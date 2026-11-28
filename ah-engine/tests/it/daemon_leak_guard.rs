//! A daemon a test harness starts must not outlive its test (#742): not when the test panics, and not when the test process is
//! killed (a nextest timeout, a cancelled CI job, Ctrl-C), where no `Drop` runs.
//!
//! Each case runs a small harness scenario in a child process (this test binary, the ignored `scenario` test below) that
//! auto-starts a real daemon through the client, in a scratch HOME and state directory under the system temp directory,
//! exactly as the `e2e` and `gitcheck` harnesses do (the daemon's `daemon.scratch_idle_exit_s` is what ends it when no `Drop` runs). The parent then checks the daemon the child left behind.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use crate::common;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const PAYLOAD: &str = r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"true"}}"#;

/// The harness the child runs: the shape of `e2e::Env` (scratch dir, auto-start allowed, `reap` in `Drop`).
struct Harness {
    dir: PathBuf,
}

impl Harness {
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env_remove("AH_ENGINE_NOSPAWN")
            .env_remove("AH_ENGINE_IDLE_EXIT_S");
        c
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        common::reap(&self.dir.join("eng"), || {
            ah_engine::discard::harmless(self.cmd().args(["ctl", "stop"]).output());
        });
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

/// The child side. Ignored: the parent cases below run it, with `AH_LEAK_ROOT` and `AH_LEAK_MODE` set.
#[test]
#[ignore = "run by the parent cases of this file"]
fn scenario() {
    let (Some(root), Ok(mode)) = (std::env::var_os("AH_LEAK_ROOT"), std::env::var("AH_LEAK_MODE")) else { return };
    let h = Harness { dir: PathBuf::from(root).join("scratch") };
    std::fs::create_dir_all(h.dir.join("home")).unwrap();
    let mut ch = h.cmd().arg("hook").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(PAYLOAD.as_bytes()).unwrap();
    ch.wait().unwrap();
    let state = h.dir.join("eng");
    let t = Instant::now();
    let pid = loop {
        if let Some(p) = common::marker_pid(&state).filter(|p| common::is_daemon(*p)) {
            break p;
        }
        assert!(t.elapsed() < common::READY_CEILING, "the harness's client never started a daemon");
        std::thread::sleep(Duration::from_millis(20));
    };
    std::fs::write(Path::new(&std::env::var_os("AH_LEAK_ROOT").unwrap()).join("daemon.pid"), pid.to_string()).unwrap();
    match mode.as_str() {
        "panic" => panic!("scenario: the test fails while its daemon is running"),
        _ => std::thread::sleep(Duration::from_secs(600)), // "hang": the parent kills this process
    }
}

fn child(root: &Path, mode: &str, backstop_s: &str) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "daemon_leak_guard::scenario", "--test-threads", "1"])
        .env("AH_LEAK_ROOT", root)
        .env("AH_LEAK_MODE", mode)
        .env("AH_ENGINE_SCRATCH_IDLE_EXIT_S", backstop_s)
        .env_remove("AH_ENGINE_IDLE_EXIT_S")
        .env_remove("AH_ENGINE_NOSPAWN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

fn wait_for(mut f: impl FnMut() -> bool, ceiling: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < ceiling {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    f()
}

fn daemon_pid(root: &Path) -> Option<i32> {
    std::fs::read_to_string(root.join("daemon.pid")).ok()?.trim().parse().ok()
}

/// Ends a daemon the case under test left alive, so a failing case cannot leak one itself.
fn kill_leftover(pid: i32) {
    if common::alive(pid) {
        // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

#[test]
fn a_panicking_harness_test_leaves_no_daemon_and_no_scratch_dir() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-leakguard-panic-{}", std::process::id())));
    let mut c = child(root.path(), "panic", "180");
    let status = c.wait().unwrap();
    let pid = daemon_pid(root.path()).expect("the scenario never recorded its daemon");
    let survived = !wait_for(|| !common::alive(pid), common::READY_CEILING);
    kill_leftover(pid);
    assert!(!status.success(), "the scenario was meant to panic");
    assert!(!survived, "daemon {pid} of a panicked harness test survived it");
    assert!(!root.path().join("scratch").exists(), "the panicked harness left its scratch directory");
}

#[test]
fn a_killed_test_process_leaves_no_daemon_beyond_the_scratch_idle_cap() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-leakguard-kill-{}", std::process::id())));
    let mut c = child(root.path(), "hang", "3");
    let started = wait_for(|| daemon_pid(root.path()).is_some(), common::READY_CEILING);
    // SIGKILL: no Drop, no reap, exactly what a nextest timeout does to a test process
    ah_engine::discard::harmless(c.kill());
    ah_engine::discard::harmless(c.wait());
    let pid = daemon_pid(root.path());
    assert!(started && pid.is_some(), "the scenario never started its daemon");
    let pid = pid.unwrap();
    // the cap is 3 s of idleness, checked every idle_check_ms; allow for a loaded machine
    let gone = wait_for(|| !common::alive(pid), common::READY_CEILING);
    kill_leftover(pid);
    assert!(gone, "daemon {pid} of a killed test process was still running {:?} after its test died", common::READY_CEILING);
}

/// The shipped cap, read from the plugin's own defaults (never a literal in the test).
fn shipped_scratch_cap() -> u64 {
    let plugin = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    let t: toml::Table = std::fs::read_to_string(plugin.join("engine/defaults/engine.toml")).unwrap().parse().unwrap();
    t["daemon"]["scratch_idle_exit_s"]["value"].as_integer().unwrap() as u64
}

/// A daemon started the way `dispatch_e2e` does (state dir under the parent's temp directory, `env_clear()`, so the daemon
/// resolves its own temp directory differently) with the SHIPPED cap (no override) is still capped.
#[test]
fn the_shipped_cap_holds_under_a_cleared_env() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ah-leakguard-env-{}", std::process::id())));
    assert_eq!(daemon_idle_exit(root.path(), None), Some(shipped_scratch_cap()), "a daemon under the temp dir with a cleared env escaped the shipped cap");
}

/// A state dir that is no scratch (outside every temp root) is never capped, even when `TMPDIR` is `/` or the user's home:
/// such a temp root would otherwise make every real daemon "scratch" (idle exit ignores scheduled jobs, shutdown kills them).
#[test]
fn a_temp_root_of_slash_or_home_does_not_make_a_real_state_dir_scratch() {
    let base = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("ah-leakguard-real-{}", std::process::id()));
    let home = ah_engine::checks::jsport::home::real_home().unwrap_or_else(|| "/".into());
    let root = common::TempDir::at(base);
    for tmpdir in ["/", home.as_str()] {
        let got = daemon_idle_exit(root.path(), Some(tmpdir));
        assert!(got > Some(shipped_scratch_cap()), "TMPDIR={tmpdir} made a non-scratch state dir scratch: idle exit {got:?}");
    }
}

