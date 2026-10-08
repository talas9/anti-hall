//! The phrase analysis and turn reading of `hooks/lib/compact-advice.js` (`findAdvice`, `lastRetraction`, `stripQuoted`,
//! `readTurn`), for the compact-advice guard.
//!
//! JavaScript indexes a string by UTF-16 unit: the 60-unit window before a match, `{0,400}` quantifiers, blanked spans of
//! the same length, the indexes compared between the stripped and the raw text. So the text is first turned into a
//! unit string, one `char` per UTF-16 unit: a character outside the Basic Multilingual Plane becomes two stand-in
//! characters, one per surrogate (`U+F0000 + (unit - 0xD800)`, a range no unit string otherwise holds). Every count and
//! index below is then a count of units, and a class that names a surrogate unit (the non-`u` pattern classes holding
//! an emoji) names its stand-in. Text shown to the user is turned back first.
//!
//! The patterns are the Node ones, kept in `defaults/ctxbudget.toml` as Rust regex sources with three tokens: `{S}` and
//! `{NS}` (JavaScript's `\s` and `\S`), `{ws}` (the `\s` set inside a class), `{G1}`/`{G2}` (the stand-ins of the green
//! circle's surrogates) and `\b` (made ASCII, as in JavaScript). The `i` flag is applied by matching against the text
//! with ASCII letters lowered (JavaScript's non-`u` `i` folds no non-ASCII character onto an ASCII one, and every
//! pattern letter is ASCII); the match itself is read back from the unlowered text at the same offsets. Multiline `^`
//! and `$` also stop at `\r`, U+2028 and U+2029 in JavaScript but not in Rust, so a text holding one is not judged here.
use super::pct::parse_line;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::jsport::date::{self, Parsed};
use crate::defaults;
use regex::Regex;
use serde_json::Value;

const STAND_IN: u32 = 0xF0000;
const SURROGATE: u32 = 0xD800;

/// The stand-in character of a surrogate unit.
fn stand_in(unit: u32) -> char {
    char::from_u32(STAND_IN + (unit - SURROGATE)).unwrap_or(char::REPLACEMENT_CHARACTER)
}

/// The unit string of a text.
pub fn to_units(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        let mut buf = [0u16; 2];
        let enc = c.encode_utf16(&mut buf);
        if enc.len() == 2 {
            out.push(stand_in(u32::from(enc[0])));
            out.push(stand_in(u32::from(enc[1])));
        } else {
            out.push(c);
        }
    }
    out
}

