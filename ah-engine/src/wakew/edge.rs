//! The pure core of the wake watcher: the edge-trigger state machine and the lines it emits. Port of `tick`, `tickInner`,
//! `normalizeState` and the `format*Line` functions of `companion/lib/devswarm-wake-watch.js`.
//!
//! No file, clock or process is touched here: the caller hands in the state and one snapshot (with its own clock reading) and
//! gets the new state and the lines to print. Every text and number comes from `wake_watch.*` in the shipped defaults.
use crate::checks::jsport::num::to_js_string;
use crate::defaults;

/// The edge-trigger state of one watcher. Totals are the doubles JavaScript holds.
#[derive(Clone, Debug, PartialEq)]
pub struct State {
    /// The arm line has been printed.
    pub armed: bool,
    /// Cursor of the first (NDJSON, or for a Primary the mesh summary) channel.
    pub last_total: f64,
    /// Cursor of the second (child mesh-direct) channel.
    pub last_total2: f64,
    /// Cursor of the broadcast channel (resynced to the current value, it can go down).
    pub last_broadcast: f64,
    /// No history was recorded for the first cursor: seed it from the first live read instead of diffing it.
    pub total_missing: bool,
    /// Same, second cursor.
    pub total2_missing: bool,
    /// Same, broadcast cursor.
    pub broadcast_missing: bool,
    /// Consecutive failed reads.
    pub consec_errors: f64,
    /// Index into the error back-off schedule.
    pub backoff_idx: usize,
    /// When the last error line was printed (`None`: never since the last recovery).
    pub last_error_emit_ms: Option<f64>,
    /// When the last new-mail wake was printed whose mail the workspace has not drained yet (GH #884: wake coalescing). `None`:
    /// no wake is outstanding, the next new mail wakes. Kept in memory only: a restarted watcher wakes on the next mail.
    pub woke_ms: Option<f64>,
    /// The mesh-direct total and the unread count at that wake: mail the workspace read since shows as unread below
    /// `woke_unread` plus what arrived since, and means the wake was used.
    pub woke_total2: f64,
    /// See `woke_total2`.
    pub woke_unread: f64,
    /// A wake was held and the workspace has not drained since: it is woken again once the re-wake window has passed, even
    /// when no further mail arrives.
    pub held_pending: bool,
    /// New-mail wake lines held back by the last tick (coalesced into the outstanding wake), for the caller's counter.
    pub held: u32,
    /// Wake lines the last tick printed for new mail (direct or inbox), for the caller's `mesh_wake_lines` counter (GH #845).
    pub woke_mail: u32,
    /// Wake lines the last tick printed for broadcasts, same counter.
    pub woke_broadcast: u32,
    /// The broadcast watermark (GH #845): the highest broadcast seq a line was printed for (or that was seeded); it never goes down,
    /// so a drain followed by a new arrival between two polls still wakes.
    pub last_bc_seq: f64,
    /// No watermark was saved (a fresh watcher, or a cursor file from a build before it): the first read with the watermark field
    /// reconciles instead of seeding silently, so pending eligible mail always wakes once.
    pub bc_seq_missing: bool,
    /// The eligible unread broadcast count at the last read (memory only, `None` before the first): an ack that lowers it while
    /// some stay unread wakes again (review P1-1), so a backlog the drain held back past its caps is drained too.
    pub last_bc_pending: Option<f64>,
}

impl Default for State {
    fn default() -> State {
        State {
            armed: false,
            last_total: 0.0,
            last_total2: 0.0,
            last_broadcast: 0.0,
            total_missing: false,
            total2_missing: false,
            broadcast_missing: false,
            consec_errors: 0.0,
            backoff_idx: 0,
            last_error_emit_ms: None,
            woke_ms: None,
            woke_total2: 0.0,
            woke_unread: 0.0,
            held_pending: false,
            held: 0,
            woke_mail: 0,
            woke_broadcast: 0,
            last_bc_seq: 0.0,
            bc_seq_missing: false,
            last_bc_pending: None,
        }
    }
}

