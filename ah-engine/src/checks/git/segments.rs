//! scanCommand, the git verdicts, the quote-blind backstops and the handover-commit check (git-guard.js).
use super::Ctx;
use super::aliases::*;
use super::gitcmd::*;
use super::heredoc::mask_data_heredocs;
use super::launcher::*;
use super::payloads::*;
use super::runner::*;
use super::tables::{argv_template, block, plain, tables};
use super::tokenize::*;
use super::util::*;
use crate::checks::lit_re;
use regex::Regex;
use std::collections::HashMap;
use std::sync::OnceLock;

fn is_line_term(c: char) -> bool {
    c == '\n' || c == '\r' || c == '\u{2028}' || c == '\u{2029}'
}

/// `key = value` lines (CONFIG_LINE_RE, per line); returns the captured value of each matching line.
fn config_line_values(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut line = String::new();
    let mut lines: Vec<String> = Vec::new();
    for c in text.chars() {
        if is_line_term(c) {
            lines.push(std::mem::take(&mut line));
        } else {
            line.push(c);
        }
    }
    lines.push(line);
    for l in lines {
        let cs: Vec<char> = l.chars().collect();
        let mut p = 0;
        while p < cs.len() && (cs[p] == ' ' || cs[p] == '\t') {
            p += 1;
        }
        if p < cs.len() && cs[p] == '[' {
            // optional `[section]` group
            if let Some(close) = cs[p + 1..].iter().position(|&c| c == ']').map(|x| x + p + 1) {
                p = close + 1;
                while p < cs.len() && (cs[p] == ' ' || cs[p] == '\t') {
                    p += 1;
                }
            }
        }
        if p >= cs.len() || !cs[p].is_ascii_alphabetic() {
            continue;
        }
        p += 1;
        while p < cs.len() && (cs[p].is_ascii_alphanumeric() || cs[p] == '_' || cs[p] == '.' || cs[p] == '-') {
            p += 1;
        }
        while p < cs.len() && (cs[p] == ' ' || cs[p] == '\t') {
            p += 1;
        }
        if p >= cs.len() || cs[p] != '=' {
            continue;
        }
        p += 1;
        let mut q = p;
        while q < cs.len() && (cs[q] == ' ' || cs[q] == '\t') {
            q += 1;
        }
        if q < cs.len() {
            out.push(cs[q..].iter().collect());
        } else if q > p {
            out.push(cs[q - 1..].iter().collect());
        }
    }
    out
}

/// Mirrors `git-guard.js` `scanConfigLines`.
fn scan_config_lines(ctx: &mut Ctx, text: &str, d: usize) -> Option<String> {
    for v in config_line_values(text) {
        if let Some(h) = scan_command_value(ctx, &v, d) {
            return Some(h);
        }
    }
    None
}

/// Mirrors `git-guard.js` `scanCommandValue`.
fn scan_command_value(ctx: &mut Ctx, v: &str, d: usize) -> Option<String> {
    if d >= 3 || !v.contains("push") {
        return None;
    }
    let s = js_trim(v).to_string();
    let mut cands = vec![s.clone()];
    // /^'?[A-Za-z_][\w.-]*=([\s\S]*?)'?$/
    let body = s.strip_prefix('\'').unwrap_or(&s);
    let mut cs = body.chars();
    if cs.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') {
        let name_len = 1 + body.chars().skip(1).take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.' || *c == '-').count();
        if body[name_len..].starts_with('=') {
            let mut val = &body[name_len + 1..];
            if let Some(v2) = val.strip_suffix('\'') {
                val = v2;
            }
            cands.push(js_trim(val).to_string());
        }
    }
    for c in cands {
        let cmd = c.strip_prefix('!').unwrap_or(&c).to_string();
        if let Some(hit) = scan_command(ctx, &cmd, d + 1, None) {
            return Some(hit);
        }
        if let Some(hit) = scan_command(ctx, &format!("git {cmd}"), d + 1, None) {
            return Some(hit);
        }
    }
    None
}

