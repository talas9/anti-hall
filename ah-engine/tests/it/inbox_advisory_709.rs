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
    age_record(&h.home().join(".anti-hall/devswarm/unread-seen.json"), "child:s1");
    assert!(h.turn(&[]).contains(MARK), "an unchanged set speaks again once the cooldown has passed");
    assert!(!h.turn(&[]).contains(MARK), "and the cooldown restarts");
    // the switch off restores the every-prompt advisory
    let off = [("ANTIHALL_DEVSWARM_INBOX_ADVISORY_ON_CHANGE", "0")];
    assert!(h.turn(&off).contains(MARK) && h.turn(&off).contains(MARK), "off: every prompt speaks");
}

/// Push the record `key` of the unread-advisory store `file` 11 minutes into the past (past the 10-minute default cooldown).
fn age_record(file: &std::path::Path, key: &str) {
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    let old = v["e"][key]["at"].as_u64().unwrap() - 11 * 60_000;
    v["e"][key]["at"] = old.into();
    std::fs::write(file, v.to_string()).unwrap();
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
    age_record(&p.dir.join(".anti-hall/devswarm/unread-seen.json"), "own:s1");
    assert!(p.turn(&[]).contains(OWN), "an unchanged set speaks again once the cooldown has passed");
    assert!(!p.turn(&[]).contains(OWN));
    let off = [("ANTIHALL_DEVSWARM_INBOX_ADVISORY_ON_CHANGE", "0")];
    assert!(p.turn(&off).contains(OWN) && p.turn(&off).contains(OWN), "off: every prompt speaks");
}

#[test]
fn the_unread_advisory_store_stays_bounded_and_drops_old_sessions() {
    let h = Home::new("bound");
    h.inbox(&[r#"{"id":"m1","text":"a"}"#]);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let mut e = serde_json::Map::new();
    for i in 0..250u64 {
        e.insert(format!("child:old{i}"), serde_json::json!({"sig":"x","at":now - 1000 - i}));
    }
    e.insert("child:ancient".into(), serde_json::json!({"sig":"x","at":now - 49 * 3_600_000}));
    h.put(".anti-hall/devswarm/unread-seen.json", &serde_json::json!({"e": e}).to_string());
    assert!(h.turn(&[]).contains(MARK), "a first unread message speaks");
    let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(h.home().join(".anti-hall/devswarm/unread-seen.json")).unwrap()).unwrap();
    let e = doc["e"].as_object().unwrap();
    assert_eq!(e.len(), 200, "the store is capped at unread_seen_max entries");
    assert!(e.contains_key("child:s1"), "the record just made is kept");
    assert!(!e.contains_key("child:ancient"), "an entry past the age limit is dropped");
    assert!(!e.contains_key("child:old249"), "the oldest are dropped first");
    assert!(
        std::fs::read_dir(h.home().join(".anti-hall/devswarm")).unwrap().all(|f| !f.unwrap().file_name().to_string_lossy().starts_with("child-unread")),
        "no per-session files"
    );
}

#[test]
fn an_alias_row_mail_acked_and_replaced_at_the_same_count_speaks_at_once() {
    const OWN: &str = "devswarm-own-inbox";
    let p = Primary::new("alias");
    // the app database names the alias row as the primary builder of this very checkout
    let db = p.dir.join("app.db");
    let c = rusqlite::Connection::open(&db).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT, repositoryId TEXT, sourceBranch TEXT, branchName TEXT, worktreePath TEXT, terminalId TEXT, label TEXT, createdAt TEXT, lastAccessed TEXT, rank INTEGER, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isPinned INTEGER, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE builder_terminals (id TEXT, builderId TEXT, terminalId TEXT, terminalType TEXT, aiAgent TEXT, ai_session_config TEXT, isActive INTEGER, panelStatus TEXT, createdAt TEXT, lastViewedAt TEXT, initialPrompt TEXT, initialPromptDeliveredAt TEXT, initialPromptWithheldAt TEXT);
         CREATE TABLE pull_requests (id TEXT, repositoryId TEXT, branchName TEXT, number INTEGER, state TEXT, isDraft INTEGER, url TEXT, checkStatus TEXT, reviewStatus TEXT, lastSyncedAt TEXT);
         CREATE TABLE repositories (id TEXT, path TEXT, name TEXT, defaultBaseBranch TEXT);
         CREATE TABLE workspace_messages (repositoryId TEXT, toBranch TEXT, createdAt TEXT);",
    )
    .unwrap();
    c.execute("INSERT INTO builders (id, worktreePath, builderType, isActive) VALUES ('alias-1', ?1, 'primary', 1)", [p.repo.to_str().unwrap()]).unwrap();
    drop(c);
    let env = [("ANTIHALL_DEVSWARM_APP_DB", db.to_str().unwrap())];
    let alias = |cursor: u64, total: u64| {
        let s = serde_json::json!({"workspaces":{
            p.own.clone(): {"unread":0,"cursor":0,"total":0,"status":"working","gates":{}},
            "alias-1": {"unread":1,"directUnread":1,"cursor":cursor,"total":total,"worktreePath":p.repo,"status":"working","gates":{}}}});
        p.put(&format!(".anti-hall/devswarm/summaries/{}.json", p.key), &s.to_string());
    };
    alias(0, 1);
    let first = p.turn(&env);
    assert!(first.contains(OWN), "alias mail speaks: {first}");
    assert!(!p.turn(&env).contains(OWN), "the same alias mail stays silent");
    alias(1, 2); // the first was read, a new one arrived: still one unread
    assert!(p.turn(&env).contains(OWN), "a new alias message at an unchanged count speaks at once");
}

