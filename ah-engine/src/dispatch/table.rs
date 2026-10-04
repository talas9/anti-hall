//! The dispatch table (D58): per host and event, the hook entries `hooks.json` registers, in `hooks.json` order, and
//! which of them a built-in check answers. The table is data (`defaults/dispatch.toml`, generated from the two
//! `hooks.json` files and kept in step by `tests/dispatch_table.rs`); this module reads it and decides which entries
//! a payload matches, the way the host does.
use crate::defaults::{self, V};
use crate::error::DispatchError;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;

/// One hook entry of an event, as `hooks.json` registers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Stable name of the entry within its event (the fallback-map key).
    pub id: String,
    /// The `hooks.json` matcher (`""` = every occurrence).
    pub matcher: String,
    /// The Node hook command, exactly as `hooks.json` has it (or as the fallback map overrides it).
    pub command: String,
    /// The `hooks.json` timeout in seconds.
    pub timeout_s: u64,
    /// The built-in check that answers this entry, if any.
    pub check: Option<String>,
}

/// The table key of one host's event.
fn key(host: &str, event: &str) -> String {
    format!("dispatch.hooks_{host}_{event}")
}

/// The hosts the table has (every `dispatch.root_vars` host).
pub fn hosts() -> Vec<&'static str> {
    defaults::raw("dispatch.root_vars").as_table().map(|t| t.iter().map(|(k, _)| *k).collect()).unwrap_or_default()
}

/// Every entry of `host`'s `event`, in table order; empty when the host does not register the event.
pub fn entries(host: &str, event: &str) -> Vec<Entry> {
    let k = key(host, event);
    if !defaults::has(&k) {
        return Vec::new();
    }
    defaults::raw(&k)
        .as_array()
        .unwrap_or(&[])
        .iter()
        .map(|e| Entry {
            id: e.str_field("id").to_string(),
            matcher: e.str_field("matcher").to_string(),
            command: e.str_field("command").to_string(),
            timeout_s: e.get("timeout").and_then(V::as_integer).unwrap_or(0).max(0) as u64,
            check: Some(e.str_field("check")).filter(|c| !c.is_empty()).map(str::to_string),
        })
        .collect()
}

/// Every event the table lists for `host`, in file order.
pub fn events(host: &str) -> Vec<&'static str> {
    let prefix = key(host, "");
    defaults::all().iter().filter_map(|e| e.key.strip_prefix(prefix.as_str())).collect()
}

/// Whether `matcher` selects a value of `subject` (with its aliases) on `host`.
///
/// Mirrors the host: Claude reads a matcher made only of letters, digits and `dispatch.exact_chars` as an exact name or
/// a `|`/`,` list and anything else as an unanchored JavaScript regex; Codex reads every matcher as an unanchored regex
/// (`dispatch.matcher_mode`). An invalid regex matches nothing.
pub fn matcher_matches(host: &str, matcher: &str, subjects: &[&str]) -> bool {
    if defaults::list("dispatch.match_all").contains(&matcher) {
        return true;
    }
    let mode = defaults::raw("dispatch.matcher_mode").str_field(host);
    let exact_chars = defaults::text("dispatch.exact_chars");
    let exact = mode != "regex" && matcher.chars().all(|c| c.is_ascii_alphanumeric() || exact_chars.contains(c));
    if exact {
        let seps = defaults::text("dispatch.list_separators");
        let names: Vec<&str> = matcher.split(|c| seps.contains(c)).map(str::trim).filter(|s| !s.is_empty()).collect();
        return subjects.iter().any(|s| names.contains(s));
    }
    match Regex::new(matcher) {
        Ok(re) => subjects.iter().any(|s| re.is_match(s)),
        Err(_) => false,
    }
}

/// The value a matcher of `event` is tested against, plus the host's aliases for it; `None` when the event ignores
/// matchers (`dispatch.matcher_field` does not list it).
pub fn matcher_subjects(host: &str, event: &str, payload: &Value, tool: Option<&str>) -> Option<Vec<String>> {
    let field = defaults::raw("dispatch.matcher_field").get(event).and_then(V::as_str)?;
    let value = match (field, tool) {
        ("tool_name", Some(t)) => t.to_string(),
        _ => payload.get(field).and_then(Value::as_str).unwrap_or("").to_string(),
    };
    let mut out = vec![value.clone()];
    if let Some(aliases) = defaults::raw("dispatch.tool_aliases").get(host).and_then(|h| h.get(&value)) {
        out.extend(aliases.strings().into_iter().map(str::to_string));
    }
    Some(out)
}

/// The entries of `host`'s `event` that this payload matches, in table order. `tool` (the `--tool` argument) stands
/// in for the payload's `tool_name` when given.
pub fn select(host: &str, event: &str, payload: &Value, tool: Option<&str>) -> Vec<Entry> {
    let subjects = matcher_subjects(host, event, payload, tool);
    entries(host, event)
        .into_iter()
        .filter(|e| match &subjects {
            None => true,
            Some(s) => matcher_matches(host, &e.matcher, &s.iter().map(String::as_str).collect::<Vec<_>>()),
        })
        .collect()
}

/// The fallback map: event, then hook id, to the Node command that replaces the table's command for that entry.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct FallbackMap(pub HashMap<String, HashMap<String, String>>);

