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
    /// #920: the hold rule a gh subcommand outside `gh_known` falls under (empty = off: a gh alias is a command no word list knows),
    /// the subcommands gh itself defines, and the options in front of the subcommand that take their value as the next word.
    pub gh_rule: String,
    /// The subcommands gh itself defines.
    pub gh_known: Vec<String>,
    /// The gh options that take their value as the next word.
    pub gh_opts_with_arg: Vec<String>,
    /// #920: the command names that are no alias or function (builtins, keywords, read-only binaries); a command word outside this
    /// list is reported in `Normalised::unknown_cmds`. Empty = off.
    pub unknown_known: Vec<String>,
    /// #920: the interpreters whose first non-option word is a script they run (`bash x.sh`, `python3 x.py`, `source x`).
    pub script_interps: Vec<String>,
    /// #920: the interpreter flags that take the code inline (`-c`, `-e`): no script then.
    pub script_inline_flags: Vec<String>,
    /// #920: the words that run the command after them, for the unknown-name and script reading (`git_wrappers` without the words
    /// whose next word is no command: `find`'s path, `source`'s script).
    pub cmd_wrappers: Vec<String>,
    /// #920: the words after which another command starts inside the same simple command (`find .. -exec cmd`).
    pub cmd_markers: Vec<String>,
    /// #920: the commands that change the directory the commands after them run in (`cd`, `pushd`): a relative script path is
    /// read from there too.
    pub cd_cmds: Vec<String>,
    /// #928: cleanup of a path the text made itself is no risky delete. The cleanup commands (`rm`), the words in an assignment's
    /// value that make its path the text's own (`mktemp`), the temp-dir words (`TMPDIR`, `/tmp/`) that make it own together with a
    /// unique-suffix marker (`$$`). Empty `own_cleanup` or no creators and bases = off.
    pub own_cleanup: Vec<String>,
    /// The words in an assignment's value that make the path the text's own (`mktemp`).
    pub own_creators: Vec<String>,
    /// The temp-dir words that make a path own when the value also holds one of `own_markers`.
    pub own_bases: Vec<String>,
    /// The unique-suffix words (`$$`) that, with a base, mark a path made by the text.
    pub own_markers: Vec<String>,
    /// The words that can stand in front of an assignment (`then`, `export`, `local`), each with its trailing space.
    pub own_prefixes: Vec<String>,
    /// The words that can stand before the cleanup command in command position (`sudo`, `command`).
    pub own_leads: Vec<String>,
    /// The commands whose quoted string argument starts a command (`trap 'rm -rf "$tmp"' EXIT`).
    pub own_string_leads: Vec<String>,
    /// The declarations that leave a variable's value as it is (`export HOME`): the name alone after one is no other assignment.
    pub own_keep: Vec<String>,
    /// The block words of the shell as opener = closer (`if` = `fi`, `{` = `}`): a variable made inside a block is own only inside it.
    pub own_blocks: Vec<(String, String)>,
    /// The words that start a new branch of the block they are in (`then`, `else`, `do`).
    pub own_branches: Vec<String>,
    /// The commands after `||` that end the run when the command before failed (`exit`): a creator so guarded made its path.
    pub own_guards: Vec<String>,
    /// The words that define a function (`function name`): its body's `{` is the block that follows.
    pub own_functions: Vec<String>,
    /// The block openers whose body holds patterns closed by a `)` (`case`).
    pub own_cases: Vec<String>,
    /// #928: the project-local tool directories (`.venv/bin`, `node_modules/.bin`, `target/debug`) whose executables are known
    /// commands when they resolve inside the repo, and the entry (`.git`) that marks the repo root. Empty = off.
    pub local_dirs: Vec<String>,
    /// The entry that marks the repo root.
    pub repo_marker: String,
    /// #928: per wrapper word (`sudo`, `env`, `nice`, `timeout`), the options that take the next word as their value, so that
    /// value is not read as the command.
    pub wrapper_opts: Vec<(String, Vec<String>)>,
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
    /// #920: the first gh subcommand that is not in `gh_known` (a gh alias, an extension), if any.
    pub gh_unknown: Option<String>,
    /// #920: command names that are in no word list of `unknown_known`: what a shell alias or function defined earlier in the session
    /// would be called. The caller drops the ones that resolve to a binary on PATH.
    pub unknown_cmds: Vec<String>,
    /// #920: the scripts the command runs by path (`./x.sh`, `bash x.sh`, `node x.js`), as written.
    pub scripts: Vec<String>,
    /// #920: the directories a `cd_cmds` command changes to, in order, as written.
    pub cds: Vec<String>,
    /// #928: how many wrapper-option values were skipped to find a command (`sudo -u bob cmd`).
    pub opt_skips: usize,
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

/// Appends the items of `more` that `into` does not hold yet.
fn merge(into: &mut Vec<String>, more: Vec<String>) {
    for m in more {
        if !into.contains(&m) {
            into.push(m);
        }
    }
}

/// The first subcommand of command `cmd` (git, gh) that is not in `known`: `cmd` must be at the start of a command (opened, after
/// assignments only, or behind a wrapper), its options in `opts` take the next word, any other option is skipped.
fn unknown_sub(group: &[(String, bool, String)], cmd: &str, known: &[String], opts: &[String], wrappers: &[String]) -> Option<String> {
    let wrapper = |w: &str| wrappers.iter().any(|x| x.eq_ignore_ascii_case(base(w)));
    for j in 0..group.len() {
        // the command spelled in any case runs it on a case-insensitive file system
        let Some((w, opened)) = opener(&group[j].0) else { continue };
        if !base(w).eq_ignore_ascii_case(cmd) {
            continue;
        }
        let at_command = opened || group[..j].iter().all(|(w, ..)| is_assign(w)) || group[..j].iter().any(|(w, ..)| wrapper(w));
        if !at_command {
            continue;
        }
        let mut k = j + 1;
        while k < group.len() {
            let w = group[k].0.trim_end_matches([')', '`', '}']);
            if opts.iter().any(|o| o == w) {
                k += 2;
            } else if w.starts_with('-') || w.is_empty() {
                k += 1;
            } else {
                if !known.iter().any(|s| s == w) {
                    return Some(w.to_string());
                }
                break;
            }
        }
    }
    None
}

/// A redirection word (`>out`, `2>&1`, `<in`), not a process substitution (`<(..)`).
fn is_redir(word: &str) -> bool {
    let w = word.trim_start_matches(|c: char| c.is_ascii_digit());
    (w.starts_with('<') || w.starts_with('>')) && !w[1..].starts_with('(')
}

/// The word a simple command runs (assignments, redirections, wrappers and their options skipped), with the words after it.
/// `None` when it is dynamic (`$x`, which the dynamic-command rule holds) or the group runs nothing. A wrapper's option that takes
/// a value (`sudo -u bob`, `env -u X`, `timeout -s KILL`; `opts`) skips that value too, counted in `skips` (#928).
fn command_at<'a>(group: &'a [(String, bool, String)], wrappers: &[String], opts: &[(String, Vec<String>)], skips: &mut usize) -> Option<(&'a str, usize)> {
    let wrapper = |w: &str| wrappers.iter().any(|x| x.eq_ignore_ascii_case(base(w)));
    let mut wrapped = false;
    let (mut cur, mut skip_value) = (String::new(), false);
    for (i, (word, ..)) in group.iter().enumerate() {
        if skip_value {
            skip_value = false;
            *skips += 1;
            continue;
        }
        if word.starts_with('$') && !word.starts_with("$(") {
            return None;
        }
        if is_redir(word) {
            continue;
        }
        let Some((w, _)) = opener(word) else { continue };
        let w = w.trim_end_matches([')', '`', '}']);
        if w.is_empty() {
            continue;
        }
        if wrapper(w) {
            wrapped = true;
            cur = base(w).to_ascii_lowercase();
            continue;
        }
        // an option that takes its value as the next word (`sudo -u bob`): that word is no command
        if wrapped && opts.iter().any(|(k, os)| *k == cur && os.iter().any(|o| o == w)) {
            skip_value = true;
            continue;
        }
        // a wrapper's option and its value (`timeout 30s`, `nice -n 10`), an assignment (`env A=1`)
        if wrapped && (w.starts_with('-') || w.starts_with(|c: char| c.is_ascii_digit()) || is_assign(w)) {
            continue;
        }
        return Some((w, i));
    }
    None
}

