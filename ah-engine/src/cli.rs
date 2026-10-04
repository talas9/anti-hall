//! The command line (D50, D53): one registry of commands, every one accepting `--json`.
//!
//! Why a registry: the generated reference, the usage text and the future command-guard allowlist all need the list of
//! commands and whether each one changes state. The data (summary, arguments, `read_only`, status) is in
//! `defaults/commands.toml`; the handlers are here. A test keeps the two in step, so a command cannot exist without
//! documentation or be documented without existing.
use crate::{client, daemon, defaults, docs, health};
use serde_json::{json, Value};

/// A parsed command line: the command, whether `--json` was given, and the remaining arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// The command word (empty when none was given).
    pub command: String,
    /// `--json` was present anywhere.
    pub json: bool,
    /// Everything after the command except `--json`.
    pub rest: Vec<String>,
}

/// A command's shipped metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandInfo {
    /// The command word.
    pub name: String,
    /// Argument synopsis.
    pub args: String,
    /// True when the command never changes state.
    pub read_only: bool,
    /// `implemented` or `planned (D-n)`.
    pub status: String,
    /// What it does.
    pub doc: String,
}

type Handler = fn(&Parsed) -> i32;

/// The handlers, by command word. Planned commands are not listed here: they are in the defaults only.
fn handlers() -> &'static [(&'static str, Handler)] {
    &[
        ("serve", cmd_serve),
        ("hook", cmd_hook),
        ("status", cmd_status),
        ("metrics", cmd_metrics),
        ("impact", cmd_impact),
        ("docs", cmd_docs),
        ("check", cmd_check),
        ("version", cmd_version),
        ("ctl", cmd_ctl),
        ("stop", cmd_stop),
        ("reset", cmd_reset),
        ("proj", cmd_proj),
    ]
}

/// Every command in the shipped registry data, in file order.
pub fn commands() -> Vec<CommandInfo> {
    defaults::all()
        .into_iter()
        .filter(|e| e.key.starts_with("cmd."))
        .map(|e| {
            let t = e.value.as_table().cloned().unwrap_or_default();
            let get = |k: &str| t.get(k).and_then(toml::Value::as_str).unwrap_or("").to_string();
            CommandInfo {
                name: e.key["cmd.".len()..].to_string(),
                args: get("args"),
                read_only: t.get("read_only").and_then(toml::Value::as_bool).unwrap_or(false),
                status: get("status"),
                doc: e.doc,
            }
        })
        .collect()
}

/// Split `--json` out of the arguments (after the program name).
pub fn parse(args: &[String]) -> Parsed {
    let json = args.iter().any(|a| a == "--json");
    let mut rest: Vec<String> = args.iter().filter(|a| *a != "--json").cloned().collect();
    let command = if rest.is_empty() { String::new() } else { rest.remove(0) };
    Parsed { command, json, rest }
}

/// Print `text`, or `value` as one JSON line when `--json` was given.
fn emit(p: &Parsed, text: String, value: Value) {
    if p.json {
        println!("{value}");
    } else {
        println!("{text}");
    }
}

/// A flag's value: the word after `--<name>`.
fn flag(p: &Parsed, name: &str) -> String {
    let f = format!("--{name}");
    p.rest.iter().position(|a| *a == f).and_then(|i| p.rest.get(i + 1)).cloned().unwrap_or_default()
}

/// Render JSON as indented `key: value` lines for people.
pub fn human(v: &Value) -> String {
    fn walk(v: &Value, indent: usize, out: &mut String) {
        let pad = "  ".repeat(indent);
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    if x.is_object() || x.as_array().is_some_and(|a| a.iter().any(|y| y.is_object())) {
                        out.push_str(&format!("{pad}{k}:\n"));
                        walk(x, indent + 1, out);
                    } else {
                        out.push_str(&format!("{pad}{k}: {}\n", scalar(x)));
                    }
                }
            }
            Value::Array(a) => {
                for x in a {
                    if x.is_object() {
                        out.push_str(&format!("{pad}-\n"));
                        walk(x, indent + 1, out);
                    } else {
                        out.push_str(&format!("{pad}- {}\n", scalar(x)));
                    }
                }
            }
            other => out.push_str(&format!("{pad}{}\n", scalar(other))),
        }
    }
    fn scalar(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            Value::Array(a) => a.iter().map(scalar).collect::<Vec<_>>().join(", "),
            other => other.to_string(),
        }
    }
    let mut out = String::new();
    walk(v, 0, &mut out);
    out.trim_end().to_string()
}

/// Run the command line (arguments after the program name); returns the process exit code.
pub fn run(args: &[String]) -> i32 {
    let p = parse(args);
    let infos = commands();
    let Some(info) = infos.iter().find(|c| c.name == p.command) else {
        let names: Vec<String> = infos.iter().map(|c| c.name.clone()).collect();
        let usage = defaults::render("msg.cli_usage", &[("commands", &names.join("|"))]);
        if p.json && !p.command.is_empty() {
            println!("{}", json!({"error": defaults::render("msg.cli_unknown", &[("command", &p.command)]), "usage": usage}));
        } else {
            eprintln!("{usage}");
        }
        return 64;
    };
    if info.status != "implemented" {
        let decision = info.status.trim_start_matches("planned (").trim_end_matches(')').to_string();
        let msg = defaults::render("msg.cli_planned", &[("command", &p.command), ("decision", &decision)]);
        emit(&p, msg.clone(), json!({"error": msg, "status": info.status}));
        return 64;
    }
    match handlers().iter().find(|(n, _)| *n == p.command) {
        Some((_, h)) => h(&p),
        None => 70, // registered as implemented but has no handler: the registry test prevents this
    }
}

