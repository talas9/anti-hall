//! The DevSwarm CLI verbs of lane l8h that move a workspace between its lifecycle states: `unarchive` first, then the verbs
//! of the later commits of the lane (see the module list in `extverbs`).
//!
//! The rules are those of the other store verbs ([`crate::meshw::actverbs`]): the engine answers what it can reproduce byte for
//! byte, decides every deferral BEFORE the first write (exit 75, nothing written, Node then runs the verb), and after the first
//! write nothing defers any more (`mark_committed`: a late failure exits 70 and Node never repeats the write).
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
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{self, is_safe_id};
use crate::meshw::send::{Answer, Effect};
use crate::meshw::wsverbs;

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

/// `{ ok: false, error }` the way the dispatcher refuses a missing or unsafe id.
fn bad_id() -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(defaults::text("devswarm_cli.msg_bad_id")));
    answer(2, o.done())
}

/// `storeOwnerKeyFor(id, ctx)`: the project's key for the caller's cwd, else the id's own legacy hash bucket.
fn store_owner_key(inv: &Inv, id: &str) -> R<String> {
    Ok(match ident::resolve_context(&inv.cwd, true)?.repo_key {
        Some(k) => k,
        None => crate::meshw::send::hash_from_workspace_id(id),
    })
}

/// Apply a planned job's units to the real home, in order, the caller holding each unit's lock. A unit handed back (lock busy, drifted precondition) before any
/// write defers the verb; a unit that fails after its first step landed is a committed failure.
fn apply_units(inv: &Inv, units: &[crate::dssup::recon::Unit]) -> R<()> {
    let st = inv.settings();
    let env = apply::Env { home: &inv.home, now: inv.now, st: &st, log_dir: None };
    for (i, u) in units.iter().enumerate() {
        // the caller holds the workspace's lock
        let unlocked = crate::dssup::recon::Unit { label: u.label.clone(), lock: None, ops: u.ops.clone() };
        match apply::unit(&env, &unlocked, &Hooks::none()) {
            UnitEnd::Applied => crate::meshw::mark_committed(),
            UnitEnd::Deferred(why) if i == 0 => return defer(&why),
            UnitEnd::Deferred(why) | UnitEnd::Failed(why) => return defer(&format!("committed:{why}")),
        }
    }
    Ok(())
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
    let id = match resolve_archive_id(inv, raw)? {
        Resolved::Id(x) => x,
        Resolved::Ambiguous(tpl, ids) => return Ok(Resolved::refusal(defaults::text("devswarm_cli.action_unarchive"), true, raw, tpl, &ids)),
    };
    let owner = store_owner_key(inv, &id)?;
    // every deferral is decided before the lock directory is touched (a deferral writes nothing); the plan that counts is the
    // one read under `withIdLock(id)`, and the units then run without taking the lock again
    let opts = RestoreOpts { keep_marker: false, require_owner_key: Some(owner.clone()) };
    restore_archived_descriptor(&inv.home, &id, &opts)?;
    let Some(lock) = idlock::acquire(&inv.home, &id) else { return defer("lock-busy") };
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
        let applied = apply_units(inv, &plan.job.units);
        lock.release();
        applied?;
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
    /// Nothing: it has an owner key, or it is not the engine's to look at.
    Nothing,
    /// The descriptor with its missing `ownerKey` (and `repoKey`) backfilled.
    Backfill(OVal),
    /// An active descriptor stranded in the legacy hash bucket of a project that now resolves: `rehomeCore` moves the registry
    /// row and the messages, which only Node does.
    Rehome,
}

