//! Hook client. Contract: NEVER fail the host and NEVER mistake a bad reply for "allow".
//!
//! Order of events for `engine hook`:
//!  1. ask the daemon (short deadline, framed reply, size-capped input);
//!  2. a complete OK frame is the answer (its body may be empty = nothing to say);
//!  3. no daemon, timeout, breaker open, or crash-loop stop fails open: print nothing and exit 0;
//!  4. BUSY, ERR, and malformed verdict bodies are healthy negative replies, so the event's configured failure mode answers.
//!
//! The client launches nothing: there is no hook command to fall back to.
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
    /// Set by the dispatcher for a guard event (dispatch.guard_events): such a call waits for a starting daemon.
    static GUARD_CALL: Cell<bool> = const { Cell::new(false) };
}

/// Mark the calls this thread makes next as a guard event's (or not): a guard call that finds no daemon waits for one to start
/// (`client.cold_guard_wait_ms`) instead of answering nothing; prompts and advisories never wait.
pub(crate) fn set_guard_call(on: bool) {
    GUARD_CALL.set(on);
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

/// Open the daemon socket after checking it is a socket of ours: `Err` carries the exchange result to return.
fn connect_checked(sock: &Path) -> Result<UnixStream, Exch> {
    match std::fs::symlink_metadata(sock) {
        // only a missing socket means "no daemon"; any other error (EACCES, ENOTDIR, ELOOP, EIO) is a failed exchange the
        // breaker counts and the log names, never a reason to start a second daemon (review finding 18)
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(Exch::Absent),
        Err(e) => return Err(Exch::Failed(defaults::render("msg.client_io", &[("what", &defaults::text("msg.client_what_stat")), ("err", &e)]))),
        Ok(m) if !m.file_type().is_socket() || m.uid() != crate::limits::uid() => return Err(Exch::Failed(defaults::text("msg.client_bad_socket").into())),
        Ok(_) => {}
    }
    match UnixStream::connect(sock) {
        Ok(s) => Ok(s),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound) => Err(Exch::Absent),
        Err(e) => Err(Exch::Failed(defaults::render("msg.client_connect", &[("err", &e)]))),
    }
}

/// Arm the read timeout. macOS refuses `SO_RCVTIMEO` with EINVAL on a socket whose peer has already closed (the daemon's BUSY
/// reply is written and the connection dropped at once), so a reply that is already buffered would be read as a failed exchange
/// and mark a healthy daemon down. A closed peer cannot block a read (buffered bytes, then end-of-stream), so that one error
/// is not fatal; every other error still is.
fn set_read_timeout_if_open(s: &UnixStream, t: Duration) -> std::io::Result<()> {
    match s.set_read_timeout(Some(t)) {
        Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => Ok(()),
        r => r,
    }
}

