//! Orderly overload on the daemon's request path (#969, T-76).
//!
//! The daemon is thread-based (an accept loop, a Mutex/Condvar queue, a fixed set of worker threads; no async runtime), so the
//! tower 0.5 layers and tower-acc (whose controller is a tokio `Semaphore`) do not fit without rewriting the request path. This
//! module gives the same semantics natively:
//!
//! * classing (a priority buffer): the accept loop peeks a new connection's first bytes without consuming or waiting for them
//!   ([`classify`]) and gives it a class rank (`overload.classes`, highest first). Anything it cannot read is classed
//!   `overload.class_unknown` (guard), so a misread request is never treated as advice;
//! * a priority queue ([`Queue`]): a worker takes the oldest request of the highest-ranked class it may serve; a full queue makes
//!   room for a request by answering the NEWEST request of a strictly lower class BUSY (`load_shed`), and refuses only when nothing
//!   lower is queued;
//! * worker reservation and an adaptive concurrency limit ([`Aimd`], `concurrency_limit` + tower-acc's AIMD, after Netflix
//!   concurrency-limits): the limited classes (`overload.limited_classes`) may hold at most the adaptive limit of workers, at most
//!   `daemon.workers` minus `overload.reserved_workers`, so guard and control requests always find a worker. The limit shrinks
//!   multiplicatively when a request finishes slower than its target and grows additively when one finishes in time;
//! * shed mode (`timeout` + load shedding inside a request): a request served while the limit is backed off to its floor, or one
//!   that waited past its class bound, runs with its advisory checks skipped (`dispatch::native`); fail-closed checks, recorders and
//!   the keep list always run, and the hard deadline still gives every blocking check its failure mode.
//!
//! Every class, limit, target and label is in `defaults/overload.toml`.
use crate::defaults::{self, V};
use std::cell::Cell;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Whether classing, the limit and shed mode are on (`overload.enabled`); off, every request shares one FIFO class.
pub fn enabled() -> bool {
    defaults::num("overload.enabled") == 1
}

/// The class names, highest rank first.
pub fn classes() -> Vec<&'static str> {
    defaults::list("overload.classes")
}

/// The rank of class `name` (its position in `overload.classes`), else the rank of `overload.class_unknown`, else the top rank.
pub fn rank_of(name: &str) -> usize {
    let cs = classes();
    cs.iter().position(|c| *c == name).or_else(|| cs.iter().position(|c| *c == defaults::text("overload.class_unknown"))).unwrap_or(0)
}

/// The class name of rank `rank` (the unknown class's name past the end).
pub fn class_name(rank: usize) -> &'static str {
    classes().get(rank).copied().unwrap_or_else(|| defaults::text("overload.class_unknown"))
}

/// Per rank: whether the class shares the adaptive limit.
pub fn limited_ranks() -> Vec<bool> {
    let limited = defaults::list("overload.limited_classes");
    classes().iter().map(|c| enabled() && limited.contains(c)).collect()
}

/// The value of the JSON string key `key` in `text` (the first occurrence), read without parsing the whole (possibly cut) text.
fn string_value<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let quoted = format!("\"{key}\"");
    let at = text.find(&quoted)? + quoted.len();
    let rest = text[at..].trim_start().strip_prefix(':')?.trim_start().strip_prefix('"')?;
    rest.find('"').map(|end| &rest[..end])
}

/// [`classify`], or `None` while the bytes do not yet tell the class (nothing, or a cut prefix or event, arrived so far).
pub fn classify_read(head: &[u8]) -> Option<(usize, &'static str)> {
    let got = classify(head);
    let unknown = rank_of(defaults::text("overload.class_unknown"));
    let complete = head.len() >= defaults::num("overload.peek_bytes") as usize || head.ends_with(b"}");
    (got.0 != unknown || got.1 != defaults::text("overload.event_none") || complete).then_some(got)
}

