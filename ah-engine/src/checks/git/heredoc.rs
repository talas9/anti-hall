//! Data-heredoc masking (guards.gitGuardHeredocData): a heredoc whose consumer is not a shell is data, so its
//! body is removed before the segment scans. All-or-nothing and fail-closed: any doubt returns the command
//! unchanged.
use super::Ctx;
use super::gitcmd::git_subcommand;
use super::tables::{Spec, tables};
use super::tokenize::*;
use super::util::*;
use crate::checks::lit_re;
use regex::Regex;
use std::collections::{HashMap, HashSet};

fn all_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

/// Mirrors `git-guard.js` `hdFlagWords`.
fn hd_flag_words(args: &[Tok], sp: &Spec) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut k = 0usize;
    while k < args.len() {
        let w = args[k].text.as_str();
        if w == "--" {
            k += 1;
            while k < args.len() {
                words.push(args[k].text.clone());
                k += 1;
            }
            break;
        }
        if !w.starts_with('-') || w == "-" {
            words.push(w.to_string());
            k += 1;
            continue;
        }
        if let Some(rest) = w.strip_prefix("--") {
            let eq = rest.find('=');
            let name = match eq {
                None => rest,
                Some(p) => &rest[..p],
            };
            if sp.big_l.contains(name) {
                if eq.is_none() {
                    k += 1;
                }
                k += 1;
                continue;
            }
            if eq.is_none() && sp.l.contains(name) {
                k += 1;
                continue;
            }
            if sp.big_o.contains(name) {
                k += 1;
                continue;
            }
            return None;
        }
        if sp.num && w.len() > 1 && all_digits(&w[1..]) {
            k += 1;
            continue;
        }
        let wc: Vec<char> = w.chars().collect();
        if sp.strict {
            let ch = wc[1];
            if wc.len() == 2 && sp.s.contains(ch) {
                k += 1;
                continue;
            }
            if wc.len() == 2 && sp.v.contains(ch) {
                match args.get(k + 1) {
                    Some(n) if all_digits(&n.text) => {}
                    _ => return None,
                }
                k += 2;
                continue;
            }
            // /^-.[0-9]+$/
            if sp.v.contains(ch) && wc.len() >= 3 && wc[2..].iter().all(|c| c.is_ascii_digit()) {
                k += 1;
                continue;
            }
            // /^-.[0-9]*%?$/
            if sp.o.contains(ch) {
                let tail: String = wc[2..].iter().collect();
                let t = tail.strip_suffix('%').unwrap_or(&tail);
                if t.chars().all(|c| c.is_ascii_digit()) {
                    k += 1;
                    continue;
                }
            }
            return None;
        }
        let mut c = 1;
        while c < wc.len() {
            let ch = wc[c];
            if sp.v.contains(ch) {
                if c == wc.len() - 1 {
                    k += 1;
                }
                break;
            }
            if sp.o.contains(ch) {
                break;
            }
            if !sp.s.contains(ch) {
                return None;
            }
            c += 1;
        }
        k += 1;
    }
    Some(words)
}

fn safe_path_word(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "_./~+@%:,=-".contains(c))
}

/// Mirrors `git-guard.js` `hdGitOk`.
fn hd_git_ok(args: &[Tok]) -> bool {
    let mut k = 0usize;
    while k < args.len() {
        let w = args[k].text.as_str();
        if w == "--no-pager" || w == "-P" {
            k += 1;
            continue;
        }
        if w == "-C" {
            let dir = args.get(k + 1).map(|t| t.text.as_str()).unwrap_or("");
            if !safe_path_word(dir) || dir.contains("__AH") {
                return false;
            }
            k += 2;
            continue;
        }
        break;
    }
    let sub = if k < args.len() { args[k].text.as_str() } else { "" };
    let Some(sp) = tables().hd_specs.get(sub) else { return false };
    let Some(words) = hd_flag_words(&args[(k + 1).min(args.len())..], sp) else { return false };
    if sub == "notes" && !words.is_empty() && !tables().hd_notes_subs.has(words[0].as_str()) {
        return false;
    }
    true
}

