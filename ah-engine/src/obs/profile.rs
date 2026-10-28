//! Switchable profiling: per-check CPU and allocation spans written to a bounded file.
//!
//! The mode is `off`, `sample` (one call in `diagnostics.profile_sample_every`) or `full`. The baseline is the config key
//! `diagnostics.profile`; `ah-engine ctl profile on [mode] --for <dur>` raises it for a limited time (capped at
//! `diagnostics.profile_max_secs`) and the mode falls back to the baseline when the time is up. While the mode is off the cost of a
//! call site is [`active`]: one relaxed atomic load. The span file never grows past `diagnostics.profile_max_bytes`: reaching it
//! switches profiling off (counted and logged), it is not rotated.
use crate::{defaults, health, paths};
use serde_json::{Value, json};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering::Relaxed};

/// How much is recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Nothing.
    Off,
    /// One call in `diagnostics.profile_sample_every`.
    Sample,
    /// Every call.
    Full,
}

impl Mode {
    fn from_u8(n: u8) -> Mode {
        match n {
            1 => Mode::Sample,
            2 => Mode::Full,
            _ => Mode::Off,
        }
    }

    /// The mode's name as written in the config and in replies.
    pub fn name(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Sample => "sample",
            Mode::Full => "full",
        }
    }

    /// The mode named `s`.
    pub fn parse(s: &str) -> Option<Mode> {
        match s.trim() {
            "off" => Some(Mode::Off),
            "sample" => Some(Mode::Sample),
            "full" => Some(Mode::Full),
            _ => None,
        }
    }
}

/// The mode now in force.
static EFFECTIVE: AtomicU8 = AtomicU8::new(0);
/// The mode the config asks for (what the runtime window falls back to).
static BASELINE: AtomicU8 = AtomicU8::new(0);
/// When the runtime window ends (health clock, ms); 0 = no window.
static UNTIL_MS: AtomicU64 = AtomicU64::new(0);
/// `ctl profile off` was given: a config load does not switch the baseline back on until the next `on`.
static FORCED_OFF: AtomicBool = AtomicBool::new(false);
/// Calls seen while sampling.
static TICK: AtomicU64 = AtomicU64::new(0);
/// Spans written.
static RECORDED: AtomicU64 = AtomicU64::new(0);
/// Times the span file reached its size limit.
static FULL: AtomicU64 = AtomicU64::new(0);

/// Whether profiling may be on: one relaxed atomic load, the whole cost of a call site while it is off.
#[inline]
pub fn active() -> bool {
    EFFECTIVE.load(Relaxed) != 0
}

/// The mode in force at `now_ms`; a runtime window that has ended is closed here (back to the baseline).
pub fn mode_at(now_ms: u64) -> Mode {
    let cur = EFFECTIVE.load(Relaxed);
    let until = UNTIL_MS.load(Relaxed);
    if cur != 0 && until != 0 && now_ms >= until {
        let base = BASELINE.load(Relaxed);
        if EFFECTIVE.compare_exchange(cur, base, Relaxed, Relaxed).is_ok() {
            UNTIL_MS.store(0, Relaxed);
            health::log_event("obs", "profile", &defaults::render("msg.obs_profile_off", &[("mode", &Mode::from_u8(base).name()), ("why", &"expired")]));
        }
        return Mode::from_u8(EFFECTIVE.load(Relaxed));
    }
    Mode::from_u8(cur)
}

/// Switch to `mode` from `now_ms` for `dur_ms` (cut to `diagnostics.profile_max_secs`; 0 asks for that limit). Returns the length
/// of the window in milliseconds.
pub fn enable_at(now_ms: u64, mode: Mode, dur_ms: u64) -> u64 {
    let limit = defaults::num("diagnostics.profile_max_secs").saturating_mul(unit_ms("s"));
    let dur = if dur_ms == 0 { limit } else { dur_ms.min(limit) };
    FORCED_OFF.store(false, Relaxed);
    UNTIL_MS.store(now_ms.saturating_add(dur), Relaxed);
    EFFECTIVE.store(mode as u8, Relaxed);
    health::log_event("obs", "profile", &defaults::render("msg.obs_profile_on", &[("mode", &mode.name()), ("ms", &dur)]));
    dur
}

