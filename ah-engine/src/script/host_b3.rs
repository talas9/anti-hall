//! Host primitives of D88 batch 3 (generic, no rules): the per-session state file store the Node guards share, and the
//! shell-command scanner `scan-throttle` needs. Installed by [`install`] from [`super::host::install`]; the `ah.*` shape is
//! built from them by the plugin's `engine/logic/lib/60-b3.js`.
//!
//! | raw function | what it does |
//! |---|---|
//! | `stateHomeOk()` | whether the request has a home directory the state files can live under |
//! | `stateGet(ns, key)` | the text of the state file of `(ns, key)` (`<home>/.anti-hall/<ns>-<key>.json`), or `null` |
//! | `stateProbe(ns, key)` | whether that file can be read exactly as Node reads it (absent, or UTF-8 and the same JSON in both readers) |
//! | `shellHeredocAt(cmd, i)` | a heredoc opener at code point `i` of a shell command (not inside arithmetic): `[end, openerLen]` in code points, or `null` |
//! | `platform()` | the operating system the engine runs on (`macos`, `linux`, ...) |
//! | `readTail(path, window)` | the last `window` bytes of a file as text (lossy UTF-8), the possibly partial first line dropped when the file is larger; `null` when unreadable |
//! | `maskQuoted(text)` | the reply with its quoted material blanked (the speculation guard's `maskQuotedText`) |
//! | `jevMode(id)` | the mode (`on`, `shadow`, `off`) of Jev integration `id` for this request |
//! | `jevAskSpec(spec)` | ask Jev (`spec`: JSON text, see [`jev_ask`]): detached (returns `null`) or synchronous (returns the outcome as JSON text) |
//! | `fnv(text)` / `contentHash(parts)` | the 64-bit FNV-1a hex of a text (the spawn key) / the Jev content hash of a list of texts |
//! | `localTime(ms)` | JSON local calendar fields of an instant with the zone offset |
//! | `stateUpdate(ns, key, fn)` | atomic read-modify-write: `fn(current or null)` returns the new text, or `null` to leave it; stale files are pruned after a write |
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use super::host::with_settings;
use crate::checks::guardkit::state::{FileState, SessionState};
use rquickjs::{Ctx, Function, Object};

fn state_of() -> rquickjs::Result<Option<FileState>> {
    with_settings(|st| FileState::new(&st.home))
}

fn state_update<'js>(ns: String, key: String, cb: Function<'js>) -> rquickjs::Result<bool> {
    let Some(store) = state_of()? else { return Ok(false) };
    let mut failure: Option<rquickjs::Error> = None;
    store.update(&ns, &key, &mut |cur| match cb.call::<_, Option<String>>((cur.map(str::to_string),)) {
        Ok(v) => v,
        Err(e) => {
            failure = Some(e);
            None
        }
    });
    match failure {
        Some(e) => Err(e),
        None => Ok(true),
    }
}

fn state_probe(ns: &str, key: &str) -> rquickjs::Result<bool> {
    let home = with_settings(|st| st.home.clone())?;
    if home.is_empty() {
        return Ok(true);
    }
    let path = format!("{}/{ns}-{key}{}", crate::checks::guardkit::fsio::state_dir(&home), crate::defaults::text("guardkit.state_ext"));
    Ok(match std::fs::read(path) {
        Ok(b) => !crate::checks::guardkit::jsdiff::js_reads_differently(&b) && std::str::from_utf8(&b).is_ok(),
        Err(e) => e.kind() == std::io::ErrorKind::NotFound,
    })
}

thread_local! {
    /// The arithmetic scan of the shell command being walked left to right (it restarts when the command changes).
    static HEREDOC: std::cell::RefCell<(String, crate::checks::git::tokenize::ArithScan)> =
        std::cell::RefCell::new((String::new(), crate::checks::git::tokenize::ArithScan::new()));
}

fn heredoc_at(cmd: &str, i: usize) -> Option<Vec<i64>> {
    let cs: Vec<char> = cmd.chars().collect();
    HEREDOC.with(|h| {
        let mut h = h.borrow_mut();
        if h.0 != cmd {
            *h = (cmd.to_string(), crate::checks::git::tokenize::ArithScan::new());
        }
        crate::checks::git::tokenize::parse_heredoc_at(&cs, i, &mut h.1).map(|r| vec![r.end as i64, r.opener_len as i64])
    })
}

