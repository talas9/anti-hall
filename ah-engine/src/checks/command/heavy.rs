//! The heavy-command classifier of command-guard.js (`isHeavyCommand` and everything it calls).
//!
//! The engine only ever acts on a "not heavy" answer (it then allows); a "heavy" answer defers to the Node hook. So
//! every predicate here may err only toward heavy: the heavy tests (verbs, patterns, `node -e`, git push/pull/fetch,
//! gh mutations, flagged interpreter scripts) are exact ports, and a light exception the port cannot reproduce exactly
//! is simply never granted. The one such exception is the stable-launcher form (`node ~/.anti-hall/bin/...`), whose
//! pattern depends on the home directory of the process that loaded the Node module; it is not granted here.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::shell::{
    Split, blank_pattern_argument, effective_verb, extract_eval_payload, extract_shell_c_payload, extract_substitutions, has_shell_expansion_anywhere,
    has_substitution_outside_single_quotes, has_unquoted_redirect_char, is_ws, neutralize_quoted_contents, split_detailed, tokenize_quoted, trim, words,
};
use super::tables::{NegLight, tables};
use crate::checks::git::tokenize::basename;
use crate::checks::lit_re;
use regex::Regex;
use std::collections::HashSet;

/// True when `text[..e]` ends where JavaScript `\b` holds after a word character.
fn word_boundary_after(text: &str, e: usize) -> bool {
    text.as_bytes().get(e).is_none_or(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))
}

/// A light exception with a trailing negative lookahead: HEAD`\b(?![^\n]*NOT)`.
///
/// Mirrors the JavaScript lookahead exactly by enumerating every end point of a `head` match.
fn neg_light_match(nl: &NegLight, text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let mut from = 0;
    while let Some(p) = lower[from..].find(&nl.end) {
        let e = from + p + nl.end.len();
        from = from + p + 1;
        if !word_boundary_after(text, e) || !nl.head.is_match(&text[..e]) {
            continue;
        }
        let eol = text[e..].find('\n').map_or(text.len(), |q| q + e);
        let hit = nl.not_after.find_at(text, e).is_some_and(|m| m.start() <= eol);
        if !hit {
            return true;
        }
    }
    false
}

/// The index of the git subcommand after the `git` word at `git_idx`, skipping global options.
///
/// Mirrors `command-guard.js` `gitSubcommandIndex`.
fn git_subcommand_index(tokens: &[String], git_idx: usize) -> Option<usize> {
    let t = tables();
    let mut idx = git_idx + 1;
    while idx < tokens.len() {
        let tok = &tokens[idx];
        if !tok.starts_with('-') {
            return Some(idx);
        }
        let eq = tok.find('=');
        let base = eq.map_or(tok.as_str(), |e| &tok[..e]);
        if t.git_global_value.contains(base) {
            idx += if eq.is_none() { 2 } else { 1 };
            continue;
        }
        idx += 1;
    }
    None
}

/// The tokens of a git segment and the index of its subcommand.
fn git_sub(segment: &str) -> Option<(Vec<String>, usize)> {
    if effective_verb(segment) != "git" {
        return None;
    }
    let tokens = tokenize_quoted(segment);
    let git_idx = tokens.iter().position(|t| basename(t).to_lowercase() == "git")?;
    let sub = git_subcommand_index(&tokens, git_idx)?;
    Some((tokens, sub))
}

/// Mirrors `command-guard.js` `isSafeGitFetch`.
fn is_safe_git_fetch(segment: &str) -> bool {
    let Some((tokens, sub)) = git_sub(segment) else { return false };
    if tokens[sub].to_lowercase() != "fetch" {
        return false;
    }
    let dangerous = &tables().git_fetch_dangerous;
    tokens[sub + 1..].iter().all(|t| !dangerous.contains(t) && !t.starts_with('+') && !t.contains(':'))
}

