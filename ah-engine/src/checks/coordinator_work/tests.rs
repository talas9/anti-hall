//! Unit tests of the coordinator-work-guard check. The full Node-vs-engine comparison is
//! `parity/run-coordinator-work-guard.js`.
use super::*;
use serde_json::json;

fn bash(extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "session_id": "s1", "tool_input": {"command": "git commit -am x"}});
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    p
}

#[test]
fn calls_that_are_not_bash_or_have_no_session_say_nothing() {
    assert!(decide(&json!({"tool_name": "Edit", "session_id": "s"})).is_none());
    assert!(decide(&bash(json!({"session_id": "   "}))).is_none());
    assert!(decide(&bash(json!({"session_id": 5}))).is_none());
    assert!(decide(&json!([1])).is_none());
    assert!(decide(&json!(null)).is_none());
}

#[test]
fn a_subagent_marker_in_the_payload_proves_it_is_not_the_main_thread() {
    assert!(decide(&bash(json!({"agent_id": "a1"}))).is_none());
    assert!(decide(&bash(json!({"agent_type": "Explore"}))).is_none());
    assert!(decide(&bash(json!({"agent_id": 7}))).is_none());
    assert!(decide(&bash(json!({"agent_id": {}}))).is_none(), "an object is truthy");
}

#[test]
fn falsy_markers_prove_nothing_on_a_claude_payload_but_count_on_a_codex_one() {
    for v in [json!(""), json!(0), json!(false), json!(null)] {
        assert_eq!(decide(&bash(json!({"agent_id": v}))), Some(Verdict::Defer), "{v}");
    }
    let codex = |extra: Value| {
        bash(json!({"turn_id": "t", "model": "gpt-5.5"})).as_object().unwrap().iter().chain(extra.as_object().unwrap().iter()).fold(
            json!({}),
            |mut acc, (k, v)| {
                acc[k] = v.clone();
                acc
            },
        )
    };
    assert!(decide(&codex(json!({"agent_id": ""}))).is_none(), "present and non-null counts on Codex");
    assert_eq!(decide(&codex(json!({"agent_id": null}))), Some(Verdict::Defer));
    assert_eq!(decide(&codex(json!({}))), Some(Verdict::Defer));
}

#[test]
fn the_main_thread_defers_to_the_node_guard_which_owns_the_window() {
    assert_eq!(decide(&bash(json!({}))), Some(Verdict::Defer));
    assert_eq!(decide(&bash(json!({"hook_event_name": "PostToolUse"}))), Some(Verdict::Defer));
}

#[test]
fn run_without_the_payload_defers_for_bash() {
    let ti = json!({"command": "ls"});
    let s = |tool| Subject { event: "PreToolUse", tool, cwd: None, tool_input: &ti, prompt: None };
    assert_eq!(CoordinatorWorkGuard.run(&s(Some("Bash")), &Value::Null), Some(Verdict::Defer));
    assert!(CoordinatorWorkGuard.run(&s(Some("Read")), &Value::Null).is_none());
}
