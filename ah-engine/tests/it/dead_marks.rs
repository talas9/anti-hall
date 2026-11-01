//! GH #508 review: the summary's expiry marks against REAL SQLite message stores and REAL NDJSON inbox files in a scratch state dir
//! (no fabricated summaries). Positive proof only: a mark hides mail only for the incarnation it was written for, only while the
//! child is archived and its worktree provably gone, only for the positions that existed, per source; anything else shows the full count.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::meshw::common::Inv;
use ah_engine::meshw::store::{MeshRow, MeshStore, RegistryRow};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const ID: &str = "child-1";
const NOW: i64 = 1_900_000_000_000;

struct W {
    dir: PathBuf,
    home: PathBuf,
    store: MeshStore,
}

impl W {
    fn new(name: &str, on: bool) -> W {
        let dir = std::env::temp_dir().join(format!("ahd-marks-{name}-{}", std::process::id()));
        ah_engine::discard::harmless(std::fs::remove_dir_all(&dir));
        let home = dir.join("home");
        std::fs::create_dir_all(home.join(".anti-hall/devswarm")).unwrap();
        std::fs::write(home.join(".anti-hall/settings.json"), json!({"devswarm": {"skipDeadChildren": on}}).to_string()).unwrap();
        let store = MeshStore::open(&home.join(".anti-hall/devswarm/store/k1/devswarm.db")).unwrap();
        W { dir, home, store }
    }

    fn ds(&self) -> PathBuf {
        self.home.join(".anti-hall/devswarm")
    }

    fn put(&self, rel: &str, v: &Value) {
        let p = self.ds().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, v.to_string()).unwrap();
    }

    /// The child's worktree under the home like a DevSwarm repos root (absent unless `make`).
    fn wt(&self, make: bool) -> String {
        let p = self.home.join(".devswarm/repos/3/8205fc11/child-wt");
        std::fs::create_dir_all(self.home.join(".devswarm/repos")).unwrap();
        if make {
            std::fs::create_dir_all(&p).unwrap();
        }
        p.to_string_lossy().to_string()
    }

    /// A registry row (and its descriptor file) for session `sid`, with an NDJSON inbox and cursor in `inbox_dir` when given.
    fn register(&self, sid: &str, wt: &str, inbox_dir: Option<&Path>) {
        let (inbox, cursor) = match inbox_dir {
            Some(d) => {
                std::fs::create_dir_all(d).unwrap();
                std::fs::write(d.join("inbox.cursor"), "0").unwrap();
                (Some(d.join("inbox.ndjson").to_string_lossy().to_string()), Some(d.join("inbox.cursor").to_string_lossy().to_string()))
            }
            None => (None, None),
        };
        let row = RegistryRow {
            id: ID.into(),
            worktree_path: Some(wt.into()),
            session_id: Some(sid.into()),
            inbox_path: inbox,
            cursor_path: cursor,
            nudge_command: None,
        };
        self.store.upsert_registry(&row, NOW, |a, b| a == b).unwrap();
        self.put(
            &format!("workspaces/{ID}.json"),
            &json!({"id": ID, "worktreePath": wt, "sessionId": sid, "inboxPath": row.inbox_path, "cursorPath": row.cursor_path}),
        );
    }

    fn archive(&self, sid: &str, wt: &str, at: u64) {
        self.put(&format!("archived/{ID}.json"), &json!({"id": ID, "worktreePath": wt, "sessionId": sid, "archivedAt": at}));
    }

    fn store_msgs(&self, n: usize, tag: &str) {
        for i in 0..n {
            let m = MeshRow {
                workspace_id: ID.into(),
                ts: NOW - 1000 + i as i64,
                hash: Some(format!("{tag}-{i}")),
                body: format!("m {tag} {i}"),
                sender: Some("someone-else".into()),
                recipient: Some(ID.into()),
                mtype: Some("direct".into()),
                urgency: None,
                is_heartbeat: false,
                needs_reply: false,
                orig_hash: None,
                instance_nonce: None,
            };
            self.store.append_mesh_row(&m).unwrap();
        }
    }

    fn nd_line(&self, dir: &Path, n: usize, tag: &str) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("inbox.ndjson")).unwrap();
        for i in 0..n {
            writeln!(f, "{}", json!({"_h": format!("nd-{tag}-{i}"), "fromBranch": "someone-else", "message": format!("nd {tag} {i}"), "createdAt": NOW - 500}))
                .unwrap();
        }
    }

    fn mark_raw(&self, v: &Value) {
        self.put(&format!("expired/{ID}.json"), v);
    }

    fn summary(&self) -> Value {
        let inv = Inv {
            home: self.home.clone(),
            env: Default::default(),
            cwd: self.home.to_string_lossy().to_string(),
            now: NOW,
            stdin: None,
            write_home: self.home.clone(),
            store_override: None,
        };
        let Ok(out) = ah_engine::meshw::summary::compute(&self.store, &inv, None) else { panic!("summary") };
        serde_json::from_str(&out.stringify()).unwrap()
    }

    fn unread(&self) -> f64 {
        let s = self.summary();
        s["workspaces"][ID]["unread"].as_f64().unwrap_or_else(|| panic!("no row for {ID}: {s}"))
    }
}

