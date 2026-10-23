//! Host primitives of the `devswarm-parent-inbox` check for a Primary that runs inside a git checkout (roadmap #68 part 2B).
//! The script (`engine/logic/devswarm-parent-inbox.js`) holds every decision and text; these functions hold no rule, threshold or
//! message, they only extract what it asks for. They write nothing. A shape the engine cannot read exactly as JavaScript does is
//! `{"unsure": true}`, which the script turns into a deferral to the Node hook before anything is written.
//!
//! | raw function | what it does |
//! |---|---|
//! | `piAppDb()` | whether the DevSwarm app's database file exists at the path the app uses (`appDbPath`) |
//! | `piSnap(windowMs, now)` | reads the app database snapshot once for this call: `{file, readable, focused}` (the file exists, a snapshot was read, the id of the workspace selected within `windowMs`) |
//! | `piWs(id, worktree, now)` | `workspaceFor(snap, { id, worktreePath })` with the fields the table reads: `{id, label, rank, isPinned, builderType, active, archived, finish, brief}`, or `null` |
//! | `piRow(id, worktree, session, repoKey, now)` | the row's archive state: `{marker, app, superseded, ignored}` (`rowEligibility` without a session id, then `resolveArchiveGate` with the row's) |
//! | `piActivity(id, worktree, session, lastOutbound, now)` | `{ts, dormant, idleAlive, idleMs}`: the widest activity signal and the liveness state of `rowLivenessState` |
//! | `piMarker(id, worktree, session)` | `isArchivedWorkspace(home, id, worktree, { sessionId })`: anti-hall's own archive marker names the row archived |
//! | `piApp(id, worktree, repoKey, now)` | the app side of "archived" for a row (`appArchivedVerdict`, then the supervisor's active-list cache) |
//! | `piIgnored(id)` | whether the row has an archive-ignore mark |
//! | `piPid(pid)` | `pidIsAlive(pid)`: `true`, `false` or `null` (no opinion) |
//! | `piAppChildren(worktree)` | the workspaces the app database lists as open children of the project around `worktree`: `{repo, children: [{id, worktreePath, sessionId}]}` (`appHasLiveChild` before the per-row eligibility) |
//! | `piFinish(id, worktree, now)` | `{label, key, extras}`: the step-plan label of a working row (`planLib.findPlan` then `finishLabel`), `label` null when the workspace has no plan |
//! | `piMeshId(worktree)` | `{id}`: `resolveContext(worktree, { missingPath: 'ancestor' }).meshId`, `null` outside a checkout |
//! | `piSessionPid(session)` | `sessionPidAlive(session)`: `true`, `false` (a record names it and every pid is dead) or `null` (no record) |
//! | `piJev()` | whether the Jev triage of arrivals may be switched on (then a broadcast feed is labelled by Jev, which the engine does not do)
//! | `piDerive(repoKey, now)` | `{text}`: the project's summary projection as the hook's refresh would write it when the ingest daemon is not healthy (`null` when the project has no store rows to derive from); nothing is written |
//! | `piDrift(worktree, anchor, current, transcriptPath)` | `anchorSessionDrift(...)`: `{newest, anchor}` when a newer session of the worktree is active than the Primary's anchor, else `null` |
//! | `piFold(id, presentJson, appBuilder)` | `{to}`: the canonical row a `primary-<hash>` label folds into (`rosterFoldTarget`) |
use super::host::with_settings;
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dssup::appsync::snap::{self, Snap};
use crate::dssup::liveness;
use crate::meshw::common::Inv;
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::rosterrows::Windows;
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::HashSet;
use std::path::Path;

thread_local! {
    /// The app database snapshot of this call: not read yet (`None`), read (`Some`) and the snapshot or none.
    static SNAP: RefCell<Option<Option<Snap>>> = const { RefCell::new(None) };
}

/// A new script call starts: no snapshot is held.
pub(super) fn reset_call() {
    SNAP.with(|s| *s.borrow_mut() = None);
}

fn unsure() -> String {
    json!({"unsure": true}).to_string()
}

fn answer(r: R<Value>) -> String {
    r.map_or_else(|_| unsure(), |v| v.to_string())
}

fn inv_of(st: &crate::checks::git::util::Settings, now: f64) -> Inv {
    let home = std::path::PathBuf::from(&st.home);
    Inv { home: home.clone(), env: st.env.clone(), cwd: String::new(), now: now as i64, stdin: None, write_home: home, store_override: None }
}

