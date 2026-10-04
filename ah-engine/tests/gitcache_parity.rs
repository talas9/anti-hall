//! X3 parity (D61): for fixture repositories, every cached fact equals what a fresh `git` invocation returns, before
//! and after each mutation, while the TTL is long enough that only the signature can invalidate. Every test uses its
//! own HOME (an empty global config) and never touches the real one.

mod transcript_support;
use ah_engine::gitcache::{GitCache, GitCacheError, GitLimits};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use transcript_support::Tmp;

struct Fx {
    tmp: Tmp,
    env: Vec<(String, String)>,
    cache: GitCache,
}

fn limits() -> GitLimits {
    let mut l = GitLimits::from_defaults();
    l.ttl = Duration::from_secs(3600); // only the signature may invalidate
    l.dirty_ttl = Duration::ZERO; // a work-tree edit is invisible to the signature, so the dirty bit is never memoized here
    l
}

impl Fx {
    fn new(tag: &str) -> Fx {
        let tmp = Tmp::new(tag);
        let home = tmp.path("home");
        std::fs::create_dir_all(&home).unwrap();
        let env = [
            ("HOME", home.to_str().unwrap()),
            ("GIT_CONFIG_NOSYSTEM", "1"),
            ("GIT_AUTHOR_NAME", "t"),
            ("GIT_AUTHOR_EMAIL", "t@example.com"),
            ("GIT_COMMITTER_NAME", "t"),
            ("GIT_COMMITTER_EMAIL", "t@example.com"),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        Fx { tmp, env, cache: GitCache::with_limits(limits()) }
    }

    fn dir(&self, name: &str) -> PathBuf {
        let p = self.tmp.path(name);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::canonicalize(&p).unwrap()
    }

    fn cmd(&self, dir: &Path, args: &[&str]) -> std::process::Output {
        let mut c = Command::new("git");
        c.args(args).current_dir(dir).env("GIT_OPTIONAL_LOCKS", "0").env("GIT_TERMINAL_PROMPT", "0");
        for (k, v) in &self.env {
            c.env(k, v);
        }
        c.output().unwrap()
    }

    /// A fresh git invocation: stdout without its final newline when it exited 0, else None.
    fn fresh(&self, dir: &Path, args: &[&str]) -> Option<String> {
        let o = self.cmd(dir, args);
        o.status.success().then(|| {
            String::from_utf8_lossy(&o.stdout).strip_suffix('\n').map(str::to_string).unwrap_or_else(|| String::from_utf8_lossy(&o.stdout).to_string())
        })
    }

    /// A mutation: must succeed.
    fn git(&self, dir: &Path, args: &[&str]) {
        let o = self.cmd(dir, args);
        assert!(o.status.success(), "git {args:?} in {} failed: {}", dir.display(), String::from_utf8_lossy(&o.stderr));
    }

    fn write(&self, dir: &Path, name: &str, text: &str) {
        std::fs::write(dir.join(name), text).unwrap();
    }

    fn commit(&self, dir: &Path, name: &str, text: &str) {
        self.write(dir, name, text);
        self.git(dir, &["add", name]);
        self.git(dir, &["commit", "-q", "-m", text]);
    }

    /// Every cached fact equals the fresh answer.
    fn assert_same(&self, dir: &Path, label: &str) {
        let r = self.cache.repo(dir, &self.env).unwrap_or_else(|e| panic!("{label}: {e}"));
        let ok = |name: &str, got: Option<String>, want: Option<String>| assert_eq!(got, want, "{label}: {name}");
        ok("toplevel", r.toplevel().unwrap(), self.fresh(dir, &["rev-parse", "--show-toplevel"]));
        ok("git_dir", r.git_dir().unwrap(), self.fresh(dir, &["rev-parse", "--absolute-git-dir"]));
        ok("head", r.head().unwrap(), self.fresh(dir, &["rev-parse", "HEAD"]));
        ok("branch", r.branch().unwrap(), self.fresh(dir, &["symbolic-ref", "--short", "HEAD"]));
        ok("upstream", r.upstream().unwrap(), self.fresh(dir, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
        assert_eq!(r.remotes().unwrap(), self.fresh(dir, &["remote"]).map(|s| s.lines().map(str::to_string).collect()), "{label}: remotes");
        assert_eq!(r.aliases().unwrap(), self.fresh_aliases(dir), "{label}: aliases");
        ok("config user.name", r.config_get("user.name").unwrap(), self.fresh(dir, &["config", "--get", "user.name"]));
        ok("config core.bare", r.config_get("core.bare").unwrap(), self.fresh(dir, &["config", "--get", "core.bare"]));
        ok("config commit.template", r.config_path("commit.template").unwrap(), self.fresh(dir, &["config", "--path", "--get", "commit.template"]));
        let dirty = self.fresh(dir, &["status", "--porcelain=v1"]).map(|s| !s.is_empty());
        assert_eq!(r.dirty().unwrap(), dirty, "{label}: dirty");
        assert_eq!(r.dirty_exact().unwrap(), dirty, "{label}: dirty_exact");
    }

    /// The alias list as `lib/git-alias-scan.js` parses it, written independently of the cache's parser.
    fn fresh_aliases(&self, dir: &Path) -> Option<BTreeMap<String, String>> {
        let o = self.cmd(dir, &["config", "-z", "--get-regexp", "^alias\\."]);
        if !o.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&o.stdout).to_string();
        let mut m = BTreeMap::new();
        for rec in text.split('\0') {
            if let Some((k, v)) = rec.split_once('\n') {
                let k = k.to_lowercase();
                let k = k.strip_prefix("alias.").unwrap_or(&k).to_string();
                m.entry(k).or_insert_with(|| v.to_string());
            }
        }
        Some(m)
    }

    fn init(&self, name: &str) -> PathBuf {
        let d = self.dir(name);
        self.git(&d, &["init", "-q", "-b", "main"]);
        d
    }
}

#[test]
fn a_plain_repository_stays_equal_to_git_across_every_kind_of_change() {
    let fx = Fx::new("gc-plain");
    let d = fx.init("repo");
    fx.assert_same(&d, "unborn");
    let r = fx.cache.repo(&d, &fx.env).unwrap();
    assert_eq!(r.head().unwrap(), None, "an unborn branch has no HEAD commit");
    assert_eq!(r.branch().unwrap().as_deref(), Some("main"));

    fx.commit(&d, "a.txt", "one");
    fx.assert_same(&d, "after the first commit");
    fx.commit(&d, "b.txt", "two");
    fx.assert_same(&d, "after a second commit");
    fx.git(&d, &["commit", "-q", "--amend", "-m", "amended"]);
    fx.assert_same(&d, "after an amend (index untouched, only the branch ref moves)");
    fx.git(&d, &["commit", "-q", "--allow-empty", "-m", "empty"]);
    fx.assert_same(&d, "after an empty commit");

    fx.git(&d, &["config", "alias.st", "status"]);
    fx.git(&d, &["config", "alias.CI", "commit -v"]);
    fx.assert_same(&d, "after adding aliases");
    assert_eq!(fx.cache.repo(&d, &fx.env).unwrap().aliases().unwrap().unwrap().get("ci").map(String::as_str), Some("commit -v"));
    fx.git(&d, &["config", "--unset", "alias.st"]);
    fx.assert_same(&d, "after removing an alias");
    fx.git(&d, &["config", "user.name", "someone"]);
    fx.git(&d, &["config", "commit.template", "~/tpl.txt"]);
    fx.assert_same(&d, "after setting config values");

    fx.git(&d, &["checkout", "-q", "-b", "feature"]);
    fx.assert_same(&d, "after switching branch");
    fx.git(&d, &["checkout", "-q", "--detach"]);
    fx.assert_same(&d, "detached HEAD");
    fx.git(&d, &["checkout", "-q", "main"]);
    fx.git(&d, &["pack-refs", "--all"]);
    fx.assert_same(&d, "after pack-refs");
    fx.git(&d, &["reset", "-q", "--hard", "HEAD~1"]);
    fx.assert_same(&d, "after a reset");

    fx.write(&d, "b.txt", "edited");
    fx.assert_same(&d, "an unstaged edit (dirty)");
    fx.write(&d, "new.txt", "x");
    fx.assert_same(&d, "an untracked file");
    fx.git(&d, &["add", "-A"]);
    fx.assert_same(&d, "staged changes");
    fx.git(&d, &["stash", "-q"]);
    fx.assert_same(&d, "after a stash");
}

#[test]
fn a_hit_spawns_nothing_and_a_change_is_never_served_stale() {
    let fx = Fx::new("gc-hits");
    let d = fx.init("repo");
    fx.commit(&d, "a.txt", "one");
    let r = fx.cache.repo(&d, &fx.env).unwrap();
    let h1 = r.head().unwrap();
    let s1 = fx.cache.stats();
    assert_eq!(r.head().unwrap(), h1);
    assert_eq!(r.branch().unwrap().as_deref(), Some("main"));
    let s2 = fx.cache.stats();
    assert_eq!(s2.hits, s1.hits + 1, "the second HEAD read was a hit");
    assert_eq!(s2.misses, s1.misses + 1, "only the first branch read ran git");
    // a commit changes HEAD's ref and the index
    fx.commit(&d, "b.txt", "two");
    let h2 = r.head().unwrap();
    assert_ne!(h2, h1, "a commit is never served stale");
    assert_eq!(h2, fx.fresh(&d, &["rev-parse", "HEAD"]));
    assert!(fx.cache.stats().invalidations > s2.invalidations);
    // a commit that touches nothing but the branch ref (empty commit) is seen through the ref's content
    let before = r.head().unwrap();
    fx.git(&d, &["commit", "-q", "--allow-empty", "-m", "e"]);
    assert_ne!(r.head().unwrap(), before);
    // a config change
    assert_eq!(r.config_get("user.name").unwrap(), None);
    fx.git(&d, &["config", "user.name", "x"]);
    assert_eq!(r.config_get("user.name").unwrap().as_deref(), Some("x"));
    fx.git(&d, &["config", "user.name", "y"]);
    assert_eq!(r.config_get("user.name").unwrap().as_deref(), Some("y"), "same size, replaced file: still seen");
    // the global config (the user's own) is signed too
    let home = fx.tmp.path("home");
    std::fs::write(home.join(".gitconfig"), "[alias]\n\tg = log\n").unwrap();
    assert_eq!(r.aliases().unwrap().unwrap().get("g").map(String::as_str), Some("log"));
    std::fs::write(home.join(".gitconfig"), "[alias]\n\th = log\n").unwrap();
    let a = r.aliases().unwrap().unwrap();
    assert!(a.contains_key("h") && !a.contains_key("g"));
}

#[test]
fn the_dirty_bit_is_bounded_by_time_and_the_exact_read_never_is() {
    let fx = Fx::new("gc-dirty");
    let d = fx.init("repo");
    fx.commit(&d, "a.txt", "one");
    let mut l = limits();
    l.dirty_ttl = Duration::from_secs(3600);
    let cache = GitCache::with_limits(l);
    let r = cache.repo(&d, &fx.env).unwrap();
    assert_eq!(r.dirty().unwrap(), Some(false));
    fx.write(&d, "a.txt", "edited"); // changes none of the signed files
    assert_eq!(r.dirty().unwrap(), Some(false), "within the TTL the memo is served (documented limit)");
    assert_eq!(r.dirty_exact().unwrap(), Some(true), "the exact read asks git");
    assert_eq!(r.dirty().unwrap(), Some(true), "and refreshes the memo");
    // staging rewrites the index, which IS signed: the memo is dropped at once, well inside the TTL
    fx.git(&d, &["add", "a.txt"]);
    fx.git(&d, &["commit", "-q", "-m", "clean again"]);
    assert_eq!(r.dirty().unwrap(), Some(false));
    fx.write(&d, "a.txt", "edited again");
    assert_eq!(r.dirty().unwrap(), Some(false), "an unstaged edit alone is still invisible to the signature");
    fx.git(&d, &["add", "a.txt"]);
    assert_eq!(r.dirty().unwrap(), Some(true), "the index changed, so the memo was discarded and git was asked");
}

#[test]
fn each_signed_file_invalidates_on_its_own() {
    let fx = Fx::new("gc-each");
    let d = fx.init("repo");
    fx.commit(&d, "a.txt", "one");
    fx.commit(&d, "b.txt", "two");
    let r = fx.cache.repo(&d, &fx.env).unwrap();
    let tip = r.head().unwrap().unwrap();
    // only a branch ref changes (no index write, HEAD file untouched)
    fx.git(&d, &["update-ref", "refs/heads/main", "HEAD~1"]);
    let moved = r.head().unwrap().unwrap();
    assert_ne!(moved, tip, "a moved branch ref is seen through the ref's content");
    assert_eq!(Some(moved), fx.fresh(&d, &["rev-parse", "HEAD"]));
    // only packed-refs changes: a tracking ref that exists only as a packed entry is deleted
    let origin = fx.dir("origin.git");
    fx.git(&origin, &["init", "-q", "--bare", "-b", "main"]);
    fx.git(&d, &["remote", "add", "origin", origin.to_str().unwrap()]);
    fx.git(&d, &["push", "-q", "origin", "main"]);
    fx.git(&d, &["branch", "-q", "--set-upstream-to=origin/main", "main"]);
    fx.git(&d, &["pack-refs", "--all"]);
    assert_eq!(r.upstream().unwrap().as_deref(), Some("origin/main"));
    fx.git(&d, &["update-ref", "-d", "refs/remotes/origin/main"]);
    assert_eq!(r.upstream().unwrap(), None, "a packed ref removed through packed-refs alone is seen");
    assert_eq!(r.upstream().unwrap(), fx.fresh(&d, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]));
}

#[test]
fn an_upstream_appears_when_a_fetch_creates_its_remote_tracking_ref() {
    let fx = Fx::new("gc-up");
    let d = fx.init("repo");
    fx.commit(&d, "a.txt", "one");
    let origin = fx.dir("origin.git");
    fx.git(&origin, &["init", "-q", "--bare", "-b", "main"]);
    fx.git(&d, &["remote", "add", "origin", origin.to_str().unwrap()]);
    fx.git(&d, &["config", "branch.main.remote", "origin"]);
    fx.git(&d, &["config", "branch.main.merge", "refs/heads/main"]);
    fx.assert_same(&d, "upstream configured, ref not fetched yet");
    assert_eq!(fx.cache.repo(&d, &fx.env).unwrap().upstream().unwrap(), None);
    fx.git(&d, &["push", "-q", "origin", "main"]);
    fx.git(&d, &["fetch", "-q", "origin"]);
    fx.assert_same(&d, "after the fetch created refs/remotes/origin/main");
    assert_eq!(fx.cache.repo(&d, &fx.env).unwrap().upstream().unwrap().as_deref(), Some("origin/main"));
    assert_eq!(fx.cache.repo(&d, &fx.env).unwrap().remotes().unwrap(), Some(vec!["origin".to_string()]));
    fx.git(&d, &["branch", "--unset-upstream"]);
    fx.assert_same(&d, "upstream unset");
    fx.git(&d, &["branch", "-q", "--set-upstream-to=origin/main"]);
    fx.assert_same(&d, "upstream set again");
    // a second clone pushes; fetching in the first moves the tracking ref (name unchanged, still equal to git)
    let other = fx.dir("other");
    fx.git(&other, &["clone", "-q", origin.to_str().unwrap(), "c"]);
    fx.commit(&other.join("c"), "z.txt", "z");
    fx.git(&other.join("c"), &["push", "-q", "origin", "main"]);
    fx.git(&d, &["fetch", "-q", "origin"]);
    fx.assert_same(&d, "after another fetch");
    fx.git(&d, &["pack-refs", "--all"]);
    fx.assert_same(&d, "after packing the tracking refs");
}

#[test]
fn a_linked_worktree_resolves_to_its_own_git_dir_and_the_shared_config() {
    let fx = Fx::new("gc-wt");
    let main = fx.init("main");
    fx.commit(&main, "a.txt", "one");
    let wt = fx.tmp.path("wt");
    fx.git(&main, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feat"]);
    let wt = std::fs::canonicalize(&wt).unwrap();
    assert!(wt.join(".git").is_file(), "a linked worktree has a .git file");
    fx.assert_same(&wt, "worktree at creation");
    fx.assert_same(&main, "main checkout");
    let r = fx.cache.repo(&wt, &fx.env).unwrap();
    assert_eq!(r.branch().unwrap().as_deref(), Some("feat"));
    fx.commit(&wt, "w.txt", "w");
    fx.assert_same(&wt, "after a commit in the worktree");
    // the config is shared: a change made through the main checkout is seen from the worktree
    fx.git(&main, &["config", "alias.zz", "status"]);
    assert_eq!(r.aliases().unwrap().unwrap().get("zz").map(String::as_str), Some("status"));
    fx.assert_same(&wt, "after a shared config change");
    // the main checkout's own branch ref moves through the common directory
    fx.commit(&main, "m.txt", "m");
    fx.assert_same(&main, "after a commit in main");
    fx.assert_same(&wt, "worktree after main moved");
}

#[test]
fn a_submodule_git_file_is_followed() {
    let fx = Fx::new("gc-sub");
    let sub = fx.init("subsrc");
    fx.commit(&sub, "s.txt", "s");
    let sup = fx.init("super");
    fx.commit(&sup, "a.txt", "one");
    fx.git(&sup, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.to_str().unwrap(), "sm"]);
    let inner = sup.join("sm");
    assert!(inner.join(".git").is_file(), "a submodule has a .git file");
    fx.assert_same(&inner, "submodule at creation");
    fx.assert_same(&sup, "superproject");
    let top_inner = fx.cache.repo(&inner, &fx.env).unwrap().toplevel().unwrap().unwrap();
    let top_sup = fx.cache.repo(&sup, &fx.env).unwrap().toplevel().unwrap().unwrap();
    assert_ne!(top_inner, top_sup, "the submodule is its own repository, not an alias of its parent");
    fx.commit(&inner, "x.txt", "x");
    fx.assert_same(&inner, "after a commit in the submodule");
    fx.git(&inner, &["config", "alias.sm", "status"]);
    fx.assert_same(&inner, "after a config change in the submodule");
    // a subdirectory resolves to the same repository
    std::fs::create_dir_all(inner.join("deep/er")).unwrap();
    assert_eq!(fx.cache.repo(&inner.join("deep/er"), &fx.env).unwrap().toplevel().unwrap(), fx.fresh(&inner, &["rev-parse", "--show-toplevel"]));
}

#[test]
fn directories_the_cache_cannot_answer_for_say_so() {
    let fx = Fx::new("gc-no");
    let plain = fx.dir("not-a-repo");
    assert!(matches!(fx.cache.repo(&plain, &fx.env), Err(GitCacheError::NotResolved(_))));
    assert!(matches!(fx.cache.repo(&fx.tmp.path("missing"), &fx.env), Err(GitCacheError::NotResolved(_))));
    let d = fx.init("repo");
    for name in ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_COUNT"] {
        let mut env = fx.env.clone();
        env.push((name.to_string(), "x".to_string()));
        match fx.cache.repo(&d, &env) {
            Err(GitCacheError::Bypassed(n)) => assert_eq!(n, name),
            other => panic!("{name}: {:?}", other.err()),
        }
    }
    // a bad .git file is reported, not guessed at
    let bad = fx.dir("bad");
    std::fs::write(bad.join(".git"), "garbage\n").unwrap();
    assert!(matches!(fx.cache.repo(&bad, &fx.env), Err(GitCacheError::GitFile(_))));
    // the message text comes from the defaults
    assert!(GitCacheError::Bypassed("GIT_DIR".into()).to_string().contains("GIT_DIR"));
}

