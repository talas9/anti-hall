//! Merge readiness (feature 4): the `ready` notice and the optional auto-merge, with their ledger, action log and mistake follow-ups.
//!
//! * The rule for "ready" is the plugin script (`rules/gh-rt.js`, `ghReady`); this module carries its answer.
//! * The notice is the `ready` edge (once per head commit: the ledger key `ready:<repo>#<number>:<sha>`), told to sessions by the
//!   gh-rt-advisory check when `github_rt.ready_notify` is on.
//! * The auto-merge (`github_rt.ready_auto_merge`, default on by owner decision) runs `gh pr merge --merge --match-head-commit`
//!   (`ready_merge_argv`, never `--admin`: GitHub's branch protection and required reviews still decide) once per head commit
//!   (key `merge:<repo>#<number>:<sha>`, claimed in the ledger BEFORE the command runs, so a crash in between never repeats it),
//!   after a live re-check of every condition. GitHub's own refusal is logged as `refused`, not as an error.
//! * Afterwards the merge is checked for mistakes: the checks of the merge commit on the base branch (red), and the base's recent
//!   commits (a revert of this pull request). Results go to the action log (`actlog`) and the shared telemetry schema.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable ledger is an empty one for the notice (it is told again, harmless) and a refusal for the merge (see `claim`)
use super::cfg::Cfg;
use super::poll::{Ctx, Got, Repo, State};
use super::{api, parse};
use crate::actlog::{self, Action};
use serde_json::{Value, json};
use std::path::PathBuf;

fn word(cfg: &Cfg, k: &str) -> String {
    cfg.txt("github_rt.ready_actions", k)
}

fn ledger_path(cfg: &Cfg) -> PathBuf {
    super::repos::file(cfg, "ledger")
}

fn ledger_keys(cfg: &Cfg) -> Vec<String> {
    std::fs::read_to_string(ledger_path(cfg))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v.get("key").and_then(Value::as_str).map(String::from))
        .collect()
}

fn ledger_add(cfg: &Cfg, key: &str, state: &str, now: u64) {
    if let Err(e) = std::fs::create_dir_all(super::repos::dir(cfg)) {
        crate::discard::note("ghrt_ledger_dir", &e.to_string());
    }
    crate::dsact::exec::append_line(&ledger_path(cfg), &json!({"key": key, "state": state, "ts": now}));
}

/// Whether `key` is already in the ledger in any state.
pub(super) fn seen(cfg: &Cfg, key: &str) -> bool {
    ledger_keys(cfg).iter().any(|k| k == key)
}

/// Record that the ready notice for `key` was told.
pub(super) fn ledger_note(cfg: &Cfg, key: &str, now: u64) {
    ledger_add(cfg, key, "told", now);
}

/// Claim `key` for this process: false when it is already claimed (a done, failed, refused or in-doubt key is never run twice).
/// A short lock file makes the check and the append one step against another process (`gh poll --force` beside the scheduled job).
fn claim(cfg: &Cfg, key: &str, now: u64) -> bool {
    let lock = ledger_path(cfg).with_extension("lock");
    let stale = cfg.int("github_rt.ready_merge_timeout_ms").saturating_mul(2);
    if std::fs::metadata(&lock).and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_millis() as u64 > stale) {
        crate::discard::harmless(std::fs::remove_file(&lock)); // keep: a lock a crashed run left behind (older than twice the longest merge)
    }
    if std::fs::create_dir_all(super::repos::dir(cfg)).is_err() || std::fs::OpenOptions::new().write(true).create_new(true).open(&lock).is_err() {
        return false; // another process is claiming right now, or the directory is unwritable: do not merge
    }
    let fresh = !seen(cfg, key);
    if fresh {
        ledger_add(cfg, key, "claimed", now);
    }
    crate::discard::harmless(std::fs::remove_file(&lock)); // keep: the lock only has to exist while claiming
    fresh
}

/// The key of the ready notice for a head commit.
pub(super) fn ready_key(slug: &str, number: u64, sha: &str) -> String {
    format!("ready:{slug}#{number}:{sha}")
}

fn merge_key(slug: &str, number: u64, sha: &str) -> String {
    format!("merge:{slug}#{number}:{sha}")
}

fn target(slug: &str, number: u64, sha: &str) -> String {
    format!("{slug}#{number}@{sha}")
}

fn emit_act(feature: &str, action: &str, outcome: crate::telemetry::event::Outcome, ms: u64, target: &str, reason: &str, key: &str) {
    let tok = actlog::token;
    crate::telemetry::emit::act(&crate::telemetry::emit::ActRec { feature, action, outcome, latency_ms: ms, target: &tok(target), inputs: "", reason: &tok(reason), action_id: &tok(key) });
}

