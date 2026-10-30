//! Engine health state, all inside the engine's own state dir (`paths::dir()`): the event log, the
//! client circuit breaker, crash-loop protection, failure classification and the once-per-session
//! advisory. Every function is best-effort: a state-dir problem must never break a hook call.
pub mod starts;

use crate::config::ClientConfig;
use crate::defaults;
use crate::paths;
use regex::Regex;
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

/// File name of the event log inside the state directory.
pub fn log_name() -> &'static str {
    defaults::text("files.log")
}

/// Event kinds that count toward the crash-loop threshold.
fn crashy() -> Vec<&'static str> {
    defaults::list("health.crashy_kinds")
}

/// Milliseconds since the Unix epoch (0 if the clock is before it).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A file inside the state directory, named by the `files.<key>` setting.
fn state_file(key: &str) -> PathBuf {
    file(defaults::text(&format!("files.{key}")))
}

fn file(name: &str) -> PathBuf {
    paths::dir().join(name)
}

fn clean(s: &str) -> String {
    s.chars().map(|c| if c == '\n' || c == '\t' || c == '\r' { ' ' } else { c }).take(defaults::num("health.event_text_max") as usize).collect()
}

// ---- event log ---------------------------------------------------------------------------------

/// One line of the event log.
#[derive(Debug, Clone)]
pub struct Event {
    /// When it happened (ms since the epoch).
    pub ts: u64,
    /// Event kind, e.g. `start`, `watchdog`.
    pub kind: String,
    /// Stable error code, `-` when not applicable.
    pub code: String,
    /// Free text, newlines removed.
    pub detail: String,
}

fn event_line(kind: &str, code: &str, detail: &str) -> String {
    format!("{}\t{}\t{}\t{}\n", now_ms(), clean(kind), clean(code), clean(detail))
}

/// The event log's lock file: appends hold it shared, the trim holds it exclusive, so a trim never drops a line another
/// process appended between its read and its replace (review finding 9).
fn log_lock(log: &std::path::Path) -> Option<std::fs::File> {
    std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(crate::paths::lock_for(log)).ok()
}

pub(crate) fn flock(f: &std::fs::File, op: libc::c_int) -> bool {
    use std::os::unix::io::AsRawFd;
    // SAFETY: `f` is an open file owned by the caller, so its descriptor is valid; flock takes only it and a flag.
    unsafe { libc::flock(f.as_raw_fd(), op) == 0 }
}

/// Keep the last `health.log_keep_lines` lines once the log passes `health.log_cap`: written to a temporary file and renamed
/// over the log under the exclusive lock (a crash leaves the old log or the new one, never a cut one). A trim already in
/// progress elsewhere is left to finish.
fn trim_log(p: &std::path::Path) {
    if !std::fs::metadata(p).is_ok_and(|m| m.len() > defaults::num("health.log_cap")) {
        return;
    }
    let Some(lock) = log_lock(p) else { return };
    if !flock(&lock, libc::LOCK_EX | libc::LOCK_NB) {
        return;
    }
    if let Ok(t) = std::fs::read_to_string(p)
        && t.len() as u64 > defaults::num("health.log_cap")
    {
        let keep: Vec<&str> = t.lines().rev().take(defaults::num("health.log_keep_lines") as usize).collect::<Vec<_>>().into_iter().rev().collect();
        if let Err(e) = crate::atomic::write(p, keep.join("\n") + "\n") {
            crate::discard::harmless(std::io::stderr().write_all(event_line("health", "log_trim_failed", &e.to_string()).as_bytes())); // keep: a closed pipe leaves nobody to tell
        }
    }
}

fn append_event_line(line: &str) -> std::io::Result<()> {
    append_to(&file(log_name()), line)
}

fn append_to(p: &std::path::Path, line: &str) -> std::io::Result<()> {
    trim_log(p);
    let lock = log_lock(p);
    // an unlockable log is still appended to, only unordered against a trim
    let _shared = lock.as_ref().is_some_and(|l| flock(l, libc::LOCK_SH));
    std::fs::OpenOptions::new().create(true).append(true).open(p)?.write_all(line.as_bytes())
}

/// Append `ts<TAB>kind<TAB>code<TAB>detail`. The log is trimmed to its last `health.log_keep_lines` lines once it passes
/// `health.log_cap`. When the log exists in principle but cannot be written (a full disk, a permission or path error) the line
/// goes to stderr instead, never nowhere (review finding 9). A state directory that does not exist (no engine ever ran for
/// this home, as in a hook answered in-process; a regular file where `~/.anti-hall` should be is the same: no state dir can exist) is not an error: the line is dropped, so a hook's stderr stays what the Node
/// hook prints.
pub fn log_event(kind: &str, code: &str, detail: &str) {
    let line = event_line(kind, code, detail);
    let line = match queue_line(line) {
        None => return,
        Some(line) => line,
    };
    if let Err(e) = append_event_line(&line)
        && !matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory)
    {
        crate::discard::harmless(std::io::stderr().write_all(line.as_bytes())); // keep: a closed pipe leaves nobody to tell
    }
}

/// What the daemon's log thread receives: a line, or a request to say when everything before it is written.
enum LogMsg {
    Line(String),
    Flush(std::sync::mpsc::Sender<()>),
}

static LOG_QUEUE: std::sync::OnceLock<std::sync::mpsc::SyncSender<LogMsg>> = std::sync::OnceLock::new();

/// Hand a line to the log thread; `Some(line)` gives it back when there is no thread (any process but the daemon) or its queue is full,
/// and the caller then appends it itself.
fn queue_line(line: String) -> Option<String> {
    let Some(tx) = LOG_QUEUE.get() else { return Some(line) };
    match tx.try_send(LogMsg::Line(line)) {
        Ok(()) => None,
        Err(std::sync::mpsc::TrySendError::Full(LogMsg::Line(l)) | std::sync::mpsc::TrySendError::Disconnected(LogMsg::Line(l))) => Some(l),
        Err(_) => None,
    }
}

/// The daemon's single log writer: lines are queued by every worker and written in batches (one stat, one lock, one open and one
/// write per batch instead of per line; with four workers the per-line lock was where they waited). Other processes (hook calls,
/// one-shot commands) still append directly under the same shared lock, so the trim keeps its guarantee.
pub fn start_log_thread() {
    let (tx, rx) = std::sync::mpsc::sync_channel::<LogMsg>(defaults::num("health.log_queue") as usize);
    if LOG_QUEUE.set(tx).is_err() {
        return;
    }
    let batch_max = defaults::num("health.log_batch") as usize;
    let spawned = std::thread::Builder::new().name("ah-log".into()).spawn(move || {
        let mut acks: Vec<std::sync::mpsc::Sender<()>> = Vec::new();
        while let Ok(first) = rx.recv() {
            let mut text = String::new();
            let mut n = 0;
            let mut next = Some(first);
            while let Some(m) = next.take() {
                match m {
                    LogMsg::Line(l) => text.push_str(&l),
                    LogMsg::Flush(a) => acks.push(a),
                }
                n += 1;
                if n < batch_max {
                    next = rx.try_recv().ok();
                }
            }
            if !text.is_empty()
                && let Err(e) = append_event_line(&text)
                && !matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory)
            {
                crate::discard::harmless(std::io::stderr().write_all(text.as_bytes())); // keep: a closed pipe leaves nobody to tell
            }
            for a in acks.drain(..) {
                crate::discard::harmless(a.send(())); // keep: the waiter may have given up
            }
        }
    });
    crate::discard::logged("log_thread_spawn", spawned.map(drop));
}

