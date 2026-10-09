//! Scripted check logic (D88 spike): a check's DECISION logic lives in an editable plugin JavaScript file and runs in an
//! embedded QuickJS-NG interpreter (`rquickjs`); the engine keeps only the generic, read-only primitives the scripts call
//! ([`host`]).
//!
//! # Where scripts come from
//!
//! `<plugin root>/<script.logic_dir>/<check>.js`, overridden file by file by `<home>/<script.override_dir>/<check>.js`; the
//! shared helpers in the `<script.lib_dir>` sub-directory of both (override wins per file name) are evaluated first, in file
//! name order. Nothing is compiled in: every call stats the files it would load, and a changed fingerprint (path, size,
//! modification time) reloads them, so an edit, a plugin update (a new root) or an owner override takes effect on the next
//! call without a restart.
//!
//! # Runtime, limits and teardown
//!
//! One runtime per worker thread (the daemon's request threads are fixed, so the pool is bounded by `daemon.workers`), and ONE
//! context in it shared by every check: the shared helpers (lib files) are evaluated once, and each check's own files (its
//! includes and its script) are evaluated as the body of a function (`script.check_scope`), so the check's top-level
//! declarations stay private to it and its entry function is kept in a registry object (`script.registry_global`). A
//! context per check cost about 150 KB each (intrinsics, host bindings and the lib files again), times every scripted check
//! times every worker thread, all of it in the C allocator's zone outside the heap counters; see DECISIONS.md, revision
//! 1.111. The runtime allocates through the Rust allocator, so its heap is in `status --memory`'s live heap.
//!
//! A call runs under a CPU-time limit (`script.time_limit_ms`, with a wall-clock backstop of `script.wall_limit_factor` times it, both enforced by the interpreter's interrupt handler), a heap ceiling (`script.call_memory_bytes` above the size measured after loading) and a
//! stack ceiling. Any failure (exception, interrupt, out of memory, a verdict of the wrong shape) is a deferral, never a
//! silent allow (D11).
//!
//! Teardown rule (the "runtime teardown assertion" root cause): `JS_FreeRuntime` asserts that no object is still alive. A
//! `Persistent` handle, or a JS value kept outside `Context::with`, that outlives the runtime aborts the process. So no JS
//! value is ever stored outside a `with` block (the entry function is looked up by name per call in the registry object), a
//! pending exception is always taken with `catch`, and [`Pool`] drops its context before its runtime (field order) and runs
//! a GC in between.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file or directory is the same as an absent one
// A failure that must be seen goes through `crate::discard` instead.

pub mod host;
pub mod host_b3;
pub mod host_d;
pub mod host_proc;
pub mod host_ts;
mod host_io;
pub mod sysmem;

use crate::checks::git::util::Settings;
use crate::checks::{Exact, RouteMeta, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use rquickjs::{CatchResultExt, Context, Function, Runtime, Value as JsValue};
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, UNIX_EPOCH};

/// The files one check's context was built from, with what identifies their version.
type Fingerprint = Vec<(PathBuf, u64, u128)>;

/// The per-thread interpreter: the context is declared before the runtime so it is dropped first.
struct Pool {
    /// The shared context and the lib files it was built from; `None` until the first call (or after a lib file changed).
    ctx: Option<(Fingerprint, Context)>,
    /// Each loaded check's own files (includes, then its script), as they were when its entry was registered.
    checks: HashMap<String, Fingerprint>,
    /// Interrupt deadlines of the call in progress.
    deadline: Arc<Deadline>,
    epoch: Instant,
    rt: Runtime,
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.checks.clear();
        self.ctx = None;
        self.rt.run_gc();
    }
}

/// The interrupt limits of one call. `cpu`: the calling thread's CPU time (microseconds on its own clock) the script may reach,
/// so a descheduled thread on a loaded machine is not charged for the time it waited for a core. `wall`: a backstop in
/// nanoseconds since the pool epoch (`script.time_limit_ms` times `script.wall_limit_factor`; moved out by the time a host function
/// spent blocked) for a script that waits without using CPU. 0 = none.
#[derive(Default)]
pub struct Deadline {
    /// The thread CPU time (us) at which the call is interrupted.
    pub cpu: AtomicU64,
    /// The wall-clock backstop (ns since the pool epoch).
    pub wall: AtomicU64,
}

