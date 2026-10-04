//! D78: telemetry's hot path is fast, its flushed data survives a kill, the loss window is exactly what was not flushed,
//! and the CLI imports and rolls up idempotently.
//!
//! Every daemon a test starts is its own child process and is reaped before the test ends; every test uses its own HOME
//! and engine directory, never the real ones.

mod common;

use ah_engine::telemetry::event::{Kind, Outcome};
use ah_engine::telemetry::recorder::Recorder;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

/// The budget for one `record()` call, median (D78: under 1 microsecond).
const BUDGET_NS: u128 = 1000;

/// Median nanoseconds per `record()` call over many batches (a batch is timed once, so the clock's own cost is spread).
fn median_ns(r: &Recorder, batch: usize, batches: usize) -> u128 {
    let combos = [
        (Kind::Hook, "hook", "PreToolUse", Outcome::Allow),
        (Kind::Check, "git", "PreToolUse", Outcome::Block),
        (Kind::Check, "git", "PreToolUse", Outcome::Allow),
        (Kind::Check, "edit", "PostToolUse", Outcome::Advise),
        (Kind::Check, "rule", "Stop", Outcome::Allow),
        (Kind::Hook, "hook", "Stop", Outcome::Skip),
    ];
    let mut per: Vec<u128> = Vec::with_capacity(batches);
    for b in 0..batches {
        let t = Instant::now();
        for i in 0..batch {
            let (k, h, e, o) = combos[(i + b) % combos.len()];
            r.record(k, h, e, o, (i % 500) as u64, (i % 3) as u64 * 40);
        }
        per.push(t.elapsed().as_nanos() / batch as u128);
    }
    per.sort_unstable();
    per[per.len() / 2]
}

#[test]
fn record_holds_under_one_microsecond_median_alone_and_under_contention() {
    let r = std::sync::Arc::new(Recorder::from_defaults());
    median_ns(&r, 1000, 50); // warm up: claims the slots
    let alone = median_ns(&r, 1000, 2000);
    println!("record() median alone: {alone} ns");
    let threads: Vec<_> = (0..4)
        .map(|_| {
            let r = r.clone();
            std::thread::spawn(move || median_ns(&r, 1000, 2000))
        })
        .collect();
    let contended: Vec<u128> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    println!("record() median with 4 threads: {contended:?} ns");
    // the budget is a release-build property; a debug build only has to run
    if !cfg!(debug_assertions) {
        assert!(alone < BUDGET_NS, "record() median {alone} ns is over the {BUDGET_NS} ns budget");
        for c in &contended {
            assert!(*c < BUDGET_NS, "record() median {c} ns under contention is over the {BUDGET_NS} ns budget");
        }
    }
}

struct Run {
    dir: PathBuf,
    daemon: Option<Child>,
}

