//! `ah-engine units <status|install|heal|uninstall> [--dry-run] [--bin <path>]`: the engine's own service units, without Node.
//!
//! One unit per user keeps the engine daemon running: a launchd LaunchAgent on macOS, a systemd user service plus timer on Linux.
//! It runs `ah-engine serve` on load and again every `units.watch_interval_s`; `serve` returns at once while a daemon answers (the
//! singleton lock decides), so the unit only ever starts a daemon when none runs and never competes with the one a hook started.
//! The unit names the engine binary at its install path, not the plugin, so a plugin update needs no new unit.
//!
//! `heal` (what update and doctor --repair call, through [`heal`]) installs the engine unit and then retires each unit a Node
//! installer wrote whose duty the engine already runs: the MCP reaper when the `mcp_reaper` job is on, the DevSwarm supervisor when
//! `devswarm_sup.mode` is engine, the DevSwarm ingest daemons when `devswarm_ingest.mode` is engine. The duty is read again right
//! before each retirement; a unit is retired by unloading it, checking that the service manager no longer has it, and moving its
//! files into the state directory (`units.state_subdir`/`units.retired_subdir`). Nothing is ever deleted. A unit retired earlier that
//! is back (the owner reinstalled it) is recorded as a mistake signal of that retirement and left alone; the engine's reaper job
//! stands down while a Node reaper unit exists, so nothing runs twice.
//!
//! Every action of a non-dry run is one ledger line (`units.ledger_file`), one engine log line and one telemetry item; a run holds
//! a lock so two runs never act at once. Service-manager commands go through [`Sys`]: the real one refuses them under a test marker
//! or a temporary home (files are still written there), and the tests drive both platforms through a recording one.
//! Every name, template, command line and word is in the plugin's `engine/defaults/units.toml`.
use crate::cli::Parsed;
use crate::defaults::{self, V};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The service manager and the operating system, as the unit code sees them.
pub trait Sys {
    /// The operating system (`std::env::consts::OS`).
    fn os(&self) -> String;
    /// Run one command line: `Some(exit code)`, or `None` when it could not run (spawn failure, timeout, killed).
    fn run(&self, argv: &[String]) -> Option<i32>;
    /// True when no service-manager command may run (a test marker, a temporary home).
    fn guarded(&self) -> bool;
}

/// The real service manager.
pub struct RealSys {
    guarded: bool,
}

impl RealSys {
    /// The real service manager for `home`, guarded under a test marker or a temporary home (unless the override is set).
    pub fn new(home: &Path, env: &crate::reqenv::RequestEnv) -> RealSys {
        let set = |k: &str| env.get(k).is_some_and(|v| !v.is_empty());
        let marked = defaults::list("units.test_markers").into_iter().any(set);
        let h = format!("{}/", home.display());
        let tmp = std::env::temp_dir();
        let tmp_home = defaults::list("units.tmp_roots").into_iter().any(|r| h.starts_with(r)) || home.starts_with(&tmp);
        let allow = env.get(defaults::text("units.allow_tmp_home_env")) == Some(defaults::text("units.allow_tmp_home_word"));
        RealSys { guarded: marked || (tmp_home && !allow) }
    }
}

impl Sys for RealSys {
    fn os(&self) -> String {
        std::env::consts::OS.to_string()
    }

    fn run(&self, argv: &[String]) -> Option<i32> {
        let (prog, args) = argv.split_first()?;
        let mut cmd = std::process::Command::new(prog);
        cmd.args(args);
        let out = crate::proc::run(cmd, defaults::text("units.cmd_what"), defaults::millis("units.cmd_timeout_ms"), defaults::millis("units.cmd_poll_ms")).ok()?;
        out.status.code()
    }

    fn guarded(&self) -> bool {
        self.guarded
    }
}

/// One line of the report (and of the ledger).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    /// What was done (`units.act_*`).
    pub action: String,
    /// What it was done to (a path or a command line).
    pub target: String,
    /// How it ended (`units.out_*`).
    pub outcome: String,
    /// Why, or nothing.
    pub reason: String,
    /// The action's id (also in the ledger), or nothing for a status line or a dry run.
    pub action_id: String,
}

