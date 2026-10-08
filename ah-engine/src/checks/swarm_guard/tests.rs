//! Unit tests of the swarm-guard check; the Node-vs-engine comparison is `tests/port_guards_parity.rs`.
use super::*;
use crate::reqenv::RequestEnv;
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
    crate::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d.to_string_lossy().to_string()
}

fn st(h: &str) -> Settings {
    Settings { home: h.into(), env: HashMap::from([("HOME".to_string(), h.to_string())]) }
}

fn env() -> RequestEnv {
    RequestEnv::from_pairs(Vec::<(String, String)>::new())
}

fn spawn() -> Value {
    json!({"tool_name": "Agent", "tool_input": {"subagent_type": "Explore", "prompt": "x"}, "session_id": "s"})
}

const GB: f64 = 1024.0 * 1024.0 * 1024.0;

#[test]
fn memory_below_the_floor_blocks_and_the_numbers_are_rounded_like_javascript() {
    let h = home("mem");
    let v = decide(&spawn(), &st(&h), "", &env(), &Fake(Some(0.04 * 16.0 * GB - 1.0), 16.0 * GB), 1_700_000_000_000);
    let Some(Verdict::Exact(x)) = v else { panic!("expected a block") };
    assert_eq!(x.code, 2);
    assert!(x.out.contains("memory pressure critical (655 MB available of 16384 MB total, < 4%)"), "{}", x.out);
    // exactly at the floor is allowed (strictly below blocks)
    assert!(decide(&spawn(), &st(&h), "", &env(), &Fake(Some(0.04 * 16.0 * GB), 16.0 * GB), 1_700_000_000_000).is_none());
    // an unreadable figure skips the gate
    assert!(decide(&spawn(), &st(&h), "", &env(), &Fake(None, 16.0 * GB), 1_700_000_000_001).is_none());
}

#[test]
fn the_cap_blocks_the_next_spawn_and_a_block_is_not_recorded() {
    let h = home("cap");
    let now = 1_700_000_000_000u64;
    let mem = Fake(Some(8.0 * GB), 16.0 * GB);
    for i in 0..20 {
        assert!(decide(&spawn(), &st(&h), "", &env(), &mem, now + i).is_none(), "spawn {i}");
    }
    let log = format!("{h}/.anti-hall/swarm-spawns.log");
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 20);
    let Some(Verdict::Exact(x)) = decide(&spawn(), &st(&h), "", &env(), &mem, now + 21) else { panic!("expected a block") };
    assert!(x.out.contains("agent spawn-rate ceiling reached (20 spawns in the last 60s, cap is 20)."));
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 20, "a block must not extend the window");
    let trips = std::fs::read_to_string(format!("{h}/.anti-hall/swarm-trips.log")).unwrap();
    assert!(trips.ends_with("Z\t20\tAgent:Explore\n") && trips.starts_with("2023-11-14T22:13:20.021Z\t"), "{trips}");
    // a minute later the window has moved on
    assert!(decide(&spawn(), &st(&h), "", &env(), &mem, now + 60_100).is_none());
}

/// A transcript whose tail holds one launched, still running agent started with `input`.
fn transcript(h: &str, input: Value) -> String {
    let path = format!("{h}/t.jsonl");
    let launch = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_1", "name": "Agent", "input": input}]}});
    let result = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1",
        "content": "Async agent launched successfully.\nagentId: a1b2c3d4e5f60718 (internal ID - do not mention to user)\noutput_file: /tmp/x/a1b2c3d4e5f60718.output"}]}});
    std::fs::write(&path, format!("{launch}\n{result}\n")).unwrap();
    path
}

fn note_of(v: Option<Verdict>) -> Option<String> {
    match v {
        Some(Verdict::Advisory(a)) => Some(a),
        None => None,
        other => panic!("unexpected {other:?}"),
    }
}

