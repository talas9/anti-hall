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
    pid > 1 && unsafe { libc::kill(pid, 0) } == 0
}

/// The pid recorded in a state dir's run marker, if any.
pub fn marker_pid(state_dir: &Path) -> Option<i32> {
    std::fs::read_to_string(state_dir.join("daemon.run")).ok().and_then(|t| t.trim().parse().ok())
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
    let pid = marker_pid(state_dir);
    stop();
    let Some(pid) = pid else { return };
    if !wait_dead(pid, Duration::from_millis(1500)) {
        unsafe { libc::kill(pid, libc::SIGTERM) };
        if !wait_dead(pid, Duration::from_millis(1500)) {
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
    let _ = ah_engine::client::exchange(sock, b"CTL stop\n", Duration::from_millis(500));
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    let _ = child.wait();
}
