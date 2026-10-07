//! Built-in `check = "claim-ledger"`: a port of the Node claim-ledger (Stop; ledger only, never blocks, never prints).
//!
//! The check cross-checks the last assistant message against the evidence the session produced (tool results, tool
//! inputs, hook attachments, user prompts in the last two megabytes of the transcript) and records every checkable token
//! whose referent never appeared: a count with a unit noun, a git SHA, "task N of", "N days ago", a runtime-state claim
//! made in a turn with no tool call. The record goes to `~/.anti-hall/claim-ledger/<session>.jsonl`; the hash of the last
//! message to `<session>.last` so one message is recorded once.
//!
//! What is answered here and what is not:
//! - Answered here: the switch, the skip file, the transcript walk, the flag extraction and both ledger files.
//! - Answered here too: the Jev shadow question. After the ledger is written, every flag is asked on the shared Jev lane
//!   without waiting (Node: `askDetached`), with Node's id, question, state, cache key, trust and baseline; the answer only
//!   reaches the Jev decision log (a `mode: "off"` row when the integration is off, as Node writes).
//! - Deferred to Node: a relative transcript path (Node resolves it against its own directory);
//!   a transcript line `JSON.parse` might read differently from `serde_json`; a context line cut inside a surrogate pair.
//!
//! Mirrors `hooks/claim-ledger.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::{collapse_ws, js_trim, slice_utf16};
use crate::checks::replykit::Defer;
use crate::checks::replykit::io::{home_of, js_id_string, read_window, safe_session, sha1_hex, truthy, utf16_len};
use crate::checks::replykit::json::{js_number, quote, stringify_value};
use crate::checks::replykit::transcript::{parse_line, prop, tail_lines};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::jev::assist::iso_ms;
use crate::jev::{AskRequest, Env as JevEnv, Question, Trust};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::io::Write;
use std::path::Path;
use std::sync::OnceLock;
use unicode_normalization::UnicodeNormalization;

#[cfg(test)]
mod tests;

struct Pats {
    count: Regex,
    sha: Regex,
    task: Regex,
    state: Regex,
    days_ago: Regex,
    number: Regex,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| Pats {
        count: jsre::compile(defaults::text("claim_ledger.count_re"), true),
        sha: jsre::compile(defaults::text("claim_ledger.sha_re"), false),
        task: jsre::compile(defaults::text("claim_ledger.task_re"), true),
        state: jsre::compile(defaults::text("claim_ledger.state_re"), true),
        days_ago: jsre::compile(defaults::text("claim_ledger.days_ago_re"), true),
        number: jsre::compile(defaults::text("claim_ledger.number_re"), false),
    })
}

/// `collapseText`: NFC, white space runs to one space, trimmed. Used for comparison only, never stored.
fn collapse_text(s: &str) -> String {
    let nfc: String = s.nfc().collect();
    js_trim(&collapse_ws(&nfc)).to_string()
}

/// `asText(v)`: strings as they are, nothing for a missing value, the JSON text of anything else.
fn as_text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => stringify_value(other),
    }
}

