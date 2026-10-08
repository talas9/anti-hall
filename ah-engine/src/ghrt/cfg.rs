//! The resolved GitHub realtime settings: the shipped `github_rt.toml` entries layered with `settings.json` and the engine's
//! own config file, read through the same layers every other engine setting uses.
use crate::cfgstore::{Effective, Paths, load_layers_cold};
use serde_json::Value;
use std::collections::BTreeMap;

/// A snapshot of the settings of one run. `over` lets a test replace a key without touching a file.
pub struct Cfg {
    eff: Effective,
    over: BTreeMap<String, Value>,
    dir: Option<std::path::PathBuf>,
}

impl Cfg {
    /// The settings of this process: shipped defaults, `settings.json`, the engine's config file, the environment.
    pub fn load() -> Cfg {
        let (layers, _) = load_layers_cold(&Paths::from_env());
        Cfg { eff: Effective::resolve_process(&layers), over: BTreeMap::new(), dir: None }
    }

    /// The settings of a daemon's active snapshot.
    pub fn from_effective(eff: &Effective) -> Cfg {
        Cfg { eff: eff.clone(), over: BTreeMap::new(), dir: None }
    }

    /// The shipped defaults only (tests).
    pub fn shipped() -> Cfg {
        Cfg { eff: Effective::defaults(), over: BTreeMap::new(), dir: None }
    }

    /// Keep the files in `dir` instead of the engine state directory (tests, one scratch directory each).
    pub fn in_dir(mut self, dir: &std::path::Path) -> Cfg {
        self.dir = Some(dir.to_path_buf());
        self
    }

    /// The directory the files of GitHub realtime are in.
    pub fn state_dir(&self) -> std::path::PathBuf {
        self.dir.clone().unwrap_or_else(crate::paths::dir)
    }

    /// Replace one setting (a whole value, so a table is given whole).
    pub fn with(mut self, key: &str, v: Value) -> Cfg {
        self.over.insert(key.to_string(), v);
        self
    }

    /// Replace one field of a table setting.
    pub fn with_field(self, key: &str, field: &str, v: Value) -> Cfg {
        let mut t = self.value(key);
        if let Some(m) = t.as_object_mut() {
            m.insert(field.to_string(), v);
        }
        self.with(key, t)
    }

    /// The raw value of a setting (`Null` when unknown).
    pub fn value(&self, key: &str) -> Value {
        self.over.get(key).cloned().or_else(|| self.eff.get(key).map(|r| r.value.clone())).unwrap_or(Value::Null)
    }

    /// A numeric setting (0 when unknown or negative).
    pub fn int(&self, key: &str) -> u64 {
        self.value(key).as_i64().map_or(0, |n| n.max(0) as u64)
    }

    /// A boolean setting.
    pub fn flag(&self, key: &str) -> bool {
        self.value(key).as_bool().unwrap_or(false)
    }

    /// A list-of-strings setting.
    pub fn strs(&self, key: &str) -> Vec<String> {
        self.value(key).as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
    }

    /// One field of a table setting.
    pub fn field(&self, key: &str, field: &str) -> Value {
        self.value(key).get(field).cloned().unwrap_or(Value::Null)
    }

    /// A text field of a table setting.
    pub fn txt(&self, key: &str, field: &str) -> String {
        self.field(key, field).as_str().unwrap_or("").to_string()
    }

    /// A numeric field of a table setting.
    pub fn num_field(&self, key: &str, field: &str) -> u64 {
        self.field(key, field).as_i64().map_or(0, |n| n.max(0) as u64)
    }

    /// A list-of-strings field of a table setting.
    pub fn list_field(&self, key: &str, field: &str) -> Vec<String> {
        self.field(key, field).as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
    }

    /// A word of `github_rt.words`, its `{name}` placeholders filled from `args`.
    pub fn word(&self, name: &str, args: &[(&str, &str)]) -> String {
        let mut s = self.txt("github_rt.words", name);
        for (k, v) in args {
            s = s.replace(&format!("{{{k}}}"), v);
        }
        s
    }
}
