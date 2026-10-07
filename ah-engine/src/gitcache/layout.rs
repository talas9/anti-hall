//! Where a repository's files are, and the signature of the ones the cached answers depend on.
//!
//! Discovery mirrors what git does from a directory: walk up to the first `.git` entry that is a repository (a
//! directory with a `HEAD`) or a `gitdir:` file (a submodule or a linked worktree), then follow `commondir` for a
//! linked worktree. Bare repositories and `GIT_DIR` are not resolved here; the caller runs git itself for those.
use super::GitCacheError;
use crate::defaults;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

/// Bytes of a signed file's content that are read (a HEAD or a loose ref is a few dozen bytes).
fn content_cap() -> usize {
    defaults::num("gitcache.content_cap_bytes") as usize
}

/// The stat fields that change when git replaces or edits a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileSig {
    dev: u64,
    ino: u64,
    size: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

/// One signed thing: a file's content, a file's stat, or a directory's stat. `None` means absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum SigItem {
    Content(Option<Vec<u8>>),
    Stat(Option<FileSig>),
}

fn stat(p: &Path) -> SigItem {
    SigItem::Stat(std::fs::metadata(p).ok().map(|m| FileSig {
        dev: m.dev(),
        ino: m.ino(),
        size: m.size(),
        mtime: (m.mtime(), m.mtime_nsec()),
        ctime: (m.ctime(), m.ctime_nsec()),
    }))
}

fn content(p: &Path) -> SigItem {
    use std::io::Read;
    SigItem::Content(std::fs::File::open(p).ok().map(|f| {
        let mut b = Vec::new();
        let _ = f.take(content_cap() as u64).read_to_end(&mut b);
        b
    }))
}

