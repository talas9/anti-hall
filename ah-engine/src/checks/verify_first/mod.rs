//! Built-in checks `verify-first-subagent` (SubagentStart) and `verify-first-full` (SessionStart): the verify-first
//! protocol text the Node hooks inject, decided in the engine.
//!
//! Both hooks print one JSON line carrying a text that depends only on the switches (`context.protocolLevel`,
//! `context.verifyFirst*`, the skip file), the host (Claude or Codex, read from the payload), the DevSwarm role of the
//! session (an environment variable) and the plugin root (the compact text names `<root>/PROTOCOL.md`). Every one of those
//! is resolved from the request's own environment (D76). When the plugin root cannot be proven the check defers to the
//! Node hook rather than print a different path (D74).
//!
//! Mirrors `hooks/verify-first-subagent.js`, `hooks/verify-first-full.js`, `hooks/verify-first-core.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::msg::advisory_json;
use crate::checks::guardkit::settings::{get_bool, get_enum, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Verdict, lit_re};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

use crate::checks::git::util::Settings;

#[cfg(test)]
mod tests;

/// True in the headless judge child, where a hook that requires `judge-child-exit.js` first prints nothing.
fn judge_child(st: &Settings) -> bool {
    let e = defaults::raw("verify_first.judge_child_env");
    st.env.get(e.str_field("name")).is_some_and(|v| v == e.str_field("on"))
}

/// `isChildWorkspace(env)`: the DevSwarm source branch variable is set to something other than white space.
fn child_workspace(st: &Settings) -> bool {
    st.env.get(defaults::text("verify_first.child_branch_env")).is_some_and(|v| !js_trim(v).is_empty())
}

/// `detectPlatform(payload) === 'codex'`.
fn codex_payload(p: &Value) -> bool {
    if !p.is_object() {
        return false;
    }
    if p.get("turn_id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return true;
    }
    let tp = p.get("transcript_path").and_then(Value::as_str).unwrap_or("");
    defaults::list("verify_first.codex_transcript_patterns").into_iter().any(|re| lit_re(re).is_match(tp))
}

/// The plugin root the way Node derives it: the directory two levels above the real location of
/// `hooks/verify-first-core.js` under the root the host named. `None` when that cannot be proven.
fn plugin_root(opts: &Value, env: &RequestEnv) -> Option<String> {
    let given = opts.get("plugin_root").and_then(Value::as_str).or_else(|| env.get(defaults::env_name("plugin_root")))?;
    if !given.starts_with('/') {
        return None;
    }
    let real = std::fs::canonicalize(format!("{given}/{}", defaults::text("verify_first.root_probe"))).ok()?;
    let root = real.parent()?.parent()?;
    root.to_str().map(str::to_string)
}

/// A compact text with the plugin root put in.
fn with_root(text: &str, root: &str) -> String {
    text.replace(defaults::text("verify_first.abs_marker"), root)
}

/// The SubagentStart decision.
///
/// Mirrors `hooks/verify-first-subagent.js` `main`.
pub fn decide_subagent(st: &Settings, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
    if !get_bool(st, defaults::raw("verify_first.setting_subagent")) || is_skipped(st, defaults::text("verify_first.guard_subagent")) {
        return Some(Verdict::Allow);
    }
    let base = if get_enum(st, defaults::raw("verify_first.setting_level")) == "full" {
        defaults::text("verify_first.subagent_full").to_string()
    } else {
        let root = plugin_root(opts, env)?;
        format!("{}\n{}", with_root(defaults::text("verify_first.compact_subagent"), &root), defaults::text("verify_first.worker"))
    };
    let text = if child_workspace(st) { format!("{base}\n{}", defaults::text("verify_first.child_note")) } else { base };
    Some(Verdict::Advisory(advisory_json("SubagentStart", &text)))
}

/// The SessionStart decision.
///
/// Mirrors `hooks/verify-first-full.js` `main`.
pub fn decide_full(p: &Value, st: &Settings, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
    if judge_child(st) || !get_bool(st, defaults::raw("verify_first.setting_session")) {
        return Some(Verdict::Allow);
    }
    let codex = codex_payload(p);
    let text = if get_enum(st, defaults::raw("verify_first.setting_level")) == "full" {
        defaults::text(if codex { "verify_first.full_codex" } else { "verify_first.full_claude" }).to_string()
    } else {
        let root = plugin_root(opts, env)?;
        let mut t = with_root(defaults::text("verify_first.compact_session"), &root);
        if !get_bool(st, defaults::raw("verify_first.setting_orchestration")) {
            t.push('\n');
            t.push_str(defaults::text(if codex { "verify_first.mn_line_codex" } else { "verify_first.mn_line" }));
        }
        t
    };
    Some(Verdict::Advisory(advisory_json("SessionStart", &text)))
}

/// The registered `verify-first-subagent` check.
pub struct VerifyFirstSubagent;

impl Check for VerifyFirstSubagent {
    fn name(&self) -> &'static str {
        "verify-first-subagent"
    }

    fn summary(&self) -> &'static str {
        defaults::text("verify_first.summary_subagent")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, _payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        decide_subagent(&Settings::from_env(env), opts, env)
    }
}

/// The registered `verify-first-full` check.
pub struct VerifyFirstFull;

impl Check for VerifyFirstFull {
    fn name(&self) -> &'static str {
        "verify-first-full"
    }

    fn summary(&self) -> &'static str {
        defaults::text("verify_first.summary_full")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        decide_full(payload, &Settings::from_env(env), opts, env)
    }
}
