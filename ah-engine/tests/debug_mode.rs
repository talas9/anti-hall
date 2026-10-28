//! Debug mode (one build, two runtime modes): the setting is followed by a running daemon without a restart, the environment
//! variable and the flag hold it on, and a debug line reaches the debug log. Real daemons, isolated HOME and state directories
//! (never the user's real `~/.anti-hall`); every command gets its environment on the child, nothing is set process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
mod common;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let t = Instant::now();
    while t.elapsed() < common::READY_CEILING {
        if f() {
            return;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    panic!("timed out waiting for {what}");
}

fn put(path: &Path, text: &str) {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}

fn cmd(root: &Path, extra_env: &[(&str, &str)]) -> Command {
    let mut c = Command::new(BIN);
    c.env("HOME", root.join("home")).env("AH_ENGINE_DIR", root.join("eng")).env("AH_ENGINE_NOSPAWN", "1");
    c.env("AH_ENGINE_CONFIG_WATCH_MS", "50").env("AH_ENGINE_CONFIG_DEBOUNCE_MS", "100").env("AH_ENGINE_WATCHDOG_TICK_MS", "50");
    c.env_remove("AH_ENGINE_DEBUG");
    for (k, v) in extra_env {
        c.env(k, v);
    }
    c
}

fn status(root: &Path) -> Option<Value> {
    let o = cmd(root, &[]).args(["status", "--json"]).output().ok()?;
    serde_json::from_slice(&o.stdout).ok().filter(|v: &Value| v["running"] == true)
}

struct Daemon {
    root: PathBuf,
    child: std::process::Child,
}

impl Daemon {
    fn start(name: &str, extra_env: &[(&str, &str)], args: &[&str]) -> Daemon {
        let root = PathBuf::from("/tmp").join(format!("ah-debug-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&root)); // keep: a leftover of an earlier run under this name
        std::fs::create_dir_all(root.join("home").join(".anti-hall")).unwrap();
        std::fs::create_dir_all(root.join("eng")).unwrap();
        let child = cmd(&root, extra_env).arg("serve").args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let d = Daemon { root, child };
        wait_for("the daemon to answer", || status(&d.root).is_some());
        d
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        ah_engine::discard::harmless(cmd(&self.root, &[]).arg("stop").output()); // keep: the reap below ends it anyway
        let t = Instant::now();
        while self.child.try_wait().ok().flatten().is_none() && t.elapsed() < common::READY_CEILING {
            std::thread::sleep(Duration::from_millis(20));
        }
        common::reap(&self.root.join("eng"), || {});
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.root)); // keep: cleanup of a scratch directory
    }
}

fn debug_lines(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join("eng").join("debug.ndjson")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

#[test]
fn the_setting_is_followed_without_a_restart_and_the_flag_and_the_environment_hold_it_on() {
    // ---- the setting: off at start, on after a config edit, off again after the next ------------------------------------------
    let d = Daemon::start("cfg", &[], &[]);
    let s = status(&d.root).unwrap();
    assert_eq!(s["debug"]["enabled"], false, "off by default");
    assert!(debug_lines(&d.root).is_empty(), "off writes no debug log");
    let toml = d.root.join("eng").join("config.toml");
    put(&toml, "[diagnostics]\ndebug_mode = true\n");
    wait_for("the daemon to follow the setting", || status(&d.root).is_some_and(|s| s["debug"]["enabled"] == true));
    wait_for("a debug line from a served request", || debug_lines(&d.root).iter().any(|l| l["module"] == "daemon/request"));
    put(&toml, "[diagnostics]\ndebug_mode = false\n");
    wait_for("the daemon to follow the setting off", || status(&d.root).is_some_and(|s| s["debug"]["enabled"] == false));
    drop(d);

    // ---- the flag: on although the setting is off, and a setting that is off cannot turn it off ----------------------------
    let d = Daemon::start("flag", &[], &["--debug"]);
    let s = status(&d.root).unwrap();
    assert_eq!((&s["debug"]["enabled"], &s["debug"]["forced"]), (&Value::Bool(true), &Value::Bool(true)));
    put(&d.root.join("eng").join("config.toml"), "[diagnostics]\ndebug_mode = false\n");
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(status(&d.root).unwrap()["debug"]["enabled"], true, "the flag wins over the setting");
    drop(d);

    // ---- the environment variable ---------------------------------------------------------------------------------------------
    let d = Daemon::start("env", &[("AH_ENGINE_DEBUG", "1")], &[]);
    assert_eq!(status(&d.root).unwrap()["debug"]["forced"], true);
    drop(d);
    let d = Daemon::start("env0", &[("AH_ENGINE_DEBUG", "0")], &[]);
    assert_eq!(status(&d.root).unwrap()["debug"]["enabled"], false, "0 is off");
}

#[test]
fn a_memory_budget_breach_is_reported_when_it_begins_and_clears_when_the_budget_is_lifted() {
    let d = Daemon::start("budget", &[("AH_ENGINE_RSS_CHECK_MS", "200")], &[]);
    let toml = d.root.join("eng").join("config.toml");
    wait_for("a memory reading", || status(&d.root).is_some_and(|s| s["budget"]["mem_mb"].as_u64().unwrap_or(0) > 0));
    let s = status(&d.root).unwrap();
    assert_eq!(s["budget"]["breached"], serde_json::json!([]), "a scratch daemon is within the shipped budget: {s}");
    put(&toml, "[diagnostics]\nbudget_mem_mb = 1\n");
    wait_for("the breach", || status(&d.root).is_some_and(|s| s["budget"]["breached"] == serde_json::json!(["mem"])));
    let s = status(&d.root).unwrap();
    assert_eq!(s["budget"]["mem_budget_mb"], 1);
    assert_eq!(s["budget"]["breaches"], 1);
    put(&toml, "[diagnostics]\nbudget_mem_mb = 0\n");
    wait_for("the breach to clear", || status(&d.root).is_some_and(|s| s["budget"]["breached"] == serde_json::json!([])));
}