/// The class rank and event of a request from its first bytes (`head`, possibly empty or cut anywhere). Disabled: rank 0.
/// The event is `overload.event_none` when it was not read; an event not listed in `overload.class_by_event` is labelled
/// `overload.event_none` too (the label set stays bounded) and classed `overload.class_unknown`.
pub fn classify(head: &[u8]) -> (usize, &'static str) {
    let none = defaults::text("overload.event_none");
    if !enabled() {
        return (0, none);
    }
    let text = String::from_utf8_lossy(head);
    let prefix = text.split([' ', '\n']).next().unwrap_or_default();
    let unknown = defaults::text("overload.class_unknown");
    if prefix.is_empty() || prefix.len() == text.len() {
        return (rank_of(unknown), none); // nothing read, or the prefix itself is not complete
    }
    if let Some(c) = defaults::raw("overload.class_by_prefix").get(prefix).and_then(V::as_str) {
        return (rank_of(c), none);
    }
    let keys = defaults::raw("overload.event_key_by_prefix").get(prefix).map(V::strings).unwrap_or_default();
    let by_event = defaults::raw("overload.class_by_event");
    let found = keys.iter().find_map(|k| string_value(&text, k));
    match found.and_then(|ev| by_event.as_table()?.iter().find(|(name, _)| *name == ev)) {
        Some((ev, class)) => (rank_of(class.as_str().unwrap_or(unknown)), ev),
        None => (rank_of(unknown), none),
    }
}

/// One queued request: the connection, when it was queued, how many requests were ahead of it, its class rank and event label.
#[derive(Debug)]
pub struct Item<T> {
    /// The accepted connection.
    pub conn: T,
    /// When it was queued.
    pub at: Instant,
    /// Requests ahead of it when it was queued (queued plus being served).
    pub in_flight: u64,
    /// Its class rank.
    pub class: usize,
    /// Its event label (`overload.event_none` when not read).
    pub event: &'static str,
    /// A worker passed it over at least once because the adaptive limit was reached (counted once).
    pub limited: bool,
    /// Nothing of it had arrived when it was accepted (classed `overload.class_unknown`): it is peeked again at each pop until its
    /// class can be read ([`Queue::reclass`]).
    pub unread: bool,
}

/// What [`Queue::push`] did with a request.
#[derive(Debug)]
pub enum Admit<T> {
    /// Queued.
    Queued,
    /// Queued, and this lower-class request was taken out to make room (the caller answers it BUSY).
    Evicted(Item<T>),
    /// Not queued: the queue is full of requests of its class or higher (the caller answers it BUSY).
    Rejected(Item<T>),
}

/// The priority queue: one FIFO lane per class rank.
#[derive(Debug)]
pub struct Queue<T> {
    lanes: Vec<VecDeque<Item<T>>>,
}

impl<T> Default for Queue<T> {
    fn default() -> Self {
        Queue { lanes: Vec::new() }
    }
}

impl<T> Queue<T> {
    /// Queued requests in all classes.
    pub fn len(&self) -> usize {
        self.lanes.iter().map(VecDeque::len).sum()
    }

    /// Nothing queued in any class.
    pub fn is_empty(&self) -> bool {
        self.lanes.iter().all(VecDeque::is_empty)
    }

    /// Queued requests per class rank.
    pub fn by_rank(&self) -> Vec<usize> {
        self.lanes.iter().map(VecDeque::len).collect()
    }

    /// Queue `item` when there is room (`cap` requests in all); a full queue evicts the newest request of the lowest class strictly
    /// below the item's, or refuses the item when there is none.
    pub fn push(&mut self, item: Item<T>, cap: usize) -> Admit<T> {
        if self.lanes.len() <= item.class {
            self.lanes.resize_with(item.class + 1, VecDeque::new);
        }
        if self.len() < cap {
            self.lanes[item.class].push_back(item);
            return Admit::Queued;
        }
        let victim = (item.class + 1..self.lanes.len()).rev().find(|r| !self.lanes[*r].is_empty()).and_then(|r| self.lanes[r].pop_back());
        match victim {
            Some(v) => {
                self.lanes[item.class].push_back(item);
                Admit::Evicted(v)
            }
            None => Admit::Rejected(item),
        }
    }

