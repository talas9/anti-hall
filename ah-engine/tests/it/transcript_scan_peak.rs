//! The transcript-scan spike (T-3): concurrent Stop / UserPromptSubmit requests on a large transcript must not raise the daemon's
//! heap by a window's worth. Before, every transcript reader allocated a private 12-64 MiB window, so a few requests in flight on a
//! 300 MB transcript pushed the live heap up 40-90 MB for half a second, over the RSS cap, and the daemon restarted.
//!
//! The rig drives the real binary: a scratch HOME (the Stop channel on), one synthetic transcript of the given size (or a real one,
//! `AH_SCAN_PEAK_TRANSCRIPT=<file>`), four requests from four sessions fired at once, and the daemon's own `status --json` heap peak
//! (`memory.heap_peak_kb`: the highest live heap since the previous status) read before and after. The gate is
//! `transcript.scan_peak_budget_bytes`, and the delta must not grow from the small transcript to the big one. It is an end-to-end guard:
//! what the daemon keeps per session (the agent scan's walk, the evidence and task lines) counts in it too. The reader-level gate that
//! fails on the old whole-window reads is `tests/transcript_scan_blocks.rs`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const MIB: usize = 1 << 20;
const BUDGET_KEY: &str = "transcript.scan_peak_budget_bytes";

fn budget_bytes() -> u64 {
    let t: toml::Table =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine/defaults/transcript.toml")).unwrap().parse().unwrap();
    let (section, key) = BUDGET_KEY.split_once('.').unwrap();
    t[section][key]["value"].as_integer().unwrap() as u64
}

/// A transcript of about `mb` MB in the shape the host writes: one typed prompt at the start (so the readers that walk back to the last
/// prompt widen as far as they can), tool traffic with results of a few KB and a rare 400 KB one, task tools, background-agent
/// launches (4 KB prompts, one every 32 records) with their completion notices, and assistant text.
fn write_transcript(path: &Path, mb: usize) {
    let mut f = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(path).unwrap());
    let (mut written, mut i) = (0usize, 0u64);
    let big = "r".repeat(400 * 1024);
    let mid = "m".repeat(3000);
    let prompt_text = "p".repeat(4000);
    let prompt = |i: u64| {
        format!(
            r#"{{"type":"user","origin":{{"kind":"human"}},"promptSource":"typed","timestamp":"2026-11-08T10:00:00.000Z","message":{{"role":"user","content":"prompt {i}: please keep going"}}}}"#
        )
    };
    let mut next_prompt = 0usize;
    while written < mb * MIB {
        if written >= next_prompt {
            let l = prompt(i);
            writeln!(f, "{l}").unwrap();
            written += l.len() + 1;
            next_prompt += 4000 * MIB;
        }
        let ts = format!("2026-11-08T10:{:02}:{:02}.000Z", (i / 60) % 60, i % 60);
        let lines: Vec<String> = match i % 8 {
            0 => vec![
                format!(
                    r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test module_{i}"}}}}]}}}}"#
                ),
                format!(
                    r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"b{i}","content":"{}"}}]}}}}"#,
                    if i % 400 == 0 { &big } else { &mid }
                ),
            ],
            1 | 5 => vec![
                format!(
                    r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"task {i}","description":"d","status":"pending"}}}}]}}}}"#
                ),
                format!(
                    r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{i}","content":"Task #{i} created successfully: task {i}"}}]}}}}"#
                ),
            ],
            2 if i % 32 == 2 => vec![
                format!(
                    r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"a{i}","name":"Agent","input":{{"description":"worker {i}","prompt":"{prompt_text}","run_in_background":true}}}}]}}}}"#
                ),
                format!(
                    r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"a{i}","content":[{{"type":"text","text":"Async agent launched successfully.\nagentId: a{i:016x} (internal ID)\noutput_file: /tmp/x/a{i}.output"}}]}}]}}}}"#
                ),
                format!(
                    r#"{{"type":"user","origin":{{"kind":"task-notification"}},"timestamp":"{ts}","message":{{"role":"user","content":"<task-notification><task-id>a{i:016x}</task-id><status>completed</status><summary>done</summary></task-notification>"}}}}"#
                ),
            ],
            _ => vec![format!(
                r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#,
                "x".repeat(600)
            )],
        };
        for l in lines {
            writeln!(f, "{l}").unwrap();
            written += l.len() + 1;
        }
        i += 1;
    }
    f.flush().unwrap();
}

