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
const ADVISOR: &str =
    r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"server_tool_use","name":"advisor","input":{}}]}}"#;
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
    let mut p =
        json!({"session_id": session, "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": input, "transcript_path": tp});
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
    assert_eq!(run("model-routing", &[], &spawn("rev1", &tp, "Critique the config", Some("haiku"), json!({}))), 2, "another trigger blocks again");
    assert_eq!(run("model-routing", &[], &spawn("rev1", &tp, "Audit the config", Some("haiku"), json!({}))), 0, "audits and scans may run on a cheap model");
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

const OPUS_WORK: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"working"}]}}"#;
const TEXT_ONLY: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"I could call the advisor tool here"}]}}"#;

#[test]
fn review_omitted_model_follows_the_resolved_session_tier() {
    let tp = transcript("rev5", &[USER, ADVISOR, OPUS_WORK]);
    assert_eq!(run("model-routing", &[], &spawn("rev5", &tp, "Review the diff", None, json!({}))), 0, "omitted model on an Opus main inherits a flagship");
    let tp = transcript("rev6", &[USER, ADVISOR, WORK]);
    assert_eq!(run("model-routing", &[], &spawn("rev6", &tp, "Review the diff", None, json!({}))), 2, "omitted model on a Sonnet main inherits a non-flagship");
}

#[test]
fn review_named_agent_with_own_model_is_allowed() {
    let tp = transcript("rev7", &[USER, ADVISOR, WORK]);
    let mut p = spawn("rev7", &tp, "Review the diff", None, json!({}));
    p["tool_input"]["subagent_type"] = json!("code-reviewer");
    assert_eq!(run("model-routing", &[], &p), 0, "a custom agent without a model argument runs on its own definition model (fail-open)");
    let mut q = spawn("rev7", &tp, "Review the diff again", Some("sonnet"), json!({}));
    q["tool_input"]["subagent_type"] = json!("code-reviewer");
    assert_eq!(run("model-routing", &[], &q), 2, "an explicit non-flagship model is still blocked");
}

#[test]
fn advisor_word_in_a_text_block_is_not_detected() {
    let tp = transcript("txt1", &[USER, TEXT_ONLY]);
    assert_eq!(run("model-routing", &[], &spawn("txt1", &tp, "Review the diff", Some("sonnet"), json!({}))), 0, "review rule silent");
    assert_eq!(run("advisor-guard", &[], &tool("txt1", &tp, "PreToolUse", "ExitPlanMode", json!({}))), 0, "plan rule silent");
}

fn pass(session: &str, tp: &str, cmd: &str) -> i32 {
    run("advisor-guard", &[], &tool(session, tp, "PostToolUse", "Bash", json!({"command": cmd})))
}

#[test]
fn retry_state_is_per_agent() {
    let tp = transcript("ag1", &[USER, ADVISOR, WORK]);
    sub_transcript("ag1", "sub-1", &[USER, ADVISOR, WORK]); // phase 3: a subagent is judged by its own transcript
    let sub = |event: &str, name: &str, input: Value| {
        let mut p = tool("ag1", &tp, event, name, input);
        p["agent_id"] = json!("sub-1");
        run("advisor-guard", &[], &p)
    };
    assert_eq!(edit("ag1", &tp, "/r/a.rs", &[]), 0, "main edits a.rs");
    assert_eq!(fail("ag1", &tp, "cargo test"), 0, "main thread test fails");
    assert_eq!(sub("PreToolUse", "Edit", json!({"file_path": "/r/a.rs"})), 0, "a subagent's first edit is not the main thread's retry");
    assert_eq!(edit("ag1", &tp, "/r/a.rs", &[]), 2, "the main thread keeps its own armed state");
    assert_eq!(sub("PostToolUseFailure", "Bash", json!({"command": "cargo test"})), 0);
    assert_eq!(sub("PreToolUse", "Edit", json!({"file_path": "/r/a.rs"})), 2, "the subagent's own retry is blocked on its own state");
}

