//! The DevSwarm wiring (lane dswire): inert when DevSwarm is absent; a fixture app database and a stub hivecontrol end to end (a
//! state edge leads to exactly one action, from a call and from a real file event); the double-run guard; the cutover switch;
//! the per-session advisory; the statusline segment; the Jev dirty queue; the role matrix; the poke / escalate path.
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use ah_engine::cli::Parsed;
use ah_engine::db::TempDir;
use ah_engine::devswarm_rt::reconcile::{Cause, Rt};
use ah_engine::devswarm_rt::sources::{self, Probe};
use ah_engine::devswarm_rt::state::{Cfg, Inputs};
use ah_engine::devswarm_rt::{Detection, Mode};
use ah_engine::dsact::runner::{RunResult, RunSpec, Runner};
use ah_engine::dswire::{Executor, Wire, cli, consume, facts, watching};
use ah_engine::reqenv::RequestEnv;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HEAD: &str = "abc123abc123abc123abc123abc123abc123abcd";

fn now() -> i64 {
    ah_engine::health::now_ms() as i64
}

/// The hivecontrol and git stand-in: git answers a merged, clean workspace; hivecontrol records every real call.
#[derive(Default)]
struct Stub {
    calls: Mutex<Vec<Vec<String>>>,
    git_fail: Mutex<Vec<String>>,
    /// The app database the stand-in hivecontrol writes an archive into (the engine checks the database shows the archive).
    db: Mutex<Option<PathBuf>>,
    /// When set, `git status --porcelain` reports an uncommitted file (and nothing under `.git` changes).
    dirty: std::sync::atomic::AtomicBool,
}

impl Runner for Stub {
    fn run(&self, spec: &RunSpec) -> RunResult {
        let ok = |out: &str| RunResult { ok: true, status: Some(0), stdout: out.into(), ..RunResult::default() };
        if spec.bin.as_deref() == Some("git") {
            let rest: Vec<&str> = spec.args.iter().skip(2).map(String::as_str).collect();
            if self.git_fail.lock().unwrap().iter().any(|f| rest.join(" ").starts_with(f.as_str())) {
                return RunResult { ok: false, status: Some(1), ..RunResult::default() };
            }
            return match rest.as_slice() {
                ["rev-parse", "HEAD"] => ok(&format!("{HEAD}\n")),
                ["status", "--porcelain"] => ok(if self.dirty.load(std::sync::atomic::Ordering::Relaxed) { " M file\n" } else { "" }),
                ["symbolic-ref", ..] => ok("refs/remotes/origin/main\n"),
                ["rev-parse", "--verify", ..] => ok("x\n"),
                ["merge-base", ..] => ok(""),
                _ => RunResult { ok: false, status: Some(128), ..RunResult::default() },
            };
        }
        if spec.args.first().map(String::as_str) == Some("--version") {
            return ok("hivecontrol 2.5.3\n");
        }
        let mut call = spec.bin.clone().into_iter().collect::<Vec<_>>();
        call.extend(spec.args.iter().cloned());
        if let (Some(db), Some(id)) = (self.db.lock().unwrap().as_ref(), (call.get(1).map(String::as_str) == Some("archive")).then(|| call.get(2)).flatten()) {
            Connection::open(db).unwrap().execute("UPDATE builders SET isActive = 0, isHidden = 1 WHERE id = ?1", params![id]).unwrap();
        }
        self.calls.lock().unwrap().push(call);
        ok("{\"archived\":true}")
    }
}

struct Shared(Arc<Stub>);
impl Runner for Shared {
    fn run(&self, spec: &RunSpec) -> RunResult {
        self.0.run(spec)
    }
}

struct World {
    _t: TempDir,
    dir: PathBuf,
    home: PathBuf,
    state: PathBuf,
    db: PathBuf,
    wt: PathBuf,
}

fn sh(dir: &Path, args: &[&str]) {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn write(p: &Path, v: &Value) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, v.to_string()).unwrap();
}

/// One active workspace `ws-1` (done, merged, clean, idle two hours) beside a primary, in a scratch home.
fn world(tag: &str) -> World {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new(tag);
    let dir = std::fs::canonicalize(&t.0).unwrap();
    let (home, state, db) = (dir.join("home"), dir.join("state"), dir.join("devswarm.db"));
    let (wt, primary) = (dir.join("wt-1"), dir.join("wt-primary"));
    for p in [&wt, &primary, &state] {
        std::fs::create_dir_all(p).unwrap();
    }
    sh(&wt, &["init", "-q"]);
    sh(&wt, &["commit", "-q", "--allow-empty", "-m", "x"]);
    let root = home.join(".anti-hall/devswarm");
    write(&root.join("workspaces/ws-1.json"), &json!({"id": "ws-1", "worktreePath": wt, "sessionId": "s1"}));
    write(&root.join("heartbeats/ws-1.json"), &json!({"ts": now() - 7_200_000}));
    let key = facts::repo_key(wt.to_str().unwrap()).expect("repo key of a fresh git repo");
    write(
        &root.join(format!("summaries/{key}.json")),
        &json!({"workspaces": {"ws-1": {"id": "ws-1", "unread": 0, "broadcastUnread": 0, "gates": {"done": true}, "doneHead": HEAD}}}),
    );
    let w = World { _t: t, dir, home, state, db, wt };
    app_db(&w, "open");
    age_git(&w, 7_200_000); // a fresh repo's HEAD is new; this child last committed two hours ago
    w
}

/// Set the modification time of `path` to `age_ms` ago.
fn age(path: &Path, age_ms: u64) {
    let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_millis(age_ms)).unwrap();
}

/// The git activity of the worktree (HEAD and its log) happened `age_ms` ago.
fn age_git(w: &World, age_ms: u64) {
    for n in ["HEAD", "logs/HEAD"] {
        age(&w.wt.join(".git").join(n), age_ms);
    }
}

/// The transcript of ws-1's session, last written `age_ms` ago.
fn transcript(w: &World, age_ms: u64) {
    let p = facts::transcript_path(&w.home, w.wt.to_str().unwrap(), "s1");
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, "{}\n").unwrap();
    age(&p, age_ms);
}

/// (Re)write the app database: ws-1 active with a PR in `pr_state`, and a primary.
fn app_db(w: &World, pr_state: &str) {
    // Keep the inode: the watcher holds a connection and observes SQLite data_version.
    let c = Connection::open(&w.db).unwrap();
    c.execute_batch(
        "CREATE TABLE IF NOT EXISTS builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, worktreePath TEXT, label TEXT, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE IF NOT EXISTS builder_terminals (id INTEGER PRIMARY KEY, builderId TEXT, panelStatus TEXT, isActive INTEGER);
         CREATE TABLE IF NOT EXISTS pull_requests (id TEXT PRIMARY KEY, number INTEGER, state TEXT, checkStatus TEXT, lastSyncedAt TEXT);
         DELETE FROM builders; DELETE FROM builder_terminals; DELETE FROM pull_requests;",
    )
    .unwrap();
    c.execute("INSERT INTO builders VALUES ('ws-1','r1','b1',?1,'Child one',0,'p1','standard',1,NULL)", params![w.wt.to_str().unwrap()]).unwrap();
    c.execute("INSERT INTO builders VALUES ('prim','r1','main',?1,'Primary',0,NULL,'primary',1,NULL)", params![w.dir.join("wt-primary").to_str().unwrap()])
        .unwrap();
    c.execute("INSERT INTO pull_requests VALUES ('p1', 7, ?1, 'Passed', '2026-10-08T04:51:07.250Z')", params![pr_state]).unwrap();
}

fn rt(w: &World) -> Rt {
    Rt::new(Cfg::from_defaults(), Detection { app_db: Some(w.db.clone()), descriptors: true, mode: Mode::On, home: w.home.clone() })
}

fn wire(w: &World, stub: &Arc<Stub>, exec: Executor) -> Wire {
    wire_with(w, stub, exec, &[("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_EVENT_DEBOUNCE_MS", "0")])
}

/// `wire` with extra settings in the wire's environment (the event path of an edge archives once its debounce has passed).
fn wire_with(w: &World, stub: &Arc<Stub>, exec: Executor, extra: &[(&str, &str)]) -> Wire {
    *stub.db.lock().unwrap() = Some(w.db.clone());
    let sink: ah_engine::dswire::Sink = Arc::new(|_f| {});
    let mut pairs = vec![("HOME".to_string(), w.home.to_string_lossy().into_owned())];
    pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
    let env = RequestEnv::from_pairs(pairs);
    Wire::new(rt(w), &w.home, &w.state, None, sink, Box::new(Shared(stub.clone())))
        .with_executor(move |_| exec)
        .with_env(env)
        .with_act_gap(0)
        .with_jev_sweeper(Arc::new(|_, _, _| {})) // never the engine's real Jev sweep (it reads the process home)
}

/// A Jev sweeper that records the ids of every sweep it is asked for.
fn recording_sweeper() -> (ah_engine::dswire::JevSweeper, Arc<Mutex<Vec<Vec<String>>>>) {
    let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    (Arc::new(move |_, only, _| s.lock().unwrap().push(only.to_vec())), seen)
}

fn archives(stub: &Stub) -> Vec<Vec<String>> {
    stub.calls.lock().unwrap().iter().filter(|c| c.get(1).map(String::as_str) == Some("archive")).cloned().collect()
}

// ---- inert -----------------------------------------------------------------------------------------------------------------

#[test]
fn devswarm_absent_starts_nothing() {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("absent");
    let (home, state) = (t.0.join("home"), t.0.join("state"));
    std::fs::create_dir_all(&home).unwrap();
    let before = std::fs::read_dir(&t.0).unwrap().count();
    let sink: ah_engine::dswire::Sink = Arc::new(|_f| {});
    let stop: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| true);
    assert!(Wire::start(&home, &state, None, sink, stop).is_none(), "no DevSwarm, no layer");
    assert!(ah_engine::dswire::global().is_none());
    assert_eq!(std::fs::read_dir(&t.0).unwrap().count(), before, "nothing was created");
    assert!(!state.exists());
    assert_eq!(ah_engine::dswire::scheduled(), "", "the scheduled job is a no-op");
}

// ---- end to end ------------------------------------------------------------------------------------------------------------

#[test]
fn an_archive_never_acts_on_a_remembered_clean_answer() {
    let w = world("stale-clean");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Engine);
    // git's clean answer for the worktree is remembered (the cache is process-wide, keyed by worktree)
    let runner = Shared(stub.clone());
    assert_eq!(facts::Git { runner: &runner }.clean(w.wt.to_str().unwrap()), (Some(true), None));
    // the tree is edited: no file under .git changes, so the remembered "clean" still looks valid to the git cache
    stub.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    wire.reconcile(Cause::Startup);
    assert!(archives(&stub).is_empty(), "the re-check before the archive asked git itself and saw the dirty tree");
}

#[test]
fn a_delete_plan_never_acts_on_a_remembered_clean_answer() {
    use ah_engine::dsact::live::LiveState;
    let w = world("stale-clean-prune");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Off);
    wire.reconcile(Cause::Startup);
    // ws-1 is archived, and was archived long ago
    Connection::open(&w.db).unwrap().execute("UPDATE builders SET isActive = 0, isHidden = 1 WHERE id = 'ws-1'", []).unwrap();
    let marker = w
        .home
        .join(".anti-hall/devswarm")
        .join(ah_engine::defaults::text("mesh_write.dir_archived"))
        .join(format!("ws-1{}", ah_engine::defaults::text("mesh_write.json_suffix")));
    write(&marker, &json!({}));
    age(&marker, 40 * 86_400_000);
    let runner = Shared(stub.clone());
    let live = ah_engine::dswire::live::RtLive {
        rt: &wire.rt,
        home: w.home.clone(),
        runner: &runner,
        state_dir: w.state.clone(),
        env: RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]),
        now: now(),
    };
    let row = |live: &ah_engine::dswire::live::RtLive| live.prune_rows(7).into_iter().find(|r| r["id"] == "ws-1").expect("ws-1 is archived");
    assert_eq!(row(&live)["eligible"], json!(true), "clean, merged, old, nothing unread: the plan would delete it");
    // git's clean answer for the worktree is remembered, then the tree is edited without any file under .git changing
    assert_eq!(facts::Git { runner: &runner }.clean(w.wt.to_str().unwrap()), (Some(true), None));
    stub.dirty.store(true, std::sync::atomic::Ordering::Relaxed);
    let r = row(&live);
    assert_eq!(r["eligible"], json!(false), "the delete plan asked git itself and saw the dirty tree: {r}");
    assert_eq!(r["uncommitted"], json!(true));
}

