//! Built-in `check = "swarm-guard"`: a port of the Node swarm-guard (PreToolUse on Agent and Task; the anti fork bomb).
//!
//! Two gates, in this order: critical memory pressure (available memory under a few percent of the total blocks the
//! spawn) and the spawn rate (the cap per rolling window, counted in `~/.anti-hall/swarm-spawns.log` under a lock file
//! the Node hook shares). An allowed spawn is recorded, a blocked one is not (a blocked retry must never extend the
//! window) but is noted in the trip log, which the decision never reads.
//!
//! What it does not decide: the optional shared-tree advisory that Node adds to an allowed spawn (a write-capable
//! agent started while another write-capable agent runs in the same working tree) needs the running-agent scan of the
//! session transcript, which is not ported. When the advisory could be due, the check defers BEFORE it records the
//! spawn, so the Node hook counts it exactly once and decides the advisory; when it cannot be due (the advisory
//! switched off, a read-only agent type, an isolated spawn, no transcript) the check records the spawn itself. A block
//! never defers: the advisory only ever rides an allowed spawn.
//!
//! Same as Node: any trouble taking the lock, reading the memory figures or writing the log allows the spawn.
//!
//! Mirrors `hooks/swarm-guard.js` and the decision half of `hooks/lib/shared-tree-note.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

pub mod mem;

use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::nodelock::{self, Params};
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{enabled, is_skipped, plugin_root};
use crate::checks::guardkit::text::{js_string_of, js_trim};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use mem::{HostMem, MemSource};
use serde_json::Value;
use std::sync::Mutex;

#[cfg(test)]
mod tests;

/// Serializes the spawns of this process before they reach the lock file, so two threads of the daemon never wait on
/// each other's lock (Node processes cannot share a mutex, which is what the lock file is for).
static IN_PROCESS: Mutex<()> = Mutex::new(());

/// JavaScript `String(x)` for the values a tool list can hold (arrays join with commas, null inside one is empty).
fn js_to_string(v: &Value, top: bool) -> String {
    match v {
        Value::Null if !top => String::new(),
        Value::Array(a) => a.iter().map(|x| js_to_string(x, false)).collect::<Vec<_>>().join(","),
        Value::Object(_) => String::from("[object Object]"),
        other => js_string_of(other).unwrap_or_default(),
    }
}

/// JavaScript truthiness.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// The first truthy value among the named fields (`a || b || c`).
fn first_truthy<'a>(inp: &'a Value, names: &[&str]) -> Option<&'a Value> {
    names.iter().filter_map(|n| inp.get(n)).find(|v| truthy(v))
}

/// `toolList(v)`: lower-cased, trimmed, non-empty names; `None` when `v` is neither a list nor a string with content.
fn tool_list(v: Option<&Value>) -> Option<Vec<String>> {
    let norm = |s: &str| js_trim(s).to_lowercase();
    match v? {
        Value::Array(a) => Some(a.iter().map(|x| norm(&js_to_string(x, true))).filter(|s| !s.is_empty()).collect()),
        Value::String(s) if !js_trim(s).is_empty() => Some(s.split(',').map(norm).filter(|s| !s.is_empty()).collect()),
        _ => None,
    }
}

/// `writeCapable(spawnInput)`: an unknown type or tool list counts as write-capable.
fn write_capable(inp: &Value) -> bool {
    let t = inp.get("subagent_type").and_then(Value::as_str).map(|s| js_trim(s).to_lowercase()).unwrap_or_default();
    if !t.is_empty() && defaults::list("swarm_guard.read_only_types").contains(&t.as_str()) {
        return false;
    }
    let write_tools = defaults::list("swarm_guard.write_tools");
    if let Some(allow) = tool_list(first_truthy(inp, &defaults::list("swarm_guard.allow_fields")))
        && !allow.iter().any(|x| write_tools.contains(&x.as_str()))
    {
        return false;
    }
    if let Some(deny) = tool_list(first_truthy(inp, &defaults::list("swarm_guard.deny_fields")))
        && defaults::list("swarm_guard.write_tools_every").iter().all(|x| deny.iter().any(|d| d == x))
    {
        return false;
    }
    true
}

/// `isolated(spawnInput)`.
fn isolated(inp: &Value) -> bool {
    let v = inp.get("isolation").and_then(Value::as_str).map(|s| js_trim(s).to_lowercase()).unwrap_or_default();
    defaults::list("swarm_guard.isolation_values").contains(&v.as_str())
}

/// True when the shared-tree advisory is certainly empty for this payload: decided without the transcript scan.
/// False means it could be due (the scan decides), so the caller defers.
fn note_certainly_silent(p: &Value, st: &Settings, root: &str) -> Result<bool, crate::checks::guardkit::settings::Undecidable> {
    if !enabled(st, defaults::raw("swarm_guard.shared_tree_setting"), root)? {
        return Ok(true);
    }
    let Some(inp) = p.get("tool_input").filter(|v| v.is_object() || v.is_array()) else { return Ok(true) };
    if !write_capable(inp) || isolated(inp) {
        return Ok(true);
    }
    Ok(!p.get("transcript_path").and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
}

/// `describeSpawn(payload)`: `tool` or `tool:agent type`, for the trip log only.
fn describe_spawn(p: &Value) -> String {
    let unknown = defaults::text("swarm_guard.unknown_label");
    let tool = p.get("tool_name").and_then(Value::as_str).filter(|s| !s.is_empty()).unwrap_or(unknown);
    let inp = p.get("tool_input");
    let atype = defaults::list("swarm_guard.agent_type_fields")
        .iter()
        .find_map(|k| inp.and_then(|i| i.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty()))
        .unwrap_or("");
    if atype.is_empty() { tool.to_string() } else { format!("{tool}:{atype}") }
}

/// `parseInt(s, 10)` for the spawn log: leading white space, an optional sign, then digits; anything after is ignored.
fn js_parse_int(s: &str) -> Option<f64> {
    let t = js_trim(s);
    let (neg, rest) = match t.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    if digits.is_empty() {
        return None;
    }
    let v: f64 = digits.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// `readTimestamps()`: the positive, finite numbers of the log; any read problem is an empty log.
fn read_timestamps(file: &str) -> Vec<f64> {
    let Ok(bytes) = std::fs::read(file) else { return Vec::new() };
    let text = String::from_utf8_lossy(&bytes).to_string();
    js_trim(&text).split('\n').filter_map(|l| js_parse_int(l.strip_suffix('\r').unwrap_or(l))).filter(|n| n.is_finite() && *n > 0.0).collect()
}

/// `Date.prototype.toISOString` for a millisecond timestamp.
fn iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil-from-days (proleptic Gregorian)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3600, rem % 3600 / 60, rem % 60, ms % 1000)
}

