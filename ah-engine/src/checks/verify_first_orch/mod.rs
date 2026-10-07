//! Built-in `check = "verify-first-orch"`: a port of the Node verify-first-orch hook (SessionStart), for the Claude hook
//! entry (`--host=claude`; the dispatch table maps only that entry to this check, the Codex entry stays Node).
//!
//! The hook emits the orchestration discipline text: the full text, or the compact text plus a marker that makes the first
//! spawn deliver the rest (an opt-in mode), and keeps that marker in step with what it sent. Everything is decided here
//! except a DevSwarm session: whether it is a Primary (a different text) depends on the role of the workspace and on
//! `CLAUDE.md` doctrine, so a session where DevSwarm is active defers to Node before any file is touched.
//!
//! The text lives in `defaults/spawn_context.toml`, copied from `hooks/verify-first-core.js`; the parity tests compare it
//! with the Node module so the copy cannot drift.
//!
//! Mirrors `hooks/verify-first-orch.js` `main` and `hooks/lib/auto-handover-text.js` `detectPlatform` and
//! `isClaudeConfident`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg;
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::checks::guardkit::settings::{get_bool, get_enum, is_skipped};
use crate::checks::spawnctx::orch_state::{read_marker, write_marker};
use crate::checks::spawnctx::{Home, devswarm_active, judge_child, os_homedir, state_home};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::{Path, PathBuf};

#[cfg(test)]
mod tests;

/// `detectPlatform(payload) === 'codex'`: a non-empty `turn_id`, or a transcript path that is a Codex rollout file or lies
/// under a `.codex` directory.
pub fn is_codex(p: &Value) -> bool {
    if p.get("turn_id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return true;
    }
    static RES: crate::defaults::Cache<Vec<regex::Regex>> = crate::defaults::Cache::new();
    let tp = p.get("transcript_path").and_then(Value::as_str).unwrap_or("");
    RES.get_or_init(|| defaults::list("verify_first_orch.codex_transcript_patterns").into_iter().map(|s| jsre::compile(s, false)).collect())
        .iter()
        .any(|re| re.is_match(tp))
}

/// `isClaudeConfident(payload, ['--host=claude'])`: positive evidence that the session runs under Claude Code, namely a
/// session id and a transcript path that lies, after resolving links, under the host's `projects` directory. `Err`: the
/// answer depends on Node's own working directory (a relative config directory), so the check defers.
fn confident(p: &Value, st: &Settings) -> Result<bool, ()> {
    if !p.is_object() || !p.get("session_id").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) || is_codex(p) {
        return Ok(false);
    }
    let Some(tp) = p.get("transcript_path").and_then(Value::as_str).filter(|s| !s.is_empty() && is_absolute(s)) else { return Ok(false) };
    let cfg = match st.env.get(defaults::text("verify_first_orch.config_dir_env")).filter(|s| !s.is_empty()) {
        Some(c) => c.clone(),
        None => match state_home(&st.env) {
            Home::Ok(h) => format!("{h}/{}", defaults::text("verify_first_orch.config_dir_default")),
            Home::Guarded => return Ok(false),
            Home::Unknown => return Err(()),
        },
    };
    if !is_absolute(&cfg) {
        return Err(());
    }
    let Ok(base) = std::fs::canonicalize(resolve_abs(&format!("{cfg}/{}", defaults::text("verify_first_orch.projects_dir")))) else { return Ok(false) };
    let segs: Vec<&str> = tp[1..].split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return Ok(false);
    }
    let mut existing = PathBuf::from("/");
    let mut i = 0;
    while i < segs.len() {
        let next = existing.join(segs[i]);
        if std::fs::symlink_metadata(&next).is_err() {
            break;
        }
        existing = next;
        i += 1;
    }
    let Ok(real) = std::fs::canonicalize(&existing) else { return Ok(false) };
    let mut candidate = real;
    for s in &segs[i..] {
        candidate.push(s);
    }
    Ok(candidate.starts_with(&base) && candidate != base)
}

/// The text with `<abs>` replaced by the plugin root (`withRoot`).
fn with_root(text: &str, root: &str) -> String {
    text.replace(defaults::text("verify_first_orch.root_placeholder"), root)
}

