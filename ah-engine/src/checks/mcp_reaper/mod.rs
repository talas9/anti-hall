//! Built-in `check = "session-end-mcp-reaper"`: the Node SessionEnd hook that terminates orphaned MCP server processes,
//! natively.
//!
//! A crashed session leaves its MCP children reparented to PID 1; on every clean exit the next session sweeps them. The hook
//! acts only on a real termination (`prompt_input_exit`, `other`), only when PID 1 is an init process, and only on a process
//! that is parented to PID 1, has an MCP command signature, is not a test runner or excluded by the user, is old enough, and is
//! not owned by the platform's service manager. It sends the polite signal, waits a grace period, re-checks the whole
//! signature against a fresh listing (a recycled pid must qualify again) and sends the forced signal to those that remain.
//! Every step is appended to an audit log.
//!
//! The selection is [`select`]; this module is the order of effects. Nothing is written or signalled before the selection is
//! complete, so a case the engine hands to Node (a user pattern it cannot translate exactly, a start time in a form it does not
//! read, an ambiguous local time, a zone the daemon and the hook might read differently) leaves the state exactly as it was. The
//! engine is never broader than Node: it signals a subset of what the Node hook would, never itself or its parent, and never a
//! pid below 2.
//!
//! Mirrors `hooks/session-end-mcp-reaper.js` `main` and `companion/mcp-reaper.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

pub mod select;
mod sys;

#[cfg(test)]
mod tests;

use self::select::{Defer, Params, Proc, Run, Sys, find_pid1_cmd, is_init_pid1, matches_invariant, parse_ps, sweep, user_pattern};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::settings::{get_bool, get_string};
use crate::checks::spawnctx::os_homedir;
use crate::checks::taskkit::jsval::number_of_str;
use crate::checks::taskkit::time::iso;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;

/// `parseEnvInt(raw, fallback)`: `Number(raw)` when it is a finite number of at least zero, floored; else the fallback.
fn env_int(st: &Settings, name_key: &str, fallback_key: &str) -> f64 {
    let fallback = defaults::num(fallback_key) as f64;
    match st.env.get(defaults::text(name_key)) {
        Some(raw) => {
            let n = number_of_str(raw);
            if n.is_finite() && n >= 0.0 { n.floor() } else { fallback }
        }
        None => fallback,
    }
}

/// `extractReason(payload)`: `reason`, else `end_reason`, when it is a string.
fn reason_of(p: &Value) -> Option<&str> {
    defaults::list("mcp_reaper.reason_fields").into_iter().find_map(|k| p.get(k).and_then(Value::as_str))
}

/// Append one audit line: `JSON.stringify` of the fields in order, after `ts`. Stops silently past the size bound.
fn log_line(file: &Path, sys: &dyn Sys, fields: Vec<(&str, OVal)>) {
    if std::fs::metadata(file).map(|m| m.len()).unwrap_or(0) > defaults::num("mcp_reaper.log_max_bytes") {
        return;
    }
    let mut all = vec![("ts".to_string(), OVal::Str(iso(sys.now_ms() as i64)))];
    all.extend(fields.into_iter().map(|(k, v)| (k.to_string(), v)));
    let line = format!("{}\n", OVal::Obj(all).stringify());
    // best effort, as Node's try/catch: a lost audit line never changes what is signalled
    crate::discard::harmless(
        std::fs::OpenOptions::new().append(true).create(true).open(file).and_then(|mut f| std::io::Write::write_all(&mut f, line.as_bytes())),
    );
}

fn proc_fields<'a>(p: &Proc, action: &'a str, reason: Option<&'a str>) -> Vec<(&'a str, OVal)> {
    let mut v = vec![("pid", OVal::Num(p.pid)), ("ppid", OVal::Num(p.ppid)), ("cmd", OVal::Str(p.cmd.clone())), ("action", OVal::Str(action.to_string()))];
    if let Some(r) = reason {
        v.push(("reason", OVal::Str(r.to_string())));
    }
    v
}

/// Signal a pid: never itself, its parent, or a pid below 2 (the engine is narrower than Node here), and never one that does
/// not fit the system call (Node's `process.kill` throws for those).
fn signal(sys: &dyn Sys, pid: f64, forced: bool) {
    if !(2.0..=f64::from(i32::MAX)).contains(&pid) || pid.fract() != 0.0 || sys.is_self_or_parent(pid) {
        return;
    }
    sys.kill(pid as i32, forced);
}

/// The ps listing as a process table; `None` when the listing failed (Node's early return).
fn listing(sys: &dyn Sys) -> Option<Vec<Proc>> {
    let argv: Vec<String> = defaults::list("mcp_reaper.ps_command").into_iter().map(str::to_string).collect();
    match sys.run(&argv, defaults::num("mcp_reaper.ps_timeout_ms"), defaults::num("mcp_reaper.ps_max_bytes")) {
        Run::Ok(out) => Some(parse_ps(&out)),
        Run::Failed | Run::TooBig => None,
    }
}

