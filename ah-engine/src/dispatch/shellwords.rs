//! #907: shell-word normalisation for `dispatch.capacity_hold`, std only. One file, two crates: ah-engine (src/dispatch/shellwords.rs)
//! and ah-launcher (src/shellwords.rs) carry byte-identical copies (a test in ah-engine holds them equal), so both matchers read a
//! command the way the shell does before the hold rules see it.
//!
//! What it does: strips in-word quotes and backslashes (`g"i"t pu\sh` becomes `git push`), splits on UNQUOTED separators only (a
//! quoted `;` `&` `|` or newline inside an argument becomes a space, so it neither ends a command nor hides one), blanks the free text
//! a gh pr/issue/release command publishes (its body, title or notes value), and finds a git subcommand that is not a known one (an
//! alias or an external command). It carries no list of its own: every word list comes in through [`Cfg`], read from the plugin's
//! `dispatch.capacity_hold` table.
//!
//! The review of #907 added what the shell does that a word list misses: an unquoted `#` at the start of a word comments out the
//! rest of its line (a quote in a comment opens nothing), a heredoc body is data up to its delimiter line (its quotes open nothing,
//! its `$(..)` still runs when the delimiter is unquoted), `<(..)` and `>(..)` run a command, `$"..."` is a quoted word, `\u`/`\U` spell a
//! character in `$'..'`, a brace list `{a,b}` expands to words, a command can open with `(` `{` `!` `$(` or a backtick, and the
//! joined words are read again (`Cfg::passes` times) so a string a nested shell runs (`sh -c '..'`, `eval "..."`, `env -S '..'`) is
//! read like a command too.

/// The word lists the normaliser reads, all from the plugin's config (empty = that step does nothing).
#[derive(Default, Clone)]
pub struct Cfg {
    /// The command whose text values are data (`gh`), the subcommands that publish text (`pr`, `issue`, `release`) and the options that
    /// carry it (`--body`, `--title`, ...; the `--opt=value` spelling too).
    pub text_verb: String,
    /// The subcommands of `text_verb` that publish text.
    pub text_subs: Vec<String>,
    /// The options whose value is that text.
    pub text_opts: Vec<String>,
    /// The hold rule a git subcommand outside `git_known` falls under (empty = off), the subcommands git itself defines (an alias can
    /// not shadow them), the global options that take their value as the next word, and the words that run another command (a git
    /// behind one of them is still a git command).
    pub git_rule: String,
    /// The subcommands git itself defines.
    pub git_known: Vec<String>,
    /// The global options that take their value as the next word.
    pub git_opts_with_arg: Vec<String>,
    /// The words that run another command.
    pub git_wrappers: Vec<String>,
    /// How many times the joined words are read again (a string a nested shell runs is a command too); 0 = once only.
    pub passes: usize,
    /// The most words one brace list expands to (0 = brace lists are not expanded).
    pub brace_cap: usize,
    /// How deep a heredoc body's substitutions are read as commands (0 = not at all).
    pub body_depth: usize,
}

/// A command read the shell's way.
pub struct Normalised {
    /// The words joined by one space, the unquoted separators kept as they were, quotes and backslashes gone.
    pub text: String,
    /// True when a gh text value was blanked out of `text`.
    pub stripped: bool,
    /// The first git subcommand that is not in `git_known` (an alias, an external command, a typo), if any.
    pub git_unknown: Option<String>,
    /// More texts the rules match: each re-reading of the joined words, and the commands a heredoc body substitutes.
    pub extra: Vec<String>,
}

