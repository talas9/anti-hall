//! Settings: the plugin's TOML defaults (parsed by the `toml` crate), with the built-in copy as the per-key fallback.
//!
//! A defaults file that is missing or does not parse leaves its table empty, so every key it holds comes from `builtin`; a single
//! value of the wrong type does the same for that key. `bad_files` lists the files that were unusable, for the log.

use crate::builtin;
use crate::util::fill;
use std::path::Path;

#[derive(Default)]
pub struct Cfg {
    doc: toml::Table,
}

impl Cfg {
    /// None when the file is missing, unreadable (including non-UTF-8) or not valid TOML.
    pub fn load(path: &Path) -> Option<Cfg> {
        let text = std::fs::read_to_string(path).ok()?;
        Some(Cfg {
            doc: text.parse().ok()?,
        })
    }

    fn entry(&self, key: &str) -> Option<&toml::Table> {
        let mut t = &self.doc;
        for seg in key.split('.') {
            t = t.get(seg)?.as_table()?;
        }
        Some(t)
    }

    fn value(&self, key: &str) -> Option<&toml::Value> {
        self.entry(key)?.get("value")
    }
}

#[derive(Default)]
pub struct Settings {
    engine: Cfg,
    dispatch: Cfg,
    messages: Cfg,
    pub bad_files: Vec<String>,
}

fn nonneg(v: &toml::Value) -> Option<u64> {
    v.as_integer().and_then(|i| u64::try_from(i).ok())
}

impl Settings {
    /// Reads the three files of `dir`. An empty `dir` (no plugin root found) is all built-in.
    pub fn load(dir: &Path) -> Settings {
        let mut bad = Vec::new();
        let mut one = |name: &str| {
            Cfg::load(&dir.join(name)).unwrap_or_else(|| {
                bad.push(name.to_string());
                Cfg::default()
            })
        };
        let engine = one(builtin::CFG_ENGINE_FILE);
        let dispatch = one(builtin::CFG_DISPATCH_FILE);
        let messages = one(builtin::CFG_MESSAGES_FILE);
        Settings {
            engine,
            dispatch,
            messages,
            bad_files: bad,
        }
    }

    fn table(&self, key: &str) -> &Cfg {
        match key.split('.').next() {
            Some("dispatch") => &self.dispatch,
            Some("msg") => &self.messages,
            _ => &self.engine,
        }
    }

    /// The shipped value of `key` only (no built-in fallback): for the parity test and the selftest.
    pub fn shipped(&self, key: &str) -> Option<&toml::Value> {
        self.table(key).value(key)
    }

    /// A number: the environment override (all digits) if the key names one, else the file value, else the built-in; clamped to
    /// the entry's min and max.
    pub fn num(&self, key: &str) -> u64 {
        let t = self.table(key);
        let from_env = t
            .entry(key)
            .and_then(|e| e.get("env"))
            .and_then(|e| e.as_str())
            .and_then(|n| std::env::var(n).ok())
            .and_then(|v| {
                let v: String = v.chars().filter(|c| !c.is_whitespace()).collect();
                (!v.is_empty() && v.chars().all(|c| c.is_ascii_digit()))
                    .then(|| v.parse().ok())
                    .flatten()
            });
        let mut v = from_env
            .or_else(|| t.value(key).and_then(nonneg))
            .or_else(|| builtin::num(key))
            .unwrap_or(0);
        if let Some(min) = t.entry(key).and_then(|e| e.get("min")).and_then(nonneg) {
            v = v.max(min);
        }
        if let Some(max) = t.entry(key).and_then(|e| e.get("max")).and_then(nonneg) {
            v = v.min(max);
        }
        v
    }

    /// One field of a per-field table setting (`{ default = 0, SessionStart = 1100, ... }`): the file's entry for `field`, else the
    /// file's `default`, else the built-in table's entry and `default`. `None` when no table is there at all.
    pub fn num_for(&self, key: &str, field: &str) -> Option<u64> {
        let file = |f: &str| {
            self.table(key)
                .value(key)
                .and_then(|v| v.as_table())
                .and_then(|t| t.get(f))
                .and_then(nonneg)
        };
        file(field)
            .or_else(|| file("default"))
            .or_else(|| builtin::table_num(key, field))
            .or_else(|| builtin::table_num(key, "default"))
    }

    pub fn text(&self, key: &str) -> String {
        self.table(key)
            .value(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| builtin::text(key))
            .unwrap_or_default()
            .to_string()
    }

    pub fn list(&self, key: &str) -> Vec<String> {
        let from_file: Option<Vec<String>> = self
            .table(key)
            .value(key)
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            });
        from_file
            .or_else(|| builtin::list(key).map(|l| l.iter().map(|s| s.to_string()).collect()))
            .unwrap_or_default()
    }

    pub fn msg(&self, key: &str, subs: &[(&str, &str)]) -> String {
        fill(&self.text(key), subs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tempdir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "ah-cfg-{tag}-{}-{}",
            std::process::id(),
            crate::util::now_ms()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn missing_dir_is_all_builtin() {
        let s = Settings::load(Path::new(""));
        assert_eq!(s.bad_files.len(), 3);
        assert_eq!(
            s.num("client.deadline_ms"),
            builtin::num("client.deadline_ms").unwrap()
        );
        assert!(!s.text("msg.launcher_internal").is_empty());
        assert_eq!(s.list("launcher.hosts"), vec!["claude", "codex"]);
    }

    #[test]
    fn wrong_type_and_clamps() {
        let d = tempdir("a");
        std::fs::write(
            d.join(builtin::CFG_ENGINE_FILE),
            "[launcher.stdin_idle_ms]\nvalue = \"x\"\nmin = 5\n[launcher.spawn_retry_max]\nvalue = 99\nmax = 3\n[launcher.hosts]\nvalue = 4\n",
        )
        .unwrap();
        let s = Settings::load(&d);
        assert_eq!(
            s.num("launcher.stdin_idle_ms"),
            builtin::num("launcher.stdin_idle_ms").unwrap().max(5)
        );
        assert_eq!(s.num("launcher.spawn_retry_max"), 3);
        assert_eq!(s.list("launcher.hosts"), vec!["claude", "codex"]);
        assert!(
            s.bad_files
                .contains(&builtin::CFG_DISPATCH_FILE.to_string())
        );
        assert!(!s.bad_files.contains(&builtin::CFG_ENGINE_FILE.to_string()));
    }

    #[test]
    fn invalid_toml_falls_back() {
        let d = tempdir("b");
        std::fs::write(d.join(builtin::CFG_ENGINE_FILE), "[[[ not toml").unwrap();
        let s = Settings::load(&d);
        assert!(s.bad_files.contains(&builtin::CFG_ENGINE_FILE.to_string()));
        assert_eq!(
            s.num("launcher.cpu_hard_s"),
            builtin::num("launcher.cpu_hard_s").unwrap()
        );
    }
}
