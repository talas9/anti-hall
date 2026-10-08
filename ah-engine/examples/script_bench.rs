//! D88 spike measurement: per-call latency of a compiled check against its plugin script, in-process, on the same payloads.
//! `cargo run --release --example script_bench -- [calls]`. Prints one JSON line per scenario (microseconds).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a measurement tool: a panic is the report
use ah_engine::checks::{Check, get};
use ah_engine::reqenv::RequestEnv;
use ah_engine::rules::Subject;
use serde_json::{Value, json};
use std::time::Instant;

fn pct(v: &mut [f64], p: f64) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn subject(p: &Value) -> Subject<'_> {
    static NULL: Value = Value::Null;
    Subject {
        event: p.get("hook_event_name").and_then(Value::as_str).unwrap_or("PreToolUse"),
        tool: p.get("tool_name").and_then(Value::as_str),
        cwd: p.get("cwd").and_then(Value::as_str),
        tool_input: p.get("tool_input").unwrap_or(&NULL),
        prompt: p.get("prompt").and_then(Value::as_str),
    }
}

fn main() {
    ah_engine::defaults::init().expect("defaults");
    let n: usize = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(2000);
    let home = std::env::temp_dir().join(format!("ah-script-bench-{}", std::process::id()));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    std::fs::write(home.join(".anti-hall/settings.json"), r#"{"guards":{"shipitGate":true}}"#).unwrap();
    let proj = home.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    let mut plan = String::from("# Plan\n\n## Phases\n\n");
    for i in 0..40 {
        plan.push_str(&format!("### Phase {i}\n- files: src/mod{i}/a.rs, src/mod{i}/b.rs, `lib/x{i}.js`\n- goal: g\n\n"));
    }
    std::fs::write(proj.join("PLAN.md"), plan).unwrap();
    let line = |role: &str, t: &str| json!({"type": role, "message": {"role": role, "content": [{"type": "text", "text": t}]}}).to_string();
    let mut quiet = Vec::new();
    let mut maybe = Vec::new();
    for i in 0..3000 {
        quiet.push(line(if i % 7 == 0 { "user" } else { "assistant" }, &format!("step {i} {}", "lorem ipsum ".repeat(30))));
        maybe.push(line(if i % 7 == 0 { "user" } else { "assistant" }, &format!("step {i} it is safe to proceed {}", "lorem ".repeat(50))));
    }
    let tq = home.join("quiet.jsonl");
    let tm = home.join("maybe.jsonl");
    std::fs::write(&tq, quiet.join("\n")).unwrap();
    std::fs::write(&tm, maybe.join("\n")).unwrap();
    let h = home.to_string_lossy().to_string();
    let env = RequestEnv::from_pairs([("HOME", h.as_str())]);
    let p = proj.to_string_lossy().to_string();
    let scenarios: Vec<(&str, &str, Value)> = vec![
        ("ship-it-guard", "declared-file", json!({"tool_name": "Edit", "cwd": p, "tool_input": {"file_path": format!("{p}/src/mod39/b.rs")}})),
        ("ship-it-guard", "undeclared-advisory", json!({"tool_name": "Edit", "cwd": p, "tool_input": {"file_path": "src/other.rs"}})),
        ("ship-it-guard", "non-code", json!({"tool_name": "Write", "cwd": p, "tool_input": {"file_path": "README.md"}})),
        (
            "compact-declaration-guard",
            "bash-not-work",
            json!({"tool_name": "Bash", "cwd": p, "transcript_path": tq.to_string_lossy(), "tool_input": {"command": "ls -la src"}}),
        ),
        (
            "compact-declaration-guard",
            "work-quiet-turn",
            json!({"tool_name": "Bash", "cwd": p, "transcript_path": tq.to_string_lossy(), "tool_input": {"command": "git commit -am x"}}),
        ),
        (
            "compact-declaration-guard",
            "work-safe-in-turn",
            json!({"tool_name": "Write", "cwd": p, "transcript_path": tm.to_string_lossy(), "tool_input": {"file_path": "a.js"}}),
        ),
    ];
    for (name, label, payload) in &scenarios {
        let check: &dyn Check = get(name).unwrap();
        let s = subject(payload);
        let t = Instant::now();
        let first = ah_engine::script::run_forced(name, payload, &env).unwrap();
        let cold_us = t.elapsed().as_secs_f64() * 1e6;
        let (mut c, mut sc) = (Vec::with_capacity(n), Vec::with_capacity(n));
        for _ in 0..n {
            let t = Instant::now();
            let a = check.run_env(&s, payload, &Value::Null, &env);
            c.push(t.elapsed().as_secs_f64() * 1e6);
            let t = Instant::now();
            let b = ah_engine::script::run_forced(name, payload, &env).unwrap();
            sc.push(t.elapsed().as_secs_f64() * 1e6);
            assert_eq!(a, b, "{name} {label}");
        }
        println!(
            "{}",
            json!({"check": name, "scenario": label, "verdict": format!("{first:?}").chars().take(40).collect::<String>(), "calls": n,
                "compiled_p50_us": pct(&mut c, 0.5), "compiled_p95_us": pct(&mut c, 0.95),
                "script_p50_us": pct(&mut sc, 0.5), "script_p95_us": pct(&mut sc, 0.95), "script_cold_us": cold_us, "p95_budget_us": ah_engine::script::p95_budget_us()})
        );
    }
    std::fs::remove_dir_all(&home).ok();
}
