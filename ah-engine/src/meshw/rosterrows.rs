//! Plain `devswarm.js roster` for a project WITH rows, ported from `scripts/devswarm-lib/roster-diag.js` (`cmdRoster`,
//! `rosterHints`, `computeInstanceNonceCounts`, `rosterHumanText`) and the readers they stand on (`row-state.js`,
//! `row-eligibility.js`, `liveness.js` dormancy, `devswarm-app-db.js`, `devswarm-sender-alias.js`, `archive.js`
//! `localArchivedAppLive`).
//!
//! The roster is a read: nothing is written (`computeSummary` is the pure projection, the app database is opened read only,
//! the app-archived verdict never uses the cross-invocation cache here). There is no Node to hand a case to, so every row class
//! is answered here:
//! * store rows with their hints (worktree gone, idle days, archived, dormant, idle-alive, phantom, waiting on a human, instance-split,
//!   done), their step-plan fields (label, current step, extras, token burn, straying signals) and the app database's fields;
//! * native `hivecontrol` children no store row represents: a row of their own (`source: native`), or folded into the archived row
//!   their worktree belongs to; children of another repository are dropped and logged;
//! * the split-brain fallback row (a Primary in the legacy hash bucket's summary), archived-descriptor rows, the apps-still-live
//!   report, the ghost-label fold and the text table.
//!
//! An odd value in a file (a number where a text is expected) is read the way JavaScript's `String()` and truthiness read it.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable or torn optional file is the absent one (Node: `try { JSON.parse(readFileSync(...)) } catch (_) {}`)
use crate::checks::guardkit::ojson::{OVal, is_array_index_key};
use crate::checks::guardkit::text::js_number_of_str;
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::dssup::appsync::plan::{app_sourced, dir_of, read_json_dir, wt_key};
use crate::dssup::appsync::snap::{self, Snap};
use crate::dssup::liveness;
use crate::meshw::appdb;
use crate::meshw::common::{Inv, Obj, s};
use crate::meshw::extverbs::tpl;
use crate::meshw::hivecontrol;
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::plan;
use crate::meshw::rostertail;
use crate::meshw::store::MeshStore;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// What the roster result needs besides its rows.
pub struct Built {
    /// The rows, in Node's order.
    pub rows: Vec<Obj>,
    /// `appStillLive`, when the app shows workspaces anti-hall archived.
    pub app_still_live: Option<OVal>,
}

struct Eng<'a> {
    inv: &'a Inv,
    now: f64,
    repo_key: &'a str,
    dormant: std::cell::OnceCell<f64>,
    /// The supervisor's active-list snapshot of this project, read once (`None`: absent, stale, malformed or empty: no evidence).
    active: std::cell::OnceCell<Option<Active>>,
}

/// The records of one project in `hivecontrol-active.json`, after `normalizeRecords`.
struct Active {
    fetched_at: f64,
    /// `(id, normalized worktree path)`.
    recs: Vec<(String, Option<String>)>,
}

fn key(k: &str) -> &'static str {
    defaults::text(k)
}

fn file_in(e: &Eng, dir_key: &str, id: &str) -> PathBuf {
    devswarm_root(&e.inv.home).join(key(dir_key)).join(format!("{id}{}", key("mesh_write.json_suffix")))
}

fn read_obj(p: &Path) -> Option<OVal> {
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))
}

fn finite(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

fn truthy_str(v: Option<&OVal>) -> R<Option<String>> {
    match v {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(t)) => Ok((!t.is_empty()).then(|| t.clone())),
        Some(x) if !x.truthy() => Ok(None),
        // a truthy value of another type is carried as the text `String()` gives it
        Some(x) => Ok(Some(ident::js_to_string(x))),
    }
}

fn strings(v: &[String]) -> OVal {
    OVal::Arr(v.iter().map(|x| s(x)).collect())
}

fn hints_of(o: &Obj) -> Vec<String> {
    match o.0.iter().find(|(k, _)| k == "hints") {
        Some((_, OVal::Arr(a))) => a.iter().filter_map(|h| if let OVal::Str(t) = h { Some(t.clone()) } else { None }).collect(),
        _ => Vec::new(),
    }
}

fn field<'a>(o: &'a Obj, k: &str) -> Option<&'a OVal> {
    o.0.iter().find(|(x, _)| x == k).map(|(_, v)| v)
}

fn str_field<'a>(o: &'a Obj, k: &str) -> Option<&'a str> {
    match field(o, k) {
        Some(OVal::Str(t)) => Some(t),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// hints
// ---------------------------------------------------------------------------------------------------------------------

/// `livenessPathFor(id)` then the verdict's finite `lastOutboundTs`.
fn last_outbound(e: &Eng, id: &str) -> Option<f64> {
    if !is_safe_id(id) {
        return None;
    }
    let v = read_obj(&file_in(e, "mesh_write.dir_liveness", id))?;
    finite(v.get(key("devswarm_cli.rr_field_last_outbound")))
}

/// `rosterIdleDays(home, id, now)`.
fn idle_days(e: &Eng, id: &str) -> Option<f64> {
    let t = last_outbound(e, id)?;
    let days = ((e.now - t) / defaults::num("devswarm_cli.rr_day_ms") as f64).floor();
    (days >= 0.0).then_some(days)
}

/// `isArchiveComplete(home, id)`: the marker exists and the active descriptor is gone (the archived directory a real directory).
fn archive_complete(e: &Eng, id: &str) -> bool {
    if !is_safe_id(id) || file_in(e, "mesh_write.dir_workspaces", id).exists() {
        return false;
    }
    let dir = devswarm_root(&e.inv.home).join(key("mesh_write.dir_archived"));
    let Ok(md) = std::fs::symlink_metadata(&dir) else { return false };
    md.is_dir() && !md.file_type().is_symlink() && file_in(e, "mesh_write.dir_archived", id).exists()
}

/// `realSid(v)`: a non-empty `String(v)`.
fn real_sid(v: Option<&OVal>) -> R<Option<String>> {
    Ok(match v {
        None | Some(OVal::Null) => None,
        Some(OVal::Str(t)) => (!t.is_empty()).then(|| t.clone()),
        Some(OVal::Num(x)) => Some(to_js_string(*x)),
        Some(OVal::Bool(b)) => Some(b.to_string()),
        // `String(v)` of an array or object
        Some(other) => Some(ident::js_to_string(other)).filter(|t| !t.is_empty()),
    })
}

/// `samePath(a, b)`: both resolved through the file system when they can be, else as given.
fn same_path(a: &str, b: &str) -> bool {
    ident::realpath(a).unwrap_or_else(|| a.to_string()) == ident::realpath(b).unwrap_or_else(|| b.to_string())
}

/// `isArchivedWorkspace(home, id, worktreePath, { sessionId })`: anti-hall's own archive marker. A marker a newer occupant of the id
/// has superseded (the row's session, else the live descriptor's, differs from the marker's) is not archived; Node only logs it.
fn marker_archived(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>) -> R<bool> {
    if !is_safe_id(id) {
        return Ok(false);
    }
    let Ok(bytes) = std::fs::read(file_in(e, "mesh_write.dir_archived", id)) else { return Ok(false) };
    let Some(desc) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { return Ok(false) };
    if !matches!(desc, OVal::Obj(_) | OVal::Arr(_)) {
        return Ok(false);
    }
    if let Some(wt) = wt {
        let marker_wt = match desc.get(key("mesh_write.field_worktree_path")) {
            Some(OVal::Str(t)) if !t.is_empty() => Some(t.as_str()),
            _ => None,
        };
        if marker_wt.is_some_and(|m| !same_path(m, wt)) {
            return Ok(false);
        }
    }
    let Some(marker_sid) = real_sid(desc.get(key("mesh_write.field_session_id")))? else { return Ok(true) };
    let live_sid = match session.filter(|s| !s.is_empty()) {
        Some(s) => Some(s.to_string()),
        None => match &read_obj(&file_in(e, "mesh_write.dir_workspaces", id)) {
            Some(d @ (OVal::Obj(_) | OVal::Arr(_))) => real_sid(d.get(key("mesh_write.field_session_id")))?,
            _ => None,
        },
    };
    Ok(!live_sid.is_some_and(|l| l != marker_sid))
}

/// `isUnderDevswarmReposRoot(p)`.
fn under_repos_root(p: &str) -> R<bool> {
    if p.is_empty() {
        return Ok(false);
    }
    // `normalizeWorktreePath`: `path.resolve` (a relative path against the working directory), then the real path when it exists
    let norm = normalize_wt(p);
    Ok(regex::Regex::new(key("devswarm_cli.rr_repos_root_re")).is_ok_and(|re| re.is_match(&norm)))
}

/// `normalizeWorktreePath(p)` for a non-empty path.
fn normalize_wt(p: &str) -> String {
    let resolved = ident::abs_from_cwd(p);
    ident::realpath(&resolved).unwrap_or(resolved)
}

/// `normalizeRecords(v)` of the active-list cache: `None` when `v` is no array.
fn normalize_records(v: &OVal) -> Option<Vec<(String, Option<String>)>> {
    let OVal::Arr(items) = v else { return None };
    let mut out = Vec::new();
    for r in items {
        if !matches!(r, OVal::Obj(_) | OVal::Arr(_)) {
            continue;
        }
        let id = match r.get("id") {
            None | Some(OVal::Null) => String::new(),
            Some(x) => ident::js_to_string(x),
        };
        if id.is_empty() {
            continue;
        }
        let wt = match r.get("worktreePath") {
            Some(OVal::Str(p)) if !p.is_empty() => Some(normalize_wt(p)),
            _ => None,
        };
        out.push((id, wt));
    }
    Some(out)
}

/// `resolveArchivedCacheMaxAgeMs(env)`: the variable when it is a positive integer, else twice the reconcile sweep interval.
fn active_max_age_ms(e: &Eng) -> f64 {
    let from_env = e
        .inv
        .env
        .get(key("devswarm_cli.rr_env_active_max_age"))
        .map(|v| v.trim())
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|v| v.parse::<f64>().ok())
        .filter(|n| *n > 0.0);
    if let Some(n) = from_env {
        return n;
    }
    let sec = crate::dsact::settings::resolve(&e.inv.settings(), defaults::raw("devswarm_sup.set_reconcile_sec")).as_f64().unwrap_or(0.0);
    let sweep = if sec.is_finite() && sec > 0.0 { sec * 1000.0 } else { defaults::num("devswarm_cli.rr_sweep_fallback_ms") as f64 };
    defaults::num("devswarm_cli.rr_active_max_age_mult") as f64 * sweep
}