/// What a run did.
#[derive(Debug, Default)]
pub struct Report {
    /// The lines, in order.
    pub rows: Vec<Row>,
    /// Notes for the operator.
    pub notes: Vec<String>,
    /// True when something failed.
    pub failed: bool,
}

impl Report {
    /// The report as one JSON value.
    pub fn to_json(&self) -> Value {
        let rows: Vec<Value> = self
            .rows
            .iter()
            .map(|r| json!({"action": r.action, "target": r.target, "outcome": r.outcome, "reason": r.reason, "action_id": r.action_id}))
            .collect();
        json!({"rows": rows, "notes": self.notes, "failed": self.failed})
    }

    /// The report as text lines.
    pub fn to_text(&self) -> String {
        let mut out: Vec<String> = self
            .rows
            .iter()
            .map(|r| {
                let reason = if r.reason.is_empty() { String::new() } else { format!("{}{}", defaults::text("units.reason_sep"), r.reason) };
                fill(defaults::text("units.line_action"), &[("action", &r.action), ("target", &r.target), ("outcome", &r.outcome), ("reason", &reason)])
            })
            .collect();
        out.extend(self.notes.iter().map(|n| fill(defaults::text("units.line_note"), &[("note", n)])));
        out.join("\n")
    }
}

/// Everything one run works with.
pub struct Ctx<'a> {
    /// The home directory.
    pub home: PathBuf,
    /// The engine state directory (ledger, lock, retired files).
    pub state: PathBuf,
    /// The engine binary the unit runs.
    pub exe: String,
    /// Report only.
    pub dry: bool,
    /// The service manager.
    pub sys: &'a dyn Sys,
    /// Whether the engine runs the duty named by a duty word (read again right before each retirement).
    pub duty: &'a dyn Fn(&str) -> bool,
    /// The clock, in milliseconds since the epoch.
    pub now_ms: u64,
}

