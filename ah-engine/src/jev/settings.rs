//! Resolving the Jev settings and every integration's mode.
//!
//! Mirrors `hooks/lib/jev-client.js` `loadJevConfig`, `jev-assist.js` `getMode` and the parts of
//! `hooks/lib/settings.js` they use. The precedence for a key is: the environment variable (only the keys that have
//! one), then `~/.anti-hall/settings.json`, then the legacy `~/.anti-hall/jev.json`, then the plugin option Claude
//! Code exports as `CLAUDE_PLUGIN_OPTION_*`, then the shipped default. Legacy outranking the plugin option is the
//! order Node uses until its one-time settings migration is stamped; after the migration the value is already in
//! settings.json, which wins here too, so the two orders agree. The stored-options tier of the plugin option (a file
//! Node reads) is planned with the config lane (D18).
//!
//! Safety keys are home-only: `allowLegacyKeyRead` and `genericKeyVendor` are read from settings.json alone, never
//! from the environment, a project file or a plugin option, so a project cannot widen where a key may be sent.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::error::JevError;
use crate::defaults;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A vendor a Jev call can go to. A key belongs to exactly one vendor and is never sent to the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Vendor {
    /// The Vercel AI Gateway passthrough.
    Vercel,
    /// TypeSafe's own API.
    Typesafe,
}

impl Vendor {
    /// The vendor's name as written in settings and in the decision log.
    pub fn as_str(self) -> &'static str {
        match self {
            Vendor::Vercel => "vercel",
            Vendor::Typesafe => "typesafe",
        }
    }

    /// Parse a settings value (case-insensitive, trimmed).
    pub fn parse(s: &str) -> Option<Vendor> {
        match s.trim().to_ascii_lowercase().as_str() {
            "vercel" => Some(Vendor::Vercel),
            "typesafe" => Some(Vendor::Typesafe),
            _ => None,
        }
    }
}

/// How far Jev may act for one integration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Jev may change the outcome, bounded by the call's trust rule.
    On,
    /// Jev is consulted and logged, but the outcome never changes.
    Shadow,
    /// Jev is not consulted.
    Off,
}

impl Mode {
    /// The mode's name as written in settings and in the decision log.
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::On => "on",
            Mode::Shadow => "shadow",
            Mode::Off => "off",
        }
    }

    /// Parse a settings value (case-insensitive, trimmed).
    pub fn parse(s: &str) -> Option<Mode> {
        match s.trim().to_ascii_lowercase().as_str() {
            "on" => Some(Mode::On),
            "shadow" => Some(Mode::Shadow),
            "off" => Some(Mode::Off),
            _ => None,
        }
    }
}

/// An immutable snapshot of the environment variables Jev reads. A snapshot, not live reads, so a settings
/// reload sees one consistent view and tests never touch the process environment.
#[derive(Debug, Clone, Default)]
pub struct Env(HashMap<String, String>);

impl Env {
    /// The current process environment.
    pub fn process() -> Env {
        Env(std::env::vars().collect())
    }

    /// An environment of exactly these pairs.
    pub fn from_pairs<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> Env {
        Env(pairs.into_iter().map(|(k, v)| (k.into(), v.into())).collect())
    }

    /// A variable's value.
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0.get(name).map(String::as_str)
    }

    /// The snapshot as a map (for the settings layer, which reads a map).
    pub fn to_map(&self) -> HashMap<String, String> {
        self.0.clone()
    }

    /// A stable SHA-256 digest (lowercase hex) of the whole environment, used to tell two sessions' environments apart.
    /// A digest, not the text: the memo that holds it never contains a key value.
    pub fn digest(&self) -> String {
        let mut pairs: Vec<(&String, &String)> = self.0.iter().collect();
        pairs.sort();
        let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
        for (k, v) in pairs {
            // length-prefixed, so no pair of different environments can serialise to the same bytes
            for part in [k, v] {
                ctx.update(&(part.len() as u64).to_le_bytes());
                ctx.update(part.as_bytes());
            }
        }
        ctx.finish().as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }

    /// A variable's value when it is non-empty after trimming.
    pub fn get_nonempty(&self, name: &str) -> Option<String> {
        self.get(name).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    }
}

