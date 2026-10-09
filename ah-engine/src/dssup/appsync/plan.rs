//! What the app sync would do to the descriptor directories, planned natively: the archived markers for workspaces the app shows
//! archived or deleted (`markAppArchivedDescriptors`) and the stale markers the app shows open again (`retireStaleArchivedMarkers`),
//! plus the marker write itself. Planning reads only; [`write_marker`] creates a marker file that must not exist yet and never
//! touches the descriptor it copies. The retire step's execution (a restored descriptor, a revived registry row) stays Node's own
//! function, run only when Node's dry run names exactly the ids planned here (see the module `mod.rs`).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable or torn descriptor is skipped (Node: `try { JSON.parse(...) } catch (_) { continue }`)
use super::snap::Snap;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::fsx;
use crate::defaults;
use crate::meshw::appdb::norm_path;
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use std::path::{Path, PathBuf};

/// A descriptor or marker file: the id it carries and its JSON object.
#[derive(Debug, Clone)]
pub struct Desc {
    /// `String(d.id)` (the file name's stem unless the object has its own `id`).
    pub id: String,
    /// The object, key order kept.
    pub body: OVal,
}

impl Desc {
    /// A truthy string field.
    pub fn text(&self, key: &str) -> Option<&str> {
        match self.body.get(key) {
            Some(OVal::Str(s)) if !s.is_empty() => Some(s),
            _ => None,
        }
    }

    /// The `worktreePath`, `Defer` for a truthy value that is not a string.
    pub fn worktree(&self) -> R<Option<String>> {
        match self.body.get(defaults::text("devswarm_sup.as_c_worktree_path")) {
            None | Some(OVal::Null) => Ok(None),
            Some(OVal::Str(s)) => Ok((!s.is_empty()).then(|| s.clone())),
            Some(v) if !v.truthy() => Ok(None),
            Some(_) => defer("descriptor-worktree-type"),
        }
    }
}

/// `workspaces/` under the DevSwarm state directory.
pub fn dir_of(home: &Path, key: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text(key))
}

