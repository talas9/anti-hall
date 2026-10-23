//! Four post-update store stages of `update.js`, run by the engine (roadmap #61 chunk C1): `reader-cursors-import`,
//! `reader-floor-repair` and `dual-partition-acks` (the reader-cursor repairs of `devswarm-lib/repair.js`) and
//! `promote-unclaimed`. Each returns the counts Node's `devswarm.js` function returned; the shaping of the
//! answer (keys, detail text, the one-time marker) is the stage table's, in `operator/postpull.rs`.
//!
//! Every stage is idempotent (a second run finds nothing to do), fail-open (an error is counted and the stage retries next run),
//! and moves or marks, never deletes: a reader row is retired by marking it, a cursor only rises, a descriptor is rewritten in
//! place. A store the engine cannot open the way Node would (no sqlite `BACKEND` marker: a journal store, a store Node would
//! first mark), or a case only Node decides (a working directory git cannot place: a relative path, or a git call that failed), returns `None`: the stage
//! table's `fallback` Node function then runs the whole stage.
use super::readercur::{self as rc, Cx, Handle};
use super::{Ctx, list_store_hashes};
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::meshw::cursors::{self, LogRec};
use crate::meshw::args::Args;
use crate::meshw::common::Inv;
use crate::meshw::ident;
use crate::meshw::idlock::is_safe_id;
use crate::meshw::store::mesh_message_hash;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// What a stage counted (Node's result object), plus the pending rows that keep its one-time marker from being stamped.
#[derive(Default)]
pub(crate) struct Tally {
    pub n: BTreeMap<&'static str, f64>,
    pub pending_rows: f64,
    /// `ok` of a result that carries one (`promoteUnclaimedRegistrySessions`).
    pub ok: Option<bool>,
    /// Stores the engine does not read (the journal backend of Node older than 22.5, a sqlite marker with no database): skipped, and
    /// named by the doctor.
    pub legacy: usize,
    /// Every store is one of those: the engine had nothing to walk, and the stage reports `disabled`.
    pub all_legacy: bool,
}

impl Tally {
    pub(super) fn add(&mut self, k: &'static str, by: f64) {
        *self.n.entry(k).or_insert(0.0) += by;
    }

    pub(super) fn set(&mut self, k: &'static str, v: f64) {
        self.n.insert(k, v);
    }

    pub(super) fn get(&self, k: &str) -> f64 {
        self.n.get(k).copied().unwrap_or(0.0)
    }
}

/// The stages this module answers, by their `native` word in the stage table.
pub(crate) fn is_store_stage(which: &str) -> bool {
    defaults::list("update_post.store_stages").contains(&which)
}

/// Run one: `None` when Node must answer. `dry` is the ingest dry-run switch (a preview: nothing is written).
pub(crate) fn run(ctx: &Ctx, which: &str, dry: bool) -> Option<Tally> {
    let home = Path::new(&ctx.home);
    let t = match which {
        "promote_unclaimed" => super::promote::promote_unclaimed(ctx),
        "cursor_hygiene" => Some(super::cursorhyg::run(ctx)),
        "owner_key_migrate" => owner_key_migrate(ctx),
        "app_archived_markers" => app_archived_markers(ctx, dry),
        "re_retire_resurrected" => re_retire_resurrected(ctx),
        "merge_split_backend_stores" => merge_split(ctx),
        _ => {
            let (hashes, skipped) = stores(ctx, dry);
            if hashes.is_empty() && skipped > 0 {
                return Some(legacy_only(skipped));
            }
            let mut cx = Cx::new(&ctx.home);
            let t = match which {
                "reader_cursors_import" => reader_cursors_import(ctx, &mut cx, &hashes, dry),
                "reader_floor_repair" => reader_floor_repair(ctx, &mut cx, &hashes, dry),
                "dual_partition_acks" => dual_partition_acks(ctx, &mut cx, &hashes, dry),
                "child_sender_labels" => super::childlabels::run(ctx, &hashes, dry),
                _ => return None,
            };
            if cx.deferred {
                return None;
            }
            t.map(|mut t| {
                t.legacy = skipped;
                t
            })
        }
    };
    let _ = home;
    t
}

