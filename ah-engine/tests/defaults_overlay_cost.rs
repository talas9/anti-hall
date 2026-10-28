//! #195: the per-call cost the config overlay adds to `defaults::num`. Its own test binary: a timing is meaningless beside other
//! tests' threads, and the overlay is process-global. The thresholds live in `defaults_overlay_cost.toml` beside this file.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report; production crates deny these in Cargo.toml
use ah_engine::defaults;
use serde_json::json;
use std::hint::black_box;
use std::time::Instant;

/// A numeric setting without an `env` override, so the call is the lookup and nothing else.
const KEY: &str = "devswarm_wire.reconcile_min_gap_ms";

fn limit(t: &toml::Table, k: &str) -> u64 {
    t.get(k).and_then(toml::Value::as_integer).unwrap_or_else(|| panic!("{k} missing in defaults_overlay_cost.toml")) as u64
}

fn best_ns(calls: u64, rounds: u64) -> f64 {
    (0..rounds)
        .map(|_| {
            let t = Instant::now();
            for _ in 0..calls {
                black_box(defaults::num(black_box(KEY)));
            }
            t.elapsed().as_nanos() as f64 / calls as f64
        })
        .fold(f64::INFINITY, f64::min)
}

#[test]
fn the_overlay_adds_at_most_the_configured_nanoseconds_per_read() {
    let t: toml::Table = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/defaults_overlay_cost.toml")).unwrap().parse().unwrap();
    let (n, calls, rounds, max_added) = (
        limit(&t, "overlay_entries"),
        limit(&t, "calls_per_round"),
        limit(&t, "rounds"),
        limit(&t, if cfg!(debug_assertions) { "max_added_ns_debug" } else { "max_added_ns_release" }),
    );
    let dir = std::env::temp_dir().join(format!("ah-overlay-cost-{}", std::process::id()));
    // SAFETY: set before the first load and before any other thread exists; the defaults then come from this checkout, never from
    // a snapshot cache in the real state directory
    unsafe { std::env::set_var("AH_ENGINE_DIR", &dir) };
    defaults::init().unwrap();
    // the overlay holds `n` integer settings, one of them the measured key, so the lookup searches a realistic table
    let mut values: Vec<(&str, serde_json::Value)> = defaults::all()
        .iter()
        .filter(|e| e.key != KEY && e.value.as_integer().is_some())
        .take(n as usize - 1)
        .map(|e| (e.key, json!(e.value.as_integer().unwrap())))
        .collect();
    let shipped = defaults::shipped(KEY).as_integer().unwrap();
    values.push((KEY, json!(shipped + 1)));
    let (mut off, mut on) = (f64::INFINITY, f64::INFINITY);
    for _ in 0..2 {
        defaults::set_overlay(&[]);
        assert_eq!(defaults::num(KEY), shipped as u64);
        off = off.min(best_ns(calls, rounds));
        defaults::set_overlay(&values);
        assert_eq!(defaults::num(KEY), shipped as u64 + 1);
        on = on.min(best_ns(calls, rounds));
    }
    eprintln!("defaults::num: {off:.1} ns without the overlay, {on:.1} ns with {n} entries (+{:.1} ns, limit {max_added})", on - off);
    assert!(on - off <= max_added as f64, "the overlay adds {:.1} ns per read, over the {max_added} ns limit", on - off);
}
