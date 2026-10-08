//! Built-in `check = "verify-first"`: a port of the Node verify-first hook (UserPromptSubmit), the short per-turn
//! reminder that rotates among a fixed list of lines.
//!
//! The reminder is picked by the SHA-1 of the whole raw stdin envelope (first four bytes, big endian, modulo the number of
//! lines), so the same payload bytes always give the same line; the dispatcher hands the check that digest (`payload_sha1`
//! in the options). The text is then passed through the emit-dedupe store under the key `verify-first`: a queued burst
//! collapses to one copy, and an unchanged reminder repeats only every `guards.injectionRepeatEvery` delivered turns.
//!
//! One case stays on Node: a DevSwarm Primary session appends a dispatch-tier sentence whose gate reads the repo's
//! `CLAUDE.md` / `AGENTS.md` chain and the git superproject (`hooks/lib/primary-tier.js`, `dispatch-tier.js`). The check
//! settles every other session itself, and when the session could be a Primary (the supervisor is on, this is not a child
//! workspace, and the tier text is not switched off) it defers before anything is written.
//!
//! Mirrors `hooks/verify-first.js`; the store is [`crate::checks::emit_dedupe`].
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::emit_dedupe::{self, Defer, Opts};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg;
use crate::checks::guardkit::settings::{get_bool, get_enum, get_number};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// True when the session might get the DevSwarm Primary sentence, which only Node can decide.
pub(crate) fn primary_possible(st: &Settings) -> bool {
    let env_text = |name: &str| st.env.get(defaults::text(name)).map(String::as_str);
    if env_text("verify_first.env_devswarm_disable") == Some("1") {
        return false;
    }
    let active = match get_enum(st, defaults::raw("verify_first.sw_supervisor_mode")).as_str() {
        "off" => false,
        "on" => true,
        _ => env_text("verify_first.env_devswarm_repo").is_some_and(|v| !js_trim(v).is_empty()),
    };
    if !active || env_text("verify_first.env_devswarm_source_branch").is_some_and(|v| !js_trim(v).is_empty()) {
        return false;
    }
    get_bool(st, defaults::raw("verify_first.sw_dispatch_tier_text"))
}

/// The reminder line a payload digest picks.
fn nudge_for(sha1_hex: &str) -> Option<&'static str> {
    let nudges = defaults::list("verify_first.nudges");
    let first4 = u32::from_str_radix(sha1_hex.get(..8)?, 16).ok()?;
    nudges.get(first4 as usize % nudges.len().max(1)).copied()
}

/// The check's decision on one payload: `Ok(Some(text))` emits, `Ok(None)` is silent.
fn decide(payload: &Value, sha1_hex: &str, st: &Settings) -> Result<Option<String>, Defer> {
    if !get_bool(st, defaults::raw("verify_first.sw_turn")) {
        return Ok(None);
    }
    if primary_possible(st) {
        return Err(Defer);
    }
    let nudge = nudge_for(sha1_hex).ok_or(Defer)?;
    let text = format!("{}{nudge}", defaults::text("verify_first.prefix"));
    let session = emit_dedupe::session_of(payload)?;
    let transcript = emit_dedupe::transcript_of(payload)?;
    let every = get_number(st, defaults::raw("verify_first.num_repeat_every"));
    let normalized = defaults::text("verify_first.dedupe_normalized");
    let emit = match &session {
        Some(sid) => emit_dedupe::should_emit(
            st,
            &Opts {
                session_id: sid,
                key: defaults::text("verify_first.dedupe_key"),
                content: &text,
                transcript_path: transcript,
                keepalive: if every.is_finite() && every > 0.0 { every } else { 0.0 },
                normalize: &|_| normalized.to_string(),
            },
        )?,
        None => true,
    };
    Ok(emit.then_some(text))
}

/// The registered `verify-first` check.
pub struct VerifyFirst;

impl Check for VerifyFirst {
    fn name(&self) -> &'static str {
        "verify-first"
    }

    fn summary(&self) -> &'static str {
        defaults::text("verify_first.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if env.get(defaults::text("prompt_emit.judge_child_env")) == Some("1") {
            return Some(Verdict::Allow);
        }
        let st = Settings::from_env(env);
        let Some(digest) = opts.get("payload_sha1").and_then(Value::as_str) else { return Some(Verdict::Defer) };
        match decide(payload, digest, &st) {
            Ok(None) => Some(Verdict::Allow),
            Ok(Some(text)) => Some(Verdict::Advisory(msg::advisory_json(defaults::text("verify_first.event"), &text))),
            Err(Defer) => Some(Verdict::Defer),
        }
    }
}
