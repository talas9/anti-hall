//! The two helpers a nudge-class Stop hook calls before it blocks: the stale-build downgrade of
//! `hooks/lib/stop-version-gate.js` (`isStale`) and the per-session signature ack of `hooks/lib/stop-ack.js`
//! (`signatureFor`, `isAcked`, `ackHint`).
//!
//! Anything whose answer may differ from Node's (a manifest or registry text the parser cannot judge as `JSON.parse`
//! would, an ack file holding such text) is reported as [`Unsupported`], and the caller defers to the Node hook.

use crate::checks::agent_scan::{self, Unsupported};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg;
use crate::checks::guardkit::paths::join;
use crate::checks::guardkit::settings::get_bool;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::text::{safe_name, sha1_hex};
use crate::checks::session::jval::{J, Parsed, parse};
use crate::checks::session::version_alert::{harness_version, is_semver};
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::Value;

/// `parseVersion(v)` of `update.js`: the leading dot-separated integers after trimming and dropping one `v`.
fn parse_version(v: &str) -> Option<Vec<f64>> {
    let t = js_trim(v);
    let t = t.strip_prefix(['v', 'V']).unwrap_or(t);
    // `^(\d+(?:\.\d+)*)`: digit runs joined by single dots; a dot not followed by a digit ends the match
    let b = t.as_bytes();
    let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut end = digits(0);
    if end == 0 {
        return None;
    }
    while b.get(end) == Some(&b'.') && b.get(end + 1).is_some_and(u8::is_ascii_digit) {
        end += 1 + digits(end + 1);
    }
    let parts: Vec<f64> = t[..end].split('.').map(|p| p.parse::<f64>().unwrap_or(f64::NAN)).collect();
    parts.iter().all(|n| n.is_finite()).then_some(parts)
}

/// `compareVersions(a, b)` of `update.js`: -1, 0 or 1 over the parsed parts, a missing part counting as 0.
pub(crate) fn compare_versions(a: &str, b: &str) -> i32 {
    let pa = parse_version(a).unwrap_or_else(|| vec![0.0]);
    let pb = parse_version(b).unwrap_or_else(|| vec![0.0]);
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (pa.get(i).copied().unwrap_or(0.0), pb.get(i).copied().unwrap_or(0.0));
        if x < y {
            return -1;
        }
        if x > y {
            return 1;
        }
    }
    0
}

/// `isStale(pluginRoot, { env, home })`: the host registry already names a newer version than the running plugin's own
/// manifest. Any failure Node catches is "not stale".
pub fn is_stale(env: &RequestEnv, home: &str, plugin_root: &str) -> Result<bool, Unsupported> {
    if !get_bool(&Settings::from_env(env), defaults::raw("silent_nudge.version_gate_setting")) {
        return Ok(false);
    }
    let Ok(harness) = harness_version(env, home) else { return Err(Unsupported) };
    // `require()` of the manifest: a missing or unparseable file throws, and Node answers "not stale"
    let Ok(bytes) = std::fs::read(join(plugin_root, defaults::text("session.plugin_json"))) else { return Ok(false) };
    let text = crate::checks::guardkit::text::lossy_owned(bytes);
    let running = match parse(text.strip_prefix('\u{feff}').unwrap_or(&text)) {
        Parsed::Ok(v) => v.get("version").and_then(J::as_str).map(str::to_string),
        Parsed::Bad => return Ok(false),
        Parsed::Unsure => return Err(Unsupported),
    };
    let (Some(h), Some(r)) = (harness, running) else { return Ok(false) };
    if !is_semver(&h) || !is_semver(&r) {
        return Ok(false);
    }
    Ok(compare_versions(&r, &h) < 0)
}

/// `signatureFor(subject)`: the first hex characters of the SHA-1 of the subject.
pub fn signature_for(subject: &str) -> String {
    let mut s = sha1_hex(subject);
    s.truncate(defaults::num("silent_nudge.signature_len") as usize);
    s
}

/// `statePath(home, sessionId)`: `<home>/.anti-hall/stop-ack/stop-ack-<safe session>.json`.
pub fn ack_path(home: &str, session: &str) -> String {
    let raw = if session.is_empty() { defaults::text("silent_nudge.ack_no_session") } else { session };
    let mut safe = safe_name(raw);
    // every character left is ASCII, so the UTF-16 slice is a byte slice
    safe.truncate(defaults::num("silent_nudge.ack_session_max") as usize);
    let name = format!("{}{safe}{}", defaults::text("silent_nudge.ack_file_prefix"), defaults::text("silent_nudge.ack_file_ext"));
    join(&join(home, defaults::text("silent_nudge.ack_dir")), &name)
}

fn ack_key(hook: &str, signature: &str) -> String {
    format!("{hook}{}{signature}", defaults::text("silent_nudge.ack_sep"))
}

/// `isAcked(home, sessionId, hook, signature)`: the session's ack file holds a positive finite time for this signature.
pub fn is_acked(env: &RequestEnv, home: &str, session: &str, hook: &str, signature: &str) -> Result<bool, Unsupported> {
    if home.is_empty() || session.is_empty() || hook.is_empty() || signature.is_empty() {
        return Ok(false);
    }
    if !get_bool(&Settings::from_env(env), defaults::raw("silent_nudge.ack_setting")) {
        return Ok(false);
    }
    let Ok(bytes) = std::fs::read(ack_path(home, session)) else { return Ok(false) };
    let text = crate::checks::guardkit::text::lossy_owned(bytes);
    let Some(Value::Object(state)) = agent_scan::parse_json(&text)? else { return Ok(false) };
    Ok(state.get(&ack_key(hook, signature)).and_then(Value::as_f64).is_some_and(|v| v.is_finite() && v > 0.0))
}

/// `ackHint(hook, signature, home, sessionId)`: the override sentence the nudge ends with, stamped with `now`.
pub fn ack_hint(hook: &str, signature: &str, home: &str, session: &str, now: f64) -> String {
    msg::render(
        "silent_nudge.ack_hint",
        &[("key", &ack_key(hook, signature)), ("now", &crate::checks::jsport::num::to_js_string(now)), ("path", &ack_path(home, session))],
    )
}
