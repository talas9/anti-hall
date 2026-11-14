//! #764: rules that fire but never reach the agent. Reads the shipped TOML (both the live `defaults/` and the non-pinned
//! `defaults.pristine/` copy) so a value cannot drift in one place only.
use std::path::PathBuf;

fn engine_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall/engine")
}

/// The `value` of key `section.name` in `<dir>/<file>`, for both shipped copies. The shipped files are the engine's own
/// format (one `[key]` table per setting, redefinitions allowed), so the one table is cut out and parsed alone.
fn both(file: &str, key: &str) -> Vec<(&'static str, toml::Value)> {
    ["defaults", "defaults.pristine"]
        .iter()
        .map(|d| {
            let text = std::fs::read_to_string(engine_dir().join(d).join(file)).unwrap_or_else(|e| panic!("{d}/{file}: {e}"));
            let header = format!("[{key}]");
            let mut body = String::new();
            let mut inside = false;
            for line in text.lines() {
                if inside && line.starts_with('[') {
                    break;
                }
                if inside {
                    body.push_str(line);
                    body.push('\n');
                } else if line.trim_end() == header {
                    inside = true;
                }
            }
            assert!(inside, "{d}/{file}: no {key}");
            let doc: toml::Table = body.parse().unwrap_or_else(|e| panic!("{d}/{file}: {key}: {e}"));
            (*d, doc.get("value").unwrap_or_else(|| panic!("{d}/{file}: {key} has no value")).clone())
        })
        .collect()
}

fn text_of(file: &str, key: &str) -> Vec<(&'static str, String)> {
    both(file, key).into_iter().map(|(d, v)| (d, v.as_str().unwrap_or_else(|| panic!("{d}/{file}: {key} is not text")).to_string())).collect()
}

/// Item 2: the checks the owner relies on are never shed past the hard CPU limit.
#[test]
fn the_reminders_the_owner_relies_on_are_in_shed_never() {
    for (d, v) in both("diagnostics.toml", "diagnostics.shed_never") {
        let t = v.as_table().unwrap();
        for c in ["idle-agent-sweep", "gh-rt-advisory", "procwatch-advisory", "switch-notice", "limit-conserve-inject"] {
            assert!(t.get(c).and_then(|r| r.as_str()).is_some_and(|r| !r.is_empty()), "{d}: {c} must be in diagnostics.shed_never with a reason");
        }
    }
}

