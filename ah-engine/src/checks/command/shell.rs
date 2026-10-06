//! Shell text primitives of command-guard.js and the parts of lib/shell-scan.js it uses: the segment splitter,
//! effective-verb resolution, the quote-aware tokenizer, command-substitution and inline-shell extraction, quote
//! neutralization, process-substitution masking and test-operator blanking.
//!
//! These are command-guard's OWN grammar (its splitter and tokenizer differ from git-guard's), so they are ported
//! here; the heredoc parser and the arithmetic scan are shared with the git check (`checks::git::tokenize`), as the
//! Node guards share them through lib/shell-scan.js.
//!
//! Every function here is only ever called on ASCII text (the check defers anything else), so byte indexes equal the
//! UTF-16 indexes of the JavaScript source and `u8::is_ascii_whitespace` plus vertical tab equals JavaScript `\s`.
use super::tables::tables;
use crate::checks::git::tokenize::{ArithScan, Heredoc, basename, parse_heredoc_at};

/// JavaScript `\s` on ASCII: space, tab, newline, carriage return, form feed and vertical tab.
pub fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// JavaScript `String.prototype.trim` on ASCII text.
pub fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_ascii() && is_ws(c as u8))
}

/// A heredoc opener at byte `i`, parsed by the shared lib/shell-scan.js port (`parseHeredocAt`).
pub struct HeredocAt {
    chars: Vec<char>,
    scan: ArithScan,
}

impl HeredocAt {
    /// A parser for `text`; `at` keeps the arithmetic scan across calls, as shell-scan.js does per text.
    pub fn new(text: &str) -> HeredocAt {
        HeredocAt { chars: text.chars().collect(), scan: ArithScan::new() }
    }

    /// `parseHeredocAt(text, i)`.
    pub fn at(&mut self, i: usize) -> Option<Heredoc> {
        parse_heredoc_at(&self.chars, i, &mut self.scan)
    }
}

/// The lower-cased basename of a word (`basename(t).toLowerCase()` in the Node source).
pub fn basename_lower(t: &str) -> String {
    basename(t).to_lowercase()
}

/// The segments of a command and the operator that ended each one.
pub struct Split {
    /// The segment texts (never blank).
    pub segments: Vec<String>,
    /// The delimiter after each segment: `&&`, `||`, `|`, `;`, `&`, a newline, `heredoc`, `group`, `subst` or `end`.
    pub delims: Vec<&'static str>,
}