/// Mirrors `git-guard.js` `hdGhWords`.
fn hd_gh_words(args: &[Tok]) -> Option<Vec<String>> {
    if args.iter().any(|a| a.text == "--") {
        return None;
    }
    let words = hd_flag_words(args, &tables().hd_gh_spec)?;
    if words.len() < 2 {
        return None;
    }
    if !tables().hd_gh_subs.has(words[0].as_str()) || !tables().hd_gh_actions.has(words[1].as_str()) {
        return None;
    }
    Some(words)
}

/// Mirrors `git-guard.js` `hdDeniedFirstWord`.
fn hd_denied_first_word(skel: &str) -> bool {
    for piece in backstop_pieces(skel) {
        let t = piece.trim_start_matches(|c: char| is_js_space(c) || matches!(c, '{' | '}' | '!' | '"' | '\'' | '('));
        let w = t.split(|c: char| is_js_space(c) || c == '"' || c == '\'').next().unwrap_or("");
        if w.is_empty() {
            continue;
        }
        if w.chars().any(|c| matches!(c, '/' | '$' | '~' | '`')) {
            return true;
        }
        let lw = w.to_lowercase();
        if tables().hd_deny_first.has(&lw) {
            return true;
        }
        let rest = lw.strip_prefix("python").or_else(|| lw.strip_prefix("pypy"));
        if let Some(r) = rest
            && r.chars().all(|c| c.is_ascii_digit() || c == '.')
        {
            return true;
        }
    }
    false
}

/// Mirrors `git-guard.js` `hdBadPath`.
fn hd_bad_path(p: &str) -> bool {
    let segs: Vec<String> = p.split('/').filter(|x| !x.is_empty()).map(|x| x.to_lowercase()).collect();
    segs.iter()
        .enumerate()
        .any(|(k, x)| tables().hd_bad_dirs.has(x) || (x == crate::defaults::text("paths.base_dir") && segs.get(k + 1).map(|s| s.as_str()) == Some("bin")))
}

fn at(s: &[char], i: usize) -> Option<char> {
    s.get(i).copied()
}

/// Mirrors `git-guard.js` `hdSkipQuote`.
fn hd_skip_quote(s: &[char], i: usize, depth: usize) -> Option<usize> {
    if depth > tables().max_nest {
        return None;
    }
    if s[i] == '\'' {
        return s[i + 1..].iter().position(|&c| c == '\'').map(|p| p + i + 2);
    }
    let mut k = i + 1;
    while k < s.len() {
        let c = s[k];
        if c == '\\' {
            k += 2;
            continue;
        }
        if c == '"' {
            return Some(k + 1);
        }
        if c == '$' && at(s, k + 1) == Some('(') {
            let e = hd_subst_end(s, k + 2, ')', depth + 1)?;
            k = e + 1;
            continue;
        }
        if c == '`' {
            let e = hd_subst_end(s, k + 1, '`', depth + 1)?;
            k = e + 1;
            continue;
        }
        k += 1;
    }
    None
}

/// Mirrors `git-guard.js` `hdSubstEnd`.
fn hd_subst_end(s: &[char], mut i: usize, closer: char, depth_nest: usize) -> Option<usize> {
    if depth_nest > tables().max_nest {
        return None;
    }
    let mut depth: i32 = 0;
    let mut word_start = true;
    while i < s.len() {
        let c = s[i];
        if c == closer && (closer == '`' || depth == 0) {
            return Some(i);
        }
        if c == '\\' {
            i += 2;
            word_start = false;
            continue;
        }
        if c == '\'' || c == '"' {
            i = hd_skip_quote(s, i, depth_nest + 1)?;
            word_start = false;
            continue;
        }
        if c == '$' && at(s, i + 1) == Some('(') {
            let e = hd_subst_end(s, i + 2, ')', depth_nest + 1)?;
            i = e + 1;
            continue;
        }
        if c == '`' && closer != '`' {
            let e = hd_subst_end(s, i + 1, '`', depth_nest + 1)?;
            i = e + 1;
            continue;
        }
        if c == '#' && word_start {
            let nl = s[i..].iter().position(|&x| x == '\n')? + i;
            i = nl;
            continue;
        }
        if closer == ')' && c == '(' {
            depth += 1;
        } else if closer == ')' && c == ')' {
            depth -= 1;
        }
        word_start = is_js_space(c) || ";&|()".contains(c);
        i += 1;
    }
    None
}