/// Wait (bounded) until every line queued so far is on disk: for the daemon's exit and for a reader that must see its own lines.
pub fn flush_log() {
    let Some(tx) = LOG_QUEUE.get() else { return };
    let (ack, done) = std::sync::mpsc::channel();
    if tx.send(LogMsg::Flush(ack)).is_ok() {
        crate::discard::harmless(done.recv_timeout(defaults::millis("health.log_flush_ms"))); // keep: a stuck writer must not hold the exit
    }
}

/// Append an event; false when it could not be written (the caller keeps it to try again).
pub fn try_log_event(kind: &str, code: &str, detail: &str) -> bool {
    append_event_line(&event_line(kind, code, detail)).is_ok()
}

/// Append an event, or write the exact sanitized event line to stderr when the state-dir log is unavailable for any reason.
pub fn log_event_or_stderr(kind: &str, code: &str, detail: &str) {
    let line = event_line(kind, code, detail);
    if append_event_line(&line).is_err() {
        crate::discard::harmless(std::io::stderr().write_all(line.as_bytes())); // keep: a closed pipe leaves nobody to tell
    }
}

/// Every line of the event log, oldest first.
pub fn events() -> Vec<Event> {
    let Ok(t) = std::fs::read_to_string(file(log_name())) else { return vec![] };
    t.lines()
        .filter_map(|l| {
            let mut it = l.splitn(4, '\t');
            Some(Event { ts: it.next()?.parse().ok()?, kind: it.next()?.into(), code: it.next()?.into(), detail: it.next().unwrap_or("").into() })
        })
        .collect()
}

fn count_recent(kinds: &[&str], window: Duration) -> usize {
    let floor = now_ms().saturating_sub(window.as_millis() as u64);
    events().iter().filter(|e| e.ts >= floor && kinds.contains(&e.kind.as_str())).count()
}

/// Like [`count_recent`], but events at or before the last crash-loop trip or reset do not count: a loop that was already
/// judged (and then waited out, reset by an operator, or left behind by a new binary) must not trip again on the same events.
fn count_recent_after_trip(kinds: &[&str], window: Duration) -> usize {
    let all = events();
    let judged = all.iter().filter(|e| defaults::list("health.judged_kinds").contains(&e.kind.as_str())).map(|e| e.ts).max().unwrap_or(0);
    let floor = now_ms().saturating_sub(window.as_millis() as u64).max(judged.saturating_add(1));
    all.iter().filter(|e| e.ts >= floor && kinds.contains(&e.kind.as_str())).count()
}

// ---- classification ----------------------------------------------------------------------------

/// Who can fix a failure.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Class {
    /// Caused by the machine (disk, permissions, path length, OS kill): the user can fix it.
    Env,
    /// Not caused by the environment (crash loop on a healthy machine, panic, invariant): a bug.
    Permanent,
}

/// Classify an error code (`os<errno>`, `sig<n>`, `unsafe_dir`, `panic`, ...) and give a plain self-fix hint.
///
/// The code groups, their class and the hint message keys come from `health.error_codes` in the defaults; a code
/// that is not listed is a permanent failure with no hint.
pub fn classify(code: &str) -> (Class, String) {
    for group in defaults::raw("health.error_codes").as_array().unwrap_or_default() {
        let listed = group.get("codes").is_some_and(|c| c.strings().contains(&code));
        if !listed {
            continue;
        }
        let class = if group.str_field("class") == "env" { Class::Env } else { Class::Permanent };
        let key = group.str_field("hint");
        return (class, if key.is_empty() { String::new() } else { hint_text(key) });
    }
    (Class::Permanent, String::new())
}

/// A hint message (by its `msg.` key) with its placeholders filled (state dir, env var names).
pub fn hint_text(key: &str) -> String {
    let state_dir = format!("~/{}/{}", defaults::text("paths.base_dir"), defaults::text("paths.state_dir"));
    defaults::render(key, &[("state_dir", &state_dir), ("env_dir", &defaults::env_name("dir")), ("env_mem", &defaults::env_of("daemon.mem_mb").unwrap_or(""))])
}

/// Record a failure for the advisory: `failure.json` {ts, class, kind, code, hint, reason}.
pub fn record_failure(kind: &str, code: &str, reason: &str) {
    let (class, hint) = classify(code);
    let v = json!({"ts": now_ms(), "class": if class == Class::Env {"env"} else {"permanent"}, "kind": kind, "code": code, "hint": hint, "reason": reason});
    if let Err(e) = crate::atomic::write(state_file("failure"), v.to_string()) {
        // without the record no advisory is ever shown; the log still has the failure itself
        log_event_or_stderr("health", "failure_record_write_failed", &format!("{kind}/{code}: {e}"));
    }
}

pub(crate) fn read_json(key: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(state_file(key)).ok()?).ok()
}

/// Write the latest crash report. Used by the panic hook and by stale-run-marker reaping.
pub fn write_crash_report(v: &Value) {
    crate::discard::logged("crash_report_write", crate::atomic::write(state_file("last_crash"), v.to_string()));
}

/// Write the latest crash report of a non-daemon process (CLI verb or hook client); never counted as a daemon crash.
pub fn write_cli_crash_report(v: &Value) {
    crate::discard::logged("cli_crash_report_write", crate::atomic::write(state_file("cli_crash"), v.to_string()));
}

/// The last crash report of a non-daemon process.
pub fn cli_crash() -> Option<Value> {
    read_json("cli_crash")
}

/// The last recorded crash report.
pub fn last_crash() -> Option<Value> {
    read_json("last_crash")
}

/// Write the current boundary breadcrumb so an abort or SIGSEGV leaves useful context for the next start.
pub fn write_crash_breadcrumb(request: &str, event: &str, check: &str, uptime_s: u64, memory: Value) {
    let v = json!({
        "ts": now_ms(),
        "pid": std::process::id(),
        "request": request,
        "event": event,
        "check": check,
        "uptime_s": uptime_s,
        "memory": memory,
    });
    // written at every request: a full sync of this file cost a few milliseconds of every hook call and buys nothing, a process
    // crash leaves what was written in the page cache; only a power cut right after the rename could lose the context
    let style = crate::atomic::Style { skip_sync: true, ..crate::atomic::Style::default() };
    crate::discard::logged("crash_breadcrumb_write", crate::atomic::write_styled(state_file("crash_breadcrumb"), v.to_string(), style));
}

/// A healthy start clears an environment-class failure (the user fixed it); permanent ones stay.
pub fn clear_env_failure() {
    if read_json("failure").and_then(|v| v["class"].as_str().map(|c| c == "env")).unwrap_or(false) {
        crate::discard::harmless(std::fs::remove_file(state_file("failure"))); // keep: cleanup that raced; an absent file is the goal state
    }
}

// ---- pids and the run marker ---------------------------------------------------------------------

/// True when a process with this pid exists (signal 0).
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a pid that already exited just fails with ESRCH.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The command line of `pid` as the probe command in `health.pid_probe` reports it (empty when it cannot be read).
///
/// It runs on the hook path (a client deciding whether to start a daemon), so it never blocks: Linux reads
/// `health.proc_cmdline` directly, and elsewhere the probe runs bounded by `health.probe_timeout_ms` (review finding 6).
pub(crate) fn process_command(pid: u32) -> String {
    if cfg!(target_os = "linux")
        && let Ok(raw) = std::fs::read(defaults::text("health.proc_cmdline").replace("{pid}", &pid.to_string()))
    {
        return String::from_utf8_lossy(&raw).replace('\0', " ");
    }
    probe_output(defaults::list("health.pid_probe"), pid)
}