/// One descriptor the migration looks at.
struct Item {
    archived: bool,
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
fn migration_fix(desc: &OVal, archived: bool, id: &str) -> R<Fix> {
    let wt = match desc.get("worktreePath") {
        Some(OVal::Str(w)) if !w.is_empty() => w.as_str(),
        _ => return defer("worktree-shape"),
    };
    let hash = crate::meshw::send::hash_from_workspace_id(id);
    let fresh = ident::repo_key_for_worktree(wt)?;
    let stored = nonempty_str(desc.get("ownerKey"));
    if !archived && stored == Some(hash.as_str()) && fresh.as_deref().is_some_and(|f| f != hash) {
        return Ok(Fix::Rehome);
    }
    if stored.is_some() {
        return Ok(Fix::Nothing);
    }
    // descriptorStructuralRepoKey: a persisted repoKey, else the key the worktree resolves to
    let resolved = fresh.clone().or_else(|| nonempty_str(desc.get("repoKey")).map(str::to_string)).unwrap_or(hash);
    let mut out = desc.clone();
    out.set("ownerKey", s_val(&resolved));
    if fresh.as_deref() == Some(resolved.as_str()) {
        out.set("repoKey", s_val(&resolved));
    }
    Ok(Fix::Backfill(out))
}

fn s_val(x: &str) -> OVal {
    OVal::Str(x.to_string())
}

/// The descriptors `migrateOwnerKeys` considers, in Node's scan order (active, then archived), one per id. A shape whose outcome
/// depends on the directory's listing order or on a file name that is not the descriptor's id is Node's.
fn migration_items(inv: &Inv) -> R<Vec<Item>> {
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
            if matches!(&desc, OVal::Obj(f) if f.iter().any(|(k, _)| k == "__proto__")) {
                return defer("descriptor-keys");
            }
            let id = match desc.get("id") {
                Some(OVal::Str(i)) => i.clone(),
                Some(OVal::Null) | None => continue,
                Some(_) => return defer("id-shape"),
            };
            if !is_safe_id(&id) {
                continue;
            }
            match desc.get("worktreePath") {
                Some(OVal::Null) | None | Some(OVal::Bool(false)) => continue,
                Some(OVal::Str(w)) if w.is_empty() => continue,
                Some(OVal::Str(_)) => {}
                Some(_) => return defer("worktree-shape"),
            }
            if items.iter().any(|i| i.id == id) {
                if items.iter().any(|i| i.id == id && i.archived == archived) {
                    return defer("duplicate-id");
                }
                continue;
            }
            if name != format!("{id}{suffix}") {
                return defer("file-name-is-not-the-id");
            }
            items.push(Item { archived, path, id });
        }
    }
    Ok(items)
}

/// `migrate-owner-keys`: backfill a missing `ownerKey` on every descriptor, active and archived. A stranded active descriptor
/// (the re-home) is Node's, decided before anything is written.
pub fn migrate_owner_keys(inv: &Inv, _a: &Args) -> R<Answer> {
    let items = migration_items(inv)?;
    for it in &items {
        let Some(desc) = read_descriptor_file(&it.path) else { continue };
        if matches!(migration_fix(&desc, it.archived, &it.id)?, Fix::Rehome) {
            return defer("rehome");
        }
    }
    let (mut backfilled, mut errors) = (0.0, 0.0);
    for it in &items {
        // withIdLock: a busy lock skips the descriptor (Node reports no error for it)
        let Some(lock) = idlock::acquire(&inv.home, &it.id) else { continue };
        // re-read under the lock: never overwrite a concurrent live mutation
        let fix = read_descriptor_file(&it.path).map(|d| migration_fix(&d, it.archived, &it.id));
        match fix {
            Some(Ok(Fix::Backfill(out))) => {
                crate::meshw::mark_committed();
                let mut tmp = it.path.as_os_str().to_os_string();
                tmp.push(format!(".{}.{}", std::process::id(), defaults::text("devswarm_cli.migrate_tmp_suffix")));
                let tmp = std::path::PathBuf::from(tmp);
                let wrote = std::fs::write(&tmp, out.stringify()).and_then(|()| std::fs::rename(&tmp, &it.path));
                if wrote.is_ok() {
                    backfilled += 1.0;
                    if let Ok(rel) = it.path.strip_prefix(&inv.home) {
                        crate::meshw::set_written(&rel.to_string_lossy(), out.stringify().as_bytes());
                    }
                } else {
                    crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: Node's catch unlinks the staging file and counts the error
                    errors += 1.0;
                }
            }
            // a descriptor that changed to need the re-home (or to be unreadable) between the scan and the lock: left for the next run
            _ => {}
        }
        lock.release();
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(errors == 0.0))
        .put("action", s(defaults::text("devswarm_cli.action_migrate_owner_keys")))
        .put("dryRun", OVal::Bool(false))
        .put("scanned", crate::meshw::common::n(items.len() as f64))
        .put("backfilled", crate::meshw::common::n(backfilled))
        .put("rehomed", crate::meshw::common::n(0.0))
        .put("errors", crate::meshw::common::n(errors));
    Ok(answer(if errors == 0.0 { 0 } else { 2 }, o.done()))
}

