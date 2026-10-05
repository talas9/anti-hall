//! The per-repo git cache (X3, D61): the facts the guards used to spawn `git` for, served from memory while they are
//! provably unchanged.
//!
//! What is cached: the work tree root, the absolute git directory, the commit HEAD points to, the current branch,
//! the upstream of the branch, the remotes, the configured aliases, single config values, and the dirty bit.
//!
//! How a hit is proven (D61): every entry holds a signature of the repository files its answers depend on, taken
//! BEFORE the answer was computed. Each lookup recomputes the signature (a handful of `stat` calls and two tiny file
//! reads, no process) and serves the memo only when it is equal and the hard TTL has not passed. The signature has
//! the content of `HEAD` and of the loose ref it names, and the stat (device, inode, size, mtime, ctime) of the index,
//! the repository config, the per-worktree config, `packed-refs`, the user's global and system config files, and the
//! remote-tracking directories (for the upstream fact). Git replaces these files by rename, so a commit, a checkout,
//! a config change, a `pack-refs` or a fetch changes the signature even within one clock tick.
//!
//! What a signature cannot see, and what is done about it:
//! - A working-tree edit changes none of those files, so the dirty bit is bounded by `gitcache.dirty_ttl_ms`, and
//!   [`Repo::dirty_exact`] always asks git; a destructive decision must use the exact read (D-new-5, D61).
//! - Settings pulled in through `include.path` and `GIT_*` environment overrides are not signed. The cache refuses a
//!   call whose environment sets one of `gitcache.bypass_env` ([`GitCacheError::Bypassed`]); the caller then runs git
//!   itself, exactly as before.
//!
//! Misses are filled by running `git` once with the answer's own arguments, so a cached answer equals a fresh one by
//! construction; the parity tests in `tests/gitcache_parity.rs` check it across mutations on fixture repositories
//! (plain, linked worktree, submodule, detached HEAD, unborn branch). Failed runs (exit status not 0) are cached as
//! "git said no"; a run that could not be completed (spawn failure, timeout) is an error and is never cached.
//!
//! Not wired into any guard yet (D75 wave 2): this is the API the ported checks will call.
mod layout;
mod run;

use crate::defaults;
use layout::{Layout, SigItem};
use std::collections::{BTreeMap, HashMap};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Why the cache could not answer; the caller falls back to running git itself.
#[derive(Debug)]
pub enum GitCacheError {
    /// No git work tree was found at or above the directory.
    NotResolved(PathBuf),
    /// The environment changes how git finds or reads a repository, so cached answers could differ.
    Bypassed(String),
    /// A `.git` file does not name a git directory.
    GitFile(PathBuf),
    /// git could not be run to completion.
    Run {
        /// The arguments.
        args: String,
        /// Why.
        source: std::io::Error,
    },
}

impl fmt::Display for GitCacheError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitCacheError::NotResolved(d) => f.write_str(&defaults::render("gitcache.msg_not_resolved", &[("dir", &d.display())])),
            GitCacheError::Bypassed(n) => f.write_str(&defaults::render("gitcache.msg_bypassed", &[("name", n)])),
            GitCacheError::GitFile(p) => f.write_str(&defaults::render("gitcache.msg_gitfile", &[("path", &p.display())])),
            GitCacheError::Run { args, source } => f.write_str(&defaults::render("gitcache.msg_run", &[("args", args), ("err", source)])),
        }
    }
}

impl std::error::Error for GitCacheError {}

/// Caps and times of the cache; [`GitLimits::from_defaults`] reads `defaults/gitcache.toml`.
#[derive(Debug, Clone)]
pub struct GitLimits {
    /// The git program run on a miss.
    pub git_binary: String,
    /// Hard lifetime of a memo.
    pub ttl: Duration,
    /// Lifetime of the dirty memo.
    pub dirty_ttl: Duration,
    /// Wall-clock limit of one git run.
    pub timeout: Duration,
    /// Poll interval while waiting for a git child.
    pub poll: Duration,
    /// Most repositories cached.
    pub max_repos: usize,
    /// Idle lifetime of a repository entry.
    pub idle_ttl: Duration,
    /// Most remote-tracking directories signed.
    pub max_ref_dirs: usize,
    /// Most distinct config keys memoized per repository.
    pub max_config_keys: usize,
}