/// `readActiveCache` for this project: the records of `byRepoKey[repoKey]` when the snapshot is fresh and holds any.
fn read_active(e: &Eng) -> Option<Active> {
    if e.repo_key.is_empty() {
        return None;
    }
    let parsed = read_obj(&devswarm_root(&e.inv.home).join(key("devswarm_cli.rr_active_list_file")))?;
    if !matches!(parsed, OVal::Obj(_)) {
        return None;
    }
    let fetched_at = finite(parsed.get("fetchedAt"))?;
    let age = e.now - fetched_at;
    if !(age >= 0.0 && age <= active_max_age_ms(e)) {
        return None;
    }
    let Some(OVal::Obj(by_repo)) = parsed.get("byRepoKey") else { return None };
    let recs = normalize_records(&by_repo.iter().rev().find(|(k, _)| k == e.repo_key)?.1)?;
    (!recs.is_empty()).then_some(Active { fetched_at, recs })
}

/// `isAppArchived(...)` for a row under the app's repos root: the project's snapshot is fresh, lists no record with the row's id or
/// worktree, and is at least the grace newer than the row's descriptor (a row the snapshot predates is not archived by its absence).
fn absent_from_active_list(e: &Eng, id: &str, wt: &str) -> bool {
    let Some(snap) = e.active.get_or_init(|| read_active(e)) else { return false };
    let want = normalize_wt(wt);
    if snap.recs.iter().any(|(rid, rwt)| rid == id || rwt.as_deref() == Some(want.as_str())) {
        return false;
    }
    let first_seen = std::fs::metadata(file_in(e, "mesh_write.dir_workspaces", id))
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .filter(|ms| ms.is_finite());
    let Some(first_seen) = first_seen else { return false };
    let grace = crate::dsact::settings::resolve(&e.inv.settings(), defaults::raw("devswarm_cli.rr_set_archived_grace_ms")).as_f64().unwrap_or(0.0);
    snap.fetched_at - first_seen >= grace
}

/// The app side of "archived": the app database's verdict, else (no opinion) the supervisor's active-list cache, which the
/// engine only handles when the worktree cannot be under the app's root or the cache file is absent or unparsable.
fn app_archived(e: &Eng, id: &str, wt: Option<&str>) -> R<bool> {
    let (verdict, _) = appdb::archived_verdict(&e.inv.home, &e.inv.env, e.inv.now, id, wt, false)?;
    if let Some(v) = verdict {
        return Ok(v);
    }
    if id.is_empty() || !under_repos_root(wt.unwrap_or(""))? {
        return Ok(false);
    }
    Ok(absent_from_active_list(e, id, wt.unwrap_or("")))
}

fn archived(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>) -> R<bool> {
    Ok(marker_archived(e, id, wt, session)? || app_archived(e, id, wt)?)
}

fn fresh_beat(e: &Eng, id: &str) -> bool {
    is_safe_id(id) && liveness::is_fresh(liveness::heartbeat_ts(&e.inv.home, id), e.now, defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64)
}

/// `dormantThresholdMs(env)`: the setting; a value at or below zero is no reading (the setting's `exclusive_min`), so the tier below
/// it answers, last the default.
fn dormant_ms(e: &Eng) -> R<f64> {
    if let Some(v) = e.dormant.get() {
        return Ok(*v);
    }
    let entry = defaults::raw("devswarm_cli.rr_set_dormant_ms");
    let read = crate::dsact::settings::resolve(&e.inv.settings(), entry).as_f64().unwrap_or(0.0);
    let v = if read.is_finite() && read > 0.0 { read } else { entry.get("default").and_then(crate::defaults::V::as_integer).unwrap_or(0) as f64 };
    Ok(*e.dormant.get_or_init(|| v))
}

/// `idleThresholdMs(env)`.
fn idle_ms(e: &Eng) -> f64 {
    let n = e.inv.env.get(key("devswarm_cli.rr_env_idle_ms")).map(|v| js_number_of_str(v)).unwrap_or(0.0);
    if n.is_finite() && n > 0.0 { n } else { defaults::num("devswarm_cli.rr_idle_ms_default") as f64 }
}

/// `readActivityTs(row, home, { lastOutboundTs })`: the newest activity signal (0 for none) and whether the session transcript was seen.
fn activity(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>, last_out: Option<f64>) -> R<(f64, bool)> {
    let home = e.inv.home.as_path();
    let mut best = 0.0f64;
    if is_safe_id(id)
        && let Some(t) = liveness::heartbeat_ts(home, id)
        && t.is_finite()
        && t > best
    {
        best = t;
    }
    let mut saw_transcript = false;
    if let (Some(sid), Some(wt)) = (session, wt)
        && let Some(t) = liveness::transcript_mtime(home, wt, sid)?
        && t.is_finite()
    {
        saw_transcript = true;
        if t > best {
            best = t;
        }
    }
    if let Some(t) = last_out
        && t > best
    {
        best = t;
    }
    if best == 0.0
        && is_safe_id(id)
        && let Some(t) = liveness::registration_ts(home, id)
        && t > 0.0
    {
        best = t;
    }
    Ok((best, saw_transcript))
}

/// `isDormantByActivity(row, home, { now, lastOutboundTs })`.
fn dormant_by_activity(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>, last_out: Option<f64>) -> R<bool> {
    let (best, saw_transcript) = activity(e, id, wt, session, last_out)?;
    if best <= 0.0 || !e.now.is_finite() {
        return Ok(false);
    }
    let age = e.now - best;
    if age < 0.0 {
        return Ok(false);
    }
    let threshold = if saw_transcript { dormant_ms(e)? } else { idle_ms(e) };
    Ok(age >= threshold)
}

/// `isSessionAliveRow({ sessionId })`.
fn session_alive(e: &Eng, session: Option<&str>) -> R<bool> {
    match session {
        Some(sid) => liveness::session_alive(&e.inv.home, sid),
        None => Ok(false),
    }
}

/// `isSiblingPartitionLive(row, home, { now })`: a fresh heartbeat is live; a row without a real session id
/// (none, or the `unclaimed:` placeholder) is not; otherwise live unless its activity is positively stale and its session is gone.
/// A case only Node decides (`Defer`) is the caller's to hand over (Node reads an undetermined row as live).
pub(crate) fn sibling_partition_live(inv: &Inv, now: f64, id: &str, wt: Option<&str>, session: Option<&str>) -> R<bool> {
    let e = Eng { inv, now, repo_key: "", dormant: std::cell::OnceCell::new(), active: std::cell::OnceCell::new() };
    if fresh_beat(&e, id) {
        return Ok(true);
    }
    match session {
        Some(sid) if !sid.is_empty() && !sid.starts_with(key("mesh_write.synthetic_session_prefix")) => {
            Ok(!(dormant_by_activity(&e, id, wt, session, None)? && !session_alive(&e, session)?))
        }
        _ => Ok(false),
    }
}

/// `isRoutingLiveRowStrict(row, home)`: not archived (anti-hall's marker or the app's verdict), and `isSiblingPartitionLive`. The
/// target-selection gate of `resolveMeshTarget`: a descriptor that merely exists proves nothing. A case only Node decides is a deferral.
pub(crate) fn routing_live_strict(inv: &Inv, now: f64, id: &str, wt: Option<&str>, session: Option<&str>) -> R<bool> {
    let e = Eng { inv, now, repo_key: "", dormant: std::cell::OnceCell::new(), active: std::cell::OnceCell::new() };
    if archived(&e, id, wt, session)? {
        return Ok(false);
    }
    sibling_partition_live(inv, now, id, wt, session)
}

/// `sessionAuthoredHeartbeat(home, id)`: `Some(true)` when the heartbeat record names a real session, `Some(false)` when it names none,
/// `None` when the file is missing or not JSON (unknown, neutral).
pub(crate) fn session_authored_heartbeat(inv: &Inv, id: &str) -> Option<bool> {
    if !is_safe_id(id) {
        return None;
    }
    let p = devswarm_root(&inv.home).join(key("mesh_write.dir_heartbeats")).join(format!("{id}{}", key("mesh_write.json_suffix")));
    let j = OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))?;
    if !matches!(j, OVal::Obj(_) | OVal::Arr(_)) {
        return None;
    }
    Some(match j.get(key("mesh_write.field_session_id")) {
        None | Some(OVal::Null) => false,
        Some(OVal::Str(t)) => !t.is_empty(),
        Some(_) => true,
    })
}

/// `computeRowLive(row, home, { now })`.
fn row_live(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>) -> R<bool> {
    if fresh_beat(e, id) {
        return Ok(true);
    }
    match session {
        Some(sid) if !sid.starts_with(key("mesh_write.synthetic_session_prefix")) => {
            Ok(!(dormant_by_activity(e, id, wt, session, None)? && !session_alive(e, session)?))
        }
        _ => Ok(false),
    }
}

/// The `waiting-on-human` hint of `childBusyState`: a heartbeat of another session reports nothing; otherwise the bounded tail
/// of the session transcript is read (`rostertail`), which also reports nothing for a missing, unreadable or empty file.
fn waiting_hint(e: &Eng, id: &str, wt: &str, session: &str) -> R<Option<String>> {
    match rostertail::transcript_file(&e.inv.home, id, wt, session)? {
        Some(file) => rostertail::waiting_hint(&file, e.now),
        None => Ok(None),
    }
}