enum Tok {
    /// The word with quoted separators blanked, whether it can run something, and its value as the shell passes it on (quotes
    /// removed, nothing blanked: what a nested shell would read).
    Word(String, bool, String),
    Sep(&'static str),
    /// A heredoc body (its delimiter line kept) and whether it can run something (an unquoted delimiter and a substitution).
    Body(String, bool),
}

/// A brace list `pre{a,b}post` expanded the way bash does (nested lists too), at most `cap` words; a word with no list is itself.
fn braces(word: &str, cap: usize) -> Vec<String> {
    let cs: Vec<char> = word.chars().collect();
    for (open, _) in cs.iter().enumerate().filter(|(_, c)| **c == '{') {
        let (mut depth, mut commas, mut close) = (0usize, Vec::new(), None);
        for (k, c) in cs.iter().enumerate().skip(open) {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        close = Some(k);
                        break;
                    }
                }
                ',' if depth == 1 => commas.push(k),
                _ => {}
            }
        }
        let Some(close) = close else { continue };
        if commas.is_empty() {
            continue;
        }
        let (pre, post): (String, String) = (cs[..open].iter().collect(), cs[close + 1..].iter().collect());
        let mut out = Vec::new();
        let mut from = open + 1;
        for to in commas.into_iter().chain(std::iter::once(close)) {
            let alt: String = cs[from..to].iter().collect();
            for w in braces(&format!("{pre}{alt}{post}"), cap) {
                if out.len() < cap {
                    out.push(w);
                }
            }
            from = to + 1;
        }
        return out;
    }
    vec![word.to_string()]
}

/// A quoted or escaped separator character is data: a space stands in for it, so it can not end or hide a command.
fn lit(out: &mut String, c: char) {
    out.push(if matches!(c, ';' | '&' | '|' | '\n' | '\r') { ' ' } else { c });
}

/// A heredoc opening at `cs[i]` (`<<`, not the here-string `<<<`): its delimiter, `<<-` (leading tabs dropped), and whether the
/// delimiter is quoted (the body then runs nothing).
fn heredoc_at(cs: &[char], i: usize) -> Option<(String, bool, bool)> {
    if cs.get(i) != Some(&'<') || cs.get(i + 1) != Some(&'<') || cs.get(i + 2) == Some(&'<') || (i > 0 && cs[i - 1] == '<') {
        return None;
    }
    let mut j = i + 2;
    let tabs = cs.get(j) == Some(&'-');
    if tabs {
        j += 1;
    }
    while matches!(cs.get(j), Some(' ' | '\t')) {
        j += 1;
    }
    let (mut delim, mut quoted) = (String::new(), false);
    while let Some(&d) = cs.get(j) {
        if d.is_whitespace() || matches!(d, ';' | '|' | '&' | '<' | '>' | '(' | ')') {
            break;
        }
        if matches!(d, '\'' | '"' | '\\') {
            quoted = true;
        } else {
            delim.push(d);
        }
        j += 1;
    }
    (!delim.is_empty()).then_some((delim, tabs, quoted))
}

/// The bodies of the heredocs a line opened, read from `*i` (just past that line's newline) up to each delimiter line: each body
/// (its delimiter line kept) and whether it can run something.
fn heredoc_bodies(cs: &[char], i: &mut usize, opened: Vec<(String, bool, bool)>) -> Vec<(String, bool)> {
    let n = cs.len();
    let mut out = Vec::new();
    for (delim, tabs, quoted) in opened {
        let mut body = String::new();
        while *i < n {
            let end = cs[*i..].iter().position(|d| *d == '\n').map_or(n, |p| *i + p);
            let line: String = cs[*i..end].iter().collect();
            *i = (end + 1).min(n);
            body.push_str(&line);
            if (if tabs { line.trim_start_matches('\t') } else { line.as_str() }) == delim {
                break;
            }
            body.push('\n');
        }
        let runs = !quoted && (body.contains("$(") || body.contains('`') || body.contains("${"));
        out.push((body, runs));
    }
    out
}

