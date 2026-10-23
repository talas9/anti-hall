//! Compile JavaScript regex sources (kept in `defaults/*.toml`) with the Rust `regex` crate, keeping JavaScript's
//! meaning for the constructs where the two differ (D31, exact parity).
//!
//! What differs, and what this does about it:
//! - `\s` / `\S`: JavaScript's white space set differs from Rust's Unicode one; both are expanded to the shipped
//!   `guardkit.js_space` class body.
//! - `\b` / `\B`, `\d`, `\w`: ASCII in JavaScript (without the `u` flag), Unicode by default in Rust.
//! - `.`: excludes the four line terminators in JavaScript, only `\n` in Rust.
//! - the `i` flag: JavaScript folds ASCII letters only (a non-ASCII character never folds to ASCII), Rust folds Unicode
//!   (the Kelvin sign matches `k`); letters are expanded to explicit pairs instead.
//!
//! Not supported (and rejected when the pattern is compiled): lookahead, lookbehind and back-references. A guard
//! that needs them matches by hand.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use crate::checks::lit_re;
use crate::defaults;
use regex::Regex;

/// Translate a JavaScript regex source into Rust regex syntax. `ci` is the `i` flag.
pub fn translate(src: &str, ci: bool) -> String {
    let ws = defaults::text("guardkit.js_space");
    let lt = defaults::text("guardkit.line_terminators");
    let cs: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len() * 2);
    let mut in_class = false;
    let mut i = 0usize;
    while i < cs.len() {
        let c = cs[i];
        if c == '\\' && i + 1 < cs.len() {
            let n = cs[i + 1];
            i += 2;
            match (n, in_class) {
                ('s', false) => out.push_str(&format!("[{ws}]")),
                ('S', false) => out.push_str(&format!("[^{ws}]")),
                ('s', true) => out.push_str(ws),
                ('b', false) => out.push_str("(?-u:\\b)"),
                ('B', false) => out.push_str("(?-u:\\B)"),
                ('d', false) => out.push_str("[0-9]"),
                ('d', true) => out.push_str("0-9"),
                ('D', false) => out.push_str("[^0-9]"),
                ('w', false) => out.push_str("[A-Za-z0-9_]"),
                ('W', false) => out.push_str("[^A-Za-z0-9_]"),
                ('w', true) => out.push_str("A-Za-z0-9_"),
                _ => {
                    out.push('\\');
                    out.push(n);
                }
            }
            continue;
        }
        if in_class {
            if c == ']' {
                in_class = false;
                out.push(c);
                i += 1;
                continue;
            }
            if ci && c.is_ascii_alphabetic() {
                // a range like a-z gets its other-case twin; a lone letter gets its twin
                if cs.get(i + 1) == Some(&'-') && cs.get(i + 2).is_some_and(|e| e.is_ascii_alphabetic() && e.is_ascii_lowercase() == c.is_ascii_lowercase()) {
                    let e = cs[i + 2];
                    out.push(c);
                    out.push('-');
                    out.push(e);
                    out.push(swap_case(c));
                    out.push('-');
                    out.push(swap_case(e));
                    i += 3;
                    continue;
                }
                out.push(c);
                out.push(swap_case(c));
                i += 1;
                continue;
            }
            out.push(c);
            i += 1;
            continue;
        }
        match c {
            '[' => {
                in_class = true;
                out.push(c);
                if cs.get(i + 1) == Some(&'^') {
                    out.push('^');
                    i += 1;
                }
            }
            '.' => out.push_str(&format!("[^{lt}]")),
            c if ci && c.is_ascii_alphabetic() => out.push_str(&format!("[{c}{}]", swap_case(c))),
            c => out.push(c),
        }
        i += 1;
    }
    out
}

fn swap_case(c: char) -> char {
    if c.is_ascii_lowercase() { c.to_ascii_uppercase() } else { c.to_ascii_lowercase() }
}

/// Compile a JavaScript regex source (no flags beyond `i`).
pub fn compile(src: &str, ci: bool) -> Regex {
    lit_re(&translate(src, ci))
}

/// Compile a JavaScript regex source with the `m` flag (`^`/`$` match line boundaries) and optional `i`.
pub fn compile_multiline(src: &str, ci: bool) -> Regex {
    lit_re(&format!("(?m:{})", translate(src, ci)))
}
