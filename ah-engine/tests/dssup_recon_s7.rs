//! The reconcile port, slice S7 (archived registry rows and twin descriptors), against Node's own functions.
//!
//! Every case builds a scratch home, plans with the engine and runs the witness gate: Node's function on one mirror, the engine's
//! op list on another, byte-compared (hard-link counts included), then applied to the real (scratch) home. A case passes only
//! when the gate agrees, or the engine defers for a stated reason before writing. Crash tests kill a child process with SIGKILL at
//! every op boundary and then let Node's next run converge. Each parity test prints a `PARITY` line.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report

use ah_engine::checks::git::util::Settings;
use ah_engine::checks::guardkit::ojson::OVal;
use ah_engine::dsact::runner::{Runner, System};
use ah_engine::dssup::recon::gate::{self, Verdict};
use ah_engine::dssup::recon::{Hooks, RegRow, archive, norm, view};
use ah_engine::dssup::tick::Ctx;
use ah_engine::meshw::store::{MeshStore, RegistryRow};
use std::collections::HashMap;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;

const NOW: i64 = 1_760_000_000_000;

fn have(bin: &str) -> bool {
    Command::new(bin).arg("--version").output().is_ok_and(|o| o.status.success())
}

fn node_ready() -> bool {
    have("node") && have("git")
}

struct Fix {
    home: PathBuf,
    st: Settings,
    root: PathBuf,
}

fn init_defaults() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: set once, before this process reads the defaults; nothing else here touches this variable
        unsafe { std::env::set_var("AH_ENGINE_PLUGIN_ROOT", Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("plugins/anti-hall")) };
        ah_engine::defaults::init().expect("defaults load");
    });
}

fn fix(tag: &str) -> Fix {
    init_defaults();
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let home = PathBuf::from(std::env::var("HOME").unwrap()).join(".anti-hall/scratch/recon-tests").join(format!(
        "s7-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&home).unwrap();
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    Fix { home, st, root: ah_engine::defaults::root().unwrap() }
}

impl Fix {
    fn ctx(&self) -> Ctx<'_> {
        Ctx { home: &self.home, root: &self.root, st: &self.st, now: NOW, engine_pokes: false }
    }
    fn ds(&self, rel: &str) -> String {
        format!(".anti-hall/devswarm/{rel}")
    }
    fn put(&self, rel: &str, text: &str) {
        let p = self.home.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.home.join(rel)).ok()
    }
    fn exists(&self, rel: &str) -> bool {
        self.home.join(rel).exists()
    }
    fn ino(&self, rel: &str) -> Option<(u64, u64)> {
        std::fs::symlink_metadata(self.home.join(rel)).ok().map(|m| (m.dev(), m.ino()))
    }
    fn repo(&self, name: &str) -> String {
        let p = self.home.join("repos").join(name);
        std::fs::create_dir_all(&p).unwrap();
        assert!(Command::new("git").args(["init", "-q"]).current_dir(&p).status().unwrap().success());
        std::fs::canonicalize(&p).unwrap().to_string_lossy().into_owned()
    }
    fn key_of(&self, wt: &str) -> String {
        ah_engine::meshw::ident::repo_key_for_worktree(wt).unwrap().unwrap()
    }
    fn store(&self, key: &str) -> MeshStore {
        let dir = self.home.join(self.ds(&format!("store/{key}")));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("BACKEND"), "sqlite\n").unwrap();
        MeshStore::open(&dir.join("devswarm.db")).unwrap()
    }
    fn row(&self, key: &str, id: &str, wt: &str, sid: &str) {
        let st = self.store(key);
        let r = RegistryRow {
            id: id.into(),
            worktree_path: Some(wt.into()),
            session_id: Some(sid.into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
    }
    fn desc(&self, id: &str, wt: &str, sid: &str) -> String {
        format!("{{\"id\":\"{id}\",\"worktreePath\":\"{wt}\",\"sessionId\":\"{sid}\",\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":null}}")
    }
    fn live(&self, id: &str, wt: &str, sid: &str) {
        self.put(&self.ds(&format!("workspaces/{id}.json")), &self.desc(id, wt, sid));
    }
    fn tomb(&self, id: &str, wt: &str, sid: &str) {
        self.put(&self.ds(&format!("archived/{id}.json")), &self.desc(id, wt, sid));
    }
    fn snapshot(&self) -> std::collections::BTreeMap<String, String> {
        let mut m = norm::dump(&self.home);
        m.retain(|k, _| !k.starts_with(".anti-hall/logs/devswarm-recon-witness"));
        m
    }
    fn registry(&self, key: &str) -> Vec<RegRow> {
        view::registry(&self.home, key).unwrap()
    }
}

struct Tally {
    name: &'static str,
    cases: std::cell::Cell<u32>,
    identical: std::cell::Cell<u32>,
    deferred: std::cell::Cell<u32>,
}

