//! GH #404 phase 1: advisor mode. Three rules (review in model-routing, plan and retry in advisor-guard), each silent unless the
//! session shows an advisor tool, each blocking once per trigger, capped, never on a Stop continuation. Tests run under a scratch HOME.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

fn dir() -> PathBuf {
    let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("advisor-{}", std::process::id()));
    std::fs::create_dir_all(d.join("home")).unwrap();
    d
}

fn run(check: &str, extra: &[(&str, &str)], p: &Value) -> i32 {
    let d = dir();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["check", check])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", d.join("home"))
        .env("AH_ENGINE_DIR", d.join("state"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .env("AH_ENGINE_PLUGIN_ROOT", plugin())
        .current_dir(&d)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c.envs(extra.iter().copied());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(p.to_string().as_bytes()).unwrap();
    ch.wait_with_output().unwrap().status.code().unwrap_or(-1)
}

const USER: &str = r#"{"type":"user","message":{"role":"user","content":"please do it"}}"#;
const ADVISOR: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"server_tool_use","name":"advisor","input":{}}]}}"#;
const WORK: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"working"}]}}"#;

/// A transcript of `lines` under a name of its own; returns the path.
fn transcript(name: &str, lines: &[&str]) -> String {
    let p = dir().join(format!("{name}.jsonl"));
    std::fs::write(&p, lines.join("\n") + "\n").unwrap();
    p.to_string_lossy().to_string()
}

fn append(path: &str, line: &str) {
    let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(f, "{line}").unwrap();
}

