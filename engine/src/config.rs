//! Tunables, all overridable by `ANTIHALL_ENGINE_*` env vars (tests shrink them to exercise limits fast).
use std::time::Duration;

fn num(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
}

/// Daemon-side limits.
#[derive(Debug, Clone)]
pub struct Config {
    /// Worker threads evaluating requests.
    pub workers: usize,
    /// Max connections waiting for a worker; beyond this the daemon answers BUSY.
    pub queue: usize,
    /// Max request bytes (larger -> ERR, the client falls back to Node).
    pub max_request: u64,
    /// Total time a client has to deliver its request.
    pub read_deadline: Duration,
    /// Time to write a reply.
    pub write_deadline: Duration,
    /// Per-request thread-CPU budget for rule evaluation, in microseconds.
    pub eval_budget_us: u64,
    /// Address-space/data limit applied with setrlimit, in MB (0 = none).
    pub mem_mb: u64,
    /// Resident-set cap in KB; above it the daemon drains and exits cleanly (0 = none).
    pub rss_cap_kb: u64,
    pub rss_check: Duration,
    /// Watchdog: a worker busy longer than this, or an accept loop silent longer than `stall`, trips a drain+exit.
    pub stuck: Duration,
    pub stall: Duration,
    pub watchdog_tick: Duration,
    /// `nice` increment for the daemon process.
    pub nice: i32,
    /// Token buckets: requests/second and burst, per session and per project.
    pub session_rps: f64,
    pub session_burst: f64,
    pub project_rps: f64,
    pub project_burst: f64,
    /// Test-only control verbs (`CTL sleep`, `CTL stall`); never on unless this env is set.
    pub test_hooks: bool,
}

impl Config {
    pub fn from_env() -> Config {
        Config {
            workers: num("ANTIHALL_ENGINE_WORKERS", 4).clamp(1, 32) as usize,
            queue: num("ANTIHALL_ENGINE_QUEUE", 16).clamp(1, 1024) as usize,
            max_request: num("ANTIHALL_ENGINE_MAX_REQUEST", MAX_REQUEST),
            read_deadline: Duration::from_millis(num("ANTIHALL_ENGINE_READ_MS", 1000)),
            write_deadline: Duration::from_millis(num("ANTIHALL_ENGINE_WRITE_MS", 1000)),
            eval_budget_us: num("ANTIHALL_ENGINE_EVAL_BUDGET_US", 200_000),
            mem_mb: num("ANTIHALL_ENGINE_MEM_MB", 64),
            rss_cap_kb: num("ANTIHALL_ENGINE_RSS_CAP_KB", 48 * 1024),
            rss_check: Duration::from_millis(num("ANTIHALL_ENGINE_RSS_CHECK_MS", 10_000)),
            stuck: Duration::from_millis(num("ANTIHALL_ENGINE_STUCK_MS", 8000)),
            stall: Duration::from_millis(num("ANTIHALL_ENGINE_STALL_MS", 5000)),
            watchdog_tick: Duration::from_millis(num("ANTIHALL_ENGINE_WATCHDOG_TICK_MS", 250)),
            nice: num("ANTIHALL_ENGINE_NICE", 5).min(19) as i32,
            session_rps: num("ANTIHALL_ENGINE_SESSION_RPS", 50) as f64,
            session_burst: num("ANTIHALL_ENGINE_SESSION_BURST", 200) as f64,
            project_rps: num("ANTIHALL_ENGINE_PROJECT_RPS", 100) as f64,
            project_burst: num("ANTIHALL_ENGINE_PROJECT_BURST", 400) as f64,
            test_hooks: std::env::var_os("ANTIHALL_ENGINE_TEST_HOOKS").is_some(),
        }
    }
}

/// Request size cap shared by client and daemon (the client sends nothing larger; it falls back instead).
pub const MAX_REQUEST: u64 = 1024 * 1024;

/// Client-side limits.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Overall deadline for one engine exchange (connect + write + read).
    pub deadline: Duration,
    /// Breaker: `n` engine failures within `window` skip the engine for `cooldown`.
    pub breaker_n: usize,
    pub breaker_window: Duration,
    pub breaker_cooldown: Duration,
    /// Crash-loop: `n` daemon deaths within `window` stop respawning for `cooldown`.
    pub crash_n: usize,
    pub crash_window: Duration,
    pub crash_cooldown: Duration,
    /// Node fallback hook is killed after this long (then plain allow: it is unavailable).
    pub fallback_timeout: Duration,
}

impl ClientConfig {
    pub fn from_env() -> ClientConfig {
        let s = |n: &str, d: u64| Duration::from_secs(num(n, d));
        ClientConfig {
            deadline: Duration::from_millis(num("ANTIHALL_ENGINE_DEADLINE_MS", 2000)),
            breaker_n: num("ANTIHALL_ENGINE_BREAKER_N", 5).max(1) as usize,
            breaker_window: s("ANTIHALL_ENGINE_BREAKER_WINDOW_S", 60),
            breaker_cooldown: s("ANTIHALL_ENGINE_BREAKER_COOLDOWN_S", 60),
            crash_n: num("ANTIHALL_ENGINE_CRASH_N", 4).max(1) as usize,
            crash_window: s("ANTIHALL_ENGINE_CRASH_WINDOW_S", 600),
            crash_cooldown: s("ANTIHALL_ENGINE_CRASH_COOLDOWN_S", 1800),
            fallback_timeout: Duration::from_millis(num("ANTIHALL_ENGINE_FALLBACK_MS", 8000)),
        }
    }
}