#[test]
fn a_state_edge_leads_to_exactly_one_archive() {
    let w = world("e2e");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Engine);
    stub.git_fail.lock().unwrap().push("status".into()); // git cannot say the tree is clean yet: gate (c) is not proven
    wire.reconcile(Cause::Startup);
    assert!(archives(&stub).is_empty(), "a gate is not proven, so the start-up sweep archives nothing");
    stub.git_fail.lock().unwrap().clear();
    app_db(&w, "merged");
    let r = wire.reconcile(Cause::Event);
    assert!(!r.edges.is_empty(), "the merged PR is an edge");
    wire.events_if_due(); // an edge archives through the event path, once its debounce has passed
    assert_eq!(archives(&stub), vec![vec!["workspace".to_string(), "archive".into(), "ws-1".into()]], "exactly one archive, with an explicit id");
    wire.reconcile(Cause::Periodic);
    wire.reconcile(Cause::Overflow);
    assert_eq!(archives(&stub).len(), 1, "later runs find the ledger and Node's durable file: no second archive");
    let node_file: Value = serde_json::from_str(&std::fs::read_to_string(w.home.join(".anti-hall/devswarm/auto-archived.json")).unwrap()).unwrap();
    assert_eq!(node_file["ws-1"][0]["doneHead"], HEAD, "Node's gate (h) file records it, so a Node supervisor would refuse too");
}

#[test]
fn the_cutover_switch_makes_the_engine_stand_down() {
    let w = world("cutover");
    for exec in [Executor::Node, Executor::Off] {
        let stub = Arc::new(Stub::default());
        let wire = wire(&w, &stub, exec);
        wire.reconcile(Cause::Startup);
        app_db(&w, "merged");
        wire.reconcile(Cause::Periodic);
        assert!(archives(&stub).is_empty(), "{exec:?}: the engine does not own auto-archive");
        app_db(&w, "open");
    }
}

#[test]
fn node_having_archived_first_blocks_the_engine() {
    let w = world("node-first");
    write(&w.home.join(".anti-hall/devswarm/auto-archived.json"), &json!({"ws-1": [{"doneHead": HEAD, "at": 1}]}));
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Engine);
    wire.reconcile(Cause::Startup);
    app_db(&w, "merged");
    wire.reconcile(Cause::Periodic);
    assert!(archives(&stub).is_empty(), "Node's gate (h) record at this HEAD stops the engine");
}

#[test]
fn a_blocked_gate_archives_nothing() {
    for (tag, fail) in [("dirty", None), ("unmerged", Some("merge-base"))] {
        let w = world(&format!("blk-{tag}"));
        let stub = Arc::new(Stub::default());
        if let Some(f) = fail {
            stub.git_fail.lock().unwrap().push(f.to_string());
        } else {
            std::fs::write(w.home.join(".anti-hall/devswarm/heartbeats/ws-1.json"), json!({"ts": now() - 1_000}).to_string()).unwrap(); // active a second ago
        }
        let wire = wire(&w, &stub, Executor::Engine);
        wire.reconcile(Cause::Startup);
        app_db(&w, "merged");
        wire.reconcile(Cause::Periodic);
        assert!(archives(&stub).is_empty(), "{tag}");
    }
}

#[test]
fn a_real_file_event_drives_the_archive() {
    let w = world("event");
    // Idle must be provable from a readable mailbox, even when other action executors are off.
    let key = facts::repo_key(w.wt.to_str().unwrap()).unwrap();
    let store = ah_engine::meshw::union::store_dir(&w.home, &key);
    std::fs::create_dir_all(&store).unwrap();
    std::fs::write(store.join("BACKEND"), "sqlite\n").unwrap();
    drop(ah_engine::meshw::store::MeshStore::open(&store.join("devswarm.db")).unwrap());
    let stub = Arc::new(Stub::default());
    // Keep the startup sweep from archiving before the event, as in the direct edge test.
    stub.git_fail.lock().unwrap().push("status".into());
    let wire = Arc::new(wire(&w, &stub, Executor::Engine).with_executor(|kind| if kind == "auto_archive" { Executor::Engine } else { Executor::Off }));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst)));
    std::thread::sleep(Duration::from_millis(1500)); // the watcher is up and the start-up run is done
    stub.git_fail.lock().unwrap().clear();
    app_db(&w, "merged");
    let t0 = Instant::now();
    while archives(&stub).is_empty() && t0.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_millis(1500));
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert_eq!(
        archives(&stub).len(),
        1,
        "one archive, driven by the file event (no periodic tick ran): snapshot={:?}, calls={:?}, work={}",
        wire.rt.current(),
        stub.calls.lock().unwrap(),
        ah_engine::threads::work()
    );
}

/// ws-1's per-repo mesh store, SQLite-backed, with its write-ahead log and shared-memory index on disk and no process holding it
/// (what a Node writer leaves behind): the next reader to open it rebuilds the index, so opening it changes a file in the store.
fn mesh_store(w: &World) -> PathBuf {
    let key = facts::repo_key(w.wt.to_str().unwrap()).unwrap();
    let dir = w.home.join(".anti-hall/devswarm/store").join(key);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("BACKEND"), "sqlite\n").unwrap();
    let src = w.dir.join("store-src.db");
    let c = Connection::open(&src).unwrap();
    c.pragma_update(None, "journal_mode", "wal").unwrap();
    c.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);").unwrap();
    for sfx in ["", "-wal", "-shm"] {
        std::fs::copy(format!("{}{sfx}", src.display()), dir.join(format!("devswarm.db{sfx}"))).unwrap();
    }
    drop(c);
    dir
}

#[test]
fn a_reconcile_does_not_wake_itself_through_the_files_it_reads() {
    // the live P0 (2026-10-15): every reconcile opened the mesh store, the open touched the store's -shm, the watcher reported
    // that as a change of a state source, and the next reconcile followed 100 ms later, forever (55-60% CPU on one core)
    let w = world("selfwake");
    let store = mesh_store(&w);
    let wire = Arc::new(wire(&w, &Arc::new(Stub::default()), Executor::Off));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst)));
    std::thread::sleep(Duration::from_millis(1500)); // the watcher is up
    write(&w.home.join(".anti-hall/devswarm/heartbeats/ws-1.json"), &json!({"ts": now() - 7_100_000})); // one real change
    std::thread::sleep(Duration::from_millis(1500)); // its reconcile, and that reconcile's own echo if any, are behind us
    let before = wire.reconciles();
    std::thread::sleep(Duration::from_millis(3000)); // nothing changes on disk in this window
    let idle = wire.reconciles() - before;
    // a real commit to the store still counts: it moves the store's data_version, which the thread polls on a held connection
    Connection::open(store.join("devswarm.db")).unwrap().execute("INSERT INTO t VALUES (2)", []).unwrap();
    let t0 = Instant::now();
    while wire.reconciles() - before == idle && t0.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(50));
    }
    let woke = wire.reconciles() - before > idle;
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert!(idle <= 1, "{idle} reconciles in 3 s with nothing changing: a reconcile wakes itself");
    assert!(woke, "a real write to the mesh store must still reconcile");
}

#[test]
fn a_storm_of_real_changes_costs_at_most_one_reconcile_per_gap() {
    let w = world("storm");
    let wire = Arc::new(wire(&w, &Arc::new(Stub::default()), Executor::Off));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst)));
    std::thread::sleep(Duration::from_millis(1500));
    let gap = ah_engine::defaults::num("devswarm_wire.reconcile_min_gap_ms");
    let before = wire.reconciles();
    let t0 = Instant::now();
    for i in 0..60 {
        // sixty different heartbeat files, one every 25 ms: each is its own batch once the debounce passes
        write(&w.home.join(format!(".anti-hall/devswarm/heartbeats/storm-{i}.json")), &json!({"ts": now()}));
        std::thread::sleep(Duration::from_millis(25));
    }
    std::thread::sleep(Duration::from_millis(gap + 1000)); // the last change's reconcile has run
    let ran = wire.reconciles() - before;
    let window = t0.elapsed().as_millis() as u64;
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert!(ran >= 1, "the changes were reconciled");
    assert!(ran <= window / gap + 1, "{ran} reconciles in {window} ms with a {gap} ms gap");
}

#[test]
fn an_edge_inside_the_sweep_gap_is_not_lost() {
    let w = world("gap");
    let stub = Arc::new(Stub::default());
    // the event path owns a plain edge's archive; with it off the edge's sweep is the one the gap holds back
    let wire = wire_with(&w, &stub, Executor::Engine, &[("ANTIHALL_DEVSWARM_AUTO_ARCHIVE_EVENT_TRIGGER", "false")]).with_act_gap(400);
    stub.git_fail.lock().unwrap().push("status".into());
    wire.reconcile(Cause::Startup);
    stub.git_fail.lock().unwrap().clear();
    app_db(&w, "merged");
    wire.reconcile(Cause::Event);
    assert!(archives(&stub).is_empty(), "the gap is still open: the sweep waits");
    wire.act_if_pending();
    assert!(archives(&stub).is_empty(), "and is not run early");
    std::thread::sleep(Duration::from_millis(500));
    wire.act_if_pending();
    assert_eq!(archives(&stub).len(), 1, "the edge's sweep ran once the gap passed");
    wire.act_if_pending();
    assert_eq!(archives(&stub).len(), 1);
}

// ---- poke / escalate -------------------------------------------------------------------------------------------------------

#[test]
fn a_stale_workspace_is_poked_then_escalated_and_a_foreign_executor_leaves_it() {
    let w = world("poke");
    let root = w.home.join(".anti-hall/devswarm");
    write(
        &root.join("workspaces/ws-1.json"),
        &json!({"id": "ws-1", "worktreePath": w.wt, "sessionId": "s1", "nudgeCommand": ["poker", "--wake", "ws-1"], "escalateCommand": ["escalator", "ws-1"]}),
    );
    app_db(&w, "open"); // PR open and passing: the heartbeat (two hours old) makes it stuck
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into()); // keep auto-archive out of this scenario
    let wire_poke_only = wire(&w, &stub, Executor::Node);
    wire_poke_only.reconcile(Cause::Startup);
    wire_poke_only.act_sweeps(true);
    assert!(stub.calls.lock().unwrap().is_empty(), "executor node: no poke");
    let wire = wire(&w, &stub, Executor::Engine);
    wire.reconcile(Cause::Startup);
    // the engine's own Node call (the parent notice after an escalation) is not one of the descriptor's commands
    let last = || stub.calls.lock().unwrap().iter().rfind(|c| c.first().map(String::as_str) != Some("node")).cloned().unwrap();
    assert_eq!(last(), vec!["poker".to_string(), "--wake".into(), "ws-1".into()], "first the poke, as the descriptor says");
    assert_eq!(ah_engine::dswire::nudges::get(&w.state, "ws-1").attempts, 1);
    let n = stub.calls.lock().unwrap().len();
    wire.act_sweeps(true);
    assert_eq!(stub.calls.lock().unwrap().len(), n, "inside the cooldown the engine neither pokes again nor escalates");
    // the cooldown passes: the second poke; then the pokes are used up and it escalates once
    ah_engine::dswire::nudges::record(&w.state, "ws-1", Some(1), now() - 10_000_000);
    wire.act_sweeps(true);
    assert_eq!(last(), vec!["poker".to_string(), "--wake".into(), "ws-1".into()]);
    ah_engine::dswire::nudges::record(&w.state, "ws-1", Some(2), now() - 10_000_000);
    wire.act_sweeps(true);
    assert_eq!(last(), vec!["escalator".to_string(), "ws-1".into()]);
    let n = stub.calls.lock().unwrap().len();
    wire.act_sweeps(true);
    assert_eq!(stub.calls.lock().unwrap().len(), n, "escalated is terminal");
    assert!(ah_engine::dswire::nudges::get(&w.state, "ws-1").escalated);
    // the parent notice of the escalation is the engine's own now (v1.0 lane L08a): Node is not asked, the action ledger has it once
    let node_asked = stub.calls.lock().unwrap().iter().filter(|c| c.first().map(String::as_str) == Some("node")).count();
    assert_eq!(node_asked, 0, "Node is not asked for the notice: {:?}", stub.calls.lock().unwrap());
    let ledger = std::fs::read_to_string(w.home.join(".anti-hall/logs/devswarm-sup-actions.ndjson")).unwrap_or_default();
    assert_eq!(ledger.matches("\"dssup-escalation-notice\"").count(), 1, "the notice is in the action ledger once: {ledger}");
    let verdict: Value = serde_json::from_str(&std::fs::read_to_string(root.join("liveness/ws-1.json")).unwrap()).unwrap();
    assert_eq!(verdict["status"], "escalated", "Node's verdict file says so too");
    assert_eq!(verdict["nudgeAttempts"], 2);
}

