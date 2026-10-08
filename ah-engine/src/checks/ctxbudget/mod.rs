//! Built-in checks of the context-budget and handover gates, ports of four Node hooks:
//! `limit-conserve-inject` (UserPromptSubmit), `auto-handover` (UserPromptSubmit), `auto-handover-pause-nag` (Stop) and
//! `compact-advice-guard` (Stop).
//!
//! What each check answers itself: the case that is both common and free of side effects, where the Node hook injects
//! nothing, blocks nothing and writes no file (the feature is off or skipped, the agent is a subagent, the context is
//! below the threshold, the usage cache shows no bucket over its limit, the turn's final text holds no wording a compact
//! recommendation needs). Every other case (a fire, a nag, a re-arm, an active conservation, a possible recommendation)
//! defers to the Node hook, which owns the text, the state files, the emit-dedupe bookkeeping and the phrase analysis,
//! so the files those hooks write are written by the one implementation that has always written them (D74: never a
//! worse guard than the Node one; D11: a deferral is never a silent allow).
//!
//! Everything a check reads is read the way Node reads it: the settings through [`setting`] (`hooks/lib/settings.js`),
//! the skip file through `guardkit::settings::is_skipped`, the context reading through [`pct`]
//! (`hooks/lib/context-pct.js`). A file the engine cannot judge exactly (an unparseable line Node might parse, a relative
//! path Node would resolve against its own directory, a missing home directory) defers.
pub mod advice;
pub mod handover;
pub mod limit;
pub mod pct;
pub mod phrase;
pub mod setting;
pub mod text;

#[cfg(test)]
mod tests;

use crate::checks::Verdict;
use crate::checks::compact_decl::json_depth;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsdiff::js_reads_differently_str;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// What reading a JSON state file came to.
pub(crate) enum Jf {
    /// Missing, unreadable, or text no JSON parser accepts: Node falls back the same way.
    Bad,
    /// A parsed value.
    Ok(Value),
    /// Text the engine's parser rejects and Node's might accept (a lone surrogate escape, nesting past the limit, an
    /// exponent out of range): the Node hook must decide.
    Hazard,
}

/// Whether JSON text the engine's parser rejected might still be accepted by `JSON.parse` (a lone surrogate escape,
/// nesting past the limit, an exponent out of range).
pub(crate) fn hazard(text: &str) -> bool {
    text.contains("\\u") || json_depth(text) > defaults::num("ctxbudget.deep_json_depth") as usize || js_reads_differently_str(text)
}

/// Read and parse a JSON file as Node does (UTF-8 with replacement characters, then `JSON.parse`).
pub(crate) fn read_json(path: &str) -> Jf {
    let Ok(bytes) = std::fs::read(path) else { return Jf::Bad };
    let text = String::from_utf8_lossy(&bytes);
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => Jf::Ok(v),
        Err(_) if hazard(&text) => Jf::Hazard,
        Err(_) => Jf::Bad,
    }
}

/// The settings view of one request: the home directory is the one Node's `os.homedir()` returns on POSIX (`HOME`), and a
/// request without an absolute one is deferred (Node would ask the password database).
pub(crate) fn settings_of(env: &RequestEnv) -> Option<Settings> {
    let home = env.get(defaults::text("ctxbudget.home_env")).filter(|h| h.starts_with('/'))?.to_string();
    Some(Settings { home, env: env.to_map() })
}

/// True inside the judge child, where every hook is a no-op (`hooks/lib/judge-child-exit.js`).
pub(crate) fn judge_child(env: &RequestEnv) -> bool {
    env.get(defaults::text("ctxbudget.judge_child_env")) == Some(defaults::text("ctxbudget.judge_child_on"))
}

/// The line a UserPromptSubmit hook prints when it injects nothing.
pub(crate) fn ups_empty() -> Verdict {
    Verdict::Exact(crate::checks::Exact { code: 0, out: defaults::text("ctxbudget.ups_empty").to_string(), err: String::new() })
}

/// `payload && typeof payload === 'object'`: an object or an array (not null, not a scalar).
pub(crate) fn is_objectish(p: &Value) -> bool {
    p.is_object() || p.is_array()
}

/// `isSubagentByPayload` (`hooks/coordinator-detect.js`): `agent_id` or `agent_type` present and not null.
pub(crate) fn subagent_by_payload(p: &Value) -> bool {
    is_objectish(p) && defaults::list("coordinator_work.agent_markers").iter().any(|k| p.get(k).is_some_and(|v| !v.is_null()))
}

/// The milliseconds since the epoch.
pub(crate) fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

macro_rules! check_impl {
    ($ty:ident, $name:literal, $summary:literal, $decide:path) => {
        #[doc = concat!("The registered `", $name, "` check.")]
        pub struct $ty;

        impl $crate::checks::Check for $ty {
            fn name(&self) -> &'static str {
                $name
            }

            fn summary(&self) -> &'static str {
                $crate::defaults::text($summary)
            }

            fn run(&self, _s: &$crate::rules::Subject<'_>, _opts: &serde_json::Value) -> Option<$crate::checks::Verdict> {
                // The decision needs the whole payload and the request environment; without them Node decides.
                Some($crate::checks::Verdict::Defer)
            }

            fn run_env(
                &self,
                _s: &$crate::rules::Subject<'_>,
                payload: &serde_json::Value,
                _opts: &serde_json::Value,
                env: &$crate::reqenv::RequestEnv,
            ) -> Option<$crate::checks::Verdict> {
                Some($decide(payload, env))
            }
        }
    };
}
pub(crate) use check_impl;