struct Doc {
    id: usize,
    line_end: usize,
    end: usize,
}

fn cslice(s: &[char], a: usize, b: usize) -> String {
    let b = b.min(s.len());
    if a >= b { String::new() } else { s[a..b].iter().collect() }
}

/// Mirrors `git-guard.js` `hdSkeleton`.
fn hd_skeleton(cmd: &[char]) -> Option<(String, Vec<Doc>)> {
    let n = cmd.len();
    let mut st = ArithScan::new();
    let mut docs: Vec<Doc> = Vec::new();
    let mut out = String::new();
    let mut i = 0usize;
    let mut stack: Vec<char> = Vec::new();
    struct Pending {
        id: usize,
        line_end: usize,
        end: usize,
    }
    let mut pending: Option<Pending> = None;
    let mut word_start = true;
    while i < n {
        let c = cmd[i];
        let top = stack.last().copied();
        if c == '\n' {
            if top == Some('D') {
                return None;
            }
            out.push(c);
            i += 1;
            word_start = true;
            if let Some(p) = pending.take() {
                if p.line_end != i - 1 {
                    return None;
                }
                i = p.end;
                docs.push(Doc { id: p.id, line_end: p.line_end, end: p.end });
            }
            continue;
        }
        if top == Some('D') {
            if c == '\\' {
                out.push_str(&cslice(cmd, i, i + 2));
                i += 2;
                continue;
            }
            if c == '"' {
                stack.pop();
                out.push(c);
                i += 1;
                continue;
            }
            if c == '$' && at(cmd, i + 1) == Some('(') {
                stack.push('C');
                out.push_str("$(");
                i += 2;
                word_start = true;
                continue;
            }
            if c == '`' {
                stack.push('B');
                out.push(c);
                i += 1;
                word_start = true;
                continue;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '\\' {
            if at(cmd, i + 1) == Some('\n') {
                return None;
            }
            out.push_str(&cslice(cmd, i, i + 2));
            i += 2;
            word_start = false;
            continue;
        }
        if c == '\'' {
            let j = cmd[i + 1..].iter().position(|&x| x == '\'').map(|p| p + i + 1)?;
            if cmd[i..j].contains(&'\n') {
                return None;
            }
            out.push_str(&cslice(cmd, i, j + 1));
            i = j + 1;
            word_start = false;
            continue;
        }
        if c == '"' {
            stack.push('D');
            out.push(c);
            i += 1;
            word_start = false;
            continue;
        }
        if c == '#' && word_start {
            let nl = cmd[i..].iter().position(|&x| x == '\n').map(|p| p + i);
            let end = nl.unwrap_or(n);
            if cmd[i..end].windows(2).any(|w| w == ['<', '<']) && pending.is_some() {
                return None;
            }
            out.push_str(&cslice(cmd, i, end));
            i = end;
            continue;
        }
        if c == '$' && at(cmd, i + 1) == Some('(') {
            stack.push('C');
            out.push_str("$(");
            i += 2;
            word_start = true;
            continue;
        }
        if c == '`' {
            if top == Some('B') {
                stack.pop();
            } else {
                stack.push('B');
            }
            out.push(c);
            i += 1;
            word_start = true;
            continue;
        }
        if c == '(' {
            stack.push('P');
            out.push(c);
            i += 1;
            word_start = true;
            continue;
        }
        if c == ')' {
            if top == Some('C') || top == Some('P') {
                stack.pop();
            } else {
                return None;
            }
            out.push(c);
            i += 1;
            word_start = true;
            continue;
        }
        if c == '<' && at(cmd, i + 1) == Some('<') && at(cmd, i + 2) != Some('<') && (i == 0 || cmd[i - 1] != '<') {
            if pending.is_some() {
                return None;
            }
            let p = parse_heredoc_at(cmd, i, &mut st)?;
            let line_end = p.line_end?;
            if !p.terminated {
                return None;
            }
            let body_start = line_end + 1;
            let mut term_lines: Vec<String> = cslice(cmd, body_start, p.end).split('\n').map(|x| x.to_string()).collect();
            if term_lines.last().is_some_and(|l| l.is_empty()) {
                term_lines.pop();
            }
            term_lines.pop();
            for ln in &term_lines {
                if ln.trim_start_matches([' ', '\t']).starts_with(p.word.as_str()) {
                    return None;
                }
            }
            if !p.quoted && (p.body.contains("$(") || p.body.contains('`') || p.body.contains("$[") || p.body.contains("\\\n")) {
                return None;
            }
            let id = docs.len();
            pending = Some(Pending { id, line_end, end: p.end });
            out.push_str(&format!(" __AHDOC{id}__ "));
            i = p.opener_end;
            word_start = false;
            continue;
        }
        word_start = is_js_space(c) || ";&|<>".contains(c);
        out.push(c);
        i += 1;
    }
    if pending.is_some() || !stack.is_empty() {
        return None;
    }
    Some((out, docs))
}

struct Level {
    text: String,
    id: Option<usize>,
}

/// Mirrors `git-guard.js` `hdLevels`.
fn hd_levels(text: &[char], levels: &mut Vec<Level>, next_id: &mut usize, depth: usize, own_id: Option<usize>) -> bool {
    if depth > 6 {
        return false;
    }
    let mut flat = String::new();
    let mut i = 0usize;
    let mut inner: Vec<(Vec<char>, usize)> = Vec::new();
    macro_rules! lift {
        ($a:expr_2021, $b:expr_2021) => {{
            let id = *next_id;
            *next_id += 1;
            inner.push((text[$a..$b].to_vec(), id));
            flat.push_str(&format!(" __AHSUB{id}__ "));
        }};
    }
    while i < text.len() {
        let c = text[i];
        if c == '\\' {
            flat.push_str(&cslice(text, i, i + 2));
            i += 2;
            continue;
        }
        if c == '\'' {
            let Some(j) = text[i + 1..].iter().position(|&x| x == '\'').map(|p| p + i + 1) else { return false };
            flat.push_str(&cslice(text, i, j + 1));
            i = j + 1;
            continue;
        }
        if c == '$' && at(text, i + 1) == Some('(') {
            let Some(e) = hd_subst_end(text, i + 2, ')', 0) else { return false };
            lift!(i + 2, e);
            i = e + 1;
            continue;
        }
        if c == '`' {
            let Some(e) = hd_subst_end(text, i + 1, '`', 0) else { return false };
            lift!(i + 1, e);
            i = e + 1;
            continue;
        }
        if c == '"' {
            flat.push(c);
            i += 1;
            while i < text.len() && text[i] != '"' {
                let d = text[i];
                if d == '\\' {
                    flat.push_str(&cslice(text, i, i + 2));
                    i += 2;
                    continue;
                }
                if d == '$' && at(text, i + 1) == Some('(') {
                    let Some(e) = hd_subst_end(text, i + 2, ')', 0) else { return false };
                    lift!(i + 2, e);
                    i = e + 1;
                    continue;
                }
                if d == '`' {
                    let Some(e) = hd_subst_end(text, i + 1, '`', 0) else { return false };
                    lift!(i + 1, e);
                    i = e + 1;
                    continue;
                }
                flat.push(d);
                i += 1;
            }
            if i >= text.len() {
                return false;
            }
            flat.push('"');
            i += 1;
            continue;
        }
        flat.push(c);
        i += 1;
    }
    levels.push(Level { text: flat, id: own_id });
    for (t, id) in inner {
        if !hd_levels(&t, levels, next_id, depth + 1, Some(id)) {
            return false;
        }
    }
    true
}

/// Mirrors `git-guard.js` `hdIsDataSink`.
fn hd_is_data_sink(t: &str) -> bool {
    if tables().hd_sinks_basic.has(t) {
        return true;
    }
    let base = t.rsplit('/').next().unwrap_or("");
    match base.rfind('.') {
        Some(dot) if dot > 0 => tables().hd_data_ext.has(&base[dot + 1..].to_lowercase()),
        _ => false,
    }
}

/// Mirrors `git-guard.js` `hdTargetOk`.
fn hd_target_ok(ctx: &Ctx, t: &str, dirs: &[String]) -> bool {
    if t.is_empty() {
        return false;
    }
    let mut t = t.to_string();
    for p in ["$HOME", "${HOME}"] {
        if let Some(rest) = t.strip_prefix(p) {
            if rest.is_empty() || rest.starts_with('/') {
                t = format!("~{rest}");
            }
            break;
        }
    }
    if tables().hd_sinks_basic.has(&t) || tables().hd_sinks_fd.has(&t) {
        return true;
    }
    if !safe_path_word(&t) || t.contains("__AH") {
        return false;
    }
    if hd_bad_path(&t) {
        return false;
    }
    let base = t.rsplit('/').next().unwrap_or("").to_string();
    if base.is_empty() || base.starts_with('.') {
        return false;
    }
    let stem = match base.rfind('.') {
        Some(p) => &base[..p],
        None => base.as_str(),
    };
    if tables().git_hook_names.has(&stem.to_lowercase()) || tables().git_hook_names.has(&base.to_lowercase()) {
        return false;
    }
    let home = ctx.home.as_str();
    for dir in dirs {
        let rel = if t.starts_with("~/") && !home.is_empty() { path_join(home, &t[2..]) } else { t.clone() };
        let abs = resolve(if dir.is_empty() { &ctx.proc_cwd } else { dir }, &rel, &ctx.proc_cwd);
        match std::fs::symlink_metadata(&abs) {
            Ok(m) => {
                if m.file_type().is_symlink() {
                    return false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
        let mut real = posix_dirname(&abs);
        match std::fs::canonicalize(&real) {
            Ok(r) => real = r.to_string_lossy().to_string(),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return false,
        }
        if hd_bad_path(&real) || hd_bad_path(&abs) {
            return false;
        }
    }
    true
}

struct Target {
    t: String,
    stdout: bool,
}

fn split_redirect_prefix(s: &str) -> Option<(String, String)> {
    // ^([0-9]*|&)(>>?|>\|)(.*)$  (dotall); the first `>>?` alternative always wins when a `>` follows
    let (prefix, rest) = if let Some(r) = s.strip_prefix('&') {
        if r.starts_with('>') {
            ("&".to_string(), r)
        } else {
            let d: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
            let r2 = &s[d.len()..];
            if !r2.starts_with('>') {
                return None;
            }
            (d, r2)
        }
    } else {
        let d: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        let r2 = &s[d.len()..];
        if !r2.starts_with('>') {
            return None;
        }
        (d, r2)
    };
    let after = rest.strip_prefix(">>").unwrap_or(&rest[1..]);
    Some((prefix, after.to_string()))
}

/// Mirrors `git-guard.js` `hdWriteTargets`.
fn hd_write_targets(tokens: &[Tok], ev: &Ev) -> Option<Vec<Target>> {
    let mut out: Vec<Target> = Vec::new();
    let mut i = 0usize;
    while i < tokens.len() {
        let t = &tokens[i];
        if t.quoted_only {
            i += 1;
            continue;
        }
        let Some((prefix, mut w)) = split_redirect_prefix(&t.text) else {
            if t.text.contains('>') {
                return None;
            }
            i += 1;
            continue;
        };
        if let Some(r) = w.strip_prefix('&') {
            // /^&[0-9-]?$/
            if r.chars().count() <= 1 && r.chars().all(|c| c.is_ascii_digit() || c == '-') {
                i += 1;
                continue;
            }
            return None;
        }
        if w.starts_with('(') {
            return None;
        }
        if w.is_empty() {
            w = tokens.get(i + 1).map(|x| x.text.clone()).unwrap_or_default();
            i += 1;
        }
        out.push(Target { t: w, stdout: prefix.is_empty() || prefix == "1" || prefix == "&" });
        i += 1;
    }
    if ev.verb == "tee" {
        let mut k = 0;
        while k < ev.args.len() {
            let a = ev.args[k].text.as_str();
            let stripped = a.trim_start_matches(|c: char| c.is_ascii_digit());
            let stripped = a.strip_prefix('&').unwrap_or(stripped);
            if stripped.starts_with('>') {
                // /^(?:[0-9]*|&)>>?\|?$/
                let r = stripped.strip_prefix(">>").or_else(|| stripped.strip_prefix('>')).unwrap_or("");
                if r.is_empty() || r == "|" {
                    k += 1;
                }
                k += 1;
                continue;
            }
            let is_doc = a.strip_prefix("__AHDOC").and_then(|r| r.strip_suffix("__")).is_some_and(all_digits);
            if a.starts_with('-') || is_doc {
                k += 1;
                continue;
            }
            out.push(Target { t: a.to_string(), stdout: true });
            k += 1;
        }
    }
    if out.iter().any(|w| w.t.contains("__AH")) { None } else { Some(out) }
}

/// Mirrors `git-guard.js` `hdMarkers`.
fn hd_markers(tokens: &[Tok], re: &Regex) -> Vec<usize> {
    let mut ids = Vec::new();
    for t in tokens {
        for m in re.captures_iter(&t.text) {
            if let Ok(n) = m[1].parse::<usize>() {
                ids.push(n);
            }
        }
    }
    ids
}

/// Mirrors `git-guard.js` `hdMessageTaker`.
fn hd_message_taker(ev: &Ev) -> bool {
    if ev.verb == "git" {
        return git_subcommand(&ev.args).0.is_some_and(|s| tables().heredoc_git_msg_subs.has(&s));
    }
    if ev.verb == "gh" {
        return hd_gh_words(&ev.args).is_some();
    }
    false
}

struct Consumer {
    ev: Ev,
    targets: Vec<Target>,
    level_id: Option<usize>,
}

/// Replace heredoc bodies that are plain data (not fed to a shell, not a hook or config path) with blanks so text inside them is never scanned as commands.
///
/// Mirrors `git-guard.js` `maskDataHeredocs`.
pub fn mask_data_heredocs(ctx: &mut Ctx, cmd: &str, base_cwd: Option<&str>) -> String {
    mask_inner(ctx, cmd, base_cwd).unwrap_or_else(|| cmd.to_string())
}

fn mask_inner(ctx: &mut Ctx, cmd: &str, base_cwd: Option<&str>) -> Option<String> {
    if !cmd.contains("<<") {
        return None;
    }
    if cmd.contains('\r') || cmd.contains('\0') {
        return None;
    }
    if !ctx.heredoc_data_enabled() {
        return None;
    }
    let chars: Vec<char> = cmd.chars().collect();
    let (skel, docs) = hd_skeleton(&chars)?;
    if docs.is_empty() {
        return None;
    }
    if skel.contains("<(") || skel.contains(">(") || skel.contains("${") || skel.contains("$'") || skel.contains("\\\n") {
        return None;
    }
    if hd_denied_first_word(&skel) {
        return None;
    }
    let mut levels: Vec<Level> = Vec::new();
    let mut next_id = 0usize;
    let skel_chars: Vec<char> = skel.chars().collect();
    if !hd_levels(&skel_chars, &mut levels, &mut next_id, 0, None) {
        return None;
    }
    let first_dir = match base_cwd {
        Some(b) if !b.is_empty() => b.to_string(),
        _ => ctx.proc_cwd.clone(),
    };
    let mut dirs: Vec<String> = vec![first_dir];
    if hd_bad_path(&dirs[0]) {
        return None;
    }
    let mut outer_of: HashMap<usize, Ev> = HashMap::new();
    let mut consumers: Vec<Consumer> = Vec::new();
    let mut seen_docs: HashSet<usize> = HashSet::new();
    static SUB_RE: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static DOC_RE: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    let sub_re = SUB_RE.get_or_init(|| lit_re(r"__AHSUB([0-9]+)__"));
    let doc_re = DOC_RE.get_or_init(|| lit_re(r"__AHDOC([0-9]+)__"));
    for lvl in &levels {
        for seg in split_segments(&lvl.text) {
            let tokens = tokenize(&seg);
            if tokens.is_empty() {
                continue;
            }
            if !tokens[0].quoted_only && is_assign(&tokens[0].text) {
                return None;
            }
            let ev = effective_verb(&tokens)?;
            if !tables().heredoc_safe_verbs.has(&ev.verb) || tokens[0].quoted_only || tokens[0].text != ev.verb {
                return None;
            }
            if ev.verb == "gh" && hd_gh_words(&ev.args).is_none() {
                return None;
            }
            if ev.verb == "git" && !hd_git_ok(&ev.args) {
                return None;
            }
            if (ev.verb == "cd" || ev.verb == "pushd")
                && let Some(dt) = ev.args.iter().find(|t| !t.text.starts_with('-'))
            {
                if !safe_path_word(&dt.text) || dt.text.contains("__AH") {
                    return None;
                }
                let home = ctx.home.as_str();
                let rel = if dt.text.starts_with("~/") && !home.is_empty() { path_join(home, &dt.text[2..]) } else { dt.text.clone() };
                let next = resolve(dirs.last()?, &rel, &ctx.proc_cwd); // dirs always holds the starting directory
                if hd_bad_path(&next) {
                    return None;
                }
                dirs.push(next);
            }
            let targets = hd_write_targets(&tokens, &ev)?;
            for w in &targets {
                if !hd_target_ok(ctx, &w.t, &dirs) {
                    return None;
                }
            }
            for id in hd_markers(&tokens, sub_re) {
                outer_of.insert(id, ev.clone());
            }
            let doc_ids = hd_markers(&tokens, doc_re);
            if !doc_ids.is_empty() {
                for id in doc_ids {
                    seen_docs.insert(id);
                }
                consumers.push(Consumer { ev, targets, level_id: lvl.id });
            }
        }
    }
    for d in &docs {
        if !seen_docs.contains(&d.id) {
            return None;
        }
    }
    for c in &consumers {
        if c.ev.verb == "git" || c.ev.verb == "gh" {
            if !hd_message_taker(&c.ev) {
                return None;
            }
            continue;
        }
        let sinks: Vec<&Target> = c.targets.iter().filter(|w| w.stdout).collect();
        if !sinks.is_empty() {
            if !sinks.iter().all(|w| hd_is_data_sink(&w.t)) {
                return None;
            }
            continue;
        }
        let outer = c.level_id.and_then(|id| outer_of.get(&id));
        match outer {
            Some(o) if hd_message_taker(o) => {}
            _ => return None,
        }
    }
    let mut out = String::new();
    let mut last = 0usize;
    for d in &docs {
        out.push_str(&cslice(&chars, last, d.line_end + 1));
        last = d.end;
    }
    out.push_str(&cslice(&chars, last, chars.len()));
    Some(out)
}