#[test]
fn the_engine_does_not_poke_or_escalate_while_the_node_supervisor_still_logs() {
    let w = world("poke-guard");
    let root = w.home.join(".anti-hall/devswarm");
    write(
        &root.join("workspaces/ws-1.json"),
        &json!({"id": "ws-1", "worktreePath": w.wt, "sessionId": "s1", "nudgeCommand": ["poker", "--wake", "ws-1"], "escalateCommand": ["escalator", "ws-1"]}),
    );
    app_db(&w, "open");
    let log = w.home.join(".anti-hall/devswarm-supervisor.log");
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, "{}\n").unwrap();
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    let wire = wire(&w, &stub, Executor::Engine);
    wire.reconcile(Cause::Startup);
    wire.act_sweeps(true);
    assert!(stub.calls.lock().unwrap().is_empty(), "the Node supervisor's log is fresh: it may poke, so the engine stands down");
    assert_eq!(ah_engine::dswire::nudges::get(&w.state, "ws-1").attempts, 0);
    // switched off: the log goes quiet for longer than the guard
    let f = std::fs::OpenOptions::new().write(true).open(&log).unwrap();
    f.set_modified(std::time::SystemTime::now() - Duration::from_secs(3600)).unwrap();
    wire.act_sweeps(true);
    assert_eq!(stub.calls.lock().unwrap().first().cloned(), Some(vec!["poker".to_string(), "--wake".into(), "ws-1".into()]), "now the engine pokes");
}

// ---- consumers -------------------------------------------------------------------------------------------------------------

struct NoProbe;
impl Probe for NoProbe {
    fn heartbeat_ms(&self, _id: &str) -> Option<i64> {
        Some(now())
    }
    fn plan_step(&self, _wt: &str) -> Option<String> {
        None
    }
    fn unread(&self, _id: &str) -> Option<usize> {
        Some(0)
    }
}

fn step(rt: &Rt, w: &World, cause: Cause) -> usize {
    let app = sources::read_app(&w.db).unwrap();
    rt.run(cause, &Inputs { app: Some(&app), probe: &NoProbe, gh: None, now: now() }, None).edges.len()
}

#[test]
fn the_advisory_reaches_each_session_once() {
    let w = world("adv");
    let rt = rt(&w);
    step(&rt, &w, Cause::Startup);
    let (a, b) = ("sess-a", "sess-b");
    assert!(consume::advisory(&rt, &w.state, a, now()).is_none(), "a session's first look starts from now");
    assert!(consume::advisory(&rt, &w.state, b, now()).is_none());
    app_db(&w, "merged");
    assert!(step(&rt, &w, Cause::Event) > 0);
    let ta = consume::advisory(&rt, &w.state, a, now()).expect("session a is told");
    assert!(ta.contains("Child one") && ta.contains("DevSwarm"), "{ta}");
    assert!(consume::advisory(&rt, &w.state, a, now()).is_none(), "and told once");
    assert_eq!(consume::advisory(&rt, &w.state, b, now()), Some(ta), "session b has its own marker and sees the same change");
    assert!(consume::advisory(&rt, &w.state, b, now()).is_none());
    assert!(consume::advisory(&rt, &w.state, "../etc", now()).is_none(), "an unsafe session id gets nothing");
}

#[test]
fn the_advisory_is_capped() {
    let w = world("cap");
    let rt = rt(&w);
    step(&rt, &w, Cause::Startup);
    consume::advisory(&rt, &w.state, "s", now());
    // one workspace per change kind is enough to exceed the edge cap: add many active workspaces, then archive them all
    let c = Connection::open(&w.db).unwrap();
    for i in 0..30 {
        c.execute(
            "INSERT INTO builders VALUES (?1,'r1','b',?2,?3,0,NULL,'standard',1,NULL)",
            params![format!("x{i}"), format!("/nowhere/{i}"), format!("A very long workspace label number {i}")],
        )
        .unwrap();
    }
    drop(c);
    step(&rt, &w, Cause::Event);
    let t = consume::advisory(&rt, &w.state, "s", now()).expect("new workspaces are lifecycle changes");
    assert!(t.chars().count() <= 600, "{} chars", t.chars().count());
    assert!(t.contains("more"), "the rest is a count: {t}");
}

#[test]
fn the_statusline_segment_counts_the_state() {
    let w = world("line");
    let rt = rt(&w);
    assert_eq!(consume::line(&rt), "ws state unknown", "before any read the state is unknown, not empty");
    step(&rt, &w, Cause::Startup);
    assert_eq!(consume::line(&rt), "ws 2 active, 0 stuck, 0 unread");
}

#[test]
fn state_edges_queue_a_per_child_jev_sweep() {
    let w = world("jev");
    let rt = rt(&w);
    step(&rt, &w, Cause::Startup);
    app_db(&w, "merged");
    let app = sources::read_app(&w.db).unwrap();
    let edges = rt.run(Cause::Event, &Inputs { app: Some(&app), probe: &NoProbe, gh: None, now: now() }, None).edges;
    let q = consume::JevQueue::load(&w.state);
    assert_eq!(consume::mark_dirty(&rt, &q, &edges), 1, "ws-1 is queued once however many edges it had");
    assert_eq!(consume::mark_dirty(&rt, &q, &edges), 0, "and not again while queued");
    let taken = consume::take_dirty(&rt, &q);
    assert!(taken.contains(&"ws-1".to_string()) && taken.contains(&w.wt.to_string_lossy().into_owned()), "id and worktree: {taken:?}");
    assert!(consume::take_dirty(&rt, &q).is_empty(), "taking empties the queue");
    // a sweep restricted to a child nobody has a plan for looks at nothing
    let env = ah_engine::jev::settings::Env::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]);
    let r = ah_engine::jev::sweep::sweep_only(&w.home, &env, now(), Some(&["ws-1".to_string()]));
    assert_eq!(r["children"], 0);
}

#[test]
fn a_restricted_jev_sweep_parses_only_the_plan_files_that_can_match() {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("sweep-only");
    let home = t.0.join("home");
    let plans = home.join(".anti-hall/devswarm/plans");
    for i in 0..20 {
        write(
            &plans.join(format!("primary-{i:04}.json")),
            &json!({"id": format!("primary-{i:04}"), "worktreePath": format!("/wt/other-{i}"), "steps": [{"title": "s"}]}),
        );
    }
    // a plan named by neither id nor file stem is still found by its worktree (the queue carries both)
    write(&plans.join("primary-zzzz.json"), &json!({"id": "primary-zzzz", "worktreePath": "/wt/mine", "steps": [{"title": "s"}]}));
    let env = ah_engine::jev::settings::Env::from_pairs([
        ("HOME", home.to_string_lossy().into_owned()),
        ("ANTIHALL_JEV", "1".to_string()),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", "on".to_string()),
    ]);
    let parsed = || ah_engine::threads::work()["jev_sweep_plans_parsed"].as_u64().unwrap_or(0);
    let before = parsed();
    ah_engine::jev::sweep::sweep_only(&home, &env, now(), Some(&["/wt/mine".to_string()]));
    assert_eq!(parsed() - before, 1, "21 plan files, one can match: one is parsed");
    let before = parsed();
    ah_engine::jev::sweep::sweep_only(&home, &env, now(), Some(&["primary-0003".to_string()]));
    assert_eq!(parsed() - before, 1, "a plan named by its file stem is parsed alone");
}

