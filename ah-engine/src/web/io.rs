//! The I/O and connection registry (plan v3 section 8): what the engine reads and writes, and who calls it, as fixed tables of
//! relaxed atomics. No lock, no allocation and no log line per call.
//!
//! * per store (`io.stores`: `id|needle` rows, matched against a file path; a store without a file, such as the database, is named
//!   directly): `reads, writes, bytes_in, bytes_out, errors, last_ms`, and a 16-bucket log2 latency histogram for the operations that
//!   are timed (the atomic file write);
//! * per client (a hook session, `io.max_clients` rows, least-recently-used replacement): `calls, timeouts, fail_open, cold_starts,
//!   last_ms` and the same histogram. A cold start is the first call the daemon sees from a client row (a new client, or one that
//!   was evicted and came back).
//!
//! The counters sit at the existing chokepoints (the connection handler, the atomic write, the database layer, the config read, the
//! transcript scan counter); no call site changes. Budget (`io.toml`): memory at most `io.mem_hard_kb`, per-op cost at most
//! `io.op_ns_hard` (measured by `CTL io bench=1`); above a hard limit the registry switches itself off for this daemon run.
use crate::defaults;
use serde_json::{Value, json};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

const BUCKETS: usize = 16;

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
struct Hist([AtomicU64; BUCKETS]);

impl Hist {
    fn add(&self, us: u64) {
        let b = (63 - us.max(1).leading_zeros() as usize).min(BUCKETS - 1);
        self.0[b].fetch_add(1, Relaxed);
    }
    fn counts(&self) -> Vec<u64> {
        self.0.iter().map(|c| c.load(Relaxed)).collect()
    }
}

/// The bucket's upper bound in microseconds (bucket `b` holds `2^b ..< 2^(b+1)`).
fn quantile_us(counts: &[u64], pct: u64) -> u64 {
    let total: u64 = counts.iter().sum();
    let want = (total * pct).div_ceil(100).max(1);
    let mut seen = 0;
    for (b, n) in counts.iter().enumerate() {
        seen += n;
        if total > 0 && seen >= want {
            return 1u64 << (b + 1);
        }
    }
    0
}

#[derive(Default)]
struct StoreRow {
    reads: AtomicU64,
    writes: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
    errors: AtomicU64,
    last_ms: AtomicU64,
    hist: Hist,
}

#[derive(Default)]
struct ClientRow {
    key: AtomicU64,
    calls: AtomicU64,
    timeouts: AtomicU64,
    fail_open: AtomicU64,
    cold_starts: AtomicU64,
    last_ms: AtomicU64,
    hist: Hist,
}

struct Reg {
    ids: Vec<&'static str>,
    needles: Vec<(usize, &'static str)>,
    stores: Vec<StoreRow>,
    clients: Vec<ClientRow>,
    names: Mutex<Vec<String>>,
    mem_bytes: usize,
}

static REG: OnceLock<Option<Reg>> = OnceLock::new();
static ON: AtomicBool = AtomicBool::new(true);

fn reg() -> Option<&'static Reg> {
    if !ON.load(Relaxed) || !defaults::has("io.enabled") || defaults::num("io.enabled") == 0 {
        return None;
    }
    REG.get_or_init(build).as_ref()
}

fn build() -> Option<Reg> {
    let (mut ids, mut needles) = (Vec::new(), Vec::new());
    for row in defaults::list("io.stores") {
        let (id, needle) = row.split_once('|').unwrap_or((row, ""));
        if ids.len() < (defaults::num("io.max_stores") as usize).saturating_sub(1) && !ids.contains(&id) {
            ids.push(id);
        }
        if !needle.is_empty()
            && let Some(i) = ids.iter().position(|x| *x == id)
        {
            needles.push((i, needle));
        }
    }
    ids.push(defaults::text("io.other_id"));
    let nclients = defaults::num("io.max_clients") as usize;
    let mem_bytes = ids.len() * std::mem::size_of::<StoreRow>() + nclients * (std::mem::size_of::<ClientRow>() + defaults::num("io.client_name_max") as usize);
    if mem_bytes as u64 > defaults::num("io.mem_hard_kb") * 1024 {
        crate::health::log_event("io", "disabled", &defaults::render("io.msg_mem_hard", &[("bytes", &mem_bytes)]));
        return None;
    }
    Some(Reg {
        stores: ids.iter().map(|_| StoreRow::default()).collect(),
        clients: (0..nclients).map(|_| ClientRow::default()).collect(),
        names: Mutex::new(vec![String::new(); nclients]),
        ids,
        needles,
        mem_bytes,
    })
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x100000001b3)).max(1)
}

impl Reg {
    fn by_id(&self, id: &str) -> usize {
        self.ids.iter().position(|x| *x == id).unwrap_or(self.ids.len() - 1)
    }
    fn by_path(&self, path: &str) -> usize {
        self.needles.iter().find(|(_, n)| path.contains(n)).map_or(self.ids.len() - 1, |(i, _)| *i)
    }
    fn store(&self, i: usize, bytes: u64, ok: bool, write: bool, us: Option<u64>) {
        let s = &self.stores[i];
        if write {
            s.writes.fetch_add(1, Relaxed);
            s.bytes_out.fetch_add(bytes, Relaxed);
        } else {
            s.reads.fetch_add(1, Relaxed);
            s.bytes_in.fetch_add(bytes, Relaxed);
        }
        s.errors.fetch_add(u64::from(!ok), Relaxed);
        s.last_ms.store(crate::health::now_ms(), Relaxed);
        if let Some(us) = us {
            s.hist.add(us);
        }
    }
}

