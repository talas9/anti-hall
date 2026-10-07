//! Switches and the skip file, resolved the way the Node guards do (`hooks/lib/settings.js` `get`,
//! `hooks/skip-guard.js` `isSkipped`).
//!
//! A switch is a table in `defaults/small_guards.toml` (`section`, `key`, `env`, `aliases`, `option`, `default`) and
//! resolves through the same chain as Node: environment variable (then its deprecated aliases), then the
//! `settings.json` file, then the plugin option (`CLAUDE_PLUGIN_OPTION_<NAME>` or the host settings file's
//! `pluginConfigs`; a value equal to the default counts as unset), then the default. Only boolean switches exist so far.
//!
//! Known limit: the environment is the engine process's, not the hook client's, so a variable set only in the agent's
//! shell does not reach a resident engine. Until the dispatcher forwards a hook environment snapshot, the switch files
//! are the reliable route; the git check has the same limit.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::text::{js_string_of, js_trim};
use crate::defaults::{self, V};
use serde_json::Value;

/// `coerceBoolToken` after the trim `coerceValue` does: `None` when the string is empty or not an on/off word.
pub(crate) fn token(raw: &str) -> Option<bool> {
    let t = js_trim(raw).to_lowercase();
    if t.is_empty() {
        return None;
    }
    if defaults::list("guardkit.true_tokens").contains(&t.as_str()) {
        Some(true)
    } else if defaults::list("guardkit.false_tokens").contains(&t.as_str()) {
        Some(false)
    } else {
        None
    }
}

/// `coerceValue` for a boolean entry, on a JSON value from a settings file.
pub(crate) fn coerce_json(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => token(s),
        Value::Number(n) => match n.as_f64() {
            Some(1.0) => Some(true),
            Some(0.0) => Some(false),
            _ => None,
        },
        _ => None,
    }
}

/// Read a JSON object file under the home directory; `None` when absent, unreadable, not JSON or not an object.
pub(crate) fn read_object(st: &Settings, rel: &str) -> Option<serde_json::Map<String, Value>> {
    if st.home.is_empty() {
        return None;
    }
    let txt = std::fs::read_to_string(format!("{}/{rel}", st.home)).ok()?;
    match serde_json::from_str::<Value>(&txt) {
        Ok(Value::Object(o)) => Some(o),
        _ => None,
    }
}

/// `readStoredPluginOptions`: the options the host stored for this plugin, flat and nested forms merged.
pub(crate) fn stored_options(st: &Settings) -> Option<serde_json::Map<String, Value>> {
    let host = read_object(st, defaults::text("guardkit.claude_settings_file"))?;
    let map = host.get("pluginConfigs")?.as_object()?;
    let mut out: Option<serde_json::Map<String, Value>> = None;
    for k in defaults::list("guardkit.plugin_config_keys") {
        let Some(e) = map.get(k).and_then(Value::as_object) else { continue };
        let o = out.get_or_insert_with(serde_json::Map::new);
        if let Some(opts) = e.get("options").and_then(Value::as_object) {
            for (n, v) in opts {
                o.insert(n.clone(), v.clone());
            }
        }
        for (n, v) in e {
            if n != "options" {
                o.insert(n.clone(), v.clone());
            }
        }
    }
    out
}

/// The value one boolean switch resolves to before its default: `None` when no source sets it.
fn resolve(st: &Settings, entry: &V) -> Option<bool> {
    let env_name = entry.str_field("env");
    if !env_name.is_empty() {
        let names = std::iter::once(env_name).chain(entry.get("aliases").map(V::strings).unwrap_or_default());
        for n in names {
            if let Some(b) = st.env.get(n).and_then(|v| token(v)) {
                return Some(b);
            }
        }
    }
    let (section, key) = (entry.str_field("section"), entry.str_field("key"));
    if let Some(v) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|s| s.get(key)).and_then(coerce_json))
    {
        return Some(v);
    }
    let option = entry.str_field("option");
    if option.is_empty() {
        return None;
    }
    let default = entry.get("default").and_then(V::as_bool).unwrap_or(false).to_string();
    let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
    if let Some(raw) = st.env.get(&env_key) {
        return if *raw == default { None } else { token(raw) };
    }
    let stored = stored_options(st)?;
    let v = stored.get(option)?;
    if js_string_of(v).is_some_and(|s| s == default) {
        return None;
    }
    coerce_json(v)
}

/// The effective value of a boolean switch: `entry` is the switch table from the defaults.
///
/// Mirrors `hooks/lib/settings.js` `get` for a boolean setting without a legacy file.
pub fn get_bool(st: &Settings, entry: &V) -> bool {
    resolve(st, entry).unwrap_or_else(|| entry.get("default").and_then(V::as_bool).unwrap_or(false))
}

/// `coerceValue` for an enum entry on a JSON value: the trimmed, lower-cased string when it is one of `values`.
fn coerce_enum(v: &Value, values: &[&str]) -> Option<String> {
    let Value::String(s) = v else { return None };
    let t = js_trim(s);
    if t.is_empty() {
        return None;
    }
    let lower = t.to_lowercase();
    values.contains(&lower.as_str()).then_some(lower)
}