/// `{name}` placeholders replaced in one pass (a value is never scanned again).
fn fill(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let after = &rest[i + 1..];
        match after.find('}').map(|j| (&after[..j], j)).and_then(|(name, j)| args.iter().find(|(n, _)| *n == name).map(|(_, v)| (*v, j))) {
            Some((v, j)) => {
                out.push_str(v);
                rest = &after[j + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `s` with the escapes of the defaults list `key` (pairs, applied in order).
fn escape(key: &str, s: &str) -> String {
    defaults::raw(key).as_array().unwrap_or_default().iter().fold(s.to_string(), |acc, pair| {
        let p = pair.strings();
        match (p.first(), p.get(1)) {
            (Some(from), Some(to)) => acc.replace(from, to),
            _ => acc,
        }
    })
}

/// The command lines of the defaults list `key` (a list of argv templates), filled with `args`.
fn argvs(key: &str, args: &[(&str, &str)]) -> Vec<Vec<String>> {
    defaults::raw(key).as_array().unwrap_or_default().iter().map(|a| a.strings().iter().map(|t| fill(t, args)).collect()).collect()
}

fn argv(key: &str, args: &[(&str, &str)]) -> Vec<String> {
    defaults::list(key).iter().map(|t| fill(t, args)).collect()
}

/// Which service manager this operating system has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    /// launchd (macOS).
    Launchd,
    /// systemd user units (Linux).
    Systemd,
}

/// The manager of `os`, or `None` when the engine writes no units there.
pub fn manager(os: &str) -> Option<Manager> {
    if os == defaults::text("units.os_launchd") {
        Some(Manager::Launchd)
    } else if os == defaults::text("units.os_systemd") {
        Some(Manager::Systemd)
    } else {
        None
    }
}

fn launchd_dir(home: &Path) -> PathBuf {
    home.join(defaults::text("units.launchd_dir"))
}

fn systemd_dir(home: &Path) -> PathBuf {
    home.join(defaults::text("units.systemd_dir"))
}

fn plist_path(home: &Path, label: &str) -> PathBuf {
    launchd_dir(home).join(format!("{label}{}", defaults::text("units.plist_suffix")))
}

fn timer_name(unit: &str) -> String {
    format!("{unit}{}", defaults::text("units.timer_suffix"))
}

/// The engine unit's files and their contents for `m`.
pub fn engine_files(m: Manager, home: &Path, exe: &str) -> Vec<(PathBuf, String)> {
    let mut args = vec![exe.to_string()];
    args.extend(defaults::list("units.serve_args").into_iter().map(str::to_string));
    let interval = defaults::num("units.watch_interval_s").to_string();
    match m {
        Manager::Launchd => {
            let x = |s: &str| escape("units.xml_escapes", s);
            let lines: Vec<String> = args.iter().map(|a| fill(defaults::text("units.plist_arg"), &[("arg", &x(a))])).collect();
            let label = defaults::text("units.label");
            let text = fill(
                defaults::text("units.plist_template"),
                &[("label", &x(label)), ("args", &lines.join("\n")), ("interval", &interval), ("log", &x(defaults::text("units.plist_log")))],
            );
            vec![(plist_path(home, label), text)]
        }
        Manager::Systemd => {
            let exec: Vec<String> = args.iter().map(|a| fill(defaults::text("units.exec_arg"), &[("arg", &escape("units.systemd_escapes", a))])).collect();
            let unit = defaults::text("units.unit_name");
            let dir = systemd_dir(home);
            vec![
                (dir.join(format!("{unit}{}", defaults::text("units.service_suffix"))), fill(defaults::text("units.service_template"), &[("exec", &exec.join(" "))])),
                (dir.join(timer_name(unit)), fill(defaults::text("units.timer_template"), &[("interval", &interval)])),
            ]
        }
    }
}

// ---- the run's bookkeeping ----------------------------------------------------------------------------------------------------

struct Run<'c, 'a> {
    ctx: &'c Ctx<'a>,
    report: Report,
    seq: u32,
}

impl Run<'_, '_> {
    fn units_dir(&self) -> PathBuf {
        self.ctx.state.join(defaults::text("units.state_subdir"))
    }

    /// Add a line; a non-dry acting line also goes to the ledger, the engine log and telemetry.
    fn row(&mut self, action: &str, target: &str, outcome: &str, reason: &str) -> String {
        let acting = !self.ctx.dry && action != defaults::text("units.act_status") && action != defaults::text("units.act_unchanged");
        let mut id = String::new();
        if acting {
            self.seq += 1;
            id = format!("{:x}-{}", self.ctx.now_ms, self.seq);
            let line = json!({"ts": self.ctx.now_ms, "action_id": id, "action": action, "target": target, "outcome": outcome, "reason": reason});
            let dir = self.units_dir();
            crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the append below reports nothing either way
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(defaults::text("units.ledger_file"))) {
                crate::discard::harmless(std::io::Write::write_all(&mut f, format!("{line}\n").as_bytes())); // keep: best effort, the report has it
            }
            crate::health::log_event(defaults::text("units.log_kind"), action, &fill(defaults::text("units.log_detail"), &[("target", target), ("outcome", outcome), ("reason", reason)]));
            crate::telemetry::emit::add_items(1);
        }
        if outcome == defaults::text("units.out_failed") {
            self.report.failed = true;
        }
        self.report.rows.push(Row { action: action.into(), target: target.into(), outcome: outcome.into(), reason: reason.into(), action_id: id.clone() });
        id
    }

    fn note(&mut self, n: String) {
        self.report.notes.push(n);
    }

    /// Run one service-manager command (one report line): its exit code, or `None` when it did not run.
    fn command(&mut self, argv: &[String]) -> Option<i32> {
        let target = argv.join(" ");
        if self.ctx.dry {
            self.row(defaults::text("units.act_load"), &target, defaults::text("units.out_dry"), "");
            return Some(0);
        }
        if self.ctx.sys.guarded() {
            self.row(defaults::text("units.act_load"), &target, defaults::text("units.out_refused"), defaults::text("units.why_test_guard"));
            return None;
        }
        let code = self.ctx.sys.run(argv);
        let (out, why) = match code {
            Some(0) => (defaults::text("units.out_ok"), String::new()),
            Some(c) => (defaults::text("units.out_nonzero"), fill(defaults::text("units.why_exit"), &[("code", &c.to_string())])),
            None => (defaults::text("units.out_failed"), String::new()),
        };
        self.row(defaults::text("units.act_load"), &target, out, &why);
        code
    }

    /// Run a sequence; only the last command's failure fails the step (the earlier ones may fail on a unit that is not loaded).
    fn sequence(&mut self, cmds: &[Vec<String>]) -> bool {
        let mut last = Some(0);
        for c in cmds {
            last = self.command(c);
        }
        last == Some(0)
    }

    /// True when the service manager reports `argv`'s unit loaded (exit 0). A guarded or dry run cannot tell: `None`.
    fn probe(&self, argv: &[String]) -> Option<bool> {
        if self.ctx.dry || self.ctx.sys.guarded() {
            return None;
        }
        Some(self.ctx.sys.run(argv) == Some(0))
    }

    /// Move `path` aside into the retired directory (never a delete): true when it moved (or would, on a dry run).
    fn move_aside(&mut self, action: &str, path: &Path) -> bool {
        let shown = path.display().to_string();
        if self.ctx.dry {
            self.row(action, &shown, defaults::text("units.out_dry"), "");
            return true;
        }
        let dir = self.units_dir().join(defaults::text("units.retired_subdir"));
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let to = dir.join(format!("{name}.{}", self.ctx.now_ms));
        let moved = std::fs::create_dir_all(&dir).is_ok()
            && (std::fs::rename(path, &to).is_ok() || (std::fs::copy(path, &to).is_ok() && std::fs::remove_file(path).is_ok()));
        let out = if moved { defaults::text("units.out_ok") } else { defaults::text("units.out_failed") };
        self.row(action, &shown, out, &to.display().to_string());
        moved
    }

    /// The id of an earlier successful retirement of `target` in the ledger, if any.
    fn retired_before(&self, target: &str) -> Option<String> {
        let text = std::fs::read_to_string(self.units_dir().join(defaults::text("units.ledger_file"))).ok()?;
        text.lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| {
                v["action"] == defaults::text("units.act_retire") && v["outcome"] == defaults::text("units.out_ok") && v["target"] == target
            })
            .filter_map(|v| v["action_id"].as_str().map(str::to_string))
            .last()
    }
}

// ---- the engine unit ----------------------------------------------------------------------------------------------------------

fn executable(p: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn install_into(run: &mut Run<'_, '_>) {
    let ctx = run.ctx;
    let Some(m) = manager(&ctx.sys.os()) else {
        run.note(fill(defaults::text("units.msg_unsupported"), &[("os", &ctx.sys.os())]));
        return;
    };
    if !executable(&ctx.exe) {
        run.note(fill(defaults::text("units.msg_no_bin"), &[("bin", &ctx.exe)]));
        run.report.failed = true;
        return;
    }
    if m == Manager::Systemd && run.probe(&argv("units.systemd_probe", &[])) == Some(false) {
        run.note(fill(defaults::text("units.msg_no_systemctl"), &[("line", &fill(defaults::text("units.cron_line"), &[("exe", &ctx.exe)]))]));
        return;
    }
    let mut changed = false;
    for (path, text) in engine_files(m, &ctx.home, &ctx.exe) {
        let shown = path.display().to_string();
        if std::fs::read(&path).is_ok_and(|b| b == text.as_bytes()) {
            run.row(defaults::text("units.act_unchanged"), &shown, defaults::text("units.out_ok"), "");
            continue;
        }
        changed = true;
        if ctx.dry {
            run.row(defaults::text("units.act_write"), &shown, defaults::text("units.out_dry"), "");
            continue;
        }
        let ok = path.parent().is_none_or(|d| std::fs::create_dir_all(d).is_ok()) && crate::atomic::write(&path, text.as_bytes()).is_ok();
        run.row(defaults::text("units.act_write"), &shown, if ok { defaults::text("units.out_ok") } else { defaults::text("units.out_failed") }, "");
        if !ok {
            return;
        }
    }
    let label = defaults::text("units.label");
    let timer = timer_name(defaults::text("units.unit_name"));
    let plist = plist_path(&ctx.home, label).display().to_string();
    let (loaded, load) = match m {
        Manager::Launchd => (argv("units.launchd_loaded", &[("label", label)]), argvs("units.launchd_load", &[("plist", &plist)])),
        Manager::Systemd => (argv("units.systemd_loaded", &[("unit", &timer)]), argvs("units.systemd_load", &[("timer", &timer)])),
    };
    if changed || run.probe(&loaded) != Some(true) {
        if !run.sequence(&load) && !ctx.sys.guarded() {
            run.report.failed = true;
        }
    }
}

fn uninstall_from(run: &mut Run<'_, '_>) {
    let ctx = run.ctx;
    let Some(m) = manager(&ctx.sys.os()) else {
        run.note(fill(defaults::text("units.msg_unsupported"), &[("os", &ctx.sys.os())]));
        return;
    };
    let files: Vec<PathBuf> = engine_files(m, &ctx.home, &ctx.exe).into_iter().map(|(p, _)| p).filter(|p| p.exists()).collect();
    let plist = plist_path(&ctx.home, defaults::text("units.label")).display().to_string();
    let timer = timer_name(defaults::text("units.unit_name"));
    let unload = match m {
        Manager::Launchd => argvs("units.launchd_unload", &[("plist", &plist)]),
        Manager::Systemd => argvs("units.systemd_unload", &[("unit", &timer)]),
    };
    if !files.is_empty() {
        run.sequence(&unload);
    }
    if ctx.sys.guarded() && !ctx.dry {
        return; // the unload did not run: moving the files would leave the unit loaded unseen
    }
    for f in &files {
        run.move_aside(defaults::text("units.act_remove"), f);
    }
    if m == Manager::Systemd && !files.is_empty() {
        run.sequence(&argvs("units.systemd_reload", &[]));
    }
}

// ---- the Node units -----------------------------------------------------------------------------------------------------------

/// One installed instance of a Node unit: its name (launchd label or systemd unit) and its files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    /// The definition's report name.
    pub def: String,
    /// The duty word.
    pub duty: String,
    /// The launchd label or systemd unit name.
    pub name: String,
    /// The systemd unit to disable (empty on launchd).
    pub stop: String,
    /// Its files.
    pub files: Vec<PathBuf>,
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    v.sort();
    v
}

/// `stem` is `base`, or (for a family) `base` + `sep` + a non-empty suffix.
fn member(stem: &str, base: &str, sep: &str, family: bool) -> bool {
    stem == base || (family && stem.strip_prefix(base).and_then(|r| r.strip_prefix(sep)).is_some_and(|s| !s.is_empty()))
}

/// The Node units installed under `home` for manager `m`.
pub fn node_instances(m: Manager, home: &Path) -> Vec<Instance> {
    let mut out = Vec::new();
    for d in defaults::raw("units.node_units").as_array().unwrap_or_default() {
        let family = d.get("family").and_then(V::as_bool).unwrap_or(false);
        let (def, duty) = (d.str_field("name").to_string(), d.str_field("duty").to_string());
        match m {
            Manager::Launchd => {
                let dir = launchd_dir(home);
                let suffix = defaults::text("units.plist_suffix");
                for n in names_in(&dir) {
                    let Some(stem) = n.strip_suffix(suffix) else { continue };
                    if member(stem, d.str_field("label"), defaults::text("units.label_sep"), family) {
                        out.push(Instance { def: def.clone(), duty: duty.clone(), name: stem.to_string(), stop: String::new(), files: vec![dir.join(&n)] });
                    }
                }
            }
            Manager::Systemd => {
                let dir = systemd_dir(home);
                let suffixes = d.get("files").map(V::strings).unwrap_or_default();
                let mut stems: Vec<String> = Vec::new();
                for n in names_in(&dir) {
                    for s in &suffixes {
                        if let Some(stem) = n.strip_suffix(s)
                            && member(stem, d.str_field("unit"), defaults::text("units.unit_sep"), family)
                            && !stems.iter().any(|x| x == stem)
                        {
                            stems.push(stem.to_string());
                        }
                    }
                }
                for stem in stems {
                    let files: Vec<PathBuf> = suffixes.iter().map(|s| dir.join(format!("{stem}{s}"))).filter(|p| p.exists()).collect();
                    let stop = fill(d.str_field("stop"), &[("unit", &stem)]);
                    out.push(Instance { def: def.clone(), duty: duty.clone(), name: stem, stop, files });
                }
            }
        }
    }
    out
}

fn retire_node_units(run: &mut Run<'_, '_>) {
    let ctx = run.ctx;
    let Some(m) = manager(&ctx.sys.os()) else { return };
    let mut reload = false;
    for inst in node_instances(m, &ctx.home) {
        let Some(first) = inst.files.first().map(|p| p.display().to_string()) else { continue };
        if let Some(prev) = run.retired_before(&first) {
            run.row(defaults::text("units.act_mistake"), &first, defaults::text("units.out_ok"), &fill(defaults::text("units.why_came_back"), &[("action_id", &prev)]));
            continue;
        }
        // the live re-check: the duty is read now, right before acting
        if !(ctx.duty)(&inst.duty) {
            run.row(defaults::text("units.act_keep"), &first, defaults::text("units.out_ok"), defaults::text("units.why_duty_node"));
            continue;
        }
        if inst.duty == defaults::text("units.duty_reaper") && !carry_reaper_optin(run) {
            continue;
        }
        let (unload, loaded) = match m {
            Manager::Launchd => (argvs("units.launchd_unload", &[("plist", &first)]), argv("units.launchd_loaded", &[("label", &inst.name)])),
            Manager::Systemd => (argvs("units.systemd_unload", &[("unit", &inst.stop)]), argv("units.systemd_loaded", &[("unit", &inst.stop)])),
        };
        run.sequence(&unload);
        if ctx.sys.guarded() && !ctx.dry {
            continue; // the unload did not run: moving the files would leave the Node unit running unseen
        }
        if run.probe(&loaded) == Some(true) {
            run.row(defaults::text("units.act_retire"), &first, defaults::text("units.out_failed"), defaults::text("units.why_duty_engine"));
            continue; // still loaded: keep its files where the owner sees them
        }
        // each move is a `retire` ledger line whose target is the file; the first file's line is what the mistake check finds
        for f in &inst.files {
            run.move_aside(defaults::text("units.act_retire"), f);
        }
        reload |= m == Manager::Systemd;
    }
    if reload {
        run.sequence(&argvs("units.systemd_reload", &[]));
    }
}

/// Write the reaper opt-in marker the job reads on `auto` (before the Node reaper unit goes, so the reaper never pauses).
fn carry_reaper_optin(run: &mut Run<'_, '_>) -> bool {
    let p = run.ctx.home.join(defaults::text("mcp_reaper.job_optin_rel"));
    let shown = p.display().to_string();
    if p.is_file() {
        return true;
    }
    if run.ctx.dry {
        run.row(defaults::text("units.act_optin"), &shown, defaults::text("units.out_dry"), "");
        return true;
    }
    let ok = p.parent().is_none_or(|d| std::fs::create_dir_all(d).is_ok()) && crate::atomic::write(&p, b"").is_ok();
    run.row(defaults::text("units.act_optin"), &shown, if ok { defaults::text("units.out_ok") } else { defaults::text("units.out_failed") }, "");
    ok
}

fn status_into(run: &mut Run<'_, '_>) {
    let ctx = run.ctx;
    let Some(m) = manager(&ctx.sys.os()) else {
        run.note(fill(defaults::text("units.msg_unsupported"), &[("os", &ctx.sys.os())]));
        return;
    };
    for (p, _) in engine_files(m, &ctx.home, &ctx.exe) {
        let out = if p.exists() { defaults::text("units.out_present") } else { defaults::text("units.out_absent") };
        run.row(defaults::text("units.act_status"), &p.display().to_string(), out, "");
    }
    for inst in node_instances(m, &ctx.home) {
        let why = if (ctx.duty)(&inst.duty) { defaults::text("units.why_duty_engine") } else { defaults::text("units.why_duty_node") };
        for f in &inst.files {
            run.row(defaults::text("units.act_status"), &f.display().to_string(), defaults::text("units.out_present"), why);
        }
    }
}

/// The subcommands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sub {
    /// Report only.
    Status,
    /// Write and load the engine unit.
    Install,
    /// Install, then retire the Node units whose duty the engine runs.
    Heal,
    /// Unload the engine unit and move its files aside.
    Uninstall,
}

