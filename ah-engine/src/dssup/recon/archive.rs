//! Slice S7: archived registry rows and twin descriptors (`scripts/devswarm-lib/repair.js` and `fold.js`).
//!
//! * [`archive_left_reason`] and [`pick_archive_forward_survivor`] (`archiveLeftReason`, `pickArchiveForwardSurvivor`): pure
//!   decisions over descriptor files and registry rows. The survivor pick is decided here for zero or one drainable sibling;
//!   two or more need `pickSurvivor`'s cursor and heartbeat evidence and are handed to Node (a deferral, nothing decided).
//! * [`retire_identity_family`] (`retireIdentityFamilyDescriptors`): a twin descriptor is hard-linked into `archived/` and only
//!   then is the active name removed ([`Op::Link`] then [`Op::UnlinkLinked`], two ops so the descriptor is in at least one
//!   place after a crash between them). An archived copy that is another file is never overwritten; the twin stays and is
//!   reported. Each twin is its own unit under its own id lock.
//! * [`restore_archived_descriptor`] (`restoreArchivedDescriptor`): the inverse (link back, unlink the archived name, persist
//!   the owner key, revive the registry row and its summary).
//! * [`fold_archived_family`] (`foldArchivedFamilyDescriptors`): the budgeted walk over tombstones that retires the twins.
//! * [`fold_archived_rows`] (`foldArchivedRegistryRows`): per store and archived id, the archived id's own registry row is
//!   removed under a conditional guard and the summary re-derived. A pair whose same-worktree siblings would have to be
//!   folded into a survivor (`foldGroupIntoSurvivor`, slice S6) is not decided here: the whole pass is handed to Node, nothing
//!   written, because Node's pass cannot be split per pair.
//!
//! Message rows are never read for writing, deleted or updated here (the ops cannot express it). Resume markers are written
//! atomically (Node writes them in place) and a torn one reads as absent, exactly as Node's reader treats it. The budget is
//! judged against the job's clock (`Date.now` is pinned for Node in the witness), so a deadline that already passed stops
//! after the first item, as Node does.
//!
//! Not ported: the `dryRun` classification (doctor's detect()) stays Node's.
use super::gate::{self, Job, Verdict};
use super::heal::{js_string, truthy_path};
use super::view::{self, archived_rel, descriptor_rel, registry};
use super::{Hooks, Op, Pre, RegRow, Scope, Unit, UnitEnd};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::meshw::ident::{R, canonical_worktree_real_path, defer, read_descriptor, repo_key_for_worktree};
use crate::meshw::idlock::is_safe_id;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// A planned call: the job for the gate, the value Node's function returns, and which units belong to which label.
pub struct Plan {
    /// The gate job (one Node call, the units, the expected return value).
    pub job: Job,
    /// What Node's function returns once every unit is applied.
    pub result: Value,
}

/// How a run ended.
pub struct Run {
    /// The value Node's function returns when every unit was applied (the plan's, whatever the units did).
    pub result: Value,
    /// Units that were handed back to Node with the reason; nothing was written for them.
    pub deferred: Vec<(String, String)>,
    /// What the witness said.
    pub verdict: Verdict,
}

/// Witness `plan` and apply it.
pub fn run_plan(ctx: &Ctx, runner: &dyn Runner, plan: &Plan, hooks: &Hooks) -> Run {
    let out = gate::run(ctx, runner, &plan.job, hooks);
    let deferred = out
        .ends
        .iter()
        .zip(plan.job.units.iter())
        .filter_map(|(e, u)| match e {
            UnitEnd::Applied => None,
            UnitEnd::Deferred(w) | UnitEnd::Failed(w) => Some((u.label.clone(), w.clone())),
        })
        .collect();
    Run { result: plan.result.clone(), deferred, verdict: out.verdict }
}

// ---- reading the home the way Node's helpers do --------------------------------------------------------------------------------

/// `readDescriptorPathState(p)`.
enum PathState {
    /// `ENOENT`.
    Absent,
    /// Exists but unreadable, not a regular file, a symbolic link or not a JSON object.
    Bad,
    /// A regular file holding a JSON object.
    Obj(OVal),
}

fn path_state(p: &Path) -> PathState {
    match std::fs::symlink_metadata(p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => PathState::Absent,
        Err(_) => PathState::Bad,
        Ok(m) if !m.is_file() => PathState::Bad,
        Ok(_) => match std::fs::read(p).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) {
            Some(v @ OVal::Obj(_)) => PathState::Obj(v),
            _ => PathState::Bad,
        },
    }
}

/// `checkedArchivedDir(home)` without `create`.
enum ArchDir {
    /// The directory is not there.
    Absent,
    /// Something is there that is not a real directory, or it cannot be read: Node returns an empty result.
    Bad,
    /// A real directory.
    Dir(PathBuf),
}

