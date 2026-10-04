//! xargs / find -exec / parallel / stdin-script handling (placeholders, appended input words).
use super::gitcmd::*;
use super::payloads::*;
use super::scan::{git_verdict, scan_command};
use super::shell::*;
use super::util::*;
use super::Ctx;
use regex::Regex;

#[derive(Clone)]
pub enum Repl {
    S(String),
    R(Regex),
}

const XARGS_SHORT_REQ: &str = "adEILnPsJRS";
const XARGS_SHORT_OPT: &str = "eil";
const XARGS_LONG_REQ: &[&str] = &["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"];
const XARGS_LONG_OTHER: &[&str] = &["null", "eof", "replace", "max-lines", "interactive", "no-run-if-empty", "verbose", "exit", "open-tty", "show-limits", "help", "version"];

pub fn xargs_command_tokens(args: &[Tok]) -> (Vec<Tok>, Vec<Repl>) {
    let mut i = 0usize;
    let mut repls: Vec<Repl> = Vec::new();
    while i < args.len() {
        let w = args[i].text.as_str();
        if w == "--" {
            i += 1;
            break;
        }
        if w == "-" || !w.starts_with('-') {
            break;
        }
        i += 1;
        if let Some(name) = w.strip_prefix("--") {
            if w.starts_with("--replace") {
                repls.push(Repl::S(if let Some(v) = w.strip_prefix("--replace=") { v.to_string() } else { "{}".to_string() }));
            }
            if w.contains('=') {
                continue;
            }
            if XARGS_LONG_OTHER.contains(&name) || XARGS_LONG_REQ.contains(&name) {
                if XARGS_LONG_REQ.contains(&name) {
                    i += 1;
                }
                continue;
            }
            if XARGS_LONG_REQ.iter().any(|o| o.starts_with(name)) && !XARGS_LONG_OTHER.iter().any(|o| o.starts_with(name)) {
                i += 1;
            }
            continue;
        }
        let wc: Vec<char> = w.chars().collect();
        for k in 1..wc.len() {
            let ch = wc[k];
            if XARGS_SHORT_OPT.contains(ch) {
                if ch == 'i' {
                    let rest: String = wc[k + 1..].iter().collect();
                    repls.push(Repl::S(if rest.is_empty() { "{}".into() } else { rest }));
                }
                break;
            }
            if XARGS_SHORT_REQ.contains(ch) {
                let val: String = if k < wc.len() - 1 { wc[k + 1..].iter().collect() } else { args.get(i).map(|t| t.text.clone()).unwrap_or_default() };
                if k == wc.len() - 1 {
                    i += 1;
                }
                if (ch == 'I' || ch == 'J') && !val.is_empty() {
                    repls.push(Repl::S(val));
                }
                break;
            }
        }
    }
    (args[i.min(args.len())..].to_vec(), repls)
}

pub fn xargs_git_verdict(ctx: &mut Ctx, ev: &Ev, d: usize, cmd: &str, hb: &Hb, cwd: Option<&str>, use_jev: bool) -> Option<String> {
    let (tokens, repls) = xargs_command_tokens(&ev.args);
    runner_verdict(ctx, &tokens, "xargs", d, cmd, hb, cwd, use_jev, &repls)
}

pub fn find_exec_verdict(ctx: &mut Ctx, ev: &Ev, d: usize, cmd: &str, hb: &Hb, cwd: Option<&str>, use_jev: bool) -> Option<String> {
    let args = &ev.args;
    let mut i = 0usize;
    while i < args.len() {
        if args[i].quoted_only || !matches!(args[i].text.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir") {
            i += 1;
            continue;
        }
        let mut j = i + 1;
        while j < args.len() && args[j].text != ";" && args[j].text != "\\;" && !(args[j].text == "+" && j > i + 1 && args[j - 1].text == "{}") {
            j += 1;
        }
        let hit = runner_verdict(ctx, &args[i + 1..j.min(args.len())], "find", d, cmd, hb, cwd, use_jev, &[Repl::S("{}".into())]);
        if hit.is_some() {
            return hit;
        }
        i = j + 1;
    }
    None
}

