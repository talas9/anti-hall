//! `ah-engine refresh [--force] [--home <dir>] [--json]` (v1.0 lane L06): the native refresh of the session caches that the
//! detached Node refresh scripts used to write, and the reload repair that `hooks/repair-on-reload.js` used to start detached.
//!
//! The decision stays in plugin JavaScript (D88): a SessionStart check that finds its cache stale (or a repair due) writes a
//! request file under `refresh.request_dir` and answers silently, exactly what its Node twin printed that session. This module
//! only executes requests, each as a bounded subprocess (own process group, killed at its timeout), and writes the cache in
//! the layout the Node refresh script wrote:
//!
//! | probe | does | writes (under the home directory) |
//! |---|---|---|
//! | `version` | `git ls-remote --tags <remote>`, then `origin` inside the marketplace clone; the highest release tag | `session.version_check_file`: `{latest, checkedAt}` (nothing when no source answered) |
//! | `claude_cli` / `devswarm` | `<bin> --version` for each configured bin until one names exactly one version | `session.claude_cli_cache` / `session.devswarm_cache`: `{installed, baseline, checkedAt, source}` |
//! | `repair` | re-checks the cooldown, takes the Node repair lock, runs `ah-engine doctor --repair --migrations-only --quiet` | the cooldown record `{ts, version}` once the repair started |
//!
//! Every action leaves one event-log line (`refresh.msg_action`: action id, probe, target, outcome, reason, latency) and one
//! telemetry `cmd` event. Requests are never deleted: the job records the newest request it handled per probe. Every
//! path, program, argument, pattern, limit and text is in `engine/defaults/refresh.toml` (and the `session.*` keys the
//! checks already read).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as the Node refresh scripts' try/catch)
// - a probe that cannot start or times out answers nothing (the Node scripts treat `r.error` the same way)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::nodelock::{self, Params};
use crate::cli::Parsed;
use crate::defaults;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// One handled (or skipped) probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    /// The probe name.
    pub probe: String,
    /// `refresh.outcome_*`.
    pub outcome: String,
    /// `refresh.reason_*`.
    pub reason: String,
    /// The file the action wrote (or the program it ran).
    pub target: String,
    /// Wall-clock milliseconds the action took.
    pub ms: u64,
}

/// The `refresh` command.
pub fn run_cmd(p: &Parsed) -> i32 {
    let force = p.rest.iter().any(|a| a == "--force");
    let home = flag(&p.rest, "--home").or_else(|| defaults::env_var("home")).filter(|h| !h.is_empty());
    let Some(home) = home else {
        eprintln!("{}", defaults::text("refresh.msg_no_home"));
        return 1;
    };
    let out = match run(Path::new(&home), force) {
        Some(done) => done,
        None => {
            let busy = defaults::text("refresh.msg_busy");
            if p.json {
                println!("{}", json!({"busy": true, "detail": busy}));
            } else {
                println!("{busy}");
            }
            return 0;
        }
    };
    if p.json {
        let rows: Vec<Value> = out.iter().map(|d| json!({"probe": d.probe, "outcome": d.outcome, "reason": d.reason, "target": d.target, "ms": d.ms})).collect();
        println!("{}", json!({"probes": rows}));
    } else {
        for d in &out {
            println!("{}", line(d, ""));
        }
    }
    0
}

fn flag(rest: &[String], name: &str) -> Option<String> {
    rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).cloned()
}

