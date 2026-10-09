//! Shared test support: reaping the daemons a test starts (D7, step 6).
//!
//! Why this exists: a test that starts a real daemon must end it, or daemons pile up across runs (the suite once left
//! one behind per run). `reap` stops the daemon politely, then by its run marker, then with SIGKILL, and fails the
//! test if the process is still alive afterwards, so a leak is a test failure, never silent.
#![allow(dead_code)] // each test binary uses a subset

use std::path::Path;
use std::time::{Duration, Instant};

/// True when a process with this pid exists.
pub fn alive(pid: i32) -> bool {
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
    pid > 1 && unsafe { libc::kill(pid, 0) } == 0
}

/// The pid recorded in a state dir's run marker, if any.
pub fn marker_pid(state_dir: &Path) -> Option<i32> {
    std::fs::read_to_string(state_dir.join("daemon.run")).ok().and_then(|t| t.trim().parse().ok())
}

/// True when `pid` is a live `ah-engine serve` (never signal a pid that was reused by something else).
pub fn is_daemon(pid: i32) -> bool {
    alive(pid)
        && std::process::Command::new("ps")
            .args(["-o", "command=", "-p", &pid.to_string()])
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).contains("ah-engine serve"))
}

/// The pid in a state dir's singleton lock file (written by the daemon that holds it), if any.
pub fn lock_pid(state_dir: &Path) -> Option<i32> {
    let lock = ah_engine::paths::lock_for(&ah_engine::paths::socket_in(state_dir));
    std::fs::read_to_string(lock).ok().and_then(|t| t.trim().parse().ok()).filter(|p| *p > 1)
}

fn wait_dead(pid: i32, within: Duration) -> bool {
    let t = Instant::now();
    while t.elapsed() < within {
        if !alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    !alive(pid)
}

/// Stop the daemon of `state_dir`: call `stop` (the polite control request), then fall back to its run marker, and
/// panic (outside an unwind) if it is still alive. Call this BEFORE removing the state dir.
pub fn reap(state_dir: &Path, stop: impl Fn()) {
    // the run marker, else the pid the singleton lock file names: a daemon whose marker was never written or already
    // removed (a failed start, a crash-loop test) must still be ended, or it outlives the test with its dir deleted
    let find = || marker_pid(state_dir).or_else(|| lock_pid(state_dir)).filter(|p| is_daemon(*p));
    let mut pid = find();
    stop();
    if pid.is_none() {
        // A daemon a client spawned a moment before the test ended can still be starting (on a loaded CI runner that took
        // seconds), with no marker or lock yet: wait for it to show itself, then stop it, or it outlives the test.
        let t = Instant::now();
        while pid.is_none() && t.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(50));
            pid = find();
        }
        if pid.is_some() {
            stop();
        }
    }
    let Some(pid) = pid else { return };
    if !wait_dead(pid, Duration::from_millis(1500)) {
        // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        if !wait_dead(pid, Duration::from_millis(1500)) {
            // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
            unsafe { libc::kill(pid, libc::SIGKILL) };
            wait_dead(pid, Duration::from_millis(1500));
        }
    }
    if !std::thread::panicking() {
        assert!(!alive(pid), "daemon {pid} of {} survived its test", state_dir.display());
    }
}

/// Stop a daemon a test started as its own child (`ah-engine serve`): ask it to stop over `sock`, then SIGKILL; it is
/// waited for (reaped) either way, so it can never outlive the test.
pub fn stop_child(sock: &Path, child: &mut std::process::Child) {
    ah_engine::client::exchange(sock, b"CTL stop\n", Duration::from_millis(500));
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    ah_engine::discard::harmless(child.kill());
    ah_engine::discard::harmless(child.wait());
}
