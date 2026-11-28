//! The deadline of the request a daemon worker is serving (review finding 4).
//!
//! A client waits `client.deadline_ms` for its reply and then falls back to Node; a reply written after that is lost. The
//! worker therefore records, per request, when its client stops waiting (the moment the connection was accepted plus the
//! client's deadline, which a dispatch request carries and any other request takes from the defaults, minus
//! `daemon.reply_slack_ms` to write the reply), and the inner budgets that can outlast it (a git call, a Jev consult) are
//! clamped to what is left. Outside a request (a CLI command, a test) there is no deadline and nothing is clamped.
//!
//! Every deadline here is a SOFT/HARD pair (owner rule). The SOFT deadline is the client's fail-fast wait (`client.deadline_ms`
//! minus the slack): past it the request is only warned about and counted, and everything keeps running. The HARD deadline
//! (`daemon.request_hard_ms` minus the slack, never below the soft one) is what cuts: a client whose daemon is alive waits for a
//! late reply up to `client.slow_fallback_max_ms` less `client.slow_wait_margin_ms` and uses it, so a guard keeps deciding under
//! load instead of deferring to Node. [`remaining`], [`clamp`], [`in_time`], [`at`] and [`cut_due`] speak for the hard deadline;
//! [`soft_remaining`] and [`note_soft_overrun`] for the soft one.
//!
//! State that silences a later answer (a Stop block's loop counter, a nudge's once-only cap) is staged here during the request
//! ([`crate::atomic::write_after_reply`]) and renamed into place only when the reply reached the client in time
//! ([`commit_staged`]): a client that fell back to Node must not find a stamp for a decision it never received (review P1-2).
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// A staged state write: the written temporary file, its target, and how to rename it.
type Staged = (PathBuf, PathBuf, crate::atomic::Style);

/// The deadlines of the request on this thread.
#[derive(Clone, Copy)]
struct Req {
    arrived: Instant,
    /// When the client's fail-fast wait ends (after the reply slack): warn only.
    soft: Option<Instant>,
    /// When the request is cut (after the reply slack).
    hard: Option<Instant>,
    /// Whether the soft overrun was already reported (once per request).
    noted: bool,
    /// Whether the client cut the request at its own wait ([`client_deadline`]): naming the event then moves nothing.
    cut: bool,
}

thread_local! {
    /// When the current request arrived (accepted), and when its client stops waiting (after the slack).
    static REQ: Cell<Option<Req>> = const { Cell::new(None) };
    /// The hook event of the request being served (set by the dispatch, empty outside one).
    static EVENT: RefCell<Option<String>> = const { RefCell::new(None) };
    /// #969: the load factor (permille) the client passed down for this request; none = unchanged.
    static LOAD: Cell<Option<u64>> = const { Cell::new(None) };
    /// The state writes the current request staged, in order.
    static STAGED: RefCell<Vec<Staged>> = const { RefCell::new(Vec::new()) };
    /// The grace (ms past the request's hard deadline) after which the script call in progress on this thread may be cut; `None`
    /// when it is not armed (or was lifted by `commit()`).
    static CUT_GRACE: Cell<Option<u64>> = const { Cell::new(None) };
    /// The daemon worker's progress beat (its watchdog slot and the daemon's start), set once per worker thread.
    static BEAT: RefCell<Option<(Arc<AtomicU64>, Instant)>> = const { RefCell::new(None) };
    /// The connection of the request being served when its client keeps it open until it has the verdict (an ack-mode client).
    static PEER: Cell<Option<std::os::fd::RawFd>> = const { Cell::new(None) };
    /// When the check running on this thread must end ([`cap_check`]): its budget, earlier than the request's hard deadline.
    static CHECK_CAP: Cell<Option<Instant>> = const { Cell::new(None) };
    /// Whether the running check was cut at its cap ([`note_cap_cut`]).
    static CAP_CUT: Cell<bool> = const { Cell::new(false) };
    /// Checks skipped on this thread because their client had gone, since [`take_client_gone_skips`].
    static GONE_SKIPS: Cell<u64> = const { Cell::new(0) };
}

/// The client of the request on this thread keeps `fd` open until it has the verdict (an ack-mode client): from now on an
/// end-of-stream on it means the client gave up, and [`client_gone`] says so. Cleared by [`end`].
pub fn watch_peer(fd: std::os::fd::RawFd) {
    PEER.with(|p| p.set(Some(fd)));
}

