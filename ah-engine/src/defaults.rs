//! Shipped defaults (D17): every tunable, table, message text, path, env-var name, limit and timeout lives in
//! `defaults/*.toml`, embedded here with `include_str!`, and is read through this module.
//!
//! File format: each setting is a table `[section.name]` with `value`, `doc` and optionally `env`, `min`, `max`
//! and `unit` (see the header of `defaults/engine.toml`). Why one table per setting: the docs generator, the
//! coverage tests and the (planned) config reload all enumerate settings, and a uniform shape makes every one of
//! them self-describing.
//!
//! Which file holds a key is decided by its section: `git.*` is in `git.toml`, `msg.*` in `messages.toml`,
//! `cmd.*` in `commands.toml`, `telemetry.*`, `metric.*` and `impact.*` in `telemetry.toml`, everything else in
//! `engine.toml`. Each file is parsed on first use only, so a client that never needs the
//! messages never parses them.
use std::sync::OnceLock;
use toml::{Table, Value};

/// Process, path, limit and health defaults.
pub const ENGINE_TOML: &str = include_str!("../defaults/engine.toml");
/// Message texts.
pub const MESSAGES_TOML: &str = include_str!("../defaults/messages.toml");
/// Tables and messages of the built-in git check.
pub const GIT_TOML: &str = include_str!("../defaults/git.toml");
/// Command registry data.
pub const COMMANDS_TOML: &str = include_str!("../defaults/commands.toml");
/// Metric and impact-event registries.
pub const TELEMETRY_TOML: &str = include_str!("../defaults/telemetry.toml");

/// One shipped file: its name, its embedded text and its lazily parsed table.
struct File {
    name: &'static str,
    text: &'static str,
    parsed: OnceLock<Table>,
}

static FILES: [File; 5] = [
    File { name: "engine.toml", text: ENGINE_TOML, parsed: OnceLock::new() },
    File { name: "messages.toml", text: MESSAGES_TOML, parsed: OnceLock::new() },
    File { name: "git.toml", text: GIT_TOML, parsed: OnceLock::new() },
    File { name: "commands.toml", text: COMMANDS_TOML, parsed: OnceLock::new() },
    File { name: "telemetry.toml", text: TELEMETRY_TOML, parsed: OnceLock::new() },
];

impl File {
    fn table(&self) -> &Table {
        self.parsed.get_or_init(|| {
            // The shipped files are checked by the `defaults` tests, so a parse failure is a build-time bug.
            self.text.parse::<Table>().unwrap_or_else(|e| panic!("shipped {} does not parse: {e}", self.name))
        })
    }
}

/// The file that holds `section`.
fn file_for(section: &str) -> &'static File {
    match section {
        "git" => &FILES[2],
        "msg" => &FILES[1],
        "cmd" => &FILES[3],
        "telemetry" | "metric" | "impact" => &FILES[4],
        _ => &FILES[0],
    }
}

/// One setting as shipped.
#[derive(Debug, Clone)]
pub struct Entry {
    /// `section.name`.
    pub key: String,
    /// File the entry ships in.
    pub file: &'static str,
    /// The default value.
    pub value: Value,
    /// One-sentence description.
    pub doc: String,
    /// Environment variable that overrides a numeric value, if any.
    pub env: Option<String>,
    /// Lower clamp for a numeric value.
    pub min: Option<i64>,
    /// Upper clamp for a numeric value.
    pub max: Option<i64>,
    /// Unit of a numeric value (documentation only).
    pub unit: Option<String>,
}

fn entry_table(key: &str) -> &'static Table {
    let (section, name) = key.split_once('.').unwrap_or((key, ""));
    file_for(section)
        .table()
        .get(section)
        .and_then(Value::as_table)
        .and_then(|s| s.get(name))
        .and_then(Value::as_table)
        .unwrap_or_else(|| panic!("defaults key {key:?} is not shipped (a source reference the `defaults` tests should have caught)"))
}

/// True when `key` is shipped (without panicking, unlike the typed getters).
pub fn has(key: &str) -> bool {
    let (section, name) = key.split_once('.').unwrap_or((key, ""));
    file_for(section)
        .table()
        .get(section)
        .and_then(Value::as_table)
        .and_then(|s| s.get(name))
        .and_then(Value::as_table)
        .is_some_and(|t| t.contains_key("value"))
}

/// The raw default value of `key`.
pub fn raw(key: &str) -> &'static Value {
    entry_table(key).get("value").unwrap_or_else(|| panic!("defaults key {key:?} has no value"))
}

/// A numeric setting: the default, overridden by its `env` variable when that holds a number, then clamped to
/// its `min`/`max`.
pub fn num(key: &str) -> u64 {
    let t = entry_table(key);
    let default = t.get("value").and_then(Value::as_integer).unwrap_or_else(|| panic!("defaults key {key:?} is not an integer")).max(0) as u64;
    let mut v = t.get("env").and_then(Value::as_str).and_then(|n| std::env::var(n).ok()).and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(default);
    if let Some(min) = t.get("min").and_then(Value::as_integer) {
        v = v.max(min.max(0) as u64);
    }
    if let Some(max) = t.get("max").and_then(Value::as_integer) {
        v = v.min(max.max(0) as u64);
    }
    v
}

