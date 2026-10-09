//! `ah-engine install-statusline` and `ah-engine uninstall-statusline`: put the anti-hall status line into the host's
//! `statusLine` setting and take it out again. Port of `statusline/install-statusline.js` and `uninstall-statusline.js`.
//!
//! They edit the user's own settings file, so every safety of the Node scripts is kept: the file is backed up once and the
//! backup is never overwritten, other keys are merged and never clobbered, a statusLine that is not ours is wrapped as line 1
//! (installer) or left alone (uninstaller), a re-run changes nothing, and the dispatcher path is refused when it holds shell
//! metacharacters. The write itself is atomic and keeps the file's mode and link. The text and exit code are the scripts' own.
//!
//! Where the Node script would print a JavaScript parser or file-system message the port cannot reproduce (a settings file
//! that is not valid JSON), it writes nothing, says so and exits with the deferral code; the Node script can be run instead.
use super::jsio::{self, join};
use super::{defer_code, env_snapshot, home, plugin_root};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, J};
use crate::cli::Parsed;
use crate::defaults;
use crate::migrate::{j_string, j_truthy};
use crate::ops::js::Defer;
use crate::setup::jsfmt::pretty;
use std::collections::BTreeMap;
use std::path::Path;

/// What the script printed, in order and by stream, so a terminal sees the same interleaving.
#[derive(Default)]
struct Log(Vec<(bool, String)>);

impl Log {
    fn out(&mut self, s: impl Into<String>) {
        self.0.push((false, s.into() + "\n"));
    }
    fn err(&mut self, s: impl Into<String>) {
        self.0.push((true, s.into() + "\n"));
    }
    fn flush(self) {
        for (is_err, text) in self.0 {
            if is_err {
                super::err(&text);
            } else {
                super::out(&text);
            }
        }
    }
}

fn t(key: &str) -> &'static str {
    defaults::text(key)
}

fn fill(key: &str, args: &[(&str, &dyn std::fmt::Display)]) -> String {
    defaults::render(key, args)
}

fn parse(text: &str) -> Result<J, json::Fail> {
    json::parse(text, defaults::num("setup.json_max_depth") as usize)
}

/// The text of a file, or `None` when it cannot be read (a directory, no permission).
fn read_text(path: &str) -> Option<String> {
    crate::checks::jsport::fsx::read_utf8(path)
}

/// `isShellSafe(p)`.
fn shell_safe(p: &str) -> bool {
    let extra = t("slcfg.shell_safe_extra");
    !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c))
}

/// `typeof v === 'object'`.
fn is_object(v: &J) -> bool {
    matches!(v, J::Null | J::Arr(_) | J::Obj(_))
}

/// A string `command` member.
fn command_of(v: Option<&J>) -> Option<&str> {
    match v.and_then(|s| s.get("command")) {
        Some(J::Str(s)) => Some(s),
        _ => None,
    }
}

/// `String(v)` for the values a settings file can hold.
fn js_text(v: &J) -> String {
    j_string(v)
}

/// The cause of a failed copy, in Node's words.
fn copy_message(e: &std::io::Error, from: &str, to: &str) -> String {
    jsio::node_message(e, t("slcfg.err_copyfile"), &[("from", &from), ("to", &to)])
}

fn mkdir_message(e: &std::io::Error, path: &str) -> String {
    jsio::node_message(e, t("slcfg.err_mkdir"), &[("path", &path)])
}

/// `fs.mkdirSync(dir, {recursive: true})` then `fs.writeFileSync(path, text)`.
fn write_in(dir: &str, path: &str, text: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| mkdir_message(&e, dir))?;
    jsio::write_file(path, text.as_bytes())
}

/// The base files, the dispatcher and the settings path: what both scripts compute first.
struct Paths {
    home: String,
    cwd: String,
    base_dir: String,
    base_cfg: String,
    consolidated_cfg: String,
    script_dir: String,
}

