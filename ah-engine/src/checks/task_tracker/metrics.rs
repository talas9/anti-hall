//! Scoring the previous turn's dispatch demand (`resolvePending` of `hooks/lib/dispatch-demand.js`), planned without writing.
//!
//! The per-turn DISPATCH NOW line leaves a pending entry in the metrics file; the next prompt scores it as followed (an
//! agent was spawned since) or ignored, drops entries that have waited too long, and rewrites the file when anything changed.
//! The engine never shows that line (such a session is left to Node), but it must still score what Node left pending, and it
//! must write the file exactly as Node does.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::jsdiff::js_reads_differently_str;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure};
use crate::checks::taskstate::tail::{lines_of, parse_iso_ms, read_tail};
use crate::checks::taskstate::unknown::safe_key;
use crate::defaults;
use serde_json::Value;

/// A rewrite of the metrics file that is due.
pub struct Write {
    /// The file.
    pub path: String,
    /// Its new content.
    pub body: String,
}

/// `sessionKey(sid)`: the session id with every unsafe character replaced, cut to the key length.
fn session_key(session: &str) -> String {
    let s = if session.is_empty() { defaults::text("task_tracker.unknown_session") } else { session };
    safe_key(s).chars().take(defaults::num("task_tracker.session_key_max") as usize).collect()
}

fn finite_ts(v: &OVal) -> Option<f64> {
    match v.get("ts") {
        Some(OVal::Num(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}

/// `spawnedSince(transcriptPath, sinceMs)`: an Agent, Task or Workflow tool call at or after `since` in the end of the
/// transcript.
fn spawned_since(tp: &str, since: f64) -> R<bool> {
    let window = defaults::num("taskstate.tail_bytes");
    if std::fs::metadata(tp).map(|m| m.len()).unwrap_or(0) == 0 {
        return Ok(false);
    }
    let Some((data, truncated)) = read_tail(tp, window) else { return Ok(false) };
    let name_re = jsre::compile(defaults::text("task_tracker.spawn_name_re"), false);
    let names = defaults::list("task_tracker.spawn_names");
    for raw in lines_of(&data, truncated) {
        if !raw.contains(defaults::text("task_tracker.spawn_marker")) || !name_re.is_match(raw) {
            continue;
        }
        if js_reads_differently_str(raw) {
            return Err(Unsure);
        }
        let Ok(e) = serde_json::from_str::<Value>(raw) else { continue };
        let ts = match e.get("timestamp") {
            Some(Value::String(s)) => parse_iso_ms(s)?,
            _ => None,
        };
        if !ts.is_some_and(|t| t.is_finite() && t >= since) {
            continue;
        }
        let content = e.get("message").and_then(|m| m.get("content")).and_then(Value::as_array);
        if content.is_some_and(|c| {
            c.iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_use") && b.get("name").and_then(Value::as_str).is_some_and(|n| names.contains(&n)))
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The metrics file after `resolvePending` for this session, when it differs from what is on disk.
///
/// `transcript` is the payload's transcript path when it is a non-empty string; `has_transcript` says the payload's value was
/// truthy at all (a truthy non-string never finds a spawn, but does score the entry).
pub fn resolve_pending(home: &str, session: &str, transcript: Option<&str>, has_transcript: bool, now: f64) -> R<Option<Write>> {
    let path = format!("{home}/{}/{}", defaults::text("paths.base_dir"), defaults::text("task_tracker.metrics_file"));
    let mut m = match std::fs::read(&path) {
        Err(_) => OVal::Obj(Vec::new()),
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if js_reads_differently_str(&text) {
                return Err(Unsure);
            }
            match OVal::parse(js_trim(&text)) {
                Some(v @ OVal::Obj(_)) => v,
                Some(OVal::Arr(_)) => return Err(Unsure),
                _ => OVal::Obj(Vec::new()),
            }
        }
    };
    for k in defaults::list("task_tracker.metrics_counters") {
        let ok = matches!(m.get(k), Some(OVal::Num(n)) if n.is_finite() && *n >= 0.0);
        if !ok {
            m.set(k, OVal::Num(0.0));
        }
    }
    let pending_key = defaults::text("task_tracker.metrics_pending");
    match m.get(pending_key) {
        Some(OVal::Obj(_)) => {}
        Some(OVal::Arr(_)) => return Err(Unsure),
        _ => m.set(pending_key, OVal::Obj(Vec::new())),
    }
    let ttl = defaults::num("task_tracker.metrics_pending_ttl_ms") as f64;
    let key = session_key(session);
    let mut dirty = false;
    let OVal::Obj(fields) = &m else { return Err(Unsure) };
    let Some(OVal::Obj(pending)) = fields.iter().find(|(k, _)| k == pending_key).map(|(_, v)| v) else { return Err(Unsure) };
    let mut kept: Vec<(String, OVal)> = Vec::new();
    for (k, v) in pending {
        match finite_ts(v) {
            Some(ts) if now - ts <= ttl => kept.push((k.clone(), v.clone())),
            _ => dirty = true,
        }
    }
    let mut followed_or_ignored: Option<&'static str> = None;
    if let Some(pos) = kept.iter().position(|(k, _)| *k == key)
        && has_transcript
    {
        let ts = finite_ts(&kept[pos].1).unwrap_or(0.0);
        let spawned = match transcript {
            Some(tp) => spawned_since(tp, ts)?,
            None => false,
        };
        followed_or_ignored = Some(if spawned { defaults::text("task_tracker.metrics_followed") } else { defaults::text("task_tracker.metrics_ignored") });
        kept.remove(pos);
        dirty = true;
    }
    if !dirty {
        return Ok(None);
    }
    m.set(pending_key, OVal::Obj(kept));
    if let Some(counter) = followed_or_ignored {
        let n = match m.get(counter) {
            Some(OVal::Num(n)) => *n,
            _ => 0.0,
        };
        m.set(counter, OVal::Num(n + 1.0));
    }
    Ok(Some(Write { path, body: m.stringify() }))
}

/// Write the file as `writeMetrics` does: a temporary file beside it, then a rename. A failure is lost silently.
pub fn write(w: &Write) {
    let tmp = format!("{}.{}.tmp", w.path, std::process::id());
    if let Some(dir) = std::path::Path::new(&w.path).parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: best effort, as Node's try/catch
    }
    if std::fs::write(&tmp, &w.body).is_ok() {
        crate::discard::harmless(std::fs::rename(&tmp, &w.path)); // keep: best effort, as Node's try/catch
    }
}
