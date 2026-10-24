//! The DevSwarm CLI verbs of lane l8h that move a workspace between its lifecycle states: `unarchive` first, then the verbs
//! of the later commits of the lane (see the module list in `extverbs`).
//!
//! The rules are those of the other store verbs ([`crate::meshw::actverbs`]): the engine answers every case natively, as Node's
//! `devswarm.js` does. A refusal Node prints (a busy lock, a guard) is printed and exits 2; a failure Node throws is the
//! dispatcher's `{ ok: false, error }`, exit 2, and logged. Nothing is handed to Node.
//!
//! The writes themselves are the reconcile port's op lists ([`crate::dssup::recon`]): the same code that the sweep applies after
//! its Node witness agreed, applied here under the workspace's lock after every precondition the plan recorded is re-checked.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dssup::recon::archive::{RestoreOpts, restore_archived_descriptor};
use crate::dssup::recon::{Hooks, UnitEnd, apply, view};
use crate::meshw::actverbs::{Resolved, resolve_archive_id};
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, s};
use crate::meshw::cursors;
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::{self, is_safe_id};
use crate::meshw::send::{Answer, Effect};
use crate::meshw::wsverbs;
use crate::migrate::readercur::{Cx, Handle, raise_all_loss_free};

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

/// `{ ok: false, error }` the way the dispatcher refuses a missing or unsafe id.
pub(crate) fn bad_id() -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(defaults::text("devswarm_cli.msg_bad_id")));
    answer(2, o.done())
}

/// `storeOwnerKeyFor(id, ctx)`: the project's key for the caller's cwd, else the id's own legacy hash bucket.
fn store_owner_key(inv: &Inv, id: &str) -> String {
    repo_key_for_cwd(inv).unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(id))
}

/// Node's `withIdLock` when a live holder keeps the lock past the budget: `{ ok: false, lockBusy: true, id, error }`, exit 2.
fn lock_busy(id: &str) -> Answer {
    let keys = defaults::list("devswarm_cli.key_lock_busy");
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put(keys[0], OVal::Bool(true))
        .put(keys[1], s(id))
        .put("error", s(&defaults::render("devswarm_cli.msg_lock_busy", &[("id", &quote(id))])));
    answer(2, o.done())
}

/// A failure Node's verb throws: the dispatcher answers `{ ok: false, error }` (exit 2) and writes the central log line.
fn thrown(inv: &Inv, op: &str, repo_key: Option<&str>, id: Option<&str>, msg: &str) -> Answer {
    crate::meshw::clog::refusal(inv, op, repo_key, id, msg, None);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(msg));
    answer(2, o.done())
}

/// `repoKeyForCwd(ctx)`: the project key of the caller's directory; a resolution that fails is no project (Node's try/catch).
fn repo_key_for_cwd(inv: &Inv) -> Option<String> {
    ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key)
}

/// `descriptorFreshRepoKey` for a worktree path value: a string that names a worktree, else none (Node's try/catch).
fn fresh_key_of(worktree: Option<&OVal>) -> Option<String> {
    match worktree {
        Some(OVal::Str(w)) if !w.is_empty() => ident::repo_key_for_worktree(w).ok().flatten(),
        _ => None,
    }
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(v: Option<&OVal>) -> bool {
    match v {
        None | Some(OVal::Null) | Some(OVal::Bool(false)) => false,
        Some(OVal::Str(x)) => !x.is_empty(),
        Some(OVal::Num(x)) => *x != 0.0 && !x.is_nan(),
        Some(_) => true,
    }
}

/// Apply a planned job's units to the real home, in order, the caller holding each unit's lock. `Err` carries the reason a unit
/// was not applied: a unit handed back (lock busy, drifted precondition) before any write changed nothing; one that fails after
/// an earlier step landed has written, so the commit mark is set and Node-era callers never repeat the verb.
pub(crate) fn apply_units_native(inv: &Inv, units: &[crate::dssup::recon::Unit]) -> Result<(), String> {
    let st = inv.settings();
    let env = apply::Env { home: &inv.home, now: inv.now, st: &st, log_dir: None };
    for (i, u) in units.iter().enumerate() {
        // the caller holds the workspace's lock
        let unlocked = crate::dssup::recon::Unit { label: u.label.clone(), lock: None, ops: u.ops.clone() };
        match apply::unit(&env, &unlocked, &Hooks::none()) {
            UnitEnd::Applied => crate::meshw::mark_committed(),
            UnitEnd::Deferred(why) if i == 0 => return Err(why),
            UnitEnd::Deferred(why) | UnitEnd::Failed(why) => {
                // a step that failed after earlier steps landed has written
                crate::meshw::mark_committed();
                return Err(why);
            }
        }
    }
    Ok(())
}

/// [`apply_units_native`] for the callers that still answer a failure through the hand-off type (`archiveverb`, another lane's
/// file): the reason travels as the error. Remove once that file reports the reason itself.
pub(crate) fn apply_units(inv: &Inv, units: &[crate::dssup::recon::Unit]) -> R<()> {
    apply_units_native(inv, units).map_err(ident::Defer)
}

/// Record a file the verb changed for the witness: the bytes it holds now (nothing when it is gone).
fn note_file(inv: &Inv, rel: &str) {
    crate::meshw::set_written(rel, &std::fs::read(inv.write_home.join(rel)).unwrap_or_default());
}

// ---- unarchive ----------------------------------------------------------------------------------------------------------

/// `unarchive <id>`: move the archived descriptor back into `workspaces/` and revive its registry row, for a descriptor of
/// the caller's own project (`cmdUnarchive` over `restoreArchivedDescriptor`).
pub fn unarchive(inv: &Inv, a: &Args) -> R<Answer> {
    let raw = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(raw) {
        return Ok(bad_id());
    }
    let id = match resolve_archive_id(inv, raw, true)? {
        Resolved::Id(x) => x,
        Resolved::Ambiguous(tpl, ids) => return Ok(Resolved::refusal(defaults::text("devswarm_cli.action_unarchive"), true, raw, tpl, &ids)),
    };
    let owner = store_owner_key(inv, &id);
    // the plan that counts is the one read under `withIdLock(id)`, and the units then run without taking the lock again
    let opts = RestoreOpts { keep_marker: false, require_owner_key: Some(owner.clone()) };
    // the plan is first read without the lock, so a case the restore planner itself still hands off leaves no lock file behind
    restore_archived_descriptor(&inv.home, &id, &opts)?;
    let Some(lock) = idlock::acquire(&inv.home, &id) else { return Ok(lock_busy(&id)) };
    let planned = restore_archived_descriptor(&inv.home, &id, &opts);
    let plan = match planned {
        Ok(p) => p,
        Err(d) => {
            lock.release();
            return Err(d);
        }
    };
    let ok = matches!(plan.result.get("ok"), Some(serde_json::Value::Bool(true)));
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(ok)).put("action", s(defaults::text("devswarm_cli.action_unarchive"))).put("id", s(&id));
    if ok {
        let applied = apply_units_native(inv, &plan.job.units);
        lock.release();
        if let Err(why) = applied {
            return Ok(thrown(inv, defaults::text("devswarm_cli.action_unarchive"), Some(&owner), Some(&id), &why));
        }
        for rel in [view::archived_rel(&id), view::descriptor_rel(&id)] {
            note_file(inv, &rel);
        }
        wsverbs::note_summary(inv, &owner);
        o.put("descriptorRestored", OVal::Bool(true));
    } else {
        let why = plan.result.get("error").and_then(|e| e.as_str()).unwrap_or_default();
        o.put("error", s(why));
        lock.release();
    }
    Ok(answer(if ok { 0 } else { 2 }, o.done()))
}

// ---- migrate-owner-keys -------------------------------------------------------------------------------------------------

/// What `migrateOwnerKeys` does to one descriptor.
enum Fix {
    /// Nothing: it has an owner key, or it is not the migration's to change.
    Nothing,
    /// The descriptor with its missing `ownerKey` (and `repoKey`) backfilled.
    Backfill(OVal),
    /// An active descriptor stranded in the legacy hash bucket of a project that now resolves (`rehomeCore` moves the registry
    /// row and the messages into the project's store): the project key it now resolves to.
    Rehome(String),
}

/// One descriptor the migration looks at.
struct Item {
    archived: bool,
    /// The file the scan found it in (the archived descriptor is read and written there; the active one at `workspaces/<id>.json`).
    path: std::path::PathBuf,
    id: String,
}

fn nonempty_str(v: Option<&OVal>) -> Option<&str> {
    match v {
        Some(OVal::Str(x)) if !x.is_empty() => Some(x.as_str()),
        _ => None,
    }
}

/// `readDescriptorPathState(p).descriptor`: a regular file (not a link) holding a JSON object; anything else is no descriptor.
fn read_descriptor_file(p: &std::path::Path) -> Option<OVal> {
    let m = std::fs::symlink_metadata(p).ok()?;
    if !m.is_file() {
        return None;
    }
    let d = OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))?;
    matches!(d, OVal::Obj(_)).then_some(d)
}

/// The decision of `migrateOwnerKeys` for the descriptor as it is now.
fn migration_fix(desc: &OVal, archived: bool, id: &str) -> Fix {
    let hash = crate::meshw::send::hash_from_workspace_id(match desc.get("id") {
        Some(OVal::Str(i)) => i.as_str(),
        _ => id,
    });
    // descriptorFreshRepoKey: a worktree path that is not a string resolves to no project
    let fresh = if truthy(desc.get("worktreePath")) { fresh_key_of(desc.get("worktreePath")) } else { None };
    let stored = nonempty_str(desc.get("ownerKey"));
    if !archived
        && stored == Some(hash.as_str())
        && let Some(f) = fresh.as_deref().filter(|f| *f != hash)
    {
        return Fix::Rehome(f.to_string());
    }
    if stored.is_some() {
        return Fix::Nothing;
    }
    // descriptorStructuralRepoKey: a persisted repoKey, else the key the worktree resolves to
    let resolved = fresh.clone().or_else(|| nonempty_str(desc.get("repoKey")).map(str::to_string)).unwrap_or(hash);
    let mut out = desc.clone();
    out.set("ownerKey", s_val(&resolved));
    if fresh.as_deref() == Some(resolved.as_str()) {
        out.set("repoKey", s_val(&resolved));
    }
    Fix::Backfill(out)
}

fn s_val(x: &str) -> OVal {
    OVal::Str(x.to_string())
}

