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
//! - Answered here too, with Node's own Jev contract: while the Jev master switch is on the reply is asked about on the
//!   shared Jev lane (`speculation`, add-block trust, baseline "the regex does not block", waited for up to Jev's own
//!   timeout exactly as the Node hook waits); a confident "speculative" adds a block; a hedge that sits under a plan or
//!   expectation heading is asked once more (`speculationFramed`, relax-block); every decision is also written to the
//!   guard's own `jev-judge.ndjson`; and the Stop after a block reports that block's outcome to the Jev decision log.
//! - Deferred to Node: `guards.inferenceCheck` on (the causal-claim scan reads tool evidence); with Jev on, a payload that
//!   does not carry the reply text (Jev judges the de-duplicated transcript text, which this port does not rebuild) and a
//!   reply whose 8000-unit Jev window would cut a surrogate pair; a relative transcript path; a transcript line
//!   `JSON.parse` might read differently from `serde_json`.
//!
//! Mirrors `hooks/speculation-guard.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::replykit::Defer;
use crate::checks::replykit::io::{home_of, js_id_string, prefix_utf16, prune_stale, read_window, safe_session, sha1_hex, truthy};
use crate::checks::replykit::json::{self, Oj, ParseError, js_number, quote};
use crate::checks::replykit::transcript::{last_assistant_text, tail_lines};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::jev::{AskRequest, Env as JevEnv, JevSettings, Question, Trust, settings::Sources};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::io::Write;
use std::path::Path;

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
    static P: crate::defaults::Cache<Pats> = crate::defaults::Cache::new();
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

/// `findSpeculationHit(text)`: the first hedge, in pattern order, that is not exempt, and the byte offset it starts at.
pub fn find_speculation_hit(text: &str) -> Option<(String, usize)> {
    let p = pats();
    let modal = defaults::list("speculation_guard.modal_markers");
    for re in &p.markers {
        let Some(first) = re.find(text) else { continue };
        if !modal.contains(&first.as_str().to_ascii_lowercase().as_str()) {
            return Some((first.as_str().to_string(), first.start()));
        }
        if let Some(m) = re.find_iter(text).find(|m| !is_obligation_phrasing(text, m.start(), m.end())) {
            return Some((m.as_str().to_string(), m.start()));
        }
    }
    None
}

/// `findSpeculationMarker(text)`: the hedge of [`find_speculation_hit`] without its position.
pub fn find_speculation_marker(text: &str) -> Option<String> {
    find_speculation_hit(text).map(|(m, _)| m)
}

struct Frame {
    line_prefix: Regex,
    heading: Regex,
    heading_label: Regex,
    inline: Regex,
}

fn frame() -> &'static Frame {
    static F: crate::defaults::Cache<Frame> = crate::defaults::Cache::new();
    F.get_or_init(|| {
        let label = defaults::text("speculation_guard.frame_label");
        Frame {
            line_prefix: jsre::compile(&defaults::text("speculation_guard.frame_line_prefix").replace("LABEL", label), true),
            heading: jsre::compile(defaults::text("speculation_guard.frame_heading"), false),
            heading_label: jsre::compile(&defaults::text("speculation_guard.frame_heading_label").replace("LABEL", label), true),
            inline: jsre::compile(defaults::text("speculation_guard.frame_inline"), true),
        }
    })
}

/// `isFramedHit(text, matchIndex)`: the hit sits on a line, or under a heading or labelled line of its section, that frames
/// it as an expectation or a plan rather than a claim about the project's current state.
fn is_framed_hit(text: &str, at: usize) -> bool {
    let f = frame();
    let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
    let line_end = text[at..].find('\n').map_or(text.len(), |i| at + i);
    let line = &text[line_start..line_end];
    if f.line_prefix.is_match(line) || f.inline.is_match(line) {
        return true;
    }
    let mut blank_run = 0;
    for l in text[..line_start].split('\n').rev() {
        if js_trim(l).is_empty() {
            blank_run += 1;
            if blank_run >= 2 {
                return false;
            }
            continue;
        }
        blank_run = 0;
        if let Some(h) = f.heading.captures(l) {
            return f.heading_label.is_match(js_trim(&h[1]));
        }
        if f.line_prefix.is_match(l) {
            return true;
        }
    }
    false
}