/// The effective value of an enum switch: `entry` is the switch table from the defaults (`values` lists the allowed
/// words, all lower case). Same chain as [`get_bool`]: environment variable, `settings.json`, the plugin option (a
/// value equal to the default counts as unset), the default.
///
/// Mirrors `hooks/lib/settings.js` `get` for an enum setting without a legacy file.
pub fn get_enum(st: &Settings, entry: &V) -> String {
    let values = entry.get("values").map(V::strings).unwrap_or_default();
    let default = entry.str_field("default");
    let env_name = entry.str_field("env");
    if !env_name.is_empty() {
        let names = std::iter::once(env_name).chain(entry.get("aliases").map(V::strings).unwrap_or_default());
        for n in names {
            if let Some(v) = st.env.get(n).and_then(|raw| coerce_enum(&Value::String(raw.clone()), &values)) {
                return v;
            }
        }
    }
    let (section, key) = (entry.str_field("section"), entry.str_field("key"));
    if let Some(v) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|s| s.get(key)).and_then(|raw| coerce_enum(raw, &values)))
    {
        return v;
    }
    let option = entry.str_field("option");
    if !option.is_empty() {
        let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
        if let Some(raw) = st.env.get(&env_key) {
            if *raw != default
                && let Some(v) = coerce_enum(&Value::String(raw.clone()), &values)
            {
                return v;
            }
        } else if let Some(stored) = stored_options(st)
            && let Some(v) = stored.get(option)
            && !js_string_of(v).is_some_and(|s| s == default)
            && let Some(v) = coerce_enum(v, &values)
        {
            return v;
        }
    }
    default.to_string()
}

/// True when an unexpired skip is recorded for `guard` (a broad skip of everything also covers it unless the guard is
/// one that must be named).
///
/// Mirrors `hooks/skip-guard.js` `isSkipped` (any error means not skipped).
pub fn is_skipped(st: &Settings, guard: &str) -> bool {
    let Some(o) = read_object(st, defaults::text("guardkit.skip_file")) else { return false };
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0);
    let live = |k: &str| o.get(k).and_then(Value::as_f64).is_some_and(|t| t > now);
    if live(guard) {
        return true;
    }
    !defaults::list("guardkit.destructive_guards").contains(&guard) && live(defaults::text("guardkit.skip_all_key"))
}

/// `coerceValue` for a number entry on a JSON value or string: `None` when the value does not count (so the next source is
/// asked). Strings are trimmed, an empty one is nothing, anything that is not a finite number is nothing; a value below the
/// entry's `min` is nothing (`rejectBelowMin`), the others are clamped.
fn coerce_number(v: &Value, entry: &V) -> Option<f64> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => {
            let t = js_trim(s);
            if t.is_empty() {
                return None;
            }
            crate::checks::guardkit::text::js_number_of_str(t)
        }
        _ => return None,
    };
    if !n.is_finite() {
        return None;
    }
    let min = entry.get("min").and_then(V::as_integer).map(|m| m as f64);
    if min.is_some_and(|m| n < m) {
        return None;
    }
    Some(entry.get("max").and_then(V::as_integer).map_or(n, |m| n.min(m as f64)))
}

/// The effective value of a number switch: environment variable, then `settings.json`, then the default. The entry's `min`
/// rejects a smaller value (it falls through to the next source, as `rejectBelowMin` does); a number setting here has no
/// plugin option.
///
/// Mirrors `hooks/lib/settings.js` `get` for a number entry with `rejectBelowMin`.
pub fn get_num(st: &Settings, entry: &V) -> f64 {
    let env_name = entry.str_field("env");
    if !env_name.is_empty()
        && let Some(n) = st.env.get(env_name).and_then(|v| coerce_number(&Value::String(v.clone()), entry))
    {
        return n;
    }
    let (section, key) = (entry.str_field("section"), entry.str_field("key"));
    if let Some(n) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|s| s.get(key)).and_then(|v| coerce_number(v, entry)))
    {
        return n;
    }
    entry.get("default").and_then(V::as_integer).map_or(0.0, |d| d as f64)
}

/// `coerceValue` for an enum entry: trimmed, lower-cased, and one of `values`; `None` otherwise (the next source decides).
fn enum_token(raw: &str, values: &[&str]) -> Option<String> {
    let t = js_trim(raw);
    if t.is_empty() {
        return None;
    }
    let l = t.to_lowercase();
    values.contains(&l.as_str()).then_some(l)
}

/// The effective value of an enum switch (`entry` is the switch table from the defaults, with `values` and `default`):
/// environment variable, then `settings.json`, then the default. The enum switches read here have no plugin option.
///
/// Mirrors `hooks/lib/settings.js` `get` for an enum setting without a plugin option or legacy file.
pub fn get_enum(st: &Settings, entry: &V) -> String {
    let values = entry.get("values").map(V::strings).unwrap_or_default();
    let env_name = entry.str_field("env");
    if !env_name.is_empty()
        && let Some(v) = st.env.get(env_name).and_then(|raw| enum_token(raw, &values))
    {
        return v;
    }
    let (section, key) = (entry.str_field("section"), entry.str_field("key"));
    if let Some(v) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|s| s.get(key)).and_then(Value::as_str).and_then(|raw| enum_token(raw, &values)))
    {
        return v;
    }
    entry.str_field("default").to_string()
}
