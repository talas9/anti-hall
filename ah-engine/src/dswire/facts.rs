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

/// Every readable descriptor that has an id, a worktree and a session.
pub fn descriptors(home: &Path) -> Vec<Desc> {
    let dir = devswarm_root(home).join(defaults::text("mesh_write.dir_workspaces"));
    let suffix = defaults::text("mesh_write.json_suffix");
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().ends_with(suffix) {
            continue;
        }
        let Some(v) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let s = |k: &str| v.get(key(k)).and_then(Value::as_str).unwrap_or_default().to_string();
        let (id, worktree, session) = (s("id"), s("worktree"), s("session"));
        if worktree.is_empty() || session.is_empty() || !is_safe_id(&id) {
            continue;
        }
        out.push(Desc { id, worktree, session, nudge: argv_of(v.get(key("nudge"))), escalate: argv_of(v.get(key("escalate"))) });
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

impl Git<'_> {
    fn run(&self, wt: &str, args: &[&str]) -> RunResult {
        let mut a = vec!["-C".to_string(), wt.to_string()];
        a.extend(args.iter().map(|s| s.to_string()));
        self.runner.run(&RunSpec {
            bin: Some(defaults::text("devswarm_wire.git_bin").to_string()),
            args: a,
            cwd: None,
            timeout_ms: defaults::num("devswarm_wire.git_timeout_ms"),
        })
    }
    /// `git rev-parse HEAD`.
    pub fn head(&self, wt: &str) -> Option<String> {
        if !Path::new(wt).exists() {
            return None;
        }
        let r = self.run(wt, &["rev-parse", "HEAD"]);
        let h = r.stdout.trim().to_string();
        (r.ok && !h.is_empty()).then_some(h)
    }
    /// `git status --porcelain`: `(clean, reason)` as Node's `cleanFact`.
    pub fn clean(&self, wt: &str) -> (Option<bool>, Option<&'static str>) {
        if !Path::new(wt).exists() {
            return (None, Some("worktree-missing"));
        }
        let r = self.run(wt, &["status", "--porcelain"]);
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
        let s = self.run(wt, &["symbolic-ref", "refs/remotes/origin/HEAD"]);
        let sym = s.stdout.trim().to_string();
        let Some(short) = s.ok.then(|| sym.strip_prefix("refs/remotes/").filter(|r| r.starts_with("origin/")).map(str::to_string)).flatten() else {
            return (None, "default-branch-unknown".into());
        };
        let full = format!("refs/remotes/{short}");
        let v = self.run(wt, &["rev-parse", "--verify", "--quiet", &format!("{full}^{{commit}}")]);
        if !v.ok {
            return (None, "unproven".into());
        }
        let r = self.run(wt, &["merge-base", "--is-ancestor", head, &full]);
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

/// The repository key of a worktree, or `None` when it cannot be resolved.
pub fn repo_key(worktree: &str) -> Option<String> {
    crate::meshw::ident::repo_key_for_worktree(worktree).ok().flatten()
}
