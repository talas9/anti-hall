use super::*;
use serde_json::json;

fn st(home: &str) -> Settings {
    Settings { home: home.into(), env: Default::default() }
}

#[test]
fn a_payload_without_a_transcript_path_does_nothing() {
    for p in [json!({}), json!(null), json!({"transcript_path": ""}), json!({"transcript_path": 5})] {
        assert_eq!(decide(&p, &st("/nonexistent-home")), Verdict::Allow, "{p}");
    }
}

#[test]
fn an_unreadable_transcript_is_an_empty_task_list() {
    let p = json!({"transcript_path": "/nonexistent/transcript.jsonl", "session_id": "s"});
    assert_eq!(decide(&p, &st("/nonexistent-home")), Verdict::Allow);
}
