//! The selection rules of the SessionEnd MCP sweep, as pure functions over a process table.
//!
//! This is the part that decides who may be signalled, so it is the part that must never be broader than the Node hook. It
//! mirrors `hooks/session-end-mcp-reaper.js` (`sweepOrphans`, `matchesInvariant`, `getAgesForPids`, `filterManagedServices`)
//! and `companion/mcp-reaper.js` (`parsePs`, `matchesMcp`, `argv0Basename`) rule for rule. Every pattern, name and number comes
//! from `defaults/mcp_reaper.toml`.
//!
//! Anything the engine cannot decide the way JavaScript would is [`Defer`]: a user pattern whose meaning the translator does
//! not guarantee, a start time that is not in the one form `ps -o lstart=` prints, a local time that is ambiguous or absent in
//! the zone, or a zone the daemon and the hook might read differently. The caller then runs the Node hook before anything is
//! written or signalled.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::taskkit::jsval::number_of_str;
use crate::defaults;
use regex::Regex;
use std::collections::HashMap;

/// The sweep cannot be decided exactly; the Node hook decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Defer;

/// One line of the process listing. The ids are JavaScript numbers.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    /// The process id.
    pub pid: f64,
    /// The parent process id.
    pub ppid: f64,
    /// The command line.
    pub cmd: String,
}

/// The result of running an external command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Run {
    /// Exit status 0 and this standard output.
    Ok(String),
    /// Any failure: not found, a non-zero status, a signal, a timeout.
    Failed,
    /// The output exceeded the byte bound (Node's `maxBuffer` error).
    TooBig,
}

/// Which service manager owns processes on this platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    /// macOS: the `launchctl list` listing.
    Launchd,
    /// Linux: the control-group file of each candidate.
    Systemd,
    /// Anything else: no service-manager filter.
    Other,
}

/// What the selection needs from the machine; the real one runs commands, the tests supply a fake table.
pub trait Sys {
    /// Run `argv` (program first) with the bounds; the environment is the request's.
    fn run(&self, argv: &[String], timeout_ms: u64, max_bytes: u64) -> Run;
    /// The text of a process's control-group file, `None` when it cannot be read.
    fn read_cgroup(&self, pid: f64) -> Option<String>;
    /// The platform's service manager.
    fn platform(&self) -> Platform;
    /// Now, in milliseconds since the epoch.
    fn now_ms(&self) -> f64;
    /// The instant of a local wall-clock time as `new Date(text)` reads it, `None` when it is ambiguous, absent, or read
    /// differently by the hook (so the caller defers).
    fn local_epoch_ms(&self, y: i64, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<f64>;
    /// Send the polite (`forced` false) or the forced signal to a process.
    fn kill(&self, pid: i32, forced: bool);
    /// True for the engine's own process and its parent, which are never signalled.
    fn is_self_or_parent(&self, pid: f64) -> bool;
    /// Wait.
    fn sleep_ms(&self, ms: u64);
}

/// The compiled patterns of `defaults/mcp_reaper.toml`.
pub struct Rules {
    ps_line: Regex,
    etimes_line: Regex,
    lstart_line: Regex,
    lstart_form: Regex,
    launchctl_header: Regex,
    mcp_self: Regex,
    runtime: Regex,
    modelctx: Regex,
    token: Regex,
    token_argv0: Regex,
    start: Regex,
    suffix: Regex,
    scoped: Regex,
    suffix_argv0: Regex,
    runners: Vec<Regex>,
}

/// The rules for the current defaults.
pub fn rules() -> &'static Rules {
    static R: defaults::Cache<Rules> = defaults::Cache::new();
    R.get_or_init(|| {
        let ci = |k: &str| jsre::compile(defaults::text(k), true);
        let cs = |k: &str| jsre::compile(defaults::text(k), false);
        Rules {
            ps_line: cs("mcp_reaper.ps_line_re"),
            etimes_line: cs("mcp_reaper.etimes_line_re"),
            lstart_line: cs("mcp_reaper.lstart_line_re"),
            lstart_form: cs("mcp_reaper.lstart_form_re"),
            launchctl_header: ci("mcp_reaper.launchctl_header_re"),
            mcp_self: ci("mcp_reaper.mcp_self_re"),
            runtime: cs("mcp_reaper.runtime_re"),
            modelctx: ci("mcp_reaper.modelctx_re"),
            token: ci("mcp_reaper.token_re"),
            token_argv0: ci("mcp_reaper.token_argv0_re"),
            start: ci("mcp_reaper.start_re"),
            suffix: ci("mcp_reaper.suffix_re"),
            scoped: ci("mcp_reaper.scoped_re"),
            suffix_argv0: ci("mcp_reaper.suffix_argv0_re"),
            runners: defaults::list("mcp_reaper.runner_exclude_res").into_iter().map(|s| jsre::compile(s, true)).collect(),
        }
    })
}

