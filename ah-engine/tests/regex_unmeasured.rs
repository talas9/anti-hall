//! A cached regex whose searches are not all measured keeps weighing at least the scratch estimate; one whose searches are all measured
//! weighs what was measured. One test binary of its own (it installs the counting allocator and flips the process-wide measurement knobs).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

mod common;

use ah_engine::memstat::{self, Counting};
use ah_engine::script::recache;

#[global_allocator]
static ALLOC: Counting = Counting;

fn search(r: &recache::Entry) {
    r.searched(|re| re.is_match(&"abc123 zzunmeasured12345 ".repeat(50)));
}

#[test]
fn the_estimate_stays_until_every_search_was_measured_and_returns_with_the_first_unmeasured_one() {
    let est = recache::scratch_estimate();
    assert!(est > 0);
    // measured branch: the counting allocator is installed here, every search is sampled
    memstat::configure_measure(true, 1);
    let r = recache::get("zzunmeasured[a-z]{3}\\d+", "").expect("valid pattern");
    assert!(r.reported_bytes() >= est, "a pattern not searched yet reports the estimate: {}", r.reported_bytes());
    let (_, m0, _) = recache::search_totals();
    search(&r);
    search(&r);
    let (_, m1, _) = recache::search_totals();
    assert_eq!(m1 - m0, 2, "both searches were measured (the counting allocator is installed)");
    assert_eq!(r.reported_bytes(), r.scratch_bytes(), "every search measured: the entry reports the measurement");
    assert!(r.reported_bytes() < est, "a small search keeps far less than the typical-use estimate: {} vs {est}", r.reported_bytes());
    // an unmeasured search (knob off) pins the entry at the estimate from then on, also once measuring is back on
    memstat::configure_measure(false, 1);
    search(&r);
    assert!(r.reported_bytes() >= est, "off: at least the estimate, got {}", r.reported_bytes());
    memstat::configure_measure(true, 1);
    search(&r);
    assert!(r.reported_bytes() >= est, "measured again, but the entry stays pinned: {}", r.reported_bytes());
    assert!(recache::usage().1 >= est, "the memory snapshot counts the scratch the cache reports: {}", recache::usage().1);
    // sampled out: every 1000th call measures, so the next search is not measured
    let r2 = recache::get("zzunmeasuredb[a-z]{3}\\d+", "").expect("valid pattern");
    memstat::configure_measure(true, 1_000_000);
    search(&r2);
    search(&r2);
    assert!(r2.reported_bytes() >= est, "sampled out: at least the estimate, got {}", r2.reported_bytes());
    memstat::configure_measure(true, 1);
}

/// Slot 0 of the sample counter measures, so a throwaway `mem::measure` takes it and the pattern's FIRST search lands on a sampled-out slot:
/// the entry has no measurement at all and must weigh the estimate, not 0.
#[test]
fn a_first_search_that_is_sampled_out_weighs_the_estimate() {
    let est = recache::scratch_estimate();
    memstat::configure_measure(true, 1_000_000);
    let _ = ah_engine::mem::measure(|| ()); // sample slot 0
    let r = recache::get("zzfirstunmeasured[a-z]{3}\\d+", "").expect("valid pattern");
    let (_, m0, _) = recache::search_totals();
    search(&r);
    let (_, m1, _) = recache::search_totals();
    assert_eq!(m1, m0, "the first search was not measured");
    assert!(r.reported_bytes() >= est, "an unmeasured first search weighs at least the estimate, got {}", r.reported_bytes());
}

/// The estimate follows a settings reload: the daemon refreshes it with the other per-call memory knobs, and entries read the one value.
#[test]
fn the_estimate_is_refreshed_with_the_memory_knobs() {
    let r = recache::get("zzrefreshed[a-z]{3}\\d+", "").expect("valid pattern");
    assert_eq!(r.reported_bytes(), recache::scratch_estimate());
    memstat::configure_measure_from_defaults(); // what a reload runs
    assert_eq!(r.reported_bytes(), recache::scratch_estimate(), "still the estimate after the refresh");
}