/// The descriptors `migrateOwnerKeys` considers, in Node's scan order (active, then archived; each directory in the order
/// `readdirSync` gives, which is sorted), one per id: the first one seen wins, whatever file name it sits under.
fn migration_items(inv: &Inv) -> Vec<Item> {
    let root = idlock::devswarm_root(&inv.home);
    let suffix = defaults::text("mesh_write.json_suffix");
    let mut items: Vec<Item> = Vec::new();
    for (dir, archived) in [(root.join(defaults::text("mesh_write.dir_workspaces")), false), (root.join(defaults::text("mesh_write.dir_archived")), true)] {
        // checkedArchivedDir: a path that is not a plain directory is skipped silently
        if archived && !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink()) {
            continue;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut names: Vec<String> = rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.ends_with(suffix)).collect();
        names.sort();
        for name in names {
            let path = dir.join(&name);
            let Some(desc) = read_descriptor_file(&path) else { continue };
            // consider(): a descriptor without a safe string id or without a worktree path is not the migration's
            let id = match desc.get("id") {
                Some(OVal::Str(i)) if is_safe_id(i) => i.clone(),
                _ => continue,
            };
            if !truthy(desc.get("worktreePath")) || items.iter().any(|i| i.id == id) {
                continue;
            }
            items.push(Item { archived, path, id });
        }
    }
    items
}

/// `rehomeCore(home, id, repoKey)` with the id's lock held: the legacy hash bucket into the project's store.
fn rehome_locked(inv: &Inv, id: &str, to: &str) -> crate::dssup::recon::rehome::Moved {
    let st = inv.settings();
    let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &inv.home, st: &st, now: inv.now, engine_pokes: false };
    crate::dssup::recon::rehome::across_stores_locked(&ctx, id, &crate::meshw::send::hash_from_workspace_id(id), to)
}

/// `migrate-owner-keys`: backfill a missing `ownerKey` on every descriptor, active and archived, and re-home an active descriptor
/// stranded in the legacy hash bucket of a project that now resolves (`migrateOwnerKeys`).
pub fn migrate_owner_keys(inv: &Inv, _a: &Args) -> R<Answer> {
    let items = migration_items(inv);
    let (mut backfilled, mut rehomed, mut errors) = (0.0, 0.0, 0.0);
    let root = idlock::devswarm_root(&inv.home);
    for it in &items {
        // withIdLock: a busy lock skips the descriptor (Node reports no error for it)
        let Some(lock) = idlock::acquire(&inv.home, &it.id) else { continue };
        // re-read under the lock: never overwrite a concurrent live mutation
        let active = root.join(defaults::text("mesh_write.dir_workspaces")).join(format!("{}{}", it.id, defaults::text("mesh_write.json_suffix")));
        let (live, target) = if it.archived { (read_descriptor_file(&it.path), it.path.clone()) } else { (read_descriptor_file(&active), active) };
        if let Some(live) = live {
            match migration_fix(&live, it.archived, &it.id) {
                Fix::Nothing => {}
                Fix::Rehome(key) => {
                    crate::meshw::mark_committed();
                    if rehome_locked(inv, &it.id, &key).rehomed {
                        rehomed += 1.0;
                    }
                }
                Fix::Backfill(out) => {
                    crate::meshw::mark_committed();
                    let mut tmp = target.as_os_str().to_os_string();
                    tmp.push(format!(".{}.{}", std::process::id(), defaults::text("devswarm_cli.migrate_tmp_suffix")));
                    let tmp = std::path::PathBuf::from(tmp);
                    let wrote = std::fs::write(&tmp, out.stringify()).and_then(|()| std::fs::rename(&tmp, &target));
                    if wrote.is_ok() {
                        backfilled += 1.0;
                        if let Ok(rel) = target.strip_prefix(&inv.home) {
                            crate::meshw::set_written(&rel.to_string_lossy(), out.stringify().as_bytes());
                        }
                    } else {
                        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: Node's catch unlinks the staging file and counts the error
                        errors += 1.0;
                    }
                }
            }
        }
        lock.release();
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(errors == 0.0))
        .put("action", s(defaults::text("devswarm_cli.action_migrate_owner_keys")))
        .put("dryRun", OVal::Bool(false))
        .put("scanned", crate::meshw::common::n(items.len() as f64))
        .put("backfilled", crate::meshw::common::n(backfilled))
        .put("rehomed", crate::meshw::common::n(rehomed))
        .put("errors", crate::meshw::common::n(errors));
    Ok(answer(if errors == 0.0 { 0 } else { 2 }, o.done()))
}

// ---- ensure / register --------------------------------------------------------------------------------------------------

/// The flags `buildDescriptorFromFlags` reads, as `one()` / `many()` return them: an empty value is a value (falsy in the
/// places Node tests it with `||`).
struct RegFlags {
    worktree: Option<String>,
    session: Option<String>,
    inbox: Option<String>,
    cursor: Option<String>,
    nudge: Vec<String>,
    repo_id: Option<String>,
}

fn reg_flags(a: &Args) -> RegFlags {
    let name = |k: &str| defaults::text(k);
    let one = |k: &str| a.one(name(k)).map(str::to_string);
    RegFlags {
        worktree: one("devswarm_cli.flag_worktree"),
        session: one("devswarm_cli.flag_session"),
        inbox: one("devswarm_cli.flag_reg_inbox"),
        cursor: one("devswarm_cli.flag_reg_cursor"),
        nudge: a.many(name("devswarm_cli.flag_reg_nudge")).into_iter().map(str::to_string).collect(),
        repo_id: one("devswarm_cli.flag_reg_repo_id"),
    }
}

/// A flag value used the way `one(flags, x) || fallback` uses it: an empty value is no value.
fn filled(v: &Option<String>) -> Option<&str> {
    v.as_deref().filter(|x| !x.is_empty())
}

/// `Object.assign({}, desc)`: the copy of a parsed descriptor. A `__proto__` key is assigned through JavaScript's setter, so it
/// is not an own property of the copy and never reaches `JSON.stringify`.
fn assigned_copy(desc: &OVal) -> OVal {
    match desc {
        OVal::Obj(fields) => OVal::Obj(fields.iter().filter(|(k, _)| k != "__proto__").cloned().collect()),
        other => other.clone(),
    }
}

/// `buildDescriptorFromFlags(id, flags, existing, env)`: keys in Node's assignment order.
fn build_descriptor(inv: &Inv, id: &str, f: &RegFlags, existing: Option<&OVal>) -> OVal {
    let mut base = existing.map_or_else(|| OVal::Obj(Vec::new()), assigned_copy);
    base.set("id", s_val(id));
    if let Some(w) = &f.worktree {
        // path.resolve of a non-empty string; an empty value stays as it is
        base.set("worktreePath", s_val(&if w.is_empty() { String::new() } else { ident::resolve(&inv.cwd, w) }));
    }
    if let Some(x) = &f.session {
        base.set("sessionId", s_val(x));
    }
    if let Some(x) = &f.inbox {
        base.set("inboxPath", s_val(x));
    }
    if let Some(x) = &f.cursor {
        base.set("cursorPath", s_val(x));
    }
    if !f.nudge.is_empty() {
        base.set("nudgeCommand", OVal::Arr(f.nudge.iter().map(|x| s_val(x)).collect()));
    }
    if let Some(r) = &f.repo_id {
        base.set("repoId", s_val(r));
    } else if let Some(r) = inv.env.get(defaults::text("devswarm_gates.repo_id_env")).filter(|r| !r.is_empty()) {
        base.set("repoId", s_val(r));
    }
    for k in ["worktreePath", "sessionId", "inboxPath", "cursorPath", "nudgeCommand", "repoId"] {
        if base.get(k).is_none() {
            base.set(k, OVal::Null);
        }
    }
    base
}

/// `String(v)` of a parsed JSON value (what the registry's `nOrNull` stores for a field of any type).
fn js_text(v: &OVal) -> String {
    match v {
        OVal::Null => "null".to_string(),
        OVal::Bool(b) => b.to_string(),
        OVal::Num(x) => crate::checks::jsport::num::to_js_string(*x),
        OVal::Str(t) => t.clone(),
        OVal::Arr(items) => items.iter().map(|e| if matches!(e, OVal::Null) { String::new() } else { js_text(e) }).collect::<Vec<_>>().join(","),
        OVal::Obj(_) => defaults::text("devswarm_cli.js_object_text").to_string(),
    }
}

/// `nOrNull(desc[key])`: the registry column of a descriptor field.
fn column_of(d: &OVal, key: &str) -> Option<String> {
    match d.get(key) {
        None | Some(OVal::Null) => None,
        Some(v) => Some(js_text(v)),
    }
}

