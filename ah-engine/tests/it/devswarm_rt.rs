//! DevSwarm realtime state (lane B1): fixture app databases, the restart diff, the invariants (property tests), inert when
//! DevSwarm is absent, the paused? evidence rule, GitHub fallback, the Node-witness comparison and persistence.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::db::{Db, TempDir};
use ah_engine::devswarm_rt::reconcile::{Cause, Rt};
use ah_engine::devswarm_rt::shadow;
use ah_engine::devswarm_rt::sources::{self, AppRead, GhPr, GithubState, Probe};
use ah_engine::devswarm_rt::state::{self, Activity, Cfg, Ci, EdgeKind, Inputs, Lifecycle, Paused, PrState, Snapshot};
use ah_engine::devswarm_rt::{self, Detection, Mode};
use proptest::prelude::*;
use rusqlite::{Connection, params};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const NOW: i64 = 1_791_500_000_000;

fn cfg() -> Cfg {
    ah_engine::defaults::init().expect("defaults load");
    Cfg::from_defaults()
}

/// A builder fixture: (id, isActive, isHidden, terminal panel statuses as (status, isActive), pr id).
type B = (&'static str, i64, i64, Vec<(&'static str, i64)>, Option<&'static str>);

fn make_db(path: &Path, builders: &[B], prs: &[(&str, i64, &str, &str, &str)]) {
    std::fs::remove_file(path).ok(); // absent is the goal state
    let c = Connection::open(path).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, worktreePath TEXT, label TEXT, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isActive INTEGER);
         CREATE TABLE builder_terminals (id INTEGER PRIMARY KEY, builderId TEXT, panelStatus TEXT, isActive INTEGER);
         CREATE TABLE pull_requests (id TEXT PRIMARY KEY, number INTEGER, state TEXT, checkStatus TEXT, lastSyncedAt TEXT);",
    )
    .unwrap();
    for (id, active, hidden, terms, pr) in builders {
        c.execute(
            "INSERT INTO builders (id, repositoryId, branchName, worktreePath, label, isHidden, pullRequestId, builderType, isActive) VALUES (?1, 'r1', ?2, ?3, ?4, ?5, ?6, 'standard', ?7)",
            params![id, format!("br-{id}"), format!("/wt/{id}"), format!("L {id}"), hidden, pr, active],
        )
        .unwrap();
        for (s, a) in terms {
            c.execute("INSERT INTO builder_terminals (builderId, panelStatus, isActive) VALUES (?1, ?2, ?3)", params![id, s, a]).unwrap();
        }
    }
    for (id, n, st, ck, at) in prs {
        c.execute("INSERT INTO pull_requests VALUES (?1, ?2, ?3, ?4, ?5)", params![id, n, st, ck, at]).unwrap();
    }
}

#[derive(Default)]
struct Stub {
    hb: HashMap<String, i64>,
    unread: HashMap<String, usize>,
    plan: HashMap<String, String>,
}
impl Probe for Stub {
    fn heartbeat_ms(&self, id: &str) -> Option<i64> {
        self.hb.get(id).copied()
    }
    fn plan_step(&self, wt: &str) -> Option<String> {
        self.plan.get(wt).cloned()
    }
    fn unread(&self, id: &str) -> Option<usize> {
        self.unread.get(id).copied()
    }
}

fn det(home: &Path, db: &Path) -> Detection {
    Detection { app_db: Some(db.to_path_buf()), descriptors: false, mode: Mode::On, home: home.to_path_buf() }
}

fn fixture() -> (TempDir, PathBuf) {
    let t = TempDir::new("rt2");
    let db = t.0.join("devswarm.db");
    (t, db)
}

fn read(db: &Path) -> AppRead {
    sources::read_app(db).expect("fixture readable")
}

fn snap_of(cfg: &Cfg, app: Option<&AppRead>, probe: &Stub, gh: Option<&dyn GithubState>, now: i64, prev: &Snapshot) -> Snapshot {
    state::derive(cfg, &Inputs { app, probe, gh, now }, prev)
}

#[test]
fn lifecycle_states_from_fixture_rows() {
    let (_t, db) = fixture();
    make_db(&db, &[("act", 1, 0, vec![], None), ("arc", 0, 1, vec![], None), ("clo", 0, 0, vec![], None), ("hid", 1, 1, vec![], None)], &[]);
    let s = snap_of(&cfg(), Some(&read(&db)), &Stub::default(), None, NOW, &Snapshot::default());
    let l = |id: &str| s.workspaces[id].lifecycle.value;
    assert_eq!((l("act"), l("arc"), l("clo"), l("hid")), (Lifecycle::Active, Lifecycle::Archived, Lifecycle::Closed, Lifecycle::Hidden));
    assert!(s.app_readable);
}

