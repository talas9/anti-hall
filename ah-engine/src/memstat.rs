//! Heap accounting for the daemon: a counting wrapper over the selected allocator.
//!
//! RSS alone cannot tell a leak from allocator retention from a one-off peak: the system allocator keeps freed pages, so
//! RSS stays at the largest transient the process ever reached. These counters give the live heap (what the program
//! holds now), the peak of it, and the number of allocations, so `status --memory` and the restart log line can say which
//! of the three it is. SQLite (bundled C) allocates through its own malloc and is not counted here.
//!
//! Cost: one once-only environment check, then one atomic read and three relaxed atomic operations per allocation.
use std::alloc::System;
use std::alloc::{GlobalAlloc, Layout};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

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
