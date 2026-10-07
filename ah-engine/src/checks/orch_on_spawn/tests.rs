//! Unit tests of the silent half of orch-on-spawn; the Node-vs-engine parity corpus is `tests/spawn_ctx_parity.rs`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

fn home(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("ah-ons-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn st(h: &std::path::Path, extra: &[(&str, &str)]) -> Settings {
    let mut env: HashMap<String, String> = extra.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    env.insert("HOME".into(), h.to_string_lossy().to_string());
    Settings { home: h.to_string_lossy().to_string(), env }
}

fn marker(h: &std::path::Path, sid: &str, decision: &str) {
    let dir = h.join(".anti-hall/orch-full");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("orch-full-{sid}.json")), format!("{{\"epochId\":\"1\",\"decision\":\"{decision}\",\"sentAt\":1}}")).unwrap();
}

fn call(tool: &str) -> serde_json::Value {
    json!({"tool_name": tool, "session_id": "s1"})
}

#[test]
fn only_a_pending_marker_on_a_coordinator_spawn_defers() {
    let h = home("pending");
    marker(&h, "s1", "pending");
    assert_eq!(decide(&call("Agent"), &st(&h, &[])), Some(Verdict::Defer));
    assert_eq!(decide(&call("Bash"), &st(&h, &[])), None, "not a spawn");
    let mut sub = call("Agent");
    sub["agent_id"] = json!("a");
    assert_eq!(decide(&sub, &st(&h, &[])), None, "a subagent's own call never claims");
    assert_eq!(decide(&call("Agent"), &st(&h, &[("ANTIHALL_PROTOCOL_LEVEL", "full")])), None);
    marker(&h, "s1", "none");
    assert_eq!(decide(&call("Agent"), &st(&h, &[])), None, "a settled marker is silent");
    assert_eq!(decide(&json!({"tool_name": "Agent"}), &st(&h, &[])), None, "no session");
}

#[test]
fn nothing_is_written_or_touched_on_the_way_to_a_deferral() {
    let h = home("untouched");
    marker(&h, "s1", "pending");
    let file = h.join(".anti-hall/orch-full/orch-full-s1.json");
    let before = std::fs::metadata(&file).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(decide(&call("Agent"), &st(&h, &[])), Some(Verdict::Defer));
    assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), before, "Node refreshes the marker's age itself");
    assert_eq!(std::fs::read_dir(h.join(".anti-hall/orch-full")).unwrap().count(), 1, "no claim file");
}
