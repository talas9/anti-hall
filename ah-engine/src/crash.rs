//! Panic and abnormal-exit context: thread-local breadcrumbs, the global panic hook, and guarded service threads.
use crate::defaults;
use crate::health;
use serde_json::{Value, json};
use std::cell::RefCell;
use std::panic::PanicHookInfo;
use std::sync::Arc;
use std::time::Duration;

thread_local! {
    static BREADCRUMB: RefCell<Context> = RefCell::new(Context::default());
}

/// Context carried across request, job and check boundaries.
#[derive(Default, Clone)]
pub struct Context {
    /// Boundary kind (`request`, `job`, `thread`, `check`).
    pub kind: String,
    /// Current request kind or control verb.
    pub request: String,
    /// Hook event name.
    pub event: String,
    /// Check id/name.
    pub check: String,
    /// Scheduled job name.
    pub job: String,
}

impl Context {
    fn json(&self) -> Value {
        json!({"kind": self.kind, "request": self.request, "event": self.event, "check": self.check, "job": self.job})
    }
}

/// Restores the previous thread-local context when dropped.
pub struct Guard(Context);

impl Drop for Guard {
    fn drop(&mut self) {
        let prior = self.0.clone();
        BREADCRUMB.with(|c| *c.borrow_mut() = prior);
    }
}

/// Enter a boundary and expose its breadcrumb to the panic hook.
pub fn enter(kind: &str, request: &str, event: &str, check: &str, job: &str) -> Guard {
    let next = Context { kind: kind.into(), request: request.into(), event: event.into(), check: check.into(), job: job.into() };
    let prior = BREADCRUMB.with(|c| std::mem::replace(&mut *c.borrow_mut(), next));
    Guard(prior)
}

/// Current thread-local context.
pub fn current() -> Context {
    BREADCRUMB.with(|c| c.borrow().clone())
}

/// Install the process-wide panic hook. The hook never writes to host stderr; it writes only the engine log and crash file.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(record_panic));
}

fn payload(info: &PanicHookInfo<'_>) -> String {
    if let Some(s) = info.payload().downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = info.payload().downcast_ref::<String>() {
        s.clone()
    } else {
        defaults::text("msg.panic_payload_unknown").to_string()
    }
}

fn record_panic(info: &PanicHookInfo<'_>) {
    let ctx = current();
    let thread = std::thread::current().name().unwrap_or(defaults::text("msg.thread_unknown")).to_string();
    let loc = info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column())).unwrap_or_default();
    let backtrace = format!("{:?}", std::backtrace::Backtrace::force_capture());
    let v = json!({
        "ts": health::now_ms(),
        "kind": "panic",
        "message": payload(info),
        "location": loc,
        "thread": thread,
        "context": ctx.json(),
        "backtrace": backtrace,
    });
    health::write_crash_report(&v);
    health::log_event("panic", "panic", &v.to_string());
}

/// Run one long-lived service loop behind a panic boundary. A panic restarts the loop until the configured cap is exceeded.
pub fn spawn_supervised(
    name: &'static str,
    should_stop: Arc<dyn Fn() -> bool + Send + Sync>,
    request_restart: Arc<dyn Fn(&str) + Send + Sync>,
    run: Arc<dyn Fn() + Send + Sync>,
) -> Option<std::thread::JoinHandle<()>> {
    let thread_name = name.to_string();
    let spawn = std::thread::Builder::new().name(thread_name.clone()).spawn(move || {
        let mut panics = 0_u64;
        loop {
            let _guard = enter("thread", "", "", "", name);
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run()));
            if r.is_ok() {
                return;
            }
            panics += 1;
            let max = defaults::num("daemon.thread_restart_max");
            health::log_event("thread_panic", name, &defaults::render("msg.thread_panic", &[("thread", &name), ("n", &panics), ("max", &max)]));
            health::record_failure("panic", "thread_panic", &defaults::render("msg.thread_panic", &[("thread", &name), ("n", &panics), ("max", &max)]));
            if panics > max || should_stop() {
                request_restart(name);
                return;
            }
            std::thread::sleep(Duration::from_millis(defaults::num("daemon.thread_restart_backoff_ms")));
        }
    });
    crate::discard::logged_ok("thread_spawn", spawn)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    #[test]
    fn supervised_thread_restarts_after_a_panic() {
        let runs = Arc::new(AtomicUsize::new(0));
        let r = runs.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let handle = spawn_supervised(
            "test-thread",
            Arc::new(move || stopped.load(Ordering::SeqCst)),
            Arc::new(|_| {}),
            Arc::new(move || {
                if r.fetch_add(1, Ordering::SeqCst) == 0 {
                    std::panic::resume_unwind(Box::new("first run"));
                }
            }),
        )
        .expect("thread spawned");
        handle.join().expect("supervisor exits after successful restarted run");
        assert_eq!(runs.load(Ordering::SeqCst), 2);
        stop.store(true, Ordering::SeqCst);
    }

    #[test]
    fn panic_hook_writes_thread_and_breadcrumb_context() {
        let d = crate::db::TempDir::new("panic-hook");
        // SAFETY: this test sets the engine state dir before spawning any helper thread that reads it.
        unsafe { std::env::set_var(crate::defaults::env_name("dir"), &d.0) };
        install_panic_hook();
        let _guard = enter("request", "V", "PreToolUse", "git-guard", "");
        assert!(std::panic::catch_unwind(|| panic!("hook panic")).is_err());
        let crash = crate::health::last_crash().expect("panic hook wrote crash report");
        assert_eq!(crash["context"]["request"], "V");
        assert_eq!(crash["context"]["event"], "PreToolUse");
        assert_eq!(crash["context"]["check"], "git-guard");
        assert!(!crash["thread"].as_str().unwrap_or("").is_empty());
        assert!(!crash["backtrace"].as_str().unwrap_or("").is_empty());
    }

    #[test]
    fn stale_run_marker_folds_abort_breadcrumb_into_last_crash() {
        let d = crate::db::TempDir::new("abort-breadcrumb");
        // SAFETY: this test sets the engine state dir before using health state helpers.
        unsafe { std::env::set_var(crate::defaults::env_name("dir"), &d.0) };
        std::fs::write(d.0.join(crate::defaults::text("files.run_marker")), "0").unwrap();
        crate::health::write_crash_breadcrumb("D", "Stop", "task-guard", 7, json!({"rss_kb": 12}));
        crate::health::reap_marker();
        let crash = crate::health::last_crash().expect("reap wrote crash report");
        assert_eq!(crash["breadcrumb"]["request"], "D");
        assert_eq!(crash["breadcrumb"]["event"], "Stop");
        assert_eq!(crash["breadcrumb"]["check"], "task-guard");
    }
}
