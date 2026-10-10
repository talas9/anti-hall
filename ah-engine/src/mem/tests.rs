//! The memory module's contract: soft eviction to the low-water mark, hard refusal that still serves, a sustained over-limit
//! total asking for a restart, no flapping at a boundary. Every number here is the test's own config, not a default.
use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};

type Events = Arc<Mutex<Vec<Event>>>;

fn registry(cfg: &[(&str, u64)]) -> (Registry, Events) {
    let map: HashMap<String, u64> = cfg.iter().map(|(k, v)| ((*k).to_string(), *v)).collect();
    let events: Events = Arc::default();
    let sink = events.clone();
    let reg = Registry::new(Box::new(move |k| map.get(k).copied().unwrap_or(0)), Box::new(move |e| sink.lock().unwrap().push(e.clone())));
    (reg, events)
}

const SPEC: Spec = Spec::new("t", "t.soft", "t.hard", "t.low").with_entries("t.max");
const BASE: [(&str, u64); 5] = [("t.soft", 100), ("t.hard", 1000), ("t.low", 80), ("t.max", 0), ("mem.global_log_min_interval_ms", 0)];

fn kinds(e: &Events) -> Vec<Kind> {
    e.lock().unwrap().iter().map(|x| x.kind).collect()
}

#[test]
fn soft_eviction_goes_down_to_the_low_water_mark_oldest_first() {
    let (reg, events) = registry(&BASE);
    let c: BoundedCache<u32, u32> = BoundedCache::new(&reg, SPEC);
    for i in 0..9 {
        assert!(c.insert(i, i, 10));
    }
    assert_eq!((c.bytes(), c.len()), (90, 9), "under the soft limit nothing is evicted");
    assert!(c.insert(9, 9, 10), "the insert that reaches soft is still stored");
    // reaching 100 evicted down to 80 - 10 (room for the new entry), then stored: 80 bytes, the two oldest gone
    assert_eq!(c.bytes(), 80);
    assert!(c.get(&0).is_none() && c.get(&1).is_none() && c.get(&2).is_some() && c.get(&9).is_some());
    assert_eq!(kinds(&events), vec![Kind::Soft], "logged once");
    assert_eq!(reg.snapshot()["holders"][0]["soft_trips"], 1);
}

#[test]
fn a_hard_refusal_still_serves_the_request_and_recycles_the_holder() {
    let (reg, events) = registry(&[("t.soft", 100), ("t.hard", 150), ("t.low", 80), ("mem.global_log_min_interval_ms", 0)]);
    let c: BoundedCache<u32, String> = BoundedCache::new(&reg, SPEC);
    assert!(c.insert(1, "kept".into(), 40));
    // a 200-byte value can never fit under hard 150: computed, returned, not stored
    let got: Result<String, ()> = c.get_or_compute(&2, || Ok(("big".to_string(), 200)));
    assert_eq!(got, Ok("big".to_string()), "the caller is served");
    assert!(c.get(&2).is_none(), "the refused value is not stored");
    assert!(c.is_empty() && c.bytes() == 0, "the holder was recycled");
    let s = reg.snapshot();
    assert_eq!(
        (s["holders"][0]["hard_trips"].as_u64(), s["holders"][0]["refused"].as_u64(), s["holders"][0]["recycles"].as_u64()),
        (Some(1), Some(1), Some(1))
    );
    assert!(kinds(&events).contains(&Kind::Hard));
    // once recycled, normal inserts work again
    assert!(c.insert(3, "ok".into(), 10));
}

#[test]
fn a_compute_error_is_returned_and_nothing_is_stored() {
    let (reg, _) = registry(&BASE);
    let c: BoundedCache<u32, u32> = BoundedCache::new(&reg, SPEC);
    assert_eq!(c.get_or_compute(&1, || Err::<(u32, usize), _>("bad")), Err("bad"));
    assert!(c.is_empty());
}

#[test]
fn the_entry_count_cap_drops_the_least_recently_used() {
    let mut cfg = BASE.to_vec();
    cfg.retain(|(k, _)| *k != "t.max");
    cfg.push(("t.max", 3));
    let (reg, _) = registry(&cfg);
    let c: BoundedCache<u32, u32> = BoundedCache::new(&reg, SPEC);
    for i in 0..3 {
        c.insert(i, i, 1);
    }
    c.get(&0); // 1 is now the oldest
    c.insert(3, 3, 1);
    assert_eq!(c.len(), 3);
    assert!(c.get(&1).is_none() && c.get(&0).is_some());
}

