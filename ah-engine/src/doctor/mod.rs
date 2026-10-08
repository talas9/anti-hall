//! `ah-engine doctor [--check] [--repair|--fix] [--dry-run] [--migrations-only] [--quiet] [--json]` (D81): the health check and
//! repair of anti-hall, as the Node doctor (`hooks/doctor.js`) does it, from the engine.
//!
//! Plain `doctor` and `--check` are read-only. `--repair` (alias `--fix`) runs the safe repairs after the diagnostics and
//! `--dry-run` previews them (see [`crate::migrate`]); `--migrations-only` with either prints only the machine-readable report
//! of the stamped migrations and sweeps, the form the repair-on-reload pass uses. The report has the Node doctor's layout and,
//! for every check the engine also makes, its exact finding text, so the two read side by side.
//!
//! What it checks: the platform and versions, that the hook scripts the registry names are on disk, the live behaviour of the
//! guards (each built-in check is run in-process on a crafted payload and must block or allow as the Node guard does; a payload
//! the engine defers to its Node hook is reported as such, never as a pass), the statusline configuration, the saved Workflow
//! templates, and the repair pass.
//!
//! What it does not do yet: the checks of the Node doctor that spawn or inspect other programs (the statusline render, the
//! context-footprint measurement, the DevSwarm supervisor, the OMC and Codex detection, the ingest daemon units, the foreign
//! plugin conflict scan, the leaked-store reports) and its explicit opt-in flags (`--prune-cache`, `--reclaim-ingest-lock`,
//! `--repair-*`, `--logs`). Each such flag is reported when given; the Node doctor stays in place for them.
mod selftest;

use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::text::slice16_lossy;
use crate::cli::Parsed;
use crate::defaults;
use crate::migrate;
use std::path::{Path, PathBuf};

/// How serious a finding is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    /// A passing check.
    Ok,
    /// A failing check; drives the exit code.
    Bad,
    /// A warning.
    Warn,
    /// A neutral note that touches no count.
    Info,
}

/// The findings of a run, in report order.
#[derive(Debug, Default)]
pub struct Doc {
    sections: Vec<(String, Vec<(Level, String)>)>,
    /// Passing checks.
    pub pass: u64,
    /// Failing checks.
    pub fail: u64,
    /// Warnings.
    pub warn: u64,
}

impl Doc {
    fn head(&mut self, title: &str) {
        self.sections.push((title.to_string(), Vec::new()));
    }

    fn push(&mut self, level: Level, msg: String) {
        if self.sections.is_empty() {
            self.sections.push((String::new(), Vec::new()));
        }
        match level {
            Level::Ok => self.pass += 1,
            Level::Bad => self.fail += 1,
            Level::Warn => self.warn += 1,
            Level::Info => {}
        }
        if let Some(s) = self.sections.last_mut() {
            s.1.push((level, msg));
        }
    }

    fn ok(&mut self, msg: String) {
        self.push(Level::Ok, msg);
    }

    fn bad(&mut self, msg: String) {
        self.push(Level::Bad, msg);
    }

    fn warnl(&mut self, msg: String) {
        self.push(Level::Warn, msg);
    }

    fn infol(&mut self, msg: String) {
        self.push(Level::Info, msg);
    }

    /// The report text between the title and the verdict: each section is a blank line and its heading, then its findings.
    fn body(&self) -> String {
        let mut lines: Vec<String> = Vec::new();
        for (title, items) in &self.sections {
            lines.push(format!("\n{title}"));
            for (level, msg) in items {
                let mark = match level {
                    Level::Ok => defaults::text("doctor_msg.row_ok"),
                    Level::Bad => defaults::text("doctor_msg.row_bad"),
                    Level::Warn => defaults::text("doctor_msg.row_warn"),
                    Level::Info => defaults::text("doctor_msg.row_prefix_info"),
                };
                lines.push(format!("  {mark} {msg}"));
            }
        }
        lines.join("\n")
    }

