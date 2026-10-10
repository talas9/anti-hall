//! The DevSwarm CLI verbs of lane dsB: `merge`, the maintenance verbs `reconcile-registry`, `reap-stale`, `reconcile-active`
//! and `auto-archive`, and the guarded fronts of `spawn` and `respawn`.
//!
//! The rules are those of the other CLI verbs ([`crate::meshw::lifeverbs`]): the engine answers what it can reproduce byte for
//! byte, decides every deferral BEFORE the first write or the first `hivecontrol` call that can change anything (exit 75,
//! nothing done, Node then runs the verb), and after that point nothing defers any more (`mark_committed`: a late failure exits
//! 70 and Node never repeats the action).
//!
//! * `merge` is the pass-through: `hivecontrol workspace check-merge`, then `workspace merge-into-source <argv>`, with the
//!   argument vector Node builds, and the broadcast of the outcome to the mesh. Node's witness would merge a second time, so
//!   this verb has none (see `extverbs::witnessed`).
//! * `reconcile-registry` is report-only: one `workspace list all` (a read) and the drift between it and the registry.
//! * `reap-stale` and `reconcile-active` answer their dry runs, and a confirmed run with nothing to archive; archiving a
//!   workspace is the `archive` verb's job (the app leg), which stays Node's, so any run that would archive defers.
//! * `auto-archive` answers when the app database is absent; the candidate evaluation (git proofs, transcripts, mail) is Node's.
//! * `spawn` and `respawn`: the refusals that need no `hivecontrol` call, git fetch or wall clock. The create path
//!   (source-freshness fetch, launch poll, timings, wake coverage) and the respawn path (git park, handover, create) are Node's.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::{OVal, is_array_index_key};
use crate::defaults;
use crate::dsact::runner::System;
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s, s_or_null};
use crate::meshw::gitverbs::csv_list;
use crate::meshw::hivecontrol::{self, Gate};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::send::{Answer, Effect};
use crate::meshw::store;

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

fn text(key: &str) -> &'static str {
    defaults::text(key)
}

fn tpl(key: &str, args: &[(&str, &str)]) -> String {
    crate::meshw::extverbs::tpl(key, args)
}

fn strs(v: &[String]) -> OVal {
    OVal::Arr(v.iter().map(|x| s(x)).collect())
}

/// `{ ok: false, ...fields }` with the keys in the order given.
fn failure(fields: &[(&str, OVal)]) -> Obj {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false));
    for (k, v) in fields {
        o.put(k, v.clone());
    }
    o
}

// ---- merge --------------------------------------------------------------------------------------------------------------

/// What the broadcast of the outcome needs, settled before `hivecontrol` runs.
struct Broadcast {
    repo_key: String,
    store: crate::meshw::store::MeshStore,
    from: String,
}