impl GitLimits {
    /// The shipped limits.
    pub fn from_defaults() -> GitLimits {
        GitLimits {
            git_binary: defaults::text("gitcache.git_binary").to_string(),
            ttl: defaults::millis("gitcache.ttl_ms"),
            dirty_ttl: defaults::millis("gitcache.dirty_ttl_ms"),
            timeout: defaults::millis("gitcache.timeout_ms"),
            poll: defaults::millis("gitcache.poll_ms"),
            max_repos: defaults::num("gitcache.max_repos") as usize,
            idle_ttl: defaults::millis("gitcache.idle_ttl_ms"),
            max_ref_dirs: defaults::num("gitcache.max_ref_dirs") as usize,
            max_config_keys: defaults::num("gitcache.max_config_keys") as usize,
        }
    }
}

/// One memoized answer and what it was computed under.
#[derive(Clone)]
struct Memo<T> {
    value: T,
    at: Instant,
    extra: Vec<SigItem>,
}

#[derive(Default)]
struct Facts {
    toplevel: Option<Memo<Option<String>>>,
    git_dir: Option<Memo<Option<String>>>,
    head: Option<Memo<Option<String>>>,
    branch: Option<Memo<Option<String>>>,
    upstream: Option<Memo<Option<String>>>,
    remotes: Option<Memo<Option<Vec<String>>>>,
    aliases: Option<Memo<Option<BTreeMap<String, String>>>>,
    dirty: Option<Memo<Option<bool>>>,
    config: HashMap<String, Option<Memo<Option<String>>>>,
}

struct Entry {
    layout: Layout,
    base: Vec<SigItem>,
    facts: Facts,
    last_used: Instant,
}

/// Which extra signature a fact is also bound to.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Extra {
    /// Only the base signature.
    None,
    /// The remote-tracking directories too (a fetch can create the upstream ref).
    RemoteRefs,
}

/// Which lifetime a fact has.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Life {
    Hard,
    Dirty,
}

/// A repository entry's key: its work tree root and the hash of the git environment it was asked under.
type RepoKey = (PathBuf, u64);

/// Counters of what the cache did, for metrics and tests.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    /// Answers served from a memo (no process spawned).
    pub hits: u64,
    /// Answers that ran git (a first ask, an expired memo, or a changed signature).
    pub misses: u64,
    /// Times a changed signature discarded a repository's memos.
    pub invalidations: u64,
}