fn exchange_inner(sock: &Path, payload: &[u8], deadline: Duration, window: Duration) -> Exch {
    let mut s = match connect_checked(sock) {
        Ok(s) => s,
        Err(e) => return e,
    };
    let io = |r: std::io::Result<()>, what: &str| r.map_err(|e| Exch::Failed(defaults::render("msg.client_io", &[("what", &what), ("err", &e)])));
    if let Err(e) = io(set_read_timeout_if_open(&s, deadline), defaults::text("msg.client_what_timeout"))
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

/// The verdict the client holds, with the socket it came on, until the host has it (see [`finish_ack`]).
struct Pending {
    stream: UnixStream,
    phases: crate::wire::ClientPhases,
}

static PENDING: std::sync::Mutex<Option<Pending>> = std::sync::Mutex::new(None);

/// ACK(res): the daemon's verdict has been handed over: written to the host (a hook call), or taken into the dispatcher, whose
/// own work after it is not the daemon's to wait for (`dispatch::ask_daemon`). A no-op when the call did not use the ack protocol
/// or was already confirmed. Best effort and bounded (`wire.res_wait_ms`): a daemon that cannot take it counts the verdict
/// undelivered, nothing else changes.
pub fn finish_ack() {
    let Some(Pending { mut stream, phases }) = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take() else { return };
    if let Err(e) = stream.set_write_timeout(Some(defaults::millis("wire.res_wait_ms"))).and_then(|_| stream.write_all(&crate::wire::ack_res(&phases))) {
        health::log_event("client_ack_res", "write_failed", &e.to_string());
    }
}

/// The daemon said the reply is a fail-open: log it, and hand it to the launcher through the file it named (`env.fail_open_file`).
fn note_reply_fail_open(reason: &str, check: &str) {
    health::log_event("client_fail_open", reason, check);
    if let Some(p) = defaults::env_var("fail_open_file").filter(|p| !p.is_empty()) {
        let line = format!("reason={reason} check={check}\n");
        let r = std::fs::OpenOptions::new().create(true).append(true).open(&p).and_then(|mut f| f.write_all(line.as_bytes()));
        crate::discard::logged("fail_open_file_write", r);
    }
}

/// One attempt of an ack-mode exchange.
enum Once {
    Done(Exch),
    /// The daemon did not acknowledge the request within `wire.ack_timeout_ms`.
    NoAck,
    /// The request does not take part in the protocol (a control verb): use the original exchange.
    Legacy,
}

fn once_ack(sock: &Path, payload: &[u8], deadline: Duration, window: Duration, retries: u64) -> Once {
    let Some(tagged) = crate::wire::tag_request(payload) else { return Once::Legacy };
    let t0 = Instant::now();
    let mut s = match connect_checked(sock) {
        Ok(s) => s,
        Err(e) => return Once::Done(e),
    };
    let connect_us = t0.elapsed().as_micros() as u64;
    let io = |r: std::io::Result<()>, what: &str| r.map_err(|e| Exch::Failed(defaults::render("msg.client_io", &[("what", &what), ("err", &e)])));
    if let Err(e) = io(s.set_write_timeout(Some(deadline)), defaults::text("msg.client_what_timeout")).and_then(|_| io(s.write_all(&tagged), "write")) {
        return Once::Done(e);
    }
    let written = Instant::now();
    let (mut buf, mut chunk) = (Vec::new(), vec![0u8; defaults::num("io.small_chunk_bytes") as usize]);
    let mut acked: Option<Instant> = None;
    if let Err(e) = io(set_read_timeout_if_open(&s, defaults::millis("wire.ack_timeout_ms").min(window)), defaults::text("msg.client_what_timeout")) {
        return Once::Done(e);
    }
    // ACK(req) first (the reply may follow in the same read, or an error frame may come instead of an ack)
    loop {
        match s.read(&mut chunk) {
            Ok(0) => {
                return Once::Done(Exch::Failed(defaults::render(
                    "msg.client_io",
                    &[("what", &"read"), ("err", &defaults::text("msg.client_closed_before_ack"))],
                )));
            }
            Ok(n) => buf.extend_from_slice(chunk.get(..n).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Once::NoAck,
            Err(e) => return Once::Done(Exch::Failed(defaults::render("msg.client_io", &[("what", &"read"), ("err", &e)]))),
        }
        match crate::wire::parse_ack_req(&buf) {
            crate::wire::AckSeen::Need => continue,
            crate::wire::AckSeen::No => break,
            crate::wire::AckSeen::Req { len, .. } => {
                buf.drain(..len);
                acked = Some(Instant::now());
                break;
            }
        }
    }
    let req_ack_us = acked.map_or(0, |a| a.duration_since(written).as_micros() as u64);
    // acked: never resend from here; wait for the reply up to the hard window (the original read loop's rules)
    let (start, max_reply) = (Instant::now(), defaults::num("client.max_reply") as usize);
    let mut late = false;
    if let Err(e) = io(set_read_timeout_if_open(&s, deadline), defaults::text("msg.client_what_timeout")) {
        return Once::Done(e);
    }
    let mut fo_checked = false;
    loop {
        if !fo_checked {
            // the daemon reports an engine-level fail-open on its own line just before the reply frame
            match crate::wire::parse_fail_open(&buf) {
                crate::wire::FoSeen::Need => {}
                crate::wire::FoSeen::No => fo_checked = true,
                crate::wire::FoSeen::Fo { len, reason, check } => {
                    buf.drain(..len);
                    fo_checked = true;
                    note_reply_fail_open(&reason, &check);
                }
            }
        }
        if let Some(total) = frame::total_len(&buf)
            && buf.len() >= total
        {
            buf.truncate(total);
            break;
        }
        if buf.len() > max_reply {
            break;
        }
        match s.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(chunk.get(..n).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => {
                let why = defaults::render("msg.client_io", &[("what", &"read"), ("err", &e)]);
                if !matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
                    return Once::Done(Exch::Failed(why));
                }
                let left = window.saturating_sub(start.elapsed());
                if left.is_zero() {
                    return Once::Done(Exch::Slow(why));
                }
                if !late {
                    late = true;
                    health::log_event("client_late", "daemon", &why);
                }
                // as in the original exchange: a daemon that acked and then stopped beating is hung, not slow
                if let Some((hung, confirmed)) = stale_heartbeat() {
                    return Once::Done(Exch::Hung(hung, confirmed));
                }
                rearm_read_timeout(&s, left.min(defaults::millis("client.heartbeat_poll_ms")));
            }
        }
    }
    let ack_response_us = acked.unwrap_or(written).elapsed().as_micros() as u64;
    match frame::decode(&buf) {
        Ok((k, body)) => {
            let launcher = std::env::var(defaults::text("launcher.stats_env")).unwrap_or_default();
            let phases = crate::wire::ClientPhases { connect_us, req_ack_us, ack_response_us, retries, launcher };
            *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = acked.map(|_| Pending { stream: s, phases });
            Once::Done(Exch::Reply(k, body))
        }
        Err(e) => Once::Done(Exch::Failed(defaults::render("msg.client_bad_frame", &[("err", &format!("{e:?}"))]))),
    }
}

/// An exchange under the ack protocol: no ACK(req) within `wire.ack_timeout_ms` means the daemon has not started on the request, so it
/// is resent on a fresh connection (the first is closed, and the daemon refuses to judge a request whose client is gone) while the
/// deadline allows; an acked request is never resent.
fn exchange_ack(sock: &Path, payload: &[u8], deadline: Duration, window: Duration) -> Exch {
    let began = Instant::now();
    let mut retries = 0;
    loop {
        let (dl, win) = (deadline.saturating_sub(began.elapsed()), window.saturating_sub(began.elapsed()));
        if dl.is_zero() || win.is_zero() {
            return Exch::Slow(defaults::text("msg.client_ack_timeout").into());
        }
        match once_ack(sock, payload, dl, win, retries) {
            Once::Done(e) => return e,
            Once::Legacy => return exchange_inner(sock, payload, deadline, window),
            Once::NoAck => {
                health::log_event("client_ack_timeout", "daemon", defaults::text("msg.client_ack_timeout"));
                // a daemon that never acknowledges and has stopped beating is hung, not slow: the replacement path, as in the original exchange
                if let Some((hung, confirmed)) = stale_heartbeat() {
                    return Exch::Hung(hung, confirmed);
                }
                if retries >= defaults::num("wire.max_retries") || window.saturating_sub(began.elapsed()) < defaults::millis("wire.retry_min_ms") {
                    // no more resends: like the original exchange, keep watching the daemon's heartbeat for the rest of the window, so a
                    // daemon that went silent and stopped beating is reported hung (and replaced) instead of merely slow
                    while window.saturating_sub(began.elapsed()) > Duration::ZERO {
                        if let Some((hung, confirmed)) = stale_heartbeat() {
                            return Exch::Hung(hung, confirmed);
                        }
                        std::thread::sleep(defaults::millis("client.heartbeat_poll_ms").min(window.saturating_sub(began.elapsed())));
                    }
                    return Exch::Slow(defaults::text("msg.client_ack_timeout").into());
                }
                retries += 1;
            }
        }
    }
}

/// One exchange under a hard overall deadline (the work runs on a thread so even a blocking connect
/// cannot outlive it).
pub fn exchange(sock: &Path, payload: &[u8], deadline: Duration) -> Exch {
    exchange_for(sock, payload, deadline, deadline, false)
}

/// `exchange` that keeps waiting for the reply up to `window` (>= `deadline`) once the deadline has passed.
fn exchange_for(sock: &Path, payload: &[u8], deadline: Duration, window: Duration, ack: bool) -> Exch {
    let window = window.max(deadline);
    let (tx, rx) = mpsc::channel();
    let (sock, payload) = (sock.to_path_buf(), payload.to_vec());
    std::thread::spawn(move || {
        crate::discard::harmless(tx.send(if ack {
            exchange_ack(&sock, &payload, deadline, window)
        } else {
            exchange_inner(&sock, &payload, deadline, window)
        })); // keep: the receiver is gone; nobody is waiting for the result
    });
    rx.recv_timeout(window + defaults::millis("client.deadline_slack_ms")).unwrap_or_else(|_| Exch::Slow(defaults::text("msg.client_timeout").into()))
}

/// The once-per-session notice for a call the engine could not take because its daemon is unreachable (C9): the same text and state
/// file as the launcher's, so a call that went through both is told once. The call itself passes through. Empty when this session
/// already heard it, or when the notice cannot be written (never a second notice for a failed write).
pub(crate) fn unreachable_notice(raw: &str, event: Option<&str>) -> String {
    let sid = serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|p| p.get("session_id").and_then(|v| v.as_str().map(str::to_owned)))
        .unwrap_or_else(|| "none".into());
    let file = state_file("unreachable_notice");
    if std::fs::read_to_string(&file).is_ok_and(|t| t.trim_end() == sid) {
        return String::new();
    }
    crate::discard::harmless(crate::limits::ensure_private_dir(&paths::dir())); // keep: the notice is still shown when the marker cannot be written
    crate::discard::logged("unreachable_notice_write", crate::atomic::write(&file, format!("{sid}\n")));
    defaults::render("msg.engine_unreachable_notice", &[("event", &event.unwrap_or_default()), ("why", &defaults::text("msg.engine_unreachable_why_daemon"))])
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
            crate::discard::logged("wait_file_write", create_marker(std::path::Path::new(&p)));
        } else {
            crate::discard::harmless(std::fs::remove_file(p)); // keep: an absent marker is the desired state
        }
    }
}