/// `merge <hivecontrol merge-into-source argv>`.
pub fn merge(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let (check, into) = (text("devswarm_cli.hc_check_merge"), text("devswarm_cli.hc_merge_into_source"));
    // both calls go through Node's capability gate; a build whose cache the engine cannot read (or that lacks the verb) is Node's
    for verb in [check, into] {
        if hivecontrol::gate_verb(&inv.env, &inv.home, verb, None) != Gate::Spawn {
            return defer("hivecontrol-gate");
        }
    }
    // the broadcast is prepared BEFORE the merge runs: everything that could defer is decided while nothing has happened yet
    let broadcast = match ident::repo_key_for_worktree(&inv.cwd)? {
        None => None,
        Some(repo_key) => {
            let st = common::open_store(inv, &repo_key)?;
            let rows = ident::rows_of(&st.reader().roster().map_err(|e| ident::Defer(format!("registry:{e}")))?);
            let who = ident::sender_identity_detailed(&inv.env, &inv.cwd, &rows, &inv.home)?;
            if who.kind == text("mesh_write.kind_child") {
                // writeAlias(...) is a no-op only when the alias already says so
                let label = who.mesh_id.clone().unwrap_or_default();
                if !common::read_aliases(&inv.home).into_iter().any(|(k, v)| k == label && v == who.identity) {
                    return defer("sender-alias");
                }
            }
            crate::meshw::summary::check(&st, inv, None)?;
            Some(Broadcast { repo_key, store: st, from: who.identity })
        }
    };
    let rest: Vec<&str> = a.raw.iter().skip(1).map(String::as_str).collect();
    let unbounded = defaults::millis("devswarm_cli.hc_unbounded_ms");
    let ws = text("devswarm_cli.hc_workspace");
    // `check-merge` may create a source worktree: from here on the verb has acted
    crate::meshw::mark_committed();
    let checked = hivecontrol::call_in(&[ws, check], &inv.env, Some(&inv.cwd), unbounded);
    let check_merge = if checked.ok { OVal::parse(&checked.raw).unwrap_or(OVal::Null) } else { OVal::Null };
    let mut margs: Vec<&str> = vec![ws, into];
    margs.extend(rest);
    let res = hivecontrol::call_in(&margs, &inv.env, Some(&inv.cwd), unbounded);
    let merged = res.ok;
    let error = if res.error.is_empty() { text("devswarm_cli.merge_error_default").to_string() } else { res.error.clone() };
    let bcast = match broadcast {
        None => failure(&[("reason", s(text("devswarm_cli.reason_no_project")))]).done(),
        Some(b) => {
            // `Number.isFinite(ctx.now) ? ctx.now : Date.now()`: the real CLI sets no clock, so it is the time after the merge
            let now = if defaults::env_var("mesh_now").is_some() { inv.now } else { common::now_ms() };
            let summary = if merged {
                text("devswarm_cli.merge_summary_ok").to_string()
            } else {
                let why = if res.error.is_empty() { text("devswarm_cli.merge_error_unknown") } else { res.error.as_str() };
                tpl("devswarm_cli.merge_summary_failed", &[("error", why)])
            };
            let urgency = text(if merged { "devswarm_cli.urgency_normal" } else { "devswarm_cli.urgency_high" });
            let mtype = text("mesh_write.mtype_broadcast");
            let hash = store::mesh_message_hash(Some(&b.from), None, mtype, urgency, &summary, &now.to_string(), false);
            let nonce = ident::reader_nonce(&inv.home);
            let row = store::mesh_message_row(Some(&b.from), None, true, &summary, now, urgency, &hash, false, nonce.as_deref());
            let appended = b.store.append_mesh_row(&row).map_err(|e| ident::Defer(format!("append:{e}")))?;
            let mut at = inv.clone();
            at.now = now;
            if let Some(why) = crate::meshw::summary::derive_after_write(&b.store, &at, &b.repo_key) {
                crate::meshw::log_summary_failure(text("devswarm_cli.verb_merge"), &why);
            }
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(true)).put("sent", OVal::Bool(appended.inserted)).put("seq", appended.seq.map_or(OVal::Null, |x| n(x as f64)));
            o.done()
        }
    };
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(merged)).put("action", s(text("devswarm_cli.action_merge"))).put("checkMerge", check_merge).put("merged", OVal::Bool(merged));
    if !merged {
        o.put("error", s(&error));
    }
    o.put("raw", s(&res.raw)).put("broadcast", bcast);
    Ok(answer(if merged { 0 } else { 2 }, o.done()))
}

// ---- reconcile-registry -------------------------------------------------------------------------------------------------

/// A workspace record of `hivecontrol workspace list all` as `parseChildrenList` keeps it.
struct Listed {
    path: Option<String>,
    label: Option<String>,
}

/// `Object.keys(o)`: the integer-like keys first in ascending order, then the others in insertion order.
fn js_keys(kv: &[(String, OVal)]) -> Vec<String> {
    let mut ints: Vec<(u64, &String)> = kv.iter().filter(|(k, _)| is_array_index_key(k)).filter_map(|(k, _)| Some((k.parse().ok()?, k))).collect();
    ints.sort_by_key(|(n, _)| *n);
    ints.into_iter().map(|(_, k)| k.clone()).chain(kv.iter().filter(|(k, _)| !is_array_index_key(k)).map(|(k, _)| k.clone())).collect()
}

/// A JavaScript-falsy value (`null`, `false`, `0`, `""`, absent) or a string; any other type is not one the engine mirrors.
fn str_or_falsy(v: Option<&OVal>) -> R<Option<String>> {
    match v {
        None | Some(OVal::Null | OVal::Bool(false)) => Ok(None),
        Some(OVal::Num(x)) if *x == 0.0 => Ok(None),
        Some(OVal::Str(t)) if t.is_empty() => Ok(None),
        Some(OVal::Str(t)) => Ok(Some(t.clone())),
        Some(_) => defer("record-field-type"),
    }
}

