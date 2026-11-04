//! The role note is one factual line for a subagent, and the task tracker words its directive, reminder and open-tasks line
//! factually (no capitals, at most two lines, one reason clause); each message has its own counters, and each change has a switch.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn plugin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall")
}

struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(tag: &str) -> Self {
        let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("reword-{tag}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall")).unwrap();
        std::fs::create_dir_all(dir.join("home/proj")).unwrap();
        Scratch { dir }
    }

    fn cmd(&self, args: &[&str], env: &[(&str, &str)]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("AH_ENGINE_PLUGIN_ROOT", plugin())
            .env("CLAUDE_PLUGIN_ROOT", plugin())
            .envs(env.iter().copied())
            .current_dir(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

fn sub_start() -> Value {
    json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "SubagentStart", "agent_id": "a1", "agent_type": "general-purpose"})
}

const ROLE_SW: &str = "ANTIHALL_ROLE_NOTE_SHORT";
const TT_SW: &str = "ANTIHALL_TASK_TRACKER_TERSE";
/// Every test runs with the switch set explicitly, on and off, and with the prompt gates quiet, so the text is the only variable.
const QUIET: [(&str, &str); 3] = [("ANTIHALL_INJECT_GATE", "0"), ("ANTIHALL_PROMPT_DIGEST", "0"), ("AH_ENGINE_DISPATCH_IN_PROCESS", "1")];

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (p, q) = (e.path(), to.join(e.file_name()));
        if p.is_dir() {
            copy_tree(&p, &q);
        } else {
            std::fs::copy(&p, &q).unwrap();
        }
    }
}

/// A plugin copy whose TOML text keys the test edits (the owner's customization), and the real `ah-engine hook` run against it.
struct Plug {
    s: Scratch,
    root: PathBuf,
    runs: std::cell::Cell<u32>,
}

impl Plug {
    /// `edits`: (file, table, stock text, replacement) - the stock text is replaced inside that table's `value` line only.
    fn new(tag: &str, edits: &[(&str, &str, &str, &str)]) -> Self {
        let s = Scratch::new(tag);
        let root = s.dir.join("plugin");
        copy_tree(&plugin().join("engine"), &root.join("engine"));
        copy_tree(&plugin().join("hooks"), &root.join("hooks"));
        for (file, table, from, to) in edits {
            let path = root.join("engine/defaults").join(file);
            let src = std::fs::read_to_string(&path).unwrap();
            let (mut out, mut inside, mut done) = (String::new(), false, false);
            for line in src.lines() {
                if line.trim() == format!("[{table}]") {
                    inside = true;
                } else if line.starts_with('[') {
                    inside = false;
                }
                if inside && !done && line.starts_with("value = ") {
                    assert!(line.contains(from), "{file} [{table}]: stock text {from:?} not in {line}");
                    out.push_str(&line.replacen(from, to, 1));
                    done = true;
                } else {
                    out.push_str(line);
                }
                out.push('\n');
            }
            assert!(done, "{file}: no table [{table}]");
            std::fs::write(&path, out).unwrap();
        }
        Plug { s, root, runs: std::cell::Cell::new(0) }
    }

    /// One real hook call on a fresh HOME (or on `home`'s state when given); returns the model-visible text.
    fn hook(&self, event: &str, host: &str, payload: &Value, env: &[(&str, &str)]) -> String {
        self.hook_in(&format!("h{}", self.runs.get()), event, host, payload, env)
    }

    fn hook_in(&self, home: &str, event: &str, host: &str, payload: &Value, env: &[(&str, &str)]) -> String {
        self.runs.set(self.runs.get() + 1);
        let h = self.s.dir.join(home);
        std::fs::create_dir_all(h.join(".anti-hall")).unwrap();
        std::fs::create_dir_all(h.join("proj")).unwrap();
        let mut c = self.s.cmd(&["hook", "--event", event, "--host", host], env);
        c.env("HOME", &h).env("AH_ENGINE_PLUGIN_ROOT", &self.root).env("CLAUDE_PLUGIN_ROOT", &self.root);
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        let err = String::from_utf8_lossy(&o.stderr).into_owned();
        assert_eq!(o.status.code(), Some(0), "{event}/{host}: {err}");
        let out = String::from_utf8_lossy(&o.stdout).into_owned();
        let mut text = match serde_json::from_str::<Value>(out.trim()) {
            Ok(v) => v.pointer("/hookSpecificOutput/additionalContext").and_then(Value::as_str).map_or(out.clone(), str::to_string),
            Err(_) => format!("{out}{err}"),
        };
        // a context over the inline cap is spilled to a file the notice names; the model reads it, so the test does too
        if let Some(i) = text.find("Read it with the Read tool: ") {
            let rest = text[i + "Read it with the Read tool: ".len()..].to_string();
            if let Some(end) = rest.find(".txt") {
                text.push('\n');
                text.push_str(&std::fs::read_to_string(&rest[..end + 4]).unwrap_or_default());
            }
        }
        text
    }

