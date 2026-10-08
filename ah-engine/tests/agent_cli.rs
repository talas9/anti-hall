//! The agent-facing commands and residency, against a real daemon (D7, D50-D52): `--json` on every command,
//! metrics and impact fed by real hook calls, a read-only status summary, planned commands that say so, the idle-exit
//! config key (default disabled), and no daemon surviving a test.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

mod common;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const RULES: &str = r#"{"version":1,"rules":[
  {"id":"git-guard","events":["PreToolUse"],"tools":["Bash"],"check":"git","action":"deny"},
  {"id":"warn-rm","events":["PreToolUse"],"tools":["Bash"],"pattern":"rm -rf","action":"warn","message":"careful"}]}"#;

struct Env {
    dir: PathBuf,
    extra: Vec<(String, String)>,
}

impl Env {
    fn new(tag: &str, extra: &[(&str, &str)]) -> Env {
        let dir = PathBuf::from("/tmp").join(format!("ah-cli-{}-{}", tag, std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("rules.json"), RULES).unwrap();
        Env { dir, extra: extra.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() }
    }

    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env_remove("AH_ENGINE_NOSPAWN");
        for (k, v) in &self.extra {
            c.env(k, v);
        }
        c
    }

    fn hook(&self, command: &str) -> (String, String, i32) {
        let payload =
            serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": "/tmp", "session_id": "s", "tool_input": {"command": command}})
                .to_string();
        let mut ch = self.cmd().arg("hook").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (String::from_utf8_lossy(&o.stdout).trim().to_string(), String::from_utf8_lossy(&o.stderr).trim().to_string(), o.status.code().unwrap_or(-1))
    }

    /// What a failing assertion should print: the daemon's log and status (so a CI failure explains itself).
    fn diag(&self) -> String {
        let log = std::fs::read_to_string(self.dir.join("eng").join("ah-engine.log")).unwrap_or_default();
        format!("\n--- ah-engine.log ---\n{log}\n--- status ---\n{}", self.run(&["status", "--json"]).0)
    }

    fn run(&self, args: &[&str]) -> (String, i32) {
        let o = self.cmd().args(args).output().unwrap();
        (String::from_utf8_lossy(&o.stdout).trim().to_string(), o.status.code().unwrap_or(-1))
    }

    fn json(&self, args: &[&str]) -> serde_json::Value {
        let (out, _) = self.run(args);
        serde_json::from_str(&out).unwrap_or_else(|e| panic!("{args:?} did not print JSON ({e}): {out}"))
    }

    fn up(&self) -> bool {
        self.run(&["ctl", "ping"]).1 == 0
    }

