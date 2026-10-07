//! Built-in `check = "devswarm-version"`: a port of the Node SessionStart hook `hooks/devswarm-version.js`.
//!
//! Probe 1 of the drift family: when the DevSwarm CLI version a background probe cached differs by major or minor from the
//! version anti-hall's integration was verified against, say so once per (installed, baseline) pair. A stale or absent
//! cache makes Node start a detached refresh process, which is Node's job, so the engine defers then.
use super::drift::{self, Cache};
use super::jval::{J, obj};
use super::{emit, home_of, is_session_start, join, now_ms, skipped, switch_on};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// The registered `devswarm-version` check.
pub struct DevswarmVersion;

impl Check for DevswarmVersion {
    fn name(&self) -> &'static str {
        "devswarm-version"
    }

    fn summary(&self) -> &'static str {
        defaults::text("session.devswarm_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, _payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if !is_session_start(s) {
            return Some(Verdict::Defer);
        }
        Some(decide(env))
    }
}

/// `alreadyAdvised(cache, installed, baseline)`: `lastAdvised` names exactly this pair (extra keys are allowed here, unlike
/// the generic key compare the other probes use).
fn already_advised(cache: &J, installed: &str, baseline: &str) -> bool {
    let Some(la) = cache.get("lastAdvised") else { return false };
    la.get("installed").and_then(J::as_str) == Some(installed) && la.get("baseline").and_then(J::as_str) == Some(baseline)
}

fn decide(env: &RequestEnv) -> Verdict {
    if super::judge_child(env) {
        return Verdict::Allow;
    }
    let Some(home) = home_of(env) else { return Verdict::Defer };
    let st = Settings::from_env(env);
    if !switch_on(&st, "session.setting_devswarm") || skipped(&st, defaults::text("session.devswarm_guard")) {
        return Verdict::Allow;
    }
    let file = join(&home, defaults::text("session.devswarm_cache"));
    let cache = match drift::read_cache(&file, |_| true) {
        Cache::Valid(c) if drift::is_fresh(&c, now_ms(), defaults::num("session.drift_cache_ttl_ms") as f64) => c,
        // stale, absent or unreadable: Node starts the detached refresh probe, so Node runs
        _ => return Verdict::Defer,
    };
    let Some(installed) = cache.get("installed").and_then(J::as_str).filter(|i| !i.is_empty()) else { return Verdict::Allow };
    let baseline = defaults::text("session.devswarm_baseline");
    let d = drift::classify(installed, baseline);
    if !d.advise() || already_advised(&cache, installed, baseline) {
        return Verdict::Allow;
    }
    let newer = if d == drift::Drift::Older { defaults::text("session.older_suffix") } else { "" };
    let what = msg::render("session.devswarm_what", &[("installed", installed), ("baseline", baseline), ("newer", newer)]);
    let text = msg::message(
        Kind::Warn,
        defaults::text("session.devswarm_guard"),
        &Parts { what: &what, why: defaults::text("session.drift_why"), instead: defaults::text("session.devswarm_instead"), ..Parts::default() },
    );
    drift::persist_advised_key(&file, &cache, obj(vec![("installed", J::Str(installed.to_string())), ("baseline", J::Str(baseline.to_string()))]));
    emit(&text)
}