impl Tally {
    fn new(name: &'static str) -> Tally {
        Tally { name, cases: 0.into(), identical: 0.into(), deferred: 0.into() }
    }
    fn case(&self, deferred: bool) {
        self.cases.set(self.cases.get() + 1);
        if deferred { self.deferred.set(self.deferred.get() + 1) } else { self.identical.set(self.identical.get() + 1) }
    }
    fn print(&self) {
        println!("PARITY {}: cases={} identical={} deferred={}", self.name, self.cases.get(), self.identical.get(), self.deferred.get());
    }
}

/// Run a plan through the gate: the witness must agree and every unit must apply.
fn agreed(f: &Fix, plan: &archive::Plan) -> archive::Run {
    let r = archive::run_plan(&f.ctx(), &System::configured() as &dyn Runner, plan, &Hooks::none());
    assert_eq!(r.verdict, Verdict::Agreed, "{}: {:?}", plan.job.label, r.verdict);
    assert!(r.deferred.is_empty(), "{}: {:?}", plan.job.label, r.deferred);
    r
}

/// The second pass over the result writes nothing (the resume marker may be rewritten with the same bytes).
fn settles(f: &Fix, again: impl Fn() -> archive::Plan) {
    let before = f.snapshot();
    agreed(f, &again());
    assert_eq!(f.snapshot(), before, "the second pass wrote something");
}

// ---- archiveLeftReason and pickArchiveForwardSurvivor ------------------------------------------------------------------------

#[test]
fn archive_left_reason_matches_node_for_every_branch() {
    if !node_ready() {
        return;
    }
    let t = Tally::new("S7.archiveLeftReason");
    let f = fix("reason");
    let p = f.repo("p");
    f.live("withdesc", &p, "s1");
    let cases: Vec<(&str, Option<Option<&str>>, bool, &str)> = vec![
        ("withdesc", Some(Some("s1")), true, "mesh-anchor-attended"),
        ("nodesc", Some(Some("s1")), false, "raced-re-register"),
        ("nodesc", None, false, "raced-re-register"),
        ("withdesc", Some(Some("s1")), false, "live-descriptor"),
        ("withdesc", None, false, "live-descriptor"),
        ("withdesc", Some(None), false, "descriptor-no-live-session"),
        ("withdesc", Some(Some("")), false, "descriptor-no-live-session"),
        ("withdesc", Some(Some("unclaimed:withdesc")), false, "descriptor-no-live-session"),
    ];
    for (id, row, anchor, want) in cases {
        assert_eq!(archive::archive_left_reason(&f.home, id, row, anchor), want);
        let job = archive::left_reason_job(&f.home, id, row, anchor);
        let out = gate::run(&f.ctx(), &System::configured(), &job, &Hooks::none());
        assert_eq!(out.verdict, Verdict::Agreed, "{id} {row:?} {anchor}: {:?}", out.verdict);
        t.case(false);
    }
    t.print();
}

fn reg_row(id: &str, wt: &str, sid: Option<&str>) -> RegRow {
    RegRow {
        row: RegistryRow {
            id: id.into(),
            worktree_path: Some(wt.into()),
            session_id: sid.map(Into::into),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        },
        updated_at: Some(1),
        write_seq: Some(1),
    }
}

#[test]
fn pick_archive_forward_survivor_matches_node_and_defers_a_tie() {
    if !node_ready() {
        return;
    }
    let t = Tally::new("S7.pickArchiveForwardSurvivor");
    let f = fix("pick");
    let p = f.repo("p");
    f.live("live1", &p, "sess-1");
    f.live("live2", &p, "sess-2");
    f.live("dead", &p, "unclaimed:dead");
    let one = |rows: Vec<RegRow>, want: &str| {
        let got = archive::pick_archive_forward_survivor(&f.home, "arch", &rows).unwrap();
        assert_eq!(got, want);
        let out = gate::run(&f.ctx(), &System::configured(), &archive::survivor_job(&f.home, "arch", &rows, &got), &Hooks::none());
        assert_eq!(out.verdict, Verdict::Agreed, "{rows:?}: {:?}", out.verdict);
        t.case(false);
    };
    one(vec![], "arch");
    one(vec![reg_row("phantom", &p, Some("sess-x"))], "arch"); // no descriptor: cannot drain
    one(vec![reg_row("dead", &p, Some("unclaimed:dead"))], "arch"); // descriptor but dead session
    one(vec![reg_row("dead", &p, None)], "arch");
    one(vec![reg_row("arch", &p, Some("s"))], "arch"); // the archived id itself is never a destination
    one(vec![reg_row("live1", &p, Some("sess-1"))], "live1");
    one(vec![reg_row("live1", &p, Some("sess-1")), reg_row("dead", &p, Some("unclaimed:dead")), reg_row("phantom", &p, Some("s"))], "live1");
    // two drainable siblings need pickSurvivor's evidence ranking: handed to Node
    let two = vec![reg_row("live1", &p, Some("sess-1")), reg_row("live2", &p, Some("sess-2"))];
    assert!(archive::pick_archive_forward_survivor(&f.home, "arch", &two).is_err());
    t.case(true);
    t.print();
}

