//! `ah-engine mcp-reaper run [--dry-run]`: the standalone MCP orphan reaper as an engine command, run every
//! `mcp_reaper.job_every_ms` by the scheduled job `mcp_reaper` (a subprocess in its own process group). Port of
//! `companion/mcp-reaper.js`, which the Node installer (`companion/install-reaper.js`) ran from its own launchd / systemd unit.
//!
//! This file holds no decision: the plugin script `engine/logic/rules/mcp-reaper.js` (D88) decides whether the reaper is on, which
//! processes are orphaned MCP servers and which still qualify after the grace period, and the host primitives (`ah.proc.*`) list,
//! wait and signal. The command prints the script's answer as one JSON line, writes one log line per action through the script,
//! and leaves one telemetry `cmd` event with the number of processes it signalled.
use crate::cli::Parsed;
use crate::defaults;
use serde_json::{Value, json};

/// The verb's handler.
pub fn run_cmd(p: &Parsed) -> i32 {
    let sub = p.rest.iter().find(|a| !a.starts_with("--")).map_or("", String::as_str);
    if sub != defaults::text("mcp_reaper.job_sub_run") {
        eprintln!("{}", defaults::text("mcp_reaper.job_msg_usage"));
        return 64;
    }
    let dry = p.rest.iter().any(|a| a == defaults::text("mcp_reaper.job_flag_dry"));
    let started = std::time::Instant::now();
    let (code, answer) = sweep(dry);
    let signalled = answer.get("termed").and_then(Value::as_array).map_or(0, Vec::len) as u64;
    crate::telemetry::emit::event(crate::telemetry::emit::command_run(&p.command, sub, code, started.elapsed().as_micros() as u64, signalled));
    if code != 0 {
        eprintln!("{}", defaults::text("mcp_reaper.job_msg_failed"));
    }
    println!("{answer}");
    code
}

/// One sweep through the plugin script: (exit code, the script's answer). No answer (the script is missing, scripts are off, or
/// the call failed) is exit 1, so the scheduler records a failed run.
pub fn sweep(dry: bool) -> (i32, Value) {
    let spec = defaults::raw("mcp_reaper.job_script");
    // the companion's own variables (MCP_REAP_DRYRUN, MCP_REAP_GRACE) are not request variables, so the command hands them in
    let args = json!({"dryRun": dry, "envDry": defaults::env_var("mcp_reap_dryrun"), "envGrace": defaults::env_var("mcp_reap_grace")});
    match crate::script::call_fn(spec.str_field("script"), spec.str_field("entry"), &args) {
        Some(v) if v.is_object() => (0, v),
        _ => (1, Value::Null),
    }
}
