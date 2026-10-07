//! Wrapper payload extraction: eval, `sh -c`, `env -S`, piped `echo ... | sh`, positional forwarding.
use super::tables::tables;
use super::tokenize::*;
use crate::checks::lit_re;
use regex::Regex;

/// The script text `eval` receives from a segment (its arguments joined the way the shell does).
///
/// Mirrors `git-guard.js` `extractEvalPayload`.
pub fn extract_eval_payload(segment: &str) -> String {
    let tokens = tokenize(segment);
    let Some(ev) = effective_verb(&tokens) else { return String::new() };
    if ev.verb != "eval" {
        return String::new();
    }
    ev.args.iter().map(|t| t.text.as_str()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
}

fn is_c_flag(t: &str) -> bool {
    if t == "-c" || t == "--command" {
        return true;
    }
    // /^-[a-z]*c$/
    t.len() >= 2 && t.starts_with('-') && t.ends_with('c') && t[1..].chars().all(|c| c.is_ascii_lowercase())
}

/// True for a shell flag cluster that contains `c` (`-c`, `-lc`, `-ec`, ...).
pub fn is_c_flag_pub(t: &str) -> bool {
    is_c_flag(t)
}

/// The script a shell receives through `-c` in a segment, with positional parameters substituted.
///
/// Mirrors `git-guard.js` `extractShellCPayload`.
pub fn extract_shell_c_payload(segment: &str) -> String {
    let tokens = tokenize(segment);
    let Some(ev) = effective_verb(&tokens) else { return String::new() };
    if !is_shell_verb(&ev.verb) {
        return String::new();
    }
    let args = &ev.args;
    for i in 0..args.len() {
        let t = args[i].text.as_str();
        if is_c_flag(t) {
            if i + 1 >= args.len() {
                return String::new();
            }
            return forward_positional(&args[i + 1].text, &args[i + 2..]);
        }
        if t == "<<<" {
            return if i + 1 < args.len() { args[i + 1].text.clone() } else { String::new() };
        }
    }
    String::new()
}

fn shq(w: &str) -> String {
    if !w.is_empty() && w.chars().all(|c| c.is_ascii_alphanumeric() || "_./:=@%+,{}-".contains(c)) {
        w.to_string()
    } else {
        format!("'{}'", w.replace('\'', "'\\''"))
    }
}

fn fp_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| lit_re(r#""\$(?:\{([0-9]+|[@*])\}|([0-9@*]))"|\$(?:\{([0-9]+|[@*])\}|([0-9@*]))"#))
}

/// Substitute `$1`, `$@` and friends in `script` with the positional arguments after the script.
///
/// Mirrors `git-guard.js` `forwardPositional`.
pub fn forward_positional(script: &str, pos: &[Tok]) -> String {
    if pos.is_empty() || !script.contains('$') {
        return script.to_string();
    }
    let word = |t: &Tok, quoted: bool| -> String {
        if quoted { shq(&t.text) } else { t.text.split(is_js_space).filter(|x| !x.is_empty()).map(shq).collect::<Vec<_>>().join(" ") }
    };
    let val = |r: &str, quoted: bool| -> String {
        if r == "@" || r == "*" {
            return pos[1.min(pos.len())..].iter().map(|t| word(t, quoted)).collect::<Vec<_>>().join(" ");
        }
        match r.parse::<usize>() {
            Ok(n) if n < pos.len() => word(&pos[n], quoted),
            _ => String::new(),
        }
    };
    fp_re()
        .replace_all(script, |c: &regex::Captures| {
            let a = c.get(1).or_else(|| c.get(2));
            if let Some(a) = a {
                val(a.as_str(), true)
            } else {
                let e = c.get(3).or_else(|| c.get(4)).map_or("", |m| m.as_str());
                val(e, false)
            }
        })
        .to_string()
}

/// The script `env -S` splits out of its argument string.
///
/// Mirrors `git-guard.js` `extractEnvSPayload`.
pub fn extract_env_s_payload(segment: &str) -> String {
    let tokens = tokenize(segment);
    let mut idx = 0;
    while idx < tokens.len() && !tokens[idx].quoted_only && is_assign(&tokens[idx].text) {
        idx += 1;
    }
    if idx >= tokens.len() || tokens[idx].quoted_only || tokens[idx].text != "env" {
        return String::new();
    }
    idx += 1;
    while idx < tokens.len() {
        let t = &tokens[idx];
        let w = if t.quoted_only { "" } else { t.text.as_str() };
        if w == "-S" || w == "--split-string" {
            return if idx + 1 < tokens.len() { tokens[idx + 1].text.clone() } else { String::new() };
        }
        if let Some(v) = w.strip_prefix("--split-string=") {
            return v.to_string();
        }
        if !w.is_empty() && (w.starts_with('-') || is_assign(w)) {
            idx += 1;
            continue;
        }
        break;
    }
    String::new()
}

/// PIPED_ECHO_SHELL_RE, hand-matched (it needs a backreference): `echo|printf 'TEXT' | <shell>` at a command start.
///
/// Mirrors `git-guard.js` `pipedEchoShellPayloads`.
pub fn piped_echo_shell_payloads(cmd: &str) -> Vec<String> {
    let s: Vec<char> = cmd.chars().collect();
    let n = s.len();
    let mut out = Vec::new();
    let ws = |p: usize| -> usize {
        let mut q = p;
        while q < n && is_js_space(s[q]) {
            q += 1;
        }
        q
    };
    let try_at = |prefix_end: usize| -> Option<(usize, String)> {
        let mut p = ws(prefix_end);
        let verb_end = if s[p.min(n)..].starts_with(&['e', 'c', 'h', 'o']) {
            p + 4
        } else if s[p.min(n)..].starts_with(&['p', 'r', 'i', 'n', 't', 'f']) {
            p + 6
        } else {
            return None;
        };
        p = verb_end;
        let q0 = ws(p);
        if q0 == p {
            return None;
        }
        p = q0;
        let q = *s.get(p)?;
        if q != '\'' && q != '"' {
            return None;
        }
        let close = s[p + 1..].iter().position(|&c| c == q)? + p + 1;
        let payload: String = s[p + 1..close].iter().collect();
        p = ws(close + 1);
        if s.get(p) != Some(&'|') {
            return None;
        }
        p = ws(p + 1);
        let mut matched = None;
        for v in tables().shell_verbs.iter() {
            let vc: Vec<char> = v.chars().collect();
            if s[p.min(n)..].starts_with(&vc) {
                matched = Some(p + vc.len());
                break;
            }
        }
        let after = matched?;
        let run_end = ws(after);
        let has_nl = s[after..run_end].contains(&'\n');
        let ok = has_nl || run_end >= n || matches!(s[run_end], ';' | '&' | ')' | '\n');
        if !ok {
            return None;
        }
        Some((run_end, payload))
    };
    let mut p = 0usize;
    while p <= n {
        let mut hit = None;
        if p == 0 {
            hit = try_at(0);
        }
        if hit.is_none() && p < n && (s[p] == ';' || s[p] == '&' || s[p] == '\n') {
            hit = try_at(p + 1);
        }
        if hit.is_none() && p < n && s[p] == '(' {
            hit = try_at(p + 1);
        }
        match hit {
            Some((end, payload)) => {
                out.push(payload);
                p = end.max(p + 1);
            }
            None => p += 1,
        }
    }
    out
}
