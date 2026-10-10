//! D33: the scheduler, against a real daemon. A job runs on time and a restart never runs it twice; a missed window
//! catches up once (or is skipped), never once per window; a hung job is killed at its timeout and the next run still
//! happens; and the `schedule` command lists, runs and shows history, with or without a daemon.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

struct Env {
    dir: PathBuf,
    daemon: Option<Child>,
    extra: Vec<(String, String)>,
}

impl Env {
    fn new(tag: &str, jobs: &str) -> Env {
        let root = std::env::var_os("AH_ENGINE_IT_ROOT").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
        let dir = root.join(format!("ah-sch-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("eng")).unwrap();
        std::fs::write(dir.join("rules.json"), r#"{"version":1,"rules":[]}"#).unwrap();
        std::fs::write(dir.join("eng").join("schedules.json"), jobs).unwrap();
        Env { dir, daemon: None, extra: Vec::new() }
    }
    fn sock(&self) -> PathBuf {
        self.dir.join("eng").join("e.sock")
    }
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("AH_ENGINE_TICK_MS", "20")
            .env("AH_ENGINE_TEST_HOOKS", "1");
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }
    fn start(&mut self) {
        let child = self.cmd().arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        self.daemon = Some(child);
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) && ah_engine::client::ping(&self.sock()).is_none() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ah_engine::client::ping(&self.sock()).is_some(), "daemon did not come up");
    }
    fn stop(&mut self) {
        if let Some(mut c) = self.daemon.take() {
            common::stop_child(&self.sock(), &mut c);
        }
    }
    fn json(&self, args: &[&str]) -> serde_json::Value {
        let o = self.cmd().args(args).output().unwrap();
        let out = String::from_utf8_lossy(&o.stdout);
        serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("{args:?}: {e}: {out}"))
    }
    fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.dir.join("eng").join("hot.db")).unwrap()
    }
    /// (due_ms, started_ms, ended_ms, status) of every run of `job`, oldest first.
    fn runs(&self, job: &str) -> Vec<(i64, i64, i64, String)> {
        let c = self.db();
        let mut st = c.prepare("SELECT due_ms, started_ms, COALESCE(ended_ms, 0), status FROM schedule_runs WHERE job = ?1 ORDER BY id").unwrap();
        st.query_map([job], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(Result::unwrap).collect()
    }
    fn next_ms(&self, job: &str) -> i64 {
        self.db().query_row("SELECT next_ms FROM schedule_state WHERE job = ?1", [job], |r| r.get(0)).unwrap()
    }
    fn failures(&self, job: &str) -> i64 {
        self.db().query_row("SELECT failures FROM schedule_state WHERE job = ?1", [job], |r| r.get(0)).unwrap()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        self.stop();
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn now_ms() -> i64 {
    ah_engine::health::now_ms() as i64
}

const PROBE: &str = r#"{"jobs": {"probe": {"kind": "engine", "action": "noop", "every_ms": 300, "timeout_ms": 2000, "persist": true, "catch_up": "once"}}}"#;

#[test]
fn failed_refresh_subprocess_records_failure_and_scheduler_backoff() {
    let jobs = r#"{"jobs": {"refresh": {"kind": "engine", "action": "refresh", "every_ms": 60000, "timeout_ms": 5000, "retries": 2, "backoff_ms": 500, "backoff_max_ms": 500, "persist": true, "catch_up": "once"}}}"#;
    let mut e = Env::new("refresh-fail", jobs);
    let empty = e.dir.join("empty-bin");
    std::fs::create_dir_all(&empty).unwrap();
    e.extra.push(("PATH".into(), empty.to_string_lossy().to_string()));
    let req = e.dir.join("home").join(".anti-hall/refresh");
    std::fs::create_dir_all(&req).unwrap();
    std::fs::write(req.join("version.json"), r#"{"requestedAt":1}"#).unwrap();
    e.start();
    let r = e.json(&["schedule", "run", "refresh", "--json"]);
    assert_eq!(r["status"], "failed", "{r}");
    e.stop();
    assert_eq!(e.runs("refresh").last().unwrap().3, "failed");
    assert_eq!(e.failures("refresh"), 1);
    assert!(e.next_ms("refresh") <= now_ms() + 700, "failure should schedule retry via backoff, not the normal interval");
}

#[test]
fn a_job_runs_on_time_and_a_restart_never_runs_it_twice() {
    let mut e = Env::new("ontime", PROBE);
    e.start();
    std::thread::sleep(Duration::from_millis(1100));
    e.stop();
    let first = e.runs("probe");
    assert!((2..=4).contains(&first.len()), "about three runs in 1.1 s at 300 ms: {first:?}");
    for (due, started, ended, status) in &first {
        assert_eq!(status, "ok");
        assert!(started >= due && started - due < 250, "on time: due {due}, started {started}");
        assert!(ended >= started);
    }
    let saved_next = e.next_ms("probe");
    e.start(); // straight away: the saved next run is still ahead
    std::thread::sleep(Duration::from_millis(1100));
    e.stop();
    let all = e.runs("probe");
    assert!(all.len() > first.len(), "the restarted daemon keeps running it");
    assert!(all[first.len()].1 >= saved_next, "the first run after the restart waits for the saved time");
    for w in all.windows(2) {
        // the schedule (due) is what an interval is measured on: a run's start time also carries thread-start jitter
        // (45 ms was seen on a CI runner), which can bring two start times closer than the interval
        assert!(w[1].0 - w[0].0 >= 280, "never two runs within one interval, across the restart too: {all:?}");
        assert!(w[1].1 >= w[0].2, "and never overlapping: {all:?}");
        assert_ne!(w[0].0, w[1].0, "never two runs for the same due time");
    }
}

#[test]
fn a_missed_window_catches_up_once_never_once_per_window() {
    let jobs = r#"{"jobs": {"daily": {"kind": "engine", "action": "noop", "every_ms": 60000, "timeout_ms": 2000, "persist": true, "catch_up": "once"},
                         "lazy": {"kind": "engine", "action": "noop", "every_ms": 60000, "timeout_ms": 2000, "persist": true, "catch_up": "skip"}}}"#;
    let mut e = Env::new("catchup", jobs);
    e.start();
    e.stop();
    // the machine "slept" through ten windows of both jobs
    let past = now_ms() - 10 * 60_000;
    e.db().execute("UPDATE schedule_state SET next_ms = ?1", [past]).unwrap();
    e.start();
    std::thread::sleep(Duration::from_millis(800));
    let m = e.json(&["metrics", "--json"]);
    e.stop();
    assert_eq!(e.runs("daily").len(), 1, "caught up exactly once: {:?}", e.runs("daily"));
    assert!(e.next_ms("daily") >= now_ms() + 50_000, "then one interval later, not at the missed times");
    assert!(e.runs("lazy").is_empty(), "a job set to skip waits for its next window");
    assert!(e.next_ms("lazy") >= now_ms() + 50_000);
    let missed: u64 =
        m["metrics"]["counters"].as_array().unwrap().iter().filter(|c| c["name"] == "schedule_missed").map(|c| c["value"].as_u64().unwrap()).sum();
    assert_eq!(missed, 2, "both missed windows are counted: {m}");
}

#[test]
fn a_hung_job_is_killed_at_its_timeout_and_the_next_run_still_happens() {
    let jobs = r#"{"jobs": {"hang": {"kind": "engine", "action": "test_sleep", "every_ms": 300, "timeout_ms": 200, "retries": 0, "cooldown_ms": 0, "persist": true}}}"#;
    let mut e = Env::new("hang", jobs);
    e.start();
    std::thread::sleep(Duration::from_millis(1600));
    e.stop();
    let runs = e.runs("hang");
    assert!(runs.len() >= 2, "the next run happens after a hung one: {runs:?}");
    for (_, started, ended, status) in runs.iter().filter(|r| r.3 != "running") {
        assert_eq!(status, "timeout");
        assert!(ended - started < 1000, "stopped at its timeout, not left hanging: {runs:?}");
    }
    let left = Command::new("pgrep").args(["-f", "^sleep 3600$"]).output().unwrap();
    let pids = String::from_utf8_lossy(&left.stdout);
    // other suites may run their own sleeps; ours were children of the daemon's process groups, all killed
    for pid in pids.split_whitespace() {
        let ppid = Command::new("ps").args(["-o", "ppid=", "-p", pid]).output().unwrap();
        assert_ne!(String::from_utf8_lossy(&ppid.stdout).trim(), "1", "a killed job left an orphaned sleep {pid}");
    }
}

#[test]
fn the_schedule_command_lists_runs_and_shows_history() {
    let mut e = Env::new("cli", r#"{"jobs": {"probe": {"kind": "engine", "action": "noop", "every_ms": 3600000, "timeout_ms": 2000, "persist": true}}}"#);
    e.start();
    let l = e.json(&["schedule", "list", "--json"]);
    let names: Vec<&str> = l["jobs"].as_array().unwrap().iter().map(|j| j["name"].as_str().unwrap()).collect();
    for n in ["probe", "maintain", "metrics_snapshot", "spool_drain"] {
        assert!(names.contains(&n), "{n} listed: {l}");
    }
    let backup = l["jobs"].as_array().unwrap().iter().find(|j| j["name"] == "backup").expect("backup listed");
    assert_eq!(backup["every_ms"], 0, "backups are off by default");
    let r = e.json(&["schedule", "run", "probe", "--json"]);
    assert_eq!(r["status"], "ok", "{r}");
    let h = e.json(&["schedule", "history", "--job", "probe", "--json"]);
    assert_eq!(h["runs"].as_array().unwrap().len(), 1, "{h}");
    assert!(e.json(&["schedule", "run", "nope", "--json"])["error"].is_string());
    e.stop();
    let offline = e.json(&["schedule", "history", "--json"]);
    assert_eq!(offline["running"], false);
    assert_eq!(offline["runs"].as_array().unwrap().len(), 1, "history reads hot.db without a daemon: {offline}");
    assert!(e.json(&["schedule", "list", "--json"])["jobs"].as_array().unwrap().iter().any(|j| j["name"] == "probe"));
}
