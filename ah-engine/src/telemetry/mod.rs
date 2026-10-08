//! What the daemon observes about itself: metrics (D51), impact events (D52) and telemetry (D78, D77), behind one handle.
//!
//! The hook path calls [`Telemetry::observe_check_in`], [`Telemetry::observe_rule`], [`Telemetry::observe_hook`] and
//! [`Telemetry::record_hook`]; the `metrics`, `impact`, `telemetry` and `status` commands read the same handle. Every
//! lock is held only for the update itself and never across I/O (D9).
//!
//! Telemetry is a thin layer over the metrics registry and the Store, in the submodules:
//!
//! * [`event`]: the event schema (fixed short fields, typed extras, no free text);
//! * [`recorder`]: the lock-free hot path (sharded counters and a ring of rich events), mirrored into the registry;
//! * [`persist`]: flushes to hot.db through the Store's writer, and the reads the reports use;
//! * [`rollup`]: daily rollups into archive.db;
//! * [`route`]: routing events joined to spawn results, and the NET savings estimate (D77);
//! * [`report`]: the `telemetry` and `impact` report bodies.
pub mod cli;
pub mod event;
pub mod persist;
pub mod recorder;
pub mod report;
pub mod rollup;
pub mod route;

use crate::checks::Verdict;
use crate::defaults;
use crate::metrics::Metrics;
use crate::rules::Action;
use crate::storage::{ImpactEvent, ImpactFilter, MemStore, Store};
use event::{Event, Kind, Outcome, day_of};
use persist::{Flushed, TelDb};
use recorder::Recorder;
use serde_json::{Value, json};
use std::sync::Mutex;

