//! #480: an open task owned by an agent the live scan cannot see (its launch lies outside the widened scan window) is "evidence
//! unavailable", not "owner ended": the Stop advises it and does not block. A complete scan that shows no such owner still blocks.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::io::Write;

fn stop_blocks(tag: &str, pad_bytes: usize) -> (bool, String) {
    let home = std::env::temp_dir().join(format!("ah-tgunk-{tag}-{}", std::process::id()));
    std::fs::remove_dir_all(&home).ok();
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap();
    let tp = real.join("t.jsonl");
    let mut f = std::fs::File::create(&tp).unwrap();
    let filler = format!(r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(900));
    for _ in 0..pad_bytes / filler.len() {
        writeln!(f, "{filler}").unwrap();
    }
    writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"c1","name":"TaskCreate","input":{{"subject":"owned","owner":"worker-1"}}}}]}}}}"#).unwrap();
    writeln!(f, r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"c1","content":"Task #1 created successfully: owned"}}]}}}}"#).unwrap();
    drop(f);
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), real.to_string_lossy().into_owned()), ("ANTIHALL_MAX_PARALLEL_DISPATCH".into(), "4".into())]);
    let payload = json!({"cwd": real, "hook_event_name": "Stop", "session_id": "s1", "transcript_path": tp});
    let v = ah_engine::script::run_forced("task-guard", &payload, &json!({}), "Stop", &env);
    let s = format!("{v:?}");
    std::fs::remove_dir_all(&real).ok();
    (s.contains("block"), s)
}

#[test]
fn scan_unknown_owner_is_advised_not_blocked() {
    // 13 MiB of other lines before the task: longer than the 12 MiB widened window, so the scan cannot prove the owner's state
    let (blocked, dbg) = stop_blocks("unk", 13 * 1024 * 1024);
    assert!(!blocked, "unknown scan evidence must not block: {dbg}");
}

#[test]
fn complete_scan_with_no_such_owner_still_blocks() {
    let (blocked, dbg) = stop_blocks("done", 0);
    assert!(blocked, "a complete scan that shows no live owner blocks: {dbg}");
}
