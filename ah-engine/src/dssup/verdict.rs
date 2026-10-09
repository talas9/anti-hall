//! The mirror of an engine poke / escalation in Node's files: the liveness verdict (`liveness/<id>.json`, written by
//! `recovery.js` `mergeVerdict` + `writeVerdict`) and the recovery log line (`appendLog`). Node's consumers (the doctor, the
//! start-up sampling, the recovery cap) read these files, so an engine-owned poke must leave them as Node would.
//!
//! The JSON is written by hand in Node's key order (`JSON.stringify` of `Object.assign({status}, preserved, extra)`): the
//! engine's JSON maps sort their keys, which would change the bytes.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable previous verdict is an absent one (Node's try/catch): the preserved fields start at their defaults
// - a verdict or log line that cannot be written is lost, never the action's result (Node: `try { writeVerdict } catch {}`)
use crate::defaults;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The verdict file of `id`; `None` for an id that is not a safe file name (Node throws and the caller fails open).
pub fn path(home: &Path, id: &str) -> Option<PathBuf> {
    crate::meshw::idlock::is_safe_id(id).then(|| super::root(home).join(defaults::text("devswarm_sup.liveness_dir")).join(format!("{id}.json")))
}

fn default_of(field: &str) -> Value {
    if defaults::list("devswarm_sup.verdict_zero_fields").contains(&field) { Value::from(0) } else { Value::Null }
}

/// `Object.assign({status}, preserved, extra)` as ordered pairs: a key set again keeps its place, a new key goes last.
pub fn merged(prev: Option<&Value>, status: &str, extra: &[(&str, Value)]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = vec![("status".into(), Value::String(status.into()))];
    for f in defaults::list("devswarm_sup.verdict_fields") {
        let kept = prev.and_then(|p| p.get(f)).filter(|v| !v.is_null()).cloned();
        out.push((f.into(), kept.unwrap_or_else(|| default_of(f))));
    }
    for (k, v) in extra {
        match out.iter_mut().find(|(ek, _)| ek == k) {
            Some(slot) => slot.1 = v.clone(),
            None => out.push(((*k).into(), v.clone())),
        }
    }
    out
}

/// `JSON.stringify` of ordered pairs.
pub fn stringify(pairs: &[(String, Value)]) -> String {
    let body: Vec<String> = pairs.iter().map(|(k, v)| format!("{}:{}", Value::String(k.clone()), v)).collect();
    format!("{{{}}}", body.join(","))
}

/// Merge `status` and `extra` into the verdict of `id` and write it the way Node does (a `.tmp` file, then a rename).
pub fn persist(home: &Path, id: &str, status: &str, extra: &[(&str, Value)]) -> Option<String> {
    let p = path(home, id)?;
    let prev: Option<Value> = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok());
    let text = stringify(&merged(prev.as_ref(), status, extra));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    if crate::atomic::write(&p, &text).is_err() {
        return None;
    }
    Some(text)
}

/// One line of the recovery log: `{"ts":<now>,<fields>}`.
pub fn log_line(now: i64, fields: &[(&str, Value)]) -> String {
    let mut pairs: Vec<(String, Value)> = vec![("ts".into(), Value::from(now))];
    pairs.extend(fields.iter().map(|(k, v)| ((*k).to_string(), v.clone())));
    stringify(&pairs)
}

/// Append one line to the recovery log (best effort).
pub fn append_log(home: &Path, now: i64, fields: &[(&str, Value)]) {
    use std::io::Write;
    let p = super::root(home).join(defaults::text("devswarm_sup.recovery_log"));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the open below reports the failure
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        crate::discard::harmless(writeln!(f, "{}", log_line(now, fields))); // keep: a lost log line never changes the action
    }
}

/// An engine poke (attempt `attempt`, at `now`) as Node's `pokeOrEscalate` records it.
pub fn mirror_poke(home: &Path, id: &str, attempt: u64, now: i64) {
    append_log(home, now, &[("id", id.into()), ("action", "nudged".into()), ("attempt", attempt.into())]);
    let extra = [("nudgeAttempts", Value::from(attempt)), ("nudgedAt", Value::from(now)), ("lastNudgeError", Value::Null)];
    persist(home, id, defaults::text("devswarm_sup.status_nudged"), &extra);
}

/// An engine escalation as Node's `pokeOrEscalate` records it (the verdict is terminal `escalated`).
pub fn mirror_escalate(home: &Path, id: &str, now: i64) {
    let prev: Option<Value> = path(home, id).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok());
    let last = prev.as_ref().and_then(|p| p.get("lastNudgeError")).filter(|v| !v.is_null()).cloned();
    let mut fields: Vec<(&str, Value)> =
        vec![("id", id.into()), ("action", "escalate".into()), ("reason", defaults::text("devswarm_sup.reason_exhausted").into())];
    if let Some(l) = last {
        fields.push(("lastNudgeError", l));
    }
    append_log(home, now, &fields);
    persist(home, id, defaults::text("devswarm_sup.status_escalated"), &[]);
}