/// A plain command name: what an alias or a function is called (no path, no expansion, no punctuation a shell reads).
fn plain_name(w: &str) -> bool {
    w.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
        && w.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-'))
        && !w.chars().all(|c| c.is_ascii_digit())
}

/// Whether `name` resolves to an executable file in a directory of `path` (a PATH value): a real binary is no alias or function.
pub fn on_path(name: &str, path: Option<&std::ffi::OsStr>) -> bool {
    let Some(path) = path else { return false };
    std::env::split_paths(path).any(|dir| {
        let p = dir.join(name);
        std::fs::metadata(&p).is_ok_and(|m| {
            #[cfg(unix)]
            let exec = std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0;
            #[cfg(not(unix))]
            let exec = true;
            m.is_file() && exec
        })
    })
}

/// #928: whether the rest of a path after an own variable stays inside it: empty, or a literal path under it (no `..`, no glob that
/// can match a dot entry (`.*`, a bracket), no variable but a positional parameter inside a component (`ss-$1`), nothing quoted).
fn own_rest(rest: &str) -> bool {
    if rest.is_empty() {
        return true;
    }
    let b = rest.as_bytes();
    rest.starts_with('/')
        && !rest.contains("..")
        && !rest.contains(".*")
        && !rest.contains(".?")
        && !rest.chars().any(|c| c.is_whitespace() || matches!(c, '[' | ']' | '{' | '}' | '~' | '`' | '\'' | '"' | '\\' | '(' | ')' | ';' | '&' | '|' | '<' | '>'))
        && b.iter().enumerate().all(|(i, c)| {
            // a `$` only as a positional parameter in the middle of a component (`ss-$1`)
            *c != b'$' || (i > 0 && b[i - 1] != b'/' && b.get(i + 1).is_some_and(u8::is_ascii_digit) && !b.get(i + 2).is_some_and(u8::is_ascii_digit))
        })
}

