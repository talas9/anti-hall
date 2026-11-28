use super::*;
use serde_json::json;

fn scratch(tag: &str) -> crate::db::TempDir {
    crate::db::TempDir::new(tag)
}

fn read(dir: &std::path::Path) -> Vec<Value> {
    rows(dir)
}

#[test]
fn every_configured_kind_yields_exactly_one_row() {
    let d = scratch("exit-kinds");
    let kinds = defaults::list("health.exit_kinds");
    assert!(!kinds.is_empty());
    for k in &kinds {
        append_in(&d.0, k, "why", 5, 1234, 42);
    }
    let r = read(&d.0);
    assert_eq!(r.len(), kinds.len());
    for (row, k) in r.iter().zip(&kinds) {
        assert_eq!(row[field("kind")], json!(k));
        assert_eq!(row[field("uptime")], json!(5));
        assert_eq!(row[field("rss")], json!(1234));
        assert_eq!(row[field("pid")], json!(42));
        assert_eq!(row[field("detail")], json!("why"));
    }
}

#[test]
fn unknown_kind_is_bounded_to_other() {
    let d = scratch("exit-other");
    append_in(&d.0, "made-up-kind", "x", 0, 0, 1);
    assert_eq!(read(&d.0)[0][field("kind")], json!(defaults::text("health.exit_kind_other")));
}

#[test]
fn ring_stays_within_its_row_and_byte_bounds() {
    let d = scratch("exit-bound");
    let rows_cap = defaults::num("health.exit_ring_rows") as usize;
    let long = "d".repeat(10_000);
    for i in 0..rows_cap + 40 {
        append_in(&d.0, "idle", &long, i as u64, 0, 1);
    }
    let r = read(&d.0);
    assert!(r.len() <= rows_cap);
    let bytes = std::fs::metadata(file(&d.0)).expect("ring file").len();
    assert!(bytes <= defaults::num("health.exit_ring_bytes"));
    let detail = r[0][field("detail")].as_str().expect("detail");
    assert_eq!(detail.chars().count() as u64, defaults::num("health.exit_detail_max"));
    // the newest row survives trimming
    assert_eq!(r.last().expect("row")[field("uptime")], json!((rows_cap + 39) as u64));
}

#[test]
fn summary_exposes_counts_and_only_the_last_n_rows() {
    let d = scratch("exit-summary");
    let n = defaults::num("health.exit_status_rows") as usize;
    for i in 0..n + 3 {
        append_in(&d.0, if i % 2 == 0 { "idle" } else { "rss" }, "x", i as u64, 0, 1);
    }
    let mut s = json!({});
    add_summary_in(&d.0, &mut s);
    assert_eq!(s[field("last")].as_array().expect("last").len(), n);
    let c = &s[field("counts")];
    assert_eq!(c["idle"].as_u64().unwrap_or(0) + c["rss"].as_u64().unwrap_or(0), (n + 3) as u64);
}

#[test]
fn first_noted_cause_wins_and_one_exit_records_once() {
    reset_for_test();
    let d = scratch("exit-once");
    // SAFETY: only this test in the module sets the state dir; it runs before any thread reads it.
    unsafe { std::env::set_var(defaults::env_name("dir"), &d.0) };
    note("sigterm", "SIGTERM");
    note("rss", "later cause");
    record_exit();
    record_exit();
    let r = read(&d.0);
    assert_eq!(r.len(), 1);
    assert_eq!(r[0][field("kind")], json!("sigterm"));
    assert_eq!(r[0][field("detail")], json!("SIGTERM"));
    reset_for_test();
}

#[test]
fn concurrent_recorders_each_keep_their_row() {
    let d = scratch("exit-concurrent");
    let n = 16;
    let dir = d.0.clone();
    let handles: Vec<_> = (0..n)
        .map(|i| {
            let dir = dir.clone();
            std::thread::spawn(move || append_in(&dir, "start_fail", "racing", i, 0, 100 + i as u32))
        })
        .collect();
    for h in handles {
        h.join().expect("recorder thread");
    }
    let r = read(&d.0);
    assert_eq!(r.len(), n as usize, "every concurrent record survives: {r:?}");
    let mut pids: Vec<u64> = r.iter().filter_map(|row| row[field("pid")].as_u64()).collect();
    pids.sort_unstable();
    assert_eq!(pids, (0..n).map(|i| 100 + i).collect::<Vec<_>>());
}

#[test]
fn a_stuck_lock_holder_skips_the_record_and_logs_instead_of_hanging() {
    let d = scratch("exit-stuck");
    let held = lock_ring(&d.0).expect("first lock");
    let t = Instant::now();
    append_in(&d.0, "idle", "blocked", 0, 0, 1);
    assert!(t.elapsed() < defaults::millis("health.exit_lock_wait_ms") * 20, "bounded wait");
    assert!(read(&d.0).is_empty(), "the record was skipped, not written unlocked");
    assert!(crate::discard::captured().iter().any(|(c, _)| c == defaults::text("health.exit_ring_lock_kind")), "the skip is logged");
    drop(held);
    append_in(&d.0, "idle", "free", 0, 0, 2);
    assert_eq!(read(&d.0).len(), 1);
}

#[test]
fn the_crashloop_kind_is_allowed_and_has_text() {
    let d = scratch("exit-crashloop");
    assert!(defaults::list("health.exit_kinds").contains(&"crashloop"));
    note("crashloop", defaults::text("health.exit_detail_crashloop"));
    let n = NOTED.lock().unwrap_or_else(|e| e.into_inner()).take();
    assert_eq!(n.as_ref().map(|(k, _)| k.as_str()), Some("crashloop"));
    append_in(&d.0, "crashloop", defaults::text("health.exit_detail_crashloop"), 0, 0, 7);
    assert_eq!(read(&d.0)[0][field("kind")], json!("crashloop"));
}