#[test]
fn retry_ignores_unrelated_and_settled_failures() {
    let tp = transcript("ret6", &[USER, ADVISOR]);
    assert_eq!(fail("ret6", &tp, "cargo test"), 0, "failure before any edit");
    assert_eq!(edit("ret6", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(edit("ret6", &tp, "/r/a.rs", &[]), 0, "the failure came before the first edit: unrelated, not armed for a.rs");
    let tp = transcript("ret7", &[USER, ADVISOR]);
    assert_eq!(edit("ret7", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(fail("ret7", &tp, "cargo test"), 0);
    assert_eq!(pass("ret7", &tp, "cargo test"), 0);
    assert_eq!(edit("ret7", &tp, "/r/a.rs", &[]), 0, "a passing run cleared the failure");
    let tp = transcript("ret8", &[USER, ADVISOR]);
    assert_eq!(edit("ret8", &tp, "/r/tests/a_test.rs", &[]), 0, "red step: write the test");
    assert_eq!(fail("ret8", &tp, "cargo test"), 0, "expected failure");
    assert_eq!(edit("ret8", &tp, "/r/tests/a_test.rs", &[]), 0, "first re-edit of the test is not blocked");
}

/// The per-session adherence tally kept in the retry state file of `session` (phase 2 monitoring).
fn stats(session: &str) -> Value {
    fn find(d: &std::path::Path, name: &str) -> Option<PathBuf> {
        for e in std::fs::read_dir(d).ok()?.flatten() {
            let p = e.path();
            if p.is_dir() {
                if let Some(f) = find(&p, name) {
                    return Some(f);
                }
            } else if p.file_name().is_some_and(|n| n.to_string_lossy() == name) {
                return Some(p);
            }
        }
        None
    }
    let f = find(&dir(), &format!("advisor-retry-{session}.json")).expect("retry state file");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap();
    v["stats"].clone()
}

#[test]
fn monitoring_counts_armed_blocked_acted_on_and_consults() {
    let tp = transcript("mon1", &[USER, ADVISOR, WORK]);
    assert_eq!(edit("mon1", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(fail("mon1", &tp, "cargo test -p x"), 0);
    assert_eq!(edit("mon1", &tp, "/r/a.rs", &[]), 2, "block fired");
    append(&tp, ADVISOR);
    assert_eq!(edit("mon1", &tp, "/r/c.rs", &[]), 0, "advisor consulted after the block");
    let s = stats("mon1");
    assert_eq!(s["armed"], 1, "{s}");
    assert_eq!(s["acted_on"], 1, "block followed by a consult: {s}");
    assert_eq!(s["consults"], 2, "both advisor calls counted once each: {s}");
    assert!(s["consulted"].is_null(), "no consult before the block: {s}");
}

#[test]
fn monitoring_counts_consult_after_failure() {
    let tp = transcript("mon2", &[USER, ADVISOR, WORK]);
    assert_eq!(edit("mon2", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(fail("mon2", &tp, "npm test"), 0);
    append(&tp, ADVISOR);
    assert_eq!(edit("mon2", &tp, "/r/a.rs", &[]), 0);
    assert_eq!(edit("mon2", &tp, "/r/a.rs", &[]), 0, "no double count");
    let s = stats("mon2");
    assert_eq!((s["armed"].as_u64(), s["consulted"].as_u64(), s["consults"].as_u64()), (Some(1), Some(1), Some(2)), "{s}");
}

// ---- Phase 3 (GH #404): enforcement when the main model is not a flagship ----

const OWNER: &str = r#"{"type":"user","timestamp":"2026-10-30T10:00:00.000Z","message":{"role":"user","content":"please fix the crash"}}"#;
const OWNER2: &str = r#"{"type":"user","timestamp":"2026-10-30T11:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"next task"}]}}"#;
const NOTIFY: &str = r#"{"type":"user","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification> agent done"}}"#;
const META: &str = r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Stop hook feedback: x"}}"#;
const SONNET: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"dispatching"}]}}"#;
const OPUS: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"dispatching"}]}}"#;
const SYNTH: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"x"}]}}"#;
const ADV_CALL: &str = r#"{"type":"assistant","timestamp":"2026-10-30T10:00:20.000Z","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"server_tool_use","id":"srvtoolu_1","name":"advisor","input":{}}]}}"#;
const ADV_RESULT: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"advisor_tool_result","tool_use_id":"srvtoolu_1","content":{"type":"advisor_result","text":"ok"}}]}}"#;
const SAY: &str = r#"{"type":"assistant","message":{"role":"assistant","model":"claude-sonnet-5-5","content":[{"type":"text","text":"Plan set. Let me consult the advisor before dispatching."}]}}"#;

/// `run` that also returns stdout (a nudge exits 0 with an additionalContext payload).
fn run_out(check: &str, extra: &[(&str, &str)], p: &Value) -> (i32, String) {
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
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string())
}