fn paths(env: &BTreeMap<String, String>) -> Result<Paths, Defer> {
    let home = home(env);
    let cwd = std::env::current_dir().map_err(|_| Defer)?.to_string_lossy().into_owned();
    let base_dir = join(&home, t("paths.base_dir"));
    let root = plugin_root(env).ok_or(Defer)?;
    let sdir = Path::new(&root).join(t("statusline.dir"));
    // the script's own directory, with links resolved as Node resolves the main module
    let script_dir = std::fs::canonicalize(&sdir).unwrap_or(sdir).to_string_lossy().into_owned();
    Ok(Paths {
        base_cfg: join(&base_dir, t("statusline.base_file")),
        consolidated_cfg: join(&base_dir, t("statusline.consolidated_file")),
        home,
        cwd,
        base_dir,
        script_dir,
    })
}

fn exists(p: &str) -> bool {
    Path::new(p).exists()
}

// ---- install ----------------------------------------------------------------------------------------------------------

/// `readStatusLineFrom(file)`: the file's `statusLine` member, `None` for absent, unreadable or not JSON.
fn status_line_from(path: &str) -> Result<Option<J>, Defer> {
    if !exists(path) {
        return Ok(None);
    }
    let Some(text) = read_text(path) else { return Ok(None) };
    match parse(&text) {
        Ok(J::Obj(o)) => Ok(o.into_iter().find(|(k, _)| k == "statusLine").map(|(_, v)| v)),
        Ok(_) | Err(json::Fail::Invalid) => Ok(None),
        Err(json::Fail::Unsupported) => Err(Defer),
    }
}

/// What `console.log` shows for the committed or user statusLine of the notes.
fn shown_command(sl: &J) -> String {
    if is_object(sl) && !matches!(sl, J::Null) {
        let cmd = sl.get("command");
        if j_truthy(cmd) {
            return cmd.map(js_text).unwrap_or_default();
        }
        return json::stringify(sl);
    }
    js_text(sl)
}

