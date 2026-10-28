//! Row 9/10 integration checks: allocator selection and non-live daemon lifetime.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: panic output is the failure report.
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml

mod common;

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

struct Serve {
    root: common::TempDir,
    state: PathBuf,
    child: Child,
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = engine(&self.root, &self.state, &["stop"], "");
        common::stop_child(&ah_engine::paths::socket_in(&self.state), &mut self.child);
    }
}

fn plugin_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

fn scratch(label: &str) -> (common::TempDir, PathBuf) {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-engine-{label}-{}-{}", std::process::id(), nanos())));
    let state = root.join("state");
    std::fs::create_dir_all(root.join("home")).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    (root, state)
}

fn nanos() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
}

fn base_cmd(root: &Path, state: &Path) -> Command {
    let mut c = Command::new(BIN);
    c.env("HOME", root.join("home")).env("AH_ENGINE_DIR", state).env("AH_ENGINE_PLUGIN_ROOT", plugin_root()).env("AH_ENGINE_NOSPAWN", "1");
    c
}

fn engine(root: &Path, state: &Path, args: &[&str], input: &str) -> (i32, String, String) {
    let mut child = base_cmd(root, state).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    child.stdin.as_mut().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned())
}

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

fn start(label: &str, allocator: &str) -> Serve {
    let (root, state) = scratch(label);
    let child = base_cmd(&root, &state)
        .env("AH_ENGINE_ALLOCATOR", allocator)
        .arg("serve")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    wait_for("daemon ping", || engine(&root, &state, &["ctl", "ping"], "").0 == 0);
    Serve { root, state, child }
}

#[test]
fn both_allocators_start_serve_a_hook_and_report_memory_mode() {
    for allocator in ["jemalloc", "system"] {
        let serve = start(allocator, allocator);
        let payload = json!({
            "session_id": format!("alloc-{allocator}"),
            "cwd": "/tmp",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "true"}
        })
        .to_string();
        let (code, _stdout, stderr) = engine(&serve.root, &serve.state, &["hook"], &payload);
        assert_eq!(code, 0, "hook served in {allocator}: {stderr}");

        let (code, stdout, stderr) = engine(&serve.root, &serve.state, &["status", "--memory", "--json"], "");
        assert_eq!(code, 0, "status --memory in {allocator}: {stderr}");
        let status: Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(status["memory"]["allocator"], allocator);
        if allocator == "system" {
            assert_eq!(status["memory"]["allocator_stats"]["jemalloc"], "n/a");
        } else {
            assert!(status["memory"]["allocator_stats"]["jemalloc"].is_object());
        }
    }
}

#[test]
fn status_memory_reports_a_live_ledger_that_balances() {
    let serve = start("ledger", "jemalloc");
    let (code, stdout, stderr) = engine(&serve.root, &serve.state, &["status", "--memory", "--json"], "");
    assert_eq!(code, 0, "status --memory: {stderr}");
    let status: Value = serde_json::from_str(&stdout).unwrap();
    let l = &status["memory"]["ledger"];
    assert!(l["footprint"].as_f64().unwrap() > 0.0, "{l}");
    // zones count what they hold (a fresh daemon: well under 5 MB), not the ~56 MB of address space the default zone reserves
    assert!(l["system_malloc_other_zones"].as_f64().unwrap() < 5.0, "{l}");
    assert!(l["unaccounted"].is_number(), "{l}");
    let h = &l["heap"];
    let allocated = h["allocated"].as_i64().unwrap();
    assert!(allocated > 0 && h["allocated_usable"].as_u64().unwrap() > 0, "{h}");
    let held: i64 = h["holders"].as_array().unwrap().iter().map(|x| x["bytes"].as_i64().unwrap()).sum();
    assert_eq!(held + h["other"].as_i64().unwrap(), allocated, "holders + other == allocated: {h}");
    assert!(l["invariant"]["other_nonneg"].is_boolean() && l["invariant"]["overcount_by"].is_array(), "{l}");
}

#[test]
fn scratch_serve_exits_when_parent_process_dies() {
    let (root, state) = scratch("parent-death");
    let mut parent = Command::new("sh")
        .arg("-c")
        .arg("AH_ENGINE_NOSPAWN=1 \"$1\" serve & echo $!; wait")
        .arg("sh")
        .arg(BIN)
        .env("HOME", root.join("home"))
        .env("AH_ENGINE_DIR", &state)
        .env("AH_ENGINE_PLUGIN_ROOT", plugin_root())
        .env("AH_ENGINE_ALLOCATOR", "jemalloc")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufReader::new(parent.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let serve_pid: i32 = line.trim().parse().unwrap();
    wait_for("child daemon", || common::is_daemon(serve_pid));
    wait_for("daemon ping", || engine(&root, &state, &["ctl", "ping"], "").0 == 0);
    // SAFETY: this is the shell process this test just spawned.
    unsafe { libc::kill(parent.id() as i32, libc::SIGTERM) };
    ah_engine::discard::harmless(parent.wait());
    wait_for("scratch daemon to exit after parent death", || !common::alive(serve_pid));
}

/// `serve` started the way a launchd/systemd unit or a replay driver starts it (no allocator tuning in the environment) still
/// returns freed pages at once: the decay settings of `daemon.malloc_conf` are applied to the running allocator.
#[test]
fn serve_without_the_malloc_env_applies_the_decay_settings() {
    let (root, state) = scratch("decay");
    let mut cmd = base_cmd(&root, &state);
    for var in ["_RJEM_MALLOC_CONF", "MALLOC_CONF"] {
        cmd.env_remove(var);
    }
    let child = cmd.env("AH_ENGINE_ALLOCATOR", "jemalloc").arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let serve = Serve { root, state, child };
    wait_for("daemon ping", || engine(&serve.root, &serve.state, &["ctl", "ping"], "").0 == 0);
    let (code, stdout, stderr) = engine(&serve.root, &serve.state, &["status", "--memory", "--json"], "");
    assert_eq!(code, 0, "status --memory: {stderr}");
    let status: Value = serde_json::from_str(&stdout).unwrap();
    let je = &status["memory"]["allocator_stats"]["jemalloc"];
    if cfg!(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu"))) {
        assert_eq!(je["dirty_decay_ms"], 0, "dirty decay applied: {je}");
        assert_eq!(je["muzzy_decay_ms"], 0, "muzzy decay applied: {je}");
    }
}