impl Pool {
    /// Start the limits of a call of `limit_ms` script time.
    fn arm(&self, limit_ms: u64) {
        let cpu_now = crate::limits::thread_cpu_us();
        self.deadline.cpu.store(cpu_now.saturating_add(limit_ms.saturating_mul(1000)).max(1), Ordering::Relaxed);
        let wall = limit_ms.saturating_mul(defaults::num("script.wall_limit_factor").max(1)).saturating_mul(1_000_000);
        self.deadline.wall.store((self.epoch.elapsed().as_nanos() as u64).saturating_add(wall).max(1), Ordering::Relaxed);
    }

    fn disarm(&self) {
        self.deadline.cpu.store(0, Ordering::Relaxed);
        self.deadline.wall.store(0, Ordering::Relaxed);
    }

    fn new() -> Option<Pool> {
        // the interpreter allocates through the Rust allocator (jemalloc where the build has it, which returns freed pages, and
        // counted by `memstat`), not the C library's malloc, whose zone kept freed pages resident (DECISIONS.md 1.111); the heap ceiling is
        // still enforced: QuickJS checks `set_memory_limit` against its own count before it calls any allocator
        let rt = Runtime::new_with_alloc(rquickjs::allocator::RustAllocator).ok()?;
        rt.set_max_stack_size(defaults::num("script.stack_bytes") as usize);
        let deadline = Arc::new(Deadline::default());
        let epoch = Instant::now();
        let d = deadline.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            let cpu = d.cpu.load(Ordering::Relaxed);
            let wall = d.wall.load(Ordering::Relaxed);
            (cpu != 0 && crate::limits::thread_cpu_us() > cpu) || (wall != 0 && epoch.elapsed().as_nanos() as u64 > wall)
        })));
        Some(Pool { ctx: None, checks: HashMap::new(), deadline, epoch, rt })
    }
}

thread_local! {
    static POOL: RefCell<Option<Pool>> = const { RefCell::new(None) };
}

/// The calling thread's interpreter after a collection: (checks loaded, bytes QuickJS holds, allocations outstanding,
/// bytecode functions and their bytes). `None` before its first scripted call. For the memory budget test and measurements
/// (`examples/script_mem.rs`); it walks the whole heap, so never on a request path.
pub fn pool_usage() -> Option<(usize, i64, i64, i64, i64)> {
    POOL.with(|cell| {
        cell.borrow().as_ref().map(|p| {
            p.rt.run_gc();
            let u = p.rt.memory_usage();
            (p.checks.len(), u.malloc_size, u.malloc_count, u.js_func_count, u.js_func_code_size)
        })
    })
}

fn mtime_ns(m: &std::fs::Metadata) -> u128 {
    m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())
}

fn file_id(p: &Path) -> Option<(PathBuf, u64, u128)> {
    let m = std::fs::metadata(p).ok().filter(std::fs::Metadata::is_file)?;
    Some((p.to_path_buf(), m.len(), mtime_ns(&m)))
}

/// The shipped and the override logic directories (override first).
fn dirs(home: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !home.is_empty() {
        out.push(Path::new(home).join(defaults::text("script.override_dir")));
    }
    if let Some(root) = defaults::root() {
        out.push(root.join(defaults::text("script.logic_dir")));
    }
    out
}

