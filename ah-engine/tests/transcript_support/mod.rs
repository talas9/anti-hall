//! Fixture builders for the transcript index tests: lines shaped like the ones the harness writes (the shapes are the
//! ones `tests/hooks/silent-agent-nudge.test.js` verified against real transcripts), and a temp directory that removes
//! only itself.
#![allow(dead_code)] // each test binary uses a subset

use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering::SeqCst};

/// A unique temp directory that is removed (it and nothing else) when dropped.
pub struct Tmp(pub PathBuf);

impl Tmp {
    pub fn new(tag: &str) -> Tmp {
        static N: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!("ah-{tag}-{}-{}", std::process::id(), N.fetch_add(1, SeqCst)));
        std::fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
    pub fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.0));
    }
}

pub fn jsonl(entries: &[Value]) -> String {
    entries.iter().map(|e| e.to_string() + "\n").collect()
}

pub fn write(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
}

pub fn append(path: &Path, text: &str) {
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(path).unwrap().write_all(text.as_bytes()).unwrap();
}

pub const TS: &str = "2026-10-04T10:00:00.000Z";

pub fn user_text(text: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": text}, "timestamp": TS, "uuid": "u1"})
}

pub fn user_blocks(texts: &[&str]) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": texts.iter().map(|t| json!({"type": "text", "text": t})).collect::<Vec<_>>()}, "timestamp": TS})
}

pub fn assistant(msg_id: &str, texts: &[&str], tool_uses: &[Value]) -> Value {
    let mut content: Vec<Value> = texts.iter().map(|t| json!({"type": "text", "text": t})).collect();
    content.extend(tool_uses.iter().cloned());
    json!({"type": "assistant", "message": {"id": msg_id, "role": "assistant", "content": content}, "timestamp": TS, "isSidechain": false})
}

pub fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

pub fn tool_result(id: &str, text: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}, "timestamp": TS})
}

pub fn notification_text(task_id: &str, status: &str) -> String {
    format!(
        "<task-notification>\n<task-id>{task_id}</task-id>\n<tool-use-id>toolu_01ABCDEF</tool-use-id>\n<output-file>/tmp/x/tasks/{task_id}.output</output-file>\n<status>{status}</status>\n<summary>Agent \"x\" finished</summary>\n</task-notification>"
    )
}

/// The three shapes a completion notice reaches the main transcript in.
pub fn notif_user(task_id: &str, status: &str) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": notification_text(task_id, status)}, "timestamp": TS})
}

pub fn notif_attachment(task_id: &str, status: &str) -> Value {
    json!({"type": "attachment", "attachment": {"type": "prompt", "commandMode": false, "prompt": notification_text(task_id, status), "timestamp": TS}, "timestamp": TS})
}

pub fn notif_queue_op(task_id: &str, status: &str) -> Value {
    json!({"type": "queue-operation", "operation": "enqueue", "content": notification_text(task_id, status), "timestamp": TS})
}

pub fn task_status_attachment(task_id: &str, status: &str) -> Value {
    json!({"type": "attachment", "attachment": {"type": "task_status", "taskId": task_id, "taskType": "local_agent", "description": "Compacted worker", "status": status, "outputFilePath": "/tmp/x/o"}, "timestamp": TS})
}

pub fn compact_boundary() -> Value {
    json!({"type": "system", "subtype": "compact_boundary", "compactMetadata": {"trigger": "auto"}, "timestamp": TS})
}

pub fn compact_summary() -> Value {
    json!({"type": "user", "isCompactSummary": true, "message": {"role": "user", "content": "This session is being continued..."}, "timestamp": TS})
}

/// A realistic multi-turn session covering every fact the index keeps.
pub fn session() -> Vec<Value> {
    vec![
        json!({"type": "summary", "summary": "x", "leafUuid": "l"}),
        user_text("please build the thing"),
        assistant(
            "msg_1",
            &["On it.", "Creating tasks."],
            &[tool_use("toolu_a", "TaskCreate", json!({"subject": "build", "description": "d"})), tool_use("toolu_b", "Bash", json!({"command": "ls"}))],
        ),
        tool_result("toolu_a", "Task #1 created successfully: build"),
        tool_result("toolu_b", "file1\nfile2"),
        assistant("msg_2", &["Spawned a helper."], &[tool_use("toolu_c", "Agent", json!({"description": "helper", "run_in_background": true}))]),
        notif_user("a111111111111111", "completed"),
        notif_attachment("a222222222222222", "killed"),
        notif_queue_op("a333333333333333", "failed"),
        assistant("msg_3", &["All done, tests pass."], &[tool_use("toolu_d", "TaskUpdate", json!({"taskId": "1", "status": "completed"}))]),
        tool_result("toolu_d", "Updated task #1 status"),
    ]
}
