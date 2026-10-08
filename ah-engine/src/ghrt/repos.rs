//! Which repos are followed: the git repos of the working directories the hooks of live sessions reported.
//!
//! Every hook payload carries `cwd`. The daemon records each directory it sees (at most once per `note_every_ms` per
//! directory) in a small file under the engine state directory; the poll tick reads it, drops what is older than
//! `cwd_ttl_ms` and resolves each directory to its repo root, its GitHub slug and its current branch.
use super::cfg::Cfg;
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// The directory of GitHub realtime's files.
pub fn dir(cfg: &Cfg) -> PathBuf {
    cfg.state_dir().join(cfg.txt("github_rt.files", "dir"))
}

/// A named file of GitHub realtime (`cwds`, `state`, `edges`).
pub fn file(cfg: &Cfg, name: &str) -> PathBuf {
    dir(cfg).join(cfg.txt("github_rt.files", name))
}

static NOTED: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);

/// Record that a session works in `cwd` (the hook path: one map lookup unless the directory is due). `state` is the
/// directory the cwd file lives in. Returns true when the file was written.
pub fn note(state: &Path, cwds_name: &str, cwd: &str, now: u64, every: u64, ttl: u64, cap: usize) -> bool {
    if cwd.is_empty() || !Path::new(cwd).is_absolute() {
        return false;
    }
    let key = format!("{}\u{1}{cwd}", state.display());
    {
        let mut g = NOTED.lock().unwrap_or_else(|e| e.into_inner());
        let map = g.get_or_insert_with(HashMap::new);
        if map.get(&key).is_some_and(|t| now.saturating_sub(*t) < every) {
            return false;
        }
        map.insert(key, now);
        if map.len() > cap.saturating_mul(4).max(64) {
            map.retain(|_, t| now.saturating_sub(*t) < ttl);
        }
    }
    let path = state.join(cwds_name);
    let mut all: BTreeMap<String, u64> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    all.insert(cwd.to_string(), now);
    all.retain(|_, t| now.saturating_sub(*t) < ttl);
    while all.len() > cap {
        let Some(oldest) = all.iter().min_by_key(|(_, t)| **t).map(|(k, _)| k.clone()) else { break };
        all.remove(&oldest);
    }
    if let Err(e) = std::fs::create_dir_all(state) {
        crate::discard::note("ghrt_cwd_dir", &e.to_string());
        return false;
    }
    match crate::atomic::write(&path, json!(all).to_string()) {
        Ok(()) => true,
        Err(e) => {
            crate::discard::note("ghrt_cwd_write", &e.to_string());
            false
        }
    }
}

