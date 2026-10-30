//! #436: the agent scan's transcript read must not buffer a whole huge line. One 60 MB `tool_result` line made `read_until` grow a
//! 120 MB buffer and the parse copy it twice more, and overlapping scans of one such transcript passed the daemon's RSS cap.
//! `agent_scan.max_line_bytes` bounds what a read holds. One test binary of its own: the allocator counter and the settings
//! overlay are process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::checks::agent_scan::{Opts, Res, Scan, Unsupported, read_line_bounded, scan_transcript, scan_transcript_uncached};
use serde_json::{Value, json};
use std::alloc::{GlobalAlloc, Layout, System};
use std::io::{BufReader, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

struct Peak;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grow(by: usize) {
    let now = CUR.fetch_add(by, Relaxed) + by;
    PEAK.fetch_max(now, Relaxed);
}

// SAFETY: every call forwards to `System` unchanged; only the live-byte counters are touched besides.
unsafe impl GlobalAlloc for Peak {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CUR.fetch_sub(l.size(), Relaxed);
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        if n >= l.size() {
            grow(n - l.size());
        } else {
            CUR.fetch_sub(l.size() - n, Relaxed);
        }
        // SAFETY: the caller upholds the contract of this method, which is passed on to `System` unchanged.
        unsafe { System.realloc(p, l, n) }
    }
}

#[global_allocator]
static ALLOC: Peak = Peak;

const MIB: usize = 1024 * 1024;
const NOW: f64 = 1_791_300_000_000.0;

/// The most bytes `f` held live beyond what was live when it started.
fn peak_of<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let base = CUR.load(Relaxed);
    PEAK.store(base, Relaxed);
    let v = f();
    (v, PEAK.load(Relaxed).saturating_sub(base))
}

fn use_line(id: &str, name: &str, input: Value, ts: &str) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}, "timestamp": ts})
        .to_string()
}

fn result_line(id: &str, text: &str, ts: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": [{"tool_use_id": id, "type": "tool_result", "content": [{"type": "text", "text": text}]}]}, "timestamp": ts}).to_string()
}

fn launch(n: usize) -> Vec<String> {
    let ts = format!("2026-10-06T12:{:02}:00.000Z", n % 60);
    let agent = format!("a{n:015x}");
    let text = format!(
        "Async agent launched successfully. (internal metadata)\nagentId: {agent} (internal ID)\nThe agent is working in the background.\noutput_file: /tmp/x/{agent}.output\nDo NOT Read or tail this file via the shell tool."
    );
    vec![
        use_line(&format!("toolu_a{n}"), "Agent", json!({"description": format!("worker {n}"), "prompt": "p", "run_in_background": true}), &ts),
        result_line(&format!("toolu_a{n}"), &text, &ts),
    ]
}

fn done(n: usize) -> String {
    let agent = format!("a{n:015x}");
    let text = format!("<task-notification>\n<task-id>{agent}</task-id>\n<status>completed</status>\n</task-notification>");
    json!({"type": "user", "message": {"role": "user", "content": text}, "timestamp": format!("2026-10-06T13:{:02}:00.000Z", n % 60)}).to_string()
}

/// The transcript: two launches, a `big`-byte tool_result line (when `big > 0`), then the first agent's completion. Written line by
/// line, so building it never holds the big line.
fn write_transcript(dir: &Path, name: &str, big: usize) -> PathBuf {
    let p = dir.join(name);
    let mut f = std::io::BufWriter::new(std::fs::File::create(&p).unwrap());
    let w = |f: &mut std::io::BufWriter<std::fs::File>, l: &str| writeln!(f, "{l}").unwrap();
    for l in launch(0).iter().chain(launch(1).iter()) {
        w(&mut f, l);
    }
    if big > 0 {
        let head = result_line("toolu_big", "", "2026-10-06T12:30:00.000Z");
        let cut = head.find("\"text\":\"").unwrap() + "\"text\":\"".len();
        f.write_all(&head.as_bytes()[..cut]).unwrap();
        let chunk = vec![b'x'; MIB];
        for _ in 0..big / MIB {
            f.write_all(&chunk).unwrap();
        }
        writeln!(f, "{}", &head[cut..]).unwrap();
    }
    w(&mut f, &done(0));
    f.flush().unwrap();
    p
}

fn snap(s: &Option<Scan>) -> String {
    let s = s.as_ref().expect("a scan");
    let mut term: Vec<&String> = s.terminal.iter().collect();
    term.sort();
    format!("{:?}\n{:?}\n{:?}", s.launched.iter().collect::<Vec<_>>(), term, s.pending)
}

fn scan_res(p: &Path, kept: bool) -> Res<Option<Scan>> {
    let (path, tail, o) = (p.to_str().unwrap(), 64 * MIB as u64, Opts { now_ms: NOW, ignore_unanswered_stops: false });
    if kept { scan_transcript(path, tail, &o) } else { scan_transcript_uncached(path, tail, &o) }
}

fn scan(p: &Path, kept: bool) -> Option<Scan> {
    scan_res(p, kept).unwrap()
}


/// (oversize lines skipped, scans degraded to unknown) counted since the last call.
fn counts() -> (usize, usize) {
    let c = ah_engine::load::take_counts();
    let n = |metric: &str| c.iter().filter(|(m, l, v)| *m == metric && *l == "reader" && ["scan_window", "scan_kept"].contains(v)).count();
    (n("transcript_line_skipped_oversize"), n("agent_scan_degraded"))
}

