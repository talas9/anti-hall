//! Shell text primitives ported from git-guard.js and lib/shell-scan.js: tokenizer, segment splitter,
//! verb resolution (wrappers), heredoc parsing and the quote-blind backstop cutter. Strings are scanned
//! as `char` vectors (the JS source indexes UTF-16 units; the two agree away from astral characters).

/// Placeholder token text standing for a command substitution the tokenizer could not evaluate.
pub const CMDSUBST: &str = "\0CMDSUBST\0";

/// One shell word after quote removal.
#[derive(Clone, Debug)]
pub struct Tok {
    /// The word with quotes and escapes removed.
    pub text: String,
    /// True when the whole word was quoted (it can then not be an assignment or an option).
    pub quoted_only: bool,
    /// The word as written, when it differs from `text`.
    pub raw: Option<String>,
}

impl Tok {
    /// A word with no quoting.
    pub fn plain(text: &str) -> Tok {
        Tok { text: text.to_string(), quoted_only: false, raw: None }
    }
}

/// A command after wrappers are stripped: the effective verb, its arguments and the environment assignments it carries.
#[derive(Clone, Debug)]
pub struct Ev {
    /// The program name (basename of the first word that is not a wrapper).
    pub verb: String,
    /// The words after the verb.
    pub args: Vec<Tok>,
    /// Assignments that prefixed the command or were forwarded by a wrapper.
    pub env: std::collections::HashMap<String, String>,
}

/// JavaScript whitespace: Unicode white space plus the byte-order mark, which `String.prototype.trim` also strips.
pub fn is_js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

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

fn slice(s: &[char], a: usize, b: usize) -> String {
    let b = b.min(s.len());
    if a >= b {
        return String::new();
    }
    s[a..b].iter().collect()
}

/// Split one segment into words, honouring quotes, escapes, `$(...)` and backticks.
///
/// Mirrors `git-guard.js` `tokenize`.
#[allow(unused_assignments)]
pub fn tokenize(segment: &str) -> Vec<Tok> {
    let s: Vec<char> = segment.chars().collect();
    let n = s.len();
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut has_unquoted = false;
    let mut started = false;
    let mut tok_start: Option<usize> = None;
    let mut i = 0usize;
    macro_rules! push_token {
        () => {
            if started {
                tokens.push(Tok { text: std::mem::take(&mut cur), quoted_only: !has_unquoted, raw: Some(slice(&s, tok_start.unwrap_or(0), i)) });
            }
            cur.clear();
            has_unquoted = false;
            started = false;
            tok_start = None;
        };
    }
    while i < n {
        let c = s[i];
        if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
            push_token!();
            i += 1;
            continue;
        }
        if c == '#' && !started {
            break;
        }
        if tok_start.is_none() {
            tok_start = Some(i);
        }
        if c == '$' && i + 1 < n && s[i + 1] == '\'' {
            started = true;
            i += 2;
            while i < n && s[i] != '\'' {
                if s[i] == '\\' && i + 1 < n {
                    let nx = s[i + 1];
                    cur.push(match nx {
                        'n' => '\n',
                        't' => '\t',
                        'r' => '\r',
                        'a' => '\x07',
                        'b' => '\x08',
                        'f' => '\x0c',
                        'v' => '\x0b',
                        'e' => '\x1b',
                        '0' => '\0',
                        other => other,
                    });
                    i += 2;
                } else {
                    cur.push(s[i]);
                    i += 1;
                }
            }
            i += 1;
            continue;
        }
        if c == '\'' {
            started = true;
            i += 1;
            while i < n && s[i] != '\'' {
                cur.push(s[i]);
                i += 1;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            started = true;
            i += 1;
            while i < n && s[i] != '"' {
                if s[i] == '\\' && i + 1 < n {
                    let nx = s[i + 1];
                    if nx == '$' || nx == '`' || nx == '"' || nx == '\\' || nx == '\n' {
                        cur.push(nx);
                    } else {
                        cur.push('\\');
                        cur.push(nx);
                    }
                    i += 2;
                } else {
                    cur.push(s[i]);
                    i += 1;
                }
            }
            i += 1;
            continue;
        }
        if c == '\\' && i + 1 < n {
            started = true;
            has_unquoted = true;
            cur.push(s[i + 1]);
            i += 2;
            continue;
        }
        started = true;
        has_unquoted = true;
        cur.push(c);
        i += 1;
    }
    push_token!();
    tokens
}