/// One observation. `total2` and `total3` are `None` when the channel does not exist for this role (the key is absent), and
/// `Some(None)` when it exists but has no data yet.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    /// `primary` or `child`.
    pub role: String,
    /// The watched workspace id.
    pub id: String,
    /// The clock reading of this observation.
    pub now_ms: f64,
    /// The reads succeeded.
    pub ok: bool,
    /// Why they did not.
    pub error: Option<String>,
    /// First channel.
    pub total: Option<f64>,
    /// Second channel.
    pub total2: Option<Option<f64>>,
    /// Broadcast channel.
    pub total3: Option<Option<f64>>,
    /// Broadcast watermark channel (GH #845): `None` when the summary row predates it (the legacy `total3` count applies),
    /// `Some(None)` when nothing unread wakes the workspace, else the highest seq of the unread broadcasts that do.
    pub bc_seq: Option<Option<f64>>,
    /// How many unread broadcasts wake the workspace (display and the start-up reconcile only).
    pub bc_pending: Option<f64>,
    /// The workspace's direct mail it has not read yet (the summary's `directUnread`), `None` when unknown.
    pub unread: Option<f64>,
    /// Wake coalescing (GH #884, `devswarm.wakeWatchCoalesce`): `Some(ms)` when it applies to this watcher, the time after which a
    /// still-undrained workspace is woken again (`devswarm.wakeWatchRewakeMs`); `None` when off.
    pub coalesce_ms: Option<f64>,
}

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

fn role_of(s: &Snapshot) -> String {
    if s.role.is_empty() { text("wake_watch.word_unknown").to_string() } else { s.role.clone() }
}

fn id_of(s: &Snapshot) -> String {
    if s.id.is_empty() { text("wake_watch.word_unknown").to_string() } else { s.id.clone() }
}

/// `formatArmLine`
pub fn arm_line(s: &Snapshot) -> String {
    defaults::render("wake_watch.line_arm", &[("role", &role_of(s)), ("id", &id_of(s))])
}

/// `formatRefusalLine(reason)`: `reason` is one of the closed vocabulary in `wake_watch.reason_*`.
pub fn refusal_line(reason: &str) -> String {
    defaults::render("wake_watch.line_refused", &[("reason", &reason)])
}

/// `formatParentGoneLine()`
pub fn parent_gone_line() -> String {
    text("wake_watch.line_parent_gone").to_string()
}

/// `formatLockLostLine(reason)`
pub fn lock_lost_line(reason: &str) -> String {
    defaults::render("wake_watch.line_lock_lost", &[("reason", &reason)])
}

/// `formatWakeLine(snapshot, prev, total, opts)`: `label` is the channel word (`ndjson`, `mesh-direct`, `broadcast`), `None` for
/// the single-channel Primary case.
pub fn wake_line(s: &Snapshot, prev: f64, total: f64, label: Option<&str>) -> String {
    let label = label.map(|l| format!("{l}{}", text("wake_watch.label_sep"))).unwrap_or_default();
    defaults::render(
        "wake_watch.line_wake",
        &[
            ("role", &role_of(s)),
            ("id", &id_of(s)),
            ("label", &label),
            ("prev", &to_js_string(prev)),
            ("total", &to_js_string(total)),
            ("delta", &to_js_string(total - prev)),
        ],
    )
}

/// `formatDualWakeLine`
pub fn dual_wake_line(s: &Snapshot, prev: f64, total: f64, prev2: f64, total2: f64) -> String {
    defaults::render(
        "wake_watch.line_dual",
        &[
            ("role", &role_of(s)),
            ("id", &id_of(s)),
            ("prev", &to_js_string(prev)),
            ("total", &to_js_string(total)),
            ("delta", &to_js_string(total - prev)),
            ("prev2", &to_js_string(prev2)),
            ("total2", &to_js_string(total2)),
            ("delta2", &to_js_string(total2 - prev2)),
        ],
    )
}

/// `formatErrorLine`
pub fn error_line(s: &Snapshot, consec: f64) -> String {
    let err = s.error.clone().filter(|e| !e.is_empty()).unwrap_or_else(|| text("wake_watch.word_unknown_error").to_string());
    defaults::render("wake_watch.line_error", &[("role", &role_of(s)), ("id", &id_of(s)), ("n", &to_js_string(consec)), ("err", &err)])
}

fn backoff_ms(idx: usize) -> f64 {
    let list = defaults::raw("wake_watch.error_backoff_ms").as_array().unwrap_or_default();
    let tier = idx.min(list.len().saturating_sub(1));
    list.get(tier).and_then(defaults::V::as_integer).unwrap_or(0) as f64
}

fn backoff_len() -> usize {
    defaults::raw("wake_watch.error_backoff_ms").as_array().map_or(0, <[defaults::V]>::len)
}

