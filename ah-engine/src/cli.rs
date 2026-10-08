//! The command line (D50, D53): one registry of commands, every one accepting `--json`.
//!
//! Why a registry: the generated reference, the usage text and the future command-guard allowlist all need the list of
//! commands and whether each one changes state. The data (summary, arguments, `read_only`, status) is in
//! `defaults/commands.toml`; the handlers are here. A test keeps the two in step, so a command cannot exist without
//! documentation or be documented without existing.
use crate::{client, daemon, defaults, docs, health};
use serde_json::{Value, json};

/// A parsed command line: the command, whether `--json` was given, and the remaining arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// The command word (empty when none was given).
    pub command: String,
    /// `--json` was present anywhere.
    pub json: bool,
    /// Everything after the command except `--json`.
    pub rest: Vec<String>,
    /// Everything after the command exactly as typed, `--json` included and in place (the operator commands read their own flag grammar).
    pub raw: Vec<String>,
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
    /// For a command that changes state only in some forms: the first arguments (`""` = none) whose runs are read-only.
    pub read_only_args: Vec<String>,
    /// For a command that changes state only in some forms: the flags whose presence makes a run read-only (`mesh ... --db`).
    pub read_only_flags: Vec<String>,
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
        ("telemetry", cmd_telemetry),
        ("docs", cmd_docs),
        ("check", cmd_check),
        ("gen-hooks", cmd_gen_hooks),
        ("version", cmd_version),
        ("ctl", cmd_ctl),
        ("stop", cmd_stop),
        ("reset", cmd_reset),
        ("proj", cmd_proj),
        ("maintain", cmd_maintain),
        ("backup", cmd_backup),
        ("restore", cmd_restore),
        ("config", cmd_config),
        ("schedule", cmd_schedule),
        ("agents", crate::agents::run_cmd),
        ("agent_tick", cmd_agent_tick),
        ("jev", crate::jev::cli::run_cmd),
        ("jev_sweep", cmd_jev_sweep),
        ("gh", crate::ghrt::run_cmd),
        ("gh_poll", crate::ghrt::run_poll),
        ("migrate", crate::migrate::cli::run_migrate),
        ("doctor", crate::doctor::run_doctor),
        ("jev-setup", crate::setup::cmd_jev_setup),
        ("capability-scan", crate::setup::cmd_capability_scan),
        ("harvest", crate::setup::cmd_harvest),
        ("briefing", crate::setup::cmd_briefing),
        ("mesh", crate::mesh::run_cmd),
        ("settings", crate::ops::cmd_settings),
        ("defect", crate::ops::cmd_defect),
        ("statusline", crate::ops::cmd_statusline),
        ("phase", crate::ops::cmd_phase),
        ("install-statusline", crate::ops::cmd_install_statusline),
        ("uninstall-statusline", crate::ops::cmd_uninstall_statusline),
        ("shadow-compare", crate::ops::cmd_shadow_compare),
        ("update", crate::operator::update::run),
        ("install-codex", crate::operator::install_codex::run),
        ("handovers", crate::handovers::run_cmd),
    ]
}

/// Every command in the shipped registry data, in file order.
pub fn commands() -> Vec<CommandInfo> {
    defaults::with_prefix("cmd.")
        .iter()
        .map(|e| CommandInfo {
            name: e.key["cmd.".len()..].to_string(),
            args: e.value.str_field("args").to_string(),
            read_only: e.value.get("read_only").and_then(defaults::V::as_bool).unwrap_or(false),
            read_only_args: e.value.get("read_only_args").map(|v| v.strings().into_iter().map(str::to_string).collect()).unwrap_or_default(),
            read_only_flags: e.value.get("read_only_flags").map(|v| v.strings().into_iter().map(str::to_string).collect()).unwrap_or_default(),
            status: e.value.str_field("status").to_string(),
            doc: e.doc.to_string(),
        })
        .collect()
}