/// Mirrors `lib/handover-find.js` `isHandoverPath`.
fn is_handover_path(p: &str) -> bool {
    static ROOT: OnceLock<Regex> = OnceLock::new();
    let root = ROOT.get_or_init(|| lit_re(r"^(?:HANDOVER(?:-[^/]*)?\.md|CONTINUE-HERE\.md|[^/]*\.continue-here\.md)$"));
    let mut norm = p.replace('\\', "/");
    while let Some(r) = norm.strip_prefix("./") {
        norm = r.to_string();
    }
    let hd = tables().handover_dir_prefix.as_str();
    if norm.starts_with(hd) || norm.contains(&format!("/{hd}")) {
        return true;
    }
    !norm.contains('/') && root.is_match(&norm)
}

enum Q {
    Value(Option<Vec<String>>),
    Exhausted,
}

/// Mirrors `git-guard.js` `committedHandovers`.
fn handover_query(ctx: &mut Ctx, dir: &str, args: &[String], status_parse: bool) -> Q {
    let key = format!("{}\0{}", dir, args.join("\0"));
    if let Some(v) = ctx.handover_cache.get(&key) {
        return Q::Value(v.clone());
    }
    if ctx.handover_query_budget <= 0 {
        return Q::Exhausted;
    }
    ctx.handover_query_budget -= 1;
    let mut argv: Vec<String> = vec!["-C".into(), dir.to_string()];
    argv.extend(argv_template("argv_diff_relative", ""));
    argv.extend(args.iter().cloned());
    let out = run_capture(&tables().git_binary, &argv, None, &HashMap::new(), tables().handover_git_timeout);
    let parsed = out.map(|s| {
        let names: Vec<String> = s.split('\0').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect();
        if status_parse {
            names
                .into_iter()
                .filter(|e| {
                    let c: Vec<char> = e.chars().take(2).collect();
                    let c0 = c.first().copied();
                    let c1 = c.get(1).copied();
                    !((c0 == Some(' ') && c1 == Some('D')) || (c0 == Some('D') && c1 == Some(' ')) || (c0.is_some() && c1 == Some('D')))
                })
                .map(|e| e.chars().skip(3).collect())
                .collect()
        } else {
            names
        }
    });
    ctx.handover_cache.insert(key, parsed.clone());
    Q::Value(parsed)
}

