//! The generated reference (D50, D54): `ah-engine docs --format md`.
//!
//! Everything here is read from the registries and the shipped defaults, never written by hand, so it cannot go
//! stale: the command registry, the socket protocol, every setting with its default and environment override, the
//! check registry, the metric and impact registries, and the error codes. A test compares the output with the
//! committed `REFERENCE.md`, so a new endpoint, key or code has to land in the reference in the same commit.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults::V;
use crate::{checks, cli, defaults};
use serde_json::{Value, json};
use std::fmt::Write;

/// A setting value in one table cell: scalars as is, long lists and tables summarised.
fn cell(v: &V) -> String {
    let s = match v {
        V::Str(s) => s.replace('\n', "\\n"),
        V::List(a) if a.len() > 6 => format!("{} items", a.len()),
        V::Table(t) => format!("{} entries", t.len()),
        V::Int(n) => n.to_string(),
        V::Bool(b) => b.to_string(),
        V::List(a) => a.iter().map(cell).collect::<Vec<_>>().join(", "),
    };
    let s = if s.chars().count() > 80 { format!("{}...", s.chars().take(77).collect::<String>()) } else { s };
    s.replace('|', "\\|")
}

fn esc(s: &str) -> String {
    s.replace('|', "\\|").replace('\n', " ")
}

/// Settings (everything that is not a command, metric, impact kind, protocol entry or message), grouped by file and
/// section, in shipped order.
fn is_setting(key: &str) -> bool {
    !(key.starts_with("cmd.")
        || key.starts_with("metric.")
        || key.starts_with("impact.")
        || key.starts_with("protocol.")
        || key.starts_with("flag.")
        || key.starts_with("msg.")
        || key.starts_with("git.msg_"))
}

/// Every `--flag` token of a command's argument synopsis (and its `read_only_flags`), by flag, with the commands that take it.
pub fn command_flags() -> std::collections::BTreeMap<String, Vec<String>> {
    let mut m: std::collections::BTreeMap<String, Vec<String>> = std::collections::BTreeMap::new();
    for c in cli::commands() {
        let toks = c.args.split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-')).filter(|t| t.starts_with("--") && t.len() > 2);
        for f in toks.map(str::to_string).chain(c.read_only_flags.iter().cloned()) {
            let users = m.entry(f).or_default();
            if !users.contains(&c.name) {
                users.push(c.name.clone());
            }
        }
    }
    m
}

/// The documented flags: the `flag.<name>` entries as (`--name`, doc).
pub fn documented_flags() -> Vec<(String, &'static str)> {
    defaults::all().iter().filter(|e| e.key.starts_with("flag.")).map(|e| (format!("--{}", &e.key["flag.".len()..]), e.doc)).collect()
}

/// Flags section: every flag a command takes or the code reads, who takes it, and what it means.
fn flags_section(o: &mut String) {
    crate::discard::harmless(writeln!(o, "## Flags\n\n{}\n", defaults::text("msg.docs_flags_intro"))); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "| Flag | Commands | What it does |\n|---|---|---|")); // keep: formatting into a String cannot fail
    let used = command_flags();
    let docs: std::collections::BTreeMap<String, &str> = documented_flags().into_iter().collect();
    let names: std::collections::BTreeSet<&String> = used.keys().chain(docs.keys()).collect();
    for f in names {
        let users = used.get(f).map(|u| u.iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        crate::discard::harmless(writeln!(o, "| `{f}` | {users} | {} |", esc(docs.get(f).copied().unwrap_or("undocumented")))); // keep: formatting into a String cannot fail
    }
    crate::discard::harmless(writeln!(o)); // keep: formatting into a String cannot fail
}

/// Environment variables section: every `env.*` name the engine, its client or its shell wrappers read, and every
/// setting's numeric override variable, sorted by name.
fn env_section(o: &mut String, all: &[&defaults::Entry]) {
    crate::discard::harmless(writeln!(o, "## Environment variables\n\n{}\n", defaults::text("msg.docs_env_intro"))); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "| Variable | Setting | What it does |\n|---|---|---|")); // keep: formatting into a String cannot fail
    let mut rows: std::collections::BTreeMap<String, (String, String)> = std::collections::BTreeMap::new();
    for e in all {
        // a setting whose whole value is a variable name (`env.*`, `diagnostics.allocator_env`, ...) documents that variable
        let named = e.value.as_str().filter(|v| v.starts_with("AH_ENGINE_") && v.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'));
        if let Some(name) = named {
            let setting = if e.key.starts_with("env.") { String::new() } else { format!("`{}`", e.key) };
            rows.entry(name.to_string()).and_modify(|r| r.1.push_str(&format!(" {}", esc(e.doc)))).or_insert((setting, esc(e.doc)));
        } else if let Some(name) = e.env {
            rows.insert(name.to_string(), (format!("`{}`", e.key), esc(e.doc)));
        }
    }
    for (name, (setting, doc)) in rows {
        crate::discard::harmless(writeln!(o, "| `{name}` | {setting} | {doc} |")); // keep: formatting into a String cannot fail
    }
    crate::discard::harmless(writeln!(o)); // keep: formatting into a String cannot fail
}

