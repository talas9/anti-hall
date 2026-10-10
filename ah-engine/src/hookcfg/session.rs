//! Per-session state for `when` predicates (D87): counters the evaluating process keeps in memory with a TTL, for "first time
//! this session", "once per N evaluations" and "at least N evaluations" conditions.
//!
//! Only a process that lives across hook calls can keep it (the daemon, or the dispatcher with `dispatch.in_process`); a
//! one-shot client has no store and a `session` condition is then unknown, which applies the entry.
//!
//! Every test is one read-modify-write under one lock, so concurrent workers evaluating the same session never both see "first".
//! The lock is held only for that update, never across a callback or I/O, and a poisoned lock is recovered (a panicking worker
//! must not disable the store for every other session).
use super::when::{SessionCond, SessionOp};
use crate::defaults;
use crate::mem::{Admit, Budget, Owner, Registry, Spec};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const SLOT_OVERHEAD: usize = std::mem::size_of::<Slot>() + 96;

struct Slot {
    count: u64,
    last: Instant,
    weight: usize,
}

#[derive(Default)]
struct SessionCore {
    slots: Mutex<HashMap<(String, String), Slot>>,
    bytes: AtomicUsize,
}

impl SessionCore {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Slot>> {
        self.slots.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn weight(session: &str, cond: &str) -> usize {
        session.len().saturating_add(cond.len()).saturating_add(SLOT_OVERHEAD)
    }

    fn refresh_bytes(slots: &HashMap<(String, String), Slot>) -> usize {
        slots.values().map(|s| s.weight).sum()
    }

    fn store_bytes(&self, slots: &HashMap<(String, String), Slot>) {
        self.bytes.store(Self::refresh_bytes(slots), SeqCst);
    }

    fn evict_expired(slots: &mut HashMap<(String, String), Slot>, now: Instant, ttl: Duration) {
        slots.retain(|_, s| now.saturating_duration_since(s.last) <= ttl);
    }

    fn evict_oldest(slots: &mut HashMap<(String, String), Slot>) -> bool {
        let oldest = slots.iter().min_by_key(|(_, s)| s.last).map(|(k, _)| k.clone());
        oldest.is_some_and(|k| slots.remove(&k).is_some())
    }
}

impl Owner for SessionCore {
    fn bytes(&self) -> usize {
        self.bytes.load(SeqCst)
    }
    fn shrink(&self, target: usize) {
        let mut slots = self.lock();
        while Self::refresh_bytes(&slots) > target && Self::evict_oldest(&mut slots) {}
        self.store_bytes(&slots);
    }
    fn recycle(&self) {
        let mut slots = self.lock();
        slots.clear();
        self.bytes.store(0, SeqCst);
    }
}

/// The session counters of one process.
pub struct SessionStore {
    core: Arc<SessionCore>,
    budget: Budget,
    clock: Box<dyn Fn() -> Instant + Send + Sync>,
}

impl Default for SessionStore {
    fn default() -> Self {
        SessionStore::new()
    }
}

impl SessionStore {
    /// An empty store on the real clock.
    pub fn new() -> SessionStore {
        Self::with_clock_and_registry(Instant::now, crate::mem::global())
    }

    /// An empty store on a caller's clock (tests advance time with it).
    pub fn with_clock(clock: impl Fn() -> Instant + Send + Sync + 'static) -> SessionStore {
        Self::with_clock_and_registry(clock, crate::mem::global())
    }

    fn with_clock_and_registry(clock: impl Fn() -> Instant + Send + Sync + 'static, reg: &Registry) -> SessionStore {
        let core = Arc::new(SessionCore::default());
        let owner: Arc<dyn Owner> = core.clone();
        let budget = reg.register(
            Spec::new("hook_sessions", "mem.hook_sessions_soft_bytes", "mem.hook_sessions_hard_bytes", "mem.hook_sessions_low_water_pct")
                .with_entries("mem.hook_sessions_max_entries"),
            Arc::downgrade(&owner),
        );
        SessionStore { core, budget, clock: Box::new(clock) }
    }

    /// Count one evaluation of `cond` in `session` and say whether the condition holds. A counter idle longer than its TTL
    /// starts again from zero; idle counters are evicted even if a session never sends `SessionEnd`.
    pub fn test(&self, session: &str, cond: &SessionCond) -> bool {
        let now = (self.clock)();
        let ttl = Duration::from_secs(cond.ttl_s.unwrap_or_else(|| defaults::num("hooks.session_ttl_s")));
        let key = (session.to_string(), cond.name.clone());
        let mut slots = self.core.lock();
        SessionCore::evict_expired(&mut slots, now, ttl);
        if let Some(slot) = slots.get_mut(&key) {
            if now.saturating_duration_since(slot.last) > ttl {
                slot.count = 0;
            }
            slot.last = now;
            slot.count = slot.count.saturating_add(1);
            let count = slot.count;
            self.core.store_bytes(&slots);
            return holds(cond, count);
        }
        let max = self.budget.max_entries();
        while max > 0 && slots.len() >= max && SessionCore::evict_oldest(&mut slots) {}
        let weight = SessionCore::weight(session, &cond.name);
        self.core.store_bytes(&slots);
        drop(slots);
        if self.budget.admit(weight) == Admit::Refused {
            return holds(cond, 1);
        }
        let mut slots = self.core.lock();
        if max > 0 && slots.len() >= max {
            return holds(cond, 1);
        }
        slots.insert(key, Slot { count: 1, last: now, weight });
        self.core.store_bytes(&slots);
        holds(cond, 1)
    }