/// Whether Node's `retireWorktreeDuplicates` would find another registry row of the same physical worktree (it folds it into this
/// id). A registry that cannot be read finds none: that function is fail-open.
pub(crate) fn has_duplicate_rows(inv: &Inv, current: &str, id: &str, worktree: Option<&str>) -> R<bool> {
    let Some(w) = worktree else { return Ok(false) };
    let keep_mesh = ident::primary_workspace_id(w)?;
    if keep_mesh == id {
        return Ok(false);
    }
    let Some(keep_real) = ident::canonical_worktree_real_path(w)? else { return Ok(false) };
    let reader = crate::meshw::tick::open_reader_creating(inv, current)?;
    let Ok(roster) = reader.roster() else { return Ok(false) };
    let rows = ident::rows_of(&roster);
    for r in rows.iter().filter(|r| r.id != id) {
        if let Some(rw) = r.worktree_path.as_deref().filter(|x| !x.is_empty())
            && ident::canonical_worktree_real_path(rw)?.as_deref() == Some(keep_real.as_str())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `descriptorStructuralRepoKey(desc)`: a persisted repoKey, else the key its worktree resolves to.
fn structural_key(desc: &OVal) -> Option<String> {
    nonempty_str(desc.get("repoKey")).map(str::to_string).or_else(|| fresh_key_of(desc.get("worktreePath")))
}

/// `descriptorRegisteredRepoKey(desc, id)`: the project the id is registered under, from its worktree while that resolves, else the
/// key the descriptor persisted (never the legacy hash bucket).
fn registered_key(desc: &OVal, id: &str) -> Option<String> {
    if let Some(fresh) = fresh_key_of(desc.get("worktreePath")) {
        return Some(fresh);
    }
    let persisted = nonempty_str(desc.get("repoKey")).or_else(|| nonempty_str(desc.get("ownerKey")))?;
    (persisted != crate::meshw::send::hash_from_workspace_id(id)).then(|| persisted.to_string())
}

/// `reservedIdToken(id)`: the first reserved token an id carries.
fn reserved_token(id: &str) -> Option<String> {
    if let Some(t) = defaults::list("mesh_write.reserved_id_tokens").iter().find(|t| id.contains(**t)) {
        return Some((*t).to_string());
    }
    let suffix = defaults::text("mesh_write.reserved_id_suffix");
    if id.ends_with(suffix) {
        return Some(suffix.to_string());
    }
    (id == defaults::text("mesh_write.reserved_exact_id")).then(|| id.to_string())
}

/// `{ ok: false, ... }` the verb returns and the dispatcher logs (`logVerbOutcome`): printed with exit 2.
fn logged_refusal(inv: &Inv, op: &str, id: &str, fields: Vec<(&str, OVal)>) -> Answer {
    let text = |k: &str| match fields.iter().find(|(x, _)| *x == k) {
        Some((_, OVal::Str(t))) => Some(t.clone()),
        _ => None,
    };
    let reason = text("reason");
    let msg = text("error").or_else(|| reason.clone()).unwrap_or_else(|| defaults::text("devswarm_cli.msg_verb_not_ok").to_string());
    crate::meshw::clog::refusal(inv, op, repo_key_for_cwd(inv).as_deref(), Some(id), &msg, reason.as_deref());
    crate::meshw::mark_committed();
    fail_with(&fields)
}

/// `childLabelRefusal(id, flags, ctx)`: `primary-<hash>` of a CHILD worktree is no identity anyone owns. `Some(fields)` is the
/// refusal (without its leading `ok` and `action`), `None` lets the registration go on (Node's fail-open null).
fn child_label_refusal(inv: &Inv, id: &str, worktree_flag: Option<&str>) -> Option<Vec<(&'static str, OVal)>> {
    if !crate::meshw::heartbeat::is_primary_label(id) {
        return None;
    }
    let cwd = inv.cwd.as_str();
    let repo_key = ident::repo_key_for_worktree(cwd).ok().flatten();
    let registry: Vec<ident::Row> = repo_key
        .as_deref()
        .and_then(|k| crate::meshw::tick::open_reader(inv, k).ok().flatten())
        .and_then(|r| r.roster().ok())
        .map(|roster| ident::rows_of(&roster))
        .unwrap_or_default();
    let canonical = |p: &str| ident::canonical_worktree_real_path(p).ok().flatten();
    let row = registry.iter().find(|r| r.id == id);
    let wt = if let Some(w) = row.and_then(|r| r.worktree_path.as_deref()).filter(|w| !w.is_empty()) {
        canonical(w)
    } else if let Some(w) = worktree_flag.filter(|w| !w.is_empty()).filter(|w| ident::canonical_mesh_id(w).ok().flatten().as_deref() == Some(id)) {
        canonical(w)
    } else if ident::caller_identity_detailed(&inv.env, cwd).ok()?.identity == id {
        ident::resolve_caller_worktree(cwd).ok().flatten()
    } else {
        None
    };
    // 0.108.4: a label already folded away (retired/<id>.json names its canonical id) is never re-minted
    let retired_to = crate::meshw::readprimary::read_retired_redirect(inv, id).filter(|r| r != id);
    let Some(wt) = wt else {
        let to = retired_to?;
        let msg = defaults::render("devswarm_cli.msg_child_label_retired", &[("id", &quote(id)), ("to", &quote(&to))]);
        return Some(vec![
            ("reason", s(defaults::text("devswarm_cli.reason_child_label"))),
            ("id", s(id)),
            ("resolvedTo", s(&to)),
            ("worktree", OVal::Null),
            ("error", s(&msg)),
        ]);
    };
    let ic = ident::resolve_context(&wt, false).ok()?;
    let root = ic.worktree_root.clone().unwrap_or_else(|| wt.clone());
    if ident::is_primary_checkout(&root, ic.main_worktree.as_deref(), &inv.home, &inv.env).ok()? {
        return None;
    }
    let primary_prefix = defaults::text("devswarm_recon.primary_id_prefix");
    let mut kids: Vec<String> = Vec::new();
    for r in registry.iter().filter(|r| !r.id.starts_with(primary_prefix)) {
        if let Some(w) = r.worktree_path.as_deref().filter(|w| !w.is_empty())
            && canonical(w).as_deref() == Some(wt.as_str())
            && !kids.contains(&r.id)
        {
            kids.push(r.id.clone());
        }
    }
    let app = ident::builder_for_worktree(&inv.home, &inv.env, &wt).ok().flatten();
    let child_id = match app.filter(|b| kids.contains(&b.id)) {
        Some(b) => Some(b.id),
        None if kids.len() == 1 => Some(kids[0].clone()),
        None => None,
    }
    .or(retired_to);
    if child_id.is_none() {
        // no registered child id: the label is still that worktree's only identity (legacy / non-DevSwarm children), except from
        // the Primary checkout, which never registers a child's label
        let caller = ident::resolve_context(cwd, true).ok()?;
        let from_primary = match caller.worktree_root.as_deref() {
            Some(r) if r != wt => ident::is_primary_checkout(r, caller.main_worktree.as_deref(), &inv.home, &inv.env).ok()?,
            _ => false,
        };
        if !from_primary {
            return None;
        }
    }
    let remedy = match &child_id {
        Some(c) => defaults::render("devswarm_cli.msg_child_label_use", &[("child", &quote(c))]),
        None => defaults::text("devswarm_cli.msg_child_label_unregistered").to_string(),
    };
    let msg = defaults::render("devswarm_cli.msg_child_label_child", &[("id", &quote(id)), ("worktree", &wt), ("remedy", &remedy)]);
    Some(vec![
        ("reason", s(defaults::text("devswarm_cli.reason_child_label"))),
        ("id", s(id)),
        ("resolvedTo", child_id.as_deref().map_or(OVal::Null, s)),
        ("worktree", s(&wt)),
        ("error", s(&msg)),
    ])
}

/// What `archivedCounterpartInfo(home, id, currentWorktree)` knows of an archived marker.
enum Counterpart {
    /// The marker cannot be read or parsed: ambiguous, and it names no worktree.
    Unreadable,
    /// The marker's worktree (`null` when it names none) and whether it is the same workspace (`None`: ambiguous).
    Read { same: Option<bool>, worktree: Option<String> },
}

fn archived_counterpart(inv: &Inv, id: &str, current: Option<&str>) -> Counterpart {
    let p = idlock::devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{}", defaults::text("mesh_write.json_suffix")));
    let Ok(raw) = std::fs::read(&p) else { return Counterpart::Unreadable };
    let Some(desc) = OVal::parse(&String::from_utf8_lossy(&raw)) else { return Counterpart::Unreadable };
    let worktree = nonempty_str(desc.get("worktreePath")).map(str::to_string);
    let (Some(a), Some(c)) = (worktree.as_deref(), current.filter(|c| !c.is_empty())) else { return Counterpart::Read { same: None, worktree } };
    let real = |x: &str| ident::realpath(x).unwrap_or_else(|| x.to_string());
    let same = ident::resolve_abs(&real(a)) == ident::resolve_abs(&real(c));
    Counterpart::Read { same: Some(same), worktree }
}

/// `ensure` and `register`: `cmdRegister(id, flags, ctx, { requireNew })`, the whole mutation under the id's lock.
fn register_verb(inv: &Inv, a: &Args, require_new: bool) -> R<Answer> {
    register_core(inv, a, require_new, None, None)
}

/// [`register_verb`]; `primary` is the worktree of `register-primary`, whose id is a `primary-<hash>` label by design and whose
/// result names the worktree and the workspace instead of the action. `held` is the id's lock when the caller already holds it
/// (`withIdLockHeld`).
fn register_core(inv: &Inv, a: &Args, require_new: bool, primary: Option<&str>, held: Option<idlock::IdLock>) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        if let Some(l) = held {
            l.release();
        }
        return Ok(bad_id());
    }
    let op = if require_new { defaults::text("devswarm_cli.verb_ensure") } else { defaults::text("devswarm_cli.verb_register") };
    let f = reg_flags(a);
    if primary.is_none()
        && let Some(refusal) = child_label_refusal(inv, id, filled(&f.worktree))
    {
        // Object.assign({ action }, refusal): the action leads
        let mut o = Obj::default();
        o.put("action", s(op)).put("ok", OVal::Bool(false));
        for (k, v) in refusal {
            o.put(k, v);
        }
        return Ok(answer(2, o.done()));
    }
    let mut lock = match held {
        Some(l) => Some(l),
        None => match idlock::acquire(&inv.home, id) {
            Some(l) => Some(l),
            None => {
                let busy = lock_busy(id);
                crate::meshw::clog::refusal(
                    inv,
                    op,
                    repo_key_for_cwd(inv).as_deref(),
                    Some(id),
                    &defaults::render("devswarm_cli.msg_lock_busy", &[("id", &quote(id))]),
                    None,
                );
                return Ok(busy);
            }
        },
    };
    let out = register_locked(inv, id, op, &f, require_new, primary, &mut lock);
    if let Some(l) = lock {
        l.release();
    }
    out
}

