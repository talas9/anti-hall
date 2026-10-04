//! One [`Index`] per transcript path, bounded by count and by idle time.
//!
//! The daemon owns one [`Indexes`]. A request names a transcript path and asks for facts; the registry creates the
//! index on first use, refreshes it (reading only appended bytes), runs the caller's closure on it and remembers
//! when it was used. A session's index is dropped when it has been idle for `transcript.idle_ttl_ms` or when more
//! than `transcript.max_indexes` are held (D22: memory holds only active items; a dropped index is rebuilt from the
//! file on the next request, so nothing is lost).
//!
//! Locking: the map lock is held only to find or create a slot, never across I/O (D9). Each index has its own lock,
//! held while that one transcript is refreshed (a bounded read, `transcript.max_update_bytes`) so two requests for the
//! same session never read the same bytes twice.
use super::index::{Index, Limits};
use super::TranscriptError;
use crate::defaults;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

struct Slot {
    index: Mutex<Index>,
    last_used_ms: Mutex<u64>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The registry of transcript indexes.
pub struct Indexes {
    slots: Mutex<HashMap<PathBuf, Arc<Slot>>>,
    limits: Limits,
    max: usize,
    ttl_ms: u64,
}

impl Indexes {
    /// A registry with the shipped limits.
    pub fn new() -> Indexes {
        Indexes::with(Limits::from_defaults(), defaults::num("transcript.max_indexes") as usize, defaults::num("transcript.idle_ttl_ms"))
    }

    /// A registry with explicit limits, size cap and idle TTL (tests).
    pub fn with(limits: Limits, max: usize, ttl_ms: u64) -> Indexes {
        Indexes { slots: Mutex::new(HashMap::new()), limits, max: max.max(1), ttl_ms }
    }

    /// Refresh the index of `path` (creating it on first use) and run `f` on it.
    pub fn with_index<R>(&self, path: &Path, now_ms: u64, f: impl FnOnce(&Index) -> R) -> Result<R, TranscriptError> {
        let slot = {
            let mut map = lock(&self.slots);
            self.sweep_locked(&mut map, now_ms);
            if !map.contains_key(path) && map.len() >= self.max {
                let oldest = map.iter().min_by_key(|(_, s)| *lock(&s.last_used_ms)).map(|(k, _)| k.clone());
                if let Some(k) = oldest {
                    map.remove(&k);
                }
            }
            map.entry(path.to_path_buf())
                .or_insert_with(|| Arc::new(Slot { index: Mutex::new(Index::with_limits(path, self.limits.clone())), last_used_ms: Mutex::new(now_ms) }))
                .clone()
        };
        *lock(&slot.last_used_ms) = now_ms;
        let mut ix = lock(&slot.index);
        ix.refresh()?;
        Ok(f(&ix))
    }

    fn sweep_locked(&self, map: &mut HashMap<PathBuf, Arc<Slot>>, now_ms: u64) {
        map.retain(|_, s| now_ms.saturating_sub(*lock(&s.last_used_ms)) <= self.ttl_ms);
    }

    /// Drop every index idle longer than the TTL; returns how many remain.
    pub fn sweep(&self, now_ms: u64) -> usize {
        let mut map = lock(&self.slots);
        self.sweep_locked(&mut map, now_ms);
        map.len()
    }

    /// Drop the index of `path` (a session ended).
    pub fn drop_index(&self, path: &Path) {
        lock(&self.slots).remove(path);
    }

    /// How many indexes are held.
    pub fn len(&self) -> usize {
        lock(&self.slots).len()
    }

    /// True when none are held.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for Indexes {
    fn default() -> Self {
        Indexes::new()
    }
}
