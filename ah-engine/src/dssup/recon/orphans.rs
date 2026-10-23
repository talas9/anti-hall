//! Slice S5: `healOrphanPartitions` (`scripts/devswarm-lib/repair.js`).
//!
//! An orphan is a workspace id that has messages (or a cursor, or a gate) in a store but no registry row. Node's pass visits the
//! orphans that have a descriptor first and the ones that have none afterwards. Per orphan:
//!
//! * no descriptor in `workspaces/` or `archived/`: reported as unhealable, nothing written;
//! * the archive gate (`resolveArchiveGate`: the id's own marker, or its worktree archived under another id, with the liveness proof
//!   that tells a true reuse from a leftover) says archived: the id is never adopted. Its unread mail is forwarded into the live
//!   survivor of its worktree family (`forwardArchivedOrphanUnread`, rows older than the age cap are not), or the id is reported
//!   drained, stale or without a family;
//! * a live descriptor whose worktree belongs to another repository: unhealable (`wrong-store`), nothing written;
//! * otherwise the id is adopted (`upsertRegistry` under the id's lock), and when its worktree family already has registry rows the
//!   adopted row's unread is folded into the family's survivor (`foldGroupIntoSurvivor`, the same plan as the project-wide fold);
//!   then one summary for the store when anything was written.
//!
//! A failure while deciding one id is that id's `error` (Node's per-id `catch`), never the whole store's. Node's per-pass `deadline`
//! is not modelled: the caller bounds the work by how many stores it takes per tick.
use super::fold::{Cx, Sim, plan_group};
use super::gate::{self, Job};
use super::view::{self, archived_rel, registry};
use super::{Hooks, Op, RegRow, Unit, UnitEnd};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::appsync::plan::js_str;
use crate::dssup::tick::Ctx;
use crate::meshw::common::Inv;
use crate::meshw::ident::{Defer, R, canonical_mesh_id, read_descriptor, realpath, repo_key_for_worktree};
use crate::meshw::idlock::is_safe_id;
use crate::meshw::store::RegistryRow;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// What the planner decided for one store.
pub struct OrphanPlan {
    /// The gate job: the units of the adoptions and forwards, then the summary unit.
    pub job: Job,
    /// Node's result for the whole pass, assuming every unit is applied.
    pub result: Value,
    /// What each planned unit contributes to `result`, in unit order.
    pub applied: Vec<Applied>,
}

/// What kind of work a planned unit is, for correcting the result when it is not applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// An adoption (and the fold of the adopted row into its family's survivor, which shares its lock).
    Adopt,
    /// A forward of an archived orphan's unread, with the rows it adds.
    Forward(i64),
}

/// One planned unit's place in the result.
#[derive(Debug, Clone)]
pub struct Applied {
    /// The orphan's id.
    pub id: String,
    /// Its entry in `result["detail"]`.
    pub detail: usize,
    /// Its unit in the job.
    pub unit: usize,
    /// What it is.
    pub kind: Kind,
}

/// How a run ended.
pub struct OrphanRun {
    /// Node's result over what was actually applied.
    pub result: Value,
    /// Units handed back (a busy lock, a drifted precondition, a failed step), with the reason.
    pub deferred: Vec<(String, String)>,
    /// What the witness said.
    pub verdict: gate::Verdict,
}

/// A descriptor path that `readDescriptorPathState` accepts: a regular file (not a link) holding a JSON object.
fn read_object(home: &Path, rel: &str) -> Option<OVal> {
    let p = home.join(rel);
    if !std::fs::symlink_metadata(&p).ok()?.is_file() {
        return None;
    }
    match OVal::parse(&String::from_utf8_lossy(&std::fs::read(&p).ok()?)) {
        Some(v @ OVal::Obj(_)) => Some(v),
        _ => None,
    }
}

/// `realWorktreePath(p)`: the real path, else the text as it is (a worktree that is gone). A relative path resolves against the
/// process directory, as `fs.realpathSync` does.
fn real_or_raw(p: &str) -> String {
    realpath(p).unwrap_or_else(|| p.to_string())
}

