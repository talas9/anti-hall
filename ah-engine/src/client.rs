//! Hook client. Contract: NEVER fail the host and NEVER mistake a bad reply for "allow".
//!
//! Order of events for `engine hook [--fallback <hook.js>]`:
//!  1. ask the daemon (short deadline, framed reply, size-capped input);
//!  2. a complete OK frame is the answer (its body may be empty = nothing to say);
//!  3. no daemon, timeout, breaker open, or crash-loop stop fails open: print nothing and exit 0;
//!  4. BUSY, ERR, and malformed verdict bodies are healthy negative replies, so the caller keeps its fallback/no-node policy.
//!
//! The fallback command is chosen by the caller (argument or env), never by anything in the payload.
use crate::config::ClientConfig;
use crate::frame::{self, Kind};
use crate::{defaults, health, paths};
use std::cell::Cell;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

thread_local! {
    static LAST_NON_OK_REPLY: Cell<bool> = const { Cell::new(false) };
    static LAST_UNAVAILABLE: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn take_non_ok_reply() -> bool {
    LAST_NON_OK_REPLY.replace(false)
}

pub(crate) fn take_unavailable() -> bool {
    LAST_UNAVAILABLE.replace(false)
}

fn note_unavailable() {
    LAST_UNAVAILABLE.set(true);
}

/// Result of one exchange with the daemon.
#[derive(Debug)]
pub enum Exch {
    /// A complete, checksum-valid reply frame.
    Reply(Kind, String),
    /// Nothing is listening (no socket, or connection refused).
    Absent,
    /// A daemon may be there but the exchange failed: unsafe socket, bad or truncated frame, an I/O error.
    Failed(String),
    /// No reply within the whole wait window (the deadline, extended to `client.slow_fallback_max_ms` for a daemon that is alive
    /// but late; on macOS an SO_RCVTIMEO expiry reads as EAGAIN, os error 35). The daemon may already have processed the
    /// request, so this call runs no Node hook (it would count twice): it fails open, and no down marker, spawn or breaker
    /// failure follows unless `client.slow_down_n` such calls come in a row (a wedged daemon).
    Slow(String),
    /// Past the deadline, and the daemon's heartbeat (`files.heartbeat`) is older than `client.heartbeat_stale_ms`: the process is
    /// stopped or wedged, not slow, so the call stops waiting at once (no slow window). `true` = confirmed (the same heartbeat
    /// stayed unchanged for `client.heartbeat_confirm_ms` since an earlier call suspected it), and only then is it recovered.
    Hung(String, bool),
}

/// The longest one exchange waits for its reply: the deadline, extended to `client.slow_fallback_max_ms` less `client.slow_wait_margin_ms` (a daemon
/// that is alive answers late rather than never; the wrapper's watchdog waits for the whole `client.slow_fallback_max_ms`).
fn wait_window(deadline: Duration) -> Duration {
    let max = defaults::millis("client.slow_fallback_max_ms");
    let ends = if max.is_zero() { Duration::ZERO } else { max.saturating_sub(defaults::millis("client.slow_wait_margin_ms")) };
    deadline.max(ends)
}

/// Re-arm the read timeout for the rest of the wait window. macOS refuses SO_RCVTIMEO (EINVAL) once the daemon has replied and
/// closed, while its reply is still buffered: that is no failure, so the refusal is logged and the previous timeout stays; the
/// next read returns the buffered reply (or EOF), and the window check in the caller bounds the wait.
fn rearm_read_timeout(s: &UnixStream, left: Duration) {
    if let Err(e) = s.set_read_timeout(Some(left)) {
        health::log_event("client_rearm", "daemon", &defaults::render("msg.client_io", &[("what", &defaults::text("msg.client_what_timeout")), ("err", &e)]));
    }
}

/// Why the daemon counts as hung, and whether that is confirmed: its heartbeat is older than `client.heartbeat_stale_ms` (0 =
/// never; unknown = alive). One stale sample only raises a suspicion ([`health::weigh_stale`]).
fn stale_heartbeat() -> Option<(String, bool)> {
    let stale = defaults::millis("client.heartbeat_stale_ms");
    let hb = health::heartbeat_of_lock_holder().filter(|hb| !stale.is_zero() && hb.age > stale)?;
    let (pid, age) = (hb.pid, hb.age.as_millis());
    Some(match health::weigh_stale(&hb) {
        health::Hang::Suspected => (defaults::render("msg.client_hung", &[("pid", &pid), ("age", &age)]), false),
        health::Hang::Confirmed(held) => (defaults::render("msg.client_hung_confirmed", &[("pid", &pid), ("age", &age), ("held", &held)]), true),
    })
}

fn exchange_inner(sock: &Path, payload: &[u8], deadline: Duration, window: Duration) -> Exch {
    match std::fs::symlink_metadata(sock) {
        // only a missing socket means "no daemon"; any other error (EACCES, ENOTDIR, ELOOP, EIO) is a failed exchange the
        // breaker counts and the log names, never a reason to start a second daemon (review finding 18)
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Exch::Absent,
        Err(e) => return Exch::Failed(defaults::render("msg.client_io", &[("what", &defaults::text("msg.client_what_stat")), ("err", &e)])),
        Ok(m) if !m.file_type().is_socket() || m.uid() != crate::limits::uid() => return Exch::Failed(defaults::text("msg.client_bad_socket").into()),
        Ok(_) => {}
    }
    let mut s = match UnixStream::connect(sock) {
        Ok(s) => s,
        Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound) => return Exch::Absent,
        Err(e) => return Exch::Failed(defaults::render("msg.client_connect", &[("err", &e)])),
    };
    let io = |r: std::io::Result<()>, what: &str| r.map_err(|e| Exch::Failed(defaults::render("msg.client_io", &[("what", &what), ("err", &e)])));
    if let Err(e) = io(s.set_read_timeout(Some(deadline)), defaults::text("msg.client_what_timeout"))
        .and_then(|_| io(s.set_write_timeout(Some(deadline)), defaults::text("msg.client_what_timeout")))
        .and_then(|_| io(s.write_all(payload), "write"))
        .and_then(|_| io(s.shutdown(std::net::Shutdown::Write), "shutdown"))
    {
        return e;
    }
    let mut buf = Vec::new();
    let (start, max_reply) = (Instant::now(), defaults::num("client.max_reply"));
    let mut late = false;
    // read_to_end keeps the bytes read before an error, so a timeout resumes the same reply instead of restarting it
    while let Err(e) = (&mut s).take(max_reply.saturating_sub(buf.len() as u64)).read_to_end(&mut buf) {
        let why = defaults::render("msg.client_io", &[("what", &"read"), ("err", &e)]);
        if !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
            return Exch::Failed(why);
        }
        let left = window.saturating_sub(start.elapsed());
        if left.is_zero() {
            return Exch::Slow(why);
        }
        if !late {
            late = true;
            health::log_event("client_late", "daemon", &why); // past the deadline but still waiting for the daemon's own reply
        }
        if let Some((hung, confirmed)) = stale_heartbeat() {
            return Exch::Hung(hung, confirmed);
        }
        rearm_read_timeout(&s, left.min(defaults::millis("client.heartbeat_poll_ms")));
    }
    match frame::decode(&buf) {
        Ok((k, body)) => Exch::Reply(k, body),
        Err(e) => Exch::Failed(defaults::render("msg.client_bad_frame", &[("err", &format!("{e:?}"))])),
    }
}

