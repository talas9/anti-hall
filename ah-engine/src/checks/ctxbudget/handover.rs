//! `auto-handover` (UserPromptSubmit) and `auto-handover-pause-nag` (Stop): ports of the cases of
//! `hooks/auto-handover.js` and `hooks/auto-handover-pause-nag.js` that inject nothing and write no state.
//!
//! The Node hooks share one per-session latch (`~/.anti-hall/auto-handover/<tag>.json`). They write it when the context
//! first crosses the threshold (and print the fire directive), when it grows another step (a nag), when it drops back
//! below (a re-arm), and, after a handover file appears, for the new-work gate. All of those defer. What the engine
//! answers itself is every case in which the Node hook would exit having printed nothing and written nothing.
use super::pct::{Pct, Reading, context_pct};
use super::setting::{get, js_parse_int};
use super::{Tag, finite, is_objectish, judge_child, now_ms, read_latch, session_tag, settings_of, subagent_by_payload, ups_empty};
use crate::checks::Verdict;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::is_skipped;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// The effective auto-handover settings (`hooks/lib/auto-handover-config.js` `resolveEffective`).
struct Eff {
    enabled: bool,
    pct: f64,
    max_tokens: f64,
    nag: bool,
    nag_step: f64,
    nag_quiet: f64,
}

fn resolve(st: &Settings) -> Eff {
    let off = Eff { enabled: false, pct: 0.0, max_tokens: 0.0, nag: false, nag_step: 0.0, nag_quiet: 0.0 };
    // the one rule the settings schema cannot express: the percent variable set to 0 disables the feature outright
    if let Some(raw) = st.env.get(defaults::text("ctxbudget.env_pct_off"))
        && !js_trim(raw).is_empty()
        && js_parse_int(raw) == Some(0.0)
    {
        return off;
    }
    if !get(st, defaults::raw("ctxbudget.set_ah_enabled")).flag() {
        return off;
    }
    Eff {
        enabled: true,
        pct: get(st, defaults::raw("ctxbudget.set_ah_pct")).num(),
        max_tokens: get(st, defaults::raw("ctxbudget.set_ah_max_tokens")).num().floor(),
        nag: get(st, defaults::raw("ctxbudget.set_ah_nag")).flag(),
        nag_step: get(st, defaults::raw("ctxbudget.set_ah_nag_step")).num(),
        nag_quiet: get(st, defaults::raw("ctxbudget.set_ah_nag_quiet")).num(),
    }
}

/// What `overThreshold` found.
#[derive(Debug, PartialEq, Clone, Copy)]
enum Over {
    /// The percent is over the threshold against a known window.
    Pct,
    /// The absolute token count is over its ceiling.
    Tokens,
    /// The percent is over the threshold against a guessed window.
    PctUnknownWindow,
}

/// `overThreshold(result, cfg)`.
fn over_threshold(r: &Reading, eff: &Eff) -> Option<Over> {
    if !eff.enabled {
        return None;
    }
    let by_pct = r.pct.is_finite() && r.pct >= eff.pct;
    let by_tokens = eff.max_tokens > 0.0 && r.used.is_some_and(|u| u.is_finite() && u >= eff.max_tokens);
    if by_pct && r.window_known {
        Some(Over::Pct)
    } else if by_tokens {
        Some(Over::Tokens)
    } else if by_pct {
        Some(Over::PctUnknownWindow)
    } else {
        None
    }
}

/// `Math.round` for the percents shown to the user.
fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// A JavaScript truthiness test of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn fired(latch: &Value) -> bool {
    latch.get("fired") == Some(&Value::Bool(true))
}

/// The transcript path of a payload (`typeof payload.transcript_path === 'string'`).
fn transcript_of(p: &Value) -> Option<&str> {
    p.get("transcript_path").and_then(Value::as_str)
}

/// The checks every case starts with: not a judge child, an object payload, not a subagent, not skipped.
enum Gate {
    /// Nothing to do: answer with the quiet verdict.
    Quiet,
    /// The Node hook decides.
    Defer,
    /// Go on, with the request's settings.
    Go(Settings),
}

fn gate(p: &Value, env: &RequestEnv, stop: bool) -> Gate {
    if judge_child(env) || !is_objectish(p) || subagent_by_payload(p) {
        return Gate::Quiet;
    }
    if stop && p.get("stop_hook_active") == Some(&Value::Bool(true)) {
        return Gate::Quiet;
    }
    let Some(st) = settings_of(env) else { return Gate::Defer };
    if is_skipped(&st, defaults::text("ctxbudget.skip_auto_handover")) { Gate::Quiet } else { Gate::Go(st) }
}

