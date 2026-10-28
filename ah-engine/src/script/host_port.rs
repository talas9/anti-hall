//! Host primitives of the session-start ports (#68): the Jev facts the `jev-review-reminder` check needs, which are file scans and
//! state writes only the engine does exactly and cheaply. Like the rest of `ahHost` they hold no rule, text or threshold of their own
//! (every name and text is a defaults entry, `session_gates.*`); the script decides whether a notice is due, these extract and record.
//!
//! | raw function | what it does |
//! |---|---|
//! | `jevReviewDue(afterDays, minDecisions)` | the Jev integrations whose shadow review is due, as JSON `[[id, days, decisions]]`, or `null` when the review state cannot be worked on: see [`jev_review_due`] |
//! | `jevReviewShown(idsJson)` | record that the review reminder named these integrations (one row in the review metrics log) |
//! | `jevKeyNotice(jevOn, judgeOn, allowAnthropic)` | the one-time "legacy key present but unused" notice of the session start, as JSON `{"notice": string\|null}` or `{"unsure": true}`: see [`jev_key_notice`] |
use super::host::with_settings;
use crate::checks::jsport::json::{self, J};
use crate::defaults;
use rquickjs::{Ctx, Function, Object};
use serde_json::{Value, json};
use std::path::Path;

fn jev_env() -> rquickjs::Result<(String, crate::jev::Env)> {
    with_settings(|st| (st.home.clone(), crate::jev::Env::from_pairs(st.env.clone())))
}

/// `jevReviewDue(afterDays, minDecisions)`: `computeReviewDue` of `hooks/lib/jev-review.js` for the numbers the script resolved from
/// the settings. The derived `shadowSince` / `dueSince` stamps are written to the review state as Node writes them. `null` when
/// the state cannot be worked on (an entry that is not an object), so the script defers and Node does exactly what it did.
fn jev_review_due(after: f64, min: f64) -> rquickjs::Result<Option<String>> {
    let (home, env) = jev_env()?;
    match crate::setup::jev_setup::review::hook_review_due(Path::new(&home), &env, after, min) {
        Ok(due) => Ok(Some(Value::Array(due.into_iter().map(|(id, days, n)| json!([id, days, n])).collect()).to_string())),
        Err(why) => {
            crate::health::log_event("jev_review_state", "SessionStart", &why);
            Ok(None)
        }
    }
}

/// `jevReviewShown(idsJson)`.
fn jev_review_shown(ids: &str) -> rquickjs::Result<()> {
    let (home, _) = jev_env()?;
    let ids: Vec<String> = serde_json::from_str(ids).unwrap_or_default();
    crate::setup::jev_setup::review::hook_reminder_shown(Path::new(&home), &ids);
    Ok(())
}

/// JavaScript truthiness of a JSON value.
fn truthy(v: Option<&J>) -> bool {
    match v {
        None | Some(J::Null) => false,
        Some(J::Bool(b)) => *b,
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Str(s)) => !s.is_empty(),
        Some(J::Arr(_) | J::Obj(_)) => true,
    }
}

fn set(o: &mut Vec<(String, J)>, name: &str, v: J) {
    match o.iter_mut().find(|(n, _)| n == name) {
        Some(slot) => slot.1 = v,
        None => o.push((name.to_string(), v)),
    }
}

