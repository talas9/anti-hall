//! The DevSwarm CLI verbs of lane dsB: `merge`, the maintenance verbs `reconcile-registry`, `reap-stale`, `reconcile-active`
//! and `auto-archive`, and the guarded fronts of `spawn` and `respawn`.
//!
//! The rules are those of the other CLI verbs ([`crate::meshw::lifeverbs`]): the engine answers every case byte for byte as the
//! Node verb does, and what Node's own exceptions would end in (a broadcast that cannot be sent, a store that cannot be written) is
//! reported in the verb's own answer, the way Node's `run()` reports a thrown error. `mark_committed` marks the first write: a late
//! failure after it exits 70.
//!
//! * `merge` is the pass-through: `hivecontrol workspace check-merge`, then `workspace merge-into-source <argv>`, with the
//!   argument vector Node builds, and the broadcast of the outcome to the mesh (a broadcast that fails is the `broadcast` field of
//!   the answer, never the merge's result). Both calls go through the capability gate: a build that lacks the verb answers Node's
//!   "capability dormant" error.
//! * `reconcile-registry` is report-only: one `workspace list all` (a read) and the drift between it and the registry.
//! * `reap-stale` and `reconcile-active` answer their dry runs; a confirmed run archives each candidate through the `archive` verb.
//! * `auto-archive` prints the plan the action layer would act on: the candidates, their gates and the first `maxPerSweep` eligible.
//! * `spawn` (and `create`): the option refusals here, then the create path of [`crate::meshw::spawnverb`].
//! * `respawn`: the Primary replaces a straying child with a fresh workspace that keeps its progress ([`respawn`]).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::dsact::runner::System;
use crate::meshw::appverbs::{concat, js_string};
use crate::meshw::args::Args;
use crate::meshw::common::{self, Inv, Obj, n, s, s_or_null};
use crate::meshw::gitverbs::csv_list;
use crate::meshw::hivecontrol::{self, Cap};
use crate::meshw::ident::{self, R};
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

/// The answer of a verb whose Node code threw: `run()` catches the exception and prints `{ ok: false, error: <message> }` with exit 2.
fn thrown(e: &dyn std::fmt::Display) -> String {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(&e.to_string()));
    o.done().stringify()
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

// ---- the capability gate ------------------------------------------------------------------------------------------------

/// `Date.now()`: the pinned clock of a test run, else the wall clock.
fn clock(inv: &Inv) -> i64 {
    if defaults::env_var("mesh_now").is_some() { inv.now } else { common::now_ms() }
}

/// `hcRun(spec)` for `hivecontrol workspace <verb>`: the call in the caller's working directory, or Node's dormant answer when the
/// build lacks the verb (`capability dormant: workspace.<verb> — <reason>`, nothing spawned). A cache with no entry for this build
/// is filled first by the capability probe (read-only `--version` / `--help`).
fn gated_call(inv: &Inv, verb: &str, args: &[&str], timeout: std::time::Duration) -> hivecontrol::Call {
    let mut cap = hivecontrol::cap_verb(&inv.env, &inv.home, verb, None, None);
    if cap == Cap::Probe {
        crate::dssup::recon::capprobe::ensure(&inv.home, clock(inv), &inv.env, &System::configured(), verb);
        cap = hivecontrol::cap_verb(&inv.env, &inv.home, verb, None, None);
    }
    if let Cap::Dormant(reason) = cap {
        let name = format!("{}{verb}", text("devswarm_cli.hc_cap_prefix"));
        let error = defaults::render("devswarm_recon.msg_capability_dormant", &[("name", &name), ("reason", &reason)]);
        return hivecontrol::Call { error, ..hivecontrol::Call::default() };
    }
    hivecontrol::call_in(args, &inv.env, Some(&inv.cwd), timeout)
}

// ---- merge --------------------------------------------------------------------------------------------------------------

/// The broadcast of a merge's outcome (`send --broadcast` to the project's mesh). `Err` is the exception Node's `try` catches: the
/// broadcast field then says `{ ok: false, error }` and the merge's own result stands.
fn broadcast_outcome(inv: &Inv, merged: bool, error: &str) -> Result<OVal, String> {
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd).map_err(|d| d.0)? else {
        return Ok(failure(&[("reason", s(text("devswarm_cli.reason_no_project")))]).done());
    };
    let st = common::open_store(inv, &repo_key).map_err(|d| d.0)?;
    let rows = ident::rows_of(&st.reader().roster().map_err(|e| e.to_string())?);
    let who = ident::sender_identity_detailed(&inv.env, &inv.cwd, &rows, &inv.home).map_err(|d| d.0)?;
    // writeAlias(...): a no-op when the alias already says so
    common::ensure_alias(inv, &who, &inv.cwd);
    crate::meshw::summary::check(&st, inv, None).map_err(|d| d.0)?;
    // `Number.isFinite(ctx.now) ? ctx.now : Date.now()`: the real CLI sets no clock, so it is the time after the merge
    let now = clock(inv);
    let summary = if merged {
        text("devswarm_cli.merge_summary_ok").to_string()
    } else {
        let why = if error.is_empty() { text("devswarm_cli.merge_error_unknown") } else { error };
        tpl("devswarm_cli.merge_summary_failed", &[("error", why)])
    };
    let urgency = text(if merged { "devswarm_cli.urgency_normal" } else { "devswarm_cli.urgency_high" });
    let mtype = text("mesh_write.mtype_broadcast");
    let from = who.identity;
    let hash = store::mesh_message_hash(Some(&from), None, mtype, urgency, &summary, &now.to_string(), false);
    let nonce = ident::reader_nonce(&inv.home);
    let row = store::mesh_message_row(Some(&from), None, true, &summary, now, urgency, &hash, false, nonce.as_deref());
    let appended = st.append_mesh_row(&row).map_err(|e| e.to_string())?;
    let mut at = inv.clone();
    at.now = now;
    if let Some(why) = crate::meshw::summary::derive_after_write(&st, &at, &repo_key) {
        crate::meshw::log_summary_failure(text("devswarm_cli.verb_merge"), &why);
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true)).put("sent", OVal::Bool(appended.inserted)).put("seq", appended.seq.map_or(OVal::Null, |x| n(x as f64)));
    Ok(o.done())
}

/// `merge <hivecontrol merge-into-source argv>`.
pub fn merge(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let (check, into) = (text("devswarm_cli.hc_check_merge"), text("devswarm_cli.hc_merge_into_source"));
    let rest: Vec<&str> = a.raw.iter().skip(1).map(String::as_str).collect();
    let unbounded = defaults::millis("devswarm_cli.hc_unbounded_ms");
    let ws = text("devswarm_cli.hc_workspace");
    // `check-merge` may create a source worktree: from here on the verb has acted
    crate::meshw::mark_committed();
    let checked = gated_call(inv, check, &[ws, check], unbounded);
    let check_merge = if checked.ok { OVal::parse(&checked.raw).unwrap_or(OVal::Null) } else { OVal::Null };
    let mut margs: Vec<&str> = vec![ws, into];
    margs.extend(rest);
    let res = gated_call(inv, into, &margs, unbounded);
    let merged = res.ok;
    let error = if res.error.is_empty() { text("devswarm_cli.merge_error_default").to_string() } else { res.error.clone() };
    let bcast = broadcast_outcome(inv, merged, &res.error).unwrap_or_else(|why| failure(&[("error", s(&why))]).done());
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
    /// `e.path || e.worktreePath`, the first truthy value as it came.
    path: Option<OVal>,
    label: Option<String>,
}

/// `Object.keys(o)`: the integer-like keys first in ascending order, then the others in insertion order.
fn js_keys(kv: &[(String, OVal)]) -> Vec<String> {
    crate::meshw::appverbs::js_entries(kv).into_iter().map(|(k, _)| k.clone()).collect()
}

/// `String(id)` of a registry id read from the store (a string, or a number SQLite handed back).
fn registry_id(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Null => None,
        serde_json::Value::String(t) => Some(t.clone()),
        other => Some(other.to_string()),
    }
}