#[test]
fn paused_is_a_question_until_the_signal_is_proven() {
    let (_t, db) = fixture();
    make_db(
        &db,
        &[
            ("allres", 1, 0, vec![("resumable", 1), ("resumable", 0)], None),
            ("mixed", 1, 0, vec![("resumable", 1), ("pending", 1)], None),
            ("none", 1, 0, vec![], None),
            ("old", 0, 1, vec![("resumable", 1)], None),
        ],
        &[],
    );
    let mut c = cfg();
    let app = read(&db);
    let s = snap_of(&c, Some(&app), &Stub::default(), None, NOW, &Snapshot::default());
    assert!(matches!(&s.workspaces["allres"].paused.value, Paused::Maybe(ev) if ev.contains("resumable")), "evidence, no claim");
    assert_eq!(s.workspaces["mixed"].paused.value, Paused::No);
    assert_eq!(s.workspaces["none"].paused.value, Paused::No);
    assert_eq!(s.workspaces["old"].paused.value, Paused::No, "an archived workspace is never paused");
    assert!(!matches!(s.workspaces["allres"].paused.value, Paused::Yes(_)));
    // the owner proves the signal with a fixture: the same evidence now reports paused
    c.paused_proven = true;
    let s2 = snap_of(&c, Some(&app), &Stub::default(), None, NOW, &Snapshot::default());
    assert!(matches!(s2.workspaces["allres"].paused.value, Paused::Yes(_)));
    // the shipped default does not claim it
    assert!(!cfg().paused_proven);
}

#[test]
fn activity_stuck_waiting_done_and_suppression() {
    let (_t, db) = fixture();
    make_db(
        &db,
        &[
            ("work", 1, 0, vec![], None),
            ("stuck", 1, 0, vec![], None),
            ("ci", 1, 0, vec![], Some("p1")),
            ("done", 1, 0, vec![], Some("p2")),
            ("arch", 0, 1, vec![], Some("p1")),
            ("nohb", 1, 0, vec![], None),
        ],
        &[("p1", 5, "open", "Pending", "2026-10-08T04:51:07.250Z"), ("p2", 6, "merged", "None", "2026-10-08T04:51:07.250Z")],
    );
    let c = cfg();
    let mut p = Stub::default();
    for id in ["work", "ci", "done", "arch"] {
        p.hb.insert(id.into(), NOW - 1000);
    }
    p.hb.insert("stuck".into(), NOW - c.stall_ms - 1);
    let s = snap_of(&c, Some(&read(&db)), &p, None, NOW, &Snapshot::default());
    let a = |id: &str| s.workspaces[id].activity.value;
    assert_eq!(
        (a("work"), a("stuck"), a("ci"), a("done"), a("arch"), a("nohb")),
        (Activity::Working, Activity::Stuck, Activity::WaitingCi, Activity::Done, Activity::Unknown, Activity::Unknown)
    );
    // no heartbeat is unknown, never guessed
    assert_eq!(s.workspaces["nohb"].last_activity_ms.value, None);
}

#[test]
fn github_state_wins_and_the_app_checkstatus_is_the_stale_fallback() {
    struct Gh;
    impl GithubState for Gh {
        fn pr(&self, wt: &str, _b: &str) -> Option<GhPr> {
            (wt == "/wt/g").then_some(GhPr { number: Some(9), state: PrState::Open, checks: Ci::Failing, observed_ms: NOW - 10 })
        }
    }
    let (_t, db) = fixture();
    make_db(&db, &[("g", 1, 0, vec![], Some("p1")), ("a", 1, 0, vec![], Some("p1"))], &[("p1", 5, "open", "Passed", "2026-10-08T04:51:07.250Z")]);
    let c = cfg();
    let s = snap_of(&c, Some(&read(&db)), &Stub::default(), Some(&Gh), NOW, &Snapshot::default());
    let (g, a) = (&s.workspaces["g"].pr, &s.workspaces["a"].pr);
    assert_eq!(g.value.as_ref().unwrap().checks, Ci::Failing);
    assert_eq!(g.source, state::Src::Github);
    assert!(!g.is_stale(NOW, c.stale_ms));
    assert_eq!(a.value.as_ref().unwrap().checks, Ci::Passing);
    assert_eq!(a.source, state::Src::AppPr);
    assert_eq!(a.observed_ms, 1_791_435_067_250, "the app's CI data is as old as its last sync");
    assert!(a.is_stale(NOW, c.stale_ms));
    // and without a GitHub feature at all the fallback is the same
    let s2 = snap_of(&c, Some(&read(&db)), &Stub::default(), None, NOW, &Snapshot::default());
    assert_eq!(s2.workspaces["g"].pr.source, state::Src::AppPr);
}

