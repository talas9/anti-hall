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
//! the engine defers to its Node hook is reported as such, never as a pass), the statusline configuration and its render, the
//! saved Workflow templates, oh-my-claudecode and the Codex port when present, other plugins' competing hooks and skills, the
//! DevSwarm supervisor section (its files, the four mechanical hooks, the installed unit), orphaned ingest registrations and
//! leaked test-fixture stores, and the repair pass. The explicit `--repair-ingest-orphans`, `--repair-test-stores` and
//! `--repair-resurrected` flags (preview, `--apply` to act) run after the diagnostics, as in the Node doctor.
//!
//! What it does not do yet: the context-footprint measurement, the DevSwarm runtime checks of an active session (liveness
//! verdicts, app-database view, delivery log, wake monitor; the report says so), the default repair rows that install or reap
//! scheduler units, the leaked-unit and other store reports, and the flags `--prune-cache`, `--reclaim-ingest-lock` and `--logs`
//! (each is reported when given; the Node doctor stays in place for them).
mod detect;
mod devswarm;
mod facts;
mod install;
mod orphans;
mod plugin;
mod render;
mod runtime;
mod selftest;
mod stores;
mod system;

use crate::checks::jsport::json::{self, J};
use crate::checks::jsport::text::slice16_lossy;
use crate::cli::Parsed;
use crate::defaults;
use crate::migrate;
use std::path::{Path, PathBuf};

pub use facts::Host;

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

/// A safe, idempotent repair (never a delete) that `--repair` may apply for a finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Fix {
    /// Set the owner execute bit on the engine binary.
    MakeExecutable(PathBuf),
    /// Remove the macOS quarantine attribute from the verified engine binary.
    Unquarantine(PathBuf),
    /// Create the engine state directory (private).
    Mkdir(PathBuf),
    /// Make the state directory private (mode 0700).
    Private(PathBuf),
    /// Add the settings the edited defaults files lack (from the pristine copy, with a backup).
    Heal,
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
    /// The explicit repair flags given, in the order their sections run.
    explicit: Vec<&'static str>,
    /// `--apply`: the explicit repairs act instead of only previewing.
    apply: bool,
}