/// The two settings files, parsed. Kept apart from the environment so one load can serve many sessions' environments.
#[derive(Debug, Clone, Default)]
pub struct Files {
    /// Parsed `settings.json` (an empty object when missing or malformed).
    pub settings: Value,
    /// Parsed legacy `jev.json` (an empty object when missing or malformed).
    pub legacy: Value,
}

impl Files {
    /// Load both files from the anti-hall directory under `home`.
    pub fn load(home: &Path) -> Files {
        let [settings, legacy] = Sources::files(home);
        Files { settings: read_object(&settings), legacy: read_object(&legacy) }
    }
}

/// The three inputs a resolution reads, loaded once and re-loaded on change.
#[derive(Debug, Clone, Default)]
pub struct Sources {
    /// The environment snapshot.
    pub env: Env,
    /// Parsed `settings.json` (an empty object when missing or malformed).
    pub settings: Value,
    /// Parsed legacy `jev.json` (an empty object when missing or malformed).
    pub legacy: Value,
}

/// Read a JSON object file; anything else (missing, unreadable, malformed, not an object) is an empty object, as Node does.
fn read_object(path: &Path) -> Value {
    match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(v) if v.is_object() => v,
        _ => Value::Object(Default::default()),
    }
}

impl Sources {
    /// Load both files from the anti-hall directory under `home`.
    pub fn load(home: &Path, env: Env) -> Sources {
        Sources::with_files(Files::load(home), env)
    }

    /// Sources from already loaded files and an environment.
    pub fn with_files(files: Files, env: Env) -> Sources {
        Sources { env, settings: files.settings, legacy: files.legacy }
    }

    /// The files the resolution depends on, for change detection.
    pub fn files(home: &Path) -> [PathBuf; 2] {
        let dir = home.join(defaults::text("paths.base_dir"));
        [dir.join(defaults::text("jev.settings_file")), dir.join(defaults::text("jev.legacy_file"))]
    }
}

/// `obj[key]`, else for a dotted key the nested path (Node: `lookup`); settings.json and jev.json accept both shapes.
fn lookup<'a>(obj: &'a Value, key: &str) -> Option<&'a Value> {
    let map = obj.as_object()?;
    if let Some(v) = map.get(key) {
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

/// A boolean from a JSON value or a token string; anything else is "not set" so the next tier answers.
fn coerce_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::String(s) => bool_token(s.trim()),
        _ => None,
    }
}

/// A boolean word (`1`, `on`, `true`, `yes` and their opposites).
pub fn bool_token(s: &str) -> Option<bool> {
    let s = s.to_ascii_lowercase();
    if defaults::list("jev.bool_true_tokens").contains(&s.as_str()) {
        Some(true)
    } else if defaults::list("jev.bool_false_tokens").contains(&s.as_str()) {
        Some(false)
    } else {
        None
    }
}

