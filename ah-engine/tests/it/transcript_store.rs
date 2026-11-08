//! D: the per-session transcript fact store. One test per budget and limit: the fixed buffer, the horizon, the session and global
//! byte budgets, the session cap, the oversize line, single flight, the restart snapshot, the cold-build permit, and the window
//! cuts that make each old reader's answer reproducible from the facts.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use crate::transcript_support::*;
use ah_engine::transcript::store::{Cfg, Store, Unsure};
use ah_engine::transcript::{Cut, FactKind};
use serde_json::json;
use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

const W: u64 = u64::MAX;

fn cfg() -> Cfg {
    let mut c = Cfg::from_defaults();
    c.wait = Duration::from_millis(500);
    c
}

fn store(c: Cfg) -> Store {
    Store::with_cfg(c, None)
}

fn file_len(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).unwrap().len()
}

/// A line whose size is about `pad` bytes, with a distinct prompt text.
fn prompt_line(i: usize, pad: usize) -> String {
    jsonl(&[user_text(&format!("prompt-{i:05} {}", "x".repeat(pad)))])
}

fn prompts(st: &Store, p: &std::path::Path, w: u64, cut: Cut) -> Vec<String> {
    st.with(p, 0, |v| v.facts(w, cut).filter_map(|f| if let FactKind::Prompt(p) = &f.kind { Some(p.text.clone()) } else { None }).collect()).unwrap()
}

#[test]
fn a_session_yields_its_facts_and_the_keyed_maps() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &jsonl(&session()));
    let st = store(cfg());
    st.with(&f, 0, |v| {
        assert_eq!(v.size(), file_len(&f));
        assert_eq!(v.covered_from(), 0);
        assert_eq!(v.last_prompt(W, Cut::Exact).unwrap().text, "please build the thing");
        assert_eq!(v.last_assistant(W, Cut::Exact).unwrap().text, "All done, tests pass.");
        let uses: Vec<&str> = v.tool_uses(W, Cut::Exact, &[]).iter().map(|u| u.name.as_str()).collect();
        assert_eq!(uses, vec!["TaskCreate", "Bash", "Agent", "TaskUpdate"]);
        assert_eq!(v.tool_uses(W, Cut::Exact, &["Bash"]).len(), 1);
        assert_eq!(v.task_events(W, Cut::Exact).len(), 4);
        assert_eq!(v.notifications(W, Cut::Exact).len(), 3);
        // the create result gave the task its id; the update set its status
        let row = v.task("1").expect("task 1 is in the keyed map");
        assert_eq!((row.subject.as_deref(), row.status.as_deref()), (Some("build"), Some("completed")));
        assert!(v.task("toolu_a").is_none(), "the create waits under the tool-use id only until its result names it");
        // the launch is in the agent map, and the notification ended the agents it names
        assert!(v.agent("toolu_c").unwrap().launched_at.is_some());
        assert!(v.agent("a111111111111111").unwrap().terminal);
        assert!(v.agent("a222222222222222").unwrap().terminal);
    })
    .unwrap();
    let s = st.stats();
    assert_eq!((s.cold_builds, s.sessions), (1, 1));
    assert!(s.bytes > 0);
}

#[test]
fn each_byte_is_parsed_once_and_an_unchanged_file_is_not_read() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &prompt_line(0, 100));
    let st = store(cfg());
    st.with(&f, 0, |_| ()).unwrap();
    let after_cold = st.stats();
    assert_eq!((after_cold.cold_builds, after_cold.refresh_bytes), (1, 0), "a cold build is not an incremental parse");
    st.with(&f, 0, |_| ()).unwrap();
    assert_eq!(st.stats().refresh_bytes, 0, "an unchanged file reads nothing");
    let more: String = (1..=5).map(|i| prompt_line(i, 100)).collect();
    append(&f, &more);
    st.with(&f, 0, |_| ()).unwrap();
    let s = st.stats();
    assert_eq!((s.refresh_bytes, s.appended_bytes, s.cold_builds), (more.len() as u64, more.len() as u64, 1));
    assert_eq!(prompts(&st, &f, W, Cut::Exact).len(), 6);
}

