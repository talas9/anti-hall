use super::*;
use serde_json::json;

fn st(home: &str) -> Settings {
    Settings { home: home.into(), env: Default::default() }
}

#[test]
fn a_relative_cwd_defers() {
    let p = json!({"hook_event_name": "TaskCreated", "cwd": "rel/dir", "task_id": "1", "session_id": "s"});
    assert_eq!(decide(&p, &st("/h"), 0), Verdict::Defer);
}

#[test]
fn an_unrelated_event_or_missing_fields_do_nothing() {
    for p in [
        json!(null),
        json!([1]),
        json!({"hook_event_name": "Stop"}),
        json!({"hook_event_name": "TaskCreated"}),
        json!({"hook_event_name": "TaskCreated", "cwd": "/x"}),
    ] {
        assert_eq!(decide(&p, &st("/h"), 0), Verdict::Allow, "{p}");
    }
}