/// `migrateOwnerKeys(home, {env, cwd})` (`ownerKeyMigratePostUpdate`): the engine's own `migrate-owner-keys` verb. It backfills a missing
/// `ownerKey` on every descriptor (a descriptor is rewritten in place, atomically; nothing is deleted). The re-home of a stranded active
/// descriptor (registry row and backlog moved between stores) is Node's: the verb decides it before writing anything, so the whole stage
/// then runs as Node's function. Node ignores the ingest dry-run switch here and so does this.
fn owner_key_migrate(ctx: &Ctx) -> Option<Tally> {
    let inv = Inv {
        home: std::path::PathBuf::from(&ctx.home),
        env: ctx.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        cwd: ctx.cwd.clone(),
        now: crate::health::now_ms() as i64,
        stdin: None,
        write_home: std::path::PathBuf::from(&ctx.home),
        store_override: None,
    };
    let ans = crate::meshw::lifeverbs::migrate_owner_keys(&inv, &Args::default()).ok()?;
    let out = crate::checks::guardkit::ojson::OVal::parse(&ans.stdout)?;
    let mut t = Tally::default();
    for k in ["scanned", "backfilled", "rehomed", "errors"] {
        if let Some(crate::checks::guardkit::ojson::OVal::Num(n)) = out.get(k) {
            t.add(k, *n);
        }
    }
    Some(t)
}

/// `markAppArchivedDescriptors(home, {env, cwd})` (`markAppArchivedPostUpdate`): the archived marker for every active descriptor the
/// DevSwarm app's own database proves archived or deleted, planned and written by the same code the supervisor's app sync uses
/// (`dssup::appsync::plan`). A marker is created only when absent (never overwritten) and the descriptor is never touched or deleted;
/// the ingest dry-run switch makes it a preview. A database the engine cannot read exactly as Node's `builderStates` does, or a
/// descriptor shape only Node decides, hands the whole stage to Node before anything is written.
fn app_archived_markers(ctx: &Ctx, dry: bool) -> Option<Tally> {
    use crate::dssup::appsync::{plan, snap};
    let home = Path::new(&ctx.home);
    let env: ident::Env = ctx.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    let file = ident::app_db_path(home, &env)?;
    let snapshot = snap::read(&file).ok()??;
    // whatever the engine cannot read as JavaScript would: Node's, before the first write
    plan::read_json_dir(&plan::dir_of(home, "devswarm_sup.as_dir_workspaces")).ok()?;
    plan::read_json_dir(&plan::dir_of(home, "devswarm_sup.as_dir_archived")).ok()?;
    let marks = plan::plan_marks(home, &snapshot).ok()?;
    let ext = defaults::text("devswarm_sup.as_json_ext");
    let wdir = plan::dir_of(home, "devswarm_sup.as_dir_workspaces");
    let scanned = crate::checks::jsport::fsx::read_dir_names(&wdir.to_string_lossy())
        .unwrap_or_default()
        .iter()
        .filter(|(n, _)| n.strip_suffix(ext).is_some_and(plan::safe_id))
        .count();
    let (mut marked, mut errors) = (0.0, 0.0);
    if !dry {
        let now = crate::health::now_ms() as i64;
        for m in &marks.marks {
            match plan::write_marker(home, m, now) {
                plan::Wrote::Marked => marked += 1.0,
                plan::Wrote::Exists => {}
                plan::Wrote::Failed(e) => {
                    errors += 1.0;
                    swallowed(ctx, "app-archived-markers", &m.id, &e);
                }
            }
        }
    }
    let mut t = Tally::default();
    t.add("scanned", scanned as f64);
    t.add("marked", marked);
    t.add("errors", errors);
    // Node's `pending`: the planned markers not written (all of them in a preview)
    let pending = (marks.marks.len() as f64 - marked).max(0.0);
    t.add("pending", pending);
    // a preview leaves its planned markers pending, which keeps the one-time stamp off
    t.pending_rows = if dry { pending } else { 0.0 };
    Some(t)
}