fn cmd_serve(_: &Parsed) -> i32 {
    daemon::serve();
    0
}

fn cmd_hook(p: &Parsed) -> i32 {
    client::hook_main(&p.rest)
}

fn cmd_status(p: &Parsed) -> i32 {
    let v = client::status_value();
    emit(p, human(&v), v);
    0
}

/// A report that comes from the daemon; with none running, say so (and `running: false` in JSON).
fn report(p: &Parsed, verb: &str) -> i32 {
    match client::ctl_json(verb) {
        Some(v) => emit(p, human(&v), v),
        None => emit(p, defaults::text("msg.cli_not_running").to_string(), json!({"running": false, "note": defaults::text("msg.cli_not_running")})),
    }
    0
}

fn cmd_metrics(p: &Parsed) -> i32 {
    let check = flag(p, "check");
    report(p, &if check.is_empty() { "metrics".to_string() } else { format!("metrics check={check}") })
}

fn cmd_impact(p: &Parsed) -> i32 {
    let mut verb = "impact".to_string();
    for name in ["kind", "project", "recent"] {
        let v = flag(p, name);
        if !v.is_empty() {
            verb.push_str(&format!(" {name}={v}"));
        }
    }
    report(p, &verb)
}

fn cmd_docs(p: &Parsed) -> i32 {
    let fmt = flag(p, "format");
    if p.json {
        println!("{}", docs::json());
    } else if fmt.is_empty() || fmt == "md" {
        print!("{}", docs::markdown());
    } else {
        eprintln!("{}", defaults::render("msg.cli_unknown", &[("command", &format!("--format {fmt}"))]));
        return 64;
    }
    0
}

fn cmd_check(p: &Parsed) -> i32 {
    crate::checks::cli_main(p.rest.first().map(String::as_str).unwrap_or(""))
}

fn cmd_version(p: &Parsed) -> i32 {
    emit(p, crate::version(), json!({"version": crate::version()}));
    0
}

fn cmd_ctl(p: &Parsed) -> i32 {
    let verb = p.rest.first().map(String::as_str).unwrap_or("ping");
    match client::ctl(verb) {
        Some(r) => emit(p, r.clone(), json!({"reply": r})),
        None => return no_daemon(p),
    }
    0
}

fn no_daemon(p: &Parsed) -> i32 {
    let msg = defaults::text("msg.cli_no_daemon");
    if p.json {
        println!("{}", json!({"error": msg, "running": false}));
    } else {
        eprintln!("{msg}");
    }
    1
}

fn cmd_stop(p: &Parsed) -> i32 {
    match client::ctl("stop") {
        Some(r) => emit(p, r.clone(), json!({"reply": r})),
        None => return no_daemon(p),
    }
    0
}

fn cmd_reset(p: &Parsed) -> i32 {
    health::reset();
    emit(p, "ok".into(), json!({"reset": true}));
    0
}

fn cmd_proj(p: &Parsed) -> i32 {
    let arg = |i: usize| p.rest.get(i).map(String::as_str).unwrap_or("");
    match client::proj(arg(0), arg(1), &p.rest[2.min(p.rest.len())..].join(" ")) {
        Some(r) => {
            emit(p, r.clone(), json!({"reply": r}));
            0
        }
        None => 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn json_flag_is_accepted_anywhere() {
        for line in ["status --json", "--json status", "metrics --json --check git"] {
            assert!(parse(&a(line)).json, "{line}");
        }
        let p = parse(&a("metrics --json --check git"));
        assert_eq!((p.command.as_str(), p.rest.clone()), ("metrics", a("--check git")));
        assert_eq!(flag(&p, "check"), "git");
    }

    #[test]
    fn every_registered_handler_has_shipped_metadata_and_every_implemented_command_has_a_handler() {
        let infos = commands();
        for (name, _) in handlers() {
            let i = infos.iter().find(|c| c.name == *name).unwrap_or_else(|| panic!("handler {name} has no cmd.{name} entry"));
            assert_eq!(i.status, "implemented", "{name}");
        }
        for i in &infos {
            let has = handlers().iter().any(|(n, _)| *n == i.name);
            assert_eq!(has, i.status == "implemented", "{} is {} but handler presence is {has}", i.name, i.status);
            assert!(!i.doc.is_empty());
        }
    }

    #[test]
    fn read_only_commands_are_exactly_the_ones_that_never_change_state() {
        let ro: Vec<String> = commands().into_iter().filter(|c| c.read_only).map(|c| c.name).collect();
        for n in ["status", "metrics", "impact", "docs", "check", "version"] {
            assert!(ro.contains(&n.to_string()), "{n} must be read-only");
        }
        for n in ["serve", "hook", "stop", "reset", "proj", "ctl"] {
            assert!(!ro.contains(&n.to_string()), "{n} changes state");
        }
    }

    #[test]
    fn human_rendering_indents_nested_objects() {
        let v = json!({"a": 1, "b": {"c": "x", "d": [1, 2]}});
        let h = human(&v);
        assert!(h.contains("a: 1") && h.contains("b:\n  c: x") && h.contains("d: 1, 2"), "{h}");
    }
}
