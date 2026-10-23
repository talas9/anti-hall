//! What the Live screen needs beyond the shared stream: the hook wiring (which checks answer which events, from `ah-engine describe`)
//! and the engine's action log, followed for new lines. Both are reads.
use crate::app::App;
use crate::cfg::Settings;
use ah_web_proto::{ActionEvt, LiveMap};
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::time::{Duration, Instant};

/// The wiring, from a `describe bindings` document: every host's events, and the checks each one runs.
pub fn reduce_map(doc: &Value) -> LiveMap {
    let mut m = LiveMap::default();
    for row in doc.get("bindings").and_then(Value::as_array).into_iter().flatten() {
        let Some(event) = row.get("event").and_then(Value::as_str) else { continue };
        if !m.events.iter().any(|e| e == event) {
            m.events.push(event.to_string());
        }
        for e in row.get("entries").and_then(Value::as_array).into_iter().flatten() {
            let Some(check) = e.get("check").and_then(Value::as_str) else { continue };
            if !m.checks.iter().any(|c| c == check) {
                m.checks.push(check.to_string());
            }
            let pair = (event.to_string(), check.to_string());
            if !m.edges.contains(&pair) {
                m.edges.push(pair);
            }
        }
    }
    m
}

/// The wiring, cached for `web.live_map_ttl_s`; an engine that does not answer leaves the last good one (or an empty one).
pub async fn map(app: &App, s: &Settings) -> LiveMap {
    if let Some((at, m)) = app.live_map.lock().unwrap_or_else(|p| p.into_inner()).as_ref()
        && at.elapsed() < Duration::from_secs(s.live_map_ttl_s)
    {
        return m.clone();
    }
    let run = tokio::process::Command::new(&app.engine)
        .arg("describe")
        .arg("--part")
        .arg(s.live_map_parts.join(","))
        .arg("--json")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let fresh = match tokio::time::timeout(Duration::from_millis(s.live_map_timeout_ms), run).await {
        Ok(Ok(out)) => serde_json::from_slice::<Value>(&out.stdout).ok().map(|d| reduce_map(&d)),
        _ => None,
    };
    let mut slot = app.live_map.lock().unwrap_or_else(|p| p.into_inner());
    match fresh {
        Some(m) => {
            *slot = Some((Instant::now(), m.clone()));
            m
        }
        None => slot.as_ref().map(|(_, m)| m.clone()).unwrap_or_default(),
    }
}

/// New lines of the action log since `*offset` (the first call starts at the end, so history is not replayed). A log that shrank was
/// rotated: it is read from its start.
pub fn new_actions(s: &Settings, socket: &std::path::Path, offset: &mut Option<u64>) -> Vec<ActionEvt> {
    let Some(dir) = socket.parent() else { return Vec::new() };
    let path = dir.join(&s.live_actions_file);
    let Ok(mut f) = std::fs::File::open(&path) else { return Vec::new() };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return Vec::new() };
    let from = match *offset {
        None => len,
        Some(o) if o > len => 0,
        Some(o) => o,
    };
    *offset = Some(len);
    if len == from {
        return Vec::new();
    }
    // a backlog bigger than the cap is skipped to its newest bytes
    let start = from.max(len.saturating_sub(s.live_actions_max_bytes));
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.take(len - start).read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines = text.split('\n');
    if start > from {
        lines.next(); // the first line of a skipped-into backlog is cut
    }
    lines
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("t").and_then(Value::as_str) == Some("action"))
        .map(|v| {
            let t = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
            ActionEvt { ts_ms: v.get("ts").and_then(Value::as_u64).unwrap_or(0), feature: t("feature"), action: t("action"), target: t("target"), outcome: t("outcome"), reason: t("reason") }
        })
        .collect()
}
