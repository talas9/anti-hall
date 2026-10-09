//! Slice S6: the mesh fold (`scripts/devswarm-lib/fold.js`): `foldMeshDuplicates`, `foldGroupIntoSurvivor`,
//! `rekeySubdirRegistryRows`, `retireWorktreeDuplicates`, `retireArchivedWorktreeGroup`, `ghostRegistryRows` and
//! `forwardArchivedOrphanUnread`.
//!
//! The fold moves mail between partitions and removes duplicate registry rows, so every decision is witnessed first (see the
//! module header of [`super`]). Per candidate row the order is Node's: forward the unread mail into the survivor (rows are only
//! ever added, and a hash that already exists is ignored), raise the candidate's reader cursors over the forwarded prefix, journal
//! the cursor move, then (unless the candidate has a descriptor) remove the registry row with the conditional delete and leave
//! a redirect file. No message row is deleted or updated: the op vocabulary cannot express it.
//!
//! The engine decides a group only when it can reproduce Node's answer exactly; otherwise the WHOLE group is handed back to Node
//! (nothing planned, nothing written for it), because a candidate's verdict depends on the other candidates of its group:
//!
//! * the survivor choice needs liveness (`isRoutingLiveRowStrict`: a harness session's dormancy) unless it is forced: exactly one
//!   row of the group carries a real session, no other row has a heartbeat file, and that row also wins the deterministic
//!   fallback (so it is the survivor whether or not it is live);
//! * a candidate whose id is its worktree's mesh id (the anchor) is decided natively when a descriptor or reader evidence
//!   protects it; when only liveness could tell (a heartbeat file, a real session without a descriptor) the group goes to Node;
//! * a candidate partition without floor rows whose cursor would have to move needs Node's legacy-cursor import;
//! * a cursor journal that would roll over, a partition message of a type the engine does not model, a deadline.
//!
//! Deferral reasons are the `Defer` texts below; a unit that ends deferred or failed on the real home is reported the same way.
use super::gate::{self, Job, Verdict};
use super::view::{self, Msg, archived_rel, descriptor_rel, exists, heartbeat_rel, retired_rel};
use super::{Hooks, Op, Pre, RegRow, Scope, Unit, UnitEnd};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::num::to_js_string;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::mesh::MeshReader;
use crate::meshw::ident::{self, Defer, R, defer};
use crate::meshw::idlock::is_safe_id;
use crate::meshw::store::{CursorRow, MeshRow, mesh_message_hash};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// What `foldGroupIntoSurvivor` returned for the candidates the engine planned.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FoldOut {
    /// Candidates whose registry row is removed.
    pub retired: Vec<String>,
    /// Candidates that stay (descriptor-backed, protected anchors, or a lost conditional delete).
    pub left: Vec<String>,
    /// The subset of `left` protected as an attended anchor.
    pub left_anchor: HashSet<String>,
    /// Candidates whose forward failed (never planned natively).
    pub forward_failed: Vec<String>,
    /// Rows the forward added.
    pub forwarded: i64,
    /// Candidates not acted on, with the reason (`survivor-gone`).
    pub skipped: Vec<(String, String)>,
    /// Partitions whose store cursors the plan raises, with the new position.
    pub raised: Vec<(String, i64)>,
}

impl FoldOut {
    /// The value the witness dispatcher reports for a `foldGroup` call.
    pub fn as_json(&self) -> Value {
        json!({
            "retired": self.retired,
            "left": self.left,
            "forwardFailed": self.forward_failed,
            "forwarded": self.forwarded,
            "skipped": self.skipped.iter().map(|(i, r)| json!({"id": i, "reason": r})).collect::<Vec<_>>(),
        })
    }
}

/// Planning state shared by the candidates of one pass.
#[derive(Clone, Default)]
pub(super) struct Sim {
    /// Hashes the plan already adds (a later candidate's duplicate is ignored by the store).
    hashes: HashSet<String>,
    /// Lines the plan already adds to each cursor journal.
    log_added: HashMap<PathBuf, usize>,
}

/// Everything a group plan reads.
pub(super) struct Cx<'a> {
    pub(super) home: &'a Path,
    pub(super) store: &'a str,
    pub(super) rd: &'a MeshReader,
    pub(super) now: i64,
    pub(super) rows: &'a [RegRow],
}

