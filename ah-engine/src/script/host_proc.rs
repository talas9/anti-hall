//! Process primitives of D88 batch 7 (generic, no rules): what a script needs to look at the machine's processes and to end
//! one it has decided to end. Like the rest of `ahHost` they hold no rule about WHICH process: a script reads the listing,
//! applies its own rules and names the pids; these only list, probe, signal and wait, within bounds. Installed by [`install`]
//! from [`super::host::install`]; the `ah.proc.*` / `ah.sleep` shape is built from them by `engine/logic/lib/00-ah.js`.
//!
//! | raw function | what it does |
//! |---|---|
//! | `procList()` | the process table: `{"rows":[{"pid","ppid","cmd"}]}`, or `null` when the listing failed, timed out, was cut or was too big (never an empty table for a listing that did not arrive); the pids it shows are the ones [`proc_signal`] may later signal |
//! | `procAges(pids)` | `{"ages":{"<pid>":seconds}}` for the pids whose age is known (elapsed seconds, else the start time read in local time); a pid with an unknown age is left out; `{"unsure":true}` for an output too big, a start time in a form the engine does not read, an ambiguous local time or a zone the engine and the hook might read differently |
//! | `procManaged(pids)` | `{"platform","managed":[pids],"unverifiable"}`: the pids the platform's service manager owns (macOS: the `launchctl` listing; Linux: the control-group file); `unverifiable` when the listing failed (none can be confirmed unmanaged); `{"unsure":true}` for an output too big |
//! | `procSignal(pid, forced)` | send the polite (`forced` false) or the forced signal to one pid; `true` when it was sent. Refused (returns `false`, nothing sent) for a pid below `hostproc.min_signal_pid`, not an integer that fits the system call, the engine's own process or its parent, a pid the script's own `procList()` in this call did not show, a forced signal for a pid not first signalled politely in this call, and anything past `hostproc.signal_max_per_call` |
//! | `sleep(ms)` | wait; at most `hostproc.sleep_max_ms` at a time and `hostproc.sleep_total_max_ms` in a call; the wait is not script time |
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use super::host::{credit_blocking, with_settings};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::taskkit::jsval::number_of_str;
use crate::defaults;
use regex::Regex;
use rquickjs::{Ctx, Function, Object};
use serde_json::json;
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

unsafe extern "C" {
    /// POSIX `tzset`: re-read the time zone from the environment and the zone files.
    fn tzset();
}

/// The local clock functions keep process-wide state; one conversion at a time.
static CLOCK: Mutex<()> = Mutex::new(());

thread_local! {
    /// The pids the script's own listings of this call showed.
    static SEEN: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
    /// The pids this call signalled politely (a forced signal needs one first).
    static TERMED: RefCell<Vec<u64>> = const { RefCell::new(Vec::new()) };
    /// Signals sent and milliseconds slept in this call.
    static SENT: RefCell<u64> = const { RefCell::new(0) };
    static SLEPT: RefCell<u64> = const { RefCell::new(0) };
}

/// A new script call starts: nothing is seen, signalled or slept yet.
pub(super) fn reset_call() {
    SEEN.with(|s| s.borrow_mut().clear());
    TERMED.with(|s| s.borrow_mut().clear());
    SENT.with(|s| *s.borrow_mut() = 0);
    SLEPT.with(|s| *s.borrow_mut() = 0);
}

/// The result of running an external command.
enum Run {
    /// Exit status 0 and this standard output.
    Ok(String),
    /// Any failure: not found, a non-zero status, a signal, a timeout, output that did not arrive.
    Failed,
    /// The output exceeded the byte bound (Node's `maxBuffer` error).
    TooBig,
}

/// Run `argv` (program first) with the request's environment, stdin closed, stderr dropped, bounded in time and in output.
fn run_cmd(argv: &[String], timeout_ms: u64, max_bytes: u64) -> rquickjs::Result<Run> {
    let Some((prog, args)) = argv.split_first() else { return Ok(Run::Failed) };
    let env = with_settings(|st| st.env.clone())?;
    let started = Instant::now();
    // `script.exec_timeout_scale` stretches this wait too (1 in production; a loaded test machine raises it)
    let r = run_bounded(prog, args, &env, timeout_ms.saturating_mul(defaults::num("script.exec_timeout_scale").max(1)), max_bytes);
    credit_blocking(started);
    Ok(r)
}

