//! The compiled-regex cache behind `ah.re.*`: ONE cache for the whole process, bounded by estimated BYTES with
//! least-recently-used eviction.
//!
//! Before, each worker thread kept its own cache (cleared only when it held `mem.regex_max_entries` patterns), so every
//! worker compiled and held its own copy of the same patterns: measured 139 distinct patterns = 3.3 MB of compiled
//! programs per copy, four copies. A compiled `Regex` is `Send + Sync` and keeps its per-thread search state inside, so the
//! program is shared through an `Arc` and each thread adds only its own scratch space.
//!
//! The `regex` crate does not report a compiled program's size, so an entry's weight is the heap its build kept, measured with
//! the counting allocator's per-thread counters (`diagnostics.check_mem`); where that is off, or the build freed more than it
//! kept, the weight is an estimate: a fixed part plus a part per byte of the translated source (`script.regex_entry_base_bytes`,
//! `script.regex_bytes_per_src_byte`). The estimate was calibrated at 87 KB for a program that measures 15 KB on average (85 shipped
//! programs: 3.8 MB estimated, 1.25 MB measured), so it is the fallback, not the rule. The compile itself is bounded too: `script.regex_size_limit` caps a program and
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

/// (patterns held, bytes held by the cache's own weights) for the memory snapshot.
pub fn usage() -> (usize, usize) {
    let c = cache();
    (c.len(), c.bytes())
}

/// What every compile so far weighed, two ways: (programs compiled, estimated bytes, measured bytes of those that were measured,
/// how many were measured). The estimate is what the cache weighs an entry by; the measurement is the heap the build kept, from the
/// per-thread counters of the counting allocator (off with `diagnostics.check_mem`). The pair is the calibration of
/// `script.regex_entry_base_bytes` and `script.regex_bytes_per_src_byte`.
pub fn compiled_totals() -> (u64, u64, u64, u64) {
    use std::sync::atomic::Ordering::Relaxed;
    (COMPILED.load(Relaxed), EST_BYTES.load(Relaxed), MEASURED_BYTES.load(Relaxed), MEASURED.load(Relaxed))
}

static COMPILED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static EST_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static MEASURED_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static MEASURED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
    let (built, kept) = crate::mem::measure(|| {
        RegexBuilder::new(&pattern)
            .size_limit(defaults::num("script.regex_size_limit") as usize)
            .dfa_size_limit(defaults::num("script.regex_dfa_size_limit") as usize)
            .build()
    });
    let re = built.ok()?;
    let estimate = (defaults::num("script.regex_entry_base_bytes") as usize)
        .saturating_add((defaults::num("script.regex_bytes_per_src_byte") as usize).saturating_mul(pattern.len()));
    // the heap the build kept, where the counting allocator measured it (a negative net is the build freeing memory that was held
    // before it: no measure); the estimate otherwise
    let measured = kept.map(|d| d.retained).filter(|r| *r > 0).map(|r| r as usize);
    {
        use std::sync::atomic::Ordering::Relaxed;
        COMPILED.fetch_add(1, Relaxed);
        EST_BYTES.fetch_add(estimate as u64, Relaxed);
        if let Some(m) = measured {
            MEASURED.fetch_add(1, Relaxed);
            MEASURED_BYTES.fetch_add(m as u64, Relaxed);
        }
    }
    Some((re, measured.unwrap_or(estimate)))
}

/// The compiled pattern for `(src, flags)`, from the shared cache or compiled now.
pub(super) fn get(src: &str, flags: &str) -> rquickjs::Result<Arc<Regex>> {
    let key = (src.to_string(), flags.to_string());
    cache().get_or_compute(&key, || {
        let (re, weight) = compile(src, flags).ok_or_else(|| err("RegExp", defaults::render("script.msg_invalid_pattern", &[("src", &src)])))?;
        Ok((Arc::new(re), weight))
    })
}
