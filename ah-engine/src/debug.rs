//! Debug mode: one build, two runtime modes. The shipped binary is the same in both; debug mode only turns on extra work.
//!
//! What it does while on:
//! * verbose per-module log lines (`debug_log!`) in the debug log (`files.debug_log`, NDJSON, rotated at
//!   `diagnostics.debug_log_max_bytes`), limited to `diagnostics.debug_modules` when that list is not empty;
//! * runtime invariant checks (`invariant!`): a violated one is logged and counted, never fatal (the engine fails open);
//! * every `diagnostics.debug_thread_sample_ms` the watchdog logs the busiest threads and the work counters per second;
//! * every `diagnostics.debug_mem_snapshot_ms` the watchdog logs a memory line.
//!
//! Switches: `diagnostics.debug_mode` (a config setting, re-read by the daemon on every config change, so a running daemon follows
//! it without a restart), the environment variable `env.debug`, and the `diagnostics.debug_flag` argument of any command. The
//! environment variable and the flag are per process and win over the setting being off.
//!
//! Cost while off: one relaxed atomic load per call site, and the arguments of `debug_log!` / `invariant!` are not evaluated.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a debug log that cannot be written is dropped: debug output never changes what the engine does
use crate::defaults;
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::Instant;

static ON: AtomicBool = AtomicBool::new(false);
/// Set by the environment variable or the flag: the config setting cannot turn it off.
static FORCED: AtomicBool = AtomicBool::new(false);
static LINES: AtomicU64 = AtomicU64::new(0);
static VIOLATIONS: AtomicU64 = AtomicU64::new(0);

/// Whether debug mode is on in this process now.
#[inline]
pub fn enabled() -> bool {
    ON.load(Relaxed)
}

/// Whether the environment variable `env.debug` asks for debug mode.
fn env_on() -> bool {
    defaults::env_var("debug").is_some_and(|v| {
        let v = v.trim();
        !v.is_empty() && v != "0"
    })
}

/// Whether the environment or the command-line `args` ask for debug mode.
pub fn requested(args: &[String]) -> bool {
    env_on() || args.iter().any(|a| a == defaults::text("diagnostics.debug_flag"))
}

/// Turn debug mode on for this process when the environment or `args` ask for it. Needs the defaults loaded.
pub fn init(args: &[String]) {
    if requested(args) {
        FORCED.store(true, Relaxed);
        ON.store(true, Relaxed);
    }
}

/// Follow the `diagnostics.debug_mode` setting (the environment and the flag keep it on). `Some(new)` when the state changed.
pub fn apply_config(setting: bool) -> Option<bool> {
    let want = FORCED.load(Relaxed) || setting;
    let was = ON.swap(want, Relaxed);
    (was != want).then_some(want)
}

/// Whether lines of `module` are written: the module list is empty, or has the name, or a prefix ending in a dot.
fn wanted(module: &str) -> bool {
    listed(&defaults::list("diagnostics.debug_modules"), module)
}

fn listed(list: &[&str], module: &str) -> bool {
    list.is_empty() || list.iter().any(|m| *m == module || (m.ends_with('/') && module.starts_with(m)))
}

fn write(module: &str, msg: &str, data: Value) {
    let path = crate::paths::dir().join(defaults::text("files.debug_log"));
    if let Some(dir) = path.parent() {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: a state dir that is not there yet must not swallow the first debug lines
    }
    if std::fs::metadata(&path).map(|m| m.len() > defaults::num("diagnostics.debug_log_max_bytes")).unwrap_or(false) {
        // keep: rotation that raced another writer leaves the log growing one more line, nothing is lost
        crate::discard::harmless(std::fs::rename(&path, path.with_extension("ndjson.1")));
    }
    let cur = std::thread::current();
    let rec = json!({"ts": crate::health::now_ms(), "pid": std::process::id(), "thread": cur.name().unwrap_or(""), "module": module, "msg": msg, "data": data});
    // the daemon and every hook client append to this file: one write call per line, so lines never interleave
    let line = format!("{rec}\n");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        crate::discard::harmless(std::io::Write::write_all(&mut f, line.as_bytes())); // keep: a lost debug line changes nothing
        LINES.fetch_add(1, Relaxed);
    }
}

