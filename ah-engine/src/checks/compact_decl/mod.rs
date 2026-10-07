//! Built-in `check = "compact-declaration-guard"`: a port of the Node compact-declaration-guard (PreToolUse).
//!
//! The Node guard blocks new work (an agent spawn, a file edit, a state-changing shell command) in a turn whose
//! assistant text holds an active "SAFE TO COMPACT" declaration. Almost no turn does, so the engine answers the common
//! case itself: it finds out whether the call is new work, reads the tail of the transcript the same way Node does
//! (the last 1.5 MB, first partial line dropped), rebuilds the current turn's assistant text with Node's turn rules,
//! and allows when that text cannot hold a declaration (it has no "safe" in it, which both declaration phrasings need).
//! When it might, the verdict is deferred to the Node guard, which owns the phrase analysis (negation, quotes, retraction)
//! and the block, whose shape (a JSON decision on stdout and the reason on stderr) the engine's reply cannot carry yet.
//!
//! Differences from the Node guard (deliberate): a transcript line the engine's JSON parser rejects and Node's might
//! accept (a lone surrogate escape, nesting beyond the configured depth, an exponent beyond the number range) defers; a
//! relative `transcript_path` or a relative file path without a working directory defers (Node would use its own process
//! directory). The shared transcript index is a separate lane, so this check reads the tail itself.
//!
//! Mirrors `hooks/compact-declaration-guard.js`, `hooks/lib/transcript-tail.js` and `hooks/lib/compact-advice.js`
//! (`classify`, `readTurn`), and `hooks/lib/work-detect.js` (`BASH_WORK_RE`, `neutralizeQuotedContents`).
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::paths;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::io::{Read, Seek, SeekFrom};
use std::sync::OnceLock;

#[cfg(test)]
mod tests;

/// The compiled patterns, built once from the defaults.
struct Pats {
    handover: Regex,
    work_always: Vec<Regex>,
    work_cmd_pos: Regex,
    work_extra: Regex,
    not_typed: Regex,
    notify: Regex,
    compact_cmd: Regex,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| Pats {
        handover: crate::checks::lit_re(defaults::text("compact_decl.handover_file")),
        work_always: defaults::list("compact_decl.bash_work_always").into_iter().map(|s| jsre::compile(s, true)).collect(),
        work_cmd_pos: jsre::compile(defaults::text("compact_decl.bash_work_command_position"), true),
        work_extra: jsre::compile(defaults::text("compact_decl.bash_work_extra"), true),
        not_typed: jsre::compile(defaults::text("compact_decl.not_typed"), false),
        notify: jsre::compile(defaults::text("compact_decl.notify"), false),
        compact_cmd: jsre::compile(defaults::text("compact_decl.compact_command"), false),
    })
}