fn archived_dir(home: &Path) -> ArchDir {
    let p = home.join(view::ds(defaults::text("mesh_write.dir_archived")));
    match std::fs::symlink_metadata(&p) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => ArchDir::Absent,
        Err(_) => ArchDir::Bad,
        Ok(m) if m.is_dir() && !m.file_type().is_symlink() => ArchDir::Dir(p),
        Ok(_) => ArchDir::Bad,
    }
}

/// `fs.readdirSync(dir)`: libuv sorts the names (`alphasort` in the C locale, byte order), so the order is not the disk's.
fn sorted_names(dir: &Path) -> Option<Vec<String>> {
    let mut v: Vec<String> = std::fs::read_dir(dir).ok()?.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    v.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    Some(v)
}

fn json_stem(n: &str) -> Option<&str> {
    n.strip_suffix(defaults::text("mesh_write.json_suffix"))
}

fn workspaces_dir(home: &Path) -> PathBuf {
    home.join(view::ds(defaults::text("mesh_write.dir_workspaces")))
}

/// `isLiveSessionId`: not null, not empty, not a synthetic `unclaimed:` mint.
fn is_live_session(s: Option<&str>) -> bool {
    s.is_some_and(|t| !t.is_empty() && !t.starts_with(defaults::text("devswarm_recon.synthetic_prefix")))
}

fn str_of(v: Option<&OVal>) -> Option<&str> {
    match v {
        Some(OVal::Str(t)) => Some(t),
        _ => None,
    }
}

/// A descriptor `id` field as a safe id (`isSafeId(d.id)`).
fn safe_id_field(d: &OVal) -> Option<&str> {
    str_of(d.get("id")).filter(|t| is_safe_id(t))
}

// ---- archiveLeftReason ------------------------------------------------------------------------------------------------------

/// `archiveLeftReason(home, id, row, isAnchor)`: the reported reason a same-worktree row survived. `row_session` is `None` when
/// there is no registry snapshot, else the row's session (`Some(None)` for a row without one).
pub fn archive_left_reason(home: &Path, id: &str, row_session: Option<Option<&str>>, is_anchor: bool) -> String {
    let t = |k: &str| defaults::text(k).to_string();
    if is_anchor {
        return t("devswarm_recon.reason_anchor");
    }
    if read_descriptor(home, id).is_none() {
        return t("devswarm_recon.reason_raced");
    }
    match row_session {
        None => t("devswarm_recon.reason_live"),
        Some(sid) if is_live_session(sid) => t("devswarm_recon.reason_live"),
        Some(_) => t("devswarm_recon.reason_no_live_session"),
    }
}

/// The gate job that proves [`archive_left_reason`] against Node's function.
pub fn left_reason_job(home: &Path, id: &str, row_session: Option<Option<&str>>, is_anchor: bool) -> Job {
    let row = match row_session {
        None => Value::Null,
        Some(sid) => json!({"id": id, "sessionId": sid}),
    };
    Job {
        label: defaults::text("devswarm_recon.job_archive").into(),
        scope: super::side::scope_for(&[descriptor_rel(id)]),
        units: Vec::new(),
        calls: vec![json!({"fn": "archiveLeftReason", "args": {"id": id, "row": row, "isAnchor": is_anchor}})],
        expect: vec![Some(json!(archive_left_reason(home, id, row_session, is_anchor)))],
    }
}

// ---- pickArchiveForwardSurvivor ---------------------------------------------------------------------------------------------

/// `pickArchiveForwardSurvivor(s, home, archivedId, rows)`: the row that will actually drain the forwarded unread, by liveness.
/// A sibling is drainable only with a descriptor file and a live session. No drainable sibling: the archived id itself. One:
/// that sibling (`pickSurvivor` returns the only row it is given). Two or more: `pickSurvivor` ranks them by cursor and
/// heartbeat evidence, which this slice does not reproduce, so it is a deferral.
pub fn pick_archive_forward_survivor(home: &Path, archived_id: &str, rows: &[RegRow]) -> R<String> {
    let mut drainable = Vec::new();
    for r in rows {
        if r.row.id == archived_id || read_descriptor(home, &r.row.id).is_none() {
            continue;
        }
        let sid = view::descriptor_of(r).session_id;
        if is_live_session(sid.as_deref()) {
            drainable.push(r.row.id.clone());
        }
    }
    match drainable.len() {
        0 => Ok(archived_id.to_string()),
        1 => Ok(drainable.remove(0)),
        _ => defer(defaults::text("devswarm_recon.why_survivor_pick")),
    }
}

/// The gate job that proves [`pick_archive_forward_survivor`] against Node's function.
pub fn survivor_job(home: &Path, archived_id: &str, rows: &[RegRow], answer: &str) -> Job {
    let rs: Vec<Value> = rows.iter().map(|r| json!({"id": r.row.id, "sessionId": view::descriptor_of(r).session_id})).collect();
    let files: Vec<String> = rows.iter().map(|r| descriptor_rel(&r.row.id)).collect();
    let _ = home;
    Job {
        label: defaults::text("devswarm_recon.job_archive").into(),
        scope: super::side::scope_for(&files),
        units: Vec::new(),
        calls: vec![json!({"fn": "pickArchiveForwardSurvivor", "args": {"archivedId": archived_id, "rows": rs}})],
        expect: vec![Some(json!(answer))],
    }
}

