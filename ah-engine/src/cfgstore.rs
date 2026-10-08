//! Config layering, watching and atomic hot-swap (D18, the file part; config-in-DB is planned with the storage phase).
//!
//! # Layers
//!
//! Every shipped setting (`defaults/*.toml`, compiled in by `build.rs`) is resolved from these sources, highest first.
//! The order mirrors `get()` in `plugins/anti-hall/hooks/lib/settings.js` (env, then `settings.json`, then the tiers
//! below the file, then the default), with the engine's own TOML in the slot Node gives to its "below the file" tiers:
//!
//! 1. **env**: the setting's own `env` variable (numeric settings only, as `defaults::num` already did).
//! 2. **`settings.json`**: `<home>/.anti-hall/settings.json`, the file `settings.js` reads. A setting
//!    `section.key` is read as `settings[section]` then `lookup(.., key)`, which accepts the flat form
//!    (`{"daemon": {"idle_exit_s": 5}}`) and the dotted-nested form, exactly like Node's `lookup()`. Values are coerced
//!    like Node's `coerceValue()`: trimmed, empty and wrong-typed values fall through to the next layer, numbers are
//!    CLAMPED to `min`/`max`, booleans accept the token sets in `config.true_tokens`/`config.false_tokens`.
//! 3. **user TOML**: `<state dir>/config.toml`, the engine's own file. Strict: an unknown key, a wrong type or an
//!    out-of-range number makes the file invalid (a hand-written engine file should fail loudly, where Node's shared
//!    store fails open).
//! 4. **shipped default**.
//!
//! Node's "plugin option" and "legacy file" tiers do not exist for engine settings (no engine setting declares a
//! `pluginOption` or `legacy` source), so there is nothing to mirror there.
//!
//! One deliberate difference: Node's `load()` reads a corrupt `settings.json` as `{}` (fail-open for a one-shot hook
//! process). A long-lived daemon that watched the file would then swap to defaults while the user is mid-edit, so here
//! an unreadable or corrupt `settings.json` is an INVALID config and the last good one stays active.
//!
//! # Hot-swap
//!
//! The daemon holds an `Arc<Snapshot>` behind an `RwLock` (the lock is held only to clone or replace the `Arc`, never
//! across I/O or evaluation). A request takes one snapshot when it starts and uses it throughout, so it sees the old
//! config or the new one entirely. A reload parses and validates everything first and swaps only on success; on any
//! error the old snapshot stays and `config_invalid` is logged. Settings listed in `config.restart_only` keep their
//! running value until the next start (the edit is reported as `pending_restart`).
//!
//! Watching is by polling file metadata (mtime, size, inode) every `config.watch_ms`, with a `config.debounce_ms`
//! settle time. Why not `notify`: it needs one dependency tree per OS (FSEvents, kqueue, inotify), has no good story
//! for a file that is deleted and re-created by an atomic-rename editor, and the watched set is two tiny files.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an unset or non-UTF-8 variable is an unset one
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::config::Config;
use crate::defaults::{self, Entry, V};
use crate::{health, paths};
use serde_json::{Map, Value as Json, json};
use std::collections::BTreeMap;
use std::fmt;
use std::ops::Deref;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Instant, SystemTime};

/// Why a config file was rejected.
#[derive(Debug)]
pub enum ConfigError {
    /// The file exists but could not be read.
    Io {
        /// The file.
        path: PathBuf,
        /// The OS error.
        source: std::io::Error,
    },
    /// The text is not valid TOML (user file) or JSON (settings file).
    Parse {
        /// The file.
        path: PathBuf,
        /// The parser's message.
        message: String,
    },
    /// `settings.json` parsed but its top level is not an object.
    NotObject(PathBuf),
    /// The user file names a setting that does not exist.
    UnknownKey {
        /// The file.
        path: PathBuf,
        /// The dotted key.
        key: String,
    },
    /// A value has the wrong type for its setting.
    Type {
        /// The file.
        path: PathBuf,
        /// The dotted key.
        key: String,
        /// What the setting holds.
        expected: &'static str,
        /// What the file gave.
        found: &'static str,
    },
    /// A number is outside the setting's `min`/`max`.
    Range {
        /// The file.
        path: PathBuf,
        /// The dotted key.
        key: String,
        /// The value given.
        value: i64,
        /// Lower bound.
        min: i64,
        /// Upper bound.
        max: i64,
    },
    /// A TOML value of a kind settings cannot hold (a date).
    Unsupported {
        /// The file.
        path: PathBuf,
        /// The dotted key.
        key: String,
    },
    /// An `[events.*]` or `[entries.*]` section (hook configuration, D87) is invalid.
    Hooks {
        /// The file.
        path: PathBuf,
        /// The dotted key.
        key: String,
        /// What is wrong, as shipped message text.
        detail: String,
    },
}

impl ConfigError {
    /// Stable short code for the event log and `status` (never parse `Display`).
    pub fn code(&self) -> &'static str {
        match self {
            ConfigError::Io { .. } => "io",
            ConfigError::Parse { .. } => "parse",
            ConfigError::NotObject(_) => "not_object",
            ConfigError::UnknownKey { .. } => "unknown_key",
            ConfigError::Type { .. } => "type",
            ConfigError::Range { .. } => "range",
            ConfigError::Unsupported { .. } => "unsupported",
            ConfigError::Hooks { .. } => "hooks",
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let r = |k: &str, a: &[(&str, &dyn fmt::Display)]| defaults::render(k, a);
        f.write_str(&match self {
            ConfigError::Io { path, source } => r("msg.cfg_err_io", &[("path", &path.display()), ("err", source)]),
            ConfigError::Parse { path, message } => r("msg.cfg_err_parse", &[("path", &path.display()), ("err", message)]),
            ConfigError::NotObject(path) => r("msg.cfg_err_not_object", &[("path", &path.display())]),
            ConfigError::UnknownKey { path, key } => r("msg.cfg_err_unknown", &[("path", &path.display()), ("key", key)]),
            ConfigError::Type { path, key, expected, found } => {
                r("msg.cfg_err_type", &[("path", &path.display()), ("key", key), ("expected", expected), ("found", found)])
            }
            ConfigError::Range { path, key, value, min, max } => {
                r("msg.cfg_err_range", &[("path", &path.display()), ("key", key), ("value", value), ("min", min), ("max", max)])
            }
            ConfigError::Hooks { path, key, detail } => r("msg.cfg_err_hooks", &[("path", &path.display()), ("key", key), ("detail", detail)]),
            ConfigError::Unsupported { path, key } => {
                r("msg.cfg_err_unsupported", &[("path", &path.display()), ("key", key), ("found", &defaults::text("msg.cfg_type_other"))])
            }
        })
    }
}