// ---- retireIdentityFamilyDescriptors ------------------------------------------------------------------------------------------

struct RetireCase {
    name: &'static str,
    build: fn(&Fix, &str),
    require_gone: bool,
    retired: &'static [&'static str],
    left: &'static [(&'static str, &'static str)],
}

const GONE: &str = "/nonexistent/s7/gone";

fn retire_cases() -> Vec<RetireCase> {
    vec![
        RetireCase {
            name: "twin by session cross-link, no gate",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
            },
            require_gone: false,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "twin whose own session is the tombstone id",
            build: |f, p| {
                f.tomb("A", p, "s");
                f.live("B", p, "A");
            },
            require_gone: false,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "migration gate: worktree still there stays active",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
            },
            require_gone: true,
            retired: &[],
            left: &[("B", "live-or-unprovable-worktree")],
        },
        RetireCase {
            name: "migration gate: worktree provably gone is retired",
            build: |f, _| {
                f.tomb("A", GONE, "B");
                f.live("B", GONE, "x");
            },
            require_gone: true,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "unrelated live sibling on the same worktree is never retired",
            build: |f, p| {
                f.tomb("A", p, "s1");
                f.live("B", p, "s2");
            },
            require_gone: false,
            retired: &[],
            left: &[],
        },
        RetireCase {
            name: "an archived file that is another inode is never clobbered",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                f.put(&f.ds("archived/B.json"), "{\"id\":\"B\",\"other\":true}");
            },
            require_gone: false,
            retired: &[],
            left: &[("B", "archived-tombstone-differs")],
        },
        RetireCase {
            name: "equal bytes at another inode is equally not ours",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                f.put(&f.ds("archived/B.json"), &f.desc("B", p, "x"));
            },
            require_gone: false,
            retired: &[],
            left: &[("B", "archived-tombstone-differs")],
        },
        RetireCase {
            name: "a half-done retire (already linked) is finished",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                std::fs::hard_link(f.home.join(f.ds("workspaces/B.json")), f.home.join(f.ds("archived/B.json"))).unwrap();
            },
            require_gone: false,
            retired: &["B"],
            left: &[],
        },
        RetireCase {
            name: "two twins and a malformed descriptor",
            build: |f, p| {
                f.tomb("A", p, "B");
                f.live("B", p, "x");
                f.live("C", p, "A");
                f.put(&f.ds("workspaces/D.json"), "{\"id\":\"WRONG\",\"sessionId\":\"A\"}");
                f.put(&f.ds("workspaces/E.json"), "not json");
            },
            require_gone: false,
            retired: &["B", "C"],
            left: &[],
        },
        RetireCase {
            name: "no twins at all",
            build: |f, p| {
                f.tomb("A", p, "s");
            },
            require_gone: false,
            retired: &[],
            left: &[],
        },
    ]
}

fn tomb_of(f: &Fix, id: &str) -> OVal {
    OVal::parse(&f.read(&f.ds(&format!("archived/{id}.json"))).unwrap()).unwrap()
}

#[test]
fn retire_identity_family_descriptors_matches_node_for_every_shape() {
    if !node_ready() {
        return;
    }
    let t = Tally::new("S7.retireIdentityFamilyDescriptors");
    for c in retire_cases() {
        let f = fix("retire");
        let p = f.repo("p");
        (c.build)(&f, &p);
        let desc = tomb_of(&f, "A");
        let plan = archive::retire_identity_family(&f.home, "A", &desc, c.require_gone).unwrap_or_else(|d| panic!("{}: deferred {d:?}", c.name));
        let got = &plan.result;
        let want_retired: Vec<&str> = c.retired.to_vec();
        assert_eq!(got["retired"], serde_json::json!(want_retired), "{}", c.name);
        let want_left: Vec<serde_json::Value> = c.left.iter().map(|(i, r)| serde_json::json!({"id": i, "reason": r})).collect();
        assert_eq!(got["left"], serde_json::Value::Array(want_left), "{}", c.name);
        agreed(&f, &plan);
        // the descriptor of each retired twin is under archived/ (hard-linked: one file) and gone from workspaces/
        for id in c.retired {
            assert!(!f.exists(&f.ds(&format!("workspaces/{id}.json"))), "{}: {id} still active", c.name);
            assert!(f.exists(&f.ds(&format!("archived/{id}.json"))), "{}: {id} not archived", c.name);
        }
        settles(&f, || archive::retire_identity_family(&f.home, "A", &desc, c.require_gone).unwrap());
        t.case(false);
    }
    t.print();
}