/// Log the notice of a ready pull request (the `ready` edge was recorded).
pub(super) fn log_notice(cfg: &Cfg, status: &Value, slug: &str, now: u64) {
    let (n, sha) = (status["number"].as_u64().unwrap_or(0), status["sha"].as_str().unwrap_or(""));
    let (feature, action) = (word(cfg, "feature"), word(cfg, "notify"));
    let t = target(slug, n, sha);
    actlog::record(&cfg.state_dir(), &Action { feature: &feature, action: &action, target: &t, inputs: status["ready_conditions"].clone(), outcome: "ok", reason: "", latency_ms: 0 }, now);
    emit_act(&feature, &action, crate::telemetry::event::Outcome::Allow, 0, &t, "", &ready_key(slug, n, sha));
}

fn failed_conditions(c: &Value) -> String {
    c.as_object().map(|m| m.iter().filter(|(_, v)| **v == json!(false)).map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(",")).unwrap_or_default()
}

/// The auto-merge for the repo's pull request, when `status` says ready. Idempotent per head commit; live re-check first.
pub(super) fn try_merge(ctx: &Ctx, st: &mut State, repo: &mut Repo, status: &Value, prev_used: &mut Option<(u64, u64)>) {
    let cfg = ctx.cfg;
    if !cfg.flag("github_rt.ready_enabled") || !cfg.flag("github_rt.ready_auto_merge") || status["ready"] != json!(true) {
        return;
    }
    let (number, sha) = (status["number"].as_u64().unwrap_or(0), status["sha"].as_str().unwrap_or("").to_string());
    if number == 0 || sha.is_empty() || repo.slug.is_empty() {
        return;
    }
    let key = merge_key(&repo.slug, number, &sha);
    if seen(cfg, &key) {
        return;
    }
    let (feature, action) = (word(cfg, "feature"), word(cfg, "merge"));
    let t = target(&repo.slug, number, &sha);
    let started = std::time::Instant::now();
    let log = |outcome: &str, reason: &str, inputs: Value| {
        let ms = started.elapsed().as_millis() as u64;
        actlog::record(&cfg.state_dir(), &Action { feature: &feature, action: &action, target: &t, inputs, outcome, reason, latency_ms: ms }, ctx.now);
        let o = match outcome {
            "ok" => crate::telemetry::event::Outcome::Allow,
            "refused" => crate::telemetry::event::Outcome::Block,
            _ => crate::telemetry::event::Outcome::Error,
        };
        emit_act(&feature, &action, o, ms, &t, reason, &key);
    };
    // the live re-check: read the pull request again (a conditional call: a 304 confirms nothing changed) and decide again
    let again = ctx.poll_repo(st, repo, prev_used).then(|| parse::status(cfg, &serde_json::to_value(&*repo).unwrap_or(Value::Null), ctx.now)).flatten();
    let Some(again) = again else {
        return; // GitHub could not be asked now (budget, backoff, error): nothing is claimed, the next tick tries again
    };
    let same = again["number"].as_u64() == Some(number) && again["sha"].as_str() == Some(sha.as_str());
    if again["ready"] != json!(true) || !same {
        let why = if same { format!("{}: {}", word(cfg, "live_recheck_failed"), failed_conditions(&again["ready_conditions"])) } else { word(cfg, "head_moved") };
        log("refused", &why, again["ready_conditions"].clone());
        return;
    }
    if !claim(cfg, &key, ctx.now) {
        return;
    }
    let argv: Vec<String> = cfg
        .strs("github_rt.ready_merge_argv")
        .iter()
        .map(|a| a.replace("{number}", &number.to_string()).replace("{slug}", &repo.slug).replace("{sha}", &sha))
        .collect();
    let inputs = again["ready_conditions"].clone();
    let res = ctx.run.merge(&argv, cfg.int("github_rt.ready_merge_timeout_ms"));
    let (outcome, reason) = match res {
        Ok((true, _)) => ("ok", String::new()),
        Ok((false, text)) => {
            let low = text.to_lowercase();
            let rule = cfg.strs("github_rt.ready_refusal_patterns").iter().any(|p| low.contains(&p.to_lowercase()));
            (if rule { "refused" } else { "failed" }, text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").chars().take(cfg.int("github_rt.error_chars") as usize).collect())
        }
        Err(api::Fail::Missing) => ("failed", cfg.word("state_missing", &[])),
        Err(api::Fail::Timeout) => ("failed", String::from("timeout")),
        Err(api::Fail::NoResponse(t)) => ("failed", t.chars().take(cfg.int("github_rt.error_chars") as usize).collect()),
    };
    ledger_add(cfg, &key, outcome, ctx.now);
    log(outcome, &reason, inputs);
    if outcome == "ok" {
        let f = cfg.value("github_rt.ready_followup");
        let wait = f["wait_ms"].as_u64().unwrap_or(0);
        let info = json!({"slug": repo.slug, "number": number, "sha": sha, "base": status["base"], "title": status["title"], "merged_ms": ctx.now});
        actlog::followup_add(&cfg.state_dir(), &feature, &action, &t, ctx.now + wait, info, ctx.now);
        repo.next_poll_ms = ctx.now; // poll again at once: the merge shows up as the pr_merged edge
    }
}

fn fetch_val(ctx: &Ctx, st: &mut State, repo: &mut Repo, key: &str, extra: &[(&str, &str)], prev_used: &mut Option<(u64, u64)>, parse_it: &dyn Fn(&Value) -> Value) -> Option<Value> {
    let path = ctx.path(key, repo, extra);
    match ctx.fetch(st, repo, &path, true, prev_used, parse_it) {
        Got::Val(v) if !v.is_null() => Some(v),
        _ => None,
    }
}

/// The follow-ups of past merges that are due: is the base branch red on the merge commit, did a commit revert it?
pub(super) fn followups(ctx: &Ctx, st: &mut State, prev_used: &mut Option<(u64, u64)>) {
    let cfg = ctx.cfg;
    let (feature, merge) = (word(cfg, "feature"), word(cfg, "merge"));
    let window = format!("{merge}_window");
    let f = cfg.value("github_rt.ready_followup");
    let (retry, give_up, revert_window) = (f["retry_ms"].as_u64().unwrap_or(0), f["give_up_ms"].as_u64().unwrap_or(0), f["revert_window_ms"].as_u64().unwrap_or(0));
    for fu in actlog::followups_due(&cfg.state_dir(), &feature, ctx.now) {
        let (action, tgt) = (fu["action"].as_str().unwrap_or("").to_string(), fu["target"].as_str().unwrap_or("").to_string());
        let c = &fu["ctx"];
        let (slug, number) = (c["slug"].as_str().unwrap_or("").to_string(), c["number"].as_u64().unwrap_or(0));
        let merged_ms = c["merged_ms"].as_u64().unwrap_or(0);
        let mut repo = Repo { slug: slug.clone(), kind: String::from("github"), ..Repo::default() };
        let num = number.to_string();
        let done = |res: &str| actlog::followup_done(&cfg.state_dir(), &feature, &action, &tgt, res, None, ctx.now);
        let later = |ms: u64| actlog::followup_done(&cfg.state_dir(), &feature, &action, &tgt, "", Some(ctx.now + ms), ctx.now);
        let give_up_now = || ctx.now.saturating_sub(merged_ms) >= give_up;
        let mistake = |kind_key: &str, detail_key: &str| actlog::mistake(&cfg.state_dir(), &feature, &merge, &tgt, &word(cfg, kind_key), &word(cfg, detail_key), ctx.now);
        let Some(info) = fetch_val(ctx, st, &mut repo, "merge_info", &[("number", &num)], prev_used, &|b| parse::merge_info(b)) else {
            if give_up_now() { done("unknown") } else { later(retry) }
            continue;
        };
        let (merge_sha, base) = (info["merge_commit_sha"].as_str().unwrap_or("").to_string(), info["base"].as_str().unwrap_or("").to_string());
        if info["merged"] != json!(true) || merge_sha.is_empty() {
            if give_up_now() { done("unknown") } else { later(retry) }
            continue;
        }
        repo.sha = merge_sha.clone();
        let reverted = |st: &mut State, repo: &mut Repo, prev_used: &mut Option<(u64, u64)>| -> Option<bool> {
            let title = c["title"].as_str().unwrap_or("").to_string();
            let ms = merge_sha.clone();
            fetch_val(ctx, st, repo, "commits", &[("base", &base)], prev_used, &move |b| parse::revert_check(b, &ms, &title)).map(|v| v["reverted"] == json!(true))
        };
        if action == merge {
            let sha = merge_sha.clone();
            let Some(ck) = fetch_val(ctx, st, &mut repo, "checks", &[], prev_used, &|b| parse::runs(cfg, b, "check_runs", &sha)) else {
                if give_up_now() { done("unknown") } else { later(retry) }
                continue;
            };
            if ck["running"].as_u64().unwrap_or(0) > 0 && !give_up_now() {
                later(retry);
                continue;
            }
            let red = ck["failing"].as_array().is_some_and(|a| !a.is_empty());
            let rev = reverted(st, &mut repo, prev_used) == Some(true);
            if red {
                mistake("mistake_ci", "detail_ci");
            }
            if rev {
                mistake("mistake_reverted", "detail_reverted");
            }
            if red || rev {
                done("mistake");
            } else {
                // clean so far: look for a revert until the window closes (a second follow-up; this one is not counted as verified)
                done("window");
                let due = (merged_ms + revert_window).max(ctx.now);
                actlog::followup_add(&cfg.state_dir(), &feature, &window, &tgt, due, c.clone(), ctx.now);
            }
        } else if reverted(st, &mut repo, prev_used) == Some(true) {
            mistake("mistake_reverted", "detail_reverted");
            done("mistake");
        } else {
            done("clean");
        }
    }
}
