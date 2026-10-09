//! Tests of the wake watcher's pure core and its reads: the edge-trigger state machine and its lines, the summary buckets, the
//! persisted cursor (including the shapes older builds wrote) and the update-announcement stamp. The watcher process itself is
//! compared with the Node watcher in `tests/it/wake_watch_parity.rs`.
use super::edge::{Snapshot, State, tick};
use super::read::{self, Hashes};
use crate::checks::jsport::json::J;
use std::path::{Path, PathBuf};

fn home(tag: &str) -> PathBuf {
    let d = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("test-wakew").join(format!("{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn snap(role: &str, total: Option<f64>) -> Snapshot {
    Snapshot { role: role.into(), id: "w1".into(), now_ms: 1_000.0, ok: true, total, ..Snapshot::default() }
}

fn child(total: f64, total2: Option<f64>, total3: Option<f64>) -> Snapshot {
    Snapshot { total2: Some(total2), total3: Some(total3), ..snap("child", Some(total)) }
}

#[test]
fn the_first_tick_arms_once_and_seeds_nothing_it_has_history_for() {
    let st = State { last_total: 5.0, ..State::default() };
    let (st, lines) = tick(&st, &snap("primary", Some(5.0)));
    assert_eq!(lines, vec!["[wake-watch] armed: watching primary w1 for new direct mesh mail and new mesh broadcasts (read-only, poll-based)."]);
    let (_, lines) = tick(&st, &snap("primary", Some(5.0)));
    assert!(lines.is_empty(), "armed already, nothing moved: {lines:?}");
}

#[test]
fn new_direct_mail_prints_one_line_with_the_delta_and_moves_the_cursor() {
    let armed = State { armed: true, last_total: 5.0, ..State::default() };
    let (st, lines) = tick(&armed, &snap("primary", Some(8.0)));
    assert_eq!(lines, vec!["[wake-watch] new mesh mail for primary w1: direct total 5 -> 8 (+3). Drain your own inbox on your next turn."]);
    assert_eq!(st.last_total, 8.0);
    let (_, lines) = tick(&st, &snap("primary", Some(8.0)));
    assert!(lines.is_empty());
}

#[test]
fn a_total_that_is_missing_never_moves_a_cursor_and_never_prints() {
    let armed = State { armed: true, last_total: 5.0, ..State::default() };
    let (st, lines) = tick(&armed, &snap("primary", None));
    assert!(lines.is_empty());
    assert_eq!(st.last_total, 5.0);
}

#[test]
fn both_child_channels_moving_in_one_tick_print_exactly_one_line() {
    let armed = State { armed: true, last_total: 1.0, last_total2: 2.0, ..State::default() };
    let (st, lines) = tick(&armed, &child(3.0, Some(7.0), None));
    assert_eq!(
        lines,
        vec!["[wake-watch] new mesh mail for child w1: ndjson total 1 -> 3 (+2), mesh-direct total 2 -> 7 (+5). Drain your own inbox on your next turn."]
    );
    assert_eq!((st.last_total, st.last_total2), (3.0, 7.0));
}

#[test]
fn one_child_channel_moving_names_its_channel() {
    let armed = State { armed: true, last_total: 1.0, last_total2: 2.0, ..State::default() };
    let (_, lines) = tick(&armed, &child(1.0, Some(4.0), None));
    assert_eq!(lines, vec!["[wake-watch] new mesh mail for child w1: mesh-direct direct total 2 -> 4 (+2). Drain your own inbox on your next turn."]);
    let (_, lines) = tick(&armed, &child(2.0, Some(2.0), None));
    assert_eq!(lines, vec!["[wake-watch] new mesh mail for child w1: ndjson direct total 1 -> 2 (+1). Drain your own inbox on your next turn."]);
}

#[test]
fn the_broadcast_cursor_follows_the_current_value_down_and_up() {
    let armed = State { armed: true, last_broadcast: 4.0, ..State::default() };
    let (st, lines) = tick(&armed, &child(0.0, Some(0.0), Some(1.0)));
    assert!(lines.is_empty(), "a drop is an ack elsewhere, not mail");
    assert_eq!(st.last_broadcast, 1.0, "resynced to the current value");
    let (st, lines) = tick(&st, &child(0.0, Some(0.0), Some(3.0)));
    assert_eq!(lines, vec!["[wake-watch] new mesh mail for child w1: broadcast direct total 1 -> 3 (+2). Drain your own inbox on your next turn."]);
    assert_eq!(st.last_broadcast, 3.0);
}

#[test]
fn a_counter_with_no_history_is_seeded_from_the_first_good_read_not_diffed() {
    let st = State { total_missing: true, total2_missing: true, broadcast_missing: true, ..State::default() };
    let (st, lines) = tick(&st, &child(40.0, Some(4691.0), Some(189.0)));
    assert_eq!(lines.len(), 1, "only the arm line: {lines:?}");
    assert_eq!((st.last_total, st.last_total2, st.last_broadcast), (40.0, 4691.0, 189.0));
    assert!(!st.total_missing && !st.total2_missing && !st.broadcast_missing);
    // a failed first read keeps the flags until a read works
    let st = State { total_missing: true, ..State::default() };
    let (st, _) = tick(&st, &Snapshot { ok: false, error: Some("x".into()), ..snap("child", None) });
    assert!(st.total_missing);
}

#[test]
fn read_errors_are_silent_up_to_the_tolerance_then_back_off_one_five_thirty_minutes() {
    let mut st = State { armed: true, ..State::default() };
    let bad = |now: f64| Snapshot { ok: false, error: Some("boom".into()), now_ms: now, ..snap("primary", None) };
    for i in 0..3 {
        let (n, lines) = tick(&st, &bad(f64::from(i)));
        assert!(lines.is_empty(), "failure {i} is within the tolerance");
        st = n;
    }
    let (n, lines) = tick(&st, &bad(10.0));
    assert_eq!(lines, vec!["[wake-watch] ERROR watching primary w1: 4 consecutive read failures (boom). Watcher still alive; will keep retrying."]);
    st = n;
    let (n, lines) = tick(&st, &bad(10.0 + 59_999.0));
    assert!(lines.is_empty(), "inside the first back-off");
    st = n;
    let (n, lines) = tick(&st, &bad(10.0 + 60_000.0));
    assert_eq!(lines.len(), 1, "the first repeat after a minute");
    assert_eq!(n.backoff_idx, 1);
    st = n;
    let (n, lines) = tick(&st, &bad(10.0 + 60_000.0 + 300_000.0));
    assert_eq!(lines.len(), 1, "the second after five minutes");
    assert_eq!(n.backoff_idx, 2);
    st = n;
    let (n, _) = tick(&st, &bad(10.0 + 60_000.0 + 300_000.0 + 1_800_000.0));
    assert_eq!(n.backoff_idx, 2, "thirty minutes forever");
    // recovery is silent and resets everything
    let (n, lines) = tick(&n, &snap("primary", Some(0.0)));
    assert!(lines.is_empty());
    assert_eq!((n.consec_errors, n.backoff_idx, n.last_error_emit_ms), (0.0, 0, None));
}

#[test]
fn an_error_without_a_reason_says_unknown_read_error() {
    let mut st = State { armed: true, consec_errors: 3.0, ..State::default() };
    let (n, lines) = tick(&st, &Snapshot { ok: false, error: None, ..snap("primary", None) });
    assert!(lines[0].contains("(unknown read error)"), "{lines:?}");
    st = n;
    assert_eq!(st.consec_errors, 4.0);
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn summary(h: &Path, hash: &str, id: &str, total: f64, bcast: Option<f64>) {
    let b = bcast.map_or(String::new(), |b| format!(",\"broadcastUnreadFromOthers\":{b}"));
    write(&read::summary_path(h, hash), &format!("{{\"workspaces\":{{\"{id}\":{{\"total\":{total}{b}}}}}}}"));
}

#[test]
fn the_repo_key_bucket_is_read_first_and_the_legacy_bucket_when_its_row_is_absent() {
    let h = home("buckets");
    let hashes = Hashes { repo_key: Some("proj-1234".into()), fallback: Some("deadbeef".into()) };
    // nothing yet: no data, not zero
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, None);
    summary(&h, "deadbeef", "w1", 9.0, None);
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, Some(9.0), "legacy bucket");
    summary(&h, "proj-1234", "w1", 12.0, None);
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, Some(12.0), "repo-key bucket wins");
    let none = read::read_direct(&h, None, "w1");
    assert!(!none.ok);
    assert_eq!(none.error.as_deref(), Some("unresolvable-repo-identity"));
}