pub(super) fn is_live_sid(sid: &str) -> bool {
    !sid.is_empty() && !sid.starts_with(defaults::text("devswarm_recon.synthetic_prefix"))
}

pub(super) fn forwardable(m: &Msg) -> bool {
    !m.is_heartbeat
        && m.mtype.as_deref() == Some(defaults::text("mesh_write.mtype_direct"))
        && m.sender.as_deref().is_some_and(|s| !js_trim(s).is_empty())
        && m.recipient.as_deref().is_some_and(|s| !js_trim(s).is_empty())
}

fn cmp_utf16(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `meshRowCopy(m, 'message', {...})` plus the hash, as the row the forward inserts.
pub(super) fn forward_row(m: &Msg, dest: &str, body: String) -> R<MeshRow> {
    let Some(from) = m.sender.clone() else { return defer("forward-sender") };
    let urgency = m.urgency.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| defaults::text("mesh_write.urgency_default").to_string());
    let orig = if m.orig_hash.is_some() { m.orig_hash.clone() } else { m.hash.clone() }.filter(|h| !h.is_empty());
    let direct = defaults::text("mesh_write.mtype_direct");
    let hash = mesh_message_hash(Some(&from), Some(dest), direct, &urgency, &body, &to_js_string(m.ts as f64), m.needs_reply);
    Ok(MeshRow {
        workspace_id: dest.to_string(),
        ts: m.ts,
        hash: Some(hash),
        body,
        sender: Some(from),
        recipient: Some(dest.to_string()),
        mtype: Some(direct.to_string()),
        urgency: Some(urgency),
        is_heartbeat: false,
        needs_reply: m.needs_reply,
        orig_hash: orig,
        instance_nonce: m.instance_nonce.clone(),
    })
}

fn rel_of(home: &Path, p: &Path) -> String {
    p.strip_prefix(home).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default()
}

/// One line of a cursor-write journal, as `logCursorWrite` writes it for a fold move.
fn cursor_log_line(now: i64, id: &str, ns: &str, from: i64, to: i64) -> String {
    let n = |x: i64| OVal::Num(x as f64);
    let s = |x: &str| OVal::Str(x.to_string());
    let rec = OVal::Obj(vec![
        ("ts".into(), n(now)),
        ("id".into(), s(id)),
        ("partition".into(), s(id)),
        ("callerId".into(), OVal::Null),
        ("ns".into(), s(ns)),
        ("from".into(), n(from)),
        ("to".into(), n(to)),
        ("delivered".into(), OVal::Null),
        ("pid".into(), OVal::Num(f64::from(std::process::id()))),
        ("nonce".into(), OVal::Null),
        ("gate".into(), s(defaults::text("devswarm_recon.log_gate_fold"))),
        ("verb".into(), s(defaults::text("devswarm_recon.log_verb_fold"))),
        ("cwd".into(), OVal::Null),
        ("ok".into(), OVal::Bool(true)),
    ]);
    format!("{}\n", rec.stringify())
}

/// Lines a cursor journal holds now, counted the way `logCursorWrite` counts before it rotates.
fn journal_lines(p: &Path) -> usize {
    std::fs::read_to_string(p).map_or(0, |t| t.split('\n').filter(|l| !l.trim().is_empty()).count())
}

pub(super) fn descriptor_exists(home: &Path, id: &str) -> bool {
    ident::read_descriptor(home, id).is_some()
}

/// The deterministic fallback of `pickFreshestLive` over rows none of which is live (`pickDeterministicFallback`).
fn fallback_winner(rows: &[RegRow]) -> Option<&RegRow> {
    let upd = |r: &RegRow| r.updated_at.unwrap_or(0);
    let mut winner: Option<&RegRow> = None;
    for d in rows {
        let Some(w) = winner else {
            winner = Some(d);
            continue;
        };
        match upd(d).cmp(&upd(w)) {
            std::cmp::Ordering::Greater => winner = Some(d),
            std::cmp::Ordering::Less => {}
            std::cmp::Ordering::Equal => {
                if cmp_utf16(&d.row.id, &w.row.id) == std::cmp::Ordering::Less {
                    winner = Some(d);
                }
            }
        }
    }
    winner
}

