//! Memory diagnostics for the daemon (issue #21): where the resident set goes.
//!
//! * A per-request log (`files.mem_log`, NDJSON): for each served request the resident set and the allocator's allocated and
//!   resident bytes before and after, the checks that ran and the size of the transcript file. The allocator figures are the
//!   process's, so the deltas of requests that overlap in time overlap too (`busy` says how many workers were serving).
//! * A cap-trip snapshot (`files.mem_snapshot`): allocator statistics, thread count, every worker's interpreter and caches and the
//!   platform's own memory map, written once before the daemon drains.
//! * `summary` / `latest_snapshot`: what `ah-engine status --memory` prints from those two files.
//!
//! Nothing here changes a decision; every function is best-effort and a failed write is dropped.
use crate::defaults;
use serde_json::{Value, json};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// Allocator figures in bytes; `None` where the build has no jemalloc statistics.
#[derive(Debug, Clone, Copy, Default)]
pub struct Alloc {
    /// Bytes the program has allocated (`stats.allocated`).
    pub allocated: u64,
    /// Bytes in pages the allocator holds resident (`stats.resident`).
    pub resident: u64,
}

#[cfg(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu")))]
mod je {
    use tikv_jemalloc_sys::mallctl;

    fn read(name: &str) -> Option<u64> {
        let key = std::ffi::CString::new(name).ok()?;
        let mut v: usize = 0;
        let mut len = std::mem::size_of::<usize>();
        // SAFETY: `key` is NUL-terminated, `v` is a writable `usize` of `len` bytes, and no value is written (null, 0).
        let rc = unsafe { mallctl(key.as_ptr(), (&mut v as *mut usize).cast(), &mut len, std::ptr::null_mut(), 0) };
        (rc == 0).then_some(v as u64)
    }

    /// Statistics are cached until the epoch is advanced.
    fn advance() {
        let key = c"epoch";
        let mut new: u64 = 1;
        let mut old: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        // SAFETY: `key` is NUL-terminated; `old` and `new` are `u64` as jemalloc's `epoch` expects, `len` is the size of `old`.
        unsafe { mallctl(key.as_ptr(), (&mut old as *mut u64).cast(), &mut len, (&mut new as *mut u64).cast(), std::mem::size_of::<u64>()) };
    }

    pub fn alloc() -> Option<super::Alloc> {
        advance();
        Some(super::Alloc { allocated: read("stats.allocated")?, resident: read("stats.resident")? })
    }

    pub fn detail() -> serde_json::Value {
        advance();
        let mut m = serde_json::Map::new();
        for k in ["allocated", "active", "metadata", "resident", "mapped", "retained"] {
            m.insert(k.into(), read(&format!("stats.{k}")).map_or(serde_json::Value::Null, Into::into));
        }
        serde_json::Value::Object(m)
    }
}

#[cfg(not(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", target_env = "gnu"))))]
mod je {
    pub fn alloc() -> Option<super::Alloc> {
        None
    }
    pub fn detail() -> serde_json::Value {
        serde_json::Value::Null
    }
}

/// The C library's allocator totals (what jemalloc's figures leave out: bundled SQLite and anything else that calls `malloc`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Sys {
    /// Bytes handed out and not freed, across all zones.
    pub in_use: u64,
    /// Bytes the allocator holds from the OS.
    pub allocated: u64,
}

#[cfg(target_os = "macos")]
mod sysm {
    use std::ffi::{c_char, c_int, c_void};

    #[repr(C)]
    #[derive(Default)]
    pub struct Stats {
        blocks_in_use: u32,
        size_in_use: usize,
        max_size_in_use: usize,
        size_allocated: usize,
    }

    unsafe extern "C" {
        fn malloc_zone_statistics(zone: *mut c_void, stats: *mut Stats);
        fn malloc_get_all_zones(task: u32, reader: *mut c_void, addresses: *mut *mut usize, count: *mut u32) -> c_int;
        fn malloc_get_zone_name(zone: *mut c_void) -> *const c_char;
    }