fn block(reason: &str) -> Verdict {
    let quoted = serde_json::to_string(reason).unwrap_or_else(|_| String::from("\"\""));
    Verdict::Exact(Exact { code: 2, out: format!("{{\"decision\":\"block\",\"reason\":{quoted}}}\n"), err: String::new() })
}

/// JavaScript `Math.round` for a non-negative number.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// `logTrip`: one line per blocked spawn; a failure changes nothing.
fn log_trip(dir: &str, count: usize, label: &str, now: u64) {
    crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: the write that follows fails too when the directory is missing
    let line = format!("{}\t{count}\t{label}\n", iso(now));
    if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(format!("{dir}/{}", defaults::text("swarm_guard.trip_file"))) {
        crate::discard::logged("swarm_trip_log", std::io::Write::write_all(&mut f, line.as_bytes()));
    }
}

/// The check's decision on one payload. `None`: nothing to say (the spawn is allowed).
///
/// Mirrors `hooks/swarm-guard.js` `main`.
pub fn decide(p: &Value, st: &Settings, root: &str, memory: &dyn MemSource, now: u64) -> Option<Verdict> {
    if st.env.get(defaults::env_name("home")).is_none_or(|h| !paths::is_absolute(h)) {
        return Some(Verdict::Defer);
    }
    match enabled(st, defaults::raw("swarm_guard.setting"), root) {
        Ok(true) => {}
        Ok(false) => return None,
        Err(_) => return Some(Verdict::Defer),
    }
    if is_skipped(st, defaults::text("swarm_guard.guard_name")) {
        return None;
    }
    let label = describe_spawn(p);

    let avail = memory.available();
    let total = memory.total();
    let percent = defaults::num("swarm_guard.mem_floor_percent") as f64;
    if let Some(avail) = avail
        && total > 0.0
        && avail / total < percent / 100.0
    {
        let mb = |b: f64| format!("{}", js_round(b / 1024.0 / 1024.0) as i64);
        return Some(block(&defaults::render("swarm_guard.msg_mem", &[("avail", &mb(avail)), ("total", &mb(total))])));
    }

    let note_silent = match note_certainly_silent(p, st, root) {
        Ok(b) => b,
        Err(_) => return Some(Verdict::Defer),
    };

    let dir = paths::join(&st.home, defaults::text("swarm_guard.state_dir"));
    let log = format!("{dir}/{}", defaults::text("swarm_guard.log_file"));
    let _local = IN_PROCESS.lock().unwrap_or_else(|e| e.into_inner());
    // Could not lock: allow without recording, and without the advisory, exactly as Node does.
    let lock = nodelock::acquire(&format!("{dir}/{}", defaults::text("swarm_guard.lock_file")), Params::swarm())?;

    let cutoff = now as f64 - defaults::num("swarm_guard.window_ms") as f64;
    let mut recent: Vec<f64> = read_timestamps(&log).into_iter().filter(|t| *t > cutoff).collect();
    let cap = defaults::num("swarm_guard.spawn_cap") as usize;
    let verdict = if recent.len() >= cap {
        let what = defaults::render("swarm_guard.msg_rate_what", &[("count", &recent.len()), ("cap", &cap)]);
        let reason = msg::message(
            Kind::Block,
            defaults::text("swarm_guard.guard_name"),
            &Parts {
                what: &what,
                why: defaults::text("swarm_guard.msg_rate_why"),
                instead: defaults::text("swarm_guard.msg_rate_instead"),
                ..Parts::default()
            },
        );
        Some((block(&reason), recent.len()))
    } else if !note_silent || recent.iter().any(|t| *t > defaults::num("swarm_guard.exact_int_limit") as f64) {
        lock.release();
        return Some(Verdict::Defer);
    } else {
        recent.push(now as f64);
        let body: Vec<String> = recent.iter().map(|t| format!("{}", *t as u64)).collect();
        crate::discard::harmless(std::fs::create_dir_all(&dir)); // keep: the write that follows fails too when the directory is missing
        crate::discard::logged("swarm_state_write", std::fs::write(&log, format!("{}\n", body.join("\n"))));
        None
    };
    lock.release();
    let (v, count) = verdict?;
    log_trip(&dir, count, &label, now);
    Some(v)
}

/// The registered `swarm-guard` check.
pub struct SwarmGuard;

impl Check for SwarmGuard {
    fn name(&self) -> &'static str {
        "swarm-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("swarm_guard.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        // a check that decided "nothing to say" answers `Allow`, never `None`: in the dispatcher `None` hands the call to the Node hook, which
        // would record the same spawn a second time
        decide(payload, &Settings::from_env(env), &plugin_root(opts, env), &HostMem, now).or(Some(Verdict::Allow))
    }
}
