//! `retireWorktreeDuplicates` (`scripts/devswarm-lib/fold.js`): fold every other registry row of the caller's physical worktree
//! into the caller's own row, through the same per-candidate plan as the project-wide fold (see [`super::fold`]).
use super::fold::{Cx, FoldOut, Sim, derive_blocked, plan_group};
use super::gate::{self, Job, Verdict};
use super::view::{self};
use super::{Hooks, Op, Unit, UnitEnd};
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::meshw::ident::{self, R, defer};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

// ---- retireWorktreeDuplicates ---------------------------------------------------------------------------------------------------

/// The value Node's `retireWorktreeDuplicates` returns (`null` is `None`).
pub fn dup_result(out: &FoldOut) -> Option<Value> {
    if out.retired.is_empty() && out.left.is_empty() && out.forwarded == 0 && out.forward_failed.is_empty() && out.skipped.is_empty() {
        return None;
    }
    let mut v = json!({"retired": out.retired, "forwarded": out.forwarded});
    if !out.left.is_empty() {
        v["left"] = json!(out.left);
    }
    if !out.skipped.is_empty() {
        v["pending"] = Value::Array(out.skipped.iter().map(|(i, r)| json!({"id": i, "reason": r})).collect());
    }
    Some(v)
}

/// What `retireWorktreeDuplicates` did for one caller.
pub struct DupRun {
    /// Node's return value (`None`: `null`).
    pub result: Option<Value>,
    /// What the witness said.
    pub verdict: Verdict,
    /// Units handed back to Node.
    pub deferred: Vec<(String, String)>,
}

/// `retireWorktreeDuplicates(home, {id, worktreePath}, {cwd})`: fold every other registry row of the caller's physical worktree
/// into the caller's row.
pub fn retire_worktree_duplicates(ctx: &Ctx, runner: &dyn Runner, cwd: &str, keep_id: &str, keep_wt: &str, hooks: &Hooks) -> R<DupRun> {
    let none = |v| DupRun { result: None, verdict: v, deferred: Vec::new() };
    if keep_id.is_empty() || keep_wt.is_empty() {
        return Ok(none(Verdict::Agreed));
    }
    if ident::primary_workspace_id(keep_wt)? == keep_id {
        return Ok(none(Verdict::Agreed));
    }
    let Some(keep_real) = ident::canonical_worktree_real_path(keep_wt)? else { return Ok(none(Verdict::Agreed)) };
    let Some(repo_key) = ident::resolve_context(cwd, true)?.repo_key else { return Ok(none(Verdict::Agreed)) };
    if !ctx.home.join(view::store_rel(&repo_key)).is_dir() {
        return defer("store-missing"); // Node would create it
    }
    let rows = view::registry(ctx.home, &repo_key)?;
    let rd = view::reader(ctx.home, &repo_key)?;
    let mut cands = Vec::new();
    for d in &rows {
        let Some(wt) = view::descriptor_of(d).worktree_path else { continue };
        if d.row.id == keep_id || ident::canonical_worktree_real_path(&wt)?.as_deref() != Some(keep_real.as_str()) {
            continue;
        }
        cands.push(d.clone());
    }
    let cx = Cx { home: ctx.home, store: &repo_key, rd: &rd, now: ctx.now, rows: &rows };
    let mut sim = Sim::default();
    let (mut units, out) = plan_group(&cx, &mut sim, keep_id, &cands, false)?;
    let calls = vec![json!({"fn": "retireDup", "args": {"cwd": cwd, "id": keep_id, "worktreePath": keep_wt}})];
    let expect = vec![Some(dup_result(&out).unwrap_or(Value::Null))];
    if !out.retired.is_empty() || out.forwarded > 0 {
        let retired: HashSet<String> = out.retired.iter().cloned().collect();
        let raised: HashMap<String, i64> = out.raised.iter().cloned().collect();
        if derive_blocked(&cx, &retired, &raised)? {
            return defer(defaults::text("devswarm_recon.why_summary_orphan"));
        }
        units.push(Unit { label: defaults::text("devswarm_recon.label_derive").into(), lock: None, ops: vec![Op::Derive { store: repo_key.clone() }] });
    }
    let mut scope = super::side::scope_for(&[]);
    scope.stores.push(repo_key.clone());
    for d in defaults::list("devswarm_recon.summary_dirs") {
        scope.dirs.push(view::ds(d));
    }
    scope.dirs.push(view::ds(defaults::text("devswarm_recon.dir_retired")));
    scope.dirs.push(view::ds(defaults::text("mesh_write.dir_cursor_log")));
    let job = Job { label: defaults::text("devswarm_recon.job_dup").into(), scope, units, calls, expect };
    let res = gate::run(ctx, runner, &job, hooks);
    let deferred = job.units.iter().zip(res.ends.iter()).filter(|(_, e)| matches!(e, UnitEnd::Deferred(_) | UnitEnd::Failed(_))).map(|(u, e)| (u.label.clone(), format!("{e:?}"))).collect();
    Ok(DupRun { result: dup_result(&out), verdict: res.verdict, deferred })
}