/// Split a command line into logical segments.
///
/// Mirrors `command-guard.js` `splitSegmentsDetailed`.
pub fn split_detailed(cmd: &str) -> Split {
    let b = cmd.as_bytes();
    let n = b.len();
    let mut hd = HeredocAt::new(cmd);
    let mut out = Split { segments: Vec::new(), delims: Vec::new() };
    let mut cur = String::new();
    let mut i = 0usize;
    let (mut in_single, mut in_double) = (false, false);
    let mut nest: Vec<u8> = Vec::new();
    let mut in_tick = false;
    let mut esc_end: Option<usize> = None;
    let mut heredoc: Option<(usize, usize)> = None; // (lineEnd, end)
    let flush = |cur: &mut String, out: &mut Split, delim: &'static str| {
        if !trim(cur).is_empty() {
            out.segments.push(std::mem::take(cur));
            out.delims.push(delim);
        }
        cur.clear();
    };
    while i < n {
        if let Some((line_end, end)) = heredoc
            && i >= line_end
        {
            flush(&mut cur, &mut out, "heredoc");
            i = i.max(end);
            heredoc = None;
            in_single = false;
            in_double = false;
            continue;
        }
        let c = b[i];
        let c2 = b.get(i + 1).copied();
        if in_single {
            cur.push(c as char);
            if c == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == b'\\' && c2.is_some() {
                cur.push(c as char);
                cur.push(b[i + 1] as char);
                i += 2;
                continue;
            }
            cur.push(c as char);
            if c == b'"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if c == b'$' && c2 == Some(b'\'') {
            let mut j = i + 2;
            while j < n && b[j] != b'\'' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let j = (j + 1).min(n);
            cur.push_str(&cmd[i..j]);
            i = j;
            continue;
        }
        if c == b'\'' {
            in_single = true;
            cur.push('\'');
            i += 1;
            continue;
        }
        if c == b'"' {
            in_double = true;
            cur.push('"');
            i += 1;
            continue;
        }
        if c == b'\\' && (c2 == Some(b'\n') || (c2 == Some(b'\r') && b.get(i + 2) == Some(&b'\n'))) {
            cur.push(' ');
            i += if c2 == Some(b'\r') { 3 } else { 2 };
            esc_end = Some(i);
            continue;
        }
        if c == b'\\' && c2.is_some() {
            cur.push(c as char);
            cur.push(b[i + 1] as char);
            i += 2;
            esc_end = Some(i);
            continue;
        }
        if c == b'#' && nest.is_empty() && !in_tick && esc_end != Some(i) && (i == 0 || matches!(b[i - 1], b' ' | b'\t' | b'\n' | b';' | b'&' | b'|')) {
            i = cmd[i..].find('\n').map_or(n, |p| p + i);
            continue;
        }
        if c == b'<'
            && c2 == Some(b'<')
            && heredoc.is_none()
            && let Some(p) = hd.at(i)
        {
            cur.push_str(&cmd[i..p.opener_end]);
            i = p.opener_end;
            if let Some(le) = p.line_end {
                heredoc = Some((le, p.end));
            }
            continue;
        }
        if c == b'&' && c2 == Some(b'&') {
            flush(&mut cur, &mut out, "&&");
            i += 2;
            continue;
        }
        if c == b'|' && c2 == Some(b'|') {
            flush(&mut cur, &mut out, "||");
            i += 2;
            continue;
        }
        if c == b'|' {
            flush(&mut cur, &mut out, "|");
            i += 1;
            continue;
        }
        if c == b';' {
            flush(&mut cur, &mut out, ";");
            i += 1;
            continue;
        }
        if c == b'&' && ((esc_end != Some(i) && i > 0 && (b[i - 1] == b'>' || b[i - 1] == b'<')) || c2 == Some(b'>')) {
            cur.push('&');
            i += 1;
            continue;
        }
        if c == b'&' {
            flush(&mut cur, &mut out, "&");
            i += 1;
            continue;
        }
        if c == b'\n' {
            flush(&mut cur, &mut out, "\n");
            i += 1;
            continue;
        }
        if matches!(c, b')' | b'(' | b'{' | b'}') {
            if c == b'(' || c == b'{' {
                nest.push(c);
            } else if nest.last() == Some(&if c == b')' { b'(' } else { b'{' }) {
                nest.pop();
            }
            flush(&mut cur, &mut out, "group");
            i += 1;
            continue;
        }
        if c == b'$' && c2 == Some(b'(') {
            nest.push(b'(');
            flush(&mut cur, &mut out, "subst");
            i += 2;
            continue;
        }
        if c == b'`' {
            in_tick = !in_tick;
            flush(&mut cur, &mut out, "subst");
            i += 1;
            continue;
        }
        if c == b'$' && c2 == Some(b'[') {
            nest.push(b'[');
            cur.push_str("$[");
            i += 2;
            continue;
        }
        if c == b'[' && nest.last() == Some(&b'[') {
            nest.push(b'[');
        } else if c == b']' && nest.last() == Some(&b'[') {
            nest.pop();
        }
        cur.push(c as char);
        i += 1;
    }
    flush(&mut cur, &mut out, "end");
    out
}

/// The segments of a command.
///
/// Mirrors `command-guard.js` `splitSegments`.
pub fn split_segments(cmd: &str) -> Vec<String> {
    split_detailed(cmd).segments
}

/// Whitespace-separated words of a segment (JavaScript `trim().split(/\s+/).filter(Boolean)`).
pub fn words(s: &str) -> Vec<&str> {
    s.split(|c: char| c.is_ascii() && is_ws(c as u8)).filter(|w| !w.is_empty()).collect()
}