fn is_parallel_sep(s: &str) -> bool {
    matches!(s, ":::" | "::::" | ":::+" | "::::+")
}

pub fn parallel_verdict(ctx: &mut Ctx, ev: &Ev, d: usize, cmd: &str, hb: &Hb, cwd: Option<&str>, use_jev: bool) -> Option<String> {
    let args = &ev.args;
    let s = args.iter().position(|t| is_parallel_sep(&t.text));
    let head: &[Tok] = match s {
        None => args,
        Some(p) => &args[..p],
    };
    let inputs: Vec<Tok> = match s {
        None => Vec::new(),
        Some(p) => args[p..].iter().filter(|t| !is_parallel_sep(&t.text)).cloned().collect(),
    };
    let mut repls: Vec<Repl> = vec![Repl::R(Regex::new(r"\{[^\s{}]*\}").unwrap()), Repl::S("{=".into())];
    for k in 0..head.len() {
        let w = head[k].text.as_str();
        if w == "-I" && k + 1 < head.len() {
            repls.push(Repl::S(head[k + 1].text.clone()));
        } else if w.chars().count() > 2 && w.starts_with("-I") {
            repls.push(Repl::S(w[2..].to_string()));
        } else if w.starts_with("--replace=") && w.chars().count() > 10 {
            repls.push(Repl::S(w[10..].to_string()));
        }
    }
    let mut certain = false;
    let mut k = 0;
    while k < head.len() && !certain {
        if head[k].text.starts_with('-') {
            k += 1;
            continue;
        }
        certain = k == 0 || !head[k - 1].text.starts_with('-');
        let mut toks: Vec<Tok> = head[k..].to_vec();
        toks.extend(inputs.iter().cloned());
        let mut hit = runner_verdict(ctx, &toks, "parallel", d, cmd, hb, cwd, use_jev, &repls);
        if hit.is_none() {
            let line = head[k..].iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" ");
            for seg in split_segments(&line) {
                let mut t2 = tokenize(&seg);
                t2.extend(inputs.iter().cloned());
                hit = runner_verdict(ctx, &t2, "parallel", d, cmd, hb, cwd, use_jev, &repls);
                if hit.is_some() {
                    break;
                }
            }
        }
        if hit.is_some() {
            return hit;
        }
        k += 1;
    }
    if !certain && d < 3 {
        for t in &inputs {
            let hit = scan_command(ctx, &t.text, d + 1, cwd);
            if hit.is_some() {
                return hit;
            }
        }
        if inputs.is_empty() && s.is_none() {
            return stdin_script_verdict(ctx, cmd, d, cwd);
        }
    }
    None
}

fn has_repl(w: &str, repls: &[Repl]) -> bool {
    repls.iter().any(|r| match r {
        Repl::S(s) => w.contains(s.as_str()),
        Repl::R(re) => re.is_match(w),
    })
}

pub fn placeholder_verdict(ev: &Ev, repls: &[Repl]) -> Option<String> {
    if repls.is_empty() {
        return None;
    }
    let mut unknown = has_repl(&ev.verb, repls);
    if !unknown && ev.verb == "git" {
        let (sub, rest) = git_subcommand(&ev.args);
        let n = ev.args.len() as isize - rest.len() as isize;
        // JS: `n >= 0 && (!rest.length || rest[0] === ev.args[n])` (object identity)
        let same_first = n >= 0 && (rest.is_empty() || ((n as usize) < ev.args.len() && rest[0].text == ev.args[n as usize].text && rest[0].raw == ev.args[n as usize].raw && rest[0].quoted_only == ev.args[n as usize].quoted_only));
        let pre: &[Tok] = if same_first { &ev.args[..n as usize] } else { &ev.args[..] };
        unknown = sub.as_deref().map_or(false, |s| has_repl(s, repls)) || pre.iter().any(|t| has_repl(&t.text, repls));
    }
    if !unknown || !(is_force_push(&ev.args) || is_delete_ref_push(&ev.args)) {
        return None;
    }
    Some(msg(
        "a command whose name or git subcommand is an xargs / find / parallel placeholder, with a force or delete flag, is blocked.",
        "The placeholder is filled from input at run time, so the command may be `git push`.",
        "run the git command directly with an explicit subcommand and arguments.",
    ))
}

