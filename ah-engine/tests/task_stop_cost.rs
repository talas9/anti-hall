//! Cost of the task-state checks of one Stop on a large transcript: wall time, process CPU and scanned bytes per check, in Stop
//! order, cold (first request), on an unchanged file, and after an append. Own test binary: it measures time.
//! `cargo test --release --test task_stop_cost -- --nocapture`
//! Knobs: AH_TSCOST_MB (transcript size, default 200), AH_TSCOST_ROOT (scratch dir; the HOME is made under it), AH_TSCOST_RUNS.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

/// A transcript row shaped like a long coordinator session: prompts, big tool results, background-agent launches, task calls.
fn line(i: u64) -> String {
    let ts = format!("2026-10-07T{:02}:{:02}:{:02}.000Z", (i / 3600) % 24, (i / 60) % 60, i % 60);
    // AH_TSCOST_SHAPE=old: tasks are created only at the start of the session; the tail only updates them
    let old = std::env::var("AH_TSCOST_SHAPE").is_ok_and(|v| v == "old");
    let k = if old && i >= 5000 && matches!(i % 50, 1 | 2) { 6 } else { i % 50 };
    match k {
        0 => format!(r#"{{"type":"user","uuid":"u{i}","timestamp":"{ts}","message":{{"role":"user","content":"prompt number {i} about the engine"}}}}"#),
        1 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"task {i}","description":"d","status":"pending"}}}}]}}}}"#
        ),
        2 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{}","content":"Task #{} created successfully: task {}"}}]}}}}"#,
            i - 1,
            i / 50 + 1,
            i - 1
        ),
        3 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"u{i}","name":"TaskUpdate","input":{{"taskId":"{}","status":"in_progress","owner":"w{}"}}}}]}}}}"#,
            (i / 50) % 100 + 1,
            i % 7
        ),
        4 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"a{i}","name":"Agent","input":{{"description":"agent {i}","run_in_background":true,"prompt":"do the thing"}}}}]}}}}"#
        ),
        5 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"a{}","content":"Async agent launched successfully.\nagentId: {:016x}\noutput_file: /nonexistent/tasks/{:016x}.output"}}]}}}}"#,
            i - 1,
            i,
            i
        ),
        k if k % 3 == 0 => format!(
            r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test --lib module_{i}"}}}}]}}}}"#
        ),
        k if k % 3 == 1 => format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"b{}","content":"{}"}}]}}}}"#,
            i - 1,
            "output line of a test run, padded; ".repeat(60)
        ),
        _ => {
            format!(r#"{{"type":"assistant","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(600))
        }
    }
}

fn grow(path: &Path, from: u64, to: u64) {
    let mut f = std::io::BufWriter::new(std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap());
    for i in from..to {
        writeln!(f, "{}", line(i)).unwrap();
    }
}

fn proc_cpu_us() -> u128 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: ts is a valid out-pointer
    unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut ts) };
    ts.tv_sec as u128 * 1_000_000 + ts.tv_nsec as u128 / 1000
}

#[derive(Clone, Copy, Default)]
struct S {
    wall: u128,
    cpu: u128,
}

fn pct(v: &mut [u128], p: usize) -> u128 {
    v.sort_unstable();
    v[((v.len() - 1) * p) / 100]
}

