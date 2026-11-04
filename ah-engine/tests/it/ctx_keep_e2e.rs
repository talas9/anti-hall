//! The per-event context budget (plan v3 L12 / C2, `context.injectGateNoSpill`) end to end: real SessionStart and UserPromptSubmit
//! payloads through the dispatcher (`ah-engine hook --event <Event> --host claude|codex`, in-process), the real checks answering, a
//! scratch home and state directory.
//!
//! The shipped budgets (3000 and 9000 characters) are far above what a quiet session sends, so each test runs against a copy of the
//! plugin's `engine/defaults` whose `ctx_keep.toml` budget is small and whose `dispatch.context_pin_priority` is set per test (90 keeps verify-first
//! pinned and the task-tracker reminder droppable; 1000 pins nothing); the rest of the plugin is linked, not copied. That is exactly how a shipped TOML is tuned.
//!
//! * Switch on, contexts over the budget: the lowest-priority context is dropped, the highest stays, no pointer line is in the
//!   answer and no file is written to the context-spill directory.
//! * Switch on, contexts within the budget: the answer is the switch-off answer.
//! * Switch off: the answer carries the context the switch on drops.
//!
//! The counters are unit-tested in `src/dispatch/ctxkeep.rs` (`metrics::bumped_on_this_thread`): this dispatcher runs in a child
//! process, whose counters are not readable here. Each test has its own HOME, state directory and plugin root.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

struct Rig {
    dir: PathBuf,
}

impl Drop for Rig {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir)); // keep: a test directory; an absent one is the goal state
    }
}

impl Rig {
    fn new(name: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("ahd-ctxkeep-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("proj")).unwrap();
        Rig { dir }
    }

    /// A plugin root whose `engine/defaults/ctx_keep.toml` carries `budgets` (the `chars_by_event` table body) and whose pin
    /// priority is `pin`: everything else of the shipped plugin is linked.
    fn plugin(&self, budgets: &str, pin: u32) -> PathBuf {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall").canonicalize().unwrap();
        let root = self.dir.join("plugin");
        std::fs::create_dir_all(root.join("engine")).unwrap();
        for e in std::fs::read_dir(&src).unwrap().flatten() {
            if e.file_name() != "engine" {
                std::os::unix::fs::symlink(e.path(), root.join(e.file_name())).unwrap();
            }
        }
        for e in std::fs::read_dir(src.join("engine")).unwrap().flatten() {
            if e.file_name() != "defaults" {
                std::os::unix::fs::symlink(e.path(), root.join("engine").join(e.file_name())).unwrap();
            }
        }
        let defaults = root.join("engine/defaults");
        std::fs::create_dir_all(&defaults).unwrap();
        for e in std::fs::read_dir(src.join("engine/defaults")).unwrap().flatten() {
            std::fs::copy(e.path(), defaults.join(e.file_name())).unwrap();
        }
        let edit = |file: &str, from: &str, to: &str| {
            let p = defaults.join(file);
            let t = std::fs::read_to_string(&p).unwrap();
            assert!(t.contains(from), "{file} no longer holds {from}");
            std::fs::write(&p, t.replacen(from, to, 1)).unwrap();
        };
        edit("ctx_keep.toml", "{ SessionStart = 9000, UserPromptSubmit = 3000 }", budgets);
        edit(
            "dispatch.toml",
            "value = 80\nmin = 0\nmax = 1000\n\n[dispatch.context_priority]",
            &format!("value = {pin}\nmin = 0\nmax = 1000\n\n[dispatch.context_priority]"),
        );
        root
    }

    fn state(&self) -> PathBuf {
        self.dir.join("state")
    }

    /// One call through `hook --event <event> --host <host>`: (exit code, stdout, stderr).
    fn run(&self, host: &str, event: &str, plugin: &std::path::Path, on: bool) -> (i32, String, String) {
        let mut payload = json!({"hook_event_name": event, "session_id": "ctxkeep-s1", "cwd": self.dir.join("proj")});
        if event == "SessionStart" {
            payload["source"] = json!("startup");
        } else {
            payload["prompt"] = json!("please fix the failing build");
        }
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--host", host])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", plugin)
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", self.dir.join("home"))
            .env("AH_ENGINE_DIR", self.state())
            .env("AH_ENGINE_VERSION", "ctxkeep-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("CLAUDE_CODE_ENTRYPOINT", "cli")
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if on {
            c.env("ANTIHALL_CTX_NO_SPILL", "1");
        }
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).to_string(), String::from_utf8_lossy(&o.stderr).to_string())
    }

    /// Files in the context-spill directory of this rig's state directory.
    fn spill_files(&self) -> usize {
        std::fs::read_dir(self.state().join(ah_engine::defaults::text("dispatch.spill_dir"))).map_or(0, |d| d.flatten().count())
    }
}

