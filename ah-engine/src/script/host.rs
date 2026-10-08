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
//! | `reTest(src, flags, text)` | a linear-time regex test (`flags`: `i` ignore case, `m` multiline (`^`/`$` at line boundaries), `r` engine syntax; else JavaScript syntax) |
//! | `reFind(src, flags, text)` / `reFindAll` | match positions in UTF-16 units: `[start, end]` / `[s0, e0, s1, e1, ...]` |
//! | `env(name)` | a variable of the hook's own environment (the request's, never the daemon's), or `null` |
//! | `settingEnum(key)` / `settingNum(key)` | the effective value of the enum / numeric setting described by defaults entry `key` |
//! | `fileSize(path)` | the size in bytes of a regular file, or `null` |
//! | `passwdHome()` | the user's home as the passwd database has it, or `null` |
//! | `realpath(path)` | the canonical path (links resolved), or `null` when it does not exist |
//! | `pathResolve(base, p)` | Node `path.resolve(base, p)` (posix) |
//! | `writeAtomic(rel, text)` | the SCOPED write (`rel` is relative to the home directory, under the state directory): see [`write_atomic`] |
//! | `appendFile(rel, text)` | the SCOPED append (same path rules as `writeAtomic`; one `O_APPEND` write): see [`append_file`] |
//! | `lstat(path)` | JSON `{kind,size,mtimeMs,mode}` of the path itself (links not followed), or `null`: see [`lstat`] |
//! | `realpathEx(path)` | JSON `{path}` or `{error}`: the canonical path, or why there is none: see [`realpath_ex`] |
//! | `isDir(path)` | whether `path` is a directory (links followed) |
//! | `readdir(path)` | sorted entry names of a directory, or `null` (not a directory, or over `script.readdir_max`) |
//! | `readlink(path)` | the target text of a symbolic link, or `null` |
//! | `lockAcquire(rel, group)` / `lockRelease(handle)` | the cross-process lock file (Node lock protocol) under the state directory: see [`lock_acquire`] |
//! | `memory()` | JSON `{available, total}` bytes of the machine: see [`memory`] |
//! | `agents(path)` | the running agents of a transcript (id, description, launching input): see [`agents`] |
//! | `repoContext(dir)` | JSON `{unsure, toplevel, root}` of the checkout around `dir`: see [`repo_context`] |
//! | `cfgLive(key)` | the effective value of a defaults key through the owner's editable layers (`settings.json`, `config.toml`, shipped): see [`cfg_live`] |
//! | `sha1(text)` | lowercase hex SHA-1 of the UTF-8 text |
//! | `tailLines(path, windowBytes, lineMax)` | the last lines of a file with their byte offsets, bounded: see [`tail_lines`] |
//! | `pruneState(prefix, keep)` | the state-file retention sweep of one writer prefix in the state directory (stale files older than the TTL, throttled; `keep` is never removed) |
//! | `log(kind, text)` | one line in the engine's event log (rate-limited by the engine) |
//! | `now()` | milliseconds since the epoch from the engine's one clock (injectable for tests): see [`now_ms`] |
//! | `stateRead(rel)`, `stateRemove(rel)`, `stateSweep(dir, prefix, maxAgeMs, maxRemove)` | scoped read, single-file delete and bounded prefix/age sweep under the state root: see [`state_read`], [`state_remove`], [`state_sweep`] |
//! | `deadlineLeftMs()` | milliseconds left of the request being answered, or `null` |
//! | `exec(prog, args, cwd, envPairs, timeoutMs)` | one allow-listed program, bounded: see [`exec`] |
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

/// Let the interrupt handler know which deadline belongs to the call in progress (`None` when it ends).
pub fn set_deadline(d: Option<std::sync::Arc<std::sync::atomic::AtomicU64>>) {
    DEADLINE.with(|c| *c.borrow_mut() = d);
}

/// Time a host function spent BLOCKED (a child process, a lock wait, a network consult) is not script time: the call's script
/// time limit (`script.time_limit_ms`) is moved out by that long, so a slow `git` never turns into an interrupted script.
pub(super) fn credit_blocking(since: std::time::Instant) {
    let ns = since.elapsed().as_nanos() as u64;
    DEADLINE.with(|c| {
        if let Some(d) = c.borrow().as_ref() {
            let cur = d.load(std::sync::atomic::Ordering::Relaxed);
            if cur != 0 {
                d.store(cur.saturating_add(ns), std::sync::atomic::Ordering::Relaxed);
            }
        }
    });
}