/// `reconcile-registry`: report the drift between the registry and `hivecontrol workspace list all`. Nothing is changed.
pub fn reconcile_registry(inv: &Inv, _a: &Args) -> R<Answer> {
    let action = text("devswarm_cli.action_reconcile_registry");
    let refusal = |reason: &str, error: String, extra: &[(&str, OVal)]| {
        let mut f: Vec<(&str, OVal)> = vec![("action", s(action)), ("reason", s(reason)), ("error", s(&error))];
        f.extend(extra.iter().cloned());
        answer(2, failure(&f).done())
    };
    let Some(repo_key) = ident::resolve_context(&inv.cwd, true)?.repo_key else {
        return Ok(refusal(text("devswarm_cli.reason_no_project"), text("devswarm_cli.msg_rr_no_project").to_string(), &[]));
    };
    // the call is a read; a build whose capability cache the engine cannot read is Node's
    let args: Vec<&str> = defaults::list("devswarm_cli.rr_list_args");
    if hivecontrol::gate(&inv.env, &inv.home) != Gate::Spawn {
        return defer("hivecontrol-gate");
    }
    let c = hivecontrol::call_in(&args, &inv.env, Some(&inv.cwd), defaults::millis("mesh_write.hivecontrol_timeout_ms"));
    let unavailable = text("devswarm_cli.reason_hc_unavailable");
    if !c.ok {
        let why = if c.error.is_empty() { text("devswarm_cli.rr_no_output") } else { c.error.as_str() };
        return Ok(refusal(unavailable, tpl("devswarm_cli.msg_rr_list_failed", &[("error", why)]), &[]));
    }
    let shape = text("devswarm_cli.reason_hc_shape");
    let Some(parsed) = OVal::parse(&c.raw) else {
        return Ok(refusal(shape, text("devswarm_cli.msg_rr_unparseable").to_string(), &[("rawKeys", OVal::Arr(Vec::new()))]));
    };
    let list: &[OVal] = match &parsed {
        OVal::Arr(l) => l,
        o @ OVal::Obj(_) => match o.get(text("devswarm_cli.rr_children_key")) {
            Some(OVal::Arr(l)) => l,
            _ => {
                let keys = match &parsed {
                    OVal::Obj(kv) => js_keys(kv).iter().map(|k| s(k)).collect(),
                    _ => Vec::new(),
                };
                return Ok(refusal(shape, text("devswarm_cli.msg_rr_not_list").to_string(), &[("rawKeys", OVal::Arr(keys))]));
            }
        },
        _ => return Ok(refusal(shape, text("devswarm_cli.msg_rr_not_list").to_string(), &[("rawKeys", OVal::Arr(Vec::new()))])),
    };
    // `e && typeof e === 'object'`: an array is an object too, and its keys are indices; the engine leaves that to Node
    let mut records: Vec<&OVal> = Vec::new();
    for e in list {
        match e {
            OVal::Obj(_) => records.push(e),
            OVal::Arr(_) => return defer("record-array"),
            _ => {}
        }
    }
    if !records.is_empty() {
        let mut seen: Vec<String> = Vec::new();
        for r in &records {
            if let OVal::Obj(kv) = r {
                for k in js_keys(kv) {
                    if !seen.contains(&k) {
                        seen.push(k);
                    }
                }
            }
        }
        let missing: Vec<String> = defaults::list("devswarm_cli.rr_expected_fields")
            .iter()
            .filter(|f| {
                if **f == text("devswarm_cli.rr_field_path") {
                    !seen.iter().any(|k| k == text("devswarm_cli.rr_field_path") || k == text("devswarm_cli.rr_field_worktree_path"))
                } else {
                    !seen.iter().any(|k| k == **f)
                }
            })
            .map(|f| (*f).to_string())
            .collect();
        if !missing.is_empty() {
            return Ok(refusal(
                shape,
                tpl("devswarm_cli.msg_rr_missing", &[("fields", &missing.join(", "))]),
                &[("missingFields", strs(&missing)), ("rawKeys", strs(&seen))],
            ));
        }
    }
    // parseChildrenList(...).filter(e => e.id): a Map keyed by String(id), a repeated id keeps its first place and its last value
    let mut listed: Vec<(String, Listed)> = Vec::new();
    for r in &records {
        let Some(id) = str_or_falsy(r.get("id"))? else { continue };
        let path = match str_or_falsy(r.get("path"))? {
            Some(p) => Some(p),
            None => str_or_falsy(r.get("worktreePath"))?,
        };
        let label = match r.get("label") {
            Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
            _ => None,
        };
        let entry = Listed { path, label };
        match listed.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = entry,
            None => listed.push((id, entry)),
        }
    }
    // the registry is read after the call, as Node does; a project with no store yet is created by Node's open
    let Some(_reader) = crate::meshw::tick::open_reader(inv, &repo_key)? else { return defer("no-store") };
    let st = common::open_store(inv, &repo_key)?;
    let roster = st.reader().roster().map_err(|e| ident::Defer(format!("registry:{e}")))?;
    let rows = ident::rows_of(&roster);
    // a registry row with an empty id is a key of its own in Node's map
    if rows.iter().any(|d| d.id.is_empty()) {
        return defer("registry-empty-id");
    }
    let (mut without_ws, mut without_reg, mut mismatch) = (Vec::new(), Vec::new(), Vec::new());
    for d in &rows {
        let Some((_, w)) = listed.iter().find(|(k, _)| *k == d.id) else {
            let mut o = Obj::default();
            o.put("id", s(&d.id)).put("worktreePath", s_or_null(d.worktree_path.as_deref().filter(|p| !p.is_empty())));
            without_ws.push(o.done());
            continue;
        };
        let a = d.worktree_path.as_deref().filter(|p| !p.is_empty());
        let b = w.path.as_deref();
        if let (Some(a), Some(b)) = (a, b)
            && ident::worktree_real_path(a)? != ident::worktree_real_path(b)?
        {
            let mut o = Obj::default();
            o.put("id", s(&d.id)).put("registryWorktreePath", s(a)).put("hivecontrolPath", s(b));
            mismatch.push(o.done());
        }
    }
    for (id, w) in &listed {
        if !rows.iter().any(|d| d.id == *id) {
            let mut o = Obj::default();
            o.put("id", s(id)).put("path", s_or_null(w.path.as_deref())).put("label", s_or_null(w.label.as_deref()));
            without_reg.push(o.done());
        }
    }
    let drift = without_ws.len() + without_reg.len() + mismatch.len();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(action))
        .put("repoKey", s(&repo_key))
        .put("reportOnly", OVal::Bool(true))
        .put("registryCount", n(rows.len() as f64))
        .put("hivecontrolCount", n(listed.len() as f64))
        .put("driftCount", n(drift as f64))
        .put("registryWithoutWorkspace", OVal::Arr(without_ws))
        .put("workspaceWithoutRegistry", OVal::Arr(without_reg))
        .put("worktreePathMismatch", OVal::Arr(mismatch))
        .put("note", s(text("devswarm_cli.msg_rr_note")));
    Ok(answer(0, o.done()))
}

