//! The spawn-result event: what an agent launch actually ran on and used, recorded by the engine at the end of the launch call
//! (`telemetry.spawn_result`). It is linked to the model-routing decision of that launch by the spawn key, which is rebuilt here
//! from the same payload fields the routing check hashes, so routing savings can be computed.
//!
//! Background launches retain a hashed child identity; completion reads actual usage from the explicitly identified child transcript.

use super::event::{Event, Extras, Kind, Outcome, Spawn, Token, Usage};
use crate::defaults;
use serde_json::Value;

/// The spawn key of a launch payload: `<key_prefix><fnv(session, agent, subagent type, fnv(prompt prefix))>`. Mirrors the routing
/// check, which bounds each part to `telemetry.token_max_len` bytes.
pub fn spawn_key(payload: &Value) -> String {
    let cfg = defaults::raw("telemetry.spawn_result");
    let f = |k: &str| cfg.str_field(k);
    let input = &payload[f("input")];
    let text = |v: &Value| v.as_str().unwrap_or_default().to_string();
    let keep = defaults::num("model_routing.key_prefix_chars") as usize;
    let prefix: String = input[f("prompt")].as_str().unwrap_or_default().chars().take(keep).collect();
    let bounded = |s: &str| {
        let limit = defaults::num("telemetry.token_max_len") as usize;
        let mut used = 0;
        s.chars()
            .take_while(|c| {
                used += c.len_utf8();
                used <= limit
            })
            .collect::<String>()
    };
    let identity = [
        bounded(&text(&payload[f("session")])),
        bounded(&text(&payload[f("agent")])),
        bounded(input[f("subagent_type")].as_str().unwrap_or_default().trim()),
        format!("{:016x}", crate::health::fnv(&prefix)),
    ]
    .join(f("sep"));
    format!("{}{:016x}", f("key_prefix"), crate::health::fnv(&identity))
}

fn field<'a>(v: &'a Value, names: &str) -> Option<&'a Value> {
    defaults::list(names).iter().find_map(|k| v.get(*k).filter(|v| !v.is_null()))
}

fn identity(payload: &Value, id: &str) -> Option<Token> {
    let cfg = defaults::raw("telemetry.spawn_result");
    let session = payload[cfg.str_field("session")].as_str().filter(|s| !s.is_empty())?;
    if id.is_empty() {
        return None;
    }
    Some(Token::sanitize(&format!("{:016x}", crate::health::fnv(&format!("{session}{}{id}", cfg.str_field("sep"))))))
}

fn usage_of(usage: &Value) -> Option<Usage> {
    if !usage.is_object() {
        return None;
    }
    let cfg = defaults::raw("telemetry.spawn_result");
    let optional = |k: &str| match usage.get(cfg.str_field(k)) {
        None => Some(0),
        Some(v) => v.as_u64(),
    };
    Some(Usage {
        input: usage[cfg.str_field("in")].as_u64()?,
        output: usage[cfg.str_field("out")].as_u64()?,
        cache_read: optional("cache_read")?,
        cache_write: optional("cache_write")?,
    })
}

/// Record both legacy Task and Agent launches. An identity-only row has no measured usage and is never a savings result.
pub fn event_of(event: &str, payload: &Value, now_ms: u64) -> Option<Event> {
    let cfg = defaults::raw("telemetry.spawn_result");
    let f = |k: &str| cfg.str_field(k);
    if event != f("event") || !defaults::list("telemetry.spawn_tools").contains(&payload["tool_name"].as_str()?) {
        return None;
    }
    let resp = &payload[f("response")];
    let agent_key = field(resp, "telemetry.spawn_agent_fields").and_then(Value::as_str).and_then(|s| identity(payload, s));
    let model = field(resp, "telemetry.spawn_model_fields").and_then(Value::as_str).filter(|s| !s.is_empty());
    let finished = resp[defaults::text("telemetry.spawn_status_field")].as_str() == Some(defaults::text("telemetry.spawn_completed_status"));
    let background = payload[f("input")][defaults::text("telemetry.spawn_background_field")].as_bool() == Some(true);
    let usage = if background && !finished { None } else { usage_of(&resp[f("usage")]) };
    if agent_key.is_none() && (model.is_none() || usage.is_none()) {
        return None;
    }
    Some(Event {
        ts_ms: now_ms,
        kind: Kind::Spawn,
        h: Token::sanitize(f("check")),
        e: Token::sanitize(event),
        o: Outcome::Allow,
        ms: 0,
        ib: 0,
        extras: Extras::Spawn(Spawn {
            started_ms: usage.filter(|_| model.is_some()).is_none().then_some(now_ms),
            agent_key,
            spawn_key: Token::sanitize(&spawn_key(payload)),
            actual_model: Token::sanitize(model.unwrap_or(defaults::text("telemetry.spawn_unknown_model"))),
            usage: if model.is_some() { usage.unwrap_or_default() } else { Usage::default() },
        }),
    })
}

