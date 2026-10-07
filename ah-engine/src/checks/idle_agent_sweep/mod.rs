//! Built-in `check = "idle-agent-sweep"`: a port of the Node idle-agent-sweep hook (UserPromptSubmit, advisory only).
//!
//! Once per user prompt, the check lists the agents this session's transcript shows finished but never stopped (Claude:
//! named teammates; Codex: `multi_agent_v1` agents never closed) and gives the exact call that ends each one. It fires
//! when at least `guards.idleAgentSweepCount` finished agents are idle, or when any one has been idle for at least
//! `guards.idleAgentSweepMin` minutes, and never for a `<task-notification>` turn. The advisory goes through the emit-dedupe
//! store (key `idle-agent-sweep`, minutes in the text normalized away), so a queued burst of prompts yields one copy.
//!
//! The scans are [`scan`] (Claude) and [`codex`]. Anything JavaScript might read differently defers to Node before
//! anything is written: a transcript line that holds a marker but that neither JSON parser accepts, a timestamp that is not
//! the strict ISO form, a relative transcript path, a label that would be cut inside a surrogate pair.
//!
//! Mirrors `hooks/idle-agent-sweep.js` and `hooks/lib/idle-agents.js`.
use crate::checks::emit_dedupe::{self, Defer, Opts};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::jsval::to_number;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, get_number, is_skipped};
use crate::checks::guardkit::tail::read_tail;
use crate::checks::guardkit::text::{collapse_ws, is_js_space, js_trim, slice_utf16};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;

pub mod codex;
pub mod scan;

#[cfg(test)]
mod tests;

/// One finished agent, from either scan.
#[derive(Debug, Clone, PartialEq)]
struct Idle {
    id: String,
    label: String,
    idle_since_ms: f64,
}

struct Res {
    rollout: Regex,
    codex_dir: Regex,
    minutes: Regex,
    ctl: Regex,
}

fn res() -> &'static Res {
    static R: crate::defaults::Cache<Res> = crate::defaults::Cache::new();
    R.get_or_init(|| Res {
        rollout: jsre::compile(defaults::text("idle_sweep.re_codex_rollout"), false),
        codex_dir: jsre::compile(defaults::text("idle_sweep.re_codex_dir"), false),
        minutes: jsre::compile(defaults::text("idle_sweep.re_minutes"), false),
        ctl: jsre::compile(defaults::text("idle_sweep.re_control_chars"), false),
    })
}

/// `now()` of the hook: the clock, or the injected one when both test variables are set (as Node does).
fn now(st: &Settings) -> f64 {
    let on = st.env.get(defaults::text("idle_sweep.env_test_isolation")).map(String::as_str) == Some("1");
    if on && let Some(raw) = st.env.get(defaults::text("idle_sweep.env_test_now")).filter(|v| !v.is_empty()) {
        let n = to_number(js_trim(raw));
        if n.is_finite() {
            return n;
        }
    }
    emit_dedupe::now_ms()
}

/// `detectPlatform(payload) === 'codex'`: a `turn_id` string, or a Codex rollout path.
fn is_codex(payload: &Value, transcript: &str) -> bool {
    payload.get("turn_id").and_then(Value::as_str).is_some_and(|t| !t.is_empty()) || res().rollout.is_match(transcript) || res().codex_dir.is_match(transcript)
}

/// `oneLine(s, max)`: control characters to spaces, white space collapsed, cut at `max` UTF-16 units. `Err` when the cut
/// would split a surrogate pair (JavaScript keeps the lone surrogate, which a Rust string cannot).
fn one_line(s: &str, max: usize) -> Result<String, Defer> {
    let spaced = res().ctl.replace_all(s, " ");
    let collapsed = collapse_ws(&spaced);
    let o = js_trim(&collapsed);
    if o.encode_utf16().count() <= max {
        return Ok(o.to_string());
    }
    let cut = slice_utf16(o, max).ok_or(Defer)?;
    Ok(format!("{}{}", cut.trim_end_matches(is_js_space), defaults::text("idle_sweep.ellipsis")))
}

