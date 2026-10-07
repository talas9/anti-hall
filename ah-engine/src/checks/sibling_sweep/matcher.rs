//! The text side of the sibling-sweep check: does a reply state the cause of a bug, which sentence, what pattern does it
//! name, and does it say it searched for other occurrences.
//!
//! The matcher is deliberately narrow: a cue (root cause, caused by, the bug was, ...) counts only in an assertive
//! sentence. Code fences and quoted lines are removed first; a question, a sentence that hedges (probably, may be), a
//! negation or an intent just before the cue (not caused by, to find the root cause), a cue inside an inline code span and a
//! sentence about the root-cause tooling itself never count. Every pattern is a setting (`defaults/sibling_sweep.toml`,
//! overridable at runtime, see [`super::tune`]).
use super::tune::Tune;
use crate::checks::guardkit::text::{collapse_ws, js_trim};
use crate::checks::replykit::io::sha1_hex;

/// A cause statement found in a reply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cause {
    /// Identity of the statement (hash of the normalised sentence): the once-per-cause key.
    pub hash: String,
    /// The pattern as the reminder names it: the first inline code span of the sentence after the cue, else an excerpt.
    pub pattern: String,
}

/// The text a statement is looked for in: fenced code and quoted lines gone, emphasis markers gone, cut to
/// `sibling_sweep.text_max_bytes` at a character boundary.
fn prepare(t: &Tune, text: &str) -> String {
    let max = t.num("sibling_sweep.text_max_bytes") as usize;
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let no_fence = t.pats.fence.replace_all(&text[..end], "");
    let no_quote = t.pats.quote.replace_all(&no_fence, "");
    let strip = t.text("sibling_sweep.strip_chars");
    no_quote.chars().filter(|c| !strip.contains(*c)).collect()
}

/// Split into sentences: a hard break character always ends one, a terminator ends one when white space or the end
/// follows. Each sentence comes with the character that ended it (`None` at the end of the text).
fn sentences<'a>(t: &Tune, text: &'a str) -> Vec<(&'a str, Option<char>)> {
    let (terms, hard) = (t.text("sibling_sweep.terminators"), t.text("sibling_sweep.hard_breaks"));
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        let ends = hard.contains(c) || (terms.contains(c) && chars.peek().is_none_or(|(_, n)| n.is_whitespace()));
        if ends {
            out.push((&text[start..i], Some(c)));
            start = i + c.len_utf8();
        }
    }
    if start < text.len() {
        out.push((&text[start..], None));
    }
    out
}

/// The last `n` characters of `s` (all of it when shorter).
fn tail_chars(s: &str, n: usize) -> &str {
    let count = s.chars().count();
    if count <= n {
        return s;
    }
    s.char_indices().nth(count - n).map_or(s, |(i, _)| &s[i..])
}

/// The first `n` characters of `s`.
fn head_chars(s: &str, n: usize) -> &str {
    s.char_indices().nth(n).map_or(s, |(i, _)| &s[..i])
}

/// The sentence with every inline code span blanked out to spaces of the same byte length, so a cue quoted in code
/// (`fix: root cause was the lock`) is not a statement, and offsets still index the original.
fn mask_code(t: &Tune, sentence: &str) -> String {
    let tick = t.text("sibling_sweep.code_span");
    let mut out = String::with_capacity(sentence.len());
    let mut inside = false;
    for c in sentence.chars() {
        if tick.starts_with(c) {
            inside = !inside;
        }
        if inside || tick.starts_with(c) {
            out.extend(std::iter::repeat_n(' ', c.len_utf8()));
        } else {
            out.push(c);
        }
    }
    out
}

/// The pattern the reminder names: the first inline code span after the cue, else an excerpt from the cue on.
fn name_pattern(t: &Tune, sentence: &str, cue_start: usize) -> String {
    let tick = t.text("sibling_sweep.code_span");
    let max = t.num("sibling_sweep.snippet_chars") as usize;
    let min_span = t.num("sibling_sweep.min_span_chars") as usize;
    // a code span after the cue is the thing the cause is about; one before it is background
    let after = &sentence[cue_start..];
    if let Some(a) = after.find(&tick)
        && let Some(len) = after[a + tick.len()..].find(&tick)
    {
        let span = js_trim(&after[a + tick.len()..a + tick.len() + len]);
        if span.chars().count() >= min_span {
            return head_chars(&collapse_ws(span), max).to_string();
        }
    }
    head_chars(&collapse_ws(js_trim(after)), max).to_string()
}

/// The first assertive cause statement in `text`, `None` when there is none.
pub fn find_cause(t: &Tune, text: &str) -> Option<Cause> {
    let p = &t.pats;
    let prepared = prepare(t, text);
    let window = t.num("sibling_sweep.window_chars") as usize;
    let question = t.text("sibling_sweep.question_terminator");
    for (sentence, term) in sentences(t, &prepared) {
        let masked = mask_code(t, sentence);
        if term.is_some_and(|c| question.contains(c)) || p.meta.is_match(&masked) || p.hedge_any.is_match(&masked) {
            continue;
        }
        for cue in &p.cues {
            let Some(m) = cue.find(&masked) else { continue };
            if p.hedge_before.is_match(tail_chars(&masked[..m.start()], window)) {
                continue;
            }
            let norm = collapse_ws(js_trim(sentence)).to_lowercase();
            let hash = sha1_hex(head_chars(&norm, t.num("sibling_sweep.hash_chars") as usize));
            return Some(Cause { hash, pattern: name_pattern(t, sentence, m.start()) });
        }
    }
    None
}

/// Whether the reply is about a bug being fixed (fix words).
pub fn has_fix_words(t: &Tune, text: &str) -> bool {
    t.pats.fix.is_match(&prepare(t, text))
}

/// Whether the reply says it searched for other occurrences of the pattern ("no other occurrences", "all call sites
/// fixed", "sibling sweep").
pub fn states_sweep(t: &Tune, text: &str) -> bool {
    let prepared = prepare(t, text);
    t.pats.sweep.iter().any(|re| re.is_match(&prepared))
}

/// The short form of a cause hash that is written to the telemetry log.
pub fn short<'a>(t: &Tune, hash: &'a str) -> &'a str {
    head_chars(hash, t.num("sibling_sweep.hash_short") as usize)
}
