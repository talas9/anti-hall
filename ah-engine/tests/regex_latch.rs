//! While the process is over its global hard memory limit the cache registry refuses every insert, so every `ah.re.*` call used to
//! compile its pattern again (#684 b). The regex cache keeps patterns up to `mem.regex_latched_bytes` during that time: each is
//! compiled at most once per excursion. Each test is one process (nextest), because the latch and the settings overlay are process-global.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

mod common;

use ah_engine::script::recache;
use ah_engine::{defaults, mem};

/// Settings from a `config.toml` of this test's own (never the user's real files).
fn settings(toml: &str) {
    let dir = std::env::temp_dir().join(format!(
        "ah-latch-{}-{}",
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

/// Put the process over the global hard limit, as the daemon's check does, and say whether the latch is on.
fn latch() -> bool {
    mem::global().tick(defaults::num("mem.global_hard_bytes") + 1, 1_000);
    mem::global().snapshot()["global"]["hard_active"].as_bool().unwrap()
}

/// Call each of three patterns ten times; the programs compiled meanwhile.
fn compiles_under_the_latch() -> u64 {
    assert!(latch(), "the latch must be on for this test to mean anything");
    let before = recache::compiled_totals().0;
    for _ in 0..10 {
        for i in 0..3 {
            recache::get(&format!("zzlatch{i}[a-z]+\\d"), "").expect("valid pattern");
        }
    }
    recache::compiled_totals().0 - before
}

#[test]
fn under_a_held_latch_each_pattern_is_compiled_at_most_once() {
    assert_eq!(compiles_under_the_latch(), 3, "three patterns, thirty calls");
}

#[test]
fn with_the_latch_cap_at_zero_every_call_compiles_again_as_before() {
    settings("[mem]\nregex_latched_bytes = 0\n");
    assert_eq!(defaults::num("mem.regex_latched_bytes"), 0);
    assert_eq!(compiles_under_the_latch(), 30, "no cap: every insert is refused, every call compiles");
}

#[test]
fn a_cap_smaller_than_the_patterns_keeps_the_latch_in_force() {
    settings("[mem]\nregex_latched_bytes = 1000\n");
    assert_eq!(compiles_under_the_latch(), 30, "an entry is heavier than the cap: refused as before");
}
