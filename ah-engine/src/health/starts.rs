//! Bounded daemon-start provenance. Only the daemon owning the singleton lock records a start; all consumers are read-only.
use crate::{defaults, health, paths};
use serde_json::{Map, Value};
use std::io::Read;

/// A configured wire/record field.
fn field(name: &str) -> &'static str {
    defaults::raw("health.start_fields").str_field(name)
}

/// A configured launch reason.
pub fn reason(name: &str) -> &'static str {
    defaults::raw("health.start_reasons").str_field(name)
}

fn file() -> std::path::PathBuf {
    paths::dir().join(defaults::text("health.start_ring_file"))
}

fn rows() -> Vec<Value> {
    let cap = defaults::num("health.start_ring_bytes");
    let Ok(f) = std::fs::File::open(file()) else { return Vec::new() };
    let mut bytes = Vec::new();
    if f.take(cap.saturating_add(1)).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > cap {
        return Vec::new();
    }
    serde_json::from_slice::<Vec<Value>>(&bytes)
        .unwrap_or_default()
        .into_iter()
        .rev()
        .take(defaults::num("health.start_ring_rows") as usize)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// The explicit launcher's reason, or manual for an unlabelled `serve`. Unknown labels cannot grow the reason cardinality.
pub fn requested(args: &[String]) -> String {
    let flag = defaults::text("health.start_reason_flag");
    let requested = args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1));
    let allowed = defaults::raw("health.start_reasons").as_table().unwrap_or(&[]);
    requested.filter(|r| allowed.iter().any(|(_, v)| v.as_str() == Some(r.as_str()))).map_or_else(|| reason("manual").to_string(), Clone::clone)
}

/// Record only once the listener exists and the singleton is ours. Reaping happened before this call, including when a hook
/// client already reaped the old run marker. A later clean exit or system-restart event prevents an old crash being reused.
pub fn record(trigger: &str) {
    let mut ring = rows();
    let last_start = ring.last().and_then(|r| r.get(field("timestamp"))).and_then(Value::as_u64).unwrap_or(0);
    let lifecycle = defaults::list("health.start_lifecycle_kinds");
    let crashes = defaults::list("health.start_crash_kinds");
    let recovered =
        health::events().iter().rev().find(|e| e.ts >= last_start && lifecycle.contains(&e.kind.as_str())).is_some_and(|e| crashes.contains(&e.kind.as_str()));
    let mut row = Map::new();
    row.insert(field("timestamp").into(), Value::from(health::now_ms()));
    row.insert(field("pid").into(), Value::from(std::process::id()));
    row.insert(field("trigger").into(), Value::from(trigger));
    row.insert(field("reason").into(), Value::from(if recovered { reason("crash") } else { trigger }));
    ring.push(Value::Object(row));
    let keep = defaults::num("health.start_ring_rows") as usize;
    if ring.len() > keep {
        ring.drain(..ring.len() - keep);
    }
    let cap = defaults::num("health.start_ring_bytes") as usize;
    let mut bytes = serde_json::to_vec(&ring).unwrap_or_default();
    while bytes.len() > cap && !ring.is_empty() {
        ring.remove(0);
        bytes = serde_json::to_vec(&ring).unwrap_or_default();
    }
    crate::discard::logged(defaults::text("health.start_ring_write_kind"), crate::atomic::write(file(), bytes));
}

fn counts(ring: &[Value]) -> Value {
    let mut counts = Map::new();
    for row in ring {
        if let Some(reason) = row.get(field("reason")).and_then(Value::as_str) {
            let n = counts.get(reason).and_then(Value::as_u64).unwrap_or(0);
            counts.insert(reason.into(), Value::from(n.saturating_add(1)));
        }
    }
    Value::Object(counts)
}

/// Health exposes counts for the bounded retained history and the most recent timestamp/reason/trigger.
pub fn add_summary(summary: &mut Value) {
    let ring = rows();
    summary[field("counts")] = counts(&ring);
    summary[field("last")] = ring.last().cloned().unwrap_or(Value::Null);
}

/// The doctor's single provenance line, with the same retained-history scope as status.
pub fn doctor_line() -> String {
    let ring = rows();
    let last = ring.last();
    let ts = last.and_then(|r| r.get(field("timestamp"))).and_then(Value::as_u64).unwrap_or(0);
    let why = last.and_then(|r| r.get(field("reason"))).and_then(Value::as_str).unwrap_or_default();
    defaults::render("health.start_doctor_line", &[("counts", &counts(&ring)), ("timestamp", &ts), ("reason", &why)])
}
