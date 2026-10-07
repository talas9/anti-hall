//! Built-in `check = "progress-prune"`: a port of the Node SessionStart hook `hooks/progress-prune.js`.
//!
//! Two jobs, both fail-open. (1) The gitignore reminder: when the project has a `.anti-hall/` directory that git does not
//! ignore, say so once a week per project. (2) The prune: a stale per-session progress file (from a day before today,
//! untouched for the safety window) is appended to its history ledger and only then removed; the pass is throttled per
//! working directory. Nothing is removed unless its content was appended first (D59: derived state, archived not lost).
//!
//! The project root is the git top level of the working directory, read from the file system the way
//! `companion/lib/identity.js` reads it. A `.git` file in a shape this port does not read exactly hands the hook back to
//! Node, before anything is written.
use super::jval::{J, Parsed, parse};
use super::time::{iso_date, iso_string};
use super::{emit, home_of, is_session_start, join, judge_child, now_ms, read_text, switch_on};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::checks::guardkit::text::is_js_space;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};

/// Serializes the passes of this process (see `decide`).
static PASS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The registered `progress-prune` check.
pub struct ProgressPrune;

impl Check for ProgressPrune {
    fn name(&self) -> &'static str {
        "progress-prune"
    }

    fn summary(&self) -> &'static str {
        defaults::text("session.progress_prune_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if !is_session_start(s) {
            return Some(Verdict::Defer);
        }
        Some(decide(payload, env))
    }
}

/// `under(child, parent)` of `identity.js`.
fn under(child: &str, parent: &str) -> bool {
    child == parent || child.starts_with(&format!("{parent}/"))
}

/// The private git directory a checkout rooted at `t` names (`gitdirOf(...).G`), or `Ok(None)` when `t/.git` is not a
/// usable one; `Err(())` for a `.git` file whose shape this port does not read exactly.
fn gitdir_of(t: &str) -> Result<Option<String>, ()> {
    let dot_git = join(t, defaults::text("session.dot_git"));
    let Ok(meta) = std::fs::symlink_metadata(&dot_git) else { return Ok(None) };
    if meta.is_dir() {
        return Ok(std::fs::canonicalize(&dot_git).ok().map(|p| p.to_string_lossy().to_string()));
    }
    let Some(text) = read_text(&dot_git) else { return Ok(None) };
    let tag = defaults::text("session.gitdir_tag");
    if !text.contains(tag) {
        return Ok(None); // no `gitdir:` anywhere: the Node pattern cannot match
    }
    // the usual file: one line, `gitdir:`, one space, the path; anything else is read by JavaScript's pattern, not here
    let line = text.strip_suffix('\n').unwrap_or(&text);
    let path = match line.strip_prefix(tag).and_then(|r| r.strip_prefix(' ')) {
        Some(p) if !p.is_empty() && !p.starts_with(is_js_space) && !p.ends_with(is_js_space) && !p.contains(['\n', '\r', '\u{2028}', '\u{2029}']) => p,
        _ => return Err(()),
    };
    let target = if is_absolute(path) { path.to_string() } else { join(t, path) };
    let Ok(real) = std::fs::canonicalize(&target) else { return Ok(None) };
    Ok(real.is_dir().then(|| real.to_string_lossy().to_string()))
}

/// The git top level of `cwd` (`resolveContext(cwd).toplevel`): the nearest ancestor holding a `.git` entry, when that
/// entry names a usable git directory and `cwd` is not inside it. `Ok(None)` for a missing path, a non-repository or an
/// unusable `.git`.
fn toplevel_of(cwd: &str) -> Result<Option<String>, ()> {
    let Ok(real) = std::fs::canonicalize(resolve_abs(cwd)) else { return Ok(None) };
    let real = real.to_string_lossy().to_string();
    let mut d = real.clone();
    let top = loop {
        if std::fs::symlink_metadata(join(&d, defaults::text("session.dot_git"))).is_ok() {
            break d;
        }
        let parent = Path::new(&d).parent().map(|p| p.to_string_lossy().to_string());
        match parent {
            Some(p) if !p.is_empty() && p != d => d = p,
            _ => return Ok(None),
        }
    };
    match gitdir_of(&top)? {
        Some(g) if !under(&real, &g) => Ok(Some(top)),
        _ => Ok(None),
    }
}

