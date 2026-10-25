//! Verdict matrix for the five W2 scripts. Advisory prose is deliberately not a contract.
//!
//! Denial exits in engine/logic/: task-guard.js:426 (idle/generic reasons :316/:322),
//! tasklist-guard.js:548 (reset/no tasks/stalled/progress/reduced :467-478) and :610 (resume),
//! speculation-guard.js:305 (regex :278, Jev add-block :263; framed relax :294).
//! task-tracker and dispatch-tier have no denial exits. Rust registers all five in checks/scripted.rs.
//! These exact JSON answers have no reason id: assert only the block class, never their English reason.

use ah_engine::jev::{
    assist::content_hash,
    cache::{Cached, FileCache, JevCache},
    client::Answer,
};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicUsize, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static ID: AtomicUsize = AtomicUsize::new(0);

struct World {
    home: PathBuf,
}
impl World {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("ah-w2-{}-{}-{}", std::process::id(), now(), ID.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(home.join("proj/.git")).unwrap();
        Self { home: home.canonicalize().unwrap() }
    }
    fn file(&self, rel: &str, body: impl AsRef<[u8]>) {
        let p = self.home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }
    fn payload(&self) -> Value {
        json!({"hook_event_name":"Stop","session_id":"s1","cwd":self.home.join("proj"),"transcript_path":self.home.join("t.jsonl")})
    }
    fn transcript(&self, lines: Vec<Value>) {
        self.file("t.jsonl", lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n");
    }
    fn cache(&self, id: &str, text: &str, answer: bool) {
        let hash = content_hash(&[id, ah_engine::defaults::text("jev.question_version"), text]);
        FileCache::for_home(&self.home).put(&hash, Cached { answer: Answer::Bool(answer), confidence: 0.99, chain: None });
    }
    fn jev_row(&self, id: &str, backend: &str, reason: Option<&str>) {
        // Advisory asks are detached: bound the wait exactly as the existing parity harness does.
        let deadline = std::time::Instant::now() + crate::common::scaled(std::time::Duration::from_secs(3));
        loop {
            let log = std::fs::read_to_string(self.home.join(".anti-hall/logs/jev-assist.ndjson")).unwrap_or_default();
            if log
                .lines()
                .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                .any(|v| v["id"] == id && v["backend"] == backend && v["reason"].as_str() == reason)
            {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "missing Jev row id={id} backend={backend} reason={reason:?}: {log}");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    fn check(&self, name: &str, payload: Value, env: &[(&str, &str)], blocked: bool, label: &str) {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", name])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("ANTIHALL_TEST_ISOLATION", "1")
            .env("ANTIHALL_INGEST_DRY_RUN", "1")
            .env("AH_ENGINE_DIR", self.home.join("engine-state"))
            .env("CLAUDE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .envs(env.iter().copied())
            .current_dir(&self.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for k in ["AH_ENGINE_SCRIPT_TIME_MS", "AH_ENGINE_SCRIPT_EXEC_SCALE"] {
            if let Some(v) = std::env::var_os(k) {
                c.env(k, v);
            }
        }
        let mut child = c.spawn().unwrap();
        child.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = child.wait_with_output().unwrap();
        let out = String::from_utf8_lossy(&o.stdout);
        let err = String::from_utf8_lossy(&o.stderr);
        assert!(!out.contains("AHFALLBACK"), "{name}/{label}: deferred: {out} {err}");
        let v: Value = serde_json::from_str(out.trim()).unwrap_or(Value::Null);
        let actual = o.status.code() == Some(2) || v["decision"] == "block" || v["hookSpecificOutput"]["permissionDecision"] == "deny";
        assert!(matches!(o.status.code(), Some(0 | 2)), "{name}/{label}: {} {err}", o.status);
        assert_eq!(actual, blocked, "{name}/{label}: code={:?} out={out} err={err}", o.status.code());
        // Freeze structured ids when present; these scripts currently expose none.
        assert!(v.get("reasonId").is_none() && v.get("reason_id").is_none(), "{name}/{label}: new reason id must be pinned");
    }
}

fn now() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis()
}
fn tool(id: &str, name: &str, input: Value) -> Value {
    json!({"type":"assistant","timestamp":"2026-10-06T08:00:00.000Z","message":{"id":id,"role":"assistant","content":[{"type":"tool_use","id":id,"name":name,"input":input}]}})
}
fn result(id: &str, text: &str) -> Value {
    json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":id,"content":text}]}})
}
fn tasks(status: &str, count: usize) -> Vec<Value> {
    (1..=count)
        .flat_map(|n| {
            let id = format!("t{n}");
            vec![
                tool(&id, "TaskCreate", json!({"subject":"work"})),
                result(&id, &format!("Task #{n} created successfully: work")),
                tool(&format!("u{n}"), "TaskUpdate", json!({"taskId":n.to_string(),"status":status})),
            ]
        })
        .collect()
}
fn work(n: usize) -> Vec<Value> {
    (0..n).map(|n| tool(&format!("e{n}"), "Edit", json!({"file_path":format!("/project/f{n}.js")}))).collect()
}

#[test]
fn w2_behaviour_matrix_task_guard() {
    // Idle and generic share the output exit, but take different reason/hash/metrics paths.
    for (label, status, extra, blocked) in [
        ("idle", "pending", false, true),
        ("idle-near-completed", "completed", false, false),
        ("generic", "in_progress", false, true),
        ("generic-near-owner-blocked", "in_progress", true, false),
    ] {
        let w = World::new();
        let mut lines = tasks(status, 1);
        if extra {
            lines.push(tool("owner", "TaskUpdate", json!({"taskId":"1","subject":"OWNER: work"})));
        }
        w.transcript(lines);
        w.check("task-guard", w.payload(), &[("ANTIHALL_DISPATCH_DEMAND", "0")], blocked, label);
    }
}

#[test]
fn w2_behaviour_matrix_tasklist_guard() {
    for branch in ["no-tasks", "reset", "stalled", "progress", "reduced", "resume"] {
        for near in [false, true] {
            let w = World::new();
            let mut p = w.payload();
            let mut lines = work(if near && ["no-tasks", "reset", "reduced"].contains(&branch) { 2 } else { 3 });
            if branch == "reset" {
                lines.extend([tool("get", "TaskGet", json!({"taskId":"99"})), result("get", "Task #99 not found")]);
            }
            if ["stalled", "progress"].contains(&branch) {
                lines.extend(tasks("in_progress", if branch == "stalled" { 2 } else { 1 }));
            }
            if branch == "stalled" || (branch == "progress" && near) {
                let date = ah_engine::jev::assist::iso_ms(now() as u64)[..10].to_string();
                w.file(&format!("proj/.anti-hall/progress/{date}/s1.md"), "fresh progress");
            }
            if branch == "stalled" && near {
                p["turn_id"] = json!("codex-turn");
            }
            if branch == "reduced" {
                p["turn_id"] = json!("codex-turn");
            }
            if branch == "resume" {
                w.file("handover.md", if near { "resume-verified: checked" } else { "unverified handover" });
                w.file(".anti-hall/handover-resume-state-s1.json", json!({"handoverFile":w.home.join("handover.md")}).to_string());
                // With task activity and fresh progress the ordinary gate is quiet, isolating resume.
                lines.extend(tasks("completed", 1));
                let date = ah_engine::jev::assist::iso_ms(now() as u64)[..10].to_string();
                w.file(&format!("proj/.anti-hall/progress/{date}/s1.md"), "fresh progress");
            }
            w.transcript(lines);
            w.check("tasklist-guard", p, &[], !near, &format!("{branch}/near={near}"));
        }
    }
    // Jev unavailable cannot relax the baseline block; below-threshold remains allowed.
    for (n, blocked) in [(3, true), (2, false)] {
        let w = World::new();
        w.transcript(work(n));
        w.file(".anti-hall/settings.json", r#"{"jevIntegrations":{"tasklistTrivial":"on"}}"#);
        w.check("tasklist-guard", w.payload(), &[("ANTIHALL_JEV", "1")], blocked, "jev-unavailable");
        if blocked {
            w.jev_row("tasklistTrivial", "baseline-only", Some("no-key"));
        }
    }
}

#[test]
fn w2_behaviour_matrix_speculation_guard() {
    for (label, text, jev, cached, blocked) in [
        ("regex", "It is probably the cache.", false, None, true),
        ("regex-near-ack", "It is probably the cache. I haven't checked.", false, None, false),
        ("jev-add", "It is probably the cache. I haven't checked.", true, Some(true), true),
        ("jev-add-near", "It is probably the cache. I haven't checked.", true, Some(false), false),
        ("framed-retain", "Plan: It is probably the cache.", true, Some(false), true),
        ("framed-relax", "Plan: It is probably the cache.", true, Some(false), false),
        ("jev-unavailable-regex", "It is probably the cache.", true, None, true),
        ("jev-unavailable-framed", "Plan: It is probably the cache.", true, None, true),
        ("jev-unavailable-near", "It is probably the cache. I haven't checked.", true, None, false),
    ] {
        let w = World::new();
        w.transcript(vec![]);
        w.file(".anti-hall/settings.json", r#"{"jevIntegrations":{"speculationFramed":"on"}}"#);
        let mut p = w.payload();
        p["last_assistant_message"] = json!(text);
        if let Some(answer) = cached {
            w.cache("speculation", text, answer);
        }
        if label.starts_with("framed") {
            w.cache("speculationFramed", text, label != "framed-relax");
        }
        let mut env = vec![("ANTIHALL_JEV", if jev { "1" } else { "0" }), ("ANTIHALL_JEV_CASCADE", "0")];
        if cached.is_some() {
            env.push(("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "matrix-test-key-not-real"));
        }
        w.check("speculation-guard", p, &env, blocked, label);
        if cached.is_some() {
            w.jev_row("speculation", "cache", None);
        }
        if label.starts_with("framed") {
            w.jev_row("speculationFramed", "cache", None);
        }
        if label.starts_with("jev-unavailable") {
            w.jev_row("speculation", "baseline-only", Some("no-key"));
            if label == "jev-unavailable-framed" {
                w.jev_row("speculationFramed", "baseline-only", Some("no-key"));
            }
        }
    }
}

#[test]
fn w2_behaviour_matrix_advisory_only() {
    for (check, event) in [("task-tracker", "UserPromptSubmit"), ("dispatch-tier", "PostToolUse")] {
        for (label, jev, enabled) in [("active", "0", true), ("near-disabled", "0", false), ("jev-unavailable", "1", true)] {
            let w = World::new();
            w.transcript(vec![]);
            let mut p = w.payload();
            p["hook_event_name"] = json!(event);
            p["prompt"] = json!("do the work");
            p["tool_name"] = json!(if enabled { "TaskCreate" } else { "Read" });
            p["tool_input"] = json!({"subject":"work"});
            if !enabled && check == "task-tracker" {
                w.file(".anti-hall/settings.json", r#"{"context":{"taskTracker":false}}"#);
            }
            w.check(check, p, &[("ANTIHALL_JEV", jev)], false, label);
            if label == "jev-unavailable" {
                w.jev_row(if check == "task-tracker" { "newRequest" } else { "dispatchTier" }, "baseline-only", Some("no-key"));
            }
        }
    }
    let w = World::new();
    w.transcript(tasks("pending", 1));
    let mut p = w.payload();
    p["hook_event_name"] = json!("UserPromptSubmit");
    p["prompt"] = json!("");
    // Empty prompt bypasses newRequest; pending work reaches the independent dispatchTier ask.
    w.check("task-tracker", p, &[("ANTIHALL_JEV", "1")], false, "tier-jev-unavailable");
    w.jev_row("dispatchTier", "baseline-only", Some("no-key"));
}
