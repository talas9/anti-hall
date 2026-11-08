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
//! That scratch (lazy-DFA transition tables and caches) lives per thread inside the compiled pattern and the crate cannot report
//! its size, but it is real heap: about 21 MB beside 3 MB of programs on the real-payload replay. So an entry also weighs
//! `daemon.workers` times `script.regex_scratch_bytes` (a calibrated typical use per pattern and thread; the cap
//! `script.regex_dfa_size_limit` is the worst case). Evicting a pattern drops the `Arc`, and its scratch goes with it.
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

/// The heap a search RESULT holds (its own allocation, not the regex's). A search is measured as a whole, and what it returns is
/// heap it kept too, so the result's size is taken off before the rest is counted as the pattern's scratch.
pub trait Kept {
    /// Bytes this value holds on the heap.
    fn kept_bytes(&self) -> usize;
}

impl Kept for bool {
    fn kept_bytes(&self) -> usize {
        0
    }
}

impl<T: Kept> Kept for Option<T> {
    fn kept_bytes(&self) -> usize {
        self.as_ref().map_or(0, Kept::kept_bytes)
    }
}

impl<T: Copy> Kept for Vec<T> {
    fn kept_bytes(&self) -> usize {
        self.capacity().saturating_mul(std::mem::size_of::<T>())
    }
}

/// A cached pattern and the search scratch it has been MEASURED to hold: the regex crate keeps lazy-DFA caches per thread inside the
/// compiled pattern and cannot report them, so each search is wrapped in the allocator's per-thread counters and the net change of
/// the heap, less the heap of the returned result ([`Kept`]), is applied here: growth when a search fills the cache, shrinkage when
/// it resets it. The total never goes below zero or above `daemon.workers` caches of `script.regex_dfa_size_limit` (what the
/// compile lets each thread keep), however many searches run. The cache reports program + this, never an estimate.
pub struct Entry {
    re: Regex,
    scratch: std::sync::atomic::AtomicU64,
}

impl std::ops::Deref for Entry {
    type Target = Regex;
    fn deref(&self) -> &Regex {
        &self.re
    }
}

impl Entry {
    /// The scratch this pattern is measured to hold now.
    pub fn scratch_bytes(&self) -> usize {
        self.scratch.load(std::sync::atomic::Ordering::Relaxed) as usize
    }

    /// Run `f` (one search) and apply the heap the REGEX kept to this pattern's scratch (the result `f` returns is not scratch).
    pub fn searched<R: Kept>(&self, f: impl FnOnce(&Regex) -> R) -> R {
        use std::sync::atomic::Ordering::Relaxed;
        let (r, d) = crate::mem::measure(|| f(&self.re));
        SEARCHES.fetch_add(1, Relaxed);
        if let Some(d) = d {
            MEASURED_SEARCHES.fetch_add(1, Relaxed);
            let net = d.retained.saturating_sub(i64::try_from(r.kept_bytes()).unwrap_or(i64::MAX));
            let cap = (defaults::num("daemon.workers")).saturating_mul(defaults::num("script.regex_dfa_size_limit"));
            let mut before = self.scratch.load(Relaxed);
            let after = loop {
                let next = before.saturating_add_signed(net).min(cap);
                match self.scratch.compare_exchange_weak(before, next, Relaxed, Relaxed) {
                    Ok(_) => break next,
                    Err(seen) => before = seen,
                }
            };
            if after > before {
                SCRATCH_BYTES.fetch_add(after - before, Relaxed);
            }
        }
        r
    }
}

fn scratch_of(e: &Arc<Entry>) -> usize {
    e.scratch.load(std::sync::atomic::Ordering::Relaxed) as usize
}

static SEARCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static MEASURED_SEARCHES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SCRATCH_BYTES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// (searches, searches measured, scratch bytes measured over all patterns ever cached).
pub fn search_totals() -> (u64, u64, u64) {
    use std::sync::atomic::Ordering::Relaxed;
    (SEARCHES.load(Relaxed), MEASURED_SEARCHES.load(Relaxed), SCRATCH_BYTES.load(Relaxed))
}

type Cache = BoundedCache<(String, String), Arc<Entry>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| {
        BoundedCache::with_extra(
            crate::mem::global(),
            Spec::new("regex", "mem.regex_soft_bytes", "mem.regex_hard_bytes", "mem.regex_low_water_pct").with_entries("mem.regex_max_entries"),
            Some(scratch_of),
        )
    })
}

/// (patterns held, bytes the cache reports: program weights plus the measured search scratch) for the memory snapshot.
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

/// What the per-thread search scratch of one cached pattern was once ASSUMED to hold (`status --memory` shows it next to the measurement; it no longer enters any weight).
pub(super) fn scratch_estimate() -> usize {
    (defaults::num("daemon.workers") as usize).saturating_mul(defaults::num("script.regex_scratch_bytes") as usize)
}

/// The compiled pattern for `(src, flags)`, from the shared cache or compiled now.
pub fn get(src: &str, flags: &str) -> rquickjs::Result<Arc<Entry>> {
    let key = (src.to_string(), flags.to_string());
    cache().get_or_compute(&key, || {
        let (re, weight) = compile(src, flags).ok_or_else(|| err("RegExp", defaults::render("script.msg_invalid_pattern", &[("src", &src)])))?;
        Ok((Arc::new(Entry { re, scratch: std::sync::atomic::AtomicU64::new(0) }), weight))
    })
}
