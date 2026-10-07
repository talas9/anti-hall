//! Built-in `check = "edit-guard"`: the part of the Node edit-guard (PreToolUse on Edit, Write, MultiEdit and
//! NotebookEdit, and on `apply_patch` for Codex) that can be decided exactly without the coordinator allowlists.
//!
//! The Node guard has two layers. The launcher-directory deny blocks a write into `~/.anti-hall/bin` for every agent,
//! subagent included. Everything after it applies to the main thread only: a coordinator may not edit files itself unless
//! the target is on one of its own allowlists (plan, state and memory files, its session scratchpad, handover docs, the
//! trusted per-project allowlist, plan mode for non-source files), each honoured only after symlink and hard-link honesty
//! checks, and a block names the DevSwarm role in its wording.
//!
//! What the engine answers, and why only that:
//!
//! - the guard is off or skipped, or the tool is not an edit tool: Node exits 0 without output;
//! - the target resolves into the launcher directory, literally or through a symlink already on disk: the same block,
//!   byte for byte (stdout JSON line, exit 2, nothing on stderr for a Claude tool);
//! - the session is not the main thread (a subagent marker in the payload, the `agent_tool` entry point, or no recognised
//!   entry point, read from the request environment): Node exits 0 right after the launcher check.
//!
//! Every main-thread call defers to the Node hook, which owns the allowlists and the wording, and so does every
//! `apply_patch` (its targets need the Codex patch parser, which is not ported), every payload whose paths cannot be
//! resolved without the hook's own working directory or home directory, and every call whose request environment has no
//! home directory (it was probably cut off, and then the entry point cannot be trusted either). A deferral is never a
//! silent allow (D11), so the engine is never weaker than the Node guard (D74).
//!
//! Mirrors `hooks/edit-guard.js` `main` and `resolvesIntoLauncherBinDir`, and `hooks/coordinator-detect.js`.
use crate::checks::coordinator_work::is_coordinator;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::js_string_of;
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

#[cfg(test)]
mod tests;

/// The string `value || ''` gives in JavaScript. `None` for an array or object, whose string form the engine does not
/// reproduce.
fn js_or_empty(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Some(String::new()),
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Some(String::new()),
        Some(Value::Array(_)) | Some(Value::Object(_)) => None,
        Some(other) => js_string_of(other),
    }
}

/// `p.replace(/\\/g, '/')`.
fn slashes(p: &str) -> String {
    p.replace('\\', "/")
}

/// True when `real` is `dir` or a path inside it (both with forward slashes and no trailing slash).
fn inside(real: &str, dir: &str) -> bool {
    real == dir || real.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'))
}

/// Whether `file` (as the payload spelled it) targets the launcher directory, literally or through a symlink on disk.
/// `None` when the answer depends on the hook's own working directory or home directory, which the engine does not have.
///
/// Mirrors `edit-guard.js` `resolvesIntoLauncherBinDir`.
fn resolves_into_launcher(file: &str, cwd: &str, home: &str) -> Option<bool> {
    if file.is_empty() || home.is_empty() {
        return Some(false);
    }
    if !paths::is_absolute(home) {
        return None;
    }
    let abs = if paths::is_absolute(file) {
        paths::resolve_abs(file)
    } else if paths::is_absolute(cwd) {
        paths::resolve(cwd, file)
    } else {
        return None;
    };
    let bin_dir = defaults::list("edit_guard.launcher_dir").iter().fold(paths::resolve_abs(home), |acc, part| paths::resolve(&acc, part));
    let norm_bin = slashes(&bin_dir).trim_end_matches('/').to_string();
    if inside(&slashes(&abs), &norm_bin) {
        return Some(true);
    }
    // a symlink already on disk: the real target against the real launcher directory (a path that does not exist yet
    // has no real target, and the literal test above stands)
    let Ok(real_abs) = std::fs::canonicalize(&abs) else { return Some(false) };
    let real_bin = std::fs::canonicalize(&bin_dir).map_or(norm_bin, |p| slashes(&p.to_string_lossy()));
    Some(inside(&slashes(&real_abs.to_string_lossy()), &real_bin))
}

/// The check's decision on one payload.
///
/// Mirrors `hooks/edit-guard.js` `main`.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    let st = Settings::from_env(env);
    if !get_bool(&st, defaults::raw("edit_guard.setting")) || is_skipped(&st, defaults::text("edit_guard.guard_name")) {
        return Verdict::Allow;
    }
    let Some(tool) = p.get("tool_name").and_then(Value::as_str) else { return Verdict::Allow };
    if tool == defaults::text("edit_guard.patch_tool") {
        return Verdict::Defer;
    }
    if !defaults::list("edit_guard.edit_tools").contains(&tool) {
        return Verdict::Allow;
    }
    // Without a home directory the request environment was cut off or the hook has none: neither the launcher
    // directory nor the entry point can be trusted.
    let Some(home) = env.get(defaults::env_name("home")) else { return Verdict::Defer };
    let null = Value::Null;
    let ti = p.get("tool_input").unwrap_or(&null);
    let field = if tool == defaults::text("edit_guard.notebook_tool") { "notebook_path" } else { "file_path" };
    let (Some(file), Some(cwd)) = (js_or_empty(ti.get(field)), js_or_empty(p.get("cwd"))) else { return Verdict::Defer };
    match resolves_into_launcher(&file, &cwd, home) {
        None => return Verdict::Defer,
        Some(true) => {
            let what = msg::render("edit_guard.msg_launcher_what", &[("tool", tool)]);
            let reason = msg::message(
                Kind::Block,
                defaults::text("edit_guard.guard_name"),
                &Parts {
                    what: &what,
                    why: defaults::text("edit_guard.msg_launcher_why"),
                    instead: defaults::text("edit_guard.msg_launcher_instead"),
                    allowed: defaults::text("edit_guard.msg_launcher_allowed"),
                    ..Parts::default()
                },
            );
            // Claude reads the block from stdout alone; only the Codex form also writes the reason to stderr
            let mut x = Exact::json_block(&reason);
            x.err.clear();
            return Verdict::Exact(x);
        }
        Some(false) => {}
    }
    if is_coordinator(p, env) { Verdict::Defer } else { Verdict::Allow }
}

/// The registered `edit-guard` check.
pub struct EditGuard;

impl Check for EditGuard {
    fn name(&self) -> &'static str {
        "edit-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("edit_guard.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.event == "PreToolUse" && s.tool.is_some()).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        // the Node guard never looks at the event name (the hook table registers it on PreToolUse only), so neither does this
        let _ = s;
        Some(std::panic::catch_unwind(|| decide(payload, env)).unwrap_or(Verdict::Defer))
    }
}
