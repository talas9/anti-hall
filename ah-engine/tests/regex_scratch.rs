//! The measured search scratch of a cached regex: what a search returns is not scratch, and the total can neither grow without bound
//! nor fail to come down. One test binary of its own (it installs the counting allocator the measurement reads).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

mod common;

use ah_engine::defaults;
use ah_engine::memstat::Counting;
use ah_engine::script::recache;
use std::hint::black_box;

#[global_allocator]
static ALLOC: Counting = Counting;

/// The same matches collected into a Vec add no more scratch than a search that only counts them: the result Vec used to be added
/// to the pattern's scratch, so a pattern that matched a lot looked like it held megabytes.
#[test]
fn a_search_result_is_not_counted_as_the_patterns_scratch() {
    let text = "zzresultvec12 ".repeat(6000);
    let collected = recache::get("zzresultvec[0-9]+", "").expect("valid pattern");
    let found: Vec<i64> = collected.searched(|re| re.find_iter(&text).map(|m| m.start() as i64).collect());
    assert_eq!(found.len(), 6000);
    let result_bytes = found.capacity() * std::mem::size_of::<i64>();
    assert!(result_bytes > 32 * 1024, "the result is big enough to show: {result_bytes}");
    assert!(
        collected.scratch_bytes() < result_bytes / 2,
        "{} bytes counted as scratch for a search whose Vec alone is {result_bytes}",
        collected.scratch_bytes()
    );
}

/// However many searches run, the scratch of a pattern stays inside what the compile lets its threads keep (`daemon.workers` caches
/// of `script.regex_dfa_size_limit`), and a search that frees memory (a cache reset) brings it down again.
#[test]
fn the_measured_scratch_is_bounded_and_follows_a_cache_reset_down() {
    let cap = (defaults::num("daemon.workers") * defaults::num("script.regex_dfa_size_limit")) as usize;
    let r = recache::get("zzscratchcap[a-z]+", "").expect("valid pattern");
    for _ in 0..8 {
        r.searched(|re| {
            black_box(Box::leak(vec![1u8; cap / 2 + 1].into_boxed_slice())); // the heap grows by half the cap and more, kept
            re.is_match("zzscratchcapx")
        });
    }
    assert!(r.scratch_bytes() <= cap, "{} over the cap {cap}", r.scratch_bytes());
    assert!(r.scratch_bytes() >= cap / 2, "growth was counted: {}", r.scratch_bytes());
    let before = r.scratch_bytes();
    let held = vec![2u8; cap / 4]; // allocated outside the search, freed inside it: the shape of a cache reset
    r.searched(|re| {
        drop(black_box(held));
        re.is_match("zzscratchcapx")
    });
    assert!(r.scratch_bytes() < before, "a search that freed memory lowers the scratch: {before} -> {}", r.scratch_bytes());
}