    pub fn total() -> Option<super::Sys> {
        let mut st = Stats::default();
        // SAFETY: a null zone means all zones; `st` is a live, writable struct with the C layout.
        unsafe { malloc_zone_statistics(std::ptr::null_mut(), &mut st) };
        Some(super::Sys { in_use: st.size_in_use as u64, allocated: st.size_allocated as u64 })
    }

    /// Per zone: name, bytes in use, bytes allocated, blocks.
    pub fn zones() -> serde_json::Value {
        let (mut addrs, mut n): (*mut usize, u32) = (std::ptr::null_mut(), 0);
        // SAFETY: task 0 is this task and no reader is needed in-process; `addrs` and `n` are live out-parameters.
        if unsafe { malloc_get_all_zones(0, std::ptr::null_mut(), &mut addrs, &mut n) } != 0 || addrs.is_null() {
            return serde_json::Value::Null;
        }
        let mut out = Vec::new();
        for i in 0..n as usize {
            // SAFETY: `addrs` points at `n` zone addresses (the list the call returned).
            let z = unsafe { *addrs.add(i) } as *mut c_void;
            let mut st = Stats::default();
            // SAFETY: `z` is a registered zone from the list; `st` is a live, writable struct.
            unsafe { malloc_zone_statistics(z, &mut st) };
            // SAFETY: the name is a NUL-terminated string owned by the zone, or null.
            let name = unsafe {
                let p = malloc_get_zone_name(z);
                if p.is_null() { String::new() } else { std::ffi::CStr::from_ptr(p).to_string_lossy().into_owned() }
            };
            out.push(serde_json::json!({"name": name, "in_use": st.size_in_use, "allocated": st.size_allocated, "blocks": st.blocks_in_use}));
        }
        serde_json::Value::Array(out)
    }
}

#[cfg(all(target_os = "linux", target_env = "gnu"))]
mod sysm {
    pub fn total() -> Option<super::Sys> {
        // SAFETY: `mallinfo2` takes no arguments and returns a plain struct by value.
        let m = unsafe { libc::mallinfo2() };
        Some(super::Sys { in_use: (m.uordblks + m.hblkhd) as u64, allocated: (m.arena + m.hblkhd) as u64 })
    }
    pub fn zones() -> serde_json::Value {
        serde_json::Value::Null
    }
}

#[cfg(not(any(target_os = "macos", all(target_os = "linux", target_env = "gnu"))))]
mod sysm {
    pub fn total() -> Option<super::Sys> {
        None
    }
    pub fn zones() -> serde_json::Value {
        serde_json::Value::Null
    }
}

/// SQLite's own count of the bytes it holds (current, high-water), across every connection of the process; 0 when the build keeps
/// no statistics.
fn sqlite_bytes() -> (i64, i64) {
    // SAFETY: both calls take plain values and read process-wide counters; they are thread-safe.
    unsafe { (rusqlite::ffi::sqlite3_memory_used(), rusqlite::ffi::sqlite3_memory_highwater(0)) }
}

/// `sqlite3_status64` current value of one counter (`SQLITE_STATUS_*`), -1 when the call fails.
fn sqlite_status(op: i32) -> i64 {
    let (mut cur, mut hi) = (0i64, 0i64);
    // SAFETY: `cur` and `hi` are live, writable i64 out-parameters; the counter is process-wide and thread-safe.
    let rc = unsafe { rusqlite::ffi::sqlite3_status64(op, &mut cur, &mut hi, 0) };
    if rc == 0 { cur } else { -1 }
}

// ---- per-request log -----------------------------------------------------------------------------------------------

/// What was measured when a request started.
pub struct Before(Probe);