/// The decision for one SessionEnd payload; the sweep's effects happen here.
pub fn decide(p: &Value, st: &Settings, plugin_root: &str, sys: &dyn Sys) -> Verdict {
    match decide_inner(p, st, plugin_root, sys) {
        Ok(()) => Verdict::Allow,
        Err(Defer) => Verdict::Defer,
    }
}

fn decide_inner(p: &Value, st: &Settings, plugin_root: &str, sys: &dyn Sys) -> Result<(), Defer> {
    if !get_bool(st, defaults::raw("mcp_reaper.setting")) {
        return Ok(());
    }
    let reason = match reason_of(p) {
        Some(r) if defaults::list("mcp_reaper.act_reasons").contains(&r) => r,
        _ => return Ok(()),
    };
    // The Node hook does nothing when the companion module it reuses cannot be loaded; the engine cannot tell a broken module
    // from a good one, so it acts only where the module is present.
    if plugin_root.is_empty() || !Path::new(plugin_root).join(defaults::text("mcp_reaper.node_module")).is_file() {
        return Err(Defer);
    }
    let home = os_homedir(&st.env).ok_or(Defer)?;
    let Some(procs) = listing(sys) else { return Ok(()) };
    if procs.is_empty() {
        return Ok(());
    }
    let log_dir = Path::new(&home).join(defaults::text("paths.base_dir")).join(defaults::text("mcp_reaper.log_dir"));
    let log = log_dir.join(defaults::text("mcp_reaper.log_file"));
    let prepare = || crate::discard::harmless(std::fs::create_dir_all(&log_dir)); // keep: fail-soft, as Node
    let pid1 = find_pid1_cmd(&procs);
    if !is_init_pid1(pid1) {
        prepare();
        let pid1_json = pid1.filter(|c| !c.is_empty()).map_or(OVal::Null, |c| OVal::Str(c.to_string()));
        log_line(
            &log,
            sys,
            vec![
                ("event", OVal::Str(defaults::text("mcp_reaper.event_skip").to_string())),
                ("reason", OVal::Str(defaults::text("mcp_reaper.reason_pid1").to_string())),
                ("pid1Cmd", pid1_json),
            ],
        );
        return Ok(());
    }
    let extra = user_pattern(&get_string(st, defaults::raw("mcp_reaper.match_setting")))?;
    let exclude = user_pattern(&get_string(st, defaults::raw("mcp_reaper.exclude_setting")))?;
    let params = Params {
        extra: extra.as_ref(),
        exclude: exclude.as_ref(),
        min_age_s: env_int(st, "mcp_reaper.min_age_env", "mcp_reaper.min_age_default_s"),
        max: env_int(st, "mcp_reaper.max_env", "mcp_reaper.max_default"),
    };
    let swept = sweep(&procs, &params, sys)?;
    // ---- the selection is final: from here on nothing is handed to Node ----
    prepare();
    for s in &swept.skipped {
        log_line(&log, sys, proc_fields(&s.proc_, defaults::text("mcp_reaper.action_skip"), Some(s.reason)));
    }
    log_line(
        &log,
        sys,
        vec![
            ("event", OVal::Str(defaults::text("mcp_reaper.event_scan").to_string())),
            ("reason", OVal::Str(reason.to_string())),
            ("candidates", OVal::Num(swept.candidates.len() as f64)),
        ],
    );
    if swept.candidates.is_empty() {
        return Ok(());
    }
    for c in &swept.candidates {
        log_line(&log, sys, proc_fields(c, defaults::text("mcp_reaper.action_term"), None));
    }
    for c in &swept.candidates {
        signal(sys, c.pid, false);
    }
    sys.sleep_ms(defaults::num("mcp_reaper.grace_ms"));
    // A fresh listing: a pid recycled during the grace period must qualify again on its own signature.
    let still: Vec<f64> =
        listing(sys).map(|fresh| fresh.iter().filter(|q| matches_invariant(q, params.extra, params.exclude)).map(|q| q.pid).collect()).unwrap_or_default();
    for c in &swept.candidates {
        if !still.contains(&c.pid) {
            continue;
        }
        log_line(&log, sys, proc_fields(c, defaults::text("mcp_reaper.action_kill"), None));
        signal(sys, c.pid, true);
    }
    Ok(())
}

/// The registered `session-end-mcp-reaper` check.
pub struct SessionEndMcpReaper;

impl Check for SessionEndMcpReaper {
    fn name(&self) -> &'static str {
        "session-end-mcp-reaper"
    }

    fn summary(&self) -> &'static str {
        defaults::text("mcp_reaper.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        let st = Settings::from_env(env);
        let root = crate::checks::guardkit::settings::plugin_root(opts, env);
        Some(decide(payload, &st, &root, &sys::RealSys::new(env)))
    }
}