/// Metrics plus the impact ledger.
pub struct Telemetry {
    metrics: Mutex<Metrics>,
    store: Box<dyn Store>,
    /// The lock-free recorder (D78).
    rec: Recorder,
    /// Telemetry's database view, when the store has a database.
    tel: Option<TelDb>,
    /// When the last snapshot was kept (ms since the epoch; 0: none yet).
    snapshot_ms: std::sync::atomic::AtomicU64,
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What a request recorded while it was being served, held until its reply is written (review finding 4: a reply the
/// client never read must not count as a decision the user saw).
enum Staged {
    Record(Kind, String, String, Outcome, u64, u64),
    Event(Event),
    Impact(ImpactEvent),
}

thread_local! {
    /// `Some` while a daemon worker stages what its request records.
    static STAGE: std::cell::RefCell<Option<Vec<Staged>>> = const { std::cell::RefCell::new(None) };
}

/// Hold what this thread records from now on until [`Telemetry::stage_commit`] or [`stage_discard`].
pub fn stage_begin() {
    STAGE.with(|s| *s.borrow_mut() = Some(Vec::new()));
}

/// Drop what this thread staged: its request's reply could not be written.
pub fn stage_discard() {
    STAGE.with(|s| *s.borrow_mut() = None);
}

/// Stage `item` when staging is on for this thread; otherwise hand it back to be recorded now.
fn staged(item: Staged) -> Option<Staged> {
    STAGE.with(|s| match s.borrow_mut().as_mut() {
        Some(v) => {
            v.push(item);
            None
        }
        None => Some(item),
    })
}

/// Hashed project key for impact events: the path is never stored, only a short stable hash of it.
pub fn project_hash(project_key: &str) -> String {
    let h = format!("{:016x}", crate::health::fnv(project_key));
    h[..(defaults::num("telemetry.project_key_len") as usize).min(h.len())].to_string()
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

/// The decision name of a verdict, as used in metric labels and impact reasons.
pub fn decision_name(v: &Verdict) -> &'static str {
    match v {
        Verdict::Routed(inner, _) => decision_name(inner),
        Verdict::Allow => "allow",
        Verdict::Block(_) => "block",
        Verdict::Advisory(_) => "advisory",
        Verdict::Exact(x) if x.code == 2 => "block",
        // any other non-zero exit is the host's non-blocking error, not an allow
        Verdict::Exact(x) if x.code != 0 => "error",
        Verdict::Exact(x) if !x.out.is_empty() => "advisory",
        Verdict::Exact(_) => "allow",
        Verdict::Defer => "defer",
    }
}

impl Telemetry {
    fn sink(&self, item: Staged) {
        match staged(item) {
            None => {}
            Some(Staged::Record(k, h, e, o, us, ib)) => self.rec.record(k, &h, &e, o, us, ib),
            Some(Staged::Event(ev)) => self.rec.event(ev),
            Some(Staged::Impact(ev)) => self.store.record_impact(ev),
        }
    }

    fn record(&self, kind: Kind, h: &str, e: &str, o: Outcome, micros: u64, ib: u64) {
        if STAGE.with(|s| s.borrow().is_none()) {
            return self.rec.record(kind, h, e, o, micros, ib); // not staging: the lock-free path, no allocation
        }
        self.sink(Staged::Record(kind, h.to_string(), e.to_string(), o, micros, ib));
    }

    /// Record everything this thread staged since [`stage_begin`] (its request's reply was written), and stop staging.
    pub fn stage_commit(&self) {
        let held = STAGE.with(|s| s.borrow_mut().take()).unwrap_or_default();
        for item in held {
            self.sink(item);
        }
    }

    /// A telemetry handle with the in-memory store sized from the defaults.
    pub fn new() -> Telemetry {
        let store = MemStore::new(
            defaults::num("telemetry.max_events") as usize,
            defaults::num("telemetry.max_series") as usize * 4,
            defaults::text("telemetry.overflow_label"),
        );
        Telemetry::with_store(Box::new(store))
    }

    /// A telemetry handle recording impact events in `store` (the daemon passes the SQLite store, D52).
    pub fn with_store(store: Box<dyn Store>) -> Telemetry {
        let tel = store.db().map(TelDb::new);
        Telemetry { metrics: Mutex::new(Metrics::default()), store, rec: Recorder::from_defaults(), tel, snapshot_ms: std::sync::atomic::AtomicU64::new(0) }
    }

    /// Turn recording on or off (`telemetry.enabled`).
    pub fn set_enabled(&self, on: bool) {
        self.rec.set_enabled(on);
    }

    /// The recorder, for callers that record directly (a ported check, the dispatcher, the Jev lane).
    pub fn recorder(&self) -> &Recorder {
        &self.rec
    }

    /// Record one rich event (a routing decision, a spawn result, a Jev call, a spill): counted like an invocation and
    /// kept in the ring for the next flush.
    pub fn event(&self, ev: Event) {
        self.sink(Staged::Event(ev));
    }

    /// Record a model-routing decision (D77): the event, plus an impact event of kind `route` whose reason is what the
    /// check did, so the ledger counts decisions in both directions.
    pub fn route(&self, ev: Event, project: &str) {
        if let event::Extras::Route(r) = &ev.extras
            && self.rec.enabled()
        {
            self.impact("route", ev.h.as_str(), r.outcome.name(), project);
        }
        self.sink(Staged::Event(ev));
    }

    /// Record one hook request: its event, how it ended, how long it took and how many bytes it injected.
    pub fn record_hook(&self, event: &str, outcome: Outcome, micros: u64, injected: u64) {
        self.record(Kind::Hook, defaults::text("telemetry.hook_label"), event, outcome, micros, injected);
    }

    /// Store what the recorder holds (counters and events since the last flush) in hot.db. Called every
    /// `telemetry.flush_ms` and at shutdown. True when nothing is left unstored; without a database the data stays in
    /// memory (and is lost with the process, as the not-persisted note says).
    pub fn flush(&self) -> bool {
        let _one_at_a_time = self.rec.flush_guard();
        let p = self.rec.drain();
        if p.is_empty() {
            return true;
        }
        let Some(t) = &self.tel else { return false };
        match t.flush(day_of(now_ms()), p.deltas.clone(), p.events.clone()) {
            Flushed::Stored | Flushed::Unknown => {
                self.rec.commit(p);
                true
            }
            Flushed::Failed => false,
        }
    }

    /// The daily rollup (D78): store what the recorder holds, then roll complete days up into archive.db and apply the
    /// retention. Idempotent. The scheduler runs it daily (`telemetry_rollup`, D33); `ah-engine telemetry rollup` runs it by hand.
    pub fn rollup(&self, retention_days: u64) -> Result<Value, String> {
        let Some(t) = &self.tel else { return Err(defaults::text("msg.tel_no_db").to_string()) };
        self.flush();
        t.rollup(now_ms(), retention_days).map_err(|e| e.to_string())
    }

    /// The database view, when there is one.
    pub fn tel_db(&self) -> Option<&TelDb> {
        self.tel.as_ref()
    }

    /// The `telemetry` control verb: `summary` or `events`, with `window=`, `kind=`, `limit=`.
    pub fn telemetry_json(&self, sub: &str, window: &str, kind: &str, limit: usize) -> Value {
        let days = report::window_days(window);
        let now = now_ms();
        match sub {
            "events" => report::events_json(self.tel.as_ref(), Some(&self.rec), kind, days, limit, now),
            _ => report::summary_json(self.tel.as_ref(), Some(&self.rec), days, now),
        }
    }

    /// Count one request of any type.
    pub fn request(&self) {
        lk(&self.metrics).inc("requests", &[]);
    }

    /// Run `f` on the metrics registry.
    pub fn with_metrics<R>(&self, f: impl FnOnce(&mut Metrics) -> R) -> R {
        f(&mut lk(&self.metrics))
    }

    /// Record one impact event.
    pub fn impact(&self, kind: &str, check: &str, reason: &str, project: &str) {
        self.sink(Staged::Impact(ImpactEvent { ts_ms: now_ms(), kind: kind.into(), check: check.into(), reason: reason.into(), project: project.into() }));
    }

    /// A built-in check finished (outside a hook event): see [`Telemetry::observe_check_in`].
    pub fn observe_check(&self, check: &str, rule_id: &str, verdict: &Verdict, micros: u64, project: &str) {
        self.observe_check_in(defaults::text("telemetry.no_event_label"), check, rule_id, verdict, micros, project);
    }

    /// A built-in check finished while serving hook event `event`: count the run, time it, record its telemetry (outcome,
    /// latency, bytes injected) and the impact of a block or advisory.
    pub fn observe_check_in(&self, event: &str, check: &str, rule_id: &str, verdict: &Verdict, micros: u64, project: &str) {
        let decision = decision_name(verdict);
        let effective;
        let verdict = match verdict {
            Verdict::Routed(inner, _) => {
                effective = &**inner;
                effective
            }
            _ => verdict,
        };
        let (outcome, injected) = match verdict {
            Verdict::Allow => (Outcome::Allow, 0),
            Verdict::Block(_) => (Outcome::Block, 0),
            Verdict::Advisory(j) => (Outcome::Advise, j.len() as u64),
            Verdict::Exact(x) if x.code == 2 => (Outcome::Block, 0),
            Verdict::Exact(x) if x.code != 0 => (Outcome::Error, 0),
            Verdict::Exact(x) if !x.out.is_empty() => (Outcome::Advise, x.out.len() as u64),
            Verdict::Exact(_) => (Outcome::Allow, 0),
            Verdict::Defer => (Outcome::Defer, 0),
            Verdict::Routed(_, _) => (Outcome::Allow, 0),
        };
        self.record(Kind::Check, check, event, outcome, micros, injected);
        {
            let mut m = lk(&self.metrics);
            m.inc("check_calls", &[("check", check)]);
            m.inc("check_decisions", &[("check", check), ("decision", decision)]);
            m.observe("check_latency_us", &[("check", check)], micros);
        }
        match verdict {
            Verdict::Block(_) => self.impact("block", check, rule_id, project),
            Verdict::Advisory(_) => self.impact("advisory", check, rule_id, project),
            Verdict::Exact(_) if decision == "block" || decision == "advisory" => self.impact(decision, check, rule_id, project),
            Verdict::Defer => self.impact("fallback", check, "defer", project),
            Verdict::Allow | Verdict::Exact(_) | Verdict::Routed(_, _) => {}
        }
    }

    /// A regex rule matched (outside a hook event): see [`Telemetry::observe_rule_in`].
    pub fn observe_rule(&self, rule_id: &str, action: Action, project: &str) {
        self.observe_rule_in(defaults::text("telemetry.no_event_label"), rule_id, action, project);
    }

    /// A regex rule matched while serving hook event `event`.
    pub fn observe_rule_in(&self, event: &str, rule_id: &str, action: Action, project: &str) {
        self.record(
            Kind::Check,
            defaults::text("telemetry.rule_label"),
            event,
            if action == Action::Deny { Outcome::Block } else { Outcome::Advise },
            0,
            0,
        );
        let (name, kind) = match action {
            Action::Deny => ("deny", "block"),
            Action::Warn => ("warn", "warning"),
            Action::Context => ("context", "context"),
        };
        lk(&self.metrics).inc("rule_hits", &[("action", name)]);
        self.impact(kind, "", rule_id, project);
    }

    /// A hook request finished: count it by event and time it.
    pub fn observe_hook(&self, event: &str, micros: u64) {
        let mut m = lk(&self.metrics);
        m.inc("hook_calls", &[("event", event)]);
        m.observe("hook_latency_us", &[("event", event)], micros);
    }

    /// The engine could not answer and the client will run the Node hook.
    pub fn fallback(&self, reason: &str, project: &str) {
        self.impact("fallback", "", reason, project);
    }

    /// Keep a snapshot of the counters and histograms in the store (D51); the lock is held only for the export.
    pub fn snapshot_metrics(&self) -> bool {
        let body = {
            let mut m = lk(&self.metrics);
            self.rec.mirror_into(&mut m);
            m.export()
        };
        let now = now_ms();
        let kept = self.store.save_metrics(now, &body);
        if kept {
            self.snapshot_ms.store(now, std::sync::atomic::Ordering::SeqCst);
        }
        kept
    }

    /// Start from the last snapshot the store kept, so counters and histograms survive a restart.
    pub fn restore_metrics(&self) {
        if let Some((ts, body)) = self.store.load_metrics() {
            lk(&self.metrics).import(&body);
            self.snapshot_ms.store(ts, std::sync::atomic::Ordering::SeqCst);
        }
    }

    /// The `metrics` command's body: all series, optionally for one check, with the live gauges refreshed.
    pub fn metrics_json(&self, check: &str, gauges: &[(&str, f64)]) -> Value {
        let persisted = self.store.persisted();
        let note = defaults::text(if persisted { "telemetry.metrics_persisted_note" } else { "telemetry.not_persisted_note" });
        let snap = self.snapshot_ms.load(std::sync::atomic::Ordering::SeqCst);
        let mut m = lk(&self.metrics);
        self.rec.mirror_into(&mut m);
        for (n, v) in gauges {
            m.set(n, *v);
        }
        json!({"running": true, "persisted": persisted, "snapshot_ms": snap, "note": note, "metrics": m.snapshot(check)})
    }

    /// The `metrics --rollup` body: the stored rollups of one resolution since `since_ms`.
    pub fn rollups_json(&self, resolution: &str, since_ms: u64) -> Value {
        let known: Vec<&str> = crate::storage::resolutions().iter().map(|r| r.0).collect();
        json!({"running": true, "resolution": resolution, "resolutions": known, "rollups": self.store.rollups(resolution, since_ms)})
    }

    /// The `impact` command's body for the default window: see [`Telemetry::impact_json_in`].
    pub fn impact_json(&self, filter: &ImpactFilter, recent: usize) -> Value {
        self.impact_json_in(filter, recent, "")
    }

    /// The `impact` command's body, with the NET savings section (D77) for the last `window` (`7d`, `36h`; empty: the
    /// default). When routing decisions exist, the model-routing saving carries the computed estimate.
    pub fn impact_json_in(&self, filter: &ImpactFilter, recent: usize, window: &str) -> Value {
        let mut v = crate::impact::summary(&*self.store, filter, recent);
        let net = report::net_json(self.tel.as_ref(), Some(&self.rec), report::window_days(window), now_ms());
        if net["routing"]["decisions"].as_u64().unwrap_or(0) > 0 {
            let r = &mut v["savings"]["model_routing"];
            r["estimated_usd"] = net["routing"]["net_usd"].clone();
            r["status"] = json!(defaults::render("msg.tel_net_status", &[("n", &net["routing"]["decisions"]), ("days", &net["window"]["days"])]));
        }
        v["net"] = net;
        v
    }

    /// Headline counts for `status`.
    pub fn headline(&self) -> Value {
        let all = self.store.impact_counts(&ImpactFilter::default());
        let total = |kind: &str| all.iter().filter(|c| c.kind == kind).map(|c| c.count).sum::<u64>();
        let m = lk(&self.metrics);
        json!({
            "requests": m.counter_total("requests"),
            "check_runs": m.counter_total("check_calls"),
            "blocks": total("block"),
            "warnings": total("warning"),
            "context_injected": total("context"),
            "advisories": total("advisory"),
            "fallbacks": total("fallback"),
        })
    }
}

impl Default for Telemetry {
    fn default() -> Self {
        Telemetry::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_a_request_records_counts_only_once_its_reply_is_written() {
        // review finding 4: a reply the client never read was still counted as a block and an impact event
        let t = Telemetry::new();
        stage_begin();
        t.observe_check("git", "git-guard", &Verdict::Block("x".into()), 400, "abc");
        stage_discard();
        assert_eq!(t.impact_json(&ImpactFilter::default(), 10)["total"], 0, "an unwritten reply records nothing");
        assert!(t.recorder().pending_deltas().is_empty());
        stage_begin();
        t.observe_check("git", "git-guard", &Verdict::Block("x".into()), 400, "abc");
        assert_eq!(t.impact_json(&ImpactFilter::default(), 10)["total"], 0, "held until the reply is written");
        t.stage_commit();
        assert_eq!(t.impact_json(&ImpactFilter::default(), 10)["total"], 1);
        assert_eq!(t.recorder().pending_deltas().iter().map(|d| d.n).sum::<u64>(), 1);
    }

    #[test]
    fn a_blocking_check_run_is_counted_timed_and_recorded() {
        let t = Telemetry::new();
        t.observe_check("git", "git-guard", &Verdict::Block("x".into()), 400, "abc");
        t.observe_check("git", "git-guard", &Verdict::Allow, 100, "abc");
        let h = t.headline();
        assert_eq!(h["blocks"], 1);
        assert_eq!(h["check_runs"], 2);
        let imp = t.impact_json(&ImpactFilter::default(), 10);
        assert_eq!(imp["total"], 1);
        assert_eq!(imp["by_kind"]["block"], 1);
        assert_eq!(imp["blocks_by_reason"]["git-guard"], 1);
    }

    #[test]
    fn an_exact_answer_with_a_non_zero_non_block_exit_is_an_error_not_an_allow() {
        let x = |code, out: &str| Verdict::Exact(crate::checks::Exact { code, out: out.into(), err: String::new() });
        assert_eq!(decision_name(&x(1, "")), "error");
        assert_eq!(decision_name(&x(1, "text")), "error");
        assert_eq!(decision_name(&x(2, "")), "block");
        assert_eq!(decision_name(&x(0, "")), "allow");
        assert_eq!(decision_name(&x(0, "{}")), "advisory");
        let t = Telemetry::new();
        t.observe_check("c", "r", &x(1, ""), 10, "abc");
        let h = t.headline();
        assert_eq!((h["blocks"].as_u64(), h["check_runs"].as_u64()), (Some(0), Some(1)));
        assert_eq!(t.impact_json(&ImpactFilter::default(), 10)["total"], 0, "an error is not an impact");
    }

    #[test]
    fn project_keys_are_hashed_and_short() {
        let a = project_hash("/home/someone/secret-project");
        assert_eq!(a.len(), defaults::num("telemetry.project_key_len") as usize);
        assert!(!a.contains("secret"));
        assert_eq!(a, project_hash("/home/someone/secret-project"));
        assert_ne!(a, project_hash("/other"));
    }

    fn durable(tag: &str) -> (crate::db::TempDir, std::sync::Arc<crate::db::Db>, Telemetry) {
        let d = crate::db::TempDir::new(tag);
        let db = crate::db::Db::open(&d.0).unwrap();
        let t = Telemetry::with_store(Box::new(crate::storage::SqliteStore::new(db.clone())));
        (d, db, t)
    }

    #[test]
    fn a_flush_survives_a_restart_and_the_loss_window_is_what_was_not_flushed() {
        let (d, db, t) = durable("tel-restart");
        t.record_hook("Stop", Outcome::Allow, 80, 0);
        t.record_hook("Stop", Outcome::Advise, 120, 300);
        assert!(t.flush());
        t.record_hook("Stop", Outcome::Allow, 80, 0); // recorded after the last flush: the crash window
        db.close();
        drop(t); // the process "dies" here without a final flush, like kill -9
        let db2 = crate::db::Db::open(&d.0).unwrap();
        let t2 = Telemetry::with_store(Box::new(crate::storage::SqliteStore::new(db2)));
        let s = t2.telemetry_json("summary", "1d", "", 10);
        assert_eq!(s["invocations"], 2, "everything up to the last flush is there, and the unflushed one is not: {s}");
        assert_eq!(s["injected_bytes"], 300);
        assert_eq!(s["by_outcome"]["advise"], 1);
        // a clean shutdown flushes first, so nothing is lost
        t2.record_hook("Stop", Outcome::Allow, 10, 0);
        assert!(t2.flush());
        assert_eq!(t2.telemetry_json("summary", "1d", "", 10)["invocations"], 3);
        assert!(t2.flush(), "flushing with nothing new is a no-op");
        assert_eq!(t2.telemetry_json("summary", "1d", "", 10)["invocations"], 3, "and does not count anything twice");
    }

    #[test]
    fn without_a_database_telemetry_stays_in_memory_and_says_so() {
        let t = Telemetry::new();
        t.record_hook("Stop", Outcome::Allow, 80, 0);
        assert!(!t.flush(), "nothing could be stored");
        let s = t.telemetry_json("summary", "1d", "", 10);
        assert_eq!((s["invocations"].as_u64(), s["persisted"].as_bool()), (Some(1), Some(false)), "the live report still sees it");
    }

    #[test]
    fn routing_events_flow_to_the_ledger_the_flush_and_the_net_report() {
        use event::{Extras, Route, RouteOutcome, Spawn, Token, Usage};
        let (_d, _db, t) = durable("tel-route");
        let tk = |s: &str| Token::new(s).unwrap();
        let now = now_ms();
        let route = Event {
            ts_ms: now,
            kind: Kind::Route,
            h: tk("model-routing"),
            e: tk("PreToolUse"),
            o: Outcome::Advise,
            ms: 1,
            ib: 200,
            extras: Extras::Route(Route {
                requested_model: tk("opus"),
                parent_model: tk("opus"),
                task_class: tk("mechanical"),
                recommended_tier: tk("haiku"),
                selected_model: tk("haiku"),
                outcome: RouteOutcome::Down,
                spawn_key: tk("key1"),
            }),
        };
        t.route(route.clone(), "p");
        let spawn = Event {
            kind: Kind::Spawn,
            ts_ms: now + 5,
            extras: Extras::Spawn(Spawn {
                spawn_key: tk("key1"),
                actual_model: tk("haiku"),
                usage: Usage { input: 10, output: 5, cache_read: 0, cache_write: 0 },
            }),
            ..route
        };
        t.event(spawn);
        t.flush();
        let imp = t.impact_json_in(&ImpactFilter::default(), 10, "7d");
        assert_eq!(imp["by_kind"]["route"], 1, "the decision is in the impact ledger: {imp}");
        let r = &imp["net"]["routing"];
        assert_eq!((r["decisions"].as_u64(), r["linked_spawns"].as_u64()), (Some(1), Some(1)), "the spawn result joined by key: {imp}");
        // the shipped price table has no verified prices yet, so the join is reported but no dollar figure is invented
        assert_eq!(r["unpriced_spawns"], 1);
        assert!(imp["net"]["net_usd"].is_null());
        assert_eq!(imp["net"]["label"], "estimate");
        let ev = t.telemetry_json("events", "7d", "route", 10);
        assert_eq!(ev["count"], 1);
        assert_eq!(ev["events"][0]["requested_model"], "opus");
    }

    #[test]
    fn rule_hits_map_to_impact_kinds() {
        let t = Telemetry::new();
        t.observe_rule("r1", Action::Deny, "p");
        t.observe_rule("r2", Action::Warn, "p");
        t.observe_rule("r3", Action::Context, "p");
        let imp = t.impact_json(&ImpactFilter::default(), 10);
        assert_eq!(imp["by_kind"]["block"], 1);
        assert_eq!(imp["by_kind"]["warning"], 1);
        assert_eq!(imp["by_kind"]["context"], 1);
    }
}
