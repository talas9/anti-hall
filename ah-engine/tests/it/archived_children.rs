//! GH #508 through the real dispatcher (`ah-engine hook --event UserPromptSubmit`): a Primary whose project holds a child that is
//! explicitly ARCHIVED (anti-hall's marker with proof the id was not re-created) is no longer nagged about it (switch
//! `devswarm.skipArchivedChildren`), a live or re-created child still is, and the switch off keeps the old text. No worktree path is
//! inspected anywhere. The payload and the on-disk layout are the ones a Primary's turn meets.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(crate) const CHILD: &str = "11111111-aaaa-4bbb-8ccc-222222222222";
pub(crate) const NOW_MS: u64 = 1_900_000_000_000;

pub(crate) struct Env {
    pub(crate) dir: PathBuf,
    pub(crate) repo: PathBuf,
    pub(crate) key: String,
    /// What the next turn's summary is built from: (worktree, messages, urgency).
    pending: std::cell::RefCell<Option<(String, u32, String)>>,
    /// The session id the child's live descriptor names (`None`: it records none).
    desc_sid: std::cell::RefCell<Option<String>>,
}

impl Env {
    pub(crate) fn new(name: &str) -> Env {
        let dir = std::env::temp_dir().join(format!("aha-arch-{name}-{}", std::process::id()));
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
        Env { dir, repo, key, pending: std::cell::RefCell::new(None), desc_sid: std::cell::RefCell::new(Some("sess-1".into())) }
    }

    pub(crate) fn dsdir(&self) -> PathBuf {
        self.dir.join("home/.anti-hall/devswarm")
    }

    /// The child's worktree path, under the home like a DevSwarm repos root; `exists` makes the directory.
    pub(crate) fn worktree(&self, exists: bool) -> String {
        let wt = self.dir.join("home/.devswarm/repos/3/8205fc11/child-wt");
        std::fs::create_dir_all(self.dir.join("home/.devswarm/repos")).unwrap();
        if exists {
            std::fs::create_dir_all(&wt).unwrap();
        }
        wt.to_string_lossy().to_string()
    }

    /// A path outside the home, behind a directory that does not exist (an unmounted volume).
    pub(crate) fn unmounted_worktree(&self) -> String {
        self.dir.join("elsewhere/wts/child-wt").to_string_lossy().to_string()
    }

    pub(crate) fn put(&self, rel: &str, v: serde_json::Value) {
        let p = self.dsdir().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }

    /// The one child holds `unread` real messages (the newest of urgency `urgency`), 40 days old, in a real SQLite store; the summary
    /// the Primary's turn reads is computed from it by the engine at the start of each turn, `stale_registry` is not a parameter: the
    /// engine derives it from the registry row.
    pub(crate) fn summary(&self, wt: &str, unread: u32, urgency: &str, _stale_registry: bool) {
        *self.pending.borrow_mut() = Some((wt.to_string(), unread, urgency.to_string()));
    }

