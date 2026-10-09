//! `devswarm.js heartbeat <id> --session S [--progress N --phase T --wip T... --blockers T...]`, ported from
//! `scripts/devswarm-lib/heartbeat-plan.js` `cmdHeartbeat`.
//!
//! A heartbeat is proof of life: it writes the workspace's heartbeat record (`heartbeats/<id>.json`) and refreshes its
//! persisted liveness verdict (`liveness/<id>.json`) to `alive`, with the mailbox's `pending` / `notDraining` /
//! `oldestUnreadAgeMs` taken from the NDJSON + store unread union ([`crate::meshw::union`]).
//!
//! The engine answers the plain form only. A call goes to Node, before anything is written, when it
//! * carries `--summary` (a mesh broadcast row and the identity families), or `--step` for a workspace that has a plan file
//!   (Node updates the plan under its lock and records supervision metrics); `--step` for a workspace WITHOUT a plan is
//!   answered here: Node reports `no-plan` and writes nothing beyond the heartbeat;
//! * carries no `--session` (Node then appends the caller's process line to `heartbeat-callers.log`, which names the Node
//!   process and cannot be reproduced);
//! * could make Node act in a way the engine does not: a child workspace addressing another id (a stderr warning), a
//!   Primary checkout whose anchor session would be refreshed, a `primary-<hash>` label id, a partition whose `reader_cursors` floor rows are
//!   missing (Node imports the legacy cursors first), a store the engine will not read exactly like Node.
//!
//! Every read happens before the first write; after the heartbeat record is written, the verdict write is best effort,
//! exactly as in Node (`try { writeVerdict } catch (_) {}`).
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_number_of_str, js_trim};
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::appdb;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::plan;
use crate::meshw::send::{Answer, Effect};
use crate::meshw::store::{self, MeshStore};
use crate::meshw::union;
use std::path::{Path, PathBuf};

/// The mailbox signal of the verdict.
struct Pending {
    pending: bool,
    not_draining: bool,
    oldest: Option<f64>,
}

