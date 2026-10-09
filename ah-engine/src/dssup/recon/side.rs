//! Slice S1: the small state files `reconcile` and the reconcile sweep keep, as planners that return ops (never writing).
//!
//! * `reconcile-sweep-state.json` (the sweep's cool-down) and `reconcile-resume.json` (the ids a run left for the next one);
//! * the workspace display-name cache `names/<id>.json`;
//! * `repo-unknown.json` (hivecontrol forgot a repository: recorded once, rechecked every `recheck_ms`);
//! * `hivecontrol-active.json` (the app-side active-workspace snapshot, with its partial-list floor);
//! * the start-up sampling pass (`startup-sampling-state.json` and the samples log).
//!
//! Each planner mirrors the Node function of the same name and returns, next to the units, the value Node's function returns, in
//! the shape the witness dispatcher reports it, so the gate compares the return values too. A planner that meets a state it does
//! not reproduce exactly (a JSON type the Node code would coerce, a cut through a surrogate pair, a relative path) returns a
//! [`Defer`] before anything is decided.
use super::view::{ds, pre_of};
use super::{Op, Scope, Unit};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{js_trim, slice_utf16};
use crate::defaults;
use crate::meshw::ident::{Defer, R, defer};
use crate::meshw::idlock::is_safe_id as is_safe_id_text;
use serde_json::{Value, json};
use std::path::Path;

/// A planned side-file change: the unit, the Node call that does the same, and what that call returns.
pub struct Planned {
    /// The ops (empty when nothing is to be written).
    pub unit: Unit,
    /// The Node call for the witness dispatcher.
    pub call: Value,
    /// What the call returns, in the dispatcher's JSON shape.
    pub expect: Value,
}

fn file_json(home: &Path, rel: &str) -> Option<OVal> {
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(home.join(rel)).ok()?))
}

