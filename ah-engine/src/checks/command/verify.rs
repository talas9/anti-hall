//! The "narrow allow" carve-out of command-guard: a bounded, single-target read-only verification command is let through
//! although it classified heavy (`isBoundedVerificationCommand` and the predicates it is built from).
//!
//! Every function mirrors the Node function of the same name in `hooks/command-guard.js`. Wherever Node reads the file
//! system (`statSync`, `realpathSync`, a manifest walk) so does this port; wherever the answer needs the hook process's own
//! working directory the result is [`Unsure`] and the check defers.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use super::cx::{Cx, Pcx, R, Unsure};
use super::heavy::{closed_sink_tokens, is_closed_sink_stage, is_heavy_command};
use super::shell::{
    blank_pattern_argument, effective_verb, has_shell_expansion_anywhere, has_unquoted_redirect_char, neutralize_quoted_contents, split_detailed,
    tokenize_quoted, trim, words,
};
use super::tables::tables;
use crate::checks::git::tokenize::basename;
use crate::checks::guardkit::paths as gp;
use crate::defaults;

macro_rules! re {
    ($p:expr) => {{
        static C: crate::defaults::Cache<regex::Regex> = crate::defaults::Cache::new();
        C.get_or_init(|| crate::checks::lit_re($p))
    }};
}
pub(super) use re;

/// `VERIFY_CHECK_FLAG_RE` (with its lookahead `(?=\s|$)` done by hand): the end of the first flag match at or after `from`,
/// as `(match_start, match_end_without_lookahead)`.
fn check_flag_at(text: &str, from: usize) -> Option<(usize, usize)> {
    let r = re!(r"(^|\s)--(?:check|dry-run|list)(?:=\S+)?(\s|$)");
    let mut at = from;
    loop {
        let c = r.captures_at(text, at)?;
        let whole = c.get(0)?;
        let tail = c.get(2)?;
        // `^` of group 1 only holds at the start of the text, never at an offset: a match that begins with an empty group 1
        // at a later offset is not JavaScript's match.
        if whole.start() > 0 && c.get(1).is_some_and(|g| g.as_str().is_empty()) {
            at = whole.start() + 1;
            continue;
        }
        return Some((whole.start(), whole.end() - tail.as_str().len()));
    }
}

/// `VERIFY_CHECK_FLAG_RE.test(text)`.
pub fn has_check_flag(text: &str) -> bool {
    check_flag_at(text, 0).is_some()
}

/// `text.replace(VERIFY_CHECK_FLAG_RE_G, ' ')`.
pub fn replace_check_flags(text: &str) -> String {
    let mut out = String::new();
    let mut last = 0;
    let mut at = 0;
    while let Some((s, e)) = check_flag_at(text, at) {
        out.push_str(&text[last..s]);
        out.push(' ');
        last = e;
        at = e;
        if at >= text.len() {
            break;
        }
    }
    out.push_str(&text[last..]);
    out
}

fn refused_verbs() -> &'static std::collections::HashSet<String> {
    static C: crate::defaults::Cache<std::collections::HashSet<String>> = crate::defaults::Cache::new();
    C.get_or_init(|| defaults::list("command.check_flag_refused_verbs").into_iter().map(str::to_string).collect())
}

/// `leadsWithRefusedCheckVerb`.
fn leads_with_refused_check_verb(segment: &str) -> bool {
    let t = tables();
    let tokens = words(segment);
    let mut idx = 0;
    while idx < tokens.len() && re!(r"^[A-Za-z_][A-Za-z0-9_]*=").is_match(tokens[idx]) {
        idx += 1;
    }
    while idx < tokens.len() {
        let word = basename(tokens[idx]).to_lowercase();
        let word = word.trim_matches(['\'', '"']).to_string();
        if refused_verbs().contains(&word) || re!(r"^python[0-9.]*$").is_match(&word) {
            return true;
        }
        if !t.wrappers.contains(&word) && !word.starts_with('-') && !re!(r"^\d+[smhd]?$").is_match(&word) {
            break;
        }
        idx += 1;
    }
    let verb = effective_verb(segment);
    !verb.is_empty() && (refused_verbs().contains(&verb) || re!(r"^python[0-9.]*$").is_match(&verb))
}

/// `CHECK_FLAG_INLINE_CODE_FLAG_RE.test(text)` (`(^|\s)(?:-[A-Za-z]*[ce]|--eval|--command)(?=[\s=]|$)`).
fn has_inline_code_flag(text: &str) -> bool {
    re!(r"(^|\s)(?:-[A-Za-z]*[ce]|--eval|--command)(?:[\s=]|$)").is_match(text)
}