fn forceish_anywhere(cmd: &str) -> bool {
    let sep = |c: char| is_js_space(c) || "'\"`;|&()<>\\".contains(c);
    let mut texts: Vec<String> = cmd.split(sep).map(|s| s.to_string()).collect();
    for seg in split_segments(cmd) {
        for t in tokenize(&seg) {
            texts.extend(t.text.split(is_js_space).map(|s| s.to_string()));
        }
    }
    let words: Vec<Tok> = texts.into_iter().filter(|s| !s.is_empty()).map(|s| Tok { text: s, quoted_only: false, raw: None }).collect();
    is_force_push(&words) || is_delete_ref_push(&words)
}

fn is_redirect_word(w: &str) -> bool {
    let t = w.trim_start_matches(|c: char| c.is_ascii_digit());
    t.starts_with('<') || t.starts_with('>') || t.starts_with("&>")
}

fn is_bare_redirect(w: &str) -> bool {
    let t = w.trim_start_matches(|c: char| c.is_ascii_digit());
    let t = t.strip_suffix('-').unwrap_or(t);
    matches!(t, "<" | "<<" | "<<<" | ">" | ">>" | "&>" | "&>>" | ">&" | "<&" | "<>" | ">|")
}

fn drop_redirects(args: &[Tok]) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let w = args[i].text.as_str();
        if args[i].quoted_only || !is_redirect_word(w) {
            out.push(args[i].clone());
            i += 1;
            continue;
        }
        if is_bare_redirect(w) {
            i += 1;
        }
        i += 1;
    }
    out
}

