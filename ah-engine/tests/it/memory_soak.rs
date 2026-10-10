//! The daemon's memory over a long mixed run (P1: it used to sit above its RSS cap and restart every ~10 s, until the crash-loop
//! breaker switched it off).
//!
//! Drives the real binary with thousands of hook calls of the shapes a session produces (PreToolUse, PostToolUse,
//! UserPromptSubmit, Stop with a large transcript to read, plus events no hook handles) across many sessions, with the shipped
//! default RSS cap, and checks: the same daemon served every call (zero self-restarts), its resident set stayed under the cap,
//! and after warm-up it is flat (no growth with the number of calls). The call count is `AH_SOAK_CALLS` (default 5000).
//! Every Node hook is mapped to `true`, so only the engine's own checks run, which is what holds the memory.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn calls() -> usize {
    std::env::var("AH_SOAK_CALLS").ok().and_then(|v| v.parse().ok()).unwrap_or(5000)
}

struct Soak {
    dir: PathBuf,
    transcript: PathBuf,
}

impl Soak {
    fn new() -> Soak {
        let dir = std::env::temp_dir().join(format!("ahd-soak-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(dir.join("home")).unwrap();
        // A transcript larger than the widest tail window any check reads, in the shape of a real one: user prompts, assistant
        // text, task tool uses and Bash/Edit tool uses, so the transcript-reading Stop checks have real work to do.
        let transcript = dir.join("session.jsonl");
        let mut f = std::io::BufWriter::new(std::fs::File::create(&transcript).unwrap());
        let mut written = 0usize;
        let mut i = 0u64;
        while written < 20 * 1024 * 1024 {
            let line = match i % 5 {
                0 => format!(
                    r#"{{"type":"user","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"user","content":"prompt number {i} about the engine"}}}}"#,
                    i % 60
                ),
                1 => format!(
                    r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"task {i}","status":"pending"}}}}]}}}}"#,
                    i % 60
                ),
                2 => format!(
                    r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test --lib module_{i}"}}}}]}}}}"#,
                    i % 60
                ),
                3 => format!(
                    r#"{{"type":"user","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{}","content":"Task #{i} created successfully: task"}}]}}}}"#,
                    i % 60,
                    i - 2
                ),
                _ => format!(
                    r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#,
                    i % 60,
                    "x".repeat(300)
                ),
            };
            writeln!(f, "{line}").unwrap();
            written += line.len() + 1;
            i += 1;
        }
        f.flush().unwrap();
        let mut perms = std::fs::metadata(&transcript).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&transcript, perms).unwrap();
        Soak { dir, transcript }
    }

    fn env(&self, c: &mut Command) {
        let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        c.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "memory-soak")
            .env("CLAUDE_PLUGIN_ROOT", &plugin)
            .env("AH_ENGINE_PLUGIN_ROOT", &plugin)
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .current_dir(&self.dir);
    }

    fn map(&self) -> PathBuf {
        let p = self.dir.join("map.json");
        let table: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/hooks/ah-fallback.map.json")).unwrap(),
        )
        .unwrap();
        let noop: serde_json::Map<String, serde_json::Value> = table
            .as_object()
            .unwrap()
            .iter()
            .map(|(ev, hooks)| (ev.clone(), serde_json::Value::Object(hooks.as_object().unwrap().keys().map(|h| (h.clone(), "true".into())).collect())))
            .collect();
        std::fs::write(&p, serde_json::Value::Object(noop).to_string()).unwrap();
        p
    }

    fn hook(&self, map: &Path, event: &str, payload: &serde_json::Value) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event]);
        if let Some(t) = payload.get("tool_name").and_then(|t| t.as_str()) {
            c.args(["--tool", t]);
        }
        c.args(["--host", "claude", "--fallback-map"]).arg(map);
        self.env(&mut c);
        c.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        ch.wait().unwrap();
    }

    fn status(&self) -> serde_json::Value {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["status", "--json"]);
        self.env(&mut c);
        let o = c.output().unwrap();
        serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("status is not JSON ({e}): {}", String::from_utf8_lossy(&o.stdout)))
    }

    fn payload(&self, i: usize) -> (&'static str, serde_json::Value) {
        let session = format!("soak-session-{}", i % 40);
        let t = self.transcript.to_string_lossy().to_string();
        let base = |extra: serde_json::Value| {
            let mut v = serde_json::json!({"session_id": session, "transcript_path": t, "cwd": self.dir.to_string_lossy()});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        match i % 10 {
            0 | 1 => ("PreToolUse", base(serde_json::json!({"tool_name": "Bash", "tool_input": {"command": format!("ls -la dir{i}")}}))),
            2 => (
                "PreToolUse",
                base(
                    serde_json::json!({"tool_name": "Edit", "tool_input": {"file_path": format!("{}/f{i}.rs", self.dir.display()), "old_string": "a", "new_string": "b"}}),
                ),
            ),
            3 | 4 => {
                ("PostToolUse", base(serde_json::json!({"tool_name": "Bash", "tool_input": {"command": "ls"}, "tool_response": {"stdout": "x", "stderr": ""}})))
            }
            5 => ("UserPromptSubmit", base(serde_json::json!({"prompt": format!("please look at module {i}")}))),
            6 => ("Stop", base(serde_json::json!({"stop_hook_active": false}))),
            7 => ("PostToolBatch", base(serde_json::json!({}))),
            8 => ("SubagentStop", base(serde_json::json!({"agent_id": format!("a{i}")}))),
            _ => ("SessionStart", base(serde_json::json!({"source": "startup"}))),
        }
    }

    fn stop_payload(&self, i: usize) -> serde_json::Value {
        serde_json::json!({
            "session_id": format!("measure-session-{}", i % 40),
            "transcript_path": self.transcript.to_string_lossy().to_string(),
            "cwd": self.dir.to_string_lossy().to_string(),
            "stop_hook_active": false
        })
    }
}

