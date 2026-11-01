//! GH #508 (`devswarm.skipDeadChildren`): the ONE definition of a dead child. Everything here is positive proof; anything unprovable
//! keeps the reminder.
//!
//! * dead = ARCHIVED (anti-hall's marker or the app) AND the worktree provably gone ([`worktree_gone`]). A worktree that is merely
//!   absent never makes a child dead.
//! * the unread counts of the summary are NOT touched: each reminder check filters dead rows itself (the script, through `piRow`).
use crate::defaults;
use crate::meshw::common::Inv;
use std::path::Path;

/// Whether the switch `devswarm.skipDeadChildren` is on. Off (the default) keeps every nudge as it was.
pub(crate) fn skip_dead_on(inv: &Inv) -> bool {
    crate::checks::guardkit::settings::get_bool(&inv.settings(), defaults::raw("devswarm_parent.sw_skip_dead"))
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
