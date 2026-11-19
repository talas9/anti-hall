//! Defect 91ab5e1317e2: the parent gate blocked a Primary's Stop on "Neglect: <child> (1 unread)" while `mesh inbox peek-primary <child>`
//! showed unreadCount 0, so every Stop cost a turn and nothing the Primary ran could clear it. The gate's child count is now the count the
//! read verbs report: an engine wake prompt queued into the child's inbox is never mail (`agent_tracker.wake_prefix`, Primary sender), and a
//! count above the shared peek-primary count of this reader is capped there. A real unread message still blocks, and the read-primary +
//! ackCommand the Primary is told to run clears it. Through the real dispatcher (`ah-engine hook --event Stop`).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use ah_engine::meshw::store::{CursorPut, MeshStore, RegistryRow};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CHILD: &str = "55555555-aaaa-4bbb-8ccc-666666666666";
const NOW_MS: u64 = 1_900_000_000_000;

struct Env {
    dir: PathBuf,
    repo: PathBuf,
    key: String,
    inbox: PathBuf,
    cursor: PathBuf,
    child_wt: PathBuf,
}

fn git(dir: &Path, ceiling: &Path, args: &[&str]) {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_CEILING_DIRECTORIES", ceiling).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

impl Env {
    /// Project A with one registered live child (a worktree, a descriptor, a registry row and the summary built from it). The child's
    /// inbox and cursor file are written by each test.
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("aha-pgu-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        let repo = dir.join("repo-a");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(dir.join("home/.anti-hall/devswarm/summaries")).unwrap();
        git(&repo, &dir, &["init", "-q"]);
        git(&repo, &dir, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
        let key = ah_engine::meshw::ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().expect("a repo key");
        let ds = dir.join("home/.anti-hall/devswarm");
        let child_wt = dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
        let e = Env { inbox: ds.join("child-inbox.jsonl"), cursor: ds.join("child-cursor"), child_wt: child_wt.clone(), dir, repo, key };
        let wt = child_wt;
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(&e.repo, &e.dir, &["worktree", "add", "-q", "-b", "child-wt", wt.to_str().unwrap()]);
        let wt = wt.to_string_lossy().to_string();
        std::fs::write(&e.inbox, "").unwrap();
        std::fs::write(&e.cursor, "0").unwrap();
        e.put(
            &format!("workspaces/{CHILD}.json"),
            &serde_json::json!({"id": CHILD, "worktreePath": wt, "sessionId": "sess-child", "inboxPath": e.inbox, "cursorPath": e.cursor}),
        );
        let home = e.dir.join("home");
        let st = e.store();
        let row = RegistryRow { id: CHILD.into(), worktree_path: Some(wt), session_id: Some("sess-child".into()), ..RegistryRow::default() };
        st.upsert_registry(&row, NOW_MS as i64, |a, b| a == b).unwrap();
        let inv = ah_engine::meshw::common::Inv {
            home: home.clone(),
            env: Default::default(),
            cwd: e.repo.to_string_lossy().to_string(),
            now: NOW_MS as i64,
            stdin: None,
            write_home: home,
            store_override: None,
        };
        let Ok(sum) = ah_engine::meshw::summary::compute(&st, &inv, None) else { panic!("summary") };
        e.put(&format!("summaries/{}.json", e.key), &serde_json::from_str(&sum.stringify()).unwrap());
        e
    }

    fn dsdir(&self) -> PathBuf {
        self.dir.join("home/.anti-hall/devswarm")
    }

    fn store(&self) -> MeshStore {
        let dir = self.dsdir().join("store").join(&self.key);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("BACKEND"), "sqlite\n").unwrap();
        MeshStore::open(&dir.join("devswarm.db")).unwrap()
    }

    fn put(&self, rel: &str, v: &serde_json::Value) {
        let p = self.dsdir().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }

    /// The hook's reader nonce: a session record of this (running) test process, the ancestor the in-process dispatcher walks up to.
    /// Without it the gate has no reader of its own and the shared count is not available to it.
    fn reader_session(&self) {
        let sessions = self.dir.join("home/.claude/sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let pid = std::process::id();
        std::fs::write(sessions.join(format!("{pid}.json")), serde_json::json!({"sessionId": "s1", "pid": pid, "startedAt": 1_000}).to_string()).unwrap();
    }

    fn inbox_lines(&self, lines: &[serde_json::Value], cursor: u32) {
        std::fs::write(&self.inbox, lines.iter().map(|l| l.to_string() + "\n").collect::<String>()).unwrap();
        std::fs::write(&self.cursor, cursor.to_string()).unwrap();
    }

    fn cmd(&self, cwd: &Path) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("GIT_CEILING_DIRECTORIES", &self.dir)
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "pgu-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
            .env("DEVSWARM_AI_AGENT", "claude")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c
    }

    fn stop(&self) -> String {
        let event = "Stop";
        let map = self.dir.join("map-stop.json");
        let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
        let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
        std::fs::write(&map, serde_json::json!({ event: m }).to_string()).unwrap();
        let t = self.dir.join("transcript-s1.jsonl");
        std::fs::write(&t, "").unwrap();
        let payload = serde_json::json!({"session_id": "s1", "hook_event_name": event, "cwd": self.repo, "transcript_path": t, "stop_hook_active": false});
        // the block names the workspaces in its details file: a fresh one per Stop, read back with the answer
        let details = self.dir.join("home/.anti-hall/block-details/devswarm-parent-gate-session.md");
        ah_engine::discard::harmless(std::fs::remove_file(&details));
        let mut c = self.cmd(&self.repo);
        c.args(["hook", "--event", event, "--fallback-map", map.to_str().unwrap()]);
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        assert_eq!(o.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr) + &std::fs::read_to_string(&details).unwrap_or_default()
    }

    /// `ah-engine mesh <argv>` from `cwd`, parsed as JSON.
    fn mesh_in(&self, cwd: &Path, argv: &[&str]) -> serde_json::Value {
        let mut c = self.cmd(cwd);
        c.arg("mesh").args(argv).stdin(Stdio::null());
        let o = c.output().unwrap();
        let out = String::from_utf8_lossy(&o.stdout).to_string();
        let line = out.lines().rev().find(|l| l.trim_start().starts_with('{')).unwrap_or_else(|| panic!("no JSON from mesh {argv:?}: {out} / {}", String::from_utf8_lossy(&o.stderr)));
        serde_json::from_str(line).unwrap()
    }

    fn peek_unread(&self) -> u64 {
        let v = self.mesh_in(&self.repo, &["inbox", "peek-primary", CHILD]);
        v["unreadCount"].as_u64().unwrap_or_else(|| panic!("peek-primary: {v}"))
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if std::env::var_os("AH_KEEP_SCRATCH").is_none() {
            ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
        }
    }
}

/// The gate's neglect line names the child with its count (`devswarm_role.pg_neglect` + the per-family bits).
fn neglects(out: &str) -> bool {
    out.contains("Neglect:") && out.contains(CHILD)
}

fn wake_line(hash: &str) -> serde_json::Value {
    serde_json::json!({
        "_h": hash,
        "fromBranch": "main",
        "message": format!("anti-hall wake: a mesh message is waiting for workspace {CHILD}. Run the read."),
        "createdAt": "2026-11-19T05:15:45.178Z",
        "status": "unread",
        "sender": "primary-63f9261d",
    })
}

fn mail_line(body: &str) -> serde_json::Value {
    serde_json::json!({"message": body, "ts": now_ms() - 3_600_000, "sender": "someone"})
}

/// The live shape of the defect: the line past the descriptor's cursor file is the Primary's own wake prompt (Primary sender, a `native:`
/// store twin with no mtype). peek-primary leaves it out; the gate must too, with and without a reader of its own.
#[test]
fn a_wake_prompt_past_the_cursor_file_is_not_neglected_mail() {
    for with_reader in [false, true] {
        let e = Env::new(if with_reader { "wake-r" } else { "wake" });
        if with_reader {
            e.reader_session();
        }
        let st = e.store();
        for h in ["native:aa01", "native:aa02"] {
            st.append_message_from(CHILD, now_ms() as i64 - 600_000, Some(h), &wake_line(h)["message"].as_str().unwrap().to_string(), Some("primary-63f9261d"))
                .unwrap();
        }
        e.inbox_lines(&[wake_line("native:aa01"), wake_line("native:aa02")], 1);
        assert_eq!(e.peek_unread(), 0, "peek-primary does not count a wake prompt");
        let stop = e.stop();
        assert!(!neglects(&stop), "reader={with_reader}: the gate agrees with peek-primary (0), got: {stop:?}");
    }
}

/// The descriptor's cursor file says 1 line read, the store's read position says both are: the walk sees 1, peek-primary 0. The gate
/// takes the shared count, so the Stop does not block.
#[test]
fn a_cursor_file_behind_the_shared_read_position_does_not_block() {
    let e = Env::new("behind");
    e.reader_session();
    e.inbox_lines(&[mail_line("first"), mail_line("second, already read by the verbs")], 1);
    let st = e.store();
    st.reader_cursor_txn(&[CursorPut { partition: CHILD.into(), ns: "nd".into(), reader: "#floor".into(), value: 2, retired_line: None, updated_at: now_ms() as i64 }])
        .unwrap();
    assert_eq!(e.peek_unread(), 0, "peek-primary reads from the store's read position");
    let stop = e.stop();
    assert!(!neglects(&stop), "the descriptor's stale cursor file is not unread mail, got: {stop:?}");
}

/// The true positive: real unread mail blocks and peek-primary agrees. The block tells the Primary to inspect with peek-primary (which acks
/// nothing, so the block stands) and to follow up with the workspace, whose own read (read-primary in its worktree, then its ackCommand)
/// advances its cursor; after that read the gate clears.
#[test]
fn real_unread_mail_blocks_and_the_read_clears_it() {
    let e = Env::new("real");
    e.reader_session();
    e.inbox_lines(&[mail_line("please review the plan")], 0);
    assert_eq!(e.peek_unread(), 1, "peek-primary sees the mail");
    let stop = e.stop();
    assert!(stop.contains("\"block\"") && neglects(&stop), "real mail blocks, got: {stop:?}");

    assert_eq!(e.peek_unread(), 1, "a peek acks nothing");
    assert!(neglects(&e.stop()), "the Primary's peek does not clear real mail");
    let read = e.mesh_in(&e.child_wt, &["inbox", "read-primary", CHILD]);
    let ack = read["ackCommand"].as_str().unwrap_or_else(|| panic!("read-primary gave no ackCommand: {read}"));
    // the ackCommand names the installed launcher; run the same verb with this build's binary
    let words: Vec<&str> = ack.rsplit_once('\'').map(|(_, rest)| rest).unwrap_or(ack).split_whitespace().collect();
    assert_eq!(words.first(), Some(&"mesh"), "ackCommand shape: {ack}");
    let acked = e.mesh_in(&e.child_wt, &words[1..]);
    assert_eq!(acked["ok"], serde_json::json!(true), "ack: {acked}");
    assert_eq!(e.peek_unread(), 0, "the read cleared peek-primary");
    let stop = e.stop();
    assert!(!neglects(&stop), "after the read the gate clears too, got: {stop:?}");
}