/// The files a check runs from: the lib files (by name), then its own files (its includes, then its script); `None` when no
/// script exists for `name`.
fn resolve(name: &str, home: &str) -> Option<(Fingerprint, Fingerprint)> {
    let ext = defaults::text("script.ext");
    let ds = dirs(home);
    let script = ds.iter().find_map(|d| file_id(&d.join(format!("{name}{ext}"))))?;
    let mut libs: std::collections::BTreeMap<String, (PathBuf, u64, u128)> = std::collections::BTreeMap::new();
    // the shipped directory last, so an override of the same file name wins
    for d in ds.iter().rev() {
        let Ok(rd) = std::fs::read_dir(d.join(defaults::text("script.lib_dir"))) else { continue };
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if fname.ends_with(ext)
                && let Some(id) = file_id(&e.path())
            {
                libs.insert(fname, id);
            }
        }
    }
    let libs: Fingerprint = libs.into_values().collect();
    let mut fp: Fingerprint = Vec::new();
    // scripts the owner's configuration says this check builds on (`script.includes`: check name to script names), loaded as
    // libraries after the shared helpers and before the check's own script, which may then redefine the entry
    let includes: Vec<String> = defaults::raw("script.includes").get(name).map(|v| v.strings().into_iter().map(str::to_string).collect()).unwrap_or_default();
    for inc in includes {
        fp.push(ds.iter().find_map(|d| file_id(&d.join(format!("{inc}{ext}"))))?);
    }
    fp.push(script);
    Some((libs, fp))
}

/// Build the shared context: the host bindings, then the lib files of `libs`. `Err` carries the reason.
fn load_libs(pool: &Pool, libs: &Fingerprint) -> Result<Context, String> {
    let ctx = Context::full(&pool.rt).map_err(|e| e.to_string())?;
    ctx.with(|c| -> Result<(), String> {
        host::install(&c).map_err(|e| e.to_string())?;
        for (path, _, _) in libs {
            let src = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
            c.eval::<(), _>(src).catch(&c).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        let reg = rquickjs::Object::new(c.clone()).map_err(|e| e.to_string())?;
        c.globals().set(defaults::text("script.registry_global"), reg).map_err(|e| e.to_string())
    })?;
    Ok(ctx)
}

/// Evaluate check `name`'s own files `own` in the shared context, inside `script.check_scope`, and register the entry it
/// defines. `Err` carries the reason (an unreadable file, an exception, no entry function).
fn load_check(ctx: &Context, name: &str, own: &Fingerprint, entry: &str) -> Result<(), String> {
    let mut src = String::new();
    for (path, _, _) in own {
        src.push_str(&std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?);
        src.push('\n');
    }
    let body = defaults::render("script.check_scope", &[("entry", &entry), ("source", &src)]);
    ctx.with(|c| -> Result<(), String> {
        let f: JsValue = c.eval(body).catch(&c).map_err(|e| format!("{name}: {e}"))?;
        if !f.is_function() {
            return Err(defaults::render("script.msg_no_entry", &[("check", &name), ("entry", &entry)]));
        }
        let reg: rquickjs::Object = c.globals().get(defaults::text("script.registry_global")).map_err(|e| e.to_string())?;
        reg.set(name, f).map_err(|e| e.to_string())
    })
}

/// Convert what a script returned into a verdict. `Err` for a value of the wrong shape.
fn verdict_of(v: &Value) -> Result<Option<Verdict>, String> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    Ok(match v {
        Value::Null => None,
        Value::String(t) if t == "allow" => Some(Verdict::Allow),
        Value::String(t) if t == "defer" => Some(Verdict::Defer),
        Value::Object(_) if s("block").is_some() => Some(Verdict::Block(s("block").unwrap_or_default())),
        Value::Object(_) if s("advisory").is_some() => Some(Verdict::Advisory(s("advisory").unwrap_or_default())),
        Value::Object(o) if o.get("exact").is_some_and(Value::is_object) => {
            let x = &o["exact"];
            let code = x.get("code").and_then(Value::as_i64).ok_or("exact.code")? as i32;
            let out = x.get("out").and_then(Value::as_str).unwrap_or_default().to_string();
            let err = x.get("err").and_then(Value::as_str).unwrap_or_default().to_string();
            Some(Verdict::Exact(Exact { code, out, err }))
        }
        Value::Object(o) if o.get("routed").is_some_and(Value::is_object) => {
            // a verdict plus the route telemetry a routing check records (`{routed: {verdict, meta: [...]}}`)
            let r = &o["routed"];
            let inner = verdict_of(r.get("verdict").unwrap_or(&Value::Null))?.ok_or_else(|| defaults::render("script.msg_bad_verdict", &[("value", r)]))?;
            let metas = r.get("meta").and_then(Value::as_array).ok_or_else(|| defaults::render("script.msg_bad_verdict", &[("value", r)]))?;
            let mut out = Vec::new();
            for m in metas {
                let t = |k: &str| m.get(k).and_then(Value::as_str).map(str::to_string);
                let b = |k: &str| m.get(k).and_then(Value::as_bool);
                let meta = (|| {
                    Some(RouteMeta {
                        requested_model: t("requested_model")?,
                        parent_model: t("parent_model")?,
                        task_class: t("task_class")?,
                        recommended_tier: t("recommended_tier")?,
                        selected_model: t("selected_model")?,
                        outcome: t("outcome")?,
                        spawn_key: t("spawn_key")?,
                        delegate: b("delegate")?,
                        blocked: b("blocked")?,
                    })
                })();
                out.push(meta.ok_or_else(|| defaults::render("script.msg_bad_verdict", &[("value", m)]))?);
            }
            Some(Verdict::Routed(Box::new(inner), out))
        }
        other => return Err(defaults::render("script.msg_bad_verdict", &[("value", other)])),
    })
}

