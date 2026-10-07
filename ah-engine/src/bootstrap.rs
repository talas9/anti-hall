//! Finding the configuration (D17, amended): the only facts the binary holds about it.
//!
//! The engine carries no settings, tables or messages; it reads them from the plugin's files at run time. To read the
//! first file it must know where the plugin is, and no file can say that about itself, so the handful of names below are
//! the one fixed layout the binary knows: where, relative to the plugin root, the defaults index lives, which environment
//! variables name the plugin root, and where the validated snapshot cache (see [`crate::defaults`]) is written.
//!
//! # Where the plugin root comes from (first hit wins)
//!
//! 1. `AH_ENGINE_PLUGIN_ROOT`: the reliability wrapper exports it from its own location, so it is the plugin that is
//!    actually running; operators and tests can set it too.
//! 2. `CLAUDE_PLUGIN_ROOT`, then `PLUGIN_ROOT`: the variables the hosts export to hook commands.
//! 3. The root recorded in the snapshot cache by the last successful load (an invocation with no environment at all,
//!    such as `ah-engine status` from a terminal, still finds the plugin the daemon runs).
//! 4. A development checkout: walking up from the executable until a directory holds
//!    `plugins/anti-hall/engine/defaults/index.toml` (a `cargo build` tree inside the repository).
//!
//! `AH_ENGINE_PLUGIN_ROOT`, when set, is an explicit choice: if it has no `index.toml` the load fails (it is not replaced by
//! another plugin). The host variables count only when their root has one. If the chosen root then fails validation the load
//! fails too; later candidates are NOT tried, so a broken edit is never silently replaced by older files.
use std::path::{Path, PathBuf};

/// The defaults directory, relative to the plugin root.
pub const DEFAULTS_DIR: &str = "engine/defaults";
/// The index file inside the defaults directory.
pub const INDEX_FILE: &str = "index.toml";
/// Environment variables naming the plugin root, in order of precedence.
pub const ROOT_ENVS: &[&str] = &["AH_ENGINE_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT", "PLUGIN_ROOT"];
/// The snapshot cache file inside the state directory.
pub const CACHE_FILE: &str = "defaults.cache";
/// The last-resort error note inside the state directory (written when no defaults could be loaded, so no log path exists).
pub const ERROR_FILE: &str = "defaults.error";
/// The exit code that tells the reliability wrapper "the engine cannot answer, run the Node hooks" (the wrapper's protocol; it equals
/// the shipped `dispatch.defer_exit`, which a test keeps true). It is used when no defaults can be loaded, i.e. exactly when no
/// shipped setting can be read.
pub const UNAVAILABLE_EXIT: i32 = 75;
/// The state directory override (the same variable `env.dir` names in the defaults; a test keeps them equal).
const STATE_ENV: &str = "AH_ENGINE_DIR";
/// The home variable and the state directory below it (the same as `paths.base_dir` / `paths.state_dir`; a test keeps them equal).
const HOME_ENV: &str = "HOME";
const STATE_REL: [&str; 2] = [".anti-hall", "ah-engine"];

/// The engine state directory, before any defaults are loaded.
pub fn state_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os(STATE_ENV).filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    let home = std::env::var_os(HOME_ENV).filter(|h| !h.is_empty())?;
    Some(STATE_REL.iter().fold(PathBuf::from(home), |p, s| p.join(s)))
}

/// The snapshot cache path.
pub fn cache_path() -> Option<PathBuf> {
    state_dir().map(|d| d.join(CACHE_FILE))
}

/// True when `root` holds a defaults index.
pub fn has_index(root: &Path) -> bool {
    index_path(root).is_file()
}

/// The index file of the plugin at `root`.
pub fn index_path(root: &Path) -> PathBuf {
    root.join(DEFAULTS_DIR).join(INDEX_FILE)
}

/// The plugin root the environment names, if any: `AH_ENGINE_PLUGIN_ROOT` is an explicit choice, so when it is set it decides
/// (`Some(root)` whether or not the root is any good, so a wrong value is reported rather than silently replaced by a
/// different plugin); the host variables count only when their root holds a defaults index (a host may export its root for
/// an older plugin that has none).
pub fn env_root() -> Option<PathBuf> {
    if let Some(own) = std::env::var_os(ROOT_ENVS[0]).filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(own));
    }
    ROOT_ENVS[1..].iter().filter_map(std::env::var_os).filter(|v| !v.is_empty()).map(PathBuf::from).find(|r| has_index(r))
}

/// The first plugin root in the lookup order above. `cache_root` is the root the cache records. `None` when no candidate
/// holds a defaults index (or the explicit `AH_ENGINE_PLUGIN_ROOT` does not).
pub fn locate_root(cache_root: Option<&Path>) -> Option<PathBuf> {
    if let Some(r) = env_root() {
        return has_index(&r).then_some(r);
    }
    cache_root.map(Path::to_path_buf).filter(|r| has_index(r)).or_else(dev_checkout)
}

fn dev_checkout() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).take(8).map(|a| a.join("plugins").join("anti-hall")).find(|r| has_index(r))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_state_dir_matches_the_shipped_path_settings() {
        // single-threaded env mutation is fine: these names are not read by another in-process test
        let home = crate::defaults::env_var("home");
        assert_eq!(crate::defaults::env_name("dir"), STATE_ENV);
        assert_eq!(crate::defaults::env_name("home"), HOME_ENV);
        assert_eq!(crate::defaults::text("paths.base_dir"), STATE_REL[0]);
        assert_eq!(crate::defaults::text("paths.state_dir"), STATE_REL[1]);
        assert!(home.is_none() || state_dir().is_some() || crate::defaults::env_var("dir").is_some());
        assert_eq!(crate::defaults::num("dispatch.defer_exit") as i32, UNAVAILABLE_EXIT);
    }

    #[test]
    fn the_dev_checkout_is_found_from_the_test_binary() {
        assert!(dev_checkout().is_some(), "the cargo target tree sits inside the repository");
    }
}
