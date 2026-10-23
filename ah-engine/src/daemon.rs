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
use crate::discard::Logged;
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
    /// Connections that closed without sending a byte: the launcher's liveness probe (connect only). Not requests: nothing is
    /// dispatched, answered or logged for them (a reply would only hit a closed pipe).
    pub probes: AtomicU64,
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
    /// The accept loop has returned (a clean drain); the watchdog no longer judges it.
    loop_ended: AtomicBool,
    /// per worker: 0 = idle, else (ms since `started`) + 1 at its last progress on the current request (picked up, a check
    /// started or finished, the interpreter ran: [`crate::deadline::beat`]); the watchdog's stuck rule measures from it
    busy_since: Vec<Arc<AtomicU64>>,
    stall_ms: AtomicU64,
    test_thread_panics: AtomicU64,
    /// CPU and memory against their budgets (`diagnostics.budget_*`), updated by the watchdog.
    budget: Mutex<crate::budget::State>,
    /// Last sampled resident set, KB.
    pub rss_kb: AtomicU64,
    /// Highest sampled resident set since start, KB.
    pub rss_peak_kb: AtomicU64,
    /// The RSS watchdog already started a drain for this process.
    rss_tripped: AtomicBool,
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
    /// Test-only resident allocation held so the RSS watchdog can be exercised deterministically.
    test_alloc: Mutex<Vec<Vec<u8>>>,
}

/// The value of `name=<value>` in a space-separated argument string (empty when absent).
fn kv(args: &str, name: &str) -> String {
    args.split_whitespace().find_map(|w| w.strip_prefix(name).and_then(|r| r.strip_prefix('='))).unwrap_or("").to_string()
}