/// Write one debug line (nothing when debug mode is off or the module is not listed).
pub fn log(module: &str, msg: &str) {
    log_data(module, msg, Value::Null);
}

/// Write one debug line with structured data.
pub fn log_data(module: &str, msg: &str, data: Value) {
    if enabled() && wanted(module) {
        write(module, msg, data);
    }
}

/// A violated invariant: counted, and written to the debug log whatever the module list says. Never panics.
pub fn violated(module: &str, what: &str) {
    VIOLATIONS.fetch_add(1, Relaxed);
    write(module, &defaults::render("msg.inv_violated", &[("what", &what)]), Value::Null);
}

/// `debug_log!(module, text)`: a debug line; `text` is a `String` expression (its wording is a shipped message, so it is built
/// with `defaults::render`) that is only evaluated in debug mode.
#[macro_export]
macro_rules! debug_log {
    ($module:expr, $text:expr) => {
        if $crate::debug::enabled() {
            $crate::debug::log($module, &$text);
        }
    };
}

/// `invariant!(module, cond, text)`: in debug mode, when `cond` is false, count and log a violation. Neither the condition nor
/// the `String` expression `text` is evaluated when debug mode is off.
#[macro_export]
macro_rules! invariant {
    ($module:expr, $cond:expr, $text:expr) => {
        if $crate::debug::enabled() && !($cond) {
            $crate::debug::violated($module, &$text);
        }
    };
}

/// The state for `status`: whether it is on, how it was asked for, lines written and invariants violated.
pub fn stats() -> Value {
    json!({"enabled": enabled(), "forced": FORCED.load(Relaxed), "lines": LINES.load(Relaxed), "invariant_violations": VIOLATIONS.load(Relaxed),
        "log": crate::paths::dir().join(defaults::text("files.debug_log")).display().to_string()})
}

/// The watchdog's periodic debug samplers (per-thread CPU, memory).
pub struct Sampler {
    prev: Option<(Value, Instant)>,
    last_threads: Instant,
    last_mem: Instant,
}

impl Default for Sampler {
    fn default() -> Self {
        Self::new()
    }
}

impl Sampler {
    /// A sampler whose first samples come one interval from now.
    pub fn new() -> Self {
        Self { prev: None, last_threads: Instant::now(), last_mem: Instant::now() }
    }

