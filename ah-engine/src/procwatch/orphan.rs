//! The orphan sweep: which processes were left behind by an ended Claude session, and the careful way to stop one.
//!
//! A process is a candidate only when it is reparented (its parent is init or gone), carries the Claude marker in its environment,
//! its owner (the session process named by the environment) is not a live Claude session, no ancestor of it is one, and it matches
//! a configured class and that class's minimum age and is not protected. Everything the system will not show (its environment)
//! is left alone. See `procwatch.toml`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - a pattern that does not compile skips that class (reported through `crate::discard::note`), never the sweep
// A failure that must be seen goes through `crate::discard` instead.

use super::host::{Host, ProcRow, env_get};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::get_enum;
use crate::defaults;
use regex::Regex;
use std::collections::{HashMap, HashSet};

/// What a class does when it finds an orphan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Not looked for.
    Off,
    /// Listed only.
    Report,
    /// Stopped, one pid at a time.
    Kill,
}

impl Mode {
    /// The setting value.
    pub fn name(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Report => "report",
            Mode::Kill => "kill",
        }
    }
}

/// One class, compiled.
pub struct Class {
    /// Report name.
    pub name: String,
    /// What the class does.
    pub mode: Mode,
    cmd: Regex,
    exclude: Option<Regex>,
    min_age_s: u64,
    children: bool,
}

/// The sweep's configuration: the plugin's defaults read at call time, with the owner's settings applied.
pub struct Cfg {
    /// Classes in match order.
    pub classes: Vec<Class>,
    session_re: Regex,
    protect: Vec<Regex>,
    marker: &'static str,
    owner_var: &'static str,
    session_var: &'static str,
    /// Grace between the polite and the forced signal.
    pub grace_ms: u64,
    /// The most pids one sweep signals.
    pub max_kills: usize,
    /// The most candidates a report lists.
    pub max_listed: usize,
    /// Command line cut length.
    pub cmd_chars: usize,
}

fn compile(src: &str, what: &str) -> Option<Regex> {
    match Regex::new(src) {
        Ok(r) => Some(r),
        Err(e) => {
            crate::discard::note("procwatch_bad_pattern", &format!("{what}: {e}"));
            None
        }
    }
}

impl Cfg {
    /// Read the configuration.
    pub fn load(st: &Settings) -> Option<Cfg> {
        let session_re = compile(defaults::text("procwatch.session_cmd_re"), "session_cmd_re")?;
        let protect = defaults::list("procwatch.protect_res").into_iter().filter_map(|s| compile(s, "protect_res")).collect();
        let mut classes = Vec::new();
        for c in defaults::raw("procwatch.classes").as_array().unwrap_or(&[]) {
            let mode = match get_enum(st, defaults::raw(c.str_field("mode_key"))).as_str() {
                "kill" => Mode::Kill,
                "off" => Mode::Off,
                _ => Mode::Report,
            };
            let Some(cmd) = compile(c.str_field("cmd_re"), c.str_field("name")) else { continue };
            let ex = c.str_field("exclude_re");
            classes.push(Class {
                name: c.str_field("name").to_string(),
                mode,
                cmd,
                exclude: if ex.is_empty() { None } else { compile(ex, c.str_field("name")) },
                min_age_s: c.get("min_age_s").and_then(|v| v.as_integer()).unwrap_or(0).max(0) as u64,
                children: c.get("children").and_then(|v| v.as_bool()).unwrap_or(false),
            });
        }
        let mut all = extra_classes(st);
        all.extend(classes);
        let classes = all;
        Some(Cfg {
            classes,
            session_re,
            protect,
            marker: defaults::text("procwatch.marker_var"),
            owner_var: defaults::text("procwatch.owner_var"),
            session_var: defaults::text("procwatch.session_var"),
            grace_ms: defaults::num("procwatch.grace_ms"),
            max_kills: defaults::num("procwatch.max_kills_per_run") as usize,
            max_listed: defaults::num("procwatch.max_listed") as usize,
            cmd_chars: defaults::num("procwatch.cmd_chars") as usize,
        })
    }