impl Run {
    fn new(tag: &str) -> Run {
        let dir = PathBuf::from("/tmp").join(format!("ah-tel-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).unwrap();
        Run { dir, daemon: None }
    }

    fn cmd(&self, flush_ms: &str) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_SESSION_RPS", "0")
            .env("AH_ENGINE_PROJECT_RPS", "0")
            .env("AH_ENGINE_TELEMETRY_FLUSH_MS", flush_ms)
            .env("AH_ENGINE_NOSPAWN", "1");
        c
    }

    fn sock(&self) -> PathBuf {
        self.dir.join("eng").join("e.sock")
    }

    fn start(&mut self, flush_ms: &str) {
        let child = self.cmd(flush_ms).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        self.daemon = Some(child);
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) {
            if ah_engine::client::ping(&self.sock()).is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        panic!("daemon did not come up");
    }

    fn hooks(&self, n: usize) {
        for i in 0..n {
            let body = format!("V 0.1.0\n{{\"hook_event_name\":\"Stop\",\"session_id\":\"s{i}\"}}");
            let r = ah_engine::client::exchange(&self.sock(), body.as_bytes(), Duration::from_secs(2));
            assert!(matches!(r, ah_engine::client::Exch::Reply(..)), "hook request {i} was not answered");
        }
    }

    /// SIGKILL the daemon: nothing gets a chance to flush.
    fn kill9(&mut self) {
        if let Some(mut d) = self.daemon.take() {
            let _ = d.kill();
            let _ = d.wait();
        }
    }

    fn json(&self, args: &[&str]) -> serde_json::Value {
        let o = self.cmd("10000").args(args).arg("--json").output().unwrap();
        serde_json::from_slice(&o.stdout).unwrap_or_else(|e| panic!("{args:?}: {e}: {}", String::from_utf8_lossy(&o.stdout)))
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        if let Some(mut d) = self.daemon.take() {
            common::stop_child(&self.sock(), &mut d);
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn a_killed_daemon_keeps_what_was_flushed_and_loses_only_the_window() {
    let mut run = Run::new("kill");
    run.start("100");
    run.hooks(12);
    std::thread::sleep(Duration::from_millis(800)); // several flush intervals
    let live = run.json(&["telemetry", "summary", "--window", "1d"]);
    assert_eq!((live["from"].as_str(), live["invocations"].as_u64()), (Some("daemon"), Some(12)), "{live}");
    run.kill9();
    let after = run.json(&["telemetry", "summary", "--window", "1d"]);
    assert_eq!(after["from"], "files", "no daemon any more: read from the database");
    assert_eq!(after["invocations"], 12, "everything up to the last flush survived kill -9: {after}");

    // the loss window: a daemon whose flush interval never comes up before the kill loses what it recorded
    let mut run2 = Run::new("lost");
    run2.start("600000");
    run2.hooks(7);
    let live = run2.json(&["telemetry", "summary", "--window", "1d"]);
    assert_eq!(live["invocations"], 7, "the live report sees unflushed data");
    run2.kill9();
    let after = run2.json(&["telemetry", "summary", "--window", "1d"]);
    assert_eq!(after["invocations"], 0, "documented: a kill -9 loses what was recorded since the last flush: {after}");
}

fn write_lines(dir: &Path, n: usize) {
    std::fs::create_dir_all(dir).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let lines: Vec<String> = (0..n)
        .map(|i| {
            serde_json::json!({"ts": now - i as u64, "k": "route", "h": "model-routing", "e": "PreToolUse", "o": "advise", "ms": 1, "ib": 100,
                "requested_model": "opus", "parent_model": "opus", "task_class": "mechanical", "recommended_tier": "haiku", "outcome": "down", "spawn_key": format!("key{i}")})
            .to_string()
        })
        .collect();
    std::fs::write(dir.join("2026-10-05.ndjson"), lines.join("\n") + "\n").unwrap();
}

#[test]
fn import_and_rollup_through_the_cli_are_idempotent() {
    let run = Run::new("cli");
    write_lines(&run.dir.join("telemetry"), 3);
    let a = run.json(&["telemetry", "import"]);
    assert_eq!((a["stored"].as_u64(), a["rejected"].as_u64()), (Some(3), Some(0)), "{a}");
    let b = run.json(&["telemetry", "import"]);
    assert_eq!((b["stored"].as_u64(), b["already_stored"].as_u64()), (Some(0), Some(3)), "{b}");
    let s = run.json(&["telemetry", "summary", "--window", "1d"]);
    assert_eq!(s["by_kind"]["route"], 3, "pre-engine data shows up in the same report, counted once: {s}");
    let ev = run.json(&["telemetry", "events", "--kind", "route", "--window", "1d"]);
    assert_eq!(ev["count"], 3);
    let r1 = run.json(&["telemetry", "rollup"]);
    let r2 = run.json(&["telemetry", "rollup"]);
    assert_eq!(r1["rows_archived"], r2["rows_archived"], "a rollup run twice archives the same rows");
    assert_eq!(r2["events_held"], 3);
    let bad = run.cmd("10000").args(["telemetry", "nonsense", "--json"]).output().unwrap();
    assert_eq!(bad.status.code(), Some(64));
}

#[test]
fn the_daily_rollup_is_a_scheduler_job_and_runs_idempotently() {
    let mut run = Run::new("sched");
    run.start("100");
    run.hooks(3);
    let jobs = run.json(&["schedule", "list"]);
    assert!(jobs["jobs"].as_array().unwrap().iter().any(|j| j["name"] == "telemetry_rollup" && j["action"] == "telemetry_rollup"), "{jobs}");
    let a = run.json(&["schedule", "run", "telemetry_rollup"]);
    let b = run.json(&["schedule", "run", "telemetry_rollup"]);
    assert_eq!((a["status"].as_str(), b["status"].as_str()), (Some("ok"), Some("ok")), "{a} {b}");
    assert_eq!(a["detail"], b["detail"], "a repeat run reports the same result");
    // the job flushed first, so what the hooks recorded is in the database (and still counted once)
    let s = run.json(&["telemetry", "summary", "--window", "1d"]);
    assert_eq!(s["invocations"], 3);
}