fn is_assign_word(w: &str) -> bool {
    crate::checks::git::tokenize::is_assign(w)
}

/// The effective verb of a segment: leading assignments and wrapper words (with their options) skipped; the
/// lower-cased basename, or "" when there is none.
///
/// Mirrors `command-guard.js` `effectiveVerb`.
pub fn effective_verb(segment: &str) -> String {
    let t = tables();
    let tokens = words(segment);
    let mut idx = 0;
    while idx < tokens.len() && is_assign_word(tokens[idx]) {
        idx += 1;
    }
    while idx < tokens.len() {
        let word = basename(tokens[idx]).to_lowercase();
        if !t.wrappers.contains(&word) {
            break;
        }
        idx += 1;
        let value_wrapper = |idx: &mut usize, vals: &std::collections::HashSet<String>, stop_at_dashdash: bool| {
            while *idx < tokens.len() && tokens[*idx].starts_with('-') {
                let f = tokens[*idx];
                *idx += 1;
                if stop_at_dashdash && f == "--" {
                    break;
                }
                if vals.contains(f) && *idx < tokens.len() && !tokens[*idx].starts_with('-') {
                    *idx += 1;
                }
            }
        };
        match word.as_str() {
            "sudo" => value_wrapper(&mut idx, &t.sudo_value, true),
            "env" => {
                while idx < tokens.len() && (is_assign_word(tokens[idx]) || tokens[idx].starts_with('-')) {
                    idx += 1;
                }
            }
            "timeout" => {
                value_wrapper(&mut idx, &t.timeout_value, false);
                if idx < tokens.len() {
                    idx += 1;
                }
            }
            "nice" => value_wrapper(&mut idx, &t.nice_value, false),
            "taskpolicy" => value_wrapper(&mut idx, &t.taskpolicy_value, false),
            "xargs" => {
                while idx < tokens.len() && tokens[idx].starts_with('-') {
                    idx += 1;
                }
            }
            _ => {}
        }
    }
    if idx >= tokens.len() {
        return String::new();
    }
    basename(tokens[idx]).to_lowercase()
}

/// Quote-aware words of a segment (quote characters removed, no escape handling).
///
/// Mirrors `lib/shell-scan.js` `tokenizeQuoted`.
pub fn tokenize_quoted(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut q: Option<char> = None;
    let mut any = false;
    for c in trim(segment).chars() {
        if let Some(qc) = q {
            if c == qc {
                q = None;
            } else {
                cur.push(c);
            }
            any = true;
            continue;
        }
        if c == '\'' || c == '"' {
            q = Some(c);
            any = true;
            continue;
        }
        if c.is_ascii() && is_ws(c as u8) {
            if any {
                tokens.push(std::mem::take(&mut cur));
                any = false;
            }
            continue;
        }
        cur.push(c);
        any = true;
    }
    if any {
        tokens.push(cur);
    }
    tokens
}

/// The words of a segment re-joined with single spaces.
///
/// Mirrors `lib/shell-scan.js` `dequoteSegment`.
pub fn dequote_segment(segment: &str) -> String {
    tokenize_quoted(segment).join(" ")
}

