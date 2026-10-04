//! The per-vendor circuit breaker (D13).
//!
//! Mirrors the breaker in `hooks/lib/jev-client.js` (`breakerOpen`, `breakerRecord`): per VENDOR, not per role, a count
//! of consecutive fallback-eligible failures; at the threshold the vendor is skipped for a cooldown, after which the
//! next call is a probe (the count stays at the threshold, so one more failure re-opens it at once and one success
//! closes it). Node keeps this in a cache file because each hook is a fresh process; the engine is resident, so the
//! state lives in memory. Persisting it across an engine restart is planned with the storage lane (D21, hot.db).
//!
//! The clock is injectable and monotonic, so a wall-clock jump can neither hold a vendor open nor close it early.
use super::settings::Vendor;
use crate::defaults;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// A source of monotonic milliseconds.
pub trait Clock: Send + Sync {
    /// Milliseconds since an arbitrary fixed start.
    fn now_ms(&self) -> u64;
}

/// The real clock: milliseconds since the first call in this process.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_millis() as u64
    }
}

/// A clock a test moves by hand.
#[derive(Debug, Default)]
pub struct ManualClock(AtomicU64);

impl ManualClock {
    /// Move time forward.
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct Entry {
    fails: u64,
    open_until: u64,
}

/// The breakers of both vendors.
pub struct Breakers {
    state: Mutex<[Entry; 2]>,
    clock: Arc<dyn Clock>,
}

fn slot(v: Vendor) -> usize {
    match v {
        Vendor::Vercel => 0,
        Vendor::Typesafe => 1,
    }
}

impl Breakers {
    /// Breakers on `clock`.
    pub fn new(clock: Arc<dyn Clock>) -> Breakers {
        Breakers { state: Mutex::new([Entry::default(); 2]), clock }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, [Entry; 2]> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True while `vendor` is being skipped.
    pub fn is_open(&self, vendor: Vendor) -> bool {
        let e = self.lock()[slot(vendor)];
        e.fails >= defaults::num("jev.breaker_threshold") && self.clock.now_ms() < e.open_until
    }

    /// Record the outcome of a call that reached the vendor: success closes the breaker, an eligible failure counts, and
    /// at or past the threshold every further failure (a failed probe included) re-opens it for a fresh cooldown.
    pub fn record(&self, vendor: Vendor, ok: bool) {
        let mut all = self.lock();
        let e = &mut all[slot(vendor)];
        if ok {
            *e = Entry::default();
            return;
        }
        e.fails += 1;
        e.open_until = if e.fails >= defaults::num("jev.breaker_threshold") { self.clock.now_ms() + defaults::num("jev.breaker_cooldown_ms") } else { 0 };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn breakers() -> (Breakers, Arc<ManualClock>) {
        let c = Arc::new(ManualClock::default());
        (Breakers::new(c.clone()), c)
    }

    #[test]
    fn it_opens_at_the_threshold_and_probes_after_the_cooldown() {
        let (b, clock) = breakers();
        let n = defaults::num("jev.breaker_threshold");
        for _ in 0..n - 1 {
            b.record(Vendor::Vercel, false);
        }
        assert!(!b.is_open(Vendor::Vercel));
        b.record(Vendor::Vercel, false);
        assert!(b.is_open(Vendor::Vercel));
        assert!(!b.is_open(Vendor::Typesafe), "per vendor");
        clock.advance(defaults::num("jev.breaker_cooldown_ms"));
        assert!(!b.is_open(Vendor::Vercel), "the cooldown has passed: the next call is a probe");
        b.record(Vendor::Vercel, false);
        assert!(b.is_open(Vendor::Vercel), "a failed probe re-opens at once");
    }

    #[test]
    fn a_success_closes_it_and_clears_the_count() {
        let (b, _) = breakers();
        for _ in 0..defaults::num("jev.breaker_threshold") {
            b.record(Vendor::Typesafe, false);
        }
        assert!(b.is_open(Vendor::Typesafe));
        b.record(Vendor::Typesafe, true);
        assert!(!b.is_open(Vendor::Typesafe));
        b.record(Vendor::Typesafe, false);
        assert!(!b.is_open(Vendor::Typesafe), "the count restarted from zero");
    }
}
