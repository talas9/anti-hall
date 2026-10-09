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
                ["status", "--porcelain"] => ok(""),
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
    w
}

/// (Re)write the app database: ws-1 active with a PR in `pr_state`, and a primary.
fn app_db(w: &World, pr_state: &str) {
    std::fs::remove_file(&w.db).ok(); // absent is the goal state
    let c = Connection::open(&w.db).unwrap();
    c.execute_batch(
        "CREATE TABLE builders (id TEXT PRIMARY KEY, repositoryId TEXT, branchName TEXT, worktreePath TEXT, label TEXT, isHidden INTEGER, pullRequestId TEXT, builderType TEXT, isActive INTEGER, lastSelectedAt TEXT);
         CREATE TABLE builder_terminals (id INTEGER PRIMARY KEY, builderId TEXT, panelStatus TEXT, isActive INTEGER);
         CREATE TABLE pull_requests (id TEXT PRIMARY KEY, number INTEGER, state TEXT, checkStatus TEXT, lastSyncedAt TEXT);",
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
    let sink: ah_engine::dswire::Sink = Arc::new(|_f| {});
    let env = RequestEnv::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]);
    Wire::new(rt(w), &w.home, &w.state, None, sink, Box::new(Shared(stub.clone()))).with_executor(move |_| exec).with_env(env).with_act_gap(0)
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
    let stub = Arc::new(Stub::default());
    let wire = Arc::new(wire(&w, &stub, Executor::Engine));
    let stop = Arc::new(AtomicBool::new(false));
    let (wr, st) = (wire.clone(), stop.clone());
    let h = std::thread::spawn(move || watching::run(&wr, &|| st.load(Ordering::SeqCst)));
    std::thread::sleep(Duration::from_millis(1500)); // the watcher is up and the start-up run is done
    app_db(&w, "merged");
    let t0 = Instant::now();
    while archives(&stub).is_empty() && t0.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(100));
    }
    std::thread::sleep(Duration::from_millis(1500));
    stop.store(true, Ordering::SeqCst);
    h.join().unwrap();
    assert_eq!(archives(&stub).len(), 1, "one archive, driven by the file event (no periodic tick ran)");
}

#[test]
fn an_edge_inside_the_sweep_gap_is_not_lost() {
    let w = world("gap");
    let stub = Arc::new(Stub::default());
    let wire = wire(&w, &stub, Executor::Engine).with_act_gap(400);
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
    let notices = stub.calls.lock().unwrap().iter().filter(|c| c.first().map(String::as_str) == Some("node")).count();
    assert_eq!(notices, 1, "the parent notice of the escalation was asked for once");
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
    assert_eq!(consume::mark_dirty(&rt, &w.state, &edges), 1, "ws-1 is queued once however many edges it had");
    assert_eq!(consume::mark_dirty(&rt, &w.state, &edges), 0, "and not again while queued");
    let taken = consume::take_dirty(&rt, &w.state);
    assert!(taken.contains(&"ws-1".to_string()) && taken.contains(&w.wt.to_string_lossy().into_owned()), "id and worktree: {taken:?}");
    assert!(consume::take_dirty(&rt, &w.state).is_empty(), "taking empties the queue");
    // a sweep restricted to a child nobody has a plan for looks at nothing
    let env = ah_engine::jev::settings::Env::from_pairs([("HOME", w.home.to_string_lossy().into_owned())]);
    let r = ah_engine::jev::sweep::sweep_only(&w.home, &env, now(), Some(&["ws-1".to_string()]));
    assert_eq!(r["children"], 0);
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
    assert!(dirs.contains(&&w.dir), "the app database directory");
    for sub in ["heartbeats", "plans", "workspaces", "summaries"] {
        assert!(dirs.contains(&&w.home.join(".anti-hall/devswarm").join(sub)), "{sub}");
    }
    assert!(want.iter().any(|(d, _, r)| *d == w.wt.join(".git") && matches!(r, watching::Role::Git(id) if id == "ws-1")), "the worktree's git directory");
    assert!(want.iter().any(|(_, _, r)| matches!(r, watching::Role::Transcript(id) if id == "ws-1")), "its transcript directory");
    let have: HashMap<PathBuf, watching::Role> = want.into_iter().map(|(d, _, r)| (d, r)).collect();
    let p = watching::plan(&have, false, &[w.dir.join("devswarm.db-wal")]);
    assert_eq!(p.reconcile, Some(Cause::Event));
    let p = watching::plan(&have, false, &[w.wt.join(".git/HEAD")]);
    assert_eq!((p.reconcile, p.dirty), (None, vec!["ws-1".to_string()]), "a commit dirties the child, it does not reconcile");
    assert_eq!(watching::plan(&have, true, &[]).reconcile, Some(Cause::Overflow), "an overflow is a full reconcile");
    assert_eq!(watching::plan(&have, false, &[PathBuf::from("/elsewhere/x")]), watching::Plan::default());
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
    let p = |rest: &[&str]| Parsed { command: "devswarm".into(), json: true, rest: rest.iter().map(|s| s.to_string()).collect() };
    let sub = env_of(&[("ANTIHALL_CALLER", "agent")]);
    for rest in [&["archive", "--id", "ws-1", "--request", "r1"][..], &["plan-prune", "--older-than", "7"], &["prune", "--confirm-ids", "a", "--plan", "n"]] {
        assert_eq!(cli::run_with(&p(rest), &sub), 64, "{rest:?}");
    }
    assert_eq!(cli::run_with(&p(&["bogus"]), &sub), 64);
    let main = env_of(&[]);
    assert_eq!(cli::run_with(&p(&["create", "--branch", "x"]), &main), 75, "create is left to Node: nothing done");
    assert_eq!(cli::run_with(&p(&["merge"]), &main), 75);
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
