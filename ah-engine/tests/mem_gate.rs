//! The D memory gate (A): a scratch daemon replays UserPromptSubmit and Stop payloads over very large transcripts, with lines
//! appended while it runs, and the peak heap is compared between the big transcripts and a small control. Ignored by default (it
//! takes minutes and needs the machine's largest transcript): run it through `scripts/mem-gate.sh`.
//!
//! What it never touches: the live engine (own HOME, own `AH_ENGINE_DIR`, own socket), and the source transcript (APFS `cp -c`
//! clones only; the original is opened for reading).
//!
//! Pass criteria are the `mem_gate.*` keys of `defaults/diagnostics.toml`, read from the plugin directory next to this checkout:
//! - peak heap with the big transcripts minus peak heap with the small ones <= `mem_gate.size_delta_mb`
//! - peak footprint <= `mem_gate.peak_footprint_mb`
//! - `transcript_read_buf_max_bytes` <= `transcript.read_buf_bytes` + `transcript.max_line_bytes` (a missing counter fails)
//! - parsed / appended bytes <= `mem_gate.parse_ratio_max_permille` (a missing counter fails)
//! - `transcript_store_cold_builds` == number of sessions (a missing counter fails)
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // a test crate: a panic is the failure report

use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MB: f64 = 1024.0 * 1024.0;

fn plugin_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

/// The `value` of the table `[key]` of a defaults file.
fn default_value(file: &str, key: &str) -> Value {
    let text = std::fs::read_to_string(plugin_root().join("engine/defaults").join(file)).unwrap_or_else(|e| panic!("{file}: {e}"));
    let doc: toml::Table = text.parse().unwrap_or_else(|e| panic!("{file}: {e}"));
    let mut cur = &toml::Value::Table(doc.clone());
    for part in key.split('.') {
        cur = cur.get(part).unwrap_or_else(|| panic!("{file} has no {key}"));
    }
    let v = cur.get("value").unwrap_or_else(|| panic!("{file} {key} has no value"));
    serde_json::to_value(v).unwrap()
}

fn num(file: &str, key: &str) -> f64 {
    default_value(file, key).as_f64().unwrap_or_else(|| panic!("{key} is not a number"))
}

/// The ids of the Node twins of both events' native checks: the gate answers each with `true`, so a check that defers does not start Node.
fn fallback_map(dir: &Path) -> PathBuf {
    let text = std::fs::read_to_string(plugin_root().join("engine/defaults/dispatch.toml")).unwrap();
    let doc: toml::Table = text.parse().unwrap();
    let mut map = serde_json::Map::new();
    for event in ["UserPromptSubmit", "Stop"] {
        let entries = doc["dispatch"][format!("hooks_claude_{event}")]["value"].as_array().unwrap();
        let ids: serde_json::Map<String, Value> = entries.iter().map(|e| (e["id"].as_str().unwrap().to_string(), Value::String("true".into()))).collect();
        map.insert(event.to_string(), Value::Object(ids));
    }
    let p = dir.join("fallback-map.json");
    std::fs::write(&p, Value::Object(map).to_string()).unwrap();
    p
}

/// The largest `*.jsonl` under `~/.claude/projects` (read-only walk), or `AH_MEM_GATE_SRC`.
fn largest_transcript() -> PathBuf {
    if let Ok(p) = std::env::var("AH_MEM_GATE_SRC") {
        return PathBuf::from(p);
    }
    let root = Path::new(&std::env::var("HOME").unwrap()).join(".claude/projects");
    let mut best: Option<(u64, PathBuf)> = None;
    for proj in std::fs::read_dir(&root).unwrap().flatten() {
        let Ok(rd) = std::fs::read_dir(proj.path()) else { continue };
        for f in rd.flatten() {
            let p = f.path();
            if p.extension().is_some_and(|e| e == "jsonl")
                && let Ok(md) = f.metadata()
                && best.as_ref().is_none_or(|(n, _)| md.len() > *n)
            {
                best = Some((md.len(), p));
            }
        }
    }
    best.expect("no transcript under ~/.claude/projects").1
}

/// `cp -c`: an APFS clone (about 0 disk). Falls back to a plain copy when the volume cannot clone.
fn clone_file(src: &Path, dst: &Path) {
    let ok = Command::new("cp").arg("-c").arg(src).arg(dst).status().is_ok_and(|s| s.success());
    if !ok {
        std::fs::copy(src, dst).unwrap();
    }
}

