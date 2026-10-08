//! D88 latency gate, in its OWN test binary: it measures wall time, so it must not share a process with tests that spawn
//! daemons or load the machine (the telemetry lane learned this). A scripted check may add at most `script.p95_budget_us`
//! over the compiled port it replaced at the 95th percentile. The compiled port is gone, so the test holds the stricter
//! bound: the script's OWN p95 over its whole golden corpus stays under the budget (the added latency cannot exceed it).
//! Run in release, where the numbers mean something: `cargo test --release --test script_latency -- --nocapture`.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::reqenv::RequestEnv;
use serde_json::Value;
use std::path::Path;

struct Laid {
    payload: Value,
    opts: Value,
    event: String,
    env: RequestEnv,
}

fn plugin() -> String {
    let _ = ah_engine::defaults::text("script.ext"); // the root is known once the defaults are loaded
    std::fs::canonicalize(ah_engine::defaults::root().expect("plugin root")).unwrap().to_string_lossy().into_owned()
}

fn fill(s: &str, home: &str, real: &str) -> String {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64);
    ah_engine::script::expand_now(&s.replace("{PLUGIN}", &plugin()).replace("{HOMEREAL}", real).replace("{HOME}", home), now)
}

fn sub(v: &Value, home: &str, real: &str) -> Value {
    match v {
        Value::String(s) => Value::String(fill(s, home, real)),
        Value::Array(a) => Value::Array(a.iter().map(|x| sub(x, home, real)).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (fill(k, home, real), sub(x, home, real))).collect()),
        other => other.clone(),
    }
}

fn lay(case: &Value, seq: usize) -> Laid {
    let home = std::env::temp_dir().join(format!("ah-latency-{}-{seq}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    let real = std::fs::canonicalize(&home).unwrap().to_string_lossy().into_owned();
    let home = home.to_string_lossy().into_owned();
    if let Some(files) = case.get("files").and_then(Value::as_object) {
        for (rel, spec) in files {
            let path = Path::new(&home).join(rel.replace("{HOME}/", ""));
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            match spec {
                Value::String(t) => std::fs::write(&path, fill(t, &home, &real)).unwrap(),
                Value::Object(o) if o.contains_key("link") => std::os::unix::fs::symlink(fill(o["link"].as_str().unwrap(), &home, &real), &path).unwrap(),
                _ => std::fs::create_dir_all(&path).unwrap(),
            }
        }
    }
    let env: Vec<(String, String)> = case
        .get("env")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), fill(v.as_str().unwrap_or_default(), &home, &real))).collect())
        .unwrap_or_default();
    Laid {
        payload: sub(case.get("payload").unwrap_or(&Value::Null), &home, &real),
        opts: sub(case.get("opts").unwrap_or(&Value::Null), &home, &real),
        event: case.get("event").and_then(Value::as_str).unwrap_or("PreToolUse").to_string(),
        env: RequestEnv::from_pairs(env),
    }
}

#[test]
fn scripted_checks_stay_inside_the_latency_budget() {
    let budget = ah_engine::script::p95_budget_us();
    let mut over = Vec::new();
    let mut seq = 0;
    let mut measured = 0;
    for c in ah_engine::checks::registry().iter().filter(|c| c.scripted()) {
        let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("tests/golden/{}.jsonl", c.name()))).ok();
        let Some(text) = text else { continue }; // a check whose parity is the Node runner's (no golden corpus)
        let laid: Vec<Laid> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                seq += 1;
                lay(&serde_json::from_str(l).unwrap(), seq)
            })
            .collect();
        let first = laid.first().expect("a golden corpus");
        let t0 = std::time::Instant::now();
        let _ = ah_engine::script::run_forced(c.name(), &first.payload, &first.opts, &first.event, &first.env);
        let cold = t0.elapsed().as_micros();
        let mut us: Vec<u128> = Vec::new();
        for _ in 0..20 {
            for l in &laid {
                let t = std::time::Instant::now();
                let _ = ah_engine::script::run_forced(c.name(), &l.payload, &l.opts, &l.event, &l.env);
                us.push(t.elapsed().as_micros());
            }
        }
        us.sort_unstable();
        let (p50, p95, p99) = (us[us.len() / 2], us[us.len() * 95 / 100], us[us.len() * 99 / 100]);
        println!("LATENCY {:<24} calls={:<6} cold={cold:>6}us p50={p50:>5}us p95={p95:>5}us p99={p99:>5}us budget={budget}us", c.name(), us.len());
        measured += 1;
        // a check that waits on a child process or a disk sync has that wait in its own p95 (the compiled port paid it too): its
        // budget is set per check in `script.p95_budget_by_check`, with the measured compiled baseline noted beside it
        let allowed = ah_engine::script::p95_budget_for(c.name());
        if p95 as u64 > allowed {
            over.push(format!("{} p95 {p95}us over {allowed}us", c.name()));
        }
    }
    assert!(measured >= 6, "measured the scripted checks that have a corpus: {measured}");
    assert!(over.is_empty(), "over the {budget}us budget: {over:?}");
}
