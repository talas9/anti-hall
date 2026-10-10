//! The resident daemon: one per socket, guarded by an flock'd lock file next to it.
//!
//! Requests (one per connection; the client half-closes after writing), replies are always framed
//! (`frame.rs`):
//!   hook:     `V <client-version>\n<raw hook JSON>`  -> OK <hook output JSON, "" = nothing to say> | ERR | BUSY
//!   control:  `CTL ping|reload|stop|status`           -> OK
//!   project:  `P <cwd>\n<verb> <args>`                -> OK `<value>` | ERR   (state partitioned by project)
//!   dispatch: `D <client-version>\n<meta>\n<payload>`   -> OK `<check answers>` | ERR | BUSY   (D58)
//! A hook request from a NEWER client makes this daemon answer, drain queued connections, then exit,
//! so the client's next call cold-starts the new build.
//!
//! Threads: the accept loop (poll, no busy wait), `workers` request threads fed by a bounded queue
//! (overflow = BUSY), and a watchdog (heartbeats + RSS check) that turns a stall into a clean drain+exit.
use crate::config::Config;
use crate::defaults;
use crate::frame::{self, Kind};
use crate::health;
use crate::limits::{self, Buckets};
use crate::paths;
use crate::rules::RuleSet;
use crate::store::{KeyCache, Store};
use crate::telemetry::{self, Telemetry};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Condvar, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime};

static HUP: AtomicBool = AtomicBool::new(false);
static TERM: AtomicBool = AtomicBool::new(false);
extern "C" fn on_hup(_: libc::c_int) {
    HUP.store(true, SeqCst);
}
extern "C" fn on_term(_: libc::c_int) {
    TERM.store(true, SeqCst);
}

/// What to do after replying.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum After {
    /// Keep serving.
    Continue,
    /// Drain the queue and exit (handoff to a newer build, or a stop request).
    Exit,
}

/// What the daemon answers: the frame kind plus its body.
#[derive(Debug, PartialEq, Eq)]
pub enum Reply {
    /// Success; the body is the answer (empty means nothing to say).
    Ok(String),
    /// Shed under load; the client falls back to the Node hook.
    Busy,
    /// The request could not be evaluated; the client falls back to the Node hook.
    Err(String),
}

impl Reply {
    /// Encode as a length-framed, checksummed reply.
    pub fn frame(&self) -> Vec<u8> {
        match self {
            Reply::Ok(b) => frame::encode(Kind::Ok, b),
            Reply::Busy => frame::encode(Kind::Busy, ""),
            Reply::Err(b) => frame::encode(Kind::Err, b),
        }
    }
}

/// Counters surfaced by `status`.
#[derive(Default)]
pub struct Stats {
    /// Requests handled.
    pub requests: AtomicU64,
    /// Requests answered BUSY.
    pub busy: AtomicU64,
    /// Requests answered ERR.
    pub errors: AtomicU64,
    /// Evaluations cut off by the CPU budget.
    pub budget_trips: AtomicU64,
    /// Handler panics contained.
    pub panics: AtomicU64,
    /// Connections dropped because the peer uid was not ours.
    pub rejected: AtomicU64,
}

/// Everything the request handler and the threads share.
pub struct Shared {
    /// The active config (D18): files layered over the shipped defaults, swapped atomically when they change.
    pub config: crate::cfgstore::ConfigStore,
    /// This build's version string, compared with each client's for handoff.
    pub own: String,
    /// The active rule set; swapped whole on reload, so a request sees one consistent set.
    pub rules: RwLock<Arc<RuleSet>>,
    rules_path: Mutex<std::path::PathBuf>,
    seen: Mutex<Option<(SystemTime, u64)>>,
    sessions: Mutex<Buckets>,
    projects: Mutex<Buckets>,
    store: Store,
    keys: Mutex<KeyCache>,
    /// Counters.
    pub stats: Stats,
    queue: Mutex<VecDeque<(UnixStream, Instant, u64)>>,
    /// Request load per minute (waits, in-flight, p95, sessions): does a call ever wait for another?
    pub load: crate::load::Load,
    cv: Condvar,
    /// Connections currently queued.
    pub depth: AtomicUsize,
    started: Instant,
    /// Result of applying the memory rlimit, for `status`.
    pub rlimit: String,
    /// True once the daemon stopped taking new clients.
    pub draining: AtomicBool,
    /// The exit timer of a clean drain (`daemon.drain_max_ms`) is armed.
    drain_timer: AtomicBool,
    /// The drain reached the database close (everything queued is being committed): the exit timers wait for it.
    db_closing: AtomicBool,
    /// The database close finished.
    db_closed: AtomicBool,
    /// The exit timer of a forced drain (`daemon.drain_grace_ms`) is armed.
    forced_timer: AtomicBool,
    /// ms since `started` at the last accept-loop iteration
    loop_beat: AtomicU64,
    /// per worker: 0 = idle, else (ms since `started`) + 1 at its last progress on the current request (picked up, a check
    /// started or finished, the interpreter ran: [`crate::deadline::beat`]); the watchdog's stuck rule measures from it
    busy_since: Vec<Arc<AtomicU64>>,
    stall_ms: AtomicU64,
    /// Last sampled resident set, KB.
    pub rss_kb: AtomicU64,
    /// Highest sampled resident set since start, KB.
    pub rss_peak_kb: AtomicU64,
    /// ms since `started` when the last request was handled (idle exit, D7, compares against it).
    last_request: AtomicU64,
    /// Metrics and the impact ledger (D51, D52).
    pub telemetry: Telemetry,
    starts: u64,
    /// The databases, when they opened (D19); hooks never depend on them.
    pub db: Option<Arc<crate::db::Db>>,
    /// `ok`, or the error code that kept storage from opening, for `status`.
    pub storage: String,
    /// The scheduler, once `serve` started it (D33).
    pub sched: std::sync::OnceLock<Arc<crate::schedule::Scheduler>>,
}

/// The value of `name=<value>` in a space-separated argument string (empty when absent).
fn kv(args: &str, name: &str) -> String {
    args.split_whitespace().find_map(|w| w.strip_prefix(name).and_then(|r| r.strip_prefix('='))).unwrap_or("").to_string()
}

