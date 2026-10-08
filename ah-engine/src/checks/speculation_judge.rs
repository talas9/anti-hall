//! Built-in `check = "speculation-judge"`: a port of the Node speculation-judge (Stop; the opt-in semantic judge).
//!
//! The hook asks a Claude model whether the reply states something as fact that nothing in the session supports, given
//! the latest user request and the session's tool evidence, and blocks once when the model says so. It is off unless
//! `jev.semanticJudge` is on (`ANTIHALL_SEMANTIC_JUDGE`), and then it does nothing at all.
//!
//! What is answered here and what is not:
//! - Answered here: the off switch, the judge-child guard (`ANTIHALL_JUDGE_CHILD=1`), the skip file, the backend switch
//!   `jev.speculationBackend` (`jev`: the judge never asks the model), Jev's own speculation integration being on (the
//!   judge stands down), a payload without a transcript path, `jev.judgeBackend` `api` with no Anthropic key (Node makes
//!   no call), a reply that is empty, already blocked or past the block cap; and, in a one-shot process, the model call
//!   itself through the Claude CLI (`judge::cli`), the state file and the block, byte for byte as Node writes them.
//! - Deferred to Node: a call through the Anthropic API (`api` with a key, or `auto` with one): the engine never calls
//!   it; a relative transcript path; a transcript or state line this port cannot read exactly; and, in the daemon, any
//!   reply that needs the model (a 5 to 25 second call cannot run inside the daemon's exchange deadline).
//!
//! Every native model call leaves a telemetry row (`judge::telemetry`).
//!
//! Mirrors `hooks/speculation-judge.js`, `hooks/lib/judge-core.js` and `hooks/lib/judge-child-exit.js`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent or unreadable state file is "nothing blocked yet" (Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::{js_trim, js_trim_end};
use crate::checks::jsport::text::len16;
use crate::checks::replykit::Defer;
use crate::checks::replykit::io::{home_of, js_id_string, read_window, safe_session, sha1_hex, truthy};
use crate::checks::replykit::json::{self, Oj, ParseError, js_number, quote};
use crate::checks::replykit::transcript::{last_assistant_text, tail_lines};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::jev::settings::{Mode, Sources};
use crate::jev::{Env as JevEnv, JevSettings};
use crate::judge::settings::{Route, integration_backend, route};
use crate::judge::{cli, evidence, input, telemetry};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;

/// The registered `speculation-judge` check.
pub struct SpeculationJudge;

/// The judge's claim as JavaScript holds it: `head`, then a lone high surrogate when the cut split a pair (a Rust string
/// cannot hold one), then `tail` (the ellipsis of a cut claim, else empty).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Claim {
    head: String,
    lone: Option<u16>,
    tail: &'static str,
}

/// `sanitizeClaim(s)`: control characters to spaces, bidi controls removed, white space collapsed, at most `claim_max`
/// UTF-16 units (`slice(0, max).trimEnd()`) plus an ellipsis.
fn sanitize_claim(s: Option<&str>) -> Claim {
    let plain = |head: String| Claim { head, lone: None, tail: "" };
    let dflt = || plain(defaults::text("speculation_judge.claim_default").to_string());
    let Some(s) = s else { return dflt() };
    let controls = jsre::compile(defaults::text("speculation_judge.claim_controls_re"), false);
    let bidi = jsre::compile(defaults::text("speculation_judge.claim_bidi_re"), false);
    let ws = jsre::compile(defaults::text("speculation_judge.claim_ws_re"), false);
    let t = controls.replace_all(s, " ");
    let t = bidi.replace_all(&t, "");
    let t = ws.replace_all(&t, " ");
    let t = js_trim(&t).to_string();
    if t.is_empty() {
        return dflt();
    }
    let max = defaults::num("speculation_judge.claim_max") as usize;
    if len16(&t) <= max {
        return plain(t);
    }
    let mut head = String::new();
    let mut units = 0usize;
    let mut lone = None;
    for c in t.chars() {
        let w = c.len_utf16();
        if units + w > max {
            if units < max {
                let mut buf = [0u16; 2];
                lone = Some(c.encode_utf16(&mut buf)[0]);
            }
            break;
        }
        units += w;
        head.push(c);
    }
    // trimEnd() of a text ending in a lone surrogate trims nothing: it is not white space
    let head = if lone.is_some() { head } else { js_trim_end(&head).to_string() };
    Claim { head, lone, tail: defaults::text("speculation_judge.claim_ellipsis") }
}