/// Wake coalescing (GH #884): one wake per state change, not one per message. New mesh-direct mail is held when an earlier wake is
/// outstanding, inside `coalesce_ms`, and the workspace has read nothing since that wake (its unread count is at least the unread
/// count of the wake plus what arrived since). A workspace that read anything used its wake, so new mail wakes it again; one that
/// drained everything ends the outstanding wake. Unknown counts, or coalescing off: every new message wakes, as before.
fn hold(st: &State, snap: &Snapshot) -> bool {
    let (Some(rewake), Some(at), Some(unread), Some(Some(total2))) = (snap.coalesce_ms, st.woke_ms, snap.unread, snap.total2) else {
        return false;
    };
    snap.now_ms - at < rewake && unread > 0.0 && unread >= st.woke_unread + (total2 - st.woke_total2)
}

/// A wake line was printed: it is the outstanding wake when coalescing applies and both counts are known.
fn note_wake(st: &mut State, snap: &Snapshot) {
    st.held_pending = false;
    st.woke_ms = None;
    if let (Some(_), Some(unread), Some(Some(total2))) = (snap.coalesce_ms, snap.unread, snap.total2) {
        st.woke_ms = Some(snap.now_ms);
        st.woke_total2 = total2;
        st.woke_unread = unread;
    }
}

/// Review P1-2: the tick's lines were (`printed`) or were not all written out. A broadcast line that did not reach the workspace
/// must not move the watermark: the old one is kept and marked unknown (never saved), so the next tick prints again.
pub fn undo_unprinted(before: &State, mut after: State, printed: bool) -> State {
    if !printed && after.woke_broadcast > 0 {
        after.last_bc_seq = before.last_bc_seq;
        after.bc_seq_missing = true;
    }
    after
}