impl std::error::Error for ConfigError {}

/// Which layer a resolved value came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// The shipped default.
    Default,
    /// The user TOML in the state directory.
    UserFile,
    /// anti-hall's `settings.json`.
    Settings,
    /// The setting's environment variable.
    Env,
}

impl Source {
    /// The name used in `config --json`.
    pub fn name(self) -> &'static str {
        match self {
            Source::Default => "default",
            Source::UserFile => "config_toml",
            Source::Settings => "settings",
            Source::Env => "env",
        }
    }
}

/// One setting's effective value and where it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Resolved {
    /// The value.
    pub value: Json,
    /// The layer that supplied it.
    pub source: Source,
}

/// The two files the layers read, as found on disk (`settings` is `None` when no home directory is known).
#[derive(Debug, Clone)]
pub struct Paths {
    /// The engine's own user TOML.
    pub user: PathBuf,
    /// anti-hall's `settings.json`.
    pub settings: Option<PathBuf>,
}

impl Paths {
    /// The files for this process: the `AH_ENGINE_CONFIG` / `AH_ENGINE_SETTINGS` overrides, else the state directory
    /// and `<home>/<base_dir>/settings.json`.
    pub fn from_env() -> Paths {
        let user = defaults::env_var("config").map(PathBuf::from).unwrap_or_else(|| paths::dir().join(defaults::text("config.user_file")));
        let settings = defaults::env_var("settings").map(PathBuf::from).or_else(|| {
            let home = defaults::env_var("home").filter(|h| !h.is_empty())?;
            Some(PathBuf::from(home).join(defaults::text("paths.base_dir")).join(defaults::text("config.settings_file")))
        });
        Paths { user, settings }
    }
}

/// The parsed, validated contents of both files (before layering).
#[derive(Debug, Clone, Default)]
pub struct Layers {
    /// `settings.json` as read (`Null` when absent).
    pub settings: Json,
    /// The user TOML flattened to `dotted.key -> value` (already validated).
    pub user: BTreeMap<String, Json>,
    /// The `[events.*]` / `[entries.*]` hook configuration of the user TOML (already validated, D87).
    pub hooks: crate::hookcfg::Layer,
}

/// Every setting resolved through the layers.
#[derive(Debug, Clone)]
pub struct Effective {
    map: BTreeMap<&'static str, Resolved>,
}

fn kind_name(v: &Json) -> &'static str {
    match v {
        Json::Number(n) if n.is_i64() || n.is_u64() => "msg.cfg_type_integer",
        Json::Bool(_) => "msg.cfg_type_boolean",
        Json::String(_) => "msg.cfg_type_string",
        Json::Array(_) => "msg.cfg_type_list",
        Json::Object(_) => "msg.cfg_type_table",
        _ => "msg.cfg_type_other",
    }
}

fn found_of(v: &Json) -> &'static str {
    defaults::text(kind_name(v))
}

fn expected_of(d: &V) -> &'static str {
    defaults::text(match d {
        V::Int(_) => "msg.cfg_type_integer",
        V::Bool(_) => "msg.cfg_type_boolean",
        V::Str(_) => "msg.cfg_type_string",
        V::List(_) => "msg.cfg_type_list",
        V::Table(_) => "msg.cfg_type_table",
    })
}

/// Does `user` have the shape of the default `d`? Tables may name only keys the default has; lists are homogeneous.
fn shape(path: &Path, key: &str, d: &V, user: &Json) -> Result<(), ConfigError> {
    let bad = || ConfigError::Type { path: path.to_path_buf(), key: key.to_string(), expected: expected_of(d), found: found_of(user) };
    match d {
        V::Int(_) => user.as_i64().map(|_| ()).ok_or_else(bad),
        V::Bool(_) => user.as_bool().map(|_| ()).ok_or_else(bad),
        V::Str(_) => user.as_str().map(|_| ()).ok_or_else(bad),
        V::List(items) => {
            for x in user.as_array().ok_or_else(bad)? {
                match items.first() {
                    Some(first) => shape(path, key, first, x)?,
                    None => {
                        if !x.is_string() {
                            return Err(ConfigError::Type {
                                path: path.to_path_buf(),
                                key: key.to_string(),
                                expected: defaults::text("msg.cfg_type_string"),
                                found: found_of(x),
                            });
                        }
                    }
                }
            }
            Ok(())
        }
        V::Table(pairs) => {
            for (k, x) in user.as_object().ok_or_else(bad)? {
                let sub = format!("{key}.{k}");
                match pairs.iter().find(|(n, _)| n == k) {
                    Some((_, dv)) => shape(path, &sub, dv, x)?,
                    None => return Err(ConfigError::UnknownKey { path: path.to_path_buf(), key: sub }),
                }
            }
            Ok(())
        }
    }
}

/// Deep-merge a (partial) user table over the default; any other kind of value replaces the default.
fn merge(default: Json, user: &Json) -> Json {
    match (default, user) {
        (Json::Object(mut d), Json::Object(u)) => {
            for (k, v) in u {
                let base = d.remove(k).unwrap_or(Json::Null);
                d.insert(k.clone(), merge(base, v));
            }
            Json::Object(d)
        }
        (_, u) => u.clone(),
    }
}

fn clamp(e: &Entry, n: i64) -> i64 {
    let mut n = n;
    if let Some(min) = e.min {
        n = n.max(min);
    }
    if let Some(max) = e.max {
        n = n.min(max);
    }
    n
}

/// Node `lookup(obj, key)` (settings.js): the flat key, else the dotted path walked through nested objects.
fn lookup<'a>(obj: &'a Json, key: &str) -> Option<&'a Json> {
    let o = obj.as_object()?;
    if let Some(v) = o.get(key) {
        return Some(v);
    }
    if !key.contains('.') {
        return None;
    }
    let mut cur = obj;
    for part in key.split('.') {
        cur = cur.as_object()?.get(part)?;
    }
    Some(cur)
}

fn token(raw: &str, list_key: &str) -> bool {
    let w = raw.trim().to_lowercase();
    defaults::list(list_key).iter().any(|t| *t == w)
}