impl Drop for Soak {
    fn drop(&mut self) {
        common::reap(&self.dir.join("state"), || {
            let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
            c.args(["stop"]);
            self.env(&mut c);
            c.output().ok();
        });
        std::fs::remove_dir_all(&self.dir).ok();
    }
}

#[test]
fn a_long_mixed_run_stays_under_the_default_cap_and_flat_with_zero_restarts() {
    let s = Soak::new();
    let map = s.map();
    let total = calls();
    let warm = total / 5;
    let (mut at_warm, mut samples) = (None, Vec::new());
    for i in 0..total {
        let (ev, p) = s.payload(i);
        s.hook(&map, ev, &p);
        if i + 1 == warm {
            at_warm = Some(s.status());
        }
        if (i + 1) % (total / 5).max(1) == 0 && i + 1 > warm {
            samples.push(s.status());
        }
    }
    let at_warm = at_warm.expect("a warm-up sample");
    let last = samples.last().expect("a final sample");
    let cap = last["rss_cap_kb"].as_u64().unwrap_or_else(|| panic!("the final status has no rss_cap_kb (daemon gone?): {last}"));
    assert!(cap > 0, "the run must use the shipped default cap, not a lifted one");
    assert_eq!(last["restarts"].as_u64(), Some(0), "the daemon restarted during the run: {}", last["health"]);
    assert_eq!(last["health"]["restarts"]["total"].as_u64(), Some(0), "self-restarts in the event log: {}", last["health"]);
    assert_eq!(last["pid"], at_warm["pid"], "the same daemon must serve the whole run");
    for st in &samples {
        let rss = st["memory"]["rss_kb"].as_u64().unwrap();
        assert!(rss < cap, "RSS {rss} KB is over the cap {cap} KB: {}", st["memory"]);
    }
    // flat after warm-up: allowed to wander, not to follow the call count (a leak adds a roughly constant amount per call)
    let (w, l) = (at_warm["memory"]["heap_live_kb"].as_u64().unwrap(), last["memory"]["heap_live_kb"].as_u64().unwrap());
    let allowed = w / 2 + 4096;
    assert!(l <= w + allowed, "live heap grew from {w} KB at call {warm} to {l} KB at call {total}: {}", last["memory"]);
    let (rw, rl) = (at_warm["memory"]["rss_kb"].as_u64().unwrap(), last["memory"]["rss_kb"].as_u64().unwrap());
    assert!(rl <= rw + rw / 2 + 8192, "RSS grew from {rw} KB at call {warm} to {rl} KB at call {total}");
}

