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
    /// What the next turn's summary is built from: (worktree, messages, urgency).
    pending: std::cell::RefCell<Option<(String, u32, String)>>,
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
        Env { dir, repo, key, pending: std::cell::RefCell::new(None) }
    }

    fn dsdir(&self) -> PathBuf {
        self.dir.join("home/.anti-hall/devswarm")
    }

    /// The child's worktree path, under the home like a DevSwarm repos root; `exists` makes the directory; `inside_home` false puts it
    /// outside the home (a path on a volume that may be unmounted).
    fn worktree(&self, exists: bool, inside_home: bool) -> String {
        let wt = if inside_home { self.dir.join("home/.devswarm/repos/3/8205fc11/child-wt") } else { self.dir.join("elsewhere/wts/child-wt") };
        if inside_home {
            std::fs::create_dir_all(self.dir.join("home/.devswarm/repos")).unwrap();
        } else {
            std::fs::create_dir_all(self.dir.join("elsewhere")).unwrap();
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

    /// The one child holds `unread` real messages (the newest of urgency `urgency`), 40 days old, in a real SQLite store; the summary
    /// the Primary's turn reads is computed from it by the engine at the start of each turn, `stale_registry` is not a parameter: the
    /// engine derives it from the registry row.
    fn summary(&self, wt: &str, unread: u32, urgency: &str, _stale_registry: bool) {
        *self.pending.borrow_mut() = Some((wt.to_string(), unread, urgency.to_string()));
    }

    fn materialize(&self) {
        use ah_engine::meshw::store::{MeshRow, MeshStore, RegistryRow};
        let Some((wt, unread, urgency)) = self.pending.borrow().clone() else { return };
        let home = self.dir.join("home");
        let st = MeshStore::open(&self.dsdir().join("store").join(&self.key).join("devswarm.db")).unwrap();
        let row = RegistryRow { id: CHILD.into(), worktree_path: Some(wt.clone()), session_id: Some("sess-1".into()), ..RegistryRow::default() };
        st.upsert_registry(&row, NOW_MS as i64, |a, b| a == b).unwrap();
        self.put(&format!("workspaces/{CHILD}.json"), serde_json::json!({"id": CHILD, "worktreePath": wt, "sessionId": "sess-1"}));
        for i in 0..unread {
            let m = MeshRow {
                workspace_id: CHILD.into(),
                ts: (NOW_MS - 40 * 86_400_000u64) as i64 + i64::from(i),
                hash: Some(format!("h{i}")),
                body: format!("message {i}"),
                sender: Some("someone-else".into()),
                recipient: Some(CHILD.into()),
                mtype: Some("direct".into()),
                urgency: Some(if i + 1 == unread { urgency.clone() } else { "normal".into() }),
                is_heartbeat: false,
                needs_reply: false,
                orig_hash: None,
                instance_nonce: None,
            };
            st.append_mesh_row(&m).unwrap(); // a duplicate hash from the previous turn is ignored
        }
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
        self.put(&format!("summaries/{}.json", self.key), serde_json::from_str(&sum.stringify()).unwrap());
    }

    fn archive(&self, wt: &str) {
        let d = serde_json::json!({"id": CHILD, "worktreePath": wt, "sessionId": "sess-1", "archivedAt": 100});
        self.put(&format!("archived/{CHILD}.json"), d);
    }

    fn settings(&self, on: bool) {
        std::fs::write(self.dir.join("home/.anti-hall/settings.json"), serde_json::json!({"devswarm": {"skipDeadChildren": on}}).to_string()).unwrap();
    }

    fn turn(&self) -> String {
        self.materialize();
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
}

/// The unread count the summary file holds for the one child, as a number.
fn summary_unread(e: &Env) -> (serde_json::Value, serde_json::Value) {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.dsdir().join(format!("summaries/{}.json", e.key))).unwrap()).unwrap();
    (v["workspaces"][CHILD]["unread"].clone(), v)
}

#[test]
fn on_an_archived_worktree_gone_child_is_not_named_and_its_unread_count_stays_raw() {
    let e = Env::new("on");
    e.settings(true);
    let wt = e.worktree(false, true);
    e.summary(&wt, 3, "urgent", false);
    e.archive(&wt);
    let out = e.turn();
    assert!(!out.contains(NUDGE) && !out.contains(URGENT) && !out.contains("devswarm-archive-ready"), "silent, got: {out:?}");
    let (unread, _) = summary_unread(&e);
    assert_eq!(unread, 3, "the summary still counts the backlog: nothing is marked or hidden");
    assert!(!e.dsdir().join("expired").exists(), "no mark is written anywhere");
    assert!(!e.turn().contains("need attention"), "a second turn is quiet too");
    assert_eq!(summary_unread(&e).0, 3);
}

#[test]
fn the_summary_is_the_same_whatever_the_switch_with_an_archived_dead_child_and_unread_mail() {
    // the control: the summary is computed by code this change does not touch, so an archived dead child with unread mail counts the same
    // with the switch off (the behaviour before this change) and on; only the reminders differ
    let off = Env::new("sum-off");
    let wt = off.worktree(false, true);
    off.summary(&wt, 4, "normal", false);
    off.archive(&wt);
    off.turn();
    let on = Env::new("sum-on");
    on.settings(true);
    let wt2 = on.worktree(false, true);
    on.summary(&wt2, 4, "normal", false);
    on.archive(&wt2);
    on.turn();
    let (u_off, v_off) = summary_unread(&off);
    let (u_on, v_on) = summary_unread(&on);
    assert_eq!(u_off, 4);
    assert_eq!(u_on, 4);
    let strip = |v: &serde_json::Value, wt: &str| v["workspaces"].to_string().replace(wt, "<wt>");
    assert_eq!(strip(&v_off, &wt), strip(&v_on, &wt2), "the workspaces section is identical");
}

