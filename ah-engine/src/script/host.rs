//! The host API a check script sees (D88): generic, read-only, compiled primitives only. Every rule, text, threshold and
//! decision stays in the plugin's files (the scripts and `engine/defaults`).
//!
//! The raw functions are installed as the global object `ahHost`; the friendly `ah` object scripts use is built from them
//! by the plugin's own `engine/logic/lib/00-ah.js`, so even the API's shape is editable.
//!
//! | raw function | what it does |
//! |---|---|
//! | `cfg(key)` | a shipped defaults entry as JSON text (throws for an unknown key) |
//! | `cfgGen()` | the defaults snapshot generation (a memo of `cfg` values is valid while it is unchanged) |
//! | `cfgNum(key)` | a numeric defaults entry with its env override and clamps applied |
//! | `settingBool(key)` | the effective value of the boolean setting described by defaults entry `key` (the request's settings chain) |
//! | `skipped(guard)` | whether an unexpired skip is recorded for `guard` |
//! | `isFile(path)` | whether `path` is a regular file |
//! | `readText(path, max)` | the first `min(max, script.read_max_bytes)` bytes of a file as text (lossy UTF-8), or `null` |
//! | `pathIsAbsolute`, `pathBasename`, `pathJoin`, `pathResolveAbs`, `pathRelative` | Node `path` (posix) functions |
//! | `reTest(src, flags, text)` | a linear-time regex test (`flags`: `i` ignore case, `r` engine syntax; else JavaScript syntax) |
//! | `reFind(src, flags, text)` / `reFindAll` | match positions in UTF-16 units: `[start, end]` / `[s0, e0, s1, e1, ...]` |
//! | `turnText(path, maxBytes, hint)` | the current turn's assistant text of a transcript, as JSON text (see [`turn_text`]) |
//!
//! Request state (the settings of the hook's own environment) is set for the duration of one call by [`with_call`].
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::compact_decl::{contains_ci, read_tail, turn_texts};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::{jsre, paths, settings};
use crate::defaults;
use regex::Regex;
use rquickjs::{Ctx, Error, Function, Object};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io::Read;

thread_local! {
    static CALL: RefCell<Option<Settings>> = const { RefCell::new(None) };
    static RES: RefCell<HashMap<(String, String), Regex>> = RefCell::new(HashMap::new());
}

/// Run `f` with `st` as the request state the host functions read.
pub fn with_call<R>(st: Settings, f: impl FnOnce() -> R) -> R {
    CALL.with(|c| *c.borrow_mut() = Some(st));
    let r = f();
    CALL.with(|c| *c.borrow_mut() = None);
    r
}

fn with_settings<R>(f: impl FnOnce(&Settings) -> R) -> rquickjs::Result<R> {
    CALL.with(|c| c.borrow().as_ref().map(f)).ok_or_else(|| err("settings", defaults::text("script.msg_no_request")))
}

fn err(what: &'static str, msg: impl Into<String>) -> Error {
    Error::new_from_js_message("value", what, msg.into())
}

fn entry(key: &str) -> rquickjs::Result<&'static defaults::Entry> {
    defaults::get(key).ok_or_else(|| err("cfg", defaults::render("script.msg_unknown_key", &[("key", &key)])))
}

/// Compile (cached) a pattern for `flags`.
fn with_re<R>(src: &str, flags: &str, f: impl FnOnce(&Regex) -> R) -> rquickjs::Result<R> {
    RES.with(|cache| {
        let mut m = cache.borrow_mut();
        let key = (src.to_string(), flags.to_string());
        if !m.contains_key(&key) {
            let re = if flags.contains('r') { Regex::new(src).ok() } else { jsre::try_compile(src, flags.contains('i')) }
                .ok_or_else(|| err("RegExp", defaults::render("script.msg_invalid_pattern", &[("src", &src)])))?;
            if m.len() >= defaults::num("script.regex_cache_max") as usize {
                m.clear();
            }
            m.insert(key.clone(), re);
        }
        Ok(f(&m[&key]))
    })
}

/// UTF-16 length of `s[..byte]`.
fn u16_at(s: &str, byte: usize) -> i64 {
    s[..byte].encode_utf16().count() as i64
}

