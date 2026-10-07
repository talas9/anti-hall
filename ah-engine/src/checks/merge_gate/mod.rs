//! Built-in `check = "merge-gate"`: the part of the Node merge-gate (PreToolUse on Bash) that can be decided exactly
//! without the Jev shadow ask.
//!
//! The Node gate is opt-in (`guards.mergeGate`, default off). With it on, a Bash command that is an auto-merge intent
//! (`gh pr merge`, `gh pr review --approve`, a fast-forward or no-fast-forward `git merge` onto a protected branch,
//! `hivecontrol workspace merge-into-source|merge-from-source`) is blocked when the recent assistant transcript tail
//! still carries an unresolved self-hedge ("first-pass", "pending review", "do not merge", ...).
//!
//! Everything is answered here: the records of the transcript tail (assistant text and real typed user prompts, both
//! quote-masked), the hedge and its resolution, the block, and the Jev shadow ask the Node gate dispatches as soon as a
//! hedge phrase is found (`mergeGateHedge`, relax-block trust, baseline = "the hedge is unresolved"; asked on the shared
//! Jev lane without waiting, so the gate's answer never depends on Jev, as in Node). Only three things defer to the Node
//! hook (never a silent allow, D11): a transcript path that is not absolute (Node resolves it against its own working
//! directory), a transcript line the engine cannot parse (Node's JSON parser accepts a few documents the engine's
//! rejects) and a text window for the ask that would cut a surrogate pair.
//!
//! Mirrors `hooks/merge-gate.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::speculation_guard::mask::mask_quoted_text;
use crate::checks::{Check, Exact, Verdict};
use crate::defaults;
use crate::jev::{AskRequest, Question, Trust};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::sync::OnceLock;

#[cfg(test)]
mod tests;

/// The compiled patterns, built once from the defaults.
struct Pats {
    split: regex::Regex,
    env_assign: regex::Regex,
    target: regex::Regex,
    hedges: Vec<regex::Regex>,
    injected: regex::Regex,
    reminder: regex::Regex,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| Pats {
        split: jsre::compile(defaults::text("merge_gate.segment_split"), false),
        env_assign: jsre::compile(defaults::text("merge_gate.env_assign"), false),
        target: jsre::compile(defaults::text("merge_gate.protected_target"), true),
        hedges: defaults::list("merge_gate.hedge_patterns").into_iter().map(|s| jsre::compile(s, true)).collect(),
        injected: jsre::compile(defaults::text("merge_gate.injected_user"), true),
        reminder: jsre::compile(defaults::text("merge_gate.system_reminder"), true),
    })
}

/// True when one rule of `merge_gate.merge_rules` matches the words after the verb.
fn rule_matches(rule: &defaults::V, rest: &[&str]) -> bool {
    let prefix = rule.get("prefix").map(defaults::V::strings).unwrap_or_default();
    if rest.len() < prefix.len() || rest.iter().zip(&prefix).any(|(w, p)| w != p) {
        return false;
    }
    let tail = &rest[prefix.len()..];
    if let Some(any) = rule.get("includes_any").map(defaults::V::strings)
        && !tail.iter().any(|w| any.contains(w))
    {
        return false;
    }
    if rule.get("needs_target").and_then(defaults::V::as_bool).unwrap_or(false) && !tail.iter().any(|w| pats().target.is_match(w)) {
        return false;
    }
    true
}

/// True when any segment of `cmd` is an auto-merge intent.
///
/// Mirrors `merge-gate.js` `splitSegments` and `isAutoMerge`.
pub fn is_auto_merge(cmd: &str) -> bool {
    let p = pats();
    let rules = defaults::raw("merge_gate.merge_rules").as_array().unwrap_or_default();
    for seg in p.split.split(cmd) {
        let words: Vec<&str> = js_trim(seg).split(is_js_space).filter(|w| !w.is_empty()).collect();
        if words.len() < 2 {
            continue;
        }
        let mut i = 0usize;
        while i < words.len() && p.env_assign.is_match(words[i]) {
            i += 1;
        }
        let Some(verb) = words.get(i) else { continue };
        let rest = &words[i + 1..];
        if rules.iter().any(|r| r.str_field("verb") == *verb && rule_matches(r, rest)) {
            return true;
        }
    }
    false
}

/// True when `text` carries a self-hedge phrase.
///
/// Mirrors `merge-gate.js` `firstHedge` (the phrase itself is not needed here).
fn has_hedge(text: &str) -> bool {
    let lower = text.to_lowercase();
    defaults::list("merge_gate.hedge_phrases").iter().any(|h| lower.contains(h)) || pats().hedges.iter().any(|re| re.is_match(text))
}

/// What reading the transcript tail gave.
enum Tail {
    /// The text of the tail (with the partial first line already dropped when the file was cut).
    Data(String),
    /// Node's `readTail` returns null on any error: no records, so the gate allows.
    Unreadable,
}