#[test]
fn iso_times_parse() {
    assert_eq!(sources::parse_iso_ms("2026-10-08T04:51:07.250Z"), Some(1_791_435_067_250));
    assert_eq!(sources::parse_iso_ms("2026-10-08T04:51:07Z"), Some(1_791_435_067_000));
    assert_eq!(sources::parse_iso_ms("garbage"), None);
}

#[test]
fn unreadable_app_db_is_unknown_not_a_guess() {
    let (t, db) = fixture();
    make_db(&db, &[("a", 1, 0, vec![], None)], &[]);
    let c = cfg();
    let first = snap_of(&c, Some(&read(&db)), &Stub::default(), None, NOW, &Snapshot::default());
    let bad = t.0.join("bad.db");
    std::fs::write(&bad, b"not a database at all").unwrap();
    assert!(sources::read_app(&bad).is_none());
    assert!(sources::read_app(&t.0.join("missing.db")).is_none());
    let after = snap_of(&c, None, &Stub::default(), None, NOW + 1, &first);
    assert!(!after.app_readable);
    assert_eq!(after.workspaces["a"].lifecycle.value, Lifecycle::Unknown);
    assert_eq!(after.workspaces["a"].activity.value, Activity::Unknown);
    assert!(state::check_invariants(&c, &after, &[], NOW + 1).is_empty());
}

#[test]
fn first_read_seeds_without_edges_then_changes_are_edges() {
    let (t, db) = fixture();
    make_db(&db, &[("a", 1, 0, vec![], None), ("b", 1, 0, vec![], None)], &[]);
    let rt = Rt::new(cfg(), det(&t.0, &db));
    let p = Stub::default();
    let r = rt.run(Cause::Startup, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW }, None);
    assert!(r.edges.is_empty(), "nothing is claimed to have changed on the very first read");
    assert!(rt.current().seeded);
    // b is archived, c appears
    make_db(&db, &[("a", 1, 0, vec![], None), ("b", 0, 1, vec![], None), ("c", 1, 0, vec![], None)], &[]);
    let r = rt.run(Cause::Event, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW + 5 }, None);
    let kinds: Vec<_> = r.edges.iter().map(|e| (e.ws.as_str(), e.from.as_str(), e.to.as_str())).collect();
    assert!(kinds.contains(&("b", "active", "archived")) && kinds.contains(&("c", "", "active")), "{kinds:?}");
    assert_eq!(r.repairs, 0, "an event-path change is not a repair");
    assert_eq!(r.generation, 1);
    // an identical read emits nothing and keeps the generation (I4)
    let r = rt.run(Cause::Event, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW + 9 }, None);
    assert!(r.edges.is_empty());
    assert_eq!(r.generation, 1);
    assert_eq!(rt.edges_since(0).len(), 2);
    assert!(rt.edges_since(1).is_empty());
}

#[test]
fn periodic_reconcile_counts_what_events_missed() {
    let (t, db) = fixture();
    make_db(&db, &[("a", 1, 0, vec![], None)], &[]);
    let rt = Rt::new(cfg(), det(&t.0, &db));
    let p = Stub::default();
    rt.run(Cause::Startup, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW }, None);
    make_db(&db, &[("a", 0, 0, vec![], None)], &[]);
    let r = rt.run(Cause::Periodic, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW + 60_000 }, None);
    assert_eq!((r.edges.len(), r.repairs), (1, 1));
    make_db(&db, &[("a", 0, 1, vec![], None)], &[]);
    let r = rt.run(Cause::Overflow, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW + 61_000 }, None);
    assert_eq!(r.repairs, 1);
    assert_eq!(rt.repairs(), 2);
    let mut m = ah_engine::metrics::Metrics::default();
    rt.publish(&mut m);
    rt.publish(&mut m);
    assert_eq!(m.counter_total("rt_reconcile_repairs"), 2, "published once, not twice");
    assert!(ah_engine::metrics::is_registered("rt_reconcile_repairs"));
}