/// Use an observed routing timestamp only when exactly one unconsumed, nonblocked launch matches the key.
/// Repeated/concurrent identical briefs are ambiguous: leave them unlinked rather than inventing a start time.
pub fn link_launch(mut launch: Event, events: &[Event]) -> Option<Event> {
    let Extras::Spawn(spawn) = &mut launch.extras else {
        return None;
    };
    let previous = events
        .iter()
        .filter_map(|e| match &e.extras {
            Extras::Spawn(s) if s.spawn_key == spawn.spawn_key && s.usage != Usage::default() && (s.agent_key.is_none() || s.agent_key != spawn.agent_key) => {
                Some(s.started_ms.unwrap_or(e.ts_ms))
            }
            _ => None,
        })
        .max();
    let starts: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.extras {
            Extras::Route(r) if r.spawn_key == spawn.spawn_key && e.o != Outcome::Block && e.ts_ms <= launch.ts_ms && previous.is_none_or(|p| e.ts_ms > p) => {
                Some(e.ts_ms)
            }
            _ => None,
        })
        .collect();
    if starts.len() != 1 {
        return None;
    }
    spawn.started_ms = starts.first().copied();
    Some(launch)
}

/// Foreground SubagentStop can precede PostToolUse. Recover from the returned child identity and the tracker's configured
/// transcript layout, only when the parent transcript is explicit and the child id is a safe filename component.
pub fn launch_completion(payload: &Value, launch: &Event, now: u64) -> Option<Event> {
    let Extras::Spawn(spawn) = &launch.extras else {
        return None;
    };
    if spawn.usage != Usage::default() {
        return None;
    }
    let cfg = defaults::raw("telemetry.spawn_result");
    let resp = &payload[cfg.str_field("response")];
    if resp[defaults::text("telemetry.spawn_status_field")].as_str() != Some(defaults::text("telemetry.spawn_completed_status")) {
        return None;
    }
    let child = field(resp, "telemetry.spawn_agent_fields")?.as_str()?;
    if child.is_empty() || !child.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
        return None;
    }
    let parent = payload[defaults::text("telemetry.spawn_parent_transcript_field")].as_str()?;
    let paths = defaults::raw("agent_tracker.paths");
    let transcript = std::path::Path::new(parent).with_extension("").join(paths.str_field("subagents")).join(format!(
        "{}{child}{}",
        paths.str_field("agent_prefix"),
        paths.str_field("transcript_ext")
    ));
    let mut stop = payload.clone();
    stop[cfg.str_field("agent")] = Value::String(child.to_string());
    stop[defaults::text("telemetry.spawn_transcript_field")] = Value::String(transcript.to_str()?.to_string());
    completion(&stop, now, std::slice::from_ref(launch))
}

/// A background completion joins by the child's identity, not by rebuilding a launch key from a stop payload with no prompt.
/// Read only the explicitly supplied transcript, bounded in size. Incomplete, mixed-model or malformed usage stays unmeasured.
pub fn completion(payload: &Value, now: u64, events: &[Event]) -> Option<Event> {
    use std::io::Read;
    let cfg = defaults::raw("telemetry.spawn_result");
    let key = identity(payload, payload[cfg.str_field("agent")].as_str()?)?;
    let launches: Vec<_> = events
        .iter()
        .filter_map(|e| match &e.extras {
            Extras::Spawn(s) if s.agent_key.as_ref() == Some(&key) => Some((e, s)),
            _ => None,
        })
        .collect();
    let (launch, spawn) = launches.iter().min_by_key(|(e, _)| e.ts_ms).copied()?;
    if launches.iter().any(|(_, s)| s.spawn_key != spawn.spawn_key) {
        return None;
    }
    let path = payload[defaults::text("telemetry.spawn_transcript_field")].as_str()?;
    if !std::path::Path::new(path).is_absolute() {
        return None;
    }
    let mut bytes = Vec::new();
    let max = defaults::num("telemetry.spawn_transcript_max_bytes");
    std::fs::File::open(path).ok()?.take(max + 1).read_to_end(&mut bytes).ok()?;
    if bytes.len() as u64 > max {
        return None;
    }
    let mut messages = std::collections::BTreeMap::new();
    for line in std::str::from_utf8(&bytes).ok()?.lines() {
        let v: Value = serde_json::from_str(line).ok()?;
        let fields = defaults::raw("telemetry.spawn_transcript_fields");
        if v[fields.str_field("type")].as_str() != Some(fields.str_field("assistant")) {
            continue;
        }
        let m = &v[fields.str_field("message")];
        if m.get(cfg.str_field("usage")).is_none() {
            continue;
        }
        let id = m[fields.str_field("id")].as_str()?;
        let model = m[fields.str_field("model")].as_str()?.to_string();
        messages.insert(id.to_string(), (model, usage_of(&m[cfg.str_field("usage")])?));
    }
    let mut total = Usage::default();
    let mut actual = None;
    for (model, u) in messages.values() {
        if actual.as_ref().is_some_and(|m| m != model) {
            return None;
        }
        actual = Some(model.clone());
        total.input = total.input.checked_add(u.input)?;
        total.output = total.output.checked_add(u.output)?;
        total.cache_read = total.cache_read.checked_add(u.cache_read)?;
        total.cache_write = total.cache_write.checked_add(u.cache_write)?;
    }
    let model = actual?;
    if total == Usage::default() || launches.iter().any(|(_, s)| s.actual_model.as_str() == model && s.usage == total) {
        return None;
    }
    Some(Event {
        ts_ms: now.max(launch.ts_ms),
        kind: Kind::Spawn,
        h: launch.h.clone(),
        e: Token::sanitize(defaults::text("telemetry.spawn_stop_event")),
        o: Outcome::Allow,
        ms: 0,
        ib: 0,
        extras: Extras::Spawn(Spawn {
            started_ms: spawn.started_ms,
            agent_key: Some(key),
            spawn_key: spawn.spawn_key.clone(),
            actual_model: Token::sanitize(&model),
            usage: total,
        }),
    })
}