/// `parsePs(stdout)`: one entry per line that has a pid, a parent pid and a command.
pub fn parse_ps(out: &str) -> Vec<Proc> {
    let re = &rules().ps_line;
    out.split('\n')
        .filter_map(|line| {
            let c = re.captures(line)?;
            Some(Proc { pid: number_of_str(&c[1]), ppid: number_of_str(&c[2]), cmd: c[3].to_string() })
        })
        .collect()
}

/// `argv0Basename(cmd)`: the first white-space-delimited token with everything up to its last slash removed.
pub fn argv0_basename(cmd: &str) -> String {
    let first = js_trim(cmd).split(is_js_space).next().unwrap_or("");
    first.rsplit('/').next().unwrap_or("").to_string()
}

/// `matchesMcp(cmd, extraRe)`: a real MCP command, never a mere mention of one.
pub fn matches_mcp(cmd: &str, extra: Option<&Regex>) -> bool {
    if cmd.is_empty() {
        return false;
    }
    let r = rules();
    if r.mcp_self.is_match(cmd) {
        return false;
    }
    if r.modelctx.is_match(cmd) {
        return true;
    }
    let base = argv0_basename(cmd);
    let runtime = r.runtime.is_match(&base);
    if r.token.is_match(cmd) && (runtime || r.token_argv0.is_match(&base)) {
        return true;
    }
    if r.start.is_match(cmd) && (runtime || base == defaults::text("mcp_reaper.start_program")) {
        return true;
    }
    if (r.suffix.is_match(cmd) || r.scoped.is_match(cmd)) && (runtime || r.suffix_argv0.is_match(&base) || base == defaults::text("mcp_reaper.start_program")) {
        return true;
    }
    extra.is_some_and(|re| re.is_match(cmd))
}

/// `isExcludedRunner(cmd)`: a test runner or dev server.
pub fn is_excluded_runner(cmd: &str) -> bool {
    !cmd.is_empty() && rules().runners.iter().any(|re| re.is_match(cmd))
}

/// `matchesInvariant(p, mcpReaper, extraRe, excludeRe)`: parent PID 1, an MCP signature, and not excluded.
pub fn matches_invariant(p: &Proc, extra: Option<&Regex>, exclude: Option<&Regex>) -> bool {
    if p.ppid != defaults::num("mcp_reaper.orphan_ppid") as f64 {
        return false;
    }
    if !matches_mcp(&p.cmd, extra) {
        return false;
    }
    if exclude.is_some_and(|re| re.is_match(&p.cmd)) {
        return false;
    }
    !is_excluded_runner(&p.cmd)
}

/// `findPid1Cmd(procs)`: the command of the first row whose pid is 1.
pub fn find_pid1_cmd(procs: &[Proc]) -> Option<&str> {
    procs.iter().find(|p| p.pid == 1.0).map(|p| p.cmd.as_str())
}

/// `isInitPid1(cmd)`: PID 1 is an init process, not a container entrypoint.
pub fn is_init_pid1(cmd: Option<&str>) -> bool {
    let Some(cmd) = cmd.filter(|c| !c.is_empty()) else { return false };
    let base = argv0_basename(cmd);
    defaults::list("mcp_reaper.init_names").contains(&base.as_str())
}

/// A pid as JavaScript's `Number.prototype.toString` prints it (the ids here are integers below 2^53).
fn pid_text(pid: f64) -> String {
    format!("{pid}")
}

/// A map keyed by a JavaScript number.
type ByPid = HashMap<u64, f64>;

fn key(pid: f64) -> u64 {
    pid.to_bits()
}

/// `parseEtimesOutput(stdout)`: pid to elapsed seconds.
pub fn parse_etimes(out: &str) -> ByPid {
    let re = &rules().etimes_line;
    out.split('\n').filter_map(|l| re.captures(l)).map(|c| (key(number_of_str(&c[1])), number_of_str(&c[2]))).collect()
}

/// `new Date(text)` for the one form `ps -o lstart=` prints, in local time; `Err` for any other text.
fn lstart_ms(text: &str, sys: &dyn Sys) -> Result<Option<f64>, Defer> {
    let c = rules().lstart_form.captures(text).ok_or(Defer)?;
    let months = defaults::list("mcp_reaper.months");
    let mo = months.iter().position(|m| *m == &c[2]).ok_or(Defer)? as u32 + 1;
    let (d, h, mi, s, y) =
        (number_of_str(&c[3]) as u32, number_of_str(&c[4]) as u32, number_of_str(&c[5]) as u32, number_of_str(&c[6]) as u32, number_of_str(&c[7]) as i64);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo as usize - 1];
    if d < 1 || d > dim || h > defaults::num("mcp_reaper.max_hour") as u32 || y < defaults::num("mcp_reaper.min_year") as i64 {
        return Err(Defer);
    }
    sys.local_epoch_ms(y, mo, d, h, mi, s).map(Some).ok_or(Defer)
}