/// `textBlocks(content)`: a string as it is; the text blocks of an array joined with one space; else nothing.
fn text_blocks(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|b| b.is_object() && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("claim_ledger.type_text")))
            .filter_map(|b| prop(b, "text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}

struct Last {
    id: Option<String>,
    text: String,
    tools: usize,
}

/// What `walk` found.
struct Walked {
    last_text: String,
    evidence: String,
    tools_this_turn: usize,
    evidence_with_last: String,
    tools_at_end: usize,
}

fn push_evidence_text(ev: &mut Vec<String>, text: &str, payload_norm: Option<&str>) {
    if let Some(pn) = payload_norm {
        let n = collapse_text(text);
        if !n.is_empty() && pn.contains(&n) {
            return;
        }
    }
    ev.push(text.to_string());
}

/// `walk(lines, payloadText)`: the last assistant text, the evidence before it and the tool calls of its turn.
fn walk(lines: &[&str], payload_text: Option<&str>) -> Result<Option<Walked>, Defer> {
    let allow_no_reply = payload_text.is_some();
    let payload_norm = payload_text.map(collapse_text);
    let mut ev: Vec<String> = Vec::new();
    let mut tools_this_turn = 0usize;
    let mut last: Option<Last> = None;
    for line in lines {
        let Some(e) = parse_line(line)? else { continue };
        if !e.is_object() && !e.is_array() {
            continue;
        }
        let message = prop(&e, "message").filter(|m| truthy(m));
        let role_v = prop(&e, "type").filter(|t| truthy(t)).or_else(|| message.and_then(|m| prop(m, "role")));
        let role = role_v.and_then(Value::as_str).unwrap_or("");
        let content = if message.is_some() { message.and_then(|m| prop(m, "content")) } else { prop(&e, "content") };
        let blocks: &[Value] = content.and_then(Value::as_array).map_or(&[], Vec::as_slice);
        if role == defaults::text("claim_ledger.role_user") {
            let results: Vec<&Value> = blocks
                .iter()
                .filter(|b| truthy(b) && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("claim_ledger.type_tool_result")))
                .collect();
            if results.is_empty() {
                tools_this_turn = 0;
                ev.push(as_text(content));
            } else {
                for r in &results {
                    ev.push(as_text(prop(r, "content")));
                }
                if let Some(t) = prop(&e, "toolUseResult") {
                    ev.push(as_text(Some(t)));
                }
            }
            continue;
        }
        if role == defaults::text("claim_ledger.role_attachment") {
            ev.push(as_text(prop(&e, "attachment")));
            continue;
        }
        if role == defaults::text("claim_ledger.role_assistant") {
            for b in blocks {
                if truthy(b) && prop(b, "type").and_then(Value::as_str) == Some(defaults::text("claim_ledger.type_tool_use")) {
                    tools_this_turn += 1;
                    ev.push(as_text(prop(b, "input")));
                }
            }
            let text = text_blocks(content);
            if !js_trim(&text).is_empty() {
                let id = message.and_then(|m| prop(m, "id")).and_then(Value::as_str).map(str::to_string);
                match last.as_mut() {
                    Some(l) if id.is_some() && l.id == id => {
                        l.text.push('\n');
                        l.text.push_str(&text);
                        l.tools = tools_this_turn;
                    }
                    _ => {
                        if let Some(l) = last.take() {
                            push_evidence_text(&mut ev, &l.text, payload_norm.as_deref());
                        }
                        last = Some(Last { id, text, tools: tools_this_turn });
                    }
                }
            }
        }
    }
    let Some(last) = last else {
        if !allow_no_reply {
            return Ok(None);
        }
        let joined = ev.join("\n");
        return Ok(Some(Walked {
            last_text: String::new(),
            evidence: joined.clone(),
            tools_this_turn,
            evidence_with_last: joined,
            tools_at_end: tools_this_turn,
        }));
    };
    let evidence = ev.join("\n");
    let with_last = format!("{evidence}\n{}", last.text);
    Ok(Some(Walked { last_text: last.text, evidence, tools_this_turn: last.tools, evidence_with_last: with_last, tools_at_end: tools_this_turn }))
}

fn decimals_of(s: &str) -> usize {
    s.find('.').map_or(0, |i| s.len() - i - 1)
}

/// `collectNumbers(evidence)`: every number in the evidence, thousands separators dropped.
fn collect_numbers(evidence: &str) -> Vec<f64> {
    pats().number.find_iter(evidence).filter_map(|m| m.as_str().replace(',', "").parse::<f64>().ok()).filter(|n| n.is_finite()).collect()
}

/// `numberInEvidence`: some number in the evidence equals the claimed one at the claim's own precision.
fn number_in_evidence(token: &str, ev_nums: &[f64]) -> bool {
    let clean = token.replace(',', "");
    let Some(target) = clean.parse::<f64>().ok().filter(|n| n.is_finite()) else { return true };
    // Math.pow(10, -d) is the correctly rounded 1e-d for every d that matters (checked against Node for d in 0..=400)
    let tol = 0.5 * format!("1e-{}", decimals_of(&clean)).parse::<f64>().unwrap_or(0.0);
    ev_nums.iter().any(|n| (n - target).abs() <= tol)
}

/// One flagged token.
struct Flag {
    cls: &'static str,
    kind: &'static str,
    token: String,
    context: String,
}

/// `contextAt(text, idx)`: the line of the match, cut to the context length in UTF-16 units.
fn context_at(text: &str, idx: usize) -> Result<String, Defer> {
    let start = text[..idx].rfind('\n').map_or(0, |i| i + 1);
    let end = text[idx..].find('\n').map_or(text.len(), |i| idx + i);
    slice_utf16(&text[start..end], defaults::num("claim_ledger.context_chars") as usize).ok_or(Defer)
}

fn word_before(text: &str, at: usize) -> bool {
    text[..at].chars().next_back().is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// `extractFlags(text, evidence, toolsThisTurn)`.
fn extract_flags(text: &str, evidence: &str, tools_this_turn: usize) -> Result<Vec<Flag>, Defer> {
    let p = pats();
    let max = defaults::num("claim_ledger.max_flags") as usize;
    let ev_nums = collect_numbers(evidence);
    let mut flags: Vec<Flag> = Vec::new();
    let push = |cls: &'static str, kind: &'static str, token: &str, idx: usize, flags: &mut Vec<Flag>| -> Result<(), Defer> {
        if flags.len() < max {
            flags.push(Flag { cls, kind, token: token.to_string(), context: context_at(text, idx)? });
        }
        Ok(())
    };
    // /(?<![\w.-])(\d{1,6}...)/gi: JavaScript retries at the next position when the look-behind fails
    let mut pos = 0usize;
    while pos <= text.len() {
        let Some(c) = p.count.captures_at(text, pos) else { break };
        let m = c.get(0).map_or(0..0, |m| m.range());
        if word_before(text, m.start) {
            pos = m.start + text[m.start..].chars().next().map_or(1, char::len_utf8);
            continue;
        }
        if !number_in_evidence(c.get(1).map_or("", |g| g.as_str()), &ev_nums) {
            push(defaults::text("claim_ledger.cls_hard"), defaults::text("claim_ledger.kind_count"), &text[m.clone()], m.start, &mut flags)?;
        }
        pos = m.end;
    }
    for m in p.sha.find_iter(text) {
        if m.as_str().bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if !evidence.contains(m.as_str()) {
            push(defaults::text("claim_ledger.cls_hard"), defaults::text("claim_ledger.kind_sha"), m.as_str(), m.start(), &mut flags)?;
        }
    }
    for m in p.task.find_iter(text) {
        if !evidence.contains(m.as_str()) {
            push(defaults::text("claim_ledger.cls_hard"), defaults::text("claim_ledger.kind_task"), m.as_str(), m.start(), &mut flags)?;
        }
    }
    if tools_this_turn == 0 {
        for m in p.state.find_iter(text) {
            push(defaults::text("claim_ledger.cls_soft"), defaults::text("claim_ledger.kind_state"), m.as_str(), m.start(), &mut flags)?;
        }
    }
    for m in p.days_ago.find_iter(text) {
        push(defaults::text("claim_ledger.cls_soft"), defaults::text("claim_ledger.kind_days_ago"), m.as_str(), m.start(), &mut flags)?;
    }
    Ok(flags)
}

/// The Jev shadow question for one flag (Node: the `askDetached` call at the end of `main`).
fn ask_jev(home: &Path, env: &RequestEnv, session: &str, turn_ref: Option<&str>, f: &Flag) {
    let mut req = AskRequest::new(
        defaults::text("claim_ledger.jev_id"),
        Question::noul(defaults::text("claim_ledger.jev_instructions"), defaults::text("claim_ledger.jev_true"), defaults::text("claim_ledger.jev_false")),
        &format!("claim: {}\ncontext: {}", f.token, f.context),
        Trust::RelaxBlock,
        Value::Bool(true),
    );
    req.cache_key = Some(format!("{}\u{1}{}\u{1}{}", f.kind, f.token, f.context));
    req.session_id = Some(session.to_string());
    req.turn_ref = turn_ref.map(str::to_string);
    crate::jev::shared::ask_detached(home, &JevEnv::from_pairs(env.to_map()), req);
}

fn record_line(session: &str, hash: &str, tools: usize, msg_chars: usize, evidence_chars: usize, truncated: bool, flags: &[Flag]) -> String {
    let fl: Vec<String> = flags
        .iter()
        .map(|f| format!("{{\"cls\":{},\"kind\":{},\"token\":{},\"context\":{}}}", quote(f.cls), quote(f.kind), quote(&f.token), quote(&f.context)))
        .collect();
    format!(
        "{{\"ts\":{},\"session\":{},\"hash\":{},\"tools_this_turn\":{},\"msg_chars\":{},\"evidence_chars\":{},\"window_truncated\":{},\"flags\":[{}]}}\n",
        quote(&iso_ms(crate::checks::replykit::io::now_ms() as u64)),
        quote(session),
        quote(hash),
        js_number(tools as f64),
        js_number(msg_chars as f64),
        js_number(evidence_chars as f64),
        truncated,
        fl.join(",")
    )
}

fn decide(payload: &Value, env: &RequestEnv) -> Result<Verdict, Defer> {
    let Some(home) = home_of(env) else { return Err(Defer) };
    let st = Settings { home: home.clone(), env: env.to_map() };
    if !get_bool(&st, defaults::raw("claim_ledger.setting")) || is_skipped(&st, defaults::text("claim_ledger.guard_name")) {
        return Ok(Verdict::Allow);
    }
    let Some(transcript) = payload.get("transcript_path").and_then(Value::as_str).filter(|p| !p.is_empty()) else { return Ok(Verdict::Allow) };
    if !transcript.starts_with('/') {
        return Err(Defer);
    }
    let Some(tail) = read_window(transcript, defaults::num("claim_ledger.window_bytes")) else { return Ok(Verdict::Allow) };
    let lines = tail_lines(&tail);
    let payload_text = payload.get("last_assistant_message").and_then(Value::as_str).filter(|s| !js_trim(s).is_empty());
    let Some(walked) = walk(&lines, payload_text)? else { return Ok(Verdict::Allow) };

    let mut reply = walked.last_text.clone();
    let mut evidence = walked.evidence.clone();
    let mut tools = walked.tools_this_turn;
    let mut from_payload = false;
    if let Some(pt) = payload_text {
        let n_pay = collapse_text(pt);
        let n_last = collapse_text(&walked.last_text);
        if n_last.is_empty() || !n_pay.contains(&n_last) {
            reply = pt.to_string();
            evidence = walked.evidence_with_last.clone();
            tools = walked.tools_at_end;
            from_payload = true;
        } else if n_pay != n_last {
            reply = pt.to_string();
        }
    }
    let session_raw = match payload.get("session_id").filter(|s| truthy(s)) {
        Some(s) => js_id_string(s).ok_or(Defer)?,
        None => sha1_hex(transcript)[..16].to_string(),
    };
    let session = safe_session(&session_raw, None);
    let dir = Path::new(&home).join(defaults::text("replykit.state_dir")).join(defaults::text("claim_ledger.dir"));
    let last_file = dir.join(format!("{session}{}", defaults::text("claim_ledger.last_ext")));
    let hash = sha1_hex(&reply);
    if std::fs::read_to_string(&last_file).is_ok_and(|t| js_trim(&t) == hash) {
        return Ok(Verdict::Allow);
    }
    let flags = extract_flags(&reply, &evidence, tools)?;
    let _ = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(&dir)?;
        std::fs::write(&last_file, &hash)?;
        if !flags.is_empty() {
            let line = record_line(&session, &hash, tools, utf16_len(&reply), utf16_len(&evidence), tail.truncated, &flags);
            let mut f =
                std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{session}{}", defaults::text("claim_ledger.ledger_ext"))))?;
            f.write_all(line.as_bytes())?;
        }
        Ok(())
    })();
    // The ledger is written first; the asks never wait. The turn pointer is left out when the reply came from the payload:
    // the transcript's last line may then belong to the previous message, and a wrong pointer is worse than none.
    let turn_ref = if from_payload { None } else { crate::jev::shared::turn_ref_from_transcript(transcript) };
    for f in &flags {
        ask_jev(Path::new(&home), env, &session_raw, turn_ref.as_deref(), f);
    }
    Ok(Verdict::Allow)
}

/// The registered `claim-ledger` check.
pub struct ClaimLedger;

impl Check for ClaimLedger {
    fn name(&self) -> &'static str {
        "claim-ledger"
    }

    fn summary(&self) -> &'static str {
        defaults::text("claim_ledger.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        // Needs the payload and the transcript; without them, let Node decide.
        (s.event == defaults::text("claim_ledger.event")).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if s.event != defaults::text("claim_ledger.event") {
            return None;
        }
        Some(decide(payload, env).unwrap_or(Verdict::Defer))
    }
}