/// Split `--json` out of the arguments (after the program name).
pub fn parse(args: &[String]) -> Parsed {
    let json = args.iter().any(|a| a == "--json");
    let mut rest: Vec<String> = args.iter().filter(|a| *a != "--json").cloned().collect();
    let command = if rest.is_empty() { String::new() } else { rest.remove(0) };
    let raw = args.iter().position(|a| a != "--json").map(|i| args[i + 1..].to_vec()).unwrap_or_default();
    Parsed { command, json, rest, raw }
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
    // the registry itself is a shipped table, so the defaults are loaded first. The thin hook client reads the daemon's snapshot
    // cache (parsing the plugin's files per call would double its start-up, D17); everything else reads the files.
    let hook = p.command == "hook";
    // the version is a build fact, not a setting: it answers before (and without) any defaults, so a smoke test needs no plugin root
    if p.command == "version" {
        defaults::use_cache();
        let v = if defaults::init().is_ok() { crate::version() } else { env!("CARGO_PKG_VERSION").to_string() };
        emit(&p, v.clone(), json!({"version": v}));
        return 0;
    }
    // an explicit `--plugin-root <dir>` decides which plugin's files are read, before anything is loaded
    if let Some(root) = p.rest.iter().position(|a| a == "--plugin-root").and_then(|i| p.rest.get(i + 1)).filter(|r| !r.is_empty()) {
        crate::bootstrap::set_root_flag(std::path::PathBuf::from(root));
    }
    // commands that only talk to the daemon or print a version need a few settings, not the docs of all of them
    // the status line runs after every turn: like the hook client it reads the snapshot cache instead of parsing every file
    let statusline = p.command == "statusline";
    if hook || statusline || ["version", "status", "ping", "ctl", "stop"].contains(&p.command.as_str()) {
        defaults::use_cache();
    }
    if hook || statusline || p.command == "serve" {
        defaults::write_cache_on_load();
    }
    if let Err(e) = defaults::init() {
        if p.command == "doctor" {
            // the doctor must still diagnose a plugin whose defaults cannot load; it writes nothing and hands over to the shell doctor
            return crate::doctor::degraded(&p, &e.to_string());
        }
        defaults::report_unavailable(&e);
        if p.command == "serve" {
            defaults::log_start_failure(&e);
        }
        // nothing can be answered without settings: a hook defers to Node through the wrapper, anything else is a plain failure
        return if hook { crate::bootstrap::UNAVAILABLE_EXIT } else { 70 };
    }
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
    // role gate (owner feature 22): the hook path is every role's plumbing and stays out of it
    if !hook && let Err((code, msg)) = crate::roles::gate(&p.command, &p.rest) {
        if p.json {
            println!("{}", json!({"error": msg}));
        } else {
            eprintln!("{msg}");
        }
        return code;
    }
    // a read-only command (or form) writes nothing, not even the telemetry its in-process checks would leave in the state directory
    let first = p.rest.iter().find(|a| !a.starts_with("--")).map_or("", String::as_str);
    if info.read_only || info.read_only_args.iter().any(|a| a == first) || info.read_only_flags.iter().any(|f| p.rest.iter().any(|a| a == f)) {
        crate::telemetry::emit::set_read_only();
    }
    match handlers().iter().find(|(n, _)| *n == p.command) {
        Some((_, h)) => run_recorded(&p, *h),
        None => 70, // registered as implemented but has no handler: the registry test prevents this
    }
}

/// True when `telemetry.cmd_record` lists this run: the command word alone, or `command:arg|arg` when one of those arguments is present.
fn recorded(p: &Parsed) -> bool {
    defaults::list("telemetry.cmd_record").iter().any(|rule| match rule.split_once(':') {
        None => *rule == p.command,
        Some((cmd, args)) => cmd == p.command && args.split('|').any(|a| p.rest.iter().any(|r| r == a)),
    })
}