/// The recorded directories seen within `ttl`, most recent first.
pub fn recent(cfg: &Cfg, now: u64) -> Vec<(String, u64)> {
    let all: BTreeMap<String, u64> = std::fs::read_to_string(file(cfg, "cwds")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let ttl = cfg.int("github_rt.cwd_ttl_ms");
    let mut v: Vec<(String, u64)> = all.into_iter().filter(|(_, t)| now.saturating_sub(*t) < ttl).collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

/// Run a configured read-only git command (`github_rt.git.<key>`) with `{root}` filled in; its trimmed stdout, or `None`.
pub fn git(cfg: &Cfg, key: &str, root: &str) -> Option<String> {
    let argv = cfg.list_field("github_rt.git", key);
    let (prog, rest) = argv.split_first()?;
    let mut cmd = std::process::Command::new(prog);
    cmd.args(rest.iter().map(|a| a.replace("{root}", root)));
    let poll = crate::defaults::millis("client.fallback_poll_ms");
    let o = crate::proc::run(cmd, "git", Duration::from_millis(cfg.num_field("github_rt.git", "timeout_ms")), poll).ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// `(owner, repo)` of an origin URL when its host is one of `github_rt.remote.hosts`.
pub fn slug_of(cfg: &Cfg, url: &str) -> Option<(String, String)> {
    let url = url.trim();
    let after_scheme = url.split_once("://").map_or(url, |(_, r)| r);
    let after_user = after_scheme.rsplit_once('@').filter(|(_, r)| !r.is_empty()).map_or(after_scheme, |(_, r)| r);
    let cut = after_user.find(['/', ':'])?;
    let (host, path) = after_user.split_at(cut);
    let host = host.to_ascii_lowercase();
    if !cfg.list_field("github_rt.remote", "hosts").iter().any(|h| h.eq_ignore_ascii_case(&host)) {
        return None;
    }
    let re = regex::Regex::new(&cfg.txt("github_rt.remote", "slug_re")).ok()?;
    let c = re.captures(path)?;
    Some((c.get(1)?.as_str().to_string(), c.get(2)?.as_str().to_string()))
}

/// What git says about a repo root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    /// The current branch, or the detached word.
    pub branch: String,
    /// The head commit.
    pub sha: String,
    /// The git dir (per worktree).
    pub gitdir: String,
    /// The common git dir, where branch refs live (it differs from `gitdir` in a linked worktree).
    pub commondir: String,
}

/// Read the branch, head commit and git dirs of `root`; `None` when it is not a readable repo.
pub fn info(cfg: &Cfg, root: &str) -> Option<Info> {
    let branch = git(cfg, "branch", root)?;
    let sha = git(cfg, "sha", root).unwrap_or_default();
    let dirs = git(cfg, "dirs", root)?;
    let mut it = dirs.lines();
    let gitdir = it.next()?.to_string();
    let common = it.next()?.to_string();
    let commondir = if Path::new(&common).is_absolute() { common } else { Path::new(root).join(&common).to_string_lossy().into_owned() };
    Some(Info { branch, sha, gitdir, commondir })
}

fn stamp(p: &Path) -> String {
    match std::fs::metadata(p) {
        Ok(m) => {
            let t = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
            format!("{t}:{}", m.len())
        }
        Err(_) => String::from("-"),
    }
}

/// The signatures of the files a commit, a checkout or a push changes: `(local, remote)`. `local` covers HEAD and the branch
/// ref; `remote` covers the remote-tracking ref of the branch and packed-refs, which a push (or a fetch) rewrites.
pub fn signature(cfg: &Cfg, gitdir: &str, commondir: &str, branch: &str) -> (String, String) {
    let f = |k: &str| cfg.txt("github_rt.push_signature", k).replace("{branch}", branch);
    let local = format!("{}|{}", stamp(&Path::new(gitdir).join(f("head"))), stamp(&Path::new(commondir).join(f("heads"))));
    let remote = format!("{}|{}", stamp(&Path::new(commondir).join(f("remotes"))), stamp(&Path::new(commondir).join(f("packed"))));
    (local, remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_urls_of_every_form_give_a_slug_and_other_hosts_do_not() {
        let c = Cfg::shipped();
        let want = Some(("acme".to_string(), "widgets".to_string()));
        for u in [
            "https://github.com/acme/widgets.git",
            "https://github.com/acme/widgets",
            "git@github.com:acme/widgets.git",
            "ssh://git@github.com/acme/widgets.git",
            "https://user:tok@github.com/acme/widgets.git/",
            "https://GitHub.com/acme/widgets",
        ] {
            assert_eq!(slug_of(&c, u), want, "{u}");
        }
        for u in ["https://gitlab.com/acme/widgets.git", "git@bitbucket.org:acme/widgets.git", "/srv/git/widgets.git", "", "https://github.com/acme"] {
            assert_eq!(slug_of(&c, u), None, "{u}");
        }
    }

    #[test]
    fn noting_a_directory_is_throttled_pruned_and_capped() {
        let d = std::env::temp_dir().join(format!("ghrt-note-{}", std::process::id()));
        let n = |cwd: &str, now: u64| note(&d, "cwds.json", cwd, now, 1000, 10_000, 3);
        assert!(n("/a", 100), "first sighting writes");
        assert!(!n("/a", 600), "inside note_every nothing is written");
        assert!(n("/a", 1200));
        assert!(!n("rel", 1300) && !n("", 1300), "a relative or empty cwd is ignored");
        for (i, p) in ["/b", "/c", "/d"].iter().enumerate() {
            assert!(n(p, 2000 + i as u64));
        }
        let read = || serde_json::from_str::<BTreeMap<String, u64>>(&std::fs::read_to_string(d.join("cwds.json")).unwrap()).unwrap();
        assert_eq!(read().keys().cloned().collect::<Vec<_>>(), ["/b", "/c", "/d"], "capped at 3, the oldest dropped");
        assert!(n("/e", 20_000));
        assert_eq!(read().keys().cloned().collect::<Vec<_>>(), ["/e"], "older than the ttl is pruned");
        std::fs::remove_dir_all(&d).unwrap();
    }
}