#[test]
fn the_broadcast_count_comes_from_the_row_that_has_a_total_and_never_from_the_other_bucket() {
    let h = home("bcast");
    let hashes = Hashes { repo_key: Some("proj-1234".into()), fallback: Some("deadbeef".into()) };
    summary(&h, "proj-1234", "w1", 5.0, None); // an older writer: a row with a total but not the field
    summary(&h, "deadbeef", "w1", 7.0, Some(99.0));
    assert_eq!(read::read_broadcast(&h, Some(&hashes), "w1").total, None, "no data this tick, not the stale 99");
    summary(&h, "proj-1234", "w1", 5.0, Some(2.0));
    assert_eq!(read::read_broadcast(&h, Some(&hashes), "w1").total, Some(2.0));
}

#[test]
fn attaching_the_broadcast_channel_fails_closed_and_joins_the_reasons() {
    let h = home("attach");
    let s = Snapshot { ok: false, error: Some("ndjson: x".into()), ..snap("child", Some(1.0)) };
    let a = read::attach_broadcast(s, &h, None, "w1");
    assert!(!a.ok);
    assert_eq!(a.error.as_deref(), Some("ndjson: x; broadcast: unresolvable-repo-identity"));
    let ok = Snapshot { ok: true, ..snap("child", Some(1.0)) };
    let a = read::attach_broadcast(ok, &h, None, "w1");
    assert_eq!(a.error.as_deref(), Some("broadcast: unresolvable-repo-identity"));
    assert_eq!(a.total3, Some(None));
}

