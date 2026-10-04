//! Built-in `check = "scan-throttle"`: a port of the Node scan-throttle guard (PreToolUse on Bash; advisory only).
//!
//! The guard ships with no built-in scan patterns: it matches nothing unless the operator sets
//! `ANTI_HALL_THROTTLE_PATTERNS` (comma-separated regex sources). When a command segment matches, the advisory
//! recommends the background-throttled form (`taskpolicy -c utility nice -n 19 ...` on macOS, `nice -n 19 ...` on Linux),
//! quoting the exact command when the scan is the first simple command and giving a generic note otherwise. It never
//! rewrites the command and never decides anything.
//!
//! Differences from the Node guard (deliberate): a user pattern is a JavaScript regex, and only a plain subset
//! (literals, `.`, groups, alternation, quantifiers, simple classes, `^`/`$`, `\s \d \w \b` and escaped punctuation, see
//! [`pattern_is_plain`]) is matched here; any other construct (lookaround, back-references, counted repeats, Unicode
//! escapes, non-ASCII text) defers the whole call to Node, whose regex engine is the authority. With no patterns set the
//! check says nothing, as Node does, without looking at the command.
//!
//! Mirrors `hooks/scan-throttle.js`.
use crate::checks::git::tokenize::{ArithScan, parse_heredoc_at};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::settings::get_bool;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::rules::Subject;
use regex::Regex;
use serde_json::Value;
use std::sync::OnceLock;

#[cfg(test)]
mod tests;

/// True when the pattern uses only constructs whose meaning is identical in JavaScript and in the Rust `regex` crate
/// (see the module docs), and is well formed in both. Anything doubtful is `false`, which defers.
pub fn pattern_is_plain(src: &str) -> bool {
    let lits = defaults::text("scan_throttle.pattern_literal_chars");
    let escapes = defaults::text("scan_throttle.pattern_escapes");
    let cs: Vec<char> = src.chars().collect();
    let mut i = 0usize;
    let mut depth = 0usize;
    let mut atom = false; // the previous token can take a quantifier
    let mut quant = false; // the previous token was a quantifier (one lazy `?` may follow)
    let mut lazy_used = false;
    while i < cs.len() {
        let c = cs[i];
        if quant && c == '?' && !lazy_used {
            lazy_used = true;
            i += 1;
            continue;
        }
        let was_quant = quant;
        quant = false;
        lazy_used = false;
        match c {
            '*' | '+' | '?' => {
                if !atom || was_quant {
                    return false;
                }
                quant = true;
                atom = false;
            }
            '.' => atom = true,
            '|' | '^' | '$' => atom = false,
            '(' => {
                if cs.get(i + 1) == Some(&'?') {
                    if cs.get(i + 2) != Some(&':') {
                        return false;
                    }
                    i += 2;
                }
                depth += 1;
                atom = false;
            }
            ')' => {
                if depth == 0 {
                    return false;
                }
                depth -= 1;
                atom = true;
            }
            '\\' => {
                let Some(&e) = cs.get(i + 1) else { return false };
                if !escapes.contains(e) {
                    return false;
                }
                atom = !matches!(e, 'b' | 'B');
                i += 1;
            }
            '[' => match plain_class(&cs, i + 1, lits) {
                Some(end) => {
                    i = end;
                    atom = true;
                }
                None => return false,
            },
            c if lits.contains(c) => atom = true,
            _ => return false,
        }
        i += 1;
    }
    depth == 0
}

/// Validate a character class starting just after its `[`; returns the index of its closing `]`.
fn plain_class(cs: &[char], mut i: usize, lits: &str) -> Option<usize> {
    let start = i;
    if cs.get(i) == Some(&'^') {
        i += 1;
    }
    let first = i;
    let mut prev_class_escape = false;
    while i < cs.len() {
        let c = cs[i];
        match c {
            ']' => return (i > first).then_some(i),
            '\\' => {
                let e = *cs.get(i + 1)?;
                if !defaults::text("scan_throttle.pattern_escapes").contains(e) || matches!(e, 'S' | 'D' | 'W' | 'b' | 'B') {
                    return None;
                }
                prev_class_escape = matches!(e, 's' | 'd' | 'w');
                i += 2;
                continue;
            }
            '-' => {
                // a literal dash only as the first or last member; a range only between two alphanumerics
                let last = cs.get(i + 1) == Some(&']');
                let range = i > first
                    && i > start
                    && cs[i - 1].is_ascii_alphanumeric()
                    && cs.get(i + 1).is_some_and(char::is_ascii_alphanumeric)
                    && cs[i - 1] <= cs[i + 1];
                if prev_class_escape || !(i == first || last || range) {
                    return None;
                }
                if range {
                    i += 2;
                    prev_class_escape = false;
                    continue;
                }
            }
            '&' | '~' | '[' => return None,
            c if lits.contains(c) || matches!(c, '.' | '$' | '*' | '+' | '?' | '(' | ')' | '|') => {}
            _ => return None,
        }
        prev_class_escape = false;
        i += 1;
    }
    None
}