/// `turnText(path, maxBytes, hint)`: the transcript's last `maxBytes` read as lines (first partial line dropped), then:
/// `null` when the file is missing, empty or unreadable; `{"hint":false}` when `hint` is not empty and no line holds it
/// (ASCII case ignored) or a `\u` escape, so no decoded string can hold it; `{"unsure":true}` when a line could not be read
/// exactly as JavaScript would; else `{"parts":[...]}`, the assistant text blocks of the current turn in order.
pub fn turn_text(path: &str, max: u64, hint: &str) -> String {
    let Some(lines) = read_tail(path, max) else { return "null".into() };
    if !hint.is_empty() && !lines.iter().any(|l| contains_ci(l.as_bytes(), hint.as_bytes()) || l.contains("\\u")) {
        return r#"{"hint":false}"#.into();
    }
    match turn_texts(&lines) {
        Some(parts) => serde_json::json!({ "parts": parts }).to_string(),
        None => r#"{"unsure":true}"#.into(),
    }
}

/// Install `ahHost` in a fresh context.
pub fn install(c: &Ctx<'_>) -> rquickjs::Result<()> {
    let h = Object::new(c.clone())?;
    h.set("cfg", Function::new(c.clone(), |key: String| -> rquickjs::Result<String> { Ok(entry(&key)?.value.to_json().to_string()) })?)?;
    h.set("cfgGen", Function::new(c.clone(), || defaults::generation() as f64)?)?;
    h.set(
        "cfgNum",
        Function::new(c.clone(), |key: String| -> rquickjs::Result<f64> {
            entry(&key)?.value.as_integer().ok_or_else(|| err("cfgNum", defaults::render("script.msg_not_number", &[("key", &key)])))?;
            Ok(defaults::num(&key) as f64)
        })?,
    )?;
    h.set(
        "settingBool",
        Function::new(c.clone(), |key: String| -> rquickjs::Result<bool> {
            let e = entry(&key)?;
            with_settings(|st| settings::get_bool(st, &e.value))
        })?,
    )?;
    h.set("skipped", Function::new(c.clone(), |guard: String| -> rquickjs::Result<bool> { with_settings(|st| settings::is_skipped(st, &guard)) })?)?;
    h.set("isFile", Function::new(c.clone(), |p: String| std::fs::metadata(p).is_ok_and(|m| m.is_file()))?)?;
    h.set(
        "readText",
        Function::new(c.clone(), |p: String, max: f64| -> Option<String> {
            let cap = defaults::num("script.read_max_bytes");
            let n = if max.is_finite() && max > 0.0 { (max as u64).min(cap) } else { cap };
            let f = std::fs::File::open(p).ok()?;
            let mut buf = Vec::new();
            f.take(n).read_to_end(&mut buf).ok()?;
            Some(crate::checks::guardkit::text::lossy_owned(buf))
        })?,
    )?;
    h.set("pathIsAbsolute", Function::new(c.clone(), |p: String| paths::is_absolute(&p))?)?;
    h.set("pathBasename", Function::new(c.clone(), |p: String| paths::basename(&p).to_string())?)?;
    h.set("pathJoin", Function::new(c.clone(), |a: String, b: String| paths::join(&a, &b))?)?;
    h.set("pathResolveAbs", Function::new(c.clone(), |p: String| paths::resolve_abs(&p))?)?;
    h.set("pathRelative", Function::new(c.clone(), |a: String, b: String| paths::relative(&a, &b))?)?;
    h.set(
        "reTest",
        Function::new(c.clone(), |src: String, flags: String, text: String| -> rquickjs::Result<bool> { with_re(&src, &flags, |re| re.is_match(&text)) })?,
    )?;
    h.set(
        "reFind",
        Function::new(c.clone(), |src: String, flags: String, text: String| -> rquickjs::Result<Option<Vec<i64>>> {
            with_re(&src, &flags, |re| re.find(&text).map(|m| vec![u16_at(&text, m.start()), u16_at(&text, m.end())]))
        })?,
    )?;
    h.set(
        "reFindAll",
        Function::new(c.clone(), |src: String, flags: String, text: String| -> rquickjs::Result<Vec<i64>> {
            with_re(&src, &flags, |re| {
                // offsets converted incrementally: one pass over the text, not one per match
                let (mut out, mut byte, mut unit) = (Vec::new(), 0usize, 0i64);
                for m in re.find_iter(&text) {
                    unit += u16_at(&text[byte..], m.start() - byte);
                    let start = unit;
                    unit += u16_at(&text[m.start()..], m.end() - m.start());
                    byte = m.end();
                    out.extend([start, unit]);
                }
                out
            })
        })?,
    )?;
    h.set("turnText", Function::new(c.clone(), |p: String, max: f64, hint: String| turn_text(&p, max.max(0.0) as u64, &hint))?)?;
    c.globals().set("ahHost", h)?;
    Ok(())
}
