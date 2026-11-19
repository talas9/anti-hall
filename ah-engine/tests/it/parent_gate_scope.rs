//! GH #809: the parent gate answers only for workspaces registered to the session's OWN project. A session in a directory that belongs to
//! no project has no project id to scope by, so the machine-global workspace descriptors of other projects must not block its Stop or ask
//! it for a mailbox cron; a session in project A is not blocked by workspaces of project B; project A's own live child still blocks a
//! Primary with no wake path. Through the real dispatcher (`ah-engine hook --event Stop`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const OWN_CHILD: &str = "11111111-aaaa-4bbb-8ccc-222222222222";
const FOREIGN_CHILD: &str = "33333333-aaaa-4bbb-8ccc-444444444444";
const NOW_MS: u64 = 1_900_000_000_000;
const WAKE_LINE: &str = "NO MAILBOX WAKE PATH";

struct Env {
    dir: PathBuf,
    repo: PathBuf,
    other: PathBuf,
    scratch: PathBuf,
    key: String,
}

fn git(dir: &Path, ceiling: &Path, args: &[&str]) {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_CEILING_DIRECTORIES", ceiling).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("aha-pgs-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        let (repo, other, scratch) = (dir.join("repo-a"), dir.join("repo-b"), dir.join("scratch"));
        for d in [&repo, &other, &scratch] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::create_dir_all(dir.join("home/.anti-hall/devswarm/summaries")).unwrap();
        for r in [&repo, &other] {
            git(r, &dir, &["init", "-q"]);
            git(r, &dir, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
        }
        let key = ah_engine::meshw::ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().expect("a repo key");
        Env { dir, repo, other, scratch, key }
    }

    fn dsdir(&self) -> PathBuf {
        self.dir.join("home/.anti-hall/devswarm")
    }

    fn put(&self, rel: &str, v: &serde_json::Value) {
        let p = self.dsdir().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }

    /// A worktree of `repo` named `leaf`, with an inbox holding one unread message: the descriptor a gate that does not scope would block on.
    fn child_with_mail(&self, repo: &Path, id: &str, leaf: &str) -> String {
        let wt = self.dir.join("home/.devswarm/repos/3/8205fc11").join(leaf);
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(repo, &self.dir, &["worktree", "add", "-q", "-b", leaf, wt.to_str().unwrap()]);
        let wt = wt.to_string_lossy().to_string();
        let (inbox, cursor) = (self.dsdir().join(format!("{leaf}-inbox.jsonl")), self.dsdir().join(format!("{leaf}-cursor")));
        std::fs::write(&inbox, serde_json::json!({"message": "please review", "ts": now_ms() - 3_600_000, "from": "someone"}).to_string() + "\n").unwrap();
        std::fs::write(&cursor, "0").unwrap();
        self.put(
            &format!("workspaces/{id}.json"),
            &serde_json::json!({"id": id, "worktreePath": wt, "sessionId": format!("sess-{leaf}"), "inboxPath": inbox, "cursorPath": cursor}),
        );
        wt
    }

    /// Project A's own live child: a registry row and the summary built from it, the way `wake_cron_child_only` lays it out.
    fn own_live_child(&self) {
        use ah_engine::meshw::store::{MeshStore, RegistryRow};
        let wt = self.child_with_mail(&self.repo, OWN_CHILD, "own-wt");
        let home = self.dir.join("home");
        let st = MeshStore::open(&self.dsdir().join("store").join(&self.key).join("devswarm.db")).unwrap();
        let row = RegistryRow { id: OWN_CHILD.into(), worktree_path: Some(wt), session_id: Some("sess-own-wt".into()), ..RegistryRow::default() };
        st.upsert_registry(&row, NOW_MS as i64, |a, b| a == b).unwrap();
        let inv = ah_engine::meshw::common::Inv {
            home: home.clone(),
            env: Default::default(),
            cwd: self.repo.to_string_lossy().to_string(),
            now: NOW_MS as i64,
            stdin: None,
            write_home: home,
            store_override: None,
        };
        let Ok(sum) = ah_engine::meshw::summary::compute(&st, &inv, None) else { panic!("summary") };
        self.put(&format!("summaries/{}.json", self.key), &serde_json::from_str(&sum.stringify()).unwrap());
    }

    fn run(&self, cwd: &Path, event: &str, payload: &serde_json::Value) -> String {
        let map = self.dir.join(format!("map-{event}.json"));
        let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
        let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
        std::fs::write(&map, serde_json::json!({ event: m }).to_string()).unwrap();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", event, "--fallback-map", map.to_str().unwrap()])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("GIT_CEILING_DIRECTORIES", &self.dir)
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "pgs-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
            .env("DEVSWARM_AI_AGENT", "claude")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        assert_eq!(o.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr)
    }

    fn stop(&self, cwd: &Path, session: &str) -> String {
        let t = self.dir.join(format!("transcript-{session}.jsonl"));
        std::fs::write(&t, "").unwrap();
        self.run(cwd, "Stop", &serde_json::json!({"session_id": session, "hook_event_name": "Stop", "cwd": cwd, "transcript_path": t, "stop_hook_active": false}))
    }

    fn turn(&self, cwd: &Path, session: &str) -> String {
        self.run(cwd, "UserPromptSubmit", &serde_json::json!({"session_id": session, "hook_event_name": "UserPromptSubmit", "prompt": "hi", "cwd": cwd}))
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if std::env::var_os("AH_KEEP_SCRATCH").is_none() {
            ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
        }
    }
}

