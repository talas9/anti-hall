//! A task list whose backfill failed (so its facts are marked unsure) is never kept in the reconstruction memo: the next check
//! computes it afresh. The control, the same shape with a backfill that succeeds, is served the second time, so the assertion
//! below is not satisfied by a memo that is simply off.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

mod common;

use ah_engine::checks::taskstate::memo::computes;
use ah_engine::script::host_d::transcript_tasks;
use serde_json::{Value, json};

fn call(id: &str, name: &str, input: Value) -> String {
    json!({"type": "assistant", "timestamp": "2026-10-07T12:00:00.000Z", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}}).to_string()
}

fn result(id: &str, text: &str) -> String {
    json!({"type": "user", "timestamp": "2026-10-07T12:00:01.000Z", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": text}]}}).to_string()
}

/// A transcript whose window holds only an update that does not carry the status, so the task's record from before the window is
/// read. `filler` is the size of the line between the create and the update: past `taskstate.backfill_prefix_scan_bytes` the
/// window starts inside a line whose end the backfill cannot find, so the backfill fails (the file is read fine; the cut is not).
fn transcript(path: &std::path::Path, filler: usize, window_in_filler: usize) -> u64 {
    let filler =
        json!({"type": "assistant", "message": {"id": "f", "role": "assistant", "content": [{"type": "text", "text": "x".repeat(filler)}]}}).to_string();
    let bare = call("t8", "TaskUpdate", json!({"taskId": "1", "owner": "me"}));
    let window = (bare.len() + window_in_filler + 11) as u64;
    let status = json!("pending");
    let lines = [
        call("t1", "TaskCreate", json!({"subject": "old subject", "status": status})),
        result("t1", "Task #1 created successfully: old subject"),
        filler,
        bare,
    ];
    std::fs::write(path, lines.join("\n") + "\n").unwrap();
    window
}

/// How many reconstructions two successive `guard` asks compute, and whether the facts were marked unsure.
fn two_asks(path: &str, window: u64) -> (u64, u64, bool) {
    let from = computes();
    let first: Value = serde_json::from_str(&transcript_tasks(path, "guard", window as f64, 0.0)).unwrap();
    let mid = computes();
    let _ = transcript_tasks(path, "guard", window as f64, 0.0);
    (mid - from, computes() - mid, first["unsure"] == json!(true))
}

#[test]
fn a_failed_backfill_leaves_the_task_facts_uncomputed_for_the_next_check() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-stopbf-{}", std::process::id())));
    std::fs::create_dir_all(&*root).unwrap();
    let ok = root.join("ok.jsonl");
    let bad = root.join("bad.jsonl");
    let (w_ok, w_bad) = (transcript(&ok, 400, 0), transcript(&bad, 10 << 20, 9 << 20));

    let (first, second, unsure) = two_asks(ok.to_str().unwrap(), w_ok);
    assert!(!unsure, "control: the backfill succeeded");
    assert!(first >= 1, "control: the first ask computes");
    assert_eq!(second, 0, "control: a complete answer is served the second time");

    let (first, second, unsure) = two_asks(bad.to_str().unwrap(), w_bad);
    assert!(unsure, "the backfill could not find where the cut line ends, so the facts are unsure");
    assert!(first >= 1 && second >= 1, "a failed backfill is computed afresh by the next ask (computes {first}, then {second})");
}
