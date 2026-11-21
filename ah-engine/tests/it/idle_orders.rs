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
    git_worktree_at(e, None)
}

/// [`git_worktree`] whose first commit is dated `date` (a worktree whose last delivery is old).
fn git_worktree_at(e: &Env, date: Option<&str>) -> String {
    let git = |args: &[&str]| {
        let o = Command::new("git")
            .args(args)
            .current_dir(&e.repo)
            .env("GIT_CEILING_DIRECTORIES", &e.dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_DATE", date.unwrap_or(""))
            .env("GIT_AUTHOR_DATE", date.unwrap_or(""))
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
fn child_judged_done_is_never_ordered_gh430() {
    // GH #430: a workspace whose done ruling stands (archive approved) must not be nagged, idle or not
    let e = idle_child("order-done", 0, 45);
    let st = ah_engine::meshw::store::MeshStore::open(&e.dsdir().join("store").join(&e.key).join("devswarm.db")).unwrap();
    for gate in ["done", "merged", "tests_passed"] {
        st.set_gate(CHILD, gate, true, "test", now_ms() as i64).unwrap();
    }
    let out = turn(&e, "idle-ord-done", &[]);
    assert!(!out.contains(ORDER), "a child judged done gets no idle order, got: {out}");
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

#[test]
fn a_briefly_suppressed_idle_child_keeps_its_escalation_record() {
    let e = idle_child("order-flap", 0, 45);
    assert!(turn(&e, "idle-ord-flap", &[]).contains(ORDER));
    // the child is still idle but now has unread mail (suppressed): its record must not be dropped, or the schedule would restart
    e.summary(&e.dir.join("home/.devswarm/repos/3/8205fc11/child-wt").to_string_lossy(), 2, "normal", false);
    assert!(!turn(&e, "idle-ord-flap", &[]).contains(ORDER));
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(record(&e)).unwrap()).unwrap();
    assert_eq!(v["subjects"][CHILD]["count"], 1, "the record survives a suppressed turn: {v}");
}

/// The child's step plan: `steps` are (text, status) pairs.
fn plan(e: &Env, steps: &[(&str, &str)]) {
    let wt = e.dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
    let steps: Vec<serde_json::Value> = steps.iter().enumerate().map(|(i, (t, s))| serde_json::json!({"n": i + 1, "text": t, "status": s})).collect();
    e.put(&format!("plans/{CHILD}.json"), serde_json::json!({"id": CHILD, "worktreePath": wt, "steps": steps, "created_at": now_ms() - 3_600_000}));
}

#[test]
fn a_finished_plan_does_not_count_as_open_gh744() {
    // the finish label is also given for a plan whose every step is done: that child is idle, not working
    let claude = [("DEVSWARM_AI_AGENT", "claude")];
    let done = idle_child("order-plan-done", 0, 45);
    plan(&done, &[("a", "done"), ("b", "done")]);
    let out = turn(&done, "idle-plan-1", &claude);
    assert!(out.contains(ORDER), "a taskless child whose plan is fully done gets the idle order, got: {out}");
    assert!(!out.contains(NO_WAKE), "and needs no mailbox wake path, got: {out}");
    // control: an unfinished plan is a child still working
    let open = idle_child("order-plan-open", 0, 45);
    plan(&open, &[("a", "done"), ("b", "doing")]);
    let out = turn(&open, "idle-plan-2", &claude);
    assert!(!out.contains(ORDER), "a child with an open plan is not ordered, got: {out}");
}

#[test]
fn unknown_or_untracked_plan_state_gives_no_order_gh744() {
    let claude = [("DEVSWARM_AI_AGENT", "claude")];
    // control: plan tracking on, no plan: the child is provably idle and is ordered
    let on = idle_child("order-track-on", 0, 45);
    assert!(turn(&on, "idle-track-1", &claude).contains(ORDER), "control: a provably idle child is ordered");
    // plan tracking off: whether a plan is open cannot be known, so idleness is not proven
    let off = idle_child("order-track-off", 0, 45);
    let out = turn(&off, "idle-track-2", &[("DEVSWARM_AI_AGENT", "claude"), ("ANTIHALL_DEVSWARM_PLAN_TRACKING", "0")]);
    assert!(!out.contains(ORDER), "plan tracking off: no idle order, got: {out}");
}

// ---- GH #876: stalled delivery, converge-or-archive, an archive-request that never completes ----

const STALL_FIRST: &str = "report working but delivered nothing";
const STALL_ORDER: &str = "still stalled";

/// A child that is working (fresh heartbeat) whose worktree last committed in 2020.
fn stalled_child(name: &str) -> Env {
    let e = Env::new(name);
    let wt = git_worktree_at(&e, Some("2020-01-01T00:00:00"));
    e.summary(&wt, 0, "normal", false);
    e.materialize();
    beat(&e, 1);
    e
}

fn stall_record(e: &Env, prefix: &str) -> std::path::PathBuf {
    let dir = e.dir.join("home/.anti-hall/idle-orders");
    std::fs::read_dir(dir)
        .unwrap()
        .map(|f| f.unwrap().path())
        .find(|p| p.file_name().unwrap().to_string_lossy().starts_with(prefix))
        .unwrap_or_else(|| panic!("no record {prefix}"))
}

/// Pretend the Primary first saw the child working `min` minutes ago.
fn first_seen(e: &Env, min: u64) {
    let rec = stall_record(e, "idle-since-");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    v["subjects"][CHILD]["at"] = serde_json::json!(now_ms() - min * 60_000);
    std::fs::write(&rec, v.to_string()).unwrap();
}

#[test]
fn working_child_with_no_commit_is_checked_then_ordered_to_converge_or_archive_gh876() {
    let e = stalled_child("stall-esc");
    let first_turn = turn(&e, "stall-1", &[]);
    assert!(!first_turn.contains(STALL_FIRST), "a child first seen working is not stalled yet (its 2020 base commit is not its progress), got: {first_turn}");
    first_seen(&e, 61);
    let first = turn(&e, "stall-1", &[]);
    assert!(first.contains(STALL_FIRST) && first.contains(CHILD), "no commit for the threshold: the status check names the child, got: {first}");
    assert!(!turn(&e, "stall-1", &[]).contains(STALL_FIRST), "inside the interval: no repeat");
    // age the order record past the first gap: the second is an order to converge or archive
    let rec = stall_record(&e, "idle-workspace_stall-");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    v["subjects"][CHILD]["lastAt"] = serde_json::json!(now_ms() - 31 * 60_000);
    std::fs::write(&rec, v.to_string()).unwrap();
    let again = turn(&e, "stall-1", &[]);
    assert!(
        again.contains(STALL_ORDER) && again.contains("converge") && again.contains("archive-request") && again.contains("unpushed"),
        "the repeat orders converge or archive, and says archive refuses unsaved work, got: {again}"
    );
}

#[test]
fn a_commit_or_a_fresh_worktree_is_progress_and_the_switch_turns_it_off_gh876() {
    // control: a worktree that just committed is not stalled whatever the watch time
    let fresh = idle_child("stall-fresh", 0, 1);
    turn(&fresh, "stall-2", &[]);
    first_seen(&fresh, 120);
    assert!(!turn(&fresh, "stall-2", &[]).contains(STALL_FIRST), "a recent commit is progress");
    // the switch
    let off = stalled_child("stall-off");
    std::fs::write(off.dir.join("home/.anti-hall/settings.json"), r#"{"guards":{"stallOrder":false}}"#).unwrap();
    turn(&off, "stall-3", &[]);
    assert!(
        !off.dir
            .join("home/.anti-hall/idle-orders")
            .read_dir()
            .map(|d| d.flatten().any(|f| f.file_name().to_string_lossy().starts_with("idle-since-")))
            .unwrap_or(false)
    );
    // a child that commits after being ordered is acted on and its record clears
    let e = stalled_child("stall-acted");
    turn(&e, "stall-4", &[]);
    first_seen(&e, 61);
    assert!(turn(&e, "stall-4", &[]).contains(STALL_FIRST));
    let wt = e.dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
    let o = Command::new("git")
        .args(["commit", "-q", "--allow-empty", "-m", "work"])
        .current_dir(&wt)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@e.invalid")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@e.invalid")
        .output()
        .unwrap();
    assert!(o.status.success());
    turn(&e, "stall-4", &[]);
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(stall_record(&e, "idle-workspace_stall-")).unwrap()).unwrap();
    assert!(v["subjects"].as_object().unwrap().is_empty(), "a commit is progress: the stall record clears, got {v}");
}

/// An unread archive-request in the child's partition (the only mail it has).
fn archive_request_mail(e: &Env) {
    let st = ah_engine::meshw::store::MeshStore::open(&e.dsdir().join("store").join(&e.key).join("devswarm.db")).unwrap();
    let m = ah_engine::meshw::store::MeshRow {
        workspace_id: CHILD.into(),
        ts: now_ms() as i64 - 40 * 60_000,
        hash: Some("req1".into()),
        body: "[[ANTIHALL_ARCHIVE_REQUEST]] please archive".into(),
        sender: Some("primary".into()),
        recipient: Some(CHILD.into()),
        mtype: Some("direct".into()),
        urgency: Some("normal".into()),
        is_heartbeat: false,
        needs_reply: false,
        orig_hash: None,
        instance_nonce: None,
    };
    st.append_mesh_row(&m).unwrap();
}

#[test]
fn an_unanswered_archive_request_does_not_silence_the_idle_order_gh876() {
    // the request is unread mail only the child can clear: before the fix it hid the child from the order that asked for it, forever
    let e = idle_child("req-pending", 0, 45);
    archive_request_mail(&e);
    let out = turn(&e, "req-1", &[]);
    assert!(out.contains(ORDER) && out.contains(CHILD), "a child that ignores its archive-request is still ordered, got: {out}");
    // control: other unread mail still silences it
    let other = idle_child("req-other-mail", 2, 45);
    assert!(!turn(&other, "req-2", &[]).contains(ORDER), "ordinary unread mail still keeps the child out of the idle order");
}

#[test]
fn the_idle_order_offers_exactly_converge_or_archive_and_names_archive_for_a_merged_child_gh876() {
    let e = idle_child("conv-merged", 0, 45);
    let first = turn(&e, "conv-1", &[]);
    assert!(first.contains("converge") && first.contains("Archive:") && first.contains("archive-request"), "converge or archive, got: {first}");
    assert!(!first.contains("archive now"), "not verified merged: no direct archive hint, got: {first}");
    let m = idle_child("conv-merged-2", 0, 45);
    let st = ah_engine::meshw::store::MeshStore::open(&m.dsdir().join("store").join(&m.key).join("devswarm.db")).unwrap();
    st.set_gate(CHILD, "merged_verified", true, "merged-verified:abc123", now_ms() as i64).unwrap();
    let out = turn(&m, "conv-2", &[]);
    assert!(out.contains("archive now") && out.contains(&format!("archive {CHILD}")), "a verified-merged idle child can be archived at once, got: {out}");
}

#[test]
fn mail_to_a_stalled_child_does_not_restart_its_stall_clock_gh876() {
    // the status check makes the Primary message the child; that unread mail silences one turn but must not reset the first-seen
    // baseline, or the ladder re-arms to the status check every cycle and never reaches the converge-or-archive order
    let e = stalled_child("stall-mail");
    turn(&e, "stall-5", &[]);
    first_seen(&e, 61);
    assert!(turn(&e, "stall-5", &[]).contains(STALL_FIRST));
    let st = ah_engine::meshw::store::MeshStore::open(&e.dsdir().join("store").join(&e.key).join("devswarm.db")).unwrap();
    let m = ah_engine::meshw::store::MeshRow {
        workspace_id: CHILD.into(),
        ts: now_ms() as i64 - 60_000,
        hash: Some("status1".into()),
        body: "what is your PR status and next step?".into(),
        sender: Some("primary".into()),
        recipient: Some(CHILD.into()),
        mtype: Some("direct".into()),
        urgency: Some("normal".into()),
        is_heartbeat: false,
        needs_reply: false,
        orig_hash: None,
        instance_nonce: None,
    };
    st.append_mesh_row(&m).unwrap();
    assert!(!turn(&e, "stall-5", &[]).contains(STALL_ORDER), "unread mail silences this turn");
    st.set_cursor(CHILD, 1_000_000, now_ms() as i64).unwrap();
    let rec = stall_record(&e, "idle-workspace_stall-");
    let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&rec).unwrap()).unwrap();
    v["subjects"][CHILD]["lastAt"] = serde_json::json!(now_ms() - 31 * 60_000);
    std::fs::write(&rec, v.to_string()).unwrap();
    let again = turn(&e, "stall-5", &[]);
    assert!(again.contains(STALL_ORDER), "mail read, still no commit: the ladder moves on to the order, got: {again}");
}

#[test]
fn a_worktree_git_cannot_date_is_unknown_never_stalled_gh876() {
    let e = stalled_child("stall-unknown");
    turn(&e, "stall-6", &[]);
    // HEAD on a branch with no commit: `git log -1` cannot say when the worktree last delivered
    let wt = e.dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
    let o = Command::new("git").args(["symbolic-ref", "HEAD", "refs/heads/unborn"]).current_dir(&wt).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    first_seen(&e, 61);
    let out = turn(&e, "stall-6", &[]);
    assert!(!out.contains(STALL_FIRST), "no commit date: unknown, not stalled, got: {out}");
}
