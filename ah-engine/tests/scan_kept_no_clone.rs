//! #173: a kept-walk answer must not clone the whole kept walk. Every scan that hit the cache copied the walk (every call, every
//! tool use, every retained answer text) before finishing it, so each answer cost as much again as the walk held, times the requests in
//! flight. The answer now reads the kept walk in place and copies only the few fields it changes. One test binary of its own: the
//! allocation counter is process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::checks::agent_scan::{Opts, scan_transcript, scan_transcript_uncached};
use serde_json::{Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Total;
static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

// SAFETY: every call forwards to `System` unchanged; only the allocated-byte counter is touched besides.
unsafe impl GlobalAlloc for Total {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(l.size(), Relaxed);
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        ALLOCATED.fetch_add(l.size(), Relaxed);
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if n > l.size() {
            ALLOCATED.fetch_add(n - l.size(), Relaxed);
        }
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.realloc(p, l, n) }
    }
}

#[global_allocator]
static ALLOC: Total = Total;

const NOW: f64 = 1_791_300_000_000.0;
const LAUNCHES: usize = 3000;
const MESSAGES: usize = 1500;

fn line(role: &str, content: Value, ts: &str) -> String {
    json!({"type": role, "message": {"role": role, "content": content}, "timestamp": ts}).to_string()
}

/// `LAUNCHES` background agent launches (a call and its answer each), none finished: the kept walk holds every call and answer.
fn write_transcript(path: &std::path::Path) {
    let mut f = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    for n in 0..LAUNCHES {
        let ts = format!("2026-10-06T12:{:02}:00.000Z", n % 60);
        let agent = format!("a{n:015x}");
        let text = format!(
            "Async agent launched successfully. (internal metadata)\nagentId: {agent} (internal ID)\nThe agent is working in the background.\noutput_file: /tmp/x/{agent}.output\nDo NOT Read or tail this file via the shell tool."
        );
        let id = format!("toolu_a{n}");
        let call =
            json!([{"type": "tool_use", "id": id, "name": "Agent", "input": {"description": format!("worker {n}"), "prompt": "p", "run_in_background": true}}]);
        let ans = json!([{"tool_use_id": id, "type": "tool_result", "content": [{"type": "text", "text": text}]}]);
        writeln!(f, "{}", line("assistant", call, &ts)).unwrap();
        writeln!(f, "{}", line("user", ans, &ts)).unwrap();
    }
    // calls of a delivery tool keep their whole input in the walk: weight the answer never copies
    let big = "m".repeat(4000);
    for n in 0..MESSAGES {
        let ts = format!("2026-10-06T13:{:02}:00.000Z", n % 60);
        let call = json!([{"type": "tool_use", "id": format!("toolu_m{n}"), "name": "SendMessage", "input": {"to": "someone", "message": big}}]);
        writeln!(f, "{}", line("assistant", call, &ts)).unwrap();
    }
    f.flush().unwrap();
}

fn allocated_by<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let before = ALLOCATED.load(Relaxed);
    let v = f();
    (v, ALLOCATED.load(Relaxed) - before)
}

#[test]
fn an_answer_from_the_kept_walk_does_not_copy_the_walk() {
    let dir = std::env::temp_dir().join(format!("ah-scan-no-clone-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let tp = dir.join("t.jsonl");
    write_transcript(&tp);
    let path = tp.to_str().unwrap();
    let (tail, o) = (64 * 1024 * 1024u64, Opts { now_ms: NOW, ignore_unanswered_stops: false });

    // the first kept scan builds and keeps the walk; the second serves from it (no appended byte)
    let first = scan_transcript(path, tail, &o).unwrap().unwrap();
    assert_eq!(first.launched.keys().count(), LAUNCHES);
    let (second, hit) = allocated_by(|| scan_transcript(path, tail, &o).unwrap().unwrap());
    assert_eq!(second.launched.keys().count(), LAUNCHES, "the kept answer is the fresh answer");
    let (fresh, built) = allocated_by(|| scan_transcript_uncached(path, tail, &o).unwrap().unwrap());
    assert_eq!(fresh.launched.keys().count(), LAUNCHES);
    drop((first, second, fresh));
    eprintln!("kept hit allocated {hit} B; fresh scan allocated {built} B");

    // the hit owns its answer (the launches), and nothing else the size of the walk: far under what reading the file afresh allocates
    assert!(hit < 6_000_000, "kept hit allocated {hit} B (a fresh scan {built} B): the walk is being copied");
    std::fs::remove_dir_all(&dir).ok();
}