fn lk<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Shared {
    /// Build the shared state for a daemon with these limits, rules and rules-file path.
    pub fn new(cfg: Config, own: &str, rules: RuleSet, rules_path: std::path::PathBuf) -> Shared {
        let workers = cfg.workers;
        Shared {
            sessions: Mutex::new(Buckets::new(cfg.session_rps, cfg.session_burst)),
            projects: Mutex::new(Buckets::new(cfg.project_rps, cfg.project_burst)),
            config: crate::cfgstore::ConfigStore::fixed(cfg),
            own: own.to_string(),
            rules: RwLock::new(Arc::new(rules)),
            seen: Mutex::new(mtime(&rules_path)),
            rules_path: Mutex::new(rules_path),
            store: Store::new(None),
            keys: Mutex::new(KeyCache::default()),
            stats: Stats::default(),
            queue: Mutex::new(VecDeque::new()),
            load: crate::load::Load::new(),
            cv: Condvar::new(),
            depth: AtomicUsize::new(0),
            started: Instant::now(),
            rlimit: "off".into(),
            draining: AtomicBool::new(false),
            drain_timer: AtomicBool::new(false),
            db_closing: AtomicBool::new(false),
            db_closed: AtomicBool::new(false),
            forced_timer: AtomicBool::new(false),
            loop_beat: AtomicU64::new(0),
            busy_since: (0..workers).map(|_| Arc::new(AtomicU64::new(0))).collect(),
            stall_ms: AtomicU64::new(0),
            rss_kb: AtomicU64::new(0),
            rss_peak_kb: AtomicU64::new(0),
            last_request: AtomicU64::new(0),
            telemetry: Telemetry::new(),
            starts: 0,
            db: None,
            storage: defaults::text("msg.storage_off").to_string(),
            sched: std::sync::OnceLock::new(),
        }
    }

    /// The active config snapshot. A request takes it once and uses it throughout, so it sees one version entirely.
    pub fn cfg(&self) -> Arc<crate::cfgstore::Snapshot> {
        self.config.snapshot()
    }

    /// Re-read the config files (`ctl reload`, or the watcher once a change has settled) and apply new rate limits.
    fn reload_config(&self) -> crate::cfgstore::Reload {
        let r = self.config.reload();
        self.sync_limits();
        r
    }

    /// Give the rate-limit buckets the active config's rates.
    fn sync_limits(&self) {
        let c = self.cfg();
        lk(&self.sessions).set_rate(c.session_rps, c.session_burst);
        lk(&self.projects).set_rate(c.project_rps, c.project_burst);
        self.telemetry.set_enabled(c.effective.boolean("telemetry.enabled"));
    }

    /// Keep impact events (and, through later layers, project state) in `db` instead of memory.
    pub fn attach_db(&mut self, db: Arc<crate::db::Db>) {
        self.telemetry = Telemetry::with_store(Box::new(crate::storage::SqliteStore::new(db.clone())));
        self.telemetry.restore_metrics(); // counters and histograms continue from the last snapshot (D51)
        self.sync_limits(); // telemetry.enabled from the active config
        self.storage = defaults::text("msg.storage_ok").to_string();
        self.store = Store::new(Some(db.clone()));
        self.db = Some(db);
    }

    fn ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    /// The `metrics` control verb: `check=<name>` narrows to one check's series; `rollup=<resolution>` (with
    /// `since=<seconds>`) returns stored rollups instead. Live gauges are refreshed first.
    fn metrics_json(&self, args: &str) -> serde_json::Value {
        let rollup = kv(args, "rollup");
        if !rollup.is_empty() {
            let since_s: u64 = kv(args, "since").parse().unwrap_or(0);
            let since = if since_s == 0 { 0 } else { health::now_ms().saturating_sub(since_s.saturating_mul(1000)) };
            return self.telemetry.rollups_json(&rollup, since);
        }
        let check = kv(args, "check");
        let mut gauges =
            vec![("rss_kb", limits::rss_kb() as f64), ("queue_depth", self.depth.load(SeqCst) as f64), ("uptime_s", self.started.elapsed().as_secs() as f64)];
        let gs = crate::gate::global().stats();
        gauges.extend([
            ("inject_gate_sessions", gs.sessions as f64),
            ("inject_gate_slots", gs.slots as f64),
            ("inject_gate_bytes", gs.bytes as f64),
            ("inject_gate_evictions", gs.evictions as f64),
        ]);
        if let Some(db) = &self.db {
            let t = lk(&db.mem.kv);
            gauges.extend([
                ("tier_items", t.len() as f64),
                ("tier_bytes", t.bytes() as f64),
                ("tier_hits", t.hits as f64),
                ("tier_misses", t.misses as f64),
                ("tier_evictions", t.evictions as f64),
                ("tier_expired", t.expired as f64),
                ("bus_published", db.mem.bus.published.load(SeqCst) as f64),
                ("bus_dropped", db.mem.bus.dropped.load(SeqCst) as f64),
                ("db_commits", db.mem.commits.load(SeqCst) as f64),
                ("db_writes", db.mem.writes.load(SeqCst) as f64),
            ]);
            drop(t);
            let sizes = crate::maintain::sizes(db.dir());
            let size = |k: &str| sizes[k].as_u64().unwrap_or(0) as f64;
            let (runs, last) = db.read(|c| Ok(crate::maintain::stats(c))).unwrap_or((0, 0));
            gauges.extend([
                ("db_hot_bytes", size("hot_bytes")),
                ("db_hot_wal_bytes", size("hot_wal_bytes")),
                ("db_archive_bytes", size("archive_bytes")),
                ("db_archive_wal_bytes", size("archive_wal_bytes")),
                ("maintain_runs", runs as f64),
                ("maintain_last_ms", last as f64),
            ]);
        }
        self.telemetry.metrics_json(&check, &gauges)
    }

    /// The `impact` control verb: `kind=<kind>`, `project=<hash>`, `recent=<n>`.
    fn impact_json(&self, args: &str) -> serde_json::Value {
        let filter = crate::storage::ImpactFilter { kind: kv(args, "kind"), project: kv(args, "project") };
        let recent = kv(args, "recent").parse().unwrap_or(defaults::num("telemetry.recent_default") as usize);
        self.telemetry.impact_json_in(&filter, recent, &kv(args, "window"))
    }

    /// The `telemetry` control verb: `summary` or `events [kind=<k>] [limit=<n>]`, each with `window=<7d>`.
    fn telemetry_json(&self, args: &str) -> serde_json::Value {
        let sub = args.split_whitespace().next().unwrap_or("summary");
        let limit = kv(args, "limit").parse().unwrap_or(defaults::num("telemetry.recent_default") as usize);
        self.telemetry.telemetry_json(sub, &kv(args, "window"), &kv(args, "kind"), limit)
    }

    /// Re-read the rules file; a file that fails to parse keeps the previous rules.
    fn reload(&self) {
        let path = lk(&self.rules_path).clone();
        if let Ok(r) = RuleSet::load(&path) {
            *self.rules.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(r);
        }
        *lk(&self.seen) = mtime(&path);
    }

    /// The memory breakdown: the live heap against RSS, and the size of every long-lived in-memory structure, so a growing
    /// one is named by `status --memory` and by the line logged when the RSS cap trips. The peak is the highest live heap
    /// since the previous report.
    pub fn memory(&self) -> serde_json::Value {
        let heap = crate::memstat::heap();
        crate::memstat::reset_peak();
        serde_json::json!({
            "rss_kb": limits::rss_kb(),
            "footprint_kb": limits::footprint_kb(),
            "mem_metric": defaults::text("daemon.mem_metric"),
            "mem_kb": limits::mem_kb(),
            "heap_live_kb": heap.live / 1024,
            "heap_peak_kb": heap.peak / 1024,
            "allocs": heap.allocs,
            "components": {
                "guard_state_entries": crate::checks::guardkit::state::entries(),
                "hookcfg_session_counters": crate::hookcfg::session::global().len(),
                "rate_buckets_sessions": lk(&self.sessions).len(),
                "rate_buckets_projects": lk(&self.projects).len(),
                "project_key_cache": lk(&self.keys).len(),
                "jev_lanes": crate::jev::shared::lane_count(),
                "queued_connections": self.depth.load(SeqCst),
                "workers": self.busy_since.len(),
            },
        })
    }

    /// The memory breakdown as one short `key=value` line for the event log (which cuts a line at `health.event_text_max`).
    fn memory_line(&self) -> String {
        let m = self.memory();
        let mut parts: Vec<String> = ["rss_kb", "heap_live_kb", "heap_peak_kb", "allocs"].iter().map(|k| format!("{k}={}", m[k])).collect();
        if let Some(c) = m["components"].as_object() {
            parts.extend(c.iter().map(|(k, v)| format!("{k}={v}")));
        }
        parts.join(" ")
    }

    /// The `daemon` health snapshot event: resident set against its cap, restarts, the degraded flag, queue and worker load, and
    /// saturation. Numbers only (the fields are declared in `telemetry.fields`).
    pub fn health_event(&self) -> crate::telemetry::event::Event {
        let cfg = self.cfg();
        let load = self.load.report(health::now_ms());
        let degraded = health::summary()["degraded"].as_bool().unwrap_or(false);
        let busy = self.busy_since.iter().filter(|b| b.load(SeqCst) != 0).count() as u64;
        crate::telemetry::emit::daemon_snapshot(
            degraded,
            &[
                ("rss_kb", limits::rss_kb()),
                ("rss_cap_kb", cfg.rss_cap_kb),
                ("heap_live_kb", crate::memstat::heap().live / 1024),
                ("restarts", self.starts.saturating_sub(1)),
                ("queue_depth", self.depth.load(SeqCst) as u64),
                ("queue_cap", cfg.queue as u64),
                ("workers", cfg.workers as u64),
                ("busy", busy),
                ("saturated", u64::from(load["saturated"].as_bool().unwrap_or(false))),
                ("peak_in_flight", load["peak_in_flight"].as_u64().unwrap_or(0)),
                ("max_wait_us", load["max_wait_us"].as_u64().unwrap_or(0)),
            ],
        )
    }

    fn status(&self) -> String {
        let rss_now = limits::rss_kb();
        let rules = self.rules.read().unwrap_or_else(|e| e.into_inner()).clone();
        let cfg = self.cfg();
        let b = health::breaker_remaining();
        let c = health::crashloop_remaining();
        let gs = crate::gate::global().stats();
        serde_json::json!({
            "running": true,
            "pid": std::process::id(),
            "version": self.own,
            "uptime_s": self.started.elapsed().as_secs(),
            "rss_kb": rss_now,
            "footprint_kb": limits::footprint_kb(),
            "mem_metric": defaults::text("daemon.mem_metric"),
            "mem_kb": limits::mem_kb(),
            "rss_peak_kb": self.rss_peak_kb.fetch_max(rss_now, SeqCst).max(rss_now),
            "memory": self.memory(),
            "load": self.load.report(health::now_ms()),
            "health": health::summary(),
            "cpu_s": (limits::process_cpu_secs() * 1000.0).round() / 1000.0,
            "queue_depth": self.depth.load(SeqCst),
            "queue_cap": cfg.queue,
            "workers": cfg.workers,
            "requests": self.stats.requests.load(SeqCst),
            "busy_replies": self.stats.busy.load(SeqCst),
            "errors": self.stats.errors.load(SeqCst),
            "budget_trips": self.stats.budget_trips.load(SeqCst),
            "panics": self.stats.panics.load(SeqCst),
            "reply_write_errors": REPLY_WRITE_ERRORS.load(SeqCst),
            "accept_errors": ACCEPT_ERRORS.load(SeqCst),
            "slow_replies": SLOW_REPLIES.load(SeqCst),
            "rejected_peers": self.stats.rejected.load(SeqCst),
            "starts": self.starts,
            "restarts": self.starts.saturating_sub(1),
            "breaker": b.map_or("closed".to_string(), |d| defaults::render("msg.state_open", &[("secs", &(d.as_secs() + 1))])),
            "crashloop": c.map_or("clear".to_string(), |d| defaults::render("msg.state_stopped", &[("secs", &(d.as_secs() + 1))])),
            "rules": {"version": rules.version, "count": rules.rules.len(), "fingerprint": format!("{:016x}", rules.fingerprint())},
            "summary": self.telemetry.headline(),
            "mem_limit": self.rlimit,
            "storage": self.storage,
            "rss_cap_kb": cfg.rss_cap_kb,
            "inject_gate": {"sessions": gs.sessions, "slots": gs.slots, "bytes": gs.bytes, "evictions": gs.evictions,
                "max_sessions": defaults::num("inject_gate.max_sessions"), "max_slots": defaults::num("inject_gate.max_slots")},
            "config": {"version": cfg.version, "pending_restart": cfg.pending_restart, "last_error": cfg.last_error},
        })
        .to_string()
    }
}

/// Pure-ish request handler (no socket I/O) so it is unit-testable.
pub fn handle_request(req: &[u8], sh: &Shared) -> (Reply, After) {
    handle_request_with(req, sh, &sh.cfg())
}

/// `handle_request` under one config snapshot, so a request that spans several reads of the config sees a single version.
pub fn handle_request_with(req: &[u8], sh: &Shared, cfg: &crate::cfgstore::Snapshot) -> (Reply, After) {
    sh.stats.requests.fetch_add(1, SeqCst);
    sh.telemetry.request();
    sh.last_request.store(sh.ms(), SeqCst);
    let text = String::from_utf8_lossy(req);
    let (head, body) = text.split_once('\n').unwrap_or((&text, ""));
    if let Some(v) = head.strip_prefix("V ") {
        let (env, payload) = crate::reqenv::split_request(body);
        if let Some(root) = crate::bootstrap::ROOT_ENVS.iter().find_map(|n| env.get(n)) {
            sh.config.offer_root(root);
        }
        let reply = hook(payload, &env, sh, cfg);
        let newer = crate::version_cmp(v.trim(), &sh.own) == std::cmp::Ordering::Greater;
        return (reply, if newer { After::Exit } else { After::Continue });
    }
    if let Some(v) = head.strip_prefix("D ") {
        let reply = dispatch(body, sh);
        let newer = crate::version_cmp(v.trim(), &sh.own) == std::cmp::Ordering::Greater;
        return (reply, if newer { After::Exit } else { After::Continue });
    }
    if let Some(v) = head.strip_prefix("G ") {
        let reply = inject_gate(body, sh);
        let newer = crate::version_cmp(v.trim(), &sh.own) == std::cmp::Ordering::Greater;
        return (reply, if newer { After::Exit } else { After::Continue });
    }
    if let Some(cwd) = head.strip_prefix("P ") {
        return (project_op(cwd.trim(), body, sh), After::Continue);
    }
    let ctl = head.strip_prefix("CTL ").map(str::trim);
    let (verb, args) = ctl.map(|c| c.split_once(' ').unwrap_or((c, ""))).unwrap_or(("", ""));
    match ctl.map(|_| verb) {
        Some("metrics") => (Reply::Ok(sh.metrics_json(args).to_string()), After::Continue),
        Some("impact") => (Reply::Ok(sh.impact_json(args).to_string()), After::Continue),
        Some("schedule") => (Reply::Ok(schedule_ctl(sh, args).to_string()), After::Continue),
        Some("devswarm") => (Reply::Ok(crate::dswire::cli::ctl(args)), After::Continue),
        Some("gate") => (Reply::Ok(crate::gate::global().report().to_string()), After::Continue),
        Some("telemetry") => (Reply::Ok(sh.telemetry_json(args).to_string()), After::Continue),
        Some("ping") => (Reply::Ok(format!("pong {} {}", sh.own, std::process::id())), After::Continue),
        Some("reload") => {
            sh.reload();
            sh.reload_config();
            (Reply::Ok("ok".into()), After::Continue)
        }
        Some("config") => (Reply::Ok(sh.config.report().to_string()), After::Continue),
        Some("stop") => (Reply::Ok("ok".into()), After::Exit),
        Some("status") => (Reply::Ok(sh.status()), After::Continue),
        Some(_) if cfg.test_hooks => test_verb(ctl.unwrap_or(""), sh),
        _ => (Reply::Err(defaults::text("msg.reply_unknown_request").into()), After::Continue),
    }
}

