//! What counts as a file-changing action in a transcript: a port of `hooks/lib/work-detect.js` (`isCountedWork` and what it
//! calls). One definition, shared by the tasklist Stop gate and the other checks that judge work.
//!
//! A relative path is resolved by Node against the hook process's working directory, which the engine does not know. Claude Code
//! starts a hook in the session's directory, which the payload names (`cwd`), so a relative path is judged against that. The
//! assumption can only make the engine count more work than Node (a relative path Node's directory would have excluded is
//! counted), never less, which is the safe direction for a guard: more counted work means the engine hands the call to Node. A
//! relative path with a `..` segment, or a session directory under the temp root, is [`Unsure`].
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::paths::{is_absolute, resolve_abs};
use crate::checks::guardkit::text::{is_js_space, js_trim};
use crate::checks::taskkit::jsval::{R, Unsure, get, truthy};
use crate::defaults;
use regex::Regex;
use serde_json::Value;

struct Pats {
    always: Regex,
    cmd_pos: Regex,
    scratchpad: Regex,
    state_dir: Regex,
    housekeeping: Regex,
    crontab: Regex,
    tmp_target: Regex,
    dev_null: Regex,
    heredoc_delim: Regex,
}

fn pats() -> &'static Pats {
    static P: crate::defaults::Cache<Pats> = crate::defaults::Cache::new();
    P.get_or_init(|| {
        let c = |k: &str, ci: bool| jsre::compile(defaults::text(k), ci);
        Pats {
            always: c("workdetect.always_work", true),
            cmd_pos: c("workdetect.command_position", true),
            scratchpad: c("workdetect.scratchpad_path", false),
            state_dir: c("workdetect.state_dir", false),
            housekeeping: c("workdetect.devswarm_housekeeping", true),
            crontab: c("workdetect.crontab_segment", true),
            tmp_target: c("workdetect.tmp_housekeeping_target", true),
            dev_null: c("workdetect.dev_null", false),
            heredoc_delim: c("workdetect.heredoc_delimiter", false),
        }
    })
}

