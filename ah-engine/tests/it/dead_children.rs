//! GH #508 through the real dispatcher (`ah-engine hook --event UserPromptSubmit`): a Primary whose project holds a child that is
//! archived with its worktree gone is no longer nagged about it (switch `devswarm.skipDeadChildren`), a live child still is, and the
//! switch off keeps the old text. The payload and the on-disk layout are the ones a Primary's turn meets.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CHILD: &str = "11111111-aaaa-4bbb-8ccc-222222222222";
const NOW_MS: u64 = 1_900_000_000_000;

struct Env {
    dir: PathBuf,
    repo: PathBuf,
    key: String,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("ahd-dead-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(dir.join("home/.anti-hall/devswarm/summaries")).unwrap();
        let git = |args: &[&str]| {
            let o = Command::new("git").args(args).current_dir(&repo).env("GIT_CEILING_DIRECTORIES", &dir).output().unwrap();
            assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        };
        git(&["init", "-q"]);
        let key = ah_engine::meshw::ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().expect("a repo key");
        Env { dir, repo, key }
    }

    fn dsdir(&self) -> PathBuf {
        self.dir.join("home/.anti-hall/devswarm")
    }

    /// The child's worktree path; `parent_exists` false puts it under a directory that is not there (an unmounted volume).
    fn worktree(&self, exists: bool, parent_exists: bool) -> String {
        let wt = if parent_exists { self.dir.join("wts/child-wt") } else { self.dir.join("unmounted/wts/child-wt") };
        if parent_exists {
            std::fs::create_dir_all(self.dir.join("wts")).unwrap();
        }
        if exists {
            std::fs::create_dir_all(&wt).unwrap();
        }
        wt.to_string_lossy().to_string()
    }

    fn put(&self, rel: &str, v: serde_json::Value) {
        let p = self.dsdir().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }

    /// A summary with the one child holding `unread` messages (`urgency` the top of them), 40 days old.
    fn summary(&self, wt: &str, unread: u32, urgency: &str, stale_registry: bool) {
        let row = serde_json::json!({
            "id": CHILD, "worktreePath": wt, "sessionId": "sess-1", "total": unread, "cursor": 0, "unread": unread, "directUnread": unread,
            "oldestDirectUnreadTs": NOW_MS - 40 * 86_400_000u64, "oldestDirectUnreadSender": "someone-else", "urgencyMax": urgency,
            "archive_ready": false, "gates": {}, "pendingQuestions": []
        });
        let mut s = serde_json::json!({"generatedAt": NOW_MS, "workspaces": {CHILD: row}});
        if stale_registry {
            s["staleRegistryPartitions"] = serde_json::json!([{"id": CHILD, "worktreePath": wt, "unread": unread}]);
        }
        self.put(&format!("summaries/{}.json", self.key), s);
    }

    fn archive(&self, wt: &str) {
        let d = serde_json::json!({"id": CHILD, "worktreePath": wt, "sessionId": "sess-1"});
        self.put(&format!("archived/{CHILD}.json"), d.clone());
        self.put(&format!("workspaces/{CHILD}.json"), d);
    }

    fn settings(&self, on: bool) {
        std::fs::write(self.dir.join("home/.anti-hall/settings.json"), serde_json::json!({"devswarm": {"skipDeadChildren": on}}).to_string()).unwrap();
    }

    fn turn(&self) -> String {
        let map = self.dir.join("map.json");
        let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "UserPromptSubmit").into_iter().map(|x| x.id).collect();
        let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
        std::fs::write(&map, serde_json::json!({ "UserPromptSubmit": m }).to_string()).unwrap();
        let payload = serde_json::json!({"session_id": "dead-e2e", "hook_event_name": "UserPromptSubmit", "prompt": "hi", "cwd": self.repo}).to_string();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("GIT_CEILING_DIRECTORIES", &self.dir)
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "dead-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .current_dir(&self.repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        assert_eq!(o.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string()
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if std::env::var_os("AH_KEEP_SCRATCH").is_none() {
            ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
        }
    }
}

