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
    /// #928: the project-local tool directories (`.venv/bin`, `node_modules/.bin`, `target/debug`) whose executables are known
    /// commands when they resolve inside the repo, and the entry (`.git`) that marks the repo root. Empty = off.
    pub local_dirs: Vec<String>,
    /// The entry that marks the repo root.
    pub repo_marker: String,
    /// #928: per wrapper word (`sudo`, `env`, `nice`, `timeout`), the options that take the next word as their value, so that
    /// value is not read as the command.
    pub wrapper_opts: Vec<(String, Vec<String>)>,
    /// #928 (Codex review): per wrapper word, the options (a subset of `wrapper_opts`' values, plus attached spellings
    /// `--opt=VALUE` / `-oVALUE`) whose value is itself a command line (`env -S './x.sh'`): the value is read again as a command,
    /// so a script it names is resolved like a top-level one.
    pub wrapper_split_opts: Vec<(String, Vec<String>)>,
    /// The parsed read exemption ([`read_only_parts`]): the separators that end one command of a list (`&&`, `;`, a newline ...;
    /// empty = the exemption is off). A pipe `|` joins the commands of one pipeline; any other separator exempts nothing.
    pub ro_seps: Vec<String>,
    /// The commands that only change the directory (`cd`, `pushd`), dropped from the list when alone in their pipeline.
    pub ro_skip: Vec<String>,
    /// The variables whose `$NAME` / `${NAME}` may stand in an argument (`HOME`, `PWD`, `TMPDIR`): set by the environment, a path
    /// or a name, never a flag. Any other expansion exempts nothing.
    pub ro_vars: Vec<String>,
    /// The word an allowed variable is read as (the read exemption's pattern then sees no `$`).
    pub ro_placeholder: String,
    /// The variable that holds the home directory (`HOME`): a leading `$HOME/`, `${HOME}/` or the home path itself reads as `~/`
    /// in a command word and an assignment's value.
    pub ro_home: String,
    /// The engine's own binary, as a command word or an assignment's value may spell it (`ah-engine`, `~/.anti-hall/...`). Only a
    /// variable assigned one of these (`E=<path>; "$E" status`) may stand in a command word.
    pub ro_programs: Vec<String>,
    /// The engine's local, reversible verbs: per entry, its leading words (`*` = any one word) and the flags (words that start
    /// with `-`) that must stand as a whole word somewhere after the program (`config set --check`).
    pub ro_verbs: Vec<String>,
    /// #969: the shells whose code argument (`bash -c '..'`, and `eval ..`'s words) runs as a command: its command words count as
    /// the call's own ([`Normalised::cmds`]); a quoted argument of any other program never does.
    pub ro_shells: Vec<String>,
}

/// What the parsed read exemption ([`read_only_parts`]) made of one pipeline of a command list.
#[derive(Debug, PartialEq, Eq)]
pub enum Part {
    /// A pipeline as text, its expansions resolved: the caller's read pattern must match all of it.
    Read(String),
    /// An engine verb of `ro_verbs` and the rest of its pipeline (`head -5 | grep x`, empty = none), which the caller's read
    /// pattern must match.
    Local(String),
}

