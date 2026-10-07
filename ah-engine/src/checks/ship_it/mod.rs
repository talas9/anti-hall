//! Built-in `check = "ship-it-guard"`: a port of the Node ship-it-guard (PreToolUse on Edit, Write and MultiEdit).
//!
//! Opt-in (`guards.shipitGate`, default off). When on, a code file on a hard-risk path (migrations, auth, CI workflows,
//! security) edited with no `PLAN.md` in the working directory is blocked; when a `PLAN.md` exists that parses into a
//! Step 2 plan (a `## Phases` section whose phases declare `files:`), a target no phase declares gets an advisory.
//!
//! Differences from the Node guard (deliberate): with the gate on, a `Bash` call (shell-write targets come from the
//! command-guard parser) or an `apply_patch` call (the Codex patch parser) defers to the Node guard, as does a payload
//! without an absolute `cwd` (Node would use its own process directory, which the engine does not share). With the gate
//! off, or skipped, every call is allowed here, exactly as in Node.
//!
//! Mirrors `hooks/ship-it-guard.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::is_js_space;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

#[cfg(test)]
mod tests;

/// The compiled patterns, built once from the defaults.
struct Pats {
    hard_risk: Vec<Regex>,
    non_code_ext: Regex,
    non_code_test_file: Regex,
    non_code_test_dir: Regex,
    phases_head: Regex,
    phases_end: Regex,
    phase_split: Regex,
    phase_head: Regex,
    files_head: Regex,
    files_end: Regex,
}

fn pats() -> &'static Pats {
    static P: crate::defaults::Cache<Pats> = crate::defaults::Cache::new();
    P.get_or_init(|| {
        let c = |k: &str, ci: bool| jsre::compile(defaults::text(k), ci);
        Pats {
            hard_risk: defaults::list("ship_it.hard_risk").into_iter().map(|s| jsre::compile(s, true)).collect(),
            non_code_ext: c("ship_it.non_code_ext", true),
            non_code_test_file: c("ship_it.non_code_test_file", true),
            non_code_test_dir: c("ship_it.non_code_test_dir", true),
            phases_head: c("ship_it.phases_head", true),
            phases_end: c("ship_it.phases_end", false),
            phase_split: c("ship_it.phase_split", false),
            phase_head: c("ship_it.phase_head", false),
            files_head: c("ship_it.files_head", true),
            files_end: c("ship_it.files_end", true),
        }
    })
}

/// Files that are not code (docs, tests, the plan itself): never gated.
///
/// Mirrors `ship-it-guard.js` `isNonCode`.
fn is_non_code(fp: &str) -> bool {
    let base = paths::basename(fp).to_lowercase();
    let p = pats();
    base == defaults::text("ship_it.non_code_name")
        || p.non_code_ext.is_match(&base)
        || p.non_code_test_file.is_match(&base)
        || p.non_code_test_dir.is_match(fp)
}

/// Mirrors `ship-it-guard.js` `isHardRisk`.
fn is_hard_risk(fp: &str) -> bool {
    let norm = fp.replace('\\', "/");
    pats().hard_risk.iter().any(|re| re.is_match(&norm) || re.is_match(fp))
}

/// Path-looking tokens of a `files:` value: separators are white space and the configured characters; a token is kept
/// when it contains a slash or ends in a short dotted extension.
///
/// Mirrors `ship-it-guard.js` `extractPathTokens`.
fn extract_path_tokens(text: &str) -> Vec<String> {
    // text.replace(/^[ \t]*-[ \t]*/gm, ' '): at every line start a bullet marker becomes one space
    let chars: Vec<char> = text.chars().collect();
    let line_start = |i: usize| i == 0 || matches!(chars[i - 1], '\n' | '\r' | '\u{2028}' | '\u{2029}');
    let mut cleaned = String::with_capacity(text.len());
    let mut i = 0usize;
    while i < chars.len() {
        if line_start(i) {
            let mut j = i;
            while j < chars.len() && matches!(chars[j], ' ' | '\t') {
                j += 1;
            }
            if j < chars.len() && chars[j] == '-' {
                j += 1;
                while j < chars.len() && matches!(chars[j], ' ' | '\t') {
                    j += 1;
                }
                cleaned.push(' ');
                i = j;
                continue;
            }
        }
        cleaned.push(chars[i]);
        i += 1;
    }
    let seps = defaults::text("ship_it.token_separators");
    let trim = defaults::text("ship_it.token_trim");
    let ext_max = defaults::num("ship_it.token_ext_max") as usize;
    let mut out = Vec::new();
    for raw in cleaned.split(|c: char| is_js_space(c) || seps.contains(c)).filter(|s| !s.is_empty()) {
        let mut t = raw;
        // .replace(/^\.\/+/, '')
        if let Some(rest) = t.strip_prefix('.')
            && rest.starts_with('/')
        {
            t = rest.trim_start_matches('/');
        }
        // .replace(/[.,;:]+$/, '')
        let t = t.trim_end_matches(|c: char| trim.contains(c));
        if t.is_empty() {
            continue;
        }
        let run = t.chars().rev().take_while(char::is_ascii_alphanumeric).count();
        let dotted = run >= 1 && run <= ext_max && t[..t.len() - run].ends_with('.');
        if t.contains('/') || dotted {
            out.push(t.replace('\\', "/"));
        }
    }
    out
}

