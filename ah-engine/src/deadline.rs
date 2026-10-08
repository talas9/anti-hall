//! The deadline of the request a daemon worker is serving (review finding 4).
//!
//! A client waits `client.deadline_ms` for its reply and then falls back to Node; a reply written after that is lost. The
//! worker therefore records, per request, when its client stops waiting (the moment the connection was accepted plus the
//! client's deadline, which a dispatch request carries and any other request takes from the defaults, minus
//! `daemon.reply_slack_ms` to write the reply), and the inner budgets that can outlast it (a git call, a Jev consult) are
//! clamped to what is left. Outside a request (a CLI command, a test) there is no deadline and nothing is clamped.
use std::cell::Cell;
use std::time::{Duration, Instant};

thread_local! {
    /// When the current request arrived (accepted), and when its client stops waiting (after the slack).
    static REQ: Cell<Option<(Instant, Option<Instant>)>> = const { Cell::new(None) };
}

/// A request that arrived at `arrived` starts on this thread; its deadline is the defaults' client deadline until the
/// request names its own ([`client_deadline`]).
pub fn begin(arrived: Instant) {
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

/// The request is answered: no deadline on this thread any more.
pub fn end() {
    REQ.with(|r| r.set(None));
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
}
