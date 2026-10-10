//! The one memory module (issue #21 / #158): every long-lived in-memory holder of the daemon registers here with a byte
//! estimator and a SOFT and a HARD limit read from the plugin's config (`mem.<holder>_soft_bytes` / `hard_bytes`), and the
//! process as a whole has a global pair (`mem.global_*`).
//!
//! * SOFT (usage reaches soft): logged once per excursion and counted; the owner is told to shrink to the low-water mark
//!   (`mem.<holder>_low_water_pct` of soft): evict least recently used, collect, unload cold checks. Requests keep being served.
//!   Hysteresis: the trigger re-arms only once usage is back at or under the low-water mark, so a holder hovering at the
//!   boundary is one excursion, not a flapping series.
//! * HARD (an insert would cross hard): the insert is refused (a cache miss: the caller computes and does not store, a script
//!   call fails open), and the holder is recycled once per excursion. If the process total stays over `mem.global_hard_bytes`
//!   (or a holder that cannot shrink stays over its own hard limit) for `mem.global_restart_after_s` after that recovery,
//!   [`Registry::tick`] asks for a clean daemon restart with the reason.
//!
//! [`BoundedCache`] is the shared byte-weighted LRU (built on [`crate::tier::Tiered`]); [`Budget`] / [`Instance`] are the
//! hooks for holders that are not caches (a QuickJS runtime per worker). Nothing here holds a number: limits, intervals and
//! texts come from `defaults/mem.toml` through the registry's lookup.
//!
//! A guard test (`tests/it/mem_guard.rs`) fails the build when a long-lived collection appears outside this module without an
//! entry in `tests/mem_allowlist.txt` that states its bound.
mod cache;
mod registry;

pub use cache::BoundedCache;
pub use registry::{Action, Admit, Budget, Event, Instance, Kind, Owner, Registry, Restart, Spec};

use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

static GLOBAL: OnceLock<Registry> = OnceLock::new();
static LEAKED: AtomicU64 = AtomicU64::new(0);

/// The process-wide registry: limits from the plugin's defaults, events to the daemon's event log.
pub fn global() -> &'static Registry {
    GLOBAL.get_or_init(|| Registry::new(Box::new(crate::defaults::num), Box::new(log_event)))
}

fn log_event(e: &Event) {
    use crate::defaults::render;
    let (code, template) = match e.kind {
        Kind::Soft => ("soft", "mem.msg_soft"),
        Kind::Hard => ("hard", "mem.msg_hard"),
        Kind::Restart => ("restart", "mem.msg_restart"),
    };
    crate::health::log_event("memory", code, &render(template, &[("holder", &e.holder), ("usage", &e.usage), ("limit", &e.limit)]));
}

/// Record `bytes` that were leaked on purpose (a `'static` value built from the config, kept for the life of the process).
/// The `defaults_leak` holder reads the total, so repeated config reloads are visible and bounded.
pub fn note_leak(bytes: usize) {
    LEAKED.fetch_add(bytes as u64, Relaxed);
}

/// Total bytes recorded with [`note_leak`].
pub fn leaked_bytes() -> usize {
    LEAKED.load(Relaxed) as usize
}

/// The holder that reports [`leaked_bytes`]; the daemon registers it at start.
pub fn register_defaults_leak() -> Budget {
    struct Leak;
    impl Owner for Leak {
        fn bytes(&self) -> usize {
            leaked_bytes()
        }
        fn shrink(&self, _: usize) {} // leaked on purpose: only a restart frees it, which the registry asks for past the hard limit
        fn recycle(&self) {}
    }
    static ANCHOR: OnceLock<std::sync::Arc<Leak>> = OnceLock::new();
    let owner = ANCHOR.get_or_init(|| std::sync::Arc::new(Leak)).clone();
    let weak: std::sync::Weak<Leak> = std::sync::Arc::downgrade(&owner);
    global().register(Spec::new("defaults_leak", "mem.defaults_leak_soft_bytes", "mem.defaults_leak_hard_bytes", "mem.defaults_leak_low_water_pct"), weak)
}

/// The exit reason recorded when [`Registry::tick`] asks for a restart.
pub fn restart_reason(r: &Restart) -> String {
    crate::defaults::render("mem.msg_exit_reason", &[("holder", &r.holder), ("usage", &r.usage), ("limit", &r.limit), ("secs", &r.secs)])
}

#[cfg(test)]
mod tests;
