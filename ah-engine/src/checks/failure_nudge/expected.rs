//! "Did this Bash call fail on purpose?": a port of `hooks/lib/expected-failure.js`.
//!
//! `grep` with no match, `test -f x`, `diff a b` and `git diff --quiet` use exit status 1 as their answer, not as an error.
//! The decision is deliberately conservative: true only when the whole exit status provably comes from a predicate command
//! (the exit code is exactly 1, the final statement decides the status, and its deciding command is a predicate). Anything it
//! cannot parse with certainty is false, so the nudge keeps firing.
//!
//! Mirrors `hooks/lib/expected-failure.js` (`isExpectedNonzero`, `isHarnessRefusal`, `exitCodeOf`, `splitTop` and the helpers
//! they use). The scan walks characters; JavaScript walks UTF-16 units, which only differ for characters outside the BMP, and
//! those are never one of the characters the walk reacts to.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::defaults;
use regex::Regex;
use std::collections::HashSet;

struct Tables {
    predicate_verbs: HashSet<&'static str>,
    trivial_verbs: HashSet<&'static str>,
    pass_through: HashSet<&'static str>,
    bail: Regex,
    assign: Regex,
    command_v: Regex,
    git_predicates: Vec<Regex>,
    control: Regex,
    trailing_bg: Regex,
    trailing_and: Regex,
    comment_or_empty: Regex,
    subst: Regex,
    redirect_split: Regex,
    exit_code: Regex,
    refusal: Regex,
}

fn t() -> &'static Tables {
    static T: crate::defaults::Cache<Tables> = crate::defaults::Cache::new();
    T.get_or_init(|| {
        let c = |k: &str| jsre::compile(defaults::text(k), false);
        Tables {
            predicate_verbs: defaults::list("expected_failure.predicate_verbs").into_iter().collect(),
            trivial_verbs: defaults::list("expected_failure.trivial_verbs").into_iter().collect(),
            pass_through: defaults::list("expected_failure.pass_through").into_iter().collect(),
            bail: c("expected_failure.bail"),
            assign: c("expected_failure.assign"),
            command_v: c("expected_failure.command_v"),
            git_predicates: defaults::list("expected_failure.git_predicates").into_iter().map(|s| jsre::compile(s, false)).collect(),
            control: c("expected_failure.control"),
            trailing_bg: c("expected_failure.trailing_bg"),
            trailing_and: c("expected_failure.trailing_and"),
            comment_or_empty: c("expected_failure.comment_or_empty"),
            subst: c("expected_failure.subst"),
            redirect_split: c("expected_failure.redirect_split"),
            exit_code: c("expected_failure.exit_code"),
            refusal: c("expected_failure.refusal"),
        }
    })
}

/// Split on top-level separators only: outside quotes, backticks, `$(...)` and `${...}`. `seps` are tried in the order given
/// (longest first). `None` when quoting is unbalanced.
///
/// Mirrors `expected-failure.js` `splitTop`.
pub fn split_top(cmd: &str, seps: &[&str]) -> Option<Vec<String>> {
    let cs: Vec<char> = cmd.chars().collect();
    let n = cs.len();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut i = 0usize;
    let mut depth = 0usize;
    let mut quote = '\0';
    while i < n {
        let c = cs[i];
        if quote == '\'' {
            cur.push(c);
            if c == '\'' {
                quote = '\0';
            }
            i += 1;
            continue;
        }
        if c == '\\' {
            cur.push(c);
            if let Some(&nx) = cs.get(i + 1) {
                cur.push(nx);
            }
            i += 2;
            continue;
        }
        if quote == '"' {
            cur.push(c);
            if c == '"' {
                quote = '\0';
            } else if c == '$' && cs.get(i + 1) == Some(&'(') {
                depth += 1;
                cur.push('(');
                i += 1;
            }
            i += 1;
            continue;
        }
        if quote == '`' {
            cur.push(c);
            if c == '`' {
                quote = '\0';
            }
            i += 1;
            continue;
        }
        if matches!(c, '\'' | '"' | '`') {
            quote = c;
            cur.push(c);
            i += 1;
            continue;
        }
        if matches!(c, '(' | '{') {
            depth += 1;
            cur.push(c);
            i += 1;
            continue;
        }
        if matches!(c, ')' | '}') {
            depth = depth.saturating_sub(1);
            cur.push(c);
            i += 1;
            continue;
        }
        if depth == 0
            && let Some(hit) = seps.iter().find(|s| s.chars().enumerate().all(|(k, sc)| cs.get(i + k) == Some(&sc)))
        {
            out.push(std::mem::take(&mut cur));
            i += hit.chars().count();
            continue;
        }
        cur.push(c);
        i += 1;
    }
    if quote != '\0' {
        return None;
    }
    out.push(cur);
    Some(out)
}