#[test]
fn a_restricted_jev_sweep_still_matches_a_plan_whose_worktree_is_written_escaped() {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("sweep-escaped");
    let home = t.0.join("home");
    let plans = home.join(".anti-hall/devswarm/plans");
    std::fs::create_dir_all(&plans).unwrap();
    // the same worktree the way a JSON writer may escape it: `\/` for `/`, `\u00e9` for a non-ASCII char
    let escaped = [
        ("primary-esc1.json", r#"{"id":"primary-esc1","worktreePath":"\/tmp\/ws-x","steps":[{"title":"s"}]}"#, "/tmp/ws-x"),
        ("primary-esc2.json", r#"{"id":"primary-esc2","worktreePath":"/tmp/caf\u00e9","steps":[{"title":"s"}]}"#, "/tmp/caf\u{e9}"),
    ];
    let env = ah_engine::jev::settings::Env::from_pairs([
        ("HOME", home.to_string_lossy().into_owned()),
        ("ANTIHALL_JEV", "1".to_string()),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_WAIT_KIND", "on".to_string()),
    ]);
    let parsed = || ah_engine::threads::work()["jev_sweep_plans_parsed"].as_u64().unwrap_or(0);
    // each file is added in turn; the sweep must parse every escaped file written so far (none is skipped by the text prefilter)
    for (n, (file, text, wt)) in escaped.iter().enumerate() {
        std::fs::write(plans.join(file), text).unwrap();
        let before = parsed();
        ah_engine::jev::sweep::sweep_only(&home, &env, now(), Some(&[wt.to_string()]));
        assert_eq!(parsed() - before, n as u64 + 1, "the escaped plan for {wt} is parsed, not skipped");
    }
}

// ---- watcher plan ----------------------------------------------------------------------------------------------------------

#[test]
fn watched_directories_cover_every_source_and_batches_are_classified() {
    let w = world("watch");
    let wire = wire(&w, &Arc::new(Stub::default()), Executor::Engine);
    wire.reconcile(Cause::Startup);
    std::fs::write(w.wt.join(".git-link-test"), "").ok();
    let cfg = ah_engine::watch::Config::load();
    let want = watching::wanted(&wire, &cfg);
    let dirs: Vec<&PathBuf> = want.iter().map(|(d, _, _)| d).collect();
    assert!(!dirs.contains(&&w.dir), "the app database is polled by data_version, its directory is not watched");
    let versions = watching::version_sources(&wire);
    assert!(versions.contains(&w.db), "the app database is a data_version source: {versions:?}");
    for sub in ["heartbeats", "plans", "workspaces", "summaries"] {
        assert!(dirs.contains(&&w.home.join(".anti-hall/devswarm").join(sub)), "{sub}");
    }
    assert!(want.iter().any(|(d, _, r)| *d == w.wt.join(".git") && matches!(r, watching::Role::Git(id) if id == "ws-1")), "the worktree's git directory");
    assert!(want.iter().any(|(_, _, r)| matches!(r, watching::Role::Transcript(id) if id == "ws-1")), "its transcript directory");
    let have: HashMap<PathBuf, watching::Role> = want.into_iter().map(|(d, _, r)| (d, r)).collect();
    let p = watching::plan(&have, false, &[w.home.join(".anti-hall/devswarm/heartbeats/ws-1.json")]);
    assert_eq!(p.reconcile, Some(Cause::Event));
    let p = watching::plan(&have, false, &[w.wt.join(".git/HEAD")]);
    assert_eq!((p.reconcile, p.dirty), (None, vec!["ws-1".to_string()]), "a commit dirties the child, it does not reconcile");
    assert_eq!(watching::plan(&have, true, &[]).reconcile, Some(Cause::Overflow), "an overflow is a full reconcile");
    assert_eq!(watching::plan(&have, false, &[PathBuf::from("/elsewhere/x")]), watching::Plan::default());
}

#[test]
fn an_ingest_daemon_heartbeat_is_not_a_reconcile_hint() {
    let w = world("ingest-beat");
    let wire = wire(&w, &Arc::new(Stub::default()), Executor::Engine);
    wire.reconcile(Cause::Startup);
    let want = watching::wanted(&wire, &ah_engine::watch::Config::load());
    let beats = w.home.join(".anti-hall/devswarm/heartbeats");
    let (_, filter, _) = want.iter().find(|(d, _, _)| *d == beats).expect("the heartbeats directory is watched");
    assert!(filter.matches(std::ffi::OsStr::new("ws-1.json")), "a workspace heartbeat is a hint");
    assert!(!filter.matches(std::ffi::OsStr::new("ingest-some-project-123.json")), "an ingest daemon heartbeat is not");
}

#[test]
fn a_writers_staged_temp_name_is_not_a_reconcile_hint() {
    let w = world("tmp-name");
    let wire = wire(&w, &Arc::new(Stub::default()), Executor::Engine);
    wire.reconcile(Cause::Startup);
    let want = watching::wanted(&wire, &ah_engine::watch::Config::load());
    for sub in ["heartbeats", "plans", "workspaces", "summaries", "archived"] {
        let dir = w.home.join(".anti-hall/devswarm").join(sub);
        let Some((_, filter, _)) = want.iter().find(|(d, _, _)| *d == dir) else { continue };
        for staged in [".fb-ws-1.json.tmp.4242", "ws-1.json.tmp.17", "ws-1.tmp"] {
            assert!(!filter.matches(std::ffi::OsStr::new(staged)), "{sub}/{staged} is a staged file, not the event");
        }
        assert!(filter.matches(std::ffi::OsStr::new("ws-1.json")), "{sub}: the renamed real file is");
    }
}

#[test]
fn only_the_beat_of_a_working_workspace_is_not_a_hint() {
    let w = world("quiet-beat");
    let wire = wire(&w, &Arc::new(Stub::default()), Executor::Off);
    wire.reconcile(Cause::Startup);
    assert!(!wire.beat_is_quiet("ws-1"), "ws-1 starts stuck (a two-hour-old beat): its next beat IS the real change");
    assert!(!wire.beat_is_quiet("never-seen"), "a workspace the state has never seen is not quiet");
    let want = watching::wanted(&wire, &ah_engine::watch::Config::load());
    let have: HashMap<PathBuf, watching::Role> = want.into_iter().map(|(d, _, r)| (d, r)).collect();
    let beat = w.home.join(".anti-hall/devswarm/heartbeats/ws-1.json");
    let quiet = |id: &str| wire.beat_is_quiet(id);
    assert_eq!(watching::plan_with(&have, false, std::slice::from_ref(&beat), &quiet).reconcile, Some(Cause::Event), "stuck: a hint");
    // the workspace beats and the state follows it: working
    write(&beat, &json!({"ts": now() - 1_000}));
    wire.reconcile(Cause::Event);
    assert!(wire.beat_is_quiet("ws-1"), "a working workspace's next beat cannot change the state");
    let p = watching::plan_with(&have, false, std::slice::from_ref(&beat), &quiet);
    assert_eq!((p.reconcile, p.quiet_beats), (None, 1), "so it is counted, not a hint");
    // a batch with a quiet beat AND a real change still reconciles for the real change
    let plan = w.home.join(".anti-hall/devswarm/plans/ws-1.json");
    let p = watching::plan_with(&have, false, &[beat.clone(), plan], &quiet);
    assert_eq!(p.reconcile, Some(Cause::Event), "a plan change in the same batch is a hint");
    // a beat file that is not a workspace's `<id>.json` is not quiet either
    let odd = w.home.join(".anti-hall/devswarm/heartbeats/ws-1.txt");
    assert_eq!(watching::plan_with(&have, false, &[odd], &quiet).reconcile, Some(Cause::Event));
    // the unchanged plan() keeps its meaning: every beat is a hint
    assert_eq!(watching::plan(&have, false, &[beat]).reconcile, Some(Cause::Event));
}

#[test]
fn a_working_workspaces_heartbeats_cost_no_reconciles_but_its_going_quiet_is_still_seen() {
    let w = world("quiet-e2e");
    let beat = w.home.join(".anti-hall/devswarm/heartbeats/ws-1.json");
    write(&beat, &json!({"ts": now() - 1_000}));
    let wire = Arc::new(wire(&w, &Arc::new(Stub::default()), Executor::Off));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst)));
    std::thread::sleep(Duration::from_millis(1500)); // the watcher is up and the start-up run is done
    assert!(wire.beat_is_quiet("ws-1"), "working after the start-up reconcile");
    std::thread::sleep(Duration::from_millis(1500));
    let before = wire.reconciles();
    for _ in 0..20 {
        write(&beat, &json!({"ts": now()})); // the heartbeat of a working workspace, as a temp file renamed over it
        std::fs::write(beat.with_file_name(".fb-ws-1.json.tmp.99"), "{}").unwrap();
        std::fs::rename(beat.with_file_name(".fb-ws-1.json.tmp.99"), beat.with_file_name("ws-1.json")).unwrap();
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_millis(ah_engine::defaults::num("devswarm_wire.reconcile_min_gap_ms") + 1000));
    let ran = wire.reconciles() - before;
    // a real change in the same directory still reconciles: another workspace's first beat
    write(&w.home.join(".anti-hall/devswarm/heartbeats/ws-9.json"), &json!({"ts": now()}));
    let t0 = Instant::now();
    while wire.reconciles() - before == ran && t0.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(50));
    }
    let real = wire.reconciles() - before > ran;
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert_eq!(ran, 0, "twenty beats of a working workspace caused {ran} reconciles");
    assert!(real, "a beat of a workspace the state does not know is still a hint");
}

/// Measurement, not a gate: CPU of one periodic reconcile split into the read/derive part and the action sweeps, at live weight.
#[test]
#[ignore = "measurement: cargo test --release --test it -- --ignored --nocapture where_a_periodic_reconcile_spends_its_cpu"]
fn where_a_periodic_reconcile_spends_its_cpu() {
    let w = world("prof");
    // SAFETY: an ignored measurement run by hand, single-threaded at this point; nothing else reads the environment concurrently.
    unsafe { std::env::set_var("AH_ENGINE_DIR", &w.state) };
    let root = w.home.join(".anti-hall/devswarm");
    let c = Connection::open(&w.db).unwrap();
    for i in 2..=10usize {
        let wt = w.dir.join(format!("wt-{i}"));
        std::fs::create_dir_all(&wt).unwrap();
        sh(&wt, &["init", "-q"]);
        sh(&wt, &["commit", "-q", "--allow-empty", "-m", "x"]);
        c.execute(&format!("INSERT INTO builders VALUES ('ws-{i}','r1','b{i}',?1,'Child {i}',0,NULL,'standard',1,NULL)"), params![wt.to_str().unwrap()])
            .unwrap();
        write(&root.join(format!("workspaces/ws-{i}.json")), &json!({"id": format!("ws-{i}"), "worktreePath": wt, "sessionId": format!("s{i}")}));
        write(&root.join(format!("heartbeats/ws-{i}.json")), &json!({"ts": now()}));
    }
    for i in 0..700 {
        write(&root.join(format!("heartbeats/old-{i}.json")), &json!({"ts": now() - 86_400_000}));
    }
    drop(c);
    let wire = wire(&w, &Arc::new(Stub::default()), Executor::Engine);
    wire.reconcile(Cause::Startup);
    let cpu = |f: &dyn Fn()| {
        let t = ah_engine::limits::thread_cpu_us();
        f();
        (ah_engine::limits::thread_cpu_us() - t) as f64 / 1000.0
    };
    for round in 0..3 {
        let ev = cpu(&|| drop(wire.rt.run_live(Cause::Event, None, None)));
        let per = cpu(&|| drop(wire.rt.run_live(Cause::Periodic, None, None)));
        let sw = cpu(&|| drop(wire.act_sweeps(true)));
        let sw_soft = cpu(&|| drop(wire.act_sweeps(false)));
        eprintln!(
            "PROFILE round {round}: run_live(Event)={ev:.1} ms run_live(Periodic)={per:.1} ms act_sweeps(true)={sw:.1} ms act_sweeps(false)={sw_soft:.1} ms"
        );
    }
    // the whole periodic path as the scheduler runs it (reconcile + the sweeps that follow), with where its reads went
    let before = ah_engine::threads::work();
    for round in 0..3 {
        let ms = cpu(&|| drop(wire.reconcile(Cause::Periodic)));
        eprintln!("PROFILE periodic reconcile {round}: {ms:.1} ms");
    }
    print_work_since("PROFILE periodic", &before);
}

/// Print the labelled work counters (`probe_*`, `dswire_*`) that moved since `before`.
fn print_work_since(tag: &str, before: &serde_json::Value) {
    let now = ah_engine::threads::work();
    for (k, v) in now.as_object().unwrap() {
        let d = v.as_u64().unwrap_or(0) - before[k].as_u64().unwrap_or(0);
        if d > 0
            && (k.starts_with("probe_")
                || k.starts_with("dswire_reconcile")
                || k.starts_with("dswire_jev")
                || k.starts_with("dswire_batches")
                || k == "git_runs"
                || k == "git_cache_hits")
        {
            eprintln!("{tag} {k} +{d}");
        }
    }
}

#[test]
fn a_quiet_periodic_reconcile_reads_through_the_cache_only_and_counts_its_cpu_by_cause() {
    let w = world("periodic-reads");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Engine)
        .with_executor(|kind| if kind == "auto_archive" { Executor::Engine } else { Executor::Off })
        .with_full_sweep_every(3_600_000);
    wire.reconcile(Cause::Startup);
    wire.reconcile(Cause::Periodic); // the first run after the seed still sees the world's first edges
    let before = ah_engine::threads::work();
    wire.reconcile(Cause::Periodic);
    wire.reconcile(Cause::Periodic);
    let now = ah_engine::threads::work();
    let moved = |k: &str| now[k].as_u64().unwrap_or(0) - before[k].as_u64().unwrap_or(0);
    assert_eq!(moved("dswire_reconcile_runs.periodic.noop"), 2, "both quiet runs found nothing: {now}");
    assert!(moved("dswire_reconcile_cpu_us.periodic.derive") > 0, "the derive phase carries its CPU: {now}");
    let others: Vec<(&String, u64)> = now
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| k.starts_with("probe_reads.") && k.ends_with(".periodic") && !k.starts_with("probe_reads.reconcile."))
        .map(|(k, v)| (k, v.as_u64().unwrap_or(0) - before[k].as_u64().unwrap_or(0)))
        .collect();
    assert!(others.iter().all(|(_, d)| *d == 0), "a quiet periodic run reads nothing outside the reconcile's cached probe: {others:?}");
}

#[test]
fn many_git_batches_inside_one_flush_interval_start_at_most_one_jev_sweep() {
    let w = world("jev-burst");
    let (sweeper, seen) = recording_sweeper();
    let wire = Arc::new(wire(&w, &Arc::new(Stub::default()), Executor::Off).with_jev_sweeper(sweeper));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst)));
    std::thread::sleep(Duration::from_millis(1500)); // the loop is up and watching the worktree's git directory
    let threads = || ah_engine::threads::work()["dswire_jev_threads"].as_u64().unwrap_or(0);
    let (t0, n0) = (threads(), seen.lock().unwrap().len());
    for i in 0..15 {
        touch(w.wt.join(".git/HEAD"), &format!("ref: refs/heads/b{i}"));
        std::thread::sleep(Duration::from_millis(60));
    }
    std::thread::sleep(Duration::from_millis(300));
    let burst = threads() - t0;
    assert!(burst <= 1, "15 git batches inside one flush interval started {burst} Jev sweep threads");
    // nothing is dropped: the queued workspace is swept on the flush tick
    let t = Instant::now();
    while seen.lock().unwrap().len() == n0 && t.elapsed() < Duration::from_secs(10) {
        std::thread::sleep(Duration::from_millis(50));
    }
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    let swept: Vec<Vec<String>> = seen.lock().unwrap()[n0..].to_vec();
    assert!(swept.iter().any(|ids| ids.iter().any(|i| i == "ws-1")), "ws-1 is swept at the next flush tick: {swept:?}");
}

#[test]
fn a_jev_sweep_thread_reports_its_cpu_under_its_name() {
    let w = world("jev-thread");
    let stub = Arc::new(Stub::default());
    let (sweeper, seen) = recording_sweeper();
    let wire = wire(&w, &stub, Executor::Off).with_jev_sweeper(sweeper);
    let before = ah_engine::threads::exited().get("ah-dswire-jev").map_or(0, |e| e.0);
    wire.jev.queue(&["ws-1".to_string()]);
    wire.run_jev();
    let t = Instant::now();
    while seen.lock().unwrap().is_empty() && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    while ah_engine::threads::exited().get("ah-dswire-jev").map_or(0, |e| e.0) == before && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(seen.lock().unwrap().len(), 1, "the sweep ran once");
    assert_eq!(ah_engine::threads::exited().get("ah-dswire-jev").map_or(0, |e| e.0), before + 1, "the sweep's thread is counted when it ends");
}