/// The bodies of `$(...)` and backtick substitutions in `s` (outer level only).
///
/// Mirrors `lib/shell-scan.js` `extractSubstitutions`.
pub fn extract_substitutions(s: &str) -> Vec<String> {
    let b = s.as_bytes();
    let n = b.len();
    let mut hd = HeredocAt::new(s);
    let mut found = Vec::new();
    let mut i = 0usize;
    let (mut in_single, mut in_double) = (false, false);
    while i < n {
        let c = b[i];
        let c2 = b.get(i + 1).copied();
        if !in_single
            && !in_double
            && c == b'<'
            && c2 == Some(b'<')
            && let Some(p) = hd.at(i)
        {
            if p.quoted {
                i = p.end;
            } else {
                i += p.opener_len;
                if i < n && b[i] == b'\n' {
                    i += 1;
                }
            }
            continue;
        }
        if in_single {
            if c == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if !in_double && c == b'$' && c2 == Some(b'\'') {
            i += 2;
            while i < n && b[i] != b'\'' {
                i += if b[i] == b'\\' { 2 } else { 1 };
            }
            i += 1;
            continue;
        }
        if !in_double && c == b'\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if c == b'"' {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if c == b'$' && c2 == Some(b'(') {
            let mut depth = 1;
            let mut j = i + 2;
            let start = j;
            while j < n && depth > 0 {
                let cj = b[j];
                if cj == b'(' {
                    depth += 1;
                } else if cj == b')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            let inner = &s[start..j.min(n)];
            if !trim(inner).is_empty() {
                found.push(inner.to_string());
            }
            i = j + 1;
            continue;
        }
        if c == b'`' {
            let start = i + 1;
            let mut j = start;
            while j < n && b[j] != b'`' {
                j += 1;
            }
            let inner = &s[start.min(n)..j.min(n)];
            if !trim(inner).is_empty() {
                found.push(inner.to_string());
            }
            i = j + 1;
            continue;
        }
        i += 1;
    }
    found
}

/// The quote-aware words of a segment, as `extractShellCPayload` / `extractEvalPayload` build them (the same
/// algorithm as `tokenizeQuoted`).
fn payload_tokens(segment: &str) -> Vec<String> {
    tokenize_quoted(segment)
}

/// The `-c` script of a shell segment (`bash -c '<cmd>'`), or "".
///
/// Mirrors `command-guard.js` `extractShellCPayload`.
pub fn extract_shell_c_payload(segment: &str) -> String {
    let verb = effective_verb(segment);
    if verb.is_empty() || !tables().shell_verbs.contains(&verb) {
        return String::new();
    }
    let tokens = payload_tokens(segment);
    for (i, t) in tokens.iter().enumerate() {
        let cluster = t.len() >= 2 && t.starts_with('-') && t.ends_with('c') && t[1..].bytes().all(|x| x.is_ascii_lowercase());
        if t == "-c" || t == "--command" || cluster {
            return tokens.get(i + 1).cloned().unwrap_or_default();
        }
    }
    String::new()
}

/// The text an `eval` segment runs, or "".
///
/// Mirrors `command-guard.js` `extractEvalPayload`.
pub fn extract_eval_payload(segment: &str) -> String {
    if effective_verb(segment) != "eval" {
        return String::new();
    }
    let tokens = payload_tokens(segment);
    let mut idx = 0;
    while idx < tokens.len() && basename(&tokens[idx]).to_lowercase() != "eval" {
        idx += 1;
    }
    idx += 1;
    tokens.iter().skip(idx).filter(|t| !t.is_empty()).cloned().collect::<Vec<_>>().join(" ")
}

/// The segment with the contents of quoted strings (and the quotes) replaced by spaces.
///
/// Mirrors `command-guard.js` `neutralizeQuotedContents`.
pub fn neutralize_quoted_contents(segment: &str) -> String {
    let b = segment.as_bytes();
    let n = b.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    let (mut in_single, mut in_double) = (false, false);
    while i < n {
        let c = b[i];
        let has2 = i + 1 < n;
        if in_single {
            out.push(' ');
            if c == b'\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == b'\\' && has2 {
                out.push_str("  ");
                i += 2;
                continue;
            }
            out.push(' ');
            if c == b'"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if c == b'\\' && has2 {
            out.push(c as char);
            out.push(b[i + 1] as char);
            i += 2;
            continue;
        }
        if c == b'\'' {
            in_single = true;
            out.push(' ');
            i += 1;
            continue;
        }
        if c == b'"' {
            in_double = true;
            out.push(' ');
            i += 1;
            continue;
        }
        out.push(c as char);
        i += 1;
    }
    out
}

