//! Built-in `check = "api-guard"`: the part of the Node api-guard (PreToolUse on Write, Edit, MultiEdit and Bash, and on
//! `apply_patch` for Codex) that can be decided without running an interpreter.
//!
//! The Node guard resolves `module.attribute` references in the code a call is about to write against the installed
//! Python or Node runtime (a probe subprocess per module group) and blocks a reference to an attribute the real module
//! lacks. The probes need the interpreters, their versions and a wall-clock budget; they stay with the Node hook. What
//! the engine answers is every call where Node reaches no probe, which is by far the most frequent outcome:
//!
//! - the guard is off (`guards.apiGuard`) or skipped;
//! - the tool is not one of the four the guard reads, or carries no code text;
//! - the target is not a Python or a JavaScript or TypeScript file (decided from the extension exactly as Node does);
//! - the code names nothing the Node guard could verify (see [`py_may_verify`] and [`js_may_verify`]);
//! - a Bash command (`guards.shellWriteChecks` on) or a Codex patch names no code file, or the Bash switch is off.
//!
//! The "could verify" tests are conservative supersets of the Node candidate extraction: they only say "no" when no
//! candidate can exist, so a "no" is exactly Node's silent allow, and a "yes" defers to the Node hook, which then
//! decides (and probes). Shell writes in particular are never judged here: a Bash command that names a code file at all
//! (a redirect, `tee`, a heredoc, `sed -i`, `python -c`, whatever the spelling) defers, so the engine is never weaker
//! than the Node guard's shell-write parser (D74).
//!
//! Mirrors `hooks/api-guard.js` `main`, `newCodeChunks`, `langFor`, `pyCandidates` and `jsCandidates`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::js_string_of;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

#[cfg(test)]
mod tests;

fn ext_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("api_guard.extension_pattern"), true))
}

fn code_name_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("api_guard.code_name_pattern"), true))
}

/// Which language a file name is checked as.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Lang {
    Python,
    Js,
}

/// The language of a file name by its extension.
///
/// Mirrors `api-guard.js` `langFor`.
fn lang_for(fp: &str) -> Option<Lang> {
    let ext = ext_re().captures(fp)?.get(1)?.as_str().to_ascii_lowercase();
    if defaults::list("api_guard.python_extensions").contains(&ext.as_str()) {
        Some(Lang::Python)
    } else if defaults::list("api_guard.js_extensions").contains(&ext.as_str()) {
        Some(Lang::Js)
    } else {
        None
    }
}

/// The maximal runs of ASCII letters, digits and underscore in `code` (what JavaScript's `\w` runs are).
fn word_runs(code: &str) -> HashSet<&str> {
    let b = code.as_bytes();
    let mut out = HashSet::new();
    let mut i = 0usize;
    while i < b.len() {
        if b[i].is_ascii_alphanumeric() || b[i] == b'_' {
            let start = i;
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_') {
                i += 1;
            }
            out.insert(&code[start..i]);
        } else {
            i += 1;
        }
    }
    out
}

/// False only when the Node guard can find no Python candidate in `code`. A candidate needs an `import` statement
/// (every module name it resolves comes from one) and, unless third-party checking is on, a standard-library module
/// name as a word of the text; strings and comments are stripped before Node looks, which only removes words.
///
/// Mirrors `api-guard.js` `pyCandidates` (as a superset).
pub fn py_may_verify(code: &str, thirdparty: bool) -> bool {
    let words = word_runs(code);
    words.contains(defaults::text("api_guard.python_import_word"))
        && (thirdparty || defaults::list("api_guard.python_stdlib").iter().any(|m| words.contains(m)))
}

/// False only when the Node guard can find no JavaScript candidate in `code`: a global builtin followed by a dot, or a
/// `require(` of a module it may verify. Written without word boundaries, so it finds everything Node's patterns find.
///
/// Mirrors `api-guard.js` `jsCandidates` (as a superset).
pub fn js_may_verify(code: &str, thirdparty: bool) -> bool {
    if defaults::list("api_guard.js_globals").iter().any(|g| code.contains(&format!("{g}."))) {
        return true;
    }
    code.contains(defaults::text("api_guard.js_require_word")) && (thirdparty || defaults::list("api_guard.node_builtins").iter().any(|m| code.contains(m)))
}