fn num(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

fn write_op(home: &Path, rel: &str, text: String, read_modify_write: bool) -> Op {
    let pre = if read_modify_write { pre_of(home, rel) } else { super::Pre::Any };
    Op::Write { rel: rel.to_string(), bytes: text.into_bytes(), pre }
}

fn n(x: i64) -> OVal {
    OVal::Num(x as f64)
}

fn s(x: &str) -> OVal {
    OVal::Str(x.to_string())
}

// ---- reconcile-sweep-state.json --------------------------------------------------------------------------------------------

/// Where the sweep's cool-down lives, relative to the home.
pub fn sweep_state_rel() -> String {
    ds(defaults::text("devswarm_recon.file_sweep_state"))
}

/// `readReconcileSweepState(home).lastRunAt`: 0 when the file is absent, torn or holds no finite number.
pub fn read_sweep_state(home: &Path) -> f64 {
    num(file_json(home, &sweep_state_rel()).as_ref().and_then(|v| v.get("lastRunAt"))).unwrap_or(0.0)
}

/// `writeReconcileSweepState(home, fs, {lastRunAt})`: persisted BEFORE the sweep runs, so a crash honours the cool-down.
pub fn plan_sweep_state(home: &Path, now: i64) -> Planned {
    let body = OVal::Obj(vec![("lastRunAt".into(), n(now))]).stringify();
    Planned {
        unit: Unit { label: "sweep-state".into(), lock: None, ops: vec![write_op(home, &sweep_state_rel(), body, false)] },
        call: json!({"fn": "sweepState", "args": {"lastRunAt": now}}),
        expect: Value::Null,
    }
}

// ---- reconcile-resume.json -------------------------------------------------------------------------------------------------

/// Where the resume marker lives, relative to the home.
pub fn resume_rel() -> String {
    ds(defaults::text("devswarm_recon.file_resume"))
}

/// `readReconcileResume(home, repoKey)`: the deferred ids of the last run for THIS repo key; empty on absence, a torn file or
/// another repo key (fail-open).
pub fn read_resume(home: &Path, repo_key: &str) -> Vec<String> {
    let Some(v) = file_json(home, &resume_rel()) else { return Vec::new() };
    match (v.get("repoKey"), v.get("ids")) {
        (Some(OVal::Str(k)), Some(OVal::Arr(ids))) if k == repo_key => ids.iter().filter_map(|x| if let OVal::Str(t) = x { Some(t.clone()) } else { None }).collect(),
        _ => Vec::new(),
    }
}

/// `writeReconcileResume(home, repoKey, ids)`: the marker holds the still-deferred ids, or is removed once nothing is left. The
/// engine writes it atomically (Node writes it in place); the bytes are the same.
pub fn plan_resume(home: &Path, repo_key: &str, ids: &[String], now: i64) -> Planned {
    let rel = resume_rel();
    let op = if ids.is_empty() {
        Op::Unlink { rel: rel.clone(), pre: super::Pre::Any }
    } else {
        let body = OVal::Obj(vec![
            ("repoKey".into(), s(repo_key)),
            ("ids".into(), OVal::Arr(ids.iter().map(|i| s(i)).collect())),
            ("ts".into(), n(now)),
        ])
        .stringify();
        write_op(home, &rel, body, false)
    };
    Planned {
        unit: Unit { label: "resume".into(), lock: None, ops: vec![op] },
        call: json!({"fn": "resumeWrite", "args": {"repoKey": repo_key, "ids": ids}}),
        expect: Value::Null,
    }
}

// ---- names/<id>.json -------------------------------------------------------------------------------------------------------

/// `writeName(home, id, name, now)`: the cached display name of a workspace. An unsafe id or an empty name is a silent no.
pub fn plan_name(home: &Path, id: &str, name: &str, now: i64) -> Planned {
    let call = json!({"fn": "nameWrite", "args": {"id": id, "name": name, "now": now}});
    if name.is_empty() || !is_safe_id_text(id) {
        return Planned { unit: Unit { label: "name".into(), lock: None, ops: Vec::new() }, call, expect: json!(false) };
    }
    let rel = ds(&format!("{}/{id}{}", defaults::text("devswarm_recon.dir_names"), defaults::text("mesh_write.json_suffix")));
    let body = OVal::Obj(vec![("name".into(), s(name)), ("updatedAt".into(), n(now))]).stringify();
    Planned { unit: Unit { label: format!("name:{id}"), lock: None, ops: vec![write_op(home, &rel, body, false)] }, call, expect: json!(true) }
}

// ---- repo-unknown.json -----------------------------------------------------------------------------------------------------

/// Where the repo-unknown marker lives, relative to the home.
pub fn repo_unknown_rel() -> String {
    ds(defaults::text("devswarm_recon.file_repo_unknown"))
}

fn read_scopes(home: &Path) -> Vec<(String, OVal)> {
    match file_json(home, &repo_unknown_rel()).as_ref().and_then(|p| p.get("scopes")) {
        Some(OVal::Obj(o)) => o.clone(),
        _ => Vec::new(),
    }
}

fn scopes_text(scopes: Vec<(String, OVal)>) -> String {
    OVal::Obj(vec![("version".into(), n(1)), ("scopes".into(), OVal::Obj(scopes))]).stringify()
}

fn key_of(repo_key: &str, scope: &str) -> String {
    format!("{repo_key}:{scope}")
}

fn streak_of(e: &OVal) -> f64 {
    num(e.get("streak")).unwrap_or(defaults::num("devswarm_recon.suppress_after") as f64)
}

/// `isSuppressed(home, repoKey, scope, now)`: a marker exists, has been seen `suppress_after` times in a row and its recheck is
/// not yet due.
pub fn repo_unknown_suppressed(home: &Path, repo_key: &str, scope: &str, now: i64) -> bool {
    let scopes = read_scopes(home);
    let Some((_, e)) = scopes.iter().find(|(k, _)| *k == key_of(repo_key, scope)) else { return false };
    let Some(last) = num(e.get("lastChecked")) else { return false };
    if streak_of(e) < defaults::num("devswarm_recon.suppress_after") as f64 {
        return false;
    }
    (now as f64 - last) < defaults::num("devswarm_recon.recheck_ms") as f64
}

/// `stripAnsi(String(r || '')).trim().slice(0, 300)`; a cut through a surrogate pair is the caller's deferral.
fn clean_reason(reason: &str) -> R<String> {
    let re = regex::Regex::new(defaults::text("devswarm_recon.ansi_re")).map_err(|e| Defer(e.to_string()))?;
    let stripped = re.replace_all(reason, "");
    slice_utf16(js_trim(&stripped), defaults::num("devswarm_recon.reason_max") as usize).ok_or_else(|| Defer(defaults::text("devswarm_recon.why_surrogate").to_string()))
}

/// `record(home, repoKey, scope, reason, now)`: note one more sweep that met hivecontrol's "repository not found". The result is
/// Node's `{first, suppressed, engaged}`.
pub fn plan_repo_unknown_record(home: &Path, repo_key: &str, scope: &str, reason: &str, now: i64) -> R<Planned> {
    let mut scopes = read_scopes(home);
    let k = key_of(repo_key, scope);
    let prev = scopes.iter().find(|(name, _)| *name == k).map(|(_, v)| v.clone());
    let first = !prev.as_ref().is_some_and(|p| num(p.get("firstSeen")).is_some());
    let r = clean_reason(reason)?;
    let same = !first && matches!(prev.as_ref().and_then(|p| p.get("reason")), Some(OVal::Str(t)) if *t == r);
    let after = defaults::num("devswarm_recon.suppress_after") as f64;
    let prev_streak = prev.as_ref().map(streak_of);
    let streak = (if same { prev_streak.unwrap_or(0.0) } else { 0.0 }) + 1.0;
    let entry = OVal::Obj(vec![
        ("reason".into(), s(&r)),
        ("firstSeen".into(), if first { n(now) } else { prev.as_ref().and_then(|p| p.get("firstSeen")).cloned().unwrap_or(OVal::Null) }),
        ("lastChecked".into(), n(now)),
        ("count".into(), OVal::Num(prev.as_ref().and_then(|p| num(p.get("count"))).unwrap_or(0.0) + 1.0)),
        ("streak".into(), OVal::Num(streak)),
    ]);
    match scopes.iter_mut().find(|(name, _)| *name == k) {
        Some(slot) => slot.1 = entry,
        None => scopes.push((k, entry)),
    }
    if scopes.iter().any(|(name, _)| crate::checks::guardkit::ojson::is_array_index_key(name)) {
        return defer("array-index-key");
    }
    let suppressed = streak >= after;
    let engaged = suppressed && !(same && prev_streak.unwrap_or(0.0) >= after);
    let rel = repo_unknown_rel();
    let op = write_op(home, &rel, scopes_text(scopes), true);
    Ok(Planned {
        unit: Unit { label: "repo-unknown".into(), lock: None, ops: vec![op] },
        call: json!({"fn": "repoUnknownRecord", "args": {"repoKey": repo_key, "scope": scope, "reason": reason, "now": now}}),
        expect: json!({"first": first, "suppressed": suppressed, "engaged": engaged}),
    })
}

/// `clear(home, repoKey, scope)`: hivecontrol knows the repository again; no write when there is nothing to clear.
pub fn plan_repo_unknown_clear(home: &Path, repo_key: &str, scope: &str) -> Planned {
    let mut scopes = read_scopes(home);
    let k = key_of(repo_key, scope);
    let ops = if scopes.iter().any(|(name, _)| *name == k) {
        scopes.retain(|(name, _)| *name != k);
        vec![write_op(home, &repo_unknown_rel(), scopes_text(scopes), true)]
    } else {
        Vec::new()
    };
    Planned {
        unit: Unit { label: "repo-unknown".into(), lock: None, ops },
        call: json!({"fn": "repoUnknownClear", "args": {"repoKey": repo_key, "scope": scope}}),
        expect: Value::Null,
    }
}

// ---- hivecontrol-active.json -----------------------------------------------------------------------------------------------

/// Where the active-workspace snapshot lives, relative to the home.
pub fn active_rel() -> String {
    ds(defaults::text("devswarm_recon.file_active_cache"))
}

/// One record of the snapshot after Node's `normalizeRecords`.
type Rec = (String, Option<String>, Option<String>);

/// `normalizeRecords(v)`: `None` when `v` is not an array; objects with a non-empty id become `{id, worktreePath, repositoryId}`
/// with the worktree path resolved (`path.resolve`, then `realpath` when it exists). A relative path, or an id that is not a
/// string, is a state the engine does not model.
fn normalize(v: &OVal) -> R<Option<Vec<Rec>>> {
    let OVal::Arr(items) = v else { return Ok(None) };
    let mut out = Vec::new();
    for r in items {
        if !matches!(r, OVal::Obj(_)) {
            continue;
        }
        let id = match r.get("id") {
            None | Some(OVal::Null) => String::new(),
            Some(OVal::Str(t)) => t.clone(),
            Some(_) => return defer("record-id-type"),
        };
        if id.is_empty() {
            continue;
        }
        let wt = match r.get("worktreePath") {
            Some(OVal::Str(p)) if !p.is_empty() => {
                if !p.starts_with('/') {
                    return defer("relative-worktree");
                }
                let resolved = crate::meshw::ident::resolve_abs(p);
                Some(crate::meshw::ident::realpath(&resolved).unwrap_or(resolved))
            }
            _ => None,
        };
        let repo = match r.get("repositoryId") {
            Some(OVal::Str(t)) if !t.is_empty() => Some(t.clone()),
            _ => None,
        };
        out.push((id, wt, repo));
    }
    Ok(Some(out))
}

fn rec_json(r: &Rec) -> OVal {
    let opt = |o: &Option<String>| o.as_deref().map_or(OVal::Null, s);
    OVal::Obj(vec![("id".into(), s(&r.0)), ("worktreePath".into(), opt(&r.1)), ("repositoryId".into(), opt(&r.2))])
}

/// The floor percentage: `devswarm.activeFloorPct` (environment, settings, default 50; 0 turns the floor off).
pub fn active_floor_pct(st: &crate::checks::git::util::Settings) -> f64 {
    crate::dssup::setting(st, "devswarm_recon.set_active_floor_pct").as_f64().unwrap_or(0.0)
}

/// `writeActiveCache({home, byRepoKey, now})`: replace the whole snapshot with the projects probed in THIS sweep, keeping the
/// previous entry of a project whose new list fell below `floor_pct` percent of it (the partial-list guard, with its log line).
/// A call with no usable record writes nothing and returns `null`.
pub fn plan_active_cache(home: &Path, by_repo_key: &[(String, OVal)], now: i64, floor_pct: f64) -> R<Planned> {
    let prev_all = match file_json(home, &active_rel()).as_ref().and_then(|p| p.get("byRepoKey")) {
        Some(OVal::Obj(o)) => {
            let mut m = Vec::new();
            for (k, v) in o {
                if let Some(recs) = normalize(v)?
                    && !recs.is_empty()
                {
                    m.push((k.clone(), recs));
                }
            }
            m
        }
        _ => Vec::new(),
    };
    let rel = active_rel();
    let mut kept: Vec<(String, Vec<Rec>)> = Vec::new();
    let mut ops = Vec::new();
    let mut count = 0usize;
    for (k, v) in by_repo_key {
        let Some(mut recs) = normalize(v)? else { continue };
        if recs.is_empty() {
            continue;
        }
        let prev = prev_all.iter().find(|(pk, _)| pk == k).map(|(_, r)| r);
        if let Some(prev) = prev
            && floor_pct > 0.0
            && !prev.is_empty()
            && (recs.len() as f64) < (prev.len() as f64 * floor_pct) / 100.0
        {
            let msg = defaults::render(
                "devswarm_recon.msg_partial_list",
                &[("new", &recs.len()), ("key", k), ("pct", &crate::checks::guardkit::ojson::js_number_text(floor_pct)), ("prev", &prev.len())],
            );
            let ctx = OVal::Obj(vec![
                ("repoKey".into(), s(k)),
                ("newCount".into(), n(recs.len() as i64)),
                ("prevCount".into(), n(prev.len() as i64)),
                ("floorPct".into(), OVal::Num(floor_pct)),
            ]);
            ops.push(Op::Log {
                component: defaults::text("devswarm_recon.log_component_cache").into(),
                op: defaults::text("devswarm_recon.log_op_partial").into(),
                level: defaults::text("devswarm_recon.log_level_warn").into(),
                msg,
                ctx: ctx.stringify(),
            });
            recs = prev.clone();
        }
        if crate::checks::guardkit::ojson::is_array_index_key(k) {
            return defer("array-index-key");
        }
        count += recs.len();
        match kept.iter_mut().find(|(kk, _)| kk == k) {
            Some(slot) => slot.1 = recs,
            None => kept.push((k.clone(), recs)),
        }
    }
    let call = json!({"fn": "activeCache", "args": {
        "byRepoKey": Value::Object(by_repo_key.iter().map(|(k, v)| (k.clone(), serde_json::from_str(&v.stringify()).unwrap_or(Value::Null))).collect()),
        "now": now, "floorPct": floor_pct}});
    if count == 0 {
        return Ok(Planned { unit: Unit { label: "active-cache".into(), lock: None, ops: Vec::new() }, call, expect: Value::Null });
    }
    let by = OVal::Obj(kept.iter().map(|(k, recs)| (k.clone(), OVal::Arr(recs.iter().map(rec_json).collect()))).collect());
    let body = OVal::Obj(vec![("fetchedAt".into(), n(now)), ("byRepoKey".into(), by), ("recordCount".into(), n(count as i64))]).stringify();
    ops.push(write_op(home, &rel, format!("{body}\n"), true));
    Ok(Planned { unit: Unit { label: "active-cache".into(), lock: None, ops }, call, expect: json!(rel) })
}

// ---- start-up sampling ------------------------------------------------------------------------------------------------------

/// The probe's answer for one workspace: Node's `{ok, raw}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Probe {
    /// The probe ran and exited 0.
    pub ok: bool,
    /// The standard output.
    pub raw: String,
}

