//! Plain `devswarm.js roster`, ported from `scripts/devswarm-lib/roster-diag.js` `cmdRoster` and `rosterHumanText`.
//!
//! This file takes the arguments, finds the project and its store, and prints; the rows (hints, archived rows, the app
//! database's fields, the ghost fold) and the text table are [`super::rosterrows`]. A project with no rows at all is the same
//! path with nothing to list: `{ok, action, repoKey, known, ..., workspaces: [], recent}` or the text `no live workspaces`.
//!
//! Nothing is written by this verb (Node's `openStore` only runs `CREATE ... IF NOT EXISTS` over a store that exists). What
//! the engine cannot reproduce is handed to Node before anything is printed (see `rosterrows` for the cases).
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::{Args, FlagVal};
use crate::meshw::common::{self, Inv, Obj, s};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::devswarm_root;
use crate::meshw::rosterrows;
use crate::meshw::send::{Answer, Effect};
use crate::meshw::summary;

/// `descriptorPhysicalOwnerKey(desc)`: the persisted `ownerKey`, else the persisted `repoKey`, else the key of the
/// descriptor's worktree.
pub(crate) fn physical_owner_key(d: &OVal) -> R<Option<String>> {
    for k in [defaults::text("mesh_write.field_owner_key"), defaults::text("mesh_write.field_repo_key")] {
        if let Some(OVal::Str(t)) = d.get(k)
            && !t.is_empty()
        {
            return Ok(Some(t.clone()));
        }
    }
    match d.get(defaults::text("mesh_write.field_worktree_path")) {
        None | Some(OVal::Null | OVal::Bool(false)) => Ok(None),
        Some(OVal::Str(w)) if w.is_empty() => Ok(None),
        Some(OVal::Str(w)) => ident::repo_key_for_worktree(w),
        Some(_) => defer("descriptor-worktree-type"),
    }
}

/// A flag the engine reads: bare, and one of `--all` / `--json`.
fn bare(a: &Args, name: &str) -> R<bool> {
    match a.flags.get(name) {
        None => Ok(false),
        Some(v) if v.iter().all(|x| *x == FlagVal::True) => Ok(true),
        Some(_) => defer("flag-value"),
    }
}

/// Run plain `roster`.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    if a.is_help() {
        return defer("help");
    }
    if a.positionals.len() != 1 {
        return defer("argv-shape");
    }
    let known = defaults::list("mesh_write.roster_flags");
    if a.flags.keys().any(|k| !known.contains(&k.as_str())) {
        return defer("flags");
    }
    let json = bare(a, defaults::text("mesh_write.flag_json"))?;
    let all_flag = bare(a, defaults::text("mesh_write.roster_flag_all"))?;
    // ---- the project and its store ----
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else { return defer("no-project") };
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_store")).join(&repo_key);
    if !dir.join(defaults::text("mesh_write.store_file")).is_file() {
        return defer("no-store");
    }
    let st = common::open_store(inv, &repo_key)?;
    let sum = summary::compute(&st, inv, None)?;
    let recent = match sum.get("recent") {
        Some(r @ OVal::Arr(_)) => r.clone(),
        Some(OVal::Null) | None => OVal::Arr(Vec::new()),
        Some(_) => return defer("recent-shape"),
    };
    let main = ident::resolve_context(&inv.cwd, false)?.main_worktree;
    let built = rosterrows::build(inv, &repo_key, &st, &sum, main.as_deref())?;
    if !json {
        let all = all_flag || inv.env.get(defaults::text("devswarm_cli.rr_env_hide_archived")).map(String::as_str) == Some(defaults::text("devswarm_cli.rr_hide_archived_off"));
        let text = rosterrows::human_text(inv, &built.rows, all, inv.now as f64)?;
        return Ok(Answer { code: 0, stdout: format!("{text}\n"), effect: Effect::None });
    }
    let archived = built.rows.iter().filter(|r| rosterrows::is_archived_row(r)).count();
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("mesh_write.verb_roster")))
        .put("repoKey", s(&repo_key))
        .put("known", OVal::Bool(true))
        .put("storeUnavailable", OVal::Bool(false))
        .put("storeUnavailableReason", OVal::Null)
        .put("storeUnavailableScope", OVal::Null)
        .put("count", OVal::Num(built.rows.len() as f64))
        .put("workspaces", OVal::Arr(built.rows.iter().map(|r| OVal::Obj(r.0.clone())).collect()))
        .put("recent", recent);
    if let Some(live) = built.app_still_live {
        out.put("appStillLive", live);
    }
    out.put("liveCount", OVal::Num((built.rows.len() - archived) as f64)).put("archivedCount", OVal::Num(archived as f64));
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect: Effect::None })
}