fn read_tail(path: &str, window: u64) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let mut buf = Vec::new();
    if size <= window {
        f.read_to_end(&mut buf).ok()?;
        return Some(crate::checks::guardkit::text::lossy_owned(buf));
    }
    f.seek(SeekFrom::Start(size - window)).ok()?;
    f.take(window).read_to_end(&mut buf).ok()?;
    let text = crate::checks::guardkit::text::lossy_owned(buf);
    Some(text.split_once('\n').map_or(String::new(), |(_, rest)| rest.to_string()))
}

fn jev_env() -> rquickjs::Result<(String, crate::jev::Env)> {
    with_settings(|st| (st.home.clone(), crate::jev::Env::from_pairs(st.env.clone())))
}

fn jev_mode(id: &str) -> rquickjs::Result<String> {
    let (home, env) = jev_env()?;
    Ok(crate::jev::shared::mode_of(std::path::Path::new(&home), &env, id).as_str().to_string())
}

/// `jevAskSpec(spec)`. `spec` is JSON: `id`, `question` (`{type: "noul"|"choice", instructions, criteria: [[key, text], ...]}`),
/// `state`, `trust` (`add_block`, `advisory`, `relax_block`), `baseline`, and optionally `cacheKey`, `budgetMs`,
/// `recordDisagreement`, `sessionId`, `turnRefFrom` (a transcript path), `projectFrom` (a working directory), `judgeLabel`
/// (a choice answer equal to it counts as true), `compare` (an independent verdict for the report's agreement metric), `sync`,
/// `relax` (Node's `consultRelax`: asked here within `jev.relax_sync_cap_ms` only while the integration is `on`; in `shadow` and
/// `off` it goes out detached and nothing is returned) and `full` (return the whole decision instead of its outcome). A
/// detached ask returns `null`; a synchronous one returns the outcome as JSON text, or with `full` the decision as a JSON object
/// `{outcome, jev, baseline, confidence, confident, ms, backend, reason, hash, changed}`.
fn jev_ask(spec: &str) -> rquickjs::Result<Option<String>> {
    use crate::jev::{AskRequest, Question, Trust};
    let v: serde_json::Value = serde_json::from_str(spec).map_err(|e| super::host::err("jevAsk", e.to_string()))?;
    let s = |k: &str| v.get(k).and_then(serde_json::Value::as_str);
    let q = v.get("question").ok_or_else(|| super::host::err("jevAsk", "question"))?;
    let qs = |k: &str| q.get(k).and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
    let crit: Vec<(String, String)> = q
        .get("criteria")
        .and_then(serde_json::Value::as_array)
        .map(|a| a.iter().filter_map(|p| Some((p.get(0)?.as_str()?.to_string(), p.get(1)?.as_str()?.to_string()))).collect())
        .unwrap_or_default();
    let question = if qs("type") == "noul" {
        let at = |k: &str| crit.iter().find(|(c, _)| c == k).map(|(_, t)| t.clone()).unwrap_or_default();
        Question::noul(&qs("instructions"), &at("true"), &at("false"))
    } else {
        Question::choice(&qs("instructions"), crit)
    };
    let trust = match s("trust") {
        Some("add_block") => Trust::AddBlock,
        Some("advisory") => Trust::Advisory,
        _ => Trust::RelaxBlock,
    };
    let mut req = AskRequest::new(s("id").unwrap_or_default(), question, s("state").unwrap_or_default(), trust, v.get("baseline").cloned().unwrap_or(serde_json::Value::Null));
    req.cache_key = s("cacheKey").map(str::to_string);
    // never past the time the client still waits
    req.budget_ms = v.get("budgetMs").and_then(serde_json::Value::as_u64).map(|b| crate::deadline::clamp(std::time::Duration::from_millis(b)).as_millis() as u64);
    req.record_disagreement = v.get("recordDisagreement").and_then(serde_json::Value::as_bool).unwrap_or(false);
    req.session_id = s("sessionId").map(str::to_string);
    req.turn_ref = s("turnRefFrom").filter(|t| !t.is_empty()).and_then(crate::jev::shared::turn_ref_from_transcript);
    req.project = crate::jev::shared::project_for(s("projectFrom"));
    if let Some(label) = s("judgeLabel") {
        let label = label.to_string();
        req.judge = Some(std::sync::Arc::new(move |answer| answer.to_json() == serde_json::Value::String(label.clone())));
    }
    req.compare = v.get("compare").and_then(serde_json::Value::as_bool);
    let (home, env) = jev_env()?;
    let home = std::path::Path::new(&home);
    let flag = |k: &str| v.get(k).and_then(serde_json::Value::as_bool).unwrap_or(false);
    let shape = |d: &crate::jev::Decision| if flag("full") { decision_json(d) } else { d.outcome.to_string() };
    if flag("relax") {
        let started = std::time::Instant::now();
        let d = crate::jev::shared::consult_relax(home, &env, req);
        super::host::credit_blocking(started);
        return Ok(d.as_ref().map(shape));
    }
    if flag("sync") {
        req.env = Some(env.clone());
        let started = std::time::Instant::now();
        let d = crate::jev::shared::lane(home, &env).ask(&req);
        super::host::credit_blocking(started);
        return Ok(Some(shape(&d)));
    }
    crate::jev::shared::ask_detached(home, &env, req);
    Ok(None)
}

