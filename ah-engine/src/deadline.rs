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
use std::time::{Duration, Instant};

/// A staged state write: the written temporary file, its target, and how to rename it.
type Staged = (PathBuf, PathBuf, crate::atomic::Style);

thread_local! {
    /// When the current request arrived (accepted), and when its client stops waiting (after the slack).
    static REQ: Cell<Option<(Instant, Option<Instant>)>> = const { Cell::new(None) };
    /// The state writes the current request staged, in order.
    static STAGED: RefCell<Vec<Staged>> = const { RefCell::new(Vec::new()) };
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