/// Where the sampling state lives, relative to the home.
pub fn sampling_state_rel() -> String {
    ds(defaults::text("devswarm_recon.file_sampling_state"))
}

/// Where the samples log lives, relative to the home.
pub fn samples_rel() -> String {
    format!("{}/{}/{}", defaults::text("mesh_write.dir_anti_hall"), defaults::text("mesh_write.dir_logs"), defaults::text("devswarm_recon.file_samples"))
}

fn liveness_rel(id: &str) -> String {
    ds(&format!("{}/{id}{}", defaults::text("devswarm_recon.dir_liveness"), defaults::text("mesh_write.json_suffix")))
}

/// `selectCandidates(descriptors, {maxProbe})`: workspaces whose persisted verdict reads stale or not-draining, in order, at most
/// `max_probe`.
pub fn sampling_candidates(home: &Path, ids: &[String], max_probe: usize) -> Vec<String> {
    let mut out = Vec::new();
    for id in ids {
        if !is_safe_id_text(id) {
            continue;
        }
        let Some(v) = file_json(home, &liveness_rel(id)) else { continue };
        let stale = matches!(v.get("status"), Some(OVal::Str(t)) if t == defaults::text("devswarm_recon.status_stale"));
        let not_draining = matches!(v.get("notDraining"), Some(OVal::Bool(true)));
        if stale || not_draining {
            out.push(id.clone());
            if out.len() >= max_probe {
                break;
            }
        }
    }
    out
}

