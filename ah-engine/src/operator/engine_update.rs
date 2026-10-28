//! `engine-update ...` (issue #140): hand the arguments to the thin client's updater (`ah-hook update ...`).
//!
//! The engine does no network access and carries no update logic: the thin client (`bin/ah-hook`, crate `ah-launcher`) downloads,
//! verifies, swaps and restarts, and works when this binary is broken. This command exists so the scheduler job and a user can say
//! `ah-engine engine-update --channel dev`. The client's file name, the verb and the texts are in `engine/defaults`.
use crate::cli::Parsed;
use crate::defaults;
use crate::paths;
use std::process::Command;

/// `engine-update <args>`: run the thin client's updater with the arguments exactly as typed and return its exit code.
pub fn run(p: &Parsed) -> i32 {
    let client = paths::dir().join(defaults::text("rollback.bin_dir")).join(defaults::text("rollback.client"));
    let shown = client.to_string_lossy().into_owned();
    if !client.is_file() {
        super::warn(&defaults::render("engine_update.msg_no_client", &[("path", &shown)]));
        return 1;
    }
    let env = crate::ops::env_snapshot();
    let mut cmd = Command::new(&client);
    if let Some(root) = crate::ops::plugin_root(&env) {
        cmd.arg("--plugin-root").arg(root);
    }
    match cmd.arg(defaults::text("launcher.cli_update_verb")).args(&p.raw).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(e) => {
            super::warn(&defaults::render("engine_update.msg_spawn_failed", &[("path", &shown), ("why", &e.to_string())]));
            1
        }
    }
}
