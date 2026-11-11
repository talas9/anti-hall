//! #709 PR-C: the shipped quiet-tick helper through the real QuickJS runtime.
use serde_json::{Value, json};
use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
};

struct Lab {
    home: PathBuf,
    repo: PathBuf,
    key: String,
}
impl Lab {
    fn new(tag: &str) -> Self {
        let home = std::env::temp_dir().join(format!("ah-quiettick-{}-{tag}", std::process::id()));
        let repo = home.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(home.join(".anti-hall/ah-engine")).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).arg(&repo).status().unwrap().success());
        let key = ah_engine::meshw::ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().unwrap();
        let l = Self { home, repo, key };
        l.put(".anti-hall/devswarm/workspaces/primary.json", &json!({"id":"primary","inboxPath":l.home.join("inbox"),"cursorPath":l.home.join("cursor")}));
        std::fs::write(l.home.join("inbox"), "").unwrap();
        std::fs::write(l.home.join("cursor"), "{\"line\":0}").unwrap();
        std::fs::create_dir_all(l.home.join(".anti-hall/ah-engine")).unwrap();
        ah_engine::db::Db::open(&l.home.join(".anti-hall/ah-engine")).unwrap();
        l.summary(0, "working");
        l.put(".anti-hall/devswarm/wake-tick/primary.json", &json!({"known":true,"unreadTotal":0,"meshGapWithheld":false,"seq":7}));
        l.put(".anti-hall/devswarm/heartbeats/primary.json", &json!({"id":"primary","version":"0.3.0","ts":1}));
        l
    }
    fn put(&self, rel: &str, v: &Value) {
        let p = self.home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }
    fn summary(&self, unread: u64, status: &str) {
        self.put(&format!(".anti-hall/devswarm/summaries/{}.json", self.key), &json!({"workspaces":{"primary":{"unread":unread,"status":status,"gates":{}}}}));
    }
    fn run(&self, scheduled: bool, extra: &[(&str, &str)]) -> String {
        let prompt = extra.iter().find(|(k, _)| *k == "QUIETTICK_PROMPT").map(|(_, v)| *v).unwrap_or("inbox tick primary --quiet");
        let tp = self.home.join("transcript.jsonl");
        let mut record =
            json!({"type":"user","turnOrigin":if scheduled {"scheduled"} else {"user"},"scheduledTaskId":"mail-cron","message":{"content":prompt}});
        let mut prefix = String::new();
        if extra.iter().any(|(k, _)| *k == "QUIETTICK_NO_JOB_ID") {
            prefix = format!("{}\n", record);
            record.as_object_mut().unwrap().remove("scheduledTaskId");
        }
        std::fs::write(&tp, format!("{prefix}{record}\n")).unwrap();
        let p = json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":self.repo,"prompt":prompt,"transcript_path":tp,"background_tasks":[]});
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        if let Some((_, host)) = extra.iter().find(|(k, _)| *k == "QUIETTICK_HOST") {
            c.args(["hook", "--host", host, "--event", "UserPromptSubmit"]);
        } else {
            c.args(["check", "devswarm-parent-inbox"]);
        }
        c.env_clear()
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &self.home)
            .env("CLAUDE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("AH_ENGINE_DIR", self.home.join(".anti-hall/ah-engine"))
            .envs(extra.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn().unwrap();
        child.stdin.take().unwrap().write_all(p.to_string().as_bytes()).unwrap();
        let o = child.wait_with_output().unwrap();
        assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }
}
#[test]
fn unchanged_scheduled_tick_gets_one_line_and_unread_changes_speak() {
    let l = Lab::new("unchanged");
    assert!(!l.run(true, &[]).contains("No change since last tick"));
    let quiet = l.run(true, &[]);
    assert!(quiet.contains("No change since last tick"), "unchanged tick must get the terse directive: {quiet}");
    assert!(quiet.contains("no tool calls"), "{quiet}");
    l.summary(1, "working");
    let normal = l.run(true, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "on")]);
    assert!(normal.contains("unread") || normal.contains("need attention"), "mail must retain the normal inbox context: {normal}");
    assert!(!l.run(true, &[]).contains("No change since last tick"));
    assert!(!l.run(true, &[]).contains("No change since last tick"), "pending unread never gated even unchanged");
}
#[test]
fn typed_prompt_switch_off_changed_child_and_task_list_fail_open() {
    let l = Lab::new("changes");
    l.run(true, &[]);
    assert!(!l.run(false, &[]).contains("No change since last tick"));
    assert!(!l.run(true, &[("ANTIHALL_IDLE_GATE", "0")]).contains("No change since last tick"));
    l.summary(0, "done");
    assert!(!l.run(true, &[]).contains("No change since last tick"));
    assert!(l.run(true, &[]).contains("No change since last tick"));
    l.put(".claude/tasks/s1/1.json", &json!({"id":"1","subject":"new task","status":"pending"}));
    assert!(!l.run(true, &[]).contains("No change since last tick"));
}

