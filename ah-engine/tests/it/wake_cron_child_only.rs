//! #709: the Primary's mailbox-wake cron only while a child workspace is alive (`devswarm.wakeCronOnlyWithChild`), through the real
//! dispatcher (`ah-engine hook --event UserPromptSubmit|SessionStart`). A cron tick is a full model turn: with no live child it only costs
//! tokens. The switch off keeps the always-armed cron. The Monitor wake-watch is the contact channel in both.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const CHILD: &str = "11111111-aaaa-4bbb-8ccc-222222222222";
const NOW_MS: u64 = 1_900_000_000_000;
const ORDER: &str = "Mailbox cron: no live workspace remains";
const WAKE_LINE: &str = "NO MAILBOX WAKE PATH";
const MONITOR_HINT: &str = "Monitor";

struct Env {
    dir: PathBuf,
    repo: PathBuf,
    key: String,
    primary: String,
}

impl Env {
    fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("aha-wcc-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(dir.join("home/.anti-hall/devswarm/summaries")).unwrap();
        for args in [&["init", "-q"][..], &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]] {
            let o = Command::new("git").args(args).current_dir(&repo).env("GIT_CEILING_DIRECTORIES", &dir).output().unwrap();
            assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        }
        let key = ah_engine::meshw::ident::repo_key_for_worktree(repo.to_str().unwrap()).unwrap().expect("a repo key");
        let primary = ah_engine::meshw::ident::primary_workspace_id(repo.to_str().unwrap()).unwrap();
        Env { dir, repo, key, primary }
    }

    fn dsdir(&self) -> PathBuf {
        self.dir.join("home/.anti-hall/devswarm")
    }

    fn put(&self, rel: &str, v: &serde_json::Value) {
        let p = self.dsdir().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }

    fn switch(&self, on: bool) {
        std::fs::write(self.dir.join("home/.anti-hall/settings.json"), serde_json::json!({"devswarm": {"wakeCronOnlyWithChild": on}}).to_string()).unwrap();
    }

    /// One live child (a descriptor, a registry row and the summary built from them), the way `archived_children` lays it out.
    fn live_child(&self) {
        use ah_engine::meshw::store::{MeshStore, RegistryRow};
        // a real git worktree of the Primary's repository: the live-child test matches the child to the project by its repository
        let wt = self.dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        let o = Command::new("git").args(["worktree", "add", "-q", "-b", "child", wt.to_str().unwrap()]).current_dir(&self.repo).env("GIT_CEILING_DIRECTORIES", &self.dir).output().unwrap();
        assert!(o.status.success(), "git worktree add: {}", String::from_utf8_lossy(&o.stderr));
        let wt = wt.to_string_lossy().to_string();
        let home = self.dir.join("home");
        let st = MeshStore::open(&self.dsdir().join("store").join(&self.key).join("devswarm.db")).unwrap();
        let row = RegistryRow { id: CHILD.into(), worktree_path: Some(wt.clone()), session_id: Some("sess-1".into()), ..RegistryRow::default() };
        st.upsert_registry(&row, NOW_MS as i64, |a, b| a == b).unwrap();
        self.put(&format!("workspaces/{CHILD}.json"), &serde_json::json!({"id": CHILD, "worktreePath": wt, "sessionId": "sess-1"}));
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

    fn mtime(&self, rel: &str, secs: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(self.dsdir().join(rel)).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + secs)).unwrap();
    }

    fn no_child(&self) {
        let _ = std::fs::remove_file(self.dsdir().join(format!("workspaces/{CHILD}.json"))); // a scratch dir of this test, not user data
    }

    /// The Primary's inbox-tick marker, `ago_ms` old.
    fn tick_marker(&self, ago_ms: u64) {
        self.put(&format!("wake-tick/{}.json", self.primary), &serde_json::json!({"ts": now_ms() - ago_ms}));
    }

    fn cron_ctl(&self, session: &str) -> Option<serde_json::Value> {
        std::fs::read_to_string(self.dsdir().join(format!("cron-ctl/{session}.json"))).ok().map(|t| serde_json::from_str(&t).unwrap())
    }

    fn run(&self, event: &str, payload: &serde_json::Value, agent: &str) -> String {
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
            .env("AH_ENGINE_VERSION", "wcc-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
            .env("DEVSWARM_AI_AGENT", agent)
            .env("CLAUDE_PLUGIN_ROOT", &self.dir)
            .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
            .current_dir(&self.repo)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut ch = c.spawn().unwrap();
        ch.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let o = ch.wait_with_output().unwrap();
        assert_eq!(o.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).to_string()
    }

    /// The child has an empty inbox and a cursor at 0: the mail duty is clean, so a Stop reaches the clean pass where the wake block lives.
    fn quiet_mail(&self) {
        let wt = self.dir.join("home/.devswarm/repos/3/8205fc11/child-wt").to_string_lossy().to_string();
        let (inbox, cursor) = (self.dsdir().join("child-inbox.jsonl"), self.dsdir().join("child-cursor"));
        std::fs::write(&inbox, "").unwrap();
        std::fs::write(&cursor, "0").unwrap();
        self.put(&format!("workspaces/{CHILD}.json"), &serde_json::json!({"id": CHILD, "worktreePath": wt, "sessionId": "sess-1", "inboxPath": inbox, "cursorPath": cursor}));
    }

    /// A live Monitor wake-watch of the Primary: a fresh lock held by this (running) test process.
    fn watcher_live(&self) {
        self.put(&format!("locks/wake-watch-{}.json", self.primary).replace(".json", ".lock"), &serde_json::json!({"ts": now_ms(), "pid": std::process::id()}));
    }

    /// The child's session transcript, last turn open on a question to the human: the child is waiting, its session alive.
    fn child_waiting(&self) {
        let wt = self.dir.join("home/.devswarm/repos/3/8205fc11/child-wt"); // as the descriptor names it, not canonicalised
        let enc: String = wt.to_string_lossy().chars().map(|c| if "/\\:.".contains(c) { '-' } else { c }).collect();
        let f = self.dir.join("home/.claude/projects").join(enc).join("sess-1.jsonl");
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        // the live session: a record naming a running process (this test's own), which is what makes the waiting verdict count
        let sessions = self.dir.join("home/.claude/sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("child.json"), serde_json::json!({"sessionId": "sess-1", "pid": std::process::id()}).to_string()).unwrap();
        let ts = |s: u32| format!("2026-11-10T10:00:{s:02}.000Z");
        let lines = [
            serde_json::json!({"type": "user", "timestamp": ts(0), "message": {"role": "user", "content": "go"}}),
            serde_json::json!({"type": "assistant", "timestamp": ts(1), "message": {"content": [{"type": "tool_use", "id": "toolu_1", "name": "AskUserQuestion", "input": {"question": "Which one?"}}]}}),
        ];
        std::fs::write(f, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n") + "\n").unwrap();
    }

    /// A Stop of the Primary's session, the clean-pass shape (no hook already active).
    fn stop(&self, session: &str) -> String {
        let t = self.dir.join(format!("transcript-{session}.jsonl"));
        std::fs::write(&t, "").unwrap();
        self.run("Stop", &serde_json::json!({"session_id": session, "hook_event_name": "Stop", "cwd": self.repo, "transcript_path": t, "stop_hook_active": false}), "claude")
    }

    fn turn(&self, session: &str, agent: &str) -> String {
        self.run("UserPromptSubmit", &serde_json::json!({"session_id": session, "hook_event_name": "UserPromptSubmit", "prompt": "hi", "cwd": self.repo}), agent)
    }

    /// The SessionStart output, with the full text of anything the engine spilled to a file because it was over the injection cap.
    fn start(&self, session: &str, source: &str, agent: &str) -> String {
        let spill = self.dir.join("state/context-spill");
        let names = |d: &Path| -> Vec<PathBuf> { std::fs::read_dir(d).map(|r| r.flatten().map(|e| e.path()).collect()).unwrap_or_default() };
        let before = names(&spill);
        let mut out = self.run("SessionStart", &serde_json::json!({"session_id": session, "hook_event_name": "SessionStart", "source": source, "cwd": self.repo}), agent);
        for f in names(&spill).into_iter().filter(|f| !before.contains(f)) {
            out.push_str(&std::fs::read_to_string(f).unwrap_or_default());
        }
        out
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        if std::env::var_os("AH_KEEP_SCRATCH").is_none() {
            ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

#[test]
fn with_no_live_child_a_primary_is_ordered_once_to_delete_its_cron() {
    let e = Env::new("order-once");
    let first = e.turn("s1", "claude");
    assert!(first.contains(ORDER) && first.contains("CronDelete"), "no live child: the order to delete the cron, got: {first:?}");
    assert_eq!(e.cron_ctl("s1").unwrap()["deleted"], true, "the order is recorded");
    // every later turn of the session (a cron tick's own turn included) stays quiet: ONE order
    for _ in 0..3 {
        let again = e.turn("s1", "claude");
        assert!(!again.contains(ORDER), "the order is not repeated, got: {again:?}");
    }
}

#[test]
fn a_live_child_means_no_order_and_the_switch_off_keeps_the_old_behaviour() {
    let e = Env::new("live-and-off");
    e.live_child();
    let live = e.turn("s1", "claude");
    assert!(!live.contains(ORDER), "a live child keeps its cron, got: {live:?}");
    assert!(e.cron_ctl("s1").is_none(), "nothing recorded while a child is alive");
    e.no_child();
    e.switch(false);
    let off = e.turn("s2", "claude");
    assert!(!off.contains(ORDER), "switch off: no order, got: {off:?}");
    assert!(e.cron_ctl("s2").is_none());
    // a Primary that is not claude has no cron to delete
    e.switch(true);
    let other = e.turn("s3", "codex");
    assert!(!other.contains(ORDER), "not claude: no order, got: {other:?}");
}

#[test]
fn the_first_live_child_after_the_delete_gets_the_cron_back_at_once() {
    let e = Env::new("rearm");
    assert!(e.turn("s1", "claude").contains(ORDER));
    // the Primary's last tick ran 5 minutes before the delete order: a marker that is still fresh by cronMissingWarnMin (60)
    e.tick_marker(5 * 60_000);
    e.live_child();
    let out = e.turn("s1", "claude");
    assert!(out.contains(WAKE_LINE) && out.contains("CronCreate"), "the live child is asked for the cron and the watcher at once, got: {out:?}");
    // control: the same marker, but the switch off: the fresh marker keeps the wake line silent (so the marker IS read)
    let c = Env::new("rearm-control");
    c.switch(false);
    c.tick_marker(5 * 60_000);
    c.live_child();
    let out = c.turn("s1", "claude");
    assert!(!out.contains(WAKE_LINE), "a fresh tick marker is no wake-path gap, got: {out:?}");
}

#[test]
fn a_tick_after_the_delete_spends_the_record_and_the_next_empty_moment_orders_again() {
    let e = Env::new("spent");
    assert!(e.turn("s1", "claude").contains(ORDER));
    e.live_child();
    e.tick_marker(0); // the cron is back and has ticked since the delete order
    let _ = e.turn("s1", "claude");
    assert_eq!(e.cron_ctl("s1").unwrap()["deleted"], false, "the record is spent once a tick ran after the order");
    e.no_child();
    let out = e.turn("s1", "claude");
    assert!(out.contains(ORDER), "the last child is gone again: ordered again, got: {out:?}");
}

#[test]
fn a_new_session_starts_with_the_monitor_alone_and_is_not_ordered_to_delete_a_cron_it_never_had() {
    let e = Env::new("start");
    let dir = e.start("s1", "startup", "claude");
    let at = dir.find("MAILBOX WAKE").unwrap_or(0);
    let wake = &dir[at..dir.len().min(at + 1800)];
    assert!(wake.contains("Monitor") && !wake.contains("CronCreate` with schedule"), "the Monitor alone is armed, got: {wake:?}");
    assert!(dir.contains("Do NOT create a mailbox cron"), "got: {dir:?}");
    assert_eq!(e.cron_ctl("s1").unwrap()["deleted"], true, "the session is recorded as cron-less");
    assert!(!e.turn("s1", "claude").contains(ORDER), "so it is not ordered to delete one");
    // a resumed session may still hold a cron armed before: no seed, so the first turn orders the delete
    let _ = e.start("s2", "resume", "claude");
    assert!(e.cron_ctl("s2").is_none());
    assert!(e.turn("s2", "claude").contains(ORDER));
    // the switch off: the old directive, with the cron
    e.switch(false);
    let old = e.start("s3", "startup", "claude");
    assert!(old.contains("CronCreate"), "switch off: the always-armed cron directive, got: {old:?}");
    assert!(e.cron_ctl("s3").is_none());
}

#[test]
fn an_ignored_child_is_alive_so_its_cron_is_kept_but_an_archived_one_is_not() {
    // ignored (archive-ignore mark): still tracked, so the Primary keeps the cron and is not told it is gone
    let e = Env::new("ignored");
    e.live_child();
    e.put(&format!("archive-ignore/{CHILD}.json"), &serde_json::json!({}));
    let out = e.turn("s1", "claude");
    assert!(!out.contains(ORDER), "an ignored child is alive, got: {out:?}");
    assert!(e.cron_ctl("s1").is_none());
    // archived (marker written after the descriptor, same session): no child is alive
    let a = Env::new("archived");
    a.live_child();
    a.put(&format!("archived/{CHILD}.json"), &serde_json::json!({"id": CHILD, "archivedAt": 100, "sessionId": "sess-1"}));
    a.mtime(&format!("workspaces/{CHILD}.json"), 50);
    a.mtime(&format!("archived/{CHILD}.json"), 100);
    let out = a.turn("s1", "claude");
    assert!(out.contains(ORDER), "an archived child does not count, got: {out:?}");
}

#[test]
fn stop_with_a_live_child_and_a_live_monitor_does_not_block() {
    // after a mid-turn spawn the Monitor carries delivery (the cron is not armed): a live watcher is a wake path, so the Stop gate is quiet
    let e = Env::new("stop-monitor");
    e.live_child();
    e.quiet_mail();
    e.watcher_live();
    let out = e.stop("s1");
    assert!(!out.contains(WAKE_LINE) && !out.contains("\"block\""), "a live watcher covers delivery, got: {out:?}");
    assert!(!out.contains(ORDER), "a live child keeps the cron: no delete order, got: {out:?}");
}

#[test]
fn stop_with_a_live_child_and_a_dead_monitor_blocks_with_the_directive_to_rearm_both() {
    let e = Env::new("stop-dead");
    e.live_child();
    e.quiet_mail();
    let out = e.stop("s1");
    assert!(out.contains("\"block\"") && out.contains(WAKE_LINE), "the dead watcher blocks the Stop with the wake line, got: {out:?}");
    assert!(out.contains(MONITOR_HINT) && out.contains("CronCreate"), "the directive re-arms the Monitor and the cron, got: {out:?}");
}

#[test]
fn a_waiting_child_with_a_live_session_keeps_the_cron() {
    let e = Env::new("waiting");
    e.live_child();
    e.quiet_mail();
    e.child_waiting();
    let out = e.turn("s1", "claude");
    assert!(!out.contains(ORDER), "a waiting child is still alive: its cron is kept, got: {out:?}");
    assert!(e.cron_ctl("s1").is_none(), "no delete recorded");
    // the Stop gate neither orders it deleted nor asks for a wake path: a waiting-on-human child sends no mail, and with the dead
    // watcher of the sibling test the same fixture would otherwise block with the wake line (proves the child was read as waiting)
    let stop = e.stop("s1");
    assert!(!stop.contains(ORDER) && !stop.contains(WAKE_LINE), "got: {stop:?}");
}

// #709 F5: the plugin-owned session watcher is the same merged wake path as a model-owned Monitor.
#[test]
fn wake_watch_session_heartbeat_suppresses_the_inbox_monitor_directive() {
    let e = Env::new("session-watch");
    e.live_child();
    let armed = e.dir.join("home/.anti-hall/agent-tracker/wake/s1.armed");
    std::fs::create_dir_all(armed.parent().unwrap()).unwrap();
    std::fs::write(armed, "").unwrap();
    let out = e.turn("s1", "claude");
    assert!(!out.contains(WAKE_LINE), "a live plugin watcher must not order a model Monitor: {out}");
    assert!(out.contains("NO MAILBOX TICK"), "the independent cron fallback remains available: {out}");
}

#[test]
fn wake_watch_missing_monitor_directive_is_state_change_only() {
    let e = Env::new("watch-state");
    std::fs::write(e.dir.join("home/.anti-hall/settings.json"), r#"{"guards":{"emitDedupe":false}}"#).unwrap();
    e.live_child();
    assert!(e.turn("s1", "claude").contains(WAKE_LINE));
    for _ in 0..8 {
        let out = e.turn("s1", "claude");
        assert!(!out.contains(WAKE_LINE), "an unchanged missing watcher must not order re-arm on every prompt: {out}");
    }
}

#[test]
fn wake_watch_tracker_reminder_is_once_per_unarmed_state_with_expiry_cooldown() {
    let cd = ah_engine::defaults::raw("agent_tracker.cooldowns").get("monitor_unarmed").unwrap();
    assert_eq!(cd.get("once").and_then(ah_engine::defaults::V::as_bool), Some(true));
    assert!(cd.get("cooldown_ms").and_then(ah_engine::defaults::V::as_integer).unwrap() >= ah_engine::defaults::num("agent_tracker.wake_timeout_ms") as i64);
}

#[test]
fn wake_watch_live_session_start_keeps_the_plugin_watcher() {
    let e = Env::new("session-start-watch");
    let armed = e.dir.join("home/.anti-hall/agent-tracker/wake/s1.armed");
    std::fs::create_dir_all(armed.parent().unwrap()).unwrap();
    std::fs::write(armed, "").unwrap();
    let out = e.start("s1", "resume", "claude");
    assert!(!out.contains("call `Monitor`"), "a live plugin watcher must not order a duplicate model Monitor: {out}");
}

#[test]
fn wake_watch_recovery_then_expiry_starts_one_new_episode_after_cooldown() {
    let e = Env::new("watch-recovery");
    e.live_child();
    assert!(e.turn("s1", "claude").contains(WAKE_LINE));
    let armed = e.dir.join("home/.anti-hall/agent-tracker/wake/s1.armed");
    std::fs::create_dir_all(armed.parent().unwrap()).unwrap();
    std::fs::write(&armed, "").unwrap();
    assert!(!e.turn("s1", "claude").contains(WAKE_LINE));
    let f = std::fs::OpenOptions::new().write(true).open(&armed).unwrap();
    f.set_modified(std::time::UNIX_EPOCH).unwrap();
    assert!(!e.turn("s1", "claude").contains(WAKE_LINE), "a flap inside the expiry cooldown stays quiet");
    let ctl = e.dir.join("home/.anti-hall/devswarm/wake-ctl/s1.json");
    let mut rec: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&ctl).unwrap()).unwrap();
    rec["lastPrompt"] = serde_json::json!(0);
    std::fs::write(ctl, rec.to_string()).unwrap();
    // Generic dedupe can suppress the same text: the episode gate itself is independent of it.
    std::fs::write(e.dir.join("home/.anti-hall/settings.json"), r#"{"guards":{"emitDedupe":false}}"#).unwrap();
    assert!(e.turn("s1", "claude").contains(WAKE_LINE), "expired heartbeat + elapsed cooldown allows one new order");
    assert!(!e.turn("s1", "claude").contains(WAKE_LINE));
}

#[test]
fn wake_watch_recent_cron_tick_does_not_spend_a_missing_watcher_order() {
    let e = Env::new("watch-tick");
    e.switch(false);
    e.live_child();
    e.tick_marker(0);
    assert!(!e.turn("s1", "claude").contains(WAKE_LINE));
    e.tick_marker(120 * 60_000);
    assert!(e.turn("s1", "claude").contains(WAKE_LINE));
}

#[test]
fn wake_watch_live_session_heartbeat_covers_the_stop_gate() {
    let e = Env::new("session-stop-watch");
    e.live_child();
    e.quiet_mail();
    let armed = e.dir.join("home/.anti-hall/agent-tracker/wake/s1.armed");
    std::fs::create_dir_all(armed.parent().unwrap()).unwrap();
    std::fs::write(armed, "").unwrap();
    let out = e.stop("s1");
    assert!(!out.contains(WAKE_LINE) && !out.contains("\"block\""), "the plugin watcher covers stop delivery: {out}");
}

#[test]
fn wake_watch_live_heartbeat_drops_only_obsolete_rearm_reminders() {
    let e = Env::new("watch-reminders");
    let dir = e.dir.join("home/.anti-hall/agent-tracker");
    std::fs::create_dir_all(dir.join("reminders")).unwrap();
    std::fs::create_dir_all(dir.join("wake")).unwrap();
    std::fs::write(dir.join("wake/s1.armed"), "").unwrap();
    let rows = [
        serde_json::json!({"id":"old-rearm", "signal":"monitor_unarmed", "agent":"s1", "text":"OBSOLETE_REARM_ORDER"}),
        serde_json::json!({"id":"real-event", "signal":"watched_exit", "agent":"child", "text":"REAL_AGENT_COMPLETION"}),
    ];
    std::fs::write(dir.join("reminders/s1.ndjson"), rows.iter().map(|r| r.to_string()).collect::<Vec<_>>().join("\n") + "\n").unwrap();
    let mut out = e.turn("s1", "claude");
    // The dispatcher can spill the combined context; inspect the actual delivered text, too.
    if let Ok(files) = std::fs::read_dir(e.dir.join("state/context-spill")) {
        for file in files.flatten() {
            out.push_str(&std::fs::read_to_string(file.path()).unwrap_or_default());
        }
    }
    assert!(!out.contains("OBSOLETE_REARM_ORDER"), "live plugin watcher suppresses an obsolete queued Monitor nag: {out}");
    assert!(out.contains("REAL_AGENT_COMPLETION"), "real agent events must still reach the session: {out}");
    assert_eq!(std::fs::read_to_string(dir.join("reminders/s1.ndjson.cursor")).unwrap(), "2");
}