/// For a grep/sed/awk segment, the text with the first non-flag operand after the verb blanked.
///
/// Mirrors `command-guard.js` `blankPatternArgument`.
pub fn blank_pattern_argument(text: &str, verb: &str) -> String {
    if verb.is_empty() || !tables().pattern_first_verbs.contains(verb) {
        return text.to_string();
    }
    let b = text.as_bytes();
    let mut found_verb = false;
    let mut i = 0;
    while i < b.len() {
        if is_ws(b[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && !is_ws(b[i]) {
            i += 1;
        }
        let tok = &text[start..i];
        if !found_verb {
            if basename(tok).to_lowercase() == verb {
                found_verb = true;
            }
            continue;
        }
        if tok.starts_with('-') {
            continue;
        }
        return format!("{}{}{}", &text[..start], " ".repeat(tok.len()), &text[i..]);
    }
    text.to_string()
}

/// True when the segment has an unquoted, unescaped `<` or `>`.
///
/// Mirrors `command-guard.js` `hasUnquotedRedirectChar`.
pub fn has_unquoted_redirect_char(segment: &str) -> bool {
    let b = segment.as_bytes();
    let (mut in_single, mut in_double) = (false, false);
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let has2 = i + 1 < b.len();
        if in_single {
            if c == b'\'' {
                in_single = false;
            }
        } else if in_double {
            if c == b'\\' && has2 {
                i += 1;
            } else if c == b'"' {
                in_double = false;
            }
        } else if c == b'\\' && has2 {
            i += 1;
        } else if c == b'\'' {
            in_single = true;
        } else if c == b'"' {
            in_double = true;
        } else if c == b'>' || c == b'<' {
            return true;
        }
        i += 1;
    }
    false
}

/// True when the segment has a command substitution outside single quotes.
///
/// Mirrors `command-guard.js` `hasSubstitutionOutsideSingleQuotes`.
fn has_substitution_outside_single_quotes(segment: &str) -> bool {
    let b = segment.as_bytes();
    let (mut in_single, mut in_double) = (false, false);
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let c2 = b.get(i + 1).copied();
        if in_single {
            if c == b'\'' {
                in_single = false;
            }
        } else if in_double {
            if c == b'\\' && c2.is_some() {
                i += 1;
            } else if c == b'"' {
                in_double = false;
            } else if c == b'`' || (c == b'$' && c2 == Some(b'(')) {
                return true;
            }
        } else if c == b'\\' && c2.is_some() {
            i += 1;
        } else if c == b'\'' {
            in_single = true;
        } else if c == b'"' {
            in_double = true;
        } else if c == b'`' || (c == b'$' && c2 == Some(b'(')) {
            return true;
        }
        i += 1;
    }
    false
}

/// True when the command carries any expansion or escape character, quoted or not.
///
/// Mirrors `command-guard.js` `hasShellExpansionAnywhere`.
pub fn has_shell_expansion_anywhere(command: &str) -> bool {
    if has_substitution_outside_single_quotes(command) {
        return true;
    }
    command.contains(['$', '`', '\\']) || command.contains("<(") || command.contains(">(")
}

