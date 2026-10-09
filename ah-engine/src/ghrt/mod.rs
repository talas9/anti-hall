//! GitHub realtime (feature #20): the pull request and CI state of the repos the user's live sessions work in.
//!
//! Independent of DevSwarm. The repos are those of the working directories hooks report (`repos`), polled with conditional
//! `gh api` calls inside a rate budget (`poll`), summarised (`parse`) and offered to the consumers: `ah-engine gh status`, the
//! statusline segment `ah-engine gh segment`, and the `gh-rt-advisory` check, which tells a session about edges only (CI went
//! red or green, the pull request merged, changes requested). Every setting is in `github_rt.toml`.
pub mod api;
pub mod cfg;
pub mod parse;
pub mod poll;
pub mod ready;
pub mod repos;
#[cfg(test)]
mod tests;

use crate::cli::Parsed;
use cfg::Cfg;
use serde_json::{Value, json};

/// Record the working directory of a hook for the poller (the daemon calls this for every hook and dispatch request).
pub fn note_cwd(eff: &crate::cfgstore::Effective, cwd: &str) {
    if cwd.is_empty() || !eff.boolean("github_rt.enabled") {
        return;
    }
    let files = eff.get("github_rt.files").map(|r| r.value.clone()).unwrap_or(Value::Null);
    let name = |k: &str| files.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let dir = crate::paths::dir().join(name("dir"));
    repos::note(
        &dir,
        &name("cwds"),
        cwd,
        crate::health::now_ms(),
        eff.num("github_rt.note_every_ms"),
        eff.num("github_rt.cwd_ttl_ms"),
        eff.num("github_rt.max_cwds") as usize,
    );
}

/// The `gh_poll` scheduled job (`ah-engine gh_poll --json`): one tick. Always exits 0 (a missing gh, a logged-out gh or a
/// network that is down is a state shown by `gh status`, never an error of the job).
pub fn run_poll(p: &Parsed) -> i32 {
    let cfg = Cfg::load();
    let report = poll::tick(&cfg, &api::GhRunner::new(&cfg), crate::health::now_ms(), false);
    if p.json {
        println!("{}", json!({"polled": report.polled, "calls": report.calls, "edges": report.edges}));
    }
    0
}

/// `ah-engine gh <status|segment|poll>`.
pub fn run_cmd(p: &Parsed) -> i32 {
    let cfg = Cfg::load();
    let sub = p.rest.first().map_or("status", String::as_str);
    let flag = |name: &str| {
        let f = format!("--{name}");
        p.rest.iter().position(|a| *a == f).and_then(|i| p.rest.get(i + 1)).cloned()
    };
    match sub {
        "status" => {
            let v = status_json(&cfg, crate::health::now_ms());
            if p.json {
                println!("{v}");
            } else {
                println!("{}", crate::cli::human(&v));
            }
            0
        }
        "segment" => {
            let cwd = flag("cwd").or_else(|| std::env::current_dir().ok().map(|d| d.to_string_lossy().into_owned())).unwrap_or_default();
            let s = segment(&cfg, &cwd, crate::health::now_ms());
            if p.json {
                println!("{}", json!({"segment": s}));
            } else if !s.is_empty() {
                println!("{s}");
            }
            0
        }
        "poll" => {
            let force = p.rest.iter().any(|a| a == "--force");
            let report = poll::tick(&cfg, &api::GhRunner::new(&cfg), crate::health::now_ms(), force);
            let v = json!({"polled": report.polled, "calls": report.calls, "edges": report.edges});
            if p.json {
                println!("{v}");
            } else {
                println!("{}", crate::cli::human(&v));
            }
            0
        }
        _ => 64,
    }
}

/// Everything `gh status` shows, from the state file alone (no network).
pub fn status_json(cfg: &Cfg, now: u64) -> Value {
    let st = poll::load(cfg);
    let cap = poll::budget_cap(cfg, st.rate.limit);
    let window_left = (st.window_start_ms + cfg.int("github_rt.window_ms")).saturating_sub(now);
    let measure: serde_json::Map<String, Value> = st
        .measure
        .iter()
        .map(|(k, c)| (k.clone(), json!({"answers": c.n, "used_delta_sum": c.sum, "free": c.zero, "max_delta": c.max, "cost_per_answer": if c.n > 0 { c.sum as f64 / c.n as f64 } else { 0.0 }})))
        .collect();
    let repos: Vec<Value> = st
        .repos
        .values()
        .map(|r| {
            json!({
                "root": r.root, "slug": r.slug, "kind": r.kind, "branch": r.branch, "sha": r.sha,
                "status": r.status, "pr": r.pr, "last_poll_ms": r.last_poll_ms, "next_poll_in_ms": r.next_poll_ms.saturating_sub(now),
                "error_status": r.err_status, "error_for_ms": r.err_until_ms.saturating_sub(now),
            })
        })
        .collect();
    let recent_edges: Vec<Value> = poll::edges(cfg).into_iter().rev().take(cfg.int("github_rt.status_edges") as usize).collect();
    json!({
        "enabled": cfg.flag("github_rt.enabled"), "gh": if st.gh.is_empty() { "unknown" } else { st.gh.as_str() },
        "hold": {"reason": st.hold_reason, "for_ms": st.hold_until_ms.saturating_sub(now)},
        "last_error": st.last_error, "ticked_ms": st.ticked_ms,
        "rate": {"limit": st.rate.limit, "remaining": st.rate.remaining, "used": st.rate.used, "resets_in_ms": st.rate.reset_ms.saturating_sub(now)},
        "budget": {"calls_in_window": st.window_calls, "cap": cap, "window_resets_in_ms": window_left, "calls_total": st.calls_total, "count_304": cfg.int("github_rt.count_304") == 1},
        "measure": measure,
        "repos": repos, "edges": recent_edges,
    })
}

/// The statusline piece for the repo that holds `cwd`, empty when there is nothing to say (no repo, stale data, gh unusable).
pub fn segment(cfg: &Cfg, cwd: &str, now: u64) -> String {
    let st = poll::load(cfg);
    if !cfg.flag("github_rt.enabled") || st.gh != "ok" {
        return String::new();
    }
    let Some(repo) = st.repos.values().filter(|r| poll::inside(&r.root, cwd)).max_by_key(|r| r.root.len()) else { return String::new() };
    if !repo.known || now.saturating_sub(repo.last_poll_ms) > cfg.int("github_rt.stale_ms") {
        return String::new();
    }
    parse::segment(cfg, &repo.status)
}