/// Where a substitution that opens at `cs[i]` (`$(` or a backtick) ends: the index just past its closing `)` or backtick. Inside it
/// a new quoting context starts, as in the shell (`"$(echo ")")"` is one word): quotes, escapes, nested parentheses, comments,
/// arithmetic and heredoc bodies are skipped. `None` when it does not close.
fn sub_end(cs: &[char], i: usize) -> Option<usize> {
    if cs.get(i) == Some(&'`') {
        let mut j = i + 1;
        loop {
            match *cs.get(j)? {
                '\\' => j += 2,
                '`' => return Some(j + 1),
                _ => j += 1,
            }
        }
    }
    let (mut j, mut depth, mut arith) = (i + 2, 1usize, 0usize);
    let mut pending: Vec<(String, bool, bool)> = Vec::new();
    loop {
        let c = *cs.get(j)?;
        let start = j == i + 2 || matches!(cs[j - 1], ' ' | '\t' | '\n' | ';' | '|' | '&' | '(');
        match c {
            '\\' => j += 2,
            '\'' => {
                j += 1;
                while *cs.get(j)? != '\'' {
                    j += 1;
                }
                j += 1;
            }
            '"' => {
                j += 1;
                loop {
                    match *cs.get(j)? {
                        '\\' => j += 2,
                        '"' => break,
                        '$' if cs.get(j + 1) == Some(&'(') => j = sub_end(cs, j)?,
                        '`' => j = sub_end(cs, j)?,
                        _ => j += 1,
                    }
                }
                j += 1;
            }
            '`' => j = sub_end(cs, j)?,
            '#' if start => {
                while j < cs.len() && cs[j] != '\n' {
                    j += 1;
                }
            }
            '\n' => {
                j += 1;
                heredoc_bodies(cs, &mut j, std::mem::take(&mut pending));
            }
            '(' => {
                if cs.get(j + 1) == Some(&'(') && (start || cs[j - 1] == '$') {
                    arith += 1;
                }
                depth += 1;
                j += 1;
            }
            ')' => {
                if arith > 0 && cs.get(j + 1) == Some(&')') {
                    arith -= 1;
                }
                depth -= 1;
                j += 1;
                if depth == 0 {
                    return Some(j);
                }
            }
            '<' if arith == 0 => {
                if let Some(h) = heredoc_at(cs, j) {
                    pending.push(h);
                }
                j += 1;
            }
            _ => j += 1,
        }
    }
}

