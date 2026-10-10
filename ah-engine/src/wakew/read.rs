//! The reads and the persisted cursor of the wake watcher: summary snapshots, the NDJSON inbox count, the seen-state file and
//! the update-announcement stamp. Port of `readPrimarySnapshot`, `readBroadcastSnapshot`, `attachBroadcastChannel`,
//! `readChildSnapshot`, `readChildCombinedSnapshot`, `loadSeenState`, `saveSeenState` and `claimUpdateAnnouncement` of
//! `companion/lib/devswarm-wake-watch.js`. All reads are pure; the two writes are the watcher's own private files.
use super::edge::{Snapshot, State};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, Fail, J};
use crate::defaults;
use crate::meshw::idlock::devswarm_root;
use std::path::{Path, PathBuf};

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

/// The text of a file as `readFileSync(p, 'utf8')` gives it (invalid bytes become U+FFFD); `None` when it cannot be read.
pub fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// A lone surrogate `\uXXXX` escape is valid JSON that JavaScript reads (a message preview cut in the middle of an emoji is
/// written that way) and the strict parser refuses: turn each one into U+FFFD. Only strings are ever affected, and the
/// watcher reads numbers.
fn replace_lone_surrogates(s: &str) -> String {
    let b = s.as_bytes();
    let hex4 = |i: usize| -> Option<u32> { std::str::from_utf8(b.get(i..i + 4)?).ok().and_then(|h| u32::from_str_radix(h, 16).ok()) };
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() && b[i + 1] < 0x80 {
            if b[i + 1] == b'u'
                && let Some(c) = hex4(i + 2)
            {
                if (0xD800..0xDC00).contains(&c) {
                    let pair = b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(i + 8).is_some_and(|d| (0xDC00..0xE000).contains(&d));
                    if pair {
                        out.push_str(&s[i..i + 12]);
                        i += 12;
                    } else {
                        out.push_str(text("wake_watch.replacement_escape"));
                        i += 6;
                    }
                    continue;
                }
                if (0xDC00..0xE000).contains(&c) {
                    out.push_str(text("wake_watch.replacement_escape"));
                    i += 6;
                    continue;
                }
            }
            out.push_str(&s[i..i + 2]);
            i += 2;
            continue;
        }
        let ch = s[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `JSON.parse(text)` for a file the watcher reads: `None` when it is not JSON.
pub fn parse_json(raw: &str) -> Option<J> {
    let depth = defaults::num("setup.json_max_depth") as usize;
    match json::parse(raw, depth) {
        Ok(v) => Some(v),
        Err(Fail::Invalid) => None,
        Err(Fail::Unsupported) => json::parse(&replace_lone_surrogates(raw), depth).ok(),
    }
}

/// A finite JSON number member.
pub fn finite(v: Option<&J>) -> Option<f64> {
    match v {
        Some(J::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `summaries/<hash>.json`
pub fn summary_path(home: &Path, hash: &str) -> PathBuf {
    devswarm_root(home).join(text("wake_watch.dir_summaries")).join(format!("{hash}{}", text("wake_watch.json_suffix")))
}

/// `readSummaryForHash(home, hash)`: the parsed summary, `None` for an absent, empty or unparseable file.
pub fn read_summary(home: &Path, hash: &str) -> Option<J> {
    let raw = read_text(&summary_path(home, hash))?;
    if js_trim(&raw).is_empty() {
        return None;
    }
    parse_json(&raw).filter(|v| matches!(v, J::Obj(_) | J::Arr(_)))
}

/// The two summary buckets a project's mail can sit in: the repo key's, then the legacy per-id hash.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hashes {
    /// The repo-key bucket.
    pub repo_key: Option<String>,
    /// The legacy hash bucket (never the same as the repo key).
    pub fallback: Option<String>,
}

impl Hashes {
    fn empty(&self) -> bool {
        self.repo_key.is_none() && self.fallback.is_none()
    }
}

/// One read's outcome (`{ ok, error, total }`).
#[derive(Clone, Debug, PartialEq)]
pub struct Part {
    /// The read worked.
    pub ok: bool,
    /// Why not.
    pub error: Option<String>,
    /// The count, `None` for "no data yet" (never a fabricated zero).
    pub total: Option<f64>,
}

fn unresolvable() -> Part {
    Part { ok: false, error: Some(text("wake_watch.err_unresolvable").to_string()), total: None }
}

fn workspace_row<'a>(summary: &'a Option<J>, id: &str) -> Option<&'a J> {
    summary.as_ref()?.get("workspaces")?.get(id)
}

/// `inboundTotalOf(row)`: the count the watcher edge-triggers on, the summary's `directTotalFromOthers` (rows the workspace's own
/// identity family did not send) when the writer published it, else the raw `total` of an older writer.
fn inbound_total(row: &J) -> Option<f64> {
    finite(row.get("directTotalFromOthers")).or_else(|| finite(row.get("total")))
}

/// `readPrimarySnapshot(home, hashes, id)`: the repo-key bucket first, the legacy bucket when the row is absent there.
pub fn read_direct(home: &Path, hashes: Option<&Hashes>, id: &str) -> Part {
    let Some(h) = hashes.filter(|h| !id.is_empty() && !h.empty()) else { return unresolvable() };
    let a = h.repo_key.as_deref().and_then(|k| read_summary(home, k));
    if let Some(row) = workspace_row(&a, id)
        && finite(row.get("total")).is_some()
    {
        return Part { ok: true, error: None, total: inbound_total(row) };
    }
    let b = h.fallback.as_deref().and_then(|k| read_summary(home, k));
    if let Some(row) = workspace_row(&b, id)
        && finite(row.get("total")).is_some()
    {
        return Part { ok: true, error: None, total: inbound_total(row) };
    }
    Part { ok: true, error: None, total: None }
}

/// `readBroadcastSnapshot`: the heartbeat- and own-sender-excluded unread broadcast count of the row the direct channel would
/// read. The bucket is chosen by ROW (the first whose row has a real `total`), never by field, so an older writer that
/// rewrote the summary without the field is "no data this tick" and not permission to read the other bucket.
pub fn read_broadcast(home: &Path, hashes: Option<&Hashes>, id: &str) -> Part {
    let Some(h) = hashes.filter(|h| !id.is_empty() && !h.empty()) else { return unresolvable() };
    let a = h.repo_key.as_deref().and_then(|k| read_summary(home, k));
    let mut row = workspace_row(&a, id).filter(|w| finite(w.get("total")).is_some());
    let b;
    if row.is_none() {
        b = h.fallback.as_deref().and_then(|k| read_summary(home, k));
        row = workspace_row(&b, id).filter(|w| finite(w.get("total")).is_some());
    }
    Part { ok: true, error: None, total: row.and_then(|w| finite(w.get(text("wake_watch.field_broadcast")))) }
}

/// `attachBroadcastChannel`: fold the broadcast channel into a snapshot, failing closed with whatever the direct channels said.
pub fn attach_broadcast(mut snap: Snapshot, home: &Path, hashes: Option<&Hashes>, id: &str) -> Snapshot {
    let b = read_broadcast(home, hashes, id);
    snap.total3 = Some(b.total);
    let base_ok = snap.ok;
    snap.ok = base_ok && b.ok;
    let b_err = b.error.unwrap_or_default();
    if !base_ok && !b.ok {
        snap.error = Some(format!("{}{}{b_err}", snap.error.clone().unwrap_or_default(), text("wake_watch.err_sep_broadcast")));
    } else if !base_ok {
        // the base error stays
    } else if !b.ok {
        snap.error = Some(format!("{}{b_err}", text("wake_watch.err_prefix_broadcast")));
    }
    snap
}

/// `countMessages(inboxPath)`: the non-blank lines of the inbox, 0 when it cannot be read.
pub fn count_messages(inbox: &Path) -> f64 {
    read_text(inbox).map_or(0.0, |t| t.split('\n').filter(|l| !js_trim(l).is_empty()).count() as f64)
}

/// `readChildCombinedSnapshot`: the NDJSON channel (`total`) and the mesh-direct channel (`total2`), independent, `ok` only
/// when both worked.
pub fn read_child(home: &Path, inbox: &Path, hashes: Option<&Hashes>, id: &str) -> Snapshot {
    let nd_total = count_messages(inbox);
    let mesh = read_direct(home, hashes, id);
    let error = if mesh.ok { None } else { Some(format!("{}{}", text("wake_watch.err_prefix_mesh"), mesh.error.clone().unwrap_or_default())) };
    Snapshot { ok: mesh.ok, error, total: Some(nd_total), total2: Some(mesh.total), ..Snapshot::default() }
}

// ---- the persisted seen-state --------------------------------------------------------------------------------------------------

/// `seenPath(home, id)`
pub fn seen_path(home: &Path, id: &str) -> PathBuf {
    devswarm_root(home).join(text("wake_watch.dir_wake")).join(format!("{id}{}", text("wake_watch.seen_suffix")))
}

fn num_member(o: &J, key: &str) -> Option<f64> {
    finite(o.get(key))
}

/// `loadSeenState(home, id, fs, role)`: the cursors, with a `*_missing` flag for each counter that has no recorded history.
pub fn load_seen(home: &Path, id: &str, primary: bool) -> State {
    let fresh = State { total_missing: true, total2_missing: true, broadcast_missing: true, ..State::default() };
    let Some(obj) = read_text(&seen_path(home, id)).and_then(|t| parse_json(&t)) else { return fresh };
    let Some(last_total) = num_member(&obj, "lastTotal").filter(|_| matches!(obj, J::Obj(_))) else { return fresh };
    let last_total2 = num_member(&obj, "lastTotal2").unwrap_or(0.0);
    let broadcast = num_member(&obj, "lastBroadcastUnread");
    let mesh_total = num_member(&obj, "meshTotal");
    let nd_total = num_member(&obj, "ndjsonTotal");
    // seenCountersFromLegacy: a pre-counter file records only positional cursors and not which role wrote them
    let (legacy_mesh, legacy_nd) = if primary { (last_total.max(last_total2), None) } else { (last_total2, Some(last_total)) };
    let mesh = mesh_total.unwrap_or(legacy_mesh);
    let mut st = State { last_broadcast: broadcast.unwrap_or(0.0), broadcast_missing: broadcast.is_none(), ..State::default() };
    if primary {
        st.last_total = mesh;
        st.last_total2 = mesh;
        return st;
    }
    // a counter-keyed file WITHOUT ndjsonTotal was last written by a primary: the NDJSON cursor is unknown, not the mesh number
    let nd_unknown = nd_total.is_none() && mesh_total.is_some();
    let nd = nd_total.unwrap_or(if mesh_total.is_some() { 0.0 } else { legacy_nd.unwrap_or(0.0) });
    st.last_total = nd;
    st.last_total2 = mesh;
    st.total_missing = nd_unknown;
    st
}

fn owned_key(k: &str) -> bool {
    defaults::list("wake_watch.seen_owned_keys").contains(&k)
}

fn write_atomic(path: &Path, payload: &str) -> bool {
    if let Some(dir) = path.parent()
        && std::fs::create_dir_all(dir).is_err()
    {
        return false;
    }
    let tmp = PathBuf::from(format!("{}.{}{}", path.display(), std::process::id(), text("wake_watch.tmp_suffix")));
    // Node's temporary name, through crate::atomic (synced, then renamed; left in place when the rename fails, as Node's)
    let style = crate::atomic::Style { leave_temp_on_rename_failure: true, ..crate::atomic::Style::default() };
    crate::atomic::stage(&tmp, payload, style).is_ok() && crate::atomic::replace(&tmp, path, style).is_ok()
}

/// `saveSeenState(home, id, state, fs, role)`: merge-preserving (keys a newer build owns are carried through), atomic,
/// best effort. Returns whether it wrote.
pub fn save_seen(home: &Path, id: &str, st: &State, primary: bool) -> bool {
    let p = seen_path(home, id);
    let prev = read_text(&p).and_then(|t| parse_json(&t));
    let fin = |v: f64| if v.is_finite() { v } else { 0.0 };
    let mut out = J::Obj(Vec::new());
    if let Some(J::Obj(members)) = &prev {
        for (k, v) in members {
            if !owned_key(k) {
                out.set(k, v.clone());
            }
        }
    }
    out.set("lastTotal", J::Num(fin(st.last_total)));
    out.set("lastTotal2", J::Num(fin(st.last_total2)));
    out.set("lastBroadcastUnread", J::Num(fin(st.last_broadcast)));
    if primary {
        out.set("meshTotal", J::Num(fin(st.last_total)));
        // the positional lastTotal2 carries the mesh total too, so an older child-role build never re-fires from a stale 0
        out.set("lastTotal2", J::Num(fin(st.last_total)));
        if let Some(nd) = prev.as_ref().and_then(|o| num_member(o, "ndjsonTotal")) {
            out.set("ndjsonTotal", J::Num(nd));
        }
    } else {
        out.set("meshTotal", J::Num(fin(st.last_total2)));
        out.set("ndjsonTotal", J::Num(fin(st.last_total)));
    }
    write_atomic(&p, &json::stringify(&out))
}

/// `claimUpdateAnnouncement(home, id, version)`: true when `version` is strictly newer than the last one announced (and
/// records it); false otherwise.
pub fn claim_update_announcement(home: &Path, id: &str, version: &str) -> bool {
    let p = seen_path(home, id);
    let mut obj = match read_text(&p).and_then(|t| parse_json(&t)) {
        Some(o @ J::Obj(_)) => o,
        _ => J::Obj(Vec::new()),
    };
    let prev = match obj.get("updateAnnouncedVersion") {
        Some(J::Str(s)) => Some(s.clone()),
        _ => None,
    };
    let key = "updateAnnouncedVersion";
    match &prev {
        Some(pv) if crate::operator::update::semver_ok(pv) && crate::operator::update::semver_ok(version) => {
            if crate::operator::update::compare_versions(version, pv) <= 0 {
                return false;
            }
        }
        Some(pv) if pv == version => return false,
        _ => {}
    }
    obj.set(key, J::Str(version.to_string()));
    // a failed write only risks one re-announcement after a restart
    write_atomic(&p, &json::stringify(&obj));
    true
}
