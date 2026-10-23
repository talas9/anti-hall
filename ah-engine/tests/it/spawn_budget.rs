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

const CACHE: &str = ".claude/plugins/oh-my-claudecode/.usage-cache-anthropic.json";

/// One spawn through the check: (exit code, stdout).
fn spawn(home: &Path) -> (i32, String) {
    let payload = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":home,
        "transcript_path": home.join("t.jsonl"), "tool_input":{"subagent_type":"Explore","prompt":"x"}});
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.arg("check").arg("swarm-guard").env_clear().env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", home).env("USERPROFILE", home).env("ANTIHALL_TEST_ISOLATION", "1").current_dir(home)
        .env("AH_ENGINE_DIR", home.join("engine-state"))
        .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned())
}

#[test]
fn ceiling_blocks_at_twelve_running_and_names_them() {
    let h = scratch("ceil");
    put(&h, "t.jsonl", &running(12));
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("spawn-ceiling") && out.contains("12 agents") && out.contains("lane 0"), "{out}");
    put(&h, "t.jsonl", &running(11));
    assert_eq!(spawn(&h).0, 0, "11 running is under the ceiling");
}

#[test]
fn ceiling_shrinks_near_the_limit() {
    let h = scratch("shrink");
    put(&h, "t.jsonl", &running(6));
    put(&h, CACHE, &usage(10.0, 86.0)); // step 85 -> ceiling 12 - 6 = 6
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("ceiling now 6"), "{out}");
}

#[test]
fn usage_soft_advises_and_hard_blocks() {
    let h = scratch("usage");
    put(&h, "t.jsonl", "");
    put(&h, CACHE, &usage(80.0, 10.0));
    let (code, out) = spawn(&h);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("spawn-usage") && out.contains("5-hour"), "{out}");
    put(&h, CACHE, &usage(10.0, 95.0));
    let (code, out) = spawn(&h);
    assert_eq!(code, 2, "{out}");
    assert!(out.contains("weekly") && out.contains("2099-01-02T00:00Z"), "{out}");
    put(&h, CACHE, &usage(10.0, 20.0));
    let (code, out) = spawn(&h);
    assert!(code == 0 && !out.contains("spawn-usage"), "{out}");
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
    put(&h, ".anti-hall/settings.json", r#"{"guards":{"spawnCeiling":false,"usageAwareDispatch":false}}"#);
    assert_eq!(spawn(&h).0, 0, "the switches lift both");
}