/// A subagent's own transcript where Claude Code keeps it: `<dir>/<session file stem>/subagents/agent-<id>.jsonl`.
fn sub_transcript(stem: &str, agent: &str, lines: &[&str]) {
    let d = dir().join(stem).join("subagents");
    std::fs::create_dir_all(&d).unwrap();
    std::fs::write(d.join(format!("agent-{agent}.jsonl")), lines.join("\n") + "\n").unwrap();
}

fn dispatch(session: &str, tp: &str, desc: &str, extra: &[(&str, &str)]) -> (i32, String) {
    let input = json!({"description": desc, "prompt": "do the work", "subagent_type": "general-purpose"});
    let p = json!({"session_id": session, "cwd": "/tmp", "hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": input, "transcript_path": tp});
    run_out("advisor-guard", extra, &p)
}

fn stop(session: &str, tp: &str, extra: &[(&str, &str)], active: bool) -> i32 {
    let p = json!({"session_id": session, "cwd": "/tmp", "hook_event_name": "Stop", "stop_hook_active": active, "transcript_path": tp});
    run("advisor-guard", extra, &p)
}

const NUDGE: &str = "Call the advisor tool now, then dispatch";

#[test]
fn thinking_nudge_then_one_capped_block_per_task() {
    let tp = transcript("th1", &[ADVISOR, OWNER, SONNET]);
    let (c, out) = dispatch("th1", &tp, "Fix the parser bug", &[]);
    assert_eq!(c, 0, "first thinking dispatch: a nudge, not a block");
    assert!(out.contains(NUDGE) && out.contains("additionalContext"), "nudge names the exact action: {out}");
    assert_eq!(dispatch("th1", &tp, "Investigate the crash", &[]).0, 2, "second dispatch of the same task: one block");
    let (c, out) = dispatch("th1", &tp, "Design the cache", &[]);
    assert_eq!((c, out.is_empty()), (0, true), "the task's one block is spent: passes silently, never a loop");
    append(&tp, OWNER2);
    assert!(dispatch("th1", &tp, "Root-cause the leak", &[]).1.contains(NUDGE), "a new owner message is a new task");
    let s = stats("th1");
    assert_eq!((s["dispatch"].as_u64(), s["nudge"].as_u64(), s["blocked"].as_u64(), s["block_capped"].as_u64()), (Some(4), Some(2), Some(1), Some(1)), "{s}");
}

#[test]
fn thinking_silent_for_flagship_unknown_model_routine_work_or_switch_off() {
    let tp = transcript("th2", &[ADVISOR, OWNER, OPUS]);
    assert_eq!(dispatch("th2", &tp, "Fix the parser bug", &[]), (0, String::new()), "flagship main");
    assert_eq!(dispatch("th2", &tp, "Fix the parser bug", &[]), (0, String::new()), "flagship main, again");
    let adv_synth = ADVISOR.replace("claude-sonnet-5-5", "<synthetic>");
    let tp = transcript("th3", &[&adv_synth, OWNER, SYNTH]);
    assert_eq!(dispatch("th3", &tp, "Fix the parser bug", &[]), (0, String::new()), "no known model: silent");
    let tp = transcript("th4", &[ADVISOR, OWNER, SONNET]);
    assert_eq!(dispatch("th4", &tp, "Write the release notes", &[]), (0, String::new()), "routine work");
    assert_eq!(dispatch("th4", &tp, "Fix the parser bug", &[("ANTIHALL_ADVISOR_THINKING", "0")]), (0, String::new()), "switch off");
    let tp = transcript("th5", &[OWNER, SONNET]);
    assert_eq!(dispatch("th5", &tp, "Fix the parser bug", &[]), (0, String::new()), "no advisor tool in the session");
}

#[test]
fn thinking_silent_after_a_consult_since_the_owner_message() {
    let tp = transcript("th6", &[OWNER, SONNET, ADV_CALL, ADV_RESULT, NOTIFY, META]);
    assert_eq!(dispatch("th6", &tp, "Fix the parser bug", &[]), (0, String::new()), "consulted; notifications and harness text are not the owner");
    let tp = transcript("th7", &[OWNER, SONNET, ADV_RESULT]);
    assert_eq!(dispatch("th7", &tp, "Fix the parser bug", &[]), (0, String::new()), "an advisor result block alone is a consult");
    assert_eq!(stats("th6")["consulted_before"], 1);
}

#[test]
fn thinking_consult_older_than_the_owner_message_still_requires_one() {
    let tp = transcript("th8", &[ADV_CALL, ADV_RESULT, OWNER, SONNET]);
    assert!(dispatch("th8", &tp, "Investigate the flaky test", &[]).1.contains(NUDGE), "the consult predates the owner's message");
}