/// `isGenericCheckFlagCommand`.
fn is_generic_check_flag_command(segment: &str) -> bool {
    let t = tables();
    let verb = effective_verb(segment);
    if !verb.is_empty() && t.heavy_verbs.contains(&verb) {
        return false;
    }
    if leads_with_refused_check_verb(segment) {
        return false;
    }
    let neutral = neutralize_quoted_contents(segment);
    if has_inline_code_flag(&neutral) {
        return false;
    }
    if is_heavy_command(&replace_check_flags(segment), 0) {
        return false;
    }
    let for_patterns = blank_pattern_argument(&neutral, &verb);
    if t.heavy_patterns.iter().any(|r| r.is_match(&for_patterns)) {
        return false;
    }
    has_check_flag(&format!(" {neutral} "))
}

/// `isInsideAntiHallPlugin(realPath)`: the path is inside this plugin, or some ancestor holds the anti-hall manifest.
pub fn is_inside_anti_hall_plugin(cx: &Cx<'_>, real: &str) -> R<bool> {
    if cx.plugin_root.is_empty() {
        return Err(Unsure);
    }
    let own = std::fs::canonicalize(cx.plugin_root).map_or_else(|_| gp::resolve_abs(cx.plugin_root), |p| p.to_string_lossy().into_owned());
    let rel = gp::relative(&own, real);
    if !rel.is_empty() && !rel.starts_with("..") && !gp::is_absolute(&rel) {
        return Ok(true);
    }
    let mut dir = crate::checks::git::util::posix_dirname(real);
    for _ in 0..16 {
        let manifest = gp::join(&dir, defaults::text("command.plugin_manifest_rel"));
        if std::path::Path::new(&manifest).exists() {
            match std::fs::read(&manifest).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok()) {
                Some(v) => {
                    // `String(JSON.parse(...).name)`: any non-string name stringifies to something else than the plugin name
                    if v.get("name").and_then(serde_json::Value::as_str) == Some(defaults::text("command.plugin_name")) {
                        return Ok(true);
                    }
                }
                None => return Ok(true),
            }
        }
        let parent = crate::checks::git::util::posix_dirname(&dir);
        if parent == dir {
            break;
        }
        dir = parent;
    }
    Ok(false)
}

