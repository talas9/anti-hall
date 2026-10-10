//! The bounded host spawn primitive (v1.0 lane L07, generic, no rules): run one program the user has installed (an interpreter a
//! guard asks to probe, such as `python3` or `node`) and hand its output to the script. It holds no rule about WHAT to run or how to
//! read the answer: the script builds the argument list (the probe source travels as an argument, never interpolated into a shell)
//! and decides from the result. Installed by [`install`] from [`super::host::install`]; a script calls `ahHost.spawnProbe`.
//!
//! | raw function | what it does |
//! |---|---|
//! | `spawnProbe(prog, args, cwd, timeoutMs)` | run `prog` (a bare name in `host_spawn.programs`, looked up on the REQUEST's `PATH`, never the daemon's or the plugin's) with `args`, in `cwd` when it is an existing absolute directory, with the request's environment minus the names `host_spawn.scrub_env` matches, no stdin, its own process group, killed at the timeout. The timeout is clamped to `host_spawn.timeout_max_ms` and to what is left of the request minus `host_spawn.deadline_reserve_ms`; at most `host_spawn.max_calls` runs per script call. Result as JSON text: `{"found":false}` (not installed or not allowed), `{"found":true,"skipped":true}` (no time or budget left: nothing ran), else `{"found":true,"path","status":n\|null,"signal":n\|null,"timedOut":b,"overflow":b,"stdout","stderr"}` (`overflow`: a stream went past `host_spawn.output_max_bytes`; both streams are cut there) |
// Discard triage (E3): nothing in this file is discarded silently; a spawn failure is logged by `crate::proc::run`.

use super::host::{credit_blocking, with_settings};
use crate::checks::guardkit::jsre;
use crate::checks::jsport::fsx;
use crate::defaults;
use rquickjs::{Ctx, Function, Object};
use serde_json::json;
use std::cell::RefCell;
use std::os::unix::process::ExitStatusExt;
use std::time::{Duration, Instant};

thread_local! {
    /// Programs started in this script call.
    static RUNS: RefCell<u64> = const { RefCell::new(0) };
}

/// A new script call starts: nothing has run yet.
pub(super) fn reset_call() {
    RUNS.with(|r| *r.borrow_mut() = 0);
}

/// The first executable regular file named `name` on `path` (a colon list), searched the way a shell does; empty entries skipped.
fn which(name: &str, path: &str) -> Option<String> {
    path.split(':').filter(|d| !d.is_empty()).map(|d| format!("{}/{name}", d.trim_end_matches('/'))).find(|p| fsx::is_file(p) && fsx::is_executable(p))
}

/// The timeout a run may use: the script's ask, clamped to the configured ceiling and to what the request has left.
fn budget(asked_ms: f64) -> Option<Duration> {
    let cap = defaults::num("host_spawn.timeout_max_ms");
    let asked = if asked_ms.is_finite() && asked_ms > 0.0 { (asked_ms as u64).min(cap) } else { cap };
    let mut d = Duration::from_millis(asked);
    if let Some(left) = crate::deadline::remaining() {
        d = d.min(left.saturating_sub(defaults::millis("host_spawn.deadline_reserve_ms")));
    }
    (d >= defaults::millis("host_spawn.min_run_ms")).then_some(d)
}

/// `spawnProbe(prog, args, cwd, timeoutMs)`: see the module table.
pub fn spawn_probe(prog: &str, args: &[String], cwd: Option<&str>, timeout_ms: f64) -> rquickjs::Result<String> {
    if !defaults::list("host_spawn.programs").contains(&prog) {
        return Ok(json!({"found": false}).to_string());
    }
    let env = with_settings(|st| st.env.clone())?;
    // no PATH in the request: the default search path a C library's execvp uses (as Node's spawn does)
    let Some(bin) = which(prog, env.get(defaults::text("host_spawn.path_env")).map_or(defaults::text("host_spawn.default_path"), String::as_str)) else {
        return Ok(json!({"found": false}).to_string());
    };
    let spent = RUNS.with(|r| {
        let mut r = r.borrow_mut();
        *r += 1;
        *r > defaults::num("host_spawn.max_calls")
    });
    let Some(limit) = budget(timeout_ms).filter(|_| !spent) else {
        return Ok(json!({"found": true, "skipped": true}).to_string());
    };
    let scrub = jsre::compile(defaults::text("host_spawn.scrub_env"), true);
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(args).env_clear();
    for (k, v) in env.iter().filter(|(k, _)| !scrub.is_match(k)) {
        cmd.env(k, v);
    }
    if let Some(c) = cwd.filter(|c| c.starts_with('/') && fsx::is_dir(c)) {
        cmd.current_dir(c);
    }
    let started = Instant::now();
    let ran = crate::proc::run(cmd, prog, limit, defaults::millis("host_spawn.poll_ms"));
    credit_blocking(started);
    let cap = defaults::num("host_spawn.output_max_bytes") as usize;
    let cut = |b: &[u8]| crate::checks::guardkit::text::lossy_owned(b[..b.len().min(cap)].to_vec());
    Ok(match ran {
        Ok(o) => json!({
            "found": true, "path": bin, "status": o.status.code(), "signal": o.status.signal(), "timedOut": false,
            "overflow": o.stdout.len() > cap || o.stderr.len() > cap, "stdout": cut(&o.stdout), "stderr": cut(&o.stderr),
        }),
        Err(crate::proc::Error::Timeout) => {
            json!({"found": true, "path": bin, "status": null, "signal": null, "timedOut": true, "overflow": false, "stdout": "", "stderr": ""})
        }
        // could not start (a race with an uninstall), or its output never completed: the same as not installed
        Err(_) => json!({"found": false}),
    }
    .to_string())
}

/// Add the spawn function to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set(
        "spawnProbe",
        Function::new(c.clone(), |prog: String, args: Vec<String>, cwd: Option<String>, timeout: f64| spawn_probe(&prog, &args, cwd.as_deref(), timeout))?,
    )?;
    Ok(())
}