/// `hasAcknowledgment(text)`.
pub fn has_acknowledgment(text: &str) -> bool {
    pats().acks.iter().any(|re| re.is_match(text))
}

/// What the session's state file said.
struct Prior {
    last_blocked: String,
    blocks: f64,
    /// The outcome-capture record the previous block left: (decision hash, source).
    pending: Option<(String, String)>,
}

fn read_prior(path: &Path) -> Result<Prior, Defer> {
    let none = Prior { last_blocked: String::new(), blocks: 0.0, pending: None };
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
                Some(p @ Oj::Obj(_)) => match (p.get("h").and_then(Oj::as_str), p.get("source").and_then(Oj::as_str)) {
                    (Some(h), Some(src)) => Some((h.to_string(), src.to_string())),
                    _ => None,
                },
                _ => None,
            };
            Ok(Prior { last_blocked: v.get("hash").and_then(Oj::as_str).unwrap_or("").to_string(), blocks, pending })
        }
        // a legacy file holding just a hash (or any other JSON scalar): the whole text is the blocked hash
        Ok(_) => Ok(Prior { last_blocked: t.to_string(), blocks: 0.0, pending: None }),
    }
}

fn jev_enabled(st: &Settings, env: &RequestEnv) -> bool {
    let home = Path::new(&st.home);
    let sources = Sources::load(home, JevEnv::from_pairs(env.to_map()));
    JevSettings::resolve(home, sources).enabled
}

/// One line of the guard's own Jev decision log (Node: the entry `appendJevLog` writes, `verdict` last).
struct JudgeEntry {
    backend: &'static str,
    reason: String,
    ms: Option<u64>,
    confidence: Option<f64>,
    regex_verdict: bool,
}

/// Append one line to `<home>/.anti-hall/logs/jev-judge.ndjson`, emptying the file first once it is over the cap. Best
/// effort: a failure never changes the decision (Node: `appendJevLog`).
fn append_judge_log(home: &str, line: &str) {
    let path = Path::new(home).join(defaults::text("paths.base_dir")).join(defaults::text("speculation_guard.judge_log"));
    let _ = (|| -> std::io::Result<()> {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d)?;
        }
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > defaults::num("speculation_guard.judge_log_max_bytes")) {
            std::fs::write(&path, "")?;
        }
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        f.write_all(line.as_bytes())
    })();
}

fn now_iso() -> String {
    crate::jev::assist::iso_ms(crate::checks::replykit::io::now_ms() as u64)
}

/// The log line of one decision: `{"ts":..,"backend":..,"reason":..,"ms":..,"confidence":..,"regexVerdict":..,"verdict":..}`.
fn judge_line(e: &JudgeEntry, verdict: &str) -> String {
    let num = |v: Option<f64>| v.map_or("null".to_string(), js_number);
    format!(
        "{{\"ts\":{},\"backend\":{},\"reason\":{},\"ms\":{},\"confidence\":{},\"regexVerdict\":{},\"verdict\":{}}}\n",
        quote(&now_iso()),
        quote(e.backend),
        quote(&e.reason),
        num(e.ms.map(|m| m as f64)),
        num(e.confidence),
        e.regex_verdict,
        quote(verdict)
    )
}

/// The project label of a decision row: see [`crate::jev::shared::project_for`].
fn project_of(payload: &Value) -> Option<String> {
    crate::jev::shared::project_for(payload.get("cwd").and_then(Value::as_str))
}