/// Run a handler; a state-writing command listed in `telemetry.cmd_record` leaves one `cmd` event: command, duration,
/// outcome and the items it reported changing.
fn run_recorded(p: &Parsed, h: Handler) -> i32 {
    if !recorded(p) {
        return h(p);
    }
    crate::telemetry::emit::take_items();
    let started = std::time::Instant::now();
    let code = h(p);
    let sub = p.rest.first().filter(|a| !a.starts_with("--")).map_or("", String::as_str);
    let items = crate::telemetry::emit::take_items();
    crate::telemetry::emit::event(crate::telemetry::emit::command_run(&p.command, sub, code, started.elapsed().as_micros() as u64, items));
    code
}

fn cmd_serve(_: &Parsed) -> i32 {
    daemon::serve();
    0
}

fn cmd_hook(p: &Parsed) -> i32 {
    if crate::dispatch::requested(&p.rest) {
        return crate::dispatch::hook_main(&p.rest);
    }
    client::hook_main(&p.rest)
}

fn cmd_status(p: &Parsed) -> i32 {
    let v = client::status_value();
    // `--memory`: just the memory breakdown (live heap against RSS, and the size of every long-lived in-memory structure)
    let v = if p.rest.iter().any(|a| a == "--memory") {
        json!({"running": v["running"], "rss_peak_kb": v["rss_peak_kb"], "rss_cap_kb": v["rss_cap_kb"], "memory": v["memory"]})
    } else {
        v
    };
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
    let mut verb = "metrics".to_string();
    for name in ["check", "rollup", "since"] {
        let v = flag(p, name);
        if !v.is_empty() {
            verb.push_str(&format!(" {name}={v}"));
        }
    }
    report(p, &verb)
}

fn cmd_impact(p: &Parsed) -> i32 {
    let mut verb = "impact".to_string();
    for name in ["kind", "project", "recent", "window"] {
        let v = flag(p, name);
        if !v.is_empty() {
            verb.push_str(&format!(" {name}={v}"));
        }
    }
    report(p, &verb)
}

fn cmd_telemetry(p: &Parsed) -> i32 {
    let (v, code) = crate::telemetry::cli::run(&p.rest);
    emit(p, human(&v), v);
    code
}

fn cmd_docs(p: &Parsed) -> i32 {
    let fmt = flag(p, "format");
    if p.json {
        println!("{}", docs::json());
    } else if fmt.is_empty() || fmt == "md" {
        print!("{}", docs::markdown());
    } else if fmt == "skill" || fmt == "skill-list" {
        // the generated engine skill family (owner feature 22): `skill-list` prints `<path>` per file, `skill --name <n>` one file
        let host = Some(flag(p, "host")).filter(|h| !h.is_empty()).unwrap_or_else(|| defaults::text("dispatch.default_host").to_string());
        let family = crate::skillgen::family(&host);
        if fmt == "skill-list" {
            for s in &family {
                println!("{}", s.path);
            }
        } else if let Some(s) = crate::skillgen::find(&host, &flag(p, "name")) {
            print!("{}", s.text);
        } else {
            eprintln!("{}", defaults::render("msg.cli_unknown", &[("command", &format!("--name {}", flag(p, "name")))]));
            return 64;
        }
    } else {
        eprintln!("{}", defaults::render("msg.cli_unknown", &[("command", &format!("--format {fmt}"))]));
        return 64;
    }
    0
}

fn cmd_check(p: &Parsed) -> i32 {
    crate::checks::cli_main(p.rest.first().map(String::as_str).unwrap_or(""))
}