    /// Start the daemon with a hook call and wait until it answers.
    fn warm(&self) {
        self.hook("echo warm");
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(3) && !self.up() {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(self.up(), "daemon never came up");
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        common::reap(&self.dir.join("eng"), || {
            let _ = self.run(&["stop"]);
        });
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

const FORCE: &str = "git pu\x73h --force origin main";

#[test]
fn metrics_impact_and_status_reflect_real_hook_calls() {
    let e = Env::new("obs", &[]);
    e.warm();
    let forced = e.hook(FORCE);
    assert_eq!(forced.2, 2, "the git check blocks a force push: {forced:?}{}", e.diag());
    assert_eq!(e.hook("git status").2, 0);
    e.hook("rm -rf build");
    let imp = e.json(&["impact", "--json"]);
    assert_eq!(imp["by_kind"]["block"], 1, "{imp}");
    assert_eq!(imp["by_kind"]["warning"], 1, "{imp}");
    assert_eq!(imp["blocks_by_reason"]["git-guard"], 1);
    assert_eq!(imp["savings"]["model_routing"]["label"], "estimate");
    assert!(imp["savings"]["model_routing"]["estimated_usd"].is_null(), "no routing events: no invented figure");
    assert!(!imp["project_path_is_never_stored"].is_string());
    let text = imp.to_string();
    assert!(!text.contains("/tmp"), "the project is a hash, never a path: {text}");
    let by_kind = e.json(&["impact", "--json", "--kind", "warning"]);
    assert_eq!(by_kind["total"], 1);

    let m = e.json(&["metrics", "--json"]);
    let counters = m["metrics"]["counters"].as_array().unwrap();
    let calls: u64 = counters.iter().filter(|c| c["name"] == "check_calls").map(|c| c["value"].as_u64().unwrap()).sum();
    assert!(calls >= 3, "{m}");
    let hists = m["metrics"]["histograms"].as_array().unwrap();
    let git = hists.iter().find(|h| h["name"] == "check_latency_us").expect("a check latency histogram");
    assert!(git["p95_us"].as_u64().unwrap() >= git["p50_us"].as_u64().unwrap());
    let only_git = e.json(&["metrics", "--json", "--check", "git"]);
    assert!(only_git["metrics"]["counters"].as_array().unwrap().iter().all(|c| c["labels"]["check"] == "git"));

    let st = e.json(&["status", "--json"]);
    assert_eq!(st["summary"]["blocks"], 1);
    assert_eq!(st["summary"]["warnings"], 1);
    let human = e.run(&["status"]).0;
    assert!(human.contains("summary:") && human.contains("blocks: 1"), "{human}");
}

#[test]
fn every_implemented_read_only_command_prints_json_and_planned_ones_say_so() {
    let e = Env::new("json", &[]);
    e.warm();
    for c in ["status", "metrics", "impact", "version", "config"] {
        let v = e.json(&[c, "--json"]);
        assert!(v.is_object(), "{c}");
    }
    let docs = e.json(&["docs", "--json"]);
    assert!(docs["commands"].as_array().unwrap().len() >= 12 && docs["checks"].as_array().unwrap().iter().any(|c| c["name"] == "git"));
    let md = e.run(&["docs", "--format", "md"]).0;
    assert!(md.starts_with("# ah-engine reference"));
    for c in ah_engine::cli::commands().into_iter().filter(|c| c.status != "implemented") {
        let planned = c.name.as_str();
        let (out, code) = e.run(&[planned, "--json"]);
        assert_eq!(code, 64, "{planned}");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert!(v["status"].as_str().unwrap().starts_with("planned"), "{v}");
    }
    let (_, code) = e.run(&["no-such-command"]);
    assert_eq!(code, 64);
}

#[test]
fn without_a_daemon_reports_say_so_in_json() {
    let e = Env::new("down", &[("AH_ENGINE_NOSPAWN", "1")]);
    let m = e.json(&["metrics", "--json"]);
    assert_eq!(m["running"], false);
    let i = e.json(&["impact", "--json"]);
    assert_eq!(i["running"], false);
    assert_eq!(e.json(&["status", "--json"])["running"], false);
}

#[test]
fn the_daemon_stays_resident_when_idle_by_default() {
    let e = Env::new("res", &[]);
    e.warm();
    std::thread::sleep(Duration::from_millis(1600));
    assert!(e.up(), "idle exit is disabled by default (D7): the engine must stay up");
}

#[test]
fn idle_exit_is_a_config_key_and_is_reset_by_activity() {
    let e = Env::new("idle", &[("AH_ENGINE_IDLE_EXIT_S", "2"), ("AH_ENGINE_WATCHDOG_TICK_MS", "100")]);
    e.warm();
    let pid = common::marker_pid(&e.dir.join("eng")).expect("run marker");
    std::thread::sleep(Duration::from_millis(1200));
    e.hook("echo still here"); // activity resets the idle clock
    std::thread::sleep(Duration::from_millis(1200));
    assert!(common::alive(pid), "a request within the idle window keeps the daemon up");
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(6) && common::alive(pid) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!common::alive(pid), "the daemon must exit once idle for idle_exit_s");
}

#[test]
fn maintain_runs_beside_a_live_daemon_and_is_reported_in_metrics() {
    let e = Env::new("maint", &[]);
    e.warm();
    assert_eq!(e.run(&["proj", "/nonexistent/maint", "put", "hello"]).0, "ok");
    let r = e.json(&["maintain", "--json"]);
    assert_eq!(r["vacuumed"], true, "{r}");
    assert!(r["after"]["hot_bytes"].as_u64().unwrap() > 0, "{r}");
    assert_eq!(r["moved_to_archive"]["mailbox"], 0, "a pending message is active and stays in hot.db: {r}");
    assert_eq!(e.run(&["proj", "/nonexistent/maint", "take"]).0, "hello", "the daemon keeps working after a maintenance run");
    let m = e.json(&["metrics", "--json"]);
    let gauge = |n: &str| m["metrics"]["gauges"].as_array().unwrap().iter().find(|g| g["name"] == n).map(|g| g["value"].as_f64().unwrap());
    assert_eq!(gauge("maintain_runs"), Some(1.0), "{m}");
    assert!(gauge("db_hot_bytes").unwrap() > 0.0);
}

#[test]
fn backup_then_restore_through_the_cli_with_a_live_daemon() {
    let e = Env::new("bkp", &[]);
    e.warm();
    let cwd = "/nonexistent/backup";
    assert_eq!(e.run(&["proj", cwd, "put", "kept"]).0, "ok");
    let m = e.json(&["backup", "--json"]);
    assert_eq!(m["scrubbed"], true, "{m}");
    let snap = m["path"].as_str().unwrap().to_string();
    assert!(snap.starts_with(&e.dir.join("eng").join("backups").to_string_lossy().to_string()), "{snap}");
    assert_eq!(e.run(&["proj", cwd, "put", "after the backup"]).0, "ok");
    let r = e.json(&["restore", &snap, "--json"]);
    assert!(r["pre_restore_snapshot"]["path"].is_string(), "{r}");
    let kept = r["pre_restore_snapshot"]["path"].as_str().unwrap().to_string();
    assert!(std::path::Path::new(&kept).join("hot.db").exists(), "the state before the restore is kept");
    // the restore stopped the daemon; the next write or read starts a new one on the restored state
    assert_eq!(e.run(&["proj", cwd, "take"]).0, "kept");
    assert_eq!(e.run(&["proj", cwd, "take"]).0, "", "the write made after the backup is not in the restored state");
    let (out, code) = e.run(&["restore", "/nonexistent/no-snapshot", "--json"]);
    assert_eq!(code, 1, "{out}");
}

fn counter_total(m: &serde_json::Value, name: &str) -> u64 {
    m["metrics"]["counters"].as_array().unwrap().iter().filter(|c| c["name"] == name).map(|c| c["value"].as_u64().unwrap()).sum()
}

fn wait_down(e: &Env) {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) && e.up() {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!e.up(), "the daemon did not stop");
}

#[test]
fn metrics_impact_and_rollups_survive_a_restart_and_a_kill() {
    let e = Env::new("persist", &[("AH_ENGINE_SNAPSHOT_MS", "100")]);
    e.warm();
    assert_eq!(e.hook(FORCE).2, 2);
    assert_eq!(e.hook("git status").2, 0);
    let before = counter_total(&e.json(&["metrics", "--json"]), "check_calls");
    // the two calls above; the warm-up call counts only when the daemon is up within client.cold_start_wait_ms
    assert!(before >= 2, "{before}");

    // a clean stop keeps a snapshot at exit
    e.run(&["stop"]);
    wait_down(&e);
    e.warm();
    let m = e.json(&["metrics", "--json"]);
    assert_eq!(m["persisted"], true, "{m}");
    let restored = counter_total(&m, "check_calls");
    assert!(restored >= before, "counts from before the restart are kept: {restored} after {before}{}", e.diag());
    assert_eq!(e.hook("git status").2, 0);
    assert_eq!(counter_total(&e.json(&["metrics", "--json"]), "check_calls"), restored + 1, "and counting continues from them");
    let imp = e.json(&["impact", "--json"]);
    assert_eq!(imp["by_kind"]["block"], 1, "impact totals survive a restart: {imp}");
    assert_eq!(imp["persisted"], true);
    let r = e.json(&["metrics", "--json", "--rollup", "minute"]);
    assert!(!r["rollups"].as_array().unwrap().is_empty(), "rollups are kept in archive.db: {r}");

    // a kill loses at most what came after the last periodic snapshot
    let seen = counter_total(&e.json(&["metrics", "--json"]), "check_calls");
    std::thread::sleep(Duration::from_millis(400)); // several snapshot periods
    let pid = common::marker_pid(&e.dir.join("eng")).expect("run marker");
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
    unsafe { libc::kill(pid, libc::SIGKILL) };
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(3) && common::alive(pid) {
        std::thread::sleep(Duration::from_millis(10));
    }
    e.warm();
    let after = counter_total(&e.json(&["metrics", "--json"]), "check_calls");
    assert!(after >= seen, "counts snapshotted before the kill survive it: {after} after {seen}");
    assert_eq!(e.json(&["impact", "--json"])["by_kind"]["block"], 1);
}