struct Gauge {
    bytes: AtomicUsize,
    shrinks: AtomicUsize,
    recycles: AtomicUsize,
}

impl Owner for Gauge {
    fn bytes(&self) -> usize {
        self.bytes.load(SeqCst)
    }
    fn shrink(&self, _: usize) {
        self.shrinks.fetch_add(1, SeqCst);
    }
    fn recycle(&self) {
        self.recycles.fetch_add(1, SeqCst);
    }
}

fn gauge(reg: &Registry) -> (Arc<Gauge>, Budget) {
    let g = Arc::new(Gauge { bytes: AtomicUsize::new(0), shrinks: AtomicUsize::new(0), recycles: AtomicUsize::new(0) });
    let owner: Arc<dyn Owner> = g.clone();
    let b = reg.register(SPEC, Arc::downgrade(&owner));
    (g, b)
}

#[test]
fn a_holder_hovering_at_the_soft_limit_is_one_excursion_not_a_flapping_series() {
    let (reg, events) = registry(&BASE);
    let (g, b) = gauge(&reg);
    // the owner cannot shrink (a stub): usage hovers around the soft limit, dipping to 85 (above low water 80) and back
    for bytes in [100, 99, 100, 85, 100, 101, 90, 100, 100, 85, 100] {
        g.bytes.store(bytes, SeqCst);
        b.observe();
    }
    assert_eq!(reg.snapshot()["holders"][0]["soft_trips"], 1, "one trigger for the whole hover");
    assert_eq!(kinds(&events), vec![Kind::Soft]);
    // it re-arms only at or under the low-water mark, and then a new rise is a new excursion
    g.bytes.store(80, SeqCst);
    b.observe();
    g.bytes.store(100, SeqCst);
    b.observe();
    assert_eq!(reg.snapshot()["holders"][0]["soft_trips"], 2);
}

#[test]
fn log_lines_are_rate_limited_but_every_excursion_is_counted() {
    let mut cfg = BASE.to_vec();
    cfg.retain(|(k, _)| *k != "mem.global_log_min_interval_ms");
    cfg.push(("mem.global_log_min_interval_ms", 3_600_000));
    let (reg, events) = registry(&cfg);
    let (g, b) = gauge(&reg);
    for _ in 0..3 {
        g.bytes.store(100, SeqCst);
        b.observe();
        g.bytes.store(10, SeqCst);
        b.observe();
    }
    assert_eq!(reg.snapshot()["holders"][0]["soft_trips"], 3);
    assert_eq!(events.lock().unwrap().len(), 1, "one line per interval");
}

const GLOBAL: [(&str, u64); 5] = [
    ("mem.global_soft_bytes", 1000),
    ("mem.global_hard_bytes", 2000),
    ("mem.global_low_water_pct", 90),
    ("mem.global_restart_after_s", 60),
    ("mem.global_log_min_interval_ms", 0),
];

#[test]
fn a_process_total_that_stays_over_the_global_hard_limit_requests_a_restart() {
    let mut cfg = GLOBAL.to_vec();
    cfg.extend(BASE);
    let (reg, events) = registry(&cfg);
    let c: BoundedCache<u32, u32> = BoundedCache::new(&reg, SPEC);
    c.insert(1, 1, 10);
    assert!(reg.tick(1500, 0).is_none(), "over soft only: shrink, no restart");
    assert_eq!(c.len(), 1, "a shrink to the holder's low-water mark keeps what fits");
    assert!(reg.tick(2500, 1_000).is_none(), "first sight over hard: recover (recycle every holder)");
    assert!(c.is_empty(), "the recovery recycled the cache");
    assert!(!c.insert(2, 2, 10), "while the total is over the hard limit inserts are refused");
    assert!(reg.tick(2500, 30_000).is_none(), "not yet N seconds");
    // a dip below the limit but above its low-water mark (1800) does not reset the clock: it is the same excursion
    assert!(reg.tick(1900, 40_000).is_none());
    let r = reg.tick(2500, 62_000).expect("over hard for 61 s after the recovery");
    assert_eq!((r.holder.as_str(), r.usage, r.limit, r.secs), ("global", 2500, 2000, 61));
    assert!(reg.restart_requested());
    assert!(kinds(&events).contains(&Kind::Restart));
    assert!(reg.tick(2500, 90_000).is_none(), "asked once");
}

