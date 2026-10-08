//! The other carve-outs of command-guard's heavy-command gate: the per-project command allowlist, the plain-push chain,
//! background scratch scripts and the narrow read-only Google Cloud access.
//!
//! Each function mirrors the Node function of the same name in `hooks/command-guard.js` (and `hooks/lib/command-allow.js` for
//! the allowlist). Where Node asks git, the engine asks git the same way (`git -C <dir> ...`, five seconds); where the answer
//! needs the hook process's own working directory the result is [`Unsure`] and the check defers.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use super::cx::{Cx, Pcx, R, Unsure};
use super::heavy::{gcloud_read_grammar, gcloud_read_ok, strip_gcloud_stderr_merge};
use super::shell::{
    has_shell_expansion_anywhere, has_substitution_outside_single_quotes, has_unquoted_redirect_char, neutralize_quoted_contents, split_detailed,
    tokenize_quoted, trim,
};
use super::verify::{has_disallowed_write_redirect, is_bounded_sink_segment, is_inside_anti_hall_plugin, is_scratch_file_sink_segment, re};
use crate::checks::guardkit::paths as gp;
use crate::checks::jsport::{gitrun, ident};
use crate::defaults;
use serde_json::Value;
use std::collections::HashSet;

fn set(key: &str) -> HashSet<&'static str> {
    defaults::list(key).into_iter().collect()
}

// ---- the per-project command allowlist --------------------------------------------------------------------------------

/// `validatePattern(p).ok` of `lib/command-allow.js`.
fn pattern_ok(p: &str) -> bool {
    if !p.starts_with('^') || !p.ends_with('$') || p.ends_with("\\$") {
        return false;
    }
    if !re!(r"^\^(?:[A-Za-z0-9_/-]|\\\.)+(?: |\$$)").is_match(p) {
        return false;
    }
    let scan = scan_pattern(p);
    !scan.0 && !scan.1 && crate::checks::guardkit::jsre::try_compile(p, false).is_some()
}

/// `validateEditPath(p).ok` of `lib/command-allow.js`.
fn edit_path_ok(p: &str) -> bool {
    let t = trim(p);
    if t.is_empty() || t != p || t.starts_with('/') || re!(r"^[A-Za-z]:").is_match(t) || t.starts_with('~') || t.contains('\\') {
        return false;
    }
    if t.split('/').any(|s| s == "..") {
        return false;
    }
    !re!(r"^[*/]+$").is_match(t)
}

/// `scanPattern(src)`: (top-level alternation, unbounded wildcard).
fn scan_pattern(src: &str) -> (bool, bool) {
    let cs: Vec<char> = src.chars().collect();
    let at = |i: usize| cs.get(i).copied();
    let unbounded_quant = |i: usize| -> bool {
        match at(i) {
            Some('*' | '+') => true,
            Some('{') => {
                let rest: String = cs[i..].iter().collect();
                re!(r"^\{\d*,\}").is_match(&rest)
            }
            _ => false,
        }
    };
    let (mut depth, mut top_alt, mut wild) = (0usize, false, false);
    let mut group_starts: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if c == '\\' {
            i += 2;
            continue;
        }
        if c == '[' {
            let mut j = i + 1;
            if at(j) == Some('^') {
                j += 1;
            }
            if at(j) == Some(']') {
                j += 1;
            }
            while j < cs.len() && cs[j] != ']' {
                if cs[j] == '\\' {
                    j += 1;
                }
                j += 1;
            }
            let body: String = cs[(i + 1).min(cs.len())..j.min(cs.len())].iter().collect();
            let spans_space = if body.starts_with('^') {
                !(body.contains(' ') || body.contains("\\s"))
            } else {
                body.contains("\\s") || body.contains("\\W") || body.contains("\\D") || body.contains(' ')
            };
            if spans_space && unbounded_quant(j + 1) {
                wild = true;
            }
            i = j + 1;
            continue;
        }
        if c == '(' {
            depth += 1;
            group_starts.push(i);
            i += 1;
            continue;
        }
        if c == ')' {
            depth = depth.saturating_sub(1);
            let start = group_starts.pop().unwrap_or(0);
            let body: String = cs[(start + 1).min(cs.len())..i.min(cs.len())].iter().collect();
            if unbounded_quant(i + 1) && re!(r"(^|[^\\])\.|\\[sWD]|\[\^| ").is_match(&body) {
                wild = true;
            }
            i += 1;
            continue;
        }
        if c == '|' && depth == 0 {
            top_alt = true;
        }
        if c == '.' && unbounded_quant(i + 1) {
            wild = true;
        }
        i += 1;
    }
    (top_alt, wild)
}

