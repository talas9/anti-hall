//! The project root of a working directory: `repoRoot(cwd)` of `hooks/lib/handover-find.js`.
//!
//! Node asks `companion/lib/identity.js` `resolveContext` for the checkout that owns `cwd` (the nearest ancestor holding a
//! `.git` entry) and falls back to `cwd` itself when there is none, when the path is gone, when the `.git` entry cannot
//! be read, when `cwd` sits inside the git directory, or when the checkout is the home directory. The submodule and
//! worktree climbing of `resolveContext` only changes other fields (`worktreeRoot`, the keys), never `toplevel`, so this
//! answers from the file system alone and never runs git.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::jsre;
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use std::path::{Path, PathBuf};

/// The checkout (git directory, private or not) behind a `<root>/.git` entry: the real path of the git directory.
/// `None` when the entry cannot be classified (Node's `gitdirOf` answers null).
fn git_dir_of(top: &Path) -> Option<PathBuf> {
    let dot = top.join(defaults::text("taskkit.git_entry"));
    let meta = std::fs::symlink_metadata(&dot).ok()?;
    if meta.is_dir() {
        return std::fs::canonicalize(&dot).ok();
    }
    static RE: crate::defaults::Cache<regex::Regex> = crate::defaults::Cache::new();
    let re = RE.get_or_init(|| jsre::compile_multiline(defaults::text("taskkit.gitdir_line"), false));
    let text = String::from_utf8_lossy(&std::fs::read(&dot).ok()?).into_owned();
    let target = re.captures(&text)?.get(1)?.as_str().to_string();
    if target.is_empty() {
        return None;
    }
    let joined = if is_absolute(&target) { target } else { format!("{}/{target}", top.to_string_lossy()) };
    let g = std::fs::canonicalize(resolve_abs(&joined)).ok()?;
    g.is_dir().then_some(g)
}

/// `under(child, parent)` of identity.js.
fn under(child: &str, parent: &str) -> bool {
    child == parent || child.strip_prefix(parent).is_some_and(|r| r.starts_with('/'))
}

/// The nearest ancestor of `dir` (inclusive) holding a `.git` entry of any kind.
fn nearest_dot_git(dir: &Path) -> Option<PathBuf> {
    let name = defaults::text("taskkit.git_entry");
    dir.ancestors().find(|d| std::fs::symlink_metadata(d.join(name)).is_ok()).map(Path::to_path_buf)
}

/// `repoRoot(cwd)` for an absolute `cwd`, with `home` as the request's home directory. `None` when the answer would depend
/// on the Node process's own working directory (a relative `cwd`) or the home directory is unknown: the caller defers.
pub fn repo_root(cwd: &str, home: &str) -> Option<String> {
    if cwd.is_empty() || !is_absolute(cwd) || home.is_empty() {
        return None;
    }
    let abs = resolve_abs(cwd);
    let Ok(real) = std::fs::canonicalize(&abs) else { return Some(cwd.to_string()) };
    let Some(top) = nearest_dot_git(&real) else { return Some(cwd.to_string()) };
    let Some(g) = git_dir_of(&top) else { return Some(cwd.to_string()) };
    let (real_s, g_s, top_s) = (real.to_string_lossy(), g.to_string_lossy(), top.to_string_lossy().into_owned());
    if under(&real_s, &g_s) {
        return Some(cwd.to_string());
    }
    let real_home = std::fs::canonicalize(home).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| home.to_string());
    if top_s == real_home {
        return Some(cwd.to_string());
    }
    Some(top_s)
}

/// True when the git directory's common config names a work tree (`core.worktree`): then Node climbs to the checkout that
/// config names, which the engine does not follow.
fn common_dir_names_worktree(g: &Path) -> bool {
    let Some(c) = std::fs::read_to_string(g.join("commondir")).ok().map(|t| crate::checks::guardkit::text::js_trim(&t).to_string()).filter(|t| !t.is_empty())
    else {
        return false;
    };
    let common_dir = std::fs::canonicalize(resolve_abs(&format!("{}/{c}", g.to_string_lossy()))).unwrap_or_else(|_| g.to_path_buf());
    std::fs::read(common_dir.join("config")).map(|b| core_section_names_worktree(&String::from_utf8_lossy(&b))).unwrap_or(false)
}

