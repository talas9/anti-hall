//! The facts the action decision script (`engine/logic/act/devswarm-act.js`) reads, gathered from the live sources: the
//! DevSwarm app database, the workspace descriptors, the mesh summary projection and the mesh store, git, and the heartbeat and
//! transcript times. Each reader is a port of the matching Node reader (`companion/lib/devswarm-lifecycle.js`,
//! `devswarm-git-truth.js`, `liveness.js`) and fails the way Node does: a fact that cannot be proven is `null`, which the
//! script treats as "not proven" and so never as permission.
//!
//! One deliberate narrowing: the idle gate uses Node's pre-0.109 rule (the newest of the heartbeat and the session transcript
//! time) and never the "real work" turn classifier. Node itself falls back to that rule whenever a transcript cannot be
//! classified, and it can only block an archive, never allow one early. The cost is that a child woken by its own mailbox
//! cron never goes idle by this rule.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable or malformed source file is the absent fact, which the decision script reads as "not proven"
use crate::defaults;
use crate::devswarm_rt::sources::{AppBuilder, FsProbe, Probe};
use crate::dsact::runner::{RunResult, RunSpec, Runner};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use crate::meshw::union;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// One workspace descriptor (`devswarm/workspaces/<id>.json`), as Node's `readDescriptors` keeps it: a worktree and a session.
#[derive(Debug, Clone, PartialEq)]
pub struct Desc {
    /// The descriptor's id.
    pub id: String,
    /// The worktree path.
    pub worktree: String,
    /// The session id.
    pub session: String,
    /// The poke argv (descriptor `nudgeCommand`), when it is an array of strings.
    pub nudge: Option<Vec<String>>,
    /// The escalate argv (descriptor `escalateCommand`).
    pub escalate: Option<Vec<String>>,
}

fn key(k: &str) -> &'static str {
    defaults::raw("devswarm_wire.desc_keys").str_field(k)
}

fn argv_of(v: Option<&Value>) -> Option<Vec<String>> {
    let a = v?.as_array()?;
    let out: Vec<String> = a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
    (out.len() == a.len() && !out.is_empty()).then_some(out)
}

/// The descriptor in the file at `path`: `None` when it cannot be read or lacks an id, a worktree or a session.
pub fn descriptor_at(path: &Path) -> Option<Desc> {
    let v = std::fs::read_to_string(path)
        .ok()
        .inspect(|t| crate::devswarm_rt::sources::count_read(t.len()))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())?;
    let s = |k: &str| v.get(key(k)).and_then(Value::as_str).unwrap_or_default().to_string();
    let (id, worktree, session) = (s("id"), s("worktree"), s("session"));
    if worktree.is_empty() || session.is_empty() || !is_safe_id(&id) {
        return None;
    }
    Some(Desc { id, worktree, session, nudge: argv_of(v.get(key("nudge"))), escalate: argv_of(v.get(key("escalate"))) })
}

/// Every readable descriptor that has an id, a worktree and a session.
pub fn descriptors(home: &Path) -> Vec<Desc> {
    descriptors_with(home, None)
}

/// [`descriptors`], answering from `cache` the files whose stat data is unchanged (the reconcile's read; an action's re-check passes none).
pub fn descriptors_with(home: &Path, cache: Option<&crate::devswarm_rt::sources::ReadCache>) -> Vec<Desc> {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().ends_with(suffix) {
            continue;
        }
        let d = match cache {
            Some(c) => c.descriptor(&e.path()),
            None => descriptor_at(&e.path()),
        };
        out.extend(d);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// The descriptors that belong to a builder: the same id or the same worktree.
pub fn descs_of<'a>(all: &'a [Desc], b: &AppBuilder) -> Vec<&'a Desc> {
    all.iter().filter(|d| d.id == b.id || b.worktree.as_deref() == Some(d.worktree.as_str())).collect()
}

/// git, run bounded through the same subprocess runner the actions use.
pub struct Git<'a> {
    /// The runner.
    pub runner: &'a dyn Runner,
}

/// Git calls started and git calls answered from memory since the process started (the `status --threads` work counters).
pub static GIT_RUNS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// See [`GIT_RUNS`].
pub static GIT_CACHE_HITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Modification time (ns) and size of each file a call's answer depends on; `None` for a file that does not exist.
type GitSig = Vec<Option<(i64, u64)>>;

/// One remembered git answer.
struct GitCached {
    sig: GitSig,
    result: RunResult,
    at: i64,
}

static GIT_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, GitCached>>> = std::sync::LazyLock::new(Default::default);

