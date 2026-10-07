//! The session-maintenance checks through the real dispatcher: `ah-engine hook --event SessionStart`, with every Node hook
//! of the event replaced by a small shell command through `--fallback-map`, so a built-in answer and a Node answer are told
//! apart by what they print. Each test has its own HOME and state directory and reaps any daemon it starts.
//!
//! What this adds to the unit tests and `tests/node_parity` (the Rust Node-parity test) (which call the checks directly): the daemon path (a
//! request carries the CLIENT's HOME and switches, never the daemon's, D76), the in-process path, and the deferral
//! contract (a deferred hook runs as Node and the files are exactly as they were).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

mod common;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Env {
    dir: PathBuf,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-sess-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::create_dir_all(dir.join("root/.claude-plugin")).unwrap();
        std::fs::write(dir.join("root/.claude-plugin/plugin.json"), r#"{"version":"1.2.3"}"#).unwrap();
        Env { dir }
    }

    fn home(&self, name: &str) -> PathBuf {
        let h = self.dir.join(name);
        std::fs::create_dir_all(&h).unwrap();
        h
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    /// A map that replaces every SessionStart Node hook by `rest`, except those named in `outs`.
    fn map(&self, outs: &[(&str, &str)], rest: &str) -> PathBuf {
        let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "SessionStart").into_iter().map(|x| x.id).collect();
        let m: serde_json::Map<String, serde_json::Value> =
            ids.iter().map(|id| (id.clone(), outs.iter().find(|(k, _)| k == id).map_or(rest.to_string(), |(_, c)| c.to_string()).into())).collect();
        let p = self.dir.join("map.json");
        std::fs::write(&p, serde_json::json!({ "SessionStart": m }).to_string()).unwrap();
        p
    }

    fn run(&self, args: &[&str], in_process: bool, payload: &str, home: &PathBuf, extra: &[(&str, &str)]) -> (i32, String, String) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", home)
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "session-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", if in_process { "1" } else { "0" })
            .env("CLAUDE_PLUGIN_ROOT", self.dir.join("root"))
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    fn wait_up(&self, home: &PathBuf) {
        for _ in 0..200 {
            if self.run(&["ctl", "ping"], false, "", home, &[]).0 == 0 {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        panic!("the daemon did not come up");
    }

    fn stop(&self) {
        let st = self.state();
        common::reap(&st, || {
            ah_engine::discard::harmless(
                Command::new(env!("CARGO_BIN_EXE_ah-engine")).arg("stop").env("AH_ENGINE_DIR", &st).env("HOME", self.dir.join("home")).output(),
            );
        });
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

fn drift_cache(ago_ms: u128) -> String {
    format!("{{\"installed\":\"2.2.0\",\"checkedAt\":{}}}", now_ms() - ago_ms)
}

fn payload(e: &Env) -> String {
    serde_json::json!({"session_id": "e2e", "cwd": e.dir, "hook_event_name": "SessionStart", "source": "startup"}).to_string()
}

const CLI_FILE: &str = ".anti-hall/claude-cli-version.json";
const ADVICE: &str = "Claude Code CLI 2.2.0 is installed; anti-hall's harness KB is audited against 2.1.238.";

#[test]
fn the_in_process_dispatcher_answers_a_fresh_cache_itself_and_writes_the_client_home() {
    let e = Env::new("inproc");
    let home = e.home("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::write(home.join(CLI_FILE), drift_cache(60_000)).unwrap();
    let map = e.map(&[("claude-cli-version", "echo NODE-RAN-CLI")], "true");
    let a = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let (code, out, err) = e.run(&a, true, &payload(&e), &home, &[]);
    assert_eq!(code, 0, "{err}");
    assert!(out.contains(ADVICE) && !out.contains("NODE-RAN-CLI"), "the built-in check answered, not the Node command: {out}");
    assert!(std::fs::read_to_string(home.join(CLI_FILE)).unwrap().contains("\"lastAdvised\":{\"installed\":\"2.2.0\",\"baseline\":\"2.1.238\"}"));
}

#[test]
fn a_stale_cache_runs_the_node_hook_and_leaves_the_files_alone() {
    let e = Env::new("stale");
    let home = e.home("home");
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let stale = drift_cache(3 * 86_400_000);
    std::fs::write(home.join(CLI_FILE), &stale).unwrap();
    let map = e.map(&[("claude-cli-version", "echo NODE-RAN-CLI")], "true");
    let a = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    let (code, out, _) = e.run(&a, true, &payload(&e), &home, &[]);
    assert_eq!(code, 0);
    assert!(out.contains("NODE-RAN-CLI") && !out.contains(ADVICE), "{out}");
    assert_eq!(std::fs::read_to_string(home.join(CLI_FILE)).unwrap(), stale);
}

/// D76 for these checks: the daemon is started by a client with one HOME and switch set; a second client with another HOME
/// and no switch is answered for ITS home, and nothing is written under the first.
#[test]
fn the_daemon_evaluates_a_request_with_the_clients_home_and_switches() {
    let e = Env::new("daemon");
    let (a_home, b_home) = (e.home("home-a"), e.home("home-b"));
    for h in [&a_home, &b_home] {
        std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
        std::fs::write(h.join(CLI_FILE), drift_cache(60_000)).unwrap();
    }
    let map = e.map(&[("claude-cli-version", "echo NODE-RAN-CLI")], "true");
    let a = ["hook", "--event", "SessionStart", "--fallback-map", map.to_str().unwrap()];
    // the first call starts the daemon and is answered through Node
    let first = e.run(&a, false, &payload(&e), &a_home, &[("ANTIHALL_CLAUDE_CLI_VERSION_ALERT", "off")]);
    assert_eq!(first.0, 0);
    e.wait_up(&a_home);
    let before_a = std::fs::read_to_string(a_home.join(CLI_FILE)).unwrap();
    let second = e.run(&a, false, &payload(&e), &b_home, &[]);
    let third = e.run(&a, false, &payload(&e), &a_home, &[("ANTIHALL_CLAUDE_CLI_VERSION_ALERT", "off")]);
    e.stop();
    assert!(second.1.contains(ADVICE) && !second.1.contains("NODE-RAN-CLI"), "daemon answered for client B: {second:?}");
    assert!(std::fs::read_to_string(b_home.join(CLI_FILE)).unwrap().contains("lastAdvised"));
    assert_eq!(std::fs::read_to_string(a_home.join(CLI_FILE)).unwrap(), before_a, "nothing written under the daemon starter's home");
    assert!(!third.1.contains(ADVICE), "client A's own switch still silences it: {third:?}");
}