/// Node `coerceValue(entry, raw)` (settings.js) for one engine setting: `None` means "fall through to the next layer".
fn coerce(e: &Entry, raw: &Json) -> Option<Json> {
    match &e.value {
        V::List(_) | V::Table(_) => {
            // Node's 'object' type: a real, non-empty object; anything else falls through. Lists: a non-empty array.
            let nonempty = match raw {
                Json::Object(o) => !o.is_empty(),
                Json::Array(a) => !a.is_empty(),
                _ => false,
            };
            (nonempty && shape(Path::new(""), e.key, &e.value, raw).is_ok()).then(|| merge(e.value.to_json(), raw))
        }
        scalar => {
            let text = match raw {
                Json::String(s) => s.trim().to_string(),
                Json::Number(n) => n.to_string(),
                Json::Bool(b) => b.to_string(),
                _ => return None, // null, array, object: rejected outright
            };
            if text.is_empty() {
                return None;
            }
            match scalar {
                V::Int(_) => {
                    if raw.is_boolean() {
                        return None;
                    }
                    let n: f64 = text.parse().ok().filter(|n: &f64| n.is_finite() && n.fract() == 0.0)?;
                    Some(json!(clamp(e, n as i64)))
                }
                V::Bool(_) => {
                    if let Json::Bool(b) = raw {
                        return Some(json!(b));
                    }
                    if token(&text, "config.true_tokens") {
                        Some(json!(true))
                    } else if token(&text, "config.false_tokens") {
                        Some(json!(false))
                    } else {
                        None
                    }
                }
                _ => Some(json!(text)),
            }
        }
    }
}

impl Effective {
    /// Resolve every shipped setting through the layers. `env` looks up an environment variable by name.
    ///
    /// The environment here is the engine process's own, on purpose: only integer engine tunables (`AH_ENGINE_*`) read an
    /// environment variable, and those configure the daemon or the client process itself. A session's `ANTIHALL_*` switches are
    /// not settings of this kind: they travel with each request (`request_env`, D76) and the checks read them from there.
    pub fn resolve(layers: &Layers, env: &dyn Fn(&str) -> Option<String>) -> Effective {
        let mut map = BTreeMap::new();
        for e in defaults::all() {
            let from_env = e
                .env
                .and_then(env)
                .and_then(|s| s.trim().parse::<u64>().ok())
                .filter(|_| matches!(e.value, V::Int(_)))
                .map(|n| json!(clamp(e, n.min(i64::MAX as u64) as i64)));
            let from_settings = || {
                let (section, key) = e.key.split_once('.')?;
                coerce(e, lookup(layers.settings.get(section)?, key)?)
            };
            let r = if let Some(v) = from_env {
                Resolved { value: v, source: Source::Env }
            } else if let Some(v) = from_settings() {
                Resolved { value: v, source: Source::Settings }
            } else if let Some(v) = layers.user.get(e.key) {
                Resolved { value: merge(e.value.to_json(), v), source: Source::UserFile }
            } else {
                Resolved { value: e.value.to_json(), source: Source::Default }
            };
            map.insert(e.key, r);
        }
        Effective { map }
    }

    /// The settings of `layers` resolved with this process's own environment (the dispatcher client, which is the process
    /// the engine tunables configure).
    ///
    /// In the daemon this is the environment it was started with, fixed for its life (review finding 19): a request's own
    /// environment never changes the env layer. That is right because every setting with an `env` override is a tunable of
    /// the process that reads it (the daemon's workers, queue, limits, storage, schedule, telemetry and spool; the client's
    /// deadline, breaker and dispatch mode; a probe timeout), never an input to a decision a check makes for one session;
    /// those read the request's environment (D76). `tests::every_env_override_is_a_process_tunable` keeps it so.
    pub fn resolve_process(layers: &Layers) -> Effective {
        Effective::resolve(layers, &|n| std::env::var(n).ok())
    }

    /// The shipped defaults plus the process environment (no files): what the daemon ran with before config files existed.
    pub fn defaults() -> Effective {
        Effective::resolve(&Layers::default(), &|n| std::env::var(n).ok())
    }

    /// One setting.
    pub fn get(&self, key: &str) -> Option<&Resolved> {
        self.map.get(key)
    }

    /// A numeric setting (negative values read as 0, like `defaults::num`); falls back to the shipped default.
    pub fn num(&self, key: &str) -> u64 {
        self.get(key).and_then(|r| r.value.as_i64()).map(|n| n.max(0) as u64).unwrap_or_else(|| defaults::num(key))
    }

    /// A string setting; falls back to the shipped default.
    pub fn text(&self, key: &str) -> String {
        self.get(key).and_then(|r| r.value.as_str().map(String::from)).unwrap_or_else(|| defaults::text(key).to_string())
    }

    /// A boolean setting; falls back to the shipped default.
    pub fn boolean(&self, key: &str) -> bool {
        self.get(key).and_then(|r| r.value.as_bool()).unwrap_or_else(|| defaults::raw(key).as_bool().unwrap_or(false))
    }

    /// Every setting, sorted by key.
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, &Resolved)> {
        self.map.iter().map(|(k, v)| (*k, v))
    }

    /// `{key: {"value": .., "source": ..}}` for `config --json`.
    pub fn to_json(&self) -> Json {
        let mut o = Map::new();
        for (k, r) in self.iter() {
            o.insert(k.to_string(), json!({"value": r.value, "source": r.source.name()}));
        }
        Json::Object(o)
    }
}

/// True when `key` only takes effect at the next start (`config.restart_only`: exact keys, or prefixes ending in a dot).
pub fn restart_only(key: &str) -> bool {
    defaults::list("config.restart_only").iter().any(|p| if p.ends_with('.') { key.starts_with(p) } else { key == *p })
}

fn read_text(path: &Path) -> Result<Option<String>, ConfigError> {
    match std::fs::read_to_string(path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(ConfigError::Io { path: path.to_path_buf(), source: e }),
    }
}

pub(crate) fn toml_to_json(path: &Path, key: &str, v: &toml::Value) -> Result<Json, ConfigError> {
    let unsupported = || ConfigError::Unsupported { path: path.to_path_buf(), key: key.to_string() };
    Ok(match v {
        toml::Value::String(s) => json!(s),
        toml::Value::Integer(n) => json!(n),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f).map(Json::Number).ok_or_else(unsupported)?,
        toml::Value::Boolean(b) => json!(b),
        toml::Value::Datetime(_) => return Err(unsupported()),
        toml::Value::Array(a) => Json::Array(a.iter().map(|x| toml_to_json(path, key, x)).collect::<Result<_, _>>()?),
        toml::Value::Table(t) => {
            let mut o = Map::new();
            for (k, x) in t {
                o.insert(k.clone(), toml_to_json(path, &format!("{key}.{k}"), x)?);
            }
            Json::Object(o)
        }
    })
}