fn install(env: &BTreeMap<String, String>, args: &[String], log: &mut Log) -> Result<i32, Defer> {
    let pa = paths(env)?;
    let stable = join(&pa.home, &format!("{}/{}", t("slcfg.stable_dir"), t("slcfg.dispatcher_file")));
    let override_var = env.get(defaults::env_name("dispatcher_override"));
    let dispatcher = match override_var {
        Some(o) => o.clone(),
        None if exists(&stable) => stable.clone(),
        None => join(&pa.script_dir, t("slcfg.dispatcher_file")),
    };
    if override_var.is_none_or(String::is_empty) && !exists(&dispatcher) {
        log.err(fill("slcfg.inst_not_found_1", &[("path", &dispatcher)]));
        log.err(t("slcfg.inst_not_found_2"));
        return Ok(1);
    }
    let note = if dispatcher == stable { t("slcfg.dispatcher_stable") } else { t("slcfg.dispatcher_dev") };
    log.out(fill("slcfg.dispatcher_line", &[("path", &dispatcher), ("note", &note)]));

    let project = args.iter().any(|a| a == t("slcfg.flag_project"));
    let consolidate = args.iter().any(|a| a == t("slcfg.flag_consolidate"));
    let scope = if project { t("slcfg.scope_project") } else { t("slcfg.scope_user") };
    let claude = t("slcfg.claude_dir");
    let user_settings = join(&pa.home, &format!("{claude}/{}", t("slcfg.settings_file")));
    let project_settings = join(&pa.cwd, &format!("{claude}/{}", t("slcfg.settings_file")));
    let local_settings = join(&pa.cwd, &format!("{claude}/{}", t("slcfg.local_file")));
    let settings_path = if project { local_settings.clone() } else { user_settings.clone() };
    let backup_path = settings_path.clone() + t("slcfg.backup_suffix");

    if jsio::config_write_refused(&settings_path, env, &pa.cwd) {
        log.err(fill("slcfg.inst_refused", &[("path", &settings_path)]));
        log.err(t("slcfg.refused_2"));
        return Ok(0);
    }
    log.out(fill("slcfg.scope_line", &[("scope", &scope)]));
    log.out(fill("slcfg.settings_line", &[("path", &settings_path)]));
    log.out("");

    let sl_user = status_line_from(&user_settings)?;
    let sl_project = status_line_from(&project_settings)?;
    let sl_local = status_line_from(&local_settings)?;
    let effective = sl_local.as_ref().or(sl_project.as_ref()).or(sl_user.as_ref());
    let effective_cmd = command_of(effective).filter(|c| !c.is_empty());

    if project {
        if let Some(sp) = &sl_project {
            log.out(t("slcfg.note_project_1"));
            log.out(fill("slcfg.indent_line", &[("text", &shown_command(sp))]));
            log.out(t("slcfg.note_project_2"));
            log.out("");
        }
        if let (Some(su), None, None) = (&sl_user, &sl_project, &sl_local) {
            log.out(t("slcfg.note_user_1"));
            log.out(fill("slcfg.indent_line", &[("text", &shown_command(su))]));
            log.out(t("slcfg.note_user_2"));
            log.out("");
        }
    }

    let ours = effective_cmd
        .filter(|cmd| cmd.contains(t("slcfg.installed_marker")) && (cmd.contains(t("slcfg.installed_dir_install")) || cmd.contains(&pa.script_dir)));
    if let Some(cmd) = ours {
        log.out(t("slcfg.already_1"));
        log.out(fill("slcfg.indent_line", &[("text", &cmd)]));
        let same = |sl: &Option<J>| command_of(sl.as_ref()).is_some_and(|c| !c.is_empty() && c == cmd);
        log.out(if same(&sl_local) {
            t("slcfg.source_local")
        } else if same(&sl_project) {
            t("slcfg.source_project")
        } else {
            t("slcfg.source_user")
        });
        if consolidate && !exists(&pa.consolidated_cfg) {
            log.out("");
            for k in ["slcfg.advisory_1", "slcfg.advisory_2", "slcfg.advisory_3", "slcfg.advisory_4"] {
                log.out(t(k));
            }
        }
        log.out(t("slcfg.no_changes"));
        return Ok(0);
    }

    if !exists(&settings_path) {
        if !project {
            log.err(fill("slcfg.user_missing", &[("path", &settings_path)]));
            return Ok(1);
        }
        let dir = Path::new(&settings_path).parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
        match std::fs::create_dir_all(&dir)
            .map_err(|e| mkdir_message(&e, &dir))
            .and_then(|()| jsio::write_file(&settings_path, t("slcfg.empty_settings").as_bytes()))
        {
            Ok(()) => log.out(fill("slcfg.created", &[("path", &settings_path)])),
            Err(msg) => {
                log.err(fill("slcfg.create_failed", &[("path", &settings_path), ("msg", &msg)]));
                return Ok(1);
            }
        }
    }

    // a file the script cannot read or parse is reported with the JavaScript parser's own message: left to Node
    let text = read_text(&settings_path).ok_or(Defer)?;
    let mut settings = match parse(&text) {
        Ok(J::Obj(o)) => J::Obj(o),
        _ => return Err(Defer),
    };

    let existing = settings.get("statusLine").cloned();
    let existing_cmd = command_of(existing.as_ref()).filter(|c| !c.is_empty()).map(str::to_string);
    if let (true, Some(cmd)) = (consolidate, &existing_cmd) {
        let body = pretty(&J::Obj(vec![("command".into(), J::Str(cmd.clone()))])) + "\n";
        match write_in(&pa.base_dir, &pa.consolidated_cfg, &body) {
            Ok(()) => {
                log.out(t("slcfg.consolidated_saved"));
                log.out(fill("slcfg.indent_line", &[("text", &pa.consolidated_cfg)]));
                log.out(fill("slcfg.command_line", &[("cmd", cmd)]));
                for k in ["slcfg.consolidated_2", "slcfg.consolidated_3", "slcfg.consolidated_4"] {
                    log.out(t(k));
                }
                log.out("");
            }
            Err(msg) => {
                log.err(fill("slcfg.consolidated_write_failed", &[("path", &pa.consolidated_cfg), ("msg", &msg)]));
                log.err(t("slcfg.consolidated_do_instead"));
                log.out("");
            }
        }
    } else if existing_cmd.is_some() && exists(&pa.base_cfg) {
        log.out(t("slcfg.base_kept_1"));
        log.out(fill("slcfg.indent_line", &[("text", &pa.base_cfg)]));
        log.out(t("slcfg.base_kept_3"));
        log.out("");
    } else if let Some(cmd) = &existing_cmd {
        let body = pretty(&J::Obj(vec![("command".into(), J::Str(cmd.clone()))])) + "\n";
        match write_in(&pa.base_dir, &pa.base_cfg, &body) {
            Ok(()) => {
                log.out(t("slcfg.base_saved"));
                log.out(fill("slcfg.indent_line", &[("text", &pa.base_cfg)]));
                log.out(fill("slcfg.command_line", &[("cmd", cmd)]));
                log.out("");
            }
            Err(msg) => {
                log.err(fill("slcfg.base_write_failed_1", &[("path", &pa.base_cfg), ("msg", &msg)]));
                log.err(t("slcfg.base_write_failed_2"));
                log.out("");
            }
        }
    } else if consolidate {
        for k in ["slcfg.consolidate_nothing_1", "slcfg.consolidate_nothing_2", "slcfg.consolidate_nothing_3", "slcfg.consolidate_nothing_4"] {
            log.out(t(k));
        }
        log.out("");
    } else if let Some(ex) = &existing {
        let kind = if is_object(ex) { json::stringify(ex) } else { js_text(ex) };
        log.out(fill("slcfg.no_command_1", &[("kind", &kind)]));
        log.out(t("slcfg.no_command_2"));
        log.out("");
    } else {
        log.out(t("slcfg.no_existing"));
        log.out("");
    }

    if project {
        let gi = join(&pa.cwd, t("slcfg.gitignore_file"));
        let entry = t("slcfg.local_entry");
        let content = if exists(&gi) { read_text(&gi).ok_or(Defer)? } else { String::new() };
        if content.split('\n').any(|l| js_trim(l) == entry) {
            log.out(fill("slcfg.gitignore_has", &[("entry", &entry)]));
        } else {
            let suffix = if content.ends_with('\n') { "" } else { "\n" };
            let add = format!("{suffix}{entry}\n");
            let appended = std::fs::OpenOptions::new().append(true).create(true).open(&gi).and_then(|mut f| std::io::Write::write_all(&mut f, add.as_bytes()));
            match appended {
                Ok(()) => log.out(fill("slcfg.gitignore_updated", &[("entry", &entry)])),
                Err(e) => log.err(fill("slcfg.gitignore_failed", &[("msg", &jsio::node_message(&e, t("slcfg.err_open"), &[("path", &gi)]))])),
            }
        }
        if tracked_by_git(&pa.cwd) {
            log.out("");
            for k in ["slcfg.tracked_1", "slcfg.tracked_2", "slcfg.tracked_3", "slcfg.tracked_4"] {
                log.out(t(k));
            }
        }
        log.out("");
    }

    let backed = backup_once(&settings_path, &backup_path, log, true);
    if let Some(msg) = backed {
        log.err(fill("slcfg.backup_failed_1", &[("msg", &msg)]));
        log.err(t("slcfg.backup_failed_2"));
    }
    log.out("");

    match &existing {
        Some(ex) => {
            log.out(t("slcfg.old_statusline"));
            log.out(pretty(ex));
        }
        None => log.out(t("slcfg.no_old_statusline")),
    }
    log.out("");

    if !shell_safe(&dispatcher) {
        log.err(t("slcfg.unsafe_1"));
        log.err(fill("slcfg.unsafe_2", &[("path", &dispatcher)]));
        log.err(fill("slcfg.unsafe_3", &[("path", &settings_path)]));
        log.err(t("slcfg.unsafe_4"));
        return Ok(1);
    }
    let new_line = J::Obj(vec![
        ("type".into(), J::Str(t("slcfg.type_command").into())),
        ("command".into(), J::Str(statusline_command(&dispatcher, env))),
        ("padding".into(), J::Num(0.0)),
        ("refreshInterval".into(), J::Num(defaults::num("slcfg.refresh_interval") as f64)),
    ]);
    settings.set("statusLine", new_line.clone());
    let uninstall = join(&pa.script_dir, t("slcfg.uninstall_file"));
    if let Err(msg) = jsio::write_file(&settings_path, (pretty(&settings) + "\n").as_bytes()) {
        log.err(fill("slcfg.write_failed_1", &[("path", &settings_path), ("msg", &msg)]));
        log.err(t("slcfg.write_failed_2"));
        log.err(fill("slcfg.write_failed_3", &[("path", &uninstall)]));
        return Ok(1);
    }
    log.out(t("slcfg.new_statusline"));
    log.out(pretty(&new_line));
    log.out("");
    log.out(fill("slcfg.done", &[("path", &settings_path)]));
    log.out("");
    log.out(t("slcfg.restart_1"));
    log.out(t("slcfg.restart_2"));
    log.out("");
    let (first, second) = if project { ("slcfg.scope_project_1", "slcfg.scope_project_2") } else { ("slcfg.scope_user_1", "slcfg.scope_user_2") };
    log.out(t(first));
    log.out(t(second));
    log.out(t("slcfg.scope_phase_1"));
    log.out(t("slcfg.scope_phase_2"));
    log.out("");
    log.out(t("slcfg.to_uninstall"));
    log.out(fill("slcfg.uninstall_hint", &[("path", &uninstall)]));
    Ok(0)
}