/// Splits `cmd` into words and unquoted separators. `None` when a quote or a substitution is left open (the caller holds the call
/// under `unreadable`). A word is "live" when it holds a substitution (`$(..)`, `${..}`, a backtick, `<(..)`, `>(..)`) outside single
/// quotes: it can run something.
#[allow(unused_assignments)] // the last flush! resets state nothing reads
fn split(cmd: &str, cfg: &Cfg) -> Option<Vec<Tok>> {
    let cs: Vec<char> = cmd.chars().collect();
    let n = cs.len();
    let mut toks: Vec<Tok> = Vec::new();
    // cur: the word with quoted separators blanked; raw: its value as the shell passes it on
    let (mut cur, mut raw, mut live, mut in_word, mut brace) = (String::new(), String::new(), false, false, false);
    let mut pending: Vec<(String, bool, bool)> = Vec::new();
    let mut arith = 0usize;
    let mut i = 0;
    macro_rules! put {
        ($c:expr) => {{
            let c: char = $c;
            lit(&mut cur, c);
            raw.push(c);
        }};
    }
    macro_rules! flush {
        () => {
            if in_word {
                let (w, r) = (std::mem::take(&mut cur), std::mem::take(&mut raw));
                if brace && cfg.brace_cap > 0 {
                    for (k, w) in braces(&w, cfg.brace_cap).into_iter().enumerate() {
                        toks.push(Tok::Word(w, live, if k == 0 { r.clone() } else { String::new() }));
                    }
                } else {
                    toks.push(Tok::Word(w, live, r));
                }
                live = false;
                in_word = false;
                brace = false;
            }
        };
    }
    while i < n {
        let c = cs[i];
        let next = cs.get(i + 1).copied();
        match c {
            ' ' | '\t' | '\r' => {
                flush!();
                i += 1;
            }
            // a comment: the rest of the line is no command, and a quote in it opens nothing
            '#' if !in_word => {
                while i < n && cs[i] != '\n' {
                    i += 1;
                }
            }
            // $"..." is a (translated) double-quoted word
            '$' if next == Some('"') => {
                in_word = true;
                i += 1;
            }
            '\\' => {
                match next {
                    Some('\n') => {}
                    Some(d) => {
                        in_word = true;
                        put!(d);
                    }
                    None => {}
                }
                i += 2;
            }
            '\'' => {
                in_word = true;
                i += 1;
                loop {
                    let d = *cs.get(i)?;
                    i += 1;
                    if d == '\'' {
                        break;
                    }
                    put!(d);
                }
            }
            '"' => {
                in_word = true;
                i += 1;
                loop {
                    let d = *cs.get(i)?;
                    match d {
                        '"' => {
                            i += 1;
                            break;
                        }
                        '\\' => {
                            i += 1;
                            match cs.get(i).copied() {
                                Some(e @ ('$' | '`' | '"' | '\\')) => {
                                    put!(e);
                                    i += 1;
                                }
                                Some('\n') => i += 1,
                                _ => put!('\\'),
                            }
                        }
                        // a substitution opens a new quoting context: copied as written, up to its close
                        '`' | '$' if d == '`' || cs.get(i + 1) == Some(&'(') => {
                            live = true;
                            let end = sub_end(&cs, i)?;
                            for &e in &cs[i..end] {
                                cur.push(e);
                                raw.push(e);
                            }
                            i = end;
                        }
                        '$' => {
                            if cs.get(i + 1) == Some(&'{') {
                                live = true;
                            }
                            put!(d);
                            i += 1;
                        }
                        _ => {
                            put!(d);
                            i += 1;
                        }
                    }
                }
            }
            '$' if next == Some('\'') => {
                // ANSI-C quoting: the escapes a command word is spelled with are decoded
                in_word = true;
                i += 2;
                loop {
                    let d = *cs.get(i)?;
                    i += 1;
                    match d {
                        '\'' => break,
                        '\\' => {
                            let e = *cs.get(i)?;
                            i += 1;
                            match e {
                                'n' => put!('\n'),
                                't' => put!('\t'),
                                'r' => put!('\r'),
                                'u' | 'U' => {
                                    let (mut v, mut k) = (0u32, 0);
                                    while k < if e == 'u' { 4 } else { 8 } {
                                        match cs.get(i).and_then(|h| h.to_digit(16)) {
                                            Some(h) => {
                                                v = v.wrapping_mul(16).wrapping_add(h);
                                                i += 1;
                                                k += 1;
                                            }
                                            None => break,
                                        }
                                    }
                                    put!(char::from_u32(v).unwrap_or(' '));
                                }
                                'x' | '0'..='7' => {
                                    let radix = if e == 'x' { 16 } else { 8 };
                                    let mut v = if e == 'x' { 0 } else { e.to_digit(8).unwrap_or(0) };
                                    let mut k = 0;
                                    while k < 2 {
                                        match cs.get(i).and_then(|h| h.to_digit(radix)) {
                                            Some(h) => {
                                                v = v * radix + h;
                                                i += 1;
                                                k += 1;
                                            }
                                            None => break,
                                        }
                                    }
                                    put!(char::from_u32(v).unwrap_or(' '));
                                }
                                other => put!(other),
                            }
                        }
                        _ => put!(d),
                    }
                }
            }
            ';' | '\n' => {
                flush!();
                toks.push(Tok::Sep(if c == ';' { ";" } else { "\n" }));
                i += 1;
                // the bodies of the heredocs this line opened: data up to each delimiter line
                if c == '\n' {
                    for (body, runs) in heredoc_bodies(&cs, &mut i, std::mem::take(&mut pending)) {
                        toks.push(Tok::Body(body, runs));
                        toks.push(Tok::Sep("\n"));
                    }
                }
            }
            '|' => {
                if i > 0 && cs[i - 1] == '>' && in_word {
                    cur.push('|');
                    raw.push('|');
                    i += 1;
                } else {
                    flush!();
                    match next {
                        Some('|') => {
                            toks.push(Tok::Sep("||"));
                            i += 2;
                        }
                        Some('&') => {
                            toks.push(Tok::Sep("|&"));
                            i += 2;
                        }
                        _ => {
                            toks.push(Tok::Sep("|"));
                            i += 1;
                        }
                    }
                }
            }
            '&' => {
                if next == Some('&') {
                    flush!();
                    toks.push(Tok::Sep("&&"));
                    i += 2;
                } else if (i > 0 && matches!(cs[i - 1], '>' | '<') && in_word) || next == Some('>') {
                    in_word = true;
                    cur.push('&');
                    raw.push('&');
                    i += 1;
                } else {
                    flush!();
                    toks.push(Tok::Sep("&"));
                    i += 1;
                }
            }
            _ => {
                // arithmetic ($(( )) or (( ))): its << is a shift, not a heredoc
                if c == '(' && next == Some('(') && (!in_word || cur.ends_with('$')) {
                    arith += 1;
                } else if c == ')' && next == Some(')') && arith > 0 {
                    arith -= 1;
                }
                in_word = true;
                if c == '`' || (matches!(c, '$' | '<' | '>') && matches!(next, Some('(' | '{')) && (c == '$' || next == Some('('))) {
                    live = true;
                }
                if c == '{' && (i == 0 || cs[i - 1] != '$') {
                    brace = true;
                }
                if arith == 0 {
                    if let Some(h) = heredoc_at(&cs, i) {
                        pending.push(h);
                    }
                }
                cur.push(c);
                raw.push(c);
                i += 1;
            }
        }
    }
    flush!();
    Some(toks)
}

fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

fn is_assign(word: &str) -> bool {
    word.split_once('=')
        .is_some_and(|(k, _)| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !k.starts_with(|c: char| c.is_ascii_digit()))
}

/// The word a command starts at, with what opens it dropped: a grouping or a substitution (`(` `{` `!` `$(` a backtick `<(`) and
/// the name of an assignment whose value is one (`x=$(git ..`). `None` for a plain assignment (`x=git` runs nothing).
fn opener(word: &str) -> Option<(&str, bool)> {
    let v = if is_assign(word) { word.split_once('=').map_or("", |x| x.1) } else { word };
    let w = v.trim_start_matches(['(', '{', '!', '$', '`', '<', '>']);
    let opened = w.len() != v.len();
    (opened || !is_assign(word)).then_some((w, opened))
}

/// The body of a word that is one whole substitution (`$(..)`, `<(..)`, `>(..)` or a backtick pair), else the word itself.
fn unwrap_sub(w: &str) -> &str {
    let mut cs = w.chars();
    let inner = match (cs.next(), cs.next()) {
        (Some('`'), _) => w[1..].strip_suffix('`'),
        (Some('$' | '<' | '>'), Some('(')) => w[2..].strip_suffix(')'),
        _ => None,
    };
    inner.unwrap_or(w)
}

