//! `engine-update ...` (issue #140): run the plugin's updater script with the arguments given.
//!
//! The engine does no network access and carries no update logic: `hooks/ah-update.sh` (POSIX sh, shipped in the plugin) downloads,
//! verifies, swaps and restarts, and works when this binary is broken. This command exists so the scheduler job and a user can say
//! `ah-engine engine-update --channel dev`. The script path, the shell and the texts are in `engine/defaults/engine_update.toml`.
use crate::cli::Parsed;
use crate::defaults;
use std::process::Command;

/// `engine-update <args>`: exec the script with the arguments exactly as typed and return its exit code.
pub fn run(p: &Parsed) -> i32 {
    let env = crate::ops::env_snapshot();
    let Some(root) = crate::ops::plugin_root(&env) else {
        super::warn(&defaults::render("engine_update.msg_no_plugin", &[("script", &defaults::text("engine_update.script"))]));
        return 1;
    };
    let script = std::path::Path::new(&root).join(defaults::text("engine_update.script"));
    let shown = script.to_string_lossy().into_owned();
    if !script.is_file() {
        super::warn(&defaults::render("engine_update.msg_no_script", &[("path", &shown)]));
        return 1;
    }
    match Command::new(defaults::text("engine_update.shell")).arg(&script).args(&p.raw).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            super::warn(&defaults::render("engine_update.msg_spawn_failed", &[("path", &shown), ("why", &e.to_string())]));
            1
        }
    }
}
