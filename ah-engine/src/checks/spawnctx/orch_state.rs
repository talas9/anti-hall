//! The per-session marker behind conditional orchestration delivery: `verify-first-orch` (SessionStart) writes whether the
//! full text is still owed to the first spawn, `orch-on-spawn` reads it. Flat files in `~/.anti-hall/orch-full/`.
//!
//! Mirrors `hooks/lib/orch-full-state.js` (`markerPath`, `writeMarker`, `readMarker`) and the prune sweep of
//! `hooks/lib/state-prune.js` (`pruneStale`) that `writeMarker` runs. Every function is fail-soft, as the Node ones are.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::text::js_trim;
use crate::checks::spawnctx::{now_ms, sanitize_session};
use crate::defaults;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// A marker as read from disk.
#[derive(Debug, PartialEq, Clone)]
pub struct Marker {
    /// The epoch the marker belongs to (`String(sentAt)`).
    pub epoch_id: String,
    /// Whether the full text is still owed (`pending`) or not (`none`).
    pub decision: String,
    /// When the marker was written, in milliseconds since the epoch.
    pub sent_at: f64,
}

/// `~/.anti-hall/orch-full`.
pub fn dir_of(home: &str) -> PathBuf {
    Path::new(home).join(defaults::text("spawn_ctx.state_root")).join(defaults::text("orch_state.dir"))
}

/// `markerPath(sessionId)`: `<dir>/orch-full-<sanitized id>.json`.
pub fn marker_path(home: &str, session_id: &str) -> PathBuf {
    dir_of(home).join(format!("{}-{}.json", defaults::text("orch_state.prefix"), sanitize_session(session_id)))
}

/// `readMarker`: the marker, or `None` when it is missing, truncated or malformed.
pub fn read_marker(home: &str, session_id: &str) -> Option<Marker> {
    let bytes = std::fs::read(marker_path(home, session_id)).ok()?;
    let v: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let epoch_id = v.get("epochId")?.as_str().filter(|s| !s.is_empty())?.to_string();
    let decision = v.get("decision")?.as_str()?;
    if !defaults::list("orch_state.decisions").contains(&decision) {
        return None;
    }
    let sent_at = v.get("sentAt")?.as_f64()?;
    Some(Marker { epoch_id, decision: decision.to_string(), sent_at })
}

/// `writeMarker(sessionId, decision)`: write the marker through a temporary file and a rename, then sweep stale state.
/// `true` when the marker is in place.
pub fn write_marker(home: &str, session_id: &str, decision: &str) -> bool {
    let dir = dir_of(home);
    if std::fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let sent_at = now_ms() as u64;
    let file = marker_path(home, session_id);
    let body = format!("{{\"epochId\":\"{sent_at}\",\"decision\":{},\"sentAt\":{sent_at}}}", serde_json::to_string(decision).unwrap_or_default());
    if crate::atomic::write_styled(&file, body, crate::atomic::Style { keep_json_ext: true, ..crate::atomic::Style::default() }).is_err() {
        return false;
    }
    prune_stale(&dir, &file);
    true
}

/// `pruneStale({ stateDir, prefix, keepFile })`: remove marker and claim files older than the time to live, at most once
/// per throttle window (a stamp file records the last sweep), never the caller's own file. Fail-open and silent.
pub fn prune_stale(dir: &Path, keep: &Path) {
    let prefix = defaults::text("orch_state.prefix");
    let stamp = dir.join(format!("{}{prefix}.json", defaults::text("orch_state.stamp_prefix")));
    let now = now_ms();
    if let Ok(bytes) = std::fs::read(&stamp) {
        let text = String::from_utf8_lossy(&bytes);
        let raw = js_trim(&text);
        if !raw.is_empty()
            && let Ok(v) = serde_json::from_str::<Value>(raw)
            && let Some(last) = v.get("lastSweep").and_then(Value::as_f64)
            && last <= now
            && now - last < defaults::num("orch_state.throttle_ms") as f64
        {
            return;
        }
    }
    crate::discard::harmless(crate::atomic::write(&stamp, format!("{{\"lastSweep\":{}}}", now as u64))); // keep: a lost sweep stamp only repeats the sweep
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let keep_name = keep.file_name().and_then(|n| n.to_str()).map(str::to_string);
    let full_prefix = format!("{prefix}-");
    let ttl = defaults::num("orch_state.ttl_ms") as f64;
    for e in entries.flatten() {
        let Some(name) = e.file_name().to_str().map(str::to_string) else { continue };
        if !name.starts_with(&full_prefix) || !name.ends_with(".json") || keep_name.as_deref() == Some(name.as_str()) {
            continue;
        }
        let path = dir.join(&name);
        let Ok(mtime) = std::fs::metadata(&path).and_then(|m| m.modified()) else { continue };
        let ms = mtime.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
        if now - ms > ttl {
            crate::discard::harmless(std::fs::remove_file(&path)); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}