/// `word` with its expansions resolved for the parsed read exemption, `None` when one is not allowed: a variable assigned earlier
/// in the list (`vars`) reads as its value, an allowed variable (`ro_vars`) as `ro_placeholder` (in a command word only the home
/// variable at its start, read as `~`); `${..}` with an operator, `${!x}`, a positional or special parameter, `$(..)`, a backtick
/// and `<(..)`/`>(..)` exempt nothing.
fn ro_expand(word: &str, vars: &[(String, String)], cfg: &Cfg, home: Option<&std::ffi::OsStr>, command: bool) -> Option<String> {
    if word.contains('`') || word.contains("<(") || word.contains(">(") {
        return None;
    }
    let name_char = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let cs: Vec<char> = word.chars().collect();
    let (mut out, mut i) = (String::new(), 0);
    while i < cs.len() {
        if cs[i] != '$' {
            out.push(cs[i]);
            i += 1;
            continue;
        }
        let (name, next): (String, usize) = if cs.get(i + 1) == Some(&'{') {
            let close = cs[i + 2..].iter().position(|c| *c == '}')? + i + 2;
            (cs[i + 2..close].iter().collect(), close + 1)
        } else {
            let len = cs[i + 1..].iter().take_while(|c| name_char(**c)).count();
            (cs[i + 1..i + 1 + len].iter().collect(), i + 1 + len)
        };
        if name.is_empty() || !name.chars().all(name_char) || name.starts_with(|c: char| c.is_ascii_digit()) {
            return None;
        }
        if let Some((_, v)) = vars.iter().find(|(k, _)| *k == name) {
            out.push_str(v);
        } else if command {
            if i != 0 || cfg.ro_home.is_empty() || name != cfg.ro_home {
                return None;
            }
            out.push('~');
        } else if cfg.ro_vars.iter().any(|v| *v == name) {
            out.push_str(&cfg.ro_placeholder);
        } else {
            return None;
        }
        i = next;
    }
    let under_home = home.and_then(|h| h.to_str()).filter(|h| command && !h.is_empty()).and_then(|h| out.strip_prefix(h)).filter(|r| r.starts_with('/'));
    Some(under_home.map_or_else(|| out.clone(), |rest| format!("~{rest}")))
}

/// Whether `word` (a command word as written, or a script path a command runs) is the engine's own binary (`ro_programs`, the home
/// directory read as `~`): it is never read as a script (#969: it is far over any read cap and would be held as unread).
pub fn is_engine_program(word: &str, cfg: &Cfg, home: Option<&std::ffi::OsStr>) -> bool {
    !cfg.ro_programs.is_empty() && ro_expand(word, &[], cfg, home, true).is_some_and(|w| cfg.ro_programs.iter().any(|p| *p == w))
}

/// Whether the words after the engine program are one of its local verbs (`ro_verbs`).
fn ro_verb(words: &[String], verbs: &[String]) -> bool {
    verbs.iter().any(|v| {
        let (flags, lead): (Vec<&str>, Vec<&str>) = v.split_whitespace().partition(|w| w.starts_with('-'));
        !lead.is_empty()
            && lead.len() <= words.len()
            && lead.iter().zip(words).all(|(p, w)| *p == "*" || *p == w.as_str())
            && flags.iter().all(|f| words.iter().any(|w| w.as_str() == *f))
    })
}