impl Drop for W {
    fn drop(&mut self) {
        if std::env::var_os("AH_KEEP_SCRATCH").is_none() {
            ah_engine::discard::harmless(std::fs::remove_dir_all(&self.dir));
        }
    }
}

/// The mark the engine itself offers for the archived, gone child, written through the engine's writer: the only honest way to build one.
fn written_mark(w: &W) -> Value {
    let row = &w.summary()["workspaces"][ID];
    let offered = row["deadMark"].clone();
    assert!(offered.is_object(), "an archived child with its worktree gone offers a mark, got: {row}");
    assert!(ah_engine::meshw::deadchild::write_offer(&w.home, ID, &offered, NOW as f64), "the mark is written");
    offered
}

#[test]
fn off_nothing_is_offered_and_nothing_is_hidden() {
    let w = W::new("off", false);
    let wt = w.wt(false);
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 100);
    w.store_msgs(3, "a");
    assert!(w.summary()["workspaces"][ID].get("deadMark").is_none());
    w.mark_raw(&json!({"incarnation": "x", "store": 3, "nd": 0, "through": 3}));
    assert_eq!(w.unread(), 3.0);
}

#[test]
fn an_archived_gone_child_is_expired_by_its_own_mark_and_new_mail_still_counts() {
    let w = W::new("basic", true);
    let wt = w.wt(false);
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 100);
    w.store_msgs(3, "a");
    assert_eq!(w.unread(), 3.0, "before the mark everything counts");
    written_mark(&w);
    assert_eq!(w.unread(), 0.0, "the three stored messages are expired");
    w.store_msgs(1, "b");
    assert_eq!(w.unread(), 1.0, "mail that arrives after the mark counts");
}

#[test]
fn a_worktree_that_comes_back_restores_the_full_count() {
    let w = W::new("back", true);
    let wt = w.wt(false);
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 100);
    w.store_msgs(3, "a");
    written_mark(&w);
    assert_eq!(w.unread(), 0.0);
    w.wt(true);
    assert_eq!(w.unread(), 3.0, "a worktree that exists is not gone: the mark is not honoured");
}

#[test]
fn a_child_that_is_not_archived_is_never_expired_even_with_a_mark() {
    let w = W::new("notarch", true);
    let wt = w.wt(false);
    w.register("sess-a", &wt, None);
    w.store_msgs(3, "a");
    assert!(w.summary()["workspaces"][ID].get("deadMark").is_none(), "a merely absent worktree offers no mark");
    w.mark_raw(&json!({"through": 3, "incarnation": format!("sess-a|{wt}|100"), "store": 3, "nd": 0}));
    assert_eq!(w.unread(), 3.0, "no archive marker: no incarnation: the mark proves nothing");
}

#[test]
fn a_missing_child_behind_a_link_that_points_outside_the_home_is_not_gone() {
    let w = W::new("link", true);
    let outside = w.dir.join("outside/real");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::create_dir_all(w.home.join(".devswarm/repos")).unwrap();
    std::os::unix::fs::symlink(&outside, w.home.join(".devswarm/repos/link")).unwrap();
    let wt = w.home.join(".devswarm/repos/link/child-wt").to_string_lossy().to_string();
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 100);
    w.store_msgs(3, "a");
    assert!(w.summary()["workspaces"][ID].get("deadMark").is_none(), "nothing proves the worktree is gone");
    w.mark_raw(&json!({"through": 3, "incarnation": format!("sess-a|{wt}|100"), "store": 3, "nd": 0}));
    assert_eq!(w.unread(), 3.0);
}

#[test]
fn a_mark_of_another_incarnation_is_ignored() {
    let w = W::new("incarn", true);
    let wt = w.wt(false);
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 100);
    w.store_msgs(3, "a");
    written_mark(&w);
    assert_eq!(w.unread(), 0.0);
    // the same id is re-created: a new session, a live row, the archive marker of the old one still on disk
    w.register("sess-b", &wt, None);
    assert_eq!(w.unread(), 3.0, "incarnation B must not inherit A's mark");
    // re-archived later: a new archivedAt is a new incarnation too
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 200);
    assert_eq!(w.unread(), 3.0, "a re-archived child needs its own mark");
}

#[test]
fn the_mark_is_per_source_a_later_ndjson_line_counts() {
    let w = W::new("sources", true);
    let wt = w.wt(false);
    let inbox = w.dir.join("inbox-dir");
    w.register("sess-a", &wt, Some(&inbox));
    w.archive("sess-a", &wt, 100);
    w.store_msgs(4, "a");
    assert_eq!(w.unread(), 4.0);
    written_mark(&w);
    assert_eq!(w.unread(), 0.0, "four stored messages expired");
    w.nd_line(&inbox, 1, "late");
    assert_eq!(w.unread(), 1.0, "one more message from the NDJSON inbox counts: a store-only cap must not eat it");
    w.store_msgs(1, "late");
    assert_eq!(w.unread(), 2.0, "and a later stored message counts too");
}

