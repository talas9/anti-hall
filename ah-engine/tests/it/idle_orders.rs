//! GH #744 through the real dispatcher (`ah-engine hook --event UserPromptSubmit`): a Primary whose project holds a live child workspace
//! that has been idle past `guards.idleOrderAfterMin` with no task and no unread mail is told once to report, reassign or archive it,
//! then again only on the escalating schedule; a busy, unread, archived or freshly active child is never named, and an idle child no
//! longer demands a mailbox wake path. GH #430 (a child judged done must not be nagged) stays silent. Scratch HOME only.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use super::archived_children::{CHILD, Env};
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};

const ORDER: &str = "idle with no task";
const NO_WAKE: &str = "NO MAILBOX WAKE PATH";

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64
}

/// One Primary turn (`UserPromptSubmit`) with `extra` environment variables on top of the scratch one.
fn turn(e: &Env, session: &str, extra: &[(&str, &str)]) -> String {
    run_event(e, "UserPromptSubmit", session, extra)
}

fn run_event(e: &Env, event: &str, session: &str, extra: &[(&str, &str)]) -> String {
    e.materialize();
    let map = e.dir.join("map.json");
    let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", event).into_iter().map(|x| x.id).collect();
    let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
    std::fs::write(&map, serde_json::json!({ event: m }).to_string()).unwrap();
    let payload = serde_json::json!({"session_id": session, "hook_event_name": event, "prompt": "hi", "cwd": e.repo}).to_string();
    let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
    c.args(["hook", "--event", event, "--fallback-map", map.to_str().unwrap()])
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap_or_default())
        .env("HOME", e.dir.join("home"))
        .env("GIT_CEILING_DIRECTORIES", &e.dir)
        .env("AH_ENGINE_DIR", e.dir.join("state"))
        .env("AH_ENGINE_VERSION", "idle-order-e2e")
        .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
        .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
        .env("CLAUDE_PLUGIN_ROOT", &e.dir)
        .env("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/anti-hall"))
        .current_dir(&e.repo)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in extra {
        c.env(k, v);
    }
    let mut ch = c.spawn().unwrap();
    ch.stdin.take().unwrap().write_all(payload.as_bytes()).unwrap();
    let o = ch.wait_with_output().unwrap();
    assert_eq!(o.status.code(), Some(0), "stderr: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).to_string()
}

/// The order record of the one project (the directory also holds the prune stamp).
fn record(e: &Env) -> std::path::PathBuf {
    let dir = e.dir.join("home/.anti-hall/idle-orders");
    std::fs::read_dir(dir)
        .unwrap()
        .map(|f| f.unwrap().path())
        .find(|p| p.file_name().unwrap().to_string_lossy().starts_with("idle-workspace-"))
        .expect("an order record")
}

/// The child's last heartbeat, `age_min` minutes ago.
fn beat(e: &Env, age_min: u64) {
    e.put(&format!("heartbeats/{CHILD}.json"), serde_json::json!({"ts": now_ms() - age_min * 60_000, "summary": "idle"}));
}

