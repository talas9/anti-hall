//! The per-session emit-dedupe store (`hooks/lib/emit-dedupe.js`) and the built-in `emit-dedupe-reset` check
//! (`hooks/emit-dedupe-reset.js`, SessionStart).
//!
//! Several UserPromptSubmit hooks decide whether to repeat a block the model already holds. They share one state file per
//! session, `~/.anti-hall/emit-dedupe/dedupe-<session>.json`, which the Node hooks that are not ported still read and
//! write, so this store reads and writes the very same file in the very same shape: insertion-ordered keys, the entry
//! layout, the 24 hour key expiry, the atomic temp-file rename, the suppression counter, and the throttled sweep of idle
//! session files. Nothing but a hash of the emitted text is stored, as in Node.
//!
//! The decision (`should_emit`) is the Node `shouldEmit` rule for rule: a copy still undelivered per the transcript tail is
//! suppressed (rule a), a delivered unchanged block is suppressed until its keepalive count is reached (rule b), a missing or
//! unreadable transcript falls back to the time window, and anything that cannot be persisted is emitted.
//!
//! Where JavaScript could decide differently from this port, the store answers [`Defer`] and the calling check defers the
//! whole hook to Node before anything is written: a state file serde rejects (JavaScript may accept it), a transcript line
//! that holds a delivered-block marker but that neither parser accepts, a timestamp that is not the strict ISO form, a
//! relative transcript path, no home directory.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsval::{DateParse, Js, date_parse, js_to_string, number_to_string, parse_line};
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::checks::guardkit::tail::read_tail;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// The store cannot decide the way Node would; the calling check defers to the Node hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Defer;

pub use crate::checks::jsport::text::sha1_hex;

/// What `shouldEmit` is asked.
pub struct Opts<'a> {
    /// The session id (never empty here: an empty id emits without a record, decided by the caller).
    pub session_id: &'a str,
    /// The block key.
    pub key: &'a str,
    /// The exact text the hook would emit.
    pub content: &'a str,
    /// The payload's `transcript_path` when it is a non-empty string.
    pub transcript_path: Option<&'a str>,
    /// `keepaliveTurns`: 0 = pending-only suppression, above 0 = on-change with that keepalive.
    pub keepalive: f64,
    /// The text normalization applied before hashing.
    pub normalize: &'a dyn Fn(&str) -> String,
}

fn num(key: &str) -> f64 {
    defaults::num(key) as f64
}

/// The current time in whole milliseconds, as `Date.now()`.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// `disabled(env, home)`: the whole feature is off when `guards.emitDedupe` is false or `context.dedupeWindowMin` is 0.
fn disabled(st: &Settings) -> bool {
    !get_bool(st, defaults::raw("emit_dedupe.sw_enabled")) || get_number(st, defaults::raw("emit_dedupe.num_window_min")) == 0.0
}

/// `windowMsFromSettings`: the fallback window in milliseconds.
fn window_ms(st: &Settings) -> f64 {
    let mins = get_number(st, defaults::raw("emit_dedupe.num_window_min"));
    if mins.is_finite() && mins > 0.0 { mins * num("emit_dedupe.ms_per_minute") } else { num("emit_dedupe.window_default_ms") }
}

/// `statePath(home, sessionId)`: every character outside letters, digits, dot, underscore and hyphen becomes `_`,
/// counted in UTF-16 units, cut to the configured length.
fn state_path(home: &str, session: &str) -> std::path::PathBuf {
    let max = defaults::num("emit_dedupe.session_safe_max") as usize;
    let mut safe = String::new();
    let mut units = 0usize;
    'cut: for c in session.chars() {
        let ok = c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-');
        for _ in 0..c.len_utf16() {
            if units == max {
                break 'cut;
            }
            safe.push(if ok { c } else { '_' });
            units += 1;
        }
    }
    let file = format!("{}-{safe}.json", defaults::text("emit_dedupe.file_prefix"));
    std::path::Path::new(home).join(defaults::text("emit_dedupe.state_dir")).join(file)
}

/// `readState`: the session file as an insertion-ordered object. A missing, unreadable or blank file, or one that holds
/// something other than an object, is an empty state (as in Node); text serde rejects is [`Defer`] because JavaScript might
/// still parse it.
fn read_state(path: &std::path::Path) -> Result<Vec<(String, Js)>, Defer> {
    let Ok(bytes) = std::fs::read(path) else { return Ok(Vec::new()) };
    let Ok(text) = String::from_utf8(bytes) else { return Err(Defer) };
    if text.trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\r')).is_empty() {
        return Ok(Vec::new());
    }
    match Js::parse(&text) {
        Some(Js::Obj(v)) => Ok(v),
        Some(_) => Ok(Vec::new()),
        None => Err(Defer),
    }
}

