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

/// `s` as one `sh` word in single quotes (nothing inside is expanded: `$`, a backtick and `\` stay literal; a `'` closes the quote,
/// is written escaped and reopens it).
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// `s` as one `sh` word: as it is when it holds only characters `sh` never treats specially, else [`sh_quote`]d (a home with a
/// space, `$` or a quote still runs; the usual path stays readable).
pub fn sh_word(s: &str) -> String {
    let plain = !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-./:@%+=,".contains(&b));
    if plain { s.to_string() } else { sh_quote(s) }
}

/// The command agents run for every DevSwarm CLI verb (`{cli}` in the texts): `devswarm_role.engine_cli` with the absolute home
/// filled in and the binary path shell-quoted when it needs it (the verb stays outside the quotes). Equal to the template for a home
/// that needs no quoting.
pub fn engine_cli(home: &str) -> String {
    format!("{} {}", sh_word(&engine_bin(home)), engine_verb())
}

/// The engine binary path alone (`devswarm_role.engine_bin`, home filled in): callers quote it, the verb stays outside the quotes.
pub fn engine_bin(home: &str) -> String {
    fill_once(defaults::text("devswarm_role.engine_bin"), &[("home", home)])
}

/// The verb after the engine binary for every DevSwarm CLI command (`devswarm_role.engine_verb`).
pub fn engine_verb() -> &'static str {
    defaults::text("devswarm_role.engine_verb")
}

/// The command agents arm with `Monitor` for the mailbox watcher: `devswarm_role.engine_watcher` with the home filled in.
pub fn engine_watcher(home: &str) -> String {
    fill_once(defaults::text("devswarm_role.engine_watcher"), &[("home", home)])
}

#[cfg(test)]
mod quote_tests {
    use super::*;

    fn init() {
        defaults::init().unwrap();
    }

    #[test]
    fn sh_word_leaves_a_plain_path_and_quotes_the_rest() {
        assert_eq!(sh_word("/Users/a/.anti-hall/bin/ah-engine"), "/Users/a/.anti-hall/bin/ah-engine");
        assert_eq!(sh_word("/Users/a b/x"), "'/Users/a b/x'");
        assert_eq!(sh_word("/Users/a$b/x"), "'/Users/a$b/x'");
        assert_eq!(sh_word("/Users/a`b/x"), "'/Users/a`b/x'");
        assert_eq!(sh_word("/Users/it's/x"), "'/Users/it'\\''s/x'");
        assert_eq!(sh_word(""), "''");
    }

    #[test]
    fn the_cli_in_every_directive_text_is_one_shell_word_for_a_home_with_a_space_dollar_or_backtick() {
        init();
        for home in ["/Users/a b", "/Users/a$b", "/Users/a`b"] {
            let cli = engine_cli(home);
            let bin = sh_quote(&engine_bin(home));
            assert_eq!(cli, format!("{bin} {}", engine_verb()), "{home}");
            let watcher = engine_watcher(home);
            for agent in ["claude", "codex"] {
                let c = Child { cli: &cli, watcher: &watcher, agent, id: "w1", cron: "*/5 * * * *", tick_only: true };
                let text = child_context(&c);
                assert!(text.contains(&format!("{cli} heartbeat")), "msg_base names the quoted cli for {home} / {agent}");
                assert!(text.contains(&format!("{cli} inbox ")), "the wake text names the quoted cli for {home} / {agent}");
                assert!(!text.contains(&format!("{} mesh", engine_bin(home))), "never the unquoted path: {home}");
            }
        }
    }

    #[test]
    fn a_plain_home_renders_the_cli_exactly_as_the_template_does() {
        init();
        assert_eq!(engine_cli("/h"), fill_once(defaults::text("devswarm_role.engine_cli"), &[("home", "/h")]));
    }
}