/// `typeof v === 'string' && v ? v : null`.
fn str_nonempty(v: Option<&OVal>) -> Option<String> {
    match v {
        Some(OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// `x != null && String(x) !== '' ? String(x) : null`.
fn sid_text(v: Option<&OVal>) -> Option<String> {
    match v {
        None | Some(OVal::Null) => None,
        Some(other) => Some(js_str(other)).filter(|s| !s.is_empty()),
    }
}

/// `buildArchivedWorktreeIndex(home)`: every archive marker that names a worktree, by the real path of that worktree.
fn archived_index(home: &Path) -> HashMap<String, Vec<(String, OVal)>> {
    let mut out: HashMap<String, Vec<(String, OVal)>> = HashMap::new();
    let dir = home.join(view::ds(defaults::text("mesh_write.dir_archived")));
    let suffix = defaults::text("mesh_write.json_suffix");
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    for name in names {
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if !is_safe_id(id) {
            continue;
        }
        let Some(marker) = std::fs::read(dir.join(&name)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let Some(wt) = str_nonempty(marker.get("worktreePath")) else { continue };
        out.entry(real_or_raw(&wt)).or_default().push((id.to_string(), marker));
    }
    out
}

/// `resolveArchiveGate(home, id, desc, fs, { worktreeIndex })` as `healOrphanPartitions` reads it: `archived && !migrateAsLive`.
/// An id is archived by its own marker, or by a marker of another id on the same worktree; either is overridden only by positive proof
/// of a live reuse (a different session that is alive now, and for the id's own marker also a descriptor written after the marker).
/// Everything unreadable or ambiguous reads as archived: the gate fails toward never resurrecting.
fn archived_gate(ctx: &Ctx, inv: &Inv, id: &str, desc: &OVal, index: &HashMap<String, Vec<(String, OVal)>>) -> bool {
    if !is_safe_id(id) {
        return false;
    }
    let home = ctx.home;
    let desc_wt = str_nonempty(desc.get("worktreePath"));
    let marker_path = home.join(archived_rel(id));
    let mut marker: Option<OVal> = None;
    if let Ok(raw) = std::fs::read(&marker_path) {
        match OVal::parse(&String::from_utf8_lossy(&raw)) {
            Some(m @ (OVal::Obj(_) | OVal::Arr(_))) => marker = Some(m),
            _ => return true, // archived-marker-unreadable
        }
    }
    if let (Some(m), Some(dwt)) = (&marker, &desc_wt)
        && let Some(mwt) = str_nonempty(m.get("worktreePath"))
        && real_or_raw(&mwt) != real_or_raw(dwt)
    {
        marker = None; // a new workspace reusing the id
    }
    let mut group_hit = false;
    if marker.is_none()
        && let Some(dwt) = &desc_wt
        && let Some(hits) = index.get(&real_or_raw(dwt))
        && let Some((_, m)) = hits.iter().find(|(h, _)| h != id).or(hits.first())
    {
        group_hit = true;
        marker = Some(m.clone());
    }
    let Some(marker) = marker else { return false };
    let (marker_sid, desc_sid) = (sid_text(marker.get("sessionId")), sid_text(desc.get("sessionId")));
    // group siblings are cross-linked by session, so their sessions are expected to differ: no reuse proof in that
    if marker_sid.is_none() || desc_sid.is_none() || marker_sid == desc_sid {
        return true;
    }
    let live = crate::meshw::rosterrows::sibling_partition_live(inv, ctx.now as f64, id, desc_wt.as_deref(), desc_sid.as_deref()).unwrap_or(false);
    if group_hit {
        return !live;
    }
    // the id's own marker: the descriptor must also have been (re)written after the marker was
    let mtime = |p: &Path| std::fs::metadata(p).ok().map(|m| super::super::liveness::mtime_ms(&m)).filter(|t| t.is_finite());
    let newer = match (mtime(&marker_path), mtime(&home.join(view::descriptor_rel(id)))) {
        (Some(m), Some(d)) => d > m,
        _ => false,
    };
    !(newer && live)
}

/// `listWorkspaceIds()` of a sqlite store, in the order Node's four sources add them.
fn workspace_ids(home: &Path, key: &str) -> R<Vec<String>> {
    let reader = crate::mesh::MeshReader::open(&view::store_db(home, key)).map_err(|e| crate::dssup::failure(format!("store-open:{e}")))?;
    let c = reader.conn();
    let (mut seen, mut out) = (HashSet::new(), Vec::new());
    for sql in [crate::sql::RECON_IDS_MESSAGES, crate::sql::RECON_IDS_REGISTRY, crate::sql::RECON_IDS_CURSORS, crate::sql::RECON_IDS_GATES] {
        // a missing table is an empty source (Node: try/catch per statement)
        let Ok(mut st) = c.prepare(sql) else { continue };
        let Ok(it) = st.query_map([], |r| r.get::<_, String>(0)) else { continue };
        for id in it.flatten() {
            if seen.insert(id.clone()) {
                out.push(id);
            }
        }
    }
    Ok(out)
}

/// `archiveForwardMaxAgeMs(env)`: `parseInt` of the environment value in days when it is positive, else the default.
fn archive_forward_max_age_ms(env: &HashMap<String, String>) -> f64 {
    let days = env.get(defaults::text("devswarm_recon.archive_forward_age_env")).and_then(|v| crate::setup::jsfmt::parse_int(v)).filter(|d| *d > 0.0);
    days.unwrap_or_else(|| defaults::num("devswarm_recon.archive_forward_age_default_days") as f64) * 86_400_000.0
}

/// The counters and detail lines of Node's result.
#[derive(Default)]
struct Acc {
    adopted: u64,
    forwarded: i64,
    unhealable: u64,
    drained: u64,
    stale: u64,
    skipped: u64,
    pending: u64,
    errors: u64,
    detail: Vec<Value>,
}

impl Acc {
    fn value(&self, key: Option<&str>) -> Value {
        json!({"ok": true, "scope": "store", "adopted": self.adopted, "forwarded": self.forwarded, "unhealable": self.unhealable,
            "archivedDrained": self.drained, "archivedStale": self.stale, "skipped": self.skipped, "deadlineSkipped": 0, "pending": self.pending,
            "errors": self.errors, "detail": self.detail, "repoKey": key})
    }
}

/// Everything one store's plan keeps while it walks the orphans.
struct Planner<'a> {
    ctx: &'a Ctx<'a>,
    repo_key: &'a str,
    rd: crate::mesh::MeshReader,
    inv: Inv,
    /// The registry as it will read once the units planned so far are applied.
    rows: Vec<RegRow>,
    sim: Sim,
    index: HashMap<String, Vec<(String, OVal)>>,
    max_age_ms: f64,
    acc: Acc,
    units: Vec<Unit>,
    applied: Vec<Applied>,
    any_write: bool,
}

impl Planner<'_> {
    /// The registry rows of the worktree family `family` names (`groupRegistryByMeshId(...).get(key).rows`).
    fn family_rows(&self, family: &str) -> R<Vec<RegRow>> {
        let mut out = Vec::new();
        for r in &self.rows {
            let Some(wt) = r.row.worktree_path.as_deref().filter(|w| !w.is_empty()) else { continue };
            if canonical_mesh_id(wt)?.as_deref() == Some(family) {
                out.push(r.clone());
            }
        }
        Ok(out)
    }

    /// One orphan that has a descriptor.
    fn one(&mut self, id: &str, desc: &OVal) -> R<()> {
        let (ctx, home) = (self.ctx, self.ctx.home);
        let wt_val = desc.get("worktreePath").filter(|v| v.truthy());
        // `canonicalMeshId(String(desc.worktreePath))`
        let family = match wt_val {
            Some(v) => canonical_mesh_id(&js_str(v))?,
            None => None,
        };
        let group = match &family {
            Some(f) => self.family_rows(f)?,
            None => Vec::new(),
        };
        let archived = archived_gate(ctx, &self.inv, id, desc, &self.index);
        // `descriptorFreshRepoKey(desc)`: only a text path resolves to a key
        let fresh = match wt_val {
            Some(OVal::Str(w)) => repo_key_for_worktree(w)?,
            _ => None,
        };
        let wrong_store = fresh.as_deref().is_some_and(|f| f != self.repo_key);
        if archived {
            return self.archived_orphan(id, &group);
        }
        if wrong_store {
            self.acc.unhealable += 1;
            self.acc.detail.push(json!({"id": id, "action": defaults::text("devswarm_recon.action_unhealable"), "reason": defaults::text("devswarm_recon.reason_wrong_store"),
                "freshRepoKey": fresh}));
            return Ok(());
        }
        // adopt: `upsertRegistry({ id, worktreePath, sessionId, inboxPath, cursorPath })`, each field `String(v)` unless null
        let col = |k: &str| match desc.get(k) {
            None | Some(OVal::Null) => None,
            Some(v) => Some(js_str(v)),
        };
        let row = RegistryRow {
            id: id.to_string(),
            worktree_path: col("worktreePath"),
            session_id: col("sessionId"),
            inbox_path: col("inboxPath"),
            cursor_path: col("cursorPath"),
            nudge_command: None,
        };
        let mut unit = Unit {
            label: format!("orphan:{id}"),
            lock: Some(id.to_string()),
            ops: vec![Op::Upsert { store: self.repo_key.to_string(), row: Box::new(row.clone()), pre: None::<Box<RegRow>> }],
        };
        self.acc.adopted += 1;
        self.any_write = true;
        // the row as the upsert will store it (a fresh row: the apply clock and the first write counter)
        let adopted_row = RegRow { row: row.clone(), updated_at: Some(ctx.now), write_seq: Some(1) };
        let mut separate: Vec<Unit> = Vec::new();
        let mut entry = json!({"id": id, "action": defaults::text("devswarm_recon.action_adopted")});
        if !group.is_empty() {
            let cx = Cx { home, store: self.repo_key, rd: &self.rd, now: ctx.now, rows: &[group.as_slice(), &[adopted_row.clone()]].concat(), inv: &self.inv };
            let survivor = super::survivor::pick(&cx, &group)?;
            match survivor {
                Some(sid) => {
                    let (fold_units, go) = plan_group(&cx, &mut self.sim, &sid, std::slice::from_ref(&adopted_row), true, false)?;
                    self.acc.forwarded += go.forwarded;
                    // the fold's units share the adoption's lock: its steps follow the upsert in the same unit, except a removal of the
                    // adopted row itself (a stale cross-reference), which is checked against the stored row once the adoption is in
                    for u in fold_units {
                        if u.ops.iter().any(|o| matches!(o, Op::RemoveRegistryIf { .. })) {
                            separate.push(u);
                        } else {
                            unit.ops.extend(u.ops);
                        }
                    }
                    if !go.skipped.is_empty() {
                        self.acc.pending += go.skipped.len() as u64;
                        let why = go.skipped.first().map_or_else(|| defaults::text("devswarm_recon.word_skipped").to_string(), |(_, r)| r.clone());
                        self.acc.detail.push(json!({"id": id, "action": "pending", "reason": why, "survivor": sid}));
                    }
                    entry = json!({"id": id, "action": defaults::text("devswarm_recon.action_adopted"), "survivor": sid, "forwarded": go.forwarded});
                    if go.retired.iter().any(|r| r == id) {
                        self.rows.retain(|r| r.row.id != id);
                    }
                }
                None => entry = json!({"id": id, "action": defaults::text("devswarm_recon.action_adopted"), "reason": defaults::text("devswarm_recon.reason_no_live_survivor")}),
            }
        }
        let detail_at = self.acc.detail.len();
        self.acc.detail.push(entry);
        self.rows.push(adopted_row);
        self.applied.push(Applied { id: id.to_string(), detail: detail_at, unit: self.units.len(), kind: Kind::Adopt });
        self.units.push(unit);
        self.units.extend(separate);
        Ok(())
    }

    /// An orphan the archive gate holds: its unread goes to the live survivor of its worktree family, never into a new registry row.
    fn archived_orphan(&mut self, id: &str, group: &[RegRow]) -> R<()> {
        let (ctx, home) = (self.ctx, self.ctx.home);
        let cur = view::cursor_rows(&self.rd, id)?;
        let floor = view::store_floor(home, &self.rd, id, &cur)?;
        let total = view::message_count(&self.rd, id).unwrap_or(0);
        let unread = (total - floor).max(0);
        if unread == 0 {
            self.acc.drained += 1;
            self.acc.detail.push(json!({"id": id, "action": "archived-drained"}));
            return Ok(());
        }
        if group.is_empty() {
            self.acc.unhealable += 1;
            self.acc.detail.push(json!({"id": id, "action": defaults::text("devswarm_recon.action_unhealable"), "reason": "archived-no-family"}));
            return Ok(());
        }
        let cx = Cx { home, store: self.repo_key, rd: &self.rd, now: ctx.now, rows: &self.rows, inv: &self.inv };
        let Some(survivor) = super::survivor::pick(&cx, group)? else {
            self.acc.unhealable += 1;
            self.acc.detail.push(json!({"id": id, "action": defaults::text("devswarm_recon.action_unhealable"), "reason": "archived-no-survivor"}));
            return Ok(());
        };
        let (unit, fwd) = super::archived::plan_forward_archived(home, self.repo_key, id, &survivor, ctx.now, self.max_age_ms, false)?;
        if fwd.status != defaults::text("devswarm_recon.status_ok") {
            self.acc.pending += 1;
            self.acc.detail.push(json!({"id": id, "action": "pending", "reason": format!("survivor-{}", fwd.status), "survivor": survivor}));
            return Ok(());
        }
        self.acc.forwarded += fwd.forwarded;
        if fwd.forwarded > 0 {
            self.any_write = true;
        }
        if fwd.forwarded == 0 && fwd.stale > 0 {
            // every unread row is past the age cap: detect-only, zero writes
            self.acc.stale += 1;
            self.acc.detail.push(json!({"id": id, "action": "archived-stale", "survivor": survivor, "staleCount": fwd.stale}));
        } else {
            let at = self.acc.detail.len();
            self.acc.detail.push(json!({"id": id, "action": "forwarded-only", "survivor": survivor, "forwarded": fwd.forwarded, "stale": fwd.stale}));
            if let Some(u) = unit {
                self.applied.push(Applied { id: id.to_string(), detail: at, unit: self.units.len(), kind: Kind::Forward(fwd.forwarded) });
                self.units.push(u);
            }
        }
        Ok(())
    }
}

/// Plan `healOrphanPartitions(home, {repoKey})` for one store.
pub fn plan(ctx: &Ctx, repo_key: &str) -> R<OrphanPlan> {
    let home = ctx.home;
    let nothing = |key: Option<&str>| -> OrphanPlan {
        OrphanPlan {
            job: Job {
                label: defaults::text("devswarm_recon.job_orphans").into(),
                scope: Default::default(),
                units: Vec::new(),
                calls: Vec::new(),
                expect: Vec::new(),
            },
            result: Acc::default().value(key),
            applied: Vec::new(),
        }
    };
    // Node never opens or creates a store just to look for orphans
    if repo_key.is_empty() {
        return Ok(nothing(None));
    }
    if !home.join(view::store_rel(repo_key)).exists() {
        return Ok(nothing(Some(repo_key)));
    }
    let call = json!({"fn": "healOrphans", "args": {"repoKey": repo_key}});
    let rows = registry(home, repo_key)?;
    let rd = view::reader(home, repo_key)?;
    let have: HashSet<&str> = rows.iter().map(|r| r.row.id.as_str()).collect();
    let broadcast = defaults::text("mesh_write.broadcast_partition");
    let orphans: Vec<String> =
        workspace_ids(home, repo_key)?.into_iter().filter(|id| id != broadcast && !have.contains(id.as_str()) && is_safe_id(id)).collect();
    // descriptors first (live, else archived), then the ones with none
    let (mut with, mut without) = (Vec::new(), Vec::new());
    for id in orphans {
        if let Some(d) = read_descriptor(home, &id) {
            with.push((id, d));
        } else if let Some(d) = read_object(home, &archived_rel(&id)) {
            with.push((id, d));
        } else {
            without.push(id);
        }
    }
    let mut p = Planner {
        ctx,
        repo_key,
        rd,
        inv: super::survivor::inv_of(ctx),
        rows: rows.clone(),
        sim: Sim::default(),
        index: archived_index(home),
        max_age_ms: archive_forward_max_age_ms(&ctx.st.env),
        acc: Acc::default(),
        units: Vec::new(),
        applied: Vec::new(),
        any_write: false,
    };
    for (id, desc) in &with {
        // Node's per-id `catch`: a failure while deciding one id is that id's error
        if let Err(Defer(why)) = p.one(id, desc) {
            p.acc.errors += 1;
            p.acc.detail.push(json!({"id": id, "action": "error", "error": why}));
        }
    }
    for id in &without {
        p.acc.unhealable += 1;
        p.acc.detail.push(
            json!({"id": id, "action": defaults::text("devswarm_recon.action_unhealable"), "reason": defaults::text("devswarm_recon.reason_no_descriptor")}),
        );
    }
    let mut scope = super::side::scope_for(&[]);
    scope.stores.push(repo_key.to_string());
    for d in defaults::list("devswarm_recon.summary_dirs") {
        scope.dirs.push(view::ds(d));
    }
    scope.dirs.push(view::ds(defaults::text("devswarm_recon.dir_retired")));
    scope.dirs.push(view::ds(defaults::text("mesh_write.dir_cursor_log")));
    let Planner { mut units, acc, applied, any_write, .. } = p;
    if any_write {
        units.push(Unit { label: "orphan-summary".into(), lock: None, ops: vec![Op::Derive { store: repo_key.to_string() }] });
    }
    let result = acc.value(Some(repo_key));
    let job = Job { label: defaults::text("devswarm_recon.job_orphans").into(), scope, units, calls: vec![call], expect: vec![Some(result.clone())] };
    Ok(OrphanPlan { job, result, applied })
}

/// Plan and apply the orphan heal of one store. A unit the real apply could not do (a busy lock, drift, a failed step) is reported in
/// `deferred` and taken out of the result.
pub fn run(ctx: &Ctx, runner: &dyn Runner, repo_key: &str, hooks: &Hooks) -> R<OrphanRun> {
    let p = plan(ctx, repo_key)?;
    let out = gate::run(ctx, runner, &p.job, hooks);
    let mut result = p.result.clone();
    let mut deferred = Vec::new();
    let mut gone: HashSet<usize> = HashSet::new();
    let (mut adopted_off, mut forwarded_off, mut pending_on) = (0u64, 0i64, 0u64);
    for a in &p.applied {
        if let Some(UnitEnd::Deferred(why) | UnitEnd::Failed(why)) = out.ends.get(a.unit) {
            deferred.push((a.id.clone(), why.clone()));
            gone.insert(a.detail);
            match a.kind {
                Kind::Adopt => adopted_off += 1,
                Kind::Forward(n) => {
                    forwarded_off += n;
                    pending_on += 1;
                }
            }
        }
    }
    if !gone.is_empty() {
        let detail: Vec<Value> =
            p.result["detail"].as_array().cloned().unwrap_or_default().into_iter().enumerate().filter(|(i, _)| !gone.contains(i)).map(|(_, v)| v).collect();
        result["adopted"] = json!(p.result["adopted"].as_u64().unwrap_or(0) - adopted_off);
        result["forwarded"] = json!(p.result["forwarded"].as_i64().unwrap_or(0) - forwarded_off);
        result["pending"] = json!(p.result["pending"].as_u64().unwrap_or(0) + pending_on);
        result["detail"] = Value::Array(detail);
    }
    Ok(OrphanRun { result, deferred, verdict: out.verdict })
}