    /// Take the samples that are due. Does nothing (and forgets the previous thread snapshot) while debug mode is off.
    pub fn tick(&mut self, memory: impl FnOnce() -> Value) {
        if !enabled() {
            self.prev = None;
            return;
        }
        if self.last_threads.elapsed() >= defaults::millis("diagnostics.debug_thread_sample_ms") {
            self.last_threads = Instant::now();
            let now = crate::threads::snapshot_json();
            let at = Instant::now();
            if let Some((a, t0)) = self.prev.take() {
                let r = crate::threads::report(&a, &now, t0.elapsed().as_micros() as u64);
                let top = defaults::num("diagnostics.debug_thread_top") as usize;
                let field = |k: &str| r.get(k).cloned().unwrap_or(Value::Null);
                let by_name: Vec<Value> = r.get("by_name").and_then(Value::as_array).map(|v| v.iter().take(top).cloned().collect()).unwrap_or_default();
                log_data(
                    "threads",
                    "cpu",
                    json!({"window_ms": field("window_ms"), "cpu_pct_total": field("cpu_pct_total"), "by_name": by_name, "work_per_s": field("work_per_s")}),
                );
            }
            self.prev = Some((now, at));
        }
        if self.last_mem.elapsed() >= defaults::millis("diagnostics.debug_mem_snapshot_ms") {
            self.last_mem = Instant::now();
            log_data("memory", "snapshot", memory());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // debug mode is process-global: the tests that switch it run one at a time
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The debug log of the unit-test scratch state directory (`paths::dir()` never reaches the real home under test).
    fn log_path() -> std::path::PathBuf {
        crate::paths::dir().join(defaults::text("files.debug_log"))
    }

    /// The lines this test wrote: this process (other test processes append to the same file) and this test's own thread (the
    /// tests of this process share one log file, so another test's lines would otherwise be counted, by test order).
    fn own_lines(path: &std::path::Path) -> Vec<Value> {
        let text = std::fs::read_to_string(path).unwrap_or_default();
        let me = std::thread::current().name().unwrap_or_default().to_string();
        text.lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter(|v| v["pid"] == json!(std::process::id()) && v["thread"] == json!(me))
            .collect()
    }

    #[test]
    fn off_by_default_writes_nothing_and_skips_the_arguments() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        ON.store(false, Relaxed);
        let evaluated = std::cell::Cell::new(false);
        crate::debug_log!("test", {
            evaluated.set(true);
            String::from("never")
        });
        crate::invariant!(
            "test",
            {
                evaluated.set(true);
                false
            },
            String::from("never")
        );
        assert!(!evaluated.get(), "arguments are only evaluated in debug mode");
        let before = VIOLATIONS.load(Relaxed);
        crate::invariant!("test", false, String::from("off"));
        assert_eq!(VIOLATIONS.load(Relaxed), before);
    }

    #[test]
    fn the_module_list_matches_names_and_slash_prefixes() {
        assert!(listed(&[], "daemon/queue"), "an empty list means every module");
        assert!(listed(&["daemon/queue"], "daemon/queue"));
        assert!(!listed(&["daemon/queue"], "daemon/cpu"));
        assert!(listed(&["daemon/"], "daemon/cpu"));
        assert!(!listed(&["daemon/"], "client/hook"));
        assert!(!listed(&["daemon"], "daemon/cpu"), "a prefix needs its slash");
    }

    #[test]
    fn the_config_setting_follows_and_the_flag_cannot_be_turned_off_by_it() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        FORCED.store(false, Relaxed);
        ON.store(false, Relaxed);
        assert_eq!(apply_config(true), Some(true));
        assert!(enabled());
        assert_eq!(apply_config(true), None, "no change, no event");
        assert_eq!(apply_config(false), Some(false), "hot reload turns it off again");
        assert!(!enabled());
        init(&["--debug".to_string()]);
        assert!(enabled() && FORCED.load(Relaxed));
        assert_eq!(apply_config(false), None, "the flag wins over a setting that is off");
        assert!(enabled());
        FORCED.store(false, Relaxed);
        ON.store(false, Relaxed);
    }

    #[test]
    fn lines_and_violations_reach_the_log_and_the_module_filter_applies() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let path = log_path();
        ON.store(true, Relaxed);
        crate::debug_log!("daemon/request", String::from("served 7"));
        crate::invariant!("daemon/queue", 1 + 1 == 3, String::from("depth 2 != len 3"));
        crate::invariant!("daemon/queue", true, String::from("holds"));
        ON.store(false, Relaxed);
        crate::debug_log!("daemon/request", String::from("after off"));
        let lines = own_lines(&path);
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0]["module"], "daemon/request");
        assert_eq!(lines[0]["msg"], "served 7");
        assert!(lines[1]["msg"].as_str().unwrap().contains("INVARIANT VIOLATED: depth 2 != len 3"));
        assert!(stats()["invariant_violations"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn a_sampler_logs_per_thread_cpu_after_two_samples() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let path = log_path();
        ON.store(true, Relaxed);
        let mut s = Sampler::new();
        // make both intervals due without waiting for them
        s.last_threads = Instant::now() - std::time::Duration::from_secs(3600);
        s.last_mem = Instant::now() - std::time::Duration::from_secs(3600);
        s.tick(|| json!({"rss_kb": 1}));
        s.last_threads = Instant::now() - std::time::Duration::from_secs(3600);
        s.tick(|| json!({}));
        ON.store(false, Relaxed);
        let lines = own_lines(&path);
        assert!(lines.iter().any(|l| l["module"] == "memory"), "{lines:?}");
        assert!(lines.iter().any(|l| l["module"] == "threads" && l["data"]["by_name"].is_array()), "{lines:?}");
    }
}
