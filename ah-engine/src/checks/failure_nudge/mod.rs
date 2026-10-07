//! Built-in `check = "failure-root-cause-nudge"`: a port of the Node failure-root-cause-nudge hook (PostToolUseFailure on
//! Bash; advisory only, never blocks).
//!
//! When a Bash call fails, the hook injects one short line pointing at the root-cause skill. The noise filter
//! (`guards.failureNudgeFilter`, default on) stays silent for an interrupt, a harness refusal, an expected exit 1 from a
//! predicate command ([`expected`]), and for every nudge after the first in one turn ([`turn_gate`], whose state is the
//! file the Node hook keeps).
//!
//! Differences from the Node hook (deliberate): a command whose cut to the display length would split a surrogate pair
//! defers (Node would keep a lone surrogate); without a home directory the check defers. The hook is not a guard event,
//! so a deferral is a missed offload, never a missed block.
//!
//! Mirrors `hooks/failure-root-cause-nudge.js`.
pub mod expected;
#[cfg(test)]
mod tests;

use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::{collapse_ws, js_trim, js_truthy, slice_utf16};
use crate::checks::guardkit::turn_gate::{self, Ask};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// The command as the advisory shows it: white space collapsed, trimmed, cut to the configured length with an ellipsis.
/// `None` when the cut would split a surrogate pair.
///
/// Mirrors `truncateCommand`.
fn truncate_command(cmd: &str) -> Option<String> {
    let one = js_trim(&collapse_ws(cmd)).to_string();
    let max = defaults::num("failure_nudge.max_cmd_len") as usize;
    if one.encode_utf16().count() <= max {
        return Some(one);
    }
    Some(format!("{}{}", slice_utf16(&one, max)?, defaults::text("failure_nudge.ellipsis")))
}

/// The check's decision on one payload. `None`: nothing to say.
///
/// Mirrors `hooks/failure-root-cause-nudge.js` `main`.
pub fn decide(p: &Value, st: &Settings) -> Option<Verdict> {
    if !get_bool(st, defaults::raw("failure_nudge.setting")) || is_skipped(st, defaults::text("failure_nudge.guard_name")) {
        return None;
    }
    if !js_truthy(Some(p)) || p.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return None;
    }
    let cmd = p.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str).unwrap_or("");
    if get_bool(st, defaults::raw("failure_nudge.filter_setting")) {
        let err = p.get("error").and_then(Value::as_str).unwrap_or("");
        if p.get("is_interrupt") == Some(&Value::Bool(true)) || expected::is_harness_refusal(err) || expected::is_expected_nonzero(cmd, err) {
            return None;
        }
        let agent = p.get("agent_id").and_then(Value::as_str).unwrap_or("");
        let ask = Ask { home: &st.home, session_id: p.get("session_id"), agent_id: agent, transcript_path: p.get("transcript_path"), key: defaults::text("failure_nudge.gate_key") };
        if st.home.is_empty() && js_truthy(ask.session_id) {
            return Some(Verdict::Defer);
        }
        if !turn_gate::first_this_turn(&ask) {
            return None;
        }
    }
    let shown = truncate_command(cmd);
    let Some(shown) = shown else { return Some(Verdict::Defer) };
    let cmd_part = if shown.is_empty() { String::new() } else { format!("{}{shown}{}", defaults::text("failure_nudge.cmd_open"), defaults::text("failure_nudge.cmd_close")) };
    let what = msg::render("failure_nudge.msg_what", &[("cmd", &cmd_part)]);
    let text = msg::message(Kind::Tip, defaults::text("failure_nudge.message_guard"), &Parts { what: &what, instead: defaults::text("failure_nudge.msg_instead"), ..Parts::default() });
    Some(Verdict::Advisory(msg::advisory_json(defaults::text("failure_nudge.event"), &text)))
}

/// The registered `failure-root-cause-nudge` check.
pub struct FailureRootCauseNudge;

impl Check for FailureRootCauseNudge {
    fn name(&self) -> &'static str {
        "failure-root-cause-nudge"
    }

    fn summary(&self) -> &'static str {
        defaults::text("failure_nudge.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.tool == Some("Bash")).then_some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        // a silent answer is an answer: `None` would hand the call to the Node hook
        Some(decide(payload, &Settings::from_env(env)).unwrap_or(Verdict::Allow))
    }
}