/// `String(x)` of a `terminalId` the engine models (string, number, bool); anything else defers.
fn terminal_text(v: &OVal) -> R<Option<String>> {
    match v {
        OVal::Null => Ok(None),
        OVal::Str(t) => Ok(Some(t.clone())),
        OVal::Num(x) => Ok(Some(crate::checks::guardkit::ojson::js_number_text(*x))),
        OVal::Bool(b) => Ok(Some(b.to_string())),
        _ => defer("terminal-id-type"),
    }
}

/// The scope a sampling pass needs mirrored: the persisted verdicts of the candidates, the state file, the samples log and its
/// rotated copy.
pub fn sampling_scope(ids: &[String]) -> Scope {
    let mut files: Vec<String> = ids.iter().filter(|i| is_safe_id_text(i)).map(|i| liveness_rel(i)).collect();
    files.push(sampling_state_rel());
    files.push(samples_rel());
    Scope { files, dirs: Vec::new(), stores: Vec::new() }
}

/// `runSamplingPass(descriptors, {home, now, maxProbe, run})`: `ids` are the descriptors' ids in order, `probes` the answers of the
/// `workspace info` calls the caller made for [`sampling_candidates`] (a candidate without an answer counts as a failed probe).
/// Returns the ops and Node's `{ran, probed, captured}`.
pub fn plan_sampling(home: &Path, ids: &[String], max_probe: usize, probes: &[(String, Probe)], now: i64) -> R<Planned> {
    let candidates = sampling_candidates(home, ids, max_probe);
    let mut state = match file_json(home, &sampling_state_rel()) {
        Some(o @ OVal::Obj(_)) => o,
        Some(OVal::Arr(_)) => return defer("sampling-state-shape"),
        _ => OVal::Obj(Vec::new()),
    };
    let samples = samples_rel();
    let max = defaults::num("devswarm_recon.samples_max_bytes");
    let mut size = std::fs::metadata(home.join(&samples)).map_or(0, |m| m.len());
    let (mut ops, mut captured) = (Vec::new(), 0);
    for id in &candidates {
        let Some((_, p)) = probes.iter().find(|(i, _)| i == id) else { continue };
        if !p.ok || js_trim(&p.raw).is_empty() {
            continue;
        }
        let Some(info) = OVal::parse(&p.raw).filter(|v| !matches!(v, OVal::Null)) else { continue };
        let prior = state.get(id).and_then(|e| e.get("terminalId")).cloned();
        let prior_text = match &prior {
            None | Some(OVal::Null) => None,
            Some(v) => terminal_text(v)?,
        };
        let (worth, new_tid) = match &info {
            OVal::Obj(o) => {
                let has = |k: &str| o.iter().any(|(n, _)| n == k);
                let startup = if has("startup") { info.get("startup") } else { info.get("startupState") };
                let tid = match info.get("terminalId") {
                    None | Some(OVal::Null) => None,
                    Some(v) => terminal_text(v)?,
                };
                let changed = has("terminalId") && tid != prior_text;
                (startup.is_some_and(|v| !matches!(v, OVal::Null)) || changed, tid)
            }
            OVal::Arr(_) => (false, None),
            // `'terminalId' in info` throws on a primitive: Node's pass aborts there, the engine does not model it
            _ => return defer("probe-shape"),
        };
        if worth {
            let line = format!("{}\n", OVal::Obj(vec![("id".into(), s(id)), ("ts".into(), n(now)), ("raw".into(), info.clone())]).stringify());
            if size + line.len() as u64 > max {
                ops.push(Op::Rename { rel: samples.clone(), to: format!("{samples}{}", defaults::text("devswarm_recon.samples_rotated_suffix")) });
                size = 0;
            }
            size += line.len() as u64;
            ops.push(Op::Append { rel: samples.clone(), bytes: line.into_bytes() });
            captured += 1;
        }
        let entry = OVal::Obj(vec![("terminalId".into(), new_tid.as_deref().map_or(OVal::Null, s)), ("lastProbedAt".into(), n(now))]);
        state.set(id, entry);
    }
    if !candidates.is_empty() {
        ops.push(write_op(home, &sampling_state_rel(), state.stringify(), true));
    }
    let probes_json: serde_json::Map<String, Value> = probes.iter().map(|(i, p)| (i.clone(), json!({"ok": p.ok, "raw": p.raw}))).collect();
    Ok(Planned {
        unit: Unit { label: "sampling".into(), lock: None, ops },
        call: json!({"fn": "sampling", "args": {"ids": ids, "probes": probes_json, "now": now, "maxProbe": max_probe}}),
        expect: json!({"ran": true, "probed": candidates.len(), "captured": captured}),
    })
}

