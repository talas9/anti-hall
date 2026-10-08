//! Engine health state, all inside the engine's own state dir (`paths::dir()`): the event log, the
//! client circuit breaker, crash-loop protection, failure classification and the once-per-session
//! advisory. Every function is best-effort: a state-dir problem must never break a hook call.
use crate::config::ClientConfig;
use crate::defaults;
use crate::paths;
use regex::Regex;
use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

/// File name of the event log inside the state directory.
pub fn log_name() -> &'static str {
    defaults::text("files.log")
}

/// Event kinds that count toward the crash-loop threshold.
fn crashy() -> Vec<&'static str> {
    defaults::list("health.crashy_kinds")
}

/// Milliseconds since the Unix epoch (0 if the clock is before it).
pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A file inside the state directory, named by the `files.<key>` setting.
fn state_file(key: &str) -> PathBuf {
    file(defaults::text(&format!("files.{key}")))
}

fn file(name: &str) -> PathBuf {
    paths::dir().join(name)
}

fn clean(s: &str) -> String {
    s.chars().map(|c| if c == '\n' || c == '\t' || c == '\r' { ' ' } else { c }).take(defaults::num("health.event_text_max") as usize).collect()
}

// ---- event log ---------------------------------------------------------------------------------

/// One line of the event log.
#[derive(Debug, Clone)]
pub struct Event {
    /// When it happened (ms since the epoch).
    pub ts: u64,
    /// Event kind, e.g. `start`, `watchdog`.
    pub kind: String,
    /// Stable error code, `-` when not applicable.
    pub code: String,
    /// Free text, newlines removed.
    pub detail: String,
}

fn event_line(kind: &str, code: &str, detail: &str) -> String {
    format!("{}\t{}\t{}\t{}\n", now_ms(), clean(kind), clean(code), clean(detail))
}

fn append_event_line(line: &str) -> bool {
    let p = file(log_name());
    if std::fs::metadata(&p).map(|m| m.len() > defaults::num("health.log_cap")).unwrap_or(false)
        && let Ok(t) = std::fs::read_to_string(&p)
    {
        let keep: Vec<&str> = t.lines().rev().take(defaults::num("health.log_keep_lines") as usize).collect::<Vec<_>>().into_iter().rev().collect();
        crate::discard::harmless(std::fs::write(&p, keep.join("\n") + "\n")); // keep: best effort, fail-open
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        return f.write_all(line.as_bytes()).is_ok();
    }
    false
}

/// Append `ts<TAB>kind<TAB>code<TAB>detail`. The log is trimmed to its last half when it passes 64 KiB.
pub fn log_event(kind: &str, code: &str, detail: &str) {
    let _ = append_event_line(&event_line(kind, code, detail));
}

/// Append an event, or write the exact sanitized event line to stderr when the state-dir log is unavailable.
pub fn log_event_or_stderr(kind: &str, code: &str, detail: &str) {
    let line = event_line(kind, code, detail);
    if !append_event_line(&line) {
        crate::discard::harmless(std::io::stderr().write_all(line.as_bytes())); // keep: a closed pipe leaves nobody to tell
    }
}

/// Every line of the event log, oldest first.
pub fn events() -> Vec<Event> {
    let Ok(t) = std::fs::read_to_string(file(log_name())) else { return vec![] };
    t.lines()
        .filter_map(|l| {
            let mut it = l.splitn(4, '\t');
            Some(Event { ts: it.next()?.parse().ok()?, kind: it.next()?.into(), code: it.next()?.into(), detail: it.next().unwrap_or("").into() })
        })
        .collect()
}

fn count_recent(kinds: &[&str], window: Duration) -> usize {
    let floor = now_ms().saturating_sub(window.as_millis() as u64);
    events().iter().filter(|e| e.ts >= floor && kinds.contains(&e.kind.as_str())).count()
}

// ---- classification ----------------------------------------------------------------------------

