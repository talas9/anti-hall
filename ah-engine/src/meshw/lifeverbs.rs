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