/// The trusted command patterns of the repository at `cwd` (`loadTrustedPatterns`).
/// The defaults keys of one allowlist kind: its file, its list key and its trust record.
pub(super) type AllowKeys = (&'static str, &'static str, &'static str);

/// The command allowlist keys.
pub(super) const COMMAND_KEYS: AllowKeys = ("command.allow_file_rel", "command.allow_list_key", "command.allow_trust_file_rel");

/// The edit allowlist keys.
pub(super) const EDIT_KEYS: AllowKeys = ("command.edit_file_rel", "command.edit_list_key", "command.edit_trust_file_rel");

pub(super) fn load_trusted(cx: &Cx<'_>, cwd: &str, kind: AllowKeys) -> R<Vec<String>> {
    if !gp::is_absolute(cwd) {
        return Err(Unsure);
    }
    let ctx = ident::resolve_context(cwd, true, cx.env);
    if ctx.unsure {
        return Err(Unsure);
    }
    let home = cx.home_raw();
    let Some(top) = ctx.toplevel else { return Ok(Vec::new()) };
    if home.is_empty() {
        return Ok(Vec::new());
    }
    let dir = gp::join(&top, defaults::text("command.allow_dir_rel"));
    let cfg = gp::join(&top, defaults::text(kind.0));
    let Ok(dst) = std::fs::symlink_metadata(&dir) else { return Ok(Vec::new()) };
    if dst.file_type().is_symlink() {
        return Ok(Vec::new());
    }
    let Ok(fst) = std::fs::symlink_metadata(&cfg) else { return Ok(Vec::new()) };
    if fst.file_type().is_symlink() || !fst.is_file() {
        return Ok(Vec::new());
    }
    let bytes = {
        use std::io::Read;
        use std::os::unix::fs::OpenOptionsExt;
        let Ok(mut f) = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(&cfg) else { return Ok(Vec::new()) };
        if !f.metadata().is_ok_and(|m| m.is_file()) {
            return Ok(Vec::new());
        }
        let mut b = Vec::new();
        if f.read_to_end(&mut b).is_err() {
            return Ok(Vec::new());
        }
        b
    };
    if crate::checks::guardkit::jsdiff::js_reads_differently(&bytes) {
        return Err(Unsure);
    }
    let hash: String = ring::digest::digest(&ring::digest::SHA256, &bytes).as_ref().iter().map(|b| format!("{b:02x}")).collect();
    let Ok(Value::Object(parsed)) = serde_json::from_slice::<Value>(&bytes) else { return Ok(Vec::new()) };
    let pats: Vec<String> = match parsed.get(defaults::text(kind.1)) {
        Some(Value::Array(a)) => a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect(),
        _ => return Ok(Vec::new()),
    };
    // trustState: the record for this repository holds exactly this file's hash
    let trust_path = gp::join(home, defaults::text(kind.2));
    let repo_key = std::fs::canonicalize(&top).map_or_else(|_| gp::resolve_abs(&top), |p| p.to_string_lossy().into_owned());
    let records = std::fs::read(&trust_path)
        .ok()
        .and_then(|b| if crate::checks::guardkit::jsdiff::js_reads_differently(&b) { None } else { serde_json::from_slice::<Value>(&b).ok() });
    let trusted = match records {
        Some(Value::Object(o)) => o.get(&repo_key).and_then(Value::as_str).is_some_and(|r| !r.is_empty() && r == hash),
        _ => false,
    };
    if !trusted {
        return Ok(Vec::new());
    }
    // a value that is not a string is dropped by the validator, and the filter keeps the order
    Ok(pats.into_iter().filter(|p| if kind == COMMAND_KEYS { pattern_ok(p) } else { edit_path_ok(p) }).collect())
}

/// `matchedProjectCommandAllowPattern(command, cwd)`: the trusted pattern the command matches, if any.
pub fn matched_project_command_allow(cx: &Cx<'_>, command: &str, cwd: &str) -> R<Option<String>> {
    if trim(command).is_empty() {
        return Ok(None);
    }
    let patterns = load_trusted(cx, cwd, COMMAND_KEYS)?;
    if patterns.is_empty() {
        return Ok(None);
    }
    let split = split_detailed(command);
    if split.segments.len() != 1 || split.delims[0] != "end" {
        return Ok(None);
    }
    if has_unquoted_redirect_char(command) || has_shell_expansion_anywhere(command) {
        return Ok(None);
    }
    let trimmed = trim(command);
    for p in patterns {
        // a pattern JavaScript could read differently from this engine's regex syntax is not guessed at
        if p.contains("(?") && !re!(r"\(\?(?:[:=!]|<[=!])").is_match(&p) {
            return Err(Unsure);
        }
        let Some(rx) = crate::checks::guardkit::jsre::try_compile(&p, false) else { return Err(Unsure) };
        if rx.is_match(trimmed) {
            return Ok(Some(p));
        }
    }
    Ok(None)
}

/// `appendProjectCommandAllowAudit(entry)`: one line in `~/.anti-hall/logs/command-allow.ndjson` (best effort).
pub fn append_allow_audit(cx: &Cx<'_>, cwd: &str, pattern: &str, command: &str) {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let home = cx.home_raw();
    if home.is_empty() {
        return;
    }
    let ah = gp::join(home, defaults::text("command.audit_state_dir"));
    let logs = gp::join(&ah, defaults::text("command.audit_logs_dir"));
    if std::fs::DirBuilder::new().recursive(true).mode(0o700).create(&logs).is_err() {
        return;
    }
    for d in [&ah, &logs] {
        match std::fs::symlink_metadata(d) {
            Ok(m) if !m.file_type().is_symlink() && m.is_dir() => {}
            _ => return,
        }
    }
    let repo = ident::resolve_context(cwd, true, cx.env).toplevel.unwrap_or_default();
    let redacted = redact_audit_command(command);
    let ts = crate::checks::jsport::date::to_iso(crate::checks::jsport::date::now_ms()).unwrap_or_default();
    let line = format!("{{\"ts\":{},\"cwd\":{},\"repo\":{},\"pattern\":{},\"command\":{}}}\n", js(&ts), js(cwd), js(&repo), js(pattern), js(&redacted));
    let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(gp::join(&logs, defaults::text("command.audit_file")))
    else {
        return;
    };
    if !f.metadata().is_ok_and(|m| m.is_file()) {
        return;
    }
    crate::discard::harmless(f.write_all(line.as_bytes())); // keep: the audit line is best effort, as in Node
}

fn js(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| String::from("\"\""))
}