/// Whether git tracks the project's local settings file (it should not: it holds a machine-absolute path).
pub(crate) fn tracked_by_git(cwd: &str) -> bool {
    let mut c = std::process::Command::new(t("slcfg.git_program"));
    c.args(defaults::list("slcfg.git_tracked_args")).current_dir(cwd);
    crate::proc::run(c, t("slcfg.git_program"), defaults::millis("slcfg.git_timeout_ms"), defaults::millis("statusline.poll_ms"))
        .is_ok_and(|o| o.status.success() && !js_trim(&String::from_utf8_lossy(&o.stdout)).is_empty())
}

/// Back `settings` up once, never over an existing backup. The installer reports an existing backup and the uninstaller stays
/// quiet about it. Returns the failure message, if any.
fn backup_once(settings: &str, backup: &str, log: &mut Log, report_existing: bool) -> Option<String> {
    if exists(backup) {
        if report_existing {
            log.out(fill("slcfg.backup_exists", &[("path", &backup)]));
        }
        return None;
    }
    match std::fs::copy(settings, backup) {
        Ok(_) => {
            log.out(fill("slcfg.backed_up_1", &[("path", &settings)]));
            log.out(fill("slcfg.backed_up_2", &[("path", &backup)]));
            None
        }
        Err(e) => Some(copy_message(&e, settings, backup)),
    }
}

