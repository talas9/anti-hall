//! `isMailboxTool(block)` of `companion/lib/devswarm-idle.js`: is one assistant tool call a mailbox-class call of the child's
//! own wake (one `devswarm.js inbox|heartbeat|roster|mesh` command with read-only output handling, the wake watcher, a cron
//! listing, a mailbox cron, a cron/monitor tool search). `childBusyState` treats a wake turn made only of such calls as a ping,
//! not as real work.
//!
//! The command grammar is Node's `segments`/`mailboxCommand`/`isReadOnlyFilter`: a sticky tokenizer over plain words, quoted
//! pieces and `|`, so anything outside it (a chain, a redirect, a substitution, another filter) is real work. Every name, verb,
//! character set and marker is a plugin setting (`devswarm_cli.rr_mb_*`).
use crate::checks::guardkit::text::{js_string_coerce, js_trim, js_truthy};
use crate::defaults;
use serde_json::Value;

fn key(k: &str) -> &'static str {
    defaults::text(k)
}

enum W {
    S(String),
    Dup,
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || key("devswarm_cli.rr_mb_word_extra").contains(c)
}

/// `segments(cmd)`: the words split on `|` (the duplicate-stderr token kept), or `None` when anything outside the grammar
/// appears.
fn segments(cmd: &str) -> Option<Vec<Vec<W>>> {
    let (sep, dup, pipe, quotes, dq_bad) = (
        key("devswarm_cli.rr_mb_sep"),
        key("devswarm_cli.rr_mb_dup"),
        key("devswarm_cli.rr_mb_pipe"),
        key("devswarm_cli.rr_mb_quotes"),
        key("devswarm_cli.rr_mb_dq_forbidden"),
    );
    let (sq, dq) = (quotes.chars().next()?, quotes.chars().nth(1)?);
    let pipe_c = pipe.chars().next()?;
    let chars: Vec<char> = cmd.chars().collect();
    let dup_c: Vec<char> = dup.chars().collect();
    let mut segs: Vec<Vec<W>> = vec![Vec::new()];
    let mut prev_word = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if sep.contains(c) {
            while i < chars.len() && sep.contains(chars[i]) {
                i += 1;
            }
            prev_word = false;
            continue;
        }
        let dup_here = chars[i..].starts_with(&dup_c) && chars.get(i + dup_c.len()).is_none_or(|n| sep.contains(*n) || *n == pipe_c);
        if dup_here {
            if prev_word {
                return None;
            }
            segs.last_mut()?.push(W::Dup);
            i += dup_c.len();
            prev_word = true;
            continue;
        }
        if c == pipe_c {
            if segs.last()?.is_empty() {
                return None;
            }
            segs.push(Vec::new());
            i += 1;
            prev_word = false;
            continue;
        }
        let (word, next) = if c == sq || c == dq {
            let mut j = i + 1;
            let mut closed = false;
            let mut s = String::new();
            while j < chars.len() {
                let x = chars[j];
                if x == c {
                    closed = true;
                    break;
                }
                if x == '\n' || (c == dq && dq_bad.contains(x)) {
                    return None;
                }
                s.push(x);
                j += 1;
            }
            if !closed {
                return None;
            }
            (s, j + 1)
        } else if is_word_char(c) {
            let mut j = i;
            let mut s = String::new();
            while j < chars.len() && is_word_char(chars[j]) {
                s.push(chars[j]);
                j += 1;
            }
            (s, j)
        } else {
            return None;
        };
        if prev_word {
            return None;
        }
        segs.last_mut()?.push(W::S(word));
        i = next;
        prev_word = true;
    }
    if segs.last()?.is_empty() {
        return None;
    }
    Some(segs)
}

/// `isReadOnlyFilter(words)`.
fn read_only_filter(words: &[W]) -> bool {
    let Some(W::S(first)) = words.first() else { return false };
    if !defaults::list("devswarm_cli.rr_mb_filters").contains(&first.as_str()) {
        return false;
    }
    let grep = defaults::list("devswarm_cli.rr_mb_filters").first() == Some(&first.as_str());
    let (long, short) = (key("devswarm_cli.rr_mb_grep_file_long"), key("devswarm_cli.rr_mb_grep_file_short"));
    for w in &words[1..] {
        let W::S(w) = w else { return false };
        if grep {
            if w == long || w.strip_prefix(long).is_some_and(|r| r.starts_with('=')) {
                return false;
            }
            if let Some(rest) = w.strip_prefix('-') {
                let run: String = rest.chars().take_while(char::is_ascii_alphanumeric).collect();
                if run.contains(short) {
                    return false;
                }
            }
        }
    }
    true
}