    fn home(&self, name: &str) -> PathBuf {
        self.s.dir.join(name)
    }
}

fn env_of<'a>(sw: &'a str, value: &'a str, more: &[(&'a str, &'a str)]) -> Vec<(&'a str, &'a str)> {
    let mut e = QUIET.to_vec();
    e.push((sw, value));
    e.extend_from_slice(more);
    e
}

fn codex_start() -> Value {
    json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "SessionStart"})
}

const STOCK_NOTE_HEAD: &str = "Engine verbs you may run:";
const SHORT_SUB: &str = "anti-hall engine: role subagent (one assigned job, report back). Engine guide: /anti-hall:engine.";

#[test]
fn a_subagent_gets_the_full_note_when_the_switch_is_off_and_one_factual_line_when_it_is_on() {
    let p = Plug::new("role", &[]);
    let off = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, "0", &[]));
    assert!(off.contains("(role: subagent)") && off.contains(STOCK_NOTE_HEAD), "off: the full note: {off}");
    let sub = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, "1", &[]));
    assert!(sub.contains(SHORT_SUB), "on: the one-line note: {sub}");
    assert!(!sub.contains(STOCK_NOTE_HEAD), "on: no verb list: {sub}");
    let main = p.hook("SessionStart", "claude", &codex_start(), &env_of(ROLE_SW, "1", &[]));
    assert!(main.contains("(role: main)") && main.contains(STOCK_NOTE_HEAD), "the main session keeps its full note: {main}");
}

// ---- role note: the one-line form is an extra default; an edited text key is honoured with the switch on AND off ----

#[test]
fn an_edited_note_text_is_used_as_written_with_the_switch_on_and_off() {
    let p = Plug::new("rn-msg", &[("roles.toml", "roles.msg_note", "anti-hall engine: you are", "EDITED NOTE: you are")]);
    for sw in ["0", "1"] {
        let out = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, sw, &[]));
        assert!(out.contains("EDITED NOTE: you are a subagent or background task") && out.contains(STOCK_NOTE_HEAD), "switch {sw}: {out}");
        assert!(!out.contains(SHORT_SUB), "switch {sw}: the one-line note must not replace an edited note: {out}");
    }
}

#[test]
fn an_edited_role_description_is_used_as_written_with_the_switch_on_and_off() {
    let p = Plug::new("rn-desc", &[("roles.toml", "roles.describe", "does one assigned job and reports back", "EDITED DESCRIPTION")]);
    for sw in ["0", "1"] {
        let out = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, sw, &[]));
        assert!(out.contains("EDITED DESCRIPTION") && out.contains(STOCK_NOTE_HEAD), "switch {sw}: {out}");
        assert!(!out.contains(SHORT_SUB), "switch {sw}: {out}");
    }
}

#[test]
fn an_edited_description_of_another_role_leaves_the_subagent_one_line_note_alone() {
    let p = Plug::new("rn-other", &[("roles.toml", "roles.describe", "works on its own task and reports through the mesh", "EDITED WORKSPACE")]);
    let on = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, "1", &[]));
    assert!(on.contains(SHORT_SUB), "{on}");
    let off = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, "0", &[]));
    assert!(off.contains(STOCK_NOTE_HEAD) && !off.contains(SHORT_SUB), "{off}");
}

#[test]
fn an_edited_one_line_note_and_role_summary_are_used_when_the_switch_is_on_only() {
    let p = Plug::new(
        "rn-short",
        &[
            ("roles.toml", "roles.msg_note_short", "anti-hall engine: role", "EDITED SHORT: role"),
            ("roles.toml", "roles.describe_short", "one assigned job, report back", "EDITED SUMMARY"),
        ],
    );
    let on = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, "1", &[]));
    assert!(on.contains("EDITED SHORT: role subagent (EDITED SUMMARY)"), "{on}");
    let off = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, "0", &[]));
    assert!(off.contains(STOCK_NOTE_HEAD) && !off.contains("EDITED"), "{off}");
}