/// What a git call reads, which decides the files its remembered answer depends on and how long it is kept.
#[derive(Clone, Copy, PartialEq)]
enum GitClass {
    /// `git status`.
    Status,
    /// `git rev-parse HEAD`.
    Ref,
    /// The merge and pushed proofs.
    Proof,
}

impl GitClass {
    /// The settings of the class that name the paths in the worktree, in its git directory and in the common directory that its answer
    /// depends on.
    fn files(self) -> [&'static str; 3] {
        [self.wt_key(), self.gitdir_key(), self.common_key()]
    }
    fn wt_key(self) -> &'static str {
        match self {
            GitClass::Status => "devswarm_wire.git_cache_status_wt",
            GitClass::Ref => "devswarm_wire.git_cache_ref_wt",
            GitClass::Proof => "devswarm_wire.git_cache_proof_wt",
        }
    }
    fn gitdir_key(self) -> &'static str {
        match self {
            GitClass::Status => "devswarm_wire.git_cache_status_gitdir",
            GitClass::Ref => "devswarm_wire.git_cache_ref_gitdir",
            GitClass::Proof => "devswarm_wire.git_cache_proof_gitdir",
        }
    }
    fn common_key(self) -> &'static str {
        match self {
            GitClass::Status => "devswarm_wire.git_cache_status_common",
            GitClass::Ref => "devswarm_wire.git_cache_ref_common",
            GitClass::Proof => "devswarm_wire.git_cache_proof_common",
        }
    }
    /// How long the answer is kept, in ms; a dirty `status` has its own, longer limit.
    fn max_ms(self, dirty: bool) -> i64 {
        (match (self, dirty) {
            (GitClass::Status, false) => defaults::num("devswarm_wire.git_cache_status_max_ms"),
            (GitClass::Status, true) => defaults::num("devswarm_wire.git_cache_status_dirty_max_ms"),
            (GitClass::Ref, _) => defaults::num("devswarm_wire.git_cache_ref_max_ms"),
            (GitClass::Proof, _) => defaults::num("devswarm_wire.git_cache_proof_max_ms"),
        }) as i64
    }
    /// Whether an answer that ended with `status` is a settled one worth remembering (`git merge-base --is-ancestor` answers a proven "no"
    /// with 1); a failure (a locked index, a missing repository) is read again at the next call.
    fn settled(self, status: Option<i32>) -> bool {
        let key = match self {
            GitClass::Proof => "devswarm_wire.git_cache_proof_exit_codes",
            GitClass::Status | GitClass::Ref => "devswarm_wire.git_cache_exit_codes",
        };
        status.is_some_and(|s| defaults::list(key).iter().any(|c| c.parse::<i32>().ok() == Some(s)))
    }
    fn tag(self) -> char {
        match self {
            GitClass::Status => 's',
            GitClass::Ref => 'r',
            GitClass::Proof => 'p',
        }
    }
}

/// The directory that holds the refs of a worktree's repository: the linked worktree's `commondir`, else its git directory.
fn common_dir(gitdir: &Path) -> PathBuf {
    let spec = defaults::text("devswarm_wire.git_commondir_file");
    match std::fs::read_to_string(gitdir.join(spec)).ok().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        Some(rel) => gitdir.join(rel),
        None => gitdir.to_path_buf(),
    }
}

/// The signature of what a `class` of git call reads, `None` when the worktree's git directory is unknown (then nothing is remembered).
fn git_sig(wt: &str, class: GitClass) -> Option<GitSig> {
    use std::os::unix::fs::MetadataExt;
    let gitdir = git_dir(wt)?;
    let common = common_dir(&gitdir);
    let stat = |p: PathBuf| std::fs::metadata(p).ok().map(|m| (m.mtime() * 1_000_000_000 + m.mtime_nsec(), m.len()));
    let mut sig = GitSig::new();
    for (key, base) in class.files().into_iter().zip([Path::new(wt).to_path_buf(), gitdir, common]) {
        for f in defaults::list(key) {
            sig.push(stat(base.join(f)));
        }
    }
    Some(sig)
}

