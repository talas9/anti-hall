//! Built-in `check = "command"`: a port of the Node command-guard (PreToolUse on Bash), the most frequent Bash hook.
//!
//! What the engine decides, and why only that. command-guard's blocks depend on things the engine cannot see
//! exactly today: the hook's own environment (`CLAUDE_CODE_ENTRYPOINT` decides coordinator vs subagent, DevSwarm and
//! settings switches; the daemon only sees its own environment), the DevSwarm state files, edit-guard's verdict on a
//! written path, the repo's command allowlist, and git subprocesses for the plain-push carve-out. Its block reply is
//! also a stdout JSON line plus stderr, which the engine's block verdict cannot carry yet. So the engine answers only
//! the commands Node allows in EVERY context, and defers everything else to the Node hook (D11, D31):
//!
//! 1. no DevSwarm or stash trigger (`defer_substrings`, `defer_path_parts`): the DevSwarm read/send/mailbox guards
//!    and the git-stash guard cannot fire;
//! 2. no write target the edit-guard parity branch would judge ([`writes::may_write`]);
//! 3. not heavy ([`heavy::is_heavy_command`]).
//!
//! A payload that proves a subagent (agent markers, as the coordinator-work check reads them) needs only the first test:
//! Node returns exit 0 for a subagent right after the special guards. That test also runs on non-ASCII commands (see
//! `unicode_trigger_may_fire`); every other command with a non-ASCII character defers.
//!
//! A command that passes all three gets exit 0 with no output from Node whether the session is a coordinator or a
//! subagent, whatever the switches say, so the engine's Allow equals Node's answer exactly. Anything else (including
//! every non-ASCII command that is not from a proven subagent, see `shell`) is a deferral, never a guess.
pub mod heavy;
pub mod shell;
pub mod tables;
#[cfg(test)]
mod tests;
pub mod writes;

use crate::checks::{Check, Verdict};
use crate::rules::Subject;
use serde_json::Value;
use tables::tables;

/// True when a segment the DevSwarm read/send guards scan has a DevSwarm CLI as its effective verb: the same walk as
/// `detectHivectlDestructiveRead` / `detectHivectlMessageSend` (segments, `sh -c` and `eval` payloads, command
/// substitutions, three levels), with only their first condition (the verb) tested, so it finds every command they could
/// block and more.
fn devswarm_cli_in(cmd: &str, d: usize) -> bool {
    let t = tables();
    if shell::trim(cmd).is_empty() {
        return false;
    }
    for seg in shell::split_segments(cmd) {
        if t.devswarm_verbs.contains(&shell::effective_verb(&shell::dequote_segment(&seg))) {
            return true;
        }
        if d < t.max_depth {
            let p = shell::extract_shell_c_payload(&seg);
            if !p.is_empty() && devswarm_cli_in(&p, d + 1) {
                return true;
            }
            let e = shell::extract_eval_payload(&seg);
            if !e.is_empty() && devswarm_cli_in(&e, d + 1) {
                return true;
            }
        }
    }
    d < t.max_depth && shell::extract_substitutions(cmd).iter().any(|s| devswarm_cli_in(s, d + 1))
}

/// True when `text` has one of the `defer_path_parts` as a component. Splitting at more characters than a path
/// separator can only produce more pieces, and a component Node compares is free of all of them, so this is a superset.
fn has_path_part(text: &str) -> bool {
    let t = tables();
    text.to_lowercase()
        .split(|c: char| matches!(c, '/' | '\\' | ';' | '&' | '|' | '(' | ')' | '<' | '>' | '`' | '$' | '=' | '\'' | '"') || c.is_whitespace())
        .any(|piece| t.defer_path_parts.iter().any(|w| w == piece))
}

/// True when a DevSwarm or stash guard could act on this command (a superset of `detectHivectlDestructiveRead`,
/// `detectHivectlMessageSend`, `detectSubagentMailboxTouch`, `detectProtectedFileRead` and `detectMutatingGitStash`).
///
/// The mailbox and stash guards need their trigger word in the text they scan, which is always the command (or a part of
/// it) with quote characters removed; folding the case and removing backslashes too only finds more. The read/send
/// guards need a DevSwarm CLI verb ([`devswarm_cli_in`]). The raw-read guard resolves a path against the payload cwd and
/// denies only an `inbox` or `store` directory under the DevSwarm root, so that name must be a component of a word in
/// the command or of the cwd. Quote characters are removed before splitting, as the Node tokenizer joins quoted pieces.
fn special_guard_may_fire(cmd: &str, cwd: Option<&str>) -> bool {
    let t = tables();
    let norm: String = cmd.chars().filter(|c| !matches!(c, '\'' | '"' | '\\')).collect::<String>().to_lowercase();
    if t.defer_substrings.iter().any(|w| norm.contains(w.as_str())) {
        return true;
    }
    let unquoted: String = cmd.chars().filter(|c| !matches!(c, '\'' | '"')).collect();
    devswarm_cli_in(cmd, 0) || has_path_part(&unquoted) || has_path_part(cwd.unwrap_or(""))
}