/// Mirrors `command-guard.js` `isHeavyGitSegment`.
fn is_heavy_git_segment(segment: &str) -> bool {
    let Some((tokens, sub)) = git_sub(segment) else { return false };
    let s = tokens[sub].to_lowercase();
    if tables().git_heavy_subs.contains(&s) {
        return true;
    }
    s == "fetch" && !is_safe_git_fetch(segment)
}

/// Mirrors `command-guard.js` `isPipedIntoSegment`.
fn is_piped_into_segment(whole: &str, segment: &str) -> bool {
    let Some(idx) = whole.find(segment) else { return false };
    if idx == 0 {
        return false;
    }
    let b = whole.as_bytes();
    let mut i = idx as isize - 1;
    while i >= 0 && is_ws(b[i as usize]) {
        i -= 1;
    }
    i >= 0 && b[i as usize] == b'|' && (i == 0 || b[i as usize - 1] != b'|')
}

/// Mirrors `command-guard.js` `isSafeSqliteReadonly`.
fn is_safe_sqlite_readonly(segment: &str, whole: &str) -> bool {
    if effective_verb(segment) != "sqlite3" {
        return false;
    }
    if neutralize_quoted_contents(segment).contains('<') || is_piped_into_segment(whole, segment) {
        return false;
    }
    let tokens = tokenize_quoted(segment);
    let Some(verb_idx) = tokens.iter().position(|t| basename(t).to_lowercase() == "sqlite3") else { return false };
    let (mut ro, mut db) = (None, None);
    for (i, t) in tokens.iter().enumerate().skip(verb_idx + 1) {
        if t == "-readonly" {
            ro = Some(i);
            continue;
        }
        if t.starts_with('-') {
            continue;
        }
        db = Some(i);
        break;
    }
    let (Some(r), Some(d)) = (ro, db) else { return false };
    if r > d {
        return false;
    }
    !tables().sqlite_dangerous.is_match(&tokens[d + 1..].join(" "))
}

/// A parsed gcloud read: its command path and verb.
struct GcloudRead {
    path: Vec<String>,
    verb: String,
}

/// Mirrors `command-guard.js` `gcloudReadGrammar`.
fn gcloud_read_grammar(rest: &[String], sep_values: bool) -> Option<GcloudRead> {
    let t = tables();
    static PATH_WORD: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static FLAG_EQ: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    let path_word = PATH_WORD.get_or_init(|| lit_re(r"^[a-z][a-z0-9-]*$"));
    let flag_eq = FLAG_EQ.get_or_init(|| lit_re(r"^--[a-z][a-z0-9-]*="));
    let mut i = 0;
    let mut path = Vec::new();
    while i < rest.len() && !rest[i].starts_with('-') {
        if t.gcloud_inspect.contains(&rest[i].to_lowercase()) {
            break;
        }
        path.push(rest[i].clone());
        i += 1;
    }
    if i >= rest.len() || rest[i].starts_with('-') {
        return None;
    }
    let verb = rest[i].to_lowercase();
    i += 1;
    if path.is_empty() {
        return None;
    }
    for (k, w) in path.iter().enumerate() {
        if !path_word.is_match(w) {
            return None;
        }
        if k == 0 && w == "run" {
            continue;
        }
        if t.gcloud_refused.is_match(w) {
            return None;
        }
    }
    if i < rest.len() && !rest[i].starts_with('-') {
        i += 1;
    }
    while i < rest.len() {
        let tok = &rest[i];
        if !tok.starts_with("--") {
            return None;
        }
        if flag_eq.is_match(tok) {
            if tok.starts_with("--flags-file=") {
                return None;
            }
            i += 1;
            continue;
        }
        if t.gcloud_bool.contains(tok) {
            i += 1;
            continue;
        }
        if sep_values && t.gcloud_value.contains(tok) && i + 1 < rest.len() && !rest[i + 1].starts_with('-') {
            i += 2;
            continue;
        }
        return None;
    }
    Some(GcloudRead { path, verb })
}

