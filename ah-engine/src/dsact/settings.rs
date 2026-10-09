//! The settings the DevSwarm actions obey, resolved the way Node's `hooks/lib/settings.js` does for these keys: the
//! environment variable, then `~/.anti-hall/settings.json` (`devswarm["autoArchive.mode"]`, else the nested
//! `devswarm.autoArchive.mode`), then the plugin option the host stored, then the default. Numbers below `min` are
//! raised, above `max` lowered; an enum or a boolean that is not one of its words falls through to the next tier.
//! Which keys exist, their bounds and their defaults are all in `devswarm_act.toml`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{read_object, stored_options};
use crate::defaults::{self, V};
use serde_json::Value;

/// The resolved settings of one run.
#[derive(Debug, Clone, PartialEq)]
pub struct ActSettings {
    /// The mode.
    pub mode: String,
    /// The idle min.
    pub idle_min: i64,
    /// The max per sweep.
    pub max_per_sweep: i64,
    /// The ignore pings.
    pub ignore_pings: bool,
    /// The nudge max attempts.
    pub nudge_max_attempts: i64,
    /// The nudge cooldown sec.
    pub nudge_cooldown_sec: i64,
    /// The create timeout ms.
    pub create_timeout_ms: i64,
    /// The viewed grace ms.
    pub viewed_grace_ms: i64,
}

fn lookup(o: &serde_json::Map<String, Value>, section: &str, key: &str) -> Option<Value> {
    let s = o.get(section)?.as_object()?;
    if let Some(v) = s.get(key) {
        return Some(v.clone());
    }
    let mut cur = s.get(key.split('.').next()?)?;
    for part in key.split('.').skip(1) {
        cur = cur.as_object()?.get(part)?;
    }
    Some(cur.clone())
}

fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.trim().to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn coerce(entry: &V, raw: &str) -> Option<Value> {
    let ty = entry.str_field("type");
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if ty == defaults::text("devswarm_act.type_enum") {
        let w = t.to_lowercase();
        let known = entry.get("values").map(V::strings).unwrap_or_default().contains(&w.as_str());
        return known.then_some(Value::String(w));
    }
    if ty == defaults::text("devswarm_act.type_bool") {
        return crate::checks::guardkit::settings::token(t).map(Value::Bool);
    }
    let n: f64 = t.parse().ok().filter(|f: &f64| f.is_finite())?;
    let min = entry.get("min").and_then(V::as_integer).map(|m| m as f64);
    let max = entry.get("max").and_then(V::as_integer).map(|m| m as f64);
    let n = min.map_or(n, |m| n.max(m));
    Some(serde_json::json!(max.map_or(n, |m| n.min(m)).floor() as i64))
}

pub(crate) fn resolve(st: &Settings, entry: &V) -> Value {
    let env = entry.str_field("env");
    if !env.is_empty()
        && let Some(v) = st.env.get(env).and_then(|r| coerce(entry, r))
    {
        return v;
    }
    if let Some(v) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| lookup(&o, entry.str_field("section"), entry.str_field("key")))
        .and_then(|v| text_of(&v))
        .and_then(|t| coerce(entry, &t))
    {
        return v;
    }
    let option = entry.str_field("option");
    if !option.is_empty() {
        let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
        if let Some(v) = st.env.get(&env_key).and_then(|r| coerce(entry, r)) {
            return v;
        }
        if let Some(v) = stored_options(st).and_then(|o| o.get(option).cloned()).and_then(|v| text_of(&v)).and_then(|t| coerce(entry, &t)) {
            return v;
        }
    }
    match entry.get("default") {
        Some(V::Int(n)) => serde_json::json!(n),
        Some(V::Bool(b)) => Value::Bool(*b),
        Some(V::Str(s)) => Value::String((*s).to_string()),
        _ => Value::Null,
    }
}

impl ActSettings {
    /// Resolve every setting for the request environment `st`.
    pub fn read(st: &Settings) -> ActSettings {
        let int = |v: Value| v.as_i64().unwrap_or(0);
        ActSettings {
            mode: resolve(st, defaults::raw("devswarm_act.set_mode")).as_str().unwrap_or_default().to_string(),
            idle_min: int(resolve(st, defaults::raw("devswarm_act.set_idle_min"))),
            max_per_sweep: int(resolve(st, defaults::raw("devswarm_act.set_max_per_sweep"))),
            ignore_pings: resolve(st, defaults::raw("devswarm_act.set_ignore_pings")).as_bool().unwrap_or(true),
            nudge_max_attempts: int(resolve(st, defaults::raw("devswarm_act.set_nudge_max_attempts"))),
            nudge_cooldown_sec: int(resolve(st, defaults::raw("devswarm_act.set_nudge_cooldown_sec"))),
            create_timeout_ms: int(resolve(st, defaults::raw("devswarm_act.set_create_timeout_ms"))),
            viewed_grace_ms: defaults::num("devswarm_act.viewed_grace_ms") as i64,
        }
    }

    /// The settings as the decision script receives them.
    pub fn json(&self) -> Value {
        serde_json::json!({
            "mode": self.mode, "idleMin": self.idle_min, "maxPerSweep": self.max_per_sweep, "ignorePings": self.ignore_pings,
            "nudgeMaxAttempts": self.nudge_max_attempts, "nudgeCooldownSec": self.nudge_cooldown_sec, "viewedGraceMs": self.viewed_grace_ms,
        })
    }
}
