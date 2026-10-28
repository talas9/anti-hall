//! `devswarm.js heartbeat <id> --session S [--progress N --phase T --wip T... --blockers T...]`, ported from
//! `scripts/devswarm-lib/heartbeat-plan.js` `cmdHeartbeat`.
//!
//! A heartbeat is proof of life: it writes the workspace's heartbeat record (`heartbeats/<id>.json`) and refreshes its
//! persisted liveness verdict (`liveness/<id>.json`) to `alive`, with the mailbox's `pending` / `notDraining` /
//! `oldestUnreadAgeMs` taken from the NDJSON + store unread union ([`crate::meshw::union`]).
//!
//! Every case answers natively, as Node does. `--summary` broadcasts a mesh heartbeat row (or reports why it did not: an app-archived
//! workspace, no project, a bad `--urgency`, a caller that does not own the id, which also files an attempt record for the
//! child Stop gate); `--step` and a summary for a workspace with a plan update the plan; a child label id is refused; a child that
//! addresses another id gets the stderr warning and `idMismatch: true`; a Primary checkout whose anchor session is stale re-registers
//! the anchor. (A heartbeat without `--session` records its caller's process line in `heartbeat-callers.log`, as Node does.)
//!
//! Every read happens before the first write; after the heartbeat record is written, the verdict write is best effort,
//! exactly as in Node (`try { writeVerdict } catch (_) {}`). A read that fails reads as Node's fail-open reads it (no
//! backlog, not archived, not owned) and is logged with its site (`mesh_heartbeat_degraded`).
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_number_of_str, js_trim};
use crate::defaults;
use crate::mesh::MeshReader;
use crate::meshw::appdb;
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{self, R};
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
pub(crate) fn is_primary_label(id: &str) -> bool {
    let hex = defaults::num("mesh_write.mesh_id_hex") as usize;
    id.strip_prefix(defaults::text("mesh_write.primary_prefix"))
        .is_some_and(|rest| rest.len() == hex && rest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// `isChildWorkspaceCorroborated(env, home, cwd)`: the env var says child AND the disk agrees (a registered
/// descriptor for the builder id, or a cwd under the app's repos tree).
fn child_corroborated(inv: &Inv) -> bool {
    if !inv.env.get(defaults::text("mesh_write.env_source_branch")).is_some_and(|v| !js_trim(v).is_empty()) {
        return false;
    }
    if let Some(id) = inv.env.get(defaults::text("mesh_write.env_builder_id")).filter(|b| !js_trim(b).is_empty() && is_safe_id(b)) {
        let desc = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
        match std::fs::metadata(&desc) {
            Ok(m) if m.is_file() => return true,
            // EACCES is not "no descriptor": a descriptor may exist that this process cannot see, so it corroborates
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return true,
            _ => {}
        }
    }
    let cwd = Path::new(&inv.cwd);
    if !cwd.is_dir() {
        return false;
    }
    let repos = inv.home.join(defaults::text("mesh_write.hb_app_repos_rel"));
    let repos_real = std::fs::canonicalize(&repos).unwrap_or_else(|_| PathBuf::from(ident::resolve_abs(&repos.to_string_lossy())));
    let cwd_real = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(ident::resolve_abs(&inv.cwd)));
    cwd_real.starts_with(&repos_real)
}

/// `warnIdMismatch` can only speak for a child workspace whose builder id differs from the heartbeat's id.
pub(crate) fn id_mismatch_possible(inv: &Inv, id: &str) -> bool {
    let child = inv.env.get(defaults::text("mesh_write.env_source_branch")).is_some_and(|v| !crate::checks::guardkit::text::js_trim(v).is_empty());
    let Some(env_id) = inv.env.get(defaults::text("mesh_write.env_builder_id")).filter(|b| is_safe_id(b)) else { return false };
    child && env_id != id
}

/// `warnIdMismatch(id, ctx)`: when a corroborated child addresses an id other than its own `DEVSWARM_BUILDER_ID`, say so on
/// stderr (never refuse) and report it.
pub(crate) fn warn_id_mismatch(inv: &Inv, id: &str) -> bool {
    if !id_mismatch_possible(inv, id) || !child_corroborated(inv) {
        return false;
    }
    let Some(env_id) = inv.env.get(defaults::text("mesh_write.env_builder_id")) else { return false };
    eprintln!("{}", defaults::render("mesh_write.msg_hb_id_mismatch", &[("id", &quote(id)), ("env_id", &quote(env_id))]));
    true
}

/// `JSON.stringify(text)`.
fn quote(x: &str) -> String {
    OVal::Str(x.to_string()).stringify()
}

/// `refreshAnchorSession(ctx)` is a no-op unless the caller is a Primary checkout whose anchor descriptor records another
/// session; true for the case that writes.
pub(crate) fn anchor_refresh_possible(inv: &Inv) -> R<bool> {
    let Some(sid) = inv.env.get(defaults::text("mesh_write.env_session_id")).filter(|v| !v.is_empty()) else { return Ok(false) };
    let c = ident::resolve_context(&inv.cwd, true)?;
    let Some(wt) = c.worktree_root.clone() else { return Ok(false) };
    if !ident::is_primary_checkout(&wt, c.main_worktree.as_deref(), &inv.home, &inv.env)? {
        return Ok(false);
    }
    let anchor = ident::mesh_id_for_real_path(&wt);
    let Some(pre) = ident::read_descriptor(&inv.home, &anchor) else { return Ok(false) };
    // `!pre.sessionId || String(pre.sessionId) === sid` -> no refresh; a non-string value reads as its JavaScript text
    match pre.get(defaults::text("mesh_write.field_session_id")) {
        None | Some(OVal::Null | OVal::Bool(false)) => Ok(false),
        Some(OVal::Num(x)) if *x == 0.0 || x.is_nan() => Ok(false),
        Some(OVal::Str(x)) if x.is_empty() => Ok(false),
        Some(x) => Ok(crate::dssup::ingest::import::js_string(x) != *sid),
    }
}

/// `refreshAnchorSession(ctx)`, fail-open: after a `/clear` the running session is a new one but the Primary anchor kept the
/// old id, so the anchor is re-registered under the caller's session, under the anchor's id lock, only while the caller's session is
/// running. Any refusal or failure leaves the heartbeat untouched (Node swallows it).
fn refresh_anchor_session(inv: &Inv) {
    let site = defaults::text("mesh_write.hb_site_anchor");
    let Ok(true) = anchor_refresh_possible(inv).inspect_err(|e| degraded(site, &e.0)) else { return };
    let Some(sid) = inv.env.get(defaults::text("mesh_write.env_session_id")).filter(|v| !v.is_empty()) else { return };
    if !crate::dssup::liveness::session_alive(&inv.home, sid).unwrap_or(false) {
        return;
    }
    let Ok(c) = ident::resolve_context(&inv.cwd, true) else { return };
    let Some(wt) = c.worktree_root.clone() else { return };
    let id = ident::mesh_id_for_real_path(&wt);
    let Some(lock) = crate::meshw::idlock::acquire(&inv.home, &id) else {
        degraded(site, defaults::text("mesh_write.hb_reason_lock_busy"));
        return;
    };
    // re-read under the lock: another process may have refreshed it already
    let again = ident::read_descriptor(&inv.home, &id);
    let stale = again.as_ref().and_then(|d| d.get(defaults::text("mesh_write.field_session_id"))).is_some_and(|v| match v {
        OVal::Null | OVal::Bool(false) => false,
        OVal::Num(x) => !(*x == 0.0 || x.is_nan()),
        OVal::Str(x) => !x.is_empty() && x != sid,
        other => crate::dssup::ingest::import::js_string(other) != *sid,
    });
    if stale {
        let mut reg = Args { positionals: vec![defaults::text("devswarm_cli.verb_register_primary").to_string()], ..Args::default() };
        reg.flags.insert(defaults::text("devswarm_cli.flag_worktree").to_string(), vec![crate::meshw::args::FlagVal::S(wt.clone())]);
        if let Some(OVal::Str(cp)) =
            again.as_ref().and_then(|d| d.get(defaults::text("mesh_write.field_cursor_path"))).filter(|v| !matches!(v, OVal::Str(x) if x.is_empty()))
        {
            reg.flags.insert(defaults::text("devswarm_cli.flag_reg_cursor").to_string(), vec![crate::meshw::args::FlagVal::S(cp.clone())]);
        }
        let reg_inv = Inv { cwd: wt, ..inv.clone() };
        match crate::meshw::lifeverbs::register_primary(&reg_inv, &reg) {
            Ok(done) if done.code == 0 => crate::meshw::mark_committed(),
            Ok(done) => degraded(site, done.stdout.trim()),
            Err(e) => degraded(site, &e.0),
        }
    }
    lock.release();
}

/// A read or step that failed and reads as Node's fail-open reads it: counted and logged with its site and reason.
fn degraded(site: &str, reason: &str) {
    crate::metrics::bump("mesh_heartbeat_degraded", &[("site", site), ("reason", reason)]);
    crate::debug::violated("meshw", &defaults::render("mesh_write.msg_hb_degraded", &[("site", &site), ("reason", &reason)]));
}

/// [`degraded`] for a result: its value, or the default after logging.
fn soft<T: Default>(site: &str, r: R<T>) -> T {
    r.unwrap_or_else(|e| {
        degraded(site, &e.0);
        T::default()
    })
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
/// yet, or none it can open); a store held in the journal backend (an old install, or a forced test backend) is one the engine does
/// not read, so it reads as no handle (the NDJSON-only backlog), counted and logged, as Node does for any store it cannot open.
pub(crate) fn open_reader(inv: &Inv, desc: &OVal) -> R<Option<MeshReader>> {
    let Some(wt) = union::path_field(desc, defaults::text("mesh_write.field_worktree_path"))? else { return Ok(None) };
    let Some(repo_key) = ident::repo_key_for_worktree(&wt)? else { return Ok(None) };
    let dir = union::store_dir(&inv.home, &repo_key);
    if !dir.exists() {
        return Ok(None);
    }
    let sqlite = defaults::text("mesh.backend_sqlite");
    let forced = inv.env.get(defaults::text("mesh_write.env_store_backend")).map(|v| v.trim().to_lowercase()).unwrap_or_default();
    if forced != sqlite {
        // `resolveStoreBackend`: a forced backend, else the marker, else what the disk already holds
        let journal = if !forced.is_empty() && forced == defaults::text("mesh_write.backend_journal") {
            true
        } else {
            let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
            if marker == defaults::text("mesh_write.backend_journal") {
                true
            } else if marker == sqlite {
                false
            } else {
                let has_db = std::fs::metadata(dir.join(defaults::text("mesh_write.store_file"))).is_ok_and(|m| m.len() > 0);
                !has_db && std::fs::read_dir(dir.join(defaults::text("mesh_write.hb_journal_dir"))).is_ok_and(|mut it| it.next().is_some())
            }
        };
        if journal {
            crate::metrics::bump(
                "mesh_store_backend_skipped",
                &[("site", defaults::text("mesh_write.hb_site_store")), ("backend", defaults::text("mesh_write.backend_journal"))],
            );
            crate::debug::violated(
                "meshw",
                &defaults::render(
                    "mesh_write.msg_store_backend_skipped",
                    &[("dir", &dir.display()), ("backend", &defaults::text("mesh_write.backend_journal"))],
                ),
            );
            return Ok(None);
        }
    }
    let db = dir.join(defaults::text("mesh_write.store_file"));
    if !db.exists() {
        return Ok(None);
    }
    match MeshReader::open(&db) {
        Ok(r) => Ok(Some(r)),
        Err(e) => {
            // `openStoreForUnread` returns null on ANY open error
            degraded(defaults::text("mesh_write.hb_site_store"), &e.to_string());
            Ok(None)
        }
    }
}

/// `unionPendingFor(descriptor, home, { now })`, fail-open as Node's: no store handle reads the NDJSON-only backlog; a
/// store read that fails is UNKNOWN and reported as pending (toward the alarm), never as an empty mailbox.
fn pending_for(inv: &Inv, desc: &OVal) -> Pending {
    let site = defaults::text("mesh_write.hb_site_pending");
    let inbox = union::path_field(desc, defaults::text("mesh_write.field_inbox_path")).unwrap_or_else(|e| {
        degraded(site, &e.0);
        None
    });
    let cursor_file = union::path_field(desc, defaults::text("mesh_write.field_cursor_path")).unwrap_or_else(|e| {
        degraded(site, &e.0);
        None
    });
    // the partition is the descriptor's own id (`descriptor.id`, as JavaScript prints it)
    let id = match desc.get(defaults::text("mesh_write.field_id")) {
        Some(OVal::Str(d)) => d.clone(),
        Some(OVal::Null) => defaults::text("mesh_write.js_null").to_string(),
        Some(other) => crate::dssup::ingest::import::js_string(other),
        None => defaults::text("mesh_write.js_undefined").to_string(),
    };
    let fallback = || {
        let lines = soft(site, known_backlog(inbox.as_deref(), cursor_file.as_deref()));
        Pending { pending: lines > 0, not_draining: false, oldest: None }
    };
    let reader = match open_reader(inv, desc) {
        Ok(Some(r)) => r,
        Ok(None) => return fallback(),
        Err(e) => {
            degraded(site, &e.0);
            return fallback();
        }
    };
    // a store read that fails is UNKNOWN (pending, toward the alarm); a case only the NDJSON side reads in a form the engine does not
    // convert is read from the NDJSON inbox alone, as for a partition without a store
    let failed = |reason: &str| {
        degraded(site, reason);
        if defaults::list("mesh_write.hb_store_error_prefixes").iter().any(|p| reason.starts_with(p)) {
            Pending { pending: true, not_draining: false, oldest: None }
        } else {
            fallback()
        }
    };
    let (store_base, nd_base) = match union::floor_bases(&reader, &inv.home, &id, cursor_file.as_deref()) {
        Ok(b) => b,
        Err(e) => return failed(&e.0),
    };
    let u = match union::union_unread(&union::UnionIn {
        inbox: inbox.as_deref(),
        cursor_file: cursor_file.as_deref(),
        id: &id,
        store: Some(&reader),
        store_base,
        nd_base,
        now: inv.now,
    }) {
        Ok(u) => u,
        Err(e) => return failed(&e.0),
    };
    let pending = u.unread > 0;
    let not_draining = pending && u.oldest_unread_age_ms.is_some_and(|a| a > defaults::num("mesh_write.not_draining_age_ms") as f64);
    Pending { pending, not_draining, oldest: u.oldest_unread_age_ms }
}

/// The lines `unreadBacklog(inboxPath, cursorPath)` reports: the inbox's lines past the cursor FILE's position, 0 when the
/// backlog is not known.
pub(crate) fn known_backlog(inbox: Option<&str>, cursor_file: Option<&str>) -> R<usize> {
    let (Some(i), Some(c)) = (inbox, cursor_file) else { return Ok(0) };
    let Some(all) = union::non_empty_lines(i)? else { return Ok(0) };
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

/// What `--summary` came to, decided from reads before anything is written (`meshBroadcast` in Node).
enum Plan {
    /// No `--summary`: `meshBroadcast` is null.
    Absent,
    /// A refusal or failure whose `meshBroadcast` object is decided (`attempt`: the record a dropped summary leaves).
    Report { value: OVal, attempt: Option<Attempt> },
    /// The row to broadcast.
    Send(Broadcast),
    /// Node's exception (the project store would not open): the answer is `{ ok:false, error }` after the heartbeat is recorded.
    Thrown(String),
}

/// The attempt record a dropped broadcast leaves for the child Stop gate (`summary-attempts/<repoKey>/<id>.ndjson`).
struct Attempt {
    repo_key: String,
    cause: String,
}

/// A `--summary` broadcast the engine writes: the shared store, resolved and checked before anything is written.
struct Broadcast {
    st: MeshStore,
    repo_key: String,
    urgency: String,
}

/// `ownershipRefusalCause(callerKind, ownEntry)`.
fn refusal_cause(kind: &str, own: Option<&ident::Row>) -> &'static str {
    if kind == defaults::text("mesh_write.kind_unresolvable") {
        defaults::text("mesh_write.hb_cause_unresolvable")
    } else if own.is_none() {
        defaults::text("mesh_write.hb_cause_unregistered")
    } else {
        defaults::text("mesh_write.hb_cause_mismatch")
    }
}

/// `crossLinkedIdentity(a, b)` on registry rows.
fn cross_linked(a: &ident::Row, b: &ident::Row) -> bool {
    if a.id.is_empty() || b.id.is_empty() || a.id == b.id {
        return false;
    }
    a.session_id.as_deref().is_some_and(|x| !x.is_empty() && x == b.id) || b.session_id.as_deref().is_some_and(|x| !x.is_empty() && x == a.id)
}

/// `deriveCallerSessionIdFromProcessTree(ctx)`: the session id of the nearest harness ancestor whose session record
/// is for this caller's worktree and whose process is not provably gone.
fn session_from_process_tree(inv: &Inv) -> Option<String> {
    let caller_wt = ident::canonical_worktree_real_path(&inv.cwd).ok().flatten().unwrap_or_else(|| inv.cwd.clone());
    if caller_wt.is_empty() {
        return None;
    }
    let dir = inv.home.join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
    let mut pid = i64::from(std::process::id());
    let mut seen = std::collections::HashSet::new();
    for _ in 0..=defaults::num("mesh_write.max_ppid_hops") {
        if pid <= 0 || !seen.insert(pid) {
            break;
        }
        let file = dir.join(format!("{pid}{}", defaults::text("mesh_write.json_suffix")));
        let rec = ident::read_or_skip(&file, defaults::text("mesh_write.hb_site_session")).and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)));
        if let Some(rec) = rec
            && let Some(cwd) = rec.get("cwd").and_then(|c| match c {
                OVal::Str(x) if !x.is_empty() => Some(x.clone()),
                _ => None,
            })
            && let Some(sid) =
                rec.get(defaults::text("mesh_write.field_session_id")).filter(|v| !matches!(v, OVal::Null)).map(crate::dssup::ingest::import::js_string)
        {
            let sid = js_trim(&sid).to_string();
            if !sid.is_empty() && !sid.starts_with(defaults::text("mesh_write.synthetic_session_prefix")) {
                let rec_wt = ident::canonical_worktree_real_path(&cwd).ok().flatten().unwrap_or(cwd);
                if rec_wt == caller_wt {
                    let since = std::fs::metadata(&file).ok().map(|m| crate::dssup::liveness::mtime_ms(&m));
                    let rec_pid = match rec.get("pid") {
                        Some(OVal::Num(x)) if x.fract() == 0.0 && *x > 0.0 => *x,
                        _ => pid as f64,
                    };
                    if crate::dssup::liveness::pid_is_alive(rec_pid, since) != Some(false) {
                        return Some(sid);
                    }
                }
            }
        }
        match crate::procid::parent(u32::try_from(pid).ok()?) {
            Some(next) if next > 1 => pid = i64::from(next),
            _ => break,
        }
    }
    None
}

