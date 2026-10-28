//! The injected directive text of a DevSwarm child workspace and the source of the stable launchers it names.
//!
//! The wording lives in `defaults/devswarm_role.toml` as templates; this file only fills in the run-time values, in one
//! pass, so a value that itself contains `{name}` is never filled a second time.
//!
//! Mirrors `hooks/devswarm-child-role.js` `buildAdditionalContext` (child branch), `hooks/lib/devswarm-wake.js`
//! (`wakeDirective`, `drainCmd`, `monitorArmLine`) and `hooks/lib/stable-launcher.js` `buildLauncherSource`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - serializing a string cannot fail
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;

/// Replace each `{name}` of `template` that `args` names, in one left-to-right pass; any other brace stays as written.
pub fn fill_once(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 256);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let tail = &rest[open + 1..];
        let hit = tail.find('}').and_then(|close| args.iter().find(|(n, _)| *n == &tail[..close]).map(|(_, v)| (close, *v)));
        match hit {
            Some((close, v)) => {
                out.push_str(v);
                rest = &tail[close + 1..];
            }
            None => {
                out.push('{');
                rest = tail;
            }
        }
    }
    out.push_str(rest);
    out
}

/// The run-time values of one child directive.
pub struct Child<'a> {
    /// The DevSwarm CLI path the commands name (the stable launcher or the plugin's own script).
    pub cli: &'a str,
    /// The mailbox watcher path the monitor line names.
    pub watcher: &'a str,
    /// The agent name, lower-cased and trimmed (empty when the agent is unknown: no wake text then).
    pub agent: &'a str,
    /// The workspace id the commands name (already validated, or the placeholder).
    pub id: &'a str,
    /// The validated cron schedule.
    pub cron: &'a str,
    /// `devswarm.rearmOnTickOnly`.
    pub tick_only: bool,
}

/// The mailbox-wake part of a child's directive (`wakeDirective`): empty when the agent is unknown.
pub fn wake_part(c: &Child<'_>) -> String {
    if c.agent.is_empty() {
        return String::new();
    }
    if c.agent == defaults::text("devswarm_role.claude_agent") {
        let expiry = defaults::text(if c.tick_only { "devswarm_role.msg_expiry_tick" } else { "devswarm_role.msg_expiry_inline" });
        fill_once(
            defaults::text("devswarm_role.msg_wake_claude"),
            &[("cli", c.cli), ("watcher", c.watcher), ("id", c.id), ("cron", c.cron), ("expiry", expiry)],
        )
    } else {
        fill_once(defaults::text("devswarm_role.msg_wake_other"), &[("cli", c.cli), ("id", c.id), ("agent", c.agent)])
    }
}

/// The whole `additionalContext` a child workspace gets at SessionStart.
pub fn child_context(c: &Child<'_>) -> String {
    let mut out = fill_once(defaults::text("devswarm_role.msg_base"), &[("cli", c.cli)]);
    out.push_str(&wake_part(c));
    out
}

/// The command agents run for every DevSwarm CLI verb: `devswarm_role.engine_cli` with the absolute home filled in.
pub fn engine_cli(home: &str) -> String {
    fill_once(defaults::text("devswarm_role.engine_cli"), &[("home", home)])
}

/// The command agents arm with `Monitor` for the mailbox watcher: `devswarm_role.engine_watcher` with the home filled in.
pub fn engine_watcher(home: &str) -> String {
    fill_once(defaults::text("devswarm_role.engine_watcher"), &[("home", home)])
}