fn request_context(req: &[u8]) -> (String, String) {
    let text = String::from_utf8_lossy(req);
    let (head, body) = text.split_once('\n').unwrap_or((&text, ""));
    let request = head.split_whitespace().next().unwrap_or("").to_string();
    let event = if head.starts_with("V ") {
        serde_json::from_str::<serde_json::Value>(crate::reqenv::split_request(body).1)
            .ok()
            .and_then(|v| v.get("hook_event_name").or_else(|| v.get("hookEventName")).and_then(serde_json::Value::as_str).map(str::to_string))
            .unwrap_or_default()
    } else {
        String::new()
    };
    (request, event)
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
            loop_ended: AtomicBool::new(false),
            busy_since: (0..workers).map(|_| Arc::new(AtomicU64::new(0))).collect(),
            stall_ms: AtomicU64::new(0),
            test_thread_panics: AtomicU64::new(0),
            budget: Mutex::new(crate::budget::State::default()),
            rss_kb: AtomicU64::new(0),
            rss_peak_kb: AtomicU64::new(0),
            rss_tripped: AtomicBool::new(false),
            last_request: AtomicU64::new(0),
            telemetry: Telemetry::new(),
            starts: 0,
            db: None,
            storage: defaults::text("msg.storage_off").to_string(),
            sched: std::sync::OnceLock::new(),
            test_alloc: Mutex::new(Vec::new()),
        }
    }

    /// The active config snapshot. A request takes it once and uses it throughout, so it sees one version entirely.
    pub fn cfg(&self) -> Arc<crate::cfgstore::Snapshot> {
        self.config.snapshot()
    }

    /// Re-read the config files (`ctl reload`, or the watcher once a change has settled) and apply new rate limits.
    fn reload_config(&self) -> crate::cfgstore::Reload {
        let r = self.config.reload();
        crate::memstat::configure_measure_from_defaults(); // the per-call memory knobs follow the reloaded defaults
        if let crate::cfgstore::Reload::Invalid(code) = &r {
            // the shipped defaults were rejected (a missing key among the reasons): the previous snapshot keeps serving, checks that
            // need the new settings cannot run
            crate::failopen::note(defaults::text("fail_open.reason_missing_key"), defaults::text("fail_open.check_none"), code);
        }
        self.sync_limits();
        r
    }

    /// Give the rate-limit buckets the active config's rates.
    fn sync_limits(&self) {
        let c = self.cfg();
        lk(&self.sessions).set_rate(c.session_rps, c.session_burst);
        lk(&self.projects).set_rate(c.project_rps, c.project_burst);
        self.telemetry.set_enabled(c.effective.boolean("telemetry.enabled"));
        crate::obs::profile::apply_config(&c.effective.text("diagnostics.profile"));
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

    /// The `diag` control verb: one read-only report over state the daemon already keeps (the topics are `diagnostics.diag_topics`).
    fn diag_json(&self, topic: &str) -> serde_json::Value {
        let cfg = self.cfg();
        match topic {
            "cpu" => serde_json::json!({
                "cpu_s": (limits::process_cpu_secs() * 1000.0).round() / 1000.0,
                "cpu": cpu_json(&self.telemetry),
                "budget": lk(&self.budget).report(cfg.effective.num("diagnostics.budget_cpu_pct"), cfg.effective.num("diagnostics.budget_mem_mb")),
                "profile": crate::obs::profile::status(),
            }),
            "mem" => self.memory_with_ledger(),
            "threads" => crate::threads::snapshot_json(),
            "hooks" => serde_json::json!({"summary": self.telemetry.headline(), "phases": phases_json(&self.telemetry), "handback": crate::obs::counters::snapshot()}),
            "mesh" => {
                let reply = crate::dswire::cli::ctl("");
                serde_json::from_str(&reply).unwrap_or_else(|_| serde_json::json!({"status": reply}))
            }
            "jev" => self.telemetry.with_metrics(|m| {
                let snap = m.snapshot("");
                let keep = |k: &str| {
                    snap.get(k).and_then(serde_json::Value::as_array).into_iter().flatten().filter(|r| r.get("name").and_then(serde_json::Value::as_str).is_some_and(|n| n.starts_with("jev"))).cloned().collect::<Vec<_>>()
                };
                serde_json::json!({"counters": keep("counters"), "histograms": keep("histograms")})
            }),
            "trace" => serde_json::json!({"running": true, "entries": crate::obs::trace::snapshot()}),
            other => crate::obs::diagverbs::local(other, "").unwrap_or_else(|| serde_json::json!({"error": defaults::render("msg.obs_diag_unknown", &[("topic", &other)])})),
        }
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
            "allocator": crate::memstat::active_allocator().as_str(),
            "allocator_config": self.cfg().effective.text("diagnostics.allocator"),
            "allocator_stats": crate::memdiag::allocator_stats(),
            "heap_live_kb": heap.live / 1024,
            "heap_peak_kb": heap.peak / 1024,
            "allocs": heap.allocs,
            "budgets": crate::mem::global().snapshot(),
            "components": {
                "guard_state_entries": crate::checks::guardkit::state::entries(),
                "hookcfg_session_counters": crate::hookcfg::session::global().len(),
                "rate_buckets_sessions": lk(&self.sessions).len(),
                "rate_buckets_projects": lk(&self.projects).len(),
                "project_key_cache": lk(&self.keys).len(),
                "jev_lanes": crate::jev::shared::lane_count(),
                "queued_connections": self.depth.load(SeqCst),
                "workers": self.busy_since.len(),
                "dswire_workspaces": crate::dswire::global().map_or(0, |w| w.rt.current().workspaces.len()),
                "dswire_edge_log": crate::dswire::global().map_or(0, |w| w.rt.edge_log_len()),
                "threads": crate::threads::snapshot().len(),
            },
        })
    }

    /// [`memory`](Self::memory) plus the live ledger (`status --memory`): the footprint, the C-library zones and the Rust heap
    /// against the named holders. Kept out of `memory()` itself, which the crash breadcrumb and the debug sampler also call.
    fn memory_with_ledger(&self) -> serde_json::Value {
        let mut m = self.memory();
        let ledger = crate::memdiag::live_ledger(m.get("budgets").unwrap_or(&serde_json::Value::Null));
        if let Some(o) = m.as_object_mut() {
            o.insert("ledger".into(), ledger);
            o.insert("regex".into(), crate::script::regex_diag());
            o.insert("leak".into(), crate::mem::leak::status());
        }
        m
    }

    /// The memory breakdown as one short `key=value` line for the event log (which cuts a line at `health.event_text_max`).
    fn memory_line(&self) -> String {
        let m = self.memory();
        let mut parts: Vec<String> = ["rss_kb", "heap_live_kb", "heap_peak_kb", "allocs"].iter().map(|k| format!("{k}={}", m[k])).collect();
        if let Some(c) = m["components"].as_object() {
            parts.extend(c.iter().map(|(k, v)| format!("{k}={v}")));
        }
        // registered holders that hold anything now (a transient scan included), so the line names more than the components
        if let Some(h) = m["budgets"]["holders"].as_array() {
            parts.extend(
                h.iter()
                    .filter(|h| h["bytes"].as_u64().is_some_and(|b| b > 0))
                    .map(|h| format!("mem_{}={}", h["name"].as_str().unwrap_or_default(), h["bytes"])),
            );
        }
        parts.join(" ")
    }

    /// The `daemon` health snapshot event: resident set against its cap, restarts, the degraded flag, queue and worker load, and
    /// saturation. Numbers only (the fields are declared in `telemetry.fields`).
    pub fn health_event(&self) -> crate::telemetry::event::Event {
        let cfg = self.cfg();
        let load = self.load.report(health::now_ms());
        let degraded =
            health::overall_degraded(&health::summary(), crate::failopen::state(crate::failopen::window().0) != defaults::text("fail_open.state_ok"));
        let busy = self.busy_since.iter().filter(|b| b.load(SeqCst) != 0).count() as u64;
        let (cpu_permille, budget_mask) = {
            let b = lk(&self.budget);
            (b.cpu_permille(), b.mask())
        };
        crate::telemetry::emit::daemon_snapshot(
            degraded,
            &[
                ("rss_kb", limits::rss_kb()),
                ("rss_cap_kb", cfg.rss_cap_kb),
                ("cpu_permille", cpu_permille),
                ("budget_breach", budget_mask),
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

    /// The vital signs for `CTL pulse` (src/web/pulse.rs): atomics and the active config snapshot only.
    pub fn pulse_json(&self) -> serde_json::Value {
        let mut pulse = crate::web::pulse::build(&crate::web::pulse::Inputs {
            version: &self.own,
            uptime_s: self.started.elapsed().as_secs(),
            rss_kb: limits::rss_kb(),
            cpu_s: limits::process_cpu_secs(),
            requests: self.stats.requests.load(SeqCst),
            busy_replies: self.stats.busy.load(SeqCst),
            slow_replies: SLOW_REPLIES.load(SeqCst),
            errors: self.stats.errors.load(SeqCst),
            panics: self.stats.panics.load(SeqCst),
            queue_depth: self.depth.load(SeqCst) as u64,
            workers: self.busy_since.len() as u64,
            budget_mask: lk(&self.budget).mask(),
            restarts: self.starts.saturating_sub(1),
            config_version: self.config.snapshot().version,
        });
        let leak = crate::mem::leak::status();
        pulse["leak"] = serde_json::json!({"state": leak["state"], "slope_mb_per_h": leak["slope_mb_per_h"], "top": leak["top"]});
        pulse
    }

    fn status(&self) -> String {
        let rss_now = limits::rss_kb();
        let rules = self.rules.read().unwrap_or_else(|e| e.into_inner()).clone();
        let cfg = self.cfg();
        let b = health::breaker_remaining();
        let c = health::crashloop_remaining();
        let gs = crate::gate::global().stats();
        // one flag for `degraded` and `health.degraded`: the health summary's own reasons or an unhealthy fail-open window
        let mut health_summary = health::summary();
        let (fo_n, fo_top) = crate::failopen::window();
        let fo_unhealthy = crate::failopen::state(fo_n) != defaults::text("fail_open.state_ok");
        health::add_fail_open_reason(&mut health_summary, fo_unhealthy.then(|| (fo_n, fo_top)));
        let degraded = health::overall_degraded(&health_summary, fo_unhealthy);
        health_summary["degraded"] = serde_json::Value::Bool(degraded);
        let mut v = serde_json::json!({
            "running": true,
            "pid": std::process::id(),
            "version": self.own,
            "uptime_s": self.started.elapsed().as_secs(),
            "rss_kb": rss_now,
            "footprint_kb": limits::footprint_kb(),
            "mem_metric": defaults::text("daemon.mem_metric"),
            "mem_kb": limits::mem_kb(),
            "allocator": crate::memstat::active_allocator().as_str(),
            "allocator_config": self.cfg().effective.text("diagnostics.allocator"),
            "rss_peak_kb": self.rss_peak_kb.fetch_max(rss_now, SeqCst).max(rss_now),
            "memory": self.memory_with_ledger(),
            "load": self.load.report(health::now_ms()),
            "health": health_summary,
            "cpu_s": (limits::process_cpu_secs() * 1000.0).round() / 1000.0,
            "queue_depth": self.depth.load(SeqCst),
            "queue_cap": cfg.queue,
            "workers": cfg.workers,
            "requests": self.stats.requests.load(SeqCst),
            "busy_replies": self.stats.busy.load(SeqCst),
            "bucket_untracked": crate::limits::bucket_untracked(),
            "errors": self.stats.errors.load(SeqCst),
            "budget_trips": self.stats.budget_trips.load(SeqCst),
            "panics": self.stats.panics.load(SeqCst),
            "reply_write_errors": REPLY_WRITE_ERRORS.load(SeqCst),
            "accept_errors": ACCEPT_ERRORS.load(SeqCst),
            "slow_replies": SLOW_REPLIES.load(SeqCst),
            "rejected_peers": self.stats.rejected.load(SeqCst),
            "probes": self.stats.probes.load(SeqCst),
            "starts": self.starts,
            "restarts": self.starts.saturating_sub(1),
            "breaker": b.map_or("closed".to_string(), |d| defaults::render("msg.state_open", &[("secs", &(d.as_secs() + 1))])),
            "crashloop": c.map_or("clear".to_string(), |d| defaults::render("msg.state_stopped", &[("secs", &(d.as_secs() + 1))])),
            "rules": {"version": rules.version, "count": rules.rules.len(), "fingerprint": format!("{:016x}", rules.fingerprint())},
            "summary": self.telemetry.headline(),
            "phases": phases_json(&self.telemetry),
            "cpu": cpu_json(&self.telemetry),
            "wire": self.telemetry.with_metrics(|m| {
                let c = |k: &str| m.counter("wire_events", &[("kind", defaults::text(k))]);
                serde_json::json!({
                    "acked": c("wire.kind_acked"), "delivered": c("wire.kind_delivered"), "retries": c("wire.kind_retry"),
                    "abandoned": c("wire.kind_abandoned"), "ack_timeouts": c("wire.kind_ack_timeout"),
                })
            }),
            "fail_open": crate::failopen::status(&self.telemetry),
            "degraded": degraded,
            "mem_limit": self.rlimit,
            "malloc_stack_logging": cfg.malloc_stack_logging,
            "storage": self.storage,
            "rss_cap_kb": cfg.rss_cap_kb,
            "budget": lk(&self.budget).report(cfg.effective.num("diagnostics.budget_cpu_pct"), cfg.effective.num("diagnostics.budget_mem_mb")),
            "debug": crate::debug::stats(),
            "inject_gate": {"sessions": gs.sessions, "slots": gs.slots, "bytes": gs.bytes, "evictions": gs.evictions,
                "max_sessions": defaults::num("inject_gate.max_sessions"), "max_slots": defaults::num("inject_gate.max_slots")},
            "config": {"version": cfg.version, "pending_restart": cfg.pending_restart, "last_error": cfg.last_error},
            "profile": crate::obs::profile::status(),
        });
        // the hand-back and accounting counters (the daemon's own plus every other process's journal)
        if let (Some(m), Some(o)) = (v.as_object_mut(), crate::obs::counters::snapshot().as_object()) {
            m.extend(o.clone());
        }
        v.to_string()
    }
}

/// The latency of each phase of a hook call by event: `{event: {phase: {count, p50_us, p95_us, max_us}}}` (the client's connect,
/// request-to-ACK and ACK-to-response, the daemon's queue wait, judging and delivery, the launcher's startup), and the time of each
/// check apart under `checks`. Quantiles are upper bucket bounds, as everywhere in the metrics.
pub fn phases_json(t: &crate::telemetry::Telemetry) -> serde_json::Value {
    let snap = t.with_metrics(|m| m.snapshot(""));
    let mut out = serde_json::Map::new();
    let mut checks = serde_json::Map::new();
    let field = |h: &serde_json::Value, k: &str| h.get(k).cloned().unwrap_or(serde_json::Value::Null);
    let label = |h: &serde_json::Value, k: &str| h.get("labels").and_then(|l| l.get(k)).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    for h in snap.get("histograms").and_then(serde_json::Value::as_array).into_iter().flatten() {
        let row = serde_json::json!({"count": field(h, "count"), "p50_us": field(h, "p50_us"), "p95_us": field(h, "p95_us"), "max_us": field(h, "max_us")});
        match h.get("name").and_then(serde_json::Value::as_str) {
            Some("hook_phase_us") => {
                let (event, phase) = (label(h, "event"), label(h, "phase"));
                out.entry(event).or_insert_with(|| serde_json::json!({})).as_object_mut().map(|o| o.insert(phase, row));
            }
            Some("check_latency_us") => {
                let c = checks.entry(label(h, "check")).or_insert_with(|| serde_json::json!({}));
                if let (Some(o), Some(r)) = (c.as_object_mut(), row.as_object()) {
                    o.extend(r.iter().map(|(k, v)| (k.clone(), v.clone())));
                }
            }
            // the bytes one call of the check allocated / grew the heap by (`diagnostics.check_mem`), next to its latency
            Some(n @ ("check_mem_peak_bytes" | "check_mem_alloc_bytes")) => {
                let key = n.trim_start_matches("check_").trim_end_matches("_bytes");
                let row =
                    serde_json::json!({"count": field(h, "count"), "p50": field(h, "p50_bytes"), "p95": field(h, "p95_bytes"), "max": field(h, "max_bytes")});
                let c = checks.entry(label(h, "check")).or_insert_with(|| serde_json::json!({}));
                if let Some(o) = c.as_object_mut() {
                    o.insert(key.to_string(), row);
                }
            }
            _ => {}
        }
    }
    for c in snap.get("counters").and_then(serde_json::Value::as_array).into_iter().flatten() {
        let key = match c.get("name").and_then(serde_json::Value::as_str) {
            Some("check_mem_retained_bytes") => "mem_retained_bytes",
            Some("check_cpu_us") => "cpu_us_total",
            _ => continue,
        };
        if let Some(o) = checks.entry(label(c, "check")).or_insert_with(|| serde_json::json!({})).as_object_mut() {
            o.insert(key.to_string(), field(c, "value"));
        }
    }
    // CPU per call = total / calls (the latency histogram's count is the number of calls)
    for row in checks.values_mut().filter_map(serde_json::Value::as_object_mut) {
        if let (Some(total), Some(calls)) = (row.get("cpu_us_total").and_then(serde_json::Value::as_u64), row.get("count").and_then(serde_json::Value::as_u64)) {
            row.insert("cpu_us_per_call".to_string(), serde_json::json!(total.checked_div(calls).unwrap_or(0)));
        }
    }
    out.insert("checks".to_string(), serde_json::Value::Object(checks));
    serde_json::Value::Object(out)
}

thread_local! {
    /// The socket peer of the request this thread is serving ([`serve_conn`] sets it, the request parse takes it).
    static REQUEST_PEER: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}

/// Where the engine's CPU goes, for `status --json`: `by_event` (hook calls and the checks' CPU per hook event) and `top_checks`
/// (the `telemetry.top_checks` checks that spent the most CPU, with calls and CPU per call).
pub fn cpu_json(t: &crate::telemetry::Telemetry) -> serde_json::Value {
    let snap = t.with_metrics(|m| m.snapshot(""));
    let label = |c: &serde_json::Value, k: &str| c.get("labels").and_then(|l| l.get(k)).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let value = |c: &serde_json::Value| c.get("value").and_then(serde_json::Value::as_u64).unwrap_or(0);
    let mut by_event = std::collections::BTreeMap::<String, (u64, u64)>::new();
    let (mut cpu, mut calls) = (std::collections::BTreeMap::<String, u64>::new(), std::collections::BTreeMap::<String, u64>::new());
    for c in snap.get("counters").and_then(serde_json::Value::as_array).into_iter().flatten() {
        match c.get("name").and_then(serde_json::Value::as_str) {
            Some("hook_calls") => by_event.entry(label(c, "event")).or_default().0 += value(c),
            Some("event_check_cpu_us") => by_event.entry(label(c, "event")).or_default().1 += value(c),
            Some("check_cpu_us") => *cpu.entry(label(c, "check")).or_default() += value(c),
            Some("check_calls") => *calls.entry(label(c, "check")).or_default() += value(c),
            _ => {}
        }
    }
    let mut top: Vec<(String, u64)> = cpu.into_iter().collect();
    top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let top: Vec<serde_json::Value> = top
        .into_iter()
        .take(defaults::num("telemetry.top_checks") as usize)
        .map(|(check, total)| {
            let n = calls.get(&check).copied().unwrap_or(0);
            serde_json::json!({"check": check, "calls": n, "cpu_us_total": total, "cpu_us_per_call": total.checked_div(n).unwrap_or(0)})
        })
        .collect();
    let by_event: serde_json::Map<String, serde_json::Value> =
        by_event.into_iter().map(|(e, (n, us))| (e, serde_json::json!({"calls": n, "cpu_us_total": us}))).collect();
    serde_json::json!({"by_event": by_event, "top_checks": top})
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
        // 0 = a daemon request whose sender the socket did not name: ancestry walks must not start at the daemon itself
        let env = env.with_peer_pid(Some(REQUEST_PEER.with(|c| c.take()).unwrap_or(0)));
        if let Some(root) = crate::bootstrap::ROOT_ENVS.iter().find_map(|n| env.get(n)) {
            sh.config.offer_root(root);
        }
        let reply = hook(payload, &env, sh, cfg);
        let newer = crate::version_cmp(v.trim(), &sh.own) == std::cmp::Ordering::Greater;
        return (reply, if newer { After::Exit } else { After::Continue });
    }
    if let Some(v) = head.strip_prefix("D ") {
        let reply = dispatch(body, sh, cfg);
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
    if let Some(reply) = ctl.and_then(|_| crate::web::dispatch(verb, args)) {
        return (Reply::Ok(reply), After::Continue);
    }
    match ctl.map(|_| verb) {
        Some("metrics") => (Reply::Ok(sh.metrics_json(args).to_string()), After::Continue),
        Some("impact") => (Reply::Ok(sh.impact_json(args).to_string()), After::Continue),
        Some("schedule") => (Reply::Ok(schedule_ctl(sh, args).to_string()), After::Continue),
        Some("devswarm") => (Reply::Ok(crate::dswire::cli::ctl(args)), After::Continue),
        Some("pulse") => (Reply::Ok(sh.pulse_json().to_string()), After::Continue),
        Some("gate") => (Reply::Ok(crate::gate::global().report().to_string()), After::Continue),
        Some("telemetry") => (Reply::Ok(sh.telemetry_json(args).to_string()), After::Continue),
        Some("profile") => (Reply::Ok(crate::obs::profile::ctl(args)), After::Continue),
        Some("diag") => (Reply::Ok(sh.diag_json(args.trim()).to_string()), After::Continue),
        Some("ping") => (Reply::Ok(format!("pong {} {}", sh.own, std::process::id())), After::Continue),
        Some("reload") => {
            sh.reload();
            sh.reload_config();
            (Reply::Ok("ok".into()), After::Continue)
        }
        Some("config") => (Reply::Ok(sh.config.report().to_string()), After::Continue),
        Some("stop") => (Reply::Ok("ok".into()), After::Exit),
        Some("status") => (Reply::Ok(sh.status()), After::Continue),
        Some(v) if v == defaults::text("diagnostics.threads_ctl") => (Reply::Ok(crate::threads::snapshot_json().to_string()), After::Continue),
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
        "alloc" => lk(&sh.test_alloc).push(vec![0xA5; ms.saturating_mul(1024) as usize]),
        "thread_panic" => sh.test_thread_panics.store(ms, SeqCst),
        "panic" => std::panic::resume_unwind(Box::new(defaults::text("msg.reply_test_panic").to_string())),
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

/// What a check that just finished read and noted (task #66 step 0): its transcript bytes and latency by transcript size class,
/// and the counted events it noted (a kept-walk hit or the reason it missed).
pub fn observe_check_cost_in(t: &Telemetry, event: &str, check: &str, micros: u64) {
    let bytes = crate::load::take_check_scan();
    let cpu = crate::load::take_check_cpu();
    let mem = crate::load::take_check_mem();
    let notes = crate::load::take_counts();
    let size = crate::load::size_bucket(crate::load::transcript_size());
    if crate::obs::profile::active() {
        crate::obs::profile::span(&crate::obs::profile::Span {
            event,
            check,
            wall_us: micros,
            cpu_us: cpu,
            alloc_bytes: mem.map_or(0, |d| d.alloc),
            peak_bytes: mem.map_or(0, |d| d.peak),
        });
    }
    t.with_metrics(|m| {
        let l = [("check", check), ("size", size.as_str())];
        m.add("check_bytes_read", &l, bytes);
        m.add("check_cpu_us", &[("check", check)], cpu);
        m.add("event_check_cpu_us", &[("event", event)], cpu);
        if let Some(d) = mem {
            m.observe_bytes("check_mem_peak_bytes", &[("check", check)], d.peak);
            m.observe_bytes("check_mem_alloc_bytes", &[("check", check)], d.alloc);
            if d.retained > 0 {
                m.add("check_mem_retained_bytes", &[("check", check)], d.retained as u64);
            }
        }
        m.observe("check_latency_by_size_us", &l, micros);
        for (metric, label, value) in notes {
            m.inc(metric, &[(label, value)]);
        }
    });
}

impl crate::hookio::Observer for DaemonObserver<'_> {
    fn check(&self, check: &str, rule_id: &str, verdict: &crate::checks::Verdict, micros: u64) {
        crate::memdiag::note_check(check);
        observe_check_cost_in(self.t, self.event, check, micros);
        crate::obs::trace::push("check", check, telemetry::decision_name(verdict), micros);
        crate::web::decisions::push(self.event, check, rule_id, "", verdict, micros);
        if matches!(verdict, crate::checks::Verdict::Defer) {
            crate::obs::counters::handback_why(crate::obs::counters::Handback::Abandoned, &format!("check:{check}"), rule_id);
        }
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

fn cpu_budget(cfg: &Config) -> (u64, u64) {
    (limits::thread_cpu_us(), cfg.eval_budget_us)
}

fn over_cpu_budget(start: u64, budget: u64) -> bool {
    budget > 0 && limits::thread_cpu_us().saturating_sub(start) > budget
}

/// The SOFT cpu budget: the request used more thread CPU than `daemon.eval_soft_us`. Only logged and counted; the checks that ran
/// keep their answers.
fn note_cpu_soft(sh: &Shared, start: u64, cfg: &Config) {
    let used = limits::thread_cpu_us().saturating_sub(start);
    if cfg.eval_soft_us > 0 && used > cfg.eval_soft_us {
        sh.telemetry.with_metrics(|m| m.inc("budget_soft", &[]));
        let detail = defaults::render("msg.log_budget_soft", &[("used_us", &used), ("soft_us", &cfg.eval_soft_us), ("hard_us", &cfg.eval_budget_us)]);
        health::log_event("budget_soft", "-", &detail);
    }
}

fn record_budget_trip(sh: &Shared, project: &str, detail: &str) {
    sh.stats.budget_trips.fetch_add(1, SeqCst);
    sh.telemetry.with_metrics(|m| m.inc("budget_trips", &[]));
    sh.telemetry.fallback("budget", project);
    health::log_event("budget", "-", detail);
    crate::obs::trace::dump(defaults::text("diagnostics.trace_reason_cpu"));
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
    let (start, budget) = cpu_budget(cfg);
    let over = move || over_cpu_budget(start, budget);
    let event = crate::hookio::event_of(&p).unwrap_or(defaults::text("telemetry.no_event_label"));
    let obs = DaemonObserver { t: &sh.telemetry, project: &phash, event };
    let reply = match crate::hookio::respond_observed(&p, &rules, &over, &obs, env) {
        Ok(out) if out == crate::hookio::FALLBACK => Reply::Err(defaults::text("msg.reply_defer").into()),
        Ok(out) => Reply::Ok(out),
        Err(_) => {
            record_budget_trip(sh, &phash, defaults::text("msg.log_budget"));
            Reply::Err(defaults::text("msg.reply_budget").into())
        }
    };
    note_cpu_soft(sh, start, cfg);
    let micros = started.elapsed().as_micros() as u64;
    sh.telemetry.observe_hook(crate::hookio::event_of(&p).unwrap_or(""), micros);
    let (outcome, injected) = reply_outcome(&reply);
    sh.telemetry.record_hook(event, outcome, micros, injected);
    reply
}

/// `D <client-version>\n<meta JSON>\n<payload>`: the built-in checks of one event's dispatch table (D58), under the
/// same rate limits and telemetry as a hook request. The reply lists each check's answer; the client runs the rest.
fn dispatch(body: &str, sh: &Shared, cfg: &Config) -> Reply {
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
        crate::deadline::client_window(ms);
    }
    crate::deadline::set_event(&meta.event);
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
    let checks_us = std::cell::Cell::new(0u64);
    crate::load::set_transcript_size(
        p.get("transcript_path").and_then(|v| v.as_str()).filter(|t| !t.is_empty()).and_then(|t| std::fs::metadata(t).ok()).map(|m| m.len()),
    );
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
        observe_check_cost_in(&sh.telemetry, &meta.event, check, micros);
        checks_us.set(checks_us.get().saturating_add(micros));
        crate::web::decisions::push(&meta.event, check, &e.id, session, &v, micros);
        sh.telemetry.observe_check(check, &e.id, &v, micros, &phash);
    };
    let (start_cpu, budget) = cpu_budget(cfg);
    let over = || over_cpu_budget(start_cpu, budget);
    let answers = crate::dispatch::native::evaluate(&meta, &p, &over, &observe);
    if over() {
        record_budget_trip(sh, &phash, defaults::text("msg.log_budget"));
    }
    note_cpu_soft(sh, start_cpu, cfg);
    let wall = started.elapsed().as_micros() as u64;
    sh.telemetry.with_metrics(|m| m.observe("dispatch_overhead_us", &[("event", meta.event.as_str())], wall.saturating_sub(checks_us.get())));
    sh.telemetry.observe_hook(&meta.event, wall);
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

/// Read a whole request within `read_deadline` and `max` bytes. An ack-mode request (its head line announces its body length, see
/// `crate::wire`) is complete at that length, with the connection left open for the client's ACK(res); any other runs to end-of-stream.
/// The flag says which kind it was.
fn read_request(s: &mut UnixStream, cfg: &Config) -> Result<(Vec<u8>, bool), &'static str> {
    if s.set_nonblocking(true).is_err() {
        return Err(defaults::text("msg.reply_read_error"));
    }
    let deadline = Instant::now() + cfg.read_deadline;
    let (mut buf, mut chunk) = (Vec::new(), vec![0u8; defaults::num("io.small_chunk_bytes") as usize]);
    // (offset of the first body byte, total request length) once an ack-mode head line has been read
    let mut announced: Option<usize> = None;
    let mut head_checked = false;
    loop {
        if !head_checked && let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            head_checked = true;
            announced = crate::wire::announced_len(&String::from_utf8_lossy(buf.get(..nl).unwrap_or_default())).and_then(|n| (nl + 1).checked_add(n));
            if announced.is_some_and(|total| total as u64 > cfg.max_request) {
                return Err(defaults::text("msg.reply_too_large"));
            }
        }
        if let Some(total) = announced
            && buf.len() >= total
        {
            buf.truncate(total);
            return Ok((buf, true));
        }
        match s.read(&mut chunk) {
            Ok(0) if announced.is_some() => return Err(defaults::text("msg.reply_read_error")), // the client closed before its announced length arrived
            Ok(0) => return Ok((buf, false)),
            Ok(n) => {
                buf.extend_from_slice(chunk.get(..n).unwrap_or_default());
                if buf.len() as u64 > cfg.max_request && announced.is_none() {
                    return Err(defaults::text("msg.reply_too_large"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if !wait_stream(s, libc::POLLIN, deadline) {
                    return Err(defaults::text("msg.reply_read_deadline"));
                }
            }
            Err(_) => return Err(defaults::text("msg.reply_read_error")),
        }
    }
}

/// Write the reply; false when it could not be written (the client is gone or stopped reading).
fn write_reply(s: &mut UnixStream, r: &Reply, cfg: &Config) -> bool {
    write_reply_after(s, &[], r, cfg)
}

/// [`write_reply`] with `prefix` (an ack-mode client's fail-open line) written first, in the same stream.
fn write_reply_after(s: &mut UnixStream, prefix: &[u8], r: &Reply, cfg: &Config) -> bool {
    let mut frame = prefix.to_vec();
    frame.extend_from_slice(&r.frame());
    let mut written = 0;
    let deadline = Instant::now() + cfg.write_deadline;
    if let Err(e) = s.set_nonblocking(true) {
        REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
        health::log_event("reply", "write_failed", &e.to_string());
        return false;
    }
    // A failed write means the client sees a cut frame and falls back to Node (it never mistakes it for an answer); the
    // cause is logged here so a pattern of them is visible, and `reply_write_errors` counts them.
    while written < frame.len() {
        match s.write(&frame[written..]) {
            Ok(0) => {
                REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
                health::log_event("reply", "write_failed", defaults::text("msg.reply_write_deadline"));
                return false;
            }
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if !wait_stream(s, libc::POLLOUT, deadline) {
                    REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
                    health::log_event("reply", "write_failed", defaults::text("msg.reply_write_deadline"));
                    return false;
                }
            }
            Err(e) => {
                REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
                health::log_event("reply", "write_failed", &e.to_string());
                return false;
            }
        }
    }
    true
}

/// True when the peer has closed its end: an ack-mode client keeps the connection open until it has the verdict, so an end-of-stream
/// after the whole request means the client gave up on it (a write to a closed unix socket can still succeed, so the ack alone does not tell).
fn peer_gone(s: &UnixStream) -> bool {
    let mut byte = 0u8;
    // SAFETY: `recv` reads at most one byte into `byte`, a live local, from the socket's own descriptor; MSG_PEEK leaves the stream untouched.
    let n = unsafe { libc::recv(s.as_raw_fd(), (&mut byte as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) };
    n == 0
}

/// Write a short control line (an ack) within the write deadline; the error is why the client is unreachable.
fn write_line(s: &mut UnixStream, bytes: &[u8], cfg: &Config) -> Result<(), String> {
    let deadline = Instant::now() + cfg.write_deadline;
    let mut written = 0;
    while written < bytes.len() {
        match s.write(bytes.get(written..).unwrap_or_default()) {
            Ok(0) => return Err(defaults::text("msg.reply_write_deadline").into()),
            Ok(n) => written += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if !wait_stream(s, libc::POLLOUT, deadline) {
                    return Err(defaults::text("msg.reply_write_deadline").into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

/// What the client said after the reply.
enum ResWait {
    /// ACK(res) arrived, `after` the reply was written.
    Got(crate::wire::ClientPhases, Duration),
    /// No usable ACK(res), and why.
    Missing(&'static str),
}

/// Wait for the client's ACK(res) after the reply was written (`wire.res_wait_ms`). A client that went away closes its end, which
/// answers at once; only a live client that never confirms costs the whole wait.
fn wait_res(s: &mut UnixStream) -> ResWait {
    let began = Instant::now();
    let deadline = began + defaults::millis("wire.res_wait_ms");
    let (max, mut buf, mut chunk) = (defaults::num("wire.res_max_bytes") as usize, Vec::new(), vec![0u8; defaults::num("io.small_chunk_bytes") as usize]);
    loop {
        match s.read(&mut chunk) {
            Ok(0) => return ResWait::Missing(defaults::text("wire.why_closed")),
            Ok(n) => {
                buf.extend_from_slice(chunk.get(..n).unwrap_or_default());
                if let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                    return match crate::wire::parse_ack_res(&String::from_utf8_lossy(buf.get(..nl).unwrap_or_default())) {
                        Some(p) => ResWait::Got(p, began.elapsed()),
                        None => ResWait::Missing(defaults::text("wire.why_garbled")),
                    };
                }
                if buf.len() > max {
                    return ResWait::Missing(defaults::text("wire.why_garbled"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                if !wait_stream(s, libc::POLLIN, deadline) {
                    return ResWait::Missing(defaults::text("wire.why_timeout"));
                }
            }
            Err(_) => return ResWait::Missing(defaults::text("wire.why_closed")),
        }
    }
}

/// Record the phases of an ack-mode call: the daemon's own (queue wait, judging), the client's (connect, request to ACK, ACK to
/// response, which ride in ACK(res)), the delivery time measured here, and the launcher's counters; or the undelivered verdict.
fn record_wire(sh: &Shared, event: &str, queue_wait: Duration, judge: Duration, res: ResWait) {
    let ev = if event.is_empty() { defaults::text("wire.event_none") } else { event };
    let us = |d: Duration| d.as_micros() as u64;
    sh.telemetry.with_metrics(|m| {
        m.inc("wire_events", &[("kind", defaults::text("wire.kind_acked"))]);
        m.observe("hook_phase_us", &[("event", ev), ("phase", defaults::text("wire.phase_queue_wait"))], us(queue_wait));
        m.observe("hook_phase_us", &[("event", ev), ("phase", defaults::text("wire.phase_judge"))], us(judge));
        if let ResWait::Got(p, delivery) = &res {
            m.inc("wire_events", &[("kind", defaults::text("wire.kind_delivered"))]);
            m.observe("hook_phase_us", &[("event", ev), ("phase", defaults::text("wire.phase_connect"))], p.connect_us);
            m.observe("hook_phase_us", &[("event", ev), ("phase", defaults::text("wire.phase_req_ack"))], p.req_ack_us);
            m.observe("hook_phase_us", &[("event", ev), ("phase", defaults::text("wire.phase_ack_response"))], p.ack_response_us);
            m.observe("hook_phase_us", &[("event", ev), ("phase", defaults::text("wire.phase_delivery"))], us(*delivery));
            m.add("wire_events", &[("kind", defaults::text("wire.kind_retry"))], p.retries);
            let (startup, counters) = crate::wire::launcher_counters(&p.launcher);
            if let Some(n) = startup {
                m.observe("hook_phase_us", &[("event", ev), ("phase", defaults::text("wire.phase_launcher_startup"))], n);
            }
            for (name, n) in counters {
                m.add("launcher_counter", &[("name", name.as_str())], n);
            }
        }
    });
    if let ResWait::Missing(why) = res {
        crate::failopen::note(defaults::text("wire.reason_undelivered"), ev, &defaults::render("wire.msg_undelivered", &[("why", &why), ("event", &ev)]));
    }
}

fn wait_stream(s: &UnixStream, events: libc::c_short, deadline: Instant) -> bool {
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return false;
        };
        let mut timeout = remaining.as_millis().min(i32::MAX as u128) as i32;
        if timeout == 0 && !remaining.is_zero() {
            timeout = 1;
        }
        let mut pfd = libc::pollfd { fd: s.as_raw_fd(), events, revents: 0 };
        // SAFETY: `pfd` is a live, writable `pollfd` and the count passed is 1.
        let n = unsafe { libc::poll(&mut pfd, 1, timeout) };
        if n > 0 {
            return true;
        }
        if n == 0 {
            return false;
        }
        let e = std::io::Error::last_os_error();
        if e.kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
}

/// Replies finished after their client's deadline had passed (slow but healthy; counted apart from failures).
pub static SLOW_REPLIES: AtomicU64 = AtomicU64::new(0);

/// Replies the daemon could not write to their client (the client then falls back to Node).
pub static REPLY_WRITE_ERRORS: AtomicU64 = AtomicU64::new(0);

fn serve_conn(mut s: UnixStream, sh: &Shared, wait: Duration, in_flight: u64) -> After {
    s.set_nonblocking(false).ok_logged("daemon_socket_blocking");
    let started = Instant::now();
    crate::load::take_scan();
    crate::load::take_request();
    let cfg = sh.cfg();
    // the client stops waiting `client.deadline_ms` after it sent the request, which is about when it was accepted
    crate::deadline::begin(started.checked_sub(wait).unwrap_or(started));
    let (req, wire) = match read_request(&mut s, &cfg) {
        Ok(r) => r,
        Err(why) => {
            sh.stats.errors.fetch_add(1, SeqCst);
            sh.telemetry.with_metrics(|m| m.inc("errors", &[]));
            write_reply(&mut s, &Reply::Err(why.into()), &cfg);
            crate::deadline::end();
            return After::Continue;
        }
    };
    if req.is_empty() {
        // a connect-only liveness probe (the launcher's gate): the peer is already gone, so there is nothing to dispatch and no
        // reply to write (it used to cost a worker 6-40 ms and log `reply write_failed: Broken pipe`)
        sh.stats.probes.fetch_add(1, SeqCst);
        crate::deadline::end();
        return After::Continue;
    }
    if wire {
        // ACK(req): the request is read and will be judged. A client that already gave up (it closed after its ack timeout and
        // resent) refuses the write, and then nothing is judged: the resend is the only judging of that request.
        let gone = if peer_gone(&s) { Err(defaults::text("wire.why_closed").to_string()) } else { Ok(()) };
        if let Err(why) = gone.and_then(|()| write_line(&mut s, &crate::wire::ack_req(wait.as_micros() as u64), &cfg)) {
            sh.telemetry.with_metrics(|m| m.inc("wire_events", &[("kind", defaults::text("wire.kind_abandoned"))]));
            health::log_event("wire", defaults::text("wire.kind_abandoned"), &defaults::render("wire.msg_abandoned", &[("why", &why)]));
            crate::deadline::end();
            return After::Continue;
        }
    }
    if wire {
        // an ack-mode client keeps its connection open until it has the verdict: from here an end-of-stream means it gave up
        crate::deadline::watch_peer(s.as_raw_fd());
    }
    let acked_at = Instant::now();
    REQUEST_PEER.with(|c| c.set(crate::limits::peer_pid(&s)));
    let (request, event) = request_context(&req);
    let _breadcrumb = crate::crash::enter("request", &request, &event, "", "");
    health::write_crash_breadcrumb(&request, &event, "", sh.started.elapsed().as_secs(), sh.memory());
    telemetry::stage_begin();
    crate::failopen::begin_request();
    let mem_before = crate::memdiag::begin(cfg.effective.boolean("diagnostics.mem_log"));
    let (reply, after) = match catch_unwind(AssertUnwindSafe(|| handle_request_with(&req, sh, &cfg))) {
        Ok(r) => r,
        Err(_) => {
            sh.stats.panics.fetch_add(1, SeqCst);
            sh.telemetry.with_metrics(|m| m.inc("panics", &[]));
            health::log_event("panic", "panic", defaults::text("msg.log_panic"));
            health::record_failure("panic", "panic", defaults::text("msg.log_panic"));
            crate::failopen::note(defaults::text("fail_open.reason_internal"), &event, defaults::text("msg.log_panic"));
            (Reply::Err(defaults::text("msg.reply_internal").into()), After::Continue)
        }
    };
    let soft_scripts = crate::script::take_soft_overruns();
    if soft_scripts > 0 {
        sh.telemetry.with_metrics(|m| m.add("script_soft", &[], soft_scripts));
    }
    let gone_skips = crate::deadline::take_client_gone_skips();
    if gone_skips > 0 {
        sh.telemetry.with_metrics(|m| m.add("client_gone_skipped", &[], gone_skips));
    }
    let mem_after = mem_before.is_some().then(crate::memdiag::measure_after);
    crate::debug_log!(
        "daemon/request",
        defaults::render(
            "msg.dbg_request",
            &[
                ("request", &request),
                ("event", &event),
                ("depth", &sh.depth.load(SeqCst)),
                ("busy", &sh.busy_since.iter().filter(|b| b.load(SeqCst) != 0).count())
            ]
        )
    );
    let judge = acked_at.elapsed();
    match &reply {
        Reply::Busy => crate::failopen::note(
            defaults::text("fail_open.reason_busy"),
            if event.is_empty() { defaults::text("fail_open.check_none") } else { &event },
            defaults::text("msg.reply_busy_detail"),
        ),
        Reply::Err(why) if !why.is_empty() => crate::failopen::note(
            defaults::text("fail_open.reason_internal"),
            if event.is_empty() { defaults::text("fail_open.check_none") } else { &event },
            why,
        ),
        _ => {}
    }
    let fo_line = wire.then(|| crate::failopen::take_request().map(|(r, c)| crate::wire::fail_open_line(&r, &c))).flatten().unwrap_or_default();
    let late = crate::deadline::soft_remaining() == Some(Duration::ZERO);
    let delivered = write_reply_after(&mut s, &fo_line, &reply, &cfg);
    if delivered {
        sh.telemetry.stage_commit();
    } else {
        // the client never read it: what the request recorded is not a decision anyone saw (review finding 4)
        telemetry::stage_discard();
    }
    crate::deadline::settle_staged(delivered);
    let res = wire.then(|| if delivered { wait_res(&mut s) } else { ResWait::Missing(defaults::text("wire.why_closed")) });
    if late {
        // answered after the client's deadline: slow but healthy, which is not a failure of the engine
        SLOW_REPLIES.fetch_add(1, SeqCst);
        sh.telemetry.with_metrics(|m| m.inc("slow_replies", &[]));
        sh.telemetry.with_metrics(|m| m.inc("deadline_soft", &[]));
    }
    crate::deadline::end();
    let (event, session) = crate::load::take_request();
    crate::failopen::drain_into(&sh.telemetry);
    crate::failopen::sync_notice(false);
    if let Some(res) = res {
        record_wire(sh, &event, wait, judge, res);
    }
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
    let how = match &reply {
        Reply::Busy => crate::web::io::Served::FailOpen,
        Reply::Err(why) if !why.is_empty() => crate::web::io::Served::FailOpen,
        _ if late => crate::web::io::Served::Timeout,
        _ => crate::web::io::Served::Ok,
    };
    crate::web::io::client(session.as_deref(), how, started.elapsed().as_micros() as u64);
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

fn spawn_service(sh: &Arc<Shared>, name: &'static str, run: Arc<dyn Fn() + Send + Sync>) {
    let s = sh.clone();
    let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || s.draining.load(SeqCst));
    let s = sh.clone();
    let restart: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |thread| {
        let why = defaults::render("msg.thread_panic_restart", &[("thread", &thread)]);
        health::record_failure("panic", "thread_panic", &why);
        begin_drain(&s, &why, false);
    });
    crate::crash::spawn_supervised(name, stop, restart, run);
}

fn worker(sh: Arc<Shared>, idx: usize) {
    crate::deadline::set_beat(sh.busy_since[idx].clone(), sh.started);
    loop {
        let conn = {
            let mut q = lk(&sh.queue);
            loop {
                if let Some((c, queued_at, in_flight)) = q.pop_front() {
                    sh.depth.fetch_sub(1, SeqCst);
                    crate::invariant!(
                        "daemon/queue",
                        sh.depth.load(SeqCst) == q.len(),
                        defaults::render("msg.inv_queue_pop", &[("depth", &sh.depth.load(SeqCst)), ("len", &q.len())])
                    );
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
            crate::script::maintain(true);
            crate::memdiag::worker_tick(idx);
            continue;
        };
        sh.busy_since[idx].store(sh.ms() + 1, SeqCst);
        let after = serve_conn(conn, &sh, wait, in_flight);
        sh.busy_since[idx].store(0, SeqCst);
        crate::script::maintain(false);
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
        crate::wire::withdraw();
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

/// True when the accept loop counts as stalled at `now` (ms since the daemon's start) given its last beat. A beat of 0 = the
/// loop has not run its first round: the daemon is still starting (database open, spool drain, scheduler and wiring start),
/// judged by the longer `start_stall_ms`. `ended` = the loop returned (a clean drain): what follows is the shutdown tail
/// (telemetry flush, database close), bounded by the drain timer; a loop that has ended is not a loop that stalled.
fn loop_stalled(beat: u64, ended: bool, now: u64, stall_ms: u64, start_stall_ms: u64) -> bool {
    if ended {
        return false;
    }
    if beat == 0 {
        return now > start_stall_ms;
    }
    now.saturating_sub(beat) > stall_ms
}

fn watchdog(sh: Arc<Shared>) {
    let mut last_rss = Instant::now();
    let mut last_idle_check = Instant::now();
    let mut last_cpu_check = Instant::now();
    let mut last_cpu_secs = limits::process_cpu_secs();
    let mut debug_sampler = crate::debug::Sampler::new();
    health::heartbeat_init();
    loop {
        std::thread::sleep(sh.cfg().watchdog_tick);
        health::heartbeat();
        // the stall and stuck checks keep running while draining: a drain waits for its workers, so one stuck there would
        // otherwise hold the process (and the singleton lock) until the drain timer. Once a forced exit is scheduled there
        // is nothing left to decide, and a check that kept firing would log the same failure every tick (each one counts
        // toward the client's crash-loop rule).
        if sh.forced_timer.load(SeqCst) {
            continue;
        }
        if sh.cfg().test_hooks && sh.test_thread_panics.load(SeqCst) > 0 {
            sh.test_thread_panics.fetch_sub(1, SeqCst);
            std::panic::resume_unwind(Box::new(defaults::text("msg.reply_test_panic").to_string()));
        }
        let draining = sh.draining.load(SeqCst);
        let cfg = sh.cfg();
        let now = sh.ms();
        // debug mode follows the setting without a restart; while on, the samplers log per-thread CPU and memory
        if let Some(on) = crate::debug::apply_config(cfg.effective.boolean("diagnostics.debug_mode")) {
            health::log_event("debug", if on { "on" } else { "off" }, defaults::text(if on { "msg.log_debug_on" } else { "msg.log_debug_off" }));
        }
        debug_sampler.tick(|| sh.memory());
        crate::invariant!(
            "daemon/watchdog",
            sh.busy_since.iter().filter(|b| b.load(SeqCst) != 0).count() <= cfg.workers,
            defaults::render("msg.inv_busy_workers", &[("workers", &cfg.workers)])
        );
        if loop_stalled(sh.loop_beat.load(SeqCst), sh.loop_ended.load(SeqCst), now, cfg.stall.as_millis() as u64, cfg.start_stall.as_millis() as u64) {
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
        let cpu_check = defaults::millis("daemon.cpu_check_ms");
        if !cpu_check.is_zero() && last_cpu_check.elapsed() >= cpu_check {
            let wall = last_cpu_check.elapsed().as_secs_f64();
            let cpu_now = limits::process_cpu_secs();
            let cpu_delta = (cpu_now - last_cpu_secs).max(0.0);
            last_cpu_check = Instant::now();
            last_cpu_secs = cpu_now;
            let warn_pct = cfg.effective.num("daemon.cpu_warn_pct") as f64;
            let pct = if wall > 0.0 { cpu_delta * 100.0 / wall } else { 0.0 };
            crate::debug_log!("daemon/cpu", defaults::render("msg.dbg_cpu_window", &[("ms", &format!("{:.0}", wall * 1000.0)), ("pct", &format!("{pct:.2}"))]));
            let edge = lk(&sh.budget).cpu_window(pct, cfg.effective.num("diagnostics.budget_cpu_pct"), cfg.effective.num("diagnostics.budget_cpu_windows"));
            report_budget_edge(edge, &format!("{pct:.1}"), cfg.effective.num("diagnostics.budget_cpu_pct"), "msg.log_budget_cpu");
            crate::nodeback::shadow::hold(lk(&sh.budget).mask() & 1 == 1); // the Node shadow starts nothing while the CPU budget is breached
            let hard_edge = lk(&sh.budget).cpu_hard_window(
                pct,
                cfg.effective.num("diagnostics.budget_cpu_hard_pct"),
                cfg.effective.num("diagnostics.budget_cpu_pct"),
                cfg.effective.num("diagnostics.budget_cpu_windows"),
            );
            if let Some(began) = hard_edge {
                let state = defaults::text(if began { "msg.state_shed_on" } else { "msg.state_shed_off" });
                let (limit, soft) = (cfg.effective.num("diagnostics.budget_cpu_hard_pct"), cfg.effective.num("diagnostics.budget_cpu_pct"));
                health::log_event("budget", "cpu_hard", &defaults::render("msg.log_budget_cpu_hard", &[("state", &state), ("value", &format!("{pct:.1}")), ("limit", &limit), ("soft", &soft)]));
            }
            if crate::budget::shedding() {
                // background duties wait: the same backoff the sustained-CPU warning uses, renewed every window while shedding
                if let Some(sched) = sh.sched.get() {
                    sched.backoff_for(cfg.effective.num("schedule.cpu_backoff_ms"));
                }
            }
            if warn_pct > 0.0 && pct >= warn_pct {
                let backoff_ms = cfg.effective.num("schedule.cpu_backoff_ms");
                if let Some(sched) = sh.sched.get() {
                    sched.backoff_for(backoff_ms);
                }
                let pct_s = format!("{pct:.1}");
                health::log_event(
                    "cpu",
                    "sustained",
                    &defaults::render("msg.log_cpu_sustained", &[("pct", &pct_s), ("ms", &cpu_check.as_millis()), ("backoff_ms", &backoff_ms)]),
                );
            }
        }
        crate::binguard::note_uptime(sh.started.elapsed());
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
        leak_sentinel(&sh);
        if last_rss.elapsed() >= cfg.rss_check {
            last_rss = Instant::now();
            let rss = limits::rss_kb();
            let mem = limits::mem_kb();
            sh.rss_kb.store(rss, SeqCst);
            sh.rss_peak_kb.fetch_max(rss, SeqCst);
            let mem_limit = cfg.effective.num("diagnostics.budget_mem_mb");
            let edge = lk(&sh.budget).mem_sample(mem, mem_limit);
            report_budget_edge(edge, &(mem / 1024).to_string(), mem_limit, "msg.log_budget_mem");
            // the memory registry's process-wide check: shrink at the global soft limit, recycle at the hard one, and a clean
            // restart (the same drain as the cap below, with the reason recorded) when it stays over the hard limit
            if let Some(r) = crate::mem::global().tick(mem.saturating_mul(1024), now) {
                crate::obs::trace::dump(defaults::text("diagnostics.trace_reason_mem"));
                health::log_event("memory", "breakdown", &sh.memory_line());
                begin_drain(&sh, &crate::mem::restart_reason(&r), true);
                continue;
            }
            if cfg.rss_cap_kb > 0 && mem > cfg.rss_cap_kb && !sh.rss_tripped.swap(true, SeqCst) {
                health::log_event("rss", "rss", &defaults::render("msg.log_rss", &[("rss", &mem), ("cap", &cfg.rss_cap_kb)]));
                crate::obs::trace::dump(defaults::text("diagnostics.trace_reason_rss"));
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

/// The leak sentinel's step (mem::leak): sample when due; on a suspected leak write the evidence file, log the notice and record
/// the impact. Detection only: nothing is restarted or killed.
fn leak_sentinel(sh: &Arc<Shared>) {
    let now_s = health::now_ms() / 1000;
    if !crate::mem::leak::due(sh.started.elapsed().as_secs(), now_s) {
        return;
    }
    let Some(n) = crate::mem::leak::observe(crate::mem::leak::collect(now_s)) else { return };
    let line = match crate::mem::leak::write_evidence(sh.memory_with_ledger(), health::now_ms()) {
        Ok(p) => format!("{} [{}]", n.text, p.display()),
        Err(e) => format!("{} [evidence not written: {e}]", n.text),
    };
    health::log_event("memory", "leak", &line);
    let kind = defaults::text("mem.leak_impact_kind");
    sh.telemetry.impact(kind, &n.top, crate::mem::leak::Level::Suspected.name(), "");
    sh.telemetry.with_metrics(|m| m.inc("memory_leak_notices", &[("top", &n.top)]));
}

/// Log the start or the end of a budget breach (one line per change, never one per sample).
fn report_budget_edge(edge: crate::budget::Edge, value: &str, limit: u64, msg: &str) {
    if let Some((bit, began)) = edge {
        let which = bit.name();
        let state = defaults::text(if began { "msg.state_budget_over" } else { "msg.state_budget_within" });
        health::log_event("budget", which, &defaults::render(msg, &[("state", &state), ("value", &value), ("limit", &limit)]));
    }
}

/// Whether a cap trip writes the memory snapshot before it drains.
fn cfg_snapshot_on(sh: &Shared) -> bool {
    sh.cfg().effective.boolean("diagnostics.mem_snapshot")
}

struct LockHolder {
    pid: String,
    live_engine: bool,
    answers: bool,
}

/// Take the singleton lock. Waits briefly for an outgoing (version-handoff) daemon to release it, but
/// gives up at once if a live daemon is already answering on the socket.
fn acquire_lock(lock_path: &Path, sock: &Path) -> Result<Result<std::fs::File, LockHolder>, std::io::Error> {
    let f = std::fs::OpenOptions::new().create(true).read(true).write(true).truncate(false).open(lock_path)?;
    let start = Instant::now();
    loop {
        // SAFETY: `f` is an open file owned by this scope, so its descriptor is valid; `flock` takes only the descriptor and a flag.
        if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Ok(f));
        }
        let holder = lock_holder(lock_path, sock);
        if holder.answers {
            return Ok(Err(holder));
        }
        if start.elapsed() > defaults::millis("daemon.lock_wait_ms") {
            // the lock is held but nothing answers on the socket: a daemon that is draining, wedged, or gone without
            // releasing it; this start gives up (the client falls back to Node), and the line says why
            health::log_event(
                "lock_wait",
                "no_daemon",
                &defaults::render("msg.log_lock_no_daemon", &[("path", &lock_path.display()), ("pid", &holder.pid), ("live_engine", &holder.live_engine)]),
            );
            return Ok(Err(holder));
        }
        std::thread::sleep(defaults::millis("daemon.lock_poll_ms"));
    }
}

fn lock_holder(lock_path: &Path, sock: &Path) -> LockHolder {
    let pid = std::fs::read_to_string(lock_path).unwrap_or_default().trim().to_string();
    let live_engine = pid.parse::<u32>().is_ok_and(health::pid_is_engine);
    LockHolder { pid, live_engine, answers: crate::client::ping(sock).is_some() }
}

fn same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

fn real_home() -> Option<std::path::PathBuf> {
    // SAFETY: getpwuid reads the system passwd entry for this uid; a null result is handled below.
    let pwd = unsafe { libc::getpwuid(libc::getuid()) };
    if pwd.is_null() {
        return None;
    }
    // SAFETY: `pwd` is non-null and `pw_dir` is a NUL-terminated C string owned by libc for the life of this call.
    let dir = unsafe { std::ffi::CStr::from_ptr((*pwd).pw_dir) }.to_string_lossy();
    (!dir.is_empty()).then(|| std::path::PathBuf::from(dir.as_ref()))
}

fn live_state_dir(dir: &Path) -> bool {
    let Some(home) = real_home() else { return false };
    [
        home.join(defaults::text("paths.base_dir")).join(defaults::text("paths.state_dir")),
        home.join(defaults::text("paths.base_dir")).join(defaults::text("paths.live_state_dir")),
    ]
    .iter()
    .any(|p| same_path(dir, p))
}

/// What a running daemon stands on: its state directory, the lock file it holds (by inode), its socket, parent and executable.
#[derive(Clone)]
struct Footing {
    dir: std::path::PathBuf,
    lock: std::path::PathBuf,
    lock_ino: u64,
    sock: Option<(std::path::PathBuf, u64)>,
    parent: Option<libc::pid_t>,
    exe: Option<std::path::PathBuf>,
}

impl Footing {
    /// Why the daemon has lost its footing, if it has: the state directory or the executable is gone, or the lock file is
    /// gone or replaced (a new daemon could then start beside this one), or for non-live daemons the parent or socket is gone.
    fn lost(&self) -> Option<&'static str> {
        if !self.dir.is_dir() {
            return Some("state_dir_gone");
        }
        if std::fs::metadata(&self.lock).map(|m| m.ino()).ok() != Some(self.lock_ino) {
            return Some("lock_gone");
        }
        if let Some((sock, ino)) = &self.sock
            && std::fs::symlink_metadata(sock).map(|m| m.ino()).ok() != Some(*ino)
        {
            return Some("socket_gone");
        }
        if let Some(parent) = self.parent {
            // SAFETY: getppid takes no arguments and cannot fail.
            if unsafe { libc::getppid() } != parent {
                return Some("parent_gone");
            }
        }
        if self.exe.as_ref().is_some_and(|e| !e.exists()) {
            return Some("binary_gone");
        }
        None
    }
}

/// Every `daemon.orphan_check_ms`, check the daemon's [`Footing`]; once lost, log why and drain (a clean exit). The idle exit
/// (`daemon.idle_exit_s`) covers a daemon nobody talks to; this covers one whose files, parent, or socket were removed under it.
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
    crate::crash::mark_daemon(true);
    // SAFETY: getppid takes no arguments and cannot fail. Capture it before any startup work so a scratch daemon whose
    // launcher dies during config/defaults loading still knows which parent it was started by.
    let initial_parent = unsafe { libc::getppid() };
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
        Ok(Ok(l)) => l,
        Ok(Err(holder)) => {
            eprintln!(
                "{}",
                defaults::render(
                    "msg.daemon_already_running",
                    &[("path", &sock.display()), ("pid", &holder.pid), ("live_engine", &holder.live_engine), ("answers", &holder.answers)]
                )
            );
            return;
        }
        Err(e) => start_fail(&io_code(&e), &defaults::render("msg.log_lock_fail", &[("path", &lock_path.display()), ("err", &e)])),
    };
    // We hold the flock, so no other daemon owns this socket. Verify before touching anything: if the
    // pid recorded in the lock file is still a live engine (flock not honoured here), do not steal.
    let prev: u32 = std::fs::read_to_string(&lock_path).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0);
    if prev != 0 && prev != std::process::id() && health::pid_is_engine(prev) && crate::client::ping(&sock).is_some() {
        return;
    }
    crate::memdiag::apply_decay_if_untuned();
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
    listener.set_nonblocking(true).ok_logged("daemon_listener_nonblocking");
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
    crate::client::release_spawn_lock();
    crate::dispatch::sweep_stale_spool();

    crate::mem::register_defaults_leak();
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
    crate::memstat::configure_measure_from_defaults(); // the per-call memory knobs, from the defaults the owner's files overlay
    let sh = Arc::new(sh);
    {
        let s = sh.clone();
        crate::db::set_panic_restart(Some(Arc::new(move |thread| {
            let why = defaults::render("msg.thread_panic_restart", &[("thread", &thread)]);
            begin_drain(&s, &why, false);
        })));
    }
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
    crate::wire::announce();
    for i in 0..sh.cfg().workers {
        let s = sh.clone();
        let name: &'static str = "worker";
        spawn_service(&sh, name, Arc::new(move || worker(s.clone(), i)));
    }
    {
        let s = sh.clone();
        spawn_service(&sh, "watchdog", Arc::new(move || watchdog(s.clone())));
    }
    {
        // the daemon's footing, as it is now: a test (or an uninstall) that removes the state dir or the binary under a
        // running daemon must not leave it running for hours with nothing that can reach or stop it
        let non_live = !live_state_dir(&paths::dir());
        let sock_footing = non_live.then(|| std::fs::symlink_metadata(&sock).ok().map(|m| (sock.clone(), m.ino()))).flatten();
        let parent = non_live.then_some(initial_parent);
        let footing = Footing {
            dir: paths::dir(),
            lock: lock_path.clone(),
            lock_ino: lock.metadata().map(|m| m.ino()).unwrap_or(0),
            sock: sock_footing,
            parent,
            exe: std::env::current_exe().ok(),
        };
        let s = sh.clone();
        spawn_service(&sh, "footing_watch", Arc::new(move || footing_watch(s.clone(), footing.clone())));
    }
    start_scheduler(&sh);
    start_devswarm(&sh);
    // the guards' first interpreter probes, warmed in the background: the first guard call after the start finds them kept
    crate::discard::logged("probe_prewarm_thread", std::thread::Builder::new().name("ah-probe-prewarm".into()).spawn(crate::script::host_spawn::prewarm));
    {
        let s = sh.clone();
        spawn_service(&sh, "telemetry_flusher", Arc::new(move || telemetry_flusher(s.clone())));
    }
    accept_loop(&sh, &listener);
    sh.loop_ended.store(true, SeqCst); // the shutdown tail below is bounded by the drain timer, not judged as a stalled loop
    crate::wire::withdraw();
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
    // `devswarm_rt.mode` is read from the daemon's live configuration, so an edit (on, observe, off) takes effect without a restart
    let weak = Arc::downgrade(sh);
    let mode: crate::dswire::ModeSource = Box::new(move || {
        weak.upgrade().map_or(crate::devswarm_rt::Mode::Off, |sh| crate::devswarm_rt::Mode::parse(&sh.cfg().effective.text("devswarm_rt.mode")))
    });
    crate::dswire::Wire::start_with(&home, &paths::dir(), sh.db.clone(), sink, stop.clone(), mode); // None is the inert case: nothing was started
    // the native ingest drain: nothing at all unless devswarm_ingest.mode is `engine` (the Node ingest daemons drain otherwise)
    let s = sh.clone();
    let restart: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |thread| {
        let why = defaults::render("msg.thread_panic_restart", &[("thread", &thread)]);
        begin_drain(&s, &why, false);
    });
    crate::dssup::ingest::start(&home, &paths::dir(), stop, restart);
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
            "test_panic" if sh.cfg().test_hooks => std::panic::resume_unwind(Box::new(defaults::text("msg.reply_test_panic").to_string())),
            "shadow_report" => crate::nodeback::report::scheduled(),
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
    let weak = Arc::downgrade(sh);
    sched.set_cpu_observer(Box::new(move |job, us| {
        if let Some(sh) = weak.upgrade() {
            sh.telemetry.with_metrics(|m| m.add("schedule_cpu_us", &[("job", job)], us));
        }
    }));
    crate::discard::harmless(sh.sched.set(sched.clone())); // keep: best effort, fail-open
    let s = sh.clone();
    spawn_service(sh, "scheduler", Arc::new(move || sched.run_ticker(&|| s.draining.load(SeqCst))));
}

/// The `schedule` control verb: `list`, `run job=<name>`, `history [job=<name>] [limit=<n>]`.
fn schedule_ctl(sh: &Shared, args: &str) -> serde_json::Value {
    let Some(sched) = sh.sched.get() else { return serde_json::json!({"running": true, "jobs": []}) };
    match args.split_whitespace().next().unwrap_or("list") {
        "run" => sched.run_now(&kv(args, "job")),
        "history" => {
            let limit = kv(args, "limit").parse().unwrap_or(defaults::num("schedule.history_default") as usize);
            let runs = sh
                .db
                .as_ref()
                .and_then(|db| db.read(|c| crate::schedule::history(c, &kv(args, "job"), limit)).ok_logged("schedule_history_read"))
                .unwrap_or_default();
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
        sh.loop_beat.store(sh.ms().max(1), SeqCst); // never the not-started value
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
            sh.loop_beat.store(sh.ms().max(1), SeqCst);
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
                crate::failopen::note(defaults::text("fail_open.reason_busy"), defaults::text("fail_open.check_none"), defaults::text("msg.reply_busy_detail"));
                crate::failopen::drain_into(&sh.telemetry);
                let mut s = s;
                s.set_nonblocking(true).ok_logged("daemon_busy_nonblocking");
                let frame = Reply::Busy.frame();
                match s.write(&frame) {
                    Ok(n) if n == frame.len() => {}
                    Ok(_) => {
                        REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
                    }
                    Err(_) => {
                        REPLY_WRITE_ERRORS.fetch_add(1, SeqCst);
                    }
                };
            } else {
                // requests ahead of this one: the queued ones and those a worker is serving now
                let in_flight = q.len() as u64 + sh.busy_since.iter().filter(|b| b.load(SeqCst) != 0).count() as u64;
                q.push_back((s, Instant::now(), in_flight));
                sh.depth.fetch_add(1, SeqCst);
                crate::invariant!(
                    "daemon/queue",
                    sh.depth.load(SeqCst) == q.len(),
                    defaults::render("msg.inv_queue_push", &[("depth", &sh.depth.load(SeqCst)), ("len", &q.len())])
                );
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
    fn the_watchdog_judges_startup_and_shutdown_by_their_own_clocks_not_the_loops() {
        // 18:45Z deploy: a clean shutdown whose tail (flush + db close) outlasted stall_ms was killed as "accept loop stalled";
        // the same applied to a start whose pre-loop work outlasted it
        assert!(!loop_stalled(10_000, true, 600_000, 5_000, 60_000), "a loop that returned is draining, not stalled");
        assert!(!loop_stalled(0, false, 30_000, 5_000, 60_000), "startup work longer than stall_ms is not a stall");
        assert!(loop_stalled(0, false, 61_000, 5_000, 60_000), "a start that never reaches the loop is still caught");
        assert!(loop_stalled(10_000, false, 15_001, 5_000, 60_000), "a running loop silent past stall_ms is a stall");
        assert!(!loop_stalled(10_000, false, 15_000, 5_000, 60_000));
    }

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
    /// `diagnostics.check_mem` follows a config reload: a knob switched off by hand comes back from the defaults.
    #[test]
    fn a_config_reload_re_applies_the_per_call_memory_knob() {
        let sh = shared();
        crate::memstat::configure_measure(false, 1);
        sh.reload_config();
        assert!(crate::memstat::measure_enabled(), "diagnostics.check_mem is true in the shipped defaults");
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
    #[test]
    fn a_budget_breach_shows_in_the_health_event_and_in_status() {
        let sh = shared();
        let fields = |ev: &crate::telemetry::event::Event| {
            let crate::telemetry::event::Extras::Fields(f) = &ev.extras else { panic!("fields") };
            (f.get_num("cpu_permille"), f.get_num("budget_breach"))
        };
        assert_eq!(fields(&sh.health_event()), (Some(0), Some(0)), "within budget at the start");
        {
            let mut b = lk(&sh.budget);
            b.cpu_window(7.5, 2, 1);
            b.mem_sample(300 * 1024, 100);
        }
        assert_eq!(fields(&sh.health_event()), (Some(75), Some(3)));
        let st: serde_json::Value = serde_json::from_str(&sh.status()).unwrap();
        assert_eq!(st["budget"]["breached"], serde_json::json!(["cpu", "mem"]));
        assert_eq!(st["budget"]["cpu_budget_pct"], sh.cfg().effective.num("diagnostics.budget_cpu_pct"));
        assert_eq!(st["budget"]["mem_budget_mb"], sh.cfg().effective.num("diagnostics.budget_mem_mb"));
        assert!(st["debug"]["enabled"].is_boolean());
    }
}