// ---- the command the host runs ----------------------------------------------------------------------------------------

/// The launcher next to a dispatcher (`<dispatcher dir>/<slcfg.launcher_rel>`), when the plugin ships it.
fn launcher_for(dispatcher: &str) -> Option<String> {
    let dir = Path::new(dispatcher).parent()?;
    let launcher = crate::meshw::ident::resolve_abs(&dir.join(t("slcfg.launcher_rel")).to_string_lossy());
    exists(&launcher).then_some(launcher)
}

/// The Node-only form: `node "<dispatcher>"`.
fn node_command(dispatcher: &str) -> String {
    format!("{}{dispatcher}{}", t("slcfg.command_prefix"), t("slcfg.command_suffix"))
}

/// What the host runs each render. The engine's status line when the plugin ships its launcher (the launcher runs the engine
/// first and the Node dispatcher when the engine is absent or leaves the render to Node), else the Node dispatcher alone. The Node
/// installer always writes the Node-only form; `slcfg.node_only_env` makes this one do the same (the parity tests set it).
fn statusline_command(dispatcher: &str, env: &BTreeMap<String, String>) -> String {
    if env.get(defaults::env_name("statusline_node_only")).is_some_and(|v| !v.is_empty()) {
        return node_command(dispatcher);
    }
    match launcher_for(dispatcher) {
        Some(l) if shell_safe(&l) => fill("slcfg.command_launcher", &[("launcher", &l), ("dispatcher", &dispatcher)]),
        _ => node_command(dispatcher),
    }
}

