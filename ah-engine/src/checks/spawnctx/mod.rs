//! Helpers shared by the spawn/path context checks ported from Node (`inbox-read-guard`, `phase-tracker`,
//! `orch-on-spawn`, `verify-first-orch`): the home directory the state files live under, the DevSwarm detector, session
//! id sanitizing and the payload tests the hooks share.
//!
//! Every function mirrors one Node helper and says which. A function that cannot decide exactly as Node would (a home
//! that is not an absolute path, a relative path that Node would resolve against the hook's own working directory)
//! reports that, and the check defers to the Node hook: never a silent allow (D11).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

#[cfg(test)]
mod tests;

use crate::checks::git::util::Settings;
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::checks::guardkit::settings::get_enum;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use serde_json::Value;
use std::collections::HashMap;

/// Where state files live, as `companion/lib/test-home-guard.js` `resolveHome` decides it.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Home {
    /// An absolute home directory.
    Ok(String),
    /// A test run whose home is the real user home: Node's `resolveHome` throws, the callers catch it, and the state is
    /// simply unavailable (nothing is read or written).
    Guarded,
    /// The environment has no usable home (unset, empty or relative): Node would ask the system or resolve against its
    /// own working directory, which the engine cannot see, so the check defers.
    Unknown,
}

/// `os.homedir()` on a POSIX host: `HOME`, when it is set to an absolute path.
pub fn os_homedir(env: &HashMap<String, String>) -> Option<String> {
    let h = env.get(defaults::env_name("home"))?;
    is_absolute(h).then(|| h.clone())
}

/// The user's real home as the passwd database has it (`os.userInfo().homedir`), `None` when it cannot be read.
pub(crate) fn passwd_home() -> Option<String> {
    // SAFETY: getpwuid returns null or a pointer to a static record valid until the next passwd call; the directory
    // string is copied out immediately, on this thread, before any other call.
    unsafe {
        let pw = libc::getpwuid(libc::geteuid());
        if pw.is_null() || (*pw).pw_dir.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr((*pw).pw_dir).to_str().ok().map(str::to_string)
    }
}

/// `resolveHome(undefined, env)`: `os.homedir()`, refused (as [`Home::Guarded`]) when a test marker is set and the result
/// is the real passwd home, unless the opt-out variable is set.
pub fn state_home(env: &HashMap<String, String>) -> Home {
    let Some(home) = os_homedir(env) else { return Home::Unknown };
    let set = |k: &str| env.get(k).is_some_and(|v| !v.is_empty());
    if set(defaults::text("spawn_ctx.real_home_optout_env")) {
        return Home::Ok(home);
    }
    if defaults::list("spawn_ctx.test_markers").into_iter().any(set) && passwd_home().is_some_and(|real| resolve_abs(&home) == resolve_abs(&real)) {
        return Home::Guarded;
    }
    Home::Ok(home)
}

/// True when the hook should do nothing because it runs inside a judge child (`hooks/lib/judge-child-exit.js`).
pub fn judge_child(env: &HashMap<String, String>) -> bool {
    env.get(defaults::text("spawn_ctx.judge_child_env")).is_some_and(|v| v == defaults::text("spawn_ctx.judge_child_value"))
}

/// `devswarm-detect.js` `isDevswarmActive(env)`: the kill switch, the supervisor mode, then the DevSwarm repo variable.
pub fn devswarm_active(st: &Settings) -> bool {
    if st.env.get(defaults::text("spawn_ctx.devswarm_kill_env")).is_some_and(|v| v == defaults::text("spawn_ctx.devswarm_kill_value")) {
        return false;
    }
    let mode = get_enum(st, defaults::raw("spawn_ctx.supervisor_setting"));
    match js_trim(&mode).to_lowercase().as_str() {
        "off" => false,
        "on" => true,
        _ => st.env.get(defaults::text("spawn_ctx.devswarm_repo_env")).is_some_and(|v| !js_trim(v).is_empty()),
    }
}

/// `handover-find.js` `sanitizeSessionId`: every character outside letters, digits, `_` and `-` removed, or the unknown
/// session name when nothing is left.
pub fn sanitize_session(raw: &str) -> String {
    let safe: String = raw.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')).collect();
    if safe.is_empty() { defaults::text("spawn_ctx.unknown_session").to_string() } else { safe }
}

/// `coordinator-detect.js` `isSubagentByPayload`: one of the agent marker keys is present and not null (a present but
/// falsy value still counts).
pub fn subagent_by_payload(p: &Value) -> bool {
    p.is_object() && defaults::list("orch_on_spawn.agent_markers").into_iter().any(|k| p.get(k).is_some_and(|v| !v.is_null()))
}

/// The current time in milliseconds since the epoch (`Date.now()`).
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}
