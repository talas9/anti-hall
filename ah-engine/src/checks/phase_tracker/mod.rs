//! Built-in `check = "phase-tracker"`: a port of the Node phase-tracker (PreToolUse on Agent and Task).
//!
//! The hook never decides anything: it records each subagent spawn so the statusline can show live swarm activity. It
//! appends a timestamp and a per-session tag to `~/.anti-hall/agent-spawns.log` (keeping the last few minutes of every
//! session's lines) and rewrites the rolling heartbeat `~/.anti-hall/agents/recent-spawn.json`. Both writes are best
//! effort and a failure of either is ignored, exactly as in Node; the answer is always "allow, say nothing".
//!
//! Mirrors `hooks/phase-tracker.js`. Not mirrored: a payload whose working directory is not a string (Node would hash its
//! JavaScript string form); that case defers.
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::spawnctx::{now_ms, os_homedir};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

#[cfg(test)]
mod tests;

/// One tracker at a time inside this process: two parallel spawn calls would otherwise race on the log, as two Node
/// processes do (a lost line is harmless, a torn write is not).
static LOCK: Mutex<()> = Mutex::new(());

/// JavaScript truthiness of a JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `parseInt(s, 10)` as a finite number: leading white space, an optional sign, then decimal digits (the rest is
/// ignored). `None` when it would be NaN or infinite.
pub fn js_parse_int(s: &str) -> Option<f64> {
    let t = s.trim_start_matches(is_js_space);
    let (neg, rest) = match t.as_bytes().first() {
        Some(b'-') => (true, &t[1..]),
        Some(b'+') => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let n: f64 = digits.parse().ok()?;
    let n = if neg { -n } else { n };
    n.is_finite().then_some(n)
}

use crate::checks::jsport::text::sha1_hex;

/// `sessionTag(payload)`: the session id, else a short hash of the working directory, else `unknown`, reduced to letters,
/// digits, `_` and `-` and cut to the tag length. `None` when the working directory is not a string (defer).
pub fn session_tag(p: &Value) -> Option<String> {
    let mut raw = String::new();
    match p.get("session_id").and_then(Value::as_str).map(js_trim) {
        Some(s) if !s.is_empty() => raw = s.to_string(),
        _ => {
            let direct = p.get("cwd");
            let cwd = if truthy(direct) { direct } else { p.get("workspace").filter(|w| truthy(Some(w))).and_then(|w| w.get("current_dir")) };
            if truthy(cwd) {
                let s = cwd.and_then(Value::as_str)?;
                let hex = sha1_hex(s);
                raw = format!("{}{}", defaults::text("phase_tracker.cwd_tag_prefix"), &hex[..defaults::num("phase_tracker.cwd_hash_len") as usize]);
            }
        }
    }
    let clean: String =
        raw.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-')).take(defaults::num("phase_tracker.tag_max") as usize).collect();
    Some(if clean.is_empty() { defaults::text("phase_tracker.unknown_tag").to_string() } else { clean })
}

/// The spawn log after this spawn: every recent line of the old log (any session), then this one.
pub fn next_log(old: &[u8], now: f64, tag: &str) -> String {
    let text = String::from_utf8_lossy(old);
    let keep = defaults::num("phase_tracker.keep_ms") as f64;
    let mut lines: Vec<&str> =
        js_trim(&text).split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| js_parse_int(l).is_some_and(|ms| now - ms < keep)).collect();
    let mine = format!("{} {tag}", now as u64);
    lines.push(&mine);
    format!("{}\n", lines.join("\n"))
}

/// Record one spawn under `home` at time `now`; every filesystem failure is ignored.
pub fn record(home: &str, now: f64, tag: &str) {
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Path::new(home).join(defaults::text("spawn_ctx.state_root"));
    let log = dir.join(defaults::text("phase_tracker.log_file"));
    let old = std::fs::read(&log).unwrap_or_default();
    let text = next_log(&old, now, tag);
    if std::fs::create_dir_all(&dir).is_ok() {
        let _ = std::fs::write(&log, text);
    }
    let agents = dir.join(defaults::text("phase_tracker.agents_dir"));
    if std::fs::create_dir_all(&agents).is_ok() {
        let _ = std::fs::write(agents.join(defaults::text("phase_tracker.heartbeat_file")), format!("{{\"ts\":{}}}", now as u64));
    }
}

/// The check's decision on one payload: it records the spawn and says nothing.
///
/// Mirrors `hooks/phase-tracker.js`.
pub fn decide(p: &Value, env: &std::collections::HashMap<String, String>, now: f64) -> Option<Verdict> {
    let Some(home) = os_homedir(env) else { return Some(Verdict::Defer) };
    let Some(tag) = session_tag(p) else { return Some(Verdict::Defer) };
    record(&home, now, &tag);
    None
}

/// The registered `phase-tracker` check.
pub struct PhaseTracker;

impl Check for PhaseTracker {
    fn name(&self) -> &'static str {
        "phase-tracker"
    }

    fn summary(&self) -> &'static str {
        defaults::text("phase_tracker.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        // recorded, nothing to say: `Allow`, never `None` (a deferral would make the Node hook record the spawn a second time)
        decide(payload, &env.to_map(), now_ms()).or(Some(Verdict::Allow))
    }
}
