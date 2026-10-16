//! The compiled-regex cache behind `ah.re.*`: ONE cache for the whole process, bounded by estimated BYTES with
//! least-recently-used eviction.
//!
//! Before, each worker thread kept its own cache (cleared only when it held `mem.regex_max_entries` patterns), so every
//! worker compiled and held its own copy of the same patterns: measured 139 distinct patterns = 3.3 MB of compiled
//! programs per copy, four copies. A compiled `Regex` is `Send + Sync` and keeps its per-thread search state inside, so the
//! program is shared through an `Arc` and each thread adds only its own scratch space.
//!
//! The `regex` crate does not report a compiled program's size, so an entry's weight is an estimate: a fixed part plus a
//! part per byte of the translated source (`script.regex_entry_base_bytes`, `script.regex_bytes_per_src_byte`, calibrated
//! against measured programs). The compile itself is bounded too: `script.regex_size_limit` caps a program and
//! `script.regex_dfa_size_limit` caps the lazy-DFA scratch each thread may grow for it.
//!
//! The cache is a [`crate::mem::BoundedCache`] registered as `regex`: soft and hard limits are `mem.regex_*`. The lock is held
//! for the lookup and the bookkeeping only, never for a compile or a match; two threads that miss on the same pattern at once
//! both compile it and the second insert replaces the first (identical programs). A refused insert (hard limit) still returns
//! the compiled pattern: the script is served, the pattern is just not kept.

use super::host::err;
use crate::checks::guardkit::jsre;
use crate::defaults;
use crate::mem::{BoundedCache, Spec};
use regex::{Regex, RegexBuilder};
use std::sync::{Arc, OnceLock};

type Cache = BoundedCache<(String, String), Arc<Regex>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::new(
            crate::mem::global(),
            Spec::new("regex", "mem.regex_soft_bytes", "mem.regex_hard_bytes", "mem.regex_low_water_pct").with_entries("mem.regex_max_entries"),
        )
    })
}

/// (patterns held, estimated bytes held) for the memory snapshot.
pub fn usage() -> (usize, usize) {
    let c = cache();
    (c.len(), c.bytes())
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
    cache().get_or_compute(&key, || {
        let (re, weight) = compile(src, flags).ok_or_else(|| err("RegExp", defaults::render("script.msg_invalid_pattern", &[("src", &src)])))?;
        Ok((Arc::new(re), weight))
    })
}