/// Run `f` with `st` as the request state the host functions read.
pub fn with_call<R>(st: Settings, f: impl FnOnce() -> R) -> R {
    CALL.with(|c| *c.borrow_mut() = Some(st));
    EXECS.with(|c| *c.borrow_mut() = 0);
    let r = f();
    // a lock a script still holds when its call ends (an exception, an interrupt) is released here, never left to go stale
    for (_, held, _guard) in HELD.with(|h| std::mem::take(&mut *h.borrow_mut())) {
        held.release();
    }
    CALL.with(|c| *c.borrow_mut() = None);
    r
}

pub(super) fn with_settings<R>(f: impl FnOnce(&Settings) -> R) -> rquickjs::Result<R> {
    CALL.with(|c| c.borrow().as_ref().map(f)).ok_or_else(|| err("settings", defaults::text("script.msg_no_request")))
}

pub(super) fn err(what: &'static str, msg: impl Into<String>) -> Error {
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
            let re = if flags.contains('r') {
                Regex::new(src).ok()
            } else if flags.contains('m') {
                // JavaScript syntax with the `m` flag: `^` and `$` match at line boundaries
                Regex::new(&format!("(?m:{})", jsre::translate(src, flags.contains('i')))).ok()
            } else {
                jsre::try_compile(src, flags.contains('i'))
            }
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
    let Some(cur) = scoped_target(home, rel, text.len(), false)? else { return Ok(false) };
    let style = crate::atomic::Style { skip_sync: defaults::num("script.write_sync") == 0, ..crate::atomic::Style::default() };
    Ok(crate::atomic::write_styled(&cur, text, style).is_ok())
}

/// The scoped append API: append `text` to `rel` (same path rules as [`write_atomic`]; the file is created when absent). The
/// append is one `O_APPEND` write, so concurrent appenders interleave whole texts, never bytes of one text. `false` on an
/// I/O failure.
pub fn append_file(home: &str, rel: &str, text: &str) -> rquickjs::Result<bool> {
    let Some(cur) = scoped_target(home, rel, text.len(), false)? else { return Ok(false) };
    let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&cur) else { return Ok(false) };
    Ok(std::io::Write::write_all(&mut f, text.as_bytes()).is_ok())
}

/// What a scoped call does at its target.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Op {
    /// Atomic replace now.
    Write,
    /// Atomic replace staged until the reply has been delivered (`atomic::write_after_reply`).
    WriteAfterReply,
    /// Append (created when absent).
    Append,
    /// Make the directory (and its parents).
    Mkdir,
    /// Remove a regular file; an absent file is the goal state.
    Remove,
}

/// The scoped file API under any absolute `root` (the home directory, or a project root the script names): `rel` must start with
/// `script.write_root` and obeys every rule of [`write_atomic`]. `true` when the operation took effect (or, for `Remove`, the file
/// is not there); `false` on an I/O failure.
pub fn scoped(root: &str, rel: &str, text: &str, op: Op) -> rquickjs::Result<bool> {
    match op {
        Op::Write => write_atomic(root, rel, text),
        Op::Append => append_file(root, rel, text),
        Op::Remove => state_remove(root, rel),
        Op::Mkdir => Ok(scoped_target(root, rel, 0, true)?.is_some()),
        Op::WriteAfterReply => {
            let Some(path) = scoped_target(root, rel, text.len(), false)? else { return Ok(false) };
            let style = crate::atomic::Style { skip_sync: defaults::num("script.write_sync") == 0, ..crate::atomic::Style::default() };
            Ok(crate::atomic::write_after_reply(&path, text, style).is_ok())
        }
    }
}