/// The union of declared path tokens across every phase's `files:` field, or `None` when the plan does not parse into a
/// real Step 2 plan.
///
/// Mirrors `ship-it-guard.js` `parsePlanDeclaredFiles`.
fn parse_plan_declared_files(plan: &str) -> Option<HashSet<String>> {
    if plan.is_empty() {
        return None;
    }
    let p = pats();
    let head = p.phases_head.find(plan)?;
    // [\s\S]*? up to the first position that is followed by the next level-two heading, or the end
    let end = p.phases_end.find(&plan[head.end()..]).map_or(plan.len(), |m| head.end() + m.start());
    let block = &plan[head.start()..end];
    // split before each phase heading, keep the sections that start with one
    let mut sections: Vec<&str> = Vec::new();
    let mut from = 0usize;
    for m in p.phase_split.find_iter(block) {
        sections.push(&block[from..m.start()]);
        from = m.start() + 1;
    }
    sections.push(&block[from..]);
    let mut declared = HashSet::new();
    let mut phase_count = 0usize;
    for section in sections.into_iter().filter(|s| p.phase_head.is_match(s)) {
        phase_count += 1;
        let Some(h) = p.files_head.find(section) else { continue };
        let rest = &section[h.end()..];
        let value = &rest[..p.files_end.find(rest).map_or(rest.len(), |m| m.start())];
        declared.extend(extract_path_tokens(value));
    }
    if phase_count == 0 || declared.is_empty() { None } else { Some(declared) }
}

/// True when `file` matches a declared token exactly or by path suffix, in either direction.
///
/// Mirrors `ship-it-guard.js` `fileMatchesDeclared`.
fn file_matches_declared(file: &str, declared: &HashSet<String>, cwd: &str) -> bool {
    if file.is_empty() {
        return false;
    }
    let abs = file.replace('\\', "/");
    let mut rel = abs.clone();
    if paths::is_absolute(file) && !cwd.is_empty() {
        let r = paths::relative(cwd, file);
        if !r.is_empty() && !r.starts_with("..") {
            rel = r.replace('\\', "/");
        }
    }
    declared.iter().any(|tok| {
        !tok.is_empty()
            && (abs == *tok
                || rel == *tok
                || abs.ends_with(&format!("/{tok}"))
                || rel.ends_with(&format!("/{tok}"))
                || tok.ends_with(&format!("/{rel}"))
                || tok.ends_with(&format!("/{abs}")))
    })
}

/// The target file paths of an Edit, Write or MultiEdit call.
///
/// Mirrors `ship-it-guard.js` `targetPaths`.
fn target_paths(tool_input: Option<&Value>) -> Vec<String> {
    let mut out = Vec::new();
    let Some(ti) = tool_input.filter(|t| t.is_object()) else { return out };
    if let Some(f) = ti.get("file_path").and_then(Value::as_str) {
        out.push(f.to_string());
    }
    if let Some(edits) = ti.get("edits").and_then(Value::as_array) {
        out.extend(edits.iter().filter_map(|e| e.get("file_path").and_then(Value::as_str)).map(str::to_string));
    }
    out
}

/// The check's decision on one payload. `None`: nothing to say.
///
/// Mirrors `hooks/ship-it-guard.js` `main`.
pub fn decide(p: &Value, st: &Settings) -> Option<Verdict> {
    if is_skipped(st, defaults::text("ship_it.guard_name")) || !get_bool(st, defaults::raw("ship_it.setting")) {
        return None;
    }
    let tool = p.get("tool_name").and_then(Value::as_str);
    if tool.is_some_and(|t| defaults::list("ship_it.deferred_tools").contains(&t)) {
        return Some(Verdict::Defer);
    }
    let files = target_paths(p.get("tool_input"));
    let code_files: Vec<&String> = files.iter().filter(|f| !is_non_code(f)).collect();
    if code_files.is_empty() {
        return None;
    }
    // Node falls back to its own process directory when the payload has no cwd; the engine cannot know it.
    let cwd = match p.get("cwd").and_then(Value::as_str) {
        Some(c) if paths::is_absolute(c) => c,
        _ => return Some(Verdict::Defer),
    };
    let plan_path = paths::join(cwd, defaults::text("ship_it.plan_file"));
    let plan_exists = std::fs::metadata(&plan_path).is_ok_and(|m| m.is_file());
    let guard = defaults::text("ship_it.guard_name");
    if let Some(shown) = code_files.iter().find(|f| is_hard_risk(f)).filter(|_| !plan_exists) {
        let what = msg::render("ship_it.msg_block_what", &[("file", shown)]);
        let text = msg::message(
            Kind::Block,
            guard,
            &Parts {
                what: &what,
                why: defaults::text("ship_it.msg_block_why"),
                instead: defaults::text("ship_it.msg_block_instead"),
                override_: defaults::text("ship_it.msg_block_override"),
                ..Parts::default()
            },
        );
        return Some(Verdict::Block(text));
    }
    if !plan_exists {
        return None;
    }
    let plan = std::fs::read(&plan_path).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    let declared = parse_plan_declared_files(&plan)?;
    let shown = code_files.iter().find(|f| !file_matches_declared(f, &declared, cwd))?;
    let what = msg::render("ship_it.msg_adv_what", &[("file", shown), ("plan", &plan_path)]);
    let text = msg::message(
        Kind::Warn,
        guard,
        &Parts { what: &what, why: defaults::text("ship_it.msg_adv_why"), instead: defaults::text("ship_it.msg_adv_instead"), ..Parts::default() },
    );
    Some(Verdict::Advisory(msg::advisory_json("PreToolUse", &text)))
}

/// The registered `ship-it-guard` check.
pub struct ShipItGuard;

impl Check for ShipItGuard {
    fn name(&self) -> &'static str {
        "ship-it-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("ship_it.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        // Needs the payload's tool name and cwd; without them, let Node decide.
        (s.event == "PreToolUse" && s.tool.is_some()).then_some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, &Settings::from_env(env)).unwrap_or(Verdict::Allow))
    }
}
