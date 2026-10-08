//! The data-safety guards that command-guard runs before anything else, in every session context: the DevSwarm destructive-read
//! and native-send blocks, the raw inbox read block, the subagent mailbox block and the armed `git stash` block.
//!
//! Every function mirrors the Node function of the same name in `hooks/command-guard.js`; the block texts live in
//! `defaults/command.toml` and read the same words as the Node ones.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::cx::{Cx, R, Unsure};
use super::shell::{
    dequote_segment, effective_verb, extract_eval_payload, extract_shell_c_payload, extract_substitutions, split_segments, tokenize_quoted, trim,
};
use super::tables::tables;
use super::verify::re;
use crate::checks::git::tokenize::basename;
use crate::checks::guardkit::msg::{self, Kind, Parts};
use crate::checks::guardkit::paths as gp;
use crate::checks::guardkit::settings::{get_string, is_skipped};
use crate::checks::jsport::ident;
use crate::checks::{Exact, Verdict};
use crate::defaults;
use regex::Regex;

fn block(reason: &str) -> Verdict {
    Verdict::Exact(Exact::json_block(reason))
}

/// `isDevswarmActive(env)`.
pub fn devswarm_active(cx: &Cx<'_>) -> bool {
    crate::checks::spawnctx::devswarm_active(cx.st)
}

/// `isChildWorkspace(env)`: `DEVSWARM_SOURCE_BRANCH` set to something other than blanks.
pub fn is_child_workspace(cx: &Cx<'_>) -> bool {
    cx.env.get(defaults::text("command.child_env")).is_some_and(|v| !trim(v).is_empty())
}

/// `isSubagentByPayload(payload)`: an agent marker is present and not null.
fn subagent_by_payload(cx: &Cx<'_>) -> bool {
    cx.payload.is_object() && defaults::list("command.agent_markers").into_iter().any(|k| cx.payload.get(k).is_some_and(|v| !v.is_null()))
}

fn cli_re(sub: &str) -> Regex {
    crate::checks::lit_re(&format!(r"(?i)\b(?:hivecontrol|devswarm)\s+(?:-\S+\s+)*workspace\s+(?:-\S+\s+)*{sub}\b"))
}

fn monitor_re() -> &'static Regex {
    static C: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    C.get_or_init(|| cli_re("monitor"))
}
fn read_messages_re() -> &'static Regex {
    static C: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    C.get_or_init(|| cli_re("read-messages"))
}
fn message_child_re() -> &'static Regex {
    static C: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    C.get_or_init(|| cli_re("message-child"))
}
fn message_parent_re() -> &'static Regex {
    static C: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    C.get_or_init(|| cli_re("message-parent"))
}

/// `hivectlSegmentHasHelpFlag`.
fn has_help_flag(seg: &str) -> bool {
    tokenize_quoted(seg).iter().any(|t| t == "--help" || t == "-h")
}

/// The sub-expressions a command hides: `-c` payloads, `eval` payloads and substitutions, one level.
fn nested(seg: &str) -> Vec<String> {
    let mut v = Vec::new();
    let p = extract_shell_c_payload(seg);
    if !p.is_empty() {
        v.push(p);
    }
    let e = extract_eval_payload(seg);
    if !e.is_empty() {
        v.push(e);
    }
    v
}

/// `detectHivectlDestructiveRead`: `Some("monitor")`, `Some("read-messages")` or `None`.
fn detect_destructive_read(command: &str, d: usize) -> Option<&'static str> {
    if trim(command).is_empty() {
        return None;
    }
    let max = tables().max_depth;
    let mut saw_read = false;
    for seg in split_segments(command) {
        let dq = dequote_segment(&seg);
        if tables().devswarm_verbs.contains(&effective_verb(&dq)) && !has_help_flag(&seg) {
            if monitor_re().is_match(&dq) {
                return Some("monitor");
            }
            if read_messages_re().is_match(&dq) {
                saw_read = true;
            }
        }
        if d < max {
            for inner in nested(&seg) {
                match detect_destructive_read(&inner, d + 1) {
                    Some("monitor") => return Some("monitor"),
                    Some(_) => saw_read = true,
                    None => {}
                }
            }
        }
    }
    if d < max {
        for inner in extract_substitutions(command) {
            match detect_destructive_read(&inner, d + 1) {
                Some("monitor") => return Some("monitor"),
                Some(_) => saw_read = true,
                None => {}
            }
        }
    }
    saw_read.then_some("read-messages")
}