/// Everything a measurement reads: resident set and footprint, jemalloc, the counted heap, the C allocator and SQLite.
pub struct Probe {
    rss_kb: u64,
    footprint_kb: Option<u64>,
    alloc: Option<Alloc>,
    heap_live: u64,
    sys: Option<Sys>,
    sqlite: i64,
}

fn probe() -> Probe {
    Probe {
        rss_kb: crate::limits::rss_kb(),
        footprint_kb: crate::limits::footprint_kb(),
        alloc: je::alloc(),
        heap_live: crate::memstat::heap().live,
        sys: sysm::total(),
        sqlite: sqlite_bytes().0,
    }
}

#[derive(Default)]
struct Note {
    checks: Vec<String>,
    transcript: Option<String>,
}

thread_local! {
    static ON: Cell<bool> = const { Cell::new(false) };
    static NOTE: RefCell<Note> = RefCell::new(Note::default());
}

/// Start measuring a request on this thread; `None` (and nothing noted afterwards) when the log is off.
pub fn begin(on: bool) -> Option<Before> {
    ON.with(|c| c.set(on));
    NOTE.with(|n| *n.borrow_mut() = Note::default());
    on.then(|| Before(probe()))
}

/// A check ran in the request in progress on this thread.
pub fn note_check(id: &str) {
    if ON.with(Cell::get) {
        NOTE.with(|n| {
            let mut n = n.borrow_mut();
            if !n.checks.iter().any(|c| c == id) {
                n.checks.push(id.to_string());
            }
        });
    }
}

/// The request in progress carries this payload; its `transcript_path` is measured when the line is written.
pub fn note_payload(p: &Value) {
    if ON.with(Cell::get)
        && let Some(t) = p.get("transcript_path").and_then(Value::as_str)
    {
        NOTE.with(|n| n.borrow_mut().transcript = Some(t.to_string()));
    }
}

/// What a finished request looked like, for [`finish`].
pub struct Done {
    /// Request kind: the first word of the request head (`V`, `D`, `G`, `P`, `CTL`).
    pub kind: String,
    /// Hook event, empty for a control request.
    pub event: String,
    /// Requests queued or being served when it was accepted.
    pub in_flight: u64,
    /// Workers serving at the time of the line.
    pub busy: u64,
    /// Processing time.
    pub proc_ms: u64,
    /// The after-measurement (see [`measure_after`]).
    pub after: After,
}

/// The measurement taken as the request's work ended.
pub struct After(Probe);

/// Measure right after the request's work, before the reply is written.
pub fn measure_after() -> After {
    After(probe())
}

static LOG_LOCK: Mutex<()> = Mutex::new(());

/// Append the request's line to the log, rotating it past `diagnostics.mem_log_max_bytes`.
pub fn finish(before: Before, d: &Done) {
    let (checks, transcript) = NOTE.with(|n| {
        let n = n.borrow();
        (n.checks.clone(), n.transcript.clone())
    });
    let tsize = transcript.as_deref().and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len());
    let (b, a) = (&before.0, &d.after.0);
    let al = |x: &Option<Alloc>, f: fn(&Alloc) -> u64| x.as_ref().map_or(Value::Null, |a| json!(f(a)));
    let sy = |x: &Option<Sys>, f: fn(&Sys) -> u64| x.as_ref().map_or(Value::Null, |a| json!(f(a)));
    let line = json!({
        "ts": crate::health::now_ms(), "kind": d.kind, "event": d.event, "checks": checks,
        "rss_kb_before": b.rss_kb, "rss_kb_after": a.rss_kb,
        "footprint_kb_before": b.footprint_kb, "footprint_kb_after": a.footprint_kb,
        "alloc_before": al(&b.alloc, |x| x.allocated), "alloc_after": al(&a.alloc, |x| x.allocated),
        "resident_before": al(&b.alloc, |x| x.resident), "resident_after": al(&a.alloc, |x| x.resident),
        "heap_live_before": b.heap_live, "heap_live_after": a.heap_live,
        "sys_in_use_before": sy(&b.sys, |x| x.in_use), "sys_in_use_after": sy(&a.sys, |x| x.in_use),
        "sys_allocated_before": sy(&b.sys, |x| x.allocated), "sys_allocated_after": sy(&a.sys, |x| x.allocated),
        "sqlite_before": b.sqlite, "sqlite_after": a.sqlite,
        "transcript_bytes": tsize, "in_flight": d.in_flight, "busy": d.busy, "proc_ms": d.proc_ms,
    });
    let path = crate::paths::dir().join(defaults::text("files.mem_log"));
    let _g = LOG_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if std::fs::metadata(&path).is_ok_and(|m| m.len() >= defaults::num("diagnostics.mem_log_max_bytes")) {
        crate::discard::harmless(std::fs::rename(&path, rotated(&path))); // keep: a log that cannot rotate keeps growing, which must not fail a request
    }
    let mut text = line.to_string();
    text.push('\n');
    crate::discard::harmless(std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(text.as_bytes()))); // keep: a diagnostic line that cannot be written is dropped
}

