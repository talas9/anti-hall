//! Heap accounting for the daemon: a counting wrapper over the system allocator.
//!
//! RSS alone cannot tell a leak from allocator retention from a one-off peak: the system allocator keeps freed pages, so
//! RSS stays at the largest transient the process ever reached. These counters give the live heap (what the program
//! holds now), the peak of it, and the number of allocations, so `status --memory` and the restart log line can say which
//! of the three it is. SQLite (bundled C) allocates through its own malloc and is not counted here.
//!
//! Cost: three relaxed atomic operations per allocation.
#[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu"))))]
use std::alloc::System;
use std::alloc::{GlobalAlloc, Layout};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// The allocator the counters wrap: jemalloc where the crate supports the target (it returns freed pages to the OS; the
/// system allocators keep them, which left RSS at 2.5x the live heap), else the system allocator.
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
static INNER: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;
#[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu"))))]
static INNER: System = System;

static LIVE: AtomicU64 = AtomicU64::new(0);
static PEAK: AtomicU64 = AtomicU64::new(0);
static ALLOCS: AtomicU64 = AtomicU64::new(0);

/// The counting allocator; the binary installs it with `#[global_allocator]`.
pub struct Counting;

fn grow(by: usize) {
    let live = LIVE.fetch_add(by as u64, Relaxed) + by as u64;
    PEAK.fetch_max(live, Relaxed);
    ALLOCS.fetch_add(1, Relaxed);
}

fn shrink(by: usize) {
    LIVE.fetch_sub(by as u64, Relaxed);
}

// SAFETY: every method forwards to `INNER` unchanged and only adds to atomic counters, so the `GlobalAlloc`
// contract (layout, alignment, pointer validity) is exactly `INNER`'s.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for `l`.
        let p = unsafe { INNER.alloc(l) };
        if !p.is_null() {
            grow(l.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        // SAFETY: as for `alloc`.
        let p = unsafe { INNER.alloc_zeroed(l) };
        if !p.is_null() {
            grow(l.size());
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        // SAFETY: `p` came from this allocator with layout `l` (the caller's contract).
        unsafe { INNER.dealloc(p, l) };
        shrink(l.size());
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        // SAFETY: `p`, `l` and `new` satisfy `GlobalAlloc::realloc`'s contract (the caller's).
        let q = unsafe { INNER.realloc(p, l, new) };
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
