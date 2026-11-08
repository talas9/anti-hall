//! The per-session transcript fact store (D): one store per session, the only reader of a transcript.
//!
//! * **One fixed buffer.** A refresh reads `[offset, size)` through a [`LineReader`] of `transcript.read_buf_bytes`; no
//!   reader holds a window. A line over `transcript.max_line_bytes` is skipped and counted; a query whose window covers one
//!   answers [`Unsure::Partial`].
//! * **One parse per byte.** A session remembers (device, inode, offset, head and tail fingerprints). A refresh parses only
//!   the bytes appended since; truncation, rotation or a rewrite rebuilds over the horizon.
//! * **Facts carry offsets.** A query names a window and a [`Cut`] and is answered from the facts inside it, so each old
//!   reader has a byte-exact twin.
//! * **Bounded.** Facts older than `size - transcript.horizon_bytes` are dropped; the keyed task and agent maps outlive the
//!   horizon within their caps; a per-session byte budget (`transcript.session_budget_bytes`) evicts the oldest facts and
//!   raises `covered_from`; a global budget (`transcript.global_budget_bytes`) evicts least recently used sessions.
//! * **Single flight.** One refresh per session at a time: a second request waits up to `transcript.wait_ms`, then answers
//!   unsure instead of reading. At most `transcript.cold_build_permits` cold builds run at once in the whole process.
//! * **Restartable.** [`Store::persist_all`] writes each session's facts; the next first touch loads them when every stamp
//!   still matches and parses only what was appended since. The transcript stays the source of truth.
//!
//! Every limit is a key of `defaults/transcript.toml`; nothing here is a number of its own.
use super::facts::{AgentRow, Cut, Fact, FactKind, FifoMap, TaskRow};
use super::persist;
use super::reader::{LineReader, ReadCfg};
use super::record::{Notification, Prompt, TaskEvent, ToolUse, cap_text, js_trim, parse_line};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::os::unix::fs::{FileExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{
    AtomicBool, AtomicU64,
    Ordering::{Relaxed, SeqCst},
};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Why a question could not be answered from the store. Every caller already has a defer path for "unsure".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsure {
    /// Another request was refreshing this session, or a cold build was running, for longer than `transcript.wait_ms`.
    Busy,
    /// The transcript is missing or empty.
    Missing,
    /// The file could not be read.
    Io(std::io::ErrorKind),
    /// The window starts before what the store still holds (evicted by a budget or older than the horizon), or covers a
    /// skipped oversize line.
    Partial {
        /// The earliest window start the store can answer.
        covered_from: u64,
    },
}

impl Unsure {
    /// A short stable word for logs and counters.
    pub fn code(&self) -> &'static str {
        match self {
            Unsure::Busy => defaults::text("transcript.unsure_busy"),
            Unsure::Missing => defaults::text("transcript.unsure_missing"),
            Unsure::Io(_) => defaults::text("transcript.unsure_io"),
            Unsure::Partial { .. } => defaults::text("transcript.unsure_partial"),
        }
    }
}

impl std::fmt::Display for Unsure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&defaults::render("transcript.msg_unsure", &[("why", &self.code())]))
    }
}

impl std::error::Error for Unsure {}

/// Every limit of the store, read from `defaults/transcript.toml`.
#[derive(Debug, Clone)]
pub struct Cfg {
    /// The reader's sizes.
    pub read: ReadCfg,
    /// How far behind the end of the file facts are kept.
    pub horizon: u64,
    /// Bytes of facts and maps one session may hold.
    pub session_budget: usize,
    /// Bytes all sessions may hold.
    pub global_budget: usize,
    /// How long a request waits for a refresh or a cold-build permit.
    pub wait: Duration,
    /// Cold builds that may run at once.
    pub permits: usize,
    /// Fixed bytes charged per fact.
    pub fact_fixed: usize,
    /// Longest text a fact keeps.
    pub text_max: usize,
    /// Longest prompt kept.
    pub prompt_max: usize,
    /// Largest tool input kept.
    pub tool_input_max: usize,
    /// Largest task-tool input kept.
    pub task_input_max: usize,
    /// Longest task result kept.
    pub task_result_max: usize,
    /// Most tasks the keyed map holds.
    pub task_map_max: usize,
    /// Most agents the keyed map holds.
    pub agent_map_max: usize,
    /// Most task-tool use ids remembered (to recognise their results).
    pub task_ids_max: usize,
    /// Most oversize line offsets remembered.
    pub oversize_kept: usize,
    /// Leading bytes fingerprinted.
    pub fingerprint: usize,
    /// Bytes fingerprinted just before the offset.
    pub tail_probe: usize,
    /// Most sessions held.
    pub max_sessions: usize,
    /// Idle time after which a session is dropped.
    pub idle_ttl_ms: u64,
    /// Largest snapshot written.
    pub snapshot_max: usize,
    /// Age after which a snapshot is removed.
    pub snapshot_ttl_ms: u64,
    /// Most snapshot files kept.
    pub snapshot_max_files: usize,
}

impl Cfg {
    /// The shipped limits.
    pub fn from_defaults() -> Cfg {
        use defaults::num;
        Cfg {
            read: ReadCfg::from_defaults(),
            horizon: num("transcript.horizon_bytes"),
            session_budget: num("transcript.session_budget_bytes") as usize,
            global_budget: num("transcript.global_budget_bytes") as usize,
            wait: defaults::millis("transcript.wait_ms"),
            permits: num("transcript.cold_build_permits") as usize,
            fact_fixed: num("transcript.fact_fixed_bytes") as usize,
            text_max: num("transcript.fact_text_max_bytes") as usize,
            prompt_max: num("transcript.prompt_max_bytes") as usize,
            tool_input_max: num("transcript.tool_input_max_bytes") as usize,
            task_input_max: num("transcript.task_input_max_bytes") as usize,
            task_result_max: num("transcript.task_result_max_bytes") as usize,
            task_map_max: num("transcript.task_map_max") as usize,
            agent_map_max: num("transcript.agent_map_max") as usize,
            task_ids_max: num("transcript.task_ids_max") as usize,
            oversize_kept: num("transcript.oversize_kept") as usize,
            fingerprint: num("transcript.fingerprint_bytes") as usize,
            tail_probe: num("transcript.tail_probe_bytes") as usize,
            max_sessions: num("transcript.max_indexes") as usize,
            idle_ttl_ms: num("transcript.idle_ttl_ms"),
            snapshot_max: num("transcript.snapshot_max_bytes") as usize,
            snapshot_ttl_ms: num("transcript.snapshot_ttl_ms"),
            snapshot_max_files: num("transcript.snapshot_max_files") as usize,
        }
    }
}