/// The last `bytes` of `src`, cut at a line boundary, written to `dst`.
fn tail_copy(src: &Path, dst: &Path, bytes: u64) {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(src).unwrap();
    let len = f.metadata().unwrap().len();
    f.seek(SeekFrom::Start(len.saturating_sub(bytes))).unwrap();
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).unwrap();
    let start = if len > bytes { buf.iter().position(|b| *b == b'\n').map_or(0, |i| i + 1) } else { 0 };
    std::fs::write(dst, &buf[start..]).unwrap();
}

/// Real lines (each under 64 KiB) from the last 16 MiB of `src`, for the appender to cycle through.
fn appender_lines(src: &Path, scratch: &Path) -> Vec<Vec<u8>> {
    let tmp = scratch.join("appender-lines.tmp");
    tail_copy(src, &tmp, 16 * 1024 * 1024);
    let data = std::fs::read(&tmp).unwrap();
    let lines: Vec<Vec<u8>> = data.split(|b| *b == b'\n').filter(|l| !l.is_empty() && l.len() < 65536).map(|l| [l, b"\n"].concat()).collect();
    assert!(!lines.is_empty(), "no appendable lines in {}", src.display());
    lines
}

#[derive(Clone)]
struct Phase {
    dir: PathBuf,
}

impl Phase {
    fn engine(&self) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", plugin_root())
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "mem-gate")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "0")
            .current_dir(&self.dir);
        c
    }

    fn hook(&self, event: &str, payload: &str, map: &Path) {
        let mut ch = self
            .engine()
            .args(["hook", "--event", event, "--fallback-map"])
            .arg(map)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        if let Some(mut s) = ch.stdin.take() {
            ah_engine::discard::harmless(s.write_all(payload.as_bytes()));
        }
        ah_engine::discard::harmless(ch.wait());
    }

    fn json(&self, args: &[&str]) -> Value {
        let out = self.engine().args(args).arg("--json").output().unwrap();
        serde_json::from_slice(&out.stdout).unwrap_or(Value::Null)
    }
}

/// What a phase measured.
#[derive(Default, Debug)]
struct Measured {
    peak_heap_mb: f64,
    peak_footprint_mb: f64,
    samples: u64,
    appended_bytes: u64,
    hooks: u64,
    counters: BTreeMap<String, f64>,
}

/// A metric's value out of `query counters --json` (`meta.metrics`: counter rows with labels, gauge rows): the sum over labels, or the max.
fn counter(v: &Value, name: &str, how: &str) -> Option<f64> {
    let m = &v["meta"]["metrics"];
    let vals: Vec<f64> = ["counters", "gauges"]
        .iter()
        .filter_map(|k| m[*k].as_array())
        .flatten()
        .filter(|r| r.get("name").and_then(Value::as_str) == Some(name))
        .filter_map(|r| r.get("value").and_then(Value::as_f64))
        .collect();
    if vals.is_empty() {
        None
    } else if how == "max" {
        vals.into_iter().reduce(f64::max)
    } else {
        Some(vals.into_iter().sum())
    }
}