/// What a check does when its script cannot give an answer (missing file, exception, interrupt, out of memory, a verdict of
/// the wrong shape). The rule (D88 condition b), all of it configuration:
///
/// - a check that has a Node twin (every check not listed in `script.engine_only_checks`) DEFERS: the Node hook decides, so a
///   broken script never changes a decision;
/// - an ENGINE-ONLY check has no Node hook to defer to (its fallback command is a no-op). On a guard event
///   (`dispatch.guard_events`) it BLOCKS with `script.msg_fail_closed`, because allowing silently would let through what the
///   check exists to stop; on any other event it ALLOWS quietly, because a broken script must never block ordinary work.
pub fn failed(name: &str, event: &str, why: &str) -> Verdict {
    crate::discard::note("script_error", &format!("{name}: {why}"));
    if !defaults::list("script.engine_only_checks").contains(&name) {
        return Verdict::Defer;
    }
    if defaults::list("dispatch.guard_events").contains(&event) {
        return Verdict::Block(defaults::render("script.msg_fail_closed", &[("check", &name), ("why", &why)]));
    }
    Verdict::Allow
}

/// Run the script of check `name` on one payload. `None`: no script for this check (or scripts are off), so the compiled
/// port decides. `Some(v)`: the script's answer, [`failed`] on any failure.
pub fn run(name: &str, payload: &Value, opts: &Value, event: &str, env: &RequestEnv) -> Option<Option<Verdict>> {
    if defaults::num("script.enabled") == 0 {
        return None;
    }
    let st = Settings::from_env(env);
    let (libs, own) = resolve(name, &st.home)?;
    Some(call(name, &libs, &own, payload, opts, event, st))
}

/// Run the script of `name` regardless of `script.enabled` (parity tests and measurements). `None` when no script exists.
pub fn run_forced(name: &str, payload: &Value, opts: &Value, event: &str, env: &RequestEnv) -> Option<Option<Verdict>> {
    let st = Settings::from_env(env);
    let (libs, own) = resolve(name, &st.home)?;
    Some(call(name, &libs, &own, payload, opts, event, st))
}

/// The answer for a check whose logic is a script (no compiled port) when no script file is found.
pub fn missing(name: &str, event: &str) -> Option<Verdict> {
    Some(failed(name, event, defaults::text("script.msg_no_script")))
}

/// The wall-clock limit of one call: the check's own entry in `script.time_limit_by_check` (`<check>:<event>` first, then
/// `<check>`), else `script.time_limit_ms`.
fn limit_ms(name: &str, event: &str) -> u64 {
    let by = defaults::raw("script.time_limit_by_check");
    [format!("{name}:{event}"), name.to_string()]
        .iter()
        .find_map(|k| by.get(k).and_then(defaults::V::as_integer))
        .map_or_else(|| defaults::num("script.time_limit_ms"), |ms| ms.max(1) as u64)
}

