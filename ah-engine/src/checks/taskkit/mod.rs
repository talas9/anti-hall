//! Helpers shared by the task checks ported from Node (task-lifecycle-log, dispatch-tier, task-tracker, task-guard,
//! tasklist-guard): JavaScript string conversion of a JSON value, the ledger text sanitizer, the UTC clock text and the
//! project root resolver (`hooks/lib/handover-find.js` `repoRoot`).
//!
//! Every function either answers exactly as the Node original does or says it cannot (`None`); the caller then defers
//! the whole call to the Node hook, so an input these helpers cannot judge never becomes a silent decision (D74).
pub mod jsval;
pub mod root;
pub mod time;
pub mod workdetect;

use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{collapse_ws, js_trim, slice_utf16};
use crate::defaults;
use serde_json::Value;
use std::sync::OnceLock;

/// `String(v)` for a JSON value, as JavaScript prints it. `None` for a number whose JavaScript text differs from the Rust
/// one (a fraction below 1e-6, or 1e21 and up), which the caller defers.
pub fn js_string(v: &Value) -> Option<String> {
    match v {
        Value::Null => Some("null".into()),
        Value::Bool(b) => Some(b.to_string()),
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => {
            let f = n.as_f64()?;
            if f == 0.0 {
                return Some("0".into());
            }
            if !f.is_finite() || f.abs() >= 1e21 || f.abs() < 1e-6 {
                return None;
            }
            let text = format!("{f}");
            // With at most `taskkit.exact_digits` significant digits the shortest round-trip text is unique, so Rust and
            // JavaScript print the same digits; with more, either may pick a different one of several valid texts.
            let digits = text.chars().filter(char::is_ascii_digit).collect::<String>();
            let sig = digits.trim_start_matches('0').trim_end_matches('0').len();
            (sig <= defaults::num("taskkit.exact_digits") as usize).then_some(text)
        }
        // `Array.prototype.toString`: the elements joined with a comma, null as the empty string.
        Value::Array(a) => {
            let mut parts = Vec::with_capacity(a.len());
            for e in a {
                parts.push(if e.is_null() { String::new() } else { js_string(e)? });
            }
            Some(parts.join(","))
        }
        Value::Object(_) => Some("[object Object]".into()),
    }
}

/// The session id as it becomes a file name part: every character outside `[A-Za-z0-9_-]` is removed, and an empty
/// result becomes the unknown-session id (`sanitizeSessionId` of the Node hook).
pub fn session_path_id(raw: &str) -> String {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| jsre::compile(defaults::text("taskkit.session_id_unsafe"), false));
    let safe = re.replace_all(raw, "");
    if safe.is_empty() { defaults::text("taskkit.unknown_session").to_string() } else { safe.into_owned() }
}

/// `sanitizeText(s, max)` of the Node hook: a non-string is empty; control characters become spaces, white space runs
/// collapse, the text is trimmed and cut to `max` UTF-16 units with an ellipsis. `None` when the cut would split a
/// surrogate pair (JavaScript would keep a lone surrogate, which a Rust string cannot hold).
pub fn sanitize_text(s: &Value, max: usize) -> Option<String> {
    let Value::String(s) = s else { return Some(String::new()) };
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| jsre::compile(defaults::text("taskkit.control_chars"), false));
    let spaced = re.replace_all(s, " ");
    let out = js_trim(&collapse_ws(&spaced)).to_string();
    let units: usize = out.chars().map(char::len_utf16).sum();
    if units > max {
        let cut = slice_utf16(&out, max)?;
        return Some(format!("{cut}{}", defaults::text("taskkit.ellipsis")));
    }
    Some(out)
}

/// `detectPlatform(payload) === 'codex'` (`hooks/lib/auto-handover-text.js`): a `turn_id` string, or a transcript path that is a
/// Codex rollout or lives under a `.codex` directory.
pub fn is_codex_platform(p: &Value) -> bool {
    if !p.is_object() && !p.is_array() {
        return false;
    }
    if jsval::get(p, "turn_id").and_then(Value::as_str).is_some_and(|t| !t.is_empty()) {
        return true;
    }
    let tp = jsval::get(p, "transcript_path").and_then(Value::as_str).unwrap_or("");
    static RE: OnceLock<(regex::Regex, regex::Regex)> = OnceLock::new();
    let (rollout, dotcodex) =
        RE.get_or_init(|| (jsre::compile(defaults::text("taskkit.codex_rollout"), false), jsre::compile(defaults::text("taskkit.codex_dir"), false)));
    rollout.is_match(tp) || dotcodex.is_match(tp)
}
