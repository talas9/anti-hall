//! The files generated from the dispatch table (D87): the table `defaults/dispatch.toml` is the one source of truth for
//! which hook entries exist; this module prints the four files the plugin ships from it, per host.
//!
//! * `hooks.json` ([`hooks_json`]): the thin file the host reads, ONE entry per event and no matcher, each running the
//!   reliability wrapper with the event name. Which entries and rules then apply is decided by the engine from the table
//!   and the config, not by the host.
//! * `hooks.registry.json` ([`registry_json`]): the old per-hook form of `hooks.json` (one handler per table entry, with
//!   its matcher, command and timeout). Nothing in the host reads it; the plugin's Node readers (doctor, the briefing,
//!   the hook-latency script, tests) and the manual Codex installer use it to know which hook scripts exist.
//! * `ah-fallback.list` ([`fallback_list`]) and `ah-fallback.map.json` ([`fallback_map`]): what the wrapper runs when the
//!   engine cannot answer, one row per table entry.
//!
//! Every function is a pure function of the shipped table, so `tests/hooks_files.rs` can require that the committed files
//! equal the output byte for byte, and a new hook is added by one table row.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use crate::dispatch::table::{self, Entry};
use std::fmt::Write;

/// The events `host` gets a thin trigger for: every event the table has entries for, then the rest of
/// `dispatch.thin_events`, in listed order, without repeats.
pub fn events(host: &str) -> Vec<&'static str> {
    let mut out = table::events(host);
    for e in defaults::raw("dispatch.thin_events").get(host).map(|v| v.strings()).unwrap_or_default() {
        if !out.contains(&e) {
            out.push(e);
        }
    }
    out
}

/// The timeout of `event`'s thin entry: the longest timeout any of its table entries has, else `dispatch.thin_timeout_s`.
pub fn event_timeout(host: &str, event: &str) -> u64 {
    table::entries(host, event).iter().map(|e| e.timeout_s).max().filter(|t| *t > 0).unwrap_or_else(|| defaults::num("dispatch.thin_timeout_s"))
}

/// The thin command of `event` on `host`: `dispatch.thin_command` with the host's plugin-root variable and extra arguments.
pub fn thin_command(host: &str, event: &str) -> String {
    let var = defaults::raw("dispatch.root_vars").get(host).map(|v| v.strings()).unwrap_or_default().first().copied().unwrap_or("");
    let extra = defaults::raw("dispatch.thin_host_args").str_field(host);
    defaults::fill(defaults::text("dispatch.thin_command"), &[("var", &var), ("event", &event), ("extra", &extra)])
}

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

fn handler(out: &mut String, command: &str, timeout: u64) {
    crate::discard::harmless(write!(
        out,
        "          {{\n            \"type\": \"command\",\n            \"command\": {},\n            \"timeout\": {}\n          }}",
        q(command),
        timeout
    )); // keep: formatting into a String cannot fail
}

/// The thin `hooks.json` of `host`.
pub fn hooks_json(host: &str) -> String {
    let mut out = String::from("{\n  \"hooks\": {\n");
    let evs = events(host);
    for (i, ev) in evs.iter().enumerate() {
        crate::discard::harmless(write!(out, "    {}: [\n      {{\n        \"hooks\": [\n", q(ev))); // keep: formatting into a String cannot fail
        handler(&mut out, &thin_command(host, ev), event_timeout(host, ev));
        out.push_str("\n        ]\n      }\n    ]");
        out.push_str(if i + 1 < evs.len() { ",\n" } else { "\n" });
    }
    out.push_str("  }\n}\n");
    out
}

/// Entries of an event grouped the way `hooks.json` groups them: consecutive entries with the same matcher share a group.
fn groups(entries: &[Entry]) -> Vec<(&str, Vec<&Entry>)> {
    let mut out: Vec<(&str, Vec<&Entry>)> = Vec::new();
    for e in entries {
        match out.last_mut() {
            Some((m, g)) if *m == e.matcher => g.push(e),
            _ => out.push((&e.matcher, vec![e])),
        }
    }
    out
}

/// The per-hook registry of `host` in the old `hooks.json` shape (events with at least one table entry only).
pub fn registry_json(host: &str) -> String {
    let mut out = String::from("{\n  \"hooks\": {\n");
    let evs = table::events(host);
    for (i, ev) in evs.iter().enumerate() {
        let entries = table::entries(host, ev);
        crate::discard::harmless(writeln!(out, "    {}: [", q(ev))); // keep: formatting into a String cannot fail
        let gs = groups(&entries);
        for (gi, (matcher, g)) in gs.iter().enumerate() {
            out.push_str("      {\n");
            if !matcher.is_empty() {
                crate::discard::harmless(writeln!(out, "        \"matcher\": {},", q(matcher))); // keep: formatting into a String cannot fail
            }
            out.push_str("        \"hooks\": [\n");
            for (hi, e) in g.iter().enumerate() {
                handler(&mut out, &e.command, e.timeout_s);
                out.push_str(if hi + 1 < g.len() { ",\n" } else { "\n" });
            }
            out.push_str("        ]\n      }");
            out.push_str(if gi + 1 < gs.len() { ",\n" } else { "\n" });
        }
        out.push_str("    ]");
        out.push_str(if i + 1 < evs.len() { ",\n" } else { "\n" });
    }
    out.push_str("  }\n}\n");
    out
}

