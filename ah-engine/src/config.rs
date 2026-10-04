//! Tunables, all overridable by `AH_ENGINE_*` env vars (tests shrink them to exercise limits fast).
use std::time::Duration;

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
    /// How often the watchdog samples resident memory.
    pub rss_check: Duration,
    /// Watchdog: a worker busy longer than this, or an accept loop silent longer than `stall`, trips a drain+exit.
    pub stuck: Duration,
    /// An accept loop silent for longer than this trips a drain and exit.
    pub stall: Duration,
    /// How often the watchdog thread wakes to look at heartbeats.
    pub watchdog_tick: Duration,
    /// `nice` increment for the daemon process.
    pub nice: i32,
    /// Token buckets: requests/second and burst, per session and per project.
    pub session_rps: f64,
    /// Token-bucket burst per session.
    pub session_burst: f64,
    /// Sustained requests per second allowed per project.
    pub project_rps: f64,
    /// Token-bucket burst per project.
    pub project_burst: f64,
    /// Idle time after which the daemon exits; `None` keeps it resident (D7).
    pub idle_exit: Option<Duration>,
    /// Test-only control verbs (`CTL sleep`, `CTL stall`); never on unless the `test_hooks` env var is set.
    pub test_hooks: bool,
}

impl Config {
    /// Read the limits from the shipped defaults, applying any `AH_ENGINE_*` overrides.
    pub fn from_env() -> Config {
        use crate::defaults::{millis, num};
        Config {
            workers: num("daemon.workers") as usize,
            queue: num("daemon.queue") as usize,
            max_request: num("daemon.max_request"),
            read_deadline: millis("daemon.read_ms"),
            write_deadline: millis("daemon.write_ms"),
            eval_budget_us: num("daemon.eval_budget_us"),
            mem_mb: num("daemon.mem_mb"),
            rss_cap_kb: num("daemon.rss_cap_kb"),
            rss_check: millis("daemon.rss_check_ms"),
            stuck: millis("daemon.stuck_ms"),
            stall: millis("daemon.stall_ms"),
            watchdog_tick: millis("daemon.watchdog_tick_ms"),
            nice: num("daemon.nice") as i32,
            session_rps: num("daemon.session_rps") as f64,
            session_burst: num("daemon.session_burst") as f64,
            project_rps: num("daemon.project_rps") as f64,
            project_burst: num("daemon.project_burst") as f64,
            idle_exit: match num("daemon.idle_exit_s") {
                0 => None,
                s => Some(Duration::from_secs(s)),
            },
            test_hooks: crate::defaults::env_var("test_hooks").is_some(),
        }
    }
}

/// Client-side limits.
#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Overall deadline for one engine exchange (connect + write + read).
    pub deadline: Duration,
    /// Breaker: `n` engine failures within `window` skip the engine for `cooldown`.
    pub breaker_n: usize,
    /// Window in which failures are counted toward the breaker.
    pub breaker_window: Duration,
    /// How long the breaker stays open once tripped.
    pub breaker_cooldown: Duration,
    /// Crash-loop: `n` daemon deaths within `window` stop respawning for `cooldown`.
    pub crash_n: usize,
    /// Window in which daemon deaths are counted.
    pub crash_window: Duration,
    /// How long respawning stays stopped after a crash loop.
    pub crash_cooldown: Duration,
    /// Node fallback hook is killed after this long (then plain allow: it is unavailable).
    pub fallback_timeout: Duration,
}

impl ClientConfig {
    /// Read the client limits from the shipped defaults, applying any `AH_ENGINE_*` overrides.
    pub fn from_env() -> ClientConfig {
        use crate::defaults::{millis, num, secs};
        ClientConfig {
            deadline: millis("client.deadline_ms"),
            breaker_n: num("client.breaker_n") as usize,
            breaker_window: secs("client.breaker_window_s"),
            breaker_cooldown: secs("client.breaker_cooldown_s"),
            crash_n: num("client.crash_n") as usize,
            crash_window: secs("client.crash_window_s"),
            crash_cooldown: secs("client.crash_cooldown_s"),
            fallback_timeout: millis("client.fallback_ms"),
        }
    }
}