/// One exchange under a hard overall deadline (the work runs on a thread so even a blocking connect
/// cannot outlive it).
pub fn exchange(sock: &Path, payload: &[u8], deadline: Duration) -> Exch {
    exchange_for(sock, payload, deadline, deadline)
}

/// `exchange` that keeps waiting for the reply up to `window` (>= `deadline`) once the deadline has passed.
fn exchange_for(sock: &Path, payload: &[u8], deadline: Duration, window: Duration) -> Exch {
    let window = window.max(deadline);
    let (tx, rx) = mpsc::channel();
    let (sock, payload) = (sock.to_path_buf(), payload.to_vec());
    std::thread::spawn(move || {
        crate::discard::harmless(tx.send(exchange_inner(&sock, &payload, deadline, window))); // keep: the receiver is gone; nobody is waiting for the result
    });
    rx.recv_timeout(window + defaults::millis("client.deadline_slack_ms")).unwrap_or_else(|_| Exch::Slow(defaults::text("msg.client_timeout").into()))
}

fn state_file(key: &str) -> PathBuf {
    paths::dir().join(defaults::text(&format!("files.{key}")))
}

fn fresh_until(p: &Path) -> bool {
    let until = std::fs::read_to_string(p).ok().and_then(|t| t.trim().parse::<u64>().ok()).unwrap_or(0);
    if until > health::now_ms() {
        return true;
    }
    crate::discard::harmless(std::fs::remove_file(p)); // keep: stale marker cleanup that raced
    false
}

pub(crate) fn daemon_down_marked() -> bool {
    fresh_until(&state_file("daemon_down_marker"))
}

pub(crate) fn fail_open_unavailable() -> bool {
    daemon_down_marked() || health::breaker_remaining().is_some() || health::crashloop_remaining().is_some()
}

fn mark_daemon_down(reason: &str) {
    crate::discard::harmless(crate::limits::ensure_private_dir(&paths::dir())); // keep: marker write below reports failure by absence
    let until = health::now_ms().saturating_add(defaults::num("client.down_marker_ttl_ms"));
    crate::discard::logged("daemon_down_marker_write", crate::atomic::write(state_file("daemon_down_marker"), until.to_string()));
    health::log_event("client_down", "daemon", reason);
}

/// Count this slow reply into the streak file (`count first_ts_ms`); true once `client.slow_down_n` slow replies came in a
/// row within `client.slow_window_ms`. A normal reply removes the file. Concurrent clients race on it, which only makes the
/// count approximate, so an unreadable or unwritable streak counts as no streak.
fn slow_streak_tripped() -> bool {
    let (now, window) = (health::now_ms(), defaults::num("client.slow_window_ms"));
    crate::discard::harmless(crate::limits::ensure_private_dir(&paths::dir())); // keep: the streak write below reports failure by absence
    let path = state_file("slow_streak");
    let prev = std::fs::read_to_string(&path).ok().and_then(|t| {
        let mut it = t.split_whitespace().filter_map(|x| x.parse::<u64>().ok());
        Some((it.next()?, it.next()?))
    });
    let (count, first) = match prev {
        Some((c, f)) if now.saturating_sub(f) <= window => (c + 1, f),
        _ => (1, now),
    };
    if count >= defaults::num("client.slow_down_n") {
        clear_slow_streak();
        return true;
    }
    crate::discard::logged("slow_streak_write", crate::atomic::write(&path, format!("{count} {first}")));
    false
}

/// Tell the wrapper (`AH_ENGINE_WAIT_FILE`) that this call is waiting on the daemon, or running the Node hooks of a late or
/// refused reply: its watchdog then lets the call run up to `client.slow_fallback_max_ms` instead of killing it at the fail-fast
/// budget (which would turn a delayed block into an allow). Removed once the daemon answered with nothing left to run (a dispatch caller keeps it until its final result is ready, see `attempt_holding_wait`) or none was there.
fn wait_marker(set: bool) {
    if let Some(p) = defaults::env_var("wait_file").filter(|p| !p.is_empty()) {
        if set {
            crate::discard::logged("wait_file_write", crate::atomic::write(p, b"")); // the wrapper only tests that the file exists
        } else {
            crate::discard::harmless(std::fs::remove_file(p)); // keep: an absent marker is the desired state
        }
    }
}

