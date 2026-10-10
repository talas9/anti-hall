//! Profiling-only stage timing for the daemon (issues #21, #22): where does a served request spend its time?
//!
//! Off unless `profile.stage_log` names a file. While off, [`span`] costs one relaxed atomic load. While on, each worker thread
//! accumulates, per request, the microseconds spent in every [`Stage`] (inclusive: `Entries` contains `Js`, which contains
//! `Proc`, which contains `Spawn`, `Wait` and `Collect`; `Git` is the part of `Proc` that ran git), and `serve_conn` appends one
//! JSON line per request to the log. Nothing here changes a decision, a reply or an exit code.
use crate::defaults;
use std::cell::RefCell;
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// One timed part of serving a request.
#[derive(Clone, Copy)]
pub enum Stage {
    /// Reading the request off the socket.
    Read,
    /// Decoding the request header, meta and payload.
    Parse,
    /// The dispatch preamble: config offer, project key, rate limits.
    Pre,
    /// Choosing the entries for the event (`table::select`).
    Select,
    /// Running all selected entries (checks), inclusive.
    Entries,
    /// Telemetry bookkeeping after each check.
    Observe,
    /// Running a check script in QuickJS (inclusive of the host calls it makes).
    Js,
    /// A child process run by the engine (`proc::run` or a script host call), inclusive.
    Proc,
    /// Part of `Proc` that ran git.
    Git,
    /// Starting the child (fork/exec).
    Spawn,
    /// Waiting for the child to exit.
    Wait,
    /// Collecting the child's output after it exited.
    Collect,
    /// Encoding the reply body and framing it.
    Encode,
    /// Writing the reply to the socket.
    Write,
}

const N: usize = 14;
const NAMES: [&str; N] = ["read", "parse", "pre", "select", "entries", "observe", "js", "proc", "git", "spawn", "wait", "collect", "encode", "write"];

static ON: AtomicBool = AtomicBool::new(false);
static LOG: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();

#[derive(Default)]
struct Cur {
    us: [u64; N],
    checks: Vec<(String, u64)>,
    procs: u64,
    tool: String,
    cpu0: u64,
}

thread_local! {
    static CUR: RefCell<Cur> = RefCell::new(Cur::default());
}

/// Read the switch from the configuration (once per request) and open the log on the first use of a path.
pub fn refresh() {
    let path = defaults::text("profile.stage_log");
    if path.is_empty() {
        ON.store(false, Relaxed);
        return;
    }
    let slot = LOG.get_or_init(|| Mutex::new(None));
    if let Ok(mut g) = slot.lock()
        && g.is_none()
    {
        let p = std::path::Path::new(path);
        let p = if p.is_absolute() { p.to_path_buf() } else { crate::paths::dir().join(p) };
        *g = std::fs::OpenOptions::new().create(true).append(true).open(p).ok();
    }
    ON.store(true, Relaxed);
}

/// Whether stage timing is on.
pub fn on() -> bool {
    ON.load(Relaxed)
}

/// A running timer for one stage; the elapsed time is added to the thread's request on drop.
pub struct Span(Option<(Stage, Instant)>);

/// Start timing `stage` (a no-op while profiling is off).
pub fn span(stage: Stage) -> Span {
    Span(on().then(|| (stage, Instant::now())))
}

impl Drop for Span {
    fn drop(&mut self) {
        if let Some((s, t)) = self.0.take() {
            let us = t.elapsed().as_micros() as u64;
            CUR.with(|c| c.borrow_mut().us[s as usize] += us);
        }
    }
}

/// Add `us` to `stage` directly (for a time measured elsewhere).
pub fn add(stage: Stage, us: u64) {
    if on() {
        CUR.with(|c| c.borrow_mut().us[stage as usize] += us);
    }
}

/// A child process started: count it for the request.
pub fn proc_started() {
    if on() {
        CUR.with(|c| c.borrow_mut().procs += 1);
    }
}

