//! The read-only silent exits of `devswarm-child-drain` and `devswarm-parent-gate`, answered in the engine.
//!
//! These are the points where the Node hook has already passed its role and switch gates and still returns without
//! printing or writing anything, having looked only at the payload, the environment and one descriptor file:
//!
//! - `devswarm-child-drain` (PostToolUse): the tool is not Bash, the call is a subagent's own, the command reads the
//!   Primary channel (`inbox ... read-primary`), the workspace id is missing or unsafe, or the descriptor is missing,
//!   unreadable, not an object, or names no `inboxPath`.
//! - `devswarm-parent-gate` (Stop): the payload says `stop_hook_active: true`, which the shared stop policy allows before
//!   it reads anything.
//!
//! Everything past those points counts unread mail (the store, the NDJSON inbox, the reader's own cursor, a git
//! repository key) or writes (throttle state, loop counters), so it defers to Node. The engine therefore never allows
//! what Node would block or nudge: each answer here is an exit Node takes before it can do either.
//!
//! Both Node hooks install their stable launchers when loaded, after their own inert check and before `main`, so an
//! answer is given only when that install would change nothing (as `devswarm_role` does for the child-role hook).
//!
//! Mirrors `hooks/devswarm-child-drain.js` (`resolveCli`, `main`), `hooks/devswarm-parent-gate.js` (`main`, the launcher
//! install above it), `hooks/coordinator-detect.js` `isSubagentByPayload`, `hooks/lib/stop-policy.js` `stopHookActive` and
//! `companion/lib/liveness.js` `isSafeId`.
use crate::checks::Verdict;
use crate::checks::devswarm_role::{current_launcher, node_root, usable_settings};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::settings::get_bool;
use crate::defaults;
use crate::reqenv::RequestEnv;
use regex::Regex;
use serde_json::Value;

fn read_primary_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("devswarm_gates.readside_read_primary_re"), true))
}

/// The settings to read with, when the stable launchers the Node hook installs at load are already what it would write
/// (`want_watcher`: the Primary gate installs the watcher launcher too). `None`: Node would install one, or the engine
/// cannot read the home the way Node does.
fn settings_if_launchers_current(env: &RequestEnv, root: Option<&str>, want_watcher: bool) -> Option<Settings> {
    let st = usable_settings(env)?;
    let root = node_root(root.filter(|r| !r.is_empty())?)?;
    if get_bool(&st, defaults::raw("devswarm_role.sw_stable_launcher")) {
        current_launcher(&st.home, &root, "devswarm_role.launcher_cli")?;
        if want_watcher {
            current_launcher(&st.home, &root, "devswarm_role.launcher_watcher")?;
        }
    }
    Some(st)
}

/// `isSafeId`: non-empty, ASCII letters, digits and the extra characters only, never `.` or `..` or a name holding `..`.
fn safe_id(id: &str) -> bool {
    let extra = defaults::text("devswarm_gates.readside_id_extra");
    !id.is_empty() && id != "." && !id.contains("..") && id.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// JavaScript truthiness of a parsed JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_none_or(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// What the child drain nudge says when the base gate (switch, DevSwarm active, child role) has not already answered.
///
/// `Allow` only for the silent exits listed in the module docs; anything else, including every case this function cannot
/// prove silent, is `Defer`.
pub fn child_drain(p: &Value, env: &RequestEnv, plugin_root: Option<&str>) -> Verdict {
    let Some(st) = settings_if_launchers_current(env, plugin_root, false) else { return Verdict::Defer };
    if !p.is_object() {
        return Verdict::Defer; // a payload that is not an object takes Node paths this check does not follow
    }
    if p.get(defaults::text("devswarm_gates.readside_tool_field")).is_some_and(|t| t.as_str() != Some(defaults::text("devswarm_gates.bash_tool"))) {
        return Verdict::Allow;
    }
    if defaults::list("devswarm_gates.readside_subagent_fields").iter().any(|k| p.get(*k).is_some_and(|v| !v.is_null())) {
        return Verdict::Allow;
    }
    let command = p
        .get(defaults::text("devswarm_gates.readside_input_field"))
        .and_then(|t| t.get(defaults::text("devswarm_gates.readside_command_field")))
        .and_then(Value::as_str)
        .unwrap_or("");
    if read_primary_re().is_match(command) {
        return Verdict::Allow;
    }
    let id = match st.env.get(defaults::text("devswarm_gates.readside_builder_env")) {
        Some(id) if safe_id(id) => id,
        _ => return Verdict::Allow,
    };
    let path =
        format!("{}/{}/{id}{}", st.home, defaults::text("devswarm_gates.readside_descriptor_dir"), defaults::text("devswarm_gates.readside_descriptor_ext"));
    let Ok(bytes) = std::fs::read(&path) else { return Verdict::Allow }; // missing or unreadable: Node's catch, no descriptor
    let Some(desc) = String::from_utf8(bytes).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else {
        return Verdict::Defer; // text only JavaScript can parse (or invalid UTF-8) is not proof of "no descriptor"
    };
    match desc.get(defaults::text("devswarm_gates.readside_inbox_field")) {
        Some(inbox) if desc.is_object() && truthy(inbox) => Verdict::Defer,
        _ => Verdict::Allow,
    }
}

/// What the Primary Stop gate says when the base gate has deferred: allow when the model is already continuing because of
/// an earlier Stop block (`stop_hook_active` is exactly `true`), which Node decides before it reads any state.
pub fn parent_gate(p: &Value, env: &RequestEnv, plugin_root: Option<&str>) -> Verdict {
    if settings_if_launchers_current(env, plugin_root, true).is_none() || !p.is_object() {
        return Verdict::Defer;
    }
    if p.get(defaults::text("devswarm_gates.readside_stop_field")) == Some(&Value::Bool(true)) { Verdict::Allow } else { Verdict::Defer }
}