/// True when a gcloud read may stand: `read` only on the logging group.
fn gcloud_read_ok(g: &GcloudRead) -> bool {
    !(g.verb == "read" && g.path.last().map(String::as_str) != Some(tables().gcloud_logging.as_str()))
}

/// Mirrors `command-guard.js` `stripGcloudStderrMerge`.
fn strip_gcloud_stderr_merge(segment: &str) -> String {
    static RE: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    RE.get_or_init(|| lit_re(r"(^|[^\\])\s+2>&1\s*$")).replacen(segment, 1, "$1").into_owned()
}

/// Mirrors `command-guard.js` `isReadOnlyCloudInspect`.
fn is_read_only_cloud_inspect(segment: &str) -> bool {
    let t = tables();
    let tokens = tokenize_quoted(segment);
    let Some(bin_idx) = tokens.iter().position(|x| t.cloud_binaries.contains(&basename(x).to_lowercase())) else { return false };
    let bin = basename(&tokens[bin_idx]).to_lowercase();
    let rest = &tokens[bin_idx + 1..];
    if bin == "gcloud" {
        let stripped = strip_gcloud_stderr_merge(segment);
        if has_unquoted_redirect_char(&stripped) {
            return false;
        }
        let st = tokenize_quoted(&stripped);
        let Some(s_idx) = st.iter().position(|x| basename(x).to_lowercase() == "gcloud") else { return false };
        return gcloud_read_grammar(&st[s_idx + 1..], false).is_some_and(|g| gcloud_read_ok(&g));
    }
    let first = rest.first().map(|s| s.to_lowercase()).unwrap_or_default();
    if !t.cloud_readonly.contains(&first) {
        return false;
    }
    rest.iter().skip(1).all(|w| w.starts_with('-') || !t.cloud_mutating.contains(&w.to_lowercase()))
}

/// Mirrors `command-guard.js` `closedSinkTokens`.
fn closed_sink_tokens(t: &[String]) -> bool {
    static HEAD1: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static NUM: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static WC: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static GREPF: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static DIGITS: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    let Some(first) = t.first() else { return false };
    let rest = &t[1..];
    if first == "head" || first == "tail" {
        return match rest.len() {
            0 => true,
            1 => HEAD1.get_or_init(|| lit_re(r"^-(?:\d+|[nc]\+?\d+)$")).is_match(&rest[0]),
            2 => (rest[0] == "-n" || rest[0] == "-c") && NUM.get_or_init(|| lit_re(r"^\+?\d+$")).is_match(&rest[1]),
            _ => false,
        };
    }
    if first == "wc" {
        let re = WC.get_or_init(|| lit_re(r"^-[lcwm]$"));
        return rest.iter().all(|a| re.is_match(a));
    }
    if first == "grep" {
        let (mut bounded, mut pattern) = (false, 0);
        let mut i = 0;
        while i < rest.len() {
            let a = &rest[i];
            if a == "-c" {
                bounded = true;
            } else if a == "-m" {
                if !rest.get(i + 1).is_some_and(|v| DIGITS.get_or_init(|| lit_re(r"^\d+$")).is_match(v)) {
                    return false;
                }
                bounded = true;
                i += 1;
            } else if GREPF.get_or_init(|| lit_re(r"^-[EFGivwxnHhoa]+$")).is_match(a) {
            } else if a.starts_with('-') {
                return false;
            } else {
                pattern += 1;
            }
            i += 1;
        }
        return bounded && pattern == 1;
    }
    false
}

/// Mirrors `command-guard.js` `isClosedSinkStage`.
fn is_closed_sink_stage(segment: &str) -> bool {
    if has_unquoted_redirect_char(segment) || has_shell_expansion_anywhere(segment) {
        return false;
    }
    closed_sink_tokens(&tokenize_quoted(segment))
}

