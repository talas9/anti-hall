//! Reading the GitHub answers into small summaries, and deriving a repo's status and its edges from them.
use super::cfg::Cfg;
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// The pull request of a branch from the pulls list (newest first): an open one wins, else the newest. `Null` when none.
pub fn pulls(body: &Value) -> Value {
    let Some(list) = body.as_array() else { return Value::Null };
    let pick = list.iter().find(|p| s(p, "state") == "open").or_else(|| list.first());
    let Some(p) = pick else { return Value::Null };
    let state = if !s(p, "merged_at").is_empty() { "merged" } else if s(p, "state") == "open" { "open" } else { "closed" };
    json!({
        "number": p.get("number").and_then(Value::as_u64).unwrap_or(0),
        "state": state,
        "base": p.get("base").map_or("", |b| s(b, "ref")),
        "title": s(p, "title"),
        "draft": p.get("draft").and_then(Value::as_bool).unwrap_or(false),
        "url": s(p, "html_url"),
    })
}

/// One pull request: the mergeability.
pub fn pull(body: &Value) -> Value {
    json!({"mergeable_state": s(body, "mergeable_state"), "mergeable": body.get("mergeable").cloned().unwrap_or(Value::Null)})
}

/// The review decision from a pull request's reviews, oldest first: each reviewer's last approving or changes-requesting
/// review counts, a dismissal removes it, a plain comment changes nothing.
pub fn reviews(cfg: &Cfg, body: &Value) -> &'static str {
    let (changes, approved, dismissed) = (cfg.txt("github_rt.statuses", "review_changes"), cfg.txt("github_rt.statuses", "review_approved"), cfg.txt("github_rt.statuses", "review_dismissed"));
    let mut last: BTreeMap<String, String> = BTreeMap::new();
    for r in body.as_array().into_iter().flatten() {
        let who = r.get("user").map_or("", |u| s(u, "login")).to_string();
        let st = s(r, "state").to_ascii_uppercase();
        if st == changes || st == approved {
            last.insert(who, st);
        } else if st == dismissed {
            last.remove(&who);
        }
    }
    if last.values().any(|v| *v == changes) {
        "changes_requested"
    } else if last.values().any(|v| *v == approved) {
        "approved"
    } else {
        "none"
    }
}

/// The check runs (`key` = `check_runs`) or workflow runs (`workflow_runs`) of a commit: counts and the names of the failing,
/// running and all of them.
pub fn runs(cfg: &Cfg, body: &Value, key: &str, sha: &str) -> Value {
    let (running, failing, skipped) = (cfg.list_field("github_rt.statuses", "running"), cfg.list_field("github_rt.statuses", "failing"), cfg.list_field("github_rt.statuses", "skipped"));
    let (mut names, mut fail, mut run, mut total, mut passed) = (Vec::new(), Vec::new(), 0u64, 0u64, 0u64);
    for r in body.get(key).and_then(Value::as_array).into_iter().flatten() {
        let (status, concl, name) = (s(r, "status"), s(r, "conclusion"), s(r, "name"));
        if skipped.iter().any(|x| x == concl) {
            continue;
        }
        total += 1;
        names.push(name.to_string());
        if running.iter().any(|x| x == status) || (status != "completed" && concl.is_empty()) {
            run += 1;
        } else if failing.iter().any(|x| x == concl) {
            fail.push(name.to_string());
        } else {
            passed += 1;
        }
    }
    json!({"sha": sha, "total": total, "running": run, "passed": passed, "failing": fail, "names": names})
}

/// The required status check contexts of the branch rules (the `required_status_checks` rules).
pub fn rules(body: &Value) -> Value {
    let mut req: Vec<String> = Vec::new();
    for r in body.as_array().into_iter().flatten().filter(|r| s(r, "type") == "required_status_checks") {
        for c in r.get("parameters").and_then(|p| p.get("required_status_checks")).and_then(Value::as_array).into_iter().flatten() {
            let ctx = s(c, "context");
            if !ctx.is_empty() && !req.iter().any(|x| x == ctx) {
                req.push(ctx.to_string());
            }
        }
    }
    json!(req)
}