// ---- ensure / register --------------------------------------------------------------------------------------------------

/// The flags `buildDescriptorFromFlags` reads.
struct RegFlags {
    worktree: Option<String>,
    session: Option<String>,
    inbox: Option<String>,
    cursor: Option<String>,
    nudge: Vec<String>,
    repo_id: Option<String>,
}

fn reg_flags(a: &Args) -> R<RegFlags> {
    let name = |k: &str| defaults::text(k);
    // an empty value is a value in JavaScript (`one()` returns ''), and falsy: Node's handling of it is not reproduced
    for k in ["devswarm_cli.flag_worktree", "devswarm_cli.flag_session", "devswarm_cli.flag_reg_inbox", "devswarm_cli.flag_reg_cursor", "devswarm_cli.flag_reg_nudge", "devswarm_cli.flag_reg_repo_id"] {
        if a.flags.get(name(k)).is_some_and(|v| v.iter().any(|x| matches!(x, crate::meshw::args::FlagVal::S(t) if t.is_empty()))) {
            return defer("empty-flag");
        }
    }
    let one = |k: &str| a.one(name(k)).map(str::to_string);
    Ok(RegFlags {
        worktree: one("devswarm_cli.flag_worktree"),
        session: one("devswarm_cli.flag_session"),
        inbox: one("devswarm_cli.flag_reg_inbox"),
        cursor: one("devswarm_cli.flag_reg_cursor"),
        nudge: a.many(name("devswarm_cli.flag_reg_nudge")).into_iter().map(str::to_string).collect(),
        repo_id: one("devswarm_cli.flag_reg_repo_id"),
    })
}