    pub(crate) fn materialize(&self) {
        use ah_engine::meshw::store::{MeshRow, MeshStore, RegistryRow};
        let Some((wt, unread, urgency)) = self.pending.borrow().clone() else { return };
        let home = self.dir.join("home");
        let st = MeshStore::open(&self.dsdir().join("store").join(&self.key).join("devswarm.db")).unwrap();
        let row = RegistryRow { id: CHILD.into(), worktree_path: Some(wt.clone()), session_id: Some("sess-1".into()), ..RegistryRow::default() };
        st.upsert_registry(&row, NOW_MS as i64, |a, b| a == b).unwrap();
        let desc_path = self.dsdir().join(format!("workspaces/{CHILD}.json"));
        if !desc_path.exists() {
            let mut d = serde_json::json!({"id": CHILD, "worktreePath": wt});
            if let Some(sid) = self.desc_sid.borrow().clone() {
                d["sessionId"] = sid.into();
            }
            self.put(&format!("workspaces/{CHILD}.json"), d);
        }
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

    /// anti-hall's archive marker for the child, naming session `sid` (`None`: the marker records none).
    pub(crate) fn archive_with(&self, wt: &str, sid: Option<&str>) {
        let mut d = serde_json::json!({"id": CHILD, "worktreePath": wt, "archivedAt": 100});
        if let Some(sid) = sid {
            d["sessionId"] = sid.into();
        }
        self.put(&format!("archived/{CHILD}.json"), d);
    }

    /// The archive completes between the summary being taken and the nudge being decided: the marker is there and the descriptor is gone.
    pub(crate) fn archive_completes_after_summary(&self, wt: &str) {
        self.materialize();
        self.pending.borrow_mut().take(); // the summary on disk stays as it was
        self.archive(wt);
        std::fs::remove_file(self.dsdir().join(format!("workspaces/{CHILD}.json"))).unwrap();
    }

    pub(crate) fn archive(&self, wt: &str) {
        self.archive_with(wt, Some("sess-1"));
    }

    /// Sets a file's modification time `secs` seconds after a fixed point (the two files of a case are ordered by it).
    pub(crate) fn mtime(&self, rel: &str, secs: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(self.dsdir().join(rel)).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000 + secs)).unwrap();
    }

    pub(crate) fn settings(&self, on: bool) {
        std::fs::write(self.dir.join("home/.anti-hall/settings.json"), serde_json::json!({"devswarm": {"skipArchivedChildren": on}}).to_string()).unwrap();
    }

    pub(crate) fn turn(&self) -> String {
        self.materialize();
        let map = self.dir.join("map.json");
        let ids: Vec<String> = ah_engine::dispatch::table::entries("claude", "UserPromptSubmit").into_iter().map(|x| x.id).collect();
        let m: serde_json::Map<String, serde_json::Value> = ids.iter().map(|id| (id.clone(), "true".into())).collect();
        std::fs::write(&map, serde_json::json!({ "UserPromptSubmit": m }).to_string()).unwrap();
        let payload = serde_json::json!({"session_id": "arch-e2e", "hook_event_name": "UserPromptSubmit", "prompt": "hi", "cwd": self.repo}).to_string();
        let mut c = Command::new(env!("CARGO_BIN_EXE_ah-engine"));
        c.args(["hook", "--event", "UserPromptSubmit", "--fallback-map", map.to_str().unwrap()])
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", self.dir.join("home"))
            .env("GIT_CEILING_DIRECTORIES", &self.dir)
            .env("AH_ENGINE_DIR", self.dir.join("state"))
            .env("AH_ENGINE_VERSION", "arch-e2e")
            .env("AH_ENGINE_DISPATCH_IN_PROCESS", "1")
            .env("ANTIHALL_DEVSWARM_SUPERVISOR", "on")
            .env("ANTIHALL_TASK_TRACKER_TERSE", "0") // the earlier tracker wording the golden file records: the terse wording ships on
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
const STALE: &str = "devswarm-stale-workspaces";
const ARCHIVE_READY: &str = "devswarm-archive-ready";

/// True when the turn's text names the child through any of the per-workspace nudges.
fn names_child(out: &str) -> bool {
    out.contains(NUDGE) || out.contains(URGENT) || out.contains(CHILD)
}

/// The unread count the summary file holds for the one child, with the whole summary.
fn summary_unread(e: &Env) -> (serde_json::Value, serde_json::Value) {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(e.dsdir().join(format!("summaries/{}.json", e.key))).unwrap()).unwrap();
    (v["workspaces"][CHILD]["unread"].clone(), v)
}

/// A marker beside a descriptor, the two written in order, with the descriptor `desc_secs` and the marker `marker_secs` after a fixed point.
fn marker_beside_descriptor(name: &str, marker_sid: Option<&str>, desc_sid: Option<&str>, marker_secs: u64, desc_secs: u64) -> (Env, String) {
    let e = Env::new(name);
    e.settings(true);
    *e.desc_sid.borrow_mut() = desc_sid.map(str::to_string);
    let wt = e.worktree(false);
    e.summary(&wt, 3, "urgent", false);
    e.archive_with(&wt, marker_sid);
    e.materialize();
    e.mtime(&format!("workspaces/{CHILD}.json"), desc_secs);
    e.mtime(&format!("archived/{CHILD}.json"), marker_secs);
    (e, wt)
}

#[test]
fn marker_no_descriptor_switch_on_urgent_and_unread_silent() {
    // a marker with no descriptor is an archive-complete child: the engine's own summary does not make it a workspace row (it lists it
    // as archived-stranded), so no nudge names it, with the switch on or off; the control proves the switch changes none of that and
    // that its unread stays raw in the summary
    for on in [false, true] {
        let e = Env::new(if on { "nodesc-on" } else { "nodesc-off" });
        e.settings(on);
        let wt = e.worktree(false);
        e.summary(&wt, 3, "urgent", false);
        e.archive_completes_after_summary(&wt);
        let out = e.turn();
        assert!(!names_child(&out) && !out.contains(ARCHIVE_READY), "silent (switch on: {on}), got: {out:?}");
        let v = summary_unread(&e).1;
        let stranded = v["archivedStranded"].as_array().is_some_and(|a| a.iter().any(|x| x["id"] == CHILD && x["unread"] == 3));
        assert!(stranded, "its raw unread stays in the summary (switch on: {on}): {v}");
    }
}

#[test]
fn same_input_switch_off_names_the_child_byte_identical() {
    // the real payload of a Primary's turn with the switch off (never set, and set to false): the exact text the engine said before this
    // change for a marker-archived child with unread mail; byte-compared against a recorded file, so any drift of the off path fails
    let want = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/archived-children-off.txt")).unwrap();
    for explicit_off in [false, true] {
        let e = Env::new(if explicit_off { "golden-off-explicit" } else { "golden-off" });
        if explicit_off {
            e.settings(false);
        }
        let wt = e.worktree(false);
        e.summary(&wt, 3, "urgent", true);
        e.archive(&wt);
        let out = e.turn();
        assert_eq!(stable(&e, &wt, &out).trim_end(), want.trim_end(), "the off output changed (explicit off: {explicit_off})");
    }
}

