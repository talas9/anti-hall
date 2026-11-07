//! FW-1 (command-family guard misfires): hand-written MUST-BLOCK and exact ALLOW cells for #620 (never-routine words keep a spawn off
//! haiku routing), #547 (gh pr ready/close allowed, `sh|bash <script>` judged by its body) and #336 item 4 (no Explore hint for a
//! review seat or a brief that runs tests). The #621 and #623 cells live in `lane_waste.rs` next to the guards they exercise.
//! Tests run under a scratch HOME (the shared `run` helper).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use super::lane_waste::run;
use serde_json::{Value, json};
use std::path::PathBuf;

fn spawn(model: Option<&str>, description: &str, prompt: &str) -> Value {
    let mut input = json!({"description": description, "prompt": prompt});
    if let Some(m) = model {
        input["model"] = json!(m);
    }
    json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": input})
}

fn route(p: &Value, env: &[(&str, &str)]) -> (i32, String) {
    let (code, out, _) = run(&["check", "model-routing"], env, &p.to_string());
    (code, out)
}

#[test]
fn never_routine_words_keep_a_flagship_spawn_off_haiku_routing() {
    // #620: the cell from the issue text
    let (code, out) = route(&spawn(Some("opus"), "", "install the USB driver"), &[]);
    assert_eq!(code, 0, "flagship 'install the USB driver' must be allowed: {out}");
    for prompt in ["install the toolchain", "flash the firmware", "run the migration", "update the driver"] {
        assert_eq!(route(&spawn(Some("fable"), "", prompt), &[]).0, 0, "{prompt}");
    }
    // unchanged: a plainly mechanical brief on a flagship model is still routed down, and a haiku spawn is not touched
    let (code, out) = route(&spawn(Some("opus"), "", "fetch and download the dump, tail the logs"), &[]);
    assert_eq!(code, 2, "row 1 unchanged: {out}");
    assert_eq!(route(&spawn(Some("haiku"), "", "run tests"), &[]).0, 0, "haiku 'run tests' unchanged");
    // the veto list is plugin configuration, not compiled in
    let toml = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults/small_guards.toml")).unwrap();
    assert!(toml.contains("[model_routing.never_routine]"), "the veto list is plugin TOML");
}

#[test]
fn a_review_seat_or_a_test_running_brief_gets_no_explore_hint() {
    // #336 item 4: a read-only-shaped general-purpose spawn is hinted toward Explore, unless it is a review seat or runs tests
    let hinted = route(&spawn(Some("sonnet"), "survey the repo layout", "investigate and locate where the config is read"), &[]);
    assert!(hinted.1.contains("Explore"), "a plain research spawn is still hinted: {:?}", hinted);
    for (d, pr) in [
        ("code reviewer for the diff", "investigate the change and locate regressions"),
        ("critic seat", "investigate the plan and find gaps"),
        ("investigate the failure", "run the tests and locate the failing case"),
        ("investigate the failure", "locate the bug; execute cargo test for the module"),
    ] {
        let (code, out) = route(&spawn(Some("sonnet"), d, pr), &[]);
        assert_eq!(code, 0, "{d} / {pr}");
        assert!(!out.contains("Explore"), "{d} / {pr} must get no Explore hint: {out}");
    }
    // the switch restores the hint
    let (_, out) =
        route(&spawn(Some("sonnet"), "code reviewer for the diff", "investigate the change and locate regressions"), &[("ANTIHALL_EXPLORE_HINT_SKIP", "0")]);
    assert!(out.contains("Explore"), "guards.exploreHintSkip off hints every research spawn: {out}");
}

fn scratch(tag: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("fw1-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(d.join(".git/refs/heads")).unwrap();
    std::fs::write(d.join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
    std::fs::canonicalize(&d).unwrap()
}

fn main_bash(cmd: &str, cwd: &str) -> Value {
    json!({"session_id": "s1", "cwd": cwd, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": cmd}})
}

/// The context in which the main-thread heavy-command gate blocks: a DevSwarm checkout (as the script counter tests set it up).
const DEVSWARM: [(&str, &str); 4] =
    [("CLAUDE_CODE_ENTRYPOINT", "cli"), ("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat"), ("ANTIHALL_INGEST_DRY_RUN", "1")];

fn guard(p: &Value, env: &[(&str, &str)]) -> i32 {
    let all: Vec<(&str, &str)> = DEVSWARM.iter().chain(env.iter()).copied().collect();
    run(&["check", "command"], &all, &p.to_string()).0
}

#[test]
fn gh_pr_ready_and_close_run_inline_but_merge_stays_blocked() {
    // #547: reversible PR state changes are allowed in the main thread; the irreversible merge is not
    let cwd = scratch("gh");
    let cwd = cwd.to_str().unwrap();
    assert_eq!(guard(&main_bash("gh pr ready 12", cwd), &[]), 0, "gh pr ready");
    assert_eq!(guard(&main_bash("gh pr close 12", cwd), &[]), 0, "gh pr close");
    assert_eq!(guard(&main_bash("gh pr merge 12", cwd), &[]), 2, "gh pr merge stays blocked");
}

#[test]
fn a_shell_wrapper_gets_the_verdict_of_its_script_body() {
    // #547: `bash run.sh` is judged by what run.sh runs, so a wrapper and its raw command agree
    let dir = scratch("wrap");
    let cwd = dir.to_str().unwrap();
    std::fs::write(dir.join("heavy.sh"), "#!/bin/sh\ncargo build --release\n").unwrap();
    std::fs::write(dir.join("light.sh"), "#!/bin/sh\necho hello\n").unwrap();
    let raw = guard(&main_bash("cargo build --release", cwd), &[]);
    assert_eq!(raw, 2, "the raw heavy command blocks");
    assert_eq!(guard(&main_bash("bash heavy.sh", cwd), &[]), raw, "relative wrapper == its raw command");
    assert_eq!(guard(&main_bash(&format!("sh {}/heavy.sh", cwd), cwd), &[]), raw, "absolute wrapper == its raw command");
    assert_eq!(guard(&main_bash("bash light.sh", cwd), &[]), 0, "a wrapper of a light body stays allowed");
    assert_eq!(guard(&main_bash("bash missing.sh", cwd), &[]), 0, "an unreadable script is judged as written");
    assert_eq!(guard(&main_bash("bash heavy.sh", cwd), &[("ANTIHALL_COMMAND_RESOLVE_WRAPPER_SCRIPTS", "0")]), 0, "guards.commandResolveWrapperScripts off");
}