// ---- retireIdentityFamilyDescriptors -----------------------------------------------------------------------------------------

/// What a retire planned.
pub struct RetirePlan {
    /// One unit per twin that is retired (each under its own id lock).
    pub units: Vec<Unit>,
    /// Twin ids retired when every unit is applied, in Node's order.
    pub retired: Vec<String>,
    /// Twins left, with the reason.
    pub left: Vec<(String, String)>,
}

impl RetirePlan {
    fn empty() -> RetirePlan {
        RetirePlan { units: Vec::new(), retired: Vec::new(), left: Vec::new() }
    }

    /// Node's `{retired, left}`.
    pub fn result(&self) -> Value {
        json!({"retired": self.retired, "left": self.left.iter().map(|(id, reason)| json!({"id": id, "reason": reason})).collect::<Vec<_>>()})
    }
}

/// `worktreeIsProvablyGone(p)`: an absolute path whose `lstat` is `ENOENT`.
fn provably_gone(v: Option<&OVal>) -> bool {
    match str_of(v) {
        Some(p) if Path::new(p).is_absolute() => matches!(std::fs::symlink_metadata(p), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
        _ => false,
    }
}

/// `crossLinkedIdentity(a, b)`: one's session IS the other's id (never the same id, never an empty field).
fn cross_linked(a_id: &str, a_sid: &str, b_id: &str, b_sid: &str) -> bool {
    !a_id.is_empty() && !b_id.is_empty() && a_id != b_id && ((!a_sid.is_empty() && a_sid == b_id) || (!b_sid.is_empty() && b_sid == a_id))
}

/// `sessionId != null ? String(sessionId) : ''` and `id != null ? String(id) : ''`.
fn id_text(v: Option<&OVal>) -> R<String> {
    match v {
        None | Some(OVal::Null) => Ok(String::new()),
        other => js_string(other),
    }
}

/// Plan `retireIdentityFamilyDescriptors(home, archivedId, desc, {requireWorktreeGone})`. `gone` lists twins an earlier step of
/// the same pass already retired (their names left `workspaces/`); it is how a multi-step pass is planned against one snapshot.
pub fn plan_retire_identity_family(home: &Path, archived_id: &str, desc: &OVal, require_gone: bool, gone: &HashSet<String>) -> R<RetirePlan> {
    let ArchDir::Dir(_) = archived_dir(home) else {
        // Node creates the directory first; creating it is not a step the engine takes, and a non-directory yields no twins
        return if matches!(archived_dir(home), ArchDir::Absent) {
            defer(defaults::text("devswarm_recon.why_archived_absent"))
        } else {
            Ok(RetirePlan::empty())
        };
    };
    let Some(names) = sorted_names(&workspaces_dir(home)) else { return Ok(RetirePlan::empty()) };
    let mut candidates: Vec<(OVal, Vec<u8>, (u64, u64))> = Vec::new();
    for n in &names {
        let Some(cid) = json_stem(n) else { continue };
        if cid == archived_id || !is_safe_id(cid) || gone.contains(cid) {
            continue;
        }
        let p = workspaces_dir(home).join(n);
        let Ok(md) = std::fs::symlink_metadata(&p) else { continue };
        if !md.is_file() {
            continue;
        }
        let Ok(bytes) = std::fs::read(&p) else { continue };
        let Some(d @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { continue };
        if safe_id_field(&d) != Some(cid) {
            continue;
        }
        candidates.push((d, bytes, (md.dev(), md.ino())));
    }
    let (a_id, a_sid) = (id_text(desc.get("id"))?, id_text(desc.get("sessionId"))?);
    let mut plan = RetirePlan::empty();
    for (twin, bytes, ino) in &candidates {
        let (b_id, b_sid) = (id_text(twin.get("id"))?, id_text(twin.get("sessionId"))?);
        if !cross_linked(&a_id, &a_sid, &b_id, &b_sid) {
            continue;
        }
        if require_gone && !provably_gone(twin.get("worktreePath")) {
            plan.left.push((b_id, defaults::text("devswarm_recon.reason_unprovable").to_string()));
            continue;
        }
        let (active, arch) = (descriptor_rel(&b_id), archived_rel(&b_id));
        // archivedTombstoneDiffers: an archived copy at another inode is never ours to clobber
        let differs = match std::fs::symlink_metadata(home.join(&arch)) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return defer(defaults::text("devswarm_recon.why_unreadable")),
            Ok(m) => (m.dev(), m.ino()) != *ino,
        };
        if differs {
            plan.left.push((b_id, defaults::text("devswarm_recon.reason_differs").to_string()));
            continue;
        }
        plan.units.push(Unit {
            label: format!("retire:{b_id}"),
            lock: Some(b_id.clone()),
            ops: vec![
                Op::Link { from: active.clone(), to: arch.clone(), pre: Pre::Digest(view::sha256_hex(bytes)), ino: Some(*ino) },
                Op::UnlinkLinked { rel: active, other: arch },
            ],
        });
        plan.retired.push(b_id);
    }
    Ok(plan)
}

fn retire_scope(extra_files: &[String]) -> Scope {
    let mut sc = super::side::scope_for(extra_files);
    sc.dirs.push(view::ds(defaults::text("mesh_write.dir_workspaces")));
    sc.dirs.push(view::ds(defaults::text("mesh_write.dir_archived")));
    sc
}

/// Plan the standalone call `retireIdentityFamilyDescriptors(home, archivedId, desc, {requireWorktreeGone})`.
pub fn retire_identity_family(home: &Path, archived_id: &str, desc: &OVal, require_gone: bool) -> R<Plan> {
    let p = plan_retire_identity_family(home, archived_id, desc, require_gone, &HashSet::new())?;
    let result = p.result();
    let call = json!({"fn": "retireFamily", "args": {"archivedId": archived_id, "desc": serde_json::from_str::<Value>(&desc.stringify()).unwrap_or(Value::Null), "requireGone": require_gone}});
    Ok(Plan {
        job: Job {
            label: defaults::text("devswarm_recon.job_retire").into(),
            scope: retire_scope(&[]),
            units: p.units,
            calls: vec![call],
            expect: vec![Some(result.clone())],
        },
        result,
    })
}

// ---- foldArchivedFamilyDescriptors --------------------------------------------------------------------------------------------

/// Where the family fold's resume marker lives, relative to the home.
pub fn family_resume_rel() -> String {
    view::ds(defaults::text("devswarm_recon.file_family_resume"))
}

/// `readFoldArchivedFamilyResume(home)`: the ids, or none for an absent, torn or foreign-shaped marker.
pub fn read_family_resume(home: &Path) -> Vec<String> {
    let Some(v) = std::fs::read(home.join(family_resume_rel())).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { return Vec::new() };
    match v.get("ids") {
        Some(OVal::Arr(a)) => a.iter().filter_map(|x| if let OVal::Str(t) = x { Some(t.clone()) } else { None }).collect(),
        _ => Vec::new(),
    }
}

fn marker_unit(label: &str, rel: &str, body: Option<OVal>) -> Unit {
    let op = match body {
        Some(b) => Op::Write { rel: rel.to_string(), bytes: b.stringify().into_bytes(), pre: Pre::Any },
        None => Op::Unlink { rel: rel.to_string(), pre: Pre::Any },
    };
    Unit { label: label.to_string(), lock: None, ops: vec![op] }
}

fn num(x: i64) -> OVal {
    OVal::Num(x as f64)
}

/// Plan `foldArchivedFamilyDescriptors(home, {deadline})`.
pub fn fold_archived_family(home: &Path, now: i64, deadline: Option<i64>) -> R<Plan> {
    let call = json!({"fn": "foldArchivedFamily", "args": {"deadline": deadline}});
    let mut out =
        json!({"ok": true, "action": "fold-archived-family-descriptors", "dryRun": false, "scanned": 0, "pending": 0, "retired": [], "left": [], "errors": 0});
    let finish = |units: Vec<Unit>, out: Value| -> R<Plan> {
        Ok(Plan {
            job: Job {
                label: defaults::text("devswarm_recon.job_family").into(),
                scope: retire_scope(&[family_resume_rel()]),
                units,
                calls: vec![call.clone()],
                expect: vec![Some(out.clone())],
            },
            result: out,
        })
    };
    let ArchDir::Dir(dir) = archived_dir(home) else { return finish(Vec::new(), out) };
    let names = sorted_names(&dir).unwrap_or_default();
    let mut candidates: Vec<(String, OVal)> = Vec::new();
    for n in &names {
        let Some(aid) = json_stem(n) else { continue };
        if !is_safe_id(aid) || view::exists(home, &descriptor_rel(aid)) {
            continue;
        }
        let PathState::Obj(d) = path_state(&dir.join(n)) else { continue };
        if js_string(d.get("id"))? != aid {
            continue;
        }
        candidates.push((aid.to_string(), d));
    }
    let resume: Vec<String> = read_family_resume(home).into_iter().filter(|id| candidates.iter().any(|c| &c.0 == id)).collect();
    if resume.iter().collect::<HashSet<_>>().len() != resume.len() {
        return defer(defaults::text("devswarm_recon.why_resume_duplicates"));
    }
    let rset: HashSet<&String> = resume.iter().collect();
    let order: Vec<String> = resume.iter().cloned().chain(candidates.iter().map(|c| c.0.clone()).filter(|id| !rset.contains(id))).collect();
    let by_id: HashMap<&String, &OVal> = candidates.iter().map(|c| (&c.0, &c.1)).collect();
    let (mut units, mut gone) = (Vec::new(), HashSet::new());
    let (mut scanned, mut skipped, mut exhausted) = (0usize, 0usize, false);
    let (mut retired, mut left): (Vec<String>, Vec<(String, String)>) = (Vec::new(), Vec::new());
    let mut resume_out: Option<Vec<String>> = None;
    for (oi, aid) in order.iter().enumerate() {
        let Some(desc) = by_id.get(aid) else { continue };
        if oi > 0 && deadline.is_some_and(|d| now >= d) {
            exhausted = true;
            skipped = order.len() - oi;
            resume_out = Some(order[oi..].to_vec());
            break;
        }
        scanned += 1;
        let p = plan_retire_identity_family(home, aid, desc, true, &gone)?;
        for u in &p.units {
            gone.insert(u.lock.clone().unwrap_or_default());
        }
        retired.extend(p.retired.iter().cloned());
        left.extend(p.left.iter().cloned());
        units.extend(p.units);
    }
    // one twin is reachable from many tombstones: report per twin, first-seen order, each distinct reason kept
    let mut seen = HashSet::new();
    retired.retain(|x| seen.insert(x.clone()));
    let retired_set: HashSet<&String> = retired.iter().collect();
    let mut by_twin: Vec<(String, Vec<String>)> = Vec::new();
    for (id, reason) in &left {
        if retired_set.contains(id) {
            continue;
        }
        match by_twin.iter_mut().find(|e| &e.0 == id) {
            Some(e) => {
                if !e.1.contains(reason) {
                    e.1.push(reason.clone());
                }
            }
            None => by_twin.push((id.clone(), vec![reason.clone()])),
        }
    }
    out["scanned"] = json!(scanned);
    out["retired"] = json!(retired);
    out["left"] = Value::Array(
        by_twin
            .iter()
            .map(|(id, rs)| if rs.len() > 1 { json!({"id": id, "reason": rs[0], "reasons": rs}) } else { json!({"id": id, "reason": rs[0]}) })
            .collect(),
    );
    out["pending"] = json!(retired.len());
    if exhausted {
        out["budgetExhausted"] = json!(true);
        out["skipped"] = json!(skipped);
    }
    let rel = family_resume_rel();
    let body = resume_out.map(|ids| OVal::Obj(vec![("ids".into(), OVal::Arr(ids.into_iter().map(OVal::Str).collect())), ("ts".into(), num(now))]));
    units.push(marker_unit("family-resume", &rel, body));
    finish(units, out)
}

// ---- foldArchivedRegistryRows -------------------------------------------------------------------------------------------------

/// Where the registry fold's resume marker lives, relative to the home.
pub fn rows_resume_rel() -> String {
    view::ds(defaults::text("devswarm_recon.file_rows_resume"))
}

/// `readFoldArchivedResume(home)`: archived ids left per store bucket; `{}` for an absent or torn marker.
pub fn read_rows_resume(home: &Path) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Some(v) = std::fs::read(home.join(rows_resume_rel())).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { return out };
    if let Some(OVal::Obj(b)) = v.get("buckets") {
        for (k, x) in b {
            if let OVal::Arr(a) = x {
                out.insert(k.clone(), a.iter().filter_map(|y| if let OVal::Str(t) = y { Some(t.clone()) } else { None }).collect());
            }
        }
    }
    out
}