/// `orchCompact(spawnDelivery, root, codex)`.
pub fn orch_compact(spawn_delivery: bool, root: &str, codex: bool) -> String {
    let first = defaults::text("verify_first_orch.compact_first").replace(
        defaults::text("verify_first_orch.delivery_placeholder"),
        if spawn_delivery { defaults::text("verify_first_orch.compact_delivery") } else { "" },
    );
    let mn = defaults::text("verify_first_orch.mn_prefix");
    let body = defaults::list("verify_first_orch.compact_body");
    let swapped = body.iter().find(|l| l.starts_with(mn)).copied();
    let mut lines = vec![first.as_str()];
    for l in &body {
        lines.push(if codex && Some(*l) == swapped { defaults::text("verify_first_orch.compact_mn_codex") } else { l });
    }
    with_root(&lines.join("\n"), root)
}

/// `ORCH_FULL` or `ORCH_FULL_CODEX`.
pub fn orch_full(codex: bool) -> String {
    defaults::list(if codex { "verify_first_orch.full_lines_codex" } else { "verify_first_orch.full_lines" }).join("\n")
}

/// The plugin root as Node computes it (`path.resolve(__dirname, '..')`, links resolved): the option the dispatcher passes,
/// else the engine's own plugin-root variable.
fn plugin_root(opts: &Value, st: &Settings) -> Option<String> {
    let given = opts.get("plugin_root").and_then(Value::as_str).or_else(|| st.env.get(defaults::env_name("plugin_root")).map(String::as_str))?;
    Some(std::fs::canonicalize(Path::new(given)).ok()?.to_string_lossy().into_owned())
}

/// The check's decision on one payload. `None`: nothing to say.
///
/// Mirrors `hooks/verify-first-orch.js` `main`.
pub fn decide(p: &Value, st: &Settings, opts: &Value) -> Option<Verdict> {
    if judge_child(&st.env) {
        return None;
    }
    if os_homedir(&st.env).is_none() {
        return Some(Verdict::Defer);
    }
    let Ok(confident) = confident(p, st) else { return Some(Verdict::Defer) };
    let state = state_home(&st.env);
    let none = defaults::list("orch_state.decisions")[1];
    let pending = defaults::list("orch_state.decisions")[0];
    let sid = p.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty());
    // writeNone: clear a pending marker of an earlier epoch (a confident session always has a marker).
    let write_none = || {
        if let Home::Ok(h) = &state {
            if confident {
                if let Some(s) = sid {
                    write_marker(h, s, none);
                }
            } else if let Some(s) = sid
                && read_marker(h, s).is_some()
            {
                write_marker(h, s, none);
            }
        }
    };
    if !get_bool(st, defaults::raw("orch_state.setting")) {
        write_none();
        return None;
    }
    let codex = is_codex(p);
    if devswarm_active(st) {
        return Some(Verdict::Defer);
    }
    let emit = |text: &str| Some(Verdict::Advisory(msg::advisory_json(defaults::text("verify_first_orch.event"), text)));
    if get_enum(st, defaults::raw("orch_state.protocol_setting")) == defaults::text("orch_state.full_level") {
        write_none();
        return emit(&orch_full(codex));
    }
    let mut mode = get_enum(st, defaults::raw("orch_state.orch_full_on_setting"));
    let (auto, spawn, session, off) = ("auto", "spawn", "session", "off");
    if mode == auto {
        mode = session.into();
    }
    if mode == spawn && !confident {
        mode = session.into();
    }
    if codex && !confident && mode != off {
        mode = session.into();
        if sid.is_some() && get_enum(st, defaults::raw("orch_state.codex_orch_full_on_setting")) == spawn {
            mode = spawn.into();
        }
    }
    if mode == spawn && is_skipped(st, defaults::text("orch_state.skip_name")) {
        mode = session.into();
    }
    // The compact text names the plugin root: without it nothing may be written, so the deferral comes first.
    if mode == off || mode == spawn {
        let Some(root) = plugin_root(opts, st) else { return Some(Verdict::Defer) };
        if mode == off {
            write_none();
            return emit(&orch_compact(false, &root, codex));
        }
        if let (Home::Ok(h), Some(s)) = (&state, sid)
            && write_marker(h, s, pending)
        {
            return emit(&orch_compact(true, &root, codex));
        }
    }
    write_none();
    emit(&orch_full(codex))
}

/// The registered `verify-first-orch` check.
pub struct VerifyFirstOrch;

impl Check for VerifyFirstOrch {
    fn name(&self) -> &'static str {
        "verify-first-orch"
    }

    fn summary(&self) -> &'static str {
        defaults::text("verify_first_orch.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        decide(payload, &Settings::from_env(env), opts)
    }
}
