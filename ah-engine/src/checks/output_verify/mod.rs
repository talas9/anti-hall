//! Built-in `check = "output-verify-guard"`: a port of the Node output-verify-guard (PostToolUse on Bash; advisory only).
//!
//! After a Bash call that ran a test runner, the check scans the tool's own output for a passing signal AND a failing
//! signal (or a non-zero exit code) in the same run, and then adds a reminder to read the real counts before reporting
//! "tests pass". It never blocks, shown at most once per turn per distinct signal set.
//!
//! What is answered here and what is not:
//! - Answered here: the switch, the skip file, the test-runner test, the signal scan, the exit code, the once-per-turn
//!   gate and its state file.
//! - Answered here too: the Jev shadow question. For every test-runner output it is asked on the shared Jev lane without
//!   waiting (Node: `askDetached`) with Node's id, question, text window, trust and baseline; the answer only reaches the
//!   Jev decision log (a `mode: "off"` row when the integration is off, as Node writes) and never changes the advisory.
//! - Deferred to Node: a payload whose output carries an object whose key order would change the
//!   answer (the engine's parsed payload does not keep key order; the check proves the answer cannot depend on it or
//!   defers), and anything the JavaScript text semantics cannot be reproduced for.
//!
//! Mirrors `hooks/output-verify-guard.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::replykit::Defer;
use crate::checks::replykit::io::{home_of, prefix_utf16, suffix_utf16, utf16_len};
use crate::checks::replykit::json::{js_number, quote, stringify_value};
use crate::checks::replykit::turn_gate::{GateInput, first_this_turn};
use crate::checks::{Check, Exact, Verdict};
use crate::defaults::{self, V};
use crate::jev::{AskRequest, Env as JevEnv, Question, Trust};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::path::Path;
use std::sync::OnceLock;

#[cfg(test)]
mod tests;

/// One signal pattern: a JavaScript regex source with its flags.
struct Signal {
    re: Regex,
    /// The pattern holds a captured count, so a zero count is not a hit (and every occurrence is scanned).
    count: bool,
    /// The `m` flag with a leading `^`: the pattern only matches at the start of a line.
    line_start: bool,
}

struct Pats {
    fail: Vec<Signal>,
    pass: Vec<Signal>,
    exit_code: Regex,
    seg_split: Regex,
    ws: Regex,
    env_assign: Regex,
    path_sep: Regex,
}

fn signals(key: &str) -> Vec<Signal> {
    defaults::raw(key)
        .as_array()
        .unwrap_or_default()
        .iter()
        .map(|e| {
            let src = e.str_field("src");
            let ci = e.get("ci").and_then(V::as_bool).unwrap_or(false);
            let line_start = e.get("multiline").and_then(V::as_bool).unwrap_or(false);
            let body = if line_start { src.strip_prefix('^').unwrap_or(src) } else { src };
            Signal { re: jsre::compile(body, ci), count: src.contains(defaults::text("output_verify.count_marker")), line_start }
        })
        .collect()
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| Pats {
        fail: signals("output_verify.fail_patterns"),
        pass: signals("output_verify.pass_patterns"),
        exit_code: jsre::compile(defaults::text("output_verify.exit_code_re"), true),
        seg_split: jsre::compile(defaults::text("output_verify.segment_split_re"), false),
        ws: jsre::compile(defaults::text("output_verify.ws_split_re"), false),
        env_assign: jsre::compile(defaults::text("output_verify.env_assign_re"), false),
        path_sep: jsre::compile(defaults::text("output_verify.path_sep_re"), false),
    })
}

/// `isTestRunnerCommand(cmd)`: some segment of the command starts (after environment assignments) with a test runner.
pub fn is_test_runner_command(cmd: &str) -> bool {
    let p = pats();
    if js_trim(cmd).is_empty() {
        return false;
    }
    let verbs = defaults::list("output_verify.runner_verbs");
    let subs = defaults::raw("output_verify.runner_subcommands").as_table().unwrap_or_default();
    for seg in p.seg_split.split(cmd) {
        let words: Vec<&str> = p.ws.split(js_trim(seg)).filter(|w| !w.is_empty()).collect();
        let Some(i) = words.iter().position(|w| !p.env_assign.is_match(w)) else { continue };
        let verb = p.path_sep.split(words[i]).last().unwrap_or("");
        let rest = &words[i + 1..];
        if verbs.contains(&verb) {
            return true;
        }
        if let Some((_, want)) = subs.iter().find(|(k, _)| *k == verb) {
            let want = want.as_str().unwrap_or("");
            let run = defaults::text("output_verify.run_word");
            if rest.first() == Some(&want) || (rest.first() == Some(&run) && rest.get(1) == Some(&want)) {
                return true;
            }
        }
    }
    false
}

fn line_start_at(text: &str, at: usize, leaf: bool) -> bool {
    match text[..at].chars().next_back() {
        None => !leaf,
        Some(c) => defaults::text("output_verify.line_terminators").contains(c),
    }
}

fn char_len_at(text: &str, at: usize) -> usize {
    text[at..].chars().next().map_or(1, char::len_utf8)
}

