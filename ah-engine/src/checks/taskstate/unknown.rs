//! The unknown-state note and the state-file sweep it triggers: ports of `lib/task-state.js` `unknownOf` and `unknownNote`
//! and `lib/state-prune.js` `pruneStale`.
use super::TaskMap;
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure, number_of_str, scalar_string, truthy};
use crate::defaults;
use serde_json::Value;
use std::path::Path;

pub use crate::checks::jsport::text::sha1_hex;

/// `unknownOf(taskMap)`: tasks whose status is unknown, and open tasks whose block state could not be established.
pub fn unknown_ids(tasks: &TaskMap) -> Vec<String> {
    tasks.values().filter(|t| t.status.is_none() || (t.is_open() && t.block_unknown)).map(|t| t.id.clone()).collect()
}

/// Sort strings the way JavaScript's default `Array.prototype.sort` does (by UTF-16 code units).
pub fn js_sort(v: &mut [String]) {
    v.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `String(x).replace(/[^A-Za-z0-9_.-]/g, '_')`: one underscore per UTF-16 unit outside the safe set.
pub fn safe_key(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
        } else {
            for _ in 0..c.len_utf16() {
                out.push('_');
            }
        }
    }
    out
}

fn now_ms() -> f64 {
    crate::checks::taskkit::time::now_ms() as f64
}

/// `pruneStale({ stateDir, prefix, keepFile })`: remove old per-session files of one prefix, at most once per throttle window.
pub fn prune_stale(state_dir: &Path, prefix: &str, keep_file: &Path) {
    let keep = keep_file.file_name().map(|n| n.to_string_lossy().into_owned());
    let ttl = defaults::num("taskstate.prune_ttl_days") as f64 * 86_400_000.0;
    let throttle = defaults::num("taskstate.prune_throttle_hours") as f64 * 3_600_000.0;
    let stamp = state_dir.join(format!("{}{prefix}.json", defaults::text("taskstate.prune_stamp_prefix")));
    let now = now_ms();
    if let Ok(raw) = std::fs::read_to_string(&stamp)
        && let Ok(Value::Object(o)) = serde_json::from_str::<Value>(js_trim(&raw))
        && let Some(last) = o.get("lastSweep").and_then(Value::as_f64)
        && last <= now
        && now - last < throttle
    {
        return;
    }
    crate::discard::harmless(crate::atomic::write(&stamp, format!("{{\"lastSweep\":{}}}", now as i64))); // keep: a lost sweep stamp only repeats the sweep
    let Ok(entries) = std::fs::read_dir(state_dir) else { return };
    let full_prefix = format!("{prefix}-");
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if !name.starts_with(&full_prefix) || !name.ends_with(".json") || keep.as_deref() == Some(name.as_str()) {
            continue;
        }
        let path = e.path();
        let Ok(mtime) = std::fs::metadata(&path).and_then(|m| m.modified()) else { continue };
        let ms = mtime.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
        if now - ms > ttl {
            crate::discard::harmless(std::fs::remove_file(&path)); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

/// `Number(x) || 0` for a stored counter.
fn counter(v: Option<&Value>) -> R<f64> {
    let n = match v {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(*b),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => number_of_str(s),
        Some(_) => return Err(Unsure),
    };
    Ok(if n.is_nan() { 0.0 } else { n })
}

/// `unknownNote(taskMap, { sessionId, tag })`: the one short line, or an empty string. Throttled by the set of unknown ids and a
/// per-session maximum; state lives in `<home>/.anti-hall/last-unknown-<tag>-<session>.json`.
pub fn unknown_note(tasks: &TaskMap, home: &str, session_id: &str, tag: &str) -> R<String> {
    let mut ids = unknown_ids(tasks);
    if ids.is_empty() {
        return Ok(String::new());
    }
    let count = ids.len();
    js_sort(&mut ids);
    let hash = sha1_hex(ids.join("\u{0}").as_bytes());
    let sid = safe_key(if session_id.is_empty() { "nosession" } else { session_id });
    let dir = Path::new(home).join(defaults::text("paths.base_dir"));
    let prefix = defaults::text("taskstate.unknown_file_prefix");
    let file = dir.join(format!("{prefix}-{tag}-{sid}.json"));
    let (mut last_hash, mut last_n) = (String::new(), 0f64);
    if let Ok(raw) = std::fs::read_to_string(&file)
        && let Ok(parsed) = serde_json::from_str::<Value>(js_trim(&raw))
        && let Value::Object(_) | Value::Array(_) = &parsed
    {
        let h = parsed.get("hash").filter(|v| truthy(v));
        last_hash = match h {
            Some(v) => scalar_string(v)?,
            None => String::new(),
        };
        last_n = counter(parsed.get("n"))?;
    }
    if last_hash == hash || last_n >= defaults::num("taskstate.unknown_max_notes") as f64 {
        return Ok(String::new());
    }
    if std::fs::create_dir_all(&dir).is_err() || crate::atomic::write(&file, format!("{{\"hash\":\"{hash}\",\"n\":{}}}", last_n + 1.0)).is_err() {
        return Ok(String::new());
    }
    prune_stale(&dir, prefix, &file);
    Ok(defaults::render("taskstate.unknown_note_text", &[("n", &count)]))
}