/// `redactAuditCommand`.
fn redact_audit_command(command: &str) -> String {
    let r = re!(r"(?i)(^|\s)(--?[A-Za-z0-9_-]*(?:token|password|passwd|secret|apikey|auth|credential|key)[A-Za-z0-9_-]*)(\s+|=)(\S+)");
    let s = r.replace_all(command, "${1}${2}${3}[REDACTED]").into_owned();
    crate::jev::scrub::scrub_secrets(&s)
}

// ---- the plain push chain ---------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
enum Plain {
    Add,
    Commit,
    Push(Option<String>, Option<String>),
    Log,
    Status,
    Show,
    LsRemote(String),
    RevParse,
}

/// `classifyPlainGitChainSegment`.
fn classify_plain_git(segment: &str) -> Option<Plain> {
    let t0 = trim(segment);
    let trimmed = re!(r"\s+2>&1\s*$").replace(t0, "").into_owned();
    let trimmed = trimmed.as_str();
    if has_unquoted_redirect_char(trimmed) || has_substitution_outside_single_quotes(trimmed) {
        return None;
    }
    if re!(r"(?i)^git\s+add\b").is_match(trimmed) {
        return Some(Plain::Add);
    }
    if re!(r"(?i)^git\s+commit\b").is_match(trimmed) {
        return Some(Plain::Commit);
    }
    // PLAIN_PUSH_SEGMENT_RE, whose two `(?![-+])` lookaheads become a check on the captured word
    if let Some(c) = re!(r"^git\s+push(?:\s+(-q|--quiet|-u|--set-upstream))?(?:\s+([A-Za-z0-9_./-]+))?(?:\s+([A-Za-z0-9_./-]+(?::[A-Za-z0-9_./-]+)?))?\s*$")
        .captures(trimmed)
    {
        let flag = c.get(1).map(|m| m.as_str());
        let m2 = c.get(2).map(|m| m.as_str());
        let m3 = c.get(3).map(|m| m.as_str());
        // `(?![-+])` rejects a word that starts with `-` or `+`: the optional group then cannot take it, and the rest of the
        // pattern (`\s*$`) cannot either, so the whole pattern fails
        if m2.is_some_and(|w| w.starts_with(['-', '+'])) || m3.is_some_and(|w| w.starts_with(['-', '+'])) {
            return None;
        }
        if m3.is_some_and(|w| w.contains(':')) && m2.is_none() {
            return None;
        }
        if matches_flag_u(flag) && !(m2.is_some() && m3.is_some()) {
            return None;
        }
        return Some(Plain::Push(m2.map(str::to_string), m3.map(str::to_string)));
    }
    if re!(r"^git\s+log\s+--oneline(?:\s+-\d+)?\s*$").is_match(trimmed) {
        return Some(Plain::Log);
    }
    if re!(r"^git\s+status(?:\s+(?:--short|-s))?\s*$").is_match(trimmed) {
        return Some(Plain::Status);
    }
    if re!(r"^git\s+show\s+--stat(?:\s+(?:-\d+|HEAD))?\s*$").is_match(trimmed) {
        return Some(Plain::Show);
    }
    if let Some(c) = re!(r"^git\s+ls-remote(?:\s+--heads)?\s+([A-Za-z0-9_./-]+)(?:\s+[A-Za-z0-9_./-]+)?\s*$").captures(trimmed) {
        let remote = c[1].to_string();
        if remote.starts_with(['-', '+']) {
            return None;
        }
        return Some(Plain::LsRemote(remote));
    }
    if let Some(c) = re!(r"^git\s+rev-parse(?:\s+--short)?\s+([A-Za-z0-9_./-]+)\s*$").captures(trimmed)
        && !c[1].starts_with(['-', '+'])
    {
        return Some(Plain::RevParse);
    }
    None
}