#[test]
fn restart_diff_flags_while_down_and_holds_the_notify() {
    let (t, db) = fixture();
    let hot = TempDir::new("rt2-hot");
    let dbh = Db::open(&hot.0).unwrap();
    make_db(&db, &[("a", 1, 0, vec![], None), ("b", 1, 0, vec![], None), ("gone", 1, 0, vec![], None)], &[]);
    let c = cfg();
    let p = Stub::default();
    let rt1 = Rt::new(c.clone(), det(&t.0, &db));
    rt1.run(Cause::Startup, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW }, Some(&dbh));
    dbh.barrier().unwrap();
    // the engine goes down; meanwhile b is archived, gone disappears, d appears
    make_db(&db, &[("a", 1, 0, vec![], None), ("b", 0, 1, vec![], None), ("d", 1, 0, vec![], None)], &[]);
    let rt2 = Rt::new(c.clone(), det(&t.0, &db));
    assert_eq!(rt2.load_persisted(&dbh), 3);
    let later = NOW + 600_000;
    let r = rt2.run(Cause::Startup, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: later }, Some(&dbh));
    let by: HashMap<_, _> = r.edges.iter().map(|e| (e.ws.as_str(), e)).collect();
    assert_eq!(by.len(), 3, "a unchanged, b archived, gone removed, d new");
    assert!(by.values().all(|e| e.while_down && e.hold_until_ms == later + c.restart_grace_ms));
    assert_eq!((by["b"].from.as_str(), by["b"].to.as_str()), ("active", "archived"));
    assert_eq!(by["gone"].to, "");
    assert_eq!(r.repairs, 0, "start-up differences are not event-layer repairs");
    // persisted state follows: a third start sees no difference
    dbh.barrier().unwrap();
    let rt3 = Rt::new(c, det(&t.0, &db));
    assert_eq!(rt3.load_persisted(&dbh), 3);
    let r = rt3.run(Cause::Startup, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: later + 1 }, Some(&dbh));
    assert!(r.edges.is_empty());
    assert!(rt3.current().generation >= 1);
    dbh.barrier().unwrap();
    let n: i64 = dbh.read(|c| c.query_row("SELECT COUNT(*) FROM rt_edges", [], |r| r.get(0))).unwrap();
    assert_eq!(n, 3, "the edge log holds the three start-up changes");
}

#[test]
fn edge_log_is_capped() {
    let (t, db) = fixture();
    let hot = TempDir::new("rt2-cap");
    let dbh = Db::open(&hot.0).unwrap();
    let mut c = cfg();
    c.edge_cap = 5;
    let rt = Rt::new(c, det(&t.0, &db));
    let p = Stub::default();
    make_db(&db, &[("a", 1, 0, vec![], None)], &[]);
    rt.run(Cause::Startup, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW }, Some(&dbh));
    for i in 0..12 {
        make_db(&db, &[("a", i % 2, 0, vec![], None)], &[]);
        rt.run(Cause::Event, &Inputs { app: Some(&read(&db)), probe: &p, gh: None, now: NOW + i }, Some(&dbh));
    }
    dbh.barrier().unwrap();
    let n: i64 = dbh.read(|c| c.query_row("SELECT COUNT(*) FROM rt_edges", [], |r| r.get(0))).unwrap();
    assert_eq!(n, 5);
    assert!(rt.edges_since(0).len() <= 5);
}

#[test]
fn devswarm_absent_is_inert() {
    let t = TempDir::new("rt2-absent");
    let home = t.0.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let env: HashMap<String, String> = HashMap::new();
    let d = devswarm_rt::detect(&home, &env);
    assert!(d.app_db.is_none() && !d.descriptors && !d.active());
    assert!(devswarm_rt::start(&home, &env).is_none());
    assert_eq!(std::fs::read_dir(&home).unwrap().count(), 0, "detection creates nothing");
    // present: the app database appears -> active; mode off -> inert again
    let db = home.join("fixture.db");
    make_db(&db, &[], &[]);
    let mut env2 = HashMap::new();
    env2.insert("ANTIHALL_DEVSWARM_APP_DB".to_string(), db.to_string_lossy().to_string());
    assert!(devswarm_rt::detect(&home, &env2).active());
    assert!(devswarm_rt::start(&home, &env2).is_some());
    assert_eq!(Mode::parse("OFF"), Mode::Off);
    assert_eq!(Mode::parse("typo"), Mode::Off, "a mistyped mode never turns the layer on");
    assert_eq!(Mode::parse("observe"), Mode::Observe);
    let off = Detection { mode: Mode::Off, ..d_with_db(&home, &db) };
    assert!(!off.active());
    assert_eq!(Mode::from_defaults(), Mode::On, "live by default");
}

