//! The topology registry: who talks to the engine and what the engine touches, for the dashboard's topology screen.
//!
//! Counters only, no per-call log. The registry sits at the engine's existing chokepoints (the connection handler, the atomic
//! file write, the database layer, the transcript tail reader, the config file read) and does not touch their call sites:
//!
//! * per client (a hook session): calls, latency p50/p95, timeouts, fail-opens, and the first call seen since the daemon started
//!   (a cold start of that client against this daemon);
//! * per store (a config, state or log file, a database, the transcript reads): reads, writes, bytes, errors, last access;
//! * the worker pool: calls, busy time, and (from the daemon) queue depth and busy workers; the daemon's thread groups come from
//!   [`crate::threads`].
//!
//! A call adds to its counters under one short lock; only every `topology.latency_sample_every`th call also fills the latency
//! histogram and times the registry itself, so the report can say what the registry costs against `topology.overhead_budget_ns`.
//! The tables are bounded by a soft and a hard limit each. Every number, name and text is in `defaults/topology.toml`.
//!
//! The registry is process-wide and lives in the daemon. [`report`] is the in-process function the web server calls;
//! `ah-engine topology --json` asks the daemon for the same document.
use crate::{cli, client, defaults};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;

/// How a served call ended, as far as its client is concerned.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Served {
    /// Answered in time.
    Ok,
    /// Answered after the client's deadline.
    Timeout,
    /// The engine could not decide (busy or internal error): the client fails open.
    FailOpen,
}

#[derive(Default)]
struct Client {
    calls: u64,
    timeouts: u64,
    fail_opens: u64,
    cold_starts: u64,
    sampled: u64,
    hist: Vec<u64>,
    last_ms: u64,
}

#[derive(Default)]
struct Store {
    reads: u64,
    writes: u64,
    bytes_read: u64,
    bytes_written: u64,
    errors: u64,
    last_ms: u64,
}

struct Reg {
    clients: BTreeMap<String, Client>,
    stores: BTreeMap<String, Store>,
    dropped: u64,
    soft_hits: u64,
    worker_calls: u64,
    worker_busy_us: u64,
    overhead_ns: u64,
    overhead_samples: u64,
}

static REG: Mutex<Reg> = Mutex::new(Reg {
    clients: BTreeMap::new(),
    stores: BTreeMap::new(),
    dropped: 0,
    soft_hits: 0,
    worker_calls: 0,
    worker_busy_us: 0,
    overhead_ns: 0,
    overhead_samples: 0,
});
static CALLS: AtomicU64 = AtomicU64::new(0);

fn reg() -> std::sync::MutexGuard<'static, Reg> {
    REG.lock().unwrap_or_else(|e| e.into_inner())
}

/// Off when the shipped defaults do not carry the registry's settings (a plugin tree older than this binary): it then counts nothing
/// rather than failing the call it sits in.
fn enabled() -> bool {
    defaults::has("topology.enabled") && defaults::num("topology.enabled") != 0
}

fn key(name: &str) -> String {
    name.chars().take(defaults::num("topology.key_max") as usize).collect()
}

fn bounds() -> Vec<u64> {
    defaults::raw("topology.latency_bounds_us").as_array().unwrap_or_default().iter().filter_map(|v| v.as_integer()).map(|n| n.max(0) as u64).collect()
}

/// Admit a new table entry under the soft and hard limits; false when the hard limit refuses it.
fn admit(len: usize, soft: &str, hard: &str, r: &mut Reg) -> bool {
    if len >= defaults::num(hard) as usize {
        r.dropped += 1;
        return false;
    }
    if len >= defaults::num(soft) as usize {
        r.soft_hits += 1;
    }
    true
}

/// One call served for `client` (a session id; `None` when it named none): how it ended and how long the worker spent on it.
pub fn served(client: Option<&str>, how: Served, proc_us: u64) {
    if !enabled() {
        return;
    }
    let every = defaults::num("topology.latency_sample_every").max(1);
    let sample = CALLS.fetch_add(1, Relaxed).is_multiple_of(every);
    let timer = sample.then(Instant::now);
    let name = key(client.filter(|c| !c.is_empty()).unwrap_or(defaults::text("topology.label_unknown_client")));
    let mut r = reg();
    r.worker_calls += 1;
    r.worker_busy_us += proc_us;
    if !r.clients.contains_key(&name) {
        let len = r.clients.len();
        if !admit(len, "topology.clients_soft", "topology.clients_hard", &mut r) {
            return;
        }
        r.clients.insert(name.clone(), Client { cold_starts: 1, ..Client::default() });
    }
    if let Some(c) = r.clients.get_mut(&name) {
        c.calls += 1;
        c.last_ms = crate::health::now_ms();
        match how {
            Served::Ok => {}
            Served::Timeout => c.timeouts += 1,
            Served::FailOpen => c.fail_opens += 1,
        }
        if sample {
            let edges = defaults::raw("topology.latency_bounds_us").as_array().unwrap_or_default();
            if c.hist.len() != edges.len() + 1 {
                c.hist = vec![0; edges.len() + 1];
            }
            let at = edges.iter().filter_map(|v| v.as_integer()).position(|b| proc_us as i64 <= b).unwrap_or(edges.len());
            c.hist[at] += 1;
            c.sampled += 1;
        }
    }
    if let Some(t) = timer {
        r.overhead_ns += t.elapsed().as_nanos() as u64;
        r.overhead_samples += 1;
    }
}