/// Switch profiling off now, whatever the baseline says, until the next `on`.
pub fn disable() {
    FORCED_OFF.store(true, Relaxed);
    EFFECTIVE.store(0, Relaxed);
    UNTIL_MS.store(0, Relaxed);
    health::log_event("obs", "profile", &defaults::render("msg.obs_profile_off", &[("mode", &Mode::Off.name()), ("why", &"off")]));
}

/// Take the baseline from the config value `name` (`off`, `sample`, `full`; anything else reads as off). A runtime window in force
/// is left alone; its end falls back to this baseline.
pub fn apply_config(name: &str) {
    let base = Mode::parse(name).unwrap_or(Mode::Off) as u8;
    BASELINE.store(base, Relaxed);
    if UNTIL_MS.load(Relaxed) == 0 && !FORCED_OFF.load(Relaxed) {
        EFFECTIVE.store(base, Relaxed);
    }
}

/// Length in milliseconds of the duration suffix `unit` (`diagnostics.duration_units`).
fn unit_ms(unit: &str) -> u64 {
    defaults::raw("diagnostics.duration_units").get(unit).and_then(|v| v.as_integer()).unwrap_or(0).max(0) as u64
}

/// A duration such as `90s`, `10m`, `2h`, `1500ms` (a bare number is seconds) in milliseconds.
pub fn parse_duration(s: &str) -> Option<u64> {
    let s = s.trim();
    let digits = s.chars().take_while(char::is_ascii_digit).count();
    let (num, unit) = s.split_at(digits);
    let n: u64 = num.parse().ok()?;
    let per = unit_ms(if unit.is_empty() { "s" } else { unit });
    (per > 0).then(|| n.saturating_mul(per))
}

/// What one recorded check call looked like.
pub struct Span<'a> {
    /// The hook event being served.
    pub event: &'a str,
    /// The check.
    pub check: &'a str,
    /// Wall microseconds.
    pub wall_us: u64,
    /// CPU microseconds of the thread.
    pub cpu_us: u64,
    /// Bytes allocated (0 when the call was not measured).
    pub alloc_bytes: u64,
    /// Peak live bytes above the start of the call (0 when not measured).
    pub peak_bytes: u64,
}