/// `firstMatch(patterns, text)`: the text of the first pattern (in list order) with a genuine hit. `leaf` marks a text
/// that sits inside a longer one, so its start is not the start of a line.
fn first_match(list: &[Signal], text: &str, leaf: bool) -> Option<String> {
    for s in list {
        let mut pos = 0usize;
        while pos <= text.len() {
            let Some(c) = s.re.captures_at(text, pos) else { break };
            let m = c.get(0).map_or(0..0, |m| m.range());
            if s.line_start && !line_start_at(text, m.start, leaf) {
                pos = m.start + char_len_at(text, m.start);
                continue;
            }
            if !s.count || c.get(1).is_some_and(|d| d.as_str().bytes().any(|b| b != b'0')) {
                return Some(text[m].to_string());
            }
            pos = if m.end == m.start { m.end + char_len_at(text, m.end) } else { m.end };
        }
    }
    None
}

/// The code `extractExitCode` reads out of one capture of the exit-code text scan (`parseInt`, finite or nothing).
fn exit_of(c: &regex::Captures<'_>) -> Option<f64> {
    c.get(1).and_then(|d| d.as_str().parse::<f64>().ok()).filter(|n| n.is_finite())
}

/// The first exit-code text in `text`, as Node's `blob.match(...)` finds it.
fn exit_first(text: &str) -> Option<f64> {
    pats().exit_code.captures(text).and_then(|c| exit_of(&c))
}

/// Every exit-code text in `text`.
fn exit_all(text: &str) -> Vec<Option<f64>> {
    pats().exit_code.captures_iter(text).map(|c| exit_of(&c)).collect()
}

/// What the scan of one payload found.
struct Found {
    pass: Option<String>,
    fail: Option<String>,
    exit: Option<f64>,
}

/// The pieces of the scan blob: the stringified `tool_response` and `tool_output` values, in that order.
struct Blob {
    blob: String,
    /// Objects with two or more keys, whose key order Node would keep and the parsed payload does not.
    ordered_parts: Vec<(String, Value)>,
}

fn build_blob(payload: &Value) -> Result<Blob, Defer> {
    let mut parts: Vec<String> = Vec::new();
    let mut ordered_parts = Vec::new();
    for key in defaults::list("output_verify.blob_fields") {
        let Some(v) = payload.get(key).filter(|v| !v.is_null()) else { continue };
        let text = match v {
            Value::String(s) => s.clone(),
            other => stringify_value(other),
        };
        if has_ordered_object(v) {
            ordered_parts.push((text.clone(), v.clone()));
        }
        parts.push(text);
    }
    let mut blob = parts.join("\n");
    let cap = defaults::num("output_verify.scan_cap") as usize;
    if utf16_len(&blob) > cap {
        if !ordered_parts.is_empty() {
            return Err(Defer);
        }
        let half = cap / 2;
        let head = prefix_utf16(&blob, half).ok_or(Defer)?;
        let tail = suffix_utf16(&blob, half).ok_or(Defer)?;
        blob = format!("{head}{}{tail}", defaults::text("output_verify.truncation_marker"));
    }
    Ok(Blob { blob, ordered_parts })
}

fn has_ordered_object(v: &Value) -> bool {
    match v {
        Value::Object(m) => m.len() >= 2 || m.values().any(has_ordered_object),
        Value::Array(a) => a.iter().any(has_ordered_object),
        _ => false,
    }
}

/// The escaped text of every key and string value in `v` (what each one contributes to `JSON.stringify(v)`).
fn leaves(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => out.push(quote(s)),
        Value::Array(a) => a.iter().for_each(|x| leaves(x, out)),
        Value::Object(m) => {
            for (k, x) in m {
                out.push(quote(k));
                leaves(x, out);
            }
        }
        _ => {}
    }
}

/// True when the order of the keys inside `v` could change what the scan finds: some pattern has genuine hits with
/// different text in different leaves (the first one in the real key order would win), or the exit-code text scan sees
/// two different codes.
fn order_matters(v: &Value, structured_exit: bool) -> bool {
    let p = pats();
    let mut ls = Vec::new();
    leaves(v, &mut ls);
    for list in [&p.fail, &p.pass] {
        for s in list {
            let one = std::slice::from_ref(s);
            let mut seen: Vec<String> = Vec::new();
            for l in &ls {
                if let Some(t) = first_match(one, l, true)
                    && !seen.contains(&t)
                {
                    seen.push(t);
                }
            }
            if seen.len() > 1 {
                return true;
            }
        }
    }
    if !structured_exit {
        let mut codes: Vec<Option<f64>> = Vec::new();
        for c in exit_all(&stringify_value(v)) {
            if !codes.contains(&c) {
                codes.push(c);
            }
        }
        if codes.len() > 1 {
            return true;
        }
    }
    false
}

/// `extractExitCode`: a numeric field of an object `tool_response`, else the text scan of the blob.
fn structured_exit(payload: &Value) -> Option<f64> {
    let tr = payload.get("tool_response").filter(|t| t.is_object())?;
    defaults::list("output_verify.exit_fields").iter().find_map(|f| tr.get(*f).and_then(Value::as_f64).filter(|n| n.is_finite()))
}