fn rotated(path: &std::path::Path) -> std::path::PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".1");
    s.into()
}

// ---- cap-trip snapshot ---------------------------------------------------------------------------------------------

static WANT: AtomicU64 = AtomicU64::new(0);
static CLAIMED: AtomicBool = AtomicBool::new(false);
static REPORTS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
static ARRIVED: Condvar = Condvar::new();

thread_local! {
    static REPORTED: Cell<u64> = const { Cell::new(0) };
}

/// Claim the one snapshot of this process; false when a cap trip already did.
pub fn claim_snapshot() -> bool {
    !CLAIMED.swap(true, SeqCst)
}

/// Whether a snapshot has been claimed (its thread then also starts the drain).
pub fn snapshot_claimed() -> bool {
    CLAIMED.load(SeqCst)
}

/// A worker's chance to report (between requests and while idle): when a snapshot is wanted and this thread has not yet reported,
/// add its interpreter and cache figures.
pub fn worker_tick(idx: usize) {
    let g = WANT.load(SeqCst);
    if g == 0 || REPORTED.with(Cell::get) == g {
        return;
    }
    REPORTED.with(|r| r.set(g));
    let mut d = crate::script::thread_diag();
    d["worker"] = json!(idx);
    REPORTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).push(d);
    ARRIVED.notify_all();
}

/// The memory ledger in MB: the footprint against what each owner holds. QuickJS allocates through the Rust allocator, so it is
/// part of the jemalloc figure, listed apart to show its share; `unaccounted` is what the owners above do not explain (thread
/// stacks, code and library data, other anonymous memory: the memory map text in the snapshot breaks it down).
fn ledger(snap: &Value) -> Value {
    let mb = |v: &Value| v.as_f64().map_or(0.0, |b| (b / 1048.576).round() / 1000.0);
    let footprint = snap["footprint_kb"].as_f64().unwrap_or(0.0) * 1024.0;
    let jemalloc = snap["allocator"]["resident"].as_f64().unwrap_or(0.0);
    let quickjs: f64 = snap["pools"].as_array().into_iter().flatten().filter_map(|p| p["quickjs_bytes"].as_f64()).sum();
    let sqlite = snap["sqlite"]["memory_used"].as_f64().unwrap_or(0.0);
    let zones = snap["system_malloc"]["zones"].as_array();
    let other_sys: f64 = match zones {
        Some(z) => z.iter().filter(|x| !x["name"].as_str().unwrap_or("").to_lowercase().contains("jemalloc")).filter_map(|x| x["allocated"].as_f64()).sum(),
        None => snap["system_malloc"]["total"]["allocated"].as_f64().unwrap_or(0.0),
    };
    json!({
        "footprint": mb(&json!(footprint)), "jemalloc_resident": mb(&json!(jemalloc)), "of_which_quickjs": mb(&json!(quickjs)),
        "system_malloc_other_zones": mb(&json!(other_sys)), "of_which_sqlite_in_use": mb(&json!(sqlite)),
        "unaccounted": mb(&json!(footprint - jemalloc - other_sys)),
    })
}