    /// The one-line verdict.
    fn verdict(&self) -> String {
        if self.fail == 0 {
            let mut v = defaults::render("doctor_msg.verdict_ok", &[("pass", &self.pass)]);
            if self.warn > 0 {
                v.push_str(&defaults::render("doctor_msg.verdict_warn", &[("warn", &self.warn)]));
            }
            v
        } else {
            defaults::render("doctor_msg.verdict_fail", &[("fail", &self.fail), ("pass", &self.pass), ("warn", &self.warn)])
        }
    }

    /// The report as JSON: `{ok, version, pass, fail, warn, sections: [{title, findings: [{level, msg}]}]}`.
    fn to_json(&self, version: &str) -> J {
        let level = |l: &Level| match l {
            Level::Ok => "ok",
            Level::Bad => "bad",
            Level::Warn => "warn",
            Level::Info => "info",
        };
        let sections = self
            .sections
            .iter()
            .map(|(t, items)| {
                let findings = items.iter().map(|(l, m)| J::Obj(vec![("level".into(), J::Str(level(l).into())), ("msg".into(), J::Str(m.clone()))])).collect();
                J::Obj(vec![("title".into(), J::Str(t.clone())), ("findings".into(), J::Arr(findings))])
            })
            .collect();
        J::Obj(vec![
            ("ok".into(), J::Bool(self.fail == 0)),
            ("version".into(), J::Str(version.into())),
            ("pass".into(), J::Num(self.pass as f64)),
            ("fail".into(), J::Num(self.fail as f64)),
            ("warn".into(), J::Num(self.warn as f64)),
            ("sections".into(), J::Arr(sections)),
        ])
    }
}

/// What a run was asked to do.
struct Flags {
    check: bool,
    dry_run: bool,
    repair: bool,
    migrations_only: bool,
    quiet: bool,
}

fn flags(p: &Parsed) -> Flags {
    let has = |n: &str| p.rest.iter().any(|a| a == n);
    Flags {
        check: has("--check"),
        dry_run: has("--dry-run"),
        repair: has("--repair") || has("--fix"),
        migrations_only: has("--migrations-only"),
        quiet: has("--quiet"),
    }
}

/// `process.platform` and `process.arch` as Node names them.
fn node_platform() -> (&'static str, &'static str) {
    let names = defaults::raw("doctor.platform_names");
    let pick = |rust: &'static str| match names.str_field(rust) {
        "" => rust,
        node => node,
    };
    (pick(std::env::consts::OS), pick(std::env::consts::ARCH))
}

/// The plugin root: the flag, else the engine's variable, else the host's.
fn plugin_root(p: &Parsed, env: &std::collections::BTreeMap<String, String>) -> Option<String> {
    let flag = p.rest.iter().position(|a| a == "--plugin-root").and_then(|i| p.rest.get(i + 1)).cloned();
    flag.or_else(|| env.get(defaults::env_name("plugin_root")).cloned())
        .or_else(|| defaults::list("doctor.plugin_root_envs").iter().find_map(|k| env.get(*k).cloned()))
        .filter(|r| !r.is_empty())
}

