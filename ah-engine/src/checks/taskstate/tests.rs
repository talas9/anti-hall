//! Unit tests for the task fact model. The expected task lists were computed with Node: `parseTasksFromFile` of `hooks/task-guard.js`
//! (instrumented to print the map), on the transcripts built below.
use super::parse::reconstruct;
use super::{Task, Variant};
use crate::checks::taskstate::unknown::{safe_key, sha1_hex};
use serde_json::{Value, json};

fn lines_of(v: &[Value]) -> Vec<String> {
    v.iter().map(|l| l.to_string()).collect()
}

/// (id, status, content, unknown, owner, blockedBy, blockedOn as text or "<undef>")
type Want = (&'static str, Option<&'static str>, &'static str, bool, &'static str, &'static str, &'static str);

fn check(name: &str, lines: &[Value], want: &[Want]) {
    let text = lines_of(lines);
    let refs: Vec<&str> = text.iter().map(String::as_str).collect();
    let facts = reconstruct(&refs, Variant::Guard).unwrap_or_else(|_| panic!("{name}: unsure"));
    let got: Vec<&Task> = facts.tasks.values().collect();
    assert_eq!(got.len(), want.len(), "{name}: {got:?}");
    for (t, w) in got.iter().zip(want) {
        let blocked_on = match &t.blocked_on {
            None => "<undef>".to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        };
        assert_eq!(
            (t.id.as_str(), t.status.as_deref(), t.content.as_str(), t.unknown.is_some(), t.owner.as_str(), t.blocked_by.join(","), blocked_on.as_str()),
            (w.0, w.1, w.2, w.3, w.4, w.5.to_string(), w.6),
            "{name}"
        );
    }
}

#[test]
fn create_done() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:01.000Z\",\"message\":{\"id\":\"msg_000002\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000001\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"a\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:02.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_000001\",\"content\":\"Task #1 created successfully: a\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:03.000Z\",\"message\":{\"id\":\"msg_000004\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000003\",\"name\":\"TaskUpdate\",\"input\":{\"taskId\":\"1\",\"status\":\"completed\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:04.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_000003\",\"content\":\"Updated task #1\"}]}}]").unwrap();
    check("createDone", &lines, &[("1", Some("completed"), "a", false, "", "", "<undef>")]);
}

#[test]
fn create_open_owner() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:05.000Z\",\"message\":{\"id\":\"msg_000006\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000005\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"a\",\"owner\":\" main \"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:06.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_000005\",\"content\":\"Task #1 created successfully: a\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:07.000Z\",\"message\":{\"id\":\"msg_000008\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000007\",\"name\":\"TaskUpdate\",\"input\":{\"taskId\":\"1\",\"status\":\"in_progress\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:08.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_000007\",\"content\":\"Updated task #1\"}]}}]").unwrap();
    check("createOpenOwner", &lines, &[("1", Some("in_progress"), "a", false, "main", "", "<undef>")]);
}

#[test]
fn unseen_update() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:09.000Z\",\"message\":{\"id\":\"msg_00000a\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000009\",\"name\":\"TaskUpdate\",\"input\":{\"taskId\":\"5\",\"description\":\"d\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:10.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_000009\",\"content\":\"Updated task #5\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:11.000Z\",\"message\":{\"id\":\"msg_00000c\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000b\",\"name\":\"TaskUpdate\",\"input\":{\"taskId\":\"6\",\"status\":\"pending\",\"owner\":\"x\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:12.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000b\",\"content\":\"Updated task #6\"}]}}]").unwrap();
    check("unseenUpdate", &lines, &[("5", None, "5", true, "", "", "<undef>"), ("6", Some("pending"), "6", true, "x", "", "<undef>")]);
}

#[test]
fn restart() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:13.000Z\",\"message\":{\"id\":\"msg_00000e\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000d\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"old\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:14.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000d\",\"content\":\"Task #1 created successfully: old\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:15.000Z\",\"message\":{\"id\":\"msg_00000g\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000f\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"old2\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:16.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000f\",\"content\":\"Task #2 created successfully: old2\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:17.000Z\",\"message\":{\"id\":\"msg_00000i\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000h\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"new\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:18.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000h\",\"content\":\"Task #1 created successfully: new\"}]}}]").unwrap();
    check("restart", &lines, &[("1", Some("pending"), "new", false, "", "", "<undef>")]);
}