/// Create the empty wait marker in place. The wrapper only tests that the file exists and a lost marker at a crash costs
/// nothing, so there is no temp file, rename or fsync (the atomic write cost 3-5 ms on every hook).
fn create_marker(p: &std::path::Path) -> std::io::Result<()> {
    std::fs::File::create(p).map(drop)
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

/// Whether a daemon holds the singleton lock (`paths::lock_for`): one that is starting, serving or draining. It is the daemon's own
/// test for "another daemon owns this socket", and unlike a ping it does not depend on the daemon having a free worker.
fn daemon_lock_held(sock: &Path) -> bool {
    let Ok(f) = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(paths::lock_for(sock)) else { return false };
    // SAFETY: `f` is an open file owned by this scope, so its descriptor is valid; `flock` takes only the descriptor and a flag.
    unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) != 0 }
}

/// The single-flight lock, but only for a client that has to start a daemon. The lock is free once a daemon listens (it releases it
/// then), so a client that failed against that daemon a moment earlier (a busy reply, a timeout), or that probed before it listened,
/// can win the lock with a daemon already up. Under the lock it asks whether a daemon holds the singleton lock; one that does is
/// not started a second time (the second `serve` would only be refused by that lock, a process started for nothing).
fn spawn_lock_if_absent(sock: &Path) -> Option<SpawnLock> {
    let lock = spawn_lock()?;
    if daemon_lock_held(sock) {
        release_spawn_lock();
        return None;
    }
    Some(lock)
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
    spawn_daemon_from(std::env::current_exe(), None)
}