/// Walk a TOML table: a path that is a shipped setting takes the whole value, any other table is descended into, and
/// anything else is an unknown key.
fn flatten(path: &Path, prefix: &str, t: &toml::Table, out: &mut BTreeMap<String, Json>) -> Result<(), ConfigError> {
    for (k, v) in t {
        let full = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
        if let Some(e) = defaults::all().iter().find(|e| e.key == full) {
            let j = toml_to_json(path, &full, v)?;
            shape(path, &full, &e.value, &j)?;
            if let (V::Int(_), Some(n)) = (&e.value, j.as_i64()) {
                let (min, max) = (e.min.unwrap_or(i64::MIN), e.max.unwrap_or(i64::MAX));
                if n < min || n > max {
                    return Err(ConfigError::Range { path: path.to_path_buf(), key: full, value: n, min, max });
                }
            }
            out.insert(full, j);
        } else if let toml::Value::Table(sub) = v {
            flatten(path, &full, sub, out)?;
        } else {
            return Err(ConfigError::UnknownKey { path: path.to_path_buf(), key: full });
        }
    }
    Ok(())
}

/// Parse and validate a user TOML file's text against the shipped schema: the settings, and the hook configuration
/// sections (`[events.*]`, `[entries.*]`, validated by `hookcfg`).
pub fn parse_user_full(path: &Path, text: &str) -> Result<(BTreeMap<String, Json>, crate::hookcfg::Layer), ConfigError> {
    let mut table: toml::Table = text.parse().map_err(|e: toml::de::Error| ConfigError::Parse { path: path.to_path_buf(), message: e.to_string() })?;
    let mut section = |name: &str| -> Result<Option<Json>, ConfigError> { table.remove(name).map(|v| toml_to_json(path, name, &v)).transpose() };
    let (events, entries) = (section("events")?, section("entries")?);
    let mut out = BTreeMap::new();
    flatten(path, "", &table, &mut out)?;
    let hooks = crate::hookcfg::parse_layer(path, crate::hookcfg::Origin::User, events.as_ref(), entries.as_ref())?;
    Ok((out, hooks))
}

/// Parse and validate a user TOML file's text against the shipped schema (the settings it sets).
pub fn parse_user(path: &Path, text: &str) -> Result<BTreeMap<String, Json>, ConfigError> {
    parse_user_full(path, text).map(|(settings, _)| settings)
}

fn load_user(p: &Paths) -> Result<(BTreeMap<String, Json>, crate::hookcfg::Layer), ConfigError> {
    match read_text(&p.user)? {
        Some(t) => parse_user_full(&p.user, &t),
        None => Ok(Default::default()),
    }
}

fn load_settings(p: &Paths) -> Result<Json, ConfigError> {
    let Some(path) = p.settings.as_deref() else { return Ok(Json::Null) };
    match read_text(path)? {
        Some(t) => match serde_json::from_str::<Json>(&t) {
            Ok(j @ Json::Object(_)) => Ok(j),
            Ok(_) => Err(ConfigError::NotObject(path.to_path_buf())),
            Err(e) => Err(ConfigError::Parse { path: path.to_path_buf(), message: e.to_string() }),
        },
        None => Ok(Json::Null),
    }
}

/// Read both files for a live reload. A missing file is an empty layer; an unreadable or invalid one is an error
/// (the caller keeps the last good config).
pub fn load_layers(p: &Paths) -> Result<Layers, ConfigError> {
    let (user, hooks) = load_user(p)?;
    Ok(Layers { user, settings: load_settings(p)?, hooks })
}

/// Read both files at a cold start, where there is no last good config to keep. Each file stands alone: a corrupt
/// `settings.json` reads as `{}` exactly as Node's `load()` does (so the engine and Node decide alike on the first
/// request), and a rejected `config.toml` reads as empty. Every rejection is returned for logging.
pub fn load_layers_cold(p: &Paths) -> (Layers, Vec<ConfigError>) {
    let mut errs = vec![];
    let (user, hooks) = load_user(p).unwrap_or_else(|e| {
        errs.push(e);
        Default::default()
    });
    let settings = load_settings(p).unwrap_or_else(|e| {
        errs.push(e);
        Json::Null
    });
    (Layers { settings, user, hooks }, errs)
}

/// `config validate <file>`: check a user TOML file; returns how many settings it sets.
pub fn validate_file(path: &Path) -> Result<usize, ConfigError> {
    let text = read_text(path)?.ok_or_else(|| ConfigError::Io { path: path.to_path_buf(), source: std::io::Error::from(std::io::ErrorKind::NotFound) })?;
    let (settings, hooks) = parse_user_full(path, &text)?;
    Ok(settings.len() + hooks.len())
}

/// One immutable, consistent view of the config: the resolved settings and the daemon limits built from them.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// Counts up by one per applied change within this process (1 for the first load).
    pub version: u64,
    /// Every setting with its source.
    pub effective: Effective,
    /// The daemon limits (restart-only fields hold the running value).
    pub config: Config,
    /// The hook configuration of the user file (D87); the dispatcher adds a project file per request.
    pub hooks: crate::hookcfg::HookCfg,
    /// Settings whose on-disk value differs from the running one but only apply at the next start.
    pub pending_restart: Vec<String>,
    /// The last rejected edit, as `code: text`, while the active snapshot is older than the files.
    pub last_error: Option<String>,
    /// The user layers this snapshot was resolved from (kept so a changed default can be re-resolved when the user files are mid-edit).
    pub layers: Layers,
}

impl Deref for Snapshot {
    type Target = Config;
    fn deref(&self) -> &Config {
        &self.config
    }
}

impl Snapshot {
    fn build(version: u64, layers: &Layers, env: &dyn Fn(&str) -> Option<String>, prev: Option<&Snapshot>) -> Snapshot {
        let mut effective = Effective::resolve(layers, env);
        let hooks = layers.hooks.clone();
        let mut pending = Vec::new();
        if let Some(prev) = prev {
            for (k, r) in effective.map.iter_mut() {
                if restart_only(k)
                    && let Some(old) = prev.effective.get(k)
                    && old.value != r.value
                {
                    pending.push(k.to_string());
                    *r = old.clone();
                }
            }
        }
        let config = Config::from_effective(&effective);
        Snapshot {
            version,
            effective,
            config,
            hooks: crate::hookcfg::HookCfg::new(None, hooks),
            pending_restart: pending,
            last_error: None,
            layers: layers.clone(),
        }
    }
}