#[test]
fn a_periodic_reconcile_sweeps_in_full_only_when_something_changed_or_the_interval_passed() {
    let w = world("periodic-full");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Engine)
        .with_executor(|kind| if kind == "auto_archive" { Executor::Engine } else { Executor::Off })
        .with_full_sweep_every(3_600_000);
    wire.reconcile(Cause::Startup);
    assert!(wire.full_sweeps() >= 1, "the start-up reconcile sweeps in full");
    wire.reconcile(Cause::Periodic); // the first run after the seed still sees the world's first edges
    let base = wire.full_sweeps();
    wire.reconcile(Cause::Periodic);
    assert_eq!(wire.full_sweeps(), base, "nothing changed and the interval has not passed: no full sweep");
    app_db(&w, "merged");
    wire.reconcile(Cause::Periodic);
    assert_eq!(wire.full_sweeps(), base + 1, "a change in the state is swept in full");
    wire.reconcile(Cause::Periodic);
    assert_eq!(wire.full_sweeps(), base + 1, "and the next quiet one is not");
    wire.reconcile(Cause::Overflow);
    assert_eq!(wire.full_sweeps(), base + 2, "an overflow is still a full sweep");
    let wire = wire_with(&w, &stub, Executor::Engine, &[]).with_full_sweep_every(0);
    wire.reconcile(Cause::Startup);
    let n = wire.full_sweeps();
    wire.reconcile(Cause::Periodic);
    assert_eq!(wire.full_sweeps(), n + 1, "an interval of 0 sweeps in full on every periodic run");
}

// ---- roles -----------------------------------------------------------------------------------------------------------------

fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
    let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    move |k| m.get(k).cloned()
}

#[test]
fn the_role_matrix_lets_only_the_main_session_act() {
    ah_engine::defaults::init().unwrap();
    assert_eq!(cli::role(&env_of(&[])), "main");
    assert_eq!(cli::role(&env_of(&[("ANTIHALL_CALLER", "interactive")])), "main");
    assert_eq!(cli::role(&env_of(&[("ANTIHALL_CALLER", "agent")])), "subagent");
    assert_eq!(cli::role(&env_of(&[("ANTIHALL_DEVSWARM_SOURCE_BRANCH", "main")])), "child");
    assert_eq!(cli::role(&env_of(&[("ANTIHALL_CALLER", "agent"), ("ANTIHALL_DEVSWARM_SOURCE_BRANCH", "main")])), "subagent", "the stricter role wins");
    for verb in ["archive", "plan-prune", "prune"] {
        assert!(cli::allowed("main", verb));
        for r in ["child", "subagent", "codex"] {
            assert!(!cli::allowed(r, verb), "{r} must not {verb}");
        }
    }
    for verb in ["status", "line", "advisory"] {
        for r in ["main", "child", "subagent", "codex"] {
            assert!(cli::allowed(r, verb), "{r} may read with {verb}");
        }
    }
    assert!(!cli::allowed("main", "nonsense"));
}

#[test]
fn a_subagent_calling_an_owner_action_is_refused_before_anything_is_read() {
    ah_engine::defaults::init().unwrap();
    let p = |rest: &[&str]| Parsed {
        command: "devswarm".into(),
        json: true,
        rest: rest.iter().map(|s| s.to_string()).collect(),
        raw: rest.iter().map(|s| s.to_string()).collect(),
    };
    let sub = env_of(&[("ANTIHALL_CALLER", "agent")]);
    for rest in [
        &["archive", "--id", "ws-1", "--request", "r1"][..],
        &["plan-prune", "--older-than", "7"],
        &["prune", "--confirm-ids", "a", "--plan", "n"],
        &["create", "b1"],
    ] {
        assert_eq!(cli::run_with(&p(rest), &sub), 64, "{rest:?}");
    }
    assert_eq!(cli::run_with(&p(&["bogus"]), &sub), 64);
    let not_ported = ah_engine::defaults::num("devswarm_wire.not_ported_exit") as i32;
    assert_ne!(not_ported, 75, "an unported verb is never the silent 75 of a deferral");
    // `create` is the spawn create path now (covered by tests/devswarm_dsB_parity.rs against a recording hivecontrol stub); it is not
    // called here, where the real hivecontrol would be. No owner verb is left unported.
    assert!(ah_engine::defaults::list("devswarm_wire.not_ported_verbs").is_empty(), "every owner verb runs in the engine");
    // `merge` is a devswarm.js verb the engine now runs itself (covered by tests/devswarm_dsB_parity.rs against a recording hivecontrol stub); it is not called here, where the real hivecontrol would be
}

// ---- facts -----------------------------------------------------------------------------------------------------------------

#[test]
fn the_done_fact_follows_nodes_rules() {
    let ids = vec!["ws-1".to_string()];
    let s = |w: Value| Some(json!({"workspaces": {"ws-1": w}}));
    let at = |w: Value, head: &str| facts::done_fact(s(w).as_ref(), &ids, Some(head));
    assert_eq!(at(json!({"gates": {"done": true}, "doneHead": "h1"}), "h1")["via"], "done-report");
    assert_eq!(at(json!({"gates": {"done": true}, "doneHead": "h1"}), "h2")["via"], "stale-head", "done at an old HEAD never passes");
    assert_eq!(at(json!({"gates": {"done": true}}), "h2")["via"], "done-gate");
    assert_eq!(at(json!({"archive_ready": true}), "h2")["via"], "gates");
    assert_eq!(at(json!({"gates": {}}), "h2")["done"], false);
    assert_eq!(facts::done_fact(None, &ids, None)["done"], false);
}

#[test]
fn the_merge_proof_asks_git_the_way_node_does() {
    let t = TempDir::new("merge");
    let wt = t.0.to_string_lossy().into_owned();
    let stub = Stub::default();
    let g = facts::Git { runner: &stub };
    assert_eq!(g.merge_proof(&wt, HEAD), (Some(true), "git:origin/main".to_string()));
    stub.git_fail.lock().unwrap().push("symbolic-ref".into());
    assert_eq!(g.merge_proof(&wt, HEAD).1, "default-branch-unknown", "no origin/HEAD: the default branch is never guessed");
    stub.git_fail.lock().unwrap().clear();
    stub.git_fail.lock().unwrap().push("merge-base".into());
    assert_eq!(g.merge_proof(&wt, HEAD), (Some(false), "git:not-ancestor".to_string()), "status 1 is a proven negative");
    assert_eq!(g.merge_proof("/does/not/exist", HEAD).0, None);
}

/// Counts the git calls it is asked to run; every answer is a clean, merged workspace.
#[derive(Default)]
struct GitCount(Mutex<Vec<String>>);

impl Runner for GitCount {
    fn run(&self, spec: &RunSpec) -> RunResult {
        let rest: Vec<&str> = spec.args.iter().skip(2).map(String::as_str).collect();
        self.0.lock().unwrap().push(rest.join(" "));
        let out = match rest.as_slice() {
            ["rev-parse", "HEAD"] => format!("{HEAD}\n"),
            ["status", ..] => self_dirty(spec),
            _ => String::new(),
        };
        RunResult { ok: true, status: Some(0), stdout: out, ..RunResult::default() }
    }
}

/// A worktree whose file `dirty` exists is reported dirty by the stand-in `git status`.
fn self_dirty(spec: &RunSpec) -> String {
    if Path::new(&spec.args[1]).join("dirty").exists() { " M f\n".into() } else { String::new() }
}

fn runs(c: &GitCount, what: &str) -> usize {
    c.0.lock().unwrap().iter().filter(|a| a.starts_with(what)).count()
}

fn repo_with_git_dir(name: &str) -> (TempDir, String) {
    let t = TempDir::new(name);
    let g = t.0.join(".git");
    std::fs::create_dir_all(g.join("logs")).unwrap();
    for f in ["index", "HEAD", "logs/HEAD"] {
        std::fs::write(g.join(f), "1").unwrap();
    }
    let wt = t.0.to_string_lossy().into_owned();
    (t, wt)
}

fn touch(path: PathBuf, body: &str) {
    std::fs::write(path, body).unwrap();
}

#[test]
fn git_status_is_not_rerun_until_the_index_or_head_changes() {
    ah_engine::defaults::init().unwrap();
    let (t, wt) = repo_with_git_dir("gitcache-status");
    let count = GitCount::default();
    let g = facts::Git { runner: &count };
    assert_eq!(g.clean(&wt), (Some(true), None));
    for _ in 0..5 {
        assert_eq!(g.clean(&wt), (Some(true), None));
    }
    assert_eq!(runs(&count, "status"), 1, "nothing changed: git ran once");
    // staging writes the index: the answer is read again
    touch(t.0.join(".git/index"), "22");
    g.clean(&wt);
    g.clean(&wt);
    assert_eq!(runs(&count, "status"), 2, "an index write re-runs git, once");
    // a commit moves HEAD and appends to its reflog
    touch(t.0.join(".git/logs/HEAD"), "333");
    g.clean(&wt);
    assert_eq!(runs(&count, "status"), 3);
    // an owner's own request is never answered from memory
    g.clean_now(&wt);
    g.clean_now(&wt);
    assert_eq!(runs(&count, "status"), 5);
    // a dirty answer is remembered too, and a commit (HEAD moves) makes it read again
    touch(t.0.join("dirty"), "");
    touch(t.0.join(".git/index"), "4444");
    assert_eq!(g.clean(&wt), (Some(false), Some("uncommitted-changes")));
    assert_eq!(g.clean(&wt), (Some(false), Some("uncommitted-changes")));
    assert_eq!(runs(&count, "status"), 6);
    std::fs::remove_file(t.0.join("dirty")).unwrap();
    touch(t.0.join(".git/HEAD"), "55555");
    assert_eq!(g.clean(&wt), (Some(true), None), "a commit cleaned it: git is asked again");
}

#[test]
fn head_and_merge_proof_are_remembered_until_a_ref_moves() {
    ah_engine::defaults::init().unwrap();
    let (t, wt) = repo_with_git_dir("gitcache-refs");
    let count = GitCount::default();
    let g = facts::Git { runner: &count };
    for _ in 0..4 {
        assert_eq!(g.head(&wt).as_deref(), Some(HEAD));
        g.merge_proof(&wt, HEAD);
    }
    assert_eq!(runs(&count, "rev-parse HEAD"), 1);
    assert_eq!(runs(&count, "symbolic-ref"), 1);
    assert_eq!(runs(&count, "merge-base"), 0, "git answered empty for symbolic-ref, so the proof stops there");
    touch(t.0.join(".git/logs/HEAD"), "22");
    g.head(&wt);
    assert_eq!(runs(&count, "rev-parse HEAD"), 2, "a commit moves HEAD's reflog");
    // a fetch rewrites packed-refs
    touch(t.0.join(".git/packed-refs"), "x");
    g.merge_proof(&wt, HEAD);
    assert_eq!(runs(&count, "symbolic-ref"), 2);
}

#[test]
fn an_archive_of_a_primary_or_unknown_builder_is_refused() {
    let w = world("archive");
    app_db(&w, "open");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Off);
    wire.reconcile(Cause::Startup);
    let runner = Shared(stub.clone());
    let live = ah_engine::dswire::live::RtLive {
        rt: &wire.rt,
        home: w.home.clone(),
        runner: &runner,
        state_dir: w.state.clone(),
        env: RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]),
        now: now(),
    };
    use ah_engine::dsact::exec::Act;
    let env = RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]);
    let act = Act::new(&w.home, &w.state, env, &live, &runner);
    for id in ["prim", "no-such", "primary-abc"] {
        let r = act.request("archive", &json!({"id": id, "request": format!("r-{id}")}));
        assert_eq!(r.word, ah_engine::dsact::ledger::Word::Refused, "{id}: {}", r.json());
    }
    assert!(archives(&stub).is_empty());
}

// ---- feature 5: stuck / silent-child detection on events -------------------------------------------------------------------

fn pokable(w: &World) {
    write(
        &w.home.join(".anti-hall/devswarm/workspaces/ws-1.json"),
        &json!({"id": "ws-1", "worktreePath": w.wt, "sessionId": "s1", "nudgeCommand": ["poker", "--wake", "ws-1"], "escalateCommand": ["escalator", "ws-1"]}),
    );
}

