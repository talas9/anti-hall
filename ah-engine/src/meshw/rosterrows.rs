//! Plain `devswarm.js roster` for a project WITH rows, ported from `scripts/devswarm-lib/roster-diag.js` (`cmdRoster`,
//! `rosterHints`, `computeInstanceNonceCounts`, `rosterHumanText`) and the readers they stand on (`row-state.js`,
//! `row-eligibility.js`, `liveness.js` dormancy, `devswarm-app-db.js`, `devswarm-sender-alias.js`, `archive.js`
//! `localArchivedAppLive`).
//!
//! The roster is a read: nothing is written (`computeSummary` is the pure projection, the app database is opened read only,
//! the app-archived verdict never uses the cross-invocation cache here). So a case the engine cannot reproduce is handed to
//! Node, and Node then answers from the same untouched files. The cases handed to Node, per row class:
//! * a transcript the engine cannot read exactly as JavaScript does (see `rostertail`: a number or an id of an odd shape);
//! * a row with a step plan (the plan label, the token burn, the straying signals);
//! * a native `hivecontrol` child that is not already a store row (it adds a row of its own, with the archived-by-worktree join),
//!   a child whose repository id disagrees with the trusted lookup (Node logs it), the split-brain fallback row;
//! * an archived marker superseded by a newer occupant of its id (Node logs it), the supervisor's active-list cache, a
//!   dormancy window set outside the defaults the engine reads;
//! * whatever the shared readers defer on (an odd value in a descriptor, the app database or a verdict file).
//!
//! What it does produce: store rows with their hints (worktree gone, idle days, archived, dormant, idle-alive, phantom,
//! instance-split, done), archived-descriptor rows, the app database's rank, title, pinned, focused, finish and brief fields,
//! the apps-still-live report, the ghost-label fold and the text table.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable or torn optional file is the absent one (Node: `try { JSON.parse(readFileSync(...)) } catch (_) {}`)
use crate::checks::guardkit::ojson::{OVal, is_array_index_key};
use crate::checks::guardkit::text::{js_number_of_str, slice_utf16};
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::dssup::appsync::plan::{app_sourced, dir_of, read_json_dir, wt_key};
use crate::dssup::appsync::snap::{self, Snap};
use crate::dssup::liveness;
use crate::meshw::appdb;
use crate::meshw::common::{Inv, Obj, s};
use crate::meshw::extverbs::tpl;
use crate::meshw::hivecontrol;
use crate::meshw::ident::{self, R, defer};
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
        Some(_) => defer("field-type"),
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
        Some(_) => return defer("session-type"),
    })
}

/// `samePath(a, b)`: both resolved through the file system when they can be, else as given.
fn same_path(a: &str, b: &str) -> bool {
    ident::realpath(a).unwrap_or_else(|| a.to_string()) == ident::realpath(b).unwrap_or_else(|| b.to_string())
}

/// `isArchivedWorkspace(home, id, worktreePath)`: anti-hall's own archive marker. A marker a newer occupant of the id has
/// superseded is logged by Node, which the engine does not do, so that case is Node's.
fn marker_archived(e: &Eng, id: &str, wt: Option<&str>) -> R<bool> {
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
    let live = read_obj(&file_in(e, "mesh_write.dir_workspaces", id));
    let live_sid = match &live {
        Some(d @ (OVal::Obj(_) | OVal::Arr(_))) => real_sid(d.get(key("mesh_write.field_session_id")))?,
        _ => None,
    };
    if live_sid.is_some_and(|l| l != marker_sid) {
        return defer("marker-superseded");
    }
    Ok(true)
}

/// `isUnderDevswarmReposRoot(p)`.
fn under_repos_root(p: &str) -> R<bool> {
    if p.is_empty() {
        return Ok(false);
    }
    if !p.starts_with('/') {
        return defer("relative-path");
    }
    let resolved = ident::resolve_abs(p);
    let norm = ident::realpath(&resolved).unwrap_or(resolved);
    Ok(regex::Regex::new(key("devswarm_cli.rr_repos_root_re")).is_ok_and(|re| re.is_match(&norm)))
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
    match read_obj(&devswarm_root(&e.inv.home).join(key("devswarm_cli.rr_active_list_file"))) {
        None => Ok(false),
        Some(_) => defer("active-list-cache"),
    }
}

fn archived(e: &Eng, id: &str, wt: Option<&str>) -> R<bool> {
    Ok(marker_archived(e, id, wt)? || app_archived(e, id, wt)?)
}

fn fresh_beat(e: &Eng, id: &str) -> bool {
    is_safe_id(id) && liveness::is_fresh(liveness::heartbeat_ts(&e.inv.home, id), e.now, defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64)
}

