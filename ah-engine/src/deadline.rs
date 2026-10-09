//! The deadline of the request a daemon worker is serving (review finding 4).
//!
//! A client waits `client.deadline_ms` for its reply and then falls back to Node; a reply written after that is lost. The
//! worker therefore records, per request, when its client stops waiting (the moment the connection was accepted plus the
//! client's deadline, which a dispatch request carries and any other request takes from the defaults, minus
//! `daemon.reply_slack_ms` to write the reply), and the inner budgets that can outlast it (a git call, a Jev consult) are
//! clamped to what is left. Outside a request (a CLI command, a test) there is no deadline and nothing is clamped.
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

thread_local! {
    /// When the current request arrived (accepted), and when its client stops waiting (after the slack).
    static REQ: Cell<Option<(Instant, Option<Instant>)>> = const { Cell::new(None) };
    /// The state writes the current request staged, in order.
    static STAGED: RefCell<Vec<Staged>> = const { RefCell::new(Vec::new()) };
    /// Whether the script call in progress on this thread may be cut at the request's deadline (armed, not lifted by `commit()`).
    static CUT_ARMED: std::sync::atomic::AtomicBool = const { std::sync::atomic::AtomicBool::new(false) };
    /// The daemon worker's progress beat (its watchdog slot and the daemon's start), set once per worker thread.
    static BEAT: RefCell<Option<(Arc<AtomicU64>, Instant)>> = const { RefCell::new(None) };
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
/// a cut (its check defers to its Node hook).
pub fn cut_due() -> bool {
    CUT_ARMED.with(|c| c.load(Ordering::Relaxed)) && !in_time()
}

/// When the client of the request this thread serves stops waiting (after the reply slack); `None` outside a request.
pub fn at() -> Option<Instant> {
    REQ.with(|r| r.get()).and_then(|(_, at)| at)
}

/// How many writes the current request has staged so far: [`discard_staged_since`] drops the ones staged after this mark.
pub fn staged_mark() -> usize {
    STAGED.with(|s| s.borrow().len())
}

/// Drop the writes staged after `mark` (a check that deferred to its Node hook must not leave a stamp for a decision it never
/// made: the Node hook that answers instead would find it).
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
    REQ.with(|r| r.set(Some((arrived, None))));
    client_deadline(crate::defaults::num("client.deadline_ms"));
}

/// The client said it waits `ms` milliseconds from sending the request.
pub fn client_deadline(ms: u64) {
    REQ.with(|r| {
        if let Some((arrived, _)) = r.get() {
            let usable = Duration::from_millis(ms).saturating_sub(crate::defaults::millis("daemon.reply_slack_ms"));
            r.set(Some((arrived, Some(arrived + usable))));
        }
    });
}

/// The request is answered: no deadline on this thread any more. A staged write not committed by now is dropped.
pub fn end() {
    discard_staged();
    REQ.with(|r| r.set(None));
}

/// Whether a request is being served on this thread (state writes are then staged until its reply is delivered).
pub fn in_request() -> bool {
    REQ.with(|r| r.get().is_some())
}

/// Whether the client still waits: no request, or a deadline not yet reached.
pub fn in_time() -> bool {
    remaining() != Some(Duration::ZERO)
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
    REQ.with(|r| r.get()).and_then(|(_, at)| at).map(|at| at.saturating_duration_since(Instant::now()))
}

/// `budget`, cut to the time left before the client stops waiting.
pub fn clamp(budget: Duration) -> Duration {
    remaining().map_or(budget, |left| budget.min(left))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_budget_is_cut_to_what_the_client_still_waits_and_untouched_outside_a_request() {
        let long = Duration::from_secs(60);
        assert_eq!(clamp(long), long, "no request: nothing is clamped");
        begin(Instant::now());
        let left = remaining().unwrap();
        let client = Duration::from_millis(crate::defaults::num("client.deadline_ms"));
        assert!(left <= client && clamp(long) <= client, "{left:?}");
        client_deadline(0);
        assert_eq!(clamp(long), Duration::ZERO, "a client that no longer waits leaves no budget");
        end();
        assert_eq!(clamp(long), long);
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
        begin(Instant::now());
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
        begin(Instant::now());
        crate::atomic::write_after_reply(&a, "a", style).unwrap();
        let mark = staged_mark();
        crate::atomic::write_after_reply(&b, "b", style).unwrap();
        discard_staged_since(mark); // the second check deferred to its Node hook
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
        begin(Instant::now());
        crate::atomic::write_after_reply(&f, "new", style).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "old", "staged, not yet in place");
        settle_staged(false); // the reply could not be written
        end();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "old", "an unwritten reply leaves the state as it was");
        begin(Instant::now());
        crate::atomic::write_after_reply(&f, "new", style).unwrap();
        client_deadline(0); // the client has stopped waiting: it answers with the Node hooks
        settle_staged(true);
        end();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "old", "a reply nobody used leaves the state as it was");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temporary file is left behind");
        begin(Instant::now());
        crate::atomic::write_after_reply(&f, "new", style).unwrap();
        settle_staged(true);
        end();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "new", "a delivered reply commits its state");
        crate::atomic::write_after_reply(&f, "direct", style).unwrap();
        assert_eq!(std::fs::read_to_string(&f).unwrap(), "direct", "outside a request the write is immediate");
        crate::discard::harmless(std::fs::remove_dir_all(&dir));
    }
}