/// The state file's prior: the blocked hash and the block count (Node: the try/catch around JSON.parse of the file).
fn read_prior(path: &Path) -> Result<(String, f64), Defer> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Ok((String::new(), 0.0)) };
    let t = js_trim(&raw);
    if t.is_empty() {
        return Ok((String::new(), 0.0));
    }
    match json::parse(t) {
        Err(ParseError::Invalid) => Ok((String::new(), 0.0)),
        Err(ParseError::Unsure) => Err(Defer),
        Ok(v) => {
            let hash = v.get("hash").and_then(Oj::as_str).unwrap_or("").to_string();
            let blocks = match (&v, v.get("blocks")) {
                (Oj::Obj(_), Some(Oj::Num(n))) if n.is_finite() => *n,
                _ => 0.0,
            };
            Ok((hash, blocks))
        }
    }
}

fn jev_speculation_on(home: &str, env: &RequestEnv) -> bool {
    let home = Path::new(home);
    let s = JevSettings::resolve(home, Sources::load(home, JevEnv::from_pairs(env.to_map())));
    s.enabled && s.mode(defaults::text("speculation_judge.jev_id"), false) == Mode::On
}

/// The block line, a lone surrogate in the claim written as JSON.stringify writes it (`\udxxx`).
fn block_line(claim: &Claim) -> String {
    // A private-use character that occurs nowhere in the message stands in for the lone half until the text is quoted.
    let probe = format!("{}{}{}", claim.head, claim.tail, defaults::text("speculation_judge.msg_what"));
    let ph = claim.lone.and_then(|h| ('\u{E000}'..='\u{F8FF}').find(|c| !probe.contains(*c)).map(|c| (h, c)));
    let claim_text = match ph {
        Some((_, c)) => format!("{}{c}{}", claim.head, claim.tail),
        None => format!("{}{}", claim.head, claim.tail),
    };
    let what = msg::render("speculation_judge.msg_what", &[("claim", &claim_text)]);
    let reason = msg::message(
        Kind::Block,
        defaults::text("speculation_judge.guard_name"),
        &Parts { what: &what, why: defaults::text("speculation_judge.msg_why"), instead: defaults::text("speculation_judge.msg_instead"), ..Parts::default() },
    );
    let mut quoted = quote(&reason);
    if let Some((h, c)) = ph {
        quoted = quoted.replace(c, &format!("\\u{h:04x}"));
    }
    format!("{{\"decision\":{},\"reason\":{quoted}}}\n", quote(defaults::text("speculation_judge.decision_block")))
}