/// Counters of the store (process-wide, monotonic except the read-buffer maximum).
#[derive(Default)]
pub struct Stats {
    cold_builds: AtomicU64,
    cold_bytes: AtomicU64,
    refresh_bytes: AtomicU64,
    appended_bytes: AtomicU64,
    partial: AtomicU64,
    waits: AtomicU64,
    wait_timeouts: AtomicU64,
    oversize_lines: AtomicU64,
    evictions: AtomicU64,
    rebuilds: AtomicU64,
    snapshot_loads: AtomicU64,
    snapshot_misses: AtomicU64,
    snapshot_writes: AtomicU64,
    snapshot_skipped: AtomicU64,
    read_buf_max: AtomicU64,
}

/// A reading of [`Stats`] plus the live sizes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StatsSnapshot {
    /// Sessions built from the file (a first touch with no usable snapshot, or a rebuild).
    pub cold_builds: u64,
    /// Bytes the cold builds read.
    pub cold_bytes: u64,
    /// Bytes the incremental refreshes parsed.
    pub refresh_bytes: u64,
    /// Bytes the files grew by between incremental refreshes.
    pub appended_bytes: u64,
    /// Questions answered unsure because the window was not covered.
    pub partial: u64,
    /// Requests that found a refresh in flight.
    pub waits: u64,
    /// Of those, the ones that gave up.
    pub wait_timeouts: u64,
    /// Lines skipped for being over the cap.
    pub oversize_lines: u64,
    /// Sessions evicted by a budget, the session cap or the idle TTL.
    pub evictions: u64,
    /// Rebuilds because the file was truncated, rotated or rewritten.
    pub rebuilds: u64,
    /// Snapshots loaded.
    pub snapshot_loads: u64,
    /// Snapshots found but not usable.
    pub snapshot_misses: u64,
    /// Snapshots written.
    pub snapshot_writes: u64,
    /// Snapshots not written because they were over the cap.
    pub snapshot_skipped: u64,
    /// The largest memory any reader held at once (buffer plus longest line kept).
    pub read_buf_max_bytes: u64,
    /// Bytes held by all sessions now.
    pub bytes: u64,
    /// Sessions held now.
    pub sessions: u64,
}

impl StatsSnapshot {
    /// The monotonic counters as (metric name, value), for the daemon's telemetry.
    pub fn counters(&self) -> Vec<(&'static str, u64)> {
        vec![
            ("transcript_store_cold_builds", self.cold_builds),
            ("transcript_store_cold_bytes", self.cold_bytes),
            ("transcript_store_refresh_bytes", self.refresh_bytes),
            ("transcript_store_appended_bytes", self.appended_bytes),
            ("transcript_store_partial", self.partial),
            ("transcript_store_waits", self.waits),
            ("transcript_store_wait_timeouts", self.wait_timeouts),
            ("transcript_store_oversize_lines", self.oversize_lines),
            ("transcript_store_evictions", self.evictions),
            ("transcript_store_rebuilds", self.rebuilds),
            ("transcript_store_snapshot_loads", self.snapshot_loads),
            ("transcript_store_snapshot_misses", self.snapshot_misses),
            ("transcript_store_snapshot_writes", self.snapshot_writes),
            ("transcript_store_snapshot_skipped", self.snapshot_skipped),
        ]
    }

    /// The live readings as (metric name, value).
    pub fn gauges(&self) -> Vec<(&'static str, f64)> {
        vec![
            ("transcript_store_bytes", self.bytes as f64),
            ("transcript_store_sessions", self.sessions as f64),
            ("transcript_read_buf_max_bytes", self.read_buf_max_bytes as f64),
        ]
    }
}

/// Why a session was rebuilt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Plan {
    Unchanged,
    Append,
    Cold,
    Rebuild,
    /// More was appended than the horizon holds: the facts are rebuilt over the horizon, the keyed maps are kept.
    Gap,
}

/// The facts of one transcript.
#[derive(Debug, Default)]
pub(super) struct Session {
    pub(super) built: bool,
    pub(super) id: Option<(u64, u64)>,
    /// Offset just after the last complete line folded in.
    pub(super) offset: u64,
    /// The file size at the last refresh.
    pub(super) seen_size: u64,
    pub(super) head: Option<(usize, u64)>,
    pub(super) tail: Option<(u64, u64)>,
    /// A window starting at or after this offset can be answered from the facts.
    pub(super) covered_from: u64,
    pub(super) seq: u64,
    pub(super) facts: VecDeque<Fact>,
    /// Facts of the unterminated last line (replaced at every refresh).
    pub(super) pending: Vec<Fact>,
    pub(super) oversize: VecDeque<u64>,
    pub(super) tasks: FifoMap<TaskRow>,
    pub(super) agents: FifoMap<AgentRow>,
    pub(super) task_ids: FifoMap<String>,
    pub(super) fact_bytes: usize,
    pub(super) map_bytes: usize,
}

impl Session {
    pub(super) fn bytes(&self) -> usize {
        self.fact_bytes + self.map_bytes + self.pending_bytes_estimate()
    }

    fn pending_bytes_estimate(&self) -> usize {
        self.pending.iter().map(|f| f.bytes(0)).sum()
    }

    fn clear(&mut self) {
        *self = Session::default();
    }

    fn recount_maps(&mut self) {
        self.map_bytes = self.tasks.iter().map(|(k, v)| k.capacity() + v.bytes()).sum::<usize>()
            + self.agents.iter().map(|(k, v)| k.capacity() + v.bytes()).sum::<usize>()
            + self.task_ids.iter().map(|(k, v)| k.capacity() + v.capacity()).sum::<usize>();
    }

    fn push_fact(&mut self, cfg: &Cfg, off: u64, kind: FactKind) {
        let f = Fact { off, kind };
        self.fact_bytes += f.bytes(cfg.fact_fixed);
        self.facts.push_back(f);
    }