/// Verbs that exist only to test the watchdog and panic containment (`AH_ENGINE_TEST_HOOKS=1`).
fn test_verb(t: &str, sh: &Shared) -> (Reply, After) {
    let (verb, arg) = t.split_once(' ').unwrap_or((t, ""));
    let ms: u64 = arg.trim().parse().unwrap_or(0);
    match verb {
        "sleep" => std::thread::sleep(Duration::from_millis(ms)), // ms comes from the test caller, not a tunable
        "stall" => sh.stall_ms.store(ms, SeqCst),
        "panic" => panic!("{}", defaults::text("msg.reply_test_panic")),
        _ => return (Reply::Err(defaults::text("msg.reply_unknown_request").into()), After::Continue),
    }
    (Reply::Ok("ok".into()), After::Continue)
}

fn project_key(sh: &Shared, cwd: &str) -> String {
    lk(&sh.keys).key(cwd)
}

/// Feeds what a hook evaluation did into the daemon's telemetry for one project.
struct DaemonObserver<'a> {
    t: &'a Telemetry,
    project: &'a str,
    /// The hook event being served (telemetry labels every check and rule with it).
    event: &'a str,
}

impl crate::hookio::Observer for DaemonObserver<'_> {
    fn check(&self, check: &str, rule_id: &str, verdict: &crate::checks::Verdict, micros: u64) {
        crate::memdiag::note_check(check);
        self.t.observe_check_in(self.event, check, rule_id, verdict, micros, self.project);
    }

    fn rule(&self, rule_id: &str, action: crate::rules::Action) {
        self.t.observe_rule_in(self.event, rule_id, action, self.project);
    }

    fn route(&self, check: &str, event: &str, route: &crate::checks::RouteMeta) {
        use crate::telemetry::event::{Delegate, Event, Extras, Kind, Outcome, Route, RouteOutcome, Token};
        let outcome = if route.delegate { RouteOutcome::Deny } else { RouteOutcome::parse(&route.outcome).unwrap_or(RouteOutcome::Advise) };
        let ev = Event {
            ts_ms: crate::health::now_ms(),
            kind: Kind::Route,
            h: Token::sanitize(check),
            e: Token::sanitize(event),
            o: if route.delegate || route.blocked {
                Outcome::Block
            } else if outcome == RouteOutcome::Allow {
                Outcome::Allow
            } else {
                Outcome::Advise
            },
            ms: 0,
            ib: 0,
            extras: Extras::Route(Route {
                requested_model: Token::sanitize(&route.requested_model),
                parent_model: Token::sanitize(&route.parent_model),
                task_class: Token::sanitize(&route.task_class),
                recommended_tier: Token::sanitize(&route.recommended_tier),
                selected_model: Token::sanitize(&route.selected_model),
                outcome,
                spawn_key: Token::sanitize(&route.spawn_key),
            }),
        };
        self.t.route(ev, self.project);
        if route.delegate {
            self.t.event(Event {
                ts_ms: crate::health::now_ms(),
                kind: Kind::Delegate,
                h: Token::sanitize(check),
                e: Token::sanitize(event),
                o: Outcome::Block,
                ms: 0,
                ib: 0,
                extras: Extras::Delegate(Delegate {
                    spawn_key: Token::sanitize(&route.spawn_key),
                    requested_model: Token::sanitize(&route.requested_model),
                    selected_model: Token::sanitize(&route.selected_model),
                    task_class: Token::sanitize(&route.task_class),
                }),
            });
        }
    }
}

/// How a hook reply ended for telemetry (D78): its outcome and the bytes it injects into model context. A block injects
/// nothing the model reads as context; an advisory, warning or context reply injects its whole body.
fn reply_outcome(r: &Reply) -> (crate::telemetry::event::Outcome, u64) {
    use crate::telemetry::event::Outcome;
    match r {
        Reply::Busy => (Outcome::Skip, 0),
        Reply::Err(_) => (Outcome::Defer, 0),
        Reply::Ok(out) if out.is_empty() => (Outcome::Allow, 0),
        Reply::Ok(out) if out.starts_with(crate::hookio::EXIT2) => (Outcome::Block, 0),
        Reply::Ok(out) => {
            let v: serde_json::Value = serde_json::from_str(out).unwrap_or_default();
            let denied = v.pointer("/hookSpecificOutput/permissionDecision").and_then(|d| d.as_str()) == Some("deny")
                || v.get("decision").and_then(|d| d.as_str()) == Some("block");
            if denied { (Outcome::Block, 0) } else { (Outcome::Advise, out.len() as u64) }
        }
    }
}

fn hook(body: &str, env: &crate::reqenv::RequestEnv, sh: &Shared, cfg: &Config) -> Reply {
    let started = Instant::now();
    let Ok(p) = serde_json::from_str::<serde_json::Value>(body) else {
        sh.stats.errors.fetch_add(1, SeqCst);
        sh.telemetry.with_metrics(|m| m.inc("errors", &[]));
        sh.telemetry.fallback("malformed", "");
        sh.telemetry.record_hook(defaults::text("telemetry.no_event_label"), crate::telemetry::event::Outcome::Error, started.elapsed().as_micros() as u64, 0);
        return Reply::Err(defaults::text("msg.reply_malformed").into());
    };
    let session = p.get("session_id").and_then(|v| v.as_str()).unwrap_or("-");
    crate::load::note_request(crate::hookio::event_of(&p).unwrap_or(""), p.get("session_id").and_then(|v| v.as_str()));
    crate::memdiag::note_payload(&p);
    let pkey = project_key(sh, p.get("cwd").and_then(|v| v.as_str()).unwrap_or("/"));
    let phash = telemetry::project_hash(&pkey);
    crate::ghrt::note_cwd(&sh.config.snapshot().effective, p.get("cwd").and_then(|v| v.as_str()).unwrap_or(""));
    if !lk(&sh.sessions).allow(session) || !lk(&sh.projects).allow(&pkey) {
        sh.stats.busy.fetch_add(1, SeqCst);
        sh.telemetry.with_metrics(|m| m.inc("busy_replies", &[]));
        sh.telemetry.fallback("busy", &phash);
        sh.telemetry.record_hook(
            crate::hookio::event_of(&p).unwrap_or(defaults::text("telemetry.no_event_label")),
            crate::telemetry::event::Outcome::Skip,
            started.elapsed().as_micros() as u64,
            0,
        );
        return Reply::Busy;
    }
    let rules = sh.rules.read().unwrap_or_else(|e| e.into_inner()).clone();
    let (start, budget) = (limits::thread_cpu_us(), cfg.eval_budget_us);
    let over = move || budget > 0 && limits::thread_cpu_us().saturating_sub(start) > budget;
    let event = crate::hookio::event_of(&p).unwrap_or(defaults::text("telemetry.no_event_label"));
    let obs = DaemonObserver { t: &sh.telemetry, project: &phash, event };
    let reply = match crate::hookio::respond_observed(&p, &rules, &over, &obs, env) {
        Ok(out) if out == crate::hookio::FALLBACK => Reply::Err(defaults::text("msg.reply_defer").into()),
        Ok(out) => Reply::Ok(out),
        Err(_) => {
            sh.stats.budget_trips.fetch_add(1, SeqCst);
            sh.telemetry.with_metrics(|m| m.inc("budget_trips", &[]));
            sh.telemetry.fallback("budget", &phash);
            health::log_event("budget", "-", defaults::text("msg.log_budget"));
            Reply::Err(defaults::text("msg.reply_budget").into())
        }
    };
    let micros = started.elapsed().as_micros() as u64;
    sh.telemetry.observe_hook(crate::hookio::event_of(&p).unwrap_or(""), micros);
    let (outcome, injected) = reply_outcome(&reply);
    sh.telemetry.record_hook(event, outcome, micros, injected);
    reply
}

/// `D <client-version>\n<meta JSON>\n<payload>`: the built-in checks of one event's dispatch table (D58), under the
/// same rate limits and telemetry as a hook request. The reply lists each check's answer; the client runs the rest.
fn dispatch(body: &str, sh: &Shared) -> Reply {
    let started = Instant::now();
    let (meta, raw) = body.split_once('\n').unwrap_or((body, ""));
    let (Ok(meta), Ok(p)) = (serde_json::from_str::<crate::dispatch::native::Meta>(meta), serde_json::from_str::<serde_json::Value>(raw)) else {
        sh.stats.errors.fetch_add(1, SeqCst);
        sh.telemetry.with_metrics(|m| m.inc("errors", &[]));
        sh.telemetry.fallback("malformed", "");
        return Reply::Err(defaults::text("msg.reply_malformed").into());
    };
    if let Some(root) = meta.root.as_deref() {
        sh.config.offer_root(root);
    }
    if let Some(ms) = meta.deadline_ms {
        crate::deadline::client_deadline(ms);
    }
    let session = p.get("session_id").and_then(|v| v.as_str()).unwrap_or("-");
    crate::load::note_request(&meta.event, p.get("session_id").and_then(|v| v.as_str()));
    crate::memdiag::note_payload(&p);
    let pkey = project_key(sh, p.get("cwd").and_then(|v| v.as_str()).unwrap_or("/"));
    let phash = telemetry::project_hash(&pkey);
    crate::ghrt::note_cwd(&sh.config.snapshot().effective, p.get("cwd").and_then(|v| v.as_str()).unwrap_or(""));
    if !lk(&sh.sessions).allow(session) || !lk(&sh.projects).allow(&pkey) {
        sh.stats.busy.fetch_add(1, SeqCst);
        sh.telemetry.with_metrics(|m| m.inc("busy_replies", &[]));
        sh.telemetry.fallback("busy", &phash);
        return Reply::Busy;
    }
    // D87: what the client's plan did to each entry (ran, skipped by predicate or cap or budget, shadowed, off), by event and entry
    sh.telemetry.with_metrics(|m| {
        for (id, outcome) in &meta.plan {
            let cfg = if meta.cfg.is_empty() { defaults::text("hooks.cfg_default_label") } else { meta.cfg.as_str() };
            m.inc("dispatch_entries", &[("event", meta.event.as_str()), ("entry", id.as_str()), ("outcome", outcome.as_str()), ("cfg", cfg)]);
        }
    });
    let observe = |e: &crate::dispatch::table::Entry, a: &crate::dispatch::native::Answer, micros: u64| {
        use crate::checks::Verdict;
        use crate::dispatch::native::Answer;
        let check = e.check.as_deref().unwrap_or("");
        let v = match a {
            Answer::Defer => Verdict::Defer,
            // a block is exit 2, or exit 0 with a blocking JSON decision (the Stop guards answer that way)
            Answer::Decided(r, routes) if r.code == Some(2) || (r.code == Some(0) && crate::dispatch::combine::json_blocks(&r.out)) => {
                Verdict::Routed(Box::new(Verdict::Block(r.err.trim_end().to_string())), routes.clone())
            }
            Answer::Decided(r, routes) if !r.out.is_empty() => Verdict::Routed(Box::new(Verdict::Advisory(r.out.trim_end().to_string())), routes.clone()),
            Answer::Decided(_, routes) => Verdict::Routed(Box::new(Verdict::Allow), routes.clone()),
        };
        if let Verdict::Routed(_, routes) = &v {
            let obs = DaemonObserver { t: &sh.telemetry, project: &phash, event: &meta.event };
            for r in routes {
                crate::hookio::Observer::route(&obs, check, &meta.event, r);
            }
        }
        let answer = if v == Verdict::Defer { "defer" } else { "decided" };
        sh.telemetry.with_metrics(|m| m.inc("dispatch_checks", &[("event", meta.event.as_str()), ("check", check), ("answer", answer)]));
        crate::memdiag::note_check(check);
        sh.telemetry.observe_check(check, &e.id, &v, micros, &phash);
    };
    let answers = crate::dispatch::native::evaluate(&meta, &p, &observe);
    sh.telemetry.observe_hook(&meta.event, started.elapsed().as_micros() as u64);
    Reply::Ok(crate::dispatch::native::encode(&answers))
}