/// What a repo looks like now, derived from its summaries; edges are the differences between two of these.
pub fn status(cfg: &Cfg, repo: &Value, now: u64) -> Value {
    let sha = s(repo, "sha");
    let own = |k: &str| repo.get(k).filter(|c| s(c, "sha") == sha && !sha.is_empty()).cloned().unwrap_or(Value::Null);
    let (checks, wf) = (own("checks"), own("runs"));
    let n = |v: &Value, k: &str| v.get(k).and_then(Value::as_u64).unwrap_or(0);
    let names = |v: &Value, k: &str| -> Vec<String> { v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() };
    let mut failing = names(&checks, "failing");
    if failing.is_empty() {
        failing = names(&wf, "failing");
    }
    let (running, total) = (n(&checks, "running") + n(&wf, "running"), n(&checks, "total") + n(&wf, "total"));
    let mut state = if !names(&checks, "failing").is_empty() || !names(&wf, "failing").is_empty() {
        "red"
    } else if running > 0 {
        "running"
    } else if total > 0 {
        "green"
    } else {
        "none"
    };
    let pushed = repo.get("pushed_ms").and_then(Value::as_u64).unwrap_or(0);
    if state == "none" && pushed > 0 && now.saturating_sub(pushed) < cfg.int("github_rt.push_watch_ms") {
        state = "running";
    }
    let pr = repo.get("pr").cloned().unwrap_or(Value::Null);
    let pr_state = if pr.is_null() { "none" } else { s(&pr, "state") };
    let required: Vec<String> = repo.get("required").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let present = names(&checks, "names");
    let missing: Vec<&String> = required.iter().filter(|r| !present.contains(r)).collect();
    let conflict = pr_state == "open" && cfg.list_field("github_rt.statuses", "conflict_states").iter().any(|c| c == s(repo.get("detail").unwrap_or(&Value::Null), "mergeable_state"));
    json!({
        "checks": state, "pr": pr_state, "number": pr.get("number").cloned().unwrap_or(Value::Null),
        "review": if pr_state == "open" { s(repo, "review") } else { "none" },
        "conflict": conflict, "sha": sha, "jobs": failing, "required": required, "required_missing": missing,
        "total": total, "running": running,
    })
}

/// An edge: its kind and the key that identifies it for the cooldown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    /// ci_red, ci_green, pr_merged, pr_closed, changes_requested, approved or conflict.
    pub kind: &'static str,
    /// Identity inside a repo: the commit for a CI edge, the pull request number for the others.
    pub subject: String,
}

