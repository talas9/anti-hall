//! Built-in `check = "codex-quota-detect"`: port of `hooks/codex-quota-detect.js` (PostToolUse on Agent).
//!
//! When a `codex:codex-rescue` Agent result reports a quota or rate-limit exhaustion, record it once in the shared
//! availability file and say so. Advisory only; the check never blocks.
//!
//! A result that is an object with several keys is scanned in JSON key order by Node, an order the engine's parsed payload
//! does not keep. Such a result is decided here only when no string in it mentions a quota word at all (so no order could
//! produce a match); otherwise the Node hook decides.
use super::quota::{self, Unsure};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::get_bool;
use crate::checks::guardkit::text::{js_trim, slice_utf16};
use crate::checks::jsport::{date, home, json, num, text as jstext};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

fn rescue_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.rescue_re"), true))
}

/// `JSON.stringify(v)` of a value whose objects have at most one key each (so the key order is not in question).
fn stringify(v: &Value) -> Option<String> {
    Some(match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            let f = n.as_f64()?;
            if f.is_finite() { num::to_js_string(f) } else { "null".into() }
        }
        Value::String(s) => json::quote(s),
        Value::Array(a) => format!("[{}]", a.iter().map(stringify).collect::<Option<Vec<_>>>()?.join(",")),
        Value::Object(o) if o.len() <= 1 => {
            format!("{{{}}}", o.iter().map(|(k, x)| stringify(x).map(|t| format!("{}:{t}", json::quote(k)))).collect::<Option<Vec<_>>>()?.join(","))
        }
        Value::Object(_) => return None,
    })
}

/// True when some string (a key or a value) anywhere in `v` could be part of a quota message.
fn mentions(v: &Value) -> bool {
    match v {
        Value::String(s) => !quota::cannot_match(s),
        Value::Array(a) => a.iter().any(mentions),
        Value::Object(o) => o.iter().any(|(k, x)| !quota::cannot_match(k) || mentions(x)),
        _ => false,
    }
}

/// The text the quota words are searched in. `Ok(None)`: nothing in the result can match; `Err`: the Node hook decides.
fn blob(p: &Value) -> Result<Option<String>, Unsure> {
    let mut parts: Vec<String> = Vec::new();
    let mut skipped = false;
    for key in ["tool_response", "tool_output"] {
        let Some(v) = jstext::member(p, key).filter(|v| !v.is_null()) else { continue };
        match v {
            Value::String(s) => parts.push(s.clone()),
            other => match stringify(other) {
                Some(t) => parts.push(t),
                None if mentions(other) => return Err(Unsure),
                None => skipped = true,
            },
        }
    }
    // A part left out has an unknown length, which would move where the scan cap cuts the others.
    if skipped && !parts.is_empty() {
        return Err(Unsure);
    }
    if skipped {
        return Ok(None);
    }
    let joined = parts.join("\n");
    if jstext::len16(&joined) > defaults::num("codex_handover.detect_scan_cap") as usize {
        return slice_utf16(&joined, defaults::num("codex_handover.detect_scan_cap") as usize).map(Some).ok_or(Unsure);
    }
    Ok(Some(joined))
}

/// The check's decision on one payload.
pub fn decide(p: &Value, env: &RequestEnv) -> Result<Option<Verdict>, Unsure> {
    let _zone = crate::checks::jsport::date::ZoneGuard::new(env);
    let st = super::settings_of(env);
    if !get_bool(&st, defaults::raw("codex_handover.setting_quota_detect")) {
        return Ok(None);
    }
    if jstext::str_member(p, "tool_name") != Some("Agent") {
        return Ok(None);
    }
    let input = jstext::member(p, "tool_input").filter(|v| jstext::truthy(Some(v)));
    let subagent = input.and_then(|i| jstext::first_truthy(i, &defaults::list("codex_handover.agent_type_keys")));
    if !subagent.and_then(Value::as_str).is_some_and(|s| rescue_re().is_match(js_trim(s))) {
        return Ok(None);
    }
    let text = match blob(p)? {
        Some(t) if !t.is_empty() => t,
        _ => return Ok(None),
    };
    let Some(hit) = quota::detect(&text)? else { return Ok(None) };
    let Some(home) = home::resolve(env) else { return Err(Unsure) };
    let now = date::now_ms();
    quota::record_quota(&home, hit.until, &hit.reason, now)?;
    let until = match hit.until {
        Some(u) if u != 0.0 => match date::to_iso(u) {
            Some(i) => i,
            None => return Ok(None), // toISOString threw: the advisory is skipped, the record already written
        },
        _ => defaults::text("codex_handover.cooldown_default_label").to_string(),
    };
    let what = msg::render("codex_handover.quota_what", &[("reason", &hit.reason)]);
    let why = msg::render("codex_handover.quota_why", &[("until", &until)]);
    let text = msg::message(
        Kind::Warn,
        defaults::text("codex_handover.quota_guard"),
        &Parts { what: &what, why: &why, instead: defaults::text("codex_handover.quota_instead"), ..Parts::default() },
    );
    Ok(Some(Verdict::Advisory(msg::advisory_json(defaults::text("codex_handover.quota_event"), &text))))
}

/// The registered `codex-quota-detect` check.
pub struct CodexQuotaDetect;

impl Check for CodexQuotaDetect {
    fn name(&self) -> &'static str {
        "codex-quota-detect"
    }

    fn summary(&self) -> &'static str {
        defaults::text("codex_handover.detect_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        match decide(payload, env) {
            Ok(v) => v.or(Some(Verdict::Allow)),
            Err(Unsure) => Some(Verdict::Defer),
        }
    }
}
