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
    let payload = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":home,
        "transcript_path": home.join("t.jsonl"), "tool_input":{"subagent_type":"Explore","prompt":"x"}});
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

/// T2: one ends (the transcript shows its result), the next spawn is allowed.
#[test]
fn t2_ending_one_frees_a_slot() {
    let h = scratch("cap2");
    put(&h, "t.jsonl", &running(3));
    assert_eq!(spawn(&h).0, 0, "3 running is under the cap of 4");
    put(&h, "t.jsonl", &running(4));
    assert_eq!(spawn(&h).0, 2);
    put(&h, "t.jsonl", &running(3));
    assert_eq!(spawn(&h).0, 0);
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

/// One Stop through the silent-agent check of session `s`: (exit code, stdout).
fn stop(home: &Path) -> (i32, String) {
    let payload = json!({"hook_event_name":"Stop","tool_name":"","session_id":"s","cwd":home,"transcript_path": home.join("t.jsonl")});
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check")
        .arg("silent-agent-nudge")
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

/// T5: an open runtime escalation blocks the coordinator's Stop once (cap per session), naming the agent and its runtime; never loops.
#[test]
fn t5_runtime_escalation_blocks_one_capped_stop() {
    let h = scratch("esc");
    put(&h, "t.jsonl", "");
    let rows = json!({"rows":[{"session":"s","child":"a0","name":"lane 0","dur_ms": 3*3600*1000u64,"reminders":3}]});
    put(&h, ".anti-hall/agent-tracker/runtime-escalations.json", &rows.to_string());
    let (code, out) = stop(&h);
    assert!(code == 0 && out.contains("\"decision\":\"block\"") && out.contains("lane 0") && out.contains("3 h"), "{code} {out}");
    let (code, out) = stop(&h);
    assert!(code == 0 && !out.contains("decision"), "capped: the second Stop passes: {out}");
    put(&h, ".anti-hall/agent-tracker/runtime-escalations.json", r#"{"rows":[]}"#);
    assert!(!stop(&h).1.contains("decision"), "a finished agent leaves nothing to block on");
}