/// A finite number from a JSON number or a numeric string.
fn coerce_num(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

/// A non-empty trimmed string from a JSON string (numbers and booleans read as their text, like Node's `String(trimmed)`).
fn coerce_str(v: &Value) -> Option<String> {
    let s = match v {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => return None,
    };
    (!s.is_empty()).then_some(s)
}

/// `modelRouting` -> `model_routing`: how a camelCase integration id is spelled in env and option names.
fn snake(id: &str) -> String {
    let mut out = String::new();
    for c in id.chars() {
        if c.is_ascii_uppercase() {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

/// The per-integration kill-switch variable, e.g. `ANTIHALL_JEV_MODEL_ROUTING` (Node: `envNameFor`).
pub fn integration_env_name(id: &str) -> String {
    format!("{}{}", defaults::text("env.jev_integration_prefix"), snake(id).to_ascii_uppercase())
}

/// The plugin-option variable of an integration, e.g. `CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_MODEL_ROUTING`.
pub fn integration_option_name(id: &str) -> String {
    format!("{}JEV_INTEGRATION_{}", defaults::text("env.jev_option_prefix"), snake(id).to_ascii_uppercase())
}

/// The default mode of a known integration (the shipped table), `None` for an id it does not list.
pub fn default_mode(id: &str) -> Option<Mode> {
    defaults::raw("jev.integrations").get(id).and_then(|v| v.as_str()).and_then(Mode::parse)
}

/// The ids of every integration in the shipped table, in table order.
pub fn known_integrations() -> Vec<&'static str> {
    defaults::raw("jev.integrations").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default()
}

/// A resolved vendor endpoint override that passed the loopback rule, in its canonical form (see [`super::loopback`]).
fn loopback_or_none(raw: Option<String>, refused: &mut bool) -> Option<String> {
    let val = raw?;
    if super::js_trim(&val).is_empty() {
        return None;
    }
    let canonical = super::loopback::endpoint(&val);
    if canonical.is_none() {
        *refused = true;
    }
    canonical
}

/// The fully resolved Jev settings (Node: `loadJevConfig` plus the pieces `getMode` and `computeCostUsd` read).
#[derive(Debug, Clone)]
pub struct JevSettings {
    /// The master switch (`ANTIHALL_JEV=0` always wins).
    pub enabled: bool,
    /// The primary vendor.
    pub transport: Vendor,
    /// The backup vendor, when one is configured and differs from the primary.
    pub fallback: Option<Vendor>,
    /// The per-call budget in milliseconds, capped at the ceiling.
    pub timeout_ms: u64,
    /// The confidence an answer needs to be trusted.
    pub confidence_threshold: f64,
    /// The threshold the decision layer applies: Node's `jev-assist.js` prefers a valid `confidenceThreshold` in the
    /// legacy jev.json over the settings chain (a quirk kept for parity), else `confidence_threshold`.
    pub assist_threshold: f64,
    /// An explicit key file path (home-expanded), if configured.
    pub key_file: Option<PathBuf>,
    /// Test endpoint override for the primary, loopback only.
    pub endpoint_override: Option<String>,
    /// Per-vendor test endpoint overrides, loopback only.
    pub endpoint_overrides: [Option<String>; 2],
    /// True when an override was refused for a non-loopback host (reported once by the caller).
    pub override_refused: bool,
    /// The one vendor the vendor-less key option and the key file are bound to (home-only setting).
    pub generic_key_vendor: Vendor,
    /// Whether the legacy key env vars and key file may be read (home-only setting).
    pub allow_legacy_key_read: bool,
    /// Rotated decision-log generations to keep.
    pub log_rotated_files: u64,
    /// `jev.budget.mode` is `watch`: warn when the day's spend passes `budget_usd_per_day` (never disables Jev).
    pub budget_watch: bool,
    /// `jev.budget.usdPerDay`: the daily spend that raises the warning, when set and positive.
    pub budget_usd_per_day: Option<f64>,
    /// `jev.audit.snippets`: keep a redacted snippet of a decision that changed (or would change) the outcome.
    pub audit_snippets: bool,
    /// The `prices` table (`{model: {inPerMTok, outPerMTok}}`), if the owner set one.
    pub prices: Value,
    /// USD per million input tokens when no price entry applies.
    pub price_in: f64,
    /// USD per million output tokens when no price entry applies.
    pub price_out: f64,
    /// The cascade's global kill switch (`jev.cascade`, `ANTIHALL_JEV_CASCADE`): false turns it off for every integration.
    pub cascade_enabled: bool,
    /// Whether the cascade shows the model Jev's answer (`jev.cascadeShowJevAnswer`).
    pub cascade_show_jev: bool,
    sources: Sources,
    home: PathBuf,
}

impl JevSettings {
    /// Resolve from loaded sources. Pure: no I/O, never fails (every bad value falls to the next tier).
    pub fn resolve(home: &Path, sources: Sources) -> JevSettings {
        let jev_file = sources.settings.get("jev").cloned().unwrap_or(Value::Null);
        let plugin_opt = |name: &str| sources.env.get_nonempty(&format!("{}{}", defaults::text("env.jev_option_prefix"), name));
        // The value of a `jev.*` key from the file tiers: settings.json, legacy jev.json, then the plugin option.
        let file_value = |key: &str, option: Option<&str>| -> Option<Value> {
            lookup(&jev_file, key).cloned().or_else(|| lookup(&sources.legacy, key).cloned()).or_else(|| option.and_then(plugin_opt).map(Value::String))
        };
        // enabled: the environment (only when it reads as a boolean), then the files and the option; then the hard overrides.
        let env_flag = sources.env.get(defaults::text("env.jev_enabled")).map(str::trim);
        let mut enabled = env_flag.and_then(bool_token).or_else(|| file_value("enabled", Some("JEV_ENABLED")).as_ref().and_then(coerce_bool)).unwrap_or(false);
        match env_flag {
            Some("1") => enabled = true,
            Some("0") => enabled = false,
            _ => {}
        }
        let transport = file_value("transport", Some("JEV_TRANSPORT")).as_ref().and_then(coerce_str).and_then(|s| Vendor::parse(&s)).unwrap_or(Vendor::Vercel);
        let fallback = file_value("fallbackTransport", Some("JEV_FALLBACK_TRANSPORT"))
            .as_ref()
            .and_then(coerce_str)
            .and_then(|s| Vendor::parse(&s))
            .filter(|f| *f != transport);
        let max_ms = defaults::num("jev.max_timeout_ms");
        // A numeric setting is clamped into its range (never rejected), like Node's settings resolver.
        let timeout_ms = match file_value("timeoutMs", None).as_ref().and_then(coerce_num) {
            Some(n) => (n.clamp(1.0, max_ms as f64) as u64).max(1),
            None => defaults::num("jev.timeout_ms"),
        };
        let confidence_threshold = match file_value("confidenceThreshold", None).as_ref().and_then(coerce_num) {
            Some(n) => n.clamp(0.0, 1.0),
            None => defaults::text("jev.confidence_threshold").parse().unwrap_or(0.85),
        };
        let assist_threshold =
            sources.legacy.get("confidenceThreshold").and_then(Value::as_f64).filter(|n| (0.0..=1.0).contains(n)).unwrap_or(confidence_threshold);
        let key_file = file_value("keyFile", None).as_ref().and_then(coerce_str).map(|s| expand_home(&s, home));
        let mut refused = false;
        let endpoint_override = loopback_or_none(sources.env.get(defaults::text("env.jev_test_endpoint")).map(str::to_string), &mut refused);
        let endpoint_overrides = [
            loopback_or_none(sources.env.get(defaults::text("env.jev_test_endpoint_vercel")).map(str::to_string), &mut refused),
            loopback_or_none(sources.env.get(defaults::text("env.jev_test_endpoint_typesafe")).map(str::to_string), &mut refused),
        ];
        // home-only: settings.json only, never the env, a plugin option or the legacy file
        let home_only = |key: &str| lookup(&jev_file, key).cloned();
        let generic_key_vendor = home_only("genericKeyVendor").as_ref().and_then(coerce_str).and_then(|s| Vendor::parse(&s)).unwrap_or(Vendor::Vercel);
        let allow_legacy_key_read = home_only("allowLegacyKeyRead").as_ref().and_then(coerce_bool) == Some(true);
        let log_rotated_files = match file_value("logRotatedFiles", None).as_ref().and_then(coerce_num) {
            Some(n) => (n.clamp(1.0, 100.0).floor()) as u64,
            None => defaults::num("jev.log_rotated_files"),
        };
        let budget_watch = file_value("budget.mode", Some("JEV_BUDGET_MODE")).as_ref().and_then(coerce_str).as_deref() == Some("watch");
        let budget_usd_per_day = file_value("budget.usdPerDay", Some("JEV_BUDGET_USD_PER_DAY")).as_ref().and_then(coerce_num).filter(|n| *n > 0.0);
        let audit_snippets = sources
            .env
            .get(defaults::text("env.jev_audit_snippets"))
            .map(str::trim)
            .and_then(bool_token)
            .or_else(|| file_value("audit.snippets", None).as_ref().and_then(coerce_bool))
            == Some(true);
        let prices = file_value("prices", None).filter(|v| v.as_object().is_some_and(|m| !m.is_empty())).unwrap_or(Value::Null);
        let price =
            |key: &str, dflt: &str| file_value(key, None).as_ref().and_then(coerce_num).filter(|n| *n >= 0.0).unwrap_or_else(|| dflt.parse().unwrap_or(0.0));
        let price_in = price("priceUsdPerMInput", defaults::text("jev.price_usd_per_m_input"));
        let price_out = price("priceUsdPerMOutput", defaults::text("jev.price_usd_per_m_output"));
        let flag = |entry: &'static defaults::V| -> bool {
            let (key, env) = (entry.str_field("key"), entry.str_field("env"));
            sources
                .env
                .get(env)
                .map(str::trim)
                .and_then(bool_token)
                .or_else(|| file_value(key, None).as_ref().and_then(coerce_bool))
                .unwrap_or_else(|| entry.get("default").and_then(defaults::V::as_bool).unwrap_or(false))
        };
        let cascade_enabled = flag(defaults::raw("cascade.enabled_setting"));
        let cascade_show_jev = flag(defaults::raw("cascade.show_setting"));
        JevSettings {
            enabled,
            transport,
            fallback,
            timeout_ms,
            confidence_threshold,
            assist_threshold,
            key_file,
            endpoint_override,
            endpoint_overrides,
            override_refused: refused,
            generic_key_vendor,
            allow_legacy_key_read,
            log_rotated_files,
            budget_watch,
            budget_usd_per_day,
            audit_snippets,
            prices,
            price_in,
            price_out,
            cascade_enabled,
            cascade_show_jev,
            sources,
            home: home.to_path_buf(),
        }
    }

    /// True when any test endpoint override applies. Answers obtained through an override are never cached, and never served
    /// to a session that has none.
    pub fn has_endpoint_override(&self) -> bool {
        self.endpoint_override.is_some() || self.endpoint_overrides.iter().any(Option::is_some)
    }

    /// The home directory these settings were resolved for.
    pub fn home(&self) -> &Path {
        &self.home
    }

    /// The environment snapshot (for key lookup).
    pub fn env(&self) -> &Env {
        &self.sources.env
    }

    /// An integration's mode (Node: `getMode`). With `assume_enabled` the master switch is skipped, which is how a status
    /// report shows the configured modes while Jev is off.
    pub fn mode(&self, id: &str, assume_enabled: bool) -> Mode {
        if !self.enabled && !assume_enabled {
            return Mode::Off;
        }
        let env = &self.sources.env;
        if env.get(&integration_env_name(id)) == Some("0") {
            return Mode::Off;
        }
        let (configured, from_default) = self.configured_mode(id);
        // The pre-integrations-map switch: a bare `triage: false` in jev.json still turns triage off, but only when
        // nothing more specific answered.
        if id == defaults::text("jev.legacy_triage_key") && self.sources.legacy.get("triage") == Some(&Value::Bool(false)) && from_default {
            return Mode::Off;
        }
        if let Some(m) = configured {
            return m;
        }
        if defaults::list("jev.legacy_on_default").contains(&id) { Mode::On } else { Mode::parse(defaults::text("jev.unlisted_mode")).unwrap_or(Mode::Shadow) }
    }

    /// The configured mode of `id` and whether it came from the shipped default (or nothing).
    fn configured_mode(&self, id: &str) -> (Option<Mode>, bool) {
        let parse = |v: &Value| coerce_str(v).and_then(|s| Mode::parse(&s));
        let from_settings = self.sources.settings.get("jevIntegrations").and_then(|s| lookup(s, id)).and_then(parse);
        if let Some(m) = from_settings {
            return (Some(m), false);
        }
        let legacy = self.sources.legacy.get("integrations").and_then(|s| s.get(id)).and_then(parse);
        if let Some(m) = legacy {
            return (Some(m), false);
        }
        let known = default_mode(id);
        if known.is_none() {
            return (None, true); // an id with no schema entry: only the legacy integrations map could name it, handled above
        }
        let option = self.sources.env.get_nonempty(&integration_option_name(id)).and_then(|s| Mode::parse(&s));
        match option {
            Some(m) => (Some(m), false),
            None => (known, true),
        }
    }

    /// Whether the cascade runs for integration `id`: not killed globally, and the integration's switch is on. The switch is, in
    /// order, the per-integration environment variable (a boolean word), the owner's `jevCascade.<id>` setting, the plugin
    /// default in `cascade.modes`, then `cascade.default_mode`.
    pub fn cascade_on(&self, id: &str) -> bool {
        if !self.cascade_enabled {
            return false;
        }
        let on = defaults::text("cascade.on");
        // `jev.<integration>Backend = cascade` is the other way to switch it on for that integration
        if let Some(entry) = defaults::raw("cascade.backend_settings").get(id).and_then(defaults::V::as_str) {
            let e = defaults::raw(entry);
            let chosen = self.sources.env.get(e.str_field("env")).map(|v| v.trim().to_ascii_lowercase()).or_else(|| {
                let jev = self.sources.settings.get(e.str_field("section"))?;
                lookup(jev, e.str_field("key")).and_then(coerce_str).map(|v| v.to_ascii_lowercase())
            });
            if chosen.as_deref() == Some(defaults::text("cascade.backend")) {
                return true;
            }
        }
        let env = format!("{}{}", defaults::text("cascade.env_prefix"), snake(id).to_ascii_uppercase());
        if let Some(b) = self.sources.env.get(&env).map(str::trim).and_then(bool_token) {
            return b;
        }
        let word = |v: &Value| coerce_str(v).map(|s| s.to_ascii_lowercase());
        let from_settings = self.sources.settings.get(defaults::text("cascade.settings_section")).and_then(|s| lookup(s, id)).and_then(word);
        let from_defaults = defaults::raw("cascade.modes").get(id).and_then(defaults::V::as_str).map(str::to_string);
        from_settings.or(from_defaults).unwrap_or_else(|| defaults::text("cascade.default_mode").to_string()) == on
    }

    /// The confidence under which integration `id`'s Jev answer is escalated: the plugin default in `cascade.escalate_below`,
    /// else the integration's own act threshold.
    pub fn cascade_below(&self, id: &str) -> f64 {
        defaults::raw("cascade.escalate_below")
            .get(id)
            .and_then(defaults::V::as_str)
            .and_then(|t| t.trim().parse::<f64>().ok())
            .filter(|n| (0.0..=1.0).contains(n))
            .unwrap_or(self.assist_threshold)
    }

    /// Check that the shipped table only holds modes this module understands (used by tests and `jev status`).
    pub fn validate_table() -> Result<(), JevError> {
        for id in known_integrations() {
            if default_mode(id).is_none() {
                return Err(JevError::Config(defaults::render("msg.jev_bad_default_mode", &[("id", &id)])));
            }
        }
        Ok(())
    }
}

/// `~` and `~/x` expanded against `home`; anything else is returned as given (Node: `expandHome`).
fn expand_home(p: &str, home: &Path) -> PathBuf {
    if p == "~" {
        home.to_path_buf()
    } else if let Some(rest) = p.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(p)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn resolve(env: &[(&str, &str)], settings: Value, legacy: Value) -> JevSettings {
        JevSettings::resolve(Path::new("/h"), Sources { env: Env::from_pairs(env.iter().copied()), settings, legacy })
    }

    #[test]
    fn jev_is_off_by_default_and_every_mode_is_off() {
        let s = resolve(&[], json!({}), json!({}));
        assert!(!s.enabled);
        assert_eq!(s.mode("speculation", false), Mode::Off);
        assert_eq!(s.mode("speculation", true), Mode::On);
        assert_eq!(s.mode("modelRouting", true), Mode::Shadow);
        assert_eq!(s.mode("postHandoverGate", true), Mode::Off);
    }

    #[test]
    fn the_environment_switch_wins_both_ways() {
        let on = resolve(&[("ANTIHALL_JEV", "1")], json!({}), json!({}));
        assert!(on.enabled);
        let off = resolve(&[("ANTIHALL_JEV", "0")], json!({"jev": {"enabled": true}}), json!({"enabled": true}));
        assert!(!off.enabled);
        let file = resolve(&[], json!({"jev": {"enabled": true}}), json!({}));
        assert!(file.enabled);
    }

    #[test]
    fn modes_follow_settings_then_legacy_then_default_and_the_kill_switch_wins() {
        let s = resolve(
            &[("ANTIHALL_JEV", "1")],
            json!({"jevIntegrations": {"modelRouting": "on"}}),
            json!({"integrations": {"claimLedger": "on", "modelRouting": "off"}}),
        );
        assert_eq!(s.mode("modelRouting", false), Mode::On, "settings.json outranks the legacy file");
        assert_eq!(s.mode("claimLedger", false), Mode::On);
        assert_eq!(s.mode("newRequest", false), Mode::Shadow);
        let k = resolve(&[("ANTIHALL_JEV", "1"), ("ANTIHALL_JEV_MODEL_ROUTING", "0")], json!({"jevIntegrations": {"modelRouting": "on"}}), json!({}));
        assert_eq!(k.mode("modelRouting", false), Mode::Off);
    }

    #[test]
    fn unknown_ids_default_to_shadow_and_the_legacy_on_ids_to_on() {
        let s = resolve(&[("ANTIHALL_JEV", "1")], json!({}), json!({}));
        assert_eq!(s.mode("someFutureThing", false), Mode::Shadow);
        let l = resolve(&[("ANTIHALL_JEV", "1")], json!({}), json!({"integrations": {"someFutureThing": "on"}}));
        assert_eq!(l.mode("someFutureThing", false), Mode::On);
    }

    #[test]
    fn a_bare_legacy_triage_false_turns_triage_off_only_when_nothing_else_answered() {
        let off = resolve(&[("ANTIHALL_JEV", "1")], json!({}), json!({"triage": false}));
        assert_eq!(off.mode("triage", false), Mode::Off);
        let kept = resolve(&[("ANTIHALL_JEV", "1")], json!({"jevIntegrations": {"triage": "on"}}), json!({"triage": false}));
        assert_eq!(kept.mode("triage", false), Mode::On);
    }

    #[test]
    fn transport_fallback_timeout_and_threshold_are_bounded() {
        let s =
            resolve(&[], json!({"jev": {"transport": "TypeSafe", "fallbackTransport": "typesafe", "timeoutMs": 99999, "confidenceThreshold": 2}}), json!({}));
        assert_eq!(s.transport, Vendor::Typesafe);
        assert_eq!(s.fallback, None, "a fallback equal to the primary is none");
        assert_eq!(s.timeout_ms, 3000);
        assert!((s.confidence_threshold - 1.0).abs() < 1e-12, "an out-of-range number is clamped, as Node's resolver does");
        let f = resolve(&[], json!({"jev": {"fallbackTransport": "typesafe", "timeoutMs": 900}}), json!({}));
        assert_eq!(f.fallback, Some(Vendor::Typesafe));
        assert_eq!(f.timeout_ms, 900);
    }

    #[test]
    fn endpoint_overrides_are_honoured_only_for_loopback_and_stored_canonically() {
        let s = resolve(
            &[
                ("ANTIHALL_JEV_TEST_ENDPOINT", "https://evil.example/"),
                ("ANTIHALL_JEV_TEST_ENDPOINT_VERCEL", "http://127.0.0.1:1/v"),
                ("ANTIHALL_JEV_TEST_ENDPOINT_TYPESAFE", "http://localhost:2/t"),
            ],
            json!({}),
            json!({}),
        );
        assert_eq!(s.endpoint_override, None);
        assert_eq!(s.endpoint_overrides[0].as_deref(), Some("http://127.0.0.1:1/v"));
        assert_eq!(s.endpoint_overrides[1].as_deref(), Some("http://127.0.0.1:2/t"), "localhost is rewritten, never resolved");
        assert!(s.override_refused);
        assert!(s.has_endpoint_override());
        assert!(!resolve(&[], json!({}), json!({})).has_endpoint_override());
    }

    #[test]
    fn the_env_digest_is_a_hash_that_never_holds_a_key_and_tells_environments_apart() {
        let a = Env::from_pairs([("K", "secret-key-value")]);
        let d = a.digest();
        assert_eq!(d.len(), 64);
        assert!(!d.contains("secret"));
        assert_eq!(d, Env::from_pairs([("K", "secret-key-value")]).digest());
        assert_ne!(d, Env::from_pairs([("K", "secret-key-valuf")]).digest());
        assert_ne!(Env::from_pairs([("ab", "c")]).digest(), Env::from_pairs([("a", "bc")]).digest(), "the pair boundaries are part of the digest");
    }

    #[test]
    fn safety_keys_come_only_from_the_home_settings_file() {
        let s =
            resolve(&[("CLAUDE_PLUGIN_OPTION_JEV_ALLOWLEGACYKEYREAD", "true")], json!({}), json!({"allowLegacyKeyRead": true, "genericKeyVendor": "typesafe"}));
        assert!(!s.allow_legacy_key_read);
        assert_eq!(s.generic_key_vendor, Vendor::Vercel);
        let h = resolve(&[], json!({"jev": {"allowLegacyKeyRead": true, "genericKeyVendor": "typesafe"}}), json!({}));
        assert!(h.allow_legacy_key_read);
        assert_eq!(h.generic_key_vendor, Vendor::Typesafe);
    }

    #[test]
    fn env_and_option_names_follow_the_node_spelling() {
        assert_eq!(integration_env_name("modelRouting"), "ANTIHALL_JEV_MODEL_ROUTING");
        assert_eq!(integration_option_name("devswarmStepMap"), "CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_STEP_MAP");
    }

    #[test]
    fn the_shipped_table_is_valid_and_complete() {
        JevSettings::validate_table().unwrap();
        assert_eq!(known_integrations().len(), 21);
        assert_eq!(default_mode("dispatchTier"), Some(Mode::On));
    }
}
