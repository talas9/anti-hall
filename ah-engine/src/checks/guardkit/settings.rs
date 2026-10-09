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
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::text::{js_string_of, js_trim};
use crate::checks::lit_re;
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
    // Node reads the file as UTF-8 with replacement characters, so invalid bytes do not make it unreadable there.
    let txt = String::from_utf8_lossy(&std::fs::read(format!("{}/{rel}", st.home)).ok()?).into_owned();
    match serde_json::from_str::<Value>(&txt) {
        Ok(Value::Object(o)) => Some(o),
        _ => None,
    }
}

type FileVerdicts = std::collections::HashMap<String, (std::time::SystemTime, u64, bool)>;

/// D74: a settings file that EXISTS but that `serde_json` cannot parse while JavaScript could (a number outside the f64 range, nesting past serde's limit, a lone surrogate escape) must
/// not be read as missing: the opt-in modes it carries (a block mode, say) would be ignored and the engine would allow what Node
/// blocks. True when any of the files the switch chain reads is such a file; every check then defers to Node (the dispatcher asks
/// before it runs a check). Cached per file by modification time and length, so a request costs one `stat` per file.
pub fn unreadable_settings_file(home: &str) -> bool {
    static SEEN: std::sync::Mutex<Option<FileVerdicts>> = std::sync::Mutex::new(None);
    if home.is_empty() {
        return false;
    }
    for key in ["guardkit.settings_file", "guardkit.claude_settings_file", "guardkit.skip_file", "guardkit.migration_markers_file", "guardkit.jev_legacy_file"]
    {
        let path = format!("{home}/{}", defaults::text(key));
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let (mtime, len) = (meta.modified().unwrap_or(std::time::UNIX_EPOCH), meta.len());
        let mut g = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        let seen = g.get_or_insert_with(Default::default);
        if let Some((m, l, bad)) = seen.get(&path)
            && *m == mtime
            && *l == len
        {
            if *bad {
                return true;
            }
            continue;
        }
        drop(g);
        let bad = std::fs::read(&path).ok().is_some_and(|b| crate::checks::guardkit::jsdiff::js_reads_differently(&b));
        let mut g = SEEN.lock().unwrap_or_else(|e| e.into_inner());
        let seen = g.get_or_insert_with(Default::default);
        if seen.len() > defaults::num("guardkit.settings_seen_max") as usize {
            seen.clear();
        }
        seen.insert(path, (mtime, len, bad));
        if bad {
            return true;
        }
    }
    false
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
/// The type a setting's value is read as (`coerceValue` of `hooks/lib/settings.js`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ty {
    Bool,
    Num,
    Enum,
    Str,
}

/// A coerced setting value.
#[derive(Clone, Debug, PartialEq)]
enum Val {
    B(bool),
    N(f64),
    S(String),
}

/// `Number(s)` for a trimmed, non-empty string, `None` when it is not a finite number.
pub fn js_number(s: &str) -> Option<f64> {
    let t = s.trim_start_matches(['+', '-']);
    let lower = t.to_ascii_lowercase();
    for (p, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(rest) = lower.strip_prefix(p)
            && t.len() == s.len()
        {
            return u64::from_str_radix(rest, radix).ok().map(|n| n as f64);
        }
    }
    let ok = lit_re(defaults::text("guardkit.js_decimal_re")).is_match(s);
    if !ok {
        return None;
    }
    s.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// The bounds of a number entry: a value below `min` is raised to it, or rejected (the next source decides) when the entry says
/// `reject_below_min`; a value above `max` is lowered to it.
fn bounded(n: f64, entry: &V) -> Option<f64> {
    let min = entry.get("min").and_then(V::as_integer).map(|m| m as f64);
    let max = entry.get("max").and_then(V::as_integer).map(|m| m as f64);
    if entry.get("reject_below_min").and_then(V::as_bool).unwrap_or(false) && min.is_some_and(|m| n < m) {
        return None;
    }
    let n = min.map_or(n, |m| n.max(m));
    Some(max.map_or(n, |m| n.min(m)))
}

fn coerce_str(ty: Ty, entry: &V, raw: &str) -> Option<Val> {
    let t = js_trim(raw);
    if t.is_empty() {
        return None;
    }
    match ty {
        Ty::Bool => token(t).map(Val::B),
        Ty::Num => bounded(js_number(t)?, entry).map(Val::N),
        Ty::Enum => {
            let lower = t.to_lowercase();
            entry.get("values").map(V::strings).unwrap_or_default().contains(&lower.as_str()).then_some(Val::S(lower))
        }
        Ty::Str => Some(Val::S(t.to_string())),
    }
}

fn coerce_value(ty: Ty, entry: &V, v: &Value) -> Option<Val> {
    match (ty, v) {
        (_, Value::String(s)) => coerce_str(ty, entry, s),
        (Ty::Bool, Value::Bool(b)) => Some(Val::B(*b)),
        (Ty::Bool, Value::Number(_)) => coerce_json(v).map(Val::B),
        (Ty::Num, Value::Number(n)) => bounded(n.as_f64().filter(|f| f.is_finite())?, entry).map(Val::N),
        (Ty::Enum | Ty::Str, Value::Number(_) | Value::Bool(_)) => js_string_of(v).and_then(|s| coerce_str(ty, entry, &s)),
        _ => None,
    }
}

fn resolve_typed(st: &Settings, entry: &V, ty: Ty) -> Option<Val> {
    let env_name = entry.str_field("env");
    if !env_name.is_empty() {
        let names = std::iter::once(env_name).chain(entry.get("aliases").map(V::strings).unwrap_or_default());
        for n in names {
            if let Some(v) = st.env.get(n).and_then(|raw| coerce_str(ty, entry, raw)) {
                return Some(v);
            }
        }
    }
    let (section, key) = (entry.str_field("section"), entry.str_field("key"));
    if let Some(v) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|s| s.get(key)).and_then(|v| coerce_value(ty, entry, v)))
    {
        return Some(v);
    }
    let option = entry.str_field("option");
    if option.is_empty() {
        return None;
    }
    let default = default_string(entry);
    let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
    if let Some(raw) = st.env.get(&env_key) {
        return if *raw == default { None } else { coerce_str(ty, entry, raw) };
    }
    let stored = stored_options(st)?;
    let v = stored.get(option)?;
    if js_string_of(v).is_some_and(|s| s == default) {
        return None;
    }
    coerce_value(ty, entry, v)
}