#[test]
fn subagent_does_not_inherit_the_main_transcript_consult() {
    let tp = transcript("sa1", &[ADVISOR, OWNER, SONNET, ADV_CALL]);
    sub_transcript("sa1", "a7", &[ADVISOR, OWNER, SONNET]);
    let sub = |agent: &str| {
        let input = json!({"description": "Fix the parser bug", "prompt": "x", "subagent_type": "general-purpose"});
        let p =
            json!({"session_id": "sa1", "agent_id": agent, "hook_event_name": "PreToolUse", "tool_name": "Agent", "tool_input": input, "transcript_path": tp});
        run_out("advisor-guard", &[], &p)
    };
    assert_eq!(dispatch("sa1", &tp, "Fix the parser bug", &[]), (0, String::new()), "the main thread consulted");
    assert!(sub("a7").1.contains(NUDGE), "the subagent's own transcript has no consult: nudged");
    assert_eq!(sub("a-none"), (0, String::new()), "a subagent with no own transcript stays silent (never judged by the main one)");
}

#[test]
fn advisor_seen_survives_ten_megabytes_without_a_call() {
    let tp = transcript("big1", &[ADVISOR, OWNER, SONNET]);
    assert!(dispatch("big1", &tp, "Fix the parser bug", &[]).1.contains(NUDGE), "advisor seen in the window");
    let filler = format!(
        r#"{{"type":"assistant","message":{{"role":"assistant","model":"claude-sonnet-5-5","content":[{{"type":"text","text":"{}"}}]}}}}"#,
        "x".repeat(1000)
    );
    let block = vec![filler.as_str(); 10 * 1024].join("\n");
    append(&tp, &block);
    append(&tp, OWNER2);
    append(&tp, SONNET);
    assert!(std::fs::metadata(&tp).unwrap().len() > 10 * 1024 * 1024);
    assert!(dispatch("big1", &tp, "Investigate the crash", &[]).1.contains(NUDGE), "the advisor call is 10 MB back, out of the window: still known from state");
}

#[test]
fn hook_errors_allow() {
    let d = dir();
    let garbage = d.join("garbage.jsonl");
    std::fs::write(&garbage, "{not json\n\u{0}\u{1}\n").unwrap();
    for tp in
        [garbage.to_string_lossy().to_string(), d.join("missing.jsonl").to_string_lossy().to_string(), "relative.jsonl".into(), d.to_string_lossy().to_string()]
    {
        assert_eq!(dispatch("err1", &tp, "Fix the parser bug", &[]).0, 0, "unreadable transcript {tp}: allow");
        assert_eq!(stop("err1", &tp, &[], false), 0, "unreadable transcript {tp} at Stop: allow");
    }
    assert_eq!(run("advisor-guard", &[], &json!(["not", "an", "object"])), 0, "malformed payload: allow");
}

#[test]
fn say_do_blocks_one_stop_per_turn() {
    let tp = transcript("sd1", &[ADVISOR, OWNER, SONNET, SAY]);
    assert_eq!(stop("sd1", &tp, &[], true), 0, "a Stop continuation is never blocked");
    assert_eq!(stop("sd1", &tp, &[], false), 2, "announced an advisor call that did not follow");
    assert_eq!(stop("sd1", &tp, &[], false), 0, "one block per turn");
    append(&tp, OWNER2);
    append(&tp, SAY);
    append(&tp, ADV_CALL);
    assert_eq!(stop("sd1", &tp, &[], false), 0, "said and did");
    append(&tp, OWNER);
    append(&tp, SAY);
    assert_eq!(stop("sd1", &tp, &[("ANTIHALL_ADVISOR_SAY_DO", "0")], false), 0, "switch off");
    let say_opus = SAY.replace("claude-sonnet-5-5", "claude-opus-5-5");
    let tp2 = transcript("sd2", &[ADVISOR, OWNER, OPUS, &say_opus]);
    assert_eq!(stop("sd2", &tp2, &[], false), 0, "flagship main");
    let s = stats("sd1");
    assert_eq!((s["say_do_miss"].as_u64(), s["say_do_blocked"].as_u64()), (Some(2), Some(1)), "{s}");
    assert_eq!(s["nudged"], 1, "the consult after the block counts as nudged: {s}");
}

