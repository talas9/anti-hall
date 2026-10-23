//! `devswarm.js gate <id> --set <csv> --clear <csv>` and `devswarm.js workspaces list` (lane l8), ported from
//! `scripts/devswarm-lib/misc-verbs.js` (`cmdGate`, `cmdWorkspacesList`), `core.js` (`projectContextMismatch`) and
//! `repair.js` (`rehomeStrandedProjectDescriptors`, only the part that proves it has nothing to move).
//!
//! Both read the per-project store and the summary projection the other store verbs already reproduce
//! ([`crate::meshw::summary`]). `gate` appends one row per name to the `gates` table and refreshes the summary file, then
//! prints the workspace's row of the refreshed projection; `workspaces list` is a pure read.
//!
//! `gate --set merged` records git's merge proof beside the gate (`merged_verified`, bound to the HEAD it was computed at); a
//! caller outside any project gates in the legacy per-id bucket; a descriptor stranded in that bucket is re-homed into the project
//! before `workspaces list` reads. A store write that fails answers `{ ok: false, error }` with exit 2, as Node's `run()` does with
//! the exception. The gate rows are the first write.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s};
use crate::meshw::ident::{self, R};
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
    rehome_is_noop(inv, id)?;
    // no project: Node opens the legacy per-id bucket (`hashFromWorkspaceId(id)`), creating its store where it is absent
    let repo_key = match caller {
        Some(k) => k,
        None => {
            let k = hash_from_workspace_id(id);
            common::init_new_store(inv, &k)?;
            k
        }
    };
    let st = common::open_store(inv, &repo_key)?;
    summary::check(&st, inv, None)?;
    let now = inv.now;
    let mut first = true;
    let wrote = |e: &dyn std::fmt::Display| {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("error", s(&defaults::render("devswarm_cli.msg_gate_write_failed", &[("error", &e)])));
        (false, o.done())
    };
    for (name, value) in set_names.iter().map(|x| (x, true)).chain(clear_names.iter().map(|x| (x, false))) {
        if let Err(e) = st.set_gate(id, name, value, set_by, now) {
            return Ok(wrote(&e));
        }
        if first {
            crate::meshw::mark_committed();
            first = false;
        }
    }
    // `merged` also records git's merge proof (report-only: the gate above is set whatever the proof says)
    if set_names.iter().any(|x| x == defaults::text("devswarm_cli.gate_merged"))
        && let Err(e) = record_merge_proof(&st, id, desc.as_ref(), now)
    {
        return Ok(wrote(&e));
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

/// The `merged_verified` gate of `gate --set merged`: `gitMergeProof(descriptor.worktreePath)` says whether HEAD is an ancestor of the remote default
/// branch. A proof that is not a yes or a no (no worktree, no default branch, git failing) records nothing; the verdict is stored
/// bound to the HEAD it was computed at, and a no is also said on stderr.
fn record_merge_proof(st: &crate::meshw::store::MeshStore, id: &str, desc: Option<&OVal>, now: i64) -> Result<(), String> {
    let Some(OVal::Str(wt)) = desc.and_then(|d| d.get(defaults::text("mesh_write.field_worktree_path"))).filter(|w| w.truthy()) else { return Ok(()) };
    let runner = crate::dsact::runner::System::configured();
    let git = crate::dswire::facts::Git { runner: &runner };
    let Some(head) = git.head(wt) else { return Ok(()) };
    let Some(verdict) = git.merge_proof(wt, &head).0 else { return Ok(()) };
    let by = format!("{}{head}", defaults::text("mesh_write.merged_setby_prefix"));
    st.set_gate(id, defaults::text("mesh_write.gate_merged_verified"), verdict, &by, now).map_err(|e| e.to_string())?;
    if !verdict {
        eprintln!("{}", defaults::text("devswarm_cli.msg_gate_merged_unverified"));
    }
    Ok(())
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

/// `rehomeStrandedProjectDescriptors(home, ctx)`: a descriptor of the workspaces directory that sits in the legacy hash bucket of its
/// own id (its persisted owner key is the hash of its id) while its worktree belongs to THIS project is moved into the project's
/// store, under the id's lock. A move that cannot be made leaves the descriptor where it is (fail-open: the list read goes on).
fn rehome_stranded(inv: &Inv, repo_key: &str) -> R<()> {
    let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(()) };
    let suffix = defaults::text("mesh_write.json_suffix");
    let st = inv.settings();
    // the sync context carries the plugin root, which the move does not read
    let root = defaults::root().unwrap_or_default();
    let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &root, st: &st, now: inv.now, engine_pokes: false };
    for e in rd.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if !is_safe_id(id) {
            continue;
        }
        let Some(d) = ident::read_descriptor(&inv.home, id) else { continue };
        // `String(desc.id) !== String(id)`
        if crate::meshw::appverbs::concat(d.get("id")) != id {
            continue;
        }
        // a worktree path that is not a string cannot resolve to a project (`descriptorFreshRepoKey` is null for it)
        let Some(OVal::Str(wt)) = d.get(defaults::text("mesh_write.field_worktree_path")).filter(|w| w.truthy()) else { continue };
        // a descriptor whose worktree is gone and that already has an archived marker is the stale shape this sweep leaves to the owner
        let archived = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{suffix}"));
        if !std::path::Path::new(wt).exists() && archived.exists() {
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
        if ident::repo_key_for_worktree(wt)?.as_deref() != Some(repo_key) {
            continue;
        }
        crate::meshw::mark_committed();
        crate::dssup::recon::rehome::core(&ctx, id, repo_key);
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
        rehome_stranded(inv, k)?;
    }
    // outside a project, Node reads the default bucket (`hashFromWorkspaceId(undefined)`), creating its store where it is absent
    let repo_key = match repo_key {
        Some(k) => k,
        None => {
            let k = crate::meshw::send::hash_from_workspace_id("");
            common::init_new_store(inv, &k)?;
            k
        }
    };
    let st = common::open_store(inv, &repo_key)?;
    let sum = summary::compute(&st, inv, None)?;
    // `Object.values(sum.workspaces || {})`: the summary always holds the workspaces object (`summary::compute` builds it), and
    // the values come in JavaScript's key order (integer-like keys first)
    let rows: Vec<OVal> = match sum.get("workspaces") {
        Some(OVal::Obj(all)) => crate::meshw::appverbs::js_entries(all).into_iter().map(|(_, v)| v.clone()).collect(),
        _ => Vec::new(),
    };
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meshw::store::MeshStore;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-wsverbs-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    fn inv(home: &Path, cwd: &Path) -> Inv {
        Inv {
            home: home.to_path_buf(),
            write_home: home.to_path_buf(),
            env: Default::default(),
            cwd: cwd.to_string_lossy().into_owned(),
            now: 1_000_000,
            stdin: None,
            store_override: None,
        }
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn descriptor(home: &Path, id: &str, worktree: &Path, extra: &str) {
        let dir = devswarm_root(home).join("workspaces");
        std::fs::create_dir_all(&dir).unwrap();
        let text = format!(r#"{{"id":"{id}","worktreePath":"{}","sessionId":"s1"{extra}}}"#, worktree.display());
        std::fs::write(dir.join(format!("{id}.json")), text).unwrap();
    }

    fn args(words: &[&str]) -> Args {
        crate::meshw::args::parse(&words.iter().map(|w| (*w).to_string()).collect::<Vec<_>>())
    }

    /// A caller outside any project gates in the legacy per-id bucket (`hashFromWorkspaceId(id)`), which Node creates on the way.
    #[test]
    fn a_gate_outside_any_project_lands_in_the_legacy_bucket() {
        let home = scratch("noproject-home");
        let cwd = scratch("noproject-cwd");
        descriptor(&home, "ws-1", &cwd, "");
        let ans = run_gate(&inv(&home, &cwd), &args(&["gate", "ws-1", "--set", "done"])).unwrap();
        assert!(ans.stdout.contains(r#""tracked":false"#), "{}", ans.stdout);
        let bucket = devswarm_root(&home).join("store").join(hash_from_workspace_id("ws-1"));
        let conn = rusqlite::Connection::open(bucket.join(defaults::text("mesh_write.store_file"))).unwrap();
        let gate: (String, i64) = conn.query_row("SELECT gate_name, value FROM gates WHERE workspace_id = 'ws-1'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(gate, ("done".to_string(), 1));
    }

    /// `gate --set merged` records git's proof beside the gate, bound to the HEAD it was computed at: a yes when HEAD is in the remote
    /// default branch, a no (also said on stderr) when it is not, nothing when git cannot say.
    #[test]
    fn setting_merged_records_the_merge_proof_bound_to_head() {
        let root = scratch("merged");
        let (origin, work) = (root.join("origin.git"), root.join("work"));
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "--bare", "-b", "main"]);
        git(&root, &["clone", "-q", origin.to_str().unwrap(), "work"]);
        git(&work, &["config", "user.email", "t@example.invalid"]);
        git(&work, &["config", "user.name", "t"]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(&work, &["push", "-q", "origin", "HEAD:main"]);
        git(&work, &["remote", "set-head", "origin", "main"]);
        let head = git(&work, &["rev-parse", "HEAD"]);
        let st = MeshStore::open(&root.join("store.db")).unwrap();
        let desc = OVal::parse(&format!(r#"{{"id":"w","worktreePath":"{}"}}"#, work.display())).unwrap();
        let verified = || -> Vec<(bool, String)> {
            let conn = rusqlite::Connection::open(root.join("store.db")).unwrap();
            let mut q = conn.prepare("SELECT value, set_by FROM gates WHERE workspace_id = 'w' AND gate_name = 'merged_verified' ORDER BY rowid").unwrap();
            q.query_map([], |r| Ok((r.get::<_, i64>(0)? == 1, r.get::<_, String>(1)?))).unwrap().map(Result::unwrap).collect()
        };
        record_merge_proof(&st, "w", Some(&desc), 5).unwrap();
        let prefix = defaults::text("mesh_write.merged_setby_prefix");
        assert_eq!(verified(), vec![(true, format!("{prefix}{head}"))]);
        git(&work, &["commit", "-q", "--allow-empty", "-m", "two"]);
        let head2 = git(&work, &["rev-parse", "HEAD"]);
        record_merge_proof(&st, "w", Some(&desc), 6).unwrap();
        assert_eq!(verified().last(), Some(&(false, format!("{prefix}{head2}"))));
        let before = verified().len();
        record_merge_proof(&st, "w", None, 7).unwrap();
        record_merge_proof(&st, "w", Some(&OVal::parse(r#"{"worktreePath":5}"#).unwrap()), 7).unwrap();
        assert_eq!(verified().len(), before, "no worktree, or one that is no path: no proof, nothing recorded");
    }

    /// `Object.values` lists integer-like workspace ids first, ascending; a workspace list answers instead of handing the order to Node.
    #[test]
    fn workspaces_list_orders_integer_like_ids_first() {
        let home = scratch("list-home");
        let cwd = scratch("list-cwd");
        let db = home.join("fixture.db");
        let st = MeshStore::open(&db).unwrap();
        for id in ["beta", "10", "9", "alpha"] {
            st.upsert_registry(
                &crate::meshw::store::RegistryRow { id: id.into(), worktree_path: Some(format!("/w/{id}")), ..Default::default() },
                1,
                |a, b| a == b,
            )
            .unwrap();
        }
        let mut i = inv(&home, &cwd);
        i.store_override = Some(db);
        let ans = run_workspaces(&i, &args(&["workspaces", "list"])).unwrap();
        let ids: Vec<String> = OVal::parse(ans.stdout.trim())
            .and_then(|v| match v.get("workspaces") {
                Some(OVal::Arr(rows)) => Some(rows.iter().map(|r| crate::meshw::appverbs::concat(r.get("id"))).collect()),
                _ => None,
            })
            .unwrap_or_default();
        assert_eq!(ids, ["9", "10", "alpha", "beta"], "{}", ans.stdout);
    }

    /// A descriptor stranded in the legacy hash bucket whose worktree belongs to this project is moved into the project's store before
    /// `workspaces list` reads, as `rehomeStrandedProjectDescriptors` does; a descriptor of another project stays where it is.
    #[test]
    fn workspaces_list_rehomes_a_stranded_descriptor_of_this_project() {
        let home = scratch("rehome-home");
        let repo = scratch("rehome-repo");
        git(&repo, &["init", "-q", "-b", "main"]);
        let i = inv(&home, &repo);
        let key = ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().unwrap();
        let bucket = hash_from_workspace_id("stranded-1");
        assert_ne!(key, bucket);
        descriptor(&home, "stranded-1", &repo, &format!(r#","ownerKey":"{bucket}""#));
        common::init_new_store(&i, &bucket).unwrap();
        let from = common::open_store(&i, &bucket).unwrap();
        let row = crate::meshw::store::RegistryRow {
            id: "stranded-1".into(),
            worktree_path: Some(repo.to_string_lossy().into_owned()),
            session_id: Some("s1".into()),
            ..Default::default()
        };
        from.upsert_registry(&row, 1, |a, b| a == b).unwrap();
        let ids = |k: &str| -> Vec<String> {
            common::open_store(&i, k).unwrap().reader().roster().unwrap().iter().filter_map(|r| r["id"].as_str().map(str::to_string)).collect()
        };
        assert_eq!(ids(&bucket), ["stranded-1"]);
        let ans = run_workspaces(&i, &args(&["workspaces", "list"])).unwrap();
        assert!(ans.stdout.contains(r#""ok":true"#), "{}", ans.stdout);
        assert_eq!(ids(&key), ["stranded-1"], "the row now lives in the project's store");
        assert!(ids(&bucket).is_empty(), "and no longer in the legacy bucket");
    }
}