/// Handle every probe once under the run lock. `None` when another run holds the lock.
pub fn run(home: &Path, force: bool) -> Option<Vec<Done>> {
    let dir = home.join(defaults::text("refresh.request_dir"));
    crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the lock and record writes below fail and say so
    let lock_path = dir.join(defaults::text("refresh.lock_file"));
    let held = nodelock::acquire(&lock_path.to_string_lossy(), lock_params(defaults::num("refresh.lock_stale_ms"), false))?;
    let handled_path = dir.join(defaults::text("refresh.handled_file"));
    let mut handled = read_object(&handled_path).unwrap_or_default();
    let mut out = vec![];
    for probe in defaults::list("refresh.probes") {
        let req = read_object(&dir.join(format!("{probe}{}", defaults::text("refresh.request_ext"))));
        let at = req.as_ref().and_then(|r| r.get("requestedAt")).and_then(Value::as_f64).filter(|v| v.is_finite());
        let last = handled.get(probe).and_then(Value::as_f64).unwrap_or(f64::NEG_INFINITY);
        let pending = at.is_some_and(|a| a > last);
        let is_repair = probe == "repair";
        if !(pending || (force && !is_repair)) {
            out.push(Done { probe: probe.into(), outcome: defaults::text("refresh.outcome_skipped").into(), reason: String::new(), target: String::new(), ms: 0 });
            continue;
        }
        let reason = if pending { defaults::text("refresh.reason_requested") } else { defaults::text("refresh.reason_forced") };
        let started = Instant::now();
        let (outcome, why, target, mark) = match probe {
            "version" => probe_version(home),
            "claude_cli" => probe_cli(home, defaults::list("refresh.claude_cli_bins"), defaults::text("session.claude_cli_cache"), defaults::text("session.claude_cli_baseline")),
            "devswarm" => probe_cli(home, defaults::list("refresh.devswarm_bins"), defaults::text("session.devswarm_cache"), defaults::text("session.devswarm_baseline")),
            "repair" => repair(home, req.as_ref()),
            _ => continue,
        };
        let done = Done { probe: probe.into(), outcome: outcome.into(), reason: if why.is_empty() { reason.into() } else { why }, target, ms: started.elapsed().as_millis() as u64 };
        record(&done);
        if mark && let Some(a) = at {
            handled.insert(probe.to_string(), json!(a));
        }
        out.push(done);
    }
    crate::discard::harmless(write_file(&handled_path, &Value::Object(handled).to_string())); // keep: an unwritten record repeats the probe next tick, nothing worse
    held.release(); // a lock not released (no longer ours, or gone) is left alone; one left behind goes stale and is taken over
    Some(out)
}

fn lock_params(stale_ms: u64, steal_dead: bool) -> Params {
    Params {
        stale_ms,
        wait_ms: defaults::num("refresh.lock_wait_ms"),
        step_ms: defaults::num("refresh.lock_step_ms"),
        reclaim_stale_ms: defaults::num("refresh.lock_reclaim_stale_ms"),
        release_tries: defaults::num("refresh.lock_release_tries"),
        release_step_ms: defaults::num("refresh.lock_release_step_ms"),
        boot_slop_s: defaults::num("refresh.lock_boot_slop_s"),
        steal_dead,
    }
}

/// The event-log line (and the text output) of one action.
fn line(d: &Done, id: &str) -> String {
    defaults::render(
        "refresh.msg_action",
        &[("action_id", &id), ("probe", &d.probe), ("target", &d.target), ("outcome", &d.outcome), ("reason", &d.reason), ("ms", &d.ms)],
    )
}

/// Measure one action: an event-log line and a telemetry `cmd` event (exit 0 when it refreshed, 1 when it failed).
fn record(d: &Done) {
    let kind = defaults::text("refresh.log_kind");
    let id = format!("{kind}-{}-{}", d.probe, crate::health::now_ms());
    crate::health::log_event(kind, &d.outcome, &line(d, &id));
    let ok = d.outcome == defaults::text("refresh.outcome_refreshed");
    crate::telemetry::emit::event(crate::telemetry::emit::command_run(kind, &d.probe, i32::from(!ok), d.ms.saturating_mul(1000), u64::from(ok)));
}

/// A JSON object file no larger than `refresh.request_max_bytes`, or `None`.
fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > defaults::num("refresh.request_max_bytes") {
        return None;
    }
    match serde_json::from_slice::<Value>(&std::fs::read(path).ok()?).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn write_file(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    crate::atomic::write(path, text)
}

/// Run `prog args` (in `cwd` when given) within `timeout`: `(exit code, stdout, stderr)`, or `None` when it could not start,
/// ran past the timeout or its output could not be collected.
fn exec(prog: &str, args: &[&str], cwd: Option<&Path>, timeout: Duration) -> Option<(Option<i32>, String, String)> {
    let mut cmd = Command::new(prog);
    cmd.args(args);
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    let o = crate::proc::run(cmd, prog, timeout, defaults::millis("refresh.poll_ms")).ok()?;
    Some((o.status.code(), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned()))
}