/// The parsed read exemption of `dispatch.capacity_hold` (`parsed`): the pipelines of a command list the caller's read pattern
/// must pass, `None` when the list can not be read this way (the exemption then exempts nothing and the rules decide). A bare
/// `cd <dir>` alone in its pipeline (`ro_skip`, no redirection) is dropped; an assignment alone (`E=<the engine binary>`, `ro_programs`) is dropped and its variable
/// may stand in a later command word (`"$E" mesh send ..`); an allowed variable in an argument is read as `ro_placeholder`; the
/// engine's own program with a local verb (`ro_verbs`, no redirection) is a [`Part::Local`]. A heredoc, a substitution, an
/// assignment in front of a command, a separator outside `ro_seps` and `|`, or any other expansion exempts nothing. `home` is the
/// home directory's path (a command word that starts with it reads as `~/`).
pub fn read_only_parts(cmd: &str, cfg: &Cfg, home: Option<&std::ffi::OsStr>) -> Option<Vec<Part>> {
    if cfg.ro_seps.is_empty() {
        return None;
    }
    let mut lists: Vec<Vec<Vec<String>>> = vec![vec![Vec::new()]];
    for t in split(cmd, cfg)? {
        match t {
            Tok::Body(..) => return None,
            Tok::Sep(s) if cfg.ro_seps.iter().any(|x| x == s) => lists.push(vec![Vec::new()]),
            Tok::Sep("|") => lists.last_mut()?.push(Vec::new()),
            Tok::Sep(_) => return None,
            Tok::Word(w, ..) => lists.last_mut()?.last_mut()?.push(w),
        }
    }
    let mut vars: Vec<(String, String)> = Vec::new();
    let mut parts = Vec::new();
    for pipe in lists {
        if pipe.len() == 1 && pipe[0].is_empty() {
            continue;
        }
        if pipe.iter().any(Vec::is_empty) {
            return None;
        }
        let first = &pipe[0];
        if first.iter().all(|w| is_assign(w)) {
            if pipe.len() > 1 {
                return None;
            }
            for w in first {
                let (k, v) = w.split_once('=')?;
                let v = ro_expand(v, &vars, cfg, home, true)?;
                if !cfg.ro_programs.iter().any(|p| *p == v) {
                    return None;
                }
                vars.retain(|(n, _)| n != k);
                vars.push((k.to_string(), v));
            }
            continue;
        }
        // only a bare `cd <dir>` is dropped: one with a redirection or more words is left for the read pattern (and so the rules)
        if pipe.len() == 1 && first.len() <= 2 && !first.iter().any(|w| is_redir(w)) && cfg.ro_skip.iter().any(|s| *s == first[0]) {
            for w in &first[1..] {
                ro_expand(w, &vars, cfg, home, false)?;
            }
            continue;
        }
        let prog = ro_expand(&first[0], &vars, cfg, home, true)?;
        let args = first[1..].iter().map(|w| ro_expand(w, &vars, cfg, home, false)).collect::<Option<Vec<_>>>()?;
        let mut tail = Vec::new();
        for el in &pipe[1..] {
            tail.push(el.iter().map(|w| ro_expand(w, &vars, cfg, home, false)).collect::<Option<Vec<_>>>()?.join(" "));
        }
        let tail = tail.join(" | ");
        if cfg.ro_programs.iter().any(|p| *p == prog) {
            if args.iter().any(|w| is_redir(w)) || !ro_verb(&args, &cfg.ro_verbs) {
                return None;
            }
            parts.push(Part::Local(tail));
        } else {
            let head = std::iter::once(prog).chain(args).collect::<Vec<_>>().join(" ");
            parts.push(Part::Read(if tail.is_empty() { head } else { format!("{head} | {tail}") }));
        }
    }
    Some(parts)
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
    /// #969: the command words the top level runs (wrappers, assignments and redirections skipped), as written: what is called, never
    /// an argument that only names a program (`pgrep -f 'ah-engine serve'`).
    pub cmds: Vec<String>,
    /// #969: the code a shell named in `ro_shells` runs (`bash -c '..'`, `eval ..`), read again by [`normalise`] for its commands.
    pub shell_code: Vec<String>,
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
fn command_at<'a>(
    group: &'a [(String, bool, String)],
    wrappers: &[String],
    opts: &[(String, Vec<String>)],
    split_opts: &[(String, Vec<String>)],
    skips: &mut usize,
    splits: &mut Vec<String>,
) -> Option<(&'a str, usize)> {
    let wrapper = |w: &str| wrappers.iter().any(|x| x.eq_ignore_ascii_case(base(w)));
    let mut wrapped = false;
    let (mut cur, mut skip_value, mut split_value) = (String::new(), false, false);
    let is_split = |cur: &str, o: &str| split_opts.iter().any(|(k, os)| k == cur && os.iter().any(|x| x == o));
    for (i, (word, _, raw)) in group.iter().enumerate() {
        if skip_value {
            skip_value = false;
            *skips += 1;
            // the value of a split option is a command line: read it again as one
            if std::mem::take(&mut split_value) {
                splits.push(raw.clone());
            }
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
            split_value = is_split(&cur, w);
            continue;
        }
        // the same option with its value attached (`--split-string=./x.sh`, `-S./x.sh`)
        if wrapped && w.starts_with('-') {
            let attached = split_opts.iter().filter(|(k, _)| *k == cur).flat_map(|(_, os)| os.iter()).find_map(|o| {
                let long = o.starts_with("--");
                let rest = if long { w.strip_prefix(o.as_str()).and_then(|r| r.strip_prefix('=')) } else { w.strip_prefix(o.as_str()) };
                rest.filter(|r| !r.is_empty())
            });
            if let Some(v) = attached {
                splits.push(v.to_string());
                continue;
            }
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

/// The file a script path names: a leading `~` is `home`; a relative path is found from the last of `dirs` that holds it (the directory the
/// command changed to last before the one it started in). `None` when it is no regular file.
pub fn script_file(path: &str, dirs: &[std::path::PathBuf], home: Option<&std::ffi::OsStr>) -> Option<(std::path::PathBuf, std::fs::Metadata)> {
    let p = tilde(path, home);
    let found = if p.is_absolute() || dirs.is_empty() {
        std::fs::metadata(&p).ok().map(|m| (p.clone(), m))
    } else {
        dirs.iter().rev().map(|d| d.join(&p)).find_map(|f| std::fs::metadata(&f).ok().filter(|m| m.is_file()).map(|m| (f, m)))
    };
    found.filter(|(_, m)| m.is_file())
}

/// Reads the script at `path` (see [`script_file`]) when it is at most
/// `cap` bytes (0 = never read), or as written when it is at most `scan` bytes.
pub fn read_script(path: &str, dirs: &[std::path::PathBuf], home: Option<&std::ffi::OsStr>, cap: usize, scan: usize) -> Script {
    use std::io::Read;
    if cap == 0 {
        return Script::Skip;
    }
    let Some((full, meta)) = script_file(path, dirs, home) else { return Script::Skip };
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

/// #928: the bytes of the script `path` names (see [`script_file`]) when it is at most `max` bytes, with its repo-relative path
/// (the real path below the nearest parent that holds `marker`, `/`-separated): what the trusted-scripts list is matched against.
/// `None` for a file that is no regular file, too big, unreadable, outside any repo or whose real path is not valid UTF-8.
pub fn script_identity(path: &str, dirs: &[std::path::PathBuf], home: Option<&std::ffi::OsStr>, max: usize, marker: &str) -> Option<(String, Vec<u8>)> {
    use std::io::Read;
    if max == 0 || marker.is_empty() {
        return None;
    }
    let (full, meta) = script_file(path, dirs, home)?;
    if usize::try_from(meta.len()).map_or(true, |n| n > max) {
        return None;
    }
    let real = std::fs::canonicalize(full).ok()?;
    let root = real.ancestors().skip(1).find(|a| a.join(marker).exists())?;
    let rel = real.strip_prefix(root).ok()?.to_str()?.replace(std::path::MAIN_SEPARATOR, "/");
    let mut bytes = Vec::new();
    std::fs::File::open(&real).and_then(|f| f.take(max as u64 + 1).read_to_end(&mut bytes)).ok()?;
    (bytes.len() <= max).then_some((rel, bytes))
}

/// #928: whether `text` matches the path glob `pat`: `*` is any run of characters but `/`, `**` any run (slashes too), `?` one
/// character but `/`; everything else is itself.
pub fn glob_match(pat: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        match p.split_first() {
            None => t.is_empty(),
            Some((b'*', rest)) if rest.first() == Some(&b'*') => {
                let rest = &rest[1..];
                (0..=t.len()).any(|i| go(rest, &t[i..]))
            }
            Some((b'*', rest)) => (0..=t.len()).take_while(|&i| i == 0 || t[i - 1] != b'/').any(|i| go(rest, &t[i..])),
            Some((b'?', rest)) => t.first().is_some_and(|&c| c != b'/') && go(rest, &t[1..]),
            Some((c, rest)) => t.first() == Some(c) && go(rest, &t[1..]),
        }
    }
    go(pat.as_bytes(), text.as_bytes())
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
    // #969: the commands of a shell's code (`bash -c '..'`, `eval ..`) are the call's own, `passes` levels deep
    let mut codes = std::mem::take(&mut n.shell_code);
    for _ in 0..cfg.passes {
        let mut next = Vec::new();
        for c in codes.drain(..) {
            if let Some((m, _)) = once(unwrap_sub(&c), cfg, 1) {
                merge(&mut n.cmds, m.cmds);
                next.extend(m.shell_code);
            }
        }
        if next.is_empty() {
            break;
        }
        codes = next;
    }
    Some(n)
}

/// What one reading of a command found besides its text (see the fields of [`Normalised`]).
#[derive(Default)]
struct Found {
    cmds: Vec<String>,
    shell_code: Vec<String>,
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
            let mut splits = Vec::new();
            let at_cmd = command_at(seg, &cfg.cmd_wrappers, &cfg.wrapper_opts, &cfg.wrapper_split_opts, &mut more.opt_skips, &mut splits);
            nested.extend(splits);
            let Some((cmd, at)) = at_cmd else { continue };
            merge(&mut more.cmds, vec![cmd.to_string()]);
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
            // #969: the code a shell runs is a command line of the call's own (its commands count for engine-unlisted)
            if cfg.ro_shells.iter().any(|sh| sh == base(cmd)) {
                let rest = &seg[at + 1..];
                let code = if cfg.script_inline_flags.is_empty() || base(cmd) == "eval" {
                    Some(rest.iter().map(|(_, _, r)| r.as_str()).collect::<Vec<_>>().join(" "))
                } else {
                    rest.iter().position(|(w, ..)| cfg.script_inline_flags.iter().any(|f| f == w)).and_then(|f| rest.get(f + 1)).map(|(_, _, r)| r.clone())
                };
                if let Some(c) = code.filter(|c| !c.trim().is_empty()) {
                    more.shell_code.push(c);
                }
            }
            // `eval` read as a wrapper (its next word taken for the command): its words are the code it runs
            if let Some(k) = seg[..at].iter().position(|(w, ..)| base(w) == "eval" && cfg.ro_shells.iter().any(|sh| sh == "eval")) {
                let c = seg[k + 1..].iter().map(|(_, _, r)| r.as_str()).collect::<Vec<_>>().join(" ");
                if !c.trim().is_empty() {
                    more.shell_code.push(c);
                }
            }
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
    let Found { cmds, shell_code, gh_unknown, unknown_cmds, scripts, cds, opt_skips } = found;
    Some((Normalised { text, stripped, git_unknown, extra, gh_unknown, unknown_cmds, scripts, cds, opt_skips, cmds, shell_code }, nested))
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
    fn ro_cfg() -> Cfg {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        Cfg {
            ro_seps: v(&["&&", ";", "\n", "||", "&"]),
            ro_skip: v(&["cd", "pushd"]),
            ro_vars: v(&["HOME", "TMPDIR"]),
            ro_placeholder: "_".into(),
            ro_home: "HOME".into(),
            ro_programs: v(&["ah-engine", "~/.anti-hall/ah-engine/bin/ah-engine"]),
            ro_verbs: v(&["mesh send", "status", "config set --check", "agents nudge * msg"]),
            ..cfg()
        }
    }

    /// The parsed read exemption: a cd in front is dropped, an allowed variable reads as the placeholder, the engine binary in a
    /// variable resolves, an engine-local verb is a Local part; anything it can not vouch for gives no parts at all.
    #[test]
    fn read_only_parts_reads_lists_variables_and_engine_verbs() {
        let c = ro_cfg();
        let home = Some(std::ffi::OsStr::new("/Users/me"));
        let parts = |cmd: &str| read_only_parts(cmd, &c, home);
        let read = |t: &str| Part::Read(t.to_string());
        let local = |t: &str| Part::Local(t.to_string());
        assert_eq!(parts("cd \"$HOME/x\" && grep -rn memo . | head -15"), Some(vec![read("grep -rn memo . | head -15")]));
        assert_eq!(parts("grep x \"${TMPDIR}/y\" $HOME"), Some(vec![read("grep x _/y _")]));
        assert_eq!(parts("E=\"$HOME/.anti-hall/ah-engine/bin/ah-engine\"; \"$E\" mesh send --to a --message \"git push\""), Some(vec![local("")]));
        assert_eq!(parts("E=/Users/me/.anti-hall/ah-engine/bin/ah-engine; $E status | head -3"), Some(vec![local("head -3")]), "the home path reads as ~");
        assert_eq!(parts("ah-engine config set daemon.nice 0 --check"), Some(vec![local("")]));
        assert_eq!(parts("ah-engine agents nudge abc msg hi"), Some(vec![local("")]), "* is any one word");
        assert_eq!(parts("cd x; ls -la"), Some(vec![read("ls -la")]), "the caller's read pattern judges what is left");
        assert_eq!(parts("cd /tmp > f && ls"), Some(vec![read("cd /tmp > f"), read("ls")]), "a cd with a redirection is not dropped");
        assert_eq!(parts("cd -P /tmp && ls"), Some(vec![read("cd -P /tmp"), read("ls")]), "only a bare cd <dir> is dropped");
        assert_eq!(parts("A=1 grep x"), Some(vec![read("A=1 grep x")]), "an assignment in front of a command is left for the read pattern to refuse");
        for (cmd, why) in [
            ("ah-engine config set daemon.nice 0", "config set without --check writes"),
            ("ah-engine config set daemon.nice 0 --check=x", "the flag must stand as a whole word"),
            ("ah-engine agents nudge abc stop", "a verb not on the list"),
            ("ah-engine --json status", "the verb words lead"),
            ("ah-engine status >out", "a redirection"),
            ("E=/tmp/evil; \"$E\" status", "an assignment of anything but the engine"),
            ("E=ah-engine \"$E\" status", "a prefix assignment resolves nothing"),
            ("$X status", "a variable in a command word not assigned earlier"),
            ("$TMPDIR/ah-engine status", "only the home variable leads a command word"),
            ("grep x \"$PAT\"", "a variable not on the list"),
            ("grep x \"${HOME:-/tmp}\"", "an expansion with an operator"),
            ("grep x \"${!HOME}\"", "an indirect expansion"),
            ("grep x \"$1\" \"$@\"", "positional and special parameters"),
            ("grep x \"$(git push)\"", "a substitution"),
            ("grep x `date`", "a backtick"),
            ("cat <(git push)", "a process substitution"),
            ("cd \"$(git push)\" && ls", "a substitution in a cd"),
            ("cat <<EOF\nx\nEOF", "a heredoc"),
            ("grep x |& head", "a separator outside the list"),
            ("grep x | | head", "an empty pipeline element"),
        ] {
            assert_eq!(parts(cmd), None, "{why}: {cmd:?}");
        }
        assert_eq!(read_only_parts("cd x; ls", &cfg(), home), None, "no separators = off");
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
        assert_eq!(n("pgrep -fl 'ah-engine serve' && sudo ah-engine status").cmds, ["pgrep", "ah-engine"], "a quoted mention is no command");
        let sh = Cfg { ro_shells: vec!["bash".into(), "sh".into(), "eval".into()], ..cfg() };
        let wrapped = Cfg { cmd_wrappers: vec!["eval".into(), "sudo".into()], ..sh.clone() };
        assert!(normalise("sudo eval \"ah-engine agents stop x\"", &wrapped).unwrap().cmds.contains(&"ah-engine".to_string()), "eval as a wrapper");
        let cmds = |c: &str| normalise(c, &sh).unwrap().cmds;
        assert_eq!(cmds("bash -c 'ah-engine agents stop x'"), ["bash", "ah-engine"], "a shell's code is the call's own");
        assert_eq!(cmds("eval \"ah-engine agents stop x\""), ["eval", "ah-engine"]);
        assert_eq!(cmds("sh -c \"bash -c 'ah-engine status'\""), ["sh", "bash", "ah-engine"], "nested shells");
        assert_eq!(cmds("echo 'ah-engine agents stop x'"), ["echo"], "an echo argument is no command");
        assert_eq!(cmds("grep -r 'bash -c ah-engine' ."), ["grep"]);
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

    #[test]
    fn issue_928_glob_match_reads_star_as_one_component_and_double_star_as_any() {
        assert!(glob_match("ah-engine/test.sh", "ah-engine/test.sh"));
        assert!(!glob_match("ah-engine/test.sh", "ah-engine/test.shx"));
        assert!(!glob_match("ah-engine/test.sh", "x/ah-engine/test.sh"));
        assert!(glob_match("ah-engine/*.sh", "ah-engine/test.sh"));
        assert!(!glob_match("ah-engine/*.sh", "ah-engine/tests/wrapper.sh"));
        assert!(glob_match("ah-engine/**/wrapper.sh", "ah-engine/tests/wrapper.sh"));
        assert!(glob_match("a/t?.sh", "a/t1.sh"));
        assert!(!glob_match("a/t?.sh", "a/t/.sh"));
    }

    #[test]
    fn issue_928_a_script_is_identified_by_its_repo_relative_path_and_bytes() {
        let root = std::env::temp_dir().join(format!("ah-928id-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root); // keep: this test's own scratch dir, named by pid
        let (repo, out) = (root.join("repo"), root.join("out"));
        std::fs::create_dir_all(repo.join("ah-engine")).unwrap();
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(repo.join(".git"), "gitdir: x").unwrap();
        std::fs::write(repo.join("ah-engine/test.sh"), "echo hi\n").unwrap();
        std::fs::write(out.join("t.sh"), "echo hi\n").unwrap();
        let id = |p: &str, d: &std::path::Path, max| script_identity(p, &[d.to_path_buf()], None, max, ".git");
        assert_eq!(id("ah-engine/test.sh", &repo, 100), Some(("ah-engine/test.sh".to_string(), b"echo hi\n".to_vec())));
        assert_eq!(id("./test.sh", &repo.join("ah-engine"), 100).map(|x| x.0).as_deref(), Some("ah-engine/test.sh"), "from a subdirectory");
        assert!(id("t.sh", &out, 100).is_none(), "outside any repo");
        assert!(id("ah-engine/test.sh", &repo, 3).is_none(), "over the cap");
        assert!(id("ah-engine/test.sh", &repo, 0).is_none(), "off");
        assert!(script_identity("ah-engine/test.sh", &[repo.clone()], None, 100, "").is_none(), "off without the marker");
        std::fs::remove_dir_all(&root).unwrap(); // keep: this test's own scratch dir
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

    /// #928 (Codex review): the value of a split option (`env -S './x.sh'`) is a command line: a script it names is read as one.
    #[test]
    fn issue_928_a_split_string_value_is_read_as_a_command_line() {
        let mut c = cfg();
        c.wrapper_opts = vec![("env".into(), vec!["-u".into(), "-S".into()])];
        c.wrapper_split_opts = vec![("env".into(), vec!["-S".into()])];
        let s = |t: &str| normalise(t, &c).map(|n| n.scripts).unwrap();
        assert_eq!(s("env -S ./x.sh"), ["./x.sh"]);
        assert_eq!(s("env -S./x.sh"), ["./x.sh"]);
        assert_eq!(s("env -S 'FOO=1 ./x.sh'"), ["./x.sh"]);
        assert!(s("env -S 'echo hi'").is_empty());
        assert!(s("env -u ./x.sh ls").is_empty(), "an option that is no split option still only skips its value");
        let mut off = c.clone();
        off.wrapper_split_opts.clear();
        assert!(normalise("env -S ./x.sh", &off).unwrap().scripts.is_empty());
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
