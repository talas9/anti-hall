//! merge-side-pick (GH #782): a side-pick is recorded only when a conflict was really being resolved, so a clean `-X ours` merge or a
//! stray `--ours` no longer makes every later `git push` draw the advisory; a real one-sided resolution still does, until a test run
//! or the TTL clears it. Real git repositories under a scratch home.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::reqenv::RequestEnv;
use serde_json::json;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-msp-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok();
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    std::fs::canonicalize(&d).unwrap().to_string_lossy().into_owned()
}

fn git(dir: &str, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-C", dir])
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `f.txt` differs on `main` and on `other`, so merging `other` into `main` conflicts.
fn repo(h: &str) -> String {
    let r = format!("{h}/repo");
    std::fs::create_dir_all(&r).unwrap();
    assert!(git(&r, &["init", "-q"]));
    std::fs::write(format!("{r}/f.txt"), "base\n").unwrap();
    assert!(git(&r, &["add", "."]) && git(&r, &["commit", "-qm", "base"]));
    assert!(git(&r, &["checkout", "-qb", "other"]));
    std::fs::write(format!("{r}/f.txt"), "theirs\n").unwrap();
    assert!(git(&r, &["commit", "-qam", "theirs"]));
    assert!(git(&r, &["checkout", "-q", "main"]));
    std::fs::write(format!("{r}/f.txt"), "ours\n").unwrap();
    assert!(git(&r, &["commit", "-qam", "ours"]));
    r
}

fn run(h: &str, event: &str, cwd: &str, cmd: &str) -> String {
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), h.to_string())]);
    let p = json!({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd, "session_id": "s1", "hook_event_name": event});
    format!("{:?}", ah_engine::script::run_forced("merge-side-pick", &p, &json!({}), event, &env))
}

fn says(v: &str) -> bool {
    v.contains("one-sided conflict resolution")
}

#[test]
fn a_clean_merge_and_a_stale_strategy_flag_stay_silent() {
    let h = home("clean");
    let r = repo(&h);
    // no conflict at all: `-X ours` merges `other` cleanly (git settles the hunk itself), so nothing was resolved by hand
    assert!(git(&r, &["merge", "-q", "-X", "ours", "other"]));
    assert!(!says(&run(&h, "PostToolUse", &r, "git merge -X ours other")));
    for _ in 0..3 {
        let v = run(&h, "PreToolUse", &r, "git push");
        assert!(!says(&v), "a plain push after a clean merge drew the advisory: {v}");
    }
    let st = std::fs::read_to_string(format!("{h}/.anti-hall/merge-side-pick-s1.json")).unwrap_or_default();
    assert!(!st.contains("\"pickSeq\":1"), "a clean merge was recorded as a side-pick: {st:?}");
    std::fs::remove_dir_all(&h).ok();
}

#[test]
fn a_real_one_sided_resolution_then_push_is_flagged_until_a_test_runs() {
    let h = home("real");
    let r = repo(&h);
    assert!(!git(&r, &["merge", "-q", "other"]), "the merge must conflict");
    run(&h, "PostToolUse", &r, "git checkout --ours f.txt");
    let v = run(&h, "PreToolUse", &r, "git push");
    assert!(says(&v), "{v}");
    run(&h, "PostToolUse", &r, "npm test");
    let v = run(&h, "PreToolUse", &r, "git push");
    assert!(!says(&v), "a test run clears the advisory: {v}");
    std::fs::remove_dir_all(&h).ok();
}

#[test]
fn a_resolution_finished_inside_one_command_is_flagged() {
    let h = home("armed");
    let r = repo(&h);
    assert!(!git(&r, &["merge", "-q", "other"]));
    // the conflict is open when the command starts and gone when it ends (resolved, added and committed within it)
    let cmd = "git checkout --theirs f.txt && git add f.txt && git commit -qm merged";
    run(&h, "PreToolUse", &r, cmd);
    assert!(git(&r, &["checkout", "--theirs", "f.txt"]) && git(&r, &["add", "f.txt"]) && git(&r, &["commit", "-qm", "merged"]));
    run(&h, "PostToolUse", &r, cmd);
    let v = run(&h, "PreToolUse", &r, "git push");
    assert!(says(&v), "{v}");
    std::fs::remove_dir_all(&h).ok();
}

#[test]
fn a_side_pick_older_than_the_ttl_is_forgotten() {
    let h = home("ttl");
    let r = repo(&h);
    assert!(!git(&r, &["merge", "-q", "other"]));
    run(&h, "PostToolUse", &r, "git checkout --ours f.txt");
    assert!(says(&run(&h, "PreToolUse", &r, "git push")));
    // the pick was recorded long ago: the meta file holds its time
    std::fs::write(format!("{h}/.anti-hall/merge-side-pick-meta-s1.json"), r#"{"at":1,"ev":false}"#).unwrap();
    let v = run(&h, "PreToolUse", &r, "git push");
    assert!(!says(&v), "a pick older than the TTL still draws the advisory: {v}");
    std::fs::remove_dir_all(&h).ok();
}
