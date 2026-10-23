//! `ah-hook <verb> [args...]`: the thin client's command-line form. Any first argument that is not a hook event (events are
//! PascalCase, engine verbs are lowercase; `launcher.cli_lowercase_verbs`) is an engine command: the launcher replaces itself
//! with `ah-engine <verb> [args...]` (exec), so every exit code, every byte of stdin and stdout and every signal is the engine's
//! own. A `--plugin-root <dir>` pair added by the hook shim (first or last) is consumed here, never forwarded.
//!
//! When no engine can run the command, nothing else runs: one line (`msg.run_engine_missing`) goes to stderr and the exit is
//! `launcher.cli_no_engine_exit`.

use crate::cfg::Settings;
use crate::launcher::{self, LOG};
use crate::limits;
use crate::util::{env_nonempty, say};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn is_verb(s: &Settings, first: &str) -> bool {
    s.num("launcher.cli_lowercase_verbs") == 1 && first.starts_with(|c: char| c.is_ascii_lowercase())
}

/// The arguments to forward: everything but a leading or trailing `--plugin-root <dir>` pair.
pub fn forwarded(args: &[String]) -> Vec<String> {
    let mut a: &[String] = args;
    if a.first().is_some_and(|f| f == "--plugin-root") && a.len() >= 2 {
        a = &a[2..];
    }
    if a.len() >= 2 && a[a.len() - 2] == "--plugin-root" {
        a = &a[..a.len() - 2];
    }
    a.to_vec()
}

/// Replace this process with the engine running `args`. Returns only when that is impossible: the exit code to use.
pub fn exec_engine(s: &Settings, args: &[String], home: Option<&PathBuf>, plugin_root: Option<&Path>) -> i32 {
    let fwd = forwarded(args);
    let what = fwd.first().cloned().unwrap_or_default();
    let test = env_nonempty(&s.text("launcher.test_flag_env")).is_some_and(|v| v == "1");
    let knob = test.then(|| env_nonempty(&s.text("launcher.knob_engine_bin"))).flatten();
    let no_engine = |why: &str| {
        if let Some(l) = LOG.get() {
            l.append(&format!("cli_no_engine verb={what} why={why}"));
        }
        say(&s.msg("msg.run_engine_missing", &[("what", &what)]));
        s.num("launcher.cli_no_engine_exit") as i32
    };
    let Some(engine) = launcher::find_engine(home, s, knob) else {
        return no_engine("missing");
    };
    let mut cmd = Command::new(&engine);
    cmd.args(&fwd);
    let root_env = s.text("env.plugin_root");
    if let Some(r) = plugin_root
        && !root_env.is_empty()
        && env_nonempty(&root_env).is_none()
    {
        cmd.env(&root_env, r);
    }
    // the engine gets the process as the host started it: no launcher CPU limit, no blocked signals
    limits::restore_cpu_limit();
    launcher::unblock_signals();
    let err = cmd.exec();
    no_engine(&err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_shim_root_pair_is_not_forwarded() {
        assert_eq!(forwarded(&v(&["settings", "show", "--plugin-root", "/p"])), v(&["settings", "show"]));
        assert_eq!(forwarded(&v(&["--plugin-root", "/p", "settings"])), v(&["settings"]));
        assert_eq!(forwarded(&v(&["settings", "--plugin-root"])), v(&["settings", "--plugin-root"]));
        assert_eq!(forwarded(&v(&["doctor"])), v(&["doctor"]));
    }

    #[test]
    fn events_are_not_verbs() {
        let s = Settings::load(Path::new(""));
        assert!(is_verb(&s, "settings"));
        assert!(is_verb(&s, "jev-setup"));
        assert!(!is_verb(&s, "PreToolUse"));
        assert!(!is_verb(&s, "--selftest"));
        assert!(!is_verb(&s, ""));
    }
}
