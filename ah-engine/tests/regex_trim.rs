//! A memory shrink drops the lazy-DFA scratch of the cached regexes instead of evicting their programs (#684 a): the scratch is freed
//! on the live heap, the cache stops reporting it, the programs stay (no recompile), and a pattern that cannot weigh less is left alone.
//! One test binary of its own (it installs the counting allocator and flips the process-wide measurement knobs).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

mod common;

use ah_engine::memstat::{self, Counting};
use ah_engine::script::recache;
use ah_engine::{defaults, mem};

#[global_allocator]
static ALLOC: Counting = Counting;

/// A haystack of many different bytes, so the lazy DFA builds many states.
fn haystack(n: usize) -> String {
    let mut x: u32 = 12345;
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
            char::from(b'a' + ((x >> 16) % 26) as u8)
        })
        .collect()
}

fn grow(r: &recache::Entry, text: &str) {
    r.searched(|re| re.find_iter(text).count() > 0);
}

/// The memory shrink the process-wide check runs above `mem.global_soft_bytes`.
fn soft_shrink() {
    mem::global().tick(defaults::num("mem.global_soft_bytes"), 1);
}

/// Measured scratch above the estimate (a search that keeps `bytes` of heap, as a filled lazy DFA would): the shrink drops it from the
/// weight, and the programs stay.
#[test]
fn a_soft_shrink_drops_reported_scratch_and_keeps_the_programs() {
    memstat::configure_measure(true, 1);
    let est = recache::scratch_estimate();
    let pats: Vec<String> = (0..6).map(|i| format!("zztrim{i}[a-z]+\\d")).collect();
    let mut held = Vec::new();
    for p in &pats {
        let r = recache::get(p, "").expect("valid pattern");
        r.searched(|re| {
            std::hint::black_box(Box::leak(vec![1u8; est * 2].into_boxed_slice())); // kept heap, counted as this pattern's scratch
            re.is_match("zztrim1abc9")
        });
        assert!(r.reported_bytes() > est, "{}", r.reported_bytes());
        held.push(r);
    }
    let compiled0 = recache::compiled_totals().0;
    drop(held);
    let (n0, reported0) = recache::usage();
    soft_shrink();
    let (n1, reported1) = recache::usage();
    assert_eq!(n1, n0, "the programs stay: nothing is evicted");
    assert!(reported0 - reported1 >= 6 * est, "each of the 6 patterns stopped reporting its scratch above the estimate: {reported0} -> {reported1}");
    for p in &pats {
        let r = recache::get(p, "").expect("valid pattern");
        assert_eq!(r.reported_bytes(), est, "a trimmed pattern reports the estimate until it is measured again");
        assert_eq!(r.scratch_bytes(), 0);
    }
    assert_eq!(recache::compiled_totals().0, compiled0, "no pattern was compiled again");
}

/// Searches that were not measured pin the weight at the estimate, but the lazy DFA they filled is real heap: the shrink frees it.
#[test]
fn a_soft_shrink_frees_real_scratch_on_the_live_heap() {
    memstat::configure_measure(false, 1);
    let text = haystack(400_000);
    let pats: Vec<String> = (0..6).map(|i| format!("(?-u:[a-z]{{1,7}}q[a-z]{{1,7}}z{i}[a-z]{{2,9}}k[a-z]*[0-9])")).collect();
    let rs: Vec<_> = pats.iter().map(|p| recache::get(p, "r").expect("valid pattern")).collect();
    let grown0 = memstat::heap().live;
    drop(rs);
    for p in &pats {
        let r = recache::get(p, "r").expect("valid pattern");
        grow(&r, &text);
        assert!(r.reported_bytes() >= recache::scratch_estimate());
    }
    let compiled0 = recache::compiled_totals().0;
    let (n0, reported0) = recache::usage();
    let live0 = memstat::heap().live;
    eprintln!("live heap grew {} by the searches", live0.saturating_sub(grown0));
    soft_shrink();
    let (n1, reported1) = recache::usage();
    let live1 = memstat::heap().live;
    eprintln!("live {live0} -> {live1}");
    assert_eq!((n1, reported1), (n0, reported0), "the weight was the estimate before and is after; nothing is evicted");
    assert!(live1 + 32 * 1024 < live0, "the scratch is gone from the live heap: {live0} -> {live1}");
    for p in &pats {
        recache::get(p, "r").expect("valid pattern");
    }
    assert_eq!(recache::compiled_totals().0, compiled0, "no pattern was compiled again");
}

