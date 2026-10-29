//! Cost of a Stop through task-guard on a large, growing transcript (the shape the hardening bar sends): measured per call, and the
//! pieces (kept-lines reconstruction vs. a read of the whole window) timed alone. Own test binary: it measures wall time.
//! `cargo test --release --test task_guard_stop_cost -- --nocapture`
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::unreachable)]

use ah_engine::reqenv::RequestEnv;
use serde_json::json;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

fn line(i: u64) -> String {
    // AH_TGCOST_SPARSE=<n>: only one block of five in n creates a task (a long session holds few tasks among many other lines)
    let sparse: u64 = std::env::var("AH_TGCOST_SPARSE").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let k = if !(i / 5).is_multiple_of(sparse) && matches!(i % 5, 1 | 3) { if i % 5 == 1 { 2 } else { 4 } } else { i % 5 };
    match k {
        0 => format!(
            r#"{{"type":"user","uuid":"u{i}","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"user","content":"prompt number {i} about the engine"}}}}"#,
            i % 60
        ),
        1 => format!(
            r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"t{i}","name":"TaskCreate","input":{{"subject":"task {i}","status":"pending"}}}}]}}}}"#,
            i % 60
        ),
        2 => format!(
            r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"b{i}","name":"Bash","input":{{"command":"cargo test --lib module_{i}"}}}}]}}}}"#,
            i % 60
        ),
        3 => format!(
            r#"{{"type":"user","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t{}","content":"Task #{i} created successfully: task"}}]}}}}"#,
            i % 60,
            i - 2
        ),
        _ => format!(
            r#"{{"type":"assistant","timestamp":"2026-10-07T10:00:{:02}.000Z","message":{{"role":"assistant","content":[{{"type":"text","text":"{}"}}]}}}}"#,
            i % 60,
            "x".repeat(300)
        ),
    }
}

fn grow(path: &Path, from: u64, to: u64) {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for i in from..to {
        writeln!(f, "{}", line(i)).unwrap();
    }
}

fn pct(v: &mut [u128], p: usize) -> u128 {
    v.sort_unstable();
    v[v.len() * p / 100]
}

#[test]
fn stop_on_a_growing_transcript_is_measured() {
    let home = std::env::temp_dir().join(format!("ah-tgcost-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap();
    let tp = real.join("t.jsonl");
    let kb: u64 = std::env::var("AH_TGCOST_KB").ok().and_then(|v| v.parse().ok()).unwrap_or(6144);
    let rows = kb * 1024 / 480;
    grow(&tp, 0, rows);
    let env = RequestEnv::from_pairs(vec![("HOME".to_string(), real.to_string_lossy().into_owned()), ("ANTIHALL_MAX_PARALLEL_DISPATCH".into(), "4".into())]);
    let payload = json!({"cwd": real, "hook_event_name": "Stop", "session_id": "s1", "transcript_path": tp});
    let ts = tp.to_string_lossy().into_owned();
    let (mut stop, mut cached, mut plain) = (Vec::new(), Vec::new(), Vec::new());
    let mut next = rows;
    for _ in 0..40 {
        grow(&tp, next, next + 5);
        next += 5;
        let t = Instant::now();
        let _ = ah_engine::script::run_forced("task-guard", &payload, &json!({}), "Stop", &env);
        stop.push(t.elapsed().as_micros());
        let t = Instant::now();
        let a = ah_engine::script::host_d::transcript_tasks(&ts, "guard", 0.0, 0.0);
        cached.push(t.elapsed().as_micros());
        let t = Instant::now();
        let b = ah_engine::script::host_d::transcript_tasks_uncached(&ts, "guard", 0.0, 0.0);
        plain.push(t.elapsed().as_micros());
        assert_eq!(a, b, "cached and uncached agree");
    }
    {
        use ah_engine::checks::taskstate::{
            Variant,
            backfill::backfill,
            parse::reconstruct,
            tail::{lines_of, read_tail},
        };
        let w = 1_572_864u64;
        let t = Instant::now();
        let (d, trunc) = read_tail(&ts, w).unwrap();
        let t_read = t.elapsed().as_micros();
        let t = Instant::now();
        let lines = lines_of(&d, trunc);
        let t_split = t.elapsed().as_micros();
        let t = Instant::now();
        let mut facts = reconstruct(&lines, Variant::Guard).unwrap();
        let t_rec = t.elapsed().as_micros();
        let t = Instant::now();
        if let Err(e) = backfill(&mut facts, &ts, w) {
            eprintln!("backfill failed: {e:?}");
        }
        let t_back = t.elapsed().as_micros();
        let t = Instant::now();
        let n = d.split('\n').filter(|l| l.contains("\"user\"")).count();
        let t_user = t.elapsed().as_micros();
        let t = Instant::now();
        let ag = ah_engine::script::host_d::agent_scan(&ts, 0.0, false);
        let t_agents = t.elapsed().as_micros();
        println!("TGAGENTS agent_scan={t_agents}us bytes={}", ag.len());
        println!(
            "TGPARTS read={t_read}us split={t_split}us reconstruct={t_rec}us backfill={t_back}us userscan={t_user}us (lines={} user={n} tasks={})",
            lines.len(),
            facts.tasks.len()
        );
    }
    println!(
        "TGCOST kb={kb} stop: p50={}us p95={}us | tasks cached: p50={}us p95={}us | tasks uncached: p50={}us p95={}us",
        pct(&mut stop.clone(), 50),
        pct(&mut stop, 95),
        pct(&mut cached.clone(), 50),
        pct(&mut cached, 95),
        pct(&mut plain.clone(), 50),
        pct(&mut plain, 95)
    );
    std::fs::remove_dir_all(&home).ok();
}
