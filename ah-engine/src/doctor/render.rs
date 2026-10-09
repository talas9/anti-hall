//! The statusline render check: does the statusline actually produce its two lines? The engine renders the statusline for a
//! sample session payload in this process (writing nothing; the Node dispatcher renders it when the engine leaves it to Node, and
//! a stand-in script under Node when the test override names one) and the lines are counted, as the Node doctor does.
use super::Doc;
use crate::defaults;
use crate::migrate::Ctx;
use crate::ops::statusline::util::{Finished, run_with_input_detail};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The first executable named `name` on the run's PATH.
fn on_path(ctx: &Ctx, name: &str) -> Option<PathBuf> {
    super::system::which(name, ctx.env.get("PATH").map(String::as_str).unwrap_or(""))
}

/// `node --check <file>`: whether Node accepts the file's syntax. `None` when there is no Node to ask.
fn node_accepts(ctx: &Ctx, file: &Path) -> Option<bool> {
    let node = on_path(ctx, defaults::text("doctor.node_default"))?;
    let mut cmd = Command::new(node);
    cmd.arg(defaults::text("doctor.node_check_flag")).arg(file).env_clear().envs(&ctx.env);
    let run =
        crate::proc::run(cmd, defaults::text("doctor.probe_label"), defaults::millis("doctor.probe_timeout_ms"), defaults::millis("doctor.probe_poll_ms"));
    Some(run.is_ok_and(|o| o.status.success()))
}

/// Node running a script with the sample payload: the test override's stand-in, or the Node dispatcher when the engine leaves the
/// render to it.
fn node_render(ctx: &Ctx, root: &Path, script: &str, sample: &[u8], timeout: std::time::Duration) -> Finished {
    let Some(node) = on_path(ctx, defaults::text("doctor.node_default")) else { return Finished::Failed };
    let mut cmd = Command::new(node);
    cmd.arg(script).env_clear().envs(&ctx.env).env(defaults::env_name("plugin_root"), root).current_dir(&ctx.cwd);
    run_with_input_detail(cmd, sample, timeout, defaults::num("doctor.statusline_max_bytes") as usize)
}

/// The statusline render and renderer checks; follows the configuration finding in the Statusline section.
pub fn statusline_render(doc: &mut Doc, ctx: &Ctx, root: Option<&Path>) {
    let Some(root) = root else { return };
    let script_env = ctx.env.get(defaults::text("doctor.statusline_script_env")).filter(|s| !s.is_empty()).cloned();
    let dispatcher = root.join(defaults::text("doctor.statusline_dispatcher"));
    let present = match &script_env {
        Some(s) => Path::new(s).exists(),
        None => dispatcher.exists(),
    };
    if !present {
        doc.bad(defaults::text("doctor_msg.statusline_dispatcher_missing").to_string());
        return;
    }
    let timeout_ms = ctx
        .env
        .get(defaults::text("doctor.statusline_timeout_env"))
        .and_then(|v| crate::setup::jsfmt::parse_int(v))
        .filter(|n| *n != 0.0)
        .map_or_else(|| defaults::num("doctor.statusline_timeout_ms"), |n| n as u64);
    let timeout = std::time::Duration::from_millis(timeout_ms);
    let sample = defaults::render("doctor.statusline_sample", &[("cwd", &serde_json::to_string(&ctx.cwd).unwrap_or_default())]);
    // the engine renders the statusline itself, in this process (nothing is spawned and no state is written); what it leaves
    // to the Node dispatcher is rendered by that, as the host would
    let finished = match &script_env {
        Some(s) => node_render(ctx, root, s, sample.as_bytes(), timeout),
        None => match crate::ops::statusline::render_text(sample.as_bytes(), &ctx.env, &ctx.home, &root.to_string_lossy(), &ctx.cwd) {
            Ok(text) => Finished::Done { code: Some(0), stdout: text.into_bytes() },
            Err(_) => node_render(ctx, root, &dispatcher.to_string_lossy(), sample.as_bytes(), timeout),
        },
    };
    match finished {
        Finished::Done { code: Some(0), stdout } => {
            let text = String::from_utf8_lossy(&stdout).trim_end().to_string();
            let n = if text.is_empty() { 0 } else { text.split('\n').count() };
            if n >= defaults::num("doctor.statusline_min_lines") as usize {
                doc.ok(defaults::render("doctor_msg.statusline_renders", &[("n", &n)]));
            } else if n == 1 {
                doc.bad(defaults::text("doctor_msg.statusline_one_line").to_string());
            } else {
                doc.bad(defaults::render("doctor_msg.statusline_no_output", &[("code", &0)]));
            }
        }
        Finished::Done { code, .. } => doc.bad(defaults::render(
            "doctor_msg.statusline_no_output",
            &[("code", &code.map_or(defaults::text("doctor.no_exit_code").to_string(), |c| c.to_string()))],
        )),
        Finished::TimedOut => doc.warnl(defaults::text("doctor_msg.statusline_timeout").to_string()),
        Finished::Failed => doc.bad(defaults::render("doctor_msg.statusline_no_output", &[("code", &defaults::text("doctor.no_exit_code"))])),
    }
    let rich = root.join(defaults::text("doctor.statusline_rich"));
    if rich.exists() && node_accepts(ctx, &rich).unwrap_or(true) {
        doc.ok(defaults::text("doctor_msg.statusline_rich_ok").to_string());
    } else {
        doc.warnl(defaults::text("doctor_msg.statusline_rich_bad").to_string());
    }
}
