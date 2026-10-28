//! Per-check THREAD CPU of the PreToolUse(Bash) scripted checks on a replay sample, plus a verdict dump for before/after diffs.
//! `cargo run --release --example bash_cpu -- <sample.ndjson> <verdicts-out.txt> [rounds]`.
//! The sample is the replay corpus format (one JSON object per line: `ev`, `payload`); only PreToolUse/Bash rows are used.
//! CPU is the calling thread's CLOCK_THREAD_CPUTIME_ID (not wall time); child processes (git) are reported separately from
//! RUSAGE_CHILDREN. Runs against a scratch HOME, never the real one.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a measurement tool: a panic is the report
use ah_engine::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::io::Write;

const CHECKS: [&str; 4] = ["git", "command", "coordinator-work-guard", "compact-declaration-guard"];

fn thread_us() -> f64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `ts` is a valid out pointer for the duration of the call.
    unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) };
    ts.tv_sec as f64 * 1e6 + ts.tv_nsec as f64 / 1e3
}

fn children_us() -> f64 {
    // SAFETY: a zeroed rusage is a valid out value for getrusage.
    let mut r: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: `r` is a valid out pointer.
    unsafe { libc::getrusage(libc::RUSAGE_CHILDREN, &mut r) };
    (r.ru_utime.tv_sec as f64 + r.ru_stime.tv_sec as f64) * 1e6 + r.ru_utime.tv_usec as f64 + r.ru_stime.tv_usec as f64
}

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn main() {
    ah_engine::defaults::init().expect("defaults");
    let args: Vec<String> = std::env::args().collect();
    let sample = args.get(1).expect("sample.ndjson");
    let out = args.get(2).expect("verdicts-out.txt");
    let rounds: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(1);
    let payloads: Vec<Value> = std::fs::read_to_string(sample)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|d| d["ev"] == "PreToolUse" && d["payload"]["tool_name"] == "Bash")
        .enumerate()
        .map(|(i, d)| {
            // one session per call: the coordinator window of a shared id would fill up and turn the replay into a block storm
            let mut p = d["payload"].clone();
            p["session_id"] = json!(format!("bashcpu-{i}"));
            p
        })
        .collect();
    let base = std::env::var("AH_BENCH_BASE").map_or_else(|_| std::env::temp_dir(), std::path::PathBuf::from);
    let home = base.join(format!("ah-bash-cpu-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let h = home.to_string_lossy().to_string();
    let root = std::env::var("AH_ENGINE_PLUGIN_ROOT").expect("AH_ENGINE_PLUGIN_ROOT");
    let env = RequestEnv::from_pairs([("HOME", h.as_str()), ("CLAUDE_CODE_ENTRYPOINT", "cli"), ("AH_ENGINE_PLUGIN_ROOT", root.as_str())]);
    let mut dump = std::fs::File::create(out).unwrap();
    // one warm-up pass per check so the first-call load/compile is not in the numbers
    for name in CHECKS {
        for p in payloads.iter().take(5) {
            let _ = ah_engine::script::run_forced(name, p, &Value::Null, "PreToolUse", &env);
        }
    }
    let only = std::env::var("AH_CHECKS").unwrap_or_default();
    for name in CHECKS.iter().filter(|n| only.is_empty() || only.split(',').any(|o| o == **n)) {
        let name = *name;
        let (mut cpu, mut kids, mut main_cpu) = (Vec::new(), 0.0, Vec::new());
        for round in 0..rounds {
            for (i, p) in payloads.iter().enumerate() {
                let (k0, t0) = (children_us(), thread_us());
                let v = ah_engine::script::run_forced(name, p, &Value::Null, "PreToolUse", &env);
                let d = thread_us() - t0;
                cpu.push(d);
                if p.get("agent_id").is_none_or(Value::is_null) {
                    main_cpu.push(d);
                }
                kids += children_us() - k0;
                if round == 0 {
                    writeln!(dump, "{name}\t{i}\t{v:?}").unwrap();
                }
            }
        }
        let n = cpu.len() as f64;
        let total: f64 = cpu.iter().sum();
        println!(
            "{}",
            json!({"check": name, "calls": cpu.len(), "thread_cpu_mean_us": (total / n).round(), "p50_us": pct(&mut cpu, 0.5).round(),
                "p95_us": pct(&mut cpu, 0.95).round(), "child_cpu_mean_us": (kids / n).round(),
                "main_calls": main_cpu.len(), "main_mean_us": (main_cpu.iter().sum::<f64>() / main_cpu.len().max(1) as f64).round()})
        );
    }
    if std::env::var("KEEP_HOME").is_ok() {
        eprintln!("home {}", home.display());
    } else {
        std::fs::remove_dir_all(&home).ok();
    }
}