fn state_get<'a>(state: &'a [(String, Js)], key: &str) -> Option<&'a Js> {
    state.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// `Number.isFinite(entry[field])` as a number.
fn finite(e: Option<&Js>, field: &str) -> Option<f64> {
    e.and_then(|j| j.get(field)).and_then(Js::as_f64).filter(|n| n.is_finite())
}

/// `writeEntry`: merge one key into the session file (re-read just before the write), drop keys unseen for the TTL, write
/// atomically, then run the throttled sweep of idle session files. `Err` is an I/O failure (the caller swallows it, as
/// Node's `try`/`catch` does) or [`Defer`] for a state file it cannot read.
fn write_entry(home: &str, session: &str, key: &str, entry: Js, now: f64) -> Result<(), WriteErr> {
    let path = state_path(home, session);
    let dir = path.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
    std::fs::create_dir_all(&dir).map_err(|_| WriteErr::Io)?;
    let mut state = read_state(&path).map_err(|_| WriteErr::Defer)?;
    match state.iter_mut().find(|(k, _)| k == key) {
        Some(slot) => slot.1 = entry,
        None => state.push((key.to_string(), entry)),
    }
    let ttl = num("emit_dedupe.key_ttl_ms");
    state.retain(|(_, e)| now - finite(Some(e), "lastSeenAt").unwrap_or(0.0) <= ttl);
    crate::atomic::write(&path, Js::Obj(state).stringify()).map_err(|_| WriteErr::Io)?;
    prune_stale(&dir, &path);
    Ok(())
}

enum WriteErr {
    Io,
    Defer,
}

/// `pruneStale` of `hooks/lib/state-prune.js`: at most once per throttle period, remove this store's session files whose
/// modification time is older than the TTL, never the caller's own. Best effort; every error is swallowed.
fn prune_stale(dir: &std::path::Path, keep: &std::path::Path) {
    let prefix = defaults::text("emit_dedupe.file_prefix");
    let stamp = dir.join(format!("{}{prefix}.json", defaults::text("emit_dedupe.prune_stamp_prefix")));
    let now = now_ms();
    if let Ok(raw) = std::fs::read_to_string(&stamp)
        && let Some(last) =
            Js::parse(raw.trim_matches(|c: char| crate::checks::guardkit::text::is_js_space(c))).and_then(|j| j.get("lastSweep").and_then(Js::as_f64))
        && last.is_finite()
        && last <= now
        && now - last < num("emit_dedupe.prune_throttle_ms")
    {
        return;
    }
    let _ = std::fs::write(&stamp, Js::Obj(vec![("lastSweep".into(), Js::Num(now))]).stringify());
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let keep_name = keep.file_name().map(|n| n.to_string_lossy().to_string());
    let (head, tail) = (format!("{prefix}-"), ".json");
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.starts_with(&head) || !name.ends_with(tail) || keep_name.as_deref() == Some(name.as_str()) {
            continue;
        }
        let Ok(m) = e.path().metadata() else { continue };
        let Ok(mtime) = m.modified().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).map_err(std::io::Error::other)) else { continue };
        if now - (mtime.as_secs_f64() * 1000.0) > num("emit_dedupe.prune_ttl_ms") {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// One `hook_additional_context` UserPromptSubmit attachment of the transcript tail.
struct Att {
    ts: f64,
    els: Vec<String>,
}

/// The tail scan result: the attachments and the file size.
struct Tail {
    atts: Vec<Att>,
    size: u64,
}

/// `scanTail`: `Ok(None)` is "unusable" (missing, unreadable, empty, or no timestamp anywhere in the window).
fn scan_tail(path: &str, bytes: u64) -> Result<Option<Tail>, Defer> {
    let Some((lines, size)) = read_tail(path, bytes) else { return Ok(None) };
    let marker = defaults::text("emit_dedupe.attachment_type");
    let mut atts = Vec::new();
    let mut any_ts = false;
    for line in &lines {
        if line.is_empty() {
            continue;
        }
        if !any_ts && line.contains("\"timestamp\"") {
            any_ts = true;
        }
        if !line.contains(marker) {
            continue;
        }
        // A line that holds the marker and that neither parser reads may still be valid JavaScript: defer.
        let Some(e) = parse_line(line) else { return Err(Defer) };
        let Some(a) = (e.get("type").and_then(Value::as_str) == Some("attachment")).then(|| e.get("attachment")).flatten() else { continue };
        if a.get("type").and_then(Value::as_str) != Some(marker) || a.get("hookEvent").and_then(Value::as_str) != Some(defaults::text("emit_dedupe.hook_event"))
        {
            continue;
        }
        let ts = match e.get("timestamp") {
            Some(Value::String(s)) => match date_parse(s) {
                DateParse::Ms(ms) => ms,
                DateParse::Nan => continue,
                DateParse::Unsupported => return Err(Defer),
            },
            Some(Value::Number(_)) | Some(Value::Array(_)) => return Err(Defer),
            _ => continue,
        };
        let els = match a.get("content") {
            Some(Value::Array(v)) => v.iter().map(js_to_string).collect(),
            Some(Value::Null) | None => vec![String::new()],
            Some(other) => vec![js_to_string(other)],
        };
        atts.push(Att { ts, els });
    }
    Ok(any_ts.then_some(Tail { atts, size }))
}

/// The tail scans of one decision, read at most once per window size (Node memoizes them per process).
struct Scans<'a> {
    path: Option<&'a str>,
    small: Option<Result<Option<Tail>, Defer>>,
    wide: Option<Result<Option<Tail>, Defer>>,
}