fn json_suffix() -> &'static str {
    defaults::text("mesh_write.json_suffix")
}

fn app_db_present(home: &str, env: &ident::Env) -> bool {
    ident::app_db_path(Path::new(home), env).is_some_and(|p| std::fs::symlink_metadata(p).is_ok())
}

// ---------------------------------------------------------------------------------------------------------------------
// the app database
// ---------------------------------------------------------------------------------------------------------------------

/// `{file, readable, focused}`; the snapshot stays for the rest of the call.
fn load_snap(home: &str, env: &ident::Env, window_ms: f64, now: f64) -> R<Value> {
    let file = ident::app_db_path(Path::new(home), env);
    let exists = file.as_deref().is_some_and(|f| std::fs::metadata(f).is_ok_and(|m| m.is_file()));
    let snap = match (&file, exists) {
        (Some(f), true) => snap::read(f)?,
        _ => None,
    };
    let focused = snap.as_ref().and_then(|s| {
        let mut best: Option<(&str, f64)> = None;
        for w in &s.workspaces {
            if let Some(at) = w.last_selected_at
                && best.is_none_or(|(_, b)| at > b)
            {
                best = Some((&w.id, at));
            }
        }
        let (id, at) = best?;
        (now - at >= 0.0 && now - at <= window_ms).then(|| id.to_string())
    });
    let out = json!({"file": exists, "readable": snap.is_some(), "focused": focused});
    SNAP.with(|s| *s.borrow_mut() = Some(snap));
    Ok(out)
}

/// The snapshot of this call, read now when no `piSnap` has read it yet.
fn ensure_snap(home: &str, env: &ident::Env, now: f64) -> R<()> {
    if SNAP.with(|s| s.borrow().is_none()) {
        load_snap(home, env, 0.0, now)?;
    }
    Ok(())
}