/// The body of `cmdRegister`, the id's lock held in `lock` (released here before the duplicate fold, as Node's fold takes its
/// own locks).
fn register_locked(inv: &Inv, id: &str, op: &str, f: &RegFlags, require_new: bool, primary: Option<&str>, lock: &mut Option<idlock::IdLock>) -> R<Answer> {
    let root = idlock::devswarm_root(&inv.home);
    let json = defaults::text("mesh_write.json_suffix");
    let desc_file = root.join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{json}"));
    // `register` / `ensure` refusals are logged by the dispatcher (`logVerbOutcome`); `register-primary` prints its own
    let refuse = |fields: Vec<(&str, OVal)>| if primary.is_some() { fail_with(&fields) } else { logged_refusal(inv, op, id, fields) };
    // readDescriptorFile: an unreadable, non-regular or non-object descriptor is no descriptor
    let existing = read_descriptor_file(&desc_file);
    // the app database is ground truth for "archived": a refusal Node logs
    let guard_wt = filled(&f.worktree).map(str::to_string).or_else(|| existing.as_ref().and_then(|d| nonempty_str(d.get("worktreePath")).map(str::to_string)));
    let (verdict, cache) = crate::meshw::appdb::archived_verdict(&inv.home, &inv.env, inv.now, id, guard_wt.as_deref(), true).unwrap_or((None, None));
    if verdict == Some(true) {
        let reason = defaults::render("devswarm_cli.msg_reg_app_archived", &[("id", &id)]);
        return Ok(refuse(vec![
            ("action", s(defaults::text("devswarm_cli.action_app_archived_skip"))),
            ("id", s(id)),
            ("archived", OVal::Bool(true)),
            ("appArchived", OVal::Bool(true)),
            ("reason", s(&reason)),
        ]));
    }
    if existing.is_none()
        && let Some(token) = reserved_token(id)
    {
        let msg = defaults::render("devswarm_cli.msg_reg_reserved", &[("id", &quote(id)), ("token", &quote(&token))]);
        return Ok(refuse(vec![("id", s(id)), ("reason", s(defaults::text("devswarm_cli.reason_reserved_id"))), ("error", s(&msg))]));
    }
    // an archived marker: a routine auto-ensure does not revive the workspace it names
    let mut archived_note: Option<OVal> = None;
    let archived_marker = root.join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{json}"));
    if require_new && existing.is_none() && archived_marker.exists() {
        let info = archived_counterpart(inv, id, f.worktree.as_deref());
        if matches!(info, Counterpart::Read { same: Some(true), .. }) {
            let msg = defaults::render("devswarm_cli.msg_reg_archived_skip", &[("id", &id)]);
            return Ok(refuse(vec![
                ("action", s(defaults::text("devswarm_cli.action_archived_skip"))),
                ("id", s(id)),
                ("archived", OVal::Bool(true)),
                ("reason", s(&msg)),
            ]));
        }
        // a new workspace reusing the id, or a case that cannot be told: the registration goes on, loudly
        let (same, worktree, known) = match &info {
            Counterpart::Read { same, worktree } => (*same, worktree.clone(), true),
            Counterpart::Unreadable => (None, None, false),
        };
        let note = match (same, worktree.as_deref()) {
            (Some(false), Some(w)) => defaults::render("devswarm_cli.msg_reg_archived_other", &[("id", &id), ("path", &w)]),
            _ => defaults::render("devswarm_cli.msg_reg_archived_ambiguous", &[("id", &id)]),
        };
        let mut o = Obj::default();
        o.put("archivedRecordExists", OVal::Bool(true)).put("sameWorkspace", same.map_or(OVal::Null, OVal::Bool));
        if known {
            o.put("archivedWorktreePath", worktree.as_deref().map_or(OVal::Null, s));
        }
        if let Some(c) = f.worktree.as_deref() {
            o.put("currentWorktreePath", s(c));
        }
        o.put("note", s(&note));
        archived_note = Some(o.done());
    }
    let current = repo_key_for_cwd(inv);
    let fresh = |d: &OVal| fresh_key_of(d.get("worktreePath"));
    let mut rehomed: Option<crate::dssup::recon::rehome::Moved> = None;
    let (out_desc, rewrite, action, create) = if let (true, Some(ex0)) = (require_new, existing.as_ref()) {
        // ensure over a descriptor that exists: idempotent, only backfilling what is proven
        let mut ex = ex0.clone();
        if let Some(reg) = registered_key(&ex, id)
            && Some(reg.as_str()) != current.as_deref()
        {
            let tail = match current.as_deref() {
                Some(c) => defaults::render("devswarm_cli.msg_ctx_other", &[("caller", &quote(c))]),
                None => defaults::text("devswarm_cli.msg_ctx_none").to_string(),
            };
            let msg = format!(
                "{}{tail}{}{}",
                defaults::render("devswarm_cli.msg_ctx_head", &[("id", &quote(id)), ("registered", &quote(&reg))]),
                defaults::text("devswarm_cli.msg_ctx_join"),
                defaults::text("devswarm_cli.msg_ensure_tail")
            );
            return Ok(refuse(vec![
                ("id", s(id)),
                ("reason", s(defaults::text("devswarm_cli.reason_ctx_mismatch"))),
                ("registeredRepoKey", s(&reg)),
                ("callerRepoKey", current.as_deref().map_or(OVal::Null, s)),
                ("error", s(&msg)),
            ]));
        }
        // the descriptor is stranded in the legacy hash bucket and this project now resolves: re-home it first
        let hash = crate::meshw::send::hash_from_workspace_id(id);
        if let Some(cur) = current.as_deref()
            && nonempty_str(ex.get("ownerKey")) == Some(hash.as_str())
            && hash != cur
        {
            crate::meshw::mark_committed();
            let moved = rehome_locked(inv, id, cur);
            if moved.rehomed
                && let Some(again) = read_descriptor_file(&desc_file)
            {
                ex = again;
            }
            rehomed = Some(moved);
        }
        let owner_now = current.clone().unwrap_or_else(|| hash.clone());
        let stored = nonempty_str(ex.get("ownerKey")).map(str::to_string);
        let proven = stored.clone().or_else(|| structural_key(&ex));
        let active_legacy_per_id = stored.is_none() && proven.is_none() && current.is_none();
        if (proven.is_none() && !active_legacy_per_id) || proven.as_deref().is_some_and(|p| p != owner_now) {
            return Ok(refuse(vec![("error", s(defaults::text("devswarm_cli.msg_ensure_not_owner")))]));
        }
        let mut ensured = assigned_copy(&ex);
        if stored.is_none() {
            ensured.set("ownerKey", s_val(&owner_now));
        }
        if let Some(cur) = current.as_deref()
            && fresh(&ensured).as_deref() == Some(cur)
        {
            ensured.set("repoKey", s_val(cur));
        }
        for (key, flag, default) in [
            ("inboxPath", &f.inbox, crate::meshw::pull::inbox_default(&inv.home, id)),
            ("cursorPath", &f.cursor, crate::meshw::pull::cursor_default(&inv.home, id)),
        ] {
            if matches!(ensured.get(key), None | Some(OVal::Null)) || matches!(ensured.get(key), Some(OVal::Str(x)) if x.is_empty()) {
                ensured.set(key, s_val(filled(flag).unwrap_or(&default)));
            }
        }
        let rewrite = ensured.stringify() != ex.stringify();
        (ensured, rewrite, defaults::text("devswarm_cli.action_exists"), false)
    } else {
        let mut desc = build_descriptor(inv, id, f, existing.as_ref());
        let mut missing: Vec<&str> = Vec::new();
        if !desc.get("worktreePath").is_some_and(OVal::truthy) {
            missing.push(defaults::text("devswarm_cli.msg_reg_missing_worktree"));
        }
        if !desc.get("sessionId").is_some_and(OVal::truthy) {
            missing.push(defaults::text("devswarm_cli.msg_reg_missing_session"));
        }
        if !missing.is_empty() {
            let msg = defaults::render("devswarm_cli.msg_reg_requires", &[("missing", &missing.join(defaults::text("devswarm_cli.msg_reg_missing_join")))]);
            return Ok(refuse(vec![("error", s(&msg))]));
        }
        let worktree_key = fresh(&desc);
        if let (Some(cur), Some(wk)) = (current.as_deref(), worktree_key.as_deref())
            && cur != wk
        {
            let wt_json = quote(nonempty_str(desc.get("worktreePath")).unwrap_or_default());
            let msg = defaults::render("devswarm_cli.msg_reg_cross_project", &[("worktree", &wt_json), ("worktree_key", &wk), ("current", &cur)]);
            return Ok(refuse(vec![("error", s(&msg))]));
        }
        if let Some(cur) = current.as_deref()
            && worktree_key.as_deref() == Some(cur)
        {
            desc.set("repoKey", s_val(cur));
        }
        desc.set("ownerKey", s_val(&current.clone().unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(id))));
        let action = if existing.is_some() { defaults::text("devswarm_cli.action_updated") } else { defaults::text("devswarm_cli.action_registered") };
        (desc, true, action, true)
    };
    let owner_key = nonempty_str(out_desc.get("ownerKey")).map(str::to_string).unwrap_or_else(|| crate::meshw::send::hash_from_workspace_id(id));
    let wt_text = column_of(&out_desc, "worktreePath");
    let row = crate::meshw::store::RegistryRow {
        id: id.to_string(),
        worktree_path: wt_text.clone(),
        session_id: column_of(&out_desc, "sessionId"),
        inbox_path: column_of(&out_desc, "inboxPath"),
        cursor_path: column_of(&out_desc, "cursorPath"),
        nudge_command: match out_desc.get("nudgeCommand") {
            None | Some(OVal::Null) => None,
            Some(v) => Some(v.stringify()),
        },
    };
    // upsertStoreRegistry opens the store of the descriptor's owner key (a new project's store is created, as Node's `openStore` does)
    let reader = crate::meshw::tick::open_reader(inv, &owner_key)?;
    if reader.is_none() {
        common::init_new_store(inv, &owner_key)?;
    }
    let store = common::open_store(inv, &owner_key)?;
    crate::meshw::summary::check(&store, inv, None)?;
    let declare = if create { crate::meshw::pull::plan_declare(inv, &store, id)? } else { Vec::new() };
    // ---- the writes, under the workspace's lock ----
    crate::meshw::mark_committed();
    if let Some(c) = &cache {
        c.perform();
    }
    let mut failure: Option<String> = None;
    if rewrite && let Err(e) = crate::meshw::pull::write_descriptor(inv, id, &out_desc) {
        failure = Some(e.to_string());
    }
    if failure.is_none() {
        crate::meshw::pull::precreate(&out_desc);
        // the ensure's upsert keeps the id-collision guard: a row at another worktree is left alone (the descriptor is still written);
        // a registration over its own id may move the worktree (`allowPathChange`)
        let guarded = |have: &str, incoming: &str| create || have == incoming || ident::realpath(have).is_some_and(|r| ident::realpath(incoming) == Some(r));
        match store.upsert_registry(&row, inv.now, guarded) {
            // the ensure's collision guard leaves a row at another worktree alone, as Node's ensure ignores the skip
            Ok(false) if create => failure = Some(defaults::render("devswarm_cli.msg_reg_upsert_skipped", &[("id", &quote(id))])),
            Ok(_) => {}
            Err(e) => failure = Some(e.to_string()),
        }
    }
    if failure.is_none() {
        if create && !declare.is_empty() {
            crate::discard::harmless(store.reader_cursor_txn(&declare)); // keep: Node's `catch (_) { /* fail-soft */ }`
        }
        if let Some(why) = crate::meshw::summary::derive_after_write(&store, inv, &owner_key) {
            crate::meshw::log_summary_failure(defaults::text("devswarm_cli.verb_register"), &why);
        }
    }
    // `retireWorktreeDuplicates`: another registry row of this physical worktree (a spawn's seed row, a legacy registration) is
    // folded into this id, its unread mail forwarded first; fail-open, as Node's catch is
    let dup = failure.is_none() && has_duplicate_rows(inv, &owner_key, id, wt_text.as_deref()).unwrap_or(false);
    if let Some(l) = lock.take() {
        l.release();
    }
    let retire = if dup { retire_duplicates(inv, id, wt_text.as_deref()) } else { None };
    if let Some(msg) = failure {
        return Ok(thrown(inv, op, Some(&owner_key), Some(id), &msg));
    }
    note_file(inv, &view::descriptor_rel(id));
    // the pre-created cursor and inbox are not noted for the witness: a descriptor names them by absolute path, which Node's scratch
    // home does not hold (the parity test compares them in the whole-home tree)
    wsverbs::note_summary(inv, &owner_key);
    let mut o = Obj::default();
    match primary {
        None => o.put("ok", OVal::Bool(true)).put("action", s(action)).put("id", s(id)).put("descriptor", out_desc),
        Some(wt) => o
            .put("ok", OVal::Bool(true))
            .put("action", s(defaults::text("devswarm_cli.action_register_primary")))
            .put("id", s(id))
            .put("workspaceId", s(id))
            .put("worktree", s(wt))
            .put("descriptor", out_desc),
    };
    if let Some(m) = rehomed.as_ref().filter(|m| m.rehomed) {
        let mut r = Obj::default();
        r.put("movedMessages", crate::meshw::common::n(m.moved_messages as f64)).put("movedRegistry", OVal::Bool(m.moved_registry));
        o.put("rehomed", r.done());
    }
    if let Some(r) = retire.as_ref().and_then(|v| OVal::parse(&v.to_string())) {
        let keys = defaults::list("devswarm_cli.reg_retire_fields");
        o.put(keys[0], r.get("retired").cloned().unwrap_or(OVal::Arr(Vec::new())));
        o.put(keys[1], r.get("forwarded").cloned().unwrap_or(OVal::Num(0.0)));
        if let Some(l) = r.get("left") {
            o.put(keys[2], l.clone());
        }
        if let Some(p) = r.get("pending") {
            o.put(keys[3], p.clone());
        }
    }
    if let Some(note) = archived_note {
        o.put("archivedNote", note);
    }
    Ok(answer(0, o.done()))
}

