//! The span recorder: ordering, cut reasons, the ring's bounds, the gap arithmetic and the off switch.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use std::time::Duration;

fn lim() -> Limits {
    Limits { ring_max: 1000, ring_max_bytes: 1 << 30, slow_keep: 3, slow_max_bytes: 1 << 30, slow_min_us: 0 }
}

/// A request of event `ev` with the given checks, each sleeping `ms` and ending with `reason`.
fn request(ev: &str, checks: &[(&str, u64, &'static str)], enabled: bool) -> Option<Summary> {
    begin_if(enabled, Instant::now(), Duration::from_micros(300));
    set_event_in(ev, "session-1", &["Stop", "T1", "T2", "T3", "T4", "T5", "T6", "T7"]);
    std::thread::sleep(Duration::from_millis(1));
    mark("spans.phase_read");
    for (name, ms, reason) in checks {
        begin_check(name, "spans.phase_select");
        std::thread::sleep(Duration::from_millis(*ms));
        end_check("allow", reason);
    }
    end_checks("spans.phase_post_checks");
    mark("spans.phase_encode");
    finish_with("spans.phase_finish", "spans.outcome_delivered", false, lim())
}

fn find(ev: &str) -> Value {
    let v = snapshot(&format!("n=200 event={ev}"));
    v["requests"].as_array().unwrap().first().cloned().unwrap_or(Value::Null)
}

#[test]
fn checks_are_recorded_in_the_order_they_ran_with_their_reasons() {
    request("T1", &[("alpha", 2, ""), ("beta", 1, "hard_deadline"), ("gamma", 1, "cpu_budget")], true).unwrap();
    let r = find("T1");
    let names: Vec<&str> = r["checks"].as_array().unwrap().iter().map(|c| c["check"].as_str().unwrap()).collect();
    assert_eq!(names, ["alpha", "beta", "gamma"]);
    let reasons: Vec<&str> = r["checks"].as_array().unwrap().iter().map(|c| c["reason"].as_str().unwrap()).collect();
    assert_eq!(reasons, [defaults::text("spans.reason_ran"), "hard_deadline", "cpu_budget"]);
    let starts: Vec<u64> = r["checks"].as_array().unwrap().iter().map(|c| c["start_us"].as_u64().unwrap()).collect();
    assert!(starts.windows(2).all(|w| w[0] < w[1]), "start offsets rise: {starts:?}");
    assert_eq!(r["queue_wait_us"], 300);
    assert_eq!(r["session"].as_str().unwrap().len(), defaults::num("telemetry.project_key_len") as usize, "only the session's hash is shown");
    assert_eq!(r["outcome"], defaults::text("spans.outcome_delivered"));
}

#[test]
fn the_gap_before_the_first_check_is_split_and_the_parts_sum_to_the_total() {
    request("T2", &[("a", 3, ""), ("b", 2, "")], true).unwrap();
    let r = find("T2");
    let sum = |k: &str| r[k].as_array().unwrap().iter().map(|p| p["us"].as_u64().unwrap()).sum::<u64>();
    let phases: Vec<&str> = r["pre"].as_array().unwrap().iter().map(|p| p["phase"].as_str().unwrap()).collect();
    assert_eq!(phases, [defaults::text("spans.phase_read"), defaults::text("spans.phase_select")]);
    assert_eq!(r["gap_us"].as_u64().unwrap(), 300 + sum("pre"), "the gap is the queue wait plus the pre-check phases");
    let checks: u64 = r["checks"].as_array().unwrap().iter().map(|c| c["wall_us"].as_u64().unwrap()).sum();
    let total = r["total_us"].as_u64().unwrap();
    let parts = sum("pre") + checks + sum("tail");
    assert!(parts <= total && total - parts == r["unaccounted_us"].as_u64().unwrap());
    // what is not in a phase or a check is only the loop between checks: well under the 2 ms slack of two sleeps
    assert!(r["unaccounted_us"].as_u64().unwrap() < 2000, "unaccounted {} of {total}", r["unaccounted_us"]);
}

#[test]
fn a_request_with_no_check_ends_its_gap_without_one() {
    request("T3", &[], true).unwrap();
    let r = find("T3");
    assert!(r["checks"].as_array().unwrap().is_empty());
    assert!(r["tail"].as_array().unwrap().iter().any(|p| p["phase"] == defaults::text("spans.phase_finish")));
}

#[test]
fn host_time_is_booked_to_the_running_check_by_kind() {
    begin_if(true, Instant::now(), Duration::ZERO);
    set_event_in("T4", "s", &["T4"]);
    begin_check("c1", "spans.phase_select");
    assert!(timing());
    note_host(0, 700, 600);
    note_host(0, 300, 0);
    note_host(2, 50, 50);
    end_check("block", "");
    assert!(!timing(), "no timing between checks");
    end_checks("spans.phase_post_checks");
    let s = finish_with("spans.phase_finish", "spans.outcome_cut", true, lim()).unwrap();
    assert_eq!(s.host, vec![(0, 1000, 600), (2, 50, 50)]);
    let r = find("T4");
    assert_eq!(r["checks"][0]["host"][kind_name(0)], json!({"us": 1000, "cpu_us": 600, "wait_us": 400, "calls": 2}));
    assert_eq!(r["checks"][0]["decision"], "block");
    assert_eq!(r["outcome"], defaults::text("spans.outcome_cut"));
    assert_eq!(r["late"], true);
}

#[test]
fn the_ring_never_holds_more_than_its_bounds() {
    let tight = Limits { ring_max: 4, ring_max_bytes: 1 << 30, slow_keep: 0, slow_max_bytes: 1 << 30, slow_min_us: 0 };
    let mut evicted = 0;
    for _ in 0..10 {
        begin_if(true, Instant::now(), Duration::ZERO);
        set_event_in("T5", "s", &["T5"]);
        begin_check("c", "spans.phase_select");
        end_check("allow", "");
        end_checks("spans.phase_post_checks");
        evicted += finish_with("spans.phase_finish", "spans.outcome_delivered", false, tight).unwrap().pushed.evicted;
    }
    let held = RING.lock().unwrap().recent.len();
    assert!(held <= 4, "ring_max enforced, held {held}");
    assert!(evicted >= 6, "evictions are reported: {evicted}");
    let bytes_cap = Limits { ring_max: 1000, ring_max_bytes: 1, slow_keep: 0, slow_max_bytes: 1 << 30, slow_min_us: 0 };
    begin_if(true, Instant::now(), Duration::ZERO);
    set_event_in("T5", "s", &["T5"]);
    finish_with("spans.phase_finish", "spans.outcome_delivered", false, bytes_cap).unwrap();
    let r = RING.lock().unwrap();
    assert_eq!(r.recent.len(), 1, "a byte bound keeps at least the newest span");
    assert_eq!(r.bytes, r.recent[0].bytes(), "the byte account matches what is held");
}

#[test]
fn the_slow_list_keeps_the_slowest_and_is_bounded() {
    let l = Limits { ring_max: 1, ring_max_bytes: 1 << 30, slow_keep: 2, slow_max_bytes: 1 << 30, slow_min_us: 0 };
    for ms in [1u64, 6, 3, 9] {
        begin_if(true, Instant::now(), Duration::ZERO);
        set_event_in("T6", "s", &["T6"]);
        std::thread::sleep(Duration::from_millis(ms));
        finish_with("spans.phase_finish", "spans.outcome_delivered", false, l).unwrap();
    }
    let v = snapshot("n=200 event=T6");
    let totals: Vec<u64> = v["requests"].as_array().unwrap().iter().map(|r| r["total_us"].as_u64().unwrap()).collect();
    assert!(totals.windows(2).all(|w| w[0] >= w[1]), "slowest first: {totals:?}");
    assert!(totals[0] >= 9000 && totals.iter().any(|t| *t >= 6000), "the slow ones survive a ring of one: {totals:?}");
    assert!(RING.lock().unwrap().slow.len() <= 2);
}

#[test]
fn disabled_records_nothing_and_an_unlisted_event_is_not_kept() {
    assert!(request("T7", &[("a", 1, "")], false).is_none());
    assert!(find("T7").is_null(), "disabled = zero spans");
    assert!(!timing());
    assert!(request("Other", &[("a", 1, "")], true).is_none(), "an event outside spans.events is not recorded");
    assert!(find("Other").is_null());
    // no begin at all (a hook or control request): marks and finish are no-ops
    mark("spans.phase_read");
    assert!(finish_with("spans.phase_finish", "spans.outcome_delivered", false, lim()).is_none());
}

#[test]
fn kinds_resolve_by_exact_name_and_unlisted_names_are_not_timed() {
    let name = |n: &str| kind_of(n).map(kind_name);
    assert_eq!(name("stateRead"), Some("store"));
    assert_eq!(name("meshUnion"), Some("mesh"));
    assert_eq!(name("meshAppBuilders"), Some("sqlite"));
    assert_eq!(name("jevAskSpec"), Some("jev"));
    assert_eq!(name("fileExec"), Some("exec"));
    assert_eq!(name("fileSize"), Some("fs"));
    assert_eq!(name("sleep"), Some("sleep"));
    assert_eq!(name("sessionBlocks"), Some("store"));
    assert_eq!(name("trackedAgents"), Some("transcript"));
    // what a prefix table misfiled: `pid` is not `piPid`, the cheap Jev switches are not the classifier
    assert_eq!((name("pid"), name("jevMode"), name("jevEnabled"), name("pathJoin")), (None, None, None, None));
    assert!(defaults::list("spans.kinds").len() <= 8);
}

#[test]
fn a_check_waits_off_cpu_only_and_the_host_split_adds_up() {
    begin_if(true, Instant::now(), Duration::ZERO);
    set_event_in("T8", "s", &["T8"]);
    begin_check("c", "spans.phase_select");
    std::thread::sleep(Duration::from_millis(5));
    note_host(0, 5000, 0); // slept inside a host call: all wait
    end_check("allow", "");
    end_checks("spans.phase_post_checks");
    finish_with("spans.phase_finish", "spans.outcome_delivered", false, lim()).unwrap();
    let c = &find("T8")["checks"][0];
    assert!(c["wait_us"].as_u64().unwrap() >= 4500, "{c}");
    assert_eq!(c["host_wait_us"], 5000);
    assert_eq!(c["other_wait_us"].as_u64().unwrap(), c["wait_us"].as_u64().unwrap().saturating_sub(5000));
    // a CPU-bound host call (cpu == wall) is no host wait, and the check's wait is not reduced by it
    begin_if(true, Instant::now(), Duration::ZERO);
    set_event_in("T8", "s", &["T8"]);
    begin_check("d", "spans.phase_select");
    note_host(5, 9000, 9000);
    end_check("allow", "");
    end_checks("spans.phase_post_checks");
    finish_with("spans.phase_finish", "spans.outcome_delivered", false, lim()).unwrap();
    let v = snapshot("n=200 event=T8");
    let d = v["requests"].as_array().unwrap().iter().find(|r| r["checks"][0]["check"] == "d").unwrap()["checks"][0].clone();
    assert_eq!(d["host_wait_us"], 0);
}

#[test]
fn the_slow_list_obeys_its_byte_bound_and_an_unrecorded_event_is_not_hashed() {
    let l = Limits { ring_max: 1, ring_max_bytes: 1 << 30, slow_keep: 50, slow_max_bytes: 1, slow_min_us: 0 };
    for _ in 0..4 {
        begin_if(true, Instant::now(), Duration::ZERO);
        set_event_in("T9", "s", &["T9"]);
        finish_with("spans.phase_finish", "spans.outcome_delivered", false, l).unwrap();
    }
    let r = RING.lock().unwrap();
    assert!(!r.slow.is_empty(), "a byte bound keeps at least the slowest span");
    assert_eq!(r.slow_bytes, r.slow.iter().map(Rec::bytes).sum::<usize>(), "the slow byte account matches what is held");
    drop(r);
    begin_if(true, Instant::now(), Duration::ZERO);
    set_event_in("Other", "session-x", &["T9"]);
    LIVE.with(|l| assert!(l.borrow().as_ref().unwrap().rec.session.is_empty(), "no hash for an event that is not recorded"));
    finish_with("spans.phase_finish", "spans.outcome_delivered", false, lim());
}

#[test]
fn the_shipped_phase_keys_all_exist() {
    for k in ["config", "read", "ack", "context", "handle", "parse", "plan", "select", "post_checks", "encode", "settle", "write", "finish"] {
        assert!(defaults::has(&format!("spans.phase_{k}")), "{k}");
    }
}

/// The bookkeeping cost of one recorded Stop-shaped request (8 phases, 6 checks, 4 host calls each, the ring push): the p50 and p99 per
/// request in nanoseconds. Run with `cargo test --release --lib spans_overhead -- --ignored --nocapture`.
#[test]
#[ignore = "a measurement, not a check"]
fn spans_overhead() {
    let ev = ["Stop"];
    let one = |on: bool| {
        let t = Instant::now();
        begin_if(on, Instant::now(), Duration::from_micros(200));
        set_event_in("Stop", "session-1", &ev);
        for p in ["spans.phase_read", "spans.phase_ack", "spans.phase_context", "spans.phase_handle", "spans.phase_parse", "spans.phase_plan"] {
            mark(p);
        }
        for c in ["a", "b", "c", "d", "e", "f"] {
            begin_check(c, "spans.phase_select");
            note_acquire(3);
            for k in 0..4u8 {
                if timing() {
                    note_host(k % 3, 5, 4);
                }
            }
            end_check("allow", "");
        }
        end_checks("spans.phase_post_checks");
        mark("spans.phase_encode");
        finish_with("spans.phase_finish", "spans.outcome_delivered", false, Limits { slow_min_us: u64::MAX, ..lim() });
        t.elapsed().as_nanos() as u64
    };
    for on in [true, false] {
        let mut v: Vec<u64> = (0..20000).map(|_| one(on)).collect();
        v.sort_unstable();
        eprintln!("spans on={on}: p50 {} ns, p99 {} ns per request", v[v.len() / 2], v[v.len() * 99 / 100]);
    }
}