#[test]
fn a_shrink_leaves_alone_a_pattern_that_would_weigh_more_trimmed() {
    memstat::configure_measure(true, 1);
    let est = recache::scratch_estimate();
    let mut held = Vec::new();
    for i in 0..20 {
        let r = recache::get(&format!("zzsmall{i}[a-z]+\\d"), "").expect("valid pattern");
        grow(&r, "abc zzsmall1 abc123 ");
        assert!(r.reported_bytes() < est, "a small search keeps far less than the estimate: {}", r.reported_bytes());
        held.push(r);
    }
    let before = recache::usage();
    soft_shrink();
    assert_eq!(recache::usage(), before, "measured entries below the estimate are not trimmed: the weight does not rise, nothing is evicted");
    for r in &held {
        assert!(r.reported_bytes() < est);
    }
}

fn settings(toml: &str) {
    let dir = std::env::temp_dir().join(format!(
        "ah-trim-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let cfg = dir.join("config.toml");
    std::fs::write(&cfg, toml).unwrap();
    // SAFETY: one test per process, set before any thread reads the environment
    unsafe {
        std::env::set_var("HOME", &dir);
        std::env::set_var("AH_ENGINE_DIR", dir.join("state"));
    }
    defaults::init().unwrap();
    // SAFETY: as above
    unsafe { std::env::set_var(defaults::env_name("config"), &cfg) };
    ah_engine::cfgstore::install_process_overlay();
}

/// `mem.regex_trim_scratch` off: a shrink trims nothing, the old behaviour.
#[test]
fn with_the_switch_off_a_shrink_trims_nothing() {
    settings("[mem]\nregex_trim_scratch = false\n");
    memstat::configure_measure(false, 1);
    let text = haystack(400_000);
    let pat = "(?-u:[a-z]{1,7}q[a-z]{1,7}zoff[a-z]{2,9}k[a-z]*[0-9])";
    drop(recache::get(pat, "r").expect("valid pattern"));
    let live_programs = memstat::heap().live;
    grow(&recache::get(pat, "r").expect("valid pattern"), &text);
    let live0 = memstat::heap().live;
    soft_shrink();
    assert!(memstat::heap().live + 4096 > live0, "nothing was dropped: {live0} -> {}", memstat::heap().live);
    assert!(live0 > live_programs, "the search grew the scratch");
}

/// A hard recycle trims first and clears only when the cache is still over its own hard limit.
#[test]
fn a_recycle_trims_and_keeps_the_programs_while_under_the_hard_limit() {
    memstat::configure_measure(true, 1);
    let est = recache::scratch_estimate();
    for i in 0..4 {
        let r = recache::get(&format!("zzrecycle{i}[a-z]+\\d"), "").expect("valid pattern");
        r.searched(|re| {
            std::hint::black_box(Box::leak(vec![1u8; est * 2].into_boxed_slice()));
            re.is_match("zzrecycle1abc9")
        });
    }
    let (n0, reported0) = recache::usage();
    assert!(reported0 > 4 * est);
    mem::global().tick(defaults::num("mem.global_hard_bytes") + 1, 1_000); // the process hard limit: every holder is recycled
    let (n1, reported1) = recache::usage();
    assert_eq!(n1, n0, "under its own hard limit the cache keeps its programs");
    assert!(reported1 + 4 * est <= reported0, "the scratch left the weight: {reported0} -> {reported1}");
}

/// After a trim, workers that search the patterns again are measured again: the weight is at least the program and what they kept.
#[test]
fn after_a_trim_the_weight_never_under_reports_what_the_workers_keep() {
    memstat::configure_measure(true, 1);
    let est = recache::scratch_estimate();
    let pats: Vec<String> = (0..3).map(|i| format!("zzbound{i}[a-z]+\\d")).collect();
    for p in &pats {
        let r = recache::get(p, "").expect("valid pattern");
        r.searched(|re| {
            std::hint::black_box(Box::leak(vec![1u8; est * 2].into_boxed_slice()));
            re.is_match("zzbound1abc9")
        });
    }
    soft_shrink();
    let workers: Vec<_> = (0..4)
        .map(|_| {
            let pats = pats.clone();
            std::thread::spawn(move || {
                for p in &pats {
                    let r = recache::get(p, "").expect("valid pattern");
                    grow(&r, "zzbound1abc9 zzbound2xyz7 ");
                }
            })
        })
        .collect();
    for w in workers {
        w.join().unwrap();
    }
    let mut kept = 0;
    for p in &pats {
        let r = recache::get(p, "").expect("valid pattern");
        assert!(r.scratch_bytes() > 0, "the workers' searches were measured on the trimmed entry");
        assert!(r.reported_bytes() >= r.scratch_bytes(), "reported {} < measured {}", r.reported_bytes(), r.scratch_bytes());
        kept += r.scratch_bytes();
    }
    assert!(recache::usage().1 >= kept, "the cache reports at least what was measured: {} < {kept}", recache::usage().1);
}