/// `retireWorktreeDuplicates(home, desc, ctx)` after a registration: fold every other registry row of the same physical worktree into
/// `id` (forwarding its unread mail first; a row with a descriptor of its own is left). `None` is Node's `null` (nothing to report,
/// or a step the engine could not do, which Node's catch also reports as `null`).
fn retire_duplicates(inv: &Inv, id: &str, worktree: Option<&str>) -> Option<serde_json::Value> {
    let wt = worktree.filter(|w| !w.is_empty())?;
    let st = inv.settings();
    // the plugin root of the context named Node's functions for the old witness; the native gate does not read it
    let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &inv.home, st: &st, now: inv.now, engine_pokes: false };
    let runner = crate::dsact::runner::System::configured();
    let hooks = crate::dssup::recon::Hooks { at: &|_| {} };
    let run = crate::dssup::recon::dup::retire_worktree_duplicates(&ctx, &runner, &inv.cwd, id, wt, &hooks).ok()?;
    let mut result = run.result?;
    // a unit the applier handed back (a busy lock, a drifted precondition) was not done: its row is pending, not retired
    let prefix = defaults::text("devswarm_recon.fold_unit_prefix");
    let pending: Vec<(String, String)> =
        run.deferred.iter().filter_map(|(label, why)| label.strip_prefix(prefix).map(|i| (i.to_string(), why.clone()))).collect();
    if !pending.is_empty() {
        if let Some(serde_json::Value::Array(r)) = result.get_mut("retired") {
            r.retain(|v| !pending.iter().any(|(i, _)| v.as_str() == Some(i.as_str())));
        }
        let list: Vec<serde_json::Value> = pending.iter().map(|(i, why)| serde_json::json!({"id": i, "reason": why})).collect();
        result["pending"] = serde_json::Value::Array(list);
    }
    Some(result)
}

/// `ensure <id> [--worktree P --session S --inbox P --cursor P]`.
pub fn ensure(inv: &Inv, a: &Args) -> R<Answer> {
    register_verb(inv, a, true)
}

/// `register <id> --worktree P --session S [--inbox P --cursor P --nudge CMD]`.
pub fn register(inv: &Inv, a: &Args) -> R<Answer> {
    register_verb(inv, a, false)
}

// ---- register-primary ---------------------------------------------------------------------------------------------------

/// `isChildWorkspaceCorroborated(env, home, cwd)`: the child-workspace variable is set AND the disk agrees (a registered descriptor
/// of the builder id, or the cwd under the DevSwarm worktree layout). Fail-open: any doubt reads as not corroborated.
fn child_workspace_corroborated(inv: &Inv) -> bool {
    let name = |k: &str| defaults::text(k);
    if !inv.env.get(name("devswarm_cli.regprim_child_env")).is_some_and(|v| !crate::checks::guardkit::text::js_trim(v).is_empty()) {
        return false;
    }
    // signal 1: a registered descriptor for the builder id (a descriptor this process cannot see counts: fail toward gating)
    if let Some(bid) = inv.env.get(name("devswarm_cli.regprim_builder_env"))
        && !crate::checks::guardkit::text::js_trim(bid).is_empty()
        && !bid.contains("..")
        && bid.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        let desc = idlock::devswarm_root(&inv.home).join(name("mesh_write.dir_workspaces")).join(format!("{bid}{}", name("mesh_write.json_suffix")));
        match std::fs::metadata(desc) {
            Ok(m) if m.is_file() => return true,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return true,
            _ => {}
        }
    }
    // signal 2: the cwd sits under the real DevSwarm worktree layout
    let cwd = if inv.cwd.is_empty() { return false } else { inv.cwd.as_str() };
    if !std::fs::metadata(cwd).is_ok_and(|m| m.is_dir()) {
        return false;
    }
    let repos = inv.home.join(name("devswarm_gates.cg_repos_dir"));
    let repos = repos.to_string_lossy().into_owned();
    let repos_real = ident::realpath(&repos).unwrap_or_else(|| ident::resolve_abs(&repos));
    let cwd_real = ident::realpath(cwd).unwrap_or_else(|| ident::resolve_abs(cwd));
    format!("{cwd_real}/").starts_with(&format!("{repos_real}/"))
}

/// `appSessionOnWorktree(home, env, session, worktree)`: `(verdict, terminalActive)` when the DevSwarm app database maps the session
/// to a terminal AND the session's own transcript records the cwd (`verdict` says whether that is `worktree`); anything unproven
/// is `None`.
fn app_session_terminal(inv: &Inv, session: &str, worktree: &str) -> Option<(bool, bool)> {
    use crate::dssup::appsync::snap;
    if session.is_empty() || worktree.is_empty() {
        return None;
    }
    let file = ident::app_db_path(&inv.home, &inv.env)?;
    let sn = snap::read(&file).ok().flatten()?;
    let (own, term) = sn.workspaces.iter().find_map(|w| w.terminals.iter().find(|t| t.session_id.as_deref() == Some(session)).map(|t| (w, t)))?;
    let own_wt = own.worktree_path.as_deref().filter(|w| !w.is_empty())?;
    let canon = |p: &str| ident::canonical_worktree_real_path(p).ok().flatten().unwrap_or_else(|| p.to_string());
    let (a, b) = (canon(own_wt), canon(worktree));
    let same = a == b;
    // Claude files the transcript under the cwd as launched: the app's own spelling, then the caller's (same) / the canonical one
    let spellings = [own.worktree_path_raw.clone(), same.then(|| worktree.to_string()), Some(if same { b } else { a })];
    for p in spellings.into_iter().flatten().filter(|p| !p.is_empty()) {
        if snap::transcript_cwd_matches(&inv.home, session, &p).ok().flatten() == Some(true) {
            return Some((same, term.is_active == Some(true)));
        }
    }
    None
}

/// `register-primary [--worktree P] [--session S] [--inbox P] [--cursor P] [--force]` (`cmdRegisterPrimary`): the Primary's own
/// descriptor under `primary-<hash of the worktree>`, written by the same code as `register`, the live-holder check and the write
/// under the Primary id's lock.
pub fn register_primary(inv: &Inv, a: &Args) -> R<Answer> {
    let name = |k: &str| defaults::text(k);
    let f = reg_flags(a);
    let force = a.has(name("devswarm_cli.flag_force"));
    let wt_flag = filled(&f.worktree).map(str::to_string);
    let worktree = match &wt_flag {
        Some(w) => w.clone(),
        None => match ident::resolve_caller_worktree(&inv.cwd)? {
            Some(w) => w,
            None => return Ok(fail_with(&[("error", s(name("devswarm_cli.msg_regprim_no_worktree")))])),
        },
    };
    let id = ident::primary_workspace_id(&worktree)?;
    if !force {
        let real = ident::resolve_caller_worktree(&worktree).ok().flatten();
        let builder = ident::builder_for_worktree(&inv.home, &inv.env, real.as_deref().unwrap_or(&worktree)).ok().flatten();
        let child_builder = builder.and_then(|b| b.builder_type).is_some_and(|t| !t.is_empty() && t != name("mesh_write.builder_type_primary"));
        // the child-environment corroboration is only asked without --worktree
        if child_builder || (wt_flag.is_none() && child_workspace_corroborated(inv)) {
            let msg = crate::meshw::extverbs::tpl("devswarm_cli.msg_regprim_child", &[("worktree", &quote(&worktree))]);
            return Ok(fail_with(&[
                ("reason", s(name("devswarm_cli.reason_not_primary_checkout"))),
                ("id", s(&id)),
                ("worktree", s(&worktree)),
                ("error", s(&msg)),
            ]));
        }
    }
    let session = filled(&f.session)
        .map(str::to_string)
        .or_else(|| inv.env.get(name("mesh_write.env_session_id")).filter(|v| !v.is_empty()).cloned())
        .or_else(|| inv.env.get(name("devswarm_cli.regprim_builder_env")).filter(|v| !v.is_empty()).cloned())
        .unwrap_or_else(|| id.clone());
    let cursor =
        filled(&f.cursor).map(str::to_string).unwrap_or_else(|| crate::meshw::cursors::primary_cursor_path(&inv.home, &id).to_string_lossy().into_owned());
    // the live-holder check and the write run under the Primary id's lock, so two sessions adopting at once serialize
    let Some(lock) = idlock::acquire(&inv.home, &id) else { return Ok(lock_busy(&id)) };
    if !force {
        // the registry row of the worktree's project; a project that cannot be named or read proves no conflict (fail-open)
        let rows = ident::repo_key_for_worktree(&worktree)
            .ok()
            .flatten()
            .and_then(|key| crate::meshw::tick::open_reader(inv, &key).ok().flatten())
            .and_then(|reader| reader.roster().ok())
            .map(|roster| ident::rows_of(&roster))
            .unwrap_or_default();
        if let Some(existing) = rows.iter().find(|r| r.id == id)
            && let Some(held) = existing.session_id.as_deref().filter(|x| !x.is_empty() && *x != session)
            && crate::dssup::liveness::session_alive(&inv.home, held).unwrap_or(false)
            // the app database may name the caller as the worktree's current AI terminal: then the caller IS the Primary
            && app_session_terminal(inv, &session, &worktree) != Some((true, true))
        {
            lock.release();
            let msg = crate::meshw::extverbs::tpl(
                "devswarm_cli.msg_regprim_conflict",
                &[("worktree", &quote(&worktree)), ("id", &quote(&id)), ("session", &quote(held))],
            );
            return Ok(fail_with(&[
                ("reason", s(name("devswarm_cli.reason_live_primary_conflict"))),
                ("error", s(&msg)),
                ("id", s(&id)),
                ("worktree", s(&worktree)),
                ("existingSessionId", s(held)),
            ]));
        }
    }
    let mut reg = Args { positionals: vec![name("devswarm_cli.verb_register").to_string(), id.clone()], ..Args::default() };
    let put = |reg: &mut Args, k: &str, v: String| {
        reg.flags.insert(name(k).to_string(), vec![crate::meshw::args::FlagVal::S(v)]);
    };
    put(&mut reg, "devswarm_cli.flag_worktree", worktree.clone());
    put(&mut reg, "devswarm_cli.flag_session", session);
    put(&mut reg, "devswarm_cli.flag_reg_cursor", cursor);
    if let Some(inbox) = &f.inbox {
        put(&mut reg, "devswarm_cli.flag_reg_inbox", inbox.clone());
    }
    register_core(inv, &reg, false, Some(&worktree), Some(lock))
}

/// `JSON.stringify(text)`.
fn quote(x: &str) -> String {
    serde_json::to_string(x).unwrap_or_default()
}

// ---- correct ------------------------------------------------------------------------------------------------------------

