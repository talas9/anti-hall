//! `devswarm.js gate <id> --set <csv> --clear <csv>` and `devswarm.js workspaces list` (lane l8), ported from
//! `scripts/devswarm-lib/misc-verbs.js` (`cmdGate`, `cmdWorkspacesList`), `core.js` (`projectContextMismatch`) and
//! `repair.js` (`rehomeStrandedProjectDescriptors`, only the part that proves it has nothing to move).
//!
//! Both read the per-project store and the summary projection the other store verbs already reproduce
//! ([`crate::meshw::summary`]). `gate` appends one row per name to the `gates` table and refreshes the summary file, then
//! prints the workspace's row of the refreshed projection; `workspaces list` is a pure read.
//!
//! Deferred BEFORE the first write (Node then runs the verb): setting the `merged` gate (Node asks git for the merge
//! proof), a re-home the engine cannot prove to be a no-op, a caller outside any project (Node would open the legacy
//! per-id bucket), a store that is not the SQLite backend, a summary the engine cannot reproduce. The gate rows are the
//! first write; after them nothing defers.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect, hash_from_workspace_id, rehome_is_noop};
use crate::meshw::summary;

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

fn fail_error(msg: &str) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(msg));
    answer(2, o.done())
}

fn quote(x: &str) -> String {
    serde_json::to_string(x).unwrap_or_default()
}

/// `csvList(flags, name)`: every value split on commas, trimmed, without repeats.
fn csv_list(a: &Args, name: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in a.many(name) {
        for part in raw.split(',') {
            let t = js_trim(part);
            if !t.is_empty() && !out.iter().any(|x| x == t) {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// The caller's project key (`repoKeyForCwd(ctx)`).
fn caller_repo_key(inv: &Inv) -> R<Option<String>> {
    Ok(ident::resolve_context(&inv.cwd, true)?.repo_key)
}

/// `projectContextMismatch(id, registeredKey, callerKey, tail)`.
fn mismatch(id: &str, registered: &str, caller: Option<&str>) -> OVal {
    let tail = match caller {
        Some(c) => defaults::render("devswarm_cli.msg_ctx_other", &[("caller", &quote(c))]),
        None => defaults::text("devswarm_cli.msg_ctx_none").to_string(),
    };
    let msg = format!(
        "{}{tail}{}{}",
        defaults::render("devswarm_cli.msg_ctx_head", &[("id", &quote(id)), ("registered", &quote(registered))]),
        defaults::text("devswarm_cli.msg_ctx_join"),
        defaults::text("devswarm_cli.msg_gate_tail")
    );
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false))
        .put("id", s(id))
        .put("reason", s(defaults::text("devswarm_cli.reason_ctx_mismatch")))
        .put("registeredRepoKey", s(registered))
        .put("callerRepoKey", caller.map_or(OVal::Null, s))
        .put("error", s(&msg));
    o.done()
}

// ---- gate ---------------------------------------------------------------------------------------------------------------

/// `gate <id> [--set CSV] [--clear CSV] [--by WHO]`.
pub fn run_gate(inv: &Inv, a: &Args) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    if !is_safe_id(id) {
        return Ok(fail_error(defaults::text("devswarm_cli.msg_bad_id")));
    }
    let id = match crate::meshw::actverbs::resolve_target_id(inv, id, defaults::text("devswarm_cli.action_gate"))? {
        Ok(x) => x,
        Err(refused) => return Ok(refused),
    };
    let id = id.as_str();
    let set_names = csv_list(a, defaults::text("devswarm_cli.flag_set"));
    let clear_names = csv_list(a, defaults::text("devswarm_cli.flag_clear"));
    if set_names.is_empty() && clear_names.is_empty() {
        return Ok(fail_error(defaults::text("devswarm_cli.msg_gate_usage")));
    }
    let set_by = a.one(defaults::text("devswarm_cli.flag_by")).unwrap_or(defaults::text("devswarm_cli.gate_set_by"));
    let (ok, res) = gate_core(inv, id, &set_names, &clear_names, set_by)?;
    Ok(answer(if ok { 0 } else { 2 }, res))
}

/// `cmdGate(id, { set, clear, by }, ctx)` once the flags are checked: `(ok, result)`. A refusal comes back before anything is
/// written; a workspace the summary does not track comes back after the gate rows were (the caller decides what that means).
pub(crate) fn gate_core(inv: &Inv, id: &str, set_names: &[String], clear_names: &[String], set_by: &str) -> R<(bool, OVal)> {
    // the authority gate runs before anything else: a workspace registered under another project is refused
    let caller = caller_repo_key(inv)?;
    let desc = ident::read_descriptor(&inv.home, id);
    if let Some(d) = &desc
        && let Some(registered) = crate::meshw::inbox::registered_repo_key(d, id)?
        && caller.as_deref() != Some(registered.as_str())
    {
        return Ok((false, mismatch(id, &registered, caller.as_deref())));
    }
    // `merged` asks git for the merge proof (and warns on stderr): Node's
    if set_names.iter().any(|x| x == defaults::text("devswarm_cli.gate_merged")) {
        return defer("merged-proof");
    }
    rehome_is_noop(inv, id)?;
    // no project: Node opens the legacy per-id bucket
    let Some(repo_key) = caller else { return defer("no-project") };
    let st = common::open_store(inv, &repo_key)?;
    summary::check(&st, inv, None)?;
    let now = inv.now;
    let mut first = true;
    for (name, value) in set_names.iter().map(|x| (x, true)).chain(clear_names.iter().map(|x| (x, false))) {
        st.set_gate(id, name, value, set_by, now).map_err(|e| ident::Defer(format!("gate-write:{e}")))?;
        if first {
            crate::meshw::mark_committed();
            first = false;
        }
    }
    let (sum, failed) = summary::derive_value(&st, inv, &repo_key)?;
    if let Some(why) = failed {
        crate::meshw::log_summary_failure(defaults::text("devswarm_cli.verb_gate"), &why);
    }
    // the refreshed summary file is part of what the verb wrote
    note_summary(inv, &repo_key);
    let ws = sum.get("workspaces").and_then(|w| w.get(id));
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(ws.is_some()))
        .put("action", s(defaults::text("devswarm_cli.action_gate")))
        .put("id", s(id))
        .put("set", OVal::Arr(set_names.iter().map(|x| s(x)).collect()))
        .put("cleared", OVal::Arr(clear_names.iter().map(|x| s(x)).collect()));
    if let Some(w) = ws {
        for k in ["gates", "archive_ready"] {
            if let Some(v) = w.get(k) {
                o.put(k, v.clone());
            }
        }
    }
    o.put("tracked", OVal::Bool(ws.is_some()));
    Ok((ws.is_some(), o.done()))
}