/// Blank the contents of single- and double-quoted spans (delimiters included) so text that is only quoted data cannot
/// match a work pattern.
///
/// Mirrors `lib/work-detect.js` `neutralizeQuotedContents`.
fn neutralize_quoted(cmd: &str) -> String {
    let cs: Vec<char> = cmd.chars().collect();
    let mut out = String::with_capacity(cmd.len());
    let (mut in_single, mut in_double) = (false, false);
    let mut i = 0usize;
    while i < cs.len() {
        let c = cs[i];
        let c2 = cs.get(i + 1);
        if in_single {
            out.push(' ');
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == '\\' && c2.is_some() {
                out.push_str("  ");
                i += 2;
                continue;
            }
            out.push(' ');
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if c == '\'' {
            in_single = true;
            out.push(' ');
        } else if c == '"' {
            in_double = true;
            out.push(' ');
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// A `>` or `>>` file redirect that is not a descriptor duplicate: `(?<![0-9&])>{1,2}(?!&)`, which the regex crate cannot
/// express (it has no lookaround). A match exists at any `>` not preceded by a digit or `&` and not followed by `&`.
fn has_file_redirect(s: &str) -> bool {
    let cs: Vec<char> = s.chars().collect();
    cs.iter().enumerate().any(|(i, &c)| c == '>' && !(i > 0 && (cs[i - 1].is_ascii_digit() || cs[i - 1] == '&')) && cs.get(i + 1) != Some(&'&'))
}

/// Whether a shell command changes state: the shared work list, or this guard's pushes and tags.
///
/// Mirrors `compact-declaration-guard.js` `isNewWork` (the Bash branch) with `work-detect.js` `BASH_WORK_RE`.
fn bash_is_work(cmd: &str) -> bool {
    let n = neutralize_quoted(cmd);
    let p = pats();
    p.work_always.iter().any(|re| re.is_match(&n)) || p.work_cmd_pos.is_match(&n) || has_file_redirect(&n) || p.work_extra.is_match(&n)
}

/// What deciding whether a call is new work came to.
enum Work {
    Yes,
    No,
    /// Node would use its own process directory; the engine cannot know it.
    Defer,
}

/// A file inside the handovers directory, resolved against the working directory. `None` when that needs a directory the
/// payload does not give.
///
/// Mirrors `compact-declaration-guard.js` `isHandoverEdit`.
fn is_handover_edit(p: &Value) -> Option<bool> {
    let ti = p.get("tool_input").filter(|t| !t.is_null());
    let field = |k: &str| ti.and_then(|t| t.get(k)).and_then(Value::as_str);
    let Some(fp) = field("file_path").or_else(|| field("notebook_path")).filter(|f| !f.is_empty()) else { return Some(false) };
    let abs = if paths::is_absolute(fp) {
        paths::resolve_abs(fp)
    } else {
        let cwd = p.get("cwd").and_then(Value::as_str).filter(|c| paths::is_absolute(c))?;
        paths::resolve_abs(&format!("{cwd}/{fp}"))
    };
    Some(pats().handover.is_match(&abs))
}

/// Mirrors `compact-declaration-guard.js` `isNewWork`.
fn is_new_work(p: &Value) -> Work {
    let name = p.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if defaults::list("compact_decl.work_tools").contains(&name) {
        return match is_handover_edit(p) {
            Some(true) => Work::No,
            Some(false) => Work::Yes,
            None => Work::Defer,
        };
    }
    match p.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str) {
        Some(cmd) if bash_is_work(cmd) => Work::Yes,
        _ => Work::No,
    }
}

/// The last `max` bytes of the file as lines, the possibly partial first line dropped when the file is larger. `None`
/// when the file is missing, empty or unreadable.
///
/// Mirrors `lib/transcript-tail.js` `readTail`.
pub(crate) fn read_tail(path: &str, max: u64) -> Option<Vec<String>> {
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(max);
    f.seek(SeekFrom::Start(size - n)).ok()?;
    let mut buf = vec![0u8; n as usize];
    let mut got = 0usize;
    while got < buf.len() {
        match f.read(&mut buf[got..]) {
            Ok(0) => break,
            Ok(k) => got += k,
            Err(_) => return None,
        }
    }
    let text = String::from_utf8_lossy(&buf[..got]);
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if size > n {
        lines.remove(0);
    }
    Some(lines)
}

/// ASCII-case-insensitive substring test on bytes.
pub(crate) fn contains_ci(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w.eq_ignore_ascii_case(needle))
}

/// What one transcript line does to the current turn.
enum Step {
    /// A real user message: starts a new turn.
    NewTurn,
    /// Assistant text, in order.
    Text(Vec<String>),
    /// Anything else (tool calls and results, notifications, compact boundaries, entries that are not messages).
    Other,
}

/// `textOfBlocks(content, types)`: a string content as is; an array's text blocks of the given types, joined with a newline.
fn text_of_blocks(content: Option<&Value>, types: &[&str]) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str).is_some_and(|t| types.contains(&t)) && b.get("text").is_some_and(Value::is_string))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Mirrors the `isMeta`/`isCompactSummary` truthiness tests (a JSON value that is not false, 0, null or "").
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// The text left after the leading system-reminder blocks a hook may have injected before the real prompt.
///
/// Mirrors the `LEADING_REMINDERS_RE` replace in `compact-advice.js` `classify`.
fn strip_leading_reminders(txt: &str) -> &str {
    let tags = defaults::raw("compact_decl.reminder_tags");
    let (open, close) = (tags.str_field("open"), tags.str_field("close"));
    let mut rest = txt;
    loop {
        let after_ws = rest.trim_start_matches(is_js_space);
        let Some(inner) = after_ws.strip_prefix(open) else { break };
        let Some(end) = inner.find(close) else { break };
        rest = &inner[end + close.len()..];
    }
    rest
}