/// The last `window` bytes of the file (or all of it), the way `merge-gate.js` `readTail` reads them.
fn read_tail(path: &str, window: u64) -> Tail {
    let read = || -> std::io::Result<(Vec<u8>, bool)> {
        let mut f = std::fs::File::open(path)?;
        let size = f.metadata()?.len();
        let mut buf = Vec::new();
        if size <= window {
            f.read_to_end(&mut buf)?;
            Ok((buf, false))
        } else {
            f.seek(SeekFrom::Start(size - window))?;
            f.take(window).read_to_end(&mut buf)?;
            Ok((buf, true))
        }
    };
    match read() {
        Ok((bytes, truncated)) => {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if truncated {
                // the first line of a cut window is likely partial: drop it, as Node does
                Tail::Data(text.split_once('\n').map_or(String::new(), |(_, rest)| rest.to_string()))
            } else {
                Tail::Data(text)
            }
        }
        Err(_) => Tail::Unreadable,
    }
}

/// What one record of the transcript tail is (Node: `readRecords`' `kind`).
#[derive(Debug, Clone, PartialEq)]
enum Rec {
    /// An assistant message: its own text blocks, quote-masked.
    Assistant(String),
    /// A real typed user prompt, quote-masked.
    User(String),
    /// A user-role record that is not a typed prompt.
    Other,
}

/// What reading the records gave.
enum Scan {
    /// The records, oldest first.
    Records(Vec<Rec>),
    /// A line the engine could not parse: Node may have.
    Unparsable,
}

fn truthy_field(entry: &Value, key: &str) -> bool {
    entry.get(key).is_some_and(crate::checks::replykit::io::truthy)
}

/// The text blocks of a record's content, joined with a newline (Node: `textOf`), and whether a `tool_result` block is
/// among them.
fn text_of(entry: &Value) -> (String, bool) {
    let content = entry.get("message").and_then(|m| m.get("content"));
    match content {
        Some(Value::Array(a)) => {
            let text: Vec<&str> =
                a.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("text").and_then(Value::as_str)).collect();
            (text.join("\n"), a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")))
        }
        Some(Value::String(s)) => (s.clone(), false),
        _ => (String::new(), false),
    }
}

/// The quote-masked text, or the raw text when masking blanked every visible character (Node: `maskedMaybe`).
fn masked_maybe(text: &str) -> String {
    let m = mask_quoted_text(text);
    if js_trim(&m).is_empty() && !js_trim(text).is_empty() { text.to_string() } else { m }
}

/// True when the record's `origin` says a peer or the system wrote it, not a human.
fn non_human(entry: &Value) -> bool {
    let Some(origin) = entry.get("origin").filter(|o| crate::checks::replykit::io::truthy(o)) else { return false };
    let kind = origin.get("kind").and_then(Value::as_str);
    !kind.is_some_and(|k| defaults::list("merge_gate.non_human_origins").contains(&k))
}

/// The records of the tail, as Node's `readRecords` builds them.
fn read_records(tail: &str) -> Scan {
    let mut out = Vec::new();
    for line in tail.split('\n') {
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(t) else { return Scan::Unparsable };
        match entry.get("type").and_then(Value::as_str) {
            Some("assistant") => out.push(Rec::Assistant(masked_maybe(&text_of(&entry).0))),
            Some("user") => {
                if truthy_field(&entry, "isMeta") || truthy_field(&entry, "isSidechain") || truthy_field(&entry, "isCompactSummary") || non_human(&entry) {
                    out.push(Rec::Other);
                    continue;
                }
                let (text, has_result) = text_of(&entry);
                if entry.get("toolUseResult").is_some() || has_result {
                    out.push(Rec::Other);
                    continue;
                }
                let raw = pats().reminder.replace_all(&text, "").into_owned();
                if js_trim(&raw).is_empty() || pats().injected.is_match(&raw) {
                    out.push(Rec::Other);
                    continue;
                }
                out.push(Rec::User(masked_maybe(&raw)));
            }
            _ => {}
        }
    }
    Scan::Records(out)
}

/// UTF-16 units before byte offset `at` of `s` (a JavaScript string index).
fn utf16_at(s: &str, at: usize) -> usize {
    s[..at].encode_utf16().count()
}

/// The last (rightmost) hedge phrase of `text`, as Node's `lastHedgePhrase` finds it: plain phrases by their last
/// occurrence in the lower-cased text, patterns by their last match in the text itself; the later start wins, and the
/// earlier hedge on a tie.
fn last_hedge_phrase(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let mut best: Option<(usize, String)> = None;
    let mut consider = |idx: usize, phrase: String| {
        if best.as_ref().is_none_or(|(b, _)| idx > *b) {
            best = Some((idx, phrase));
        }
    };
    for h in defaults::list("merge_gate.hedge_phrases") {
        if let Some(at) = lower.rfind(h) {
            consider(utf16_at(&lower, at), h.to_string());
        }
    }
    for re in &pats().hedges {
        if let Some(m) = re.find_iter(text).last() {
            consider(utf16_at(text, m.start()), m.as_str().to_string());
        }
    }
    best.map(|(_, p)| p)
}

