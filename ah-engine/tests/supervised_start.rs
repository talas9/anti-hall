//! A daemon the service manager starts (start reason launchd or systemd): it obeys the crash-loop stop, logs its start only once
//! it holds the singleton, and an outside SIGTERM ends it with the status its supervisor restarts on. Real daemon processes in
//! an isolated HOME and state directory (never the user's real `~/.anti-hall`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report
mod common;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");

fn root(name: &str) -> PathBuf {
    let r = PathBuf::from("/tmp").join(format!("ah-supstart-{name}-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&r)); // keep: a leftover of an earlier run under this name
    std::fs::create_dir_all(r.join("home").join(".anti-hall")).unwrap();
    std::fs::create_dir_all(r.join("eng")).unwrap();
    r
}

fn cmd(root: &Path) -> Command {
    let mut c = Command::new(BIN);
    c.env("HOME", root.join("home")).env("AH_ENGINE_DIR", root.join("eng")).env("AH_ENGINE_NOSPAWN", "1");
    c
}

fn serve(root: &Path, reason: &str) -> Child {
    cmd(root).args(["serve", "--start-reason", reason]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
}

/// True when the event log (a tab-separated line `ts kind code detail`) holds an event of `kind`.
fn logged(root: &Path, kind: &str) -> bool {
    let mark = format!("\t{kind}\t");
    state_text(root).lines().any(|l| l.contains(&mark) && l.split('\t').next().is_some_and(|ts| ts.parse::<u64>().is_ok()))
}

/// Every file of the state directory as text: the event log is among them.
fn state_text(root: &Path) -> String {
    std::fs::read_dir(root.join("eng")).unwrap().flatten().filter_map(|e| std::fs::read_to_string(e.path()).ok()).collect::<Vec<_>>().join("\n")
}

fn wait_exit(child: &mut Child) -> i32 {
    let t = Instant::now();
    while t.elapsed() < common::READY_CEILING {
        if let Some(st) = child.try_wait().unwrap() {
            return st.code().unwrap_or(-1);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    ah_engine::discard::harmless(child.kill()); // keep: the assertion below reports the hang
    panic!("the process did not exit");
}

#[test]
fn a_supervised_start_during_a_crash_loop_stop_exits_0_without_starting_and_logs_no_start() {
    let r = root("tripped");
    let until = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64 + 600_000;
    std::fs::write(r.join("eng").join("crashloop.until"), until.to_string()).unwrap();
    for reason in ["launchd", "systemd"] {
        let mut c = serve(&r, reason);
        assert_eq!(wait_exit(&mut c), 0, "{reason}: a stop is exit 0, which a supervisor leaves alone");
    }
    assert!(!logged(&r, "supervised_start"), "no start is logged while the loop stop holds");
    assert!(cmd(&r).args(["status", "--json"]).output().unwrap().stdout.windows(14).all(|w| w != b"\"running\":true"), "no daemon runs");
    ah_engine::discard::harmless(std::fs::remove_dir_all(&r)); // keep: cleanup of a scratch directory
}

#[test]
fn a_supervised_daemon_logs_its_start_and_an_outside_sigterm_ends_it_with_75_and_exit_sigterm() {
    let r = root("term");
    let mut c = serve(&r, "launchd");
    let t = Instant::now();
    // up and answering: the signal handlers are installed by then
    while !cmd(&r).args(["status", "--json"]).output().unwrap().stdout.windows(14).any(|w| w == b"\"running\":true") && t.elapsed() < common::READY_CEILING {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(logged(&r, "supervised_start"), "the start is logged once the lock is won");
    // SAFETY: `kill` takes plain integers; the pid is our own live child.
    unsafe { libc::kill(c.id() as i32, libc::SIGTERM) };
    assert_eq!(wait_exit(&mut c), 75, "the supervisor starts it again");
    assert!(logged(&r, "exit") && state_text(&r).lines().any(|l| l.contains("\texit\tsigterm\t")), "logged as exit/sigterm");
    assert!(!logged(&r, "crash"), "never as a crash");
    ah_engine::discard::harmless(std::fs::remove_dir_all(&r)); // keep: cleanup of a scratch directory
}

#[test]
fn an_unsupervised_daemon_exits_0_on_sigterm() {
    let r = root("manual");
    let mut c = serve(&r, "manual");
    let t = Instant::now();
    while !cmd(&r).args(["status", "--json"]).output().unwrap().stdout.windows(14).any(|w| w == b"\"running\":true") && t.elapsed() < common::READY_CEILING {
        std::thread::sleep(Duration::from_millis(25));
    }
    // SAFETY: `kill` takes plain integers; the pid is our own live child.
    unsafe { libc::kill(c.id() as i32, libc::SIGTERM) };
    assert_eq!(wait_exit(&mut c), 0);
    ah_engine::discard::harmless(std::fs::remove_dir_all(&r)); // keep: cleanup of a scratch directory
}