/// True when the first `[core]` section of a git config holds a `worktree = <value>` line (`coreWorktreeOf` of identity.js).
/// Where the key is present but its value does not resolve, Node does not climb; the engine still reports it present, which
/// only means more deferrals.
fn core_section_names_worktree(cfg: &str) -> bool {
    let section_start = |l: &str| js_trim(l).starts_with('[');
    let mut lines = cfg.split('\n').map(|l| l.trim_end_matches('\r'));
    if !lines.any(|l| js_trim(l) == "[core]") {
        return false;
    }
    for l in lines {
        if section_start(l) {
            break;
        }
        let t = js_trim(l);
        if let Some(rest) = t.strip_prefix("worktree")
            && let Some(value) = js_trim(rest).strip_prefix('=')
            && !js_trim(value).is_empty()
        {
            return true;
        }
    }
    false
}

/// `sessionProjectRoot(cwd)` for an absolute `cwd`: the outermost superproject's work tree (`ctx.worktreeRoot`). Where no
/// checkout encloses the one at `cwd`, that is the checkout itself, as for [`repo_root`]. A checkout inside another one
/// (a submodule or a nested repository) needs git or the superproject's index to classify, and a `core.worktree` setting makes
/// Node climb elsewhere: both return `None` and the caller defers.
pub fn session_project_root(cwd: &str, home: &str) -> Option<String> {
    if cwd.is_empty() || !is_absolute(cwd) || home.is_empty() {
        return None;
    }
    let abs = resolve_abs(cwd);
    let Ok(real) = std::fs::canonicalize(&abs) else { return Some(cwd.to_string()) };
    let Some(top) = nearest_dot_git(&real) else { return Some(cwd.to_string()) };
    let Some(g) = git_dir_of(&top) else { return Some(cwd.to_string()) };
    let (real_s, g_s) = (real.to_string_lossy(), g.to_string_lossy());
    if under(&real_s, &g_s) {
        return Some(cwd.to_string());
    }
    let dot_is_file = std::fs::symlink_metadata(top.join(defaults::text("taskkit.git_entry"))).is_ok_and(|m| !m.is_dir());
    if top.parent().is_some_and(|p| nearest_dot_git(p).is_some()) || (dot_is_file && common_dir_names_worktree(&g)) {
        return None;
    }
    let real_home = std::fs::canonicalize(home).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| home.to_string());
    let top_s = top.to_string_lossy().into_owned();
    if top_s == real_home { Some(cwd.to_string()) } else { Some(top_s) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_worktree_key_in_the_core_section_counts() {
        let cases: &[(&str, bool)] = &[
            ("[core]\n\tbare = false\n", false),
            ("[core]\n\tworktree = ../sub\n", true),
            ("[core]\n  worktree=../sub  \n[user]\n\tname = x\n", true),
            ("[user]\n\tname = x\n[core]\n\tworktree = /a\n", true),
            ("[core]\n\tbare = false\n[extensions]\n\tworktree = /a\n", false),
            ("[branch \"worktree\"]\n\tremote = origin\n", false),
            ("[core]\n\tworktreeConfig = true\n", false),
            ("[core]\n\tworktree =\n", false),
            ("[user]\n\tworktree = /a\n", false),
            ("", false),
        ];
        for (cfg, want) in cases {
            assert_eq!(core_section_names_worktree(cfg), *want, "{cfg:?}");
        }
    }

    #[test]
    fn a_checkout_encloses_its_subdirectories_and_a_missing_directory_is_its_own_root() {
        let base = std::env::temp_dir().join(format!("ah-root-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&base)); // keep: cleanup that raced; an absent file is the goal state
        std::fs::create_dir_all(base.join("repo/.git")).unwrap();
        std::fs::create_dir_all(base.join("repo/src/deep")).unwrap();
        let real = std::fs::canonicalize(&base).unwrap();
        let home = "/nonexistent-home";
        let deep = real.join("repo/src/deep");
        let top = real.join("repo");
        assert_eq!(repo_root(deep.to_str().unwrap(), home).as_deref(), top.to_str());
        assert_eq!(session_project_root(deep.to_str().unwrap(), home).as_deref(), top.to_str());
        let gone = real.join("gone/dir");
        assert_eq!(repo_root(gone.to_str().unwrap(), home).as_deref(), gone.to_str());
        assert_eq!(repo_root("relative", home), None, "a relative cwd resolves against Node's own directory");
        let inside_git = real.join("repo/.git");
        assert_eq!(repo_root(inside_git.to_str().unwrap(), home).as_deref(), inside_git.to_str(), "a directory inside the git directory is not a work tree");
        crate::discard::harmless(std::fs::remove_dir_all(&base)); // keep: cleanup that raced; an absent file is the goal state
    }
}
