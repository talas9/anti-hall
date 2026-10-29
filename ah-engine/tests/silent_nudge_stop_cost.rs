//! Cost of a Stop through silent-agent-nudge on a large, growing transcript with background-agent launches: wall time and thread CPU
//! per call for the cold call, calls on an unchanged file (cache hit), and calls after an append. Own test binary: it measures time.
//! `cargo test --release --test silent_nudge_stop_cost -- --nocapture`
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// The hardening bar's transcript shape (no agents; a tool use on two lines in five).
fn line_plain(i: u64) -> String {
    let ts = format!("2026-10-07T10:00:{:02}.000Z", i % 60);
    match i % 5 {
        0 => format!(r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":"prompt number {i} about the engine"}}}}"#),
        1 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"task {i}","status":"pending"}}}}]}}}}"#
        ),
        2 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test --lib module_{i}"}}}}]}}}}"#
        ),
        3 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{}","content":"Task #{i} created successfully: task"}}]}}}}"#,
            i - 2
        ),
        _ => {
            format!(r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(300))
        }
    }
}

fn line(i: u64) -> String {
    if std::env::var("AH_SNCOST_SHAPE").is_ok_and(|v| v == "plain") {
        return line_plain(i);
    }
    let ts = format!("2026-10-07T10:{:02}:{:02}.000Z", (i / 60) % 60, i % 60);
    match i % 40 {
        1 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"a{i}","name":"Agent","input":{{"description":"agent {i}","run_in_background":true,"prompt":"do the thing"}}}}]}}}}"#
        ),
        2 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"a{}","content":"Async agent launched successfully.\nagentId: {:016x}\noutput_file: /nonexistent/tasks/{:016x}.output"}}]}}}}"#,
            i - 1,
            i,
            i
        ),
        // most agents finish; the notice names them
        3 if !(i / 40).is_multiple_of(8) => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":"<task-notification><task-id>{:016x}</task-id><status>completed</status></task-notification>"}}}}"#,
            i - 1
        ),
        k if k.is_multiple_of(5) => {
            format!(r#"{{"type":"user","uuid":"u{i}","timestamp":"{ts}","message":{{"role":"user","content":"prompt number {i} about the engine"}}}}"#)
        }
        k if k % 5 == 1 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test --lib module_{i}"}}}}]}}}}"#
        ),
        _ => {
            format!(r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(300))
        }
    }
}

fn grow(path: &Path, from: u64, to: u64) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for i in from..to {
        writeln!(f, "{}", line(i)).unwrap();
    }
}

fn cpu_us() -> u128 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: ts is a valid out-pointer
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as u128 * 1_000_000 + ts.tv_nsec as u128 / 1000
}

fn timed<T>(f: impl FnOnce() -> T) -> (T, u128, u128) {
    let (c, t) = (cpu_us(), Instant::now());
    let r = f();
    (r, t.elapsed().as_micros(), cpu_us() - c)
}

fn med(v: &mut [(u128, u128)]) -> (u128, u128) {
    let mut w: Vec<u128> = v.iter().map(|x| x.0).collect();
    let mut c: Vec<u128> = v.iter().map(|x| x.1).collect();
    w.sort_unstable();
    c.sort_unstable();
    (w[w.len() / 2], c[c.len() / 2])
}

#[test]
fn silent_nudge_stop_is_measured() {
    let home = std::env::temp_dir().join(format!("ah-sncost-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap();
    let tp = real.join("t.jsonl");
    let kb: u64 = std::env::var("AH_SNCOST_KB").ok().and_then(|v| v.parse().ok()).unwrap_or(6144);
    let rows = kb * 1024 / 400;
    grow(&tp, 0, rows);
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), real.to_string_lossy().into_owned()), ("ANTIHALL_MAX_PARALLEL_DISPATCH".into(), "4".into())]);
    let payload = json!({"cwd": real, "hook_event_name": "Stop", "session_id": "s1", "transcript_path": tp});
    let ts = tp.to_string_lossy().into_owned();
    let stop = || ah_engine::script::run_forced("silent-agent-nudge", &payload, &json!({}), "Stop", &env);
    let (_, w, c) = timed(stop);
    println!("SNCOST kb={kb} rows={rows} cold: stop wall={w}us cpu={c}us");
    let mut hit = Vec::new();
    for _ in 0..20 {
        let (_, w, c) = timed(stop);
        hit.push((w, c));
    }
    let (w, c) = med(&mut hit);
    println!("SNCOST hit (unchanged file): stop median wall={w}us cpu={c}us");
    let mut scan_hit = Vec::new();
    for _ in 0..20 {
        let (_, w, c) = timed(|| ah_engine::script::host_d::agent_scan(&ts, 0.0, false));
        scan_hit.push((w, c));
    }
    let (w, c) = med(&mut scan_hit);
    println!("SNCOST hit: agent_scan alone (tail_bytes default) median wall={w}us cpu={c}us");
    let mut scan_hit = Vec::new();
    for _ in 0..20 {
        let (_, w, c) = timed(|| ah_engine::script::host_d::agent_scan(&ts, 67_108_864.0, false));
        scan_hit.push((w, c));
    }
    let (w, c) = med(&mut scan_hit);
    println!("SNCOST hit: agent_scan alone (64MiB window) median wall={w}us cpu={c}us");
    let mut app = Vec::new();
    let mut next = rows;
    for _ in 0..20 {
        grow(&tp, next, next + 5);
        next += 5;
        let (_, w, c) = timed(stop);
        app.push((w, c));
    }
    let (w, c) = med(&mut app);
    println!("SNCOST append(5 lines): stop median wall={w}us cpu={c}us");
    // the windows the daemon's checks scan one transcript with, alternating as the Stop checks do
    let wins = [1_572_864.0, 12_582_912.0, 67_108_864.0];
    let mut per: Vec<Vec<(u128, u128)>> = vec![Vec::new(); 3];
    for _ in 0..20 {
        for (k, win) in wins.iter().enumerate() {
            let (_, w, c) = timed(|| ah_engine::script::host_d::agent_scan(&ts, *win, false));
            per[k].push((w, c));
        }
    }
    for (k, win) in wins.iter().enumerate() {
        let max = per[k].iter().map(|x| x.0).max().unwrap();
        let (w, c) = med(&mut per[k]);
        println!("SNCOST alternating windows: tail={win} median wall={w}us cpu={c}us max wall={max}us");
    }
    let usage = ah_engine::checks::agent_scan::kept_usage();
    println!("SNCOST kept_usage (paths, est bytes, read bytes) = {usage:?}");
    // the three windows of one transcript stay kept side by side (no eviction thrash), and each agrees with a fresh scan
    assert_eq!(usage.0, 3, "one walk per scan window is kept");
    for win in wins {
        let opts = ah_engine::checks::agent_scan::Opts { now_ms: 1.8e12, ignore_unanswered_stops: false };
        let a = ah_engine::checks::agent_scan::scan_transcript(&ts, win as u64, &opts).unwrap().unwrap();
        let b = ah_engine::checks::agent_scan::scan_transcript_uncached(&ts, win as u64, &opts).unwrap().unwrap();
        let ids = |s: &ah_engine::checks::agent_scan::Scan| {
            let mut v: Vec<String> = s.rows().into_iter().map(|r| r.id).collect();
            v.sort();
            let mut t: Vec<&String> = s.terminal.iter().collect();
            t.sort();
            (v, format!("{t:?}"))
        };
        assert_eq!(ids(&a), ids(&b), "cached and uncached agree for window {win}");
    }
    std::fs::remove_dir_all(&home).ok();
}
