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

#[test]
fn a_subagent_gets_one_factual_line_and_the_main_session_keeps_its_note() {
    let s = Scratch::new("role");
    let sub = s.context("engine-role-note", sub_start(), &[]);
    assert_eq!(sub, "anti-hall engine: role subagent (one assigned job, report back). Verbs your role may run: /anti-hall:engine.");
    assert!(sub.len() <= 140, "{} bytes", sub.len());
    let main = s.context("engine-role-note", json!({"session_id": "s1", "cwd": "/tmp", "hook_event_name": "SessionStart"}), &[]);
    assert!(main.contains("(role: main)") && main.contains("Engine verbs you may run:"), "{main}");
    let off = s.context("engine-role-note", sub_start(), &[("ANTIHALL_ROLE_NOTE_SHORT", "0")]);
    assert!(off.contains("(role: subagent)") && off.contains("Engine verbs you may run:"), "the switch restores the full note: {off}");
}

#[test]
fn the_task_tracker_words_its_directive_and_reminder_factually_and_counts_each() {
    let s = Scratch::new("tt");
    let home = s.dir.join("home");
    let full = s.context("task-tracker", prompt(&home), &[]);
    assert!(full.contains("each user request is tracked as a priority-sorted task before work starts, so none is lost."), "{full}");
    assert!(full.lines().count() <= 2, "{full}");
    let tail = full.split("task-tracker:").nth(1).unwrap_or("");
    assert!(!tail.chars().any(char::is_uppercase), "no capitals or intensifiers in the wording: {full}");
    let short = s.context("task-tracker", prompt(&home), &[]);
    assert!(short.is_empty() || (short.contains("not in the task list yet") && short.lines().count() <= 2), "{short}");
    let legacy = Scratch::new("tt-off");
    let old = legacy.context("task-tracker", prompt(&legacy.dir.join("home")), &[("ANTIHALL_TASK_TRACKER_TERSE", "0")]);
    assert!(old.contains("requests need tracking before work starts."), "the switch restores the earlier wording: {old}");
}
