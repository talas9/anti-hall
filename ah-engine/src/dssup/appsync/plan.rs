//! What the app sync would do to the descriptor directories, planned natively: the archived markers for workspaces the app shows
//! archived or deleted (`markAppArchivedDescriptors`) and the stale markers the app shows open again (`retireStaleArchivedMarkers`),
//! plus the marker write itself. Planning reads only; [`write_marker`] creates a marker file that must not exist yet and never
//! touches the descriptor it copies. The retire step ([`retire_marker`]) restores the descriptor and revives the registry row through
//! the recon planner's own restore (`restoreArchivedDescriptor` with `keepMarker`), and only then moves the marker to
//! `archived-retired/`; a marker is never deleted.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable or torn descriptor is skipped (Node: `try { JSON.parse(...) } catch (_) { continue }`)
use super::snap::Snap;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::fsx;
use crate::defaults;
use crate::meshw::appdb::norm_path;
use crate::meshw::ident::{self, R};
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

    /// The `worktreePath` as the sync reads it: `String(d.worktreePath)` for a truthy value, none for a falsy one.
    pub fn worktree(&self) -> R<Option<String>> {
        Ok(self.body.get(defaults::text("devswarm_sup.as_c_worktree_path")).filter(|v| v.truthy()).map(js_str))
    }
}