#[test]
fn marker_beside_descriptor_same_session_silent() {
    let (e, _) = marker_beside_descriptor("same-sid", Some("sess-1"), Some("sess-1"), 100, 50);
    let out = e.turn();
    assert!(!out.contains(NUDGE) && !out.contains(URGENT), "same session on both sides: the marker is this incarnation's, got: {out:?}");
}

#[test]
fn marker_beside_descriptor_both_no_session_descriptor_not_newer_silent() {
    let (e, _) = marker_beside_descriptor("nosid-old", None, None, 100, 100);
    let out = e.turn();
    assert!(!out.contains(NUDGE) && !out.contains(URGENT), "descriptor not written since the marker, got: {out:?}");
}

#[test]
fn marker_beside_descriptor_both_no_session_descriptor_newer_named() {
    let (e, _) = marker_beside_descriptor("nosid-new", None, None, 100, 200);
    let out = e.turn();
    assert!(out.contains(NUDGE) || out.contains(URGENT), "descriptor written after the marker: re-created, still named, got: {out:?}");
}

#[test]
fn same_id_recreated_with_new_session_named() {
    let (e, _) = marker_beside_descriptor("new-sid", Some("sess-old"), Some("sess-new"), 100, 50);
    let out = e.turn();
    assert!(out.contains(NUDGE) || out.contains(URGENT), "marker names session S1, descriptor S2: a new incarnation, got: {out:?}");
}

#[test]
fn recreated_descriptor_without_session_while_marker_has_one_named() {
    // the hazard: marker_archived alone answers true here; a just re-created child has no session id yet
    let (e, _) = marker_beside_descriptor("desc-nosid", Some("sess-old"), None, 100, 50);
    let out = e.turn();
    assert!(out.contains(NUDGE) || out.contains(URGENT), "got: {out:?}");
}

#[test]
fn live_child_named() {
    let e = Env::new("live");
    e.settings(true);
    let wt = e.worktree(true);
    e.summary(&wt, 3, "normal", false);
    let out = e.turn();
    assert!(out.contains(NUDGE), "a child that is not archived is nagged, got: {out}");
}

#[test]
fn archived_with_existing_worktree_silent() {
    // proves no worktree inspection: the directory is there, the child is archived all the same
    let e = Env::new("archived-present");
    e.settings(true);
    let wt = e.worktree(true);
    e.summary(&wt, 3, "normal", false);
    e.archive(&wt);
    let out = e.turn();
    assert!(!names_child(&out), "explicitly archived: silent whatever the directory does, got: {out:?}");
}

#[test]
fn not_archived_with_missing_or_unmounted_worktree_named() {
    // the two inputs PR 560 got wrong: no marker, so the worktree says nothing; 4 urgent unread must not be hidden
    for unmounted in [false, true] {
        let e = Env::new(if unmounted { "unmounted" } else { "absent" });
        e.settings(true);
        let wt = if unmounted { e.unmounted_worktree() } else { e.worktree(false) };
        e.summary(&wt, 4, "urgent", false);
        let out = e.turn();
        assert!(out.contains(NUDGE) || out.contains(URGENT), "not archived (unmounted: {unmounted}), got: {out:?}");
    }
}

#[test]
fn stale_registry_row_archived_dropped_and_text_names_archive_step() {
    let archived = Env::new("stale-arch");
    archived.settings(true);
    let wt = archived.worktree(false);
    archived.summary(&wt, 3, "normal", true);
    archived.archive(&wt);
    assert!(!archived.turn().contains(STALE), "an archived row is not named");
    let live = Env::new("stale-live");
    live.settings(true);
    let wt = live.worktree(false);
    live.summary(&wt, 3, "normal", true);
    let out = live.turn();
    assert!(out.contains(STALE) && out.contains("archive <id>"), "names the exact step, got: {out}");
    let off = Env::new("stale-off");
    let wt = off.worktree(false);
    off.summary(&wt, 3, "normal", true);
    off.archive(&wt);
    assert!(off.turn().contains(STALE), "baseline: off lists the archived row");
}

#[test]
fn summary_unread_counts_identical_switch_on_and_off() {
    let mut seen = Vec::new();
    for on in [false, true] {
        let e = Env::new(if on { "sum-on" } else { "sum-off" });
        e.settings(on);
        let wt = e.worktree(false);
        e.summary(&wt, 4, "normal", true);
        e.archive(&wt);
        e.turn();
        let (u, v) = summary_unread(&e);
        assert_eq!(u, 4);
        seen.push(v["workspaces"].to_string().replace(&wt, "<wt>"));
        assert!(!e.dsdir().join("expired").exists(), "no mark is written anywhere");
    }
    assert_eq!(seen.first(), seen.get(1), "the summary is the same whatever the switch");
}

/// The reminder text of a turn without its first paragraph (the rotating general tip is not part of this check), with the scratch
/// paths made stable.
fn stable(e: &Env, wt: &str, out: &str) -> String {
    let v: serde_json::Value = serde_json::from_str(out).unwrap();
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    ctx.split_once("\n\n").map_or(ctx, |x| x.1).replace(wt, "<wt>").replace(&e.dir.to_string_lossy().to_string(), "<dir>")
}
