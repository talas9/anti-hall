//! The environment and working directory of the daemon (`ah-engine serve`).
//!
//! A daemon outlives the session whose hook started it and serves every later session, so what it inherited from that
//! hook (the session id, the role, the DevSwarm workspace variables, `CLAUDE_PROJECT_DIR`, the git variables of the hook's
//! repository, the hook's working directory) would be read for all of them: the first session to start a daemon would
//! own it. Per-session values reach the checks only with each request (`request_env`, D76). At start-up, before any
//! thread exists, the daemon therefore drops every variable that is not on `daemon.spawn_env_allow` (or is on
//! `daemon.spawn_env_deny`) and leaves a working directory that may be an archived worktree. It is done in the daemon
//! itself, not in its spawner, so every way of starting one (the hook client, the update script, a service unit) gets it.
use std::path::PathBuf;

use crate::defaults;

/// Whether `name` matches one entry of a `daemon.spawn_env_*` list (a trailing `*` matches a prefix).
fn listed(list: &[&str], name: &str) -> bool {
    list.iter().any(|e| e.strip_suffix('*').map_or(*e == name, |prefix| name.starts_with(prefix)))
}

/// Whether the daemon keeps the variable `name`: on `daemon.spawn_env_allow` and not on `daemon.spawn_env_deny`.
pub fn kept(name: &str) -> bool {
    listed(&defaults::list("daemon.spawn_env_allow"), name) && !listed(&defaults::list("daemon.spawn_env_deny"), name)
}

/// The directory the daemon runs in: `home` when it is a directory, else `daemon.spawn_cwd_fallback`.
pub fn cwd(home: Option<PathBuf>) -> PathBuf {
    home.filter(|h| h.is_dir()).unwrap_or_else(|| PathBuf::from(defaults::text("daemon.spawn_cwd_fallback")))
}

/// Drop the variables the daemon must not keep and move it to [`cwd`]. Call once, first thing in `serve`, while the process
/// is still single-threaded. Returns the names it removed.
pub fn sanitize() -> Vec<String> {
    let dropped: Vec<String> = std::env::vars_os().filter_map(|(k, _)| k.into_string().ok()).filter(|k| !kept(k)).collect();
    for name in &dropped {
        // SAFETY: the daemon has started no thread yet (this runs at the top of `serve`), so no other thread can be reading the
        // environment while it is modified.
        unsafe { std::env::remove_var(name) };
    }
    crate::discard::harmless(std::env::set_current_dir(cwd(defaults::env_var("home").map(PathBuf::from)))); // keep: the old directory stays, and nothing in the daemon depends on it
    dropped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_session_and_role_variables_are_dropped_and_the_account_ones_kept() {
        for gone in [
            "CLAUDE_CODE_SESSION_ID",
            "CLAUDE_PROJECT_DIR",
            "DEVSWARM_SOURCE_BRANCH",
            "DEVSWARM_BUILDER_ID",
            "ANTIHALL_ROLE",
            "ANTIHALL_SESSION_ID",
            "ANTIHALL_DEVSWARM_SOURCE_BRANCH",
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
        ] {
            assert!(!kept(gone), "{gone} must not survive into the daemon");
        }
        for stay in [
            "HOME",
            "PATH",
            "TMPDIR",
            "LC_ALL",
            "XDG_CONFIG_HOME",
            "SSH_AUTH_SOCK",
            "GH_TOKEN",
            "AH_ENGINE_DIR",
            "AH_ENGINE_ALLOCATOR",
            "MALLOC_CONF",
            "CLAUDE_PLUGIN_ROOT",
            "ANTIHALL_JEV",
        ] {
            assert!(kept(stay), "{stay} is needed by the daemon");
        }
    }

    #[test]
    fn a_missing_home_falls_back() {
        assert_eq!(cwd(Some(PathBuf::from("/definitely/not/a/dir"))), PathBuf::from(defaults::text("daemon.spawn_cwd_fallback")));
        assert_eq!(cwd(None), PathBuf::from(defaults::text("daemon.spawn_cwd_fallback")));
        let tmp = std::env::temp_dir();
        assert_eq!(cwd(Some(tmp.clone())), tmp);
    }
}