#[test]
fn a_window_is_cut_like_the_old_readers_cut_it() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    let lines: Vec<String> = (0..20).map(|i| prompt_line(i, 40 + i)).collect();
    write(&f, &lines.concat());
    let st = store(cfg());
    let size = file_len(&f);
    // brute force: the lines whose first byte is at/after the window start (Exact), or after the first newline at/after it (DropFirst)
    let mut starts = Vec::new();
    let mut off = 0u64;
    for l in &lines {
        starts.push(off);
        off += l.len() as u64;
    }
    for w in [size, size - 1, size / 2, 300, 1, starts[7] + 1, size - starts[7], size - starts[7] + 1] {
        let start = size.saturating_sub(w);
        let exact: Vec<String> = (0..20).filter(|i| starts[*i] >= start).map(|i| format!("prompt-{i:05}")).collect();
        let drop_first: Vec<String> = (0..20).filter(|i| start == 0 || starts[*i] > start).map(|i| format!("prompt-{i:05}")).collect();
        let got = |c: Cut| prompts(&st, &f, w, c).iter().map(|p| p.split(' ').next().unwrap().to_string()).collect::<Vec<_>>();
        assert_eq!(got(Cut::Exact), exact, "exact, w={w}");
        assert_eq!(got(Cut::DropFirst), drop_first, "drop-first, w={w}");
    }
}

#[test]
fn the_buffer_is_fixed_and_no_reader_holds_more_than_buffer_plus_line() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    // lines far longer than the buffer, a few of them longer than a tenth of the cap
    let big = jsonl(&[user_text(&format!("big {}", "y".repeat(40_000)))]);
    let body: String = (0..30).map(|i| if i % 5 == 0 { big.clone() } else { prompt_line(i, 300) }).collect();
    write(&f, &body);
    let mut c = cfg();
    c.read.buf = 4096;
    c.read.max_line = 64 * 1024;
    let bound = (c.read.buf + c.read.max_line) as u64;
    let st = store(c);
    assert_eq!(prompts(&st, &f, W, Cut::Exact).len(), 30, "lines longer than the buffer are still parsed whole");
    let s = st.stats();
    assert!(s.read_buf_max_bytes >= 4096, "the buffer is counted: {}", s.read_buf_max_bytes);
    assert!(s.read_buf_max_bytes <= bound, "largest reader {} over buffer+line {bound}", s.read_buf_max_bytes);
}

#[test]
fn a_line_over_the_cap_is_skipped_counted_and_makes_its_window_unsure() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    let huge = jsonl(&[user_text(&format!("huge {}", "z".repeat(20_000)))]);
    let first: String = (0..3).map(|i| prompt_line(i, 20)).collect();
    let after: String = (3..6).map(|i| prompt_line(i, 20)).collect();
    write(&f, &format!("{first}{huge}{after}"));
    let mut c = cfg();
    c.read.max_line = 1000;
    c.read.head = 32;
    let bound = (c.read.buf + c.read.max_line) as u64;
    let st = store(c);
    let r = st.with(&f, 0, |v| (v.unsure_in(W, Cut::Exact), v.check(W, Cut::Exact), v.unsure_in(after.len() as u64, Cut::Exact)));
    let (all_unsure, check, after_unsure) = r.unwrap();
    assert!(all_unsure, "the whole file covers the skipped line");
    assert!(matches!(check, Err(Unsure::Partial { .. })));
    assert!(!after_unsure, "a window that starts after it is answered");
    assert_eq!(prompts(&st, &f, W, Cut::Exact).len(), 6, "the skipped line gave no fact");
    let s = st.stats();
    assert_eq!(s.oversize_lines, 1);
    assert!(s.partial >= 1);
    assert!(s.read_buf_max_bytes <= bound, "the skipped line never grew a buffer past the cap: {}", s.read_buf_max_bytes);
}