fn map_text() -> String {
    if let Ok(t) = std::fs::read_to_string("/proc/self/smaps_rollup") {
        return t;
    }
    let probe = defaults::list("diagnostics.mem_snapshot_probe");
    let Some((program, args)) = probe.split_first() else { return String::new() };
    let mut cmd = std::process::Command::new(program);
    cmd.args(args.iter().map(|a| a.replace("{pid}", &std::process::id().to_string())));
    crate::proc::run(cmd, program, defaults::millis("diagnostics.mem_snapshot_probe_ms"), defaults::millis("health.probe_poll_ms"))
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        .unwrap_or_default()
}

/// Collect and write the snapshot: asks every worker for its figures (waiting up to `diagnostics.mem_snapshot_wait_ms`),
/// adds the process-wide ones (`memory` is the daemon's component report) and writes the file, cut to `diagnostics.mem_snapshot_max_bytes`.
pub fn capture(memory: Value, workers: usize, rss_cap_kb: u64, uptime_s: u64) {
    REPORTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    WANT.store(crate::health::now_ms().max(1), SeqCst);
    let wait = defaults::millis("diagnostics.mem_snapshot_wait_ms");
    let mut got = REPORTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let deadline = std::time::Instant::now() + wait;
    while got.len() < workers {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left == Duration::ZERO {
            break;
        }
        got = ARRIVED.wait_timeout(got, left).unwrap_or_else(std::sync::PoisonError::into_inner).0;
    }
    let mut pools = got.clone();
    drop(got);
    pools.sort_by_key(|p| p["worker"].as_u64().unwrap_or(u64::MAX));
    let reported: Vec<u64> = pools.iter().filter_map(|p| p["worker"].as_u64()).collect();
    let missing: Vec<usize> = (0..workers).filter(|i| !reported.contains(&(*i as u64))).collect();
    let heap = crate::memstat::heap();
    let (tc_entries, tc_bytes) = crate::script::host_transcript::cache_usage();
    let (walks, walk_est, walk_read) = crate::checks::agent_scan::kept_usage();
    let mut snap = json!({
        "ts": crate::health::now_ms(), "pid": std::process::id(), "uptime_s": uptime_s,
        "rss_kb": crate::limits::rss_kb(), "rss_cap_kb": rss_cap_kb, "threads": crate::limits::thread_count(),
        "counted_heap": {"live_kb": heap.live / 1024, "peak_kb": heap.peak / 1024, "allocs": heap.allocs},
        "allocator": je::detail(),
        "footprint_kb": crate::limits::footprint_kb(),
        "system_malloc": {"total": sysm::total().map(|t| json!({"in_use": t.in_use, "allocated": t.allocated})), "zones": sysm::zones()},
        "sqlite": {"memory_used": sqlite_bytes().0, "memory_highwater": sqlite_bytes().1, "pagecache_used": sqlite_status(1)},
        "runtimes": pools.iter().filter_map(|p| p["runtimes"].as_u64()).sum::<u64>(),
        "contexts": pools.iter().filter_map(|p| p["contexts"].as_u64()).sum::<u64>(),
        "pools": pools, "workers_missing": missing,
        "caches": {
            "transcript_tail": {"entries": tc_entries, "bytes": tc_bytes},
            "agent_scan_walks": {"transcripts": walks, "estimated_bytes": walk_est, "transcript_bytes_read": walk_read},
        },
        "memory": memory,
    });
    snap["ledger_mb"] = ledger(&snap);
    let cap = defaults::num("diagnostics.mem_snapshot_max_bytes") as usize;
    let mut map = map_text();
    // the file holds the whole object: cut the map until the serialized object fits (escapes make it longer than the raw text)
    snap["memory_map"] = json!(map);
    while snap.to_string().len() > cap && !map.is_empty() {
        let over = snap.to_string().len() - cap;
        let mut cut = map.len().saturating_sub(over);
        while cut > 0 && !map.is_char_boundary(cut) {
            cut -= 1;
        }
        map.truncate(cut);
        snap["memory_map"] = json!(map);
    }
    crate::discard::logged("mem_snapshot_write", crate::atomic::write(crate::paths::dir().join(defaults::text("files.mem_snapshot")), snap.to_string()));
}