/// Run a probe command (`program`, then its arguments with `{pid}` substituted) under `health.probe_timeout_ms`; its stdout,
/// or empty when it cannot run or does not finish in time.
pub(crate) fn probe_output(probe: Vec<&str>, pid: u32) -> String {
    let Some((program, args)) = probe.split_first() else { return String::new() };
    let mut cmd = std::process::Command::new(program);
    cmd.args(args.iter().map(|a| a.replace("{pid}", &pid.to_string())));
    crate::proc::run(cmd, program, defaults::millis("health.probe_timeout_ms"), defaults::millis("health.probe_poll_ms"))
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// True when `pid` is a live process running `<this binary> serve`.
pub fn pid_is_engine(pid: u32) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    // Linux reports a replaced binary's `/proc/<pid>/exe` with a trailing " (deleted)"; a binary update must not disable this check.
    let exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .map(|n| n.strip_suffix(" (deleted)").map(str::to_string).unwrap_or(n))
        .unwrap_or_default();
    let cmd = process_command(pid);
    !exe.is_empty() && cmd.contains(&exe) && cmd.contains(&format!(" {}", defaults::text("health.serve_arg")))
}

/// Record that a daemon is running, so a later start can tell a crash from a clean exit.
pub fn write_marker() {
    crate::discard::logged("run_marker_write", crate::atomic::write(state_file("run_marker"), std::process::id().to_string()));
}

/// The canonical state directory: the instance identity a heartbeat records and a client compares (two spellings of one
/// directory, a symlinked temp dir for one, must not read as two instances).
fn instance_dir() -> PathBuf {
    let d = paths::dir();
    std::fs::canonicalize(&d).unwrap_or(d)
}

/// Start the daemon's liveness heartbeat (`files.heartbeat`). The file names this process generation, one field per line: pid,
/// start time and executable as the operating system reports them ([`crate::procid`]), and the instance (state dir); a field the
/// system will not give is left empty, and a client then never signals that daemon. The executable is informational only: a binary
/// update replaces it under a surviving daemon (Linux then reports `<path> (deleted)`), so it is not part of the generation. [`heartbeat`] touches its modification
/// time at the start of every watchdog tick; a stopped or wedged process stops touching it.
pub fn heartbeat_init() {
    let pid = std::process::id();
    let start = crate::procid::start(pid).map(|s| s.to_string()).unwrap_or_default();
    let exe = crate::procid::exe(pid).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let ident = format!("{pid}\n{start}\n{exe}\n{}\n", instance_dir().to_string_lossy());
    crate::discard::logged("heartbeat_write", crate::atomic::write(state_file("heartbeat"), ident));
}

/// One heartbeat: touch the file's modification time (no data written).
pub fn heartbeat() {
    if let Ok(f) = std::fs::File::options().write(true).open(state_file("heartbeat")) {
        crate::discard::harmless(f.set_modified(std::time::SystemTime::now())); // keep: a missed beat only makes a slow reply fail open sooner
    }
}

/// One reading of the daemon's heartbeat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Heartbeat {
    /// The pid the heartbeat names.
    pub pid: u32,
    /// The whole file: the generation identity (pid, start time, executable, state dir).
    pub ident: String,
    /// Its modification time, nanoseconds since the epoch: changes on every beat.
    pub mtime_ns: u128,
    /// How old that modification time is by the wall clock (0 when it is in the future).
    pub age: Duration,
}

impl Heartbeat {
    /// The generation it names, as its OS start time, when the heartbeat belongs to this instance and records one; `None` = its
    /// generation cannot be established here (another instance's file, a heartbeat from before generation identity, a field the
    /// system would not give), and that daemon is never signalled. Identity is pid + start time + canonical state dir; the recorded
    /// executable is skipped (a binary update changes its path under a live daemon).
    pub(crate) fn generation(&self) -> Option<u64> {
        let mut f = self.ident.lines().skip(1);
        let start = f.next()?.parse::<u64>().ok()?;
        f.next()?; // the executable: informational only
        (std::path::Path::new(f.next()?) == instance_dir()).then_some(start)
    }

    /// True while `pid` is still the generation this heartbeat names: the same OS start time.
    pub(crate) fn names_running(&self) -> bool {
        self.generation().is_some_and(|start| crate::procid::start(self.pid) == Some(start))
    }
}

/// The daemon's heartbeat, counted only when it names the pid that holds the singleton lock (the daemon now serving the socket).
/// `None` = unknown (no heartbeat yet, a daemon still starting whose watchdog has not begun, a build from before the heartbeat,
/// an unreadable file), which counts as alive.
pub(crate) fn heartbeat_of_lock_holder() -> Option<Heartbeat> {
    let p = state_file("heartbeat");
    let ident = std::fs::read_to_string(&p).ok()?;
    let pid: u32 = ident.lines().next()?.trim().parse().ok()?;
    let holder: u32 = std::fs::read_to_string(paths::lock_for(&paths::socket())).ok()?.trim().parse().ok()?;
    let mtime = std::fs::metadata(&p).and_then(|m| m.modified()).ok()?;
    let mtime_ns = mtime.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    (pid != 0 && pid == holder).then(|| Heartbeat { pid, ident, mtime_ns, age: mtime.elapsed().unwrap_or_default() })
}

/// The system-wide monotonic clock in milliseconds: comparable across the short-lived client processes (std's `Instant` is not
/// serialisable) and never stepped by a wall-clock change.
pub(crate) fn mono_ms() -> u64 {
    // SAFETY: a zeroed timespec is a valid value of the plain C struct.
    let mut ts: libc::timespec = unsafe { std::mem::zeroed() };
    // SAFETY: `ts` is a live, writable timespec; CLOCK_MONOTONIC is always available on the supported systems.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    (ts.tv_sec.max(0) as u64).saturating_mul(1000).saturating_add(ts.tv_nsec.max(0) as u64 / 1_000_000)
}

/// What one stale heartbeat sample means.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Hang {
    /// First seen stale, or seen stale again within `client.heartbeat_confirm_ms`: the call fails open, nothing is signalled.
    Suspected,
    /// The same generation's heartbeat stayed unchanged for at least `client.heartbeat_confirm_ms` of monotonic time.
    Confirmed(u64),
}

/// The suspicion file (`files.heartbeat_suspect`): `<mono ms first seen stale>\n<mtime ns>\n<identity>`.
fn read_suspicion() -> Option<(u64, u128, String)> {
    let t = std::fs::read_to_string(state_file("heartbeat_suspect")).ok()?;
    let mut it = t.splitn(3, '\n');
    Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?, it.next()?.to_string()))
}

/// How long (monotonic ms) the suspicion has held this exact heartbeat (same generation, same modification time); `None` when
/// the recorded suspicion is about another heartbeat, or there is none.
fn suspicion_held(hb: &Heartbeat) -> Option<u64> {
    let (first, mtime, ident) = read_suspicion()?;
    (mtime == hb.mtime_ns && ident == hb.ident).then(|| mono_ms().checked_sub(first)).flatten()
}

