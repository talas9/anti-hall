//! `ah-engine devswarm recover --id <ws> --request <id>`: the on-demand kill-and-resume of ONE workspace's session is REFUSED by the
//! engine (owner decision F: there is no Node rollback of a kill, so the engine never kills or resumes a session). A request is still
//! checked first, so the refusal names the real problem when there is one: a caller that is not the owner's own session (the role
//! matrix, then the automated-caller rule), an id that is not a plain workspace id, a request id that already ran, a descriptor
//! without a worktree and a session, a workspace already recovered `maxRecoveries` times. Every request that passes those checks gets
//! the explicit `native_refused` outcome, before any ledger line is written and before any process is looked at. The kill-and-resume is
//! the on-demand Node recovery. It is never scheduled and never started by a sweep
//! (`devswarm_act.automatic_kinds` and `devswarm_sup.duties` do not list it).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable descriptor or verdict is an absent one: the first is a refusal, the second counts as no recoveries
use super::setting;
use crate::checks::git::util::Settings;
use crate::defaults;
use crate::dsact::runner::Runner;
use serde_json::{Value, json};
use std::path::Path;

/// A refused request: `code` names the way (a key of `devswarm_sup.act_recover_reasons`), `why` is the text the caller gets.
struct Refusal {
    code: &'static str,
    why: String,
}

fn refuse(code: &'static str, why: String) -> Refusal {
    Refusal { code, why }
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
pub fn run(at: &Place, st: &Settings, _runner: &dyn Runner, id: &str, request: &str, _now: i64) -> (Value, i32) {
    let t0 = std::time::Instant::now();
    let (report, code) = match decide(at, st, id, request) {
        Ok(done) => done,
        Err(r) => {
            let reason = defaults::raw("devswarm_sup.act_recover_reasons").str_field(r.code);
            super::tick::emit_act(at.home, defaults::text("devswarm_sup.recover_duty"), id, "refused", reason, t0.elapsed().as_millis() as u64, request);
            crate::obs::counters::account("duty", defaults::text("devswarm_sup.recover_duty"), crate::obs::counters::Outcome::Refused, 0, t0.elapsed().as_micros() as u64);
            (json!({"outcome": "refused", "why": r.why}), defaults::num("devswarm_wire.usage_exit") as i32)
        }
    };
    if report["outcome"] == "handled" {
        super::tick::emit_act(at.home, defaults::text("devswarm_sup.recover_duty"), id, "ran", "", t0.elapsed().as_millis() as u64, request);
        crate::obs::counters::account("duty", defaults::text("devswarm_sup.recover_duty"), crate::obs::counters::Outcome::Ok, 0, t0.elapsed().as_micros() as u64);
    }
    (report, code)
}

fn decide(at: &Place, st: &Settings, id: &str, request: &str) -> Result<(Value, i32), Refusal> {
    let Place { home, state_dir, .. } = *at;
    let caller = st.env.get(defaults::text("devswarm_act.caller_env")).cloned().unwrap_or_default();
    if !caller.is_empty() && caller != defaults::text("devswarm_act.interactive_caller") {
        return Err(refuse("caller", defaults::render("devswarm_sup.msg_recover_caller", &[("caller", &caller)])));
    }
    if id.is_empty() || !crate::meshw::idlock::is_safe_id(id) {
        return Err(refuse("id", defaults::text("devswarm_sup.msg_recover_id").into()));
    }
    if request.is_empty() {
        return Err(refuse("request", defaults::text("devswarm_sup.msg_recover_request").into()));
    }
    if already_ran(state_dir, request) {
        return Err(refuse("duplicate", defaults::render("devswarm_sup.msg_recover_duplicate", &[("request", &request)])));
    }
    let keys = defaults::raw("devswarm_sup.recover_descriptor_keys");
    let desc: Option<Value> = std::fs::read_to_string(super::root(home).join(defaults::text("mesh_write.dir_workspaces")).join(format!("{id}.json")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let has = |k: &str| desc.as_ref().and_then(|d| d.get(keys.str_field(k))).and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has("worktree") || !has("session") {
        return Err(refuse("descriptor", defaults::render("devswarm_sup.msg_recover_descriptor", &[("id", &id)])));
    }
    let done = super::verdict::path(home, id)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("recoveries").and_then(Value::as_u64))
        .unwrap_or(0);
    let max = setting(st, "devswarm_sup.set_max_recoveries").as_u64().unwrap_or_default(); // keep: the shipped default always resolves; zero would refuse every recovery
    if done >= max {
        return Err(refuse("max", defaults::render("devswarm_sup.msg_recover_max", &[("id", &id), ("n", &done), ("max", &max)])));
    }
    // Owner decision F: the engine never kills or resumes a session, and there is no rollback of a kill. The request is refused here,
    // before the ledger or any process is touched, whatever `devswarm_sup.duties_off` says (an opt-out list is no authorisation for a
    // native kill). The kill-and-resume stays the on-demand Node recovery.
    Err(refuse("native_refused", defaults::text("devswarm_sup.msg_recover_native_refused").into()))
}