#[test]
fn facts_older_than_the_horizon_are_dropped_but_the_keyed_maps_remember() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    let head = jsonl(&[
        assistant("m1", &["go"], &[tool_use("toolu_a", "TaskCreate", json!({"subject": "old task"}))]),
        tool_result("toolu_a", "Task #7 created successfully: old task"),
    ]);
    let filler: String = (0..200).map(|i| prompt_line(i, 100)).collect();
    write(&f, &format!("{head}{filler}"));
    let mut c = cfg();
    c.horizon = 8 * 1024;
    let st = store(c.clone());
    let size = file_len(&f);
    st.with(&f, 0, |v| {
        assert_eq!(v.covered_from(), size - 8 * 1024);
        assert!(v.unsure_in(size, Cut::Exact), "a window wider than the horizon is not answered");
        assert!(!v.unsure_in(4 * 1024, Cut::Exact));
        assert!(v.task_events(4 * 1024, Cut::Exact).is_empty(), "the create left the horizon");
    })
    .unwrap();
    // the keyed map was filled while the build read the whole file? No: a cold build reads only the horizon.
    let s = st.stats();
    assert!(s.cold_bytes <= 8 * 1024 + 4096, "a cold build reads the horizon, not the file: {}", s.cold_bytes);
}

#[test]
fn the_keyed_task_map_outlives_the_horizon_when_it_was_seen() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    let mut c = cfg();
    c.horizon = 8 * 1024;
    let st = store(c);
    write(
        &f,
        &jsonl(&[
            assistant("m1", &["go"], &[tool_use("toolu_a", "TaskCreate", json!({"subject": "old task"}))]),
            tool_result("toolu_a", "Task #7 created successfully: old task"),
        ]),
    );
    st.with(&f, 0, |v| assert_eq!(v.task("7").unwrap().subject.as_deref(), Some("old task"))).unwrap();
    let filler: String = (0..200).map(|i| prompt_line(i, 100)).collect();
    append(&f, &filler);
    st.with(&f, 0, |v| {
        assert!(v.covered_from() > 0, "the create left the horizon");
        assert_eq!(v.task("7").unwrap().subject.as_deref(), Some("old task"), "but the keyed map still has it");
        assert!(v.task_events(W, Cut::Exact).is_empty() || v.unsure_in(W, Cut::Exact));
    })
    .unwrap();
}

#[test]
fn over_the_session_budget_the_oldest_facts_go_and_covered_from_rises() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &(0..100).map(|i| prompt_line(i, 500)).collect::<String>());
    let mut c = cfg();
    c.session_budget = 16 * 1024;
    let st = store(c);
    st.with(&f, 0, |v| {
        assert!(v.bytes() <= 16 * 1024, "the session holds {} over its budget", v.bytes());
        assert!(v.covered_from() > 0);
        assert!(v.check(W, Cut::Exact).is_err(), "the whole file is no longer covered");
        let near = file_len(&f) - v.covered_from();
        assert!(v.check(near.saturating_sub(1), Cut::Exact).is_ok(), "the newest part is");
        let last = v.last_prompt(near, Cut::Exact).unwrap();
        assert!(last.text.starts_with("prompt-00099"));
    })
    .unwrap();
    assert!(st.stats().partial >= 1);
}

#[test]
fn a_large_append_stays_within_the_session_budget() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &prompt_line(0, 100));
    let mut c = cfg();
    c.session_budget = 16 * 1024;
    let st = store(c);
    st.with(&f, 0, |_| ()).unwrap();
    // one refresh now has far more new facts than the budget holds (a long gap, or a snapshot load)
    let more: String = (1..=200).map(|i| prompt_line(i, 500)).collect();
    std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(more.as_bytes()).unwrap();
    st.with(&f, 1, |v| {
        assert!(v.bytes() <= 16 * 1024, "the session holds {} over its budget after one big append", v.bytes());
        assert!(v.covered_from() > 0);
    })
    .unwrap();
    assert!(st.stats().bytes <= 16 * 1024);
}

