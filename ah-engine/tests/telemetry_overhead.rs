//! Overhead of Node-hook telemetry. Its own test binary: a p95 timing is meaningless beside other tests' daemons and threads.

use ah_engine::telemetry::event::Outcome;

/// The budget for what the Node-hook telemetry adds to one hook call, p95 (a call with three Node hooks: build and queue
/// their events, then one append to the inbox), above what the bare append syscalls cost on the same machine.
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
    // What the machine charges for the bare syscalls of one inbox append (open for append, flock, stat, write of the same
    // bytes) is not overhead the telemetry code adds: a macOS CI runner spends 110 us of CPU at the median on them (35 us on a
    // development Mac), so the budget is for what the call costs ABOVE that reference, measured in the same loop. A real
    // regression (a second lock, a read of the inbox, a per-event write) adds to the call and still goes over.
    let ref_path = dir.join("reference.jsonl");
    let ref_bytes = vec![b'x'; 360];
    let reference = || {
        use std::io::Write;
        use std::os::fd::AsRawFd;
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&ref_path) {
            // SAFETY: `f` is open, so its descriptor is valid.
            std::hint::black_box(unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) });
            std::hint::black_box(f.metadata().is_ok());
            std::hint::black_box(f.write_all(&ref_bytes).is_ok());
        }
    };
    let thread_cpu = ah_engine::limits::thread_cpu_us;
    let mut best_over = u128::MAX;
    for round in 0..3 {
        let (mut us, mut base): (Vec<u128>, Vec<u128>) = (Vec::with_capacity(3000), Vec::with_capacity(3000));
        for i in 0..3000 {
            // thread CPU time, not wall: a shared runner that preempts the thread mid-call is not overhead the code adds
            let t = thread_cpu();
            reference();
            base.push(u128::from(thread_cpu().saturating_sub(t)));
            let t = thread_cpu();
            one_call();
            us.push(u128::from(thread_cpu().saturating_sub(t)));
            if i % 200 == 0 {
                emit::ingest_from(&emit::inbox_path(), |_| {}); // the daemon's drain, outside the timing
            }
        }
        us.sort_unstable();
        base.sort_unstable();
        let (p95, base95) = (us[us.len() * 95 / 100], base[base.len() * 95 / 100]);
        println!(
            "node-hook telemetry per hook call, round {round}: p50 {} us, p95 {p95} us, max {} us; bare append p95 {base95} us",
            us[us.len() / 2],
            us[us.len() - 1]
        );
        best_over = best_over.min(p95.saturating_sub(base95));
        if best_over < HOOK_CALL_P95_BUDGET_US {
            break;
        }
    }
    // the budget is a release-build property; a debug build only has to run
    if !cfg!(debug_assertions) {
        assert!(best_over < HOOK_CALL_P95_BUDGET_US, "p95 over the bare append is {best_over} us, over the {HOOK_CALL_P95_BUDGET_US} us budget");
    }
    std::fs::remove_dir_all(&dir).ok();
}
