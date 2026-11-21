//! #907: shell-word normalisation for `dispatch.capacity_hold`, std only. One file, two crates: ah-engine (src/dispatch/shellwords.rs)
//! and ah-launcher (src/shellwords.rs) carry byte-identical copies (a test in ah-engine holds them equal), so both matchers read a
//! command the way the shell does before the hold rules see it.
//!
//! What it does: strips in-word quotes and backslashes (`g"i"t pu\sh` becomes `git push`), splits on UNQUOTED separators only (a
//! quoted `;` `&` `|` or newline inside an argument becomes a space, so it neither ends a command nor hides one), blanks the free text
//! a gh pr/issue/release command publishes (its body, title or notes value), and finds a git subcommand that is not a known one (an
//! alias or an external command). It carries no list of its own: every word list comes in through [`Cfg`], read from the plugin's
//! `dispatch.capacity_hold` table.

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
}

/// A command read the shell's way.
pub struct Normalised {
    /// The words joined by one space, the unquoted separators kept as they were, quotes and backslashes gone.
    pub text: String,
    /// True when a gh text value was blanked out of `text`.
    pub stripped: bool,
    /// The first git subcommand that is not in `git_known` (an alias, an external command, a typo), if any.
    pub git_unknown: Option<String>,
}

enum Tok {
    Word(String, bool),
    Sep(&'static str),
}

/// A quoted or escaped separator character is data: a space stands in for it, so it can not end or hide a command.
fn lit(out: &mut String, c: char) {
    out.push(if matches!(c, ';' | '&' | '|' | '\n' | '\r') {
        ' '
    } else {
        c
    });
}

/// Splits `cmd` into words and unquoted separators. `None` when a quote is left open (the caller matches the raw text then). A word is
/// "live" when it holds a substitution (`$(..)`, `${..}`, a backtick) outside single quotes: it can run something.
#[allow(unused_assignments)] // the last flush! resets state nothing reads
fn split(cmd: &str) -> Option<Vec<Tok>> {
    let cs: Vec<char> = cmd.chars().collect();
    let n = cs.len();
    let mut toks: Vec<Tok> = Vec::new();
    let (mut cur, mut live, mut in_word) = (String::new(), false, false);
    let mut i = 0;
    macro_rules! flush {
        () => {
            if in_word {
                toks.push(Tok::Word(std::mem::take(&mut cur), live));
                live = false;
                in_word = false;
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
            '\\' => {
                match next {
                    Some('\n') => {}
                    Some(d) => {
                        in_word = true;
                        lit(&mut cur, d);
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
                    lit(&mut cur, d);
                }
            }
            '"' => {
                in_word = true;
                i += 1;
                loop {
                    let d = *cs.get(i)?;
                    i += 1;
                    match d {
                        '"' => break,
                        '\\' => match cs.get(i).copied() {
                            Some(e @ ('$' | '`' | '"' | '\\')) => {
                                lit(&mut cur, e);
                                i += 1;
                            }
                            Some('\n') => i += 1,
                            _ => cur.push('\\'),
                        },
                        '`' => {
                            live = true;
                            cur.push(d);
                        }
                        '$' => {
                            if matches!(cs.get(i), Some('(' | '{')) {
                                live = true;
                            }
                            cur.push(d);
                        }
                        _ => lit(&mut cur, d),
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
                                'n' | 't' | 'r' => cur.push(' '),
                                'x' | '0'..='7' => {
                                    let radix = if e == 'x' { 16 } else { 8 };
                                    let mut v = if e == 'x' {
                                        0
                                    } else {
                                        e.to_digit(8).unwrap_or(0)
                                    };
                                    let mut k = 0;
                                    while k < if e == 'x' { 2 } else { 2 } {
                                        match cs.get(i).and_then(|h| h.to_digit(radix)) {
                                            Some(h) => {
                                                v = v * radix + h;
                                                i += 1;
                                                k += 1;
                                            }
                                            None => break,
                                        }
                                    }
                                    lit(&mut cur, char::from_u32(v).unwrap_or(' '));
                                }
                                other => lit(&mut cur, other),
                            }
                        }
                        _ => lit(&mut cur, d),
                    }
                }
            }
            ';' | '\n' => {
                flush!();
                toks.push(Tok::Sep(if c == ';' { ";" } else { "\n" }));
                i += 1;
            }
            '|' => {
                if i > 0 && cs[i - 1] == '>' && in_word {
                    cur.push('|');
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
                } else if (i > 0 && matches!(cs[i - 1], '>' | '<') && in_word) || next == Some('>')
                {
                    in_word = true;
                    cur.push('&');
                    i += 1;
                } else {
                    flush!();
                    toks.push(Tok::Sep("&"));
                    i += 1;
                }
            }
            _ => {
                in_word = true;
                if c == '`' || (c == '$' && matches!(next, Some('(' | '{'))) {
                    live = true;
                }
                cur.push(c);
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
    word.split_once('=').is_some_and(|(k, _)| {
        !k.is_empty()
            && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !k.starts_with(|c: char| c.is_ascii_digit())
    })
}

/// Reads `cmd` the way the shell does. `None` when a quote is left open: the caller then matches the raw text only.
pub fn normalise(cmd: &str, cfg: &Cfg) -> Option<Normalised> {
    let toks = split(cmd)?;
    let (mut text, mut stripped, mut git_unknown) = (String::new(), false, None);
    let mut group: Vec<(String, bool)> = Vec::new();
    let emit = |group: &mut Vec<(String, bool)>,
                text: &mut String,
                stripped: &mut bool,
                git_unknown: &mut Option<String>| {
        if group.is_empty() {
            return;
        }
        // gh <pr|issue|release> ...: the value words of the text options are data
        if !cfg.text_verb.is_empty() {
            if let Some(v) = group.iter().position(|(w, _)| base(w) == cfg.text_verb) {
                let sub = group[v + 1..]
                    .iter()
                    .map(|(w, _)| w.as_str())
                    .find(|w| cfg.text_subs.iter().any(|s| s == w) || *w == "api");
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
                        if let Some(o) = cfg
                            .text_opts
                            .iter()
                            .find(|o| o.starts_with("--") && w.starts_with(&format!("{o}=")))
                        {
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
            for j in 0..group.len() {
                if base(&group[j].0) != "git" {
                    continue;
                }
                let at_command = group[..j].iter().all(|(w, _)| is_assign(w))
                    || group[..j]
                        .iter()
                        .any(|(w, _)| cfg.git_wrappers.iter().any(|x| x == base(w)));
                if !at_command {
                    continue;
                }
                let mut k = j + 1;
                while k < group.len() {
                    let w = group[k].0.as_str();
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
        for (w, _) in group.iter() {
            if w.is_empty() {
                continue;
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
            Tok::Word(w, live) => group.push((w, live)),
            Tok::Sep(s) => {
                emit(&mut group, &mut text, &mut stripped, &mut git_unknown);
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
    emit(&mut group, &mut text, &mut stripped, &mut git_unknown);
    Some(Normalised {
        text,
        stripped,
        git_unknown,
    })
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
            git_wrappers: v(&["sudo", "env", "time"]),
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
        assert_eq!(
            n("gh pr merge 1 --body=\"x git push\"").text,
            "gh pr merge 1 --body="
        );
        assert!(!n("gh api repos/o/r -f body=x").stripped);
        assert!(
            !n("gh issue create --body \"$(git push -f)\"").stripped,
            "a value that runs something stays live"
        );
        assert!(
            !n("echo --body 'git push'").stripped,
            "only a gh command's values are data"
        );
    }

    #[test]
    fn a_git_subcommand_outside_the_known_ones_is_found() {
        assert_eq!(n("git pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("git -C /r -c a=b pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(
            n("FOO=1 /usr/bin/git pf").git_unknown.as_deref(),
            Some("pf")
        );
        assert_eq!(n("sudo git pf").git_unknown.as_deref(), Some("pf"));
        assert_eq!(n("git status && git zz").git_unknown.as_deref(), Some("zz"));
        assert_eq!(n("git status").git_unknown, None);
        assert_eq!(n("git").git_unknown, None);
        assert_eq!(
            n("ls ~/git foo").git_unknown,
            None,
            "git as an argument is not a git command"
        );
    }
}
