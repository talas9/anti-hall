//! The operator command-line tools that were Node-only (L9a), as `ah-engine` commands.
//!
//! | Command | Node source | What it does |
//! |---|---|---|
//! | `settings` | `scripts/settings.js` | show, get, set and reset any anti-hall setting; the opt-in judge switch; the project allowlist trust records |
//! | `defect` | `scripts/defect.js` | file, list, show, rule and archive defect reports; the bug-history import and queries |
//! | `statusline` | `statusline/statusline*.js` | the status line the host renders after each turn |
//!
//! Each command reproduces the script's text and `--json` output byte for byte and leaves the same files behind. The
//! parity tests (`tests/it/operator_parity.rs`) run the real Node script and the command on the same seeded scratch home and
//! compare both. The schema, the message texts and every limit are the plugin's own files (`engine/defaults/`), read at run
//! time; the settings schema is generated from `hooks/lib/settings-schema.js` (`parity/gen-settings-cli.js`).
//!
//! Where the Node tool's behaviour cannot be reproduced exactly (a lock held by a live writer, a repository layout the
//! resolver cannot classify) the command writes nothing, says so on stderr and exits with the deferral code, so the Node
//! command can be run instead.
pub mod allow;
pub mod settings;

use crate::cli::Parsed;
use crate::defaults;
use std::collections::BTreeMap;
use std::io::Write;

/// Text on stdout. A closed pipe has nobody left to tell, so the failure is dropped.
pub(crate) fn out(text: &str) {
    crate::discard::harmless(std::io::stdout().lock().write_all(text.as_bytes())); // keep: stdout closed, nowhere to report it
}

/// Text on stderr (same rule as [`out`]).
pub(crate) fn err(text: &str) {
    crate::discard::harmless(std::io::stderr().lock().write_all(text.as_bytes())); // keep: stderr closed, nowhere to report it
}

/// This process's environment, read once at the command line (a command-line process reads its own environment, D76).
pub(crate) fn env_snapshot() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

/// The home directory: `HOME`, else the account's (Node's `os.homedir()`).
pub(crate) fn home(env: &BTreeMap<String, String>) -> String {
    env.get(defaults::env_name("home"))
        .filter(|h| !h.is_empty())
        .cloned()
        .or_else(crate::checks::jsport::home::real_home)
        .unwrap_or_default()
}

/// The plugin root: the host's variable, else the root the engine's defaults were read from.
pub(crate) fn plugin_root(env: &BTreeMap<String, String>) -> Option<String> {
    env.get(defaults::env_name("plugin_root"))
        .filter(|r| !r.is_empty())
        .cloned()
        .or_else(|| defaults::root().map(|p| p.to_string_lossy().into_owned()))
}

/// The exit code a command returns when it leaves the work to the Node tool (nothing written).
pub(crate) fn defer_code() -> i32 {
    defaults::num("ops.defer_exit") as i32
}

/// `settings <verb> ...`
pub fn cmd_settings(p: &Parsed) -> i32 {
    settings::run(p)
}