/// `/^primary-[0-9a-f]{8}$/`: a Primary label id, which Node's `childLabelRefusal` examines.
fn is_primary_label(id: &str) -> bool {
    let hex = defaults::num("mesh_write.mesh_id_hex") as usize;
    id.strip_prefix(defaults::text("mesh_write.primary_prefix"))
        .is_some_and(|rest| rest.len() == hex && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// `warnIdMismatch` can only speak for a child workspace whose builder id differs from the heartbeat's id: defer that.
pub(crate) fn id_mismatch_possible(inv: &Inv, id: &str) -> bool {
    let child = inv.env.get(defaults::text("mesh_write.env_source_branch")).is_some_and(|v| !crate::checks::guardkit::text::js_trim(v).is_empty());
    let Some(env_id) = inv.env.get(defaults::text("mesh_write.env_builder_id")).filter(|b| is_safe_id(b)) else { return false };
    child && env_id != id
}

/// `refreshAnchorSession(ctx)` is a no-op unless the caller is a Primary checkout whose anchor descriptor records another
/// session; that case (the one that writes) defers.
pub(crate) fn anchor_refresh_possible(inv: &Inv) -> R<bool> {
    let Some(sid) = inv.env.get(defaults::text("mesh_write.env_session_id")).filter(|v| !v.is_empty()) else { return Ok(false) };
    let c = ident::resolve_context(&inv.cwd, true)?;
    let Some(wt) = c.worktree_root.clone() else { return Ok(false) };
    if !ident::is_primary_checkout(&wt, c.main_worktree.as_deref(), &inv.home, &inv.env)? {
        return Ok(false);
    }
    let anchor = ident::mesh_id_for_real_path(&wt);
    let Some(pre) = ident::read_descriptor(&inv.home, &anchor) else { return Ok(false) };
    match pre.get(defaults::text("mesh_write.field_session_id")) {
        None | Some(OVal::Null | OVal::Bool(false)) => Ok(false),
        Some(OVal::Str(x)) if x.is_empty() => Ok(false),
        Some(OVal::Str(x)) => Ok(x != sid),
        Some(_) => defer("anchor-session-type"),
    }
}

/// `runningAntiHallVersion()`: the `version` of this plugin's manifest, `null` when unreadable.
pub(crate) fn running_version() -> OVal {
    let Some(root) = defaults::root() else { return OVal::Null };
    let p = root.join(defaults::text("mesh_write.plugin_manifest_dir")).join(defaults::text("mesh_write.plugin_manifest_file"));
    let Ok(bytes) = std::fs::read(p) else { return OVal::Null };
    match OVal::parse(&String::from_utf8_lossy(&bytes)).as_ref().and_then(|j| j.get("version")) {
        Some(OVal::Str(v)) => OVal::Str(v.clone()),
        _ => OVal::Null,
    }
}

/// Open the partition's store the way `openStoreForUnread` does (read only): `Ok(None)` is Node's null handle (no store
/// yet); anything the engine cannot read exactly like Node defers.
pub(crate) fn open_reader(inv: &Inv, desc: &OVal) -> R<Option<MeshReader>> {
    let Some(wt) = union::path_field(desc, defaults::text("mesh_write.field_worktree_path"))? else { return Ok(None) };
    let Some(repo_key) = ident::repo_key_for_worktree(&wt)? else { return Ok(None) };
    let dir = union::store_dir(&inv.home, &repo_key);
    if !dir.exists() {
        return Ok(None);
    }
    let forced = inv.env.get(defaults::text("mesh_write.env_store_backend")).map(|v| v.trim().to_lowercase()).unwrap_or_default();
    if forced != defaults::text("mesh.backend_sqlite") {
        if !forced.is_empty() && forced == defaults::text("mesh_write.backend_journal") {
            return defer("journal-backend");
        }
        let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
        if marker != defaults::text("mesh.backend_sqlite") {
            return defer("store-backend");
        }
    }
    let db = dir.join(defaults::text("mesh_write.store_file"));
    if !db.exists() {
        return Ok(None);
    }
    MeshReader::open(&db).map(Some).map_err(|e| ident::Defer(format!("store-open:{e}")))
}

/// `unionPendingFor(descriptor, home, { now })`.
fn pending_for(inv: &Inv, id: &str, desc: &OVal) -> R<Pending> {
    let inbox = union::path_field(desc, defaults::text("mesh_write.field_inbox_path"))?;
    let cursor_file = union::path_field(desc, defaults::text("mesh_write.field_cursor_path"))?;
    // the partition is the descriptor's own id; the engine reads the cursor fallback from the same file
    if !matches!(desc.get(defaults::text("mesh_write.field_id")), Some(OVal::Str(d)) if d == id) {
        return defer("descriptor-id");
    }
    let Some(reader) = open_reader(inv, desc)? else {
        // no store handle: the NDJSON-only backlog (unreadBacklog), never a reader base
        let lines = known_backlog(inbox.as_deref(), cursor_file.as_deref())?;
        return Ok(Pending { pending: lines > 0, not_draining: false, oldest: None });
    };
    let (store_base, nd_base) = union::floor_bases(&reader, &inv.home, id, cursor_file.as_deref())?;
    let u = union::union_unread(&union::UnionIn {
        inbox: inbox.as_deref(),
        cursor_file: cursor_file.as_deref(),
        id,
        store: Some(&reader),
        store_base,
        nd_base,
        now: inv.now,
    })?;
    let pending = u.unread > 0;
    let not_draining = pending && u.oldest_unread_age_ms.is_some_and(|a| a > defaults::num("mesh_write.not_draining_age_ms") as f64);
    Ok(Pending { pending, not_draining, oldest: u.oldest_unread_age_ms })
}

/// The lines `unreadBacklog(inboxPath, cursorPath)` reports: the inbox's lines past the cursor FILE's position, 0 when the
/// backlog is not known.
pub(crate) fn known_backlog(inbox: Option<&str>, cursor_file: Option<&str>) -> R<usize> {
    let (Some(i), Some(c)) = (inbox, cursor_file) else { return Ok(0) };
    let Some(all) = union::non_empty_lines(i) else { return Ok(0) };
    let Some(pos) = union::cursor_position(c)? else { return Ok(0) };
    Ok(all.len().saturating_sub(if pos > 0.0 { pos.floor() as usize } else { 0 }))
}

/// `Math.max(0, Math.min(100, n))` for a finite `n`.
fn clamp_percent(x: f64) -> f64 {
    let v = x.clamp(0.0, 100.0);
    if v == 0.0 { 0.0 } else { v }
}

/// Stage `text` next to `dst` and rename it into place (the heartbeat and verdict writes).
fn write_atomic(dst: &Path, text: &str, tmp: PathBuf) -> std::io::Result<()> {
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dst).inspect_err(|_| {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: never leak a staged temp (Node unlinks it)
    })
}

/// A `--summary` broadcast the engine can write: the shared store, resolved and checked before anything is written.
struct Broadcast {
    st: MeshStore,
    repo_key: String,
    urgency: String,
}

/// `crossLinkedIdentity(a, b)` on registry rows.
fn cross_linked(a: &ident::Row, b: &ident::Row) -> bool {
    if a.id.is_empty() || b.id.is_empty() || a.id == b.id {
        return false;
    }
    a.session_id.as_deref().is_some_and(|x| !x.is_empty() && x == b.id) || b.session_id.as_deref().is_some_and(|x| !x.is_empty() && x == a.id)
}

/// The ownership check of `cmdHeartbeat`'s broadcast: the caller is the id, or owns it by its registry row, or by the
/// identity family (`broadcastFamilyOwns` legs a1, a2 and a3). Everything else is a refusal Node answers with a dropped
/// summary and an attempt record, or a first claim that needs the app database: both are Node's, so they defer.
#[allow(clippy::too_many_arguments)]
fn owns(inv: &Inv, rows: &[ident::Row], caller: &str, id: &str, cwd: &str, session: &str, had_prior: bool) -> R<()> {
    if caller == id {
        return Ok(());
    }
    let own_entry = crate::meshw::send::resolve_mesh_target(rows, Some(caller))?;
    if own_entry.as_ref().is_some_and(|e| e.id == id) {
        return Ok(());
    }
    let Some(target) = rows.iter().find(|r| r.id == id) else { return defer("summary-first-claim") };
    let Some(twp) = target.worktree_path.as_deref().filter(|p| !p.is_empty()) else { return defer("summary-first-claim") };
    let Some(t_key) = ident::canonical_mesh_id(twp)? else { return defer("summary-ownership-refused") };
    if own_entry.as_ref().is_some_and(|e| cross_linked(e, target)) {
        return Ok(());
    }
    let mut same = ident::resolve_caller_worktree(cwd)?.map(|w| ident::canonical_mesh_id(&w)).transpose()?.flatten().as_deref() == Some(t_key.as_str());
    if !same && let Some(wp) = own_entry.as_ref().and_then(|e| e.worktree_path.as_deref()).filter(|p| !p.is_empty()) {
        same = ident::canonical_mesh_id(wp)?.as_deref() == Some(t_key.as_str());
    }
    if !same {
        return defer("summary-ownership-refused");
    }
    // (a2) the target row's session is the caller's real session (`realSessionIdFrom`)
    let raw =
        if session.is_empty() { inv.env.get(defaults::text("mesh_write.env_session_id")).map(String::as_str).filter(|v| !v.is_empty()) } else { Some(session) };
    let Some(raw) = raw else { return defer("summary-session-derive") };
    let real = js_trim(raw);
    let real = (!real.is_empty() && real != id && !real.starts_with(defaults::text("mesh_write.synthetic_session_prefix"))).then_some(real);
    if let (Some(r), Some(ts)) = (real, target.session_id.as_deref())
        && ts == r
    {
        return Ok(());
    }
    // (a3) a placeholder: no descriptor and no heartbeat of its own before this call
    if ident::read_descriptor(&inv.home, id).is_none() && !had_prior {
        return Ok(());
    }
    defer("summary-ownership-refused")
}

/// Everything the `--summary` broadcast needs, decided before the first write.
fn prepare_broadcast(inv: &Inv, a: &Args, id: &str, session: &str, had_prior: bool) -> R<Broadcast> {
    let cwd = ident::project_cwd_for(&inv.home, &inv.env, &inv.cwd)?;
    let Some(repo_key) = ident::repo_key_for_worktree(&cwd)? else { return defer("summary-no-project") };
    let urgency = a.one(defaults::text("mesh_write.flag_urgency")).unwrap_or(defaults::text("mesh_write.hb_urgency_default")).to_string();
    if !defaults::list("mesh_write.allowed_urgency").contains(&urgency.as_str()) {
        return defer("summary-urgency");
    }
    let st = crate::meshw::common::open_store(inv, &repo_key)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| ident::Defer(format!("registry:{e}")))?);
    let caller = ident::caller_identity_detailed(&inv.env, &cwd)?;
    owns(inv, &rows, &caller.identity, id, &cwd, session, had_prior)?;
    crate::meshw::summary::check(&st, inv, None)?;
    Ok(Broadcast { st, repo_key, urgency })
}