/// `store.listStoreHashes(home)`: store directory names shaped like a legacy hash or a repository key, in readdir order.
fn store_buckets(home: &Path) -> Vec<String> {
    let legacy = regex::Regex::new(defaults::text("devswarm_recon.re_legacy_hash"));
    let shaped = regex::Regex::new(defaults::text("devswarm_recon.re_repo_key"));
    let (Ok(legacy), Ok(shaped)) = (legacy, shaped) else { return Vec::new() };
    sorted_names(&home.join(view::ds(defaults::text("mesh_write.dir_store"))))
        .unwrap_or_default()
        .into_iter()
        .filter(|n| legacy.is_match(n) || shaped.is_match(n))
        .collect()
}

/// `removeRegistryIf` succeeds iff the row's raw columns equal the guard Node builds: an empty or missing session is NULL.
fn guard_matches(row: &RegRow) -> bool {
    let normalised = row.row.session_id.as_deref().filter(|s| !s.is_empty());
    normalised == row.row.session_id.as_deref()
}

/// Plan `foldArchivedRegistryRows(home, {deadline})`.
pub fn fold_archived_rows(home: &Path, now: i64, deadline: Option<i64>) -> R<Plan> {
    let call = json!({"fn": "foldArchivedRows", "args": {"deadline": deadline}});
    let mut out = json!({"ok": true, "action": "fold-archived-rows", "dryRun": false, "scanned": 0, "pending": 0, "retired": [], "forwarded": 0, "left": [], "errors": 0});
    let buckets = store_buckets(home);
    let finish = |units: Vec<Unit>, out: Value, with_stores: bool| -> R<Plan> {
        let mut scope = retire_scope(&[rows_resume_rel()]);
        if with_stores {
            scope.stores.extend(buckets.iter().cloned());
            for d in defaults::list("devswarm_recon.summary_dirs") {
                scope.dirs.push(view::ds(d));
            }
            scope.dirs.sort();
            scope.dirs.dedup();
        }
        Ok(Plan {
            job: Job { label: defaults::text("devswarm_recon.job_rows").into(), scope, units, calls: vec![call.clone()], expect: vec![Some(out.clone())] },
            result: out,
        })
    };
    let ArchDir::Dir(dir) = archived_dir(home) else { return finish(Vec::new(), out, false) };
    let names = sorted_names(&dir).unwrap_or_default();
    // (id, canonical real path of its worktree)
    let mut archived: Vec<(String, Option<String>)> = Vec::new();
    for n in &names {
        let Some(id) = json_stem(n) else { continue };
        if !is_safe_id(id) || view::exists(home, &descriptor_rel(id)) {
            continue;
        }
        let PathState::Obj(d) = path_state(&dir.join(n)) else { continue };
        if js_string(d.get("id"))? != id {
            continue;
        }
        let real = match truthy_path(d.get("worktreePath"))? {
            Some(wt) => canonical_worktree_real_path(&wt)?,
            None => None,
        };
        archived.push((id.to_string(), real));
    }
    out["scanned"] = json!(archived.len());
    if archived.is_empty() {
        return finish(Vec::new(), out, false);
    }
    let mut regs: Vec<(String, Vec<RegRow>)> = Vec::new();
    for b in &buckets {
        regs.push((b.clone(), registry(home, b)?));
    }
    let resume = read_rows_resume(home);
    let all_ids: Vec<String> = archived.iter().map(|a| a.0.clone()).collect();
    let known: HashSet<&String> = all_ids.iter().collect();
    let ids_for = |bucket: &str| -> R<Vec<String>> {
        let r: Vec<String> = resume.get(bucket).map(|v| v.iter().filter(|id| known.contains(id)).cloned().collect()).unwrap_or_default();
        if r.iter().collect::<HashSet<_>>().len() != r.len() {
            return defer(defaults::text("devswarm_recon.why_resume_duplicates"));
        }
        let rs: HashSet<&String> = r.iter().collect();
        let rest: Vec<String> = all_ids.iter().filter(|id| !rs.contains(id)).cloned().collect();
        Ok(r.into_iter().chain(rest).collect())
    };
    let real_of: HashMap<&String, &Option<String>> = archived.iter().map(|a| (&a.0, &a.1)).collect();
    let mut canon: HashMap<String, Option<String>> = HashMap::new();
    let (mut units, mut remaining): (Vec<Unit>, Vec<(String, Vec<String>)>) = (Vec::new(), Vec::new());
    let (mut retired, mut left): (Vec<String>, Vec<Value>) = (Vec::new(), Vec::new());
    let (mut exhausted, mut checked) = (false, 0usize);
    for (bucket, rows0) in &regs {
        if exhausted {
            remaining.push((bucket.clone(), ids_for(bucket)?));
            continue;
        }
        let mut rows = rows0.clone();
        let ids = ids_for(bucket)?;
        for (ii, aid) in ids.iter().enumerate() {
            let Some(real) = real_of.get(aid) else { continue };
            if checked > 0 && deadline.is_some_and(|d| now >= d) {
                exhausted = true;
                remaining.push((bucket.clone(), ids[ii..].to_vec()));
                break;
            }
            checked += 1;
            let own = rows.iter().find(|r| &r.row.id == aid).cloned();
            let mut same: Vec<RegRow> = Vec::new();
            if let Some(real) = real.as_deref() {
                for r in rows.iter().filter(|r| &r.row.id != aid) {
                    let Some(wt) = view::descriptor_of(r).worktree_path else { continue };
                    if !canon.contains_key(&wt) {
                        canon.insert(wt.clone(), canonical_worktree_real_path(&wt)?);
                    }
                    if canon.get(&wt).and_then(|c| c.as_deref()) == Some(real) {
                        same.push(r.clone());
                    }
                }
            }
            if own.is_none() && same.is_empty() {
                continue;
            }
            let survivor = pick_archive_forward_survivor(home, aid, &same)?;
            if same.iter().any(|r| r.row.id != survivor) {
                return defer(defaults::text("devswarm_recon.why_group_fold"));
            }
            if &survivor != aid {
                left.push(json!({"id": survivor, "bucket": bucket, "reason": defaults::text("devswarm_recon.reason_live")}));
            }
            if let Some(own) = own {
                if guard_matches(&own) {
                    units.push(Unit {
                        label: format!("rows:{bucket}:{aid}"),
                        lock: Some(aid.clone()),
                        ops: vec![Op::Remove { store: bucket.clone(), guard: Box::new(own) }, Op::Derive { store: bucket.clone() }],
                    });
                    retired.push(format!("{aid}@{bucket}"));
                    rows.retain(|r| &r.row.id != aid);
                } else {
                    left.push(json!({"id": aid, "bucket": bucket, "reason": defaults::text("devswarm_recon.reason_raced")}));
                }
            }
        }
    }
    let rel = rows_resume_rel();
    let any = remaining.iter().any(|(_, v)| !v.is_empty());
    let body = any.then(|| {
        let map = remaining.iter().map(|(k, v)| (k.clone(), OVal::Arr(v.iter().cloned().map(OVal::Str).collect()))).collect();
        OVal::Obj(vec![("buckets".into(), OVal::Obj(map)), ("ts".into(), num(now))])
    });
    units.push(marker_unit("rows-resume", &rel, body));
    out["retired"] = json!(retired);
    out["pending"] = json!(retired.len());
    out["left"] = Value::Array(left);
    if exhausted {
        out["budgetExhausted"] = json!(true);
        out["skipped"] = json!(remaining.iter().map(|(_, v)| v.len()).sum::<usize>());
    }
    finish(units, out, true)
}