/// True when the lower-cased text holds any resolution phrase.
fn has_resolution(text: &str) -> bool {
    let lower = text.to_lowercase();
    defaults::list("merge_gate.resolutions").iter().any(|p| lower.contains(p))
}

/// True when the last hedged assistant record has no later real user prompt that resolves it (Node: `isHedgeUnresolved`).
fn hedge_unresolved(records: &[Rec]) -> bool {
    let Some(at) = records.iter().rposition(|r| matches!(r, Rec::Assistant(t) if has_hedge(t))) else { return false };
    !records[at + 1..].iter().any(|r| matches!(r, Rec::User(t) if has_resolution(t)))
}

/// The `mergeGateHedge` shadow ask (Node: the `askDetached` call before the block).
fn ask_jev(st: &Settings, p: &Value, tp: &str, window: &str, unresolved: bool) {
    let mut req = AskRequest::new(
        defaults::text("merge_gate.jev_id"),
        Question::noul(defaults::text("merge_gate.jev_instructions"), defaults::text("merge_gate.jev_true"), defaults::text("merge_gate.jev_false")),
        window,
        Trust::RelaxBlock,
        Value::Bool(unresolved),
    );
    req.session_id = p.get("session_id").filter(|s| crate::checks::replykit::io::truthy(s)).and_then(crate::checks::replykit::io::js_id_string);
    req.turn_ref = crate::jev::shared::turn_ref_from_transcript(tp);
    req.project = crate::jev::shared::project_for(p.get("cwd").and_then(Value::as_str));
    crate::jev::shared::ask_detached(std::path::Path::new(&st.home), &crate::jev::Env::from_pairs(st.env.clone()), req);
}

/// The check's decision on one payload.
///
/// Mirrors `hooks/merge-gate.js` `decide`.
pub fn decide(p: &Value, st: &Settings) -> Verdict {
    if is_skipped(st, defaults::text("merge_gate.guard_name")) || !get_bool(st, defaults::raw("merge_gate.setting")) {
        return Verdict::Allow;
    }
    let cmd = p.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str).unwrap_or("");
    if cmd.is_empty() || !is_auto_merge(cmd) {
        return Verdict::Allow;
    }
    let tp = match p.get("transcript_path") {
        Some(Value::String(s)) if !s.is_empty() => s.as_str(),
        _ => return Verdict::Allow,
    };
    if !paths::is_absolute(tp) {
        return Verdict::Defer;
    }
    let tail = match read_tail(tp, defaults::num("merge_gate.window_bytes")) {
        Tail::Data(d) => d,
        Tail::Unreadable => return Verdict::Allow,
    };
    let records = match read_records(&tail) {
        Scan::Unparsable => return Verdict::Defer,
        Scan::Records(r) => r,
    };
    let text = records.iter().filter_map(|r| if let Rec::Assistant(t) = r { Some(t.as_str()) } else { None }).collect::<Vec<_>>().join("\n");
    if text.is_empty() || !has_hedge(&text) {
        return Verdict::Allow;
    }
    let unresolved = hedge_unresolved(&records);
    let Some(window) = crate::checks::replykit::io::suffix_utf16(&text, defaults::num("merge_gate.jev_state_chars") as usize) else { return Verdict::Defer };
    if p.get("session_id").is_some_and(|s| crate::checks::replykit::io::truthy(s) && crate::checks::replykit::io::js_id_string(s).is_none()) {
        return Verdict::Defer; // String(session_id) of an object is Node's to write
    }
    ask_jev(st, p, tp, &window, unresolved);
    if !unresolved {
        return Verdict::Allow;
    }
    let hedge = last_hedge_phrase(&text).unwrap_or_default();
    let what = msg::render("merge_gate.msg_what", &[("hedge", &hedge)]);
    let reason = msg::message(
        Kind::Block,
        defaults::text("merge_gate.guard_name"),
        &Parts {
            what: &what,
            why: defaults::text("merge_gate.msg_why"),
            instead: defaults::text("merge_gate.msg_instead"),
            override_: defaults::text("merge_gate.msg_override"),
            ..Parts::default()
        },
    );
    Verdict::Exact(Exact { code: 2, out: String::new(), err: format!("{reason}\n") })
}

/// The registered `merge-gate` check.
pub struct MergeGate;

impl Check for MergeGate {
    fn name(&self) -> &'static str {
        "merge-gate"
    }

    fn summary(&self) -> &'static str {
        defaults::text("merge_gate.summary")
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