/// Validate a scoped write target and prepare its directory: `Err` for a policy violation, `Ok(None)` for an I/O failure,
/// `Ok(Some(path))` for the file to write.
fn scoped_target(home: &str, rel: &str, len: usize, want_dir: bool) -> rquickjs::Result<Option<PathBuf>> {
    if !paths::is_absolute(home) {
        return Err(refused(defaults::text("script.write_why_home")));
    }
    if len as u64 > defaults::num("script.write_max_bytes") {
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
            Ok(m) if (i < last && !m.is_dir()) || (i == last && (want_dir != m.is_dir() || (!want_dir && !m.is_file()))) => return Ok(None),
            _ => {}
        }
    }
    // the root itself may be a link the owner set up (a state directory on another disk); what is refused is a link BELOW it
    let Some(parent) = (if want_dir { Some(cur.as_path()) } else { cur.parent() }) else { return Ok(None) };
    if std::fs::create_dir_all(parent).is_err() {
        return Ok(None);
    }
    let (Ok(real_root), Ok(real_parent)) = (std::fs::canonicalize(&root), std::fs::canonicalize(parent)) else { return Ok(None) };
    if !real_parent.starts_with(&real_root) {
        return Err(refused(defaults::text("script.write_why_link")));
    }
    Ok(Some(cur))
}

/// `lstat(path)` as JSON text: `{"kind":"file"|"dir"|"link"|"other","size":n,"mtimeMs":n,"mode":n}` (the link itself, never its
/// target), `null` when the path does not exist, and `{"kind":"error","code":"<io error kind>"}` when it cannot be examined for any
/// other reason (permission, a file where a directory should be, too many links).
pub fn lstat(path: &str) -> String {
    use std::os::unix::fs::MetadataExt;
    let m = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return "null".into(),
        Err(e) => return serde_json::json!({"kind": "error", "code": format!("{:?}", e.kind())}).to_string(),
    };
    let t = m.file_type();
    let kind = if t.is_symlink() {
        "link"
    } else if t.is_dir() {
        "dir"
    } else if t.is_file() {
        "file"
    } else {
        "other"
    };
    serde_json::json!({"kind": kind, "size": m.len(), "mtimeMs": m.mtime() as f64 * 1000.0 + (m.mtime_nsec() / 1_000_000) as f64, "mode": m.mode()}).to_string()
}

/// `realpathEx(path)`: the canonical path as `{"path":s}`, or `{"error":"NotFound"}` / `{"error":"<io error kind>"}` when it cannot be
/// resolved, so a script can tell a path that does not exist from one it could not examine.
pub fn realpath_ex(path: &str) -> String {
    match std::fs::canonicalize(path) {
        Ok(p) => serde_json::json!({"path": p.to_string_lossy()}).to_string(),
        Err(e) => serde_json::json!({"error": format!("{:?}", e.kind())}).to_string(),
    }
}

/// `readdir(path)`: the entry names of a directory (not `.` and `..`), sorted bytewise, at most `script.readdir_max`; `null`
/// when it is not a readable directory, or holds more entries than the cap (a partial listing is never returned as a whole).
pub fn readdir(path: &str) -> Option<Vec<String>> {
    let cap = defaults::num("script.readdir_max") as usize;
    let mut names = Vec::new();
    for e in std::fs::read_dir(path).ok()? {
        names.push(e.ok()?.file_name().to_string_lossy().into_owned());
        if names.len() > cap {
            return None;
        }
    }
    names.sort();
    Some(names)
}

/// Serializes the lock takers of this process before they reach the lock file, so two threads of the daemon never wait on each
/// other's lock file (processes cannot share a mutex, which is what the file is for).
static IN_PROCESS: std::sync::Mutex<()> = std::sync::Mutex::new(());

