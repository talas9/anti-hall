//! Per-session state of the guards, behind a trait so the backing store can change without touching a guard.
//!
//! Today the state lives in memory (a derived cache, allowed memory-only by D23); when storage lands (D19, D22) a
//! `Store`-backed implementation replaces [`MemoryState`] and the guards do not change. Values are JSON text so the
//! shape is the same one the Node guards keep in `~/.anti-hall/*.json`. The in-memory store is bounded (D25): past the
//! configured cap the least recently written entry is evicted, which a guard sees as "no state yet" (the fail-open
//! direction for these advisory guards).
use crate::defaults;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Per-session JSON state, keyed by (namespace, session key).
pub trait SessionState: Send + Sync {
    /// Read-modify-write one entry atomically: `f` receives the current value (`None` when absent) and returns the new
    /// one (`None` leaves the entry as it was).
    fn update(&self, ns: &str, session: &str, f: &mut dyn FnMut(Option<&str>) -> Option<String>);
    /// Read one entry.
    fn get(&self, ns: &str, session: &str) -> Option<String>;
}

/// The in-memory implementation.
pub struct MemoryState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    map: HashMap<(String, String), (String, u64)>,
    seq: u64,
}

impl MemoryState {
    /// An empty store.
    pub fn new() -> MemoryState {
        MemoryState { inner: Mutex::new(Inner::default()) }
    }
}

impl Default for MemoryState {
    fn default() -> Self {
        MemoryState::new()
    }
}

impl SessionState for MemoryState {
    fn update(&self, ns: &str, session: &str, f: &mut dyn FnMut(Option<&str>) -> Option<String>) {
        let mut g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let key = (ns.to_string(), session.to_string());
        let new = f(g.map.get(&key).map(|(v, _)| v.as_str()));
        if let Some(v) = new {
            g.seq += 1;
            let seq = g.seq;
            g.map.insert(key, (v, seq));
            let cap = defaults::num("guardkit.state_cap") as usize;
            if g.map.len() > cap
                && let Some(oldest) = g.map.iter().min_by_key(|(_, (_, s))| *s).map(|(k, _)| k.clone())
            {
                g.map.remove(&oldest);
            }
        }
    }

    fn get(&self, ns: &str, session: &str) -> Option<String> {
        let g = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.map.get(&(ns.to_string(), session.to_string())).map(|(v, _)| v.clone())
    }
}

/// The process-wide state the registered checks use.
pub fn global() -> &'static dyn SessionState {
    static G: OnceLock<MemoryState> = OnceLock::new();
    G.get_or_init(MemoryState::new)
}

/// A session id as the Node guards turn it into a file-name part: every character outside letters, digits, dot,
/// underscore and hyphen becomes `_` (one per UTF-16 unit), cut to `guardkit.session_key_max` units. Two ids that
/// sanitize alike share state, exactly as they share a file in Node.
pub fn session_key(sid: &str) -> String {
    let max = defaults::num("guardkit.session_key_max") as usize;
    let mut out = String::new();
    let mut units = 0usize;
    for c in sid.chars() {
        let w = c.len_utf16();
        let ok = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
        for _ in 0..w {
            if units == max {
                return out;
            }
            out.push(if ok { c } else { '_' });
            units += 1;
        }
    }
    out
}
