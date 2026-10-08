//! The full command-guard decision for one Bash call: the special data-safety guards, the skip and switch, the coordinator
//! test, the Bash edit parity and the heavy-command gate with its carve-outs and its block message.
//!
//! Mirrors `hooks/command-guard.js` `main` step by step. The engine answers every call it can prove the Node answer for and
//! returns [`Verdict::Defer`] only when an answer needs something it cannot see (the hook's own working directory, a git
//! layout it does not classify, a settings file only JavaScript can read, a pattern or URL grammar it does not reproduce).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::carve::{
    append_allow_audit, is_allowed_gcloud_read_command, is_allowed_plain_push_chain, is_background_scratch_script, matched_project_command_allow,
};
use super::cx::{Cx, Pcx, R, Unsure};
use super::devswarm::{devswarm_active, is_child_workspace, special_guards};
use super::heavy::{git_subcommand_index, is_heavy_command, is_heavy_gh_segment, is_heavy_segment};
use super::shell::{effective_verb, extract_eval_payload, extract_shell_c_payload, extract_substitutions, split_segments, tokenize_quoted, trim};
use super::tables::tables;
use super::verify::{is_bounded_verification_command, re};
use crate::checks::git::tokenize::basename;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths as gp;
use crate::checks::guardkit::settings::{get_bool, get_string, is_skipped};
use crate::checks::jsport::ident;
use crate::checks::{Exact, Verdict};
use crate::defaults;
use regex::Regex;
use serde_json::Value;

/// `isCodexPayload(payload)`.
pub fn is_codex_payload(p: &Value) -> bool {
    if !p.is_object() {
        return false;
    }
    if p.get("tool_name").and_then(Value::as_str) == Some(defaults::text("command.codex_patch_tool")) {
        return true;
    }
    let s = |k: &str| p.get(k).and_then(Value::as_str).is_some_and(|v| !v.is_empty());
    s("turn_id") && s("model")
}

/// `isCoordinator(payload, env)`.
pub fn is_coordinator(cx: &Cx<'_>) -> bool {
    let p = cx.payload;
    let entry = cx.env.get(defaults::text("command.entrypoint_env")).unwrap_or("");
    let by_payload = |markers: &[&str], truthy: bool| {
        p.is_object()
            && markers.iter().any(|k| match p.get(*k) {
                None | Some(Value::Null) => false,
                Some(v) => !truthy || crate::checks::guardkit::text::js_truthy(Some(v)),
            })
    };
    let markers = defaults::list("command.agent_markers");
    if is_codex_payload(p) {
        return !by_payload(&markers, false) && entry.is_empty();
    }
    if by_payload(&markers, true) || entry == defaults::text("command.subagent_entrypoint") {
        return false;
    }
    if entry.is_empty() {
        return false;
    }
    entry == defaults::text("command.cli_entrypoint")
        || entry.starts_with(defaults::text("command.ide_entrypoint_prefix"))
        || defaults::list("command.ide_entrypoints").contains(&entry)
}

/// `classifyHeavy(command, depth)`: `(is_remote, label)`; the label is a heavy verb for a verb hit.
fn classify_heavy(command: &str, d: usize) -> Option<(bool, bool, String)> {
    if trim(command).is_empty() {
        return None;
    }
    let max = tables().max_depth;
    for seg in split_segments(command) {
        if is_heavy_segment(&seg, command) {
            let push_or_pull = |wanted: &[&str]| -> bool {
                if effective_verb(&seg) != "git" {
                    return false;
                }
                let tokens = tokenize_quoted(&seg);
                let Some(gi) = tokens.iter().position(|t| basename(t).to_lowercase() == "git") else { return false };
                git_subcommand_index(&tokens, gi).is_some_and(|si| wanted.contains(&tokens[si].to_lowercase().as_str()))
            };
            if is_heavy_gh_segment(&seg, "")
                || push_or_pull(&defaults::list("command.classify_push_subs"))
                || push_or_pull(&defaults::list("command.classify_pull_subs"))
            {
                return Some((true, false, String::new()));
            }
            let verb = effective_verb(&seg);
            if !verb.is_empty() && tables().heavy_verbs.contains(&verb) {
                return Some((false, true, verb));
            }
            return Some((false, false, defaults::text("command.heavy_pattern_label").to_string()));
        }
        if d < max {
            for inner in [extract_shell_c_payload(&seg), extract_eval_payload(&seg)] {
                if !inner.is_empty()
                    && let Some(c) = classify_heavy(&inner, d + 1)
                {
                    return Some(c);
                }
            }
        }
    }
    if d < max {
        for inner in extract_substitutions(command) {
            if let Some(c) = classify_heavy(&inner, d + 1) {
                return Some(c);
            }
        }
    }
    None
}

