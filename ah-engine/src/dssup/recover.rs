//! `ah-engine devswarm recover --id <ws> --request <id>`: the on-demand kill-and-resume of ONE workspace's session. It is never
//! scheduled and never started by a sweep (`devswarm_act.automatic_kinds` and `devswarm_sup.duties` do not list it).
//!
//! The engine decides whether it may start and refuses before anything is touched: a caller that is not the owner's own session
//! (the role matrix, then the automated-caller rule), an id that is not a plain workspace id, a request id that already ran, a
//! descriptor without a worktree and a session, a workspace already recovered `maxRecoveries` times. What then runs is Node's
//! `devswarm-recover.js` `run`, unchanged: it resolves the process (exactly one match or it abstains), confirms its identity and
//! working directory right before SIGTERM and again before SIGKILL, and resumes the session headless. The engine does not
//! re-implement process matching: that code differs per operating system and its fixtures live with Node's tests.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable descriptor or verdict is an absent one: the first is a refusal, the second counts as no recoveries
use super::setting;
use crate::checks::git::util::Settings;
use crate::defaults;
use crate::dsact::runner::Runner;
use serde_json::{Value, json};
use std::path::Path;

fn refuse(why: String) -> (Value, i32) {
    (json!({"outcome": "refused", "why": why}), defaults::num("devswarm_wire.usage_exit") as i32)
}

fn ledger(state_dir: &Path) -> std::path::PathBuf {
    state_dir.join(defaults::text("devswarm_sup.recover_ledger"))
}

fn already_ran(state_dir: &Path, request: &str) -> bool {
    std::fs::read_to_string(ledger(state_dir))
        .ok()
        .is_some_and(|t| t.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).any(|v| v.get("request").and_then(Value::as_str) == Some(request)))
}

/// Where a recovery runs: the home directory, the plugin root and the engine state directory.
pub struct Place<'a> {
    /// The home directory.
    pub home: &'a Path,
    /// The plugin root.
    pub root: &'a Path,
    /// The engine state directory (the request ledger lives there).
    pub state_dir: &'a Path,
}

/// Run the recovery request. Returns the report and the exit code (0 when the run was handled, whatever the outcome Node reports).
pub fn run(at: &Place, st: &Settings, runner: &dyn Runner, id: &str, request: &str, now: i64) -> (Value, i32) {
    let Place { home, root, state_dir } = *at;
    let caller = st.env.get(defaults::text("devswarm_act.caller_env")).cloned().unwrap_or_default();
    if !caller.is_empty() && caller != defaults::text("devswarm_act.interactive_caller") {
        return refuse(defaults::render("devswarm_sup.msg_recover_caller", &[("caller", &caller)]));
    }
    if id.is_empty() || !crate::meshw::idlock::is_safe_id(id) {
        return refuse(defaults::text("devswarm_sup.msg_recover_id").into());
    }
    if request.is_empty() {
        return refuse(defaults::text("devswarm_sup.msg_recover_request").into());
    }
    if already_ran(state_dir, request) {
        return refuse(defaults::render("devswarm_sup.msg_recover_duplicate", &[("request", &request)]));
    }
    let keys = defaults::raw("devswarm_sup.recover_descriptor_keys");
    let desc: Option<Value> = std::fs::read_to_string(super::root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}.json")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let has = |k: &str| desc.as_ref().and_then(|d| d.get(keys.str_field(k))).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has("worktree") || !has("session") {
        return refuse(defaults::render("devswarm_sup.msg_recover_descriptor", &[("id", &id)]));
    }
    let done = super::verdict::path(home, id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("recoveries").and_then(Value::as_u64))
        .unwrap_or(0);
    let max = setting(st, "devswarm_sup.set_max_recoveries").as_u64().unwrap_or_default(); // keep: the shipped default always resolves; zero would refuse every recovery
    if done >= max {
        return refuse(defaults::render("devswarm_sup.msg_recover_max", &[("id", &id), ("n", &done), ("max", &max)]));
    }
    // the request is recorded BEFORE the run: a run that dies half way is never repeated by the same request
    crate::dsact::exec::append_line(&ledger(state_dir), &json!({"ts": now, "request": request, "id": id}));
    let ctx = super::tick::Ctx { home, root, st, now, engine_pokes: true };
    let r = super::tick::node(runner, &ctx, defaults::text("devswarm_sup.recover_snippet"), &[id], defaults::num("devswarm_sup.recover_timeout_ms"));
    let body: Option<Value> = r.stdout.lines().rev().find(|l| !l.trim().is_empty()).and_then(|l| serde_json::from_str(l).ok());
    match body {
        Some(b) if r.ok => (json!({"outcome": "handled", "id": id, "request": request, "node": b}), 0),
        _ => {
            let why = r.error.clone().unwrap_or_else(|| r.stderr.chars().take(defaults::num("devswarm_sup.detail_chars") as usize).collect());
            (json!({"outcome": "failed", "id": id, "request": request, "why": defaults::render("devswarm_sup.msg_recover_failed", &[("why", &why)])}), 1)
        }
    }
}