fn pokes(stub: &Stub) -> usize {
    stub.calls.lock().unwrap().iter().filter(|c| c.first().map(String::as_str) == Some("poker")).count()
}

fn stall_report(w: &World) -> Value {
    ah_engine::actlog::report(&w.state, Some("stall"), now() as u64, 0)["features"]["stall"].clone()
}

#[test]
fn silence_needs_enough_quiet_sources_and_never_more_than_exist() {
    use ah_engine::devswarm_rt::state::silence;
    let cfg = |n| Cfg { stall_ms: 1000, require_quiet: n, ..Cfg::from_defaults() };
    assert_eq!(Cfg::from_defaults().require_quiet, 3, "by default every source must be silent");
    let t = 100_000;
    assert_eq!(silence(&cfg(2), None, &[1], t), None, "no heartbeat: unknown, as before");
    assert_eq!(silence(&cfg(2), Some(t - 5000), &[], t), Some((true, t - 5000)), "only the heartbeat exists: it alone decides");
    assert_eq!(silence(&cfg(2), Some(t - 5000), &[t - 100], t), Some((false, t - 100)), "a fresh transcript resets the clock");
    assert_eq!(silence(&cfg(1), Some(t - 5000), &[t - 100], t), Some((true, t - 100)), "the heartbeat alone decides when one source is enough");
    assert_eq!(silence(&cfg(2), Some(t - 100), &[t - 5000], t), Some((false, t - 100)));
    assert_eq!(silence(&cfg(2), Some(t - 5000), &[t - 6000, t - 100], t), Some((true, t - 100)), "two of three silent when two are needed");
    assert_eq!(silence(&cfg(3), Some(t - 5000), &[t - 6000, t - 100], t).map(|s| s.0), Some(false), "all three must be silent when three are needed");
    assert_eq!(silence(&cfg(3), Some(t - 5000), &[t - 6000, t - 7000], t).map(|s| s.0), Some(true));
}

#[test]
fn a_child_writing_its_transcript_or_committing_is_not_poked_and_a_silent_one_is() {
    let w = world("stall-sources");
    pokable(&w);
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    let wire = wire(&w, &stub, Executor::Engine);
    transcript(&w, 1_000); // heartbeat two hours old, but the transcript was written a second ago
    wire.reconcile(Cause::Startup);
    assert_eq!(pokes(&stub), 0, "the transcript is fresh: not stuck, not poked");
    transcript(&w, 7_200_000);
    age_git(&w, 500); // and now a commit a moment ago instead
    wire.reconcile(Cause::Periodic);
    assert_eq!(pokes(&stub), 0, "a fresh commit also resets the silence clock");
    age_git(&w, 7_200_000);
    wire.reconcile(Cause::Periodic);
    assert_eq!(pokes(&stub), 1, "all sources silent: poked, through the descriptor's own command");
    let s = stall_report(&w);
    assert_eq!((s["ok"].clone(), s["by_action"]["poke"]["ok"].clone()), (json!(1), json!(1)));
    let log = std::fs::read_to_string(w.state.join("actions.ndjson")).unwrap();
    let rec: Value = log.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|r| r["t"] == "action").unwrap();
    assert_eq!(
        (rec["feature"].clone(), rec["action"].clone(), rec["target"].clone(), rec["outcome"].clone()),
        (json!("stall"), json!("poke"), json!("ws-1"), json!("ok"))
    );
    assert_eq!(rec["inputs"]["silent"], json!(true));
    assert_eq!(rec["inputs"]["lifecycle_active"], json!(true));
    assert_eq!(rec["inputs"]["paused"], json!(false));
    assert!(rec["latency_ms"].is_u64());
}

#[test]
fn a_paused_archived_or_ci_waiting_child_is_never_poked() {
    // waiting on CI: the PR's checks are running
    let w = world("stall-ci");
    pokable(&w);
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    Connection::open(&w.db).unwrap().execute("UPDATE pull_requests SET checkStatus = 'Running'", []).unwrap();
    wire(&w, &stub, Executor::Engine).reconcile(Cause::Startup);
    assert_eq!(pokes(&stub), 0, "waiting on CI");
    // paused: every open terminal of the child is resumable
    let w = world("stall-paused");
    pokable(&w);
    Connection::open(&w.db).unwrap().execute("INSERT INTO builder_terminals VALUES (1, 'ws-1', 'resumable', 1)", []).unwrap();
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    wire(&w, &stub, Executor::Engine).reconcile(Cause::Startup);
    assert_eq!(pokes(&stub), 0, "paused (or maybe paused): the owner has to resume it");
    // archived or closed
    let w = world("stall-archived");
    pokable(&w);
    Connection::open(&w.db).unwrap().execute("UPDATE builders SET isActive = 0, isHidden = 1 WHERE id = 'ws-1'", []).unwrap();
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    wire(&w, &stub, Executor::Engine).reconcile(Cause::Startup);
    assert_eq!(pokes(&stub), 0, "archived");
}

#[test]
fn the_live_recheck_refuses_a_poke_when_the_child_woke_up_after_the_decision() {
    let w = world("stall-recheck");
    pokable(&w);
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    let engine_on = Arc::new(AtomicBool::new(false));
    let flag = engine_on.clone();
    let sink: ah_engine::dswire::Sink = Arc::new(|_f| {});
    let env = RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]);
    let wire = Wire::new(rt(&w), &w.home, &w.state, None, sink, Box::new(Shared(stub.clone())))
        .with_executor(move |_| if flag.load(Ordering::SeqCst) { Executor::Engine } else { Executor::Node })
        .with_env(env)
        .with_act_gap(0);
    wire.reconcile(Cause::Startup); // the snapshot says stuck; the executor is not the engine yet, so nothing is poked
    assert!(wire.stuck_among(&["ws-1".to_string()]));
    transcript(&w, 100); // it wakes up between the snapshot and the sweep
    engine_on.store(true, Ordering::SeqCst);
    wire.act_sweeps(true);
    assert_eq!(pokes(&stub), 0, "the sources are read again right before acting, not taken from the snapshot");
}

#[test]
fn the_silence_clock_reaching_stall_ms_re_reads_the_state_without_an_event() {
    let w = world("stall-deadline");
    pokable(&w);
    write(&w.home.join(".anti-hall/devswarm/heartbeats/ws-1.json"), &json!({"ts": now() - 200}));
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    let sink: ah_engine::dswire::Sink = Arc::new(|_f| {});
    let rt = Rt::new(
        Cfg { stall_ms: 600, ..Cfg::from_defaults() },
        Detection { app_db: Some(w.db.clone()), descriptors: true, mode: Mode::On, home: w.home.clone() },
    );
    let env = RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]);
    let wire = Wire::new(rt, &w.home, &w.state, None, sink, Box::new(Shared(stub.clone()))).with_executor(|_| Executor::Engine).with_env(env).with_act_gap(0);
    wire.reconcile(Cause::Startup);
    assert_eq!(wire.rt.current().workspaces["ws-1"].activity.value, ah_engine::devswarm_rt::state::Activity::Working);
    wire.stall_tick();
    assert_eq!(pokes(&stub), 0, "the clock has not reached stall_ms yet");
    std::thread::sleep(Duration::from_millis(700));
    wire.stall_tick(); // no file event, no periodic tick: the deadline itself triggers the read
    assert_eq!(wire.rt.current().workspaces["ws-1"].activity.value, ah_engine::devswarm_rt::state::Activity::Stuck);
    assert_eq!(pokes(&stub), 1, "and the poke follows");
}

#[test]
fn a_transcript_event_on_a_stuck_child_clears_the_stuck_state_at_once() {
    let w = world("stall-event");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Node);
    wire.reconcile(Cause::Startup);
    assert!(wire.stuck_among(&["ws-1".to_string()]));
    transcript(&w, 50);
    wire.reconcile(Cause::Event); // what the watcher loop does for a transcript event on a stuck child
    assert!(!wire.stuck_among(&["ws-1".to_string()]));
    // and the watcher classifies a transcript path of a watched child as a dirty id, not a reconcile
    let mut have = HashMap::new();
    let dir = facts::transcript_path(&w.home, w.wt.to_str().unwrap(), "s1").parent().unwrap().to_path_buf();
    have.insert(dir.clone(), watching::Role::Transcript("ws-1".into()));
    let p = watching::plan(&have, false, &[dir.join("s1.jsonl")]);
    assert_eq!((p.reconcile, p.dirty), (None, vec!["ws-1".to_string()]));
}

#[test]
fn a_nudge_that_changed_nothing_and_an_escalation_followed_by_activity_are_logged_as_mistakes() {
    let w = world("stall-followup");
    pokable(&w);
    let stub = Arc::new(Stub::default());
    stub.git_fail.lock().unwrap().push("status".into());
    let wire = wire(&w, &stub, Executor::Engine);
    wire.reconcile(Cause::Startup);
    assert_eq!(pokes(&stub), 1);
    let wait = ah_engine::defaults::num("devswarm_rt.stall_followup_wait_ms") as i64;
    wire.stall_followups(now() + 1000);
    assert_eq!(stall_report(&w)["followups_pending"], json!(1), "not due yet");
    wire.stall_followups(now() + wait + 1000); // nothing happened in the workspace since the poke
    let s = stall_report(&w);
    assert_eq!((s["mistakes"].clone(), s["mistakes_by_kind"]["nudge_no_change"].clone(), s["followups_pending"].clone()), (json!(1), json!(1), json!(0)));
    assert_eq!(s["mistake_rate"], json!(1.0));
    // a poke followed by activity is clean
    ah_engine::actlog::followup_add(&w.state, "stall", "poke", "ws-1", 0, json!({"last_activity_ms": 0}), 0);
    transcript(&w, 10);
    wire.reconcile(Cause::Event);
    wire.stall_followups(now());
    let s = stall_report(&w);
    assert_eq!(s["mistakes"], json!(1), "activity after the poke is not a mistake");
    assert_eq!(s["followups_verified"], json!(2));
    // an escalation after which the child shows activity again was needless
    ah_engine::actlog::followup_add(&w.state, "stall", "escalate", "ws-1", 0, json!({"last_activity_ms": 0}), 0);
    wire.stall_followups(now());
    assert_eq!(stall_report(&w)["mistakes_by_kind"]["escalation_then_active"], json!(1));
}

// ---- benchmark --------------------------------------------------------------------------------------------------------------

fn cpu_s() -> f64 {
    // SAFETY: getrusage fills the zeroed struct it is given.
    let mut ru: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: as above.
    unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut ru) };
    let t = |v: libc::timeval| v.tv_sec as f64 + v.tv_usec as f64 / 1e6;
    t(ru.ru_utime) + t(ru.ru_stime)
}