/// Who can fix a failure.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Class {
    /// Caused by the machine (disk, permissions, path length, OS kill): the user can fix it.
    Env,
    /// Not caused by the environment (crash loop on a healthy machine, panic, invariant): a bug.
    Permanent,
}

/// Classify an error code (`os<errno>`, `sig<n>`, `unsafe_dir`, `panic`, ...) and give a plain self-fix hint.
///
/// The code groups, their class and the hint message keys come from `health.error_codes` in the defaults; a code
/// that is not listed is a permanent failure with no hint.
pub fn classify(code: &str) -> (Class, String) {
    for group in defaults::raw("health.error_codes").as_array().unwrap_or_default() {
        let listed = group.get("codes").is_some_and(|c| c.strings().contains(&code));
        if !listed {
            continue;
        }
        let class = if group.str_field("class") == "env" { Class::Env } else { Class::Permanent };
        let key = group.str_field("hint");
        return (class, if key.is_empty() { String::new() } else { hint_text(key) });
    }
    (Class::Permanent, String::new())
}

/// A hint message (by its `msg.` key) with its placeholders filled (state dir, env var names).
pub fn hint_text(key: &str) -> String {
    let state_dir = format!("~/{}/{}", defaults::text("paths.base_dir"), defaults::text("paths.state_dir"));
    defaults::render(key, &[("state_dir", &state_dir), ("env_dir", &defaults::env_name("dir")), ("env_mem", &defaults::env_of("daemon.mem_mb").unwrap_or(""))])
}

/// Record a failure for the advisory: `failure.json` {ts, class, kind, code, hint, reason}.
pub fn record_failure(kind: &str, code: &str, reason: &str) {
    let (class, hint) = classify(code);
    let v = json!({"ts": now_ms(), "class": if class == Class::Env {"env"} else {"permanent"}, "kind": kind, "code": code, "hint": hint, "reason": reason});
    if let Err(e) = std::fs::write(state_file("failure"), v.to_string()) {
        // without the record no advisory is ever shown; the log still has the failure itself
        log_event_or_stderr("health", "failure_record_write_failed", &format!("{kind}/{code}: {e}"));
    }
}

fn read_json(key: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(state_file(key)).ok()?).ok()
}

/// A healthy start clears an environment-class failure (the user fixed it); permanent ones stay.
pub fn clear_env_failure() {
    if read_json("failure").and_then(|v| v["class"].as_str().map(|c| c == "env")).unwrap_or(false) {
        crate::discard::harmless(std::fs::remove_file(state_file("failure"))); // keep: cleanup that raced; an absent file is the goal state
    }
}

// ---- pids and the run marker ---------------------------------------------------------------------

/// True when a process with this pid exists (signal 0).
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: `kill` takes plain integers and has no memory-safety preconditions; a pid that already exited just fails with ESRCH.
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// The command line of `pid` as the probe command in `health.pid_probe` reports it (empty when it cannot be read).
fn process_command(pid: u32) -> String {
    let probe = defaults::list("health.pid_probe");
    let Some((program, args)) = probe.split_first() else { return String::new() };
    let args: Vec<String> = args.iter().map(|a| a.replace("{pid}", &pid.to_string())).collect();
    std::process::Command::new(program).args(&args).output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
}

/// True when `pid` is a live process running `<this binary> serve`.
pub fn pid_is_engine(pid: u32) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    let exe = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).unwrap_or_default();
    let cmd = process_command(pid);
    !exe.is_empty() && cmd.contains(&exe) && cmd.contains(&format!(" {}", defaults::text("health.serve_arg")))
}

/// Record that a daemon is running, so a later start can tell a crash from a clean exit.
pub fn write_marker() {
    crate::discard::harmless(std::fs::write(state_file("run_marker"), std::process::id().to_string())); // keep: best effort, fail-open
}

/// Remove the run marker on a clean exit.
pub fn clear_marker() {
    crate::discard::harmless(std::fs::remove_file(state_file("run_marker"))); // keep: cleanup that raced; an absent file is the goal state
}