/// `detectHivectlMessageSend`.
fn detect_message_send(command: &str, d: usize) -> Option<&'static str> {
    if trim(command).is_empty() {
        return None;
    }
    let max = tables().max_depth;
    for seg in split_segments(command) {
        let dq = dequote_segment(&seg);
        if tables().devswarm_verbs.contains(&effective_verb(&dq)) && !has_help_flag(&seg) {
            if message_child_re().is_match(&dq) {
                return Some("message-child");
            }
            if message_parent_re().is_match(&dq) {
                return Some("message-parent");
            }
        }
        if d < max {
            for inner in nested(&seg) {
                if let Some(r) = detect_message_send(&inner, d + 1) {
                    return Some(r);
                }
            }
        }
    }
    if d < max {
        for inner in extract_substitutions(command) {
            if let Some(r) = detect_message_send(&inner, d + 1) {
                return Some(r);
            }
        }
    }
    None
}

fn mailbox_res() -> &'static [Regex; 5] {
    static C: crate::defaults::Cache<[Regex; 5]> = crate::defaults::Cache::new();
    C.get_or_init(|| {
        let (flag_skip, js_prefix) = (defaults::text("command.mailbox_flag_skip"), defaults::text("command.mailbox_js_prefix"));
        let alt = format!(r"(?:inbox\s+{flag_skip}(?:pull|ack|read-primary|drain-primary-legacy|read|tick)\b|heartbeat\b|reap-orphans\b|register(?:[^A-Za-z0-9_-]|$)|archive(?:[^A-Za-z0-9_-]|$))");
        let mk = |tail: &str| crate::checks::lit_re(&format!(r"(?i)\b{js_prefix}\s+{flag_skip}{tail}"));
        [
            mk(&alt),
            mk(&format!(r"inbox\s+{flag_skip}messages\b")),
            mk(&format!(r"mesh\s+{flag_skip}read\b")),
            mk(r"roster\b"),
            crate::checks::lit_re(r"(?i)--ack-as-owner\b|--ack\b"),
        ]
    })
}

/// `mailboxTouchInSegment`.
fn mailbox_touch_in_segment(dq: &str) -> bool {
    let r = mailbox_res();
    if r[0].is_match(dq) {
        return true;
    }
    if r[1].is_match(dq) && r[4].is_match(dq) {
        return true;
    }
    if r[2].is_match(dq) && !re!(r"(?i)--peek\b|--seq\b").is_match(dq) {
        return true;
    }
    r[3].is_match(dq) && re!(r"(?i)--ack\b").is_match(dq)
}

/// `detectSubagentMailboxTouch`.
fn detect_mailbox_touch(command: &str, d: usize) -> bool {
    if trim(command).is_empty() {
        return false;
    }
    let max = tables().max_depth;
    for seg in split_segments(command) {
        if mailbox_touch_in_segment(&dequote_segment(&seg)) {
            return true;
        }
        if d < max && nested(&seg).iter().any(|i| detect_mailbox_touch(i, d + 1)) {
            return true;
        }
    }
    d < max && extract_substitutions(command).iter().any(|i| detect_mailbox_touch(i, d + 1))
}

/// `mutatingGitStashInSegment`: the stash subcommand a segment runs, when it mutates.
fn mutating_git_stash_in_segment(seg: &str) -> Option<String> {
    if effective_verb(seg) != "git" {
        return None;
    }
    let tokens = tokenize_quoted(seg);
    let mut idx = tokens.iter().position(|t| basename(t).to_lowercase() == "git")?;
    idx += 1;
    let take_value = defaults::list("command.stash_global_value_opts");
    while idx < tokens.len() {
        let tok = &tokens[idx];
        if tok == "--" {
            idx += 1;
            break;
        }
        if !tok.starts_with('-') {
            break;
        }
        if re!(r"^--[A-Za-z-]+=").is_match(tok) {
            idx += 1;
            continue;
        }
        if take_value.contains(&tok.as_str()) {
            idx += 1;
            if idx < tokens.len() {
                idx += 1;
            }
            continue;
        }
        idx += 1;
    }
    if idx >= tokens.len() || tokens[idx].to_lowercase() != "stash" {
        return None;
    }
    idx += 1;
    let push_value = defaults::list("command.stash_push_value_flags");
    while idx < tokens.len() {
        let tok = &tokens[idx];
        if !tok.starts_with('-') {
            break;
        }
        if tok.starts_with("--message=") {
            idx += 1;
            continue;
        }
        if push_value.contains(&tok.as_str()) {
            idx += 1;
            if idx < tokens.len() {
                idx += 1;
            }
            continue;
        }
        idx += 1;
    }
    if idx >= tokens.len() {
        return Some("push".to_string());
    }
    let sub = tokens[idx].to_lowercase();
    if defaults::list("command.stash_read_subs").contains(&sub.as_str()) {
        return None;
    }
    defaults::list("command.stash_mutating_subs").contains(&sub.as_str()).then_some(sub)
}