/// `G <version>\n{"s":session,"a":agent,"r":reset,"q":[question, ...]}`: the injection gate (`crate::gate`). Each question is
/// answered with one word (pass on, drop, or keepalive), and what was passed on and kept out is counted by cut. A request that
/// cannot be read is answered ERR, which the client reads as "pass everything on".
fn inject_gate(body: &str, sh: &Shared) -> Reply {
    use crate::gate::Decision;
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        sh.stats.errors.fetch_add(1, SeqCst);
        return Reply::Err(defaults::text("msg.reply_malformed").into());
    };
    let sid = v.get("s").and_then(|x| x.as_str()).unwrap_or("");
    let agent = v.get("a").and_then(|x| x.as_str()).unwrap_or("");
    let gate = crate::gate::global();
    if v.get("r").and_then(|x| x.as_bool()).unwrap_or(false) {
        gate.reset(sid);
    }
    let qs: Option<Vec<crate::gate::Query>> = v.get("q").and_then(|x| x.as_array()).map(|a| a.iter().filter_map(crate::dispatch::inject::read_query).collect());
    let Some(qs) = qs else { return Reply::Err(defaults::text("msg.reply_malformed").into()) };
    let decisions: Vec<Decision> = qs.iter().map(|q| gate.decide(sid, agent, q)).collect();
    sh.telemetry.with_metrics(|m| {
        for (q, d) in qs.iter().zip(&decisions) {
            let l = [("cut", q.cut.as_str())];
            match d {
                Decision::Emit => {
                    m.inc("inject_emitted", &l);
                    m.add("inject_emitted_bytes", &l, q.len as u64);
                }
                Decision::Keepalive => {
                    m.inc("inject_keepalive", &l);
                    m.add("inject_emitted_bytes", &l, q.keep_len as u64);
                    m.add("inject_suppressed_bytes", &l, q.len.saturating_sub(q.keep_len) as u64);
                }
                Decision::Suppress => {
                    m.inc("inject_suppressed", &l);
                    m.add("inject_suppressed_bytes", &l, q.len as u64);
                }
            }
        }
    });
    Reply::Ok(crate::dispatch::inject::encode_reply(&decisions))
}

/// `P <cwd>\n[W <write-id>\n]<verb> <args>`: the partition is derived here from `cwd`; the request cannot name a key. The
/// optional write id makes a write idempotent, so a client may retry it or spool it (D24).
fn project_op(cwd: &str, body: &str, sh: &Shared) -> Reply {
    if cwd.is_empty() {
        return Reply::Err(defaults::text("msg.reply_missing_cwd").into());
    }
    let key = project_key(sh, cwd);
    if !lk(&sh.projects).allow(&key) {
        sh.stats.busy.fetch_add(1, SeqCst);
        sh.telemetry.with_metrics(|m| m.inc("busy_replies", &[]));
        return Reply::Busy;
    }
    let (write_id, body) = match body.strip_prefix("W ").and_then(|r| r.split_once('\n')) {
        Some((id, rest)) => (id.trim(), rest),
        None => ("", body),
    };
    let (verb, args) = body.trim_end_matches('\n').split_once(' ').unwrap_or((body.trim(), ""));
    if verb != "get" && verb != "len" {
        drain_spool(sh); // spooled writes are older than this one: apply them first, so order holds (D24)
    }
    match sh.store.op(&key, write_id, verb, args) {
        Ok(v) => Reply::Ok(v),
        Err(crate::error::DbError::Rejected(e)) => Reply::Err(e.to_string()),
        Err(_) => {
            // busy, timed out, or storage failing: the client may retry and spool it (the write id keeps it once)
            sh.stats.busy.fetch_add(1, SeqCst);
            sh.telemetry.with_metrics(|m| m.inc("busy_replies", &[]));
            Reply::Busy
        }
    }
}

/// Apply the spooled writes, in order, through the same store and write ids as live requests (D24).
pub fn drain_spool(sh: &Shared) -> crate::spool::Drained {
    use crate::error::DbError;
    use crate::spool::Applied;
    if sh.db.is_none() {
        return Default::default();
    }
    let r = crate::spool::drain(&crate::spool::path(), &mut |rec| {
        if !crate::spool::spoolable(&rec.verb) {
            return Applied::Refused(defaults::render("msg.err_unknown_verb", &[("verb", &rec.verb)]));
        }
        match sh.store.op(&project_key(sh, &rec.cwd), &rec.id, &rec.verb, &rec.args) {
            Ok(_) => Applied::Done,
            Err(DbError::Rejected(e)) => Applied::Refused(e.to_string()),
            Err(_) => Applied::Later,
        }
    });
    if r.applied + r.quarantined > 0 {
        sh.telemetry.with_metrics(|m| {
            m.add("spool_applied", &[], r.applied as u64);
            m.add("spool_quarantined", &[], r.quarantined as u64);
        });
    }
    r
}

/// Read a whole request within `read_deadline` and `max` bytes.
fn read_request(s: &mut UnixStream, cfg: &Config) -> Result<Vec<u8>, &'static str> {
    s.set_read_timeout(Some(defaults::millis("daemon.read_poll_ms"))).ok();
    let start = Instant::now();
    let (mut buf, mut chunk) = (Vec::new(), vec![0u8; defaults::num("io.small_chunk_bytes") as usize]);
    loop {
        if start.elapsed() > cfg.read_deadline {
            return Err(defaults::text("msg.reply_read_deadline"));
        }
        match s.read(&mut chunk) {
            Ok(0) => return Ok(buf),
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() as u64 > cfg.max_request {
                    return Err(defaults::text("msg.reply_too_large"));
                }
            }
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted) => continue,
            Err(_) => return Err(defaults::text("msg.reply_read_error")),
        }
    }
}

/// Write the reply; false when it could not be written (the client is gone or stopped reading).
fn write_reply(s: &mut UnixStream, r: &Reply, cfg: &Config) -> bool {
    if let Err(e) = s.set_write_timeout(Some(cfg.write_deadline)) {
        health::log_event("reply", "set_timeout", &e.to_string());
    }
    // A failed write means the client sees a cut frame and falls back to Node (it never mistakes it for an answer); the
    // cause is logged here so a pattern of them is visible, and `reply_write_errors` counts them.
    if let Err(e) = s.write_all(&r.frame()) {
        REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
        health::log_event("reply", "write_failed", &e.to_string());
        return false;
    }
    true
}

/// Replies finished after their client's deadline had passed (slow but healthy; counted apart from failures).
pub static SLOW_REPLIES: AtomicU64 = AtomicU64::new(0);

/// Replies the daemon could not write to their client (the client then falls back to Node).
pub static REPLY_WRITE_ERRORS: AtomicU64 = AtomicU64::new(0);

fn serve_conn(mut s: UnixStream, sh: &Shared, wait: Duration, in_flight: u64) -> After {
    s.set_nonblocking(false).ok();
    let started = Instant::now();
    crate::load::take_scan();
    crate::load::take_request();
    let cfg = sh.cfg();
    // the client stops waiting `client.deadline_ms` after it sent the request, which is about when it was accepted
    crate::deadline::begin(started.checked_sub(wait).unwrap_or(started));
    let req = match read_request(&mut s, &cfg) {
        Ok(r) => r,
        Err(why) => {
            sh.stats.errors.fetch_add(1, SeqCst);
            sh.telemetry.with_metrics(|m| m.inc("errors", &[]));
            write_reply(&mut s, &Reply::Err(why.into()), &cfg);
            crate::deadline::end();
            return After::Continue;
        }
    };
    telemetry::stage_begin();
    let mem_before = crate::memdiag::begin(cfg.effective.boolean("diagnostics.mem_log"));
    let (reply, after) = match catch_unwind(AssertUnwindSafe(|| handle_request_with(&req, sh, &cfg))) {
        Ok(r) => r,
        Err(_) => {
            sh.stats.panics.fetch_add(1, SeqCst);
            sh.telemetry.with_metrics(|m| m.inc("panics", &[]));
            health::log_event("panic", "panic", defaults::text("msg.log_panic"));
            health::record_failure("panic", "panic", defaults::text("msg.log_panic"));
            (Reply::Err(defaults::text("msg.reply_internal").into()), After::Continue)
        }
    };
    let mem_after = mem_before.is_some().then(crate::memdiag::measure_after);
    let late = crate::deadline::remaining() == Some(Duration::ZERO);
    let delivered = write_reply(&mut s, &reply, &cfg);
    if delivered {
        sh.telemetry.stage_commit();
    } else {
        // the client never read it: what the request recorded is not a decision anyone saw (review finding 4)
        telemetry::stage_discard();
    }
    crate::deadline::settle_staged(delivered);
    if late {
        // answered after the client's deadline: slow but healthy, which is not a failure of the engine
        SLOW_REPLIES.fetch_add(1, SeqCst);
        sh.telemetry.with_metrics(|m| m.inc("slow_replies", &[]));
    }
    crate::deadline::end();
    let (event, session) = crate::load::take_request();
    if let (Some(before), Some(after_m)) = (mem_before, mem_after) {
        let kind = req.split(|b| *b == b' ' || *b == b'\n').next().map(|k| String::from_utf8_lossy(k).into_owned()).unwrap_or_default();
        crate::memdiag::finish(
            before,
            &crate::memdiag::Done {
                kind,
                event: event.clone(),
                in_flight,
                busy: sh.busy_since.iter().filter(|b| b.load(SeqCst) != 0).count() as u64,
                proc_ms: started.elapsed().as_millis() as u64,
                after: after_m,
            },
        );
    }
    sh.load.record(&crate::load::Sample {
        at_ms: health::now_ms(),
        wait_us: wait.as_micros() as u64,
        proc_us: started.elapsed().as_micros() as u64,
        in_flight,
        event,
        session,
        scan_bytes: crate::load::take_scan(),
    });
    after
}

