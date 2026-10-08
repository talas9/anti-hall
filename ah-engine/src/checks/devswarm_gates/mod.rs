//! Built-in checks `devswarm-child-gate`, `devswarm-parent-reply-tracker` and `devswarm-child-drain`: the part of the three
//! DevSwarm hooks that can be decided exactly without the mailbox store or `scripts/devswarm.js`.
//!
//! What is decided here is only what the Node hook decides before it touches anything but the environment, the settings
//! files and the payload, and where it then says nothing and writes nothing:
//!
//! - `devswarm-child-gate` (Stop): the switch is off, a skip is recorded, DevSwarm is not active, or this is not a child
//!   workspace. The Node hook exits silently on each of these before it loads anything (`devswarm-primary-gate.js`
//!   `exitIfInert`); the answer is an allow, byte for byte what Node prints (nothing, exit 0).
//! - `devswarm-parent-reply-tracker` (PostToolUse, Bash): the switch is off, this is a child workspace, the payload is not
//!   an object, the tool is not Bash, or the command does not contain both the `devswarm` and `send` words. Node records
//!   nothing and prints nothing for each.
//! - `devswarm-child-drain` (PostToolUse, Bash): the switch is off, DevSwarm is not active, or this is not a child
//!   workspace (the same `exitIfInert`).
//!
//! Everything else defers to the Node hook, so it can never decide more weakly than Node (D74): the child gate keeps its
//! heartbeat and inbox state, the shared stop budgets, the store reads (reader cursors, unread counts), the
//! `hivecontrol workspace message-count` probe and the block text; the reply tracker keeps the reply-state file, the
//! send receipts and the repository key; the drain nudge keeps its throttle state and the unread count. Those need the
//! mailbox store or a spawn of `devswarm.js`, which the engine does not do until the mailbox moves in (D45).
//!
//! Mirrors `hooks/lib/devswarm-primary-gate.js`, `hooks/lib/devswarm-detect.js` `isDevswarmActive`,
//! `hooks/lib/devswarm-role.js` `isChildWorkspace` and the early exits of the three hooks' `main`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_enum, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

pub mod readside;

#[cfg(test)]
mod tests;

/// A non-empty environment string after JavaScript's `trim` (`nonEmpty`, and the child test of `isChildWorkspace`).
fn non_empty(st: &Settings, name: &str) -> bool {
    st.env.get(name).is_some_and(|v| !js_trim(v).is_empty())
}

/// This session is a DevSwarm child workspace: `DEVSWARM_SOURCE_BRANCH` is set and not blank.
///
/// Mirrors `devswarm-role.js` `isChildWorkspace`.
pub fn is_child(st: &Settings) -> bool {
    non_empty(st, defaults::text("devswarm_gates.source_branch_env"))
}

/// The DevSwarm integration is in play: not killed, and the mode is `on`, or `auto` with `DEVSWARM_REPO_ID` set.
///
/// Mirrors `devswarm-detect.js` `isDevswarmActive`.
pub fn devswarm_active(st: &Settings) -> bool {
    if st.env.get(defaults::text("devswarm_gates.kill_env")).is_some_and(|v| v == defaults::text("devswarm_gates.kill_env_value")) {
        return false;
    }
    let mode = get_enum(st, defaults::raw("devswarm_gates.supervisor_mode"));
    if mode == defaults::text("devswarm_gates.mode_off") {
        return false;
    }
    if mode == defaults::text("devswarm_gates.mode_on") {
        return true;
    }
    non_empty(st, defaults::text("devswarm_gates.repo_id_env"))
}

/// True when the byte before `i` (if any) and the byte at `j` (if any) are both not word characters: JavaScript's `\b`
/// on both sides of the span `i..j`, for a span that starts and ends with a word character. Only ASCII letters, digits and
/// `_` are word characters (no `u` flag), so every byte of a multi-byte character is a non-word byte.
fn bounded(b: &[u8], i: usize, j: usize) -> bool {
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    (i == 0 || !word(b[i - 1])) && (j >= b.len() || !word(b[j]))
}