const NUDGE: &str = "devswarm-parent-inbox: 1 active workspace(s) need attention";
const URGENT: &str = "CHILD NOT DRAINING: STOP and poke it NOW";

#[test]
fn off_by_default_an_archived_worktree_gone_child_is_still_named_as_before() {
    let e = Env::new("off");
    let wt = e.worktree(false, true);
    e.summary(&wt, 3, "normal", false);
    e.archive(&wt);
    let out = e.turn();
    assert!(out.contains(NUDGE), "the root cause: anti-hall's own archive marker is ignored by the nudge, got: {out}");
    assert!(!e.dsdir().join(format!("expired/{CHILD}.json")).exists(), "nothing is marked while the switch is off");
}

#[test]
fn on_an_archived_worktree_gone_child_is_not_named_and_its_unread_is_marked_expired() {
    let e = Env::new("on");
    e.settings(true);
    let wt = e.worktree(false, true);
    e.summary(&wt, 3, "urgent", false);
    e.archive(&wt);
    let out = e.turn();
    assert!(!out.contains(NUDGE) && !out.contains(URGENT) && !out.contains("devswarm-archive-ready"), "silent, got: {out:?}");
    let mark: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.dsdir().join(format!("expired/{CHILD}.json"))).unwrap()).unwrap();
    assert_eq!(mark["through"], 3, "the backlog is marked expired up to its message count: {mark}");
    // a second turn is quiet too and does not rewrite the mark
    assert!(!e.turn().contains("need attention"));
}

#[test]
fn off_the_urgent_nudge_names_the_archived_worktree_gone_child_and_on_it_does_not() {
    let off = Env::new("urg-off");
    let wt = off.worktree(false, true);
    off.summary(&wt, 2, "urgent", false);
    off.archive(&wt);
    assert!(off.turn().contains(URGENT), "baseline: the old text fires");
    let on = Env::new("urg-on");
    on.settings(true);
    let wt = on.worktree(false, true);
    on.summary(&wt, 2, "urgent", false);
    on.archive(&wt);
    assert!(!on.turn().contains(URGENT));
}

#[test]
fn on_a_live_child_still_nudges() {
    let e = Env::new("live");
    e.settings(true);
    let wt = e.worktree(true, true);
    e.summary(&wt, 3, "normal", false);
    let out = e.turn();
    assert!(out.contains(NUDGE), "a child that is not archived and has its worktree is nagged, got: {out}");
    assert!(!e.dsdir().join(format!("expired/{CHILD}.json")).exists());
}

#[test]
fn on_a_worktree_under_a_missing_parent_is_not_proven_gone_and_still_nudges() {
    let e = Env::new("unmounted");
    e.settings(true);
    let wt = e.worktree(false, false);
    e.summary(&wt, 3, "normal", false);
    let out = e.turn();
    assert!(out.contains(NUDGE), "an unmounted volume is not a gone worktree, got: {out}");
}

#[test]
fn on_the_stale_workspaces_notice_drops_an_archived_row_and_names_the_step_for_a_gone_live_one() {
    let archived = Env::new("stale-arch");
    archived.settings(true);
    let wt = archived.worktree(false, true);
    archived.summary(&wt, 3, "normal", true);
    archived.archive(&wt);
    assert!(!archived.turn().contains("devswarm-stale-workspaces"));
    let gone = Env::new("stale-gone");
    gone.settings(true);
    let wt = gone.worktree(false, true);
    gone.summary(&wt, 3, "normal", true);
    let out = gone.turn();
    assert!(out.contains("devswarm-stale-workspaces") && out.contains("archive <id>"), "names the exact step, got: {out}");
    let old = Env::new("stale-off");
    let wt = old.worktree(false, true);
    old.summary(&wt, 3, "normal", true);
    old.archive(&wt);
    assert!(old.turn().contains("devswarm-stale-workspaces"), "baseline: off lists the archived row");
}