fn cmd_gen_hooks(p: &Parsed) -> i32 {
    let host = Some(flag(p, "host")).filter(|h| !h.is_empty()).unwrap_or_else(|| defaults::text("dispatch.default_host").to_string());
    let kind = Some(flag(p, "kind")).filter(|k| !k.is_empty()).unwrap_or_else(|| defaults::text("dispatch.gen_default_kind").to_string());
    if !crate::dispatch::table::hosts().contains(&host.as_str()) {
        let msg = defaults::render("dispatch.msg_unknown_host", &[("host", &host), ("hosts", &crate::dispatch::table::hosts().join(", "))]);
        emit(p, msg.clone(), json!({"error": msg}));
        return 64;
    }
    match crate::hooksgen::render(&host, &kind) {
        Some(text) => {
            print!("{text}");
            0
        }
        None => {
            let msg = defaults::render("dispatch.msg_unknown_kind", &[("kind", &kind)]);
            emit(p, msg.clone(), json!({"error": msg}));
            64
        }
    }
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

fn cmd_maintain(p: &Parsed) -> i32 {
    let dir = crate::paths::dir();
    let res = crate::limits::ensure_private_dir(&dir).map_err(|e| e.to_string()).and_then(|_| crate::maintain::run(&dir).map_err(|e| e.to_string()));
    report_result(p, res)
}

fn cmd_schedule(p: &Parsed) -> i32 {
    let sub = p.rest.first().map(String::as_str).unwrap_or("list");
    let verb = match sub {
        "run" => match p.rest.get(1).filter(|j| !j.starts_with("--")) {
            Some(job) => format!("schedule run job={job}"),
            None => return report_result(p, Err(defaults::render("msg.cli_usage", &[("commands", &defaults::text("msg.cli_usage_schedule_run"))]))),
        },
        "history" => {
            let mut v = "schedule history".to_string();
            for name in ["job", "limit"] {
                let x = flag(p, name);
                if !x.is_empty() {
                    v.push_str(&format!(" {name}={x}"));
                }
            }
            v
        }
        "list" => "schedule list".to_string(),
        other => return report_result(p, Err(defaults::render("msg.cli_unknown", &[("command", &format!("schedule {other}"))]))),
    };
    if let Some(v) = client::ctl_json(&verb) {
        return report_result(p, Ok(v));
    }
    // no daemon: list and history come straight from the files; a run needs the daemon
    match sub {
        "run" => no_daemon(p),
        "history" => {
            let limit = flag(p, "limit").parse().unwrap_or(defaults::num("schedule.history_default") as usize);
            let hot = crate::paths::dir().join(defaults::text("storage.hot_file"));
            let runs = rusqlite::Connection::open_with_flags(&hot, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .ok()
                .and_then(|c| crate::schedule::history(&c, &flag(p, "job"), limit).ok())
                .unwrap_or_default();
            report_result(p, Ok(json!({"running": false, "runs": runs})))
        }
        _ => {
            use crate::schedule::ScheduleSource;
            let jobs: Vec<Value> = crate::schedule::FileSource::standard(false)
                .jobs()
                .iter()
                .map(|j| json!({"name": j.name, "kind": j.kind, "action": j.action, "every_ms": j.every_ms, "persist": j.persist}))
                .collect();
            report_result(p, Ok(json!({"running": false, "jobs": jobs})))
        }
    }
}

fn cmd_backup(p: &Parsed) -> i32 {
    let to = flag(p, "to");
    let to = (!to.is_empty()).then(|| std::path::PathBuf::from(to));
    report_result(p, crate::backup::backup(&crate::paths::dir(), to.as_deref()).map_err(|e| e.to_string()))
}

fn cmd_restore(p: &Parsed) -> i32 {
    let Some(from) = p.rest.first() else {
        return report_result(p, Err(defaults::render("msg.cli_usage", &[("commands", &defaults::text("msg.cli_usage_restore"))])));
    };
    report_result(p, crate::backup::restore(&crate::paths::dir(), std::path::Path::new(from)).map_err(|e| e.to_string()))
}

/// Print a command's JSON report (or human text), or its error; exit 0 or 1.
fn report_result(p: &Parsed, res: Result<Value, String>) -> i32 {
    match res {
        Ok(v) => {
            emit(p, human(&v), v);
            0
        }
        Err(e) => {
            if p.json {
                println!("{}", json!({"error": e}));
            } else {
                eprintln!("{e}");
            }
            1
        }
    }
}

fn cmd_proj(p: &Parsed) -> i32 {
    let arg = |i: usize| p.rest.get(i).map(String::as_str).unwrap_or("");
    let session = defaults::env_var("session").unwrap_or_else(|| "-".to_string());
    match crate::spool::write(arg(0), arg(1), &p.rest[2.min(p.rest.len())..].join(" "), &session) {
        crate::spool::Outcome::Answered(r) => {
            emit(p, r.clone(), json!({"reply": r}));
            0
        }
        crate::spool::Outcome::Spooled(id) => {
            emit(p, defaults::render("msg.spool_spooled", &[("id", &id)]), json!({"spooled": true, "write_id": id}));
            0
        }
        crate::spool::Outcome::Refused(why) | crate::spool::Outcome::Failed(why) => {
            if p.json {
                println!("{}", json!({"error": why}));
            } else {
                eprintln!("{why}");
            }
            1
        }
    }
}

/// `config [--json]`: the effective config and where each value comes from (the running daemon's active version when
/// one is up, else what a fresh start would load from the files); `config validate <file>`: check a user TOML file.
fn cmd_config(p: &Parsed) -> i32 {
    match p.rest.first().map(String::as_str) {
        None => {
            let mut v = client::ctl_json("config").map(|mut v| {
                v["from"] = json!("daemon");
                v
            });
            if v.is_none() {
                let mut f = crate::cfgstore::report_from_files();
                f["from"] = json!("files");
                v = Some(f);
            }
            let v = v.unwrap_or(Value::Null);
            emit(p, config_text(&v), v);
            0
        }
        Some("validate") => match p.rest.get(1) {
            None => {
                let msg = defaults::text("msg.cfg_validate_usage");
                emit(p, msg.to_string(), json!({"error": msg}));
                64
            }
            Some(file) => match crate::cfgstore::validate_file(std::path::Path::new(file)) {
                Ok(n) => {
                    let msg = defaults::render("msg.cfg_valid", &[("path", file), ("count", &n)]);
                    emit(p, msg.clone(), json!({"valid": true, "path": file, "settings": n}));
                    0
                }
                Err(e) => {
                    let msg = defaults::render("msg.cfg_invalid_cli", &[("err", &e)]);
                    emit(p, msg.clone(), json!({"valid": false, "path": file, "code": e.code(), "error": e.to_string()}));
                    1
                }
            },
        },
        Some("heal") => {
            // explicit: writes the missing settings even into a version-controlled checkout (the automatic heal never does)
            let Some(root) = defaults::root() else { return 70 };
            let report = match defaults::load_from(&root, crate::bootstrap::lkg_dir().as_deref(), None) {
                Ok(d) => d.report().clone(),
                Err(e) => {
                    let msg = e.to_string();
                    emit(p, msg.clone(), json!({"error": msg}));
                    return 1;
                }
            };
            let done = defaults::heal(&root, &report, true);
            crate::telemetry::emit::add_items(done.len() as u64);
            if done.is_empty() {
                let msg = defaults::text("defaults_load.msg_heal_none");
                emit(p, msg.to_string(), json!({"healed": []}));
                return 0;
            }
            let mut lines = Vec::new();
            let mut failed = false;
            for h in &done {
                let (kind, code, detail) = defaults::heal_line(h);
                crate::health::log_event(kind, code, &detail);
                failed |= matches!(h, defaults::Healed::Failed { .. });
                lines.push(detail);
            }
            emit(p, lines.join("\n"), json!({"healed": lines, "failed": failed}));
            i32::from(failed)
        }
        Some(other) => {
            // versions, rollback, export: planned with the config database
            let decision = defaults::raw("cmd.config").str_field("planned_decision");
            let msg = defaults::render("msg.cli_planned", &[("command", &format!("{} {other}", p.command)), ("decision", &decision)]);
            emit(p, msg.clone(), json!({"error": msg, "planned": decision}));
            64
        }
    }
}

/// Human rendering of a config report: where it came from, the files, then one line per setting with its source.
fn config_text(v: &Value) -> String {
    let mut out = vec![defaults::render("msg.cfg_show_header", &[("version", &v["version"]), ("from", &v["from"].as_str().unwrap_or(""))])];
    for f in v["files"].as_array().into_iter().flatten() {
        let state = defaults::text(if f["present"].as_bool().unwrap_or(false) { "msg.cfg_state_present" } else { "msg.cfg_state_absent" });
        out.push(defaults::render(
            "msg.cfg_show_file",
            &[("kind", &f["kind"].as_str().unwrap_or("")), ("path", &f["path"].as_str().unwrap_or("")), ("state", &state)],
        ));
    }
    if let Some(e) = v["last_error"].as_str() {
        out.push(defaults::render("msg.cfg_show_error", &[("err", &e)]));
    }
    if let Some(p) = v["pending_restart"].as_array().filter(|p| !p.is_empty()) {
        out.push(defaults::render("msg.cfg_show_pending", &[("keys", &p.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))]));
    }
    for (k, s) in v["settings"].as_object().into_iter().flatten() {
        out.push(defaults::render("msg.cfg_show_setting", &[("key", k), ("value", &s["value"]), ("source", &s["source"].as_str().unwrap_or(""))]));
    }
    out.join("\n")
}

/// The `jev_sweep` scheduled job (`ah-engine jev_sweep --json`): one evidence sweep of the supervisor's Jev questions.
fn cmd_jev_sweep(_p: &Parsed) -> i32 {
    match defaults::env_var("home") {
        Some(h) => crate::jev::sweep::run(std::path::Path::new(&h)),
        None => 64,
    }
}

/// The `agent_tick` scheduled job (`ah-engine agent_tick --json`): one tracker tick.
fn cmd_agent_tick(p: &Parsed) -> i32 {
    let verb = defaults::text("agent_tracker.tick_verb").to_string();
    crate::agents::run_cmd(&Parsed { command: p.command.clone(), json: p.json, rest: vec![verb.clone()], raw: vec![verb] })
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
    fn only_state_writing_runs_listed_in_the_settings_are_recorded() {
        for (line, want) in [
            ("migrate --dry-run", true),
            ("mesh roster --db x", true),
            ("jev-setup enable", true),
            ("doctor --repair", true),
            ("doctor --fix", true),
            ("doctor --check", false),
            ("doctor", false),
            ("config heal", true),
            ("config", false),
            ("config validate f.toml", false),
            ("status", false),
        ] {
            assert_eq!(recorded(&parse(&a(line))), want, "{line}");
        }
    }

    #[test]
    fn a_recorded_command_leaves_one_cmd_event_with_its_exit_duration_and_items() {
        use crate::telemetry::{
            emit,
            event::{Extras, Kind, Outcome},
        };
        emit::take_queued();
        let ok = run_recorded(&parse(&a("migrate --dry-run")), |_| {
            emit::add_items(3);
            0
        });
        let bad = run_recorded(&parse(&a("config heal")), |_| 1);
        let quiet = run_recorded(&parse(&a("status")), |_| 0);
        assert_eq!((ok, bad, quiet), (0, 1, 0));
        let evs = emit::take_queued();
        assert_eq!(evs.len(), 2, "status is not recorded: {evs:?}");
        assert_eq!((evs[0].kind, evs[0].h.as_str(), evs[0].e.as_str(), evs[0].o), (Kind::Cmd, "migrate", "-", Outcome::Allow));
        let Extras::Fields(f) = &evs[0].extras else { panic!("fields") };
        assert_eq!((f.get_num("items"), f.get_num("exit")), (Some(3), Some(0)));
        assert_eq!((evs[1].h.as_str(), evs[1].e.as_str(), evs[1].o), ("config", "heal", Outcome::Error));
        let Extras::Fields(f) = &evs[1].extras else { panic!("fields") };
        assert_eq!((f.get_num("items"), f.get_num("exit")), (Some(0), Some(1)), "items do not leak between runs");
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
        for n in ["serve", "hook", "stop", "reset", "proj", "ctl", "maintain", "backup", "restore", "schedule"] {
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
