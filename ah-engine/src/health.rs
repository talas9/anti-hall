//! Engine health state, all inside the engine's own state dir (`paths::dir()`): the event log, the
//! client circuit breaker, crash-loop protection, failure classification and the once-per-session
//! advisory. Every function is best-effort: a state-dir problem must never break a hook call.
use crate::config::ClientConfig;
use crate::paths;
use regex::Regex;
use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

pub const LOG: &str = "ah-engine.log";
const LOG_CAP: u64 = 64 * 1024;
/// Event kinds that count toward the crash-loop threshold.
const CRASHY: &[&str] = &["crash", "panic", "start_fail", "watchdog", "rss"];

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn file(name: &str) -> PathBuf {
    paths::dir().join(name)
}

fn clean(s: &str) -> String {
    s.chars().map(|c| if c == '\n' || c == '\t' || c == '\r' { ' ' } else { c }).take(300).collect()
}

// ---- event log ---------------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct Event {
    pub ts: u64,
    pub kind: String,
    pub code: String,
    pub detail: String,
}

/// Append `ts<TAB>kind<TAB>code<TAB>detail`. The log is trimmed to its last half when it passes 64 KiB.
pub fn log_event(kind: &str, code: &str, detail: &str) {
    let p = file(LOG);
    if std::fs::metadata(&p).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
        if let Ok(t) = std::fs::read_to_string(&p) {
            let keep: Vec<&str> = t.lines().rev().take(200).collect::<Vec<_>>().into_iter().rev().collect();
            let _ = std::fs::write(&p, keep.join("\n") + "\n");
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(format!("{}\t{}\t{}\t{}\n", now_ms(), clean(kind), clean(code), clean(detail)).as_bytes());
    }
}

pub fn events() -> Vec<Event> {
    let Ok(t) = std::fs::read_to_string(file(LOG)) else { return vec![] };
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

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Class {
    /// Caused by the machine (disk, permissions, path length, OS kill): the user can fix it.
    Env,
    /// Not caused by the environment (crash loop on a healthy machine, panic, invariant): a bug.
    Permanent,
}

/// Classify an error code (`os<errno>`, `sig<n>`, `unsafe_dir`, `panic`, ...) and give a plain self-fix hint.
pub fn classify(code: &str) -> (Class, &'static str) {
    match code {
        "os28" => (Class::Env, "the disk is full (no space left); free some space, then it recovers by itself"),
        "os13" | "os1" | "unsafe_dir" => (Class::Env, "the engine's state directory is not writable or not private; fix its ownership (chown to yourself) and permissions (chmod 700 ~/.anti-hall/ah-engine), or set AH_ENGINE_DIR to a directory you own"),
        "os36" | "os22" | "path_too_long" => (Class::Env, "the socket path is too long; set AH_ENGINE_DIR to a shorter path (e.g. /tmp/ah)"),
        "os24" | "os23" => (Class::Env, "the process ran out of file descriptors; raise `ulimit -n` or close other programs"),
        "os12" | "sig9" => (Class::Env, "the OS killed or starved the engine (low memory); close other programs or lower AH_ENGINE_MEM_MB"),
        _ => (Class::Permanent, ""),
    }
}

/// Record a failure for the advisory: `failure.json` {ts, class, kind, code, hint, reason}.
pub fn record_failure(kind: &str, code: &str, reason: &str) {
    let (class, hint) = classify(code);
    let v = json!({"ts": now_ms(), "class": if class == Class::Env {"env"} else {"permanent"}, "kind": kind, "code": code, "hint": hint, "reason": reason});
    let _ = std::fs::write(file("failure.json"), v.to_string());
}

fn read_json(name: &str) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(file(name)).ok()?).ok()
}

/// A healthy start clears an environment-class failure (the user fixed it); permanent ones stay.
pub fn clear_env_failure() {
    if read_json("failure.json").and_then(|v| v["class"].as_str().map(|c| c == "env")).unwrap_or(false) {
        let _ = std::fs::remove_file(file("failure.json"));
    }
}

// ---- pids and the run marker ---------------------------------------------------------------------

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let rc = unsafe { libc::kill(pid as i32, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// True when `pid` is a live process running `<this binary> serve`.
pub fn pid_is_engine(pid: u32) -> bool {
    if !pid_alive(pid) {
        return false;
    }
    let exe = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string())).unwrap_or_default();
    let out = std::process::Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output();
    let cmd = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
    !exe.is_empty() && cmd.contains(&exe) && cmd.contains(" serve")
}