fn worker(sh: Arc<Shared>, idx: usize) {
    crate::deadline::set_beat(sh.busy_since[idx].clone(), sh.started);
    loop {
        let conn = {
            let mut q = lk(&sh.queue);
            loop {
                if let Some((c, queued_at, in_flight)) = q.pop_front() {
                    sh.depth.fetch_sub(1, SeqCst);
                    break Some((c, queued_at.elapsed(), in_flight));
                }
                let (g, _) = sh.cv.wait_timeout(q, defaults::millis("daemon.worker_wait_ms")).unwrap_or_else(|e| e.into_inner());
                q = g;
                if q.is_empty() {
                    break None;
                }
            }
        };
        let Some((conn, wait, in_flight)) = conn else {
            crate::memdiag::worker_tick(idx);
            continue;
        };
        sh.busy_since[idx].store(sh.ms() + 1, SeqCst);
        let after = serve_conn(conn, &sh, wait, in_flight);
        sh.busy_since[idx].store(0, SeqCst);
        crate::memdiag::worker_tick(idx);
        if after == After::Exit {
            begin_drain(&sh, defaults::text("msg.exit_reason_handoff"), false);
        }
    }
}

/// Stop taking new clients (unlink the socket) and arm an exit timer, so no drain can last forever (a worker stuck
/// during a drain would otherwise keep the process alive holding the singleton lock, with its socket already gone, and
/// every new daemon would give up on the lock). A forced drain (stall, stuck worker, memory cap) is cut off after
/// `daemon.drain_grace_ms`; any other drain (handoff, stop, idle, SIGTERM) after `daemon.drain_max_ms`. A forced drain
/// that follows a clean one arms the shorter timer too.
fn begin_drain(sh: &Arc<Shared>, why: &str, forced_exit: bool) {
    let first = !sh.draining.swap(true, SeqCst);
    if first {
        crate::discard::harmless(std::fs::remove_file(paths::socket())); // keep: cleanup that raced; an absent file is the goal state
    }
    let armed = if forced_exit { &sh.forced_timer } else { &sh.drain_timer };
    if armed.swap(true, SeqCst) {
        return;
    }
    let why = why.to_string();
    let grace = defaults::millis(if forced_exit { "daemon.drain_grace_ms" } else { "daemon.drain_max_ms" });
    let code = if forced_exit { "forced" } else { "drain_timeout" };
    let sh = sh.clone();
    std::thread::spawn(move || {
        std::thread::sleep(grace);
        // a close that started in time is not cut: its commits are the one thing a drain must not lose (bounded, so a wedged close still ends)
        await_close(&sh.db_closing, &sh.db_closed, defaults::millis("daemon.close_max_ms"), defaults::millis("daemon.drain_poll_ms"));
        crate::proc::kill_all();
        health::clear_marker();
        health::log_event("exit", code, &why);
        std::process::exit(defaults::num("daemon.forced_exit_code") as i32);
    });
}

/// The exit timer fired: when the database close is under way, wait for it to finish (at most `max`). True when it finished.
fn await_close(closing: &AtomicBool, closed: &AtomicBool, max: Duration, poll: Duration) -> bool {
    let start = Instant::now();
    while closing.load(SeqCst) && !closed.load(SeqCst) && start.elapsed() < max {
        std::thread::sleep(poll);
    }
    closed.load(SeqCst)
}

fn watchdog(sh: Arc<Shared>) {
    let mut last_rss = Instant::now();
    let mut last_idle_check = Instant::now();
    loop {
        std::thread::sleep(sh.cfg().watchdog_tick);
        // the stall and stuck checks keep running while draining: a drain waits for its workers, so one stuck there would
        // otherwise hold the process (and the singleton lock) until the drain timer. Once a forced exit is scheduled there
        // is nothing left to decide, and a check that kept firing would log the same failure every tick (each one counts
        // toward the client's crash-loop rule).
        if sh.forced_timer.load(SeqCst) {
            continue;
        }
        let draining = sh.draining.load(SeqCst);
        let cfg = sh.cfg();
        let now = sh.ms();
        if now.saturating_sub(sh.loop_beat.load(SeqCst)) > cfg.stall.as_millis() as u64 {
            health::log_event("watchdog", "stall", defaults::text("msg.log_stall"));
            health::record_failure("watchdog", "stall", defaults::text("msg.failure_stall"));
            begin_drain(&sh, defaults::text("msg.exit_reason_stall"), true);
            continue;
        }
        for (i, b) in sh.busy_since.iter().enumerate() {
            let since = b.load(SeqCst);
            if since != 0 && now.saturating_sub(since - 1) > cfg.stuck.as_millis() as u64 {
                health::log_event("watchdog", "stuck", &defaults::render("msg.log_stuck", &[("i", &i)]));
                health::record_failure("watchdog", "stuck", defaults::text("msg.failure_stuck"));
                begin_drain(&sh, defaults::text("msg.exit_reason_stuck"), true);
                break;
            }
        }
        if draining {
            continue;
        }
        // Idle exit is off unless configured (D7): the engine stays resident so the scheduler and mailbox keep running.
        if let Some(idle) = cfg.idle_exit
            && last_idle_check.elapsed() >= defaults::millis("daemon.idle_check_ms")
        {
            last_idle_check = Instant::now();
            let quiet = sh.busy_since.iter().all(|b| b.load(SeqCst) == 0) && sh.depth.load(SeqCst) == 0;
            if quiet && now.saturating_sub(sh.last_request.load(SeqCst)) > idle.as_millis() as u64 {
                begin_drain(&sh, defaults::text("msg.exit_reason_idle"), false);
                continue;
            }
        }
        if last_rss.elapsed() >= cfg.rss_check {
            last_rss = Instant::now();
            let rss = limits::rss_kb();
            let mem = limits::mem_kb();
            sh.rss_kb.store(rss, SeqCst);
            sh.rss_peak_kb.fetch_max(rss, SeqCst);
            if cfg.rss_cap_kb > 0 && mem > cfg.rss_cap_kb {
                health::log_event("rss", "rss", &defaults::render("msg.log_rss", &[("rss", &mem), ("cap", &cfg.rss_cap_kb)]));
                // its own kind: the cap trip above is the one the crash-loop rule counts, this line only explains it
                health::log_event("memory", "breakdown", &sh.memory_line());
                if cfg_snapshot_on(&sh) {
                    // the snapshot first (workers report between requests), then the drain; later ticks leave the drain to that thread
                    if crate::memdiag::claim_snapshot() {
                        let s = sh.clone();
                        let workers = cfg.workers;
                        std::thread::spawn(move || {
                            crate::memdiag::capture(s.memory(), workers, s.cfg().rss_cap_kb, s.started.elapsed().as_secs());
                            begin_drain(&s, defaults::text("msg.exit_reason_rss"), true);
                        });
                    }
                } else {
                    begin_drain(&sh, defaults::text("msg.exit_reason_rss"), true);
                }
            }
        }
    }
}

/// Whether a cap trip writes the memory snapshot before it drains.
fn cfg_snapshot_on(sh: &Shared) -> bool {
    sh.cfg().effective.boolean("diagnostics.mem_snapshot")
}

/// Take the singleton lock. Waits briefly for an outgoing (version-handoff) daemon to release it, but
/// gives up at once if a live daemon is already answering on the socket.
fn acquire_lock(lock_path: &Path, sock: &Path) -> Result<Option<std::fs::File>, std::io::Error> {
    let f = std::fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(lock_path)?;
    let start = Instant::now();
    loop {
        // SAFETY: `f` is an open file owned by this scope, so its descriptor is valid; `flock` takes only the descriptor and a flag.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(f));
        }
        if crate::client::ping(sock).is_some() {
            return Ok(None);
        }
        if start.elapsed() > defaults::millis("daemon.lock_wait_ms") {
            // the lock is held but nothing answers on the socket: a daemon that is draining, wedged, or gone without
            // releasing it; this start gives up (the client falls back to Node), and the line says why
            let holder = std::fs::read_to_string(lock_path).unwrap_or_default();
            health::log_event(
                "lock_wait",
                "no_daemon",
                &defaults::render("msg.log_lock_no_daemon", &[("path", &lock_path.display()), ("pid", &holder.trim())]),
            );
            return Ok(None);
        }
        std::thread::sleep(defaults::millis("daemon.lock_poll_ms"));
    }
}

/// What a running daemon stands on: its state directory, the lock file it holds (by inode) and its executable.
struct Footing {
    dir: std::path::PathBuf,
    lock: std::path::PathBuf,
    lock_ino: u64,
    exe: Option<std::path::PathBuf>,
}

impl Footing {
    /// Why the daemon has lost its footing, if it has: the state directory or the executable is gone, or the lock file is
    /// gone or replaced (a new daemon could then start beside this one).
    fn lost(&self) -> Option<&'static str> {
        if !self.dir.is_dir() {
            return Some("state_dir_gone");
        }
        if std::fs::metadata(&self.lock).map(|m| m.ino()).ok() != Some(self.lock_ino) {
            return Some("lock_gone");
        }
        if self.exe.as_ref().is_some_and(|e| !e.exists()) {
            return Some("binary_gone");
        }
        None
    }
}

/// Every `daemon.orphan_check_ms`, check the daemon's [`Footing`]; once lost, log why and drain (a clean exit). The idle exit
/// (`daemon.idle_exit_s`) covers a daemon nobody talks to; this covers one whose files were removed under it.
fn footing_watch(sh: Arc<Shared>, footing: Footing) {
    while !sh.draining.load(SeqCst) {
        std::thread::sleep(defaults::millis("daemon.orphan_check_ms"));
        if let Some(why) = footing.lost() {
            health::log_event("exit", "orphaned", why);
            begin_drain(&sh, why, false);
            return;
        }
    }
}

fn mtime(p: &Path) -> Option<(SystemTime, u64)> {
    std::fs::metadata(p).ok().and_then(|m| Some((m.modified().ok()?, m.len())))
}

fn start_fail(code: &str, detail: &str) -> ! {
    health::log_event("start_fail", code, detail);
    health::record_failure("start_fail", code, detail);
    std::process::exit(defaults::num("daemon.start_fail_exit_code") as i32);
}

fn io_code(e: &std::io::Error) -> String {
    format!("os{}", e.raw_os_error().unwrap_or(0))
}