fn failed(why: &str, target: String, mark: bool) -> (&'static str, String, String, bool) {
    (defaults::text("refresh.outcome_failed"), defaults::text(why).to_string(), target, mark)
}

/// The `version` probe (hooks/version-alert-refresh.js).
fn probe_version(home: &Path) -> (&'static str, String, String, bool) {
    let target = home.join(defaults::text("session.version_check_file"));
    let timeout = defaults::millis("refresh.probe_timeout_ms");
    let git = defaults::text("refresh.git_program");
    let ask = |remote: &str, cwd: Option<&Path>| {
        let mut args = defaults::list("refresh.tag_args");
        args.push(remote);
        exec(git, &args, cwd, timeout).filter(|(code, out, _)| *code == Some(0) && !out.is_empty()).map(|(_, out, _)| out)
    };
    let clone = home.join(defaults::text("session.marketplace_dir"));
    let output = ask(defaults::text("refresh.tag_remote"), None).or_else(|| if clone.is_dir() { ask(defaults::text("refresh.tag_fallback_remote"), Some(&clone)) } else { None });
    let shown = target.to_string_lossy().into_owned();
    let Some(output) = output else { return failed("refresh.reason_no_output", shown, true) };
    let Some(latest) = highest_tag(&output) else { return failed("refresh.reason_no_tag", shown, true) };
    let now = crate::health::now_ms();
    let text = format!("{{\"latest\":{},\"checkedAt\":{now}}}", Value::from(latest));
    match write_file(&target, &text) {
        Ok(()) => (defaults::text("refresh.outcome_refreshed"), String::new(), shown, true),
        Err(_) => failed("refresh.reason_write_failed", shown, true),
    }
}

/// `parseHighestTag`: the highest release tag in `git ls-remote --tags` output (the first of equals), or `None`.
pub fn highest_tag(output: &str) -> Option<String> {
    let re = Regex::new(defaults::text("refresh.tag_re")).ok()?;
    let mut best: Option<(String, [u64; 3])> = None;
    for raw in output.split('\n') {
        let l = raw.strip_suffix('\r').unwrap_or(raw);
        let Some(tag) = re.captures(l).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()) else { continue };
        let parts: Vec<u64> = tag.trim_start_matches('v').split('.').map(|n| n.parse::<u64>().unwrap_or(u64::MAX)).collect();
        let key = [parts.first().copied().unwrap_or(0), parts.get(1).copied().unwrap_or(0), parts.get(2).copied().unwrap_or(0)];
        if best.as_ref().is_none_or(|(_, b)| key > *b) {
            best = Some((tag, key));
        }
    }
    best.map(|(t, _)| t)
}

/// `extractVersion`: exactly one distinct full X.Y.Z token, else (no full token) exactly one distinct X.Y token, else `None`.
pub fn extract_version(text: &str) -> Option<String> {
    if text.is_empty() {
        return None;
    }
    for pattern in [defaults::text("refresh.full_version_re"), defaults::text("refresh.partial_version_re")] {
        let re = Regex::new(pattern).ok()?;
        let mut seen: Vec<String> = vec![];
        for c in re.captures_iter(text) {
            if let Some(m) = c.get(1)
                && !seen.iter().any(|s| s == m.as_str())
            {
                seen.push(m.as_str().to_string());
            }
        }
        match seen.len() {
            0 => continue,
            1 => return seen.pop(),
            _ => return None,
        }
    }
    None
}