/// `message(result, nowMs)`: the advisory text.
fn message(list: &[Idle], codex: bool, now_ms: f64) -> Result<String, Defer> {
    let words = defaults::raw(if codex { "idle_sweep.words_codex" } else { "idle_sweep.words_claude" });
    let max_named = defaults::num("idle_sweep.max_named") as usize;
    let label_max = defaults::num("idle_sweep.label_max") as usize;
    let mut shown = Vec::new();
    for a in list.iter().take(max_named) {
        let mins = ((now_ms - a.idle_since_ms) / defaults::num("idle_sweep.ms_per_minute") as f64).floor().max(0.0);
        shown.push(format!("{} ({}m)", one_line(&a.label, label_max)?, mins as i64));
    }
    let more = if list.len() > max_named { msg::render("idle_sweep.more", &[("m", &(list.len() - max_named).to_string())]) } else { String::new() };
    let n = list.len();
    let be = defaults::text(if n == 1 { "idle_sweep.be_one" } else { "idle_sweep.be_many" });
    let past = words.str_field("past");
    let call = msg::render(if codex { "idle_sweep.call_codex" } else { "idle_sweep.call_claude" }, &[("id", list.first().map_or("", |a| a.id.as_str()))]);
    let what = msg::render("idle_sweep.what", &[("n", &n.to_string()), ("be", be), ("past", past), ("shown", &shown.join(", ")), ("more", &more)]);
    let why = msg::render("idle_sweep.why", &[("why_head", words.str_field("why_head")), ("past", past)]);
    let instead = msg::render("idle_sweep.instead", &[("verb", words.str_field("verb")), ("call", &call)]);
    Ok(msg::message(Kind::Tip, defaults::text("idle_sweep.guard_name"), &Parts { what: &what, why: &why, instead: &instead, ..Parts::default() }))
}

/// `advisory(payload, nowMs)`: the text, or `None` when there is nothing to say.
fn advisory(payload: &Value, st: &Settings) -> Result<Option<String>, Defer> {
    let tp = match payload.get("transcript_path").and_then(Value::as_str) {
        Some(t) if !t.is_empty() => t,
        _ => return Ok(None),
    };
    let prompt = payload.get("prompt").and_then(Value::as_str).unwrap_or("");
    if prompt.trim_start_matches(is_js_space).starts_with(defaults::text("idle_sweep.notification_tag")) {
        return Ok(None);
    }
    if !tp.starts_with('/') {
        return Err(Defer);
    }
    let codex_run = is_codex(payload, tp);
    let Some((lines, _)) = read_tail(tp, defaults::num("idle_sweep.scan_bytes")) else { return Ok(None) };
    let mut agents: Vec<Idle> = if codex_run {
        codex::finished(&lines)?.into_iter().map(|a| Idle { id: a.id, label: a.label, idle_since_ms: a.idle_since_ms }).collect()
    } else {
        scan::finished_teammates(&lines)?.into_iter().map(|f| Idle { id: f.name.clone(), label: f.name, idle_since_ms: f.idle_since_ms }).collect()
    };
    agents.sort_by(|a, b| a.idle_since_ms.partial_cmp(&b.idle_since_ms).unwrap_or(std::cmp::Ordering::Equal));
    let now_ms = now(st);
    let count = get_number(st, defaults::raw("idle_sweep.num_count"));
    let minutes = get_number(st, defaults::raw("idle_sweep.num_minutes"));
    let fire = !agents.is_empty()
        && (agents.len() as f64 >= count || agents.iter().any(|a| now_ms - a.idle_since_ms >= minutes * defaults::num("idle_sweep.ms_per_minute") as f64));
    if !fire {
        return Ok(None);
    }
    message(&agents, codex_run, now_ms).map(Some)
}

fn decide(payload: &Value, st: &Settings) -> Result<Option<String>, Defer> {
    if !get_bool(st, defaults::raw("idle_sweep.sw_enabled")) || is_skipped(st, defaults::text("idle_sweep.skip_name")) {
        return Ok(None);
    }
    let Some(text) = advisory(payload, st)? else { return Ok(None) };
    let session = emit_dedupe::session_of(payload)?;
    let transcript = emit_dedupe::transcript_of(payload)?;
    let emit = match &session {
        Some(sid) => emit_dedupe::should_emit(
            st,
            &Opts {
                session_id: sid,
                key: defaults::text("idle_sweep.dedupe_key"),
                content: &text,
                transcript_path: transcript,
                keepalive: 0.0,
                normalize: &|t| res().minutes.replace_all(t, "").into_owned(),
            },
        )?,
        None => true,
    };
    Ok(emit.then_some(text))
}

/// The registered `idle-agent-sweep` check.
pub struct IdleAgentSweep;

impl Check for IdleAgentSweep {
    fn name(&self) -> &'static str {
        "idle-agent-sweep"
    }

    fn summary(&self) -> &'static str {
        defaults::text("idle_sweep.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if env.get(defaults::text("prompt_emit.judge_child_env")) == Some("1") {
            return Some(Verdict::Allow);
        }
        let st = Settings::from_env(env);
        match decide(payload, &st) {
            Ok(None) => Some(Verdict::Allow),
            Ok(Some(text)) => Some(Verdict::Advisory(msg::advisory_json(defaults::text("idle_sweep.event"), &text))),
            Err(Defer) => Some(Verdict::Defer),
        }
    }
}