/// What one settings file's upgrade did.
pub(crate) struct Upgrade {
    /// `fixed`, `skipped` or `failed` (a migration report's words).
    pub status: &'static str,
    /// The report text.
    pub msg: String,
}

/// The dispatcher inside a Node-only statusLine command that anti-hall installed (`node "<…/anti-hall/…/statusline.js>"`).
fn legacy_dispatcher(cmd: &str) -> Option<&str> {
    let inner = cmd.strip_prefix(t("slcfg.command_prefix"))?.strip_suffix(t("slcfg.command_suffix"))?;
    let norm = inner.replace('\\', "/");
    (norm.contains(t("slcfg.installed_marker")) && norm.contains(t("slcfg.installed_dir_install"))).then_some(inner)
}

/// The persisted-shape migration of an existing install: a statusLine anti-hall wrote in the Node-only form becomes the launcher
/// form. Idempotent (the new form is not the old one), fail-open (anything unclear is left exactly as it is), and it only ever
/// changes that one string, in place in the file's own text, after the one-time backup the installer keeps. `None`: nothing to do.
fn upgrade_file(path: &str, env: &BTreeMap<String, String>, cwd: &str, dry_run: bool) -> Option<Upgrade> {
    if env.get(defaults::env_name("statusline_node_only")).is_some_and(|v| !v.is_empty()) || jsio::config_write_refused(path, env, cwd) {
        return None;
    }
    let text = read_text(path)?;
    let settings = parse(&text).ok()?;
    let old = command_of(settings.get("statusLine"))?.to_string();
    let dispatcher = legacy_dispatcher(&old)?;
    let new = statusline_command(dispatcher, env);
    if new == old || !shell_safe(dispatcher) {
        return None;
    }
    let (old_lit, new_lit) = (json::quote(&old), json::quote(&new));
    let report = |status: &'static str, key: &str| Some(Upgrade { status, msg: fill(key, &[("path", &path), ("command", &new)]) });
    if text.matches(&old_lit).count() != 1 {
        return report("skipped", "slcfg.mig_ambiguous");
    }
    let next = text.replacen(&old_lit, &new_lit, 1);
    if parse(&next).ok().is_none_or(|n| command_of(n.get("statusLine")) != Some(new.as_str())) {
        return report("skipped", "slcfg.mig_ambiguous");
    }
    if dry_run {
        return report("skipped", "slcfg.mig_dry_run");
    }
    let backup = path.to_string() + t("slcfg.backup_suffix");
    if !exists(&backup) && std::fs::copy(path, &backup).is_err() {
        return report("failed", "slcfg.mig_backup_failed");
    }
    match jsio::write_file(path, next.as_bytes()) {
        Ok(()) => report("fixed", "slcfg.mig_fixed"),
        Err(_) => report("failed", "slcfg.mig_write_failed"),
    }
}

/// The settings files an install may have written: the user's, and the project's own two.
pub(crate) fn upgrade_commands(home: &str, cwd: &str, env: &BTreeMap<String, String>, dry_run: bool) -> Vec<Upgrade> {
    let claude = t("slcfg.claude_dir");
    let mut files = vec![join(home, &format!("{claude}/{}", t("slcfg.settings_file")))];
    if !cwd.is_empty() {
        files.push(join(cwd, &format!("{claude}/{}", t("slcfg.local_file"))));
        files.push(join(cwd, &format!("{claude}/{}", t("slcfg.settings_file"))));
    }
    let mut seen = std::collections::BTreeSet::new();
    files.into_iter().filter(|f| seen.insert(f.clone())).filter_map(|f| upgrade_file(&f, env, cwd, dry_run)).collect()
}

// ---- uninstall --------------------------------------------------------------------------------------------------------