/// A CLI version probe (hooks/claude-cli-version-refresh.js, hooks/devswarm-version-refresh.js): always writes the cache,
/// with `installed: null` when no bin answered.
fn probe_cli(home: &Path, bins: Vec<&str>, cache: &str, baseline: &str) -> (&'static str, String, String, bool) {
    let target = home.join(cache);
    let timeout = defaults::millis("refresh.probe_timeout_ms");
    let mut found: Option<(String, &str)> = None;
    for bin in bins {
        let Some((_, out, err)) = exec(bin, &[defaults::text("refresh.version_arg")], None, timeout) else { continue };
        if let Some(v) = extract_version(&out).or_else(|| extract_version(&err)) {
            found = Some((v, bin));
            break;
        }
    }
    let now = crate::health::now_ms();
    let (installed, source) = match &found {
        Some((v, b)) => (Value::from(v.as_str()), Value::from(*b)),
        None => (Value::Null, Value::Null),
    };
    let text = format!("{{\"installed\":{installed},\"baseline\":{},\"checkedAt\":{now},\"source\":{source}}}", Value::from(baseline));
    let shown = target.to_string_lossy().into_owned();
    match write_file(&target, &text) {
        Ok(()) => (defaults::text("refresh.outcome_refreshed"), String::new(), shown, true),
        Err(_) => failed("refresh.reason_write_failed", shown, true),
    }
}

/// The reload repair (hooks/repair-on-reload.js past its gates): the request names the running `version` and, when known,
/// the `pluginRoot`. A held repair lock leaves the request pending for the next tick.
fn repair(home: &Path, req: Option<&Map<String, Value>>) -> (&'static str, String, String, bool) {
    let ah_dir = home.join(defaults::text("session_gates.anti_hall_dir"));
    let cooldown = ah_dir.join(defaults::text("repair_reload.cooldown_file"));
    let version = req.and_then(|r| r.get("version")).and_then(Value::as_str).unwrap_or_default().to_string();
    let shown = cooldown.to_string_lossy().into_owned();
    let now = crate::health::now_ms();
    // live re-check of the cooldown the check already read
    if let Some(last) = read_object(&cooldown)
        && last.get("version").and_then(Value::as_str) == Some(version.as_str())
        && let Some(ts) = last.get("ts").and_then(Value::as_f64).filter(|t| t.is_finite())
    {
        let age = now as f64 - ts;
        if age >= 0.0 && age < defaults::num("repair_reload.cooldown_ms") as f64 {
            return (defaults::text("refresh.outcome_skipped"), defaults::text("refresh.reason_cooldown").into(), shown, true);
        }
    }
    let lock = ah_dir.join(defaults::text("refresh.repair_lock_file"));
    let Some(held) = nodelock::acquire(&lock.to_string_lossy(), lock_params(defaults::num("refresh.repair_lock_stale_ms"), true)) else {
        return failed("refresh.reason_locked", shown, false);
    };
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    let home_s = home.to_string_lossy().into_owned();
    let mut args: Vec<&str> = defaults::list("refresh.repair_args");
    args.extend(["--home", home_s.as_str()]);
    let root = req.and_then(|r| r.get("pluginRoot")).and_then(Value::as_str).filter(|s| !s.is_empty() && Path::new(s).is_absolute());
    if let Some(r) = root {
        args.extend(["--plugin-root", r]);
    }
    let mut cmd = Command::new(&exe);
    cmd.args(&args);
    let ran = crate::proc::run(cmd, &exe, defaults::millis("refresh.repair_timeout_ms"), defaults::millis("refresh.poll_ms"));
    let started = !matches!(ran, Err(crate::proc::Error::Spawn(_)));
    if started {
        // Node stamps the cooldown once the repair started, whatever it does next
        crate::discard::harmless(write_file(&cooldown, &format!("{{\"ts\":{now},\"version\":{}}}", Value::from(version.as_str())))); // keep: an unstamped cooldown only allows an earlier retry
    }
    held.release(); // a lock not released (no longer ours, or gone) is left alone; one left behind goes stale and is taken over
    match ran {
        Ok(o) if o.status.success() => (defaults::text("refresh.outcome_refreshed"), String::new(), shown, true),
        _ => failed("refresh.reason_exit", shown, started),
    }
}

/// Where a check's request for `probe` lives (tests and tooling).
pub fn request_path(home: &Path, probe: &str) -> PathBuf {
    home.join(defaults::text("refresh.request_dir")).join(format!("{probe}{}", defaults::text("refresh.request_ext")))
}

#[cfg(test)]
mod tests;
