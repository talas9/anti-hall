//! Benchmark of the poll backend (realtime lane R1): detection latency and idle CPU against the shipped targets
//! (`realtime.latency_target_ms`, `realtime.cpu_budget_permille`). Its own test binary, because idle CPU is read from the
//! process's resource usage and any other test running in the same process would be counted too. Run it alone and look at
//! the `BENCH` line: `cargo test --release --test watch_bench -- --nocapture`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::defaults;
use ah_engine::watch::poll::Filter;
use ah_engine::watch::{Config, Watcher};

/// The sizes of the sources the DevSwarm and GitHub consumers watch, counted on the owner's machine (2026-10-08): the app DB
/// (3 names), 8 active mesh stores (4 files each), and the shared inbox, plans, workspaces and heartbeats directories.
const SET: &[(&str, usize)] = &[
    ("store1", 4),
    ("store2", 4),
    ("store3", 4),
    ("store4", 4),
    ("store5", 4),
    ("store6", 4),
    ("store7", 4),
    ("store8", 4),
    ("inbox", 311),
    ("plans", 30),
    ("workspaces", 102),
    ("heartbeats", 661),
    ("tr1", 10),
    ("tr2", 10),
    ("tr3", 10),
    ("tr4", 10),
];
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn drain(w: &Watcher, quiet: Duration) {
    while w.next(quiet).is_some() {}
}

struct Tmp(PathBuf);
impl Tmp {
    fn new(tag: &str) -> Tmp {
        let p = std::env::temp_dir().join(format!("ah-watch-{tag}-{}", std::process::id()));
        fs::remove_dir_all(&p).unwrap_or_default();
        fs::create_dir_all(&p).unwrap();
        Tmp(p)
    }
}
impl Drop for Tmp {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap_or_default(); // our own tempdir
    }
}

// ---- benchmark: latency and idle CPU of the poll backend ----------------------------------------------------------

/// Build the realistic watch set under `t`; returns the path whose growth the latency probe appends to.
fn realistic(t: &Tmp, w: &Watcher) -> PathBuf {
    let db = t.0.join("appdb");
    fs::create_dir_all(&db).unwrap();
    for n in ["devswarm.db", "devswarm.db-wal", "devswarm.db-shm"] {
        fs::write(db.join(n), vec![0u8; 4096]).unwrap();
    }
    w.add(&db, w.config().sqlite_filter("devswarm.db"));
    for (d, n) in SET {
        let p = t.0.join(d);
        fs::create_dir_all(&p).unwrap();
        for i in 0..*n {
            fs::write(p.join(format!("{i}.json")), "{}").unwrap();
        }
        w.add(&p, Filter::All);
    }
    db.join("devswarm.db-wal")
}

fn cpu() -> Duration {
    // SAFETY: `getrusage` fills a plain-old-data struct; an all-zero value is a valid starting state.
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `ru` is a valid, writable rusage and RUSAGE_SELF takes no other pointer.
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let tv = |t: libc::timeval| Duration::new(t.tv_sec as u64, (t.tv_usec as u32) * 1000);
    tv(ru.ru_utime) + tv(ru.ru_stime)
}

/// Measure idle CPU (permille of one core) and detection latency (p50, p95, max) at one poll interval.
fn measure(backend: &str, poll_ms: u64) -> (f64, Duration, Duration, Duration) {
    let mut c = Config::load();
    c.backend = backend.into();
    c.poll = ms(poll_ms);
    let t = Tmp::new(&format!("bench{backend}{poll_ms}"));
    let w = Watcher::start(c);
    let wal = realistic(&t, &w);
    drain(&w, ms(300));
    let (c0, w0) = (cpu(), Instant::now());
    std::thread::sleep(ms(6000));
    let permille = (cpu() - c0).as_secs_f64() * 1000.0 / w0.elapsed().as_secs_f64();
    let mut lat: Vec<Duration> = Vec::new();
    for i in 0..30u64 {
        std::thread::sleep(ms(37 + (i * 53) % 241)); // vary the phase against the poll tick
        let t0 = Instant::now();
        let mut f = fs::OpenOptions::new().append(true).open(&wal).unwrap();
        f.write_all(&[1u8; 64]).unwrap();
        drop(f);
        let b = w.next(ms(10_000)).expect("a batch");
        assert_eq!(b.paths, vec![wal.clone()]);
        lat.push(t0.elapsed());
    }
    lat.sort();
    (permille, lat[lat.len() / 2], lat[lat.len() * 95 / 100], lat[lat.len() - 1])
}

#[test]
fn bench_events_and_poll_latency_p95_and_idle_cpu_against_the_targets() {
    defaults::init().expect("defaults load in a test");
    let shipped = Config::load();
    let (target, budget) = (shipped.latency_target, shipped.cpu_budget_permille);
    for poll_ms in [250, 800] {
        let (cpu_pm, p50, p95, max) = measure("poll", poll_ms);
        eprintln!("BENCH poll   poll_ms={poll_ms} entries~1260 idle_cpu={cpu_pm:.3} permille latency p50={p50:?} p95={p95:?} max={max:?}");
    }
    let (cpu_pm, p50, p95, max) = measure("auto", shipped.poll.as_millis() as u64);
    eprintln!("BENCH events entries~1260 idle_cpu={cpu_pm:.3} permille (budget {budget}) latency p50={p50:?} p95={p95:?} max={max:?} (target {target:?})");
    // The shipped choice (events) meets both targets on the realistic set ...
    assert!(p95 <= target, "events p95 {p95:?} over target {target:?}");
    assert!(cpu_pm <= budget as f64, "events idle cpu {cpu_pm:.3} permille over budget {budget}");
}
