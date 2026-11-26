//! #969: load-aware guard deadlines, std and libc only. One file, two crates: ah-engine (src/loadscale.rs) and ah-launcher
//! (src/loadscale.rs) carry byte-identical copies (a test in ah-engine holds them equal), so the daemon's cut, the client's wait and
//! the launcher's watchdog scale by the same factor.
//!
//! Under load a guard check needs more wall time, not a hold: the hard ceiling of a request (`daemon.request_hard_ms`) and the
//! late-reply wait (`client.slow_fallback_max_ms`) are both multiplied by the 1-minute load average per core, clamped to
//! [1, max] and rounded down to a step (so two processes that sample a moment apart agree). The fail-fast wait
//! (`client.deadline_ms`) is never scaled. All numbers come from the caller's config; nothing here is a tunable.

/// The 1-minute load average per core (1.0 = every core busy), `None` when the system does not report it. Tests read a
/// thread-local value instead (none set = no load), so a loaded test machine changes no deadline.
pub fn per_core() -> Option<f64> {
    #[cfg(test)]
    {
        TEST_LOAD.with(std::cell::Cell::get)
    }
    #[cfg(not(test))]
    {
        let mut load = [0f64; 1];
        // SAFETY: getloadavg fills at most the number of doubles asked for (1), and the array holds that many.
        let got = unsafe { libc::getloadavg(load.as_mut_ptr(), 1) };
        let cores = std::thread::available_parallelism().map_or(1, std::num::NonZero::get) as f64;
        (got >= 1).then(|| load[0] / cores)
    }
}

#[cfg(test)]
thread_local! {
    static TEST_LOAD: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
}

/// Tests only: the load per core [`per_core`] reports on this thread (`None` = no load).
#[cfg(test)]
pub fn set_test_load(v: Option<f64>) {
    TEST_LOAD.with(|c| c.set(v));
}

/// The scale factor in permille (1000 = unchanged): the load per core clamped to [1000, `max`] permille and rounded down to a
/// multiple of `step` above 1000 (0 = no rounding). `max` at most 1000, or no load reading, is 1000: the deadlines do not move.
pub fn factor_permille(load_per_core: Option<f64>, max: u64, step: u64) -> u64 {
    let Some(load) = load_per_core.filter(|l| l.is_finite() && *l > 1.0) else { return 1000 };
    if max <= 1000 {
        return 1000;
    }
    let raw = ((load * 1000.0) as u64).min(max);
    let over = raw - 1000;
    1000 + if step == 0 { over } else { over - over % step }
}

/// `ms` scaled by `factor` permille (the product in 128 bits, so it never saturates before the divide).
pub fn scale(ms: u64, factor: u64) -> u64 {
    u64::try_from(u128::from(ms) * u128::from(factor) / 1000).unwrap_or(u64::MAX)
}

/// `factor` lowered until `base_ms` scaled by it fits in `avail_ms` (the outer bound of the call less everything else it plans:
/// the cold-start wait, the kill graces, the wall margin), never below 1000, rounded down to `step` above 1000 (0 = no rounding).
/// The outermost process fits the factor once and passes it down, so no inner process waits past the outer one.
pub fn fit_permille(factor: u64, base_ms: u64, avail_ms: u64, step: u64) -> u64 {
    let cap = if base_ms == 0 { factor } else { u64::try_from(u128::from(avail_ms) * 1000 / u128::from(base_ms)).unwrap_or(u64::MAX) };
    let over = factor.min(cap).max(1000) - 1000;
    1000 + if step == 0 { over } else { over - over % step }
}

/// A factor passed down by the outer process (a request field, an environment value): clamped to [1000, `max`]; none = 1000. An
/// inner process never samples the load itself, so it can not disagree with the outer one across a step.
pub fn passed_permille(v: Option<u64>, max: u64) -> u64 {
    v.map_or(1000, |f| f.clamp(1000, max.max(1000)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The factor is clamped to [1, max], rounded down to the step, and a load at or under one per core changes nothing.
    #[test]
    fn the_factor_is_clamped_stepped_and_one_at_or_under_a_core() {
        for load in [None, Some(0.0), Some(0.5), Some(1.0), Some(f64::NAN), Some(f64::INFINITY), Some(-3.0)] {
            assert_eq!(factor_permille(load, 2000, 250), 1000, "{load:?}");
        }
        assert_eq!(factor_permille(Some(1.2), 2000, 250), 1000, "under one step");
        assert_eq!(factor_permille(Some(1.3), 2000, 250), 1250);
        assert_eq!(factor_permille(Some(1.74), 2000, 250), 1500);
        assert_eq!(factor_permille(Some(3.5), 2000, 250), 2000, "clamped to the max");
        assert_eq!(factor_permille(Some(1.33), 2000, 0), 1330, "no step");
        assert_eq!(factor_permille(Some(3.5), 1000, 250), 1000, "max 1000 = off");
        assert_eq!(factor_permille(Some(3.5), 0, 250), 1000, "max 0 = off");
        assert_eq!(scale(3000, 1500), 4500);
        assert_eq!(scale(u64::MAX, 2000), u64::MAX, "saturates only past u64, never in the multiply");
        assert_eq!(scale(u64::MAX / 1000, 1000), u64::MAX / 1000, "no overflow before the divide");
        // fitting: Stop's 9000 ms late wait in a 10 s wrapper with a 2000 ms cold wait can not grow at all
        assert_eq!(fit_permille(2000, 9000, 10_000 - 2000 - 500, 250), 1000);
        // a 3000 ms wait in 7000 ms of room: at most 2333, stepped down to 2250, and never past the sampled factor
        assert_eq!(fit_permille(3000, 3000, 7000, 250), 2250);
        assert_eq!(fit_permille(1500, 3000, 7000, 250), 1500);
        assert_eq!(fit_permille(2000, 3000, 0, 250), 1000, "no room: unchanged");
        assert!(scale(3000, fit_permille(2000, 3000, 7000, 250)) <= 7000);
        assert_eq!(passed_permille(None, 2000), 1000);
        assert_eq!(passed_permille(Some(5000), 2000), 2000, "clamped to the max");
        assert_eq!(passed_permille(Some(10), 2000), 1000);
        assert_eq!(passed_permille(Some(1500), 0), 1000, "max off");
        set_test_load(Some(2.0));
        assert_eq!(per_core(), Some(2.0));
        set_test_load(None);
        assert_eq!(per_core(), None);
    }
}
