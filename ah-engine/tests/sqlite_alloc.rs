//! libc retention: SQLite (bundled, calls the C library's `malloc`) left about 8 MB of freed pages resident in the daemon after a
//! burst. `sqlalloc::route_through_global_allocator` sends its allocations to the process allocator (jemalloc with the daemon's decay
//! settings), which hands freed pages back as they are freed. Measured on the process footprint, the figure the memory budget
//! compares, in two child processes (SQLite takes its allocator once per process): C library vs routed.
//! One test binary of its own: the footprint is process-wide.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report
#![allow(clippy::panic, clippy::unreachable)] // integration tests: a panic is the failure report
#![cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))] // where the daemon runs jemalloc

use ah_engine::{limits, sqlalloc};

// the daemon's allocator: the counting wrapper over jemalloc (tuned by `MALLOC_CONF` below), so the routed run is the daemon's run
#[global_allocator]
static ALLOC: ah_engine::memstat::Counting = ah_engine::memstat::Counting;

const MODE: &str = "AH_TEST_SQLITE_ALLOC";

/// A cache-sized burst: fill an in-memory database well past its page cache with 2 KB rows, then close it. Returns (footprint kB
/// before, footprint kB after the connection is gone).
fn burst() -> (u64, u64) {
    let base = limits::footprint_kb().unwrap();
    {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.pragma_update(None, "cache_size", -60_000).unwrap();
        c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, b BLOB)").unwrap();
        let tx = c.unchecked_transaction().unwrap();
        for _ in 0..20_000 {
            tx.execute("INSERT INTO t (b) VALUES (zeroblob(2000))", []).unwrap();
        }
        tx.commit().unwrap();
        c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap();
    }
    (base, limits::footprint_kb().unwrap())
}

#[test]
fn child() {
    let Ok(mode) = std::env::var(MODE) else { return };
    if mode == "routed" {
        assert!(sqlalloc::route_through_global_allocator(), "SQLite had already started");
        assert!(sqlalloc::routed());
    }
    let (base, after) = burst();
    println!("RESULT {mode} base_kb={base} after_kb={after} held_kb={}", after.saturating_sub(base));
}

fn run(mode: &str) -> u64 {
    let out = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["child", "--exact", "--nocapture"])
        .env(MODE, mode)
        .env("MALLOC_CONF", "narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0,tcache_max:1024")
        .env("_RJEM_MALLOC_CONF", "narenas:1,dirty_decay_ms:0,muzzy_decay_ms:0,tcache_max:1024")
        .output()
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let line = text
        .lines()
        .find(|l| l.starts_with("RESULT"))
        .unwrap_or_else(|| panic!("no result from the {mode} child: {text} {}", String::from_utf8_lossy(&out.stderr)));
    eprintln!("{line}");
    line.split("held_kb=").nth(1).unwrap().trim().parse().unwrap()
}

#[test]
fn routed_sqlite_hands_its_burst_back_where_the_c_library_keeps_it() {
    if std::env::var(MODE).is_ok() {
        return;
    }
    let libc_held = run("libc");
    let routed_held = run("routed");
    assert!(libc_held > 8 * 1024, "the C library kept {libc_held} kB: the burst is too small to measure anything");
    assert!(routed_held * 4 < libc_held, "routed {routed_held} kB held after the burst against {libc_held} kB on the C library");
}