    /// Is this command line a Claude session process?
    pub fn is_session(&self, cmd: &str) -> bool {
        self.session_re.is_match(cmd)
    }

    fn protected(&self, cmd: &str) -> bool {
        self.protect.iter().any(|r| r.is_match(cmd))
    }
}

/// A class the owner defines in the extra classes file (`procwatch.extra_classes_file` in the engine state directory).
#[derive(serde::Deserialize)]
struct ExtraClass {
    name: String,
    #[serde(default)]
    mode: String,
    cmd_re: String,
    #[serde(default)]
    exclude_re: String,
    #[serde(default)]
    min_age_s: u64,
    #[serde(default)]
    children: bool,
}

#[derive(serde::Deserialize)]
struct ExtraFile {
    #[serde(default)]
    classes: Vec<ExtraClass>,
}

/// The owner's own classes, placed before the shipped ones (they win a tie). The mode is written in the file itself: the file is
/// the owner's explicit choice. A file that does not parse, or a pattern that does not compile, is skipped and reported.
fn extra_classes(st: &Settings) -> Vec<Class> {
    if st.home.is_empty() {
        return Vec::new();
    }
    let path = std::path::Path::new(&st.home)
        .join(defaults::text("paths.base_dir"))
        .join(defaults::text("paths.state_dir"))
        .join(defaults::text("procwatch.extra_classes_file"));
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let file: ExtraFile = match toml::from_str(&text) {
        Ok(f) => f,
        Err(e) => {
            crate::discard::note("procwatch_bad_extra_classes", &e.to_string());
            return Vec::new();
        }
    };
    file.classes
        .into_iter()
        .filter_map(|c| {
            let cmd = compile(&c.cmd_re, &c.name)?;
            let exclude = if c.exclude_re.is_empty() { None } else { compile(&c.exclude_re, &c.name) };
            let mode = match c.mode.as_str() {
                "kill" => Mode::Kill,
                "off" => Mode::Off,
                _ => Mode::Report,
            };
            Some(Class { name: c.name, mode, cmd, exclude, min_age_s: c.min_age_s, children: c.children })
        })
        .collect()
}

/// One orphan candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    /// Process id.
    pub pid: u32,
    /// Parent at listing time.
    pub ppid: u32,
    /// Start time (identity, with the command, against pid reuse).
    pub start_s: u64,
    /// Age in seconds.
    pub age_s: u64,
    /// The class.
    pub class: String,
    /// The class's mode.
    pub mode: Mode,
    /// The full command line.
    pub cmd: String,
    /// The session id the environment names ("" when none).
    pub session_id: String,
    /// `owner_gone`, or `child_of:<pid>`.
    pub reason: String,
}

/// Cut `s` to `n` characters.
pub fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn ancestor_is_live_session(cfg: &Cfg, table: &HashMap<u32, &ProcRow>, row: &ProcRow) -> bool {
    let mut seen = HashSet::new();
    let mut cur = row.ppid;
    while cur > 1 && seen.insert(cur) {
        let Some(p) = table.get(&cur) else { return false };
        if cfg.is_session(&p.cmd) {
            return true;
        }
        cur = p.ppid;
    }
    false
}

/// Is the owner named by `env` gone? A session process with that pid that started before the candidate is a live owner; a
/// different command on that pid (a recycled pid) or none at all is a gone owner. No owner variable: gone when reparented.
fn owner_gone(cfg: &Cfg, table: &HashMap<u32, &ProcRow>, row: &ProcRow, env: &[(String, String)]) -> bool {
    match env_get(env, cfg.owner_var).and_then(|v| v.trim().parse::<u32>().ok()) {
        Some(o) => match table.get(&o) {
            None => true,
            Some(p) => !(cfg.is_session(&p.cmd) && p.start_s <= row.start_s),
        },
        None => true,
    }
}