/// `reRetireResurrectedRowsAllStores(home, {dryRun: true})` (`reRetireResurrectedPostUpdate`): the update only REPORTS the registry rows
/// an old migration resurrected (a row with a proven archive link, not live, whose archived twin is another id). It writes nothing
/// but the BACKEND marker an open of an old store pins, as Node's open does; the removal stays the operator's (`doctor --repair-resurrected`).
fn re_retire_resurrected(ctx: &Ctx) -> Option<Tally> {
    let home = Path::new(&ctx.home);
    let (hashes, skipped) = stores(ctx, false);
    if hashes.is_empty() && skipped > 0 {
        return Some(legacy_only(skipped));
    }
    let inv = Inv {
        home: home.to_path_buf(),
        env: ctx.env.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        cwd: ctx.cwd.clone(),
        now: crate::health::now_ms() as i64,
        stdin: None,
        write_home: home.to_path_buf(),
        store_override: None,
    };
    let now = inv.now as f64;
    let index = archive_index(home)?;
    let mut t = Tally::default();
    for hash in &hashes {
        let registry = match rc::open(home, hash, false).map_err(|e| e.to_string()).and_then(|h| h.rd().roster().map_err(|e| e.to_string())) {
            Ok(r) => r,
            Err(e) => {
                t.add("errors", 1.0);
                swallowed(ctx, "re-retire-resurrected", hash, &e);
                continue;
            }
        };
        for row in &registry {
            let Some(id) = row_id(row).filter(|i| crate::meshw::idlock::is_safe_id(i)) else { continue };
            let desc = ident::read_descriptor(home, &id);
            let desc_wt = match desc.as_ref().and_then(|d| d.get("worktreePath")) {
                Some(crate::checks::guardkit::ojson::OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
                Some(v) if v.truthy() => return None, // a worktree of a type only Node reads
                _ => None,
            };
            let row_wt = desc_wt.or_else(|| jv(row, "worktreePath").as_str().filter(|w| !w.is_empty()).map(str::to_string));
            let Some(wt) = row_wt.clone() else { continue };
            let real = if wt.starts_with('/') { ident::realpath(&wt).unwrap_or_else(|| wt.clone()) } else { return None };
            let Some(hits) = index.get(&real).filter(|h| !h.is_empty()) else { continue };
            let hit = hits.iter().find(|h| **h != id).unwrap_or(&hits[0]);
            let session = jv(row, "sessionId").as_str().map(str::to_string);
            if crate::meshw::rosterrows::sibling_partition_live(&inv, now, &id, Some(&wt), session.as_deref()).ok()? {
                continue;
            }
            if *hit == id {
                t.add("unhealable", 1.0);
                continue;
            }
            t.add("candidates", 1.0);
        }
    }
    // the answer's `left` placeholder counts the rows needing a manual review
    let unhealable = t.get("unhealable");
    t.add("left", unhealable);
    t.legacy = skipped;
    Some(t)
}

/// `buildArchivedWorktreeIndex(home)`: the ids of the archive markers, by the real path of the worktree each names, in directory order.
fn archive_index(home: &Path) -> Option<HashMap<String, Vec<String>>> {
    let mut idx: HashMap<String, Vec<String>> = HashMap::new();
    let dir = ident_archived_dir(home);
    let suffix = defaults::text("mesh_write.json_suffix");
    let Ok(rd) = std::fs::read_dir(&dir) else { return Some(idx) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if !crate::meshw::idlock::is_safe_id(id) {
            continue;
        }
        let Some(marker) = std::fs::read(e.path()).ok().and_then(|b| crate::checks::guardkit::ojson::OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        let wt = match marker.get("worktreePath") {
            Some(crate::checks::guardkit::ojson::OVal::Str(s)) if !s.is_empty() => s.clone(),
            _ => continue,
        };
        if !wt.starts_with('/') {
            return None;
        }
        let real = ident::realpath(&wt).unwrap_or(wt);
        idx.entry(real).or_default().push(id.to_string());
    }
    Some(idx)
}

fn ident_archived_dir(home: &Path) -> std::path::PathBuf {
    crate::meshw::idlock::devswarm_root(home).join(defaults::text("mesh_write.dir_archived"))
}

/// `store.listStoreHashes(home)`, the stores the engine can open as Node would, and how many it skips. A store with no readable `BACKEND`
/// marker (made before the marker existed) and a non-empty `devswarm.db` is sqlite to Node's `resolveStoreBackend`
/// (`inferBackendFromDisk`), which also writes the marker unless the open is read-only (`dry`); the engine does the same and never
/// touches the data. A store on the journal backend (Node older than 22.5) and a store with no database are skipped, not walked: the
/// engine does not read them (the doctor names them), so they never hold up the stores it can.
fn stores(ctx: &Ctx, dry: bool) -> (Vec<String>, usize) {
    let all = list_store_hashes(ctx);
    let forced = ctx.env.get(defaults::text("mesh_write.env_store_backend")).map(|s| s.trim().to_lowercase()).unwrap_or_default();
    if !forced.is_empty() && forced != defaults::text("mesh.backend_sqlite") {
        let skipped = all.len();
        return (Vec::new(), skipped);
    }
    let total = all.len();
    let open: Vec<String> = all.into_iter().filter(|h| rc::sqlite_store(Path::new(&ctx.home), h) || rc::adopt_legacy_marker(Path::new(&ctx.home), h, dry)).collect();
    let skipped = total - open.len();
    (open, skipped)
}

/// The tally of a stage that found only stores it does not read.
fn legacy_only(skipped: usize) -> Tally {
    Tally { legacy: skipped, all_legacy: true, ..Tally::default() }
}

/// `mergeSplitBackendStoresAllStores(home)`: the journal side of every split sqlite store is folded into sqlite (`super::splitmerge`).
fn merge_split(ctx: &Ctx) -> Option<Tally> {
    let (hashes, skipped) = stores(ctx, false); // Node opens the stores read-write here whatever the dry-run switch says
    if hashes.is_empty() && skipped > 0 {
        return Some(legacy_only(skipped));
    }
    let mut t = super::splitmerge::merge_all(ctx, hashes.len() + skipped, &hashes);
    t.legacy = skipped;
    Some(t)
}

pub(super) fn swallowed(ctx: &Ctx, stage: &str, what: &str, e: &str) {
    ctx.note(defaults::render("update_post.note_store", &[("stage", &stage), ("what", &what), ("error", &e)]));
}

/// Plan (read-only) every partition of a store that still needs its import; true when any plan met a case only Node decides.
fn import_needs_node(cx: &mut Cx, h: &rc::Handle, home: &Path) -> bool {
    for id in h.rd().workspace_ids() {
        if !is_safe_id(&id) {
            continue;
        }
        if crate::meshw::cursors::rows_from_reader(h.rd(), &id).is_ok_and(|rows| !crate::meshw::cursors::needs_import(&rows)) {
            continue;
        }
        let cursor_path = match ident::read_descriptor(home, &id).as_ref().and_then(|d| d.get("cursorPath")) {
            Some(crate::checks::guardkit::ojson::OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        };
        rc::import_plan_dry(cx, h, &id, cursor_path.as_deref());
        if cx.deferred {
            return true;
        }
    }
    false
}

/// Plan (read-only) every partition of a store for the floor repair; true when any plan met a case only Node decides.
fn repair_needs_node(cx: &mut Cx, h: &rc::Handle) -> bool {
    for id in h.rd().workspace_ids() {
        if is_safe_id(&id) {
            let _planned = rc::repair_pinned_floors(cx, h, &id, true); // keep: only the deferral flag matters, errors surface in the real pass
            if cx.deferred {
                return true;
            }
        }
    }
    false
}

/// `importReaderCursorsAllStores(home)`.
fn reader_cursors_import(ctx: &Ctx, cx: &mut Cx, hashes: &[String], dry: bool) -> Option<Tally> {
    let home = Path::new(&ctx.home);
    let mut t = Tally::default();
    for hash in hashes {
        let h = match rc::open(home, hash, dry) {
            Ok(h) => h,
            Err(e) => {
                t.add("errors", 1.0);
                swallowed(ctx, "reader-cursors-import", hash, &e);
                continue;
            }
        };
        t.add("stores", 1.0);
        if !dry && import_needs_node(cx, &h, home) {
            // one session only Node can classify: write nothing for this store, the Node fallback starts from the untouched state
            cx.deferred = true;
            return Some(t);
        }
        for id in h.rd().workspace_ids() {
            if !is_safe_id(&id) {
                continue;
            }
            t.add("partitions", 1.0);
            let cursor_path = match ident::read_descriptor(home, &id).as_ref().and_then(|d| d.get("cursorPath")) {
                Some(crate::checks::guardkit::ojson::OVal::Str(s)) if !s.is_empty() => Some(s.clone()),
                _ => None,
            };
            let done = rc::import_legacy(cx, &h, &id, cursor_path.as_deref(), dry).and_then(|r| {
                if r.imported {
                    t.add("imported", 1.0);
                }
                if r.would {
                    t.add("wouldImport", 1.0);
                }
                // provably ended readers are marked (process proof only); this never moves the floor by itself
                if dry { Ok(()) } else { rc::retire_ended(cx, &h, &id).map(|_| ()) }
            });
            if let Err(e) = done {
                t.add("errors", 1.0);
                swallowed(ctx, "reader-cursors-import", &id, &e);
            }
        }
    }
    // a preview imported nothing: the import itself is still pending
    t.pending_rows = if dry { 1.0 } else { 0.0 };
    Some(t)
}

/// `repairReaderFloorsAllStores(home)`.
fn reader_floor_repair(ctx: &Ctx, cx: &mut Cx, hashes: &[String], dry: bool) -> Option<Tally> {
    let home = Path::new(&ctx.home);
    let mut t = Tally::default();
    for hash in hashes {
        let h = match rc::open(home, hash, dry) {
            Ok(h) => h,
            Err(e) => {
                t.add("errors", 1.0);
                swallowed(ctx, "reader-floor-repair", hash, &e);
                continue;
            }
        };
        t.add("stores", 1.0);
        if !dry && repair_needs_node(cx, &h) {
            // a case only Node decides: write nothing for this store, the Node fallback starts from the untouched state
            return Some(t);
        }
        for id in h.rd().workspace_ids() {
            if !is_safe_id(&id) {
                continue;
            }
            t.add("partitions", 1.0);
            match rc::repair_pinned_floors(cx, &h, &id, dry) {
                Ok(r) if !r.changed => {}
                Ok(r) => {
                    t.add("pending", 1.0);
                    if !dry {
                        t.add("repaired", 1.0);
                        t.add("retired", r.retired as f64);
                        t.add("floorsRaised", r.floors_raised() as f64);
                    }
                }
                Err(e) => {
                    t.add("errors", 1.0);
                    swallowed(ctx, "reader-floor-repair", &id, &e);
                }
            }
        }
    }
    t.pending_rows = if dry { t.get("pending") } else { 0.0 };
    Some(t)
}

/// `reconcileDualPartitionAcksAllStores(home)`.
fn dual_partition_acks(ctx: &Ctx, cx: &mut Cx, hashes: &[String], dry: bool) -> Option<Tally> {
    let home = Path::new(&ctx.home);
    let mut t = Tally::default();
    for hash in hashes {
        let h = match rc::open(home, hash, dry) {
            Ok(h) => h,
            Err(e) => {
                t.add("errors", 1.0);
                swallowed(ctx, "dual-partition-acks", hash, &e);
                continue;
            }
        };
        t.add("stores", 1.0);
        if !dry {
            // plan the whole store first (read-only): a case only Node decides leaves the store untouched for the fallback
            let _planned = reconcile(cx, &h, true, true, &mut Tally::default()); // keep: only the deferral flag matters
            if cx.deferred {
                return Some(t);
            }
        }
        if let Err(e) = reconcile(cx, &h, dry, false, &mut t) {
            t.add("errors", 1.0);
            swallowed(ctx, "dual-partition-acks", hash, &e);
        }
    }
    t.pending_rows = if dry { t.get("wouldRaise") } else { 0.0 };
    Some(t)
}

/// One store's message as the reconcile reads it.
struct Msg {
    hash: Option<String>,
    orig: Option<String>,
}

/// `forwardedOrigHashOf(row)`: the original's hash for a forwarded copy (stamped, else reconstructed from the provenance prefix).
fn forwarded_orig_hash(r: &Value) -> Option<String> {
    if let Some(h) = jv(r, "origHash").as_str().filter(|h| !h.is_empty()) {
        return Some(h.to_string());
    }
    let rest = jv(r, "body").as_str()?.strip_prefix(defaults::text("mesh_write.forward_prefix"))?;
    let close = rest.find(']').filter(|i| *i > 0)?;
    let archived = rest.get(..close)?;
    let body = rest.get(close + 1..)?.strip_prefix(' ')?;
    let direct = defaults::text("mesh_write.mtype_direct");
    Some(mesh_message_hash(
        jv(r, "sender").as_str(),
        Some(archived),
        direct,
        jv(r, "urgency").as_str().unwrap_or(""),
        body,
        &to_js_string(jv(r, "ts").as_f64().unwrap_or(0.0)),
        jv(r, "needsReply").as_bool().unwrap_or(false),
    ))
}

struct View {
    floor: i64,
    rows: Vec<Msg>,
    consumed: HashSet<String>,
}

fn keys(m: &Msg) -> Vec<&String> {
    [m.hash.as_ref(), m.orig.as_ref()].into_iter().flatten().collect()
}

/// `reconcileDualPartitionAcks(s, home, dryRun, out)` (`probe`: plan only, and run what a raise would plan for an unimported partition): for every anchor/partner pair on one worktree, raise a partition's floor
/// through the contiguous prefix of rows already consumed in the other (MAX-only, loss-free; stops at the first row not).
fn reconcile(cx: &mut Cx, h: &Handle, dry: bool, probe: bool, t: &mut Tally) -> Result<(), String> {
    let registry = h.rd().roster().map_err(|e| e.to_string())?;
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for d in &registry {
        let Some(wt) = jv(d, "worktreePath").as_str().filter(|w| !w.is_empty()) else { continue };
        let Some(id) = row_id(d).filter(|i| is_safe_id(i)) else { continue };
        let key = match ident::canonical_mesh_id(wt) {
            Ok(Some(k)) => k,
            Ok(None) => continue,
            Err(_) => {
                cx.deferred = true;
                continue;
            }
        };
        if !groups.contains_key(&key) {
            order.push(key.clone());
        }
        groups.entry(key).or_default().push(id);
    }
    if cx.deferred {
        return Ok(()); // a worktree only git can place: nothing is raised for this store
    }
    let sid_of: HashMap<String, String> = registry.iter().filter_map(|d| row_id(d).map(|i| (i, jv(d, "sessionId").as_str().unwrap_or("").to_string()))).collect();
    for mesh_id in order {
        let Some(ids) = groups.get(&mesh_id) else { continue };
        if ids.len() < 2 || !ids.contains(&mesh_id) {
            continue;
        }
        let mut view: HashMap<&String, View> = HashMap::new();
        for id in ids {
            let mut rows = Vec::new();
            h.rd()
                .for_each_message(id, 0, |m| {
                    rows.push(Msg { hash: jv(&m, "hash").as_str().map(str::to_string), orig: forwarded_orig_hash(&m) });
                    true
                })
                .map_err(|e| e.to_string())?;
            let floor = rc::floor_store(cx, h, id);
            let mut consumed = HashSet::new();
            for r in rows.iter().take((floor.max(0) as usize).min(rows.len())) {
                consumed.extend(keys(r).into_iter().cloned());
            }
            view.insert(id, View { floor, rows, consumed });
        }
        let anchor_sid = sid_of.get(&mesh_id).cloned().unwrap_or_default();
        let same_identity = |id: &String| sid_of.get(id).is_none_or(|s| s.is_empty() || *s == anchor_sid);
        let pair_of = |a: &String, b: &String| (*a == mesh_id && same_identity(b)) || (*b == mesh_id && same_identity(a));
        for id in ids {
            let Some(me) = view.get(id) else { continue };
            let others: Vec<&View> = ids.iter().filter(|o| *o != id && pair_of(id, o)).filter_map(|o| view.get(o)).collect();
            if others.is_empty() {
                continue;
            }
            let acked_elsewhere = |m: &Msg| others.iter().any(|o| keys(m).iter().any(|k| o.consumed.contains(*k)));
            let mut to = me.floor.max(0) as usize;
            while me.rows.get(to).is_some_and(acked_elsewhere) {
                to += 1;
            }
            if (to as i64) <= me.floor {
                continue;
            }
            t.add("partitions", 1.0);
            t.add("rows", (to as i64 - me.floor) as f64);
            if probe {
                rc::raise_probe(cx, h, id);
                continue;
            }
            if dry {
                t.add("wouldRaise", 1.0);
                continue;
            }
            rc::raise_all_loss_free(cx, h, id, defaults::text("mesh_write.ns_store"), to as i64)?;
            cursors::log_cursor_write(
                &cx.home,
                &LogRec {
                    id,
                    caller_id: None,
                    ns: defaults::text("mesh_write.log_ns_store"),
                    from: Some(me.floor),
                    to: Some(to as f64),
                    delivered: None,
                    nonce: None,
                    gate: defaults::text("update_post.cursor_gate"),
                    verb: defaults::text("update_post.cursor_verb"),
                    cwd: None,
                    ok: true,
                    err: None,
                    repo_key: None,
                },
            );
            t.add("raised", 1.0);
        }
    }
    Ok(())
}

/// `v[k]` of a JSON value: `null` when absent.
pub(super) fn jv<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}

/// `String(d.id)` of a registry row.
pub(super) fn row_id(d: &Value) -> Option<String> {
    match jv(d, "id") {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(to_js_string(n.as_f64()?)),
        _ => None,
    }
}
