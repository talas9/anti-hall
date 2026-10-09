//! `retireArchivedWorktreeGroup` and `forwardArchivedOrphanUnread` (`scripts/devswarm-lib/fold.js`): the archive paths' use of the
//! fold. The survivor is chosen without liveness only when it is forced (no drainable sibling, or exactly one); anything else is
//! Node's. The forward of an archived partition's unread only ever adds rows to a registered survivor.
use super::fold::{Cx, Sim, descriptor_exists, forward_row, forwardable, is_live_sid, plan_group};
use super::gate::{self, Job, Verdict};
use super::view::{self};
use super::{Hooks, Op, RegRow, Unit, UnitEnd};
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::meshw::ident::{self, R, defer};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;

// ---- retireArchivedWorktreeGroup ------------------------------------------------------------------------------------------------

/// `archiveLeftReason(home, id, row, isAnchor)`.
fn left_reason(home: &Path, id: &str, row: Option<&RegRow>, anchor: bool) -> &'static str {
    if anchor {
        return defaults::text("devswarm_recon.reason_anchor");
    }
    if !descriptor_exists(home, id) {
        return defaults::text("devswarm_recon.reason_raced");
    }
    match row {
        Some(r) if view::descriptor_of(r).session_id.as_deref().is_some_and(is_live_sid) => defaults::text("devswarm_recon.reason_live_descriptor"),
        None => defaults::text("devswarm_recon.reason_live_descriptor"),
        _ => defaults::text("devswarm_recon.reason_no_live_session"),
    }
}

/// `pickArchiveForwardSurvivor(s, home, archivedId, rows)` where the answer needs no liveness: no drainable row, or exactly one.
fn pick_archive_survivor(home: &Path, archived: &str, rows: &[RegRow]) -> R<String> {
    let drainable: Vec<&RegRow> = rows
        .iter()
        .filter(|d| d.row.id != archived && descriptor_exists(home, &d.row.id) && view::descriptor_of(d).session_id.as_deref().is_some_and(is_live_sid))
        .collect();
    match drainable.len() {
        0 => Ok(archived.to_string()),
        1 => Ok(drainable[0].row.id.clone()),
        _ => defer("survivor-liveness"),
    }
}

/// The value Node's `retireArchivedWorktreeGroup` returns, as JSON.
pub fn archived_group_json(retired: &[String], forwarded: i64, left: &[(String, String)], forwarded_to: &str) -> Value {
    json!({
        "retired": retired,
        "forwarded": forwarded,
        "left": left.iter().map(|(i, r)| json!({"id": i, "reason": r})).collect::<Vec<_>>(),
        "forwardedTo": forwarded_to,
    })
}

/// What a retire of an archived worktree's group did.
pub struct ArchivedRun {
    /// Node's return value.
    pub result: Value,
    /// What the witness said.
    pub verdict: Verdict,
    /// Units handed back to Node.
    pub deferred: Vec<(String, String)>,
}

/// `retireArchivedWorktreeGroup(s, home, archivedId, worktreePath)` over the store `repo_key`.
pub fn retire_archived_worktree_group(ctx: &Ctx, runner: &dyn Runner, repo_key: &str, archived_id: &str, wt: &str, hooks: &Hooks) -> R<ArchivedRun> {
    let base = |v: Vec<(String, String)>, verdict| ArchivedRun { result: archived_group_json(&[], 0, &v, archived_id), verdict, deferred: Vec::new() };
    if wt.is_empty() || archived_id.is_empty() {
        return Ok(base(Vec::new(), Verdict::Agreed));
    }
    let Some(keep_real) = ident::canonical_worktree_real_path(wt)? else { return Ok(base(Vec::new(), Verdict::Agreed)) };
    let rows = view::registry(ctx.home, repo_key)?;
    let rd = view::reader(ctx.home, repo_key)?;
    let mut cands = Vec::new();
    for d in &rows {
        let Some(dwt) = view::descriptor_of(d).worktree_path else { continue };
        if d.row.id == archived_id || ident::canonical_worktree_real_path(&dwt)?.as_deref() != Some(keep_real.as_str()) {
            continue;
        }
        cands.push(d.clone());
    }
    if cands.is_empty() {
        return Ok(base(Vec::new(), Verdict::Agreed));
    }
    let survivor = pick_archive_survivor(ctx.home, archived_id, &cands)?;
    let fold_cands: Vec<RegRow> = cands.iter().filter(|d| d.row.id != survivor).cloned().collect();
    let cx = Cx { home: ctx.home, store: repo_key, rd: &rd, now: ctx.now, rows: &rows };
    let mut sim = Sim::default();
    let (units, out) = plan_group(&cx, &mut sim, &survivor, &fold_cands, true)?;
    let mut left: Vec<(String, String)> = Vec::new();
    if survivor != archived_id {
        left.push((survivor.clone(), defaults::text("devswarm_recon.reason_live_descriptor").to_string()));
    }
    let by_id: HashMap<&str, &RegRow> = cands.iter().map(|d| (d.row.id.as_str(), d)).collect();
    for x in &out.left {
        left.push((x.clone(), left_reason(ctx.home, x, by_id.get(x.as_str()).copied(), out.left_anchor.contains(x)).to_string()));
    }
    for f in &out.forward_failed {
        left.push((f.clone(), defaults::text("devswarm_recon.reason_forward_failed").to_string()));
    }
    for (i, r) in &out.skipped {
        left.push((i.clone(), r.clone()));
    }
    let want = archived_group_json(&out.retired, out.forwarded, &left, &survivor);
    let call = json!({"fn": "retireArchived", "args": {"repoKey": repo_key, "id": archived_id, "worktreePath": wt}});
    let mut scope = super::side::scope_for(&[]);
    scope.stores.push(repo_key.to_string());
    for d in defaults::list("devswarm_recon.summary_dirs") {
        scope.dirs.push(view::ds(d));
    }
    scope.dirs.push(view::ds(defaults::text("devswarm_recon.dir_retired")));
    scope.dirs.push(view::ds(defaults::text("mesh_write.dir_cursor_log")));
    let job = Job { label: defaults::text("devswarm_recon.job_archived").into(), scope, units, calls: vec![call], expect: vec![Some(want.clone())] };
    let res = gate::run(ctx, runner, &job, hooks);
    let deferred = job.units.iter().zip(res.ends.iter()).filter(|(_, e)| matches!(e, UnitEnd::Deferred(_) | UnitEnd::Failed(_))).map(|(u, e)| (u.label.clone(), format!("{e:?}"))).collect();
    Ok(ArchivedRun { result: want, verdict: res.verdict, deferred })
}

