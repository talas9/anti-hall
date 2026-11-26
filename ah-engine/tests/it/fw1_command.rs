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

#[test]
fn a_brief_that_deletes_or_cleans_up_gets_no_explore_hint_and_a_read_only_one_that_forbids_it_keeps_it() {
    // #965 item 4: the live misfire (redacted): a cache-cleanup brief whose only research word is "find"
    let cleanup = "The disk is at 39 GB free. Free space by deleting ONLY regenerable build output.\n\nALLOWED to delete:\n1. Inside these archived \
                   workspaces only: /w/a, /w/b. In each one, delete these folders if present (find them with `ls -d <ws>/*/app/<dir>`): app/build, \
                   app/.dart_tool.\n\nNEVER delete: anything else in those worktrees. Don't scan the whole disk.";
    let (code, out) = route(&spawn(Some("sonnet"), "Free disk: regenerable build caches", cleanup), &[]);
    assert_eq!(code, 0, "{out}");
    assert!(!out.contains("Explore"), "a brief that deletes is write work: no Explore hint: {out}");
    for (d, pr) in [
        ("Remove archived workspace worktrees", "Free disk by removing the git worktrees of three archived workspaces. Find each one first."),
        ("Clear closed workspace worktrees", "Clear the worktrees of an archived workspace. Locate each dir and check it for unpushed commits."),
        ("Free disk via cargo clean", "Find every Cargo.toml with a sibling target dir and run cargo clean on it."),
    ] {
        let (code, out) = route(&spawn(Some("sonnet"), d, pr), &[]);
        assert_eq!(code, 0, "{d}");
        assert!(!out.contains("Explore"), "{d} deletes: no Explore hint: {out}");
    }
    // true positives: read-only research that forbids deleting, or names delete only as a noun or a list item, keeps the hint
    for (d, pr) in [
        ("Find disk space consumers", "READ-ONLY investigation. Do NOT delete, move or modify anything. Find what is consuming space now."),
        ("Find what consumed disk", "READ-ONLY disk audit. Delete nothing, move nothing. Find which directories grew."),
        ("Housekeeping inventory", "Inventory dormant workspaces. Delete/modify NOTHING. Locate each worktree and its size."),
        ("Audit error handling", "Investigate the error handling of user actions (download, delete, settings put). Find empty catch blocks."),
        ("Trace a delete", "Investigate why the remove button does not work and locate the handler."),
    ] {
        let (code, out) = route(&spawn(Some("sonnet"), d, pr), &[]);
        assert_eq!(code, 0, "{d}");
        assert!(out.contains("Explore"), "{d} is read-only research: the hint stays: {out}");
    }
    // the verb list and its negations are plugin configuration, not compiled in
    let toml = std::fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults/small_guards.toml")).unwrap();
    assert!(toml.contains("[model_routing.delete_re]") && toml.contains("[model_routing.negated_delete_re]"), "the delete verbs are plugin TOML");
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
fn gh_pr_ready_runs_inline_close_takes_the_unlisted_path_and_merge_stays_blocked() {
    // #547: a reversible PR state change (ready) is allowed in the main thread; close (it can carry --delete-branch) and merge are not
    let cwd = scratch("gh");
    let cwd = cwd.to_str().unwrap();
    assert_eq!(guard(&main_bash("gh pr ready 12", cwd), &[]), 0, "gh pr ready");
    // close is no longer in remote_allow: it and its --delete-branch form take the same path as any unlisted gh mutation
    let unlisted = guard(&main_bash("gh pr review 12", cwd), &[]);
    assert_eq!(guard(&main_bash("gh pr close 12", cwd), &[]), unlisted, "gh pr close takes the old path");
    assert_eq!(guard(&main_bash("gh pr close 12 --delete-branch", cwd), &[]), unlisted, "gh pr close --delete-branch takes the old path");
    assert_eq!(guard(&main_bash("gh pr merge 12", cwd), &[]), 2, "gh pr merge stays blocked");
}

#[test]
fn a_heavy_block_names_the_rule_that_fired_and_flutter_clean_is_light() {
    let cwd = scratch("rule");
    let cwd = cwd.to_str().unwrap();
    let all: Vec<(&str, &str)> = DEVSWARM.to_vec();
    let text = |cmd: &str| {
        let (code, out, err) = run(&["check", "command"], &all, &main_bash(cmd, cwd).to_string());
        (code, format!("{out}{err}"))
    };
    let (code, msg) = text("flutter build apk");
    assert_eq!(code, 2, "{msg}");
    assert!(msg.contains("Rule: a heavy command (flutter)."), "the visible text names the heavy verb: {msg}");
    let (code, msg) = text("gh pr merge 836 --squash");
    assert_eq!(code, 2, "{msg}");
    assert!(msg.contains("Rule: a command that changes a shared remote."), "the visible text names the remote rule: {msg}");
    assert_eq!(text("flutter clean").0, 0, "flutter clean is light, like cargo clean");
}

#[test]
fn the_rule_stays_visible_with_a_real_length_session_id_and_a_details_link() {
    // #857: a real session id (a UUID) makes the details link 30 chars longer than the goldens' "s1"; the rule must still show
    let cwd = scratch("rule-uuid");
    let cwd = cwd.to_str().unwrap();
    let all: Vec<(&str, &str)> = DEVSWARM.to_vec();
    let sid = "0b7a2f4e-3c1d-4e5f-9a8b-7c6d5e4f3a2b";
    for (cmd, rule) in [
        ("flutter build apk", "Rule: a heavy command (flutter)."),
        ("gh pr merge 836 --squash", "Rule: a command that changes a shared remote."),
        ("make ; timeout 5 node scripts/devswarm.js inbox ack w", "Rule: a heavy command (make)."),
        ("env A=1 gh pr merge 2 && echo $(cargo build) | tail -3 ; timeout 5 python3 scripts/chk.py ", "Rule: a command that changes a shared remote."),
        ("timeout 5 gh pr merge 2 ; timeout 5 git status ; echo $(env A=1 docker ps)", "Rule: a command that changes a shared remote."),
        ("gcloud run services delete svc --format=json", "Rule: a heavy command (gcloud)."),
        ("npm run deploy\nnpm test", "Rule: a heavy command (npm)."),
    ] {
        let mut p = main_bash(cmd, cwd);
        p["session_id"] = json!(sid);
        let (code, out, err) = run(&["check", "command"], &all, &p.to_string());
        let msg = format!("{out}{err}");
        eprintln!("--- {cmd}\n{msg}");
        assert_eq!(code, 2, "{msg}");
        assert!(msg.contains(rule), "{cmd}: the visible block names its rule with a real session id: {msg}");
    }
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

#[test]
fn gcloud_config_get_value_is_a_read_not_a_heavy_command() {
    // #709: reading one configured value forced a helper agent and a task update per call; `get-value` is a read-only verb (command.gcloud_inspect_verbs)
    let cwd = scratch("gcloud");
    let cwd = cwd.to_str().unwrap();
    assert_eq!(guard(&main_bash("gcloud config get-value project", cwd), &[]), 0, "gcloud config get-value");
    assert_eq!(guard(&main_bash("gcloud compute instances list", cwd), &[]), 0, "an inspect verb stays a read");
}