/// True when `s` has a character whose JavaScript lower-casing yields ASCII (`\u{212A}` Kelvin sign becomes `k`, `\u{130}`
/// becomes `i` plus a combining dot), which could spell a trigger word out of text that does not contain it.
fn folds_to_ascii(s: &str) -> bool {
    s.chars().any(|c| matches!(c, '\u{212A}' | '\u{130}'))
}

/// [`special_guard_may_fire`] for text with non-ASCII characters. Every trigger is an ASCII word that Node finds as a
/// contiguous run of the text, so it is also a contiguous run once the non-ASCII characters are dropped (which can only
/// join more runs) or turned into blanks (which keeps the blanks JavaScript's `\s` would split at); the ASCII test runs
/// on both. A character that lower-cases to ASCII is a deferral. The working directory is only compared by path
/// component, which holds for any text.
fn unicode_trigger_may_fire(cmd: &str, cwd: Option<&str>) -> bool {
    if folds_to_ascii(cmd) {
        return true;
    }
    let dropped: String = cmd.chars().filter(char::is_ascii).collect();
    let blanked: String = cmd.chars().map(|c| if c.is_ascii() { c } else { ' ' }).collect();
    special_guard_may_fire(&dropped, cwd) || special_guard_may_fire(&blanked, cwd)
}

/// The command-guard decision for one Bash command: `Allow` when Node allows it in every context, else `Defer`.
///
/// Mirrors `command-guard.js` `main` (see the module doc for which answers are ported).
pub fn decide(cmd: &str, cwd: Option<&str>) -> Verdict {
    decide_in(cmd, cwd, false)
}

/// [`decide`] with what the payload proves about the caller. `subagent` is true when the payload alone proves a
/// subagent (`coordinator_work::subagent_by_payload`, the payload part of `coordinator-detect.js` `isCoordinator`).
/// `main` runs the DevSwarm and stash guards first; past them a subagent is always allowed (`if (!isCoordinator(...))
/// return io.decision(0)`), before the edit-parity branch and the heavy-command gate, so for a proven subagent only the
/// special-guard trigger test decides. Without the proof the three-part test of the module doc applies.
pub fn decide_in(cmd: &str, cwd: Option<&str>, subagent: bool) -> Verdict {
    let t = tables();
    if cmd.len() > t.max_len || cwd.is_some_and(folds_to_ascii) {
        return Verdict::Defer;
    }
    if !cmd.is_ascii() {
        // Only the trigger test can run on non-ASCII text (the other tests lean on JavaScript's UTF-16 indexing and wider
        // `\s`), so only a proven subagent is answered.
        return if subagent && !unicode_trigger_may_fire(cmd, cwd) { Verdict::Allow } else { Verdict::Defer };
    }
    if special_guard_may_fire(cmd, cwd) {
        return Verdict::Defer;
    }
    if subagent {
        return Verdict::Allow;
    }
    if writes::may_write(cmd, 0) || heavy::is_heavy_command(cmd, 0) {
        return Verdict::Defer;
    }
    Verdict::Allow
}

/// The registered `command` check: command-guard's PreToolUse decision for Bash commands (a port of
/// `command-guard.js`).
pub struct CommandGuard;

impl Check for CommandGuard {
    fn name(&self) -> &'static str {
        "command"
    }

    fn summary(&self) -> &'static str {
        tables().summary.as_str()
    }

    /// Like the Node guard, this reads `tool_input.command` whatever the event and tool (the rule chooses those); a
    /// command that is not a string is allowed, as Node treats it.
    fn run(&self, s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        let cmd = s.tool_input.get("command").and_then(Value::as_str)?;
        // the check never panics on purpose; a bug must not take a daemon worker down, so a panic defers to Node
        Some(std::panic::catch_unwind(|| decide(cmd, s.cwd)).unwrap_or(Verdict::Defer))
    }

    /// With the payload the check also knows whether it proves a subagent, which Node allows whatever the command is
    /// (past the special guards).
    fn run_payload(&self, s: &Subject<'_>, payload: &Value, _opts: &Value) -> Option<Verdict> {
        let cmd = s.tool_input.get("command").and_then(Value::as_str)?;
        let sub = crate::checks::coordinator_work::subagent_by_payload(payload);
        Some(std::panic::catch_unwind(|| decide_in(cmd, s.cwd, sub)).unwrap_or(Verdict::Defer))
    }
}