/// `realSessionIdFrom(flags, ctx, id)`: a real session id (the flag, the ambient session, else derived while the row
/// still needs one), or none. Not the id itself and not a synthetic `unclaimed:` marker.
fn real_session_id(inv: &Inv, session_flag: Option<&str>, id: &str, rows: &[ident::Row]) -> Option<String> {
    let env_sid = inv.env.get(defaults::text("mesh_write.env_session_id")).map(String::as_str).filter(|v| !v.is_empty());
    let raw = session_flag.filter(|v| !v.is_empty()).or(env_sid);
    if let Some(raw) = raw {
        let v = js_trim(raw);
        return (!v.is_empty() && v != id && !v.starts_with(defaults::text("mesh_write.synthetic_session_prefix"))).then(|| v.to_string());
    }
    // rowStillNeedsSessionDerivation: derive only while a side of the row still lacks a real session
    let marker = format!("{}{id}", defaults::text("mesh_write.synthetic_session_prefix"));
    let desc_sid = ident::read_descriptor(&inv.home, id)
        .and_then(|d| d.get(defaults::text("mesh_write.field_session_id")).filter(|v| !matches!(v, OVal::Null)).map(crate::dssup::ingest::import::js_string));
    let reg_sid = rows.iter().find(|r| r.id == id).and_then(|r| r.session_id.clone());
    let real = |x: &Option<String>| x.as_deref().is_some_and(|v| !v.is_empty() && v != marker);
    if real(&desc_sid) && real(&reg_sid) {
        return None;
    }
    session_from_process_tree(inv).filter(|d| d != id)
}

