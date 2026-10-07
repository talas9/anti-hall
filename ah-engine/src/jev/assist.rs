//! The Jev decision layer: per-integration modes, the trust rule, the cache, the budget and the one log row.
//!
//! Mirrors `hooks/lib/jev-assist.js` (`ask`, `finalize`, `computeFinal`, `computeCostUsd`, `recordOutcome`, `prepare`).
//! This layer never decides anything on its own authority. Every result is gated by the caller's `baseline` and trust
//! rule, and every failure (disabled, off, no key, over budget, timeout, bad response, queue full, log I/O error)
//! degrades to the caller's `baseline`: with Jev off, missing or failing, behaviour equals the deterministic non-Jev
//! path (D35). Nothing here runs on the hot path while Jev is off: the call returns after one clock read and one
//! settings snapshot, with no hashing, no cache lookup, no network and no log I/O. The one I/O an off call can cause is
//! the settings re-check: at most one `stat` of each of the two settings files per `jev.settings_recheck_ms` (and none
//! between), taken by whichever call finds the window elapsed; [`Jev::reload`] is the notification path that replaces it.
//!
//! Trust rules (D36). Jev may ADD a block or advisory, and an explicitly enabled relax-block integration may remove a
//! blocking baseline when Jev confidently says the block should not stand:
//!
//! * [`Trust::AddBlock`]: `final = baseline || (confident && jev == true)`.
//! * [`Trust::Advisory`]: a baseline of `true` stays `true`; otherwise `final = jev` when confident, else the baseline
//!   (a label-valued baseline or none is how a classification advisory is produced).
//! * [`Trust::RelaxBlock`]: a non-blocking baseline stays as-is and is not consulted; a blocking baseline becomes
//!   non-blocking only when the integration is `on`, the answer is confident, and Jev's decision is `false`.
//!
//! Modes: `off` consults nothing, `shadow` consults and logs but never changes the outcome, `on` lets the trust rule
//! apply. `changed` is `"added"`, `"changed"` or `null`; `wouldChange` reports what the rule would have done had the mode
//! been `on`, so `jev report` can judge a shadow integration before it is trusted.
use super::breaker::{Breakers, Clock, SystemClock, WallClock};
use super::cache::{Cached, JevCache, MemCache};
use super::client::{Answer, CallResult, JevClient};
use super::credentials::resolve_key;
use super::error::Reason;
use super::log::{DecisionLog, FileLog, Row};
use super::question::Question;
use super::settings::{Env, Files, JevSettings, Mode, Sources, Vendor};
use super::transport::{HttpTransport, Transport, endpoint_for};
use crate::defaults;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, SystemTime};

/// How far Jev may move a caller's baseline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    /// Jev may only turn a non-blocking baseline into a block.
    AddBlock,
    /// Jev may only add an advisory or supply a label; a baseline of `true` stays.
    Advisory,
    /// Jev may relax a blocking baseline when this integration is explicitly on.
    RelaxBlock,
}

/// Normalises a Jev answer into the true/false space the trust rules work in (for a Choice question).
pub type Judge = Arc<dyn Fn(&Answer) -> bool + Send + Sync>;

/// One decision to ask Jev about.
#[derive(Clone)]
pub struct AskRequest {
    /// The integration id (a key of the `jev.integrations` table).
    pub id: String,
    /// The question.
    pub question: Question,
    /// The text Jev evaluates (scrubbed on the way out).
    pub state: String,
    /// The trust rule.
    pub trust: Trust,
    /// The caller's own deterministic verdict: a boolean, a label, or `null`.
    pub baseline: Value,
    /// Cache on this instead of the text.
    pub cache_key: Option<String>,
    /// Per-call time budget in milliseconds, capped at the ceiling.
    pub budget_ms: Option<u64>,
    /// An independent verdict for the report's agreement metric (not the baseline).
    pub compare: Option<bool>,
    /// The project name for `jev report --by project`; the working-directory name when absent.
    pub project: Option<String>,
    /// The session, when the caller has one.
    pub session_id: Option<String>,
    /// A short pointer to the turn the decision was about.
    pub turn_ref: Option<String>,
    /// Report a would-change whenever Jev's answer differs from the baseline (label-only integrations).
    pub record_disagreement: bool,
    /// Normalise a non-boolean answer.
    pub judge: Option<Judge>,
    /// The calling session's environment (D76): the switches, keys and kill switches this decision obeys. `None` uses the
    /// engine's own environment, which is only right for a single-user process such as the one-shot CLI.
    pub env: Option<Env>,
}

impl AskRequest {
    /// A request with the optional fields empty.
    pub fn new(id: &str, question: Question, state: &str, trust: Trust, baseline: Value) -> AskRequest {
        AskRequest {
            id: id.to_string(),
            question,
            state: state.to_string(),
            trust,
            baseline,
            cache_key: None,
            budget_ms: None,
            compare: None,
            project: None,
            session_id: None,
            turn_ref: None,
            record_disagreement: false,
            judge: None,
            env: None,
        }
    }
}

/// Where a decision's answer came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// A fresh Jev call.
    Jev,
    /// The cache.
    Cache,
    /// No answer: the baseline stands.
    BaselineOnly,
}

impl Backend {
    /// The name written in the log and used as a metric label.
    pub fn as_str(self) -> &'static str {
        match self {
            Backend::Jev => "jev",
            Backend::Cache => "cache",
            Backend::BaselineOnly => "baseline-only",
        }
    }
}

/// Where a cost figure came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostSource {
    /// A cache hit: no new inference, so zero.
    Cache,
    /// The vendor reported the cost.
    Gateway,
    /// Real token counts priced from the owner's `prices` table.
    PriceTable,
    /// Real token counts priced at the built-in published rate.
    DefaultPrice,
}

impl CostSource {
    /// The name written in the log's `costSource` field.
    pub fn as_str(self) -> &'static str {
        match self {
            CostSource::Cache => "cache",
            CostSource::Gateway => "gateway",
            CostSource::PriceTable => "price-table",
            CostSource::DefaultPrice => "default-price",
        }
    }
}