fn matches_flag_u(flag: Option<&str>) -> bool {
    flag.is_some_and(|f| f == "-u" || f == "--set-upstream")
}

/// `classifyLeadingCdSegment`.
fn classify_leading_cd(segment: &str) -> Option<String> {
    let trimmed = trim(segment);
    if has_unquoted_redirect_char(trimmed) || has_substitution_outside_single_quotes(trimmed) || has_shell_expansion_anywhere(trimmed) {
        return None;
    }
    let t = tokenize_quoted(trimmed);
    if t.len() != 2 || t[0] != "cd" {
        return None;
    }
    let p = &t[1];
    if p.is_empty() || p == "-" || p.starts_with('~') {
        return None;
    }
    Some(p.clone())
}

fn git_out(cx: &Cx<'_>, cwd: &str, args: &[&str]) -> Option<String> {
    gitrun::git(cwd, args, defaults::millis("command.git_timeout_ms"), cx.env)
}

fn configured_remotes(cx: &Cx<'_>, cwd: &str) -> Option<Vec<String>> {
    let out = git_out(cx, cwd, &["remote"])?;
    Some(out.split('\n').map(|l| trim(l).to_string()).filter(|l| !l.is_empty()).collect())
}

fn current_branch(cx: &Cx<'_>, cwd: &str) -> Option<String> {
    let out = git_out(cx, cwd, &defaults::list("command.git_branch_argv"))?;
    let n = trim(&out).to_string();
    (!n.is_empty()).then_some(n)
}

fn remote_allowed(cx: &Cx<'_>, remote: &Option<String>, cwd: &str) -> bool {
    match remote {
        None => true,
        Some(r) => configured_remotes(cx, cwd).is_some_and(|rs| rs.contains(r)),
    }
}

fn ref_allowed(cx: &Cx<'_>, r: &Option<String>, cwd: &str) -> bool {
    let Some(r) = r else { return true };
    if r == "HEAD" {
        return true;
    }
    let Some(branch) = current_branch(cx, cwd) else { return false };
    let Some(colon) = r.find(':') else { return *r == branch };
    let src = &r[..colon];
    let dst = r[colon + 1..].strip_prefix("refs/heads/").unwrap_or(&r[colon + 1..]);
    if dst != branch {
        return false;
    }
    if src == "HEAD" || src == branch {
        return true;
    }
    if re!(r"(?i)^[0-9a-f]{7,40}$").is_match(src) {
        let resolve = |rev: &str| -> String {
            git_out(cx, cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).map(|o| trim(&o).to_lowercase()).unwrap_or_default()
        };
        let head = resolve("HEAD");
        return !head.is_empty() && resolve(src) == head;
    }
    false
}

