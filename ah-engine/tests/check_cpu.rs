//! Per-check and per-event CPU in `status --json`: the `phases.checks.<check>` row carries the check's total CPU and CPU per call, and
//! the `cpu` block lists CPU and calls per hook event and the top checks by CPU (`telemetry.top_checks`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::{daemon, load, telemetry};

fn run_check(t: &telemetry::Telemetry, event: &str, check: &str, cpu_us: u64) {
    t.observe_hook(event, 100);
    t.observe_check(check, "r", &ah_engine::checks::Verdict::Allow, 1, "p");
    load::note_check_cpu(cpu_us);
    daemon::observe_check_cost_in(t, event, check, 10);
}

#[test]
fn status_reports_cpu_per_check_per_event_and_the_top_checks() {
    let t = telemetry::Telemetry::new();
    // 7 checks with growing CPU; the first also runs twice so cpu_us_per_call differs from the total
    for (i, c) in ["c1", "c2", "c3", "c4", "c5", "c6", "c7"].iter().enumerate() {
        run_check(&t, "PreToolUse", c, 1000 * (i as u64 + 1));
    }
    run_check(&t, "Stop", "c1", 3000);
    let phases = daemon::phases_json(&t);
    let c1 = &phases["checks"]["c1"];
    assert_eq!(c1["cpu_us_total"], 4000, "phases {phases}");
    assert_eq!(c1["cpu_us_per_call"], 2000, "two calls of c1: phases {phases}");
    let cpu = daemon::cpu_json(&t);
    assert_eq!(cpu["by_event"]["PreToolUse"]["cpu_us_total"], 28000, "cpu {cpu}");
    assert_eq!(cpu["by_event"]["PreToolUse"]["calls"], 7, "cpu {cpu}");
    assert_eq!(cpu["by_event"]["Stop"]["cpu_us_total"], 3000, "cpu {cpu}");
    let top = cpu["top_checks"].as_array().unwrap();
    assert_eq!(top.len(), 5, "telemetry.top_checks = 5: {cpu}");
    assert_eq!(top[0]["check"], "c7");
    assert_eq!(top[0]["cpu_us_total"], 7000);
    assert_eq!(top[0]["cpu_us_per_call"], 7000);
    assert!(top.windows(2).all(|w| w[0]["cpu_us_total"].as_u64() >= w[1]["cpu_us_total"].as_u64()));
}