/// What the watcher compares: the user files and the plugin's defaults files.
#[derive(Debug, Clone, PartialEq)]
struct Fingerprint {
    files: Vec<Option<(SystemTime, u64, u64)>>,
    defaults: defaults::Fingerprint,
}

fn fingerprint(p: &Paths, defaults_root: Option<&Path>) -> Fingerprint {
    let one = |path: &Path| std::fs::metadata(path).ok().and_then(|m| Some((m.modified().ok()?, m.len(), m.ino())));
    let mut v = vec![one(&p.user)];
    v.push(p.settings.as_deref().and_then(one));
    Fingerprint { files: v, defaults: defaults_root.map(defaults::fingerprint).unwrap_or_default() }
}

struct Watch {
    seen: Fingerprint,
    pending: Option<(Fingerprint, Instant)>,
    last_poll: Instant,
}

/// What a reload did.
#[derive(Debug, PartialEq, Eq)]
pub enum Reload {
    /// A new snapshot is active (its version).
    Applied(u64),
    /// The files resolve to what is already active; nothing swapped.
    Unchanged,
    /// The files were rejected; the previous snapshot stays (code of the error).
    Invalid(&'static str),
}

/// The active config, the files it comes from, and the watcher state.
pub struct ConfigStore {
    cur: RwLock<Arc<Snapshot>>,
    paths: Option<Paths>,
    watch: Mutex<Watch>,
    /// A plugin root a request named that differs from the active one (a plugin update): adopted at the next poll when it is newer.
    offered: Mutex<Option<PathBuf>>,
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl ConfigStore {
    /// A store that never reads files: it serves `config` as given (unit tests).
    pub fn fixed(config: Config) -> ConfigStore {
        let snap = Snapshot {
            version: 1,
            effective: Effective::defaults(),
            config,
            hooks: Default::default(),
            pending_restart: vec![],
            last_error: None,
            layers: Layers::default(),
        };
        ConfigStore {
            cur: RwLock::new(Arc::new(snap)),
            paths: None,
            watch: Mutex::new(Watch { seen: Fingerprint { files: vec![], defaults: vec![] }, pending: None, last_poll: Instant::now() }),
            offered: Mutex::new(None),
        }
    }

    /// Load the files for this process. A rejected file is logged (`config_invalid`) and the shipped defaults run
    /// instead, because there is no earlier good config to keep.
    pub fn load() -> ConfigStore {
        ConfigStore::load_from(Paths::from_env())
    }

    /// `load` for explicit paths.
    pub fn load_from(paths: Paths) -> ConfigStore {
        let seen = fingerprint(&paths, defaults::root().as_deref());
        let env = |n: &str| std::env::var(n).ok();
        let (layers, errs) = load_layers_cold(&paths);
        for e in &errs {
            health::log_event("config_invalid", e.code(), &e.to_string());
        }
        let mut snap = Snapshot::build(1, &layers, &env, None);
        snap.last_error = errs.first().map(|e| format!("{}: {e}", e.code()));
        ConfigStore {
            cur: RwLock::new(Arc::new(snap)),
            paths: Some(paths),
            watch: Mutex::new(Watch { seen, pending: None, last_poll: Instant::now() }),
            offered: Mutex::new(None),
        }
    }

    /// The active snapshot. Take it once per request and use it throughout.
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.cur.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// The files this store reads (none for a fixed store).
    pub fn paths(&self) -> Option<&Paths> {
        self.paths.as_ref()
    }

    /// Note the plugin root a request came from. A root that differs from the active one is adopted at a later poll when its defaults
    /// are newer (a plugin update installs new files); an older or equal one is ignored, so two plugin versions in use at once cannot
    /// make the daemon flip between them.
    pub fn offer_root(&self, root: &str) {
        if root.is_empty() || self.paths.is_none() || defaults::root().as_deref() == Some(Path::new(root)) {
            return;
        }
        let mut o = lk(&self.offered);
        if o.as_deref() != Some(Path::new(root)) {
            *o = Some(PathBuf::from(root));
        }
    }

    /// The plugin root the defaults should be read from now: the active one, or an offered one whose index is newer.
    fn target_root(&self) -> Option<PathBuf> {
        let cur = defaults::root();
        let mtime = |r: &Path| std::fs::metadata(crate::bootstrap::index_path(r)).and_then(|m| m.modified()).ok();
        let offered = lk(&self.offered).clone();
        match (offered, &cur) {
            (Some(o), Some(c)) if o != *c && mtime(&o).is_some_and(|new| mtime(c).is_none_or(|old| new > old)) => Some(o),
            (Some(o), None) => Some(o),
            _ => cur,
        }
    }

    /// Re-read the files now and swap if they are valid and different (`ctl reload`, and the watcher once settled). The plugin's
    /// defaults are read and validated first; an invalid set keeps EVERYTHING as it was (one snapshot, never a mixture).
    pub fn reload(&self) -> Reload {
        let Some(paths) = &self.paths else { return Reload::Unchanged };
        let root = self.target_root();
        lk(&self.watch).seen = fingerprint(paths, root.as_deref());
        let prev = self.snapshot();
        let env = |n: &str| std::env::var(n).ok();
        let defaults_applied = match defaults::reload(root.as_deref()) {
            Err(e) => {
                health::log_event("defaults_invalid", e.code, &e.to_string());
                let mut s = (*prev).clone();
                s.last_error = Some(format!("{}: {e}", e.code));
                *self.cur.write().unwrap_or_else(|x| x.into_inner()) = Arc::new(s);
                return Reload::Invalid(e.code);
            }
            Ok(r) => r == defaults::Reloaded::Applied,
        };
        if defaults_applied {
            let root = defaults::root().map(|r| r.display().to_string()).unwrap_or_default();
            health::log_event("defaults_applied", "ok", &root);
            let mut o = lk(&self.offered);
            if o.as_deref().is_some_and(|x| Some(x) == defaults::root().as_deref()) {
                *o = None;
            }
        }
        let (layers, user_err) = match load_layers(paths) {
            Ok(l) => (l, None),
            // the user's files are mid-edit: keep the layers the active snapshot has, but still adopt the new defaults
            Err(e) => (prev.layers.clone(), Some(e)),
        };
        if let Some(e) = &user_err {
            health::log_event("config_invalid", e.code(), &e.to_string());
            if !defaults_applied {
                let mut s = (*prev).clone();
                s.last_error = Some(format!("{}: {e}", e.code()));
                *self.cur.write().unwrap_or_else(|x| x.into_inner()) = Arc::new(s);
                return Reload::Invalid(e.code());
            }
        }
        let mut next = Snapshot::build(prev.version + 1, &layers, &env, Some(&prev));
        next.last_error = user_err.as_ref().map(|e| format!("{}: {e}", e.code()));
        let changed: Vec<&str> = next.effective.iter().filter(|(k, r)| prev.effective.get(k) != Some(*r)).map(|(k, _)| k).collect();
        if !defaults_applied && changed.is_empty() && next.hooks == prev.hooks && next.pending_restart == prev.pending_restart && prev.last_error.is_none() {
            return Reload::Unchanged;
        }
        if !next.pending_restart.is_empty() && next.pending_restart != prev.pending_restart {
            health::log_event("config_pending", "restart", &defaults::render("msg.cfg_log_pending", &[("keys", &next.pending_restart.join(", "))]));
        }
        let v = next.version;
        health::log_event("config_applied", "ok", &defaults::render("msg.cfg_log_applied", &[("version", &v), ("changed", &changed.len())]));
        *self.cur.write().unwrap_or_else(|x| x.into_inner()) = Arc::new(next);
        match user_err {
            Some(e) => Reload::Invalid(e.code()),
            None => Reload::Applied(v),
        }
    }

    /// Called from the daemon's accept loop: every `config.watch_ms`, look at the files; once a change has stayed the
    /// same for `config.debounce_ms`, reload. Returns what a reload did, if one ran.
    pub fn poll(&self) -> Option<Reload> {
        let paths = self.paths.as_ref()?;
        let mut w = lk(&self.watch);
        if w.last_poll.elapsed() < defaults::millis("config.watch_ms") {
            return None;
        }
        w.last_poll = Instant::now();
        let root = self.target_root();
        let now = fingerprint(paths, root.as_deref());
        if now == w.seen {
            w.pending = None;
            return None;
        }
        match &w.pending {
            Some((fp, since)) if *fp == now => {
                if since.elapsed() < defaults::millis("config.debounce_ms") {
                    return None;
                }
            }
            _ => {
                w.pending = Some((now, Instant::now()));
                if !defaults::millis("config.debounce_ms").is_zero() {
                    return None;
                }
            }
        }
        w.pending = None;
        drop(w);
        Some(self.reload())
    }

    /// `config --json`: the active snapshot, with the files it is read from.
    pub fn report(&self) -> Json {
        let s = self.snapshot();
        report_of(&s, self.paths.as_ref())
    }
}

fn file_json(kind: &str, path: &Path) -> Json {
    json!({"kind": kind, "path": path.display().to_string(), "present": path.exists()})
}

fn report_of(s: &Snapshot, paths: Option<&Paths>) -> Json {
    let mut files = vec![];
    if let Some(p) = paths {
        files.push(file_json(Source::UserFile.name(), &p.user));
        if let Some(sp) = &p.settings {
            files.push(file_json(Source::Settings.name(), sp));
        }
    }
    json!({
        "version": s.version,
        "files": files,
        "pending_restart": s.pending_restart,
        "last_error": s.last_error,
        "hooks_hash": s.hooks.hash(),
        "settings": s.effective.to_json(),
    })
}

/// The effective config computed from the files right now (no daemon): what a fresh start would run with.
pub fn report_from_files() -> Json {
    let paths = Paths::from_env();
    let env = |n: &str| std::env::var(n).ok();
    let (layers, errs) = load_layers_cold(&paths);
    let mut s = Snapshot::build(1, &layers, &env, None);
    s.last_error = errs.first().map(|e| format!("{}: {e}", e.code()));
    report_of(&s, Some(&paths))
}

#[cfg(test)]
mod tests {
    /// A setting that reads the process environment is an engine tunable of the process that resolves it; a per-session
    /// switch (`ANTIHALL_*`) would stick to whichever client started the daemon, so none may be an integer setting.
    #[test]
    fn only_engine_tunables_read_the_process_environment() {
        for e in defaults::all() {
            if let (Some(name), V::Int(_)) = (e.env, &e.value) {
                assert!(name.starts_with("AH_ENGINE_"), "{} reads {name} from the daemon's environment", e.key);
            }
        }
    }