/// `reconcileRealPath(p)`: the worktree's real path, else `path.resolve(p)`.
fn reconcile_real_path(inv: &Inv, p: &str) -> String {
    ident::worktree_real_path(p).unwrap_or_else(|_| ident::resolve(&inv.cwd, p))
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
    // the read goes through the capability gate: a build that lacks `workspace list` answers Node's dormant error
    let args: Vec<&str> = defaults::list("devswarm_cli.rr_list_args");
    let c = gated_call(inv, text("mesh_write.hivecontrol_list_verb"), &args, defaults::millis("mesh_write.hivecontrol_timeout_ms"));
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
    // `e && typeof e === 'object'`: an array is an object too, and its keys are its indices
    let records: Vec<&OVal> = list.iter().filter(|e| matches!(e, OVal::Obj(_) | OVal::Arr(_))).collect();
    if !records.is_empty() {
        let mut seen: Vec<String> = Vec::new();
        for r in &records {
            let keys: Vec<String> = match r {
                OVal::Obj(kv) => js_keys(kv),
                OVal::Arr(items) => (0..items.len()).map(|i| i.to_string()).collect(),
                _ => Vec::new(),
            };
            for k in keys {
                if !seen.contains(&k) {
                    seen.push(k);
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
    // (an array has no `id`, so only objects list)
    let mut listed: Vec<(String, Listed)> = Vec::new();
    for r in &records {
        let Some(id_value) = r.get("id").filter(|v| v.truthy()) else { continue };
        let id = crate::meshw::appverbs::js_string(id_value);
        let path = r.get("path").filter(|v| v.truthy()).or_else(|| r.get("worktreePath").filter(|v| v.truthy())).cloned();
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
    let _reader = crate::meshw::tick::open_reader_creating(inv, &repo_key)?;
    let st = common::open_store(inv, &repo_key)?;
    let roster = match st.reader().roster() {
        Ok(r) => r,
        Err(e) => return ident::refuse(&thrown(&e)),
    };
    // regById: `registry.filter(d => d && d.id != null)` as a Map keyed by String(id) (an empty id is a key of its own)
    let mut registry: Vec<(String, Option<String>)> = Vec::new();
    for d in &roster {
        let Some(id) = registry_id(&d["id"]) else { continue };
        let wt = d["worktreePath"].as_str().filter(|p| !p.is_empty()).map(str::to_string);
        match registry.iter_mut().find(|(k, _)| *k == id) {
            Some(slot) => slot.1 = wt,
            None => registry.push((id, wt)),
        }
    }
    let (mut without_ws, mut without_reg, mut mismatch) = (Vec::new(), Vec::new(), Vec::new());
    for (id, registered) in &registry {
        let Some((_, w)) = listed.iter().find(|(k, _)| k == id) else {
            let mut o = Obj::default();
            o.put("id", s(id)).put("worktreePath", s_or_null(registered.as_deref()));
            without_ws.push(o.done());
            continue;
        };
        let a = registered.as_deref();
        let b = w.path.as_ref().map(crate::meshw::appverbs::js_string);
        if let (Some(a), Some(b)) = (a, b.as_deref())
            && reconcile_real_path(inv, a) != reconcile_real_path(inv, b)
        {
            let mut o = Obj::default();
            o.put("id", s(id)).put("registryWorktreePath", s(a)).put("hivecontrolPath", s(b));
            mismatch.push(o.done());
        }
    }
    for (id, w) in &listed {
        if !registry.iter().any(|(k, _)| k == id) {
            let mut o = Obj::default();
            o.put("id", s(id)).put("path", w.path.clone().unwrap_or(OVal::Null)).put("label", s_or_null(w.label.as_deref()));
            without_reg.push(o.done());
        }
    }
    let drift = without_ws.len() + without_reg.len() + mismatch.len();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(action))
        .put("repoKey", s(&repo_key))
        .put("reportOnly", OVal::Bool(true))
        .put("registryCount", n(registry.len() as f64))
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
    /// `d.worktreePath`, the truthy value as it came (a string in every descriptor the engine or Node writes).
    worktree: OVal,
}

impl Scoped {
    /// The path as text; `fs.existsSync` and the git helpers take nothing else, so a value of another type reads as no path.
    fn path(&self) -> &str {
        match &self.worktree {
            OVal::Str(p) => p,
            _ => "",
        }
    }
}

fn scoped_descriptors(inv: &Inv, repo_key: &str) -> R<Vec<Scoped>> {
    let mut out = Vec::new();
    for d in crate::dssup::liveness::read_descriptors(&inv.home) {
        // `isSafeId(d.id) && d.worktreePath` hold for what readDescriptors accepts; the owner key is the persisted one, else the worktree's
        if crate::meshw::roster::physical_owner_key(&d.raw)?.as_deref() != Some(repo_key) {
            continue;
        }
        let Some(wt) = d.raw.get(text("mesh_write.field_worktree_path")).filter(|w| w.truthy()) else { continue };
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
    if wt.is_empty() || !std::path::Path::new(wt).exists() {
        return false;
    }
    crate::dssup::liveness::worktree_activity(&System::configured(), wt).is_some_and(|t| now - t <= idle_ms)
}

fn has_confirm(a: &Args) -> bool {
    a.has(text("devswarm_cli.flag_yes")) || a.has(text("devswarm_cli.flag_confirm"))
}

/// What `cmdArchive(id, ctx)` came to for the one id: the archive verb's own answer, read back as the object Node's function returns.
struct Archived {
    ok: bool,
    error: Option<String>,
    /// The reason the archive was skipped by the caller's check inside the lock (nothing was archived).
    skipped: Option<String>,
}

#[allow(clippy::type_complexity)] // a skip-reason callback
fn archive_via_verb(inv: &Inv, id: &str, revalidate: Option<&dyn Fn(&OVal) -> Option<String>>) -> Archived {
    let argv = vec![text("devswarm_cli.action_archive").to_string(), id.to_string()];
    let args = crate::meshw::args::parse(&argv);
    match crate::meshw::archiveverb::archive_with(inv, &args, revalidate) {
        Ok(ans) => {
            let r = OVal::parse(ans.stdout.trim());
            let skipped = r
                .as_ref()
                .filter(|v| v.get("skipped").is_some_and(OVal::truthy))
                .map(|v| v.get("reason").map_or_else(String::new, crate::meshw::appverbs::js_string));
            let ok = r.as_ref().and_then(|v| v.get("ok")).is_some_and(OVal::truthy);
            let error = match r.as_ref().and_then(|v| v.get("error")) {
                Some(v) if v.truthy() => Some(crate::meshw::appverbs::js_string(v)),
                _ => None,
            };
            Archived { ok, error, skipped }
        }
        // the archive verb could not finish: said in the entry, the other candidates still get their turn
        Err(d) => Archived { ok: false, error: Some(d.0), skipped: None },
    }
}

/// `revalidate(desc)` of `reap-stale`: why a candidate must NOT be archived now, else `None` (the verdict is still stale or escalated,
/// no fresh heartbeat, no recent commit, and the descriptor still belongs to this project).
#[allow(clippy::too_many_arguments)] // one recheck: its inputs are the recheck
fn reap_recheck(inv: &Inv, id: &str, wt: &str, repo_key: &str, desc: &OVal, fresh_ms: f64, idle_ms: f64, states: &[&str]) -> Option<&'static str> {
    let now = clock(inv) as f64;
    if !verdict_status(inv, id).is_some_and(|t| states.contains(&t.as_str())) {
        Some(text("devswarm_cli.reap_skip_became_live"))
    } else if crate::dssup::liveness::is_fresh(crate::dssup::liveness::heartbeat_ts(&inv.home, id), now, fresh_ms) {
        Some(text("devswarm_cli.reap_skip_heartbeat"))
    } else if recent_activity(wt, now, idle_ms) {
        Some(text("devswarm_cli.reap_skip_activity"))
    } else if crate::meshw::roster::physical_owner_key(desc).ok().is_some_and(|k| k.as_deref() != Some(repo_key)) {
        // P1-6: a re-keyed or cross-project descriptor is never archived out from under its real project
        Some(text("devswarm_cli.reap_skip_ownership"))
    } else {
        None
    }
}

/// `reap-stale [--yes|--confirm]`: workspaces whose persisted verdict is stale or escalated, with no fresh heartbeat and no recent
/// commit. A confirmed run archives each candidate through the `archive` verb, re-checking the same conditions right before.
pub fn reap_stale(inv: &Inv, a: &Args) -> R<Answer> {
    let action = text("devswarm_cli.action_reap_stale");
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else {
        return Ok(answer(2, failure(&[("reason", s(text("devswarm_cli.reason_no_project")))]).done()));
    };
    let now = inv.now as f64;
    let idle_ms = defaults::num("devswarm_cli.reap_idle_ms") as f64;
    let fresh_ms = defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64;
    let states = defaults::list("devswarm_cli.reap_stale_states");
    let skip = |id: &str, reason: &str| {
        let mut o = Obj::default();
        o.put("id", s(id)).put("reason", s(reason));
        o.done()
    };
    let (mut candidates, mut kept, mut skipped) = (Vec::new(), Vec::new(), Vec::new());
    for d in scoped_descriptors(inv, &repo_key)? {
        let status = verdict_status(inv, &d.id);
        let Some(status) = status.filter(|t| states.contains(&t.as_str())) else { continue };
        if crate::dssup::liveness::is_fresh(crate::dssup::liveness::heartbeat_ts(&inv.home, &d.id), now, fresh_ms) {
            skipped.push(skip(&d.id, text("devswarm_cli.reap_skip_heartbeat")));
            continue;
        }
        if recent_activity(d.path(), now, idle_ms) {
            skipped.push(skip(&d.id, text("devswarm_cli.reap_skip_activity")));
            continue;
        }
        let mut o = Obj::default();
        o.put("id", s(&d.id)).put("status", s(&status)).put("worktreePath", d.worktree.clone());
        candidates.push(o.done());
        kept.push(d);
    }
    let mut o = Obj::default();
    if !has_confirm(a) {
        o.put("ok", OVal::Bool(true))
            .put("action", s(action))
            .put("repoKey", s(&repo_key))
            .put("dryRun", OVal::Bool(true))
            .put("count", n(candidates.len() as f64))
            .put("candidates", OVal::Arr(candidates))
            .put("skipped", OVal::Arr(skipped))
            .put("note", s(text("devswarm_cli.msg_reap_stale_note")));
        return Ok(answer(0, o.done()));
    }
    let mut archived = Vec::new();
    for c in &kept {
        // P1-5: the safety condition is re-checked INSIDE the workspace's lock, immediately before the archive writes, so a workspace
        // that heartbeats or commits after the candidates were collected is skipped, not archived
        let recheck = |desc: &OVal| -> Option<String> { reap_recheck(inv, &c.id, c.path(), &repo_key, desc, fresh_ms, idle_ms, &states).map(str::to_string) };
        let r = archive_via_verb(inv, &c.id, Some(&recheck));
        if let Some(reason) = &r.skipped {
            skipped.push(skip(&c.id, reason));
            continue;
        }
        let mut e = Obj::default();
        e.put("id", s(&c.id)).put("ok", OVal::Bool(r.ok)).put("error", s_or_null(r.error.as_deref()));
        archived.push((r.ok, e.done()));
    }
    let all_ok = archived.iter().all(|(ok, _)| *ok);
    o.put("ok", OVal::Bool(all_ok))
        .put("action", s(action))
        .put("repoKey", s(&repo_key))
        .put("dryRun", OVal::Bool(false))
        .put("count", n(archived.len() as f64))
        .put("archived", OVal::Arr(archived.into_iter().map(|(_, e)| e).collect()))
        .put("skipped", OVal::Arr(skipped));
    Ok(answer(if all_ok { 0 } else { 2 }, o.done()))
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

/// `reconcile-active --active ID,... [--stdin] [--allow-empty] [--yes|--confirm]`: workspaces absent from the active set that the
/// DevSwarm app's database proves archived; a confirmed run archives each through the `archive` verb.
pub fn reconcile_active(inv: &Inv, a: &Args) -> R<Answer> {
    let action = text("devswarm_cli.action_reconcile_active");
    let Some(repo_key) = ident::repo_key_for_worktree(&inv.cwd)? else {
        return Ok(answer(2, failure(&[("reason", s(text("devswarm_cli.reason_no_project")))]).done()));
    };
    let mut tokens = csv_list(a, text("devswarm_cli.flag_active"));
    // `--stdin` reads newline/space/comma-separated ids from fd 0 (opt-in only: a blocking read on a tty must never wedge the CLI)
    if a.has(text("devswarm_cli.flag_stdin")) {
        let raw = match &inv.stdin {
            Some(t) => t.clone(),
            None => {
                let mut b = Vec::new();
                // a read that fails is an empty body, as Node's catch makes it
                crate::discard::harmless(std::io::Read::read_to_end(&mut std::io::stdin(), &mut b)); // keep: Node's `catch (_) { raw = '' }`
                String::from_utf8_lossy(&b).into_owned()
            }
        };
        for tok in raw.split(|c: char| crate::checks::guardkit::text::is_js_space(c) || c == ',') {
            let t = crate::checks::guardkit::text::js_trim(tok);
            if !t.is_empty() && !tokens.iter().any(|x| x == t) {
                tokens.push(t.to_string());
            }
        }
    }
    if tokens.is_empty() && !a.has(text("devswarm_cli.flag_allow_empty")) {
        let o = failure(&[("action", s(action)), ("repoKey", s(&repo_key)), ("error", s(text("devswarm_cli.msg_ra_empty")))]);
        return Ok(answer(2, o.done()));
    }
    let now = inv.now;
    let readable = crate::meshw::appdb::builder_states(&inv.home, &inv.env, now, false)?.is_some();
    let (mut candidates, mut cand_ids, mut kept, mut kept_not) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for d in scoped_descriptors(inv, &repo_key)? {
        if active_matches(&tokens, &d.id) {
            kept.push(d.id.clone());
            continue;
        }
        let verdict = if readable {
            let wt = (!d.path().is_empty()).then(|| d.path().to_string());
            crate::meshw::appdb::archived_verdict(&inv.home, &inv.env, now, &d.id, wt.as_deref(), false)?.0
        } else {
            None
        };
        if verdict == Some(true) {
            let mut o = Obj::default();
            o.put("id", s(&d.id)).put("worktreePath", d.worktree.clone());
            candidates.push(o.done());
            cand_ids.push(d.id.clone());
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
    let mut archived = Vec::new();
    for id in &cand_ids {
        let r = archive_via_verb(inv, id, None);
        let mut e = Obj::default();
        e.put("id", s(id)).put("ok", OVal::Bool(r.ok)).put("error", s_or_null(r.error.as_deref()));
        archived.push((r.ok, e.done()));
    }
    let ok = archived.iter().all(|(ok, _)| *ok);
    o.put("ok", OVal::Bool(ok))
        .put("action", s(action))
        .put("repoKey", s(&repo_key))
        .put("dryRun", OVal::Bool(false))
        .put("active", strs(&tokens))
        .put("kept", strs(&kept))
        .put("keptNotArchivedInApp", OVal::Arr(kept_not))
        .put("appDb", OVal::Bool(readable))
        .put("count", n(archived.len() as f64))
        .put("archived", OVal::Arr(archived.into_iter().map(|(_, e)| e).collect()));
    Ok(answer(if ok { 0 } else { 2 }, o.done()))
}

// ---- auto-archive -------------------------------------------------------------------------------------------------------

/// A JSON number, string, bool, array or object of the action layer as the ordered value the answer is written from.
fn ov(v: &serde_json::Value) -> OVal {
    match v {
        serde_json::Value::Null => OVal::Null,
        serde_json::Value::Bool(b) => OVal::Bool(*b),
        serde_json::Value::Number(x) => n(x.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(t) => s(t),
        serde_json::Value::Array(items) => OVal::Arr(items.iter().map(ov).collect()),
        serde_json::Value::Object(m) => OVal::Obj(m.iter().map(|(k, x)| (k.clone(), ov(x))).collect()),
    }
}

/// A non-empty string field of the action layer's facts, else null (`x || null`).
fn text_or_null(v: &serde_json::Value) -> OVal {
    v.as_str().filter(|t| !t.is_empty()).map_or(OVal::Null, s)
}

/// One candidate of the plan, in the shape of `evaluateCandidate`: the workspace, the verdict, the gates that block it and the facts
/// they were decided from.
fn plan_candidate(app: &crate::devswarm_rt::sources::AppRead, d: &serde_json::Value) -> OVal {
    let f = &d["facts"];
    let id = d["id"].as_str().unwrap_or_default();
    let repository = app.builders.iter().find(|b| b.id == id).and_then(|b| b.repo.as_deref());
    let wt = f["worktreePath"].as_str().filter(|w| !w.is_empty());
    let blockers: Vec<OVal> = d["blockers"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|b| {
                    let mut o = Obj::default();
                    o.put("gate", ov(&b["gate"])).put("detail", ov(&b["detail"]));
                    o.done()
                })
                .collect()
        })
        .unwrap_or_default();
    let un = &f["unread"];
    let mut unread = Obj::default();
    unread
        .put("toChild", ov(&un["toChild"]))
        .put("toDirect", ov(&un["toDirect"]))
        .put("toBroadcast", ov(&un["toBroadcast"]))
        .put("fromChild", ov(&un["fromChild"]));
    let mut facts = Obj::default();
    facts
        .put("done", OVal::Bool(f["done"]["done"].as_bool().unwrap_or(false)))
        .put("doneVia", ov(&f["done"]["via"]))
        .put("merged", ov(&f["merged"]))
        .put("clean", ov(&f["clean"]))
        .put("unread", unread.done())
        .put("idleMin", ov(&d["idleMin"]))
        .put("idleVia", ov(&f["idle"]["via"]))
        .put("head", ov(&f["head"]));
    let mut o = Obj::default();
    o.put("id", s(id))
        .put("label", text_or_null(&f["label"]))
        .put("branch", text_or_null(&f["branch"]))
        .put("repositoryId", s_or_null(repository))
        .put("worktreePath", s_or_null(wt))
        .put("repoKey", s_or_null(wt.and_then(crate::dswire::facts::repo_key).as_deref()))
        .put("eligible", OVal::Bool(d["eligible"].as_bool() == Some(true)))
        .put("soft", OVal::Bool(d["soft"].as_bool() == Some(true)))
        .put("blockers", OVal::Arr(blockers))
        .put("facts", facts.done());
    o.done()
}

/// `auto-archive`: the read-only plan (`planAutoArchive`): which done workspaces the action layer would archive now, with the proof
/// and the blockers per row. Nothing is archived, written or spawned except git reads and `--help` probes.
pub fn auto_archive(inv: &Inv, _a: &Args) -> R<Answer> {
    let st = crate::dsact::settings::ActSettings::read(&inv.settings());
    let mut settings = Obj::default();
    settings
        .put("mode", s(&st.mode))
        .put("idleMin", n(st.idle_min as f64))
        .put("maxPerSweep", n(st.max_per_sweep as f64))
        .put("ignorePings", OVal::Bool(st.ignore_pings));
    let app = ident::app_db_path(&inv.home, &inv.env).and_then(|f| crate::devswarm_rt::sources::read_app(std::path::Path::new(&f)));
    let Some(app) = app else {
        // the app database is not there (or not readable): the plan is the settings and nothing else
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
        return Ok(answer(2, o.done()));
    };
    // the action layer over the live facts of this one run: the same decision the supervisor acts on
    let env = crate::reqenv::RequestEnv::capture();
    let det = crate::devswarm_rt::detect_with(&inv.home, &inv.env, crate::devswarm_rt::Mode::On);
    let rt = crate::devswarm_rt::Rt::new(crate::devswarm_rt::Cfg::from_defaults(), det);
    let runner = System::configured();
    // the engine state directory holds the ledger the plan reads; with no state directory there is no ledger to read
    let state_dir = crate::bootstrap::state_dir().unwrap_or_default();
    let live = crate::dswire::live::RtLive { rt: &rt, home: inv.home.clone(), runner: &runner, state_dir: state_dir.clone(), env: env.clone(), now: inv.now };
    let act = crate::dsact::exec::Act::new(&inv.home, &state_dir, env, &live, &runner);
    let (absent, version) = act.version();
    let verb = defaults::list("devswarm_act.id_verbs")[0];
    let capability = act.capability(verb);
    let mut cap = Obj::default();
    cap.put("ok", OVal::Bool(capability.is_ok()))
        .put(
            "reason",
            match &capability {
                Ok(()) => OVal::Null,
                Err(_) if absent => s(text("devswarm_cli.aa_cap_absent")),
                Err(why) => s(why),
            },
        )
        .put("version", version.map_or(OVal::Null, |v| s(&v.iter().map(u64::to_string).collect::<Vec<_>>().join("."))));
    let candidates: Vec<serde_json::Value> =
        crate::dsact::live::LiveState::candidates(&live).iter().filter_map(|id| act.auto_candidate(id, &st, false)).collect();
    let to_archive: Vec<OVal> =
        candidates.iter().filter(|c| c["eligible"].as_bool() == Some(true)).take(st.max_per_sweep.max(1) as usize).map(|c| ov(&c["id"])).collect();
    let mut o = Obj::default();
    o.put("action", s(text("devswarm_cli.action_auto_archive")))
        .put("ok", OVal::Bool(true))
        .put("mode", s(&st.mode))
        .put("settings", settings.done())
        .put("capability", cap.done())
        .put("candidates", OVal::Arr(candidates.iter().map(|c| plan_candidate(&app, c)).collect()))
        .put("toArchive", OVal::Arr(to_archive));
    if let Err(why) = capability {
        o.put("dormant", s(if absent { text("devswarm_cli.aa_dormant_absent") } else { &why }));
    }
    Ok(answer(0, o.done()))
}

// ---- spawn and respawn --------------------------------------------------------------------------------------------------

/// `spawnFlagValueError(rest)`: a value-taking create option with no value, or handed what looks like the next option.
fn spawn_flag_error(rest: &[&str]) -> Option<String> {
    let flags = defaults::raw("devswarm_cli.spawn_value_flags").as_array().map(<[_]>::to_vec).unwrap_or_default();
    let option_shaped = crate::checks::guardkit::jsre::compile(text("devswarm_cli.spawn_option_shape"), false);
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
                return Some(tpl("devswarm_cli.msg_spawn_no_value", &[("label", &label), ("name", &name)]));
            };
            let bad = if any_dash { value.starts_with('-') } else { option_shaped.is_match(value) };
            if bad {
                let quoted = serde_json::to_string(value).unwrap_or_default();
                return Some(tpl("devswarm_cli.msg_spawn_bad_value", &[("label", &label), ("value", &quoted), ("name", &name), ("short", short)]));
            }
            break;
        }
    }
    None
}

/// `spawn <branch> [create options]` (and `create`): the option refusals, then the create path ([`crate::meshw::spawnverb`]).
pub fn spawn(inv: &Inv, a: &Args) -> R<Answer> {
    common::seat_check(inv)?;
    let rest: Vec<&str> = a.raw.iter().skip(1).map(String::as_str).collect();
    let Some(branch) = rest.first().filter(|b| !b.is_empty()) else {
        return Ok(answer(2, failure(&[("error", s(text("devswarm_cli.msg_spawn_no_branch")))]).done()));
    };
    let strict = crate::dsact::settings::resolve(&inv.settings(), defaults::raw("devswarm_cli.set_spawn_strict")).as_bool().unwrap_or(true);
    if strict && let Some(error) = spawn_flag_error(&rest) {
        let o = failure(&[("action", s(text("devswarm_cli.action_spawn"))), ("branch", s(branch)), ("created", OVal::Bool(false)), ("error", s(&error))]);
        return Ok(answer(2, o.done()));
    }
    crate::meshw::spawnverb::create(inv, &rest, branch)
}

// ---- respawn ------------------------------------------------------------------------------------------------------------

/// A git argument list from the defaults, each `{name}` replaced.
fn argv(key: &str, vars: &[(&str, &str)]) -> Vec<String> {
    defaults::list(key)
        .iter()
        .map(|a| {
            let mut t = (*a).to_string();
            for (k, v) in vars {
                t = t.replace(&format!("{{{k}}}"), v);
            }
            t
        })
        .collect()
}

/// What one git call said: whether it exited 0, and its trimmed stdout and stderr.
struct GitOut {
    ok: bool,
    out: String,
    err: String,
}

/// `git -C cwd <args>` bounded by `timeout`, with extra environment (`devswarm-respawn.js` `git`).
fn git_with(cwd: &str, args: &[String], timeout: std::time::Duration, env: &[(&str, &std::path::Path)]) -> GitOut {
    let bin = defaults::text("codex_handover.git_binary");
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("-C").arg(cwd).args(args);
    for (k, v) in env {
        cmd.env(k, v);
    }
    match crate::proc::run(cmd, bin, timeout, defaults::millis("codex_handover.git_poll_ms")) {
        Ok(o) => GitOut {
            ok: o.status.success(),
            out: crate::checks::guardkit::text::js_trim(&String::from_utf8_lossy(&o.stdout)).to_string(),
            err: crate::checks::guardkit::text::js_trim(&String::from_utf8_lossy(&o.stderr)).to_string(),
        },
        Err(e) => GitOut { ok: false, out: String::new(), err: format!("{e:?}") },
    }
}

fn git(cwd: &str, args: &[String]) -> GitOut {
    git_with(cwd, args, defaults::millis("devswarm_cli.rs_git_timeout_ms"), &[])
}

/// `worktreeState(wt)`: the branch HEAD is on, whether the tree is dirty, and the commits no origin ref contains (`None` when git
/// cannot say).
struct WtState {
    branch: Option<String>,
    dirty: bool,
    unpushed: Option<f64>,
}

fn worktree_state(wt: Option<&str>) -> Result<WtState, String> {
    let shown = wt.unwrap_or("undefined");
    let Some(wt) = wt.filter(|w| !w.is_empty() && std::path::Path::new(w).exists()) else {
        return Err(tpl("devswarm_cli.rs_msg_no_worktree", &[("wt", shown)]));
    };
    if !git(wt, &argv("devswarm_cli.rs_git_head", &[])).ok {
        return Err(tpl("devswarm_cli.rs_msg_no_head", &[("wt", wt)]));
    }
    let br = git(wt, &argv("devswarm_cli.rs_git_branch_name", &[]));
    let st = git(wt, &argv("devswarm_cli.rs_git_status", &[]));
    if !st.ok {
        return Err(tpl("devswarm_cli.rs_msg_status_failed", &[("wt", wt), ("err", &st.err)]));
    }
    let up = git(wt, &argv("devswarm_cli.rs_git_unpushed", &[]));
    // `Number(out) || 0`: a count git printed that is not a number is none
    let count = crate::checks::guardkit::jsval::to_number(&up.out);
    Ok(WtState {
        branch: (br.ok && !br.out.is_empty()).then_some(br.out),
        dirty: !st.out.is_empty(),
        unpushed: up.ok.then_some(if count.is_nan() { 0.0 } else { count }),
    })
}

/// `needsPark(state)`: work would be lost without a park branch.
fn needs_park(st: &WtState) -> bool {
    st.dirty || st.unpushed.is_none_or(|u| u > 0.0)
}

/// `parkBranchName(branch, now)`: `park/<branch>-<yyyymmdd-hhmmss>`.
fn park_branch_name(branch: &str, now: i64) -> String {
    let iso = crate::checks::agent_scan::iso_utc(now as f64);
    let stamp: String = iso.chars().filter(|c| *c != '-' && *c != ':').take_while(|c| *c != '.').map(|c| if c == 'T' { '-' } else { c }).collect();
    format!("{}{branch}-{stamp}", text("devswarm_cli.rs_park_prefix"))
}

/// `nextBranch(branch, exists)`: `feat-x` is `feat-x-r2`, `feat-x-r2` is `feat-x-r3`; a name already taken is skipped.
fn next_branch(branch: &str, exists: &dyn Fn(&str) -> bool) -> String {
    let (base, mut n) = match regex::Regex::new(text("devswarm_cli.rs_next_branch_re")).ok().and_then(|re| re.captures(branch)) {
        Some(c) => (c[1].to_string(), crate::checks::guardkit::jsval::to_number(&c[2]) + 1.0),
        None => (branch.to_string(), 2.0),
    };
    let cap = defaults::num("devswarm_cli.rs_next_branch_cap") as f64;
    let name = |n: f64| format!("{base}{}{}", text("devswarm_cli.rs_next_branch_suffix"), crate::checks::jsport::num::to_js_string(n));
    while exists(&name(n)) && n < cap {
        n += 1.0;
    }
    name(n)
}

/// `isSecretPath(p)`: the basename matches one of the credential patterns.
fn is_secret_path(p: &str) -> bool {
    let base = ident::basename(p);
    defaults::list("devswarm_cli.rs_secret_globs").iter().any(|g| {
        let pattern: String = g.chars().map(|c| if c == '*' { ".*".to_string() } else { regex::escape(&c.to_string()) }).collect();
        regex::RegexBuilder::new(&format!("^{pattern}$")).case_insensitive(true).build().is_ok_and(|re| re.is_match(base))
    })
}

/// What `parkWip` came to, as the object the answer carries.
struct Parked {
    ok: bool,
    /// The stage that failed (empty when none did).
    stage: String,
    /// The answer's `park` object.
    json: OVal,
    park_branch: Option<String>,
    included: Vec<String>,
    excluded: Vec<String>,
    error: String,
}

fn park_failed(stage: &str, error: String, park_branch: Option<&str>, commit: Option<&str>) -> Parked {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("stage", s(stage));
    if let Some(b) = park_branch {
        o.put("parkBranch", s(b));
    }
    if let Some(c) = commit {
        o.put("commit", s(c));
    }
    o.put("error", s(&error));
    Parked { ok: false, stage: stage.to_string(), json: o.done(), park_branch: None, included: Vec::new(), excluded: Vec::new(), error }
}

/// `parkWip(wt, ...)`: snapshot the worktree through a private temporary index (the child's own index, HEAD, branch and files are
/// never touched), commit it on top of HEAD, point a NEW branch at it and push that branch. Nothing is stashed, reset or deleted.
fn park_wip(wt: &str, id: &str, branch: &str, park_branch: &str, dirty: bool) -> Parked {
    let (mut included, mut excluded) = (Vec::new(), Vec::new());
    let commit = if dirty {
        let tmp = std::env::temp_dir().join(format!("{}{}-{}", text("devswarm_cli.rs_park_tmp_prefix"), std::process::id(), common::now_ms()));
        if let Err(e) = std::fs::create_dir_all(&tmp) {
            return park_failed(text("devswarm_cli.rs_stage_snapshot"), e.to_string(), None, None);
        }
        let snap = snapshot_commit(wt, id, branch, &tmp, &mut included, &mut excluded);
        // our own private temporary index, never the child's
        crate::discard::harmless(std::fs::remove_dir_all(&tmp)); // keep: Node's `rmSync(tmpDir, { force: true })`
        match snap {
            Ok(c) => c,
            Err(p) => return p,
        }
    } else {
        let h = git(wt, &argv("devswarm_cli.rs_git_rev_head", &[]));
        if !h.ok {
            return park_failed(text("devswarm_cli.rs_stage_commit"), text("devswarm_cli.rs_err_no_head").to_string(), None, None);
        }
        h.out
    };
    let b = git(wt, &argv("devswarm_cli.rs_git_branch_at", &[("branch", park_branch), ("commit", &commit)]));
    if !b.ok {
        return park_failed(
            text("devswarm_cli.rs_stage_branch"),
            tpl("devswarm_cli.rs_err_branch", &[("branch", park_branch), ("err", &b.err)]),
            None,
            Some(&commit),
        );
    }
    let p = git_with(wt, &argv("devswarm_cli.rs_git_push", &[("branch", park_branch)]), defaults::millis("devswarm_cli.rs_push_timeout_ms"), &[]);
    if !p.ok {
        let lines: Vec<&str> = p.err.split('\n').collect();
        let tail = lines[lines.len().saturating_sub(3)..].join(" ");
        return park_failed(
            text("devswarm_cli.rs_stage_push"),
            tpl("devswarm_cli.rs_err_push", &[("branch", park_branch), ("tail", &tail)]),
            Some(park_branch),
            Some(&commit),
        );
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("parkBranch", s(park_branch))
        .put("commit", s(&commit))
        .put("pushed", OVal::Bool(true))
        .put("untrackedIncluded", strs(&included))
        .put("untrackedExcluded", strs(&excluded));
    Parked { ok: true, stage: String::new(), json: o.done(), park_branch: Some(park_branch.to_string()), included, excluded, error: String::new() }
}

/// The snapshot commit of a dirty worktree: tracked changes, then the untracked files that are not credentials, staged into the
/// private index `tmp/index`, written as a tree and committed on top of HEAD (no ref moves).
#[allow(clippy::result_large_err)] // Parked carries the whole parked-row record; the error path is rare
fn snapshot_commit(wt: &str, id: &str, branch: &str, tmp: &std::path::Path, included: &mut Vec<String>, excluded: &mut Vec<String>) -> Result<String, Parked> {
    let index = tmp.join(text("devswarm_cli.rs_index_name"));
    let env: [(&str, &std::path::Path); 1] = [(text("devswarm_cli.rs_index_env"), index.as_path())];
    let timeout = defaults::millis("devswarm_cli.rs_git_timeout_ms");
    let stage = |key: &str| text(key);
    let rt = git_with(wt, &argv("devswarm_cli.rs_git_read_tree", &[]), timeout, &env);
    if !rt.ok {
        return Err(park_failed(stage("devswarm_cli.rs_stage_snapshot"), tpl("devswarm_cli.rs_err_read_tree", &[("err", &rt.err)]), None, None));
    }
    // tracked changes only: this alone never stages a NEW untracked file, so it cannot pick up a fresh secret
    let tracked = git_with(wt, &argv("devswarm_cli.rs_git_add_tracked", &[]), timeout, &env);
    if !tracked.ok {
        return Err(park_failed(stage("devswarm_cli.rs_stage_snapshot"), tpl("devswarm_cli.rs_err_add_tracked", &[("err", &tracked.err)]), None, None));
    }
    // untracked, non-ignored files: credential-pattern basenames are filtered out BEFORE staging, with an explicit path list
    let ls = git(wt, &argv("devswarm_cli.rs_git_untracked", &[]));
    let untracked: Vec<String> =
        if ls.ok && !ls.out.is_empty() { ls.out.split('\n').filter(|l| !l.is_empty()).map(str::to_string).collect() } else { Vec::new() };
    included.extend(untracked.iter().filter(|p| !is_secret_path(p)).cloned());
    excluded.extend(untracked.iter().filter(|p| is_secret_path(p)).cloned());
    if !included.is_empty() {
        let mut args = argv("devswarm_cli.rs_git_add_paths", &[]);
        args.extend(included.iter().cloned());
        let added = git_with(wt, &args, timeout, &env);
        if !added.ok {
            return Err(park_failed(stage("devswarm_cli.rs_stage_snapshot"), tpl("devswarm_cli.rs_err_add_untracked", &[("err", &added.err)]), None, None));
        }
    }
    let tree = git_with(wt, &argv("devswarm_cli.rs_git_write_tree", &[]), timeout, &env);
    if !tree.ok {
        return Err(park_failed(stage("devswarm_cli.rs_stage_snapshot"), tpl("devswarm_cli.rs_err_write_tree", &[("err", &tree.err)]), None, None));
    }
    let mut args = if git(wt, &argv("devswarm_cli.rs_git_user_email", &[])).ok {
        Vec::new()
    } else {
        let who = defaults::list("devswarm_cli.rs_park_git_user");
        argv("devswarm_cli.rs_git_identity", &[("name", who[0]), ("email", who[1])])
    };
    let shown = if branch.is_empty() { text("devswarm_cli.rs_detached_word") } else { branch };
    let message = tpl("devswarm_cli.rs_park_message", &[("id", id), ("branch", shown)]);
    args.extend(argv("devswarm_cli.rs_git_commit_tree", &[("tree", &tree.out), ("message", &message)]));
    let c = git(wt, &args);
    if !c.ok {
        return Err(park_failed(stage("devswarm_cli.rs_stage_commit"), tpl("devswarm_cli.rs_err_commit_tree", &[("err", &c.err)]), None, None));
    }
    Ok(c.out)
}

/// What the handover and the brief are written from.
struct Respawning<'a> {
    id: &'a str,
    branch: &'a str,
    plan: &'a OVal,
    park_branch: Option<&'a str>,
    merge_ref: &'a str,
    new_branch: &'a str,
    default_branch: &'a str,
    last_working_on: Option<&'a OVal>,
    now: i64,
}

/// A step's `status` equals the word (strictly, as `s.status === 'done'` does).
fn step_is(step: &OVal, word: &str) -> bool {
    matches!(step.get("status"), Some(OVal::Str(t)) if t == word)
}

/// `handoverText(info)`: markdown. Steps are written as `#N text`, never `N. text`, so the plan parser reads only the brief's own
/// numbered plan.
fn handover_text(i: &Respawning<'_>) -> String {
    let steps = crate::meshw::plan::steps_of(i.plan);
    let (done, remaining): (Vec<&OVal>, Vec<&OVal>) = steps.iter().partition(|st| step_is(st, "done"));
    let line = |st: &OVal, status: &str| tpl("devswarm_cli.rs_h_step", &[("n", &concat(st.get("n"))), ("text", &concat(st.get("text"))), ("status", status)]);
    let shown = if i.branch.is_empty() { text("devswarm_cli.rs_unknown_word") } else { i.branch };
    let none = text("devswarm_cli.rs_h_none").to_string();
    let parked = if i.park_branch.is_some() { text("devswarm_cli.rs_h_parked") } else { "" };
    let mut l: Vec<String> = vec![
        tpl("devswarm_cli.rs_h_title", &[("id", i.id)]),
        String::new(),
        tpl("devswarm_cli.rs_h_old", &[("id", i.id), ("branch", shown)]),
        tpl("devswarm_cli.rs_h_new", &[("new", i.new_branch), ("default", i.default_branch)]),
        tpl("devswarm_cli.rs_h_merge", &[("ref", i.merge_ref), ("parked", parked)]),
        tpl("devswarm_cli.rs_h_written", &[("at", &crate::checks::agent_scan::iso_utc(i.now as f64))]),
        String::new(),
        text("devswarm_cli.rs_h_done_head").to_string(),
    ];
    if done.is_empty() {
        l.push(none.clone());
    } else {
        l.extend(done.iter().map(|st| line(st, "")));
    }
    l.push(String::new());
    l.push(text("devswarm_cli.rs_h_remaining_head").to_string());
    if remaining.is_empty() {
        l.push(none.clone());
    } else {
        for st in &remaining {
            let note = match st.get("status") {
                Some(OVal::Str(t)) if t == "todo" => String::new(),
                other => tpl("devswarm_cli.rs_h_step_status", &[("status", &concat(other))]),
            };
            l.push(line(st, &note));
        }
    }
    l.extend([String::new(), text("devswarm_cli.rs_h_last_head").to_string(), String::new()]);
    l.push(match i.last_working_on.filter(|v| v.truthy()) {
        Some(v) => js_string(v),
        None => text("devswarm_cli.rs_h_no_summary").to_string(),
    });
    let scope: Vec<String> = match i.plan.get("scope_globs") {
        Some(OVal::Arr(g)) => g.iter().map(|x| if matches!(x, OVal::Null) { String::new() } else { js_string(x) }).collect(),
        _ => Vec::new(),
    };
    l.extend([String::new(), text("devswarm_cli.rs_h_scope_head").to_string(), String::new()]);
    l.push(if scope.is_empty() { text("devswarm_cli.rs_h_no_scope").to_string() } else { scope.join(text("devswarm_cli.app_join_comma")) });
    l.extend([String::new(), text("devswarm_cli.rs_h_extras_head").to_string()]);
    match i.plan.get("extras") {
        Some(OVal::Arr(extras)) if !extras.is_empty() => {
            l.extend(extras.iter().map(|e| tpl("devswarm_cli.rs_h_extra", &[("glob", &concat(e.get("glob"))), ("note", &concat(e.get("note")))])));
        }
        _ => l.push(none),
    }
    format!("{}\n", l.join("\n"))
}

/// `briefText(info, handover)`: the new workspace's `-p` brief, the handover, then a numbered plan whose step 1 merges the old work
/// and whose later steps are the remaining ones, then the old scope line.
fn brief_text(i: &Respawning<'_>, handover: &str) -> String {
    let shown = if i.branch.is_empty() { text("devswarm_cli.rs_unknown_word") } else { i.branch };
    let remaining: Vec<&OVal> = crate::meshw::plan::steps_of(i.plan).iter().filter(|st| !step_is(st, "done")).collect();
    let mut out: Vec<String> = vec![
        tpl("devswarm_cli.rs_b_intro", &[("id", i.id), ("branch", shown)]),
        String::new(),
        js_trim(handover).to_string(),
        String::new(),
        text("devswarm_cli.rs_b_plan_head").to_string(),
        tpl("devswarm_cli.rs_b_merge_step", &[("ref", i.merge_ref)]),
    ];
    for (k, st) in remaining.iter().enumerate() {
        out.push(tpl("devswarm_cli.rs_b_step", &[("n", &(k + 2).to_string()), ("text", &concat(st.get("text")))]));
    }
    if remaining.is_empty() {
        out.push(text("devswarm_cli.rs_b_verify").to_string());
    }
    if let Some(OVal::Arr(g)) = i.plan.get("scope_globs").filter(|g| matches!(g, OVal::Arr(a) if !a.is_empty())) {
        let scope: Vec<String> = g.iter().map(|x| if matches!(x, OVal::Null) { String::new() } else { js_string(x) }).collect();
        out.push(String::new());
        out.push(tpl("devswarm_cli.rs_b_scope", &[("scope", &scope.join(text("devswarm_cli.app_join_comma")))]));
    }
    out.join("\n")
}

/// A setting that is a number of at least zero, else the default (`setting(k, d)` of `cmdRespawn`).
fn respawn_setting(inv: &Inv, key: &str, default: f64) -> f64 {
    crate::dsact::settings::resolve(&inv.settings(), defaults::raw(key)).as_f64().filter(|v| v.is_finite() && *v >= 0.0).unwrap_or(default)
}

/// Run a mesh verb of this binary in process, the way `run(argv, ctx)` runs one in Node: its answer, or the reason it could not
/// give one.
fn run_verb(inv: &Inv, argv: &[String]) -> Result<(i32, OVal), String> {
    let args = crate::meshw::args::parse(argv);
    let ans = crate::meshw::run_native(inv, &args).map_err(|d| d.0)?;
    OVal::parse(ans.stdout.trim()).map(|v| (ans.code, v)).ok_or_else(|| ans.stdout.trim().to_string())
}

/// `respawn <id> [--dry-run]`: the Primary replaces a straying child with a fresh workspace that keeps its progress. Primary-run
/// only, never automatic, and only after a `correct` warning and `devswarm.respawnGraceMin` minutes. Then, in order: (a) the child is
/// asked to commit and push and given `devswarm.respawnWipWaitSec` seconds; (b) whatever is still dirty or unpushed is parked on a
/// NEW pushed branch (a failed park aborts the respawn); (c) the handover is written; (d) `<branch>-r<N>` is spawned from the default
/// branch with the handover as its brief; (e) the old workspace is archived. `--dry-run` prints the plan and changes nothing.
pub fn respawn(inv: &Inv, a: &Args) -> R<Answer> {
    let id = a.positionals.get(1).map(String::as_str).unwrap_or("");
    let action = text("devswarm_cli.action_respawn");
    if !is_safe_id(id) {
        return Ok(answer(2, failure(&[("action", s(action)), ("error", s(text("devswarm_cli.msg_respawn_usage")))]).done()));
    }
    let now = clock(inv);
    let refuse = |reason: &str, error: String, extra: &[(&str, OVal)]| -> Answer {
        let mut f: Vec<(&str, OVal)> = vec![("action", s(action)), ("id", s(id)), ("reason", s(reason)), ("error", s(&error))];
        f.extend(extra.iter().cloned());
        answer(2, failure(&f).done())
    };
    let session = a
        .one(text("devswarm_cli.flag_session"))
        .filter(|x| !x.is_empty())
        .map(str::to_string)
        .or_else(|| inv.env.get(text("mesh_write.env_session_id")).filter(|x| !x.is_empty()).cloned())
        .unwrap_or_default();
    // a seat verdict that cannot be read is the state `unknown`
    let seat = crate::script::host_seat::seat_verdict(inv, &session, now as f64)
        .ok()
        .and_then(|v| v.get("state").and_then(serde_json::Value::as_str).map(str::to_string))
        .unwrap_or_else(|| text("devswarm_cli.seat_state_unknown").to_string());
    if seat != text("devswarm_cli.seat_state_own") {
        return Ok(refuse(
            text("devswarm_cli.respawn_reason_not_primary"),
            tpl("devswarm_cli.msg_respawn_not_primary", &[("seat", &seat)]),
            &[("seat", s(&seat))],
        ));
    }
    let found = crate::meshw::plan::find(inv, id)?.filter(|f| !crate::meshw::plan::steps_of(&f.plan).is_empty());
    let Some(found) = found else {
        return Ok(refuse(text("devswarm_cli.rs_reason_no_plan"), tpl("devswarm_cli.rs_msg_no_plan", &[("id", id)]), &[]));
    };
    let warned_at = match found.plan.get("warned_at") {
        Some(OVal::Num(w)) if w.is_finite() => *w,
        _ => return Ok(refuse(text("devswarm_cli.rs_reason_not_warned"), tpl("devswarm_cli.rs_msg_not_warned", &[("id", id)]), &[])),
    };
    let grace_min = respawn_setting(inv, "devswarm_cli.set_respawn_grace_min", 20.0);
    let since_ms = now as f64 - warned_at;
    if since_ms < grace_min * 60000.0 {
        let grace = crate::checks::jsport::num::to_js_string(grace_min);
        return Ok(refuse(
            text("devswarm_cli.rs_reason_grace"),
            tpl("devswarm_cli.rs_msg_grace", &[("ago", &crate::meshw::plan::dur(since_ms)), ("grace", &grace)]),
            &[("warned_at", n(warned_at)), ("graceMin", n(grace_min)), ("remainingMin", n(((grace_min * 60000.0 - since_ms) / 60000.0).ceil()))],
        ));
    }
    // `ref.worktreePath || found.plan.worktreePath`
    let wt: Option<String> = crate::meshw::plan::plan_ref(inv, id)?.or_else(|| match found.plan.get("worktreePath") {
        Some(OVal::Str(p)) if !p.is_empty() => Some(p.clone()),
        _ => None,
    });
    let st = match worktree_state(wt.as_deref()) {
        Ok(st) => st,
        Err(e) => return Ok(refuse(text("devswarm_cli.rs_reason_no_worktree"), e, &[])),
    };
    let Some(branch) = st.branch.clone() else {
        return Ok(refuse(text("devswarm_cli.rs_reason_detached"), text("devswarm_cli.rs_msg_detached").to_string(), &[]));
    };
    let origin = text("devswarm_cli.rs_origin_prefix");
    let default_ref = git_with(&inv.cwd, &argv("devswarm_cli.rs_git_default_ref", &[]), defaults::millis("devswarm_wire.git_timeout_ms"), &[]);
    let default_ref = default_ref
        .ok
        .then(|| regex::Regex::new(text("devswarm_cli.rs_default_ref_re")).ok().and_then(|re| re.captures(&default_ref.out).map(|c| c[1].to_string())))
        .flatten();
    let Some(default_branch) = default_ref.and_then(|r| r.strip_prefix(origin).map(str::to_string)) else {
        return Ok(refuse(text("devswarm_cli.rs_reason_default_unknown"), text("devswarm_cli.rs_msg_default_unknown").to_string(), &[]));
    };
    let next = next_branch(&branch, &|name| git(&inv.cwd, &argv("devswarm_cli.rs_git_branch_exists", &[("name", name)])).ok);
    let last_summary = match found.plan.get("summaries") {
        Some(OVal::Arr(sm)) => sm.last().and_then(|x| x.get("text")),
        _ => None,
    };
    let handover_path = devswarm_root(&inv.home).join(text("mesh_write.dir_plans")).join(format!("{id}{}", text("devswarm_cli.rs_handover_suffix")));
    let wip_wait_sec = respawn_setting(inv, "devswarm_cli.set_respawn_wip_wait_sec", 120.0);
    let info = |park: Option<&str>| -> (String, String) {
        let merge_ref = park.unwrap_or(&branch).to_string();
        let r = Respawning {
            id,
            branch: &branch,
            plan: &found.plan,
            park_branch: park,
            merge_ref: &merge_ref,
            new_branch: &next,
            default_branch: &default_branch,
            last_working_on: last_summary,
            now,
        };
        let handover = handover_text(&r);
        let brief = brief_text(&r, &handover);
        (handover, brief)
    };
    let handover_shown = handover_path.to_string_lossy().into_owned();
    if a.has(text("devswarm_cli.flag_dry_run")) {
        let would_park = needs_park(&st);
        let park_name = would_park.then(|| park_branch_name(&branch, now));
        let (_, brief) = info(park_name.as_deref());
        let wait = crate::checks::jsport::num::to_js_string(wip_wait_sec);
        let placeholder = tpl("devswarm_cli.rs_park_placeholder", &[("branch", &branch)]);
        let vars: [(&str, &str); 6] = [
            ("id", id),
            ("wip_wait", &wait),
            ("park", park_name.as_deref().unwrap_or(&placeholder)),
            ("handover", &handover_shown),
            ("next", &next),
            ("default", &default_branch),
        ];
        let plan_lines: Vec<OVal> = defaults::list("devswarm_cli.rs_plan_dryrun")
            .iter()
            .map(|l| {
                let mut t = (*l).to_string();
                for (k, v) in &vars {
                    t = t.replace(&format!("{{{k}}}"), v);
                }
                s(&t)
            })
            .collect();
        let mut wt_state = Obj::default();
        wt_state.put("dirty", OVal::Bool(st.dirty)).put("unpushed", st.unpushed.map_or(OVal::Null, n));
        let spawn_args = argv("devswarm_cli.rs_spawn_argv", &[("branch", &next), ("default", &default_branch), ("brief", &brief)]);
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(true))
            .put("action", s(action))
            .put("id", s(id))
            .put("dryRun", OVal::Bool(true))
            .put("branch", s(&branch))
            .put("newBranch", s(&next))
            .put("defaultBranch", s(&default_branch))
            .put("worktree", wt_state.done())
            .put("wipWaitSec", n(wip_wait_sec))
            .put("wouldPark", OVal::Bool(would_park))
            .put("parkBranch", s_or_null(park_name.as_deref()))
            .put("handoverPath", s(&handover_shown))
            // the spawn arguments without the verb word: the branch, then the flags
            .put("spawnArgs", OVal::Arr(spawn_args.iter().skip(1).map(|x| s(x)).collect()))
            .put("plan", OVal::Arr(plan_lines));
        return Ok(answer(0, o.done()));
    }
    let abort = |stage: &str| {
        let fields = vec![("id".to_string(), s(id)), ("key".to_string(), s(&found.key)), ("stage".to_string(), s(stage))];
        if crate::meshw::plan::record(inv, text("devswarm_cli.sr_t_aborted"), &fields, now as f64).is_some() {
            crate::meshw::plan::note_log(inv);
        }
    };
    // (a) ask the child to commit and push, then wait for it
    crate::meshw::mark_committed();
    let tmp_dir = std::env::temp_dir().join(format!("{}{}-{}", text("devswarm_cli.rs_msg_tmp_prefix"), std::process::id(), common::now_ms()));
    let msg_file = tmp_dir.join(text("devswarm_cli.rs_msg_file"));
    let message = tpl("devswarm_cli.rs_msg_child", &[("branch", &next)]);
    let send_ok = std::fs::create_dir_all(&tmp_dir).and_then(|()| std::fs::write(&msg_file, &message)).is_ok()
        && run_verb(inv, &argv("devswarm_cli.rs_send_argv", &[("id", id), ("file", &msg_file.to_string_lossy())])).is_ok_and(|(code, _)| code == 0);
    crate::discard::harmless(std::fs::remove_file(&msg_file)); // keep: Node's `try { fs.unlinkSync(msgFile) } catch (_) {}` on its own temp file
    crate::discard::harmless(std::fs::remove_dir(&tmp_dir)); // keep: as above, our own empty temp directory
    let wait = std::time::Duration::from_secs_f64(wip_wait_sec);
    let started = std::time::Instant::now();
    let mut cur = worktree_state(wt.as_deref());
    while send_ok && cur.as_ref().is_ok_and(needs_park) && started.elapsed() < wait {
        std::thread::sleep(wait.saturating_sub(started.elapsed()).min(defaults::millis("devswarm_cli.rs_wait_step_ms")));
        cur = worktree_state(wt.as_deref());
    }
    let cur = match cur {
        Ok(c) => c,
        Err(e) => {
            abort(text("devswarm_cli.rs_stage_worktree"));
            return Ok(refuse(text("devswarm_cli.rs_reason_worktree_error"), e, &[("sent", OVal::Bool(send_ok))]));
        }
    };
    // (b) park whatever is still dirty or unpushed
    let wt_path = wt.as_deref().unwrap_or_default();
    let mut park: Option<Parked> = None;
    if needs_park(&cur) {
        let p = park_wip(wt_path, id, &branch, &park_branch_name(&branch, now), cur.dirty);
        if !p.ok {
            abort(&p.stage);
            let error = tpl("devswarm_cli.rs_msg_park_failed", &[("error", &p.error)]);
            return Ok(refuse(text("devswarm_cli.rs_reason_park_failed"), error, &[("sent", OVal::Bool(send_ok)), ("park", p.json.clone())]));
        }
        park = Some(p);
    }
    let park_branch = park.as_ref().and_then(|p| p.park_branch.clone());
    let park_json = park.as_ref().map_or(OVal::Null, |p| p.json.clone());
    // (c) the handover
    let (handover, brief) = info(park_branch.as_deref());
    let written = (|| -> std::io::Result<()> {
        if let Some(dir) = handover_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut tmp = handover_path.as_os_str().to_os_string();
        tmp.push(format!(".{}{}", std::process::id(), text("mesh_write.tmp_suffix")));
        let tmp = std::path::PathBuf::from(tmp);
        std::fs::write(&tmp, &handover)?;
        std::fs::rename(&tmp, &handover_path)
    })();
    if let Err(e) = written {
        abort(text("devswarm_cli.rs_stage_handover"));
        let error = tpl("devswarm_cli.rs_msg_handover_failed", &[("path", &handover_shown), ("error", &e.to_string())]);
        return Ok(refuse(text("devswarm_cli.rs_reason_handover_failed"), error, &[("sent", OVal::Bool(send_ok)), ("park", park_json)]));
    }
    // (d) spawn from the default branch
    let spawned = run_verb(inv, &argv("devswarm_cli.rs_spawn_argv", &[("branch", &next), ("default", &default_branch), ("brief", &brief)]));
    let sp = match &spawned {
        Ok((_, v)) if v.get("ok").is_some_and(OVal::truthy) => v.clone(),
        other => {
            abort(text("devswarm_cli.rs_stage_spawn"));
            let sp_error = match other {
                Ok((_, v)) => v.get("error").filter(|e| e.truthy()).map(js_string),
                Err(why) => Some(why.clone()),
            }
            .unwrap_or_else(|| text("devswarm_cli.rs_msg_spawn_unknown").to_string());
            let holds = park_branch.clone().unwrap_or_else(|| branch.clone());
            let error = tpl("devswarm_cli.rs_msg_spawn_failed", &[("where", &holds), ("error", &sp_error)]);
            let spawn_json = other.as_ref().map_or(OVal::Null, |(_, v)| v.clone());
            return Ok(refuse(
                text("devswarm_cli.rs_reason_spawn_failed"),
                error,
                &[("sent", OVal::Bool(send_ok)), ("park", park_json), ("handoverPath", s(&handover_shown)), ("spawn", spawn_json)],
            ));
        }
    };
    let new_key = match sp.get("plan") {
        Some(p) if p.get("written").is_some_and(OVal::truthy) => p.get("key").filter(|k| k.truthy()).map(js_string),
        _ => None,
    };
    let note = |key: &str, written: R<Option<((), Option<String>)>>| {
        if let Ok(Some(((), Some(text)))) = written {
            crate::meshw::note_written(&crate::meshw::plan::plan_rel(key), text.as_bytes());
        }
    };
    if let Some(key) = &new_key {
        let extras: Vec<OVal> = match found.plan.get("extras") {
            Some(OVal::Arr(e)) => e.clone(),
            _ => Vec::new(),
        };
        let mut respawn_field = Obj::default();
        respawn_field.put("from", s(id)).put("from_branch", s(&branch)).put("park", s_or_null(park_branch.as_deref())).put("at", n(now as f64));
        let r = crate::meshw::plan::update_with(inv, key, |cur| {
            let Some(mut p) = cur else { return Ok(((), None)) };
            for e in &extras {
                if let (Some(OVal::Str(glob)), note_v) = (e.get("glob"), e.get("note")) {
                    crate::meshw::planverbs::add_extra(
                        &mut p,
                        glob,
                        &note_v.map_or_else(String::new, |v| if matches!(v, OVal::Null) { String::new() } else { js_string(v) }),
                        now as f64,
                    )
                    .or_else(|t| t.refusal())?;
                }
            }
            p.set("respawn", respawn_field.done());
            Ok(((), Some(p)))
        });
        note(key, r);
    }
    let new_id = sp.get("meshId").filter(|m| m.truthy()).map(js_string);
    let r = crate::meshw::plan::update_with(inv, &found.key, |cur| {
        let Some(mut p) = cur else { return Ok(((), None)) };
        p.set("respawned_to", s(new_id.as_deref().unwrap_or(&next)));
        p.set("respawned_at", n(now as f64));
        Ok(((), Some(p)))
    });
    note(&found.key, r);
    // (e) archive the old workspace; the owner closes its app tab
    let archived = archive_via_verb(inv, id, None);
    let nag = tpl("devswarm_cli.rs_msg_nag", &[("id", id), ("branch", &branch), ("next", &next)]);
    let fields = vec![
        ("id".to_string(), s(id)),
        ("key".to_string(), s(&found.key)),
        ("newId".to_string(), s_or_null(new_id.as_deref())),
        ("newKey".to_string(), s_or_null(new_key.as_deref())),
        ("parked".to_string(), OVal::Bool(park_branch.is_some())),
        ("pushedByChild".to_string(), OVal::Bool(park_branch.is_none() && needs_park(&st))),
        ("stepsDone".to_string(), n(crate::meshw::plan::steps_done(&found.plan) as f64)),
        ("stepsPlanned".to_string(), n(crate::meshw::plan::steps_of(&found.plan).len() as f64)),
    ];
    if crate::meshw::plan::record(inv, text("devswarm_cli.sr_t_respawn"), &fields, now as f64).is_some() {
        crate::meshw::plan::note_log(inv);
    }
    let mut spawn_obj = Obj::default();
    spawn_obj.put("ok", sp.get("ok").cloned().unwrap_or(OVal::Null));
    if let Some(w) = sp.get("worktreePath") {
        spawn_obj.put("worktreePath", w.clone());
    }
    if let Some(p) = sp.get("plan") {
        spawn_obj.put("plan", p.clone());
    }
    let mut arch = Obj::default();
    arch.put("ok", OVal::Bool(archived.ok));
    if let (false, Some(e)) = (archived.ok, archived.error.as_deref()) {
        arch.put("error", s(e));
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(action))
        .put("id", s(id))
        .put("branch", s(&branch))
        .put("newBranch", s(&next))
        .put("newId", s_or_null(new_id.as_deref()))
        .put("defaultBranch", s(&default_branch))
        .put("sent", OVal::Bool(send_ok))
        .put("parked", OVal::Bool(park_branch.is_some()))
        .put("parkBranch", s_or_null(park_branch.as_deref()))
        .put("handoverPath", s(&handover_shown))
        .put("spawn", spawn_obj.done())
        .put("untrackedIncluded", strs(&park.as_ref().map(|p| p.included.clone()).unwrap_or_default()))
        .put("untrackedExcluded", strs(&park.as_ref().map(|p| p.excluded.clone()).unwrap_or_default()))
        .put("archived", arch.done())
        .put("nag", s(&nag));
    Ok(answer(0, o.done()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-dsb-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A git repository with a commit (a project the verbs resolve a key for).
    fn repo(tag: &str) -> PathBuf {
        let r = scratch(tag);
        git(&r, &["init", "-q", "-b", "main"]);
        git(&r, &["config", "user.email", "t@example.invalid"]);
        git(&r, &["config", "user.name", "t"]);
        git(&r, &["commit", "-q", "--allow-empty", "-m", "one"]);
        r
    }

    fn inv(home: &Path, cwd: &Path, path: Option<&Path>) -> Inv {
        let mut env: ident::Env = Default::default();
        env.insert("PATH".into(), path.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default());
        Inv {
            home: home.to_path_buf(),
            write_home: home.to_path_buf(),
            env,
            cwd: cwd.to_string_lossy().into_owned(),
            now: 2_000_000,
            stdin: None,
            store_override: None,
        }
    }

    fn args(words: &[&str]) -> Args {
        crate::meshw::args::parse(&words.iter().map(|w| (*w).to_string()).collect::<Vec<_>>())
    }

    fn json(a: &Answer) -> OVal {
        OVal::parse(a.stdout.trim()).unwrap_or_else(|| panic!("not JSON: {}", a.stdout))
    }

    /// A `hivecontrol` that prints per argument vector, plus the capability cache that says which `workspace` verbs the build has.
    fn stub_hivecontrol(home: &Path, bin_dir: &Path, script: &str, verbs: &[&str], dormant: &[&str]) {
        std::fs::create_dir_all(bin_dir).unwrap();
        let bin = bin_dir.join(defaults::text("mesh_write.hivecontrol_bin"));
        std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let key = hivecontrol::cache_keys(&bin).remove(0);
        let verb_map: Vec<String> = verbs.iter().map(|v| format!("\"{v}\":{{}}")).collect();
        let lines: Vec<String> = dormant
            .iter()
            .map(|v| {
                format!(
                    "\"{}{v}\":{}",
                    text("devswarm_cli.hc_cap_prefix"),
                    serde_json::to_string(&hivecontrol::dormant_line(v, None, None, Some("2.5.3"), false).1).unwrap()
                )
            })
            .collect();
        let cache = format!(
            r#"{{"key":{},"checkedAt":"2026-01-01T00:00:00.000Z","probe":{{"present":true,"bin":"x","version":"2.5.3","verbs":{{{}}},"helpParsed":true}},"dormantLog":{{{}}}}}"#,
            serde_json::to_string(&key).unwrap(),
            verb_map.join(","),
            lines.join(",")
        );
        let file = home.join(text("mesh_write.dir_anti_hall")).join(text("mesh_write.dir_devswarm")).join(text("mesh_write.hivecontrol_cache_file"));
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, cache).unwrap();
    }

    /// `merge` outside a project: both calls go through the gate; the broadcast has no project to go to and says so.
    #[test]
    fn merge_answers_with_the_merge_result_and_a_broadcast_that_has_no_project() {
        let (home, bin, cwd) = (scratch("merge-home"), scratch("merge-bin"), scratch("merge-cwd"));
        stub_hivecontrol(&home, &bin, "case \"$2\" in check-merge) echo '{\"ok\":true}';; *) echo done;; esac", &["check-merge", "merge-into-source"], &[]);
        let ans = merge(&inv(&home, &cwd, Some(&bin)), &args(&["merge", "--into", "x"])).unwrap();
        let v = json(&ans);
        assert_eq!(ans.code, 0, "{}", ans.stdout);
        assert!(matches!(v.get("merged"), Some(OVal::Bool(true))) && v.get("checkMerge").is_some_and(|c| c.get("ok").is_some()), "{}", ans.stdout);
        assert_eq!(v.get("broadcast").map(OVal::stringify).as_deref(), Some(r#"{"ok":false,"reason":"no-project"}"#));
    }

    /// A build without `merge-into-source` answers Node's "capability dormant" failure instead of handing the verb on; a broadcast that
    /// cannot be sent is the `broadcast` field, never the merge's result.
    #[test]
    fn merge_on_a_build_without_the_verb_answers_the_dormant_error_and_reports_a_failed_broadcast() {
        let (home, bin) = (scratch("dormant-home"), scratch("dormant-bin"));
        let cwd = repo("dormant-repo");
        stub_hivecontrol(&home, &bin, "echo '{}'", &["check-merge"], &["merge-into-source"]);
        // the project's store directory is a file: the broadcast cannot open it
        std::fs::create_dir_all(devswarm_root(&home)).unwrap();
        std::fs::write(devswarm_root(&home).join(defaults::text("mesh_write.dir_store")), "x").unwrap();
        let ans = merge(&inv(&home, &cwd, Some(&bin)), &args(&["merge"])).unwrap();
        let v = json(&ans);
        assert_eq!(ans.code, 2);
        let error = crate::meshw::appverbs::concat(v.get("error"));
        assert!(error.starts_with("capability dormant: workspace.merge-into-source"), "{error}");
        let b = v.get("broadcast").unwrap();
        assert!(matches!(b.get("ok"), Some(OVal::Bool(false))) && b.get("error").is_some_and(OVal::truthy), "{}", ans.stdout);
    }

    /// Array records are records (their keys are indices), ids are `String(id)`, a path is whatever truthy value came, and a build
    /// without `workspace list` answers the dormant error as a refusal.
    #[test]
    fn reconcile_registry_reads_records_like_javascript() {
        let (home, bin) = (scratch("rr-home"), scratch("rr-bin"));
        let cwd = repo("rr-repo");
        stub_hivecontrol(&home, &bin, r#"echo '[[1,2],{"id":"a","path":"/x","label":"L"},{"id":7,"worktreePath":"/y"},{"id":0},null]'"#, &["list"], &[]);
        let i = inv(&home, &cwd, Some(&bin));
        let key = ident::repo_key_for_worktree(cwd.to_str().unwrap()).unwrap().unwrap();
        common::init_new_store(&i, &key).unwrap();
        let st = common::open_store(&i, &key).unwrap();
        for (id, wt) in [("r1", "/z"), ("a", "/elsewhere")] {
            st.upsert_registry(&store::RegistryRow { id: id.into(), worktree_path: Some(wt.into()), ..Default::default() }, 1, |a, b| a == b).unwrap();
        }
        let ans = reconcile_registry(&i, &args(&["reconcile-registry"])).unwrap();
        let v = json(&ans);
        assert_eq!(ans.code, 0, "{}", ans.stdout);
        assert_eq!(v.get("workspaceWithoutRegistry").map(OVal::stringify).as_deref(), Some(r#"[{"id":"7","path":"/y","label":null}]"#), "{}", ans.stdout);
        assert_eq!(v.get("registryWithoutWorkspace").map(OVal::stringify).as_deref(), Some(r#"[{"id":"r1","worktreePath":"/z"}]"#));
        assert_eq!(
            v.get("worktreePathMismatch").map(OVal::stringify).as_deref(),
            Some(r#"[{"id":"a","registryWorktreePath":"/elsewhere","hivecontrolPath":"/x"}]"#)
        );
        let (home2, bin2) = (scratch("rr2-home"), scratch("rr2-bin"));
        stub_hivecontrol(&home2, &bin2, "echo '[]'", &["check-merge"], &["list"]);
        let ans = reconcile_registry(&inv(&home2, &cwd, Some(&bin2)), &args(&["reconcile-registry"])).unwrap();
        let v = json(&ans);
        assert_eq!(ans.code, 2);
        assert!(crate::meshw::appverbs::concat(v.get("error")).contains("capability dormant: workspace.list"), "{}", ans.stdout);
    }

    /// `--stdin` reads the active ids from the input; the dry run lists them.
    #[test]
    fn reconcile_active_reads_ids_from_stdin() {
        let (home, cwd) = (scratch("ra-home"), repo("ra-repo"));
        let mut i = inv(&home, &cwd, None);
        i.stdin = Some("a b,c\n\t d ".into());
        let ans = reconcile_active(&i, &args(&["reconcile-active", "--stdin"])).unwrap();
        assert_eq!(ans.code, 0, "{}", ans.stdout);
        assert_eq!(json(&ans).get("active").map(OVal::stringify).as_deref(), Some(r#"["a","b","c","d"]"#));
        let none = reconcile_active(&inv(&home, &cwd, None), &args(&["reconcile-active"])).unwrap();
        assert_eq!(none.code, 2, "an empty active set is refused unless --allow-empty");
    }

    /// A descriptor whose `worktreePath` is not text is a candidate with that value as it came, never a reason to hand the verb on.
    #[test]
    fn reap_stale_lists_a_descriptor_whose_worktree_is_not_text() {
        let (home, cwd) = (scratch("rs-home"), repo("rs-repo"));
        let key = ident::repo_key_for_worktree(cwd.to_str().unwrap()).unwrap().unwrap();
        let dir = devswarm_root(&home);
        std::fs::create_dir_all(dir.join("workspaces")).unwrap();
        std::fs::write(dir.join("workspaces/odd-1.json"), format!(r#"{{"id":"odd-1","worktreePath":5,"sessionId":"s","ownerKey":"{key}"}}"#)).unwrap();
        std::fs::create_dir_all(dir.join(text("devswarm_cli.dir_liveness"))).unwrap();
        std::fs::write(dir.join(text("devswarm_cli.dir_liveness")).join("odd-1.json"), r#"{"status":"stale"}"#).unwrap();
        let ans = reap_stale(&inv(&home, &cwd, None), &args(&["reap-stale"])).unwrap();
        assert_eq!(ans.code, 0, "{}", ans.stdout);
        assert_eq!(json(&ans).get("candidates").map(OVal::stringify).as_deref(), Some(r#"[{"id":"odd-1","status":"stale","worktreePath":5}]"#));
    }

    /// The plan is answered from the action layer's own facts: a candidate with its gates, blockers and facts, and the DevSwarm CLI's
    /// absence as the capability and the dormant text.
    #[test]
    fn auto_archive_prints_the_plan_with_the_app_database_present() {
        let (home, wt) = (scratch("aa-home"), scratch("aa-wt"));
        let db = home.join("devswarm.db");
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch(
                "CREATE TABLE builders (id TEXT, isActive INTEGER, isHidden INTEGER, worktreePath TEXT, builderType TEXT, branchName TEXT, repositoryId TEXT, label TEXT, pullRequestId TEXT);",
            )
            .unwrap();
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute("INSERT INTO builders VALUES ('child-1', 1, 0, ?1, 'child', 'feat', 'repo-1', 'Child', NULL)", [wt.to_string_lossy().as_ref()])
            .unwrap();
        let dir = devswarm_root(&home);
        std::fs::create_dir_all(dir.join("workspaces")).unwrap();
        std::fs::write(dir.join("workspaces/child-1.json"), format!(r#"{{"id":"child-1","worktreePath":"{}","sessionId":"s"}}"#, wt.display())).unwrap();
        let mut i = inv(&home, &wt, None);
        i.env.insert("ANTIHALL_DEVSWARM_APP_DB".into(), db.to_string_lossy().into_owned());
        let ans = auto_archive(&i, &args(&["auto-archive"])).unwrap();
        let v = json(&ans);
        assert_eq!(ans.code, 0, "{}", ans.stdout);
        let c = match v.get("candidates") {
            Some(OVal::Arr(c)) if c.len() == 1 => c[0].clone(),
            other => panic!("one candidate expected: {other:?} in {}", ans.stdout),
        };
        assert_eq!(c.get("id").map(OVal::stringify).as_deref(), Some(r#""child-1""#));
        assert_eq!((c.get("label").map(OVal::stringify), c.get("repositoryId").map(OVal::stringify)), (Some(r#""Child""#.into()), Some(r#""repo-1""#.into())));
        assert!(matches!(c.get("eligible"), Some(OVal::Bool(false))));
        let gates: Vec<String> = match c.get("blockers") {
            Some(OVal::Arr(b)) => b.iter().map(|x| crate::meshw::appverbs::concat(x.get("gate"))).collect(),
            _ => Vec::new(),
        };
        assert!(gates.contains(&"a-done".to_string()) && gates.contains(&"b-merged".to_string()), "{gates:?}");
        assert!(matches!(v.get("toArchive"), Some(OVal::Arr(a)) if a.is_empty()));
        assert!(v.get("facts").is_none() && c.get("facts").is_some_and(|f| f.get("merged").is_some() && f.get("unread").is_some()));
    }

    /// The `park/<branch>-<yyyymmdd-hhmmss>` name, the next respawn branch and the credential filter.
    #[test]
    fn respawn_names_and_filters_follow_the_node_helpers() {
        assert_eq!(park_branch_name("feat-x", 1_790_000_000_000), "park/feat-x-20260921-141320");
        let taken = |names: &'static [&'static str]| move |n: &str| names.contains(&n);
        assert_eq!(next_branch("feat-x", &taken(&[])), "feat-x-r2");
        assert_eq!(next_branch("feat-x-r2", &taken(&[])), "feat-x-r3");
        assert_eq!(next_branch("feat-x", &taken(&["feat-x-r2", "feat-x-r3"])), "feat-x-r4");
        assert_eq!(next_branch("x-r", &taken(&[])), "x-r-r2", "no generation number: not a respawn branch");
        for secret in [".env", ".ENV.local", "a/b/id_rsa.pub", "credentials-prod.json", "x.pem", "dir/.npmrc", "a.key"] {
            assert!(is_secret_path(secret), "{secret}");
        }
        for plain in ["x.txt", "env", "src/main.rs", "keys.md"] {
            assert!(!is_secret_path(plain), "{plain}");
        }
    }

    /// The park commit: tracked changes and non-credential untracked files go on a NEW pushed branch through a private index; the
    /// child's own index, HEAD and files are untouched and the credential file is reported, not committed.
    #[test]
    fn parking_snapshots_the_worktree_without_touching_it() {
        let root = scratch("park");
        let (origin, work) = (root.join("origin.git"), root.join("work"));
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "--bare", "-b", "main"]);
        git(&root, &["clone", "-q", origin.to_str().unwrap(), "work"]);
        git(&work, &["config", "user.email", "t@example.invalid"]);
        git(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("tracked.txt"), "one\n").unwrap();
        git(&work, &["add", "tracked.txt"]);
        git(&work, &["commit", "-q", "-m", "one"]);
        git(&work, &["push", "-q", "origin", "HEAD:main"]);
        std::fs::write(work.join("tracked.txt"), "two\n").unwrap();
        std::fs::write(work.join("new.txt"), "n\n").unwrap();
        std::fs::write(work.join(".env"), "SECRET=1\n").unwrap();
        let (head, status) = (git(&work, &["rev-parse", "HEAD"]), git(&work, &["status", "--porcelain", "--untracked-files=all"]));
        let st = worktree_state(Some(work.to_str().unwrap())).unwrap();
        assert!(st.dirty && needs_park(&st) && st.unpushed == Some(0.0) && st.branch.as_deref() == Some("main"));
        let p = park_wip(work.to_str().unwrap(), "child-1", "main", "park/main-test", true);
        assert!(p.ok, "{}", p.error);
        assert_eq!((p.included.clone(), p.excluded.clone()), (vec!["new.txt".to_string()], vec![".env".to_string()]));
        assert_eq!(git(&work, &["rev-parse", "HEAD"]), head, "the child's HEAD is where it was");
        assert_eq!(git(&work, &["status", "--porcelain", "--untracked-files=all"]), status, "and so are its index and files");
        assert_eq!(git(&origin, &["show", "park/main-test:tracked.txt"]), "two");
        assert_eq!(git(&origin, &["show", "park/main-test:new.txt"]), "n");
        assert!(
            Command::new("git").arg("-C").arg(&origin).args(["cat-file", "-e", "park/main-test:.env"]).status().is_ok_and(|s| !s.success()),
            "the credential file is not committed"
        );
        let missing = worktree_state(Some(root.join("nope").to_str().unwrap()));
        assert!(missing.is_err_and(|e| e.starts_with("worktree not found: ")));
    }

    /// The dry run of a respawn names the next branch, the default branch and the five steps, and changes nothing.
    #[test]
    fn respawn_dry_run_prints_the_plan() {
        let root = scratch("respawn");
        let (origin, primary, child) = (root.join("origin.git"), root.join("primary"), root.join("child"));
        std::fs::create_dir_all(&origin).unwrap();
        git(&origin, &["init", "-q", "--bare", "-b", "main"]);
        git(&root, &["clone", "-q", origin.to_str().unwrap(), "primary"]);
        git(&primary, &["config", "user.email", "t@example.invalid"]);
        git(&primary, &["config", "user.name", "t"]);
        git(&primary, &["commit", "-q", "--allow-empty", "-m", "one"]);
        git(&primary, &["push", "-q", "origin", "HEAD:main"]);
        git(&primary, &["remote", "set-head", "origin", "main"]);
        git(&primary, &["worktree", "add", "-q", child.to_str().unwrap(), "-b", "feat-x"]);
        let home = scratch("respawn-home");
        let dir = devswarm_root(&home);
        std::fs::create_dir_all(dir.join("workspaces")).unwrap();
        std::fs::create_dir_all(dir.join("plans")).unwrap();
        let primary_id = ident::primary_workspace_id(primary.to_str().unwrap()).unwrap();
        std::fs::write(
            dir.join(format!("workspaces/{primary_id}.json")),
            format!(r#"{{"id":"{primary_id}","worktreePath":"{}","sessionId":"seat-1"}}"#, primary.display()),
        )
        .unwrap();
        std::fs::write(dir.join("workspaces/child-1.json"), format!(r#"{{"id":"child-1","worktreePath":"{}","sessionId":"c"}}"#, child.display())).unwrap();
        let key = ident::mesh_id_for_real_path(child.to_str().unwrap());
        let plan = r#"{"steps":[{"n":1,"text":"first","status":"done"},{"n":2,"text":"second","status":"todo"}],"warned_at":1,"scope_globs":["src/**"],"summaries":[{"ts":1,"text":"on step 2"}]}"#;
        std::fs::write(dir.join(format!("plans/{key}.json")), plan).unwrap();
        let mut i = inv(&home, &primary, None);
        i.env.insert(defaults::text("mesh_write.env_session_id").into(), "seat-1".into());
        let ans = respawn(&i, &args(&["respawn", "child-1", "--dry-run"])).unwrap();
        let v = json(&ans);
        assert_eq!(ans.code, 0, "{}", ans.stdout);
        let field = |k: &str| v.get(k).map(OVal::stringify).unwrap_or_default();
        assert_eq!((field("branch"), field("newBranch"), field("defaultBranch")), (r#""feat-x""#.into(), r#""feat-x-r2""#.into(), r#""main""#.into()));
        assert_eq!((field("wouldPark"), field("parkBranch"), field("wipWaitSec")), ("false".into(), "null".into(), "120".into()));
        assert!(field("handoverPath").ends_with(r#"/plans/child-1.handover.md""#), "{}", field("handoverPath"));
        assert!(field("spawnArgs").starts_with(r#"["feat-x-r2","-s","main","-p","Respawn of child-1 (feat-x)"#), "{}", field("spawnArgs"));
        assert!(matches!(v.get("plan"), Some(OVal::Arr(p)) if p.len() == 5));
        let refused = respawn(
            &{
                let mut j = i.clone();
                j.env.insert(defaults::text("mesh_write.env_session_id").into(), "other".into());
                j
            },
            &args(&["respawn", "child-1", "--dry-run"]),
        )
        .unwrap();
        assert_eq!(refused.code, 2);
        assert!(refused.stdout.contains(r#""reason":"not-primary""#), "{}", refused.stdout);
    }

    /// The race `revalidate` closes: a workspace that revives after the candidates were collected is skipped INSIDE the lock, and
    /// nothing is archived.
    #[test]
    fn a_workspace_that_revives_between_the_check_and_the_archive_is_not_archived() {
        let (home, cwd) = (scratch("race-home"), repo("race-repo"));
        // an old last commit: the workspace is quiet when collected
        let old = Command::new("git")
            .arg("-C")
            .arg(&cwd)
            .args(["commit", "-q", "--amend", "--allow-empty", "-m", "one", "--date=2020-01-01T00:00:00"])
            .env("GIT_COMMITTER_DATE", "2020-01-01T00:00:00")
            .status()
            .unwrap();
        assert!(old.success());
        let key = ident::repo_key_for_worktree(cwd.to_str().unwrap()).unwrap().unwrap();
        let dir = devswarm_root(&home);
        std::fs::create_dir_all(dir.join("workspaces")).unwrap();
        std::fs::write(
            dir.join("workspaces/child-1.json"),
            format!(r#"{{"id":"child-1","worktreePath":"{}","sessionId":"s","ownerKey":"{key}"}}"#, cwd.display()),
        )
        .unwrap();
        std::fs::create_dir_all(dir.join(text("devswarm_cli.dir_liveness"))).unwrap();
        std::fs::write(dir.join(text("devswarm_cli.dir_liveness")).join("child-1.json"), r#"{"status":"stale"}"#).unwrap();
        let i = inv(&home, &cwd, None);
        common::init_new_store(&i, &key).unwrap();
        common::open_store(&i, &key).unwrap();
        let states = defaults::list("devswarm_cli.reap_stale_states");
        let (fresh_ms, idle_ms) = (defaults::num("devswarm_sup.lv_heartbeat_fresh_ms") as f64, defaults::num("devswarm_cli.reap_idle_ms") as f64);
        let desc_then = ident::read_descriptor(&home, "child-1").unwrap();
        assert_eq!(reap_recheck(&i, "child-1", cwd.to_str().unwrap(), &key, &desc_then, fresh_ms, idle_ms, &states), None, "still a candidate when collected");
        // between collection and the archive the workspace beats: the check inside the lock sees it
        let revive = |desc: &OVal| -> Option<String> {
            let beats = dir.join(defaults::text("mesh_write.dir_heartbeats"));
            std::fs::create_dir_all(&beats).unwrap();
            std::fs::write(beats.join("child-1.json"), format!(r#"{{"ts":{},"sessionId":"s"}}"#, common::now_ms())).unwrap();
            reap_recheck(&i, "child-1", cwd.to_str().unwrap(), &key, desc, fresh_ms, idle_ms, &states).map(str::to_string)
        };
        let r = archive_via_verb(&i, "child-1", Some(&revive));
        assert_eq!(r.skipped.as_deref(), Some("fresh-heartbeat"), "{:?}", r.error);
        assert!(dir.join("workspaces/child-1.json").exists(), "the active descriptor stays");
        assert!(!dir.join("archived/child-1.json").exists(), "and no archived marker was written");
    }

    /// Node's idle rule is the stricter one: a workspace whose last turn the transcript cannot show finished, or that launched background
    /// work, is held ("idle uncertain") and never planned for archive; one whose last turn ended is judged by its clock.
    #[test]
    fn an_idle_that_cannot_be_proven_holds_the_workspace() {
        let (home, wt) = (scratch("idle-home"), repo("idle-wt"));
        // a project whose store exists: the newest inbound message is then known (none)
        let setup = inv(&home, &wt, None);
        let key = ident::repo_key_for_worktree(wt.to_str().unwrap()).unwrap().unwrap();
        common::init_new_store(&setup, &key).unwrap();
        common::open_store(&setup, &key).unwrap();
        let db = home.join("devswarm.db");
        let c = rusqlite::Connection::open(&db).unwrap();
        c.execute_batch("CREATE TABLE builders (id TEXT, isActive INTEGER, isHidden INTEGER, worktreePath TEXT, builderType TEXT, branchName TEXT, repositoryId TEXT, label TEXT, pullRequestId TEXT);").unwrap();
        c.execute("INSERT INTO builders VALUES ('child-1', 1, 0, ?1, 'child', 'feat', 'repo-1', 'Child', NULL)", [wt.to_string_lossy().as_ref()]).unwrap();
        let dir = devswarm_root(&home);
        std::fs::create_dir_all(dir.join("workspaces")).unwrap();
        std::fs::write(dir.join("workspaces/child-1.json"), format!(r#"{{"id":"child-1","worktreePath":"{}","sessionId":"sess"}}"#, wt.display())).unwrap();
        let transcript = crate::dswire::facts::transcript_path(&home, wt.to_str().unwrap(), "sess");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let g_idle = |lines: &str| -> String {
            std::fs::write(&transcript, lines).unwrap();
            let mut i = inv(&home, &wt, None);
            i.env.insert("ANTIHALL_DEVSWARM_APP_DB".into(), db.to_string_lossy().into_owned());
            let v = json(&auto_archive(&i, &args(&["auto-archive"])).unwrap());
            let Some(OVal::Arr(c)) = v.get("candidates") else { panic!("no candidates: {}", v.stringify()) };
            let b = match c[0].get("blockers") {
                Some(OVal::Arr(b)) => b.clone(),
                _ => Vec::new(),
            };
            b.iter()
                .find(|x| crate::meshw::appverbs::concat(x.get("gate")) == "g-idle")
                .map(|x| crate::meshw::appverbs::concat(x.get("detail")))
                .unwrap_or_default()
        };
        let held = defaults::text("devswarm_act.msg_idle_uncertain");
        let ended = r#"{"type":"user","message":{"role":"user","content":"go"}}
{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[]}}
{"type":"system","subtype":"turn_duration"}
"#;
        assert_ne!(g_idle(ended), held, "a finished turn is judged by its clock");
        let open = format!("{ended}{}", r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result"}]}}"#);
        assert_eq!(g_idle(&open), held, "a tool result after the last end_turn: the turn is open");
        let tool = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[]}}"#;
        assert_eq!(g_idle(tool), held, "an assistant entry that did not end its turn");
        let bg = r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"tool_use","input":{"run_in_background":true}}]}}"#.to_string();
        assert_eq!(g_idle(&bg), held, "background work launched and not shown finished");
        assert_eq!(g_idle("not json at all"), held, "a tail with no turn entry proves nothing");
    }
}
