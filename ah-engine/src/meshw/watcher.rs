//! Whether a live wake-watch Monitor covers a workspace: the ONE check `inbox tick` (`watcherArmed`) and the agent tracker share, a
//! port of `watcherLockLive` / `watcherLiveForWorkspace` of `companion/lib/devswarm-wake-watch.js`.
//!
//! A lock is live when it is fresh (`mesh_write.wake_lock_stale_ms`) and its pid is not provably gone. A workspace is covered by
//! the lock under its own id, or by the live lock of another registered row on the SAME checkout: a Monitor armed under the
//! DevSwarm app's own row id for a Primary's checkout is still the watcher covering it. An unreadable lock is not live.
use crate::checks::guardkit::ojson::OVal;
use crate::defaults;
use crate::meshw::ident::R;
use crate::meshw::idlock::devswarm_root;
use std::path::{Path, PathBuf};

/// The lock file of a watcher armed under `id`.
pub fn lock_file(home: &Path, id: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_locks")).join(format!(
        "{}{id}{}",
        defaults::text("mesh_write.wake_lock_prefix"),
        defaults::text("mesh_write.wake_lock_suffix")
    ))
}

/// `watcherLockLive(home, id, now)`: the lock under exactly `id` is fresh and its pid is not provably gone.
pub fn lock_live(home: &Path, id: &str, now: i64) -> R<bool> {
    let Ok(bytes) = std::fs::read(lock_file(home, id)) else { return Ok(false) };
    let Some(lock @ OVal::Obj(_)) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { return Ok(false) };
    let ts = crate::meshw::tick::js_number(lock.get("ts"))?;
    let fresh = ts.is_finite() && (now as f64 - ts) <= defaults::num("mesh_write.wake_lock_stale_ms") as f64;
    let alive = match lock.get("pid") {
        Some(OVal::Num(p)) if p.is_finite() && p.fract() == 0.0 => crate::meshw::tick::pid_alive(*p),
        _ => None,
    };
    Ok(fresh && alive != Some(false))
}

/// The same no-live-children decision used by wake-watch and inbox tick.
pub fn idle_for_workspace(home: &Path, id: &str, st: &crate::checks::git::util::Settings) -> bool {
    let Some(d) = crate::meshw::ident::read_descriptor(home, id) else { return false };
    let Some(OVal::Str(scope)) = d.get(defaults::text("mesh_write.field_worktree_path")) else { return false };
    if scope.is_empty() { return false; }
    let p = crate::wakew::who::Proc {
        home: home.to_path_buf(), cwd: scope.clone(), env: st.env.clone(), st: st.clone(),
        root: defaults::root().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    };
    matches!(crate::wakew::arch::idle_skip(&p), Ok(crate::wakew::arch::IdleSkip::Applies))
}

/// What [`live_for_workspace`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Armed {
    /// A live watcher covers the workspace.
    pub armed: bool,
    /// It was found through another row of the same checkout, not the workspace's own id.
    pub by_checkout: bool,
}

