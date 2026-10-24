//! Plain `devswarm.js roster`, ported from `scripts/devswarm-lib/roster-diag.js` `cmdRoster` and `rosterHumanText`.
//!
//! This file takes the arguments, finds the project and its store, and prints; the rows (hints, archived rows, the app
//! database's fields, the ghost fold, the native children, the plan fields) and the text table are [`super::rosterrows`]. A project
//! with no rows at all is the same path with nothing to list: `{ok, action, repoKey, known, ..., workspaces: [], recent}` or the
//! text `no live workspaces`.
//!
//! Nothing is written by this verb (Node's `openStore` only runs `CREATE ... IF NOT EXISTS` over a store that exists). Every row
//! class is answered (see `rosterrows`).
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, s};
use crate::meshw::ident::{self, R};
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
        Some(OVal::Num(x)) if *x == 0.0 || x.is_nan() => Ok(None),
        // a truthy path of another type is `String()`-coerced by Node's `repoKeyForWorktree`
        Some(other) => ident::repo_key_for_worktree(&ident::js_to_string(other)),
    }
}

/// A switch of the verb as `main()` reads it: the exact word anywhere in the argument list (`argv.includes('--json')`), whatever follows.
fn has_word(a: &Args, name: &str) -> bool {
    let word = format!("--{name}");
    a.raw.contains(&word)
}

/// Run plain `roster`.
pub fn run(inv: &Inv, a: &Args) -> R<Answer> {
    // `cmdRoster(flags, ctx)` reads no flag and no positional; only `main()` reads `--json` and `--all`, and a help request never
    // arrives here (`simple::classify` takes it first)
    let json = has_word(a, defaults::text("mesh_write.flag_json"));
    let all_flag = has_word(a, defaults::text("mesh_write.roster_flag_all"));
    // ---- the project and its store ----
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("reason", s(defaults::text("devswarm_cli.reason_no_project")))
            .put("error", s(defaults::text("devswarm_cli.msg_roster_no_project")));
        return Ok(Answer { code: 2, stdout: format!("{}\n", o.done().stringify()), effect: Effect::None });
    };
    let st = common::open_store(inv, &repo_key)?;
    let sum = summary::compute(&st, inv, None)?;
    let recent = match sum.get("recent") {
        Some(r @ OVal::Arr(_)) => r.clone(),
        Some(OVal::Null) | None => OVal::Arr(Vec::new()),
        // `sum.recent || []`: any other truthy value is carried as it is
        Some(other) if other.truthy() => other.clone(),
        Some(_) => OVal::Arr(Vec::new()),
    };
    let main = ident::resolve_context(&inv.cwd, false)?.main_worktree;
    let built = rosterrows::build(inv, &repo_key, &st, &sum, main.as_deref())?;
    if !json {
        let all = all_flag
            || inv.env.get(defaults::text("devswarm_cli.rr_env_hide_archived")).map(String::as_str)
                == Some(defaults::text("devswarm_cli.rr_hide_archived_off"));
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