pub fn write_marker() {
    let _ = std::fs::write(file("daemon.run"), std::process::id().to_string());
}

pub fn clear_marker() {
    let _ = std::fs::remove_file(file("daemon.run"));
}

/// If a previous daemon left its run marker and is gone (or the pid is no longer an engine), it died
/// without a clean exit: claim the marker atomically (rename) and log one `crash` event.
pub fn reap_marker() {
    let m = file("daemon.run");
    let Ok(t) = std::fs::read_to_string(&m) else { return };
    let pid: u32 = t.trim().parse().unwrap_or(0);
    if pid != std::process::id() && pid_is_engine(pid) {
        return;
    }
    let claim = file(&format!("daemon.run.reaped.{}", std::process::id()));
    if std::fs::rename(&m, &claim).is_ok() {
        let _ = std::fs::remove_file(&claim);
        log_event("crash", "unknown", &format!("daemon pid {pid} died without a clean exit"));
    }
}

// ---- crash-loop protection (daemon deaths) -------------------------------------------------------

fn halted(name: &str) -> Option<Duration> {
    let until: u64 = std::fs::read_to_string(file(name)).ok()?.trim().parse().ok()?;
    let now = now_ms();
    (until > now).then(|| Duration::from_millis(until - now))
}

fn halt(name: &str, cooldown: Duration) {
    let _ = std::fs::write(file(name), (now_ms() + cooldown.as_millis() as u64).to_string());
}

/// Time left in a crash-loop cooldown, if one is active.
pub fn crashloop_remaining() -> Option<Duration> {
    halted("crashloop.until")
}

/// Evaluate the crash-loop rule before (re)spawning: reap a dead daemon's marker, then if the daemon died
/// `crash_n` or more times within `crash_window`, enter a cooldown, record why, and return true
/// (= do NOT spawn; the caller falls back).
pub fn crashloop_tripped(cfg: &ClientConfig) -> bool {
    if crashloop_remaining().is_some() {
        return true;
    }
    reap_marker();
    let n = count_recent(CRASHY, cfg.crash_window);
    if n < cfg.crash_n {
        return false;
    }
    halt("crashloop.until", cfg.crash_cooldown);
    // a crash loop caused by the environment keeps that cause; otherwise it is a permanent failure
    let last_env = events().iter().rev().find(|e| CRASHY.contains(&e.kind.as_str())).map(|e| classify(&e.code).0 == Class::Env).unwrap_or(false);
    let (kind, code, reason) = if last_env {
        let e = events().into_iter().rev().find(|e| CRASHY.contains(&e.kind.as_str())).unwrap();
        ("crashloop".to_string(), e.code, format!("daemon died {n} times in {} s", cfg.crash_window.as_secs()))
    } else {
        ("crashloop".to_string(), "crashloop".to_string(), format!("daemon died {n} times in {} s", cfg.crash_window.as_secs()))
    };
    log_event("crashloop", &code, &reason);
    record_failure(&kind, &code, &reason);
    true
}

// ---- client circuit breaker ----------------------------------------------------------------------

pub fn breaker_remaining() -> Option<Duration> {
    halted("breaker.until")
}

/// Count one engine failure (timeout, bad frame, ...). `n` of them within `window` open the breaker for
/// `cooldown`: the client then skips the engine and goes straight to the Node fallback.
pub fn breaker_failure(cfg: &ClientConfig, why: &str) {
    log_event("client_fail", "engine", why);
    if count_recent(&["client_fail"], cfg.breaker_window) >= cfg.breaker_n && breaker_remaining().is_none() {
        halt("breaker.until", cfg.breaker_cooldown);
        let reason = format!("{} engine failures in {} s (last: {why})", cfg.breaker_n, cfg.breaker_window.as_secs());
        log_event("breaker_open", "breaker", &reason);
        record_failure("breaker", "breaker", &reason);
    }
}

/// Operator reset: clear the breaker, the crash-loop cooldown and the failure record.
pub fn reset() {
    for n in ["breaker.until", "crashloop.until", "failure.json"] {
        let _ = std::fs::remove_file(file(n));
    }
    log_event("reset", "-", "operator reset");
}

// ---- scrubbing and the once-per-session advisory -------------------------------------------------

