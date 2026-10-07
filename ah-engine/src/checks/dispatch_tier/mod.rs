//! Built-in `check = "dispatch-tier"`: the cheap half of the Node dispatch-tier hook (PostToolUse on TaskCreate and
//! TaskUpdate).
//!
//! The Node hook's only effect is to ask Jev, detached, how a new or changed task should be dispatched
//! (`lib/dispatch-tier.js` `request`), and it does that only when the `dispatchTier` Jev integration is not off. Everything
//! before that point only reads. So while the integration is off (Jev disabled, which is the default, or the integration
//! switched off) the hook does nothing at all, and this check answers for it without starting Node. While the integration
//! is on or in shadow mode the hook writes its request marker and starts the detached Jev worker, which this check does not
//! reproduce: it defers and the Node hook runs. The mode comes from the same resolver the Jev lane uses
//! ([`crate::jev::JevSettings::mode`], a port of `jev-assist.js` `getMode`).
//!
//! Mirrors `hooks/dispatch-tier.js`.
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::jev::JevSettings;
use crate::jev::settings::{Env, Mode, Sources};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;

#[cfg(test)]
mod tests;

/// The decision for one payload and the request's environment.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    let tool = p.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !defaults::list("dispatch_tier.tools").contains(&tool) {
        return Verdict::Allow;
    }
    let map = env.to_map();
    let home = map.get(defaults::env_name("home")).or_else(|| map.get(defaults::env_name("home_alt"))).filter(|h| !h.is_empty());
    let Some(home) = home else { return Verdict::Defer };
    let home = Path::new(home);
    let settings = JevSettings::resolve(home, Sources::load(home, Env::from_pairs(map.clone())));
    if settings.mode(defaults::text("dispatch_tier.jev_id"), false) == Mode::Off { Verdict::Allow } else { Verdict::Defer }
}

/// The registered `dispatch-tier` check.
pub struct DispatchTier;

impl Check for DispatchTier {
    fn name(&self) -> &'static str {
        "dispatch-tier"
    }

    fn summary(&self) -> &'static str {
        defaults::text("dispatch_tier.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, env))
    }
}