/// `pickSurvivor(s, {rows}, home)` where the answer does not depend on liveness (see the module header).
fn pick_survivor(home: &Path, rows: &[RegRow]) -> R<String> {
    let live: Vec<&RegRow> = rows.iter().filter(|r| view::descriptor_of(r).session_id.as_deref().is_some_and(is_live_sid)).collect();
    if live.len() != 1 {
        return defer("survivor-liveness");
    }
    let l = live[0];
    if rows.iter().any(|r| r.row.id != l.row.id && exists(home, &heartbeat_rel(&r.row.id))) {
        return defer("survivor-heartbeat");
    }
    match fallback_winner(rows) {
        Some(w) if w.row.id == l.row.id => Ok(l.row.id.clone()),
        _ => defer("survivor-liveness"),
    }
}

/// `ghostRegistryRows(s, home, rows, {now, env})`.
pub fn ghost_rows(home: &Path, rd: &MeshReader, rows: &[RegRow], now: i64, max_age_ms: f64) -> R<Vec<RegRow>> {
    let mut out = Vec::new();
    for r in rows {
        let id = r.row.id.as_str();
        if !is_safe_id(id) {
            continue;
        }
        if view::descriptor_of(r).session_id.is_some() {
            continue;
        }
        if descriptor_exists(home, id) || exists(home, &heartbeat_rel(id)) {
            continue;
        }
        let cur = view::cursor_rows(rd, id)?;
        if view::store_floor(home, rd, id, &cur)? > 0 {
            continue;
        }
        if exists(home, &view::primary_cursor_rel(id)) {
            continue;
        }
        let upd = r.updated_at.unwrap_or(0);
        if upd <= 0 || ((now - upd) as f64) < max_age_ms {
            continue;
        }
        out.push(r.clone());
    }
    Ok(out)
}

/// `ghostRowMaxAgeMs(env)`: the age bar in milliseconds. An environment value Node's `Number()` would read in a way the engine
/// does not model hands the decision to Node.
pub fn ghost_age_ms(env: &HashMap<String, String>) -> R<f64> {
    let hours = match env.get(defaults::text("devswarm_recon.ghost_age_env")).map(|v| v.trim()).filter(|v| !v.is_empty()) {
        None => defaults::num("devswarm_recon.ghost_age_default_h") as f64,
        Some(v) => {
            let plain = v.chars().all(|c| c.is_ascii_digit() || c == '.') && v.matches('.').count() <= 1 && v.chars().any(|c| c.is_ascii_digit());
            if !plain {
                return defer("ghost-age-env");
            }
            match v.parse::<f64>() {
                Ok(h) if h.is_finite() && h > 0.0 => h,
                _ => defaults::num("devswarm_recon.ghost_age_default_h") as f64,
            }
        }
    };
    Ok(hours * 3_600_000.0)
}