fn spawn(session: &str, tp: &str, desc: &str, model: Option<&str>, extra: Value) -> Value {
    let mut input = json!({"description": desc, "prompt": "go", "subagent_type": "general-purpose"});
    if let Some(m) = model {
        input["model"] = json!(m);
    }
    let mut p = json!({"session_id": session, "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": input, "transcript_path": tp});
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

fn tool(session: &str, tp: &str, event: &str, name: &str, input: Value) -> Value {
    json!({"session_id": session, "cwd": "/tmp", "hook_event_name": event, "tool_name": name, "tool_input": input, "transcript_path": tp})
}

#[test]
fn review_blocked_once_on_non_flagship_when_advisor_present() {
    let tp = transcript("rev1", &[USER, ADVISOR, WORK]);
    let p = spawn("rev1", &tp, "Review the diff", Some("sonnet"), json!({}));
    assert_eq!(run("model-routing", &[], &p), 2, "first review spawn on sonnet is blocked");
    assert_eq!(run("model-routing", &[], &p), 0, "the same spawn retried is allowed (once per trigger)");
    assert_eq!(run("model-routing", &[], &spawn("rev1", &tp, "Audit the config", Some("haiku"), json!({}))), 2, "another trigger blocks again");
}

#[test]
fn review_allowed_on_flagship_non_review_or_off() {
    let tp = transcript("rev2", &[USER, ADVISOR, WORK]);
    assert_eq!(run("model-routing", &[], &spawn("rev2", &tp, "Review the diff", Some("opus"), json!({}))), 0, "flagship");
    assert_eq!(run("model-routing", &[], &spawn("rev2", &tp, "Write the parser", Some("sonnet"), json!({}))), 0, "not review-shaped");
    assert_eq!(run("model-routing", &[("ANTIHALL_ADVISOR_REVIEW", "0")], &spawn("rev2", &tp, "Review the diff x", Some("sonnet"), json!({}))), 0, "switch off");
    assert_eq!(run("model-routing", &[], &spawn("rev2", &tp, "Review the diff y", Some("sonnet"), json!({"stop_hook_active": true}))), 0, "stop_hook_active");
}

#[test]
fn review_silent_without_advisor_tool() {
    let tp = transcript("rev3", &[USER, WORK]);
    assert_eq!(run("model-routing", &[], &spawn("rev3", &tp, "Review the diff", Some("sonnet"), json!({}))), 0);
    let listed = spawn("rev3", &tp, "Review the diff z", Some("sonnet"), json!({"tools": ["Bash", "advisor"]}));
    assert_eq!(run("model-routing", &[], &listed), 2, "the payload's tool list also shows the advisor");
}

#[test]
fn review_cap_is_respected() {
    let tp = transcript("rev4", &[USER, ADVISOR]);
    let blocks = (0..6).filter(|i| run("model-routing", &[], &spawn("rev4", &tp, &format!("Review part {i}"), Some("sonnet"), json!({}))) == 2).count();
    assert_eq!(blocks, 3, "advisory.cap_hard_by_kind.advisor_review");
}

#[test]
fn plan_blocked_once_without_advisor_this_task() {
    let tp = transcript("plan1", &[USER, WORK]);
    let exit = tool("plan1", &tp, "PreToolUse", "ExitPlanMode", json!({"plan": "x"}));
    assert_eq!(run("advisor-guard", &[], &exit), 0, "silent without an advisor tool in the session");
    let tp = transcript("plan2", &[ADVISOR, USER, WORK]);
    let exit = tool("plan2", &tp, "PreToolUse", "ExitPlanMode", json!({"plan": "x"}));
    assert_eq!(run("advisor-guard", &[], &exit), 2, "advisor used before the last user message does not count");
    assert_eq!(run("advisor-guard", &[], &exit), 0, "once per trigger");
    let file = tool("plan2", &tp, "PreToolUse", "Write", json!({"file_path": "/r/PLAN.md", "content": "x"}));
    assert_eq!(run("advisor-guard", &[], &file), 2, "PLAN.md is a plan file");
    let other = tool("plan2", &tp, "PreToolUse", "Write", json!({"file_path": "/r/src/a.rs", "content": "x"}));
    assert_eq!(run("advisor-guard", &[], &other), 0, "an ordinary file is not a plan");
}

#[test]
fn plan_allowed_after_advisor_off_and_stop() {
    let tp = transcript("plan3", &[USER, ADVISOR, WORK]);
    assert_eq!(run("advisor-guard", &[], &tool("plan3", &tp, "PreToolUse", "ExitPlanMode", json!({}))), 0, "advisor called since the task began");
    let tp = transcript("plan4", &[ADVISOR, USER]);
    let exit = tool("plan4", &tp, "PreToolUse", "ExitPlanMode", json!({}));
    assert_eq!(run("advisor-guard", &[("ANTIHALL_ADVISOR_PLAN", "0")], &exit), 0, "switch off");
    let mut stop = exit.clone();
    stop["stop_hook_active"] = json!(true);
    assert_eq!(run("advisor-guard", &[], &stop), 0, "stop_hook_active");
}

#[test]
fn plan_cap_is_respected() {
    let tp = transcript("plan5", &[ADVISOR, USER]);
    let blocks = (0..6)
        .filter(|i| run("advisor-guard", &[], &tool("plan5", &tp, "PreToolUse", "Write", json!({"file_path": format!("/r/plans/p{i}.md")}))) == 2)
        .count();
    assert_eq!(blocks, 3, "advisory.cap_hard_by_kind.advisor_plan");
}

fn fail(session: &str, tp: &str, cmd: &str) -> i32 {
    run("advisor-guard", &[], &tool(session, tp, "PostToolUseFailure", "Bash", json!({"command": cmd})))
}

fn edit(session: &str, tp: &str, file: &str, extra: &[(&str, &str)]) -> i32 {
    run("advisor-guard", extra, &tool(session, tp, "PreToolUse", "Edit", json!({"file_path": file})))
}

#[test]
fn retry_blocked_once_on_second_edit_after_failure() {
    let tp = transcript("ret1", &[USER, ADVISOR, WORK]);
    assert_eq!(edit("ret1", &tp, "/r/a.rs", &[]), 0, "first edit");
    assert_eq!(fail("ret1", &tp, "cargo test -p x"), 0, "a failure never blocks itself");
    assert_eq!(edit("ret1", &tp, "/r/b.rs", &[]), 0, "another file is a first edit");
    assert_eq!(edit("ret1", &tp, "/r/a.rs", &[]), 2, "second edit of a.rs after the failure");
    assert_eq!(edit("ret1", &tp, "/r/a.rs", &[]), 0, "blocked once, then the failure is disarmed");
}

#[test]
fn retry_allowed_when_advisor_called_in_between() {
    let tp = transcript("ret2", &[USER, ADVISOR, WORK]);
    assert_eq!(edit("ret2", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(fail("ret2", &tp, "npm test"), 0);
    append(&tp, ADVISOR);
    assert_eq!(edit("ret2", &tp, "/r/a.rs", &[]), 0, "advisor consulted after the failure");
}

#[test]
fn retry_silent_without_advisor_or_off_or_stopping_or_unrelated_failure() {
    let tp = transcript("ret3", &[USER, WORK]);
    assert_eq!(edit("ret3", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(fail("ret3", &tp, "cargo test"), 0);
    assert_eq!(edit("ret3", &tp, "/r/a.rs", &[]), 0, "no advisor tool in the session");
    let tp = transcript("ret4", &[USER, ADVISOR]);
    assert_eq!(edit("ret4", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(fail("ret4", &tp, "ls /nope"), 0);
    assert_eq!(edit("ret4", &tp, "/r/a.rs", &[]), 0, "ls is not a test or build command");
    assert_eq!(fail("ret4", &tp, "cargo build"), 0);
    assert_eq!(edit("ret4", &tp, "/r/a.rs", &[("ANTIHALL_ADVISOR_RETRY", "0")]), 0, "switch off");
    let mut stop = tool("ret4", &tp, "PreToolUse", "Edit", json!({"file_path": "/r/a.rs"}));
    stop["stop_hook_active"] = json!(true);
    assert_eq!(run("advisor-guard", &[], &stop), 0, "stop_hook_active");
}

#[test]
fn retry_cap_is_respected() {
    let tp = transcript("ret5", &[USER, ADVISOR]);
    let mut blocks = 0;
    for i in 0..6 {
        let f = format!("/r/f{i}.rs");
        edit("ret5", &tp, &f, &[]);
        fail("ret5", &tp, "cargo test");
        if edit("ret5", &tp, &f, &[]) == 2 {
            blocks += 1;
        }
    }
    assert_eq!(blocks, 3, "advisory.cap_hard_by_kind.advisor_retry");
}
