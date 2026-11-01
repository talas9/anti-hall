//! GH #508 (`devswarm.skipDeadChildren`): the ONE definition of a dead child and the ONE place that validates, applies and writes the
//! expiry marks. Everything here is positive proof; anything unprovable keeps the reminder and the unread count.
//!
//! * dead = ARCHIVED (anti-hall's marker or the app) AND the worktree provably gone ([`worktree_gone`]). A worktree that is merely
//!   absent never makes a child dead.
//! * a mark (`expired/<id>.json`) covers the mail that EXISTED when it was written: per source (`store` rows, `nd` NDJSON lines),
//!   never a merged total, so anything arriving later counts whichever source it comes from.
//! * a mark is bound to an INCARNATION of the child (session id, worktree and the `archivedAt` of its archive marker): a mark of
//!   another incarnation is ignored. An impossible mark (a position past what is stored, negative, non-integer, wrong type) is
//!   ignored too, so the summary falls back to the full count.
//! * the write is monotonic (compare-and-set to the larger positions under a directory lock) and reports whether it wrote.
use crate::defaults;
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The positions a mark covers: `store` rows and `nd` NDJSON lines of one incarnation.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Mark {
    incarnation: String,
    store: u64,
    nd: u64,
}

fn suffix() -> &'static str {
    defaults::text("mesh_write.json_suffix")
}