/// `repoRoot(cwd)`: the git top level, or `cwd` itself when there is none or it is the home directory.
fn repo_root(cwd: &str, top: Option<&str>, home: &str) -> String {
    let real_home = std::fs::canonicalize(home).map_or_else(|_| home.to_string(), |p| p.to_string_lossy().to_string());
    match top {
        Some(t) if t != real_home => t.to_string(),
        _ => cwd.to_string(),
    }
}

/// What the gitignore probe came to.
enum Probe {
    /// git exited with this code (0 ignored, 1 not ignored).
    Exit(i32),
    /// git could not be run, or was killed by a signal: Node's `spawnSync` reports an error and the reminder stays quiet.
    Failed,
    /// git did not answer within the engine's limit: the client's whole exchange is shorter than Node's own probe limit, so
    /// the hook goes back to Node (before anything is written) instead of answering after the client gave up.
    Slow,
}

/// `git -C root check-ignore -q .anti-hall/probe` with the git environment the client forwarded.
fn check_ignore(root: &str, env: &RequestEnv) -> Probe {
    let mut cmd = Command::new(defaults::text("session.git_binary"));
    cmd.args(["-C", root])
        .args(defaults::list("session.check_ignore_args"))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .env_clear();
    let scrub = defaults::list("session.git_scrub_env");
    for (k, v) in env.to_map() {
        if !scrub.contains(&k.as_str()) {
            cmd.env(k, v);
        }
    }
    let Ok(mut child) = cmd.spawn() else { return Probe::Failed };
    let pid = child.id() as i32;
    let start = std::time::Instant::now();
    let limit = std::time::Duration::from_millis(defaults::num("session.gitignore_probe_ms"));
    let poll = std::time::Duration::from_millis(defaults::num("session.git_poll_ms"));
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return st.code().map_or(Probe::Failed, Probe::Exit),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(poll),
            _ => {
                // the whole group, so a git helper does not outlive the limit
                unsafe { libc::kill(-pid, libc::SIGKILL) };
                let _ = child.wait();
                return Probe::Slow;
            }
        }
    }
}

/// A state file as the Node hooks read it: an object (anything else, or an unreadable file, is an empty one). `Err(())`
/// when the text may parse differently from `JSON.parse`.
fn read_state(file: &str) -> Result<J, ()> {
    match read_text(file).map(|t| parse(&t)) {
        Some(Parsed::Ok(v @ J::Obj(_))) => Ok(v),
        Some(Parsed::Unsure) => Err(()),
        _ => Ok(J::Obj(Vec::new())),
    }
}

/// `fs.mkdirSync(dirname, {recursive}); fs.writeFileSync(file, JSON.stringify(state))`.
fn write_state(file: &str, state: &J) -> std::io::Result<()> {
    if let Some(dir) = Path::new(file).parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(file, state.stringify())
}

