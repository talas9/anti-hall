//! Built-in `check = "task-tracker"`: the Node task-tracker hook (UserPromptSubmit), natively, for the Claude and the Codex entry.
//!
//! On every prompt the hook keeps the task-list discipline in front of the model without repeating it every turn: the full
//! directive on the first prompt of a session, again when its window elapses or the transcript has grown by the growth
//! threshold, a short reminder in between that the injection keepalive rations, plus one line about the open tasks. It also asks
//! Jev (integration `newRequest`) to label the prompt, and scores the previous turn's dispatch demand.
//!
//! The work is split so that a hand-over to Node leaves no trace. First everything is READ and decided, with every point at
//! which the engine cannot answer exactly raising a deferral: a session that could be a DevSwarm Primary, a task the per-turn
//! DISPATCH NOW line would name (it counts the agents running in the session and asks Jev for a tier), a dispatch-tier outcome
//! still to be labelled, a state file only JavaScript reads, a dedupe store the engine cannot read. Only then are the effects
//! performed, in Node's order: the Jev ask, the directive's state file, the demand score, the unknown-state note and the
//! dedupe records.
//!
//! Mirrors `hooks/task-tracker.js` `main`, `pickMessage` and `freshnessNote`, and `hooks/lib/dispatch-demand.js` `resolvePending`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

pub mod fresh;
mod metrics;

#[cfg(test)]
mod tests;

use crate::checks::emit_dedupe::{self, Opts};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsdiff::js_reads_differently_str;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, get_enum, get_number, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, Fail, J};
use crate::checks::jsport::text::sha1_hex;
use crate::checks::spawnctx::{Home, judge_child, state_home};
use crate::checks::taskkit::js_string;
use crate::checks::taskkit::jsval::{R, Unsure, truthy};
use crate::checks::taskstate::unknown::{prune_stale, safe_key, unknown_note_plan};
use crate::checks::verify_first_orch::is_codex;
use crate::checks::verify_first_prompt::tier_text_on;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::jev::settings::Env;
use crate::jev::{AskRequest, Question, Trust};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The short reminder.
fn short_text() -> String {
    msg::message(Kind::Tip, defaults::text("task_tracker.guard_name"), &Parts { what: defaults::text("task_tracker.what_short"), ..Parts::default() })
}

/// The full directive: with the non-blocking clause at the full protocol level, without it at the compact one; the Codex text
/// names a plan list where the Claude text names the task tool.
fn full_text(st: &Settings, codex: bool) -> String {
    let full_level = get_enum(st, defaults::raw("orch_state.protocol_setting")) == defaults::text("task_tracker.full_level");
    let instead = format!(
        "{}{}{}",
        defaults::text("task_tracker.instead_head"),
        if full_level { defaults::text("task_tracker.non_blocking") } else { "" },
        defaults::text("task_tracker.instead_tail")
    );
    let m = msg::message(
        Kind::Tip,
        defaults::text("task_tracker.guard_name"),
        &Parts { what: defaults::text("task_tracker.what_full"), instead: &instead, ..Parts::default() },
    );
    if codex { m.replacen(defaults::text("task_tracker.codex_from"), defaults::text("task_tracker.codex_to"), 1) } else { m }
}

/// Which message `pickMessage` chose.
enum Pick {
    /// Within the window and the growth threshold.
    Short,
    /// First prompt, window over, or the transcript grew: inject and remember it.
    Full { size: f64 },
}

fn state_file(home: &str, session: &str) -> PathBuf {
    Path::new(home).join(defaults::text("paths.base_dir")).join(format!(
        "{}{}{}",
        defaults::text("task_tracker.state_prefix"),
        safe_key(session),
        defaults::text("task_tracker.state_suffix")
    ))
}

/// `pickMessage`: read the state of this session and choose; nothing is written here.
fn pick(file: &Path, transcript: Option<&str>, now: f64) -> R<Pick> {
    let size = transcript.and_then(|t| std::fs::metadata(t).ok()).map_or(-1.0, |m| m.len() as f64);
    let (mut last_full, mut last_size) = (0.0f64, -1.0f64);
    if let Ok(bytes) = std::fs::read(file) {
        let raw = String::from_utf8_lossy(&bytes).into_owned();
        let t = js_trim(&raw);
        if !t.is_empty() {
            if js_reads_differently_str(t) {
                return Err(Unsure);
            }
            match json::parse(t, defaults::num("task_tracker.json_max_depth") as usize) {
                Ok(v @ J::Obj(_)) => {
                    if let Some(J::Num(n)) = v.get("lastFull")
                        && n.is_finite()
                        && *n <= now + defaults::num("task_tracker.future_tolerance_ms") as f64
                    {
                        last_full = *n;
                    }
                    if let Some(J::Num(n)) = v.get("lastFullSize")
                        && n.is_finite()
                        && *n >= 0.0
                    {
                        last_size = *n;
                    }
                }
                Ok(_) | Err(Fail::Invalid) => {}
                Err(Fail::Unsupported) => return Err(Unsure),
            }
        }
    }
    let fresh_window = now - last_full < defaults::num("task_tracker.window_ms") as f64;
    let grew = size >= 0.0 && last_size >= 0.0 && size - last_size >= defaults::num("task_tracker.growth_bytes") as f64;
    Ok(if fresh_window && !grew { Pick::Short } else { Pick::Full { size } })
}