#[test]
fn retire_is_deferred_when_node_would_create_the_archived_directory() {
    let f = fix("retire-nodir");
    let p = f.repo("p");
    f.live("B", &p, "x");
    let desc = OVal::parse(&f.desc("A", &p, "B")).unwrap();
    assert!(archive::retire_identity_family(&f.home, "A", &desc, false).is_err());
}

// ---- foldArchivedFamilyDescriptors ----------------------------------------------------------------------------------------------

#[test]
fn fold_archived_family_matches_node_including_the_budget_and_the_resume_marker() {
    if !node_ready() {
        return;
    }
    let t = Tally::new("S7.foldArchivedFamilyDescriptors");
    let setup = |tag: &str| {
        let f = fix(tag);
        // three tombstones; T1 and T2 both name twin X (reported once), T3 names Y whose worktree is still there
        let p = f.repo("p");
        f.tomb("T1", GONE, "X");
        f.tomb("T2", GONE, "X");
        f.tomb("T3", GONE, "Y");
        f.live("X", GONE, "x");
        f.live("Y", &p, "y");
        f.live("Z", GONE, "T1"); // twin by its own session
        f
    };
    // a plain pass
    let f = setup("fam-plain");
    let plan = archive::fold_archived_family(&f.home, NOW, None).unwrap();
    assert_eq!(plan.result["retired"], serde_json::json!(["X", "Z"]));
    assert_eq!(plan.result["left"], serde_json::json!([{"id": "Y", "reason": "live-or-unprovable-worktree"}]));
    agreed(&f, &plan);
    assert!(f.exists(&f.ds("archived/X.json")) && !f.exists(&f.ds("workspaces/X.json")));
    assert!(!f.exists(&f.ds("fold-archived-family-resume.json")));
    settles(&f, || archive::fold_archived_family(&f.home, NOW, None).unwrap());
    t.case(false);
    // an exhausted budget: the first tombstone always runs, the rest wait in the marker; the next pass starts with them
    let f = setup("fam-budget");
    let plan = archive::fold_archived_family(&f.home, NOW, Some(NOW - 1)).unwrap();
    assert_eq!(plan.result["budgetExhausted"], serde_json::json!(true));
    assert_eq!(plan.result["skipped"], serde_json::json!(2));
    agreed(&f, &plan);
    let marker = f.read(&f.ds("fold-archived-family-resume.json")).unwrap();
    assert!(marker.contains("\"ids\":[\"T2\",\"T3\"]"), "{marker}");
    t.case(false);
    let plan = archive::fold_archived_family(&f.home, NOW, None).unwrap();
    agreed(&f, &plan);
    assert!(!f.exists(&f.ds("fold-archived-family-resume.json")), "a drained pass leaves no marker");
    t.case(false);
    // a resume marker orders the work first, whatever the directory order
    let f = setup("fam-resume");
    f.put(&f.ds("fold-archived-family-resume.json"), "{\"ids\":[\"T3\",\"gone-id\",5],\"ts\":1}");
    agreed(&f, &archive::fold_archived_family(&f.home, NOW, Some(NOW - 1)).unwrap());
    t.case(false);
    // a torn marker (Node writes it in place) reads as absent
    let f = setup("fam-torn");
    f.put(&f.ds("fold-archived-family-resume.json"), "{\"ids\":[\"T3\",");
    assert!(archive::read_family_resume(&f.home).is_empty());
    agreed(&f, &archive::fold_archived_family(&f.home, NOW, None).unwrap());
    assert!(!f.exists(&f.ds("fold-archived-family-resume.json")));
    t.case(false);
    // a marker naming an id twice is Node's
    let f = setup("fam-dup");
    f.put(&f.ds("fold-archived-family-resume.json"), "{\"ids\":[\"T2\",\"T2\"]}");
    assert!(archive::fold_archived_family(&f.home, NOW, None).is_err());
    t.case(true);
    // no archived directory: nothing to do, no marker touched
    let f = fix("fam-none");
    let plan = archive::fold_archived_family(&f.home, NOW, None).unwrap();
    assert!(plan.job.units.is_empty());
    agreed(&f, &plan);
    t.case(false);
    t.print();
}

// ---- foldArchivedRegistryRows ------------------------------------------------------------------------------------------------

