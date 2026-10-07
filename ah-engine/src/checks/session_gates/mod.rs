//! Built-in checks `jev-weekly-scorecard`, `jev-review-reminder` and `repair-on-reload`: the gates of three Node hooks
//! that run at session start (and, for the repair, on every prompt) and are silent almost every time.
//!
//! Each check answers "nothing to say" itself when it can prove the Node hook would print nothing and write nothing, and
//! defers to the Node hook in every other case. The proof reads only what the Node hook reads first (switches, the
//! payload, a small state file); the work behind the gates (the Jev report, the review log, the migration engine and
//! the detached repair) stays in Node, so a deferral is the exact Node behavior and nothing is decided twice. A check
//! that cannot read its inputs defers; none of them ever writes a file.
//!
//! Mirrors the early exits of `hooks/jev-weekly-scorecard.js`, `hooks/jev-review-reminder.js` (with
//! `hooks/lib/credentials.js` `sessionNotice` and `hooks/lib/jev-recommend.js` `sessionNotice`) and
//! `hooks/repair-on-reload.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{Undecidable, get_setting, plugin_root, read_object};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

mod jev_review;
mod jev_weekly;
mod repair_reload;

#[cfg(test)]
mod tests;

pub use jev_review::JevReviewReminder;
pub use jev_weekly::JevWeeklyScorecard;
pub use repair_reload::RepairOnReload;

/// What a gate decided: nothing to say, or the Node hook must run.
pub(crate) type Gate = Result<(), Undecidable>;

/// True when a judge child runs this hook (every one of these hooks then does nothing).
fn judge_child(st: &Settings) -> bool {
    st.env.get(defaults::text("session_gates.judge_child_env")).map(String::as_str) == Some(defaults::text("session_gates.judge_child_value"))
}

/// The home directory the Node hook would use (`os.homedir()` is `$HOME`), or `None` when the request has none.
fn home_known(st: &Settings) -> bool {
    st.env.get(defaults::env_name("home")).is_some_and(|h| paths::is_absolute(h))
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `get(section, key, dflt)` of a boolean setting as a plain bool (`=== true`).
fn is_true(st: &Settings, entry: &str, dflt: bool, root: &str) -> Result<bool, Undecidable> {
    Ok(get_setting(st, defaults::raw(entry), Some(Value::Bool(dflt)), root)? == Some(Value::Bool(true)))
}

/// `readJevJson(home).enabled === true`: the strict reading of the legacy file, the fallback value Node passes.
fn legacy_enabled_strict(st: &Settings) -> bool {
    let rel = format!("{}/{}", defaults::text("session_gates.anti_hall_dir"), defaults::text("session_gates.jev_config_file"));
    read_object(st, &rel).and_then(|o| o.get("enabled").and_then(Value::as_bool)).unwrap_or(false)
}

/// The time stored under `key` in a small JSON state file, when it is a finite number (`Number.isFinite`).
fn stored_time(st: &Settings, rel: &str, key: &str) -> Option<f64> {
    read_object(st, &format!("{}/{rel}", defaults::text("session_gates.anti_hall_dir"))).and_then(|o| o.get(key).and_then(Value::as_f64)).filter(|n| n.is_finite())
}

macro_rules! gate_check {
    ($ty:ident, $name:literal, $summary:literal, $decide:path) => {
        impl Check for $ty {
            fn name(&self) -> &'static str {
                $name
            }

            fn summary(&self) -> &'static str {
                defaults::text($summary)
            }

            fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
                Some(Verdict::Defer)
            }

            fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
                let st = Settings::from_env(env);
                if !home_known(&st) {
                    return Some(Verdict::Defer);
                }
                match $decide(payload, &st, &plugin_root(opts, env)) {
                    Ok(()) => Some(Verdict::Allow),
                    Err(Undecidable) => Some(Verdict::Defer),
                }
            }
        }
    };
}
pub(crate) use gate_check;

/// `js_trim` re-exported for the three gate files.
pub(crate) fn trimmed(s: &str) -> &str {
    js_trim(s)
}