#[test]
fn an_archive_complete_dead_child_is_never_named_and_its_unread_stays_raw_in_the_summary() {
    // archived AND its descriptor moved away (archive-complete): it is not a workspace row at all, so no nudge names it with the
    // switch on or off; its unread stays in the summary's archived-stranded list
    for on in [false, true] {
        let e = Env::new(if on { "complete-on" } else { "complete-off" });
        if on {
            e.settings(true);
        }
        let wt = e.worktree(false, true);
        e.summary(&wt, 3, "urgent", false);
        e.archive(&wt);
        e.materialize();
        std::fs::remove_file(e.dsdir().join(format!("workspaces/{CHILD}.json"))).unwrap();
        e.pending.borrow_mut().take(); // the summary on disk stays as computed with the descriptor gone below
        let inv_home = e.dir.join("home");
        let st = ah_engine::meshw::store::MeshStore::open(&e.dsdir().join("store").join(&e.key).join("devswarm.db")).unwrap();
        let inv = ah_engine::meshw::common::Inv {
            home: inv_home.clone(),
            env: Default::default(),
            cwd: e.repo.to_string_lossy().to_string(),
            now: NOW_MS as i64,
            stdin: None,
            write_home: inv_home,
            store_override: None,
        };
        let Ok(sum) = ah_engine::meshw::summary::compute(&st, &inv, None) else { panic!("summary") };
        let sum = sum.stringify();
        e.put(&format!("summaries/{}.json", e.key), serde_json::from_str(&sum).unwrap());
        let v: serde_json::Value = serde_json::from_str(&sum).unwrap();
        assert!(v["workspaces"].get(CHILD).is_none(), "an archive-complete child is not a workspace row: {sum}");
        let listed = |k: &str| v[k].as_array().is_some_and(|a| a.iter().any(|x| x["id"] == CHILD && x["unread"] == 3));
        assert!(listed("archivedStranded") || listed("orphans"), "its raw unread stays in the summary (on={on}): {sum}");
        let out = e.turn();
        assert!(!out.contains(NUDGE) && !out.contains(URGENT), "no per-workspace nudge (on={on}), got: {out:?}");
        assert!(
            listed("archivedStranded") && !listed("orphans") && !out.contains("devswarm-orphaned-mesh"),
            "stranded, never an orphan notice (on={on}): {out:?}"
        );
    }
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
}

#[test]
fn on_a_worktree_outside_the_home_is_not_proven_gone_and_still_nudges() {
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

#[test]
fn on_a_worktree_that_is_merely_absent_never_silences_a_child_that_is_not_archived() {
    let e = Env::new("absent-live");
    e.settings(true);
    let wt = e.worktree(false, true);
    e.summary(&wt, 3, "urgent", false);
    let out = e.turn();
    assert!(out.contains(NUDGE) || out.contains(URGENT), "not archived: the reminder stays whatever the directory does, got: {out:?}");
    // the directory comes back: the same reminder, not a different one
    e.worktree(true, true);
    let back = e.turn();
    assert!(back.contains(NUDGE) || back.contains(URGENT), "got: {back:?}");
}

#[test]
fn on_an_archived_child_whose_worktree_is_present_is_not_dead() {
    let e = Env::new("archived-present");
    e.settings(true);
    let wt = e.worktree(true, true);
    e.summary(&wt, 3, "normal", false);
    e.archive(&wt);
    let out = e.turn();
    assert!(out.contains(NUDGE), "archived but its worktree exists: not provably dead, got: {out:?}");
}

#[test]
fn on_a_missing_worktree_behind_a_link_leaving_the_home_is_not_gone() {
    let e = Env::new("link-out");
    e.settings(true);
    let outside = e.dir.join("outside-real");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(e.dir.join("home/.devswarm/repos")).unwrap();
    std::os::unix::fs::symlink(&outside, e.dir.join("home/.devswarm/repos/link")).unwrap();
    let wt = e.dir.join("home/.devswarm/repos/link/child-wt").to_string_lossy().to_string();
    e.summary(&wt, 3, "normal", false);
    e.archive(&wt);
    let out = e.turn();
    assert!(out.contains(NUDGE), "a path absent only because a link points outside the home proves nothing, got: {out:?}");
}

/// The reminder text of a turn without its first paragraph (the rotating general tip is not part of this check), with the scratch
/// paths made stable.
fn stable(e: &Env, wt: &str, out: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(out).unwrap();
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    ctx.split_once("\n\n").map_or(ctx, |x| x.1).replace(wt, "<wt>").replace(&e.dir.to_string_lossy().to_string(), "<dir>")
}

#[test]
fn off_the_whole_reminder_output_is_the_recorded_text() {
    // the real payload of a Primary's turn with the switch off (and with it never set): the exact text the engine said before this change
    // for an archived worktree-gone child with unread mail; it is byte-compared against a recorded file, so any drift of the off path fails
    let want = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/dead-children-off.txt")).unwrap();
    for explicit_off in [false, true] {
        let e = Env::new(if explicit_off { "golden-off-explicit" } else { "golden-off" });
        if explicit_off {
            e.settings(false);
        }
        let wt = e.worktree(false, true);
        e.summary(&wt, 3, "urgent", true);
        e.archive(&wt);
        let out = e.turn();
        assert_eq!(stable(&e, &wt, &out).trim_end(), want.trim_end(), "the off output changed (explicit off: {explicit_off})");
    }
}