/// The gitignore reminder (`gitignoreHint(cwd)`): the advisory text to print, if any. Writes the weekly marker only when
/// the reminder is due. `Err(())` defers.
fn gitignore_hint(top: Option<&str>, home: &str, env: &RequestEnv, st: &Settings, now: f64) -> Result<Option<String>, ()> {
    if !switch_on(st, "session.setting_gitignore_hint") {
        return Ok(None);
    }
    let Some(root) = top else { return Ok(None) };
    if !Path::new(&join(root, defaults::text("session.anti_hall_dir"))).is_dir() {
        return Ok(None);
    }
    match check_ignore(root, env) {
        Probe::Exit(1) => {}
        Probe::Slow => return Err(()),
        Probe::Exit(_) | Probe::Failed => return Ok(None),
    }
    let file = join(&join(home, defaults::text("session.state_dir")), defaults::text("session.gitignore_state_file"));
    let mut state = read_state(&file)?;
    let last = state.get(root).and_then(J::finite).unwrap_or(0.0);
    let age = now - last;
    if age >= 0.0 && age < defaults::num("session.gitignore_remind_ms") as f64 {
        return Ok(None);
    }
    state.set(root, J::Num(now));
    if write_state(&file, &state).is_err() {
        return Ok(None); // Node throws before it prints
    }
    Ok(Some(msg::message(
        Kind::Warn,
        defaults::text("session.gitignore_guard"),
        &Parts {
            what: defaults::text("session.gitignore_what"),
            why: defaults::text("session.gitignore_why"),
            instead: defaults::text("session.gitignore_instead"),
            ..Parts::default()
        },
    )))
}

/// `cwdKey(cwd)`: the 31-hash of the UTF-16 units in base 36 behind a fixed prefix.
fn cwd_key(cwd: &str) -> String {
    let mut h: i32 = 0;
    for u in cwd.encode_utf16() {
        h = h.wrapping_shl(5).wrapping_sub(h).wrapping_add(i32::from(u));
    }
    let mut n = i64::from(h).unsigned_abs();
    let mut digits = Vec::new();
    loop {
        digits.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            break;
        }
    }
    format!("{}{}", defaults::text("session.cwd_key_prefix"), digits.iter().rev().collect::<String>())
}

/// `blockquote(content)`: every line behind `> `, one trailing newline.
fn blockquote(content: &str) -> String {
    let mut out = String::new();
    let mut rest = content;
    loop {
        let (line, tail) = match rest.find('\n') {
            Some(i) => (&rest[..i], Some(&rest[i + 1..])),
            None => (rest, None),
        };
        out.push_str(defaults::text("session.quote_prefix"));
        match tail {
            Some(t) => {
                // `split(/\r?\n/)` takes a carriage return before a line feed with it; the last line keeps its own
                out.push_str(line.strip_suffix('\r').unwrap_or(line));
                out.push('\n');
                rest = t;
            }
            None => {
                out.push_str(line);
                break;
            }
        }
    }
    out.push('\n');
    out
}

/// Append a progress file to its history ledger and remove it only after the append succeeded.
fn archive_and_delete(progress: &Path, history: &Path, pruned_at: &str) {
    let Some(content) = read_text(&progress.to_string_lossy()) else { return };
    let entry = msg::render("session.archive_entry", &[("pruned_at", pruned_at), ("quote", &blockquote(&content))]);
    let appended = (|| -> std::io::Result<()> {
        if let Some(dir) = history.parent() {
            std::fs::create_dir_all(dir)?;
        }
        use std::io::Write;
        std::fs::OpenOptions::new().append(true).create(true).open(history)?.write_all(entry.as_bytes())?;
        std::fs::remove_file(progress)
    })();
    let _ = appended; // fail-safe: nothing is removed before the append succeeded
}

/// Names of a directory's entries that satisfy `keep`, in name order (as `readdirSync` lists them).
fn entries(dir: &Path, keep: impl Fn(&std::fs::FileType) -> bool) -> Option<Vec<String>> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| keep(&t)))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    Some(v)
}