/// Weigh one stale sample of `hb`. A hang is confirmed only when a suspicion raised earlier saw this same heartbeat (same
/// generation, same modification time) at least `client.heartbeat_confirm_ms` ago by the monotonic clock: any beat in between,
/// a new generation, or a wall-clock jump that only made a moving heartbeat read old, resets it. Otherwise the suspicion is
/// (re)recorded for the next call.
pub(crate) fn weigh_stale(hb: &Heartbeat) -> Hang {
    match suspicion_held(hb) {
        Some(held) if held >= defaults::num("client.heartbeat_confirm_ms") => Hang::Confirmed(held),
        Some(_) => Hang::Suspected,
        None => {
            crate::discard::harmless(crate::limits::ensure_private_dir(&paths::dir())); // keep: the write below reports failure by absence
            let line = format!("{}\n{}\n{}", mono_ms(), hb.mtime_ns, hb.ident);
            crate::discard::logged("heartbeat_suspect_write", crate::atomic::write(state_file("heartbeat_suspect"), line));
            Hang::Suspected
        }
    }
}

/// True while the recorded suspicion still holds `hb` unchanged for at least `client.heartbeat_confirm_ms` (re-checked under the
/// spawn lock and again immediately before a signal).
pub(crate) fn hang_confirmed(hb: &Heartbeat) -> bool {
    suspicion_held(hb).is_some_and(|held| held >= defaults::num("client.heartbeat_confirm_ms"))
}

/// Drop the suspicion (the daemon it named was ended).
pub(crate) fn clear_hang_suspicion() {
    crate::discard::harmless(std::fs::remove_file(state_file("heartbeat_suspect"))); // keep: an absent suspicion is the goal state
}

/// Remove the run marker on a clean exit.
pub fn clear_marker() {
    crate::discard::harmless(std::fs::remove_file(state_file("run_marker"))); // keep: cleanup that raced; an absent file is the goal state
}

/// True when the machine stopped under the previous daemon: the operating system booted after the last sign of life that daemon
/// left (`last_alive_ms`), by more than `health.system_restart_slack_ms`. Without a boot time the answer is no (a crash stays a crash).
pub(crate) fn stopped_by_system(boot_ms: Option<u64>, last_alive_ms: u64) -> bool {
    boot_ms.is_some_and(|boot| last_alive_ms > 0 && boot > last_alive_ms.saturating_add(defaults::num("health.system_restart_slack_ms")))
}

/// If a previous daemon left its run marker and is gone (or the pid is no longer an engine), it died
/// without a clean exit: claim the marker atomically (rename) and log one event. The event is a `crash` unless the machine
/// stopped under it (the system booted after the daemon's last sign of life: a reboot, an OS update, a power loss), which is a
/// `system_restart`: its own reason, not a crash, so it does not count toward the crash-loop threshold or mark the engine degraded.
pub fn reap_marker() {
    reap_marker_at(crate::limits::boot_time_ms());
}