/// `rosterHints(home, id, worktreePath, now, sessionId, { registryBacked })`.
fn hints(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>, registry_backed: bool) -> R<Vec<String>> {
    let mut h: Vec<String> = Vec::new();
    if let Some(w) = wt
        && !Path::new(w).exists()
    {
        h.push(key("devswarm_cli.rr_hint_worktree_gone").to_string());
    }
    if let Some(d) = idle_days(e, id) {
        h.push(tpl("devswarm_cli.rr_hint_idle", &[("days", &to_js_string(d))]));
    }
    if archived(e, id, wt, session)? {
        h.push(key("devswarm_cli.rr_hint_archived").to_string());
        if fresh_beat(e, id) {
            h.push(key("devswarm_cli.rr_hint_live_in_archived").to_string());
        }
        return Ok(h);
    }
    let dormant = dormant_by_activity(e, id, wt, session, last_outbound(e, id))?;
    if dormant && !session_alive(e, session)? {
        h.push(key("devswarm_cli.rr_hint_dormant").to_string());
    } else if dormant {
        h.push(key("devswarm_cli.rr_hint_idle_alive").to_string());
    } else if registry_backed && !row_live(e, id, wt, session)? {
        // `phantom` only for a row with a registry entry: a native child has no descriptor and no session as its permanent shape
        h.push(key("devswarm_cli.rr_hint_phantom").to_string());
    }
    if let (Some(sid), Some(w)) = (session, wt)
        && let Some(hint) = waiting_hint(e, id, w, sid)?
    {
        h.push(hint);
    }
    Ok(h)
}

/// `computeInstanceNonceCounts(rows, now, freshMs)`: id -> the most nonces alive at once.
#[allow(clippy::type_complexity)]
fn instance_counts(st: &MeshStore, now: f64) -> R<HashMap<String, f64>> {
    let window = defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64;
    let gap = defaults::num("devswarm_cli.rr_split_gap_ms") as f64;
    let mut by_sender: Vec<(String, Vec<(String, f64, f64)>)> = Vec::new();
    st.reader()
        .for_each_message(key("mesh_write.broadcast_partition"), 0, |m| {
            let (Some(sender), Some(nonce)) = (m["sender"].as_str(), m["instanceNonce"].as_str()) else { return true };
            if nonce.is_empty() {
                return true;
            }
            let ts = m["ts"].as_f64().unwrap_or(f64::NAN);
            if !ts.is_finite() || now - ts > window {
                return true;
            }
            let at = match by_sender.iter().position(|(k, _)| k == sender) {
                Some(i) => i,
                None => {
                    by_sender.push((sender.to_string(), Vec::new()));
                    by_sender.len() - 1
                }
            };
            let spans = &mut by_sender[at].1;
            match spans.iter_mut().find(|(n, _, _)| n == nonce) {
                Some((_, lo, hi)) => {
                    if ts < *lo {
                        *lo = ts;
                    }
                    if ts > *hi {
                        *hi = ts;
                    }
                }
                None => spans.push((nonce.to_string(), ts, ts)),
            }
            true
        })
        .or_else(|e| ident::unavailable("mesh_write.what_messages", &e))?;
    let mut out = HashMap::new();
    for (id, spans) in by_sender {
        if spans.len() <= 1 {
            out.insert(id, spans.len() as f64);
            continue;
        }
        // (time, +1 start / -1 end), starts first at a tie
        let mut events: Vec<(f64, i32)> = Vec::new();
        for (_, lo, hi) in &spans {
            events.push((*lo, 1));
            events.push((*hi + gap, -1));
        }
        events.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(b.1.cmp(&a.1)));
        let (mut active, mut best) = (0i64, 0i64);
        for (_, delta) in events {
            active += i64::from(delta);
            best = best.max(active);
        }
        out.insert(id, best as f64);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------------
// native children, archived rows, the app database
// ---------------------------------------------------------------------------------------------------------------------

struct Child {
    branch: Option<String>,
    id: Option<String>,
    path: Option<String>,
    label: Option<String>,
    repo_id: Option<String>,
}

/// `parseChildrenList(raw)`.
fn parse_children(raw: &str) -> Vec<Child> {
    let parsed = OVal::parse(raw);
    let list: &[OVal] = match &parsed {
        Some(OVal::Arr(a)) => a,
        Some(o @ OVal::Obj(_)) => match o.get(key("mesh_write.roster_children_key")) {
            Some(OVal::Arr(a)) => a,
            _ => &[],
        },
        _ => &[],
    };
    let text = |el: &OVal, k: &str| el.get(k).filter(|v| v.truthy()).map(ident::js_to_string);
    let non_empty = |el: &OVal, k: &str| match el.get(k) {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
        _ => None,
    };
    list.iter()
        .filter(|el| matches!(el, OVal::Obj(_) | OVal::Arr(_)))
        .map(|el| {
            let id = text(el, "id");
            Child {
                branch: text(el, "branch").or_else(|| id.clone()),
                id,
                path: text(el, "path").or_else(|| text(el, "worktreePath")),
                label: non_empty(el, "label"),
                repo_id: non_empty(el, "repositoryId"),
            }
        })
        .collect()
}

/// `fetchNativeChildren(ctx)`: the children `hivecontrol workspace list children` reports, without those of another repository
/// (the cross-repo guard drops them and logs it). Nothing to fold (`[]`) when the build lacks the verb, the binary cannot be run or
/// its answer is not usable: the roster's own store view is never degraded by this best-effort addition.
fn fetch_native_children(e: &Eng) -> Vec<Child> {
    let list_args: Vec<&str> = defaults::list("mesh_write.roster_children_args");
    let raw = match hivecontrol::gate(&e.inv.env, &e.inv.home) {
        hivecontrol::Gate::Spawn => match hivecontrol::run(&list_args, &e.inv.env) {
            Some(r) => r,
            None => return Vec::new(),
        },
        // the build lacks the verb (Node refuses the call and records it), or the capability probe could not settle: no call is made
        hivecontrol::Gate::Refused | hivecontrol::Gate::Probe => return Vec::new(),
    };
    let children = parse_children(&raw);
    if !children.iter().any(|c| c.repo_id.is_some()) {
        return children;
    }
    let mut env = e.inv.env.clone();
    env.remove(key("devswarm_cli.rr_env_repo_id"));
    let trusted_args: Vec<&str> = defaults::list("devswarm_cli.rr_trusted_args");
    let Some(trusted) = hivecontrol::run(&trusted_args, &env).and_then(|r| parse_children(&r).into_iter().find_map(|c| c.repo_id)) else { return children };
    let mismatched: Vec<&String> = children.iter().filter_map(|c| c.repo_id.as_ref()).filter(|r| **r != trusted).collect();
    if !mismatched.is_empty() {
        let mut got: Vec<&String> = Vec::new();
        for m in &mismatched {
            if !got.contains(m) {
                got.push(m);
            }
        }
        let msg = tpl("devswarm_cli.msg_roster_native_dropped", &[("count", &mismatched.len().to_string())]);
        if crate::meshw::clog::ready(e.inv).is_ok() {
            crate::meshw::clog::warn_event(
                e.inv,
                key("devswarm_cli.rr_native_fold_op"),
                &msg,
                vec![("expected", s(&trusted)), ("got", OVal::Arr(got.iter().map(|g| s(g)).collect()))],
            );
        }
    }
    children.into_iter().filter(|c| c.repo_id.as_ref().is_none_or(|r| *r == trusted)).collect()
}

/// `String(v)` of a descriptor `id` the way the archive scan compares it.
fn js_text(v: Option<&OVal>) -> R<String> {
    Ok(match v {
        None => key("mesh_write.js_undefined").to_string(),
        Some(OVal::Null) => key("mesh_write.js_null").to_string(),
        Some(OVal::Str(t)) => t.clone(),
        Some(OVal::Num(x)) => to_js_string(*x),
        Some(OVal::Bool(b)) => b.to_string(),
        // `String(d.id)` of an array or object
        Some(other) => ident::js_to_string(other),
    })
}

/// The archived descriptors of this project by the mesh id of their worktree (`archivedByWt`): the first of each.
fn archived_by_worktree(e: &Eng) -> R<HashMap<String, String>> {
    let dir = devswarm_root(&e.inv.home).join(key("mesh_write.dir_archived"));
    let mut out: HashMap<String, String> = HashMap::new();
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        _ => return Ok(out),
    }
    let suffix = key("mesh_write.json_suffix");
    for (name, _) in crate::checks::jsport::fsx::read_dir_names(&dir.to_string_lossy()).unwrap_or_default() {
        let Some(aid) = name.strip_suffix(suffix) else { continue };
        if !is_safe_id(aid) {
            continue;
        }
        let p = dir.join(&name);
        if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(d @ OVal::Obj(_)) = read_obj(&p) else { continue };
        if js_text(d.get(key("mesh_write.field_id")))? != aid {
            continue;
        }
        let Some(wt) = d.get(key("mesh_write.field_worktree_path")).filter(|w| w.truthy()) else { continue };
        if crate::meshw::roster::physical_owner_key(&d)?.as_deref() != Some(e.repo_key) {
            continue;
        }
        if let Ok(k) = ident::primary_workspace_id(&ident::js_to_string(wt)) {
            out.entry(k).or_insert_with(|| aid.to_string());
        }
    }
    Ok(out)
}