    #[test]
    fn every_env_override_is_a_process_tunable() {
        // review finding 19: the daemon resolves the env layer from its own environment, fixed at start; that is only right
        // while no env-overridable setting decides anything for one request. A new `env` key outside these sections fails
        // here until it is reviewed (and, if it is per request, read from the request's environment instead).
        const PROCESS: &[&str] = &[
            "daemon.",
            "client.",
            "storage.",
            "schedule.",
            "telemetry.",
            "spool.",
            "config.",
            "tier.",
            "dispatch.in_process",
            "dispatch.max_timeout_s",
            "session.gitignore_probe_ms",
            "script.", // the interpreter switch and deadline are process-wide, not per request
            "ops.shadow_rate_", // the shadow sampling rates of the operator command-line tools: each run is its own process
        ];
        let odd: Vec<&str> = defaults::all().iter().filter(|e| e.env.is_some() && !PROCESS.iter().any(|p| e.key.starts_with(p))).map(|e| e.key).collect();
        assert!(odd.is_empty(), "env-overridable settings that are not process tunables: {odd:?}");
    }

    use super::*;

    fn no_env(_: &str) -> Option<String> {
        None
    }

    fn layers(settings: Json, toml_text: &str) -> Layers {
        Layers { settings, user: parse_user(Path::new("t.toml"), toml_text).unwrap(), ..Default::default() }
    }