/// The string `tool_input.file_path || ''` gives in JavaScript. `None` for an array or object, whose string form the
/// engine does not reproduce.
fn js_path(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => Some(String::new()),
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => Some(String::new()),
        Some(Value::Array(_)) | Some(Value::Object(_)) => None,
        Some(other) => js_string_of(other),
    }
}

/// The code strings a Write, Edit or MultiEdit call is about to write.
///
/// Mirrors `api-guard.js` `newCodeChunks` (the three Claude edit tools).
fn edit_codes<'a>(tool: &str, ti: &'a Value) -> Vec<&'a str> {
    if tool == defaults::text("api_guard.tool_write") {
        ti.get("content").and_then(Value::as_str).into_iter().collect()
    } else if tool == defaults::text("api_guard.tool_edit") {
        ti.get("new_string").and_then(Value::as_str).into_iter().collect()
    } else {
        ti.get("edits").and_then(Value::as_array).map(|a| a.iter().filter_map(|e| e.get("new_string").and_then(Value::as_str)).collect()).unwrap_or_default()
    }
}

/// The check's decision on one payload: `Allow` exactly when the Node guard would exit 0 without probing, else `Defer`.
///
/// Mirrors `hooks/api-guard.js` `main`.
pub fn decide(p: &Value, st: &Settings) -> Verdict {
    if !get_bool(st, defaults::raw("api_guard.setting")) || is_skipped(st, defaults::text("api_guard.guard_name")) {
        return Verdict::Allow;
    }
    let Some(tool) = p.get("tool_name").and_then(Value::as_str) else { return Verdict::Allow };
    let null = Value::Null;
    let ti = p.get("tool_input").filter(|t| !t.is_null() && t.as_bool() != Some(false)).unwrap_or(&null);
    let is_tool = |k: &str| tool == defaults::text(k);
    if is_tool("api_guard.tool_shell") || is_tool("api_guard.tool_patch") {
        // a shell write's visible text, or a patch's added lines: judged by Node. Only a command that names no code file
        // (or, for Bash, a switch that is off) is certainly a silent allow here.
        if is_tool("api_guard.tool_shell") && !get_bool(st, defaults::raw("api_guard.shell_setting")) {
            return Verdict::Allow;
        }
        return match ti.get("command") {
            None | Some(Value::Null) => Verdict::Allow,
            Some(Value::String(c)) if !code_name_re().is_match(c) => Verdict::Allow,
            _ => Verdict::Defer,
        };
    }
    if !(is_tool("api_guard.tool_write") || is_tool("api_guard.tool_edit") || is_tool("api_guard.tool_multi")) {
        return Verdict::Allow;
    }
    let codes = edit_codes(tool, ti);
    if codes.is_empty() {
        return Verdict::Allow;
    }
    let Some(fp) = js_path(ti.get("file_path")) else { return Verdict::Defer };
    let Some(lang) = lang_for(&fp) else { return Verdict::Allow };
    let thirdparty = get_bool(st, defaults::raw("api_guard.thirdparty_setting"));
    let may = |code: &str| if lang == Lang::Python { py_may_verify(code, thirdparty) } else { js_may_verify(code, thirdparty) };
    if codes.iter().any(|c| may(c)) { Verdict::Defer } else { Verdict::Allow }
}

/// The registered `api-guard` check.
pub struct ApiGuard;

impl Check for ApiGuard {
    fn name(&self) -> &'static str {
        "api-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("api_guard.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.event == "PreToolUse" && s.tool.is_some()).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        // the Node guard never looks at the event name (the hook table registers it on PreToolUse only), so neither does this
        let _ = s;
        Some(std::panic::catch_unwind(|| decide(payload, &Settings::from_env(env))).unwrap_or(Verdict::Defer))
    }
}
