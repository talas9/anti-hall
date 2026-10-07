//! Session-maintenance checks: ports of the SessionStart hooks that keep a small cache or ledger under the home directory
//! (`version-alert`, `devswarm-version`, `claude-cli-version`, `repo-self-drift`, `defect-nudge`, `progress-prune`).
//!
//! These are not guards: they never block, and a failure must never slow or break session start (D74: non-guard hooks are
//! fail-open). What they share, written once here: the home directory the Node hook resolves from `HOME`, the switch and
//! skip-file chain, the SessionStart advisory envelope, and the rule for when the engine hands the hook back to Node.
//!
//! The deferral rule (D11): a hook whose Node original would start a background process (a stale version cache spawns a
//! detached probe), or whose answer depends on the hook process's own working directory or on JavaScript behaviour this
//! port does not reproduce byte for byte, answers `Verdict::Defer` BEFORE it writes anything, so the Node hook then runs
//! whole. A check never defers after a state write, because Node would then see the changed state and say less.
pub mod claude_cli_version;
pub mod defect_nudge;
pub mod devswarm_version;
pub mod drift;
pub mod jval;
pub mod progress_prune;
pub mod repo_self_drift;
pub mod time;
pub mod version_alert;

#[cfg(test)]
mod tests;

use crate::checks::Verdict;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::advisory_json;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::is_js_space;
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// The home directory the Node hook sees (`os.homedir()` reads `HOME`); `None` when it is unset, empty or relative, where
/// Node would fall back to the password database or the hook's own working directory, which a daemon cannot answer for the
/// client.
pub(crate) fn home_of(env: &RequestEnv) -> Option<String> {
    env.get(defaults::env_name("home")).filter(|h| h.starts_with('/')).map(str::to_string)
}

/// The plugin root the dispatcher passes (`plugin_root`; `ah-engine check` passes it in the environment), resolved to its
/// real path as Node resolves `__dirname`.
pub(crate) fn plugin_root(opts: &Value, env: &RequestEnv) -> Option<String> {
    let root = opts.get("plugin_root").and_then(Value::as_str).or_else(|| env.get(defaults::env_name("plugin_root"))).filter(|r| !r.is_empty())?;
    std::fs::canonicalize(root).ok().map(|p| p.to_string_lossy().to_string())
}

/// True inside the judge child (`ANTIHALL_JUDGE_CHILD=1`), where every hook is a silent no-op (`judge-child-exit.js`).
pub(crate) fn judge_child(env: &RequestEnv) -> bool {
    env.get(defaults::text("session.judge_child_env")) == Some(defaults::text("session.judge_child_on"))
}

/// True for the SessionStart event; the only one these hooks are registered on.
pub(crate) fn is_session_start(s: &Subject<'_>) -> bool {
    s.event == defaults::text("session.event")
}

/// The switch `key` (a table in `defaults/session.toml`) as the Node `settings.get(...) !== false` test reads it.
pub(crate) fn switch_on(st: &Settings, key: &str) -> bool {
    get_bool(st, defaults::raw(key))
}

/// `skip-guard.js` `isSkipped(name)`.
pub(crate) fn skipped(st: &Settings, name: &str) -> bool {
    is_skipped(st, name)
}

/// `Date.now()` in milliseconds.
pub(crate) fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `fs.readFileSync(path, 'utf8')`: `None` on any error (absent, a directory, unreadable).
pub(crate) fn read_text(path: &str) -> Option<String> {
    std::fs::read(path).ok().map(crate::checks::guardkit::text::lossy_owned)
}

/// `path.join(a, b)` for two path strings.
pub(crate) fn join(a: &str, b: &str) -> String {
    crate::checks::guardkit::paths::join(a, b)
}

/// The SessionStart advisory the Node hooks print: `{"hookSpecificOutput":{"hookEventName":"SessionStart",...}}`.
pub(crate) fn emit(text: &str) -> Verdict {
    Verdict::Advisory(advisory_json(defaults::text("session.event"), text))
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `parseInt(s, 10)`: leading white space, an optional sign, then the digits it can read; `NaN` when there are none.
pub(crate) fn js_parse_int(s: &str) -> f64 {
    let t = s.trim_start_matches(is_js_space);
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    let v: f64 = digits.parse().unwrap_or(f64::NAN);
    if neg { -v } else { v }
}

/// True for a character of JavaScript's `\w` (ASCII letters, digits and underscore).
pub(crate) fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// The `text` of a template literal `${x}` for a JSON value, or `None` for an object or array (whose text this port
/// does not reproduce, so the caller defers).
pub(crate) fn template_text(v: &jval::J) -> Option<String> {
    match v {
        jval::J::Str(s) => Some(s.clone()),
        jval::J::Num(n) => Some(jval::js_num(*n)),
        jval::J::Bool(b) => Some(b.to_string()),
        jval::J::Null => Some("null".to_string()),
        _ => None,
    }
}
