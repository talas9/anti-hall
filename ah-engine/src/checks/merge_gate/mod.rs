//! Built-in `check = "merge-gate"`: the part of the Node merge-gate (PreToolUse on Bash) that can be decided exactly
//! without the Jev shadow ask.
//!
//! The Node gate is opt-in (`guards.mergeGate`, default off). With it on, a Bash command that is an auto-merge intent
//! (`gh pr merge`, `gh pr review --approve`, a fast-forward or no-fast-forward `git merge` onto a protected branch,
//! `hivecontrol workspace merge-into-source|merge-from-source`) is blocked when the recent assistant transcript tail
//! still carries an unresolved self-hedge ("first-pass", "pending review", "do not merge", ...).
//!
//! What the engine answers, and why only that. The block needs the quote mask, the resolution scan over user records and
//! a fire-and-forget Jev shadow ask that the Node gate dispatches as soon as a hedge phrase is found (its log line is a
//! side effect of the hook). The engine therefore answers only the calls where Node exits 0 with no output and no side
//! effect: the gate is off or skipped, the command is not an auto-merge intent, the payload names no transcript, the
//! transcript cannot be read, or no hedge phrase occurs anywhere in the recent assistant text. The last test runs on the
//! raw text; Node runs it on the quote-masked text, which only blanks characters, so a phrase the engine cannot see is
//! one Node cannot see either. Everything else defers to the Node hook (never a silent allow, D11): a hedge phrase in the
//! assistant text, a transcript path that is not absolute (Node resolves it against its own working directory) and a
//! transcript line the engine cannot parse (Node's JSON parser accepts a few documents the engine's rejects).
//!
//! Mirrors `hooks/merge-gate.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::{Check, Verdict};
use crate::defaults;
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
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| Pats {
        split: jsre::compile(defaults::text("merge_gate.segment_split"), false),
        env_assign: jsre::compile(defaults::text("merge_gate.env_assign"), false),
        target: jsre::compile(defaults::text("merge_gate.protected_target"), true),
        hedges: defaults::list("merge_gate.hedge_patterns").into_iter().map(|s| jsre::compile(s, true)).collect(),
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

/// What the assistant records of the tail said, for the hedge test.
enum Scan {
    /// The joined text of every assistant text block.
    Text(String),
    /// A line the engine could not parse: Node may have.
    Unparsable,
}

/// The raw text of every assistant record of the tail, joined with a newline.
///
/// Mirrors `merge-gate.js` `readRecords` (assistant text only, before the quote mask).
fn assistant_text(tail: &str) -> Scan {
    let mut texts: Vec<String> = Vec::new();
    for line in tail.split('\n') {
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(t) else { return Scan::Unparsable };
        if entry.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let content = entry.get("message").and_then(|m| m.get("content"));
        let blocks: Vec<&str> = match content {
            Some(Value::Array(a)) => {
                a.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("text").and_then(Value::as_str)).collect()
            }
            Some(Value::String(s)) => vec![s.as_str()],
            _ => Vec::new(),
        };
        texts.push(blocks.join("\n"));
    }
    Scan::Text(texts.join("\n"))
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
    match assistant_text(&tail) {
        Scan::Unparsable => Verdict::Defer,
        // a hedge phrase is a possible block and starts the Jev shadow ask that goes with it: both are Node's
        Scan::Text(t) if has_hedge(&t) => Verdict::Defer,
        Scan::Text(_) => Verdict::Allow,
    }
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