#[test]
fn recovering_below_the_low_water_mark_resets_the_restart_clock() {
    let mut cfg = GLOBAL.to_vec();
    cfg.extend(BASE);
    let (reg, _) = registry(&cfg);
    assert!(reg.tick(2500, 0).is_none());
    assert!(reg.tick(1000, 10_000).is_none(), "well under the limit: back to normal");
    assert!(reg.tick(2500, 20_000).is_none(), "a new excursion starts a new clock");
    assert!(reg.tick(2500, 70_000).is_none(), "50 s into the new excursion");
    assert!(reg.tick(2500, 81_000).is_some());
}

#[test]
fn a_holder_that_recycling_cannot_shrink_gets_the_daemon_restarted() {
    let mut cfg = GLOBAL.to_vec();
    cfg.extend([("t.soft", 100), ("t.hard", 200), ("t.low", 80), ("mem.global_log_min_interval_ms", 0)]);
    let (reg, _) = registry(&cfg);
    let (g, _b) = gauge(&reg); // a leak: recycle does nothing
    g.bytes.store(300, SeqCst);
    assert!(reg.tick(10, 0).is_none());
    assert!(reg.tick(10, 59_000).is_none());
    let r = reg.tick(10, 61_000).expect("still over its own hard limit");
    assert_eq!((r.holder.as_str(), r.usage, r.limit), ("t", 300, 200));
    assert!(g.recycles.load(SeqCst) == 0 || g.shrinks.load(SeqCst) > 0, "the soft trigger shrank it first");
}

#[test]
fn an_instance_is_told_to_shrink_at_soft_and_recycle_over_hard() {
    let (reg, events) = registry(&[("t.soft", 100), ("t.hard", 300), ("t.low", 90), ("mem.global_log_min_interval_ms", 0)]);
    let b = reg.register_instances(SPEC);
    let mut a = b.instance();
    let mut other = b.instance();
    assert_eq!(a.report(50), Action::None);
    assert_eq!(a.report(120), Action::Shrink(90));
    assert_eq!(a.report(110), Action::Shrink(90), "still above soft: shrink again, no second trigger");
    assert_eq!(other.report(60), Action::None, "limits apply to each instance");
    assert_eq!(a.report(400), Action::Recycle);
    assert_eq!(a.hard_limit(), 300);
    let s = reg.snapshot();
    assert_eq!(
        (s["holders"][0]["soft_trips"].as_u64(), s["holders"][0]["hard_trips"].as_u64(), s["holders"][0]["bytes"].as_u64()),
        (Some(1), Some(1), Some(460))
    );
    assert_eq!(kinds(&events), vec![Kind::Soft, Kind::Hard]);
    drop(a);
    assert_eq!(reg.snapshot()["holders"][0]["bytes"], 60, "a dropped instance leaves the sum");
}

#[test]
fn the_snapshot_reports_each_holder_against_its_limits_and_the_global_totals() {
    let mut cfg = GLOBAL.to_vec();
    cfg.extend(BASE);
    let (reg, _) = registry(&cfg);
    let c: BoundedCache<u32, u32> = BoundedCache::new(&reg, SPEC);
    c.insert(1, 1, 30);
    reg.tick(1234, 0);
    let s = reg.snapshot();
    let h = &s["holders"][0];
    assert_eq!(
        (h["name"].as_str(), h["bytes"].as_u64(), h["soft_bytes"].as_u64(), h["hard_bytes"].as_u64(), h["level"].as_str()),
        (Some("t"), Some(30), Some(100), Some(1000), Some("ok"))
    );
    assert_eq!(
        (s["global"]["process_bytes"].as_u64(), s["global"]["soft_trips"].as_u64(), s["global"]["registered_bytes"].as_u64()),
        (Some(1234), Some(1), Some(30))
    );
}

#[test]
fn leaked_bytes_accumulate() {
    let before = leaked_bytes();
    note_leak(7);
    assert!(leaked_bytes() >= before + 7);
}