/// `sinkPathHasSymlink(target, payload)`.
fn sink_path_has_symlink(cx: &Cx<'_>, target: &str) -> R<bool> {
    let base = Pcx::of(cx).base()?;
    let abs = gp::resolve(&base, super::cx::strip_edge_quotes(target));
    let dirs = super::cx::own_scratchpad_dirs(cx.payload, cx.payload_cwd(), cx.env);
    let Some(root) = dirs.iter().find(|r| abs.starts_with(&format!("{r}/"))) else { return Ok(true) };
    let mut cur = root.clone();
    for part in gp::relative(root, &abs).split('/').filter(|p| !p.is_empty()) {
        cur = gp::join(&cur, part);
        match std::fs::symlink_metadata(&cur) {
            Ok(m) => {
                if m.file_type().is_symlink() {
                    return Ok(true);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Ok(true),
        }
    }
    Ok(false)
}

/// `resolvedLeadingCdTarget(rawPath, payloadCwd)`.
fn resolved_leading_cd_target(cx: &Cx<'_>, raw: &str, payload_cwd: &str) -> R<Option<String>> {
    if !gp::is_absolute(payload_cwd) {
        return Err(Unsure);
    }
    let Ok(target) = std::fs::canonicalize(gp::resolve(payload_cwd, raw)) else { return Ok(None) };
    let target = target.to_string_lossy().into_owned();
    let Some((pcommon, _, u1)) = ident::raw_git_info(payload_cwd) else { return Ok(None) };
    let Some((tcommon, ttop, u2)) = ident::raw_git_info(&target) else { return Ok(None) };
    if u1 || u2 {
        return Err(Unsure);
    }
    if tcommon != pcommon || std::fs::canonicalize(&ttop).is_err() {
        return Ok(None);
    }
    let _ = cx;
    Ok(Some(target))
}

/// `isAllowedPlainPushChain(command, cwd, payload)`.
pub fn is_allowed_plain_push_chain(cx: &Cx<'_>, command0: &str, cwd: &str) -> R<bool> {
    if trim(command0).is_empty() {
        return Ok(false);
    }
    let mut command = command0.to_string();
    // a trailing `> <scratchpad file>` sink is cut off first
    if let Some(c) = re!(r#"[ \t]+>>?[ \t]*([^\s<>&|;'"`$\\]+)((?:[ \t]+2>&1)?)[ \t]*$"#).captures(command0) {
        let (Some(whole), Some(path), Some(merge)) = (c.get(0), c.get(1), c.get(2)) else { return Ok(false) };
        let pc = Pcx { cwd: cx.payload_cwd().map(str::to_string), unknown: false, own_only: true };
        if cx.is_scratch_or_tmp(path.as_str(), &pc)? && !sink_path_has_symlink(cx, path.as_str())? {
            command = format!("{}{}", &command0[..whole.start()], merge.as_str());
        }
    }
    let split = split_detailed(&command);
    let mut segments = split.segments.clone();
    let mut delims: Vec<&'static str> = split.delims.clone();
    if segments.is_empty() {
        return Ok(false);
    }
    let filter = re!(r"^(?:tail|head)(?:\s+(?:-n\s*)?-?\d+)?\s*$");
    if segments.len() >= 2 && delims[delims.len() - 1] == "end" && delims[delims.len() - 2] == "|" && filter.is_match(trim(&segments[segments.len() - 1])) {
        segments.pop();
        delims.pop();
        let n = delims.len();
        delims[n - 1] = "end";
    }
    let mut i = segments.len() as isize - 2;
    while i >= 0 {
        let iu = i as usize;
        if iu + 1 < segments.len()
            && delims[iu] == "|"
            && filter.is_match(trim(&segments[iu + 1]))
            && matches!(classify_plain_git(trim(&segments[iu])), Some(Plain::Push(..)))
        {
            segments.remove(iu + 1);
            delims.remove(iu);
        }
        i -= 1;
    }
    for (k, d) in delims.iter().enumerate() {
        if k == delims.len() - 1 {
            if *d != "end" {
                return Ok(false);
            }
        } else if *d != "&&" && *d != ";" {
            return Ok(false);
        }
    }
    let mut rest: Vec<String> = segments.clone();
    let mut git_cwd = cwd.to_string();
    let first = trim(&segments[0]).to_string();
    if !first.is_empty() && re!(r"(?i)^cd\b").is_match(&first) {
        let Some(raw) = classify_leading_cd(&first) else { return Ok(false) };
        let Some(resolved) = resolved_leading_cd_target(cx, &raw, cwd)? else { return Ok(false) };
        git_cwd = resolved;
        rest = segments[1..].to_vec();
        if rest.is_empty() {
            return Ok(false);
        }
    }
    if !gp::is_absolute(&git_cwd) {
        return Err(Unsure);
    }
    let mut saw_push = false;
    for seg in &rest {
        let t = trim(seg);
        if t.is_empty() {
            continue;
        }
        let Some(cls) = classify_plain_git(t) else { return Ok(false) };
        match &cls {
            Plain::Push(remote, r) => {
                if !remote_allowed(cx, remote, &git_cwd) || !ref_allowed(cx, r, &git_cwd) {
                    return Ok(false);
                }
                saw_push = true;
            }
            Plain::Log | Plain::Status | Plain::Show | Plain::LsRemote(_) | Plain::RevParse => {
                if !saw_push {
                    return Ok(false);
                }
                if let Plain::LsRemote(remote) = &cls
                    && !remote_allowed(cx, &Some(remote.clone()), &git_cwd)
                {
                    return Ok(false);
                }
            }
            Plain::Add | Plain::Commit => {}
        }
    }
    Ok(true)
}

// ---- background scratch scripts ---------------------------------------------------------------------------------------

/// `isBackgroundScratchScriptSegment`.
fn bg_script_segment(cx: &Cx<'_>, segment: &str, pc: &Pcx) -> R<bool> {
    let interps = set("command.background_script_interpreters");
    let stripped = re!(r"\d*>>?\s*\S+").replace_all(segment, " ").into_owned();
    let tokens = tokenize_quoted(&stripped);
    let direct = !tokens.is_empty() && tokens[0].contains('/') && !interps.contains(tokens[0].as_str());
    if !direct && (tokens.len() < 2 || !interps.contains(tokens[0].as_str())) {
        return Ok(false);
    }
    let script = if direct { &tokens[0] } else { &tokens[1] };
    if script.is_empty() || script.starts_with('-') {
        return Ok(false);
    }
    let spc = if direct { Pcx { own_only: true, ..pc.clone() } } else { pc.clone() };
    if !cx.is_scratch_or_tmp(script, &spc)? {
        return Ok(false);
    }
    if direct && sink_path_has_symlink(cx, script)? {
        return Ok(false);
    }
    let base = Pcx::of(cx).base()?;
    let joined = if gp::is_absolute(script) { script.clone() } else { format!("{}/{}", base.trim_end_matches('/'), script) };
    let Ok(real) = std::fs::canonicalize(&joined) else { return Ok(false) };
    let real = real.to_string_lossy().into_owned();
    let Ok(md) = std::fs::metadata(&real) else { return Ok(false) };
    if !md.is_file() {
        return Ok(false);
    }
    {
        use std::os::unix::fs::PermissionsExt;
        if direct && md.permissions().mode() & 0o111 == 0 {
            return Ok(false);
        }
    }
    if tokens.iter().any(|t| t == "--confirmed" || t.starts_with("--confirmed=")) {
        return Ok(false);
    }
    Ok(!is_inside_anti_hall_plugin(cx, &real)?)
}

/// `isBackgroundScratchScript(command, payload)`.
pub fn is_background_scratch_script(cx: &Cx<'_>, command: &str) -> R<bool> {
    let bg = cx.payload.get("tool_input").and_then(|t| t.get("run_in_background"));
    if bg != Some(&Value::Bool(true)) || trim(command).is_empty() {
        return Ok(false);
    }
    let neutral = neutralize_quoted_contents(command);
    if neutral.contains('#') || has_shell_expansion_anywhere(command) || neutral.contains('<') {
        return Ok(false);
    }
    let pc = Pcx::of(cx);
    if has_disallowed_write_redirect(cx, command, &pc)? {
        return Ok(false);
    }
    let split = split_detailed(command);
    if split.segments.is_empty() {
        return Ok(false);
    }
    let delim_ok = set("command.background_chain_delims");
    let mut saw = false;
    for (i, seg) in split.segments.iter().enumerate() {
        if !delim_ok.contains(split.delims[i]) {
            return Ok(false);
        }
        let s = trim(seg);
        if s.is_empty() {
            return Ok(false);
        }
        if bg_script_segment(cx, s, &pc)? {
            saw = true;
        } else if !is_bounded_sink_segment(s) && !is_scratch_file_sink_segment(cx, s, &pc)? {
            return Ok(false);
        }
    }
    Ok(saw)
}

// ---- narrow read-only Google Cloud access -----------------------------------------------------------------------------

/// `isGcloudReadSinkSegment`.
fn gcloud_read_sink_segment(segment: &str) -> bool {
    if has_unquoted_redirect_char(segment) || has_shell_expansion_anywhere(segment) {
        return false;
    }
    let tokens = tokenize_quoted(segment);
    let Some(first) = tokens.first() else { return false };
    if first == "jq" {
        let safe = set("command.jq_safe_flags");
        let mut filters = 0;
        for t in &tokens[1..] {
            if t.starts_with('-') {
                if !safe.contains(t.as_str()) {
                    return false;
                }
                continue;
            }
            if jq_refused_filter(t) {
                return false;
            }
            filters += 1;
        }
        return filters <= 1;
    }
    if !set("command.gcloud_sink_verbs").contains(first.as_str()) {
        return false;
    }
    if first == "grep" && tokens.iter().any(|t| re!(r"^-[A-Za-z]*f").is_match(t) || re!(r"^--file(?:=|$)").is_match(t)) {
        return false;
    }
    is_bounded_sink_segment(segment)
}

/// `JQ_REFUSED_FILTER_RE.test(t)`: `\$ENV|\$__loc__|(^|[^A-Za-z0-9_$])(?:env|input|inputs|input_filename|import|include)(?![A-Za-z0-9_])`.
fn jq_refused_filter(t: &str) -> bool {
    if t.contains("$ENV") || t.contains("$__loc__") {
        return true;
    }
    let words = defaults::list("command.jq_refused_words");
    let b = t.as_bytes();
    let is_word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    for i in 0..=b.len() {
        let lead_ok = i == 0 || !(is_word(b[i - 1]) || b[i - 1] == b'$');
        if !lead_ok {
            continue;
        }
        for w in &words {
            if t[i..].starts_with(w) && b.get(i + w.len()).is_none_or(|c| !is_word(*c)) {
                return true;
            }
        }
    }
    false
}

/// `isGcloudReadSegment(rawSegment)`: `Some(true)` for the token printer, `Some(false)` for a read.
fn gcloud_read_segment(raw: &str) -> Option<bool> {
    let segment = strip_gcloud_stderr_merge(raw);
    if has_unquoted_redirect_char(&segment) || has_shell_expansion_anywhere(&segment) {
        return None;
    }
    let tokens = tokenize_quoted(&segment);
    if tokens.first().map(String::as_str) != Some("gcloud") {
        return None;
    }
    let rest = &tokens[1..];
    if rest.len() == 2 && rest[0] == "auth" && rest[1] == "print-access-token" {
        return Some(true);
    }
    let verbs: HashSet<String> = defaults::list("command.gcloud_read_verbs").into_iter().map(str::to_string).collect();
    let g = gcloud_read_grammar(rest, false, &verbs)?;
    if !gcloud_read_ok(&g) {
        return None;
    }
    let formats: Vec<&String> = g.flags.iter().filter(|f| f.starts_with("--format=")).collect();
    if formats.len() != 1 || !re!(r"^(?:json|yaml|value\(.+\))$").is_match(&formats[0][9..]) {
        return None;
    }
    Some(false)
}

/// `isGoogleApisHttpsUrl(raw)`.
fn googleapis_https_url(raw: &str) -> R<bool> {
    if raw.contains(['{', '}', '[', ']']) {
        return Ok(false);
    }
    let raw_host = re!(r"^https://([^/?#:]*)").captures(raw).map_or("", |c| c.get(1).map_or("", |m| m.as_str()));
    if raw_host.is_empty() || !re!(r"^[A-Za-z0-9.-]+$").is_match(raw_host) {
        return Ok(false);
    }
    // an IDNA label (`xn--`) is validated by the URL parser in ways this check does not reproduce
    if raw_host.split('.').any(|l| l.len() >= 4 && l[..4].eq_ignore_ascii_case("xn--")) {
        return Err(Unsure);
    }
    // the port, when there is one, must be empty or digits up to 65535, else `new URL` throws
    let after = &raw["https://".len() + raw_host.len()..];
    if let Some(p) = after.strip_prefix(':') {
        let end = p.find(['/', '?', '#']).unwrap_or(p.len());
        let port = &p[..end];
        if !port.chars().all(|c| c.is_ascii_digit())
            || (!port.is_empty() && port.trim_start_matches('0').len() as u64 > defaults::num("command.port_digits_max"))
            || port.parse::<u64>().is_ok_and(|n| n > defaults::num("command.port_max"))
        {
            return Ok(false);
        }
    }
    let host = raw_host.to_lowercase();
    if raw.contains('@') || host.starts_with('[') || re!(r"^[\d.]+$").is_match(&host) {
        return Ok(false);
    }
    Ok(host == "googleapis.com" || host.ends_with(".googleapis.com"))
}

/// Remove every `$TV` / `${TV}` reference (`tokenRefRe`: `\$(?:\{TV\}|TV(?![A-Za-z0-9_]))`).
fn strip_token_refs(text: &str, tv: &str) -> String {
    let mut out = String::new();
    let mut i = 0;
    let b = text.as_bytes();
    while i < b.len() {
        if b[i] == b'$' {
            let rest = &text[i + 1..];
            if let Some(r) = rest.strip_prefix('{').and_then(|r| r.strip_prefix(tv)).and_then(|r| r.strip_prefix('}')) {
                i = text.len() - r.len();
                continue;
            }
            if let Some(r) = rest.strip_prefix(tv)
                && r.as_bytes().first().is_none_or(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))
            {
                i = text.len() - r.len();
                continue;
            }
        }
        let ch = text[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `curlSegmentShape(segment, tokenVar)`: `Some(max_filesize)` for an accepted shape.
fn curl_segment_shape(segment: &str, tv: &str) -> R<Option<bool>> {
    if has_unquoted_redirect_char(segment) || has_substitution_outside_single_quotes(segment) || re!(r"[`\\]|[<>]\(").is_match(segment) {
        return Ok(None);
    }
    let tokens = tokenize_quoted(segment);
    if tokens.first().map(String::as_str) != Some("curl") {
        return Ok(None);
    }
    let (mut silent, mut url, mut max_filesize) = (false, None::<&String>, false);
    let mut i = 1;
    while i < tokens.len() {
        let t = &tokens[i];
        if re!(r"^-[sSf]+$").is_match(t) {
            if t.contains('s') {
                silent = true;
            }
            i += 1;
            continue;
        }
        if set("command.curl_bare_flags").contains(t.as_str()) {
            if t == "--silent" {
                silent = true;
            }
            i += 1;
            continue;
        }
        if t == "-X" || t == "--request" {
            if tokens.get(i + 1).map(String::as_str) != Some("GET") {
                return Ok(None);
            }
            i += 2;
            continue;
        }
        if t == "-XGET" || t == "--request=GET" {
            i += 1;
            continue;
        }
        if t == "--max-filesize" || t == "--max-time" || t == "-m" {
            if !tokens.get(i + 1).is_some_and(|v| re!(r"^\d+$").is_match(v)) {
                return Ok(None);
            }
            if t == "--max-filesize" {
                max_filesize = true;
            }
            i += 2;
            continue;
        }
        if t == "-H" || t == "--header" {
            let Some(h) = tokens.get(i + 1).filter(|h| !h.is_empty() && !h.starts_with('@')) else { return Ok(None) };
            let stripped = strip_token_refs(h, tv);
            if stripped.contains(['$', '`', '\\']) {
                return Ok(None);
            }
            if stripped != *h {
                let bearer = crate::checks::lit_re(&format!(r"(?i)^Authorization:\s*Bearer\s+\$(?:\{{{tv}\}}|{tv})$", tv = regex::escape(tv)));
                if !bearer.is_match(h) {
                    return Ok(None);
                }
            }
            i += 2;
            continue;
        }
        if t.starts_with('-') {
            return Ok(None);
        }
        if url.is_some() {
            return Ok(None);
        }
        if !re!(r"^https://[^\s$`\\@]+$").is_match(t) || !googleapis_https_url(t)? {
            return Ok(None);
        }
        url = Some(t);
        i += 1;
    }
    if !silent || url.is_none() {
        return Ok(None);
    }
    if strip_token_refs(segment, tv).contains('$') {
        return Ok(None);
    }
    Ok(Some(max_filesize))
}

/// `isAllowedGcloudReadCommand(command)`.
pub fn is_allowed_gcloud_read_command(command: &str) -> R<bool> {
    if trim(command).is_empty() || neutralize_quoted_contents(command).contains('#') {
        return Ok(false);
    }
    if let Some(c) = re!(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=\$\(\s*gcloud\s+auth\s+print-access-token\s*\)\s*(?:;|&&)\s*").captures(command) {
        let (Some(whole), Some(var)) = (c.get(0), c.get(1)) else { return Ok(false) };
        if !set("command.gcloud_token_vars").contains(var.as_str()) {
            return Ok(false);
        }
        let rest = &command[whole.end()..];
        let split = split_detailed(rest);
        if split.segments.is_empty() || split.delims.last() != Some(&"end") {
            return Ok(false);
        }
        let Some(max_filesize) = curl_segment_shape(&split.segments[0], var.as_str())? else { return Ok(false) };
        if split.delims[..split.delims.len() - 1].iter().any(|d| *d != "|") {
            return Ok(false);
        }
        if !split.segments[1..].iter().all(|s| gcloud_read_sink_segment(s)) {
            return Ok(false);
        }
        return Ok(split.segments.len() > 1 || max_filesize);
    }
    let split = split_detailed(command);
    if split.segments.is_empty() || split.delims.last() != Some(&"end") {
        return Ok(false);
    }
    let Some(token) = gcloud_read_segment(&split.segments[0]) else { return Ok(false) };
    if token {
        return Ok(split.segments.len() == 1);
    }
    if split.delims[..split.delims.len() - 1].iter().any(|d| *d != "|") {
        return Ok(false);
    }
    Ok(split.segments[1..].iter().all(|s| gcloud_read_sink_segment(s)))
}