fn clear_slow_streak() {
    crate::discard::harmless(std::fs::remove_file(state_file("slow_streak"))); // keep: absent streak is the desired state
}

fn clear_daemon_down_marker() {
    crate::discard::harmless(std::fs::remove_file(state_file("daemon_down_marker"))); // keep: absent marker is the desired state
}

struct SpawnLock {
    path: PathBuf,
}

impl Drop for SpawnLock {
    fn drop(&mut self) {
        let _ = &self.path; // keep the single-flight marker until the daemon releases it on start, or its config TTL expires
    }
}

/// The daemon is listening: the start the single-flight lock guarded is over, so a death right after it is restarted by the
/// next client instead of waiting out `client.spawn_lock_ttl_ms`. A daemon that dies before it listens never gets here, so its
/// lock still throttles restarts (and the crash-loop rule still counts them).
pub(crate) fn release_spawn_lock() {
    crate::discard::harmless(std::fs::remove_file(state_file("spawn_lock"))); // keep: absent lock is the desired state
}

fn spawn_lock() -> Option<SpawnLock> {
    crate::discard::harmless(crate::limits::ensure_private_dir(&paths::dir())); // keep: create_new below is the real gate
    let p = state_file("spawn_lock");
    if std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > defaults::millis("client.spawn_lock_ttl_ms"))
    {
        crate::discard::harmless(std::fs::remove_file(&p)); // keep: stale lock from a dead client
    }
    let f = std::fs::OpenOptions::new().write(true).create_new(true).open(&p).ok()?;
    let _ = f.as_raw_fd();
    Some(SpawnLock { path: p })
}

fn ctl_body(sock: &Path, req: &str) -> Option<String> {
    match exchange(sock, req.as_bytes(), defaults::millis("client.ctl_timeout_ms")) {
        Exch::Reply(Kind::Ok, b) => Some(b),
        _ => None,
    }
}

/// `Some("pong <version> <pid>")` when a daemon answers on `sock`.
pub fn ping(sock: &Path) -> Option<String> {
    ctl_body(sock, "CTL ping\n").filter(|r| r.starts_with("pong "))
}

/// Send a control verb (`reload`, `stop`, `ping`, `status`).
pub fn ctl(verb: &str) -> Option<String> {
    ctl_body(&paths::socket(), &format!("CTL {verb}\n"))
}

/// The daemon's own status JSON, or what the state dir says when it is down.
pub fn status_value() -> serde_json::Value {
    if let Some(v) = ctl("status").and_then(|s| serde_json::from_str(&s).ok()) {
        return v;
    }
    let ev = health::events();
    serde_json::json!({
        "running": false,
        "breaker": health::breaker_remaining().map_or("closed".to_string(), |d| defaults::render("msg.state_open", &[("secs", &(d.as_secs() + 1))])),
        "crashloop": health::crashloop_remaining().map_or("clear".to_string(), |d| defaults::render("msg.state_stopped", &[("secs", &(d.as_secs() + 1))])),
        "health": health::summary(),
        "last_event": ev.last().map(|e| format!("{} {}", e.kind, e.code)),
    })
}

/// `ah-engine status` as one JSON line.
pub fn status() -> String {
    status_value().to_string()
}

/// Send a control verb that answers with JSON (`metrics`, `impact`); `None` when there is no daemon or the reply is not JSON.
pub fn ctl_json(verb: &str) -> Option<serde_json::Value> {
    ctl(verb).and_then(|s| serde_json::from_str(&s).ok())
}

/// Start a detached daemon (unless the `nospawn` env var is set); `None` when it could not be started, logged with the OS
/// error (review finding 18: a fork that failed with EAGAIN or ENOMEM was not on record).
pub fn spawn_daemon() -> Option<std::process::Child> {
    if defaults::env_var("nospawn").is_some() {
        return None;
    }
    let spawn_failed = |e: std::io::Error| {
        log_fallback("spawn_fail", &format!("os{}", e.raw_os_error().unwrap_or(0)), &defaults::render("msg.log_daemon_spawn_failed", &[("err", &e)]));
    };
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            spawn_failed(e);
            return None;
        }
    };
    let mut cmd = Command::new(exe);
    // The allocator is chosen before the daemon's first allocation, so the configured one travels in its environment.
    let alloc_env = defaults::text("diagnostics.allocator_env");
    if std::env::var_os(alloc_env).is_none() {
        let want = defaults::text("diagnostics.allocator");
        if defaults::list("diagnostics.allocator_choices").contains(&want) {
            cmd.env(alloc_env, want);
        } else {
            log_fallback("alloc_invalid", "config", &defaults::render("msg.log_allocator_invalid", &[("value", &want)]));
            cmd.env(alloc_env, "jemalloc");
        }
    }
    // The allocator's purge tuning is read by jemalloc at its first allocation, so it has to be in the environment the daemon starts with.
    let conf = defaults::text("daemon.malloc_conf");
    if !conf.is_empty() {
        for var in defaults::list("daemon.malloc_conf_vars") {
            if std::env::var_os(var).is_none() {
                cmd.env(var, conf);
            }
        }
    }
    match cmd.arg(defaults::text("health.serve_arg")).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn() {
        Ok(child) => Some(child),
        Err(e) => {
            spawn_failed(e);
            None
        }
    }
}

/// What `hook` prints and exits with.
#[derive(Debug, PartialEq, Eq)]
pub struct Outcome {
    /// What to print on stdout.
    pub out: String,
    /// The process exit code.
    pub code: i32,
    /// Text for stderr (a built-in check that blocks the way the Node guards do: exit 2 + reason on stderr).
    pub err: String,
}