/// `String(default)` of a setting entry.
fn default_string(entry: &V) -> String {
    match entry.get("default") {
        Some(d) => {
            d.as_bool().map(|b| b.to_string()).or_else(|| d.as_integer().map(|i| i.to_string())).or_else(|| d.as_str().map(str::to_string)).unwrap_or_default()
        }
        None => false.to_string(),
    }
}

/// The value one boolean switch resolves to before its default: `None` when no source sets it.
fn resolve(st: &Settings, entry: &V) -> Option<bool> {
    match resolve_typed(st, entry, Ty::Bool) {
        Some(Val::B(b)) => Some(b),
        _ => None,
    }
}

/// An enum setting (`settings.get` of a `type: 'enum'` entry): the first tier that holds one of the entry's `values`,
/// else its `default`.
pub fn get_enum(st: &Settings, entry: &V) -> String {
    match resolve_typed(st, entry, Ty::Enum) {
        Some(Val::S(s)) => s,
        _ => entry.str_field("default").to_string(),
    }
}

/// A string setting (`settings.get` of a `type: 'string'` entry): the first tier that holds a non-empty value (a string is
/// trimmed, a number or boolean is written the way `String()` does), else its `default`.
pub fn get_string(st: &Settings, entry: &V) -> String {
    match resolve_typed(st, entry, Ty::Str) {
        Some(Val::S(s)) => s,
        _ => entry.str_field("default").to_string(),
    }
}

/// A numeric setting: the first tier that holds a finite number (raised to the entry's `min`), else its `default`.
pub fn get_number(st: &Settings, entry: &V) -> f64 {
    match resolve_typed(st, entry, Ty::Num) {
        Some(Val::N(n)) => n,
        _ => entry.get("default").and_then(V::as_integer).unwrap_or(0) as f64,
    }
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

// ---- the full Node chain for typed settings (boolean and enum), with the legacy tier ---------------------------------
//
// `get_bool` above covers the plain switches. The settings below also have a legacy file (`jev.json`) or are an
// enumeration, so they need the whole of `hooks/lib/settings.js` `get`: environment, `settings.json`, then the tiers
// below the file (legacy file and plugin option, in the order the one-time migration stamp decides), then the default.

/// `coerceValue(entry, raw)` for a boolean or an enum entry: `None` when `raw` cannot be read as that type, so the
/// next source is tried.
fn coerce_typed(entry: &V, raw: &Value) -> Option<Value> {
    let trimmed = match raw {
        Value::String(s) => js_trim(s).to_string(),
        Value::Number(_) | Value::Bool(_) => js_string_of(raw)?,
        _ => return None,
    };
    if trimmed.is_empty() {
        return None;
    }
    match entry.str_field("type") {
        "boolean" => match raw {
            Value::Bool(b) => Some(Value::Bool(*b)),
            _ => token(&trimmed).map(Value::Bool),
        },
        "enum" => {
            let v = trimmed.to_lowercase();
            entry.get("values").map(V::strings).unwrap_or_default().contains(&v.as_str()).then_some(Value::String(v))
        }
        _ => None,
    }
}

/// What a typed lookup could not decide on its own.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Undecidable;

/// True when the plugin version's `migrateSettingsFromLegacy` stamp is in the marker file (`settingsMigrationStamped`):
/// false on any read problem, as in Node. `Err` when the plugin root is unknown, which only the caller can supply.
fn migration_stamped(st: &Settings, plugin_root: &str) -> Result<bool, Undecidable> {
    if plugin_root.is_empty() {
        return Err(Undecidable);
    }
    let version = std::fs::read_to_string(format!("{plugin_root}/{}", defaults::text("guardkit.plugin_manifest")))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("version").and_then(Value::as_str).map(str::to_string));
    let Some(version) = version.filter(|v| !v.is_empty()) else { return Ok(false) };
    let Some(markers) = read_object(st, defaults::text("guardkit.migration_markers_file")) else { return Ok(false) };
    let done = markers
        .get(defaults::text("guardkit.settings_migration_key"))
        .and_then(Value::as_object)
        .and_then(|m| m.get("completedVersion"))
        .and_then(Value::as_str);
    Ok(done == Some(version.as_str()))
}

