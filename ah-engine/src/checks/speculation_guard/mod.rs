//! Built-in `check = "speculation-guard"`: a port of the Node speculation-guard (Stop).
//!
//! The check takes the reply being stopped (the payload's `last_assistant_message`, else the transcript's last assistant
//! text), looks for hedge words that assert without evidence ("probably", "should be", "I suspect"...), and blocks once
//! when it finds one and the reply holds no acknowledgment that would make the hedge honest. A reply is blocked once
//! per distinct text, and at most three times per session, so the guard can never wedge a session.
//!
//! What is answered here and what is not (D74: never a worse guard than Node, so every doubtful case is Node's):
//! - Answered here: the switch, the skip file, reply and transcript text, the hedge and acknowledgment scan with the
//!   requirement-phrasing and quoted-text exemptions, loop safety, the state file `speculation-guard-state-<session>.json`
//!   and the block.
//! - Deferred to Node: every Stop while the Jev master switch is on (the Jev call path, its two integrations and its
//!   log stay on Node, see `docs/AH-ENGINE.md`); the Stop right after a block (its state carries a pending outcome record
//!   that Node reports to the Jev log); `guards.inferenceCheck` on (the causal-claim scan reads tool evidence); a relative
//!   transcript path; a transcript line `JSON.parse` might read differently from `serde_json`.
//!
//! Mirrors `hooks/speculation-guard.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::replykit::Defer;
use crate::checks::replykit::io::{home_of, js_id_string, prune_stale, read_window, safe_session, sha1_hex, truthy};
use crate::checks::replykit::json::{self, Oj, ParseError, js_number, quote};
use crate::checks::replykit::transcript::{last_assistant_text, tail_lines};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::jev::{Env as JevEnv, JevSettings, settings::Sources};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

pub(crate) mod mask;
#[cfg(test)]
mod tests;

pub use mask::mask_quoted_text;

struct Pats {
    markers: Vec<Regex>,
    acks: Vec<Regex>,
    obligation: Regex,
    requirement_line: Regex,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| {
        let ci = |key: &str| defaults::list(key).into_iter().map(|s| jsre::compile(s, true)).collect::<Vec<_>>();
        let mut acks = ci("speculation_guard.ack_ci");
        acks.extend(defaults::list("speculation_guard.ack_cs").into_iter().map(|s| jsre::compile(s, false)));
        Pats {
            markers: ci("speculation_guard.markers"),
            acks,
            obligation: jsre::compile(defaults::text("speculation_guard.obligation_re"), true),
            requirement_line: jsre::compile(defaults::text("speculation_guard.requirement_line_re"), true),
        }
    })
}

/// The first 40 UTF-16 units of `s` (whole characters only: a pair the cut would split is left out, which no pattern
/// that reads this window can tell apart from JavaScript's lone surrogate).
fn window(s: &str, units: usize) -> &str {
    let mut used = 0usize;
    for (i, c) in s.char_indices() {
        used += c.len_utf16();
        if used > units {
            return &s[..i];
        }
    }
    s
}

/// `isObligationPhrasing(text, matchText, matchIndex)`: a "must be"/"should be" that states a duty, not a claim.
fn is_obligation_phrasing(text: &str, start: usize, end: usize) -> bool {
    let p = pats();
    if p.obligation.is_match(window(&text[end..], defaults::num("speculation_guard.obligation_window") as usize)) {
        return true;
    }
    let line_start = text[..start].rfind('\n').map_or(0, |i| i + 1);
    let line_end = text[start..].find('\n').map_or(text.len(), |i| start + i);
    p.requirement_line.is_match(&text[line_start..line_end])
}

/// `findSpeculationHit(text)`: the first hedge, in pattern order, that is not exempt.
pub fn find_speculation_marker(text: &str) -> Option<String> {
    let p = pats();
    let modal = defaults::list("speculation_guard.modal_markers");
    for re in &p.markers {
        let Some(first) = re.find(text) else { continue };
        if !modal.contains(&first.as_str().to_ascii_lowercase().as_str()) {
            return Some(first.as_str().to_string());
        }
        if let Some(m) = re.find_iter(text).find(|m| !is_obligation_phrasing(text, m.start(), m.end())) {
            return Some(m.as_str().to_string());
        }
    }
    None
}

/// `hasAcknowledgment(text)`.
pub fn has_acknowledgment(text: &str) -> bool {
    pats().acks.iter().any(|re| re.is_match(text))
}

/// What the session's state file said.
struct Prior {
    last_blocked: String,
    blocks: f64,
    pending: bool,
}

fn read_prior(path: &Path) -> Result<Prior, Defer> {
    let none = Prior { last_blocked: String::new(), blocks: 0.0, pending: false };
    let Ok(raw) = std::fs::read_to_string(path) else { return Ok(none) };
    let t = js_trim(&raw);
    if t.is_empty() {
        return Ok(none);
    }
    match json::parse(t) {
        Err(ParseError::Invalid) => Ok(none),
        Err(ParseError::Unsure) => Err(Defer),
        Ok(v) if v.truthy() && v.is_object_like() => {
            let blocks = match v.get("blocks") {
                Some(Oj::Num(n)) if n.is_finite() => *n,
                _ => 0.0,
            };
            let pending = match v.get("pending") {
                Some(p @ Oj::Obj(_)) => p.get("h").and_then(Oj::as_str).is_some() && p.get("source").and_then(Oj::as_str).is_some(),
                _ => false,
            };
            Ok(Prior { last_blocked: v.get("hash").and_then(Oj::as_str).unwrap_or("").to_string(), blocks, pending })
        }
        // a legacy file holding just a hash (or any other JSON scalar): the whole text is the blocked hash
        Ok(_) => Ok(Prior { last_blocked: t.to_string(), blocks: 0.0, pending: false }),
    }
}