/// Ask the engine. `None` = no daemon verdict within the deadline.
fn engine_attempt(raw: &str, cfg: &ClientConfig, have_fallback: bool) -> Option<String> {
    if raw.len() as u64 > crate::defaults::num("daemon.max_request") || health::breaker_remaining().is_some() || health::crashloop_remaining().is_some() {
        return None;
    }
    let payload = format!("V {}\n{}\n{}", crate::version(), crate::reqenv::RequestEnv::capture().to_line(), raw);
    attempt(payload.as_bytes(), cfg, have_fallback)
}

/// Send one request (a hook `V` or a dispatch `D` request) to the daemon, starting it when none answers. `None` =
/// fail open for hook callers; with `have_fallback` a cold start does not wait.
pub(crate) fn attempt(payload: &[u8], cfg: &ClientConfig, have_fallback: bool) -> Option<String> {
    attempt_with(payload, cfg, have_fallback, false)
}

/// [`attempt`] for a caller that may still run Node hooks after an OK reply (its answers can contain a deferral): the wait marker
/// stays in place after the reply, so the wrapper's watchdog keeps its extended window while that work is unresolved. The caller
/// ends it with [`release_wait_marker`] once its final result is ready.
pub(crate) fn attempt_holding_wait(payload: &[u8], cfg: &ClientConfig, have_fallback: bool) -> Option<String> {
    attempt_with(payload, cfg, have_fallback, true)
}

/// Remove the wait marker: the call's final result is ready.
pub(crate) fn release_wait_marker() {
    wait_marker(false);
}

fn attempt_with(payload: &[u8], cfg: &ClientConfig, have_fallback: bool, hold_wait_on_ok: bool) -> Option<String> {
    LAST_NON_OK_REPLY.set(false);
    LAST_UNAVAILABLE.set(false);
    if health::breaker_remaining().is_some() || health::crashloop_remaining().is_some() || daemon_down_marked() {
        note_unavailable();
        health::log_event("client_skip", "daemon", defaults::text("msg.client_skip"));
        return None;
    }
    let sock = paths::socket();
    wait_marker(true);
    match exchange_for(&sock, payload, cfg.deadline, wait_window(cfg.deadline)) {
        Exch::Reply(Kind::Ok, body) => {
            if !hold_wait_on_ok {
                wait_marker(false);
            }
            clear_daemon_down_marker();
            clear_slow_streak();
            Some(body)
        }
        Exch::Reply(_, _) => {
            // a completed valid reply (BUSY / ERR) is not a slow one: the streak counts consecutive slow replies only
            clear_slow_streak();
            LAST_NON_OK_REPLY.set(true);
            None
        }
        Exch::Failed(why) => {
            wait_marker(false);
            note_unavailable();
            mark_daemon_down(&why);
            if !health::crashloop_tripped(cfg)
                && let Some(_spawn_lock) = spawn_lock()
            {
                health::log_event("client_spawn_attempt", "singleflight", &why);
                let _ = spawn_daemon();
            }
            health::breaker_failure(cfg, &why);
            None
        }
        Exch::Slow(why) => {
            // nothing came within the whole window, but the daemon may have processed the request already: running the Node
            // hooks too would count the call twice, so this call fails open (the unavailable path), never to Node
            wait_marker(false);
            note_unavailable();
            health::log_event("client_slow", "daemon", &why);
            if slow_streak_tripped() {
                mark_daemon_down(&why); // wedged: later clients skip it
            }
            None
        }
        Exch::Hung(why, confirmed) => {
            // stopped or wedged, not slow: this call fails open and the daemon is skipped until the marker expires. A first
            // stale sample only raises a suspicion; the first call after the marker that finds the same heartbeat still
            // unchanged confirms it, and the daemon is replaced (the new one clears the down marker). The marker comes first,
            // so a client cut off mid-way still leaves it; the wait marker stays until the replacement is done, so the
            // wrapper's watchdog does not cut it off (single-flight: one call pays it).
            note_unavailable();
            clear_slow_streak();
            health::log_event("client_hung", "daemon", &why);
            mark_daemon_down(&why);
            if confirmed && replace_hung_daemon(cfg, &why) {
                clear_daemon_down_marker();
            }
            wait_marker(false);
            None
        }
        Exch::Absent => {
            wait_marker(false);
            note_unavailable();
            if health::crashloop_tripped(cfg) {
                return None;
            }
            let _spawn_lock = spawn_lock()?;
            health::log_event("client_spawn_attempt", "singleflight", "absent");
            let Some(mut child) = spawn_daemon() else {
                mark_daemon_down("spawn");
                return None;
            };
            if have_fallback {
                return None; // the Node hook answers this call; the daemon is up for the next one
            }
            let start = Instant::now();
            let cold_wait = defaults::millis("client.cold_start_wait_ms");
            while start.elapsed() < cold_wait {
                if let Ok(Some(st)) = child.try_wait() {
                    use std::os::unix::process::ExitStatusExt;
                    if let Some(sig) = st.signal() {
                        health::log_event("start_fail", &format!("sig{sig}"), defaults::text("msg.log_daemon_killed"));
                        health::record_failure("start_fail", &format!("sig{sig}"), defaults::text("msg.log_daemon_killed"));
                    }
                    ping(&sock)?;
                }
                if let Exch::Reply(Kind::Ok, body) = exchange(&sock, payload, cfg.deadline) {
                    return Some(body);
                }
                std::thread::sleep(defaults::millis("client.cold_start_poll_ms"));
            }
            health::log_event("client_down", "daemon", "cold_start");
            None
        }
    }
}