/// The user patterns from the environment value: `None` when any of them is not plain (defer), else the compiled ones.
/// An empty or unset value gives no patterns. A pattern that is plain but does not compile is invalid in JavaScript too
/// (both reject the same malformed text) and is skipped, as Node does.
fn parse_user_patterns(env_val: Option<&str>) -> Option<Vec<Regex>> {
    let mut out = Vec::new();
    for src in env_val.unwrap_or("").split(',').map(js_trim).filter(|s| !s.is_empty()) {
        if !pattern_is_plain(src) {
            return None;
        }
        out.push(jsre::try_compile(src, false)?);
    }
    Some(out)
}

/// Quote-aware, heredoc-aware split into simple commands: the opener line of a heredoc stays on its segment and the body
/// is skipped.
///
/// Mirrors `scan-throttle.js` `splitSegments`.
fn split_segments(cmd: &str) -> Vec<String> {
    let cs: Vec<char> = cmd.chars().collect();
    let n = cs.len();
    let mut segs: Vec<String> = Vec::new();
    let mut cur = String::new();
    let (mut in_single, mut in_double) = (false, false);
    let mut scan = ArithScan::new();
    let mut i = 0usize;
    let flush = |cur: &mut String, segs: &mut Vec<String>| {
        if !js_trim(cur).is_empty() {
            segs.push(std::mem::take(cur));
        } else {
            cur.clear();
        }
    };
    while i < n {
        let c = cs[i];
        let c2 = cs.get(i + 1).copied();
        if in_single {
            cur.push(c);
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if let (true, Some(d)) = (c == '\\', c2) {
                cur.push(c);
                cur.push(d);
                i += 2;
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
        if c == '<'
            && c2 == Some('<')
            && let Some(h) = parse_heredoc_at(&cs, i, &mut scan)
        {
            cur.extend(&cs[i..i + h.opener_len]);
            i = h.end;
            flush(&mut cur, &mut segs);
            continue;
        }
        if (c == '&' && c2 == Some('&')) || (c == '|' && c2 == Some('|')) {
            flush(&mut cur, &mut segs);
            i += 2;
            continue;
        }
        if matches!(c, '|' | ';' | '&' | '\n' | ')' | '(' | '{' | '}' | '`') {
            flush(&mut cur, &mut segs);
            i += 1;
            continue;
        }
        if c == '$' && c2 == Some('(') {
            flush(&mut cur, &mut segs);
            i += 2;
            continue;
        }
        cur.push(c);
        i += 1;
    }
    flush(&mut cur, &mut segs);
    segs
}

/// Whether `tool` is a file on the search path `path_var` (a pure scan, no subprocess).
///
/// Mirrors `scan-throttle.js` `probeOnPath`.
fn on_path(path_var: &str, tool: &str) -> bool {
    path_var
        .split(defaults::text("scan_throttle.path_separator"))
        .filter(|d| !d.is_empty())
        .any(|d| std::fs::metadata(format!("{}/{tool}", d.trim_end_matches('/'))).is_ok_and(|m| m.is_file()))
}

/// The exact prefix to prepend, or `None` when the platform has no known throttle tool on the path.
///
/// Mirrors `scan-throttle.js` `computeThrottlePrefix`.
fn throttle_prefix(path_var: &str) -> Option<String> {
    if cfg!(target_os = "macos") {
        let d = defaults::raw("scan_throttle.darwin");
        return on_path(path_var, d.str_field("tool")).then(|| d.str_field("prefix").to_string());
    }
    if cfg!(target_os = "linux") {
        let l = defaults::raw("scan_throttle.linux");
        if !on_path(path_var, l.str_field("tool")) {
            return None;
        }
        let io = if on_path(path_var, l.str_field("io_tool")) { l.str_field("io_prefix") } else { "" };
        return Some(format!("{io}{}", l.str_field("prefix")));
    }
    None
}

/// Index just past leading white space and NAME=value assignments (each followed by white space).
///
/// Mirrors `scan-throttle.js` `stripLeadingAssignments`.
fn strip_leading_assignments(cmd: &str) -> usize {
    static ONE: OnceLock<Regex> = OnceLock::new();
    let one = ONE.get_or_init(|| jsre::compile(defaults::text("scan_throttle.assign_one"), false));
    let skip_ws = |s: &str, from: usize| from + s[from..].chars().take_while(|&c| is_js_space(c)).map(char::len_utf8).sum::<usize>();
    let mut i = skip_ws(cmd, 0);
    while let Some(m) = one.find(&cmd[i..]) {
        let after = i + m.end();
        let next = skip_ws(cmd, after);
        if next == after {
            break; // not clearly a standalone assignment token
        }
        i = next;
    }
    i
}

/// True when the text where the prefix would go starts with a shell token that is not a plain simple command.
///
/// Mirrors `scan-throttle.js` `looksLikeUnsafeInsertionPoint`.
fn unsafe_insertion_point(rest: &str) -> bool {
    rest.is_empty()
        || rest.starts_with(|c: char| defaults::text("scan_throttle.unsafe_start_chars").contains(c))
        || rest.starts_with(defaults::text("scan_throttle.unsafe_start_subst"))
}

/// The check's decision on one payload. `None`: nothing to say.
///
/// Mirrors `hooks/scan-throttle.js` `main`.
pub fn decide(p: &Value, st: &Settings) -> Option<Verdict> {
    if !get_bool(st, defaults::raw("scan_throttle.setting")) {
        return None;
    }
    if p.get("tool_name").and_then(Value::as_str) != Some("Bash") {
        return None;
    }
    let command = p.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str).unwrap_or("");
    if js_trim(command).is_empty() {
        return None;
    }
    // No pattern, no match: Node says nothing whatever the platform or PATH, so neither is probed.
    let patterns = match parse_user_patterns(st.env.get(defaults::text("scan_throttle.patterns_env")).map(String::as_str)) {
        Some(v) => v,
        None => return Some(Verdict::Defer),
    };
    if patterns.is_empty() {
        return None;
    }
    let prefix = throttle_prefix(st.env.get(defaults::text("scan_throttle.path_var")).map_or("", String::as_str))?;
    let trimmed = command.trim_start_matches(is_js_space);
    if defaults::list("scan_throttle.known_prefixes").iter().any(|k| trimmed.starts_with(k)) {
        return None;
    }
    let segments = split_segments(command);
    let match_index = segments.iter().position(|s| patterns.iter().any(|re| re.is_match(s)))?;
    let rest_start = strip_leading_assignments(command);
    let (leading, rest) = command.split_at(rest_start);
    let guard = defaults::text("scan_throttle.guard_name");
    let text = if match_index == 0 && !unsafe_insertion_point(rest) {
        let throttled = format!("{leading}{prefix}{rest}");
        let instead = msg::render("scan_throttle.msg_first_instead", &[("throttled", &throttled)]);
        msg::message(
            Kind::Tip,
            guard,
            &Parts {
                what: defaults::text("scan_throttle.msg_first_what"),
                why: defaults::text("scan_throttle.msg_first_why"),
                instead: &instead,
                ..Parts::default()
            },
        )
    } else {
        let instead = msg::render("scan_throttle.msg_group_instead", &[("prefix", js_trim(&prefix))]);
        msg::message(Kind::Tip, guard, &Parts { what: defaults::text("scan_throttle.msg_group_what"), instead: &instead, ..Parts::default() })
    };
    Some(Verdict::Advisory(msg::advisory_json("PreToolUse", &text)))
}

/// The registered `scan-throttle` check.
pub struct ScanThrottle;

impl Check for ScanThrottle {
    fn name(&self) -> &'static str {
        "scan-throttle"
    }

    fn summary(&self) -> &'static str {
        defaults::text("scan_throttle.summary")
    }

    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        (s.tool == Some("Bash")).then_some(Verdict::Defer)
    }

    fn run_payload(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value) -> Option<Verdict> {
        decide(payload, &Settings::from_process())
    }
}