impl<'a> Scans<'a> {
    fn new(path: Option<&'a str>) -> Scans<'a> {
        Scans { path, small: None, wide: None }
    }

    /// `findInTail`: `Some(true/false)`, or `None` when the transcript cannot tell (no attachment of any kind in the window).
    fn find(&mut self, pred: &dyn Fn(&Att) -> bool) -> Result<Option<bool>, Defer> {
        let Some(p) = self.path else { return Ok(None) };
        let small_bytes = defaults::num("emit_dedupe.tail_bytes");
        let wide_bytes = defaults::num("emit_dedupe.tail_bytes_wide");
        let small = self.small.get_or_insert_with(|| scan_tail(p, small_bytes));
        let Some(t) = small.as_ref().map_err(|e| *e)?.as_ref() else { return Ok(None) };
        if t.atts.iter().any(pred) {
            return Ok(Some(true));
        }
        let mut any = !t.atts.is_empty();
        if t.size > small_bytes {
            let wide = self.wide.get_or_insert_with(|| scan_tail(p, wide_bytes));
            if let Some(w) = wide.as_ref().map_err(|e| *e)?.as_ref() {
                if w.atts.iter().any(pred) {
                    return Ok(Some(true));
                }
                any = any || !w.atts.is_empty();
            }
        }
        Ok(any.then_some(false))
    }
}

/// `matchesExact`: some attachment element is the emitted string, or holds it as a run of `k` whole segments.
fn matches_exact(els: &[String], ch: &str, k: usize) -> bool {
    let sep = defaults::text("emit_dedupe.segment_sep");
    els.iter().any(|el| {
        if sha1_hex(el.as_bytes()) == ch {
            return true;
        }
        let pieces: Vec<&str> = el.split(sep).collect();
        (0..=pieces.len().saturating_sub(k)).any(|i| i + k <= pieces.len() && sha1_hex(pieces[i..i + k].join(sep).as_bytes()) == ch)
    })
}

/// `tpId`: a short hash of the transcript path.
fn tp_id(tp: Option<&str>) -> Option<String> {
    tp.map(|t| sha1_hex(t.as_bytes())[..16].to_string())
}

fn js_str(s: &str) -> Js {
    Js::Str(s.to_string())
}

fn js_opt(s: Option<String>) -> Js {
    s.map_or(Js::Null, Js::Str)
}

/// `exactId(content)`: the hash of the exact emitted string and its segment count.
fn exact_id(content: &str) -> (Js, Js) {
    (js_str(&sha1_hex(content.as_bytes())), Js::Num(content.split(defaults::text("emit_dedupe.segment_sep")).count() as f64))
}

fn entry(fields: Vec<(&str, Js)>) -> Js {
    Js::Obj(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// `shouldEmit(opts)`: decide and record. `Ok(true)` = emit.
pub fn should_emit(st: &Settings, o: &Opts<'_>) -> Result<bool, Defer> {
    if disabled(st) || o.session_id.is_empty() || o.key.is_empty() {
        return Ok(true);
    }
    if st.home.is_empty() {
        return Err(Defer);
    }
    let home = st.home.as_str();
    let now = now_ms();
    let win = window_ms(st);
    let max_pending = num("emit_dedupe.max_pending_ms");
    let tol = num("emit_dedupe.ts_tolerance_ms");
    let keepalive = if o.keepalive.is_finite() && o.keepalive > 0.0 { o.keepalive } else { 0.0 };
    let hash = sha1_hex((o.normalize)(o.content).as_bytes());
    let tp = tp_id(o.transcript_path);
    let state = read_state(&state_path(home, o.session_id))?;
    let prev = state_get(&state, o.key);
    let reset_at = finite(state_get(&state, defaults::text("emit_dedupe.reset_key")), "resetAt").unwrap_or(0.0);
    // The record counts only when it is well formed, emitted before now and after the last reset, into this transcript.
    let prev_tp_matches = |p: &Js| match p.get("tp") {
        None | Some(Js::Null) | Some(Js::Bool(false)) => tp.is_none(),
        Some(Js::Num(n)) if *n == 0.0 || n.is_nan() => tp.is_none(),
        Some(Js::Str(s)) if s.is_empty() => tp.is_none(),
        Some(Js::Str(s)) => tp.as_deref() == Some(s.as_str()),
        Some(_) => false,
    };
    let prev_ok = prev.filter(|p| {
        matches!(p, Js::Obj(_))
            && p.get("hash").and_then(Js::as_str).is_some()
            && finite(Some(p), "lastEmittedAt").is_some_and(|l| l <= now && l >= reset_at)
            && prev_tp_matches(p)
    });
    let same = prev_ok.filter(|p| p.get("hash").and_then(Js::as_str) == Some(hash.as_str()));
    let last_seen = prev_ok.and_then(|p| finite(Some(p), "lastSeenAt")).unwrap_or(0.0);
    let turns = prev_ok.and_then(|p| finite(Some(p), "turnsSinceEmit")).unwrap_or(0.0);
    let new_turn_gap = num("emit_dedupe.window_default_ms");

    let mut emit = true;
    let mut next_turns = 0.0;
    let mut scans = Scans::new(o.transcript_path);
    if let Some(p) = same {
        let last_emitted = finite(Some(p), "lastEmittedAt").unwrap_or(0.0);
        let since = last_emitted - tol;
        let ch = p.get("ch").and_then(Js::as_str).unwrap_or("").to_string();
        let k = match p.get("k").and_then(Js::as_f64).filter(|k| k.is_finite() && *k > 0.0) {
            Some(k) if k.fract() == 0.0 => k as usize,
            Some(_) => return Err(Defer),
            None => 1,
        };
        let consumed = scans.find(&|a| a.ts >= since && !ch.is_empty() && matches_exact(&a.els, &ch, k))?;
        match consumed {
            None => {
                if now - last_emitted < win {
                    emit = false;
                    next_turns = turns;
                } else if keepalive > 0.0 {
                    let new_turn = now - last_seen >= new_turn_gap;
                    if !(new_turn && turns >= keepalive) {
                        emit = false;
                        next_turns = turns + if new_turn { 1.0 } else { 0.0 };
                    }
                }
            }
            Some(false) => {
                if now - last_emitted < max_pending {
                    emit = false;
                    next_turns = turns;
                }
            }
            Some(true) => {
                if keepalive > 0.0 {
                    let new_turn = scans.find(&|a| a.ts >= last_seen - tol)? == Some(true);
                    let t = turns + if new_turn { 1.0 } else { 0.0 };
                    if t > keepalive {
                        emit = true;
                    } else {
                        emit = false;
                        next_turns = t;
                    }
                }
            }
        }
    }
    let new_entry = if emit {
        let (ch, k) = exact_id(o.content);
        entry(vec![
            ("hash", Js::Str(hash)),
            ("tp", js_opt(tp)),
            ("lastEmittedAt", Js::Num(now)),
            ("lastSeenAt", Js::Num(now)),
            ("turnsSinceEmit", Js::Num(0.0)),
            ("ch", ch),
            ("k", k),
        ])
    } else {
        let p = same.unwrap_or(&Js::Null);
        // `{ hash: prev.hash, tp: prev.tp || null, ch: prev.ch, k: prev.k, ... }`: an absent ch or k is dropped by stringify.
        let mut f = vec![("hash", p.get("hash").cloned().unwrap_or(Js::Null)), ("tp", js_opt(tp))];
        if let Some(c) = p.get("ch") {
            f.push(("ch", c.clone()));
        }
        if let Some(k) = p.get("k") {
            f.push(("k", k.clone()));
        }
        f.push(("lastEmittedAt", p.get("lastEmittedAt").cloned().unwrap_or(Js::Null)));
        f.push(("lastSeenAt", Js::Num(now)));
        f.push(("turnsSinceEmit", Js::Num(next_turns)));
        entry(f)
    };
    match write_entry(home, o.session_id, o.key, new_entry, now) {
        Ok(()) => {}
        Err(WriteErr::Io) => return Ok(true), // cannot persist: never suppress on unverifiable state
        Err(WriteErr::Defer) => return Err(Defer),
    }
    if !emit {
        bump_suppressed(home, o.session_id, now);
    }
    Ok(emit)
}

/// `bumpSuppressed`: the per-session suppression counter doctor reads. Best effort; never changes the decision.
fn bump_suppressed(home: &str, session: &str, now: f64) {
    let path = state_path(home, session);
    let Ok(state) = read_state(&path) else { return };
    let key = defaults::text("emit_dedupe.stats_key");
    let count = finite(state_get(&state, key), "suppressed").unwrap_or(0.0);
    let stats = entry(vec![("suppressed", Js::Num(count + 1.0)), ("lastSeenAt", Js::Num(now)), ("lastSuppressedAt", Js::Num(now))]);
    let _ = write_entry(home, session, key, stats, now);
}

/// `resetSession`: mark a context loss, so every record emitted before now counts as absent. Fail-open.
pub fn reset_session(st: &Settings, session: &str) -> Result<(), Defer> {
    if disabled(st) || session.is_empty() {
        return Ok(());
    }
    if st.home.is_empty() {
        return Err(Defer);
    }
    let now = now_ms();
    let e = entry(vec![("resetAt", Js::Num(now)), ("lastSeenAt", Js::Num(now))]);
    match write_entry(&st.home, session, defaults::text("emit_dedupe.reset_key"), e, now) {
        Err(WriteErr::Defer) => Err(Defer),
        _ => Ok(()),
    }
}

/// The session id string `emit-dedupe-reset.js` derives: `String(payload.session_id)` unless null or absent. `Err` for an
/// array or object id (`String(..)` of those is not reproduced here).
fn reset_session_id(p: &Value) -> Result<String, Defer> {
    match p.get("session_id") {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::Array(_)) | Some(Value::Object(_)) => Err(Defer),
        Some(v) => Ok(js_to_string(v)),
    }
}

/// The session id as the UserPromptSubmit hooks use it: `payload.session_id` when truthy (`String(..)` of a number or
/// `true`), else none. An array or object id is [`Defer`] (`String(..)` of those is not reproduced here).
pub fn session_of(p: &Value) -> Result<Option<String>, Defer> {
    match p.get("session_id") {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Ok(None),
        Some(Value::String(s)) => Ok((!s.is_empty()).then(|| s.clone())),
        Some(Value::Number(n)) => Ok(n.as_f64().filter(|x| *x != 0.0 && !x.is_nan()).map(number_to_string)),
        Some(Value::Bool(true)) => Ok(Some("true".into())),
        Some(_) => Err(Defer),
    }
}

/// `payload.transcript_path` when it is a non-empty string (every use in Node tests `typeof === 'string'` first). A
/// relative path is [`Defer`]: Node would resolve it against its own working directory, not the daemon's.
pub fn transcript_of(p: &Value) -> Result<Option<&str>, Defer> {
    match p.get("transcript_path") {
        Some(Value::String(s)) if !s.is_empty() => {
            if s.starts_with('/') {
                Ok(Some(s))
            } else {
                Err(Defer)
            }
        }
        _ => Ok(None),
    }
}

/// The registered `emit-dedupe-reset` check.
pub struct EmitDedupeReset;

impl Check for EmitDedupeReset {
    fn name(&self) -> &'static str {
        "emit-dedupe-reset"
    }

    fn summary(&self) -> &'static str {
        defaults::text("emit_dedupe.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if env.get(defaults::text("prompt_emit.judge_child_env")) == Some("1") {
            return Some(Verdict::Allow);
        }
        let st = Settings::from_env(env);
        let Ok(session) = reset_session_id(payload) else { return Some(Verdict::Defer) };
        match reset_session(&st, &session) {
            Ok(()) => Some(Verdict::Allow),
            Err(Defer) => Some(Verdict::Defer),
        }
    }
}
