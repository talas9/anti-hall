//! `CTL pulse`: the engine's vital signs from atomics and one cheap `getloadavg`, for the dashboard header chips. The daemon fills
//! [`Inputs`] from its own counters; nothing here takes a lock, reads a file or does a scan.
use serde_json::{Value, json};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};

/// What the daemon reads from its own atomics.
pub struct Inputs<'a> {
    /// This build's version.
    pub version: &'a str,
    /// The version of the plugin the daemon serves (its manifest at the loaded root); empty when unreadable.
    pub plugin_version: &'a str,
    /// The build version the hook client last reported with a request; empty before the first one.
    pub hook_version: &'a str,
    /// Seconds since the daemon started.
    pub uptime_s: u64,
    /// Resident set, KB.
    pub rss_kb: u64,
    /// Physical footprint, KB: the figure the memory budget is measured on (`None` where the platform will not say).
    pub footprint_kb: Option<u64>,
    /// Process CPU time, seconds.
    pub cpu_s: f64,
    /// Requests handled.
    pub requests: u64,
    /// Requests answered BUSY.
    pub busy_replies: u64,
    /// Replies sent after the client's deadline.
    pub slow_replies: u64,
    /// Requests that failed.
    pub errors: u64,
    /// Handler panics contained.
    pub panics: u64,
    /// Connections waiting for a worker.
    pub queue_depth: u64,
    /// Workers in the pool.
    pub workers: u64,
    /// Bit 0: CPU budget breached, bit 1: memory budget breached.
    pub budget_mask: u64,
    /// Daemon starts before this one.
    pub restarts: u64,
    /// The version of the active config snapshot.
    pub config_version: u64,
}

/// First 8 hex digits of the SHA-256 of the running executable (the figure the deploy kit verifies), read once.
fn build_sha() -> &'static str {
    static SHA: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SHA.get_or_init(|| {
        let Some(bytes) = std::env::current_exe().ok().and_then(|p| std::fs::read(p).ok()) else { return String::new() };
        ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref().iter().take(crate::defaults::num("web.build_sha_bytes") as usize).map(|b| format!("{b:02x}")).collect()
    })
}

static PREV_CPU_US: AtomicU64 = AtomicU64::new(0);
static PREV_AT_MS: AtomicU64 = AtomicU64::new(0);

/// The pulse document. `cpu_permille` is the process CPU since the previous pulse, as parts per thousand of one core.
pub fn build(i: &Inputs<'_>) -> Value {
    let (now, cpu_us) = (crate::health::now_ms(), (i.cpu_s * 1_000_000.0) as u64);
    let (prev_at, prev_cpu) = (PREV_AT_MS.swap(now, Relaxed), PREV_CPU_US.swap(cpu_us, Relaxed));
    let cpu_permille = if prev_at == 0 || now <= prev_at { Value::Null } else { json!(cpu_us.saturating_sub(prev_cpu) / (now - prev_at)) };
    let mut load = [0f64; 1];
    // SAFETY: getloadavg fills at most the number of doubles asked for, and the array holds that many.
    let got = unsafe { libc::getloadavg(load.as_mut_ptr(), 1) };
    let cores = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
    json!({"version": i.version, "plugin_version": i.plugin_version, "hook_version": i.hook_version, "build_sha": build_sha(), "pid": std::process::id(), "uptime_s": i.uptime_s, "rss_kb": i.rss_kb, "footprint_kb": i.footprint_kb, "cpu_s": i.cpu_s, "cpu_permille": cpu_permille,
        "requests": i.requests, "busy_replies": i.busy_replies, "slow_replies": i.slow_replies, "errors": i.errors, "panics": i.panics,
        "queue_depth": i.queue_depth, "workers": i.workers, "budget_mask": i.budget_mask, "restarts": i.restarts, "config_version": i.config_version,
        "load_per_core": (got >= 1).then(|| load[0] / cores), "at_ms": now})
}