/// The text of a unit string (pairs of stand-ins back to their character; a lone one, which only a cut can make,
/// becomes U+FFFD).
pub fn from_units(u: &str) -> String {
    let units: Vec<u16> = u
        .chars()
        .flat_map(|c| {
            let v = c as u32;
            if (STAND_IN..STAND_IN + 0x800).contains(&v) {
                vec![(v - STAND_IN + SURROGATE) as u16]
            } else {
                let mut b = [0u16; 2];
                c.encode_utf16(&mut b).to_vec()
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// A unit string with its char-to-byte offsets.
struct U<'a> {
    s: &'a str,
    b: Vec<usize>,
}

impl<'a> U<'a> {
    fn new(s: &'a str) -> U<'a> {
        let mut b: Vec<usize> = s.char_indices().map(|(i, _)| i).collect();
        b.push(s.len());
        U { s, b }
    }
    fn len(&self) -> usize {
        self.b.len() - 1
    }
    /// `s.slice(i, j)` in units.
    fn slice(&self, i: usize, j: usize) -> &'a str {
        let (i, j) = (i.min(self.len()), j.min(self.len()));
        &self.s[self.b[i]..self.b[j.max(i)]]
    }
    /// The unit index of a byte offset.
    fn idx(&self, byte: usize) -> usize {
        self.b.partition_point(|&o| o < byte)
    }
    fn at(&self, i: usize) -> char {
        self.s[self.b[i]..].chars().next().unwrap_or('\0')
    }
}

/// A pattern of the defaults, its tokens expanded.
fn rx(key: &str) -> Regex {
    let ws = defaults::text("guardkit.js_space");
    let src = defaults::text(key)
        .replace("{S}", &format!("[{ws}]"))
        .replace("{NS}", &format!("[^{ws}]"))
        .replace("{ws}", ws)
        .replace("{G1}", &stand_in(defaults::num("ctxbudget.ca_green_hi") as u32).to_string())
        .replace("{G2}", &stand_in(defaults::num("ctxbudget.ca_green_lo") as u32).to_string())
        .replace("\\b", "(?-u:\\b)");
    crate::checks::lit_re(&src)
}

struct Pats {
    advice: Vec<Regex>,
    neg_before: Regex,
    neg_after: Regex,
    cond_before: Regex,
    meta_before: Regex,
    all_caps: Regex,
    marker_line: Regex,
    retract: Regex,
    line_retract: Regex,
    fenced: Regex,
    blockquote: Regex,
    dquote: Regex,
    backtick: Regex,
    slash_cmd: Regex,
    instr_line: Regex,
    instr_verb: Regex,
}

fn pats() -> &'static Pats {
    static P: crate::defaults::Cache<Pats> = crate::defaults::Cache::new();
    P.get_or_init(|| Pats {
        advice: defaults::list("ctxbudget.ca_advice").iter().map(|k| rx(k)).collect(),
        neg_before: rx("ctxbudget.ca_negation_before"),
        neg_after: rx("ctxbudget.ca_negation_after"),
        cond_before: rx("ctxbudget.ca_conditional_before"),
        meta_before: rx("ctxbudget.ca_meta_before"),
        all_caps: rx("ctxbudget.ca_all_caps"),
        marker_line: rx("ctxbudget.ca_marker_line"),
        retract: rx("ctxbudget.ca_retract"),
        line_retract: rx("ctxbudget.ca_line_retract"),
        fenced: rx("ctxbudget.ca_fenced"),
        blockquote: rx("ctxbudget.ca_blockquote"),
        dquote: rx("ctxbudget.ca_dquote"),
        backtick: rx("ctxbudget.ca_backtick"),
        slash_cmd: rx("ctxbudget.ca_slash_cmd"),
        instr_line: rx("ctxbudget.ca_instr_line"),
        instr_verb: rx("ctxbudget.ca_instr_verb"),
    })
}

/// Whether a text holds a line terminator Rust's multiline anchors do not know (see the module docs).
pub fn has_foreign_line_end(text: &str) -> bool {
    text.contains(['\r', '\u{2028}', '\u{2029}'])
}

fn spaces(n: usize) -> String {
    " ".repeat(n)
}

/// `stripQuoted(text)` of a unit string.
fn strip_quoted(u: &str) -> String {
    let p = pats();
    let t = p.fenced.replace_all(u, |c: &regex::Captures| c[0].chars().map(|ch| if ch == '\n' { '\n' } else { ' ' }).collect::<String>()).into_owned();
    let t = p.blockquote.replace_all(&t, |c: &regex::Captures| spaces(c[0].chars().count())).into_owned();
    let t = p.dquote.replace_all(&t, |c: &regex::Captures| spaces(c[0].chars().count())).into_owned();
    // an inline-code span naming a slash command stays only as an instruction (after a verb, or opening its own line)
    let tu = U::new(&t);
    let t2 = p
        .backtick
        .replace_all(&t, |c: &regex::Captures| {
            let m = &c[0];
            if !p.slash_cmd.is_match(&m.to_ascii_lowercase()) {
                return spaces(m.chars().count());
            }
            let off = tu.idx(c.get(0).map_or(0, |x| x.start()));
            let before = tu.slice(off.saturating_sub(defaults::num("ctxbudget.ca_backtick_lookback") as usize), off);
            if p.instr_line.is_match(before) || p.instr_verb.is_match(&before.to_ascii_lowercase()) { m.to_string() } else { spaces(m.chars().count()) }
        })
        .into_owned();
    strip_single_quotes(&t2)
}

/// The single-quote step of `stripQuoted`:
/// `/(^|[\s([{])'([^'\n]{0,400})'(?=[\s.,;:!?)\]}]|$)/g`, a quote that names no slash command blanked.
fn strip_single_quotes(t: &str) -> String {
    let u = U::new(t);
    let n = u.len();
    let max = defaults::num("ctxbudget.ca_quote_max") as usize;
    let opens = defaults::text("ctxbudget.ca_quote_open_after");
    let closes = defaults::text("ctxbudget.ca_quote_close_before");
    let mut out = String::with_capacity(t.len());
    let mut p = 0usize;
    // try a quote opening at unit `q`: the closing quote is the first one after it (no newline, at most `max` between)
    let try_at = |q: usize| -> Option<usize> {
        if q >= n || u.at(q) != '\'' {
            return None;
        }
        let mut k = q + 1;
        while k < n && k - (q + 1) < max && u.at(k) != '\'' && u.at(k) != '\n' {
            k += 1;
        }
        if k >= n || u.at(k) != '\'' {
            return None;
        }
        let ok = k + 1 == n || is_js_space(u.at(k + 1)) || closes.contains(u.at(k + 1));
        ok.then_some(k + 1)
    };
    let slash = &pats().slash_cmd;
    while p < n {
        let hit = if p == 0 { try_at(0).map(|e| (0, e)) } else { None }.or_else(|| {
            let c = u.at(p);
            (is_js_space(c) || opens.contains(c)).then(|| try_at(p + 1).map(|e| (p + 1, e))).flatten()
        });
        match hit {
            Some((q, end)) => {
                let inner = u.slice(q + 1, end - 1);
                out.push_str(u.slice(p, q));
                if slash.is_match(&inner.to_ascii_lowercase()) {
                    out.push_str(u.slice(q, end));
                } else {
                    out.push_str(&spaces(end - q));
                }
                p = end;
            }
            None => {
                out.push(u.at(p));
                p += 1;
            }
        }
    }
    out
}

fn line_bounds(u: &U<'_>, index: usize) -> (usize, usize) {
    let start = (0..index).rev().find(|&i| u.at(i) == '\n').map_or(0, |i| i + 1);
    let end = (index..u.len()).find(|&i| u.at(i) == '\n').unwrap_or(u.len());
    (start, end)
}

/// `isMarkerLine(t, index)`: the line holds only the declaration marker (a `u`-flag pattern, so on real characters).
fn is_marker_line(u: &U<'_>, index: usize) -> bool {
    let (s, e) = line_bounds(u, index);
    pats().marker_line.is_match(&from_units(u.slice(s, e)))
}

/// `isTableRow(t, index)`.
fn is_table_row(u: &U<'_>, index: usize) -> bool {
    let (s, e) = line_bounds(u, index);
    let line = u.slice(s, e);
    let head = u.slice(s, index);
    let tail = u.slice(index, e);
    line.trim_start_matches(is_js_space).starts_with('|') || (head.contains('|') && tail.contains('|'))
}

/// `isAtSentenceOrLineStart(t, index)`.
fn is_sentence_start(u: &U<'_>, index: usize) -> bool {
    let deco = defaults::text("ctxbudget.ca_lead_deco");
    let (g1, g2) = (stand_in(defaults::num("ctxbudget.ca_green_hi") as u32), stand_in(defaults::num("ctxbudget.ca_green_lo") as u32));
    let is_deco = |c: char| is_js_space(c) || deco.contains(c) || c == g1 || c == g2;
    let ends = defaults::text("ctxbudget.ca_sentence_end");
    let mut i = index;
    let mut crossed = false;
    while i > 0 && is_deco(u.at(i - 1)) {
        if u.at(i - 1) == '\n' {
            crossed = true;
        }
        i -= 1;
    }
    if i == 0 || crossed || ends.contains(u.at(i - 1)) {
        return true;
    }
    if u.at(i - 1) == ',' {
        let mut j = i - 1;
        while j > 0 && is_js_space(u.at(j - 1)) {
            j -= 1;
        }
        let mut k = j;
        while k > 0 && u.at(k - 1).is_ascii_alphabetic() {
            k -= 1;
        }
        if k < j && defaults::list("ctxbudget.ca_lead_words").iter().any(|w| u.slice(k, j).eq_ignore_ascii_case(w)) {
            let mut s = k;
            let mut crossed2 = false;
            while s > 0 && is_js_space(u.at(s - 1)) {
                if u.at(s - 1) == '\n' {
                    crossed2 = true;
                }
                s -= 1;
            }
            if s == 0 || crossed2 || ends.contains(u.at(s - 1)) {
                return true;
            }
        }
    }
    false
}

/// `isQuestionSentence(t, index)`: the first sentence end after the match is a question mark.
fn is_question(u: &U<'_>, index: usize) -> bool {
    u.slice(index, u.len()).chars().find(|c| matches!(c, '.' | '!' | '?')) == Some('?')
}

/// `findAdvice(text)`: the recommendations (unit index, phrase), by index. The caller has ruled out the line terminators
/// of [`has_foreign_line_end`].
pub fn find_advice(text: &str) -> Vec<(usize, String)> {
    let p = pats();
    let stripped = strip_quoted(&to_units(text));
    let lower = stripped.to_ascii_lowercase();
    let (u, ul) = (U::new(&stripped), U::new(&lower));
    let (back, ahead) = (defaults::num("ctxbudget.ca_window_before") as usize, defaults::num("ctxbudget.ca_window_after") as usize);
    let mut out: Vec<(usize, String)> = Vec::new();
    for (k, re) in p.advice.iter().enumerate() {
        for m in re.find_iter(&lower) {
            let (i, e) = (ul.idx(m.start()), ul.idx(m.end()));
            let before = ul.slice(i.saturating_sub(back), i);
            let after = ul.slice(e, e + ahead);
            let negated = p.neg_before.is_match(before) || p.neg_after.is_match(after) || p.cond_before.is_match(before) || p.meta_before.is_match(before);
            let phrase = js_trim(&stripped[m.range()]);
            let bare = k == defaults::num("ctxbudget.ca_bare_safe_index") as usize;
            let command = k == defaults::num("ctxbudget.ca_command_index") as usize;
            let positioned = if bare && p.all_caps.is_match(phrase) {
                is_marker_line(&u, i) || !is_table_row(&u, i)
            } else {
                (!bare && !command) || is_sentence_start(&u, i)
            };
            if !negated && !is_question(&u, i) && positioned {
                out.push((i, from_units(phrase)));
            }
        }
    }
    out.sort_by_key(|x| x.0);
    out
}

/// `lastRetraction(text)`: the unit index of the last retraction, if any.
pub fn last_retraction(text: &str) -> Option<usize> {
    let lower = to_units(text).to_ascii_lowercase();
    let u = U::new(&lower);
    let p = pats();
    p.retract.find_iter(&lower).chain(p.line_retract.find_iter(&lower)).map(|m| u.idx(m.start())).max()
}

/// What `readTurn` reports.
#[derive(Debug, Default, PartialEq)]
pub struct Turn {
    /// The assistant text after the last tool call or result of the current turn.
    pub final_text: String,
    /// Responses started since the newest compact boundary (none without a visible one).
    pub turns_since_compact: Option<f64>,
    /// The boundary's time, when it has a readable one.
    pub compact_at: Option<f64>,
}

/// One classified event.
enum Ev {
    User,
    Notify,
    Text(String),
    Tool,
    Compact(Option<f64>),
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `tsOf(e)`. `Err` for a date only V8's lenient parser reads.
fn ts_of(e: &Value) -> Result<Option<f64>, ()> {
    match e.get("timestamp").and_then(Value::as_str).map(date::parse) {
        Some(Parsed::Ms(ms)) => Ok(Some(ms)),
        Some(Parsed::Unknown) => Err(()),
        _ => Ok(None),
    }
}

/// `textOfBlocks(content, types)`.
fn text_of_blocks(content: Option<&Value>, types: &[&str]) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str).is_some_and(|t| types.contains(&t)))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The leading `<system-reminder>` blocks of a prompt removed (`LEADING_REMINDERS_RE`).
fn strip_leading_reminders(txt: &str) -> &str {
    let tags = defaults::raw("compact_decl.reminder_tags");
    let (open, close) = (tags.str_field("open"), tags.str_field("close"));
    let mut rest = txt;
    loop {
        let Some(inner) = rest.trim_start_matches(is_js_space).strip_prefix(open) else { break };
        let Some(end) = inner.find(close) else { break };
        rest = &inner[end + close.len()..];
    }
    rest
}

struct TurnPats {
    not_typed: Regex,
    notify: Regex,
    compact_cmd: Regex,
}

fn turn_pats() -> &'static TurnPats {
    static P: crate::defaults::Cache<TurnPats> = crate::defaults::Cache::new();
    P.get_or_init(|| TurnPats {
        not_typed: crate::checks::guardkit::jsre::compile(defaults::text("compact_decl.not_typed"), false),
        notify: crate::checks::guardkit::jsre::compile(defaults::text("compact_decl.notify"), false),
        compact_cmd: crate::checks::guardkit::jsre::compile(defaults::text("compact_decl.compact_command"), false),
    })
}