/// `noWorkspaceRepo(cwd, home)` of `lib/dispatch-tier.js`.
fn no_workspace_repo(cx: &Cx<'_>, cwd: &str) -> R<bool> {
    if !gp::is_absolute(cwd) {
        return Err(Unsure);
    }
    let dir0 = gp::resolve_abs(cwd);
    let raw = get_string(cx.st, defaults::raw("command.tier_repos_setting"));
    let list: Vec<&str> = raw.split(',').map(trim).filter(|s| !s.is_empty()).collect();
    if list.contains(&"*") {
        return Ok(true);
    }
    for e in &list {
        let hit = if gp::is_absolute(e) { dir0 == *e || dir0.starts_with(&format!("{e}/")) } else { dir0.split('/').any(|p| p == *e) };
        if hit {
            return Ok(true);
        }
    }
    if !get_bool(cx.st, defaults::raw("command.tier_detect_setting")) {
        return Ok(false);
    }
    let c = ident::resolve_context(&dir0, true, cx.env);
    if c.unsure {
        return Err(Unsure);
    }
    let root = c.worktree_root;
    let rx = re!(r"(?i)no\s+workspaces?\s+for\s+real\s+work");
    let mut dir = dir0;
    for _ in 0..defaults::num("command.tier_doc_levels") {
        for f in defaults::list("command.tier_doc_files") {
            if let Ok(b) = std::fs::read(gp::join(&dir, f)) {
                if crate::checks::guardkit::jsdiff::js_reads_differently(&b) {
                    return Err(Unsure);
                }
                if rx.is_match(&String::from_utf8_lossy(&b)) {
                    return Ok(true);
                }
            }
        }
        if root.as_deref() == Some(dir.as_str()) {
            break;
        }
        let up = crate::checks::git::util::posix_dirname(&dir);
        if up == dir {
            break;
        }
        dir = up;
    }
    Ok(false)
}

/// `primaryTierTextOn(env, cwd)` with the DevSwarm Primary test already known true.
pub fn primary_tier_text_on(cx: &Cx<'_>, cwd: &str) -> R<bool> {
    if !devswarm_active(cx) || is_child_workspace(cx) {
        return Ok(false);
    }
    if !get_bool(cx.st, defaults::raw("command.tier_text_setting")) {
        return Ok(false);
    }
    Ok(!no_workspace_repo(cx, cwd)?)
}

/// The block reason of the heavy-command gate.
fn heavy_reason(cx: &Cx<'_>, command: &str) -> R<String> {
    let cwd = cx.payload.get("cwd").and_then(Value::as_str).unwrap_or("");
    let cls = classify_heavy(command, 0);
    let remote = cls.as_ref().is_some_and(|c| c.0);
    let detail = match &cls {
        Some((true, _, _)) => String::new(),
        Some((_, true, l)) => msg::render("command.msg_heavy_detail_verb", &[("label", l)]),
        Some((_, false, l)) => msg::render("command.msg_heavy_detail_category", &[("label", l)]),
        None => msg::render("command.msg_heavy_detail_category", &[("label", defaults::text("command.heavy_default_label"))]),
    };
    let devswarm_primary = devswarm_active(cx) && !is_child_workspace(cx);
    let mut cd_join_hint = String::new();
    if let Some(m) = re!(r"^(\s*cd\s+[^;&|\n]+?)\s*;").captures(command)
        && let (Some(whole), Some(head)) = (m.get(0), m.get(1))
    {
        let joined = format!("{} &&{}", head.as_str(), &command[whole.end()..]);
        if is_bounded_verification_command(cx, &joined, &Pcx::of(cx))? {
            cd_join_hint = defaults::text("command.msg_heavy_cd_hint").to_string();
        }
    }
    let tier_text = devswarm_primary && { if cwd.is_empty() { return Err(Unsure) } else { primary_tier_text_on(cx, cwd)? } };
    let codex = is_codex_payload(cx.payload);
    let what_kind = if remote { defaults::text("command.msg_heavy_remote") } else { defaults::text("command.msg_heavy_plain") };
    let what = msg::render("command.msg_heavy_what", &[("kind", what_kind), ("detail", &detail)]);
    let sub = if codex { defaults::text("command.codex_subagent") } else { defaults::text("command.claude_subagent") };
    let cheap = if codex { defaults::text("command.codex_cheap") } else { sub };
    let delegate = msg::render("command.msg_heavy_delegate", &[("to", cheap)]);
    let allowed = format!(
        "{}{}",
        defaults::text("command.msg_heavy_allowed"),
        if codex { defaults::text("command.msg_heavy_allowed_codex") } else { defaults::text("command.msg_heavy_allowed_claude") }
    );
    let instead_core = if tier_text { msg::render("command.msg_heavy_instead_tier", &[("delegate", &delegate), ("sub", sub)]) } else { format!("{delegate}.") };
    let instead = format!("{instead_core}{cd_join_hint}");
    Ok(msg::message(
        Kind::Block,
        defaults::text("command.guard_name"),
        &Parts { what: &what, why: defaults::text("command.msg_heavy_why"), instead: &instead, allowed: &allowed, override_: "", extra: &[] },
    ))
}