#[test]
fn a_lowered_note_limit_keeps_the_limited_full_note_instead_of_the_longer_one_line_note() {
    let p = Plug::new("rn-max", &[("roles.toml", "roles.note_max", "900", "60")]);
    for sw in ["0", "1"] {
        let out = p.hook("SubagentStart", "claude", &sub_start(), &env_of(ROLE_SW, sw, &[]));
        assert!(out.contains("(role: subagent)") && !out.contains(SHORT_SUB), "switch {sw}: {out}");
    }
}

#[test]
fn the_codex_main_seat_keeps_its_full_note_and_an_edited_codex_note_is_honoured_on_and_off() {
    let plain = Plug::new("rn-codex", &[]);
    for sw in ["0", "1"] {
        let out = plain.hook("SessionStart", "codex", &codex_start(), &env_of(ROLE_SW, sw, &[]));
        assert!(out.contains(STOCK_NOTE_HEAD) && !out.contains("anti-hall engine: role "), "switch {sw}: {out}");
    }
    let edited = Plug::new("rn-codex-ed", &[("roles.toml", "roles.msg_note", "Full guide:", "EDITED GUIDE:")]);
    for sw in ["0", "1"] {
        let out = edited.hook("SessionStart", "codex", &codex_start(), &env_of(ROLE_SW, sw, &[]));
        assert!(out.contains("EDITED GUIDE:"), "switch {sw}: {out}");
    }
}

// ---- task tracker ----

const SID: &str = "0a1b2c3d-1111-2222-3333-444455556666";

fn prompt_of(sid: &str, home: &Path, text: &str) -> Value {
    json!({"hook_event_name": "UserPromptSubmit", "session_id": sid, "prompt": text, "cwd": home.join("proj")})
}

/// The directive for a first prompt of a fresh session, with one text key of `task_tracker.toml` edited.
fn directive(tag: &str, table: &str, from: &str, to: &str, sw: &str, host: &str) -> String {
    directive_with(tag, table, from, to, sw, host, &[])
}

fn directive_with(tag: &str, table: &str, from: &str, to: &str, sw: &str, host: &str, more: &[(&str, &str)]) -> String {
    let p = Plug::new(tag, &[("task_tracker.toml", table, from, to)]);
    let home = p.home("h0");
    p.hook_in("h0", "UserPromptSubmit", host, &prompt_of("edited", &home, "do the thing"), &env_of(TT_SW, sw, more))
}

#[test]
fn an_edited_first_line_of_the_directive_is_printed_with_the_switch_on_and_off() {
    // the reported input: ANTIHALL_TASK_TRACKER_TERSE=0 printed the stock first line instead of the edited one
    for sw in ["0", "1"] {
        let out = directive("tt-full", "task_tracker.what_full", "requests need tracking before work starts.", "custom tracking directive.", sw, "claude");
        assert!(out.contains("💡 task tracker: custom tracking directive."), "switch {sw}: {out}");
        assert!(!out.contains("requests need tracking") && !out.contains("so none is lost"), "switch {sw}: {out}");
    }
}

#[test]
fn an_edited_first_line_is_printed_on_the_codex_host_with_the_switch_on_and_off() {
    for sw in ["0", "1"] {
        let out = directive("tt-codex", "task_tracker.what_full", "requests need tracking before work starts.", "custom codex directive.", sw, "codex");
        assert!(out.contains("task tracker: custom codex directive."), "switch {sw}: {out}");
    }
}

#[test]
fn an_edited_do_instead_head_is_printed_with_the_switch_on_and_off() {
    for sw in ["0", "1"] {
        let out = directive("tt-head", "task_tracker.instead_head", "track each request as a priority-sorted task.", "custom do-instead head.", sw, "claude");
        assert!(out.contains("custom do-instead head."), "switch {sw}: {out}");
        assert!(!out.contains("track each request") && !out.contains("create the task before the work"), "switch {sw}: {out}");
    }
}

#[test]
fn an_edited_non_blocking_clause_is_printed_with_the_switch_on_and_off() {
    for sw in ["0", "1"] {
        // the full protocol level, where the directive carries the non-blocking clause
        let out = directive_with(
            "tt-nb",
            "task_tracker.non_blocking",
            "keep the MAIN thread non-blocking by delegating heavy/long work to background subagents; ",
            " custom clause. ",
            sw,
            "claude",
            &[("ANTIHALL_PROTOCOL_LEVEL", "full")],
        );
        assert!(out.contains("custom clause."), "switch {sw}: {out}");
        assert!(!out.contains("MAIN thread") && !out.contains("main thread stays free"), "switch {sw}: {out}");
    }
}