type Held = (u64, crate::checks::guardkit::nodelock::Held, std::sync::MutexGuard<'static, ()>);

thread_local! {
    static CLOCK: RefCell<Option<f64>> = const { RefCell::new(None) };
    /// The interpreter's interrupt deadline of the call in progress (nanoseconds since the pool epoch; 0 = none) and the epoch.
    static DEADLINE: RefCell<Option<std::sync::Arc<std::sync::atomic::AtomicU64>>> = const { RefCell::new(None) };
    static HELD: RefCell<Vec<Held>> = const { RefCell::new(Vec::new()) };
    static EXECS: RefCell<u64> = const { RefCell::new(0) };
}

/// `lockAcquire(rel, group)`: take the cross-process lock file `rel` (the scoped path rules of [`write_atomic`]) with the Node
/// lock protocol of `companion/lib/lock.js`, timings from the defaults group `group` (`<group>.lock_*`). Returns a handle number,
/// or `null` when the lock could not be taken (the script decides what that means; the swarm guard fails open). A lock still
/// held when the script call ends is released by the host. At most one lock is held per call.
pub fn lock_acquire(home: &str, rel: &str, group: &str) -> rquickjs::Result<Option<f64>> {
    let Some(params) = crate::checks::guardkit::nodelock::Params::from_group(group) else {
        return Err(err("lockAcquire", defaults::render("script.msg_unknown_key", &[("key", &group)])));
    };
    if HELD.with(|h| !h.borrow().is_empty()) {
        return Ok(None);
    }
    let Some(path) = scoped_target(home, rel, 0, false)? else { return Ok(None) };
    let started = std::time::Instant::now();
    let guard = IN_PROCESS.lock().unwrap_or_else(|e| e.into_inner());
    let taken = crate::checks::guardkit::nodelock::acquire(&path.to_string_lossy(), params);
    credit_blocking(started);
    let Some(held) = taken else { return Ok(None) };
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    HELD.with(|h| h.borrow_mut().push((id, held, guard)));
    Ok(Some(id as f64))
}

/// `lockRelease(handle)`: release a lock taken in this call; `false` when it was not held (or no longer ours).
pub fn lock_release(id: f64) -> bool {
    let Some(i) = HELD.with(|h| h.borrow().iter().position(|(n, _, _)| *n as f64 == id)) else { return false };
    let (_, held, _guard) = HELD.with(|h| h.borrow_mut().remove(i));
    held.release()
}

/// `memory()`: `{"available": bytes|null, "total": bytes}` of this machine (available counts reclaimable cache; `null` when the
/// read failed, `total` 0 when unknown).
pub fn memory() -> String {
    use super::sysmem::{HostMem, MemSource};
    serde_json::json!({"available": HostMem.available(), "total": HostMem.total()}).to_string()
}

/// `agents(path)`: the agents a transcript shows as running, from the engine's streaming transcript scan (widened to a longer
/// window when the default one shows none): `null` (unreadable, or the count cannot be trusted), `{"unsure":true}` (a line JavaScript might read differently, or a relative path), else
/// `{"rows":[{"id","description","spawnInput"}]}` (`spawnInput`: the input of the launching tool call when it was in the
/// window, else `null`).
pub fn agents(path: &str) -> String {
    use crate::checks::agent_scan;
    let opts = agent_scan::Opts { now_ms: crate::checks::replykit::io::now_ms(), ignore_unanswered_stops: false };
    match agent_scan::running_agents_or_null(path, &opts) {
        Err(_) => r#"{"unsure":true}"#.into(),
        Ok(None) => "null".into(),
        Ok(Some(rows)) => {
            let rows: Vec<serde_json::Value> =
                rows.iter().map(|r| serde_json::json!({"id": r.id, "description": r.description, "spawnInput": r.rec.spawn_input})).collect();
            serde_json::json!({"rows": rows}).to_string()
        }
    }
}

/// `repoContext(dir)`: the checkout around `dir` as the Node `resolveContext(dir, {missingPath: 'ancestor'})` finds it:
/// `{"unsure":bool,"toplevel":s|null,"root":s|null}` (`root`: the outermost superproject checkout).
pub fn repo_context(dir: &str) -> rquickjs::Result<String> {
    let env = with_settings(|st| crate::reqenv::RequestEnv::from_pairs(st.env.clone()))?;
    let c = crate::checks::jsport::ident::resolve_context(dir, true, &env);
    Ok(serde_json::json!({"unsure": c.unsure, "toplevel": c.toplevel, "root": c.worktree_root}).to_string())
}

/// The clock override of the current thread, in milliseconds since the epoch (tests; `None` = the system clock).
pub fn set_clock(ms: Option<f64>) {
    CLOCK.with(|c| *c.borrow_mut() = ms);
}

/// `now()`: milliseconds since the Unix epoch. One clock for every script (`ah.clock.now()`), injectable with [`set_clock`] so a
/// test pins time without touching `Date`.
pub fn now_ms() -> f64 {
    CLOCK.with(|c| *c.borrow()).unwrap_or_else(crate::checks::replykit::io::now_ms)
}

/// `stateRead(rel)`: the text of a file under the state root (the scoped path rules of [`write_atomic`], but nothing is created),
/// at most `script.read_max_bytes`; `null` when absent, unreadable or over the cap.
pub fn state_read(home: &str, rel: &str) -> rquickjs::Result<Option<String>> {
    let Some(path) = scoped_existing(home, rel)? else { return Ok(None) };
    let cap = defaults::num("script.read_max_bytes");
    if std::fs::metadata(&path).map_or(true, |m| !m.is_file() || m.len() > cap) {
        return Ok(None);
    }
    Ok(std::fs::read(&path).ok().map(crate::checks::guardkit::text::lossy_owned))
}

/// `stateRemove(rel)`: delete ONE regular file under the state root (the scoped path rules; a link, a directory or an absent
/// file is left alone). `true` when the file is gone (an absent file is the goal state).
pub fn state_remove(home: &str, rel: &str) -> rquickjs::Result<bool> {
    let Some(path) = scoped_existing(home, rel)? else { return Ok(true) };
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.file_type().is_file() => Ok(std::fs::remove_file(&path).is_ok()),
        Ok(_) => Ok(false),
        Err(_) => Ok(true),
    }
}