/// The child's checkout: a real git worktree of the Primary's repository (so the engine resolves it to the same project).
fn git_worktree(e: &Env) -> String {
    let git = |args: &[&str]| {
        let o = Command::new("git")
            .args(args)
            .current_dir(&e.repo)
            .env("GIT_CEILING_DIRECTORIES", &e.dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output()
            .unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    };
    git(&["commit", "-q", "--allow-empty", "-m", "init"]);
    let wt = e.dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
    std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
    git(&["worktree", "add", "-q", "-b", "child", wt.to_str().unwrap()]);
    wt.to_string_lossy().to_string()
}

/// A descriptor that names its (empty) inbox and cursor: the Stop gate then counts 0 unread instead of an unknown backlog.
fn with_inbox(e: &Env) {
    let wt = e.dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
    let (inbox, cursor) = (e.dir.join("child-inbox.ndjson"), e.dir.join("child-cursor.json"));
    std::fs::write(&inbox, "").unwrap();
    std::fs::write(&cursor, r#"{"line":0}"#).unwrap();
    e.put(
        &format!("workspaces/{CHILD}.json"),
        serde_json::json!({"id": CHILD, "worktreePath": wt, "sessionId": "sess-1", "inboxPath": inbox, "cursorPath": cursor}),
    );
}

fn idle_child(name: &str, unread: u32, age_min: u64) -> Env {
    let e = Env::new(name);
    let wt = git_worktree(&e);
    e.summary(&wt, unread, "normal", false);
    e.materialize();
    beat(&e, age_min);
    e
}

#[test]
fn idle_task_less_child_gets_one_order_then_waits_for_the_interval() {
    let e = idle_child("order-once", 0, 45);
    let first = turn(&e, "idle-ord-1", &[]);
    assert!(
        first.contains(ORDER) && first.contains("archive-request") && first.contains(CHILD),
        "the order names the child and the exact command, got: {first}"
    );
    let second = turn(&e, "idle-ord-1", &[]);
    assert!(!second.contains(ORDER), "the next turn is inside the interval: no repeat, got: {second}");
}

#[test]
fn order_escalates_on_the_schedule() {
    let e = idle_child("order-esc", 0, 45);
    assert!(turn(&e, "idle-ord-2", &[]).contains(ORDER));
    // age the record past the first gap (30 min): the second order is due
    let rec = record(&e);
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    v["subjects"][CHILD]["lastAt"] = serde_json::json!(now_ms() - 31 * 60_000);
    std::fs::write(&rec, v.to_string()).unwrap();
    let again = turn(&e, "idle-ord-2", &[]);
    assert!(again.contains(ORDER), "the second order is due after the first gap, got: {again}");
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    assert_eq!(v["subjects"][CHILD]["count"], 2);
}

#[test]
fn recently_active_unread_archived_or_switched_off_child_gets_no_order() {
    let fresh = idle_child("order-fresh", 0, 5);
    assert!(!turn(&fresh, "idle-ord-3", &[]).contains(ORDER), "a child with a fresh heartbeat is not idle");

    let unread = idle_child("order-unread", 3, 45);
    assert!(!turn(&unread, "idle-ord-4", &[]).contains(ORDER), "a child with unread mail is not an idle task-less child");

    let archived = idle_child("order-archived", 0, 45);
    archived.archive(&archived.dir.join("home/.devswarm/repos/3/8205fc11/child-wt").to_string_lossy());
    assert!(!turn(&archived, "idle-ord-5", &[]).contains(ORDER), "an archived child is silent");

    let off = idle_child("order-off", 0, 45);
    std::fs::write(off.dir.join("home/.anti-hall/settings.json"), r#"{"guards":{"idleOrder":false}}"#).unwrap();
    assert!(!turn(&off, "idle-ord-6", &[]).contains(ORDER), "the switch off gives no order");
}

#[test]
fn acted_on_clears_the_record_and_counts() {
    let e = idle_child("order-acted", 0, 45);
    assert!(turn(&e, "idle-ord-7", &[]).contains(ORDER));
    beat(&e, 1); // the child was given work and reports again
    assert!(!turn(&e, "idle-ord-7", &[]).contains(ORDER));
    let rec = record(&e);
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    assert!(v["subjects"].as_object().unwrap().is_empty(), "the order record is cleared once the child is active again: {v}");
}

#[test]
fn idle_child_needs_no_mailbox_wake_path_but_an_active_one_does() {
    let claude = [("DEVSWARM_AI_AGENT", "claude")];
    let idle = idle_child("wake-idle", 0, 45);
    let out = turn(&idle, "idle-wake-1", &claude);
    assert!(!out.contains(NO_WAKE), "an idle task-less child must not demand a wake-watch/cron, got: {out}");
    let active = idle_child("wake-active", 0, 1);
    let out = turn(&active, "idle-wake-2", &claude);
    assert!(out.contains(NO_WAKE), "control: a recently active child still needs the wake path, got: {out}");
}

#[test]
fn stop_block_does_not_demand_a_wake_path_for_an_idle_task_less_child() {
    let claude = [("DEVSWARM_AI_AGENT", "claude")];
    let detail = |e: &Env| std::fs::read_to_string(e.dir.join("home/.anti-hall/block-details/devswarm-parent-gate-session.md")).unwrap_or_default();
    let idle = idle_child("stop-idle", 0, 45);
    with_inbox(&idle);
    let out = run_event(&idle, "Stop", "idle-stop-1", &claude);
    assert!(
        !out.contains("\"block\"") && !out.contains(NO_WAKE) && !detail(&idle).contains(NO_WAKE),
        "an idle task-less child: the Stop gate asks for no watcher or cron, got: {out}"
    );
    let active = idle_child("stop-active", 0, 1);
    with_inbox(&active);
    let out = run_event(&active, "Stop", "idle-stop-2", &claude);
    assert!(out.contains(NO_WAKE), "control: an active child still gets the wake-path block, got: {out}");
}