/// `deriveAttemptRecordSessionId(ctx, id)`: never the `--session` flag (a string any caller chooses); the process tree's session,
/// which the environment's session must agree with when both exist.
fn attempt_session_id(inv: &Inv, id: &str) -> Option<String> {
    let env_candidate = inv
        .env
        .get(defaults::text("mesh_write.env_session_id"))
        .map(|v| js_trim(v).to_string())
        .filter(|v| !v.is_empty() && v != id && !v.starts_with(defaults::text("mesh_write.synthetic_session_prefix")));
    let derived = session_from_process_tree(inv).filter(|d| d != id);
    match (env_candidate, derived) {
        (Some(e), Some(d)) if e == d => Some(e),
        (_, Some(d)) => Some(d),
        _ => None,
    }
}

/// `ownerAppDbEnv(ctx)`: the environment for the first-claim leg's app-database read, with the two override keys removed, so
/// a caller cannot point "ground truth" at a database it wrote itself.
fn owner_app_env(env: &ident::Env) -> ident::Env {
    let mut e = env.clone();
    for k in defaults::list("mesh_write.hb_app_override_keys") {
        e.remove(k);
    }
    e
}

/// The first-claim leg (a0) of `broadcastFamilyOwns`: `id` has no registry row at all; the DevSwarm app's own database, not the caller's
/// word, must name an ACTIVE builder for the caller's worktree whose id is exactly `id`.
fn first_claim(inv: &Inv, id: &str, caller_kind: &str, cwd: &str) -> R<bool> {
    if caller_kind != defaults::text("mesh_write.kind_resolved") || ident::read_descriptor(&inv.home, id).is_some() {
        return Ok(false);
    }
    let Some(wt) = ident::resolve_caller_worktree(cwd)? else { return Ok(false) };
    let env = owner_app_env(&inv.env);
    let Some(file) = ident::app_db_path(&inv.home, &env) else { return Ok(false) };
    let Some(states) = appdb::read_states(&file)? else { return Ok(false) };
    let Some(want) = appdb::norm_path(&wt)? else { return Ok(false) };
    let active: Vec<&appdb::State> = states.iter().filter(|b| b.worktree.as_deref() == Some(want.as_str()) && b.active).collect();
    Ok(active.len() == 1 && active[0].id == id)
}

