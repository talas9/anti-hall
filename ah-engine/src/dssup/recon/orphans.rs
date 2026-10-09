//! Slice S5: `healOrphanPartitions` (`scripts/devswarm-lib/repair.js`), the additive part only.
//!
//! An orphan is a workspace id that has messages (or a cursor, or a gate) in a store but no registry row. Node's pass visits the
//! orphans that have a descriptor first and the ones that have none afterwards. Natively decided, per orphan:
//!
//! * no descriptor in `workspaces/` or `archived/`: reported as unhealable, nothing written;
//! * a live descriptor whose worktree belongs to another repository: reported as unhealable (`wrong-store`), nothing written;
//! * a live descriptor, no archive marker of its own, its worktree not archived under any id, and no registry row of the same
//!   worktree family (neither one that exists nor one this pass adopts earlier): the id is adopted, an `upsertRegistry` under
//!   the id's lock, then one summary for the store.
//!
//! Everything else needs a part of the fold that is not ported yet and hands the WHOLE store back to Node before anything is
//! decided (Node's pass is one ordered walk, so a store is never split between the two): an orphan whose descriptor is only an
//! archive marker (forward or drained), an archive gate that reaches the liveness proof, a worktree family (the adopted row
//! forwards its unread into the survivor, `foldGroupIntoSurvivor`), a descriptor field of a type the engine does not model. The
//! forward is the part of the fold that appends message rows; this slice therefore never appends one. Node's per-pass
//! `deadline` is not modelled: the caller bounds the work by how many stores it takes per tick.
use super::gate::{self, Job};
use super::view::{self, archived_rel, registry};
use super::{Hooks, Op, RegRow, Unit, UnitEnd};
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::dsact::runner::Runner;
use crate::dssup::tick::Ctx;
use crate::meshw::ident::{R, canonical_mesh_id, defer, read_descriptor, realpath, repo_key_for_worktree};
use crate::meshw::idlock::is_safe_id;
use crate::meshw::store::RegistryRow;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// What the planner decided for one store.
pub struct OrphanPlan {
    /// The gate job: one unit per adoption, then the summary unit.
    pub job: Job,
    /// Node's result for the whole pass, assuming every unit is applied.
    pub result: Value,
    /// For each adoption unit of the job (in order): the id and its detail entry's index in `result["detail"]`.
    pub adopts: Vec<(String, usize)>,
}

/// How a run ended.
pub struct OrphanRun {
    /// Node's result over what was actually applied.
    pub result: Value,
    /// Adoptions handed back to Node, with the reason.
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

/// A descriptor field the engine models: a string, or absent / `null`; any other type is a deferral.
fn field(d: &OVal, key: &str) -> R<Option<String>> {
    match d.get(key) {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(s)) => Ok(Some(s.clone())),
        Some(_) => defer("descriptor-field-type"),
    }
}

/// `realWorktreePath(p)`: the real path, else the text as it is (a worktree that is gone).
fn real_or_raw(p: &str) -> R<String> {
    if !p.starts_with('/') {
        return defer("relative-path");
    }
    Ok(realpath(p).unwrap_or_else(|| p.to_string()))
}

/// `buildArchivedWorktreeIndex`: the set of real worktree paths some archive marker names.
fn archived_worktrees(home: &Path) -> R<HashSet<String>> {
    let mut out = HashSet::new();
    let dir = home.join(view::ds(defaults::text("mesh_write.dir_archived")));
    let suffix = defaults::text("mesh_write.json_suffix");
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(out) };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(suffix) else { continue };
        if !is_safe_id(id) {
            continue;
        }
        let Some(marker) = std::fs::read(e.path()).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        if let Some(OVal::Str(wt)) = marker.get("worktreePath")
            && !wt.is_empty()
        {
            out.insert(real_or_raw(wt)?);
        }
    }
    Ok(out)
}