/// Plan `foldGroupIntoSurvivor(s, home, survivor, candidates, {lockCandidates})` for one group: the units (one per candidate with
/// something to write, in Node's order) and the value Node returns. A candidate the engine cannot decide defers the group.
pub(super) fn plan_group(cx: &Cx, sim: &mut Sim, survivor: &str, cands: &[RegRow], lock_candidates: bool) -> R<(Vec<Unit>, FoldOut)> {
    let mut group_ids: HashSet<String> = cands.iter().map(|c| c.row.id.clone()).collect();
    group_ids.insert(survivor.to_string());
    let mut out = FoldOut::default();
    let mut units = Vec::new();
    let log_cap = defaults::num("mesh_write.cursor_log_cap") as usize;
    for cand in cands {
        let id = cand.row.id.clone();
        if id == survivor {
            continue;
        }
        if !is_safe_id(&id) {
            return defer("unsafe-id");
        }
        let d = view::descriptor_of(cand);
        let sid = d.session_id.clone().unwrap_or_default();
        let stale = !sid.is_empty() && sid != id && group_ids.contains(&sid);
        // ---- the mesh-anchor guard
        if let Some(wt) = d.worktree_path.as_deref() {
            let mesh = match ident::canonical_mesh_id(wt)? {
                Some(m) => Some(m),
                None => ident::raw_path_mesh_id(wt)?,
            };
            if mesh.as_deref() == Some(id.as_str()) {
                let evidence = view::has_reader_evidence(cx.home, cx.rd, &id)?;
                let beat = exists(cx.home, &heartbeat_rel(&id));
                let anchor = if stale {
                    if evidence {
                        true
                    } else if beat {
                        return defer("anchor-heartbeat");
                    } else {
                        false
                    }
                } else if evidence || descriptor_exists(cx.home, &id) {
                    true
                } else if beat {
                    return defer("anchor-heartbeat");
                } else if is_live_sid(&sid) {
                    return defer("anchor-dormancy");
                } else {
                    false
                };
                if anchor {
                    out.left.push(id.clone());
                    out.left_anchor.insert(id);
                    continue;
                }
            }
        }
        // ---- foldOne: forward, raise, tombstone
        let rows_c = view::cursor_rows(cx.rd, &id)?;
        let since = view::store_floor(cx.home, cx.rd, &id, &rows_c)?;
        let seen_rel = view::seen_cursor_rel(survivor, &id);
        let seen = seen_rel.as_ref().map_or(0, |r| crate::meshw::cursors::read_cursor(&cx.home.join(r)) as i64);
        let forward_from = since.max(seen);
        let msgs = view::messages_of(cx.rd, &id)?;
        let (mut pos, mut advance_to, mut saw_gap) = (since, since, false);
        let mut batch: Vec<MeshRow> = Vec::new();
        for m in msgs.iter().skip(since.max(0) as usize) {
            pos += 1;
            if pos <= forward_from || !forwardable(m) {
                saw_gap = true;
                continue;
            }
            batch.push(forward_row(m, survivor, m.body.clone())?);
            if !saw_gap {
                advance_to = pos;
            }
        }
        let mut ops: Vec<Op> = Vec::new();
        if !batch.is_empty() {
            if !cx.rows.iter().any(|r| r.row.id == survivor) {
                out.skipped.push((id, defaults::text("devswarm_recon.reason_survivor_gone").to_string()));
                continue;
            }
            for b in &batch {
                let h = b.hash.clone().unwrap_or_default();
                if !sim.hashes.contains(&h) && !view::hash_present(cx.rd, &h)? {
                    sim.hashes.insert(h);
                    out.forwarded += 1;
                }
            }
            ops.push(Op::Forward { store: cx.store.to_string(), dest: survivor.to_string(), rows: batch });
        }
        if advance_to > since {
            if crate::meshw::cursors::needs_import(&rows_c) {
                return defer("cursor-import-needed");
            }
            let ns = defaults::text("mesh_write.ns_store");
            let moved = rows_c.iter().filter(|r: &&CursorRow| r.ns == ns && r.value < advance_to).count();
            let key = crate::meshw::send::hash_from_workspace_id(&id);
            let journal = crate::meshw::cursors::log_path(cx.home, Some(&key));
            let lines = if moved > 0 { 2 } else { 1 };
            let added = sim.log_added.entry(journal.clone()).or_insert(0);
            if journal_lines(&journal) + *added + lines > log_cap {
                return defer("cursor-log-rotation");
            }
            *added += lines;
            let rel = rel_of(cx.home, &journal);
            out.raised.push((id.clone(), advance_to));
            ops.push(Op::RaiseCursors { store: cx.store.to_string(), partition: id.clone(), value: advance_to });
            if moved > 0 {
                ops.push(Op::Append { rel: rel.clone(), bytes: cursor_log_line(cx.now, &id, defaults::text("mesh_write.log_ns_store"), since, advance_to).into_bytes() });
            }
            ops.push(Op::Append { rel, bytes: cursor_log_line(cx.now, &id, ns, since, advance_to).into_bytes() });
        }
        if !stale && descriptor_exists(cx.home, &id) {
            out.left.push(id.clone());
        } else {
            // removeRegistryIf's guard: the descriptor's reading of the row against the stored columns, NULL-safe
            let snap_sess = d.session_id.clone();
            let snap_upd = Some(cand.updated_at.unwrap_or(0));
            let snap_ws = cand.write_seq;
            if cand.row.session_id == snap_sess && cand.updated_at == snap_upd && cand.write_seq == snap_ws {
                ops.push(Op::RemoveRegistryIf { store: cx.store.to_string(), id: id.clone(), session_id: snap_sess, updated_at: snap_upd, write_seq: snap_ws, pre: Box::new(cand.clone()) });
                let redirect = OVal::Obj(vec![("retiredTo".into(), OVal::Str(survivor.to_string())), ("at".into(), OVal::Num(cx.now as f64))]).stringify();
                ops.push(Op::Write { rel: retired_rel(&id), bytes: redirect.into_bytes(), pre: Pre::Any });
                out.retired.push(id.clone());
            } else {
                out.left.push(id.clone());
            }
        }
        if !ops.is_empty() {
            let mut files = vec![view::primary_cursor_rel(&id), descriptor_rel(&id), heartbeat_rel(&id)];
            files.extend(seen_rel);
            let guard = Op::Guard {
                store: cx.store.to_string(),
                partition: id.clone(),
                sig: view::partition_sig(cx.home, cx.store, &id)?,
                files: files.into_iter().map(|f| (f.clone(), view::pre_of(cx.home, &f))).collect(),
            };
            let mut all = vec![guard];
            all.extend(ops);
            units.push(Unit { label: format!("fold:{id}"), lock: lock_candidates.then(|| id.clone()), ops: all });
        }
    }
    Ok((units, out))
}