/// The length of the whole-command CLI name `cmd` starts with, when whitespace follows it (ASCII case-insensitive).
fn starts_with_cli(cmd: &str) -> Option<usize> {
    let lower = cmd.to_ascii_lowercase();
    tables().whole_clis.iter().find(|c| lower.starts_with(c.as_str()) && lower.as_bytes().get(c.len()).is_some_and(|&x| is_ws(x))).map(String::len)
}

/// Mirrors `command-guard.js` `isWholeCommandReadOnlyForm` (with `VERSION_CLI_RE`).
fn is_whole_command_read_only_form(command: &str) -> bool {
    let cmd = trim(command);
    if starts_with_cli(cmd).is_none() {
        return false;
    }
    if cmd.contains(['\n', '\r']) || has_shell_expansion_anywhere(cmd) {
        return false;
    }
    let split = split_detailed(cmd);
    let segs = &split.segments;
    if segs.is_empty() || split.delims.last() != Some(&"end") {
        return false;
    }
    if split.delims[..split.delims.len() - 1].iter().any(|d| *d != "|") {
        return false;
    }
    let first = trim(&segs[0]);
    static STRIP_TAIL: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static VERSION_TAIL: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    let vq = STRIP_TAIL.get_or_init(|| lit_re(r"\s+2>(?:&1|/dev/null)$")).replacen(first, 1, "").into_owned();
    let ok = if starts_with_cli(&vq).is_some_and(|c| VERSION_TAIL.get_or_init(|| lit_re(r"(?i)^\s+(?:--version|-V)$")).is_match(&vq[c..])) {
        !has_unquoted_redirect_char(&vq)
    } else {
        let stripped = strip_gcloud_stderr_merge(first);
        if has_unquoted_redirect_char(&stripped) {
            false
        } else {
            let st = tokenize_quoted(&stripped);
            st.first().map(String::as_str) == Some("gcloud") && gcloud_read_grammar(&st[1..], true).is_some_and(|g| gcloud_read_ok(&g))
        }
    };
    ok && segs[1..].iter().all(|s| is_closed_sink_stage(trim(s)))
}

/// Mirrors `command-guard.js` `isSafeNodeEvalPayload`.
fn is_safe_node_eval_payload(payload: &str) -> bool {
    let t = tables();
    if payload.is_empty() || t.node_eval_deny.iter().any(|r| r.is_match(payload)) {
        return false;
    }
    t.node_fs_call.captures_iter(payload).all(|c| c.get(1).is_some_and(|m| t.node_fs_read.contains(m.as_str())))
}

/// The word after the first `-e` / `--eval` of a node segment: `Some(payload)` when there is such a flag.
fn node_eval_payload(segment: &str) -> Option<String> {
    if effective_verb(segment) != "node" {
        return None;
    }
    let tokens = tokenize_quoted(segment);
    let i = tokens.iter().position(|t| tables().node_eval_flags.contains(t))?;
    Some(tokens.get(i + 1).cloned().unwrap_or_default())
}

/// Mirrors `command-guard.js` `isReadOnlyGhGraphql`.
fn is_read_only_gh_graphql(tokens: &[String], gh_idx: usize) -> bool {
    let t = tables();
    static GQL: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static MUT: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    static QSTART: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    let gql = GQL.get_or_init(|| lit_re(r"(?i)^/?graphql$"));
    if !tokens.get(gh_idx + 2).is_some_and(|x| gql.is_match(x)) {
        return false;
    }
    let mut queries = 0;
    let mut i = gh_idx + 3;
    while i < tokens.len() {
        let tok = &tokens[i];
        if t.gh_gql_bool.contains(tok) {
            i += 1;
            continue;
        }
        if t.gh_gql_value.contains(tok) {
            if i + 1 >= tokens.len() {
                return false;
            }
            i += 2;
            continue;
        }
        if t.gh_field_flags.contains(tok) {
            if i + 1 >= tokens.len() {
                return false;
            }
            i += 1;
            let v = &tokens[i];
            let Some(eq) = v.find('=') else { return false };
            if &v[..eq] != "query" {
                i += 1;
                continue;
            }
            let q = &v[eq + 1..];
            if q.contains(['$', '`']) || q.starts_with('@') || MUT.get_or_init(|| lit_re(r"(?i)\bmutation\b")).is_match(q) {
                return false;
            }
            let qt = trim(q);
            if !qt.is_empty() && !qt.starts_with('{') && !QSTART.get_or_init(|| lit_re(r"^query[\s{(]")).is_match(qt) {
                return false;
            }
            queries += 1;
            i += 1;
            continue;
        }
        return false;
    }
    queries == 1
}