/// `/^(?:.*\/)?<script>$/.test(s)`: the bare name or any path ending in it, with no line terminator (a `.` does not cross one).
fn script_matches(s: &str, name: &str) -> bool {
    if key("devswarm_cli.rr_mb_line_terms").chars().any(|t| s.contains(t)) {
        return false;
    }
    s == name || s.strip_suffix(name).is_some_and(|p| p.ends_with('/'))
}

/// `mailboxCommand(cmd, scriptRe, verbs, allowTail)`.
fn mailbox_command(cmd: &str, script: &str, verbs: bool, allow_tail: bool) -> bool {
    let Some(mut segs) = segments(cmd) else { return false };
    let rest = segs.split_off(1);
    let mut first = segs.remove(0);
    if !allow_tail && (!rest.is_empty() || first.iter().any(|w| matches!(w, W::Dup))) {
        return false;
    }
    if matches!(first.last(), Some(W::Dup)) {
        first.pop();
    }
    let mut words: Vec<&str> = Vec::new();
    for w in &first {
        match w {
            W::S(s) => words.push(s),
            W::Dup => return false,
        }
    }
    if words.len() < if verbs { 3 } else { 2 } || words[0] != key("devswarm_cli.rr_mb_node") || !script_matches(words[1], script) {
        return false;
    }
    if verbs && !defaults::list("devswarm_cli.rr_mb_verbs").contains(&words[2]) {
        return false;
    }
    rest.iter().all(|s| read_only_filter(s))
}

/// `\binbox\b` with JavaScript's `\w` (ASCII word characters).
fn has_word(s: &str, w: &str) -> bool {
    let is_w = |c: char| c.is_ascii_alphanumeric() || c == '_';
    s.match_indices(w).any(|(i, m)| !s[..i].chars().next_back().is_some_and(is_w) && !s[i + m.len()..].chars().next().is_some_and(is_w))
}

/// `String(input[field])` where `input[field]` may be missing (`String(undefined)` is never reached: the callers test truthiness
/// or map a missing field to the empty string first).
fn field<'a>(input: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    match input {
        Some(Value::Object(o)) => o.get(name),
        _ => None,
    }
}

/// `String(input[f] || '')`.
fn truthy_text(input: Option<&Value>, name: &str) -> String {
    match field(input, name) {
        Some(v) if js_truthy(Some(v)) => js_string_coerce(v),
        _ => String::new(),
    }
}

/// `isMailboxTool(block)` for a tool call named `name` (`String(block.name || '')`) with `input` (the block's own `input`).
/// A falsy or non-object input reads as `{}` (every field missing).
pub fn is_mailbox_tool(name: &str, input: Option<&Value>) -> bool {
    let tools = defaults::list("devswarm_cli.rr_mb_tools");
    let at = |i: usize| tools.get(i).copied();
    let fields = defaults::list("devswarm_cli.rr_mb_fields");
    let f = |i: usize| fields.get(i).copied().unwrap_or("");
    if Some(name) == at(0) {
        let bg = field(input, f(1));
        if matches!(bg, Some(Value::Bool(true))) || matches!(bg, Some(Value::String(s)) if s == key("devswarm_cli.rr_mb_true_text")) {
            return false;
        }
        let cmd = match field(input, f(0)) {
            None | Some(Value::Null) => String::new(),
            Some(v) => js_string_coerce(v),
        };
        return mailbox_command(&cmd, key("devswarm_cli.rr_mb_cli_script"), true, true);
    }
    if Some(name) == at(1) {
        let cmd = match field(input, f(0)) {
            None | Some(Value::Null) => String::new(),
            Some(v) => js_string_coerce(v),
        };
        return mailbox_command(&cmd, key("devswarm_cli.rr_mb_watch_script"), false, false);
    }
    if Some(name) == at(2) {
        return true;
    }
    if Some(name) == at(3) {
        let p = truthy_text(input, f(2));
        return p.contains(key("devswarm_cli.rr_mb_cli_script")) && has_word(&p, key("devswarm_cli.rr_mb_inbox_word"));
    }
    if Some(name) == at(4) {
        let q = truthy_text(input, f(3));
        let Some(list) = q.strip_prefix(key("devswarm_cli.rr_mb_select_prefix")) else { return false };
        let ok = defaults::list("devswarm_cli.rr_mb_select_tools");
        return list.split(',').all(|t| ok.contains(&js_trim(t)));
    }
    false
}