/// `credentials.sessionNotice({home})` of `hooks/lib/credentials.js`. `jev_on` / `judge_on` are the already-resolved `jev.enabled` and
/// `jev.semanticJudge`, `allow_anthropic` the home-only `guards.allowAnthropicEnvKey`. The notice is named once per kind in
/// `~/.anti-hall/legacy-key-notice-state.json`; with every kind already named, or no legacy key present, nothing is read further and
/// nothing is written. A state file whose shape only JavaScript reads the same way answers `{"unsure": true}`.
fn jev_key_notice(jev_on: bool, judge_on: bool, allow_anthropic: bool) -> rquickjs::Result<String> {
    let (home, env) = jev_env()?;
    let home = Path::new(&home);
    let unsure = || json!({"unsure": true}).to_string();
    let none = || json!({"notice": Value::Null}).to_string();
    let mut kinds: Vec<&str> = Vec::new();
    if jev_on {
        kinds.push(defaults::text("session_gates.key_kind_jev"));
    }
    if jev_on || judge_on {
        kinds.push(defaults::text("session_gates.key_kind_anthropic"));
    }
    if kinds.is_empty() {
        return Ok(none());
    }
    let depth = defaults::num("setup.json_max_depth") as usize;
    let dir = home.join(defaults::text("paths.base_dir"));
    let state_file = dir.join(defaults::text("session_gates.key_state_file"));
    // `JSON.parse(raw) || {}`: an absent, unreadable or invalid file is an empty state
    let state = match std::fs::read(&state_file).ok().map(|b| json::parse(&String::from_utf8_lossy(&b), depth)) {
        Some(Ok(v)) if truthy(Some(&v)) => v,
        Some(Err(json::Fail::Unsupported)) => return Ok(unsure()),
        _ => J::Obj(Vec::new()),
    };
    let shown_key = defaults::text("session_gates.key_shown_member");
    let shown: Vec<(String, J)> = match state.get(shown_key) {
        Some(J::Obj(m)) if matches!(state, J::Obj(_)) => m.clone(),
        Some(J::Arr(_)) if matches!(state, J::Obj(_)) => return Ok(unsure()), // `Object.assign({}, array)` copies indices: not reproduced
        _ => Vec::new(),
    };
    let shown_get = |name: &str| shown.iter().find(|(n, _)| n == name).map(|(_, v)| v);

    let sources = crate::jev::settings::Sources::load(home, env.clone());
    let generic_recorded = sources
        .settings
        .get(defaults::text("session_gates.settings_jev_member"))
        .and_then(|j| j.get(defaults::text("session_gates.generic_vendor_member")))
        .is_some();
    let s = crate::jev::JevSettings::resolve(home, sources);
    let transport = s.transport;
    let key_file = s.key_file.clone().unwrap_or_else(|| crate::jev::credentials::default_key_file(transport, home));

    let mut pending: Vec<&str> = Vec::new();
    for k in &kinds {
        if truthy(shown_get(k)) {
            continue;
        }
        let is_jev = *k == defaults::text("session_gates.key_kind_jev");
        if if is_jev { s.allow_legacy_key_read } else { allow_anthropic } {
            continue;
        }
        let present = if is_jev {
            std::fs::metadata(&key_file).is_ok_and(|m| m.is_file() && m.len() > 0)
        } else {
            env.get(defaults::text("judge.anthropic_legacy_env")).is_some_and(|v| !v.is_empty())
        };
        if present {
            pending.push(k);
        }
    }

    // a generic Jev key bound to the default vendor while the transport is typesafe, never bound on purpose
    let mut binding: Option<String> = None;
    if jev_on && !truthy(shown_get(defaults::text("session_gates.key_binding_member"))) {
        let option_set = env.get(defaults::text("env.jev_key_generic")).is_some_and(|v| !v.trim().is_empty());
        if transport == crate::jev::settings::Vendor::Typesafe && !generic_recorded && (s.key_file.is_some() || option_set) {
            binding = Some(defaults::render("session_gates.key_binding_note", &[("vendor", &defaults::text("session_gates.key_default_vendor"))]));
        }
    }
    if pending.is_empty() && binding.is_none() {
        return Ok(none());
    }

    // the stamp is written BEFORE the notice is returned; a failed write means no notice (never one at every session start)
    let now = J::Num(crate::script::host::now_ms().floor());
    let mut next_shown = shown.clone();
    for k in &pending {
        set(&mut next_shown, k, now.clone());
    }
    if binding.is_some() {
        set(&mut next_shown, defaults::text("session_gates.key_binding_member"), now.clone());
    }
    let body = json::stringify(&J::Obj(vec![(shown_key.to_string(), J::Obj(next_shown))])) + "\n";
    let write = std::fs::create_dir_all(&dir).and_then(|()| crate::atomic::write(&state_file, body.as_bytes()));
    if let Err(e) = write {
        crate::health::log_event("jev_key_notice", "SessionStart", &e.to_string());
        return Ok(unsure());
    }
    let mut parts: Vec<String> = pending
        .iter()
        .map(|k| {
            let (what, option, setting) = if *k == defaults::text("session_gates.key_kind_jev") {
                (defaults::text("session_gates.key_what_jev"), defaults::text("session_gates.key_option_jev"), defaults::text("session_gates.key_setting_jev"))
            } else {
                (
                    defaults::text("session_gates.key_what_anthropic"),
                    defaults::text("session_gates.key_option_anthropic"),
                    defaults::text("session_gates.key_setting_anthropic"),
                )
            };
            defaults::render("session_gates.key_migration_note", &[("what", &what), ("option", &option), ("setting", &setting)])
        })
        .collect();
    parts.extend(binding);
    let text = format!("{}{}", defaults::text("session_gates.key_notice_prefix"), parts.join(defaults::text("session_gates.key_notice_joiner")));
    Ok(json!({"notice": text}).to_string())
}

/// Add the session-start port functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("jevReviewDue", Function::new(c.clone(), |after: f64, min: f64| jev_review_due(after, min))?)?;
    h.set("jevReviewShown", Function::new(c.clone(), |ids: String| jev_review_shown(&ids))?)?;
    h.set("jevKeyNotice", Function::new(c.clone(), |jev: bool, judge: bool, anthropic: bool| jev_key_notice(jev, judge, anthropic))?)?;
    Ok(())
}
