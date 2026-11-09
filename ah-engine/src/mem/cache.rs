//! `BoundedCache<K, V>`: the shared, byte-weighted LRU every cache of the daemon uses. It is a mutex around
//! [`crate::tier::Tiered`] (the daemon's one LRU) registered with the memory registry: the registry decides when it shrinks
//! or refuses an insert, the cache just does what its [`Owner`] methods say.
//!
//! The lock is held for the lookup and the bookkeeping only. A miss computes its value with no lock held
//! ([`BoundedCache::get_or_compute`]); two threads that miss on the same key both compute and the second insert replaces the
//! first. Nothing here sizes a value: the caller gives each insert its weight (an estimate is enough).
use super::registry::{Admit, Budget, Owner, Registry, Spec};
use crate::tier::Tiered;
use std::hash::Hash;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};

struct Core<K: Hash + Eq + Clone, V: Clone> {
    tier: Mutex<Tiered<K, V>>,
    bytes: AtomicUsize,
    /// Bytes a value holds beyond its weight, measured as it is used (the regex search scratch); summed over the held values.
    extra: Option<fn(&V) -> usize>,
    extra_seen: AtomicUsize,
}

impl<K: Hash + Eq + Clone, V: Clone> Core<K, V> {
    fn lock(&self) -> std::sync::MutexGuard<'_, Tiered<K, V>> {
        self.tier.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl<K: Hash + Eq + Clone + Send + 'static, V: Clone + Send + 'static> Owner for Core<K, V> {
    fn bytes(&self) -> usize {
        let base = self.bytes.load(SeqCst);
        let Some(f) = self.extra else { return base };
        // a busy lock keeps the last sum: reporting never waits on a lookup
        if let Ok(t) = self.tier.try_lock() {
            self.extra_seen.store(t.values().iter().map(f).sum(), SeqCst);
        }
        base + self.extra_seen.load(SeqCst)
    }
    fn shrink(&self, target: usize) {
        let mut t = self.lock();
        match self.extra {
            None => {
                t.evict_retained_to(target);
            }
            Some(f) => {
                // `bytes()` is the weights plus the measured extra, and the registry's target is on that figure: evict until THAT is at
                // the target (by weight alone it stops while the extra still holds the cache over it). The extra leaves with its entry.
                while t.retained_bytes().saturating_add(t.values().iter().map(f).sum::<usize>()) > target && t.pop_lru().is_some() {}
                let kept = t.retained_bytes();
                t.evict_retained_to(kept); // compacts the map's storage
            }
        }
        self.bytes.store(t.retained_bytes(), SeqCst);
    }
    fn recycle(&self) {
        let mut t = self.lock();
        t.clear();
        self.bytes.store(t.retained_bytes(), SeqCst);
    }
}

/// A byte-weighted LRU cache shared across threads, on the memory registry.
pub struct BoundedCache<K: Hash + Eq + Clone + Send + 'static, V: Clone + Send + 'static> {
    core: Arc<Core<K, V>>,
    budget: Budget,
}

impl<K: Hash + Eq + Clone + Send + 'static, V: Clone + Send + 'static> BoundedCache<K, V> {
    /// An empty cache registered as `spec` (its limits are read from the spec's config keys).
    pub fn new(reg: &Registry, spec: Spec) -> Self {
        Self::with_extra(reg, spec, None)
    }

    /// [`BoundedCache::new`] whose reported bytes also include `extra(value)` of every held value: memory a value grows after it
    /// was weighed, measured by its user (the weight stays the admission estimate; the report is the measurement).
    pub fn with_extra(reg: &Registry, spec: Spec, extra: Option<fn(&V) -> usize>) -> Self {
        let core = Arc::new(Core { tier: Mutex::new(Tiered::new(usize::MAX)), bytes: AtomicUsize::new(0), extra, extra_seen: AtomicUsize::new(0) });
        let owner: Arc<dyn Owner> = core.clone();
        let budget = reg.register(spec, Arc::downgrade(&owner));
        BoundedCache { core, budget }
    }

    /// The value for `k`, refreshing its recency.
    pub fn get(&self, k: &K) -> Option<V> {
        self.get_at(k, 0)
    }

    /// The value for `k` at `now_ms`, dropping it first when its TTL has expired.
    pub fn get_at(&self, k: &K, now_ms: u64) -> Option<V> {
        let mut t = self.core.lock();
        let v = t.get(k, now_ms);
        self.core.bytes.store(t.retained_bytes(), SeqCst);
        v
    }

    /// Store `v` (about `weight` bytes) unless the registry refuses it; true when it was stored. The least recently used
    /// entries go first when the entry-count cap is reached.
    pub fn insert(&self, k: K, v: V, weight: usize) -> bool {
        self.insert_with_ttl(k, v, weight, None)
    }

    /// Store `v` with an optional absolute expiry timestamp in milliseconds.
    pub fn insert_with_ttl(&self, k: K, v: V, weight: usize, expires_ms: Option<u64>) -> bool {
        if self.budget.admit(weight) == Admit::Refused {
            return false;
        }
        let max = self.budget.max_entries();
        let mut t = self.core.lock();
        while max > 0 && t.len() >= max && !t.contains(&k) && t.pop_lru().is_some() {}
        t.insert(k.clone(), v, weight, expires_ms);
        self.core.bytes.store(t.retained_bytes(), SeqCst);
        drop(t);
        self.budget.observe();
        self.core.lock().contains(&k)
    }

    /// Drop and return `k`, if present.
    pub fn remove(&self, k: &K) -> Option<V> {
        let mut t = self.core.lock();
        let v = t.take(k, 0);
        if v.is_some() {
            self.core.bytes.store(t.retained_bytes(), SeqCst);
        }
        v
    }

    /// Snapshot the cached values.
    pub fn values(&self) -> Vec<V> {
        self.core.lock().values()
    }

    /// The cached value for `k`, or the one `compute` makes (outside any lock), stored when the registry allows it. A refused
    /// insert is still returned: the caller gets its answer, the cache just does not keep it. `compute` returns the value and
    /// its weight.
    ///
    /// # Errors
    /// What `compute` returns.
    pub fn get_or_compute<E>(&self, k: &K, compute: impl FnOnce() -> Result<(V, usize), E>) -> Result<V, E> {
        if let Some(v) = self.get(k) {
            return Ok(v);
        }
        let (v, w) = compute()?;
        self.insert(k.clone(), v.clone(), w);
        Ok(v)
    }

    /// Entries held.
    pub fn len(&self) -> usize {
        self.core.lock().len()
    }

    /// True when nothing is held.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Estimated retained bytes: item weights plus allocated collection storage.
    pub fn bytes(&self) -> usize {
        self.core.bytes.load(SeqCst)
    }

    /// [`BoundedCache::bytes`] plus what the values report beyond their weight ([`BoundedCache::with_extra`]): the figure the registry
    /// limits act on.
    pub fn reported_bytes(&self) -> usize {
        Owner::bytes(&*self.core)
    }

    /// The registry handle (for tests and for owners that also grow in other ways).
    pub fn budget(&self) -> &Budget {
        &self.budget
    }
}