#[test]
#[ignore = "benchmark: run alone (--ignored --exact); prints the DevSwarm thread's CPU under a synthetic load of five sessions"]
fn dswire_cpu_under_a_synthetic_load() {
    let w = world("bench");
    // SAFETY: the benchmark runs alone (--exact), so no other thread reads the environment; the engine state dir (the statusline
    // line file, counted below as one write per reconcile) goes to the scratch state dir, never the real home
    unsafe { std::env::set_var("AH_ENGINE_DIR", &w.state) };
    mesh_store(&w);
    let c = Connection::open(&w.db).unwrap();
    for i in 2..=5 {
        c.execute(&format!("INSERT INTO builders VALUES ('ws-{i}','r1','b{i}',?1,'Child {i}',0,NULL,'standard',1,NULL)"), params![w.wt.to_str().unwrap()])
            .unwrap();
        let root = w.home.join(".anti-hall/devswarm");
        write(&root.join(format!("workspaces/ws-{i}.json")), &json!({"id": format!("ws-{i}"), "worktreePath": w.wt, "sessionId": format!("s{i}")}));
        write(&root.join(format!("heartbeats/ws-{i}.json")), &json!({"ts": now()}));
    }
    // the rest of a long-lived machine (live 2026-10-15: 301 builders, 106 descriptors, 683 heartbeats): archived workspaces
    for i in 0..300 {
        c.execute(&format!("INSERT INTO builders VALUES ('old-{i}','r1','o{i}','/gone/{i}','Old {i}',1,NULL,'standard',0,NULL)"), []).unwrap();
        let root = w.home.join(".anti-hall/devswarm");
        if i < 100 {
            write(
                &root.join(format!("workspaces/old-{i}.json")),
                &json!({"id": format!("old-{i}"), "worktreePath": format!("/gone/{i}"), "sessionId": format!("o{i}")}),
            );
        }
        write(&root.join(format!("heartbeats/old-{i}.json")), &json!({"ts": now() - 86_400_000}));
    }
    drop(c);
    for i in 1..=5 {
        let p = facts::transcript_path(&w.home, w.wt.to_str().unwrap(), &format!("s{i}"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{}\n").unwrap();
    }
    let wire = Arc::new(wire(&w, &Arc::new(Stub::default()), Executor::Off));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::Builder::new().name("ah-dswire".into()).spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst))).unwrap();
    // the load: five sessions, each appending a transcript line every 2 s, and one heartbeat rewrite every 2 s
    let (home, wt, gen_stop) = (w.home.clone(), w.wt.clone(), Arc::new(AtomicBool::new(false)));
    let gs = gen_stop.clone();
    let load = std::thread::spawn(move || {
        let mut n = 0u64;
        while !gs.load(Ordering::SeqCst) {
            let i = n % 5 + 1;
            let p = facts::transcript_path(&home, wt.to_str().unwrap(), &format!("s{i}"));
            use std::io::Write;
            std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(format!("{{\"n\":{n}}}\n").as_bytes()).unwrap();
            if n.is_multiple_of(5) {
                write(&home.join(format!(".anti-hall/devswarm/heartbeats/ws-{i}.json")), &json!({"ts": now()}));
            }
            n += 1;
            std::thread::sleep(Duration::from_millis(400));
        }
    });
    std::thread::sleep(Duration::from_secs(3)); // warm-up
    let line = w.state.join("devswarm-line.json");
    let ino = |p: &Path| std::fs::metadata(p).ok().map(|m| (std::os::unix::fs::MetadataExt::ino(&m), m.modified().ok()));
    let work0 = ah_engine::threads::work();
    let (c0, t0) = (cpu_s(), Instant::now());
    let (mut prev, mut writes) = (ino(&line), 0u64);
    while t0.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(10));
        let cur = ino(&line);
        if cur != prev {
            writes += 1;
            prev = cur;
        }
    }
    let (cpu, wall) = (cpu_s() - c0, t0.elapsed().as_secs_f64());
    gen_stop.store(true, Ordering::SeqCst);
    load.join().unwrap();
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    print_work_since("BENCH", &work0);
    eprintln!("BENCH cpu={:.2}% of one core over {wall:.1} s, reconciles={writes} ({:.2}/s)", 100.0 * cpu / wall, writes as f64 / wall);
}

// ---- mode, gate, queue, change detection (lane A) ---------------------------------------------------------------------------

/// `devswarm_rt.mode` as a switch the test flips.
fn mode_switch(start: Mode) -> (Arc<std::sync::atomic::AtomicU8>, ah_engine::dswire::ModeSource) {
    let m = Arc::new(std::sync::atomic::AtomicU8::new(start as u8));
    let r = m.clone();
    (m, Box::new(move || Mode::from_u8(r.load(Ordering::SeqCst))))
}

#[test]
fn mode_off_starts_nothing_and_turning_it_off_stops_the_thread_and_the_jev_sweep() {
    let w = world("mode-off");
    let env: HashMap<String, String> = HashMap::new();
    assert!(ah_engine::devswarm_rt::start_with(&w.home, &env, Mode::Off).is_none(), "off at start: no layer, as if DevSwarm were absent");
    assert!(ah_engine::devswarm_rt::start_with(&w.home, &env, Mode::On).is_some());
    // on at start, then off while running
    let (sw, src) = mode_switch(Mode::On);
    let (sweeper, sweeps) = recording_sweeper();
    let wire = Arc::new(wire(&w, &Arc::new(Stub::default()), Executor::Off).with_mode_source(src).with_jev_sweeper(sweeper));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst)));
    std::thread::sleep(Duration::from_millis(1500));
    assert!(wire.reconciles() >= 1, "on: the start-up reconcile ran");
    sw.store(Mode::Off as u8, Ordering::SeqCst);
    std::thread::sleep(Duration::from_millis(ah_engine::defaults::num("devswarm_wire.wait_ms") + 1500)); // the thread notices within one wait
    let (rec, sw_n) = (wire.reconciles(), sweeps.lock().unwrap().len());
    // everything that used to wake it: a state file, a transcript, a Jev dirty mark, the scheduled reconcile
    write(&w.home.join(".anti-hall/devswarm/heartbeats/ws-1.json"), &json!({"ts": now() - 7_000_000}));
    transcript(&w, 10);
    wire.jev.queue(&["ws-1".to_string()]);
    wire.run_jev();
    wire.reconcile(Cause::Periodic);
    std::thread::sleep(Duration::from_millis(3500));
    assert_eq!(wire.reconciles(), rec, "off: no reconcile, from the thread or from the scheduler");
    assert_eq!(sweeps.lock().unwrap().len(), sw_n, "off: no Jev sweep");
    assert_eq!(wire.jev.take_ids(), vec!["ws-1".to_string()], "off: the queue is kept untouched");
    // and back on: the thread reads the state again
    sw.store(Mode::On as u8, Ordering::SeqCst);
    let t0 = Instant::now();
    while wire.reconciles() == rec && t0.elapsed() < Duration::from_secs(8) {
        std::thread::sleep(Duration::from_millis(50));
    }
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert!(wire.reconciles() > rec, "on again: reconciling resumes");
}

#[test]
fn the_jev_queue_lives_in_memory_and_is_saved_only_when_flushed() {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("jevq");
    let dir = t.0.clone();
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(ah_engine::defaults::text("devswarm_wire.jev_dirty_file"));
    let q = consume::JevQueue::load(&dir);
    assert_eq!(q.queue(&["a".into(), "b".into(), "a".into()]), 2, "a workspace queued twice stays once");
    assert_eq!(q.queue(&["a".into()]), 0);
    assert!(!file.exists(), "queueing writes nothing: the queue is in memory");
    assert!(q.unsaved());
    q.flush();
    assert_eq!(
        serde_json::from_str::<Vec<String>>(&std::fs::read_to_string(&file).unwrap()).unwrap(),
        ["a", "b"],
        "the file keeps its shape: a JSON array of ids"
    );
    let m = std::fs::metadata(&file).unwrap().modified().unwrap();
    q.flush();
    assert_eq!(std::fs::metadata(&file).unwrap().modified().unwrap(), m, "nothing changed: no rewrite");
    // a restart sees the saved queue (this is also the file an earlier version wrote)
    let q2 = consume::JevQueue::load(&dir);
    assert_eq!(q2.take_ids(), ["a", "b"]);
    assert!(q2.take_ids().is_empty());
    q2.flush();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "[]", "taking is saved too");
    std::fs::write(&file, "not json").unwrap();
    assert!(consume::JevQueue::load(&dir).take_ids().is_empty(), "a malformed file is the empty queue");
    let cap = ah_engine::defaults::num("devswarm_wire.jev_dirty_cap") as usize;
    let many: Vec<String> = (0..cap + 5).map(|i| format!("w{i}")).collect();
    q.take_ids();
    assert_eq!(q.queue(&many), cap, "past the cap the oldest are dropped");
    assert_eq!(q.take_ids().first().map(String::as_str), Some("w5"));
}

#[test]
fn a_held_connection_sees_another_processs_commit_and_not_its_own_reads() {
    use ah_engine::dswire::storewatch::VersionWatch;
    let w = world("versions");
    let store = mesh_store(&w);
    let db = store.join("devswarm.db");
    let mut v = VersionWatch::new();
    assert_eq!(v.sync(&[db.clone(), w.dir.join("absent.db")]), 1, "the missing database is not held");
    assert!(!v.changed(), "nothing committed yet");
    for _ in 0..5 {
        let c = Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)).unwrap(); // a reader's open and read
    }
    assert!(!v.changed(), "other readers do not move the counter");
    Connection::open(&db).unwrap().execute("INSERT INTO t VALUES (9)", []).unwrap();
    assert!(v.changed(), "a commit by another connection does");
    assert!(!v.changed(), "and is reported once");
    assert_eq!(v.sync(&[]), 0);
}

#[test]
fn the_transcript_gate_acts_on_growth_once_per_interval_and_never_loses_held_back_growth() {
    use ah_engine::dswire::gate::TranscriptGate;
    let t = TempDir::new("gate");
    std::fs::create_dir_all(&t.0).unwrap();
    let f = t.0.join("s1.jsonl");
    std::fs::write(&f, "{}\n").unwrap();
    let min = Duration::from_millis(400);
    let mut g = TranscriptGate::new(min);
    let t0 = Instant::now();
    assert!(g.observe("ws-1", std::slice::from_ref(&f), t0), "first sight of a file is growth");
    assert!(!g.observe("ws-1", std::slice::from_ref(&f), t0 + Duration::from_millis(10)), "an event without growth is nothing");
    std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"{}\n").unwrap();
    assert!(!g.observe("ws-1", std::slice::from_ref(&f), t0 + Duration::from_millis(100)), "growth inside the interval waits");
    assert_eq!(g.next_due(), Some(t0 + min), "and has a deadline");
    assert!(g.tick(t0 + Duration::from_millis(200)).is_empty(), "not before it");
    assert_eq!(g.tick(t0 + min), ["ws-1"], "at the deadline the held-back growth is acted on");
    assert!(g.next_due().is_none());
    // no growth since: nothing is due even if events come
    assert!(!g.observe("ws-1", std::slice::from_ref(&f), t0 + Duration::from_millis(900)));
    // a deadline with no growth left (the file was truncated back) acts on nothing
    std::fs::OpenOptions::new().append(true).open(&f).unwrap().write_all(b"{}\n").unwrap();
    assert!(!g.observe("ws-1", std::slice::from_ref(&f), t0 + Duration::from_millis(500)), "inside the interval that began at the deadline");
    std::fs::write(&f, "").unwrap();
    assert!(g.tick(t0 + Duration::from_secs(5)).is_empty());
    // a rotated file (a new inode) is growth, and a second workspace has its own interval. The old file stays open while the new one
    // is created: Linux filesystems hand a freed inode number to the next file at once, and a "new" file with the old number and a
    // size at or under the baseline is indistinguishable from a truncation (macOS does not reuse numbers, so only CI saw it)
    let old = std::fs::File::open(&f).unwrap();
    let ino = |p: &Path| std::os::unix::fs::MetadataExt::ino(&std::fs::metadata(p).unwrap());
    let before = ino(&f);
    std::fs::remove_file(&f).unwrap();
    std::fs::write(&f, "{}\n").unwrap();
    let why = format!("inode {before} -> {} (an equal pair means the filesystem reused the number)", ino(&f));
    assert!(g.observe("ws-1", std::slice::from_ref(&f), t0 + Duration::from_secs(10)), "a rotated file is growth: {why}");
    assert!(g.observe("ws-2", std::slice::from_ref(&f), t0 + Duration::from_secs(10)), "a second workspace has its own interval: {why}");
    drop(old);
}

// ---- the scale test: the budget -------------------------------------------------------------------------------------------

/// A mesh store for the worktree `wt` (see [`mesh_store`]): SQLite-backed with its WAL and index on disk and no process holding it.
fn mesh_store_of(w: &World, wt: &Path, tag: &str) -> PathBuf {
    let key = facts::repo_key(wt.to_str().unwrap()).unwrap();
    let dir = w.home.join(".anti-hall/devswarm/store").join(key);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("BACKEND"), "sqlite\n").unwrap();
    let src = w.dir.join(format!("store-src-{tag}.db"));
    let c = Connection::open(&src).unwrap();
    c.pragma_update(None, "journal_mode", "wal").unwrap();
    c.execute_batch("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);").unwrap();
    for sfx in ["", "-wal", "-shm"] {
        std::fs::copy(format!("{}{sfx}", src.display()), dir.join(format!("devswarm.db{sfx}"))).unwrap();
    }
    drop(c);
    dir
}

/// CPU seconds used so far by the threads `own` names (by thread id).
fn cpu_of(own: &std::collections::HashSet<u64>) -> f64 {
    ah_engine::threads::snapshot().iter().filter(|t| own.contains(&t.tid)).map(|t| t.cpu_us as f64 / 1e6).sum()
}