#[test]
fn todo_reset() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:19.000Z\",\"message\":{\"id\":\"msg_00000k\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000j\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"a\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:20.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000j\",\"content\":\"Task #1 created successfully: a\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:21.000Z\",\"message\":{\"id\":\"msg_00000m\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000l\",\"name\":\"TodoWrite\",\"input\":{\"todos\":[{\"content\":\"t1\",\"status\":\"pending\"},{\"id\":\"x\",\"content\":\"t2\"}]}}]}}]").unwrap();
    check("todoReset", &lines, &[("t1", Some("pending"), "t1", false, "", "", "<undef>"), ("x", Some("pending"), "t2", false, "", "", "<undef>")]);
}

#[test]
fn list_empty() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:23.000Z\",\"message\":{\"id\":\"msg_00000o\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000n\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"a\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:24.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000n\",\"content\":\"Task #1 created successfully: a\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:25.000Z\",\"message\":{\"id\":\"msg_00000q\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000p\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"b\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:26.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000p\",\"content\":\"Task #2 created successfully: b\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:27.000Z\",\"message\":{\"id\":\"msg_00000s\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000r\",\"name\":\"TaskList\",\"input\":{}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:28.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000r\",\"content\":\"No tasks found\"}]}}]").unwrap();
    check("listEmpty", &lines, &[]);
}

#[test]
fn not_found() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:29.000Z\",\"message\":{\"id\":\"msg_00000u\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000t\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"a\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:30.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000t\",\"content\":\"Task #1 created successfully: a\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:31.000Z\",\"message\":{\"id\":\"msg_00000w\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000v\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"b\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:32.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000v\",\"content\":\"Task #2 created successfully: b\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:33.000Z\",\"message\":{\"id\":\"msg_00000y\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000x\",\"name\":\"TaskGet\",\"input\":{\"taskId\":\"1\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:34.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000x\",\"content\":\"Task #1 not found\"}]}}]").unwrap();
    check("notFound", &lines, &[("2", Some("pending"), "b", false, "", "", "<undef>")]);
}

#[test]
fn blocked_by() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:35.000Z\",\"message\":{\"id\":\"msg_000010\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_00000z\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"a\"}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:36.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_00000z\",\"content\":\"Task #1 created successfully: a\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:37.000Z\",\"message\":{\"id\":\"msg_000012\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000011\",\"name\":\"TaskCreate\",\"input\":{\"subject\":\"b\",\"blockedBy\":[\"1\"]}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:38.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_000011\",\"content\":\"Task #2 created successfully: b\"}]}},{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:39.000Z\",\"message\":{\"id\":\"msg_000014\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000013\",\"name\":\"TaskUpdate\",\"input\":{\"taskId\":\"2\",\"addBlockedBy\":[\"9\",\"1\"],\"metadata\":{\"blockedOn\":\"Owner\"}}}]}},{\"type\":\"user\",\"timestamp\":\"2026-10-06T08:00:40.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"toolu_000013\",\"content\":\"Updated task #2\"}]}}]").unwrap();
    check("blockedBy", &lines, &[("2", Some("pending"), "b", false, "", "1,9", "Owner"), ("1", Some("pending"), "a", false, "", "", "<undef>")]);
}

#[test]
fn title_only() {
    let lines: Vec<Value> = serde_json::from_str("[{\"type\":\"assistant\",\"timestamp\":\"2026-10-06T08:00:41.000Z\",\"message\":{\"id\":\"msg_000016\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"toolu_000015\",\"name\":\"TaskCreate\",\"input\":{\"title\":\"t\"}}]}}]").unwrap();
    check("titleOnly", &lines, &[("toolu_000015", Some("pending"), "t", false, "", "", "<undef>")]);
}

#[test]
fn a_line_that_is_json_null_is_not_understood() {
    assert!(reconstruct(&["null"], Variant::Guard).is_err(), "Node throws on `entry.type` and the hook exits quietly");
}

#[test]
fn a_non_string_truthy_status_is_not_understood() {
    let line = json!({"type": "assistant", "message": {"id": "m", "content": [{"type": "tool_use", "id": "t1", "name": "TaskUpdate", "input": {"taskId": "1", "status": 5}}]}}).to_string();
    assert!(reconstruct(&[line.as_str()], Variant::Guard).is_err());
}

#[test]
fn the_session_key_and_hash_follow_node() {
    // Expected values computed with Node: String(x).replace(/[^A-Za-z0-9_.-]/g, '_') and sha1(x).hex
    assert_eq!(safe_key("a/b c😀"), "a_b_c__");
    assert_eq!(sha1_hex(b"/x/y.jsonl"), "95af2b5c45318efd81ab1ea4c5d50b6fd1d9d641");
}