pub fn stdin_script_verdict(ctx: &mut Ctx, cmd: &str, d: usize, cwd: Option<&str>) -> Option<String> {
    if d >= 3 {
        return None;
    }
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"'([^']*)'|"((?:[^"\\]|\\(?s:.))*)""#).unwrap());
    let mut texts: Vec<String> = Vec::new();
    for m in re.captures_iter(cmd) {
        texts.push(m.get(1).or_else(|| m.get(2)).map(|x| x.as_str().to_string()).unwrap_or_default());
    }
    for seg in split_segments(cmd) {
        if let Some(ev) = effective_verb(&tokenize(&seg)) {
            if ev.verb == "echo" || ev.verb == "printf" {
                texts.push(ev.args.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" "));
            }
        }
    }
    for t in texts {
        let hit = scan_command(ctx, &t.replace("\\n", "\n"), d + 1, cwd);
        if hit.is_some() {
            return hit;
        }
    }
    None
}

fn shell_script_is_input(sh_tokens: &[Tok], repls: &[Repl]) -> bool {
    let Some(ev) = effective_verb(sh_tokens) else { return false };
    if !is_shell_verb(&ev.verb) {
        return false;
    }
    let mut script: Option<String> = None;
    for i in 0..ev.args.len() {
        let t = ev.args[i].text.as_str();
        if is_c_flag_pub(t) {
            script = Some(ev.args.get(i + 1).map(|x| x.text.clone()).unwrap_or_default());
            break;
        }
        if !t.starts_with('-') || t == "-" {
            return t == "-";
        }
    }
    let Some(mut script) = script else { return true };
    for r in repls {
        script = match r {
            Repl::S(s) if s.is_empty() => script.chars().map(|c| c.to_string()).collect::<Vec<_>>().join(" "),
            Repl::S(s) => script.split(s.as_str()).collect::<Vec<_>>().join(" "),
            Repl::R(re) => re.replace_all(&script, " ").to_string(),
        };
    }
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"\$\{?[0-9@*]\}?|(?-u:\b)(?:eval|exec)(?-u:\b)|["'\s;]"#).unwrap());
    re.replace_all(&script, "").is_empty()
}

pub fn shell_script_is_input_pub(sh: &[Tok], repls: &[Repl]) -> bool {
    shell_script_is_input(sh, repls)
}

#[allow(clippy::too_many_arguments)]
pub fn runner_verdict(ctx: &mut Ctx, cmd_tokens: &[Tok], runner: &str, d: usize, cmd: &str, hb: &Hb, cwd: Option<&str>, use_jev: bool, repls: &[Repl]) -> Option<String> {
    // `xargs xargs xargs ...` recurses once per word; JS overflows its stack (and then allows). Bound it and defer to Node.
    if ctx.rec > 1500 {
        ctx.overflow = true;
        return None;
    }
    ctx.rec += 1;
    let saved = ctx.active_repls.clone();
    if !repls.is_empty() {
        ctx.active_repls.extend(repls.iter().cloned());
    }
    let r = runner_verdict_in(ctx, cmd_tokens, runner, d, cmd, hb, cwd, use_jev);
    ctx.active_repls = saved;
    ctx.rec -= 1;
    r
}

fn runner_verdict_in(ctx: &mut Ctx, cmd_tokens: &[Tok], runner: &str, d: usize, cmd: &str, hb: &Hb, cwd: Option<&str>, use_jev: bool) -> Option<String> {
    if cmd_tokens.is_empty() {
        return None;
    }
    let inner = effective_verb(cmd_tokens)?;
    let pv = placeholder_verdict(&inner, &ctx.active_repls);
    if pv.is_some() {
        return pv;
    }
    let appends = runner == "xargs" || runner == "parallel";
    if inner.verb == "git" {
        let (sub, _) = git_subcommand(&inner.args);
        if appends && git_subcommand(&drop_redirects(&inner.args)).0.is_none() && forceish_anywhere(cmd) {
            return Some(msg(
                &format!("`{runner} git` with no subcommand, beside a force or delete flag, is blocked."),
                &format!("{runner} reads the subcommand from its input, so it may be `push` with that flag."),
                "run the git command directly with an explicit subcommand and arguments.",
            ));
        }
        if sub.as_deref() == Some("push") && appends {
            return Some(msg(
                &format!("force push via `{runner} git push` is blocked."),
                &format!("{runner} appends input words to the command, so the full argv (and any hidden --force/-f) cannot be verified statically."),
                "run `git push` directly with explicit arguments.",
            ));
        }
        if sub.as_deref() == Some("push") && inner.args.iter().any(|t| t.text.contains("{}")) {
            return Some(msg(
                "push via `find -exec git push ... {}` is blocked.",
                "find puts file names where {} stands, so the refspecs (a `+ref` is a force push) cannot be verified statically.",
                "run `git push` directly with explicit arguments.",
            ));
        }
        return git_verdict(ctx, &inner, d, cmd, hb, cwd, use_jev);
    }
    if inner.verb == "xargs" {
        return xargs_git_verdict(ctx, &inner, d, cmd, hb, cwd, use_jev);
    }
    if inner.verb == "find" {
        return find_exec_verdict(ctx, &inner, d, cmd, hb, cwd, use_jev);
    }
    if inner.verb == "parallel" {
        return parallel_verdict(ctx, &inner, d, cmd, hb, cwd, use_jev);
    }
    if d < 3 && (inner.verb == "eval" || is_shell_verb(&inner.verb)) {
        let repls = ctx.active_repls.clone();
        if shell_script_is_input(cmd_tokens, &repls) {
            let sv = stdin_script_verdict(ctx, cmd, d, cwd);
            if sv.is_some() {
                return sv;
            }
        }
        let mut text = cmd_tokens.iter().map(|t| t.raw.clone().unwrap_or_else(|| t.text.clone())).collect::<Vec<_>>().join(" ");
        if appends {
            text.push_str(" --force");
        }
        return scan_command(ctx, &text, d + 1, cwd);
    }
    None
}