#[test]
fn a_write_capable_spawn_beside_a_running_writer_gets_the_advisory_and_is_recorded() {
    let h = home("adv");
    let mem = Fake(Some(8.0 * GB), 16.0 * GB);
    let t = transcript(&h, json!({"subagent_type": "general-purpose", "prompt": "fix it"}));
    let writer = json!({"tool_name": "Agent", "tool_input": {"subagent_type": "general-purpose"}, "transcript_path": t, "cwd": h});
    let a = note_of(decide(&writer, &st(&h), "", &env(), &mem, 1_700_000_000_000)).expect("advisory");
    assert!(a.contains("anti-hall \u{b7} shared-tree: another write-capable agent") && a.contains("pass isolation:\\\"worktree\\\""), "{a}");
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/swarm-spawns.log")).unwrap().lines().count(), 1, "an advisory spawn is recorded once");
    // a repo that forbids worktrees drops the isolation hint
    std::fs::write(format!("{h}/CLAUDE.md"), "Rules: no worktrees here.\n").unwrap();
    let a = note_of(decide(&writer, &st(&h), "", &env(), &mem, 1_700_000_000_001)).expect("advisory");
    assert!(a.contains("serialize them or give each its own scratch clone.") && !a.contains("isolation"), "{a}");
}

#[test]
fn the_advisory_is_silent_whenever_node_is_silent() {
    let h = home("quiet");
    let mem = Fake(Some(8.0 * GB), 16.0 * GB);
    let busy = transcript(&h, json!({"subagent_type": "general-purpose"}));
    let call = |input: Value, t: &str| json!({"tool_name": "Agent", "tool_input": input, "transcript_path": t, "cwd": h});
    let mut n = 0u64;
    let mut silent = |input: Value, t: &str| {
        n += 1;
        note_of(decide(&call(input, t), &st(&h), "", &env(), &mem, 1_700_000_000_000 + n)).is_none()
    };
    assert!(silent(json!({"subagent_type": "Explore"}), &busy), "a read-only type");
    assert!(silent(json!({"isolation": "worktree"}), &busy), "an isolated spawn");
    assert!(silent(json!({"prompt": "work in a scratch clone under /tmp/x"}), &busy), "a scratch spawn");
    assert!(!silent(json!({"prompt": "work in a scratch clone under /tmp/x, in the repo"}), &busy), "an in-place statement cancels scratch");
    assert!(!silent(json!({"prompt": "not in scratch /tmp/x"}), &busy), "a negation cancels scratch");
    assert!(silent(json!({}), "/missing/transcript.jsonl"), "an unreadable transcript");
    assert!(silent(json!({}), &transcript(&h, json!({"subagent_type": "Explore"}))), "the other agent is read-only");
    assert!(silent(json!({}), &transcript(&h, json!({"isolation": "remote"}))), "the other agent is isolated");
    assert!(silent(json!({}), &transcript(&h, json!({"prompt": "cd /private/tmp/x and work"}))), "the other agent works in scratch");
    let no_transcript = json!({"tool_name": "Agent", "tool_input": {}});
    assert!(note_of(decide(&no_transcript, &st(&h), "", &env(), &mem, 1_700_000_100_000)).is_none());
}

#[test]
fn what_the_port_cannot_reproduce_defers_before_the_spawn_is_recorded() {
    let h = home("defer");
    let mem = Fake(Some(8.0 * GB), 16.0 * GB);
    let t = transcript(&h, json!({"subagent_type": "general-purpose"}));
    let log = format!("{h}/.anti-hall/swarm-spawns.log");
    // no cwd: Node would use the hook process's own directory
    let no_cwd = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": t});
    assert_eq!(decide(&no_cwd, &st(&h), "", &env(), &mem, 1_700_000_000_000), Some(Verdict::Defer));
    // a relative transcript path resolves against the hook's directory
    let rel = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": "t.jsonl", "cwd": h});
    assert_eq!(decide(&rel, &st(&h), "", &env(), &mem, 1_700_000_000_001), Some(Verdict::Defer));
    // a cwd that is not in normal form
    let odd = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": t, "cwd": format!("{h}/../x")});
    assert_eq!(decide(&odd, &st(&h), "", &env(), &mem, 1_700_000_000_002), Some(Verdict::Defer));
    assert!(!std::path::Path::new(&log).exists(), "a deferral must not record the spawn");
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
    assert_eq!(decide(&spawn(), &st(&h), "", &env(), &Fake(Some(8.0 * GB), 16.0 * GB), 1_700_000_000_000), Some(Verdict::Defer));
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