/// Run `sub` with `ctx` (no lock: the caller holds it).
pub fn execute(sub: Sub, ctx: &Ctx<'_>) -> Report {
    let mut run = Run { ctx, report: Report::default(), seq: 0 };
    match sub {
        Sub::Status => status_into(&mut run),
        Sub::Install => install_into(&mut run),
        Sub::Heal => {
            install_into(&mut run);
            retire_node_units(&mut run);
        }
        Sub::Uninstall => uninstall_from(&mut run),
    }
    run.report
}

// ---- the real context ---------------------------------------------------------------------------------------------------------

/// Whether the engine runs the duty `word` now (environment, settings.json, shipped defaults).
pub fn engine_runs(word: &str) -> bool {
    if word == defaults::text("units.duty_reaper") {
        let env = crate::reqenv::RequestEnv::capture();
        let st = crate::checks::git::util::Settings::from_env(&env);
        let mode = crate::checks::guardkit::settings::get_enum(&st, defaults::raw("mcp_reaper.job_setting"));
        return mode != defaults::text("mcp_reaper.job_word_off") && defaults::num("mcp_reaper.job_every_ms") > 0;
    }
    if word == defaults::text("units.duty_supervisor") {
        return crate::dssup::owner() == crate::dssup::Owner::Engine;
    }
    if word == defaults::text("units.duty_ingest") {
        return crate::dssup::ingest::owner() == crate::dssup::ingest::Owner::Engine;
    }
    false
}

