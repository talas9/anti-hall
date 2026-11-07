//! Per-request spans (task #595): where the wall time of ONE dispatched request went.
//!
//! The histograms the daemon already keeps say how long requests take in aggregate, never which step of one slow request took it.
//! A span is the answer for one request: the time before its first check (queue wait, then the named phases of `serve_conn` and
//! `dispatch`: config snapshot, read, ack, context, parse, plan, table select), then for each check in the order it ran its wall
//! time, thread CPU, script-pool acquire time, time inside host functions by kind (`spans.kinds`: wall and thread CPU, so a host call that
//! computes reads as CPU and one that sleeps or blocks reads as wait) and the reason it was cut or deferred, then the reply tail
//! (post-check work, encode, settle, write). Wall minus CPU is the check's wait (off-CPU time); host CPU is part of the check's CPU,
//! host wait part of its wait, and nothing is subtracted twice.
//!
//! Recording is per request thread (a thread-local, no lock on the hot path); a finished span goes into a bounded ring of the recent
//! requests (`spans.ring_max`, `spans.ring_max_bytes`) and, if slow, into a small slow list (`spans.slow_keep`, `spans.slow_max_bytes`) so a rare multi-second
//! request is not pushed out by the fast ones after it. The query side is [`snapshot`] (`CTL spans`, `query stop_spans`). Every number is
//! a `spans.*` setting; `spans.enabled = 0` records nothing and times no host function. A session is shown only as its short hash.
use crate::defaults;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

/// Where a request is: before its first check, among the checks, or after the last one.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Pre,
    Checks,
    Post,
}

/// Time a check spent in the host functions of one kind.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub struct HostRec {
    /// Index of the kind in `spans.kinds`.
    kind: u8,
    wall_us: u64,
    /// Thread CPU inside the calls (already part of the check's `cpu_us`).
    cpu_us: u64,
    calls: u32,
}

impl HostRec {
    /// Off-CPU part of the calls: sleeping, blocked on I/O or a lock, preempted.
    fn wait_us(&self) -> u64 {
        self.wall_us.saturating_sub(self.cpu_us)
    }
}

/// One check of a span.
#[derive(Clone, Default)]
pub struct CheckRec {
    check: String,
    /// Microseconds from the request's start (not counting its queue wait) to this check's start.
    start_us: u64,
    wall_us: u64,
    cpu_us: u64,
    /// Time to get a script context ready (pool, fingerprints, load) before the check's JavaScript ran.
    acquire_us: u64,
    decision: &'static str,
    reason: &'static str,
    /// Time in host functions of one kind; kinds never called are absent.
    host: Vec<HostRec>,
}