/// `name` from the environment given to the cache, and from nowhere else (D76): the daemon's own environment belongs to
/// whichever client started it, never to the request being answered.
pub(super) fn env_get(env: &[(String, String)], name: &str) -> Option<String> {
    env.iter().rev().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

/// Refuse when the environment changes how git finds or reads a repository.
pub(super) fn check_bypass(env: &[(String, String)]) -> Result<(), GitCacheError> {
    for name in defaults::list("gitcache.bypass_env") {
        if env_get(env, name).is_some() {
            return Err(GitCacheError::Bypassed(name.to_string()));
        }
    }
    Ok(())
}

/// The three directories that matter for one repository.
#[derive(Debug, Clone)]
pub(super) struct Layout {
    /// The directory that holds the `.git` entry (the work tree root as git reports it, symlinks resolved).
    pub work_dir: PathBuf,
    /// The git directory (`.git`, or the `gitdir:` target).
    pub git_dir: PathBuf,
    /// Where `config`, `packed-refs` and `refs/` live (the git directory, or the main one for a linked worktree).
    pub common_dir: PathBuf,
}

fn is_repo_dir(d: &Path) -> bool {
    d.join(defaults::text("gitcache.file_head")).is_file()
}

impl Layout {
    pub(super) fn discover(start: &Path) -> Result<Layout, GitCacheError> {
        let not = || GitCacheError::NotResolved(start.to_path_buf());
        let abs = std::fs::canonicalize(start).map_err(|_| not())?;
        let first = if abs.is_dir() { abs.clone() } else { abs.parent().map(Path::to_path_buf).ok_or_else(not)? };
        let dot = defaults::text("gitcache.dot_git");
        for dir in first.ancestors() {
            let marker = dir.join(dot);
            let meta = match std::fs::symlink_metadata(&marker) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let git_dir = if meta.is_dir() {
                if !is_repo_dir(&marker) {
                    continue;
                }
                marker
            } else {
                let text = std::fs::read_to_string(&marker).map_err(|_| GitCacheError::GitFile(marker.clone()))?;
                let prefix = defaults::text("gitcache.gitdir_prefix");
                let target = text
                    .lines()
                    .next()
                    .and_then(|l| l.strip_prefix(prefix))
                    .map(str::trim)
                    .filter(|t| !t.is_empty())
                    .ok_or_else(|| GitCacheError::GitFile(marker.clone()))?;
                let p = Path::new(target);
                let joined = if p.is_absolute() { p.to_path_buf() } else { dir.join(p) };
                let resolved = std::fs::canonicalize(&joined).map_err(|_| GitCacheError::GitFile(marker.clone()))?;
                if !is_repo_dir(&resolved) {
                    return Err(GitCacheError::GitFile(marker));
                }
                resolved
            };
            let common_dir = match std::fs::read_to_string(git_dir.join(defaults::text("gitcache.file_commondir"))) {
                Ok(t) => {
                    let p = Path::new(t.trim());
                    let joined = if p.is_absolute() { p.to_path_buf() } else { git_dir.join(p) };
                    std::fs::canonicalize(&joined).unwrap_or(joined)
                }
                Err(_) => git_dir.clone(),
            };
            return Ok(Layout { work_dir: dir.to_path_buf(), git_dir, common_dir });
        }
        Err(not())
    }

    /// The ref file HEAD names, when HEAD is a symbolic ref to something under `refs/` (and nothing odd in the path).
    fn head_ref(&self, head: &SigItem) -> Option<PathBuf> {
        let SigItem::Content(Some(bytes)) = head else { return None };
        let text = String::from_utf8_lossy(bytes);
        let name = text.lines().next()?.strip_prefix(defaults::text("gitcache.head_ref_prefix"))?.trim();
        (name.starts_with("refs/") && !name.split('/').any(|c| c == ".." || c.is_empty())).then(|| self.common_dir.join(name))
    }

    /// The signature of everything the base facts depend on.
    pub(super) fn signature(&self, env: &[(String, String)]) -> Vec<SigItem> {
        let head = content(&self.git_dir.join(defaults::text("gitcache.file_head")));
        let mut sig = vec![
            stat(&self.git_dir.join(defaults::text("gitcache.file_index"))),
            stat(&self.common_dir.join(defaults::text("gitcache.file_config"))),
            stat(&self.git_dir.join(defaults::text("gitcache.file_config_worktree"))),
            stat(&self.common_dir.join(defaults::text("gitcache.file_packed_refs"))),
            match self.head_ref(&head) {
                Some(p) => content(&p),
                None => SigItem::Content(None),
            },
            head,
        ];
        for p in global_configs(env) {
            sig.push(stat(&p));
        }
        sig
    }

    /// The signature of the remote-tracking directories: a fetch that creates or removes a ref changes its parent
    /// directory's mtime.
    pub(super) fn remote_ref_signature(&self, max: usize) -> Vec<SigItem> {
        let root = self.common_dir.join(defaults::text("gitcache.dir_remote_refs"));
        let mut sig = vec![stat(&root)];
        if let Ok(rd) = std::fs::read_dir(&root) {
            let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
            dirs.sort();
            for d in dirs.into_iter().take(max) {
                sig.push(stat(&d));
            }
        }
        sig
    }
}

/// The user's and the system's config files that git reads besides the repository's own.
fn global_configs(env: &[(String, String)]) -> Vec<PathBuf> {
    let home = env_get(env, defaults::text("gitcache.env_home")).map(PathBuf::from);
    let mut out: Vec<PathBuf> = Vec::new();
    for rel in defaults::list("gitcache.global_configs") {
        let p = Path::new(rel);
        if p.is_absolute() {
            out.push(p.to_path_buf());
        } else if let Some(h) = &home {
            out.push(h.join(p));
        }
    }
    if let Some(x) = env_get(env, defaults::text("gitcache.env_xdg_config")) {
        out.push(Path::new(&x).join(defaults::text("gitcache.xdg_git_config")));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_process_environment_is_never_read() {
        let name = "GIT_DISCOVERY_ACROSS_FILESYSTEM";
        assert!(defaults::list("gitcache.bypass_env").contains(&name));
        unsafe { std::env::set_var(name, "1") };
        let own = check_bypass(&[]);
        let given = check_bypass(&[(name.to_string(), "1".to_string())]);
        unsafe { std::env::remove_var(name) };
        assert!(own.is_ok(), "the daemon's own GIT_* is not the request's: {own:?}");
        assert!(matches!(given, Err(GitCacheError::Bypassed(n)) if n == name));
        assert_eq!(env_get(&[], "PATH"), None);
    }

    #[test]
    fn every_bypass_variable_reaches_the_daemon_with_the_request() {
        for name in defaults::list("gitcache.bypass_env") {
            assert!(crate::reqenv::allowed(name), "{name} is not in request_env.allow, so a client's value would never be seen");
        }
    }
}