pub(crate) fn reap_marker_at(boot_ms: Option<u64>) {
    let m = state_file("run_marker");
    let Ok(t) = std::fs::read_to_string(&m) else { return };
    let pid: u32 = t.trim().parse().unwrap_or(0);
    if pid != std::process::id() && pid_is_engine(pid) {
        return;
    }
    // the daemon's last sign of life: its newest breadcrumb (written at every request boundary) or, failing that, when it started
    let started_ms =
        std::fs::metadata(&m).and_then(|md| md.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    let breadcrumb = read_json("crash_breadcrumb");
    let breadcrumb_ms = breadcrumb
        .as_ref()
        .filter(|b| b.get("pid").and_then(serde_json::Value::as_u64) == Some(u64::from(pid)))
        .and_then(|b| b.get("ts").and_then(serde_json::Value::as_u64))
        .unwrap_or(0);
    let last_alive_ms = started_ms.max(breadcrumb_ms);
    let claim = file(&format!("{}{}", defaults::text("files.reaped_prefix"), std::process::id()));
    if std::fs::rename(&m, &claim).is_ok() {
        crate::discard::harmless(std::fs::remove_file(&claim)); // keep: cleanup that raced; an absent file is the goal state
        let breadcrumb = breadcrumb.unwrap_or_else(|| json!({"context": "unknown"}));
        if stopped_by_system(boot_ms, last_alive_ms) {
            let detail = defaults::render("msg.log_system_restart", &[("pid", &pid), ("last_alive_ms", &last_alive_ms), ("boot_ms", &boot_ms.unwrap_or(0))]);
            log_event("system_restart", "boot", &detail);
            return;
        }
        let report = json!({"ts": now_ms(), "kind": "crash", "code": "unknown", "pid": pid, "breadcrumb": breadcrumb});
        write_crash_report(&report);
        let detail = defaults::render("msg.log_crash_context", &[("pid", &pid), ("context", &report)]);
        log_event("crash", "unknown", &detail);
        record_failure("crash", "unknown", &detail);
    }
}

// ---- crash-loop protection (daemon deaths) -------------------------------------------------------

fn halted(key: &str) -> Option<Duration> {
    let until: u64 = std::fs::read_to_string(state_file(key)).ok()?.trim().parse().ok()?;
    let now = now_ms();
    (until > now).then(|| Duration::from_millis(until - now))
}

fn halt(key: &str, cooldown: Duration) {
    if let Err(e) = crate::atomic::write(state_file(key), (now_ms() + cooldown.as_millis() as u64).to_string()) {
        // a cooldown that was not written does not hold: the loop it was meant to stop would go on
        log_event_or_stderr("health", "halt_write_failed", &format!("{key}: {e}"));
    }
}

/// Time left in a crash-loop cooldown, if one is active.
pub fn crashloop_remaining() -> Option<Duration> {
    let left = halted("crashloop_until")?;
    if crate::binguard::cooldown_binary_replaced() {
        clear_crashloop();
        return None;
    }
    Some(left)
}

/// End the crash-loop cooldown (the binary was replaced, or the operator reset it): the stamp files go, the event log stays.
fn clear_crashloop() {
    for key in ["crashloop_until", "crashloop_bin", "rollback_request"] {
        crate::discard::harmless(std::fs::remove_file(state_file(key))); // keep: cleanup that raced; an absent file is the goal state
    }
}

/// Evaluate the crash-loop rule before (re)spawning: reap a dead daemon's marker, then if the daemon died
/// `crash_n` or more times within `crash_window`, enter a cooldown, record why, and return true
/// (= do NOT spawn; the caller falls back).
pub fn crashloop_tripped(cfg: &ClientConfig) -> bool {
    if crashloop_remaining().is_some() {
        return true;
    }
    reap_marker();
    let n = count_recent_after_trip(&crashy(), cfg.crash_window);
    // a binary that exits at once leaves no crash event, so the starts themselves are counted too: this many in this window
    // is a loop whatever the daemon reported
    let starts = count_recent_after_trip(&["client_spawn_attempt"], cfg.spawn_window);
    if n < cfg.crash_n && starts < cfg.spawn_n {
        return false;
    }
    // say which rule fired: the crashes within their window, or the starts within theirs
    let (n, window) = if starts >= cfg.spawn_n && starts >= n { (starts, cfg.spawn_window) } else { (n, cfg.crash_window) };
    halt("crashloop_until", cfg.crash_cooldown);
    let rolled = crate::binguard::on_crashloop_trip();
    // a crash loop caused by the environment keeps that cause; otherwise it is a permanent failure
    let env_code = events().into_iter().rev().find(|e| crashy().contains(&e.kind.as_str())).filter(|e| classify(&e.code).0 == Class::Env).map(|e| e.code);
    let reason = defaults::render("msg.reason_crashloop", &[("n", &n.to_string()), ("secs", &window.as_secs().to_string())]);
    let (kind, code) = ("crashloop".to_string(), env_code.unwrap_or_else(|| "crashloop".to_string()));
    log_event("crashloop", &code, &reason);
    record_failure(&kind, &code, &reason);
    if rolled {
        log_event("crashloop", "rollback_requested", defaults::text("msg.log_crashloop_rollback"));
    }
    true
}

// ---- client circuit breaker ----------------------------------------------------------------------

/// Time left until the client circuit breaker closes, if it is open.
pub fn breaker_remaining() -> Option<Duration> {
    halted("breaker_until")
}

/// Count one engine failure (timeout, bad frame, ...). `n` of them within `window` open the breaker for
/// `cooldown`: the client then skips the engine and goes straight to the Node fallback.
pub fn breaker_failure(cfg: &ClientConfig, why: &str) {
    log_event("client_fail", "engine", why);
    if count_recent(&["client_fail"], cfg.breaker_window) >= cfg.breaker_n && breaker_remaining().is_none() {
        halt("breaker_until", cfg.breaker_cooldown);
        let reason =
            defaults::render("msg.reason_breaker", &[("n", &cfg.breaker_n.to_string()), ("secs", &cfg.breaker_window.as_secs().to_string()), ("why", &why)]);
        log_event("breaker_open", "breaker", &reason);
        record_failure("breaker", "breaker", &reason);
    }
}

/// Operator reset: clear the breaker, the crash-loop cooldown and the failure record.
pub fn reset() {
    clear_crashloop();
    for key in ["breaker_until", "failure"] {
        crate::discard::harmless(std::fs::remove_file(state_file(key))); // keep: cleanup that raced; an absent file is the goal state
    }
    log_event("reset", "-", defaults::text("msg.log_operator_reset"));
}

// ---- scrubbing and the once-per-session advisory -------------------------------------------------

/// Remove anything that looks like a secret, an email or the home path from `s`.
///
/// The patterns are `health.scrub_patterns` in the defaults (regex, replacement), applied in order; the home
/// directory is replaced by `~` first so a diagnostic never names the user's account.
pub fn scrub(s: &str) -> String {
    let mut out = s.to_string();
    if let Some(h) = defaults::env_var("home").filter(|h| h.len() > 1) {
        out = out.replace(&h, "~");
    }
    for pair in defaults::raw("health.scrub_patterns").as_array().unwrap_or_default() {
        let (Some(re), Some(rep)) =
            (pair.as_array().and_then(|p| p.first()).and_then(defaults::V::as_str), pair.as_array().and_then(|p| p.get(1)).and_then(defaults::V::as_str))
        else {
            continue;
        };
        if let Ok(r) = Regex::new(re) {
            out = r.replace_all(&out, rep).to_string();
        }
    }
    out
}

/// The secret-scrubbed diagnostic block appended to a permanent-failure advisory.
pub fn diagnostics(code: &str) -> String {
    let log: Vec<String> = std::fs::read_to_string(file(log_name()))
        .map(|t| t.lines().rev().take(defaults::num("health.diag_lines") as usize).map(String::from).collect::<Vec<_>>().into_iter().rev().collect())
        .unwrap_or_default();
    let body = defaults::render(
        "msg.diagnostics",
        &[("version", &crate::version()), ("os", &std::env::consts::OS), ("arch", &std::env::consts::ARCH), ("code", &code), ("log", &log.join("\n"))],
    );
    scrub(&body)
}

/// FNV-1a 64: stable across Rust versions (used for file names that two builds must agree on).
pub fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// The one "not at full strength" flag `status` reports at its top level and in `health.degraded`: the health summary says so
/// (a restart in the window, a tripped breaker, a defaults fallback), or the fail-open window is not in its ok state. Both
/// places read this, so they cannot disagree (live20.1: top-level `false` next to `health.degraded` `true`).
pub fn overall_degraded(summary: &Value, fail_open_degraded: bool) -> bool {
    summary.get("degraded").and_then(serde_json::Value::as_bool).unwrap_or(false) || fail_open_degraded
}

/// Fold an unhealthy fail-open window into the summary as one more reason (`count` fail-opens, `top` the commonest cause), so the
/// top-level flag, `degraded_reason` and `reasons` always agree. `None` (window ok) leaves the summary as it is.
pub fn add_fail_open_reason(summary: &mut Value, unhealthy: Option<(u64, String)>) {
    let Some((count, top)) = unhealthy else { return };
    let row = json!({"group": defaults::text("health.group_fail_open"), "kind": "fail_open", "code": top, "count": count, "first_ts": Value::Null, "last_ts": now_ms(), "detail": ""});
    let mut reasons = summary["reasons"].as_array().cloned().unwrap_or_default();
    reasons.push(row);
    let rendered = format!("fail_open:{top} x{count}");
    if summary["degraded_reason"].is_null() {
        summary["degraded_reason"] = json!(rendered);
    } else if let Some(r) = summary["degraded_reason"].as_str() {
        summary["degraded_reason"] = json!(format!("{r} +fail_open"));
    }
    summary["evidence"] = json!(summary["evidence"].as_u64().unwrap_or(0) + count);
    summary["reasons"] = Value::Array(reasons);
    summary["degraded"] = json!(true);
}

/// The engine's health over the last `health.degraded_window_s`: self-restarts by reason, the crash-loop breaker and the client
/// breaker with when they tripped, and how often a call fell back to Node and why. `degraded` is true when the engine is
/// not at full strength (a restart in the window, the crash-loop breaker tripped, the client breaker open, or a defaults
/// fallback of a `health.degraded_kinds` kind in the window). Everything is
/// read from the event log, so it works with the daemon down and survives a restart.
pub fn summary() -> Value {
    let mut summary = summary_from(&events(), now_ms(), crashloop_remaining(), breaker_remaining());
    starts::add_summary(&mut summary);
    summary
}

/// Every cause of `degraded`, each with how often it happened and when it was first and last seen: a restart (by kind and code) in
/// the window, a defaults fallback in the window and not older than the running daemon (a fresh daemon reloads the defaults, so a
/// fallback logged before its start is already answered; one still failing is logged again at start), the crash-loop breaker,
/// the client breaker. `degraded` is exactly "this list is not empty", so the flag can never ship without its reason.
fn degraded_reasons(ev: &[Event], now: u64, window: Duration, loop_left: Option<Duration>, breaker_left: Option<Duration>) -> Vec<Value> {
    let floor = now.saturating_sub(window.as_millis() as u64);
    let started = ev.iter().rev().find(|e| e.kind == defaults::text("health.start_kind")).map_or(0, |e| e.ts);
    let (crashy, kinds, resolved) = (crashy(), defaults::list("health.degraded_kinds"), defaults::list("health.resolved_by_start_kinds"));
    // (group, kind, code) -> (count, first_ts, last_ts, last detail)
    type Key<'a> = (&'a str, String, String);
    type Tally = (u64, u64, u64, String);
    let mut groups: std::collections::BTreeMap<Key, Tally> = std::collections::BTreeMap::new();
    for e in ev.iter().filter(|e| e.ts >= floor) {
        let group = if crashy.contains(&e.kind.as_str()) && e.kind != "crashloop" {
            defaults::text("health.group_restart")
        } else if kinds.contains(&e.kind.as_str()) && !(resolved.contains(&e.kind.as_str()) && e.ts < started) {
            defaults::text("health.group_defaults")
        } else {
            continue;
        };
        let g = groups.entry((group, e.kind.clone(), e.code.clone())).or_insert((0, e.ts, e.ts, String::new()));
        g.0 += 1;
        g.2 = e.ts;
        g.3 = e.detail.clone();
    }
    let mut out: Vec<Value> = groups
        .into_iter()
        .map(|((group, kind, code), (count, first, last, detail))| json!({"group": group, "kind": kind, "code": code, "count": count, "first_ts": first, "last_ts": last, "detail": detail}))
        .collect();
    let last_ts = |kind: &str| ev.iter().rev().find(|e| e.kind == kind).map_or(now, |e| e.ts);
    for (left, kind, group) in [(loop_left, "crashloop", "health.group_crashloop"), (breaker_left, "breaker_open", "health.group_breaker")] {
        if let Some(d) = left {
            let t = last_ts(kind);
            out.push(json!({"group": defaults::text(group), "kind": kind, "code": "tripped", "count": 1, "first_ts": t, "last_ts": t, "detail": format!("{}s remaining", d.as_secs() + 1)}));
        }
    }
    out.sort_by_key(|r| r["first_ts"].as_u64().unwrap_or(0));
    out
}