fn fail_with(fields: &[(&str, OVal)]) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    answer(2, o.done())
}

/// `Number(v)` of a parsed value for the shapes a plan file holds (an array or object, which JavaScript would stringify first,
/// reads as NaN here; no writer of the plan file produces one).
fn js_number(v: Option<&OVal>) -> f64 {
    match v {
        None => f64::NAN,
        Some(OVal::Null) => 0.0,
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Num(x)) => *x,
        Some(OVal::Str(t)) => crate::checks::guardkit::text::js_number_of_str(t),
        Some(_) => f64::NAN,
    }
}

/// `a >= b` between two parsed values: two strings compare as text, anything else as numbers.
fn js_ge(a: &OVal, b: &OVal) -> bool {
    match (a, b) {
        (OVal::Str(x), OVal::Str(y)) => x >= y,
        _ => js_number(Some(a)) >= js_number(Some(b)),
    }
}

/// `v + ''` for a value that may be missing (`undefined`).
fn js_concat(v: Option<&OVal>) -> String {
    v.map_or_else(|| defaults::text("devswarm_cli.js_undefined_text").to_string(), js_text)
}

/// The text of the TypeError JavaScript throws when a property is read off `null`.
fn null_property(prop: &str) -> String {
    defaults::render("devswarm_cli.msg_js_null_property", &[("prop", &prop)])
}

/// `planLib.currentStep(plan)`: the newest doing/blocked step, else the first open one. A step that is `null` makes JavaScript throw
/// on `.status`; that is the `Err`.
fn current_step(plan: &OVal) -> Result<Option<&OVal>, String> {
    let steps = crate::meshw::plan::steps_of(plan);
    let done = defaults::text("mesh_write.plan_status_done");
    let working = [defaults::text("mesh_write.plan_status_doing"), defaults::text("mesh_write.plan_status_blocked")];
    if steps.iter().any(|st| matches!(st, OVal::Null)) {
        return Err(null_property(defaults::text("devswarm_cli.js_prop_status")));
    }
    let open: Vec<&OVal> = steps.iter().filter(|st| !crate::meshw::plan::status_is(st, done)).collect();
    let ts = |st: &OVal| -> OVal {
        match st.get("ts") {
            Some(v) if v.truthy() => v.clone(),
            _ => OVal::Num(0.0),
        }
    };
    let mut best: Option<&OVal> = None;
    for st in &open {
        if !working.iter().any(|w| crate::meshw::plan::status_is(st, w)) {
            continue;
        }
        if best.is_none_or(|b| js_ge(&ts(st), &ts(b))) {
            best = Some(st);
        }
    }
    Ok(best.or_else(|| open.first().copied()))
}

/// `devswarm-plan.js` `readStray(home, key)`: the stray-state file, parsed; any failure is none.
fn read_stray(inv: &Inv, key: &str) -> Option<OVal> {
    let p = idlock::devswarm_root(&inv.home).join(defaults::text("devswarm_cli.dir_stray")).join(format!("{key}{}", defaults::text("mesh_write.json_suffix")));
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))
}

/// `stray.active` when it is an array (none otherwise); an entry that is `null` makes JavaScript throw on the first property it reads.
fn stray_active<'a>(stray: Option<&'a OVal>, prop: &str) -> Result<Vec<&'a OVal>, String> {
    match stray.and_then(|s| s.get("active")) {
        Some(OVal::Arr(v)) => {
            if v.iter().any(|a| matches!(a, OVal::Null)) {
                return Err(null_property(prop));
            }
            Ok(v.iter().collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// `sup.correctionText(id, plan, stray, now)`.
fn correction_text(id: &str, plan: &OVal, stray: Option<&OVal>, now: f64) -> Result<String, String> {
    let cur = current_step(plan)?;
    let (n, text) = match cur {
        Some(st) => (js_concat(st.get("n")), js_concat(st.get("text"))),
        None => (crate::meshw::plan::steps_of(plan).len().to_string(), defaults::text("devswarm_cli.corr_final_report").to_string()),
    };
    let mut reasons: Vec<String> = Vec::new();
    for a in stray_active(stray, defaults::text("devswarm_cli.js_prop_reason"))? {
        if let Some(r) = a.get("reason").filter(|r| r.truthy()) {
            reasons.push(js_text(r));
        }
    }
    if reasons.is_empty() {
        let since = match plan.get("step_ts") {
            Some(OVal::Num(x)) if x.is_finite() => *x,
            _ => js_number(plan.get("created_at")),
        };
        reasons.push(crate::meshw::extverbs::tpl("devswarm_cli.corr_no_progress", &[("d", &crate::meshw::plan::dur(now - since))]));
    }
    Ok(crate::meshw::extverbs::tpl(
        "devswarm_cli.corr_text",
        &[("n", &n), ("text", &text), ("reasons", &reasons.join(defaults::text("devswarm_cli.corr_reason_join"))), ("id", id)],
    ))
}

/// `delete obj[key]` on an object (an assignment of `undefined` serializes as no key at all).
fn unset(o: &mut OVal, key: &str) {
    if let OVal::Obj(v) = o {
        v.retain(|(k, _)| k != key);
    }
}

/// `correct <id> [--dry-run]`: the Primary's correction for a straying child (`cmdCorrect`).
pub fn correct(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let action = s(defaults::text("devswarm_cli.action_correct"));
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(fail_with(&[("action", action), ("error", s(defaults::text("devswarm_cli.msg_corr_usage")))]));
    }
    let id = match crate::meshw::actverbs::resolve_target_id(inv, id, defaults::text("devswarm_cli.action_correct"))? {
        Ok(x) => x,
        Err(refused) => return Ok(refused),
    };
    let id = id.as_str();
    let op = defaults::text("devswarm_cli.action_correct");
    let now = inv.now as f64;
    let found = crate::meshw::plan::find(inv, id)?;
    let Some(found) = found.filter(|f| !crate::meshw::plan::steps_of(&f.plan).is_empty()) else {
        return Ok(fail_with(&[
            ("action", action),
            ("id", s(id)),
            ("reason", s(defaults::text("devswarm_cli.corr_reason_no_plan"))),
            ("error", s(&crate::meshw::extverbs::tpl("devswarm_cli.msg_corr_no_plan", &[("id", id)]))),
        ]));
    };
    let stray = read_stray(inv, &found.key);
    let message = match correction_text(id, &found.plan, stray.as_ref(), now) {
        Ok(m) => m,
        Err(why) => return Ok(thrown(inv, op, None, Some(id), &why)),
    };
    if a.has(defaults::text("devswarm_cli.flag_dry_run")) {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true)).put("action", action).put("id", s(id)).put("dryRun", OVal::Bool(true)).put("message", s(&message));
        return Ok(answer(0, o.done()));
    }
    // the plan's record of the correction: the signals the supervisor had flagged and the Jev notes the Primary saw (JavaScript's
    // `undefined` is an absent key or a `null` array member)
    let active = match stray_active(stray.as_ref(), defaults::text("devswarm_cli.js_prop_signal")) {
        Ok(v) => v,
        Err(why) => return Ok(thrown(inv, op, None, Some(id), &why)),
    };
    let mut all_signals: Vec<OVal> = Vec::new();
    let mut signals: Vec<OVal> = Vec::new();
    let mut warned_jev: Vec<OVal> = Vec::new();
    for e in &active {
        let sig = e.get("signal").cloned().unwrap_or(OVal::Null);
        if !signals.contains(&sig) {
            signals.push(sig.clone());
        }
        all_signals.push(sig);
        if let Some(OVal::Arr(notes)) = e.get("jev") {
            for note in notes {
                if matches!(note, OVal::Null) {
                    return Ok(thrown(inv, op, None, Some(id), &null_property(defaults::text("devswarm_cli.js_prop_integration"))));
                }
                let mut o = Obj::default();
                if let Some(i) = note.get("integration") {
                    o.put("integration", i.clone());
                }
                o.put("supports", OVal::Bool(matches!(note.get("supports"), Some(OVal::Bool(true)))));
                warned_jev.push(o.done());
            }
        }
    }
    // the message goes out through the native send, as Node's nested `run(['send', '--to', id, '--message-file', f])`
    let mut send_args = Args { positionals: vec![defaults::text("mesh_write.verb_send").to_string()], ..Args::default() };
    send_args.flags.insert(defaults::text("mesh_write.flag_to").to_string(), vec![crate::meshw::args::FlagVal::S(id.to_string())]);
    send_args.flags.insert(defaults::text("mesh_write.flag_message").to_string(), vec![crate::meshw::args::FlagVal::S(message.clone())]);
    let sent = crate::meshw::send::run(inv, &send_args)?;
    let sent_result = OVal::parse(sent.stdout.trim_end()).unwrap_or(OVal::Null);
    let effect = sent.effect.clone();
    let reply = |o: Obj| Answer {
        code: if sent.code == 0 && matches!(o.0.iter().find(|(k, _)| k == "ok"), Some((_, OVal::Bool(true)))) { 0 } else { 2 },
        stdout: format!("{}\n", o.done().stringify()),
        effect: effect.clone(),
    };
    if sent.code != 0 {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("action", action)
            .put("id", s(id))
            .put("message", s(&message))
            .put("sent", sent_result)
            .put("error", s(defaults::text("devswarm_cli.msg_corr_send_failed")));
        return Ok(reply(o));
    }
    let warned = crate::meshw::plan::update_with(inv, &found.key, |cur| {
        let Some(mut plan) = cur else { return Ok((None, None)) };
        // the step the correction names is the current one of the fresh plan on disk
        let step_n: Option<OVal> = match current_step(&plan) {
            Ok(Some(st)) => st.get("n").cloned(),
            _ => Some(OVal::Null),
        };
        plan.set("warned_at", crate::meshw::common::n(now));
        match &step_n {
            Some(n) => plan.set("warned_step", n.clone()),
            None => unset(&mut plan, "warned_step"),
        }
        plan.set("warned_signals", OVal::Arr(signals.clone()));
        plan.set("warned_jev", OVal::Arr(warned_jev.clone()));
        Ok((Some(step_n), Some(plan)))
    })?;
    let mut step_n: Option<OVal> = Some(OVal::Null);
    let recorded = match warned {
        Some((Some(n), Some(text))) => {
            crate::meshw::note_written(&crate::meshw::plan::plan_rel(&found.key), text.as_bytes());
            step_n = n;
            true
        }
        _ => false,
    };
    if !recorded {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("action", action)
            .put("id", s(id))
            .put("message", s(&message))
            .put("sent", sent_result)
            .put("error", s(defaults::text("devswarm_cli.msg_corr_not_recorded")));
        return Ok(reply(o));
    }
    let mut fields = vec![("id".to_string(), s(id)), ("key".to_string(), s(&found.key))];
    if let Some(n) = &step_n {
        fields.push(("step".to_string(), n.clone()));
    }
    fields.push(("signals".to_string(), OVal::Arr(all_signals)));
    fields.push(("jev".to_string(), OVal::Arr(warned_jev)));
    if crate::meshw::plan::record(inv, defaults::text("devswarm_cli.corr_event"), &fields, now).is_some() {
        crate::meshw::plan::note_log(inv);
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", action).put("id", s(id)).put("message", s(&message)).put("warned_at", crate::meshw::common::n(now));
    if let Some(n) = &step_n {
        o.put("step", n.clone());
    }
    o.put("sent", sent_result);
    Ok(reply(o))
}

// ---- reap-orphans -------------------------------------------------------------------------------------------------------

/// The refusal / result object of `reap-orphans` with `ok` and `action` first.
fn reap_result(ok: bool, fields: &[(&str, OVal)]) -> Obj {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(ok)).put("action", s(defaults::text("devswarm_cli.action_reap_orphans")));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    o
}