/// `broadcastFamilyOwns`: `id` belongs to the same workspace identity as the caller, never on raw-id equality alone and
/// never on anything a caller can forge. Fail-closed: a failure of any read is "not owned".
#[allow(clippy::too_many_arguments)]
fn family_owns(
    inv: &Inv,
    rows: &[ident::Row],
    own_entry: Option<&ident::Row>,
    id: &str,
    cwd: &str,
    caller_kind: &str,
    session_flag: Option<&str>,
    had_prior: bool,
) -> bool {
    let site = defaults::text("mesh_write.hb_site_owns");
    soft(site, family_owns_inner(inv, rows, own_entry, id, cwd, caller_kind, session_flag, had_prior).map(Some)).unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn family_owns_inner(
    inv: &Inv,
    rows: &[ident::Row],
    own_entry: Option<&ident::Row>,
    id: &str,
    cwd: &str,
    caller_kind: &str,
    session_flag: Option<&str>,
    had_prior: bool,
) -> R<bool> {
    let target = rows.iter().find(|r| r.id == id);
    let Some(target) = target.filter(|t| t.worktree_path.as_deref().is_some_and(|p| !p.is_empty())) else {
        return first_claim(inv, id, caller_kind, cwd);
    };
    let Some(t_key) = ident::canonical_mesh_id(target.worktree_path.as_deref().unwrap_or_default())? else { return Ok(false) };
    // (a1) cross-linked identity: unconditional, not gated on the worktree
    if own_entry.is_some_and(|e| cross_linked(e, target)) {
        return Ok(true);
    }
    // the remaining legs need the same worktree: the caller's own, or its registry row's
    let mut same = ident::resolve_caller_worktree(cwd)?.map(|w| ident::canonical_mesh_id(&w)).transpose()?.flatten().as_deref() == Some(t_key.as_str());
    if !same && let Some(wp) = own_entry.and_then(|e| e.worktree_path.as_deref()).filter(|p| !p.is_empty()) {
        same = ident::canonical_mesh_id(wp)?.as_deref() == Some(t_key.as_str());
    }
    if !same {
        return Ok(false);
    }
    // (a2) the target row's session is the caller's real session
    if let (Some(real), Some(ts)) = (real_session_id(inv, session_flag, id, rows), target.session_id.as_deref())
        && ts == real
    {
        return Ok(true);
    }
    // (a3) a placeholder: no descriptor and no heartbeat of its own before this call
    Ok(ident::read_descriptor(&inv.home, id).is_none() && !had_prior)
}

/// Everything the `--summary` broadcast needs, decided before the first write.
#[allow(clippy::too_many_arguments)]
fn plan_broadcast(inv: &Inv, a: &Args, id: &str, session_flag: Option<&str>, had_prior: bool, app_archived: bool) -> Plan {
    let ok_false = |fields: Vec<(&str, OVal)>| {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false));
        for (k, v) in fields {
            o.put(k, v);
        }
        o.done()
    };
    if app_archived {
        let why = defaults::text("mesh_write.hb_reason_app_archived");
        let value = ok_false(vec![
            ("reason", s(why)),
            ("dropped", OVal::Bool(true)),
            ("dropReason", s(why)),
            ("error", s(&defaults::render("mesh_write.msg_hb_app_archived", &[("id", &id)]))),
        ]);
        return Plan::Report { value, attempt: None };
    }
    let site = defaults::text("mesh_write.hb_site_broadcast");
    let cwd = match ident::project_cwd_for(&inv.home, &inv.env, &inv.cwd) {
        Ok(c) => c,
        Err(e) => {
            degraded(site, &e.0);
            inv.cwd.clone()
        }
    };
    let repo_key = soft(site, ident::repo_key_for_worktree(&cwd));
    let Some(repo_key) = repo_key else {
        let value = ok_false(vec![("reason", s(defaults::text("mesh_write.hb_reason_no_project")))]);
        return Plan::Report { value, attempt: None };
    };
    let urgency = a.one(defaults::text("mesh_write.flag_urgency")).unwrap_or(defaults::text("mesh_write.hb_urgency_default")).to_string();
    let allowed = defaults::list("mesh_write.allowed_urgency");
    if !allowed.contains(&urgency.as_str()) {
        let value = ok_false(vec![
            ("error", s(&defaults::render("mesh_write.msg_hb_urgency", &[("allowed", &allowed.join("|"))]))),
            ("allowed", OVal::Arr(allowed.iter().map(|x| s(x)).collect())),
        ]);
        // an invalid --urgency is a caller mistake: not one of the benign reasons, so the verb fails
        return Plan::Report { value, attempt: None };
    }
    let st = match crate::meshw::common::open_store(inv, &repo_key) {
        Ok(st) => st,
        Err(e) => {
            degraded(site, &e.0);
            return Plan::Thrown(e.0);
        }
    };
    let rows = match st.reader().roster() {
        Ok(r) => ident::rows_of(&r),
        Err(e) => {
            degraded(site, &e.to_string());
            Vec::new()
        }
    };
    let caller = soft(site, ident::caller_identity_detailed(&inv.env, &cwd).map(Some)).unwrap_or(ident::Caller {
        identity: String::new(),
        kind: defaults::text("mesh_write.kind_unresolvable").to_string(),
        mesh_id: None,
    });
    let own_entry = soft(site, crate::meshw::send::resolve_mesh_target(inv, None, &rows, Some(&caller.identity)));
    let owns = caller.identity == id
        || own_entry.as_ref().is_some_and(|e| e.id == id)
        || family_owns(inv, &rows, own_entry.as_ref(), id, &cwd, &caller.kind, session_flag, had_prior);
    if owns {
        return Plan::Send(Broadcast { st, repo_key, urgency });
    }
    let cause = refusal_cause(&caller.kind, own_entry.as_ref());
    let mut identity = Obj::default();
    identity.put("id", s(&caller.identity)).put("kind", s(&caller.kind));
    let value = ok_false(vec![
        ("reason", s(cause)),
        ("dropped", OVal::Bool(true)),
        ("dropReason", s(cause)),
        ("error", s(&defaults::render("mesh_write.msg_hb_not_owner", &[("cause", &cause), ("caller", &quote(&caller.identity)), ("id", &quote(id))]))),
        ("callerIdentity", s(&caller.identity)),
        ("identity", identity.done()),
    ]);
    Plan::Report { value, attempt: Some(Attempt { repo_key, cause: cause.to_string() }) }
}

