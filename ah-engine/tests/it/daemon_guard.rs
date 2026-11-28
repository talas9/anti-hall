//! #895: a daemon a test starts never outlives it. The shared `common::Daemon` guard stops it on drop (a normal end or a
//! failed assertion) and a panic hook kills the ones the panicking thread still holds (a guard that never gets to drop).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

/// A scratch home and state dir, and the `serve` child started in them (not yet guarded).
fn start(root: &Path) -> std::process::Child {
    std::fs::create_dir_all(root.join("home")).unwrap();
    let child = Command::new(BIN)
        .arg("serve")
        .env("HOME", root.join("home"))
        .env("AH_ENGINE_DIR", root.join("eng"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let sock = ah_engine::paths::socket_in(&root.join("eng"));
    let t = Instant::now();
    while t.elapsed() < common::READY_CEILING && ah_engine::client::ping(&sock).is_none() {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(ah_engine::client::ping(&sock).is_some(), "the scratch daemon did not come up");
    child
}

/// True when no `ah-engine serve` of this scratch state dir is left: its run marker and lock name no live daemon.
fn none_left(root: &Path, pid: u32) -> bool {
    let eng = root.join("eng");
    !common::is_daemon(pid as i32) && !common::marker_pid(&eng).is_some_and(common::is_daemon) && !common::lock_pid(&eng).is_some_and(common::is_daemon)
}

#[test]
fn a_dropped_guard_leaves_no_daemon() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ahd-guard-drop-{}", std::process::id())));
    let d = common::Daemon::new(start(&root));
    let pid = d.id();
    assert!(common::is_daemon(pid as i32), "the daemon is running while guarded");
    drop(d);
    assert!(none_left(&root, pid), "the daemon outlived its guard");
}

#[test]
fn a_failed_assertion_leaves_no_daemon() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ahd-guard-unwind-{}", std::process::id())));
    let r2 = root.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let h = std::thread::spawn(move || {
        let d = common::Daemon::with_sock(start(&r2), ah_engine::paths::socket_in(&r2.join("eng")));
        tx.send(d.id()).unwrap();
        panic!("a test assertion failed with the daemon still running");
    });
    let pid = rx.recv().unwrap();
    assert!(h.join().is_err());
    assert!(none_left(&root, pid), "the daemon outlived a panicking test");
}

#[test]
fn the_panic_hook_kills_a_daemon_whose_guard_never_drops() {
    let root = common::TempDir::at(std::env::temp_dir().join(format!("ahd-guard-hook-{}", std::process::id())));
    let r2 = root.to_path_buf();
    let (tx, rx) = std::sync::mpsc::channel();
    let h = std::thread::spawn(move || {
        let d = common::Daemon::new(start(&r2));
        tx.send(d.id()).unwrap();
        std::mem::forget(d); // no drop: only the hook can end it
        panic!("a test panicked with its guard leaked");
    });
    let pid = rx.recv().unwrap();
    assert!(h.join().is_err());
    // the daemon is this process's child, so it is collected here: it must have died by SIGKILL (the hook), not on its own
    let t = Instant::now();
    let mut status = 0;
    let mut got = 0;
    while t.elapsed() < common::READY_CEILING && got == 0 {
        // SAFETY: `waitpid` on a pid this process spawned, with a valid status pointer.
        got = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
        std::thread::sleep(Duration::from_millis(20));
    }
    if got == 0 {
        // SAFETY: `kill` takes plain integers; the cleanup of a failed run.
        unsafe { libc::kill(pid as i32, libc::SIGKILL) };
    }
    assert_eq!(got as u32, pid, "the panic hook did not end the daemon");
    assert!(libc::WIFSIGNALED(status) && libc::WTERMSIG(status) == libc::SIGKILL, "ended by something other than the hook: status {status}");
    assert!(none_left(&root, pid));
}
