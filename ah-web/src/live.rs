//! What the Live screen needs beyond the shared stream: the hook wiring (which checks answer which events, from `ah-engine describe`)
//! and the engine's action log, followed for new lines. Both are reads.
use crate::app::App;
use crate::cfg::Settings;
use ah_web_proto::{ActionEvt, JevEvt, LiveMap};
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

/// The complete new lines of `path` since `*offset` (the first call starts at the end, so history is not replayed). A file that shrank
/// was rotated: it is read from its start. A backlog over `max_bytes` is skipped to its newest bytes.
fn tail_lines(path: &std::path::Path, offset: &mut Option<u64>, max_bytes: u64) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
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
    let start = from.max(len.saturating_sub(max_bytes));
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
    lines.map(str::to_string).collect()
}

/// New lines of the engine's action log.
pub fn new_actions(s: &Settings, socket: &std::path::Path, offset: &mut Option<u64>) -> Vec<ActionEvt> {
    let Some(dir) = socket.parent() else { return Vec::new() };
    tail_lines(&dir.join(&s.live_actions_file), offset, s.live_actions_max_bytes)
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("t").and_then(Value::as_str) == Some("action"))
        .map(|v| {
            let t = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
            ActionEvt { ts_ms: v.get("ts").and_then(Value::as_u64).unwrap_or(0), feature: t("feature"), action: t("action"), target: t("target"), outcome: t("outcome"), reason: t("reason") }
        })
        .collect()
}

/// Milliseconds since the epoch of `YYYY-MM-DDTHH:MM:SS(.mmm)Z`; `None` for any other shape.
fn iso_ms(t: &str) -> Option<u64> {
    let n = |r: std::ops::Range<usize>| t.get(r)?.parse::<i64>().ok();
    let (y, m, d, hh, mm, ss) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let ms = t.get(20..23).and_then(|x| x.parse::<i64>().ok()).unwrap_or(0);
    // days from civil (Howard Hinnant)
    let (y2, m2) = if m <= 2 { (y - 1, m + 9) } else { (y, m - 3) };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    u64::try_from(((days * 24 + hh) * 60 + mm) * 60_000 + ss * 1000 + ms).ok()
}

/// New rows of the Jev decision log (under the user's home).
pub fn new_jev(s: &Settings, offset: &mut Option<u64>) -> Vec<JevEvt> {
    let Ok(home) = std::env::var("HOME") else { return Vec::new() };
    tail_lines(&std::path::Path::new(&home).join(&s.live_jev_log_rel), offset, s.live_actions_max_bytes)
        .iter()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("type").is_none())
        .map(|v| {
            let t = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
            JevEvt {
                ts_ms: v.get("ts").and_then(Value::as_str).and_then(iso_ms).unwrap_or(0),
                id: t("id"),
                verdict: v.get("jev").filter(|j| !j.is_null()).map(Value::to_string).unwrap_or_default(),
                conf: v.get("conf").and_then(Value::as_f64),
                mode: t("mode"),
                latency_ms: v.get("ms").and_then(Value::as_u64).unwrap_or(0),
                cost_usd: v.get("costUsd").and_then(Value::as_f64),
                reason: t("reason"),
                changed: v.get("changed").is_some_and(|c| !c.is_null() && *c != Value::Bool(false)),
            }
        })
        .collect()
}
