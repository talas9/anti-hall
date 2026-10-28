//! Per-call memory measurement: the bytes one call allocated, the most it grew the heap above where it started, and what it
//! kept. Built on the per-thread counters of [`crate::memstat`] (why those are hand-written: see that module), so it counts
//! the same unit (requested `Layout` sizes) under jemalloc and the system allocator, and counts the QuickJS runtime, whose
//! allocations go through Rust's allocator.
//!
//! Limits: only this thread is counted (a call that hands work to another thread is not followed); a block this call frees
//! that another window allocated makes `retained` negative; a block freed on a different thread than it was allocated on
//! skews that thread's net, so trust `alloc` and `peak` over `retained` for such calls. `None` when the knob is off, the
//! call is not sampled, or the counting allocator is not installed (a `diag` build, or a test binary without it).
use crate::memstat::{sample_this_call, set_thread_peak, thread_marks};

/// What one measured call did to the heap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delta {
    /// Bytes allocated during the call (a realloc counts its new size).
    pub alloc: u64,
    /// The most the net heap grew above its level at entry.
    pub peak: u64,
    /// Net at exit minus net at entry; negative when the call freed more than it allocated.
    pub retained: i64,
}

/// Restores the enclosing window's high-water mark, also when the measured call panics: the outer peak is the larger of its
/// own and everything this window reached.
struct Restore {
    outer_peak: i64,
}

impl Drop for Restore {
    fn drop(&mut self) {
        let (_, _, inner) = thread_marks();
        set_thread_peak(inner.max(self.outer_peak));
    }
}

/// Run `f` and report its [`Delta`]. Windows nest.
pub fn measure<R>(f: impl FnOnce() -> R) -> (R, Option<Delta>) {
    if !sample_this_call() {
        return (f(), None);
    }
    let (alloc0, net0, outer_peak) = thread_marks();
    set_thread_peak(net0);
    let guard = Restore { outer_peak };
    let r = f();
    let (alloc1, net1, peak1) = thread_marks();
    drop(guard);
    let delta = Delta { alloc: alloc1.wrapping_sub(alloc0), peak: peak1.saturating_sub(net0).max(0) as u64, retained: net1.saturating_sub(net0) };
    (r, Some(delta))
}
