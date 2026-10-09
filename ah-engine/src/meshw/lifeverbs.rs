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
use crate::meshw::common::{Inv, Obj, s};
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