    /// Drop what the horizon and the budget no longer allow, raising `covered_from` for every loss.
    fn trim(&mut self, cfg: &Cfg, size: u64) {
        let limit = size.saturating_sub(cfg.horizon);
        if limit > self.covered_from {
            self.covered_from = limit;
        }
        while self.facts.front().is_some_and(|f| f.off < limit) {
            self.pop_front_fact(cfg);
        }
        while self.oversize.front().is_some_and(|o| *o < limit) {
            self.oversize.pop_front();
        }
        while self.oversize.len() > cfg.oversize_kept.max(1) {
            if let Some(o) = self.oversize.pop_front() {
                self.covered_from = self.covered_from.max(o + 1);
            }
        }
        while self.bytes() > cfg.session_budget {
            if !self.facts.is_empty() {
                self.pop_front_fact(cfg);
            } else if self.tasks.pop_oldest().is_some() || self.agents.pop_oldest().is_some() || self.task_ids.pop_oldest().is_some() {
                self.recount_maps();
            } else {
                break;
            }
        }
    }

    fn pop_front_fact(&mut self, cfg: &Cfg) {
        if let Some(f) = self.facts.pop_front() {
            self.fact_bytes = self.fact_bytes.saturating_sub(f.bytes(cfg.fact_fixed));
            self.covered_from = self.covered_from.max(f.off + 1);
        }
    }

    /// Fold one parsed line in. `off` is the line's first byte.
    fn ingest(&mut self, cfg: &Cfg, off: u64, text: &str, pending: bool) {
        let trimmed_empty = js_trim(text).is_empty();
        if trimmed_empty {
            return;
        }
        let seq = self.seq + 1;
        let rec = parse_line(text, seq, cfg.tool_input_max, cfg.task_input_max);
        if rec.kind == defaults::text("transcript.malformed_kind") {
            return; // a line that does not parse is most likely half written (pending) or not an entry
        }
        if !pending {
            self.seq = seq;
        }
        let mut out: Vec<FactKind> = Vec::new();
        if rec.compact_boundary {
            out.push(FactKind::Boundary);
        }
        let keep = |text: Option<String>| -> Option<super::record::Assistant> {
            let mut text = text?;
            let truncated = cap_text(&mut text, cfg.text_max);
            Some(super::record::Assistant { text, sidechain: rec.sidechain, seq, ts_ms: rec.ts_ms, truncated })
        };
        if let Some(a) = keep(rec.assistant_dedup.clone()) {
            out.push(FactKind::Assistant(a));
        }
        if let Some(a) = keep(rec.assistant_legacy.clone()) {
            out.push(FactKind::AssistantLegacy(a));
        }
        if let Some(mut text) = rec.prompt.clone() {
            let truncated = cap_text(&mut text, cfg.prompt_max);
            out.push(FactKind::Prompt(Prompt { text, seq, truncated }));
        }
        let task_tools = defaults::list("transcript.task_tools");
        let agent_tools = defaults::list("transcript.agent_tools");
        for tu in rec.tool_uses {
            if !pending {
                self.note_tool_use(cfg, off, &tu, &task_tools, &agent_tools);
            }
            if task_tools.contains(&tu.name.as_str()) {
                out.push(FactKind::Task(TaskEvent::Use(tu)));
            } else {
                out.push(FactKind::ToolUse(tu));
            }
        }
        for (id, mut text) in rec.tool_results {
            if self.task_ids.get(&id).is_some() {
                if !pending {
                    self.note_task_result(cfg, off, &id, &text);
                }
                let truncated = cap_text(&mut text, cfg.task_result_max);
                out.push(FactKind::Task(TaskEvent::Result { tool_use_id: id, text, truncated, seq }));
            }
        }
        for n in rec.notifications {
            if !pending {
                self.note_notification(cfg, off, &n);
            }
            out.push(FactKind::Notification(n));
        }
        if let Some(t) = rec.task_status {
            out.push(FactKind::TaskStatus(t));
        }
        for kind in out {
            if pending {
                self.pending.push(Fact { off, kind });
            } else {
                self.push_fact(cfg, off, kind);
            }
        }
    }

    fn note_tool_use(&mut self, cfg: &Cfg, off: u64, tu: &ToolUse, task_tools: &[&str], agent_tools: &[&str]) {
        let Some(id) = tu.id.as_deref() else { return };
        if agent_tools.contains(&tu.name.as_str()) {
            self.agents.upsert(id, cfg.agent_map_max, AgentRow::default, |r| {
                r.launched_at = Some(off);
                r.off = off;
            });
        }
        if !task_tools.contains(&tu.name.as_str()) {
            return;
        }
        self.task_ids.upsert(id, cfg.task_ids_max, || tu.name.clone(), |_| {});
        let input = &tu.input;
        let str_of = |k: &str| input.get(k).and_then(Value::as_str).map(str::to_string);
        let task_id = match input.get("taskId") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        };
        let create = defaults::text("transcript.task_create_tool");
        // a create has no id until its result says so: it waits under the tool use id
        let key = if tu.name == create { Some(id.to_string()) } else { task_id };
        if let Some(key) = key {
            let blocked: Vec<String> = input
                .get("addBlockedBy")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string).or_else(|| v.as_u64().map(|n| n.to_string()))).collect())
                .unwrap_or_default();
            let (subject, status, owner) = (str_of("subject"), str_of("status"), str_of("owner"));
            self.tasks.upsert(&key, cfg.task_map_max, TaskRow::default, |r| {
                if subject.is_some() {
                    r.subject = subject;
                }
                if status.is_some() {
                    r.status = status;
                }
                if owner.is_some() {
                    r.owner = owner;
                }
                for b in blocked {
                    if !r.blocked_by.contains(&b) {
                        r.blocked_by.push(b);
                    }
                }
                r.off = off;
            });
        }
        self.recount_maps();
    }

    fn note_task_result(&mut self, cfg: &Cfg, off: u64, tool_use_id: &str, text: &str) {
        let created = self.task_ids.get(tool_use_id).is_some_and(|n| n == defaults::text("transcript.task_create_tool"));
        if !created {
            return;
        }
        let Some(re) = created_re() else { return };
        let Some(id) = re.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()) else { return };
        if let Some(mut row) = self.tasks.remove(tool_use_id) {
            row.off = off;
            self.tasks.remove(&id);
            self.tasks.upsert(&id, cfg.task_map_max, || row, |_| {});
            self.recount_maps();
        }
    }

    fn note_notification(&mut self, cfg: &Cfg, off: u64, n: &Notification) {
        let terminal = n.terminal_agent().is_some();
        for key in n.task_id.iter().filter(|k| !k.is_empty()).chain(n.idle_tool_use_id.iter()) {
            let status = n.status.clone();
            self.agents.upsert(key, cfg.agent_map_max, AgentRow::default, |r| {
                r.terminal |= terminal;
                r.status = status;
                r.off = off;
            });
        }
        self.recount_maps();
    }
}