/// Blank the contents of single- and double-quoted spans (delimiters included): `neutralizeQuotedContents`.
pub fn neutralize_quoted(cmd: &str) -> String {
    let cs: Vec<char> = cmd.chars().collect();
    let mut out = String::with_capacity(cmd.len());
    let (mut single, mut double) = (false, false);
    let mut i = 0usize;
    while i < cs.len() {
        let c = cs[i];
        let has_next = i + 1 < cs.len();
        if single {
            out.push(' ');
            if c == '\'' {
                single = false;
            }
            i += 1;
            continue;
        }
        if double {
            if c == '\\' && has_next {
                out.push_str("  ");
                i += 2;
                continue;
            }
            out.push(' ');
            if c == '"' {
                double = false;
            }
            i += 1;
            continue;
        }
        if c == '\'' {
            single = true;
            out.push(' ');
        } else if c == '"' {
            double = true;
            out.push(' ');
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// `(?<![0-9&])>{1,2}(?!&)`: a `>` or `>>` that is a file redirect, not a descriptor duplicate.
pub fn has_file_redirect(s: &str) -> bool {
    let cs: Vec<char> = s.chars().collect();
    (0..cs.len()).any(|i| {
        if cs[i] != '>' || (i > 0 && (cs[i - 1].is_ascii_digit() || cs[i - 1] == '&')) {
            return false;
        }
        // one or two `>`, whichever leaves no `&` right after
        let two = cs.get(i + 1) == Some(&'>');
        (two && cs.get(i + 2) != Some(&'&')) || cs.get(i + 1) != Some(&'&')
    })
}

/// `BASH_WORK_RE.test(neutralized)`.
pub fn bash_work(neutralized: &str) -> bool {
    pats().always.is_match(neutralized) || pats().cmd_pos.is_match(neutralized) || has_file_redirect(neutralized)
}

/// The temp directory `os.tmpdir()` reports for an environment.
pub fn tmpdir(get_env: &dyn Fn(&str) -> Option<String>) -> String {
    let mut p = defaults::list("taskkit.tmp_env_names").iter().find_map(|k| get_env(k).filter(|v| !v.is_empty())).unwrap_or_else(|| "/tmp".to_string());
    if p.len() > 1 && p.ends_with('/') {
        p.pop();
    }
    p
}

/// A tool-call context: the temp root and the directory relative paths are judged against.
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    /// `os.tmpdir()` of the hook's environment.
    pub tmp: &'a str,
    /// The session's working directory from the payload, when it is absolute.
    pub cwd: Option<&'a str>,
}

fn is_under(path: &str, root: &str) -> bool {
    path == root || path.strip_prefix(root).is_some_and(|r| r.starts_with('/'))
}

/// `isUnderTmpRoot(p)`: `p` resolved is the temp root or below it.
fn under_tmp_root(p: &str, cx: Ctx<'_>) -> R<bool> {
    if p.is_empty() {
        return Ok(false);
    }
    if is_absolute(p) {
        return Ok(is_under(&resolve_abs(p), cx.tmp));
    }
    let Some(cwd) = cx.cwd.filter(|c| is_absolute(c)) else { return Err(Unsure) };
    if p.split('/').any(|seg| seg == "..") || is_under(&resolve_abs(cwd), cx.tmp) {
        return Err(Unsure);
    }
    Ok(false)
}

/// `isExcludedWritePath(fp)`: the scratchpad, an anti-hall state directory, or a copy under the temp root.
pub fn is_excluded_write_path(fp: &str, cx: Ctx<'_>) -> R<bool> {
    if fp.is_empty() {
        return Ok(false);
    }
    let p = pats();
    if p.scratchpad.is_match(fp) || p.state_dir.is_match(fp) {
        return Ok(true);
    }
    under_tmp_root(fp, cx)
}

/// `hasExcludedPathHint(cmd)`.
fn has_excluded_path_hint(cmd: &str, root: &str) -> bool {
    if cmd.is_empty() {
        return false;
    }
    let p = pats();
    p.scratchpad.is_match(cmd) || p.state_dir.is_match(cmd) || (!root.is_empty() && cmd.contains(root))
}

/// `allPathsExcluded(neutralized)`: every token with a `/` is an excluded path.
fn all_paths_excluded(neutralized: &str, cx: Ctx<'_>) -> R<bool> {
    for tok in neutralized.split(is_js_space).filter(|t| !t.is_empty()) {
        if !tok.contains('/') {
            continue;
        }
        if !is_excluded_write_path(tok, cx)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Split a command into segments the way `rawCmd.split(/&&|\|\||;|\||\n|(?<![<>])&(?!>)/)` does.
fn split_segments(cmd: &str) -> Vec<String> {
    let cs: Vec<char> = cmd.chars().collect();
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut i = 0usize;
    while i < cs.len() {
        let c = cs[i];
        let n = cs.get(i + 1).copied();
        let sep = if (c == '&' && n == Some('&')) || (c == '|' && n == Some('|')) {
            2
        } else if c == ';' || c == '|' || c == '\n' || (c == '&' && !(i > 0 && matches!(cs[i - 1], '<' | '>')) && n != Some('>')) {
            1
        } else {
            0
        };
        if sep > 0 {
            out.push(std::mem::take(&mut cur));
            i += sep;
        } else {
            cur.push(c);
            i += 1;
        }
    }
    out.push(cur);
    out
}

/// `REAL_REDIRECT_RE.exec(s)`: the target after the first file redirect, `(?<![0-9&])>{1,2}(?!&)\s*(\S+)`.
fn real_redirect_target(s: &str) -> Option<String> {
    let cs: Vec<char> = s.chars().collect();
    for i in 0..cs.len() {
        if cs[i] != '>' || (i > 0 && (cs[i - 1].is_ascii_digit() || cs[i - 1] == '&')) {
            continue;
        }
        let two = cs.get(i + 1) == Some(&'>');
        for len in if two { vec![2usize, 1] } else { vec![1usize] } {
            let after = i + len;
            if cs.get(after) == Some(&'&') {
                continue;
            }
            let mut j = after;
            while j < cs.len() && is_js_space(cs[j]) {
                j += 1;
            }
            let start = j;
            while j < cs.len() && !is_js_space(cs[j]) {
                j += 1;
            }
            if j > start {
                return Some(cs[start..j].iter().collect());
            }
        }
    }
    None
}

/// `segmentEscapesHousekeeping(seg)`.
fn segment_escapes_housekeeping(seg: &str) -> bool {
    let n = neutralize_quoted(seg);
    if n.contains("$(") || n.contains('`') {
        return true;
    }
    match real_redirect_target(&n) {
        Some(t) => !pats().dev_null.is_match(&t) && !pats().tmp_target.is_match(&t),
        None => false,
    }
}

/// `stripHeredocBodies(cmd)`: the command without heredoc bodies, or `None` when a body holds a command substitution.
fn strip_heredoc_bodies(cmd: &str) -> Option<String> {
    let mut out: Vec<&str> = Vec::new();
    let mut delim: Option<String> = None;
    for line in cmd.split('\n') {
        if let Some(d) = &delim {
            if line.contains("$(") || line.contains('`') {
                return None;
            }
            if js_trim(line) == d {
                delim = None;
            }
            continue;
        }
        out.push(line);
        let neutral = neutralize_quoted(line);
        // the first `#` that starts a comment: at the start or after white space
        let cs: Vec<char> = neutral.chars().collect();
        let hash = (0..cs.len()).find(|&i| cs[i] == '#' && (i == 0 || is_js_space(cs[i - 1]))).map(|i| if i == 0 { 0 } else { i - 1 });
        let (code, scan): (String, Vec<char>) = match hash {
            Some(h) => (line.chars().take(h).collect(), cs[..h].to_vec()),
            None => (line.to_string(), cs.clone()),
        };
        // an operator `<<`: not part of `<<<`, not backslash-escaped
        let mut at: Option<usize> = None;
        let mut k = 0usize;
        while k + 1 < scan.len() {
            if scan[k] == '<' && scan[k + 1] == '<' && !(k > 0 && scan[k - 1] == '<') && scan.get(k + 2) != Some(&'<') {
                let mut bs = 0usize;
                while k > bs && scan[k - 1 - bs] == '\\' {
                    bs += 1;
                }
                if bs.is_multiple_of(2) {
                    at = Some(k);
                    break;
                }
            }
            k += 1;
        }
        let Some(at) = at else { continue };
        let rest: String = code.chars().skip(at).collect();
        if let Some(m) = pats().heredoc_delim.captures(&rest) {
            let word = m.get(1).map_or("", |g| g.as_str());
            delim = Some(unquote_delim(word));
        }
    }
    Some(out.join("\n"))
}

/// `word.replace(/\\(.)|['"]/g, (_, c) => c || '')`.
fn unquote_delim(word: &str) -> String {
    let mut out = String::new();
    let mut it = word.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\\' => match it.peek() {
                Some(&n) if !matches!(n, '\n' | '\r' | '\u{2028}' | '\u{2029}') => {
                    out.push(n);
                    it.next();
                }
                _ => out.push('\\'),
            },
            '\'' | '"' => {}
            c => out.push(c),
        }
    }
    out
}

/// `isDevswarmHousekeepingOnly(rawCmd)`: every segment is a DevSwarm launcher verb or a crontab call, with no escaping write.
pub fn is_devswarm_housekeeping_only(raw: &str) -> bool {
    if raw.is_empty() {
        return false;
    }
    let owned;
    let mut cmd = raw;
    if raw.contains("<<") {
        match strip_heredoc_bodies(raw) {
            Some(s) => {
                owned = s;
                cmd = &owned;
            }
            None => return false,
        }
    }
    let mut saw_any = false;
    for seg in split_segments(cmd) {
        let s = js_trim(&seg);
        if s.is_empty() {
            continue;
        }
        saw_any = true;
        if !pats().housekeeping.is_match(s) && !crontab_segment(s) {
            return false;
        }
        if segment_escapes_housekeeping(s) {
            return false;
        }
    }
    saw_any
}

/// `/^[({\s]*crontab(?![\w.-])/i`.
fn crontab_segment(s: &str) -> bool {
    let Some(m) = pats().crontab.find(s) else { return false };
    !s[m.end()..].chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// `isCountedWork(tu)` for a tool-use block.
pub fn is_counted_work(tu: &Value, cx: Ctx<'_>) -> R<bool> {
    let name = get(tu, "name").filter(|v| truthy(v)).and_then(Value::as_str).unwrap_or("");
    if defaults::list("workdetect.never_work_tools").contains(&name) {
        return Ok(false);
    }
    let input = get(tu, "input").filter(|v| truthy(v));
    if defaults::list("workdetect.mutating_tools").contains(&name) {
        let fp = input.and_then(|i| get(i, "file_path")).and_then(Value::as_str).unwrap_or("");
        return Ok(!is_excluded_write_path(fp, cx)?);
    }
    if name == "Bash" {
        let cmd = input.and_then(|i| get(i, "command")).and_then(Value::as_str).unwrap_or("");
        if cmd.is_empty() || is_devswarm_housekeeping_only(cmd) {
            return Ok(false);
        }
        let n = neutralize_quoted(cmd);
        if !bash_work(&n) {
            return Ok(false);
        }
        let scratch_only = has_excluded_path_hint(cmd, cx.tmp) && !pats().always.is_match(&n) && all_paths_excluded(&n, cx)?;
        return Ok(!scratch_only);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TMP: &str = "/var/folders/6s/s5c6_sx91wl2rxby6l4gmkzh0000gn/T";

    fn cx() -> Ctx<'static> {
        Ctx { tmp: TMP, cwd: Some("/home/u/proj") }
    }

    /// Expected values computed with Node: `isCountedWork` of `hooks/lib/work-detect.js` (os.tmpdir() = TMP).
    #[test]
    fn bash_commands_count_as_node_counts_them() {
        let cases: &[(&str, bool)] = &[
            ("git commit -am x", true),
            ("git status", false),
            ("echo hi > f", true),
            ("echo hi 2>/dev/null", false),
            ("cmd >&2", false),
            ("rm f", true),
            ("echo \"rm f\"", false),
            ("a && rm b", true),
            ("cat > /x/scratchpad/y <<EOF\nz\nEOF", false),
            ("cp /x/scratchpad/a /repo/b", true),
            ("node devswarm.js inbox read-primary abc", false),
            ("node devswarm.js roster > src/x.js", true),
            ("crontab -l > /tmp/x", false),
            ("crontab -l > src/x", true),
            ("crontab-parser x", false),
            ("node devswarm.js send x <<EOF\na -> b\nEOF", false),
            ("node devswarm.js send x <<EOF\n$(rm f)\nEOF", true),
            ("sed -i s/a/b/ f", true),
            ("patch -p1 < x.patch", true),
            ("touch /x/scratchpad/f", false),
            ("git commit -m x && rm /x/scratchpad/y", true),
            ("echo x >> .anti-hall/progress/a.md", false),
            ("ls", false),
            ("", false),
            ("make -j4", true),
        ];
        for (cmd, want) in cases {
            let tu = json!({"type": "tool_use", "name": "Bash", "input": {"command": cmd}});
            assert_eq!(is_counted_work(&tu, cx()), Ok(*want), "{cmd:?}");
        }
    }

    #[test]
    fn file_tools_count_unless_the_path_is_excluded() {
        let cases: &[(&str, bool)] = &[
            ("/p/src/a.js", true),
            ("/p/x/scratchpad/y", false),
            ("/p/.anti-hall/progress/2026-01-01/s.md", false),
            ("", true),
            ("/tmp/x", true),
            ("/private/tmp/y", true),
            ("/p/.anti-hall/other/z", true),
        ];
        for (fp, want) in cases {
            let tu = json!({"type": "tool_use", "name": "Edit", "input": {"file_path": fp}});
            assert_eq!(is_counted_work(&tu, cx()), Ok(*want), "{fp:?}");
        }
        let under = json!({"type": "tool_use", "name": "Write", "input": {"file_path": format!("{TMP}/a/b")}});
        assert_eq!(is_counted_work(&under, cx()), Ok(false));
        let rel = json!({"type": "tool_use", "name": "Write", "input": {"file_path": "rel/a"}});
        assert_eq!(is_counted_work(&rel, cx()), Ok(true), "a relative path outside the temp root counts");
        assert_eq!(is_counted_work(&rel, Ctx { tmp: TMP, cwd: None }), Err(Unsure), "no directory to judge it against");
        assert_eq!(is_counted_work(&rel, Ctx { tmp: TMP, cwd: Some(&format!("{TMP}/x")) }), Err(Unsure), "a session directory under the temp root");
        let up = json!({"type": "tool_use", "name": "Write", "input": {"file_path": "../a"}});
        assert_eq!(is_counted_work(&up, cx()), Err(Unsure), "a path that climbs out");
    }

    #[test]
    fn tmpdir_follows_node() {
        let e = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string());
        assert_eq!(tmpdir(&e(&[("TMPDIR", "/a/b/")])), "/a/b");
        assert_eq!(tmpdir(&e(&[("TMP", "/c")])), "/c");
        assert_eq!(tmpdir(&e(&[("TMPDIR", ""), ("TEMP", "/d")])), "/d");
        assert_eq!(tmpdir(&e(&[])), "/tmp");
        assert_eq!(tmpdir(&e(&[("TMPDIR", "/")])), "/");
    }
}