fn run_bounded(prog: &str, args: &[String], env: &HashMap<String, String>, timeout_ms: u64, max_bytes: u64) -> Run {
    let _proc = crate::prof::span(crate::prof::Stage::Proc);
    let _git = crate::prof::on().then(|| prog.rsplit('/').next().is_some_and(|b| b.starts_with("git")).then(|| crate::prof::span(crate::prof::Stage::Git))).flatten();
    crate::prof::proc_started();
    let mut cmd = Command::new(prog);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).env_clear();
    for (k, v) in env {
        cmd.env(k, v);
    }
    crate::proc::apply_git_env(&mut cmd);
    let Ok(mut child) = cmd.spawn() else { return Run::Failed };
    let Some(mut out) = child.stdout.take() else { return Run::Failed };
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        crate::discard::harmless((&mut out).take(max_bytes + 1).read_to_end(&mut b)); // keep: a short read is judged by the size below
        // keep draining so the child is never blocked on a full pipe before it is reaped
        crate::discard::harmless(std::io::copy(&mut out, &mut std::io::sink()));
        crate::discard::harmless(tx.send(b)); // keep: the receiver is gone; nobody is waiting for the result
    });
    let start = Instant::now();
    let timeout = Duration::from_millis(timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) if start.elapsed() < timeout => std::thread::sleep(defaults::millis("hostproc.poll_ms")),
            _ => {
                crate::discard::harmless(child.kill()); // keep: reaping a child that already ended
                crate::discard::harmless(child.wait()); // keep: reaping a child that already ended
                return Run::Failed;
            }
        }
    };
    // The output is collected until the pipe closes, within what is left of the timeout (never less than `read_ms`). An output
    // that did not arrive is a failed run, never an empty listing: an empty service-manager listing would leave every
    // candidate unprotected.
    let left = timeout.saturating_sub(start.elapsed()).max(defaults::millis("hostproc.read_ms"));
    let Ok(bytes) = rx.recv_timeout(left) else { return Run::Failed };
    if !status.success() {
        return Run::Failed;
    }
    if bytes.len() as u64 > max_bytes {
        return Run::TooBig;
    }
    Run::Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn argv_of(key: &str) -> Vec<String> {
    defaults::list(key).into_iter().map(str::to_string).collect()
}

fn re_of(key: &str, ci: bool) -> Regex {
    jsre::compile(defaults::text(key), ci)
}

fn key(pid: f64) -> u64 {
    pid.to_bits()
}

fn unsure() -> String {
    r#"{"unsure":true}"#.into()
}

/// `procList()`: see the module table.
pub fn proc_list() -> rquickjs::Result<String> {
    let argv = argv_of("hostproc.list_command");
    let Run::Ok(out) = run_cmd(&argv, defaults::num("hostproc.list_timeout_ms"), defaults::num("hostproc.list_max_bytes"))? else { return Ok("null".into()) };
    let re = re_of("hostproc.list_line_re", false);
    let mut rows = Vec::new();
    for line in out.split('\n') {
        let Some(c) = re.captures(line) else { continue };
        let (pid, ppid) = (number_of_str(&c[1]), number_of_str(&c[2]));
        SEEN.with(|s| {
            let mut s = s.borrow_mut();
            if !s.contains(&key(pid)) {
                s.push(key(pid));
            }
        });
        rows.push(json!({"pid": pid, "ppid": ppid, "cmd": &c[3]}));
    }
    Ok(json!({"rows": rows}).to_string())
}

/// `parseEtimesOutput(stdout)`: pid to elapsed seconds.
fn parse_etimes(out: &str) -> HashMap<u64, f64> {
    let re = re_of("hostproc.etimes_line_re", false);
    out.split('\n').filter_map(|l| re.captures(l)).map(|c| (key(number_of_str(&c[1])), number_of_str(&c[2]))).collect()
}