#[test]
fn a_project_less_directory_is_not_blocked_by_other_projects_workspaces() {
    let e = Env::new("none");
    e.child_with_mail(&e.other, FOREIGN_CHILD, "foreign-wt");
    let stop = e.stop(&e.scratch, "s1");
    assert!(!stop.contains("\"block\"") && !stop.contains("workspace duties") && !stop.contains(FOREIGN_CHILD), "no block, got: {stop:?}");
    assert!(!stop.contains("CronCreate") && !stop.contains(WAKE_LINE), "no cron advice, got: {stop:?}");
    let turn = e.turn(&e.scratch, "s1");
    assert!(!turn.contains("CronCreate") && !turn.contains(WAKE_LINE) && !turn.contains(FOREIGN_CHILD), "no wake advice, got: {turn:?}");
}

#[test]
fn a_project_is_not_blocked_by_workspaces_registered_to_another_project() {
    let e = Env::new("other");
    e.child_with_mail(&e.other, FOREIGN_CHILD, "foreign-wt");
    let stop = e.stop(&e.repo, "s1");
    assert!(!stop.contains("\"block\"") && !stop.contains(FOREIGN_CHILD), "project B's workspace is not project A's duty, got: {stop:?}");
}

#[test]
fn a_project_with_its_own_live_child_and_no_wake_path_still_blocks() {
    let e = Env::new("own");
    e.child_with_mail(&e.other, FOREIGN_CHILD, "foreign-wt");
    e.own_live_child();
    let stop = e.stop(&e.repo, "s1");
    assert!(stop.contains("\"block\""), "the project's own child still blocks, got: {stop:?}");
    // the block text keeps the ids in its details file: it names the own child and never the foreign one
    let details = std::fs::read_to_string(e.dir.join("home/.anti-hall/block-details/devswarm-parent-gate-session.md")).unwrap_or_default();
    assert!(details.contains(OWN_CHILD) && !details.contains(FOREIGN_CHILD), "details: {details:?}");
    assert!(!stop.contains(FOREIGN_CHILD), "the foreign workspace is never named, got: {stop:?}");
}

#[test]
fn a_primary_whose_cwd_was_deleted_inside_its_repo_still_blocks() {
    let e = Env::new("pdel");
    e.own_live_child();
    let gone = e.repo.join("gone");
    let t = e.dir.join("transcript-del.jsonl");
    std::fs::write(&t, "").unwrap();
    let stop = e.run(&e.repo, "Stop", &serde_json::json!({"session_id": "s1", "hook_event_name": "Stop", "cwd": gone, "transcript_path": t, "stop_hook_active": false}));
    assert!(stop.contains("\"block\""), "a deleted cwd inside the repo fails open and keeps the descriptors, got: {stop:?}");
}