/// A lock on the units directory, held while it lives; `None` when another run holds it (or it cannot be opened).
fn lock(state: &Path) -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    let dir = state.join(defaults::text("units.state_subdir"));
    std::fs::create_dir_all(&dir).ok()?;
    let f = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(defaults::text("units.lock_file"))).ok()?;
    // SAFETY: `f` is an open file owned by this scope; flock takes only its descriptor and a flag.
    (unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0).then_some(f)
}

/// Run `sub` for this user with the real service manager: the report, or `None` when another run holds the lock or there is
/// no home directory (the reason is the second value).
pub fn run_real(sub: Sub, dry: bool, bin: Option<String>) -> Result<Report, &'static str> {
    let env = crate::reqenv::RequestEnv::capture();
    let Some(home) = defaults::env_var("home").filter(|h| !h.is_empty()).map(PathBuf::from) else { return Err("units.msg_no_home") };
    let state = crate::paths::dir();
    let exe = bin.unwrap_or_else(|| home.join(defaults::text("units.engine_bin_rel")).display().to_string());
    let sys = RealSys::new(&home, &env);
    let _held = if dry || sub == Sub::Status {
        None
    } else {
        Some(lock(&state).ok_or("units.msg_busy")?)
    };
    let now_ms = crate::health::now_ms();
    Ok(execute(sub, &Ctx { home, state, exe, dry, sys: &sys, duty: &engine_runs, now_ms }))
}

