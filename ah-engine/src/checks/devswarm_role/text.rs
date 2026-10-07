//! The injected directive text of a DevSwarm child workspace and the source of the stable launchers it names.
//!
//! The wording lives in `defaults/devswarm_role.toml` as templates; this file only fills in the run-time values, in one
//! pass, so a value that itself contains `{name}` is never filled a second time.
//!
//! Mirrors `hooks/devswarm-child-role.js` `buildAdditionalContext` (child branch), `hooks/lib/devswarm-wake.js`
//! (`wakeDirective`, `drainCmd`, `monitorArmLine`) and `hooks/lib/stable-launcher.js` `buildLauncherSource`.
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

/// The whole `additionalContext` a child workspace gets at SessionStart.
pub fn child_context(c: &Child<'_>) -> String {
    let mut out = fill_once(defaults::text("devswarm_role.msg_base"), &[("cli", c.cli)]);
    if c.agent.is_empty() {
        return out;
    }
    if c.agent == defaults::text("devswarm_role.claude_agent") {
        let expiry = defaults::text(if c.tick_only { "devswarm_role.msg_expiry_tick" } else { "devswarm_role.msg_expiry_inline" });
        out.push_str(&fill_once(
            defaults::text("devswarm_role.msg_wake_claude"),
            &[("cli", c.cli), ("watcher", c.watcher), ("id", c.id), ("cron", c.cron), ("expiry", expiry)],
        ));
    } else {
        out.push_str(&fill_once(defaults::text("devswarm_role.msg_wake_other"), &[("cli", c.cli), ("id", c.id), ("agent", c.agent)]));
    }
    out
}

/// The source `buildLauncherSource(segments, fallback)` generates for the script at `target` (path parts joined by `/`)
/// whose absolute path at generation time is `fallback`.
pub fn launcher_source(target: &str, fallback: &str) -> String {
    let segments = serde_json::to_string(&target.split('/').collect::<Vec<_>>()).unwrap_or_default();
    let fallback = serde_json::to_string(fallback).unwrap_or_default();
    fill_once(defaults::text("devswarm_role.launcher_src"), &[("segments", &segments), ("fallback", &fallback)])
}
