//! The fan-out ceiling (`spawn-ceiling`) and usage-aware dispatch (`spawn-usage`) of `swarm-guard` (GH #270), through the real
//! check in a scratch home. Thresholds and texts come from `engine/defaults/spawn_guards.toml`.
use serde_json::json;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ah-spawnbudget-{tag}-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&d));
    std::fs::create_dir_all(d.join(".anti-hall")).unwrap();
    d
}

fn put(home: &Path, rel: &str, body: &str) {
    let p = home.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, body).unwrap();
}

/// A transcript in which `n` background agents were launched and none has finished.
fn running(n: usize) -> String {
    let mut out = String::new();
    for i in 0..n {
        let (tu, id) = (format!("toolu_{i}"), format!("a{i:015x}"));
        let call = json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":tu,"name":"Agent","input":{"description":format!("lane {i}"),"subagent_type":"Explore"}}]}});
        let result = json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":tu,
            "content":format!("Async agent launched successfully.\nagentId: {id} (internal ID - do not mention to user)\noutput_file: /tmp/ah-none/{id}.output")}]}});
        out.push_str(&format!("{call}\n{result}\n"));
    }
    out
}

fn usage(five: f64, weekly: f64) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    json!({"timestamp": now, "data": {"fiveHourPercent": five, "weeklyPercent": weekly,
        "fiveHourResetsAt": "2099-01-01T05:00:00.000Z", "weeklyResetsAt": "2099-01-02T00:00:00.000Z"}})
    .to_string()
}

/// The tracker's proof that the first `n` agents of `running(n)` are live: a fresh, readable subagent transcript each and a retained
/// tracker row for it. `spawn_ceiling.ignore_unknown_liveness` (default true) counts a transcript row only on such proof, so a bare
/// transcript row no longer fills a spawn slot.
fn tracked(home: &Path, n: usize) {
    let mut st = ah_engine::agents::State::default();
    for i in 0..n {
        let id = format!("a{i:015x}");
        let rel = format!(".claude/projects/p/s/subagents/agent-{id}.jsonl");
        put(home, &rel, &format!("{}\n", json!({"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}})));
        let a = ah_engine::agents::Agent {
            id: id.clone(),
            kind: "subagent".into(),
            parent: "s".into(),
            name: format!("lane {i}"),
            cwd: home.to_string_lossy().into_owned(),
            path: home.join(rel).to_string_lossy().into_owned(),
            ..Default::default()
        };
        st.agents.insert(id, a);
    }
    put(home, ".anti-hall/agent-tracker/state.json", &serde_json::to_string(&st).unwrap());
}

const NO_CAP: &str = r#"{"guards":{"maxConcurrentAgents":0}}"#;
const CACHE: &str = ".claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json";

/// One spawn through the check: (exit code, stdout).
fn spawn(home: &Path) -> (i32, String) {
    spawn_as(home, "")
}

/// One spawn through the check carrying the tool call id `tu` (none when empty): (exit code, stdout).
fn spawn_as(home: &Path, tu: &str) -> (i32, String) {
    let mut payload = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":home,
        "transcript_path": home.join("t.jsonl"), "tool_input":{"subagent_type":"Explore","prompt":"x"}});
    if !tu.is_empty() {
        payload["tool_use_id"] = json!(tu);
    }
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check")
        .arg("swarm-guard")
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("ANTIHALL_TEST_ISOLATION", "1")
        .current_dir(home)
        .env("AH_ENGINE_DIR", home.join("engine-state"))
        .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned())
}

#[test]
fn ceiling_blocks_at_twelve_running_and_names_them() {
    let h = scratch("ceil");
    put(&h, ".anti-hall/settings.json", NO_CAP);
    put(&h, "t.jsonl", &running(12));
    tracked(&h, 12);
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("spawn ceiling") && out.contains("12 agents") && out.contains("limit 12"), "{out}");
    put(&h, "t.jsonl", &running(11));
    assert_eq!(spawn(&h).0, 0, "11 running is under the ceiling");
}

#[test]
fn ceiling_shrinks_near_the_limit() {
    let h = scratch("shrink");
    put(&h, ".anti-hall/settings.json", NO_CAP);
    put(&h, "t.jsonl", &running(6));
    tracked(&h, 6);
    put(&h, CACHE, &usage(10.0, 86.0)); // step 85 -> ceiling 12 - 6 = 6
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("6 agents are running (limit 6)"), "{out}");
}

#[test]
fn usage_soft_advises_and_hard_blocks() {
    let h = scratch("usage");
    put(&h, "t.jsonl", "");
    put(&h, CACHE, &usage(80.0, 10.0));
    let (code, out) = spawn(&h);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("usage limit") && out.contains("5-hour"), "{out}");
    put(&h, CACHE, &usage(10.0, 95.0));
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("weekly") && out.contains("2099-01-02T00:00Z"), "{out}");
    put(&h, CACHE, &usage(10.0, 20.0));
    let (code, out) = spawn(&h);
    assert!(code == 0 && !out.contains("usage limit"), "{out}");
}

#[test]
fn switches_and_skip_lift_the_guards() {
    let h = scratch("off");
    put(&h, "t.jsonl", &running(12));
    put(&h, CACHE, &usage(99.0, 99.0));
    assert_eq!(spawn(&h).0, 2);
    put(&h, ".anti-hall/skip.json", r#"{"spawn-ceiling":99999999999999,"spawn-usage":99999999999999}"#);
    assert_eq!(spawn(&h).0, 0, "skip entries lift both");
    std::fs::remove_file(h.join(".anti-hall/skip.json")).unwrap();
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"spawnCeiling":false,"usageAwareDispatch":false,"maxConcurrentAgents":0}}"#);
    assert_eq!(spawn(&h).0, 0, "the switches lift both");
}