#[test]
fn an_edited_key_is_independent_of_the_other_keys_the_switch_rewords() {
    // switch on: the edited first line stays, the unedited do-instead head takes the terse wording
    let on = directive("tt-mix", "task_tracker.what_full", "requests need tracking before work starts.", "custom tracking directive.", "1", "claude");
    assert!(on.contains("custom tracking directive.") && on.contains("create the task before the work and keep its status current."), "{on}");
    // switch off: the edited first line stays, the unedited head keeps the stock wording
    let off = directive("tt-mix0", "task_tracker.what_full", "requests need tracking before work starts.", "custom tracking directive.", "0", "claude");
    assert!(off.contains("custom tracking directive.") && off.contains("track each request as a priority-sorted task."), "{off}");
}

#[test]
fn a_key_set_to_the_terse_wording_by_hand_is_kept_with_the_switch_off() {
    let off = directive(
        "tt-hand",
        "task_tracker.what_full",
        "requests need tracking before work starts.",
        "each user request is tracked as a priority-sorted task before work starts, so none is lost.",
        "0",
        "claude",
    );
    assert!(off.contains("so none is lost."), "{off}");
}

#[test]
fn the_unedited_directive_has_the_stock_wording_when_off_and_the_terse_wording_when_on() {
    let p = Plug::new("tt-plain", &[]);
    let home = p.home("h0");
    let old = p.hook_in("h0", "UserPromptSubmit", "claude", &prompt_of("edited", &home, "do the thing"), &env_of(TT_SW, "0", &[]));
    assert!(old.contains("task tracker: requests need tracking before work starts."), "{old}");
    let new = p.hook_in("h1", "UserPromptSubmit", "claude", &prompt_of("edited", &p.home("h1"), "do the thing"), &env_of(TT_SW, "1", &[]));
    assert!(new.contains("task tracker: each user request is tracked as a priority-sorted task before work starts, so none is lost."), "{new}");
    // the tracker's own block: from its header to the next blank line (other guards speak in the same context)
    let block = new.split("task tracker:").nth(1).unwrap_or("").split("\n\n").next().unwrap_or("").replace("Do instead:", "");
    assert!(!block.is_empty() && block.lines().count() <= 2 && !block.chars().any(char::is_uppercase), "no capitals, at most two lines: {block:?}");
}

/// A second prompt of the same session, once the task list holds an in-progress and a pending task (the list changed, so the short reminder
/// and the open-tasks line both speak; the change-only gate is off).
fn followup(tag: &str, edits: &[(&str, &str, &str, &str)], sw: &str) -> String {
    let p = Plug::new(tag, edits);
    let home = p.home("h0");
    let env = env_of(TT_SW, sw, &[("ANTIHALL_TASK_TRACKER_CHANGE_ONLY", "0")]);
    let first = p.hook_in("h0", "UserPromptSubmit", "claude", &prompt_of(SID, &home, "first request"), &env);
    assert!(first.contains("task tracker:"), "the first prompt carries the directive: {first}");
    let mut t = String::new();
    for n in 1..=2 {
        let id = format!("c{n}");
        t += &format!(
            "{}\n",
            json!({"type": "assistant", "message": {"id": id, "role": "assistant", "content": [{"type": "tool_use", "id": id, "name": "TaskCreate", "input": {"subject": format!("sibling task {n}")}}]}})
        );
        t += &format!(
            "{}\n",
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": id, "content": format!("Task #{n} created successfully: sibling task {n}")}]}})
        );
    }
    t += &format!(
        "{}\n",
        json!({"type": "assistant", "message": {"id": "u1", "role": "assistant", "content": [{"type": "tool_use", "id": "u1", "name": "TaskUpdate", "input": {"taskId": "1", "status": "in_progress"}}]}})
    );
    let transcript = home.join("t.jsonl");
    std::fs::write(&transcript, t).unwrap();
    let mut second = prompt_of(SID, &home, "second request");
    second["transcript_path"] = json!(transcript);
    p.hook_in("h0", "UserPromptSubmit", "claude", &second, &env)
}