/// `reap-orphans [--apply --max N] [--i-am-a-human]`: the engine answers the cases that need no orphan classification: no
/// project, every refusal of the apply path, and a project with no partition holding unread mail with no live reader (the
/// summary defers, nothing written, the moment one exists: classifying it and retiring it stay Node's).
pub fn reap_orphans(inv: &Inv, a: &Args) -> R<Answer> {
    let apply = a.has(defaults::text("devswarm_cli.flag_apply"));
    let Some(repo_key) = repo_key_for_cwd(inv) else {
        let o = reap_result(
            false,
            &[("reason", s(defaults::text("devswarm_cli.reap_reason_no_project"))), ("error", s(defaults::text("devswarm_cli.msg_reap_no_project")))],
        );
        return Ok(answer(2, o.done()));
    };
    // collectOrphanCandidates opens the project's store (Node creates a missing one) and reads its summary
    let _reader = crate::meshw::tick::open_reader_creating(inv, &repo_key)?;
    let store = common::open_store(inv, &repo_key)?;
    let refuse = |reason: &str, error: String| -> Answer { answer(2, reap_result(false, &[("reason", s(reason)), ("error", s(&error))]).done()) };
    let max_n = if apply {
        let flag = defaults::text("devswarm_cli.flag_max");
        let raw = a.one(flag);
        let Some(raw) = raw else {
            return Ok(refuse(defaults::text("devswarm_cli.reap_reason_max_required"), defaults::text("devswarm_cli.msg_reap_max_required").to_string()));
        };
        let n = crate::checks::guardkit::text::js_number_of_str(raw);
        if !n.is_finite() || n < 1.0 || n.floor() != n {
            return Ok(refuse(
                defaults::text("devswarm_cli.reap_reason_bad_max"),
                crate::meshw::extverbs::tpl("devswarm_cli.msg_reap_bad_max", &[("got", &serde_json::to_string(raw).unwrap_or_default())]),
            ));
        }
        if inv.env.get(defaults::text("devswarm_cli.reap_automation_env")).map(String::as_str) == Some(defaults::text("devswarm_cli.reap_automation_value")) {
            return Ok(refuse(defaults::text("devswarm_cli.reap_reason_automation"), defaults::text("devswarm_cli.msg_reap_automation").to_string()));
        }
        // SAFETY: isatty only reads the descriptor's mode.
        let tty = unsafe { libc::isatty(0) } == 1;
        if !tty && !a.has(defaults::text("devswarm_cli.flag_human")) {
            return Ok(refuse(defaults::text("devswarm_cli.reap_reason_non_interactive"), defaults::text("devswarm_cli.msg_reap_non_interactive").to_string()));
        }
        Some(n)
    } else {
        None
    };
    // the candidates are the summary's orphans[] (partitions with unread mail and no live reader), the very set the per-turn warning lists
    let sum = crate::meshw::summary::compute(&store, inv, None)?;
    let candidates = candidates_of(&store, &sum);
    let n_ = crate::meshw::common::n;
    let reaped_dir = idlock::devswarm_root(&inv.home).join(defaults::text("devswarm_cli.reap_dir"));
    let dir_text = reaped_dir.to_string_lossy().into_owned();
    let o = match max_n {
        None => {
            let note = if candidates.is_empty() {
                defaults::text("devswarm_cli.msg_reap_none").to_string()
            } else {
                crate::meshw::extverbs::tpl("devswarm_cli.msg_reap_dry_run", &[("dir", &dir_text)])
            };
            reap_result(
                true,
                &[
                    ("mode", s(defaults::text("devswarm_cli.reap_mode_dry_run"))),
                    ("repoKey", s(&repo_key)),
                    ("candidateCount", n_(candidates.len() as f64)),
                    ("candidates", OVal::Arr(candidates.iter().map(Candidate::to_oval).collect())),
                    ("note", s(&note)),
                ],
            )
        }
        Some(max) => {
            let take = if max >= candidates.len() as f64 { candidates.len() } else { max as usize };
            let targets = &candidates[..take];
            let (mut reaped, mut failed) = (Vec::new(), Vec::new());
            for c in targets {
                match retire(&store, inv, &repo_key, &reaped_dir, c)? {
                    Ok(r) => reaped.push(r),
                    Err(f) => failed.push(f),
                }
            }
            if !reaped.is_empty()
                && let Some(why) = crate::meshw::summary::derive_after_write(&store, inv, &repo_key)
            {
                crate::meshw::log_summary_failure(defaults::text("devswarm_cli.verb_reap_orphans"), &why);
            }
            reap_result(
                true,
                &[
                    ("mode", s(defaults::text("devswarm_cli.reap_mode_apply"))),
                    ("repoKey", s(&repo_key)),
                    ("max", n_(max)),
                    ("candidateCount", n_(candidates.len() as f64)),
                    ("consideredCount", n_(targets.len() as f64)),
                    ("reapedCount", n_(reaped.len() as f64)),
                    ("reaped", OVal::Arr(reaped.clone())),
                    ("failedCount", n_(failed.len() as f64)),
                    ("failed", OVal::Arr(failed.clone())),
                    ("capped", OVal::Bool(candidates.len() > targets.len())),
                    ("remaining", n_((candidates.len() - targets.len()) as f64)),
                    ("note", s(&crate::meshw::extverbs::tpl("devswarm_cli.msg_reap_applied", &[("dir", &dir_text)]))),
                ],
            )
        }
    };
    Ok(answer(0, o.done()))
}

/// One candidate of `collectOrphanCandidates`.
struct Candidate {
    id: String,
    unread: f64,
    message_count: f64,
    last_ts: Option<f64>,
}

impl Candidate {
    fn to_oval(&self) -> OVal {
        let n_ = crate::meshw::common::n;
        let mut o = Obj::default();
        o.put("partitionId", s(&self.id))
            .put("unread", n_(self.unread))
            .put("messageCount", n_(self.message_count))
            .put("lastMessageTs", self.last_ts.map_or(OVal::Null, n_))
            .put("reason", s(defaults::text("devswarm_cli.reap_reason_unread")));
        o.done()
    }
}

/// `collectOrphanCandidates`: the summary's `orphans[]` entries with a safe id, each with the newest message ts in its partition.
fn candidates_of(store: &crate::meshw::store::MeshStore, sum: &OVal) -> Vec<Candidate> {
    let Some(OVal::Arr(list)) = sum.get("orphans") else { return Vec::new() };
    let num = |v: Option<&OVal>| match v {
        Some(OVal::Num(x)) if x.is_finite() => *x,
        _ => 0.0,
    };
    let mut out = Vec::new();
    for e in list {
        let Some(OVal::Str(id)) = e.get("id") else { continue };
        if !is_safe_id(id) {
            continue;
        }
        let mut last: Option<f64> = None;
        // keep: a partition that cannot be read to the end reports the newest ts seen so far (Node's listMessages reads what the store gives)
        crate::discard::harmless(store.reader().for_each_message(id, 0, |m| {
            if let Some(t) = m["ts"].as_f64().filter(|t| t.is_finite())
                && last.is_none_or(|l| t > l)
            {
                last = Some(t);
            }
            true
        }));
        out.push(Candidate { id: id.clone(), unread: num(e.get("unread")), message_count: num(e.get("messageCount")), last_ts: last });
    }
    out
}