fn read_value(p: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn mark_dir(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_parent.dir_expired"))
}

/// Whether the worktree is provably gone: `Some(true)` only when the path is absent AND its nearest existing ancestor is a directory
/// that, with every link resolved, lies inside the home directory (a path behind a link that points outside the home, on an unmounted
/// volume or behind a permission error proves nothing); `Some(false)` when the path is there; `None` when it cannot be established.
pub(crate) fn worktree_gone(wt: &str, home: &Path) -> Option<bool> {
    let p = Path::new(wt);
    if wt.is_empty() || !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    match std::fs::symlink_metadata(p) {
        Ok(_) => return Some(false),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    let real_home = std::fs::canonicalize(home).ok()?;
    for a in p.ancestors().skip(1) {
        match std::fs::symlink_metadata(a) {
            Ok(_) => {
                let real = std::fs::canonicalize(a).ok()?;
                return (real.is_dir() && real.starts_with(&real_home)).then_some(true);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }
    None
}

/// The incarnation of the archived child `id`: its archive marker's session id, worktree and `archivedAt`, when `reg` (the live
/// registry row's `(session, worktree)`, `None` for a partition with no registry row) names the same session and worktree. `None` when
/// any part is missing or the registry names another child: such a child has no incarnation, so no mark is written or honoured.
pub(crate) fn incarnation_of(home: &Path, id: &str, reg: Option<(Option<&str>, Option<&str>)>) -> Option<String> {
    if !is_safe_id(id) {
        return None;
    }
    let m = read_value(&devswarm_root(home).join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{}", suffix())))?;
    let text = |k: &str| m.get(k).and_then(Value::as_str).filter(|s| !s.is_empty());
    let sid = text(defaults::text("mesh_write.field_session_id"))?;
    let wt = text(defaults::text("mesh_write.field_worktree_path"))?;
    let at = m.get(defaults::text("devswarm_sup.rt_archived_at")).and_then(Value::as_u64)?;
    if let Some((rs, rw)) = reg
        && (rs != Some(sid) || rw != Some(wt))
    {
        return None;
    }
    let at = at.to_string();
    Some(defaults::render("devswarm_parent.mark_incarnation_fmt", &[("sid", &sid), ("wt", &wt), ("at", &at)]))
}

/// The mark of `id` when it is well formed: an object whose incarnation is text and whose positions are non-negative integers.
fn read_mark(home: &Path, id: &str) -> Option<Mark> {
    let v = read_value(&mark_dir(home).join(format!("{id}{}", suffix())))?;
    let pos = |k: &str| v.get(k).and_then(|x| if x.is_u64() { x.as_u64() } else { None });
    Some(Mark {
        incarnation: v.get(defaults::text("devswarm_parent.mark_incarnation"))?.as_str().filter(|s| !s.is_empty())?.to_string(),
        store: pos(defaults::text("devswarm_parent.mark_store"))?,
        nd: pos(defaults::text("devswarm_parent.mark_nd"))?,
    })
}

/// What the summary counts from: the positions `(store, nd)` the mark of `id` expires, `(0, 0)` unless the switch is on, a well formed
/// mark exists for the CURRENT incarnation, the worktree `reg` names is still provably gone, and the mark does not reach past what is
/// stored (`store_total` rows, `nd_lines` NDJSON lines). Every refusal is counted (`devswarm_dead_mark_ignored`, by reason).
pub(crate) fn applied(home: &Path, on: bool, id: &str, reg: Option<(Option<&str>, Option<&str>)>, store_total: f64, nd_lines: f64) -> (f64, f64) {
    if !on || !is_safe_id(id) {
        return (0.0, 0.0);
    }
    let path = mark_dir(home).join(format!("{id}{}", suffix()));
    if std::fs::symlink_metadata(&path).is_err() {
        return (0.0, 0.0);
    }
    let ignore = |why: &str| {
        crate::metrics::bump("devswarm_dead_mark_ignored", &[("reason", why)]);
        (0.0, 0.0)
    };
    let Some(mark) = read_mark(home, id) else { return ignore("malformed") };
    match incarnation_of(home, id, reg) {
        Some(cur) if cur == mark.incarnation => {}
        _ => return ignore("other_incarnation"),
    }
    let wt = reg.and_then(|r| r.1).map(str::to_string).or_else(|| archived_worktree(home, id));
    if worktree_gone(wt.as_deref().unwrap_or(""), home) != Some(true) {
        return ignore("worktree_back");
    }
    if mark.store as f64 > store_total || mark.nd as f64 > nd_lines {
        return ignore("beyond_stored");
    }
    (mark.store as f64, mark.nd as f64)
}

fn archived_worktree(home: &Path, id: &str) -> Option<String> {
    let m = read_value(&devswarm_root(home).join(defaults::text("mesh_write.dir_archived")).join(format!("{id}{}", suffix())))?;
    m.get(defaults::text("mesh_write.field_worktree_path"))?.as_str().map(str::to_string)
}

/// The mark a summary row offers for writing: `{incarnation, store, nd}` when the child is archived (its marker names an incarnation)
/// and its worktree is provably gone, else `None`.
pub(crate) fn offer(home: &Path, on: bool, id: &str, reg: Option<(Option<&str>, Option<&str>)>, store_total: f64, nd_lines: f64) -> Option<Value> {
    if !on || store_total + nd_lines <= 0.0 {
        return None;
    }
    let inc = incarnation_of(home, id, reg)?;
    let wt = reg.and_then(|r| r.1).map(str::to_string).or_else(|| archived_worktree(home, id))?;
    (worktree_gone(&wt, home) == Some(true)).then(|| {
        json!({
            defaults::text("devswarm_parent.mark_incarnation"): inc,
            defaults::text("devswarm_parent.mark_store"): store_total as u64,
            defaults::text("devswarm_parent.mark_nd"): nd_lines as u64,
        })
    })
}

/// Write the offered `mark` of `id` (compare-and-set to the larger positions under an exclusive lock on the mark directory, so
/// concurrent writers can never lower it). `true` only when the file now holds a larger mark that this call wrote; `false` when
/// nothing changed or the write failed (the caller then counts nothing).
pub fn write_offer(home: &Path, id: &str, offered: &Value, now: f64) -> bool {
    let (Some(inc), Some(store), Some(nd)) = (
        offered.get(defaults::text("devswarm_parent.mark_incarnation")).and_then(Value::as_str).filter(|s| !s.is_empty()),
        offered.get(defaults::text("devswarm_parent.mark_store")).and_then(Value::as_u64),
        offered.get(defaults::text("devswarm_parent.mark_nd")).and_then(Value::as_u64),
    ) else {
        return false;
    };
    if !is_safe_id(id) {
        return false;
    }
    let dir = mark_dir(home);
    if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) || std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let Ok(lock) = std::fs::File::open(&dir) else { return false };
    // the shared bounded lock (spool.lock_wait_ms): a stuck holder makes this give up and write nothing; released when `lock` drops
    if crate::spool::flock_bounded(&lock).is_err() {
        return false;
    }
    let (store, nd) = match read_mark(home, id) {
        Some(cur) if cur.incarnation == inc => {
            if cur.store >= store && cur.nd >= nd {
                return false;
            }
            (cur.store.max(store), cur.nd.max(nd))
        }
        _ => (store, nd),
    };
    let body = json!({
        defaults::text("devswarm_parent.mark_incarnation"): inc,
        defaults::text("devswarm_parent.mark_store"): store,
        defaults::text("devswarm_parent.mark_nd"): nd,
        defaults::text("devswarm_parent.mark_at"): now as u64,
    });
    let Ok(rel) = dir.join(format!("{id}{}", suffix())).strip_prefix(home).map(|p| p.to_string_lossy().into_owned()) else { return false };
    crate::script::host::write_atomic_with(&home.to_string_lossy(), &rel, &body.to_string(), false).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worktree_is_gone_only_on_positive_proof() {
        let d = std::env::temp_dir().join(format!("ah-gone-{}", std::process::id()));
        let home = d.join("home");
        std::fs::create_dir_all(home.join("repos/here")).unwrap();
        std::fs::create_dir_all(d.join("outside/real")).unwrap();
        std::os::unix::fs::symlink(d.join("outside/real"), home.join("repos/link")).unwrap();
        std::os::unix::fs::symlink(d.join("nowhere"), home.join("repos/dangling")).unwrap();
        let p = |x: &str| home.join(x).to_string_lossy().to_string();
        assert_eq!(worktree_gone(&p("repos/here"), &home), Some(false), "present");
        assert_eq!(worktree_gone(&p("repos/absent"), &home), Some(true), "absent under an existing parent");
        assert_eq!(worktree_gone(&p("repos/3/8205fc11/absent"), &home), Some(true), "the repos-root folders went with it");
        assert_eq!(worktree_gone(&p("repos/link/absent"), &home), None, "behind a link that points outside the home");
        assert_eq!(worktree_gone(&p("repos/dangling/absent"), &home), None, "behind a dangling link");
        assert_eq!(worktree_gone(&d.join("elsewhere/absent").to_string_lossy(), &home), None, "an ancestor outside the home proves nothing");
        assert_eq!(worktree_gone(&p("repos/here/../x"), &home), None, "a path with .. proves nothing");
        assert_eq!(worktree_gone("", &home), None);
        assert_eq!(worktree_gone("relative/path", &home), None);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