// ---- restoreArchivedDescriptor ------------------------------------------------------------------------------------------------

/// The options of `restoreArchivedDescriptor`.
#[derive(Debug, Clone, Default)]
pub struct RestoreOpts {
    /// `keepMarker`: `archived/<id>.json` stays; an existing live descriptor is the truth.
    pub keep_marker: bool,
    /// `requireOwnerKey`: the descriptor's physical owner key must equal this.
    pub require_owner_key: Option<String>,
}

fn fail(error: String) -> R<(Vec<Op>, Value, Option<String>)> {
    Ok((Vec::new(), json!({"ok": false, "error": error}), None))
}

/// `descriptorPhysicalOwnerKey(desc)`: the stored `ownerKey`, else the structural repository key (`repoKey`, else the one the
/// worktree resolves to).
fn physical_owner_key(desc: &OVal) -> R<Option<String>> {
    if let Some(k) = nonempty(desc.get("ownerKey")) {
        return Ok(Some(k.to_string()));
    }
    if let Some(k) = nonempty(desc.get("repoKey")) {
        return Ok(Some(k.to_string()));
    }
    match truthy_path(desc.get("worktreePath"))? {
        Some(wt) => repo_key_for_worktree(&wt),
        None => Ok(None),
    }
}

fn nonempty(v: Option<&OVal>) -> Option<&str> {
    str_of(v).filter(|s| !s.is_empty())
}