/// One finished span.
#[derive(Clone)]
pub struct Rec {
    seq: u64,
    ts_ms: u64,
    event: String,
    session: String,
    /// Time the request waited in the daemon's queue before a worker took it.
    wait_us: u64,
    pre: Vec<(&'static str, u64)>,
    checks: Vec<CheckRec>,
    post: Vec<(&'static str, u64)>,
    /// From the worker taking the request to the end of its reply.
    total_us: u64,
    outcome: &'static str,
    late: bool,
}

impl Rec {
    /// A rough byte size, for the ring's byte bound.
    fn bytes(&self) -> usize {
        let checks: usize = self.checks.iter().map(|c| std::mem::size_of::<CheckRec>() + c.check.len() + c.host.len() * std::mem::size_of::<HostRec>()).sum();
        std::mem::size_of::<Rec>() + self.event.len() + self.session.len() + (self.pre.len() + self.post.len()) * std::mem::size_of::<(&str, u64)>() + checks
    }
    fn gap_us(&self) -> u64 {
        self.wait_us + self.pre.iter().map(|p| p.1).sum::<u64>()
    }
}

/// The bounds of the ring (all `spans.*` settings; tests build their own).
#[derive(Clone, Copy)]
pub struct Limits {
    /// Most recent spans kept.
    pub ring_max: usize,
    /// Estimated bytes the recent ring may hold.
    pub ring_max_bytes: usize,
    /// Slowest spans kept apart.
    pub slow_keep: usize,
    /// Estimated bytes the slow list may hold.
    pub slow_max_bytes: usize,
    /// Request total from which a span is a slow-list candidate.
    pub slow_min_us: u64,
}

impl Limits {
    fn current() -> Limits {
        Limits {
            ring_max: defaults::num("spans.ring_max") as usize,
            ring_max_bytes: defaults::num("spans.ring_max_bytes") as usize,
            slow_keep: defaults::num("spans.slow_keep") as usize,
            slow_max_bytes: defaults::num("spans.slow_max_bytes") as usize,
            slow_min_us: defaults::num("spans.slow_min_us"),
        }
    }
}

#[derive(Default)]
struct Ring {
    recent: VecDeque<Rec>,
    bytes: usize,
    slow: Vec<Rec>,
    slow_bytes: usize,
}

static RING: Mutex<Ring> = Mutex::new(Ring { recent: VecDeque::new(), bytes: 0, slow: Vec::new(), slow_bytes: 0 });
static SEQ: AtomicU64 = AtomicU64::new(0);

/// What pushing one span did to the ring (the daemon turns it into counters).
#[derive(Default, Clone, Copy)]
pub struct Pushed {
    /// Recent spans dropped.
    pub evicted: u64,
    /// The span entered the slow list.
    pub slow_added: bool,
    /// Slow-list spans dropped.
    pub slow_evicted: u64,
}

/// Add `rec` to the ring under `lim`.
fn push(rec: Rec, lim: Limits) -> Pushed {
    let mut out = Pushed::default();
    let mut r = RING.lock().unwrap_or_else(|e| e.into_inner());
    if lim.slow_keep > 0 && rec.total_us >= lim.slow_min_us {
        r.slow_bytes += rec.bytes();
        r.slow.push(rec.clone());
        out.slow_added = true;
        while r.slow.len() > lim.slow_keep || (r.slow_bytes > lim.slow_max_bytes && r.slow.len() > 1) {
            let fastest = r.slow.iter().enumerate().min_by_key(|(_, s)| s.total_us).map(|(i, _)| i).unwrap_or(0);
            let gone = r.slow.swap_remove(fastest);
            r.slow_bytes = r.slow_bytes.saturating_sub(gone.bytes());
            out.slow_evicted += 1;
        }
    }
    r.bytes += rec.bytes();
    r.recent.push_back(rec);
    while r.recent.len() > lim.ring_max.max(1) || (r.bytes > lim.ring_max_bytes && r.recent.len() > 1) {
        if let Some(old) = r.recent.pop_front() {
            r.bytes = r.bytes.saturating_sub(old.bytes());
            out.evicted += 1;
        }
    }
    out
}

/// The request being recorded on this thread.
struct Live {
    /// Recording this request (false once its event is not one of `spans.events`).
    on: bool,
    t0: Instant,
    last: Instant,
    stage: Stage,
    rec: Rec,
    cur: Option<CheckRec>,
    cur_t0: Instant,
    cur_cpu0: u64,
}

thread_local! {
    static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
    /// True while a check of a recorded request is running: the one flag a host-function wrapper reads.
    static TIMING: Cell<bool> = const { Cell::new(false) };
}

/// Start the span of the request this thread took at `started` (`wait`: how long it sat in the queue before). Does nothing when `spans.enabled` is 0.
pub fn begin(started: Instant, wait: Duration) {
    begin_if(defaults::num("spans.enabled") == 1, started, wait);
}

/// [`begin`] with the switch given.
pub fn begin_if(enabled: bool, started: Instant, wait: Duration) {
    TIMING.with(|t| t.set(false));
    LIVE.with(|l| {
        let mut l = l.borrow_mut();
        if !enabled {
            *l = None;
            return;
        }
        let now = started;
        let ts_ms = crate::health::now_ms().saturating_sub(wait.as_millis() as u64 + started.elapsed().as_millis() as u64);
        *l = Some(Live {
            on: true,
            t0: now,
            last: now,
            stage: Stage::Pre,
            rec: Rec {
                seq: 0,
                ts_ms,
                event: String::new(),
                session: String::new(),
                wait_us: wait.as_micros() as u64,
                pre: Vec::new(),
                checks: Vec::new(),
                post: Vec::new(),
                total_us: 0,
                outcome: "",
                late: false,
            },
            cur: None,
            cur_t0: now,
            cur_cpu0: 0,
        });
    });
}

/// Name the request's event and session: only the events in `spans.events` (all when the list is empty) stay recorded.
pub fn set_event(event: &str, session: &str) {
    let want = defaults::list("spans.events");
    set_event_in(event, session, &want);
}

fn set_event_in(event: &str, session: &str, want: &[&str]) {
    LIVE.with(|l| {
        if let Some(live) = l.borrow_mut().as_mut() {
            live.on = want.is_empty() || want.contains(&event);
            if live.on {
                live.rec.event = event.to_string();
                live.rec.session = crate::telemetry::project_hash(session);
            }
        }
    });
}

/// Close the phase `phase` (a `spans.phase_*` defaults key): the time since the previous mark (or the request's start) is booked to it.
pub fn mark(phase: &'static str) {
    LIVE.with(|l| {
        if let Some(live) = l.borrow_mut().as_mut().filter(|x| x.on) {
            let now = Instant::now();
            let us = now.duration_since(live.last).as_micros() as u64;
            live.last = now;
            match live.stage {
                Stage::Pre => live.rec.pre.push((phase, us)),
                Stage::Post => live.rec.post.push((phase, us)),
                Stage::Checks => {} // between two checks nothing is named; it shows as the span's unaccounted time
            }
        }
    });
}

/// A check is about to start. The first one closes the pre-check gap (its last phase, `select` (a `spans.phase_*` key), is the table lookup).
pub fn begin_check(check: &str, select: &'static str) {
    LIVE.with(|l| {
        if let Some(live) = l.borrow_mut().as_mut().filter(|x| x.on) {
            let now = Instant::now();
            if live.stage == Stage::Pre {
                live.rec.pre.push((select, now.duration_since(live.last).as_micros() as u64));
                live.stage = Stage::Checks;
            }
            live.cur_t0 = now;
            live.cur_cpu0 = crate::limits::thread_cpu_us();
            live.cur = Some(CheckRec { check: check.to_string(), start_us: now.duration_since(live.t0).as_micros() as u64, ..CheckRec::default() });
            TIMING.with(|t| t.set(true));
        }
    });
}

/// The script context of the running check was ready after `us` (pool, fingerprints, load); adds up when a check calls twice.
pub fn note_acquire(us: u64) {
    if !TIMING.with(Cell::get) {
        return;
    }
    LIVE.with(|l| {
        if let Some(c) = l.borrow_mut().as_mut().and_then(|x| x.cur.as_mut()) {
            c.acquire_us += us;
        }
    });
}

/// A host function of kind index `kind` took `wall_us` of wall time, of which `cpu_us` was this thread's CPU.
pub fn note_host(kind: u8, wall_us: u64, cpu_us: u64) {
    LIVE.with(|l| {
        if let Some(c) = l.borrow_mut().as_mut().and_then(|x| x.cur.as_mut()) {
            match c.host.iter_mut().find(|h| h.kind == kind) {
                Some(h) => {
                    h.wall_us += wall_us;
                    h.cpu_us += cpu_us;
                    h.calls += 1;
                }
                None => c.host.push(HostRec { kind, wall_us, cpu_us, calls: 1 }),
            }
        }
    });
}

/// True while a check of a recorded request runs (the wrapper times a host call only then).
pub fn timing() -> bool {
    TIMING.with(Cell::get)
}

/// The check that was running ended: `decision` is what it answered (`allow`, `advisory`, `block`, `defer`), `reason` why it gave no
/// answer (`shed`, `client_gone`, `hard_deadline`, `check_deferred`, `cpu_budget`) or `spans.reason_ran`.
pub fn end_check(decision: &'static str, reason: &'static str) {
    TIMING.with(|t| t.set(false));
    LIVE.with(|l| {
        if let Some(live) = l.borrow_mut().as_mut().filter(|x| x.on)
            && let Some(mut c) = live.cur.take()
        {
            let now = Instant::now();
            c.wall_us = now.duration_since(live.cur_t0).as_micros() as u64;
            c.cpu_us = crate::limits::thread_cpu_us().saturating_sub(live.cur_cpu0);
            c.decision = decision;
            c.reason = reason;
            live.last = now;
            live.rec.checks.push(c);
        }
    });
}

/// Every check has run; what follows is the reply tail. `phase` books the work since the last check (notices, the loop's exit).
pub fn end_checks(phase: &'static str) {
    LIVE.with(|l| {
        if let Some(live) = l.borrow_mut().as_mut().filter(|x| x.on) {
            let now = Instant::now();
            let us = now.duration_since(live.last).as_micros() as u64;
            live.last = now;
            if live.stage == Stage::Pre {
                live.rec.pre.push((phase, us)); // no check ran: the whole wait is the gap
            } else {
                live.rec.post.push((phase, us));
            }
            live.stage = Stage::Post;
        }
    });
}

/// What the daemon needs to count about a finished span.
pub struct Summary {
    /// The hook event.
    pub event: String,
    /// Queue wait plus the pre-check phases.
    pub gap_us: u64,
    /// `(kind index, wall microseconds, CPU microseconds)` summed over the checks.
    pub host: Vec<(u8, u64, u64)>,
    /// What the ring did.
    pub pushed: Pushed,
}

/// The request ended: close the tail, store the span. `None` when nothing was recorded (disabled, or an event not in `spans.events`).
pub fn finish(tail: &'static str, outcome: &'static str, late: bool) -> Option<Summary> {
    finish_with(tail, outcome, late, Limits::current())
}

fn finish_with(tail: &'static str, outcome: &'static str, late: bool, lim: Limits) -> Option<Summary> {
    TIMING.with(|t| t.set(false));
    let live = LIVE.with(|l| l.borrow_mut().take())?;
    if !live.on || live.rec.event.is_empty() {
        return None;
    }
    let now = Instant::now();
    let mut rec = live.rec;
    if live.stage == Stage::Post || live.stage == Stage::Checks {
        rec.post.push((tail, now.duration_since(live.last).as_micros() as u64));
    } else {
        rec.pre.push((tail, now.duration_since(live.last).as_micros() as u64));
    }
    rec.total_us = now.duration_since(live.t0).as_micros() as u64;
    rec.outcome = outcome;
    rec.late = late;
    rec.seq = SEQ.fetch_add(1, Relaxed) + 1;
    let mut host: Vec<(u8, u64, u64)> = Vec::new();
    for c in &rec.checks {
        for h in &c.host {
            match host.iter_mut().find(|x| x.0 == h.kind) {
                Some(x) => {
                    x.1 += h.wall_us;
                    x.2 += h.cpu_us;
                }
                None => host.push((h.kind, h.wall_us, h.cpu_us)),
            }
        }
    }
    let (event, gap_us) = (rec.event.clone(), rec.gap_us());
    let pushed = push(rec, lim);
    Some(Summary { event, gap_us, host, pushed })
}

/// The name of kind index `k` in `spans.kinds`.
pub fn kind_name(k: u8) -> &'static str {
    defaults::list("spans.kinds").get(k as usize).copied().unwrap_or_default()
}

/// The kind index of host function `name`: the kind whose `spans.kind_functions` entry lists it (exact name; a function no kind lists
/// is not timed).
pub fn kind_of(name: &str) -> Option<u8> {
    let kinds = defaults::list("spans.kinds");
    let table = defaults::raw("spans.kind_functions");
    kinds.iter().position(|kind| table.get(kind).map(|v| v.strings()).unwrap_or_default().contains(&name)).map(|i| i as u8)
}

/// The label of a phase key (`spans.phase_*`); a key the defaults do not know shows as itself.
fn label(key: &'static str) -> &'static str {
    if defaults::has(key) { defaults::text(key) } else { key }
}

fn phases_json(v: &[(&'static str, u64)]) -> Value {
    Value::Array(v.iter().map(|(p, us)| json!({"phase": label(p), "us": us})).collect())
}

fn check_json(c: &CheckRec) -> Value {
    let host: serde_json::Map<String, Value> = c
        .host
        .iter()
        .map(|h| (kind_name(h.kind).to_string(), json!({"us": h.wall_us, "cpu_us": h.cpu_us, "wait_us": h.wait_us(), "calls": h.calls})))
        .collect();
    let host_wait: u64 = c.host.iter().map(HostRec::wait_us).sum();
    let wait = c.wall_us.saturating_sub(c.cpu_us);
    json!({
        "check": c.check, "start_us": c.start_us, "wall_us": c.wall_us, "cpu_us": c.cpu_us, "acquire_us": c.acquire_us,
        // off-CPU time of the check; host CPU is already inside cpu_us and host wait inside wait_us
        "wait_us": wait, "host_wait_us": host_wait, "other_wait_us": wait.saturating_sub(host_wait),
        "decision": c.decision, "reason": if c.reason.is_empty() { defaults::text("spans.reason_ran") } else { c.reason }, "host": host,
    })
}

/// One span as JSON: the breakdown the report lists.
fn rec_json(r: &Rec) -> Value {
    let pre_sum: u64 = r.pre.iter().map(|p| p.1).sum();
    let post_sum: u64 = r.post.iter().map(|p| p.1).sum();
    let checks_sum: u64 = r.checks.iter().map(|c| c.wall_us).sum();
    // the biggest single step, so the report names it: a pre-check phase, a check, or a tail phase
    let mut top = ("", 0u64);
    for (p, us) in r.pre.iter().chain(r.post.iter()) {
        if *us > top.1 {
            top = (label(p), *us);
        }
    }
    for c in &r.checks {
        if c.wall_us > top.1 {
            top = (&c.check, c.wall_us);
        }
    }
    json!({
        "seq": r.seq, "ts_ms": r.ts_ms, "event": r.event, "session": r.session,
        "total_us": r.total_us, "queue_wait_us": r.wait_us, "gap_us": r.gap_us(),
        "outcome": label(r.outcome), "late": r.late,
        "pre": phases_json(&r.pre), "checks": r.checks.iter().map(check_json).collect::<Vec<_>>(), "tail": phases_json(&r.post),
        "unaccounted_us": r.total_us.saturating_sub(pre_sum + checks_sum + post_sum),
        "top": {"step": top.0, "us": top.1},
    })
}

/// `CTL spans [n=<count>] [event=<name>] [min_us=<total>]`: the slowest spans (largest request total first) of the recent ring and the
/// slow list, with the ring's occupancy.
pub fn snapshot(args: &str) -> Value {
    let want = |k: &str| args.split_whitespace().find_map(|a| a.strip_prefix(k).map(str::to_string));
    let max = defaults::num("spans.query_max") as usize;
    let n = want("n=").and_then(|v| v.parse::<usize>().ok()).filter(|n| *n > 0).unwrap_or(defaults::num("spans.query_default") as usize).min(max);
    let event = want("event=").filter(|e| !e.is_empty());
    let min_us: u64 = want("min_us=").and_then(|v| v.parse().ok()).unwrap_or(0);
    let r = RING.lock().unwrap_or_else(|e| e.into_inner());
    let mut all: Vec<&Rec> = r.recent.iter().chain(r.slow.iter()).filter(|x| event.as_deref().is_none_or(|e| x.event == e) && x.total_us >= min_us).collect();
    all.sort_by(|a, b| b.total_us.cmp(&a.total_us).then(b.seq.cmp(&a.seq)));
    all.dedup_by_key(|x| x.seq);
    let rows: Vec<Value> = all.into_iter().take(n).map(rec_json).collect();
    json!({
        "enabled": defaults::num("spans.enabled") == 1,
        "ring": {"recent": r.recent.len(), "recent_max": defaults::num("spans.ring_max"), "bytes": r.bytes, "bytes_max": defaults::num("spans.ring_max_bytes"), "slow": r.slow.len(), "slow_max": defaults::num("spans.slow_keep"), "slow_bytes": r.slow_bytes, "slow_bytes_max": defaults::num("spans.slow_max_bytes")},
        "requests": rows,
    })
}

#[cfg(test)]
mod tests;
