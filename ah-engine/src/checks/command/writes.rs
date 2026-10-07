//! The Bash write scan of command-guard.js's edit-guard parity branch (`classifyBashWork` with `editOnly`).
//!
//! Node blocks a main-thread Bash write into a file edit-guard would refuse for the Edit tool. Deciding that needs
//! edit-guard's own verdict, the repo toplevel and the session scratchpad, which the engine does not mirror. So this
//! scan answers a narrower question exactly: could the command produce ANY write target Node would judge? A target
//! Node skips without looking at the file system (one with an expansion or glob character, or a leading `~`) does not
//! count; every other target, and every inline-code body that might name one, makes the engine defer.
use super::shell::{
    basename_lower, blank_test_operators, effective_verb, extract_eval_payload, extract_shell_c_payload, extract_substitutions, is_ws,
    mask_process_substitutions, neutralize_quoted_contents, segment_heredoc_bodies, split_detailed, tokenize_quoted, trim,
};
use super::tables::tables;
use crate::checks::git::tokenize::basename;
use crate::checks::git::util::path_join;
use crate::checks::lit_re;
use regex::Regex;

/// `${NAME}` (not followed by an identifier character) rewritten to `$NAME`, as classifyBashWork does before
/// splitting (the splitter cuts at braces).
///
/// Mirrors `command-guard.js` `.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}(?![A-Za-z0-9_])/g, '$$$1')`.
pub fn unbrace_simple_vars(text: &str) -> String {
    let b = text.as_bytes();
    let n = b.len();
    let mut out = String::with_capacity(n);
    let mut i = 0;
    let ident = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    while i < n {
        if b[i] == b'$' && b.get(i + 1) == Some(&b'{') && b.get(i + 2).is_some_and(|&c| c.is_ascii_alphabetic() || c == b'_') {
            let mut j = i + 3;
            while j < n && ident(b[j]) {
                j += 1;
            }
            if b.get(j) == Some(&b'}') && !b.get(j + 1).is_some_and(|&c| ident(c)) {
                out.push('$');
                out.push_str(&text[i + 2..j]);
                i = j + 1;
                continue;
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

/// The dequoted shell word at `i` (after blanks), or `None` for an fd-dup / process target or an empty word.
///
/// Mirrors `command-guard.js` `readRedirectTarget`.
fn read_redirect_target(s: &str, mut i: usize) -> Option<String> {
    let b = s.as_bytes();
    while i < b.len() && (b[i] == b' ' || b[i] == b'\t') {
        i += 1;
    }
    if i >= b.len() || b[i] == b'&' || b[i] == b'(' {
        return None;
    }
    let mut out = String::new();
    let mut q: Option<u8> = None;
    while i < b.len() {
        let c = b[i];
        if let Some(qc) = q {
            if c == qc {
                q = None;
            } else {
                out.push(c as char);
            }
        } else if c == b'\'' || c == b'"' {
            q = Some(c);
        } else if c == b'\\' && i + 1 < b.len() {
            out.push(b[i + 1] as char);
            i += 1;
        } else if is_ws(c) || matches!(c, b';' | b'|' | b'&' | b'<' | b'>' | b'(' | b')') {
            break;
        } else {
            out.push(c as char);
        }
        i += 1;
    }
    (!out.is_empty()).then_some(out)
}

/// The keep() filter of bashWriteTargets: drops fd-dups, process targets and device files.
fn keep(out: &mut Vec<String>, t: Option<String>) {
    let Some(t) = t else { return };
    if t.is_empty() || t.starts_with('&') || t.starts_with('(') || t.contains('>') || t.starts_with("/dev/") {
        return;
    }
    out.push(t);
}

/// The paths one segment writes. For `cp`/`mv` without `-t` or a trailing `/`, Node asks the file system whether the
/// destination is a directory; this port returns the targets of both answers (a superset).
///
/// Mirrors `command-guard.js` `bashWriteTargets`.
pub fn bash_write_targets(segment: &str) -> Vec<String> {
    static OP: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static REDIR_TOK: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static BARE_REDIR_TOK: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static ALPHA_FLAG: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    let mut out = Vec::new();
    if trim(segment).is_empty() {
        return out;
    }
    // (a) redirects
    let neutral = blank_test_operators(&neutralize_quoted_contents(segment));
    let nb = neutral.as_bytes();
    let op_re = OP.get_or_init(|| lit_re(r"(^|[^<>&])(>\||&?>>?)"));
    for m in op_re.captures_iter(&neutral) {
        let (Some(g1), Some(g2)) = (m.get(1), m.get(2)) else { continue };
        let op = g1.end();
        let mut bs = 0;
        while op > bs && nb[op - 1 - bs] == b'\\' {
            bs += 1;
        }
        if bs % 2 == 1 {
            continue;
        }
        keep(&mut out, read_redirect_target(segment, op + g2.as_str().len()));
    }
    // (b) argv without redirect tokens
    let redir = REDIR_TOK.get_or_init(|| lit_re(r"^\d*(?:&?>>?|>\||<)"));
    let bare = BARE_REDIR_TOK.get_or_init(|| lit_re(r"^\d*(?:&?>>?|>\||<+)$"));
    let raw = tokenize_quoted(segment);
    let mut toks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        if !raw[i].is_empty() && redir.is_match(&raw[i]) {
            if bare.is_match(&raw[i]) {
                i += 1;
            }
            i += 1;
            continue;
        }
        toks.push(raw[i].clone());
        i += 1;
    }
    let verb = effective_verb(segment);
    if verb.is_empty() {
        return out;
    }
    let Some(vi) = toks.iter().position(|t| basename_lower(t) == verb) else { return out };
    let rest = &toks[vi + 1..];
    match verb.as_str() {
        "tee" => {
            for t in rest {
                if !t.starts_with('-') {
                    keep(&mut out, Some(t.clone()));
                }
            }
        }
        "sed" => {
            let alpha = ALPHA_FLAG.get_or_init(|| lit_re(r"^-[A-Za-z]"));
            let (mut in_place, mut script_opt) = (false, false);
            let mut pos: Vec<String> = Vec::new();
            let mut i = 0;
            while i < rest.len() {
                let t = &rest[i];
                if t == "--" {
                    pos.extend(rest[i + 1..].iter().cloned());
                    break;
                }
                if t == "-i" {
                    in_place = true;
                    if rest.get(i + 1).is_some_and(String::is_empty) {
                        i += 1;
                    }
                } else if t == "-e" || t == "-f" || t == "--expression" || t == "--file" {
                    script_opt = true;
                    i += 1;
                } else if t.starts_with("--expression=") || t.starts_with("--file=") {
                    script_opt = true;
                } else if t == "--in-place" || t.starts_with("--in-place=") {
                    in_place = true;
                } else if t.starts_with("--") {
                } else if alpha.is_match(t) {
                    let tb = t.as_bytes();
                    for k in 1..tb.len() {
                        if tb[k] == b'i' {
                            in_place = true;
                            break;
                        }
                        if tb[k] == b'e' || tb[k] == b'f' {
                            script_opt = true;
                            if k == tb.len() - 1 {
                                i += 1;
                            }
                            break;
                        }
                    }
                } else {
                    pos.push(t.clone());
                }
                i += 1;
            }
            if in_place {
                for t in pos.iter().skip(if script_opt { 0 } else { 1 }) {
                    keep(&mut out, Some(t.clone()));
                }
            }
        }
        "perl" => {
            let (mut in_place, mut has_e) = (false, false);
            let mut pos: Vec<String> = Vec::new();
            let mut i = 0;
            while i < rest.len() {
                let t = &rest[i];
                let tb = t.as_bytes();
                if t == "--" {
                    pos.extend(rest[i + 1..].iter().cloned());
                    break;
                }
                if tb.len() >= 2 && tb[0] == b'-' && tb[1] != b'-' {
                    for k in 1..tb.len() {
                        if tb[k] == b'i' {
                            in_place = true;
                            break;
                        }
                        if tb[k] == b'e' || tb[k] == b'E' {
                            has_e = true;
                            if k == tb.len() - 1 {
                                i += 1;
                            }
                            break;
                        }
                    }
                } else if !t.starts_with("--") {
                    pos.push(t.clone());
                }
                i += 1;
            }
            if in_place {
                for t in pos.iter().skip(if has_e { 0 } else { 1 }) {
                    keep(&mut out, Some(t.clone()));
                }
            }
        }
        "cp" | "mv" => {
            let mut tdir: Option<String> = None;
            let mut pos: Vec<String> = Vec::new();
            let mut i = 0;
            while i < rest.len() {
                let t = &rest[i];
                if t == "--" {
                    pos.extend(rest[i + 1..].iter().cloned());
                    break;
                }
                if t == "-t" || t == "--target-directory" {
                    // JavaScript `rest[i + 1] || null`: an empty word counts as no directory
                    tdir = rest.get(i + 1).filter(|s| !s.is_empty()).cloned();
                    i += 2;
                    continue;
                }
                if let Some(v) = t.strip_prefix("--target-directory=") {
                    tdir = Some(v.to_string());
                } else if t.len() > 2 && t.starts_with("-t") && !matches!(t.as_bytes()[2], b'\n' | b'\r') {
                    // JavaScript `/^-t./`: `.` matches neither a newline nor a carriage return
                    tdir = Some(t[2..].to_string());
                } else if t == "-S" || t == "--suffix" {
                    i += 1;
                } else if !t.starts_with('-') {
                    pos.push(t.clone());
                }
                i += 1;
            }
            let (dest, srcs) = match tdir.clone() {
                Some(d) => (d, pos.clone()),
                None => {
                    if pos.len() < 2 {
                        return out;
                    }
                    (pos[pos.len() - 1].clone(), pos[..pos.len() - 1].to_vec())
                }
            };
            let known_dir = tdir.is_some() || dest.ends_with('/');
            for s in &srcs {
                keep(&mut out, Some(path_join(&dest, &basename(s))));
            }
            if !known_dir {
                keep(&mut out, Some(dest.clone()));
            }
            if verb == "mv" {
                for s in &srcs {
                    keep(&mut out, Some(s.clone()));
                }
            }
        }
        _ => {}
    }
    out
}

/// True when inline interpreter code in the segment might name a literal write target.
///
/// A superset of `command-guard.js` `inlineWriteLiterals` (via `inlineCodeBody`): every literal-write pattern there
/// needs one of the `inline_write_markers` in the code.
fn inline_may_write(segment: &str) -> bool {
    let t = tables();
    let verb = effective_verb(segment).replace(['"', '\''], "");
    if !t.inline_verbs.contains(&verb) {
        return false;
    }
    let toks = tokenize_quoted(segment);
    let Some(vi) = toks.iter().position(|x| basename_lower(x) == verb) else { return false };
    let flags = if verb.starts_with("python") { &t.inline_python_flags } else { &t.inline_other_flags };
    let Some(fi) = toks.iter().enumerate().position(|(k, x)| k > vi && flags.contains(x)) else { return false };
    let Some(body) = toks.get(fi + 1) else { return false };
    t.inline_write_markers.iter().any(|m| body.contains(m.as_str()))
}

/// True when Node's resolveWriteTarget might return a resolvable target (anything but the forms it skips without
/// looking at the file system).
fn resolvable(t: &str) -> bool {
    !(t.is_empty() || t.contains(tables().unknowable.as_slice()) || t.starts_with('~'))
}

/// The commands a list of segments runs inline: `sh -c`, `eval`, and the last heredoc body fed to a shell without `-c`.
///
/// Mirrors `command-guard.js` `shellRunPayloads`.
pub fn shell_run_payloads(segments: &[String], text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut bodies: Option<Vec<Vec<String>>> = None;
    for (i, seg) in segments.iter().enumerate() {
        let c = extract_shell_c_payload(seg);
        if !c.is_empty() {
            out.push(c.clone());
        }
        let e = extract_eval_payload(seg);
        if !e.is_empty() {
            out.push(e);
        }
        if c.is_empty() && tables().shell_verbs.contains(&effective_verb(seg)) && seg.contains("<<") {
            let all = bodies.get_or_insert_with(|| segment_heredoc_bodies(segments, text));
            if let Some(last) = all.get(i).and_then(|b| b.last())
                && !last.is_empty()
            {
                out.push(last.clone());
            }
        }
    }
    out
}

/// True when the Bash write scan could find a target Node would judge, in the command or anything it runs inline.
///
/// Mirrors the target walk of `command-guard.js` `classifyBashWorkImpl` (`editOnly`): git segments never add an edit
/// block there, so they are skipped here too.
pub fn may_write(command: &str, depth: usize) -> bool {
    let t = tables();
    if trim(command).is_empty() || command.len() > t.max_len {
        return false;
    }
    let (masked, inners) =
        if command.contains("<(") || command.contains(">(") { mask_process_substitutions(command) } else { (command.to_string(), Vec::new()) };
    let masked = blank_test_operators(&masked);
    let split = split_detailed(&unbrace_simple_vars(&masked));
    for seg in &split.segments {
        if effective_verb(seg) == "git" {
            continue;
        }
        if bash_write_targets(seg).iter().any(|x| resolvable(x)) || inline_may_write(seg) {
            return true;
        }
    }
    if depth < t.max_depth {
        let mut inner = shell_run_payloads(&split.segments, &masked);
        inner.extend(extract_substitutions(&masked));
        inner.extend(inners);
        return inner.iter().any(|s| may_write(s, depth + 1));
    }
    false
}