/// If a previous daemon left its run marker and is gone (or the pid is no longer an engine), it died
/// without a clean exit: claim the marker atomically (rename) and log one `crash` event.
pub fn reap_marker() {
    let m = state_file("run_marker");
    let Ok(t) = std::fs::read_to_string(&m) else { return };
    let pid: u32 = t.trim().parse().unwrap_or(0);
    if pid != std::process::id() && pid_is_engine(pid) {
        return;
    }
    let claim = file(&format!("{}{}", defaults::text("files.reaped_prefix"), std::process::id()));
    if std::fs::rename(&m, &claim).is_ok() {
        crate::discard::harmless(std::fs::remove_file(&claim)); // keep: cleanup that raced; an absent file is the goal state
        log_event("crash", "unknown", &defaults::render("msg.log_crash", &[("pid", &pid.to_string())]));
    }
}

// ---- crash-loop protection (daemon deaths) -------------------------------------------------------

fn halted(key: &str) -> Option<Duration> {
    let until: u64 = std::fs::read_to_string(state_file(key)).ok()?.trim().parse().ok()?;
    let now = now_ms();
    (until > now).then(|| Duration::from_millis(until - now))
}

fn halt(key: &str, cooldown: Duration) {
    if let Err(e) = std::fs::write(state_file(key), (now_ms() + cooldown.as_millis() as u64).to_string()) {
        // a cooldown that was not written does not hold: the loop it was meant to stop would go on
        log_event_or_stderr("health", "halt_write_failed", &format!("{key}: {e}"));
    }
}

/// Time left in a crash-loop cooldown, if one is active.
pub fn crashloop_remaining() -> Option<Duration> {
    halted("crashloop_until")
}

/// Evaluate the crash-loop rule before (re)spawning: reap a dead daemon's marker, then if the daemon died
/// `crash_n` or more times within `crash_window`, enter a cooldown, record why, and return true
/// (= do NOT spawn; the caller falls back).
pub fn crashloop_tripped(cfg: &ClientConfig) -> bool {
    if crashloop_remaining().is_some() {
        return true;
    }
    reap_marker();
    let n = count_recent(&crashy(), cfg.crash_window);
    if n < cfg.crash_n {
        return false;
    }
    halt("crashloop_until", cfg.crash_cooldown);
    // a crash loop caused by the environment keeps that cause; otherwise it is a permanent failure
    let env_code = events().into_iter().rev().find(|e| crashy().contains(&e.kind.as_str())).filter(|e| classify(&e.code).0 == Class::Env).map(|e| e.code);
    let reason = defaults::render("msg.reason_crashloop", &[("n", &n.to_string()), ("secs", &cfg.crash_window.as_secs().to_string())]);
    let (kind, code) = ("crashloop".to_string(), env_code.unwrap_or_else(|| "crashloop".to_string()));
    log_event("crashloop", &code, &reason);
    record_failure(&kind, &code, &reason);
    true
}

// ---- client circuit breaker ----------------------------------------------------------------------

/// Time left until the client circuit breaker closes, if it is open.
pub fn breaker_remaining() -> Option<Duration> {
    halted("breaker_until")
}

/// Count one engine failure (timeout, bad frame, ...). `n` of them within `window` open the breaker for
/// `cooldown`: the client then skips the engine and goes straight to the Node fallback.
pub fn breaker_failure(cfg: &ClientConfig, why: &str) {
    log_event("client_fail", "engine", why);
    if count_recent(&["client_fail"], cfg.breaker_window) >= cfg.breaker_n && breaker_remaining().is_none() {
        halt("breaker_until", cfg.breaker_cooldown);
        let reason =
            defaults::render("msg.reason_breaker", &[("n", &cfg.breaker_n.to_string()), ("secs", &cfg.breaker_window.as_secs().to_string()), ("why", &why)]);
        log_event("breaker_open", "breaker", &reason);
        record_failure("breaker", "breaker", &reason);
    }
}