impl Git<'_> {
    fn run(&self, wt: &str, args: &[&str]) -> RunResult {
        GIT_RUNS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut a = vec!["-C".to_string(), wt.to_string()];
        a.extend(args.iter().map(|s| s.to_string()));
        self.runner.run(&RunSpec {
            bin: Some(defaults::text("devswarm_wire.git_bin").to_string()),
            args: a,
            cwd: None,
            timeout_ms: defaults::num("devswarm_wire.git_timeout_ms"),
            ..RunSpec::default()
        })
    }

    /// [`Self::run`], answered from memory while the files a `class` of call depends on are unchanged and the answer is younger than its
    /// limit (`devswarm_wire.git_cache_<class>_max_ms`; a dirty `status` has its own, longer limit, since only a commit or an index
    /// write cleans a tree and both move the signature). A call that timed out, failed to start, ended with an exit status the class does not settle on, or has no signature is never remembered.
    fn run_cached(&self, wt: &str, class: GitClass, args: &[&str]) -> RunResult {
        let Some(sig) = git_sig(wt, class) else { return self.run(wt, args) };
        let key = format!("{}\0{wt}\0{}", class.tag(), args.join("\0"));
        let now = crate::health::now_ms() as i64;
        if let Some(c) = GIT_CACHE.lock().unwrap_or_else(|e| e.into_inner()).get(&key) {
            let dirty = class == GitClass::Status && !c.result.stdout.trim().is_empty();
            if c.sig == sig && now - c.at < class.max_ms(dirty) {
                GIT_CACHE_HITS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                return c.result.clone();
            }
        }
        let result = self.run(wt, args);
        if !result.timed_out && !result.missing && class.settled(result.status) {
            let mut cache = GIT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            if cache.len() >= defaults::num("devswarm_wire.git_cache_max_entries") as usize {
                cache.clear(); // bounded: the next reconcile refills it
            }
            cache.insert(key, GitCached { sig, result: result.clone(), at: now });
        }
        result
    }
    /// `git rev-parse HEAD`.
    pub fn head(&self, wt: &str) -> Option<String> {
        if !Path::new(wt).exists() {
            return None;
        }
        let r = self.run_cached(wt, GitClass::Ref, &["rev-parse", "HEAD"]);
        let h = r.stdout.trim().to_string();
        (r.ok && !h.is_empty()).then_some(h)
    }
    /// Is `head` on some remote branch (`git branch -r --contains`)? `None` when git cannot say.
    pub fn pushed(&self, wt: &str, head: &str) -> Option<bool> {
        if !Path::new(wt).exists() {
            return None;
        }
        let mut args: Vec<&str> = defaults::list("devswarm_act.git_pushed_args");
        args.push(head);
        let r = self.run_cached(wt, GitClass::Proof, &args);
        r.ok.then(|| !r.stdout.trim().is_empty())
    }
    /// `git status --porcelain`: `(clean, reason)` as Node's `cleanFact`.
    pub fn clean(&self, wt: &str) -> (Option<bool>, Option<&'static str>) {
        self.clean_with(wt, true)
    }
    /// [`Self::clean`] asked of git itself, never from memory: an owner's own request reads the tree as it is now.
    pub fn clean_now(&self, wt: &str) -> (Option<bool>, Option<&'static str>) {
        self.clean_with(wt, false)
    }
    fn clean_with(&self, wt: &str, remembered: bool) -> (Option<bool>, Option<&'static str>) {
        if !Path::new(wt).exists() {
            return (None, Some("worktree-missing"));
        }
        let args = ["status", "--porcelain"];
        let r = if remembered { self.run_cached(wt, GitClass::Status, &args) } else { self.run(wt, &args) };
        if !r.ok {
            return (None, Some("git-status-failed"));
        }
        let dirty = !r.stdout.trim().is_empty();
        (Some(!dirty), dirty.then_some("uncommitted-changes"))
    }
    /// `gitMergeProof`: is `head` an ancestor of the remote default branch (`origin/HEAD`)? `(merged, via)`.
    pub fn merge_proof(&self, wt: &str, head: &str) -> (Option<bool>, String) {
        if !Path::new(wt).exists() {
            return (None, "unproven".into());
        }
        let s = self.run_cached(wt, GitClass::Proof, &["symbolic-ref", "refs/remotes/origin/HEAD"]);
        let sym = s.stdout.trim().to_string();
        let Some(short) = s.ok.then(|| sym.strip_prefix("refs/remotes/").filter(|r| r.starts_with("origin/")).map(str::to_string)).flatten() else {
            return (None, "default-branch-unknown".into());
        };
        let full = format!("refs/remotes/{short}");
        let v = self.run_cached(wt, GitClass::Proof, &["rev-parse", "--verify", "--quiet", &format!("{full}^{{commit}}")]);
        if !v.ok {
            return (None, "unproven".into());
        }
        let r = self.run_cached(wt, GitClass::Proof, &["merge-base", "--is-ancestor", head, &full]);
        match r.status {
            Some(0) => (Some(true), format!("git:{short}")),
            Some(1) => (Some(false), "git:not-ancestor".into()),
            _ => (None, "unproven".into()),
        }
    }
}

