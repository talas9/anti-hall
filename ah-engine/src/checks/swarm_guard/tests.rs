//! Unit tests of the swarm-guard check; the Node-vs-engine comparison is `tests/port_guards_parity.rs`.
use super::*;
use serde_json::json;
use std::collections::HashMap;

struct Fake(Option<f64>, f64);
impl MemSource for Fake {
    fn available(&self) -> Option<f64> {
        self.0
    }
    fn total(&self) -> f64 {
        self.1
    }
}

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-swarm-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

fn st(h: &str) -> Settings {
    Settings { home: h.into(), env: HashMap::from([("HOME".to_string(), h.to_string())]) }
}

fn spawn() -> Value {
    json!({"tool_name": "Agent", "tool_input": {"subagent_type": "Explore", "prompt": "x"}, "session_id": "s"})
}

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

#[test]
fn memory_below_the_floor_blocks_and_the_numbers_are_rounded_like_javascript() {
    let h = home("mem");
    let v = decide(&spawn(), &st(&h), "", &Fake(Some(0.04 * 16.0 * GB - 1.0), 16.0 * GB), 1_700_000_000_000);
    let Some(Verdict::Exact(x)) = v else { panic!("expected a block") };
    assert_eq!(x.code, 2);
    assert!(x.out.contains("memory pressure critical (655 MB available of 16384 MB total, < 4%)"), "{}", x.out);
    // exactly at the floor is allowed (strictly below blocks)
    assert!(decide(&spawn(), &st(&h), "", &Fake(Some(0.04 * 16.0 * GB), 16.0 * GB), 1_700_000_000_000).is_none());
    // an unreadable figure skips the gate
    assert!(decide(&spawn(), &st(&h), "", &Fake(None, 16.0 * GB), 1_700_000_000_001).is_none());
}

#[test]
fn the_cap_blocks_the_next_spawn_and_a_block_is_not_recorded() {
    let h = home("cap");
    let now = 1_700_000_000_000u64;
    let mem = Fake(Some(8.0 * GB), 16.0 * GB);
    for i in 0..20 {
        assert!(decide(&spawn(), &st(&h), "", &mem, now + i).is_none(), "spawn {i}");
    }
    let log = format!("{h}/.anti-hall/swarm-spawns.log");
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 20);
    let Some(Verdict::Exact(x)) = decide(&spawn(), &st(&h), "", &mem, now + 21) else { panic!("expected a block") };
    assert!(x.out.contains("agent spawn-rate ceiling reached (20 spawns in the last 60s, cap is 20)."));
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 20, "a block must not extend the window");
    let trips = std::fs::read_to_string(format!("{h}/.anti-hall/swarm-trips.log")).unwrap();
    assert!(trips.ends_with("Z\t20\tAgent:Explore\n") && trips.starts_with("2023-11-14T22:13:20.021Z\t"), "{trips}");
    // a minute later the window has moved on
    assert!(decide(&spawn(), &st(&h), "", &mem, now + 60_100).is_none());
}

#[test]
fn a_spawn_that_may_get_the_advisory_defers_before_it_is_recorded() {
    let h = home("defer");
    let mem = Fake(Some(8.0 * GB), 16.0 * GB);
    let writer = json!({"tool_name": "Agent", "tool_input": {"subagent_type": "general-purpose"}, "transcript_path": "/t.jsonl"});
    assert_eq!(decide(&writer, &st(&h), "", &mem, 1_700_000_000_000), Some(Verdict::Defer));
    assert!(!std::path::Path::new(&format!("{h}/.anti-hall/swarm-spawns.log")).exists(), "a deferral must not record the spawn");
    let isolated = json!({"tool_name": "Agent", "tool_input": {"isolation": "Worktree"}, "transcript_path": "/t.jsonl"});
    assert!(decide(&isolated, &st(&h), "", &mem, 1_700_000_000_000).is_none());
    let no_transcript = json!({"tool_name": "Agent", "tool_input": {}});
    assert!(decide(&no_transcript, &st(&h), "", &mem, 1_700_000_000_001).is_none());
}

#[test]
fn the_log_is_read_like_parse_int_and_a_huge_entry_defers() {
    assert_eq!(js_parse_int("  123abc"), Some(123.0));
    assert_eq!(js_parse_int("+7"), Some(7.0));
    assert_eq!(js_parse_int("-7"), Some(-7.0));
    assert_eq!(js_parse_int("1e3"), Some(1.0));
    assert_eq!(js_parse_int("0x10"), Some(0.0));
    assert_eq!(js_parse_int("abc"), None);
    assert_eq!(js_parse_int(""), None);
    let h = home("huge");
    std::fs::write(format!("{h}/.anti-hall/swarm-spawns.log"), "99999999999999999999\n").unwrap();
    assert_eq!(decide(&spawn(), &st(&h), "", &Fake(Some(8.0 * GB), 16.0 * GB), 1_700_000_000_000), Some(Verdict::Defer));
}

#[test]
fn the_iso_time_matches_javascript() {
    assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso(1_700_000_000_021), "2023-11-14T22:13:20.021Z");
    assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00.000Z");
    assert_eq!(iso(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
}

#[test]
fn the_write_capability_test_follows_the_node_helper() {
    assert!(!write_capable(&json!({"subagent_type": "  EXPLORE "})));
    assert!(write_capable(&json!({"subagent_type": "general-purpose"})));
    assert!(!write_capable(&json!({"tools": ["Read", "Grep"]})));
    assert!(write_capable(&json!({"tools": ["Read", "Edit"]})));
    assert!(!write_capable(&json!({"tools": []})));
    assert!(!write_capable(&json!({"tools": "Read, Grep"})));
    assert!(write_capable(&json!({"tools": 5})));
    assert!(!write_capable(&json!({"disallowedTools": ["Edit", "Write", "MultiEdit"]})));
    assert!(write_capable(&json!({"disallowedTools": ["Edit", "Write"]})));
    assert!(write_capable(&json!({"tools": [["Edit"]]})));
}