/// Operator reset: clear the breaker, the crash-loop cooldown and the failure record.
pub fn reset() {
    for key in ["breaker_until", "crashloop_until", "failure"] {
        crate::discard::harmless(std::fs::remove_file(state_file(key))); // keep: cleanup that raced; an absent file is the goal state
    }
    log_event("reset", "-", defaults::text("msg.log_operator_reset"));
}

// ---- scrubbing and the once-per-session advisory -------------------------------------------------

/// Remove anything that looks like a secret, an email or the home path from `s`.
///
/// The patterns are `health.scrub_patterns` in the defaults (regex, replacement), applied in order; the home
/// directory is replaced by `~` first so a diagnostic never names the user's account.
pub fn scrub(s: &str) -> String {
    let mut out = s.to_string();
    if let Some(h) = defaults::env_var("home").filter(|h| h.len() > 1) {
        out = out.replace(&h, "~");
    }
    for pair in defaults::raw("health.scrub_patterns").as_array().unwrap_or_default() {
        let (Some(re), Some(rep)) =
            (pair.as_array().and_then(|p| p.first()).and_then(defaults::V::as_str), pair.as_array().and_then(|p| p.get(1)).and_then(defaults::V::as_str))
        else {
            continue;
        };
        if let Ok(r) = Regex::new(re) {
            out = r.replace_all(&out, rep).to_string();
        }
    }
    out
}

/// The secret-scrubbed diagnostic block appended to a permanent-failure advisory.
pub fn diagnostics(code: &str) -> String {
    let log: Vec<String> = std::fs::read_to_string(file(log_name()))
        .map(|t| t.lines().rev().take(defaults::num("health.diag_lines") as usize).map(String::from).collect::<Vec<_>>().into_iter().rev().collect())
        .unwrap_or_default();
    let body = defaults::render(
        "msg.diagnostics",
        &[("version", &crate::version()), ("os", &std::env::consts::OS), ("arch", &std::env::consts::ARCH), ("code", &code), ("log", &log.join("\n"))],
    );
    scrub(&body)
}

/// FNV-1a 64: stable across Rust versions (used for file names that two builds must agree on).
pub fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// The engine's health over the last `health.degraded_window_s`: self-restarts by reason, the crash-loop breaker and the client
/// breaker with when they tripped, and how often a call fell back to Node and why. `degraded` is true when the engine is
/// not at full strength (a restart in the window, the crash-loop breaker tripped, the client breaker open, or a defaults
/// fallback of a `health.degraded_kinds` kind in the window). Everything is
/// read from the event log, so it works with the daemon down and survives a restart.
pub fn summary() -> Value {
    let window = defaults::secs("health.degraded_window_s");
    let floor = now_ms().saturating_sub(window.as_millis() as u64);
    let ev = events();
    let recent: Vec<&Event> = ev.iter().filter(|e| e.ts >= floor).collect();
    let tally = |pick: &dyn Fn(&Event) -> Option<String>| -> serde_json::Map<String, Value> {
        let mut m: std::collections::BTreeMap<String, u64> = std::collections::BTreeMap::new();
        for e in &recent {
            if let Some(k) = pick(e) {
                *m.entry(k).or_insert(0) += 1;
            }
        }
        m.into_iter().map(|(k, v)| (k, json!(v))).collect()
    };
    let crashy = crashy();
    // a crash-loop trip is the consequence of the restarts, not one of them
    let restarts = tally(&|e| (crashy.contains(&e.kind.as_str()) && e.kind != "crashloop").then(|| format!("{}:{}", e.kind, e.code)));
    let fallbacks = tally(&|e| matches!(e.kind.as_str(), "dispatch_defer" | "client_fail").then(|| format!("{}:{}", e.kind, e.code)));
    let total = |m: &serde_json::Map<String, Value>| m.values().filter_map(Value::as_u64).sum::<u64>();
    let last = |kind: &str| ev.iter().rev().find(|e| e.kind == kind).map(|e| json!({"ts": e.ts, "code": e.code, "detail": e.detail}));
    let (loop_left, breaker_left) = (crashloop_remaining(), breaker_remaining());
    let degraded_kinds = defaults::list("health.degraded_kinds");
    let defaults_fb = tally(&|e| degraded_kinds.contains(&e.kind.as_str()).then(|| format!("{}:{}", e.kind, e.code)));
    let last_defaults = ev
        .iter()
        .rev()
        .find(|e| e.ts >= floor && degraded_kinds.contains(&e.kind.as_str()))
        .map(|e| json!({"ts": e.ts, "kind": e.kind, "code": e.code, "detail": e.detail}));
    let degraded = total(&restarts) > 0 || loop_left.is_some() || breaker_left.is_some() || total(&defaults_fb) > 0;
    json!({
        "degraded": degraded,
        "window_s": window.as_secs(),
        "restarts": {"total": total(&restarts), "by_reason": restarts, "last_rss_trip": last("rss"), "last_memory_breakdown": last("memory")},
        "crashloop": {"tripped": loop_left.is_some(), "remaining_s": loop_left.map(|d| d.as_secs() + 1), "last_trip": last("crashloop")},
        "breaker": {"open": breaker_left.is_some(), "remaining_s": breaker_left.map(|d| d.as_secs() + 1), "last_open": last("breaker_open")},
        "fallbacks": {"total": total(&fallbacks), "by_reason": fallbacks},
        "defaults": {"total": total(&defaults_fb), "by_reason": defaults_fb, "last": last_defaults},
        "log": file(log_name()).display().to_string(),
    })
}

