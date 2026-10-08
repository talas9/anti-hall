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
//! One runtime per worker thread (the daemon's request threads are fixed, so the pool is bounded by `daemon.workers`), one
//! context per check inside it. A call runs under a wall-clock deadline (`script.time_limit_ms`, enforced by the
//! interpreter's interrupt handler), a heap ceiling (`script.call_memory_bytes` above the size measured after loading) and a
//! stack ceiling. Any failure (exception, interrupt, out of memory, a verdict of the wrong shape) is a deferral, never a
//! silent allow (D11).
//!
//! Teardown rule (the "runtime teardown assertion" root cause): `JS_FreeRuntime` asserts that no object is still alive. A
//! `Persistent` handle, or a JS value kept outside `Context::with`, that outlives the runtime aborts the process. So no JS
//! value is ever stored outside a `with` block (the entry function is looked up by name per call), a pending exception is
//! always taken with `catch`, and [`Pool`] drops its contexts before its runtime (field order) and runs a GC in between.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file or directory is the same as an absent one
// A failure that must be seen goes through `crate::discard` instead.

pub mod host;

use crate::checks::git::util::Settings;
use crate::checks::{Exact, Verdict};
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

/// One check's loaded context.
struct Loaded {
    fp: Fingerprint,
    ctx: Context,
}

/// The per-thread interpreter: the contexts are declared before the runtime so they are dropped first.
struct Pool {
    loaded: HashMap<String, Loaded>,
    /// Interrupt deadline: nanoseconds since `epoch`, 0 = none.
    deadline: Arc<AtomicU64>,
    epoch: Instant,
    rt: Runtime,
}

impl Drop for Pool {
    fn drop(&mut self) {
        self.loaded.clear();
        self.rt.run_gc();
    }
}

impl Pool {
    fn new() -> Option<Pool> {
        let rt = Runtime::new().ok()?;
        rt.set_max_stack_size(defaults::num("script.stack_bytes") as usize);
        let deadline = Arc::new(AtomicU64::new(0));
        let epoch = Instant::now();
        let d = deadline.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            let until = d.load(Ordering::Relaxed);
            until != 0 && epoch.elapsed().as_nanos() as u64 > until
        })));
        Some(Pool { loaded: HashMap::new(), deadline, epoch, rt })
    }
}

thread_local! {
    static POOL: RefCell<Option<Pool>> = const { RefCell::new(None) };
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

/// The files a check's context is built from, lib files first (by name), then the check script; `None` when no script
/// exists for `name`.
fn resolve(name: &str, home: &str) -> Option<Fingerprint> {
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
    let mut fp: Fingerprint = libs.into_values().collect();
    fp.push(script);
    Some(fp)
}

/// Build a context from the files of `fp`. `Err` carries the reason.
fn load(pool: &Pool, fp: &Fingerprint) -> Result<Context, String> {
    let ctx = Context::full(&pool.rt).map_err(|e| e.to_string())?;
    ctx.with(|c| -> Result<(), String> {
        host::install(&c).map_err(|e| e.to_string())?;
        for (path, _, _) in fp {
            let src = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
            c.eval::<(), _>(src).catch(&c).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Ok(())
    })?;
    Ok(ctx)
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
        other => return Err(defaults::render("script.msg_bad_verdict", &[("value", other)])),
    })
}

/// Run the script of check `name` on one payload. `None`: no script for this check (or scripts are off), so the compiled
/// port decides. `Some(v)`: the script's answer, a deferral on any failure.
pub fn run(name: &str, payload: &Value, env: &RequestEnv) -> Option<Option<Verdict>> {
    if defaults::num("script.enabled") == 0 {
        return None;
    }
    let st = Settings::from_env(env);
    let fp = resolve(name, &st.home)?;
    Some(call(name, &fp, payload, st))
}

/// Run the script of `name` regardless of `script.enabled` (parity tests and measurements). `None` when no script exists.
pub fn run_forced(name: &str, payload: &Value, env: &RequestEnv) -> Option<Option<Verdict>> {
    let st = Settings::from_env(env);
    let fp = resolve(name, &st.home)?;
    Some(call(name, &fp, payload, st))
}

fn call(name: &str, fp: &Fingerprint, payload: &Value, st: Settings) -> Option<Verdict> {
    let r = POOL.with(|cell| -> Result<Option<Verdict>, String> {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = Some(Pool::new().ok_or("runtime")?);
        }
        let pool = slot.as_mut().ok_or("runtime")?;
        if pool.loaded.get(name).is_none_or(|l| l.fp != *fp) {
            // a replaced context goes before the new one is built, and its cycles are collected
            pool.loaded.remove(name);
            pool.rt.set_memory_limit(0);
            pool.rt.run_gc();
            let ctx = load(pool, fp)?;
            pool.loaded.insert(name.to_string(), Loaded { fp: fp.clone(), ctx });
            pool.rt.run_gc();
            let base = pool.rt.memory_usage().malloc_size.max(0) as usize;
            pool.rt.set_memory_limit(base + defaults::num("script.call_memory_bytes") as usize);
        }
        let ctx = pool.loaded.get(name).map(|l| l.ctx.clone()).ok_or("context")?;
        let raw = serde_json::to_string(payload).map_err(|e| e.to_string())?;
        let limit = defaults::num("script.time_limit_ms").saturating_mul(1_000_000);
        host::with_call(st, || {
            pool.deadline.store((pool.epoch.elapsed().as_nanos() as u64).saturating_add(limit).max(1), Ordering::Relaxed);
            let out = ctx.with(|c| -> Result<String, String> {
                let f: Function = c.globals().get(defaults::text("script.entry")).catch(&c).map_err(|e| e.to_string())?;
                let p: JsValue = c.json_parse(raw).catch(&c).map_err(|e| e.to_string())?;
                let v: JsValue = f.call((p,)).catch(&c).map_err(|e| e.to_string())?;
                if v.is_undefined() || v.is_null() {
                    return Ok("null".into());
                }
                let s = c.json_stringify(v).catch(&c).map_err(|e| e.to_string())?;
                Ok(s.and_then(|s| s.to_string().ok()).unwrap_or_else(|| "null".into()))
            });
            pool.deadline.store(0, Ordering::Relaxed);
            let text = out?;
            let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            verdict_of(&v)
        })
    });
    match r {
        Ok(v) => v,
        Err(e) => {
            crate::discard::note("script_error", &format!("{name}: {e}"));
            Some(Verdict::Defer)
        }
    }
}

/// The latency budget of one scripted check call at the 95th percentile (`script.p95_budget_us`), for the go/no-go gate.
pub fn p95_budget_us() -> u64 {
    defaults::num("script.p95_budget_us")
}

#[cfg(test)]
mod tests;
