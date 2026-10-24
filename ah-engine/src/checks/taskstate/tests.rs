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

/// `inp.status || 'pending'` keeps a number as it is and Node only throws where it lowercases the status of a task still in the
/// final map: a record a later create replaces (here a numbering restart drops it) is read, not turned into "no tasks" (#248).
#[test]
fn a_non_string_status_a_later_create_replaces_is_read() {
    let tu = |m: &str, id: &str, input: Value| json!({"type": "assistant", "message": {"id": m, "content": [{"type": "tool_use", "id": id, "name": "TaskCreate", "input": input}]}});
    let res =
        |id: &str| json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": id, "content": "Task #1 created successfully: x"}]}});
    let lines = [tu("m1", "t1", json!({"subject": "x", "status": 7})), res("t1"), tu("m2", "t2", json!({"subject": "x"})), res("t2")];
    check("nonStringStatusReplaced", &lines, &[("1", Some("pending"), "x", false, "", "", "<undef>")]);
    // the same record left in the map is still not understood: Node's `.toLowerCase()` on it throws
    let kept = [tu("m1", "t1", json!({"subject": "x", "status": 7})), res("t1")];
    let text = lines_of(&kept);
    let refs: Vec<&str> = text.iter().map(String::as_str).collect();
    assert!(reconstruct(&refs, Variant::Guard).is_err());
}

#[test]
fn the_session_key_and_hash_follow_node() {
    // Expected values computed with Node: String(x).replace(/[^A-Za-z0-9_.-]/g, '_') and sha1(x).hex
    assert_eq!(safe_key("a/b c😀"), "a_b_c__");
    assert_eq!(sha1_hex(b"/x/y.jsonl"), "95af2b5c45318efd81ab1ea4c5d50b6fd1d9d641");
}

/// A transcript line serde rejects that `JSON.parse` reads (a 309+ digit integer is Infinity, 1e400, a lone surrogate escape, nesting
/// past 128) is not a skippable bad line and no longer a hand-back to Node (there is none): Node counts it, so the reconstruction
/// reads it too (#237) and the task it carries is kept, never turned into "no tasks".
#[test]
fn a_line_only_javascript_can_parse_is_read_not_skipped() {
    let base = json!({"type": "assistant", "message": {"id": "m", "content": [{"type": "tool_use", "id": "t1", "name": "TaskCreate", "input": {"subject": "a", "x": 1}}]}}).to_string();
    let deep = format!("{}{}", "[".repeat(150), "]".repeat(150));
    for (name, repl) in [
        ("big", format!("1{}", "0".repeat(400))),
        ("neg-big", format!("-1{}", "0".repeat(400))),
        ("e400", "1e400".into()),
        ("deep", deep),
        ("surrogate", "\"\\ud83d\"".into()),
    ] {
        let line = base.replace("\"x\":1", &format!("\"x\":{repl}"));
        assert!(serde_json::from_str::<Value>(&line).is_err(), "{name}: the fixture must be one serde rejects");
        assert!(super::parse::maybe_valid_for_js(&line), "{name}");
        for variant in [Variant::Guard, Variant::State] {
            let facts = reconstruct(&[line.as_str()], variant).unwrap_or_else(|_| panic!("{name}: {variant:?} left unsure"));
            assert_eq!(facts.tasks.len(), 1, "{name}: {variant:?} lost the task the line creates");
        }
    }
    // an unrelated line with a lone surrogate beside a task that stays open
    let other = "{\"type\":\"assistant\",\"message\":{\"id\":\"o\",\"content\":[{\"type\":\"text\",\"text\":\"cut \\ud83d here\"}]}}";
    assert!(serde_json::from_str::<Value>(other).is_err());
    let plain = base.replace("\"x\":1", "\"x\":2");
    let facts = reconstruct(&[plain.as_str(), other], Variant::Guard).unwrap_or_else(|_| panic!("unrelated line left unsure"));
    assert_eq!(facts.tasks.len(), 1);
    // a line both parsers reject is skipped
    assert!(!super::parse::maybe_valid_for_js("{\"x\": 1,"));
    assert!(reconstruct(&["{\"x\": 1,"], Variant::Guard).is_ok());
}

