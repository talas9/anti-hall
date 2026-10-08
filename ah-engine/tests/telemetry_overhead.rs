//! Overhead of Node-hook telemetry. Its own test binary: a p95 timing is meaningless beside other tests' daemons and threads.

use ah_engine::telemetry::event::Outcome;
use std::time::Instant;

/// The budget for what the Node-hook telemetry adds to one hook call, p95 (a call with three Node hooks: build and queue
/// their events, then one append to the inbox).
const HOOK_CALL_P95_BUDGET_US: u128 = 200;

#[test]
fn recording_a_hook_calls_node_hooks_adds_under_two_tenths_of_a_millisecond_at_p95() {
    use ah_engine::telemetry::emit::{self, NodeRun};
    let dir = std::env::temp_dir().join(format!(
        "ah-tel-overhead-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    // SAFETY: set before any other thread of this test reads it, and no other test in this file reads the state dir
    unsafe { std::env::set_var("AH_ENGINE_DIR", &dir) };
    let one_call = || {
        for id in ["git-guard", "edit-guard", "task-state"] {
            emit::queue(emit::node_run(&NodeRun {
                id,
                event: "PreToolUse",
                outcome: Outcome::Allow,
                micros: 21_000,
                out_bytes: 120,
                err_bytes: 0,
                exit: Some(0),
                fate: "ran",
            }));
        }
        emit::flush();
    };
    for _ in 0..200 {
        one_call(); // warm up: creates the inbox
    }
    let mut us: Vec<u128> = Vec::with_capacity(3000);
    for i in 0..3000 {
        let t = Instant::now();
        one_call();
        us.push(t.elapsed().as_micros());
        if i % 200 == 0 {
            emit::ingest_from(&emit::inbox_path(), |_| {}); // the daemon's drain, outside the timing
        }
    }
    us.sort_unstable();
    let p95 = us[us.len() * 95 / 100];
    println!("node-hook telemetry per hook call: p50 {} us, p95 {p95} us, max {} us", us[us.len() / 2], us[us.len() - 1]);
    // the budget is a release-build property; a debug build only has to run
    if !cfg!(debug_assertions) {
        assert!(p95 < HOOK_CALL_P95_BUDGET_US, "p95 {p95} us is over the {HOOK_CALL_P95_BUDGET_US} us budget");
    }
    std::fs::remove_dir_all(&dir).ok();
}