#[test]
fn fold_archived_rows_matches_node_for_every_shape_and_defers_a_group_fold() {
    if !node_ready() {
        return;
    }
    let t = Tally::new("S7.foldArchivedRegistryRows");
    // the archived id's own row is retired and the summary re-derived
    let f = fix("rows-own");
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.tomb("a1", &p, "s1");
    f.row(&k, "a1", &p, "s1");
    f.row(&k, "other", "/elsewhere", "s9");
    let plan = archive::fold_archived_rows(&f.home, NOW, None).unwrap();
    assert_eq!(plan.result["retired"], serde_json::json!([format!("a1@{k}")]));
    agreed(&f, &plan);
    assert_eq!(f.registry(&k).iter().map(|r| r.row.id.clone()).collect::<Vec<_>>(), vec!["other"]);
    settles(&f, || archive::fold_archived_rows(&f.home, NOW, None).unwrap());
    t.case(false);
    // a live drainable sibling on the worktree is the survivor: reported, kept; nothing to fold into it
    let f = fix("rows-live");
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.tomb("a1", &p, "s1");
    f.row(&k, "a1", &p, "s1");
    f.row(&k, "sib", &p, "sess-sib");
    f.live("sib", &p, "sess-sib");
    let plan = archive::fold_archived_rows(&f.home, NOW, None).unwrap();
    assert_eq!(plan.result["left"], serde_json::json!([{"id": "sib", "bucket": k, "reason": "live-descriptor"}]));
    agreed(&f, &plan);
    assert_eq!(f.registry(&k).len(), 1);
    t.case(false);
    // a sibling that would have to be folded into a survivor is slice S6: the whole pass is Node's, nothing written
    let f = fix("rows-fold");
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.tomb("a1", &p, "s1");
    f.row(&k, "a1", &p, "s1");
    f.row(&k, "phantom", &p, "s2");
    let before = f.snapshot();
    assert!(archive::fold_archived_rows(&f.home, NOW, None).is_err());
    assert_eq!(f.snapshot(), before);
    t.case(true);
    // an empty session is a NULL guard that the stored empty text never satisfies: raced-re-register, nothing deleted
    let f = fix("rows-empty-session");
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.tomb("a1", &p, "s1");
    f.row(&k, "a1", &p, "");
    let plan = archive::fold_archived_rows(&f.home, NOW, None).unwrap();
    assert_eq!(plan.result["left"], serde_json::json!([{"id": "a1", "bucket": k, "reason": "raced-re-register"}]));
    agreed(&f, &plan);
    assert_eq!(f.registry(&k).len(), 1);
    t.case(false);
    // two buckets and a spent budget: the first pair runs, the rest are written to the marker per bucket, and the next pass
    // starts with them
    let f = fix("rows-budget");
    let (p, q) = (f.repo("p"), f.repo("q"));
    let (kp, kq) = (f.key_of(&p), f.key_of(&q));
    for (id, wt, key) in [("a1", &p, &kp), ("a2", &q, &kq)] {
        f.tomb(id, wt, "s");
        f.row(key, id, wt, "s");
    }
    let plan = archive::fold_archived_rows(&f.home, NOW, Some(NOW - 1)).unwrap();
    assert_eq!(plan.result["budgetExhausted"], serde_json::json!(true));
    agreed(&f, &plan);
    let marker = f.read(&f.ds("fold-archived-resume.json")).unwrap();
    assert!(marker.contains("\"buckets\""), "{marker}");
    t.case(false);
    agreed(&f, &archive::fold_archived_rows(&f.home, NOW, None).unwrap());
    assert!(!f.exists(&f.ds("fold-archived-resume.json")));
    assert!(f.registry(&kp).is_empty() && f.registry(&kq).is_empty());
    t.case(false);
    // a torn marker reads as absent
    let f = fix("rows-torn");
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.tomb("a1", &p, "s1");
    f.row(&k, "a1", &p, "s1");
    f.put(&f.ds("fold-archived-resume.json"), "{\"buckets\":{\"abc\":[\"a1\"");
    assert!(archive::read_rows_resume(&f.home).is_empty());
    agreed(&f, &archive::fold_archived_rows(&f.home, NOW, None).unwrap());
    t.case(false);
    // a store that is not SQLite is Node's
    let f = fix("rows-journal");
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.tomb("a1", &p, "s1");
    f.put(&f.ds(&format!("store/{k}/BACKEND")), "journal\n");
    assert!(archive::fold_archived_rows(&f.home, NOW, None).is_err());
    t.case(true);
    // a tombstone with a live descriptor of the same id is a mid-archive state: not this pass's
    let f = fix("rows-midarchive");
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.tomb("a1", &p, "s1");
    f.live("a1", &p, "s1");
    f.row(&k, "a1", &p, "s1");
    let plan = archive::fold_archived_rows(&f.home, NOW, None).unwrap();
    assert_eq!(plan.result["scanned"], serde_json::json!(0));
    agreed(&f, &plan);
    assert_eq!(f.registry(&k).len(), 1);
    t.case(false);
    t.print();
}

// ---- restoreArchivedDescriptor ---------------------------------------------------------------------------------------------