/// `looksLikeAntiHallStatusLine(cmd)`.
fn looks_like_ours(cmd: Option<&str>) -> bool {
    cmd.is_some_and(|c| {
        let norm = c.replace('\\', "/");
        norm.contains(t("slcfg.installed_marker")) && norm.contains(t("slcfg.installed_dir_uninstall"))
    })
}

/// `purgeBaseIfRequested()` for the fall-through strategies.
fn purge_if_requested(pa: &Paths, purge: bool, log: &mut Log) {
    if purge && exists(&pa.base_cfg) && std::fs::remove_file(&pa.base_cfg).is_ok() {
        log.out(fill("slcfg.u_purged_a", &[("path", &pa.base_cfg)]));
        log.out("");
    }
}

fn uninstall(env: &BTreeMap<String, String>, args: &[String], log: &mut Log) -> Result<i32, Defer> {
    let pa = paths(env)?;
    let project = args.iter().any(|a| a == t("slcfg.flag_project"));
    let purge = args.iter().any(|a| a == t("slcfg.flag_purge"));
    let claude = t("slcfg.claude_dir");
    let scope = if project { t("slcfg.scope_project") } else { t("slcfg.scope_user") };
    let settings_path = if project {
        let local = join(&pa.cwd, &format!("{claude}/{}", t("slcfg.local_file")));
        if exists(&local) { local } else { join(&pa.cwd, &format!("{claude}/{}", t("slcfg.settings_file"))) }
    } else {
        join(&pa.home, &format!("{claude}/{}", t("slcfg.settings_file")))
    };
    let backup_path = settings_path.clone() + t("slcfg.backup_suffix");
    if jsio::config_write_refused(&settings_path, env, &pa.cwd) {
        log.err(fill("slcfg.uninst_refused", &[("path", &settings_path)]));
        log.err(t("slcfg.refused_2"));
        return Ok(0);
    }
    log.out(fill("slcfg.scope_line", &[("scope", &scope)]));
    log.out(fill("slcfg.settings_line", &[("path", &settings_path)]));
    log.out("");

    if !exists(&settings_path) {
        log.err(fill("slcfg.u_not_found", &[("path", &settings_path)]));
        return Ok(1);
    }
    let ensure_backup = |log: &mut Log| {
        if exists(&backup_path) {
            return;
        }
        match backup_once(&settings_path, &backup_path, log, false) {
            None => log.out(""),
            Some(msg) => log.err(fill("slcfg.uninst_backup_failed", &[("msg", &msg)])),
        }
    };
    // Strategy A: the saved base command is the original statusLine
    if exists(&pa.base_cfg) {
        let base = match parse(&read_text(&pa.base_cfg).ok_or(Defer)?) {
            Ok(v) => v,
            Err(_) => return Err(Defer),
        };
        let restored = command_of(Some(&base)).map(|c| js_trim(c).to_string()).filter(|c| !c.is_empty());
        if let Some(restored) = restored {
            let mut settings = match parse(&read_text(&settings_path).ok_or(Defer)?) {
                Ok(J::Obj(o)) => J::Obj(o),
                _ => return Err(Defer),
            };
            let current = command_of(settings.get("statusLine")).filter(|c| !c.is_empty()).map(str::to_string);
            if !looks_like_ours(current.as_deref()) {
                log.out(fill("slcfg.u_not_antihall_1", &[("path", &settings_path)]));
                log.out(t("slcfg.u_not_antihall_2"));
                log.out(fill("slcfg.u_current", &[("cmd", &current.as_deref().unwrap_or_else(|| t("slcfg.u_none")))]));
                log.out("");
            } else {
                ensure_backup(log);
                settings.set("statusLine", J::Obj(vec![("type".into(), J::Str(t("slcfg.type_command").into())), ("command".into(), J::Str(restored.clone()))]));
                if let Err(msg) = jsio::write_file(&settings_path, (pretty(&settings) + "\n").as_bytes()) {
                    log.err(fill("slcfg.u_write_failed", &[("path", &settings_path), ("msg", &msg)]));
                    return Ok(1);
                }
                log.out(fill("slcfg.u_restored_base", &[("path", &pa.base_cfg)]));
                log.out(fill("slcfg.command_line", &[("cmd", &restored)]));
                log.out("");
                if purge {
                    if std::fs::remove_file(&pa.base_cfg).is_ok() {
                        log.out(fill("slcfg.u_purged_a", &[("path", &pa.base_cfg)]));
                        log.out(t("slcfg.u_purged_a2"));
                        log.out(t("slcfg.u_purged_a3"));
                    }
                } else {
                    log.out(fill("slcfg.u_kept_base", &[("path", &pa.base_cfg)]));
                    log.out(t("slcfg.u_kept_base2"));
                }
                log.out("");
                log.out(t("slcfg.u_restart"));
                return Ok(0);
            }
        }
    }
    // Strategy B: restore the whole file from the backup
    if exists(&backup_path) {
        let backup = match parse(&read_text(&backup_path).ok_or(Defer)?) {
            Ok(v) => v,
            Err(_) => return Err(Defer),
        };
        if !matches!(backup, J::Null) {
            if let Err(msg) = jsio::write_file(&settings_path, (pretty(&backup) + "\n").as_bytes()) {
                log.err(fill("slcfg.u_restore_failed", &[("path", &settings_path), ("msg", &msg)]));
                return Ok(1);
            }
            log.out(fill("slcfg.u_restored_backup", &[("path", &settings_path)]));
            log.out(fill("slcfg.u_backup_line", &[("path", &backup_path)]));
            match backup.get("statusLine") {
                Some(sl) => log.out(fill("slcfg.u_restored_sl", &[("json", &json::stringify(sl))])),
                None => log.out(t("slcfg.u_backup_no_sl")),
            }
            log.out("");
            purge_if_requested(&pa, purge, log);
            log.out(t("slcfg.u_restart"));
            return Ok(0);
        }
    }
    // Strategy C: no backup and no base: remove the key
    let mut settings = match parse(&read_text(&settings_path).ok_or(Defer)?) {
        Ok(J::Obj(o)) => J::Obj(o),
        _ => return Err(Defer),
    };
    let Some(removed) = settings.get("statusLine").cloned() else {
        log.out(fill("slcfg.u_nothing", &[("path", &settings_path)]));
        return Ok(0);
    };
    ensure_backup(log);
    if let J::Obj(o) = &mut settings {
        o.retain(|(k, _)| k != "statusLine");
    }
    if let Err(msg) = jsio::write_file(&settings_path, (pretty(&settings) + "\n").as_bytes()) {
        log.err(fill("slcfg.u_write_failed", &[("path", &settings_path), ("msg", &msg)]));
        return Ok(1);
    }
    log.out(fill("slcfg.u_removed", &[("path", &settings_path)]));
    log.out(pretty(&removed));
    log.out("");
    log.out(t("slcfg.u_no_backup"));
    log.out("");
    purge_if_requested(&pa, purge, log);
    log.out(t("slcfg.u_restart"));
    Ok(0)
}

// ---- the commands -----------------------------------------------------------------------------------------------------

fn finish(plan: Option<super::shadow::Plan>, result: Result<i32, Defer>, log: Log) -> i32 {
    let code = match result {
        Ok(c) => {
            log.flush();
            c
        }
        Err(Defer) => {
            super::err(&(t("slcfg.deferred").to_string() + "\n"));
            defer_code()
        }
    };
    super::shadow::end(plan, code);
    code
}

/// `install-statusline [--user|--project] [--consolidate]`
pub fn run_install(p: &Parsed) -> i32 {
    let plan = super::shadow::begin_install(t("ops.verb_install"), t("ops.script_install"), &p.raw);
    let mut log = Log::default();
    let result = install(&env_snapshot(), &p.raw, &mut log);
    finish(plan, result, log)
}

/// `uninstall-statusline [--user|--project] [--purge-base]`
pub fn run_uninstall(p: &Parsed) -> i32 {
    let plan = super::shadow::begin_install(t("ops.verb_uninstall"), t("ops.script_uninstall"), &p.raw);
    let mut log = Log::default();
    let result = uninstall(&env_snapshot(), &p.raw, &mut log);
    finish(plan, result, log)
}