/// Record the project's summary file as written by this verb (its content as it is now; a later write replaces it).
pub(crate) fn note_summary(inv: &Inv, repo_key: &str) {
    let rel = format!(
        "{}/{}/{}/{repo_key}{}",
        defaults::text("mesh_write.dir_anti_hall"),
        defaults::text("mesh_write.dir_devswarm"),
        defaults::text("mesh_write.dir_summaries"),
        defaults::text("mesh_write.json_suffix")
    );
    let file =
        devswarm_root(&inv.write_home).join(defaults::text("mesh_write.dir_summaries")).join(format!("{repo_key}{}", defaults::text("mesh_write.json_suffix")));
    crate::meshw::set_written(&rel, &std::fs::read(file).unwrap_or_default());
}

// ---- workspaces list ----------------------------------------------------------------------------------------------------

/// `rehomeStrandedProjectDescriptors(home, ctx)` does nothing: no descriptor of the workspaces directory is stranded in the
/// legacy hash bucket of another project (its persisted owner key is the hash of its id and not this project's key).
/// Whatever could be stranded defers; nothing is ever moved here.
fn rehome_sweep_is_noop(inv: &Inv, repo_key: &str) -> R<()> {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(()) };
    let suffix = defaults::text("mesh_write.json_suffix");
    for e in rd.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if !is_safe_id(id) {
            continue;
        }
        let Some(d) = ident::read_descriptor(&inv.home, id) else { continue };
        match d.get("id") {
            Some(OVal::Str(x)) if x == id => {}
            Some(OVal::Str(_)) => continue,
            // `String(desc.id)` of anything else: not reproduced
            _ => return defer("descriptor-shape"),
        }
        if !d.get(defaults::text("mesh_write.field_worktree_path")).is_some_and(OVal::truthy) {
            continue;
        }
        let owner = match d.get(defaults::text("mesh_write.field_owner_key")) {
            Some(OVal::Str(x)) if !x.is_empty() => Some(x.as_str()),
            _ => None,
        };
        let hash_key = hash_from_workspace_id(id);
        if owner != Some(hash_key.as_str()) || hash_key == repo_key {
            continue;
        }
        return defer("rehome");
    }
    Ok(())
}

/// `workspaces list [--workspace ID] [--worktree PATH]`.
pub fn run_workspaces(inv: &Inv, a: &Args) -> R<Answer> {
    let sub = a.positionals.get(1).map(String::as_str).filter(|x| !x.is_empty()).unwrap_or(defaults::text("devswarm_cli.sub_list"));
    if sub != defaults::text("devswarm_cli.sub_list") {
        return Ok(fail_error(&defaults::render("devswarm_cli.msg_workspaces_sub", &[("sub", &sub)])));
    }
    let mut workspace_id: Option<String> = a.one(defaults::text("devswarm_cli.flag_workspace")).map(str::to_string);
    let worktree_flag = a.one(defaults::text("devswarm_cli.flag_worktree")).filter(|x| !x.is_empty()).map(str::to_string);
    let worktree = match &worktree_flag {
        Some(w) => Some(w.clone()),
        None => ident::resolve_caller_worktree(&inv.cwd)?,
    };
    if workspace_id.is_none()
        && let Some(w) = &worktree
    {
        workspace_id = Some(ident::primary_workspace_id(w)?);
    }
    let repo_key = match &worktree {
        Some(w) => ident::repo_key_for_worktree(w)?,
        None => caller_repo_key(inv)?,
    };
    // the sweep that runs first is scoped to the same project the store opens (an explicit --worktree wins over the cwd)
    let sweep_key = match &worktree_flag {
        Some(w) => ident::resolve_context(w, true)?.repo_key,
        None => caller_repo_key(inv)?,
    };
    if let Some(k) = &sweep_key {
        rehome_sweep_is_noop(inv, k)?;
    }
    let Some(repo_key) = repo_key else { return defer("no-project") };
    let st = common::open_store(inv, &repo_key)?;
    let sum = summary::compute(&st, inv, None)?;
    let Some(OVal::Obj(all)) = sum.get("workspaces") else { return defer("summary-shape") };
    if all.iter().any(|(k, _)| crate::checks::guardkit::ojson::is_array_index_key(k)) {
        return defer("integer-keys");
    }
    let rows: Vec<OVal> = all.iter().map(|(_, v)| v.clone()).collect();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.action_workspaces")))
        .put("workspaceId", workspace_id.filter(|w| !w.is_empty()).map_or(OVal::Null, |w| s(&w)));
    if let Some(r) = sum.get("requiredGates") {
        o.put("requiredGates", r.clone());
    }
    o.put("count", n(rows.len() as f64)).put("workspaces", OVal::Arr(rows));
    Ok(answer(0, o.done()))
}
