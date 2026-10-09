//! D24: nothing is lost while the engine is down. With no daemon, `ah-engine proj ... put` spools each write (framed,
//! checksummed, fsync'd); a daemon that starts applies them all exactly once, in order per session, and a replay of
//! the same records (as after a crash between applying and truncating) changes nothing. A running daemon also drains
//! records that appear while it runs.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const SESSIONS: usize = 4;
const WRITES: usize = 100;

struct Env {
    dir: PathBuf,
    daemon: Option<Child>,
}

impl Env {
    fn new(tag: &str) -> Env {
        let dir = PathBuf::from("/tmp").join(format!("ah-sp-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home")).unwrap();
        std::fs::write(dir.join("rules.json"), r#"{"version":1,"rules":[]}"#).unwrap();
        Env { dir, daemon: None }
    }
    fn eng(&self) -> PathBuf {
        self.dir.join("eng")
    }
    fn sock(&self) -> PathBuf {
        self.eng().join("e.sock")
    }
    fn cmd(&self) -> Command {
        let mut c = Command::new(BIN);
        c.env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.eng())
            .env("AH_ENGINE_RULES", self.dir.join("rules.json"))
            .env("AH_ENGINE_VERSION", "0.1.0")
            .env("AH_ENGINE_SESSION_RPS", "0")
            .env("AH_ENGINE_PROJECT_RPS", "0")
            .env("AH_ENGINE_SPOOL_DRAIN_MS", "50")
            .env("AH_ENGINE_NOSPAWN", "1") // the client never starts a daemon here: the test decides when one runs
            // the two seconds a client waits for an answer are the machine's on a loaded CI runner; one late answer must not
            // count toward the breaker that makes the client skip the engine
            .env("AH_ENGINE_DEADLINE_MS", "30000")
            .env("AH_ENGINE_SPOOL_RETRIES", "4") // a write carries its id, so a retry after a late answer is applied once
            .env("AH_ENGINE_SPOOL_BACKOFF_MS", "1");
        c
    }
    fn proj(&self, session: &str, args: &[&str]) -> (String, i32) {
        let o = self.cmd().env("AH_ENGINE_SESSION", session).arg("proj").args(args).output().unwrap();
        let mut out = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !o.status.success() {
            out = format!("{out} [stderr: {}]", String::from_utf8_lossy(&o.stderr).trim()); // a failed call says why
        }
        (out, o.status.code().unwrap_or(-1))
    }
    fn start(&mut self) {
        self.start_with(&[]);
    }
    fn start_with(&mut self, env: &[(&str, &str)]) {
        let child = self.cmd().envs(env.iter().copied()).arg("serve").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        self.daemon = Some(child);
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(5) && ah_engine::client::ping(&self.sock()).is_none() {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ah_engine::client::ping(&self.sock()).is_some(), "daemon did not come up");
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if let Some(mut c) = self.daemon.take() {
            common::stop_child(&self.sock(), &mut c);
        }
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn cwd(s: usize) -> String {
    format!("/nonexistent/ah-spool/s{s}")
}

fn wait_for(f: impl Fn() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    f()
}

#[test]
fn writes_made_while_the_engine_is_down_are_applied_once_and_in_order() {
    let mut e = Env::new("down");
    for i in 0..WRITES {
        let s = i % SESSIONS;
        let (out, code) = e.proj(&format!("s{s}"), &[&cwd(s), "put", &format!("m{i:03}")]);
        assert_eq!(code, 0, "a spooled write is accepted: {out}");
        assert!(out.starts_with("spooled "), "{out}");
    }
    let spool = e.eng().join("spool.log");
    let saved = std::fs::read(&spool).unwrap();
    assert!(!saved.is_empty());

    e.start();
    assert_eq!(std::fs::metadata(&spool).unwrap().len(), 0, "the daemon drained the spool on start");
    for s in 0..SESSIONS {
        assert_eq!(e.proj("x", &[&cwd(s), "len"]).0, (WRITES / SESSIONS).to_string(), "session {s}: all writes present");
    }

    // a replay of the same records (a crash between applying and truncating) must change nothing
    std::fs::OpenOptions::new().append(true).open(&spool).map(|mut f| std::io::Write::write_all(&mut f, &saved)).unwrap().unwrap();
    assert!(wait_for(|| std::fs::metadata(&spool).map(|m| m.len() == 0).unwrap_or(false)), "the running daemon drains on its tick");
    for s in 0..SESSIONS {
        assert_eq!(e.proj("x", &[&cwd(s), "len"]).0, (WRITES / SESSIONS).to_string(), "session {s}: exactly once after a replay");
        let got: Vec<String> = (0..WRITES / SESSIONS)
            .map(|n| {
                let (out, code) = e.proj("x", &[&cwd(s), "take"]);
                assert_eq!(code, 0, "take {n} of session {s} failed (client breaker open: {}): {out:?}", e.eng().join("breaker.until").exists());
                out
            })
            .collect();
        let want: Vec<String> = (0..WRITES).filter(|i| i % SESSIONS == s).map(|i| format!("m{i:03}")).collect();
        assert_eq!(got, want, "session {s}: applied in the order written");
    }
    assert!(!e.eng().join("spool.quarantine").exists(), "nothing was damaged or refused");
}

#[test]
fn a_take_is_never_spooled_and_a_damaged_record_is_kept_in_quarantine() {
    let mut e = Env::new("q");
    let (_, code) = e.proj("s", &[&cwd(0), "take"]);
    assert_eq!(code, 1, "a take needs an answer, so with no engine it fails instead of spooling");
    assert!(!e.eng().join("spool.log").exists() || std::fs::metadata(e.eng().join("spool.log")).unwrap().len() == 0);
    assert_eq!(e.proj("s", &[&cwd(0), "put", "before"]).1, 0);
    std::fs::OpenOptions::new()
        .append(true)
        .open(e.eng().join("spool.log"))
        .map(|mut f| std::io::Write::write_all(&mut f, b"AHS1 9 deadbeef\nnot json!\n"))
        .unwrap()
        .unwrap();
    assert_eq!(e.proj("s", &[&cwd(0), "put", "after"]).1, 0);
    e.start();
    assert_eq!(e.proj("s", &[&cwd(0), "take"]).0, "before");
    assert_eq!(e.proj("s", &[&cwd(0), "take"]).0, "after");
    let q = std::fs::read_to_string(e.eng().join("spool.quarantine")).unwrap();
    assert!(q.contains("not json!"), "damaged bytes are kept: {q}");
}

#[test]
fn spooled_writes_reach_a_running_daemon_before_newer_direct_writes() {
    let mut e = Env::new("order");
    e.start();
    // a record spooled while the daemon was (say) busy, then a newer direct write from the same session
    let rec =
        ah_engine::spool::Record { id: ah_engine::spool::new_write_id(), session: "s".into(), cwd: cwd(0), verb: "put".into(), args: "older".into(), ts_ms: 1 };
    ah_engine::spool::append(Path::new(&e.eng().join("spool.log")), &rec).unwrap();
    assert_eq!(e.proj("s", &[&cwd(0), "put", "newer"]).0, "ok");
    assert_eq!(e.proj("s", &[&cwd(0), "take"]).0, "older", "the spooled write is applied first");
    assert_eq!(e.proj("s", &[&cwd(0), "take"]).0, "newer");
}

#[test]
fn a_busy_engine_makes_the_client_spool_and_the_daemon_applies_it_on_its_tick() {
    let mut e = Env::new("busy");
    // one request per second per project, no burst: the second write in a row is answered BUSY
    e.start_with(&[("AH_ENGINE_PROJECT_RPS", "1"), ("AH_ENGINE_PROJECT_BURST", "1")]);
    assert_eq!(e.proj("s", &[&cwd(0), "put", "first"]).0, "ok");
    let (out, code) = e.proj("s", &[&cwd(0), "put", "second"]);
    assert_eq!(code, 0);
    assert!(out.starts_with("spooled "), "a busy engine makes the client spool: {out}");
    let rows = || -> Vec<String> {
        let c = rusqlite::Connection::open_with_flags(e.eng().join("hot.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut st = c.prepare("SELECT body FROM mailbox ORDER BY id").unwrap();
        st.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    };
    assert!(wait_for(|| rows().len() == 2), "the daemon applies the spooled write without another request: {:?}", rows());
    assert_eq!(rows(), vec!["first", "second"]);
}