fn run_phase(name: &'static str, root: &Path, src: &Path, sessions_n: usize, secs: u64, lines: &[Vec<u8>]) -> Measured {
    let phase = Phase { dir: root.join(name) };
    std::fs::create_dir_all(phase.dir.join("home")).unwrap();
    std::fs::create_dir_all(phase.dir.join("state")).unwrap();
    let map = fallback_map(&phase.dir);
    let sessions: Vec<(String, PathBuf)> = (0..sessions_n)
        .map(|i| {
            let p = phase.dir.join(format!("session-{i}.jsonl"));
            if name == "big" {
                clone_file(src, &p)
            } else {
                tail_copy(src, &p, 5 * 1024 * 1024)
            }
            (format!("gate-{name}-{i}"), p)
        })
        .collect();
    let payload = |event: &str, sid: &str, path: &Path| {
        serde_json::json!({"hook_event_name": event, "session_id": sid, "transcript_path": path, "cwd": phase.dir, "prompt": "continue", "stop_hook_active": false}).to_string()
    };
    // the daemon starts on the first call; wait until it answers
    phase.hook("SessionStart", &payload("SessionStart", "gate-warm", &sessions[0].1), &map);
    let t0 = Instant::now();
    while phase.json(&["status"]).get("running") != Some(&Value::Bool(true)) {
        assert!(t0.elapsed() < Duration::from_secs(60), "scratch daemon did not start");
        std::thread::sleep(Duration::from_millis(200));
    }
    let stop = Arc::new(AtomicBool::new(false));
    let res = Arc::new(Mutex::new(Measured::default()));
    let appended = Arc::new(AtomicU64::new(0));
    let hooks = Arc::new(AtomicU64::new(0));
    let mut threads = Vec::new();
    // sampler: footprint and heap every 50 ms (the heap peak is the peak since the previous report, so the max of the samples is the max)
    {
        let (stop, res, ph) = (stop.clone(), res.clone(), phase.clone());
        threads.push(std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let v = ph.json(&["status", "--memory"]);
                let m = &v["memory"];
                let mut r = res.lock().unwrap();
                r.samples += 1;
                for k in ["heap_peak_kb", "heap_live_kb"] {
                    r.peak_heap_mb = r.peak_heap_mb.max(m[k].as_f64().unwrap_or(0.0) / 1024.0);
                }
                r.peak_footprint_mb = r.peak_footprint_mb.max(m["footprint_kb"].as_f64().unwrap_or(0.0) / 1024.0);
                drop(r);
                std::thread::sleep(Duration::from_millis(50));
            }
        }));
    }
    // appender: ~50 KB/s into every session, real lines
    {
        let (stop, appended) = (stop.clone(), appended.clone());
        let files: Vec<PathBuf> = sessions.iter().map(|(_, p)| p.clone()).collect();
        let lines = lines.to_vec();
        threads.push(std::thread::spawn(move || {
            let mut i = 0usize;
            while !stop.load(Ordering::Relaxed) {
                for f in &files {
                    let mut o = std::fs::OpenOptions::new().append(true).open(f).unwrap();
                    let mut written = 0usize;
                    while written < 5000 {
                        let l = &lines[i % lines.len()];
                        o.write_all(l).unwrap();
                        written += l.len();
                        i += 1;
                    }
                    appended.fetch_add(written as u64, Ordering::Relaxed);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }));
    }
    // drivers: one stream per session (UPS then Stop, back to back), plus 4 requests at once on session 0
    let deadline = Instant::now() + Duration::from_secs(secs);
    for (sid, path) in sessions.clone() {
        let (hooks, map, ph) = (hooks.clone(), map.clone(), phase.clone());
        let (ups, st) = (payload("UserPromptSubmit", &sid, &path), payload("Stop", &sid, &path));
        threads.push(std::thread::spawn(move || {
            while Instant::now() < deadline {
                ph.hook("UserPromptSubmit", &ups, &map);
                ph.hook("Stop", &st, &map);
                hooks.fetch_add(2, Ordering::Relaxed);
            }
        }));
    }
    {
        let (sid, path) = sessions[0].clone();
        let (hooks, map, ph) = (hooks.clone(), map.clone(), phase.clone());
        let (ups, st) = (payload("UserPromptSubmit", &sid, &path), payload("Stop", &sid, &path));
        threads.push(std::thread::spawn(move || {
            while Instant::now() < deadline {
                let hs: Vec<_> = (0..4)
                    .map(|k| {
                        let (map, ph) = (map.clone(), ph.clone());
                        let (ev, p) = if k % 2 == 0 { ("UserPromptSubmit", ups.clone()) } else { ("Stop", st.clone()) };
                        std::thread::spawn(move || ph.hook(ev, &p, &map))
                    })
                    .collect();
                for h in hs {
                    ah_engine::discard::harmless(h.join());
                }
                hooks.fetch_add(4, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(500));
            }
        }));
    }
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
    }
    std::thread::sleep(Duration::from_secs(2)); // the last requests finish
    stop.store(true, Ordering::Relaxed);
    for t in threads {
        ah_engine::discard::harmless(t.join());
    }
    let counters = phase.json(&["query", "counters", "--limit", "5000"]);
    // which check held the most (the gate's own diagnosis: the bars above are about the engine, this names the reader)
    {
        let m = &counters["meta"]["metrics"];
        let mut rows: Vec<(f64, String)> = ["counters", "gauges", "histograms"]
            .iter()
            .filter_map(|k| m[*k].as_array())
            .flatten()
            .filter(|r| matches!(r.get("name").and_then(Value::as_str), Some("check_mem_peak_bytes")))
            .map(|r| (r.get("value").or_else(|| r.get("max")).and_then(Value::as_f64).unwrap_or(0.0), r.to_string()))
            .collect();
        rows.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (_, row) in rows.iter().take(8) {
            eprintln!("GATE {name} check_mem_peak_bytes {row}");
        }
    }
    let mut r = std::mem::take(&mut *res.lock().unwrap());
    r.appended_bytes = appended.load(Ordering::Relaxed);
    r.hooks = hooks.load(Ordering::Relaxed);
    for (n, how) in [
        ("transcript_read_buf_max_bytes", "max"),
        ("transcript_store_cold_builds", "sum"),
        ("transcript_store_refresh_bytes", "sum"),
        ("transcript_store_appended_bytes", "sum"),
        ("transcript_store_bytes", "max"),
        ("heap_burst_total", "sum"),
        ("check_bytes_read", "sum"),
    ] {
        if let Some(v) = counter(&counters, n, how) {
            r.counters.insert(n.to_string(), v);
        }
    }
    ah_engine::discard::harmless(phase.engine().arg("stop").output());
    r
}