/// The instant of a local wall-clock time as `new Date(text)` reads it; `None` when it is ambiguous, absent, or read differently
/// by the hook (the zones differ).
fn local_epoch_ms(tz_agrees: bool, y: i64, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<f64> {
    if !tz_agrees {
        return None;
    }
    let _g = CLOCK.lock().unwrap_or_else(|e| e.into_inner());
    // SAFETY: tzset only reads the environment and the zone files; the lock above serializes this module's use of the
    // process-wide zone state.
    unsafe { tzset() };
    let wall = |t: &libc::tm| (i64::from(t.tm_year) + 1900, t.tm_mon as u32 + 1, t.tm_mday as u32, t.tm_hour as u32, t.tm_min as u32, t.tm_sec as u32);
    let mut valid: Vec<i64> = Vec::new();
    for isdst in [-1, 0, 1] {
        // SAFETY: a zeroed `tm` is a valid value of the plain C struct (a null zone pointer is allowed).
        let mut tm: libc::tm = unsafe { std::mem::zeroed() };
        tm.tm_year = (y - 1900) as libc::c_int;
        tm.tm_mon = mo as libc::c_int - 1;
        tm.tm_mday = d as libc::c_int;
        tm.tm_hour = h as libc::c_int;
        tm.tm_min = mi as libc::c_int;
        tm.tm_sec = s as libc::c_int;
        tm.tm_isdst = isdst;
        // SAFETY: `tm` is a valid, initialized struct owned by this frame.
        let t = unsafe { libc::mktime(&mut tm) };
        if t == -1 || valid.contains(&(t as i64)) {
            continue;
        }
        // SAFETY: as above; `back` is written by localtime_r and read only after it returns non-null.
        let mut back: libc::tm = unsafe { std::mem::zeroed() };
        let tt = t;
        // SAFETY: both pointers refer to live locals of this frame.
        let ok = unsafe { !libc::localtime_r(&tt, &mut back).is_null() };
        if ok && wall(&back) == (y, mo, d, h, mi, s) {
            valid.push(t as i64);
        }
    }
    // exactly one instant has this wall-clock time: an ambiguous (clock set back) or absent (clock set forward) time is Node's
    (valid.len() == 1).then(|| valid[0] as f64 * 1000.0)
}

/// `new Date(text)` for the one form `ps -o lstart=` prints, in local time; `Err` for any other text.
fn lstart_ms(text: &str, tz_agrees: bool) -> Result<f64, ()> {
    let c = re_of("hostproc.lstart_form_re", false).captures(text).ok_or(())?;
    let months = defaults::list("hostproc.months");
    let mo = months.iter().position(|m| *m == &c[2]).ok_or(())? as u32 + 1;
    let (d, h, mi, s, y) =
        (number_of_str(&c[3]) as u32, number_of_str(&c[4]) as u32, number_of_str(&c[5]) as u32, number_of_str(&c[6]) as u32, number_of_str(&c[7]) as i64);
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo as usize - 1];
    if d < 1 || d > dim || h > defaults::num("hostproc.max_hour") as u32 || y < defaults::num("hostproc.min_year") as i64 {
        return Err(());
    }
    local_epoch_ms(tz_agrees, y, mo, d, h, mi, s).ok_or(())
}

/// `parseLstartOutput(stdout, nowMs)`: pid to age in seconds; a start time in the future is unknown (left out).
fn parse_lstart(out: &str, now_ms: f64, tz_agrees: bool) -> Result<HashMap<u64, f64>, ()> {
    let re = re_of("hostproc.lstart_line_re", false);
    let mut map = HashMap::new();
    for line in out.split('\n') {
        let Some(c) = re.captures(line) else { continue };
        let pid = number_of_str(&c[1]);
        let start = lstart_ms(&c[2], tz_agrees)?;
        let age = ((now_ms - start) / 1000.0).floor();
        if age < 0.0 {
            continue;
        }
        map.insert(key(pid), age);
    }
    Ok(map)
}

/// `procAges(pids)`: see the module table.
pub fn proc_ages(pids_json: &str) -> rquickjs::Result<String> {
    let pids: Vec<f64> = serde_json::from_str::<Vec<f64>>(pids_json).unwrap_or_default();
    let max_id = defaults::num("hostproc.max_exact_id") as f64;
    if pids.iter().any(|p| !(*p >= 0.0 && *p < max_id)) {
        return Ok(unsure());
    }
    if pids.is_empty() {
        return Ok(json!({"ages": {}}).to_string());
    }
    let tz = defaults::text("hostproc.tz_env");
    let tz_agrees = with_settings(|st| st.env.get(tz).cloned())? == std::env::var(tz).ok();
    let probe = |cmd_key: &str, ids: &[f64]| -> rquickjs::Result<Result<Option<String>, ()>> {
        let mut argv = argv_of(cmd_key);
        argv.push(ids.iter().map(|p| format!("{p}")).collect::<Vec<_>>().join(","));
        Ok(match run_cmd(&argv, defaults::num("hostproc.probe_timeout_ms"), defaults::num("hostproc.probe_max_bytes"))? {
            Run::Ok(s) => Ok(Some(s)),
            Run::Failed => Ok(None),
            Run::TooBig => Err(()),
        })
    };
    let Ok(etimes_out) = probe("hostproc.etimes_command", &pids)? else { return Ok(unsure()) };
    let etimes = etimes_out.map(|s| parse_etimes(&s)).unwrap_or_default();
    let missing: Vec<f64> = pids.iter().copied().filter(|p| !etimes.contains_key(&key(*p))).collect();
    let lstart = if missing.is_empty() {
        HashMap::new()
    } else {
        let Ok(out) = probe("hostproc.lstart_command", &missing)? else { return Ok(unsure()) };
        match out {
            Some(s) => match parse_lstart(&s, super::host::now_ms(), tz_agrees) {
                Ok(m) => m,
                Err(()) => return Ok(unsure()),
            },
            None => HashMap::new(),
        }
    };
    let mut ages = serde_json::Map::new();
    for p in &pids {
        if let Some(a) = etimes.get(&key(*p)).or_else(|| lstart.get(&key(*p))) {
            ages.insert(format!("{p}"), json!(a));
        }
    }
    Ok(json!({"ages": ages}).to_string())
}

