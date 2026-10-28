//! `mem::measure` under the system allocator (`AH_ENGINE_ALLOCATOR=system`): the choice is made once before the first
//! allocation, so the test re-runs this binary with the variable set and checks the child's result.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report

use ah_engine::mem::measure;
use ah_engine::memstat::{Allocator, active_allocator};
use std::hint::black_box;

#[global_allocator]
static ALLOC: ah_engine::memstat::Counting = ah_engine::memstat::Counting;

const MIB: u64 = 1 << 20;
const CHILD: &str = "AH_TEST_MEASURE_SYSTEM_CHILD";

#[test]
fn measure_works_with_the_system_allocator() {
    if std::env::var_os(CHILD).is_none() {
        let exe = std::env::current_exe().unwrap();
        let out = std::process::Command::new(exe)
            .args(["--exact", "measure_works_with_the_system_allocator", "--nocapture", "--test-threads=1"])
            .env(CHILD, "1")
            .env("AH_ENGINE_ALLOCATOR", "system")
            .output()
            .unwrap();
        assert!(out.status.success(), "child failed: {}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
        return;
    }
    assert_eq!(active_allocator(), Allocator::System);
    let (v, d) = measure(|| vec![1u8; MIB as usize]);
    let d = d.expect("measurement");
    assert!(d.alloc >= MIB && d.peak >= MIB && d.retained >= MIB as i64, "{d:?}");
    let ((), d) = measure(move || drop(black_box(v)));
    assert!(d.expect("measurement").retained <= -(MIB as i64));
}