/// `appendMeshMessage` of the heartbeat row plus the summary refresh; the result is `meshBroadcast`.
fn broadcast(inv: &Inv, b: &Broadcast, id: &str, text: &str) -> R<OVal> {
    let ts = inv.now.to_string();
    let mtype = defaults::text("mesh_write.mtype_broadcast");
    let hash = store::mesh_message_hash(Some(id), None, mtype, &b.urgency, text, &ts, false);
    let nonce = ident::reader_nonce(&inv.home);
    let mut row = store::mesh_message_row(Some(id), None, true, text, inv.now, &b.urgency, &hash, false, nonce.as_deref());
    row.is_heartbeat = true;
    let r = b.st.append_mesh_row(&row).map_err(|e| ident::Defer(format!("append:{e}")))?;
    crate::meshw::note_row(&hash);
    if let Some(why) = crate::meshw::summary::derive_after_write(&b.st, inv, &b.repo_key) {
        crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_heartbeat"), &why);
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("sent", OVal::Bool(r.inserted)).put("seq", r.seq.map_or(OVal::Null, |x| n(x as f64))).put("repoKey", s(&b.repo_key));
    Ok(o.done())
}

/// Run `heartbeat`.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    if a.is_help() {
        return defer("help");
    }
    let Some(id) = a.positionals.get(1).map(String::as_str).filter(|i| is_safe_id(i)) else { return defer("bad-id") };
    if is_primary_label(id) {
        return defer("primary-label");
    }
    let summary = a.one(defaults::text("mesh_write.flag_summary"));
    let step_raw = a.one(defaults::text("mesh_write.flag_step"));
    let Some(session) = a.one(defaults::text("mesh_write.flag_session")) else { return defer("no-session") };
    if id_mismatch_possible(inv, id) {
        return defer("id-mismatch");
    }
    if anchor_refresh_possible(inv)? {
        return defer("anchor-refresh");
    }
    // ---- reads: everything that can defer happens before the first write ----
    let beat_file =
        devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let had_prior = beat_file.exists();
    let desc = ident::read_descriptor(&inv.home, id);
    let mut pending = Pending { pending: false, not_draining: false, oldest: None };
    // APP-DB ARCHIVE GUARD: a workspace the DevSwarm app reports archived must not have its verdict cleared to alive
    let mut app_archived = false;
    let mut cache: Option<appdb::CacheWrite> = None;
    if let Some(d) = &desc {
        pending = pending_for(inv, id, d)?;
        let wt = union::path_field(d, defaults::text("mesh_write.field_worktree_path"))?;
        let (verdict, owed) = appdb::archived_verdict(&inv.home, &inv.env, inv.now, id, wt.as_deref(), true)?;
        app_archived = verdict == Some(true);
        cache = owed;
    }
    if summary.is_some() && app_archived {
        return defer("summary-archived"); // a dropped summary is logged through the verb-outcome log
    }
    let bcast = match summary {
        Some(_) => Some(prepare_broadcast(inv, a, id, session, had_prior)?),
        None => None,
    };
    // the plan: the step, or the summary of a workspace that has one (the mutation is tried on the plan as read)
    let status = a.one(defaults::text("mesh_write.flag_status")).unwrap_or(defaults::text("mesh_write.plan_status_default"));
    let now = inv.now as f64;
    let call = plan::Call { step_raw, status, summary, now };
    let found = if step_raw.is_some() || summary.is_some() { plan::find(inv, id)? } else { None };
    if let Some(f) = &found {
        let tried = plan::compute(inv, &f.key, id, &call, Some(f.plan.clone()))?;
        if !tried.events.is_empty() && plan::log_needs_rotation(inv) {
            return defer("supervision-rotate");
        }
    }
    let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
    let progress = a.one(defaults::text("mesh_write.flag_progress")).map(js_number_of_str).filter(|x| x.is_finite()).map(clamp_percent);
    let text_or_null = |name: &str| a.one(name).map_or(OVal::Null, |t| OVal::Str(t.to_string()));
    let strings = |name: &str| OVal::Arr(a.many(name).into_iter().map(|t| OVal::Str(t.to_string())).collect());
    let mut beat = Obj::default();
    beat.put("id", s(id))
        .put("ts", n(now))
        .put("state_ts", n(now))
        .put("source", s(defaults::text("mesh_write.heartbeat_source")))
        .put("progress_pct", progress.map_or(OVal::Null, n))
        .put("phase", text_or_null(defaults::text("mesh_write.flag_phase")))
        .put("wip", strings(defaults::text("mesh_write.flag_wip")))
        .put("blockers", strings(defaults::text("mesh_write.flag_blockers")))
        .put("sessionId", s(session))
        .put("version", running_version());
    let beat = beat.done();
    // ---- writes ----
    let root = devswarm_root(&inv.home);
    let dir = root.join(defaults::text("mesh_write.dir_heartbeats"));
    std::fs::create_dir_all(&dir).map_err(|e| ident::Defer(format!("heartbeat-dir:{e}")))?;
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}{}", std::process::id(), crate::meshw::common::now_ms(), defaults::text("mesh_write.tmp_suffix")));
    write_atomic(&file, &beat.stringify(), PathBuf::from(tmp)).map_err(|e| ident::Defer(format!("heartbeat-write:{e}")))?;
    crate::meshw::mark_committed();
    if let Some(c) = &cache {
        c.perform(); // the app-state cache Node refreshes while it works out the archive guard
    }
    // writeVerdict: best effort (Node swallows a failure)
    let mut verdict = Obj::default();
    verdict
        .put("status", s(defaults::text("mesh_write.liveness_alive")))
        .put("lastOutboundTs", n(now))
        .put("staleSince", OVal::Null)
        .put("nudgeAttempts", n(0.0))
        .put("nudgedAt", OVal::Null)
        .put("pending", OVal::Bool(pending.pending))
        .put("notDraining", OVal::Bool(pending.not_draining))
        .put("oldestUnreadAgeMs", pending.oldest.map_or(OVal::Null, n))
        .put("heartbeatTs", n(now));
    let vdir = root.join(defaults::text("mesh_write.dir_liveness"));
    let vfile = vdir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let mut vtmp = vfile.as_os_str().to_os_string();
    vtmp.push(defaults::text("mesh_write.tmp_suffix"));
    let write_verdict = || -> std::io::Result<()> {
        std::fs::create_dir_all(&vdir)?;
        write_atomic(&vfile, &verdict.done().stringify(), PathBuf::from(vtmp.clone()))
    };
    if !app_archived {
        crate::discard::harmless(write_verdict()); // keep: the verdict refresh is best-effort and never breaks a heartbeat (Node's catch)
    }
    // the mesh broadcast of --summary (an unchanged result for a call without one)
    let mesh_broadcast = match (&bcast, summary) {
        (Some(b), Some(text)) => broadcast(inv, b, id, text)?,
        _ => OVal::Null,
    };
    let mut ident_obj = Obj::default();
    ident_obj.put("id", s(&caller.identity)).put("kind", s(&caller.kind));
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("mesh_write.action_heartbeat")))
        .put("id", s(id))
        .put("heartbeat", beat)
        .put("meshBroadcast", mesh_broadcast)
        .put("identity", ident_obj.done())
        .put("idMismatch", OVal::Bool(false));
    if app_archived {
        out.put("appArchived", OVal::Bool(true));
    }
    // plan tracking: `--step`, or a summary for a workspace that has a plan
    let mut ok = true;
    let plan_out = match &found {
        Some(f) => Some(apply_plan(inv, f, id, &call)?),
        None if step_raw.is_some() => {
            let mut plan = Obj::default();
            plan.put("ok", OVal::Bool(false))
                .put("reason", s(defaults::text("mesh_write.hb_plan_no_plan")))
                .put("hint", s(&defaults::render("mesh_write.hb_plan_hint", &[("id", &id)])));
            Some(plan.done())
        }
        None => None,
    };
    if let Some(p) = plan_out {
        if matches!(p.get("reason"), Some(OVal::Str(r)) if r == defaults::text("mesh_write.plan_reason_bad_step")) {
            ok = false;
        }
        out.put("plan", p);
    }
    if !ok {
        out.put("ok", OVal::Bool(false));
    }
    Ok(Answer { code: if ok { 0 } else { 2 }, stdout: format!("{}\n", out.done().stringify()), effect: Effect::None })
}

/// `applyHeartbeatPlan` for a plan that exists: the locked update, then the supervision events.
fn apply_plan(inv: &Inv, f: &plan::Found, id: &str, call: &plan::Call<'_>) -> R<OVal> {
    let Some((c, written)) = plan::update(inv, &f.key, id, call)? else {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("reason", s(defaults::text("mesh_write.plan_reason_lock_busy")))
            .put("key", s(&f.key))
            .put("hint", s(defaults::text("mesh_write.plan_lock_busy_hint")));
        return Ok(o.done());
    };
    if let Some(text) = written {
        crate::meshw::note_written(&plan::plan_rel(&f.key), text.as_bytes());
    }
    for (typ, fields) in &c.events {
        if let Some(line) = plan::record(inv, typ, fields, call.now) {
            crate::meshw::note_written(&plan::log_rel(), line.as_bytes());
        }
    }
    Ok(c.out)
}
