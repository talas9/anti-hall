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
}

thread_local! {
    /// When the current request arrived (accepted), and when its client stops waiting (after the slack).
    static REQ: Cell<Option<Req>> = const { Cell::new(None) };
    /// The hook event of the request being served (set by the dispatch, empty outside one).
    static EVENT: RefCell<Option<String>> = const { RefCell::new(None) };
    /// The state writes the current request staged, in order.
    static STAGED: RefCell<Vec<Staged>> = const { RefCell::new(Vec::new()) };
    /// Whether the script call in progress on this thread may be cut at the request's deadline (armed, not lifted by `commit()`).
    static CUT_ARMED: std::sync::atomic::AtomicBool = const { std::sync::atomic::AtomicBool::new(false) };
    /// The daemon worker's progress beat (its watchdog slot and the daemon's start), set once per worker thread.
    static BEAT: RefCell<Option<(Arc<AtomicU64>, Instant)>> = const { RefCell::new(None) };
    /// The connection of the request being served when its client keeps it open until it has the verdict (an ack-mode client).
    static PEER: Cell<Option<std::os::fd::RawFd>> = const { Cell::new(None) };
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

/// Arm (or disarm) the cut of the script call in progress at the request's client deadline.
pub fn set_cut_armed(on: bool) {
    CUT_ARMED.with(|c| c.store(on, Ordering::Relaxed));
}

/// True when the script call in progress may be cut and its request's client has stopped waiting: a native scan the call is
/// running (a transcript window of many megabytes, which the interpreter cannot interrupt) stops early, and the call fails as
/// a cut (its check gets no answer and takes its failure policy).
pub fn cut_due() -> bool {
    CUT_ARMED.with(|c| c.load(Ordering::Relaxed)) && !in_time()
}

/// When the client of the request this thread serves stops waiting (after the reply slack); `None` outside a request.
pub fn at() -> Option<Instant> {
    REQ.with(|r| r.get()).and_then(|r| r.hard)
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
    REQ.with(|r| r.set(Some(Req { arrived, soft: None, hard: None, noted: false })));
    client_window(crate::defaults::num("client.deadline_ms"));
}

/// The client said it waits `ms` milliseconds from sending the request, and the request is cut there too (soft = hard).
pub fn client_deadline(ms: u64) {
    set_window(ms, ms);
}

/// The client's fail-fast wait is `soft_ms` (a warning past it); the request is cut at `daemon.request_hard_ms`, or at `soft_ms`
/// when that is larger.
pub fn client_window(soft_ms: u64) {
    set_window(soft_ms, soft_ms.max(crate::defaults::num("daemon.request_hard_ms")));
}

fn set_window(soft_ms: u64, hard_ms: u64) {
    REQ.with(|r| {
        if let Some(req) = r.get() {
            let slack = crate::defaults::millis("daemon.reply_slack_ms");
            let at = |ms: u64| req.arrived + Duration::from_millis(ms).saturating_sub(slack);
            r.set(Some(Req { soft: Some(at(soft_ms)), hard: Some(at(hard_ms)), ..req }));
        }
    });
}

/// The request is answered: no deadline on this thread any more. A staged write not committed by now is dropped.
pub fn end() {
    discard_staged();
    EVENT.with(|e| *e.borrow_mut() = None);
    REQ.with(|r| r.set(None));
    PEER.with(|p| p.set(None));
}

/// The request being served on this thread is a dispatch of hook event `event`.
pub fn set_event(event: &str) {
    EVENT.with(|e| *e.borrow_mut() = Some(event.to_string()));
}

/// The hook event of the request being served, when the dispatch named it.
pub fn event() -> Option<String> {
    EVENT.with(|e| e.borrow().clone().filter(|s| !s.is_empty()))
}

/// Whether a request is being served on this thread (state writes are then staged until its reply is delivered).
pub fn in_request() -> bool {
    REQ.with(|r| r.get().is_some())
}

/// Whether the client still waits: no request, or a deadline not yet reached.
pub fn in_time() -> bool {
    remaining() != Some(Duration::ZERO)
}

/// How many milliseconds past the HARD deadline the request is (0 before it, and outside a request).
pub fn past_hard_ms() -> u64 {
    REQ.with(|r| r.get()).and_then(|r| r.hard).map_or(0, |at| Instant::now().saturating_duration_since(at).as_millis() as u64)
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

/// Time left before the client stops waiting, if a request with a deadline is being served on this thread.
pub fn remaining() -> Option<Duration> {
    REQ.with(|r| r.get()).and_then(|r| r.hard).map(|at| at.saturating_duration_since(Instant::now()))
}

/// `budget`, cut to the time left before the client stops waiting.
pub fn clamp(budget: Duration) -> Duration {
    remaining().map_or(budget, |left| budget.min(left))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn past_the_soft_deadline_the_request_is_only_noted_once_and_cut_at_the_hard_one() {
        assert!(!note_soft_overrun(), "no request");
        begin_now();
        assert!(!note_soft_overrun(), "inside the soft deadline");
        // soft passed, hard far away: the request goes on
        set_window(0, 60_000);
        assert_eq!(soft_remaining(), Some(Duration::ZERO));
        assert!(in_time(), "past the soft deadline the client still waits");
        assert!(note_soft_overrun(), "reported the first time");
        assert!(!note_soft_overrun(), "and only once per request");
        set_window(0, 0);
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
        let dir = std::env::temp_dir().join(format!("ah-stage-since-{}", std::process::id()));
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
        let dir = std::env::temp_dir().join(format!("ah-p1-2-{}", std::process::id()));
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
