//! The settings and path helpers the native `devswarm wake-directive` verb reads (`meshw`). The two checks that used this module
//! (`devswarm-child-role`, `devswarm-parent-gate`) decide in plugin scripts (D88), so no check lives here any more.

use crate::checks::git::util::{Settings, posix_normalize};
use crate::defaults;
use crate::reqenv::RequestEnv;

pub mod settings;
pub mod text;

/// The home directory of the settings reads and the file paths, when it is one this check can use exactly as Node
/// does: `HOME` set, absolute, already normalized (Node joins paths lexically), and not the real home under a test
/// marker (where the Node settings reader refuses).
pub(crate) fn usable_settings(env: &RequestEnv) -> Option<Settings> {
    let home = env.get(defaults::env_name("home"))?;
    if !home.starts_with('/') || posix_normalize(home) != home {
        return None;
    }
    let marked = defaults::list("devswarm_role.test_markers").iter().any(|m| env.get(m).is_some_and(|v| !v.is_empty()));
    let escape = env.get(defaults::text("devswarm_role.real_home_escape")).is_some_and(|v| !v.is_empty());
    if marked && !escape && passwd_home().is_none_or(|real| posix_normalize(&real).trim_end_matches('/') == posix_normalize(home).trim_end_matches('/')) {
        return None;
    }
    Some(Settings::from_env(env))
}

/// The home directory the password database names for this user (`os.userInfo().homedir`).
fn passwd_home() -> Option<String> {
    // SAFETY: `getpwuid` returns null or a pointer to a static record; the directory is copied out before any other call.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr((*pw).pw_dir).to_str().ok().map(str::to_string)
    }
}

/// The real path of the plugin root's parent of `hooks`, which is where a Node hook's `path.join(__dirname, '..')` points.
pub(crate) fn node_root(plugin_root: &str) -> Option<String> {
    let hooks = std::fs::canonicalize(std::path::Path::new(plugin_root).join(defaults::text("devswarm_role.hooks_dir"))).ok()?;
    Some(hooks.parent()?.to_str()?.to_string())
}
