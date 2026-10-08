//! Plain `devswarm.js roster`, ported from `scripts/devswarm-lib/roster-diag.js` `cmdRoster` and `rosterHumanText`.
//!
//! A roster row is built from the liveness, session-transcript, idle, plan, app-database, name and alias machinery of
//! Node, none of which the engine has. So the engine answers the one project whose roster has NO rows and defers every
//! other: a project with no registered workspace, no archived descriptor it owns, no split-brain fallback summary and no native
//! child that `hivecontrol workspace list children` reports. That roster is `{ok, action, repoKey, known, ...,
//! workspaces: [], recent}` (or the text `no live workspaces`), and what it still reads is the same: the store (through the
//! shared summary projection), the archived directory, the fallback summary file, and ONE bounded `hivecontrol` call.
//!
//! The cheap checks run first: a project that has workspaces (nearly every one) defers before `hivecontrol` is started,
//! so Node does not pay for a second call. Node's capability gate comes first (`meshw::hivecontrol`): a binary it would have
//! to probe (and cache the probe of) is Node's. A missing, failing, hanging or empty-answering `hivecontrol` is "no
//! children", exactly as Node's fail-open `fetchNativeChildren`; a child it does report is a row, so that defers.
//!
//! Nothing is written by this verb (Node's `openStore` only runs `CREATE ... IF NOT EXISTS` over a store that exists).
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::args::{Args, FlagVal};
use crate::meshw::common::{self, Inv, Obj, s};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::devswarm_root;
use crate::meshw::send::{Answer, Effect, hash_from_workspace_id};
use crate::meshw::{hivecontrol, summary};

/// `parseChildrenList(raw)` has at least one entry: a bare array or a `{children: [...]}` wrapper, each element an object
/// (an array is an object to JavaScript). Text that does not parse is an empty list.
fn reports_children(raw: &str) -> bool {
    let parsed = OVal::parse(raw);
    let list = match &parsed {
        Some(OVal::Arr(a)) => Some(a),
        Some(o @ OVal::Obj(_)) => match o.get(defaults::text("mesh_write.roster_children_key")) {
            Some(OVal::Arr(a)) => Some(a),
            _ => None,
        },
        _ => None,
    };
    list.is_some_and(|l| l.iter().any(|e| matches!(e, OVal::Obj(_) | OVal::Arr(_))))
}

/// `descriptorPhysicalOwnerKey(desc)`: the persisted `ownerKey`, else the persisted `repoKey`, else the key of the
/// descriptor's worktree.
fn physical_owner_key(d: &OVal) -> R<Option<String>> {
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
    bare(a, defaults::text("mesh_write.roster_flag_all"))?;
    // ---- the project and its store ----
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else { return defer("no-project") };
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_store")).join(&repo_key);
    if !dir.join(defaults::text("mesh_write.store_file")).is_file() {
        return defer("no-store");
    }
    let st = common::open_store(inv, &repo_key)?;
    let sum = summary::compute(&st, inv, None)?;
    if !matches!(sum.get("workspaces"), Some(OVal::Obj(w)) if w.is_empty()) {
        return defer("has-workspaces");
    }
    let recent = match sum.get("recent") {
        Some(r @ OVal::Arr(_)) => r.clone(),
        Some(OVal::Null) | None => OVal::Arr(Vec::new()),
        Some(_) => return defer("recent-shape"),
    };
    // an archived descriptor OWNED by this project adds a row (and brings in the app-database and name machinery); the
    // directory is shared by every project of the machine, so the ones owned elsewhere are skipped, as Node skips them
    if let Ok(rd) = std::fs::read_dir(devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_archived"))) {
        let suffix = defaults::text("mesh_write.json_suffix");
        for e in rd.flatten() {
            if !e.file_name().to_string_lossy().ends_with(suffix) {
                continue;
            }
            // readDescriptorPathState: a regular file holding a JSON object; anything else is skipped
            let p = e.path();
            if !std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_file()) {
                continue;
            }
            let Some(d @ OVal::Obj(_)) = std::fs::read(&p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
            if physical_owner_key(&d)?.as_deref() == Some(repo_key.as_str()) {
                return defer("archived-descriptor-owned");
            }
        }
    }
    // the split-brain fallback: the Primary's own summary under a different hash would add its workspace
    let ctx = ident::resolve_context(&inv.cwd, false)?;
    if let Some(main) = ctx.main_worktree {
        let fallback = hash_from_workspace_id(&ident::primary_workspace_id(&main)?);
        let file =
            devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_summaries")).join(format!("{fallback}{}", defaults::text("mesh_write.json_suffix")));
        if fallback != repo_key && file.exists() {
            return defer("fallback-summary");
        }
    }
    // ---- the one bounded external call, last: only a project with no rows pays for it ----
    let args: Vec<&str> = defaults::list("mesh_write.roster_children_args");
    match hivecontrol::gate(&inv.env, &inv.home) {
        hivecontrol::Gate::Probe => return defer("hivecontrol-probe"),
        hivecontrol::Gate::Refused => {}
        hivecontrol::Gate::Spawn => {
            if let Some(raw) = hivecontrol::run(&args, &inv.env)
                && reports_children(&raw)
            {
                return defer("native-children");
            }
        }
    }
    if !json {
        return Ok(Answer { code: 0, stdout: format!("{}\n", defaults::text("mesh_write.roster_none_text")), effect: Effect::None });
    }
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("mesh_write.verb_roster")))
        .put("repoKey", s(&repo_key))
        .put("known", OVal::Bool(true))
        .put("storeUnavailable", OVal::Bool(false))
        .put("storeUnavailableReason", OVal::Null)
        .put("storeUnavailableScope", OVal::Null)
        .put("count", OVal::Num(0.0))
        .put("workspaces", OVal::Arr(Vec::new()))
        .put("recent", recent)
        .put("liveCount", OVal::Num(0.0))
        .put("archivedCount", OVal::Num(0.0));
    Ok(Answer { code: 0, stdout: format!("{}\n", out.done().stringify()), effect: Effect::None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_list_without_an_object_has_no_children() {
        for raw in ["", "[]", "{}", "{\"children\":[]}", "[1,2,null]", "not json", "{\"children\":5}", "\"x\""] {
            assert!(!reports_children(raw), "{raw:?}");
        }
    }

    #[test]
    fn an_object_or_array_element_is_a_child() {
        for raw in ["[{}]", "[[1]]", "{\"children\":[{\"id\":\"a\"}]}", "[null,{\"id\":1}]"] {
            assert!(reports_children(raw), "{raw:?}");
        }
    }
}
