//! Burst allocation-site profile: a synthetic check allocates a burst, exactly one dump is written and it names the allocating function.
//! One test binary of its own: the profiler is process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

mod common;

use ah_engine::burst::{self, Config, Ctx, Outcome};
use ah_engine::memstat::Counting;
use std::hint::black_box;

#[global_allocator]
static ALLOC: Counting = Counting;

#[inline(never)]
fn synthetic_burst_allocator() -> Vec<Vec<u8>> {
    (0..8).map(|i| black_box(vec![i as u8 + 1; 4 * 1024 * 1024])).collect()
}

fn cfg() -> Config {
    Config { on: true, sample_bytes: 256 * 1024, dump_bytes: 16 * 1024 * 1024, window_ms: 60_000, max_per_hour: 1, rate_window_ms: 3_600_000, keep: 2, sites: 128, frames: 24, dump_sites: 16, recent: 4 }
}

#[test]
fn a_burst_writes_one_dump_naming_the_allocating_function() {
    let dir = std::env::temp_dir().join(format!("ah-burst-test-{}", std::process::id()));
    burst::set_dump_dir(Some(dir.clone()));
    burst::configure(&cfg());
    // the first request end opens the window
    assert_eq!(burst::request_end(&Ctx { event: "warmup", busy: 1 }), None);

    burst::begin();
    let held = synthetic_burst_allocator(); // 32 MB inside the window
    burst::note_check("synthetic-check", 32 * 1024 * 1024);
    let out = burst::request_end(&Ctx { event: "PreToolUse", busy: 1 });
    let Some(Outcome::Written(path)) = out else { panic!("expected a dump, got {out:?}") };

    let files: Vec<_> = std::fs::read_dir(&dir).unwrap().collect();
    assert_eq!(files.len(), 1, "exactly one dump file");
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(doc["event"], "PreToolUse");
    assert_eq!(doc["checks"][0]["check"], "synthetic-check");
    let text = doc["sites"].to_string();
    assert!(text.contains("synthetic_burst_allocator"), "the dump names the allocating function: {text}");

    // a second burst in the same hour is suppressed, not written
    burst::begin();
    let held2 = synthetic_burst_allocator(); // the first burst is still held, so the window base includes it
    assert_eq!(burst::request_end(&Ctx { event: "PreToolUse", busy: 1 }), Some(Outcome::Suppressed));
    drop(black_box((held, held2)));
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "still one file");
    std::fs::remove_dir_all(&dir).ok(); // keep: the test's own scratch directory
}

/// Cost of the allocation hook: alloc+free pairs of a QuickJS-sized block with the profile off and on (printed; the bound is loose).
#[test]
fn the_hook_costs_little_per_allocation() {
    use std::time::Instant;
    const N: u64 = 2_000_000;
    let run = || {
        let t = Instant::now();
        for _ in 0..N {
            black_box(vec![0u8; black_box(4096)]);
        }
        t.elapsed().as_nanos() as f64 / N as f64
    };
    burst::configure(&Config { on: false, ..cfg() });
    let off = run();
    burst::configure(&cfg());
    let on = run();
    println!("ns per 4 KiB alloc+free: off {off:.1}, on {on:.1} (sampling every {} KiB)", cfg().sample_bytes / 1024);
    assert!(on < off * 4.0 + 500.0, "off {off} on {on}");
}