/// Mirrors `command-guard.js` `isHeavyGhSegment`.
pub fn is_heavy_gh_segment(segment: &str, command: &str) -> bool {
    let t = tables();
    if effective_verb(segment) != "gh" {
        return false;
    }
    let tokens = tokenize_quoted(segment);
    let Some(gh_idx) = tokens.iter().position(|x| basename(x).to_lowercase() == "gh") else { return false };
    let group = tokens.get(gh_idx + 1).map(|s| s.to_lowercase()).unwrap_or_default();
    let sub = tokens.get(gh_idx + 2).map(|s| s.to_lowercase()).unwrap_or_default();
    if t.gh_mutating.get(&group).is_some_and(|s| s.contains(&sub)) {
        return true;
    }
    if group == "api" {
        static GQL: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
        static FSHORT: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
        static FLONG: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
        if is_read_only_gh_graphql(&tokens, gh_idx) && !command.contains('`') {
            return false;
        }
        let gql = GQL.get_or_init(|| lit_re(r"(?i)^/?graphql$"));
        if tokens.iter().skip(gh_idx + 2).any(|x| gql.is_match(x)) {
            return true;
        }
        let fshort = FSHORT.get_or_init(|| lit_re(r"^-[fF]."));
        let flong = FLONG.get_or_init(|| lit_re(r"^--(field|raw-field|input)="));
        for i in gh_idx + 2..tokens.len() {
            let x = &tokens[i];
            if t.gh_field_flags.contains(x) || fshort.is_match(x) || flong.is_match(x) || x == "--input" {
                return true;
            }
            if (x == "-X" || x == "--method") && tokens.get(i + 1).is_some_and(|m| t.gh_api_methods.contains(&m.to_uppercase())) {
                return true;
            }
        }
    }
    false
}

/// Mirrors `command-guard.js` `isFlaggedInterpreterScript`.
fn is_flagged_interpreter_script(segment: &str) -> bool {
    let t = tables();
    let tokens = words(segment);
    if tokens.len() < 3 || !t.script_interp.is_match(tokens[0]) || !tokens[1].starts_with('-') {
        return false;
    }
    let ext = if tokens[0] == "node" { &t.node_ext } else { &t.py_ext };
    tokens[1..].iter().any(|x| ext.is_match(x))
}

/// Mirrors `command-guard.js` `isHeavySegment`.
fn is_heavy_segment(segment: &str, command: &str) -> bool {
    let t = tables();
    let segment = t.control_prefix.replacen(segment, 1, "").into_owned();
    let unwrapped = t.timeout_prefix.replacen(&segment, 1, "").into_owned();
    if t.light.iter().any(|re| re.is_match(&segment) || re.is_match(&unwrapped)) {
        return false;
    }
    if t.light_neg.iter().any(|nl| neg_light_match(nl, &segment) || neg_light_match(nl, &unwrapped)) {
        return false;
    }
    if is_safe_git_fetch(&segment) || is_safe_sqlite_readonly(&segment, command) || is_read_only_cloud_inspect(&segment) {
        return false;
    }
    if let Some(p) = node_eval_payload(&segment) {
        // isSafeNodeEval: a safe payload is light; any other `node -e` is heavy (isNodeDashEInvocation)
        return !is_safe_node_eval_payload(&p);
    }
    if is_heavy_git_segment(&segment) || is_heavy_gh_segment(&segment, command) || is_flagged_interpreter_script(&segment) {
        return true;
    }
    let verb = effective_verb(&segment);
    if !verb.is_empty() && t.heavy_verbs.contains(&verb) {
        return true;
    }
    let for_patterns = blank_pattern_argument(&neutralize_quoted_contents(&segment), &verb);
    t.heavy_patterns.iter().any(|re| re.is_match(&for_patterns))
}