/// `(verb, args)` of one simple command: leading `VAR=val` words and pass-through wrappers skipped, the verb reduced to its
/// base name.
fn simple_verb(seg: &str) -> Option<(String, Vec<String>)> {
    let s = js_trim(seg);
    let first = s.chars().next()?;
    if matches!(first, '(' | '{' | '!') {
        return None;
    }
    let toks: Vec<&str> = s.split(is_js_space).filter(|x| !x.is_empty()).collect();
    let mut i = 0usize;
    loop {
        while i < toks.len() && t().assign.is_match(toks[i]) {
            i += 1;
        }
        if i < toks.len() && t().pass_through.contains(toks[i]) {
            i += 1;
            continue;
        }
        if i < toks.len() && toks[i] == "-v" && i > 0 && toks[i - 1] == "command" {
            return Some((defaults::text("expected_failure.command_v_verb").to_string(), toks[i + 1..].iter().map(|x| x.to_string()).collect()));
        }
        break;
    }
    if i >= toks.len() {
        return None;
    }
    let verb = toks[i].rsplit('/').next().unwrap_or("").to_string();
    Some((verb, toks[i + 1..].iter().map(|x| x.to_string()).collect()))
}

fn is_predicate(seg: &str) -> bool {
    let s = js_trim(seg);
    if t().command_v.is_match(s) {
        return true;
    }
    let Some((verb, args)) = simple_verb(s) else { return false };
    if t().predicate_verbs.contains(verb.as_str()) {
        return true;
    }
    if verb == defaults::text("expected_failure.git_verb") {
        let rest = args.join(" ");
        return t().git_predicates.iter().any(|re| re.is_match(&rest));
    }
    false
}

fn is_trivial(seg: &str) -> bool {
    simple_verb(seg).is_some_and(|(v, _)| t().trivial_verbs.contains(v.as_str()))
}

/// The exit code stated in a PostToolUseFailure `error` text (`Exit code N`), `None` when not stated. The code is returned
/// as its digit text with leading zeros removed, because only equality with a small number is ever asked.
pub fn exit_code_of(error_text: &str) -> Option<String> {
    let caps = t().exit_code.captures(error_text)?;
    let digits = caps.get(1)?.as_str().trim_start_matches('0');
    Some(if digits.is_empty() { "0".to_string() } else { digits.to_string() })
}

/// A refusal by the harness or a guard: the command never ran, so "this command failed" would be wrong.
///
/// Mirrors `isHarnessRefusal`.
pub fn is_harness_refusal(error_text: &str) -> bool {
    t().refusal.is_match(error_text)
}

/// `isExpectedNonzero(command, errorText)`.
pub fn is_expected_nonzero(command: &str, error_text: &str) -> bool {
    if js_trim(command).is_empty() {
        return false;
    }
    if exit_code_of(error_text).as_deref() != Some(defaults::text("expected_failure.predicate_exit")) {
        return false;
    }
    if t().bail.is_match(command) {
        return false;
    }
    // line continuations join physical lines into one logical line
    let flat = command.replace("\\\n", " ");
    let Some(stmts) = split_top(&flat, &[";", "\n"]) else { return false };
    let Some(last) = stmts.iter().rev().map(|s| js_trim(s)).find(|s| !s.is_empty()) else { return false };
    if t().trailing_bg.is_match(last) && !t().trailing_and.is_match(last) {
        return false;
    }
    if t().comment_or_empty.is_match(last) || t().control.is_match(last) {
        return false;
    }
    match split_top(last, &["||"]) {
        Some(v) if v.len() > 1 => return false,
        None => return false, // `splitTop` null has no `.length`: the Node code throws and the caller answers false
        _ => {}
    }
    let Some(links) = split_top(last, &["&&"]) else { return false };
    let mut saw_predicate = false;
    for link in &links {
        let Some(stages) = split_top(link, &["|&", "|"]) else { return false };
        let Some(decider) = stages.last() else { return false };
        let head = t().redirect_split.split(decider).next().unwrap_or("");
        if t().subst.is_match(head) {
            return false;
        }
        if is_predicate(decider) {
            saw_predicate = true;
            continue;
        }
        if links.len() > 1 && is_trivial(decider) && stages.len() == 1 {
            continue;
        }
        return false;
    }
    saw_predicate
}