/// `units heal` for a caller in the engine (update's post-pull stage, doctor --repair): the report as JSON.
pub fn heal(dry: bool) -> Value {
    match run_real(Sub::Heal, dry, None) {
        Ok(r) => r.to_json(),
        Err(key) => json!({"rows": [], "notes": [defaults::text(key)], "failed": false}),
    }
}

/// Whether the callers inside the engine (update's post-pull stage, `doctor --repair`) run `units heal`: the setting
/// `maintenance.unitsHeal`, on unless it says off.
pub fn heal_enabled() -> bool {
    let env = crate::reqenv::RequestEnv::capture();
    let st = crate::checks::git::util::Settings::from_env(&env);
    crate::checks::guardkit::settings::get_enum(&st, defaults::raw("units.heal_setting")) != defaults::text("units.heal_word_off")
}

/// `units heal` for update's post-pull stage and `doctor --repair`: `None` when the setting is off or the run changed nothing
/// (an idempotent run on a healed machine, or one with nothing to act on, reports nothing); otherwise the report without its "unchanged" and test-guard "refused" lines. It moves Node
/// units aside and writes the engine unit, never deletes, and a failure is in the report, never a panic.
pub fn heal_changes(dry: bool) -> Option<Report> {
    if !heal_enabled() {
        return None;
    }
    let mut report = match run_real(Sub::Heal, dry, None) {
        Ok(r) => r,
        Err(key) => Report { rows: Vec::new(), notes: vec![defaults::text(key).to_string()], failed: false },
    };
    let (unchanged, refused) = (defaults::text("units.act_unchanged"), defaults::text("units.out_refused"));
    report.rows.retain(|r| r.action != unchanged && r.outcome != refused);
    // no row: nothing was written or moved (the engine binary is not installed yet, no service manager, another run holds the lock)
    if report.rows.is_empty() {
        return None;
    }
    Some(report)
}