/// #244: a TaskCreate Node still counts although its shape is off: a numeric tool_use id (the Map key is the number, so no tool_result
/// ever matches it and the task lives under `String(5)`) and a non-string subject (rendered with `String()`). The reconstruction must
/// keep both, never answer "unsure" (which the Stop guards read as no task) or drop them.
#[test]
fn a_task_create_with_a_numeric_id_or_an_object_subject_is_still_a_task() {
    let create = |id: Value, subject: Value| {
        json!({"type": "assistant", "message": {"id": "m", "content": [{"type": "tool_use", "id": id, "name": "TaskCreate", "input": {"subject": subject}}]}})
            .to_string()
    };
    for (name, id, subject, want_id, want_content) in [
        ("numeric id", json!(5), json!("x"), "5", "x"),
        ("fractional id", json!(1.5), json!("x"), "1.5", "x"),
        ("true id", json!(true), json!("x"), "true", "x"),
        ("object subject", json!("tu_1"), json!({"a": 1}), "tu_1", "[object Object]"),
        ("array subject", json!("tu_2"), json!(["a", ["b", 2], null]), "tu_2", "a,b,2,"),
    ] {
        let line = create(id, subject);
        for variant in [Variant::Guard, Variant::State] {
            let facts = reconstruct(&[line.as_str()], variant).unwrap_or_else(|_| panic!("{name}: {variant:?} left unsure"));
            let t =
                facts.tasks.get(want_id).unwrap_or_else(|| panic!("{name}: {variant:?} has no task {want_id}: {:?}", facts.tasks.values().collect::<Vec<_>>()));
            assert_eq!((t.content.as_str(), t.status.as_deref()), (want_content, Some("pending")), "{name}: {variant:?}");
        }
    }
    // a numeric id and a string id of the same digits are two creates that land on one task
    let both = [create(json!(7), json!("first")), create(json!("7"), json!("second"))];
    let refs: Vec<&str> = both.iter().map(String::as_str).collect();
    let facts = reconstruct(&refs, Variant::Guard).unwrap();
    assert_eq!(facts.tasks.len(), 1);
    // an object subject that carries its own toString has no String(): Node throws there, so this stays unsure
    let weird = create(json!("tu_3"), json!({"toString": "x"}));
    assert!(reconstruct(&[weird.as_str()], Variant::Guard).is_err());
}

