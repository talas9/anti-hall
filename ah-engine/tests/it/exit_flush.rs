//! A count a one-shot child process bumps reaches the daemon's telemetry inbox on its exit (#416), and the exit never waits on the
//! inbox lock past the bounded budget. The built binary runs with a scratch HOME and state directory and no daemon (`AH_ENGINE_NOSPAWN`),
//! so nothing here touches the live engine.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(tag: &str) -> Scratch {
        let root = std::env::var_os("AH_ENGINE_IT_ROOT").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
        let dir = root.join(format!("ah-exitflush-{}-{}", tag, std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        Scratch { dir }
    }

    fn inbox(&self) -> PathBuf {
        self.dir.join("eng").join("telemetry-inbox.jsonl")
    }

    /// `jev arrival` with nothing configured: it bumps its outcome counter with a plain `metrics::bump` and does nothing else.
    fn arrival(&self) -> Output {
        self.command().output().unwrap()
    }

    fn command(&self) -> Command {
        let mut c = Command::new(BIN);
        c.args(["jev", "arrival", "--json"])
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.dir.join("eng"))
            .env("AH_ENGINE_NOSPAWN", "1")
            .current_dir(&self.dir);
        c
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

#[test]
fn a_plain_bump_in_a_child_process_reaches_the_inbox_on_exit() {
    let s = Scratch::new("bump");
    let out = s.arrival();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let inbox = std::fs::read_to_string(s.inbox()).unwrap_or_default();
    let counters: Vec<serde_json::Value> =
        inbox.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).filter(|v| v["k"] == "counter" && v["h"] == "jev_arrival").collect();
    assert_eq!(counters.len(), 1, "the child's jev_arrival count must be in the inbox, got: {inbox:?}");
    assert_eq!(counters[0]["ib"], 1);
}

#[test]
fn a_run_that_panics_still_hands_over_its_counts() {
    use std::os::unix::io::FromRawFd;
    let s = Scratch::new("panic");
    // stdout is a pipe whose reader is gone: printing the answer panics (the engine's SIGPIPE convention: exit 141) after the count was bumped
    let mut fds = [0i32; 2];
    // SAFETY: `fds` has room for the two descriptors `pipe` writes; each is closed or handed to the child below.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: `fds[0]` is the read end just created and owned here.
    unsafe { libc::close(fds[0]) };
    // SAFETY: `fds[1]` is the write end just created; ownership moves into the `File`.
    let writer = unsafe { std::fs::File::from_raw_fd(fds[1]) };
    let status = Command::new(BIN)
        .args(["jev", "arrival", "--json"])
        .env("HOME", s.dir.join("home"))
        .env("AH_ENGINE_DIR", s.dir.join("eng"))
        .env("AH_ENGINE_NOSPAWN", "1")
        .current_dir(&s.dir)
        .stdout(writer)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(141), "the run must end through the panic path");
    let inbox = std::fs::read_to_string(s.inbox()).unwrap_or_default();
    assert!(
        inbox.lines().any(|l| l.contains("\"k\":\"counter\"") && l.contains("jev_arrival")),
        "the panicked run's count must be in the inbox, got: {inbox:?}"
    );
}

#[test]
fn the_exit_flush_gives_up_on_a_held_inbox_lock_instead_of_stalling() {
    let s = Scratch::new("held");
    std::fs::create_dir_all(s.dir.join("eng")).unwrap();
    let held = std::fs::OpenOptions::new().create(true).append(true).open(s.inbox()).unwrap();
    // SAFETY: `held` is an open file we own, so its descriptor is valid; `flock` takes only the descriptor and flags.
    assert_eq!(unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX) }, 0);
    // the lock stays held for the whole run: a child that waited on it would never finish, so it is given a generous deadline (a loaded
    // machine starts slowly) and killed if it is still there
    const DEADLINE: Duration = Duration::from_secs(25);
    let mut child = s.command().stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break Some(st);
        }
        if start.elapsed() > DEADLINE {
            ah_engine::discard::harmless(child.kill()); // keep: the test is failing and the child is stuck on the lock
            ah_engine::discard::harmless(child.wait());
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let status =
        status.unwrap_or_else(|| panic!("the child was still waiting on the inbox lock after {DEADLINE:?}: the exit flush must give up at its budget"));
    assert!(status.success(), "{status:?}");
    drop(held);
    assert!(std::fs::read_to_string(s.inbox()).unwrap_or_default().is_empty(), "nothing was written while the lock was held");
}
