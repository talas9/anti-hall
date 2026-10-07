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
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

struct Slot {
    count: u64,
    last: Instant,
}

/// The session counters of one process.
pub struct SessionStore {
    slots: Mutex<HashMap<(String, String), Slot>>,
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
        SessionStore { slots: Mutex::new(HashMap::new()), clock: Box::new(Instant::now) }
    }

    /// An empty store on a caller's clock (tests advance time with it).
    pub fn with_clock(clock: impl Fn() -> Instant + Send + Sync + 'static) -> SessionStore {
        SessionStore { slots: Mutex::new(HashMap::new()), clock: Box::new(clock) }
    }

    /// Count one evaluation of `cond` in `session` and say whether the condition holds. A counter idle longer than its TTL
    /// starts again from zero.
    pub fn test(&self, session: &str, cond: &SessionCond) -> bool {
        let now = (self.clock)();
        let ttl = Duration::from_secs(cond.ttl_s.unwrap_or_else(|| defaults::num("hooks.session_ttl_s")));
        let mut slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
        let max = defaults::num("hooks.session_max_keys") as usize;
        if slots.len() >= max {
            slots.retain(|_, s| now.saturating_duration_since(s.last) <= ttl);
            if slots.len() >= max {
                let oldest = slots.iter().min_by_key(|(_, s)| s.last).map(|(k, _)| k.clone());
                if let Some(k) = oldest {
                    slots.remove(&k);
                }
            }
        }
        let slot = slots.entry((session.to_string(), cond.name.clone())).or_insert(Slot { count: 0, last: now });
        if now.saturating_duration_since(slot.last) > ttl {
            slot.count = 0;
        }
        slot.last = now;
        slot.count = slot.count.saturating_add(1);
        match cond.op {
            SessionOp::First => slot.count == 1,
            SessionOp::Every(n) => (slot.count - 1).is_multiple_of(n),
            SessionOp::AtLeast(n) => slot.count >= n,
        }
    }

    /// Forget every counter of a session (it ended).
    pub fn end(&self, session: &str) {
        self.slots.lock().unwrap_or_else(|e| e.into_inner()).retain(|(s, _), _| s != session);
    }

    /// How many counters are held.
    pub fn len(&self) -> usize {
        self.slots.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    /// True when none are held.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
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
    fn a_panic_while_holding_the_lock_does_not_disable_the_store() {
        let s = Arc::new(SessionStore::new());
        let s2 = s.clone();
        let _ = std::thread::spawn(move || {
            let _g = s2.slots.lock().unwrap();
            panic!("worker died");
        })
        .join();
        assert!(s.test("s", &cond("a", SessionOp::First, None)), "a poisoned lock is recovered");
    }
}
