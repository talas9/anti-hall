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

/// `tick(state, snapshot)` -> the new state and the lines to print.
pub fn tick(state: &State, snap: &Snapshot) -> (State, Vec<String>) {
    let mut st = state.clone();
    let mut lines = Vec::new();
    let now = snap.now_ms;
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
    let has_channel2 = snap.total2.is_some();
    let total = snap.total;
    let total2 = snap.total2.flatten();
    let moved1 = total.is_some_and(|t| t > st.last_total);
    let moved2 = total2.is_some_and(|t| t > st.last_total2);
    // SINGLE-EMIT RULE: both channels advancing in one tick print exactly one line.
    if let (true, true, Some(t1), Some(t2)) = (moved1, moved2, total, total2) {
        lines.push(dual_wake_line(snap, st.last_total, t1, st.last_total2, t2));
    } else if let (true, Some(t1)) = (moved1, total) {
        lines.push(wake_line(snap, st.last_total, t1, has_channel2.then(|| text("wake_watch.label_ndjson"))));
    } else if let (true, Some(t2)) = (moved2, total2) {
        lines.push(wake_line(snap, st.last_total2, t2, Some(text("wake_watch.label_mesh_direct"))));
    }
    if moved1 && let Some(t) = total {
        st.last_total = t;
    }
    if moved2 && let Some(t) = total2 {
        st.last_total2 = t;
    }
    // BROADCAST CHANNEL: a third, independent observation, never merged into the dual-channel logic.
    let total3 = snap.total3.flatten();
    if let Some(t3) = total3
        && t3 > st.last_broadcast
    {
        lines.push(wake_line(snap, st.last_broadcast, t3, Some(text("wake_watch.label_broadcast"))));
    }
    if snap.total3.is_some()
        && let Some(t3) = total3
    {
        st.last_broadcast = t3;
    }
    (st, lines)
}
