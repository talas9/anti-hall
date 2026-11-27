//! Tests of the wake watcher's pure core and its reads: the edge-trigger state machine and its lines, the summary buckets, the
//! persisted cursor (including the shapes older builds wrote) and the update-announcement stamp. The watcher process itself is
//! compared with the Node watcher in `tests/it/wake_watch_parity.rs`.
use super::edge::{Snapshot, State, tick};
use super::read::{self, Hashes};
use crate::checks::jsport::json::J;
use std::path::{Path, PathBuf};

fn home(tag: &str) -> PathBuf {
    let d = crate::testtmp::child("test-wakew", format!("{tag}-{}", std::process::id()));
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
    write(&read::summary_path(h, hash), &format!("{{\"workspaces\":{{\"{id}\":{{\"total\":{total},\"directTotalFromOthers\":{total}{b}}}}}}}"));
}

/// A row with a `total` but no `directTotalFromOthers` (a degraded or old write) is "no data this tick": falling back to the raw
/// `total` switched series between ticks and read as "+215 new mail" (the Primary's own 215 sends).
#[test]
fn a_row_without_the_inbound_count_is_no_data_not_the_raw_total() {
    let h = home("inbound");
    let hashes = Hashes { repo_key: Some("k".into()), fallback: None };
    write(&read::summary_path(&h, "k"), "{\"workspaces\":{\"w1\":{\"total\":5421}}}");
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, None);
    write(&read::summary_path(&h, "k"), "{\"workspaces\":{\"w1\":{\"total\":5421,\"directTotalFromOthers\":5206}}}");
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, Some(5206.0));
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
    write(&read::summary_path(&h, "k"), "{\"recent\":[{\"body\":\"cut \\ud83d\"}],\"workspaces\":{\"w1\":{\"total\":3,\"directTotalFromOthers\":3}}}");
    let hashes = Hashes { repo_key: Some("k".into()), fallback: None };
    assert_eq!(read::read_direct(&h, Some(&hashes), "w1").total, Some(3.0));
    // a valid pair is left alone
    write(
        &read::summary_path(&h, "p"),
        "{\"recent\":[{\"body\":\"\\ud83d\\ude00 \\\\ud83d\"}],\"workspaces\":{\"w1\":{\"total\":4,\"directTotalFromOthers\":4}}}",
    );
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
    // GH #845: a known broadcast watermark is written with the cursor file version (the default state knows it: 0)
    assert_eq!(
        text,
        "{\"lastTotal\":4,\"lastTotal2\":9,\"lastBroadcastUnread\":2,\"lastBroadcastWakeSeq\":0,\"seenVersion\":2,\"meshTotal\":9,\"ndjsonTotal\":4}"
    );
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

// ---- wake coalescing (GH #884) ----------------------------------------------------------------------------------------------

fn mail(total2: f64, unread: Option<f64>, now_ms: f64, coalesce: Option<f64>) -> Snapshot {
    Snapshot { now_ms, unread, coalesce_ms: coalesce, ..child(0.0, Some(total2), None) }
}

/// One wake per state change: mail that lands while the workspace has read nothing since its last wake is held (the cursor moves,
/// so it never fires later as new mail); a drained inbox ends the outstanding wake. Before, every message printed a wake line and
/// each one cost the workspace a turn.
#[test]
fn new_mail_while_nothing_was_read_since_the_last_wake_is_held_and_a_drain_ends_it() {
    let on = Some(600_000.0);
    let armed = State { armed: true, ..State::default() };
    let (st, lines) = tick(&armed, &mail(1.0, Some(1.0), 1_000.0, on));
    assert_eq!(lines.len(), 1, "the first message wakes: {lines:?}");
    assert_eq!((st.held, st.woke_ms), (0, Some(1_000.0)));
    let (st, lines) = tick(&st, &mail(2.0, Some(2.0), 31_000.0, on));
    assert!(lines.is_empty(), "a second message, nothing read since the wake: held: {lines:?}");
    assert_eq!((st.held, st.last_total2, st.held_pending), (1, 2.0, true), "counted, and the cursor moved");
    let (st, lines) = tick(&st, &mail(2.0, Some(0.0), 40_000.0, on));
    assert!(lines.is_empty() && st.woke_ms.is_none() && !st.held_pending, "drained: no wake outstanding");
    let (st, lines) = tick(&st, &mail(3.0, Some(1.0), 50_000.0, on));
    assert_eq!((lines.len(), st.woke_ms), (1, Some(50_000.0)), "new mail after the drain wakes again: {lines:?}");
}