fn hooks_section(doc: &mut Doc, root: &Path) {
    doc.head(defaults::text("doctor_msg.head_hooks"));
    let hooks = root.join(defaults::text("doctor.hooks_dir"));
    let read = |name: &str| -> Result<J, String> {
        let path = hooks.join(name);
        let text = migrate::read_text(&path).map_err(|e| migrate::node_err(&e, "open", &path))?;
        migrate::parse_json(&text).ok_or_else(|| defaults::render("doctor_msg.not_json", &[("file", &name)]))
    };
    let parsed = read(defaults::text("doctor.hooks_json")).and_then(|_| read(defaults::text("doctor.hooks_registry")));
    let registry = match parsed {
        Ok(r) => r,
        Err(e) => {
            doc.bad(defaults::render("doctor_msg.hooks_invalid", &[("error", &e)]));
            return;
        }
    };
    let re = crate::checks::lit_re(defaults::text("doctor.script_re"));
    let text = json::stringify(&registry);
    let mut scripts: Vec<String> = Vec::new();
    for m in re.find_iter(&text) {
        if !scripts.iter().any(|s| s == m.as_str()) {
            scripts.push(m.as_str().to_string());
        }
    }
    doc.ok(defaults::render("doctor_msg.hooks_valid", &[("n", &scripts.len())]));
    for f in scripts {
        if hooks.join(&f).exists() {
            doc.ok(defaults::render("doctor_msg.hook_present", &[("file", &f)]));
        } else {
            doc.bad(defaults::render("doctor_msg.hook_missing", &[("file", &f)]));
        }
    }
}

fn statusline_section(doc: &mut Doc, ctx: &migrate::Ctx, home: &str, cwd: &str) {
    doc.head(defaults::text("doctor_msg.head_statusline"));
    for scope in defaults::raw("doctor.statusline_scopes").as_array().unwrap_or_default() {
        let base = if scope.get("home").and_then(defaults::V::as_bool).unwrap_or(false) { home } else { cwd };
        let file = Path::new(base).join(scope.str_field("file"));
        let Some(settings) = migrate::read_json_note(ctx, &file) else { continue };
        let Some(J::Str(cmd)) = settings.get("statusLine").and_then(|s| s.get("command")).filter(|c| migrate::j_truthy(Some(c))) else { continue };
        let label = scope.str_field("label");
        if cmd.contains(defaults::text("doctor.statusline_marker")) {
            doc.ok(defaults::render("doctor_msg.statusline_installed", &[("label", &label)]));
        } else {
            let shown = slice16_lossy(cmd, defaults::num("doctor.statusline_shown") as usize);
            doc.ok(defaults::render("doctor_msg.statusline_set", &[("label", &label), ("command", &shown)]));
        }
        return;
    }
    doc.warnl(defaults::text("doctor_msg.statusline_none").to_string());
}

fn workflows_section(doc: &mut Doc, ctx: &migrate::Ctx, home: &str, cwd: &str) {
    doc.head(defaults::text("doctor_msg.head_workflows"));
    let patterns: Vec<regex::Regex> = defaults::list("doctor.workflow_patterns").iter().map(|p| crate::checks::lit_re(p)).collect();
    let rel = defaults::text("doctor.workflow_dir");
    let mut found: Vec<String> = Vec::new();
    for base in [home, cwd] {
        let dir: PathBuf = Path::new(base).join(rel);
        let names = match migrate::read_dir_sorted(&dir) {
            Ok(n) => n,
            Err(e) => {
                ctx.io_note("scandir", &dir, &e);
                Vec::new()
            }
        };
        for name in names {
            if patterns.iter().any(|re| re.is_match(&name)) {
                found.push(dir.join(&name).to_string_lossy().into_owned());
            }
        }
    }
    if found.is_empty() {
        doc.warnl(defaults::text("doctor_msg.workflow_missing").to_string());
    } else {
        doc.ok(defaults::render("doctor_msg.workflow_found", &[("files", &found.join(", "))]));
    }
}

fn engine_section(doc: &mut Doc) {
    doc.head(defaults::text("doctor_msg.head_engine"));
    doc.ok(defaults::render("doctor_msg.engine_version", &[("version", &crate::version())]));
    match crate::client::ctl("ping") {
        Some(reply) => doc.ok(defaults::render("doctor_msg.daemon_up", &[("reply", &js_trim(&reply))])),
        None => doc.infol(defaults::text("doctor_msg.daemon_down").to_string()),
    }
}

