//! D33: the scheduler, against a real daemon. A job runs on time and a restart never runs it twice; a missed window
//! catches up once (or is skipped), never once per window; a hung job is killed at its timeout and the next run still
//! happens; and the `schedule` command lists, runs and shows history, with or without a daemon.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")
}

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
    fn eng(&self) -> PathBuf {
        self.dir.join("eng")
    }
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .env("AH_ENGINE_TICK_MS", "20")
            .env("AH_ENGINE_TEST_HOOKS", "1");
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }
    fn spawning_cmd(&self) -> Command {
        let mut c = self.cmd();
        c.env_remove("AH_ENGINE_NOSPAWN");
        c
    }
    fn start(&mut self) {
        self.start_in(None);
    }
    /// `serve` started in `dir` (the working directory of the process that starts it).
    fn start_in(&mut self, dir: Option<&std::path::Path>) {
        let mut c = self.cmd();
        if let Some(d) = dir {
            c.current_dir(d);
        }
        let child = c.arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        self.daemon = Some(child);
        let t = Instant::now();
        while t.elapsed() < common::READY_CEILING && ah_engine::client::ping(&self.sock()).is_none() {
            std::thread::sleep(Duration::from_millis(10));
        }
        let status = self.daemon.as_mut().and_then(|c| c.try_wait().ok()).flatten();
        assert!(
            ah_engine::client::ping(&self.sock()).is_some(),
            "daemon did not come up within {:?}; child_status={status:?}; log: {}",
            common::READY_CEILING,
            self.log()
        );
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
    fn ctl(&self, verb: &str) -> String {
        let o = self.cmd().args(["ctl", verb]).output().unwrap();
        assert!(o.status.success(), "ctl {verb}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }
    fn hook_spawn(&self) {
        use std::io::Write;
        let payload = r#"{"session_id":"s","cwd":"/tmp","hook_event_name":"UserPromptSubmit","prompt":"restart probe"}"#;
        let mut child = self.spawning_cmd().arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "hook spawn exits cleanly: status={:?} stdout={} stderr={}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }
    fn log(&self) -> String {
        std::fs::read_to_string(self.dir.join("eng").join("ah-engine.log")).unwrap_or_default()
    }
    fn pid(&self) -> u32 {
        ah_engine::client::ping(&self.sock()).and_then(|p| p.split_whitespace().nth(2).and_then(|n| n.parse().ok())).expect("daemon ping pid")
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
    fn job(&self, list: &serde_json::Value, name: &str) -> serde_json::Value {
        list["jobs"].as_array().unwrap().iter().find(|j| j["name"] == name).cloned().unwrap_or_else(|| panic!("missing {name}: {list}"))
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
fn a_daemon_started_from_a_workspace_child_or_subagent_still_runs_main_only_jobs() {
    // live 2026-10-16: a daemon whose spawning hook ran in a DevSwarm workspace child inherited DEVSWARM_SOURCE_BRANCH, so
    // every `ah-engine <job> --json` it started was refused by the role gate (exit 77, reason on stdout, empty stderr)
    let jobs =
        r#"{"jobs": {"jev_sweep": {"kind": "engine", "action": "jev_sweep", "every_ms": 60000, "timeout_ms": 20000, "persist": true, "catch_up": "once"}}}"#;
    let mut e = Env::new("role-env", jobs);
    e.extra.push(("DEVSWARM_SOURCE_BRANCH".into(), "feat/child".into()));
    e.extra.push(("ANTIHALL_ROLE".into(), "subagent".into()));
    e.start();
    e.extra.clear(); // the `schedule run` caller is the main session
    let r = e.json(&["schedule", "run", "jev_sweep", "--json"]);
    e.stop();
    assert_eq!(r["status"], "ok", "{r}");
    assert_eq!(e.runs("jev_sweep").last().unwrap().3, "ok");
}

/// The environment (as `KEY=value` words) of process `pid`, from `ps eww` (macOS and procps both append it).
fn process_env_words(pid: u32) -> String {
    let o = Command::new("ps").args(["eww", "-p", &pid.to_string()]).output().unwrap();
    String::from_utf8_lossy(&o.stdout).into_owned()
}

#[test]
fn a_daemon_started_from_a_workspace_child_keeps_nothing_of_the_session_that_started_it() {
    // #103: a daemon serves every session but inherited the whole environment and the working directory of whichever hook
    // started it, so the first session to spawn it owned its session id, role, workspace and project for all the others
    let mut e = Env::new("spawn-env", PROBE);
    let start_dir = e.dir.join("child-worktree");
    std::fs::create_dir_all(&start_dir).unwrap();
    for (k, v) in [
        ("DEVSWARM_SOURCE_BRANCH", "feat/child"),
        ("DEVSWARM_BUILDER_ID", "builder-x"),
        ("ANTIHALL_ROLE", "subagent"),
        ("ANTIHALL_SESSION_ID", "child-session"),
        ("CLAUDE_CODE_SESSION_ID", "child-session"),
        ("CLAUDE_PROJECT_DIR", "/child/worktree"),
        ("GIT_DIR", "/child/worktree/.git"),
    ] {
        e.extra.push((k.into(), v.into()));
    }
    let mut c = e.spawning_cmd();
    c.current_dir(&start_dir);
    {
        use std::io::Write;
        let payload = r#"{"session_id":"s","cwd":"/tmp","hook_event_name":"UserPromptSubmit","prompt":"spawn env probe"}"#;
        let mut child = c.arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        child.wait_with_output().unwrap();
    }
    let t = Instant::now();
    while t.elapsed() < common::READY_CEILING && ah_engine::client::ping(&e.sock()).is_none() {
        std::thread::sleep(Duration::from_millis(10));
    }
    let pid = e.pid();
    let env = process_env_words(pid);
    assert!(env.contains("AH_ENGINE_DIR="), "the probe must see the daemon's environment at all");
    for gone in [
        "DEVSWARM_SOURCE_BRANCH=",
        "DEVSWARM_BUILDER_ID=",
        "ANTIHALL_ROLE=",
        "ANTIHALL_SESSION_ID=",
        "CLAUDE_CODE_SESSION_ID=",
        "CLAUDE_PROJECT_DIR=",
        "GIT_DIR=",
    ] {
        assert!(!env.contains(gone), "the daemon kept {gone} of the session that started it");
    }
    let home = std::fs::canonicalize(e.dir.join("home")).unwrap();
    assert_eq!(process_cwd(pid), home, "the daemon kept the starting hook's working directory");
    let eng = e.eng();
    common::reap(&eng, || {
        drop(ah_engine::client::exchange(&e.sock(), b"CTL stop\n", Duration::from_millis(500))); // best-effort stop; the reply is not needed
    });
}

/// The working directory of process `pid`, from `lsof`.
fn process_cwd(pid: u32) -> std::path::PathBuf {
    let o = Command::new("lsof").args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"]).output().unwrap();
    let cwd = String::from_utf8_lossy(&o.stdout).lines().find_map(|l| l.strip_prefix('n').map(str::to_string)).unwrap_or_default();
    std::fs::canonicalize(cwd).unwrap_or_default()
}

#[test]
fn a_daemon_started_by_hand_in_a_workspace_leaves_that_directory() {
    // the daemon sanitizes itself, so a start that is not the hook client's (the update script, a service unit) is covered too
    let mut e = Env::new("serve-cwd", PROBE);
    let worktree = e.dir.join("child-worktree");
    std::fs::create_dir_all(&worktree).unwrap();
    e.start_in(Some(&worktree));
    let cwd = process_cwd(e.pid());
    e.stop();
    assert_eq!(cwd, std::fs::canonicalize(e.dir.join("home")).unwrap(), "the daemon stayed in the directory it was started from");
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
fn an_injected_job_panic_clears_running_and_daemon_keeps_serving() {
    let jobs = r#"{"jobs": {"panic_probe": {"kind": "engine", "action": "test_panic", "every_ms": 3600000, "timeout_ms": 2000, "retries": 0, "cooldown_ms": 0, "persist": true}}}"#;
    let mut e = Env::new("panic", jobs);
    e.start();
    let r = e.json(&["schedule", "run", "panic_probe", "--json"]);
    assert_eq!(r["status"], "failed", "{r}");
    assert_eq!(r["detail"], ah_engine::defaults::text("msg.schedule_panic"));
    assert!(ah_engine::client::ping(&e.sock()).is_some(), "daemon still serves ping after job panic");
    let l = e.json(&["schedule", "list", "--json"]);
    let job = e.job(&l, "panic_probe");
    assert_eq!(job["running"], false, "{job}");
    assert_eq!(job["last"]["status"], "failed", "{job}");
    let s = e.json(&["status", "--json"]);
    assert_eq!(s["running"], true, "{s}");
    e.stop();
}

#[test]
fn a_daemon_thread_panic_restarts_until_the_cap_then_drains() {
    let mut e =
        Env::new("thread-panic", r#"{"jobs": {"probe": {"kind": "engine", "action": "noop", "every_ms": 3600000, "timeout_ms": 2000, "persist": true}}}"#);
    e.start();
    let first_pid = e.pid();
    e.ctl("thread_panic 1");
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) && !e.log().contains("\tthread_panic\twatchdog\t") {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(e.log().contains("\tthread_panic\twatchdog\t"), "watchdog panic logged: {}", e.log());
    assert!(ah_engine::client::ping(&e.sock()).is_some(), "watchdog restarted after one panic");

    let max = ah_engine::defaults::num("daemon.thread_restart_max");
    e.ctl(&format!("thread_panic {}", max + 1));
    let child = e.daemon.as_mut().expect("daemon child");
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(10) {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(child.try_wait().unwrap().is_some(), "daemon drained after the supervised panic cap; log: {}", e.log());
    e.daemon = None;

    e.hook_spawn();
    let t = Instant::now();
    while t.elapsed() < common::READY_CEILING && ah_engine::client::ping(&e.sock()).is_none() {
        std::thread::sleep(Duration::from_millis(20));
    }
    let second_pid = e.pid();
    assert_ne!(second_pid, first_pid, "the client started a fresh daemon after the capped thread panic");
    let r = e.json(&["schedule", "run", "probe", "--json"]);
    assert_eq!(r["status"], "ok", "{r}");
    let eng = e.eng();
    common::reap(&eng, || {
        drop(ah_engine::client::exchange(&e.sock(), b"CTL stop\n", Duration::from_millis(500))); // best-effort stop; the reply is not needed
    });
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