/// The advisor's case: woken for message 1, the workspace read it, but the watcher never saw an unread count of 0 (message 2 landed
/// before the summary was rewritten). The unread count is 1 again, yet it is new mail the workspace has not been woken for: it wakes.
#[test]
fn a_workspace_that_read_its_mail_since_the_wake_is_woken_for_the_next_one_even_at_the_same_unread_count() {
    let on = Some(600_000.0);
    let armed = State { armed: true, ..State::default() };
    let (st, _) = tick(&armed, &mail(1.0, Some(1.0), 1_000.0, on));
    let (st, lines) = tick(&st, &mail(2.0, Some(1.0), 20_000.0, on));
    assert_eq!((lines.len(), st.held), (1, 0), "message 1 was read (2 arrived, 1 unread): woken for message 2: {lines:?}");
}

/// Held mail that is still unread when the re-wake window passes wakes the workspace again on a tick with no new mail.
#[test]
fn held_mail_still_unread_after_the_rewake_window_wakes_once_without_new_mail() {
    let on = Some(600_000.0);
    let armed = State { armed: true, ..State::default() };
    let (st, _) = tick(&armed, &mail(1.0, Some(1.0), 1_000.0, on));
    let (st, held) = tick(&st, &mail(2.0, Some(2.0), 2_000.0, on));
    assert!(held.is_empty() && st.held_pending);
    let (st, lines) = tick(&st, &mail(2.0, Some(2.0), 300_000.0, on));
    assert!(lines.is_empty(), "inside the window: still held: {lines:?}");
    let (st, lines) = tick(&st, &mail(2.0, Some(2.0), 601_000.0, on));
    assert_eq!(lines, vec!["[wake-watch] new mesh mail for child w1: mesh-direct direct total 1 -> 2 (+1). Drain your own inbox on your next turn."]);
    assert!(!st.held_pending && st.woke_ms == Some(601_000.0));
    let (_, lines) = tick(&st, &mail(2.0, Some(2.0), 1_300_000.0, on));
    assert!(lines.is_empty(), "nothing held any more: no repeat: {lines:?}");
}

#[test]
fn without_coalescing_or_an_unread_count_every_message_wakes() {
    let armed = State { armed: true, ..State::default() };
    // coalescing off (devswarm.wakeWatchCoalesce false, or a Primary watcher)
    let (st, a) = tick(&armed, &mail(1.0, Some(1.0), 1_000.0, None));
    let (_, b) = tick(&st, &mail(2.0, Some(2.0), 2_000.0, None));
    assert_eq!((a.len(), b.len()), (1, 1));
    // the summary row has no unread count: never held
    let on = Some(600_000.0);
    let (st, a) = tick(&armed, &mail(1.0, None, 1_000.0, on));
    let (_, b) = tick(&st, &mail(2.0, None, 2_000.0, on));
    assert_eq!((a.len(), b.len()), (1, 1));
}

