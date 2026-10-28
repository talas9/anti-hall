//! Load-aware headroom for the wall-clock assertions of the test suite.
//!
//! A test that asserts "this took under N ms" measures the machine as much as the product: on a box shared with other
//! agents (load 35-100 on 16 cores) the same code takes several times longer and the assertion goes red for nothing.
//! `scaled` stretches a bound by one factor, measured once per test process (nextest runs one process per test):
//!
//! - `AH_TEST_TIME_SCALE=<n>` wins when set (CI sets it); a value below 1 is 1.
//! - otherwise the factor is `ceil(load1 / (cores * load_per_core))`, 1 when the machine is quiet.
//! - never above `max`.
//!
//! `load_per_core` and `max` live in `tests/budgets.toml`, `[time_scale]` (local tooling thresholds, not engine settings).
//! On a quiet machine the factor is 1, so a bound is exactly as strict as written; only an upper bound is scaled, never a
//! lower bound (a "waited at least this long" assertion proves the wait happened, and load does not shorten it).
//! A bound that proves the product's own contract on a quiet runner is checked by the `timed` pass (`test.sh`, -j 1).
#![allow(dead_code)] // each test binary uses a subset

use std::sync::OnceLock;
use std::time::Duration;

fn num(t: &toml::Value, key: &str) -> f64 {
    let v = &t["time_scale"][key];
    v.as_float().or_else(|| v.as_integer().map(|i| i as f64)).unwrap_or_else(|| panic!("tests/budgets.toml [time_scale] {key} is missing"))
}

/// The headroom factor for this process (see the module doc).
pub fn time_scale() -> u64 {
    static SCALE: OnceLock<u64> = OnceLock::new();
    *SCALE.get_or_init(|| {
        let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/budgets.toml")).unwrap();
        let cfg: toml::Value = toml::from_str(&text).unwrap();
        let max = num(&cfg, "max").max(1.0) as u64;
        if let Some(n) = std::env::var("AH_TEST_TIME_SCALE").ok().and_then(|v| v.trim().parse::<u64>().ok()) {
            return n.clamp(1, max);
        }
        let mut load = [0f64; 3];
        // SAFETY: `getloadavg` writes at most 3 doubles into the array it is given, which has room for 3.
        let got = unsafe { libc::getloadavg(load.as_mut_ptr(), 1) };
        if got < 1 {
            return 1;
        }
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
        let per_core = num(&cfg, "load_per_core").max(0.01);
        ((load[0] / (cores * per_core)).ceil() as u64).clamp(1, max)
    })
}

/// `d` stretched by the headroom factor: use it on the UPPER bound of a wall-clock assertion.
pub fn scaled(d: Duration) -> Duration {
    d * u32::try_from(time_scale()).unwrap_or(u32::MAX)
}

/// `ms` stretched by the headroom factor.
pub fn scaled_ms(ms: u64) -> u64 {
    ms.saturating_mul(time_scale())
}