#[test]
fn a_summary_with_a_lone_surrogate_escape_still_reads() {
    let h = home("surrogate");
    // a message preview cut in the middle of an emoji is written like this and JavaScript reads it
    write(&read::summary_path(&h, "k"), "{\"recent\":[{\"body\":\"cut \\ud83d\"}],\"workspaces\":{\"w1\":{\"total\":3}}}");
    let hashes = Hashes { repo_key: Some("k".into()), fallback: None };
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, Some(3.0));
    // a valid pair is left alone
    write(&read::summary_path(&h, "p"), "{\"recent\":[{\"body\":\"\\ud83d\\ude00 \\\\ud83d\"}],\"workspaces\":{\"w1\":{\"total\":4}}}");
    let hashes = Hashes { repo_key: Some("p".into()), fallback: None };
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, Some(4.0));
}

#[test]
fn the_inbox_count_is_the_non_blank_lines_and_zero_when_unreadable() {
    let h = home("inbox");
    let p = h.join("in.ndjson");
    assert_eq!(read::count_messages(&p), 0.0);
    write(&p, "{\"a\":1}\n\n  \n{\"b\":2}\n{\"c\":3}");
    assert_eq!(read::count_messages(&p), 3.0);
}

#[test]
fn a_cursor_file_round_trips_per_role_and_carries_a_newer_builds_members_through() {
    let h = home("seen");
    let st = State { last_total: 4.0, last_total2: 9.0, last_broadcast: 2.0, ..State::default() };
    assert!(read::save_seen(&h, "w1", &st, false));
    let text = std::fs::read_to_string(read::seen_path(&h, "w1")).unwrap();
    assert_eq!(text, "{\"lastTotal\":4,\"lastTotal2\":9,\"lastBroadcastUnread\":2,\"meshTotal\":9,\"ndjsonTotal\":4}");
    let back = read::load_seen(&h, "w1", false);
    assert_eq!((back.last_total, back.last_total2, back.last_broadcast), (4.0, 9.0, 2.0));
    assert!(!back.total_missing && !back.total2_missing && !back.broadcast_missing);
    // the same file read as a Primary maps the mesh counter, never the NDJSON one
    let as_primary = read::load_seen(&h, "w1", true);
    assert_eq!((as_primary.last_total, as_primary.last_total2), (9.0, 9.0));
    // a newer build's member survives a rewrite by this one
    write(&read::seen_path(&h, "w1"), "{\"future\":{\"x\":1},\"lastTotal\":4,\"updateAnnouncedVersion\":\"1.2.3\"}");
    assert!(read::save_seen(&h, "w1", &st, false));
    let text = std::fs::read_to_string(read::seen_path(&h, "w1")).unwrap();
    assert!(text.starts_with("{\"future\":{\"x\":1},\"updateAnnouncedVersion\":\"1.2.3\",\"lastTotal\":4"), "{text}");
}

#[test]
fn older_cursor_shapes_load_with_the_right_baselines_and_missing_flags() {
    let h = home("legacy");
    let p = read::seen_path(&h, "w1");
    // no file at all: nothing is known
    let fresh = read::load_seen(&h, "w1", false);
    assert!(fresh.total_missing && fresh.total2_missing && fresh.broadcast_missing);
    // positional fields only (pre counter-keyed): a child keeps them as they are, the broadcast cursor is unknown
    write(&p, "{\"lastTotal\":7,\"lastTotal2\":30}");
    let child = read::load_seen(&h, "w1", false);
    assert_eq!((child.last_total, child.last_total2), (7.0, 30.0));
    assert!(child.broadcast_missing && !child.total_missing);
    // a Primary takes the larger of the two as its mesh baseline
    let primary = read::load_seen(&h, "w1", true);
    assert_eq!((primary.last_total, primary.last_total2), (30.0, 30.0));
    // a counter-keyed file written by a Primary: the child's NDJSON cursor is unknown (seeded, not diffed against zero)
    write(&p, "{\"lastTotal\":30,\"lastTotal2\":30,\"lastBroadcastUnread\":1,\"meshTotal\":30}");
    let child = read::load_seen(&h, "w1", false);
    assert_eq!((child.last_total, child.last_total2, child.last_broadcast), (0.0, 30.0, 1.0));
    assert!(child.total_missing && !child.broadcast_missing);
    // garbage: fresh
    write(&p, "[1,2");
    assert!(read::load_seen(&h, "w1", false).total_missing);
}

#[test]
fn an_update_is_announced_once_per_newer_version() {
    let h = home("announce");
    assert!(read::claim_update_announcement(&h, "w1", "1.2.3"));
    assert!(!read::claim_update_announcement(&h, "w1", "1.2.3"), "same version: already announced");
    assert!(!read::claim_update_announcement(&h, "w1", "1.2.2"), "older: never");
    assert!(read::claim_update_announcement(&h, "w1", "1.10.0"), "numeric, not lexical, order");
    let v = read::parse_json(&std::fs::read_to_string(read::seen_path(&h, "w1")).unwrap()).unwrap();
    assert_eq!(v.get("updateAnnouncedVersion"), Some(&J::Str("1.10.0".into())));
}