/// #928: `v` split into the variable it references (`$name` or `${name}`) and the rest after it.
fn own_ref_parts(v: &str) -> Option<(&str, &str)> {
    let r = v.strip_prefix('$')?;
    match r.strip_prefix('{') {
        Some(b) => b.split_once('}'),
        None => Some(r.split_at(r.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(r.len()))),
    }
    .filter(|(n, _)| !n.is_empty() && n.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'))
}

/// #928: what an assignment's value makes the variable: `Some(true)` a path that is never empty (one word with a temp-dir base and a
/// unique-suffix marker outside any `${..}`, no space, no glob, no `..`: `${TMPDIR:-/tmp}/x.$$`), `Some(false)` a path made by a
/// creator (exactly one command substitution `$(mktemp -d ..)`, nothing nested in it, nothing after it: empty when it fails), `None`
/// no own path.
fn own_value(val: &str, cfg: &Cfg) -> Option<bool> {
    let v = val.trim();
    let v = v.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(v);
    let sub = v.strip_prefix("$(").and_then(|x| x.strip_suffix(')')).or_else(|| v.strip_prefix('`').and_then(|x| x.strip_suffix('`')));
    if let Some(inner) = sub {
        let first = inner.split_whitespace().next().unwrap_or_default();
        let ok = cfg.own_creators.iter().any(|c| c == first) && !inner.contains(['(', ')', '`', ';', '&', '|', '\n', '<', '>']);
        return ok.then_some(false);
    }
    if v.is_empty()
        || v.contains("..")
        || v.chars().any(|c| c.is_whitespace() || matches!(c, '*' | '?' | '[' | ']' | '`' | '"' | '\'' | ';' | '&' | '|' | '(' | ')' | '<' | '>' | '\\'))
        || !cfg.own_bases.iter().any(|b| v.contains(b.as_str()))
    {
        return None;
    }
    let (mut outside, mut depth, mut rest) = (String::new(), 0usize, v);
    while let Some(c) = rest.chars().next() {
        if rest.starts_with("${") {
            depth += 1;
            rest = &rest[2..];
            continue;
        }
        if c == '}' && depth > 0 {
            depth -= 1;
        } else if depth == 0 {
            outside.push(c);
        }
        rest = &rest[c.len_utf8()..];
    }
    (depth == 0 && cfg.own_markers.iter().any(|m| outside.contains(m.as_str()))).then_some(true)
}

/// #928: one simple command of a text as [`commands`] reads it: where its first word is, where it ends, the blocks it sits in (the ids
/// of the open `if`/`while`/`case`/`{`/`(`/function bodies, outermost first; a `then`/`else`/`do`/`;;` starts a new id) and whether it
/// runs only maybe (after `&&` or `||`, in a pipeline or in the background), and whether a `|| exit` guards it.
#[derive(Debug, Clone)]
struct Cmd {
    at: usize,
    end: usize,
    stack: Vec<usize>,
    maybe: bool,
    guarded: bool,
}

/// #928: the simple commands of `text` at its top level (not in a quote, a substitution, a comment or a heredoc body), with the blocks
/// each sits in: the shell's own syntax (quotes, `$(..)`, `${..}`, backticks, `#`, `<<`) is read here; the block words come from
/// `own_blocks` (opener = closer) and `own_branches`. With it whether the reading balanced: a closer that is not the innermost
/// block's own, a `)` that closes nothing (outside a `own_cases` block), a block left open, a quote or substitution left open or a
/// heredoc without its delimiter line make it unbalanced, and the caller then exempts nothing.
fn commands(text: &str, cfg: &Cfg) -> (Vec<Cmd>, bool) {
    let b = text.as_bytes();
    let (mut cmds, mut stack, mut kinds): (Vec<Cmd>, Vec<usize>, Vec<String>) = (Vec::new(), Vec::new(), Vec::new());
    let (mut next_id, mut i, mut maybe_next) = (1usize, 0usize, false);
    let mut heredocs: Vec<(String, bool)> = Vec::new();
    let mut balanced = true;
    let word_end = |from: usize| (from..b.len()).find(|&k| b[k].is_ascii_whitespace() || matches!(b[k], b';' | b'&' | b'|' | b'(' | b')' | b'<' | b'>')).unwrap_or(b.len());
    while i < b.len() {
        // command position: block words, then the command
        while i < b.len() && matches!(b[i], b' ' | b'\t') {
            i += 1;
        }
        if i >= b.len() {
            break;
        }
        let c0 = b[i];
        if c0 == b'\n' {
            i += 1;
            maybe_next = false;
            i = skip_heredocs(text, i, &mut heredocs, &mut balanced);
            continue;
        }
        if c0 == b'#' {
            i = text[i..].find('\n').map_or(b.len(), |n| i + n);
            continue;
        }
        if c0 == b'(' || c0 == b')' {
            if c0 == b'(' {
                stack.push(next_id);
                kinds.push("(".into());
                next_id += 1;
            } else if kinds.last().is_some_and(|k| k == "(") {
                stack.pop();
                kinds.pop();
            } else if !kinds.last().is_some_and(|k| cfg.own_cases.iter().any(|c| c == k)) {
                // a ) that closes nothing but a case pattern: the reading is lost
                balanced = false;
            }
            i += 1;
            continue;
        }
        let we = word_end(i);
        let w = &text[i..we];
        if !w.is_empty() {
            if cfg.own_blocks.iter().any(|(o, _)| o == w) {
                stack.push(next_id);
                kinds.push(w.to_string());
                next_id += 1;
                i = we;
                continue;
            }
            if cfg.own_branches.iter().any(|x| x == w) {
                if let Some(top) = stack.last_mut() {
                    *top = next_id;
                    next_id += 1;
                }
                maybe_next = false;
                i = we;
                continue;
            }
            if cfg.own_blocks.iter().any(|(_, c)| c == w) {
                // a closer ends the innermost block only, and only when it is its opener's
                if kinds.last().is_some_and(|k| cfg.own_blocks.iter().any(|(o, c)| o == k && c == w)) {
                    stack.pop();
                    kinds.pop();
                } else {
                    balanced = false;
                }
                i = we;
                continue;
            }
            if w == "!" {
                i = we;
                continue;
            }
            // `function name`: its body's `{` is the block that follows
            if cfg.own_functions.iter().any(|f| f == w) {
                let mut k = we;
                while k < b.len() && matches!(b[k], b' ' | b'\t') {
                    k += 1;
                }
                i = word_end(k);
                if text[i..].trim_start_matches([' ', '\t']).starts_with("()") {
                    i = text[i..].find("()").map_or(i, |n| i + n + 2);
                }
                continue;
            }
        }
        // a function definition (`name() {`): its body is a block of its own
        let at = i;
        let mut cmd = Cmd { at, end: at, stack: stack.clone(), maybe: maybe_next, guarded: false };
        maybe_next = false;
        let mut ctx: Vec<u8> = Vec::new();
        let mut sep = 0u8;
        while i < b.len() {
            let c = b[i];
            let top = ctx.last().copied();
            match top {
                Some(b'\'') => {
                    if c == b'\'' {
                        ctx.pop();
                    }
                    i += 1;
                    continue;
                }
                Some(b'"') => {
                    match c {
                        b'\\' => i += 1,
                        b'"' => {
                            ctx.pop();
                        }
                        b'`' => ctx.push(b'`'),
                        b'$' if b.get(i + 1) == Some(&b'(') => {
                            ctx.push(b'S');
                            i += 1;
                        }
                        b'$' if b.get(i + 1) == Some(&b'{') => {
                            ctx.push(b'P');
                            i += 1;
                        }
                        _ => {}
                    }
                    i += 1;
                    continue;
                }
                Some(b'`') if c == b'`' => {
                    ctx.pop();
                    i += 1;
                    continue;
                }
                Some(b'P') if c == b'}' => {
                    ctx.pop();
                    i += 1;
                    continue;
                }
                Some(b'S' | b'p') if c == b')' => {
                    ctx.pop();
                    i += 1;
                    continue;
                }
                Some(b'S' | b'p') if c == b'(' => {
                    ctx.push(b'p');
                    i += 1;
                    continue;
                }
                _ => {}
            }
            match c {
                b'\\' => i += 1,
                b'\'' => ctx.push(b'\''),
                b'"' => ctx.push(b'"'),
                b'`' => ctx.push(b'`'),
                b'$' if b.get(i + 1) == Some(&b'(') => {
                    ctx.push(b'S');
                    i += 1;
                }
                b'$' if b.get(i + 1) == Some(&b'{') => {
                    ctx.push(b'P');
                    i += 1;
                }
                b'<' if top.is_none() && b.get(i + 1) == Some(&b'<') && b.get(i + 2) != Some(&b'<') => {
                    // a heredoc: its body (from the next line to the delimiter line) is no command
                    let mut k = i + 2;
                    let dash = b.get(k) == Some(&b'-');
                    if dash {
                        k += 1;
                    }
                    while k < b.len() && matches!(b[k], b' ' | b'\t') {
                        k += 1;
                    }
                    let e = word_end(k);
                    let d: String = text[k..e].chars().filter(|c| !matches!(c, '\'' | '"' | '\\')).collect();
                    if !d.is_empty() {
                        heredocs.push((d, dash));
                    }
                    i = e;
                    continue;
                }
                b'#' if top.is_none() && i > 0 && b[i - 1].is_ascii_whitespace() => {
                    i = text[i..].find('\n').map_or(b.len(), |n| i + n);
                    continue;
                }
                b'(' if top.is_none()
                    && b.get(i + 1) == Some(&b')')
                    && text[at..i].trim().bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.' | b':'))
                    && !text[at..i].trim().is_empty() =>
                {
                    // `name()`: a function definition; its body's `{` is the block that follows, read at command position
                    i += 2;
                    sep = b'f';
                    break;
                }
                b'\n' | b';' | b'&' | b'|' | b'(' | b')' if top.is_none() => {
                    sep = c;
                    break;
                }
                _ => {}
            }
            i += 1;
        }
        cmd.end = i.min(b.len());
        if !ctx.is_empty() {
            // the text ends inside a quote or a substitution
            balanced = false;
        }
        match sep {
            b'f' => {}
            b'\n' => {
                i += 1;
                i = skip_heredocs(text, i, &mut heredocs, &mut balanced);
            }
            b';' => {
                i += 1;
                // `;;` ends a case arm: the next arm is a new block
                if b.get(i) == Some(&b';') {
                    i += 1;
                    while matches!(b.get(i), Some(b';' | b'&')) {
                        i += 1;
                    }
                    if let Some(top) = stack.last_mut() {
                        *top = next_id;
                        next_id += 1;
                    }
                }
            }
            b'&' | b'|' => {
                let double = b.get(i + 1) == Some(&sep);
                i += if double { 2 } else { 1 };
                if double {
                    maybe_next = true;
                    if sep == b'|' {
                        // `cmd || exit`: the command before it went through when the one after does not run
                        let mut k = i;
                        while k < b.len() && b[k].is_ascii_whitespace() {
                            k += 1;
                        }
                        let w = &text[k..word_end(k)];
                        // and only when the guard runs in this shell (`|| exit | cat` exits a pipeline subshell only)
                        let tail = text[k..].split(['\n', ';']).next().unwrap_or_default();
                        cmd.guarded = cfg.own_guards.iter().any(|g| g == w) && !tail.contains(['|', '&', '(', '`']);
                    }
                } else {
                    // in a pipeline or the background: a subshell, so its assignments stay there
                    cmd.maybe = true;
                    maybe_next = sep == b'|';
                }
            }
            _ => {}
        }
        if cmd.end > cmd.at {
            cmds.push(cmd);
        }
    }
    (cmds, balanced && stack.is_empty() && heredocs.is_empty())
}

/// #928: past the bodies of the heredocs opened on the line before `i` (each up to its delimiter line).
fn skip_heredocs(text: &str, mut i: usize, docs: &mut Vec<(String, bool)>, balanced: &mut bool) -> usize {
    for (d, dash) in docs.drain(..) {
        let mut closed = false;
        while i < text.len() {
            let e = text[i..].find('\n').map_or(text.len(), |n| i + n);
            let line = &text[i..e];
            i = (e + 1).min(text.len());
            if (if dash { line.trim_start_matches('\t') } else { line }) == d {
                closed = true;
                break;
            }
        }
        *balanced &= closed;
    }
    i
}

/// #928: `text` (a command or a script) with the cleanup of a path it made itself blanked (`rm` becomes `:`) and how many were.
/// A variable is own at a cleanup when an assignment that surely ran before it (earlier, not after `&&`/`||`, not in a pipeline or the
/// background, in the same block or one around it) gave it an own value: `own_value`, or a path under another own variable there; and
/// its name appears nowhere else but as a plain reference or such an assignment (`read t`, `printf -v t`, `eval t=/`, `t+=..`, `t[0]=`,
/// `${t:=..}`, `declare -n r=t`, a value that is no own path anywhere: no own path at all). A variable that is ever set empty, or made
/// by a creator that can fail without a `|| exit` after it, counts only as a bare target (`rm -rf ""` deletes nothing). A cleanup
/// command (`own_cleanup`) is blanked when it stands in command position (after `own_prefixes` / `own_leads` words only, or first in
/// the string of an `own_string_leads` command: `trap 'rm -rf "$tmp"' EXIT`) and ALL its targets are a double-quoted reference to an
/// own variable, alone or with a literal rest that stays inside it. Anything else stays for the rules.
pub fn blank_own_temp(text: &str, cfg: &Cfg) -> (String, usize) {
    if cfg.own_cleanup.is_empty() || (cfg.own_creators.is_empty() && cfg.own_bases.is_empty()) {
        return (text.to_string(), 0);
    }
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let (cmds, balanced) = commands(text, cfg);
    if !balanced {
        return (text.to_string(), 0);
    }
    // a creator or guard the text redefines (`mktemp() { ..; }`, `alias exit=..`) is no creator or guard
    let shadowed = cfg.own_creators.iter().chain(&cfg.own_guards).any(|w| {
        [format!("{w}()"), format!("{w} ()"), format!("alias {w}=")].iter().any(|p| text.contains(p.as_str()))
            || cfg.own_functions.iter().any(|f| text.contains(&format!("{f} {w}")))
    });
    if shadowed {
        return (text.to_string(), 0);
    }
    // the assignments at the start of a command: (name, value, byte offset of the name, the command)
    let mut assigns: Vec<(String, String, usize, &Cmd)> = Vec::new();
    for c in &cmds {
        let mut s = &text[c.at..c.end];
        while let Some(rest) = cfg.own_prefixes.iter().find_map(|k| s.strip_prefix(k.as_str())) {
            s = rest.trim_start();
        }
        if let Some((k, v)) = s.split_once('=').filter(|(k, _)| !k.is_empty() && k.bytes().all(ident) && !k.starts_with(|c: char| c.is_ascii_digit())) {
            assigns.push((k.to_string(), v.to_string(), s.as_ptr() as usize - text.as_ptr() as usize, c));
        }
    }
    let b = text.as_bytes();
    let sep = |c: u8| c.is_ascii_whitespace() || matches!(c, b'"' | b'\'' | b';' | b'&' | b'|' | b'(' | b')' | b'{' | b'}' | b'`' | b'=');
    // a name that appears anywhere but as a plain reference or a recognised assignment can be set some other way: no own path
    let mut bad: Vec<String> = Vec::new();
    for (name, ..) in &assigns {
        if bad.contains(name) {
            continue;
        }
        let mut from = 0;
        while let Some(off) = text.get(from..).and_then(|t| t.find(name.as_str())) {
            let p = from + off;
            let e = p + name.len();
            from = e;
            // a comment or a heredoc body is data (the reading balanced, so what is outside every command runs nothing)
            if !cmds.iter().any(|c| c.at <= p && p < c.end) {
                continue;
            }
            if (p > 0 && ident(b[p - 1])) || b.get(e).is_some_and(|c| ident(*c)) || (p > 0 && b[p - 1] == b'$') {
                continue;
            }
            let braced = (p >= 2 && &b[p - 2..p] == b"${") || (p >= 3 && matches!(b[p - 1], b'#' | b'!') && &b[p - 3..p - 1] == b"${");
            if braced {
                if text[e..].starts_with('=') || text[e..].starts_with(":=") {
                    bad.push(name.clone());
                    break;
                }
                continue;
            }
            if assigns.iter().any(|(_, _, at, _)| *at == p) {
                continue;
            }
            // a declaration that leaves the value as it is (`export HOME`, `own_keep`), the name alone after it
            let head = text[..p].rfind(['\n', ';', '&', '|', '{']).map_or(0, |s| s + 1);
            if cfg.own_keep.iter().any(|k| k == text[head..p].trim()) && b.get(e).is_none_or(|c| matches!(c, b'\n' | b';' | b'&' | b'|' | b' ' | b'\t' | b'}')) {
                continue;
            }
            let before = p == 0 || sep(b[p - 1]);
            let after = b.get(e).is_none_or(|c| sep(*c) || matches!(c, b'+' | b'['));
            if before && after {
                bad.push(name.clone());
                break;
            }
        }
    }
    // own_at: Some(never empty) when `k` is own at a command at byte `at` in blocks `stack`: EVERY assignment of it anywhere (any of them
    // can be the last to run, in a loop or a function called later) is an own value or a path under a variable own (and never empty)
    // there, and at least one surely ran before (earlier, not maybe, in the same block or one around it)
    #[allow(clippy::too_many_arguments)]
    fn own_at(k: &str, at: usize, stack: &[usize], depth: usize, assigns: &[(String, String, usize, &Cmd)], cfg: &Cfg, bad: &[String]) -> Option<bool> {
        if depth > 8 || bad.iter().any(|x| x == k) {
            return None;
        }
        let (mut ran, mut sure) = (false, true);
        for (n, v, off, c) in assigns {
            if n != k {
                continue;
            }
            let t = v.trim();
            if t.is_empty() {
                sure = false;
                continue;
            }
            let t = t.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(t);
            let got = match own_value(v, cfg) {
                Some(s) => s || c.guarded,
                None => {
                    let (base, rest) = own_ref_parts(t).filter(|(_, r)| own_rest(r))?;
                    // a path under a variable that may be empty is no path under it (`"$t"/x` is `/x`)
                    own_at(base, *off, &c.stack, depth + 1, assigns, cfg, bad).filter(|s| *s || rest.is_empty())?
                }
            };
            sure &= got;
            ran |= *off < at && !c.maybe && stack.starts_with(&c.stack);
        }
        ran.then_some(sure)
    }
    let leads = |t: &str| t.split_whitespace().all(|w| cfg.own_leads.iter().any(|l| l == w) || cfg.own_prefixes.iter().any(|p| p.trim() == w));
    let (mut out, mut last, mut n, mut i) = (String::with_capacity(text.len()), 0, 0, 0);
    while i < b.len() {
        let hit = text.get(i..).and_then(|t| cfg.own_cleanup.iter().find(|c| t.starts_with(c.as_str())));
        let Some(cmd) = hit else {
            i += 1;
            continue;
        };
        let end = i + cmd.len();
        let at_word = i == 0 || matches!(b[i - 1], b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b'(' | b'`' | b'\'' | b'"' | b'{');
        // the simple command the cleanup is in (or the trap command whose string it starts)
        let Some(host) = cmds.iter().rev().find(|c| c.at <= i && i < c.end) else {
            i = end;
            continue;
        };
        if !at_word || !b.get(end).is_some_and(|c| matches!(c, b' ' | b'\t')) {
            i = end;
            continue;
        }
        // command position: only lead words since the start of the command, or first in the string of a string lead (`trap '`)
        let lead = &text[host.at..i];
        // or a later command of that string, after a ; && || in it (`trap 'kill "$p"; rm -rf "$tmp"' EXIT`)
        let in_string = |l: &str| {
            let w = l.split_whitespace().next().unwrap_or_default();
            let after = l.trim_start().get(w.len()..).unwrap_or_default().trim_start();
            cfg.own_string_leads.iter().any(|s| s == w)
                && after.starts_with(['\'', '"'])
                && (after.len() == 1 || l.trim_end().ends_with(';') || l.trim_end().ends_with("&&") || l.trim_end().ends_with("||"))
                && l.ends_with(char::is_whitespace)
        };
        let positioned = match lead.strip_suffix(['\'', '"']) {
            Some(l) => {
                let mut ws: Vec<&str> = l.split_whitespace().collect();
                l.ends_with(char::is_whitespace) && ws.pop().is_some_and(|w| cfg.own_string_leads.iter().any(|s| s == w)) && leads(&ws.join(" "))
            }
            None => leads(lead) || in_string(lead),
        };
        if !positioned {
            i = end;
            continue;
        }
        let (mut j, mut targets, mut all) = (end, 0, true);
        loop {
            while j < b.len() && matches!(b[j], b' ' | b'\t') {
                j += 1;
            }
            let s = j;
            while j < b.len() && !matches!(b[j], b' ' | b'\t' | b'\n' | b';' | b'&' | b'|' | b')' | b'`') {
                j += 1;
            }
            let w = text.get(s..j).unwrap_or_default();
            let plain = w.trim_matches(['"', '\'']);
            if plain.is_empty() || plain.starts_with('#') {
                break;
            }
            if plain.starts_with('-') || plain.trim_start_matches(|c: char| c.is_ascii_digit()).starts_with(['<', '>']) {
                continue;
            }
            targets += 1;
            // a double-quoted reference only (no word splitting, no glob of the value), no `$` outside the quotes (`"$t/a"$1`); a
            // trailing ' closes a trap string
            let q = w.strip_suffix('\'').unwrap_or(w);
            let mut inq = false;
            let quoted = q.chars().all(|c| {
                if c == '"' {
                    inq = !inq;
                }
                c != '$' || inq
            });
            let path = q.replace('"', "");
            all &= q.starts_with("\"$")
                && !q.contains('\'')
                && quoted
                && own_ref_parts(&path).is_some_and(|(name, rest)| {
                    own_rest(rest) && own_at(name, host.at, &host.stack, 0, &assigns, cfg, &bad).is_some_and(|sure| sure || rest.is_empty())
                });
            if w.matches('\'').count() % 2 == 1 || w.matches('"').count() % 2 == 1 {
                break;
            }
        }
        if targets > 0 && all {
            out.push_str(&text[last..i]);
            out.push(':');
            last = end;
            n += 1;
        }
        i = end;
    }
    out.push_str(&text[last..]);
    (out, n)
}

/// #928: whether `name` is an executable in a project-local tool directory (`local_dirs`: `.venv/bin`, `node_modules/.bin`,
/// `target/debug`) of one of `dirs` (the cwd and each directory the command changes to) or of their parents up to the repo root (the
/// nearest parent that holds `marker`), with the real path inside that root: a symlink that leaves the repo, or a directory outside
/// any repo, is no known tool. Its real path, so the caller reads it as a script run by path is (#929 review: a planted tool is read).
pub fn local_tool(name: &str, dirs: &[std::path::PathBuf], local_dirs: &[String], marker: &str) -> Option<std::path::PathBuf> {
    if local_dirs.is_empty() || marker.is_empty() || !plain_name(name) {
        return None;
    }
    dirs.iter().filter_map(|d| std::fs::canonicalize(d).ok()).find_map(|d| {
        let root = d.ancestors().find(|a| a.join(marker).exists()).map(std::path::Path::to_path_buf)?;
        d.ancestors().take_while(|a| a.starts_with(&root)).find_map(|a| {
            local_dirs.iter().find_map(|l| {
                std::fs::canonicalize(a.join(l).join(name)).ok().filter(|p| {
                    p.starts_with(&root)
                        && std::fs::metadata(p).is_ok_and(|m| {
                            #[cfg(unix)]
                            let exec = std::os::unix::fs::PermissionsExt::mode(&m.permissions()) & 0o111 != 0;
                            #[cfg(not(unix))]
                            let exec = true;
                            m.is_file() && exec
                        })
                })
            })
        })
    })
}

/// What reading a script a command runs by path gave.
#[derive(Debug, PartialEq)]
pub enum Script {
    /// Its text (at most the read cap, no NUL byte).
    Text(String),
    /// The text of a script over the read cap but within the scan cap (no NUL byte): matched as written, not read the shell's way.
    Large(String),
    /// There is a file but it was not read: larger than the scan cap, binary, or unreadable.
    Unread,
    /// Nothing to read: reading is off (`cap` 0), the path is no file.
    Skip,
}

/// `path` with a leading `~` (alone or before a `/`) spelled as `home`, the way the shell expands it.
fn tilde(path: &str, home: Option<&std::ffi::OsStr>) -> std::path::PathBuf {
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with('/') => std::path::Path::new(h).join(rest.trim_start_matches('/')),
        _ => std::path::PathBuf::from(path),
    }
}