// ---- the read side (`status --memory`) -----------------------------------------------------------------------------

/// The latest snapshot file, or `null`.
pub fn latest_snapshot() -> Value {
    std::fs::read_to_string(crate::paths::dir().join(defaults::text("files.mem_snapshot")))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

fn tail_of(path: &std::path::Path, max: u64) -> String {
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let len = f.metadata().map_or(0, |m| m.len());
    let start = len.saturating_sub(max);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut b = Vec::new();
    crate::discard::harmless(f.take(max).read_to_end(&mut b)); // keep: a short read leaves a shorter summary
    let t = String::from_utf8_lossy(&b).to_string();
    if start > 0 { t.split_once('\n').map(|x| x.1.to_string()).unwrap_or_default() } else { t }
}

#[derive(Default)]
struct Acc {
    n: u64,
    grew: u64,
    rss: i64,
    rss_max: i64,
    alloc: i64,
    resident: i64,
}

impl Acc {
    fn add(&mut self, rss: i64, alloc: Option<i64>, res: Option<i64>) {
        self.n += 1;
        self.grew += u64::from(rss > 0);
        self.rss += rss;
        self.rss_max = self.rss_max.max(rss);
        self.alloc += alloc.unwrap_or(0);
        self.resident += res.unwrap_or(0);
    }

    fn row(&self, name: &str) -> Value {
        json!({"name": name, "requests": self.n, "requests_grew": self.grew, "rss_delta_kb_total": self.rss,
            "rss_delta_kb_max": self.rss_max, "alloc_delta_bytes_total": self.alloc, "resident_delta_bytes_total": self.resident})
    }
}

fn top(m: BTreeMap<String, Acc>, n: usize) -> Vec<Value> {
    let mut v: Vec<(&String, &Acc)> = m.iter().collect();
    v.sort_by(|a, b| b.1.rss.cmp(&a.1.rss).then(a.0.cmp(b.0)));
    v.into_iter().take(n).map(|(k, a)| a.row(k)).collect()
}

/// Summarise the memory log: requests in total, the first and last resident set, and the top events and checks by total resident-set
/// growth. A check's row counts every request it took part in (a request runs several checks, so rows overlap; the request's whole
/// delta is credited to each).
pub fn summary() -> Value {
    let path = crate::paths::dir().join(defaults::text("files.mem_log"));
    let max = defaults::num("diagnostics.summary_read_bytes");
    let mut text = tail_of(&rotated(&path), max);
    text.push_str(&tail_of(&path, max));
    summary_of(&text)
}

fn summary_of(text: &str) -> Value {
    let mut lines: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    lines.sort_by_key(|l| l["ts"].as_u64().unwrap_or(0));
    let lines = lines.as_slice();
    if lines.is_empty() {
        return Value::Null;
    }
    let (mut events, mut checks, mut all) = (BTreeMap::<String, Acc>::new(), BTreeMap::<String, Acc>::new(), Acc::default());
    for l in lines {
        let g = |k: &str| l[k].as_i64();
        let rss = g("rss_kb_after").unwrap_or(0) - g("rss_kb_before").unwrap_or(0);
        let alloc = g("alloc_after").zip(g("alloc_before")).map(|(a, b)| a - b);
        let res = g("resident_after").zip(g("resident_before")).map(|(a, b)| a - b);
        let name = format!("{} {}", l["kind"].as_str().unwrap_or(""), l["event"].as_str().unwrap_or("")).trim().to_string();
        events.entry(name).or_default().add(rss, alloc, res);
        for c in l["checks"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            checks.entry(c.to_string()).or_default().add(rss, alloc, res);
        }
        all.add(rss, alloc, res);
    }
    let n = defaults::num("diagnostics.summary_top") as usize;
    json!({
        "requests": lines.len(), "first_ts": lines[0]["ts"], "last_ts": lines[lines.len() - 1]["ts"],
        "rss_kb_first": lines[0]["rss_kb_before"], "rss_kb_last": lines[lines.len() - 1]["rss_kb_after"],
        "rss_delta_kb_total": all.rss, "alloc_delta_bytes_total": all.alloc,
        "top_events": top(events, n), "top_checks": top(checks, n),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_ranks_events_and_checks_by_total_growth() {
        let line = |ts: u64, ev: &str, checks: &[&str], b: u64, a: u64| {
            json!({"ts": ts, "kind": "V", "event": ev, "checks": checks, "rss_kb_before": b, "rss_kb_after": a, "alloc_before": 10, "alloc_after": 12, "resident_before": 20, "resident_after": 30})
                .to_string()
        };
        let text = [line(1, "Stop", &["x", "y"], 100, 110), line(2, "Stop", &["x"], 110, 105), line(3, "Pre", &["y"], 105, 106)].join("\n");
        let s = summary_of(&text);
        assert_eq!(s["requests"], 3);
        assert_eq!(s["top_events"][0]["name"], "V Stop");
        assert_eq!(s["top_events"][0]["rss_delta_kb_total"], 5);
        assert_eq!(s["top_checks"][0]["name"], "y");
        assert_eq!(s["top_checks"][0]["rss_delta_kb_total"], 11);
        assert_eq!(s["rss_kb_first"], 100);
        assert_eq!(s["rss_kb_last"], 106);
        assert_eq!(summary_of(""), Value::Null);
    }

    #[test]
    fn a_request_line_and_a_snapshot_are_written_and_read_back() {
        std::fs::create_dir_all(crate::paths::dir()).unwrap();
        let b = begin(true).expect("on");
        note_check("memdiag-test-check");
        note_payload(&json!({"transcript_path": "/nonexistent/t.jsonl"}));
        let d = Done { kind: "V".into(), event: "memdiag-test-event".into(), in_flight: 1, busy: 1, proc_ms: 2, after: measure_after() };
        finish(b, &d);
        let log = std::fs::read_to_string(crate::paths::dir().join(defaults::text("files.mem_log"))).unwrap();
        let l: Value = log
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect::<Vec<_>>()
            .into_iter()
            .rfind(|l| l["event"] == "memdiag-test-event")
            .expect("line written");
        assert_eq!(l["checks"], json!(["memdiag-test-check"]));
        assert!(l["rss_kb_after"].as_u64().unwrap() > 0 && l["transcript_bytes"].is_null());
        assert!(begin(false).is_none(), "off: nothing measured");

        capture(json!({"k": 1}), 0, 123, 4);
        let s = latest_snapshot();
        assert_eq!(s["rss_cap_kb"], 123);
        assert_eq!(s["memory"]["k"], 1);
        assert!(s["ledger_mb"]["footprint"].as_f64().unwrap() > 0.0 && s["sqlite"]["memory_used"].is_number() && s["footprint_kb"].as_u64().unwrap() > 0);
        assert!(l["footprint_kb_after"].as_u64().unwrap() > 0 && l["sys_in_use_after"].as_u64().unwrap() > 0);
        assert!(s["threads"].as_u64().unwrap() > 0 && s["workers_missing"].as_array().unwrap().is_empty());
        assert!(s.to_string().len() <= defaults::num("diagnostics.mem_snapshot_max_bytes") as usize);
    }
}
