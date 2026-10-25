//! Slice S2: `healRegistry`, `rehomeMiskeyedRow` and `repairRootMappedChildRows` (`scripts/devswarm-lib/fold.js`).
//!
//! `healRegistry(home, repoKey)` visits every registry row of one store and asks `rehomeMiskeyedRow` what is wrong with it. Natively
//! decided, per row:
//!
//! * the row is skipped (unsafe id; worktree gone and an archived counterpart exists);
//! * the descriptor is missing or belongs to another session (`no-descriptor`, `descriptor-identity-mismatch`) or its worktree
//!   names no repository (`unresolvable`): nothing changes;
//! * the row is correctly keyed: a stale `ownerKey` / `repoKey` on the descriptor is rewritten in place, and a stale registry
//!   `worktree_path` is refreshed from the descriptor (an `upsertRegistry` with the path-change opt-in, then the summary);
//! * the row is genuinely mis-keyed (its worktree belongs to another store): it is moved there (`super::rehome`: copy, verify,
//!   then tombstone the source registry row; no message row is ever deleted).
//!
//! A child row registered against the Primary checkout's path is first repaired from the app's own builder record.
use super::gate::{self, Job};
use super::rehome;
use super::view::{self, archived_rel, descriptor_rel, registry};
use super::{Hooks, Op, RegRow, Scope, Unit, UnitEnd};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::meshw::ident::{R, read_descriptor, repo_key_for_worktree};
use crate::meshw::idlock::is_safe_id;
use serde_json::{Value, json};
use std::path::Path;

/// What the planner decided for one store.
pub struct HealPlan {
    /// The gate job: one unit per visited row, the Node call and what it must return.
    pub job: Job,
    /// The rows handed back (id, why): none are decided here any more, the field is kept for a unit that cannot apply.
    pub deferred: Vec<(String, String)>,
    /// The mis-keyed rows to move (id, fresh repo key, the descriptor's worktree path), decided before anything was written.
    pub needs: Vec<(String, String, String)>,
    /// Node's `healRegistry` result for the rows handled here (the aggregate over all rows when none is deferred).
    pub result: Value,
    /// For each unit of the job, the row's id.
    pub ids: Vec<Option<String>>,
    /// Rows `healRegistry` counts as skipped without visiting them (unsafe id, archived counterpart).
    pub pre_skipped: usize,
}

/// How a run ended.
pub struct HealRun {
    /// `healRegistry`'s result over the rows that were applied or found already right.
    pub result: Value,
    /// Rows handed back to Node, with the reason.
    pub deferred: Vec<(String, String)>,
    /// What the witness said.
    pub verdict: gate::Verdict,
}

/// `String(v)` of a JSON value (`undefined` for an absent one; arrays join with commas, objects are `[object Object]`).
pub(super) fn js_string(v: Option<&OVal>) -> R<String> {
    Ok(match v {
        None => "undefined".to_string(),
        Some(other) => crate::dssup::appsync::plan::js_str(other),
    })
}

/// `isLiveSessionId(x)` then `String(x)`: a value that is not null, not empty and not a synthetic `unclaimed:` mint.
fn live_session(v: Option<&OVal>) -> R<Option<String>> {
    let text = match v {
        None | Some(OVal::Null) => return Ok(None),
        Some(other) => js_string(Some(other))?,
    };
    Ok((!text.is_empty() && !text.starts_with(defaults::text("devswarm_recon.synthetic_prefix"))).then_some(text))
}

/// A non-empty string field (`typeof x === 'string' && x`), else `None`.
fn nonempty_str(v: Option<&OVal>) -> Option<&str> {
    match v {
        Some(OVal::Str(t)) if !t.is_empty() => Some(t),
        _ => None,
    }
}

fn row_result(id: &str, healed_descriptor: bool, reason: Option<&str>, healed_path: bool) -> Value {
    let mut v = json!({"id": id, "rehomed": false, "healedDescriptor": healed_descriptor, "reason": reason});
    if healed_path {
        v["healedRegistryPath"] = json!(true);
    }
    v
}

/// What `rehomeMiskeyedRow` does for one registry row of `store`.
enum Row {
    /// Decided here: the result and the ops (maybe none).
    Done(Value, Vec<Op>),
    /// Genuinely mis-keyed: needs the move into the store its worktree belongs to (`fresh`), with the descriptor's path.
    Needs { fresh: String, worktree: String },
}

