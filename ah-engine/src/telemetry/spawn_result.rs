//! The spawn-result event: what an agent launch actually ran on and used, recorded by the engine at the end of the launch call
//! (`telemetry.spawn_result`). It is linked to the model-routing decision of that launch by the spawn key, which is rebuilt here
//! from the same payload fields the routing check hashes, so routing savings can be computed.
//!
//! A launch that has not finished (a background agent) has no usage in its response and records nothing.

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
    let identity = [bounded(&text(&payload[f("session")])), bounded(&text(&payload[f("agent")])), bounded(input[f("subagent_type")].as_str().unwrap_or_default().trim()), format!("{:016x}", crate::health::fnv(&prefix))]
        .join(f("sep"));
    format!("{}{:016x}", f("key_prefix"), crate::health::fnv(&identity))
}

/// The spawn-result event of a finished launch, or `None` when this payload is not one (another event or tool, or a launch whose
/// response carries no usage yet).
pub fn event_of(event: &str, payload: &Value, now_ms: u64) -> Option<Event> {
    let cfg = defaults::raw("telemetry.spawn_result");
    let f = |k: &str| cfg.str_field(k);
    if event != f("event") || payload["tool_name"].as_str() != Some(f("tool")) {
        return None;
    }
    let resp = &payload[f("response")];
    let (usage, model) = (&resp[f("usage")], resp[f("model")].as_str().filter(|m| !m.is_empty())?);
    if !usage.is_object() {
        return None;
    }
    let n = |k: &str| usage[f(k)].as_u64().unwrap_or(0);
    Some(Event {
        ts_ms: now_ms,
        kind: Kind::Spawn,
        h: Token::sanitize(f("check")),
        e: Token::sanitize(event),
        o: Outcome::Allow,
        ms: 0,
        ib: 0,
        extras: Extras::Spawn(Spawn {
            spawn_key: Token::sanitize(&spawn_key(payload)),
            actual_model: Token::sanitize(model),
            usage: Usage { input: n("in"), output: n("out"), cache_read: n("cache_read"), cache_write: n("cache_write") },
        }),
    })
}