/// A check answer the dispatcher discards (over the CPU budget) must leave no "already shown" record: the notice was never delivered,
/// so the next prompt speaks it again instead of staying silent for the cooldown.
#[test]
fn a_discarded_child_advisory_leaves_no_suppression_record() {
    let h = Home::new("discard");
    h.inbox(&[r#"{"id":"m1","text":"a"}"#]);
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall");
    let mut pairs: Vec<(String, String)> = CHILD_ENV.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    pairs.push(("HOME".into(), h.home().to_string_lossy().to_string()));
    let meta: ah_engine::dispatch::native::Meta = serde_json::from_value(serde_json::json!({
        "host": "claude", "event": "UserPromptSubmit", "root": root, "only": ["devswarm-child-turn"]
    }))
    .unwrap();
    let meta = ah_engine::dispatch::native::Meta { env: ah_engine::reqenv::RequestEnv::from_pairs(pairs), ..meta };
    let p = serde_json::json!({"hook_event_name":"UserPromptSubmit","session_id":"s1","cwd":h.home(),"transcript_path":h.dir.join("t.jsonl")});
    let store = h.home().join(".anti-hall/devswarm/unread-seen.json");
    let run = |over: bool| {
        ah_engine::deadline::begin(std::time::Instant::now());
        let got = ah_engine::dispatch::native::evaluate(&meta, &p, &|_| over, &|_, _, _| {});
        ah_engine::deadline::settle_staged(true); // the reply is delivered: what the check staged lands unless it was dropped
        ah_engine::deadline::end();
        got
    };
    let got = run(true);
    assert!(!got.is_empty() && got.iter().all(|(_, a)| matches!(a, ah_engine::dispatch::native::Answer::Defer)), "control: the answer is discarded: {got:?}");
    assert!(!store.exists(), "a discarded answer leaves no suppression record");
    let got = run(false);
    let spoke = got.iter().any(|(_, a)| matches!(a, ah_engine::dispatch::native::Answer::Decided(r, _) if r.out.contains(MARK)));
    assert!(spoke, "the next prompt speaks the notice again: {got:?}");
    assert!(store.exists(), "a delivered answer records it");
}