/// `serializeCmd(nudgeCommand)` and the string columns of `upsertRegistry(desc)`.
fn registry_row_of(desc: &OVal, id: &str) -> R<crate::meshw::store::RegistryRow> {
    let col = |k: &str| -> R<Option<String>> {
        match desc.get(k) {
            None | Some(OVal::Null) => Ok(None),
            other => js_string(other).map(Some),
        }
    };
    let nudge = match desc.get("nudgeCommand") {
        None | Some(OVal::Null) => None,
        Some(v) => Some(v.stringify()),
    };
    Ok(crate::meshw::store::RegistryRow {
        id: id.to_string(),
        worktree_path: col("worktreePath")?,
        session_id: col("sessionId")?,
        inbox_path: col("inboxPath")?,
        cursor_path: col("cursorPath")?,
        nudge_command: nudge,
    })
}

/// The ops, Node's return value and the owner store the decision read (it must be in the mirror: Node opens it).
fn restore_ops(home: &Path, id: &str, o: &RestoreOpts) -> R<(Vec<Op>, Value, Option<String>)> {
    let (arch_rel, act_rel) = (archived_rel(id), descriptor_rel(id));
    let (arch_p, act_p) = (home.join(&arch_rel), home.join(&act_rel));
    let archived = path_state(&arch_p);
    let arch_exists = !matches!(archived, PathState::Absent);
    let active = if arch_exists && !o.keep_marker { None } else { Some(path_state(&act_p)) };
    if matches!(archived, PathState::Bad) || matches!(active, Some(PathState::Bad)) {
        return defer(defaults::text("devswarm_recon.why_unreadable"));
    }
    let active_exists = matches!(active, Some(PathState::Obj(_)));
    let q = serde_json::to_string(id).unwrap_or_default();
    if !arch_exists && !active_exists {
        return fail(defaults::render("devswarm_recon.err_no_archived", &[("id", &q)]));
    }
    if o.keep_marker && !arch_exists {
        return fail(defaults::render("devswarm_recon.err_no_marker", &[("id", &q)]));
    }
    let active_live = o.keep_marker && active_exists;
    let mut desc = match (&archived, &active) {
        (_, Some(PathState::Obj(a))) if active_live => a.clone(),
        (PathState::Obj(a), _) => a.clone(),
        (_, Some(PathState::Obj(a))) => a.clone(),
        _ => return defer(defaults::text("devswarm_recon.why_unreadable")),
    };
    if safe_id_field(&desc).is_none() || js_string(desc.get("id"))? != id || truthy_path(desc.get("worktreePath"))?.is_none() {
        return fail(defaults::render("devswarm_recon.err_identity", &[("id", &q)]));
    }
    let Some(owner) = physical_owner_key(&desc)? else { return fail(defaults::text("devswarm_recon.err_no_owner").to_string()) };
    if let Some(want) = &o.require_owner_key
        && *want != owner
    {
        return fail(defaults::text("devswarm_recon.err_other_project").to_string());
    }
    let mut ops = Vec::new();
    let mut created_link = false;
    let arch_bytes = std::fs::read(&arch_p).unwrap_or_default();
    if arch_exists && !active_live {
        match view::pre_of(home, &act_rel) {
            Pre::Absent => {
                created_link = true;
                ops.push(Op::Link {
                    from: arch_rel.clone(),
                    to: act_rel.clone(),
                    pre: Pre::Digest(view::sha256_hex(&arch_bytes)),
                    ino: super::apply::ino_of(&arch_p),
                });
            }
            _ => {
                if super::apply::ino_of(&arch_p) != super::apply::ino_of(&act_p) {
                    return fail(defaults::text("devswarm_recon.err_anchor").to_string());
                }
            }
        }
        if !o.keep_marker {
            ops.push(Op::UnlinkLinked { rel: arch_rel.clone(), other: act_rel.clone() });
        }
    }
    let marker_only: Vec<&str> = defaults::list("devswarm_recon.marker_only_fields").into_iter().filter(|k| desc.get(k).is_some()).collect();
    let owner_differs = !matches!(desc.get("ownerKey"), Some(OVal::Str(k)) if *k == owner);
    if owner_differs || (!marker_only.is_empty() && !active_live) {
        desc.set("ownerKey", OVal::Str(owner.clone()));
        if let OVal::Obj(fields) = &mut desc {
            fields.retain(|(k, _)| !marker_only.contains(&k.as_str()));
        }
        let pre = if created_link || (arch_exists && !active_live) { Pre::Any } else { view::pre_of(home, &act_rel) };
        ops.push(Op::Write { rel: act_rel.clone(), bytes: desc.stringify().into_bytes(), pre });
    }
    // the registry row in the owner's store
    let rows = registry(home, &owner)?;
    let present = rows.iter().find(|r| r.row.id == id).cloned();
    if o.keep_marker && present.is_some() {
        return Ok((ops, json!({"ok": true, "restoredLink": created_link}), Some(owner)));
    }
    let row = registry_row_of(&desc, id)?;
    if let Some(p) = &present
        && p.row.worktree_path != row.worktree_path
    {
        return defer(defaults::text("devswarm_recon.why_collision"));
    }
    ops.push(Op::Upsert { store: owner.clone(), row: Box::new(row), pre: present.map(Box::new) });
    ops.push(Op::Derive { store: owner.clone() });
    Ok((ops, json!({"ok": true, "restoredLink": created_link}), Some(owner)))
}