/// `auto-handover.js`.
pub fn decide_prompt(p: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let st = match gate(p, env, false) {
        Gate::Quiet => return ups_empty(),
        Gate::Defer => return Verdict::Defer,
        Gate::Go(st) => st,
    };
    let eff = resolve(&st);
    let tag = match session_tag(p) {
        Tag::Id(t) => t,
        Tag::None => return ups_empty(),
        Tag::Hash => return Verdict::Defer,
    };
    let Ok(latch) = read_latch(&st, &tag) else { return Verdict::Defer };
    if !eff.enabled {
        // a latch that was set is cleared by a write
        return if fired(&latch) { Verdict::Defer } else { ups_empty() };
    }
    let reading = match context_pct(&st, p.get("session_id"), transcript_of(p), None) {
        Pct::Defer => return Verdict::Defer,
        Pct::None => return ups_empty(),
        Pct::Reading(r) => r,
    };
    match over_threshold(&reading, &eff) {
        None if fired(&latch) || truthy(latch.get("softFired")) => Verdict::Defer,
        None => ups_empty(),
        // already told once this arm that the window is a guess: nothing more is said
        Some(Over::PctUnknownWindow) if !fired(&latch) && latch.get("softFired") == Some(&Value::Bool(true)) => ups_empty(),
        Some(_) => Verdict::Defer,
    }
}

/// `auto-handover-pause-nag.js`.
pub fn decide_stop(p: &Value, env: &RequestEnv) -> Verdict {
    let st = match gate(p, env, true) {
        Gate::Quiet => return Verdict::Allow,
        Gate::Defer => return Verdict::Defer,
        Gate::Go(st) => st,
    };
    let eff = resolve(&st);
    if !eff.enabled {
        return Verdict::Allow;
    }
    let tag = match session_tag(p) {
        Tag::Id(t) => t,
        Tag::None => return Verdict::Allow,
        Tag::Hash => return Verdict::Defer,
    };
    let Ok(latch) = read_latch(&st, &tag) else { return Verdict::Defer };
    let transcript = transcript_of(p);
    let lines = match transcript.filter(|t| !t.is_empty()) {
        Some(t) if !t.starts_with('/') => return Verdict::Defer, // Node resolves it against its own directory
        Some(t) => crate::checks::compact_decl::read_tail(t, defaults::num("ctxbudget.tail_bytes")),
        None => None,
    };
    let reading = context_pct(&st, p.get("session_id"), transcript, lines.as_deref());
    if !fired(&latch) {
        return match reading {
            Pct::Defer => Verdict::Defer,
            Pct::Reading(r) if matches!(over_threshold(&r, &eff), Some(Over::Pct | Over::Tokens)) => Verdict::Defer,
            _ => Verdict::Allow,
        };
    }
    if !eff.nag {
        return Verdict::Allow;
    }
    let r = match reading {
        Pct::Defer => return Verdict::Defer,
        Pct::None => return Verdict::Allow,
        Pct::Reading(r) if !r.pct.is_finite() => return Verdict::Allow,
        Pct::Reading(r) => r,
    };
    if over_threshold(&r, &eff).is_none() {
        return Verdict::Defer; // back below the threshold: the latch is re-armed by a write
    }
    let last_nag_at = finite(latch.get("lastNagAt")).unwrap_or(0.0);
    let last_nag_pct = finite(latch.get("lastNagPct")).or_else(|| finite(latch.get("firedPct"))).unwrap_or(eff.pct);
    let risen = r.pct >= last_nag_pct + eff.nag_step;
    let quiet_elapsed = now_ms() - last_nag_at >= eff.nag_quiet * 60.0 * 1000.0;
    if !risen && !quiet_elapsed {
        return Verdict::Allow;
    }
    if !risen && finite(latch.get("lastPauseNagPct")) == Some(js_round(r.pct)) {
        return Verdict::Allow; // the same step, the identical text
    }
    Verdict::Defer
}

super::check_impl!(AutoHandover, "auto-handover", "ctxbudget.summary_auto_handover", decide_prompt);
super::check_impl!(AutoHandoverPauseNag, "auto-handover-pause-nag", "ctxbudget.summary_pause_nag", decide_stop);
