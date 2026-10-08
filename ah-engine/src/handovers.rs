//! `ah-engine handovers index|check|search`: the command-line face of the handover brief tree.
//!
//! This holds no rule: what a handover is, how it is read, what the briefs contain, what counts as a problem and how a search
//! ranks are all the plugin script `engine/logic/handover-hygiene.js` and `defaults/handovers.toml`. The command only hands
//! the script its working directory and arguments (with the larger time limit of the `Cli` event) and relays its exit code
//! and output. The scheduled job `handovers` runs the same command as a subprocess.
use crate::checks::Verdict;
use crate::cli::Parsed;
use crate::defaults;
use crate::reqenv::RequestEnv;
use serde_json::json;

/// `handovers <verb> [args]`: run the script and relay its answer.
pub fn run_cmd(p: &Parsed) -> i32 {
    let cwd = std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default();
    let payload = json!({"cwd": cwd, "args": p.rest, "json": p.json});
    let event = defaults::text("handovers.cli_event");
    match crate::script::run_forced(defaults::text("handovers.guard_name"), &payload, &serde_json::Value::Null, event, &RequestEnv::capture()) {
        Some(Some(Verdict::Exact(x))) => {
            print!("{}", x.out);
            eprint!("{}", x.err);
            x.code
        }
        other => {
            let why = format!("{other:?}");
            eprintln!("{}", defaults::render("handovers.msg_script_failed", &[("why", &why)]));
            1
        }
    }
}