/// Mirrors `git-guard.js` `committedHandovers`.
fn committed_handovers(ctx: &mut Ctx, ev: &Ev, last_cd_dir: Option<&str>) -> Option<Vec<String>> {
    let (sub, rest) = git_subcommand(&ev.args);
    if sub.as_deref() != Some("commit") {
        return None;
    }
    let mut dir: String = match last_cd_dir {
        Some(d) if !d.is_empty() => d.to_string(),
        _ => ctx.proc_cwd.clone(),
    };
    let mut k = 0usize;
    while k < ev.args.len() {
        let t = ev.args[k].text.as_str();
        if t == "-C" && k + 1 < ev.args.len() {
            dir = resolve(&dir, &ev.args[k + 1].text, &ctx.proc_cwd);
            k += 2;
            continue;
        }
        if t == "--git-dir" || t == "--work-tree" || t.starts_with("--git-dir=") || t.starts_with("--work-tree=") {
            return None;
        }
        if t == "-c" || t == "--namespace" || t == "--config-env" {
            k += 2;
            continue;
        }
        if t.starts_with('-') {
            k += 1;
            continue;
        }
        break;
    }
    let mut all = false;
    let mut specs: Vec<String> = Vec::new();
    let mut after_dd = false;
    let mut i = 0usize;
    while i < rest.len() {
        let t = rest[i].text.as_str();
        if after_dd || !t.starts_with('-') {
            specs.push(t.to_string());
            i += 1;
            continue;
        }
        if t == "--" {
            after_dd = true;
            i += 1;
            continue;
        }
        if t == "--all" {
            all = true;
            i += 1;
            continue;
        }
        if t.starts_with("--pathspec-from-file") {
            return None;
        }
        if t.starts_with("--") {
            if tables().add_commit_value_opts.has(t) {
                i += 1;
            }
            i += 1;
            continue;
        }
        let cluster: Vec<char> = t.chars().skip(1).collect();
        for c in 0..cluster.len() {
            if cluster[c] == 'a' {
                all = true;
            }
            if "mFCct".contains(cluster[c]) {
                if c == cluster.len() - 1 {
                    i += 1;
                }
                break;
            }
            if "Su".contains(cluster[c]) {
                break;
            }
        }
        i += 1;
    }
    let diff = |ctx: &mut Ctx, dir: &str, extra: &[String]| -> Q {
        let mut a: Vec<String> = argv_template("argv_diff_names", "");
        a.extend(extra.iter().cloned());
        handover_query(ctx, dir, &a, false)
    };
    // paths: Value(Some) = list, Value(None) = null (unknown), Exhausted = undefined
    let mut paths: Q;
    if !specs.is_empty() {
        let mut a = vec!["HEAD".to_string(), "--".to_string()];
        a.extend(specs.iter().cloned());
        paths = diff(ctx, &dir, &a);
    } else {
        paths = diff(ctx, &dir, &["--cached".to_string()]);
        if all && let Q::Value(Some(p)) = &paths {
            let tracked = diff(ctx, &dir, &[]);
            paths = match tracked {
                Q::Value(Some(t)) => {
                    let mut np = p.clone();
                    np.extend(t);
                    Q::Value(Some(np))
                }
                other => other,
            };
        }
    }
    if let Q::Value(Some(p)) = &paths
        && specs.is_empty()
        && !ctx.handover_adds.is_empty()
    {
        let a: Vec<String> = [
            "status",
            "--porcelain",
            "-z",
            "--untracked-files=all",
            "--",
            &format!(":(top,glob)**/{}**", tables().handover_dir_prefix),
            ":(top,glob)HANDOVER.md",
            ":(top,glob)HANDOVER-*.md",
            ":(top,glob)CONTINUE-HERE.md",
            ":(top,glob)*.continue-here.md",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let st = handover_query(ctx, &dir, &a, true);
        match st {
            Q::Exhausted => paths = Q::Exhausted,
            Q::Value(Some(st)) => {
                let adds = ctx.handover_adds.clone();
                let covered = |p: &str| adds.iter().any(|a| a == "." || a == p || p.starts_with(&format!("{}/", a.trim_end_matches('/'))));
                let mut np = p.clone();
                np.extend(st.into_iter().filter(|x| covered(x)));
                paths = Q::Value(Some(np));
            }
            Q::Value(None) => {}
        }
    }
    let paths = match paths {
        Q::Exhausted => {
            ctx.handover_skipped += 1;
            return None;
        }
        Q::Value(None) => return None,
        Q::Value(Some(p)) => p,
    };
    let hits: Vec<String> = paths.into_iter().filter(|p| is_handover_path(p)).collect();
    if hits.is_empty() {
        return None;
    }
    let mut gd_argv: Vec<String> = vec!["-C".into(), dir.clone()];
    gd_argv.extend(argv_template("argv_git_dir", ""));
    let gd = run_capture(&tables().git_binary, &gd_argv, None, &HashMap::new(), tables().handover_git_timeout);
    let gd = gd?;
    if js_trim(&gd).is_empty() {
        return None;
    }
    let git_dir = resolve(&dir, js_trim(&gd), &ctx.proc_cwd);
    for m in ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"] {
        if std::path::Path::new(&path_join(&git_dir, m)).exists() {
            return None;
        }
    }
    Some(hits)
}

/// Mirrors `git-guard.js` `handoverCommitVerdict`.
fn handover_commit_verdict(ctx: &mut Ctx, ev: &Ev, last_cd: Option<&str>) -> Option<String> {
    if !ev.args.iter().any(|t| t.text == "commit") {
        return None;
    }
    let old = ctx.handover_eval_budget;
    ctx.handover_eval_budget -= 1;
    if old <= 0 {
        ctx.handover_skipped += 1;
        return None;
    }
    if !ctx.handover_guard_enabled() {
        return None;
    }
    let hits = committed_handovers(ctx, ev, last_cd)?;
    let shown = hits.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
    let shown = format!("{shown}{}", if hits.len() > 3 { tables().more_marker.as_str() } else { "" });
    Some(block("msg_handover", &[("shown", &shown), ("skip", &ctx.skip_cmd(&tables().guard_name))]))
}