/// `defaultProbeRun(id)`: `hivecontrol workspace info <id>`, read-only and bounded.
pub fn probe(runner: &dyn crate::dsact::runner::Runner, id: &str) -> Probe {
    let mut args: Vec<String> = defaults::list("devswarm_recon.probe_args").iter().map(|a| (*a).to_string()).collect();
    args.push(id.to_string());
    let r = runner.run(&crate::dsact::runner::RunSpec { bin: None, args, timeout_ms: defaults::num("devswarm_recon.probe_timeout_ms"), ..Default::default() });
    Probe { ok: r.ok && r.status == Some(0), raw: r.stdout }
}

// ---- the mirror scope of the plain side files ---------------------------------------------------------------------------------

/// What a job over the plain side files needs mirrored: the files themselves plus the settings files a Node function reads.
pub fn scope_for(rels: &[String]) -> Scope {
    let mut files: Vec<String> = rels.to_vec();
    files.push(defaults::text("guardkit.settings_file").to_string());
    for f in defaults::list("devswarm_recon.settings_files") {
        files.push(f.to_string());
    }
    Scope { files, dirs: Vec::new(), stores: Vec::new() }
}

/// The path of the unit's files, for building a [`Scope`] (the targets of its Write/Unlink/Append/Rename ops).
pub fn touched(u: &Unit) -> Vec<String> {
    let mut out = Vec::new();
    for op in &u.ops {
        match op {
            Op::Write { rel, .. } | Op::Unlink { rel, .. } | Op::Append { rel, .. } => out.push(rel.clone()),
            Op::Rename { rel, to } => {
                out.push(rel.clone());
                out.push(to.clone());
            }
            Op::Upsert { .. } | Op::Derive { .. } | Op::Log { .. } | Op::Forward { .. } | Op::RaiseCursors { .. } | Op::RemoveRegistryIf { .. } | Op::Guard { .. } => {}
        }
    }
    out.sort();
    out.dedup();
    out
}