fn restore_fixture(f: &Fix, with_row: bool) -> (String, String) {
    let p = f.repo("p");
    let k = f.key_of(&p);
    f.put(
        &f.ds("archived/W.json"),
        &format!("{{\"id\":\"W\",\"worktreePath\":\"{p}\",\"sessionId\":\"sw\",\"archivedBy\":\"op\",\"archivedAt\":5,\"inboxPath\":null,\"cursorPath\":null,\"nudgeCommand\":[\"a\",\"b\"]}}"),
    );
    // the owner's store exists (an empty one, or with the id's row)
    let st = f.store(&k);
    if with_row {
        let r = RegistryRow {
            id: "W".into(),
            worktree_path: Some(p.clone()),
            session_id: Some("old".into()),
            inbox_path: None,
            cursor_path: None,
            nudge_command: None,
        };
        assert!(st.upsert_registry(&r, 1_000, |_, _| true).unwrap());
    }
    (p, k)
}

#[test]
fn restore_archived_descriptor_matches_node_in_both_modes() {
    if !node_ready() {
        return;
    }
    let t = Tally::new("S7.restoreArchivedDescriptor");
    let run = |f: &Fix, o: &archive::RestoreOpts| {
        let plan = archive::restore_archived_descriptor(&f.home, "W", o).unwrap_or_else(|d| panic!("deferred {d:?}"));
        agreed(f, &plan);
        plan.result
    };
    // unarchive: link back, unlink the archived name, persist the owner key without the marker fields, revive the row
    let f = fix("restore-move");
    let (p, k) = restore_fixture(&f, false);
    let res = run(&f, &archive::RestoreOpts::default());
    assert_eq!(res, serde_json::json!({"ok": true, "restoredLink": true}));
    assert!(!f.exists(&f.ds("archived/W.json")));
    let d = f.read(&f.ds("workspaces/W.json")).unwrap();
    assert!(d.contains(&format!("\"ownerKey\":\"{k}\"")) && !d.contains("archivedBy") && !d.contains("archivedAt"), "{d}");
    assert_eq!(f.registry(&k)[0].row.worktree_path.as_deref(), Some(p.as_str()));
    t.case(false);
    // the same, owner key required and matching
    let f = fix("restore-owner");
    let (_, k) = restore_fixture(&f, false);
    run(&f, &archive::RestoreOpts { keep_marker: false, require_owner_key: Some(k) });
    t.case(false);
    // a different project refuses and writes nothing
    let f = fix("restore-other");
    restore_fixture(&f, false);
    let before = f.snapshot();
    let res = run(&f, &archive::RestoreOpts { keep_marker: false, require_owner_key: Some("someone-else".into()) });
    assert_eq!(res["ok"], serde_json::json!(false));
    assert_eq!(f.snapshot(), before);
    t.case(false);
    // the row already there (same worktree): upserted again (the clock and write_seq move)
    let f = fix("restore-row");
    let (_, k) = restore_fixture(&f, true);
    run(&f, &archive::RestoreOpts::default());
    assert_eq!(f.registry(&k)[0].row.session_id.as_deref(), Some("sw"));
    t.case(false);
    // keepMarker without a live descriptor: the marker stays, a link is made
    let f = fix("restore-keep");
    restore_fixture(&f, false);
    let res = run(&f, &archive::RestoreOpts { keep_marker: true, require_owner_key: None });
    assert_eq!(res["restoredLink"], serde_json::json!(true));
    assert!(f.exists(&f.ds("archived/W.json")) && f.exists(&f.ds("workspaces/W.json")));
    t.case(false);
    // keepMarker with a live descriptor and a live row: nothing is touched but the owner key
    let f = fix("restore-keep-live");
    let (p, k) = restore_fixture(&f, true);
    f.put(&f.ds("workspaces/W.json"), &f.desc("W", &p, "live-sess"));
    run(&f, &archive::RestoreOpts { keep_marker: true, require_owner_key: None });
    assert_eq!(f.registry(&k)[0].row.session_id.as_deref(), Some("old"));
    t.case(false);
    // keepMarker with a live descriptor and no row: the row is revived from the live descriptor
    let f = fix("restore-keep-norow");
    let (p, k) = restore_fixture(&f, false);
    f.put(&f.ds("workspaces/W.json"), &f.desc("W", &p, "live-sess"));
    run(&f, &archive::RestoreOpts { keep_marker: true, require_owner_key: None });
    assert_eq!(f.registry(&k)[0].row.session_id.as_deref(), Some("live-sess"));
    t.case(false);
    // refusals: nothing archived; keepMarker without a marker; identity mismatch; a live file that is not the anchor
    let f = fix("restore-none");
    assert_eq!(run(&f, &archive::RestoreOpts::default())["ok"], serde_json::json!(false));
    assert_eq!(run(&f, &archive::RestoreOpts { keep_marker: true, require_owner_key: None })["ok"], serde_json::json!(false));
    t.case(false);
    let f = fix("restore-identity");
    let p = f.repo("p");
    f.put(&f.ds("archived/W.json"), &f.desc("NOT-W", &p, "s"));
    assert_eq!(run(&f, &archive::RestoreOpts::default())["ok"], serde_json::json!(false));
    t.case(false);
    let f = fix("restore-anchor");
    let (p, _) = restore_fixture(&f, false);
    f.put(&f.ds("workspaces/W.json"), &f.desc("W", &p, "another-file"));
    let before = f.snapshot();
    assert_eq!(run(&f, &archive::RestoreOpts::default())["ok"], serde_json::json!(false));
    assert_eq!(f.snapshot(), before);
    t.case(false);
    // a registry row on another worktree is the collision guard of upsertRegistry: Node's
    let f = fix("restore-collision");
    let (_, k) = restore_fixture(&f, false);
    f.row(&k, "W", "/somewhere/else", "x");
    assert!(archive::restore_archived_descriptor(&f.home, "W", &archive::RestoreOpts::default()).is_err());
    t.case(true);
    t.print();
}