/// `new RegExp('\\b' + word + '\\b', 'i').test(s)` for an ASCII word of letters.
///
/// The `i` flag without `u` folds only ASCII here (JavaScript does not fold U+017F or U+212A to ASCII letters in this mode,
/// which Rust's Unicode-aware `(?i)` would), so the comparison is on ASCII bytes. `devswarm(?:\.js)?` needs no extra case:
/// the optional `.js` can only be followed by a boundary where `devswarm` alone already is.
fn has_word(s: &str, word: &str) -> bool {
    let (b, w) = (s.as_bytes(), word.as_bytes());
    if w.is_empty() || b.len() < w.len() {
        return false;
    }
    (0..=b.len() - w.len()).any(|i| b[i..i + w.len()].eq_ignore_ascii_case(w) && bounded(b, i, i + w.len()))
}

/// The command plausibly invokes `devswarm.js send`: both words appear anywhere, in either order.
///
/// Mirrors `devswarm-parent-reply-tracker.js` `looksLikeDevswarmSend`.
pub fn looks_like_send(command: &str) -> bool {
    defaults::list("devswarm_gates.send_words").iter().all(|w| has_word(command, w))
}

/// `devswarm-primary-gate.js` `inert`: the hook would exit silently before doing anything (child role).
fn inert_for_child_hook(st: &Settings, switch: &str, guard: Option<&str>) -> bool {
    !get_bool(st, defaults::raw(switch)) || guard.is_some_and(|g| is_skipped(st, g)) || !devswarm_active(st) || !is_child(st)
}

/// What the child Stop gate says for a Stop payload. Never `None`: a stop the gate must not decide on its own defers.
pub fn decide_child_gate(st: &Settings) -> Verdict {
    if inert_for_child_hook(st, "devswarm_gates.child_gate_setting", Some(defaults::text("devswarm_gates.child_gate_guard_name"))) {
        Verdict::Allow
    } else {
        Verdict::Defer
    }
}

/// What the reply tracker says for a PostToolUse payload.
///
/// Mirrors `devswarm-parent-reply-tracker.js` `main` up to the first step that reads anything beyond the payload.
pub fn decide_reply_tracker(p: &Value, st: &Settings) -> Verdict {
    if !get_bool(st, defaults::raw("devswarm_gates.reply_tracker_setting")) || is_child(st) || !p.is_object() {
        return Verdict::Allow;
    }
    if p.get("tool_name").and_then(Value::as_str) != Some(defaults::text("devswarm_gates.bash_tool")) {
        return Verdict::Allow;
    }
    match p.get("tool_input").and_then(|t| t.get("command")).and_then(Value::as_str) {
        Some(c) if looks_like_send(c) => Verdict::Defer,
        _ => Verdict::Allow,
    }
}

/// What the child drain nudge says for a PostToolUse payload.
pub fn decide_child_drain(st: &Settings) -> Verdict {
    if inert_for_child_hook(st, "devswarm_gates.child_drain_setting", None) { Verdict::Allow } else { Verdict::Defer }
}

/// The registered `devswarm-child-gate` check.
pub struct DevswarmChildGate;

/// The registered `devswarm-parent-reply-tracker` check.
pub struct DevswarmParentReplyTracker;

/// The registered `devswarm-child-drain` check.
pub struct DevswarmChildDrain;

impl Check for DevswarmChildGate {
    fn name(&self) -> &'static str {
        "devswarm-child-gate"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_gates.child_gate_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, _payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide_child_gate(&Settings::from_env(env)))
    }
}

impl Check for DevswarmParentReplyTracker {
    fn name(&self) -> &'static str {
        "devswarm-parent-reply-tracker"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_gates.reply_tracker_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide_reply_tracker(payload, &Settings::from_env(env)))
    }
}

impl Check for DevswarmChildDrain {
    fn name(&self) -> &'static str {
        "devswarm-child-drain"
    }

    fn summary(&self) -> &'static str {
        defaults::text("devswarm_gates.child_drain_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(match decide_child_drain(&Settings::from_env(env)) {
            Verdict::Defer => {
                let root = opts.get("plugin_root").and_then(Value::as_str).or_else(|| env.get(defaults::env_name("plugin_root")));
                readside::child_drain(payload, env, root)
            }
            v => v,
        })
    }
}
