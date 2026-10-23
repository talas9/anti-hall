//! Heap accounting for the daemon: a counting wrapper over the selected allocator.
//!
//! RSS alone cannot tell a leak from allocator retention from a one-off peak: the system allocator keeps freed pages, so
//! RSS stays at the largest transient the process ever reached. These counters give the live heap (what the program
//! holds now), the peak of it, and the number of allocations, so `status --memory` and the restart log line can say which
//! of the three it is. SQLite (bundled C) allocates through its own malloc and is not counted here.
//!
//! Per call: three const-initialised, non-`Drop` thread-local `Cell`s count the bytes this thread allocated and freed and
//! the high-water mark of its net growth, so [`crate::mem::measure`] can report one call's allocated / peak / retained
//! bytes. They are hand-written, not read from the allocator, for three reasons: one unit (the requested `Layout` size,
//! the same unit as [`heap`]) across jemalloc and the system allocator; jemalloc's `thread.peak` is sampled every 64 KiB
//! of activity and does not exist in system mode; and jemalloc's `thread.allocatedp` counts usable sizes, so it serves only
//! as the oracle of the tests. A thread-local that is const-initialised and has no destructor is a plain TLS slot: no lazy
//! initialisation and no destructor registration, so nothing allocates inside the allocator.
//!
//! Cost: one once-only environment check, then one atomic read and three relaxed atomic operations per allocation, plus
//! (while `diagnostics.check_mem` is on) one relaxed flag read and three thread-local cell updates.
use std::alloc::System;
use std::alloc::{GlobalAlloc, Layout};
use std::cell::Cell;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};

/// The allocator selected for this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Allocator {
    /// jemalloc, where this build supports it.
    Jemalloc,
    /// The platform system allocator.
    System,
}

impl Allocator {
    /// Stable label used in diagnostics.
    pub fn as_str(self) -> &'static str {
        match self {
            Allocator::Jemalloc => "jemalloc",
            Allocator::System => "system",
        }
    }
}

/// jemalloc where the crate supports the target (it returns freed pages to the OS; the system allocators keep them, which left
/// RSS at 2.5x the live heap), plus the system allocator for `AH_ENGINE_ALLOCATOR=system`.
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
static JEMALLOC: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;
static SYSTEM: System = System;

static ACTIVE: OnceLock<Allocator> = OnceLock::new();

fn env_is_system() -> bool {
    let key = c"AH_ENGINE_ALLOCATOR";
    // SAFETY: `key` is a static NUL-terminated C string; `getenv` returns a borrowed pointer or null and allocates nothing.
    let p = unsafe { libc::getenv(key.as_ptr()) };
    if p.is_null() {
        return false;
    }
    let want = b"system";
    for (i, b) in want.iter().enumerate() {
        // SAFETY: `p` points at a NUL-terminated environment value. The loop reads at most `want.len() + 1` bytes.
        if unsafe { *p.add(i) } != *b as libc::c_char {
            return false;
        }
    }
    // SAFETY: as above; this confirms the value is exactly `system`.
    unsafe { *p.add(want.len()) == 0 }
}

fn choose() -> Allocator {
    #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
    {
        if env_is_system() { Allocator::System } else { Allocator::Jemalloc }
    }
    #[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu"))))]
    {
        Allocator::System
    }
}

/// The process allocator selected once from `AH_ENGINE_ALLOCATOR` (`jemalloc` default, `system` alternative).
pub fn active_allocator() -> Allocator {
    *ACTIVE.get_or_init(choose)
}

static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);
static ALLOCS: AtomicU64 = AtomicU64::new(0);

/// The counting allocator; the binary installs it with `#[global_allocator]`.
pub struct Counting;

// Per-thread counters (see the module comment). `const` initialisers and no `Drop`: reading or writing them never allocates.
thread_local! {
    static TL_ALLOC: Cell<u64> = const { Cell::new(0) };
    static TL_FREE: Cell<u64> = const { Cell::new(0) };
    static TL_PEAK: Cell<i64> = const { Cell::new(0) };
}

// `diagnostics.check_mem` and `diagnostics.check_mem_sample_every`, set by [`configure_measure`]. 1 is the identity (every call).
static MEASURE_ON: AtomicBool = AtomicBool::new(true);
static SAMPLE_EVERY: AtomicU64 = AtomicU64::new(1);
static SAMPLE_CALLS: AtomicU64 = AtomicU64::new(0);

fn net(alloc: u64, free: u64) -> i64 {
    alloc.wrapping_sub(free) as i64
}

fn grow(by: usize) {
    let live = LIVE.fetch_add(by as u64, Relaxed) + by as u64;
    PEAK.fetch_max(live, Relaxed);
    ALLOCS.fetch_add(1, Relaxed);
    if MEASURE_ON.load(Relaxed) {
        let alloc = TL_ALLOC.with(|c| {
            let a = c.get().wrapping_add(by as u64);
            c.set(a);
            a
        });
        let n = net(alloc, TL_FREE.with(Cell::get));
        TL_PEAK.with(|p| {
            if n > p.get() {
                p.set(n);
            }
        });
    }
}