/// The mesh summary projection of a repository (`summaries/<repoKey>.json`).
pub fn summary(home: &Path, repo_key: &str) -> Option<Value> {
    let p = devswarm_root(home).join(defaults::text("mesh_write.dir_summaries")).join(format!("{repo_key}{}", defaults::text("mesh_write.json_suffix")));
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

/// Gate (a), Node's `doneFact`: `{done, via, doneHead?}`.
pub fn done_fact(summary: Option<&Value>, ids: &[String], head: Option<&str>) -> Value {
    let ws = summary.and_then(|s| s.get("workspaces")).and_then(Value::as_object);
    let (mut manual, mut stale): (Option<Value>, Option<String>) = (None, None);
    for w in ids.iter().filter_map(|id| ws.and_then(|m| m.get(id))) {
        let done_row = w.pointer("/gates/done") == Some(&Value::Bool(true));
        let ready = w.get("archive_ready") == Some(&Value::Bool(true));
        if !done_row && !ready {
            continue;
        }
        if done_row && let Some(dh) = w.get("doneHead").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            if head == Some(dh) {
                return json!({"done": true, "via": "done-report", "boundToHead": true});
            }
            stale.get_or_insert_with(|| dh.to_string());
            continue;
        }
        manual.get_or_insert_with(|| json!({"done": true, "via": if ready { "gates" } else { "done-gate" }, "boundToHead": false}));
    }
    match (manual, stale) {
        (Some(m), _) => m,
        (None, Some(s)) => json!({"done": false, "via": "stale-head", "doneHead": s}),
        _ => json!({"done": false, "via": null}),
    }
}

fn num(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

/// The mesh store reader of a repository, when its store is the SQLite backend.
fn reader(home: &Path, repo_key: &str) -> Option<crate::mesh::MeshReader> {
    let dir = union::store_dir(home, repo_key);
    let marker = std::fs::read_to_string(dir.join(defaults::text("mesh.backend_marker"))).map(|m| m.trim().to_lowercase()).unwrap_or_default();
    let db = dir.join(defaults::text("mesh_write.store_file"));
    (marker == defaults::text("mesh.backend_sqlite") && db.exists()).then(|| crate::mesh::MeshReader::open(&db).ok()).flatten()
}

/// Gate (d), Node's `unreadFact` with broadcasts excluded: `{toChild, toDirect, toBroadcast, fromChild}` (null = unknown).
pub fn unread_fact(home: &Path, repo_key: Option<&str>, summary: Option<&Value>, ids: &[String]) -> Value {
    let unknown = json!({"toChild": null, "toDirect": null, "toBroadcast": null, "fromChild": null});
    let (Some(rk), Some(ws)) = (repo_key, summary.and_then(|s| s.get("workspaces")).and_then(Value::as_object)) else { return unknown };
    let (mut direct, mut broadcast, mut known) = (0.0, 0.0, false);
    for w in ids.iter().filter_map(|id| ws.get(id)) {
        known = true;
        direct += num(w.get("unread"));
        broadcast += num(w.get("broadcastUnread"));
    }
    let others: Vec<&Value> =
        ws.values().filter(|w| w.get("id").and_then(Value::as_str).is_some_and(|i| !ids.iter().any(|x| x == i)) && num(w.get("unread")) > 0.0).collect();
    let from_child = if others.is_empty() {
        Some(0)
    } else {
        reader(home, rk).and_then(|r| {
            let mut n = 0u64;
            for w in &others {
                let id = w.get("id").and_then(Value::as_str)?;
                r.for_each_message(id, num(w.get("cursor")) as u64, |m| {
                    if m.get("sender").and_then(Value::as_str).is_some_and(|s| ids.iter().any(|x| x == s)) {
                        n += 1;
                    }
                    true
                })
                .ok()?;
            }
            Some(n)
        })
    };
    json!({"toChild": known.then_some(direct), "toDirect": known.then_some(direct), "toBroadcast": known.then_some(broadcast), "fromChild": from_child})
}

/// The transcript file of a session: `<home>/<transcript_dir>/<worktree with / \ : . as ->/<session>.jsonl`.
pub fn transcript_path(home: &Path, worktree: &str, session: &str) -> PathBuf {
    let enc: String = worktree.chars().map(|c| if defaults::text("devswarm_wire.transcript_encode").contains(c) { '-' } else { c }).collect();
    home.join(defaults::text("devswarm_wire.transcript_dir")).join(enc).join(format!("{session}{}", defaults::text("devswarm_wire.transcript_ext")))
}

/// Node's `readActivityTs` for the candidate's descriptors: the newest of the heartbeat time and each transcript's mtime.
pub fn activity_ms(home: &Path, probe: &FsProbe, b: &AppBuilder, descs: &[&Desc]) -> Option<i64> {
    let mut best = descs.iter().filter_map(|d| probe.heartbeat_ms(&d.id)).chain(probe.heartbeat_ms(&b.id)).max().unwrap_or(0);
    for d in descs {
        let m = std::fs::metadata(transcript_path(home, &d.worktree, &d.session)).and_then(|m| m.modified()).ok();
        if let Some(t) = m.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()) {
            best = best.max(t.as_millis() as i64);
        }
    }
    (best > 0).then_some(best)
}