/// `buildDescriptorFromFlags(id, flags, existing, env)`: keys in Node's assignment order.
fn build_descriptor(inv: &Inv, id: &str, f: &RegFlags, existing: Option<&OVal>) -> OVal {
    let mut base = existing.cloned().unwrap_or_else(|| OVal::Obj(Vec::new()));
    base.set("id", s_val(id));
    if let Some(w) = &f.worktree {
        base.set("worktreePath", s_val(&ident::resolve(&inv.cwd, w)));
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

/// Whether Node's `retireWorktreeDuplicates` would find another registry row of the same physical worktree (it would fold it
/// into this id: the engine leaves that to Node).
fn has_duplicate_rows(inv: &Inv, current: &str, id: &str, worktree: Option<&str>) -> R<bool> {
    let Some(w) = worktree else { return Ok(false) };
    let keep_mesh = ident::primary_workspace_id(w)?;
    if keep_mesh == id {
        return Ok(false);
    }
    let Some(keep_real) = ident::canonical_worktree_real_path(w)? else { return Ok(false) };
    let Some(reader) = crate::meshw::tick::open_reader(inv, current)? else { return defer("no-store") };
    let rows = ident::rows_of(&reader.roster().map_err(|e| ident::Defer(format!("registry:{e}")))?);
    for r in rows.iter().filter(|r| r.id != id) {
        if let Some(rw) = r.worktree_path.as_deref().filter(|x| !x.is_empty())
            && ident::canonical_worktree_real_path(rw)?.as_deref() == Some(keep_real.as_str())
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `ensure` and `register`: `cmdRegister(id, flags, ctx, { requireNew })`. The engine answers a registration it can prove: an
/// idempotent ensure of a descriptor that already belongs to this project, and a new or updated registration in the project of
/// the caller's cwd. Every refusal (Node logs those to the central log), the re-home, an archived twin, a second registry row of
/// the worktree and a project the engine cannot name are Node's, decided before the first write.
fn register_verb(inv: &Inv, a: &Args, require_new: bool) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(bad_id());
    }
    if crate::meshw::heartbeat::is_primary_label(id) {
        return defer("primary-label");
    }
    let f = reg_flags(a)?;
    let root = idlock::devswarm_root(&inv.home);
    let json = defaults::text("mesh_write.json_suffix");
    let desc_file = root.join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}{json}"));
    let existing = match std::fs::symlink_metadata(&desc_file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return defer("descriptor-io"),
        Ok(_) => Some(read_descriptor_file(&desc_file).ok_or_else(|| ident::Defer("descriptor-unreadable".into()))?),
    };
    if matches!(&existing, Some(OVal::Obj(fields)) if fields.iter().any(|(k, _)| k == "__proto__")) {
        return defer("descriptor-keys");
    }
    // the app database is ground truth for "archived": a refusal Node logs
    let guard_wt = f.worktree.clone().or_else(|| existing.as_ref().and_then(|d| nonempty_str(d.get("worktreePath")).map(str::to_string)));
    let (verdict, cache) = crate::meshw::appdb::archived_verdict(&inv.home, &inv.env, inv.now, id, guard_wt.as_deref(), true)?;
    if verdict == Some(true) {
        return defer("app-archived");
    }
    if existing.is_none() {
        let reserved = defaults::list("mesh_write.reserved_id_tokens").iter().any(|t| id.contains(t))
            || id.ends_with(defaults::text("mesh_write.reserved_id_suffix"))
            || id == defaults::text("mesh_write.reserved_exact_id");
        if reserved {
            return defer("reserved-id");
        }
        if require_new && std::fs::symlink_metadata(root.join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{json}"))).is_ok() {
            return defer("archived-counterpart");
        }
    }
    let ctx = ident::resolve_context(&inv.cwd, true)?;
    if ctx.kind.starts_with(defaults::text("mesh_write.kind_submodule_prefix")) {
        return defer("submodule");
    }
    let Some(current) = ctx.repo_key.clone() else { return defer("no-project") };
    let fresh = |d: &OVal| -> R<Option<String>> {
        match d.get("worktreePath") {
            Some(OVal::Str(w)) if !w.is_empty() => ident::repo_key_for_worktree(w),
            _ => Ok(None),
        }
    };
    let (out_desc, rewrite, action, create) = if let (true, Some(ex)) = (require_new, existing.as_ref()) {
        // ensure over a descriptor that exists: idempotent, only backfilling what is proven
        if let Some(reg) = crate::meshw::inbox::registered_repo_key(ex, id)?
            && reg != current
        {
            return defer("project-context-mismatch");
        }
        let hash = crate::meshw::send::hash_from_workspace_id(id);
        let stored = nonempty_str(ex.get("ownerKey")).map(str::to_string);
        if stored.as_deref() == Some(hash.as_str()) && hash != current {
            return defer("rehome");
        }
        let proven = match &stored {
            Some(k) => Some(k.clone()),
            None => match nonempty_str(ex.get("repoKey")) {
                Some(k) => Some(k.to_string()),
                None => fresh(ex)?,
            },
        };
        if proven.as_deref() != Some(current.as_str()) {
            return defer("ensure-refused");
        }
        let mut ensured = ex.clone();
        if stored.is_none() {
            ensured.set("ownerKey", s_val(&current));
        }
        if fresh(&ensured)?.as_deref() == Some(current.as_str()) {
            ensured.set("repoKey", s_val(&current));
        }
        for (key, flag, default) in [
            ("inboxPath", &f.inbox, crate::meshw::pull::inbox_default(&inv.home, id)),
            ("cursorPath", &f.cursor, crate::meshw::pull::cursor_default(&inv.home, id)),
        ] {
            if matches!(ensured.get(key), None | Some(OVal::Null)) || matches!(ensured.get(key), Some(OVal::Str(x)) if x.is_empty()) {
                ensured.set(key, s_val(flag.as_deref().unwrap_or(&default)));
            }
            if !matches!(ensured.get(key), Some(OVal::Str(_))) {
                return defer("descriptor-path-type");
            }
        }
        let rewrite = ensured.stringify() != ex.stringify();
        (ensured, rewrite, defaults::text("devswarm_cli.action_exists"), false)
    } else {
        let mut desc = build_descriptor(inv, id, &f, existing.as_ref());
        for k in ["worktreePath", "sessionId"] {
            match desc.get(k) {
                Some(OVal::Str(x)) if !x.is_empty() => {}
                None | Some(OVal::Null) => return defer("register-requires"),
                Some(OVal::Str(_)) => return defer("register-requires"),
                Some(_) => return defer("field-type"),
            }
        }
        let worktree_key = fresh(&desc)?;
        if worktree_key.as_deref().is_some_and(|wk| wk != current) {
            return defer("cross-project-register");
        }
        if worktree_key.as_deref() == Some(current.as_str()) {
            desc.set("repoKey", s_val(&current));
        }
        desc.set("ownerKey", s_val(&current));
        let action = if existing.is_some() { defaults::text("devswarm_cli.action_updated") } else { defaults::text("devswarm_cli.action_registered") };
        (desc, true, action, true)
    };
    let wt_text = crate::meshw::pull::text_or_null(&out_desc, "worktreePath")?;
    let row = crate::meshw::store::RegistryRow {
        id: id.to_string(),
        worktree_path: wt_text.clone(),
        session_id: crate::meshw::pull::text_or_null(&out_desc, "sessionId")?,
        inbox_path: crate::meshw::pull::text_or_null(&out_desc, "inboxPath")?,
        cursor_path: crate::meshw::pull::text_or_null(&out_desc, "cursorPath")?,
        nudge_command: match out_desc.get("nudgeCommand") {
            None | Some(OVal::Null) => None,
            Some(v) => Some(v.stringify()),
        },
    };
    if has_duplicate_rows(inv, &current, id, wt_text.as_deref())? {
        return defer("duplicate-registry-rows");
    }
    let Some(reader) = crate::meshw::tick::open_reader(inv, &current)? else { return defer("no-store") };
    if !create {
        // the ensure's upsert keeps the collision guard: a row at another worktree is left alone (the descriptor is still written)
        let rows = ident::rows_of(&reader.roster().map_err(|e| ident::Defer(format!("registry:{e}")))?);
        if let (Some(have), Some(incoming)) = (rows.iter().find(|r| r.id == id).and_then(|r| r.worktree_path.clone()), row.worktree_path.as_deref())
            && have != incoming
        {
            return defer("registry-collision");
        }
    }
    let store = common::open_store(inv, &current)?;
    crate::meshw::summary::check(&store, inv, None)?;
    let declare = if create { crate::meshw::pull::plan_declare(inv, &store, id)? } else { Vec::new() };
    // ---- the writes, under the workspace's lock ----
    let Some(lock) = idlock::acquire(&inv.home, id) else { return defer("lock-busy") };
    crate::meshw::mark_committed();
    if let Some(c) = &cache {
        c.perform();
    }
    let mut failed = false;
    if rewrite && crate::meshw::pull::write_descriptor(inv, id, &out_desc).is_err() {
        failed = true;
    }
    if !failed {
        crate::meshw::pull::precreate(&out_desc);
        failed = store.upsert_registry(&row, inv.now, |_, _| true).is_err();
    }
    if !failed {
        if create && !declare.is_empty() {
            crate::discard::harmless(store.reader_cursor_txn(&declare)); // keep: Node's `catch (_) { /* fail-soft */ }`
        }
        if let Some(why) = crate::meshw::summary::derive_after_write(&store, inv, &current) {
            crate::meshw::log_summary_failure(defaults::text("devswarm_cli.verb_register"), &why);
        }
    }
    lock.release();
    if failed {
        return defer("committed:registry");
    }
    note_file(inv, &view::descriptor_rel(id));
    // the pre-created cursor and inbox are not noted for the witness: a descriptor names them by absolute path, which Node's scratch
    // home does not hold (the parity test compares them in the whole-home tree)
    wsverbs::note_summary(inv, &current);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(action)).put("id", s(id)).put("descriptor", out_desc);
    Ok(answer(0, o.done()))
}