/// Run the daemon until it drains: take the singleton lock, bind the socket, start the workers and the watchdog.
pub fn serve() {
    let sock = paths::socket();
    let lock_path = paths::lock_for(&sock);
    // state dir + socket dir: private (0700), ours, not a symlink
    for d in [Some(paths::dir()), sock.parent().map(Path::to_path_buf)].into_iter().flatten() {
        if !d.as_os_str().is_empty()
            && let Err(e) = limits::ensure_private_dir(&d)
        {
            start_fail(&e.code(), &e.to_string());
        }
    }
    let lock = match acquire_lock(&lock_path, &sock) {
        Ok(Some(l)) => l,
        Ok(None) => return, // a live daemon owns the socket (or the handoff is not done): not an error
        Err(e) => start_fail(&io_code(&e), &defaults::render("msg.log_lock_fail", &[("path", &lock_path.display()), ("err", &e)])),
    };
    // We hold the flock, so no other daemon owns this socket. Verify before touching anything: if the
    // pid recorded in the lock file is still a live engine (flock not honoured here), do not steal.
    let prev: u32 = std::fs::read_to_string(&lock_path).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    if prev != 0 && prev != std::process::id() && health::pid_is_engine(prev) && crate::client::ping(&sock).is_some() {
        return;
    }
    crate::jev::shared::set_resident();
    health::reap_marker();
    crate::discard::harmless(lock.set_len(0)); // keep: best effort, fail-open
    crate::discard::harmless((&lock).write_all(std::process::id().to_string().as_bytes())); // keep: best effort, fail-open
    // a stale socket FILE (from a dead daemon) is removed; anything else at that path is left alone
    if let Ok(m) = std::fs::symlink_metadata(&sock) {
        if m.file_type().is_socket() {
            crate::discard::harmless(std::fs::remove_file(&sock)); // keep: cleanup that raced; an absent file is the goal state
        } else {
            start_fail("unsafe_dir", &defaults::render("msg.log_not_socket", &[("path", &sock.display())]));
        }
    }
    let listener = match UnixListener::bind(&sock) {
        Ok(l) => l,
        Err(e) => {
            let code = if sock.as_os_str().len() >= defaults::num("paths.socket_max_len") as usize { "path_too_long".to_string() } else { io_code(&e) };
            start_fail(&code, &defaults::render("msg.log_bind_fail", &[("path", &sock.display()), ("err", &e)]));
        }
    };
    crate::discard::harmless(std::fs::set_permissions(&sock, std::fs::Permissions::from_mode(0o600))); // keep: best effort, fail-open
    listener.set_nonblocking(true).ok();
    // SAFETY: both handlers are `extern "C"` fns that only store to an atomic, which is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGHUP, on_hup as extern "C" fn(libc::c_int) as libc::sighandler_t);
        libc::signal(libc::SIGTERM, on_term as extern "C" fn(libc::c_int) as libc::sighandler_t);
    }
    // Config is read once the singleton lock is ours, so a refused second daemon never logs a config error twice.
    let store = crate::cfgstore::ConfigStore::load();
    let cfg = store.snapshot().config.clone();
    let rlimit = limits::apply_mem_limit(cfg.mem_mb);
    limits::apply_nice(cfg.nice);
    health::write_marker();
    health::clear_env_failure();
    let starts = next_start_count();
    health::log_event("start", "-", &defaults::render("msg.log_start", &[("version", &crate::version()), ("pid", &std::process::id()), ("rlimit", &rlimit)]));
    crate::dispatch::sweep_stale_spool();

    let rules_path = paths::rules_file();
    let mut sh = Shared::new(cfg, &crate::version(), RuleSet::load(&rules_path).unwrap_or_default(), rules_path);
    sh.config = store;
    sh.rlimit = rlimit;
    sh.starts = starts;
    // Storage is opened after the singleton lock, so only one daemon ever writes the databases. A storage failure
    // is logged and the daemon serves hooks anyway (they never depend on storage); impact then stays in memory.
    match crate::db::Db::open(&paths::dir()) {
        Ok(db) => sh.attach_db(db),
        Err(e) => {
            health::log_event("storage", e.code(), &e.to_string());
            sh.storage = e.code().to_string();
        }
    }
    drain_spool(&sh); // writes spooled while the engine was down, before any new one
    let sh = Arc::new(sh);
    // events from other processes (the hook dispatcher, one-shot commands) arrive through the inbox; events from inside
    // this process (Jev, health snapshots) go straight to the recorder
    sh.telemetry.set_inbox(crate::telemetry::emit::inbox_path());
    {
        let weak = Arc::downgrade(&sh);
        crate::telemetry::emit::install(Box::new(move |ev| {
            if let Some(sh) = weak.upgrade() {
                sh.telemetry.event(ev);
            }
        }));
    }
    for i in 0..sh.cfg().workers {
        let s = sh.clone();
        std::thread::spawn(move || worker(s, i));
    }
    {
        let s = sh.clone();
        std::thread::spawn(move || watchdog(s));
    }
    {
        // the daemon's footing, as it is now: a test (or an uninstall) that removes the state dir or the binary under a
        // running daemon must not leave it running for hours with nothing that can reach or stop it
        let footing =
            Footing { dir: paths::dir(), lock: lock_path.clone(), lock_ino: lock.metadata().map(|m| m.ino()).unwrap_or(0), exe: std::env::current_exe().ok() };
        let s = sh.clone();
        std::thread::spawn(move || footing_watch(s, footing));
    }
    start_scheduler(&sh);
    start_devswarm(&sh);
    {
        let s = sh.clone();
        std::thread::spawn(move || telemetry_flusher(s));
    }
    accept_loop(&sh, &listener);
    crate::dssup::ingest::join_all(); // a monitor call in flight has already taken its messages off the native queue
    if let Some(db) = &sh.db {
        sh.telemetry.flush(); // telemetry recorded since the last flush (D78)
        sh.telemetry.snapshot_metrics(); // the counters as they are at exit
        sh.db_closing.store(true, SeqCst);
        db.close(); // everything queued commits before the process exits
        sh.db_closed.store(true, SeqCst);
    }
    crate::proc::kill_all(); // a scheduled job still running must not outlive its daemon
    health::clear_marker();
    health::log_event("exit", "clean", "drained");
    // The socket was unlinked when the drain began (a successor may already own that path); the lock
    // file is never removed (that would let two daemons hold different inodes) and is released on exit.
}

/// Start the DevSwarm wiring (lane dswire): nothing at all unless DevSwarm is detected and `devswarm_rt.mode` is not `off`.
fn start_devswarm(sh: &Arc<Shared>) {
    let Some(home) = defaults::env_var("home").map(std::path::PathBuf::from) else { return };
    let weak = Arc::downgrade(sh);
    let sink: crate::dswire::Sink = Arc::new(move |f| {
        if let Some(sh) = weak.upgrade() {
            sh.telemetry.with_metrics(|m| f(m));
        }
    });
    let s = sh.clone();
    let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || s.draining.load(SeqCst));
    crate::dswire::Wire::start(&home, &paths::dir(), sh.db.clone(), sink, stop.clone()); // None is the inert case: nothing was started
    // the native ingest drain: nothing at all unless devswarm_ingest.mode is `engine` (the Node ingest daemons drain otherwise)
    crate::dssup::ingest::start(&home, &paths::dir(), stop);
}

/// Start the scheduler's ticker (D33). Its engine-side jobs (maintain, backup, the metrics snapshot, the spool drain)
/// run inside this daemon; the in-process ones reach the daemon through a weak handle, so the scheduler never keeps it
/// alive.
fn start_scheduler(sh: &Arc<Shared>) {
    use crate::schedule::{FileSource, InProc, Observer, PlannedDelivery, Scheduler, Setting};
    let weak = Arc::downgrade(sh);
    let inproc: InProc = Box::new(move |action| {
        let Some(sh) = weak.upgrade() else { return Err(defaults::text("msg.schedule_daemon_gone").to_string()) };
        match action {
            "metrics_snapshot" if sh.telemetry.snapshot_metrics() => Ok(String::new()),
            "metrics_snapshot" => Err(defaults::text("msg.schedule_snapshot_failed").to_string()),
            "spool_drain" => {
                let r = drain_spool(&sh);
                Ok(serde_json::json!({"applied": r.applied, "quarantined": r.quarantined, "left": r.left}).to_string())
            }
            "telemetry_rollup" => sh.telemetry.rollup(sh.cfg().effective.num("telemetry.retention_days")).map(|v| v.to_string()),
            "procwatch" => {
                let home = defaults::env_var("home").unwrap_or_default();
                let rec = |kind: &str, class: &str, reason: &str| {
                    sh.telemetry.impact(kind, class, reason, "");
                    sh.telemetry.with_metrics(|m| m.inc("procwatch_events", &[("kind", kind), ("class", class)]));
                };
                crate::procwatch::run_job(&crate::paths::dir(), &home, &rec)
            }
            "devswarm_reconcile" => Ok(crate::dswire::scheduled()),
            "devswarm_supervisor" => Ok(crate::dssup::cli::scheduled()),
            "noop" => Ok(String::new()),
            other => Err(defaults::render("msg.schedule_unknown_action", &[("job", &"-"), ("action", &other)])),
        }
    });
    let weak = Arc::downgrade(sh);
    let observe: Observer = Box::new(move |job, status, catch_up| {
        if let Some(sh) = weak.upgrade() {
            sh.telemetry.with_metrics(|m| {
                m.inc("schedule_runs", &[("job", job), ("status", status)]);
                if catch_up {
                    m.inc("schedule_missed", &[("job", job)]);
                }
            });
        }
    });
    let weak = Arc::downgrade(sh);
    let setting: Setting = Box::new(move |key| weak.upgrade().map(|sh| sh.cfg().effective.num(key)).unwrap_or_else(|| defaults::num(key)));
    let sched = Arc::new(Scheduler::new(&FileSource::standard(sh.cfg().test_hooks), sh.db.clone(), inproc, Box::new(PlannedDelivery), observe, setting));
    crate::discard::harmless(sh.sched.set(sched.clone())); // keep: best effort, fail-open
    let s = sh.clone();
    std::thread::spawn(move || sched.run_ticker(&|| s.draining.load(SeqCst)));
}

/// The `schedule` control verb: `list`, `run job=<name>`, `history [job=<name>] [limit=<n>]`.
fn schedule_ctl(sh: &Shared, args: &str) -> serde_json::Value {
    let Some(sched) = sh.sched.get() else { return serde_json::json!({"running": true, "jobs": []}) };
    match args.split_whitespace().next().unwrap_or("list") {
        "run" => sched.run_now(&kv(args, "job")),
        "history" => {
            let limit = kv(args, "limit").parse().unwrap_or(defaults::num("schedule.history_default") as usize);
            let runs = sh.db.as_ref().and_then(|db| db.read(|c| crate::schedule::history(c, &kv(args, "job"), limit)).ok()).unwrap_or_default();
            serde_json::json!({"running": true, "runs": runs})
        }
        _ => sched.list(),
    }
}

