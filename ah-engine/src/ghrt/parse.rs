//! Reading the GitHub answers into small summaries, and deriving a repo's status and its edges from them.
//!
//! The rules are not compiled: they are the plugin script `engine/logic/rules/gh-rt.js` (D88), called through
//! [`crate::script::call_fn`] with the settings it needs (the status words, the conflict states, the push-watch window) read here from
//! `github_rt.toml` and the owner's overrides of it. These functions only carry the data across. A script that cannot answer (it is
//! missing, switched off, or failed: the reason is logged) gives no summary, which the poller reads as "nothing known": no status, so
//! no edge.
use super::cfg::Cfg;
use serde_json::{Value, json};

fn call(func: &str, args: Value) -> Option<Value> {
    crate::script::call_fn(crate::defaults::text("github_rt.rules_script"), func, &args)
}

/// The pull request of a branch from the pulls list (newest first): an open one wins, else the newest. `Null` when none.
pub fn pulls(body: &Value) -> Value {
    call("ghPulls", json!({"body": body})).unwrap_or(Value::Null)
}

/// One pull request: the mergeability.
pub fn pull(body: &Value) -> Value {
    call("ghPull", json!({"body": body})).unwrap_or(Value::Null)
}

/// The review decision from a pull request's reviews, oldest first: each reviewer's last approving or changes-requesting
/// review counts, a dismissal removes it, a plain comment changes nothing. `Null` when the script gave no answer.
pub fn reviews(cfg: &Cfg, body: &Value) -> Value {
    call("ghReviews", json!({"body": body, "statuses": cfg.value("github_rt.statuses")})).unwrap_or(Value::Null)
}

/// The check runs (`key` = `check_runs`) or workflow runs (`workflow_runs`) of a commit: counts and the names of the failing,
/// running and all of them.
pub fn runs(cfg: &Cfg, body: &Value, key: &str, sha: &str) -> Value {
    call("ghRuns", json!({"body": body, "key": key, "sha": sha, "statuses": cfg.value("github_rt.statuses")})).unwrap_or(Value::Null)
}

/// The required status check contexts of the branch rules (the `required_status_checks` rules).
pub fn rules(body: &Value) -> Value {
    call("ghRules", json!({"body": body})).unwrap_or_else(|| json!([]))
}

/// What a repo looks like now, derived from its summaries; edges are the differences between two of these. `None` when the
/// script gave no answer.
pub fn status(cfg: &Cfg, repo: &Value, now: u64) -> Option<Value> {
    call(
        "ghStatus",
        json!({
            "repo": repo, "now": now, "pushWatchMs": cfg.int("github_rt.push_watch_ms"), "conflictStates": cfg.list_field("github_rt.statuses", "conflict_states"),
            "ready": {
                "enabled": cfg.flag("github_rt.ready_enabled"), "requireApproval": cfg.flag("github_rt.ready_require_approval"), "requireUpToDate": cfg.flag("github_rt.ready_require_up_to_date"),
                "okStates": cfg.strs("github_rt.ready_ok_states"), "behindStates": cfg.strs("github_rt.ready_behind_states"),
            },
        }),
    )
}

/// An edge: its kind and the key that identifies it for the cooldown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    /// ci_red, ci_green, pr_merged, pr_closed, changes_requested, approved or conflict.
    pub kind: String,
    /// Identity inside a repo: the commit for a CI edge, the pull request number for the others.
    pub subject: String,
}

/// The edges between two statuses of the same repo and branch. None before the first full poll (nothing to compare).
pub fn edges(prev: Option<&Value>, new: &Value) -> Vec<Edge> {
    let Some(prev) = prev.filter(|p| !p.is_null()) else { return Vec::new() };
    let list = call("ghEdges", json!({"prev": prev, "next": new})).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    list.iter().filter_map(|e| Some(Edge { kind: e.get("kind")?.as_str()?.to_string(), subject: e.get("subject")?.as_str()?.to_string() })).collect()
}

/// How an edge reads aloud, and the jobs it names.
pub fn edge_text(cfg: &Cfg, kind: &str, slug: &str, branch: &str, sha: &str, status: &Value) -> (String, Vec<String>) {
    let args = json!({"kind": kind, "slug": slug, "branch": branch, "sha": sha, "status": status, "words": cfg.value("github_rt.words"), "jobsShown": cfg.int("github_rt.jobs_shown")});
    let Some(v) = call("ghEdgeText", args) else { return (String::new(), Vec::new()) };
    let jobs = v.get("jobs").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    (v.get("text").and_then(Value::as_str).unwrap_or("").to_string(), jobs)
}

/// The statusline pieces for a repo's status.
pub fn segment(cfg: &Cfg, status: &Value) -> String {
    let args = json!({"status": status, "kinds": cfg.strs("github_rt.statusline_kinds"), "words": cfg.value("github_rt.words")});
    call("ghSegment", args).and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

/// The name of the `github_rt` setting that holds the polling interval a repo's status calls for.
pub fn cadence(status: &Value) -> Option<String> {
    call("ghCadence", json!({"status": status})).and_then(|v| v.as_str().map(String::from))
}

/// The merge commit of a pull request read after a merge: `{merged, merge_commit_sha, base}`.
pub fn merge_info(body: &Value) -> Value {
    call("ghMergeInfo", json!({"body": body})).unwrap_or(Value::Null)
}

/// Whether the commit list of a base branch holds a revert of the merged pull request: `{reverted, by}`.
pub fn revert_check(commits: &Value, merge_sha: &str, title: &str) -> Value {
    call("ghRevertCheck", json!({"body": commits, "mergeSha": merge_sha, "title": title})).unwrap_or(Value::Null)
}