/// `ensure <id> [--worktree P --session S --inbox P --cursor P]`.
pub fn ensure(inv: &Inv, a: &Args) -> R<Answer> {
    register_verb(inv, a, true)
}

/// `register <id> --worktree P --session S [--inbox P --cursor P --nudge CMD]`.
pub fn register(inv: &Inv, a: &Args) -> R<Answer> {
    register_verb(inv, a, false)
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

/// `planLib.currentStep(plan)`: the newest doing/blocked step, else the first open one.
fn current_step(plan: &OVal) -> R<Option<&OVal>> {
    let steps = crate::meshw::plan::steps_of(plan);
    let done = defaults::text("mesh_write.plan_status_done");
    let working = [defaults::text("mesh_write.plan_status_doing"), defaults::text("mesh_write.plan_status_blocked")];
    let ts = |st: &OVal| -> R<f64> {
        match st.get("ts") {
            None | Some(OVal::Null) => Ok(0.0),
            Some(OVal::Num(x)) if x.is_finite() => Ok(*x),
            Some(_) => defer("plan-shape"),
        }
    };
    let open: Vec<&OVal> = steps.iter().filter(|st| !crate::meshw::plan::status_is(st, done)).collect();
    let mut best: Option<&OVal> = None;
    for st in &open {
        if !working.iter().any(|w| crate::meshw::plan::status_is(st, w)) {
            continue;
        }
        if best.is_none_or(|b| ts(st).unwrap_or(0.0) >= ts(b).unwrap_or(0.0)) {
            ts(st)?;
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

/// The entries of `stray.active` (none when there is no such list).
fn stray_active(stray: Option<&OVal>) -> R<Vec<&OVal>> {
    match stray.and_then(|s| s.get("active")) {
        Some(OVal::Arr(v)) => {
            if v.iter().any(|a| !matches!(a, OVal::Obj(_))) {
                return defer("stray-shape");
            }
            Ok(v.iter().collect())
        }
        _ => Ok(Vec::new()),
    }
}

/// `sup.correctionText(id, plan, stray, now)`.
fn correction_text(id: &str, plan: &OVal, stray: Option<&OVal>, now: f64) -> R<String> {
    let cur = current_step(plan)?;
    let (n, text) = match cur {
        Some(st) => {
            let n = match st.get("n") {
                Some(OVal::Num(x)) => crate::checks::guardkit::ojson::js_number_text(*x),
                _ => return defer("plan-shape"),
            };
            let text = match st.get("text") {
                Some(OVal::Str(t)) => t.clone(),
                _ => return defer("plan-shape"),
            };
            (n, text)
        }
        None => (crate::meshw::plan::steps_of(plan).len().to_string(), defaults::text("devswarm_cli.corr_final_report").to_string()),
    };
    let mut reasons: Vec<String> = Vec::new();
    for a in stray_active(stray)? {
        match a.get("reason") {
            None | Some(OVal::Null) => {}
            Some(OVal::Str(r)) if r.is_empty() => {}
            Some(OVal::Str(r)) => reasons.push(r.clone()),
            Some(_) => return defer("stray-shape"),
        }
    }
    if reasons.is_empty() {
        let since = match plan.get("step_ts") {
            Some(OVal::Num(x)) if x.is_finite() => *x,
            _ => match plan.get("created_at") {
                Some(OVal::Num(x)) => *x,
                None | Some(OVal::Null) => f64::NAN,
                Some(_) => return defer("plan-shape"),
            },
        };
        reasons.push(crate::meshw::extverbs::tpl("devswarm_cli.corr_no_progress", &[("d", &crate::meshw::plan::dur(now - since))]));
    }
    Ok(crate::meshw::extverbs::tpl(
        "devswarm_cli.corr_text",
        &[("n", &n), ("text", &text), ("reasons", &reasons.join(defaults::text("devswarm_cli.corr_reason_join"))), ("id", id)],
    ))
}

/// `correct <id> [--dry-run]`: the Primary's correction for a straying child (`cmdCorrect`).
pub fn correct(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let action = s(defaults::text("devswarm_cli.action_correct"));
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(fail_with(&[("action", action), ("error", s(defaults::text("devswarm_cli.msg_corr_usage")))]));
    }
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
    let message = correction_text(id, &found.plan, stray.as_ref(), now)?;
    if a.has(defaults::text("devswarm_cli.flag_dry_run")) {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true)).put("action", action).put("id", s(id)).put("dryRun", OVal::Bool(true)).put("message", s(&message));
        return Ok(answer(0, o.done()));
    }
    // everything the plan update will record is decided before the send writes the message
    let active = stray_active(stray.as_ref())?;
    let mut signals: Vec<String> = Vec::new();
    let mut all_signals: Vec<OVal> = Vec::new();
    let mut warned_jev: Vec<OVal> = Vec::new();
    for e in &active {
        let sig = match e.get("signal") {
            Some(OVal::Str(t)) => t.clone(),
            _ => return defer("stray-shape"),
        };
        all_signals.push(s(&sig));
        if !signals.contains(&sig) {
            signals.push(sig);
        }
        match e.get("jev") {
            Some(OVal::Arr(notes)) => {
                for note in notes {
                    let integration = match note.get("integration") {
                        Some(OVal::Str(t)) => s(t),
                        _ => return defer("stray-shape"),
                    };
                    let mut o = Obj::default();
                    o.put("integration", integration).put("supports", OVal::Bool(matches!(note.get("supports"), Some(OVal::Bool(true)))));
                    warned_jev.push(o.done());
                }
            }
            None | Some(OVal::Null) => {}
            Some(_) => return defer("stray-shape"),
        }
    }
    let step_n = match current_step(&found.plan)? {
        Some(st) => match st.get("n") {
            Some(OVal::Num(x)) => Some(*x),
            _ => return defer("plan-shape"),
        },
        None => None,
    };
    if crate::meshw::plan::log_needs_rotation(inv) {
        return defer("supervision-rotate");
    }
    // the message goes out through the native send, as Node's nested `run(['send', '--to', id, '--message-file', f])`
    let mut send_args = Args { positionals: vec![defaults::text("mesh_write.verb_send").to_string()], ..Args::default() };
    send_args.flags.insert(defaults::text("mesh_write.flag_to").to_string(), vec![crate::meshw::args::FlagVal::S(id.to_string())]);
    send_args.flags.insert(defaults::text("mesh_write.flag_message").to_string(), vec![crate::meshw::args::FlagVal::S(message.clone())]);
    let sent = crate::meshw::send::run(inv, &send_args)?;
    let sent_result = OVal::parse(sent.stdout.trim_end()).ok_or_else(|| ident::Defer("committed:send-result".into()))?;
    let effect = sent.effect.clone();
    let reply = |o: Obj| Answer { code: if sent.code == 0 && matches!(o.0.iter().find(|(k, _)| k == "ok"), Some((_, OVal::Bool(true)))) { 0 } else { 2 }, stdout: format!("{}\n", o.done().stringify()), effect: effect.clone() };
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
        let Some(mut plan) = cur else { return Ok(((), None)) };
        plan.set("warned_at", crate::meshw::common::n(now));
        plan.set("warned_step", step_n.map_or(OVal::Null, crate::meshw::common::n));
        plan.set("warned_signals", OVal::Arr(signals.iter().map(|t| s(t)).collect()));
        plan.set("warned_jev", OVal::Arr(warned_jev.clone()));
        Ok(((), Some(plan)))
    })?;
    let recorded = match warned {
        Some(((), Some(text))) => {
            crate::meshw::note_written(&crate::meshw::plan::plan_rel(&found.key), text.as_bytes());
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
    let fields = vec![
        ("id".to_string(), s(id)),
        ("key".to_string(), s(&found.key)),
        ("step".to_string(), step_n.map_or(OVal::Null, crate::meshw::common::n)),
        ("signals".to_string(), OVal::Arr(all_signals)),
        ("jev".to_string(), OVal::Arr(warned_jev)),
    ];
    if crate::meshw::plan::record(inv, defaults::text("devswarm_cli.corr_event"), &fields, now).is_some() {
        crate::meshw::plan::note_log(inv);
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", action)
        .put("id", s(id))
        .put("message", s(&message))
        .put("warned_at", crate::meshw::common::n(now))
        .put("step", step_n.map_or(OVal::Null, crate::meshw::common::n))
        .put("sent", sent_result);
    Ok(reply(o))
}