/// End a hung daemon and start a new one; true once the new one is started. Single-flight (the spawn lock) and gated by the
/// crash-loop rule. Signalled only when every check holds: the heartbeat still names the singleton lock holder, is still stale,
/// and is still the exact one a confirmed suspicion held unchanged for `client.heartbeat_confirm_ms`; it belongs to this
/// instance (state dir); the pid is this engine's daemon process; and the operating system still reports the start time and
/// executable the heartbeat recorded (the same process generation, not a reused pid). The heartbeat and the generation are
/// read again after the process probe, immediately before the signal ([`crate::procid::signal_verified`]: a pidfd on Linux).
/// Anything else is spared and logged. SIGKILL, because a stopped process acts on nothing else.
fn replace_hung_daemon(cfg: &ClientConfig, why: &str) -> bool {
    if health::crashloop_tripped(cfg) {
        return false;
    }
    let Some(_spawn_lock) = spawn_lock() else { return false };
    let stale = defaults::millis("client.heartbeat_stale_ms");
    let still_hung = |hb: &health::Heartbeat| hb.age > stale && health::hang_confirmed(hb);
    let Some(hb) = health::heartbeat_of_lock_holder().filter(|hb| still_hung(hb)) else { return false };
    let pid = hb.pid;
    let unchanged = || health::heartbeat_of_lock_holder().is_some_and(|now| now.ident == hb.ident && now.mtime_ns == hb.mtime_ns && still_hung(&now));
    let killed = pid != std::process::id()
        && hb.generation().is_some()
        && health::pid_is_engine(pid)
        // The slow OS reads (`names_running`) go first and the heartbeat re-read is the LAST step before the signal. Read-then-signal
        // cannot be made atomic (no handle ties a heartbeat read to a delivery); the residual is acceptable because a live daemon
        // that recovers from a confirmed stall of at least `client.heartbeat_confirm_ms` must beat again within microseconds of
        // running, and the client must be descheduled exactly across that moment.
        && crate::procid::signal_verified(pid, libc::SIGKILL, || hb.names_running() && unchanged());
    if !killed {
        health::log_event("client_hung_spared", "daemon", &defaults::render("msg.log_hung_spared", &[("pid", &pid), ("why", &why)]));
        return false;
    }
    health::clear_hang_suspicion();
    health::log_event("client_hung_kill", "daemon", &defaults::render("msg.log_hung_kill", &[("pid", &pid), ("why", &why)]));
    health::log_event("client_spawn_attempt", "singleflight", why);
    spawn_daemon().is_some()
}

/// Log a fallback failure; the state dir may not exist yet (no daemon ever ran here), and the event must still be on record.
fn log_fallback(kind: &str, code: &str, detail: &str) {
    crate::discard::harmless(crate::limits::ensure_private_dir(&paths::dir())); // keep: a failure surfaces at the next create in that directory
    health::log_event(kind, code, detail);
}

/// Read `stream` to EOF on a thread; the bytes arrive on the returned channel once, at EOF, with whether the read reached
/// the end cleanly (a read error leaves a partial buffer, which must never be taken for the whole output).
fn read_to_eof(mut stream: impl Read + Send + 'static) -> mpsc::Receiver<(Vec<u8>, bool)> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let clean = stream.read_to_end(&mut b).is_ok();
        // the receiver is gone only when the caller already gave up at its deadline
        crate::discard::harmless(tx.send((b, clean))); // keep: the receiver is gone; nobody is waiting for the result
    });
    rx
}

enum FallbackInput {
    Bytes(Vec<u8>),
    BytesThenStdin(Vec<u8>, std::io::Stdin),
}

enum FallbackResult {
    Answer(Outcome),
    NoDecision(Outcome),
}

/// Run the Node hook: stdin = the payload; stdout, stderr and the exit code are returned. Both streams are read to EOF,
/// bounded only by the overall deadline (`client.fallback_ms`), because a hook can exit before its output is complete
/// (a background process of its own holds the pipe) and an empty stdout would read as an allow.
///
/// `None` when it cannot run or does not finish in time (= the fallback is unavailable, as when the host's own timeout
/// kills a hook). A hook that finished but whose output was still unread at the deadline is an explicit error outcome
/// (exit 1, a message on stderr): never an empty stdout.
fn run_fallback(input: FallbackInput, path: &Path, cfg: &ClientConfig) -> Option<FallbackResult> {
    let node = std::env::var_os(defaults::env_name("node")).unwrap_or_else(|| "node".into());
    // its own process group, so a timeout can take its helpers down with it (they would otherwise hold the pipes open)
    let mut child = Command::new(node).arg(path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).process_group(0).spawn().ok()?;
    let mut stdin = child.stdin.take()?;
    std::thread::spawn(move || match input {
        FallbackInput::Bytes(bytes) => {
            crate::discard::harmless(stdin.write_all(&bytes)); // keep: best effort, fail-open
        }
        FallbackInput::BytesThenStdin(bytes, mut rest) => {
            crate::discard::harmless(stdin.write_all(&bytes)); // keep: best effort, fail-open
            crate::discard::harmless(std::io::copy(&mut rest, &mut stdin)); // keep: best effort, fail-open
        }
    });
    let (out_rx, err_rx) = (read_to_eof(child.stdout.take()?), read_to_eof(child.stderr.take()?));
    let deadline = Instant::now() + cfg.fallback_timeout;
    let (mut status, mut out, mut err) = (None, None, None);
    loop {
        status = status.or_else(|| child.try_wait().ok().flatten());
        out = out.or_else(|| out_rx.try_recv().ok());
        err = err.or_else(|| err_rx.try_recv().ok());
        if let (Some(st), Some((o, o_clean)), Some((e, e_clean))) = (status, &out, &err) {
            use std::os::unix::process::ExitStatusExt;
            if !(*o_clean && *e_clean) {
                // an unreadable pipe is an incomplete answer: say so (exit 1), never an empty or partial stdout that reads as an allow
                log_fallback("fallback_fail", "read", defaults::text("msg.log_fallback_read_error"));
                return Some(FallbackResult::NoDecision(Outcome {
                    out: String::new(),
                    code: 1,
                    err: format!("{}\n", defaults::text("msg.fallback_read_error")),
                }));
            }
            let Some(code) = st.code() else {
                // killed by a signal (out of memory, a crash): no decision, never an exit 0 that reads as an allow
                let sig = st.signal().unwrap_or(0);
                log_fallback("fallback_fail", &format!("sig{sig}"), &defaults::render("msg.log_fallback_signal", &[("signal", &sig)]));
                return Some(FallbackResult::NoDecision(Outcome {
                    out: String::new(),
                    code: 1,
                    err: format!("{}\n", defaults::render("msg.fallback_signal", &[("signal", &sig)])),
                }));
            };
            return Some(FallbackResult::Answer(Outcome { out: String::from_utf8_lossy(o).to_string(), code, err: String::from_utf8_lossy(e).to_string() }));
        }
        if Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(defaults::millis("client.fallback_poll_ms"));
    }
    let finished = status.is_some();
    // the whole group, as `dispatch::node` does: a helper the hook left behind holds its pipes and must not outlive the deadline
    // SAFETY: killpg only sends a signal; the group id is the child we spawned as its own group leader
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    if !finished {
        crate::discard::harmless(child.kill()); // keep: reaping or draining a child or thread that already ended
        crate::discard::harmless(child.wait()); // keep: reaping or draining a child or thread that already ended
        log_fallback("fallback_fail", "timeout", defaults::text("msg.log_fallback_timeout"));
        return None;
    }
    log_fallback("fallback_read_timeout", "-", defaults::text("msg.log_fallback_read_timeout"));
    Some(FallbackResult::NoDecision(Outcome { out: String::new(), code: 1, err: format!("{}\n", defaults::text("msg.fallback_read_timeout")) }))
}

