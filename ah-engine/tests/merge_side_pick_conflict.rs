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

/// `f.txt` changes on `main` and `g.txt` on `other`: merging `other` into `main` never conflicts.
fn repo_disjoint(h: &str) -> String {
    let r = format!("{h}/repo");
    std::fs::create_dir_all(&r).unwrap();
    assert!(git(&r, &["init", "-q"]));
    std::fs::write(format!("{r}/f.txt"), "base\n").unwrap();
    std::fs::write(format!("{r}/g.txt"), "base\n").unwrap();
    assert!(git(&r, &["add", "."]) && git(&r, &["commit", "-qm", "base"]));
    assert!(git(&r, &["checkout", "-qb", "other"]));
    std::fs::write(format!("{r}/g.txt"), "theirs\n").unwrap();
    assert!(git(&r, &["commit", "-qam", "theirs"]));
    assert!(git(&r, &["checkout", "-q", "main"]));
    std::fs::write(format!("{r}/f.txt"), "ours\n").unwrap();
    assert!(git(&r, &["commit", "-qam", "ours"]));
    r
}

#[test]
fn a_clean_merge_and_a_stale_strategy_flag_stay_silent() {
    let h = home("clean");
    let r = repo_disjoint(&h);
    // no conflicting hunk at all: `-X ours` has nothing to settle, so nothing was resolved by hand
    assert!(git(&r, &["merge", "-q", "--no-edit", "-X", "ours", "other"]));
    assert!(!says(&run(&h, "PostToolUse", &r, "git merge -X ours other")));
    for _ in 0..3 {
        let v = run(&h, "PreToolUse", &r, "git push");
        assert!(!says(&v), "a plain push after a clean merge drew the advisory: {v}");
    }
    let st = std::fs::read_to_string(format!("{h}/.anti-hall/merge-side-pick-s1.json")).unwrap_or_default();
    assert!(!st.contains("\"pickSeq\":1"), "a clean merge was recorded as a side-pick: {st:?}");
    std::fs::remove_dir_all(&h).ok();
}

/// GH #782 review: `merge -X ours` settles a CONFLICTING hunk itself, leaving no marker and no unmerged path, before and after. That is a
/// one-sided resolution all the same: it is recorded, and a push before a test run is flagged.
#[test]
fn an_automatic_x_ours_resolution_of_a_conflicting_hunk_is_flagged() {
    let h = home("auto");
    let r = repo(&h);
    assert!(git(&r, &["merge", "-q", "--no-edit", "-X", "ours", "other"]), "-X ours settles the conflict itself");
    run(&h, "PostToolUse", &r, "git merge -X ours other");
    let v = run(&h, "PreToolUse", &r, "git push");
    assert!(says(&v), "an automatic resolution escaped detection: {v}");
    run(&h, "PostToolUse", &r, "npm test");
    assert!(!says(&run(&h, "PreToolUse", &r, "git push")), "a test run clears it");
    std::fs::remove_dir_all(&h).ok();
}

/// GH #782 review: the conflict note armed by a resolution command is that command's own. An unrelated command's PostToolUse (a test run in a
/// parallel tool call) between its Pre and its Post must not clear it, or the pick of a resolve-and-commit command is missed.
#[test]
fn an_unrelated_post_hook_does_not_clear_another_commands_conflict_note() {
    let h = home("interleave");
    let r = repo(&h);
    assert!(!git(&r, &["merge", "-q", "other"]));
    let cmd = "git checkout --theirs f.txt && git add f.txt && git commit -qm merged";
    run(&h, "PreToolUse", &r, cmd);
    // an unrelated command finishes while the resolution command is still running
    run(&h, "PostToolUse", &r, "npm test");
    assert!(git(&r, &["checkout", "--theirs", "f.txt"]) && git(&r, &["add", "f.txt"]) && git(&r, &["commit", "-qm", "merged"]));
    run(&h, "PostToolUse", &r, cmd);
    let v = run(&h, "PreToolUse", &r, "git push");
    assert!(says(&v), "the interleaved Post hook lost the conflict evidence: {v}");
    std::fs::remove_dir_all(&h).ok();
}

/// GH #782 review: a record written before the time of a pick was kept (no meta file) can never be shown to be fresh: it is expired, so a live
/// session stops seeing the stale advisory.
#[test]
fn a_record_with_no_meta_is_expired() {
    let h = home("legacy");
    let r = repo(&h);
    std::fs::write(format!("{h}/.anti-hall/merge-side-pick-s1.json"), r#"{"seq":1,"pickSeq":1,"testSeq":0,"cmd":"git checkout --ours old"}"#).unwrap();
    let v = run(&h, "PreToolUse", &r, "git push");
    assert!(!says(&v), "a legacy record with no meta still draws the advisory: {v}");
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
