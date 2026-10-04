//! The generated reference (D50, D54): `ah-engine docs --format md`.
//!
//! Everything here is read from the registries and the shipped defaults, never written by hand, so it cannot go
//! stale: the command registry, the socket protocol, every setting with its default and environment override, the
//! check registry, the metric and impact registries, and the error codes. A test compares the output with the
//! committed `REFERENCE.md`, so a new endpoint, key or code has to land in the reference in the same commit.
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
        || key.starts_with("msg.")
        || key.starts_with("git.msg_"))
}

/// The reference as Markdown.
pub fn markdown() -> String {
    let mut o = String::new();
    let all = defaults::all();
    let _ = writeln!(o, "# ah-engine reference\n\n{}\n", defaults::text("msg.docs_intro"));

    let _ = writeln!(o, "## Commands\n\nEvery command accepts `--json`. Read-only commands never change state.\n");
    let _ = writeln!(o, "| Command | Arguments | Read-only | Status | What it does |\n|---|---|---|---|---|");
    for c in cli::commands() {
        let _ = writeln!(o, "| `{}` | `{}` | {} | {} | {} |", c.name, esc(&c.args), if c.read_only { "yes" } else { "no" }, c.status, esc(&c.doc));
    }

    let _ = writeln!(o, "\n## Socket protocol\n\n| Name | Request | Reply | What it does |\n|---|---|---|---|");
    for e in all.iter().filter(|e| e.key.starts_with("protocol.")) {
        let _ = writeln!(
            o,
            "| `{}` | `{}` | `{}` | {} |",
            &e.key["protocol.".len()..],
            esc(e.value.str_field("request")),
            esc(e.value.str_field("reply")),
            esc(e.doc)
        );
    }

    let _ = writeln!(o, "\n## Checks\n\n{}\n\n{}\n", defaults::text("msg.docs_checks_note"), defaults::text("msg.docs_rule_fields"));
    let _ = writeln!(o, "| Check | What it does |\n|---|---|");
    for c in checks::registry() {
        let _ = writeln!(o, "| `{}` | {} |", c.name(), esc(c.summary()));
    }

    let _ =
        writeln!(o, "\n## Settings\n\nDefaults ship in `defaults/*.toml`; a numeric setting with an environment variable can be overridden for one process.\n");
    let mut last = String::new();
    for e in all.iter().filter(|e| is_setting(e.key)) {
        let section = format!("{} / {}", e.file, e.key.split('.').next().unwrap_or(""));
        if section != last {
            let _ = writeln!(o, "\n### {section}\n\n| Key | Default | Env override | Unit | What it is |\n|---|---|---|---|---|");
            last = section;
        }
        let _ = writeln!(
            o,
            "| `{}` | `{}` | {} | {} | {} |",
            e.key,
            cell(&e.value),
            e.env.map(|n| format!("`{n}`")).unwrap_or_default(),
            e.unit.unwrap_or(""),
            esc(e.doc)
        );
    }

    let _ = writeln!(o, "\n## Messages\n\nText lives in `messages.toml` (and `git.toml` for the git check's block messages); keys and what they are for:\n");
    let _ = writeln!(o, "| Key | When it is shown |\n|---|---|");
    for e in all.iter().filter(|e| e.key.starts_with("msg.") || e.key.starts_with("git.msg_")) {
        let _ = writeln!(o, "| `{}` | {} |", e.key, esc(e.doc));
    }

    let _ = writeln!(o, "\n## Metrics\n\n| Name | Kind | Unit | Labels | What it counts |\n|---|---|---|---|---|");
    for e in all.iter().filter(|e| e.key.starts_with("metric.")) {
        let labels = e.value.get("labels").map(|l| l.strings().join(", ")).unwrap_or_default();
        let _ =
            writeln!(o, "| `{}` | {} | {} | {} | {} |", &e.key["metric.".len()..], e.value.str_field("kind"), e.value.str_field("unit"), labels, esc(e.doc));
    }

    let _ = writeln!(o, "\n## Impact kinds\n\n| Kind | What it records |\n|---|---|");
    for k in crate::impact::kinds() {
        let doc = all.iter().find(|e| e.key == format!("impact.{k}")).map(|e| e.doc).unwrap_or_default();
        let _ = writeln!(o, "| `{k}` | {} |", esc(doc));
    }

    let _ =
        writeln!(o, "\n## Error codes\n\nEnvironment-class codes get a plain self-fix hint; any other code is a permanent failure that asks for an issue.\n");
    let _ = writeln!(o, "| Codes | Class | Self-fix hint |\n|---|---|---|");
    for g in defaults::raw("health.error_codes").as_array().unwrap_or_default() {
        let codes = g.get("codes").map(|c| c.strings().iter().map(|c| format!("`{c}`")).collect::<Vec<_>>().join(", ")).unwrap_or_default();
        let hint = crate::health::hint_text(g.str_field("hint"));
        let _ = writeln!(o, "| {codes} | {} | {} |", g.str_field("class"), esc(&hint));
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
    fn generation_is_deterministic() {
        assert_eq!(markdown(), markdown());
    }
}
