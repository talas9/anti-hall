//! The shadow comparison against the Node witness (owner amendment 4): Node's supervisor and ingest run non-acting in a
//! scratch HOME against read mirrors; their liveness verdicts and app-state cache are read from that scratch tree (never
//! from the live Node files) and compared with the engine's state. Differences are appended to the NDJSON shadow log and
//! counted in `rt_shadow_mismatches`.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::devswarm_rt::state::{Activity, Lifecycle, Snapshot};
use crate::meshw::idlock::devswarm_root;
use serde_json::json;
use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};

/// One difference between the engine and the witness.
#[derive(Debug, Clone, PartialEq)]
pub struct Mismatch {
    /// What was compared.
    pub check: &'static str,
    /// The workspace, or empty for a count.
    pub id: String,
    /// The engine's value.
    pub engine: String,
    /// The witness's value.
    pub witness: String,
}

/// The shadow log's path in the engine state directory.
pub fn log_path() -> Option<PathBuf> {
    crate::bootstrap::state_dir().map(|d| d.join(defaults::text("devswarm_rt.shadow_file")))
}

/// The witness's DevSwarm directory under `home`.
pub fn witness_dir(home: &Path) -> PathBuf {
    devswarm_root(&home.join(defaults::text("devswarm_rt.witness_home")))
}

fn read(p: &Path) -> Option<OVal> {
    OVal::parse(&String::from_utf8_lossy(&std::fs::read(p).ok()?))
}

/// Compare the engine's snapshot with the witness tree at `dir`. `None`: the witness has not produced its files (nothing to
/// compare, which is not a mismatch).
pub fn compare(snap: &Snapshot, dir: &Path) -> Option<Vec<Mismatch>> {
    let app_state = read(&dir.join(defaults::text("devswarm_rt.witness_app_state")))?;
    let mut out = Vec::new();
    let engine_active: BTreeSet<String> =
        snap.workspaces.values().filter(|w| matches!(w.lifecycle.value, Lifecycle::Active | Lifecycle::Hidden)).map(|w| w.id.clone()).collect();
    if let Some(OVal::Arr(list)) = app_state.get(defaults::text("devswarm_rt.shadow_key_active")) {
        let theirs: BTreeSet<String> = list
            .iter()
            .filter_map(|e| match e.get(defaults::text("devswarm_rt.shadow_key_id")) {
                Some(OVal::Str(s)) => Some(s.clone()),
                _ => None,
            })
            .collect();
        for id in engine_active.symmetric_difference(&theirs) {
            out.push(Mismatch {
                check: "active_set",
                id: id.clone(),
                engine: engine_active.contains(id).to_string(),
                witness: theirs.contains(id).to_string(),
            });
        }
    }
    if let Some(counts) = app_state.get(defaults::text("devswarm_rt.shadow_key_counts"))
        && let Some(OVal::Num(n)) = counts.get(defaults::text("devswarm_rt.shadow_key_archived"))
    {
        let mine = snap.workspaces.values().filter(|w| w.lifecycle.value == Lifecycle::Archived).count();
        if mine as f64 != *n {
            out.push(Mismatch { check: "archived_count", id: String::new(), engine: mine.to_string(), witness: n.to_string() });
        }
    }
    let suffix = defaults::text("mesh_write.json_suffix");
    for w in snap.workspaces.values().filter(|w| engine_active.contains(&w.id)) {
        let Some(live) = read(&dir.join(defaults::text("mesh_write.dir_liveness")).join(format!("{}{suffix}", w.id))) else { continue };
        if let Some(OVal::Str(status)) = live.get(defaults::text("devswarm_rt.shadow_key_status")) {
            let theirs_stuck = status != defaults::text("devswarm_rt.liveness_ok");
            // an engine `unknown` activity makes no claim, so it cannot disagree
            if w.activity.value != Activity::Unknown && (w.activity.value == Activity::Stuck) != theirs_stuck {
                out.push(Mismatch { check: "stuck", id: w.id.clone(), engine: format!("{:?}", w.activity.value), witness: status.clone() });
            }
        }
        if let (Some(OVal::Bool(p)), Some(n)) = (live.get(defaults::text("devswarm_rt.shadow_key_pending")), w.unread.value)
            && *p != (n > 0)
        {
            out.push(Mismatch { check: "unread_pending", id: w.id.clone(), engine: n.to_string(), witness: p.to_string() });
        }
    }
    Some(out)
}

/// Append a run's mismatches to the shadow log (one JSON line each), unless the log is at its size cap. Returns how many
/// lines were written.
pub fn append(log: &Path, now: i64, generation: u64, mismatches: &[Mismatch]) -> std::io::Result<usize> {
    if mismatches.is_empty() {
        return Ok(0);
    }
    if std::fs::metadata(log).is_ok_and(|m| m.len() >= defaults::num("devswarm_rt.shadow_max_bytes")) {
        return Ok(0);
    }
    if let Some(d) = log.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
    for m in mismatches {
        writeln!(f, "{}", json!({"at": now, "gen": generation, "check": m.check, "id": m.id, "engine": m.engine, "witness": m.witness}))?;
    }
    Ok(mismatches.len())
}