/// The archive scan: a descriptor of an archived workspace this project owns that no row shows yet becomes a row of its own.
fn archived_rows(e: &Eng, shown: &HashSet<String>) -> R<Vec<Obj>> {
    let dir = devswarm_root(&e.inv.home).join(key("mesh_write.dir_archived"));
    match std::fs::symlink_metadata(&dir) {
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => {}
        _ => return Ok(Vec::new()),
    }
    let suffix = key("mesh_write.json_suffix");
    let mut out = Vec::new();
    for (name, _) in crate::checks::jsport::fsx::read_dir_names(&dir.to_string_lossy()).unwrap_or_default() {
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if shown.contains(id) || !is_safe_id(id) {
            continue;
        }
        let p = dir.join(&name);
        // readDescriptorPathState: a regular file holding a JSON object
        if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
            continue;
        }
        let Some(d @ OVal::Obj(_)) = read_obj(&p) else { continue };
        if js_text(d.get(key("mesh_write.field_id")))? != id || !d.get(key("mesh_write.field_worktree_path")).is_some_and(OVal::truthy) {
            continue;
        }
        if crate::meshw::roster::physical_owner_key(&d)?.as_deref() != Some(e.repo_key) {
            continue;
        }
        // Node pushed null for both although the descriptor it had just checked holds the path: the path and its mesh id are
        // the row's, so an archived workspace can be matched by where it lived
        let wt = js_text(d.get(key("mesh_write.field_worktree_path")))?;
        let mesh_id = ident::primary_workspace_id(&wt).ok();
        let mut o = Obj::default();
        o.put("id", s(id))
            .put("working_on", OVal::Null)
            .put("directUnread", OVal::Null)
            .put("broadcastUnread", OVal::Null)
            .put("urgencyMax", OVal::Null)
            .put("worktreePath", s(&wt))
            .put("source", s(key("devswarm_cli.rr_source_archived")))
            .put("meshId", mesh_id.as_deref().map_or(OVal::Null, s))
            .put("hints", strings(&[key("devswarm_cli.rr_hint_archived").to_string()]));
        out.push(o);
    }
    Ok(out)
}

/// `localArchivedAppLive(home, { repoKey })`: workspaces anti-hall archived that the app still shows.
#[allow(clippy::type_complexity)]
fn app_still_live(e: &Eng, snap: &Snap) -> R<Vec<(String, String, Option<String>, Option<String>, String)>> {
    let home = e.inv.home.as_path();
    let archived = read_json_dir(&dir_of(home, "devswarm_sup.as_dir_archived"))?;
    let active = read_json_dir(&dir_of(home, "devswarm_sup.as_dir_workspaces"))?;
    let active_ids: HashSet<&str> = active.iter().map(|d| d.id.as_str()).collect();
    let mut active_wts: HashSet<String> = HashSet::new();
    for d in &active {
        if let Some(k) = wt_key(d.worktree()?.as_deref())? {
            active_wts.insert(k);
        }
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut out = Vec::new();
    for d in &archived {
        if !is_safe_id(&d.id) || app_sourced(d) || active_ids.contains(d.id.as_str()) {
            continue;
        }
        if wt_key(d.worktree()?.as_deref())?.is_some_and(|k| active_wts.contains(&k)) {
            continue;
        }
        if crate::meshw::roster::physical_owner_key(&d.body)?.as_deref() != Some(e.repo_key) {
            continue;
        }
        let Some(w) = snap.workspaces.iter().find(|x| x.id == d.id) else { continue };
        let kind = w.builder_type.clone().unwrap_or_default();
        if w.archived || kind.to_lowercase() == key("devswarm_sup.as_primary_type") || kind.is_empty() || seen.contains(w.id.as_str()) {
            continue;
        }
        seen.insert(&w.id);
        let d_branch = truthy_str(d.body.get("branch"))?;
        let branch = w.branch_name.clone().filter(|b| !b.is_empty()).or(d_branch);
        let target = branch.clone().unwrap_or_else(|| w.id.clone());
        out.push((d.id.clone(), w.id.clone(), branch, w.label.clone().filter(|l| !l.is_empty()), tpl("devswarm_cli.rr_app_live_cmd", &[("target", &target)])));
    }
    Ok(out)
}

/// `rosterFoldTarget(home, id, present, { aliases, appBuilderId })`.
fn fold_target(e: &Eng, id: &str, present: &HashSet<String>, aliases: &[(String, String)], app_builder: Option<&str>) -> R<Option<String>> {
    if !regex::Regex::new(key("devswarm_cli.rr_ghost_label_re")).is_ok_and(|re| re.is_match(id)) {
        return Ok(None);
    }
    let has = |x: &str| x != id && present.contains(x);
    if let Some((_, to)) = aliases.iter().find(|(label, _)| label == id)
        && has(to)
    {
        return Ok(Some(to.clone()));
    }
    // retiredTo(home, id)
    if is_safe_id(id)
        && let Some(j) = read_obj(&file_in(e, "devswarm_cli.rr_dir_retired", id))
    {
        let to = match j.get(key("devswarm_cli.rr_field_retired_to")) {
            None | Some(OVal::Null) => String::new(),
            Some(OVal::Str(t)) => t.clone(),
            Some(OVal::Num(x)) => to_js_string(*x),
            Some(OVal::Bool(b)) => b.to_string(),
            // `String(retiredTo)` of an array or object
            Some(other) => ident::js_to_string(other),
        };
        if !to.is_empty() && to != id && has(&to) {
            return Ok(Some(to));
        }
    }
    Ok(app_builder.filter(|b| has(b)).map(str::to_string))
}

fn num_field(o: &Obj, k: &str) -> Option<f64> {
    finite(field(o, k))
}

/// The app database's part of `cmdRoster`: `appArchived`, the title, the `app` object, the sidebar order, then the ghost fold.
fn enrich(e: &Eng, rows: &mut Vec<Obj>, snap: &Option<Snap>) -> R<()> {
    let Some(snap) = snap else {
        return fold(e, rows, &None);
    };
    let focused = snap.focused(e.now).map(str::to_string);
    for r in rows.iter_mut() {
        let id = str_field(r, "id").map(str::to_string);
        let wt = str_field(r, "worktreePath").map(str::to_string);
        let Some(ws) = snap.workspace_for(id.as_deref(), wt.as_deref())? else { continue };
        r.put(
            "appArchived",
            if ws.archived {
                OVal::Bool(true)
            } else if ws.active {
                OVal::Bool(false)
            } else {
                OVal::Null
            },
        );
        if let Some(l) = ws.label.as_ref().filter(|l| !l.is_empty()) {
            r.put("wsName", s(l));
        }
        let mut app = Obj::default();
        app.put("rank", ws.rank.filter(|x| x.is_finite()).map_or(OVal::Null, OVal::Num))
            .put("pinned", ws.is_pinned.map_or(OVal::Null, OVal::Bool))
            .put("focused", OVal::Bool(focused.as_deref() == Some(ws.id.as_str())))
            .put("finish", snap::finish_signal(ws).map_or(OVal::Null, |f| s(&f)))
            .put("brief", snap.brief_status(ws, e.now).map_or(OVal::Null, s))
            .put("builderType", ws.builder_type.as_ref().map_or(OVal::Null, |t| s(t)));
        r.put("app", app.done());
    }
    let rank = |o: &Obj| match field(o, "app") {
        Some(a) => finite(a.get("rank")).unwrap_or(f64::INFINITY),
        None => f64::INFINITY,
    };
    rows.sort_by(|a, b| rank(a).partial_cmp(&rank(b)).unwrap_or(std::cmp::Ordering::Equal));
    fold(e, rows, &Some(snap))
}

/// The ghost-row fold: a `primary-<hash>` label folds into its canonical row, carrying its unread count and hints.
fn fold(e: &Eng, rows: &mut Vec<Obj>, snap: &Option<&Snap>) -> R<()> {
    let aliases = crate::meshw::common::read_aliases(&e.inv.home);
    let present: HashSet<String> = rows.iter().filter_map(|r| str_field(r, "id").map(str::to_string)).collect();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for (i, r) in rows.iter().enumerate() {
        if let Some(id) = str_field(r, "id") {
            by_id.insert(id.to_string(), i);
        }
    }
    let mut folded: HashSet<usize> = HashSet::new();
    for i in 0..rows.len() {
        let Some(id) = str_field(&rows[i], "id").map(str::to_string) else { continue };
        let mut app_builder: Option<String> = None;
        if let (Some(snap), Some(wt)) = (snap, str_field(&rows[i], "worktreePath"))
            && let Some(ws) = snap.workspace_for(None, Some(wt))?
            && ws.builder_type.as_deref() != Some(key("devswarm_sup.as_primary_type"))
        {
            app_builder = Some(ws.id.clone());
        }
        let Some(to) = fold_target(e, &id, &present, &aliases, app_builder.as_deref())? else { continue };
        let Some(&t) = by_id.get(&to) else { continue };
        if t == i {
            continue;
        }
        let direct = num_field(&rows[i], "directUnread").filter(|d| *d > 0.0);
        let ghost_hints = hints_of(&rows[i]);
        let target = &mut rows[t];
        if let Some(d) = direct {
            target.put("directUnread", OVal::Num(num_field(target, "directUnread").unwrap_or(0.0) + d));
        }
        if !ghost_hints.is_empty() {
            let mut merged = hints_of(target);
            for h in ghost_hints {
                if !merged.contains(&h) {
                    merged.push(h);
                }
            }
            target.put("hints", strings(&merged));
        }
        let mut aliases_so_far = match field(target, "foldedAliases") {
            Some(OVal::Arr(a)) => a.clone(),
            _ => Vec::new(),
        };
        aliases_so_far.push(s(&id));
        target.put("foldedAliases", OVal::Arr(aliases_so_far));
        folded.insert(i);
    }
    let mut idx = 0;
    rows.retain(|_| {
        let keep = !folded.contains(&idx);
        idx += 1;
        keep
    });
    Ok(())
}

/// The row-state readers the Primary prompt hook needs apart from [`Verdicts`]: the app's verdict alone (`appArchivedVerdict`, then the
/// supervisor's active-list cache), the ghost-label fold target, and the two activity windows.
pub(crate) struct Windows<'a>(Eng<'a>);