/// The `.json` files of `dir` in `readdirSync` order, as (stem, parsed object); torn files and non-objects are skipped.
pub fn read_json_dir(dir: &Path) -> R<Vec<Desc>> {
    let mut out = Vec::new();
    let ext = defaults::text("devswarm_sup.as_json_ext");
    for (name, _) in fsx::read_dir_names(&dir.to_string_lossy()).unwrap_or_default() {
        let Some(stem) = name.strip_suffix(ext) else { continue };
        let Ok(bytes) = std::fs::read(dir.join(&name)) else { continue };
        let Some(body @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { continue };
        let id = match body.get(defaults::text("devswarm_sup.as_c_id")) {
            None => stem.to_string(),
            Some(OVal::Str(s)) => s.clone(),
            Some(OVal::Num(n)) => crate::checks::guardkit::ojson::js_number_text(*n),
            Some(_) => return defer("descriptor-id-type"),
        };
        out.push(Desc { id, body });
    }
    Ok(out)
}

/// `isSafeId(id)`.
pub fn safe_id(id: &str) -> bool {
    is_safe_id(id)
}

/// `canonicalWorktreeRealPath(String(p)) || String(p)` for a truthy path; `None` for a falsy one.
pub fn wt_key(p: Option<&str>) -> R<Option<String>> {
    let Some(p) = p.filter(|p| !p.is_empty()) else { return Ok(None) };
    Ok(Some(ident::canonical_worktree_real_path(p)?.filter(|c| !c.is_empty()).unwrap_or_else(|| p.to_string())))
}

/// Whether a marker's `archivedBy` is one the app sync itself writes.
pub fn app_sourced(marker: &Desc) -> bool {
    matches!(marker.body.get("archivedBy"), Some(OVal::Str(s)) if defaults::list("devswarm_sup.as_markers_app").contains(&s.as_str()))
}

/// One marker the plan would write.
#[derive(Debug, Clone)]
pub struct Mark {
    /// The workspace id.
    pub id: String,
    /// Deleted in the app (not just archived).
    pub deleted: bool,
    /// The descriptor as read.
    pub body: OVal,
}

/// `markAppArchivedDescriptors`' plan.
#[derive(Debug, Default)]
pub struct MarkPlan {
    /// Workspaces needing a marker, in directory order.
    pub marks: Vec<Mark>,
}

/// `appArchivedVerdict` over the snapshot's `builderStates` map: `Some(true/false)`, or `None` (no opinion).
fn verdict(snap: &Snap, id: &str, worktree: Option<&str>) -> R<Option<bool>> {
    // Map(id -> state): a repeated id keeps its first position with the last values
    let mut order: Vec<&super::snap::Ws> = Vec::new();
    for w in &snap.workspaces {
        match order.iter().position(|o| o.id == w.id) {
            Some(i) => order[i] = w,
            None => order.push(w),
        }
    }
    if !id.is_empty()
        && let Some(w) = order.iter().find(|w| w.id == id)
    {
        return Ok(Some(w.archived));
    }
    let Some(wt) = worktree.map(norm_path).transpose()?.flatten() else { return Ok(None) };
    let mut saw = false;
    for b in order {
        if b.worktree_path.as_deref() != Some(wt.as_str()) {
            continue;
        }
        if b.active || !b.archived {
            return Ok(Some(false));
        }
        saw = true;
    }
    Ok(saw.then_some(true))
}

/// `appDeletedBuilder`: positive evidence the app deleted builder `id`.
fn deleted_builder(snap: &Snap, id: &str, worktree: Option<&str>) -> R<bool> {
    if snap.workspaces.is_empty() || snap.workspaces.iter().any(|w| w.id == id) {
        return Ok(false);
    }
    Ok(snap.workspace_for(None, worktree)?.is_none())
}

/// Plan the markers: for every active descriptor the app proves archived (by id, or through an archived twin on its worktree),
/// or deleted, that has no marker yet.
pub fn plan_marks(home: &Path, snap: &Snap) -> R<MarkPlan> {
    let wdir = dir_of(home, "devswarm_sup.as_dir_workspaces");
    let adir = dir_of(home, "devswarm_sup.as_dir_archived");
    let ext = defaults::text("devswarm_sup.as_json_ext");
    let uuid = regex::Regex::new(defaults::text("devswarm_sup.as_builder_re")).map_err(|e| ident::Defer(e.to_string()))?;
    let mut plan = MarkPlan::default();
    for (name, _) in fsx::read_dir_names(&wdir.to_string_lossy()).unwrap_or_default() {
        let Some(id) = name.strip_suffix(ext) else { continue };
        if !safe_id(id) {
            continue;
        }
        let Ok(bytes) = std::fs::read(wdir.join(&name)) else { continue };
        let Some(body @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { continue };
        let d = Desc { id: id.to_string(), body };
        let wt = d.worktree()?;
        let v = verdict(snap, id, wt.as_deref())?;
        let deleted = v.is_none() && uuid.is_match(id) && deleted_builder(snap, id, wt.as_deref())?;
        if v != Some(true) && !deleted {
            continue;
        }
        if std::fs::metadata(adir.join(&name)).is_ok() {
            continue;
        }
        plan.marks.push(Mark { id: id.to_string(), deleted, body: d.body });
    }
    Ok(plan)
}

/// A marker body: the descriptor with `archivedBy` and `archivedAt` set.
pub fn marker_text(m: &Mark, now: i64) -> String {
    let mut b = m.body.clone();
    let by = if m.deleted { defaults::text("devswarm_sup.as_marker_deleted") } else { defaults::text("devswarm_sup.as_marker_app") };
    b.set("archivedBy", OVal::Str(by.into()));
    b.set("archivedAt", OVal::Num(now as f64));
    b.stringify()
}

/// `checkedArchivedDir(home, { create: true })`: the directory, created if absent, which must be a real directory.
fn archived_dir_checked(home: &Path, create: bool) -> Result<Option<PathBuf>, String> {
    let dir = dir_of(home, "devswarm_sup.as_dir_archived");
    let st = match std::fs::symlink_metadata(&dir) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if !create {
                return Ok(None);
            }
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?
        }
        Err(e) => return Err(e.to_string()),
    };
    if !st.is_dir() || st.file_type().is_symlink() {
        return Err(defaults::text("devswarm_sup.as_msg_archived_dir").to_string());
    }
    Ok(Some(dir))
}