/// The regex that finds the id in a create result, compiled once per defaults generation.
fn created_re() -> Option<Arc<Regex>> {
    static CACHE: Mutex<Option<(u64, Option<Arc<Regex>>)>> = Mutex::new(None);
    let generation = defaults::generation();
    let mut c = lock(&CACHE);
    if let Some((g, re)) = c.as_ref()
        && *g == generation
    {
        return re.clone();
    }
    let re = Regex::new(defaults::text("transcript.task_created_re")).ok().map(Arc::new);
    *c = Some((generation, re.clone()));
    re
}

fn fnv(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, x| (h ^ u64::from(*x)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// A counting semaphore with a timed acquire: the cold-build permits.
struct Permits {
    free: Mutex<Option<usize>>,
    cv: Condvar,
}

struct Permit<'a>(&'a Permits);

impl Permits {
    fn acquire(&self, n: usize, deadline: Instant) -> Option<Permit<'_>> {
        let mut free = lock(&self.free);
        if free.is_none() {
            *free = Some(n.max(1));
        }
        loop {
            if let Some(f) = free.as_mut()
                && *f > 0
            {
                *f -= 1;
                return Some(Permit(self));
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            free = self.cv.wait_timeout(free, left).unwrap_or_else(|e| e.into_inner()).0;
        }
    }
}

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        if let Some(f) = lock(&self.0.free).as_mut() {
            *f += 1;
        }
        self.0.cv.notify_one();
    }
}

struct Slot {
    busy: Mutex<bool>,
    cv: Condvar,
    data: Mutex<Session>,
    bytes: AtomicU64,
    last_used_ms: AtomicU64,
    /// Set (under the `busy` lock) when the slot leaves the map. A retired slot never starts another refresh and its
    /// bytes are never counted again, so the map holds at most one slot per path and the total cannot leak.
    retired: AtomicBool,
}

impl Slot {
    /// Take the slot out of service when it is idle (nobody refreshes it). False when a request is in flight.
    fn claim(&self) -> bool {
        let busy = lock(&self.busy);
        if *busy {
            return false;
        }
        self.retired.store(true, SeqCst);
        true
    }

    /// Take the slot out of service even when a request is in flight (the session ended); that request gives its bytes back.
    fn force_retire(&self) {
        let _busy = lock(&self.busy);
        self.retired.store(true, SeqCst);
    }
}

struct BusyGuard<'a>(&'a Slot);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        *lock(&self.0.busy) = false;
        self.0.cv.notify_one();
    }
}

/// What a query is answered from: the facts of one session, after a refresh.
pub struct View<'a> {
    s: &'a Session,
    stats: &'a Stats,
}

impl View<'_> {
    /// The file size at the refresh.
    pub fn size(&self) -> u64 {
        self.s.seen_size
    }

    /// The earliest window start the facts can answer.
    pub fn covered_from(&self) -> u64 {
        self.s.covered_from
    }

    /// Where the window of the last `w` bytes starts.
    pub fn window_start(&self, w: u64) -> u64 {
        self.s.seen_size.saturating_sub(w)
    }

    /// True when the facts cannot answer for this window: it starts before `covered_from`, or covers a skipped line.
    pub fn unsure_in(&self, w: u64, cut: Cut) -> bool {
        let start = self.window_start(w);
        start < self.s.covered_from || self.s.oversize.iter().any(|o| cut.keeps(*o, start))
    }

    /// Ok when the window can be answered; otherwise [`Unsure::Partial`] (counted in `transcript_store_partial`).
    pub fn check(&self, w: u64, cut: Cut) -> Result<(), Unsure> {
        if self.unsure_in(w, cut) {
            self.stats.partial.fetch_add(1, Relaxed);
            return Err(Unsure::Partial { covered_from: self.s.covered_from });
        }
        Ok(())
    }

    /// The facts inside the window, oldest first (the unterminated last line's facts come last).
    pub fn facts(&self, w: u64, cut: Cut) -> impl Iterator<Item = &Fact> {
        let start = self.window_start(w);
        self.s.facts.iter().chain(self.s.pending.iter()).filter(move |f| cut.keeps(f.off, start))
    }

    /// Uses of the tools named (any tool when `names` is empty), oldest first. Task-tool uses are included.
    pub fn tool_uses(&self, w: u64, cut: Cut, names: &[&str]) -> Vec<&ToolUse> {
        self.facts(w, cut)
            .filter_map(|f| match &f.kind {
                FactKind::ToolUse(u) | FactKind::Task(TaskEvent::Use(u)) => Some(u),
                _ => None,
            })
            .filter(|u| names.is_empty() || names.contains(&u.name.as_str()))
            .collect()
    }

    /// The task-tool uses and results inside the window, oldest first.
    pub fn task_events(&self, w: u64, cut: Cut) -> Vec<&TaskEvent> {
        self.facts(w, cut).filter_map(|f| if let FactKind::Task(e) = &f.kind { Some(e) } else { None }).collect()
    }

    /// The task-notification blocks inside the window, oldest first.
    pub fn notifications(&self, w: u64, cut: Cut) -> Vec<&Notification> {
        self.facts(w, cut).filter_map(|f| if let FactKind::Notification(n) = &f.kind { Some(n) } else { None }).collect()
    }

    /// The newest typed prompt inside the window.
    pub fn last_prompt(&self, w: u64, cut: Cut) -> Option<&Prompt> {
        self.facts(w, cut).filter_map(|f| if let FactKind::Prompt(p) = &f.kind { Some(p) } else { None }).last()
    }

    /// The newest assistant reply inside the window (the extraction without repeated text).
    pub fn last_assistant(&self, w: u64, cut: Cut) -> Option<&super::record::Assistant> {
        self.facts(w, cut).filter_map(|f| if let FactKind::Assistant(a) = &f.kind { Some(a) } else { None }).last()
    }

    /// What the keyed map knows about task `id` (it outlives the horizon within `transcript.task_map_max`).
    pub fn task(&self, id: &str) -> Option<&TaskRow> {
        self.s.tasks.get(id)
    }

    /// What the keyed map knows about agent `id` (a task id or a tool-use id).
    pub fn agent(&self, id: &str) -> Option<&AgentRow> {
        self.s.agents.get(id)
    }

    /// Every task row, oldest first.
    pub fn tasks(&self) -> impl Iterator<Item = (&String, &TaskRow)> {
        self.s.tasks.iter()
    }

    /// Every agent row, oldest first.
    pub fn agents(&self) -> impl Iterator<Item = (&String, &AgentRow)> {
        self.s.agents.iter()
    }

    /// Bytes this session holds.
    pub fn bytes(&self) -> usize {
        self.s.bytes()
    }
}