/// Node's `defaultLastInboundTs`: the newest message addressed to one of `ids` that is no broadcast, no heartbeat and not from one of
/// them. `None` when the store cannot be read (the caller then holds the workspace).
pub fn last_inbound_ms(home: &Path, repo_key: Option<&str>, ids: &[String]) -> Option<f64> {
    let r = reader(home, repo_key?)?;
    let mut best = 0.0f64;
    for id in ids {
        r.for_each_message(id, 0, |m| {
            let from_self = m.get("sender").and_then(Value::as_str).is_some_and(|s| ids.iter().any(|i| i == s));
            let broadcast = m.get("mtype").and_then(Value::as_str) == Some(defaults::text("mesh_write.mtype_broadcast"));
            if !from_self && !broadcast && m.get("isHeartbeat") != Some(&Value::Bool(true)) {
                best = best.max(m.get("ts").and_then(Value::as_f64).filter(|t| t.is_finite()).unwrap_or(0.0));
            }
            true
        })
        .ok()?;
    }
    Some(best)
}

/// Whether the candidate's transcripts cannot PROVE that it is idle. Node classifies the tail turn by turn (ignoring its own pings);
/// this check is deliberately stricter and can only hold a workspace: it is uncertain unless the last user or assistant entry of every
/// readable transcript is an assistant entry that ended its turn, and when the tail shows background work the child launched. A
/// transcript that cannot be read says nothing (Node then falls back to the heartbeat and file time, as the activity floor does).
pub fn idle_uncertain(home: &Path, descs: &[&Desc]) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let tail = defaults::num("devswarm_wire.idle_tail_bytes");
    descs.iter().any(|d| {
        let Ok(mut f) = std::fs::File::open(transcript_path(home, &d.worktree, &d.session)) else { return false };
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let start = size.saturating_sub(tail);
        let mut buf = Vec::new();
        if f.seek(SeekFrom::Start(start)).is_err() || f.take(tail).read_to_end(&mut buf).is_err() {
            return true;
        }
        let text = String::from_utf8_lossy(&buf);
        if text.contains(defaults::text("devswarm_wire.idle_background_marker")) {
            return true;
        }
        let last = text.lines().rev().filter_map(|l| serde_json::from_str::<Value>(l).ok()).find(|v| {
            matches!(v.get("type").and_then(Value::as_str), Some(t) if t == defaults::text("devswarm_wire.idle_type_assistant") || t == defaults::text("devswarm_wire.idle_type_user"))
        });
        !last.is_some_and(|v| {
            v.get("type").and_then(Value::as_str) == Some(defaults::text("devswarm_wire.idle_type_assistant"))
                && v.pointer(defaults::text("devswarm_wire.idle_stop_pointer")).and_then(Value::as_str) == Some(defaults::text("devswarm_wire.idle_stop_end_turn"))
        })
    })
}

/// The repository key of a worktree, or `None` when it cannot be resolved.
pub fn repo_key(worktree: &str) -> Option<String> {
    crate::meshw::ident::repo_key_for_worktree(worktree).ok().flatten()
}

/// A worktree's git directory: `<wt>/.git` itself, or the target of the `gitdir:` line a linked worktree has in its place.
pub fn git_dir(wt: &str) -> Option<PathBuf> {
    let spec = defaults::raw("devswarm_wire.git_dir_file");
    let p = Path::new(wt).join(spec.str_field("file"));
    if p.is_dir() {
        return Some(p);
    }
    let line = std::fs::read_to_string(&p).ok()?;
    let target = line.lines().next()?.strip_prefix(spec.str_field("prefix"))?.trim();
    let t = Path::new(target);
    Some(if t.is_absolute() { t.to_path_buf() } else { Path::new(wt).join(t) })
}
