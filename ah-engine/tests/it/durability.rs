//! D23: a write is acknowledged only after its commit, and a crash never half-applies one.
//!
//! The test runs a real daemon, has several threads write to it as fast as they can (mailbox puts and key sets, each
//! with a write id), kills the daemon with SIGKILL in the middle of the burst, starts a new one, and checks the
//! databases against what the writers saw:
//!  - every acknowledged put is present, and every acknowledged key set (or a later one) is the key's value;
//!  - everything present was really sent, intact (each value carries its own checksum), and present once;
//!  - the write ids recorded as applied match the rows one to one (the id and the row commit together, never half).
//!
//! It loops `LOOPS` times against the same state directory, so recovery after recovery is tested too. Every daemon it
//! starts is its own child process and is reaped (waited for) before the test ends.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::common;

use ah_engine::client::{Exch, exchange};
use ah_engine::frame::Kind;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_ah-engine");
const LOOPS: usize = 50;
const THREADS: usize = 4;
/// Puts per thread per loop, below `store.mailbox_cap`; after that a thread only sets keys.
const PUTS: usize = 60;
const KEYS: usize = 4;

fn spawn(dir: &Path) -> Child {
    Command::new(BIN)
        .arg("serve")
        .env("HOME", dir.join("home"))
        .env("AH_ENGINE_DIR", dir.join("eng"))
        .env("AH_ENGINE_RULES", dir.join("rules.json"))
        .env("AH_ENGINE_VERSION", "0.1.0")
        .env("AH_ENGINE_SESSION_RPS", "0")
        .env("AH_ENGINE_PROJECT_RPS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

/// The running daemon and its directory; dropping it (also on a failed assertion) stops and reaps the daemon and
/// removes the directory, so a failing run leaves nothing behind.
struct Run {
    dir: PathBuf,
    daemon: Child,
}

impl Drop for Run {
    fn drop(&mut self) {
        common::stop_child(&sock(&self.dir), &mut self.daemon);
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn sock(dir: &Path) -> PathBuf {
    dir.join("eng").join("e.sock")
}

fn wait_up(dir: &Path) {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(5) {
        if ah_engine::client::ping(&sock(dir)).is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("daemon did not come up");
}

/// FNV-1a 64 of `s`: each value ends with the checksum of the rest, so a torn value cannot pass as intact.
fn sum(s: &str) -> String {
    format!("{:016x}", s.bytes().fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3)))
}

fn value(lp: usize, t: usize, i: usize) -> String {
    let body = format!("{lp}.{t}.{i}.{}", "x".repeat(i % 97));
    format!("{body}#{}", sum(&body))
}

fn intact(v: &str) -> bool {
    v.rsplit_once('#').is_some_and(|(b, s)| sum(b) == s)
}

/// What one thread sent and which writes were acknowledged.
#[derive(Default)]
struct Seen {
    puts_sent: HashSet<String>,
    puts_acked: HashSet<String>,
    /// key -> (value of each set in send order, index of the last acknowledged one)
    sets: HashMap<String, (Vec<String>, Option<usize>)>,
}

fn burst(dir: &Path, lp: usize, t: usize, stop: Arc<AtomicBool>, seen: Arc<Mutex<Seen>>) {
    let s = sock(dir);
    let project = format!("/nonexistent/ah-durability/{lp}/{t}");
    let mut i = 0;
    while !stop.load(SeqCst) {
        let v = value(lp, t, i);
        let (req, put, key) = if i < PUTS {
            (format!("P {project}\nW p-{lp}-{t}-{i}\nput {v}"), true, String::new())
        } else {
            let key = format!("k{}", i % KEYS);
            (format!("P {project}\nW s-{lp}-{t}-{i}\nset {key} {v}"), false, key)
        };
        {
            let mut g = seen.lock().unwrap();
            if put {
                g.puts_sent.insert(v.clone());
            } else {
                g.sets.entry(key.clone()).or_default().0.push(v.clone());
            }
        }
        match exchange(&s, req.as_bytes(), Duration::from_millis(500)) {
            Exch::Reply(Kind::Ok, _) => {
                let mut g = seen.lock().unwrap();
                if put {
                    g.puts_acked.insert(v);
                } else {
                    let e = g.sets.get_mut(&key).unwrap();
                    e.1 = Some(e.0.len() - 1);
                }
            }
            _ => return, // the daemon is gone: nothing more is acknowledged
        }
        i += 1;
    }
}

fn check(dir: &Path, lp: usize, seen: &[Arc<Mutex<Seen>>]) -> (usize, usize) {
    let c = rusqlite::Connection::open_with_flags(dir.join("eng").join("hot.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let (mut acked, mut present_total) = (0, 0);
    for (t, s) in seen.iter().enumerate() {
        let s = s.lock().unwrap();
        let project = format!("/nonexistent/ah-durability/{lp}/{t}");
        let mut st = c.prepare("SELECT body FROM mailbox WHERE project = ?1").unwrap();
        let bodies: Vec<String> = st.query_map([&project], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        let present: HashSet<String> = bodies.iter().cloned().collect();
        assert_eq!(present.len(), bodies.len(), "loop {lp} thread {t}: a put is present twice");
        for b in &bodies {
            assert!(intact(b), "loop {lp} thread {t}: torn value {b:?}");
            assert!(s.puts_sent.contains(b), "loop {lp} thread {t}: {b:?} was never sent");
        }
        for a in &s.puts_acked {
            assert!(present.contains(a), "loop {lp} thread {t}: acknowledged put {a:?} is missing after the crash");
        }
        acked += s.puts_acked.len();
        present_total += bodies.len();
        for (key, (sent, last_ack)) in &s.sets {
            let v: Option<String> = c.query_row("SELECT value FROM kv WHERE project = ?1 AND key = ?2", [&project, key], |r| r.get(0)).ok();
            match (v, last_ack) {
                (Some(v), _) => {
                    assert!(intact(&v), "loop {lp}: torn key value {v:?}");
                    let at = sent.iter().position(|x| *x == v).unwrap_or_else(|| panic!("loop {lp}: key {key} holds {v:?}, never sent"));
                    if let Some(a) = last_ack {
                        assert!(at >= *a, "loop {lp}: key {key} went back to an older value than the last acknowledged one");
                        acked += 1;
                    }
                }
                (None, Some(_)) => panic!("loop {lp}: acknowledged set of {key} is missing"),
                (None, None) => {}
            }
        }
    }
    // the write id and the row it wrote commit together, never one without the other: one id per row, one row per id
    let ids: i64 = c.query_row("SELECT COUNT(*) FROM applied WHERE write_id LIKE ?1", [format!("p-{lp}-%")], |r| r.get(0)).unwrap();
    assert_eq!(ids as usize, present_total, "loop {lp}: every applied put id has exactly its one row");
    (acked, present_total)
}

#[test]
fn kill_9_mid_burst_never_loses_an_acknowledged_write_or_half_applies_one() {
    let dir = PathBuf::from("/tmp").join(format!("ah-dur-{}", std::process::id()));
    ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
    std::fs::create_dir_all(dir.join("home")).unwrap();
    std::fs::write(dir.join("rules.json"), r#"{"version":1,"rules":[]}"#).unwrap();
    let started = Instant::now();
    let mut run = Run { daemon: spawn(&dir), dir: dir.clone() };
    wait_up(&dir);
    let (mut acked_total, mut present_total) = (0, 0);
    let mut rng: u64 = 0x2545_f491_4f6c_dd1d ^ std::process::id() as u64;
    for lp in 0..LOOPS {
        let stop = Arc::new(AtomicBool::new(false));
        let seen: Vec<Arc<Mutex<Seen>>> = (0..THREADS).map(|_| Arc::new(Mutex::new(Seen::default()))).collect();
        let workers: Vec<_> = (0..THREADS)
            .map(|t| {
                let (d, stop, seen) = (dir.clone(), stop.clone(), seen[t].clone());
                std::thread::spawn(move || burst(&d, lp, t, stop, seen))
            })
            .collect();
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        std::thread::sleep(Duration::from_millis(2 + rng % 30));
        // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a dead pid just fails with ESRCH.
        unsafe { libc::kill(run.daemon.id() as i32, libc::SIGKILL) };
        ah_engine::discard::harmless(run.daemon.wait());
        stop.store(true, SeqCst);
        workers.into_iter().for_each(|w| w.join().unwrap());
        run.daemon = spawn(&dir);
        wait_up(&dir); // recovery: the new daemon opens the databases the killed one left
        let (a, p) = check(&dir, lp, &seen);
        acked_total += a;
        present_total += p;
        assert!(started.elapsed() < Duration::from_secs(120), "the crash loop must stay bounded in time");
    }
    assert!(acked_total > LOOPS, "the bursts really wrote: {acked_total} acknowledged");
    eprintln!("durability: {LOOPS} kill -9 loops, {acked_total} acknowledged writes all present, {present_total} puts present, in {:?}", started.elapsed());
}

/// Review findings 10, 11 and 22: whole-file state is written through `crate::atomic` (a temporary file, synced, renamed),
/// never truncated in place, so a reader or a crash never sees a cut file. The plain writes left in the source are the
/// documented exceptions (DECISIONS, "Atomic-write exceptions"); a new one fails here until it is converted or listed.
#[test]
fn whole_file_state_is_written_atomically_outside_the_listed_exceptions() {
    const EXCEPTIONS: &[(&str, &str)] = &[
        ("src/backup.rs", "manifest written into a backup directory that is not published yet"),
        ("src/checks/speculation_guard/mod.rs", "an append-only judge log cut at its cap, as Node does"),
        ("src/checks/sibling_sweep/mod.rs", "an append-only log cut at its cap, as Node does"),
        ("src/checks/guardkit/nodelock.rs", "a lock file (locks stay as they are)"),
        ("src/checks/guardkit/filelock.rs", "a lock file (locks stay as they are)"),
        ("src/checks/phase_tracker/mod.rs", "the phase log is written in place so a symlinked log is written through, as Node does"),
        ("src/dispatch/mod.rs", "the empty done marker the wrapper tests for existence"),
        ("src/doctor/selftest.rs", "fixtures in the self-test's scratch home"),
        ("src/doctor/devswarm.rs", "fixtures in the DevSwarm hook self-test's scratch home (`selftest::Scratch`), never state"),
        ("src/defaults/load.rs", "the one-time backup copy of an edited defaults file (a new file)"),
        (
            "src/meshw/",
            "the mesh verbs write the very files and bytes Node's devswarm code writes (a staged tmp file then rename, an in-place cut, the background checker's scratch fixtures), and the parity tests compare them byte for byte",
        ),
        (
            "src/ops/",
            "the operator command-line tools (settings, defect, statusline, phase, install-statusline) write the very files Node's scripts write, in place or via their own tmp+rename, and the shadow scratch files; the parity tests compare the bytes",
        ),
        ("src/operator/install_codex.rs", "writes .codex/hooks.json exactly as install-codex.js does; the parity test compares the file"),
        ("src/dssup/witness.rs", "the witness spec file in its scratch directory (never state)"),
        ("src/dssup/recon/mirror.rs", "files of the scratch mirror the reconcile runs against (never the real store)"),
        ("src/dssup/recon/sweep.rs", "a scratch copy of the sweep state the Node function runs against (never the real state)"),
        ("src/bin/", "developer generators, not the engine"),
    ];
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") && p.file_name().is_some_and(|n| n != "tests.rs") {
                out.push(p);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    walk(&root.join("src"), &mut files);
    // files compiled only into the unit tests (`#[cfg(test)] mod x;` in their parent)
    let test_only = ["src/checks/guardkit/jsdiff_sites.rs", "src/checks/jsport/testkit.rs", "src/script/golden.rs"];
    let mut found = Vec::new();
    for f in files {
        let rel = f.strip_prefix(root).unwrap().to_string_lossy().to_string();
        let text = std::fs::read_to_string(&f).unwrap();
        // the code before the file's unit-test module (`#[cfg(test)]` then a `mod`), and none of a test-only file
        let lines: Vec<&str> = text.lines().collect();
        let end = (0..lines.len())
            .find(|&i| lines[i].trim() == "#[cfg(test)]" && lines[i + 1..].iter().take(3).any(|l| l.trim_start().starts_with("mod ")))
            .unwrap_or(lines.len());
        let code = if test_only.contains(&rel.as_str()) { String::new() } else { lines[..end].join("\n") };
        for (n, line) in code.lines().enumerate() {
            if line.contains("std::fs::write(") && !line.trim_start().starts_with("//") && !EXCEPTIONS.iter().any(|(p, _)| rel.starts_with(p)) {
                found.push(format!("{rel}:{}: {}", n + 1, line.trim()));
            }
        }
    }
    assert!(found.is_empty(), "plain whole-file writes outside crate::atomic:\n{}", found.join("\n"));
}