// ---- crash safety ---------------------------------------------------------------------------------------------------------------

fn kill_hook(point: &str) -> impl Fn(&str) + '_ {
    move |name| {
        if name == point || point.strip_prefix('*').is_some_and(|tail| name.ends_with(tail)) {
            // SAFETY: SIGKILL of this very process, the point of the crash test
            unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
        }
    }
}

fn crash_fixture(f: &Fix, kind: &str) -> String {
    let p = f.repo("p");
    let k = f.key_of(&p);
    match kind {
        "retire" => {
            f.tomb("A", &p, "B");
            f.live("B", &p, "x");
        }
        "restore" => {
            let _ = restore_fixture(f, false);
        }
        _ => {
            f.tomb("a1", &p, "s1");
            f.row(&k, "a1", &p, "s1");
        }
    }
    k
}

#[test]
fn crash_child() {
    // the child half of the crash tests: does nothing unless the parent set the environment
    let (Ok(home), Ok(at), Ok(kind)) = (std::env::var("S7_CRASH_HOME"), std::env::var("S7_CRASH_AT"), std::env::var("S7_CRASH_KIND")) else { return };
    init_defaults();
    let home = PathBuf::from(home);
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    let st = Settings { home: home.to_string_lossy().into_owned(), env };
    let root = ah_engine::defaults::root().unwrap();
    let ctx = Ctx { home: &home, root: &root, st: &st, now: NOW, engine_pokes: false };
    let hook = kill_hook(&at);
    let plan = match kind.as_str() {
        "retire" => {
            let desc = OVal::parse(&std::fs::read_to_string(home.join(".anti-hall/devswarm/archived/A.json")).unwrap()).unwrap();
            archive::retire_identity_family(&home, "A", &desc, false).unwrap()
        }
        "restore" => archive::restore_archived_descriptor(&home, "W", &archive::RestoreOpts::default()).unwrap(),
        _ => archive::fold_archived_rows(&home, NOW, None).unwrap(),
    };
    let _ = archive::run_plan(&ctx, &System::configured(), &plan, &Hooks { at: &hook });
}

fn crash_run(kind: &str, point: &str) -> Option<(Fix, String)> {
    let f = fix(&format!("crash-{kind}"));
    let k = crash_fixture(&f, kind);
    let o = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
        .env("S7_CRASH_HOME", &f.home)
        .env("S7_CRASH_AT", point)
        .env("S7_CRASH_KIND", kind)
        .output()
        .unwrap();
    use std::os::unix::process::ExitStatusExt;
    (o.status.signal() == Some(9)).then_some((f, k))
}

#[test]
fn a_sigkill_between_the_hard_link_and_the_unlink_leaves_the_twin_in_both_places_and_nodes_next_run_finishes() {
    if !node_ready() {
        return;
    }
    let mut reached = 0;
    for w in ["before", "after"] {
        for i in 0..2 {
            let point = format!("retire:B:{i}:{w}");
            let Some((f, _)) = crash_run("retire", &point) else { continue };
            reached += 1;
            let (act, arch) = (f.ds("workspaces/B.json"), f.ds("archived/B.json"));
            assert!(f.exists(&act) || f.exists(&arch), "{point}: the descriptor is in neither place");
            let live = f.read(&act).or_else(|| f.read(&arch)).unwrap();
            assert!(OVal::parse(&live).is_some(), "{point}: parses");
            if f.exists(&act) && f.exists(&arch) {
                assert_eq!(f.ino(&act), f.ino(&arch), "{point}: both names are one file");
            }
            // Node's next pass finishes it
            let code = "process.env.HOME=process.argv[2];const F=require(process.argv[1]+'/scripts/devswarm-lib/fold.js');const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[2]+'/.anti-hall/devswarm/archived/A.json','utf8'));F.retireIdentityFamilyDescriptors(process.argv[2],'A',d,{})";
            let n = Command::new("node")
                .args(["-e", code, f.root.to_str().unwrap(), f.home.to_str().unwrap()])
                .env("ANTI_HALL_LOG_DIR", f.home.join("logs"))
                .output()
                .unwrap();
            assert!(n.status.success(), "{}", String::from_utf8_lossy(&n.stderr));
            assert!(!f.exists(&act) && f.exists(&arch), "{point}: converged");
            // and the engine's own next pass finds nothing left to do
            let desc = tomb_of(&f, "A");
            let again = archive::retire_identity_family(&f.home, "A", &desc, false).unwrap();
            assert!(again.job.units.is_empty(), "{point}");
        }
    }
    assert!(reached >= 3, "the kill points were reached ({reached})");
}