/// The command with `>(...)` / `<(...)` blanked to one space, and the inner commands.
///
/// Mirrors `command-guard.js` `maskProcessSubstitutions`.
pub fn mask_process_substitutions(cmd: &str) -> (String, Vec<String>) {
    let b = cmd.as_bytes();
    let n = b.len();
    let mut hd = HeredocAt::new(cmd);
    let mut inners = Vec::new();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    let mut q: Option<u8> = None;
    while i < n {
        let c = b[i];
        if let Some(qc) = q {
            if c == b'\\' && qc == b'"' && i + 1 < n {
                out.push_str(&cmd[i..i + 2]);
                i += 2;
                continue;
            }
            out.push(c as char);
            if c == qc {
                q = None;
            }
            i += 1;
            continue;
        }
        if c == b'\\' && i + 1 < n {
            out.push_str(&cmd[i..i + 2]);
            i += 2;
            continue;
        }
        if c == b'\'' || c == b'"' {
            q = Some(c);
            out.push(c as char);
            i += 1;
            continue;
        }
        if c == b'<'
            && b.get(i + 1) == Some(&b'<')
            && let Some(h) = hd.at(i)
        {
            out.push_str(&cmd[i..h.end]);
            i = h.end;
            continue;
        }
        if (c == b'<' || c == b'>') && b.get(i + 1) == Some(&b'(') {
            let mut j = i + 2;
            let mut depth = 1;
            let mut qq: Option<u8> = None;
            while j < n && depth > 0 {
                let d = b[j];
                if let Some(x) = qq {
                    if d == x {
                        qq = None;
                    }
                } else if d == b'\'' || d == b'"' {
                    qq = Some(d);
                } else if d == b'(' {
                    depth += 1;
                } else if d == b')' {
                    depth -= 1;
                }
                j += 1;
            }
            let end = if depth > 0 { j } else { j - 1 };
            inners.push(cmd[i + 2..end].to_string());
            out.push(' ');
            i = j;
            continue;
        }
        out.push(c as char);
        i += 1;
    }
    (out, inners)
}

/// Words that put a following `[[` / `((` at command position (command-guard.js TEST_KEYWORDS).
fn is_test_keyword(w: &str) -> bool {
    tables().test_keywords.contains(w)
}

/// The text with every `<` / `>` inside `[[ ]]`, `(( ))` and `$(( ))` replaced by a space.
///
/// Mirrors `command-guard.js` `blankTestOperators`.
pub fn blank_test_operators(text: &str) -> String {
    if !text.contains(['<', '>']) || !(text.contains("((") || text.contains("[[")) {
        return text.to_string();
    }
    let b = text.as_bytes();
    let n = b.len();
    let mut hd = HeredocAt::new(text);
    let mut stack: Vec<u8> = Vec::new();
    let test_ctx = |st: &Vec<u8>| matches!(st.last(), Some(b'A' | b'a' | b'b' | b'g'));
    let sep = |c: u8| matches!(c, b';' | b'&' | b'|' | b'(' | b'!' | b'\n');
    let cmd_pos = |i: usize| -> bool {
        let mut j = i as isize - 1;
        while j >= 0 && (b[j as usize] == b' ' || b[j as usize] == b'\t') {
            j -= 1;
        }
        if j < 0 || sep(b[j as usize]) {
            return true;
        }
        let mut k = j;
        while k >= 0 && b[k as usize].is_ascii_alphabetic() {
            k -= 1;
        }
        if !is_test_keyword(&text[(k + 1) as usize..(j + 1) as usize]) {
            return false;
        }
        while k >= 0 && (b[k as usize] == b' ' || b[k as usize] == b'\t') {
            k -= 1;
        }
        k < 0 || sep(b[k as usize])
    };
    let drop = |st: &mut Vec<u8>, kinds: &[u8]| {
        while st.last().is_some_and(|t| kinds.contains(t)) {
            st.pop();
        }
    };
    let mut out = String::with_capacity(n);
    let mut i = 0;
    let mut q: Option<u8> = None;
    while i < n {
        let c = b[i];
        let c2 = b.get(i + 1).copied();
        if let Some(qc) = q {
            if c == b'\\' && qc == b'"' && i + 1 < n {
                out.push_str(&text[i..i + 2]);
                i += 2;
                continue;
            }
            out.push(c as char);
            if c == qc {
                q = None;
            }
            i += 1;
            continue;
        }
        if c == b'\\' && i + 1 < n {
            out.push_str(&text[i..i + 2]);
            i += 2;
            continue;
        }
        if c == b'$' && c2 == Some(b'\'') {
            let mut j = i + 2;
            while j < n && b[j] != b'\'' {
                j += if b[j] == b'\\' { 2 } else { 1 };
            }
            let j = (j + 1).min(n);
            out.push_str(&text[i..j]);
            i = j;
            continue;
        }
        if c == b'\'' || c == b'"' {
            q = Some(c);
            out.push(c as char);
            i += 1;
            continue;
        }
        if c == b'<'
            && c2 == Some(b'<')
            && !test_ctx(&stack)
            && let Some(h) = hd.at(i)
        {
            out.push_str(&text[i..h.end]);
            i = h.end;
            continue;
        }
        if c == b';' || c == b'\n' {
            drop(&mut stack, b"abg");
        } else if (c == b'&' || c == b'|') && c2 != Some(c) && (i == 0 || b[i - 1] != c) {
            drop(&mut stack, b"bg");
        }
        if c == b'$' && c2 == Some(b'(') && b.get(i + 2) == Some(&b'(') {
            stack.push(b'A');
            out.push_str("$((");
            i += 3;
            continue;
        }
        if c == b'$' && c2 == Some(b'(') {
            stack.push(b'p');
            out.push_str("$(");
            i += 2;
            continue;
        }
        if c == b'(' && c2 == Some(b'(') && !test_ctx(&stack) && cmd_pos(i) {
            stack.push(b'a');
            out.push_str("((");
            i += 2;
            continue;
        }
        if c == b'(' {
            let k = if test_ctx(&stack) { b'g' } else { b'p' };
            stack.push(k);
            out.push('(');
            i += 1;
            continue;
        }
        if c == b')' {
            if matches!(stack.last(), Some(b'a' | b'A')) && c2 == Some(b')') {
                stack.pop();
                out.push_str("))");
                i += 2;
                continue;
            }
            stack.pop();
            out.push(')');
            i += 1;
            continue;
        }
        if c == b'[' && c2 == Some(b'[') && !test_ctx(&stack) && cmd_pos(i) && b.get(i + 2).is_some_and(|&x| is_ws(x)) {
            stack.push(b'b');
            out.push_str("[[");
            i += 2;
            continue;
        }
        if c == b']'
            && c2 == Some(b']')
            && stack.last() == Some(&b'b')
            && b.get(i + 2).is_none_or(|&x| is_ws(x) || matches!(x, b';' | b'&' | b'|' | b')' | b'<' | b'>'))
        {
            stack.pop();
            out.push_str("]]");
            i += 2;
            continue;
        }
        out.push(if (c == b'<' || c == b'>') && test_ctx(&stack) { ' ' } else { c as char });
        i += 1;
    }
    out
}

