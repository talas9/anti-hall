//! Dogfood fixes #420 / #421 / #417: tasklist-guard counts only the session's own work and names it, carries the progress file across
//! midnight, and command-guard names the heavy segment of a chain. Each fix has an off switch and a counter.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::checks::Verdict;
use ah_engine::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

// The counters are process-global and the state directory comes from the process environment, so the tests run one at a time.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
static REAL_HOME: std::sync::OnceLock<Option<std::ffi::OsString>> = std::sync::OnceLock::new();

thread_local! {
    static HELD: std::cell::RefCell<Option<std::sync::MutexGuard<'static, ()>>> = const { std::cell::RefCell::new(None) };
}

fn home(tag: &str) -> PathBuf {
    HELD.with(|h| {
        let mut h = h.borrow_mut();
        if h.is_none() {
            *h = Some(SERIAL.lock().unwrap_or_else(|e| e.into_inner()));
        }
    });
    REAL_HOME.get_or_init(|| std::env::var_os("HOME"));
    let d = std::env::temp_dir().join(format!("ah-dfa-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&d).ok();
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    let d = std::fs::canonicalize(&d).unwrap();
    // the scratch state directory is applied BEFORE anything resolves a state path, so no counter, journal or cache reaches the real home
    // SAFETY: the tests are serialized by SERIAL, so no other thread reads the environment while it changes.
    unsafe {
        std::env::set_var("AH_ENGINE_DIR", d.join("state"));
        std::env::set_var("AH_ENGINE_PLUGIN_ROOT", concat!(env!("CARGO_MANIFEST_DIR"), "/../plugins/anti-hall"));
    }
    ah_engine::defaults::init().expect("defaults load");
    let state = ah_engine::paths::dir();
    assert_eq!(state, d.join("state"), "the state directory is the scratch one");
    if let Some(Some(real)) = REAL_HOME.get() {
        assert!(!state.starts_with(Path::new(real).join(".anti-hall")), "the real home's state tree must stay untouched: {state:?}");
    }
    std::fs::create_dir_all(&state).unwrap(); // the counter journal is only written when the state directory exists
    d
}

fn advisory(metric: &str, kind: &str) -> u64 {
    ah_engine::obs::counters::snapshot()["advisory"][kind][metric].as_u64().unwrap_or(0)
}

fn text_of(v: Option<Option<Verdict>>) -> (String, bool) {
    match v {
        Some(Some(Verdict::Exact(x))) => (format!("{}{}", x.out, x.err), x.code == 2 || x.out.contains("\"block\"")),
        Some(Some(Verdict::Block(s))) => (s, true),
        _ => (String::new(), false),
    }
}

// ---- tasklist-guard --------------------------------------------------------------------------------------------------------

fn bash_use(i: usize, cmd: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"2026-10-29T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":{}}}}}]}}}}"#,
        i % 60,
        Value::String(cmd.into())
    )
}

fn edit_use(i: usize, path: &str) -> String {
    format!(
        r#"{{"type":"assistant","timestamp":"2026-10-29T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"e{i}","name":"Edit","input":{{"file_path":{}}}}}]}}}}"#,
        i % 60,
        Value::String(path.into())
    )
}

