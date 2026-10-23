//! The app's own id of a workspace, found by its worktree path.
//!
//! A workspace the app created has one id (a UUID) in the app database (`builders.id`), and the worktree path is the only thing
//! a spawn knows about it right after the create. A registry row keyed by the `primary-<hash>` label of that path is a label, not
//! a workspace id: the roster shows it as a phantom and `archive` has nothing to act on. This module finds the real id, read-only
//! (the app database is opened `SQLITE_OPEN_READ_ONLY` through [`crate::devswarm_rt::sources::read_app`]).
//!
//! A path that matches no builder, an archived builder, or more than one live builder gives no id: the caller never guesses.
use crate::defaults;
use crate::devswarm_rt::sources::{self, AppBuilder};
use crate::meshw::ident::{self, Env};
use crate::meshw::idlock::is_safe_id;
use std::path::Path;

/// What one look for a worktree's app id found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Lookup {
    /// There is no app database to ask (no app installed, or switched off): nothing to wait for.
    NoApp,
    /// The app database is there but names no single live workspace for the path (yet).
    Missing,
    /// The one live, non-primary builder whose worktree is the path.
    Found(String),
}

/// `normPath`: absolute, symlinks resolved when the path exists.
fn norm(p: &str) -> String {
    let r = ident::resolve_abs(p);
    ident::realpath(&r).unwrap_or(r)
}

/// The builder of `worktree` among `builders`: non-primary, not archived, a safe id, and the only one (or the only active one).
pub fn pick<'a>(builders: &'a [AppBuilder], worktree: &str) -> Option<&'a AppBuilder> {
    if !worktree.starts_with('/') {
        return None;
    }
    let want = norm(worktree);
    let primary = defaults::text("devswarm_recon.app_primary_type");
    let hits: Vec<&AppBuilder> = builders
        .iter()
        .filter(|b| b.builder_type.as_deref() != Some(primary) && is_safe_id(&b.id))
        .filter(|b| !(b.active == Some(false) && b.hidden == Some(true)))
        .filter(|b| b.worktree.as_deref().is_some_and(|w| w.starts_with('/') && norm(w) == want))
        .collect();
    match hits.len() {
        0 => None,
        1 => Some(hits[0]),
        _ => {
            let live: Vec<&AppBuilder> = hits.iter().filter(|b| b.active == Some(true)).copied().collect();
            (live.len() == 1).then(|| live[0])
        }
    }
}

/// One look: `builders.id` for `worktree`.
pub fn lookup(home: &Path, env: &Env, worktree: &str) -> Lookup {
    let Some(file) = ident::app_db_path(home, env) else { return Lookup::NoApp };
    if !Path::new(&file).is_file() {
        return Lookup::NoApp;
    }
    // an unreadable database (locked beyond the busy timeout, unexpected shape) is "not yet", not "no app"
    let Some(app) = sources::read_app(Path::new(&file)) else { return Lookup::Missing };
    match pick(&app.builders, worktree) {
        Some(b) => Lookup::Found(b.id.clone()),
        None => Lookup::Missing,
    }
}

/// [`lookup`] with a bounded retry and growing waits (`devswarm_cli.sp_uuid_*`); stops at once on `Found` or `NoApp`.
pub fn lookup_with_retry(home: &Path, env: &Env, worktree: &str) -> Lookup {
    let attempts = defaults::num("devswarm_cli.sp_uuid_attempts").max(1);
    let growth = defaults::num("devswarm_cli.sp_uuid_backoff_pct").max(100);
    let cap = defaults::num("devswarm_cli.sp_uuid_max_interval_ms");
    let mut wait = defaults::num("devswarm_cli.sp_uuid_interval_ms");
    let mut last = Lookup::Missing;
    for i in 0..attempts {
        last = lookup(home, env, worktree);
        if last != Lookup::Missing || i + 1 == attempts {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(wait.min(cap)));
        wait = wait.saturating_mul(growth) / 100;
    }
    last
}
