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
fn token(raw: &str) -> Option<bool> {
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
fn coerce_json(v: &Value) -> Option<bool> {
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