fn stop(h: &Path, proj: &Path, lines: &[String], extra: &[(&str, &str)]) -> Option<Option<Verdict>> {
    let tp = h.join("t.jsonl");
    let mut body = String::from(r#"{"type":"user","timestamp":"2026-10-29T09:59:00.000Z","message":{"role":"user","content":"integrate the workers"}}"#);
    body.push('\n');
    body.push_str(&lines.join("\n"));
    body.push('\n');
    std::fs::write(&tp, body).unwrap();
    let mut pairs = vec![("HOME", h.to_string_lossy().into_owned())];
    pairs.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    let env = RequestEnv::from_pairs(pairs);
    let payload = json!({"cwd": proj, "hook_event_name": "Stop", "session_id": "sess1", "transcript_path": tp});
    ah_engine::script::run_forced("tasklist-guard", &payload, &json!({}), "Stop", &env)
}

fn project(h: &Path) -> PathBuf {
    let p = h.join("proj");
    std::fs::create_dir_all(p.join(".git/refs/heads")).unwrap();
    std::fs::write(p.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    p
}

fn integration() -> Vec<String> {
    ["git merge fix/a", "git cherry-pick abc123", "git checkout dev", "git merge --no-ff fix/b"].iter().enumerate().map(|(i, c)| bash_use(i, c)).collect()
}

#[test]
fn worker_commits_integrated_by_the_session_do_not_block_stop_and_are_counted() {
    let h = home("tl-int");
    let proj = project(&h);
    let before = advisory("tasklist_integration_skipped", "suppressed");
    let (out, blocked) = text_of(stop(&h, &proj, &integration(), &[]));
    assert!(!blocked, "integration-only commands must not block: {out}");
    assert_eq!(advisory("tasklist_integration_skipped", "suppressed"), before + 1);
    // the off switch restores the old count: the same integration commands block again
    let (out, blocked) = text_of(stop(&h, &proj, &integration(), &[("ANTIHALL_TASKLIST_INTEGRATION_SKIP", "0")]));
    assert!(blocked, "with the switch off the integration commands count again: {out}");
}

#[test]
fn own_edits_still_block_stop_and_the_message_names_what_was_counted() {
    let h = home("tl-own");
    let proj = project(&h);
    let mut lines = integration();
    for (i, f) in ["src/a.rs", "src/b.rs", "src/c.rs"].iter().enumerate() {
        lines.push(edit_use(10 + i, &format!("{}/{f}", proj.display())));
    }
    let (out, blocked) = text_of(stop(&h, &proj, &lines, &[]));
    assert!(blocked, "own edits must block: {out}");
    assert!(out.contains("a.rs") && out.contains("c.rs"), "the counted files are named: {out}");
    assert!(!out.contains("git merge"), "integration commands are not counted: {out}");
}

#[test]
fn a_session_that_crossed_midnight_keeps_its_earlier_progress_file() {
    let h = home("tl-mid");
    let proj = project(&h);
    let old = proj.join(".anti-hall/progress/2026-10-28");
    std::fs::create_dir_all(&old).unwrap();
    std::fs::write(old.join("sess1.md"), "# progress\n").unwrap();
    let before = advisory("tasklist_progress_carried", "suppressed");
    let lines: Vec<String> = (0..4).map(|i| edit_use(i, &format!("{}/src/f{i}.rs", proj.display()))).collect();
    let (out, _) = text_of(stop(&h, &proj, &lines, &[]));
    assert_eq!(advisory("tasklist_progress_carried", "suppressed"), before + 1, "the carry is counted");
    assert!(!out.contains("progress/2026-10-29/sess1.md"), "no new-date path is demanded: {out}");
}

// ---- command-guard ---------------------------------------------------------------------------------------------------------

fn command(h: &Path, cmd: &str) -> (String, bool) {
    command_with(h, cmd, &[])
}

fn command_with(h: &Path, cmd: &str, extra: &[(&str, &str)]) -> (String, bool) {
    let proj = project(h);
    std::fs::create_dir_all(proj.join("src")).unwrap();
    let mut pairs: Vec<(String, String)> = [
        ("HOME", h.to_string_lossy().as_ref()),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
        ("DEVSWARM_REPO_ID", "r1"),
        ("DEVSWARM_SOURCE_BRANCH", "feat"),
        ("ANTIHALL_INGEST_DRY_RUN", "1"),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();
    pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let env = RequestEnv::from_pairs(pairs);
    let p = json!({"tool_name": "Bash", "session_id": "s", "cwd": proj, "hook_event_name": "PreToolUse", "tool_input": {"command": cmd}});
    text_of(ah_engine::script::run_forced("command", &p, &json!({}), "PreToolUse", &env))
}

#[test]
fn a_chain_with_one_heavy_part_names_it_and_still_blocks() {
    let h = home("cg-chain");
    let before = advisory("command_heavy_segment_named", "flagged");
    let cmd = "git log --oneline -3 && cat VERSION && git status && for t in a b; do node tests/x.test.js; done";
    let (out, blocked) = command(&h, cmd);
    assert!(blocked, "the heavy part still blocks the chain: {out}");
    assert!(out.contains("Heavy: node tests/x.test.js"), "names the heavy segment: {out}");
    assert!(out.contains("are fine alone"), "says the rest is fine: {out}");
    assert_eq!(advisory("command_heavy_segment_named", "flagged"), before + 1);
}

#[test]
fn a_single_heavy_command_gets_no_segment_note() {
    let h = home("cg-single");
    let (out, blocked) = command(&h, "npm test");
    assert!(blocked, "{out}");
    assert!(!out.contains("Heavy: "), "{out}");
}

#[test]
fn the_segment_note_has_an_off_switch_and_the_block_stays() {
    let h = home("cg-off");
    let (out, blocked) = command_with(&h, "git status && npm test", &[("ANTIHALL_COMMAND_NAME_SEGMENT", "0")]);
    assert!(blocked && !out.contains("Heavy: "), "{out}");
}

// Shipped defaults (no switch pinned): commands that restore or resolve real file content are work; pure integration is not.
#[test]
fn restoring_or_resolving_file_content_is_counted_with_the_shipped_defaults() {
    let rows = [
        "git checkout HEAD -- src/a.js",
        "git checkout HEAD -- src/a.js ",
        "git checkout  HEAD -- src/a.js",
        "git checkout --ours -- src/a.js",
        "git merge --continue",
        "git checkout src/a.js",
        "git cherry-pick --continue",
    ];
    for row in rows {
        let h = home("tl-row");
        let proj = project(&h);
        let lines: Vec<String> = (0..3).map(|i| bash_use(i, row)).collect();
        let (out, blocked) = text_of(stop(&h, &proj, &lines, &[]));
        assert!(blocked, "must count: {row}: {out}");
    }
    for row in ["git checkout dev", "git switch -c fix/x", "git merge fix/a", "git merge --no-ff fix/b", "git cherry-pick abc123", "git checkout release/1.2"] {
        let h = home("tl-row");
        let proj = project(&h);
        let lines: Vec<String> = (0..3).map(|i| bash_use(i, row)).collect();
        let (out, blocked) = text_of(stop(&h, &proj, &lines, &[]));
        assert!(!blocked, "must not count: {row}: {out}");
    }
}