/// The shared context with the entry `entry` of `own` registered under `key`, built (and the memory ceiling set) when the lib
/// files or the entry's files changed since.
fn ensure_entry(pool: &mut Pool, key: &str, libs: &Fingerprint, own: &Fingerprint, entry: &str) -> Result<Context, String> {
        let libs_stale = pool.ctx.as_ref().is_none_or(|(fp, _)| fp != libs);
        if libs_stale || pool.checks.get(key).is_none_or(|fp| fp != own) {
            // a replaced context or entry goes before the new one is built, and its cycles are collected
            pool.checks.remove(key);
            if libs_stale {
                pool.checks.clear();
                pool.ctx = None;
            }
            pool.rt.set_memory_limit(0);
            pool.rt.run_gc();
            if pool.ctx.is_none() {
                pool.ctx = Some((libs.clone(), load_libs(pool, libs)?));
            }
            let ctx = pool.ctx.as_ref().map(|(_, c)| c.clone()).ok_or("context")?;
            load_check(&ctx, key, own, entry)?;
            pool.checks.insert(key.to_string(), own.clone());
            pool.rt.run_gc();
            let base = pool.rt.memory_usage().malloc_size.max(0) as usize;
            pool.rt.set_memory_limit(base + defaults::num("script.call_memory_bytes") as usize);
        }
    pool.ctx.as_ref().map(|(_, c)| c.clone()).ok_or_else(|| "context".to_string())
}

/// Ask the plugin script `name` (`engine/logic/<name>.js`, owner override first) to apply one of its rules: call its top-level
/// function `func` with `args` (JSON in, JSON out). This is how engine code that is not a hook (the GitHub poller, a statusline
/// segment) reads a rule from the plugin instead of holding it: the script is the rule. `None` when scripts are off, the script
/// is missing, or the call failed (an exception, the time or heap limit, a result that is not JSON); the reason is logged, and the
/// caller decides what no answer means. The same bounds as a hook's script apply.
pub fn call_fn(name: &str, func: &str, args: &Value) -> Option<Value> {
    if defaults::num("script.enabled") == 0 {
        return None;
    }
    let env = RequestEnv::from_pairs(std::env::vars());
    let st = Settings::from_env(&env);
    let (libs, own) = resolve(name, &st.home)?;
    let key = format!("{name}#{func}");
    let r = POOL.with(|cell| -> Result<Value, String> {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(Pool::new().ok_or("runtime")?);
        }
        let pool = slot.as_mut().ok_or("runtime")?;
        let ctx = ensure_entry(pool, &key, &libs, &own, func)?;
        let raw = serde_json::to_string(args).map_err(|e| e.to_string())?;
        let limit = limit_ms(name, func);
        host::with_call(st, || {
            host::set_deadline(Some(pool.deadline.clone()));
            pool.arm(limit);
            let out = ctx.with(|c| -> Result<String, String> {
                let reg: rquickjs::Object = c.globals().get(defaults::text("script.registry_global")).catch(&c).map_err(|e| e.to_string())?;
                let f: Function = reg.get(key.as_str()).catch(&c).map_err(|e| e.to_string())?;
                let a: JsValue = c.json_parse(raw).catch(&c).map_err(|e| e.to_string())?;
                let v: JsValue = f.call((a,)).catch(&c).map_err(|e| e.to_string())?;
                let s = c.json_stringify(v).catch(&c).map_err(|e| e.to_string())?;
                Ok(s.and_then(|s| s.to_string().ok()).unwrap_or_else(|| "null".into()))
            });
            pool.disarm();
            host::set_deadline(None);
            serde_json::from_str(&out?).map_err(|e| e.to_string())
        })
    });
    match r {
        Ok(v) => Some(v),
        Err(e) => {
            crate::discard::note("script_error", &format!("{name}.{func}: {e}"));
            None
        }
    }
}