#[test]
#[ignore = "manual issue-21 measurement: prints cache memory at 0/1000/2500/5000 calls"]
fn measure_byte_bounded_caches_at_requested_checkpoints() {
    assert_disk_floor();
    let s = Soak::new();
    let map = s.map();
    let points = measurement_points();
    let mut done = 0usize;
    let mut prev = sample(0, &s.status(), None);
    print_row_header();
    print_row(&prev);
    for target in points.into_iter().filter(|p| *p > 0) {
        assert_disk_floor();
        while done < target {
            s.hook(&map, "Stop", &s.stop_payload(done));
            done += 1;
        }
        let row = sample(done, &s.status(), Some(&prev));
        print_row(&row);
        prev = row;
    }
}

fn measurement_points() -> Vec<usize> {
    std::env::var("AH_CACHE_MEASURE_POINTS")
        .ok()
        .map(|v| v.split(',').filter_map(|p| p.trim().parse().ok()).collect())
        .filter(|v: &Vec<usize>| !v.is_empty())
        .unwrap_or_else(|| vec![0, 1000, 2500, 5000])
}

struct Row {
    calls: usize,
    rss_kb: u64,
    footprint_kb: u64,
    jemalloc_allocated: u64,
    jemalloc_resident: u64,
    cache_bytes: u64,
    allocs_total: u64,
    allocs_per_request: f64,
}

fn sample(calls: usize, st: &serde_json::Value, prev: Option<&Row>) -> Row {
    let m = &st["memory"];
    let tt = &m["caches"]["transcript_tail"];
    let walks = &m["caches"]["agent_scan_walks"];
    let allocs_total = m["allocs"].as_u64().unwrap_or(0);
    let delta_calls = prev.map_or(0, |p| calls.saturating_sub(p.calls));
    let delta_allocs = prev.map_or(0, |p| allocs_total.saturating_sub(p.allocs_total));
    Row {
        calls,
        rss_kb: m["rss_kb"].as_u64().unwrap_or(0),
        footprint_kb: m["footprint_kb"].as_u64().unwrap_or(0),
        jemalloc_allocated: m["jemalloc"]["allocated"].as_u64().unwrap_or(0),
        jemalloc_resident: m["jemalloc"]["resident"].as_u64().unwrap_or(0),
        cache_bytes: tt["bytes"].as_u64().unwrap_or(0) + walks["estimated_bytes"].as_u64().unwrap_or(0),
        allocs_total,
        allocs_per_request: if delta_calls == 0 { 0.0 } else { delta_allocs as f64 / delta_calls as f64 },
    }
}

fn print_row_header() {
    println!("calls\trss_kb\tfootprint_kb\tjemalloc_allocated\tjemalloc_resident\tcache_bytes\tallocs_per_request");
}

fn print_row(r: &Row) {
    println!(
        "{}\t{}\t{}\t{}\t{}\t{}\t{:.2}",
        r.calls, r.rss_kb, r.footprint_kb, r.jemalloc_allocated, r.jemalloc_resident, r.cache_bytes, r.allocs_per_request
    );
}

fn assert_disk_floor() {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let out = Command::new("df").args(["-g", &home]).output().expect("df -g HOME");
    assert!(out.status.success(), "df -g {home} failed: {}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout);
    let avail = text.lines().last().and_then(|l| l.split_whitespace().nth(3)).and_then(|n| n.parse::<u64>().ok()).unwrap_or(0);
    assert!(avail >= 50, "df -g {home} reports only {avail} GB available; aborting measurement");
}