/// A realistic DevSwarm machine, driven for a while; returns (average CPU % of one core of the engine's threads, resident MB at
/// the end, reconciles per second, thread wakes per second). `n` active workspaces each have their own repository, mesh store,
/// transcript and descriptor; on top of them is the weight of a long-lived machine (300 archived builders, 100 descriptors, 300
/// heartbeats). Every session appends to its transcript once a second, every workspace rewrites its heartbeat every 5 s, and
/// every mesh store receives a commit every 10 s.
fn drive(tag: &str, n: usize, warm: Duration, window: Duration) -> (f64, f64, f64, f64, f64) {
    let w = world(tag);
    // SAFETY: nothing else in this test reads the environment while it runs alone (nextest: one process per test); the engine state
    // dir (the statusline line file, one write per reconcile) goes to the scratch state dir, never the real home
    unsafe { std::env::set_var("AH_ENGINE_DIR", &w.state) };
    let root = w.home.join(".anti-hall/devswarm");
    let c = Connection::open(&w.db).unwrap();
    let mut stores = Vec::new();
    let mut wts = vec![(1usize, w.wt.clone())];
    for i in 2..=n {
        let wt = w.dir.join(format!("wt-{i}"));
        std::fs::create_dir_all(&wt).unwrap();
        sh(&wt, &["init", "-q"]);
        sh(&wt, &["commit", "-q", "--allow-empty", "-m", "x"]);
        c.execute(&format!("INSERT INTO builders VALUES ('ws-{i}','r1','b{i}',?1,'Child {i}',0,NULL,'standard',1,NULL)"), params![wt.to_str().unwrap()])
            .unwrap();
        write(&root.join(format!("workspaces/ws-{i}.json")), &json!({"id": format!("ws-{i}"), "worktreePath": wt, "sessionId": format!("s{i}")}));
        wts.push((i, wt));
    }
    for (i, wt) in &wts {
        write(&root.join(format!("heartbeats/ws-{i}.json")), &json!({"ts": now()}));
        stores.push(mesh_store_of(&w, wt, &format!("{i}")).join("devswarm.db"));
        let p = facts::transcript_path(&w.home, wt.to_str().unwrap(), &format!("s{i}"));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, "{}\n").unwrap();
    }
    for i in 0..300 {
        c.execute(&format!("INSERT INTO builders VALUES ('old-{i}','r1','o{i}','/gone/{i}','Old {i}',1,NULL,'standard',0,NULL)"), []).unwrap();
        if i < 100 {
            write(
                &root.join(format!("workspaces/old-{i}.json")),
                &json!({"id": format!("old-{i}"), "worktreePath": format!("/gone/{i}"), "sessionId": format!("o{i}")}),
            );
        }
        write(&root.join(format!("heartbeats/old-{i}.json")), &json!({"ts": now() - 86_400_000}));
    }
    drop(c);
    let load_stop = Arc::new(AtomicBool::new(false));
    let (ls, home, wts2) = (load_stop.clone(), w.home.clone(), wts.clone());
    // the load generator's own CPU (the stand-in for sessions and companions, not the engine's), so it can be taken off the process total
    let load_cpu = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let lc = load_cpu.clone();
    let load = std::thread::spawn(move || {
        let mut tick = 0u64;
        while !ls.load(Ordering::SeqCst) {
            lc.store(ah_engine::limits::thread_cpu_us(), Ordering::Relaxed);
            for (i, wt) in &wts2 {
                if tick % 10 == (*i as u64) % 10 {
                    let p = facts::transcript_path(&home, wt.to_str().unwrap(), &format!("s{i}"));
                    std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(format!("{{\"n\":{tick}}}\n").as_bytes()).unwrap();
                }
                if tick % 50 == (*i as u64) % 50 {
                    write(&home.join(format!(".anti-hall/devswarm/heartbeats/ws-{i}.json")), &json!({"ts": now()}));
                }
                if tick.is_multiple_of(20) && *i <= 2 {
                    // the Node ingest companions beat every ~2 s into the same directory; no reconcile reads these files
                    write(&home.join(format!(".anti-hall/devswarm/heartbeats/ingest-proj{i}.json")), &json!({"ts": now()}));
                }
                if tick % 100 == (*i as u64) % 100 {
                    let key = facts::repo_key(wt.to_str().unwrap()).unwrap();
                    let db = home.join(".anti-hall/devswarm/store").join(key).join("devswarm.db");
                    Connection::open(db).unwrap().execute("INSERT INTO t VALUES (7)", []).unwrap();
                }
            }
            tick += 1;
            std::thread::sleep(Duration::from_millis(100));
        }
    });
    let rss_before = ah_engine::limits::rss_kb() as f64 / 1024.0;
    let before: std::collections::HashSet<u64> = ah_engine::threads::snapshot().iter().map(|t| t.tid).collect();
    let (sweeper, _) = recording_sweeper();
    let wire = Arc::new(wire(&w, &Arc::new(Stub::default()), Executor::Off).with_jev_sweeper(sweeper));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::Builder::new().name("ah-dswire".into()).spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst))).unwrap();
    std::thread::sleep(warm);
    let own: std::collections::HashSet<u64> = ah_engine::threads::snapshot().iter().filter(|t| !before.contains(&t.tid)).map(|t| t.tid).collect();
    assert!(!own.is_empty(), "the engine's threads were found");
    let per_thread = |own: &std::collections::HashSet<u64>| -> std::collections::BTreeMap<String, f64> {
        let mut m = std::collections::BTreeMap::new();
        for t in ah_engine::threads::snapshot().iter().filter(|t| own.contains(&t.tid)) {
            *m.entry(t.name.clone()).or_insert(0.0) += t.cpu_us as f64 / 1e6;
        }
        m
    };
    let (c0, r0, k0, t0, p0) = (cpu_of(&own), wire.reconciles(), watching::work::snapshot(), Instant::now(), per_thread(&own));
    let work0 = ah_engine::threads::work();
    let exited0 = ah_engine::threads::exited();
    let (proc0, load0) = (ah_engine::limits::process_cpu_secs(), load_cpu.load(Ordering::Relaxed));
    // the scheduler's safety-net job runs one periodic reconcile every `devswarm_rt.reconcile_ms` on a thread of its own, which exits
    // with it; the window is shorter than that interval, so the runs are spread `periodic_runs_per_window` times over the window
    let runs = b_periodic_runs();
    let mut fired = 0u32;
    while t0.elapsed() < window {
        let next = window.mul_f64((fired as f64 + 1.0) / (runs as f64 + 1.0));
        std::thread::sleep(next.saturating_sub(t0.elapsed()).min(window.saturating_sub(t0.elapsed())));
        if fired < runs && t0.elapsed() >= next {
            let wr = wire.clone();
            std::thread::Builder::new()
                .name("ah-schedule-devswarm_reconcile".into())
                .spawn(move || drop(wr.reconcile(Cause::Periodic)))
                .unwrap()
                .join()
                .unwrap();
            fired += 1;
        }
    }
    for (name, v) in per_thread(&own) {
        eprintln!("SCALE thread {name}: {:.3}% of one core", 100.0 * (v - p0.get(&name).copied().unwrap_or(0.0)) / t0.elapsed().as_secs_f64());
    }
    eprintln!("SCALE work: {:?}", watching::work::snapshot().iter().zip(k0.iter()).map(|(a, b)| (a.0, a.1 - b.1)).collect::<Vec<_>>());
    // the whole process, minus the load generator: threads that were born and ended inside the window count too
    let (proc1, load1) = (ah_engine::limits::process_cpu_secs(), load_cpu.load(Ordering::Relaxed));
    let (cpu, wall, rec) = ((proc1 - proc0) - (load1.saturating_sub(load0)) as f64 / 1e6, t0.elapsed().as_secs_f64(), wire.reconciles() - r0);
    print_work_since("SCALE", &work0);
    for (n, (c, us)) in ah_engine::threads::exited() {
        let (c0, us0) = exited0.get(&n).copied().unwrap_or((0, 0));
        eprintln!("SCALE exited {n}: {} threads, {:.1} ms CPU", c - c0, (us - us0) as f64 / 1000.0);
    }
    eprintln!("SCALE own-live-threads cpu={:.3}s, process-minus-load cpu={cpu:.3}s, periodic runs fired={fired}", cpu_of(&own) - c0);
    let wakes = watching::work::snapshot().iter().find(|(k, _)| *k == "wakes").map_or(0, |x| x.1) - k0.iter().find(|(k, _)| *k == "wakes").map_or(0, |x| x.1);
    let rss_mb = ah_engine::limits::rss_kb() as f64 / 1024.0;
    load_stop.store(true, Ordering::SeqCst);
    load.join().unwrap();
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    (100.0 * cpu / wall, rss_mb, rss_mb - rss_before, rec as f64 / wall, wakes as f64 / wall)
}

/// How many periodic reconciles the scale window carries (`devswarm_scale.periodic_runs_per_window` in tests/budgets.toml).
fn b_periodic_runs() -> u32 {
    let b: toml::Table = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/budgets.toml")).unwrap().parse().unwrap();
    b["devswarm_scale"]["periodic_runs_per_window"].as_integer().unwrap() as u32
}

#[test]
fn the_thread_stays_inside_its_budget_at_scale() {
    let b: toml::Table = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/budgets.toml")).unwrap().parse().unwrap();
    let b = &b["devswarm_scale"];
    let f = |k: &str| b[k].as_float().unwrap_or_else(|| b[k].as_integer().unwrap() as f64);
    let (cpu_budget, rss_budget) = (f("cpu_pct"), f("rss_mb"));
    let factor = if cfg!(debug_assertions) { f("debug_factor") } else { 1.0 };
    let (window, warm) = (Duration::from_secs(f("window_s") as u64), Duration::from_secs(f("warmup_s") as u64));
    let (cpu, rss, grown, rec, wakes) = drive("scale", 10, warm, window);
    eprintln!(
        "SCALE 1 primary + 10 workspaces + 10 sessions: cpu={cpu:.2}% (budget {cpu_budget}% x{factor}) rss={rss:.1} MB (+{grown:.1} since the start; budget {rss_budget}) reconciles={rec:.2}/s wakes={wakes:.2}/s"
    );
    assert!(cpu < cpu_budget * factor, "the DevSwarm threads used {cpu:.2}% of one core, over the {cpu_budget}% budget (x{factor})");
    assert!(grown < rss_budget, "the DevSwarm machinery grew the process by {grown:.1} MB, over the {rss_budget} MB budget");
    // the whole process counts when it is alone (nextest runs each test in its own process; `cargo test` shares one with every other test)
    if std::env::var_os("NEXTEST").is_some() {
        assert!(rss < rss_budget, "the process holds {rss:.1} MB, over the {rss_budget} MB budget");
    }
}

#[test]
fn the_read_cache_parses_a_settled_file_once_and_never_trusts_a_fresh_or_changed_one() {
    use ah_engine::devswarm_rt::sources::ReadCache;
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("rcache");
    std::fs::create_dir_all(&t.0).unwrap();
    let f = t.0.join("hb.json");
    std::fs::write(&f, r#"{"ts": 111}"#).unwrap();
    age(&f, 60_000); // settled: well past devswarm_rt.probe_cache_racy_ms
    let c = ReadCache::new();
    c.begin();
    let (a, b) = (c.json(&f).unwrap(), c.json(&f).unwrap());
    assert!(Arc::ptr_eq(&a, &b), "an unchanged settled file is parsed once");
    // changed in place with the same size: only its modification time differs
    std::fs::write(&f, r#"{"ts": 222}"#).unwrap();
    age(&f, 30_000);
    let d = c.json(&f).unwrap();
    assert!(!Arc::ptr_eq(&a, &d), "a changed file is read again");
    assert_eq!(format!("{:?}", d.get("ts")), format!("{:?}", ah_engine::checks::guardkit::ojson::OVal::parse(r#"{"ts": 222}"#).unwrap().get("ts")));
    // a file modified just now could be rewritten within the clock's granularity: never kept
    let g = t.0.join("fresh.json");
    std::fs::write(&g, r#"{"ts": 1}"#).unwrap();
    let (x, y) = (c.json(&g).unwrap(), c.json(&g).unwrap());
    assert!(!Arc::ptr_eq(&x, &y), "a fresh file is read every time");
    // what a reconcile did not use is dropped at its end
    c.end();
    c.begin();
    c.end();
    let e = c.json(&f).unwrap();
    assert!(!Arc::ptr_eq(&d, &e), "an entry unused by a whole reconcile is gone");
    // an unreadable file is nothing, not a stale answer
    std::fs::remove_file(&f).unwrap();
    assert!(c.json(&f).is_none());
}