impl<'a> Windows<'a> {
    pub(crate) fn new(inv: &'a Inv, repo_key: &'a str) -> Windows<'a> {
        Windows(Eng { inv, now: inv.now as f64, repo_key, dormant: std::cell::OnceCell::new(), active: std::cell::OnceCell::new() })
    }

    /// The app side of "archived" for a row.
    pub(crate) fn app_archived(&self, id: &str, wt: Option<&str>) -> R<bool> {
        app_archived(&self.0, id, wt)
    }

    /// `rosterFoldTarget(home, id, present, { aliases, appBuilderId })`.
    pub(crate) fn fold_target(&self, id: &str, present: &HashSet<String>, aliases: &[(String, String)], app_builder: Option<&str>) -> R<Option<String>> {
        fold_target(&self.0, id, present, aliases, app_builder)
    }

    /// `dormantThresholdMs(env)` (defers on a value the engine does not reproduce).
    pub(crate) fn dormant_ms(&self) -> R<f64> {
        dormant_ms(&self.0)
    }

    /// `idleThresholdMs(env)`.
    pub(crate) fn idle_ms(&self) -> f64 {
        idle_ms(&self.0)
    }

    /// `isSessionAliveRow({ sessionId })`.
    pub(crate) fn session_alive(&self, session: Option<&str>) -> R<bool> {
        session_alive(&self.0, session)
    }

    /// `readActivityTs`: the newest activity signal (0 for none) and whether the session transcript was seen.
    pub(crate) fn activity(&self, id: &str, wt: Option<&str>, session: Option<&str>, last_out: Option<f64>) -> R<(f64, bool)> {
        activity(&self.0, id, wt, session, last_out)
    }

    /// `isDormantByActivity`.
    pub(crate) fn dormant_by_activity(&self, id: &str, wt: Option<&str>, session: Option<&str>, last_out: Option<f64>) -> R<bool> {
        dormant_by_activity(&self.0, id, wt, session, last_out)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// the roster
// ---------------------------------------------------------------------------------------------------------------------

/// `cmdRoster`'s rows for a project whose store holds `sum`.
pub fn build(inv: &Inv, repo_key: &str, st: &MeshStore, sum: &OVal, main_worktree: Option<&str>) -> R<Built> {
    let e = Eng { inv, now: inv.now as f64, repo_key, dormant: std::cell::OnceCell::new(), active: std::cell::OnceCell::new() };
    // `Object.values(sum.workspaces || {})`: the integer-like keys first, ascending, then the others in their order
    let workspaces: Vec<&OVal> = match sum.get("workspaces") {
        Some(OVal::Obj(ws)) => {
            let mut indexed: Vec<(u64, &OVal)> =
                ws.iter().filter(|(k, _)| is_array_index_key(k)).filter_map(|(k, v)| Some((k.parse::<u64>().ok()?, v))).collect();
            indexed.sort_by_key(|(n, _)| *n);
            indexed.into_iter().map(|(_, v)| v).chain(ws.iter().filter(|(k, _)| !is_array_index_key(k)).map(|(_, v)| v)).collect()
        }
        Some(OVal::Arr(items)) => items.iter().collect(),
        _ => Vec::new(),
    };
    let counts = instance_counts(st, e.now)?;
    let mut rows: Vec<Obj> = Vec::new();
    for w in workspaces {
        // a summary row's `id` is its registry id (a text); anything else reads as the text `String()` gives it
        let id = &match w.get("id") {
            Some(OVal::Str(t)) => t.clone(),
            Some(other) => ident::js_to_string(other),
            None => key("mesh_write.js_undefined").to_string(),
        };
        let wt = truthy_str(w.get("worktreePath"))?;
        let session = truthy_str(w.get("sessionId"))?;
        let only_archived = archive_complete(&e, id);
        let mut h = hints(&e, id, wt.as_deref(), session.as_deref(), true)?;
        if only_archived {
            h.insert(0, key("devswarm_cli.rr_hint_archived").to_string());
        }
        let instances = counts.get(id.as_str()).copied();
        if instances.is_some_and(|n| n > 1.0) {
            h.push(key("devswarm_cli.rr_hint_split").to_string());
        }
        if !only_archived && matches!(w.get("gates").and_then(|g| g.get(key("mesh_write.gate_done"))), Some(OVal::Bool(true))) {
            h.push(key("devswarm_cli.rr_hint_done").to_string());
            h.push(key("devswarm_cli.rr_hint_archive_pending").to_string());
        }
        let mut o = Obj::default();
        for k in ["id", "working_on", "directUnread", "broadcastUnread", "urgencyMax"] {
            if let Some(v) = w.get(k) {
                o.put(k, v.clone());
            }
        }
        o.put("worktreePath", wt.as_deref().map_or(OVal::Null, s))
            .put("source", s(key(if only_archived { "devswarm_cli.rr_source_archived" } else { "devswarm_cli.rr_source_store" })))
            .put(
                "meshId",
                match wt.as_deref() {
                    Some(p) => s(&ident::primary_workspace_id(p)?),
                    None => OVal::Null,
                },
            )
            .put("hints", strings(&h))
            .put("wsName", if is_safe_id(id) { crate::dssup::appsync::state::read_name(&inv.home, id).map_or(OVal::Null, |n| s(&n)) } else { OVal::Null });
        if let Some(n) = instances {
            o.put("instances", OVal::Num(n));
        }
        rows.push(o);
    }
    let mut known: HashSet<String> = HashSet::new();
    for r in &rows {
        if let Some(p) = str_field(r, "worktreePath") {
            known.insert(ident::primary_workspace_id(p)?);
        }
    }
    // native `hivecontrol` children that no store row represents: a row of their own, or the archived row their worktree belongs to
    let archived_by_wt = archived_by_worktree(&e)?;
    for child in fetch_native_children(&e) {
        if child.path.as_deref().is_some_and(|p| ident::primary_workspace_id(p).is_ok_and(|m| known.contains(&m))) {
            continue; // already represented via the store
        }
        let mesh_id = child.path.as_deref().and_then(|p| ident::primary_workspace_id(p).ok());
        let archived_id = mesh_id.as_ref().and_then(|m| archived_by_wt.get(m));
        // the app's own database saying the worktree is ACTIVE outranks a stale marker (a path reused by a newer live workspace)
        let app_active = match (archived_id, child.path.as_deref()) {
            (Some(_), Some(p)) => appdb::archived_verdict(&inv.home, &inv.env, inv.now, "", Some(p), false)?.0 == Some(false),
            _ => false,
        };
        let folded_name = child.branch.clone().or_else(|| child.id.clone()).unwrap_or_default();
        if let Some(aid) = archived_id.filter(|_| !app_active) {
            if let Some(prior) = rows.iter_mut().find(|r| str_field(r, "id") == Some(aid.as_str())) {
                let mut folded = match field(prior, "foldedNative") {
                    Some(OVal::Arr(a)) => a.clone(),
                    _ => Vec::new(),
                };
                folded.push(s(&folded_name));
                prior.put("foldedNative", OVal::Arr(folded));
                continue;
            }
            let mut h = hints(&e, aid, child.path.as_deref(), None, false)?;
            if !h.iter().any(|x| x == key("devswarm_cli.rr_hint_archived")) {
                h.insert(0, key("devswarm_cli.rr_hint_archived").to_string());
            }
            let mut o = Obj::default();
            o.put("id", s(aid))
                .put("working_on", OVal::Null)
                .put("directUnread", OVal::Null)
                .put("broadcastUnread", OVal::Null)
                .put("urgencyMax", OVal::Null)
                .put("worktreePath", child.path.as_deref().map_or(OVal::Null, s))
                .put("source", s(key("devswarm_cli.rr_source_archived")))
                .put("meshId", mesh_id.as_deref().map_or(OVal::Null, s))
                .put("hints", strings(&h))
                .put("wsName", child.label.as_deref().map_or(OVal::Null, s))
                .put("foldedNative", OVal::Arr(vec![s(&folded_name)]));
            rows.push(o);
            continue;
        }
        let id = child.branch.clone().or_else(|| child.id.clone());
        let h = hints(&e, id.as_deref().unwrap_or(""), child.path.as_deref(), None, false)?;
        let mut o = Obj::default();
        o.put("id", id.as_deref().map_or(OVal::Null, s))
            .put("working_on", OVal::Null)
            .put("directUnread", OVal::Null)
            .put("broadcastUnread", OVal::Null)
            .put("urgencyMax", OVal::Null)
            .put("worktreePath", child.path.as_deref().map_or(OVal::Null, s))
            .put("source", s(key("devswarm_cli.rr_source_native")))
            .put("meshId", mesh_id.as_deref().map_or(OVal::Null, s))
            .put("hints", strings(&h))
            .put("wsName", child.label.as_deref().map_or(OVal::Null, s));
        rows.push(o);
    }
    // Fix 1 (split-brain heal, READ-ONLY): a Primary registered into the legacy hash bucket is invisible to the project's own
    // summary; its already-derived summary under that hash is folded in, labeled `store-fallback`
    if let Some(main) = main_worktree {
        let primary = ident::primary_workspace_id(main)?;
        let fallback = crate::meshw::send::hash_from_workspace_id(&primary);
        let already = known.contains(&primary) || rows.iter().any(|r| str_field(r, "id") == Some(primary.as_str()));
        if !fallback.is_empty() && fallback != repo_key && !already {
            let file = devswarm_root(&inv.home).join(key("mesh_write.dir_summaries")).join(format!("{fallback}{}", key("mesh_write.json_suffix")));
            let sum2 =
                std::fs::read(&file).ok().map(|b| String::from_utf8_lossy(&b).into_owned()).filter(|t| !t.trim().is_empty()).and_then(|t| OVal::parse(&t));
            if let Some(pw) = sum2.as_ref().and_then(|s2| s2.get("workspaces")).and_then(|w| w.get(&primary)).filter(|pw| pw.truthy()) {
                let fe = Eng { inv, now: e.now, repo_key: &fallback, dormant: std::cell::OnceCell::new(), active: std::cell::OnceCell::new() };
                let pid = match pw.get("id") {
                    Some(OVal::Str(t)) => t.clone(),
                    Some(other) => ident::js_to_string(other),
                    None => String::new(),
                };
                let pwt = truthy_str(pw.get("worktreePath"))?;
                let psession = truthy_str(pw.get("sessionId"))?;
                let h = hints(&fe, &pid, pwt.as_deref(), psession.as_deref(), true)?;
                let mut o = Obj::default();
                if let Some(v) = pw.get("id") {
                    o.put("id", v.clone());
                }
                for k in ["working_on", "directUnread", "broadcastUnread", "urgencyMax"] {
                    if let Some(v) = pw.get(k) {
                        o.put(k, v.clone());
                    }
                }
                o.put("worktreePath", pwt.as_deref().map_or(OVal::Null, s))
                    .put("source", s(key("devswarm_cli.rr_source_fallback")))
                    .put(
                        "meshId",
                        match pwt.as_deref() {
                            Some(p) => ident::primary_workspace_id(p).map_or(OVal::Null, |m| s(&m)),
                            None => OVal::Null,
                        },
                    )
                    .put("hints", strings(&h))
                    .put(
                        "wsName",
                        if is_safe_id(&pid) { crate::dssup::appsync::state::read_name(&inv.home, &pid).map_or(OVal::Null, |n| s(&n)) } else { OVal::Null },
                    );
                rows.push(o);
            }
        }
    }
    let shown: HashSet<String> = rows.iter().filter_map(|r| str_field(r, "id").map(str::to_string)).collect();
    rows.extend(archived_rows(&e, &shown)?);
    // the app database: read once, as Node's per-process snapshot
    let snap = match ident::app_db_path(&inv.home, &inv.env) {
        Some(f) => snap::read(&f)?,
        None => None,
    };
    for r in rows.iter_mut() {
        r.put("appArchived", OVal::Null);
    }
    let mut live_report: Option<OVal> = None;
    if let Some(sn) = &snap {
        let found = app_still_live(&e, sn)?;
        if !found.is_empty() {
            let cmds: Vec<&str> = found.iter().map(|f| f.4.as_str()).collect();
            let mut rep = Obj::default();
            rep.put("count", OVal::Num(found.len() as f64)).put(
                "rows",
                OVal::Arr(
                    found
                        .iter()
                        .map(|(id, app_id, branch, label, cmd)| {
                            let mut r = Obj::default();
                            r.put("id", s(id))
                                .put("appId", s(app_id))
                                .put("branch", branch.as_deref().map_or(OVal::Null, s))
                                .put("label", label.as_deref().map_or(OVal::Null, s))
                                .put("cmd", s(cmd));
                            r.done()
                        })
                        .collect(),
                ),
            );
            rep.put(
                "message",
                s(&tpl(
                    "devswarm_cli.rr_app_live_message",
                    &[("count", &found.len().to_string()), ("cmds", &cmds.join(key("devswarm_cli.rr_app_live_cmd_sep")))],
                )),
            );
            live_report = Some(rep.done());
            for (id, ..) in &found {
                if let Some(r) = rows.iter_mut().find(|r| str_field(r, "id") == Some(id.as_str())) {
                    let mut h = hints_of(r);
                    if !h.iter().any(|x| x == key("devswarm_cli.rr_hint_app_live")) {
                        h.push(key("devswarm_cli.rr_hint_app_live").to_string());
                        r.put("hints", strings(&h));
                    }
                }
            }
        }
    }
    enrich(&e, &mut rows, &snap)?;
    // Plan tracking: a row whose workspace has a step plan gains a `plan` field; a row without one is left as it was. A plan Node
    // would throw on part-way ends the pass there (its `try/catch` keeps the rows done so far and drops the rest).
    if crate::checks::guardkit::settings::get_bool(&inv.settings(), defaults::raw("devswarm_cli.sp_set_plan_tracking")) {
        for r in rows.iter_mut() {
            if str_field(r, "source") == Some(key("devswarm_cli.rr_source_archived")) {
                continue;
            }
            let id = str_field(r, "id").unwrap_or("").to_string();
            let wt = str_field(r, "worktreePath").map(str::to_string);
            let fields = (|| -> Result<Option<OVal>, ()> {
                let Some(found) = plan::find_for(inv, &id, wt.as_deref()).map_err(|_| ())? else { return Ok(None) };
                Ok(Some(plan_fields(inv, &found, e.now)?))
            })();
            match fields {
                Ok(Some(f)) => {
                    r.put("plan", f);
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    }
    Ok(Built { rows, app_still_live: live_report })
}

/// `Math.round(x)`: halves round up.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `devswarm-token-usage.js` `fmt(n)`.
fn fmt_tokens(n: f64) -> String {
    let v = if n.is_nan() { 0.0 } else { n };
    if v >= defaults::num("devswarm_cli.rr_tok_mega_at") as f64 {
        let tenths = defaults::num("devswarm_cli.rr_tok_tenths") as f64;
        return format!("{}{}", to_js_string(js_round(v / defaults::num("devswarm_cli.rr_tok_tenth_div") as f64) / tenths), key("devswarm_cli.rr_tok_mega"));
    }
    if v >= defaults::num("devswarm_cli.rr_tok_kilo_at") as f64 {
        return format!("{}{}", to_js_string(js_round(v / defaults::num("devswarm_cli.rr_tok_kilo_at") as f64)), key("devswarm_cli.rr_tok_kilo"));
    }
    to_js_string(js_round(v))
}

/// `Number(v)` of a plan or state field (a text is parsed; `null` is 0; an array or object is not reproduced as a number).
fn number_of(v: Option<&OVal>) -> f64 {
    match v {
        None => f64::NAN,
        Some(OVal::Null) => 0.0,
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Num(x)) => *x,
        Some(OVal::Str(t)) => js_number_of_str(t),
        Some(_) => f64::NAN,
    }
}

/// A field as a JSON value, absent when the source has none (`JSON.stringify` drops an `undefined`).
fn carried(o: &mut Obj, k: &str, v: Option<&OVal>) {
    if let Some(v) = v {
        o.put(k, v.clone());
    }
}

/// `planLib.currentStep(plan)`: the newest open step being worked on or blocked, else the first open one.
fn current_step(plan_doc: &OVal) -> Option<&OVal> {
    let steps = plan::steps_of(plan_doc);
    let mut best: Option<&OVal> = None;
    let mut first_open: Option<&OVal> = None;
    for st in steps.iter().filter(|x| !plan::status_is(x, defaults::text("mesh_write.plan_status_done"))) {
        first_open.get_or_insert(st);
        let working =
            plan::status_is(st, defaults::text("mesh_write.plan_status_doing")) || plan::status_is(st, defaults::text("mesh_write.plan_status_blocked"));
        if !working {
            continue;
        }
        let ts = |x: &OVal| {
            let n = number_of(x.get("ts"));
            if n.is_nan() { 0.0 } else { n }
        };
        if best.is_none_or(|b| ts(st) >= ts(b)) {
            best = Some(st);
        }
    }
    best.or(first_open)
}

/// What the tracker saw the workspace do (see `agents::sources::live_plan`) when that is ahead of its plan: more task-list completions
/// than the plan counts done, or a commit, push, merge or deploy after the plan's last report. The label text to append, and the facts
/// for the row's `live` field. `None`: no such file, or the plan is as current as the work.
fn live_work(inv: &Inv, plan_doc: &OVal, now: f64) -> Option<(String, OVal)> {
    let cfg = defaults::raw("agent_tracker.live_plan");
    let paths = defaults::raw("agent_tracker.paths");
    let id = ident::js_to_string(plan_doc.get("id")?);
    if !is_safe_id(&id) {
        return None;
    }
    let file =
        inv.home.join(paths.str_field("base")).join(paths.str_field("dir")).join(cfg.str_field("dir")).join(format!("{id}{}", paths.str_field("json_ext")));
    let facts = read_obj(&file)?;
    let facts = facts.get("facts")?.clone();
    let get = |k: &str| {
        let n = number_of(facts.get(k));
        if n.is_finite() { n } else { 0.0 }
    };
    let (tasks, commits, shipped, last_ship) = (get("tasks_done"), get("commits"), get("shipped"), get("last_ship_ms"));
    let stale_ms = cfg.get("stale_ms").and_then(defaults::V::as_integer).unwrap_or(0) as f64;
    let reported = ["step_ts", "activity_ts"].iter().map(|k| number_of(plan_doc.get(k))).filter(|n| n.is_finite()).fold(0.0, f64::max);
    let ahead_tasks = tasks > plan::steps_done(plan_doc) as f64;
    let ahead_ship = last_ship > reported + stale_ms;
    if !ahead_tasks && !ahead_ship {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if tasks > 0.0 {
        parts.push(defaults::render("mesh_write.lbl_live_tasks", &[("n", &tasks)]));
    }
    if commits > 0.0 {
        parts.push(defaults::render("mesh_write.lbl_live_commits", &[("n", &commits)]));
    }
    if shipped > 0.0 {
        parts.push(defaults::render("mesh_write.lbl_live_shipped", &[("n", &shipped)]));
    }
    if last_ship > 0.0 {
        parts.push(defaults::render("mesh_write.lbl_live_last", &[("dur", &plan::dur(now - last_ship))]));
    }
    let text = defaults::render("mesh_write.lbl_live", &[("parts", &parts.join(defaults::text("mesh_write.lbl_sep")))]);
    Some((text, facts))
}

/// The `plan` field of a roster row (roster-diag.js `cmdRoster`, plan tracking): label, current step, counts, extras, the token burn
/// once the supervisor has read the child's transcript, and the straying warnings with any Jev recommendation. An `Err` is a plan
/// Node's code would throw on.
fn plan_fields(inv: &Inv, found: &plan::Found, now: f64) -> Result<OVal, ()> {
    let plan_doc = &found.plan;
    let cur = current_step(plan_doc);
    let mut label = plan::finish_label(plan_doc, now).map_err(|_| ())?;
    let live = live_work(inv, plan_doc, now);
    if let (Some((text, _)), true) = (&live, label.truthy()) {
        label = s(&format!("{}{text}", ident::js_to_string(&label)));
    }
    let mut o = Obj::default();
    let put_label = |o: &mut Obj, l: &OVal| {
        o.put("label", l.clone());
    };
    put_label(&mut o, &label);
    match cur {
        Some(c) => {
            if let Some(n) = c.get("n") {
                o.put("step", n.clone());
            }
        }
        None => {
            o.put("step", OVal::Null);
        }
    }
    if let Some((_, facts)) = live {
        o.put("live", facts);
    }
    o.put("of", OVal::Num(plan::steps_of(plan_doc).len() as f64)).put("done", OVal::Num(plan::steps_done(plan_doc) as f64));
    match cur {
        Some(c) => carried(&mut o, "stepText", c.get("text")),
        None => {
            o.put("stepText", OVal::Null);
        }
    }
    let extras: Vec<OVal> = match plan_doc.get("extras") {
        None | Some(OVal::Null) => Vec::new(),
        Some(OVal::Arr(items)) => {
            let mut out = Vec::new();
            for x in items {
                let mut e = Obj::default();
                match x {
                    OVal::Null => return Err(()),
                    OVal::Obj(_) | OVal::Arr(_) => {
                        carried(&mut e, "glob", x.get("glob"));
                        carried(&mut e, "note", x.get("note"));
                    }
                    _ => {}
                }
                out.push(e.done());
            }
            out
        }
        Some(v) if !v.truthy() => Vec::new(),
        Some(_) => return Err(()),
    };
    o.put("extras", OVal::Arr(extras));
    // the token burn: only once the supervisor has read the child's transcript
    let tok = if is_safe_id(&found.key) {
        read_obj(&devswarm_root(&inv.home).join(key("devswarm_cli.rr_dir_token_usage")).join(format!("{}{}", found.key, key("mesh_write.json_suffix"))))
            .filter(|v| matches!(v, OVal::Obj(_) | OVal::Arr(_)))
    } else {
        None
    };
    if let Some(tok) = tok {
        let total = number_of(tok.get("total"));
        if total.is_finite() && total > 0.0 {
            let since = number_of(tok.get("sinceStep"));
            let since = if since.is_nan() || since == 0.0 { 0.0 } else { since };
            let mut t = Obj::default();
            t.put("total", OVal::Num(js_round(total))).put("sinceStep", if since.is_finite() { OVal::Num(js_round(since)) } else { OVal::Null });
            o.put("tokens", t.done());
            if label.truthy() {
                let text =
                    format!("{}{}{}{}", ident::js_to_string(&label), key("devswarm_cli.rr_tok_sep"), fmt_tokens(total), key("devswarm_cli.rr_tok_suffix"));
                label = s(&text);
                put_label(&mut o, &label);
            }
        }
    }
    // straying warnings with any Jev recommendation (the Primary decides)
    let stray = if is_safe_id(&found.key) {
        read_obj(&devswarm_root(&inv.home).join(key("devswarm_cli.dir_stray")).join(format!("{}{}", found.key, key("mesh_write.json_suffix"))))
            .filter(|v| matches!(v, OVal::Obj(_)))
    } else {
        None
    };
    if let Some(OVal::Arr(active)) = stray.as_ref().and_then(|st| st.get("active"))
        && !active.is_empty()
    {
        let mut out = Vec::new();
        for a in active {
            if matches!(a, OVal::Null) {
                return Err(());
            }
            let mut m = Obj::default();
            carried(&mut m, "signal", a.get("signal"));
            carried(&mut m, "step", a.get("step"));
            carried(&mut m, "reason", a.get("reason"));
            let jev: Vec<OVal> = match a.get("jev") {
                Some(OVal::Arr(items)) => {
                    let mut v = Vec::new();
                    for n in items {
                        if matches!(n, OVal::Null) {
                            return Err(());
                        }
                        let mut j = Obj::default();
                        carried(&mut j, "integration", n.get("integration"));
                        carried(&mut j, "verdict", n.get("verdict"));
                        carried(&mut j, "confidence", n.get("confidence"));
                        v.push(j.done());
                    }
                    v
                }
                _ => Vec::new(),
            };
            m.put("jev", OVal::Arr(jev));
            out.push(m.done());
        }
        o.put("straying", OVal::Arr(out));
    }
    Ok(o.done())
}

// ---------------------------------------------------------------------------------------------------------------------
// the text table
// ---------------------------------------------------------------------------------------------------------------------

/// `rosterIsArchivedRow(w)`.
pub fn is_archived_row(o: &Obj) -> bool {
    str_field(o, "source") == Some(key("devswarm_cli.rr_source_archived")) || hints_of(o).iter().any(|h| h == key("devswarm_cli.rr_hint_archived"))
}

/// `rosterRelative(ts, now)`.
fn relative(ts: Option<f64>, now: f64) -> String {
    let Some(ts) = ts.filter(|t| t.is_finite() && *t > 0.0) else { return key("devswarm_cli.rr_text_dash").to_string() };
    let secs = ((now - ts).max(0.0) / 1000.0).floor();
    if secs < 60.0 {
        return format!("{}s", to_js_string(secs));
    }
    let mins = (secs / 60.0).floor();
    if mins < 60.0 {
        return format!("{}m", to_js_string(mins));
    }
    let hours = (mins / 60.0).floor();
    if hours < 24.0 { format!("{}h", to_js_string(hours)) } else { format!("{}d", to_js_string((hours / 24.0).floor())) }
}

/// `rosterHumanText(result, { all, home, now })`.
pub fn human_text(inv: &Inv, rows: &[Obj], all: bool, now: f64) -> R<String> {
    let e = Eng { inv, now, repo_key: "", dormant: std::cell::OnceCell::new(), active: std::cell::OnceCell::new() };
    let shown: Vec<&Obj> = rows.iter().filter(|r| all || !is_archived_row(r)).collect();
    let hidden = rows.len() - shown.len();
    let mut lines: Vec<String> = Vec::new();
    if shown.is_empty() {
        lines.push(key("mesh_write.roster_none_text").to_string());
    } else {
        lines.extend(defaults::list("devswarm_cli.rr_text_header").iter().map(|l| l.to_string()));
        for r in shown {
            let h = hints_of(r);
            let status = if h.is_empty() {
                key("devswarm_cli.rr_text_active").to_string()
            } else {
                h.iter()
                    .take(defaults::num("devswarm_cli.rr_text_status_max") as usize)
                    .map(|x| x.split(key("devswarm_cli.rr_text_hint_cut")).next().unwrap_or_default().to_string())
                    .collect::<Vec<_>>()
                    .join(key("devswarm_cli.rr_text_status_sep"))
            };
            let finish = match field(r, "app").and_then(|a| a.get("finish")) {
                Some(OVal::Str(f)) if !f.is_empty() => f.clone(),
                _ => key("devswarm_cli.rr_text_dash").to_string(),
            };
            let unread = match num_field(r, "directUnread") {
                None => key("devswarm_cli.rr_text_dash").to_string(),
                Some(d) => match num_field(r, "broadcastUnread").filter(|b| *b > 0.0) {
                    Some(b) => tpl("devswarm_cli.rr_text_unread_bcast", &[("direct", &to_js_string(d)), ("bcast", &to_js_string(b))]),
                    None => to_js_string(d),
                },
            };
            let id = str_field(r, "id");
            let last = id.and_then(|i| last_outbound(&e, i));
            let name = match (field(r, "wsName"), id) {
                (Some(OVal::Str(n)), Some(i)) if !n.is_empty() => {
                    let short = crate::meshw::appverbs::short(i)?;
                    tpl("devswarm_cli.rr_text_name", &[("name", n), ("short", &short)])
                }
                (_, Some(i)) => i.to_string(),
                _ => String::new(),
            };
            let pipe = defaults::list("devswarm_cli.rr_text_pipe");
            let name = name.replace(pipe[0], pipe[1]);
            lines.push(tpl(
                "devswarm_cli.rr_text_row",
                &[("name", &name), ("status", &status), ("finish", &finish), ("unread", &unread), ("last", &relative(last, now))],
            ));
        }
    }
    if hidden > 0 {
        lines.push(tpl("devswarm_cli.rr_text_hidden", &[("n", &hidden.to_string())]));
    }
    Ok(lines.join("\n"))
}

/// The row-state readers of the roster for another verb (`diagnose`, `healthcheck`): the same archived and live verdicts.
pub(crate) struct Verdicts<'a>(Eng<'a>);

impl<'a> Verdicts<'a> {
    /// Verdicts for one project at the invocation's clock.
    pub(crate) fn new(inv: &'a Inv, repo_key: &'a str) -> Verdicts<'a> {
        Verdicts(Eng { inv, now: inv.now as f64, repo_key, dormant: std::cell::OnceCell::new(), active: std::cell::OnceCell::new() })
    }

    /// `rowEligibility(...).archived`: anti-hall's archive marker or the app's verdict.
    pub(crate) fn archived(&self, id: &str, wt: Option<&str>) -> R<bool> {
        archived(&self.0, id, wt, None)
    }

    /// `computeRowLive` / `isSiblingPartitionLive` of a row (`session` already empty-to-none).
    pub(crate) fn live(&self, id: &str, wt: Option<&str>, session: Option<&str>) -> R<bool> {
        row_live(&self.0, id, wt, session)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::args;
    use std::os::unix::fs::PermissionsExt;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-roster-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        d.canonicalize().unwrap()
    }

    fn git_init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let st = std::process::Command::new("git").current_dir(dir).args(["init", "-q", "-b", "main"]).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap();
        assert!(st.success());
    }

    /// A `hivecontrol` that answers the capability probe and the two `workspace list` calls.
    fn stub(dir: &Path, children: &str, trusted: &str) -> PathBuf {
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let script = format!(
            "#!/bin/sh\ncase \"$*\" in\n  \"--version\") echo 'hivecontrol 2.5.7';;\n  \"workspace --help\") printf 'Commands:\\n  list [options]  List workspaces\\n';;\n  \"workspace list children\") cat <<'JSON'\n{children}\nJSON\n;;\n  \"workspace list all\") cat <<'JSON'\n{trusted}\nJSON\n;;\n  *) exit 3;;\nesac\n"
        );
        let p = bin.join("hivecontrol");
        std::fs::write(&p, script).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    struct Fx {
        inv: Inv,
        repo_key: String,
    }

    fn fixture(tag: &str, children: &str, trusted: &str) -> Fx {
        let home = scratch(tag);
        let repo = home.join("repo");
        git_init(&repo);
        let repo = repo.canonicalize().unwrap();
        let bin = stub(&home, children, trusted);
        let env: crate::meshw::ident::Env = [("PATH".to_string(), format!("{}:/usr/bin:/bin", bin.display()))].into_iter().collect();
        let inv = Inv {
            home: home.clone(),
            write_home: home,
            env,
            cwd: repo.to_string_lossy().into_owned(),
            now: crate::meshw::common::now_ms(),
            stdin: None,
            store_override: None,
        };
        let repo_key = ident::repo_key_for_worktree(&inv.cwd).unwrap().unwrap();
        Fx { inv, repo_key }
    }

    fn roster_json(fx: &Fx) -> serde_json::Value {
        let a = args::parse(&["roster".to_string(), "--json".to_string()]);
        let ans = crate::meshw::roster::run(&fx.inv, &a).unwrap();
        serde_json::from_str(ans.stdout.trim()).unwrap()
    }

    /// 2026-10-23: a native child no store row represents made `roster` hand over to Node; it is a row of its own.
    #[test]
    fn a_native_child_no_store_row_represents_is_a_row_of_its_own() {
        let fx = fixture("native", r#"[{"branch":"feat/x","path":"/nowhere/ah-native-x","label":"X"}]"#, "[]");
        let v = roster_json(&fx);
        assert_eq!(v["count"], 1, "{v}");
        let row = &v["workspaces"][0];
        assert_eq!(row["id"], "feat/x");
        assert_eq!(row["source"], "native");
        assert_eq!(row["wsName"], "X");
        assert_eq!(row["worktreePath"], "/nowhere/ah-native-x");
        assert!(row["hints"].as_array().unwrap().iter().any(|h| h == "worktree-gone"), "{row}");
        assert!(!row["hints"].as_array().unwrap().iter().any(|h| h == "phantom"), "a native child is never a phantom: {row}");
    }

    /// Children of another repository are dropped (and logged), not handed to Node.
    #[test]
    fn children_of_another_repository_are_dropped() {
        let fx = fixture(
            "mismatch",
            r#"[{"branch":"a","path":"/nowhere/a","repositoryId":"repo-A"},{"branch":"b","path":"/nowhere/b"}]"#,
            r#"[{"repositoryId":"repo-B"}]"#,
        );
        let v = roster_json(&fx);
        assert_eq!(v["count"], 1, "{v}");
        assert_eq!(v["workspaces"][0]["id"], "b", "only the child without a repository id stays: {v}");
    }

    /// A native child on the worktree of an archived workspace folds into that archived row.
    #[test]
    fn a_native_child_on_an_archived_worktree_folds_into_the_archived_row() {
        let fx = fixture("fold", r#"[{"branch":"feat/y","path":"/nowhere/ah-archived-y","label":"Y"}]"#, "[]");
        let dir = devswarm_root(&fx.inv.home).join(key("mesh_write.dir_archived"));
        std::fs::create_dir_all(&dir).unwrap();
        let desc = serde_json::json!({"id": "arch-1", "worktreePath": "/nowhere/ah-archived-y", "ownerKey": fx.repo_key});
        std::fs::write(dir.join("arch-1.json"), desc.to_string()).unwrap();
        let v = roster_json(&fx);
        let rows = v["workspaces"].as_array().unwrap();
        let row = rows.iter().find(|r| r["id"] == "arch-1").unwrap_or_else(|| panic!("{v}"));
        assert_eq!(row["source"], "archived");
        assert_eq!(row["foldedNative"][0], "feat/y");
        assert!(rows.iter().all(|r| r["id"] != "feat/y"), "no native row of its own: {v}");
    }

    fn active_fx(tag: &str, rows: serde_json::Value, fetched_ago_ms: i64) -> (Fx, String) {
        let fx = fixture(tag, "[]", "[]");
        let wt = "/nowhere/.devswarm/repos/1/h/mine";
        let snap = serde_json::json!({"fetchedAt": fx.inv.now - fetched_ago_ms, "byRepoKey": {fx.repo_key.clone(): rows}});
        std::fs::create_dir_all(devswarm_root(&fx.inv.home)).unwrap();
        std::fs::write(devswarm_root(&fx.inv.home).join(key("devswarm_cli.rr_active_list_file")), snap.to_string()).unwrap();
        (fx, wt.to_string())
    }

    fn descriptor_aged(fx: &Fx, id: &str, age_ms: u64) {
        let dir = devswarm_root(&fx.inv.home).join(key("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("{id}.json"));
        std::fs::write(&p, "{}").unwrap();
        let at = std::time::SystemTime::now() - std::time::Duration::from_millis(age_ms);
        std::fs::OpenOptions::new().write(true).open(&p).unwrap().set_modified(at).unwrap();
    }

    /// The supervisor's active-list snapshot: a row under the app's root that the fresh snapshot does not list, and that is older
    /// than the grace, reads as archived in the app; listed, too young or a stale snapshot reads as not.
    #[test]
    fn a_row_absent_from_a_fresh_active_list_reads_as_archived_in_the_app() {
        let (fx, wt) = active_fx("absent", serde_json::json!([{"id": "other", "worktreePath": "/nowhere/.devswarm/repos/1/h/other"}]), 1_000);
        descriptor_aged(&fx, "mine", 3_600_000);
        let e = Eng { inv: &fx.inv, now: fx.inv.now as f64, repo_key: &fx.repo_key, dormant: Default::default(), active: Default::default() };
        assert!(app_archived(&e, "mine", Some(&wt)).unwrap(), "older than the grace and unlisted");
        descriptor_aged(&fx, "young", 1_000);
        assert!(!app_archived(&e, "young", Some("/nowhere/.devswarm/repos/1/h/young")).unwrap(), "younger than the grace");
        assert!(!app_archived(&e, "other", Some("/nowhere/.devswarm/repos/1/h/other")).unwrap(), "listed");
        let (fx, wt) = active_fx("stale", serde_json::json!([{"id": "other"}]), 3 * 3_600_000);
        descriptor_aged(&fx, "mine", 7_200_000);
        let e = Eng { inv: &fx.inv, now: fx.inv.now as f64, repo_key: &fx.repo_key, dormant: Default::default(), active: Default::default() };
        assert!(!app_archived(&e, "mine", Some(&wt)).unwrap(), "a stale snapshot is no evidence");
    }

    /// `plan` fields of a roster row: label, current step, extras, the token burn and the straying signals.
    #[test]
    fn a_row_with_a_step_plan_gains_its_plan_fields() {
        let fx = fixture("plan", "[]", "[]");
        let plan_doc = OVal::parse(
            r#"{"steps":[{"n":1,"text":"one","status":"done","ts":5},{"n":2,"text":"two","status":"doing","ts":9},{"n":3,"text":"three","status":"todo"}],
                "extras":[{"glob":"docs/**","note":"asked"}],"step_ts":9}"#,
        )
        .unwrap();
        let root = devswarm_root(&fx.inv.home);
        std::fs::create_dir_all(root.join("token-usage")).unwrap();
        std::fs::write(root.join("token-usage").join("k1.json"), r#"{"total": 1234567, "sinceStep": 4200}"#).unwrap();
        std::fs::create_dir_all(root.join("stray")).unwrap();
        std::fs::write(
            root.join("stray").join("k1.json"),
            r#"{"active":[{"signal":"off-scope","step":2,"reason":"r","jev":[{"integration":"j","verdict":"v","confidence":0.5}]}]}"#,
        )
        .unwrap();
        let found = plan::Found { key: "k1".into(), plan: plan_doc };
        let f = plan_fields(&fx.inv, &found, 20.0).unwrap();
        assert_eq!(f.get("step"), Some(&OVal::Num(2.0)));
        assert_eq!(f.get("of"), Some(&OVal::Num(3.0)));
        assert_eq!(f.get("done"), Some(&OVal::Num(1.0)));
        assert_eq!(f.get("stepText"), Some(&OVal::Str("two".into())));
        assert_eq!(f.get("tokens").and_then(|t| t.get("total")), Some(&OVal::Num(1_234_567.0)));
        assert_eq!(f.get("tokens").and_then(|t| t.get("sinceStep")), Some(&OVal::Num(4200.0)));
        let label = ident::js_to_string(f.get("label").unwrap());
        assert!(label.ends_with(" \u{b7} 1.2M tok"), "{label}");
        assert_eq!(
            f.get("straying")
                .and_then(|s| match s {
                    OVal::Arr(a) => a.first(),
                    _ => None,
                })
                .and_then(|x| x.get("signal")),
            Some(&OVal::Str("off-scope".into()))
        );
        assert_eq!(fmt_tokens(950.0), "950");
        assert_eq!(fmt_tokens(15_500.0), "16k");
    }
}
