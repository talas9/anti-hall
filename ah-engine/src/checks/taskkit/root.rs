//! The project root of a working directory: `repoRoot(cwd)` of `hooks/lib/handover-find.js`.
//!
//! Node asks `companion/lib/identity.js` `resolveContext` for the checkout that owns `cwd` (the nearest ancestor holding a
//! `.git` entry) and falls back to `cwd` itself when there is none, when the path is gone, when the `.git` entry cannot
//! be read, when `cwd` sits inside the git directory, or when the checkout is the home directory. The submodule and
//! worktree climbing of `resolveContext` only changes other fields (`worktreeRoot`, the keys), never `toplevel`, so this
//! answers from the file system alone and never runs git.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::defaults;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The checkout (git directory, private or not) behind a `<root>/.git` entry: the real path of the git directory.
/// `None` when the entry cannot be classified (Node's `gitdirOf` answers null).
fn git_dir_of(top: &Path) -> Option<PathBuf> {
    let dot = top.join(defaults::text("taskkit.git_entry"));
    let meta = std::fs::symlink_metadata(&dot).ok()?;
    if meta.is_dir() {
        return std::fs::canonicalize(&dot).ok();
    }
    static RE: OnceLock<regex::Regex> = OnceLock::new();
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
    std::fs::read(common_dir.join("config")).map(|b| String::from_utf8_lossy(&b).to_lowercase().contains("worktree")).unwrap_or(false)
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