fn decide(payload: &Value, env: &RequestEnv) -> Result<Verdict, Defer> {
    if env.get(defaults::text("speculation_judge.child_env")) == Some(defaults::text("speculation_judge.child_value")) {
        return Ok(Verdict::Allow);
    }
    let Some(home) = home_of(env) else { return Err(Defer) };
    let st = Settings { home: home.clone(), env: env.to_map() };
    if !get_bool(&st, defaults::raw("speculation_judge.setting")) {
        return Ok(Verdict::Allow);
    }
    if is_skipped(&st, defaults::text("speculation_judge.guard_name")) {
        return Ok(Verdict::Allow);
    }
    // the per-integration backend switch: `jev` leaves the speculation question to speculation-guard's Jev path alone
    let backend = integration_backend(&st, defaults::raw("speculation_judge.backend_setting"));
    if backend == defaults::text("speculation_judge.backend_jev") || backend == defaults::text("cascade.backend") {
        return Ok(Verdict::Allow);
    }
    // Jev's own speculation integration fully on: speculation-guard already asks it on every Stop (Node: no double pay)
    if jev_speculation_on(&home, env) {
        return Ok(Verdict::Allow);
    }
    let Some(transcript) = payload.get("transcript_path").and_then(Value::as_str).filter(|p| !p.is_empty()) else { return Ok(Verdict::Allow) };
    // the request's environment is the allowlisted one, which never carries ANTHROPIC_API_KEY
    match route(&st, false) {
        Route::NoKey => return Ok(Verdict::Allow),
        Route::Api | Route::Unknown => return Err(Defer),
        Route::Cli => {}
    }
    if !transcript.starts_with('/') {
        return Err(Defer);
    }
    let session_raw = match payload.get("session_id").filter(|s| truthy(s)) {
        Some(s) => js_id_string(s).ok_or(Defer)?,
        None => sha1_hex(transcript)[..16].to_string(),
    };
    let state_dir = Path::new(&home).join(defaults::text("replykit.state_dir"));
    let state_file = state_dir.join(format!(
        "{}{}{}",
        defaults::text("speculation_judge.state_prefix"),
        safe_session(&session_raw, None),
        defaults::text("replykit.json_ext")
    ));
    let last_text = match payload.get("last_assistant_message").and_then(Value::as_str).filter(|s| !js_trim(s).is_empty()) {
        Some(t) => t.to_string(),
        None => match read_window(transcript, defaults::num("speculation_judge.reply_window")) {
            Some(tail) => last_assistant_text(&tail_lines(&tail), None)?.unwrap_or_default(),
            None => String::new(),
        },
    };
    if js_trim(&last_text).is_empty() {
        return Ok(Verdict::Allow);
    }
    let msg_hash = sha1_hex(format!("{last_text}{}", defaults::text("speculation_judge.hash_suffix")));
    let (blocked_hash, blocks) = read_prior(&state_file)?;
    if msg_hash == blocked_hash || blocks >= defaults::num("speculation_judge.max_blocks") as f64 {
        return Ok(Verdict::Allow);
    }
    let (evidence, user_request) = match read_window(transcript, defaults::num("speculation_judge.evidence_window")) {
        Some(tail) => {
            let lines = tail_lines(&tail);
            (evidence::collect_evidence(&lines)?, evidence::last_user_prompt(&lines)?)
        }
        None => (Vec::new(), String::new()),
    };
    // Everything above is cheap and side-effect free; the model call is not, and the daemon cannot wait for it.
    if !crate::judge::blocking_calls_allowed() {
        return Err(Defer);
    }
    let judge_input = input::build_judge_input(&last_text, &evidence, &user_request);
    let model = crate::judge::settings::model(&st);
    let child_env = cli::process_env();
    let out = cli::run(&cli::CliCall {
        system: defaults::text("speculation_judge.system_prompt"),
        model: &model,
        input: &judge_input,
        env: &child_env,
        timeout: defaults::millis("speculation_judge.timeout_ms"),
    });
    let decision = out.result.as_ref().ok().and_then(|t| cli::parse_decision(t));
    let error = match (&out.result, &decision) {
        (Err(e), _) => Some(e.word()),
        (Ok(_), None) => Some(defaults::text("judge.err_answer")),
        _ => None,
    };
    let verdict_word = decision.as_ref().and_then(|d| d.get("decision")).and_then(Value::as_str);
    telemetry::record(
        Path::new(&home),
        &telemetry::Row {
            integration: defaults::text("speculation_judge.jev_id"),
            backend: defaults::text("judge.backend_haiku_cli"),
            model: Some(&model),
            ms: out.ms,
            confidence: None,
            decision: verdict_word,
            error,
        },
    );
    let Some(d) = decision.as_ref() else { return Ok(Verdict::Allow) };
    if verdict_word != Some(defaults::text("speculation_judge.decision_block")) {
        return Ok(Verdict::Allow);
    }
    let body = format!("{{\"hash\":{},\"blocks\":{}}}", quote(&msg_hash), js_number(blocks + 1.0));
    if std::fs::create_dir_all(&state_dir).and_then(|()| crate::atomic::write(&state_file, body)).is_err() {
        return Ok(Verdict::Allow);
    }
    let claim = sanitize_claim(d.get("claim").and_then(Value::as_str));
    Ok(Verdict::Exact(Exact { code: 0, out: block_line(&claim), err: String::new() }))
}