/// The Jev ask for a prompt (`askDetached` of integration `newRequest`).
fn jev_request(p: &Value, prompt: &str, session: &str) -> R<AskRequest> {
    let state = crate::checks::replykit::io::prefix_utf16(prompt, defaults::num("task_tracker.jev_state_limit") as usize).ok_or(Unsure)?;
    let labels = defaults::list("task_tracker.jev_labels");
    let texts = defaults::list("task_tracker.jev_label_texts");
    let criteria = labels.iter().zip(texts).map(|(l, t)| (l.to_string(), t.to_string())).collect();
    let mut req = AskRequest::new(
        defaults::text("task_tracker.jev_id"),
        Question::choice(defaults::text("task_tracker.jev_instructions"), criteria),
        &state,
        Trust::Advisory,
        Value::Null,
    );
    if !session.is_empty() {
        req.session_id = Some(session.to_string());
    }
    req.turn_ref = p.get("transcript_path").and_then(Value::as_str).filter(|t| !t.is_empty()).and_then(crate::jev::shared::turn_ref_from_transcript);
    req.project = crate::jev::shared::project_for(p.get("cwd").and_then(Value::as_str));
    Ok(req)
}

/// The dedupe options of the Primary block.
fn primary_block_opts<'a>(sid: &'a str, content: &'a str, transcript: Option<&'a str>, keepalive: f64, normalize: &'a dyn Fn(&str) -> String) -> Opts<'a> {
    Opts { session_id: sid, key: defaults::text("task_tracker.primary_key"), content, transcript_path: transcript, keepalive, normalize }
}

/// The decision for one payload and the request's environment.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    decide_inner(p, env).unwrap_or(Verdict::Defer)
}