/// The heredoc bodies in `text`, in order.
///
/// Mirrors `lib/shell-scan.js` `heredocBodiesIn`.
pub fn heredoc_bodies_in(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut hd = HeredocAt::new(text);
    let mut out = Vec::new();
    let mut q: Option<u8> = None;
    let mut i = 0usize;
    while i < b.len() {
        let c = b[i];
        if let Some(qc) = q {
            if c == b'\\' && qc == b'"' {
                i += 2;
                continue;
            }
            if c == qc {
                q = None;
            }
            i += 1;
            continue;
        }
        if c == b'\\' {
            i += 2;
            continue;
        }
        if c == b'\'' || c == b'"' {
            q = Some(c);
            i += 1;
            continue;
        }
        if c == b'<' && b.get(i + 1) == Some(&b'<') {
            if let Some(h) = hd.at(i) {
                out.push(h.body.clone());
                let stop = if h.line_end.is_some() { h.end } else { h.opener_end };
                i = i.max(stop.saturating_sub(1));
            } else if b.get(i + 2) == Some(&b'<') {
                i += 2;
            }
        }
        i += 1;
    }
    out
}

/// Per segment, the heredoc bodies that belong to it (matched by count against the bodies of the whole text).
///
/// Mirrors `lib/shell-scan.js` `segmentHeredocBodies`.
pub fn segment_heredoc_bodies(segments: &[String], text: &str) -> Vec<Vec<String>> {
    let all = heredoc_bodies_in(text);
    let mut k = 0;
    segments
        .iter()
        .map(|s| {
            let n = heredoc_bodies_in(s).len();
            let lo = k.min(all.len());
            let hi = (k + n).min(all.len());
            k += n;
            all[lo..hi].to_vec()
        })
        .collect()
}