/// The registry of session stores.
pub struct Store {
    slots: Mutex<HashMap<PathBuf, Arc<Slot>>>,
    permits: Permits,
    stats: Stats,
    total_bytes: AtomicU64,
    cfg: Option<Cfg>,
    snap_dir: Option<PathBuf>,
    published: Mutex<StatsSnapshot>,
}

impl Default for Store {
    fn default() -> Self {
        Store::new()
    }
}

impl Store {
    /// A store with the shipped limits (re-read at every request, so a config reload takes effect).
    pub fn new() -> Store {
        Store {
            slots: Mutex::new(HashMap::new()),
            permits: Permits { free: Mutex::new(None), cv: Condvar::new() },
            stats: Stats::default(),
            total_bytes: AtomicU64::new(0),
            cfg: None,
            snap_dir: None,
            published: Mutex::new(StatsSnapshot::default()),
        }
    }

    /// A store with explicit limits and snapshot directory (tests).
    pub fn with_cfg(cfg: Cfg, snap_dir: Option<PathBuf>) -> Store {
        Store { cfg: Some(cfg), snap_dir, ..Store::new() }
    }

    fn cfg(&self) -> Cfg {
        self.cfg.clone().unwrap_or_else(Cfg::from_defaults)
    }

    fn snap_dir(&self) -> PathBuf {
        self.snap_dir.clone().unwrap_or_else(|| crate::paths::dir().join(defaults::text("transcript.snapshot_dir")))
    }

    /// The counters and live sizes now.
    pub fn stats(&self) -> StatsSnapshot {
        let s = &self.stats;
        StatsSnapshot {
            cold_builds: s.cold_builds.load(Relaxed),
            cold_bytes: s.cold_bytes.load(Relaxed),
            refresh_bytes: s.refresh_bytes.load(Relaxed),
            appended_bytes: s.appended_bytes.load(Relaxed),
            partial: s.partial.load(Relaxed),
            waits: s.waits.load(Relaxed),
            wait_timeouts: s.wait_timeouts.load(Relaxed),
            oversize_lines: s.oversize_lines.load(Relaxed),
            evictions: s.evictions.load(Relaxed),
            rebuilds: s.rebuilds.load(Relaxed),
            snapshot_loads: s.snapshot_loads.load(Relaxed),
            snapshot_misses: s.snapshot_misses.load(Relaxed),
            snapshot_writes: s.snapshot_writes.load(Relaxed),
            snapshot_skipped: s.snapshot_skipped.load(Relaxed),
            read_buf_max_bytes: s.read_buf_max.load(Relaxed),
            bytes: self.total_bytes.load(Relaxed),
            sessions: lock(&self.slots).len() as u64,
        }
    }

    /// Add what the counters gained since the last call to `m`, and set the gauges (the daemon calls this as each check finishes).
    pub fn publish(&self, m: &mut crate::metrics::Metrics) {
        let now = self.stats();
        let mut last = lock(&self.published);
        for ((name, v), (_, was)) in now.counters().into_iter().zip(last.counters()) {
            if v > was {
                m.add(name, &[], v - was);
            }
        }
        for (name, v) in now.gauges() {
            m.set(name, v);
        }
        *last = now;
    }

    /// Shrink to `target` bytes by evicting the least recently used sessions (the memory registry's soft limit).
    pub fn shrink(&self, target: usize) {
        let cfg = self.cfg();
        while self.bytes() > target {
            match self.take_victim(None) {
                Some((k, s)) => self.retire(&k, &s, &cfg),
                None => break,
            }
        }
    }

    /// Remove the least recently used session nobody is refreshing from the map (never `keep`). None when there is none.
    fn take_victim(&self, keep: Option<&Path>) -> Option<(PathBuf, Arc<Slot>)> {
        let mut map = lock(&self.slots);
        let mut order: Vec<(&PathBuf, u64)> = map.iter().filter(|(k, _)| Some(k.as_path()) != keep).map(|(k, s)| (k, s.last_used_ms.load(Relaxed))).collect();
        order.sort_by_key(|(_, t)| *t);
        let key = order.into_iter().find(|(k, _)| map.get(*k).is_some_and(|s| s.claim())).map(|(k, _)| k.clone())?;
        map.remove(&key).map(|s| (key, s))
    }

    /// Bytes all sessions hold now.
    pub fn bytes(&self) -> usize {
        self.total_bytes.load(Relaxed) as usize
    }