/// True when the request's client has closed its connection, so nothing that is computed from here on can be read
/// (`daemon.skip_when_client_gone`; false for a client that does not keep its connection open, and outside a request).
pub fn client_gone() -> bool {
    let Some(fd) = PEER.with(|p| p.get()) else { return false };
    if crate::defaults::raw("daemon.skip_when_client_gone").as_bool() != Some(true) {
        return false;
    }
    let mut byte = 0u8;
    // SAFETY: `recv` reads at most one byte into `byte`, a live local, from a descriptor the serving thread owns for the whole
    // request ([`watch_peer`] is cleared by [`end`] before the connection is dropped); MSG_PEEK leaves the stream untouched.
    let n = unsafe { libc::recv(fd, (&mut byte as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) };
    let gone = n == 0 || (n < 0 && matches!(std::io::Error::last_os_error().kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe));
    if gone {
        GONE_SKIPS.with(|c| c.set(c.get() + 1));
    }
    gone
}

/// True when the peer has closed the whole connection, so nobody can read a reply (`daemon.skip_when_client_gone`). A peer that
/// only shut down its write side, as the legacy client does right after sending its request, is still waiting for the reply and
/// is not hung up: `recv` returning 0 cannot tell the two apart, and on macOS neither can `poll`'s POLLHUP.
pub fn hung_up(fd: std::os::fd::RawFd) -> bool {
    if crate::defaults::raw("daemon.skip_when_client_gone").as_bool() != Some(true) {
        return false;
    }
    // SAFETY: a zero-length `send` reads no memory (the pointer is never dereferenced) and is non-blocking; it only reports
    // EPIPE when the peer has closed the connection (macOS, measured; Linux reports it too once the peer socket is released).
    let n = unsafe { libc::send(fd, std::ptr::NonNull::<u8>::dangling().as_ptr().cast(), 0, libc::MSG_DONTWAIT) };
    if n < 0 && matches!(std::io::Error::last_os_error().kind(), std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset) {
        return true;
    }
    // Linux sets POLLHUP only when both directions are down (a write-side shutdown alone is POLLRDHUP), so it is exact there.
    #[cfg(target_os = "linux")]
    {
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        // SAFETY: `pfd` is a live, writable `pollfd`, the count is 1 and the timeout 0 (a non-blocking readiness query).
        let r = unsafe { libc::poll(&mut pfd, 1, 0) };
        return r > 0 && pfd.revents & libc::POLLHUP != 0;
    }
    #[allow(unreachable_code)]
    false
}

/// How many checks were skipped on this thread because their client had gone, since the last call.
pub fn take_client_gone_skips() -> u64 {
    GONE_SKIPS.with(|c| c.replace(0))
}

/// Make `slot` (milliseconds since `base`, plus 1; 0 = idle) this thread's progress beat: the daemon watchdog reads it.
pub fn set_beat(slot: Arc<AtomicU64>, base: Instant) {
    BEAT.with(|b| *b.borrow_mut() = Some((slot, base)));
}

/// Forward progress on the request this thread serves (a check started or finished, the interpreter ran): the watchdog's
/// stuck rule (`daemon.stuck_ms`) measures the time since the last beat, so a worker a loaded machine merely slows down is
/// never taken for a hung one. Nothing outside a daemon request (an idle slot stays 0).
pub fn beat() {
    BEAT.with(|b| {
        if let Some((slot, base)) = b.borrow().as_ref()
            && slot.load(Ordering::Relaxed) != 0
        {
            slot.store(base.elapsed().as_millis() as u64 + 1, Ordering::Relaxed);
        }
    });
}

/// Progress that is already paid for: the worker is inside a call that ends by itself within `dur` (a git run with its timeout, a
/// model call with its budget), so the watchdog and a waiting client count it as making progress until then. A later [`beat`]
/// replaces it with the real time. Nothing outside a daemon request.
pub fn beat_for(dur: Duration) {
    BEAT.with(|b| {
        if let Some((slot, base)) = b.borrow().as_ref()
            && slot.load(Ordering::Relaxed) != 0
        {
            slot.store((base.elapsed() + dur).as_millis() as u64 + 1, Ordering::Relaxed);
        }
    });
}

/// Arm the cut of the script call in progress at the request's client deadline plus `grace` ms (the check's
/// `diagnostics.deadline_grace_ms`), or disarm it (`None`).
pub fn set_cut_grace(grace: Option<u64>) {
    CUT_GRACE.with(|c| c.set(grace));
}

/// Arm (or disarm) the cut of the script call in progress at the request's client deadline.
pub fn set_cut_armed(on: bool) {
    set_cut_grace(on.then_some(0));
}

/// True when the script call in progress may be cut and its request's client has stopped waiting: a native scan the call is
/// running (a transcript window of many megabytes, which the interpreter cannot interrupt) stops early, and the call fails as
/// a cut (its check gets no answer and takes its failure policy).
/// A call armed with a grace ([`set_cut_grace`], the check's `diagnostics.deadline_grace_ms`) is cut only once the request is that far
/// past its hard deadline, the same moment the interpreter's own request limit trips. A check running under a cap ([`cap_check`]) is
/// also cut when its cap passes (the grace never extends a cap: it is time the checks after it keep).
pub fn cut_due() -> bool {
    CUT_GRACE.with(Cell::get).is_some_and(|grace| cut_point(grace).is_some_and(|at| Instant::now() >= at))
}

/// When a call armed with `grace_ms` is cut: the request's hard deadline plus the grace, or the running check's cap when that comes
/// first; `None` outside a request.
pub fn cut_point(grace_ms: u64) -> Option<Instant> {
    let hard = REQ.with(|r| r.get()).and_then(|r| r.hard)? + Duration::from_millis(grace_ms);
    Some(CHECK_CAP.with(Cell::get).map_or(hard, |cap| cap.min(hard)))
}

/// When the client of the request this thread serves stops waiting (after the reply slack); `None` outside a request.
pub fn at() -> Option<Instant> {
    REQ.with(|r| r.get()).and_then(|r| r.hard)
}

/// The cap of the running check: lifted, and its cut state cleared, when dropped.
pub struct CheckWindow(());

impl CheckWindow {
    /// Whether the check was cut at its cap: its call was interrupted (or its scan stopped) because the cap passed before the request's
    /// own hard deadline did ([`note_cap_cut`]).
    pub fn cut(&self) -> bool {
        CAP_CUT.with(Cell::get)
    }
}

impl Drop for CheckWindow {
    fn drop(&mut self) {
        CHECK_CAP.with(|c| c.set(None));
        CAP_CUT.with(|c| c.set(false));
    }
}

/// The check about to run on this thread must end `budget` from now (#763): the dispatcher gives it what the request has left less
/// the time the checks after it are reserved, so ONE slow check cannot use up the clock the guards behind it need. Past the cap the
/// check is cut exactly as at the hard deadline (a script call is interrupted, a native scan stops at [`cut_due`], a host call is
/// clamped by [`remaining`]). Set only for a check that may be cut at the deadline (`script::cut_at_deadline`): a check that fails
/// closed on a guard event, or whose deadline policy is `finish`, gets no cap, so none of its host calls are clamped by one.
pub fn cap_check(budget: Duration) -> CheckWindow {
    if in_request() {
        CHECK_CAP.with(|c| c.set(Some(Instant::now() + budget)));
    }
    CAP_CUT.with(|c| c.set(false));
    CheckWindow(())
}

/// Whether the running check's cap, not the request's hard deadline, is what has passed: a cut now is a cut at the cap.
pub fn cap_passed() -> bool {
    let hard = at();
    CHECK_CAP.with(Cell::get).zip(hard).is_some_and(|(cap, hard)| cap < hard && Instant::now() >= cap)
}

/// The running check was cut at its cap ([`CheckWindow::cut`]).
pub fn note_cap_cut() {
    CAP_CUT.with(|c| c.set(true));
}

/// Time left before the client's fail-fast wait (the soft deadline) ends; `None` outside a request.
pub fn soft_remaining() -> Option<Duration> {
    REQ.with(|r| r.get()).and_then(|r| r.soft).map(|at| at.saturating_duration_since(Instant::now()))
}

/// True once, the first time it is called after the soft deadline has passed in this request: the caller logs and counts the
/// overrun (the request keeps running). False outside a request, before the deadline, and on every later call.
pub fn note_soft_overrun() -> bool {
    let Some(req) = REQ.with(|r| r.get()) else { return false };
    if soft_remaining() != Some(Duration::ZERO) || req.noted {
        return false;
    }
    REQ.with(|r| r.set(Some(Req { noted: true, ..req })));
    true
}

/// Milliseconds since the current request arrived; `None` outside a request.
pub fn elapsed_ms() -> Option<u64> {
    REQ.with(|r| r.get()).map(|req| req.arrived.elapsed().as_millis() as u64)
}

/// How many writes the current request has staged so far: [`discard_staged_since`] drops the ones staged after this mark.
pub fn staged_mark() -> usize {
    STAGED.with(|s| s.borrow().len())
}

/// Drop the writes staged after `mark` (a check that gave no answer must not leave a stamp for a decision it never
/// made: its failure policy answers instead and a later call would find the stamp).
pub fn discard_staged_since(mark: usize) {
    let tail: Vec<Staged> = STAGED.with(|s| {
        let mut s = s.borrow_mut();
        let at = mark.min(s.len());
        s.split_off(at)
    });
    for (tmp, _, _) in tail {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup that raced; an absent file is the goal state
    }
}

/// A request that arrived at `arrived` starts on this thread; its deadline is the defaults' client deadline until the
/// request names its own ([`client_deadline`]).
pub fn begin(arrived: Instant) {
    discard_staged(); // nothing a previous request left can belong to this one
    EVENT.with(|e| *e.borrow_mut() = None);
    REQ.with(|r| r.set(Some(Req { arrived, soft: None, hard: None, noted: false, cut: false })));
    client_window(crate::defaults::num("client.deadline_ms"));
}

/// The client said it waits `ms` milliseconds from sending the request, and the request is cut there too (soft = hard).
pub fn client_deadline(ms: u64) {
    set_window(ms, ms, true);
}

/// The wall ceiling of a request for `event` (`daemon.request_hard_ms`, or its `daemon.request_hard_event_ms` row), in ms; an
/// empty event gets the plain ceiling.
pub fn ceiling_ms(event: &str) -> u64 {
    let base = crate::defaults::raw("daemon.request_hard_event_ms")
        .get(event)
        .and_then(crate::defaults::V::as_integer)
        .map_or_else(|| crate::defaults::num("daemon.request_hard_ms"), |v| v.max(0) as u64);
    crate::loadscale::scale(base, load_factor(event))
}

/// #969: the factor (permille, 1000 = unchanged) `event`'s hard ceiling is stretched by: the one the client passed down in the
/// request ([`set_load_factor`]), for an event in `daemon.load_scale_events` only. The daemon never samples the load itself, so its
/// cut and the client's wait always use the same factor.
pub fn load_factor(event: &str) -> u64 {
    if event.is_empty() || !crate::defaults::list("daemon.load_scale_events").contains(&event) {
        return 1000;
    }
    crate::loadscale::passed_permille(LOAD.with(Cell::get), crate::defaults::num("daemon.load_scale_max_permille"))
}

/// #969: the load factor the request carries (`Meta::load_permille`, fitted once by the outermost process), clamped to
/// [1000, `daemon.load_scale_max_permille`]; none = 1000. Reset when the request ends.
pub fn set_load_factor(v: Option<u64>) {
    LOAD.with(|c| c.set(v));
}

/// #969 review: a factor a request carries, fitted again to `event`'s outer bound on `host` the way the ah-hook launcher fits it:
/// min(the event's hook timeout, `client.wrapper_default_timeout_s`) less `client.cold_guard_wait_ms`, both
/// `client.wrapper_kill_grace_ms` and `launcher.wall_hard_margin_ms`, for the event's late wait (`client.slow_fallback_max_ms` or its
/// row). A factor the launcher fitted stays as it is (the fit is idempotent); a request that skipped the launcher, or names a larger
/// factor than fits, can never stretch the ceiling past the configured bound. Empty `host` = the wrapper cap alone.
pub fn fit_passed(v: Option<u64>, host: &str, event: &str) -> Option<u64> {
    let f = v.filter(|f| *f > 1000)?;
    let num = crate::defaults::num;
    let cap = num("client.wrapper_default_timeout_s").saturating_mul(1000);
    let outer = if host.is_empty() { cap } else { crate::hooksgen::event_timeout(host, event).saturating_mul(1000).min(cap) };
    let plan = num("client.cold_guard_wait_ms")
        .saturating_add(num("client.wrapper_kill_grace_ms").saturating_mul(2))
        .saturating_add(num("launcher.wall_hard_margin_ms"));
    let slow_base = crate::defaults::num_for_event("client.slow_fallback_max_ms", "client.slow_fallback_event_ms", event);
    Some(crate::loadscale::fit_permille(f, slow_base, outer.saturating_sub(plan), num("daemon.load_scale_step_permille")))
}

/// #969: the load factor of the hook client's own call: the one the ah-hook launcher fitted and passed in `daemon.load_scale_env`
/// (clamped like a request's), for an event in `daemon.load_scale_events`; none (no launcher, or a launcher that found no room) =
/// 1000. The client never samples the load itself.
pub fn client_load_factor(event: &str) -> u64 {
    if event.is_empty() || !crate::defaults::list("daemon.load_scale_events").contains(&event) {
        return 1000;
    }
    let name = crate::defaults::text("daemon.load_scale_env");
    let v = Some(name).filter(|n| !n.is_empty()).and_then(|n| std::env::var(n).ok()).and_then(|v| v.trim().parse::<u64>().ok());
    let f = crate::loadscale::passed_permille(v, crate::defaults::num("daemon.load_scale_max_permille"));
    // #969 review: within the wrapper cap, as the daemon fits a request's (idempotent for a factor the launcher fitted)
    fit_passed(Some(f), "", event).unwrap_or(f)
}

/// The client's fail-fast wait is `soft_ms` (a warning past it); the request is cut at the event's wall ceiling
/// ([`ceiling_ms`]). #969 review: the caller's value only ever lowers the soft mark, never raises the ceiling: a request that
/// names a long deadline is still cut at the configured per-event bound.
pub fn client_window(soft_ms: u64) {
    let event = event().unwrap_or_default();
    let hard = ceiling_ms(&event);
    set_window(soft_ms.min(hard), hard, false);
}

fn set_window(soft_ms: u64, hard_ms: u64, cut: bool) {
    REQ.with(|r| {
        if let Some(req) = r.get() {
            let slack = crate::defaults::millis("daemon.reply_slack_ms");
            let at = |ms: u64| req.arrived + Duration::from_millis(ms).saturating_sub(slack);
            r.set(Some(Req { soft: Some(at(soft_ms)), hard: Some(at(hard_ms)), cut, ..req }));
        }
    });
}

/// The request is answered: no deadline on this thread any more. A staged write not committed by now is dropped.
pub fn end() {
    discard_staged();
    LOAD.with(|c| c.set(None));
    EVENT.with(|e| *e.borrow_mut() = None);
    REQ.with(|r| r.set(None));
    CHECK_CAP.with(|c| c.set(None));
    CAP_CUT.with(|c| c.set(false));
    PEER.with(|p| p.set(None));
}

/// The request being served on this thread is a dispatch of hook event `event`.
pub fn set_event(event: &str) {
    EVENT.with(|e| *e.borrow_mut() = Some(event.to_string()));
    if load_factor(event) > 1000 {
        crate::metrics::bump("deadline_load_scaled", &[("event", event)]);
    }
    // the window was set before the event was known: its ceiling is the event's own now (a request cut at its soft wait stays so)
    REQ.with(|r| {
        if let Some(req) = r.get()
            && let (Some(soft), Some(_)) = (req.soft, req.hard)
            && !req.cut
        {
            let at = req.arrived + Duration::from_millis(ceiling_ms(event)).saturating_sub(crate::defaults::millis("daemon.reply_slack_ms"));
            // #969 review: the event's ceiling holds even below the soft mark the caller named (it never raises the ceiling)
            r.set(Some(Req { soft: Some(soft.min(at)), hard: Some(at), ..req }));
        }
    });
}

/// The hook event of the request being served, when the dispatch named it.
pub fn event() -> Option<String> {
    EVENT.with(|e| e.borrow().clone().filter(|s| !s.is_empty()))
}

/// Whether a request is being served on this thread (state writes are then staged until its reply is delivered).
pub fn in_request() -> bool {
    REQ.with(|r| r.get().is_some())
}

/// Whether the client still waits: no request, or a deadline not yet reached (the request's own deadline, not a running check's cap).
pub fn in_time() -> bool {
    at().is_none_or(|at| Instant::now() < at)
}

/// How many milliseconds past the HARD deadline the request is (0 before it, and outside a request).
pub fn past_hard_ms() -> u64 {
    at().map_or(0, |at| Instant::now().saturating_duration_since(at).as_millis() as u64)
}

/// Hold a staged write (`tmp` already written) until the reply is delivered.
pub fn stage(tmp: PathBuf, path: PathBuf, style: crate::atomic::Style) {
    STAGED.with(|s| s.borrow_mut().push((tmp, path, style)));
}

/// The reply was written (`delivered`) or not: the staged state lands only when the client got it in time; a client past
/// its deadline answers with the Node hooks, which must not find a stamp for this decision (review P1-2).
pub fn settle_staged(delivered: bool) {
    if delivered && in_time() { commit_staged() } else { discard_staged() }
}

/// The reply reached the client in time: rename every staged write into place, in the order it was made.
pub fn commit_staged() {
    for (tmp, path, style) in STAGED.with(|s| std::mem::take(&mut *s.borrow_mut())) {
        crate::discard::logged("staged_state_commit", crate::atomic::replace(&tmp, &path, style));
    }
}

/// The reply was not used by the client: drop every staged write, leaving the targets as they were.
pub fn discard_staged() {
    for (tmp, _, _) in STAGED.with(|s| std::mem::take(&mut *s.borrow_mut())) {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup that raced; an absent file is the goal state
    }
}

/// Time left before the client stops waiting, if a request with a deadline is being served on this thread; while a check runs under a
/// cap ([`cap_check`]), the time left before that cap when it comes first (a host call of the check is clamped to it).
pub fn remaining() -> Option<Duration> {
    let end = at().map(|hard| CHECK_CAP.with(Cell::get).map_or(hard, |cap| cap.min(hard)));
    end.map(|at| at.saturating_duration_since(Instant::now()))
}

/// `budget`, cut to the time left before the client stops waiting.
pub fn clamp(budget: Duration) -> Duration {
    remaining().map_or(budget, |left| budget.min(left))
}

/// `budget` for ONE host call (a git run, a spawned program) of a check: cut to the time left ([`clamp`]) and to the call's share of
/// the request's ceiling (`daemon.host_call_share_pct` of [`ceiling_ms`] for the event), so a slow call cannot drain the clock the
/// checks after it need. Outside a request, or with the share off (0), only the request clock cuts.
pub fn share(budget: Duration) -> Duration {
    let budget = clamp(budget);
    let pct = crate::defaults::num("daemon.host_call_share_pct");
    if !in_request() || pct == 0 {
        return budget;
    }
    let ceiling = Duration::from_millis(ceiling_ms(&event().unwrap_or_default()));
    budget.min(ceiling.mul_f64(pct as f64 / 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #969: a load at or under one per core moves no deadline; above it a guard event's ceiling scales (clamped to the max), any
    /// other event's does not; the daemon uses only the factor the request carries; at the max factor, as the launcher fits it, a cold
    /// call of every scaled event (Stop under the 10 s wrapper cap, PermissionRequest under its 10 s hook timeout) stays inside its
    /// outer bound and keeps hard + grace within the client's late wait.
    #[test]
    fn load_scales_guard_ceilings_within_the_invariant_and_the_hook_timeout() {
        let base = |ev: &str| {
            crate::defaults::raw("daemon.request_hard_event_ms")
                .get(ev)
                .and_then(crate::defaults::V::as_integer)
                .map_or_else(|| crate::defaults::num("daemon.request_hard_ms"), |v| v as u64)
        };
        let max = crate::defaults::num("daemon.load_scale_max_permille");
        assert!(max > 1000, "shipped on");
        for f in [None, Some(0), Some(1000)] {
            set_load_factor(f);
            assert_eq!(ceiling_ms("PreToolUse"), base("PreToolUse"), "{f:?}: no factor passed, no change");
            assert_eq!(load_factor("Stop"), 1000);
        }
        // the daemon uses only the factor the request carries: a loaded machine with no factor passed changes nothing
        crate::loadscale::set_test_load(Some(50.0));
        set_load_factor(None);
        assert_eq!(ceiling_ms("PreToolUse"), base("PreToolUse"), "the daemon never samples the load itself");
        set_load_factor(Some(50_000));
        assert_eq!(load_factor("PreToolUse"), max, "a passed factor is clamped to the max");
        assert_eq!(ceiling_ms("PreToolUse"), crate::loadscale::scale(base("PreToolUse"), max));
        assert_eq!(ceiling_ms("Stop"), crate::loadscale::scale(base("Stop"), max));
        assert_eq!(ceiling_ms("SessionEnd"), base("SessionEnd"), "an event not listed keeps its ceiling");
        assert_eq!(load_factor(""), 1000);
        let hooks: serde_json::Value =
            serde_json::from_str(include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../plugins/anti-hall/hooks/hooks.json"))).unwrap();
        let num = crate::defaults::num;
        let (grace, margin) = (num("diagnostics.deadline_grace_cap_ms"), num("client.slow_wait_margin_ms"));
        // what the ah-hook launcher fits the factor into: the event's outer bound, min(hooks.json timeout, the wrapper cap), less the
        // cold-start wait, both kill graces and the wall margin (launcher.rs, the wall-clock backstop)
        let (cap_ms, cold, kill, wall) =
            (num("client.wrapper_default_timeout_s") * 1000, num("client.cold_guard_wait_ms"), num("client.wrapper_kill_grace_ms"), num("launcher.wall_hard_margin_ms"));
        for ev in crate::defaults::list("daemon.load_scale_events") {
            let slow_base = crate::defaults::num_for_event("client.slow_fallback_max_ms", "client.slow_fallback_event_ms", ev);
            let timeout_ms = hooks["hooks"][ev]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|g| g["hooks"].as_array().into_iter().flatten())
                .filter_map(|h| h["timeout"].as_u64())
                .min()
                .map_or(cap_ms, |s| (s * 1000).min(cap_ms));
            let avail = timeout_ms.saturating_sub(cold + 2 * kill + wall);
            let f = crate::loadscale::fit_permille(max, slow_base, avail, num("daemon.load_scale_step_permille"));
            let slow = crate::loadscale::scale(slow_base, f);
            // a factor above 1000 is only ever chosen when the whole cold plan fits; with no room the plan stays the unscaled one
            let plan = cold + slow + 2 * kill + wall;
            assert!(f == 1000 || plan <= timeout_ms, "{ev}: a cold call at the max factor ({f}) plans {plan} ms of {timeout_ms}");
            match ev {
                "PermissionRequest" | "PreToolUse" => assert!(f > 1000 && plan <= timeout_ms, "{ev}: scales and fits ({f}, {plan} of {timeout_ms})"),
                "Stop" => assert_eq!(f, 1000, "Stop's 9000 ms late wait has no room under the 10 s wrapper cap"),
                _ => {}
            }
            set_load_factor(Some(f));
            assert!(ceiling_ms(ev) + grace <= slow.saturating_sub(margin), "{ev}: hard {} + grace {grace} within {slow} - {margin}", ceiling_ms(ev));
        }
        crate::loadscale::set_test_load(None);
        end();
        assert_eq!(load_factor("PreToolUse"), 1000, "the factor ends with the request");
    }

    /// The two copies of the load-scale module (the engine's and the launcher's) are one file.
    #[test]
    fn the_launcher_carries_the_same_loadscale_module() {
        assert_eq!(include_str!("loadscale.rs"), include_str!("../../ah-launcher/src/loadscale.rs"));
    }

    /// live20.1: `deadline_soft` named the next check to start (ship-it-guard, 0.7 ms mean) for time earlier checks spent. The line now
    /// names the check that was running when the wait ended, with how long it ran and how old the request was.
    #[test]
    fn the_soft_deadline_lines_say_who_ran_and_for_how_long() {
        let ran = crate::defaults::render(
            "msg.log_deadline_soft",
            &[("check", &"git-guard"), ("event", &"PreToolUse"), ("elapsed_ms", &312u64), ("ran_ms", &290u128)],
        );
        assert!(ran.contains("git-guard") && ran.contains("ran 290 ms") && ran.contains("312 ms"), "{ran}");
        let queued = crate::defaults::render("msg.log_deadline_soft_queued", &[("check", &"git-guard"), ("event", &"PreToolUse"), ("elapsed_ms", &312u64)]);
        assert!(queued.contains("before the first check started") && queued.contains("312 ms"), "{queued}");
        assert!(!ran.contains('{') && !queued.contains('{'), "unfilled placeholder: {ran} / {queued}");
        assert_eq!(elapsed_ms(), None, "no request on this thread");
    }

    /// Start a request now, with the defaults already loaded: the first read of a setting parses the shipped file (hundreds of
    /// milliseconds in a debug build), which would otherwise be spent inside the request window. The window is the fail-fast
    /// client deadline (300 ms), not the former 2 s, so the cost of loading must not count against it.
    fn begin_now() {
        crate::defaults::num("client.deadline_ms");
        crate::defaults::millis("daemon.reply_slack_ms");
        begin(Instant::now());
    }

    #[test]
    fn a_budget_is_cut_to_what_the_client_still_waits_and_untouched_outside_a_request() {
        let long = Duration::from_secs(60);
        assert_eq!(clamp(long), long, "no request: nothing is clamped");
        begin_now();
        let left = remaining().unwrap();
        let hard = Duration::from_millis(crate::defaults::num("daemon.request_hard_ms"));
        assert!(left <= hard && clamp(long) <= hard, "{left:?}");
        assert!(soft_remaining().unwrap() <= Duration::from_millis(crate::defaults::num("client.deadline_ms")));
        client_deadline(0);
        assert_eq!(clamp(long), Duration::ZERO, "a client that no longer waits leaves no budget");
        end();
        assert_eq!(clamp(long), long);
    }

    /// #684 review of #690: the long wall ceiling belongs to Stop and SubagentStop only. The daemon names the event after the window is
    /// set, so naming it moves the ceiling; a request the client cut at its own wait (hard = soft) stays cut there.
    #[test]
    fn the_wall_ceiling_is_per_event_and_naming_the_event_moves_it() {
        let ms = |d: Option<Duration>| d.unwrap().as_millis() as u64;
        let (short, long) = (crate::defaults::num("daemon.request_hard_ms"), ceiling_ms("Stop"));
        assert!(
            long > short
                && ceiling_ms("SubagentStop") == long
                && ceiling_ms("PreToolUse") == short
                && ceiling_ms("SessionEnd") == short
                && ceiling_ms("") == short
        );
        begin_now();
        assert!(ms(remaining()) <= short, "event not named yet: the plain ceiling");
        set_event("Stop");
        assert!(ms(remaining()) > short + 1000 && ms(remaining()) <= long, "Stop: the long ceiling");
        end();
        begin_now();
        set_event("PreToolUse");
        assert!(ms(remaining()) <= short, "a tool call keeps the short ceiling");
        end();
        begin_now();
        client_deadline(250);
        set_event("Stop");
        assert!(ms(remaining()) <= 250, "a request the client cut at its own wait is not extended by its event");
        end();
    }

    /// #969 review: the caller's deadline only ever lowers the soft mark, never raises the ceiling past the configured per-event bound,
    /// and a factor a request carries is fitted to the event's outer bound again (a direct request can not skip the launcher's fit).
    #[test]
    fn a_callers_deadline_and_factor_never_raise_the_configured_ceiling() {
        let ms = |d: Option<Duration>| d.unwrap().as_millis() as u64;
        let num = crate::defaults::num;
        let (short, long) = (num("daemon.request_hard_ms"), ceiling_ms("Stop"));
        // a request that names a deadline far past every ceiling is still cut at the event's bound
        begin_now();
        client_window(short * 20);
        assert!(ms(remaining()) <= short, "the plain ceiling, not the caller's {}", short * 20);
        set_event("Stop");
        assert!(ms(remaining()) <= long && ms(remaining()) > short, "Stop: its own ceiling, never the caller's");
        end();
        // true negative: the normal fail-fast deadline keeps the soft mark and the event's whole ceiling
        begin_now();
        client_window(num("client.deadline_ms"));
        set_event("Stop");
        assert!(ms(remaining()) > short && ms(remaining()) <= long);
        end();
        // the factor: Stop's late wait has no room under the wrapper cap, so a direct request's max factor is fitted to none
        let max = num("daemon.load_scale_max_permille");
        crate::loadscale::set_test_load(None);
        assert_eq!(fit_passed(Some(max), "claude", "Stop"), Some(1000), "a direct Stop request can not stretch the ceiling");
        set_load_factor(fit_passed(Some(max), "claude", "Stop"));
        assert_eq!(ceiling_ms("Stop"), long, "the configured Stop ceiling holds");
        // true negative: a factor the launcher fitted for PreToolUse is kept as it is (the fit is idempotent)
        let cap = num("client.wrapper_default_timeout_s") * 1000;
        let avail = (crate::hooksgen::event_timeout("claude", "PreToolUse") * 1000).min(cap)
            - num("client.cold_guard_wait_ms")
            - 2 * num("client.wrapper_kill_grace_ms")
            - num("launcher.wall_hard_margin_ms");
        let base = crate::defaults::num_for_event("client.slow_fallback_max_ms", "client.slow_fallback_event_ms", "PreToolUse");
        let fitted = crate::loadscale::fit_permille(max, base, avail, num("daemon.load_scale_step_permille"));
        assert!(fitted > 1000, "PreToolUse scales under the shipped numbers ({fitted})");
        assert_eq!(fit_passed(Some(fitted), "claude", "PreToolUse"), Some(fitted));
        assert_eq!(fit_passed(Some(fitted), "", "PreToolUse"), Some(fitted), "the wrapper cap alone");
        assert_eq!(fit_passed(None, "claude", "PreToolUse"), None);
        assert_eq!(fit_passed(Some(1000), "claude", "PreToolUse"), None, "none to fit");
        set_load_factor(None);
    }

    /// #684 review of #690: one host call gets a share of the ceiling, never the rest of the request clock.
    #[test]
    fn one_host_call_gets_a_share_of_the_ceiling_not_the_rest_of_the_clock() {
        let ms = |d: Duration| d.as_millis() as u64;
        let long = Duration::from_secs(60);
        assert_eq!(share(long), long, "outside a request nothing is cut");
        let pct = crate::defaults::num("daemon.host_call_share_pct");
        assert!(pct > 0 && pct < 100, "the shipped share is on");
        begin_now();
        set_event("Stop");
        let stop = ms(share(long));
        assert!(stop <= ceiling_ms("Stop") * pct / 100 && stop > ceiling_ms("Stop") * pct / 100 - 1000, "{stop}");
        assert_eq!(ms(share(Duration::from_millis(100))), 100, "a call that asks for less keeps its own timeout");
        end();
        begin_now();
        set_event("PreToolUse");
        assert!(ms(share(long)) <= ceiling_ms("PreToolUse") * pct / 100);
        end();
    }

    #[test]
    fn past_the_soft_deadline_the_request_is_only_noted_once_and_cut_at_the_hard_one() {
        assert!(!note_soft_overrun(), "no request");
        begin_now();
        assert!(!note_soft_overrun(), "inside the soft deadline");
        // soft passed, hard far away: the request goes on
        set_window(0, 60_000, false);
        assert_eq!(soft_remaining(), Some(Duration::ZERO));
        assert!(in_time(), "past the soft deadline the client still waits");
        assert!(note_soft_overrun(), "reported the first time");
        assert!(!note_soft_overrun(), "and only once per request");
        set_window(0, 0, true);
        assert!(!in_time(), "past the hard deadline it is cut");
        end();
    }

    #[test]
    fn the_progress_beat_moves_a_busy_slot_and_leaves_an_idle_one_alone() {
        let slot = Arc::new(AtomicU64::new(0));
        let base = Instant::now() - Duration::from_secs(5);
        set_beat(slot.clone(), base);
        beat();
        assert_eq!(slot.load(Ordering::Relaxed), 0, "an idle worker stays idle");
        slot.store(1, Ordering::Relaxed); // picked a request up at the daemon's start
        beat();
        assert!(slot.load(Ordering::Relaxed) > 5000, "the beat records the progress time: {}", slot.load(Ordering::Relaxed));
        BEAT.with(|b| *b.borrow_mut() = None);
    }

    /// #763: a check's cap ends its calls and scans before the request's deadline, its grace never extends the cap, the request's own
    /// clock is untouched, and dropping the window lifts the cap.
    #[test]
    fn a_check_cap_cuts_before_the_request_deadline_and_is_lifted_after() {
        begin_now();
        set_window(60_000, 60_000, true);
        let w = cap_check(Duration::ZERO);
        assert!(remaining().is_some_and(|r| r == Duration::ZERO), "a host call is clamped to the cap");
        assert!(in_time(), "the request's client still waits");
        set_cut_grace(Some(400));
        assert!(cut_due(), "the grace past the request deadline does not extend a cap");
        assert!(cap_passed(), "it is the cap that passed, not the request deadline");
        assert!(!w.cut(), "nothing was cut yet");
        note_cap_cut();
        assert!(w.cut());
        drop(w);
        assert!(!cut_due(), "the cap is lifted with its window");
        assert!(remaining().is_some_and(|r| r > Duration::from_secs(50)), "the request's own clock is back");
        set_cut_grace(None);
        end();
        let w = cap_check(Duration::ZERO);
        assert!(remaining().is_none() && !cap_passed() && !w.cut(), "outside a request nothing is capped");
    }

    /// Codex P2 (#463): the deadline grace of a check reaches the native scans its script runs, not only the interpreter.
    #[test]
    fn a_native_scan_keeps_the_deadline_grace_of_its_check() {
        begin_now();
        set_cut_grace(Some(400));
        client_deadline(0);
        assert!(!cut_due(), "inside the check's grace a native scan is not cut");
        end();
        begin(Instant::now() - std::time::Duration::from_secs(60));
        set_cut_grace(Some(400));
        client_deadline(0);
        assert!(cut_due(), "past the grace it is");
        set_cut_grace(None);
        assert!(!cut_due(), "a disarmed call is never cut");
        end();
    }

    #[test]
    fn a_native_scan_is_cut_only_inside_an_armed_call_past_its_deadline() {
        assert!(!cut_due(), "no request");
        begin_now();
        set_cut_armed(true);
        assert!(!cut_due(), "the client still waits");
        client_deadline(0);
        assert!(cut_due(), "armed and past the deadline");
        set_cut_armed(false); // commit() or the end of the call
        assert!(!cut_due(), "a lifted call is never cut");
        end();
    }

    #[test]
    fn a_deferred_checks_staged_writes_are_dropped_and_the_others_kept() {
        let dir = crate::testtmp::path(format!("ah-stage-since-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.json"), dir.join("b.json"));
        let style = crate::atomic::Style::default();
        begin_now();
        crate::atomic::write_after_reply(&a, "a", style).unwrap();
        let mark = staged_mark();
        crate::atomic::write_after_reply(&b, "b", style).unwrap();
        discard_staged_since(mark); // the second check gave no answer
        settle_staged(true);
        end();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "a", "the answered check's state lands");
        assert!(!b.exists(), "the deferred check left no stamp");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temporary file is left behind");
        crate::discard::harmless(std::fs::remove_dir_all(&dir));
    }

    #[test]
    fn state_written_during_a_request_lands_only_when_the_reply_is_delivered_in_time() {
        // review P1-2: a stamp written before a reply the client never used silenced the Node fallback that answered instead
        let dir = crate::testtmp::path(format!("ah-p1-2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("state.json");
        std::fs::write(&f, "old").unwrap();
        let style = crate::atomic::Style::default();
        begin_now();
        crate::atomic::write_after_reply(&f, "new", style).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "old", "staged, not yet in place");
        settle_staged(false); // the reply could not be written
        end();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "old", "an unwritten reply leaves the state as it was");
        begin_now();
        crate::atomic::write_after_reply(&f, "new", style).unwrap();
        client_deadline(0); // the client has stopped waiting: it answers with the Node hooks
        settle_staged(true);
        end();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "old", "a reply nobody used leaves the state as it was");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temporary file is left behind");
        begin_now();
        crate::atomic::write_after_reply(&f, "new", style).unwrap();
        settle_staged(true);
        end();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new", "a delivered reply commits its state");
        crate::atomic::write_after_reply(&f, "direct", style).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "direct", "outside a request the write is immediate");
        crate::discard::harmless(std::fs::remove_dir_all(&dir));
    }
}