fn repair_section(doc: &mut Doc, ctx: &migrate::Ctx, f: &Flags) {
    doc.head(defaults::text(if f.dry_run { "doctor_msg.repair_heading_dry" } else { "doctor_msg.repair_heading" }));
    let rows = migrate::run(ctx);
    crate::telemetry::emit::add_items(rows.iter().filter(|r| r.status == "fixed").count() as u64);
    if rows.is_empty() && doc.fail == 0 {
        doc.infol(defaults::text("doctor_msg.repair_none").to_string());
    }
    for r in &rows {
        let args: &[(&str, &dyn std::fmt::Display)] = &[("id", &r.id), ("msg", &r.msg)];
        match r.status.as_str() {
            "fixed" => doc.ok(defaults::render("doctor_msg.repair_fixed", args)),
            "failed" => doc.bad(defaults::render("doctor_msg.repair_failed", args)),
            "gated" => doc.warnl(defaults::render("doctor_msg.repair_gated", args)),
            _ => doc.infol(defaults::render("doctor_msg.repair_skipped", args)),
        }
    }
}

/// The `doctor` command.
pub fn run_doctor(p: &Parsed) -> i32 {
    let f = flags(p);
    let do_repair = (f.repair || f.dry_run) && !f.check;
    if f.migrations_only && do_repair {
        let forwarded = Parsed { command: "migrate".into(), json: true, rest: p.rest.clone(), raw: p.rest.clone() };
        return migrate::cli::run_migrate(&forwarded);
    }
    let (ctx, _) = match migrate::cli::context(p) {
        Ok(c) => c,
        Err(e) => {
            if p.json {
                println!("{}", json::stringify(&J::Obj(vec![("error".into(), J::Str(e))])));
            } else {
                eprintln!("{e}");
            }
            return 1;
        }
    };
    let root = plugin_root(p, &ctx.env);
    let version = ctx.version.clone().unwrap_or_else(|| defaults::text("doctor_msg.unknown_version").to_string());
    let mut doc = Doc::default();

    doc.head(defaults::text("doctor_msg.head_environment"));
    let (platform, arch) = node_platform();
    doc.ok(defaults::render("doctor_msg.platform", &[("platform", &platform), ("arch", &arch)]));
    if root.is_some() {
        doc.ok(defaults::render("doctor_msg.plugin_version", &[("version", &version)]));
    } else {
        doc.warnl(defaults::text("doctor_msg.no_plugin_root").to_string());
    }
    engine_section(&mut doc);
    for flag in defaults::list("doctor.unhandled_flags") {
        if p.rest.iter().any(|a| a == flag) {
            if doc.sections.last().is_none_or(|s| s.0 != defaults::text("doctor_msg.head_unhandled")) {
                doc.head(defaults::text("doctor_msg.head_unhandled"));
            }
            doc.warnl(defaults::render("doctor_msg.unhandled_flag", &[("flag", &flag)]));
        }
    }
    if let Some(r) = root.as_deref() {
        hooks_section(&mut doc, Path::new(r));
    }
    doc.head(defaults::text("doctor_msg.head_guards"));
    selftest::run(&mut doc, &ctx, root.as_deref(), &version);
    statusline_section(&mut doc, &ctx, &ctx.home, &ctx.cwd);
    workflows_section(&mut doc, &ctx, &ctx.home, &ctx.cwd);
    if do_repair {
        repair_section(&mut doc, &ctx, &f);
    } else if !f.check {
        doc.head(defaults::text("doctor_msg.repair_heading"));
        doc.infol(defaults::text("doctor_msg.repair_read_only").to_string());
    }

    for n in ctx.take_notes() {
        eprintln!("{}", defaults::render("migrate_msg.note_line", &[("note", &n)]));
    }
    let verdict = doc.verdict();
    if p.json {
        println!("{}", json::stringify(&doc.to_json(&version)));
    } else {
        if !f.quiet {
            println!("{}", defaults::render("doctor_msg.title", &[("version", &version)]));
            println!("{}\n", doc.body());
        }
        println!("{verdict}");
    }
    i32::from(doc.fail != 0)
}