/// The archive gate's answer when it is plain "not archived": the id has no marker that applies to this worktree and the
/// worktree is not archived under another id. Every other answer (archived, or a candidate reuse that needs the liveness
/// proof) is `false`, and the caller hands the store back.
fn not_archived(home: &Path, id: &str, wt: Option<&str>, index: &HashSet<String>) -> R<bool> {
    let wt = wt.filter(|w| !w.is_empty());
    let marker_path = home.join(archived_rel(id));
    let own = match std::fs::read(&marker_path) {
        Err(_) => None,
        Ok(raw) => match OVal::parse(&String::from_utf8_lossy(&raw)) {
            Some(m @ OVal::Obj(_)) => Some(m),
            _ => return Ok(false), // unreadable marker: archived
        },
    };
    if let Some(m) = &own {
        let mwt = match m.get("worktreePath") {
            Some(OVal::Str(s)) if !s.is_empty() => Some(s.as_str()),
            Some(OVal::Str(_)) | None | Some(OVal::Null) => None,
            Some(_) => return defer("descriptor-field-type"),
        };
        match (mwt, wt) {
            (Some(a), Some(b)) if real_or_raw(a)? != real_or_raw(b)? => {} // a different worktree: a new workspace reusing the id
            _ => return Ok(false),
        }
    }
    Ok(match wt {
        Some(w) => !index.contains(&real_or_raw(w)?),
        None => true,
    })
}