fn scan(payload: &Value, blob: &Blob) -> Result<Found, Defer> {
    let p = pats();
    let structured = structured_exit(payload);
    for (_, v) in &blob.ordered_parts {
        if order_matters(v, structured.is_some()) {
            return Err(Defer);
        }
    }
    let exit = structured.or_else(|| exit_first(&blob.blob));
    Ok(Found { pass: first_match(&p.pass, &blob.blob, false), fail: first_match(&p.fail, &blob.blob, false), exit })
}

/// The Jev shadow question for one test-runner output (Node: the `askDetached` call before the advisory).
fn ask_jev(home: &str, env: &RequestEnv, session: Option<String>, text: &str, mismatch: bool) {
    let mut req = AskRequest::new(
        defaults::text("output_verify.jev_id"),
        Question::noul(defaults::text("output_verify.jev_instructions"), defaults::text("output_verify.jev_true"), defaults::text("output_verify.jev_false")),
        text,
        Trust::Advisory,
        Value::Bool(mismatch),
    );
    req.session_id = session;
    crate::jev::shared::ask_detached(Path::new(home), &JevEnv::from_pairs(env.to_map()), req);
}

fn decide(payload: &Value, env: &RequestEnv) -> Result<Verdict, Defer> {
    let Some(home) = home_of(env) else { return Err(Defer) };
    let st = Settings { home: home.clone(), env: env.to_map() };
    if !get_bool(&st, defaults::raw("output_verify.setting")) || is_skipped(&st, defaults::text("output_verify.guard_name")) {
        return Ok(Verdict::Allow);
    }
    if payload.get("tool_name").and_then(Value::as_str) != Some(defaults::text("output_verify.tool")) {
        return Ok(Verdict::Allow);
    }
    let cmd = payload.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str).unwrap_or("");
    if !is_test_runner_command(cmd) {
        return Ok(Verdict::Allow);
    }
    let blob = build_blob(payload)?;
    if blob.blob.is_empty() {
        return Ok(Verdict::Allow);
    }
    let found = scan(payload, &blob)?;
    let non_zero = found.exit.is_some_and(|n| n != 0.0);
    // The shadow ask comes before the advisory and never waits; a window that would cut a surrogate pair is Node's lone
    // surrogate, which this port does not reproduce, so that call stays on Node.
    let window = prefix_utf16(&blob.blob, defaults::num("output_verify.jev_state_chars") as usize).ok_or(Defer)?;
    let session = match payload.get("session_id").filter(|s| crate::checks::replykit::io::truthy(s)) {
        Some(s) => Some(crate::checks::replykit::io::js_id_string(s).ok_or(Defer)?),
        None => None,
    };
    ask_jev(&home, env, session, &window, found.pass.is_some() && (found.fail.is_some() || non_zero));
    let (Some(pass), true) = (found.pass.as_ref(), found.fail.is_some() || non_zero) else { return Ok(Verdict::Allow) };
    let mut bits: Vec<String> = vec![msg::render("output_verify.bit_pass", &[("hit", &quote(pass))])];
    if let Some(f) = &found.fail {
        bits.push(msg::render("output_verify.bit_fail", &[("hit", &quote(f))]));
    }
    if non_zero && let Some(code) = found.exit {
        bits.push(msg::render("output_verify.bit_exit", &[("code", &js_number(code))]));
    }
    let sep = defaults::text("output_verify.bits_sep");
    if get_bool(&st, defaults::raw("output_verify.once_setting")) {
        let agent = payload.get("agent_id").and_then(Value::as_str).unwrap_or("");
        let gate = GateInput {
            home: &home,
            session: payload.get("session_id"),
            agent,
            transcript: payload.get("transcript_path"),
            key: defaults::text("output_verify.guard_name"),
            sig: &bits.join(defaults::text("output_verify.sig_sep")),
        };
        if !first_this_turn(&gate)? {
            return Ok(Verdict::Allow);
        }
    }
    let what = msg::render("output_verify.msg_what", &[("bits", &bits.join(sep))]);
    let text = msg::message(
        Kind::Warn,
        defaults::text("output_verify.guard_name"),
        &Parts { what: &what, why: defaults::text("output_verify.msg_why"), instead: defaults::text("output_verify.msg_instead"), ..Parts::default() },
    );
    Ok(Verdict::Exact(Exact { code: 0, out: format!("{}\n", msg::advisory_json(defaults::text("output_verify.event"), &text)), err: String::new() }))
}

/// The registered `output-verify-guard` check.
pub struct OutputVerifyGuard;

impl Check for OutputVerifyGuard {
    fn name(&self) -> &'static str {
        "output-verify-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("output_verify.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        // Needs the payload's tool output; without the payload, let Node decide.
        (s.event == defaults::text("output_verify.event")).then_some(Verdict::Defer)
    }

    fn run_env(&self, s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        if s.event != defaults::text("output_verify.event") {
            return None;
        }
        Some(decide(payload, env).unwrap_or(Verdict::Defer))
    }
}