/// The candidates among `rows`. `own` are the pids the engine itself must never touch (itself and its ancestors).
pub fn classify(host: &mut dyn Host, rows: &[ProcRow], cfg: &Cfg, own: &HashSet<u32>) -> Vec<Finding> {
    let now = host.now_s();
    let table: HashMap<u32, &ProcRow> = rows.iter().map(|r| (r.pid, r)).collect();
    let floor = defaults::num("procwatch.protect_pids_below") as u32;
    let mut out: Vec<Finding> = Vec::new();
    let mut taken: HashSet<u32> = HashSet::new();
    for row in rows {
        if row.pid < floor || own.contains(&row.pid) || cfg.protected(&row.cmd) {
            continue;
        }
        // a root candidate is reparented: its parent is init, or gone
        if !(row.ppid <= 1 || !table.contains_key(&row.ppid)) {
            continue;
        }
        let Some(class) =
            cfg.classes.iter().find(|c| c.mode != Mode::Off && c.cmd.is_match(&row.cmd) && !c.exclude.as_ref().is_some_and(|x| x.is_match(&row.cmd)))
        else {
            continue;
        };
        let age = now.saturating_sub(row.start_s);
        if age < class.min_age_s || ancestor_is_live_session(cfg, &table, row) {
            continue;
        }
        let Some(env) = host.environ(row.pid) else { continue };
        if env_get(&env, cfg.marker).is_none_or(str::is_empty) || !owner_gone(cfg, &table, row, &env) {
            continue;
        }
        taken.insert(row.pid);
        out.push(Finding {
            pid: row.pid,
            ppid: row.ppid,
            start_s: row.start_s,
            age_s: age,
            class: class.name.clone(),
            mode: class.mode,
            cmd: row.cmd.clone(),
            session_id: env_get(&env, cfg.session_var).unwrap_or("").to_string(),
            reason: "owner_gone".to_string(),
        });
        if class.children {
            // the descendants die with their root: they are listed (and, in kill mode, stopped) with it
            let mut kids: HashMap<u32, Vec<&ProcRow>> = HashMap::new();
            for r in rows {
                kids.entry(r.ppid).or_default().push(r);
            }
            let mut stack = vec![row.pid];
            let mut guard = 0usize;
            while let Some(p) = stack.pop() {
                guard += 1;
                if guard > rows.len() {
                    break;
                }
                for k in kids.get(&p).map(Vec::as_slice).unwrap_or(&[]) {
                    if k.pid < floor || own.contains(&k.pid) || cfg.protected(&k.cmd) || !taken.insert(k.pid) {
                        continue;
                    }
                    stack.push(k.pid);
                    out.push(Finding {
                        pid: k.pid,
                        ppid: k.ppid,
                        start_s: k.start_s,
                        age_s: now.saturating_sub(k.start_s),
                        class: class.name.clone(),
                        mode: class.mode,
                        cmd: k.cmd.clone(),
                        session_id: String::new(),
                        reason: format!("child_of:{}", row.pid),
                    });
                }
            }
        }
    }
    out
}

/// What became of one stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// Gone before the first signal (it exited, or was not the process listed any more).
    Gone,
    /// Ended on the polite signal.
    Terminated,
    /// Needed the forced signal.
    Killed,
}

fn same(row: &ProcRow, f: &Finding) -> bool {
    row.start_s == f.start_s && row.cmd == f.cmd
}

/// Stop one finding: re-read that pid, and only if it is still the same process (start time and command) send the polite signal;
/// after the grace re-read again and send the forced signal only if it is still the same process.
pub fn reap(host: &mut dyn Host, f: &Finding, grace_ms: u64) -> Outcome {
    match host.proc_row(f.pid) {
        Some(r) if same(&r, f) => {}
        _ => return Outcome::Gone,
    }
    if !host.signal(f.pid, false) {
        return Outcome::Gone;
    }
    host.sleep_ms(grace_ms);
    match host.proc_row(f.pid) {
        Some(r) if same(&r, f) => {
            if host.signal(f.pid, true) {
                Outcome::Killed
            } else {
                Outcome::Terminated
            }
        }
        _ => Outcome::Terminated,
    }
}