fn summary_from(ev: &[Event], now: u64, loop_left: Option<Duration>, breaker_left: Option<Duration>) -> Value {
    let window = defaults::secs("health.degraded_window_s");
    let floor = now.saturating_sub(window.as_millis() as u64);
    let recent: Vec<&Event> = ev.iter().filter(|e| e.ts >= floor).collect();
    let tally = |pick: &dyn Fn(&Event) -> Option<String>| -> serde_json::Map<String, Value> {
        let mut m: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        for e in &recent {
            if let Some(k) = pick(e) {
                *m.entry(k).or_insert(0) += 1;
            }
        }
        m.into_iter().map(|(k, v)| (k, json!(v))).collect()
    };
    let crashy = crashy();
    // a crash-loop trip is the consequence of the restarts, not one of them
    let restarts = tally(&|e| (crashy.contains(&e.kind.as_str()) && e.kind != "crashloop").then(|| format!("{}:{}", e.kind, e.code)));
    let system_restarts = recent.iter().filter(|e| e.kind == "system_restart").count();
    let fallbacks = tally(&|e| matches!(e.kind.as_str(), "dispatch_defer" | "client_fail").then(|| format!("{}:{}", e.kind, e.code)));
    let total = |m: &serde_json::Map<String, Value>| m.values().filter_map(Value::as_u64).sum::<u64>();
    let last = |kind: &str| ev.iter().rev().find(|e| e.kind == kind).map(|e| json!({"ts": e.ts, "code": e.code, "detail": e.detail}));
    let reasons = degraded_reasons(ev, now, window, loop_left, breaker_left);
    let defaults_rows: Vec<&Value> = reasons.iter().filter(|r| r["group"] == defaults::text("health.group_defaults")).collect();
    let defaults_fb: serde_json::Map<String, Value> =
        defaults_rows.iter().map(|r| (format!("{}:{}", r["kind"].as_str().unwrap_or(""), r["code"].as_str().unwrap_or("")), r["count"].clone())).collect();
    let last_defaults = defaults_rows
        .iter()
        .max_by_key(|r| r["last_ts"].as_u64())
        .map(|r| json!({"ts": r["last_ts"], "kind": r["kind"], "code": r["code"], "detail": r["detail"]}));
    let evidence: u64 = reasons.iter().filter_map(|r| r["count"].as_u64()).sum();
    let since = reasons.iter().filter_map(|r| r["first_ts"].as_u64()).min();
    let reason = reasons.first().map(|r| {
        let n = reasons.len();
        let base =
            format!("{}:{} x{} ({})", r["kind"].as_str().unwrap_or(""), r["code"].as_str().unwrap_or(""), r["count"], r["detail"].as_str().unwrap_or(""));
        if n > 1 { format!("{base} +{} more", n - 1) } else { base }
    });
    json!({
        "degraded": !reasons.is_empty(),
        "degraded_reason": reason,
        "reasons": reasons,
        "since": since,
        "evidence": evidence,
        "window_s": window.as_secs(),
        "restarts": {"total": total(&restarts), "by_reason": restarts, "last_rss_trip": last("rss"), "last_memory_breakdown": last("memory")},
        "system_restarts": {"total": system_restarts, "last": last("system_restart")},
        "crashloop": {"tripped": loop_left.is_some(), "remaining_s": loop_left.map(|d| d.as_secs() + 1), "last_trip": last("crashloop")},
        "breaker": {"open": breaker_left.is_some(), "remaining_s": breaker_left.map(|d| d.as_secs() + 1), "last_open": last("breaker_open")},
        "rollback": {"last": crate::binguard::last_rollback(), "last_request": last("rollback_request")},
        "fallbacks": {"total": total(&fallbacks), "by_reason": fallbacks},
        "defaults": {"total": total(&defaults_fb), "by_reason": defaults_fb, "last": last_defaults},
        "last_crash": last_crash(),
        "log": file(log_name()).display().to_string(),
    })
}

/// The advisory for this session: `Some(text)` the first time a recent failure exists for `session`,
/// then `None` for the rest of that session. Env failures get a self-fix hint; permanent ones get the
/// issue-filing text and a scrubbed diagnostic block. Nothing is ever filed automatically.
pub fn advisory(session: &str) -> Option<String> {
    let Some(f) = read_json("failure").filter(|f| now_ms().saturating_sub(f["ts"].as_u64().unwrap_or(0)) <= defaults::num("health.advisory_ttl_ms")) else {
        return degraded_notice(session);
    };
    let dir = state_file("advised_dir");
    crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the write that follows reports a failure
    let stamp = dir.join(format!("{:016x}", fnv(&format!("{session}|{}", f["ts"]))));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&stamp).ok()?; // already advised => None
    prune_advised(&dir);
    let reason = f["reason"].as_str().unwrap_or("unknown");
    let code = f["code"].as_str().unwrap_or("unknown");
    Some(if f["class"] == "env" {
        defaults::render("msg.advisory_env", &[("hint", &f["hint"].as_str().unwrap_or(reason))])
    } else {
        defaults::render("msg.advisory_permanent", &[("reason", &scrub(reason)), ("diagnostics", &diagnostics(code))])
    })
}

/// True the first time it is asked for this `session` and `tag`, false after (the once-per-session stamp the advisories share).
pub fn first_in_session(session: &str, tag: &str) -> bool {
    let dir = state_file("advised_dir");
    crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the write that follows reports a failure
    let stamp = dir.join(format!("{:016x}", fnv(&format!("{session}|{tag}"))));
    let first = std::fs::OpenOptions::new().write(true).create_new(true).open(&stamp).is_ok();
    if first {
        prune_advised(&dir);
    }
    first
}

/// A few words, once per session, when the engine is running below full strength (a self-restart in the window, a tripped
/// breaker) and no failure advisory applies, so the owner learns of a degraded engine without digging through logs.
fn degraded_notice(session: &str) -> Option<String> {
    degraded_notice_in(session, &summary(), &state_file("advised_dir"))
}

/// [`degraded_notice`] for a given health summary `s` and once-per-session stamp directory `dir`.
fn degraded_notice_in(session: &str, s: &Value, dir: &std::path::Path) -> Option<String> {
    if s["degraded"] != true {
        return None;
    }
    crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the write that follows reports a failure
    let stamp = dir.join(format!("{:016x}", fnv(&format!("{session}|degraded"))));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&stamp).ok()?; // already told => None
    prune_advised(dir);
    let mut text = defaults::render(
        "msg.advisory_degraded",
        &[
            ("restarts", &s["restarts"]["total"]),
            ("mins", &(defaults::secs("health.degraded_window_s").as_secs() / 60)),
            ("fallbacks", &s["fallbacks"]["total"]),
            ("log", &s["log"].as_str().unwrap_or("")),
        ],
    );
    if s["defaults"]["total"].as_u64().unwrap_or(0) > 0 {
        text.push_str(&defaults::render(
            "msg.advisory_defaults",
            &[("count", &s["defaults"]["total"]), ("last", &s["defaults"]["last"]["detail"].as_str().unwrap_or(""))],
        ));
    }
    Some(text)
}