/// Node's message row as `JSON.stringify` writes it (the key order of `listMessages`).
fn row_oval(m: &serde_json::Value) -> OVal {
    let conv = |v: &serde_json::Value| match v {
        serde_json::Value::Null => OVal::Null,
        serde_json::Value::Bool(b) => OVal::Bool(*b),
        serde_json::Value::Number(x) => crate::meshw::common::n(x.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(t) => s(t),
        _ => OVal::Null,
    };
    let keys = defaults::list("devswarm_cli.reap_row_keys");
    OVal::Obj(keys.iter().map(|k| (k.to_string(), conv(&m[*k]))).collect())
}

/// Archive, verify, then retire one partition (`cmdReapOrphans`' loop body). The inner `Err` is the `failed[]` entry.
fn retire(store: &crate::meshw::store::MeshStore, inv: &Inv, repo_key: &str, reaped_dir: &std::path::Path, c: &Candidate) -> R<Result<OVal, OVal>> {
    let n_ = crate::meshw::common::n;
    let fail = |reason: &str, extra: Vec<(&str, OVal)>| -> OVal {
        let mut o = Obj::default();
        o.put("partitionId", s(&c.id)).put("reason", s(reason));
        for (k, v) in extra {
            o.put(k, v);
        }
        o.done()
    };
    let pid = c.id.as_str();
    let cursor = crate::meshw::summary::store_floor(store, &inv.home, pid);
    let total = match store.reader().message_count(pid) {
        Ok(t) => t as f64,
        Err(e) => return Ok(Err(fail(defaults::text("devswarm_cli.reap_reason_error"), vec![("error", s(&e.to_string()))]))),
    };
    let mut unread: Vec<serde_json::Value> = Vec::new();
    let since = if cursor.is_finite() && cursor > 0.0 { cursor.floor() as u64 } else { 0 };
    if let Err(e) = store.reader().for_each_message(pid, since, |m| {
        unread.push(m);
        true
    }) {
        return Ok(Err(fail(defaults::text("devswarm_cli.reap_reason_error"), vec![("error", s(&e.to_string()))])));
    }
    if unread.is_empty() {
        return Ok(Err(fail(defaults::text("devswarm_cli.reap_reason_no_unread"), vec![])));
    }
    let at = crate::checks::jsport::date::to_iso(common::now_ms() as f64).unwrap_or_default();
    let mut payload = String::new();
    for m in &unread {
        let mut line = Obj::default();
        line.put("partitionId", s(pid)).put("reapedAt", s(&at)).put("message", row_oval(m));
        payload.push_str(&line.done().stringify());
        payload.push('\n');
    }
    let archive = reaped_dir.join(format!("{pid}{}", defaults::text("devswarm_cli.reap_archive_suffix")));
    let written = std::fs::create_dir_all(reaped_dir).and_then(|()| std::fs::write(&archive, &payload)).and_then(|()| std::fs::read_to_string(&archive));
    let read_back = match written {
        Ok(t) => t,
        Err(e) => return Ok(Err(fail(defaults::text("devswarm_cli.reap_reason_error"), vec![("error", s(&e.to_string()))]))),
    };
    let landed: Vec<&str> = read_back.split('\n').filter(|l| !l.trim().is_empty()).collect();
    if landed.len() != unread.len() {
        return Ok(Err(fail(
            defaults::text("devswarm_cli.reap_reason_verify_failed"),
            vec![("expected", n_(unread.len() as f64)), ("got", n_(landed.len() as f64))],
        )));
    }
    if landed.iter().any(|l| OVal::parse(l).is_none()) {
        return Ok(Err(fail(defaults::text("devswarm_cli.reap_reason_unparseable"), vec![])));
    }
    // raiseAllLossFree: every row of the store namespace (the floor included) rises to the count, a retired row's line with it; the
    // legacy cursors are imported first when the partition has no floor row yet
    let ns = defaults::text("mesh_write.ns_store");
    let handle = Handle::Rw(common::open_store(inv, repo_key)?);
    let mut cx = Cx::new(&inv.home.to_string_lossy());
    cx.now = inv.now;
    let raised = raise_all_loss_free(&mut cx, &handle, pid, ns, total as i64);
    // the reader cursors of this partition cannot be settled this pass (its legacy positions cannot be classified): nothing was
    // written to the cursors, the archive above is only a copy, and the partition stays an orphan for the next pass
    if cx.deferred {
        crate::discard::note("reap_orphans_cursor_import", defaults::text("devswarm_cli.msg_reap_cursor_import"));
        return Ok(Err(fail(defaults::text("devswarm_cli.reap_reason_error"), vec![("error", s(defaults::text("devswarm_cli.msg_reap_cursor_import")))])));
    }
    if let Err(e) = raised {
        return Ok(Err(fail(defaults::text("devswarm_cli.reap_reason_error"), vec![("error", s(&e))])));
    }
    cursors::log_cursor_write(
        &inv.home,
        &cursors::LogRec {
            id: pid,
            caller_id: None,
            ns: defaults::text("mesh_write.log_ns_store"),
            from: Some(cursor as i64),
            to: Some(total),
            delivered: None,
            nonce: None,
            gate: defaults::text("devswarm_cli.reap_log_gate"),
            verb: defaults::text("devswarm_cli.verb_reap_orphans"),
            cwd: None,
            ok: true,
            err: None,
            repo_key: Some(repo_key),
        },
    );
    let mut o = Obj::default();
    o.put("partitionId", s(pid)).put("unread", n_(unread.len() as f64)).put("archivePath", s(&archive.to_string_lossy())).put("cursorAdvancedTo", n_(total));
    Ok(Ok(o.done()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)] // tests: a panic is the failure report
    use super::*;
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-lifeverbs-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn inv(home: &Path) -> Inv {
        Inv {
            home: home.to_path_buf(),
            write_home: home.to_path_buf(),
            // the log goes to the scratch home, never to the machine's
            env: HashMap::from([(defaults::text("devswarm_cli.env_log_dir").to_string(), home.join("logs").to_string_lossy().into_owned())]),
            cwd: "/".into(),
            now: 1_795_000_000_000,
            stdin: None,
            store_override: None,
        }
    }

    fn argv(words: &[&str]) -> Args {
        crate::meshw::args::parse(&words.iter().map(|w| (*w).to_string()).collect::<Vec<_>>())
    }

    fn put(home: &Path, rel: &str, text: &str) {
        let p = home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn json(a: &Answer) -> OVal {
        OVal::parse(a.stdout.trim_end()).expect("the answer is JSON")
    }

    // ---- lock busy: every verb that takes the id's lock answers the way Node's withIdLock does ----

    #[test]
    fn a_busy_lock_is_answered_natively_by_unarchive_ensure_and_register_primary() {
        let home = scratch("busy");
        let held = idlock::acquire(&home, "w-busy").expect("the lock is free");
        // unarchive resolves the id from the caller's checkout
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        assert!(std::process::Command::new("git").args(["init", "-q"]).arg(&repo).status().unwrap().success());
        let mut i = inv(&home);
        i.cwd = repo.to_string_lossy().into_owned();
        for words in [&["unarchive", "w-busy"][..], &["ensure", "w-busy", "--worktree", "/x/y", "--session", "s"]] {
            let a = if words[0] == "unarchive" { unarchive(&i, &argv(words)) } else { ensure(&i, &argv(words)) }.expect("answered, not handed off");
            assert_eq!(a.code, 2, "{words:?}");
            let j = json(&a);
            assert_eq!(j.get("lockBusy"), Some(&OVal::Bool(true)), "{words:?}");
            assert_eq!(j.get("id"), Some(&s("w-busy")));
        }
        held.release();
        // register-primary takes the Primary id's lock after its checks
        let wt = home.join("wt-primary");
        std::fs::create_dir_all(&wt).unwrap();
        let wt = wt.to_string_lossy().into_owned();
        let pid = ident::primary_workspace_id(&wt).expect("an id");
        let held = idlock::acquire(&home, &pid).expect("the lock is free");
        let a = register_primary(&i, &argv(&["register-primary", "--worktree", &wt, "--force"])).expect("answered, not handed off");
        assert_eq!(a.code, 2);
        assert_eq!(json(&a).get("lockBusy"), Some(&OVal::Bool(true)));
        held.release();
    }

    // ---- migrate-owner-keys: the shapes that used to be Node's ----

    #[test]
    fn migrate_owner_keys_answers_duplicate_ids_foreign_file_names_and_odd_fields_natively() {
        let home = scratch("migrate");
        let ws = ".anti-hall/devswarm/workspaces";
        // an own `__proto__` key survives the backfill, as JSON.stringify writes it
        put(&home, &format!("{ws}/a.json"), r#"{"id":"a","worktreePath":"/nonexistent/wt-a","__proto__":{"x":1}}"#);
        // a file whose name is not its id: Node reads workspaces/b.json, which is absent, so it changes nothing
        put(&home, &format!("{ws}/b-copy.json"), r#"{"id":"b","worktreePath":5}"#);
        // the same id again under another name: the first one seen wins
        put(&home, &format!("{ws}/dup.json"), r#"{"id":"a","worktreePath":"/other"}"#);
        // an id of the wrong type is not the migration's
        put(&home, &format!("{ws}/c.json"), r#"{"id":7,"worktreePath":"/x"}"#);
        let a = migrate_owner_keys(&inv(&home), &Args::default()).expect("answered, not handed off");
        assert_eq!(a.code, 0, "{}", a.stdout);
        let j = json(&a);
        assert_eq!(j.get("scanned"), Some(&OVal::Num(2.0)));
        assert_eq!(j.get("backfilled"), Some(&OVal::Num(1.0)));
        assert_eq!(j.get("errors"), Some(&OVal::Num(0.0)));
        let written = std::fs::read_to_string(home.join(format!("{ws}/a.json"))).unwrap();
        let d = OVal::parse(&written).unwrap();
        assert_eq!(d.get("ownerKey"), Some(&s(&crate::meshw::send::hash_from_workspace_id("a"))));
        assert!(written.contains("__proto__"), "{written}");
    }

    // ---- ensure / register: the refusals Node prints ----

    #[test]
    fn register_refusals_are_answered_and_logged_natively() {
        let home = scratch("refusals");
        let i = inv(&home);
        // a reserved token in a fresh id
        let a = ensure(&i, &argv(&["ensure", "w.seen-1", "--worktree", "/x/y", "--session", "s"])).expect("answered");
        assert_eq!(a.code, 2);
        assert_eq!(json(&a).get("reason"), Some(&s("reserved-id-token")));
        // a registration without a session
        let a = register(&i, &argv(&["register", "w-new", "--worktree", "/x/y"])).expect("answered");
        assert_eq!(a.code, 2);
        let j = json(&a);
        assert!(matches!(j.get("error"), Some(OVal::Str(e)) if e.starts_with("register requires --session")), "{}", a.stdout);
        // an auto-ensure of a workspace that is archived
        put(&home, ".anti-hall/devswarm/archived/w-old.json", r#"{"id":"w-old","worktreePath":"/x/old"}"#);
        let a = ensure(&i, &argv(&["ensure", "w-old", "--worktree", "/x/old", "--session", "s"])).expect("answered");
        assert_eq!(a.code, 2);
        assert_eq!(json(&a).get("action"), Some(&s("archived-skip")));
        // every one of them is in the central log
        let log = std::fs::read_to_string(home.join("logs").join(defaults::text("devswarm_cli.log_file"))).unwrap();
        assert_eq!(log.lines().count(), 3, "{log}");
    }

    #[test]
    fn a_retired_worktree_label_is_refused_natively_with_the_action_first() {
        let home = scratch("label");
        put(&home, ".anti-hall/devswarm/retired/primary-0123abcd.json", r#"{"retiredTo":"w-child"}"#);
        let a = ensure(&inv(&home), &argv(&["ensure", "primary-0123abcd"])).expect("answered");
        assert_eq!(a.code, 2);
        assert!(a.stdout.starts_with(r#"{"action":"ensure","ok":false,"reason":"child-label-id""#), "{}", a.stdout);
        assert_eq!(json(&a).get("resolvedTo"), Some(&s("w-child")));
    }

    #[test]
    fn an_empty_flag_value_is_a_value_not_a_hand_off() {
        let home = scratch("emptyflag");
        let i = inv(&home);
        let a = register(&i, &argv(&["register", "w-empty", "--worktree=", "--session=s"])).expect("answered");
        assert_eq!(a.code, 2);
        assert!(json(&a).get("error").is_some_and(|e| matches!(e, OVal::Str(t) if t.starts_with("register requires --worktree"))), "{}", a.stdout);
    }

    // ---- correct: the plan and stray-state shapes that used to be Node's ----

    #[test]
    fn the_correction_text_reads_odd_plan_and_stray_shapes_the_way_javascript_does() {
        let plan =
            OVal::parse(r#"{"steps":[{"n":"2","text":"x","status":"doing","ts":"9"},{"text":"y","status":"doing","ts":10}],"created_at":"1000"}"#).unwrap();
        // the newer step (ts 10 >= "9" as numbers) has no `n`: JavaScript prints `undefined`
        let stray = OVal::parse(r#"{"active":[{"reason":"idle"},{"reason":0},{"reason":"off scope"}]}"#).unwrap();
        let t = correction_text("w1", &plan, Some(&stray), 5000.0).unwrap();
        assert!(t.starts_with("step undefined 'y': idle / off scope."), "{t}");
        // no reasons: the age comes from `created_at`, a numeric string
        let t = correction_text("w1", &plan, None, 61_000.0 + 1000.0).unwrap();
        assert!(t.contains("no progress"), "{t}");
        // a `null` entry makes JavaScript throw on `.reason`: that message is the answer
        let bad = OVal::parse(r#"{"active":[null]}"#).unwrap();
        let e = correction_text("w1", &plan, Some(&bad), 0.0).unwrap_err();
        assert_eq!(e, "Cannot read properties of null (reading 'reason')");
    }
}