#[test]
fn eviction_during_a_waiting_or_refreshing_request_neither_leaks_bytes_nor_splits_the_flight() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &(0..30).map(|j| prompt_line(j, 400)).collect::<String>());
    let mut c = cfg();
    c.wait = Duration::from_secs(5);
    let st = Arc::new(store(c));
    let (s2, f2) = (st.clone(), f.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        s2.with(&f2, 0, |_| {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(300));
        })
        .unwrap();
    });
    rx.recv().unwrap();
    let (s3, f3) = (st.clone(), f.clone());
    let waiter = std::thread::spawn(move || s3.with(&f3, 1, |_| ()).unwrap());
    std::thread::sleep(Duration::from_millis(80));
    st.shrink(0); // the memory registry's recycle, with one request in flight and one waiting
    holder.join().unwrap();
    waiter.join().unwrap();
    assert_eq!(st.stats().cold_builds, 1, "one flight per path: the eviction never opened a second session");
    st.shrink(0);
    let s = st.stats();
    assert_eq!((s.sessions, s.bytes), (0, 0), "the byte count must follow the map: {s:?}");
}

#[test]
fn ending_a_session_during_its_refresh_releases_its_bytes() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &(0..30).map(|j| prompt_line(j, 400)).collect::<String>());
    let st = Arc::new(store(cfg()));
    let (s2, f2) = (st.clone(), f.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        s2.with(&f2, 0, |_| {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(200));
        })
        .unwrap();
    });
    rx.recv().unwrap();
    st.drop_session(&f);
    holder.join().unwrap();
    let s = st.stats();
    assert_eq!((s.sessions, s.bytes), (0, 0), "{s:?}");
}

#[test]
fn over_the_global_budget_the_least_recently_used_session_is_evicted() {
    let t = Tmp::new("ts");
    let mut c = cfg();
    c.global_budget = 40 * 1024;
    let st = store(c);
    let files: Vec<_> = (0..4)
        .map(|i| {
            let f = t.path(&format!("s{i}.jsonl"));
            write(&f, &(0..30).map(|j| prompt_line(j, 400)).collect::<String>());
            f
        })
        .collect();
    for (i, f) in files.iter().enumerate() {
        st.with(f, i as u64, |_| ()).unwrap();
    }
    let s = st.stats();
    assert!(s.bytes as usize <= 40 * 1024, "all sessions hold {} over the global budget", s.bytes);
    assert!(s.evictions >= 1 && s.sessions < 4, "{s:?}");
    // the newest session is the one kept
    let before = st.stats().cold_builds;
    st.with(&files[3], 9, |_| ()).unwrap();
    assert_eq!(st.stats().cold_builds, before, "the most recently used session was not evicted");
}

#[test]
fn the_session_cap_and_the_idle_ttl_drop_sessions() {
    let t = Tmp::new("ts");
    let mut c = cfg();
    c.max_sessions = 2;
    c.idle_ttl_ms = 1000;
    let st = store(c);
    let files: Vec<_> = (0..3)
        .map(|i| {
            let f = t.path(&format!("s{i}.jsonl"));
            write(&f, &prompt_line(i, 10));
            f
        })
        .collect();
    st.with(&files[0], 1, |_| ()).unwrap();
    st.with(&files[1], 2, |_| ()).unwrap();
    st.with(&files[2], 3, |_| ()).unwrap();
    assert_eq!(st.stats().sessions, 2, "the cap holds");
    st.with(&files[2], 5000, |_| ()).unwrap();
    assert_eq!(st.stats().sessions, 1, "idle sessions went after the TTL");
}