/// The per-repo git cache.
pub struct GitCache {
    repos: Mutex<HashMap<RepoKey, Arc<Mutex<Entry>>>>,
    limits: GitLimits,
    hits: AtomicU64,
    misses: AtomicU64,
    invalidations: AtomicU64,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// FNV-1a of the extra environment, so two callers with different git environments never share an entry.
fn env_key(env: &[(String, String)]) -> u64 {
    let mut sorted: Vec<&(String, String)> = env.iter().collect();
    sorted.sort();
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for (k, v) in sorted {
        for b in k.bytes().chain([0]).chain(v.bytes()).chain([1]) {
            h = (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

impl GitCache {
    /// A cache with the shipped limits.
    pub fn new() -> GitCache {
        GitCache::with_limits(GitLimits::from_defaults())
    }

    /// A cache with explicit limits (tests).
    pub fn with_limits(limits: GitLimits) -> GitCache {
        GitCache { repos: Mutex::new(HashMap::new()), limits, hits: AtomicU64::new(0), misses: AtomicU64::new(0), invalidations: AtomicU64::new(0) }
    }

    /// The repository at or above `dir`. `env` is added to the process environment for every git run and to the
    /// entry's key (pass the same pairs on every call of one caller).
    pub fn repo(&self, dir: &Path, env: &[(String, String)]) -> Result<Repo<'_>, GitCacheError> {
        layout::check_bypass(env)?;
        let lay = Layout::discover(dir)?;
        let key = (lay.work_dir.clone(), env_key(env));
        let now = Instant::now();
        let entry = {
            let mut map = lock(&self.repos);
            map.retain(|_, e| now.duration_since(lock(e).last_used) <= self.limits.idle_ttl);
            if !map.contains_key(&key) && map.len() >= self.limits.max_repos {
                if let Some(old) = map.iter().min_by_key(|(_, e)| lock(e).last_used).map(|(k, _)| k.clone()) {
                    map.remove(&old);
                }
            }
            map.entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(Entry { base: Vec::new(), layout: lay.clone(), facts: Facts::default(), last_used: now })))
                .clone()
        };
        {
            let mut e = lock(&entry);
            e.layout = lay;
            e.last_used = now;
        }
        Ok(Repo { cache: self, entry, env: env.to_vec() })
    }

    /// What the cache has done so far.
    pub fn stats(&self) -> Stats {
        Stats { hits: self.hits.load(Relaxed), misses: self.misses.load(Relaxed), invalidations: self.invalidations.load(Relaxed) }
    }

    /// How many repositories are cached.
    pub fn len(&self) -> usize {
        lock(&self.repos).len()
    }

    /// True when none are cached.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Forget every cached repository.
    pub fn clear(&self) {
        lock(&self.repos).clear();
    }
}

impl Default for GitCache {
    fn default() -> Self {
        GitCache::new()
    }
}

/// A repository handle: each method answers from the cache while the signature holds, else runs git once.
pub struct Repo<'a> {
    cache: &'a GitCache,
    entry: Arc<Mutex<Entry>>,
    env: Vec<(String, String)>,
}

impl Repo<'_> {
    /// Get-or-fill one memo. The entry lock is held while git runs: that is bounded by `gitcache.timeout_ms`, and it
    /// stops two callers from running the same query twice.
    fn memo<T: Clone>(
        &self,
        sel: impl Fn(&mut Facts) -> &mut Option<Memo<T>>,
        life: Life,
        extra: Extra,
        fill: impl FnOnce(&run::Runner) -> Result<T, GitCacheError>,
    ) -> Result<T, GitCacheError> {
        let lim = &self.cache.limits;
        let mut e = lock(&self.entry);
        let now = Instant::now();
        e.last_used = now;
        let base = e.layout.signature(&self.env);
        if e.base != base {
            if !e.base.is_empty() {
                self.cache.invalidations.fetch_add(1, Relaxed);
            }
            e.base = base.clone();
            e.facts = Facts::default();
        }
        let extra_sig = if extra == Extra::RemoteRefs { e.layout.remote_ref_signature(lim.max_ref_dirs) } else { Vec::new() };
        let ttl = if life == Life::Dirty { lim.dirty_ttl } else { lim.ttl };
        if let Some(m) = sel(&mut e.facts) {
            if m.extra == extra_sig && now.duration_since(m.at) < ttl {
                self.cache.hits.fetch_add(1, Relaxed);
                return Ok(m.value.clone());
            }
        }
        self.cache.misses.fetch_add(1, Relaxed);
        let runner = run::Runner::new(&e.layout, &self.env, lim);
        let value = fill(&runner)?;
        *sel(&mut e.facts) = Some(Memo { value: value.clone(), at: Instant::now(), extra: extra_sig });
        Ok(value)
    }

    fn line(&self, sel: impl Fn(&mut Facts) -> &mut Option<Memo<Option<String>>>, key: &'static str, extra: Extra) -> Result<Option<String>, GitCacheError> {
        self.memo(sel, Life::Hard, extra, |r| Ok(r.run(&defaults::words(key))?.map(|s| run::strip_newline(&s))))
    }

    /// The work tree root (`git rev-parse --show-toplevel`); `None` when git has none (a bare repository).
    pub fn toplevel(&self) -> Result<Option<String>, GitCacheError> {
        self.line(|f| &mut f.toplevel, "gitcache.argv_toplevel", Extra::None)
    }

    /// The absolute git directory (`git rev-parse --absolute-git-dir`).
    pub fn git_dir(&self) -> Result<Option<String>, GitCacheError> {
        self.line(|f| &mut f.git_dir, "gitcache.argv_git_dir", Extra::None)
    }