fn store_op(label: &str, bytes: u64, ok: bool, write: bool) {
    if !enabled() {
        return;
    }
    let name = key(label);
    let mut r = reg();
    if !r.stores.contains_key(&name) {
        let len = r.stores.len();
        if !admit(len, "topology.stores_soft", "topology.stores_hard", &mut r) {
            return;
        }
        r.stores.insert(name.clone(), Store::default());
    }
    if let Some(s) = r.stores.get_mut(&name) {
        s.last_ms = crate::health::now_ms();
        s.errors += u64::from(!ok);
        if write {
            s.writes += 1;
            s.bytes_written += bytes;
        } else {
            s.reads += 1;
            s.bytes_read += bytes;
        }
    }
}

/// The engine read `bytes` from the store `label` (`ok` false when the read failed).
pub fn store_read(label: &str, bytes: u64, ok: bool) {
    store_op(label, bytes, ok, false);
}

/// The engine wrote `bytes` to the store `label` (`ok` false when the write failed).
pub fn store_write(label: &str, bytes: u64, ok: bool) {
    store_op(label, bytes, ok, true);
}

/// The store name of a file: its first component under the state directory, or the path with the home directory shortened.
pub fn store_name(path: &Path) -> String {
    let state = crate::paths::dir();
    if let Ok(rel) = path.strip_prefix(&state)
        && let Some(first) = rel.components().next()
    {
        return first.as_os_str().to_string_lossy().into_owned();
    }
    if let Some(home) = defaults::env_var("home")
        && let Ok(rel) = path.strip_prefix(home)
    {
        return format!("{}/{}", defaults::text("topology.label_outside_state"), rel.display());
    }
    path.display().to_string()
}

/// A file read of `bytes` (`ok` false on failure), by path.
pub fn file_read(path: &Path, bytes: u64, ok: bool) {
    if enabled() {
        store_read(&store_name(path), bytes, ok);
    }
}

/// A file write of `bytes` (`ok` false on failure), by path.
pub fn file_write(path: &Path, bytes: u64, ok: bool) {
    if enabled() {
        store_write(&store_name(path), bytes, ok);
    }
}

/// What the daemon knows that the registry does not: the queue and the pool.
#[derive(Clone, Copy, Debug, Default)]
pub struct Gauges {
    /// Connections waiting for a worker.
    pub queue_depth: u64,
    /// Workers serving a request now.
    pub busy_workers: u64,
    /// Workers in the pool.
    pub workers: u64,
}

fn quantile(hist: &[u64], bounds: &[u64], q_pct: u64) -> u64 {
    let total: u64 = hist.iter().sum();
    if total == 0 {
        return 0;
    }
    let want = (total * q_pct).div_ceil(100).max(1);
    let mut seen = 0;
    for (i, n) in hist.iter().enumerate() {
        seen += n;
        if seen >= want {
            return bounds.get(i).or(bounds.last()).copied().unwrap_or(0);
        }
    }
    bounds.last().copied().unwrap_or(0)
}

fn pct(part: u64, whole: u64) -> u64 {
    (part * 100).checked_div(whole).unwrap_or(0)
}

/// `bad` / `warn` / `ok` for a value against its two thresholds (a zero threshold is not used).
fn judge(value: u64, warn: &str, bad: &str) -> &'static str {
    let (w, b) = (defaults::num(warn), defaults::num(bad));
    if b > 0 && value >= b {
        defaults::text("topology.state_bad")
    } else if w > 0 && value >= w {
        defaults::text("topology.state_warn")
    } else {
        defaults::text("topology.state_ok")
    }
}

fn worse(a: &'static str, b: &'static str) -> &'static str {
    let rank = |s: &str| [defaults::text("topology.state_ok"), defaults::text("topology.state_warn"), defaults::text("topology.state_bad")].iter().position(|x| *x == s).unwrap_or(0);
    if rank(b) > rank(a) { b } else { a }
}

