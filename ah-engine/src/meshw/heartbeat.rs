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
use crate::checks::guardkit::text::js_number_of_str;
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::appdb;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect};
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
fn id_mismatch_possible(inv: &Inv, id: &str) -> bool {
    let child = inv.env.get(defaults::text("mesh_write.env_source_branch")).is_some_and(|v| !crate::checks::guardkit::text::js_trim(v).is_empty());
    let Some(env_id) = inv.env.get(defaults::text("mesh_write.env_builder_id")).filter(|b| is_safe_id(b)) else { return false };
    child && env_id != id
}

/// `refreshAnchorSession(ctx)` is a no-op unless the caller is a Primary checkout whose anchor descriptor records another
/// session; that case (the one that writes) defers.
fn anchor_refresh_possible(inv: &Inv) -> R<bool> {
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
fn running_version() -> OVal {
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
fn open_reader(inv: &Inv, desc: &OVal) -> R<Option<MeshReader>> {
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
fn known_backlog(inbox: Option<&str>, cursor_file: Option<&str>) -> R<usize> {
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

/// Run `heartbeat`.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    if a.is_help() {
        return defer("help");
    }
    let Some(id) = a.positionals.get(1).map(String::as_str).filter(|i| is_safe_id(i)) else { return defer("bad-id") };
    if is_primary_label(id) {
        return defer("primary-label");
    }
    if a.one(defaults::text("mesh_write.flag_summary")).is_some() {
        return defer("summary");
    }
    // `--step`: with no plan file Node answers `no-plan`; with one it updates the plan under a lock (not ported)
    let step = a.one(defaults::text("mesh_write.flag_step")).is_some();
    if step && crate::meshw::common::sender_has_plan(inv, id)? {
        return defer("plan-present");
    }
    let Some(session) = a.one(defaults::text("mesh_write.flag_session")) else { return defer("no-session") };
    if id_mismatch_possible(inv, id) {
        return defer("id-mismatch");
    }
    if anchor_refresh_possible(inv)? {
        return defer("anchor-refresh");
    }
    // ---- reads: everything that can defer happens before the first write ----
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
    let caller = ident::caller_identity_detailed(&inv.env, &inv.cwd)?;
    let progress = a.one(defaults::text("mesh_write.flag_progress")).map(js_number_of_str).filter(|x| x.is_finite()).map(clamp_percent);
    let text_or_null = |name: &str| a.one(name).map_or(OVal::Null, |t| OVal::Str(t.to_string()));
    let strings = |name: &str| OVal::Arr(a.many(name).into_iter().map(|t| OVal::Str(t.to_string())).collect());
    let now = inv.now as f64;
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
    let mut ident_obj = Obj::default();
    ident_obj.put("id", s(&caller.identity)).put("kind", s(&caller.kind));
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("mesh_write.action_heartbeat")))
        .put("id", s(id))
        .put("heartbeat", beat)
        .put("meshBroadcast", OVal::Null)
        .put("identity", ident_obj.done())
        .put("idMismatch", OVal::Bool(false));
    if app_archived {
        out.put("appArchived", OVal::Bool(true));
    }
    if step {
        let mut plan = Obj::default();
        plan.put("ok", OVal::Bool(false))
            .put("reason", s(defaults::text("mesh_write.hb_plan_no_plan")))
            .put("hint", s(&defaults::render("mesh_write.hb_plan_hint", &[("id", &id)])));
        out.put("plan", plan.done());
    }
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect: Effect::None })
}