/// `listWorkspaceIds()` of a sqlite store, in the order Node's four sources add them.
fn workspace_ids(home: &Path, key: &str) -> R<Vec<String>> {
    let reader = crate::mesh::MeshReader::open(&view::store_db(home, key)).map_err(|e| crate::meshw::ident::Defer(format!("store-open:{e}")))?;
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

fn empty_result(key: &str, detail: Vec<Value>, adopted: usize, unhealable: usize) -> Value {
    json!({"ok": true, "scope": "store", "repoKey": key, "adopted": adopted, "forwarded": 0, "unhealable": unhealable,
        "archivedDrained": 0, "archivedStale": 0, "skipped": 0, "deadlineSkipped": 0, "pending": 0, "errors": 0, "detail": detail})
}

/// Plan `healOrphanPartitions(home, {repoKey})` for one store, or defer the whole store.
pub fn plan(home: &Path, repo_key: &str) -> R<OrphanPlan> {
    if repo_key.is_empty() {
        return defer("no-repo-key");
    }
    let call = json!({"fn": "healOrphans", "args": {"repoKey": repo_key}});
    if !home.join(view::store_rel(repo_key)).exists() {
        // Node never opens or creates a store just to look for orphans
        let result = empty_result(repo_key, Vec::new(), 0, 0);
        let job = Job {
            label: defaults::text("devswarm_recon.job_orphans").into(),
            scope: Default::default(),
            units: Vec::new(),
            calls: Vec::new(),
            expect: Vec::new(),
        };
        return Ok(OrphanPlan { job, result, adopts: Vec::new() });
    }
    let rows = registry(home, repo_key)?;
    let have: HashSet<&str> = rows.iter().map(|r| r.row.id.as_str()).collect();
    let broadcast = defaults::text("mesh_write.broadcast_partition");
    let orphans: Vec<String> =
        workspace_ids(home, repo_key)?.into_iter().filter(|id| id != broadcast && !have.contains(id.as_str()) && is_safe_id(id)).collect();
    // descriptors first (live, else archived), then the ones with none
    let (mut with, mut without) = (Vec::new(), Vec::new());
    for id in orphans {
        if let Some(d) = read_descriptor(home, &id) {
            with.push((id, d, false));
        } else if let Some(d) = read_object(home, &archived_rel(&id)) {
            with.push((id, d, true));
        } else {
            without.push(id);
        }
    }
    let index = archived_worktrees(home)?;
    // the families of the rows the store holds, grown by what this pass adopts
    let mut family: HashMap<String, usize> = HashMap::new();
    for r in &rows {
        if let Some(wt) = r.row.worktree_path.as_deref().filter(|w| !w.is_empty())
            && let Some(m) = canonical_mesh_id(wt)?
        {
            *family.entry(m).or_default() += 1;
        }
    }
    let (mut detail, mut units, mut adopts) = (Vec::new(), Vec::new(), Vec::new());
    let (mut adopted, mut unhealable) = (0, 0);
    for (id, desc, archived) in with {
        if archived {
            return defer(defaults::text("devswarm_recon.why_orphan_archived"));
        }
        let wt = field(&desc, "worktreePath")?;
        let wt_text = wt.clone().filter(|w| !w.is_empty());
        let session = field(&desc, "sessionId")?;
        let inbox = field(&desc, "inboxPath")?;
        let cursor = field(&desc, "cursorPath")?;
        if !not_archived(home, &id, wt_text.as_deref(), &index)? {
            return defer(defaults::text("devswarm_recon.why_orphan_archived"));
        }
        let fresh = match &wt_text {
            Some(w) => repo_key_for_worktree(w)?,
            None => None,
        };
        if let Some(f) = fresh.filter(|f| f != repo_key) {
            unhealable += 1;
            detail.push(json!({"id": id, "action": defaults::text("devswarm_recon.action_unhealable"), "reason": defaults::text("devswarm_recon.reason_wrong_store"), "freshRepoKey": f}));
            continue;
        }
        let mesh = match &wt_text {
            Some(w) => canonical_mesh_id(w)?,
            None => None,
        };
        if mesh.as_ref().is_some_and(|m| family.contains_key(m)) {
            return defer(defaults::text("devswarm_recon.why_orphan_family"));
        }
        if let Some(m) = mesh {
            *family.entry(m).or_default() += 1;
        }
        let row = RegistryRow { id: id.clone(), worktree_path: wt, session_id: session, inbox_path: inbox, cursor_path: cursor, nudge_command: None };
        units.push(Unit {
            label: format!("orphan:{id}"),
            lock: Some(id.clone()),
            ops: vec![Op::Upsert { store: repo_key.to_string(), row: Box::new(row), pre: None::<Box<RegRow>> }],
        });
        adopts.push((id.clone(), detail.len()));
        adopted += 1;
        detail.push(json!({"id": id, "action": defaults::text("devswarm_recon.action_adopted")}));
    }
    for id in without {
        unhealable += 1;
        detail.push(
            json!({"id": id, "action": defaults::text("devswarm_recon.action_unhealable"), "reason": defaults::text("devswarm_recon.reason_no_descriptor")}),
        );
    }
    let mut scope = super::side::scope_for(&[]);
    scope.stores.push(repo_key.to_string());
    for d in defaults::list("devswarm_recon.summary_dirs") {
        scope.dirs.push(view::ds(d));
    }
    if adopted > 0 {
        units.push(Unit { label: "orphan-summary".into(), lock: None, ops: vec![Op::Derive { store: repo_key.to_string() }] });
    }
    let result = empty_result(repo_key, detail, adopted, unhealable);
    let job = Job { label: defaults::text("devswarm_recon.job_orphans").into(), scope, units, calls: vec![call], expect: vec![Some(result.clone())] };
    Ok(OrphanPlan { job, result, adopts })
}

/// Plan, witness and apply the orphan heal of one store. A store the engine cannot decide in full is an `Err` (nothing was
/// written); an adoption the real apply could not do (busy lock, drift, a failed step) is reported in `deferred`.
pub fn run(ctx: &Ctx, runner: &dyn Runner, repo_key: &str, hooks: &Hooks) -> R<OrphanRun> {
    let p = plan(ctx.home, repo_key)?;
    let out = gate::run(ctx, runner, &p.job, hooks);
    let mut result = p.result.clone();
    let mut deferred = Vec::new();
    let mut gone: HashSet<usize> = HashSet::new();
    for ((id, at), end) in p.adopts.iter().zip(out.ends.iter()) {
        if let UnitEnd::Deferred(why) | UnitEnd::Failed(why) = end {
            deferred.push((id.clone(), why.clone()));
            gone.insert(*at);
        }
    }
    if !gone.is_empty() {
        let detail: Vec<Value> =
            p.result["detail"].as_array().cloned().unwrap_or_default().into_iter().enumerate().filter(|(i, _)| !gone.contains(i)).map(|(_, v)| v).collect();
        result["adopted"] = json!(p.adopts.len() - gone.len());
        result["detail"] = Value::Array(detail);
    }
    Ok(OrphanRun { result, deferred, verdict: out.verdict })
}