// ---------------------------------------------------------------------------------------------------

fn cd_next(ctx: &Ctx, cd: Option<&str>, dir_tok: &str) -> Option<String> {
    if let Some(c) = cd
        && (c.chars().count() > 4096 || c.split('/').count() > 64)
    {
        return None;
    }
    let n = normalize_guard_path(ctx, dir_tok, cd);
    Some(if n.is_empty() { dir_tok.to_string() } else { n })
}

/// Scan a command text: split it into segments, resolve each segment's verb, and return the first block message (or `None` to allow). `depth` bounds nested payloads.
///
/// Mirrors `git-guard.js` `scanCommand`.
pub fn scan_command(ctx: &mut Ctx, cmd: &str, depth: usize, base_cwd: Option<&str>) -> Option<String> {
    let d = depth;
    let base_cwd = base_cwd.filter(|b| !b.is_empty());
    if d == 0 {
        ctx.launcher_cmd_text = cmd.to_string();
    }
    let scan_text = mask_data_heredocs(ctx, cmd, base_cwd);
    let segments = split_segments(&scan_text);
    let heredoc_bodies = Hb::new(extract_heredoc_bodies(cmd));
    let mut last_cd: Option<String> = base_cwd.map(|b| b.to_string());

    if d < 3 {
        for lit in call_literal_commands(&scan_text) {
            if let Some(hit) = scan_command(ctx, &lit, d + 1, base_cwd) {
                return Some(hit);
            }
        }
    }
    for h in &heredoc_bodies.bodies {
        if let Some(hit) = scan_config_lines(ctx, &h.body, d) {
            return Some(hit);
        }
    }

    let mut persist_env: Env = Env::new();
    for seg in &segments {
        let tokens = tokenize(seg);
        if tokens.is_empty() {
            continue;
        }
        let (inline, persist) = segment_env(&tokens);
        let mut git_env = persist_env.clone();
        git_env.extend(inline);
        persist_env.extend(persist);

        for t in &tokens {
            if t.quoted_only {
                continue;
            }
            if is_assign(&t.text) {
                let Some(eq) = t.text.find('=') else { continue }; // is_assign guarantees an '='
                let v = &t.text[eq + 1..];
                if !v.is_empty()
                    && let Some(hit) = scan_command_value(ctx, v, d)
                {
                    return Some(hit);
                }
            }
        }

        let Some(mut ev) = effective_verb(&tokens) else { continue };
        ev.env = git_env;

        if let Some(h) = shell_definition_verdict(ctx, &tokens, &ev, d, last_cd.as_deref()) {
            return Some(h);
        }
        let repls = ctx.active_repls.clone();
        if let Some(pv) = placeholder_verdict(&ev, &repls) {
            return Some(pv);
        }
        if writes_launcher_dir(ctx, &tokens, &ev, last_cd.as_deref()) {
            return Some(launcher_block_msg());
        }
        if ev.verb == "echo" || ev.verb == "printf" {
            let text = ev.args.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" ");
            let text = replace_bs_nt(&text);
            if let Some(hit) = scan_config_lines(ctx, &text, d) {
                return Some(hit);
            }
            continue;
        }
        if ev.verb == "cd" || ev.verb == "pushd" {
            if let Some(dt) = ev.args.iter().find(|t| !t.text.starts_with('-')) {
                last_cd = cd_next(ctx, last_cd.as_deref(), &dt.text);
            }
            continue;
        }
        if ev.verb == "eval" {
            if d < 3 {
                let payload = extract_eval_payload(seg);
                if !payload.is_empty()
                    && let Some(n) = scan_command(ctx, &payload, d + 1, last_cd.as_deref())
                {
                    return Some(n);
                }
            }
            continue;
        }
        if is_shell_verb(&ev.verb) {
            if d < 3 {
                let payload = extract_shell_c_payload(seg);
                if !payload.is_empty() {
                    if let Some(n) = scan_command(ctx, &payload, d + 1, last_cd.as_deref()) {
                        return Some(n);
                    }
                } else if shell_script_is_input_pub(&tokens, &[])
                    && let Some(sv) = stdin_script_verdict(ctx, cmd, d, last_cd.as_deref())
                {
                    return Some(sv);
                }
            }
            continue;
        }
        if ev.verb == "gh" {
            if let Some(m) = gh_self_credit_message(ctx, &ev.args) {
                return Some(m);
            }
            continue;
        }
        if ev.verb == "xargs" {
            if let Some(xv) = xargs_git_verdict(ctx, &ev, d, cmd, &heredoc_bodies, last_cd.as_deref(), true) {
                return Some(xv);
            }
            continue;
        }
        if ev.verb == "find" {
            if let Some(fv) = find_exec_verdict(ctx, &ev, d, cmd, &heredoc_bodies, last_cd.as_deref(), true) {
                return Some(fv);
            }
            continue;
        }
        if ev.verb == "parallel" {
            if let Some(pa) = parallel_verdict(ctx, &ev, d, cmd, &heredoc_bodies, last_cd.as_deref(), true) {
                return Some(pa);
            }
            continue;
        }
        if ev.verb != "git" {
            continue;
        }
        if let Some(gv) = git_verdict(ctx, &ev, d, cmd, &heredoc_bodies, last_cd.as_deref(), true) {
            return Some(gv);
        }
        if ctx.handover_adds.len() < 50 && ev.args.iter().any(|t| t.text == "add") {
            let (add_sub, add_rest) = git_subcommand(&ev.args);
            if add_sub.as_deref() == Some("add") {
                let specs: Vec<String> =
                    add_rest.iter().filter(|t| !t.text.starts_with('-') || t.text == "--").map(|t| t.text.clone()).filter(|x| x != "--").collect();
                let broad = specs.is_empty() || add_rest.iter().any(|t| is_broad_add_flag(&t.text));
                if broad {
                    ctx.handover_adds.push(".".into());
                }
                for s in specs {
                    let one = s.strip_prefix("./").unwrap_or(&s).to_string();
                    ctx.handover_adds.push(if one.is_empty() { ".".into() } else { one });
                }
            }
        }
        if let Some(hv) = handover_commit_verdict(ctx, &ev, last_cd.as_deref()) {
            return Some(hv);
        }
    }
    if d == 0
        && let Some(lb) = launcher_backstop(ctx, &scan_text, base_cwd)
    {
        return Some(lb);
    }
    git_backstop(ctx, &scan_text, d, &heredoc_bodies, base_cwd)
}