fn plan_row(home: &Path, store: &str, cur: &RegRow) -> R<Row> {
    let id = cur.row.id.as_str();
    let reason = |r: &str| Ok(Row::Done(row_result(id, false, Some(r), false), Vec::new()));
    let Some(desc) = read_descriptor(home, id) else { return reason("no-descriptor") };
    // `!desc.worktreePath` is JavaScript truthiness; a path that is not text resolves to no key (`repoKeyForWorktree(5)` is null)
    let wt_val = desc.get("worktreePath");
    if js_string(desc.get("id"))? != id || !wt_val.is_some_and(OVal::truthy) {
        return reason("no-descriptor");
    }
    let wt = match wt_val {
        Some(OVal::Str(t)) => Some(t.clone()),
        _ => None,
    };
    // identity guard: the row in this store and the descriptor must name the same live session
    let cur_sid = view::descriptor_of(cur).session_id.filter(|s| !s.starts_with(defaults::text("devswarm_recon.synthetic_prefix")));
    let desc_sid = live_session(desc.get("sessionId"))?;
    if !(cur_sid.is_some() && desc_sid.is_some() && cur_sid == desc_sid) {
        return reason("descriptor-identity-mismatch");
    }
    let fresh = match &wt {
        Some(w) => repo_key_for_worktree(w)?,
        None => None,
    };
    let (Some(fresh), Some(wt)) = (fresh, wt) else { return reason("unresolvable") };
    if fresh != store {
        return Ok(Row::Needs { fresh, worktree: wt });
    }
    let mut ops = Vec::new();
    let mut healed_descriptor = false;
    let stale = |k: &str| nonempty_str(desc.get(k)) != Some(store);
    if stale("ownerKey") || stale("repoKey") {
        let mut healed = desc.clone();
        healed.set("ownerKey", OVal::Str(store.to_string()));
        healed.set("repoKey", OVal::Str(store.to_string()));
        let rel = descriptor_rel(id);
        ops.push(Op::Write { rel: rel.clone(), bytes: healed.stringify().into_bytes(), pre: view::pre_of(home, &rel) });
        healed_descriptor = true;
    }
    let mut healed_path = false;
    let current = view::descriptor_of(cur);
    if current.worktree_path.as_deref() != Some(wt.as_str()) {
        let mut fixed = current;
        fixed.worktree_path = Some(wt);
        ops.push(Op::Upsert { store: store.to_string(), row: Box::new(fixed), pre: Some(Box::new(cur.clone())) });
        ops.push(Op::Derive { store: store.to_string() });
        healed_path = true;
    }
    Ok(Row::Done(row_result(id, healed_descriptor, None, healed_path), ops))
}