/// What an OK reply body means: exact bytes, an exit-2 block, or plain stdout. `None` when the body claims to be exact
/// bytes but does not parse as such: a damaged verdict must never reach the host as plain stdout (an allow), so the caller
/// runs the Node fallback instead.
fn reply_outcome(body: String) -> Option<Outcome> {
    if let Some(j) = body.strip_prefix(crate::hookio::EXACT) {
        let x = serde_json::from_str::<(i32, String, String)>(j).ok()?;
        return Some(Outcome { out: x.1, code: x.0, err: x.2 });
    }
    if let Some(reason) = body.strip_prefix(crate::hookio::EXIT2) {
        return Some(Outcome { out: String::new(), code: 2, err: reason.to_string() });
    }
    Some(Outcome { out: body, code: 0, err: String::new() })
}

fn guarded(event: &str) -> bool {
    crate::defaults::list("dispatch.guard_events").contains(&event)
}

fn event_from_lossy(raw: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(raw);
    if let Ok(p) = serde_json::from_str::<serde_json::Value>(&text) {
        return crate::hookio::event_of(&p).map(str::to_owned);
    }
    event_from_prefix(&text)
}

fn skip_ws(bytes: &[u8], mut i: usize) -> usize {
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    i
}

fn string_end(bytes: &[u8], i: usize) -> Option<usize> {
    if bytes.get(i) != Some(&b'"') {
        return None;
    }
    let mut esc = false;
    for (off, b) in bytes[i + 1..].iter().enumerate() {
        if esc {
            esc = false;
        } else if *b == b'\\' {
            esc = true;
        } else if *b == b'"' {
            return Some(i + 1 + off + 1);
        }
    }
    None
}

fn skip_value(bytes: &[u8], mut i: usize) -> Option<usize> {
    let mut depth = 0usize;
    loop {
        match bytes.get(i).copied() {
            Some(b'"') => i = string_end(bytes, i)?,
            Some(b'{' | b'[') => {
                depth += 1;
                i += 1;
            }
            Some(b'}' | b']') if depth > 0 => {
                depth -= 1;
                i += 1;
            }
            Some(b',' | b'}') if depth == 0 => return Some(i),
            Some(_) => i += 1,
            None => return None,
        }
    }
}

fn best_event(keys: &[&str], found: &[(String, String)]) -> Option<String> {
    keys.iter().find_map(|want| found.iter().find(|(key, _)| key == want).map(|(_, value)| value.clone()))
}

fn event_from_prefix(text: &str) -> Option<String> {
    let keys = defaults::list("hook.event_keys");
    let bytes = text.as_bytes();
    let mut i = skip_ws(bytes, 0);
    if bytes.get(i) != Some(&b'{') {
        return None;
    }
    i += 1;
    let mut found: Vec<(String, String)> = Vec::new();
    loop {
        i = skip_ws(bytes, i);
        if bytes.get(i) == Some(&b'}') {
            break;
        }
        let key_end = match string_end(bytes, i) {
            Some(key_end) => key_end,
            None => return best_event(&keys, &found),
        };
        let key: String = match serde_json::from_str(&text[i..key_end]).ok() {
            Some(key) => key,
            None => return best_event(&keys, &found),
        };
        i = skip_ws(bytes, key_end);
        if bytes.get(i) != Some(&b':') {
            return best_event(&keys, &found);
        }
        i = skip_ws(bytes, i + 1);
        if keys.iter().any(|k| k == &key) {
            let value_end = match string_end(bytes, i) {
                Some(value_end) => value_end,
                None => return best_event(&keys, &found),
            };
            let value = match serde_json::from_str(&text[i..value_end]).ok() {
                Some(value) => value,
                None => return best_event(&keys, &found),
            };
            found.push((key, value));
            i = value_end;
        } else {
            i = match skip_value(bytes, i) {
                Some(i) => i,
                None => return best_event(&keys, &found),
            };
        }
        if bytes.get(i) == Some(&b',') {
            i += 1;
        }
    }
    best_event(&keys, &found)
}