fn replace_bs_nt(s: &str) -> String {
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '\\' && i + 1 < cs.len() && (cs[i + 1] == 'n' || cs[i + 1] == 't') {
            out.push('\n');
            i += 2;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

fn is_broad_add_flag(t: &str) -> bool {
    // /^-(?:[A-Za-z]*[Au][A-Za-z]*|-all|-update)$/
    if t == "--all" || t == "--update" {
        return true;
    }
    t.len() >= 2 && t.starts_with('-') && t[1..].chars().all(|c| c.is_ascii_alphabetic()) && t[1..].chars().any(|c| c == 'A' || c == 'u')
}

/// The block message for one git command, if any: force push, AI self-credit, broad add, handover commit, hook-dir writes and the other git rules.
///
/// Mirrors `git-guard.js` `gitVerdict`.
pub fn git_verdict(ctx: &mut Ctx, ev: &Ev, d: usize, cmd: &str, hb: &Hb, last_cd: Option<&str>, _use_jev: bool) -> Option<String> {
    let args = &ev.args;
    let mut j = 0;
    while j + 1 < args.len() {
        if args[j].text == "-c" {
            let v = args[j + 1].text.as_str();
            if let Some(eq) = v.find('=')
                && eq >= 1
                && let Some(hit) = scan_command_value(ctx, &v[eq + 1..], d)
            {
                return Some(hit);
            }
        }
        j += 1;
    }
    let (sub, rest) = git_subcommand(args);
    let sub = sub?;
    if let Some(h) = alias_git_verdict(ctx, args, &sub, &rest, last_cd, d, &ev.env) {
        return Some(h);
    }
    if sub == "config" {
        for t in &rest {
            if t.text.starts_with('-') {
                continue;
            }
            if let Some(hit) = scan_command_value(ctx, &t.text, d) {
                return Some(hit);
            }
        }
    }
    if sub == "push" {
        if is_force_push(&rest) {
            return Some(block("msg_force_push", &[]));
        }
        if is_delete_ref_push(&rest) {
            return Some(block("msg_delete_ref", &[("skip", &ctx.skip_cmd(&tables().guard_name))]));
        }
        if has_cmd_subst_arg(&rest) {
            static HD: OnceLock<Regex> = OnceLock::new();
            let hd = HD.get_or_init(|| lit_re(r#"<<-?[ \t]*['"\\]?[A-Za-z_]"#));
            let mut m = block("msg_push_cmdsubst", &[]);
            if hd.is_match(&ctx.raw_cmd) {
                m.push_str(plain("push_cmdsubst_heredoc_note"));
            }
            return Some(m);
        }
    }
    if tables().backstop_commit_subs.has(&sub) {
        if has_self_credit_trailer_key_remap(args) {
            return Some(block("msg_trailer_remap", &[]));
        }
        for m in inline_commit_messages(&rest) {
            let n = norm_escapes(&m);
            if credit_regexes(&m) || credit_regexes(&n) {
                return Some(block("msg_commit_credit", &[]));
            }
        }
        if _use_jev && inline_commit_messages(&rest).iter().any(|m| !m.is_empty()) {
            ctx.jev_wanted = true;
        }
        for spec in file_commit_messages(&rest) {
            let text: Option<String>;
            let mut cached_credit: Option<bool> = None;
            if spec == "-" || spec == "/dev/stdin" {
                let (t, c) = hb.stdin_candidate(cmd);
                text = t;
                cached_credit = Some(c);
            } else {
                let mut p = spec.clone();
                if !p.starts_with('/')
                    && let Some(cd) = last_cd.filter(|c| !c.is_empty())
                {
                    p = path_join(cd, &p);
                }
                let abs = ctx.abs_from_cwd(&p);
                text = read_file_lossy(&abs);
            }
            let Some(text) = text else { continue };
            if cached_credit.unwrap_or_else(|| credit_regexes(&text)) {
                return Some(block("msg_commit_file_credit", &[]));
            }
            if _use_jev {
                ctx.jev_wanted = true;
            }
        }
    }
    if tables().commit_creating.has(&sub) && raw_has_credit(ctx) {
        return Some(block("msg_creating_credit", &[("sub", &sub)]));
    }
    None
}

// ---------------------------------------------------------------------------------------------------
// quote-blind backstop

/// Mirrors `git-guard.js` `backstopEnv`.
fn backstop_env(cmd: &str) -> Env {
    let mut env = Env::new();
    for seg in split_segments(cmd) {
        let (inline, persist) = segment_env(&tokenize(&seg));
        env.extend(persist);
        env.extend(inline);
    }
    env
}

fn word_git(line: &str) -> bool {
    // /\bgit\b/ (ASCII word boundaries)
    let b = line.as_bytes();
    let wc = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    let mut from = 0;
    while let Some(p) = line[from..].find("git") {
        let s = from + p;
        let e = s + 3;
        let before_ok = s == 0 || !wc(b[s - 1]);
        let after_ok = e >= b.len() || !wc(b[e]);
        if before_ok && after_ok {
            return true;
        }
        from = s + 1;
    }
    false
}

/// Mirrors `git-guard.js` `gitBackstopLines`.
fn git_backstop_lines(ctx: &mut Ctx, cmd: &str, d: usize, hb: &Hb, cwd: Option<&str>) -> Option<String> {
    let benv = backstop_env(cmd);
    // cmd.replace(/\\\r?\n/g, ' ')
    let cs: Vec<char> = cmd.chars().collect();
    let mut joined = String::new();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '\\' && (cs.get(i + 1) == Some(&'\n') || (cs.get(i + 1) == Some(&'\r') && cs.get(i + 2) == Some(&'\n'))) {
            joined.push(' ');
            i += if cs[i + 1] == '\r' { 3 } else { 2 };
        } else {
            joined.push(cs[i]);
            i += 1;
        }
    }
    for line in joined.split('\n') {
        if !word_git(line) {
            continue;
        }
        for seg in split_segments(line) {
            let tokens = tokenize(&seg);
            if tokens.is_empty() {
                continue;
            }
            let Some(mut ev) = effective_verb(&tokens) else { continue };
            if ev.verb == "xargs" {
                if let Some(xv) = xargs_git_verdict(ctx, &ev, d, cmd, hb, cwd, false) {
                    return Some(xv);
                }
                continue;
            }
            if ev.verb == "find" {
                if let Some(fv) = find_exec_verdict(ctx, &ev, d, cmd, hb, cwd, false) {
                    return Some(fv);
                }
                continue;
            }
            if ev.verb == "parallel" {
                if let Some(pa) = parallel_verdict(ctx, &ev, d, cmd, hb, cwd, false) {
                    return Some(pa);
                }
                continue;
            }
            if ev.verb != "git" {
                continue;
            }
            ev.env = benv.clone();
            if let Some(hit) = git_verdict(ctx, &ev, d, cmd, hb, cwd, false) {
                return Some(hit);
            }
        }
    }
    None
}

/// Mirrors `git-guard.js` `gitBackstop`.
fn git_backstop(ctx: &mut Ctx, cmd: &str, d: usize, hb: &Hb, base_cwd: Option<&str>) -> Option<String> {
    let benv = backstop_env(cmd);
    let cwd = base_cwd.filter(|b| !b.is_empty());
    if d < 3 {
        for payload in piped_echo_shell_payloads(cmd) {
            let pb = Hb::new(extract_heredoc_bodies(&payload));
            if let Some(hit) = git_backstop(ctx, &payload, d + 1, &pb, cwd) {
                return Some(hit);
            }
        }
    }
    for raw in backstop_pieces(cmd) {
        let trimmed = raw.trim_start_matches(is_js_space).to_string();
        let mut variants = vec![trimmed.clone()];
        if trimmed.starts_with('"') || trimmed.starts_with('\'') {
            variants.push(trimmed.trim_start_matches(['"', '\'']).to_string());
        }
        for v in variants {
            if d < 3 {
                let env_payload = extract_env_s_payload(&v);
                if !env_payload.is_empty() {
                    let pb = Hb::new(extract_heredoc_bodies(&env_payload));
                    if let Some(hit) = git_backstop(ctx, &env_payload, d + 1, &pb, cwd) {
                        return Some(hit);
                    }
                    continue;
                }
            }
            let Some(mut ev) = backstop_verb(&v) else { continue };
            if ev.verb == "git" {
                ev.env = benv.clone();
                if let Some(hit) = git_verdict(ctx, &ev, d, cmd, hb, cwd, false) {
                    return Some(hit);
                }
            } else if d < 3 && (ev.verb == "eval" || is_shell_verb(&ev.verb)) {
                let payload = if ev.verb == "eval" { extract_eval_payload(&v) } else { extract_shell_c_payload(&v) };
                if !payload.is_empty() {
                    let pb = Hb::new(extract_heredoc_bodies(&payload));
                    if let Some(hit) = git_backstop(ctx, &payload, d + 1, &pb, cwd) {
                        return Some(hit);
                    }
                }
            }
        }
    }
    git_backstop_lines(ctx, cmd, d, hb, cwd)
}