/// Remove anything that looks like a secret, an email or the home path from `s`.
pub fn scrub(s: &str) -> String {
    let pats: [(&str, &str); 7] = [
        (r"(?i)\b(?:sk|pk|rk|xox[a-z])[-_][A-Za-z0-9_\-]{12,}", "[redacted]"),
        (r"\bgh[pousr]_[A-Za-z0-9]{20,}", "[redacted]"),
        (r"\bAKIA[0-9A-Z]{16}\b", "[redacted]"),
        (r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}", "$1 [redacted]"),
        (r#"(?i)((?:api[_-]?key|token|secret|passw(?:or)?d|authorization)["']?\s*[=:]\s*)["']?[^\s"',}]+"#, "$1[redacted]"),
        (r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", "[email]"),
        (r"\b[A-Za-z0-9+/_\-]{40,}\b", "[redacted]"),
    ];
    let mut out = s.to_string();
    if let Some(h) = std::env::var_os("HOME").map(|h| h.to_string_lossy().to_string()).filter(|h| h.len() > 1) {
        out = out.replace(&h, "~");
    }
    for (re, rep) in pats {
        if let Ok(r) = Regex::new(re) {
            out = r.replace_all(&out, rep).to_string();
        }
    }
    out
}

/// The secret-scrubbed diagnostic block appended to a permanent-failure advisory.
pub fn diagnostics(code: &str) -> String {
    let log: Vec<String> = std::fs::read_to_string(file(LOG))
        .map(|t| t.lines().rev().take(8).map(String::from).collect::<Vec<_>>().into_iter().rev().collect())
        .unwrap_or_default();
    let body = format!(
        "--- anti-hall engine diagnostics ---\nversion: {}\nos: {} {}\nerror code: {}\nlast log lines (ts, kind, code, detail):\n{}\n---",
        crate::version(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        code,
        log.join("\n")
    );
    scrub(&body)
}

/// FNV-1a 64: stable across Rust versions (used for file names that two builds must agree on).
pub fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

/// The advisory for this session: `Some(text)` the first time a recent failure exists for `session`,
/// then `None` for the rest of that session. Env failures get a self-fix hint; permanent ones get the
/// issue-filing text and a scrubbed diagnostic block. Nothing is ever filed automatically.
pub fn advisory(session: &str) -> Option<String> {
    let f = read_json("failure.json")?;
    if now_ms().saturating_sub(f["ts"].as_u64().unwrap_or(0)) > 3_600_000 {
        return None;
    }
    let dir = file("advised");
    let _ = std::fs::create_dir_all(&dir);
    let stamp = dir.join(format!("{:016x}", fnv(&format!("{session}|{}", f["ts"]))));
    std::fs::OpenOptions::new().write(true).create_new(true).open(&stamp).ok()?; // already advised => None
    prune_advised(&dir);
    let reason = f["reason"].as_str().unwrap_or("unknown");
    let code = f["code"].as_str().unwrap_or("unknown");
    Some(if f["class"] == "env" {
        format!("⚠️ anti-hall · engine: {}. Using the built-in checks instead.", f["hint"].as_str().unwrap_or(reason))
    } else {
        format!(
            "⚠️ anti-hall · engine: stopped after repeated failures ({}). Using the built-in checks instead. Please file an issue: https://github.com/talas9/anti-hall/issues/new\n{}",
            scrub(reason),
            diagnostics(code)
        )
    })
}

fn prune_advised(dir: &std::path::Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let all: Vec<_> = rd.flatten().collect();
    if all.len() <= 500 {
        return;
    }
    for e in all {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map_or(false, |d| d > Duration::from_secs(2 * 86400));
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Fold an advisory into hook output `existing` (what the Node hook or engine printed). Output that is
/// not a JSON object is left untouched (returns None) so a protocol line is never corrupted.
pub fn merge_advisory(event: &str, existing: &str, text: &str) -> Option<String> {
    let mut v: Value = if existing.trim().is_empty() { json!({}) } else { serde_json::from_str(existing).ok()? };
    let obj = v.as_object_mut()?;
    let ctx_events = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "SessionStart", "SubagentStart"];
    if ctx_events.contains(&event) {
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
    fn scrub_removes_secrets_emails_and_home() {
        std::env::set_var("HOME", "/Users/someone");
        let s = scrub("key sk-abcdef0123456789ABCDEF token=hunter2 Authorization: Bearer abcdefgh12345678 ghp_0123456789abcdefghijABCDEF me@example.com /Users/someone/x AKIAABCDEFGHIJKLMNOP");
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
        let m = merge_advisory("PreToolUse", r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"}}"#, "ADV").unwrap();
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