impl Check for SpeculationJudge {
    fn name(&self) -> &'static str {
        "speculation-judge"
    }

    fn summary(&self) -> &'static str {
        defaults::text("speculation_judge.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.event == defaults::text("speculation_judge.event")).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        (s.event == defaults::text("speculation_judge.event")).then(|| decide(payload, env).unwrap_or(Verdict::Defer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> RequestEnv {
        let mut all = vec![("HOME", "/nonexistent-ah-home")];
        all.extend_from_slice(pairs);
        RequestEnv::from_pairs(all)
    }

    fn stop() -> Value {
        serde_json::json!({"hook_event_name": "Stop", "transcript_path": "/nonexistent-ah-home/t.jsonl", "last_assistant_message": "The cause is x."})
    }

    fn d(e: &RequestEnv) -> Verdict {
        decide(&stop(), e).unwrap_or(Verdict::Defer)
    }

    #[test]
    fn off_by_default_and_for_the_judge_child() {
        assert_eq!(d(&env(&[])), Verdict::Allow);
        assert_eq!(d(&env(&[("ANTIHALL_SEMANTIC_JUDGE", "0")])), Verdict::Allow);
        assert_eq!(d(&env(&[("ANTIHALL_JUDGE_CHILD", "1"), ("ANTIHALL_SEMANTIC_JUDGE", "1")])), Verdict::Allow);
    }

    #[test]
    fn the_api_backend_without_a_key_makes_no_call_and_with_a_key_defers() {
        assert_eq!(d(&env(&[("ANTIHALL_SEMANTIC_JUDGE", "1")])), Verdict::Allow);
        assert_eq!(d(&env(&[("ANTIHALL_SEMANTIC_JUDGE", "1"), ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "k")])), Verdict::Defer);
        assert_eq!(
            d(&env(&[("ANTIHALL_SEMANTIC_JUDGE", "1"), ("ANTIHALL_JUDGE_BACKEND", "auto"), ("CLAUDE_PLUGIN_OPTION_ANTHROPIC_API_KEY", "k")])),
            Verdict::Defer
        );
    }

    #[test]
    fn the_jev_backend_switch_never_asks_the_model() {
        let e = env(&[("ANTIHALL_SEMANTIC_JUDGE", "1"), ("ANTIHALL_JUDGE_BACKEND", "cli"), ("ANTIHALL_JEV_SPECULATION_BACKEND", "jev")]);
        assert_eq!(d(&e), Verdict::Allow);
    }

    #[test]
    fn the_cli_backend_defers_in_the_daemon_when_the_model_is_needed() {
        // unit tests never set judge::allow_blocking_calls, as the daemon never does
        let e = env(&[("ANTIHALL_SEMANTIC_JUDGE", "1"), ("ANTIHALL_JUDGE_BACKEND", "cli")]);
        assert_eq!(d(&e), Verdict::Defer);
        // a payload with no transcript path is answered without the model
        assert_eq!(decide(&serde_json::json!({"hook_event_name": "Stop"}), &e).unwrap(), Verdict::Allow);
        // a relative transcript path is Node's to resolve
        assert_eq!(decide(&serde_json::json!({"transcript_path": "rel.jsonl", "last_assistant_message": "x"}), &e), Err(Defer));
    }

    #[test]
    fn a_request_without_a_home_defers() {
        assert_eq!(decide(&stop(), &RequestEnv::from_pairs([("ANTIHALL_SEMANTIC_JUDGE", "0")])), Err(Defer));
    }

    #[test]
    fn claims_are_sanitized_like_node() {
        assert_eq!(sanitize_claim(None).head, "an unverified factual claim");
        assert_eq!(sanitize_claim(Some("  \u{1}\n ")).head, "an unverified factual claim");
        assert_eq!(sanitize_claim(Some(" a\u{1}\n b\u{202E}c  ")).head, "a bc");
        let long = format!("{} {}", "x".repeat(119), "z".repeat(10));
        assert_eq!(sanitize_claim(Some(&long)), Claim { head: "x".repeat(119), lone: None, tail: "\u{2026}" }, "the cut is trimmed at its end");
        let pair = format!("{}\u{1F600}", "y".repeat(119));
        let c = sanitize_claim(Some(&pair));
        assert_eq!((c.head.as_str(), c.lone), ("y".repeat(119).as_str(), Some(0xD83D)));
        assert!(block_line(&c).contains("\\ud83d\u{2026}' as fact"), "{}", block_line(&c));
    }
}