/// The advisory for this session: `Some(text)` the first time a recent failure exists for `session`,
/// then `None` for the rest of that session. Env failures get a self-fix hint; permanent ones get the
/// issue-filing text and a scrubbed diagnostic block. Nothing is ever filed automatically.
pub fn advisory(session: &str) -> Option<String> {
    let Some(f) = read_json("failure").filter(|f| now_ms().saturating_sub(f["ts"].as_u64().unwrap_or(0)) <= defaults::num("health.advisory_ttl_ms")) else {
        return degraded_notice(session);
    };
    let dir = state_file("advised_dir");
    crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the write that follows reports a failure
    let stamp = dir.join(format!("{:016x}", fnv(&format!("{session}|{}", f["ts"]))));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&stamp).ok()?; // already advised => None
    prune_advised(&dir);
    let reason = f["reason"].as_str().unwrap_or("unknown");
    let code = f["code"].as_str().unwrap_or("unknown");
    Some(if f["class"] == "env" {
        defaults::render("msg.advisory_env", &[("hint", &f["hint"].as_str().unwrap_or(reason))])
    } else {
        defaults::render("msg.advisory_permanent", &[("reason", &scrub(reason)), ("diagnostics", &diagnostics(code))])
    })
}

/// A few words, once per session, when the engine is running below full strength (a self-restart in the window, a tripped
/// breaker) and no failure advisory applies, so the owner learns of a degraded engine without digging through logs.
fn degraded_notice(session: &str) -> Option<String> {
    let s = summary();
    if s["degraded"] != true {
        return None;
    }
    let dir = state_file("advised_dir");
    crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the write that follows reports a failure
    let stamp = dir.join(format!("{:016x}", fnv(&format!("{session}|degraded"))));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&stamp).ok()?; // already told => None
    prune_advised(&dir);
    let mut text = defaults::render(
        "msg.advisory_degraded",
        &[
            ("restarts", &s["restarts"]["total"]),
            ("mins", &(defaults::secs("health.degraded_window_s").as_secs() / 60)),
            ("fallbacks", &s["fallbacks"]["total"]),
            ("log", &s["log"].as_str().unwrap_or("")),
        ],
    );
    if s["defaults"]["total"].as_u64().unwrap_or(0) > 0 {
        text.push_str(&defaults::render(
            "msg.advisory_defaults",
            &[("count", &s["defaults"]["total"]), ("last", &s["defaults"]["last"]["detail"].as_str().unwrap_or(""))],
        ));
    }
    Some(text)
}

