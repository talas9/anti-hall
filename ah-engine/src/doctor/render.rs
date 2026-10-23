//! The statusline render check: does the statusline actually produce its two lines? The engine renders the statusline for a
//! sample session payload in this process (writing nothing) and the lines are counted, as the Node doctor does. No Node is
//! started: a render the engine leaves undecided is reported as a deferral, and the line-1 renderer is checked by its presence.
use super::Doc;
use crate::defaults;
use crate::migrate::Ctx;
use std::path::Path;

/// The statusline render and renderer checks; follows the configuration finding in the Statusline section.
pub fn statusline_render(doc: &mut Doc, ctx: &Ctx, root: Option<&Path>) {
    let Some(root) = root else { return };
    if !root.join(defaults::text("doctor.statusline_dispatcher")).exists() {
        doc.bad(defaults::text("doctor_msg.statusline_dispatcher_missing").to_string());
        return;
    }
    let sample = defaults::render("doctor.statusline_sample", &[("cwd", &serde_json::to_string(&ctx.cwd).unwrap_or_default())]);
    // the engine renders the statusline itself, in this process (nothing is spawned and no state is written)
    match crate::ops::statusline::render_text(sample.as_bytes(), &ctx.env, &ctx.home, &root.to_string_lossy(), &ctx.cwd) {
        Ok(text) => {
            let text = text.trim_end();
            let n = if text.is_empty() { 0 } else { text.split('\n').count() };
            if n >= defaults::num("doctor.statusline_min_lines") as usize {
                doc.ok(defaults::render("doctor_msg.statusline_renders", &[("n", &n)]));
            } else if n == 1 {
                doc.bad(defaults::text("doctor_msg.statusline_one_line").to_string());
            } else {
                doc.bad(defaults::render("doctor_msg.statusline_no_output", &[("code", &0)]));
            }
        }
        Err(_) => doc.warnl(defaults::render("doctor_msg.deferred", &[("check", &defaults::text("doctor.statusline_check"))])),
    }
    rich_check(doc, root);
}

/// The rich renderer is on disk.
fn rich_check(doc: &mut Doc, root: &Path) {
    if root.join(defaults::text("doctor.statusline_rich")).exists() {
        doc.ok(defaults::text("doctor_msg.statusline_rich_ok").to_string());
    } else {
        doc.warnl(defaults::text("doctor_msg.statusline_rich_bad").to_string());
    }
}