/// `dormantThresholdMs(env)`: the setting, which a value of zero or below turns into Node's lower tiers (not reproduced).
fn dormant_ms(e: &Eng) -> R<f64> {
    if let Some(v) = e.dormant.get() {
        return Ok(*v);
    }
    let v = crate::dsact::settings::resolve(&e.inv.settings(), defaults::raw("devswarm_cli.rr_set_dormant_ms")).as_f64().unwrap_or(0.0);
    if !(v.is_finite() && v > 0.0) {
        return defer("dormant-ms");
    }
    Ok(*e.dormant.get_or_init(|| v))
}

/// `idleThresholdMs(env)`.
fn idle_ms(e: &Eng) -> f64 {
    let n = e.inv.env.get(key("devswarm_cli.rr_env_idle_ms")).map(|v| js_number_of_str(v)).unwrap_or(0.0);
    if n.is_finite() && n > 0.0 { n } else { defaults::num("devswarm_cli.rr_idle_ms_default") as f64 }
}

/// `isDormantByActivity(row, home, { now, lastOutboundTs })`.
fn dormant_by_activity(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>, last_out: Option<f64>) -> R<bool> {
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
    if is_safe_id(id)
        && let Some(beat) = read_obj(&file_in(e, "mesh_write.dir_heartbeats", id))
        && let Some(theirs) = beat.get(key("mesh_write.field_session_id"))
        && theirs.truthy()
    {
        let theirs = match theirs {
            OVal::Str(t) => t.clone(),
            OVal::Num(x) => to_js_string(*x),
            OVal::Bool(b) => b.to_string(),
            _ => return defer("heartbeat-session-type"),
        };
        if theirs != session {
            return Ok(None);
        }
    }
    if session.contains('/') || session.contains('\\') || session.contains("..") {
        return defer("session-path");
    }
    let encoded: String = {
        let from = key("devswarm_sup.lv_encode_chars");
        wt.chars().map(|c| if from.contains(c) { key("devswarm_sup.lv_encode_to").to_string() } else { c.to_string() }).collect()
    };
    let file = e
        .inv
        .home
        .join(key("mesh_write.claude_dir"))
        .join(key("devswarm_sup.lv_projects_dir"))
        .join(encoded)
        .join(format!("{session}{}", key("devswarm_sup.lv_transcript_ext")));
    rostertail::waiting_hint(&file, e.now)
}

/// `rosterHints(home, id, worktreePath, now, sessionId, { registryBacked })`.
fn hints(e: &Eng, id: &str, wt: Option<&str>, session: Option<&str>) -> R<Vec<String>> {
    let mut h: Vec<String> = Vec::new();
    if let Some(w) = wt
        && !Path::new(w).exists()
    {
        h.push(key("devswarm_cli.rr_hint_worktree_gone").to_string());
    }
    if let Some(d) = idle_days(e, id) {
        h.push(tpl("devswarm_cli.rr_hint_idle", &[("days", &to_js_string(d))]));
    }
    if archived(e, id, wt)? {
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
    } else if !row_live(e, id, wt, session)? {
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
        .map_err(|_| ident::Defer("messages".into()))?;
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
    path: Option<String>,
    repo_id: Option<String>,
}

/// `parseChildrenList(raw)`.
fn parse_children(raw: &str) -> R<Vec<Child>> {
    let parsed = OVal::parse(raw);
    let list: &[OVal] = match &parsed {
        Some(OVal::Arr(a)) => a,
        Some(o @ OVal::Obj(_)) => match o.get(key("mesh_write.roster_children_key")) {
            Some(OVal::Arr(a)) => a,
            _ => &[],
        },
        _ => &[],
    };
    let mut out = Vec::new();
    for el in list {
        if !matches!(el, OVal::Obj(_) | OVal::Arr(_)) {
            continue;
        }
        let path = match (truthy_str(el.get("path"))?, truthy_str(el.get("worktreePath"))?) {
            (Some(p), _) | (None, Some(p)) => Some(p),
            _ => None,
        };
        let repo_id = match el.get("repositoryId") {
            Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
            _ => None,
        };
        out.push(Child { path, repo_id });
    }
    Ok(out)
}

/// `fetchNativeChildren(ctx)` folded into the store rows: every child the app lists must already be a store row (it then adds
/// nothing). Anything else is a row of its own, which Node builds.
fn check_native_children(e: &Eng, known: &HashSet<String>) -> R<()> {
    let list_args: Vec<&str> = defaults::list("mesh_write.roster_children_args");
    let raw = match hivecontrol::gate(&e.inv.env, &e.inv.home) {
        hivecontrol::Gate::Probe => return defer("hivecontrol-probe"),
        hivecontrol::Gate::Refused => return Ok(()),
        hivecontrol::Gate::Spawn => match hivecontrol::run(&list_args, &e.inv.env) {
            Some(r) => r,
            None => return Ok(()),
        },
    };
    let children = parse_children(&raw)?;
    for c in &children {
        let Some(p) = &c.path else { return defer("native-row") };
        if !known.contains(&ident::primary_workspace_id(p)?) {
            return defer("native-row");
        }
    }
    if children.iter().any(|c| c.repo_id.is_some()) {
        let mut env = e.inv.env.clone();
        env.remove(key("devswarm_cli.rr_env_repo_id"));
        let trusted_args: Vec<&str> = defaults::list("devswarm_cli.rr_trusted_args");
        if let Some(trusted_raw) = hivecontrol::run(&trusted_args, &env)
            && let Some(trusted) = parse_children(&trusted_raw)?.into_iter().find_map(|c| c.repo_id)
            && children.iter().any(|c| c.repo_id.as_ref().is_some_and(|r| *r != trusted))
        {
            return defer("native-repository-mismatch");
        }
    }
    Ok(())
}

/// `String(v)` of a descriptor `id` the way the archive scan compares it.
fn js_text(v: Option<&OVal>) -> R<String> {
    Ok(match v {
        None => key("mesh_write.js_undefined").to_string(),
        Some(OVal::Null) => key("mesh_write.js_null").to_string(),
        Some(OVal::Str(t)) => t.clone(),
        Some(OVal::Num(x)) => to_js_string(*x),
        Some(OVal::Bool(b)) => b.to_string(),
        Some(_) => return defer("descriptor-id-type"),
    })
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
        let mut o = Obj::default();
        o.put("id", s(id))
            .put("working_on", OVal::Null)
            .put("directUnread", OVal::Null)
            .put("broadcastUnread", OVal::Null)
            .put("urgencyMax", OVal::Null)
            .put("worktreePath", OVal::Null)
            .put("source", s(key("devswarm_cli.rr_source_archived")))
            .put("meshId", OVal::Null)
            .put("hints", strings(&[key("devswarm_cli.rr_hint_archived").to_string()]));
        out.push(o);
    }
    Ok(out)
}