/// `readPluginOption`: the plugin option's value unless it equals the entry default (which the host exports even when
/// the person never touched it, so it must not mask a lower tier).
fn plugin_option_typed(st: &Settings, entry: &V) -> Option<Value> {
    let option = entry.str_field("option");
    if option.is_empty() {
        return None;
    }
    let default = entry.get("default").map(|d| match d {
        V::Bool(b) => b.to_string(),
        other => other.as_str().unwrap_or_default().to_string(),
    })?;
    let env_key = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
    if let Some(raw) = st.env.get(&env_key) {
        return if *raw == default { None } else { coerce_typed(entry, &Value::String(raw.clone())) };
    }
    let stored = stored_options(st)?;
    let v = stored.get(option)?;
    if js_string_of(v).is_some_and(|s| s == default) {
        return None;
    }
    coerce_typed(entry, v)
}

/// `readLegacy`: the value of `legacy_file[legacy_key]` under the anti-hall directory.
fn legacy_typed(st: &Settings, entry: &V) -> Option<Value> {
    let file = entry.str_field("legacy_file");
    if file.is_empty() {
        return None;
    }
    let o = read_object(st, &format!("{}/{file}", defaults::text("guardkit.settings_dir")))?;
    coerce_typed(entry, o.get(entry.str_field("legacy_key"))?)
}

/// The effective value of a boolean or enum setting, as `hooks/lib/settings.js` `get(section, key, dflt)` answers it.
/// `dflt` wins over the entry's own default (but nothing above it in the chain). `Ok(None)` is JavaScript's `undefined`.
/// `Err` when the answer depends on the plugin root and the caller has none.
pub fn get_setting(st: &Settings, entry: &V, dflt: Option<Value>, plugin_root: &str) -> Result<Option<Value>, Undecidable> {
    let env_name = entry.str_field("env");
    if !env_name.is_empty() {
        let names = std::iter::once(env_name).chain(entry.get("aliases").map(V::strings).unwrap_or_default());
        for n in names {
            if let Some(v) = st.env.get(n).and_then(|raw| coerce_typed(entry, &Value::String(raw.clone()))) {
                return Ok(Some(v));
            }
        }
    }
    let (section, key) = (entry.str_field("section"), entry.str_field("key"));
    if let Some(v) = read_object(st, defaults::text("guardkit.settings_file"))
        .and_then(|o| o.get(section).and_then(Value::as_object).and_then(|s| s.get(key)).and_then(|raw| coerce_typed(entry, raw)))
    {
        return Ok(Some(v));
    }
    let has_legacy = !entry.str_field("legacy_file").is_empty();
    let legacy_first = has_legacy && !migration_stamped(st, plugin_root)?;
    if legacy_first && let Some(v) = legacy_typed(st, entry) {
        return Ok(Some(v));
    }
    if let Some(v) = plugin_option_typed(st, entry) {
        return Ok(Some(v));
    }
    if !legacy_first && let Some(v) = legacy_typed(st, entry) {
        return Ok(Some(v));
    }
    Ok(dflt.or_else(|| entry.get("default").map(V::to_json)))
}

/// `settings.enabled(section, key)`: false only when the setting resolves to exactly `false` or to `"off"`.
pub fn enabled(st: &Settings, entry: &V, plugin_root: &str) -> Result<bool, Undecidable> {
    let v = get_setting(st, entry, None, plugin_root)?;
    Ok(!matches!(v, Some(Value::Bool(false))) && v.as_ref().and_then(Value::as_str) != Some("off"))
}

/// The plugin root a check was given: the rule's `plugin_root` option, else the engine's environment variable for it,
/// else empty (unknown).
pub fn plugin_root(opts: &Value, env: &crate::reqenv::RequestEnv) -> String {
    opts.get("plugin_root")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| env.get(defaults::env_name("plugin_root")).map(str::to_string))
        .unwrap_or_default()
}