/// `watcherLiveForWorkspace(home, id, now)`: the workspace's own lock, else the live lock of any other registered row whose
/// checkout is the same directory (compared by resolved and real path, as `realFormsOf` does). A row with no session id counts
/// on both sides: it is the app's own row for the checkout.
pub fn live_for_workspace(home: &Path, id: &str, now: i64) -> R<Armed> {
    if lock_live(home, id, now)? {
        return Ok(Armed { armed: true, by_checkout: false });
    }
    let rows = crate::wakew::who::read_checkout_rows(home); // rows without a session too: the app's own row covers the Primary's checkout
    let text = |d: &crate::checks::jsport::json::J, k: &str| crate::wakew::who::str_member(d, k);
    let Some(own) = rows.iter().find(|d| text(d, "id").as_deref() == Some(id)) else { return Ok(Armed { armed: false, by_checkout: false }) };
    let Some(own_wt) = text(own, "worktreePath") else { return Ok(Armed { armed: false, by_checkout: false }) };
    let own_forms = crate::wakew::who::real_forms(&own_wt, "/");
    for d in &rows {
        let (Some(other), Some(wt)) = (text(d, "id"), text(d, "worktreePath")) else { continue };
        if other == id || crate::wakew::who::real_forms(&wt, "/").is_disjoint(&own_forms) {
            continue;
        }
        if lock_live(home, &other, now)? {
            return Ok(Armed { armed: true, by_checkout: true });
        }
    }
    Ok(Armed { armed: false, by_checkout: false })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("ah-watcher-{}-{tag}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: cleanup that raced; an absent directory is the goal state
        std::fs::create_dir_all(devswarm_root(&home).join(defaults::text("mesh_write.dir_workspaces"))).unwrap();
        std::fs::create_dir_all(devswarm_root(&home).join(defaults::text("mesh_write.dir_locks"))).unwrap();
        home
    }

    fn descriptor(home: &Path, id: &str, worktree: &str) {
        let f = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}.json"));
        std::fs::write(f, format!(r#"{{"id":"{id}","worktreePath":"{worktree}","sessionId":"s-{id}"}}"#)).unwrap();
    }

    fn lock(home: &Path, id: &str, ts: i64) {
        std::fs::write(lock_file(home, id), format!(r#"{{"pid":{},"ts":{ts}}}"#, std::process::id())).unwrap();
    }

    #[test]
    fn a_lock_of_another_row_on_the_same_checkout_arms_the_workspace() {
        // #181: descriptors A and B share one worktree; only B has a (fresh, live) lock
        let home = scratch("checkout");
        let (wt, other) = (home.join("wt").to_string_lossy().into_owned(), home.join("elsewhere").to_string_lossy().into_owned());
        std::fs::create_dir_all(&wt).unwrap();
        descriptor(&home, "A", &wt);
        descriptor(&home, "B", &wt);
        descriptor(&home, "C", &other);
        lock(&home, "B", 1_000_000);
        let a = live_for_workspace(&home, "A", 1_000_500).unwrap();
        assert_eq!(a, Armed { armed: true, by_checkout: true }, "A is covered by B's lock");
        assert_eq!(live_for_workspace(&home, "B", 1_000_500).unwrap(), Armed { armed: true, by_checkout: false }, "B's own lock");
        assert_eq!(live_for_workspace(&home, "C", 1_000_500).unwrap(), Armed { armed: false, by_checkout: false }, "another checkout is not covered");
        let stale = live_for_workspace(&home, "A", 1_000_000 + defaults::num("mesh_write.wake_lock_stale_ms") as i64 + 1).unwrap();
        assert!(!stale.armed, "a stale lock covers nobody");
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: test cleanup; an absent directory is the goal state
    }

    #[test]
    fn the_app_row_without_a_session_is_covered_by_the_primarys_lock_on_its_checkout() {
        // SkyCrew 2026-10-22: the DevSwarm app's own row for a Primary's checkout has `sessionId: null`; the Primary's row (with the
        // session) holds the live lock. The tracker asks about the app row and said "no Monitor wake-watch covers this workspace".
        let home = scratch("sessionless");
        let wt = home.join("wt").to_string_lossy().into_owned();
        std::fs::create_dir_all(&wt).unwrap();
        descriptor(&home, "primary-x", &wt);
        let f = devswarm_root(&home).join(defaults::text("mesh_write.dir_workspaces")).join("app-row.json");
        std::fs::write(f, format!(r#"{{"id":"app-row","worktreePath":"{wt}","sessionId":null}}"#)).unwrap();
        lock(&home, "primary-x", 1_000_000);
        let a = live_for_workspace(&home, "app-row", 1_000_500).unwrap();
        assert_eq!(a, Armed { armed: true, by_checkout: true }, "the app row is covered by the Primary's lock");
        // a sessionless row holding the live lock covers the Primary's row the same way
        lock(&home, "app-row", 1_000_000);
        crate::discard::harmless(std::fs::remove_file(lock_file(&home, "primary-x"))); // keep: the lock may already be gone
        assert!(live_for_workspace(&home, "primary-x", 1_000_500).unwrap().armed, "a live lock under the app row covers the Primary");
        crate::discard::harmless(std::fs::remove_dir_all(home)); // keep: test cleanup; an absent directory is the goal state
    }
}