/// Record `s` when the mode asks for it. Call it behind [`active`]: with profiling off nothing here runs.
pub fn span(s: &Span<'_>) {
    let record = match mode_at(health::now_ms()) {
        Mode::Off => false,
        Mode::Full => true,
        Mode::Sample => TICK.fetch_add(1, Relaxed).is_multiple_of(defaults::num("diagnostics.profile_sample_every").max(1)),
    };
    if !record {
        return;
    }
    let line = format!(
        "{}\n",
        json!({"ts_ms": health::now_ms(), "event": s.event, "check": s.check, "wall_us": s.wall_us, "cpu_us": s.cpu_us, "alloc": s.alloc_bytes, "peak": s.peak_bytes})
    );
    let path = paths::dir().join(defaults::text("diagnostics.profile_file"));
    if path.parent().is_some_and(|d| !d.is_dir()) {
        return; // no state directory: nothing is created for a profile
    }
    let size = std::fs::metadata(&path).map_or(0, |m| m.len());
    if size + line.len() as u64 > defaults::num("diagnostics.profile_max_bytes") {
        FULL.fetch_add(1, Relaxed);
        BASELINE.store(0, Relaxed);
        EFFECTIVE.store(0, Relaxed);
        UNTIL_MS.store(0, Relaxed);
        health::log_event("obs", "profile", &defaults::render("msg.obs_profile_off", &[("mode", &Mode::Off.name()), ("why", &"file full")]));
        return;
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(&path).and_then(|mut f| f.write_all(line.as_bytes())) {
        Ok(()) => {
            RECORDED.fetch_add(1, Relaxed);
        }
        Err(e) => health::log_event("obs", "profile", &defaults::render("msg.obs_counter_write_failed", &[("err", &e)])),
    }
}

/// The state, for `ctl profile status` and `diag cpu`.
pub fn status() -> Value {
    let now = health::now_ms();
    let until = UNTIL_MS.load(Relaxed);
    json!({
        "mode": mode_at(now).name(),
        "baseline": Mode::from_u8(BASELINE.load(Relaxed)).name(),
        "remaining_ms": until.saturating_sub(now),
        "recorded": RECORDED.load(Relaxed),
        "file_full": FULL.load(Relaxed),
        "file": defaults::text("diagnostics.profile_file"),
    })
}

/// The `profile` control verb of the daemon: `on` with an optional mode and `for=<dur>`, `off` or `status`. The reply is JSON.
pub fn ctl(args: &str) -> String {
    let mut words = args.split_whitespace();
    let usage = || json!({"error": defaults::text("msg.obs_profile_usage")}).to_string();
    match words.next() {
        Some("on") => {
            let mut mode = Mode::parse(defaults::text("diagnostics.profile_on_mode")).filter(|m| *m != Mode::Off).unwrap_or(Mode::Full);
            let mut dur = 0;
            for w in words {
                if let Some(v) = w.strip_prefix("for=") {
                    match parse_duration(v) {
                        Some(ms) => dur = ms,
                        None => return json!({"error": defaults::render("msg.obs_profile_bad_duration", &[("value", &v)])}).to_string(),
                    }
                } else if let Some(m) = Mode::parse(w).filter(|m| *m != Mode::Off) {
                    mode = m;
                } else {
                    return usage();
                }
            }
            enable_at(health::now_ms(), mode, dur);
            status().to_string()
        }
        Some("off") => {
            disable();
            status().to_string()
        }
        Some("status") | None => status().to_string(),
        Some(_) => usage(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_runtime_window_expires_back_to_the_baseline_and_off_costs_one_load() {
        apply_config("off");
        assert!(!active(), "off: the call site's whole cost is this one atomic load");
        std::fs::create_dir_all(crate::paths::dir()).unwrap(); // the unit-test scratch state dir, never the real one
        let before = RECORDED.load(Relaxed);
        enable_at(health::now_ms(), Mode::Full, 60_000);
        span(&Span { event: "PreToolUse", check: "t", wall_us: 5, cpu_us: 4, alloc_bytes: 3, peak_bytes: 2 });
        assert_eq!(RECORDED.load(Relaxed), before + 1, "a full-mode span is written to the profile file");
        disable();
        FORCED_OFF.store(false, Relaxed);
        let dur = enable_at(1000, Mode::Full, 500);
        assert_eq!(dur, 500);
        assert!(active());
        assert_eq!(mode_at(1499), Mode::Full, "inside the window");
        assert_eq!(mode_at(1500), Mode::Off, "the window ended: back to the baseline");
        assert!(!active());
        apply_config("sample");
        enable_at(0, Mode::Full, 100);
        assert_eq!(mode_at(200), Mode::Sample, "a window falls back to the configured baseline, not to off");
        let capped = enable_at(0, Mode::Full, u64::MAX / 2);
        assert_eq!(capped, defaults::num("diagnostics.profile_max_secs") * 1000, "a long --for is cut to the configured limit");
        assert_eq!(parse_duration("2m"), Some(120_000));
        assert_eq!(parse_duration("90"), Some(90_000));
        assert_eq!(parse_duration("1500ms"), Some(1500));
        assert_eq!(parse_duration("soon"), None);
        assert_eq!(parse_duration("5x"), None);
        disable();
        apply_config("full");
        assert!(!active(), "a config load does not undo an explicit off");
        FORCED_OFF.store(false, Relaxed);
        apply_config("off");
        assert!(!active());
    }
}
