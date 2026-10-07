//! Unit tests of the stale_agent_stop_note check (parity with the Node hook is in tests/agent_controls_parity.rs).
use super::*;

#[test]
fn one_line_cuts_on_utf16_units_and_never_inside_a_pair() {
    assert_eq!(one_line("a\u{1}b\n c", 60).unwrap(), "a b c");
    assert_eq!(one_line(&"x".repeat(61), 60).unwrap(), format!("{}…", "x".repeat(60)));
    assert_eq!(one_line(&format!("{}  {}", "x".repeat(59), "y".repeat(5)), 60).unwrap(), format!("{}…", "x".repeat(59)), "trimEnd after the cut");
    assert_eq!(one_line(&format!("{}\u{1F600}tail", "x".repeat(59)), 60), Err(Unsupported));
}

#[test]
fn rounding_goes_up_on_halves_like_math_round() {
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-0.4), 0.0);
    assert_eq!(js_round(2.4), 2.0);
}

#[test]
fn a_request_without_home_defers_and_a_disabled_note_is_silent() {
    let p = serde_json::json!({"tool_name": "TaskStop", "tool_input": {"task_id": "x"}, "transcript_path": "/nope"});
    assert_eq!(decide(&p, &RequestEnv::from_pairs([("ANTIHALL_X", "1")])), Verdict::Defer);
    assert_eq!(decide(&p, &RequestEnv::from_pairs([("HOME", "/nonexistent-home"), ("ANTIHALL_STALE_AGENT_STOP_NOTE", "off")])), Verdict::Allow);
}