fn ask_request(id: &str, q: Question, state: &str, trust: Trust, baseline: bool, session: &str, payload: &Value) -> AskRequest {
    let mut r = AskRequest::new(id, q, state, trust, Value::Bool(baseline));
    r.session_id = Some(session.to_string());
    r.project = project_of(payload);
    r
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
    let skipped = is_skipped(&st, defaults::text("speculation_guard.guard_name"));
    let jev_env = JevEnv::from_pairs(env.to_map());
    let jev_on = jev_enabled(&st, env);
    let loop_safe = msg_hash == prior.last_blocked || prior.blocks >= defaults::num("speculation_guard.max_blocks") as f64;
    let inference_on = get_bool(&st, defaults::raw("speculation_guard.inference_setting"));
    // Everything that would have to be rebuilt from the transcript, or that Node alone can judge, is decided before the
    // first side effect: a deferral after an ask or a write would be done twice.
    if inference_on && !loop_safe && jev_on {
        return Err(Defer);
    }
    let jev_text = if jev_on && !loop_safe && !skipped {
        let Some(t) = payload_text else { return Err(Defer) };
        Some(prefix_utf16(t, defaults::num("speculation_guard.jev_state_chars") as usize).ok_or(Defer)?)
    } else {
        None
    };

    // OUTCOME CAPTURE: the previous Stop's block is classified against THIS reply (before the skip check: a skip is itself
    // one of the outcomes), reported to the Jev decision log, and cleared so it is evaluated once.
    if let Some((h, source)) = &prior.pending {
        let outcome = if skipped {
            Some(defaults::text("speculation_guard.outcome_override"))
        } else if has_acknowledgment(&last_text) {
            Some(defaults::text("speculation_guard.outcome_evidence"))
        } else if find_speculation_marker(&marker_text).is_some() {
            Some(defaults::text("speculation_guard.outcome_repeat"))
        } else {
            None
        };
        if let Some(o) = outcome {
            let project = project_of(payload);
            crate::jev::shared::lane(Path::new(&home), &jev_env).record_outcome(
                defaults::text("speculation_guard.jev_id"),
                h,
                o,
                Some(source),
                project.as_deref(),
            );
        }
        let cleared = format!("{{\"hash\":{},\"blocks\":{},\"pending\":null}}", quote(&prior.last_blocked), js_number(prior.blocks));
        let _ = std::fs::create_dir_all(&state_dir).and_then(|()| std::fs::write(&state_file, cleared));
    }
    if skipped {
        return Ok(Verdict::Allow);
    }

    let regex_hit = find_speculation_hit(&marker_text);
    let regex_would_block = regex_hit.is_some() && !has_acknowledgment(&last_text);

    // JEV: the speculation question (add-block). A confident "speculative" adds a block; any failure leaves the regex verdict.
    let mut entry: Option<JudgeEntry> = None;
    let mut jev_block = false;
    let mut jev_hash = String::new();
    if jev_on && loop_safe {
        entry = Some(JudgeEntry { backend: "none", reason: "loop-safe".into(), ms: None, confidence: None, regex_verdict: regex_would_block });
    } else if let Some(text) = &jev_text {
        let q = Question::noul(
            defaults::text("speculation_guard.jev_instructions"),
            defaults::text("speculation_guard.jev_true"),
            defaults::text("speculation_guard.jev_false"),
        );
        let mut req = ask_request(defaults::text("speculation_guard.jev_id"), q, text, Trust::AddBlock, false, &session_raw, payload);
        req.compare = Some(regex_would_block);
        req.env = Some(jev_env.clone());
        let d = crate::jev::shared::lane(Path::new(&home), &jev_env).ask(&req);
        if d.jev == Value::Null {
            if let Some(reason) = &d.reason {
                entry = Some(JudgeEntry {
                    backend: "jev\u{2192}regex",
                    reason: reason.to_string(),
                    ms: Some(d.ms),
                    confidence: None,
                    regex_verdict: regex_would_block,
                });
            }
        } else if d.outcome == Value::Bool(true) {
            jev_block = true;
            jev_hash = d.hash.clone();
            entry = Some(JudgeEntry { backend: "jev", reason: "confident".into(), ms: Some(d.ms), confidence: d.confidence, regex_verdict: regex_would_block });
        } else {
            let reason = if d.confident == Some(true) { "confident-allow-untrusted" } else { "low-confidence" };
            entry = Some(JudgeEntry {
                backend: "jev\u{2192}regex",
                reason: reason.into(),
                ms: Some(d.ms),
                confidence: d.confidence,
                regex_verdict: regex_would_block,
            });
        }
    }
    let finish = |v: Verdict, verdict: &str| -> Result<Verdict, Defer> {
        if let Some(e) = &entry {
            append_judge_log(&home, &judge_line(e, verdict));
        }
        Ok(v)
    };

    let mut marker: Option<String> = None;
    let mut hit_at = 0usize;
    if !jev_block {
        match regex_hit.clone().filter(|_| !has_acknowledgment(&last_text)) {
            Some((m, at)) => {
                marker = Some(m);
                hit_at = at;
            }
            None => {
                // no hedge, or an honest one: the causal-claim scan (off unless `guards.inferenceCheck` is on) reads tool
                // evidence
                if !loop_safe && inference_on {
                    return Err(Defer);
                }
                return finish(Verdict::Allow, "allow");
            }
        }
    }
    if loop_safe {
        return finish(Verdict::Allow, "allow");
    }

    // FRAMED EXPECTATION (relax-block): only for a genuine regex hit under a plan or expectation frame; Jev may turn that
    // block into a non-block, never add one.
    if !jev_block && marker.is_some() && is_framed_hit(&marker_text, hit_at) && jev_on {
        append_judge_log(
            &home,
            &format!(
                "{{\"ts\":{},\"event\":\"trigger\",\"id\":{},\"outcome\":\"seen\"}}\n",
                quote(&now_iso()),
                quote(defaults::text("speculation_guard.jev_framed_id"))
            ),
        );
        let Some(text) = &jev_text else { return Err(Defer) }; // unreachable: Jev on and not loop-safe computed it above
        let q = Question::noul(
            defaults::text("speculation_guard.framed_instructions"),
            defaults::text("speculation_guard.framed_true"),
            defaults::text("speculation_guard.framed_false"),
        );
        let mut req = ask_request(defaults::text("speculation_guard.jev_framed_id"), q, text, Trust::RelaxBlock, true, &session_raw, payload);
        req.env = Some(jev_env.clone());
        let d = crate::jev::shared::lane(Path::new(&home), &jev_env).ask(&req);
        if d.outcome == Value::Bool(false) {
            return finish(Verdict::Allow, "allow");
        }
    }

    let (pending_h, source) = if jev_block {
        (if jev_hash.is_empty() { msg_hash.clone() } else { jev_hash.clone() }, defaults::text("speculation_guard.source_jev"))
    } else {
        (msg_hash.clone(), defaults::text("speculation_guard.source_regex"))
    };
    let body = format!(
        "{{\"hash\":{},\"blocks\":{},\"pending\":{{\"h\":{},\"source\":{}}}}}",
        quote(&msg_hash),
        js_number(prior.blocks + 1.0),
        quote(&pending_h),
        quote(source)
    );
    let persisted = std::fs::create_dir_all(&state_dir).is_ok() && std::fs::write(&state_file, body).is_ok();
    if !persisted {
        return finish(Verdict::Allow, "allow");
    }
    prune_stale(&state_dir, defaults::text("speculation_guard.prune_prefix"), Some(&state_name));
    let what = if jev_block {
        defaults::text("speculation_guard.msg_what_jev").to_string()
    } else {
        msg::render("speculation_guard.msg_what", &[("marker", marker.as_deref().unwrap_or_default())])
    };
    let reason = msg::message(
        Kind::Block,
        defaults::text("speculation_guard.guard_name"),
        &Parts { what: &what, why: defaults::text("speculation_guard.msg_why"), instead: defaults::text("speculation_guard.msg_instead"), ..Parts::default() },
    );
    let out = format!("{{\"decision\":\"block\",\"reason\":{}}}\n", quote(&reason));
    finish(Verdict::Exact(Exact { code: 0, out, err: String::new() }), "block")
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
