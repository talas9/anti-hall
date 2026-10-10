//! The compiled-regex cache behind `ah.re.*`: ONE cache for the whole process, bounded by estimated BYTES with
//! least-recently-used eviction.
//!
//! Before, each worker thread kept its own cache (cleared only when it held `script.regex_cache_max` patterns), so every
//! worker compiled and held its own copy of the same patterns: measured 139 distinct patterns = 3.3 MB of compiled
//! programs per copy, four copies. A compiled `Regex` is `Send + Sync` and keeps its per-thread search state inside, so the
//! program is shared through an `Arc` and each thread adds only its own scratch space.
//!
//! The `regex` crate does not report a compiled program's size, so an entry's weight is an estimate: a fixed part plus a
//! part per byte of the translated source (`script.regex_entry_base_bytes`, `script.regex_bytes_per_src_byte`, calibrated
//! against measured programs). The compile itself is bounded too: `script.regex_size_limit` caps a program and
//! `script.regex_dfa_size_limit` caps the lazy-DFA scratch each thread may grow for it.
//!
//! The lock is held for the lookup and the bookkeeping only, never for a compile or a match; two threads that miss on the
//! same pattern at once both compile it and the second insert replaces the first (identical programs).

use super::host::err;
use crate::checks::guardkit::jsre;
use crate::defaults;
use regex::{Regex, RegexBuilder};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct Entry {
    re: Arc<Regex>,
    weight: usize,
    used: u64,
}

#[derive(Default)]
struct Cache {
    map: HashMap<(String, String), Entry>,
    bytes: usize,
    tick: u64,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn lock() -> std::sync::MutexGuard<'static, Option<Cache>> {
    CACHE.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// (patterns held, estimated bytes held) for the memory snapshot.
pub fn usage() -> (usize, usize) {
    lock().as_ref().map_or((0, 0), |c| (c.map.len(), c.bytes))
}

/// Translate and compile `src` for `flags`; the estimated weight of the result. `None` when the pattern is not valid.
fn compile(src: &str, flags: &str) -> Option<(Regex, usize)> {
    let pattern = if flags.contains('r') {
        src.to_string()
    } else if flags.contains('m') {
        // JavaScript syntax with the `m` flag: `^` and `$` match at line boundaries
        format!("(?m:{})", jsre::translate(src, flags.contains('i')))
    } else {
        jsre::translate(src, flags.contains('i'))
    };
    let re = RegexBuilder::new(&pattern)
        .size_limit(defaults::num("script.regex_size_limit") as usize)
        .dfa_size_limit(defaults::num("script.regex_dfa_size_limit") as usize)
        .build()
        .ok()?;
    let weight = (defaults::num("script.regex_entry_base_bytes") as usize)
        .saturating_add((defaults::num("script.regex_bytes_per_src_byte") as usize).saturating_mul(pattern.len()));
    Some((re, weight))
}

/// The compiled pattern for `(src, flags)`, from the shared cache or compiled now.
pub(super) fn get(src: &str, flags: &str) -> rquickjs::Result<Arc<Regex>> {
    let key = (src.to_string(), flags.to_string());
    {
        let mut g = lock();
        if let Some(c) = g.as_mut() {
            c.tick += 1;
            let t = c.tick;
            if let Some(e) = c.map.get_mut(&key) {
                e.used = t;
                return Ok(e.re.clone());
            }
        }
    }
    let (re, weight) = compile(src, flags).ok_or_else(|| err("RegExp", defaults::render("script.msg_invalid_pattern", &[("src", &src)])))?;
    let re = Arc::new(re);
    let (budget, max_entries) = (defaults::num("script.regex_cache_bytes") as usize, defaults::num("script.regex_cache_max") as usize);
    let mut g = lock();
    let c = g.get_or_insert_with(Cache::default);
    if let Some(old) = c.map.remove(&key) {
        c.bytes = c.bytes.saturating_sub(old.weight);
    }
    // least recently used first, until the new entry fits both bounds; an entry larger than the whole budget is not kept
    while !c.map.is_empty() && (c.bytes.saturating_add(weight) > budget || c.map.len() >= max_entries) {
        let Some(oldest) = c.map.iter().min_by_key(|(_, e)| e.used).map(|(k, _)| k.clone()) else { break };
        if let Some(e) = c.map.remove(&oldest) {
            c.bytes = c.bytes.saturating_sub(e.weight);
        }
    }
    if weight <= budget {
        c.tick += 1;
        c.bytes += weight;
        c.map.insert(key, Entry { re: re.clone(), weight, used: c.tick });
    }
    Ok(re)
}
