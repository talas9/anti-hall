//! The per-vendor circuit breaker (D13).
//!
//! Mirrors the breaker in `hooks/lib/jev-client.js` (`breakerOpen`, `breakerRecord`): per VENDOR, not per role, a count
//! of consecutive fallback-eligible failures; at the threshold the vendor is skipped for a cooldown, after which the
//! next call is a probe (the count stays at the threshold, so one more failure re-opens it at once and one success
//! closes it). Node keeps this in `<home>/.anti-hall/cache/jev-breaker.json` because each hook is a fresh process.
//! While Node hooks and the engine both serve one user, the two must see ONE breaker, so [`Breakers::shared`] reads and
//! writes that same file in Node's shape (`{<vendor>: {fails, openUntil}}` with the vendors "vercel" and "typesafe", epoch milliseconds, atomic tmp+rename, last
//! writer wins, any I/O error reads as closed). [`Breakers::new`] keeps the state in memory (tests, one-shot use).
//!
//! The clock is injectable. In memory it is monotonic, so a wall-clock jump can neither hold a vendor open nor close it
//! early; in the shared file it is the wall clock, because that is what Node writes, and a stored `openUntil` further
//! out than one cooldown reads as closed (Node's rule: a tampered value never holds a vendor open).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

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

/// Epoch milliseconds: the clock Node's breaker file is written in.
#[derive(Debug, Default, Clone, Copy)]
pub struct WallClock;

impl Clock for WallClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
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
    /// Node's breaker file, when the state is shared with it.
    file: Option<std::path::PathBuf>,
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
        Breakers { state: Mutex::new([Entry::default(); 2]), clock, file: None }
    }

    /// Breakers whose state lives in the Node breaker file `path`, in epoch milliseconds from `clock`.
    pub fn shared(path: std::path::PathBuf, clock: Arc<dyn Clock>) -> Breakers {
        Breakers { state: Mutex::new([Entry::default(); 2]), clock, file: Some(path) }
    }

    fn name(v: Vendor) -> &'static str {
        match v {
            Vendor::Vercel => "vercel",
            Vendor::Typesafe => "typesafe",
        }
    }

    /// The file's map; missing, corrupt or not an object reads as empty (closed).
    fn read_file(&self) -> serde_json::Map<String, serde_json::Value> {
        let Some(p) = &self.file else { return Default::default() };
        match std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()) {
            Some(serde_json::Value::Object(m)) => m,
            _ => Default::default(),
        }
    }

    /// One vendor's entry as Node's `breakerEntry` reads it.
    fn entry_from(&self, m: &serde_json::Map<String, serde_json::Value>, v: Vendor) -> Entry {
        let Some(e) = m.get(Self::name(v)) else { return Entry::default() };
        let fails = e.get("fails").and_then(serde_json::Value::as_f64).filter(|f| f.is_finite() && *f >= 0.0);
        let Some(fails) = fails else { return Entry::default() };
        let now = self.clock.now_ms() as f64;
        let ou = e
            .get("openUntil")
            .and_then(serde_json::Value::as_f64)
            .filter(|o| o.is_finite() && *o > 0.0 && *o <= now + defaults::num("jev.breaker_cooldown_ms") as f64);
        Entry { fails: fails as u64, open_until: ou.map_or(0, |o| o as u64) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, [Entry; 2]> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// True while `vendor` is being skipped.
    pub fn is_open(&self, vendor: Vendor) -> bool {
        let e = if self.file.is_some() { self.entry_from(&self.read_file(), vendor) } else { self.lock()[slot(vendor)] };
        e.fails >= defaults::num("jev.breaker_threshold") && self.clock.now_ms() < e.open_until
    }

    /// Record the outcome of a call that reached the vendor: success closes the breaker, an eligible failure counts, and
    /// at or past the threshold every further failure (a failed probe included) re-opens it for a fresh cooldown.
    pub fn record(&self, vendor: Vendor, ok: bool) {
        if let Some(p) = &self.file {
            let _guard = self.lock(); // one writer per process; across processes the last writer wins, as in Node
            let mut m = self.read_file();
            let e = self.entry_from(&m, vendor);
            let next = if ok {
                if e.fails == 0 {
                    return;
                }
                Entry::default()
            } else {
                let fails = e.fails + 1;
                Entry {
                    fails,
                    open_until: if fails >= defaults::num("jev.breaker_threshold") {
                        self.clock.now_ms() + defaults::num("jev.breaker_cooldown_ms")
                    } else {
                        0
                    },
                }
            };
            m.insert(Self::name(vendor).to_string(), serde_json::json!({"fails": next.fails, "openUntil": next.open_until}));
            crate::discard::harmless((|| -> std::io::Result<()> {
                if let Some(d) = p.parent() {
                    std::fs::create_dir_all(d)?;
                }
                crate::atomic::write(p, serde_json::Value::Object(m).to_string())
            })()); // keep: a lost write only delays the breaker
            return;
        }
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
    fn the_shared_breaker_reads_and_writes_the_node_file_shape() {
        let d = std::env::temp_dir().join(format!("ah-brk-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
        let p = d.join("cache/jev-breaker.json");
        let clock = Arc::new(ManualClock::default());
        clock.advance(1_000_000);
        let a = Breakers::shared(p.clone(), clock.clone());
        let b = Breakers::shared(p.clone(), clock.clone()); // a second "process"
        for _ in 0..defaults::num("jev.breaker_threshold") {
            a.record(Vendor::Vercel, false);
        }
        assert!(b.is_open(Vendor::Vercel), "the other process sees the open breaker");
        let text = std::fs::read_to_string(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["vercel"]["fails"], 3);
        assert_eq!(v["vercel"]["openUntil"], 1_000_000 + defaults::num("jev.breaker_cooldown_ms"));
        // a Node-written entry is honoured, a tampered openUntil is not
        std::fs::write(&p, r#"{"typesafe":{"fails":3,"openUntil":1000500},"vercel":{"fails":3,"openUntil":99999999999999}}"#).unwrap();
        assert!(b.is_open(Vendor::Typesafe));
        assert!(!b.is_open(Vendor::Vercel), "further out than one cooldown reads as closed");
        b.record(Vendor::Typesafe, true);
        assert!(!a.is_open(Vendor::Typesafe));
        std::fs::write(&p, "not json").unwrap();
        assert!(!a.is_open(Vendor::Vercel), "a corrupt file is closed");
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