/// One plain read-only git segment: a fetch that [`is_safe_git_fetch`] accepts, or a log/status/show/rev-parse in the exact
/// shapes of `classifyPlainGitChainSegment` (no redirect, no expansion, no extra flags).
///
/// Mirrors `command-guard.js` `isPlainReadGitSegment`.
fn is_plain_read_git_segment(segment: &str) -> bool {
    if is_safe_git_fetch(segment) {
        return !has_unquoted_redirect_char(segment) && !has_shell_expansion_anywhere(segment);
    }
    let t = tables();
    let trimmed = t.trailing_stderr_merge.replacen(trim(segment), 1, "");
    if has_unquoted_redirect_char(&trimmed) || has_substitution_outside_single_quotes(&trimmed) {
        return false;
    }
    t.plain_read_git.iter().any(|re| re.is_match(&trimmed))
}

/// Segment indexes that belong to a chain unit which is, on its own, exactly one whole read-only form.
///
/// A chain is cut into units at `;` / `&&` only; the exemption applies only when EVERY unit is read-only on its face.
/// Mirrors `command-guard.js` `readOnlyFormUnits`.
fn read_only_form_units(split: &Split) -> HashSet<usize> {
    let mut out = HashSet::new();
    let (segments, delims) = (&split.segments, &split.delims);
    if segments.len() < 2 || !delims.iter().any(|x| *x == "&&" || *x == ";") {
        return HashSet::new();
    }
    let mut start = 0;
    for i in 0..segments.len() {
        let last = i == segments.len() - 1;
        let cut = last || delims[i] == "&&" || delims[i] == ";";
        if !cut {
            if delims[i] != "|" {
                return HashSet::new();
            }
            continue;
        }
        let text = segments[start..=i].iter().map(|s| trim(s)).collect::<Vec<_>>().join(" | ");
        if is_whole_command_read_only_form(&text) {
            out.extend(start..=i);
        } else if !(start == i && is_plain_read_git_segment(trim(&segments[i]))) {
            return HashSet::new();
        }
        start = i + 1;
    }
    out
}

/// Whether the command is heavy in the main thread (the engine defers on `true`).
///
/// Mirrors `command-guard.js` `isHeavyCommand`, except that the stable-launcher light exception is never granted
/// (see the module doc), which can only turn a Node "not heavy" into a deferral.
pub fn is_heavy_command(command: &str, d: usize) -> bool {
    if trim(command).is_empty() {
        return false;
    }
    if d == 0 && is_whole_command_read_only_form(command) {
        return false;
    }
    let max = tables().max_depth;
    let split = split_detailed(command);
    let exempt = if d == 0 { read_only_form_units(&split) } else { HashSet::new() };
    for (si, seg) in split.segments.iter().enumerate() {
        if exempt.contains(&si) {
            continue;
        }
        if is_heavy_segment(seg, command) {
            return true;
        }
        if d < max {
            let p = extract_shell_c_payload(seg);
            if !p.is_empty() && is_heavy_command(&p, d + 1) {
                return true;
            }
            let e = extract_eval_payload(seg);
            if !e.is_empty() && is_heavy_command(&e, d + 1) {
                return true;
            }
        }
    }
    d < max && extract_substitutions(command).iter().any(|inner| is_heavy_command(inner, d + 1))
}