#[test]
fn the_short_reminder_and_the_open_tasks_line_are_stock_or_terse_by_the_switch() {
    let off = followup("tt-fu0", &[], "0");
    assert!(off.contains("capture every request as a priority-sorted task; keep statuses current"), "off, short reminder: {off}");
    assert!(off.contains("open tasks: 2") && off.contains("update or close them.") && off.contains("oldest in_progress subject:"), "off, open line: {off}");
    let on = followup("tt-fu1", &[], "1");
    assert!(on.contains("this prompt may hold a request that is not in the task list yet"), "on, short reminder: {on}");
    assert!(
        on.contains("open tasks: 2") && on.contains("close the finished ones, so the list stays accurate.") && on.contains("oldest in progress:"),
        "on, open line: {on}"
    );
}

#[test]
fn an_edited_short_reminder_is_printed_with_the_switch_on_and_off() {
    for sw in ["0", "1"] {
        let edit = [(
            "task_tracker.toml",
            "task_tracker.what_short",
            "capture every request as a priority-sorted task; keep statuses current; delegate heavy work; drop nothing.",
            "custom short reminder.",
        )];
        let out = followup(&format!("tt-short-ed{sw}"), &edit, sw);
        assert!(out.contains("task tracker: custom short reminder."), "switch {sw}: {out}");
        assert!(!out.contains("capture every request") && !out.contains("not in the task list yet"), "switch {sw}: {out}");
    }
}

#[test]
fn an_edited_open_tasks_line_is_printed_with_the_switch_on_and_off() {
    for sw in ["0", "1"] {
        let edit = [("task_tracker.toml", "task_tracker.open_some", "— update or close them.", "- EDITED OPEN LINE.")];
        let out = followup(&format!("tt-open-ed{sw}"), &edit, sw);
        assert!(out.contains("EDITED OPEN LINE.") && !out.contains("update or close them.") && !out.contains("stays accurate"), "switch {sw}: {out}");
    }
}

#[test]
fn an_edited_oldest_in_progress_tail_is_printed_with_the_switch_on_and_off() {
    for sw in ["0", "1"] {
        let edit = [("task_tracker.toml", "task_tracker.subject_tail", "(oldest in_progress subject:", "(EDITED TAIL:")];
        let out = followup(&format!("tt-tail-ed{sw}"), &edit, sw);
        assert!(out.contains("(EDITED TAIL:") && !out.contains("oldest in_progress subject") && !out.contains("oldest in progress"), "switch {sw}: {out}");
    }
}

// ---- the role note keeps the full note when the pristine fallback lacks the short-note keys ----

/// One real hook call (`ah-engine hook`, in process) against a plugin copy whose edited roles.toml is broken, so the engine
/// answers from the released pristine copy, which has none of the role-note keys added since.
fn broken_roles_hook(tag: &str, event: &str, host: &str, payload: Value, env: &[(&str, &str)]) -> (i32, String, String) {
    let s = Scratch::new(tag);
    let plugin_copy = s.dir.join("plugin");
    copy_tree(&plugin().join("engine"), &plugin_copy.join("engine"));
    copy_tree(&plugin().join("hooks"), &plugin_copy.join("hooks"));
    std::fs::write(plugin_copy.join("engine/defaults/roles.toml"), "not valid TOML = [\n").unwrap();
    let mut c = s.cmd(&["hook", "--event", event, "--host", host], env);
    c.env("AH_ENGINE_PLUGIN_ROOT", &plugin_copy).env("CLAUDE_PLUGIN_ROOT", &plugin_copy).env("AH_ENGINE_DISPATCH_IN_PROCESS", "1");
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

#[test]
fn the_role_note_keeps_the_full_note_when_the_pristine_fallback_lacks_the_short_note_keys() {
    let quiet = [("ANTIHALL_INJECT_GATE", "0"), ("ANTIHALL_PROMPT_DIGEST", "0")];
    for (tag, event, host, payload) in [("fb-claude-sub", "SubagentStart", "claude", sub_start()), ("fb-codex-start", "SessionStart", "codex", codex_start())] {
        for switch in ["0", "1"] {
            let mut env = quiet.to_vec();
            env.push((ROLE_SW, switch));
            let (code, out, err) = broken_roles_hook(tag, event, host, payload.clone(), &env);
            assert_eq!(code, 0, "{tag} switch {switch}: {err}");
            // other guards may fail on the same fallback (rule-digest reads roles.digest_budget, outside this switch); the role note must not
            assert!(!out.contains("engine-role-note guard could not run"), "{tag} switch {switch}: the role-note guard must not fail: {out}");
            if host == "claude" {
                assert!(out.contains(STOCK_NOTE_HEAD), "{tag} switch {switch}: the full note answers from the fallback: {out}");
            }
        }
    }
}