/// The attempt record of a dropped broadcast (heartbeat-plan.js:451-516): a bounded, append-only per-id file the child Stop gate reads, stamped with
/// this process's nonce and its derived (never flag-supplied) session. Best effort, as in Node.
fn write_attempt(inv: &Inv, att: &Attempt, id: &str, text: &str, now: f64) {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.hb_attempts_dir")).join(&att.repo_key);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.hb_attempts_suffix")));
    let cap = defaults::num("mesh_write.hb_attempt_summary_cap") as usize;
    let units: Vec<u16> = text.encode_utf16().take(cap).collect();
    let mut row = Obj::default();
    row.put("ts", n(now))
        .put("id", s(id))
        .put("reason", s(&att.cause))
        .put("summary", s(&String::from_utf16_lossy(&units)))
        .put("instanceNonce", ident::reader_nonce(&inv.home).as_deref().map_or(OVal::Null, s))
        .put("sessionId", attempt_session_id(inv, id).as_deref().map_or(OVal::Null, s))
        .put("pid", n(f64::from(std::process::id())));
    let line = format!("{}\n", row.done().stringify());
    {
        use std::io::Write;
        let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) else { return };
        if f.write_all(line.as_bytes()).is_err() {
            return;
        }
    }
    // trim to the newest lines once past the threshold (atomic: a reader never sees a half-written file)
    let Ok(text) = std::fs::read_to_string(&file) else { return };
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    if lines.len() > defaults::num("mesh_write.hb_attempt_trim_over") as usize {
        let keep = defaults::num("mesh_write.hb_attempt_trim_to") as usize;
        let trimmed = format!("{}\n", lines[lines.len() - keep..].join("\n"));
        let mut tmp = file.as_os_str().to_os_string();
        tmp.push(format!(".{}.{}{}", std::process::id(), crate::meshw::common::now_ms(), defaults::text("mesh_write.tmp_suffix")));
        crate::discard::harmless(write_atomic(&file, &trimmed, PathBuf::from(tmp))); // keep: the trim is best effort, the append above already succeeded
    }
}

/// `appendMeshMessage` of the heartbeat row plus the summary refresh; the result is `meshBroadcast`.
fn broadcast(inv: &Inv, b: &Broadcast, id: &str, text: &str) -> Result<OVal, String> {
    let ts = inv.now.to_string();
    let mtype = defaults::text("mesh_write.mtype_broadcast");
    let hash = store::mesh_message_hash(Some(id), None, mtype, &b.urgency, text, &ts, false);
    let nonce = ident::reader_nonce(&inv.home);
    let mut row = store::mesh_message_row(Some(id), None, true, text, inv.now, &b.urgency, &hash, false, nonce.as_deref());
    row.is_heartbeat = true;
    match b.st.append_mesh_row(&row) {
        Ok(r) => {
            crate::meshw::mark_committed();
            crate::meshw::note_row(&hash);
            if let Some(why) = crate::meshw::summary::derive_after_write(&b.st, inv, &b.repo_key) {
                crate::meshw::log_summary_failure(defaults::text("mesh_write.verb_heartbeat"), &why);
            }
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(true))
                .put("sent", OVal::Bool(r.inserted))
                .put("seq", r.seq.map_or(OVal::Null, |x| n(x as f64)))
                .put("repoKey", s(&b.repo_key));
            Ok(o.done())
        }
        // the store write threw: Node's dispatcher reports the exception as the verb's own error
        Err(e) => Err(e.to_string()),
    }
}

/// `appendHeartbeatCallerLog(home, id, now)`: one line naming the process that sent a heartbeat without `--session` (its pid, parent
/// pid and first arguments), the file capped to its newest `mesh_write.heartbeat_callers_cap` lines. Best effort.
fn append_caller_log(inv: &Inv, id: &str, now: f64) {
    let p = devswarm_root(&inv.home).join(defaults::text("mesh_write.heartbeat_callers_log"));
    let argv: Vec<String> = std::env::args().take(defaults::num("mesh_write.heartbeat_callers_argv") as usize).collect();
    let mut o = Obj::default();
    // SAFETY: getppid has no preconditions and cannot fail
    let ppid = unsafe { libc::getppid() };
    o.put("ts", n(now)).put("pid", n(f64::from(std::process::id()))).put("ppid", n(f64::from(ppid))).put("argv", s(&argv.join(" "))).put("id", s(id));
    let mut lines: Vec<String> = std::fs::read_to_string(&p).map(|t| t.split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    lines.push(o.done().stringify());
    let cap = defaults::num("mesh_write.heartbeat_callers_cap") as usize;
    if lines.len() > cap {
        lines.drain(..lines.len() - cap);
    }
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports nothing either way
    }
    crate::discard::harmless(std::fs::write(&p, format!("{}\n", lines.join("\n")))); // keep: instrumentation only (Node's catch)
}

/// `childLabelRefusal(id, flags, ctx)`: `primary-<hash>` of a CHILD worktree is not an identity anyone owns, so a heartbeat or
/// registration under it is refused with the child's own id when it has one. Fail-open: any failure reads as no refusal.
pub(crate) fn child_label_refusal(inv: &Inv, a: &Args, id: &str) -> Option<Vec<(String, OVal)>> {
    let site = defaults::text("mesh_write.hb_site_label");
    soft(site, child_label_inner(inv, a, id))
}