/// The tasklist-guard pass (`scanview`) applies a rename the way the reconstruction does (#177 follow-up): a subject an update set
/// is kept when the create's result is folded in, and the status and priority the pass counts are unchanged by it. The pass reports
/// ids and counts only, so the rename itself is not visible in its answer; this holds the counts.
#[test]
fn the_scan_counts_a_renamed_task_as_it_counts_an_unrenamed_one() {
    use super::scanview::scan_tasks;
    let call = |id: &str, name: &str, input: Value| {
        json!({"type": "assistant", "message": {"id": "m", "role": "assistant",
        "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
    };
    let result = |id: &str, text: &str| {
        json!({"type": "user", "message": {"role": "user",
        "content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}})
    };
    for rename in [false, true] {
        let mut update = json!({"taskId": "1", "status": "in_progress"});
        if rename {
            update["subject"] = json!("renamed after creation");
        }
        let lines = [
            call("t1", "TaskCreate", json!({"subject": "created as", "priority": "P0"})),
            result("t1", "Task #1 created successfully: created as"),
            call("t2", "TaskUpdate", update),
            result("t2", "Updated task #1"),
        ];
        let path = std::env::temp_dir().join(format!("ah-scanview-{}-{rename}.jsonl", std::process::id()));
        std::fs::write(&path, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        let scan = scan_tasks(&path.to_string_lossy(), 1 << 20, 1 << 20).unwrap().unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!((scan.open_task_ids.clone(), scan.in_progress_count, scan.saw_task_activity), (vec!["1".to_string()], 1, true), "rename={rename}");
    }
}

/// The tasklist-guard pass keeps a non-string status the way JavaScript keeps it (`status: todo.status || 'pending'`) and Node only
/// throws where `isOpenTask` lowercases the status of a task still in the final map (#251 follow-up: four more give-up sites).
mod non_string_status_in_the_scan {
    use super::super::scanview::scan_tasks;
    use serde_json::{Value, json};

    fn call(id: &str, name: &str, input: Value) -> Value {
        json!({"type": "assistant", "message": {"id": "m", "role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
    }
    fn result(id: &str, text: &str) -> Value {
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}})
    }
    /// `(open ids, in progress count)` of the scan, or `None` where the pass is not understood (an `Err`).
    fn scan(tag: &str, lines: &[Value], window: u64) -> Option<(Vec<String>, u64)> {
        let path = std::env::temp_dir().join(format!("ah-nsstatus-{}-{tag}.jsonl", std::process::id()));
        std::fs::write(&path, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        let out = scan_tasks(&path.to_string_lossy(), window, window).ok().map(|s| {
            let s = s.expect("a scan");
            (s.open_task_ids, s.in_progress_count)
        });
        std::fs::remove_file(&path).unwrap();
        out
    }

    #[test]
    fn a_todo_write_status_a_later_update_replaces_is_read() {
        let todo = call("t1", "TodoWrite", json!({"todos": [{"id": "a", "content": "x", "status": 7}]}));
        let upd = call("t2", "TaskUpdate", json!({"taskId": "a", "status": "in_progress"}));
        assert_eq!(scan("todo-upd", &[todo.clone(), upd], 1 << 20), Some((vec!["a".to_string()], 1)));
        assert_eq!(scan("todo-kept", &[todo], 1 << 20), None, "the status Node lowercases stays unsure");
    }

    #[test]
    fn a_task_create_status_a_later_update_replaces_is_read() {
        let lines = [
            call("t1", "TaskCreate", json!({"subject": "x", "status": true})),
            result("t1", "Task #1 created successfully: x"),
            call("t2", "TaskUpdate", json!({"taskId": "1", "status": "in_progress"})),
        ];
        assert_eq!(scan("create-upd", &lines, 1 << 20), Some((vec!["1".to_string()], 1)));
        assert_eq!(scan("create-kept", &lines[..2], 1 << 20), None, "the status Node lowercases stays unsure");
    }

    #[test]
    fn a_task_update_status_a_later_update_or_todo_write_replaces_is_read() {
        let first = call("t1", "TaskUpdate", json!({"taskId": "5", "status": ["completed"]}));
        let second = call("t2", "TaskUpdate", json!({"taskId": "5", "status": "pending"}));
        assert_eq!(scan("upd-upd", &[first.clone(), second], 1 << 20), Some((vec!["5".to_string()], 0)));
        let todo = call("t3", "TodoWrite", json!({"todos": [{"id": "b", "content": "y"}]}));
        assert_eq!(scan("upd-todo", &[first.clone(), todo], 1 << 20), Some((vec!["b".to_string()], 0)));
        assert_eq!(scan("upd-kept", &[first], 1 << 20), None, "the status Node lowercases stays unsure");
    }

    /// The backfill reads a record from before the window. A non-string status it does not need (the window already carries the
    /// task's status) is not read by Node's `applyRec`, so it is no reason to give up; one it applies to the task is.
    #[test]
    fn the_backfill_gives_up_only_on_a_non_string_status_it_applies() {
        let filler = json!({"type": "assistant", "message": {"id": "f", "role": "assistant", "content": [{"type": "text", "text": "x".repeat(400)}]}});
        let upd = call("t9", "TaskUpdate", json!({"taskId": "1", "status": "in_progress"}));
        let upd_len = upd.to_string().len() as u64 + 1;
        let bare = call("t8", "TaskUpdate", json!({"taskId": "1", "owner": "me"}));
        let bare_len = bare.to_string().len() as u64 + 1;
        let create = |status: Value| {
            [call("t1", "TaskCreate", json!({"subject": "old subject", "status": status})), result("t1", "Task #1 created successfully: old subject")]
        };
        // create site, status not needed: the window update carries it
        let mut lines = create(json!(7)).to_vec();
        lines.extend([filler.clone(), upd.clone()]);
        assert_eq!(scan("bf-create-unneeded", &lines, upd_len + 10), Some((vec!["1".to_string()], 1)));
        // create site, status needed: Node applies it and throws
        let mut lines = create(json!(7)).to_vec();
        lines.extend([filler.clone(), bare.clone()]);
        assert_eq!(scan("bf-create-needed", &lines, bare_len + 10), None);
        // update site, status not needed
        let mut lines = create("pending".into()).to_vec();
        lines.push(call("t0", "TaskUpdate", json!({"taskId": "1", "status": 7})));
        lines.extend([filler.clone(), upd]);
        assert_eq!(scan("bf-update-unneeded", &lines, upd_len + 10), Some((vec!["1".to_string()], 1)));
        // update site, status needed
        let mut lines = create("pending".into()).to_vec();
        lines.push(call("t0", "TaskUpdate", json!({"taskId": "1", "status": 7})));
        lines.extend([filler, bare]);
        assert_eq!(scan("bf-update-needed", &lines, bare_len + 10), None);
    }

    /// Prevention sweep: every transcript-status read site (TodoWrite, TaskCreate, TaskUpdate) with every bad shape. A truthy
    /// non-string status a later update replaces is read; one a task keeps is unsure (never a silent allow); a falsy one is `pending`.
    #[test]
    fn every_status_read_site_decides_every_bad_shape_like_node() {
        let truthy_shapes = [json!(7), json!(true), json!({"a": 1}), json!(["completed"]), json!(-1.5)];
        let falsy_shapes = [json!(null), json!(0), json!(false)];
        let replace = call("r", "TaskUpdate", json!({"taskId": "1", "status": "in_progress"}));
        for (n, shape) in truthy_shapes.iter().chain(falsy_shapes.iter()).enumerate() {
            let is_truthy = n < truthy_shapes.len();
            let sites: [(&str, Vec<Value>); 3] = [
                ("todo", vec![call("t", "TodoWrite", json!({"todos": [{"id": "1", "content": "x", "status": shape}]}))]),
                ("create", vec![call("t", "TaskCreate", json!({"subject": "x", "status": shape})), result("t", "Task #1 created successfully: x")]),
                ("update", vec![call("t", "TaskUpdate", json!({"taskId": "1", "status": shape}))]),
            ];
            for (site, lines) in sites {
                let tag = format!("sweep-{site}-{n}");
                let kept = scan(&tag, &lines, 1 << 20);
                let mut replaced = lines.clone();
                replaced.push(replace.clone());
                let after = scan(&format!("{tag}-r"), &replaced, 1 << 20);
                assert_eq!(after, Some((vec!["1".to_string()], 1)), "{site} {shape}: a later update replaces it");
                if is_truthy {
                    assert_eq!(kept, None, "{site} {shape}: a kept non-string status is unsure");
                } else if site != "update" {
                    // a TaskUpdate of an unseen task with no status makes no pending task (Node: no record to lowercase)
                    assert_eq!(kept, Some((vec!["1".to_string()], 0)), "{site} {shape}: a falsy status is pending");
                }
            }
        }
    }
}