// ---- reap-stale and reconcile-active ------------------------------------------------------------------------------------

/// One descriptor of THIS project (`projectScopedDescriptors`): the accepted descriptors whose physical owner key is the project's.
struct Scoped {
    id: String,
    worktree: String,
}

fn scoped_descriptors(inv: &Inv, repo_key: &str) -> R<Vec<Scoped>> {
    let mut out = Vec::new();
    for d in crate::dssup::liveness::read_descriptors(&inv.home) {
        // `isSafeId(d.id) && d.worktreePath` hold for what readDescriptors accepts; the owner key is the persisted one, else the worktree's
        if crate::meshw::roster::physical_owner_key(&d.raw)?.as_deref() != Some(repo_key) {
            continue;
        }
        let Some(OVal::Str(wt)) = d.raw.get(text("mesh_write.field_worktree_path")) else { return defer("descriptor-field-type") };
        out.push(Scoped { id: d.id.clone(), worktree: wt.clone() });
    }
    Ok(out)
}

/// `readPersistedVerdictStatus(id)`: the `status` string of `liveness/<id>.json`, else none.
fn verdict_status(inv: &Inv, id: &str) -> Option<String> {
    let p = devswarm_root(&inv.home).join(text("devswarm_cli.dir_liveness")).join(format!("{id}{}", text("mesh_write.json_suffix")));
    match OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))?.get("status") {
        Some(OVal::Str(t)) => Some(t.clone()),
        _ => None,
    }
}

/// `hasRecentWorktreeActivity(wt, now, idleMs)`: the worktree exists and its last commit is within `idle_ms` of now.
fn recent_activity(wt: &str, now: f64, idle_ms: f64) -> bool {
    if !std::path::Path::new(wt).exists() {
        return false;
    }
    crate::dssup::liveness::worktree_activity(&System::configured(), wt).is_some_and(|t| now - t <= idle_ms)
}