/// `stateSweep(dirRel, prefix, maxAgeMs, maxRemove)`: delete the regular files directly inside a directory under the state root
/// whose name starts with `prefix` (never empty) and whose modification time is older than `maxAgeMs`, at most
/// `min(maxRemove, script.sweep_max_remove)` of them, oldest first. Returns how many were removed. Links, directories and files
/// of other names are never touched.
pub fn state_sweep(home: &str, dir_rel: &str, prefix: &str, max_age_ms: f64, max_remove: f64) -> rquickjs::Result<f64> {
    if prefix.is_empty() || prefix.contains('/') || !max_age_ms.is_finite() || max_age_ms < 0.0 {
        return Err(refused(defaults::text("script.write_why_path")));
    }
    let Some(dir) = scoped_existing(home, dir_rel)? else { return Ok(0.0) };
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(0.0) };
    let now = now_ms();
    let mut old: Vec<(f64, PathBuf)> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(m) = std::fs::symlink_metadata(e.path()) else { continue };
        if !name.starts_with(prefix) || !m.file_type().is_file() {
            continue;
        }
        let mtime = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        if now - mtime > max_age_ms {
            old.push((mtime, e.path()));
        }
    }
    old.sort_by(|a, b| a.0.total_cmp(&b.0));
    let cap = (max_remove.max(0.0) as usize).min(defaults::num("script.sweep_max_remove") as usize);
    Ok(old.into_iter().take(cap).filter(|(_, p)| std::fs::remove_file(p).is_ok()).count() as f64)
}

/// The path of an EXISTING-or-not target under the state root, validated like [`scoped_target`] but creating nothing; a link at
/// any existing part below the root is a refusal. `Ok(None)` when the path does not exist.
fn scoped_existing(home: &str, rel: &str) -> rquickjs::Result<Option<PathBuf>> {
    if !paths::is_absolute(home) {
        return Err(refused(defaults::text("script.write_why_home")));
    }
    if rel.len() as u64 > defaults::num("script.write_path_max") || rel.is_empty() || rel.contains('\0') {
        return Err(refused(defaults::text("script.write_why_path")));
    }
    let parts: Vec<&str> = rel.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") || parts[0] != defaults::text("script.write_root") {
        return Err(refused(defaults::text("script.write_why_path")));
    }
    let mut cur = Path::new(home).join(parts[0]);
    for part in parts.iter().skip(1) {
        cur.push(part);
        match std::fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => return Err(refused(defaults::text("script.write_why_link"))),
            Ok(_) => {}
            Err(_) => return Ok(None),
        }
    }
    Ok(Some(cur))
}

/// `cfgLive(key)`: the effective value of a defaults key as JSON text, resolved through the editable layers (the request home's
/// `settings.json`, then the engine's `config.toml`, then the shipped default), so an owner edit applies on the next call.
/// Cached per pair of files (path, size, modification time) and per defaults generation, so a call costs two `stat`s.
pub fn cfg_live(key: &str) -> rquickjs::Result<String> {
    use crate::cfgstore::{self, Effective, Paths};
    use std::sync::{Arc, Mutex};
    type Stamp = Vec<(PathBuf, Option<(std::time::SystemTime, u64)>)>;
    static CACHE: Mutex<Option<(Stamp, u64, Arc<Effective>)>> = Mutex::new(None);
    entry(key)?;
    let home = with_settings(|st| st.home.clone())?;
    let base = Path::new(&home).join(defaults::text("paths.base_dir"));
    let paths = Paths { user: Paths::from_env().user, settings: Some(base.join(defaults::text("config.settings_file"))) };
    let one = |p: &PathBuf| (p.clone(), std::fs::metadata(p).ok().map(|m| (m.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH), m.len())));
    let mut now: Stamp = vec![one(&paths.user)];
    if let Some(s) = &paths.settings {
        now.push(one(s));
    }
    let generation = defaults::generation();
    let eff = {
        let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        match g.as_ref() {
            Some((s, at, e)) if *s == now && *at == generation => Arc::clone(e),
            _ => {
                let (layers, _problems) = cfgstore::load_layers_cold(&paths);
                let e = Arc::new(Effective::resolve(&layers, &|_| None));
                *g = Some((now, generation, Arc::clone(&e)));
                e
            }
        }
    };
    Ok(eff.get(key).map_or_else(|| entry(key).map(|e| e.value.to_json().to_string()), |r| Ok(r.value.to_string()))?)
}