/// A Jev decision as JSON text: `{outcome, jev, baseline, confidence, confident, ms, backend, reason, hash, changed}`.
fn decision_json(d: &crate::jev::Decision) -> String {
    serde_json::json!({
        "outcome": d.outcome,
        "jev": d.jev,
        "baseline": d.baseline,
        "confidence": d.confidence,
        "confident": d.confident,
        "ms": d.ms,
        "backend": d.backend.as_str(),
        "reason": d.reason.as_ref().map(ToString::to_string),
        "hash": d.hash,
        "changed": d.changed,
    })
    .to_string()
}

/// `localTime(ms)`: the local calendar fields of an instant as JSON `{year, month, day, hour, minute, second, weekday, offsetMinutes}`
/// (`month` 1-12, `weekday` 0 = Sunday, `offsetMinutes` east of UTC), from the system time zone.
pub fn local_time(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: `tm` is a plain-old-data struct that `localtime_r` fills; both pointers are valid for the call.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: `secs` and `tm` are live locals; `localtime_r` only reads the first and writes the second.
    let ok = unsafe { !libc::localtime_r(&secs, &mut tm).is_null() };
    if !ok {
        return "null".into();
    }
    serde_json::json!({"year": tm.tm_year + 1900, "month": tm.tm_mon + 1, "day": tm.tm_mday, "hour": tm.tm_hour, "minute": tm.tm_min, "second": tm.tm_sec, "weekday": tm.tm_wday, "offsetMinutes": tm.tm_gmtoff / 60}).to_string()
}

/// Add the batch-3 functions to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("stateHomeOk", Function::new(c.clone(), || -> rquickjs::Result<bool> { Ok(state_of()?.is_some()) })?)?;
    h.set(
        "stateGet",
        Function::new(c.clone(), |ns: String, key: String| -> rquickjs::Result<Option<String>> { Ok(state_of()?.and_then(|s| s.get(&ns, &key))) })?,
    )?;
    h.set("stateProbe", Function::new(c.clone(), |ns: String, key: String| state_probe(&ns, &key))?)?;
    h.set("shellHeredocAt", Function::new(c.clone(), |cmd: String, i: f64| heredoc_at(&cmd, i.max(0.0) as usize))?)?;
    h.set("readTail", Function::new(c.clone(), |p: String, w: f64| read_tail(&p, w.max(0.0) as u64))?)?;
    h.set("maskQuoted", Function::new(c.clone(), |t: String| crate::checks::speculation_guard::mask::mask_quoted_text(&t))?)?;
    h.set("jevMode", Function::new(c.clone(), |id: String| jev_mode(&id))?)?;
    h.set("jevAskSpec", Function::new(c.clone(), |spec: String| jev_ask(&spec))?)?;
    h.set("fnv", Function::new(c.clone(), |t: String| format!("{:016x}", crate::health::fnv(&t)))?)?;
    h.set(
        "contentHash",
        Function::new(c.clone(), |parts: Vec<String>| crate::jev::assist::content_hash(&parts.iter().map(String::as_str).collect::<Vec<_>>()))?,
    )?;
    h.set("localTime", Function::new(c.clone(), |ms: f64| local_time(ms))?)?;
    h.set("platform", Function::new(c.clone(), || std::env::consts::OS.to_string())?)?;
    h.set("stateUpdate", Function::new(c.clone(), state_update)?)?;
    Ok(())
}