    #[test]
    fn precedence_is_env_then_settings_then_user_file_then_default() {
        let key = "daemon.queue";
        let d = defaults::raw(key).as_integer().unwrap();
        let both = layers(json!({"daemon": {"queue": 11}}), "[daemon]\nqueue = 22\n");
        let r = Effective::resolve(&both, &no_env);
        assert_eq!((r.get(key).unwrap().value.clone(), r.get(key).unwrap().source), (json!(11), Source::Settings));
        let only_toml = layers(Json::Null, "[daemon]\nqueue = 22\n");
        let r = Effective::resolve(&only_toml, &no_env);
        assert_eq!((r.get(key).unwrap().value.clone(), r.get(key).unwrap().source), (json!(22), Source::UserFile));
        let env = |n: &str| (n == defaults::env_of(key).unwrap()).then(|| "33".to_string());
        let r = Effective::resolve(&both, &env);
        assert_eq!((r.get(key).unwrap().value.clone(), r.get(key).unwrap().source), (json!(33), Source::Env));
        let r = Effective::resolve(&Layers::default(), &no_env);
        assert_eq!((r.get(key).unwrap().value.clone(), r.get(key).unwrap().source), (json!(d), Source::Default));
    }

    #[test]
    fn settings_json_is_coerced_like_node_and_bad_values_fall_through() {
        let key = "daemon.queue";
        let (min, max) =
            (defaults::all().iter().find(|e| e.key == key).unwrap().min.unwrap(), defaults::all().iter().find(|e| e.key == key).unwrap().max.unwrap());
        let get = |s: Json| Effective::resolve(&Layers { settings: s, user: BTreeMap::new(), ..Default::default() }, &no_env).get(key).unwrap().clone();
        assert_eq!(get(json!({"daemon": {"queue": " 7 "}})).value, json!(7), "trimmed numeric string");
        assert_eq!(get(json!({"daemon": {"queue": max + 999}})).value, json!(max), "clamped, not rejected");
        assert_eq!(get(json!({"daemon": {"queue": min - 5}})).value, json!(min));
        assert_eq!(get(json!({"daemon": {"queue": "  "}})).source, Source::Default, "blank falls through");
        assert_eq!(get(json!({"daemon": {"queue": true}})).source, Source::Default, "boolean is not a number");
        assert_eq!(get(json!({"daemon": {"queue": [1]}})).source, Source::Default);
        assert_eq!(get(json!({"daemon": {"queue": "junk"}})).source, Source::Default);
        assert_eq!(get(json!({"daemon.queue": 5})).source, Source::Default, "section is a single path segment");
        assert_eq!(get(json!({"daemon": {"nope": 5}})).source, Source::Default);
        assert_eq!(get(json!("not an object")).source, Source::Default);
    }

    #[test]
    fn nested_dotted_lookup_and_boolean_tokens_mirror_node() {
        let v = json!({"a": {"b": {"c": 1}}, "flat.key": 2});
        assert_eq!(lookup(v.get("a").unwrap(), "b.c"), Some(&json!(1)));
        assert_eq!(lookup(&v, "flat.key"), Some(&json!(2)), "flat key wins before the dotted walk");
        assert_eq!(lookup(&v, "a.b.x"), None);
        let bool_key = defaults::all().iter().find(|e| matches!(e.value, V::Bool(_))).map(|e| e.key);
        if let Some(k) = bool_key {
            let (s, n) = k.split_once('.').unwrap();
            for (raw, want) in [("YES", true), (" off ", false), ("0", false), ("1", true)] {
                let r = Effective::resolve(&Layers { settings: json!({ s: { n: raw } }), user: BTreeMap::new(), ..Default::default() }, &no_env);
                assert_eq!(r.get(k).unwrap().value, json!(want), "{raw}");
            }
        }
    }

    #[test]
    fn the_user_file_is_strict() {
        let p = Path::new("t.toml");
        assert_eq!(parse_user(p, "[daemon]\nnope = 1\n").unwrap_err().code(), "unknown_key");
        assert_eq!(parse_user(p, "[daemon]\nqueue = \"x\"\n").unwrap_err().code(), "type");
        assert_eq!(parse_user(p, "[daemon]\nqueue = 99999999\n").unwrap_err().code(), "range");
        assert_eq!(parse_user(p, "daemon = 3\n").unwrap_err().code(), "unknown_key");
        assert_eq!(parse_user(p, "[daemon\n").unwrap_err().code(), "parse");
        assert_eq!(parse_user(p, "[daemon]\nqueue = 1979-05-27\n").unwrap_err().code(), "unsupported");
        assert!(parse_user(p, "").unwrap().is_empty());
        assert!(parse_user(p, "# only a comment\n").unwrap().is_empty());
    }

    #[test]
    fn a_table_setting_takes_a_partial_override_merged_over_the_default() {
        let path = Path::new("t.toml");
        let user = parse_user(path, "[cmd.version]\nargs = \"[x]\"\n").unwrap();
        let r = Effective::resolve(&Layers { settings: Json::Null, user, ..Default::default() }, &no_env);
        let v = &r.get("cmd.version").unwrap().value;
        assert_eq!(v["args"], "[x]");
        assert_eq!(v["status"], "implemented", "the other fields of the default table survive: {v}");
        assert_eq!(parse_user(path, "[cmd.version]\nnope = 1\n").unwrap_err().code(), "unknown_key");
        assert_eq!(parse_user(path, "[cmd.version]\nargs = 3\n").unwrap_err().code(), "type");
    }

    #[test]
    fn every_shipped_setting_resolves_to_its_default_without_overrides() {
        let r = Effective::resolve(&Layers::default(), &no_env);
        for e in defaults::all() {
            let got = r.get(e.key).unwrap_or_else(|| panic!("{} missing", e.key));
            assert_eq!((&got.value, got.source), (&e.value.to_json(), Source::Default), "{}", e.key);
        }
    }