impl FallbackMap {
    /// Read a `--fallback-map` file: a JSON object `{ "<Event>": { "<hook id>": "<command>" } }`.
    pub fn load(path: &std::path::Path) -> Result<FallbackMap, DispatchError> {
        let text = std::fs::read_to_string(path).map_err(|e| DispatchError::Map { path: path.to_path_buf(), detail: e.to_string() })?;
        serde_json::from_str::<HashMap<String, HashMap<String, String>>>(&text)
            .map(FallbackMap)
            .map_err(|e| DispatchError::Map { path: path.to_path_buf(), detail: e.to_string() })
    }

    /// Apply the map's overrides to `entries` of `event`.
    pub fn apply(&self, event: &str, entries: &mut [Entry]) {
        if let Some(m) = self.0.get(event) {
            for e in entries.iter_mut() {
                if let Some(c) = m.get(&e.id) {
                    e.command = c.clone();
                }
            }
        }
    }
}

/// The plugin root for `host`: the first of its `dispatch.root_vars` that is set and not empty.
pub fn plugin_root(host: &str) -> Option<String> {
    defaults::raw("dispatch.root_vars").get(host)?.strings().into_iter().find_map(|v| std::env::var(v).ok().filter(|s| !s.is_empty()))
}

/// Whether `command` can run here: it is not empty and every `${NAME}` / `$NAME` variable it names is set.
///
/// Why: a hook command whose plugin-root variable is unset would run a script at the wrong path and report a
/// "not found" error the host treats as no decision, which is a silent allow for a guard (D74).
pub fn runnable(command: &str) -> bool {
    if command.trim().is_empty() {
        return false;
    }
    let b = command.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'$' {
            let rest = &command[i + 1..];
            let (name, used) = if let Some(r) = rest.strip_prefix('{') {
                let end = r.find('}').unwrap_or(r.len());
                (&r[..end], end + 2)
            } else {
                let end = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(rest.len());
                (&rest[..end], end + 1)
            };
            if !name.is_empty() && std::env::var(name).map(|v| v.is_empty()).unwrap_or(true) {
                return false;
            }
            i += used;
        } else {
            i += 1;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_matchers_are_exact_lists_or_unanchored_regexes() {
        assert!(matcher_matches("claude", "Bash", &["Bash"]));
        assert!(!matcher_matches("claude", "Bash", &["BashOutput"]), "a plain name is exact on Claude");
        assert!(matcher_matches("claude", "Write|Edit|MultiEdit|Bash", &["Bash"]));
        assert!(matcher_matches("claude", "Edit, Write", &["Write"]));
        assert!(matcher_matches("claude", "", &["anything"]));
        assert!(matcher_matches("claude", "*", &["anything"]));
        assert!(matcher_matches("claude", "^Notebook", &["NotebookEdit"]));
        assert!(matcher_matches("claude", "Edit.*", &["NotebookEdit"]), "a regex is unanchored");
        assert!(!matcher_matches("claude", "(", &["("]), "an invalid regex matches nothing");
    }

    #[test]
    fn codex_matchers_are_regexes_and_apply_patch_answers_to_edit_and_write() {
        assert!(matcher_matches("codex", "Bash", &["BashOutput"]), "Codex reads every matcher as an unanchored regex");
        assert!(matcher_matches("codex", "^(?:collaboration)?spawn_agent$", &["collaborationspawn_agent"]));
        let p = json!({"tool_name": "apply_patch"});
        let s = matcher_subjects("codex", "PreToolUse", &p, None).unwrap();
        assert!(matcher_matches("codex", "Edit|Write", &s.iter().map(String::as_str).collect::<Vec<_>>()));
    }

    #[test]
    fn events_without_a_matcher_field_ignore_matchers() {
        assert!(matcher_subjects("claude", "Stop", &json!({}), None).is_none());
        assert_eq!(matcher_subjects("claude", "PreToolUse", &json!({"tool_name": "Read"}), Some("Bash")).unwrap(), vec!["Bash"]);
    }

    #[test]
    fn the_bash_pre_tool_use_entries_are_the_nine_node_hooks_in_order() {
        let p = json!({"tool_name": "Bash"});
        let ids: Vec<String> = select("claude", "PreToolUse", &p, None).into_iter().map(|e| e.id).collect();
        assert_eq!(
            ids,
            [
                "compact-declaration-guard",
                "git-guard",
                "command-guard",
                "coordinator-work-guard",
                "merge-side-pick",
                "merge-gate",
                "scan-throttle",
                "api-guard",
                "ship-it-guard"
            ]
        );
        assert_eq!(select("claude", "PreToolUse", &json!({"tool_name": "Glob"}), None), Vec::new(), "no entry matches Glob");
    }

    #[test]
    fn runnable_needs_every_named_variable() {
        std::env::set_var("AH_DISPATCH_T_SET", "/x");
        std::env::remove_var("AH_DISPATCH_T_UNSET");
        assert!(runnable("node \"${AH_DISPATCH_T_SET}/hooks/a.js\" --post"));
        assert!(runnable("node $AH_DISPATCH_T_SET/a.js"));
        assert!(!runnable("node \"${AH_DISPATCH_T_UNSET}/hooks/a.js\""));
        assert!(!runnable("  "));
    }

    #[test]
    fn the_fallback_map_overrides_by_event_and_id() {
        let mut es = entries("claude", "PreToolUse");
        let mut m = FallbackMap::default();
        m.0.insert("PreToolUse".into(), [("git-guard".to_string(), "node /tmp/x.js".to_string())].into_iter().collect());
        m.apply("PreToolUse", &mut es);
        assert_eq!(es.iter().find(|e| e.id == "git-guard").unwrap().command, "node /tmp/x.js");
        assert!(es.iter().find(|e| e.id == "command-guard").unwrap().command.contains("command-guard.js"));
    }
}