/// Mirrors `git-guard.js` `isBraceGroupWord`.
fn is_brace_group_word(cur: &[char], c: char, c2: Option<char>) -> bool {
    let cur_blank = cur.iter().all(|&x| is_js_space(x));
    if let Some(c2v) = c2 {
        if !is_js_space(c2v) {
            return c == '}' && cur_blank && ";&|<>)".contains(c2v);
        }
    }
    if c == '}' {
        cur_blank
    } else {
        cur.is_empty() || cur.last().is_some_and(|&x| is_js_space(x))
    }
}

/// Split a command text at `;`, `&&`, `||`, `|`, `&` and newlines (outside quotes, substitutions and heredocs).
///
/// Mirrors `git-guard.js` `splitSegments`.
pub fn split_segments(cmd: &str) -> Vec<String> {
    let s: Vec<char> = cmd.chars().collect();
    let n = s.len();
    let mut segments: Vec<String> = Vec::new();
    let mut cur: Vec<char> = Vec::new();
    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    let sentinel: Vec<char> = format!(" {CMDSUBST} ").chars().collect();
    /// Mirrors `git-guard.js` `flush`.
    fn flush(cur: &mut Vec<char>, segments: &mut Vec<String>) {
        if !cur.iter().all(|&x| is_js_space(x)) {
            segments.push(cur.iter().collect());
        }
        cur.clear();
    }
    while i < n {
        let c = s[i];
        let c2 = if i + 1 < n { Some(s[i + 1]) } else { None };
        if in_single {
            cur.push(c);
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == '\\' {
                if let Some(c2v) = c2 {
                    cur.push(c);
                    cur.push(c2v);
                    i += 2;
                    continue;
                }
            }
            if (c == '$' && c2 == Some('(')) || c == '`' {
                cur.extend_from_slice(&sentinel);
                i += if c == '$' { 2 } else { 1 };
                continue;
            }
            cur.push(c);
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if c == '\'' {
            in_single = true;
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '"' {
            in_double = true;
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '\\' && (c2 == Some('\n') || (c2 == Some('\r') && s.get(i + 2) == Some(&'\n'))) {
            cur.push(' ');
            i += if c2 == Some('\r') { 3 } else { 2 };
            continue;
        }
        if c == '\\' {
            if let Some(c2v) = c2 {
                cur.push(c);
                cur.push(c2v);
                i += 2;
                continue;
            }
        }
        if c == '&' && c2 == Some('&') {
            flush(&mut cur, &mut segments);
            i += 2;
            continue;
        }
        if c == '|' && c2 == Some('|') {
            flush(&mut cur, &mut segments);
            i += 2;
            continue;
        }
        if c == '|' {
            let prev = cur.last().copied();
            let mut bs = 0;
            if prev == Some('>') {
                let mut k = cur.len() as isize - 2;
                while k >= 0 && cur[k as usize] == '\\' {
                    bs += 1;
                    k -= 1;
                }
            }
            if prev == Some('>') && bs % 2 == 0 {
                cur.push(c);
                i += 1;
                continue;
            }
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        if c == ';' {
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        if c == '&' && c2 == Some('>') {
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '&' {
            let prev = cur.last().copied();
            let mut bs = 0;
            if prev == Some('>') || prev == Some('<') {
                let mut k = cur.len() as isize - 2;
                while k >= 0 && cur[k as usize] == '\\' {
                    bs += 1;
                    k -= 1;
                }
            }
            if (prev == Some('>') || prev == Some('<')) && bs % 2 == 0 {
                cur.push(c);
                i += 1;
                continue;
            }
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        if c == '\n' {
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        if c == ')' {
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        if (c == '{' || c == '}') && is_brace_group_word(&cur, c, c2) {
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        if c == '(' {
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        if c == '$' && c2 == Some('(') {
            cur.extend_from_slice(&sentinel);
            flush(&mut cur, &mut segments);
            i += 2;
            continue;
        }
        if c == '`' {
            cur.extend_from_slice(&sentinel);
            flush(&mut cur, &mut segments);
            i += 1;
            continue;
        }
        cur.push(c);
        i += 1;
    }
    flush(&mut cur, &mut segments);
    segments
}

// ---------------------------------------------------------------------------------------------------
// verb resolution

/// Mirrors `git-guard.js` `WRAPPERS`.
const WRAPPERS: &[&str] =
    &["command", "builtin", "exec", "sudo", "env", "nice", "nohup", "time", "timeout", "then", "do", "else", "if", "while", "until", "elif", "coproc", "!"];

/// Option grammar of a wrapper command such as `stdbuf` or `caffeinate`: which short and long options take a value and how many operands precede the wrapped command.
pub struct OptWrapper {
    /// Short options that take no value.
    pub s: &'static str,
    /// Short options that take a value.
    pub v: &'static str,
    /// Long options that take no value.
    pub l: &'static [&'static str],
    /// Long options that take a value.
    pub big_l: &'static [&'static str],
    /// Positional operands the wrapper consumes before the wrapped command.
    pub ops: usize,
}

fn opt_wrapper(name: &str) -> Option<OptWrapper> {
    Some(match name {
        "stdbuf" => OptWrapper { s: "", v: "ioe", l: &[], big_l: &["input", "output", "error"], ops: 0 },
        "caffeinate" => OptWrapper { s: "dimsu", v: "tw", l: &[], big_l: &[], ops: 0 },
        "ionice" => OptWrapper { s: "t", v: "cnpPu", l: &["ignore"], big_l: &["class", "classdata", "pid", "pgid", "uid"], ops: 0 },
        "flock" => OptWrapper {
            s: "sexnouFv",
            v: "wE",
            l: &["shared", "exclusive", "unlock", "nonblock", "nb", "close", "no-fork", "verbose"],
            big_l: &["wait", "timeout", "conflict-exit-code"],
            ops: 1,
        },
        "setsid" => OptWrapper { s: "cfw", v: "", l: &["ctty", "fork", "wait"], big_l: &[], ops: 0 },
        "chrt" => OptWrapper {
            s: "abdefiomrRpv",
            v: "TPD",
            l: &["all-tasks", "batch", "deadline", "ext", "fifo", "idle", "other", "rr", "reset-on-fork", "max", "pid", "verbose"],
            big_l: &["sched-runtime", "sched-period", "sched-deadline"],
            ops: 1,
        },
        "taskset" => OptWrapper { s: "apc", v: "", l: &["all-tasks", "pid", "cpu-list"], big_l: &[], ops: 1 },
        "doas" => OptWrapper { s: "nsL", v: "uC", l: &[], big_l: &[], ops: 0 },
        _ => return None,
    })
}

/// Mirrors `git-guard.js` `skipOptWrapper`.
fn skip_opt_wrapper(tokens: &[Tok], mut idx: usize, g: &OptWrapper) -> usize {
    while idx < tokens.len() && !tokens[idx].quoted_only && tokens[idx].text.starts_with('-') && tokens[idx].text != "-" {
        let w: Vec<char> = tokens[idx].text.chars().collect();
        let ws = tokens[idx].text.clone();
        idx += 1;
        if ws == "--" {
            break;
        }
        if let Some(long) = ws.strip_prefix("--") {
            if !ws.contains('=') && g.big_l.contains(&long) {
                idx += 1;
            }
            continue;
        }
        for k in 1..w.len() {
            if g.v.contains(w[k]) {
                if k == w.len() - 1 {
                    idx += 1;
                }
                break;
            }
        }
    }
    idx + g.ops
}

/// Mirrors `git-guard.js` `flockCommand`.
fn flock_command(tokens: &[Tok], mut i: usize) -> Option<Tok> {
    let g = opt_wrapper("flock")?; // a fixed table entry
    let is_cmd = |n: &str| n.chars().count() >= 3 && "command".starts_with(n);
    let attached = |t: &str| Tok { text: t.to_string(), quoted_only: false, raw: None };
    let mut after_file = false;
    while i < tokens.len() {
        let w = tokens[i].text.clone();
        if after_file {
            if w == "-c" {
                return tokens.get(i + 1).cloned();
            }
            if let Some(rest) = w.strip_prefix("--") {
                let (name, val) = match rest.find('=') {
                    Some(p) => (&rest[..p], Some(&rest[p + 1..])),
                    None => (rest, None),
                };
                if is_cmd(name) {
                    return match val {
                        Some(v) if !v.is_empty() => Some(attached(v)),
                        _ => tokens.get(i + 1).cloned(),
                    };
                }
            }
            return None;
        }
        if w == "--" {
            i += 2;
            after_file = true;
            continue;
        }
        if !w.starts_with('-') || w == "-" {
            after_file = true;
            i += 1;
            continue;
        }
        if let Some(rest) = w.strip_prefix("--") {
            let eq = rest.find('=');
            let name = match eq {
                Some(p) => &rest[..p],
                None => rest,
            };
            if is_cmd(name) {
                return match eq {
                    None => tokens.get(i + 1).cloned(),
                    Some(p) => Some(attached(&rest[p + 1..])),
                };
            }
            if eq.is_none() && g.big_l.contains(&name) {
                i += 1;
            }
            i += 1;
            continue;
        }
        let wc: Vec<char> = w.chars().collect();
        for k in 1..wc.len() {
            if wc[k] == 'c' {
                return if k < wc.len() - 1 { Some(attached(&wc[k + 1..].iter().collect::<String>())) } else { tokens.get(i + 1).cloned() };
            }
            if g.v.contains(wc[k]) {
                if k == wc.len() - 1 {
                    i += 1;
                }
                break;
            }
        }
        i += 1;
    }
    None
}

/// Strip wrappers (`sudo`, `env`, `nice`, `command`, shell keywords, ...) and leading assignments to find what a segment really runs.
///
/// Mirrors `git-guard.js` `effectiveVerb`.
pub fn effective_verb(tokens: &[Tok]) -> Option<Ev> {
    let mut idx = 0usize;
    while idx < tokens.len() {
        let t = &tokens[idx];
        if !t.quoted_only && is_assign(&t.text) {
            idx += 1;
            continue;
        }
        break;
    }
    while idx < tokens.len() {
        let t = &tokens[idx];
        let word = t.text.as_str();
        if !t.quoted_only {
            if let Some(g) = opt_wrapper(word) {
                let fc = if word == "flock" { flock_command(tokens, idx + 1) } else { None };
                if let Some(fc) = fc {
                    return Some(Ev { verb: "sh".into(), args: vec![Tok::plain("-c"), fc], env: Default::default() });
                }
                idx = skip_opt_wrapper(tokens, idx + 1, &g);
                continue;
            }
        }
        if !t.quoted_only && WRAPPERS.contains(&word) {
            idx += 1;
            if word == "sudo" {
                /// Mirrors `git-guard.js` `SUDO_VAL`.
                const SUDO_VAL: &[&str] = &[
                    "-u",
                    "-g",
                    "-p",
                    "-C",
                    "-r",
                    "-t",
                    "-U",
                    "-h",
                    "--user",
                    "--group",
                    "--prompt",
                    "--close-from",
                    "--role",
                    "--type",
                    "--other-user",
                    "--host",
                ];
                while idx < tokens.len() && !tokens[idx].quoted_only && tokens[idx].text.starts_with('-') {
                    let f = tokens[idx].text.as_str();
                    idx += 1;
                    if f == "--" {
                        break;
                    }
                    if SUDO_VAL.contains(&f) && idx < tokens.len() && !tokens[idx].quoted_only && !tokens[idx].text.starts_with('-') {
                        idx += 1;
                    }
                }
            } else if word == "env" {
                while idx < tokens.len() {
                    let e = &tokens[idx];
                    if !e.quoted_only && (is_assign(&e.text) || e.text.starts_with('-')) {
                        idx += 1;
                        continue;
                    }
                    break;
                }
            } else if word == "timeout" {
                while idx < tokens.len() && !tokens[idx].quoted_only && tokens[idx].text.starts_with('-') {
                    let f = tokens[idx].text.as_str();
                    idx += 1;
                    if (f == "-s" || f == "--signal" || f == "-k" || f == "--kill-after")
                        && idx < tokens.len()
                        && !tokens[idx].quoted_only
                        && !tokens[idx].text.starts_with('-')
                    {
                        idx += 1;
                    }
                }
                if idx < tokens.len() && !tokens[idx].quoted_only {
                    idx += 1;
                }
            } else if word == "time" || word == "command" {
                if idx < tokens.len() && !tokens[idx].quoted_only && tokens[idx].text == "-p" {
                    idx += 1;
                }
            } else if word == "nice" {
                while idx < tokens.len() && !tokens[idx].quoted_only && tokens[idx].text.starts_with('-') {
                    let f = tokens[idx].text.as_str();
                    idx += 1;
                    if (f == "-n" || f == "--adjustment") && idx < tokens.len() && !tokens[idx].quoted_only && !tokens[idx].text.starts_with('-') {
                        idx += 1;
                    }
                }
            }
            continue;
        }
        break;
    }
    if idx >= tokens.len() {
        return None;
    }
    let vt = &tokens[idx];
    if vt.quoted_only {
        return None;
    }
    Some(Ev { verb: basename(&vt.text), args: tokens[idx + 1..].to_vec(), env: Default::default() })
}

/// Shell programs whose `-c` argument is itself a script.
///
/// Mirrors `lib/shell-scan.js` `SHELL_VERBS`.
pub const SHELL_VERBS: &[&str] = &["bash", "sh", "zsh", "dash", "ksh", "ash"];

/// True when `v` names a shell (case-insensitive).
pub fn is_shell_verb(v: &str) -> bool {
    let l = v.to_lowercase();
    SHELL_VERBS.contains(&l.as_str())
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
    while st.j < pos {
        if let Some(sf) = st.skip_from {
            if st.j >= sf {
                if st.skip_to > pos {
                    return false;
                }
                st.j = st.skip_to;
                st.skip_from = None;
                continue;
            }
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

/// A heredoc body with its delimiter word and quoting, as scanned out of a whole command.
pub struct HeredocBody {
    /// The delimiter word.
    pub word: String,
    /// True when the delimiter was quoted.
    pub quoted: bool,
    /// The body text.
    pub body: String,
}

/// All heredoc bodies in `cmd`, in order.
///
/// Mirrors `git-guard.js` `extractHeredocBodies`.
pub fn extract_heredoc_bodies(cmd: &str) -> Vec<HeredocBody> {
    let s: Vec<char> = cmd.chars().collect();
    let n = s.len();
    let mut st = ArithScan::new();
    let mut bodies = Vec::new();
    let mut i = 0usize;
    let (mut in_single, mut in_double) = (false, false);
    while i < n {
        let c = s[i];
        let c2 = s.get(i + 1).copied();
        if in_single {
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == '\\' && c2.is_some() {
                i += 2;
                continue;
            }
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if c == '\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if c == '"' {
            in_double = true;
            i += 1;
            continue;
        }
        if c == '<' && c2 == Some('<') {
            if let Some(p) = parse_heredoc_at(&s, i, &mut st) {
                bodies.push(HeredocBody { word: p.word.clone(), quoted: p.quoted, body: p.body.clone() });
                i = p.end;
                if !p.terminated {
                    break;
                }
                continue;
            }
        }
        i += 1;
    }
    bodies
}

// ---------------------------------------------------------------------------------------------------
// quote-blind backstop cutter

/// Quote-blind cut of `cmd` at separators, used by the backstop scan that must not trust the tokenizer.
///
/// Mirrors `git-guard.js` `backstopPieces`.
pub fn backstop_pieces(cmd: &str) -> Vec<String> {
    // backslash-newline joins: /\\\r?\n/g -> ' '
    let mut joined = String::with_capacity(cmd.len());
    {
        let cs: Vec<char> = cmd.chars().collect();
        let mut i = 0;
        while i < cs.len() {
            if cs[i] == '\\' && (cs.get(i + 1) == Some(&'\n') || (cs.get(i + 1) == Some(&'\r') && cs.get(i + 2) == Some(&'\n'))) {
                joined.push(' ');
                i += if cs[i + 1] == '\r' { 3 } else { 2 };
            } else {
                joined.push(cs[i]);
                i += 1;
            }
        }
    }
    let s: Vec<char> = joined.chars().collect();
    let n = s.len();
    struct Piece {
        text: String,
        tight: bool,
        line: usize,
    }
    let mut pieces: Vec<Piece> = Vec::new();
    let mut start = 0usize;
    let mut tight_pipe = false;
    let mut line_index = 0usize;
    let mut cut = |end: usize, next: usize, subst: bool, next_tight: bool, new_line: bool, pieces: &mut Vec<Piece>| {
        let mut t: String = s[start.min(end)..end].iter().collect();
        if subst {
            t.push_str(&format!(" {CMDSUBST} "));
        }
        pieces.push(Piece { text: t, tight: tight_pipe, line: line_index });
        start = next;
        tight_pipe = next_tight;
        if new_line {
            line_index += 1;
        }
    };
    let mut i = 0usize;
    while i < n {
        let c = s[i];
        if c == '\n' {
            cut(i, i + 1, false, false, true, &mut pieces);
            i += 1;
            continue;
        }
        if c == ';' || c == ')' {
            cut(i, i + 1, false, false, false, &mut pieces);
            i += 1;
            continue;
        }
        if c == '(' {
            cut(i, i + 1, i > 0 && s[i - 1] == '$', false, false, &mut pieces);
            i += 1;
            continue;
        }
        if c == '`' {
            cut(i, i + 1, true, false, false, &mut pieces);
            i += 1;
            continue;
        }
        if c == '|' {
            if i > 0 && s[i - 1] == '>' {
                i += 1;
                continue;
            }
            if s.get(i + 1) == Some(&'|') || s.get(i + 1) == Some(&'&') {
                cut(i, i + 2, false, false, false, &mut pieces);
                i += 2;
                continue;
            }
            let tight = i > 0 && !is_js_space(s[i - 1]) && i + 1 < n && !is_js_space(s[i + 1]);
            cut(i, i + 1, false, tight, false, &mut pieces);
            i += 1;
            continue;
        }
        if c == '&' {
            if s.get(i + 1) == Some(&'&') {
                cut(i, i + 2, false, false, false, &mut pieces);
                i += 2;
                continue;
            }
            if (i > 0 && (s[i - 1] == '>' || s[i - 1] == '<')) || s.get(i + 1) == Some(&'>') {
                i += 1;
                continue;
            }
            cut(i, i + 1, false, false, false, &mut pieces);
        }
        i += 1;
    }
    cut(n, n, false, false, false, &mut pieces);
    let mut out: Vec<String> = Vec::new();
    let mut pending: Option<(Vec<String>, usize)> = None;
    let (mut dq_par, mut sq_par) = (0u8, 0u8);
    for p in &pieces {
        let dq = (p.text.matches('"').count() % 2) as u8;
        let sq = (p.text.matches('\'').count() % 2) as u8;
        let (entering_dq, entering_sq) = (dq_par, sq_par);
        dq_par ^= dq;
        sq_par ^= sq;
        if let Some((_, pl)) = &pending {
            if p.line != *pl {
                let (parts, _) = pending.take().unwrap_or_default(); // checked Some just above
                out.extend(parts);
            }
        }
        if let Some((parts, _)) = pending.as_mut() {
            parts.push(p.text.clone());
            if dq_par == 0 && sq_par == 0 {
                let (parts, _) = pending.take().unwrap_or_default(); // checked Some just above
                let joined = parts.join("|");
                if let Some(last) = out.last_mut() {
                    last.push('|');
                    last.push_str(&joined);
                } else {
                    out.push(joined);
                }
            }
            continue;
        }
        if p.tight && !out.is_empty() && (entering_dq != 0 || entering_sq != 0) {
            let parts = vec![p.text.clone()];
            if dq_par == 0 && sq_par == 0 {
                let joined = parts.join("|");
                if let Some(last) = out.last_mut() {
                    last.push('|');
                    last.push_str(&joined);
                }
            } else {
                pending = Some((parts, p.line));
            }
            continue;
        }
        out.push(p.text.clone());
    }
    if let Some((parts, _)) = pending {
        out.extend(parts);
    }
    out
}

/// Effective verb of a backstop piece, found without full tokenization.
///
/// Mirrors `git-guard.js` `backstopVerb`.
pub fn backstop_verb(text: &str) -> Option<Ev> {
    // text.replace(/^(?:\s*[{}!](?=\s|$))+/, '')
    let cs: Vec<char> = text.chars().collect();
    let mut p = 0usize;
    loop {
        let mut q = p;
        while q < cs.len() && is_js_space(cs[q]) {
            q += 1;
        }
        if q < cs.len() && (cs[q] == '{' || cs[q] == '}' || cs[q] == '!') && (q + 1 >= cs.len() || is_js_space(cs[q + 1])) {
            p = q + 1;
        } else {
            break;
        }
    }
    let rest: String = cs[p..].iter().collect();
    let mut tokens = tokenize(&rest);
    let mut idx = 0;
    while idx < tokens.len() && !tokens[idx].quoted_only && is_assign(&tokens[idx].text) {
        idx += 1;
    }
    if idx < tokens.len() && tokens[idx].quoted_only {
        let t = tokens[idx].text.clone();
        tokens[idx] = Tok { text: t, quoted_only: false, raw: None };
    }
    effective_verb(&tokens)
}