#[test]
fn ndjson_mail_present_at_the_mark_is_expired_with_it_and_later_lines_count() {
    let w = W::new("nd-mark", true);
    let wt = w.wt(false);
    let inbox = w.dir.join("inbox-dir");
    w.register("sess-a", &wt, Some(&inbox));
    w.archive("sess-a", &wt, 100);
    w.store_msgs(2, "a");
    w.nd_line(&inbox, 2, "early");
    assert_eq!(w.unread(), 4.0, "two stored and two NDJSON");
    let offered = written_mark(&w);
    assert_eq!((offered["store"].as_u64(), offered["nd"].as_u64()), (Some(2), Some(2)), "{offered}");
    assert_eq!(w.unread(), 0.0);
    w.nd_line(&inbox, 1, "late");
    assert_eq!(w.unread(), 1.0);
}

#[test]
fn an_impossible_mark_is_rejected_and_the_full_count_shows() {
    let w = W::new("impossible", true);
    let wt = w.wt(false);
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 100);
    w.store_msgs(3, "a");
    let inc = format!("sess-a|{wt}|100");
    for bad in [
        json!({"through": 100, "incarnation": inc, "store": 100, "nd": 0}),
        json!({"through": -1, "incarnation": inc, "store": -1, "nd": 0}),
        json!({"through": 2.5, "incarnation": inc, "store": 2.5, "nd": 0}),
        json!({"through": "3", "incarnation": inc, "store": "3", "nd": 0}),
        json!({"incarnation": inc, "store": 3, "nd": 5}),
        json!({"incarnation": inc, "store": 3}),
        json!({"incarnation": 7, "store": 3, "nd": 0}),
        json!({"through": 100}),
        json!([1, 2]),
    ] {
        w.mark_raw(&bad);
        assert_eq!(w.unread(), 3.0, "{bad} must be ignored");
    }
    // a bogus huge mark does not hide mail that arrives later
    w.mark_raw(&json!({"through": 100, "incarnation": inc, "store": 100, "nd": 0}));
    w.store_msgs(5, "later");
    assert_eq!(w.unread(), 8.0);
    // a good mark of the same incarnation works
    w.mark_raw(&json!({"through": 3, "incarnation": inc, "store": 3, "nd": 0}));
    assert_eq!(w.unread(), 5.0);
}

#[test]
fn the_mark_write_is_monotonic_and_reports_honestly() {
    let w = W::new("monotonic", true);
    let wt = w.wt(false);
    w.register("sess-a", &wt, None);
    w.archive("sess-a", &wt, 100);
    w.store_msgs(5, "a");
    let offered = written_mark(&w);
    let inc = offered["incarnation"].clone();
    let read = |w: &W| -> Value { serde_json::from_str(&std::fs::read_to_string(w.ds().join(format!("expired/{ID}.json"))).unwrap()).unwrap() };
    assert_eq!(read(&w)["store"], 5);
    // a writer with an older, smaller view can never lower it, and says it wrote nothing
    assert!(!ah_engine::meshw::deadchild::write_offer(&w.home, ID, &json!({"incarnation": inc, "store": 3, "nd": 0}), NOW as f64));
    assert_eq!(read(&w)["store"], 5);
    // the same positions again: nothing written
    assert!(!ah_engine::meshw::deadchild::write_offer(&w.home, ID, &offered, NOW as f64));
    // larger raises
    assert!(ah_engine::meshw::deadchild::write_offer(&w.home, ID, &json!({"incarnation": inc, "store": 7, "nd": 1}), NOW as f64));
    let m = read(&w);
    assert_eq!((m["store"].as_u64(), m["nd"].as_u64()), (Some(7), Some(1)));
    // many concurrent writers: the file ends at the maximum
    let hs: Vec<_> = (1..=12u64)
        .map(|i| {
            let (home, inc) = (w.home.clone(), inc.clone());
            std::thread::spawn(move || ah_engine::meshw::deadchild::write_offer(&home, ID, &json!({"incarnation": inc, "store": 10 + i, "nd": 0}), NOW as f64))
        })
        .collect();
    for h in hs {
        h.join().unwrap();
    }
    assert_eq!(read(&w)["store"], 22);
    // a write that fails reports false: the mark directory is a file
    let w2 = W::new("failwrite", true);
    std::fs::write(w2.ds().join("expired"), "not a directory").unwrap();
    assert!(!ah_engine::meshw::deadchild::write_offer(&w2.home, ID, &json!({"incarnation": "i", "store": 1, "nd": 0}), NOW as f64));
}
