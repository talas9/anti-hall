//! The Bash edit parity of command-guard: a main-thread Bash write (`sed -i`, `perl -i`, `tee`, `cp`, `mv`, a redirect, a
//! literal open-for-write path in inline interpreter code, also inside `sh -c`, `eval`, `$(...)` or a heredoc fed to a
//! shell) into a file the edit-guard would refuse for the Edit tool gets the same delegation block.
//!
//! Mirrors `classifyBashWork(.., { editOnly: true })` of `hooks/command-guard.js` and, for the verdict on one path,
//! `editVerdict` of `hooks/edit-guard.js`. Every filesystem question Node asks (lstat chain, realpath, stat, git toplevel) is
//! asked the same way; whatever depends on the hook's own working directory is [`Unsure`].
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::carve::{EDIT_KEYS, load_trusted, matched_project_command_allow};
use super::cx::{Cx, Pcx, R, Roots, Unsure, own_scratchpad_dirs};
use super::devswarm::{devswarm_active, is_child_workspace};
use super::guard::{is_codex_payload, primary_tier_text_on};
use super::shell::{blank_test_operators, effective_verb, extract_substitutions, mask_process_substitutions, split_detailed, tokenize_quoted, trim};
use super::tables::tables;
use super::verify::re;
use super::writes::{bash_write_targets, may_write, shell_run_payloads, unbrace_simple_vars};
use crate::checks::git::tokenize::basename;
use crate::checks::git::util::{posix_basename, posix_dirname, posix_normalize};
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths as gp;
use crate::checks::guardkit::settings::{get_bool, get_string, is_skipped};
use crate::checks::jsport::{fsx, ident};
use crate::checks::{Exact, Verdict};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;

/// One working-directory possibility of a segment (`cdAwareContexts`).
#[derive(Clone, PartialEq, Eq)]
struct Ctx {
    cwd: String,
    unknown: bool,
}

/// `cdAwareContexts(segments, delims, payload)`: for each segment, the directories it may run in.
fn cd_aware_contexts(cx: &Cx<'_>, segments: &[String], delims: &[&str]) -> R<Vec<Vec<Ctx>>> {
    let cwd = cx.payload_cwd().filter(|c| gp::is_absolute(c)).ok_or(Unsure)?;
    let start = fsx::realpath_or_self(&gp::resolve_abs(cwd));
    let mut cur = vec![Ctx { cwd: start, unknown: false }];
    let mut out = Vec::new();
    for i in 0..segments.len() {
        out.push(cur.clone());
        let d = delims[i];
        if !defaults::list("command.cd_delims").contains(&d) {
            continue;
        }
        let toks = tokenize_quoted(&segments[i]);
        if toks.first().map(String::as_str) != Some("cd") {
            continue;
        }
        let t = trim(&segments[i]);
        let raw_arg = trim(t.get(2..).unwrap_or(""));
        let arg = toks.get(1);
        let next: Vec<Ctx> =
            if toks.len() != 2 || arg.is_none_or(|a| a.is_empty() || a == "-") || raw_arg.contains(['$', '`', '*', '?', '[', ']', '{', '}', '~']) {
                cur.iter().map(|c| Ctx { cwd: c.cwd.clone(), unknown: true }).collect()
            } else {
                let arg = arg.map(String::as_str).unwrap_or("");
                cur.iter().map(|c| Ctx { cwd: fsx::realpath_or_self(&gp::resolve(&c.cwd, arg)), unknown: c.unknown && !gp::is_absolute(arg) }).collect()
            };
        let merged: Vec<Ctx> = if d == "&&" { next } else { cur.iter().cloned().chain(next).collect() };
        let mut seen: Vec<Ctx> = Vec::new();
        for c in merged {
            if !seen.contains(&c) {
                seen.push(c);
            }
        }
        seen.truncate(defaults::num("command.cd_contexts_max") as usize);
        cur = seen;
    }
    Ok(out)
}

/// `isWriteMode(m)`.
fn is_write_mode(m: &str) -> bool {
    re!(r"^[rwaxbt+]{1,4}$").is_match(m) && m.contains(['w', 'a', 'x', '+'])
}