fn prune_advised(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let all: Vec<_> = rd.flatten().collect();
    if all.len() as u64 <= defaults::num("health.advised_cap") {
        return;
    }
    for e in all {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d > defaults::secs("health.advised_expire_s"));
        if old {
            crate::discard::harmless(std::fs::remove_file(e.path())); // keep: cleanup that raced; an absent file is the goal state
        }
    }
}

/// Fold an advisory into hook output `existing` (what the Node hook or engine printed). Output that is
/// not a JSON object is left untouched (returns None) so a protocol line is never corrupted.
pub fn merge_advisory(event: &str, existing: &str, text: &str) -> Option<String> {
    let mut v: Value = if existing.trim().is_empty() { json!({}) } else { serde_json::from_str(existing).ok()? };
    let obj = v.as_object_mut()?;
    if defaults::list("health.context_events").contains(&event) {
        let hso = obj.entry("hookSpecificOutput").or_insert_with(|| json!({}));
        let h = hso.as_object_mut()?;
        h.entry("hookEventName").or_insert_with(|| json!(event));
        let prev = h.get("additionalContext").and_then(Value::as_str).unwrap_or("").to_string();
        h.insert("additionalContext".into(), json!(if prev.is_empty() { text.to_string() } else { format!("{prev}\n{text}") }));
    } else {
        let prev = obj.get("systemMessage").and_then(Value::as_str).unwrap_or("").to_string();
        obj.insert("systemMessage".into(), json!(if prev.is_empty() { text.to_string() } else { format!("{prev}\n{text}") }));
    }
    Some(v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::undocumented_unsafe_blocks)] // test-only env mutation; the single-thread audit is the FIXME beside each call
    fn scrub_removes_secrets_emails_and_home() {
        // FIXME: Audit that the environment access only happens in single-threaded code.
        unsafe { std::env::set_var("HOME", "/Users/someone") };
        let s = scrub(
            "key sk-abcdef0123456789ABCDEF token=hunter2 Authorization: Bearer abcdefgh12345678 ghp_0123456789abcdefghijABCDEF me@example.com /Users/someone/x AKIAABCDEFGHIJKLMNOP",
        );
        for leak in ["sk-abcdef", "hunter2", "abcdefgh12345678", "ghp_0123", "me@example.com", "/Users/someone", "AKIAABCD"] {
            assert!(!s.contains(leak), "{leak} leaked: {s}");
        }
        assert!(s.contains("~/x"));
    }

    #[test]
    fn classification_splits_env_from_permanent() {
        for c in ["os28", "os13", "os36", "sig9", "unsafe_dir", "os24"] {
            let (cl, hint) = classify(c);
            assert_eq!(cl, Class::Env, "{c}");
            assert!(!hint.is_empty());
        }
        for c in ["panic", "crashloop", "unknown", "invariant"] {
            assert_eq!(classify(c).0, Class::Permanent, "{c}");
        }
    }

    #[test]
    fn merge_into_each_output_shape() {
        let m = merge_advisory("PreToolUse", "", "ADV").unwrap();
        assert!(m.contains(r#""additionalContext":"ADV""#) && m.contains(r#""hookEventName":"PreToolUse""#));
        let m = merge_advisory(
            "PreToolUse",
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"}}"#,
            "ADV",
        )
        .unwrap();
        assert!(m.contains("permissionDecision") && m.contains("ADV"));
        let m = merge_advisory("Stop", r#"{"systemMessage":"old"}"#, "ADV").unwrap();
        assert!(m.contains("old\\nADV"));
        assert_eq!(merge_advisory("PreToolUse", "plain text not json", "ADV"), None);
    }

    #[test]
    fn fnv_is_stable() {
        assert_eq!(fnv(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv("a"), 0xaf63_dc4c_8601_ec8c);
    }
}