// ---- GH #484: the owner's concurrent-agent cap (guards.maxConcurrentAgents, default 4) ----

/// T1: 4 agents running, none of them tracked (unknown liveness counts as running), the 5th spawn is denied naming the cap and the agents.
#[test]
fn t1_fifth_spawn_denied_naming_cap_and_agents_unknown_liveness_counts() {
    let h = scratch("cap1");
    put(&h, "t.jsonl", &running(4));
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("limit 4") && out.contains("lane 0") && out.contains("lane 3"), "{out}");
    assert!(!out.contains("a000000000000000"), "no raw ids: {out}");
}

/// T2: one of four ends (its completion notification is appended to the same transcript), and that frees the slot it held.
#[test]
fn t2_ending_one_frees_a_slot() {
    let h = scratch("cap2");
    let mut t = running(4);
    put(&h, "t.jsonl", &t);
    assert_eq!(spawn(&h).0, 2, "4 running is at the cap of 4");
    let text = format!("<task-notification>\n<task-id>a{:015x}</task-id>\n<status>completed</status>\n</task-notification>", 3);
    t.push_str(&format!("{}\n", json!({"type":"user","message":{"role":"user","content":text}})));
    put(&h, "t.jsonl", &t);
    assert_eq!(spawn(&h).0, 0, "the finished agent no longer holds a slot");
}

/// T3: 0 is off; the setting is respected.
#[test]
fn t3_zero_turns_the_cap_off_and_the_value_is_the_cap() {
    let h = scratch("cap3");
    put(&h, "t.jsonl", &running(8));
    assert_eq!(spawn(&h).0, 2);
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":0}}"#);
    assert_eq!(spawn(&h).0, 0, "0 = no cap (the 8 are unproven under the 12-agent ceiling)");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":9}}"#);
    assert_eq!(spawn(&h).0, 0, "8 running under a cap of 9");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":8}}"#);
    assert_eq!(spawn(&h).0, 2, "8 running at a cap of 8");
}

/// A transcript with no agent launched in it (a prompt and an answer).
fn quiet() -> String {
    format!("{}\n{}\n", json!({"type":"user","message":{"role":"user","content":"go"}}),
        json!({"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}))
}

const RESERVATIONS: &str = ".anti-hall/spawn-reservations.json";

/// P1: a burst of 6 overlapping spawn checks with nothing running and the cap at 4: each allow reserves its slot atomically, so
/// exactly 4 are allowed and 2 denied.
#[test]
fn t6_a_parallel_burst_cannot_pass_the_cap() {
    let h = scratch("burst");
    put(&h, "t.jsonl", &quiet());
    let go = std::sync::Arc::new(std::sync::Barrier::new(6));
    let runs: Vec<_> = (0..6)
        .map(|i| {
            let (h, go) = (h.clone(), go.clone());
            std::thread::spawn(move || {
                go.wait();
                spawn_as(&h, &format!("toolu_burst{i}")).0
            })
        })
        .collect();
    let codes: Vec<i32> = runs.into_iter().map(|r| r.join().unwrap()).collect();
    assert_eq!(codes.iter().filter(|c| **c == 0).count(), 4, "{codes:?}");
    assert_eq!(codes.iter().filter(|c| **c == 2).count(), 2, "{codes:?}");
}

/// P1: a reservation whose launch never arrives (a crashed or denied call) frees its slot when it expires.
#[test]
fn t7_an_expired_reservation_frees_its_slot() {
    let h = scratch("expire");
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"maxConcurrentAgents":1}}"#);
    put(&h, "t.jsonl", &quiet());
    assert_eq!(spawn_as(&h, "toolu_e0").0, 0, "the first spawn reserves the one slot");
    assert_eq!(spawn_as(&h, "toolu_e1").0, 2, "the reserved slot is taken");
    let mut doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(h.join(RESERVATIONS)).unwrap()).unwrap();
    for r in doc["rows"].as_array_mut().unwrap() {
        r["at"] = json!(1); // aged far past the TTL
    }
    put(&h, RESERVATIONS, &doc.to_string());
    assert_eq!(spawn_as(&h, "toolu_e2").0, 0, "an expired reservation no longer holds the slot");
}

/// P1: the launch result of a reserved spawn releases that reservation only, so the launched agent is counted once and the other
/// reservation still holds its slot (no double free).
#[test]
fn t8_a_launch_result_releases_its_own_reservation_once() {
    let h = scratch("release");
    put(&h, "t.jsonl", &running(2));
    assert_eq!(spawn_as(&h, "toolu_2").0, 0, "2 running + 0 reserved");
    assert_eq!(spawn_as(&h, "toolu_3").0, 0, "2 running + 1 reserved");
    assert_eq!(spawn_as(&h, "toolu_x").0, 2, "2 running + 2 reserved is the cap");
    put(&h, "t.jsonl", &running(3)); // toolu_2's launch result arrived
    assert_eq!(spawn_as(&h, "toolu_y").0, 2, "3 running + toolu_3 still reserved is the cap");
}

/// P2: tracked running agents count even when their launches fell out of the transcript window: 4 tracked + 1 visible launch is 4.
#[test]
fn t9_tracked_agents_outside_the_window_count() {
    let h = scratch("tracked");
    put(&h, "t.jsonl", &running(1));
    tracked(&h, 4);
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("4 agents are running"), "{out}");
}
