//! `maskQuotedText` of `hooks/speculation-guard.js`: blank the quoted material of a reply (blockquotes, fenced code,
//! inline code, straight and curly quotes) so a hedge inside a quotation is not read as the session's own speculation.
//!
//! The blanked text keeps every newline and, in UTF-16 units, its length (JavaScript's `[^\n]` matches one unit, so an
//! astral character becomes two spaces), which is what the offsets the caller computes with rely on.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::defaults;
use regex::Regex;

struct Pats {
    quote_line: Regex,
    fence_line: Regex,
    separators: Vec<Regex>,
    backtick: Regex,
    curly_double: Regex,
    curly_single: Regex,
    straight: Regex,
}

fn pats() -> &'static Pats {
    static P: crate::defaults::Cache<Pats> = crate::defaults::Cache::new();
    P.get_or_init(|| Pats {
        quote_line: jsre::compile(defaults::text("speculation_guard.quote_line_re"), false),
        fence_line: jsre::compile(defaults::text("speculation_guard.fence_line_re"), false),
        separators: defaults::raw("speculation_guard.quote_separators")
            .as_array()
            .unwrap_or_default()
            .iter()
            .map(|e| jsre::compile(e.str_field("src"), e.get("ci").and_then(crate::defaults::V::as_bool).unwrap_or(false)))
            .collect(),
        backtick: jsre::compile(defaults::text("speculation_guard.backtick_re"), false),
        curly_double: jsre::compile(defaults::text("speculation_guard.curly_double_re"), false),
        curly_single: jsre::compile(defaults::text("speculation_guard.curly_single_re"), false),
        straight: jsre::compile(defaults::text("speculation_guard.straight_re"), false),
    })
}

/// `blank(s)`: every character but a newline becomes a space, one per UTF-16 unit.
fn blank(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if c == '\n' {
            out.push('\n');
        } else {
            for _ in 0..c.len_utf16() {
                out.push(' ');
            }
        }
    }
    out
}

/// The first character of the fence marker a line opens or closes with, if it is a fence line.
fn fence_char(line: &str) -> Option<char> {
    pats().fence_line.captures(line).and_then(|c| c.get(1)).and_then(|m| m.as_str().chars().next())
}

/// `separatorEnd(line)`: the end of the earliest quote/hedge separator on a line (the earliest start wins; on a tie the
/// first pattern does), or `None`.
fn separator_end(line: &str) -> Option<usize> {
    let mut best: Option<(usize, usize)> = None;
    for re in &pats().separators {
        if let Some(m) = re.find(line)
            && best.is_none_or(|(s, _)| m.start() < s)
        {
            best = Some((m.start(), m.end()));
        }
    }
    best.map(|(_, e)| e)
}

/// `fenceMembership(lines)`: which lines belong to a fenced span (open marker through its close, or through the end).
fn fence_membership(lines: &[String]) -> Vec<bool> {
    let mut member = vec![false; lines.len()];
    let mut open: Option<char> = None;
    for (i, l) in lines.iter().enumerate() {
        let f = fence_char(l);
        match open {
            None => {
                if f.is_some() {
                    open = f;
                    member[i] = true;
                }
            }
            Some(ch) => {
                member[i] = true;
                if f == Some(ch) {
                    open = None;
                }
            }
        }
    }
    member
}

/// True when every non-empty line is fenced or a blockquote line: such a reply is never masked.
fn all_quoted_or_fenced(lines: &[String], member: &[bool]) -> bool {
    lines.iter().zip(member).all(|(l, m)| js_trim(l).is_empty() || *m || pats().quote_line.is_match(l))
}

/// `maskStraightQuotesLine(line)`: pair straight quotes within one line; an odd count masks nothing.
fn mask_straight_quotes_line(line: &str) -> String {
    let q = defaults::text("speculation_guard.quote_char");
    let n = line.matches(q).count();
    if n == 0 || !n.is_multiple_of(2) {
        return line.to_string();
    }
    pats().straight.replace_all(line, |c: &regex::Captures<'_>| blank(&c[0])).into_owned()
}

/// `maskQuotedText(text)`.
pub fn mask_quoted_text(text: &str) -> String {
    let p = pats();
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    let member = fence_membership(&lines);
    if all_quoted_or_fenced(&lines, &member) {
        return text.to_string();
    }
    let mut open: Option<(usize, char)> = None;
    for i in 0..lines.len() {
        let f = fence_char(&lines[i]);
        match open {
            None => {
                if let Some(ch) = f {
                    open = Some((i, ch));
                }
            }
            Some((start, ch)) => {
                if f == Some(ch) {
                    for l in &mut lines[start..=i] {
                        *l = blank(l);
                    }
                    open = None;
                }
            }
        }
    }
    for l in &mut lines {
        if !p.quote_line.is_match(l) {
            continue;
        }
        *l = match separator_end(l) {
            None => blank(l),
            Some(end) => format!("{}{}", blank(&l[..end]), &l[end..]),
        };
    }
    let joined = lines.iter().map(|l| mask_straight_quotes_line(l)).collect::<Vec<_>>().join("\n");
    let a = p.backtick.replace_all(&joined, |c: &regex::Captures<'_>| blank(&c[0])).into_owned();
    let b = p.curly_double.replace_all(&a, |c: &regex::Captures<'_>| blank(&c[0])).into_owned();
    p.curly_single.replace_all(&b, |c: &regex::Captures<'_>| blank(&c[0])).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hedge_inside_inline_code_or_quotes_is_blanked() {
        let sp = |n: usize| " ".repeat(n);
        assert_eq!(mask_quoted_text("see `must be x` and \"likely\" ok"), format!("see {} and {} ok", sp(11), sp(8)));
        assert_eq!(mask_quoted_text("a \u{1f600} `b`"), format!("a \u{1f600} {}", sp(3)));
    }

    #[test]
    fn a_reply_that_is_all_quote_is_left_alone() {
        assert_eq!(mask_quoted_text("> probably\n> likely"), "> probably\n> likely");
        assert_eq!(mask_quoted_text("```\nprobably\n```"), "```\nprobably\n```");
    }

    #[test]
    fn a_blockquote_is_blanked_up_to_its_separator() {
        let sp = |n: usize| " ".repeat(n);
        assert_eq!(mask_quoted_text("> probably \u{2014} so I think it is fine\nreal"), format!("{} so I think it is fine\nreal", sp(12)));
        assert_eq!(mask_quoted_text("> quoted line\nreal text"), format!("{}\nreal text", sp(13)));
    }

    #[test]
    fn a_closed_fence_is_blanked_and_an_unclosed_one_is_not() {
        assert_eq!(mask_quoted_text("x\n```\nlikely\n```\ny"), "x\n   \n      \n   \ny");
        assert_eq!(mask_quoted_text("x\n```\nlikely"), "x\n```\nlikely");
    }
}