/// The verb's handler.
pub fn cmd_units(p: &Parsed) -> i32 {
    let sub_word = p.rest.iter().find(|a| !a.starts_with("--")).map_or("", String::as_str);
    let bin_flag = defaults::text("units.flag_bin");
    let bin = p.rest.iter().position(|a| a == bin_flag).and_then(|i| p.rest.get(i + 1)).cloned();
    let sub = if sub_word == defaults::text("units.sub_status") {
        Sub::Status
    } else if sub_word == defaults::text("units.sub_install") {
        Sub::Install
    } else if sub_word == defaults::text("units.sub_heal") {
        Sub::Heal
    } else if sub_word == defaults::text("units.sub_uninstall") {
        Sub::Uninstall
    } else {
        eprintln!("{}", defaults::text("units.msg_usage"));
        return 64;
    };
    // the binary path after --bin is not the subcommand
    if bin.as_deref() == Some(sub_word) {
        eprintln!("{}", defaults::text("units.msg_usage"));
        return 64;
    }
    let dry = p.rest.iter().any(|a| a == defaults::text("units.flag_dry"));
    let started = std::time::Instant::now();
    crate::telemetry::emit::take_items();
    let (code, value, text) = match run_real(sub, dry, bin) {
        Ok(r) => (i32::from(r.failed), r.to_json(), r.to_text()),
        Err(key) => (0, json!({"rows": [], "notes": [defaults::text(key)], "failed": false}), defaults::text(key).to_string()),
    };
    if sub != Sub::Status && !dry {
        let items = crate::telemetry::emit::take_items();
        crate::telemetry::emit::event(crate::telemetry::emit::command_run(&p.command, sub_word, code, started.elapsed().as_micros() as u64, items));
    }
    if p.json {
        println!("{value}");
    } else if !text.is_empty() {
        println!("{text}");
    }
    code
}

#[cfg(test)]
mod tests;