#[test]
fn a_truncated_rotated_or_rewritten_file_is_rebuilt() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &(0..10).map(|i| prompt_line(i, 50)).collect::<String>());
    let st = store(cfg());
    assert_eq!(prompts(&st, &f, W, Cut::Exact).len(), 10);
    // truncated
    write(&f, &(0..3).map(|i| prompt_line(i + 100, 50)).collect::<String>());
    assert_eq!(prompts(&st, &f, W, Cut::Exact).len(), 3);
    // rotated: a different file (inode) at the same path, longer than the old one
    let other = t.path("new.jsonl");
    write(&other, &(0..8).map(|i| prompt_line(i + 200, 50)).collect::<String>());
    std::fs::rename(&other, &f).unwrap();
    let p = prompts(&st, &f, W, Cut::Exact);
    assert_eq!((p.len(), p[0].starts_with("prompt-00200")), (8, true));
    // rewritten in place with the same size: the head fingerprint notices
    let same_len = std::fs::read_to_string(&f).unwrap().replace("prompt-00200", "prompt-99999");
    write(&f, &same_len);
    assert!(prompts(&st, &f, W, Cut::Exact)[0].starts_with("prompt-99999"));
    assert!(st.stats().rebuilds >= 3, "{:?}", st.stats());
}

#[test]
fn an_unterminated_last_line_is_seen_but_not_consumed_or_counted_twice() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    let line = prompt_line(2, 30);
    let (a, b) = line.split_at(line.len() - 10);
    write(&f, &format!("{}{}", prompt_line(1, 30), a));
    let st = store(cfg());
    assert_eq!(prompts(&st, &f, W, Cut::Exact).len(), 1, "half a line does not parse, so it is not a fact yet");
    append(&f, b);
    let mut n = 0;
    st.with(&f, 0, |v| n = v.facts(W, Cut::Exact).count()).unwrap();
    assert_eq!(n, 2);
    assert_eq!(st.stats().refresh_bytes, line.len() as u64, "the completed line was parsed once as a committed line");
    // a final line that is complete JSON but has no newline yet is visible at once
    append(&f, prompt_line(3, 30).trim_end());
    assert_eq!(prompts(&st, &f, W, Cut::Exact).len(), 3);
}

#[test]
fn a_second_request_waits_for_the_refresh_in_flight_then_times_out_instead_of_reading() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &prompt_line(0, 10));
    let mut c = cfg();
    c.wait = Duration::from_millis(60);
    let st = Arc::new(store(c));
    let (s2, f2) = (st.clone(), f.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        s2.with(&f2, 0, |_| {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(400));
        })
        .unwrap();
    });
    rx.recv().unwrap();
    assert_eq!(st.with(&f, 0, |_| ()).unwrap_err(), Unsure::Busy);
    holder.join().unwrap();
    let s = st.stats();
    assert_eq!((s.waits, s.wait_timeouts, s.cold_builds), (1, 1, 1), "the waiter never started a second read");
}

#[test]
fn a_waiter_that_is_not_too_slow_shares_the_result() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &prompt_line(0, 10));
    let mut c = cfg();
    c.wait = Duration::from_secs(5);
    let st = Arc::new(store(c));
    let (s2, f2) = (st.clone(), f.clone());
    let (tx, rx) = std::sync::mpsc::channel();
    let holder = std::thread::spawn(move || {
        s2.with(&f2, 0, |_| {
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(150));
        })
        .unwrap();
    });
    rx.recv().unwrap();
    st.with(&f, 0, |v| assert_eq!(v.facts(W, Cut::Exact).count(), 1)).unwrap();
    holder.join().unwrap();
    let s = st.stats();
    assert_eq!((s.waits, s.wait_timeouts, s.cold_builds), (1, 0, 1));
}