#[test]
fn second_fix_attempt_for_one_issue_needs_a_consult() {
    let off = [("ANTIHALL_ADVISOR_THINKING", "0")];
    let tp = transcript("fx1", &[ADVISOR, OWNER, SONNET]);
    assert_eq!(dispatch("fx1", &tp, "Fix #404 crash", &off).0, 0, "first attempt");
    assert_eq!(dispatch("fx1", &tp, "Fix #404 again", &off).0, 2, "second attempt, no consult in between");
    assert_eq!(dispatch("fx1", &tp, "Fix #404 third", &off).0, 0, "blocked once per issue");
    assert_eq!(dispatch("fx1", &tp, "Fix #500 crash", &off).0, 0);
    append(&tp, ADV_CALL);
    assert_eq!(dispatch("fx1", &tp, "Fix #500 retry", &off).0, 0, "consulted between the attempts");
    assert_eq!(dispatch("fx1", &tp, "Fix #600 x", &[("ANTIHALL_ADVISOR_THINKING", "0"), ("ANTIHALL_ADVISOR_RETRY", "0")]).0, 0);
    assert_eq!(dispatch("fx1", &tp, "Fix #600 y", &[("ANTIHALL_ADVISOR_THINKING", "0"), ("ANTIHALL_ADVISOR_RETRY", "0")]).0, 0, "switch off");
    assert_eq!(stats("fx1")["second_gated"], 1);
}

#[test]
fn nudge_then_routine_work_counts_a_false_nag() {
    let tp = transcript("fn1", &[ADVISOR, OWNER, SONNET]);
    assert!(dispatch("fn1", &tp, "Fix the parser bug", &[]).1.contains(NUDGE));
    assert_eq!(dispatch("fn1", &tp, "Rename the module", &[]), (0, String::new()), "routine work passes");
    assert_eq!(stats("fn1")["false_nag"], 1);
}

#[test]
fn two_sessions_keep_their_own_state() {
    let a = transcript("ss-a", &[ADVISOR, OWNER, SONNET]);
    let b = transcript("ss-b", &[ADVISOR, OWNER, SONNET]);
    assert!(dispatch("ss-a", &a, "Fix the parser bug", &[]).1.contains(NUDGE));
    assert_eq!(dispatch("ss-a", &a, "Fix the parser bug", &[]).0, 2);
    assert!(dispatch("ss-b", &b, "Fix the parser bug", &[]).1.contains(NUDGE), "session b starts at its own first nudge");
}

#[test]
fn phase3_rows_are_wired_never_shed_and_fail_open() {
    let read = |f: &str| std::fs::read_to_string(plugin().join("engine/defaults").join(f)).unwrap();
    let dispatch = read("dispatch.toml");
    assert!(dispatch.contains(r#"{ id = "advisor-guard:dispatch", matcher = "Agent|Task", timeout = 10, check = "advisor-guard" }"#));
    assert!(dispatch.contains(r#"{ id = "advisor-guard:stop", matcher = "", timeout = 10, check = "advisor-guard" }"#));
    let diag = read("diagnostics.toml");
    let shed = diag.split("[diagnostics.shed_never]").nth(1).unwrap().split("\n[").next().unwrap();
    assert!(shed.contains(r#""advisor-guard" = "#), "advisor-guard is never shed");
    assert!(read("script.toml").contains(r#"advisor-guard = "open""#), "advisor-guard fails open");
    for f in ["advisor.toml", "advisory.toml", "dispatch.toml", "diagnostics.toml"] {
        let pristine = std::fs::read_to_string(plugin().join("engine/defaults.pristine").join(f)).unwrap();
        assert_eq!(read(f), pristine, "{f}: defaults and defaults.pristine are byte-identical");
    }
}

#[test]
fn default_switches_give_one_block_per_task_across_both_dispatch_rules() {
    let tp = transcript("one1", &[ADVISOR, OWNER, SONNET]);
    assert!(dispatch("one1", &tp, "Fix #404 crash", &[]).1.contains(NUDGE), "first: nudge");
    assert_eq!(dispatch("one1", &tp, "Fix #404 again", &[]).0, 2, "second: the one block (second attempt)");
    assert_eq!(dispatch("one1", &tp, "Fix #404 third", &[]), (0, String::new()), "third: passes, the task's block is spent");
}

#[test]
fn say_do_fires_in_a_session_that_never_called_the_advisor() {
    let tp = transcript("sd3", &[OWNER, SONNET, SAY]);
    assert_eq!(stop("sd3", &tp, &[], false), 2, "the announcement alone shows the tool is there");
    assert_eq!(stop("sd3", &tp, &[], false), 0, "one block per turn");
}