/// `tick(state, snapshot)` -> the new state and the lines to print.
pub fn tick(state: &State, snap: &Snapshot) -> (State, Vec<String>) {
    let mut st = state.clone();
    st.held = 0;
    st.woke_mail = 0;
    st.woke_broadcast = 0;
    let mut lines = Vec::new();
    let now = snap.now_ms;
    let arming = !st.armed;
    if !st.armed {
        st.armed = true;
        lines.push(arm_line(snap));
    }
    // SEED MISSING BASELINES: a counter with no recorded history is seeded from the first successful read, so a missing
    // baseline is a migration, never new mail.
    if snap.ok {
        if st.total_missing
            && let Some(t) = snap.total
        {
            st.last_total = t;
            st.total_missing = false;
        }
        if st.total2_missing
            && let Some(Some(t)) = snap.total2
        {
            st.last_total2 = t;
            st.total2_missing = false;
        }
        if st.broadcast_missing
            && let Some(Some(t)) = snap.total3
        {
            st.last_broadcast = t;
            st.broadcast_missing = false;
        }
    }
    if !snap.ok {
        st.consec_errors += 1.0;
        if st.consec_errors > defaults::num("wake_watch.error_tolerance") as f64 {
            let tier = st.backoff_idx.min(backoff_len().saturating_sub(1));
            let first = st.last_error_emit_ms.is_none();
            let due_ms = if first { 0.0 } else { backoff_ms(tier) };
            let due = first || st.last_error_emit_ms.is_some_and(|last| now - last >= due_ms);
            if due {
                lines.push(error_line(snap, st.consec_errors));
                if !first {
                    st.backoff_idx = (st.backoff_idx + 1).min(backoff_len().saturating_sub(1));
                }
                st.last_error_emit_ms = Some(now);
            }
        }
        return (st, lines);
    }
    // Recovery: reset the error state silently.
    if st.consec_errors > 0.0 {
        st.consec_errors = 0.0;
        st.backoff_idx = 0;
        st.last_error_emit_ms = None;
    }
    // the workspace read all its direct mail: no wake is outstanding any more
    if snap.unread.is_some_and(|u| u <= 0.0) {
        st.woke_ms = None;
        st.held_pending = false;
    }
    let has_channel2 = snap.total2.is_some();
    let total = snap.total;
    let total2 = snap.total2.flatten();
    let moved1 = total.is_some_and(|t| t > st.last_total);
    let moved2 = total2.is_some_and(|t| t > st.last_total2);
    // SINGLE-EMIT RULE: both channels advancing in one tick print exactly one line.
    let mut mail = None;
    if let (true, true, Some(t1), Some(t2)) = (moved1, moved2, total, total2) {
        mail = Some(dual_wake_line(snap, st.last_total, t1, st.last_total2, t2));
    } else if let (true, Some(t1)) = (moved1, total) {
        mail = Some(wake_line(snap, st.last_total, t1, has_channel2.then(|| text("wake_watch.label_ndjson"))));
    } else if let (true, Some(t2)) = (moved2, total2) {
        mail = Some(wake_line(snap, st.last_total2, t2, Some(text("wake_watch.label_mesh_direct"))));
    }
    let had_mail = mail.is_some();
    if let Some(line) = mail {
        // only mail on the mesh-direct channel alone is coalesced: the inbox channel moving, too, always wakes
        if moved2 && !moved1 && hold(&st, snap) {
            st.held += 1;
            st.held_pending = true;
        } else {
            lines.push(line);
            st.woke_mail += 1;
            note_wake(&mut st, snap);
        }
    } else if st.held_pending
        && let (Some(rewake), Some(at), Some(Some(t2))) = (snap.coalesce_ms, st.woke_ms, snap.total2)
        && snap.now_ms - at >= rewake
    {
        // held mail still unread after the re-wake window: one wake for all of it
        lines.push(wake_line(snap, st.woke_total2, t2, Some(text("wake_watch.label_mesh_direct"))));
        st.woke_mail += 1;
        note_wake(&mut st, snap);
    }
    // A (re)started watcher keeps no wake in memory, while the cursor a held wake moved past is saved: unread direct mail found
    // at arm with no new mail is treated as held behind an outstanding wake, so the re-wake still comes if it stays unread.
    if arming
        && !had_mail
        && let (Some(_), Some(unread), Some(Some(t2))) = (snap.coalesce_ms, snap.unread, snap.total2)
        && unread > 0.0
    {
        st.woke_ms = Some(now);
        st.woke_total2 = t2 - unread;
        st.woke_unread = 0.0;
        st.held_pending = true;
    }
    if moved1 && let Some(t) = total {
        st.last_total = t;
    }
    if moved2 && let Some(t) = total2 {
        st.last_total2 = t;
    }
    // The inbound count is a different metric from the raw total an older seen-file recorded and can read lower: resync DOWN
    // silently (never a wake) so the next genuinely new inbound message still fires.
    if let Some(t) = total.filter(|t| *t < st.last_total) {
        st.last_total = t;
    }
    if let Some(t) = total2.filter(|t| *t < st.last_total2) {
        st.last_total2 = t;
    }
    // BROADCAST CHANNEL: a third, independent observation, never merged into the dual-channel logic.
    let total3 = snap.total3.flatten();
    if let Some(seq) = snap.bc_seq {
        // GH #845 watermark: wake when the highest eligible unread seq passes the saved one (never on a count edge, which a drain
        // plus a new arrival between two polls would hide). A watcher with no saved watermark wakes once for pending eligible mail.
        let pending = snap.bc_pending.unwrap_or(0.0);
        // the line shows how many unread broadcasts wake the workspace (`0 -> N`), in the legacy line text
        let line = || wake_line(snap, 0.0, pending.max(1.0), Some(text("wake_watch.label_broadcast")));
        // review P1-2: a (re)armed watcher, or one with no trusted watermark, prints once for pending eligible mail, so a line lost
        // to a closed pipe or a restart after the watermark was saved still reaches the workspace
        let reacked = st.last_bc_pending.is_some_and(|was| pending > 0.0 && pending < was);
        if st.bc_seq_missing || arming {
            if pending > 0.0 {
                lines.push(line());
                st.woke_broadcast += 1;
            }
            st.bc_seq_missing = false;
            st.last_bc_seq = st.last_bc_seq.max(seq.unwrap_or(0.0));
        } else if let Some(s) = seq.filter(|s| *s > st.last_bc_seq) {
            lines.push(line());
            st.woke_broadcast += 1;
            st.last_bc_seq = s;
        } else if reacked {
            lines.push(line());
            st.woke_broadcast += 1;
        }
        st.last_bc_pending = Some(pending);
        // the legacy count stays in step silently, for a build that still reads it
        if let Some(t3) = total3 {
            st.last_broadcast = t3;
        }
        return (st, lines);
    }
    if let Some(t3) = total3
        && t3 > st.last_broadcast
    {
        lines.push(wake_line(snap, st.last_broadcast, t3, Some(text("wake_watch.label_broadcast"))));
        st.woke_broadcast += 1;
    }
    if snap.total3.is_some()
        && let Some(t3) = total3
    {
        st.last_broadcast = t3;
    }
    (st, lines)
}