/// The reference as Markdown.
pub fn markdown() -> String {
    let mut o = String::new();
    let all = defaults::all();
    crate::discard::harmless(writeln!(o, "# ah-engine reference\n\n{}\n", defaults::text("msg.docs_intro"))); // keep: formatting into a String cannot fail

    crate::discard::harmless(writeln!(o, "## Commands\n\nEvery command accepts `--json`. Read-only commands never change state.\n")); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "| Command | Arguments | Read-only | Status | What it does |\n|---|---|---|---|---|")); // keep: formatting into a String cannot fail
    for c in cli::commands() {
        crate::discard::harmless(writeln!(
            o,
            "| `{}` | `{}` | {} | {} | {} |",
            c.name,
            esc(&c.args),
            if c.read_only { "yes" } else { "no" },
            c.status,
            esc(&c.doc)
        )); // keep: formatting into a String cannot fail
    }

    crate::discard::harmless(writeln!(o)); // keep: formatting into a String cannot fail
    flags_section(&mut o);
    env_section(&mut o, &all);
    crate::discard::harmless(writeln!(o, "\n## Socket protocol\n\n| Name | Request | Reply | What it does |\n|---|---|---|---|")); // keep: formatting into a String cannot fail
    for e in all.iter().filter(|e| e.key.starts_with("protocol.")) {
        crate::discard::harmless(writeln!(
            o,
            "| `{}` | `{}` | `{}` | {} |",
            &e.key["protocol.".len()..],
            esc(e.value.str_field("request")),
            esc(e.value.str_field("reply")),
            esc(e.doc)
        )); // keep: formatting into a String cannot fail
    }

    crate::discard::harmless(writeln!(o, "\n## Checks\n\n{}\n\n{}\n", defaults::text("msg.docs_checks_note"), defaults::text("msg.docs_rule_fields"))); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "| Check | What it does |\n|---|---|")); // keep: formatting into a String cannot fail
    for c in checks::registry() {
        crate::discard::harmless(writeln!(o, "| `{}` | {} |", c.name(), esc(c.summary()))); // keep: formatting into a String cannot fail
    }

    crate::discard::harmless(writeln!(
        o,
        "\n## Settings\n\nDefaults ship with the plugin in `engine/defaults/*.toml` and are read at run time; a numeric setting with an environment variable can be overridden for one process.\n"
    )); // keep: formatting into a String cannot fail
    let mut last = String::new();
    for e in all.iter().filter(|e| is_setting(e.key)) {
        let section = format!("{} / {}", e.file, e.key.split('.').next().unwrap_or(""));
        if section != last {
            crate::discard::harmless(writeln!(o, "\n### {section}\n\n| Key | Default | Env override | Unit | What it is |\n|---|---|---|---|---|")); // keep: formatting into a String cannot fail
            last = section;
        }
        crate::discard::harmless(writeln!(
            o,
            "| `{}` | `{}` | {} | {} | {} |",
            e.key,
            cell(&e.value),
            e.env.map(|n| format!("`{n}`")).unwrap_or_default(),
            e.unit.unwrap_or(""),
            esc(e.doc)
        )); // keep: formatting into a String cannot fail
    }

    crate::discard::harmless(writeln!(
        o,
        "\n## Messages\n\nText lives in `messages.toml` (and `git.toml` for the git check's block messages); keys and what they are for:\n"
    )); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "| Key | When it is shown |\n|---|---|")); // keep: formatting into a String cannot fail
    for e in all.iter().filter(|e| e.key.starts_with("msg.") || e.key.starts_with("git.msg_")) {
        crate::discard::harmless(writeln!(o, "| `{}` | {} |", e.key, esc(e.doc))); // keep: formatting into a String cannot fail
    }

    crate::discard::harmless(writeln!(o, "\n## Metrics\n\n| Name | Kind | Unit | Labels | What it counts |\n|---|---|---|---|---|")); // keep: formatting into a String cannot fail
    for e in all.iter().filter(|e| e.key.starts_with("metric.")) {
        let labels = e.value.get("labels").map(|l| l.strings().join(", ")).unwrap_or_default();
        crate::discard::harmless(writeln!(
            o,
            "| `{}` | {} | {} | {} | {} |",
            &e.key["metric.".len()..],
            e.value.str_field("kind"),
            e.value.str_field("unit"),
            labels,
            esc(e.doc)
        )); // keep: formatting into a String cannot fail
    }

    crate::discard::harmless(writeln!(o, "\n## Impact kinds\n\n| Kind | What it records |\n|---|---|")); // keep: formatting into a String cannot fail
    for k in crate::impact::kinds() {
        let doc = all.iter().find(|e| e.key == format!("impact.{k}")).map(|e| e.doc).unwrap_or_default();
        crate::discard::harmless(writeln!(o, "| `{k}` | {} |", esc(doc))); // keep: formatting into a String cannot fail
    }

    crate::discard::harmless(writeln!(
        o,
        "\n## Error codes\n\nEnvironment-class codes get a plain self-fix hint; any other code is a permanent failure that asks for an issue.\n"
    )); // keep: formatting into a String cannot fail
    crate::discard::harmless(writeln!(o, "| Codes | Class | Self-fix hint |\n|---|---|---|")); // keep: formatting into a String cannot fail
    for g in defaults::raw("health.error_codes").as_array().unwrap_or_default() {
        let codes = g.get("codes").map(|c| c.strings().iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let hint = crate::health::hint_text(g.str_field("hint"));
        crate::discard::harmless(writeln!(o, "| {codes} | {} | {} |", g.str_field("class"), esc(&hint))); // keep: formatting into a String cannot fail
    }
    o
}