#[test]
fn task_stop_cost_is_measured() {
    let root = std::env::var("AH_TSCOST_ROOT").expect("AH_TSCOST_ROOT: a scratch dir");
    let root = std::fs::canonicalize(&root).unwrap();
    // AH_TSCOST_STORE=0: the session has no store of its own (a named task list), so the guards read the transcript
    let n_store = if std::env::var("AH_TSCOST_STORE").is_ok_and(|v| v == "0") { 0 } else { 25 };
    let home = root.join(format!("home-{n_store}"));
    std::fs::create_dir_all(&home).unwrap();
    let real_home = std::env::var("HOME").unwrap_or_default();
    assert!(
        !real_home.is_empty() && !home.starts_with(&real_home) || home.starts_with("/private/tmp") || home.starts_with("/tmp"),
        "scratch must not be the real HOME"
    );
    // a store of 25 tasks under the session id, like a live list
    let sid = "tscost-session";
    let store = home.join(".claude/tasks").join(sid);
    std::fs::create_dir_all(&store).unwrap();
    for n in 1..=n_store {
        let st = if n % 3 == 0 { "completed" } else { "pending" };
        std::fs::write(store.join(format!("{n}.json")), format!(r#"{{"id":"{n}","subject":"task {n}","status":"{st}","description":"d"}}"#)).unwrap();
    }
    let mb: u64 = std::env::var("AH_TSCOST_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(200);
    let shape = std::env::var("AH_TSCOST_SHAPE").unwrap_or_else(|_| "plain".into());
    let tp = root.join(format!("t-{shape}.jsonl"));
    if !tp.exists() || std::fs::metadata(&tp).unwrap().len() < mb * 1024 * 1024 {
        let mut i = 0u64;
        while std::fs::metadata(&tp).map(|m| m.len()).unwrap_or(0) < mb * 1024 * 1024 {
            grow(&tp, i, i + 20_000);
            i += 20_000;
        }
    }
    let rows = std::fs::read_to_string(&tp).map(|_| 0).unwrap_or(0);
    let _ = rows;
    let size = std::fs::metadata(&tp).unwrap().len();
    let mut next = size / 1100;
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), home.to_string_lossy().into_owned()), ("ANTIHALL_MAX_PARALLEL_DISPATCH".into(), "4".into())]);
    let payload = json!({"cwd": home, "hook_event_name": "Stop", "session_id": sid, "transcript_path": tp});
    let checks = ["task-guard", "task-pair-guard", "tasklist-guard", "coordinator-work-guard", "devswarm-parent-inbox"];
    let runs: usize = std::env::var("AH_TSCOST_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(15);
    println!("TSCOST transcript {} MB, home {}", size / 1024 / 1024, home.display());

    let one = |name: &str| -> (S, u64, bool) {
        let _ = ah_engine::load::take_scan();
        let (c, t) = (proc_cpu_us(), Instant::now());
        let r = ah_engine::script::run_forced(name, &payload, &json!({}), "Stop", &env);
        let s = S { wall: t.elapsed().as_micros(), cpu: proc_cpu_us() - c };
        (s, ah_engine::load::take_scan(), r.is_some())
    };
    let phases: [(&str, bool); 3] = [("cold", false), ("unchanged", false), ("append3", true)];
    let mut totals: Vec<Vec<u128>> = vec![Vec::new(); 3];
    for (pi, (phase, appends)) in phases.iter().enumerate() {
        let n = if pi == 0 { 1 } else { runs };
        let mut per: Vec<Vec<(S, u64)>> = vec![Vec::new(); checks.len()];
        for _ in 0..n {
            if *appends {
                grow(&tp, next, next + 3);
                next += 3;
            }
            let mut tot = 0;
            for (ci, c) in checks.iter().enumerate() {
                let (s, scan, found) = one(c);
                assert!(found, "no script for {c}");
                tot += s.wall;
                per[ci].push((s, scan));
            }
            totals[pi].push(tot);
        }
        for (ci, c) in checks.iter().enumerate() {
            let mut w: Vec<u128> = per[ci].iter().map(|x| x.0.wall).collect();
            let mut cp: Vec<u128> = per[ci].iter().map(|x| x.0.cpu).collect();
            let sc = per[ci].iter().map(|x| x.1).max().unwrap_or(0);
            println!(
                "TSCOST {phase:<9} {c:<24} wall p50={:>7}us p95={:>7}us  cpu p50={:>7}us  scan_bytes(max)={sc}",
                pct(&mut w, 50),
                pct(&mut w, 95),
                pct(&mut cp, 50)
            );
        }
        println!("TSCOST {phase:<9} SUM of the 5 checks wall p50={}us p95={}us", pct(&mut totals[pi], 50), pct(&mut totals[pi], 95));
    }
}