#[test]
fn a_sigkill_inside_a_restore_never_loses_the_descriptor_and_a_rerun_converges() {
    if !node_ready() {
        return;
    }
    let mut reached = 0;
    for w in ["before", "after"] {
        for i in 0..5 {
            let point = format!("restore:W:{i}:{w}");
            let Some((f, k)) = crash_run("restore", &point) else { continue };
            reached += 1;
            let (act, arch) = (f.ds("workspaces/W.json"), f.ds("archived/W.json"));
            assert!(f.exists(&act) || f.exists(&arch), "{point}: the descriptor is in neither place");
            for r in [&act, &arch] {
                if let Some(t) = f.read(r) {
                    assert!(OVal::parse(&t).is_some(), "{point}: {r} parses");
                }
            }
            // the rerun (engine, gated by Node) finishes the restore
            let plan = archive::restore_archived_descriptor(&f.home, "W", &archive::RestoreOpts::default()).unwrap();
            let r = archive::run_plan(&f.ctx(), &System::configured(), &plan, &Hooks::none());
            assert_eq!(r.verdict, Verdict::Agreed, "{point}: {:?}", r.verdict);
            assert!(f.exists(&act) && !f.exists(&arch), "{point}: converged");
            assert_eq!(f.registry(&k).len(), 1, "{point}");
        }
    }
    assert!(reached >= 4, "the kill points were reached ({reached})");
}

#[test]
fn a_sigkill_inside_the_rows_fold_leaves_the_row_whole_and_the_rerun_converges() {
    if !node_ready() {
        return;
    }
    let mut reached = 0;
    for w in ["before", "after"] {
        for i in 0..2 {
            // the label carries the store key, which only the built fixture knows: match on the tail
            let point = format!("*:a1:{i}:{w}");
            let f = fix("crash-rows");
            let k = crash_fixture(&f, "rows");
            let o = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "crash_child", "--nocapture", "--test-threads=1"])
                .env("S7_CRASH_HOME", &f.home)
                .env("S7_CRASH_AT", &point)
                .env("S7_CRASH_KIND", "rows")
                .output()
                .unwrap();
            use std::os::unix::process::ExitStatusExt;
            if o.status.signal() != Some(9) {
                continue;
            }
            reached += 1;
            let rows = f.registry(&k);
            assert!(rows.len() <= 1 && rows.iter().all(|r| r.row.id == "a1" && r.row.session_id.as_deref() == Some("s1")), "{point}: the row is whole or gone");
            assert!(f.exists(&f.ds("archived/a1.json")), "{point}: the tombstone is never touched");
            let r = archive::run_plan(&f.ctx(), &System::configured(), &archive::fold_archived_rows(&f.home, NOW, None).unwrap(), &Hooks::none());
            assert_eq!(r.verdict, Verdict::Agreed, "{point}: {:?}", r.verdict);
            assert!(f.registry(&k).is_empty(), "{point}: converged");
        }
    }
    assert!(reached >= 2, "the kill points were reached ({reached})");
}

// ---- the mode switch and the invariants -------------------------------------------------------------------------------------

#[test]
fn the_sweep_tail_is_node_s_unless_the_setting_says_engine() {
    let mut f = fix("mode");
    assert!(!archive::engine_mode(&f.st), "the default leaves the sweep tail to Node");
    f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "engine".into());
    assert!(archive::engine_mode(&f.st));
    f.st.env.insert("ANTIHALL_DEVSWARM_SWEEP_TAIL_MODE".into(), "bogus".into());
    assert!(!archive::engine_mode(&f.st), "an unknown value is not engine");
}

#[test]
fn the_archive_module_cannot_address_a_message_row() {
    let re = regex::Regex::new(r"(?i)(delete\s+from\s+messages|update\s+messages|insert\s+into\s+messages)").unwrap();
    let text = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/dssup/recon/archive.rs")).unwrap();
    assert!(!re.is_match(&text));
    // the only SQL step that removes anything is the conditional registry delete
    let sql = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/sql.rs")).unwrap();
    let removers: Vec<&str> = sql.lines().filter(|l| l.contains("pub const RECON_") && l.to_ascii_uppercase().contains("DELETE")).collect();
    assert_eq!(removers.len(), 1);
    assert!(removers[0].contains("FROM registry WHERE id = ? AND session_id IS ? AND updated_at IS ? AND write_seq IS ?"));
}