/// What the caller gets back.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    /// The outcome the caller should act on: the baseline unless the mode and trust rule let Jev change it.
    pub outcome: Value,
    /// Jev's answer (`null` when there was none).
    pub jev: Value,
    /// The caller's baseline, unchanged.
    pub baseline: Value,
    /// Jev's confidence, when it answered.
    pub confidence: Option<f64>,
    /// Whether the confidence met the threshold, when Jev answered.
    pub confident: Option<bool>,
    /// Milliseconds the call took (0 for a cache hit or no call).
    pub ms: u64,
    /// Where the answer came from.
    pub backend: Backend,
    /// Why there was no answer.
    pub reason: Option<Reason>,
    /// The content hash (also the log's `h`).
    pub hash: String,
    /// Cost of this decision in USD, when known.
    pub cost_usd: Option<f64>,
    /// Where the cost came from.
    pub cost_source: Option<CostSource>,
    /// True when the outcome differs from the baseline.
    pub changed: bool,
}

/// Counters the engine folds into its metrics (D51).
#[derive(Default)]
pub struct JevStats {
    calls: Mutex<Vec<((&'static str, &'static str), u64)>>,
    timeouts: AtomicU64,
    cooldowns: AtomicU64,
    changed: AtomicU64,
    cost_micro_usd: AtomicU64,
    verdicts: Mutex<Vec<((String, &'static str), u64)>>,
    latencies_us: Mutex<Vec<u64>>,
}

impl JevStats {
    fn call(&self, backend: Backend, mode: Mode) {
        let key = (backend.as_str(), mode.as_str());
        let mut g = self.calls.lock().unwrap_or_else(|e| e.into_inner());
        match g.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 += 1,
            None => g.push((key, 1)),
        }
    }

    fn verdict(&self, id: &str, verdict: &'static str) {
        let mut g = self.verdicts.lock().unwrap_or_else(|e| e.into_inner());
        match g.iter_mut().find(|((i, v), _)| i == id && *v == verdict) {
            Some(slot) => slot.1 += 1,
            None => g.push(((id.to_string(), verdict), 1)),
        }
    }

    /// Move the counts gathered since the last call into `m` and reset them.
    pub fn drain_into(&self, m: &mut crate::metrics::Metrics) {
        for ((backend, mode), n) in std::mem::take(&mut *self.calls.lock().unwrap_or_else(|e| e.into_inner())) {
            m.add("jev_calls", &[("backend", backend), ("mode", mode)], n);
        }
        m.add("jev_timeouts", &[], self.timeouts.swap(0, Ordering::Relaxed));
        m.add("jev_cooldowns", &[], self.cooldowns.swap(0, Ordering::Relaxed));
        m.add("jev_changed", &[], self.changed.swap(0, Ordering::Relaxed));
        m.add("jev_cost_micro_usd", &[], self.cost_micro_usd.swap(0, Ordering::Relaxed));
        for ((id, verdict), n) in std::mem::take(&mut *self.verdicts.lock().unwrap_or_else(|e| e.into_inner())) {
            m.add("jev_verdicts", &[("id", &id), ("verdict", verdict)], n);
        }
        for us in std::mem::take(&mut *self.latencies_us.lock().unwrap_or_else(|e| e.into_inner())) {
            m.observe("jev_latency_us", &[], us);
        }
    }
}

/// The resolved settings, re-checked at most every `jev.settings_recheck_ms`. One load of the files serves every
/// session: the files are shared, the environment is the calling session's (D76), and each distinct environment's
/// resolution is memoized (a small bounded set) until a file changes.
struct SettingsCache {
    home: PathBuf,
    default_env: Env,
    clock: Arc<dyn Clock>,
    state: Mutex<Resolved>,
}

/// The parsed files, the stamps they were read at, when they were last checked, and the memoized resolutions.
struct Resolved {
    files: Files,
    stamps: Vec<Option<(SystemTime, u64)>>,
    checked_ms: u64,
    default: Arc<JevSettings>,
    by_env: Vec<(String, Arc<JevSettings>)>,
}

/// Resolve the settings and, the first time in this process that a test endpoint override is refused for a non-loopback
/// host, say so once on stderr (Node: `endpointRejectionLogged`). The message never names the URL or a key.
fn resolve_settings(home: &Path, files: &Files, env: &Env) -> Arc<JevSettings> {
    static REPORTED: AtomicBool = AtomicBool::new(false);
    let s = JevSettings::resolve(home, Sources::with_files(files.clone(), env.clone()));
    if s.override_refused && !REPORTED.swap(true, Ordering::Relaxed) {
        eprintln!("{}", defaults::text("msg.jev_endpoint_ignored"));
    }
    Arc::new(s)
}

fn stamps_of(home: &Path) -> Vec<Option<(SystemTime, u64)>> {
    Sources::files(home).iter().map(|p| std::fs::metadata(p).ok().and_then(|m| Some((m.modified().ok()?, m.len())))).collect()
}

impl SettingsCache {
    fn new(home: &Path, env: Env, clock: Arc<dyn Clock>) -> SettingsCache {
        let files = Files::load(home);
        let default = resolve_settings(home, &files, &env);
        let now = clock.now_ms();
        SettingsCache {
            home: home.to_path_buf(),
            default_env: env,
            clock,
            state: Mutex::new(Resolved { files, stamps: stamps_of(home), checked_ms: now, default, by_env: Vec::new() }),
        }
    }

    fn refresh(&self, g: &mut Resolved) {
        g.files = Files::load(&self.home);
        g.default = resolve_settings(&self.home, &g.files, &self.default_env);
        g.by_env.clear();
    }