/// Reads `cmd` the way the shell does. `None` when a quote is left open: the caller then matches the raw text only.
pub fn normalise(cmd: &str, cfg: &Cfg) -> Option<Normalised> {
    let (mut n, mut nested) = once(cmd, cfg, 0)?;
    // a word with a space in it can be a string a nested shell runs (sh -c '..', eval "...", env -S '..', git -c core.pager='..',
    // "$(..)"): it is read as a command too, `passes` levels deep
    for _ in 0..cfg.passes {
        let mut next = Vec::new();
        for w in nested.drain(..) {
            // a substitution's body is the command (`"$(git pf)"`)
            let body = unwrap_sub(&w);
            let Some((m, more)) = once(body, cfg, 1) else { continue };
            if n.git_unknown.is_none() {
                n.git_unknown = m.git_unknown;
            }
            n.extra.push(m.text);
            n.extra.extend(m.extra);
            next.extend(more);
        }
        if next.is_empty() {
            break;
        }
        nested = next;
    }
    Some(n)
}

/// One reading of `cmd`, and its words that hold a space (read again by [`normalise`]).
fn once(cmd: &str, cfg: &Cfg, depth: usize) -> Option<(Normalised, Vec<String>)> {
    let toks = split(cmd, cfg)?;
    let (mut text, mut stripped, mut git_unknown, mut extra) = (String::new(), false, None, Vec::new());
    let mut nested: Vec<String> = Vec::new();
    let mut group: Vec<(String, bool, String)> = Vec::new();
    let emit = |group: &mut Vec<(String, bool, String)>, text: &mut String, stripped: &mut bool, git_unknown: &mut Option<String>, nested: &mut Vec<String>| {
        if group.is_empty() {
            return;
        }
        // gh <pr|issue|release> ...: the value words of the text options are data
        if !cfg.text_verb.is_empty() {
            if let Some(v) = group.iter().position(|(w, ..)| base(w) == cfg.text_verb) {
                let sub = group[v + 1..].iter().map(|(w, ..)| w.as_str()).find(|w| cfg.text_subs.iter().any(|s| s == w) || *w == "api");
                if sub.is_some_and(|s| s != "api") {
                    let mut k = v + 1;
                    while k < group.len() {
                        let w = group[k].0.clone();
                        if cfg.text_opts.iter().any(|o| *o == w) {
                            if let Some(val) = group.get_mut(k + 1) {
                                if !val.1 && !val.0.is_empty() {
                                    val.0.clear();
                                    *stripped = true;
                                }
                            }
                            k += 2;
                            continue;
                        }
                        if let Some(o) = cfg.text_opts.iter().find(|o| o.starts_with("--") && w.starts_with(&format!("{o}="))) {
                            if !group[k].1 && w.len() > o.len() + 1 {
                                group[k].0 = format!("{o}=");
                                *stripped = true;
                            }
                        }
                        k += 1;
                    }
                }
            }
        }
        if git_unknown.is_none() && !cfg.git_rule.is_empty() {
            let wrapper = |w: &str| cfg.git_wrappers.iter().any(|x| x.eq_ignore_ascii_case(base(w)));
            for j in 0..group.len() {
                // git spelled in any case runs git on a case-insensitive file system
                let Some((w, opened)) = opener(&group[j].0) else { continue };
                if !base(w).eq_ignore_ascii_case("git") {
                    continue;
                }
                let at_command = opened || group[..j].iter().all(|(w, ..)| is_assign(w)) || group[..j].iter().any(|(w, ..)| wrapper(w));
                if !at_command {
                    continue;
                }
                let mut k = j + 1;
                while k < group.len() {
                    let w = group[k].0.trim_end_matches([')', '`', '}']);
                    if cfg.git_opts_with_arg.iter().any(|o| o == w) {
                        k += 2;
                    } else if w.starts_with('-') || w.is_empty() {
                        k += 1;
                    } else {
                        if !cfg.git_known.iter().any(|s| s == w) {
                            *git_unknown = Some(w.to_string());
                        }
                        break;
                    }
                }
                if git_unknown.is_some() {
                    break;
                }
            }
        }
        for (w, _, r) in group.iter() {
            if w.is_empty() {
                continue;
            }
            // what a nested shell would read: the value as passed on, its quoted newlines and separators intact
            if r.contains(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|')) {
                nested.push(r.clone());
            }
            if !text.is_empty() && !text.ends_with(['\n', ' ']) {
                text.push(' ');
            }
            text.push_str(w);
        }
        group.clear();
    };
    for t in toks {
        match t {
            Tok::Word(w, live, r) => group.push((w, live, r)),
            Tok::Body(b, runs) => {
                emit(&mut group, &mut text, &mut stripped, &mut git_unknown, &mut nested);
                // the body is data (matched as written); what it substitutes runs, so that is read as a command, once as written
                // and once with its quotes and comment marks blanked (they are literal in a body, so they hide nothing there)
                if runs && depth < cfg.body_depth {
                    let plain: String = b.chars().map(|c| if matches!(c, '\'' | '"' | '#') { ' ' } else { c }).collect();
                    for (m, more) in [once(&b, cfg, depth + 1), once(&plain, cfg, depth + 1)].into_iter().flatten() {
                        if git_unknown.is_none() {
                            git_unknown = m.git_unknown;
                        }
                        extra.push(m.text);
                        extra.extend(m.extra);
                        nested.extend(more);
                    }
                }
                text.push_str(&b);
            }
            Tok::Sep(s) => {
                emit(&mut group, &mut text, &mut stripped, &mut git_unknown, &mut nested);
                if !text.is_empty() && !text.ends_with(['\n', ' ']) {
                    text.push(' ');
                }
                text.push_str(s);
                if s != "\n" {
                    text.push(' ');
                }
            }
        }
    }
    emit(&mut group, &mut text, &mut stripped, &mut git_unknown, &mut nested);
    Some((Normalised { text, stripped, git_unknown, extra }, nested))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Cfg {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        Cfg {
            text_verb: "gh".into(),
            text_subs: v(&["pr", "issue", "release"]),
            text_opts: v(&["--body", "-b", "--title", "-t", "--body-file", "--notes"]),
            git_rule: "git-unknown-subcommand".into(),
            git_known: v(&["status", "log", "commit"]),
            git_opts_with_arg: v(&["-C", "-c"]),
            git_wrappers: v(&["sudo", "env", "time", "if", "{"]),
            passes: 3,
            brace_cap: 64,
            body_depth: 2,
        }
    }
    fn n(c: &str) -> Normalised {
        normalise(c, &cfg()).unwrap_or_else(|| panic!("balanced: {c}"))
    }

    #[test]
    fn quotes_and_backslashes_inside_a_word_are_dropped() {
        assert_eq!(n("g\"i\"t pu'sh' -f").text, "git push -f");
        assert_eq!(n("r\\m -rf x").text, "rm -rf x");
        assert_eq!(n("$'g\\x69t' push").text, "git push");
    }

    #[test]
    fn a_quoted_separator_is_data_and_an_unquoted_one_splits() {
        assert_eq!(n("git -C \"a;b\" status").text, "git -C a b status");
        assert_eq!(n("echo 'x | y' ; ls").text, "echo x   y ; ls");
        assert_eq!(n("a && b || c | d").text, "a && b || c | d");
        assert_eq!(n("ls 2>&1 >out").text, "ls 2>&1 >out");
    }

    #[test]
    fn an_open_quote_is_not_normalised() {
        assert!(normalise("echo 'x", &cfg()).is_none());
        assert!(normalise("echo \"x", &cfg()).is_none());
    }

    #[test]
    fn gh_text_values_are_blanked_but_the_command_words_stay() {
        let r = n("gh issue create --title t --body \"a; git push -f\"");
        assert!(r.stripped);
        assert_eq!(r.text, "gh issue create --title --body");
        assert_eq!(n("gh pr merge 1 --body=\"x git push\"").text, "gh pr merge 1 --body=");
        assert!(!n("gh api repos/o/r -f body=x").stripped);
        assert!(!n("gh issue create --body \"$(git push -f)\"").stripped, "a value that runs something stays live");
        assert!(!n("echo --body 'git push'").stripped, "only a gh command's values are data");
    }

    #[test]
    fn a_git_subcommand_outside_the_known_ones_is_found() {
        assert_eq!(n("git pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("git -C /r -c a=b pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("FOO=1 /usr/bin/git pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("sudo git pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("git status && git zz").git_unknown.as_deref(), Some("zz"));
        assert_eq!(n("git status").git_unknown, None);
        assert_eq!(n("git").git_unknown, None);
        assert_eq!(n("ls ~/git foo").git_unknown, None, "git as an argument is not a git command");
    }

    #[test]
    fn review_907_what_the_shell_does_that_a_word_list_misses() {
        // a comment: its quote opens nothing, so the next line is a command
        assert_eq!(n("echo x #'\ngit push -f\n: #'").text, "echo x \ngit push -f \n:");
        // a heredoc body is data to its delimiter line: its quote hides nothing after it
        let h = n("cat <<EOF\ngh pr view 1 -b '\nEOF\ngit push -f");
        assert!(h.text.contains("\ngit push -f"), "{}", h.text);
        assert!(!h.stripped);
        // what an unquoted heredoc substitutes runs
        assert_eq!(n("cat <<EOF\n$(git pf)\nEOF").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("cat <<'EOF'\n$(git pf)\nEOF").git_unknown, None);
        // <( ) runs: a gh text value that is one is not data
        assert!(!n("gh pr view 1 --body-file <(git push -f)").stripped);
        // $"..", \u and \U, brace lists
        assert_eq!(n("$\"git\" pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("$'\\u0067it' push").text, "git push");
        assert_eq!(n("$'\\U00000067it' push").text, "git push");
        assert_eq!(n("{rm,-rf,/x}").text, "rm -rf /x");
        assert_eq!(n("gh pr {merge,1}").text, "gh pr merge 1");
        assert_eq!(n("echo \"{a,b}\" ${x,,}").text, "echo {a,b} ${x,,}");
        // a command opened by a grouping or a substitution, git in any case, a nested shell's string
        for c in ["(git pf)", "{ git pf; }", "if git pf; then :; fi", "x=$(git pf)", "echo `git pf`", "GIT pf", "echo \"$(git pf)\"", "env -S 'git pf'"] {
            assert_eq!(n(c).git_unknown.as_deref(), Some("pf"), "{c}");
        }
        assert!(n("bash -c 'g\"i\"t reset --hard'").extra.iter().any(|t| t.contains("git reset --hard")));
        for c in ["echo $(git log -1 --format=%H)", "echo \"$(git status)\"", "x=$(git log -1)", "x=git ls"] {
            assert_eq!(n(c).git_unknown, None, "{c}");
        }
    }

    #[test]
    fn review_918_second_pass() {
        // an arithmetic shift is no heredoc: the next line is still read
        assert!(n("echo $((1<<2))\ng\"i\"t reset --hard").text.contains("git reset --hard"));
        assert!(n("(( n = 1 << 2 ))\ng\"i\"t reset --hard").text.contains("git reset --hard"));
        // a nested shell keeps the quoted newline: the comment ends at it
        for c in ["bash -c 'echo x #\ng\"i\"t reset --hard'", "echo `#'\ng\"i\"t reset --hard\n: #'`", "echo $(#'\ng\"i\"t reset --hard\n: #')\n)"] {
            assert!(n(c).extra.iter().any(|t| t.contains("git reset --hard")), "{c}");
        }
        // a substitution inside double quotes opens a new quoting context
        assert!(normalise("g\"i\"t reset --hard; echo \"$(echo \"'\")\"", &cfg()).is_some());
        assert!(normalise("git commit -m \"$(cat <<'EOF'\nfix: don't\nEOF\n)\"", &cfg()).is_some());
        assert!(normalise("echo \"$(git log -1 --format=\"%s\")\"", &cfg()).is_some());
    }
}
