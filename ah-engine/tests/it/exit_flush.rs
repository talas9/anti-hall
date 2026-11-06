//! A scheduled subprocess action hands the counts it bumped to the daemon through the private counts file the daemon named in its
//! environment (#416), without ever taking the inbox lock. The built binary runs with a scratch HOME and state directory and no daemon
//! (`AH_ENGINE_NOSPAWN`), so nothing here touches the live engine; this test process plays the daemon (it is the child's parent).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::os::unix::io::AsRawFd;
use std::path::PathBuf;
use std::process::Command;
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

    /// `jev arrival` with nothing configured: it bumps its outcome counter with a plain `metrics::bump` and does nothing else (no model call).
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

impl Scratch {
    fn counts(&self) -> PathBuf {
        self.dir.join("counts.jsonl")
    }

    /// The counts file as the daemon would have made it: empty, owned by the run.
    fn prepare_counts(&self) {
        std::fs::write(self.counts(), "").unwrap();
    }

    /// `jev arrival` as the scheduler starts it: the marker names this process (the child's parent) and the counts file.
    fn marked(&self, parent: &str) -> Command {
        let mut c = self.command();
        c.env(ah_engine::defaults::text("schedule.child_counts_env"), format!("{parent}:{}", self.counts().display()));
        c
    }

    fn counter_lines(text: &str) -> Vec<serde_json::Value> {
        text.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()).filter(|v| v["k"] == "counter" && v["h"] == "jev_arrival").collect()
    }
}

#[test]
fn a_marked_child_writes_its_counts_to_the_file_it_was_given() {
    let s = Scratch::new("marked");
    s.prepare_counts();
    let out = s.marked(&std::process::id().to_string()).output().unwrap();
    assert!(out.status.success(), "{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let counts = std::fs::read_to_string(s.counts()).unwrap();
    let lines = Scratch::counter_lines(&counts);
    assert_eq!(lines.len(), 1, "exactly one jev_arrival counter line in the counts file, got: {counts:?}");
    assert_eq!(lines[0]["ib"], 1);
    let inbox = std::fs::read_to_string(s.inbox()).unwrap_or_default();
    assert!(Scratch::counter_lines(&inbox).is_empty(), "the count must not go through the inbox, got: {inbox:?}");
}

#[test]
fn a_marker_naming_another_parent_is_ignored() {
    // a process the job started in turn inherits the variable but its parent is not the daemon: it must not write the file
    let s = Scratch::new("foreign");
    s.prepare_counts();
    let out = s.marked("1").output().unwrap();
    assert!(out.status.success());
    assert_eq!(std::fs::read_to_string(s.counts()).unwrap(), "", "a marker for another parent writes nothing");
}

#[test]
fn a_run_that_panics_still_writes_its_counts() {
    use std::os::unix::io::FromRawFd;
    let s = Scratch::new("panic");
    s.prepare_counts();
    // stdout is a pipe whose reader is gone: printing the answer panics (the engine's SIGPIPE convention: exit 141) after the count was bumped
    let mut fds = [0i32; 2];
    // SAFETY: `fds` has room for the two descriptors `pipe` writes; each is closed or handed to the child below.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    // SAFETY: `fds[0]` is the read end just created and owned here.
    unsafe { libc::close(fds[0]) };
    // SAFETY: `fds[1]` is the write end just created; ownership moves into the `File`.
    let writer = unsafe { std::fs::File::from_raw_fd(fds[1]) };
    let status = s.marked(&std::process::id().to_string()).stdout(writer).status().unwrap();
    assert_eq!(status.code(), Some(141), "the run must end through the panic path");
    let counts = std::fs::read_to_string(s.counts()).unwrap();
    assert_eq!(Scratch::counter_lines(&counts).len(), 1, "the panicked run's count must be in the counts file, got: {counts:?}");
}

#[test]
fn a_held_inbox_lock_never_slows_a_marked_child() {
    let s = Scratch::new("held");
    s.prepare_counts();
    std::fs::create_dir_all(s.dir.join("eng")).unwrap();
    let held = std::fs::OpenOptions::new().create(true).append(true).open(s.inbox()).unwrap();
    // SAFETY: `held` is an open file we own, so its descriptor is valid; `flock` takes only the descriptor and flags.
    assert_eq!(unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX) }, 0);
    // the lock stays held for the whole run: a child that waited on it would never finish, so it is given a generous deadline (a loaded
    // machine starts slowly) and killed if it is still there
    const DEADLINE: Duration = Duration::from_secs(25);
    let mut child = s.marked(&std::process::id().to_string()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().unwrap();
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
    let status = status.unwrap_or_else(|| panic!("the child was still waiting on the inbox lock after {DEADLINE:?}: its counts path must not touch it"));
    assert!(status.success(), "{status:?}");
    drop(held);
    assert_eq!(Scratch::counter_lines(&std::fs::read_to_string(s.counts()).unwrap()).len(), 1, "the count is in the file");
    assert!(std::fs::read_to_string(s.inbox()).unwrap_or_default().is_empty(), "nothing was written to the inbox while the lock was held");
}

#[test]
fn an_unmarked_process_keeps_the_base_path() {
    // the hook dispatcher and every manual command carry no marker: a plain bump stays in the process table, the inbox gains no counter
    let s = Scratch::new("unmarked");
    s.prepare_counts();
    let out = s.command().output().unwrap();
    assert!(out.status.success());
    assert_eq!(std::fs::read_to_string(s.counts()).unwrap(), "", "no marker: the counts file is not touched");
    let inbox = std::fs::read_to_string(s.inbox()).unwrap_or_default();
    assert!(Scratch::counter_lines(&inbox).is_empty(), "no marker: no counter line reaches the inbox, got: {inbox:?}");
}