/// A Stop payload's own fields: plan mode (the tasklist guard then answers with a note), no background tasks pending.
fn stop_extra() -> serde_json::Value {
    serde_json::json!({"stop_hook_active": false, "permission_mode": "plan", "background_tasks": [], "session_crons": []})
}

struct Rig {
    dir: PathBuf,
    /// A copy of the plugin whose `transcript.max_concurrent_scans` the latency run sets (`None`: the repository's plugin as is).
    plugin: Option<PathBuf>,
}

impl Rig {
    fn new(tag: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("ahd-scanpeak-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: a leftover of an earlier run under this name
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj/.git")).unwrap();
        std::fs::write(dir.join("proj/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        // the Stop channel on, with the setting a user can switch on: a Stop note then walks the transcript back to the last typed prompt
        std::fs::write(dir.join("home/.anti-hall/settings.json"), r#"{"context":{"stopAdditionalContext":true}}"#).unwrap();
        Rig { dir, plugin: None }
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let plugin = self.plugin.clone().unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"));
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "scan-peak")
            .env("CLAUDE_PLUGIN_ROOT", &plugin)
            .env("AH_ENGINE_PLUGIN_ROOT", &plugin)
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .current_dir(&self.dir);
        c
    }

    fn map(&self) -> PathBuf {
        let p = self.dir.join("map.json");
        let table: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall-node/hooks/ah-fallback.map.json")).unwrap(),
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

    /// A hook process that is up and waiting for its payload on stdin.
    fn spawn_hook(&self, map: &Path, event: &str) -> std::process::Child {
        let mut c = self.cmd(&["hook", "--event", event, "--host", "claude", "--fallback-map"]);
        c.arg(map).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
        c.spawn().unwrap()
    }

    fn send(ch: &mut std::process::Child, payload: &serde_json::Value) {
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    }

    fn hook(&self, map: &Path, event: &str, payload: &serde_json::Value) -> std::process::Child {
        let mut ch = self.spawn_hook(map, event);
        Rig::send(&mut ch, payload);
        ch
    }

    fn status(&self) -> serde_json::Value {
        let o = self.cmd(&["status", "--json"]).output().unwrap();
        serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("status is not JSON ({e})"))
    }

    fn memory(&self) -> serde_json::Value {
        self.status()["memory"].clone()
    }

    /// Wait until the daemon the first hook started answers (a debug build takes seconds to come up; a hook sent before that falls back
    /// to its Node map and is not served by the daemon at all).
    fn wait_up(&self) {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(120);
        while self.memory()["heap_live_kb"].as_u64().is_none() {
            assert!(std::time::Instant::now() < until, "the daemon did not come up");
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }

    /// The heap peak above the live heap at the start, over four concurrent requests (two Stop, two UserPromptSubmit) each on its own
    /// copy of a transcript of `mb` MB.
    fn burst_peak_bytes(&self, mb: usize) -> u64 {
        let map = self.map();
        // `AH_SCAN_PEAK_TRANSCRIPT=<file>`: measure a real transcript (read only, linked by symlink) instead of the synthetic one
        let real = std::env::var_os("AH_SCAN_PEAK_TRANSCRIPT").map(PathBuf::from);
        let base = self.dir.join("t0.jsonl");
        if real.is_none() {
            write_transcript(&base, mb);
        }
        // one transcript, four sessions: requests on a busy session arrive together, and each used to read its own windows of it
        let paths: Vec<PathBuf> = (0..4)
            .map(|_| match &real {
                Some(r) => {
                    if !base.exists() {
                        std::os::unix::fs::symlink(r, &base).unwrap();
                    }
                    base.clone()
                }
                None => base.clone(),
            })
            .collect();
        let payload = |n: usize, extra: serde_json::Value| {
            let mut v = serde_json::json!({"session_id": format!("peak-{n}"), "transcript_path": paths[n].to_string_lossy(), "cwd": self.dir.join("proj").to_string_lossy()});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        // start the daemon and let it settle on a small transcript of the same shape, so what the burst raises is what reading a big
        // transcript costs, not the daemon's first use of its regexes, script runtimes and defaults
        let small = self.dir.join("small.jsonl");
        write_transcript(&small, 4);
        let warm = |n: &str, extra: serde_json::Value| {
            let mut v = serde_json::json!({"session_id": n, "transcript_path": small.to_string_lossy(), "cwd": self.dir.join("proj").to_string_lossy()});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        self.hook(&map, "Stop", &warm("warm-0", stop_extra())).wait().unwrap();
        self.wait_up();
        for n in 0..2 {
            self.hook(&map, "Stop", &warm(&format!("warm-s{n}"), stop_extra())).wait().unwrap();
            self.hook(&map, "UserPromptSubmit", &warm(&format!("warm-u{n}"), serde_json::json!({"prompt": "go on"}))).wait().unwrap();
        }
        let before = self.memory();
        let live0 = before["heap_live_kb"].as_u64().unwrap();
        // the four processes are up before any payload is sent, so the four requests reach the daemon together
        let plan = [
            ("Stop", payload(0, stop_extra())),
            ("UserPromptSubmit", payload(1, serde_json::json!({"prompt": "carry on"}))),
            ("Stop", payload(2, stop_extra())),
            ("UserPromptSubmit", payload(3, serde_json::json!({"prompt": "and again"}))),
        ];
        let mut kids: Vec<std::process::Child> = plan.iter().map(|(ev, _)| self.spawn_hook(&map, ev)).collect();
        std::thread::sleep(std::time::Duration::from_millis(1500));
        for (k, (_, p)) in kids.iter_mut().zip(&plan) {
            Rig::send(k, p);
        }
        for k in &mut kids {
            k.wait().unwrap();
        }
        let st = self.status();
        // which checks grew the heap most in one call (`diagnostics.check_mem`): where a regression is
        let mut worst: Vec<(u64, String)> =
            st["phases"]["checks"].as_object().into_iter().flatten().filter_map(|(name, row)| Some((row["mem_peak"]["max"].as_u64()?, name.clone()))).collect();
        worst.sort_unstable_by(|a, b| b.cmp(a));
        eprintln!("scan-peak {mb} MB worst checks (bytes): {:?}", &worst[..worst.len().min(6)]);
        let after = st["memory"].clone();
        let holders: Vec<String> = after["budgets"]["holders"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|h| h["bytes"].as_u64().unwrap_or(0) > 200_000)
            .map(|h| format!("{}={}KB", h["name"].as_str().unwrap_or("?"), h["bytes"].as_u64().unwrap_or(0) / 1024))
            .collect();
        eprintln!("scan-peak {mb} MB holders over 200 KB: {holders:?}");
        let peak = after["heap_peak_kb"].as_u64().unwrap();
        let live1 = after["heap_live_kb"].as_u64().unwrap_or(0);
        eprintln!("scan-peak {mb} MB: live0={live0} KB peak={peak} KB delta={} KB (live after {live1} KB)", peak.saturating_sub(live0));
        peak.saturating_sub(live0) * 1024
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        common::reap(&self.dir.join("state"), || {
            self.cmd(&["stop"]).output().ok();
        });
        if std::thread::panicking() {
            eprintln!("scan-peak state kept: {}", self.dir.display());
        } else {
            ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: a test directory; an absent one is the goal state
        }
    }
}

#[test]
fn four_concurrent_requests_on_a_big_transcript_stay_under_the_budget_and_do_not_grow_with_its_size() {
    let budget = budget_bytes();
    let small = Rig::new("s").burst_peak_bytes(100);
    let big = Rig::new("b").burst_peak_bytes(300);
    assert!(small < budget, "100 MB transcript: heap peak +{small} bytes is over the budget {budget}");
    assert!(big < budget, "300 MB transcript: heap peak +{big} bytes is over the budget {budget}");
    assert!(big <= small + budget / 4, "the peak grows with the transcript: +{small} bytes at 100 MB, +{big} bytes at 300 MB");
}

// ---- latency of the scan turn: `AH_SCAN_LATENCY=1 cargo test --release -- --ignored scan_turn_latency` ----

fn percentile(v: &mut [u128], p: f64) -> u128 {
    v.sort_unstable();
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

impl Rig {
    /// The plugin copied here with `transcript.max_concurrent_scans` set to `max`.
    fn with_max_scans(&mut self, max: u32) {
        let dst = self.dir.join("plugin");
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
        assert!(Command::new("cp").arg("-R").arg(&src).arg(&dst).status().unwrap().success());
        for d in ["defaults", "defaults.pristine"] {
            let f = dst.join("engine").join(d).join("transcript.toml");
            let t = std::fs::read_to_string(&f).unwrap();
            let at = t.find("[transcript.max_concurrent_scans]").unwrap();
            let v = at + t[at..].find("value = ").unwrap();
            let end = v + t[v..].find('\n').unwrap();
            std::fs::write(&f, format!("{}value = {max}{}", &t[..v], &t[end..])).unwrap();
        }
        self.plugin = Some(dst);
    }

    /// Four requests (two Stop, two UserPromptSubmit) sent together on a transcript of `mb` MB, `rounds` times (a line is appended
    /// between rounds, so the first is cold and the rest are warm). The milliseconds each took from send to exit: (stop, ups).
    fn burst_latencies(&self, mb: usize, rounds: usize) -> (Vec<u128>, Vec<u128>, Vec<u128>, Vec<u128>) {
        let map = self.map();
        let t = self.dir.join("t0.jsonl");
        write_transcript(&t, mb);
        let small = self.dir.join("small.jsonl");
        write_transcript(&small, 4);
        let pl = |n: &str, path: &Path, extra: serde_json::Value| {
            let mut v = serde_json::json!({"session_id": n, "transcript_path": path.to_string_lossy(), "cwd": self.dir.join("proj").to_string_lossy()});
            v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            v
        };
        self.hook(&map, "Stop", &pl("warm-0", &small, stop_extra())).wait().unwrap();
        self.wait_up();
        self.hook(&map, "Stop", &pl("warm-1", &small, stop_extra())).wait().unwrap();
        let (mut cold_s, mut cold_u, mut warm_s, mut warm_u) = (vec![], vec![], vec![], vec![]);
        for round in 0..rounds {
            if round > 0 {
                let mut f = std::fs::OpenOptions::new().append(true).open(&t).unwrap();
                writeln!(f, r#"{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"round {round}"}}]}}}}"#).unwrap();
            }
            let plan = [
                ("Stop", pl(&format!("lat-0-{round}"), &t, stop_extra())),
                ("UserPromptSubmit", pl(&format!("lat-1-{round}"), &t, serde_json::json!({"prompt": "carry on"}))),
                ("Stop", pl(&format!("lat-2-{round}"), &t, stop_extra())),
                ("UserPromptSubmit", pl(&format!("lat-3-{round}"), &t, serde_json::json!({"prompt": "and again"}))),
            ];
            let mut kids: Vec<std::process::Child> = plan.iter().map(|(ev, _)| self.spawn_hook(&map, ev)).collect();
            std::thread::sleep(std::time::Duration::from_millis(800));
            let start = std::time::Instant::now();
            for (k, (_, p)) in kids.iter_mut().zip(&plan) {
                Rig::send(k, p);
            }
            let mut took: Vec<Option<u128>> = vec![None; 4];
            while took.iter().any(Option::is_none) {
                for (i, k) in kids.iter_mut().enumerate() {
                    if took[i].is_none() && k.try_wait().unwrap().is_some() {
                        took[i] = Some(start.elapsed().as_millis());
                    }
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            for (i, (ev, _)) in plan.iter().enumerate() {
                let ms = took[i].unwrap();
                match (round == 0, *ev == "Stop") {
                    (true, true) => cold_s.push(ms),
                    (true, false) => cold_u.push(ms),
                    (false, true) => warm_s.push(ms),
                    (false, false) => warm_u.push(ms),
                }
            }
        }
        (cold_s, cold_u, warm_s, warm_u)
    }
}

#[test]
#[ignore = "a latency measurement, not a gate: AH_SCAN_LATENCY=1, run in release"]
fn scan_turn_latency() {
    if std::env::var_os("AH_SCAN_LATENCY").is_none() {
        return;
    }
    let mb: usize = std::env::var("AH_SCAN_LATENCY_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    let trials: usize = std::env::var("AH_SCAN_LATENCY_TRIALS").ok().and_then(|v| v.parse().ok()).unwrap_or(4);
    for max in [0u32, 1, 2] {
        let (mut cs, mut cu, mut ws, mut wu) = (vec![], vec![], vec![], vec![]);
        for trial in 0..trials {
            let mut rig = Rig::new(&format!("lat{max}-{trial}"));
            rig.with_max_scans(max);
            let (a, b, c, d) = rig.burst_latencies(mb, 4);
            cs.extend(a);
            cu.extend(b);
            ws.extend(c);
            wu.extend(d);
        }
        for (name, v) in [("cold Stop", &mut cs), ("cold UPS", &mut cu), ("warm Stop", &mut ws), ("warm UPS", &mut wu)] {
            eprintln!(
                "LAT max_concurrent_scans={max} {name}: n={} p50={} ms p95={} ms max={} ms",
                v.len(),
                percentile(v, 0.5),
                percentile(v, 0.95),
                v.iter().max().unwrap()
            );
        }
    }
}