// ---- forwardArchivedOrphanUnread -----------------------------------------------------------------------------------------------

/// What `forwardArchivedOrphanUnread` reports.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchivedForward {
    /// Rows added to the survivor.
    pub forwarded: i64,
    /// Rows older than the age bar, not forwarded.
    pub stale: i64,
    /// `ok` or `gone`.
    pub status: String,
}

/// Plan `forwardArchivedOrphanUnread(s, id, survivor, {home, now, maxAgeMs})`: the unit (empty when nothing is forwarded) and
/// Node's answer. A destination that is not registered answers `gone` (an archived-only destination is Node's).
pub fn plan_forward_archived(home: &Path, store: &str, id: &str, survivor: &str, now: i64, max_age_ms: f64, allow_archived_dest: bool) -> R<(Option<Unit>, ArchivedForward)> {
    let rd = view::reader(home, store)?;
    let rows = view::registry(home, store)?;
    let cur = view::cursor_rows(&rd, id)?;
    let since = view::store_floor(home, &rd, id, &cur)?;
    let msgs = view::messages_of(&rd, id)?;
    let prefix = defaults::render("devswarm_recon.archived_forward_prefix", &[("id", &id)]);
    let (mut batch, mut stale) = (Vec::new(), 0);
    for m in msgs.iter().skip(since.max(0) as usize) {
        if !forwardable(m) {
            continue;
        }
        if ((now - m.ts) as f64) > max_age_ms {
            stale += 1;
            continue;
        }
        batch.push(forward_row(m, survivor, format!("{prefix}{}", m.body))?);
    }
    if batch.is_empty() {
        return Ok((None, ArchivedForward { forwarded: 0, stale, status: defaults::text("devswarm_recon.status_ok").into() }));
    }
    if !rows.iter().any(|r| r.row.id == survivor) {
        if allow_archived_dest {
            return defer("archived-destination");
        }
        return Ok((None, ArchivedForward { forwarded: 0, stale, status: defaults::text("devswarm_recon.status_gone").into() }));
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut inserted = 0;
    for b in &batch {
        let h = b.hash.clone().unwrap_or_default();
        if !view::hash_present(&rd, &h)? && seen.insert(h) {
            inserted += 1;
        }
    }
    let guard = Op::Guard {
        store: store.to_string(),
        partition: id.to_string(),
        sig: view::partition_sig(home, store, id)?,
        files: vec![(view::primary_cursor_rel(id), view::pre_of(home, &view::primary_cursor_rel(id)))],
    };
    let unit = Unit { label: format!("forward-archived:{id}"), lock: None, ops: vec![guard, Op::Forward { store: store.to_string(), dest: survivor.to_string(), rows: batch }] };
    Ok((Some(unit), ArchivedForward { forwarded: inserted, stale, status: defaults::text("devswarm_recon.status_ok").into() }))
}

/// Witness and apply [`plan_forward_archived`].
pub fn forward_archived_orphan_unread(ctx: &Ctx, runner: &dyn Runner, store: &str, id: &str, survivor: &str, max_age_ms: f64, hooks: &Hooks) -> R<(ArchivedForward, Verdict, Vec<UnitEnd>)> {
    let (unit, res) = plan_forward_archived(ctx.home, store, id, survivor, ctx.now, max_age_ms, false)?;
    let want = json!({"forwarded": res.forwarded, "stale": res.stale, "status": res.status});
    let call = json!({"fn": "forwardArchived", "args": {"repoKey": store, "id": id, "survivor": survivor, "now": ctx.now, "maxAgeMs": max_age_ms}});
    let mut scope = super::side::scope_for(&[]);
    scope.stores.push(store.to_string());
    scope.dirs.push(view::ds(defaults::text("mesh_write.dir_cursors")));
    let job = Job { label: defaults::text("devswarm_recon.job_forward_archived").into(), scope, units: unit.into_iter().collect(), calls: vec![call], expect: vec![Some(want)] };
    let out = gate::run(ctx, runner, &job, hooks);
    Ok((res, out.verdict, out.ends))
}