/// The topology document: nodes, links, health and the registry's own overhead. `g` is what the daemon adds.
pub fn report(g: Gauges) -> Value {
    let bounds = bounds();
    let (engine, workers) = (defaults::text("topology.label_engine"), defaults::text("topology.label_workers"));
    let min_calls = defaults::num("topology.min_calls_for_health");
    let (mut nodes, mut links) = (Vec::new(), Vec::new());
    let mut engine_health = defaults::text("topology.state_ok");
    let (overhead, dropped, soft_hits, worker_calls, worker_busy_us);
    {
        let r = reg();
        for (name, c) in &r.clients {
            let (p50, p95) = (quantile(&c.hist, &bounds, 50), quantile(&c.hist, &bounds, 95));
            let mut h = defaults::text("topology.state_ok");
            if c.calls >= min_calls {
                h = worse(h, judge(pct(c.fail_opens, c.calls), "topology.warn_fail_open_pct", "topology.bad_fail_open_pct"));
                h = worse(h, judge(p95, "topology.warn_p95_us", "topology.bad_p95_us"));
            }
            engine_health = worse(engine_health, h);
            let id = format!("{}:{name}", defaults::text("topology.kind_client"));
            nodes.push(json!({"id": id, "kind": defaults::text("topology.kind_client"), "label": name, "health": h, "last_ms": c.last_ms,
                "calls": c.calls, "p50_us": p50, "p95_us": p95, "timeouts": c.timeouts, "fail_opens": c.fail_opens, "cold_starts": c.cold_starts}));
            links.push(json!({"from": id, "to": engine, "calls": c.calls, "p95_us": p95}));
        }
        for (name, s) in &r.stores {
            let ops = s.reads + s.writes;
            let mut h = defaults::text("topology.state_ok");
            if ops >= min_calls {
                h = judge(pct(s.errors, ops), "topology.warn_store_error_pct", "topology.bad_store_error_pct");
            }
            let id = format!("{}:{name}", defaults::text("topology.kind_store"));
            nodes.push(json!({"id": id, "kind": defaults::text("topology.kind_store"), "label": name, "health": h, "last_ms": s.last_ms,
                "reads": s.reads, "writes": s.writes, "bytes_read": s.bytes_read, "bytes_written": s.bytes_written, "errors": s.errors}));
            links.push(json!({"from": engine, "to": id, "reads": s.reads, "writes": s.writes}));
        }
        (overhead, dropped, soft_hits, worker_calls, worker_busy_us) = (
            (r.overhead_ns.checked_div(r.overhead_samples).unwrap_or(0), r.overhead_samples),
            r.dropped,
            r.soft_hits,
            r.worker_calls,
            r.worker_busy_us,
        );
    }
    let pool_health = judge(g.queue_depth, "topology.warn_queue_depth", "topology.bad_queue_depth");
    engine_health = worse(engine_health, pool_health);
    let pool_id = format!("{}:{workers}", defaults::text("topology.kind_subsystem"));
    nodes.push(json!({"id": pool_id, "kind": defaults::text("topology.kind_subsystem"), "label": workers, "health": pool_health,
        "calls": worker_calls, "busy_us": worker_busy_us, "queue_depth": g.queue_depth, "busy_workers": g.busy_workers, "workers": g.workers}));
    links.push(json!({"from": engine, "to": pool_id}));
    let mut groups: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for t in crate::threads::snapshot() {
        let name = if t.name.is_empty() { defaults::text("topology.label_unnamed_thread").to_string() } else { t.name };
        let g = groups.entry(name).or_default();
        g.0 += 1;
        g.1 += t.cpu_us;
    }
    for (name, (threads, cpu_us)) in groups {
        let id = format!("{}:{name}", defaults::text("topology.kind_subsystem"));
        nodes.push(json!({"id": id, "kind": defaults::text("topology.kind_subsystem"), "label": name, "health": defaults::text("topology.state_ok"), "threads": threads, "busy_us": cpu_us}));
        links.push(json!({"from": engine, "to": id}));
    }
    nodes.push(json!({"id": engine, "kind": defaults::text("topology.kind_engine"), "label": engine, "health": engine_health, "pid": std::process::id()}));
    let budget = defaults::num("topology.overhead_budget_ns");
    json!({"running": true, "enabled": enabled(), "at_ms": crate::health::now_ms(), "nodes": nodes, "links": links,
        "limits": {"dropped": dropped, "soft_hits": soft_hits},
        "overhead": {"avg_ns": overhead.0, "samples": overhead.1, "budget_ns": budget, "over_budget": overhead.0 > budget,
            "sample_every": defaults::num("topology.latency_sample_every")}})
}

/// `ah-engine topology [--json]`: the daemon's report.
pub fn run_cmd(p: &cli::Parsed) -> i32 {
    match client::ctl_json(defaults::text("topology.ctl_verb")) {
        Some(v) => {
            println!("{}", if p.json { v.to_string() } else { human(&v) });
            0
        }
        None => {
            let msg = defaults::text("topology.msg_not_running");
            println!("{}", if p.json { json!({"running": false, "note": msg}).to_string() } else { msg.to_string() });
            0
        }
    }
}

fn human(v: &Value) -> String {
    let mut out = String::new();
    for n in v["nodes"].as_array().into_iter().flatten() {
        out.push_str(&format!("{:<10} {:<40} {}\n", n["kind"].as_str().unwrap_or(""), n["label"].as_str().unwrap_or(""), n["health"].as_str().unwrap_or("")));
    }
    out.push_str(&format!("overhead avg {} ns / budget {} ns over {} samples\n", v["overhead"]["avg_ns"], v["overhead"]["budget_ns"], v["overhead"]["samples"]));
    out
}
