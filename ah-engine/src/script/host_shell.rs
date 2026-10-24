//! Shell-text scanners of the `command` check as host functions (the character-by-character walks were the bulk of the check's
//! CPU when run in the interpreter). Each is a line-for-line port of the plugin's reference function in
//! `engine/logic/command.js`, which stays in the script as the differential oracle (`tokenizeQuotedJs`,
//! `extractSubstitutionsJs`, `splitSegmentsDetailedJs`, `scannersReference`): `tests` below runs both on a fixed fixture set,
//! a generated shell-ish alphabet and the replay and real-command corpora, and requires zero differences.
//!
//! | raw function | what it does |
//! |---|---|
//! | `shellTokenize(segment)` | the quote-respecting words of a segment (`tokenizeQuotedRaw`) |
//! | `shellSubstitutions(text)` | the bodies of `$(...)` and backtick substitutions, heredoc bodies skipped (`extractSubstitutionsRaw`) |
//! | `shellSplit(cmd)` | `[segments, delimiters]` of a command line (`splitSegmentsDetailedRaw`) |
//!
//! Strings are scanned as `char` vectors; every special character is ASCII or BMP, so splitting by code point instead of by
//! UTF-16 unit changes nothing (a surrogate pair is never torn apart in the output).

use crate::checks::git::tokenize::{ArithScan, js_trim, parse_heredoc_at};
use crate::checks::guardkit::text::is_js_space;
use rquickjs::{Ctx, Function, Object};

/// The character at `i`, as JavaScript's `s[i]` (nothing past the end).
fn at(v: &[char], i: usize) -> Option<char> {
    v.get(i).copied()
}