#[test]
fn cold_builds_share_the_permits_and_a_starved_one_answers_unsure() {
    let t = Tmp::new("ts");
    let mut c = cfg();
    c.permits = 1;
    c.wait = Duration::from_millis(80);
    let st = Arc::new(store(c));
    let files: Vec<_> = (0..2)
        .map(|i| {
            let f = t.path(&format!("s{i}.jsonl"));
            write(&f, &prompt_line(i, 10));
            f
        })
        .collect();
    // session 0 holds the only permit's worth of time inside its closure only after its build; so hold a permit through a build that
    // is slow: a large file read in a tiny buffer
    let big = t.path("big.jsonl");
    write(&big, &(0..4000).map(|i| prompt_line(i, 200)).collect::<String>());
    let mut tiny = cfg();
    tiny.read.buf = 16;
    tiny.permits = 1;
    tiny.wait = Duration::from_millis(5);
    let slow = Arc::new(store(tiny));
    let other = t.path("other.jsonl");
    write(&other, &prompt_line(1, 10));
    let (s2, b2) = (slow.clone(), big.clone());
    let builder = std::thread::spawn(move || s2.with(&b2, 0, |_| ()).map(|_| ()));
    let mut starved = false;
    for _ in 0..200 {
        if let Err(Unsure::Busy) = slow.with(&other, 0, |_| ()) {
            starved = true;
            break;
        }
        if builder.is_finished() {
            break;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
    let built = builder.join().unwrap();
    assert!(starved || built.is_ok(), "either the second cold build waited out its wait, or the first finished first");
    assert!(st.with(&files[0], 0, |_| ()).is_ok() && st.with(&files[1], 0, |_| ()).is_ok(), "uncontended cold builds just run");
    assert_eq!(st.stats().cold_builds, 2);
}

#[test]
fn a_restart_snapshot_is_loaded_when_it_still_matches_and_ignored_when_it_does_not() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    let snap = t.path("snap");
    write(&f, &session().iter().map(|e| e.to_string() + "\n").collect::<String>());
    let first = Store::with_cfg(cfg(), Some(snap.clone()));
    first.with(&f, 0, |_| ()).unwrap();
    assert_eq!(first.persist_all(), 1);
    assert_eq!(first.stats().snapshot_writes, 1);
    // appended after the snapshot
    let more = prompt_line(77, 20);
    append(&f, &more);
    let second = Store::with_cfg(cfg(), Some(snap.clone()));
    second
        .with(&f, 0, |v| {
            assert_eq!(v.last_prompt(W, Cut::Exact).unwrap().text.split(' ').next(), Some("prompt-00077"));
            assert_eq!(v.task("1").unwrap().status.as_deref(), Some("completed"), "facts from before the restart are there");
            assert_eq!(v.tool_uses(W, Cut::Exact, &["Bash"]).len(), 1);
        })
        .unwrap();
    let s = second.stats();
    assert_eq!((s.snapshot_loads, s.cold_builds, s.refresh_bytes), (1, 0, more.len() as u64), "only the appended bytes were parsed");
    // the file is rewritten: the stamps no longer match
    write(&f, &(0..3).map(|i| prompt_line(i, 20)).collect::<String>());
    let third = Store::with_cfg(cfg(), Some(snap));
    assert_eq!(prompts(&third, &f, W, Cut::Exact).len(), 3);
    let s = third.stats();
    assert_eq!((s.snapshot_loads, s.snapshot_misses, s.cold_builds), (0, 1, 1));
}

#[test]
fn a_snapshot_over_its_cap_is_not_written() {
    let t = Tmp::new("ts");
    let f = t.path("s.jsonl");
    write(&f, &(0..50).map(|i| prompt_line(i, 300)).collect::<String>());
    let mut c = cfg();
    c.snapshot_max = 1024;
    let st = Store::with_cfg(c, Some(t.path("snap")));
    st.with(&f, 0, |_| ()).unwrap();
    assert_eq!(st.persist_all(), 0);
    assert_eq!(st.stats().snapshot_skipped, 1);
}

#[test]
fn a_missing_or_empty_transcript_is_unsure_not_an_error_of_the_caller() {
    let t = Tmp::new("ts");
    let st = store(cfg());
    assert_eq!(st.with(&t.path("nope.jsonl"), 0, |_| ()).unwrap_err(), Unsure::Missing);
    write(&t.path("empty.jsonl"), "");
    assert_eq!(st.with(&t.path("empty.jsonl"), 0, |_| ()).unwrap_err(), Unsure::Missing);
}