/// A numeric setting expressed in milliseconds, as a `Duration`.
pub fn millis(key: &str) -> std::time::Duration {
    std::time::Duration::from_millis(num(key))
}

/// A numeric setting expressed in seconds, as a `Duration`.
pub fn secs(key: &str) -> std::time::Duration {
    std::time::Duration::from_secs(num(key))
}

/// A string setting.
pub fn text(key: &str) -> &'static str {
    raw(key).as_str().unwrap_or_else(|| panic!("defaults key {key:?} is not a string"))
}

/// A list-of-strings setting.
pub fn list(key: &str) -> Vec<&'static str> {
    raw(key).as_array().unwrap_or_else(|| panic!("defaults key {key:?} is not a list")).iter().filter_map(Value::as_str).collect()
}

/// A string setting split on whitespace (compact option-name sets).
pub fn words(key: &str) -> Vec<&'static str> {
    text(key).split_whitespace().collect()
}

/// A message with `{name}` placeholders replaced by `args`. Unknown placeholders are left as written.
pub fn render(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    fill(text(key), args)
}

/// Replace `{name}` in `template` with the matching value of `args`.
pub fn fill(template: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut out = template.to_string();
    for (name, value) in args {
        out = out.replace(&format!("{{{name}}}"), &value.to_string());
    }
    out
}

/// The environment variable that overrides the numeric setting `key`, if it has one.
pub fn env_of(key: &str) -> Option<&'static str> {
    entry_table(key).get("env").and_then(Value::as_str)
}

/// The name of the environment variable shipped as `env.<name>`.
pub fn env_name(name: &str) -> &'static str {
    text(&format!("env.{name}"))
}

/// Read the environment variable shipped as `env.<name>`.
pub fn env_var(name: &str) -> Option<String> {
    std::env::var(env_name(name)).ok()
}

/// Every shipped setting, in file order. Used by the docs generator and the tests; parses all files.
pub fn all() -> Vec<Entry> {
    let mut out = Vec::new();
    for f in &FILES {
        for (section, body) in f.table() {
            let Some(body) = body.as_table() else { continue };
            for (name, e) in body {
                let Some(e) = e.as_table() else { continue };
                out.push(Entry {
                    key: format!("{section}.{name}"),
                    file: f.name,
                    value: e.get("value").cloned().unwrap_or(Value::String(String::new())),
                    doc: e.get("doc").and_then(Value::as_str).unwrap_or("").to_string(),
                    env: e.get("env").and_then(Value::as_str).map(str::to_string),
                    min: e.get("min").and_then(Value::as_integer),
                    max: e.get("max").and_then(Value::as_integer),
                    unit: e.get("unit").and_then(Value::as_str).map(str::to_string),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_shipped_file_parses_and_every_setting_has_a_value_and_a_doc() {
        let all = all();
        assert!(all.len() > 50, "defaults are not being enumerated: {}", all.len());
        for e in &all {
            assert!(!e.doc.trim().is_empty(), "{} ({}) has no doc", e.key, e.file);
            assert!(e.doc.trim().ends_with('.'), "{} doc should be a sentence ending in a period: {:?}", e.key, e.doc);
            let has_value = file_for(e.key.split('.').next().unwrap_or(""))
                .table()
                .get(e.key.split('.').next().unwrap_or(""))
                .and_then(Value::as_table)
                .and_then(|s| s.get(e.key.split('.').nth(1).unwrap_or("")))
                .and_then(Value::as_table)
                .is_some_and(|t| t.contains_key("value"));
            assert!(has_value, "{} has no `value`", e.key);
        }
    }

    #[test]
    fn keys_are_unique_across_files() {
        let mut seen = std::collections::HashSet::new();
        for e in all() {
            assert!(seen.insert(e.key.clone()), "duplicate setting {}", e.key);
        }
    }

    #[test]
    fn env_names_are_unique_and_prefixed() {
        let mut seen = std::collections::HashSet::new();
        for e in all() {
            if let Some(n) = &e.env {
                assert!(n.starts_with("AH_ENGINE_"), "{} env {n} lacks the AH_ENGINE_ prefix", e.key);
                assert!(seen.insert(n.clone()), "env var {n} is used twice");
            }
        }
    }

    #[test]
    fn numeric_clamps_hold_and_env_overrides_apply() {
        assert_eq!(num("daemon.workers"), 4);
        std::env::set_var("AH_ENGINE_QUEUE", "999999");
        assert_eq!(num("daemon.queue"), 1024, "clamped to max");
        std::env::set_var("AH_ENGINE_QUEUE", "junk");
        assert_eq!(num("daemon.queue"), 16, "unparseable falls back to the default");
        std::env::remove_var("AH_ENGINE_QUEUE");
    }

    #[test]
    fn render_fills_placeholders() {
        assert_eq!(fill("a {x} b {y}", &[("x", &"1"), ("y", &"2")]), "a 1 b 2");
        assert_eq!(fill("{missing}", &[("x", &"1")]), "{missing}");
    }
}