/// Run both phases over `src` and judge the result. Returns the failures (empty = pass).
fn run_gate(src: &Path, root: &Path, secs: u64, sessions: usize) -> Vec<String> {
    let src_len = std::fs::metadata(src).unwrap().len();
    eprintln!("gate: source {} ({:.0} MB), {sessions} sessions, {secs}s per phase, work dir {}", src.display(), src_len as f64 / MB, root.display());
    let lines = appender_lines(src, root);
    let big = run_phase("big", root, src, sessions, secs, &lines);
    let small = run_phase("small", root, src, sessions, secs, &lines);
    let delta = big.peak_heap_mb - small.peak_heap_mb;
    let (limit_delta, limit_foot) = (num("diagnostics.toml", "mem_gate.size_delta_mb"), num("diagnostics.toml", "mem_gate.peak_footprint_mb"));
    let buf_limit = num("transcript.toml", "transcript.read_buf_bytes") + num("transcript.toml", "transcript.max_line_bytes");
    let ratio_max = num("diagnostics.toml", "mem_gate.parse_ratio_max_permille") / 1000.0;
    let mut fails: Vec<String> = Vec::new();
    println!(
        "GATE big   peak_heap {:.1} MB, peak_footprint {:.1} MB, {} hooks, {} samples, appended {:.1} MB, counters {:?}",
        big.peak_heap_mb,
        big.peak_footprint_mb,
        big.hooks,
        big.samples,
        big.appended_bytes as f64 / MB,
        big.counters
    );
    println!(
        "GATE small peak_heap {:.1} MB, peak_footprint {:.1} MB, {} hooks, {} samples, appended {:.1} MB, counters {:?}",
        small.peak_heap_mb,
        small.peak_footprint_mb,
        small.hooks,
        small.samples,
        small.appended_bytes as f64 / MB,
        small.counters
    );
    println!("GATE heap delta (big - small) = {delta:.1} MB (limit {limit_delta})");
    if delta > limit_delta {
        fails.push(format!("heap delta {delta:.1} MB > {limit_delta} MB"));
    }
    if big.peak_footprint_mb > limit_foot {
        fails.push(format!("peak footprint {:.1} MB > {limit_foot} MB", big.peak_footprint_mb));
    }
    match big.counters.get("transcript_read_buf_max_bytes") {
        Some(b) if *b <= buf_limit => {}
        Some(b) => fails.push(format!("largest read buffer {b} > {buf_limit}")),
        None => fails.push("transcript_read_buf_max_bytes counter missing".into()),
    }
    match (big.counters.get("transcript_store_refresh_bytes"), big.counters.get("transcript_store_appended_bytes")) {
        (Some(p), Some(a)) if *a > 0.0 && p / a <= ratio_max => {}
        (Some(p), Some(a)) => fails.push(format!("parsed/appended {p}/{a} > {ratio_max}")),
        _ => fails.push("transcript_store_refresh_bytes / appended_bytes counters missing".into()),
    }
    match big.counters.get("transcript_store_cold_builds") {
        Some(c) if (*c - sessions as f64).abs() < 0.5 => {}
        Some(c) => fails.push(format!("cold builds {c} != {sessions}")),
        None => fails.push("transcript_store_cold_builds counter missing".into()),
    }
    if let Some(b) = big.counters.get("heap_burst_total").filter(|b| **b > 0.0) {
        fails.push(format!("heap_burst_total {b} > 0"));
    }
    println!("GATE {}", if fails.is_empty() { "PASS".to_string() } else { format!("FAIL: {}", fails.join("; ")) });
    fails
}

fn work_root(tag: &str) -> PathBuf {
    let root = std::env::var("AH_MEM_GATE_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        Path::new(&std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())).join(".anti-hall/work/mem-gate").join(format!("{tag}-{}", std::process::id()))
    });
    std::fs::create_dir_all(&root).unwrap();
    root
}