/// An operation on the store named `id` (an `io.stores` id; an unknown one counts as `other`).
pub fn store_op(id: &str, bytes: u64, ok: bool, write: bool) {
    if let Some(r) = reg() {
        r.store(r.by_id(id), bytes, ok, write, None);
    }
}

/// An operation on a file, classified by its path (an unmatched path counts as `other`); `us` is its time when it was measured.
pub fn path_op(path: &Path, bytes: u64, ok: bool, write: bool, us: Option<u64>) {
    if let Some(r) = reg() {
        r.store(r.by_path(&path.to_string_lossy()), bytes, ok, write, us);
    }
}

/// The transcript scan counter: `bytes` read by a check.
pub fn transcript_read(bytes: u64) {
    store_op(defaults::text("io.id_transcripts"), bytes, true, false);
}

/// One call served for `client` (a session id; `None` when the call named none).
pub fn client(client: Option<&str>, how: Served, proc_us: u64) {
    let Some(r) = reg() else { return };
    let key = fnv(client.filter(|c| !c.is_empty()).unwrap_or(defaults::text("io.unknown_client")));
    let now = crate::health::now_ms();
    let slot = match r.clients.iter().position(|c| c.key.load(Relaxed) == key) {
        Some(i) => i,
        None => {
            // claim the least recently used row (an empty row has last_ms 0)
            let i = r.clients.iter().enumerate().min_by_key(|(_, c)| c.last_ms.load(Relaxed)).map_or(0, |(i, _)| i);
            let c = &r.clients[i];
            c.key.store(key, Relaxed);
            for a in [&c.calls, &c.timeouts, &c.fail_open] {
                a.store(0, Relaxed);
            }
            c.cold_starts.fetch_add(1, Relaxed);
            c.hist.0.iter().for_each(|h| h.store(0, Relaxed));
            let max = defaults::num("io.client_name_max") as usize;
            if let Ok(mut n) = r.names.lock() {
                n[i] = client.unwrap_or(defaults::text("io.unknown_client")).chars().take(max).collect();
            }
            i
        }
    };
    let c = &r.clients[slot];
    c.calls.fetch_add(1, Relaxed);
    match how {
        Served::Ok => {}
        Served::Timeout => {
            c.timeouts.fetch_add(1, Relaxed);
        }
        Served::FailOpen => {
            c.fail_open.fetch_add(1, Relaxed);
        }
    }
    c.last_ms.store(now, Relaxed);
    c.hist.add(proc_us);
}

/// Time `io.bench_ops` counter updates on a scratch row and switch the registry off when the cost per op passes the hard limit.
fn bench() -> Value {
    let (soft, hard) = (defaults::num("io.op_ns_soft"), defaults::num("io.op_ns_hard"));
    let (n, row) = (defaults::num("io.bench_ops").max(1), StoreRow::default());
    let t = Instant::now();
    for i in 0..n {
        row.reads.fetch_add(1, Relaxed);
        row.bytes_in.fetch_add(std::hint::black_box(i), Relaxed);
        row.last_ms.store(i, Relaxed);
    }
    let ns = t.elapsed().as_nanos() as u64 / n;
    let over_hard = ns > hard;
    if over_hard {
        ON.store(false, Relaxed);
        crate::health::log_event("io", "disabled", &defaults::render("io.msg_op_hard", &[("ns", &ns), ("hard", &hard)]));
    }
    json!({"ops": n, "ns_per_op": ns, "soft": soft, "hard": hard, "over_soft": ns > soft, "disabled": over_hard})
}

/// `CTL io [store=<id>] [client=<name>] [bench=1]`.
pub fn snapshot(args: &str) -> Value {
    let want = |k: &str| args.split_whitespace().find_map(|a| a.strip_prefix(k).map(str::to_string));
    let bench = want("bench=").is_some_and(|b| b != "0").then(bench);
    let Some(r) = reg() else { return json!({"enabled": false, "bench": bench}) };
    let stores: Vec<Value> = r.stores.iter().enumerate().filter(|(i, _)| want("store=").is_none_or(|w| r.ids[*i] == w)).map(|(i, s)| {
        let h = s.hist.counts();
        json!({"id": r.ids[i], "reads": s.reads.load(Relaxed), "writes": s.writes.load(Relaxed), "bytes_in": s.bytes_in.load(Relaxed), "bytes_out": s.bytes_out.load(Relaxed),
            "errors": s.errors.load(Relaxed), "last_ms": s.last_ms.load(Relaxed), "p50_us": quantile_us(&h, 50), "p95_us": quantile_us(&h, 95)})
    }).collect();
    let names = r.names.lock().map(|n| n.clone()).unwrap_or_default();
    let clients: Vec<Value> = r.clients.iter().enumerate().filter(|(i, c)| c.key.load(Relaxed) != 0 && want("client=").is_none_or(|w| names[*i] == w)).map(|(i, c)| {
        let h = c.hist.counts();
        json!({"id": names[i], "calls": c.calls.load(Relaxed), "timeouts": c.timeouts.load(Relaxed), "fail_open": c.fail_open.load(Relaxed),
            "cold_starts": c.cold_starts.load(Relaxed), "last_ms": c.last_ms.load(Relaxed), "p50_us": quantile_us(&h, 50), "p95_us": quantile_us(&h, 95), "hist": h})
    }).collect();
    json!({"enabled": true, "at_ms": crate::health::now_ms(), "mem_bytes": r.mem_bytes, "budget": {"mem_soft_kb": defaults::num("io.mem_soft_kb"), "mem_hard_kb": defaults::num("io.mem_hard_kb"),
        "op_ns_soft": defaults::num("io.op_ns_soft"), "op_ns_hard": defaults::num("io.op_ns_hard")}, "bench": bench, "stores": stores, "clients": clients})
}