/// `parseLstartOutput(stdout, nowMs)`: pid to age in seconds; a start time in the future is unknown (left out).
pub fn parse_lstart(out: &str, now_ms: f64, sys: &dyn Sys) -> Result<ByPid, Defer> {
    let re = &rules().lstart_line;
    let mut map = ByPid::new();
    for line in out.split('\n') {
        let Some(c) = re.captures(line) else { continue };
        let pid = number_of_str(&c[1]);
        let Some(start) = lstart_ms(&c[2], sys)? else { continue };
        let age = ((now_ms - start) / 1000.0).floor();
        if age < 0.0 {
            continue;
        }
        map.insert(key(pid), age);
    }
    Ok(map)
}

/// `getAgesForPids(pids)`: elapsed seconds from the elapsed-seconds probe, the start-time probe for the rest. A pid absent
/// from the result has an unknown age and must not be reaped.
pub fn ages_for(pids: &[f64], sys: &dyn Sys) -> Result<ByPid, Defer> {
    let mut result = ByPid::new();
    if pids.is_empty() {
        return Ok(result);
    }
    let probe = |cmd_key: &str, ids: &[f64]| -> Result<Option<String>, Defer> {
        let mut argv: Vec<String> = defaults::list(cmd_key).into_iter().map(str::to_string).collect();
        argv.push(ids.iter().map(|p| pid_text(*p)).collect::<Vec<_>>().join(","));
        match sys.run(&argv, defaults::num("mcp_reaper.probe_timeout_ms"), defaults::num("mcp_reaper.probe_max_bytes")) {
            Run::Ok(s) => Ok(Some(s)),
            Run::Failed => Ok(None),
            Run::TooBig => Err(Defer),
        }
    };
    let etimes = probe("mcp_reaper.etimes_command", pids)?.map(|s| parse_etimes(&s)).unwrap_or_default();
    let missing: Vec<f64> = pids.iter().copied().filter(|p| !etimes.contains_key(&key(*p))).collect();
    let lstart = if missing.is_empty() {
        ByPid::new()
    } else {
        match probe("mcp_reaper.lstart_command", &missing)? {
            Some(s) => parse_lstart(&s, sys.now_ms(), sys)?,
            None => ByPid::new(),
        }
    };
    for p in pids {
        if let Some(a) = etimes.get(&key(*p)).or_else(|| lstart.get(&key(*p))) {
            result.insert(key(*p), *a);
        }
    }
    Ok(result)
}

/// A candidate removed by the service-manager filter, with the reason for the audit log.
#[derive(Debug, Clone, PartialEq)]
pub struct Skipped {
    /// The process.
    pub proc_: Proc,
    /// The audit reason.
    pub reason: &'static str,
}

/// `parseLaunchctlListOutput(stdout)`: the pids the service manager owns.
fn parse_launchctl(out: &str) -> Vec<f64> {
    let header = &rules().launchctl_header;
    out.split('\n')
        .map(js_trim)
        .filter(|t| !t.is_empty() && !header.is_match(t))
        .filter_map(|t| {
            let n = number_of_str(t.split(is_js_space).next().unwrap_or(""));
            (n.is_finite() && n > 0.0).then_some(n)
        })
        .collect()
}

/// `filterManagedServices(candidates)`: drop processes the platform's service manager owns. Only ever shrinks the list.
fn filter_managed(list: Vec<Proc>, sys: &dyn Sys) -> Result<(Vec<Proc>, Vec<Skipped>), Defer> {
    if list.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    match sys.platform() {
        Platform::Launchd => {
            let argv: Vec<String> = defaults::list("mcp_reaper.launchctl_command").into_iter().map(str::to_string).collect();
            let managed = match sys.run(&argv, defaults::num("mcp_reaper.probe_timeout_ms"), defaults::num("mcp_reaper.probe_max_bytes")) {
                Run::Ok(s) => parse_launchctl(&s),
                Run::Failed => {
                    let reason = defaults::text("mcp_reaper.reason_launchd_unverifiable");
                    return Ok((Vec::new(), list.into_iter().map(|p| Skipped { proc_: p, reason }).collect()));
                }
                Run::TooBig => return Err(Defer),
            };
            let (mut kept, mut skipped) = (Vec::new(), Vec::new());
            for p in list {
                if managed.contains(&p.pid) {
                    skipped.push(Skipped { proc_: p, reason: defaults::text("mcp_reaper.reason_launchd") });
                } else {
                    kept.push(p);
                }
            }
            Ok((kept, skipped))
        }
        Platform::Systemd => {
            let (mut kept, mut skipped) = (Vec::new(), Vec::new());
            for p in list {
                if sys.read_cgroup(p.pid).is_some_and(|t| t.contains(defaults::text("mcp_reaper.cgroup_marker"))) {
                    skipped.push(Skipped { proc_: p, reason: defaults::text("mcp_reaper.reason_systemd") });
                } else {
                    kept.push(p);
                }
            }
            Ok((kept, skipped))
        }
        Platform::Other => Ok((list, Vec::new())),
    }
}