/// Start a detached daemon from `exe` (the installer starts the binary it just installed, not itself). `plugin_root`, when given,
/// is the plugin root the daemon loads: the installer may itself run against a different tree than the live one.
pub fn spawn_daemon_from(exe: std::io::Result<PathBuf>, plugin_root: Option<&Path>) -> Option<std::process::Child> {
    spawn_daemon_from_reason(exe, plugin_root, health::starts::reason("hook"))
}

/// Start with explicit provenance from the actual launcher (hooks and the install routine share the spawn machinery).
pub fn spawn_daemon_from_reason(exe: std::io::Result<PathBuf>, plugin_root: Option<&Path>, reason: &str) -> Option<std::process::Child> {
    if defaults::env_var("nospawn").is_some() {
        return None;
    }
    let spawn_failed = |e: std::io::Error| {
        log_fallback("spawn_fail", &format!("os{}", e.raw_os_error().unwrap_or(0)), &defaults::render("msg.log_daemon_spawn_failed", &[("err", &e)]));
    };
    let exe = match exe {
        Ok(p) => p,
        Err(e) => {
            spawn_failed(e);
            return None;
        }
    };
    let mut cmd = Command::new(exe);
    // A daemon serves every later session, so it starts from the allowlisted part of this environment and from the home
    // directory, never the starting hook's own (the daemon drops the rest itself too, see `daemonenv`; doing it here as well
    // keeps the process image, as `ps` shows it, free of the session's values).
    cmd.env_clear()
        .envs(std::env::vars().filter(|(k, _)| crate::daemonenv::kept(k)))
        .current_dir(crate::daemonenv::cwd(defaults::env_var("home").map(PathBuf::from)));
    if let Some(root) = plugin_root {
        cmd.env(defaults::env_name("plugin_root"), root);
    }
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
    match cmd
        .arg(defaults::text("health.serve_arg"))
        .arg(defaults::text("health.start_reason_flag"))
        .arg(reason)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
    {
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
fn engine_attempt(raw: &str, cfg: &ClientConfig) -> Option<String> {
    if raw.len() as u64 > crate::defaults::num("daemon.max_request") || health::breaker_remaining().is_some() || health::crashloop_remaining().is_some() {
        return None;
    }
    let payload = format!("V {}\n{}\n{}", crate::version(), crate::reqenv::RequestEnv::capture().to_line(), raw);
    attempt(payload.as_bytes(), cfg, false)
}

/// Send one request (a hook `V` or a dispatch `D` request) to the daemon, starting it when none answers. `None` =
/// fail open for hook callers; with `answer_now` a cold start does not wait (the dispatcher's own callers).
pub(crate) fn attempt(payload: &[u8], cfg: &ClientConfig, answer_now: bool) -> Option<String> {
    attempt_with(payload, cfg, answer_now, false)
}

/// [`attempt`] for a caller that may still run Node hooks after an OK reply (its answers can contain a deferral): the wait marker
/// stays in place after the reply, so the wrapper's watchdog keeps its extended window while that work is unresolved. The caller
/// ends it with [`release_wait_marker`] once its final result is ready.
pub(crate) fn attempt_holding_wait(payload: &[u8], cfg: &ClientConfig, answer_now: bool) -> Option<String> {
    attempt_with(payload, cfg, answer_now, true)
}

/// Remove the wait marker: the call's final result is ready.
pub(crate) fn release_wait_marker() {
    wait_marker(false);
}

fn attempt_with(payload: &[u8], cfg: &ClientConfig, answer_now: bool, hold_wait_on_ok: bool) -> Option<String> {
    LAST_NON_OK_REPLY.set(false);
    LAST_UNAVAILABLE.set(false);
    if health::breaker_remaining().is_some() || health::crashloop_remaining().is_some() || daemon_down_marked() {
        note_unavailable();
        health::log_event("client_skip", "daemon", defaults::text("msg.client_skip"));
        return None;
    }
    let sock = paths::socket();
    wait_marker(true);
    // the ack protocol only with a daemon that announced it (an older one would wait for an end-of-stream that never comes)
    let ack = defaults::num("wire.ack") == 1 && crate::wire::caps_path().exists();
    match exchange_for(&sock, payload, cfg.deadline, wait_window(cfg.deadline), ack) {
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
                && let Some(_spawn_lock) = spawn_lock_if_absent(&sock)
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
            if health::crashloop_tripped(cfg) {
                wait_marker(false);
                note_unavailable();
                return None;
            }
            // a guard call waits only for a daemon that is really starting; with spawning disabled (no daemon will come) it keeps
            // the unavailable contract: fail open, run no hooks
            if !GUARD_CALL.get() || defaults::env_var("nospawn").is_some() {
                return absent_unguarded(&sock, payload, cfg, answer_now);
            }
            absent_guarded(&sock, payload, cfg, hold_wait_on_ok)
        }
    }
}

/// No daemon listens, spawning is allowed, and this is a guard event's call: a daemon is really starting. The call that takes the
/// spawn lock starts it; a call that finds the lock held finds it being started by another call. Both wait for it to answer within
/// `client.cold_guard_wait_ms` (the wait marker stays, so the wrapper's watchdog grants the slow window), then send the request once,
/// on one connection, for what is left of the slow window (`wait_window`): one absolute budget, so the call never outlives the
/// wrapper's watchdog. A call that gave up at once answered nothing, so every guard hook arriving while a daemon (re)started was an
/// allow, a lost block. A start that fails (the spawn fails, or the daemon never answers in time) ends the call on the unavailable
/// path exactly as before: fail open, the spawn failure also marks the daemon down. The request is not
/// sent under the ack protocol: the new daemon queues the whole burst of calls that waited with it, so a request can sit
/// unacknowledged past `wire.ack_timeout_ms`, and the ack protocol would resend it and then give up; one connection is never resent,
/// so never judged twice.
fn absent_guarded(sock: &Path, payload: &[u8], cfg: &ClientConfig, hold_wait_on_ok: bool) -> Option<String> {
    let start = Instant::now();
    // the spawn lock is held until this call's wait ends, so the calls arriving meanwhile wait instead of spawning again
    let (spawn_guard, mut child) = match spawn_lock_if_absent(sock) {
        Some(lock) => {
            health::log_event("client_spawn_attempt", "singleflight", "absent");
            let Some(child) = spawn_daemon() else {
                wait_marker(false);
                note_unavailable();
                mark_daemon_down("spawn");
                return None;
            };
            (Some(lock), Some(child))
        }
        None => (None, None),
    };
    let window = wait_window(cfg.deadline);
    let cold_wait = defaults::millis("client.cold_guard_wait_ms").min(window);
    let ctl = defaults::millis("client.ctl_timeout_ms");
    while start.elapsed() < cold_wait {
        if let Some(Ok(Some(st))) = child.as_mut().map(|c| c.try_wait()) {
            use std::os::unix::process::ExitStatusExt;
            if let Some(sig) = st.signal() {
                health::log_event("start_fail", &format!("sig{sig}"), defaults::text("msg.log_daemon_killed"));
                health::record_failure("start_fail", &format!("sig{sig}"), defaults::text("msg.log_daemon_killed"));
            }
            child = None; // it exited (another daemon holds the singleton, or it died): keep asking the socket
        }
        // only readiness is polled here, never longer than the budget left
        let probe = ctl.min(cold_wait.saturating_sub(start.elapsed()));
        let up = !probe.is_zero() && matches!(exchange(sock, b"CTL ping\n", probe), Exch::Reply(Kind::Ok, ref b) if b.starts_with("pong "));
        if up {
            drop(spawn_guard);
            let left = window.saturating_sub(start.elapsed());
            return match exchange_for(sock, payload, cfg.deadline.min(left), left, false) {
                Exch::Reply(Kind::Ok, body) => {
                    if !hold_wait_on_ok {
                        wait_marker(false);
                    }
                    clear_daemon_down_marker();
                    Some(body)
                }
                Exch::Reply(_, _) => {
                    wait_marker(false);
                    LAST_NON_OK_REPLY.set(true);
                    None
                }
                _ => {
                    wait_marker(false);
                    note_unavailable();
                    health::log_event("client_down", "daemon", "cold_start");
                    None
                }
            };
        }
        std::thread::sleep(defaults::millis("client.cold_guard_poll_ms").min(cold_wait.saturating_sub(start.elapsed())));
    }
    wait_marker(false);
    note_unavailable();
    health::log_event("client_down", "daemon", "cold_start");
    None
}

/// No daemon listens and the call is not a guard event's: start one and answer at once (prompts and advisories never wait; with `answer_now`
/// the call gets no answer). Otherwise the call waits `client.cold_start_wait_ms` for the new daemon.
fn absent_unguarded(sock: &Path, payload: &[u8], cfg: &ClientConfig, answer_now: bool) -> Option<String> {
    wait_marker(false);
    note_unavailable();
    let _spawn_lock = spawn_lock_if_absent(sock)?;
    health::log_event("client_spawn_attempt", "singleflight", "absent");
    let Some(mut child) = spawn_daemon() else {
        mark_daemon_down("spawn");
        return None;
    };
    if answer_now {
        return None; // no answer for this call (the caller lets it through); the daemon is up for the next one
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
            ping(sock)?;
        }
        if let Exch::Reply(Kind::Ok, body) = exchange(sock, payload, cfg.deadline) {
            return Some(body);
        }
        std::thread::sleep(defaults::millis("client.cold_start_poll_ms"));
    }
    health::log_event("client_down", "daemon", "cold_start");
    None
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

/// Log a client-side failure; the state dir may not exist yet (no daemon ever ran here), and the event must still be on record.
fn log_fallback(kind: &str, code: &str, detail: &str) {
    crate::discard::harmless(crate::limits::ensure_private_dir(&paths::dir())); // keep: a failure surfaces at the next create in that directory
    health::log_event(kind, code, detail);
}

/// What an OK reply body means: exact bytes, an exit-2 block, or plain stdout. `None` when the body claims to be exact
/// bytes but does not parse as such: a damaged verdict must never reach the host as plain stdout (an allow), so the caller
/// treats the call as one without a verdict.
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
pub fn run(raw: &str) -> Outcome {
    run_bytes(raw.as_bytes().to_vec(), false, false)
}

/// Core of `engine hook` for raw stdin bytes. `unaskable` means the client cannot safely ask the engine (invalid UTF-8, a capped
/// read, or a stdin read error); `fail_closed_unavailable` then blocks (exit 2) instead of letting the call through.
fn run_bytes(raw: Vec<u8>, unaskable: bool, fail_closed_unavailable: bool) -> Outcome {
    if raw.is_empty() && !unaskable {
        return Outcome { out: String::new(), code: 0, err: String::new() };
    }
    let cfg = ClientConfig::from_env();
    // Fail fast: an engine that cannot answer is no verdict, so hook callers fail open instead of waiting.
    let event_name = event_from_lossy(&raw);
    let text = std::str::from_utf8(&raw).ok();
    if !unaskable && let Some(raw) = text {
        if let Some(body) = engine_attempt(raw, &cfg)
            && let Some(o) = reply_outcome(body)
        {
            return o;
        }
        let non_ok_reply = take_non_ok_reply();
        let unavailable = take_unavailable() || fail_open_unavailable();
        if !non_ok_reply && unavailable && raw.len() as u64 <= defaults::num("daemon.max_request") {
            return Outcome { out: env_advisory_output(raw, "").unwrap_or_default(), code: 0, err: unreachable_notice(raw, event_name.as_deref()) };
        }
    }
    let advisory_raw = if unaskable { None } else { text.map(str::to_owned) };
    let mut o = if unaskable && fail_closed_unavailable {
        Outcome { out: String::new(), code: 2, err: defaults::text("msg.client_unavailable").into() }
    } else if unaskable {
        Outcome { out: String::new(), code: 0, err: defaults::text("msg.client_unavailable").into() }
    } else if let Some(ev) = event_name.as_deref().filter(|ev| guarded(ev)) {
        // the engine answered with no verdict (a healthy negative reply): the event's configured failure mode answers
        let why = defaults::text("msg.client_no_verdict");
        log_fallback("no_verdict", "none", why);
        crate::dispatch::no_node_answer(ev, None, "infra", why).unwrap_or(Outcome { out: String::new(), code: 0, err: String::new() })
    } else {
        Outcome { out: String::new(), code: 0, err: String::new() }
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

/// `engine hook`: read stdin, print the result and exit with its code (0 when the engine answered or could not).
pub fn hook_main(args: &[String]) -> i32 {
    let res = std::panic::catch_unwind(|| {
        let max = defaults::num("client.max_stdin");
        let mut raw = Vec::new();
        let mut stdin = std::io::stdin();
        let read = stdin.by_ref().take(max + 1).read_to_end(&mut raw);
        let cap_hit = raw.len() as u64 > max;
        let unaskable = read.is_err() || cap_hit || std::str::from_utf8(&raw).is_err();
        // a stdin I/O error is an internal fault and fails open; an oversize or non-UTF-8 payload is deliberate and stays fail-closed on guards
        let fail_closed_unavailable = unaskable && read.is_ok() && event_from_lossy(&raw).is_none_or(|event| guarded(&event));
        let started = std::time::Instant::now();
        let o = run_bytes(raw, unaskable, fail_closed_unavailable);
        crate::debug_log!(
            "client/hook",
            defaults::render("msg.dbg_hook", &[("code", &o.code), ("out", &o.out.len()), ("err", &o.err.len()), ("us", &started.elapsed().as_micros())])
        );
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
    fn the_wait_marker_is_one_plain_empty_file_with_no_temp_file_left() {
        let dir = std::env::temp_dir().join(format!("ah-client-marker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let marker = dir.join("wait");
        create_marker(&marker).unwrap();
        create_marker(&marker).unwrap(); // a second call over an existing marker is fine
        assert_eq!(std::fs::metadata(&marker).unwrap().len(), 0);
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "no temp file next to the marker: {names:?}");
        assert!(create_marker(&dir.join("no-such-dir").join("wait")).is_err(), "a failure is reported to the caller, which logs it");
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
    }

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

    /// The tests below share the process-wide pending ack.
    static ACK_TESTS: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ah-ack-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Read a tagged request off `c` the way the daemon does (head line, then the announced body length); the head line is returned.
    fn read_tagged(c: &mut UnixStream) -> String {
        let mut buf = Vec::new();
        let mut one = [0u8; 1];
        while !buf.ends_with(b"\n") {
            c.read_exact(&mut one).unwrap();
            buf.push(one[0]);
        }
        let head = String::from_utf8(buf).unwrap();
        let mut body = vec![0u8; crate::wire::announced_len(head.trim_end()).expect("an ack-mode head announces its length")];
        c.read_exact(&mut body).unwrap();
        head
    }

    fn read_res(c: &mut UnixStream) -> crate::wire::ClientPhases {
        let mut line = Vec::new();
        let mut one = [0u8; 1];
        while !line.ends_with(b"\n") {
            c.read_exact(&mut one).unwrap();
            line.push(one[0]);
        }
        crate::wire::parse_ack_res(&String::from_utf8(line).unwrap()).expect("ACK(res)")
    }

    #[test]
    fn an_acked_exchange_returns_the_reply_and_confirms_it_after_the_verdict_is_handed_over() {
        let _g = ACK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch("ok");
        let sock = dir.join("d.sock");
        let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let h = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let head = read_tagged(&mut c);
            std::io::Write::write_all(&mut c, &crate::wire::ack_req(7)).unwrap();
            std::io::Write::write_all(&mut c, &frame::encode(Kind::Ok, "verdict")).unwrap();
            (head, read_res(&mut c))
        });
        let r = exchange_ack(&sock, b"V 0.1.0\nE {}\n{}", Duration::from_secs(2), Duration::from_secs(2));
        assert!(matches!(&r, Exch::Reply(Kind::Ok, b) if b == "verdict"), "{r:?}");
        finish_ack();
        let (head, phases) = h.join().unwrap();
        assert!(head.starts_with("V 0.1.0-w1."), "{head}");
        assert_eq!(phases.retries, 0);
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn a_missing_ack_closes_the_connection_and_resends_on_a_fresh_one() {
        let _g = ACK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch("retry");
        let sock = dir.join("d.sock");
        let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let h = std::thread::spawn(move || {
            let (mut first, _) = l.accept().unwrap();
            read_tagged(&mut first); // read, but never ack: a daemon whose queue has not reached it yet
            let (mut second, _) = l.accept().unwrap();
            read_tagged(&mut second);
            std::io::Write::write_all(&mut second, &crate::wire::ack_req(1)).unwrap();
            std::io::Write::write_all(&mut second, &frame::encode(Kind::Ok, "second")).unwrap();
            let res = read_res(&mut second);
            // the first connection was closed by the client before the resend: a read sees the end of the stream
            let mut rest = Vec::new();
            first.read_to_end(&mut rest).unwrap();
            (res, rest)
        });
        let r = exchange_ack(&sock, b"V 0.1.0\nE {}\n{}", Duration::from_secs(3), Duration::from_secs(3));
        assert!(matches!(&r, Exch::Reply(Kind::Ok, b) if b == "second"), "{r:?}");
        finish_ack();
        let (res, rest) = h.join().unwrap();
        assert_eq!(res.retries, 1, "the resend is reported");
        assert!(rest.is_empty());
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn an_acked_request_is_never_resent_however_long_the_judging_takes() {
        let _g = ACK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch("noresend");
        let sock = dir.join("d.sock");
        let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        l.set_nonblocking(true).unwrap();
        let ack_ms = defaults::millis("wire.ack_timeout_ms");
        let h = std::thread::spawn(move || {
            let c = loop {
                match l.accept() {
                    Ok((c, _)) => break c,
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            };
            let mut c = c;
            c.set_nonblocking(false).unwrap();
            read_tagged(&mut c);
            std::io::Write::write_all(&mut c, &crate::wire::ack_req(1)).unwrap();
            std::thread::sleep(ack_ms * 2); // judging takes longer than the ack timeout: still no resend
            std::io::Write::write_all(&mut c, &frame::encode(Kind::Ok, "slow")).unwrap();
            let res = read_res(&mut c);
            std::thread::sleep(Duration::from_millis(50));
            (res, l.accept().is_err())
        });
        let r = exchange_ack(&sock, b"V 0.1.0\nE {}\n{}", Duration::from_secs(5), Duration::from_secs(5));
        assert!(matches!(&r, Exch::Reply(Kind::Ok, b) if b == "slow"), "{r:?}");
        finish_ack();
        let (res, no_second_connection) = h.join().unwrap();
        assert_eq!(res.retries, 0);
        assert!(no_second_connection, "an acked request must not be sent again");
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn a_daemon_that_never_acks_ends_as_slow_after_the_bounded_resends() {
        let _g = ACK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch("old");
        let sock = dir.join("d.sock");
        let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let h = std::thread::spawn(move || {
            // an original daemon: reads to end-of-stream, which an ack-mode client never sends before giving up
            let mut seen = 0;
            while seen < 1 + defaults::num("wire.max_retries") {
                let (mut c, _) = l.accept().unwrap();
                let mut req = Vec::new();
                c.read_to_end(&mut req).unwrap();
                seen += 1;
            }
            seen
        });
        let r = exchange_ack(&sock, b"V 0.1.0\nE {}\n{}", Duration::from_secs(3), Duration::from_secs(3));
        assert!(matches!(r, Exch::Slow(_)), "{r:?}");
        assert_eq!(h.join().unwrap(), 1 + defaults::num("wire.max_retries"));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
    }

    #[test]
    fn control_verbs_never_take_part_in_the_protocol() {
        let _g = ACK_TESTS.lock().unwrap_or_else(|e| e.into_inner());
        let dir = scratch("legacy");
        let sock = dir.join("d.sock");
        let l = std::os::unix::net::UnixListener::bind(&sock).unwrap();
        let h = std::thread::spawn(move || {
            let (mut c, _) = l.accept().unwrap();
            let mut req = Vec::new();
            c.read_to_end(&mut req).unwrap();
            std::io::Write::write_all(&mut c, &frame::encode(Kind::Ok, "pong")).unwrap();
            req
        });
        let r = exchange_ack(&sock, b"CTL ping\n", Duration::from_secs(2), Duration::from_secs(2));
        assert!(matches!(&r, Exch::Reply(Kind::Ok, b) if b == "pong"), "{r:?}");
        assert_eq!(h.join().unwrap(), b"CTL ping\n", "sent untouched, ended with end-of-stream");
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: cleanup that raced; an absent file is the goal state
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
    fn a_panic_fails_open_whatever_the_arguments() {
        assert_eq!(panic_code(&["whatever".into(), "/x/hook.sh".into()]), 0);
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
    fn a_damaged_exact_verdict_is_no_answer() {
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