/// The same registries as JSON, for agents (`ah-engine docs --json`).
pub fn json() -> Value {
    let settings: Vec<Value> = defaults::all()
        .iter()
        .filter(|e| is_setting(e.key))
        .map(|e| json!({"key": e.key, "file": e.file, "default": e.value.to_json(), "env": e.env, "unit": e.unit, "doc": e.doc}))
        .collect();
    let commands: Vec<Value> =
        cli::commands().into_iter().map(|c| json!({"name": c.name, "args": c.args, "read_only": c.read_only, "status": c.status, "doc": c.doc})).collect();
    let checks: Vec<Value> = checks::registry().iter().map(|c| json!({"name": c.name(), "summary": c.summary()})).collect();
    json!({
        "commands": commands,
        "checks": checks,
        "settings": settings,
        "flags": documented_flags().into_iter().map(|(f, d)| json!({"flag": f, "commands": command_flags().get(&f), "doc": d})).collect::<Vec<_>>(),
        "env": defaults::all().iter().filter(|e| e.key.starts_with("env.")).map(|e| json!({"name": e.value.to_json(), "doc": e.doc})).collect::<Vec<_>>(),
        "metrics": defaults::all().iter().filter(|e| e.key.starts_with("metric.")).map(|e| json!({"name": &e.key["metric.".len()..], "spec": e.value.to_json(), "doc": e.doc})).collect::<Vec<_>>(),
        "impact_kinds": crate::impact::kinds(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_reference_lists_every_command_check_metric_and_impact_kind() {
        let md = markdown();
        for c in cli::commands() {
            assert!(md.contains(&format!("| `{}` |", c.name)), "command {} missing", c.name);
        }
        for c in checks::registry() {
            assert!(md.contains(&format!("| `{}` |", c.name())), "check {} missing", c.name());
        }
        for e in defaults::all().iter().filter(|e| e.key.starts_with("metric.")) {
            assert!(md.contains(&format!("| `{}` |", &e.key["metric.".len()..])), "metric {} missing", e.key);
        }
        for k in crate::impact::kinds() {
            assert!(md.contains(&format!("| `{k}` |")), "impact kind {k} missing");
        }
    }

    #[test]
    fn the_reference_lists_every_setting_with_its_env_override() {
        let md = markdown();
        for e in defaults::all().iter().filter(|e| is_setting(e.key)) {
            assert!(md.contains(&format!("| `{}` |", e.key)), "setting {} missing", e.key);
            if let Some(env) = e.env {
                assert!(md.contains(&format!("`{env}`")), "env {env} missing");
            }
        }
    }

    #[test]
    fn every_command_flag_has_a_description() {
        let docs: std::collections::BTreeMap<String, &str> = documented_flags().into_iter().collect();
        for (flag, users) in command_flags() {
            assert!(docs.contains_key(&flag), "flag {flag} (used by {users:?}) has no `[flag.*]` entry in flags.toml");
        }
        for (flag, doc) in &docs {
            assert!(!doc.trim().is_empty(), "flag {flag} has an empty description");
        }
    }

    #[test]
    fn the_reference_has_flag_and_environment_sections() {
        let md = markdown();
        assert!(md.contains("\n## Flags\n"), "flags section missing");
        assert!(md.contains("\n## Environment variables\n"), "environment section missing");
        assert!(md.contains("| `--json` |"), "--json missing");
        assert!(md.contains("| `AH_ENGINE_DIR` |"), "AH_ENGINE_DIR missing");
    }

    #[test]
    fn generation_is_deterministic() {
        assert_eq!(markdown(), markdown());
    }
}