fn jev_enabled(st: &Settings, env: &RequestEnv) -> bool {
    let home = Path::new(&st.home);
    let sources = Sources::load(home, JevEnv::from_pairs(env.to_map()));
    JevSettings::resolve(home, sources).enabled
}

fn decide(payload: &Value, env: &RequestEnv) -> Result<Verdict, Defer> {
    let Some(home) = home_of(env) else { return Err(Defer) };
    let st = Settings { home: home.clone(), env: env.to_map() };
    if !get_bool(&st, defaults::raw("speculation_guard.setting")) {
        return Ok(Verdict::Allow);
    }
    let Some(transcript) = payload.get("transcript_path").and_then(Value::as_str).filter(|p| !p.is_empty()) else { return Ok(Verdict::Allow) };
    if !transcript.starts_with('/') {
        return Err(Defer);
    }
    let session_raw = match payload.get("session_id").filter(|s| truthy(s)) {
        Some(s) => js_id_string(s).ok_or(Defer)?,
        None => sha1_hex(transcript)[..16].to_string(),
    };
    let state_dir = Path::new(&home).join(defaults::text("replykit.state_dir"));
    let state_name = format!("{}{}{}", defaults::text("speculation_guard.state_prefix"), safe_session(&session_raw, None), defaults::text("replykit.json_ext"));
    let state_file = state_dir.join(&state_name);

    let payload_text = payload.get("last_assistant_message").and_then(Value::as_str).filter(|s| !js_trim(s).is_empty());
    let window_bytes = defaults::num("speculation_guard.window_bytes");
    let transcript_lines = |map: Option<&dyn Fn(&str) -> String>| -> Result<Option<String>, Defer> {
        let Some(tail) = read_window(transcript, window_bytes) else { return Ok(None) };
        last_assistant_text(&tail_lines(&tail), map)
    };
    let last_text = match payload_text {
        Some(t) => t.to_string(),
        None => match transcript_lines(None)? {
            Some(t) => t,
            None => return Ok(Verdict::Allow),
        },
    };
    if last_text.is_empty() {
        return Ok(Verdict::Allow);
    }
    let mut marker_text = match payload_text {
        Some(t) => mask_quoted_text(t),
        None => transcript_lines(Some(&mask_quoted_text))?.unwrap_or_default(),
    };
    if js_trim(&marker_text).is_empty() {
        marker_text = last_text.clone();
    }
    let msg_hash = sha1_hex(&last_text);
    let prior = read_prior(&state_file)?;
    // the outcome of the previous block is reported to the Jev log by the Node hook
    if prior.pending {
        return Err(Defer);
    }
    if is_skipped(&st, defaults::text("speculation_guard.guard_name")) {
        return Ok(Verdict::Allow);
    }
    // every Jev consult, its log rows and the framed-expectation relaxation live on the Node side
    if jev_enabled(&st, env) {
        return Err(Defer);
    }
    let loop_safe = msg_hash == prior.last_blocked || prior.blocks >= defaults::num("speculation_guard.max_blocks") as f64;
    let Some(marker) = find_speculation_marker(&marker_text).filter(|_| !has_acknowledgment(&last_text)) else {
        // no hedge, or an honest one: the causal-claim scan (off unless `guards.inferenceCheck` is on) reads tool evidence
        if !loop_safe && get_bool(&st, defaults::raw("speculation_guard.inference_setting")) {
            return Err(Defer);
        }
        return Ok(Verdict::Allow);
    };
    if loop_safe {
        return Ok(Verdict::Allow);
    }
    let body = format!(
        "{{\"hash\":{},\"blocks\":{},\"pending\":{{\"h\":{},\"source\":{}}}}}",
        quote(&msg_hash),
        js_number(prior.blocks + 1.0),
        quote(&msg_hash),
        quote(defaults::text("speculation_guard.source_regex"))
    );
    let persisted = std::fs::create_dir_all(&state_dir).is_ok() && std::fs::write(&state_file, body).is_ok();
    if !persisted {
        return Ok(Verdict::Allow);
    }
    prune_stale(&state_dir, defaults::text("speculation_guard.prune_prefix"), Some(&state_name));
    let what = msg::render("speculation_guard.msg_what", &[("marker", &marker)]);
    let reason = msg::message(
        Kind::Block,
        defaults::text("speculation_guard.guard_name"),
        &Parts { what: &what, why: defaults::text("speculation_guard.msg_why"), instead: defaults::text("speculation_guard.msg_instead"), ..Parts::default() },
    );
    let out = format!("{{\"decision\":\"block\",\"reason\":{}}}\n", quote(&reason));
    Ok(Verdict::Exact(Exact { code: 0, out, err: String::new() }))
}

/// The registered `speculation-guard` check.
pub struct SpeculationGuard;

impl Check for SpeculationGuard {
    fn name(&self) -> &'static str {
        "speculation-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("speculation_guard.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        // Needs the payload and the transcript; without them, let Node decide.
        (s.event == defaults::text("speculation_guard.event")).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if s.event != defaults::text("speculation_guard.event") {
            return None;
        }
        Some(decide(payload, env).unwrap_or(Verdict::Defer))
    }
}
