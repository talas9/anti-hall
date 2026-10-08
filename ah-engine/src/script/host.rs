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
//! | `env(name)` | a variable of the hook's own environment (the request's, never the daemon's), or `null` |
//! | `settingEnum(key)` / `settingNum(key)` | the effective value of the enum / numeric setting described by defaults entry `key` |
//! | `fileSize(path)` | the size in bytes of a regular file, or `null` |
//! | `passwdHome()` | the user's home as the passwd database has it, or `null` |
//! | `realpath(path)` | the canonical path (links resolved), or `null` when it does not exist |
//! | `pathResolve(base, p)` | Node `path.resolve(base, p)` (posix) |
//! | `writeAtomic(rel, text)` | the SCOPED write (`rel` is relative to the home directory, under the state directory): see [`write_atomic`] |
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
use std::path::{Path, PathBuf};

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

/// Why a scripted write was refused (a policy violation, as opposed to an I/O failure, which only makes the write return
/// `false`).
fn refused(why: &str) -> Error {
    err("writeAtomic", defaults::render("script.msg_write_refused", &[("why", &why)]))
}

/// The scoped write API (D88 condition a): write `text` atomically to `rel`, a path RELATIVE to the home directory that must
/// lie under the script write root (`script.write_root`, the anti-hall state directory), through the engine's atomic helper.
///
/// Refused (the call throws, so the check takes its failure policy): an absolute path, a path whose first part is not the
/// write root, a `..` / `.` / empty / NUL-bearing part, a text over `script.write_max_bytes`, a path longer than
/// `script.write_path_max`, a symlink at ANY existing part below the root (an escape through a link) and a home that is not an absolute
/// path. A file where a directory is needed, or a directory where the file goes, is an I/O failure: the call returns `false`. An I/O failure (disk full, permission) returns `false`. Directories under the root are
/// created as needed. The check and the write are separate steps, so a process that races a link into the tree between
/// them is not excluded; the root is the owner's own state directory, so that is the owner racing themselves.
pub fn write_atomic(home: &str, rel: &str, text: &str) -> rquickjs::Result<bool> {
    if !paths::is_absolute(home) {
        return Err(refused(defaults::text("script.write_why_home")));
    }
    if text.len() as u64 > defaults::num("script.write_max_bytes") {
        return Err(refused(defaults::text("script.write_why_size")));
    }
    if rel.len() as u64 > defaults::num("script.write_path_max") || rel.is_empty() || rel.contains('\0') {
        return Err(refused(defaults::text("script.write_why_path")));
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") || parts.len() < 2 || parts[0] != defaults::text("script.write_root") {
        return Err(refused(defaults::text("script.write_why_path")));
    }
    let root: PathBuf = Path::new(home).join(parts[0]);
    let mut cur = root.clone();
    let last = parts.len() - 1;
    for (i, part) in parts.iter().enumerate().skip(1) {
        cur.push(part);
        match std::fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => return Err(refused(defaults::text("script.write_why_link"))),
            // a file where a directory is needed, or a directory where the file goes: the disk cannot take the write
            Ok(m) if (i < last && !m.is_dir()) || (i == last && !m.is_file()) => return Ok(false),
            _ => {}
        }
    }
    // the root itself may be a link the owner set up (a state directory on another disk); what is refused is a link BELOW it
    let Some(parent) = cur.parent() else { return Ok(false) };
    if std::fs::create_dir_all(parent).is_err() {
        return Ok(false);
    }
    let (Ok(real_root), Ok(real_parent)) = (std::fs::canonicalize(&root), std::fs::canonicalize(parent)) else { return Ok(false) };
    if !real_parent.starts_with(&real_root) {
        return Err(refused(defaults::text("script.write_why_link")));
    }
    let style = crate::atomic::Style { skip_sync: defaults::num("script.write_sync") == 0, ..crate::atomic::Style::default() };
    Ok(crate::atomic::write_styled(&cur, text, style).is_ok())
}

/// The user's home as the passwd database has it.
fn passwd_home() -> Option<String> {
    crate::checks::spawnctx::passwd_home()
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
    h.set("env", Function::new(c.clone(), |name: String| -> rquickjs::Result<Option<String>> { with_settings(|st| st.env.get(&name).cloned()) })?)?;
    h.set(
        "settingEnum",
        Function::new(c.clone(), |key: String| -> rquickjs::Result<String> {
            let e = entry(&key)?;
            with_settings(|st| settings::get_enum(st, &e.value))
        })?,
    )?;
    h.set(
        "settingNum",
        Function::new(c.clone(), |key: String| -> rquickjs::Result<f64> {
            let e = entry(&key)?;
            with_settings(|st| settings::get_number(st, &e.value))
        })?,
    )?;
    h.set("fileSize", Function::new(c.clone(), |p: String| std::fs::metadata(p).ok().filter(std::fs::Metadata::is_file).map(|m| m.len() as f64))?)?;
    h.set("passwdHome", Function::new(c.clone(), passwd_home)?)?;
    h.set("realpath", Function::new(c.clone(), |p: String| std::fs::canonicalize(p).ok().map(|r| r.to_string_lossy().into_owned()))?)?;
    h.set("pathResolve", Function::new(c.clone(), |a: String, b: String| paths::resolve(&a, &b))?)?;
    h.set(
        "writeAtomic",
        Function::new(c.clone(), |rel: String, text: String| -> rquickjs::Result<bool> {
            let home = with_settings(|st| st.home.clone())?;
            write_atomic(&home, &rel, &text)
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