/// `localArchivedAppLive(home, { repoKey })`: workspaces anti-hall archived that the app still shows.
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
            Some(_) => return defer("retired-type"),
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

// ---------------------------------------------------------------------------------------------------------------------
// the roster
// ---------------------------------------------------------------------------------------------------------------------

/// `cmdRoster`'s rows for a project whose store holds `sum`.
pub fn build(inv: &Inv, repo_key: &str, st: &MeshStore, sum: &OVal, main_worktree: Option<&str>) -> R<Built> {
    let e = Eng { inv, now: inv.now as f64, repo_key, dormant: std::cell::OnceCell::new() };
    let Some(OVal::Obj(ws)) = sum.get("workspaces") else { return defer("summary-shape") };
    if ws.iter().any(|(k, _)| is_array_index_key(k)) {
        return defer("index-like-id");
    }
    let counts = instance_counts(st, e.now)?;
    let mut rows: Vec<Obj> = Vec::new();
    for (_, w) in ws {
        let Some(OVal::Str(id)) = w.get("id") else { return defer("row-id") };
        let wt = truthy_str(w.get("worktreePath"))?;
        let session = truthy_str(w.get("sessionId"))?;
        let only_archived = archive_complete(&e, id);
        let mut h = hints(&e, id, wt.as_deref(), session.as_deref())?;
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
    check_native_children(&e, &known)?;
    // the split-brain fallback: the Primary's own summary under a different hash would add its workspace
    if let Some(main) = main_worktree {
        let primary = ident::primary_workspace_id(main)?;
        let fallback = crate::meshw::send::hash_from_workspace_id(&primary);
        let already = known.contains(&primary) || rows.iter().any(|r| str_field(r, "id") == Some(primary.as_str()));
        let file = devswarm_root(&inv.home).join(key("mesh_write.dir_summaries")).join(format!("{fallback}{}", key("mesh_write.json_suffix")));
        if !fallback.is_empty() && fallback != repo_key && !already && file.exists() {
            return defer("fallback-summary");
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
    // a step plan adds the plan fields (label, tokens, straying signals): Node's
    for r in &rows {
        if str_field(r, "source") == Some(key("devswarm_cli.rr_source_archived")) {
            continue;
        }
        if let Some(id) = str_field(r, "id")
            && plan::find_for(inv, id, str_field(r, "worktreePath"))?.is_some()
        {
            return defer("plan-row");
        }
    }
    Ok(Built { rows, app_still_live: live_report })
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
    let e = Eng { inv, now, repo_key: "", dormant: std::cell::OnceCell::new() };
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
                    let width = defaults::num("devswarm_cli.app_short_id") as usize;
                    let short = if i.encode_utf16().count() > width { slice_utf16(i, width) } else { Some(i.to_string()) };
                    let Some(short) = short else { return defer("surrogate-cut") };
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