    /// The commit HEAD points to (`git rev-parse HEAD`); `None` on an unborn branch.
    pub fn head(&self) -> Result<Option<String>, GitCacheError> {
        self.line(|f| &mut f.head, "gitcache.argv_head", Extra::None)
    }

    /// The current branch (`git symbolic-ref --short HEAD`); `None` on a detached HEAD.
    pub fn branch(&self) -> Result<Option<String>, GitCacheError> {
        self.line(|f| &mut f.branch, "gitcache.argv_branch", Extra::None)
    }

    /// The upstream of the current branch (`git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`); `None`
    /// when there is none or its remote-tracking ref does not exist.
    pub fn upstream(&self) -> Result<Option<String>, GitCacheError> {
        self.line(|f| &mut f.upstream, "gitcache.argv_upstream", Extra::RemoteRefs)
    }

    /// The configured remotes (`git remote`), in git's order; `None` when git failed.
    pub fn remotes(&self) -> Result<Option<Vec<String>>, GitCacheError> {
        self.memo(
            |f| &mut f.remotes,
            Life::Hard,
            Extra::None,
            |r| Ok(r.run(&defaults::words("gitcache.argv_remotes"))?.map(|s| s.lines().filter(|l| !l.is_empty()).map(str::to_string).collect())),
        )
    }

    /// The configured aliases, lower-cased name to expansion, the first definition of a name winning
    /// (`git config -z --get-regexp ^alias\.`, parsed like `lib/git-alias-scan.js` `aliasesFor`). `None` when git failed
    /// (it exits 1 when there is no alias at all, which is an empty map here only if git printed nothing and succeeded).
    pub fn aliases(&self) -> Result<Option<BTreeMap<String, String>>, GitCacheError> {
        self.memo(
            |f| &mut f.aliases,
            Life::Hard,
            Extra::None,
            |r| {
                let argv: Vec<&str> = defaults::list("gitcache.argv_aliases");
                Ok(r.run(&argv)?.map(|out| run::parse_aliases(&out)))
            },
        )
    }

    /// One config value (`git config --get <key>`); `None` when it is not set.
    pub fn config_get(&self, key: &str) -> Result<Option<String>, GitCacheError> {
        self.config_value(key, "gitcache.argv_config_get")
    }

    /// One path-valued config value with `~` expanded (`git config --path --get <key>`), such as `commit.template`.
    pub fn config_path(&self, key: &str) -> Result<Option<String>, GitCacheError> {
        self.config_value(key, "gitcache.argv_config_path")
    }

    fn config_value(&self, key: &str, argv: &'static str) -> Result<Option<String>, GitCacheError> {
        let slot = format!("{argv}\u{0}{key}");
        let cap = self.cache.limits.max_config_keys;
        self.memo(
            |f| {
                if f.config.len() >= cap && !f.config.contains_key(&slot) {
                    f.config.clear();
                }
                f.config.entry(slot.clone()).or_default()
            },
            Life::Hard,
            Extra::None,
            |r| {
                let mut a: Vec<&str> = defaults::words(argv);
                a.push(key);
                Ok(r.run(&a)?.map(|s| run::strip_newline(&s)))
            },
        )
    }

    /// Whether `git status --porcelain=v1` prints anything (a staged, unstaged or untracked change), bounded by
    /// `gitcache.dirty_ttl_ms`. Use [`Repo::dirty_exact`] before a destructive decision.
    pub fn dirty(&self) -> Result<Option<bool>, GitCacheError> {
        self.memo(|f| &mut f.dirty, Life::Dirty, Extra::None, |r| Ok(r.run(&defaults::words("gitcache.argv_status"))?.map(|s| !s.is_empty())))
    }

    /// The dirty bit straight from git, never from the memo (and the memo is refreshed with it).
    pub fn dirty_exact(&self) -> Result<Option<bool>, GitCacheError> {
        {
            let mut e = lock(&self.entry);
            e.facts.dirty = None;
        }
        self.dirty()
    }
}