/// Classify one transcript entry.
///
/// Mirrors `compact-advice.js` `classify` (only what decides turn text).
fn classify(e: &Value) -> Step {
    let p = pats();
    let ty = e.get("type").and_then(Value::as_str);
    if ty == Some("system") && e.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
        return Step::Other;
    }
    if e.get("isSidechain") == Some(&Value::Bool(true)) {
        return Step::Other;
    }
    let message = e.get("message").filter(|m| truthy(Some(m)));
    if let (Some("user"), Some(m)) = (ty, message) {
        if truthy(e.get("isMeta")) || truthy(e.get("isCompactSummary")) {
            return Step::Other;
        }
        let content = m.get("content");
        if content.and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))) {
            return Step::Other;
        }
        let txt = text_of_blocks(content, &["text"]);
        if p.notify.is_match(&txt) {
            return Step::Other;
        }
        let typed = strip_leading_reminders(&txt);
        if js_trim(typed).is_empty() || p.not_typed.is_match(typed) || p.compact_cmd.is_match(typed) {
            return Step::Other;
        }
        return Step::NewTurn;
    }
    if let (Some("assistant"), Some(m)) = (ty, message) {
        let texts: Vec<String> = match m.get("content") {
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .filter(|t| !js_trim(t).is_empty())
                .map(str::to_string)
                .collect(),
            Some(Value::String(s)) if !js_trim(s).is_empty() => vec![s.clone()],
            _ => Vec::new(),
        };
        return if texts.is_empty() { Step::Other } else { Step::Text(texts) };
    }
    // Codex rollout entries
    let Some(pl) = e.get("payload").filter(|v| v.is_object()) else { return Step::Other };
    match ty {
        Some("event_msg") => {
            let msg = pl.get("message").and_then(Value::as_str);
            if pl.get("type").and_then(Value::as_str) == Some("user_message") && msg.is_some_and(|m| !js_trim(m).is_empty() && !p.not_typed.is_match(m)) {
                Step::NewTurn
            } else {
                Step::Other
            }
        }
        Some("response_item") => {
            if pl.get("type").and_then(Value::as_str) == Some("message") && pl.get("role").and_then(Value::as_str) == Some("assistant") {
                let txt = text_of_blocks(pl.get("content"), &defaults::list("compact_decl.codex_text_types"));
                return if js_trim(&txt).is_empty() { Step::Other } else { Step::Text(vec![txt]) };
            }
            Step::Other
        }
        _ => Step::Other,
    }
}

/// A number with an exponent (`1e5`, `2E-3`) somewhere in the text: serde rejects one outside the finite range, which
/// JavaScript reads as infinity.
pub(crate) fn has_exponent(line: &str) -> bool {
    line.as_bytes().windows(3).enumerate().any(|(i, w)| {
        w[0].is_ascii_digit()
            && matches!(w[1], b'e' | b'E')
            && (w[2].is_ascii_digit() || (matches!(w[2], b'+' | b'-') && line.as_bytes().get(i + 3).is_some_and(u8::is_ascii_digit)))
    })
}

