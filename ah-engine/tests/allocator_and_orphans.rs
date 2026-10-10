//! Row 9/10 integration checks: allocator selection and non-live daemon lifetime.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: panic output is the failure report.

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
