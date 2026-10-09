//! Shell text primitives that other compiled checks still share (the heredoc opener parser and the arithmetic-context scan of
//! `lib/shell-scan.js`, `basename`, `is_assign`). The git guard's own tokenizer, segment splitter, verb resolution and scans are
//! plugin script logic now (`engine/logic/git.js`, D88); this file holds only what `command` and `scan-throttle` have not yet
//! moved. Strings are scanned as `char` vectors.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

/// JavaScript whitespace (`\s`), the exact ECMAScript set; Rust's `char::is_whitespace` differs (U+0085 is in it,
/// U+FEFF is not), so the shared helper is used.
pub use crate::checks::guardkit::text::is_js_space;

/// Trim like JavaScript `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// Final path component, like Node `path.basename`.
///
/// Mirrors `lib/shell-scan.js` `basename`.
pub fn basename(p: &str) -> String {
    if p.is_empty() {
        return String::new();
    }
    p.rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

/// True for a `NAME=value` word.
pub fn is_assign(s: &str) -> bool {
    let mut it = s.chars();
    match it.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    for c in it {
        if c == '=' {
            return true;
        }
        if !(c.is_ascii_alphanumeric() || c == '_') {
            return false;
        }
    }
    false
}

// ---------------------------------------------------------------------------------------------------
// heredoc parsing (lib/shell-scan.js)

/// One parsed heredoc: where it starts and ends in the command, its delimiter word, whether the delimiter was quoted, and its body.
#[derive(Clone, Debug)]
pub struct Heredoc {
    /// Index just past the heredoc (terminator line included).
    pub end: usize,
    /// Length of the `<<WORD` opener text.
    pub opener_len: usize,
    /// Index just past the opener.
    pub opener_end: usize,
    /// Index of the newline that ends the opener line, if any.
    pub line_end: Option<usize>,
    /// The delimiter word.
    pub word: String,
    /// True when the delimiter was quoted, so the body is not expanded.
    pub quoted: bool,
    /// The text between the opener line and the terminator.
    pub body: String,
    /// True when the terminator line was found.
    pub terminated: bool,
}

/// Incremental state for telling whether a position is inside `$((...))` arithmetic, where `<<` is a shift, not a heredoc.
pub struct ArithScan {
    j: usize,
    stack: Vec<char>,
    in_single: bool,
    in_double: bool,
    skip_from: Option<usize>,
    skip_to: usize,
}

impl ArithScan {
    /// A scan positioned at the start of the text.
    pub fn new() -> ArithScan {
        ArithScan { j: 0, stack: Vec::new(), in_single: false, in_double: false, skip_from: None, skip_to: 0 }
    }
}

impl Default for ArithScan {
    fn default() -> Self {
        Self::new()
    }
}

fn is_ws_js(c: char) -> bool {
    is_js_space(c)
}

/// True when `pos` lies inside an arithmetic expansion; `st` carries the scan between calls so a left-to-right pass stays linear.
///
/// Mirrors `lib/shell-scan.js` `inArithmeticAt`.
pub fn in_arithmetic_at(cmd: &[char], pos: usize, st: &mut ArithScan) -> bool {
    let n = cmd.len();
    if st.j > pos {
        *st = ArithScan::new();
    }
    // `pos` past the end scans to the end: JavaScript reads `undefined` there and moves on, it never throws.
    while st.j < pos && st.j < n {
        if let Some(sf) = st.skip_from
            && st.j >= sf
        {
            if st.skip_to > pos {
                return false;
            }
            st.j = st.skip_to;
            st.skip_from = None;
            continue;
        }
        let j = st.j;
        let c = cmd[j];
        let c2 = cmd.get(j + 1).copied();
        let top = st.stack.last().copied();
        if st.in_single {
            if c == '\'' {
                st.in_single = false;
            }
            st.j = j + 1;
            continue;
        }
        if c == '\\' {
            st.j = j + 2;
            continue;
        }
        if !st.in_double && c == '$' && c2 == Some('\'') {
            let mut k = j + 2;
            while k < n && cmd[k] != '\'' {
                k += if cmd[k] == '\\' { 2 } else { 1 };
            }
            st.j = k + 1;
            continue;
        }
        if !st.in_double && c == '\'' {
            st.in_single = true;
            st.j = j + 1;
            continue;
        }
        if c == '"' {
            st.in_double = !st.in_double;
            st.j = j + 1;
            continue;
        }
        if c == '$' && c2 == Some('(') && cmd.get(j + 2) == Some(&'(') {
            st.stack.push('A');
            st.j = j + 3;
            continue;
        }
        if c == '$' && c2 == Some('[') {
            st.stack.push('B');
            st.j = j + 2;
            continue;
        }
        if c == '$' && c2 == Some('(') {
            st.stack.push('C');
            st.j = j + 2;
            continue;
        }
        if c == '(' && c2 == Some('(') && top != Some('A') && top != Some('B') {
            st.stack.push('A');
            st.j = j + 2;
            continue;
        }
        if c == '(' {
            st.stack.push('P');
            st.j = j + 1;
            continue;
        }
        if c == ')' {
            if top == Some('A') && c2 == Some(')') {
                st.stack.pop();
                st.j = j + 2;
                continue;
            }
            if top == Some('C') || top == Some('P') {
                st.stack.pop();
            }
            st.j = j + 1;
            continue;
        }
        if c == '[' && (top == Some('B') || top == Some('Q')) {
            st.stack.push('Q');
            st.j = j + 1;
            continue;
        }
        if c == ']' {
            if top == Some('B') || top == Some('Q') {
                st.stack.pop();
            }
            st.j = j + 1;
            continue;
        }
        if !st.in_double && c == '<' && c2 == Some('<') && top != Some('A') && top != Some('B') {
            if let Some(h) = parse_heredoc_raw(cmd, j) {
                let body_start = j + h.opener_len;
                if body_start < h.end && st.skip_from.is_none_or(|sf| body_start < sf) {
                    st.skip_from = Some(body_start);
                    st.skip_to = h.end;
                }
            }
            st.j = j + 2;
            continue;
        }
        st.j = j + 1;
    }
    let top = st.stack.last().copied();
    top == Some('A') || top == Some('B')
}

/// Parse a heredoc opener at `i`, unless that position is inside arithmetic.
///
/// Mirrors `lib/shell-scan.js` `parseHeredocAt`.
pub fn parse_heredoc_at(cmd: &[char], i: usize, st: &mut ArithScan) -> Option<Heredoc> {
    if in_arithmetic_at(cmd, i, st) {
        return None;
    }
    parse_heredoc_raw(cmd, i)
}

fn find_char(cmd: &[char], c: char, from: usize) -> Option<usize> {
    if from >= cmd.len() {
        return None;
    }
    cmd[from..].iter().position(|&x| x == c).map(|p| p + from)
}

/// Parse a heredoc opener at `i` without the arithmetic check.
///
/// Mirrors `lib/shell-scan.js` `parseHeredocRaw`.
pub fn parse_heredoc_raw(cmd: &[char], i: usize) -> Option<Heredoc> {
    let n = cmd.len();
    if cmd.get(i) != Some(&'<') || cmd.get(i + 1) != Some(&'<') {
        return None;
    }
    if cmd.get(i + 2) == Some(&'<') || (i > 0 && cmd[i - 1] == '<') {
        return None;
    }
    // HEREDOC_RE: ^<<(-)?\s*("([^"]*)"|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*))
    let mut p = i + 2;
    let mut dash_strip = false;
    if cmd.get(p) == Some(&'-') {
        dash_strip = true;
        p += 1;
    }
    while p < n && is_ws_js(cmd[p]) {
        p += 1;
    }
    let item_start = p;
    match cmd.get(p) {
        Some('"') => {
            find_char(cmd, '"', p + 1)?;
        }
        Some('\'') => {
            find_char(cmd, '\'', p + 1)?;
        }
        Some(&c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return None,
    }
    let mut j = item_start;
    let mut word = String::new();
    let mut quoted = false;
    let stop = |c: char| " \t\r\n;&|<>()".contains(c);
    while j < n && !stop(cmd[j]) {
        let ch = cmd[j];
        if ch == '$' || ch == '`' {
            return None;
        }
        if ch == '\'' {
            let close = find_char(cmd, '\'', j + 1)?;
            word.extend(cmd[j + 1..close].iter());
            quoted = true;
            j = close + 1;
            continue;
        }
        if ch == '"' {
            let mut k = j + 1;
            while k < n && cmd[k] != '"' {
                if cmd[k] == '$' || cmd[k] == '`' {
                    return None;
                }
                if cmd[k] == '\\' && k + 1 < n && (cmd[k + 1] == '\\' || cmd[k + 1] == '"') {
                    word.push(cmd[k + 1]);
                    k += 2;
                    continue;
                }
                word.push(cmd[k]);
                k += 1;
            }
            if k >= n {
                return None;
            }
            quoted = true;
            j = k + 1;
            continue;
        }
        if ch == '\\' {
            if j + 1 >= n || cmd[j + 1] == '\n' || cmd[j + 1] == '\r' {
                return None;
            }
            word.push(cmd[j + 1]);
            quoted = true;
            j += 2;
            continue;
        }
        word.push(ch);
        j += 1;
    }
    if word.is_empty() {
        return None;
    }
    let opener_end = j;
    let line_end = match find_char(cmd, '\n', opener_end) {
        None => {
            return Some(Heredoc { end: n, opener_len: n - i, opener_end, line_end: None, word, quoted, body: String::new(), terminated: false });
        }
        Some(l) => l,
    };
    let opener_len = line_end - i;
    let mut idx = line_end + 1;
    let mut body_lines: Vec<String> = Vec::new();
    let mut terminated = false;
    while idx <= n {
        let next_nl = find_char(cmd, '\n', idx);
        let line_raw: String = match next_nl {
            None => cmd[idx.min(n)..].iter().collect(),
            Some(nn) => cmd[idx..nn].iter().collect(),
        };
        let line: &str = if dash_strip { line_raw.trim_start_matches('\t') } else { &line_raw };
        if line == word {
            terminated = true;
            idx = match next_nl {
                None => n,
                Some(nn) => nn + 1,
            };
            break;
        }
        body_lines.push(line.to_string());
        match next_nl {
            None => {
                idx = n;
                break;
            }
            Some(nn) => idx = nn + 1,
        }
    }
    Some(Heredoc { end: idx, opener_len, opener_end, line_end: Some(line_end), word, quoted, body: body_lines.join("\n"), terminated })
}