fn ws_of(id: Option<&str>, wt: Option<&str>, now: f64) -> R<Value> {
    SNAP.with(|s| {
        let held = s.borrow();
        let Some(Some(snap)) = held.as_ref() else { return Ok(Value::Null) };
        let Some(ws) = snap.workspace_for(id, wt)? else { return Ok(Value::Null) };
        Ok(json!({
            "id": ws.id,
            "label": ws.label,
            "rank": ws.rank.filter(|r| r.is_finite()),
            "isPinned": ws.is_pinned,
            "builderType": ws.builder_type,
            "active": ws.active,
            "archived": ws.archived,
            "finish": snap::finish_signal(ws),
            "brief": snap.brief_status(ws, now),
        }))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// the archive state of a row
// ---------------------------------------------------------------------------------------------------------------------

fn real_sid(v: Option<&OVal>) -> R<Option<String>> {
    Ok(match v {
        None | Some(OVal::Null) => None,
        Some(OVal::Str(t)) => (!t.is_empty()).then(|| t.clone()),
        Some(OVal::Num(x)) => Some(crate::checks::jsport::num::to_js_string(*x)),
        Some(OVal::Bool(b)) => Some(b.to_string()),
        Some(_) => return defer("session-type"),
    })
}

fn same_path(a: &str, b: &str) -> bool {
    ident::realpath(a).unwrap_or_else(|| a.to_string()) == ident::realpath(b).unwrap_or_else(|| b.to_string())
}

fn read_val(p: &Path) -> Option<OVal> {
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))
}

fn obj_like(v: &OVal) -> bool {
    matches!(v, OVal::Obj(_) | OVal::Arr(_))
}

/// `isArchivedWorkspace(home, id, worktreePath, { sessionId })` (no log function: a superseded marker is simply not archived).
fn marker_archived(home: &Path, id: &str, wt: Option<&str>, sid: Option<&str>) -> R<bool> {
    if !is_safe_id(id) {
        return Ok(false);
    }
    let root = devswarm_root(home);
    let Some(desc) = read_val(&root.join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{}", json_suffix()))) else { return Ok(false) };
    if !obj_like(&desc) {
        return Ok(false);
    }
    if let Some(wt) = wt {
        let archived_wt = match desc.get(defaults::text("mesh_write.field_worktree_path")) {
            Some(OVal::Str(t)) if !t.is_empty() => Some(t.as_str()),
            _ => None,
        };
        if archived_wt.is_some_and(|a| !same_path(a, wt)) {
            return Ok(false);
        }
    }
    let Some(marker_sid) = real_sid(desc.get(defaults::text("mesh_write.field_session_id")))? else { return Ok(true) };
    let live_sid = match sid.filter(|s| !s.is_empty()) {
        Some(s) => Some(s.to_string()),
        None => match read_val(&root.join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", json_suffix()))) {
            Some(d) if obj_like(&d) => real_sid(d.get(defaults::text("mesh_write.field_session_id")))?,
            _ => None,
        },
    };
    Ok(!live_sid.is_some_and(|l| l != marker_sid))
}

/// `resolveArchiveGate(...)` for a row whose own marker did not archive it: `archived && !migrateAsLive`.
fn gate_superseded(w: &Windows, home: &Path, id: &str, desc_wt: Option<&str>, desc_sid: Option<&str>, now: f64) -> R<bool> {
    if !is_safe_id(id) {
        return Ok(false);
    }
    let root = devswarm_root(home);
    let archived_dir = root.join(defaults::text("mesh_write.dir_archived"));
    let marker_path = archived_dir.join(format!("{id}{}", json_suffix()));
    let own = std::fs::read(&marker_path).ok();
    let mut marker: Option<OVal> = None;
    if let Some(bytes) = &own {
        match OVal::parse(&String::from_utf8_lossy(bytes)) {
            Some(v) if obj_like(&v) => marker = Some(v),
            _ => return Ok(true), // archived-marker-unreadable
        }
    }
    let wt_field = defaults::text("mesh_write.field_worktree_path");
    let marker_wt = |m: &OVal| match m.get(wt_field) {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
        _ => None,
    };
    if let (Some(m), Some(dwt)) = (&marker, desc_wt)
        && let Some(mwt) = marker_wt(m)
        && ident::realpath(&mwt).unwrap_or(mwt) != ident::realpath(dwt).unwrap_or_else(|| dwt.to_string())
    {
        marker = None;
    }
    let mut group = false;
    if marker.is_none()
        && let Some(dwt) = desc_wt
    {
        let real = ident::realpath(dwt).unwrap_or_else(|| dwt.to_string());
        let mut names: Vec<String> = match std::fs::read_dir(&archived_dir) {
            Ok(rd) => rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect(),
            Err(_) => Vec::new(),
        };
        names.sort();
        let mut hits: Vec<(String, OVal)> = Vec::new();
        for n in names {
            let Some(cand) = n.strip_suffix(json_suffix()) else { continue };
            if !is_safe_id(cand) {
                continue;
            }
            let Some(m) = read_val(&archived_dir.join(&n)) else { continue };
            let Some(mwt) = marker_wt(&m) else { continue };
            if ident::realpath(&mwt).unwrap_or(mwt) == real {
                hits.push((cand.to_string(), m));
            }
        }
        if !hits.is_empty() {
            let hit = hits.iter().position(|(h, _)| h != id).unwrap_or(0);
            marker = Some(hits.swap_remove(hit).1);
            group = true;
        }
    }
    let Some(marker) = marker else { return Ok(false) };
    let marker_sid = real_sid(marker.get(defaults::text("mesh_write.field_session_id")))?;
    let desc_sid = desc_sid.filter(|s| !s.is_empty()).map(str::to_string);
    if marker_sid.is_none() || desc_sid.is_none() || marker_sid == desc_sid {
        return Ok(true);
    }
    // isSiblingPartitionLive({ id, sessionId, worktreePath }, home, { now })
    let live = {
        let fresh = liveness::is_fresh(
            is_safe_id(id).then(|| liveness::heartbeat_ts(home, id)).flatten(),
            now,
            defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64,
        );
        if fresh {
            true
        } else {
            let sid = desc_sid.as_deref().unwrap_or("");
            if sid.is_empty() || sid.starts_with(defaults::text("mesh_write.synthetic_session_prefix")) {
                false
            } else {
                !(w.dormant_by_activity(id, desc_wt, Some(sid), None)? && !w.session_alive(Some(sid))?)
            }
        }
    };
    if group {
        return Ok(!live);
    }
    let mtime = |p: &Path| std::fs::metadata(p).ok().map(|m| liveness::mtime_ms(&m)).filter(|t| t.is_finite());
    let marker_mtime = mtime(&marker_path);
    let desc_mtime = mtime(&root.join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", json_suffix())));
    let newer = matches!((marker_mtime, desc_mtime), (Some(m), Some(d)) if d > m);
    Ok(!(newer && live))
}

fn archive_ignored(home: &Path, id: &str) -> bool {
    std::fs::metadata(devswarm_root(home).join(defaults::text("devswarm_parent.archive_ignore_dir")).join(format!("{id}{}", json_suffix()))).is_ok()
}

fn row_state(inv: &Inv, id: &str, wt: Option<&str>, sid: Option<&str>, repo_key: &str) -> R<Value> {
    let w = Windows::new(inv, repo_key);
    let wt = wt.filter(|s| !s.is_empty());
    // `elig.of({ id, worktreePath, repoKey })` carries no session id: the live descriptor names the occupant
    let marker = marker_archived(&inv.home, id, wt, None)?;
    let app = w.app_archived(id, wt)?;
    let superseded = if marker { false } else { gate_superseded(&w, &inv.home, id, wt, sid, inv.now as f64)? };
    let ignored = is_safe_id(id) && archive_ignored(&inv.home, id);
    Ok(json!({"marker": marker, "app": app, "superseded": superseded, "ignored": ignored}))
}

/// `appHasLiveChild` up to the per-row eligibility: the open, unarchived, non-primary workspaces of the project the working directory
/// belongs to, other than the workspace on that directory.
fn app_children(wt: &str) -> R<Value> {
    SNAP.with(|s| {
        let held = s.borrow();
        let Some(Some(snap)) = held.as_ref() else { return Ok(json!({"repo": false, "children": []})) };
        let Some(norm) = crate::meshw::appdb::norm_path(wt)? else { return Ok(json!({"repo": false, "children": []})) };
        let repo_id: Option<Option<String>> = match snap.repositories.iter().find(|r| r.path.as_deref() == Some(norm.as_str())) {
            Some(r) => Some(Some(r.id.clone())),
            None => {
                snap.workspaces.iter().find(|w| w.worktree_path.as_deref() == Some(norm.as_str()) && w.repository_id.is_some()).map(|w| w.repository_id.clone())
            }
        };
        let Some(Some(repo_id)) = repo_id else { return Ok(json!({"repo": false, "children": []})) };
        let self_id = snap.workspace_for(None, Some(wt))?.map(|w| w.id.clone());
        let children: Vec<Value> = snap
            .workspaces
            .iter()
            .filter(|w| w.active && !w.archived && w.builder_type.as_deref() != Some(defaults::text("devswarm_sup.as_primary_type")))
            .filter(|w| w.repository_id.as_deref() == Some(repo_id.as_str()))
            .filter(|w| self_id.as_deref() != Some(w.id.as_str()))
            .map(|w| json!({"id": w.id, "worktreePath": w.worktree_path, "sessionId": w.session_id}))
            .collect();
        Ok(json!({"repo": true, "children": children}))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// activity
// ---------------------------------------------------------------------------------------------------------------------

fn activity_of(inv: &Inv, id: &str, wt: Option<&str>, sid: Option<&str>, last_out: Option<f64>, repo_key: &str) -> R<Value> {
    let w = Windows::new(inv, repo_key);
    let wt = wt.filter(|s| !s.is_empty());
    let sid = sid.filter(|s| !s.is_empty());
    let (best, saw) = w.activity(id, wt, sid, last_out)?;
    let ts = (best > 0.0).then_some(best);
    let now = inv.now as f64;
    let mut dormant_act = false;
    if let Some(t) = ts
        && now.is_finite()
        && now - t >= 0.0
    {
        let threshold = if saw { w.dormant_ms()? } else { w.idle_ms() };
        dormant_act = now - t >= threshold;
    }
    let alive = if dormant_act { w.session_alive(sid)? } else { false };
    Ok(json!({"ts": ts, "dormant": dormant_act && !alive, "idleAlive": dormant_act && alive, "idleMs": w.idle_ms()}))
}

fn mesh_id_of(wt: &str) -> R<Value> {
    let c = ident::resolve_context(wt, true)?;
    Ok(json!({"id": c.worktree_root.as_deref().map(ident::mesh_id_for_real_path)}))
}

// ---------------------------------------------------------------------------------------------------------------------
// the step plan of a row
// ---------------------------------------------------------------------------------------------------------------------

fn finish_of(inv: &Inv, id: &str, wt: Option<&str>) -> R<Value> {
    let Some(found) = crate::meshw::plan::find_for(inv, id, wt.filter(|s| !s.is_empty()))? else { return Ok(json!({"label": Value::Null})) };
    let label = crate::meshw::plan::finish_label(&found.plan, inv.now as f64)?;
    let OVal::Str(label) = label else { return Ok(json!({"label": Value::Null})) };
    let extras = match found.plan.get("extras") {
        Some(OVal::Arr(a)) => a.len(),
        _ => 0,
    };
    Ok(json!({"label": label, "key": found.key, "extras": extras}))
}

// ---------------------------------------------------------------------------------------------------------------------
// the summary refresh
// ---------------------------------------------------------------------------------------------------------------------

/// The refresh the hook makes when the ingest daemon is not healthy: `deriveSummary` over a store that holds something. The text is
/// what Node writes; the script writes it once nothing else can defer the turn.
fn derive_text(inv: &Inv, key: &str) -> R<Value> {
    let dir = crate::meshw::union::store_dir(&inv.home, key);
    let db = dir.join(defaults::text("mesh_write.store_file"));
    if !db.exists() {
        // no store at all is Node's null; a journal store or a marker with no database is Node's to read
        if dir.join(defaults::text("mesh.backend_marker")).exists()
            || std::fs::read_dir(dir.join(defaults::text("devswarm_role.pg_journal_dir"))).is_ok_and(|mut d| d.next().is_some())
        {
            return defer("store-backend");
        }
        return Ok(json!({"text": Value::Null}));
    }
    let store = crate::meshw::common::open_store(inv, key)?;
    let reader = store.reader();
    let has_rows = !reader.roster().map_err(|e| ident::Defer(format!("registry:{e}")))?.is_empty() || !reader.workspace_ids().is_empty();
    if !has_rows {
        return Ok(json!({"text": Value::Null}));
    }
    let sum = crate::meshw::summary::compute(&store, inv, None)?;
    Ok(json!({"text": sum.stringify()}))
}

// ---------------------------------------------------------------------------------------------------------------------
// session drift
// ---------------------------------------------------------------------------------------------------------------------

/// A session of the worktree: its id and the last time its transcript was written.
pub(super) struct Session {
    pub(super) id: String,
    pub(super) last_ms: f64,
}

/// `projectDirFor(worktree, home)`.
pub(super) fn project_dir(home: &Path, worktree: &str) -> std::path::PathBuf {
    let from = defaults::text("devswarm_sup.lv_encode_chars");
    let enc: String =
        worktree.chars().map(|c| if from.contains(c) { defaults::text("devswarm_sup.lv_encode_to").to_string() } else { c.to_string() }).collect();
    home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("devswarm_sup.lv_projects_dir")).join(enc)
}

/// The `cwd` a transcript starts with: the first `"cwd"` of its head, read as a JSON string (`transcriptInfo`).
fn head_cwd(file: &Path) -> R<Option<String>> {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(file) else { return Ok(None) };
    let mut buf = vec![0u8; defaults::num("devswarm_parent.drift_head_bytes") as usize];
    let mut n = 0;
    loop {
        match f.read(&mut buf[n..]) {
            Ok(0) | Err(_) => break,
            Ok(k) => {
                n += k;
                if n == buf.len() {
                    break;
                }
            }
        }
    }
    let head = String::from_utf8_lossy(&buf[..n]).into_owned();
    let re = regex::Regex::new(defaults::text("devswarm_parent.drift_cwd_re")).map_err(|_| ident::Defer("regex".into()))?;
    let Some(m) = re.captures(&head) else { return Ok(None) };
    match serde_json::from_str::<String>(&format!("\"{}\"", &m[1])) {
        Ok(c) => Ok(Some(c)),
        // JSON.parse reads a lone-surrogate escape that serde rejects
        Err(_) if m[1].contains("\\u") => defer("drift-cwd-escape"),
        Err(_) => Ok(None),
    }
}

/// `sessionsForWorktree(worktree, { home })`, newest activity first.
pub(super) fn sessions_for(home: &Path, worktree: &str) -> R<Vec<Session>> {
    let dir = project_dir(home, worktree);
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };
    let mut names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).collect();
    names.sort();
    let ext = defaults::text("devswarm_sup.lv_transcript_ext");
    let sid_re = regex::Regex::new(defaults::text("devswarm_parent.drift_sid_re")).map_err(|_| ident::Defer("regex".into()))?;
    let mut files: Vec<Session> = Vec::new();
    for n in names {
        let Some(id) = n.strip_suffix(ext) else { continue };
        if !sid_re.is_match(id) {
            continue;
        }
        let Ok(md) = std::fs::metadata(dir.join(&n)) else { continue };
        files.push(Session { id: id.to_string(), last_ms: liveness::mtime_ms(&md) });
    }
    files.sort_by(|a, b| b.last_ms.partial_cmp(&a.last_ms).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<Session> = Vec::new();
    for s in files.into_iter().take(defaults::num("devswarm_parent.drift_max_scan") as usize) {
        let Some(cwd) = head_cwd(&dir.join(format!("{}{ext}", s.id)))? else { continue };
        let sep_prefix = format!("{worktree}{}", std::path::MAIN_SEPARATOR);
        if !(cwd == worktree || cwd.starts_with(&sep_prefix)) {
            continue;
        }
        out.push(s);
    }
    out.sort_by(|a, b| b.last_ms.partial_cmp(&a.last_ms).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

/// `anchorSessionDrift({ anchorSessionId, worktree, home, currentSessionId, currentTranscriptPath })`.
fn drift_of(home: &Path, worktree: &str, anchor: &str, current: &str, transcript: Option<&str>) -> R<Value> {
    if anchor.is_empty() || anchor.starts_with(defaults::text("mesh_write.synthetic_session_prefix")) {
        return Ok(Value::Null);
    }
    let list = sessions_for(home, worktree)?;
    let Some(first) = list.first() else { return Ok(Value::Null) };
    if first.id == anchor {
        return Ok(Value::Null);
    }
    if !current.is_empty() {
        // currentActivityMs(cur, list, o)
        let cur_ms = if let Some(hit) = list.iter().find(|s| s.id == current) {
            Some(hit.last_ms)
        } else {
            let mut cands: Vec<std::path::PathBuf> = Vec::new();
            if let Some(t) = transcript.filter(|t| !t.is_empty()) {
                cands.push(std::path::PathBuf::from(t));
            }
            if regex::Regex::new(defaults::text("devswarm_parent.drift_sid_re")).map_err(|_| ident::Defer("regex".into()))?.is_match(current) {
                cands.push(project_dir(home, worktree).join(format!("{current}{}", defaults::text("devswarm_sup.lv_transcript_ext"))));
            }
            cands.iter().find_map(|p| std::fs::metadata(p).ok().map(|m| liveness::mtime_ms(&m)).filter(|m| m.is_finite()))
        };
        match cur_ms {
            None => return Ok(Value::Null),
            Some(c) if first.last_ms <= c => return Ok(Value::Null),
            Some(_) => {}
        }
    }
    Ok(json!({"newest": first.id, "anchor": anchor}))
}

// ---------------------------------------------------------------------------------------------------------------------

fn fold_of(inv: &Inv, id: &str, present: &[String], app_builder: Option<&str>, repo_key: &str) -> R<Value> {
    let w = Windows::new(inv, repo_key);
    let set: HashSet<String> = present.iter().cloned().collect();
    let aliases = crate::meshw::common::read_aliases(&inv.home);
    Ok(json!({"to": w.fold_target(id, &set, &aliases, app_builder)?}))
}

pub(super) fn install<'js>(c: &Ctx<'js>, h: &Object<'js>) -> rquickjs::Result<()> {
    h.set("piAppDb", Function::new(c.clone(), || -> rquickjs::Result<bool> { with_settings(|st| app_db_present(&st.home, &st.env)) })?)?;
    h.set(
        "piSnap",
        Function::new(c.clone(), |window_ms: f64, now: f64| -> rquickjs::Result<String> {
            with_settings(|st| answer(load_snap(&st.home, &st.env, window_ms, now)))
        })?,
    )?;
    h.set(
        "piWs",
        Function::new(c.clone(), |id: Option<String>, wt: Option<String>, now: f64| -> rquickjs::Result<String> {
            with_settings(|_| answer(ws_of(id.as_deref(), wt.as_deref(), now)))
        })?,
    )?;
    h.set(
        "piRow",
        Function::new(c.clone(), |id: String, wt: Option<String>, sid: Option<String>, key: String, now: f64| -> rquickjs::Result<String> {
            with_settings(|st| answer(row_state(&inv_of(st, now), &id, wt.as_deref(), sid.as_deref(), &key)))
        })?,
    )?;
    h.set(
        "piActivity",
        Function::new(
            c.clone(),
            |id: String, wt: Option<String>, sid: Option<String>, last_out: Option<f64>, key: String, now: f64| -> rquickjs::Result<String> {
                with_settings(|st| answer(activity_of(&inv_of(st, now), &id, wt.as_deref(), sid.as_deref(), last_out.filter(|x| x.is_finite()), &key)))
            },
        )?,
    )?;
    h.set(
        "piMarker",
        Function::new(c.clone(), |id: String, wt: Option<String>, sid: Option<String>| -> rquickjs::Result<String> {
            with_settings(|st| {
                answer(marker_archived(Path::new(&st.home), &id, wt.as_deref().filter(|s| !s.is_empty()), sid.as_deref()).map(|b| json!({"archived": b})))
            })
        })?,
    )?;
    h.set(
        "piApp",
        Function::new(c.clone(), |id: String, wt: Option<String>, key: String, now: f64| -> rquickjs::Result<String> {
            with_settings(|st| {
                let inv = inv_of(st, now);
                answer(Windows::new(&inv, &key).app_archived(&id, wt.as_deref().filter(|s| !s.is_empty())).map(|b| json!({"archived": b})))
            })
        })?,
    )?;
    h.set(
        "piIgnored",
        Function::new(c.clone(), |id: String| -> rquickjs::Result<bool> { with_settings(|st| is_safe_id(&id) && archive_ignored(Path::new(&st.home), &id)) })?,
    )?;
    h.set("piPid", Function::new(c.clone(), |pid: f64| -> rquickjs::Result<Option<bool>> { Ok(liveness::pid_is_alive(pid, None)) })?)?;
    h.set(
        "piAppChildren",
        Function::new(c.clone(), |wt: String, now: f64| -> rquickjs::Result<String> {
            with_settings(|st| answer(ensure_snap(&st.home, &st.env, now).and_then(|()| app_children(&wt))))
        })?,
    )?;
    h.set(
        "piFinish",
        Function::new(c.clone(), |id: String, wt: Option<String>, now: f64| -> rquickjs::Result<String> {
            with_settings(|st| answer(finish_of(&inv_of(st, now), &id, wt.as_deref())))
        })?,
    )?;
    h.set("piMeshId", Function::new(c.clone(), |wt: String| -> rquickjs::Result<String> { with_settings(|_| answer(mesh_id_of(&wt))) })?)?;
    h.set(
        "piSessionPid",
        Function::new(c.clone(), |sid: String| -> rquickjs::Result<String> {
            with_settings(|st| answer(liveness::session_state(Path::new(&st.home), &sid).map(|v| json!({"alive": v}))))
        })?,
    )?;
    h.set("piJev", Function::new(c.clone(), || -> rquickjs::Result<bool> { with_settings(|st| crate::meshw::common::jev_maybe_enabled(&inv_of(st, 0.0))) })?)?;
    h.set(
        "piDerive",
        Function::new(c.clone(), |key: String, now: f64| -> rquickjs::Result<String> { with_settings(|st| answer(derive_text(&inv_of(st, now), &key))) })?,
    )?;
    h.set(
        "piDrift",
        Function::new(c.clone(), |wt: String, anchor: String, current: String, tp: Option<String>| -> rquickjs::Result<String> {
            with_settings(|st| answer(drift_of(Path::new(&st.home), &wt, &anchor, &current, tp.as_deref())))
        })?,
    )?;
    h.set(
        "piFold",
        Function::new(c.clone(), |id: String, present: String, app_builder: Option<String>, key: String, now: f64| -> rquickjs::Result<String> {
            with_settings(|st| {
                let present: Vec<String> = serde_json::from_str(&present).unwrap_or_default();
                answer(fold_of(&inv_of(st, now), &id, &present, app_builder.as_deref(), &key))
            })
        })?,
    )?;
    Ok(())
}