    /// Refresh the session of `path` (creating it on first use), then run `f` on its facts.
    pub fn with<R>(&self, path: &Path, now_ms: u64, f: impl FnOnce(&View) -> R) -> Result<R, Unsure> {
        let cfg = self.cfg();
        let deadline = Instant::now() + cfg.wait;
        let slot = loop {
            let slot = self.slot(path, now_ms, &cfg);
            let mut busy = lock(&slot.busy);
            if *busy {
                self.stats.waits.fetch_add(1, Relaxed);
            }
            while *busy {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    self.stats.wait_timeouts.fetch_add(1, Relaxed);
                    return Err(Unsure::Busy);
                }
                busy = slot.cv.wait_timeout(busy, left).unwrap_or_else(|e| e.into_inner()).0;
            }
            if slot.retired.load(SeqCst) {
                // left the map while this request waited: the map's slot (or a new one) is the one to use. BusyGuard wakes one
                // waiter; pass the wakeup on so every other waiter on this dead slot moves to the map's slot too.
                slot.cv.notify_all();
                continue;
            }
            *busy = true;
            drop(busy);
            break slot;
        };
        let _flight = BusyGuard(&slot);
        let mut sess = lock(&slot.data);
        let refreshed = self.refresh(&mut sess, path, &cfg, deadline);
        let now_bytes = sess.bytes() as u64;
        let before = slot.bytes.swap(now_bytes, SeqCst);
        self.adjust_total(before, now_bytes);
        if slot.retired.load(SeqCst) {
            // the session ended during this refresh: its bytes are no longer anyone's
            self.adjust_total(slot.bytes.swap(0, SeqCst), 0);
        }
        refreshed?;
        let out = f(&View { s: &sess, stats: &self.stats });
        drop(sess);
        self.enforce_global(&cfg, path);
        Ok(out)
    }

    fn adjust_total(&self, before: u64, after: u64) {
        if after >= before {
            self.total_bytes.fetch_add(after - before, Relaxed);
        } else {
            self.total_bytes.try_update(Relaxed, Relaxed, |t| Some(t.saturating_sub(before - after))).ok();
        }
    }

    fn slot(&self, path: &Path, now_ms: u64, cfg: &Cfg) -> Arc<Slot> {
        let mut retired: Vec<(PathBuf, Arc<Slot>)> = Vec::new();
        let slot = {
            let mut map = lock(&self.slots);
            let idle: Vec<PathBuf> = map
                .iter()
                .filter(|(_, s)| now_ms.saturating_sub(s.last_used_ms.load(Relaxed)) > cfg.idle_ttl_ms)
                .filter(|(_, s)| s.claim())
                .map(|(k, _)| k.clone())
                .collect();
            for k in idle {
                if let Some(s) = map.remove(&k) {
                    retired.push((k, s));
                }
            }
            if !map.contains_key(path) && map.len() >= cfg.max_sessions.max(1) {
                let mut order: Vec<(PathBuf, u64)> = map.iter().map(|(k, s)| (k.clone(), s.last_used_ms.load(Relaxed))).collect();
                order.sort_by_key(|(_, t)| *t);
                if let Some(k) = order.into_iter().map(|(k, _)| k).find(|k| map.get(k).is_some_and(|s| s.claim()))
                    && let Some(s) = map.remove(&k)
                {
                    retired.push((k, s));
                }
            }
            map.entry(path.to_path_buf())
                .or_insert_with(|| {
                    Arc::new(Slot {
                        busy: Mutex::new(false),
                        cv: Condvar::new(),
                        data: Mutex::new(Session::default()),
                        bytes: AtomicU64::new(0),
                        last_used_ms: AtomicU64::new(now_ms),
                        retired: AtomicBool::new(false),
                    })
                })
                .clone()
        };
        slot.last_used_ms.store(now_ms, Relaxed);
        for (k, s) in retired {
            self.retire(&k, &s, cfg);
        }
        slot
    }

    /// A session leaves the map: its bytes are released and, when it is idle, its facts are written for the next start.
    fn retire(&self, path: &Path, slot: &Slot, cfg: &Cfg) {
        self.stats.evictions.fetch_add(1, Relaxed);
        self.adjust_total(slot.bytes.swap(0, Relaxed), 0);
        if let Ok(sess) = slot.data.try_lock() {
            self.write_snapshot(path, &sess, cfg);
        }
    }

    fn enforce_global(&self, cfg: &Cfg, keep: &Path) {
        while self.total_bytes.load(Relaxed) as usize > cfg.global_budget {
            match self.take_victim(Some(keep)) {
                Some((k, s)) => self.retire(&k, &s, cfg),
                None => break,
            }
        }
    }

    /// Drop the session of `path` (the session ended).
    pub fn drop_session(&self, path: &Path) {
        let cfg = self.cfg();
        let gone = lock(&self.slots).remove(path);
        if let Some(s) = gone {
            s.force_retire();
            self.adjust_total(s.bytes.swap(0, SeqCst), 0);
            let _ = cfg;
        }
    }

    /// Write every idle session's facts to the snapshot directory (the idle sweep and shutdown call this).
    pub fn persist_all(&self) -> usize {
        let cfg = self.cfg();
        let slots: Vec<(PathBuf, Arc<Slot>)> = lock(&self.slots).iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let mut n = 0;
        for (k, s) in slots {
            if let Ok(sess) = s.data.try_lock()
                && self.write_snapshot(&k, &sess, &cfg)
            {
                n += 1;
            }
        }
        persist::sweep(&self.snap_dir(), cfg.snapshot_ttl_ms, cfg.snapshot_max_files);
        n
    }

    fn write_snapshot(&self, path: &Path, sess: &Session, cfg: &Cfg) -> bool {
        if !sess.built {
            return false;
        }
        match persist::write(&self.snap_dir(), path, sess, cfg.snapshot_max) {
            persist::Wrote::Yes => {
                self.stats.snapshot_writes.fetch_add(1, Relaxed);
                true
            }
            persist::Wrote::TooBig => {
                self.stats.snapshot_skipped.fetch_add(1, Relaxed);
                false
            }
            persist::Wrote::Failed => false,
        }
    }

    // ---- the refresh ----------------------------------------------------------------------------------------

    fn refresh(&self, s: &mut Session, path: &Path, cfg: &Cfg, deadline: Instant) -> Result<(), Unsure> {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                s.clear();
                return Err(Unsure::Missing);
            }
            Err(e) => return Err(Unsure::Io(e.kind())),
        };
        let meta = file.metadata().map_err(|e| Unsure::Io(e.kind()))?;
        let size = meta.len();
        if size == 0 {
            s.clear();
            return Err(Unsure::Missing);
        }
        let mut plan = self.plan(s, &file, &meta, cfg).map_err(|e| Unsure::Io(e.kind()))?;
        if plan == Plan::Cold && self.try_snapshot(s, path, &file, &meta, cfg) {
            plan = if size == s.seen_size && size >= s.offset { Plan::Unchanged } else { Plan::Append };
        }
        match plan {
            Plan::Unchanged => {
                s.seen_size = size;
                Ok(())
            }
            Plan::Append => self.append(s, &file, &meta, cfg),
            Plan::Cold | Plan::Rebuild | Plan::Gap => {
                let Some(_permit) = self.permits.acquire(cfg.permits, deadline) else {
                    self.stats.wait_timeouts.fetch_add(1, Relaxed);
                    return Err(Unsure::Busy);
                };
                self.stats.cold_builds.fetch_add(1, Relaxed);
                self.build(s, &file, &meta, cfg, plan == Plan::Gap)
            }
        }
    }

    fn plan(&self, s: &mut Session, file: &File, meta: &std::fs::Metadata, cfg: &Cfg) -> std::io::Result<Plan> {
        if !s.built {
            return Ok(Plan::Cold);
        }
        let size = meta.len();
        let changed = s.id.is_some_and(|i| i != (meta.dev(), meta.ino())) || size < s.offset || !prefix_intact(s, file)?;
        if changed {
            self.stats.rebuilds.fetch_add(1, Relaxed);
            return Ok(Plan::Rebuild);
        }
        if size - s.offset > cfg.horizon {
            return Ok(Plan::Gap);
        }
        Ok(if size == s.seen_size { Plan::Unchanged } else { Plan::Append })
    }

    /// Adopt the snapshot of this transcript when every stamp still matches.
    fn try_snapshot(&self, s: &mut Session, path: &Path, file: &File, meta: &std::fs::Metadata, cfg: &Cfg) -> bool {
        let snap = match persist::read(&self.snap_dir(), path, cfg.snapshot_max) {
            Ok(snap) => snap,
            Err(persist::Miss::Absent) => return false,
            Err(persist::Miss::Unusable) => {
                // there is a snapshot and it is corrupt, over the cap or of another format or configuration
                self.stats.snapshot_misses.fetch_add(1, Relaxed);
                return false;
            }
        };
        let fits = |snap: &persist::Snap| snap.id == (meta.dev(), meta.ino()) && snap.offset <= meta.len() && meta.len() - snap.offset <= cfg.horizon;
        if !fits(&snap) {
            self.stats.snapshot_misses.fetch_add(1, Relaxed);
            return false;
        }
        let mut cand = snap.into_session();
        let ok = prefix_intact(&cand, file).unwrap_or(false);
        if !ok {
            self.stats.snapshot_misses.fetch_add(1, Relaxed);
            return false;
        }
        cand.recount_maps();
        cand.fact_bytes = cand.facts.iter().map(|f| f.bytes(cfg.fact_fixed)).sum();
        *s = cand;
        self.stats.snapshot_loads.fetch_add(1, Relaxed);
        true
    }

    fn build(&self, s: &mut Session, file: &File, meta: &std::fs::Metadata, cfg: &Cfg, keep_maps: bool) -> Result<(), Unsure> {
        let size = meta.len();
        let kept = keep_maps.then(|| (std::mem::take(&mut s.tasks), std::mem::take(&mut s.agents), std::mem::take(&mut s.task_ids)));
        s.clear();
        if let Some((tasks, agents, ids)) = kept {
            (s.tasks, s.agents, s.task_ids) = (tasks, agents, ids);
            s.recount_maps();
        }
        let io = |e: std::io::Error| Unsure::Io(e.kind());
        let start = size.saturating_sub(cfg.horizon);
        let mut from = start;
        if start > 0 {
            // a window starting inside a line drops the rest of that line, as readTail does; a window that starts at a line start keeps it
            let mut prev = 0u8;
            file.read_exact_at(std::slice::from_mut(&mut prev), start - 1).map_err(io)?;
            if prev != b'\n' {
                let mut r = LineReader::new(file, cfg.read, start, size);
                match r.next_line().map_err(io)? {
                    Some(l) if l.terminated => from = l.off + l.len,
                    _ => from = size,
                }
                self.stats.read_buf_max.fetch_max(r.peak_bytes() as u64, Relaxed);
                self.stats.cold_bytes.fetch_add(from - start, Relaxed);
            }
        }
        s.covered_from = start;
        s.offset = from;
        s.id = Some((meta.dev(), meta.ino()));
        s.built = true;
        let read = self.fold(s, file, cfg, from, size)?;
        self.stats.cold_bytes.fetch_add(read, Relaxed);
        s.seen_size = size;
        finish(s, file, cfg).map_err(io)?;
        s.trim(cfg, size);
        Ok(())
    }

    fn append(&self, s: &mut Session, file: &File, meta: &std::fs::Metadata, cfg: &Cfg) -> Result<(), Unsure> {
        let size = meta.len();
        let grew = size.saturating_sub(s.seen_size);
        let from = s.offset;
        let read = self.fold(s, file, cfg, from, size)?;
        self.stats.refresh_bytes.fetch_add(read, Relaxed);
        self.stats.appended_bytes.fetch_add(grew, Relaxed);
        s.seen_size = size;
        finish(s, file, cfg).map_err(|e| Unsure::Io(e.kind()))?;
        s.trim(cfg, size);
        Ok(())
    }

    /// Read `[from, size)` line by line and fold the complete lines into the facts; the unterminated last line becomes the
    /// pending overlay. Returns the bytes consumed.
    fn fold(&self, s: &mut Session, file: &File, cfg: &Cfg, from: u64, size: u64) -> Result<u64, Unsure> {
        let io = |e: std::io::Error| Unsure::Io(e.kind());
        let mut r = LineReader::new(file, cfg.read, from, size);
        s.pending.clear();
        let mut consumed = 0u64;
        while let Some(line) = r.next_line().map_err(io)? {
            if !line.terminated {
                if !line.oversize && line.len as usize <= cfg.read.max_line {
                    let text = String::from_utf8_lossy(r.bytes());
                    s.ingest(cfg, line.off, &text, true);
                }
                break;
            }
            consumed += line.len;
            s.offset = line.off + line.len;
            if line.oversize {
                self.stats.oversize_lines.fetch_add(1, Relaxed);
                s.oversize.push_back(line.off);
                continue;
            }
            let text = String::from_utf8_lossy(r.bytes());
            s.ingest(cfg, line.off, &text, false);
            if s.bytes() > cfg.session_budget {
                s.trim(cfg, size);
            }
            #[cfg(test)]
            tests::probe(self, s);
        }
        self.stats.read_buf_max.fetch_max(r.peak_bytes() as u64, Relaxed);
        Ok(consumed)
    }
}