/// Core of `engine hook`. Pure of process exit.
pub fn run(raw: &str, fallback: Option<&Path>) -> Outcome {
    run_bytes(raw.as_bytes().to_vec(), false, fallback, None, false)
}

/// Core of `engine hook` for raw stdin bytes. `force_fallback` means the client cannot safely ask the engine (invalid
/// UTF-8, a capped read, or a stdin read error), so the Node fallback receives the exact bytes the client read.
fn run_bytes(raw: Vec<u8>, force_fallback: bool, fallback: Option<&Path>, rest: Option<std::io::Stdin>, fail_closed_unavailable: bool) -> Outcome {
    if raw.is_empty() && !force_fallback {
        return Outcome { out: String::new(), code: 0, err: String::new() };
    }
    let cfg = ClientConfig::from_env();
    // Fail fast: an engine that cannot answer is no verdict, so hook callers fail open instead of waiting for fallback work.
    let event_name = event_from_lossy(&raw);
    let guard_without_fallback = fallback.is_none() && event_name.as_deref().is_some_and(guarded);
    let text = std::str::from_utf8(&raw).ok();
    if !force_fallback && let Some(raw) = text {
        if let Some(body) = engine_attempt(raw, &cfg, fallback.is_some())
            && let Some(o) = reply_outcome(body)
        {
            return o;
        }
        let non_ok_reply = take_non_ok_reply();
        let unavailable = take_unavailable() || fail_open_unavailable();
        if !non_ok_reply && unavailable && raw.len() as u64 <= defaults::num("daemon.max_request") {
            return Outcome { out: env_advisory_output(raw, "").unwrap_or_default(), code: 0, err: String::new() };
        }
    }
    let advisory_raw = if force_fallback { None } else { text.map(str::to_owned) };
    let input = match rest {
        Some(rest) => FallbackInput::BytesThenStdin(raw, rest),
        None => FallbackInput::Bytes(raw),
    };
    let unavailable = || {
        if guard_without_fallback {
            let why = defaults::text("msg.client_no_fallback_guard");
            log_fallback("fallback_fail", "none", why);
            // no Node to run the hook (dispatch.defer_to_node 0): the event's configured failure mode answers
            if let Some(ev) = event_name.as_deref()
                && let Some(o) = crate::dispatch::no_node_answer(ev, None, "infra", why)
            {
                return o;
            }
            Outcome { out: String::new(), code: defaults::num("dispatch.defer_exit") as i32, err: format!("{why}\n") }
        } else if fail_closed_unavailable {
            Outcome { out: String::new(), code: 2, err: defaults::text("msg.client_fallback_unavailable").into() }
        } else if force_fallback {
            Outcome { out: String::new(), code: 0, err: defaults::text("msg.client_fallback_unavailable").into() }
        } else {
            Outcome { out: String::new(), code: 0, err: String::new() }
        }
    };
    let mut o = match fallback.and_then(|p| run_fallback(input, p, &cfg)) {
        Some(FallbackResult::Answer(o)) => o,
        Some(FallbackResult::NoDecision(mut o)) if force_fallback && fail_closed_unavailable => {
            o.code = 2;
            o
        }
        Some(FallbackResult::NoDecision(mut o)) if force_fallback => {
            o.code = 0;
            o
        }
        Some(FallbackResult::NoDecision(o)) => o,
        None => unavailable(),
    };
    // We are running on the built-in checks: tell the agent once per session if the engine is in a known-bad state.
    if o.code == 0
        && paths::dir().join(defaults::text("files.failure")).exists()
        && let Some(raw) = advisory_raw
        && let Some(m) = advisory_output(&raw, o.out.trim())
    {
        o.out = m;
    }
    o
}

fn advisory_output(raw: &str, existing: &str) -> Option<String> {
    if !paths::dir().join(defaults::text("files.failure")).exists() {
        return None;
    }
    let p: serde_json::Value = serde_json::from_str(raw).ok()?;
    let session = p["session_id"].as_str().unwrap_or("-");
    let event = crate::hookio::event_of(&p).unwrap_or("");
    health::advisory(session).and_then(|text| health::merge_advisory(event, existing, &text))
}

fn env_advisory_output(raw: &str, existing: &str) -> Option<String> {
    let f: serde_json::Value = std::fs::read_to_string(state_file("failure")).ok().and_then(|s| serde_json::from_str(&s).ok())?;
    if f["class"] != "env" || health::now_ms().saturating_sub(f["ts"].as_u64().unwrap_or(0)) > defaults::num("health.advisory_ttl_ms") {
        return None;
    }
    advisory_output(raw, existing)
}

fn fallback_arg(args: &[String]) -> Option<PathBuf> {
    args.iter()
        .position(|a| a == "--fallback")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::var_os(defaults::env_name("fallback")).map(PathBuf::from))
}