    /// Class again each request accepted before its bytes arrived: `read` peeks it and gives its class and event once they can be
    /// told (`None` = still not), and the request moves to that class's lane, in arrival order.
    pub fn reclass(&mut self, read: impl Fn(&T) -> Option<(usize, &'static str)>) {
        let mut moved = Vec::new();
        for lane in &mut self.lanes {
            let mut i = 0;
            while i < lane.len() {
                let found = lane[i].unread.then(|| read(&lane[i].conn)).flatten();
                match (found, lane.get(i).map(|it| it.class)) {
                    (Some((class, event)), Some(cur)) if class != cur => {
                        if let Some(mut it) = lane.remove(i) {
                            (it.class, it.event, it.unread) = (class, event, false);
                            moved.push(it);
                        }
                    }
                    (Some((_, event)), _) => {
                        (lane[i].event, lane[i].unread) = (event, false);
                        i += 1;
                    }
                    _ => i += 1,
                }
            }
        }
        for it in moved {
            if self.lanes.len() <= it.class {
                self.lanes.resize_with(it.class + 1, VecDeque::new);
            }
            let lane = &mut self.lanes[it.class];
            let at = lane.iter().position(|o| o.at > it.at).unwrap_or(lane.len());
            lane.insert(at, it);
        }
    }

    /// The oldest request of the highest-ranked class `may_serve` allows. The head of a class it refuses is marked limited, and
    /// `on_limited` is told about it the first time.
    pub fn pop(&mut self, may_serve: impl Fn(usize) -> bool, mut on_limited: impl FnMut(&Item<T>)) -> Option<Item<T>> {
        for (rank, lane) in self.lanes.iter_mut().enumerate() {
            let Some(head) = lane.front_mut() else { continue };
            if may_serve(rank) {
                return lane.pop_front();
            }
            if !head.limited {
                head.limited = true;
                on_limited(head);
            }
        }
        None
    }
}

/// The adaptive concurrency limit of the limited classes: AIMD (additive increase, multiplicative decrease), as in Netflix
/// concurrency-limits and tower-acc's `Aimd`, with every parameter from `overload.aimd_*`. Kept as a float so repeated backoffs
/// decay smoothly; the usable limit is its integer part, clamped to `[aimd_min, workers - reserved_workers]`.
#[derive(Debug, Clone)]
pub struct Aimd {
    limit: f64,
}

impl Aimd {
    /// A limiter starting at its upper bound for `workers` workers (an idle machine serves everything at once).
    pub fn new(workers: usize) -> Aimd {
        Aimd { limit: Self::max(workers) as f64 }
    }

    /// The lower bound (`overload.aimd_min`).
    pub fn min() -> usize {
        defaults::num("overload.aimd_min") as usize
    }

    /// The upper bound: `workers` less `overload.reserved_workers`, never below the lower bound.
    pub fn max(workers: usize) -> usize {
        workers.saturating_sub(defaults::num("overload.reserved_workers") as usize).max(Self::min())
    }

    /// How many limited-class requests may be served at once now.
    pub fn limit(&self, workers: usize) -> usize {
        (self.limit as usize).clamp(Self::min(), Self::max(workers))
    }

    /// Whether the limit is backed off to the shed floor (`overload.shed_at_limit`) below its upper bound: sustained overload.
    pub fn at_floor(&self, workers: usize) -> bool {
        self.limit < Self::max(workers) as f64 && self.limit(workers) <= defaults::num("overload.shed_at_limit") as usize
    }

    /// The raw (fractional) limit, for status.
    pub fn raw(&self) -> f64 {
        self.limit
    }

