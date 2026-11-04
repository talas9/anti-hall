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

    /// The additional context one hook call puts in front of the model ("" when it stays silent).
    fn context(&self, check: &str, payload: Value, env: &[(&str, &str)]) -> String {
        let mut ch = self.cmd(&["check", check], env).spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        assert_eq!(o.status.code(), Some(0), "{}", String::from_utf8_lossy(&o.stderr));
        let out = String::from_utf8_lossy(&o.stdout).into_owned();
        if out.trim().is_empty() {
            return String::new();
        }
        let v: Value = serde_json::from_str(out.trim()).unwrap_or_else(|e| panic!("not JSON ({e}): {out}"));
        v.pointer("/hookSpecificOutput/additionalContext").and_then(Value::as_str).unwrap_or("").to_string()
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

fn prompt(home: &Path) -> Value {
    json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "prompt": "do the thing", "cwd": home.join("proj")})
}

const ROLE_ON: (&str, &str) = ("ANTIHALL_ROLE_NOTE_SHORT", "1");
const TT_ON: (&str, &str) = ("ANTIHALL_TASK_TRACKER_TERSE", "1");

#[test]
fn a_subagent_gets_the_full_note_by_default_and_one_factual_line_when_the_switch_is_on() {
    let s = Scratch::new("role");
    let off = s.context("engine-role-note", sub_start(), &[]);
    assert!(off.contains("(role: subagent)") && off.contains("Engine verbs you may run:"), "the default keeps the full note: {off}");
    let sub = s.context("engine-role-note", sub_start(), &[ROLE_ON]);
    assert_eq!(sub, "anti-hall engine: role subagent (one assigned job, report back). Engine guide: /anti-hall:engine.");
    assert!(sub.len() <= 140, "{} bytes", sub.len());
    let main = s.context("engine-role-note", json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "SessionStart"}), &[ROLE_ON]);
    assert!(main.contains("(role: main)") && main.contains("Engine verbs you may run:"), "the main session keeps its note: {main}");
}

#[test]
fn the_task_tracker_keeps_its_earlier_wording_by_default_and_words_it_factually_when_the_switch_is_on() {
    let s = Scratch::new("tt-off");
    let old = s.context("task-tracker", prompt(&s.dir.join("home")), &[]);
    assert!(old.contains("requests need tracking before work starts."), "the default keeps the earlier wording: {old}");
    let s = Scratch::new("tt");
    let home = s.dir.join("home");
    let full = s.context("task-tracker", prompt(&home), &[TT_ON]);
    assert!(full.contains("each user request is tracked as a priority-sorted task before work starts, so none is lost."), "{full}");
    assert!(full.lines().count() <= 2, "{full}");
    let tail = full.split("task-tracker:").nth(1).unwrap_or("");
    assert!(!tail.chars().any(char::is_uppercase), "no capitals or intensifiers in the wording: {tail}");
    let short = s.context("task-tracker", prompt(&home), &[TT_ON]);
    assert!(short.is_empty() || (short.contains("not in the task list yet") && short.lines().count() <= 2), "{short}");
}

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
    for (tag, event, host, payload) in [
        ("fb-claude-sub", "SubagentStart", "claude", sub_start()),
        ("fb-codex-start", "SessionStart", "codex", json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "SessionStart"})),
    ] {
        for switch in ["0", "1"] {
            let mut env = quiet.to_vec();
            env.push(("ANTIHALL_ROLE_NOTE_SHORT", switch));
            let (code, out, err) = broken_roles_hook(tag, event, host, payload.clone(), &env);
            assert_eq!(code, 0, "{tag} switch {switch}: {err}");
            // other guards may fail on the same fallback (rule-digest reads roles.digest_budget, outside this switch); the role note must not
            assert!(!out.contains("engine-role-note guard could not run"), "{tag} switch {switch}: the role-note guard must not fail: {out}");
            if host == "claude" {
                assert!(out.contains("Engine verbs you may run:"), "{tag} switch {switch}: the full note answers from the fallback: {out}");
            }
        }
    }
}
