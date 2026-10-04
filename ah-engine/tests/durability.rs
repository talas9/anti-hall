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

use ah_engine::client::{exchange, Exch};
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

/// Stop a daemon this test started as its own child: politely, then SIGKILL; it must be gone (and reaped) after.
fn stop_child(dir: &Path, child: &mut Child) {
    let _ = exchange(&sock(dir), b"CTL stop\n", Duration::from_millis(500));
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

/// The running daemon and its directory; dropping it (also on a failed assertion) stops and reaps the daemon and
/// removes the directory, so a failing run leaves nothing behind.
struct Run {
    dir: PathBuf,
    daemon: Child,
}

impl Drop for Run {
    fn drop(&mut self) {
        stop_child(&self.dir, &mut self.daemon);
        let _ = std::fs::remove_dir_all(&self.dir);
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
    let _ = std::fs::remove_dir_all(&dir);
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
        unsafe { libc::kill(run.daemon.id() as i32, libc::SIGKILL) };
        let _ = run.daemon.wait();
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