/// What writing one marker did.
#[derive(Debug, PartialEq)]
pub enum Wrote {
    /// Created.
    Marked,
    /// Already there (written by someone in the meantime): left as it is.
    Exists,
    /// Failed with this text.
    Failed(String),
}

/// Create `archived/<id>.json` if and only if it does not exist (never overwritten): the content goes to a temporary file in
/// the same directory and is linked into place, so a crash never leaves a torn marker and an existing one is never replaced.
pub fn write_marker(home: &Path, m: &Mark, now: i64) -> Wrote {
    let dir = match archived_dir_checked(home, true) {
        Ok(Some(d)) => d,
        Ok(None) => return Wrote::Failed(defaults::text("devswarm_sup.as_msg_archived_dir").into()),
        Err(e) => return Wrote::Failed(e),
    };
    let name = format!("{}{}", m.id, defaults::text("devswarm_sup.as_json_ext"));
    let target = dir.join(&name);
    let tmp = dir.join(format!("{name}.{}{}", std::process::id(), defaults::text("devswarm_sup.as_tmp_suffix")));
    let text = marker_text(m, now);
    let staged = std::fs::File::create(&tmp).and_then(|mut f| {
        use std::io::Write;
        f.write_all(text.as_bytes())?;
        f.sync_all()
    });
    if let Err(e) = staged {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: our own temporary file
        return Wrote::Failed(e.to_string());
    }
    let r = std::fs::hard_link(&tmp, &target);
    crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: our own temporary file
    match r {
        Ok(()) => Wrote::Marked,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Wrote::Exists,
        Err(e) => Wrote::Failed(e.to_string()),
    }
}

/// `retireStaleArchivedMarkers`' plan: the app-written markers whose workspace the app shows open again, older than the grace.
#[derive(Debug, Default)]
pub struct RetirePlan {
    /// The ids, in directory order.
    pub ids: Vec<String>,
}

/// Plan the retirements.
pub fn plan_retire(home: &Path, snap: &Snap, now: i64) -> R<RetirePlan> {
    let mut plan = RetirePlan::default();
    let dir = match archived_dir_checked(home, false) {
        Ok(Some(d)) => d,
        _ => return Ok(plan),
    };
    let ext = defaults::text("devswarm_sup.as_json_ext");
    for (name, _) in fsx::read_dir_names(&dir.to_string_lossy()).unwrap_or_default() {
        let Some(id) = name.strip_suffix(ext) else { continue };
        if !safe_id(id) {
            continue;
        }
        // Map(id -> w) of the open ones: the last row of a repeated id wins
        let Some(w) = snap.workspaces.iter().rev().find(|w| w.id == id && w.active && w.is_hidden == Some(false)) else { continue };
        let path = dir.join(&name);
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Some(body @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { continue };
        let marker = Desc { id: id.to_string(), body };
        let mw = wt_key(marker.worktree()?.as_deref())?;
        let aw = wt_key(w.worktree_path.as_deref())?;
        if let (Some(a), Some(b)) = (&mw, &aw)
            && a != b
        {
            continue;
        }
        if !app_sourced(&marker) {
            continue;
        }
        let at = match marker.body.get("archivedAt") {
            Some(OVal::Num(n)) if n.is_finite() => *n,
            _ => std::fs::symlink_metadata(&path).map_or(f64::NAN, |m| {
                use std::os::unix::fs::MetadataExt;
                m.ctime() as f64 * 1000.0 + m.ctime_nsec() as f64 / 1e6
            }),
        };
        if now as f64 - at < defaults::num("devswarm_sup.as_retire_grace_ms") as f64 {
            continue;
        }
        plan.ids.push(id.to_string());
    }
    Ok(plan)
}
