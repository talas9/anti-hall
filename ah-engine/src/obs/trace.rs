//! The always-on trace ring: the most recent check, duty, stage and hand-back records, kept in memory.
//!
//! One push is a short lock and one small allocation, so the ring stays on in every build. `diag trace` prints it; when a hard limit
//! trips (the memory registry's hard limit, the resident-set cap, a request over its CPU budget) [`dump`] writes it to
//! `diagnostics.trace_dump_file`, so the minutes before a restart or a trip are on disk. Its size is `diagnostics.trace_entries`,
//! read once at the first push.
use crate::{atomic, defaults, health, paths};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Mutex, OnceLock};

struct Entry {
    ts_ms: u64,
    kind: &'static str,
    label: String,
    outcome: &'static str,
    micros: u64,
}

struct Ring {
    cap: usize,
    items: VecDeque<Entry>,
}

/// When the ring was last dumped (health clock, ms); 0 = never.
static LAST_DUMP: AtomicU64 = AtomicU64::new(0);
static RING: OnceLock<Mutex<Ring>> = OnceLock::new();

fn ring() -> std::sync::MutexGuard<'static, Ring> {
    RING.get_or_init(|| {
        let cap = (defaults::num("diagnostics.trace_entries") as usize).max(1);
        Mutex::new(Ring { cap, items: VecDeque::with_capacity(cap) })
    })
    .lock()
    .unwrap_or_else(|e| e.into_inner())
}

/// Record one event (`kind`: check, duty, stage, a hand-back kind; `label`: the check, duty or site; `outcome`: its result, empty
/// when it has none; `micros`: its wall time). The oldest record goes when the ring is full.
pub fn push(kind: &'static str, label: &str, outcome: &'static str, micros: u64) {
    let mut r = ring();
    if r.items.len() >= r.cap {
        r.items.pop_front();
    }
    r.items.push_back(Entry { ts_ms: health::now_ms(), kind, label: label.to_string(), outcome, micros });
}

/// The ring, oldest first.
pub fn snapshot() -> Vec<Value> {
    ring().items.iter().map(|e| json!({"ts_ms": e.ts_ms, "kind": e.kind, "label": e.label, "outcome": e.outcome, "us": e.micros})).collect()
}

/// The number of records held.
pub fn len() -> usize {
    ring().items.len()
}

/// Write the ring to the dump file (replacing the previous dump), the first line naming `reason`. Called when a hard limit trips; a
/// failure is logged, never raised.
pub fn dump(reason: &str) {
    let now = health::now_ms();
    let last = LAST_DUMP.load(Relaxed);
    if last != 0 && now.saturating_sub(last) < defaults::num("diagnostics.trace_dump_min_ms") {
        return;
    }
    LAST_DUMP.store(now, Relaxed);
    let rows = snapshot();
    let path = paths::dir().join(defaults::text("diagnostics.trace_dump_file"));
    let head = json!({"dump": reason, "ts_ms": health::now_ms(), "entries": rows.len()});
    let body: String = std::iter::once(head).chain(rows.iter().cloned()).map(|v| format!("{v}\n")).collect();
    match atomic::write(&path, body) {
        Ok(()) => health::log_event(
            "obs",
            "trace",
            &defaults::render("msg.obs_trace_dumped", &[("reason", &reason), ("entries", &rows.len()), ("path", &path.display())]),
        ),
        Err(e) => health::log_event("obs", "trace", &defaults::render("msg.obs_trace_dump_failed", &[("reason", &reason), ("err", &e)])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ring_never_holds_more_than_its_configured_size() {
        let cap = defaults::num("diagnostics.trace_entries") as usize;
        for i in 0..cap + 40 {
            push("check", &format!("c{i}"), "allow", 1);
        }
        let rows = snapshot();
        assert_eq!(rows.len(), cap, "bounded by diagnostics.trace_entries");
        assert!(rows.iter().all(|r| r["label"] != "c0"), "the oldest records were dropped");
    }
}