    /// Forget every counter of a session (it ended).
    pub fn end(&self, session: &str) {
        let mut slots = self.core.lock();
        slots.retain(|(s, _), _| s != session);
        self.core.store_bytes(&slots);
    }

    /// How many counters are held.
    pub fn len(&self) -> usize {
        self.core.lock().len()
    }

    /// Estimated bytes held.
    pub fn bytes(&self) -> usize {
        self.core.bytes.load(SeqCst)
    }

    /// True when none are held.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn holds(cond: &SessionCond, count: u64) -> bool {
    match cond.op {
        SessionOp::First => count == 1,
        SessionOp::Every(n) => (count - 1).is_multiple_of(n),
        SessionOp::AtLeast(n) => count >= n,
    }
}

/// The store of this process, shared by every worker.
pub fn global() -> &'static SessionStore {
    static STORE: std::sync::OnceLock<SessionStore> = std::sync::OnceLock::new();
    STORE.get_or_init(SessionStore::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn cond(name: &str, op: SessionOp, ttl_s: Option<u64>) -> SessionCond {
        SessionCond { name: name.into(), op, ttl_s }
    }

    #[test]
    fn first_is_true_once_per_session_and_name() {
        let s = SessionStore::new();
        let c = cond("a", SessionOp::First, None);
        assert_eq!([s.test("s1", &c), s.test("s1", &c), s.test("s2", &c), s.test("s1", &cond("b", SessionOp::First, None))], [true, false, true, true]);
        s.end("s1");
        assert!(s.test("s1", &c), "a session that ended starts again");
        assert_eq!(s.len(), 2, "s1 was forgotten, then re-created; s2 stayed");
    }

    #[test]
    fn a_counter_expires_after_its_ttl_and_starts_again() {
        let ms = Arc::new(AtomicU64::new(0));
        let base = Instant::now();
        let m = ms.clone();
        let s = SessionStore::with_clock(move || base + Duration::from_millis(m.load(Ordering::SeqCst)));
        let c = cond("a", SessionOp::First, Some(10));
        assert!(s.test("s", &c));
        ms.store(9_000, Ordering::SeqCst);
        assert!(!s.test("s", &c), "inside the TTL");
        ms.store(9_000 + 10_001, Ordering::SeqCst);
        assert!(s.test("s", &c), "idle longer than the TTL: first again");
        assert!(!s.test("s", &c));
    }

    #[test]
    fn expired_counters_are_evicted_without_session_end() {
        let ms = Arc::new(AtomicU64::new(0));
        let base = Instant::now();
        let m = ms.clone();
        let s = SessionStore::with_clock(move || base + Duration::from_millis(m.load(Ordering::SeqCst)));
        let c = cond("a", SessionOp::First, Some(1));
        assert!(s.test("never-ended", &c));
        assert_eq!(s.len(), 1);
        ms.store(1_001, Ordering::SeqCst);
        assert!(s.test("other", &c), "a later request prunes the idle session");
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn concurrent_first_tests_agree_on_exactly_one_winner() {
        let s = Arc::new(SessionStore::new());
        let c = cond("race", SessionOp::First, None);
        let wins: usize = (0..8)
            .map(|_| {
                let (s, c) = (s.clone(), c.clone());
                std::thread::spawn(move || (0..200).filter(|_| s.test("one-session", &c)).count())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .sum();
        assert_eq!(wins, 1, "the update is atomic: one `first` across 1600 racing evaluations");
    }

    #[test]
    fn the_store_is_bounded() {
        let s = SessionStore::new();
        let max = defaults::num("hooks.session_max_keys") as usize;
        for i in 0..max + 50 {
            s.test(&format!("s{i}"), &cond("k", SessionOp::First, None));
        }
        assert!(s.len() <= max, "{} > {max}", s.len());
    }

    #[test]
    fn the_store_obeys_its_memory_budget() {
        let reg = crate::mem::Registry::new(
            Box::new(|k| match k {
                "mem.hook_sessions_soft_bytes" => 512,
                "mem.hook_sessions_hard_bytes" => 1024,
                "mem.hook_sessions_low_water_pct" => 50,
                "mem.hook_sessions_max_entries" => 0,
                _ => 0,
            }),
            Box::new(|_| {}),
        );
        let s = SessionStore::with_clock_and_registry(Instant::now, &reg);
        let c = cond("k", SessionOp::First, None);
        for i in 0..100 {
            s.test(&format!("session-{i}-{}", "x".repeat(80)), &c);
        }
        assert!(s.bytes() <= 1024, "{} > hard budget", s.bytes());
    }

    #[test]
    fn a_panic_while_holding_the_lock_does_not_disable_the_store() {
        let s = Arc::new(SessionStore::new());
        let s2 = s.clone();
        crate::discard::harmless(
            std::thread::spawn(move || {
                let _g = s2.core.slots.lock().unwrap();
                panic!("worker died");
            })
            .join(),
        ); // keep: best effort, fail-open
        assert!(s.test("s", &cond("a", SessionOp::First, None)), "a poisoned lock is recovered");
    }
}