/// Plan `restoreArchivedDescriptor(home, id, ctx, opts)` (the caller holds the id lock in Node; here the unit takes it).
pub fn restore_archived_descriptor(home: &Path, id: &str, opts: &RestoreOpts) -> R<Plan> {
    let (ops, result, owner) = restore_ops(home, id, opts)?;
    let mut sc = retire_scope(&[]);
    if let Some(store) = owner {
        sc.stores.push(store);
        for d in defaults::list("devswarm_recon.summary_dirs") {
            sc.dirs.push(view::ds(d));
        }
        sc.dirs.sort();
        sc.dirs.dedup();
    }
    let units = if ops.is_empty() { Vec::new() } else { vec![Unit { label: format!("restore:{id}"), lock: Some(id.to_string()), ops }] };
    let call = json!({"fn": "restore", "args": {"id": id, "keepMarker": opts.keep_marker, "requireOwnerKey": opts.require_owner_key}});
    Ok(Plan {
        job: Job { label: defaults::text("devswarm_recon.job_restore").into(), scope: sc, units, calls: vec![call], expect: vec![Some(result.clone())] },
        result,
    })
}

/// Whether the engine decides the sweep tail (`devswarm_sup.sweep_tail_mode` is `engine`); `node` (the default) leaves every
/// function to Node's scheduled sweep.
pub fn engine_mode(st: &crate::checks::git::util::Settings) -> bool {
    crate::dssup::setting(st, "devswarm_sup.sweep_tail_mode").as_str() == Some(defaults::text("devswarm_recon.mode_engine"))
}