fn d_with_db(home: &Path, db: &Path) -> Detection {
    det(home, db)
}

#[test]
fn reading_never_writes_the_app_db() {
    let (_t, db) = fixture();
    make_db(&db, &[("a", 1, 0, vec![("resumable", 1)], None)], &[]);
    let before = (std::fs::read(&db).unwrap(), std::fs::metadata(&db).unwrap().modified().unwrap());
    let c = cfg();
    let app = read(&db);
    let rt = Rt::new(c, det(Path::new("/nonexistent-home"), &db));
    rt.run(Cause::Startup, &Inputs { app: Some(&app), probe: &Stub::default(), gh: None, now: NOW }, None);
    let after = (std::fs::read(&db).unwrap(), std::fs::metadata(&db).unwrap().modified().unwrap());
    assert!(before == after, "I5: the source is untouched");
    assert!(!db.with_extension("db-wal").exists() || std::fs::metadata(db.with_extension("db-wal")).unwrap().len() == 0);
}

#[test]
fn shadow_compares_with_the_witness_tree_and_logs_mismatches() {
    let (t, db) = fixture();
    make_db(&db, &[("a", 1, 0, vec![], None), ("b", 1, 0, vec![], None), ("z", 0, 1, vec![], None)], &[]);
    let c = cfg();
    let mut p = Stub::default();
    p.hb.insert("a".into(), NOW - 1);
    p.hb.insert("b".into(), NOW - c.stall_ms - 5);
    p.unread.insert("a".into(), 2);
    let s = snap_of(&c, Some(&read(&db)), &p, None, NOW, &Snapshot::default());
    let w = t.0.join("witness");
    std::fs::create_dir_all(w.join("liveness")).unwrap();
    assert!(shadow::compare(&s, &w).is_none(), "no witness files yet is not a mismatch");
    // witness agrees on a (alive, pending) and b (stuck); says z is also active and 2 archived
    std::fs::write(w.join("app-state.json"), r#"{"active":[{"id":"a"},{"id":"b"},{"id":"z"}],"counts":{"active":3,"archived":2}}"#).unwrap();
    std::fs::write(w.join("liveness/a.json"), r#"{"status":"alive","pending":true}"#).unwrap();
    std::fs::write(w.join("liveness/b.json"), r#"{"status":"escalated","pending":false}"#).unwrap();
    let m = shadow::compare(&s, &w).unwrap();
    let got: Vec<_> = m.iter().map(|m| (m.check, m.id.as_str())).collect();
    assert_eq!(got, vec![("active_set", "z"), ("archived_count", "")], "{m:?}");
    // witness disagrees on b's stuck verdict
    std::fs::write(w.join("liveness/b.json"), r#"{"status":"alive","pending":false}"#).unwrap();
    assert!(shadow::compare(&s, &w).unwrap().iter().any(|m| m.check == "stuck" && m.id == "b"));
    let log = t.0.join("rt-shadow.ndjson");
    assert_eq!(shadow::append(&log, NOW, 1, &m).unwrap(), 2);
    assert_eq!(shadow::append(&log, NOW, 1, &[]).unwrap(), 0);
    assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 2);
    assert!(shadow::witness_dir(Path::new("/h")).starts_with("/h/.anti-hall/ah-node-shadow/scratch-home"));
}

// ---- property tests: the invariants hold for any sources ------------------------------------------------------------

type Spec = (i64, i64, Vec<(usize, i64)>, bool, Option<i64>, Option<usize>);

fn arb_builder() -> impl Strategy<Value = Spec> {
    (
        0i64..=1,
        0i64..=1,
        proptest::collection::vec((0usize..3, 0i64..=1), 0..4),
        any::<bool>(),
        proptest::option::of(-3_000_000i64..3_000_000),
        proptest::option::of(0usize..5),
    )
}

fn build(specs: &[Spec], path: &Path) -> (Stub, ()) {
    const PANELS: [&str; 3] = ["new", "pending", "resumable"];
    let c = {
        std::fs::remove_file(path).ok(); // absent is the goal state
        Connection::open(path).unwrap()
    };
    c.execute_batch(
        "CREATE TABLE builders (id TEXT PRIMARY KEY, branchName TEXT, worktreePath TEXT, isHidden INTEGER, pullRequestId TEXT, isActive INTEGER);
         CREATE TABLE builder_terminals (id INTEGER PRIMARY KEY, builderId TEXT, panelStatus TEXT, isActive INTEGER);
         CREATE TABLE pull_requests (id TEXT PRIMARY KEY, number INTEGER, state TEXT, checkStatus TEXT, lastSyncedAt TEXT);
         INSERT INTO pull_requests VALUES ('p0', 1, 'open', 'Pending', '2026-10-08T00:00:00Z'), ('p1', 2, 'merged', 'Passed', '2026-10-08T00:00:00Z'), ('p2', 3, 'closed', 'Failed', 'x'), ('p3', 4, 'open', 'Failed', NULL), ('p4', 5, 'weird', 'weird', '2026-10-08T00:00:00Z');",
    )
    .unwrap();
    let mut stub = Stub::default();
    for (i, (act, hid, terms, unread, hb, pr)) in specs.iter().enumerate() {
        let id = format!("w{i}");
        c.execute("INSERT INTO builders VALUES (?1, 'b', ?2, ?3, ?4, ?5)", params![id, format!("/wt/{id}"), hid, pr.map(|p| format!("p{p}")), act]).unwrap();
        for (s, a) in terms {
            c.execute("INSERT INTO builder_terminals (builderId, panelStatus, isActive) VALUES (?1, ?2, ?3)", params![id, PANELS[*s], a]).unwrap();
        }
        if let Some(h) = hb {
            stub.hb.insert(id.clone(), NOW + h);
        }
        if *unread {
            stub.unread.insert(id, 3);
        }
    }
    (stub, ())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 48, ..ProptestConfig::default() })]

    #[test]
    fn invariants_hold_for_any_sources(a in proptest::collection::vec(arb_builder(), 0..6), b in proptest::collection::vec(arb_builder(), 0..6), proven in any::<bool>()) {
        let t = TempDir::new("rt2-prop");
        let db = t.0.join("d.db");
        let mut c = cfg();
        c.paused_proven = proven;
        let (pa, _) = build(&a, &db);
        let ra = read(&db);
        let s1 = snap_of(&c, Some(&ra), &pa, None, NOW, &Snapshot::default());
        prop_assert!(state::check_invariants(&c, &s1, &[], NOW).is_empty());
        // identical sources: no edges (I4)
        let again = snap_of(&c, Some(&ra), &pa, None, NOW + 1, &s1);
        prop_assert!(state::diff(&s1, &again, &c, 1, NOW + 1, false).is_empty());
        // changed sources: every edge is a real change, and none is a stuck/CI/paused edge on a finished workspace (I2, I4)
        let (pb, _) = build(&b, &db);
        let rb = read(&db);
        let s2 = snap_of(&c, Some(&rb), &pb, None, NOW + 2, &s1);
        let mut next = s2.clone();
        next.generation = 1;
        let edges = state::diff(&s1, &next, &c, 1, NOW + 2, false);
        let bad = state::check_invariants(&c, &next, &edges, NOW + 2);
        prop_assert!(bad.is_empty(), "{:?}", bad);
        for e in &edges { prop_assert!(e.from != e.to); }
        // nothing says paused unless the signal is proven (I1)
        for w in s2.workspaces.values() { prop_assert!(!matches!(w.paused.value, Paused::Yes(_)) || proven); }
        // I3
        for w in s2.workspaces.values() {
            prop_assert_eq!(w.pr.is_stale(NOW + 2, c.stale_ms), (NOW + 2) - w.pr.observed_ms > c.stale_ms);
        }
        // reconcile of the old state toward the new one equals the diff: a finished workspace never carries an Activity edge
        for e in edges.iter().filter(|e| e.kind == EdgeKind::Activity) {
            prop_assert!(!matches!(next.workspaces[&e.ws].lifecycle.value, Lifecycle::Archived | Lifecycle::Closed));
        }
    }
}

#[test]
fn defaults_parse_and_are_live_by_default() {
    let c = cfg();
    assert!(c.stall_ms > 0 && c.stale_ms > 0 && c.edge_cap >= 10);
    assert_eq!(c.namespace, "devswarm");
}
