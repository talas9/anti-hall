//! The answer cache, keyed by content hash.
//!
//! Mirrors the cache in `hooks/lib/jev-assist.js` (`readCache`, `writeCache`): only a successful answer is cached, the
//! key is the content hash of the integration id, the question version and the text (or an explicit cache key), and the
//! oldest entry goes first once the bound is reached. A hit costs nothing and is logged with backend `cache`.
//!
//! [`JevCache`] is the seam to storage: [`MemCache`] holds the entries in memory, bounded and lost on exit. Putting the
//! cache on the `Store` trait (hot.db, D22) is planned with the storage lane (D21); nothing outside this module depends
//! on the backend.
use super::client::Answer;
use crate::defaults;
use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

/// A cached answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Cached {
    /// The answer.
    pub answer: Answer,
    /// Its confidence.
    pub confidence: f64,
}

/// Where answers are remembered. Implementations must stay bounded (D25) and never block on I/O longer than a call may.
pub trait JevCache: Send + Sync {
    /// The cached answer for `hash`.
    fn get(&self, hash: &str) -> Option<Cached>;
    /// Remember an answer, replacing any earlier one for the same hash.
    fn put(&self, hash: &str, value: Cached);
    /// Entries held.
    fn len(&self) -> usize;
    /// True when nothing is held.
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

struct Inner {
    map: HashMap<String, (Cached, u64)>,
    order: BTreeMap<u64, String>,
    next: u64,
}

/// The in-memory cache: insertion-ordered eviction, bounded by `jev.cache_max_entries`.
pub struct MemCache {
    inner: Mutex<Inner>,
    cap: usize,
}

impl MemCache {
    /// A cache holding at most `cap` entries.
    pub fn new(cap: usize) -> MemCache {
        MemCache { inner: Mutex::new(Inner { map: HashMap::new(), order: BTreeMap::new(), next: 1 }), cap: cap.max(1) }
    }

    /// A cache bounded by the shipped default.
    pub fn with_defaults() -> MemCache {
        MemCache::new(defaults::num("jev.cache_max_entries") as usize)
    }
}

impl JevCache for MemCache {
    fn get(&self, hash: &str) -> Option<Cached> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).map.get(hash).map(|(c, _)| c.clone())
    }

    fn put(&self, hash: &str, value: Cached) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let seq = g.next;
        g.next += 1;
        if let Some((_, old)) = g.map.insert(hash.to_string(), (value, seq)) {
            g.order.remove(&old);
        }
        g.order.insert(seq, hash.to_string());
        while g.map.len() > self.cap {
            let Some((_, oldest)) = g.order.pop_first() else { break };
            g.map.remove(&oldest);
        }
    }

    fn len(&self) -> usize {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).map.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(b: bool) -> Cached {
        Cached { answer: Answer::Bool(b), confidence: 0.9 }
    }

    #[test]
    fn it_evicts_the_oldest_insertion_first_and_stays_bounded() {
        let m = MemCache::new(2);
        m.put("a", c(true));
        m.put("b", c(true));
        m.put("c", c(false));
        assert_eq!((m.len(), m.get("a"), m.get("b").is_some(), m.get("c").is_some()), (2, None, true, true));
    }

    #[test]
    fn rewriting_a_key_makes_it_the_newest() {
        let m = MemCache::new(2);
        m.put("a", c(true));
        m.put("b", c(true));
        m.put("a", c(false));
        m.put("c", c(true));
        assert_eq!(m.get("a"), Some(c(false)));
        assert_eq!(m.get("b"), None, "b was the oldest after a was rewritten");
    }
}
