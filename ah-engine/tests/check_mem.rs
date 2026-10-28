//! Per-check memory telemetry (`diagnostics.check_mem`): a check that allocates 2 MiB in one call shows up in the per-check
//! histograms and in the `phases` block of `status --json`; with the knob off nothing is recorded. One test binary of its own: the
//! knob is process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::checks::{Check, Verdict, run_env_guarded};
use ah_engine::reqenv::RequestEnv;
use ah_engine::rules::Subject;
use ah_engine::{daemon, load, memstat, telemetry};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::hint::black_box;

#[global_allocator]
static ALLOC: memstat::Counting = memstat::Counting;

const TWO_MIB: u64 = 2 * 1024 * 1024;

/// A check that allocates 2 MiB, touches it and frees it again.
struct Hog;

impl Check for Hog {
    fn name(&self) -> &'static str {
        "mem-test-hog"
    }
    fn summary(&self) -> &'static str {
        "test check that allocates 2 MiB"
    }
    fn run(&self, _s: &Subject<'_>, _o: &Value) -> Option<Verdict> {
        let v = vec![7u8; TWO_MIB as usize];
        black_box(&v);
        Some(Verdict::Allow)
    }
}

fn run_hog_and_observe(t: &telemetry::Telemetry) {
    let home = std::env::temp_dir().join(format!("ah-check-mem-{}", std::process::id()));
    let env = RequestEnv::from(BTreeMap::from([("HOME".to_string(), home.display().to_string())]));
    let subject = Subject { event: "PreToolUse", tool: Some("Bash"), cwd: None, tool_input: &Value::Null, prompt: None };
    let v = run_env_guarded(&Hog, &subject, &json!({}), &json!({}), &env);
    assert!(matches!(v, Some(Verdict::Allow)));
    daemon::observe_check_cost_in(t, "PreToolUse", "mem-test-hog", 10);
}

#[test]
fn a_check_that_allocates_two_mib_is_recorded_per_check_and_only_while_the_knob_is_on() {
    // one unmeasured call first: the first call of a process allocates what its lazily built tables and caches keep for the rest of
    // its life (a few hundred bytes), and that is retained by the process, not by the check
    memstat::configure_measure(false, 1);
    run_hog_and_observe(&telemetry::Telemetry::new());
    let t = telemetry::Telemetry::new();
    memstat::configure_measure(true, 1);
    run_hog_and_observe(&t);
    let snap = t.with_metrics(|m| m.snapshot("mem-test-hog"));
    let hist = |name: &str| snap["histograms"].as_array().unwrap().iter().find(|h| h["name"] == name).cloned().unwrap_or_else(|| panic!("no {name} in {snap}"));
    let (peak, alloc) = (hist("check_mem_peak_bytes"), hist("check_mem_alloc_bytes"));
    assert!(peak["max_bytes"].as_u64().unwrap() >= TWO_MIB, "peak {peak}");
    assert!(alloc["max_bytes"].as_u64().unwrap() >= TWO_MIB, "alloc {alloc}");
    // the 2 MiB is freed again: nothing retained is counted
    assert_eq!(t.with_metrics(|m| m.counter("check_mem_retained_bytes", &[("check", "mem-test-hog")])), 0);
    // visible where the dashboard reads the per-check dispatch telemetry
    let phases = daemon::phases_json(&t);
    let row = &phases["checks"]["mem-test-hog"];
    assert!(row["mem_peak"]["max"].as_u64().unwrap() >= TWO_MIB, "status phases {phases}");
    assert!(row["mem_alloc"]["max"].as_u64().unwrap() >= TWO_MIB, "status phases {phases}");

    // knob off: a second check records nothing
    let off = telemetry::Telemetry::new();
    memstat::configure_measure(false, 1);
    run_hog_and_observe(&off);
    let none = off.with_metrics(|m| m.snapshot(""));
    assert!(none["histograms"].as_array().unwrap().iter().all(|h| h["name"] != "check_mem_peak_bytes"), "recorded with the knob off: {none}");
    assert!(load::take_check_mem().is_none());
    memstat::configure_measure(true, 1);
}

/// A check that allocates a little, like the typical built-in (a few small strings).
struct Small;

impl Check for Small {
    fn name(&self) -> &'static str {
        "mem-test-small"
    }
    fn summary(&self) -> &'static str {
        "test check with a small allocation"
    }
    fn run(&self, _s: &Subject<'_>, _o: &Value) -> Option<Verdict> {
        black_box(vec![format!("{}", black_box(42u32)); 8]);
        Some(Verdict::Allow)
    }
}

/// What the measurement adds to one dispatched check: mean ns per `run_env_guarded` call with the knob on and off (printed; the
/// bound is the 5 ms per-call CPU bar divided by a thousand, so only a gross regression fails).
#[test]
fn measuring_a_check_adds_nothing_measurable_to_its_call() {
    let home = std::env::temp_dir().join(format!("ah-check-mem-cost-{}", std::process::id()));
    let env = RequestEnv::from(BTreeMap::from([("HOME".to_string(), home.display().to_string())]));
    let subject = Subject { event: "PreToolUse", tool: Some("Bash"), cwd: None, tool_input: &Value::Null, prompt: None };
    let (payload, opts) = (json!({}), json!({}));
    const N: u32 = 10_000;
    // One timed round of N calls with the knob on or off.
    let round = |on: bool| {
        memstat::configure_measure(on, 1);
        let t = std::time::Instant::now();
        for _ in 0..N {
            black_box(run_env_guarded(&Small, &subject, &payload, &opts, &env));
            black_box(load::take_check_mem());
        }
        t.elapsed()
    };
    // Off and on rounds alternate so a noisy stretch on a shared runner hits both sides; the per-side minimum over 7 rounds drops it.
    let _ = round(true);
    let (mut off, mut on) = (std::time::Duration::MAX, std::time::Duration::MAX);
    for _ in 0..7 {
        off = off.min(round(false));
        on = on.min(round(true));
    }
    let ns = |d: std::time::Duration| d.as_nanos() as f64 / f64::from(N);
    println!("run_env_guarded per call: knob off {:.0} ns, on {:.0} ns, extra {:.0} ns", ns(off), ns(on), ns(on) - ns(off));
    assert!(ns(on) - ns(off) < 5_000.0, "measuring adds {:.0} ns per check", ns(on) - ns(off));
    memstat::configure_measure(true, 1);
}