/// `isInterpreterScriptCheck(segment, ctx)`.
fn is_interpreter_script_check(cx: &Cx<'_>, segment: &str, pc: &Pcx) -> R<bool> {
    if cx.setting("command.setting_allow_read_only_verify_scripts")? == Some(serde_json::Value::Bool(false)) {
        return Ok(false);
    }
    let trimmed = trim(segment);
    let tokens = words(trimmed);
    if tokens.len() < 3 || pc.unknown {
        return Ok(false);
    }
    if !re!(r"^(?:python[0-9.]*|node|ruby|perl|php)$").is_match(&basename(tokens[0]).to_lowercase()) {
        return Ok(false);
    }
    let bad = re!(r#"[$`'"~*?\[\]{}\\<>();&|]"#);
    if tokens[0] != basename(tokens[0]) {
        if bad.is_match(tokens[0]) {
            return Ok(false);
        }
        if !std::fs::metadata(gp::resolve(&pc.base()?, tokens[0])).is_ok_and(|m| m.is_file()) {
            return Ok(false);
        }
    }
    let script = tokens[1];
    if script == "-" || script.starts_with('-') || bad.is_match(script) {
        return Ok(false);
    }
    if re!(r"[$`\\]|<\(|>\(").is_match(segment) {
        return Ok(false);
    }
    let neutral = neutralize_quoted_contents(segment);
    if neutral.contains('<')
        || re!(r"(^|\s)(?:-[A-Za-z]*[cemprI]|--eval|--command|--print|--require|--import|--loader|--experimental-loader|--interactive)(?:[\s=]|$)")
            .is_match(&neutral)
    {
        return Ok(false);
    }
    if !has_check_flag(&format!(" {neutral} ")) {
        return Ok(false);
    }
    let joined = if gp::is_absolute(script) { script.to_string() } else { format!("{}/{}", pc.base()?.trim_end_matches('/'), script) };
    let Ok(real) = std::fs::canonicalize(&joined) else { return Ok(false) };
    let real = real.to_string_lossy().into_owned();
    if !std::fs::metadata(&real).is_ok_and(|m| m.is_file()) {
        return Ok(false);
    }
    if tokens.iter().any(|t| *t == "--confirmed" || t.starts_with("--confirmed=")) {
        return Ok(false);
    }
    if is_inside_anti_hall_plugin(cx, &real)? {
        return Ok(false);
    }
    // `trimmed.slice(trimmed.indexOf(script, tokens[0].length) + script.length)`
    let from = tokens[0].len().min(trimmed.len());
    let Some(rel_idx) = trimmed[from..].find(script) else { return Ok(false) };
    let rest = &trimmed[from + rel_idx + script.len()..];
    Ok(!is_heavy_command(&replace_check_flags(&format!("true {rest}")), 0))
}

/// `isSyntaxOnlyCompileCheck`.
fn is_syntax_only_compile_check(segment: &str) -> bool {
    let verb = effective_verb(segment);
    !verb.is_empty() && defaults::list("command.verify_syntax_only_compilers").contains(&verb.as_str()) && re!(r"(^|\s)-fsyntax-only(?:\s|$)").is_match(segment)
}

/// `isSinglePytestFileCheck`.
fn is_single_pytest_file_check(segment: &str) -> bool {
    let Some(c) = re!(r"^python3\s+-m\s+pytest\s+-q\s+(\S+)$").captures(trim(segment)) else { return false };
    let target = &c[1];
    !target.contains(['*', '?', '[', ']']) && !target.ends_with('/')
}

/// `isBoundedNodeTestCheck`.
fn is_bounded_node_test_check(segment: &str) -> bool {
    let tokens = words(segment);
    if tokens.len() < 3 || tokens.len() > 4 || basename(tokens[0]).to_lowercase() != "node" || tokens[1] != "--test" {
        return false;
    }
    tokens[2..].iter().all(|f| !f.starts_with('-') && !f.contains(['*', '?', '[', ']']) && !f.ends_with('/') && re!(r"(?i)\.(?:m?js|cjs|ts)$").is_match(f))
}

/// `isBoundedJsTestRunnerCheck`.
fn is_bounded_js_test_runner_check(segment: &str, pc: &Pcx) -> R<bool> {
    let tokens = words(segment);
    let mut i = 0;
    if tokens.first() == Some(&"npx") {
        i += 1;
    }
    match tokens.get(i).copied() {
        Some("vitest") => {
            i += 1;
            if tokens.get(i).copied() != Some("run") {
                return Ok(false);
            }
            i += 1;
        }
        Some("jest") => i += 1,
        _ => return Ok(false),
    }
    let files = &tokens[i.min(tokens.len())..];
    if files.is_empty() || files.len() > 2 || pc.unknown {
        return Ok(false);
    }
    for f in files {
        if f.starts_with('-') || f.contains(['*', '?', '[', ']', '$', '`', '\\']) {
            return Ok(false);
        }
        if !re!(r"(?i)^.+\.(?:test|spec)\.[mc]?[jt]sx?$").is_match(&basename(f)) {
            return Ok(false);
        }
        if !std::fs::metadata(gp::resolve(&pc.base()?, f)).is_ok_and(|m| m.is_file()) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// `isSafeScratchpadGitClone`.
fn is_safe_scratchpad_git_clone(cx: &Cx<'_>, segment: &str, pc: &Pcx) -> R<bool> {
    let Some(c) = re!(r"^git\s+clone\s+--depth\s+1\s+(https://\S+)\s+(\S+)$").captures(trim(segment)) else { return Ok(false) };
    cx.is_scratch_or_tmp(&c[2], pc)
}

/// `isQualifyingSingleTargetCheck`.
fn is_qualifying_single_target_check(cx: &Cx<'_>, segment: &str, pc: &Pcx) -> R<bool> {
    Ok(is_syntax_only_compile_check(segment)
        || is_single_pytest_file_check(segment)
        || is_bounded_node_test_check(segment)
        || is_bounded_js_test_runner_check(segment, pc)?
        || re!(r"^ctest\s+-R\s+\S+$").is_match(trim(segment))
        || is_safe_scratchpad_git_clone(cx, segment, pc)?
        || is_generic_check_flag_command(segment)
        || is_interpreter_script_check(cx, segment, pc)?)
}

/// `isLooseSinkShape`.
fn is_loose_sink_shape(segment: &str) -> bool {
    let verb = effective_verb(segment);
    match verb.as_str() {
        "" => false,
        "tail" | "head" | "wc" => true,
        "grep" => re!(r"(^|\s)-c(?:\s|$)").is_match(segment) || re!(r"(^|\s)-m\s*\d+(?:\s|$)").is_match(segment),
        _ => false,
    }
}

/// `segment.replace(/(^|\s)2>&1(?=\s|$)/g, ' ')`.
fn strip_stderr_merges(segment: &str) -> String {
    let r = re!(r"(^|\s)2>&1(\s|$)");
    let mut out = String::new();
    let mut last = 0;
    let mut at = 0;
    while at <= segment.len() {
        let Some(c) = r.captures_at(segment, at) else { break };
        let (Some(whole), Some(lead), Some(tail)) = (c.get(0), c.get(1), c.get(2)) else { break };
        if whole.start() > 0 && lead.as_str().is_empty() {
            at = whole.start() + 1;
            continue;
        }
        out.push_str(&segment[last..whole.start()]);
        out.push(' ');
        last = whole.end() - tail.as_str().len();
        at = last;
        if at >= segment.len() {
            break;
        }
    }
    out.push_str(&segment[last..]);
    out
}

/// `isBoundedSinkSegment`.
pub fn is_bounded_sink_segment(segment: &str) -> bool {
    if !is_loose_sink_shape(segment) {
        return false;
    }
    let s = strip_stderr_merges(segment);
    let s = trim(&s);
    let s = s
        .strip_prefix("command")
        .filter(|r| r.starts_with(|c: char| c.is_ascii() && super::shell::is_ws(c as u8)))
        .map_or(s, |r| r.trim_start_matches(|c: char| c.is_ascii() && super::shell::is_ws(c as u8)));
    is_closed_sink_stage(s)
}

/// `isScratchFileSinkSegment`.
pub fn is_scratch_file_sink_segment(cx: &Cx<'_>, segment: &str, pc: &Pcx) -> R<bool> {
    if !is_loose_sink_shape(segment) || has_unquoted_redirect_char(segment) || has_shell_expansion_anywhere(segment) {
        return Ok(false);
    }
    let seg = trim(segment);
    let seg = seg
        .strip_prefix("command")
        .filter(|r| r.starts_with(|c: char| c.is_ascii() && super::shell::is_ws(c as u8)))
        .map_or(seg, |r| r.trim_start_matches(|c: char| c.is_ascii() && super::shell::is_ws(c as u8)));
    let t = tokenize_quoted(seg);
    let mut end = t.len();
    let max_strip = if t.first().map(String::as_str) == Some("grep") { 1 } else { t.len() };
    let mut n = 0;
    while n < max_strip && end > 1 && !t[end - 1].starts_with('-') && cx.is_scratch_or_tmp(&t[end - 1], pc)? {
        end -= 1;
        n += 1;
    }
    Ok(closed_sink_tokens(&t[..end]))
}

/// `isReadOnlyFilterSegment`.
fn is_read_only_filter_segment(segment: &str) -> bool {
    let verb = effective_verb(segment);
    if verb.is_empty() {
        return false;
    }
    let raw = trim(segment);
    if strip_stderr_merges(&neutralize_quoted_contents(raw)).contains('>') {
        return false;
    }
    let tokens = tokenize_quoted(raw);
    let args = &tokens[1.min(tokens.len())..];
    match verb.as_str() {
        "grep" | "cut" | "tr" => true,
        "sort" => !args.iter().any(|t| re!(r"^(?:-[a-zA-Z]*o|--output|--compress-program)").is_match(t)),
        "uniq" => args.iter().all(|t| t.starts_with('-')),
        "sed" => {
            if !args.iter().any(|t| t == "-n") {
                return false;
            }
            let rest: Vec<&String> = args.iter().filter(|t| *t != "-n").collect();
            rest.len() == 1 && re!(r"^(?:(?:\d+|\$)(?:,(?:\d+|\$))?|/[^/\\]+/)p$").is_match(rest[0])
        }
        "awk" => {
            if args.iter().any(|t| re!(r"^-f|^--file|^-i|^--include|^-e|^--source").is_match(t)) {
                return false;
            }
            !re!(r"system|getline|close|ENVIRON|fflush|[|>]").is_match(raw)
        }
        _ => false,
    }
}

/// `isPlainLightSegment`.
fn is_plain_light_segment(segment: &str) -> bool {
    let seg = trim(segment);
    if re!(r"\$\(|`|<\(|>\(|\$\{").is_match(seg) {
        return false;
    }
    if re!(r"[()]").is_match(&neutralize_quoted_contents(seg)) {
        return false;
    }
    if re!(r"^(?:!\s*)?(?:for|while|until|if|then|do|else|elif|case|select|function|time|\{)\b").is_match(seg) || seg.starts_with('{') {
        return false;
    }
    if re!(r"^(?:done|fi|esac|\})$").is_match(seg) {
        return false;
    }
    !is_heavy_command(seg, 0)
}

/// `isTriviallySafeSegment`.
fn is_trivially_safe_segment(segment: &str) -> bool {
    let verb = effective_verb(segment);
    !verb.is_empty() && defaults::list("command.verify_trivial_verbs").contains(&verb.as_str())
}

/// `hasDisallowedWriteRedirect(segment, ctx)`.
pub fn has_disallowed_write_redirect(cx: &Cx<'_>, segment: &str, pc: &Pcx) -> R<bool> {
    let r = re!(r"(^|[^<>&])(&?>>?)\s*(\S+)");
    let mut at = 0;
    while let Some(c) = r.captures_at(segment, at) {
        let (Some(whole), Some(lead), Some(target)) = (c.get(0), c.get(1), c.get(3)) else { break };
        if whole.start() > 0 && lead.as_str().is_empty() {
            at = whole.start() + 1;
            continue;
        }
        at = whole.end();
        if re!(r"^&\d*$").is_match(target.as_str()) {
            continue;
        }
        if !cx.is_scratch_or_tmp(target.as_str(), pc)? {
            return Ok(true);
        }
    }
    if effective_verb(segment) == "tee" {
        for t in words(segment).iter().skip(1) {
            if t.starts_with('-') {
                continue;
            }
            return Ok(!cx.is_scratch_or_tmp(t, pc)?);
        }
    }
    Ok(false)
}

/// `isBoundedVerificationCommand(command, ctx)`: the payload's directory is `pc.cwd`.
pub fn is_bounded_verification_command(cx: &Cx<'_>, command: &str, pc0: &Pcx) -> R<bool> {
    if trim(command).is_empty() || neutralize_quoted_contents(command).contains('#') {
        return Ok(false);
    }
    let split = split_detailed(command);
    if split.segments.is_empty() {
        return Ok(false);
    }
    let mut pc = pc0.clone();
    let mut saw_qualifying = false;
    let mut pipeline_has_check = false;
    let ends = defaults::list("command.pipeline_ends");
    for idx in 0..split.segments.len() {
        let seg = trim(&split.segments[idx]);
        if seg.is_empty() {
            continue;
        }
        if effective_verb(seg) == "cd" {
            let cd_tok = tokenize_quoted(seg);
            let mut cd_cwd: Option<String> = None;
            if cd_tok.len() == 2
                && cd_tok[0] == "cd"
                && !re!(r"^-|[$`~*?\[\]{}\\]").is_match(&cd_tok[1])
                && split.delims[idx] == "&&"
                && split.delims[..idx].iter().all(|x| *x == "&&")
                && let Ok(p) = std::fs::canonicalize(gp::resolve(&pc.base()?, &cd_tok[1]))
            {
                cd_cwd = Some(p.to_string_lossy().into_owned());
            }
            match cd_cwd {
                Some(c) => pc.cwd = Some(c),
                None => pc.unknown = true,
            }
        }
        if has_disallowed_write_redirect(cx, seg, &pc)? {
            return Ok(false);
        }
        let check_seg_owned = strip_stderr_merges(seg);
        let check_seg = trim(&check_seg_owned);
        let kind_sink;
        if !neutralize_quoted_contents(check_seg).contains(">&") && is_qualifying_single_target_check(cx, check_seg, &pc)? {
            kind_sink = false;
            saw_qualifying = true;
            pipeline_has_check = true;
        } else if is_loose_sink_shape(seg) {
            if !is_bounded_sink_segment(seg) {
                return Ok(false);
            }
            if idx == 0 || split.delims[idx - 1] != "|" {
                return Ok(false);
            }
            kind_sink = true;
        } else if is_trivially_safe_segment(seg)
            || (idx > 0 && split.delims[idx - 1] == "|" && is_read_only_filter_segment(seg))
            || (!(idx > 0 && split.delims[idx - 1] == "|") && is_plain_light_segment(seg))
        {
            kind_sink = false;
        } else {
            return Ok(false);
        }
        let d = split.delims[idx];
        if d == "|" {
            continue;
        }
        if !ends.contains(&d) {
            return Ok(false);
        }
        if pipeline_has_check && !kind_sink {
            return Ok(false);
        }
        pipeline_has_check = false;
    }
    Ok(saw_qualifying)
}
