//! The per-workspace-id advisory lock Node's mesh writers serialize on (`scripts/devswarm-lib/core.js` `acquireIdLock` /
//! `withIdLock` over `companion/lib/recovery.js` `acquireLock`).
//!
//! The lock file is `<home>/.anti-hall/devswarm/locks/<id>.lock`, published and reclaimed with the `lock.js` protocol
//! (`guardkit::nodelock`): a JSON owner record linked into place, a dead holder taken over at once (`stealDead`), any
//! holder older than the stale limit taken over, a takeover serialized by the `.reclaim` marker. One acquire attempt is
//! made per step (Node calls `lock.acquire` with its defaults: no internal wait), every `mesh_write.id_lock_step_ms` until
//! `mesh_write.id_lock_budget_ms` has passed; then the caller reports `lockBusy` and writes nothing, as Node does.
use crate::checks::guardkit::nodelock;
use crate::defaults;
use std::path::{Path, PathBuf};

/// `isSafeId(id)` (`companion/lib/liveness.js`): non-empty, not `.`/`..`, no `..`, only `[A-Za-z0-9._-]`.
pub fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id != "." && id != ".." && !id.contains("..") && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `<home>/.anti-hall/devswarm`.
pub fn devswarm_root(home: &Path) -> PathBuf {
    home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_devswarm"))
}

/// `lockPathFor(id, home)`.
pub fn lock_path(home: &Path, id: &str) -> PathBuf {
    devswarm_root(home).join(defaults::text("mesh_write.dir_locks")).join(format!("{id}{}", defaults::text("mesh_write.lock_suffix")))
}

fn params() -> nodelock::Params {
    nodelock::Params {
        stale_ms: defaults::num("mesh_write.id_lock_stale_ms"),
        wait_ms: 0,
        step_ms: defaults::num("mesh_write.id_lock_step_ms"),
        reclaim_stale_ms: defaults::num("mesh_write.id_lock_reclaim_stale_ms"),
        release_tries: defaults::num("mesh_write.id_lock_release_tries"),
        release_step_ms: defaults::num("mesh_write.id_lock_release_step_ms"),
        boot_slop_s: defaults::num("mesh_write.id_lock_boot_slop_s"),
        steal_dead: true,
    }
}

/// A held per-id lock; released by [`IdLock::release`].
pub struct IdLock(nodelock::Held);

impl IdLock {
    /// Release it (only while the on-disk token is still ours).
    pub fn release(self) {
        self.0.release();
    }
}

/// `acquireIdLock(id, home)`: `None` when the budget passed with a live, fresh holder (or `id` is not a safe id, which
/// Node's `lockPathFor` refuses by throwing on every attempt).
pub fn acquire(home: &Path, id: &str) -> Option<IdLock> {
    let deadline = std::time::Instant::now() + defaults::millis("mesh_write.id_lock_budget_ms");
    loop {
        if is_safe_id(id)
            && let Some(h) = nodelock::acquire(&lock_path(home, id).to_string_lossy(), params())
        {
            return Some(IdLock(h));
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(defaults::millis("mesh_write.id_lock_step_ms"));
    }
}
