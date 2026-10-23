//! Stage 2 of the Node backup: the fallback switch. `ah-engine fallback node|off|status`.
//!
//! The switch is the marker file `files.fallback_switch` in the state directory. While it exists, `hooks/ah-hook.sh` (and the thin
//! launcher it hands over to) run the original Node hooks directly instead of the engine, and write their verdicts to the shadow
//! ledger with source `node`. The shipped default `nodeback.fallback` can also say `node`; the marker is the runtime switch and
//! never flips by itself.
use crate::cli::Parsed;
use crate::defaults;
use serde_json::json;

/// Whether the fallback is on: the marker exists, or the shipped default says `node`.
pub fn effective() -> bool {
    super::state_file("files.fallback_switch").exists()
        || defaults::text("nodeback.fallback") == defaults::list("nodeback.fallback_choices").first().copied().unwrap_or_default()
}

/// `fallback <node|off|status>`
pub fn run(p: &Parsed) -> i32 {
    let words = defaults::list("nodeback.fallback_choices");
    let w = |i: usize| words.get(i).copied().unwrap_or_default();
    let word = p.rest.first().map(String::as_str).unwrap_or_default();
    let marker = super::state_file("files.fallback_switch");
    let shown = marker.to_string_lossy().into_owned();
    let say = |text: String| crate::ops::out(&format!("{text}\n"));
    let fail = |e: std::io::Error| {
        crate::ops::err(&format!("{}\n", defaults::render("nodeback.msg_fallback_write_failed", &[("file", &shown), ("err", &e)])));
        1
    };
    if word == w(0) {
        let made = crate::limits::ensure_private_dir(&crate::paths::dir())
            .map_err(std::io::Error::other)
            .and_then(|()| crate::atomic::write(&marker, format!("{word}\n")));
        if let Err(e) = made {
            return fail(e);
        }
        crate::health::log_event(defaults::text("nodeback.log_kind"), word, &defaults::render("nodeback.msg_fallback_on", &[("file", &shown)]));
        say(defaults::render("nodeback.msg_fallback_on", &[("file", &shown)]));
        if super::node_dir("claude").is_none() {
            let dir = defaults::text("nodeback.node_dir").to_string();
            say(defaults::render("nodeback.msg_no_node_dir", &[("dir", &dir)]));
        }
        0
    } else if word == w(1) {
        match std::fs::remove_file(&marker) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return fail(e),
        }
        crate::health::log_event(defaults::text("nodeback.log_kind"), word, defaults::text("nodeback.msg_fallback_off"));
        say(defaults::text(if defaults::text("nodeback.fallback") == w(0) { "nodeback.msg_fallback_still_node" } else { "nodeback.msg_fallback_off" })
            .to_string());
        0
    } else if word == w(2) {
        let (state, has) = (if effective() { w(0) } else { w(1) }, marker.exists());
        if p.json {
            say(json!({"state": state, "marker": has, "default": defaults::text("nodeback.fallback"), "file": shown}).to_string());
        } else {
            say(defaults::render(
                "nodeback.msg_fallback_status",
                &[("state", &state), ("marker", &if has { "yes" } else { "no" }), ("default", &defaults::text("nodeback.fallback"))],
            ));
        }
        0
    } else {
        crate::ops::err(&format!("{}\n", defaults::text("nodeback.msg_fallback_usage")));
        64
    }
}