    #[test]
    fn restart_only_matches_exact_keys_and_prefixes() {
        assert!(restart_only("daemon.workers") && restart_only("paths.rules_file") && restart_only("storage.anything"));
        assert!(!restart_only("daemon.queue") && !restart_only("daemon.worker_wait_ms"));
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-cfg-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reload_swaps_valid_edits_keeps_the_old_on_invalid_and_falls_back_when_deleted() {
        let d = tmp("reload");
        let paths = Paths { user: d.join("config.toml"), settings: Some(d.join("settings.json")) };
        let store = ConfigStore::load_from(paths.clone());
        let q = |s: &ConfigStore| s.snapshot().queue;
        let shipped = q(&store);
        std::fs::write(&paths.user, "[daemon]\nqueue = 77\n").unwrap();
        assert_eq!(store.reload(), Reload::Applied(2));
        assert_eq!(q(&store), 77);
        assert_eq!(store.snapshot().effective.get("daemon.queue").unwrap().source, Source::UserFile);
        std::fs::write(&paths.user, "[daemon]\nqueue = \"oops\"\n").unwrap();
        assert_eq!(store.reload(), Reload::Invalid("type"));
        assert_eq!(q(&store), 77, "an invalid edit keeps the last good config");
        assert!(store.snapshot().last_error.as_deref().unwrap().starts_with("type"));
        std::fs::write(paths.settings.clone().unwrap(), "{ not json").unwrap();
        assert_eq!(store.reload(), Reload::Invalid("type"), "the user file is still the first error");
        std::fs::write(&paths.user, "[daemon]\nqueue = 78\n").unwrap();
        assert_eq!(store.reload(), Reload::Invalid("parse"), "a corrupt settings.json is invalid, not read as empty");
        assert_eq!(q(&store), 77);
        std::fs::write(paths.settings.clone().unwrap(), r#"{"daemon":{"queue":79}}"#).unwrap();
        assert_eq!(store.reload(), Reload::Applied(3));
        assert_eq!(q(&store), 79, "settings.json outranks the user file");
        assert!(store.snapshot().last_error.is_none());
        std::fs::remove_file(paths.settings.clone().unwrap()).unwrap();
        std::fs::remove_file(&paths.user).unwrap();
        assert_eq!(store.reload(), Reload::Applied(4));
        assert_eq!(q(&store), shipped, "deleted files fall back to the shipped defaults");
        assert_eq!(store.reload(), Reload::Unchanged);
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn hook_sections_swap_atomically_with_the_settings_and_a_bad_one_keeps_the_last_good_snapshot() {
        let d = tmp("hooks-reload");
        let paths = Paths { user: d.join("config.toml"), settings: None };
        let store = ConfigStore::load_from(paths.clone());
        let cap = |s: &ConfigStore| s.snapshot().hooks.event("PostToolUse").max_rules;
        assert_eq!((cap(&store), store.snapshot().hooks.hash()), (0, ""));
        std::fs::write(&paths.user, "[daemon]\nqueue = 9\n[events.PostToolUse]\nmax_rules = 2\n").unwrap();
        assert_eq!(store.reload(), Reload::Applied(2));
        let s = store.snapshot();
        assert_eq!((s.queue, s.hooks.event("PostToolUse").max_rules), (9, 2), "settings and hook sections swap together");
        let h = s.hooks.hash().to_string();
        assert!(!h.is_empty());
        // a bad hook section rejects the whole file: neither the setting nor the section changes, and the error is reported
        std::fs::write(&paths.user, "[daemon]\nqueue = 11\n[events.PreToolUse]\nmode = \"off\"\n").unwrap();
        assert_eq!(store.reload(), Reload::Invalid("hooks"));
        let s = store.snapshot();
        assert_eq!((s.queue, s.hooks.event("PostToolUse").max_rules, s.hooks.hash()), (9, 2, h.as_str()), "the previous snapshot stays");
        assert!(s.last_error.as_deref().unwrap().starts_with("hooks"), "{:?}", s.last_error);
        // only a hook-section change is still a change
        std::fs::write(&paths.user, "[daemon]\nqueue = 9\n[events.PostToolUse]\nmax_rules = 3\n").unwrap();
        assert_eq!(store.reload(), Reload::Applied(3));
        assert_eq!((cap(&store), store.snapshot().last_error.clone()), (3, None));
        std::fs::remove_file(&paths.user).unwrap();
        assert_eq!(store.reload(), Reload::Applied(4));
        assert_eq!((cap(&store), store.snapshot().hooks.hash()), (0, ""), "a deleted file falls back to the defaults");
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn restart_only_edits_are_held_pending_and_the_running_value_stays() {
        let d = tmp("restart");
        let paths = Paths { user: d.join("config.toml"), settings: None };
        let store = ConfigStore::load_from(paths.clone());
        let running = store.snapshot().workers;
        std::fs::write(&paths.user, format!("[daemon]\nworkers = {}\nqueue = 9\n", running + 1)).unwrap();
        assert!(matches!(store.reload(), Reload::Applied(_)));
        let s = store.snapshot();
        assert_eq!((s.workers, s.queue), (running, 9), "queue is live, workers waits for a restart");
        assert_eq!(s.pending_restart, vec!["daemon.workers".to_string()]);
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn an_invalid_engine_file_at_startup_runs_the_defaults() {
        let d = tmp("start-bad");
        let paths = Paths { user: d.join("config.toml"), settings: None };
        std::fs::write(&paths.user, "[daemon]\nqueue = [").unwrap();
        let store = ConfigStore::load_from(paths);
        let s = store.snapshot();
        assert_eq!(s.queue, Config::from_env().queue);
        assert!(s.last_error.as_deref().unwrap().starts_with("parse"));
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn cold_start_reads_a_corrupt_settings_json_as_empty_like_node() {
        let d = tmp("cold-settings");
        let paths = Paths { user: d.join("config.toml"), settings: Some(d.join("settings.json")) };
        std::fs::write(paths.settings.clone().unwrap(), "{ not json").unwrap();
        std::fs::write(&paths.user, "[daemon]\nqueue = 31\n").unwrap();
        let s = ConfigStore::load_from(paths.clone()).snapshot();
        let node = Effective::resolve(
            &Layers { settings: Json::Null, user: parse_user(&paths.user, "[daemon]\nqueue = 31\n").unwrap(), ..Default::default() },
            &|n| std::env::var(n).ok(),
        );
        for (k, r) in node.iter() {
            assert_eq!(s.effective.get(k), Some(r), "{k}: a corrupt settings.json must read as {{}} at cold start");
        }
        assert_eq!(s.queue, 31, "the valid engine file still applies");
        assert!(s.last_error.as_deref().unwrap().starts_with("parse"), "the problem is still reported");
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn poll_debounces_then_reloads() {
        let d = tmp("poll");
        let paths = Paths { user: d.join("config.toml"), settings: None };
        let store = ConfigStore::load_from(paths.clone());
        std::fs::write(&paths.user, "[daemon]\nqueue = 5\n").unwrap();
        // first sighting only arms the debounce; a reload happens once the same change has stayed for the settle time
        let t = Instant::now();
        let mut got = None;
        while t.elapsed() < std::time::Duration::from_secs(5) && got.is_none() {
            got = store.poll();
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(got, Some(Reload::Applied(2)));
        assert!(t.elapsed() >= defaults::millis("config.debounce_ms"), "debounced");
        assert_eq!(store.snapshot().queue, 5);
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }
}