#[test]
fn an_oversize_line_is_read_past_not_held_and_the_other_lines_still_count() {
    let dir = std::env::temp_dir().join(format!("ah-scan-line-bound-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // scratch HOME: nothing here may touch the real one
    // SAFETY: the one test that reads the environment, and the only thread running when it is set (it is set first).
    unsafe { std::env::set_var("HOME", &dir) };
    ah_engine::defaults::init().unwrap();
    let plain = write_transcript(&dir, "plain.jsonl", 0);
    let huge = write_transcript(&dir, "huge.jsonl", 20 * MIB);
    let want = snap(&scan(&plain, false));
    // warm every lazy table once, so the measurement below sees the read and not the one-time set-up
    let _ = scan_res(&huge, false);
    let _ = scan(&plain, true);
    ah_engine::load::take_counts();

    let (_, base) = peak_of(|| scan(&plain, false));
    eprintln!("plain peak {base}");
    // bound on (the shipped 4 MiB): the fresh read and the kept walk both stay far under the 20 MB line, and the scan is unknown
    // (the skipped line may have carried a completion), not an answer made as if the line were absent
    for kept in [false, true] {
        let (got, peak) = peak_of(|| scan_res(&huge, kept));
        assert_eq!(got.unwrap_err(), Unsupported, "kept={kept}: an oversize line makes the scan unknown");
        assert!(peak < 8 * MIB, "kept={kept}: peak {peak} B with a 20 MB line; the bound is 4 MiB plus the reader buffer");
        assert_eq!(counts(), (1, 1), "kept={kept}: the oversize line and the degraded scan are each counted once");
    }
    // a second kept scan of the same file serves from the kept walk and is still unknown
    assert_eq!(scan_res(&huge, true).unwrap_err(), Unsupported, "the kept walk remembers the oversize line");
    assert_eq!(counts().1, 1);

    // off (0): the old read, the whole line buffered (the cause of #436)
    ah_engine::defaults::set_overlay(&[("agent_scan.max_line_bytes", json!(0))]);
    let (opts, tail) = (Opts { now_ms: NOW, ignore_unanswered_stops: false }, 64 * MIB as u64);
    let (got, peak) = peak_of(|| scan_transcript_uncached(huge.to_str().unwrap(), tail, &opts));
    // the whole line is parsed too, and the parse may decline it (the check then defers to Node): that is the old behaviour
    eprintln!("off: scan result is_ok={}", got.is_ok());
    assert!(peak >= 20 * MIB, "off: peak {peak} B; the whole line is held again");
    assert_eq!(counts(), (0, 0), "off: nothing is skipped or degraded");
    ah_engine::defaults::set_overlay(&[]);
    a_padded_completion_past_the_bound_makes_the_scan_unknown_and_the_bound_off_still_reads_it(&dir);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn the_reader_holds_a_line_at_the_bound_and_drops_one_byte_past_it() {
    // a 7-byte reader buffer: the line arrives in many chunks, none of which may be gathered past the bound
    let data = b"aaaa\nbbbbb\ncccccc\nddddddd\nlast";
    let mut r = BufReader::with_capacity(7, Cursor::new(&data[..]));
    let mut buf = Vec::new();
    let mut got = Vec::new();
    while let Some(l) = read_line_bounded(&mut r, &mut buf, 5).unwrap() {
        assert!(buf.capacity() <= 5 + 7, "capacity {} past bound + chunk", buf.capacity());
        got.push((String::from_utf8(buf.clone()).unwrap(), l.len, l.newline, l.oversize));
    }
    let s = |t: &str| t.to_string();
    assert_eq!(
        got,
        vec![(s("aaaa"), 5, true, false), (s("bbbbb"), 6, true, false), (s(""), 7, true, true), (s(""), 8, true, true), (s("last"), 4, false, false)]
    );
    // 0 is no bound
    let mut r = BufReader::with_capacity(7, Cursor::new(&data[..]));
    let mut lens = Vec::new();
    while let Some(l) = read_line_bounded(&mut r, &mut buf, 0).unwrap() {
        assert!(!l.oversize);
        lens.push(buf.len());
    }
    assert_eq!(lens, vec![4, 5, 6, 7, 4]);
}

/// Codex's input (#443 review P1): a small successful Agent launch, then a valid user-string completion notification for that agent
/// padded past the bound. The skipped completion must not read as "still running": the scan is unknown, both readers, and counted.
/// With the bound off (`max_line_bytes = 0`) the completion is read and the agent is terminal, as before the bound.
///
/// Run from the first test (the allocator counter, the settings overlay and the metric counts are process-wide).
fn a_padded_completion_past_the_bound_makes_the_scan_unknown_and_the_bound_off_still_reads_it(dir: &Path) {
    let p = dir.join("padded.jsonl");
    let agent = format!("a{:015x}", 0);
    let pad = "p".repeat(5 * MIB);
    let note = format!("<task-notification>\n<task-id>{agent}</task-id>\n<status>completed</status>\n<summary>{pad}</summary>\n</task-notification>");
    let l = json!({"type": "user", "message": {"role": "user", "content": note}, "timestamp": "2026-10-06T13:00:00.000Z"}).to_string();
    assert!(l.len() > 4 * MIB);
    let mut f = std::fs::File::create(&p).unwrap();
    for x in launch(0) {
        writeln!(f, "{x}").unwrap();
    }
    writeln!(f, "{l}").unwrap();
    drop(f);
    counts();
    for kept in [false, true] {
        assert_eq!(scan_res(&p, kept).unwrap_err(), Unsupported, "kept={kept}");
        assert_eq!(counts(), (1, 1), "kept={kept}");
    }
    ah_engine::defaults::set_overlay(&[("agent_scan.max_line_bytes", json!(0))]);
    for kept in [false, true] {
        let s = scan(&p, kept).unwrap();
        assert!(s.terminal.contains(&agent), "kept={kept}: off switch: the completion is read again");
    }
    ah_engine::defaults::set_overlay(&[]);
}