fn prune_advised(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let all: Vec<_> = rd.flatten().collect();
    if all.len() as u64 <= defaults::num("health.advised_cap") {
        return;
    }
    for e in all {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d > defaults::secs("health.advised_expire_s"));
        if old {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

/// Fold an advisory into hook output `existing` (what the Node hook or engine printed). Output that is
/// not a JSON object is left untouched (returns None) so a protocol line is never corrupted.
pub fn merge_advisory(event: &str, existing: &str, text: &str) -> Option<String> {
    let mut v: Value = if existing.trim().is_empty() { json!({}) } else { serde_json::from_str(existing).ok()? };
    let obj = v.as_object_mut()?;
    if defaults::list("health.context_events").contains(&event) {
        let hso = obj.entry("hookSpecificOutput").or_insert_with(|| json!({}));
        let h = hso.as_object_mut()?;
        h.entry("hookEventName").or_insert_with(|| json!(event));
        let prev = h.get("additionalContext").and_then(Value::as_str).unwrap_or("").to_string();
        h.insert("additionalContext".into(), json!(if prev.is_empty() { text.to_string() } else { format!("{prev}\n{text}") }));
    } else {
        let prev = obj.get("systemMessage").and_then(Value::as_str).unwrap_or("").to_string();
        obj.insert("systemMessage".into(), json!(if prev.is_empty() { text.to_string() } else { format!("{prev}\n{text}") }));
    }
    Some(v.to_string())
}

#[cfg(test)]
mod tests {
    /// live20.1: `status` showed top-level `degraded: false` next to `health.degraded: true` because each was computed from its
    /// own input. The one flag is true when either the health summary or the fail-open window says so.
    #[test]
    fn one_degraded_flag_covers_health_and_fail_open() {
        let (sick, well) = (serde_json::json!({"degraded": true}), serde_json::json!({"degraded": false}));
        assert!(overall_degraded(&sick, false), "a health reason alone degrades the engine");
        assert!(overall_degraded(&well, true), "an unhealthy fail-open window alone degrades the engine");
        assert!(!overall_degraded(&well, false));
        assert!(!overall_degraded(&serde_json::json!({}), false), "a summary without the field is not degraded");
    }

    use super::*;

    fn ev(ts: u64, kind: &str, code: &str, detail: &str) -> Event {
        Event { ts, kind: kind.into(), code: code.into(), detail: detail.into() }
    }

    /// v3.0.1 live: right after a deploy `health.degraded` was true with no reason. The log held a watchdog restart and three
    /// defaults fallbacks, all logged before the new daemon's `start` line.
    #[test]
    fn a_defaults_fallback_before_the_daemon_start_is_answered_and_a_restart_is_named() {
        let log = vec![
            ev(1_000, "watchdog", "stall", "accept loop stalled"),
            ev(5_000, "defaults_fallback", "missing_key", "defaults mesh_write.toml mesh_write.exit_defer rejected (missing_key): using the pristine copy"),
            ev(
                5_001,
                "defaults_fallback",
                "missing_key",
                "defaults devswarm_wire.toml devswarm_wire.msg_deferred rejected (missing_key): using the pristine copy",
            ),
            ev(9_000, "start", "-", "v0.1.0 pid 27794"),
        ];
        let s = summary_from(&log, 10_000, None, None);
        assert_eq!(s["defaults"]["total"], 0, "the start answered the earlier fallbacks: {s}");
        assert_eq!(s["degraded"], true, "the watchdog restart is still inside the window: {s}");
        assert_eq!(s["reasons"].as_array().unwrap().len(), 1, "{s}");
        assert_eq!(s["reasons"][0]["code"], "stall");
        assert_eq!((s["since"].as_u64(), s["evidence"].as_u64()), (Some(1_000), Some(1)));
        assert!(s["degraded_reason"].as_str().unwrap().contains("watchdog:stall"), "{s}");
        // a fallback logged after the start is a live problem and counts, with its first-seen time and count
        let mut live = log.clone();
        live.push(ev(9_500, "defaults_fallback", "parse", "defaults engine.toml rejected (parse)"));
        live.push(ev(9_600, "defaults_fallback", "parse", "defaults engine.toml rejected (parse)"));
        let s = summary_from(&live, 10_000, None, None);
        assert_eq!(s["defaults"]["by_reason"]["defaults_fallback:parse"], 2, "{s}");
        let row = s["reasons"].as_array().unwrap().iter().find(|r| r["code"] == "parse").unwrap();
        assert_eq!((row["count"].as_u64(), row["first_ts"].as_u64(), row["last_ts"].as_u64()), (Some(2), Some(9_500), Some(9_600)));
    }

    /// Prevention: whatever the log holds, `degraded: true` never ships without a reason, a first-seen time and an evidence count,
    /// and `degraded: false` carries none.
    #[test]
    fn degraded_is_never_true_without_its_reason() {
        let kinds = [
            "watchdog",
            "crash",
            "panic",
            "rss",
            "start_fail",
            "defaults_fallback",
            "defaults_heal_skipped",
            "start",
            "crashloop",
            "discard",
            "system_restart",
        ];
        for mask in 0u32..(1 << kinds.len()) {
            let log: Vec<Event> = kinds.iter().enumerate().filter(|(i, _)| mask >> i & 1 == 1).map(|(i, k)| ev(1_000 + i as u64 * 100, k, "c", "d")).collect();
            for (lp, br) in [(None, None), (Some(Duration::from_secs(5)), None), (None, Some(Duration::from_secs(5)))] {
                let s = summary_from(&log, 5_000, lp, br);
                let n = s["reasons"].as_array().unwrap().len();
                assert_eq!(s["degraded"] == true, n > 0, "flag and reasons disagree: {s}");
                if n > 0 {
                    assert!(s["degraded_reason"].as_str().is_some_and(|r| !r.is_empty()), "no reason text: {s}");
                    assert!(s["since"].as_u64().is_some() && s["evidence"].as_u64().unwrap() >= n as u64, "no since/evidence: {s}");
                } else {
                    assert!(s["degraded_reason"].is_null() && s["since"].is_null() && s["evidence"] == 0, "{s}");
                }
            }
        }
    }

    /// #201: a `missing_key` fallback logged AFTER the daemon start (plugin defaults lag the engine) is a live problem: the engine is
    /// degraded, with that reason, its count and first-seen time. Before the start it is answered and does not degrade.
    #[test]
    fn a_missing_key_fallback_after_the_start_marks_the_engine_degraded() {
        let detail = "defaults routine.toml routine.x rejected (missing_key): using the pristine copy";
        let before = vec![ev(5_000, "defaults_fallback", "missing_key", detail), ev(9_000, "start", "-", "v0.1.0 pid 1")];
        let s = summary_from(&before, 10_000, None, None);
        assert_eq!((s["degraded"].clone(), s["defaults"]["total"].clone()), (serde_json::json!(false), serde_json::json!(0)), "{s}");
        let mut after = before.clone();
        after.push(ev(9_500, "defaults_fallback", "missing_key", detail));
        after.push(ev(9_700, "defaults_fallback", "missing_key", detail));
        let s = summary_from(&after, 10_000, None, None);
        assert_eq!(s["degraded"], true, "a missing_key after the start must degrade: {s}");
        assert_eq!(s["defaults"]["by_reason"]["defaults_fallback:missing_key"], 2, "{s}");
        let row = s["reasons"].as_array().unwrap().iter().find(|r| r["code"] == "missing_key").expect("a missing_key reason");
        assert_eq!((row["count"].as_u64(), row["first_ts"].as_u64()), (Some(2), Some(9_500)), "{s}");
        assert!(s["degraded_reason"].as_str().unwrap().contains("defaults_fallback:missing_key"), "{s}");
    }

    /// #201: a degraded engine tells each session exactly once (rendered from `msg.advisory_degraded`, naming the defaults
    /// fallback); a new session hears it again; a healthy engine says nothing.
    #[test]
    fn a_degraded_engine_gives_exactly_one_notice_per_session() {
        let dir = std::env::temp_dir().join(format!("ah-degraded-notice-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        let log = vec![
            ev(9_000, "start", "-", "v0.1.0 pid 1"),
            ev(9_500, "defaults_fallback", "missing_key", "defaults routine.toml routine.x rejected (missing_key): using the pristine copy"),
        ];
        let sick = summary_from(&log, 10_000, None, None);
        let well = summary_from(&[], 10_000, None, None);
        assert_eq!(degraded_notice_in("sess-A", &well, &dir), None, "a healthy engine is silent");
        let first = degraded_notice_in("sess-A", &sick, &dir).expect("the first call of a session carries the notice");
        assert!(first.contains("missing_key"), "the notice names the defaults problem: {first}");
        assert_eq!(degraded_notice_in("sess-A", &sick, &dir), None, "no repeat inside the session");
        assert!(degraded_notice_in("sess-B", &sick, &dir).is_some(), "a new session hears it again");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_fail_open_window_adds_its_own_reason() {
        let mut s = summary_from(&[], 5_000, None, None);
        assert_eq!(s["degraded"], false);
        add_fail_open_reason(&mut s, Some((9, "deadline_cut".into())));
        assert_eq!((s["degraded"].clone(), s["evidence"].clone()), (json!(true), json!(9)));
        assert!(s["degraded_reason"].as_str().unwrap().contains("fail_open:deadline_cut"), "{s}");
        assert_eq!(s["reasons"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_generation_does_not_depend_on_the_executable_path() {
        // a binary update replaces the executable under a surviving daemon: same pid, start and dir must stay recoverable
        let pid = std::process::id();
        let start = crate::procid::start(pid).expect("own start time");
        let beat = |start: u64, exe: &str| Heartbeat {
            pid,
            ident: format!("{pid}\n{start}\n{exe}\n{}\n", instance_dir().to_string_lossy()),
            mtime_ns: 0,
            age: Duration::ZERO,
        };
        assert!(beat(start, "/old/place/ah-engine (deleted)").names_running(), "another exe path, same generation");
        assert!(beat(start, "").names_running(), "an unrecorded exe, same generation");
        assert!(!beat(start + 1, "/old/place/ah-engine").names_running(), "another start time is another generation");
    }

    #[test]
    fn the_log_trim_keeps_the_tail_atomically_and_waits_for_no_one() {
        // review finding 9: the trim truncated the log in place with no lock, racing every other appender
        let d = std::env::temp_dir().join(format!("ah-health-trim-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let log = d.join("e.log");
        let cap = defaults::num("health.log_cap") as usize;
        let line = "1\tk\tc\tdetail\n";
        std::fs::write(&log, line.repeat(cap / line.len() + 10)).unwrap();
        // another process trimming (the exclusive lock held): this append neither trims nor blocks
        let held = log_lock(&log).unwrap();
        assert!(flock(&held, libc::LOCK_EX | libc::LOCK_NB));
        let t = std::thread::spawn({
            let log = log.clone();
            move || append_to(&log, "1\tk\tc\tlast\n").is_ok()
        });
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!t.is_finished() || std::fs::metadata(&log).unwrap().len() as usize > cap, "the append waits for the trim to finish, then appends");
        drop(held);
        assert!(t.join().unwrap());
        assert!(std::fs::read_to_string(&log).unwrap().ends_with("last\n"));
        // free: the next append trims to the last health.log_keep_lines lines (renamed over the log, no temp left)
        append_to(&log, "1\tk\tc\tafter\n").unwrap();
        let text = std::fs::read_to_string(&log).unwrap();
        assert_eq!(text.lines().count(), defaults::num("health.log_keep_lines") as usize + 1, "trimmed, then appended");
        assert!(text.ends_with("\tlast\n1\tk\tc\tafter\n"), "{:?}", &text[text.len().saturating_sub(80)..]);
        let left: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(left.len(), 2, "the log and its lock file only: {left:?}");
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn an_unwritable_log_is_an_error_not_a_silent_drop() {
        // review finding 9: log_event dropped every append error; only a missing state dir is silent now
        let d = std::env::temp_dir().join(format!("ah-health-unwritable-{}", std::process::id()));
        std::fs::create_dir_all(d.join("e.log")).unwrap(); // the log path is a directory: EISDIR
        let e = append_to(&d.join("e.log"), "x\n").unwrap_err();
        assert_ne!(e.kind(), std::io::ErrorKind::NotFound, "goes to stderr");
        assert_eq!(append_to(&d.join("missing/e.log"), "x\n").unwrap_err().kind(), std::io::ErrorKind::NotFound, "no state dir: dropped");
        crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    #[allow(clippy::undocumented_unsafe_blocks)] // test-only env mutation; the single-thread audit is the FIXME beside each call
    fn scrub_removes_secrets_emails_and_home() {
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var("HOME", "/Users/someone") };
        let s = scrub(
            "key sk-abcdef0123456789ABCDEF token=hunter2 Authorization: Bearer abcdefgh12345678 ghp_0123456789abcdefghijABCDEF me@example.com /Users/someone/x AKIAABCDEFGHIJKLMNOP",
        );
        for leak in ["sk-abcdef", "hunter2", "abcdefgh12345678", "ghp_0123", "me@example.com", "/Users/someone", "AKIAABCD"] {
            assert!(!s.contains(leak), "{leak} leaked: {s}");
        }
        assert!(s.contains("~/x"));
    }

    #[test]
    fn classification_splits_env_from_permanent() {
        for c in ["os28", "os13", "os36", "sig9", "unsafe_dir", "os24"] {
            let (cl, hint) = classify(c);
            assert_eq!(cl, Class::Env, "{c}");
            assert!(!hint.is_empty());
        }
        for c in ["panic", "crashloop", "unknown", "invariant"] {
            assert_eq!(classify(c).0, Class::Permanent, "{c}");
        }
    }

    #[test]
    fn merge_into_each_output_shape() {
        let m = merge_advisory("PreToolUse", "", "ADV").unwrap();
        assert!(m.contains(r#""additionalContext":"ADV""#) && m.contains(r#""hookEventName":"PreToolUse""#));
        let m = merge_advisory(
            "PreToolUse",
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"}}"#,
            "ADV",
        )
        .unwrap();
        assert!(m.contains("permissionDecision") && m.contains("ADV"));
        let m = merge_advisory("Stop", r#"{"systemMessage":"old"}"#, "ADV").unwrap();
        assert!(m.contains("old\\nADV"));
        assert_eq!(merge_advisory("PreToolUse", "plain text not json", "ADV"), None);
    }

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv("a"), 0xaf63_dc4c_8601_ec8c);
    }
}