fn context(out: &str) -> String {
    let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("not JSON ({e}): {out}"));
    v.pointer("/hookSpecificOutput/additionalContext").and_then(Value::as_str).unwrap_or("").to_string()
}

const TIGHT: &str = "{ SessionStart = 1, UserPromptSubmit = 1 }";
const WIDE: &str = "{ SessionStart = 100000, UserPromptSubmit = 100000 }";

/// One UserPromptSubmit through the real checks: over the budget the lower-priority task-tracker reminder (85) goes and the
/// verify-first reminder (95) stays; nothing is filed and no pointer is left. The switch off delivers both.
fn prompt_over_budget(host: &str) {
    let (off_rig, r) = (Rig::new(&format!("prompt-off-{host}")), Rig::new(&format!("prompt-{host}")));
    let plugin = r.plugin(TIGHT, 90);
    let (_, off, _) = off_rig.run(host, "UserPromptSubmit", &off_rig.plugin(TIGHT, 90), false);
    assert!(
        context(&off).contains("task tracker") && context(&off).contains("VERIFY-FIRST"),
        "{host}: both reminders are delivered with the switch off: {off}"
    );
    let (code, out, err) = r.run(host, "UserPromptSubmit", &plugin, true);
    assert_eq!((code, err.as_str()), (0, ""), "{host}: {out}");
    let ctx = context(&out);
    assert!(ctx.contains("VERIFY-FIRST") && !ctx.contains("task tracker"), "{host}: the lower priority goes, the higher stays: {ctx}");
    assert!(!ctx.contains("full text:") && !ctx.contains(ah_engine::defaults::text("dispatch.spill_dir")), "{host}: no pointer line: {ctx}");
    assert_eq!(r.spill_files(), 0, "{host}: no context file is written");
}

#[test]
fn ctx_keep_claude_user_prompt_submit_over_budget_drops_the_lower_priority_and_files_nothing() {
    prompt_over_budget("claude");
}

#[test]
fn ctx_keep_codex_user_prompt_submit_over_budget_drops_the_lower_priority_and_files_nothing() {
    prompt_over_budget("codex");
}

#[test]
fn ctx_keep_session_start_over_budget_drops_the_lower_priorities_and_files_nothing() {
    let (off_rig, r) = (Rig::new("start-off"), Rig::new("start"));
    let plugin = r.plugin(TIGHT, 1000);
    let (_, off, _) = off_rig.run("claude", "SessionStart", &off_rig.plugin(TIGHT, 1000), false);
    assert!(context(&off).len() > 1, "the switch off delivers a SessionStart context (else this proves nothing): {off}");
    let (code, out, err) = r.run("claude", "SessionStart", &plugin, true);
    assert_eq!((code, err.as_str()), (0, ""), "{out}");
    assert!(!out.contains(ah_engine::defaults::text("dispatch.spill_dir")) && !out.contains("full text:"), "no pointer line: {out}");
    assert_eq!(context(&out), "", "a 1 character budget leaves no context: {out}");
    assert_eq!(r.spill_files(), 0, "no context file is written");
}

#[test]
fn ctx_keep_within_budget_the_answer_is_the_switch_off_answer() {
    for (host, event) in [("claude", "UserPromptSubmit"), ("codex", "UserPromptSubmit")] {
        let off = Rig::new(&format!("within-off-{host}-{event}"));
        let on = Rig::new(&format!("within-on-{host}-{event}"));
        let (c0, out_off, e0) = off.run(host, event, &off.plugin(WIDE, 90), false);
        let (c1, out_on, e1) = on.run(host, event, &on.plugin(WIDE, 90), true);
        assert_eq!((c0, c1, e0.as_str(), e1.as_str()), (0, 0, "", ""), "{host} {event}");
        // the verify-first reminder rotates its sentence from call to call: compare everything else, paragraph by paragraph
        let rest = |o: &str| context(o).split("\n\n").filter(|p| !p.starts_with("VERIFY-FIRST")).map(str::to_string).collect::<Vec<_>>();
        assert_eq!(rest(&out_on), rest(&out_off), "{host} {event}: within the budget the switch changes nothing");
        assert!(!context(&out_on).is_empty(), "{host} {event}: there is a context to compare");
        assert_eq!(on.spill_files(), 0);
    }
}