/// The wrapper's fallback list of `host`: a section per thin event (`@Event<TAB>timeout`, marked with the list's empty word
/// when the table has no entry for it), then one `matcher<TAB>timeout<TAB>command` row per table entry.
pub fn fallback_list(host: &str) -> String {
    let mut out = String::from(defaults::text("dispatch.list_banner"));
    out.push('\n');
    for ev in events(host) {
        let entries = table::entries(host, ev);
        let t = event_timeout(host, ev);
        if entries.is_empty() {
            crate::discard::harmless(writeln!(out, "@{ev}\t{t}\t{}", defaults::text("dispatch.list_empty_word"))); // keep: formatting into a String cannot fail
            continue;
        }
        crate::discard::harmless(writeln!(out, "@{ev}\t{t}")); // keep: formatting into a String cannot fail
        for e in entries {
            let matcher = if e.matcher.is_empty() { "*" } else { e.matcher.as_str() };
            let timeout = if e.timeout_s == 0 { t } else { e.timeout_s };
            crate::discard::harmless(writeln!(out, "{matcher}\t{timeout}\t{}", e.command)); // keep: formatting into a String cannot fail
        }
    }
    out
}

/// The `--fallback-map` file of `host`: event, then entry id, to the entry's command.
pub fn fallback_map(host: &str) -> String {
    let mut m = serde_json::Map::new();
    for ev in table::events(host) {
        let ids: serde_json::Map<String, serde_json::Value> =
            table::entries(host, ev).into_iter().map(|e| (e.id, serde_json::Value::String(e.command))).collect();
        m.insert(ev.to_string(), serde_json::Value::Object(ids));
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(m)).unwrap_or_default() + "\n"
}

/// The generated file `kind` (`hooks`, `registry`, `list` or `map`) of `host`; `None` for an unknown kind.
pub fn render(host: &str, kind: &str) -> Option<String> {
    match kind {
        "hooks" => Some(hooks_json(host)),
        "registry" => Some(registry_json(host)),
        "list" => Some(fallback_list(host)),
        "map" => Some(fallback_map(host)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_thin_file_has_one_matcherless_entry_per_event() {
        for host in table::hosts() {
            let v: serde_json::Value = serde_json::from_str(&hooks_json(host)).unwrap();
            let hooks = v["hooks"].as_object().unwrap();
            assert_eq!(hooks.len(), events(host).len(), "{host}");
            for (ev, groups) in hooks {
                let groups = groups.as_array().unwrap();
                assert_eq!(groups.len(), 1, "{host} {ev}: exactly one group");
                assert!(groups[0].get("matcher").is_none(), "{host} {ev}: no matcher");
                let hs = groups[0]["hooks"].as_array().unwrap();
                assert_eq!(hs.len(), 1, "{host} {ev}: exactly one handler");
                assert_eq!(hs[0]["command"].as_str().unwrap(), thin_command(host, ev));
                assert_eq!(hs[0]["timeout"].as_u64().unwrap(), event_timeout(host, ev));
            }
        }
    }

    #[test]
    fn worktree_events_have_no_thin_trigger_and_every_other_claude_event_has_one() {
        let evs = events("claude");
        assert!(!evs.contains(&"WorktreeCreate") && !evs.contains(&"WorktreeRemove"));
        assert_eq!(evs.len(), 31, "33 documented events minus the two worktree events: {evs:?}");
        assert!(evs.contains(&"PostToolBatch") && evs.contains(&"SessionEnd") && evs.contains(&"PermissionRequest"));
    }

    #[test]
    fn the_thin_command_names_the_hosts_root_variable_and_arguments() {
        assert_eq!(thin_command("claude", "Stop"), "sh \"${CLAUDE_PLUGIN_ROOT}/hooks/ah-hook.sh\" Stop");
        assert_eq!(thin_command("codex", "Stop"), "sh \"${PLUGIN_ROOT}/hooks/ah-hook.sh\" Stop --host codex");
    }

    #[test]
    fn the_registry_regroups_to_the_same_entries_in_the_same_order() {
        for host in table::hosts() {
            let v: serde_json::Value = serde_json::from_str(&registry_json(host)).unwrap();
            for (ev, gs) in v["hooks"].as_object().unwrap() {
                let mut got = Vec::new();
                for g in gs.as_array().unwrap() {
                    let m = g.get("matcher").and_then(|m| m.as_str()).unwrap_or("").to_string();
                    for h in g["hooks"].as_array().unwrap() {
                        got.push((m.clone(), h["command"].as_str().unwrap().to_string(), h["timeout"].as_u64().unwrap()));
                    }
                }
                let want: Vec<_> = table::entries(host, ev).into_iter().map(|e| (e.matcher, e.command, e.timeout_s)).collect();
                assert_eq!(got, want, "{host} {ev}");
            }
        }
    }

    #[test]
    fn the_fallback_list_marks_events_without_entries() {
        let l = fallback_list("claude");
        assert!(l.contains("@PostToolBatch\t10\tempty\n"), "{l}");
        assert!(l.lines().any(|x| x.starts_with("@PreToolUse\t45") && !x.ends_with("empty")));
    }
}