fn decide_inner(p: &Value, env: &RequestEnv) -> R<Verdict> {
    let st = Settings::from_env(env);
    if judge_child(&st.env) || !get_bool(&st, defaults::raw("task_tracker.setting")) {
        return Ok(Verdict::Allow);
    }
    // `payload.prompt` on a null payload throws in Node, which swallows it and exits silently; any other value that is not an
    // object has no session and no working directory, so Node falls back to its own working directory
    if !p.is_object() {
        return if p.is_null() { Ok(Verdict::Allow) } else { Err(Unsure) };
    }
    if is_skipped(&st, defaults::text("task_tracker.guard_name")) {
        return Ok(Verdict::Allow);
    }
    let Home::Ok(home) = state_home(&st.env) else { return Err(Unsure) };
    // the DevSwarm Primary block: whether it applies depends on the repository's own documents (`None`: not reproducible)
    let primary_on = tier_text_on(&st, env, p).ok_or(Unsure)?;
    let now = emit_dedupe::now_ms();
    let codex = is_codex(p);
    let transcript = emit_dedupe::transcript_of(p).map_err(|_| Unsure)?;
    let dedupe_session = emit_dedupe::session_of(p).map_err(|_| Unsure)?;
    let session_raw = match p.get("session_id").filter(|v| truthy(v)) {
        Some(v) => js_string(v).ok_or(Unsure)?,
        None => String::new(),
    };
    let session = if session_raw.is_empty() {
        let cwd = p.get("cwd").filter(|v| truthy(v)).ok_or(Unsure)?; // else Node uses its own working directory
        sha1_hex(js_string(cwd).ok_or(Unsure)?.as_bytes())[..defaults::num("task_tracker.session_hash_len") as usize].to_string()
    } else {
        session_raw.clone()
    };

    // ---- decide: nothing below this line writes until the effects block ----
    let file = state_file(&home, &session);
    let chosen = pick(&file, transcript, now)?;
    let (full, short) = (full_text(&st, codex), short_text());
    let fresh = fresh::plan(&st, &home, transcript, &session_raw)?;
    let unknown = match &fresh {
        Some(f) => Some(unknown_note_plan(&f.tasks, &home, &session_raw, defaults::text("task_tracker.unknown_tag"))?),
        None => None,
    };
    let has_transcript = p.get("transcript_path").is_some_and(truthy);
    let demand = metrics::resolve_pending(&home, &session_raw, transcript, has_transcript, now)?;
    let jev = match p.get("prompt") {
        Some(Value::String(s)) if !js_trim(s).is_empty() => Some(jev_request(p, s, &session_raw)?),
        _ => None,
    };
    let compose = |unknown_note: &str| -> (String, String) {
        let open = match &fresh {
            Some(f) if f.line.is_empty() => unknown_note.to_string(),
            Some(f) if unknown_note.is_empty() => f.line.clone(),
            Some(f) => format!("{} {unknown_note}", f.line),
            None => String::new(),
        };
        let lead = if matches!(chosen, Pick::Full { .. }) { &full } else { &short };
        let text = if open.is_empty() { lead.clone() } else { format!("{lead}{}{open}", defaults::text("task_tracker.note_joiner")) };
        (text, open)
    };
    let (text, _) = compose(unknown.as_ref().map_or("", |u| u.note.as_str()));
    let every = get_number(&st, defaults::raw("verify_first.num_repeat_every"));
    let keepalive = if every.is_finite() && every > 0.0 { every } else { 0.0 };
    let normalize = |t: &str| t.replace(&full, &short);
    let key = defaults::text("task_tracker.dedupe_key");
    let identity = |t: &str| t.to_string();
    let primary_text = msg::message(
        Kind::Tip,
        defaults::text("task_tracker.guard_name"),
        &Parts { what: defaults::text("task_tracker.primary_what"), instead: defaults::text("task_tracker.primary_instead"), ..Parts::default() },
    );

    if primary_on && let Some(sid) = &dedupe_session {
        emit_dedupe::dry_run(&st, &primary_block_opts(sid, &primary_text, transcript, keepalive, &identity)).map_err(|_| Unsure)?;
    }
    if let Some(sid) = &dedupe_session {
        let o = Opts { session_id: sid, key, content: &text, transcript_path: transcript, keepalive: 0.0, normalize: &normalize };
        if text.starts_with(&full) {
            emit_dedupe::record_ready(&st, sid).map_err(|_| Unsure)?;
        } else if emit_dedupe::dry_run(&st, &o).map_err(|_| Unsure)? && text.starts_with(&short) {
            let s = Opts {
                session_id: sid,
                key: defaults::text("task_tracker.dedupe_short_key"),
                content: &short,
                transcript_path: transcript,
                keepalive,
                normalize: &identity,
            };
            emit_dedupe::dry_run(&st, &s).map_err(|_| Unsure)?;
        }
    }

    // ---- effects, in Node's order ----
    if let Some(req) = jev {
        let jenv = Env::from_pairs(env.to_map());
        crate::jev::shared::ask_detached(Path::new(&home), &jenv, req);
    }
    if let Pick::Full { size } = chosen
        && let Some(dir) = file.parent()
    {
        crate::discard::harmless(std::fs::create_dir_all(dir)); // keep: Node ignores a failed state write and injects regardless
        crate::discard::harmless(std::fs::write(&file, format!("{{\"lastFull\":{},\"lastFullSize\":{}}}", now as i64, size as i64)));
        prune_stale(dir, defaults::text("task_tracker.prune_prefix"), &file);
    }
    if let Some(w) = &demand {
        metrics::write(w);
    }
    let unknown_note = unknown.map_or(String::new(), |u| u.apply());
    let (text, open) = compose(&unknown_note);
    // Held out of `text`, so a burst-collapsed copy and a delivered one hash alike
    let primary_block = if primary_on {
        let show = match &dedupe_session {
            Some(sid) => emit_dedupe::should_emit(&st, &primary_block_opts(sid, &primary_text, transcript, keepalive, &identity)).unwrap_or(true),
            None => true,
        };
        if show { primary_text.clone() } else { String::new() }
    } else {
        String::new()
    };
    let mut emit = true;
    let mut out = text.clone();
    if let Some(sid) = &dedupe_session {
        let o = Opts { session_id: sid, key, content: &text, transcript_path: transcript, keepalive: 0.0, normalize: &normalize };
        if text.starts_with(&full) {
            crate::discard::harmless(emit_dedupe::record(&st, &o).map_err(|_| ())); // keep: a store that cannot be written emits, as in Node
        } else {
            emit = emit_dedupe::should_emit(&st, &o).unwrap_or(true);
        }
    }
    if emit && text.starts_with(&short) {
        let show = match &dedupe_session {
            Some(sid) => {
                let s = Opts {
                    session_id: sid,
                    key: defaults::text("task_tracker.dedupe_short_key"),
                    content: &short,
                    transcript_path: transcript,
                    keepalive,
                    normalize: &identity,
                };
                emit_dedupe::should_emit(&st, &s).unwrap_or(true)
            }
            None => true,
        };
        out = if show {
            [short.as_str(), open.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(defaults::text("task_tracker.segment_joiner"))
        } else {
            open
        };
    }
    let final_text = [if emit { out.as_str() } else { "" }, primary_block.as_str()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(defaults::text("task_tracker.segment_joiner"));
    Ok(if !final_text.is_empty() { Verdict::Advisory(msg::advisory_json(defaults::text("task_tracker.event"), &final_text)) } else { Verdict::Allow })
}

/// The registered `task-tracker` check.
pub struct TaskTracker;

impl Check for TaskTracker {
    fn name(&self) -> &'static str {
        "task-tracker"
    }

    fn summary(&self) -> &'static str {
        defaults::text("task_tracker.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, env))
    }
}