/// `classify(line)` of a parsed entry. `Err` where the result is not reproduced here.
fn classify(e: &Value) -> Result<Vec<Ev>, ()> {
    let tp = turn_pats();
    let ty = e.get("type").and_then(Value::as_str);
    if ty == Some("system") && e.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
        return Ok(vec![Ev::Compact(ts_of(e)?)]);
    }
    if e.get("isSidechain") == Some(&Value::Bool(true)) {
        return Ok(Vec::new());
    }
    let message = e.get("message").filter(|m| truthy(Some(m)));
    if let (Some("user"), Some(m)) = (ty, message) {
        if truthy(e.get("isMeta")) || truthy(e.get("isCompactSummary")) {
            return Ok(Vec::new());
        }
        let c = m.get("content");
        if c.and_then(Value::as_array).is_some_and(|a| a.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))) {
            return Ok(vec![Ev::Tool]);
        }
        let txt = text_of_blocks(c, &["text"]);
        if tp.notify.is_match(&txt) {
            return Ok(vec![Ev::Notify]);
        }
        let typed = strip_leading_reminders(&txt);
        if js_trim(typed).is_empty() || tp.not_typed.is_match(typed) || tp.compact_cmd.is_match(typed) {
            return Ok(Vec::new());
        }
        return Ok(vec![Ev::User]);
    }
    if let (Some("assistant"), Some(m)) = (ty, message) {
        return Ok(match m.get("content") {
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|b| truthy(Some(b)))
                .filter_map(|b| match b.get("type").and_then(Value::as_str) {
                    Some("text") => b.get("text").and_then(Value::as_str).filter(|t| !js_trim(t).is_empty()).map(|t| Ev::Text(t.to_string())),
                    Some("tool_use") => Some(Ev::Tool),
                    _ => None,
                })
                .collect(),
            Some(Value::String(s)) if !js_trim(s).is_empty() => vec![Ev::Text(s.clone())],
            _ => Vec::new(),
        });
    }
    // Codex rollout items
    if ty == Some("compacted") {
        return Ok(vec![Ev::Compact(ts_of(e)?)]);
    }
    let Some(pl) = e.get("payload").filter(|v| v.is_object() || v.is_array()) else { return Ok(Vec::new()) };
    let pty = pl.get("type");
    match ty {
        Some("event_msg") => {
            if pty.and_then(Value::as_str) == Some("context_compacted") {
                return Ok(vec![Ev::Compact(ts_of(e)?)]);
            }
            let msg = pl.get("message").and_then(Value::as_str);
            let user = pty.and_then(Value::as_str) == Some("user_message") && msg.is_some_and(|m| !js_trim(m).is_empty() && !tp.not_typed.is_match(m));
            Ok(if user { vec![Ev::User] } else { Vec::new() })
        }
        Some("response_item") => {
            if pty.and_then(Value::as_str) == Some("message") && pl.get("role").and_then(Value::as_str) == Some("assistant") {
                let txt = text_of_blocks(pl.get("content"), &defaults::list("compact_decl.codex_text_types"));
                return Ok(if js_trim(&txt).is_empty() { Vec::new() } else { vec![Ev::Text(txt)] });
            }
            // `String(p.type || '')` tested for a tool-call word: an array's text is not reproduced here
            let words = defaults::list("ctxbudget.ca_codex_tool_types");
            match pty {
                Some(Value::String(s)) if words.iter().any(|w| s.contains(w)) => Ok(vec![Ev::Tool]),
                Some(Value::Array(a)) if !a.is_empty() => Err(()),
                _ => Ok(Vec::new()),
            }
        }
        _ => Ok(Vec::new()),
    }
}

/// `readTurn(lines)` (the final text and the compact facts). `Err` where a line is not judged exactly here.
pub fn read_turn(lines: &[String]) -> Result<Turn, ()> {
    let mut finals: Vec<String> = Vec::new();
    let mut since: Option<f64> = None;
    let mut at: Option<f64> = None;
    for line in lines.iter().filter(|l| !l.is_empty()) {
        let Some(e) = parse_line(line)? else { continue };
        if !(e.is_object() || e.is_array()) {
            continue;
        }
        for ev in classify(&e)? {
            match ev {
                Ev::User | Ev::Notify => {
                    finals.clear();
                    since = since.map(|n| n + 1.0);
                }
                Ev::Compact(t) => {
                    since = Some(0.0);
                    at = t;
                }
                Ev::Tool => finals.clear(),
                Ev::Text(t) => finals.push(t),
            }
        }
    }
    Ok(Turn { final_text: finals.join("\n"), turns_since_compact: since, compact_at: at })
}