/// Stores the telemetry recorded in memory every `telemetry.flush_ms` (D78), reading the interval from the active config
/// each round so an edit applies without a restart. Everything recorded after the last flush is lost on `kill -9`.
fn telemetry_flusher(sh: Arc<Shared>) {
    let slice = defaults::millis("daemon.worker_wait_ms");
    let (mut last, mut last_health) = (Instant::now(), Instant::now());
    while !sh.draining.load(SeqCst) {
        std::thread::sleep(slice);
        let cfg = sh.cfg();
        if last_health.elapsed() >= Duration::from_millis(cfg.effective.num("telemetry.health_snapshot_ms")) {
            last_health = Instant::now();
            sh.telemetry.event(sh.health_event());
        }
        if last.elapsed() >= Duration::from_millis(cfg.effective.num("telemetry.flush_ms")) {
            last = Instant::now();
            if sh.db.is_some() {
                sh.telemetry.flush();
            }
        }
    }
}

fn next_start_count() -> u64 {
    let p = paths::dir().join("starts");
    let n = std::fs::read_to_string(&p).ok().and_then(|t| t.trim().parse::<u64>().ok()).unwrap_or(0) + 1;
    if let Err(e) = crate::atomic::write(&p, n.to_string()) {
        // the restart count would stall, and `restarts` in `status` with it
        health::log_event("start", "count_write_failed", &e.to_string());
    }
    n
}

/// An `accept` that failed for a reason other than "nothing pending" (review finding 5): counted in `accept_errors` (by
/// errno), logged at most once per `discard.log_interval_ms`, then the loop sleeps `daemon.accept_error_backoff_ms` before
/// polling again, so a full descriptor table cannot turn the accept loop into a busy spin.
fn accept_error(sh: &Shared, e: &std::io::Error) -> String {
    let code = io_code(e);
    ACCEPT_ERRORS.fetch_add(1, SeqCst);
    sh.telemetry.with_metrics(|m| m.inc("accept_errors", &[("code", code.as_str())]));
    crate::discard::note("daemon_accept_error", &defaults::render("msg.log_accept_error", &[("code", &code), ("err", e)]));
    std::thread::sleep(defaults::millis("daemon.accept_error_backoff_ms"));
    code
}

/// Accept calls that failed with something other than "nothing pending" (EMFILE and the like), since start.
pub static ACCEPT_ERRORS: AtomicU64 = AtomicU64::new(0);

