//! The knobs of `mem::measure` (`diagnostics.check_mem`, `diagnostics.check_mem_sample_every`) and the cost of the per-thread
//! counters. One test binary of its own: the knobs are process-wide, so no other test may run beside them.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

mod common;

use ah_engine::mem::measure;
use ah_engine::memstat::{self, Counting};
use std::alloc::{GlobalAlloc, Layout};
use std::hint::black_box;
use std::time::{Duration, Instant};

#[global_allocator]
static ALLOC: Counting = Counting;

#[test]
fn the_knobs_switch_the_measurement_off_and_thin_it_out() {
    memstat::configure_measure(false, 1);
    assert!(measure(|| black_box(vec![1u8; 4096])).1.is_none(), "check_mem = false measures nothing");
    memstat::configure_measure(true, 3);
    let shown: Vec<bool> = (0..9).map(|_| measure(|| black_box(vec![1u8; 4096])).1.is_some()).collect();
    assert_eq!(shown.iter().filter(|s| **s).count(), 3, "every 3rd call is measured: {shown:?}");
    memstat::configure_measure(true, 1);
    assert!(measure(|| black_box(vec![1u8; 4096])).1.is_some());
    memstat::configure_measure(true, 0);
    assert!(measure(|| black_box(vec![1u8; 4096])).1.is_some(), "0 is treated as 1 (every call)");
}

/// Cost of the per-thread counters: N alloc+free pairs through `Counting` with the counters on and off. Prints ns per
/// alloc+free pair and the CPU share at the live allocation rate (1.553e9 allocations over 8164 s = 190k per second).
#[test]
fn the_counters_cost_under_a_tenth_of_a_percent_of_a_core_at_the_live_allocation_rate() {
    const N: u64 = 1_000_000;
    const LIVE_ALLOCS_PER_S: f64 = 1.553e9 / 8164.0;
    let a = Counting;
    let l = Layout::from_size_align(48, 8).unwrap();
    let run = || {
        let t = Instant::now();
        for _ in 0..N {
            // SAFETY: `l` has a non-zero size; the pointer is freed with the same layout straight away.
            unsafe {
                let p = a.alloc(l);
                black_box(p);
                a.dealloc(p, l);
            }
        }
        t.elapsed()
    };
    // Off and on are sampled in ALTERNATING rounds and each keeps its minimum: a slow patch of the machine (a noisy
    // neighbour, a frequency step, parallel test processes) then hits both sides alike. Measuring all the "off" runs and
    // then all the "on" runs let a drift between the two phases land entirely in the difference: the macOS full-tier run
    // 41130018901 read 13.73 vs 29.90 ns (extra 16.17 > 15) while the same test passed on the earlier macOS runs.
    const ROUNDS: usize = 25;
    let mut best_off = Duration::MAX;
    let mut best_on = Duration::MAX;
    memstat::configure_measure(true, 1);
    let _ = run(); // warm up the allocator
    for _ in 0..ROUNDS {
        memstat::configure_measure(false, 1);
        best_off = best_off.min(run());
        memstat::configure_measure(true, 1);
        best_on = best_on.min(run());
    }
    let (off, on) = (best_off, best_on);
    let ns = |d: Duration| d.as_nanos() as f64 / N as f64;
    let extra = (ns(on) - ns(off)).max(0.0);
    let share = extra * LIVE_ALLOCS_PER_S / 1e9 * 100.0;
    println!("counters off {:.2} ns/pair, on {:.2} ns/pair, extra {extra:.2} ns -> {share:.4} % of a core at {LIVE_ALLOCS_PER_S:.0} allocs/s", ns(off), ns(on));
    let limit = common::scaled(Duration::from_nanos(5)).as_nanos() as f64; // 0.1 % of a core at 190k allocs/s is 5.26 ns
    // only an optimised build says anything about the live cost; a debug build does not inline the thread-local accessors
    assert!(cfg!(debug_assertions) || extra <= limit, "extra {extra:.2} ns per alloc+free exceeds {limit} ns");
    memstat::configure_measure(true, 1);
}