#[test]
fn different_git_environments_never_share_an_entry_and_the_cache_is_bounded() {
    let fx = Fx::new("gc-env");
    let d = fx.init("repo");
    fx.commit(&d, "a.txt", "one");
    let mut env2 = fx.env.clone();
    env2.push(("GIT_AUTHOR_DATE".to_string(), "2020-01-01T00:00:00".to_string()));
    fx.cache.repo(&d, &fx.env).unwrap().head().unwrap();
    fx.cache.repo(&d, &env2).unwrap().head().unwrap();
    assert_eq!(fx.cache.len(), 2);
    let mut l = limits();
    l.max_repos = 2;
    let small = GitCache::with_limits(l);
    for n in ["r1", "r2", "r3"] {
        let r = fx.init(n);
        small.repo(&r, &fx.env).unwrap();
    }
    assert_eq!(small.len(), 2, "the least recently used repository was dropped");
    small.clear();
    assert!(small.is_empty());
}

#[test]
fn a_git_that_cannot_finish_is_an_error_and_is_not_cached() {
    let fx = Fx::new("gc-slow");
    let d = fx.init("repo");
    fx.commit(&d, "a.txt", "one");
    let mut l = limits();
    l.timeout = Duration::from_millis(1);
    l.poll = Duration::from_millis(1);
    let cache = GitCache::with_limits(l);
    let r = cache.repo(&d, &fx.env).unwrap();
    // 1 ms is far below git's start-up time, so every run times out; none of them may be remembered
    let first = r.head();
    assert!(matches!(first, Err(GitCacheError::Run { .. })), "{first:?}");
    assert!(matches!(r.head(), Err(GitCacheError::Run { .. })));
    assert_eq!(cache.stats().hits, 0);
}
