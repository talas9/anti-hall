//! Built-in checks `devswarm-parent-inbox` and `devswarm-child-turn`: the gate of the two DevSwarm UserPromptSubmit
//! hooks, answered in the engine.
//!
//! Both Node hooks are silent (exit 0, no output, no state written) unless this session is an active DevSwarm Primary
//! (parent inbox) or an active DevSwarm child workspace (child turn). Only the silent cases are decided here; they are
//! the common ones, since most sessions are not DevSwarm sessions at all. Everything else defers to the Node hook:
//! the Primary hook reads the roster, the shared store, the app database and the daemon heartbeat and keeps dedupe
//! state, and the child hook writes a heartbeat and a workspace descriptor, spawns git and runs the mesh registration
//! on every turn. None of that has an engine owner yet (D45, the mesh and mailbox, is the prerequisite), so the engine
//! neither renders those segments nor keeps a dedupe state of its own that could disagree with Node's.
//!
//! A session is silent for a hook when any one of these holds (each alone makes the Node hook return before it
//! writes anything):
//! 1. the process is a Jev judge child (`ANTIHALL_JUDGE_CHILD=1`);
//! 2. the role does not match (the Primary hook in a child workspace, the child hook outside one);
//! 3. the hook's switch (`devswarm.parentInbox` / `devswarm.childTurn`) is off;
//! 4. DevSwarm is inactive (kill switch, `devswarm.supervisorMode` off, or auto mode without a repository id).
//!
//! Mirrors `hooks/lib/devswarm-primary-gate.js` `inert`, `hooks/lib/devswarm-detect.js` `isDevswarmActive` and
//! `hooks/lib/devswarm-role.js` `isChildWorkspace`, which both hooks call before anything else.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, read_object, stored_options};
use crate::checks::guardkit::text::{js_string_of, js_trim};
use crate::checks::{Check, Verdict};
use crate::defaults::{self, V};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// Which of the two hooks is being gated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// `devswarm-parent-inbox`: acts only in a Primary.
    Parent,
    /// `devswarm-child-turn`: acts only in a child workspace.
    Child,
}

/// `s` is a non-blank string (`typeof v === 'string' && v.trim() !== ''`).
fn non_blank(v: Option<&String>) -> bool {
    v.is_some_and(|s| !js_trim(s).is_empty())
}

/// `coerceValue` for an enum entry: trimmed, lower-cased, one of the accepted words.
fn enum_word(raw: &str, values: &[&str]) -> Option<String> {
    let t = js_trim(raw).to_lowercase();
    values.contains(&t.as_str()).then_some(t)
}

/// `devswarm.supervisorMode` as `settings.get` resolves it: environment, `settings.json`, plugin option, default.
fn supervisor_mode(st: &Settings) -> String {
    let e: &V = defaults::raw("devswarm_prompt.mode_setting");
    let values = e.get("values").map(V::strings).unwrap_or_default();
    let default = e.str_field("default");
    if let Some(w) = st.env.get(e.str_field("env")).and_then(|v| enum_word(v, &values)) {
        return w;
    }
    let from_file = read_object(st, defaults::text("guardkit.settings_file")).and_then(|o| {
        let raw = o.get(e.str_field("section"))?.as_object()?.get(e.str_field("key"))?;
        match raw {
            // coerceValue lets a string, number or boolean through; only a string can be one of the words.
            Value::String(s) => enum_word(s, &values),
            _ => None,
        }
    });
    if let Some(w) = from_file {
        return w;
    }
    let manifest = e.str_field("manifest_default");
    let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), e.str_field("option").to_ascii_uppercase());
    if let Some(raw) = st.env.get(&env_key) {
        return if raw == manifest { default.to_string() } else { enum_word(raw, &values).unwrap_or_else(|| default.to_string()) };
    }
    if let Some(v) = stored_options(st).and_then(|o| o.get(e.str_field("option")).cloned()) {
        let is_default = js_string_of(&v).is_some_and(|s| s == manifest);
        if !is_default && let Value::String(s) = &v {
            return enum_word(s, &values).unwrap_or_else(|| default.to_string());
        }
    }
    default.to_string()
}

/// `isDevswarmActive(env)`.
///
/// The kill switch is tested by the caller ([`provably_silent`]) before anything that needs the home directory.
fn devswarm_active(st: &Settings) -> bool {
    match supervisor_mode(st).as_str() {
        "off" => false,
        "on" => true,
        _ => non_blank(st.env.get(defaults::text("devswarm_prompt.repo_env"))),
    }
}

/// `isChildWorkspace(env)`.
fn child_workspace(st: &Settings) -> bool {
    non_blank(st.env.get(defaults::text("devswarm_prompt.branch_env")))
}

/// True when the Node hook for `role` is provably silent in this environment.
///
/// `st.home` is `HOME` exactly: Node resolves the settings file against `os.homedir()` (which is `HOME` on POSIX), so a
/// request without `HOME` proves nothing about the files and only the environment-only conditions are used.
pub fn provably_silent(role: Role, st: &Settings) -> bool {
    if st.env.get(defaults::text("devswarm_prompt.judge_env")).is_some_and(|v| v == defaults::text("devswarm_prompt.judge_value")) {
        return true;
    }
    let child = child_workspace(st);
    if (role == Role::Parent && child) || (role == Role::Child && !child) {
        return true;
    }
    if st.env.get(defaults::text("devswarm_prompt.kill_env")).is_some_and(|v| v == defaults::text("devswarm_prompt.kill_value")) {
        return true;
    }
    if st.home.is_empty() {
        return false;
    }
    let switch = match role {
        Role::Parent => "devswarm_prompt.parent_setting",
        Role::Child => "devswarm_prompt.child_setting",
    };
    !get_bool(st, defaults::raw(switch)) || !devswarm_active(st)
}

/// The settings view of one request: the home is `HOME` only (see [`provably_silent`]).
fn settings_of(env: &RequestEnv) -> Settings {
    let map = env.to_map();
    let home = map.get(defaults::env_name("home")).cloned().unwrap_or_default();
    Settings { home, env: map }
}

fn decide(role: Role, env: &RequestEnv) -> Verdict {
    if provably_silent(role, &settings_of(env)) { Verdict::Allow } else { Verdict::Defer }
}

/// The registered `devswarm-parent-inbox` check.
pub struct DevswarmParentInbox;

/// The registered `devswarm-child-turn` check.
pub struct DevswarmChildTurn;

impl Check for DevswarmParentInbox {
    fn name(&self) -> &'static str {
        "devswarm-parent-inbox"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_prompt.parent_summary")
    }

    /// Without the request environment nothing is provable: defer.
    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, _payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(Role::Parent, env))
    }
}

impl Check for DevswarmChildTurn {
    fn name(&self) -> &'static str {
        "devswarm-child-turn"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_prompt.child_summary")
    }

    /// Without the request environment nothing is provable: defer.
    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, _payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(Role::Child, env))
    }
}
