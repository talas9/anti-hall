//! One `hivecontrol workspace monitor` call and what a failure of it means: `defaultMonitorRunAsync`, the circuit breaker
//! (`createMonitorBreaker`) with its backoff ladders, and the hivecontrol binary resolution of `companion/devswarm-ingest.js`.
//!
//! The call is a bounded subprocess: `-i <interval> -t <timeout>` makes hivecontrol long-poll and exit, and a hard limit a
//! margin beyond that kills a child that does not honour its own timeout (only the engine's own child). What the child printed
//! before it was killed is KEPT (the read is destructive: those messages are already off the native queue). A non-zero exit
//! with no spawn error is still a successful poll, as in Node. A missing or non-executable binary is a CONFIGURATION fault:
//! the breaker escalates its backoff instead of hammering it every few seconds.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a cache file that is absent or unparsable is "no cached path" (Node: `catch (_) { return null }`)
use crate::checks::git::util::Settings;
use crate::defaults;
use crate::dsact::runner::{RunResult, RunSpec, Runner};
use std::path::Path;

/// The resolved hivecontrol executable and where it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Hc {
    /// The executable (a bare name is resolved by the OS on the daemon's PATH).
    pub bin: String,
    /// `env` (the unit's baked variable), `cache` (the path cache the installer writes) or `path`.
    pub source: String,
}

/// Option (the setting), then the environment variable, then the path cache, then the configured bare name.
pub fn resolve_hc(st: &Settings, devswarm_root: &Path) -> Hc {
    let env = st.env.get(defaults::text("devswarm_ingest.env_hivecontrol")).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if let Some(bin) = env {
        return Hc { bin, source: defaults::text("devswarm_ingest.src_env").to_string() };
    }
    let cached = std::fs::read_to_string(devswarm_root.join(defaults::text("devswarm_ingest.hc_cache")))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v[defaults::text("devswarm_ingest.hc_cache_key")].as_str().map(str::to_string))
        .filter(|p| Path::new(p).is_file());
    if let Some(bin) = cached {
        return Hc { bin, source: defaults::text("devswarm_ingest.src_cache").to_string() };
    }
    Hc { bin: defaults::text("devswarm_act.hc_bin").to_string(), source: defaults::text("devswarm_ingest.src_path").to_string() }
}

/// `hivecontrolBinUsable`: `Some(false)` only for an ABSOLUTE path that is not a file; a bare name is unknown until tried.
pub fn usable(hc: &Hc) -> Option<bool> {
    Path::new(&hc.bin).is_absolute().then(|| Path::new(&hc.bin).is_file())
}

/// The outcome of one monitor call.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Poll {
    /// False for a spawn failure or a hard-timeout kill; a non-zero exit is still `true`.
    pub ok: bool,
    /// Everything the child printed (kept even when it was killed).
    pub raw: String,
    /// Why it failed, or the stderr tail of a non-zero exit.
    pub error: Option<String>,
    /// `ENOENT`, `EACCES`, `ENOTDIR` (configuration faults) or `ETIMEDOUT`.
    pub code: Option<String>,
    /// More was printed than could be kept: the excess is unrecoverable.
    pub truncated: bool,
}

/// Run ONE monitor call in `cwd` (the project's main worktree), with the workspace-identity variables scrubbed from the
/// environment so the call acts as the project, never as a workspace the daemon happened to be started from.
pub fn poll(runner: &dyn Runner, hc: &Hc, cwd: &str, interval_sec: u64, timeout_sec: u64, hard_ms: u64) -> Poll {
    let mut args: Vec<String> = defaults::list("devswarm_ingest.monitor_args").iter().map(|s| (*s).to_string()).collect();
    args.extend([defaults::text("devswarm_ingest.flag_interval").to_string(), interval_sec.to_string()]);
    args.extend([defaults::text("devswarm_ingest.flag_timeout").to_string(), timeout_sec.to_string()]);
    let r: RunResult = runner.run(&RunSpec {
        bin: Some(hc.bin.clone()),
        args,
        cwd: Some(cwd.to_string()),
        timeout_ms: hard_ms,
        cap_bytes: defaults::num("devswarm_ingest.output_cap_bytes"),
        scrub_env: defaults::list("devswarm_ingest.scrub_env_prefixes").iter().map(|s| (*s).to_string()).collect(),
    });
    if r.missing || (!r.timed_out && r.status.is_none() && r.error.is_some()) {
        let text = r.error.clone().unwrap_or_default();
        let code = defaults::raw("devswarm_ingest.spawn_error_codes")
            .as_array()
            .unwrap_or_default()
            .iter()
            .find(|e| text.contains(e.str_field("text")))
            .map(|e| e.str_field("code").to_string());
        return Poll {
            ok: false,
            raw: r.stdout,
            error: Some(defaults::render("devswarm_ingest.msg_spawn_failed", &[("bin", &hc.bin), ("code", &code.clone().unwrap_or_else(|| text.clone()))])),
            code,
            truncated: r.truncated,
        };
    }
    if r.timed_out {
        return Poll {
            ok: false,
            raw: r.stdout,
            error: Some(defaults::render("devswarm_ingest.msg_timeout", &[("bin", &hc.bin), ("ms", &hard_ms)])),
            code: Some(defaults::text("devswarm_ingest.code_timeout").to_string()),
            truncated: r.truncated,
        };
    }
    let error = (r.status != Some(0)).then(|| {
        let tail = r.stderr.trim();
        let keep: String = tail.chars().rev().take(defaults::num("devswarm_ingest.stderr_tail_chars") as usize).collect::<Vec<_>>().into_iter().rev().collect();
        if keep.is_empty() {
            defaults::render("devswarm_ingest.msg_exit_no_stderr", &[("bin", &hc.bin), ("status", &r.status.map_or("?".to_string(), |s| s.to_string()))])
        } else {
            defaults::render(
                "devswarm_ingest.msg_exit_stderr",
                &[("bin", &hc.bin), ("status", &r.status.map_or("?".to_string(), |s| s.to_string())), ("tail", &keep)],
            )
        }
    });
    Poll { ok: true, raw: r.stdout, error, code: None, truncated: r.truncated }
}