/// What the sweep takes from settings and the environment.
pub struct Params<'a> {
    /// The user's extra MCP pattern.
    pub extra: Option<&'a Regex>,
    /// The user's exclusion pattern.
    pub exclude: Option<&'a Regex>,
    /// The age floor in seconds.
    pub min_age_s: f64,
    /// The cap.
    pub max: f64,
}

/// The outcome of the candidate selection.
#[derive(Debug, PartialEq)]
pub struct Sweep {
    /// The processes to signal, in listing order, capped.
    pub candidates: Vec<Proc>,
    /// The candidates the service-manager filter removed.
    pub skipped: Vec<Skipped>,
}

/// `sweepOrphans(procs, mcpReaper, opts)`: PID 1 must be init; then signature, parent PID 1 and the exclusions; then the age
/// floor; then the service-manager filter; then the cap.
pub fn sweep(procs: &[Proc], p: &Params<'_>, sys: &dyn Sys) -> Result<Sweep, Defer> {
    let none = Sweep { candidates: Vec::new(), skipped: Vec::new() };
    if !is_init_pid1(find_pid1_cmd(procs)) {
        return Ok(none);
    }
    let raw: Vec<&Proc> = procs.iter().filter(|q| matches_invariant(q, p.extra, p.exclude)).collect();
    if raw.is_empty() {
        return Ok(none);
    }
    if raw.iter().any(|q| !(q.pid >= 0.0 && q.pid < defaults::num("mcp_reaper.max_exact_id") as f64)) {
        return Err(Defer);
    }
    let ages = ages_for(&raw.iter().map(|q| q.pid).collect::<Vec<_>>(), sys)?;
    let aged: Vec<Proc> = raw.into_iter().filter(|q| ages.get(&key(q.pid)).is_some_and(|a| *a >= p.min_age_s)).cloned().collect();
    if aged.is_empty() {
        return Ok(none);
    }
    let (mut kept, skipped) = filter_managed(aged, sys)?;
    let cap = if p.max >= usize::MAX as f64 { usize::MAX } else { p.max as usize };
    kept.truncate(cap);
    Ok(Sweep { candidates: kept, skipped })
}

/// A user pattern as `new RegExp(pattern, 'i')` would compile it, when the engine can guarantee the same meaning.
///
/// `Ok(None)` is no pattern (empty), exactly as `buildExtraRe` returns null. A pattern the translator does not map exactly
/// (look-around, back-references, named groups, brace quantifiers, non-ASCII text, escapes other than the ASCII class and
/// punctuation ones, a bracket that holds a class JavaScript reads differently) is [`Defer`]: JavaScript might accept it or
/// might throw, and either way the answer is Node's.
pub fn user_pattern(src: &str) -> Result<Option<Regex>, Defer> {
    if src.is_empty() {
        return Ok(None);
    }
    if !src.is_ascii() || src.chars().any(|c| c.is_control()) {
        return Err(Defer);
    }
    let cs: Vec<char> = src.chars().collect();
    let (mut i, mut in_class) = (0usize, false);
    while i < cs.len() {
        let c = cs[i];
        match c {
            '\\' => {
                let Some(n) = cs.get(i + 1) else { return Err(Defer) };
                let class_escape = matches!(n, 'd' | 'w' | 's');
                let outside_only = matches!(n, 'D' | 'W' | 'S' | 'b' | 'B');
                let punct = n.is_ascii_punctuation();
                if !(class_escape || punct || (!in_class && outside_only)) {
                    return Err(Defer);
                }
                i += 2;
                continue;
            }
            '{' | '}' => return Err(Defer),
            '(' if cs.get(i + 1) == Some(&'?') && cs.get(i + 2) != Some(&':') => return Err(Defer),
            '[' if !in_class => {
                in_class = true;
                if cs.get(i + 1) == Some(&']') || (cs.get(i + 1) == Some(&'^') && cs.get(i + 2) == Some(&']')) {
                    return Err(Defer);
                }
            }
            '[' => return Err(Defer),
            ']' if in_class => in_class = false,
            ']' => return Err(Defer),
            _ => {}
        }
        i += 1;
    }
    if in_class {
        return Err(Defer);
    }
    jsre::try_compile(src, true).map(Some).ok_or(Defer)
}
