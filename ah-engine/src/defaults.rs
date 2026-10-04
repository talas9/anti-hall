//! Shipped defaults (D17): every tunable, table, message text, path, env-var name, limit and timeout lives in
//! `defaults/*.toml` and is read through this module.
//!
//! File format: each setting is a table `[section.name]` with `value`, `doc` and optionally `env`, `min`, `max`
//! and `unit` (see the header of `defaults/engine.toml`). Why one table per setting: the docs generator, the
//! coverage tests and the (planned) config reload all enumerate settings, and a uniform shape makes every one of
//! them self-describing.
//!
//! The files are compiled into this binary by `build.rs` as static data, so reading a setting parses nothing and
//! allocates nothing. (Parsing the TOML at every hook-client start was measured: `ah-engine version` took 3.7 to
//! 3.8 ms with the parse and 1.9 to 2.1 ms without. The build fails on a malformed or undocumented entry, so the
//! runtime never meets one.)
use serde_json::{json, Value as Json};

/// A default's value: the TOML types the defaults use, as static data.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum V {
    /// An integer.
    Int(i64),
    /// A boolean.
    Bool(bool),
    /// A string.
    Str(&'static str),
    /// A list.
    List(&'static [V]),
    /// A table, as (key, value) pairs in key order.
    Table(&'static [(&'static str, V)]),
}

impl V {
    /// The string, if this is one.
    pub fn as_str(&self) -> Option<&'static str> {
        match self {
            V::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The integer, if this is one.
    pub fn as_integer(&self) -> Option<i64> {
        match self {
            V::Int(n) => Some(*n),
            _ => None,
        }
    }

    /// The boolean, if this is one.
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            V::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// The items, if this is a list.
    pub fn as_array(&self) -> Option<&'static [V]> {
        match self {
            V::List(a) => Some(a),
            _ => None,
        }
    }

    /// The pairs, if this is a table.
    pub fn as_table(&self) -> Option<&'static [(&'static str, V)]> {
        match self {
            V::Table(t) => Some(t),
            _ => None,
        }
    }

    /// The field `key` of a table.
    pub fn get(&self, key: &str) -> Option<&'static V> {
        self.as_table()?.iter().find(|(k, _)| *k == key).map(|(_, v)| v)
    }

    /// A string field of a table (empty when missing or not a string).
    pub fn str_field(&self, key: &str) -> &'static str {
        self.get(key).and_then(V::as_str).unwrap_or("")
    }

    /// The strings of a list (non-strings skipped).
    pub fn strings(&self) -> Vec<&'static str> {
        self.as_array().map(|a| a.iter().filter_map(V::as_str).collect()).unwrap_or_default()
    }

    /// The value as JSON, for `--json` output.
    pub fn to_json(&self) -> Json {
        match self {
            V::Int(n) => json!(n),
            V::Bool(b) => json!(b),
            V::Str(s) => json!(s),
            V::List(a) => Json::Array(a.iter().map(V::to_json).collect()),
            V::Table(t) => Json::Object(t.iter().map(|(k, v)| (k.to_string(), v.to_json())).collect()),
        }
    }
}

/// One setting as shipped.
#[derive(Debug, Clone, Copy)]
pub struct Entry {
    /// `section.name`.
    pub key: &'static str,
    /// File the entry ships in.
    pub file: &'static str,
    /// The default value.
    pub value: V,
    /// One-sentence description.
    pub doc: &'static str,
    /// Environment variable that overrides a numeric value, if any.
    pub env: Option<&'static str>,
    /// Lower clamp for a numeric value.
    pub min: Option<i64>,
    /// Upper clamp for a numeric value.
    pub max: Option<i64>,
    /// Unit of a numeric value (documentation only).
    pub unit: Option<&'static str>,
}

mod generated {
    #![allow(missing_docs)]
    use super::{Entry, V};
    include!(concat!(env!("OUT_DIR"), "/defaults_gen.rs"));
}

/// The entry for `key`, if shipped.
fn find(key: &str) -> Option<&'static Entry> {
    let i = generated::INDEX.binary_search_by(|(k, _)| (*k).cmp(key)).ok()?;
    Some(&generated::ENTRIES[generated::INDEX[i].1])
}

fn entry(key: &str) -> &'static Entry {
    find(key).unwrap_or_else(|| panic!("defaults key {key:?} is not shipped (a source reference the `defaults` tests should have caught)"))
}

/// True when `key` is shipped (without panicking, unlike the typed getters).
pub fn has(key: &str) -> bool {
    find(key).is_some()
}

/// The raw default value of `key`.
pub fn raw(key: &str) -> &'static V {
    &entry(key).value
}

/// A numeric setting: the default, overridden by its `env` variable when that holds a number, then clamped to
/// its `min`/`max`.
pub fn num(key: &str) -> u64 {
    let e = entry(key);
    let default = e.value.as_integer().unwrap_or_else(|| panic!("defaults key {key:?} is not an integer")).max(0) as u64;
    let mut v = e.env.and_then(|n| std::env::var(n).ok()).and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(default);
    if let Some(min) = e.min {
        v = v.max(min.max(0) as u64);
    }
    if let Some(max) = e.max {
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
    raw(key).as_array().unwrap_or_else(|| panic!("defaults key {key:?} is not a list")).iter().filter_map(V::as_str).collect()
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
    entry(key).env
}

/// The name of the environment variable shipped as `env.<name>`.
pub fn env_name(name: &str) -> &'static str {
    text(&format!("env.{name}"))
}

/// Read the environment variable shipped as `env.<name>`.
pub fn env_var(name: &str) -> Option<String> {
    std::env::var(env_name(name)).ok()
}

/// Every shipped setting, in file order (sorted by key within a file).
pub fn all() -> &'static [Entry] {
    generated::ENTRIES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_setting_has_a_value_and_a_sentence_doc() {
        assert!(all().len() > 100, "defaults are not being enumerated: {}", all().len());
        for e in all() {
            assert!(e.doc.trim().ends_with('.'), "{} doc should be a sentence ending in a period: {:?}", e.key, e.doc);
            assert!(has(e.key));
        }
    }

    #[test]
    fn keys_are_unique_and_the_index_is_sorted() {
        let mut seen = std::collections::HashSet::new();
        for e in all() {
            assert!(seen.insert(e.key), "duplicate setting {}", e.key);
        }
        assert!(generated::INDEX.windows(2).all(|w| w[0].0 < w[1].0));
    }

    #[test]
    fn env_names_are_unique_and_prefixed() {
        let mut seen = std::collections::HashSet::new();
        for e in all() {
            if let Some(n) = e.env {
                assert!(n.starts_with("AH_ENGINE_"), "{} env {n} lacks the AH_ENGINE_ prefix", e.key);
                assert!(seen.insert(n), "env var {n} is used twice");
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

    #[test]
    fn values_convert_to_json() {
        assert_eq!(raw("health.crashy_kinds").to_json()[0], "crash");
        assert_eq!(raw("impact.block").get("counted").and_then(V::as_str), Some("exact"));
    }
}