fn accept_loop(sh: &Arc<Shared>, listener: &UnixListener) {
    let me = limits::uid();
    let fd = listener.as_raw_fd();
    let mut last_check = Instant::now();
    // accept failures since the last accepted connection: (OS error code, count)
    let mut failing: Option<(String, u64)> = None;
    // a connection was accepted after the last accept error (the recovery line is then due)
    let mut accepted_since_error = false;
    loop {
        sh.loop_beat.store(sh.ms(), SeqCst);
        let st = sh.stall_ms.swap(0, SeqCst);
        if st > 0 {
            std::thread::sleep(Duration::from_millis(st)); // test hook: simulate a wedged loop
        }
        if TERM.swap(false, SeqCst) {
            begin_drain(sh, defaults::text("msg.exit_reason_sigterm"), false);
        }
        let draining = sh.draining.load(SeqCst);
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let timeout = defaults::num(if draining { "daemon.drain_poll_ms" } else { "daemon.accept_poll_ms" }) as i32;
        // SAFETY: `pfd` is a live, writable `pollfd` and the count passed is 1.
        unsafe { libc::poll(&mut pfd, 1, timeout) };
        let mut got_any = false;
        loop {
            let s = match listener.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break, // nothing pending: back to poll
                Err(e) if matches!(e.kind(), std::io::ErrorKind::Interrupted | std::io::ErrorKind::ConnectionAborted) => continue,
                Err(e) => {
                    // EMFILE, ENFILE, ENOBUFS, ENOMEM: the connection stays pending, so poll fires again at once and the loop
                    // would spin at full CPU until a descriptor frees up. Count it, say why (rate-limited), and back off.
                    let n = failing.as_ref().map_or(0, |f| f.1);
                    failing = Some((accept_error(sh, &e), n + 1));
                    accepted_since_error = false;
                    break;
                }
            };
            accepted_since_error = true;
            got_any = true;
            if !limits::peer_allowed(&s, me) {
                sh.stats.rejected.fetch_add(1, SeqCst);
                sh.telemetry.with_metrics(|m| m.inc("rejected_peers", &[]));
                continue; // dropped: another uid never gets a reply
            }
            let mut q = lk(&sh.queue);
            if q.len() >= sh.cfg().queue {
                drop(q);
                sh.stats.busy.fetch_add(1, SeqCst);
                sh.telemetry.with_metrics(|m| m.inc("busy_replies", &[]));
                let mut s = s;
                s.set_nonblocking(false).ok();
                s.set_write_timeout(Some(defaults::millis("daemon.busy_write_ms"))).ok();
                crate::discard::harmless(s.write_all(&Reply::Busy.frame())); // keep: best effort, fail-open
            } else {
                // requests ahead of this one: the queued ones and those a worker is serving now
                let in_flight = q.len() as u64 + sh.busy_since.iter().filter(|b| b.load(SeqCst) != 0).count() as u64;
                q.push_back((s, Instant::now(), in_flight));
                sh.depth.fetch_add(1, SeqCst);
                drop(q);
                sh.cv.notify_one();
            }
        }
        // accepts work again: say so once the line can be written (the descriptor table may still be full right after one
        // accept, and the failure's own line may never have reached the log); kept and retried each round until written
        if accepted_since_error
            && let Some((code, n)) = failing.take()
            && !health::try_log_event("accept", "recovered", &defaults::render("msg.log_accept_recovered", &[("n", &n), ("code", &code)]))
        {
            failing = Some((code, n));
        }
        if draining && !got_any && lk(&sh.queue).is_empty() && sh.busy_since.iter().all(|b| b.load(SeqCst) == 0) {
            return; // queue drained, nothing in flight
        }
        // every ~200 ms: SIGHUP or a rules-file change
        if !draining && last_check.elapsed() >= defaults::millis("daemon.rules_check_ms") {
            last_check = Instant::now();
            // the rules file can move with the plugin (an update installs a new root) or appear as a user override
            let wanted = paths::rules_file();
            let moved = wanted != *lk(&sh.rules_path);
            if moved {
                *lk(&sh.rules_path) = wanted.clone();
            }
            let now = mtime(&wanted);
            if moved || HUP.swap(false, SeqCst) || now != *lk(&sh.seen) {
                sh.reload();
                sh.reload_config();
            }
        }
        // config files (D18): a settled change is validated and swapped in without a restart
        if !draining && sh.config.poll().is_some() {
            sh.sync_limits();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exit_timer_waits_for_a_close_in_progress_and_gives_up_on_a_wedged_one() {
        // P2-6: the drain timer used to process::exit mid db.close, losing queued commits
        let (closing, closed) = (AtomicBool::new(true), AtomicBool::new(false));
        let t = Instant::now();
        let done = std::thread::scope(|sc| {
            sc.spawn(|| {
                std::thread::sleep(Duration::from_millis(150));
                closed.store(true, SeqCst);
            });
            await_close(&closing, &closed, Duration::from_secs(20), Duration::from_millis(5))
        });
        assert!(done && t.elapsed() >= Duration::from_millis(150), "waited for the close: {:?}", t.elapsed());
        // no close under way: the timer fires at once
        let (idle, never) = (AtomicBool::new(false), AtomicBool::new(false));
        let t = Instant::now();
        assert!(!await_close(&idle, &never, Duration::from_secs(20), Duration::from_millis(5)));
        assert!(t.elapsed() < Duration::from_secs(1));
        // a close that never finishes is cut at the bound
        let (stuck_closing, stuck) = (AtomicBool::new(true), AtomicBool::new(false));
        let t = Instant::now();
        assert!(!await_close(&stuck_closing, &stuck, Duration::from_millis(200), Duration::from_millis(5)));
        assert!(t.elapsed() >= Duration::from_millis(200));
    }
    fn shared() -> Shared {
        let rs = RuleSet::parse(r#"{"version":1,"rules":[{"pattern":"BAD","action":"deny","message":"no"}]}"#).unwrap();
        Shared::new(Config::from_env(), "0.1.0", rs, "/nonexistent/rules.json".into())
    }
    fn call(req: &str, own: &str) -> (Reply, After) {
        let mut sh = shared();
        sh.own = own.into();
        handle_request(req.as_bytes(), &sh)
    }
    fn ok(r: &Reply) -> &str {
        match r {
            Reply::Ok(s) => s,
            o => panic!("not OK: {o:?}"),
        }
    }

    /// D76: one daemon, two clients whose environments differ, same payload. The git check's on/off switch is an
    /// environment variable, so each client must get the answer its own environment implies, whatever the daemon's is.
    #[test]
    fn each_request_is_evaluated_with_its_own_environment_never_the_daemons() {
        let rs = RuleSet::parse(r#"{"version":1,"rules":[{"id":"git-guard","events":["PreToolUse"],"tools":["Bash"],"check":"git","action":"deny","options":{"plugin_root":"/p"}}]}"#).unwrap();
        let sh = Shared::new(Config::from_env(), "0.1.0", rs, "/nonexistent/rules.json".into());
        let payload =
            r#"{"session_id":"s","cwd":"/","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}"#;
        let home = std::env::temp_dir().join(format!("ahd-env-{}", std::process::id()));
        let envs = [
            crate::reqenv::RequestEnv::from_pairs([("HOME", home.to_str().unwrap())]),
            crate::reqenv::RequestEnv::from_pairs([("HOME", home.to_str().unwrap()), ("ANTIHALL_GIT_GUARD", "0")]),
        ];
        for round in 0..2 {
            // V (rules) and D (dispatch table) both: the first client's guard is on, the second client's is off
            for (i, env) in envs.iter().enumerate() {
                let v = format!("V 0.1.0\n{}\n{payload}", env.to_line());
                let blocked_v = ok(&handle_request(v.as_bytes(), &sh).0).starts_with(crate::hookio::EXIT2);
                let meta = crate::dispatch::native::Meta {
                    host: "claude".into(),
                    event: "PreToolUse".into(),
                    tool: None,
                    root: Some("/p".into()),
                    env: env.clone(),
                    only: None,
                    plan: vec![],
                    cfg: String::new(),
                    payload_sha1: None,
                    deadline_ms: None,
                };
                let d = format!("D 0.1.0\n{}\n{payload}", serde_json::to_string(&meta).unwrap());
                let rows: Vec<serde_json::Value> = serde_json::from_str(ok(&handle_request(d.as_bytes(), &sh).0)).unwrap();
                let git = rows.iter().find(|r| r[0] == "git-guard").expect("the git check answers its entry");
                let blocked_d = git[1] == 2;
                assert_eq!((blocked_v, blocked_d), (i == 0, i == 0), "round {round}, client {i}: {git}");
            }
        }
    }

    #[test]
    fn same_or_older_client_keeps_daemon_alive() {
        let req = "V 0.1.0\n{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"BAD\"}}";
        let (reply, after) = call(req, "0.1.0");
        assert!(ok(&reply).contains("deny"));
        assert_eq!(after, After::Continue);
        assert_eq!(call(req, "0.2.0").1, After::Continue);
    }

    #[test]
    fn newer_client_still_gets_its_answer_then_daemon_retires() {
        let req = "V 0.2.0\n{\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"BAD\"}}";
        let (reply, after) = call(req, "0.1.0");
        assert!(ok(&reply).contains("deny"), "in-flight request is still served");
        assert_eq!(after, After::Exit);
    }

    #[test]
    fn control_requests() {
        assert!(ok(&call("CTL ping\n", "9.9.9").0).starts_with("pong 9.9.9 "));
        assert_eq!(call("CTL stop\n", "1").1, After::Exit);
        let st: serde_json::Value = serde_json::from_str(ok(&call("CTL status\n", "1").0)).unwrap();
        assert_eq!(st["running"], true);
        assert_eq!(st["rules"]["count"], 1);
        assert!(matches!(call("garbage", "1"), (Reply::Err(_), After::Continue)));
        assert!(matches!(call("CTL panic\n", "1"), (Reply::Err(_), _)), "test verbs are off by default");
    }

    #[test]
    fn malformed_payload_is_an_error_reply_never_an_allow() {
        assert!(matches!(call("V 0.1.0\nnot json at all", "0.1.0").0, Reply::Err(_)));
        assert!(matches!(call("V 0.1.0\n", "0.1.0").0, Reply::Err(_)));
    }

    #[test]
    fn forced_delegation_route_and_delegate_events_are_linkable_and_ledger_ready() {
        let t = Telemetry::new();
        let obs = DaemonObserver { t: &t, project: "p", event: "PreToolUse" };
        let route = crate::checks::RouteMeta {
            requested_model: "opus".into(),
            parent_model: "opus".into(),
            task_class: "mechanical".into(),
            recommended_tier: "haiku".into(),
            selected_model: "haiku".into(),
            outcome: "down".into(),
            spawn_key: "spawn-key1".into(),
            delegate: true,
            blocked: true,
        };
        crate::hookio::Observer::route(&obs, "model-routing", "PreToolUse", &route);
        let routes = t.telemetry_json("events", "1d", "route", 10);
        let delegates = t.telemetry_json("events", "1d", "delegate", 10);
        assert_eq!(routes["count"], 1);
        assert_eq!(delegates["count"], 1);
        let r = &routes["events"][0];
        let d = &delegates["events"][0];
        assert_eq!(r["spawn_key"], d["spawn_key"]);
        assert_eq!(r["requested_model"], "opus");
        assert_eq!(r["selected_model"], "haiku");
        assert_eq!(r["outcome"], "deny");
        assert_eq!(d["requested_model"], "opus");
        assert_eq!(d["selected_model"], "haiku");
        assert_eq!(d["task_class"], "mechanical");
    }

    #[test]
    fn a_blocking_route_without_delegation_is_serialized_as_a_block() {
        let t = Telemetry::new();
        let obs = DaemonObserver { t: &t, project: "p", event: "PreToolUse" };
        let route = crate::checks::RouteMeta {
            requested_model: "sonnet".into(),
            parent_model: "opus".into(),
            task_class: "unknown".into(),
            recommended_tier: "sonnet".into(),
            selected_model: "sonnet".into(),
            outcome: "exempt".into(),
            spawn_key: "spawn-key2".into(),
            delegate: false,
            blocked: true,
        };
        crate::hookio::Observer::route(&obs, "model-routing", "PreToolUse", &route);
        let routes = t.telemetry_json("events", "1d", "route", 10);
        assert_eq!(routes["events"][0]["o"], "block");
        assert_eq!(t.telemetry_json("events", "1d", "delegate", 10)["count"], 0, "no delegation, no delegate event");
    }

    #[test]
    fn per_session_rate_limit_is_independent_per_session() {
        let mut cfg = Config::from_env();
        cfg.session_rps = 0.001;
        cfg.session_burst = 2.0;
        let rs = RuleSet::parse(r#"{"version":1,"rules":[]}"#).unwrap();
        let sh = Shared::new(cfg, "1", rs, "/x".into());
        let q = |s: &str| handle_request(format!("V 1\n{{\"hook_event_name\":\"Stop\",\"session_id\":\"{s}\"}}").as_bytes(), &sh).0;
        assert!(matches!(q("a"), Reply::Ok(_)) && matches!(q("a"), Reply::Ok(_)));
        assert_eq!(q("a"), Reply::Busy);
        assert!(matches!(q("b"), Reply::Ok(_)), "another session is unaffected");
    }

    #[test]
    fn project_ops_are_partitioned_by_cwd() {
        let d = crate::db::TempDir::new("daemon-proj");
        let mut sh = shared();
        assert_eq!(handle_request(b"P /nonexistent-a\nput x", &sh).0, Reply::Busy, "no storage: the client retries and spools; never kept in memory alone");
        sh.attach_db(crate::db::Db::open(&d.0).unwrap());
        let p = |cwd: &str, body: &str| handle_request(format!("P {cwd}\n{body}").as_bytes(), &sh).0;
        assert_eq!(p("/nonexistent-a", "put hello"), Reply::Ok("ok".into()));
        assert_eq!(p("/nonexistent-b", "take"), Reply::Ok(String::new()));
        assert_eq!(p("/nonexistent-a", "take"), Reply::Ok("hello".into()));
        assert_eq!(p("/nonexistent-a", "W id-1\nput again"), Reply::Ok("ok".into()));
        assert_eq!(p("/nonexistent-a", "W id-1\nput again"), Reply::Ok("ok".into()));
        assert_eq!(p("/nonexistent-a", "len"), Reply::Ok("1".into()), "the write id made the repeat a no-op");
    }

    #[test]
    fn every_hook_and_check_run_is_recorded_with_no_per_check_code() {
        use crate::telemetry::recorder::Delta;
        let rs = RuleSet::parse(
            r#"{"version":1,"rules":[{"id":"git-guard","events":["PreToolUse"],"tools":["Bash"],"check":"git","action":"deny","options":{"plugin_root":"/plugin"}}]}"#,
        )
        .unwrap();
        let sh = Shared::new(Config::from_env(), "1", rs, "/x".into());
        let forced = format!("git pu{}h --force origin main", "s");
        let send = |cmd: &str| {
            let payload =
                serde_json::json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "cwd": "/tmp", "session_id": "s", "tool_input": {"command": cmd}});
            // a whole environment: a request without one is incomplete, and every check then defers
            let env = crate::reqenv::RequestEnv::from_pairs([("HOME", "/tmp")]).to_line();
            handle_request(format!("V 1\n{env}\n{payload}").as_bytes(), &sh).0
        };
        assert!(matches!(send(&forced), Reply::Ok(_)));
        assert!(matches!(send("ls"), Reply::Ok(_)));
        let d = sh.telemetry.recorder().pending_deltas();
        let n = |k: &str, h: &str, o: &str| d.iter().filter(|x: &&Delta| x.k == k && x.h == h && x.o == o && x.e == "PreToolUse").map(|x| x.n).sum::<u64>();
        assert_eq!(n("check", "git", "block"), 1, "the git check's block is recorded: {d:?}");
        assert_eq!(n("check", "git", "allow"), 1, "and its allow");
        assert_eq!(n("hook", "hook", "block"), 1, "the whole hook request too");
        assert_eq!(n("hook", "hook", "allow"), 1);
        assert!(d.iter().all(|x| x.us_sum > 0 || x.n == 0 || x.hist.iter().sum::<u64>() == x.n), "latency is bucketed for every row");
        // switching telemetry off through the config stops recording
        sh.telemetry.set_enabled(false);
        send("ls");
        assert_eq!(sh.telemetry.recorder().pending_deltas().iter().map(|x| x.n).sum::<u64>(), d.iter().map(|x| x.n).sum::<u64>());
    }

    #[test]
    fn busy_and_malformed_requests_are_recorded_as_skip_and_error() {
        let mut cfg = Config::from_env();
        cfg.session_rps = 0.001;
        cfg.session_burst = 1.0;
        let rs = RuleSet::parse(r#"{"version":1,"rules":[]}"#).unwrap();
        let sh = Shared::new(cfg, "1", rs, "/x".into());
        let q = |b: &str| handle_request(format!("V 1\n{b}").as_bytes(), &sh).0;
        q(r#"{"hook_event_name":"Stop","session_id":"a"}"#);
        q(r#"{"hook_event_name":"Stop","session_id":"a"}"#);
        q("not json");
        let d = sh.telemetry.recorder().pending_deltas();
        let n = |o: &str| d.iter().filter(|x| x.k == "hook" && x.o == o).map(|x| x.n).sum::<u64>();
        assert_eq!((n("allow"), n("skip"), n("error")), (1, 1, 1));
    }

    #[test]
    fn the_telemetry_verb_reports_live_data_and_the_loss_window() {
        let sh = shared();
        handle_request(b"V 1\n{\"hook_event_name\":\"Stop\"}", &sh);
        let v: serde_json::Value = serde_json::from_str(ok(&handle_request(b"CTL telemetry summary window=1d\n", &sh).0)).unwrap();
        assert_eq!(v["invocations"], 1);
        assert_eq!(v["live"], true);
        assert!(v["note"].as_str().unwrap().contains("kill -9"));
        let e: serde_json::Value = serde_json::from_str(ok(&handle_request(b"CTL telemetry events kind=route\n", &sh).0)).unwrap();
        assert_eq!(e["count"], 0);
    }

    #[test]
    fn a_health_snapshot_carries_the_daemons_readings_and_shows_in_the_summary() {
        let sh = shared();
        let ev = sh.health_event();
        let crate::telemetry::event::Extras::Fields(f) = &ev.extras else { panic!("fields") };
        assert!(f.get_num("rss_kb").is_some_and(|n| n > 0), "{f:?}");
        assert_eq!(f.get_num("rss_cap_kb"), Some(sh.cfg().rss_cap_kb));
        assert_eq!((f.get_num("workers"), f.get_num("busy"), f.get_num("restarts")), (Some(sh.cfg().workers as u64), Some(0), Some(0)));
        for k in ["degraded", "queue_depth", "queue_cap", "saturated", "peak_in_flight", "max_wait_us", "heap_live_kb"] {
            assert!(f.get_num(k).is_some(), "missing {k}");
        }
        assert_eq!(&crate::telemetry::event::Event::from_json(&ev.to_json()).unwrap(), &ev);
        sh.telemetry.event(ev);
        let v: serde_json::Value = serde_json::from_str(ok(&handle_request(b"CTL telemetry summary window=1d\n", &sh).0)).unwrap();
        assert_eq!(v["detail"]["daemon"]["snapshots"], 1);
        assert_eq!(v["detail"]["daemon"]["latest"]["rss_cap_kb"], sh.cfg().rss_cap_kb);
    }
}