/// `tailLines(path, windowBytes, lineMax)`: the last `windowBytes` (clamped to `script.tail_max_bytes`) of a file as lines, the
/// partial first line dropped when the window starts inside the file: JSON `{"lines":[[offset, text|null], ...]}`, `offset` the
/// byte position of the line in the file; `text` is `null` for a line over `lineMax` bytes (never stored) or not valid UTF-8.
/// `null` when the file cannot be read.
pub fn tail_lines(path: &str, window: f64, line_max: f64) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let cap = defaults::num("script.tail_max_bytes");
    let window = if window.is_finite() && window > 0.0 { (window as u64).min(cap) } else { cap };
    let line_max = if line_max.is_finite() && line_max > 0.0 { line_max as usize } else { usize::MAX / 2 };
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let start = size.saturating_sub(window);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut r = std::io::BufReader::with_capacity(65_536, f.take(size - start));
    let mut offset = start;
    let mut lines: Vec<serde_json::Value> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut first = start > 0;
    loop {
        buf.clear();
        let mut total = 0usize;
        let mut over = false;
        loop {
            let chunk = std::io::BufRead::fill_buf(&mut r).ok()?;
            if chunk.is_empty() {
                break;
            }
            let (take, found) = match chunk.iter().position(|b| *b == b'\n') {
                Some(i) => (i + 1, true),
                None => (chunk.len(), false),
            };
            total += take;
            if !over {
                if buf.len() + take > line_max + 1 {
                    over = true;
                    buf.clear();
                } else {
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
            std::io::BufRead::consume(&mut r, take);
            if found {
                break;
            }
        }
        if total == 0 {
            break;
        }
        let at = offset;
        offset += total as u64;
        if first {
            first = false; // the window starts inside a line: that partial line is not a line
            continue;
        }
        if !over && buf.last() == Some(&b'\n') {
            buf.pop();
        }
        let text = if over { None } else { String::from_utf8(std::mem::take(&mut buf)).ok() };
        lines.push(serde_json::json!([at, text]));
    }
    Some(serde_json::json!({ "lines": lines }).to_string())
}

/// `deadlineLeftMs()`: milliseconds left of the request the engine is answering (the caller is not waiting past it), or `null`
/// outside a daemon request. A script that would start a slow step checks it first.
pub fn deadline_left_ms() -> Option<f64> {
    crate::deadline::remaining().map(|d| d.as_millis() as f64)
}

/// `exec(prog, args, cwd, envPairs, timeoutMs)`: run one allow-listed program (`script.exec_programs`, a bare name) with the
/// request's environment (never the daemon's) plus `envPairs` (`[k, v, k, v, ...]`) on top, in `cwd` when given, through the
/// engine's bounded runner (own process group, killed at the timeout, output drained while it runs, no stdin). The timeout is
/// clamped to `script.exec_timeout_max_ms`, at most `script.exec_max_calls` runs per script call, each stream is cut at
/// `script.exec_output_max_bytes` (`truncated`). Result as JSON text: `{"status":n|null,"stdout":s,"stderr":s,"truncated":b}`;
/// `null` when the program is not allowed, the budget is spent, or it could not be started, ran past its timeout or its output
/// could not be collected (no answer is better than a partial one).
pub fn exec(prog: &str, args: &[String], cwd: Option<&str>, env_pairs: &[String], timeout_ms: f64) -> rquickjs::Result<String> {
    if !defaults::list("script.exec_programs").contains(&prog) {
        return Ok("null".into());
    }
    let spent = EXECS.with(|c| {
        let mut c = c.borrow_mut();
        *c += 1;
        *c > defaults::num("script.exec_max_calls")
    });
    if spent {
        return Ok("null".into());
    }
    let base = with_settings(|st| st.env.clone())?;
    let mut cmd = std::process::Command::new(prog);
    cmd.args(args).env_clear();
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    for (k, v) in &base {
        cmd.env(k, v);
    }
    for kv in env_pairs.chunks_exact(2) {
        cmd.env(&kv[0], &kv[1]);
    }
    let started = std::time::Instant::now();
    let cap_ms = defaults::num("script.exec_timeout_max_ms");
    let ms = if timeout_ms.is_finite() && timeout_ms > 0.0 { (timeout_ms as u64).min(cap_ms) } else { cap_ms };
    let ran = crate::proc::run(cmd, prog, std::time::Duration::from_millis(ms), defaults::millis("script.exec_poll_ms"));
    credit_blocking(started);
    let Ok(o) = ran else { return Ok("null".into()) };
    let cap = defaults::num("script.exec_output_max_bytes") as usize;
    let truncated = o.stdout.len() > cap || o.stderr.len() > cap;
    let cut = |b: &[u8]| crate::checks::guardkit::text::lossy_owned(b[..b.len().min(cap)].to_vec());
    Ok(serde_json::json!({"status": o.status.code(), "stdout": cut(&o.stdout), "stderr": cut(&o.stderr), "truncated": truncated}).to_string())
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
    h.set(
        "appendFile",
        Function::new(c.clone(), |rel: String, text: String| -> rquickjs::Result<bool> {
            let home = with_settings(|st| st.home.clone())?;
            append_file(&home, &rel, &text)
        })?,
    )?;
    h.set(
        "lockAcquire",
        Function::new(c.clone(), |rel: String, group: String| -> rquickjs::Result<Option<f64>> {
            let home = with_settings(|st| st.home.clone())?;
            lock_acquire(&home, &rel, &group)
        })?,
    )?;
    h.set("lockRelease", Function::new(c.clone(), |id: f64| lock_release(id))?)?;
    h.set("memory", Function::new(c.clone(), memory)?)?;
    h.set("agents", Function::new(c.clone(), |p: String| agents(&p))?)?;
    h.set("repoContext", Function::new(c.clone(), |d: String| -> rquickjs::Result<String> { repo_context(&d) })?)?;
    h.set("cfgLive", Function::new(c.clone(), |k: String| -> rquickjs::Result<String> { cfg_live(&k) })?)?;
    h.set("sha1", Function::new(c.clone(), |t: String| crate::checks::replykit::io::sha1_hex(&t))?)?;
    h.set("tailLines", Function::new(c.clone(), |p: String, w: f64, l: f64| tail_lines(&p, w, l))?)?;
    h.set(
        "pruneState",
        Function::new(c.clone(), |prefix: String, keep: Option<String>| -> rquickjs::Result<()> {
            let home = with_settings(|st| st.home.clone())?;
            crate::checks::replykit::io::prune_stale(&Path::new(&home).join(defaults::text("replykit.state_dir")), &prefix, keep.as_deref());
            Ok(())
        })?,
    )?;
    h.set("log", Function::new(c.clone(), |kind: String, text: String| crate::discard::note("script_log", &format!("{kind}: {text}")))?)?;
    h.set("deadlineLeftMs", Function::new(c.clone(), deadline_left_ms)?)?;
    h.set("realpathEx", Function::new(c.clone(), |p: String| realpath_ex(&p))?)?;
    h.set("isDir", Function::new(c.clone(), |p: String| std::fs::metadata(p).is_ok_and(|m| m.is_dir()))?)?;
    h.set("lstat", Function::new(c.clone(), |p: String| lstat(&p))?)?;
    h.set("readdir", Function::new(c.clone(), |p: String| readdir(&p))?)?;
    h.set("readlink", Function::new(c.clone(), |p: String| std::fs::read_link(p).ok().map(|r| r.to_string_lossy().into_owned()))?)?;
    h.set(
        "exec",
        Function::new(c.clone(), |prog: String, args: Vec<String>, cwd: Option<String>, env: Vec<String>, timeout: f64| -> rquickjs::Result<String> {
            exec(&prog, &args, cwd.as_deref(), &env, timeout)
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
    super::host_io::install(c, &h)?;
    super::host_b3::install(c, &h)?;
    c.globals().set("ahHost", h)?;
    Ok(())
}