/// The edges between two statuses of the same repo and branch. `None` before the first full poll (nothing to compare).
pub fn edges(prev: Option<&Value>, new: &Value) -> Vec<Edge> {
    let Some(prev) = prev.filter(|p| !p.is_null()) else { return Vec::new() };
    let (pc, nc) = (s(prev, "checks"), s(new, "checks"));
    let sha_changed = s(prev, "sha") != s(new, "sha");
    let mut out = Vec::new();
    let sha = s(new, "sha").to_string();
    if nc == "red" && (pc != "red" || sha_changed) {
        out.push(Edge { kind: "ci_red", subject: sha.clone() });
    }
    if nc == "green" && (pc != "green" || sha_changed) {
        out.push(Edge { kind: "ci_green", subject: sha });
    }
    let (number, same_pr) = (new.get("number").and_then(Value::as_u64).unwrap_or(0), prev.get("number") == new.get("number"));
    let subject = number.to_string();
    if same_pr && s(prev, "pr") == "open" {
        if s(new, "pr") == "merged" {
            out.push(Edge { kind: "pr_merged", subject: subject.clone() });
        }
        if s(new, "pr") == "closed" {
            out.push(Edge { kind: "pr_closed", subject: subject.clone() });
        }
    }
    if s(new, "pr") == "open" {
        if s(new, "review") == "changes_requested" && (s(prev, "review") != "changes_requested" || !same_pr) {
            out.push(Edge { kind: "changes_requested", subject: subject.clone() });
        }
        if s(new, "review") == "approved" && (s(prev, "review") != "approved" || !same_pr) {
            out.push(Edge { kind: "approved", subject: subject.clone() });
        }
        if new["conflict"] == true && (prev["conflict"] != true || !same_pr) {
            out.push(Edge { kind: "conflict", subject });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Cfg {
        Cfg::shipped()
    }

    #[test]
    fn an_open_pull_request_wins_over_a_newer_closed_one_and_merged_is_told_from_closed() {
        let list = json!([{"number": 9, "state": "closed", "merged_at": "2026-01-01T00:00:00Z", "base": {"ref": "main"}}, {"number": 7, "state": "open", "base": {"ref": "dev"}, "title": "t", "draft": true}]);
        let p = pulls(&list);
        assert_eq!((p["number"].as_u64(), p["state"].as_str(), p["base"].as_str(), p["draft"].as_bool()), (Some(7), Some("open"), Some("dev"), Some(true)));
        let p = pulls(&json!([{"number": 9, "state": "closed", "merged_at": "x"}]));
        assert_eq!(p["state"], "merged");
        assert_eq!(pulls(&json!([{"number": 3, "state": "closed", "merged_at": null}]))["state"], "closed");
        assert!(pulls(&json!([])).is_null() && pulls(&json!({"message": "x"})).is_null());
    }

    #[test]
    fn the_review_decision_follows_the_last_decisive_review_of_each_reviewer() {
        let r = |v: Value| reviews(&cfg(), &v);
        assert_eq!(r(json!([])), "none");
        assert_eq!(r(json!([{"user": {"login": "a"}, "state": "COMMENTED"}])), "none");
        assert_eq!(r(json!([{"user": {"login": "a"}, "state": "APPROVED"}])), "approved");
        assert_eq!(r(json!([{"user": {"login": "a"}, "state": "CHANGES_REQUESTED"}, {"user": {"login": "b"}, "state": "APPROVED"}])), "changes_requested");
        assert_eq!(r(json!([{"user": {"login": "a"}, "state": "CHANGES_REQUESTED"}, {"user": {"login": "a"}, "state": "APPROVED"}])), "approved", "the later review replaces the earlier");
        assert_eq!(r(json!([{"user": {"login": "a"}, "state": "CHANGES_REQUESTED"}, {"user": {"login": "a"}, "state": "DISMISSED"}])), "none");
    }

    #[test]
    fn check_runs_count_running_failing_passed_and_ignore_skipped() {
        let b = json!({"check_runs": [
            {"name": "build", "status": "completed", "conclusion": "success"},
            {"name": "test", "status": "completed", "conclusion": "failure"},
            {"name": "lint", "status": "in_progress", "conclusion": null},
            {"name": "docs", "status": "completed", "conclusion": "skipped"},
        ]});
        let v = runs(&cfg(), &b, "check_runs", "abc");
        assert_eq!((v["total"].as_u64(), v["running"].as_u64(), v["passed"].as_u64(), v["failing"][0].as_str()), (Some(3), Some(1), Some(1), Some("test")));
    }

    #[test]
    fn required_checks_come_from_the_required_status_checks_rules_only() {
        let b = json!([{"type": "pull_request"}, {"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "build"}, {"context": "test"}]}}]);
        assert_eq!(rules(&b), json!(["build", "test"]));
        assert_eq!(rules(&json!({"message": "Not Found"})), json!([]));
    }

    fn repo(checks: Value, pr: Value) -> Value {
        json!({"sha": "s1", "checks": checks, "runs": Value::Null, "pr": pr, "review": "none", "required": ["build", "e2e"]})
    }

    #[test]
    fn status_reads_red_before_running_and_required_checks_missing_from_the_run() {
        let c = |v: Value| status(&cfg(), &repo(v, Value::Null), 0);
        let red = c(json!({"sha": "s1", "total": 2, "running": 1, "failing": ["test"], "names": ["build", "test"]}));
        assert_eq!((red["checks"].as_str(), red["jobs"][0].as_str(), red["required_missing"][0].as_str()), (Some("red"), Some("test"), Some("e2e")));
        assert_eq!(c(json!({"sha": "s1", "total": 2, "running": 1, "failing": [], "names": []}))["checks"], "running");
        assert_eq!(c(json!({"sha": "s1", "total": 1, "running": 0, "failing": [], "names": ["build"]}))["checks"], "green");
        assert_eq!(c(json!({"sha": "OLD", "total": 1, "running": 0, "failing": ["x"], "names": []}))["checks"], "none", "checks of another commit do not count");
    }

    #[test]
    fn a_fresh_push_with_no_checks_yet_reads_as_running_for_the_watch_window() {
        let mut r = repo(Value::Null, Value::Null);
        r["pushed_ms"] = json!(1_000_000);
        assert_eq!(status(&cfg(), &r, 1_100_000)["checks"], "running");
        assert_eq!(status(&cfg(), &r, 1_000_000 + cfg().int("github_rt.push_watch_ms") + 1)["checks"], "none");
    }

    fn st(checks: &str, pr: &str, review: &str, conflict: bool, sha: &str) -> Value {
        json!({"checks": checks, "pr": pr, "number": 5, "review": review, "conflict": conflict, "sha": sha})
    }

    #[test]
    fn edges_fire_on_change_only_and_never_on_the_first_sight() {
        let kinds = |p: Option<Value>, n: Value| edges(p.as_ref(), &n).into_iter().map(|e| e.kind).collect::<Vec<_>>();
        assert!(kinds(None, st("red", "open", "none", false, "a")).is_empty(), "baseline");
        assert_eq!(kinds(Some(st("running", "open", "none", false, "a")), st("red", "open", "none", false, "a")), ["ci_red"]);
        assert!(kinds(Some(st("red", "open", "none", false, "a")), st("red", "open", "none", false, "a")).is_empty(), "still red");
        assert_eq!(kinds(Some(st("red", "open", "none", false, "a")), st("red", "open", "none", false, "b")), ["ci_red"], "a new commit that is red again");
        assert_eq!(kinds(Some(st("running", "open", "none", false, "a")), st("green", "open", "none", false, "a")), ["ci_green"]);
        assert_eq!(kinds(Some(st("green", "open", "none", false, "a")), st("none", "open", "none", false, "b")), Vec::<&str>::new(), "a new commit without checks is no edge");
        assert_eq!(kinds(Some(st("green", "open", "none", false, "a")), st("green", "merged", "none", false, "a")), ["pr_merged"]);
        assert_eq!(kinds(Some(st("green", "open", "none", false, "a")), st("green", "closed", "none", false, "a")), ["pr_closed"]);
        assert_eq!(kinds(Some(st("green", "open", "none", false, "a")), st("green", "open", "changes_requested", false, "a")), ["changes_requested"]);
        assert_eq!(kinds(Some(st("green", "open", "changes_requested", false, "a")), st("green", "open", "approved", false, "a")), ["approved"]);
        assert_eq!(kinds(Some(st("green", "open", "none", false, "a")), st("green", "open", "none", true, "a")), ["conflict"]);
        assert!(kinds(Some(st("green", "none", "none", false, "a")), st("green", "merged", "none", false, "a")).is_empty(), "a pull request first seen merged is no merge edge");
    }
}
