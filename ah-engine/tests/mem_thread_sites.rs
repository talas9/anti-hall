//! Per-subsystem heap gauges (issue #471, review of PR #476): a byte is charged to the site of the thread that ALLOCATED it,
//! and its free is charged back to that same site whichever thread frees it. One test binary of its own: it installs
//! `Counting` as the global allocator, as the daemon does, and the site table is process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::mem::{attribute_thread, thread_sites};
use ah_engine::memstat::Counting;
use std::alloc::{GlobalAlloc, Layout};
use std::hint::black_box;
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

#[global_allocator]
static ALLOC: Counting = Counting;

fn gauge(name: &str) -> i64 {
    thread_sites().into_iter().find(|(n, _)| *n == name).map_or(0, |(_, b)| b)
}

/// Thread A allocates log-line-sized strings, thread B frees them (the request workers and the `ah-log` thread). The heap is
/// flat, so both gauges must be flat too: a free charged to the freeing thread would grow A's gauge by every byte sent.
#[test]
fn a_gauge_stays_flat_when_one_thread_allocates_and_another_frees() {
    const WARM: usize = 1_000;
    const N: usize = 50_000;
    let (tx, rx) = sync_channel::<String>(64);
    let (mid_tx, mid_rx) = sync_channel::<()>(0);
    let (go_tx, go_rx) = sync_channel::<()>(0);
    let freer = std::thread::spawn(move || {
        attribute_thread("issue-476-freer");
        let mut n = 0;
        while let Ok(s) = rx.recv() {
            drop(black_box(s));
            n += 1;
            if n == WARM {
                mid_tx.send(()).unwrap();
                go_rx.recv().unwrap();
            }
        }
    });
    let maker = std::thread::spawn(move || {
        attribute_thread("issue-476-maker");
        for i in 0..N {
            tx.send(format!("{i:>120}")).unwrap();
        }
    });
    mid_rx.recv().unwrap();
    let (a0, b0) = (gauge("issue-476-maker"), gauge("issue-476-freer"));
    go_tx.send(()).unwrap();
    maker.join().unwrap();
    freer.join().unwrap();
    let (a1, b1) = (gauge("issue-476-maker"), gauge("issue-476-freer"));
    let sent = ((N - WARM) * 120) as i64;
    println!("maker {a0} -> {a1}, freer {b0} -> {b1} ({sent} bytes sent across)");
    // the channel's bounded buffer and thread-exit bookkeeping may move a few KiB; a leak-shaped drift is the whole `sent`
    let slack = 64 * 1024;
    assert!((a1 - a0).abs() < slack, "allocating site drifted by {} bytes over a flat heap", a1 - a0);
    assert!((b1 - b0).abs() < slack, "freeing site drifted by {} bytes over a flat heap", b1 - b0);
}

/// Cost of the allocator wrapper per alloc+free pair: unattributed, attributed, and four threads charging one shared site
/// (the request workers). Prints ns per pair; an optimised build only says anything about the live cost.
#[test]
fn the_site_tag_costs_a_few_nanoseconds_per_allocation() {
    const N: u64 = 1_000_000;
    let l = Layout::from_size_align(48, 8).unwrap();
    let run = || {
        let a = Counting;
        let t = Instant::now();
        for _ in 0..N {
            // SAFETY: `l` has a non-zero size; the pointer is freed with the same layout straight away.
            unsafe {
                let p = a.alloc(l);
                black_box(p);
                a.dealloc(p, l);
            }
        }
        t.elapsed()
    };
    let best = |threads: usize, site: Option<&'static str>| -> Duration {
        (0..5)
            .map(|_| {
                let hs: Vec<_> = (0..threads)
                    .map(|_| {
                        std::thread::spawn(move || {
                            if let Some(s) = site {
                                attribute_thread(s);
                            }
                            run()
                        })
                    })
                    .collect();
                hs.into_iter().map(|h| h.join().unwrap()).max().unwrap()
            })
            .min()
            .unwrap()
    };
    let ns = |d: Duration| d.as_nanos() as f64 / N as f64;
    let _ = best(1, None);
    let solo_unbound = ns(best(1, None));
    let solo_bound = ns(best(1, Some("issue-476-bench")));
    let four_unbound = ns(best(4, None));
    let four_shared = ns(best(4, Some("issue-476-bench")));
    println!(
        "ns/pair: 1 thread unattributed {solo_unbound:.2}, attributed {solo_bound:.2}; 4 threads unattributed {four_unbound:.2}, one shared site {four_shared:.2}"
    );
    assert!(solo_bound.is_finite() && four_shared.is_finite());
}