fn shrink(by: usize) {
    LIVE.fetch_sub(by as u64, Relaxed);
    if MEASURE_ON.load(Relaxed) {
        TL_FREE.with(|c| c.set(c.get().wrapping_add(by as u64)));
    }
}

/// Set the per-call measurement knobs: `enabled` is `diagnostics.check_mem` (off also stops the per-thread counting in the
/// allocator), `every` is `diagnostics.check_mem_sample_every` (every Nth [`crate::mem::measure`] call measures; 0 reads as 1).
pub fn configure_measure(enabled: bool, every: u64) {
    MEASURE_ON.store(enabled, Relaxed);
    SAMPLE_EVERY.store(every.max(1), Relaxed);
    SAMPLE_CALLS.store(0, Relaxed);
}

/// Whether per-call measurement is switched on (`diagnostics.check_mem`, as last applied by [`configure_measure`]).
pub fn measure_enabled() -> bool {
    MEASURE_ON.load(Relaxed)
}

/// [`configure_measure`] from the shipped settings (`diagnostics.check_mem`, `diagnostics.check_mem_sample_every`).
pub fn configure_measure_from_defaults() {
    let on = crate::defaults::raw("diagnostics.check_mem").as_bool().unwrap_or_default();
    configure_measure(on, crate::defaults::num("diagnostics.check_mem_sample_every"));
}

/// Whether this `measure` call should measure: the knob is on, the counting allocator is installed (it has counted at least
/// one allocation; under `diag` dhat replaces it and nothing counts), and this is every Nth call.
pub(crate) fn sample_this_call() -> bool {
    if !MEASURE_ON.load(Relaxed) || ALLOCS.load(Relaxed) == 0 {
        return false;
    }
    let every = SAMPLE_EVERY.load(Relaxed);
    every <= 1 || SAMPLE_CALLS.fetch_add(1, Relaxed).is_multiple_of(every)
}

/// This thread's (bytes allocated, net bytes held, high-water mark of the net) since it started.
pub(crate) fn thread_marks() -> (u64, i64, i64) {
    let alloc = TL_ALLOC.with(Cell::get);
    (alloc, net(alloc, TL_FREE.with(Cell::get)), TL_PEAK.with(Cell::get))
}

/// Move this thread's high-water mark (a measurement window starts it at the current net; it ends by restoring the outer one).
pub(crate) fn set_thread_peak(peak: i64) {
    TL_PEAK.with(|p| p.set(peak));
}

// SAFETY: every method forwards to `INNER` unchanged and only adds to atomic counters, so the `GlobalAlloc`
// contract (layout, alignment, pointer validity) is exactly `INNER`'s.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for `l`.
        let p = match active_allocator() {
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
            Allocator::Jemalloc => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::alloc` call.
                unsafe { JEMALLOC.alloc(l) }
            }
            Allocator::System => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::alloc` call.
                unsafe { SYSTEM.alloc(l) }
            }
        };
        if !p.is_null() {
            grow(l.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        // SAFETY: as for `alloc`.
        let p = match active_allocator() {
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
            Allocator::Jemalloc => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::alloc_zeroed` call.
                unsafe { JEMALLOC.alloc_zeroed(l) }
            }
            Allocator::System => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::alloc_zeroed` call.
                unsafe { SYSTEM.alloc_zeroed(l) }
            }
        };
        if !p.is_null() {
            grow(l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: `p` came from this allocator with layout `l` (the caller's contract).
        match active_allocator() {
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
            Allocator::Jemalloc => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::dealloc` call.
                unsafe { JEMALLOC.dealloc(p, l) }
            }
            Allocator::System => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::dealloc` call.
                unsafe { SYSTEM.dealloc(p, l) }
            }
        }
        shrink(l.size());
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        // SAFETY: `p`, `l` and `new` satisfy `GlobalAlloc::realloc`'s contract (the caller's).
        let q = match active_allocator() {
            #[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
            Allocator::Jemalloc => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::realloc` call.
                unsafe { JEMALLOC.realloc(p, l, new) }
            }
            Allocator::System => {
                // SAFETY: forwarded unchanged from this unsafe `GlobalAlloc::realloc` call.
                unsafe { SYSTEM.realloc(p, l, new) }
            }
        };
        if !q.is_null() {
            shrink(l.size());
            grow(new);
        }
        q
    }
}

/// What the counters say now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Heap {
    /// Bytes allocated and not yet freed.
    pub live: u64,
    /// The most `live` has been.
    pub peak: u64,
    /// Allocations made since start.
    pub allocs: u64,
}

/// The counters (all zero when the counting allocator is not installed, as in the test binaries).
pub fn heap() -> Heap {
    Heap { live: LIVE.load(Relaxed), peak: PEAK.load(Relaxed), allocs: ALLOCS.load(Relaxed) }
}

/// Start a new peak window: the peak becomes the current live size (so a status call can report the peak since the
/// previous one).
pub fn reset_peak() {
    PEAK.store(LIVE.load(Relaxed), Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_are_stable() {
        assert_eq!(Allocator::Jemalloc.as_str(), "jemalloc");
        assert_eq!(Allocator::System.as_str(), "system");
    }
}
