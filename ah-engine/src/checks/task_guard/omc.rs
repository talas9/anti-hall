//! `hooks/omc-detect.js` `isOmcLoopActive`: an oh-my-claudecode autonomous loop (ralph, ultrawork, autopilot, ...) is
//! running for this session, so task-guard steps aside instead of deadlocking against it.
use super::demand::parse_js;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsval::{DateParse, Js, date_parse};
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure};
use crate::defaults;
use std::path::{Path, PathBuf};

/// The kill switches: `DISABLE_OMC=1`, or `persistent-mode` in the comma list `OMC_SKIP_HOOKS`.
fn kill_switch(st: &Settings) -> bool {
    if st.env.get(defaults::text("task_guard.omc_disable_env")).map(String::as_str) == Some(defaults::text("task_guard.omc_disable_value")) {
        return true;
    }
    let skip = st.env.get(defaults::text("task_guard.omc_skip_env")).map(String::as_str).unwrap_or("");
    skip.split(',').any(|s| js_trim(s) == defaults::text("task_guard.omc_skip_token"))
}

/// Read a small JSON file the way the detector does: `Ok(None)` when it is missing, unreadable, larger than `max` or not
/// JSON (Node's catch), [`Unsure`] when only JavaScript might read it.
fn small_json(p: &Path, max: u64) -> R<Option<Js>> {
    let Ok(md) = std::fs::metadata(p) else { return Ok(None) };
    if md.len() > max {
        return Ok(None);
    }
    let Ok(b) = std::fs::read(p) else { return Ok(None) };
    parse_js(&crate::checks::guardkit::text::lossy_owned(b))
}

/// `settingsFileEnablesOmc(file)`: `enabledPlugins["oh-my-claudecode@omc"] === true`.
fn enables_omc(p: &Path) -> R<bool> {
    let Some(v) = small_json(p, defaults::num("task_guard.omc_settings_max_bytes"))? else { return Ok(false) };
    Ok(matches!(v.get(defaults::text("task_guard.omc_plugins_key")).and_then(|pl| pl.get(defaults::text("task_guard.omc_plugin_id"))), Some(Js::Bool(true))))
}

/// `omcEnabled(cwd)`: the user settings file, then the project's `.claude/settings.json` and `settings.local.json`.
fn omc_enabled(st: &Settings, cwd: Option<&str>) -> R<bool> {
    let claude = defaults::text("task_guard.omc_claude_dir");
    if enables_omc(&Path::new(&st.home).join(claude).join(defaults::text("task_guard.omc_settings_file")))? {
        return Ok(true);
    }
    if let Some(cwd) = cwd {
        let dir = Path::new(cwd).join(claude);
        for f in defaults::list("task_guard.omc_project_settings") {
            if enables_omc(&dir.join(f))? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `resolveStateRoot(cwd)`: `<cwd>/.omc/state` when it is a directory, else `~/.omc/state`.
fn state_root(st: &Settings, cwd: Option<&str>) -> PathBuf {
    let rel: PathBuf = defaults::list("task_guard.omc_state_dir").iter().collect();
    if let Some(cwd) = cwd {
        let p = Path::new(cwd).join(&rel);
        if std::fs::metadata(&p).is_ok_and(|m| m.is_dir()) {
            return p;
        }
    }
    Path::new(&st.home).join(rel)
}

/// `new Date(v).getTime()` of a timestamp field as the detector maps it: a number as is, a string parsed, else 0; NaN as 0.
fn ts_of(v: Option<&Js>) -> R<f64> {
    let n = match v {
        Some(Js::Num(n)) => *n,
        Some(Js::Str(s)) => match date_parse(s) {
            DateParse::Ms(ms) => ms,
            DateParse::Nan => f64::NAN,
            DateParse::Unsupported => return Err(Unsure),
        },
        _ => 0.0,
    };
    Ok(if n.is_finite() { n } else { 0.0 })
}

/// `String(v)` of a JSON value the session affinity compares; [`Unsure`] where JavaScript's text is not reproduced.
fn js_text(v: &Js) -> R<String> {
    match v {
        Js::Str(s) => Ok(s.clone()),
        Js::Bool(b) => Ok(b.to_string()),
        Js::Num(n) => Ok(crate::checks::guardkit::jsval::number_to_string(*n)),
        Js::Obj(_) => Ok(defaults::text("task_guard.js_object_text").to_string()),
        Js::Null | Js::Arr(_) => Err(Unsure),
    }
}

/// `checkStateFile(file, sessionId)`: an active loop with a fresh timestamp that belongs to this session (or to none).
fn active_state(p: &Path, session: Option<&str>, now: f64) -> R<bool> {
    let Some(state @ Js::Obj(_)) = small_json(p, defaults::num("task_guard.omc_state_max_bytes"))? else { return Ok(false) };
    if !matches!(state.get(defaults::text("task_guard.omc_active_key")), Some(Js::Bool(true))) {
        return Ok(false);
    }
    let fresh = defaults::num("task_guard.omc_fresh_ms") as f64;
    let mut found = false;
    for k in defaults::list("task_guard.omc_ts_keys") {
        let v = ts_of(state.get(k))?;
        if v > 0.0 && now - v <= fresh {
            found = true;
            break;
        }
    }
    if !found {
        return Ok(false);
    }
    match state.get(defaults::text("task_guard.omc_session_key")) {
        None | Some(Js::Null) => Ok(true),
        Some(v) => Ok(session.is_some_and(|s| !s.is_empty()) && js_text(v)? == session.unwrap_or_default()),
    }
}

/// `isOmcLoopActive({ cwd, sessionId })`. `cwd` is the payload's string `cwd` (empty: none); a relative one is [`Unsure`]
/// (Node resolves it against its own working directory).
pub fn loop_active(st: &Settings, cwd: Option<&str>, session: Option<&str>) -> R<bool> {
    if kill_switch(st) {
        return Ok(false);
    }
    let cwd = cwd.filter(|c| !c.is_empty());
    // `path.join` resolves `.` and `..` by text, the file system through symlinks: only a plain absolute path is read alike
    if cwd.is_some_and(|c| !c.starts_with('/') || c.split('/').any(|s| s == "." || s == "..")) {
        return Err(Unsure);
    }
    if !omc_enabled(st, cwd)? {
        return Ok(false);
    }
    let root = state_root(st, cwd);
    let now = crate::checks::agent_scan::now_ms();
    for f in defaults::list("task_guard.omc_state_files") {
        if active_state(&root.join(f), session, now)? {
            return Ok(true);
        }
    }
    Ok(false)
}
