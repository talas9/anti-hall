//! #709: the unread-inbox advisory of a child workspace speaks when the unread SET changed or after the configured cooldown, not on every
//! prompt. Each case drives the shipped `devswarm-child-turn` check on a scratch home: the same unread set is silent, a new message
//! (even with an unchanged count) speaks at once, the cooldown re-announces, and the switch restores the old every-prompt behaviour.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const CHILD_ENV: [(&str, &str); 4] =
    [("DEVSWARM_REPO_ID", "r1"), ("DEVSWARM_SOURCE_BRANCH", "feat/x"), ("DEVSWARM_BUILDER_ID", "b-1"), ("DEVSWARM_AI_AGENT", "claude")];
const MARK: &str = "devswarm-child-inbox";

struct Home {
    dir: PathBuf,
}

impl Home {
    fn new(name: &str) -> Home {
        let dir = std::env::temp_dir().join(format!("aha-709-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        std::fs::create_dir_all(dir.join("home/.anti-hall/ah-engine")).unwrap();
        Home { dir }
    }

    fn home(&self) -> PathBuf {
        self.dir.join("home")
    }

    fn put(&self, rel: &str, body: &str) {
        let p = self.home().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn turn(&self, extra: &[(&str, &str)]) -> String {
        let p = serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":self.home(),"transcript_path":self.dir.join("t.jsonl")});
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", "devswarm-child-turn"])
            .env_clear()
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.home())
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.envs(CHILD_ENV.iter().copied()).envs(extra.iter().copied());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(p.to_string().as_bytes()).unwrap();
        String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string()
    }

    /// A child with an inbox of `lines` and its cursor at 0.
    fn inbox(&self, lines: &[&str]) {
        let inbox = self.home().join(".anti-hall/devswarm/inbox-b-1.ndjson");
        let cursor = self.home().join(".anti-hall/devswarm/cursor-b-1");
        self.put(".anti-hall/devswarm/inbox-b-1.ndjson", &(lines.join("\n") + "\n"));
        self.put(".anti-hall/devswarm/cursor-b-1", "0");
        self.put(".anti-hall/devswarm/workspaces/b-1.json", &serde_json::json!({"inboxPath": inbox, "cursorPath": cursor}).to_string());
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

#[test]
fn the_child_inbox_advisory_speaks_on_a_changed_unread_set_or_after_the_cooldown() {
    let h = Home::new("child");
    h.inbox(&[r#"{"id":"m1","text":"a"}"#]);
    assert!(h.turn(&[]).contains(MARK), "a first unread message speaks");
    assert!(!h.turn(&[]).contains(MARK), "the same unread set stays silent on the next prompt");
    assert!(!h.turn(&[]).contains(MARK), "and on the one after");
    h.inbox(&[r#"{"id":"m1","text":"a"}"#, r#"{"id":"m2","text":"b"}"#]);
    assert!(h.turn(&[]).contains("2 unread"), "a new unread message speaks at once");
    assert!(!h.turn(&[]).contains(MARK), "the new set is then silent");
    h.inbox(&[r#"{"id":"m1","text":"a"}"#, r#"{"id":"m3","text":"c"}"#]);
    assert!(h.turn(&[]).contains(MARK), "a different message with an unchanged count is a changed set");
    assert!(!h.turn(&[]).contains(MARK));
    // the cooldown: the record's age is pushed past the configured minutes
    let rec = h.home().join(".anti-hall/devswarm/child-unread-seen/s1.json");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    let old = v["at"].as_u64().unwrap() - 11 * 60_000;
    v["at"] = old.into();
    std::fs::write(&rec, v.to_string()).unwrap();
    assert!(h.turn(&[]).contains(MARK), "an unchanged set speaks again once the cooldown has passed");
    assert!(!h.turn(&[]).contains(MARK), "and the cooldown restarts");
    // the switch off restores the every-prompt advisory
    let off = [("ANTIHALL_DEVSWARM_INBOX_ADVISORY_ON_CHANGE", "0")];
    assert!(h.turn(&off).contains(MARK) && h.turn(&off).contains(MARK), "off: every prompt speaks");
}

/// A Primary in a scratch checkout whose summary names `unread` own messages at cursor..total.
struct Primary {
    dir: PathBuf,
    repo: PathBuf,
    key: String,
    own: String,
}

impl Primary {
    fn new(name: &str) -> Primary {
        let dir = std::env::temp_dir().join(format!("aha-709-own-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(dir.join(".anti-hall/ah-engine")).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).arg(&repo).status().unwrap().success());
        let key = ah_engine::meshw::ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().unwrap();
        let own = ah_engine::meshw::ident::primary_workspace_id(repo.to_str().unwrap()).unwrap();
        let p = Primary { dir, repo, key, own };
        p.put(
            &format!(".anti-hall/devswarm/workspaces/{}.json", p.own),
            &serde_json::json!({"id":p.own,"inboxPath":p.dir.join("inbox"),"cursorPath":p.dir.join("cursor")}).to_string(),
        );
        std::fs::write(p.dir.join("inbox"), "").unwrap();
        std::fs::write(p.dir.join("cursor"), "{\"line\":0}").unwrap();
        ah_engine::db::Db::open(&p.dir.join(".anti-hall/ah-engine")).unwrap();
        p.put(
            &format!(".anti-hall/devswarm/wake-tick/{}.json", p.own),
            &serde_json::json!({"known":true,"unreadTotal":0,"meshGapWithheld":false,"seq":7}).to_string(),
        );
        p.put(&format!(".anti-hall/devswarm/heartbeats/{}.json", p.own), &serde_json::json!({"id":p.own,"version":"0.3.0","ts":1}).to_string());
        p
    }

    fn put(&self, rel: &str, body: &str) {
        let f = self.dir.join(rel);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, body).unwrap();
    }

    fn summary(&self, cursor: u64, total: u64) {
        let s = serde_json::json!({"workspaces":{self.own.clone():{"unread":total - cursor,"cursor":cursor,"total":total,"status":"working","gates":{}}}});
        self.put(&format!(".anti-hall/devswarm/summaries/{}.json", self.key), &s.to_string());
    }

    fn turn(&self, extra: &[(&str, &str)]) -> String {
        let p = serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":self.repo,"prompt":"hi","background_tasks":[]});
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["check", "devswarm-parent-inbox"])
            .env_clear()
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("AH_ENGINE_NOSPAWN", "1")
            .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &self.dir)
            .env("CLAUDE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("AH_ENGINE_PLUGIN_ROOT", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .env("AH_ENGINE_DIR", self.dir.join(".anti-hall/ah-engine"))
            .envs(extra.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(p.to_string().as_bytes()).unwrap();
        String::from_utf8_lossy(&ch.wait_with_output().unwrap().stdout).to_string()
    }
}

impl Drop for Primary {
    fn drop(&mut self) {
        ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
    }
}

#[test]
fn the_own_inbox_advisory_speaks_on_a_changed_unread_set_or_after_the_cooldown() {
    const OWN: &str = "devswarm-own-inbox";
    let p = Primary::new("own");
    p.summary(0, 2);
    let first = p.turn(&[]);
    assert!(first.contains(OWN), "a first unread message speaks: {first}");
    assert!(!p.turn(&[]).contains(OWN), "the same unread set stays silent on the next prompt");
    assert!(!p.turn(&[]).contains(OWN));
    p.summary(0, 3);
    assert!(p.turn(&[]).contains(OWN), "a new unread message speaks at once");
    assert!(!p.turn(&[]).contains(OWN));
    p.summary(1, 3);
    assert!(p.turn(&[]).contains(OWN), "a different unread set with the same total speaks");
    let rec = p.dir.join(".anti-hall/devswarm/own-unread-seen/s1.json");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    let old = v["at"].as_u64().unwrap() - 11 * 60_000;
    v["at"] = old.into();
    std::fs::write(&rec, v.to_string()).unwrap();
    assert!(p.turn(&[]).contains(OWN), "an unchanged set speaks again once the cooldown has passed");
    assert!(!p.turn(&[]).contains(OWN));
    let off = [("ANTIHALL_DEVSWARM_INBOX_ADVISORY_ON_CHANGE", "0")];
    assert!(p.turn(&off).contains(OWN) && p.turn(&off).contains(OWN), "off: every prompt speaks");
}