/// True when the file still begins, and continues at the offset, the way it did when the session read it.
fn prefix_intact(s: &Session, file: &File) -> std::io::Result<bool> {
    if let Some((len, h)) = s.head {
        let mut b = vec![0u8; len];
        if file.read_exact_at(&mut b, 0).is_err() || fnv(&b) != h {
            return Ok(false);
        }
    }
    if let Some((len, h)) = s.tail {
        let mut b = vec![0u8; len as usize];
        if s.offset < len || file.read_exact_at(&mut b, s.offset - len).is_err() || fnv(&b) != h {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Record the change detectors for the state just reached.
fn finish(s: &mut Session, file: &File, cfg: &Cfg) -> std::io::Result<()> {
    let want = (cfg.fingerprint as u64).min(s.seen_size) as usize;
    if s.head.is_none_or(|(len, _)| len < want) {
        let mut b = vec![0u8; want];
        file.read_exact_at(&mut b, 0)?;
        s.head = Some((want, fnv(&b)));
    }
    let len = (cfg.tail_probe as u64).min(s.offset);
    s.tail = if len == 0 {
        None
    } else {
        let mut b = vec![0u8; len as usize];
        file.read_exact_at(&mut b, s.offset - len)?;
        Some((len, fnv(&b)))
    };
    Ok(())
}

static GLOBAL: OnceLock<Store> = OnceLock::new();

/// The process-wide store the daemon's checks ask.
pub fn global() -> &'static Store {
    GLOBAL.get_or_init(Store::new)
}

struct MemOwner;

impl crate::mem::Owner for MemOwner {
    // A memory poll never creates the store: until a check asks it a question there is nothing to count or shrink.
    fn bytes(&self) -> usize {
        global_if_started().map_or(0, Store::bytes)
    }
    fn shrink(&self, target: usize) {
        if let Some(st) = global_if_started() {
            st.shrink(target);
        }
    }
    fn recycle(&self) {
        if let Some(st) = global_if_started() {
            st.shrink(0);
        }
    }
}

/// Register the global store as the `transcript_store` memory holder (the daemon calls it at start).
pub fn register_mem() -> crate::mem::Budget {
    static ANCHOR: OnceLock<Arc<MemOwner>> = OnceLock::new();
    let owner = ANCHOR.get_or_init(|| Arc::new(MemOwner)).clone();
    let weak: std::sync::Weak<MemOwner> = Arc::downgrade(&owner);
    crate::mem::global().register(
        crate::mem::Spec::new("transcript_store", "mem.transcript_store_soft_bytes", "mem.transcript_store_hard_bytes", "mem.transcript_store_low_water_pct"),
        weak,
    )
}

/// The global store when something has asked it a question already (the daemon publishes its counters only then).
pub fn global_if_started() -> Option<&'static Store> {
    GLOBAL.get()
}

#[cfg(test)]
mod tests {
    //! Hooks into the middle of a refresh: the probe runs on the refreshing thread after each folded line, so a test can
    //! observe the session while it is being built and end the session while its refresh is running.
    use super::*;
    use std::cell::RefCell;

    type Probe = Box<dyn FnMut(&Store, &Session)>;
    thread_local! { static PROBE: RefCell<Option<Probe>> = const { RefCell::new(None) }; }

    pub(super) fn probe(st: &Store, s: &Session) {
        PROBE.with(|p| {
            if let Some(f) = p.borrow_mut().as_mut() {
                f(st, s);
            }
        });
    }

    fn line(i: usize, pad: usize) -> String {
        format!("{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"prompt-{i:05} {}\"}}}}\n", "x".repeat(pad))
    }

    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Dir {
            let d = std::env::temp_dir().join(format!("ah-store-{tag}-{}", std::process::id()));
            std::fs::create_dir_all(&d).unwrap();
            Dir(d)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).ok();
        }
    }

    fn cfg_with_budget(budget: usize) -> Cfg {
        let mut c = Cfg::from_defaults();
        c.wait = Duration::from_millis(500);
        c.session_budget = budget;
        c
    }

    /// The peak the session reaches while one big append is folded must stay within the budget: the per-line trim, not
    /// only the final trim, keeps it there.
    #[test]
    fn a_big_append_never_exceeds_the_session_budget_at_any_point() {
        let d = Dir::new("peak");
        let f = d.0.join("s.jsonl");
        std::fs::write(&f, line(0, 100)).unwrap();
        let st = Store::with_cfg(cfg_with_budget(16 * 1024), None);
        st.with(&f, 0, |_| ()).unwrap();
        let more: String = (1..=200).map(|i| line(i, 500)).collect();
        std::io::Write::write_all(&mut std::fs::OpenOptions::new().append(true).open(&f).unwrap(), more.as_bytes()).unwrap();
        let peak = Arc::new(AtomicU64::new(0));
        let p2 = peak.clone();
        PROBE.with(|p| {
            *p.borrow_mut() = Some(Box::new(move |_, s| {
                p2.fetch_max(s.bytes() as u64, Relaxed);
            }))
        });
        st.with(&f, 1, |_| ()).unwrap();
        PROBE.with(|p| *p.borrow_mut() = None);
        let peak = peak.load(Relaxed);
        assert!(peak > 0, "the probe never ran");
        assert!(peak <= 16 * 1024, "the session reached {peak} bytes during the append, over its 16384 budget");
    }

    /// The session ends while its refresh is running (not while `f` runs): the refresh's bytes must not be counted.
    #[test]
    fn ending_a_session_in_the_middle_of_its_refresh_leaves_no_bytes() {
        let d = Dir::new("drop");
        let f = d.0.join("s.jsonl");
        std::fs::write(&f, (0..30).map(|i| line(i, 400)).collect::<String>()).unwrap();
        let st = Store::with_cfg(cfg_with_budget(1 << 20), None);
        let (f2, once) = (f.clone(), std::cell::Cell::new(false));
        PROBE.with(|p| {
            *p.borrow_mut() = Some(Box::new(move |st, _| {
                if !once.replace(true) {
                    st.drop_session(&f2);
                }
            }))
        });
        st.with(&f, 0, |_| ()).unwrap();
        PROBE.with(|p| *p.borrow_mut() = None);
        let s = st.stats();
        assert_eq!((s.sessions, s.bytes), (0, 0), "{s:?}");
    }
}
