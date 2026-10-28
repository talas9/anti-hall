//! `mem::measure`: per-call allocated / peak / retained bytes from the counting allocator's per-thread counters (S2 of the
//! memory attribution work). The binary installs `Counting` as its global allocator, as the daemon does.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::mem::{Delta, measure};
use std::hint::black_box;

#[global_allocator]
static ALLOC: ah_engine::memstat::Counting = ah_engine::memstat::Counting;

const MIB: u64 = 1 << 20;

fn delta<R>(f: impl FnOnce() -> R) -> (R, Delta) {
    let (r, d) = measure(f);
    (r, d.expect("the counting allocator is installed, so a measurement exists"))
}

#[test]
fn a_one_mib_vec_that_is_dropped_counts_as_allocated_and_peak_but_not_retained() {
    let ((), d) = delta(|| {
        let v = vec![1u8; MIB as usize];
        black_box(&v);
        drop(v);
    });
    assert!(d.alloc >= MIB, "alloc {}", d.alloc);
    assert!(d.peak >= MIB, "peak {}", d.peak);
    assert!(d.retained.unsigned_abs() < 1024, "retained {}", d.retained);
}

#[test]
fn a_kept_vec_is_retained() {
    let (v, d) = delta(|| vec![1u8; MIB as usize]);
    assert!(d.retained >= MIB as i64, "retained {}", d.retained);
    assert!(d.peak >= MIB && d.alloc >= MIB);
    // freeing what an earlier window made is a negative retained delta
    let ((), freed) = delta(move || drop(v));
    assert!(freed.retained <= -(MIB as i64), "retained {}", freed.retained);
    assert_eq!(freed.alloc, 0);
}

#[test]
fn a_realloc_is_a_free_of_the_old_size_and_an_alloc_of_the_new() {
    let ((), d) = delta(|| {
        let mut v: Vec<u8> = vec![0; 1024];
        v.reserve_exact(MIB as usize);
        black_box(&v);
    });
    assert!(d.alloc >= MIB && d.peak >= MIB);
    assert!(d.retained.unsigned_abs() < 1024, "retained {}", d.retained);
}

#[test]
fn peak_is_the_growth_above_the_level_at_entry() {
    let keep = vec![0u8; 4 * MIB as usize];
    black_box(&keep);
    let ((), d) = delta(|| {
        let v = vec![1u8; MIB as usize];
        black_box(&v);
    });
    assert!(d.peak >= MIB && d.peak < 2 * MIB, "peak {} must not include the 4 MiB held before the window", d.peak);
}

#[test]
fn nested_windows_are_consistent() {
    let ((inner, outer_after_inner), outer) = delta(|| {
        let a = vec![1u8; MIB as usize];
        black_box(&a);
        let ((), inner) = delta(|| {
            let b = vec![2u8; 2 * MIB as usize];
            black_box(&b);
        });
        let c = vec![3u8; MIB as usize];
        black_box(&c);
        (inner, a.len() + c.len())
    });
    assert_eq!(outer_after_inner, 2 * MIB as usize);
    assert!(inner.alloc >= 2 * MIB && inner.peak >= 2 * MIB && inner.peak < 3 * MIB, "inner {inner:?}");
    assert!(inner.retained.unsigned_abs() < 1024);
    // the outer window includes the inner one's allocation; its peak is a (1 MiB) + the inner 2 MiB, ahead of c
    assert!(outer.alloc >= 4 * MIB, "outer {outer:?}");
    assert!(outer.peak >= 3 * MIB, "outer {outer:?}");
    assert!(outer.peak >= inner.peak);
    assert!(outer.retained.unsigned_abs() < 1024, "outer {outer:?}");
}

#[test]
fn a_thread_that_exits_after_measuring_does_not_crash() {
    for _ in 0..8 {
        let h = std::thread::spawn(|| {
            let ((), d) = delta(|| {
                black_box(vec![1u8; 64 * 1024]);
            });
            d.alloc
        });
        assert!(h.join().expect("thread") >= 64 * 1024);
    }
}

#[test]
fn a_panic_in_the_window_restores_the_outer_window() {
    let ((), outer) = delta(|| {
        let r = std::panic::catch_unwind(|| {
            measure(|| {
                black_box(vec![1u8; 3 * MIB as usize]);
                panic!("boom");
            })
        });
        assert!(r.is_err());
        black_box(vec![1u8; MIB as usize]);
    });
    assert!(outer.peak >= 3 * MIB, "the panicked window's growth still counts for the outer one: {outer:?}");
}

/// jemalloc's own per-thread byte counter is the oracle (usable sizes, so a little larger than requested sizes).
#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
#[test]
fn the_allocated_figure_matches_jemallocs_thread_counter() {
    use ah_engine::memstat::{Allocator, active_allocator};
    fn je_allocated() -> u64 {
        let mut p: *mut u64 = std::ptr::null_mut();
        let mut len = std::mem::size_of::<*mut u64>();
        // SAFETY: `thread.allocatedp` yields a pointer to this thread's u64 counter, written into `p` (`len` bytes).
        let rc = unsafe { tikv_jemalloc_sys::mallctl(c"thread.allocatedp".as_ptr(), (&mut p as *mut *mut u64).cast(), &mut len, std::ptr::null_mut(), 0) };
        assert_eq!(rc, 0);
        // SAFETY: jemalloc returned a valid pointer to the calling thread's counter, which lives as long as the thread.
        unsafe { *p }
    }
    if active_allocator() != Allocator::Jemalloc {
        return; // the system-allocator run (see mem_measure_system) has no jemalloc counter
    }
    let before = je_allocated();
    let ((), d) = delta(|| {
        // sizes that are jemalloc size classes, so usable == requested and the two units can be compared tightly
        for i in 0..64usize {
            black_box(vec![1u8; [64, 80, 96, 112][i % 4] * 1024]);
        }
    });
    let oracle = je_allocated() - before;
    assert!(d.alloc <= oracle, "requested {} must not exceed usable {oracle}", d.alloc);
    assert!(oracle - d.alloc <= oracle / 20, "requested {} vs jemalloc {oracle}: within 5%", d.alloc);
}