/// `String(v)` of a parsed JSON value: arrays join their elements with commas (null as empty), objects are `[object Object]`.
pub fn js_str(v: &OVal) -> String {
    match v {
        OVal::Null => defaults::text("devswarm_sup.as_js_null").to_string(),
        OVal::Bool(b) => b.to_string(),
        OVal::Num(n) => crate::checks::jsport::num::to_js_string(*n),
        OVal::Str(s) => s.clone(),
        OVal::Arr(a) => a.iter().map(|x| if matches!(x, OVal::Null) { String::new() } else { js_str(x) }).collect::<Vec<_>>().join(","),
        OVal::Obj(_) => defaults::text("devswarm_sup.as_js_object").to_string(),
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
        // `Object.assign({ id: stem }, d)`: the descriptor's own `id` wins, whatever it is, and readers take `String(d.id)`
        let id = body.get(defaults::text("devswarm_sup.as_c_id")).map_or_else(|| stem.to_string(), js_str);
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
    let uuid = regex::Regex::new(defaults::text("devswarm_sup.as_builder_re")).map_err(|e| crate::dssup::failure(e.to_string()))?;
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

/// How retiring one stale marker ended.
#[derive(Debug, PartialEq)]
pub enum Retired {
    /// The workspace is active again and the marker moved to `archived-retired/`.
    Done,
    /// The marker went away before the lock was taken: nothing to do.
    Gone,
    /// Nothing was changed for this marker (or only the restore landed, which is idempotent): the reason, the marker stays.
    Left(String),
    /// A step failed with an error (counted as an error of the pass).
    Failed(String),
}

fn retired_dir_checked(home: &Path) -> Result<PathBuf, String> {
    let dir = dir_of(home, "devswarm_sup.as_dir_retired");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let st = std::fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !st.is_dir() || st.file_type().is_symlink() {
        return Err(defaults::text("devswarm_sup.as_msg_retired_dir").to_string());
    }
    Ok(dir)
}

/// Retire one stale marker (`retireStaleArchivedMarkers`, one id): under the id's lock, restore the descriptor and revive the
/// registry row first (the marker stays until the workspace is verifiably active again), then write the marker's bytes plus a
/// `retired` record to `archived-retired/<id>.<now>.json` (new file, never overwritten) and only then remove the marker, so the
/// descriptor is in at least one place after a crash between the two. Nothing is ever deleted that is not copied first.
pub fn retire_marker(ctx: &crate::dssup::tick::Ctx, id: &str, builder_id: &str) -> Retired {
    use crate::dssup::recon::{Op, Pre, Unit, UnitEnd, apply, archive, view};
    let home = ctx.home;
    let Some(lock) = crate::meshw::idlock::acquire(home, id) else { return Retired::Left(defaults::text("devswarm_sup.as_why_lock_busy").to_string()) };
    let r = (|| {
        let marker_rel = view::archived_rel(id);
        let marker_path = home.join(&marker_rel);
        let Ok(body) = std::fs::read(&marker_path) else { return Retired::Gone };
        let env = apply::Env { home, now: ctx.now, st: ctx.st, log_dir: None };
        // restore first (the same restore `unarchive` runs); the marker moves only after the workspace is verifiably active again
        let opts = archive::RestoreOpts { keep_marker: true, require_owner_key: None };
        let plan = match archive::restore_archived_descriptor(home, id, &opts) {
            Ok(p) => p,
            Err(d) => return Retired::Left(defaults::render("devswarm_sup.as_why_restore_failed", &[("error", &d.0)])),
        };
        if !matches!(plan.result.get("ok"), Some(serde_json::Value::Bool(true))) {
            let why = plan.result.get("error").and_then(|e| e.as_str()).unwrap_or_default();
            return Retired::Left(defaults::render("devswarm_sup.as_why_restore_failed", &[("error", &why)]));
        }
        for u in &plan.job.units {
            let unlocked = Unit { label: u.label.clone(), lock: None, ops: u.ops.clone() };
            match apply::unit(&env, &unlocked, &crate::dssup::recon::Hooks::none()) {
                UnitEnd::Applied => {}
                UnitEnd::Deferred(why) => return Retired::Left(why),
                UnitEnd::Failed(why) => return Retired::Failed(why),
            }
        }
        let dir = match retired_dir_checked(home) {
            Ok(d) => d,
            Err(e) => return Retired::Left(e),
        };
        let name = format!("{id}.{}{}", ctx.now, defaults::text("devswarm_sup.as_json_ext"));
        if dir.join(&name).exists() {
            return Retired::Left(defaults::text("devswarm_sup.as_why_retired_exists").to_string());
        }
        let text = String::from_utf8_lossy(&body).into_owned();
        let mut rec = match OVal::parse(&text) {
            Some(o @ OVal::Obj(_)) => o,
            _ => OVal::Obj(vec![(defaults::text("devswarm_sup.as_retired_raw").to_string(), OVal::Str(text.clone()))]),
        };
        let s = |t: &str| OVal::Str(t.to_string());
        let key = |k: &str| defaults::text(k).to_string();
        rec.set(
            &key("devswarm_sup.as_retired_field"),
            OVal::Obj(vec![
                (key("devswarm_sup.as_retired_at"), OVal::Num(ctx.now as f64)),
                (key("devswarm_sup.as_retired_by"), s(defaults::text("devswarm_sup.as_retired_by_value"))),
                (key("devswarm_sup.as_retired_reason"), s(defaults::text("devswarm_sup.as_retired_reason_value"))),
                (key("devswarm_sup.as_retired_builder"), s(builder_id)),
                (key("devswarm_sup.as_retired_restored"), OVal::Bool(true)),
            ]),
        );
        let dest_rel = view::ds(&format!("{}/{name}", defaults::text("devswarm_sup.as_dir_retired")));
        let unit = Unit {
            label: format!("retire-marker:{id}"),
            lock: None,
            ops: vec![
                Op::Write { rel: dest_rel, bytes: rec.stringify().into_bytes(), pre: Pre::Absent },
                Op::Unlink { rel: marker_rel, pre: Pre::Digest(view::sha256_hex(&body)) },
            ],
        };
        match apply::unit(&env, &unit, &crate::dssup::recon::Hooks::none()) {
            UnitEnd::Applied => Retired::Done,
            UnitEnd::Deferred(why) => Retired::Left(why),
            UnitEnd::Failed(why) => Retired::Failed(why),
        }
    })();
    lock.release();
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_descriptor_with_an_odd_id_or_worktree_is_read_as_javascript_stringifies_it() {
        crate::defaults::init().unwrap();
        let dir = std::env::temp_dir().join(format!("ah-as-plan-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.json"), r#"{"id":{"x":1},"worktreePath":7}"#).unwrap();
        std::fs::write(dir.join("b.json"), r#"{"id":null,"worktreePath":["p","q"]}"#).unwrap();
        std::fs::write(dir.join("c.json"), r#"{"id":12,"worktreePath":""}"#).unwrap();
        std::fs::write(dir.join("d.json"), r#"{"worktreePath":"/w"}"#).unwrap();
        let mut got: Vec<(String, Option<String>)> = read_json_dir(&dir).unwrap().iter().map(|d| (d.id.clone(), d.worktree().unwrap())).collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("12".to_string(), None),
                ("[object Object]".to_string(), Some("7".to_string())),
                ("d".to_string(), Some("/w".to_string())),
                ("null".to_string(), Some("p,q".to_string())),
            ]
        );
        crate::discard::harmless(std::fs::remove_dir_all(dir)); // keep: cleanup of a scratch directory
    }
}