fn call(name: &str, libs: &Fingerprint, own: &Fingerprint, payload: &Value, opts: &Value, event: &str, st: Settings) -> Option<Verdict> {
    let r = POOL.with(|cell| -> Result<Option<Verdict>, String> {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(Pool::new().ok_or("runtime")?);
        }
        let pool = slot.as_mut().ok_or("runtime")?;
        let ctx = ensure_entry(pool, name, libs, own, defaults::text("script.entry"))?;
        let raw = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        let opts_raw = serde_json::to_string(opts).map_err(|e| e.to_string())?;
        let limit = limit_ms(name, event);
        host::with_call(st, || {
            host::set_deadline(Some(pool.deadline.clone()));
            pool.arm(limit);
            let out = ctx.with(|c| -> Result<String, String> {
                let reg: rquickjs::Object = c.globals().get(defaults::text("script.registry_global")).catch(&c).map_err(|e| e.to_string())?;
                let f: Function = reg.get(name).catch(&c).map_err(|e| e.to_string())?;
                let p: JsValue = c.json_parse(raw).catch(&c).map_err(|e| e.to_string())?;
                let o: JsValue = c.json_parse(opts_raw).catch(&c).map_err(|e| e.to_string())?;
                let v: JsValue = f.call((p, o, event)).catch(&c).map_err(|e| e.to_string())?;
                if v.is_undefined() || v.is_null() {
                    return Ok("null".into());
                }
                let s = c.json_stringify(v).catch(&c).map_err(|e| e.to_string())?;
                Ok(s.and_then(|s| s.to_string().ok()).unwrap_or_else(|| "null".into()))
            });
            pool.disarm();
            host::set_deadline(None);
            let text = out?;
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            verdict_of(&v)
        })
    });
    match r {
        Ok(v) => v,
        Err(e) => Some(failed(name, event, &e)),
    }
}

/// The latency budget of one scripted check call at the 95th percentile (`script.p95_budget_us`), for the go/no-go gate.
pub fn p95_budget_us() -> u64 {
    defaults::num("script.p95_budget_us")
}

/// The latency budget of one scripted check: its own entry in `script.p95_budget_by_check` (a check that waits on a child
/// process or a disk sync has that wait in its p95, as the compiled port did), else `script.p95_budget_us`.
pub fn p95_budget_for(check: &str) -> u64 {
    defaults::raw("script.p95_budget_by_check").get(check).and_then(defaults::V::as_integer).map_or_else(p95_budget_us, |b| b.max(0) as u64)
}

/// `{NOW}`, `{NOW-<ms>}` and `{NOW+<ms>}` become the current time in milliseconds since the epoch, `{ISO}`, `{ISO-<ms>}` and
/// `{ISO+<ms>}` the same instant as an ISO-8601 UTC text, `{DATE}` its UTC calendar day (`YYYY-MM-DD`): a case can place an event a fixed distance from the moment it is
/// replayed, so a check that compares times against the clock answers the same today and in a year.
pub fn expand_now(s: &str, now_ms: f64) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('{') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let placeholder = tail.find('}').and_then(|close| {
            let body = &tail[1..close];
            let (kind, delta) = match body.find(['-', '+']) {
                Some(i) => (&body[..i], body[i..].parse::<f64>().ok()),
                None => (body, Some(0.0)),
            };
            match (kind, delta) {
                ("NOW", Some(d)) => Some((close, format!("{}", (now_ms + d) as i64))),
                ("ISO", Some(d)) => Some((close, crate::checks::agent_scan::iso_utc(now_ms + d))),
                ("DATE", Some(d)) => Some((close, crate::checks::agent_scan::iso_utc(now_ms + d)[..10].to_string())),
                _ => None,
            }
        });
        match placeholder {
            Some((close, text)) => {
                out.push_str(&text);
                rest = &tail[close + 1..];
            }
            None => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod golden;
#[cfg(test)]
mod tests;
#[cfg(test)]
#[path = "host_tests/tests.rs"]
mod tests_host;
#[cfg(test)]
#[path = "host_tests_e/tests.rs"]
mod tests_host_e;
#[cfg(test)]
#[path = "host_tests_d/tests.rs"]
mod tests_host_d;
#[cfg(test)]
#[path = "golden_d6/tests.rs"]
mod tests_golden_d6;
#[cfg(test)]
#[path = "golden_e/tests.rs"]
mod tests_golden_e;