/// Plan `healRegistry(home, repoKey)` for one store.
pub fn plan(home: &Path, repo_key: &str) -> R<HealPlan> {
    let empty = |rows: Vec<Value>| json!({"repoKey": repo_key, "checked": 0, "healed": 0, "rehomed": 0, "rootMapped": 0, "skipped": 0, "rows": rows});
    if repo_key.is_empty() {
        let result = empty(Vec::new());
        let job = Job {
            label: defaults::text("devswarm_recon.job_heal").into(),
            scope: Scope::default(),
            units: Vec::new(),
            calls: vec![json!({"fn": "healRegistry", "args": {"repoKey": repo_key}})],
            expect: vec![Some(result.clone())],
        };
        return Ok(HealPlan { job, deferred: Vec::new(), needs: Vec::new(), result, ids: Vec::new(), pre_skipped: 0 });
    }
    let rows = registry(home, repo_key)?;
    let (mut units, mut ids, deferred) = (Vec::new(), Vec::new(), Vec::<(String, String)>::new());
    let mut needs: Vec<(String, String, String)> = Vec::new();
    let (mut checked, mut healed, mut skipped, mut pre_skipped) = (0, 0, 0, 0);
    let (mut out_rows, mut handled_ids): (Vec<Value>, Vec<String>) = (Vec::new(), Vec::new());
    let mut files = Vec::new();
    let mut needs_dirs = false;
    for cur in &rows {
        let id = cur.row.id.clone();
        if !is_safe_id(&id) {
            skipped += 1;
            pre_skipped += 1;
            continue;
        }
        files.push(descriptor_rel(&id));
        files.push(archived_rel(&id));
        let d = view::descriptor_of(cur);
        if let Some(wt) = d.worktree_path.as_deref()
            && !Path::new(wt).exists()
            && view::exists(home, &archived_rel(&id))
        {
            skipped += 1;
            pre_skipped += 1;
            continue;
        }
        checked += 1;
        match plan_row(home, repo_key, cur)? {
            Row::Needs { fresh, worktree } => {
                needs.push((id, fresh, worktree));
            }
            Row::Done(res, ops) => {
                if res["healedDescriptor"] == json!(true) || res["healedRegistryPath"] == json!(true) {
                    healed += 1;
                } else {
                    skipped += 1;
                }
                needs_dirs |= ops.iter().any(|o| matches!(o, Op::Derive { .. }));
                units.push(Unit { label: format!("heal:{id}"), lock: (!ops.is_empty()).then(|| id.clone()), ops });
                ids.push(Some(id.clone()));
                handled_ids.push(id);
                out_rows.push(res);
            }
        }
    }
    let result = json!({"repoKey": repo_key, "checked": checked, "healed": healed, "rehomed": 0, "rootMapped": 0, "skipped": skipped, "rows": out_rows});
    let (call, expect) = if deferred.is_empty() {
        (json!({"fn": "healRegistry", "args": {"repoKey": repo_key}}), result.clone())
    } else {
        (json!({"fn": "healRows", "args": {"repoKey": repo_key, "ids": handled_ids}}), Value::Array(out_rows.clone()))
    };
    let mut scope = super::side::scope_for(&files);
    scope.stores.push(repo_key.to_string());
    if needs_dirs {
        for d in defaults::list("devswarm_recon.summary_dirs") {
            scope.dirs.push(view::ds(d));
        }
    }
    let job = Job { label: defaults::text("devswarm_recon.job_heal").into(), scope, units, calls: vec![call], expect: vec![Some(expect)] };
    Ok(HealPlan { job, deferred, needs, result, ids, pre_skipped })
}

/// Plan and apply `healRegistry` for one store: the root-mapped child rows first (proof from the app's own builder record), then
/// every row: correctly keyed rows are healed in place (units, each under its id's lock), genuinely mis-keyed rows are MOVED into the
/// store their worktree belongs to (`super::rehome`). A unit that cannot apply (a busy lock, a drifted precondition) is reported in
/// `deferred` with nothing written for it.
pub fn run(ctx: &Ctx, runner: &dyn Runner, repo_key: &str, hooks: &Hooks) -> R<HealRun> {
    let root_fixed = rehome::repair_root_mapped(ctx, repo_key);
    let p = plan(ctx.home, repo_key)?;
    let out = gate::run(ctx, runner, &p.job, hooks);
    let mut deferred = p.deferred.clone();
    let mut kept = Vec::new();
    for ((end, id), row) in out.ends.iter().zip(p.ids.iter()).zip(p.result["rows"].as_array().cloned().unwrap_or_default()) {
        match end {
            UnitEnd::Applied => kept.push(row),
            UnitEnd::Deferred(why) | UnitEnd::Failed(why) => deferred.push((id.clone().unwrap_or_default(), why.clone())),
        }
    }
    for (id, fresh, worktree) in &p.needs {
        kept.push(rehome::mis_keyed(ctx, id, repo_key, fresh, worktree));
    }
    let flagged = |r: &Value| r["healedDescriptor"] == json!(true) || r["healedRegistryPath"] == json!(true);
    let rehomed = kept.iter().filter(|r| rehome::is_rehomed(r)).count();
    let healed_rows = kept.iter().filter(|r| !rehome::is_rehomed(r) && flagged(r)).count();
    let mut result = p.result.clone();
    result["checked"] = json!(kept.len());
    result["healed"] = json!(healed_rows + root_fixed);
    result["rehomed"] = json!(rehomed);
    result["rootMapped"] = json!(root_fixed);
    result["skipped"] = json!(p.pre_skipped + kept.len() - healed_rows - rehomed);
    result["rows"] = Value::Array(kept);
    Ok(HealRun { result, deferred, verdict: out.verdict })
}
