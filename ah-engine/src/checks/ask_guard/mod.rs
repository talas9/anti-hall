//! Built-in `check = "ask-guard"`: a port of the Node ask-guard (PreToolUse on AskUserQuestion).
//!
//! Optional and off by default (`guards.noBlockingQuestions`): `advise` adds the standing rule to the question call,
//! `block` refuses it unless the first question starts with `DESTRUCTIVE:` or `CREDENTIAL:` (then the use is appended to
//! `~/.anti-hall/logs/ask-guard.ndjson`). Independent of that mode, `guards.questionAgentsNote` (default on) adds one line
//! naming the background agents the transcript proves are still in flight. In a DevSwarm child workspace the advice and the
//! block point at the parent.
//!
//! Differences from the Node guard (deliberate): a transcript the scan cannot read exactly as JavaScript would (see
//! [`crate::checks::agent_scan::Unsupported`]) defers the whole call to Node, and so does a request whose `HOME` is unset.
//! The decision is computed before the marker log line is written, so a deferral never leaves a duplicate line.
//!
//! Mirrors `hooks/ask-guard.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::agent_scan::{self, Opts, Unsupported};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, get_enum, is_skipped};
use crate::checks::guardkit::text::{js_trim, slice_utf16};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::io::Write;

#[cfg(test)]
mod tests;

fn marker_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| crate::checks::lit_re(defaults::text("ask_guard.marker_re")))
}

fn control_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| crate::checks::lit_re(defaults::text("ask_guard.note_control_re")))
}

/// `markerOf(toolInput)`: `DESTRUCTIVE` or `CREDENTIAL` from the FIRST question's header, then its question text.
fn marker_of(tool_input: &Value) -> Option<String> {
    let first = tool_input.get("questions").and_then(Value::as_array).and_then(|a| a.first())?;
    if !first.is_object() && !first.is_array() {
        return None;
    }
    for field in ["header", "question"] {
        if let Some(s) = first.get(field).and_then(Value::as_str)
            && let Some(c) = marker_re().captures(js_trim(s))
        {
            return Some(c[1].to_string());
        }
    }
    None
}

/// `agentsNote(payload)`: one line naming the running agents, or `None` when none is provably in flight.
fn agents_note(st: &Settings, payload: &Value) -> Result<Option<String>, Unsupported> {
    if !get_bool(st, defaults::raw("ask_guard.note_setting")) {
        return Ok(None);
    }
    let Some(tp) = payload.get("transcript_path").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return Ok(None) };
    let opts = Opts { now_ms: agent_scan::now_ms(), ignore_unanswered_stops: false };
    let Some(agents) = agent_scan::running_agents_or_null(tp, &opts)? else { return Ok(None) };
    if agents.is_empty() {
        return Ok(None);
    }
    let max_listed = defaults::num("ask_guard.note_max_listed") as usize;
    let mut names = Vec::new();
    for a in agents.iter().take(max_listed) {
        let cleaned = control_re().replace_all(&a.description, " ");
        let d = js_trim(&cleaned);
        let cut = slice_utf16(d, defaults::num("ask_guard.note_desc_max") as usize).ok_or(Unsupported)?;
        names.push(if cut.is_empty() { defaults::text("ask_guard.note_unnamed").to_string() } else { cut });
    }
    let more =
        if agents.len() > max_listed { defaults::text("ask_guard.note_more").replace("{n}", &(agents.len() - max_listed).to_string()) } else { String::new() };
    let verb = if agents.len() == 1 { defaults::text("ask_guard.note_one") } else { defaults::text("ask_guard.note_many") };
    Ok(Some(format!(
        "{}{}{}{}{}{}{}",
        agents.len(),
        defaults::text("ask_guard.note_head"),
        verb,
        defaults::text("ask_guard.note_mid"),
        names.join(defaults::text("ask_guard.note_join")),
        more,
        defaults::text("ask_guard.note_tail")
    )))
}

fn is_child(env: &RequestEnv) -> bool {
    env.get(defaults::text("ask_guard.child_env")).is_some_and(|v| !js_trim(v).is_empty())
}

/// Append one NDJSON line recording marker use; best effort, as in Node.
fn log_marker(home: &str, marker: &str) {
    let path = format!("{home}/{}", defaults::text("ask_guard.log_file"));
    let dir = std::path::Path::new(&path).parent().map(std::path::Path::to_path_buf);
    crate::discard::logged(
        "ask_log_write",
        (|| -> std::io::Result<()> {
            if let Some(d) = dir {
                std::fs::create_dir_all(d)?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
            let line = format!(
                "{{\"ts\":\"{}\",\"event\":\"{}\",\"marker\":\"{marker}\"}}\n",
                agent_scan::iso_utc(agent_scan::now_ms()),
                defaults::text("ask_guard.log_event")
            );
            f.write_all(line.as_bytes())
        })(),
    );
}

/// The check's decision on one payload.
///
/// Mirrors `hooks/ask-guard.js` `main`.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    let Some(home) = agent_scan::home_dir(env) else { return Verdict::Defer };
    let st = Settings::from_env(env);
    let mode = get_enum(&st, defaults::raw("ask_guard.mode_setting"));
    let note_on = get_bool(&st, defaults::raw("ask_guard.note_setting"));
    if mode == "off" && !note_on {
        return Verdict::Allow;
    }
    if is_skipped(&st, defaults::text("ask_guard.guard_name")) {
        return Verdict::Allow;
    }
    if !p.is_object() || p.get("tool_name").and_then(Value::as_str) != Some(defaults::text("ask_guard.tool")) {
        return Verdict::Allow;
    }
    let guard = defaults::text("ask_guard.guard_name");
    let suffix = if is_child(env) { defaults::text("ask_guard.child_text") } else { "" };
    let null = Value::Null;
    let mut marker = None;
    if mode == "block" {
        marker = marker_of(p.get("tool_input").unwrap_or(&null));
        if marker.is_none() {
            let reason = format!(
                "{}{suffix}",
                msg::message(
                    Kind::Block,
                    guard,
                    &Parts {
                        what: defaults::text("ask_guard.block_what"),
                        why: defaults::text("ask_guard.block_why"),
                        instead: defaults::text("ask_guard.block_instead"),
                        allowed: defaults::text("ask_guard.block_allowed"),
                        ..Parts::default()
                    }
                )
            );
            let out = format!("{{\"decision\":\"block\",\"reason\":{}}}\n", serde_json::to_string(&reason).unwrap_or_default());
            return Verdict::Exact(Exact { code: 2, out, err: String::new() });
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if mode == "advise" {
        let advice = msg::message(
            Kind::Tip,
            guard,
            &Parts { what: defaults::text("ask_guard.advise_what"), instead: defaults::text("ask_guard.advise_instead"), ..Parts::default() },
        );
        parts.push(format!("{advice}{suffix}"));
    }
    match agents_note(&st, p) {
        Ok(Some(n)) => parts.push(n),
        Ok(None) => {}
        Err(Unsupported) => return Verdict::Defer,
    }
    if let Some(m) = &marker {
        log_marker(&home, m);
    }
    if parts.is_empty() {
        return Verdict::Allow;
    }
    Verdict::Advisory(msg::advisory_json("PreToolUse", &parts.join("\n")))
}

/// The registered `ask-guard` check.
pub struct AskGuard;

impl Check for AskGuard {
    fn name(&self) -> &'static str {
        "ask-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("ask_guard.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.tool == Some(defaults::text("ask_guard.tool"))).then_some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, env))
    }
}