fn child_label_inner(inv: &Inv, a: &Args, id: &str) -> R<Option<Vec<(String, OVal)>>> {
    if !is_primary_label(id) {
        return Ok(None);
    }
    let (home, env, cwd) = (&inv.home, &inv.env, inv.cwd.as_str());
    let registry: Vec<ident::Row> = match ident::repo_key_for_worktree(cwd)? {
        Some(key) => match crate::meshw::tick::open_reader(inv, &key) {
            Ok(Some(r)) => r.roster().map(|x| ident::rows_of(&x)).unwrap_or_default(),
            _ => Vec::new(),
        },
        None => Vec::new(),
    };
    let row = registry.iter().find(|r| r.id == id);
    let wt_flag = a.one(defaults::text("devswarm_cli.flag_worktree")).filter(|v| !v.is_empty());
    let wt: Option<String> = if let Some(w) = row.and_then(|r| r.worktree_path.as_deref()).filter(|p| !p.is_empty()) {
        ident::canonical_worktree_real_path(w)?
    } else if let Some(w) = wt_flag.filter(|w| ident::canonical_mesh_id(w).ok().flatten().as_deref() == Some(id)) {
        ident::canonical_worktree_real_path(w)?
    } else if ident::caller_identity_detailed(env, cwd)?.identity == id {
        ident::resolve_caller_worktree(cwd)?
    } else {
        None
    };
    // a label already folded away (retired/<id>.json names its canonical id) is never re-minted
    let redirect = crate::meshw::readprimary::read_retired_redirect(inv, id);
    let retired_to = redirect.filter(|r| r != id);
    let refusal = |resolved: Option<&str>, worktree: Option<&str>, error: String| {
        vec![
            ("ok".into(), OVal::Bool(false)),
            ("reason".into(), s(defaults::text("mesh_write.hb_reason_child_label"))),
            ("id".into(), s(id)),
            ("resolvedTo".into(), resolved.map_or(OVal::Null, s)),
            ("worktree".into(), worktree.map_or(OVal::Null, s)),
            ("error".into(), s(&error)),
        ]
    };
    let Some(wt) = wt else {
        let Some(to) = retired_to else { return Ok(None) };
        return Ok(Some(refusal(Some(&to), None, defaults::render("mesh_write.msg_hb_label_retired", &[("id", &quote(id)), ("to", &quote(&to))]))));
    };
    let ic = ident::resolve_context(&wt, false)?;
    let Some(root) = ic.worktree_root.as_deref() else { return Ok(None) };
    if ident::is_primary_checkout(root, ic.main_worktree.as_deref(), home, env)? {
        return Ok(None);
    }
    let mut kids: Vec<String> = Vec::new();
    for r in registry.iter().filter(|r| !r.id.is_empty() && !r.id.starts_with(defaults::text("mesh_write.primary_prefix"))) {
        if let Some(p) = r.worktree_path.as_deref().filter(|p| !p.is_empty())
            && ident::canonical_worktree_real_path(p)?.as_deref() == Some(wt.as_str())
            && !kids.contains(&r.id)
        {
            kids.push(r.id.clone());
        }
    }
    let app = soft(defaults::text("mesh_write.hb_site_label"), ident::builder_for_worktree(home, env, &wt));
    let child_id: Option<String> = app.filter(|b| kids.contains(&b.id)).map(|b| b.id).or_else(|| (kids.len() == 1).then(|| kids[0].clone())).or(retired_to);
    if child_id.is_none() {
        // no registered child id: the label is the only identity that worktree has, except from the Primary checkout
        let caller_ic = ident::resolve_context(cwd, true)?;
        let from_primary = match caller_ic.worktree_root.as_deref() {
            Some(r) if r != wt => ident::is_primary_checkout(r, caller_ic.main_worktree.as_deref(), home, env)?,
            _ => false,
        };
        if !from_primary {
            return Ok(None);
        }
    }
    let hint = match &child_id {
        Some(c) => defaults::render("mesh_write.msg_hb_label_use", &[("child", &quote(c))]),
        None => defaults::text("mesh_write.msg_hb_label_unregistered").to_string(),
    };
    Ok(Some(refusal(child_id.as_deref(), Some(&wt), defaults::render("mesh_write.msg_hb_label_child", &[("id", &quote(id)), ("wt", &wt), ("hint", &hint)]))))
}

/// The answer of a verb that threw in Node: `{ ok:false, error }`, exit 2, with the exception logged.
fn thrown(inv: &Inv, id: &str, message: String) -> Answer {
    let repo_key = ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key);
    crate::meshw::clog::refusal(inv, defaults::text("mesh_write.verb_heartbeat"), repo_key.as_deref(), None, &message, None);
    let _ = id;
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(&message));
    Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None }
}