/// `parseLaunchctlListOutput(stdout)`: the pids the service manager owns.
fn parse_launchctl(out: &str) -> Vec<f64> {
    let header = re_of("hostproc.service_header_re", true);
    out.split('\n')
        .map(js_trim)
        .filter(|t| !t.is_empty() && !header.is_match(t))
        .filter_map(|t| {
            let n = number_of_str(t.split(is_js_space).next().unwrap_or(""));
            (n.is_finite() && n > 0.0).then_some(n)
        })
        .collect()
}

/// `procManaged(pids)`: see the module table.
pub fn proc_managed(pids_json: &str) -> rquickjs::Result<String> {
    let pids: Vec<f64> = serde_json::from_str::<Vec<f64>>(pids_json).unwrap_or_default();
    let os = std::env::consts::OS;
    if os == defaults::text("hostproc.platform_launchd") {
        let argv = argv_of("hostproc.service_list_command");
        return Ok(match run_cmd(&argv, defaults::num("hostproc.probe_timeout_ms"), defaults::num("hostproc.probe_max_bytes"))? {
            Run::Ok(s) => {
                let owned = parse_launchctl(&s);
                let managed: Vec<f64> = pids.iter().copied().filter(|p| owned.contains(p)).collect();
                json!({"platform": "launchd", "managed": managed, "unverifiable": false}).to_string()
            }
            Run::Failed => json!({"platform": "launchd", "managed": [], "unverifiable": true}).to_string(),
            Run::TooBig => unsure(),
        });
    }
    if os == defaults::text("hostproc.platform_systemd") {
        let marker = defaults::text("hostproc.cgroup_marker");
        let managed: Vec<f64> = pids
            .iter()
            .copied()
            .filter(|p| {
                let path = defaults::text("hostproc.cgroup_path").replace("{pid}", &format!("{p}"));
                std::fs::read_to_string(path).is_ok_and(|t| t.contains(marker))
            })
            .collect();
        return Ok(json!({"platform": "systemd", "managed": managed, "unverifiable": false}).to_string());
    }
    Ok(json!({"platform": "other", "managed": [], "unverifiable": false}).to_string())
}

/// `procSignal(pid, forced)`: see the module table.
pub fn proc_signal(pid: f64, forced: bool) -> bool {
    if pid.fract() != 0.0 || !(defaults::num("hostproc.min_signal_pid") as f64..=f64::from(i32::MAX)).contains(&pid) {
        return false;
    }
    // SAFETY: getppid takes no arguments and cannot fail.
    let ppid = unsafe { libc::getppid() };
    if pid == f64::from(std::process::id()) || pid == f64::from(ppid) {
        return false;
    }
    if !SEEN.with(|s| s.borrow().contains(&key(pid))) || (forced && !TERMED.with(|s| s.borrow().contains(&key(pid)))) {
        return false;
    }
    if SENT.with(|n| {
        let mut n = n.borrow_mut();
        *n += 1;
        *n > defaults::num("hostproc.signal_max_per_call")
    }) {
        return false;
    }
    if !forced {
        TERMED.with(|s| s.borrow_mut().push(key(pid)));
    }
    let sig = if forced { libc::SIGKILL } else { libc::SIGTERM };
    // SAFETY: a plain signal to a validated pid (at least the minimum, not this process or its parent, shown by this call's own
    // listing); failure (already gone) is fine.
    unsafe { libc::kill(pid as libc::pid_t, sig) };
    true
}

/// `sleep(ms)`: see the module table.
pub fn sleep(ms: f64) {
    if !ms.is_finite() || ms <= 0.0 {
        return;
    }
    let want = (ms as u64).min(defaults::num("hostproc.sleep_max_ms"));
    let left = SLEPT.with(|t| defaults::num("hostproc.sleep_total_max_ms").saturating_sub(*t.borrow()));
    let take = want.min(left);
    if take == 0 {
        return;
    }
    SLEPT.with(|t| *t.borrow_mut() += take);
    let started = Instant::now();
    std::thread::sleep(Duration::from_millis(take));
    credit_blocking(started);
}

/// Add the process functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("procList", Function::new(c.clone(), proc_list)?)?;
    h.set("procAges", Function::new(c.clone(), |p: String| proc_ages(&p))?)?;
    h.set("procManaged", Function::new(c.clone(), |p: String| proc_managed(&p))?)?;
    h.set("procSignal", Function::new(c.clone(), |pid: f64, forced: bool| proc_signal(pid, forced))?)?;
    h.set("sleep", Function::new(c.clone(), sleep)?)?;
    Ok(())
}