/// The directories a relative script path is read from: `cwd` (the process's own when `None`), then each directory the command
/// changes to (`cds`, in order, each from the one before; a leading `~` is `home`).
pub fn dirs(cwd: Option<&str>, cds: &[String], home: Option<&std::ffi::OsStr>) -> Vec<std::path::PathBuf> {
    let mut at = cwd.map(std::path::PathBuf::from).unwrap_or_default();
    let mut out = vec![at.clone()];
    for d in cds {
        at = at.join(tilde(d, home)); // an absolute directory replaces the one before
        out.push(at.clone());
    }
    out
}

/// Reads the script at `path` (a leading `~` is `home`; a relative path from the last of `dirs` that holds it: the directory the
/// command changed to last before the one it started in) when it is at most
/// `cap` bytes (0 = never read), or as written when it is at most `scan` bytes.
pub fn read_script(path: &str, dirs: &[std::path::PathBuf], home: Option<&std::ffi::OsStr>, cap: usize, scan: usize) -> Script {
    use std::io::Read;
    if cap == 0 {
        return Script::Skip;
    }
    let p = tilde(path, home);
    let found = if p.is_absolute() || dirs.is_empty() {
        std::fs::metadata(&p).ok().map(|m| (p.clone(), m))
    } else {
        dirs.iter().rev().map(|d| d.join(&p)).find_map(|f| std::fs::metadata(&f).ok().filter(|m| m.is_file()).map(|m| (f, m)))
    };
    let Some((full, meta)) = found.filter(|(_, m)| m.is_file()) else { return Script::Skip };
    let limit = cap.max(scan);
    if usize::try_from(meta.len()).map_or(true, |n| n > limit) {
        return Script::Unread;
    }
    let mut bytes = Vec::new();
    match std::fs::File::open(&full).and_then(|f| f.take(limit as u64 + 1).read_to_end(&mut bytes)) {
        Ok(n) if n <= cap && !bytes.contains(&0) => Script::Text(String::from_utf8_lossy(&bytes).into_owned()),
        Ok(n) if n <= limit && !bytes.contains(&0) => Script::Large(String::from_utf8_lossy(&bytes).into_owned()),
        _ => Script::Unread,
    }
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
            if n.gh_unknown.is_none() {
                n.gh_unknown = m.gh_unknown;
            }
            n.cds.extend(m.cds);
            n.opt_skips += m.opt_skips;
            merge(&mut n.scripts, m.scripts); // unknown_cmds: the top level only (a quoted word that holds a space is text more often than a command)
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

/// What one reading of a command found besides its text (see the fields of [`Normalised`]).
#[derive(Default)]
struct Found {
    gh_unknown: Option<String>,
    unknown_cmds: Vec<String>,
    scripts: Vec<String>,
    cds: Vec<String>,
    opt_skips: usize,
}

/// One reading of `cmd`, and its words that hold a space (read again by [`normalise`]).
fn once(cmd: &str, cfg: &Cfg, depth: usize) -> Option<(Normalised, Vec<String>)> {
    let toks = split(cmd, cfg)?;
    let (mut text, mut stripped, mut git_unknown, mut extra) = (String::new(), false, None, Vec::new());
    let mut found = Found::default();
    let mut nested: Vec<String> = Vec::new();
    let mut group: Vec<(String, bool, String)> = Vec::new();
    let emit = |group: &mut Vec<(String, bool, String)>,
                text: &mut String,
                stripped: &mut bool,
                git_unknown: &mut Option<String>,
                nested: &mut Vec<String>,
                more: &mut Found| {
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
            *git_unknown = unknown_sub(group, "git", &cfg.git_known, &cfg.git_opts_with_arg, &cfg.git_wrappers);
        }
        if more.gh_unknown.is_none() && !cfg.gh_rule.is_empty() {
            more.gh_unknown = unknown_sub(group, "gh", &cfg.gh_known, &cfg.gh_opts_with_arg, &cfg.git_wrappers);
        }
        // the commands of the group: the first, and one after each marker word (`find . -exec cmd {} ;`)
        let starts = std::iter::once(0).chain(group.iter().enumerate().filter(|(_, (w, ..))| cfg.cmd_markers.iter().any(|m| m == w)).map(|(i, _)| i + 1));
        for seg in starts.map(|s| &group[s..]) {
            let Some((cmd, at)) = command_at(seg, &cfg.cmd_wrappers, &cfg.wrapper_opts, &mut more.opt_skips) else { continue };
            // a command name no list knows: what a shell alias or function defined earlier in the session is called
            if !cfg.unknown_known.is_empty() && plain_name(cmd) && !cfg.unknown_known.iter().any(|k| k == cmd) {
                merge(&mut more.unknown_cmds, vec![cmd.to_string()]);
            }
            // the directory the later commands run in
            if cfg.cd_cmds.iter().any(|c| c == cmd) {
                let to = seg[at + 1..].iter().map(|(w, ..)| w.as_str()).find(|w| !w.is_empty() && !w.starts_with('-') && !is_redir(w));
                if let Some(d) = to.filter(|d| !d.contains(['$', '`'])) {
                    more.cds.push(d.to_string());
                }
            }
            // a script run by path: the first non-option word after an interpreter (one named by its path too: /bin/sh x), or the
            // command word itself
            if cfg.script_interps.iter().any(|i| i == base(cmd)) {
                let rest = &seg[at + 1..];
                let flag = rest.iter().position(|(w, ..)| cfg.script_inline_flags.iter().any(|f| f == w));
                let inline = flag.is_some();
                // the code of a one-liner is read as a command too (a word with no space is not re-read otherwise: `sh -c ./d.sh`)
                if let Some((_, _, code)) = flag.and_then(|f| rest.get(f + 1)) {
                    // one that holds a space or a separator is re-read below with every such word already
                    if !code.is_empty() && !code.contains(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|')) {
                        nested.push(code.clone());
                    }
                }
                let script = rest.iter().map(|(w, ..)| w.as_str()).find(|w| !w.is_empty() && !w.starts_with('-') && !is_assign(w) && !is_redir(w));
                if let (false, Some(sc)) = (inline, script) {
                    merge(&mut more.scripts, vec![sc.to_string()]);
                }
            } else if cmd.contains('/') && !cmd.ends_with('/') {
                merge(&mut more.scripts, vec![cmd.to_string()]);
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
                emit(&mut group, &mut text, &mut stripped, &mut git_unknown, &mut nested, &mut found);
                // the body is data (matched as written); what it substitutes runs, so that is read as a command, once as written
                // and once with its quotes and comment marks blanked (they are literal in a body, so they hide nothing there)
                if runs && depth < cfg.body_depth {
                    let plain: String = b.chars().map(|c| if matches!(c, '\'' | '"' | '#') { ' ' } else { c }).collect();
                    for (m, more) in [once(&b, cfg, depth + 1), once(&plain, cfg, depth + 1)].into_iter().flatten() {
                        if git_unknown.is_none() {
                            git_unknown = m.git_unknown;
                        }
                        if found.gh_unknown.is_none() {
                            found.gh_unknown = m.gh_unknown;
                        }
                        merge(&mut found.scripts, m.scripts);
                        found.cds.extend(m.cds);
                        extra.push(m.text);
                        extra.extend(m.extra);
                        nested.extend(more);
                    }
                }
                text.push_str(&b);
            }
            Tok::Sep(s) => {
                emit(&mut group, &mut text, &mut stripped, &mut git_unknown, &mut nested, &mut found);
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
    emit(&mut group, &mut text, &mut stripped, &mut git_unknown, &mut nested, &mut found);
    let Found { gh_unknown, unknown_cmds, scripts, cds, opt_skips } = found;
    Some((Normalised { text, stripped, git_unknown, extra, gh_unknown, unknown_cmds, scripts, cds, opt_skips }, nested))
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
            git_wrappers: v(&["sudo", "env", "time", "if", "then", "do", "{"]),
            passes: 3,
            brace_cap: 64,
            body_depth: 2,
            gh_rule: "gh-unknown-subcommand".into(),
            gh_known: v(&["pr", "issue", "api"]),
            unknown_known: v(&["ls", "cd", "echo", "if", "then", "fi", "export", "git", "gh", "for", "do", "done"]),
            script_interps: v(&["bash", "sh", "python3", "node", "source", "."]),
            script_inline_flags: v(&["-c", "-e"]),
            cmd_wrappers: v(&["sudo", "env", "time", "if", "then", "do", "{"]),
            cmd_markers: v(&["-exec", "-execdir"]),
            cd_cmds: v(&["cd", "pushd"]),
            ..Cfg::default()
        }
    }
    fn n(c: &str) -> Normalised {
        normalise(c, &cfg()).unwrap_or_else(|| panic!("balanced: {c}"))
    }

    /// #920: a gh subcommand outside the known list is a gh alias; a command name outside the known list is what a shell alias or
    /// function is called; the scripts a command runs by path are listed, an inline one-liner is no script.
    #[test]
    fn aliases_unknown_names_and_scripts_are_found() {
        assert_eq!(n("gh co 12").gh_unknown.as_deref(), Some("co"));
        assert_eq!(n("sudo gh zz").gh_unknown.as_deref(), Some("zz"));
        assert_eq!(n("gh pr merge 1").gh_unknown, None);
        assert_eq!(n("echo gh co").gh_unknown, None, "gh as an argument is no gh command");
        assert_eq!(n("zzgp; ls").unknown_cmds, ["zzgp"]);
        assert_eq!(n("FOO=1 zzgp x && ls").unknown_cmds, ["zzgp"]);
        assert_eq!(n("if true; then zzgp; fi").unknown_cmds, ["true", "zzgp"], "wrappers and their keywords are skipped");
        assert_eq!(n("sudo -u root ls").unknown_cmds, ["root"], "a wrapper option value is read as the command (a false hold, never a pass)");
        assert!(n("ls -la; cd x; export A=1").unknown_cmds.is_empty());
        assert!(n("\"$x\" a; ./run.sh; foo() { ls; }; >out ls").unknown_cmds.is_empty(), "dynamic words, paths, definitions, redirections");
        assert!(n("git commit -m \"fix the bug\"").unknown_cmds.is_empty(), "a quoted argument is text, not a command");
        assert_eq!(n("bash x.sh a").scripts, ["x.sh"]);
        assert_eq!(n("sudo ./d.sh").scripts, ["./d.sh"]);
        assert_eq!(n("FOO=1 python3 -u t/p.py").scripts, ["t/p.py"]);
        assert_eq!(n("source ./e").scripts, ["./e"]);
        assert!(n("bash -c 'ls'").scripts.is_empty() && n("python3 -c x").scripts.is_empty(), "inline code is no script");
        assert_eq!(n("sh -c './d.sh'").scripts, ["./d.sh"], "a nested shell's script is read too");
        assert!(n("ls x.sh").scripts.is_empty());
    }

    /// #920 review: a path a command takes as its argument is no command name (`find src`), `source`'s word is a script, an
    /// interpreter named by its path reads its script, a script after `find -exec` is found, and `cd` targets are listed.
    #[test]
    fn arguments_are_no_command_and_scripts_are_found_behind_paths_and_markers() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let c = Cfg { git_wrappers: v(&["find", "source", ".", "-exec", "sudo"]), unknown_known: v(&["find", "ls", "cd", "source", "sudo"]), ..cfg() };
        let n = |x: &str| normalise(x, &c).unwrap();
        assert!(n("find src -name x.rs -type f").unknown_cmds.is_empty(), "find's path is no command");
        assert_eq!(n("source env.sh").scripts, ["env.sh"], "source reads its script");
        assert!(n("source env.sh").unknown_cmds.is_empty());
        assert_eq!(n(". ./e.sh").scripts, ["./e.sh"]);
        assert_eq!(n("/bin/bash s/p.sh").scripts, ["s/p.sh"], "an interpreter by path reads its script, it is none itself");
        assert_eq!(n("/usr/bin/python3 -c x").scripts, Vec::<String>::new());
        assert_eq!(n("find . -name p.sh -exec ./s/p.sh {} ;").scripts, ["./s/p.sh"]);
        assert_eq!(n("find . -exec bash s/p.sh ;").scripts, ["s/p.sh"]);
        assert_eq!(n("cd sub && ./p.sh; pushd ~/x; cd $D").cds, ["sub", "~/x"], "a dynamic directory is unknown");
        assert_eq!(n("sh -c 'cd sub && ./p.sh'").cds, ["sub"]);
    }

    #[test]
    fn a_relative_script_is_read_from_cwd_or_a_cd_target_and_tilde_is_home() {
        let dir = std::env::temp_dir().join(format!("ah-920-dirs-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/p.sh"), "git push\n").unwrap();
        std::fs::write(dir.join("big.sh"), format!("{}git push\n", "#\n".repeat(40))).unwrap();
        let d = dir.to_str().unwrap();
        let home = std::ffi::OsString::from(d);
        let ds = dirs(Some(d), &["sub".into()], None);
        assert_eq!(ds, [dir.clone(), dir.join("sub")]);
        assert_eq!(read_script("./p.sh", &ds, None, 50, 0), Script::Text("git push\n".into()), "read from the cd target");
        assert_eq!(read_script("./p.sh", &ds[..1], None, 50, 0), Script::Skip);
        std::fs::write(dir.join("p.sh"), "ls\n").unwrap();
        assert_eq!(read_script("./p.sh", &ds, None, 50, 0), Script::Text("git push\n".into()), "the last cd target first, as the shell runs it");
        assert_eq!(read_script("~/sub/p.sh", &[], Some(&home), 50, 0), Script::Text("git push\n".into()), "~ is home");
        assert_eq!(dirs(Some("/a"), &["~/b".into()], Some(&home))[1], dir.join("b"));
        assert_eq!(read_script("big.sh", &ds, None, 50, 0), Script::Unread, "over the cap, no scan");
        assert!(matches!(read_script("big.sh", &ds, None, 50, 500), Script::Large(t) if t.ends_with("git push\n")), "within the scan cap");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_script_is_read_up_to_the_cap_and_a_binary_on_path_is_no_alias() {
        let dir = std::env::temp_dir().join(format!("ah-920-sw-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (small, big, bin, tool) = (dir.join("small.sh"), dir.join("big.sh"), dir.join("bin.sh"), dir.join("zztool920"));
        std::fs::write(&small, "git push\n").unwrap();
        std::fs::write(&big, "x".repeat(100)).unwrap();
        std::fs::write(&bin, b"a\0b").unwrap();
        std::fs::write(&tool, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&tool, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        let d = dir.to_str().unwrap();
        assert_eq!(read_script("small.sh", &[d.into()], None, 50, 0), Script::Text("git push\n".into()), "a relative path is read from cwd");
        assert_eq!(read_script("big.sh", &[d.into()], None, 50, 0), Script::Unread, "over the cap");
        assert_eq!(read_script("bin.sh", &[d.into()], None, 50, 0), Script::Unread, "a NUL byte is a binary");
        assert_eq!(read_script("nope.sh", &[d.into()], None, 50, 0), Script::Skip);
        assert_eq!(read_script("small.sh", &[d.into()], None, 0, 0), Script::Skip, "cap 0 = reading off");
        assert_eq!(read_script(small.to_str().unwrap(), &[], None, 50, 0), Script::Text("git push\n".into()));
        let path = std::env::join_paths([dir.as_path()]).unwrap();
        assert!(on_path("zztool920", Some(&path)));
        assert!(!on_path("small.sh", Some(&path)), "a file without the exec bit is no command");
        assert!(!on_path("zztool920", None));
        std::fs::remove_dir_all(&dir).unwrap();
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

    fn own() -> Cfg {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        Cfg {
            own_cleanup: v(&["rm"]),
            own_creators: v(&["mktemp"]),
            own_bases: v(&["TMPDIR", "/tmp/"]),
            own_markers: v(&["$$"]),
            own_prefixes: v(&["then ", "do ", "export ", "local "]),
            own_leads: v(&["sudo", "command"]),
            own_string_leads: v(&["trap"]),
            own_keep: v(&["export"]),
            own_blocks: [("if", "fi"), ("while", "done"), ("until", "done"), ("for", "done"), ("case", "esac"), ("{", "}")].iter().map(|(a, b)| (a.to_string(), b.to_string())).collect(),
            own_branches: v(&["then", "else", "elif", "do"]),
            own_guards: v(&["exit", "return"]),
            own_functions: v(&["function"]),
            own_cases: v(&["case"]),
            ..cfg()
        }
    }

    #[test]
    fn issue_928_the_cleanup_of_a_path_the_text_made_itself_is_blanked() {
        let b = |t: &str| blank_own_temp(t, &own());
        // mktemp, a unique temp dir, a path under one, a trap string, a function body, a reset to empty
        assert_eq!(b("t=$(mktemp -d); rm -rf \"$t\"").1, 1);
        assert_eq!(b("t=${TMPDIR:-/tmp}/x.$$\ntrap 'rm -rf \"$t\"' EXIT HUP").1, 1);
        assert_eq!(b("t=${TMPDIR:-/tmp}/x.$$\ntrap '[ -n \"$p\" ] && kill \"$p\"; rm -rf \"$t\"' EXIT").1, 1);
        assert_eq!(b("# the t dir\nt=${TMPDIR:-/tmp}/x.$$\nrm -rf \"$t\"").1, 1);
        assert_eq!(b("t=$(mktemp -d) || exit 1\ns=$t/seen\nrm -f \"$s\" \"$t/sub\"").1, 1);
        assert_eq!(b("t=$(mktemp -d) || exit 1\nf() { d=$t/h.$1; rm -rf \"$d\"; }").1, 1);
        assert_eq!(b("t=${TMPDIR:-/tmp}/b.$$\nf() { HOME=\"$t/home.$1\"; export HOME; rm -rf \"$HOME\"; }").1, 1);
        assert_eq!(b("if true; then\n  t=$(mktemp -d) || exit 1\n  rm -rf \"$t/x\"\nfi").1, 1);
        assert_eq!(b("c=$(mktemp -d)\n[ -n \"${c:-}\" ] && rm -rf \"$c\"\nc=").1, 1);
        assert!(!b("t=$(mktemp -d); rm -rf \"$t\"").0.contains("rm"));
        // anything else stays for the rules: a mixed list, a path that climbs, a variable set to something else or read from input,
        // a temp dir without a unique suffix, a path nothing made, a cleanup the text does not spell as a command word
        for t in [
            "t=$(mktemp -d); rm -rf \"$t\" /x",
            "t=$(mktemp -d); rm -rf \"$t/..\"",
            "t=$(mktemp -d); t=/; rm -rf \"$t\"",
            "t=$(mktemp -d); read t; rm -rf \"$t\"",
            "t=/tmp/x; rm -rf \"$t\"",
            "rm -rf \"$t\"",
            "t=$(mktemp -d); xrm -rf \"$t\"",
            "t=$(mktemp -d); rm -rf \"$t$x\"",
            // review of #929: each of these passed the first cut
            "t=; rm -rf \"$t\"/Users/x",
            "t=${HOME:-mktemp}; rm -rf \"$t\"",
            "t=\"$(mktemp -d) $HOME\"; rm -rf $t",
            "t=$(mktemp -d); rm -rf $t",
            "t=$(mktemp -d); x=..; rm -rf \"$t/$x\"",
            "t=$(mktemp -d); IFS= read -r t; rm -rf \"$t\"",
            "t=$(mktemp -d); printf -v t %s \"$HOME\"; rm -rf \"$t\"",
            "t=$(mktemp -d); eval t=/; rm -rf \"$t\"",
            "t=$(mktemp -d); t+=/../..; rm -rf \"$t\"",
            "t=$(mktemp -d); t[0]=/; rm -rf \"$t\"",
            "t=$(mktemp -d); case $x in a) t=/ ;; esac; rm -rf \"$t\"",
            "t=$(mktemp -d); : ${t:=/}; rm -rf \"$t\"",
            "t=$(mktemp -d); declare -n r=t; r=/; rm -rf \"$t\"",
            "t=$(mktemp -d) rm -rf \"$t\"/*",
            "t=$(mktemp -d); echo / | xargs rm -rf \"$t\"",
            "t=$(mktemp -d); find / -exec rm -rf \"$t\" \\;",
            "t=$(mktemp -d); rm -rf \"$t\"/.*/x",
            "t=${TMPDIR%$$}; rm -rf \"$t\"",
            "rm -rf \"$t/x\"; t=$(mktemp -d)",
            "s=$t/x; t=$(mktemp -d); rm -rf \"$s\"",
            "f() { d=$t/h.$1; rm -rf \"$d\"; }\nt=$(mktemp -d)",
            "t=$(mktemp -d); d=$t/$1; rm -rf \"$d\"",
            "t=$(mktemp -d); trap \"rm -rf $t\" EXIT",
            "t=$(mktemp -d); set -- ' /'; rm -rf \"$t/a\"$1",
            // a creator that can fail leaves only a bare target; an assignment that may not have run is no own path
            "t=$(mktemp -d)\ns=$t/seen\nrm -rf \"$s\"",
            "t=$(mktemp -d); rm -rf \"$t/x\"",
            "false && t=$(mktemp -d); rm -rf \"$t\"",
            "if false; then t=$(mktemp -d) || exit; fi; rm -rf \"$t/x\"",
            "f() { HOME=$(mktemp -d); }; rm -rf \"$HOME\"",
            "if false; then t=$(mktemp -d) || exit; a=(); fi; rm -rf \"$t/x\"",
            "mktemp() { echo \"$HOME\"; }; t=$(mktemp) || exit; rm -rf \"$t\"",
            "t=$(mktemp -d) || exit\nfi\nrm -rf \"$t/x\"",
            "(t=$(mktemp -d) || exit); rm -rf \"$t/x\"",
            "t=$(mktemp -d) || exit | cat; rm -rf \"$t/x\"",
            "t=$(mktemp -d) || exit | cat\nrm -rf \"$t/x\"",
            "t=$(mktemp -d); trap 'echo / | xargs rm -rf \"$t\"' EXIT",
            "t=$(mktemp -d); export -n t; rm -rf \"$t\"",
        ] {
            assert_eq!(b(t).1, 0, "{t}");
        }
        // off without the lists
        assert_eq!(blank_own_temp("t=$(mktemp -d); rm -rf \"$t\"", &cfg()).1, 0);
    }

    #[test]
    fn issue_928_a_wrapper_options_value_is_no_command() {
        let mut c = cfg();
        c.cmd_wrappers = vec!["sudo".into(), "env".into(), "timeout".into()];
        c.wrapper_opts = vec![("sudo".into(), vec!["-u".into(), "-g".into()]), ("env".into(), vec!["-u".into()]), ("timeout".into(), vec!["-s".into()])];
        let u = |t: &str| normalise(t, &c).map(|n| (n.unknown_cmds, n.opt_skips)).unwrap();
        assert_eq!(u("sudo -u deploy ls"), (vec![], 1));
        assert_eq!(u("sudo -g a -u b ls"), (vec![], 2));
        assert_eq!(u("env -u X ls"), (vec![], 1));
        assert_eq!(u("timeout -s KILL 30 ls"), (vec![], 1));
        // an option not in the list takes no value: its next word is the command, and an unknown one is still reported
        assert_eq!(u("sudo -E zzz"), (vec!["zzz".to_string()], 0));
        // the value is skipped, the command behind it is still read
        assert_eq!(u("sudo -u deploy zzz"), (vec!["zzz".to_string()], 1));
        let mut none = c.clone();
        none.wrapper_opts.clear();
        assert_eq!(normalise("sudo -u deploy ls", &none).map(|n| n.unknown_cmds).unwrap(), vec!["deploy".to_string()]);
    }

    #[test]
    fn issue_928_a_tool_in_a_project_local_dir_inside_the_repo_is_known() {
        let root = std::env::temp_dir().join(format!("ah-928-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root); // keep: this test's own scratch dir, named by pid
        let (repo, other) = (root.join("repo"), root.join("other"));
        let bin = repo.join(".venv/bin");
        let sub = repo.join("pkg/src");
        for d in [&bin, &sub, &other.join(".venv/bin")] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(repo.join(".git"), "gitdir: x").unwrap();
        for p in [bin.join("mytool"), other.join(".venv/bin/mytool")] {
            std::fs::write(&p, "#!/bin/sh\n").unwrap();
            std::fs::set_permissions(&p, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        }
        std::os::unix::fs::symlink(other.join(".venv/bin/mytool"), bin.join("escape")).unwrap();
        std::fs::write(bin.join("plain"), "x").unwrap(); // not executable
        let l = vec![".venv/bin".to_string()];
        let t = |name: &str, d: &std::path::Path| local_tool(name, &[d.to_path_buf()], &l, ".git").is_some();
        assert!(t("mytool", &repo), "in the repo root");
        assert!(t("mytool", &sub), "from a subdirectory, up to the repo root");
        assert!(!t("mytool", &other), "outside any repo");
        assert!(!t("escape", &repo), "a symlink that leaves the repo");
        assert!(!t("plain", &repo), "not executable");
        assert!(!t("absent", &repo));
        assert!(local_tool("mytool", std::slice::from_ref(&repo), &[], ".git").is_none(), "off without the list");
        assert!(local_tool("mytool", std::slice::from_ref(&repo), &l, "").is_none(), "off without the marker");
        assert!(local_tool("../x", std::slice::from_ref(&repo), &l, ".git").is_none(), "a path is no tool name");
        std::fs::remove_dir_all(&root).unwrap(); // keep: this test's own scratch dir
    }
}