/// `tokenizeQuotedRaw`: words split on whitespace outside quotes, the quote characters removed.
pub fn tokenize(segment: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let (mut cur, mut q, mut any) = (String::new(), None::<char>, false);
    for c in js_trim(segment).chars() {
        if let Some(open) = q {
            if c == open {
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
        if is_js_space(c) {
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

/// `extractSubstitutionsRaw`.
pub fn substitutions(text: &str) -> Vec<String> {
    let s: Vec<char> = text.chars().collect();
    let n = s.len();
    let mut st = ArithScan::new();
    let mut found = Vec::new();
    let (mut i, mut in_single, mut in_double) = (0usize, false, false);
    while i < n {
        let Some(c) = at(&s, i) else { break };
        let c2 = at(&s, i + 1);
        if !in_single
            && !in_double
            && c == '<'
            && c2 == Some('<')
            && let Some(h) = parse_heredoc_at(&s, i, &mut st)
        {
            if h.quoted {
                i = h.end;
            } else {
                i += h.opener_len;
                if at(&s, i) == Some('\n') {
                    i += 1;
                }
            }
            continue;
        }
        if in_single {
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if !in_double && c == '$' && c2 == Some('\'') {
            i += 2;
            while at(&s, i).is_some_and(|x| x != '\'') {
                i += if at(&s, i) == Some('\\') { 2 } else { 1 };
            }
            i += 1;
            continue;
        }
        if !in_double && c == '\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if c == '"' {
            in_double = !in_double;
            i += 1;
            continue;
        }
        if c == '$' && c2 == Some('(') {
            let (mut depth, mut j) = (1usize, i + 2);
            let mut inner = String::new();
            while j < n && depth > 0 {
                let Some(cj) = at(&s, j) else { break };
                if cj == '(' {
                    depth += 1;
                } else if cj == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                inner.push(cj);
                j += 1;
            }
            if !js_trim(&inner).is_empty() {
                found.push(inner);
            }
            i = j + 1;
            continue;
        }
        if c == '`' {
            let mut j = i + 1;
            let mut inner = String::new();
            while let Some(x) = at(&s, j).filter(|&x| x != '`') {
                inner.push(x);
                j += 1;
            }
            if !js_trim(&inner).is_empty() {
                found.push(inner);
            }
            i = j + 1;
            continue;
        }
        i += 1;
    }
    found
}

/// The `[ \t\n;&|]` test of a comment start: the character before an unquoted `#`.
fn word_start(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | ';' | '&' | '|')
}

struct Splitter {
    segments: Vec<String>,
    delims: Vec<&'static str>,
    cur: String,
}

impl Splitter {
    fn flush(&mut self, delim: &'static str) {
        if !js_trim(&self.cur).is_empty() {
            self.segments.push(std::mem::take(&mut self.cur));
            self.delims.push(delim);
        }
        self.cur.clear();
    }
}

/// `splitSegmentsDetailedRaw`: `(segments, delims)`, delims[i] being what terminated segments[i].
pub fn split_detailed(text: &str) -> (Vec<String>, Vec<&'static str>) {
    let cmd: Vec<char> = text.chars().collect();
    let n = cmd.len();
    let mut st = ArithScan::new();
    let mut sp = Splitter { segments: Vec::new(), delims: Vec::new(), cur: String::new() };
    let (mut i, mut in_single, mut in_double, mut in_tick) = (0usize, false, false, false);
    let mut nest: Vec<char> = Vec::new();
    let mut esc_end: i64 = -1;
    // the pending heredoc: (end of its opener line, end of its body)
    let mut heredoc: Option<(usize, usize)> = None;
    while i < n {
        if let Some((line_end, end)) = heredoc
            && i >= line_end
        {
            sp.flush("heredoc");
            i = i.max(end);
            heredoc = None;
            in_single = false;
            in_double = false;
            continue;
        }
        let Some(c) = at(&cmd, i) else { break };
        let c2 = at(&cmd, i + 1);
        if in_single {
            sp.cur.push(c);
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == '\\'
                && let Some(d) = c2
            {
                sp.cur.push(c);
                sp.cur.push(d);
                i += 2;
                continue;
            }
            sp.cur.push(c);
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        if c == '$' && c2 == Some('\'') {
            let mut j = i + 2;
            while at(&cmd, j).is_some_and(|x| x != '\'') {
                j += if at(&cmd, j) == Some('\\') { 2 } else { 1 };
            }
            j = (j + 1).min(n);
            sp.cur.extend(cmd.get(i..j).unwrap_or_default());
            i = j;
            continue;
        }
        if c == '\'' {
            in_single = true;
            sp.cur.push(c);
            i += 1;
            continue;
        }
        if c == '"' {
            in_double = true;
            sp.cur.push(c);
            i += 1;
            continue;
        }
        if c == '\\' && (c2 == Some('\n') || (c2 == Some('\r') && cmd.get(i + 2) == Some(&'\n'))) {
            sp.cur.push(' ');
            i += if c2 == Some('\r') { 3 } else { 2 };
            esc_end = i as i64;
            continue;
        }
        if c == '\\'
            && let Some(d) = c2
        {
            sp.cur.push(c);
            sp.cur.push(d);
            i += 2;
            esc_end = i as i64;
            continue;
        }
        if c == '#' && nest.is_empty() && !in_tick && esc_end != i as i64 && (i == 0 || at(&cmd, i - 1).is_some_and(word_start)) {
            i = cmd.get(i..).unwrap_or_default().iter().position(|&x| x == '\n').map_or(n, |p| p + i);
            continue;
        }
        if c == '<'
            && c2 == Some('<')
            && heredoc.is_none()
            && let Some(h) = parse_heredoc_at(&cmd, i, &mut st)
        {
            sp.cur.extend(cmd.get(i..h.opener_end).unwrap_or_default());
            i = h.opener_end;
            if let Some(le) = h.line_end {
                heredoc = Some((le, h.end));
            }
            continue;
        }
        if c == '&' && c2 == Some('&') {
            sp.flush("&&");
            i += 2;
            continue;
        }
        if c == '|' && c2 == Some('|') {
            sp.flush("||");
            i += 2;
            continue;
        }
        if c == '|' {
            sp.flush("|");
            i += 1;
            continue;
        }
        if c == ';' {
            sp.flush(";");
            i += 1;
            continue;
        }
        if c == '&' && ((esc_end != i as i64 && i > 0 && matches!(at(&cmd, i - 1), Some('>' | '<'))) || c2 == Some('>')) {
            sp.cur.push(c);
            i += 1;
            continue;
        }
        if c == '&' {
            sp.flush("&");
            i += 1;
            continue;
        }
        if c == '\n' {
            sp.flush("\n");
            i += 1;
            continue;
        }
        if matches!(c, ')' | '(' | '{' | '}') {
            if c == '(' || c == '{' {
                nest.push(c);
            } else if nest.last() == Some(&(if c == ')' { '(' } else { '{' })) {
                nest.pop();
            }
            sp.flush("group");
            i += 1;
            continue;
        }
        if c == '$' && c2 == Some('(') {
            nest.push('(');
            sp.flush("subst");
            i += 2;
            continue;
        }
        if c == '`' {
            in_tick = !in_tick;
            sp.flush("subst");
            i += 1;
            continue;
        }
        if c == '$' && c2 == Some('[') {
            nest.push('[');
            sp.cur.push_str("$[");
            i += 2;
            continue;
        }
        if c == '[' && nest.last() == Some(&'[') {
            nest.push('[');
        } else if c == ']' && nest.last() == Some(&'[') {
            nest.pop();
        }
        sp.cur.push(c);
        i += 1;
    }
    sp.flush("end");
    (sp.segments, sp.delims)
}

/// Add the shell scanners to `ahHost`.
pub fn install<'a>(c: &Ctx<'a>, h: &Object<'a>) -> rquickjs::Result<()> {
    h.set("shellTokenize", Function::new(c.clone(), |s: String| tokenize(&s))?)?;
    h.set("shellSubstitutions", Function::new(c.clone(), |s: String| substitutions(&s))?)?;
    h.set(
        "shellSplit",
        Function::new(c.clone(), |s: String| -> Vec<Vec<String>> {
            let (segments, delims) = split_detailed(&s);
            vec![segments, delims.into_iter().map(str::to_string).collect()]
        })?,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// What `scannersWith` returns for one command, computed by the native functions directly.
    fn native(cmd: &str) -> Value {
        let (segments, delims) = split_detailed(cmd);
        let mut subs: Vec<Vec<String>> = Vec::new();
        let mut queue = vec![cmd.to_string()];
        let mut k = 0;
        while k < queue.len() && k < 64 {
            let f = substitutions(&queue[k]);
            queue.extend(f.iter().cloned());
            subs.push(f);
            k += 1;
        }
        let tokens: Vec<Vec<String>> = segments.iter().map(|s| tokenize(s)).collect();
        json!({"segments": segments, "delims": delims, "tokens": tokens, "subs": subs})
    }

    /// Commands the reference walks and the native ones must read the same: each a quoting, comment, heredoc, substitution or
    /// arithmetic corner of the shell grammar the scanners model.
    const FIXTURES: &[&str] = &[
        "",
        " ",
        "ls -la",
        "cd app && npm test | tail -5; echo done",
        "echo 'a ; b' \"c && d\" e\\ f",
        "git commit -m \" ; npm test ; echo \"",
        "git commit -m \\\" ; npm test ; echo \\\"",
        "x=$'a\\' # '; go build",
        "echo $(npm run build) `ls` \"$(a)\" '$(b)'",
        "echo $(echo $(a (b) c) d) e",
        "echo $(unterminated",
        "echo `unterminated",
        "cat <<EOF | git commit -F -\nbody $(not run) `x`\nEOF\nnpm test",
        "cat <<'EOF'\n$(quoted)\nEOF\necho $(after)",
        "cat <<-EOF\n\tbody\n\tEOF\nls",
        "cat <<EOF\nno terminator",
        "cat <<EOF",
        "echo $((1<<2)) && echo <<<here",
        "echo $(( a << b )) ; cat <<X\nz\nX",
        "a # comment ; b\nc",
        "a#b ; c $#x ${#y} z",
        "echo ${x:- #} ; ls",
        "echo `# not a comment` ; ls",
        "echo a\\\nb && c",
        "echo a\\\r\nb",
        "x 2>&1 | tail ; y &> f ; z >&2 ; w <&3 ; q & r",
        "x \\>& y",
        "(a; b) && { c; d; }",
        "echo $[ 1 # 2 ] ; ls",
        "echo $[ $[ 1 ] ] && x",
        "echo é 😀 \"é\" 'é' | cat",
        "echo '😀' $'😀\\'' x",
        "\t  leading  \n  trailing  \t",
        "echo \u{a0}nbsp\u{2003}em\u{feff}bom",
        "a \\",
        "a \"b \\\" c\" d",
        "a 'b",
        "a \"b",
        "$'",
        "$'abc",
        "$(",
        "`",
        "<<",
        "<<<",
        "<<-",
        "cat <<\"E O\"\nx\nE O\n",
        "cat <<E\\OF\nx\nEOF\n",
        "cat <<$VAR\nx\n",
        "bash -c 'echo $(ls)' ; eval \"npm test\"",
    ];

    /// A deterministic mix of shell-ish fragments: `n` strings of up to `max` fragments.
    fn generated(n: usize, max: usize) -> Vec<String> {
        const PARTS: &[&str] = &[
            "a", "b", "ls", " ", "\t", "\n", "\r", "'", "\"", "\\", "$(", ")", "(", "{", "}", "`", "#", ";", "&", "&&", "|", "||", "<<", "<<-", "<", "<<<",
            ">", "EOF", "'EOF'", "$'", "$[", "]", "[", "((", "))", "$((", "é", "😀", "\\\n", " # ", "2>&1", "&>", "x=1", "\u{a0}", "$", "-c",
        ];
        let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
        let mut next = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        (0..n)
            .map(|_| {
                let k = 1 + (next() as usize % max);
                (0..k).map(|_| PARTS[next() as usize % PARTS.len()]).collect::<String>()
            })
            .collect()
    }

    /// Run the reference (JS) and the host-backed script entries and the direct native functions over `cmds`; the commands that differ.
    fn differences(cmds: &[String]) -> Vec<String> {
        let mut bad = Vec::new();
        let mut at = 0;
        while at < cmds.len() {
            // a chunk bounded by size: one script call has a time limit
            let mut end = at;
            let mut bytes = 0;
            while end < cmds.len() && (end == at || bytes + cmds[end].len() < 24_000) && end - at < 200 {
                bytes += cmds[end].len();
                end += 1;
            }
            let chunk = &cmds[at..end];
            let args = json!({"cmds": chunk});
            let reference = crate::script::call_fn("command", "scannersReference", &args).expect("reference entry answered");
            let via_host = crate::script::call_fn("command", "scannersNative", &args).expect("native entry answered");
            for (k, cmd) in chunk.iter().enumerate() {
                let direct = native(cmd);
                if reference[k] != via_host[k] || reference[k] != direct {
                    bad.push(format!("{cmd:?}\n  js:     {}\n  host:   {}\n  direct: {direct}", reference[k], via_host[k]));
                }
            }
            at = end;
        }
        bad
    }

    fn report(bad: &[String], total: usize, what: &str) {
        assert!(bad.is_empty(), "{} of {total} {what} differ; first:\n{}", bad.len(), bad.iter().take(3).cloned().collect::<Vec<_>>().join("\n"));
    }

    #[test]
    fn the_native_scanners_equal_the_reference_walks_on_the_fixtures_and_generated_commands() {
        let mut cmds: Vec<String> = FIXTURES.iter().map(|s| s.to_string()).collect();
        cmds.extend(generated(3000, 24));
        report(&differences(&cmds), cmds.len(), "fixture and generated commands");
    }

    /// The commands of the frozen replay sample (PreToolUse Bash) and of the real-command corpus; the paths are
    /// `AH_SCANNER_CORPORA` (colon separated), else the two default work files. Absent files are skipped: the always-run test
    /// above is the gate, this one is the zero-difference proof on real commands.
    #[test]
    fn the_native_scanners_equal_the_reference_walks_on_the_replay_and_real_command_corpora() {
        let home = std::env::var("HOME").unwrap_or_default();
        let paths = std::env::var("AH_SCANNER_CORPORA")
            .unwrap_or_else(|_| format!("{home}/.anti-hall/work/replay/sample-frozen.ndjson:{home}/.anti-hall/work/fpr/cmds.jsonl"));
        let mut cmds: Vec<String> = Vec::new();
        for p in paths.split(':').filter(|p| !p.is_empty()) {
            let Ok(text) = std::fs::read_to_string(p) else {
                eprintln!("corpus {p} absent: skipped");
                continue;
            };
            for line in text.lines() {
                let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
                let cmd = v.pointer("/payload/tool_input/command").or_else(|| v.get("cmd")).and_then(Value::as_str);
                if let Some(c) = cmd {
                    cmds.push(c.to_string());
                }
            }
        }
        eprintln!("corpus commands: {}", cmds.len());
        report(&differences(&cmds), cmds.len(), "corpus commands");
    }
}