#[test]
fn the_direct_read_carries_the_rows_unread_count() {
    let h = home("unread");
    write(&read::summary_path(&h, "rk"), r#"{"workspaces":{"w1":{"total":9,"directTotalFromOthers":7,"directUnread":2}}}"#);
    let hashes = Hashes { repo_key: Some("rk".into()), fallback: None };
    let d = read::read_direct(&h, Some(&hashes), "w1");
    assert_eq!((d.total, d.unread), (Some(7.0), Some(2.0)));
    let coalesce = crate::defaults::list("wake_watch.coalesce_roles");
    assert_eq!(coalesce, vec!["child"], "the Primary's own mail is not coalesced");
}

/// A restarted watcher (a deploy re-execs it) keeps no wake in memory, but the cursor a held wake moved past was saved: unread mail
/// found at arm, with no new mail, still gets the one re-wake after the window. New mail at arm wakes at once, as before.
#[test]
fn a_restarted_watcher_still_re_wakes_mail_that_was_held_before_the_restart() {
    let on = Some(600_000.0);
    let saved = State { last_total2: 5.0, ..State::default() };
    let (st, lines) = tick(&saved, &mail(5.0, Some(2.0), 1_000.0, on));
    assert_eq!(lines.len(), 1, "only the arm line: {lines:?}");
    assert!(st.held_pending);
    let (st, lines) = tick(&st, &mail(5.0, Some(2.0), 300_000.0, on));
    assert!(lines.is_empty(), "inside the window: {lines:?}");
    let (st, lines) = tick(&st, &mail(5.0, Some(2.0), 601_000.0, on));
    assert_eq!(lines, vec!["[wake-watch] new mesh mail for child w1: mesh-direct direct total 3 -> 5 (+2). Drain your own inbox on your next turn."]);
    let (_, lines) = tick(&st, &mail(5.0, Some(2.0), 1_300_000.0, on));
    assert!(lines.is_empty(), "one re-wake only: {lines:?}");
    // mail that arrived while the watcher was down wakes on the arm tick, never held
    let (_, lines) = tick(&saved, &mail(6.0, Some(3.0), 1_000.0, on));
    assert_eq!(lines.len(), 2, "arm line and a wake: {lines:?}");
    // coalescing off: nothing is seeded
    let (st, _) = tick(&saved, &mail(5.0, Some(2.0), 1_000.0, None));
    assert!(!st.held_pending);
}

/// GH #845 phase 0: each tick reports how many wake lines it printed per channel (mail, broadcast) for the `mesh_wake_lines` counter;
/// the arm line and a held (coalesced) wake are not counted, and the counts reset every tick.
#[test]
fn each_tick_counts_its_wake_lines_per_channel() {
    let armed = State { armed: true, last_total: 1.0, last_total2: 2.0, last_broadcast: 0.0, ..State::default() };
    let (st, lines) = tick(&armed, &child(1.0, Some(3.0), Some(2.0)));
    assert_eq!(lines.len(), 2, "{lines:?}");
    assert_eq!((st.woke_mail, st.woke_broadcast), (1, 1));
    let (st, lines) = tick(&st, &child(1.0, Some(3.0), Some(2.0)));
    assert!(lines.is_empty());
    assert_eq!((st.woke_mail, st.woke_broadcast), (0, 0), "nothing moved: the counts reset");
    let fresh = State { total_missing: true, total2_missing: true, broadcast_missing: true, ..State::default() };
    let (st, lines) = tick(&fresh, &child(1.0, Some(3.0), Some(2.0)));
    assert_eq!(lines.len(), 1, "only the arm line: {lines:?}");
    assert_eq!((st.woke_mail, st.woke_broadcast), (0, 0), "the arm line is not a wake");
}

fn bc(seq: Option<f64>, pending: f64) -> Snapshot {
    Snapshot { bc_seq: Some(seq), bc_pending: Some(pending), ..child(1.0, Some(1.0), Some(pending)) }
}

/// GH #845 (Codex P0-1): the broadcast channel wakes on the watermark, so a drain followed by a new arrival between two polls (the
/// unread count stays 1) still wakes.
#[test]
fn a_drain_plus_a_new_arrival_between_polls_still_wakes() {
    let st = State { armed: true, last_total: 1.0, last_total2: 1.0, last_bc_seq: 0.0, ..State::default() };
    let (st, lines) = tick(&st, &bc(Some(100.0), 1.0));
    assert_eq!((lines.len(), st.last_bc_seq), (1, 100.0));
    // the reader drained seq 100 and seq 105 arrived before the next poll: pending is 1 again, the seq moved
    let (st, lines) = tick(&st, &bc(Some(105.0), 1.0));
    assert_eq!((lines.len(), st.last_bc_seq), (1, 105.0), "{lines:?}");
    // drained, nothing new: the watermark never goes down and nothing prints
    let (st, lines) = tick(&st, &bc(None, 0.0));
    assert_eq!((lines.len(), st.last_bc_seq), (0, 105.0));
    let (_, lines) = tick(&st, &bc(Some(105.0), 1.0));
    assert!(lines.is_empty(), "a row at or under the watermark was already woken for");
}

/// A fresh or pre-watermark watcher wakes once for pending eligible mail instead of seeding it away, and seeds silently when none.
#[test]
fn a_missing_watermark_reconciles_pending_mail_instead_of_seeding_it() {
    let st = State { armed: true, last_total: 1.0, last_total2: 1.0, bc_seq_missing: true, ..State::default() };
    let (after, lines) = tick(&st, &bc(Some(42.0), 2.0));
    assert_eq!((lines.len(), after.last_bc_seq, after.bc_seq_missing), (1, 42.0, false));
    let (after, lines) = tick(&st, &bc(None, 0.0));
    assert_eq!((lines.len(), after.bc_seq_missing), (0, false));
}

/// A summary row without the watermark field (an older writer) keeps the legacy count channel.
#[test]
fn a_row_without_the_watermark_uses_the_legacy_count() {
    let st = State { armed: true, last_total: 1.0, last_total2: 1.0, last_broadcast: 0.0, ..State::default() };
    let (_, lines) = tick(&st, &child(1.0, Some(1.0), Some(2.0)));
    assert_eq!(lines.len(), 1);
}

/// The watermark survives a restart only in a cursor file of this version.
#[test]
fn the_watermark_round_trips_through_the_cursor_file() {
    let h = home("bcseq");
    let st = State { last_total: 3.0, last_total2: 4.0, last_bc_seq: 77.0, ..State::default() };
    assert!(read::save_seen(&h, "w1", &st, false));
    let back = read::load_seen(&h, "w1", false);
    assert_eq!((back.last_bc_seq, back.bc_seq_missing), (77.0, false));
    let unknown = State { bc_seq_missing: true, ..st };
    assert!(read::save_seen(&h, "w2", &unknown, false));
    assert!(read::load_seen(&h, "w2", false).bc_seq_missing, "an unknown watermark is never saved as 0");
}

/// Review P1-1: an ack that leaves eligible broadcasts unread (the drain held some back past its caps) wakes again, so the
/// backlog is drained; a drain that leaves the count unchanged (it listed the held rows) does not.
#[test]
fn an_ack_that_leaves_eligible_rows_unread_wakes_again() {
    let st = State { armed: true, last_total: 1.0, last_total2: 1.0, last_bc_seq: 0.0, ..State::default() };
    let (st, lines) = tick(&st, &bc(Some(120.0), 120.0));
    assert_eq!(lines.len(), 1);
    // the drain acked 100 of them, 20 remain unread at or under the watermark
    let (st, lines) = tick(&st, &bc(Some(120.0), 20.0));
    assert_eq!((lines.len(), st.woke_broadcast), (1, 1), "a re-wake for the rest: {lines:?}");
    let (st, lines) = tick(&st, &bc(Some(120.0), 20.0));
    assert!(lines.is_empty(), "no new ack, no new line");
    let (_, lines) = tick(&st, &bc(None, 0.0));
    assert!(lines.is_empty(), "all read");
}