fn has_confirm(a: &Args) -> bool {
    a.has(text("devswarm_cli.flag_yes")) || a.has(text("devswarm_cli.flag_confirm"))
}

/// `reap-stale [--yes|--confirm]`: workspaces whose persisted verdict is stale or escalated, with no fresh heartbeat and no recent
/// commit. A run that would archive one is Node's (`archive` is the app leg).
pub fn reap_stale(inv: &Inv, a: &Args) -> R<Answer> {
    let action = text("devswarm_cli.action_reap_stale");
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else {
        return Ok(answer(2, failure(&[("reason", s(text("devswarm_cli.reason_no_project")))]).done()));
    };
    let now = inv.now as f64;
    let idle_ms = defaults::num("devswarm_cli.reap_idle_ms") as f64;
    let fresh_ms = defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64;
    let states = defaults::list("devswarm_cli.reap_stale_states");
    let (mut candidates, mut skipped) = (Vec::new(), Vec::new());
    for d in scoped_descriptors(inv, &repo_key)? {
        let status = verdict_status(inv, &d.id);
        let Some(status) = status.filter(|t| states.contains(&t.as_str())) else { continue };
        let skip = |reason: &str| {
            let mut o = Obj::default();
            o.put("id", s(&d.id)).put("reason", s(reason));
            o.done()
        };
        if crate::dssup::liveness::is_fresh(crate::dssup::liveness::heartbeat_ts(&inv.home, &d.id), now, fresh_ms) {
            skipped.push(skip(text("devswarm_cli.reap_skip_heartbeat")));
            continue;
        }
        if recent_activity(&d.worktree, now, idle_ms) {
            skipped.push(skip(text("devswarm_cli.reap_skip_activity")));
            continue;
        }
        let mut o = Obj::default();
        o.put("id", s(&d.id)).put("status", s(&status)).put("worktreePath", s(&d.worktree));
        candidates.push(o.done());
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("action", s(action)).put("repoKey", s(&repo_key));
    if !has_confirm(a) {
        o.put("dryRun", OVal::Bool(true))
            .put("count", n(candidates.len() as f64))
            .put("candidates", OVal::Arr(candidates))
            .put("skipped", OVal::Arr(skipped))
            .put("note", s(text("devswarm_cli.msg_reap_stale_note")));
        return Ok(answer(0, o.done()));
    }
    if !candidates.is_empty() {
        return defer("archive");
    }
    o.put("dryRun", OVal::Bool(false)).put("count", n(0.0)).put("archived", OVal::Arr(Vec::new())).put("skipped", OVal::Arr(skipped));
    Ok(answer(0, o.done()))
}

/// `activeMatches(id)`: a token is the id, a prefix of at least four characters, or (eight or more) a part of it.
fn active_matches(tokens: &[String], id: &str) -> bool {
    let (min_prefix, min_part) = (defaults::num("devswarm_cli.ra_min_prefix") as usize, defaults::num("devswarm_cli.ra_min_part") as usize);
    tokens.iter().any(|t| {
        if t.is_empty() {
            return false;
        }
        let len = t.encode_utf16().count();
        id == t || (len >= min_prefix && id.starts_with(t.as_str())) || (len >= min_part && id.contains(t.as_str()))
    })
}

/// `reconcile-active --active ID,... [--allow-empty] [--yes|--confirm]`: workspaces absent from the active set that the DevSwarm
/// app's database proves archived. A run that would archive one is Node's.
pub fn reconcile_active(inv: &Inv, a: &Args) -> R<Answer> {
    let action = text("devswarm_cli.action_reconcile_active");
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else {
        return Ok(answer(2, failure(&[("reason", s(text("devswarm_cli.reason_no_project")))]).done()));
    };
    // `--stdin` reads fd 0
    if a.has(text("devswarm_cli.flag_stdin")) {
        return defer("stdin");
    }
    let tokens = csv_list(a, text("devswarm_cli.flag_active"));
    if tokens.is_empty() && !a.has(text("devswarm_cli.flag_allow_empty")) {
        let o = failure(&[("action", s(action)), ("repoKey", s(&repo_key)), ("error", s(text("devswarm_cli.msg_ra_empty")))]);
        return Ok(answer(2, o.done()));
    }
    let now = inv.now;
    let readable = crate::meshw::appdb::builder_states(&inv.home, &inv.env, now, false)?.is_some();
    let (mut candidates, mut kept, mut kept_not) = (Vec::new(), Vec::new(), Vec::new());
    for d in scoped_descriptors(inv, &repo_key)? {
        if active_matches(&tokens, &d.id) {
            kept.push(d.id.clone());
            continue;
        }
        let verdict = if readable { crate::meshw::appdb::archived_verdict(&inv.home, &inv.env, now, &d.id, Some(&d.worktree), false)?.0 } else { None };
        if verdict == Some(true) {
            let mut o = Obj::default();
            o.put("id", s(&d.id)).put("worktreePath", s(&d.worktree));
            candidates.push(o.done());
            continue;
        }
        kept.push(d.id.clone());
        let why = if !readable {
            text("devswarm_cli.ra_why_unreadable")
        } else if verdict == Some(false) {
            text("devswarm_cli.ra_why_active")
        } else {
            text("devswarm_cli.ra_why_unknown")
        };
        let mut o = Obj::default();
        o.put("id", s(&d.id)).put("reason", s(why));
        kept_not.push(o.done());
    }
    let db_note = text("devswarm_cli.msg_ra_db_unreadable");
    let mut o = Obj::default();
    if !has_confirm(a) {
        let ok = readable || kept_not.is_empty();
        o.put("ok", OVal::Bool(ok))
            .put("action", s(action))
            .put("repoKey", s(&repo_key))
            .put("dryRun", OVal::Bool(true))
            .put("active", strs(&tokens))
            .put("kept", strs(&kept))
            .put("keptNotArchivedInApp", OVal::Arr(kept_not))
            .put("appDb", OVal::Bool(readable))
            .put("count", n(candidates.len() as f64))
            .put("candidates", OVal::Arr(candidates))
            .put("note", s(if readable { text("devswarm_cli.msg_ra_dry_note") } else { db_note }));
        return Ok(answer(if ok { 0 } else { 2 }, o.done()));
    }
    if !readable && !kept_not.is_empty() {
        o.put("ok", OVal::Bool(false))
            .put("action", s(action))
            .put("repoKey", s(&repo_key))
            .put("dryRun", OVal::Bool(false))
            .put("reason", s(text("devswarm_cli.ra_why_unreadable")))
            .put("error", s(db_note))
            .put("active", strs(&tokens))
            .put("kept", strs(&kept))
            .put("keptNotArchivedInApp", OVal::Arr(kept_not))
            .put("appDb", OVal::Bool(false))
            .put("count", n(0.0))
            .put("archived", OVal::Arr(Vec::new()));
        return Ok(answer(2, o.done()));
    }
    if !candidates.is_empty() {
        return defer("archive");
    }
    o.put("ok", OVal::Bool(true))
        .put("action", s(action))
        .put("repoKey", s(&repo_key))
        .put("dryRun", OVal::Bool(false))
        .put("active", strs(&tokens))
        .put("kept", strs(&kept))
        .put("keptNotArchivedInApp", OVal::Arr(kept_not))
        .put("appDb", OVal::Bool(readable))
        .put("count", n(0.0))
        .put("archived", OVal::Arr(Vec::new()));
    Ok(answer(0, o.done()))
}

// ---- auto-archive -------------------------------------------------------------------------------------------------------

/// `auto-archive`: the read-only plan. Answered when the app's database is not there (the plan is then the settings and nothing
/// else); with a database, the candidates are evaluated against git, transcripts and mail, which is Node's.
pub fn auto_archive(inv: &Inv, _a: &Args) -> R<Answer> {
    let present = ident::app_db_path(&inv.home, &inv.env).is_some_and(|f| std::fs::metadata(f).is_ok_and(|m| m.is_file()));
    if present {
        return defer("auto-archive-plan");
    }
    let st = crate::dsact::settings::ActSettings::read(&inv.settings());
    let mut settings = Obj::default();
    settings
        .put("mode", s(&st.mode))
        .put("idleMin", n(st.idle_min as f64))
        .put("maxPerSweep", n(st.max_per_sweep as f64))
        .put("ignorePings", OVal::Bool(st.ignore_pings));
    let mut cap = Obj::default();
    cap.put("ok", OVal::Bool(false)).put("reason", s(text("devswarm_cli.aa_cap_reason"))).put("version", OVal::Null);
    let mut o = Obj::default();
    o.put("action", s(text("devswarm_cli.action_auto_archive")))
        .put("ok", OVal::Bool(false))
        .put("reason", s(text("devswarm_cli.aa_reason_no_db")))
        .put("mode", s(&st.mode))
        .put("settings", settings.done())
        .put("capability", cap.done())
        .put("candidates", OVal::Arr(Vec::new()))
        .put("toArchive", OVal::Arr(Vec::new()));
    Ok(answer(2, o.done()))
}

// ---- spawn and respawn --------------------------------------------------------------------------------------------------

/// `spawnFlagValueError(rest)`: a value-taking create option with no value, or handed what looks like the next option.
fn spawn_flag_error(rest: &[&str]) -> R<Option<String>> {
    let flags = defaults::raw("devswarm_cli.spawn_value_flags").as_array().map(<[_]>::to_vec).unwrap_or_default();
    let option_shaped = regex::Regex::new(text("devswarm_cli.spawn_option_shape")).map_err(|_| ident::Defer("spawn-pattern".into()))?;
    for (i, a) in rest.iter().enumerate().skip(1) {
        for f in &flags {
            let (short, long) = (f.str_field("short"), f.str_field("long"));
            let any_dash = f.get("anyDash").and_then(defaults::V::as_bool) == Some(true);
            let (name, value): (String, Option<&str>) = if *a == short || *a == long {
                ((*a).to_string(), rest.get(i + 1).copied())
            } else if let Some(v) = a.strip_prefix(&format!("{long}=")) {
                (long.to_string(), Some(v))
            } else {
                continue;
            };
            let label = format!("{short}/{long}");
            let Some(value) = value.filter(|v| !v.is_empty()) else {
                return Ok(Some(tpl("devswarm_cli.msg_spawn_no_value", &[("label", &label), ("name", &name)])));
            };
            if value.chars().any(|c| text("devswarm_cli.spawn_exotic_chars").contains(c)) {
                return defer("spawn-white-space");
            }
            let bad = if any_dash { value.starts_with('-') } else { option_shaped.is_match(value) };
            if bad {
                let quoted = serde_json::to_string(value).unwrap_or_default();
                return Ok(Some(tpl("devswarm_cli.msg_spawn_bad_value", &[("label", &label), ("value", &quoted), ("name", &name), ("short", short)])));
            }
            break;
        }
    }
    Ok(None)
}

/// `spawn <branch> [create options]`: the refusals before anything is fetched or created. The create path is Node's.
pub fn spawn(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let rest: Vec<&str> = a.raw.iter().skip(1).map(String::as_str).collect();
    let Some(branch) = rest.first().filter(|b| !b.is_empty()) else {
        return Ok(answer(2, failure(&[("error", s(text("devswarm_cli.msg_spawn_no_branch")))]).done()));
    };
    let strict = crate::dsact::settings::resolve(&inv.settings(), defaults::raw("devswarm_cli.set_spawn_strict")).as_bool().unwrap_or(true);
    if !strict {
        return defer("spawn-lenient");
    }
    match spawn_flag_error(&rest)? {
        Some(error) => {
            let o = failure(&[("action", s(text("devswarm_cli.action_spawn"))), ("branch", s(branch)), ("created", OVal::Bool(false)), ("error", s(&error))]);
            Ok(answer(2, o.done()))
        }
        None => defer("spawn-create"),
    }
}

/// `respawn <id> [--dry-run]`: the usage refusal and the refusal of a caller that is not in the Primary checkout. The rest (plan,
/// warning, git park, handover, create, archive) is Node's.
pub fn respawn(inv: &Inv, a: &Args) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    let action = text("devswarm_cli.action_respawn");
    if !is_safe_id(id) {
        return Ok(answer(2, failure(&[("action", s(action)), ("error", s(text("devswarm_cli.msg_respawn_usage")))]).done()));
    }
    if !crate::meshw::actverbs::seat_not_applicable(inv)? {
        return defer("respawn-primary");
    }
    let state = text("devswarm_cli.seat_state_na");
    let o = failure(&[
        ("action", s(action)),
        ("id", s(id)),
        ("reason", s(text("devswarm_cli.respawn_reason_not_primary"))),
        ("error", s(&tpl("devswarm_cli.msg_respawn_not_primary", &[("seat", state)]))),
        ("seat", s(state)),
    ]);
    Ok(answer(2, o.done()))
}