/// What the breaker decided about a failure.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// A configuration fault (retrying cannot fix it).
    pub permanent: bool,
    /// The fault code, for a permanent one.
    pub code: Option<String>,
    /// How long to wait before the next call.
    pub backoff_ms: u64,
    /// Consecutive failures of this kind.
    pub consecutive: u64,
    /// A line for the log, when this failure is one worth logging (a state change or the periodic rollup).
    pub log: Option<String>,
}

/// The circuit breaker of the monitor loop.
#[derive(Debug, Default)]
pub struct Breaker {
    base_ms: u64,
    consecutive: u64,
    signature: Option<String>,
    permanent: bool,
    step: Option<usize>,
    first_at: i64,
    last_log_at: Option<i64>,
    since_log: u64,
    /// When the last successful call completed.
    pub last_ok_ms: Option<i64>,
}

fn permanent_steps() -> Vec<f64> {
    defaults::list("devswarm_ingest.permanent_steps").iter().filter_map(|s| s.parse().ok()).collect()
}

impl Breaker {
    /// A breaker whose backoffs scale from `base_ms`.
    pub fn new(base_ms: u64) -> Breaker {
        Breaker { base_ms, ..Breaker::default() }
    }

    fn transient_backoff(&self) -> u64 {
        let n = self.consecutive.max(1).min(defaults::num("devswarm_ingest.backoff_shift_max") + 1);
        self.base_ms.saturating_mul(1u64 << (n - 1)).min(defaults::num("devswarm_ingest.transient_cap_ms"))
    }

    fn permanent_backoff(&self) -> u64 {
        let steps = permanent_steps();
        let idx = (self.consecutive.max(1) as usize - 1).min(steps.len().saturating_sub(1));
        ((self.base_ms as f64 * steps.get(idx).copied().unwrap_or(1.0)).round() as u64).min(defaults::num("devswarm_ingest.permanent_cap_ms"))
    }

    /// A failed call at `now`.
    pub fn on_failure(&mut self, poll: &Poll, now: i64) -> Verdict {
        let permanent_codes = defaults::list("devswarm_ingest.permanent_codes");
        let code = poll.code.clone().filter(|c| permanent_codes.contains(&c.as_str()));
        let message = poll.error.clone().unwrap_or_else(|| defaults::text("devswarm_ingest.msg_no_detail").to_string());
        let permanent = code.is_some();
        let signature = format!("{}\u{0}{}", code.clone().unwrap_or_default(), if permanent { String::new() } else { message.clone() });
        if !permanent {
            // transient: one log line per occurrence, exponential backoff; it also resets any permanent run
            self.consecutive = if self.signature.as_deref() == Some(&signature) { self.consecutive + 1 } else { 1 };
            if self.consecutive == 1 {
                self.first_at = now;
            }
            self.signature = Some(signature);
            self.permanent = false;
            self.step = None;
            return Verdict {
                permanent: false,
                code: None,
                backoff_ms: self.transient_backoff(),
                consecutive: self.consecutive,
                log: Some(defaults::render("devswarm_ingest.msg_log_transient", &[("error", &message)])),
            };
        }
        let same_run = self.permanent && self.signature.as_deref() == Some(&signature);
        self.consecutive = if same_run { self.consecutive + 1 } else { 1 };
        self.signature = Some(signature);
        self.permanent = true;
        if !same_run {
            self.first_at = now;
            self.last_log_at = None;
            self.step = None;
            self.since_log = 0;
        }
        self.since_log += 1;
        let backoff_ms = self.permanent_backoff();
        let step = (self.consecutive as usize - 1).min(permanent_steps().len().saturating_sub(1));
        let transitioned = self.step != Some(step);
        let rollup_due = !transitioned && self.last_log_at.is_some_and(|t| now - t >= defaults::num("devswarm_ingest.rollup_ms") as i64);
        self.step = Some(step);
        let log = (transitioned || rollup_due).then(|| {
            self.last_log_at = Some(now);
            let n = std::mem::take(&mut self.since_log);
            defaults::render(
                "devswarm_ingest.msg_log_permanent",
                &[("code", &code.clone().unwrap_or_default()), ("n", &self.consecutive), ("since", &n), ("backoff", &backoff_ms), ("error", &message)],
            )
        });
        Verdict { permanent: true, code, backoff_ms, consecutive: self.consecutive, log }
    }

    /// A successful call at `now`. Returns a log line when it ends a run of configuration failures.
    pub fn on_success(&mut self, now: i64) -> Option<String> {
        let (was_permanent, count) = (self.permanent, self.consecutive);
        *self = Breaker { base_ms: self.base_ms, last_ok_ms: Some(now), ..Breaker::default() };
        (was_permanent && count > 0).then(|| defaults::render("devswarm_ingest.msg_log_recovered", &[("n", &count)]))
    }
}