/// Stable-launcher light exceptions (`anchoredAntiHallStableLauncher`): the regexes this request's homes allow.
fn launcher_regexes(cx: &Cx<'_>, command: &str) -> R<Vec<Regex>> {
    if !command.to_ascii_lowercase().contains(defaults::text("command.launcher_marker")) {
        return Ok(Vec::new());
    }
    let mut homes: Vec<String> = Vec::new();
    match crate::checks::spawnctx::state_home(&cx.st.env) {
        crate::checks::spawnctx::Home::Ok(h) => homes.push(h),
        crate::checks::spawnctx::Home::Guarded => {}
        crate::checks::spawnctx::Home::Unknown => return Err(Unsure),
    }
    if let Some(p) = crate::checks::jsport::home::real_home().filter(|p| !p.is_empty() && !homes.contains(p)) {
        homes.push(p);
    }
    if homes.iter().any(|h| !h.is_ascii()) {
        return Err(Unsure);
    }
    let mut alt = String::from(r#"(?:~|"?\$\{HOME\}"?|\$HOME"#);
    for h in &homes {
        alt.push('|');
        alt.push_str(&regex::escape(h));
    }
    alt.push(')');
    Ok(defaults::list("command.launcher_scripts")
        .into_iter()
        .map(|s| {
            crate::checks::lit_re(&format!(r"(?i)^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*node\s+{alt}[\\/]\.anti-hall[\\/]bin[\\/]{}(?:\s|$)", regex::escape(s)))
        })
        .collect())
}

/// The decision for one Bash call. `Allow` and the block are exact; `Defer` hands the call to the Node hook.
pub fn evaluate(cx: &Cx<'_>, command: &str) -> Verdict {
    match decide(cx, command) {
        Ok(v) => v,
        Err(Unsure) => Verdict::Defer,
    }
}

fn decide(cx: &Cx<'_>, command: &str) -> R<Verdict> {
    if let Some(v) = special_guards(cx, command)? {
        return Ok(v);
    }
    let st = cx.st;
    if is_skipped(st, defaults::text("command.guard_name")) {
        return Ok(Verdict::Allow);
    }
    if !get_bool(st, defaults::raw("coordinator_work.command_guard_setting")) {
        return Ok(Verdict::Allow);
    }
    if !is_coordinator(cx) {
        return Ok(Verdict::Allow);
    }
    if let Some(v) = super::editpar::edit_parity(cx, command)? {
        return Ok(v);
    }
    let _launchers = super::heavy::set_launchers(launcher_regexes(cx, command)?);
    if !is_heavy_command(command, 0) {
        return Ok(Verdict::Allow);
    }
    let pc = Pcx::of(cx);
    if cx.setting_not_false("command.setting_allow_read_only_verify")? && is_bounded_verification_command(cx, command, &pc)? {
        return Ok(Verdict::Allow);
    }
    let cwd = cx.payload.get("cwd").and_then(Value::as_str).unwrap_or("");
    if cx.setting_not_false("command.setting_project_command_allow")?
        && let Some(pattern) = matched_project_command_allow(cx, command, cwd)?
    {
        append_allow_audit(cx, cwd, &pattern, command);
        return Ok(Verdict::Allow);
    }
    if cx.setting_not_false("command.setting_allow_plain_push")? && is_allowed_plain_push_chain(cx, command, cwd)? {
        return Ok(Verdict::Allow);
    }
    if cx.setting_not_false("command.setting_allow_bg_scratch")? && is_background_scratch_script(cx, command)? {
        return Ok(Verdict::Allow);
    }
    if cx.setting_not_false("command.setting_allow_gcloud_reads")? && is_allowed_gcloud_read_command(command)? {
        return Ok(Verdict::Allow);
    }
    let reason = heavy_reason(cx, command)?;
    Ok(Verdict::Exact(Exact::json_block(&reason)))
}