    /// Record one finished request that took `took` (queue wait plus serving) against `target`.
    pub fn update(&mut self, took: Duration, target: Duration, workers: usize) {
        let permille = |k: &str| defaults::num(k) as f64 / 1000.0;
        let next = if took > target { self.limit * permille("overload.aimd_backoff_permille") } else { self.limit + permille("overload.aimd_increase_permille") };
        self.limit = next.clamp(Self::min() as f64, Self::max(workers) as f64);
    }
}

/// The latency target of a request of class `rank` and event `event`: the event's row of `overload.aimd_target_ms_by_event`, else its
/// class row of `overload.aimd_target_ms_by_class`, else the guard class row (the tightest).
pub fn target(rank: usize, event: &str) -> Duration {
    let ms = defaults::raw("overload.aimd_target_ms_by_event")
        .get(event)
        .and_then(V::as_integer)
        .or_else(|| defaults::raw("overload.aimd_target_ms_by_class").get(class_name(rank)).and_then(V::as_integer))
        .or_else(|| defaults::raw("overload.aimd_target_ms_by_class").get(defaults::text("overload.class_unknown")).and_then(V::as_integer))
        .unwrap_or(0);
    Duration::from_millis(ms.max(0) as u64)
}

/// Whether a request of class `rank` that waited `waited` in the queue is past its class bound (`overload.shed_wait_ms_by_class`).
pub fn waited_too_long(rank: usize, waited: Duration) -> bool {
    enabled()
        && defaults::raw("overload.shed_wait_ms_by_class")
            .get(class_name(rank))
            .and_then(V::as_integer)
            .is_some_and(|ms| waited > Duration::from_millis(ms.max(0) as u64))
}

thread_local! {
    /// Whether the request this worker serves runs in shed mode.
    static SHED: Cell<bool> = const { Cell::new(false) };
}

/// Mark the request on this thread as served in shed mode (or not); cleared with `false` when it ends.
pub fn set_request_shed(on: bool) {
    SHED.with(|s| s.set(on));
}

/// Whether the request on this thread runs in shed mode.
pub fn request_shed() -> bool {
    SHED.with(Cell::get)
}

/// Whether `check` is skipped in shed mode: the request runs in shed mode and the check is advice (it does not fail closed, is not a
/// recorder in `diagnostics.shed_never`, and is not in `overload.keep_checks`).
pub fn sheds_check(check: &str) -> bool {
    request_shed()
        && crate::script::failure_mode(check) != defaults::text("script.failure_mode_closed")
        && defaults::raw("diagnostics.shed_never").get(check).is_none()
        && defaults::raw("overload.keep_checks").get(check).is_none()
}

/// Count one overload outcome (`what` = an `overload.what_*` label) for a request of class `rank` and event `event`.
pub fn count(what: &str, rank: usize, event: &str) {
    crate::metrics::bump("overload", &[("what", what), ("class", class_name(rank)), ("event", event)]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(class: usize, tag: u32) -> Item<u32> {
        Item { conn: tag, at: Instant::now(), in_flight: 0, class, event: "-", limited: false, unread: false }
    }

    fn rank(c: &str) -> usize {
        rank_of(c)
    }

    #[test]
    fn requests_are_classed_by_prefix_and_event_and_an_unread_one_is_a_guard() {
        let (guard, advisory, control, turn) = (rank("guard"), rank("advisory"), rank("control"), rank("turn"));
        assert!(control < guard && guard < turn && turn < advisory, "ranks follow overload.classes");
        assert_eq!(classify(b"CTL status"), (control, "-"));
        assert_eq!(classify(b"P /repo\nget x"), (control, "-"));
        assert_eq!(classify(b"D 0.3.31\n{\"host\":\"claude\",\"event\":\"PostToolUse\",\"tool\":null}\n{}"), (advisory, "PostToolUse"));
        assert_eq!(classify(b"D 0.3.31\n{\"host\":\"claude\",\"event\": \"PreToolUse\"}"), (guard, "PreToolUse"));
        assert_eq!(classify(b"V 0.3.31\n{\"session_id\":\"s\",\"hook_event_name\":\"UserPromptSubmit\"}"), (turn, "UserPromptSubmit"));
        // fail toward guard: nothing sent yet, a cut prefix, a cut event, an unknown event, an unknown prefix
        for head in [&b""[..], b"D", b"D 0.3.31\n{\"host\":\"claude\",\"ev", b"D 0.3.31\n{\"event\":\"PostTo", b"D 1\n{\"event\":\"Nope\"}", b"Z 1\n{}"] {
            assert_eq!(classify(head), (guard, "-"), "{:?} is a guard", String::from_utf8_lossy(head));
        }
    }

    #[test]
    fn disabled_every_request_is_one_fifo_class() {
        defaults::set_overlay(&[("overload.enabled", serde_json::json!(0))]);
        let got = (classify(b"CTL status"), classify(b"D 1\n{\"event\":\"PostToolUse\"}"), limited_ranks().iter().any(|l| *l));
        defaults::set_overlay(&[]);
        assert_eq!(got, ((0, "-"), (0, "-"), false));
    }

    #[test]
    fn the_highest_class_is_served_first_and_fifo_within_a_class() {
        let mut q = Queue::default();
        for (c, t) in [(3, 1), (1, 2), (3, 3), (1, 4), (0, 5)] {
            assert!(matches!(q.push(item(c, t), 16), Admit::Queued));
        }
        let order: Vec<u32> = std::iter::from_fn(|| q.pop(|_| true, |_| {}).map(|i| i.conn)).collect();
        assert_eq!(order, vec![5, 2, 4, 1, 3]);
    }

    #[test]
    fn a_full_queue_evicts_the_newest_lower_class_request_and_refuses_only_when_none_is_lower() {
        let mut q = Queue::default();
        for t in 0..3 {
            q.push(item(3, t), 4);
        }
        q.push(item(1, 10), 4);
        match q.push(item(1, 11), 4) {
            Admit::Evicted(v) => assert_eq!((v.class, v.conn), (3, 2), "the newest advisory request makes room"),
            other => panic!("expected an eviction: {other:?}"),
        }
        assert!(matches!(q.push(item(3, 12), 4), Admit::Rejected(_)), "an advisory request never evicts its own class");
        q.push(item(1, 13), 4);
        q.push(item(1, 14), 4);
        assert!(matches!(q.push(item(1, 15), 4), Admit::Rejected(_)), "a queue full of guards refuses a guard");
        assert_eq!(q.by_rank(), vec![0, 4, 0, 0]);
    }

    #[test]
    fn a_request_accepted_before_its_bytes_arrived_is_classed_again_in_arrival_order() {
        let mut q = Queue::default();
        let t0 = Instant::now();
        let mut early = item(rank("guard"), 1);
        (early.unread, early.at) = (true, t0);
        q.push(early, 8);
        let mut later = item(rank("advisory"), 2);
        later.at = t0 + Duration::from_millis(5);
        q.push(later, 8);
        q.reclass(|c| (*c == 1).then_some((rank("advisory"), "PostToolUse")));
        assert_eq!(q.by_rank()[rank("guard")], 0, "the unread request left the guard lane");
        let first = q.pop(|_| true, |_| {}).unwrap();
        assert_eq!((first.conn, first.event, first.unread), (1, "PostToolUse", false), "it keeps its place by arrival");
        assert_eq!(classify_read(b"D 1\n{\"host\":\"claude\",\"ev"), None, "a cut event is not decided yet");
        assert_eq!(classify_read(b"D 1\n{\"event\":\"Nope\"}"), Some((rank("guard"), "-")), "a complete unknown event is a guard");
    }

    #[test]
    fn a_limited_class_waits_while_the_limit_is_reached_and_is_counted_once() {
        let mut q = Queue::default();
        q.push(item(3, 1), 8);
        let mut seen = 0;
        assert!(q.pop(|r| r != 3, |_| seen += 1).is_none());
        assert!(q.pop(|r| r != 3, |_| seen += 1).is_none());
        assert_eq!(seen, 1, "the same request is counted limited once");
        q.push(item(1, 2), 8);
        assert_eq!(q.pop(|r| r != 3, |_| {}).map(|i| i.conn), Some(2), "a guard passes a blocked advisory lane");
        assert_eq!(q.pop(|_| true, |_| {}).map(|i| (i.conn, i.limited)), Some((1, true)));
    }

    #[test]
    fn the_limit_backs_off_on_slow_requests_recovers_on_fast_ones_and_stays_in_bounds() {
        let workers = 4;
        let (lo, hi) = (Aimd::min(), Aimd::max(workers));
        assert_eq!((lo, hi), (1, 3), "shipped: aimd_min 1, reserved_workers 1");
        let mut a = Aimd::new(workers);
        assert_eq!(a.limit(workers), hi);
        assert!(!a.at_floor(workers));
        let t = Duration::from_millis(100);
        for _ in 0..50 {
            a.update(Duration::from_millis(500), t, workers);
        }
        assert_eq!(a.limit(workers), lo);
        assert!(a.at_floor(workers), "sustained slowness reaches the shed floor");
        for _ in 0..50 {
            a.update(Duration::from_millis(10), t, workers);
        }
        assert_eq!(a.limit(workers), hi, "fast requests restore the limit, also at low traffic");
        assert!(!a.at_floor(workers));
        // two workers: the bound is one, and the floor is never "backed off" (shed mode then comes from queue waits only)
        let mut b = Aimd::new(2);
        b.update(Duration::from_secs(9), t, 2);
        assert_eq!(b.limit(2), 1);
        assert!(!b.at_floor(2));
    }

    #[test]
    fn shed_mode_skips_only_advice() {
        assert!(!sheds_check("handover-hygiene"), "outside shed mode nothing is skipped");
        set_request_shed(true);
        let got = (sheds_check("handover-hygiene"), sheds_check("git"), sheds_check("merge-side-pick"), sheds_check("switch-notice"));
        set_request_shed(false);
        assert_eq!(got, (true, false, false, false), "advice skipped; fail-closed, recorder and kept checks run");
    }

    #[test]
    fn a_guard_has_the_tightest_target_and_events_override_their_class() {
        assert_eq!(target(rank("guard"), "PreToolUse"), Duration::from_millis(300));
        assert!(target(rank("guard"), "Stop") > target(rank("guard"), "PreToolUse"), "a Stop scan is allowed longer");
        assert!(waited_too_long(rank("advisory"), Duration::from_secs(5)));
        assert!(!waited_too_long(rank("control"), Duration::from_secs(5)), "a class without a bound never times out");
    }
}