    /// The settings for `env` (the calling session's environment) or, with `None`, the engine's own.
    fn get(&self, env: Option<&Env>) -> Arc<JevSettings> {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let now = self.clock.now_ms();
        if now.saturating_sub(g.checked_ms) >= defaults::num("jev.settings_recheck_ms") {
            g.checked_ms = now;
            let stamps = stamps_of(&self.home);
            if stamps != g.stamps {
                g.stamps = stamps;
                self.refresh(&mut g);
            }
        }
        let Some(env) = env else { return g.default.clone() };
        let digest = env.digest();
        if let Some((_, s)) = g.by_env.iter().find(|(d, _)| *d == digest) {
            return s.clone();
        }
        let s = resolve_settings(&self.home, &g.files, env);
        if g.by_env.len() >= defaults::num("jev.env_cache_cap") as usize {
            g.by_env.remove(0);
        }
        g.by_env.push((digest, s.clone()));
        s
    }

    fn reload(&self) {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        g.stamps = stamps_of(&self.home);
        g.checked_ms = self.clock.now_ms();
        self.refresh(&mut g);
    }
}

/// The Jev lane: settings, client, cache, log, stats and the asynchronous queue.
pub struct Jev {
    settings: SettingsCache,
    client: JevClient,
    cache: Arc<dyn JevCache>,
    log: Arc<dyn DecisionLog>,
    /// Counters for the metrics registry.
    pub stats: JevStats,
    queue: OnceLock<SyncSender<AskRequest>>,
    pending: AtomicUsize,
    this: OnceLock<Weak<Jev>>,
    log_errors: AtomicU64,
}

/// The ISO-8601 UTC time with milliseconds, as `Date.prototype.toISOString` writes it.
pub fn iso_ms(unix_ms: u64) -> String {
    let secs = (unix_ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (proleptic Gregorian), after Howard Hinnant
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, unix_ms % 1000)
}

fn now_unix_ms() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// The content hash: SHA-256 of the parts joined with U+0001, as lowercase hex cut to `jev.hash_len`.
pub fn content_hash(parts: &[&str]) -> String {
    let hex = full_hash(parts);
    hex[..(defaults::num("jev.hash_len") as usize).min(hex.len())].to_string()
}

/// The whole SHA-256 of the parts joined with U+0001, as lowercase hex (the cache key; the log keeps the short form).
fn full_hash(parts: &[&str]) -> String {
    let joined = parts.join("\u{1}");
    ring::digest::digest(&ring::digest::SHA256, joined.as_bytes()).as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Node's `computeFinal` with this engine's trust rules (see the module docs).
fn compute_final(trust: Trust, baseline: &Value, jev: &Value, confident: bool) -> Value {
    let t = Value::Bool(true);
    match trust {
        Trust::AddBlock => {
            if *baseline == t {
                t
            } else {
                Value::Bool(confident && *jev == t)
            }
        }
        Trust::RelaxBlock => {
            if *baseline != t {
                baseline.clone()
            } else {
                Value::Bool(!(confident && *jev == Value::Bool(false)))
            }
        }
        Trust::Advisory => {
            if *baseline == t {
                t
            } else if confident {
                jev.clone()
            } else {
                baseline.clone()
            }
        }
    }
}

fn direction(trust: Trust, changed: bool) -> Value {
    if !changed {
        return Value::Null;
    }
    match trust {
        Trust::AddBlock => json!("added"),
        Trust::RelaxBlock => json!("relaxed"),
        Trust::Advisory => json!("changed"),
    }
}

/// What a decision cost (Node: `computeCostUsd`): zero for a cache hit, the vendor's figure when reported, else real token
/// counts priced from the owner's table or the published rate, else unknown. Never a guess and never a network call.
fn cost_of(s: &JevSettings, r: &CallResult, cached: bool) -> (Option<f64>, Option<CostSource>) {
    if cached {
        return (Some(0.0), Some(CostSource::Cache));
    }
    if !r.ok() {
        return (None, None);
    }
    if let Some(c) = r.cost {
        return (Some(c), Some(CostSource::Gateway));
    }
    if let (Some(i), Some(o)) = (r.tokens_in, r.tokens_out) {
        let entry = r.model.as_deref().and_then(|m| s.prices.get(m)).or_else(|| s.prices.get("default"));
        if let Some(e) = entry
            && let (Some(pi), Some(po)) = (e.get("inPerMTok").and_then(Value::as_f64), e.get("outPerMTok").and_then(Value::as_f64))
        {
            return (Some(i / 1e6 * pi + o / 1e6 * po), Some(CostSource::PriceTable));
        }
        return (Some(i / 1e6 * s.price_in + o / 1e6 * s.price_out), Some(CostSource::DefaultPrice));
    }
    (None, None)
}

/// The working directory's name: the project label when a caller gives none (Node: `defaultProject`).
fn default_project() -> String {
    std::env::current_dir()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

impl Jev {
    /// A Jev lane for `home` using the real network transport and a file log under it. `env` is the environment snapshot
    /// the settings are resolved against.
    pub fn new(home: &Path, env: Env) -> Arc<Jev> {
        let breakers = Breakers::shared(home.join(defaults::text("paths.base_dir")).join(defaults::text("jev.breaker_file")), Arc::new(WallClock));
        Jev::build(home, env, Arc::new(HttpTransport::new()), Arc::new(SystemClock), None, None, Some(breakers))
    }

    /// A Jev lane with every part replaceable (tests, and the daemon when storage supplies the cache and log).
    pub fn with_parts(
        home: &Path,
        env: Env,
        transport: Arc<dyn Transport>,
        clock: Arc<dyn Clock>,
        cache: Option<Arc<dyn JevCache>>,
        log: Option<Arc<dyn DecisionLog>>,
    ) -> Arc<Jev> {
        Jev::build(home, env, transport, clock, cache, log, None)
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        home: &Path,
        env: Env,
        transport: Arc<dyn Transport>,
        clock: Arc<dyn Clock>,
        cache: Option<Arc<dyn JevCache>>,
        log: Option<Arc<dyn DecisionLog>>,
        breakers: Option<Breakers>,
    ) -> Arc<Jev> {
        let settings = SettingsCache::new(home, env, clock.clone());
        let snapshot = settings.get(None);
        let log = log.unwrap_or_else(|| {
            let path = home.join(defaults::text("paths.base_dir")).join(defaults::text("jev.log_file"));
            Arc::new(FileLog::new(path, defaults::num("jev.log_max_bytes"), snapshot.log_rotated_files))
        });
        let jev = Arc::new(Jev {
            settings,
            client: match breakers {
                Some(b) => JevClient::with_breakers(transport, clock.clone(), b),
                None => JevClient::new(transport, clock.clone()),
            },
            cache: cache.unwrap_or_else(|| Arc::new(MemCache::with_defaults())),
            log,
            stats: JevStats::default(),
            queue: OnceLock::new(),
            pending: AtomicUsize::new(0),
            this: OnceLock::new(),
            log_errors: AtomicU64::new(0),
        });
        let _ = jev.this.set(Arc::downgrade(&jev));
        jev
    }

    /// The current settings snapshot.
    pub fn settings(&self) -> Arc<JevSettings> {
        self.settings.get(None)
    }

    /// Re-read the settings files now (the config lane calls this when a file changes).
    pub fn reload(&self) {
        self.settings.reload();
    }

    /// Decision-log writes that failed since start.
    pub fn log_errors(&self) -> u64 {
        self.log_errors.load(Ordering::Relaxed)
    }

    /// True while `vendor`'s circuit breaker is open.
    pub fn breaker_open(&self, vendor: super::settings::Vendor) -> bool {
        self.client.breaker_open(vendor)
    }

    fn write(&self, row: &Row) {
        if self.log.append(row).is_err() {
            self.log_errors.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Ask Jev on the caller's thread, inside the call's budget, and return the decision. Never fails: the worst case is the
    /// caller's baseline.
    pub fn ask(&self, req: &AskRequest) -> Decision {
        let s = self.settings.get(req.env.as_ref());
        let mode = s.mode(&req.id, false);
        if mode == Mode::Off {
            // The off path: no hashing, no cache, no network and, unless asked, no log row.
            return self.finish(&s, req, mode, None, false, defaults::num("jev.log_off_rows") == 1);
        }
        if req.trust == Trust::RelaxBlock && req.baseline != Value::Bool(true) {
            return self.finish(&s, req, mode, None, false, true); // nothing to relax: not consulted
        }
        // The cache is shared by every session, so an entry is only valid for a session that would have asked the same vendor
        // the same way: the key names the vendor chain, models and endpoints, and a test endpoint override never reads or
        // writes the cache. A hit still needs a key for the CALLING session; without one the call fails as `no-key`.
        let cache_key = self.cache_key_of(&s, req);
        if let Some(ck) = cache_key.as_deref().filter(|_| resolve_key(&s, s.transport).key.is_some())
            && let Some(c) = self.cache.get(ck)
        {
            let r = CallResult::answered(c.answer, c.confidence, 0);
            return self.finish(&s, req, mode, Some(r), true, true);
        }
        let r = self.client.decide(&s, &req.question, &req.state, req.budget_ms);
        if let (Some(a), Some(ck)) = (&r.answer, &cache_key) {
            self.cache.put(ck, Cached { answer: a.clone(), confidence: r.confidence });
        }
        self.finish(&s, req, mode, Some(r), false, true)
    }

    /// Queue the call and return at once; the answer lands in the cache and the log for a later turn. A full queue is
    /// logged as busy and costs the caller nothing. When the integration is off the call is not even queued.
    pub fn ask_async(&self, req: AskRequest) {
        let s = self.settings.get(req.env.as_ref());
        if s.mode(&req.id, false) == Mode::Off {
            self.finish(&s, &req, Mode::Off, None, false, defaults::num("jev.log_off_rows") == 1);
            return;
        }
        let mut req = req;
        if req.budget_ms.is_none() {
            req.budget_ms = Some(if s.timeout_ms != defaults::num("jev.timeout_ms") { s.timeout_ms } else { defaults::num("jev.async_budget_ms") });
        }
        let tx = self.queue.get_or_init(|| self.start_worker());
        self.pending.fetch_add(1, Ordering::SeqCst);
        match tx.try_send(req) {
            Ok(()) => {}
            Err(TrySendError::Full(req) | TrySendError::Disconnected(req)) => {
                self.pending.fetch_sub(1, Ordering::SeqCst);
                let mode = s.mode(&req.id, false);
                self.finish(&s, &req, mode, Some(CallResult::failed(Reason::Busy)), false, true);
            }
        }
    }

    fn start_worker(&self) -> SyncSender<AskRequest> {
        let (tx, rx) = sync_channel::<AskRequest>(defaults::num("jev.queue_cap") as usize);
        let weak = self.this.get().cloned().unwrap_or_default();
        std::thread::spawn(move || {
            // Ends when the Jev lane (and with it the sender) is dropped.
            while let Ok(req) = rx.recv() {
                let Some(jev) = weak.upgrade() else { break };
                let _ = jev.ask(&req);
                jev.pending.fetch_sub(1, Ordering::SeqCst);
            }
        });
        tx
    }

    /// Wait until the asynchronous queue is empty or `timeout` passes; true when it emptied. For tests and shutdown.
    pub fn drain(&self, timeout: Duration) -> bool {
        let end = std::time::Instant::now() + timeout;
        while self.pending.load(Ordering::SeqCst) > 0 {
            if std::time::Instant::now() >= end {
                return false;
            }
            std::thread::sleep(defaults::millis("jev.drain_poll_ms"));
        }
        true
    }

    /// The key an answer is cached under for the session whose settings are `s`; `None` when it must not be cached (a test
    /// endpoint override is in effect). Unlike the logged hash it covers everything that decides who answers and how.
    fn cache_key_of(&self, s: &JevSettings, req: &AskRequest) -> Option<String> {
        if s.has_endpoint_override() {
            return None;
        }
        let qv = defaults::text("jev.question_version");
        let vendors: Vec<Vendor> = std::iter::once(s.transport).chain(s.fallback).collect();
        let chain: String = vendors
            .iter()
            .enumerate()
            .map(|(i, v)| format!("{}|{}|{}", v.as_str(), JevClient::model_for(*v), endpoint_for(s, *v, i == 0)))
            .collect::<Vec<_>>()
            .join(">");
        Some(full_hash(&[&req.id, qv, &chain, req.cache_key.as_deref().unwrap_or(&req.state)]))
    }

    fn hash_of(&self, req: &AskRequest) -> String {
        let qv = defaults::text("jev.question_version");
        content_hash(&[&req.id, qv, req.cache_key.as_deref().unwrap_or(&req.state)])
    }

    /// Apply the mode and trust rule, count it and write the one log row (Node: `finalize`).
    fn finish(&self, s: &JevSettings, req: &AskRequest, mode: Mode, r: Option<CallResult>, cached: bool, log: bool) -> Decision {
        let threshold = s.assist_threshold;
        let answered = r.as_ref().filter(|x| x.ok());
        let confident = answered.is_some_and(|x| x.confidence >= threshold);
        let jev_value = answered.and_then(|x| x.answer.as_ref()).map(|a| match (&req.judge, a) {
            (Some(j), _) => Value::Bool(j(a)),
            (None, a) => a.to_json(),
        });
        let would_be = match &jev_value {
            Some(j) => compute_final(req.trust, &req.baseline, j, confident),
            None => req.baseline.clone(),
        };
        let changed = mode == Mode::On && would_be != req.baseline;
        let outcome = if mode == Mode::On { would_be.clone() } else { req.baseline.clone() };
        let would_change = match &jev_value {
            Some(j) => direction(req.trust, if req.record_disagreement { *j != req.baseline } else { would_be != req.baseline }),
            None => Value::Null,
        };
        let backend = match (&r, cached) {
            (None, _) => Backend::BaselineOnly,
            (Some(_), true) => Backend::Cache,
            (Some(x), false) => {
                if x.ok() {
                    Backend::Jev
                } else {
                    Backend::BaselineOnly
                }
            }
        };
        let (cost_usd, cost_source) = r.as_ref().map_or((None, None), |x| cost_of(s, x, cached));
        let hash = if log || r.is_some() { self.hash_of(req) } else { String::new() };
        let ms = r.as_ref().map_or(0, |x| x.ms);
        let reason = r.as_ref().filter(|x| !x.ok()).and_then(|x| x.reason.clone());
        if r.is_some() || log {
            self.stats.call(backend, mode);
            if reason == Some(Reason::Timeout) {
                self.stats.timeouts.fetch_add(1, Ordering::Relaxed);
            }
            if reason == Some(Reason::CircuitOpen) {
                self.stats.cooldowns.fetch_add(1, Ordering::Relaxed);
            }
            if changed {
                self.stats.changed.fetch_add(1, Ordering::Relaxed);
            }
            let verdict = if answered.is_none() {
                "no-answer"
            } else if changed {
                if req.trust == Trust::AddBlock { "added" } else { "changed" }
            } else if mode != Mode::On && would_change != Value::Null {
                "would-change"
            } else {
                "none"
            };
            self.stats.verdict(&req.id, verdict);
            if backend == Backend::Jev {
                // whole micro-dollars; a call cheaper than one rounds down, which the unit makes visible
                self.stats.cost_micro_usd.fetch_add((cost_usd.unwrap_or(0.0) * 1e6).max(0.0) as u64, Ordering::Relaxed);
            }
            if backend == Backend::Jev {
                self.stats.latencies_us.lock().unwrap_or_else(|e| e.into_inner()).push(ms.saturating_mul(1000));
            }
        }
        if log {
            self.write(&self.row(
                s,
                req,
                mode,
                r.as_ref(),
                cached,
                &hash,
                &outcome,
                &direction(req.trust, changed),
                &would_change,
                backend,
                cost_usd,
                cost_source,
            ));
        }
        Decision {
            outcome,
            jev: answered.and_then(|x| x.answer.as_ref()).map_or(Value::Null, Answer::to_json),
            baseline: req.baseline.clone(),
            confidence: answered.map(|x| x.confidence),
            confident: answered.map(|_| confident),
            ms,
            backend,
            reason,
            hash,
            cost_usd,
            cost_source,
            changed,
        }
    }

    /// Build the log row; the field order and presence rules are Node's `finalize`.
    #[allow(clippy::too_many_arguments)]
    fn row(
        &self,
        _s: &JevSettings,
        req: &AskRequest,
        mode: Mode,
        r: Option<&CallResult>,
        cached: bool,
        hash: &str,
        outcome: &Value,
        changed: &Value,
        would_change: &Value,
        backend: Backend,
        cost_usd: Option<f64>,
        cost_source: Option<CostSource>,
    ) -> Row {
        let ok = r.filter(|x| x.ok());
        let mut row = Row::default();
        row.put("ts", json!(iso_ms(now_unix_ms())));
        row.put("id", json!(req.id));
        row.put("h", json!(hash));
        row.put("base", req.baseline.clone());
        row.put("jev", ok.and_then(|x| x.answer.as_ref()).map_or(Value::Null, Answer::to_json));
        row.put("conf", ok.map_or(Value::Null, |x| json!(x.confidence)));
        row.put("ms", json!(r.map_or(0, |x| x.ms)));
        row.put("backend", json!(backend.as_str()));
        row.put("final", outcome.clone());
        row.put("changed", changed.clone());
        if mode != Mode::On || req.record_disagreement {
            row.put("wouldChange", would_change.clone());
        }
        row.put("cached", json!(cached));
        row.put("mode", json!(mode.as_str()));
        row.put("project", json!(req.project.clone().filter(|p| !p.is_empty()).unwrap_or_else(default_project)));
        if let Some(sid) = req.session_id.as_ref().filter(|s| !s.is_empty()) {
            row.put("sessionId", json!(sid));
        }
        if let Some(t) = req.turn_ref.as_ref().filter(|s| !s.is_empty()) {
            row.put("turnRef", json!(t));
        }
        if let Some(x) = r.filter(|x| !x.ok())
            && let Some(reason) = &x.reason
        {
            row.put("reason", json!(reason.to_string()));
        }
        if let Some(x) = r.filter(|_| !cached) {
            if let Some(t) = x.transport {
                row.put("transport", json!(t.as_str()));
            }
            if x.fell_back {
                row.put("fellBack", json!(true));
            }
        }
        if let Some(x) = r {
            row.put("costUsd", cost_usd.map_or(Value::Null, |c| json!(c)));
            row.put("costSource", cost_source.map_or(Value::Null, |c| json!(c.as_str())));
            if let Some(t) = x.tokens_in {
                row.put("tokensIn", json!(t));
            }
            if let Some(t) = x.tokens_out {
                row.put("tokensOut", json!(t));
            }
        }
        if let Some(c) = req.compare {
            row.put("compare", json!(c));
        }
        row
    }

    /// Record a later observed result against a decision by hash, so `jev report` can join them (Node: `recordOutcome`).
    pub fn record_outcome(&self, id: &str, hash: &str, outcome: &str, source: Option<&str>, project: Option<&str>) {
        if id.is_empty() || hash.is_empty() || outcome.is_empty() {
            return;
        }
        let mut row = Row::default();
        row.put("ts", json!(iso_ms(now_unix_ms())));
        row.put("type", json!("outcome"));
        row.put("id", json!(id));
        row.put("h", json!(hash));
        row.put("outcome", json!(outcome));
        if let Some(src) = source.filter(|s| !s.is_empty()) {
            row.put("source", json!(src));
        }
        row.put("project", json!(project.filter(|p| !p.is_empty()).map_or_else(default_project, str::to_string)));
        self.write(&row);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::breaker::ManualClock;
    use crate::jev::testkit::{Fake, ok};

    struct MemLog(Mutex<Vec<Row>>);
    impl DecisionLog for MemLog {
        fn append(&self, row: &Row) -> Result<(), crate::jev::error::JevError> {
            self.0.lock().unwrap().push(row.clone());
            Ok(())
        }
    }

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn lane(
        env: &[(&str, &str)],
        script: Vec<Result<crate::jev::transport::RawResponse, crate::jev::transport::NetError>>,
    ) -> (Arc<Jev>, Arc<Fake>, Arc<MemLog>) {
        let f = Arc::new(Fake::new(script));
        let log = Arc::new(MemLog(Mutex::new(Vec::new())));
        let jev =
            Jev::with_parts(Path::new("/nohome"), Env::from_pairs(env.iter().copied()), f.clone(), Arc::new(ManualClock::default()), None, Some(log.clone()));
        (jev, f, log)
    }

    fn q() -> Question {
        Question::noul("Is it?", "yes", "no")
    }

    fn req(id: &str, trust: Trust, baseline: Value) -> AskRequest {
        let mut r = AskRequest::new(id, q(), "some text", trust, baseline);
        r.project = Some("proj".into());
        r
    }

    fn answer(p: f64) -> String {
        format!(r#"{{"answers":{{"decision":{{"noul":{p}}}}}}}"#)
    }

    fn field(row: &Row, k: &str) -> Value {
        row.0.iter().find(|(key, _)| *key == k).map(|(_, v)| v.clone()).unwrap_or(json!("<absent>"))
    }

    #[test]
    fn jev_off_is_the_baseline_with_no_network_no_cache_and_one_off_row_as_node_writes() {
        let (jev, f, log) = lane(&[], vec![]);
        let d = jev.ask(&req("speculation", Trust::AddBlock, json!(false)));
        assert_eq!((d.outcome, d.backend, d.changed), (json!(false), Backend::BaselineOnly, false));
        assert!(f.seen.lock().unwrap().is_empty() && jev.cache.is_empty());
        let rows = log.0.lock().unwrap();
        assert_eq!(rows.len(), 1, "Node's finalize logs a skipped call, so `jev report` volume is unchanged");
        assert_eq!((field(&rows[0], "mode"), field(&rows[0], "backend"), field(&rows[0], "final")), (json!("off"), json!("baseline-only"), json!(false)));
    }

    #[test]
    fn on_mode_add_block_adds_a_block_when_confident_and_never_removes_one() {
        let (jev, _, log) = lane(&ON, vec![ok(200, &answer(0.99)), ok(200, &answer(0.01))]);
        let added = jev.ask(&req("speculation", Trust::AddBlock, json!(false)));
        assert_eq!((added.outcome, added.changed), (json!(true), true));
        let mut r2 = req("speculation", Trust::AddBlock, json!(true));
        r2.state = "other text".into();
        let kept = jev.ask(&r2);
        assert_eq!((kept.outcome, kept.changed), (json!(true), false), "Jev saying no never removes a block");
        let rows = log.0.lock().unwrap();
        assert_eq!(field(&rows[0], "changed"), json!("added"));
        assert!(rows[0].0.iter().all(|(k, _)| *k != "wouldChange"), "an on row carries no wouldChange");
    }

    #[test]
    fn low_confidence_leaves_the_baseline() {
        let (jev, _, _) = lane(&ON, vec![ok(200, &answer(0.6))]);
        let d = jev.ask(&req("speculation", Trust::AddBlock, json!(false)));
        assert_eq!((d.outcome, d.confident), (json!(false), Some(false)));
    }

    #[test]
    fn shadow_never_changes_the_outcome_but_reports_the_would_change() {
        let (jev, _, log) = lane(&ON, vec![ok(200, &answer(0.99))]);
        let d = jev.ask(&req("modelRouting", Trust::AddBlock, json!(false)));
        assert_eq!((d.outcome, d.changed), (json!(false), false));
        let row = log.0.lock().unwrap()[0].clone();
        assert_eq!((field(&row, "mode"), field(&row, "changed"), field(&row, "wouldChange")), (json!("shadow"), Value::Null, json!("added")));
    }

    #[test]
    fn relax_block_relaxes_when_on_and_a_non_blocking_baseline_is_not_consulted() {
        let (jev, f, log) = lane(
            &[("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"), ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_MODEL_ROUTING", "on")],
            vec![ok(200, &answer(0.0))],
        );
        let mut r = req("modelRouting", Trust::RelaxBlock, json!(true));
        let d = jev.ask(&r);
        assert_eq!((d.outcome, d.changed), (json!(false), true));
        r.baseline = json!(false);
        r.state = "x2".into();
        jev.ask(&r);
        assert_eq!(f.seen.lock().unwrap().len(), 1, "a non-blocking baseline asks nothing");
        let row = log.0.lock().unwrap()[0].clone();
        assert_eq!((field(&row, "mode"), field(&row, "changed")), (json!("on"), json!("relaxed")));
        assert!(row.0.iter().all(|(k, _)| *k != "wouldChange"), "an on row carries no wouldChange");
    }

    #[test]
    fn advisory_supplies_a_label_but_never_removes_a_true_baseline() {
        let (jev, _, _) = lane(&ON, vec![ok(200, &answer(0.01)), ok(200, &answer(0.01))]);
        let mut r = req("dispatchTier", Trust::Advisory, json!(true));
        assert_eq!(jev.ask(&r).outcome, json!(true), "Jev saying no never removes an advisory");
        r.state = "other".into();
        r.baseline = Value::Null;
        assert_eq!(jev.ask(&r).outcome, json!(false), "a confident advisory fills in where there was no baseline");
    }

    #[test]
    fn the_second_identical_ask_is_a_free_cache_hit() {
        let (jev, f, log) = lane(&ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.99}},"provider_metadata":{"gateway":{"cost":"0.0004"}}}"#)]);
        let r = req("speculation", Trust::AddBlock, json!(false));
        let first = jev.ask(&r);
        let second = jev.ask(&r);
        assert_eq!((first.backend, first.cost_source), (Backend::Jev, Some(CostSource::Gateway)));
        assert_eq!((second.backend, second.cost_usd, second.cost_source, second.ms), (Backend::Cache, Some(0.0), Some(CostSource::Cache), 0));
        assert_eq!(f.seen.lock().unwrap().len(), 1);
        assert_eq!(field(&log.0.lock().unwrap()[1], "cached"), json!(true));
    }

    #[test]
    fn every_failure_degrades_to_the_baseline_and_is_logged_with_its_reason() {
        for (script, reason) in
            [(vec![ok(500, "x")], "http-500"), (vec![ok(200, "junk")], "parse-error"), (vec![ok(200, "{}")], "bad-response"), (vec![], "network-error")]
        {
            let (jev, _, log) = lane(&ON, script);
            let d = jev.ask(&req("speculation", Trust::AddBlock, json!(false)));
            assert_eq!((d.outcome, d.backend), (json!(false), Backend::BaselineOnly));
            assert_eq!(field(&log.0.lock().unwrap()[0], "reason"), json!(reason));
            assert!(jev.cache.is_empty(), "a failure is never cached");
        }
        let (nokey, _, log) = lane(&[("ANTIHALL_JEV", "1")], vec![]);
        assert_eq!(nokey.ask(&req("speculation", Trust::AddBlock, json!(false))).reason, Some(Reason::NoKey));
        assert_eq!(field(&log.0.lock().unwrap()[0], "reason"), json!("no-key"));
    }

    #[test]
    fn the_async_path_returns_at_once_and_lands_in_the_cache_and_the_log() {
        let (jev, f, log) = lane(&ON, vec![ok(200, &answer(0.99))]);
        jev.ask_async(req("speculation", Trust::AddBlock, json!(false)));
        assert!(jev.drain(Duration::from_secs(5)));
        assert_eq!(f.seen.lock().unwrap().len(), 1);
        assert_eq!(log.0.lock().unwrap().len(), 1);
        assert_eq!(jev.cache.len(), 1);
    }

    #[test]
    fn an_off_integration_is_not_even_queued() {
        let (jev, f, log) = lane(&[("ANTIHALL_JEV", "1"), ("ANTIHALL_JEV_SPECULATION", "0"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")], vec![]);
        jev.ask_async(req("speculation", Trust::AddBlock, json!(false)));
        assert!(jev.queue.get().is_none(), "no worker thread was started");
        assert!(f.seen.lock().unwrap().is_empty());
        let rows = log.0.lock().unwrap();
        assert_eq!((rows.len(), field(&rows[0], "mode")), (1, json!("off")), "the off row Node's askDetached writes synchronously");
    }

    #[test]
    fn the_row_has_node_s_fields_in_node_s_order() {
        let (jev, _, log) = lane(&ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.99}},"usage":{"input_tokens":1000,"output_tokens":5}}"#)]);
        let mut r = req("speculation", Trust::AddBlock, json!(false));
        r.session_id = Some("s1".into());
        r.compare = Some(true);
        jev.ask(&r);
        let row = log.0.lock().unwrap()[0].clone();
        let keys: Vec<&str> = row.0.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            keys,
            [
                "ts",
                "id",
                "h",
                "base",
                "jev",
                "conf",
                "ms",
                "backend",
                "final",
                "changed",
                "cached",
                "mode",
                "project",
                "sessionId",
                "transport",
                "costUsd",
                "costSource",
                "tokensIn",
                "tokensOut",
                "compare"
            ]
        );
        assert_eq!(field(&row, "costSource"), json!("default-price"));
        assert!((field(&row, "costUsd").as_f64().unwrap() - 0.000042).abs() < 1e-12);
    }

    #[test]
    fn the_hash_is_the_sha256_of_the_parts_cut_to_sixteen_hex_characters() {
        // echo -n 'speculation\x01v1\x01some text' | shasum -a 256 | cut -c1-16, checked against Node's crypto in the parity harness
        let h = content_hash(&["speculation", "v1", "some text"]);
        assert_eq!(h.len(), 16);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(content_hash(&["a"]), "ca978112ca1bbdca", "sha256(\"a\") starts ca978112ca1bbdca");
    }

    #[test]
    fn iso_timestamps_match_to_iso_string() {
        assert_eq!(iso_ms(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_ms(1_791_158_400_123), "2026-10-05T00:00:00.123Z");
        assert_eq!(iso_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }

    #[test]
    fn each_session_decides_with_its_own_environment() {
        let (jev, f, _) = lane(&[], vec![ok(200, &answer(0.99))]);
        let mut a = req("speculation", Trust::AddBlock, json!(false));
        assert_eq!(jev.ask(&a).backend, Backend::BaselineOnly, "the engine's own environment has Jev off");
        a.env = Some(Env::from_pairs(ON.iter().copied()));
        let on = jev.ask(&a);
        assert_eq!((on.backend, on.outcome), (Backend::Jev, json!(true)), "this session turned Jev on and has its own key");
        let mut b = req("speculation", Trust::AddBlock, json!(false));
        b.state = "a different text, so no cached answer applies".into();
        b.env = Some(Env::from_pairs([("ANTIHALL_JEV", "1")]));
        assert_eq!(jev.ask(&b).reason, Some(Reason::NoKey), "another session's key is not borrowed");
        assert_eq!(f.seen.lock().unwrap().len(), 1);
    }

    fn session(pairs: &[(&str, &str)]) -> Option<Env> {
        Some(Env::from_pairs(pairs.iter().copied()))
    }

    #[test]
    fn an_answer_from_a_test_endpoint_session_never_reaches_a_session_without_one() {
        let (jev, f, _) = lane(&[], vec![ok(200, &answer(0.99)), ok(200, &answer(0.01))]);
        let mut a = req("speculation", Trust::AddBlock, json!(false));
        a.env = session(&[("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"), ("ANTIHALL_JEV_TEST_ENDPOINT", "http://127.0.0.1:9/x")]);
        let da = jev.ask(&a);
        assert_eq!((da.backend, da.outcome), (Backend::Jev, json!(true)), "session A got the mock's answer");
        assert!(jev.cache.is_empty(), "an answer obtained through an override is never cached");
        // session B: same text, no override, another vendor
        let mut b = a.clone();
        b.env = session(&[("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT", "typesafe"), ("CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY", "tk")]);
        let db = jev.ask(&b);
        assert_eq!((db.backend, db.outcome), (Backend::Jev, json!(false)), "B asked its own vendor and was not served A's answer");
        let seen = f.seen.lock().unwrap();
        assert_eq!((seen.len(), seen[0].0.as_str(), seen[1].0.as_str()), (2, "http://127.0.0.1:9/x", "https://api.typesafe.ai/v1/systemone"));
        assert_eq!((seen[0].1.as_str(), seen[1].1.as_str()), ("vk", "tk"), "each key went only to its own session's endpoint");
    }

    #[test]
    fn a_cache_entry_is_per_vendor_chain_and_a_hit_needs_the_callers_key() {
        let (jev, f, _) = lane(&[], vec![ok(200, &answer(0.99)), ok(200, &answer(0.01))]);
        let mut a = req("speculation", Trust::AddBlock, json!(false));
        a.env = session(&ON);
        assert_eq!(jev.ask(&a).backend, Backend::Jev);
        assert_eq!(jev.ask(&a).backend, Backend::Cache, "the same session shape shares the entry");
        let mut other = a.clone();
        other.env = session(&[("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "another-key")]);
        assert_eq!(jev.ask(&other).backend, Backend::Cache, "a session with the same vendor chain and its own key shares it");
        let mut fb = a.clone();
        fb.env = session(&[
            ("ANTIHALL_JEV", "1"),
            ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"),
            ("CLAUDE_PLUGIN_OPTION_JEV_FALLBACK_TRANSPORT", "typesafe"),
            ("CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY", "tk"),
        ]);
        assert_eq!(jev.ask(&fb).backend, Backend::Jev, "a different vendor chain is a different entry");
        let mut nokey = a.clone();
        nokey.env = session(&[("ANTIHALL_JEV", "1")]);
        let d = jev.ask(&nokey);
        assert_eq!((d.backend, d.reason), (Backend::BaselineOnly, Some(Reason::NoKey)), "a hit is not served to a session with no key");
        let mut off = a.clone();
        off.env = session(&[]);
        assert_eq!(jev.ask(&off).backend, Backend::BaselineOnly, "nor to one with Jev off");
        assert_eq!(f.seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn the_per_environment_memo_stays_bounded() {
        let (jev, _, _) = lane(&[], vec![]);
        for i in 0..40 {
            let mut r = req("speculation", Trust::AddBlock, json!(false));
            r.env = Some(Env::from_pairs([("N", i.to_string())]));
            jev.ask(&r);
        }
        let cap = defaults::num("jev.env_cache_cap") as usize;
        assert!(jev.settings.state.lock().unwrap().by_env.len() <= cap);
    }

    #[test]
    fn drained_stats_reach_the_metrics_registry() {
        let (jev, _, _) = lane(&ON, vec![ok(200, &answer(0.99))]);
        jev.ask(&req("speculation", Trust::AddBlock, json!(false)));
        let mut m = crate::metrics::Metrics::default();
        jev.stats.drain_into(&mut m);
        assert_eq!(m.counter("jev_calls", &[("backend", "jev"), ("mode", "on")]), 1);
        assert_eq!(m.counter("jev_changed", &[]), 1);
        assert_eq!(m.counter("jev_verdicts", &[("id", "speculation"), ("verdict", "added")]), 1);
        assert_eq!(m.counter("jev_cost_micro_usd", &[]), 0, "no cost was reported and no tokens were priced");
    }
}
