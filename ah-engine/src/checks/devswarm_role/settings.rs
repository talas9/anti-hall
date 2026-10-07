//! The settings the DevSwarm role hooks read, resolved the way `hooks/lib/settings.js` `get` does: environment variable,
//! then `settings.json`, then the plugin option, then the default. The boolean switches go through
//! [`crate::checks::guardkit::settings::get_bool`]; this file adds the two other shapes (an enum and a free string).
//!
//! Mirrors `hooks/lib/settings.js` `get`, `coerceValue` (enum and string), `readEnvOverride` and `readPluginOption`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{read_object, stored_options};
use crate::checks::guardkit::text::{is_js_space, js_string_of, js_trim};
use crate::defaults::{self, V};
use serde_json::Value;

/// `coerceValue` for an enum entry on a raw string: trimmed, lower-cased, and one of the allowed values.
fn enum_of(raw: &str, values: &[&str]) -> Option<String> {
    let t = js_trim(raw);
    if t.is_empty() {
        return None;
    }
    let v = t.to_lowercase();
    values.contains(&v.as_str()).then_some(v)
}

/// `coerceValue` for an enum entry on a JSON value: only a string, number or boolean is ever accepted.
fn enum_json(v: &Value, values: &[&str]) -> Option<String> {
    match v {
        Value::String(_) | Value::Number(_) | Value::Bool(_) => enum_of(&js_string_of(v)?, values),
        _ => None,
    }
}

/// `coerceValue` for a string entry on a JSON value: `String(trimmed)` of a non-empty string, number or boolean.
fn string_json(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => {
            let t = js_trim(s);
            (!t.is_empty()).then(|| t.to_string())
        }
        Value::Number(_) | Value::Bool(_) => js_string_of(v),
        _ => None,
    }
}

/// The value `settings.json` holds for the entry's section and key.
fn file_value(st: &Settings, entry: &V) -> Option<Value> {
    let o = read_object(st, defaults::text("guardkit.settings_file"))?;
    o.get(entry.str_field("section"))?.as_object()?.get(entry.str_field("key")).cloned()
}

/// The enum setting `entry` resolves to (`env`, `option`, `default` and the allowed `values` come from the entry).
///
/// The plugin option follows `readPluginOption`: a value equal to the manifest default (the entry's `default`) counts as
/// unset, and an option variable that is present decides even when its value is no allowed word (the stored options are
/// then not consulted).
pub fn get_enum(st: &Settings, entry: &V) -> String {
    let values = entry.get("values").map(V::strings).unwrap_or_default();
    let default = entry.str_field("default");
    let env_name = entry.str_field("env");
    if !env_name.is_empty()
        && let Some(v) = st.env.get(env_name).and_then(|r| enum_of(r, &values))
    {
        return v;
    }
    if let Some(v) = file_value(st, entry).and_then(|v| enum_json(&v, &values)) {
        return v;
    }
    let option = entry.str_field("option");
    if !option.is_empty() {
        let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
        if let Some(raw) = st.env.get(&env_key) {
            if *raw != default
                && let Some(v) = enum_of(raw, &values)
            {
                return v;
            }
        } else if let Some(v) = stored_options(st).and_then(|o| o.get(option).cloned())
            && js_string_of(&v).is_none_or(|s| s != default)
            && let Some(v) = enum_json(&v, &values)
        {
            return v;
        }
    }
    default.to_string()
}

/// The free-string setting `entry` resolves to (environment variable, then `settings.json`, then the default).
pub fn get_string(st: &Settings, entry: &V) -> String {
    let env_name = entry.str_field("env");
    if !env_name.is_empty()
        && let Some(v) = st.env.get(env_name).map(|r| js_trim(r)).filter(|t| !t.is_empty())
    {
        return v.to_string();
    }
    file_value(st, entry).and_then(|v| string_json(&v)).unwrap_or_else(|| entry.str_field("default").to_string())
}

/// `wakeCron(env)` of `hooks/lib/devswarm-wake.js`: the configured schedule when it is exactly the right number of
/// whitespace-separated fields made only of cron characters (re-joined with single spaces), else the default.
pub fn wake_cron(st: &Settings) -> String {
    let entry = defaults::raw("devswarm_role.sw_wake_cron");
    let default = entry.str_field("default");
    let raw = get_string(st, entry);
    let expr = js_trim(&raw);
    if expr.is_empty() {
        return default.to_string();
    }
    let fields: Vec<&str> = expr.split(is_js_space).filter(|f| !f.is_empty()).collect();
    let charset = defaults::text("devswarm_role.cron_charset");
    if fields.len() as u64 != defaults::num("devswarm_role.cron_fields") || !fields.iter().all(|f| f.chars().all(|c| charset.contains(c))) {
        return default.to_string();
    }
    fields.join(" ")
}