/// `inlineCodeBody(segment)`.
fn inline_code_body(segment: &str) -> Option<String> {
    let t = tables();
    let verb = effective_verb(segment).replace(['"', '\''], "");
    if !t.inline_verbs.contains(&verb) {
        return None;
    }
    let toks = tokenize_quoted(segment);
    let vi = toks.iter().position(|x| basename(x).to_lowercase() == verb)?;
    let flags = if verb.starts_with("python") { &t.inline_python_flags } else { &t.inline_other_flags };
    let fi = toks.iter().enumerate().position(|(k, x)| k > vi && flags.contains(x))?;
    toks.get(fi + 1).cloned()
}

/// `inlineWriteLiterals(segment)`.
fn inline_write_literals(segment: &str) -> Vec<String> {
    let Some(body) = inline_code_body(segment) else { return Vec::new() };
    let mut out: Vec<String> = Vec::new();
    // a quote pair is written as two alternatives (the pattern's back-reference `\1`)
    let open = re!(r#"\bopen\s*\(\s*(?:'([^'"]+)'|"([^'"]+)")\s*,\s*(?:'([^'"]*)'|"([^'"]*)")\s*[,)]"#);
    for c in open.captures_iter(&body) {
        let path = c.get(1).or_else(|| c.get(2));
        let mode = c.get(3).or_else(|| c.get(4));
        if let (Some(p), Some(m)) = (path, mode)
            && is_write_mode(m.as_str())
        {
            out.push(p.as_str().to_string());
        }
    }
    let perl3 = re!(
        r#"\bopen\s*\(?\s*(?:my\s+)?[$A-Za-z0-9_]+\s*,\s*(?:'\s*\+?(?:>>?|\+<)[:A-Za-z0-9_]*\s*'|"\s*\+?(?:>>?|\+<)[:A-Za-z0-9_]*\s*")\s*,\s*(?:'([^'"]+)'|"([^'"]+)")"#
    );
    for c in perl3.captures_iter(&body) {
        if let Some(p) = c.get(1).or_else(|| c.get(2)) {
            out.push(p.as_str().to_string());
        }
    }
    let perl2 = re!(r#"\bopen\s*\(?\s*(?:my\s+)?[$A-Za-z0-9_]+\s*,\s*(?:'\s*\+?>>?\s*([^'"\s>&=-][^'"\s]*)\s*'|"\s*\+?>>?\s*([^'"\s>&=-][^'"\s]*)\s*")"#);
    for c in perl2.captures_iter(&body) {
        if let Some(p) = c.get(1).or_else(|| c.get(2)) {
            out.push(p.as_str().to_string());
        }
    }
    let wf = re!(r#"(?:(?:write|append)File(?:Sync)?|createWriteStream)\(\s*(?:'([^'"]+)'|"([^'"]+)")"#);
    for c in wf.captures_iter(&body) {
        if let Some(p) = c.get(1).or_else(|| c.get(2)) {
            out.push(p.as_str().to_string());
        }
    }
    let fw = re!(r#"(?:File|IO)\.write\(\s*(?:'([^'"]+)'|"([^'"]+)")"#);
    for c in fw.captures_iter(&body) {
        if let Some(p) = c.get(1).or_else(|| c.get(2)) {
            out.push(p.as_str().to_string());
        }
    }
    out
}

/// The answer of `resolveWriteTarget` for one write target.
struct Target {
    abs: String,
    base: String,
    in_base: bool,
    scratch: bool,
}

/// `resolveWriteTarget(t, ctx, payload, rootOf)`.
fn resolve_write_target(cx: &Cx<'_>, t: &str, ctx: &Ctx, roots: &Roots<'_>) -> R<Option<Target>> {
    if t.is_empty() || t.contains(['$', '`', '*', '?', '[', ']', '{', '}']) || t.starts_with('~') {
        return Ok(None);
    }
    if ctx.unknown && !gp::is_absolute(t) {
        return Ok(None);
    }
    let resolved = gp::resolve(&ctx.cwd, t);
    let abs = gp::join(&fsx::realpath_or_self(&posix_dirname(&resolved)), &posix_basename(&resolved));
    let r = roots.of(&ctx.cwd)?;
    let in_top = r.toplevel.as_ref().is_some_and(|top| fsx::is_inside_dir(&abs, top));
    let own = Pcx { cwd: cx.payload_cwd().map(str::to_string), unknown: false, own_only: true };
    let any = Pcx { own_only: false, ..own.clone() };
    let scratch = cx.is_scratch_or_tmp(&abs, &own)? || (!in_top && cx.is_scratch_or_tmp(&abs, &any)?);
    Ok(Some(Target { in_base: fsx::is_inside_dir(&abs, &r.base), abs, base: r.base, scratch }))
}

// ---- edit-guard's verdict on one path ---------------------------------------------------------------------------------

/// `globToRegExp(glob)` of `hooks/edit-guard.js`.
fn glob_re(glob: &str) -> Regex {
    let mut src = String::from("^");
    let cs: Vec<char> = glob.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        if cs[i] == '*' && cs.get(i + 1) == Some(&'*') {
            src.push_str(r"[^\n\r\x{2028}\x{2029}]*");
            i += 2;
        } else if cs[i] == '*' {
            src.push_str("[^/]*");
            i += 1;
        } else {
            if ".*+?^${}()|[]\\".contains(cs[i]) {
                src.push('\\');
            }
            src.push(cs[i]);
            i += 1;
        }
    }
    src.push('$');
    crate::checks::lit_re(&src)
}

/// `basename(p)` of `hooks/edit-guard.js`: the last `/` or `\` separated part.
fn eg_basename(p: &str) -> String {
    p.replace('\\', "/").rsplit('/').next().unwrap_or("").to_string()
}

/// `toRelPath(filePath, cwd)`.
fn to_rel_path(file: &str, cwd: &str) -> String {
    let mut p = file.to_string();
    if !cwd.is_empty() && gp::is_absolute(&p) {
        p = gp::relative(cwd, &p);
    }
    p.replace('\\', "/")
}

/// `isAllowed(filePath, cwd)`.
fn is_allowed(cx: &Cx<'_>, file: &str, cwd: &str) -> bool {
    let base = eg_basename(file);
    let rel = to_rel_path(file, cwd);
    for pat in defaults::list("command.eg_default_allow") {
        let re = glob_re(pat);
        if pat.contains('/') {
            if re.is_match(&base) || re.is_match(&rel) {
                return true;
            }
        } else if !rel.contains('/') && re.is_match(&rel) {
            return true;
        }
    }
    let extra = get_string(cx.st, defaults::raw("command.eg_allow_setting"));
    for pat in extra.split([':', ',']).map(trim).filter(|s| !s.is_empty()) {
        let re = glob_re(pat);
        if re.is_match(&base) || re.is_match(&rel) {
            return true;
        }
    }
    false
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    norm(a) == norm(b)
}

/// `allowlistIsHonest(filePath, cwd)`.
fn allowlist_is_honest(file: &str, cwd: &str) -> bool {
    use std::os::unix::fs::MetadataExt;
    if !gp::is_absolute(cwd) {
        return false;
    }
    let abs = gp::resolve(cwd, file);
    let rel = gp::relative(cwd, &abs);
    let inside = !rel.is_empty() && !rel.starts_with("..") && !gp::is_absolute(&rel);
    let chain: Vec<String> = if inside {
        let mut cur = cwd.to_string();
        rel.split('/')
            .map(|seg| {
                cur = gp::join(&cur, seg);
                cur.clone()
            })
            .collect()
    } else {
        vec![abs.clone()]
    };
    for (i, p) in chain.iter().enumerate() {
        match std::fs::symlink_metadata(p) {
            Ok(m) => {
                if m.file_type().is_symlink() {
                    return false;
                }
                if i == chain.len() - 1 && m.is_file() && m.nlink() > 1 {
                    return false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        }
    }
    let (Ok(real_dir_of_abs), Ok(dir_of_real)) = (
        std::fs::canonicalize(&abs).map(|p| posix_dirname(&p.to_string_lossy())),
        std::fs::canonicalize(posix_dirname(&abs)).map(|p| p.to_string_lossy().into_owned()),
    ) else {
        return false;
    };
    same_path(&real_dir_of_abs, &dir_of_real)
}

/// `canonicalUnderProjectRoot(filePath, cwd)`.
fn canonical_under_project_root(cx: &Cx<'_>, file: &str, cwd: &str) -> R<Option<(String, String)>> {
    if file.is_empty() || cwd.is_empty() {
        return Ok(None);
    }
    if !gp::is_absolute(cwd) {
        return Err(Unsure);
    }
    // sessionProjectRoot(cwd): the outermost checkout, unless that is the real home
    let c = ident::resolve_context(cwd, false, cx.env);
    if c.unsure {
        return Err(Unsure);
    }
    let real_home = cx.home().map(|h| std::fs::canonicalize(h).map_or_else(|_| h.to_string(), |p| p.to_string_lossy().into_owned()))?;
    let session_root = match c.worktree_root {
        Some(w) if w != real_home => w,
        _ => cwd.to_string(),
    };
    let root = fsx::realpath_or_self(&session_root);
    let abs = gp::resolve(cwd, file);
    let real = gp::join(&fsx::realpath_or_self(&posix_dirname(&abs)), &posix_basename(&abs));
    let rel = gp::relative(&root, &real);
    if rel.is_empty() || rel.starts_with("..") || gp::is_absolute(&rel) {
        return Ok(None);
    }
    Ok(Some((real, root)))
}

fn fold_segment(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase()
}

/// `projectEditTarget(filePath, cwd)`: the repository-relative path of `file`, when it lies inside the repository at `cwd`.
fn project_edit_target(cx: &Cx<'_>, file: &str, cwd: &str) -> R<Option<(String, String)>> {
    if file.is_empty() {
        return Ok(None);
    }
    if !gp::is_absolute(cwd) {
        return Err(Unsure);
    }
    let c = ident::resolve_context(cwd, true, cx.env);
    if c.unsure {
        return Err(Unsure);
    }
    let Some(top) = c.toplevel else { return Ok(None) };
    let real_top = fsx::realpath_or_self(&top);
    let real_abs = fsx::realpath_or_self(&gp::resolve(cwd, file));
    let rel = gp::relative(&real_top, &real_abs);
    if rel.is_empty() || rel.starts_with("..") || gp::is_absolute(&rel) {
        return Ok(None);
    }
    Ok(Some((rel, real_abs)))
}

/// `isProjectEditAllowed(filePath, cwd)`.
fn is_project_edit_allowed(cx: &Cx<'_>, file: &str, cwd: &str) -> R<bool> {
    let Some((rel, real_abs)) = project_edit_target(cx, file, cwd)? else { return Ok(false) };
    let segs: Vec<String> = rel.split('/').map(fold_segment).collect();
    let deny = defaults::list("command.eg_project_deny_segments");
    if segs.iter().any(|s| deny.contains(&s.as_str())) || segs.last().map(String::as_str) == Some(defaults::text("command.eg_hooks_file")) {
        return Ok(false);
    }
    let home = match crate::checks::spawnctx::state_home(&cx.st.env) {
        crate::checks::spawnctx::Home::Ok(h) => h,
        crate::checks::spawnctx::Home::Guarded => return Ok(false),
        crate::checks::spawnctx::Home::Unknown => return Err(Unsure),
    };
    let claude_home = fsx::realpath_or_self(&gp::join(&home, defaults::text("command.eg_claude_dir")));
    let in_claude = gp::relative(&claude_home, &real_abs);
    if in_claude.is_empty() || (!in_claude.starts_with("..") && !gp::is_absolute(&in_claude)) {
        return Ok(false);
    }
    let paths = load_trusted(cx, cwd, EDIT_KEYS)?;
    if paths.is_empty() || !paths.iter().any(|g| glob_re(g).is_match(&rel)) {
        return Ok(false);
    }
    Ok(allowlist_is_honest(file, cwd))
}

/// `isLikelySource(filePath)`.
fn is_likely_source(file: &str) -> bool {
    let norm = file.replace('\\', "/");
    re!(r"(?i)(^|[\\/])(plugins|scripts|hooks|companion|statusline|tests)[\\/]").is_match(&norm)
        || re!(r"(?i)\.(js|mjs|cjs|jsx|ts|tsx|py|sh|go|rs|c|h|cpp|java|rb)$").is_match(&norm)
}

/// `editVerdict(filePath, cwd, payload) === 'allow'`.
fn edit_allows(cx: &Cx<'_>, file: &str, cwd: &str) -> R<bool> {
    let project_allow = cx.setting_not_false("command.setting_project_edit_allow")?;
    if project_allow
        && let Some((rel, _)) = project_edit_target(cx, file, cwd)?
        && rel.split('/').map(fold_segment).collect::<Vec<_>>().join("/") == defaults::text("command.eg_edit_allow_file")
    {
        return Ok(false);
    }
    if is_allowed(cx, file, cwd) && allowlist_is_honest(file, cwd) {
        return Ok(true);
    }
    if let Some((cfile, croot)) = canonical_under_project_root(cx, file, cwd)?
        && is_allowed(cx, &cfile, &croot)
        && allowlist_is_honest(&cfile, &croot)
    {
        return Ok(true);
    }
    if project_allow && is_project_edit_allowed(cx, file, cwd)? {
        return Ok(true);
    }
    // a Claude plan file under ~/.claude/plans
    if re!(r"(?i)\.md$").is_match(file) {
        let home = cx.home()?;
        let abs = gp::resolve(cwd, file);
        let real_abs = fsx::realpath_or_self(&abs);
        let real_plans = fsx::realpath_or_self(&gp::join(home, defaults::text("command.eg_plans_rel")));
        let rel = gp::relative(&real_plans, &real_abs);
        if !rel.is_empty() && !rel.starts_with("..") && !gp::is_absolute(&rel) && allowlist_is_honest(file, cwd) {
            return Ok(true);
        }
    }
    // the session's own scratchpad
    {
        let dirs = own_scratchpad_dirs(cx.payload, Some(cwd), cx.env);
        if !dirs.is_empty() {
            let real_abs = fsx::realpath_or_self(&gp::resolve(cwd, file));
            let hit = dirs.iter().any(|d| {
                let rel = gp::relative(&fsx::realpath_or_self(d), &real_abs);
                !rel.is_empty() && !rel.starts_with("..") && !gp::is_absolute(&rel)
            });
            if hit && allowlist_is_honest(file, cwd) {
                return Ok(true);
            }
        }
    }
    // a handover note, or the legacy CONTINUE-HERE file
    let base = eg_basename(file);
    let is_handover = re!(r"(?i)\.md$").is_match(&base) && re!(r"(?i)(handover|handoff|compact.*(?:handover|handoff|prep))").is_match(&base);
    let legacy = {
        let rel = posix_normalize(&to_rel_path(file, cwd));
        !rel.contains('/') && re!(r"^(?:CONTINUE-HERE\.md|[^/]*\.continue-here\.md)$").is_match(&rel)
    };
    if is_handover || legacy {
        let abs = gp::resolve(cwd, file);
        let rel = gp::relative(cwd, &abs);
        let within = !rel.is_empty() && !rel.starts_with("..") && !gp::is_absolute(&rel);
        if within && allowlist_is_honest(file, cwd) {
            if cwd.is_empty() {
                return Ok(true);
            }
            return Ok(std::fs::metadata(&abs).is_ok());
        }
    }
    let plan = cx.payload.get("permission_mode").and_then(Value::as_str).is_some_and(|m| m.to_lowercase() == defaults::text("command.eg_plan_mode"));
    if plan && !is_likely_source(file) && allowlist_is_honest(file, cwd) {
        return Ok(true);
    }
    Ok(false)
}

// ---- the classification -----------------------------------------------------------------------------------------------

/// `classifyBashWork(command, payload, { editOnly: true }).editBlocks` (depth `depth`).
fn edit_blocks(cx: &Cx<'_>, command: &str, depth: usize, out: &mut BTreeSet<String>) -> R<()> {
    if trim(command).is_empty() || command.len() > tables().max_len {
        return Ok(());
    }
    let roots = Roots::new(cx)?;
    let (masked, inners) =
        if command.contains("<(") || command.contains(">(") { mask_process_substitutions(command) } else { (command.to_string(), Vec::new()) };
    let masked = blank_test_operators(&masked);
    let split = split_detailed(&unbrace_simple_vars(&masked));
    let ctxs = cd_aware_contexts(cx, &split.segments, &split.delims)?;
    for (i, seg) in split.segments.iter().enumerate() {
        let is_git = effective_verb(seg) == "git";
        for ctx in &ctxs[i] {
            let mut targets: Vec<String> = bash_write_targets(seg, Some(&ctx.cwd));
            targets.extend(inline_write_literals(seg));
            for t in targets {
                let Some(w) = resolve_write_target(cx, &t, ctx, &roots)? else { continue };
                if w.scratch || !w.in_base {
                    continue;
                }
                if !is_git && !edit_allows(cx, &w.abs, &w.base)? {
                    out.insert(w.abs);
                }
            }
        }
    }
    if depth < tables().max_depth {
        let mut inner = shell_run_payloads(&split.segments, &masked);
        inner.extend(extract_substitutions(&masked));
        inner.extend(inners);
        for sub in inner {
            edit_blocks(cx, &sub, depth + 1, out)?;
        }
    }
    Ok(())
}

/// `edit-guard.js` `delegationReason(label, cwd, payload)`.
fn delegation_reason(cx: &Cx<'_>) -> R<String> {
    let codex = is_codex_payload(cx.payload);
    let sub = if codex { defaults::text("command.codex_subagent") } else { defaults::text("command.claude_subagent") };
    let active = devswarm_active(cx);
    let plugin = std::fs::canonicalize(cx.plugin_root).map_err(|_| Unsure)?;
    let cli = gp::join(&plugin.to_string_lossy(), defaults::text("command.devswarm_cli_rel"));
    let quoted = format!("'{}'", cli.replace('\'', r"'\''"));
    let skip_cmd = msg::render("command.msg_edit_skip_cmd", &[("cli", &quoted)]);
    let override_ = msg::render("command.msg_edit_override", &[("skip", &skip_cmd)]);
    let notes = if codex { msg::render("command.msg_edit_notes_codex", &[("sub", sub)]) } else { defaults::text("command.msg_edit_notes").to_string() };
    let what = msg::render(
        "command.msg_edit_what",
        &[("who", if active { defaults::text("command.msg_edit_who_orch") } else { defaults::text("command.msg_edit_who_coord") })],
    );
    let guard = defaults::text("command.edit_guard_name");
    if active {
        let cwd = cx.payload.get("cwd").and_then(Value::as_str).unwrap_or("");
        let tier = !is_child_workspace(cx) && { if cwd.is_empty() { return Err(Unsure) } else { primary_tier_text_on(cx, cwd)? } };
        let instead =
            if tier { msg::render("command.msg_edit_instead_tier", &[("sub", sub)]) } else { msg::render("command.msg_edit_instead", &[("sub", sub)]) };
        return Ok(msg::message(
            Kind::Block,
            guard,
            &Parts { what: &what, why: defaults::text("command.msg_edit_why_orch"), instead: &instead, allowed: &notes, override_: &override_, extra: &[] },
        ));
    }
    let instead = msg::render("command.msg_edit_instead", &[("sub", sub)]);
    Ok(msg::message(
        Kind::Block,
        guard,
        &Parts { what: &what, why: defaults::text("command.msg_edit_why"), instead: &instead, allowed: "", override_: &override_, extra: &[] },
    ))
}

/// The Bash edit parity step of `main`: `Some(block)` when a write target is one edit-guard would refuse.
pub fn edit_parity(cx: &Cx<'_>, command: &str) -> R<Option<Verdict>> {
    if command.len() > tables().max_len {
        return Err(Unsure);
    }
    // nothing in the command can name a write target Node would judge
    if !may_write(command, 0) {
        return Ok(None);
    }
    if !cx.setting_not_false("command.setting_bash_edit_parity")?
        || !get_bool(cx.st, defaults::raw("edit_guard.setting"))
        || is_skipped(cx.st, defaults::text("command.edit_guard_name"))
    {
        return Ok(None);
    }
    let cwd = cx.payload.get("cwd").and_then(Value::as_str).unwrap_or("");
    if matched_project_command_allow(cx, command, cwd)?.is_some() {
        return Ok(None);
    }
    let mut blocks = BTreeSet::new();
    edit_blocks(cx, command, 0, &mut blocks)?;
    if blocks.is_empty() {
        return Ok(None);
    }
    Ok(Some(Verdict::Exact(Exact::json_block(&delegation_reason(cx)?))))
}