fn flags(p: &Parsed) -> Flags {
    let has = |n: &str| p.rest.iter().any(|a| a == n);
    Flags {
        check: has("--check"),
        dry_run: has("--dry-run"),
        repair: has("--repair") || has("--fix"),
        migrations_only: has("--migrations-only"),
        quiet: has("--quiet"),
        explicit: defaults::list("doctor.explicit_flags").into_iter().filter(|f| has(f)).collect(),
        apply: has(defaults::text("doctor.apply_flag")),
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

/// Apply (or, in a dry run, only describe) one safe repair; the row says what was done.
fn apply_fix(fix: &Fix, dry: bool, root: Option<&Path>) -> (&'static str, Result<String, String>) {
    use std::os::unix::fs::PermissionsExt;
    let add_mode = |p: &Path, add: u32| -> std::io::Result<()> {
        let cur = std::fs::metadata(p)?.permissions().mode();
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(cur | add))
    };
    match fix {
        Fix::MakeExecutable(p) => {
            let id = "engine-binary-exec";
            let msg = defaults::render("doctor_msg.fix_exec", &[("path", &p.display())]);
            (id, if dry { Ok(msg) } else { add_mode(p, defaults::num("doctor.owner_exec_bit") as u32).map(|()| msg).map_err(|e| e.to_string()) })
        }
        Fix::Unquarantine(p) => {
            let msg = defaults::render("doctor_msg.fix_quarantine", &[("path", &p.display())]);
            ("engine-binary-quarantine", if dry { Ok(msg) } else { facts::clear_quarantine(p).map(|()| msg).map_err(|e| e.to_string()) })
        }
        Fix::Mkdir(p) => {
            let msg = defaults::render("doctor_msg.fix_mkdir", &[("dir", &p.display())]);
            ("state-dir-create", if dry { Ok(msg) } else { crate::limits::ensure_private_dir(p).map(|()| msg).map_err(|e| e.to_string()) })
        }
        Fix::Private(p) => {
            let msg = defaults::render("doctor_msg.fix_private", &[("dir", &p.display())]);
            ("state-dir-private", if dry { Ok(msg) } else { crate::limits::ensure_private_dir(p).map(|()| msg).map_err(|e| e.to_string()) })
        }
        Fix::Heal => {
            let id = "config-heal";
            let (Some(r), Some(report)) = (root.map(Path::to_path_buf).or_else(defaults::root), defaults::load_report()) else {
                return (id, Err(defaults::text("doctor_msg.fix_heal_nothing").to_string()));
            };
            if dry {
                return (id, Ok(defaults::render("doctor_msg.fix_heal_dry", &[("n", &report.missing.len())])));
            }
            let done = defaults::heal(&r, &report, false);
            let lines: Vec<String> = done.iter().map(|h| defaults::heal_line(h).2).collect();
            let failed = done.iter().any(|h| matches!(h, defaults::Healed::Failed { .. }));
            (id, if failed { Err(lines.join("; ")) } else { Ok(lines.join("; ")) })
        }
    }
}

fn repair_section(doc: &mut Doc, ctx: &migrate::Ctx, f: &Flags, fixes: &[Fix], root: Option<&Path>) {
    doc.head(defaults::text(if f.dry_run { "doctor_msg.repair_heading_dry" } else { "doctor_msg.repair_heading" }));
    let rows = migrate::run(ctx);
    crate::telemetry::emit::add_items(rows.iter().filter(|r| r.status == "fixed").count() as u64);
    let mut done = 0u64;
    let mut seen: Vec<&Fix> = Vec::new();
    for fix in fixes {
        if seen.contains(&fix) {
            continue;
        }
        seen.push(fix);
        let (id, outcome) = apply_fix(fix, f.dry_run, root);
        match outcome {
            Ok(msg) if f.dry_run => doc.infol(defaults::render("doctor_msg.repair_would", &[("id", &id), ("msg", &msg)])),
            Ok(msg) => {
                done += 1;
                doc.ok(defaults::render("doctor_msg.repair_fixed", &[("id", &id), ("msg", &msg)]));
            }
            Err(e) => doc.bad(defaults::render("doctor_msg.repair_failed", &[("id", &id), ("msg", &e)])),
        }
    }
    crate::telemetry::emit::add_items(done);
    if rows.is_empty() && fixes.is_empty() && doc.fail == 0 {
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

/// The sections of the explicit repair flags (`--repair-ingest-orphans`, `--repair-test-stores`, `--repair-resurrected`), each a
/// preview unless `--apply` is given. They run after the diagnostics and end the report, as the Node doctor's do.
fn explicit_sections(doc: &mut Doc, ctx: &migrate::Ctx, f: &Flags) {
    for flag in &f.explicit {
        let (title, rows, retire) = match *flag {
            "--repair-ingest-orphans" => ("doctor_msg.repair_title_orphans", orphans::repair(ctx, f.apply), "doctor_msg.explicit_unloaded"),
            "--repair-test-stores" => ("doctor_msg.repair_title_stores", stores::repair_test_stores(ctx, f.apply), "doctor_msg.explicit_moved"),
            _ => ("doctor_msg.repair_title_resurrected", stores::repair_resurrected(ctx), "doctor_msg.explicit_retired"),
        };
        let mode = defaults::text(if f.apply { "doctor_msg.repair_mode_apply" } else { "doctor_msg.repair_mode_dry" });
        doc.head(&defaults::render("doctor_msg.repair_head_explicit", &[("title", &defaults::text(title)), ("mode", &mode), ("flag", flag)]));
        if rows.is_empty() && doc.fail == 0 {
            doc.infol(defaults::text("doctor_msg.explicit_nothing").to_string());
        }
        for (id, status, msg) in rows {
            let label = format!("[{id}] {msg}");
            match status {
                "fixed" => doc.ok(format!("{}{label}", defaults::text(retire))),
                "failed" => doc.bad(format!("{}{label}", defaults::text("doctor_msg.explicit_failed"))),
                "gated" => doc.warnl(format!("{}{label}", defaults::text("doctor_msg.explicit_gated"))),
                _ => doc.infol(format!("{}{label}", defaults::text("doctor_msg.explicit_skipped"))),
            }
        }
    }
}

/// The `doctor` command.
pub fn run_doctor(p: &Parsed) -> i32 {
    let f = flags(p);
    let do_repair = (f.repair || f.dry_run) && !f.check && f.explicit.is_empty();
    if f.migrations_only && do_repair {
        let forwarded = Parsed { command: "migrate".into(), json: true, rest: p.rest.clone(), raw: p.rest.clone() };
        return migrate::cli::run_migrate(&forwarded);
    }
    if !do_repair {
        // a check reads and reports; the guards it exercises in-process must not leave telemetry (that would create the state directory)
        crate::telemetry::emit::set_read_only();
    }
    let (ctx, _) = match migrate::cli::context(p) {
        Ok(c) => c,
        Err(e) => return no_context(p, &e),
    };
    let root = plugin_root(p, &ctx.env);
    let root_path = root.as_deref().map(Path::new);
    let version = ctx.version.clone().unwrap_or_else(|| defaults::text("doctor_msg.unknown_version").to_string());
    let mut doc = Doc::default();
    let mut fixes: Vec<Fix> = Vec::new();
    let host = Host::detect();
    let uid = crate::limits::uid();

    doc.head(defaults::text("doctor_msg.head_environment"));
    let (platform, arch) = node_platform();
    doc.ok(defaults::render("doctor_msg.platform", &[("platform", &platform), ("arch", &arch)]));
    if root.is_some() {
        doc.ok(defaults::render("doctor_msg.plugin_version", &[("version", &version)]));
    } else {
        doc.warnl(defaults::text("doctor_msg.no_plugin_root").to_string());
    }
    runtime::daemon_section(&mut doc);
    let engine_usable = install::section(&mut doc, &mut fixes, &ctx, root_path, &host);
    runtime::state_section(&mut doc, &mut fixes, uid);
    plugin::config_section(&mut doc, &mut fixes, &ctx);
    plugin::registry_section(&mut doc, &ctx, root_path, &version);
    for flag in defaults::list("doctor.unhandled_flags") {
        if p.rest.iter().any(|a| a == flag) {
            if doc.sections.last().is_none_or(|s| s.0 != defaults::text("doctor_msg.head_unhandled")) {
                doc.head(defaults::text("doctor_msg.head_unhandled"));
            }
            doc.warnl(defaults::render("doctor_msg.unhandled_flag", &[("flag", &flag)]));
        }
    }
    if let Some(r) = root_path {
        hooks_section(&mut doc, r);
        plugin::thin_section(&mut doc, r);
    }
    system::environment_section(&mut doc, &ctx, engine_usable, uid);
    system::claude_section(&mut doc, &ctx);
    system::logs_section(&mut doc);
    system::witness_section(&mut doc, &ctx);
    doc.head(defaults::text("doctor_msg.head_guards"));
    selftest::run(&mut doc, &ctx, root.as_deref(), &version);
    statusline_section(&mut doc, &ctx, &ctx.home, &ctx.cwd);
    render::statusline_render(&mut doc, &ctx, root_path);
    devswarm::section(&mut doc, &ctx, root_path);
    let absent: Vec<&str> = [detect::omc_section(&mut doc, &ctx), detect::codex_section(&mut doc, &ctx, root_path)].into_iter().flatten().collect();
    if !absent.is_empty() {
        doc.head(defaults::text("doctor_msg.head_integrations"));
        for note in absent {
            doc.infol(note.to_string());
        }
    }
    workflows_section(&mut doc, &ctx, &ctx.home, &ctx.cwd);
    detect::foreign_section(&mut doc, &ctx, root_path);
    if do_repair {
        repair_section(&mut doc, &ctx, &f, &fixes, root_path);
    } else if !f.check && f.explicit.is_empty() {
        doc.head(defaults::text("doctor_msg.repair_heading"));
        doc.infol(defaults::text("doctor_msg.repair_read_only").to_string());
    }
    orphans::detect_section(&mut doc, &ctx);
    stores::detect_section(&mut doc, &ctx);
    explicit_sections(&mut doc, &ctx, &f);

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

/// The run cannot even build its context (HOME unset, no working directory): report that as a diagnosis, not a bare error.
fn no_context(p: &Parsed, why: &str) -> i32 {
    let mut doc = Doc::default();
    doc.head(defaults::text("doctor_msg.head_environment"));
    doc.bad(if why == defaults::text("migrate_msg.no_home") { defaults::text("doctor_msg.home_unset").to_string() } else { why.to_string() });
    if p.json {
        println!("{}", json::stringify(&doc.to_json(&crate::version())));
    } else {
        println!("{}", defaults::render("doctor_msg.title", &[("version", &crate::version())]));
        println!("{}\n", doc.body());
        println!("{}", doc.verdict());
    }
    1
}

/// `doctor` when the engine's defaults cannot be loaded at all: nothing the engine can say comes from settings, so the shell
/// doctor next to the hook wrapper (its own texts, POSIX sh only) gives the diagnosis. `err` is why the load failed.
pub fn degraded(p: &Parsed, err: &str) -> i32 {
    let root = p.rest.iter().position(|a| a == "--plugin-root").and_then(|i| p.rest.get(i + 1)).map(PathBuf::from).or_else(crate::bootstrap::env_root);
    let wrapper = root.as_deref().map(|r| r.join(crate::bootstrap::WRAPPER_REL)).filter(|w| w.is_file());
    eprintln!("ah-engine: defaults unavailable: {err}");
    let Some(w) = wrapper else { return 70 };
    let mut cmd = std::process::Command::new("sh");
    cmd.arg(&w).arg(crate::bootstrap::SHELL_DOCTOR_ARG).args(p.rest.iter().filter(|a| a.starts_with("--")));
    cmd.env(crate::bootstrap::ROOT_ENVS[0], root.unwrap_or_default());
    cmd.env(crate::bootstrap::DEFAULTS_ERROR_ENV, err.split_whitespace().collect::<Vec<_>>().join(" "));
    cmd.status().map_or(70, |s| s.code().unwrap_or(70))
}
