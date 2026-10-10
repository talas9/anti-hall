//! The operator commands that were Node-only (D81, lane L9b), as `ah-engine` commands.
//!
//! | Command | Node source | What it does |
//! |---|---|---|
//! | `update` | `skills/update/scripts/update.js` | `git pull --ff-only` of the marketplace clone, cache sync, harness re-registration, changelog delta |
//! | `engine-update` | (new, issue #140) | runs the plugin's updater script `hooks/ah-update.sh`; the engine has no network code |
//! | `install-codex` | `codex/install-codex.js` | registers the anti-hall hooks in a Codex `hooks.json` and enables the hooks feature in `config.toml` |
//!
//! `doctor`, `migrate` (the port of `migrate-state.js`) and `capability-scan` were ported earlier (`doctor/`, `migrate/`,
//! `setup/`). The texts, paths, limits and patterns of both commands are in the plugin's `engine/defaults/update_cli.toml`.
pub mod engine_update;
pub mod install_codex;
pub mod postpull;
pub mod update;

use crate::defaults;
use std::io::Write;

/// Text on stdout without a line break added. A write failure (a closed pipe) is an error, never a panic.
pub(crate) fn out(text: &str) -> Result<(), String> {
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(text.as_bytes()).and_then(|()| stdout.flush()).map_err(|e| e.to_string())
}

/// One line on stderr. When stderr itself is closed there is nowhere left to report that.
pub(crate) fn warn(line: &str) {
    let mut stderr = std::io::stderr().lock();
    if stderr.write_all(line.as_bytes()).and_then(|()| stderr.write_all(b"\n")).is_err() {
        // stderr is closed: nothing can be reported any more
    }
}

/// The text shipped as `key`.
pub(crate) fn t(key: &str) -> &'static str {
    defaults::text(key)
}