/// `pruneProject(cwd, now)`; `false` when the progress directory cannot be listed (Node throws, so no throttle mark).
fn prune_project(root: &str, now: f64) -> bool {
    let progress = Path::new(root).join(defaults::text("session.anti_hall_dir")).join(defaults::text("session.progress_dir"));
    let today = iso_date(now);
    let Some(all) = std::fs::read_dir(&progress).ok().map(|rd| {
        let mut v: Vec<(String, bool)> =
            rd.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().is_ok_and(|t| t.is_dir()))).collect();
        v.sort();
        v
    }) else {
        return false;
    };
    let skip = defaults::list("session.progress_skip");
    let pruned_at = iso_string(now);
    for (date_dir, is_dir) in all {
        if !is_dir || date_dir == today || skip.contains(&date_dir.as_str()) {
            continue;
        }
        let dir = progress.join(&date_dir);
        let Some(files) = entries(&dir, std::fs::FileType::is_file) else { continue };
        for name in files.into_iter().filter(|n| n.ends_with(defaults::text("session.md_ext"))) {
            let file = dir.join(&name);
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let ms = |d: std::time::Duration| d.as_secs() as f64 * 1000.0 + f64::from(d.subsec_nanos()) / 1e6;
            let mtime = meta.modified().map_or(0.0, |t| match t.duration_since(std::time::UNIX_EPOCH) {
                Ok(d) => ms(d),
                Err(e) => -ms(e.duration()),
            });
            if now - mtime <= defaults::num("session.prune_safety_ms") as f64 {
                continue;
            }
            let session = name.strip_suffix(defaults::text("session.md_ext")).unwrap_or(&name);
            let history = Path::new(root)
                .join(defaults::text("session.anti_hall_dir"))
                .join(defaults::text("session.history_dir"))
                .join(&date_dir)
                .join(format!("{session}{}", defaults::text("session.md_ext")));
            archive_and_delete(&file, &history, &pruned_at);
        }
    }
    true
}

fn decide(payload: &Value, env: &RequestEnv) -> Verdict {
    if judge_child(env) {
        return Verdict::Allow;
    }
    let Some(cwd) = payload.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) else { return Verdict::Allow };
    let Some(home) = home_of(env) else { return Verdict::Defer };
    // a relative working directory is resolved against the hook's own directory, which the daemon does not know
    if !is_absolute(cwd) {
        return Verdict::Defer;
    }
    let Ok(top) = toplevel_of(cwd) else { return Verdict::Defer };
    // One pass at a time in this process: two sessions of one project starting together would otherwise both archive the same
    // file, or both print the reminder (the Node hooks, separate processes, have that race; the engine does not need it).
    let _one_at_a_time = PASS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let st = Settings::from_env(env);
    let now = now_ms();
    let state_file = join(&join(&home, defaults::text("session.state_dir")), defaults::text("session.progress_state_file"));
    let Ok(mut state) = read_state(&state_file) else { return Verdict::Defer };

    // from here on nothing defers: the hint may already have written its marker
    let hint = match gitignore_hint(top.as_deref(), &home, env, &st, now) {
        Ok(h) => h,
        Err(()) => return Verdict::Defer,
    };
    let verdict = |hint: Option<String>| hint.map_or(Verdict::Allow, |h| emit(&h));
    if !switch_on(&st, "session.setting_progress_prune") {
        return verdict(hint);
    }
    let key = cwd_key(cwd);
    let last = state.get(&key).filter(|s| s.is_obj()).and_then(|s| s.get("lastPrunedAt")).and_then(J::finite).unwrap_or(0.0);
    let age = now - last;
    if age >= 0.0 && age < defaults::num("session.prune_throttle_ms") as f64 {
        return verdict(hint);
    }
    let root = repo_root(cwd, top.as_deref(), &home);
    if prune_project(&root, now) {
        state.set(&key, J::Obj(vec![("lastPrunedAt".to_string(), J::Num(now))]));
        let _ = write_state(&state_file, &state);
    }
    verdict(hint)
}

/// Test access to `cwd_key`.
#[cfg(test)]
pub(super) fn cwd_key_for_test(cwd: &str) -> String {
    cwd_key(cwd)
}

/// Test access to `blockquote`.
#[cfg(test)]
pub(super) fn blockquote_for_test(content: &str) -> String {
    blockquote(content)
}