/// How deeply a JSON text nests (brackets outside strings).
pub(crate) fn json_depth(line: &str) -> usize {
    let (mut depth, mut max, mut in_str, mut esc) = (0usize, 0usize, false, false);
    for c in line.chars() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '[' | '{' => {
                depth += 1;
                max = max.max(depth);
            }
            ']' | '}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    max
}

/// The assistant text of the current turn, one part per text block, in order. `None` when a line could not be handled
/// exactly.
///
/// Mirrors `compact-advice.js` `readTurn` (the turn text only).
pub(crate) fn turn_texts(lines: &[String]) -> Option<Vec<String>> {
    let mut parts: Vec<String> = Vec::new();
    for line in lines.iter().filter(|l| !l.is_empty()) {
        let e: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // Node might parse what serde rejects: a lone surrogate escape, nesting past serde's limit, an exponent
                // out of range. Anything else is invalid JSON for both, and Node skips the line too.
                if line.contains("\\u") || json_depth(line) > defaults::num("compact_decl.deep_json_depth") as usize || has_exponent(line) {
                    return None;
                }
                continue;
            }
        };
        if !e.is_object() && !e.is_array() {
            continue;
        }
        match classify(&e) {
            Step::NewTurn => parts.clear(),
            Step::Text(t) => parts.extend(t),
            Step::Other => {}
        }
    }
    Some(parts)
}

/// Whether the current turn's assistant text may hold a declaration. `None` when a line could not be handled exactly.
///
/// Mirrors `compact-advice.js` `readTurn` (the turn text only), reduced to "does it contain the safe word".
fn turn_may_declare(lines: &[String]) -> Option<bool> {
    let word = defaults::text("compact_decl.safe_word").as_bytes();
    Some(turn_texts(lines)?.iter().any(|t| contains_ci(t.as_bytes(), word)))
}

/// The check's decision on one payload. `None`: allow.
///
/// Mirrors `hooks/compact-declaration-guard.js` `decide`.
pub fn decide(p: &Value, st: &Settings) -> Option<Verdict> {
    if !get_bool(st, defaults::raw("compact_decl.setting")) || !p.is_object() {
        return None;
    }
    let markers = defaults::list("compact_decl.agent_markers");
    if markers.iter().any(|k| p.get(k).is_some_and(|v| !v.is_null())) || is_skipped(st, defaults::text("compact_decl.guard_name")) {
        return None;
    }
    // Without a transcript path Node allows whatever the call is, so that is settled first (it also spares a deferral for a
    // relative file path that would need the working directory).
    let path = p.get("transcript_path").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    match is_new_work(p) {
        Work::No => return None,
        Work::Defer => return Some(Verdict::Defer),
        Work::Yes => {}
    }
    if !paths::is_absolute(path) {
        return Some(Verdict::Defer);
    }
    let max = defaults::num("compact_decl.tail_bytes");
    let lines = read_tail(path, max)?;
    // Quick exact test: if the tail holds neither the safe word nor any `\u` escape, no string in it can decode to text
    // that contains the word, so the turn cannot hold a declaration whatever the turn boundaries are.
    let word = defaults::text("compact_decl.safe_word").as_bytes();
    if !lines.iter().any(|l| contains_ci(l.as_bytes(), word) || l.contains("\\u")) {
        return None;
    }
    match turn_may_declare(&lines) {
        Some(false) => None,
        Some(true) | None => Some(Verdict::Defer),
    }
}

/// The registered `compact-declaration-guard` check.
pub struct CompactDeclarationGuard;

impl Check for CompactDeclarationGuard {
    fn name(&self) -> &'static str {
        "compact-declaration-guard"
    }

    fn summary(&self) -> &'static str {
        defaults::text("compact_decl.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        // Needs the transcript path and agent markers from the payload; without them, let Node decide.
        (s.event == "PreToolUse" && s.tool.is_some()).then_some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, &Settings::from_env(env)).unwrap_or(Verdict::Allow))
    }
}