/// Run `heartbeat`. (A help request never gets here: `verb_of` classifies it as the `help` verb first.)
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    let Some(id) = a.positionals.get(1).map(String::as_str).filter(|i| is_safe_id(i)) else {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("error", s(defaults::text("mesh_write.msg_bad_workspace_id")));
        return Ok(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None });
    };
    if let Some(fields) = child_label_refusal(inv, a, id) {
        let mut o = Obj::default();
        o.put("action", s(defaults::text("mesh_write.action_heartbeat")));
        for (k, v) in fields {
            o.put(&k, v);
        }
        return Ok(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None });
    }
    let summary = a.one(defaults::text("mesh_write.flag_summary"));
    let step_raw = a.one(defaults::text("mesh_write.flag_step"));
    let session_flag = a.one(defaults::text("mesh_write.flag_session"));
    let id_mismatch = warn_id_mismatch(inv, id);
    refresh_anchor_session(inv);
    // ---- reads ----
    let beat_file =
        devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_heartbeats")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let had_prior = beat_file.exists();
    let desc = ident::read_descriptor(&inv.home, id);
    let mut pending = Pending { pending: false, not_draining: false, oldest: None };
    // APP-DB ARCHIVE GUARD: a workspace the DevSwarm app reports archived must not have its verdict cleared to alive
    let mut app_archived = false;
    let mut cache: Option<appdb::CacheWrite> = None;
    if let Some(d) = &desc {
        pending = pending_for(inv, d);
        let wt = soft(defaults::text("mesh_write.hb_site_pending"), union::path_field(d, defaults::text("mesh_write.field_worktree_path")).map(Some)).flatten();
        match appdb::archived_verdict(&inv.home, &inv.env, inv.now, id, wt.as_deref(), true) {
            Ok((verdict, owed)) => {
                app_archived = verdict == Some(true);
                cache = owed;
            }
            Err(e) => degraded(defaults::text("mesh_write.hb_site_archived"), &e.0),
        }
    }
    let bcast = match summary {
        Some(_) => plan_broadcast(inv, a, id, session_flag, had_prior, app_archived),
        None => Plan::Absent,
    };
    // the plan: the step, or the summary of a workspace that has one (the mutation is tried on the plan as read)
    let status = a.one(defaults::text("mesh_write.flag_status")).unwrap_or(defaults::text("mesh_write.plan_status_default"));
    let now = inv.now as f64;
    let call = plan::Call { step_raw, status, summary, now };
    let found = if step_raw.is_some() || summary.is_some() { soft(defaults::text("mesh_write.hb_site_plan"), plan::find(inv, id)) } else { None };
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
        .put("sessionId", session_flag.map_or(OVal::Null, s))
        .put("version", running_version());
    let beat = beat.done();
    // ---- writes ----
    let root = devswarm_root(&inv.home);
    let dir = root.join(defaults::text("mesh_write.dir_heartbeats"));
    if let Err(e) = std::fs::create_dir_all(&dir) {
        return Ok(thrown(inv, id, crate::migrate::node_err(&e, defaults::text("mesh_write.hb_syscall_mkdir"), &dir)));
    }
    let file = dir.join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    if session_flag.is_none() {
        // the caller of a session-less heartbeat is recorded (`appendHeartbeatCallerLog`, instrumentation, best effort)
        crate::meshw::mark_committed();
        append_caller_log(inv, id, now);
    }
    let mut tmp = file.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}{}", std::process::id(), crate::meshw::common::now_ms(), defaults::text("mesh_write.tmp_suffix")));
    let tmp = PathBuf::from(tmp);
    if let Err(e) = write_atomic(&file, &beat.stringify(), tmp.clone()) {
        return Ok(thrown(inv, id, crate::migrate::node_err(&e, defaults::text("mesh_write.hb_syscall_open"), &tmp)));
    }
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
    // the mesh broadcast of --summary (null for a call without one), or the report of why it did not happen
    let (mesh_broadcast, attempt) = match (&bcast, summary) {
        (Plan::Thrown(message), _) => return Ok(thrown(inv, id, message.clone())),
        (Plan::Send(b), Some(text)) => match broadcast(inv, b, id, text) {
            Ok(v) => (v, None),
            Err(message) => return Ok(thrown(inv, id, message)),
        },
        (Plan::Report { value, attempt }, _) => (value.clone(), attempt.as_ref()),
        _ => (OVal::Null, None),
    };
    if let (Some(att), Some(text)) = (attempt, summary) {
        write_attempt(inv, att, id, text, now);
    }
    let mut hard_failure = false;
    let mut dropped: Option<String> = None;
    if matches!(mesh_broadcast.get("ok"), Some(OVal::Bool(false))) {
        let reason = match mesh_broadcast.get("reason") {
            Some(OVal::Str(r)) => Some(r.as_str()),
            _ => None,
        };
        // a broadcast refusal is logged for `devswarm logs` (logVerbOutcome)
        let msg = match (mesh_broadcast.get("error"), reason) {
            (Some(OVal::Str(e)), _) => e.clone(),
            (_, Some(r)) => r.to_string(),
            _ => defaults::text("mesh_write.msg_hb_no_detail").to_string(),
        };
        let repo_key = ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key);
        crate::meshw::clog::refusal(inv, defaults::text("mesh_write.hb_log_op"), repo_key.as_deref(), Some(id), &msg, reason);
        // the verb fails on a hard broadcast failure: not-ok whose reason is none of the benign ones
        hard_failure = !reason.is_some_and(|r| defaults::list("mesh_write.hb_benign_reasons").contains(&r));
        if matches!(mesh_broadcast.get("dropped"), Some(OVal::Bool(true))) {
            dropped = Some(match mesh_broadcast.get("dropReason") {
                Some(OVal::Str(r)) => r.clone(),
                _ => reason.unwrap_or(defaults::text("mesh_write.hb_reason_unknown")).to_string(),
            });
        }
    }
    // `identity` is computed fresh (a pure cwd/env resolution); null when that throws
    let identity = match ident::caller_identity_detailed(&inv.env, &inv.cwd) {
        Ok(c) => {
            let mut ident_obj = Obj::default();
            ident_obj.put("id", s(&c.identity)).put("kind", s(&c.kind));
            ident_obj.done()
        }
        Err(e) => {
            degraded(defaults::text("mesh_write.hb_site_identity"), &e.0);
            OVal::Null
        }
    };
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(!hard_failure))
        .put("action", s(defaults::text("mesh_write.action_heartbeat")))
        .put("id", s(id))
        .put("heartbeat", beat)
        .put("meshBroadcast", mesh_broadcast)
        .put("identity", identity)
        .put("idMismatch", OVal::Bool(id_mismatch));
    if app_archived {
        out.put("appArchived", OVal::Bool(true));
    }
    // a DROPPED --summary is otherwise only visible buried in the nested object: one plain top-level line
    if let Some(why) = dropped {
        out.put("note", s(&defaults::render("mesh_write.msg_hb_note", &[("why", &why)])));
    }
    // plan tracking: `--step`, or a summary for a workspace that has a plan
    let mut ok = !hard_failure;
    let plan_out = match &found {
        Some(f) => Some(match apply_plan(inv, f, id, &call) {
            Ok(p) => p,
            Err(e) => {
                let mut o = Obj::default();
                o.put("ok", OVal::Bool(false)).put("reason", s(defaults::text("mesh_write.hb_plan_error"))).put("error", s(&e.0));
                o.done()
            }
        }),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_inv(tag: &str) -> Inv {
        defaults::init().unwrap();
        let home = std::env::temp_dir().join(format!("ah-hb-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&home).unwrap();
        let cwd = home.join("plain");
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap().to_string_lossy().into_owned();
        let mut env: ident::Env = Default::default();
        // the host's own DevSwarm app database is never consulted
        env.insert(defaults::text("mesh_write.env_app_db").to_string(), defaults::text("mesh_write.app_db_off").to_string());
        Inv { home: home.clone(), write_home: home, env, cwd, now: 1_000_000, stdin: None, store_override: None }
    }

    fn init_repo(inv: &mut Inv) {
        let dir = inv.home.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        let st = std::process::Command::new("git").current_dir(&dir).args(["init", "-q", "-b", "main"]).env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap();
        assert!(st.success());
        inv.cwd = dir.canonicalize().unwrap().to_string_lossy().into_owned();
    }

    fn run_args(inv: &Inv, words: &[&str]) -> (i32, OVal) {
        let argv: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        let ans = run(inv, &crate::meshw::args::parse(&argv)).unwrap();
        (ans.code, OVal::parse(ans.stdout.trim()).unwrap())
    }

    fn field<'a>(v: &'a OVal, k: &str) -> &'a OVal {
        v.get(k).unwrap_or_else(|| panic!("no {k} in {}", v.stringify()))
    }

    #[test]
    fn a_missing_or_unsafe_id_is_refused_with_nodes_message() {
        let inv = scratch_inv("badid");
        for words in [&["heartbeat"][..], &["heartbeat", "../x"][..]] {
            let (code, v) = run_args(&inv, words);
            assert_eq!(code, 2);
            assert_eq!(v.stringify(), r#"{"ok":false,"error":"invalid or missing workspace id"}"#);
        }
    }

    #[test]
    fn a_retired_worktree_label_is_refused_naming_its_canonical_id() {
        let inv = scratch_inv("retired");
        let dir = crate::meshw::idlock::devswarm_root(&inv.home).join(defaults::text("devswarm_cli.rr_dir_retired"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("primary-0123abcd.json"), r#"{"retiredTo":"real-id"}"#).unwrap();
        let (code, v) = run_args(&inv, &["heartbeat", "primary-0123abcd"]);
        assert_eq!(code, 2);
        assert_eq!(
            v.stringify(),
            r#"{"action":"heartbeat","ok":false,"reason":"child-label-id","id":"primary-0123abcd","resolvedTo":"real-id","worktree":null,"error":"\"primary-0123abcd\" is a retired worktree label (folded into \"real-id\"), not an identity. Nothing was written."}"#
        );
        assert!(!crate::meshw::idlock::devswarm_root(&inv.home).join("heartbeats").join("primary-0123abcd.json").exists(), "nothing was written");
    }

    #[test]
    fn a_child_addressing_another_id_is_told_and_reported() {
        let mut inv = scratch_inv("mismatch");
        inv.env.insert("DEVSWARM_SOURCE_BRANCH".into(), "feature".into());
        inv.env.insert("DEVSWARM_BUILDER_ID".into(), "child-1".into());
        assert!(!warn_id_mismatch(&inv, "other"), "no descriptor and no app worktree: the env var alone corroborates nothing");
        let dir = crate::meshw::idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("child-1.json"), r#"{"id":"child-1"}"#).unwrap();
        assert!(warn_id_mismatch(&inv, "other"));
        assert!(!warn_id_mismatch(&inv, "child-1"), "its own id is no mismatch");
        let (code, v) = run_args(&inv, &["heartbeat", "other", "--session", "s1"]);
        assert_eq!(code, 0);
        assert_eq!(field(&v, "idMismatch"), &OVal::Bool(true));
    }

    #[test]
    fn a_summary_outside_any_project_reports_no_project_and_the_heartbeat_still_counts() {
        let inv = scratch_inv("noproject");
        let (code, v) = run_args(&inv, &["heartbeat", "w-1", "--summary", "hi", "--session", "s1"]);
        assert_eq!(code, 0);
        assert_eq!(field(&v, "ok"), &OVal::Bool(true));
        assert_eq!(field(&v, "meshBroadcast").stringify(), r#"{"ok":false,"reason":"no-project"}"#);
        assert!(crate::meshw::idlock::devswarm_root(&inv.home).join("heartbeats").join("w-1.json").is_file());
    }

    #[test]
    fn a_bad_urgency_fails_the_heartbeat_but_the_record_is_written() {
        let mut inv = scratch_inv("urgency");
        init_repo(&mut inv);
        let (code, v) = run_args(&inv, &["heartbeat", "w-1", "--summary", "hi", "--urgency", "bogus", "--session", "s1"]);
        assert_eq!(code, 2);
        assert_eq!(field(&v, "ok"), &OVal::Bool(false));
        assert_eq!(field(field(&v, "meshBroadcast"), "error").stringify(), r#""heartbeat --urgency must be one of low|normal|high|urgent""#);
        assert!(crate::meshw::idlock::devswarm_root(&inv.home).join("heartbeats").join("w-1.json").is_file());
    }

    #[test]
    fn a_summary_for_an_id_the_caller_does_not_own_is_dropped_with_an_attempt_record() {
        let mut inv = scratch_inv("dropped");
        init_repo(&mut inv);
        let (code, v) = run_args(&inv, &["heartbeat", "someone-else", "--summary", "my summary", "--session", "s1"]);
        assert_eq!(code, 0, "an ownership refusal is a working security control, not a failure");
        let mb = field(&v, "meshBroadcast");
        assert_eq!(field(mb, "reason"), &OVal::Str("caller-not-registered".into()));
        assert_eq!(field(mb, "dropped"), &OVal::Bool(true));
        assert_eq!(field(&v, "note"), &OVal::Str("summary NOT recorded: caller-not-registered".into()));
        let key = ident::repo_key_for_worktree(&inv.cwd).unwrap().unwrap();
        let rec = crate::meshw::idlock::devswarm_root(&inv.home).join("summary-attempts").join(key).join("someone-else.ndjson");
        let line = std::fs::read_to_string(rec).unwrap();
        let row = OVal::parse(line.trim()).unwrap();
        assert_eq!(field(&row, "id"), &OVal::Str("someone-else".into()));
        assert_eq!(field(&row, "reason"), &OVal::Str("caller-not-registered".into()));
        assert_eq!(field(&row, "summary"), &OVal::Str("my summary".into()));
    }

    #[test]
    fn the_callers_own_id_broadcasts_its_summary() {
        let mut inv = scratch_inv("owner");
        init_repo(&mut inv);
        let me = ident::caller_identity_detailed(&inv.env, &inv.cwd).unwrap().identity;
        let (code, v) = run_args(&inv, &["heartbeat", &me, "--summary", "working", "--session", "s1"]);
        assert_eq!(code, 0);
        let mb = field(&v, "meshBroadcast");
        assert_eq!((field(mb, "ok"), field(mb, "sent")), (&OVal::Bool(true), &OVal::Bool(true)), "{}", v.stringify());
    }

    #[test]
    fn a_store_in_the_journal_backend_reads_as_no_handle_not_as_a_handoff() {
        let mut inv = scratch_inv("journal");
        init_repo(&mut inv);
        let key = ident::repo_key_for_worktree(&inv.cwd).unwrap().unwrap();
        std::fs::create_dir_all(union::store_dir(&inv.home, &key)).unwrap();
        inv.env.insert(defaults::text("mesh_write.env_store_backend").to_string(), "journal".into());
        let desc = OVal::parse(&format!(r#"{{"id":"x","worktreePath":{}}}"#, OVal::Str(inv.cwd.clone()).stringify())).unwrap();
        assert!(open_reader(&inv, &desc).unwrap().is_none());
    }

    #[test]
    fn an_anchor_session_of_any_type_reads_as_javascript_reads_it() {
        let mut inv = scratch_inv("anchor");
        init_repo(&mut inv);
        inv.env.insert(defaults::text("mesh_write.env_session_id").to_string(), "abc".into());
        let wt = ident::resolve_context(&inv.cwd, true).unwrap().worktree_root.unwrap();
        let anchor = ident::mesh_id_for_real_path(&wt);
        let dir = crate::meshw::idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&dir).unwrap();
        for (body, want) in [
            (r#"{"sessionId":123}"#, true),
            (r#"{"sessionId":0}"#, false),
            (r#"{"sessionId":"abc"}"#, false),
            (r#"{"sessionId":"old"}"#, true),
            (r#"{"sessionId":["old"]}"#, true),
        ] {
            std::fs::write(dir.join(format!("{anchor}.json")), body).unwrap();
            assert_eq!(anchor_refresh_possible(&inv).unwrap(), want, "{body}");
        }
    }

    #[test]
    fn a_flag_session_that_is_the_id_or_synthetic_is_no_real_session() {
        let inv = scratch_inv("realsid");
        assert_eq!(real_session_id(&inv, Some(" s1 "), "w", &[]), Some("s1".into()));
        assert_eq!(real_session_id(&inv, Some("w"), "w", &[]), None);
        assert_eq!(real_session_id(&inv, Some("unclaimed:w"), "w", &[]), None);
    }
}