/// One check finished in `us` microseconds.
pub fn check(name: &str, us: u64) {
    if on() {
        CUR.with(|c| c.borrow_mut().checks.push((name.to_string(), us)));
    }
}

/// The tool name of the request being served.
pub fn note_tool(tool: &str) {
    if on() {
        CUR.with(|c| c.borrow_mut().tool = tool.to_string());
    }
}

/// Forget the thread's stages (start of a request).
pub fn begin() {
    if on() {
        CUR.with(|c| *c.borrow_mut() = Cur { cpu0: crate::limits::thread_cpu_us(), ..Cur::default() });
    }
}

/// Append the request's line to the log: its event, the queue wait, the total processing time and every stage.
pub fn finish(event: &str, wait_us: u64, total_us: u64, late: bool) {
    if !on() {
        return;
    }
    let line = CUR.with(|c| {
        let c = std::mem::take(&mut *c.borrow_mut());
        let mut o = serde_json::Map::new();
        o.insert("t_ms".into(), crate::health::now_ms().into());
        o.insert("ev".into(), event.into());
        o.insert("tool".into(), c.tool.clone().into());
        o.insert("queue".into(), wait_us.into());
        o.insert("total".into(), total_us.into());
        o.insert("late".into(), late.into());
        o.insert("procs".into(), c.procs.into());
        // CPU time this thread used since the request began; total minus cpu is time off the CPU (blocked, or not scheduled)
        o.insert("cpu".into(), crate::limits::thread_cpu_us().saturating_sub(c.cpu0).into());
        for (i, n) in NAMES.iter().enumerate() {
            o.insert((*n).into(), c.us[i].into());
        }
        let checks: serde_json::Map<String, serde_json::Value> = c.checks.into_iter().map(|(k, v)| (k, v.into())).collect();
        o.insert("checks".into(), checks.into());
        serde_json::Value::Object(o).to_string() + "\n"
    });
    if let Some(m) = LOG.get()
        && let Ok(mut g) = m.lock()
        && let Some(f) = g.as_mut()
    {
        crate::discard::harmless(f.write_all(line.as_bytes())); // keep: a profile line lost to a full disk must not touch the reply
    }
}

/// QuickJS memory per worker thread, published by `script` every `profile.js_stats_every` calls.
pub mod js {
    use std::collections::BTreeMap;
    use std::sync::Mutex;
    /// (malloc_size, malloc_count, memory_used_size, obj_count, str_count, js_func_count, checks loaded) by thread name.
    static BY_THREAD: Mutex<BTreeMap<String, [i64; 7]>> = Mutex::new(BTreeMap::new());
    /// Publish this thread's reading.
    pub fn publish(v: [i64; 7]) {
        let name = std::thread::current().name().map_or_else(|| format!("{:?}", std::thread::current().id()), str::to_string);
        if let Ok(mut m) = BY_THREAD.lock() {
            m.insert(name, v);
        }
    }
    /// The readings as JSON: per thread and the sum.
    pub fn report() -> serde_json::Value {
        let m = BY_THREAD.lock().map(|g| g.clone()).unwrap_or_default();
        let keys = ["malloc_size", "malloc_count", "memory_used_size", "obj_count", "str_count", "js_func_count", "checks_loaded"];
        let mut sum = [0i64; 7];
        let mut threads = serde_json::Map::new();
        for (t, v) in &m {
            let mut o = serde_json::Map::new();
            for (i, k) in keys.iter().enumerate() {
                o.insert((*k).into(), v[i].into());
                sum[i] += v[i];
            }
            threads.insert(t.clone(), o.into());
        }
        let mut s = serde_json::Map::new();
        for (i, k) in keys.iter().enumerate() {
            s.insert((*k).into(), sum[i].into());
        }
        serde_json::json!({"threads": m.len(), "sum": s, "by_thread": threads})
    }
}