/// `engine hook`: read stdin, print the result, exit with the Node hook's code (0 when the engine answered).
pub fn hook_main(args: &[String]) -> i32 {
    let res = std::panic::catch_unwind(|| {
        let fallback = fallback_arg(args);
        let max = defaults::num("client.max_stdin");
        let mut raw = Vec::new();
        let mut stdin = std::io::stdin();
        let read = stdin.by_ref().take(max + 1).read_to_end(&mut raw);
        let cap_hit = raw.len() as u64 > max;
        let force_fallback = read.is_err() || cap_hit || std::str::from_utf8(&raw).is_err();
        let rest = (force_fallback && cap_hit).then_some(stdin);
        // a stdin I/O error is an internal fault and fails open; an oversize or non-UTF-8 payload is deliberate and stays fail-closed on guards
        let fail_closed_unavailable = force_fallback && read.is_ok() && event_from_lossy(&raw).is_none_or(|event| guarded(&event));
        let o = run_bytes(raw, force_fallback, fallback.as_deref(), rest, fail_closed_unavailable);
        if !o.err.is_empty() {
            let mut se = std::io::stderr();
            crate::discard::harmless(se.write_all(o.err.as_bytes())); // keep: a closed pipe leaves nobody to tell
            crate::discard::harmless(se.flush()); // keep: best effort, fail-open
        }
        if !o.out.is_empty() {
            let mut so = std::io::stdout();
            crate::discard::harmless(so.write_all(o.out.as_bytes())); // keep: a closed pipe leaves nobody to tell
            if !o.out.ends_with('\n') {
                crate::discard::harmless(so.write_all(b"\n")); // keep: a closed pipe leaves nobody to tell
            }
            crate::discard::harmless(so.flush()); // keep: a closed pipe leaves nobody to tell
        }
        o.code
    });
    res.unwrap_or_else(|_| panic_code(args))
}

/// The exit code after a panic in [`hook_main`]: an internal client error fails open (exit 0) and says why in the health log;
/// it never blocks the session and never starts the Node hooks (their run is not bounded by the client deadline). Every read
/// is guarded: the panic may have come from the defaults or the log itself.
fn panic_code(_args: &[String]) -> i32 {
    crate::discard::harmless(std::panic::catch_unwind(|| {
        health::log_event("client_panic", "panic", defaults::text("msg.log_client_panic"));
    })); // keep: a failing log must not turn the fail-open into a second panic
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::checks::Exact;

    #[test]
    fn only_a_missing_socket_means_no_daemon() {
        // review finding 18: any stat error read as "no daemon" (and started a second one); only ENOENT does now
        let dir = std::env::temp_dir().join(format!("ah-client-stat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("not-a-dir");
        std::fs::write(&file, "x").unwrap();
        assert!(matches!(exchange_inner(&dir.join("absent.sock"), b"CTL ping\n", Duration::from_millis(200), Duration::from_millis(200)), Exch::Absent));
        // a path through a regular file: ENOTDIR, a broken install, not an absent daemon
        let r = exchange_inner(&file.join("e.sock"), b"CTL ping\n", Duration::from_millis(200), Duration::from_millis(200));
        assert!(matches!(r, Exch::Failed(_)), "{r:?}");
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn a_reply_written_and_closed_after_the_first_read_timeout_is_still_delivered() {
        // macOS: re-arming SO_RCVTIMEO on a socket the daemon already closed is EINVAL; that must not drop the readable reply
        let dir = std::env::temp_dir().join(format!("ah-client-late-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("d.sock");
        let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let h = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut req = Vec::new();
            c.read_to_end(&mut req).unwrap();
            std::thread::sleep(Duration::from_millis(400));
            std::io::Write::write_all(&mut c, &frame::encode(Kind::Ok, "late-ok")).unwrap();
        }); // dropping `c` closes the socket right after the write
        let r = exchange_inner(&sock, b"CTL ping\n", Duration::from_millis(150), Duration::from_secs(5));
        h.join().unwrap();
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
        assert!(matches!(&r, Exch::Reply(Kind::Ok, b) if b == "late-ok"), "{r:?}");
    }

    #[test]
    fn a_refused_rearm_on_a_closed_socket_leaves_the_buffered_reply_readable() {
        let (mut a, mut b) = UnixStream::pair().unwrap();
        a.shutdown(std::net::Shutdown::Write).unwrap();
        std::io::Write::write_all(&mut b, b"reply").unwrap();
        drop(b);
        std::thread::sleep(Duration::from_millis(50));
        rearm_read_timeout(&a, Duration::from_millis(100)); // EINVAL on macOS here; must neither panic nor fail the exchange
        let mut got = Vec::new();
        a.read_to_end(&mut got).unwrap();
        assert_eq!(got, b"reply");
    }

    #[test]
    fn a_panic_fails_open_even_with_a_node_fallback_given() {
        assert_eq!(panic_code(&["--fallback".into(), "/x/hook.js".into()]), 0);
        assert_eq!(panic_code(&[]), 0);
    }

    #[test]
    fn an_exact_verdict_reaches_the_host_byte_for_byte() {
        let x = Exact::json_block("no \"way\"\n");
        let body = crate::hookio::EXACT.to_string() + &serde_json::json!([x.code, x.out, x.err]).to_string();
        assert_eq!(reply_outcome(body), Some(Outcome { out: x.out, code: 2, err: x.err }));
    }

    #[test]
    fn the_other_reply_shapes_keep_their_meaning() {
        assert_eq!(reply_outcome(format!("{}why\n", crate::hookio::EXIT2)), Some(Outcome { out: String::new(), code: 2, err: "why\n".into() }));
        assert_eq!(reply_outcome("{\"a\":1}".into()), Some(Outcome { out: "{\"a\":1}".into(), code: 0, err: String::new() }));
        assert_eq!(reply_outcome(String::new()).unwrap().code, 0);
    }

    #[test]
    fn a_damaged_exact_verdict_is_no_answer_so_the_fallback_runs() {
        for body in [
            format!("{}not json", crate::hookio::EXACT),
            format!("{}[2,\"out\"]", crate::hookio::EXACT),
            format!("{}[\"2\",\"o\",\"e\"]", crate::hookio::EXACT),
            crate::hookio::EXACT.to_string(),
        ] {
            assert_eq!(reply_outcome(body.clone()), None, "{body}");
        }
    }
}
