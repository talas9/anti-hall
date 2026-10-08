//! The gate of the DevSwarm Primary dispatch-tier text, answered natively: `hooks/lib/primary-tier.js`
//! `primaryTierTextOn` and `hooks/lib/dispatch-tier.js` `noWorkspaceRepo`.
//!
//! The text is withheld unless DevSwarm is active, this session is not a child workspace, `devswarm.dispatchTierText` is
//! on, and the repo does not forbid workspaces for real work: neither the configured list (`jev.dispatchTierNoWorkspaceRepos`)
//! names the working directory, nor a `CLAUDE.md` / `AGENTS.md` between the working directory and the repository root
//! carries the rule. `None` means the answer depends on something this port does not reproduce (a relative or absent
//! working directory, a repository layout the identity resolver cannot classify): the caller defers.
//!
//! The patterns, file names, climb limit and setting entries live in the plugin's defaults, not here.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::primary_possible;
use crate::checks::git::util::{Settings, posix_dirname, resolve};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::settings::{get_bool, get_string};
use crate::checks::jsport::{fsx, ident};
use crate::checks::taskkit::jsval::truthy;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// `primaryTierTextOn(env, payload.cwd)`.
pub(crate) fn tier_text_on(st: &Settings, env: &RequestEnv, payload: &Value) -> Option<bool> {
    if !primary_possible(st) {
        return Some(false);
    }
    // `path.resolve(cwd || process.cwd())`: an absent working directory is the hook's own (unknown here), a truthy
    // non-string throws and primaryTierTextOn fails open to false
    let cwd = match payload.get("cwd") {
        Some(v) if truthy(v) => match v {
            Value::String(s) => s.as_str(),
            _ => return Some(false),
        },
        _ => return None,
    };
    if !cwd.starts_with('/') || st.home.is_empty() {
        return None;
    }
    no_workspace_repo(cwd, st, env).map(|forbidden| !forbidden)
}

/// `noWorkspaceRepo(cwd)`.
fn no_workspace_repo(cwd: &str, st: &Settings, env: &RequestEnv) -> Option<bool> {
    let dir0 = resolve(cwd, "", "/");
    let list = get_string(st, defaults::raw("verify_first.sw_no_ws_repos"));
    let entries: Vec<&str> = list.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
    if entries.contains(&"*") {
        return Some(true);
    }
    for e in entries {
        let hit = if e.starts_with('/') { dir0 == e || dir0.starts_with(&format!("{e}/")) } else { dir0.split('/').any(|seg| seg == e) };
        if hit {
            return Some(true);
        }
    }
    if !get_bool(st, defaults::raw("verify_first.sw_no_ws_detect")) {
        return Some(false);
    }
    repo_docs_match(&dir0, env)
}

/// `repoDocsMatch(dir0, home, NO_WS_RE)`.
fn repo_docs_match(dir0: &str, env: &RequestEnv) -> Option<bool> {
    let ctx = ident::resolve_context(dir0, true, env);
    if ctx.unsure {
        return None;
    }
    let re = jsre::compile(defaults::text("verify_first.no_ws_pattern"), true);
    let mut dir = dir0.to_string();
    for _ in 0..defaults::num("verify_first.no_ws_levels") as usize {
        for f in defaults::list("verify_first.no_ws_docs") {
            if fsx::read_utf8(&format!("{}/{f}", dir.trim_end_matches('/'))).is_some_and(|t| re.is_match(&t)) {
                return Some(true);
            }
        }
        if ctx.worktree_root.as_deref() == Some(dir.as_str()) {
            break;
        }
        let up = posix_dirname(&dir);
        if up == dir {
            break;
        }
        dir = up;
    }
    Some(false)
}