/// Starts a daemon through a client with a cleared env (scratch HOME, state under `root`, optional `TMPDIR`), reads its idle
/// exit from `status --json`, and stops it.
fn daemon_idle_exit(root: &Path, tmpdir: Option<&str>) -> Option<u64> {
    let state = root.join("state");
    std::fs::create_dir_all(root.join("home")).unwrap();
    let cmd = || {
        let mut c = Command::new(BIN);
        c.env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", root.join("home"))
            .env("AH_ENGINE_DIR", &state)
            .env("AH_ENGINE_VERSION", "0.1.0");
        if let Some(t) = tmpdir {
            c.env("TMPDIR", t);
        }
        c
    };
    let mut ch = cmd().arg("hook").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    ch.stdin.take().unwrap().write_all(PAYLOAD.as_bytes()).unwrap();
    ch.wait().unwrap();
    let t = Instant::now();
    while !common::marker_pid(&state).is_some_and(common::is_daemon) {
        assert!(t.elapsed() < common::READY_CEILING, "no daemon started");
        std::thread::sleep(Duration::from_millis(20));
    }
    // the marker shows before the socket listens: ask until the daemon itself answers (its status carries the key)
    let v = loop {
        let o = cmd().args(["status", "--json"]).output().unwrap();
        if let Some(v) = serde_json::from_slice::<serde_json::Value>(&o.stdout).ok().filter(|v| v.get("idle_exit_s").is_some()) {
            break v;
        }
        assert!(t.elapsed() < common::READY_CEILING, "the daemon never answered a status: {}", String::from_utf8_lossy(&o.stdout));
        std::thread::sleep(Duration::from_millis(50));
    };
    common::reap(&state, || {
        ah_engine::discard::harmless(cmd().args(["ctl", "stop"]).output());
    });
    v["idle_exit_s"].as_u64()
}