/// `detectMutatingGitStash`.
fn detect_mutating_git_stash(command: &str, d: usize) -> Option<String> {
    if trim(command).is_empty() {
        return None;
    }
    let max = tables().max_depth;
    for seg in split_segments(command) {
        if let Some(h) = mutating_git_stash_in_segment(&seg) {
            return Some(h);
        }
        if d < max {
            for inner in nested(&seg) {
                if let Some(r) = detect_mutating_git_stash(&inner, d + 1) {
                    return Some(r);
                }
            }
        }
    }
    if d < max {
        for inner in extract_substitutions(command) {
            if let Some(r) = detect_mutating_git_stash(&inner, d + 1) {
                return Some(r);
            }
        }
    }
    None
}

/// `detectProtectedFileRead(command, home, cwd)`: the raw inbox read it finds, `Some(false)` never (a raw store read is not
/// decided here, see [`classify_path`]).
fn detect_protected_file_read(command: &str, home: &str, cwd: &str, d: usize) -> R<bool> {
    if trim(command).is_empty() {
        return Ok(false);
    }
    let max = tables().max_depth;
    let read_verbs = defaults::list("command.file_read_verbs");
    for seg in split_segments(command) {
        let verb = effective_verb(&seg);
        if !verb.is_empty() && read_verbs.contains(&verb.as_str()) {
            let tokens = tokenize_quoted(&seg);
            let mut idx = 0;
            while idx < tokens.len() && basename(&tokens[idx]).to_lowercase() != verb {
                idx += 1;
            }
            idx += 1;
            let mut skip_next = tables().pattern_first_verbs.contains(&verb);
            while idx < tokens.len() {
                let tok = &tokens[idx];
                idx += 1;
                if tok.is_empty() || tok.starts_with('-') {
                    continue;
                }
                if skip_next {
                    skip_next = false;
                    continue;
                }
                if classify_path(tok, home, cwd)? {
                    return Ok(true);
                }
            }
        }
        if d < max {
            for inner in nested(&seg) {
                if detect_protected_file_read(&inner, home, cwd, d + 1)? {
                    return Ok(true);
                }
            }
        }
    }
    if d < max {
        for inner in extract_substitutions(command) {
            if detect_protected_file_read(&inner, home, cwd, d + 1)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// `classifyDevswarmPath(raw, home, cwd)` for the inbox: `true` for `deny-inbox`. A path into the raw store that
/// `isStoreDenyTarget` accepts needs the store module's presence check, which the engine does not make: unsure.
fn classify_path(raw: &str, home: &str, cwd: &str) -> R<bool> {
    if raw.is_empty() {
        return Ok(false);
    }
    let abs = if gp::is_absolute(raw) {
        raw.to_string()
    } else {
        let base = if cwd.is_empty() { home } else { cwd };
        if !gp::is_absolute(base) {
            return Err(Unsure);
        }
        gp::resolve(base, raw)
    };
    let n_abs = abs.replace('\\', "/");
    let n_abs = n_abs.trim_end_matches('/');
    let root = gp::join(home, defaults::text("command.devswarm_root_rel")).replace('\\', "/");
    let n_root = root.trim_end_matches('/');
    if n_abs != n_root && !n_abs.starts_with(&format!("{n_root}/")) {
        return Ok(false);
    }
    let rel = if n_abs == n_root { "" } else { &n_abs[n_root.len() + 1..] };
    if rel.is_empty() {
        return Ok(false);
    }
    let seg = rel.split('/').next().unwrap_or("");
    if seg == defaults::text("command.devswarm_inbox_dir") {
        return Ok(true);
    }
    if seg == defaults::text("command.devswarm_store_dir") {
        let rest = rel.get(seg.len() + 1..).unwrap_or("");
        for pat in defaults::list("command.store_deny_patterns") {
            if crate::checks::lit_re(pat).is_match(rest) {
                return Err(Unsure);
            }
        }
    }
    Ok(false)
}

fn guard_msg(guard: &str, what: &str, why: &str, instead: &str, allowed: &str, override_: &str) -> String {
    msg::message(Kind::Block, guard, &Parts { what, why, instead, allowed, override_, extra: &[] })
}

fn read_reason(cx: &Cx<'_>, kind: &str) -> R<String> {
    let inbox_cmd = get_string(cx.st, defaults::raw("command.inbox_cmd_setting"));
    let base = defaults::text("command.msg_dsread_instead");
    let instead = if trim(&inbox_cmd).is_empty() { base.to_string() } else { format!("{}{base}", defaults::text("command.msg_dsread_inbox_cmd_prefix")) };
    let guard = defaults::text("command.dsread_guard");
    let override_ = defaults::text("command.msg_dsread_override");
    if kind == "monitor" {
        return Ok(guard_msg(
            guard,
            defaults::text("command.msg_dsread_monitor_what"),
            defaults::text("command.msg_dsread_monitor_why"),
            &instead,
            "",
            override_,
        ));
    }
    Ok(guard_msg(
        guard,
        defaults::text("command.msg_dsread_rm_what"),
        defaults::text("command.msg_dsread_rm_why"),
        &instead,
        defaults::text("command.msg_dsread_rm_allowed"),
        override_,
    ))
}

/// `hasProtectedStashesMarker(cwd)`.
fn has_protected_stashes_marker(cx: &Cx<'_>, cwd: &str) -> R<bool> {
    if !gp::is_absolute(cwd) {
        return Err(Unsure);
    }
    let c = ident::resolve_context(cwd, true, cx.env);
    if c.unsure {
        return Err(Unsure);
    }
    let Some(top) = c.toplevel else { return Ok(false) };
    Ok(std::fs::metadata(gp::join(&top, defaults::text("command.stash_marker_rel"))).is_ok())
}

/// The special guards in the order Node runs them. `Some(verdict)` is a block.
pub fn special_guards(cx: &Cx<'_>, command: &str) -> R<Option<Verdict>> {
    let active = devswarm_active(cx);
    let st = cx.st;
    if active && !is_skipped(st, defaults::text("command.dsread_guard")) {
        if let Some(kind) = detect_destructive_read(command, 0) {
            return Ok(Some(block(&read_reason(cx, kind)?)));
        }
        let cwd = cx.payload.get("cwd").and_then(serde_json::Value::as_str).unwrap_or("");
        let home = cx.home()?;
        if detect_protected_file_read(command, home, cwd, 0)? {
            let r = guard_msg(
                defaults::text("command.msg_rawread_inbox_guard"),
                defaults::text("command.msg_rawread_inbox_what"),
                defaults::text("command.msg_rawread_inbox_why"),
                defaults::text("command.msg_rawread_inbox_instead"),
                "",
                defaults::text("command.msg_rawread_override"),
            );
            return Ok(Some(block(&r)));
        }
    }
    if active
        && !is_skipped(st, defaults::text("command.dssend_guard"))
        && let Some(kind) = detect_message_send(command, 0)
    {
        let what = msg::render("command.msg_send_what", &[("kind", kind)]);
        let r = guard_msg(
            defaults::text("command.msg_send_guard"),
            &what,
            defaults::text("command.msg_send_why"),
            defaults::text("command.msg_send_instead"),
            "",
            defaults::text("command.msg_send_override"),
        );
        return Ok(Some(block(&r)));
    }
    if subagent_by_payload(cx)
        && !cx.setting_true("command.allow_subagent_mailbox_setting")?
        && !is_skipped(st, defaults::text("command.mailbox_guard"))
        && detect_mailbox_touch(command, 0)
    {
        let r = guard_msg(
            defaults::text("command.msg_mailbox_guard"),
            defaults::text("command.msg_mailbox_what"),
            defaults::text("command.msg_mailbox_why"),
            defaults::text("command.msg_mailbox_instead"),
            defaults::text("command.msg_mailbox_allowed"),
            defaults::text("command.msg_mailbox_override"),
        );
        return Ok(Some(block(&r)));
    }
    if !is_skipped(st, defaults::text("command.stash_guard"))
        && let Some(sub) = detect_mutating_git_stash(command, 0)
    {
        let cwd = cx.payload.get("cwd").and_then(serde_json::Value::as_str).unwrap_or("");
        let armed = has_protected_stashes_marker(cx, cwd)? || cx.setting_true("command.stash_guard_setting")?;
        if armed {
            let scope =
                if subagent_by_payload(cx) { defaults::text("command.msg_stash_scope_subagent") } else { defaults::text("command.msg_stash_scope_armed") };
            let what = msg::render("command.msg_stash_what", &[("sub", &sub), ("scope", scope)]);
            let r = guard_msg(
                defaults::text("command.stash_guard"),
                &what,
                defaults::text("command.msg_stash_why"),
                defaults::text("command.msg_stash_instead"),
                defaults::text("command.msg_stash_allowed"),
                "",
            );
            return Ok(Some(block(&r)));
        }
    }
    Ok(None)
}