/// Whether the closing `deriveSummary` would meet a partition the engine's projection cannot classify: an unregistered
/// (or archived) partition with unread mail once the plan's retirements and cursor raises are in. Node derives after a fold
/// that retired or forwarded anything, so a fold the engine could not close with the same projection is Node's.
pub(super) fn derive_blocked(cx: &Cx, retired: &HashSet<String>, raised: &HashMap<String, i64>) -> R<bool> {
    let archived = crate::meshw::summary::archive_complete_ids(cx.home);
    let registered: HashSet<&str> = cx.rows.iter().map(|r| r.row.id.as_str()).filter(|i| !retired.contains(*i) && !archived.contains(*i)).collect();
    let bpart = defaults::text("mesh_write.broadcast_partition");
    for id in cx.rd.workspace_ids() {
        if id == bpart || registered.contains(id.as_str()) || !is_safe_id(&id) {
            continue;
        }
        let total = view::message_count(cx.rd, &id)?;
        let rows = view::cursor_rows(cx.rd, &id)?;
        let floor = view::store_floor(cx.home, cx.rd, &id, &rows)?.max(raised.get(&id).copied().unwrap_or(0));
        if total - floor > 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---- rekeySubdirRegistryRows ---------------------------------------------------------------------------------------------------

/// `needsRekey(row)`: the canonical toplevel path to write, or `None` (already canonical, non-git, or unresolvable).
fn needs_rekey(wt: &str) -> R<Option<String>> {
    let Some(top) = ident::resolve_context(wt, false)?.worktree_root else { return Ok(None) };
    let canon = ident::primary_workspace_id(&top)?;
    if ident::primary_workspace_id(wt)? == canon { Ok(None) } else { Ok(Some(top)) }
}

/// Plan `rekeySubdirRegistryRows(s, home, false)`: one unit per row to re-key, the count, and the rows as they will read afterwards.
fn plan_rekey(cx_home: &Path, now: i64, store: &str, rows: &[RegRow]) -> R<(Vec<Unit>, Vec<RegRow>)> {
    let mut units = Vec::new();
    let mut after = rows.to_vec();
    for (i, cur) in rows.iter().enumerate() {
        let Some(wt) = view::descriptor_of(cur).worktree_path else { continue };
        let Some(top) = needs_rekey(&wt)? else { continue };
        let mut fixed = view::descriptor_of(cur);
        fixed.worktree_path = Some(top.clone());
        units.push(Unit {
            label: format!("rekey:{}", cur.row.id),
            lock: Some(cur.row.id.clone()),
            ops: vec![Op::Upsert { store: store.to_string(), row: Box::new(fixed), pre: Some(Box::new(cur.clone())) }],
        });
        after[i].row.worktree_path = Some(top);
        after[i].updated_at = Some(now);
        after[i].write_seq = Some(cur.write_seq.unwrap_or(0) + 1);
    }
    let _ = cx_home;
    Ok((units, after))
}

// ---- foldMeshDuplicates --------------------------------------------------------------------------------------------------------

/// What the groups of a store contribute, collected apart so a closing summary that cannot be reproduced drops them together.
#[derive(Default)]
struct Groups {
    units: Vec<Unit>,
    tags: Vec<Tag>,
    calls: Vec<Value>,
    expect: Vec<Option<Value>>,
    result: FoldRun,
    raised: Vec<(String, i64)>,
    ids: Vec<String>,
}

/// What the planner decided for one store.
pub struct FoldPlan {
    /// The gate job.
    pub job: Job,
    /// For each unit of the job, what it contributes to the result.
    pub tags: Vec<Tag>,
    /// The result over everything the engine planned.
    pub result: FoldRun,
    /// Groups handed to Node before anything was written: the ids of their rows and why.
    pub deferred: Vec<(Vec<String>, String)>,
}

/// What a unit contributes to the result if it applies.
#[derive(Debug, Clone, PartialEq)]
pub enum Tag {
    /// A re-keyed row.
    Rekey,
    /// A folded candidate, with whether its row is removed.
    Fold {
        /// The candidate's id.
        id: String,
        /// Whether its registry row is removed.
        retired: bool,
    },
    /// The closing `deriveSummary`.
    Derive,
}

/// The aggregate `foldMeshDuplicates` reports.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FoldRun {
    /// Retired registry ids.
    pub retired: Vec<String>,
    /// Rows added by forwarding.
    pub forwarded: i64,
    /// Groups with something acted on.
    pub folded: i64,
    /// Candidates left in place.
    pub left: Vec<String>,
    /// Candidates not acted on this pass.
    pub pending: Vec<(String, String)>,
    /// Rows re-keyed.
    pub rekeyed: i64,
    /// Zero-live groups refused: the mesh id and the row ids.
    pub needs_attention: Vec<(String, Vec<String>)>,
    /// Mesh ids shared by two distinct worktrees.
    pub mesh_id_collisions: i64,
}

/// Plan `foldMeshDuplicates(home, {repoKey, now})` for one store.
pub fn plan_fold(ctx: &Ctx, repo_key: &str) -> R<FoldPlan> {
    let home = ctx.home;
    let empty = || FoldPlan {
        job: Job { label: defaults::text("devswarm_recon.job_fold").into(), scope: Scope::default(), units: Vec::new(), calls: Vec::new(), expect: Vec::new() },
        tags: Vec::new(),
        result: FoldRun::default(),
        deferred: Vec::new(),
    };
    if repo_key.is_empty() || !home.join(view::store_rel(repo_key)).is_dir() {
        return Ok(empty());
    }
    let rows0 = view::registry(home, repo_key)?;
    let rd = view::reader(home, repo_key)?;
    let ghost_ms = ghost_age_ms(&ctx.st.env)?;
    let (mut units, mut tags, mut calls, mut expect) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut result = FoldRun::default();
    let mut deferred: Vec<(Vec<String>, String)> = Vec::new();
    let call = |f: &str, args: Value| json!({"fn": f, "args": args});

    // P1b first: re-key subdirectory rows, so the grouping below sees canonical paths
    let (rekey_units, rows) = plan_rekey(home, ctx.now, repo_key, &rows0)?;
    if !rekey_units.is_empty() {
        result.rekeyed = rekey_units.len() as i64;
        calls.push(call("foldRekey", json!({"repoKey": repo_key})));
        expect.push(Some(json!(rekey_units.len())));
        for u in rekey_units {
            tags.push(Tag::Rekey);
            units.push(u);
        }
    }
    // group by canonical mesh id (first appearance order), then by real path within a mesh id
    let mut order: Vec<String> = Vec::new();
    let mut by_mesh: HashMap<String, Vec<RegRow>> = HashMap::new();
    for d in &rows {
        let Some(wt) = view::descriptor_of(d).worktree_path else { continue };
        let Some(mesh) = ident::canonical_mesh_id(&wt)? else { continue };
        if !by_mesh.contains_key(&mesh) {
            order.push(mesh.clone());
        }
        by_mesh.entry(mesh).or_default().push(d.clone());
    }
    let cx = Cx { home, store: repo_key, rd: &rd, now: ctx.now, rows: &rows };
    let mut sim = Sim::default();
    let mut g = Groups::default();
    for mesh in &order {
        let group = &by_mesh[mesh];
        if group.len() < 2 {
            continue;
        }
        let mut subs: Vec<(String, Vec<RegRow>)> = Vec::new();
        for d in group {
            let wt = view::descriptor_of(d).worktree_path.unwrap_or_default();
            let key = ident::canonical_worktree_real_path(&wt)?.unwrap_or_else(|| format!("\0unresolved:{}", d.row.id));
            match subs.iter_mut().find(|(k, _)| *k == key) {
                Some((_, v)) => v.push(d.clone()),
                None => subs.push((key, vec![d.clone()])),
            }
        }
        if subs.len() > 1 {
            result.mesh_id_collisions += 1;
        }
        for (_, sub) in &subs {
            if sub.len() < 2 {
                continue;
            }
            let ids: Vec<String> = sub.iter().map(|r| r.row.id.clone()).collect();
            let decided = (|| -> R<Option<(String, Vec<RegRow>)>> {
                let any_live = sub.iter().any(|r| view::descriptor_of(r).session_id.as_deref().is_some_and(is_live_sid));
                if !any_live {
                    let ghosts = ghost_rows(home, &rd, sub, ctx.now, ghost_ms)?;
                    let non: Vec<&RegRow> = sub.iter().filter(|r| !ghosts.iter().any(|g| g.row.id == r.row.id)).collect();
                    if !ghosts.is_empty() && non.len() == 1 {
                        return Ok(Some((non[0].row.id.clone(), ghosts)));
                    }
                    return Ok(None);
                }
                let survivor = pick_survivor(home, sub)?;
                let cands = sub.iter().filter(|r| r.row.id != survivor).cloned().collect();
                Ok(Some((survivor, cands)))
            })();
            let (survivor, cands) = match decided {
                Ok(Some(x)) => x,
                Ok(None) => {
                    result.needs_attention.push((mesh.clone(), ids));
                    continue;
                }
                Err(Defer(why)) => {
                    deferred.push((ids, why));
                    continue;
                }
            };
            let mut trial = sim.clone();
            match plan_group(&cx, &mut trial, &survivor, &cands, false) {
                Err(Defer(why)) => deferred.push((ids, why)),
                Ok((gu, go)) => {
                    sim = trial;
                    g.calls.push(call("foldGroup", json!({"repoKey": repo_key, "survivor": survivor, "ids": cands.iter().map(|c| c.row.id.clone()).collect::<Vec<_>>()})));
                    g.expect.push(Some(go.as_json()));
                    for u in gu {
                        let id = u.label.trim_start_matches("fold:").to_string();
                        let retired = go.retired.contains(&id);
                        g.tags.push(Tag::Fold { id, retired });
                        g.units.push(u);
                    }
                    if !go.retired.is_empty() || !go.left.is_empty() || !go.forward_failed.is_empty() {
                        g.result.folded += 1;
                    }
                    g.result.forwarded += go.forwarded;
                    g.result.retired.extend(go.retired.clone());
                    g.result.left.extend(go.left.clone());
                    g.result.pending.extend(go.skipped.clone());
                    g.raised.extend(go.raised.clone());
                    g.ids.extend(ids);
                }
            }
        }
    }
    if !g.result.retired.is_empty() || g.result.forwarded > 0 {
        let retired: HashSet<String> = g.result.retired.iter().cloned().collect();
        let raised: HashMap<String, i64> = g.raised.iter().cloned().collect();
        if derive_blocked(&cx, &retired, &raised)? {
            deferred.push((g.ids.clone(), defaults::text("devswarm_recon.why_summary_orphan").to_string()));
            g = Groups::default();
        } else {
            g.units.push(Unit { label: defaults::text("devswarm_recon.label_derive").into(), lock: None, ops: vec![Op::Derive { store: repo_key.to_string() }] });
            g.tags.push(Tag::Derive);
            g.calls.push(call("foldDerive", json!({"repoKey": repo_key})));
            g.expect.push(None);
        }
    }
    units.extend(g.units);
    tags.extend(g.tags);
    calls.extend(g.calls);
    expect.extend(g.expect);
    result.folded += g.result.folded;
    result.forwarded += g.result.forwarded;
    result.retired.extend(g.result.retired);
    result.left.extend(g.result.left);
    result.pending.extend(g.result.pending);
    let mut scope = super::side::scope_for(&[]);
    scope.stores.push(repo_key.to_string());
    for d in defaults::list("devswarm_recon.summary_dirs") {
        scope.dirs.push(view::ds(d));
    }
    scope.dirs.push(view::ds(defaults::text("devswarm_recon.dir_retired")));
    scope.dirs.push(view::ds(defaults::text("mesh_write.dir_cursor_log")));
    let job = Job { label: defaults::text("devswarm_recon.job_fold").into(), scope, units, calls, expect };
    Ok(FoldPlan { job, tags, result, deferred })
}

/// How a run ended.
pub struct FoldEnd {
    /// The aggregate over the units that applied.
    pub result: FoldRun,
    /// Groups and units handed back to Node, with the reason.
    pub deferred: Vec<(String, String)>,
    /// What the witness said.
    pub verdict: Verdict,
}

/// Plan, witness and apply the mesh fold of one store. Behind `devswarm_sup.sweep_tail_mode`: anything but `engine` hands the
/// whole store to Node before a single file is read.
pub fn run(ctx: &Ctx, runner: &dyn Runner, repo_key: &str, hooks: &Hooks) -> R<FoldEnd> {
    if crate::dssup::setting(ctx.st, "devswarm_sup.sweep_tail_mode").as_str() != Some(defaults::text("devswarm_recon.mode_engine")) {
        return defer("sweep-tail-mode");
    }
    let p = plan_fold(ctx, repo_key)?;
    let out = gate::run(ctx, runner, &p.job, hooks);
    let mut deferred: Vec<(String, String)> = p.deferred.iter().map(|(ids, why)| (ids.join(","), why.clone())).collect();
    let mut result = p.result.clone();
    for ((end, tag), unit) in out.ends.iter().zip(p.tags.iter()).zip(p.job.units.iter()) {
        let (UnitEnd::Deferred(why) | UnitEnd::Failed(why)) = end else { continue };
        deferred.push((unit.label.clone(), why.clone()));
        if let Tag::Fold { id, retired: true, .. } = tag {
            result.retired.retain(|r| r != id);
        }
    }
    Ok(FoldEnd { result, deferred, verdict: out.verdict })
}

/// The ghost rows of one store, witnessed against Node's `ghostRegistryRows` (a read-only decision: no unit, only the answer).
pub fn ghost_ids(ctx: &Ctx, runner: &dyn Runner, store: &str, ids: &[String]) -> R<(Vec<String>, Verdict)> {
    let rows = view::registry(ctx.home, store)?;
    let rd = view::reader(ctx.home, store)?;
    let picked: Vec<RegRow> = ids.iter().filter_map(|i| rows.iter().find(|r| &r.row.id == i).cloned()).collect();
    let got: Vec<String> = ghost_rows(ctx.home, &rd, &picked, ctx.now, ghost_age_ms(&ctx.st.env)?)?.into_iter().map(|r| r.row.id).collect();
    let call = json!({"fn": "ghosts", "args": {"repoKey": store, "ids": ids, "now": ctx.now}});
    let mut scope = super::side::scope_for(&[]);
    scope.stores.push(store.to_string());
    for d in defaults::list("devswarm_recon.summary_dirs") {
        scope.dirs.push(view::ds(d));
    }
    let job = Job { label: defaults::text("devswarm_recon.job_ghosts").into(), scope, units: Vec::new(), calls: vec![call], expect: vec![Some(json!(got))] };
    // a job without units still compares Node's answer; the gate returns its verdict
    let out = gate::run(ctx, runner, &job, &Hooks::none());
    Ok((got, out.verdict))
}

/// The path of an archived marker, for callers deciding about `allowArchivedDest`.
pub fn archived_marker_rel(id: &str) -> String {
    archived_rel(id)
}