#[test]
fn default_is_one_line_block_is_explicit_and_ceiling_forces_a_normal_tick() {
    assert_eq!(ah_engine::defaults::raw("idle_gate.mode").get("default").and_then(ah_engine::defaults::V::as_str), Some("one_line"));
    assert_eq!(ah_engine::defaults::raw("idle_gate.owner_cron_opt_in").get("default").and_then(ah_engine::defaults::V::as_bool), Some(false));
    let l = Lab::new("mode");
    l.run(true, &[]);
    let quiet = l.run(true, &[]);
    assert!(quiet.contains("No change since last tick") && !quiet.contains("\"decision\":\"block\""), "{quiet}");
    let blocked = l.run(true, &[("ANTIHALL_IDLE_GATE_MODE", "block")]);
    assert_eq!(serde_json::from_str::<Value>(&blocked).unwrap()["decision"], "block");
    let dir = l.home.join(".anti-hall/idle-gate");
    for f in std::fs::read_dir(dir).unwrap().flatten() {
        let mut v: Value = serde_json::from_str(&std::fs::read_to_string(f.path()).unwrap()).unwrap();
        v["normalAt"] = json!(1);
        std::fs::write(f.path(), v.to_string()).unwrap();
    }
    assert!(!l.run(true, &[]).contains("No change since last tick"));
}
#[test]
fn actual_new_block_runs_normally_and_benign_database_changes_stay_quiet() {
    let l = Lab::new("blocks");
    l.run(true, &[]);
    assert!(l.run(true, &[]).contains("No change since last tick"));
    let db = ah_engine::db::Db::open(&l.home.join(".anti-hall/ah-engine")).unwrap();
    db.write(ah_engine::db::Op::Metrics { ts_ms: 1, body: "{}".into() }).unwrap();
    assert!(l.run(true, &[]).contains("No change since last tick"));
    db.write(ah_engine::db::Op::Block(ah_engine::storage::BlockRow {
        ts_ms: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
        guard: "test-guard".into(),
        rule: "test-rule".into(),
        event: "Stop".into(),
        session: "s1".into(),
        agent: String::new(),
        tool: String::new(),
        project: String::new(),
        reason: "new blocker".into(),
        repeat: 0,
    }))
    .unwrap();
    assert!(!l.run(true, &[]).contains("No change since last tick"));
}
#[test]
fn real_dispatch_on_both_hosts_runs_the_gate_once() {
    for host in ["claude", "codex"] {
        let l = Lab::new(host);
        let extra = [("QUIETTICK_HOST", host), ("ANTIHALL_DEVSWARM_SUPERVISOR", "on")];
        assert!(!l.run(true, &extra).contains("No change since last tick"));
        let quiet = l.run(true, &extra);
        assert_eq!(quiet.matches("No change since last tick").count(), 1, "{host}: {quiet}");
        assert!(!l.run(false, &extra).contains("No change since last tick"));
    }
}
#[test]
fn uncertain_mail_native_imports_and_corrupt_state_stay_normal() {
    let l = Lab::new("unknown");
    l.run(true, &[]);
    l.put(".anti-hall/devswarm/workspaces/primary.json", &json!({"id":"primary"}));
    assert!(!l.run(true, &[]).contains("No change since last tick"));
    assert!(!l.run(true, &[("QUIETTICK_PROMPT", "inbox tick primary --child --quiet")]).contains("No change since last tick"));
    let h = Lab::new("corrupt");
    h.run(true, &[]);
    std::fs::write(h.home.join(format!(".anti-hall/devswarm/summaries/{}.json", h.key)), "{broken").unwrap();
    assert!(!h.run(true, &[]).contains("No change since last tick"));
}

#[test]
fn mixed_work_prompts_missing_job_identity_and_mail_clearing_do_not_reuse_a_clean_baseline() {
    let l = Lab::new("identity");
    l.run(true, &[]);
    assert!(l.run(true, &[]).contains("No change since last tick"));
    assert!(!l.run(true, &[("QUIETTICK_PROMPT", "inbox tick primary --quiet; inspect pending work")]).contains("No change since last tick"));
    assert!(!l.run(true, &[("QUIETTICK_NO_JOB_ID", "1")]).contains("No change since last tick"));
    l.summary(1, "working");
    assert!(!l.run(true, &[]).contains("No change since last tick"));
    l.summary(0, "working");
    assert!(!l.run(true, &[]).contains("No change since last tick"), "clearing unread is itself a state change");
    assert!(l.run(true, &[]).contains("No change since last tick"));
}