/// The local and live proof: the machine's largest real transcript (`scripts/mem-gate.sh`).
#[test]
#[ignore = "minutes long and needs a very large transcript: run scripts/mem-gate.sh"]
fn the_memory_gate() {
    let secs: u64 = std::env::var("AH_MEM_GATE_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(num("diagnostics.toml", "mem_gate.run_secs") as u64);
    let root = work_root("run");
    let fails = run_gate(&largest_transcript(), &root, secs, num("diagnostics.toml", "mem_gate.sessions") as usize);
    assert!(fails.is_empty(), "gate failed: {fails:?}");
}

/// A transcript of about `mb` MB, built from nothing: prompts, replies, tool calls and results of every size (some far over
/// the line cap), task events and agent notifications, so every kind of fact and every reader path is exercised.
fn synth_transcript(path: &Path, mb: u64) {
    use std::io::BufWriter;
    let ts = "2026-10-04T10:00:00.000Z";
    let line = |v: Value| v.to_string() + "\n";
    let mut w = BufWriter::new(std::fs::File::create(path).unwrap());
    let target = mb * 1024 * 1024;
    let (mut written, mut i) = (0u64, 0u64);
    while written < target {
        let pad = |n: usize| "x".repeat(n);
        let chunk = match i % 12 {
            0 => line(serde_json::json!({"type":"user","message":{"role":"user","content":format!("prompt {i} {}", pad(200))},"timestamp":ts})),
            1 => line(
                serde_json::json!({"type":"assistant","message":{"id":format!("m{i}"),"role":"assistant","content":[{"type":"text","text":format!("reply {i} {}", pad(1500))},{"type":"tool_use","id":format!("t{i}"),"name":"Bash","input":{"command":"ls"}}]},"timestamp":ts}),
            ),
            2 => line(
                serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("t{}", i-1),"content":pad(2000 + (i as usize % 7) * 9000)}]},"timestamp":ts}),
            ),
            3 if i % 120 == 3 => line(
                serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"big","content":pad(6 * 1024 * 1024)}]},"timestamp":ts}),
            ),
            4 => line(
                serde_json::json!({"type":"assistant","message":{"id":format!("m{i}"),"role":"assistant","content":[{"type":"tool_use","id":format!("c{i}"),"name":"TaskCreate","input":{"subject":format!("task {i}")}}]},"timestamp":ts}),
            ),
            5 => line(
                serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":format!("c{}", i-1),"content":format!("Task #{i} created successfully: task")}]},"timestamp":ts}),
            ),
            6 => line(
                serde_json::json!({"type":"assistant","message":{"id":format!("m{i}"),"role":"assistant","content":[{"type":"tool_use","id":format!("a{i}"),"name":"Agent","input":{"description":"w","run_in_background":true}}]},"timestamp":ts}),
            ),
            7 => line(
                serde_json::json!({"type":"user","message":{"role":"user","content":format!("<task-notification>\n<task-id>a{i:015}</task-id>\n<tool-use-id>a{}</tool-use-id>\n<status>completed</status>\n</task-notification>", i-1)},"timestamp":ts}),
            ),
            _ => line(
                serde_json::json!({"type":"assistant","message":{"id":format!("m{i}"),"role":"assistant","content":[{"type":"text","text":pad(300)}]},"timestamp":ts}),
            ),
        };
        w.write_all(chunk.as_bytes()).unwrap();
        written += chunk.len() as u64;
        i += 1;
    }
    w.flush().unwrap();
}

/// The CI gate: the same bars over a generated transcript (nothing committed). It runs in the regular test job and enforces only
/// when `mem_gate.ci_enforce` is 1 (the lane that makes the checks read through the store flips it); until then it reports the numbers.
#[test]
fn the_memory_gate_on_a_synthetic_transcript() {
    let enforce = num("diagnostics.toml", "mem_gate.ci_enforce") == 1.0;
    if !enforce && std::env::var("AH_MEM_GATE_CI").is_err() {
        eprintln!("mem gate (synthetic): not enforced yet (mem_gate.ci_enforce = 0); set AH_MEM_GATE_CI=1 to run it anyway");
        return;
    }
    let root = work_root("synth");
    let src = root.join("synthetic.jsonl");
    synth_transcript(&src, num("diagnostics.toml", "mem_gate.synth_mb") as u64);
    let fails = run_gate(&src, &root, num("diagnostics.toml", "mem_gate.ci_run_secs") as u64, num("diagnostics.toml", "mem_gate.sessions") as usize);
    assert!(!enforce || fails.is_empty(), "gate failed: {fails:?}");
}
