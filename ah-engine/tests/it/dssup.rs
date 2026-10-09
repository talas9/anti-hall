//! The DevSwarm supervisor duties (lane l7): the witness switch, the double-run guard, the tick against Node on fixture homes
//! (each duty), the shared sweep lock, the verdict mirror of an engine poke / escalation byte for byte against Node's recovery
//! code, the log rotation against Node's, and recover's refusals. Real `node` runs only in a scratch HOME and only the duties
//! that never call `hivecontrol` (reconcile is exercised through its cool-down gate and a recording runner).
use ah_engine::checks::git::util::Settings;
use ah_engine::checks::guardkit::nodelock;
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::{RunResult, RunSpec, Runner, System};
use ah_engine::dssup::{Owner, node_running, recover, tick, verdict};
use ah_engine::dswire::{Executor, resolve_executor};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

fn now() -> i64 {
    ah_engine::health::now_ms() as i64
}

fn have_node() -> bool {
    Command::new("node").arg("--version").output().is_ok_and(|o| o.status.success())
}

/// Records every call and answers with `{"stub":true}`.
#[derive(Default)]
struct Rec {
    calls: Mutex<Vec<RunSpec>>,
}

impl Runner for Rec {
    fn run(&self, spec: &RunSpec) -> RunResult {
        self.calls.lock().unwrap().push(spec.clone());
        RunResult { ok: true, status: Some(0), stdout: "{\"stub\":true}\n".into(), ..RunResult::default() }
    }
}

impl Rec {
    fn n(&self) -> usize {
        self.calls.lock().unwrap().len()
    }
}

struct Fx {
    _t: TempDir,
    home: PathBuf,
    state: PathBuf,
    root: PathBuf,
}

fn fx(tag: &str, descriptor: bool) -> Fx {
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new(tag);
    let dir = std::fs::canonicalize(&t.0).unwrap();
    let (home, state) = (dir.join("home"), dir.join("state"));
    std::fs::create_dir_all(&state).unwrap();
    std::fs::create_dir_all(home.join(".anti-hall/devswarm/workspaces")).unwrap();
    if descriptor {
        let wt = dir.join("wt-1");
        std::fs::create_dir_all(&wt).unwrap();
        put(
            &home.join(".anti-hall/devswarm/workspaces/ws-1.json"),
            &json!({"id": "ws-1", "worktreePath": wt, "sessionId": "11111111-2222-3333-4444-555555555555"}),
        );
    }
    Fx { _t: t, home, state, root: ah_engine::defaults::root().unwrap() }
}

fn put(p: &Path, v: &Value) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, v.to_string()).unwrap();
}

fn settings(f: &Fx, extra: &[(&str, &str)]) -> Settings {
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("HOME".into(), f.home.to_string_lossy().into_owned());
    // the witness has its own tests; everywhere else it stays off so the runner sees only the duties
    env.insert("ANTIHALL_DEVSWARM_SUP_WITNESS".into(), "off".into());
    for (k, v) in extra {
        env.insert((*k).into(), (*v).into());
    }
    Settings { home: f.home.to_string_lossy().into_owned(), env }
}

fn ctx<'a>(f: &'a Fx, st: &'a Settings, engine_pokes: bool) -> tick::Ctx<'a> {
    tick::Ctx { home: &f.home, root: &f.root, st, now: now(), engine_pokes }
}

fn dev(f: &Fx) -> PathBuf {
    f.home.join(".anti-hall/devswarm")
}

fn age_log(p: &Path, ms_ago: u64) {
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, "{}\n").unwrap();
    let f = std::fs::OpenOptions::new().write(true).open(p).unwrap();
    f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_millis(ms_ago)).unwrap();
}

fn node_eval(home: &Path, code: &str) -> Value {
    let root = ah_engine::defaults::root().unwrap();
    let o = Command::new("node").args(["-e", code, root.to_str().unwrap(), home.to_str().unwrap()]).output().unwrap();
    assert!(o.status.success(), "node: {}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_str(String::from_utf8_lossy(&o.stdout).lines().last().unwrap_or("null")).unwrap_or(Value::Null)
}

// ---- the switch ------------------------------------------------------------------------------------------------------------

#[test]
fn the_switch_reads_a_typo_as_witness_and_auto_follows_it() {
    ah_engine::defaults::init().unwrap();
    for (word, owner) in [("engine", Owner::Engine), (" ENGINE ", Owner::Engine), ("witness", Owner::Witness), ("enigne", Owner::Witness), ("", Owner::Witness)]
    {
        assert_eq!(Owner::parse(word), owner, "{word:?}");
    }
    // poke and escalate: auto follows the mode; an explicit word wins; a typo makes the engine stand down
    for kind in ["poke", "escalate"] {
        assert_eq!(resolve_executor(kind, "auto", Owner::Witness), Executor::Node);
        assert_eq!(resolve_executor(kind, "auto", Owner::Engine), Executor::Engine);
        assert_eq!(resolve_executor(kind, "node", Owner::Engine), Executor::Node);
        assert_eq!(resolve_executor(kind, "engine", Owner::Witness), Executor::Engine);
        assert_eq!(resolve_executor(kind, "off", Owner::Engine), Executor::Off);
        assert_eq!(resolve_executor(kind, "autoo", Owner::Engine), Executor::Node);
    }
    // auto-archive has no auto word: it stays the engine by its own default and `auto` there is a typo
    assert_eq!(resolve_executor("auto_archive", "auto", Owner::Engine), Executor::Node);
    assert_eq!(resolve_executor("auto_archive", "engine", Owner::Witness), Executor::Engine);
}

#[test]
fn engine_pokes_unless_both_executors_are_node() {
    use ah_engine::dssup::cli::engine_pokes;
    let both = |p: Executor, e: Executor| engine_pokes(&move |k| if k == "poke" { p } else { e });
    assert!(!both(Executor::Node, Executor::Node), "Node's own poke step runs only when Node owns both");
    assert!(both(Executor::Engine, Executor::Engine));
    assert!(both(Executor::Engine, Executor::Node), "a mixed setting never lets Node's sweep poke as well");
    assert!(both(Executor::Off, Executor::Off), "off means nowhere");
}

#[test]
fn a_witness_tick_runs_nothing_and_writes_nothing() {
    let f = fx("witness", true);
    let (st, rec) = (settings(&f, &[]), Rec::default());
    let before = walk(&f.home);
    let out = tick::run(&ctx(&f, &st, true), Owner::Witness, &rec);
    assert_eq!(out["reason"], "witness");
    assert_eq!(rec.n(), 0);
    assert_eq!(walk(&f.home), before, "no file was created or changed");
}

#[test]
fn a_tick_where_devswarm_is_absent_is_inert() {
    let f = fx("inert", false);
    let (st, rec) = (settings(&f, &[]), Rec::default());
    let before = walk(&f.home);
    let out = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    assert_eq!(out["reason"], "inert");
    assert_eq!(rec.n(), 0);
    assert_eq!(walk(&f.home), before);
}

fn walk(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let md = e.metadata().unwrap();
            if md.is_dir() {
                stack.push(e.path());
            } else {
                out.push((e.path(), md.len()));
            }
        }
    }
    out.sort();
    out
}

// ---- the double-run guard ---------------------------------------------------------------------------------------------------

#[test]
fn the_double_run_guard_holds_the_engine_back_while_the_node_supervisor_logs() {
    let f = fx("guard", true);
    let (st, rec) = (settings(&f, &[]), Rec::default());
    let log = f.home.join(".anti-hall/devswarm-supervisor.log");
    assert!(node_running(&f.home, now()).is_none(), "no log, no Node supervisor");
    age_log(&log, 30_000);
    assert!(node_running(&f.home, now()).is_some_and(|a| a >= 29_000));
    let out = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    assert_eq!(out["reason"], "node-running");
    assert_eq!(rec.n(), 0, "not one duty ran");
    assert!(!dev(&f).join("locks/sweep.lock").exists());
    // switched off: the log goes quiet for longer than the guard, and the tick runs
    age_log(&log, 3_600_000);
    assert!(node_running(&f.home, now()).is_none());
    let out = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    assert_eq!(out["ran"], true, "{out}");
    assert!(rec.n() > 0);
    // a rotation in progress (the log renamed to .1) still counts as running
    std::fs::remove_file(&log).unwrap();
    age_log(&f.home.join(".anti-hall/devswarm-supervisor.log.1"), 10_000);
    assert!(node_running(&f.home, now()).is_some());
}

// ---- the tick: order, gates, lock ---------------------------------------------------------------------------------------------

#[test]
fn a_tick_runs_the_duties_in_nodes_order_with_the_poke_owner_and_the_shared_lock() {
    let f = fx("order", true);
    let (st, rec) = (settings(&f, &[]), Rec::default());
    let out = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    let names: Vec<&str> = out["duties"].as_array().unwrap().iter().map(|d| d["duty"].as_str().unwrap()).collect();
    assert_eq!(names, ["log_rotate", "verdicts", "reconcile", "deferred", "app_sync", "retention", "housekeeping"]);
    let calls = rec.calls.lock().unwrap();
    // the liveness sweep and housekeeping are native (the sweep asks git for the worktree's last commit); the other four duties
    // are Node's functions
    let node: Vec<&RunSpec> = calls.iter().filter(|c| c.bin.as_deref() == Some("node")).collect();
    assert_eq!(node.len(), 4, "{calls:?}");
    assert!(calls.iter().filter(|c| c.bin.as_deref() != Some("node")).all(|c| c.bin.as_deref() == Some("git")));
    for c in node.iter() {
        assert_eq!(c.args[0], "-e");
        assert_eq!(c.args[2], f.root.to_string_lossy());
        assert_eq!(c.args[3], f.home.to_string_lossy());
        assert!(c.timeout_ms > 0 && c.timeout_ms <= 900_000);
    }
    assert!(node[0].args[1].contains("reconcileSweepIfDue"));
    assert!(calls.iter().all(|c| c.args.len() < 2 || !c.args[1].contains("housekeepingSweepIfDue")), "housekeeping is native: no worker for it");
    drop(calls);
    assert!(!dev(&f).join("locks/sweep.lock").exists(), "the lock is released");
    // a workspace with a step plan is one Node has tail work for: the sweep is then told who pokes
    put(
        &dev(&f).join("plans/ws-1.json"),
        &json!({"v": 1, "key": "ws-1", "id": "ws-1", "created_at": 1, "steps": [{"n": 1, "text": "a", "status": "doing", "ts": 1, "started_at": 1}]}),
    );
    let (rec_e, rec_n) = (Rec::default(), Rec::default());
    tick::run(&ctx(&f, &st, true), Owner::Engine, &rec_e);
    tick::run(&ctx(&f, &st, false), Owner::Engine, &rec_n);
    let sweep_owner = |r: &Rec| r.calls.lock().unwrap().iter().find(|c| c.args.get(1).is_some_and(|a| a.contains("sweepOnce"))).map(|c| c.args[4].clone());
    assert_eq!(sweep_owner(&rec_e).as_deref(), Some("engine"), "the tail sweep is told the engine pokes");
    assert_eq!(sweep_owner(&rec_n).as_deref(), Some("node"), "Node's poke step runs only when the engine does not own it");
    assert!(f.home.join(".anti-hall/logs/devswarm-supervisor-engine.ndjson").exists(), "the engine's own tick log");
}

/// A runner that looks at the lock while a duty runs.
struct LockProbe {
    seen: Mutex<Vec<Value>>,
    lock: String,
}

impl Runner for LockProbe {
    fn run(&self, _spec: &RunSpec) -> RunResult {
        let rec = std::fs::read_to_string(&self.lock).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        self.seen.lock().unwrap().push(rec);
        RunResult { ok: true, status: Some(0), stdout: "{}".into(), ..RunResult::default() }
    }
}

#[test]
fn the_sweep_lock_is_nodes_file_held_during_the_duties_and_a_live_holder_skips_the_tick() {
    let f = fx("lock", true);
    let st = settings(&f, &[]);
    let lock = tick::lock_path(&f.home);
    let probe = LockProbe { seen: Mutex::new(vec![]), lock: lock.clone() };
    tick::run(&ctx(&f, &st, true), Owner::Engine, &probe);
    let seen = probe.seen.lock().unwrap();
    assert!(!seen.is_empty());
    for rec in seen.iter() {
        assert_eq!(rec["pid"], std::process::id(), "Node's owner record: {rec}");
        assert!(rec["token"].is_string() && rec["host"].is_string() && rec["ts"].is_number());
    }
    drop(seen);
    // another live sweep (here: a lock this process holds) makes the tick skip, and Node's own acquire is refused by ours
    let held = nodelock::acquire(&lock, nodelock::Params { stale_ms: 300_000, wait_ms: 0, steal_dead: true, ..nodelock::Params::swarm() }).unwrap();
    let rec = Rec::default();
    let out = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    assert_eq!(out["reason"], "locked");
    assert_eq!(rec.n(), 0);
    if have_node() {
        let got = node_eval(
            &f.home,
            "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");const r=S.acquireSweepLock(process.argv[2],{});console.log(JSON.stringify({got:!!r}));if(r)r()",
        );
        assert_eq!(got["got"], false, "a Node sweep sees the engine's lock and exits");
    }
    assert!(held.release());
    if have_node() {
        let got = node_eval(
            &f.home,
            "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");const r=S.acquireSweepLock(process.argv[2],{});console.log(JSON.stringify({got:!!r}));if(r)r()",
        );
        assert_eq!(got["got"], true, "released: Node takes it");
    }
}

#[test]
fn cooldown_duties_follow_nodes_state_files_and_switches() {
    let f = fx("gates", true);
    let rec = Rec::default();
    let st = settings(&f, &[]);
    // never run: due
    let out = tick::run_duty("reconcile", &ctx(&f, &st, true), &rec);
    assert_eq!(out["outcome"], "ran");
    // Node's state file says it just ran: skipped, for the engine and for Node alike
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": now() - 60_000}));
    put(&dev(&f).join("housekeeping-sweep-state.json"), &json!({"lastRunAt": now() - 60_000}));
    for d in ["reconcile", "housekeeping"] {
        let out = tick::run_duty(d, &ctx(&f, &st, true), &rec);
        assert_eq!((out["outcome"].as_str(), out["reason"].as_str()), (Some("skipped"), Some("cooldown")), "{d}");
    }
    assert_eq!(rec.n(), 1, "only the first reconcile started a worker");
    // past the setting's seconds: due again
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": now() - 1_000_000}));
    assert_eq!(tick::run_duty("reconcile", &ctx(&f, &st, true), &rec)["outcome"], "ran");
    // the switches, from settings.json exactly as Node reads them
    put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"reconcileSweep": "off", "housekeepingSweep": "off"}}));
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": 0}));
    let n = rec.n();
    for d in ["reconcile", "housekeeping"] {
        let out = tick::run_duty(d, &ctx(&f, &st, true), &rec);
        assert_eq!((out["outcome"].as_str(), out["reason"].as_str()), (Some("skipped"), Some("disabled")), "{d}");
    }
    assert_eq!(rec.n(), n);
    // the cool-down seconds setting is floored at 300 like Node's
    put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"reconcileSweepSec": 5}}));
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": now() - 100_000}));
    assert_eq!(tick::run_duty("reconcile", &ctx(&f, &st, true), &rec)["reason"], "cooldown", "100 s is inside the 300 s floor");
}

#[test]
fn the_gate_agrees_with_nodes_own_answer_on_the_same_state() {
    if !have_node() {
        return;
    }
    let f = fx("gate-vs-node", true);
    let rec = Rec::default();
    let st = settings(&f, &[]);
    put(&dev(&f).join("housekeeping-sweep-state.json"), &json!({"lastRunAt": now() - 60_000}));
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": now() - 60_000}));
    let node = node_eval(
        &f.home,
        "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");console.log(JSON.stringify({h:S.housekeepingSweepIfDue({home:process.argv[2]}).reason,r:S.reconcileSweepIfDue({home:process.argv[2]}).reason}))",
    );
    assert_eq!(node, json!({"h": "cooldown", "r": "cooldown"}));
    assert_eq!(tick::run_duty("housekeeping", &ctx(&f, &st, true), &rec)["reason"], "cooldown");
    assert_eq!(tick::run_duty("reconcile", &ctx(&f, &st, true), &rec)["reason"], "cooldown");
    // and the other way: an old state is due for both (Node is asked first: the engine's run advances the shared state file)
    put(&dev(&f).join("housekeeping-sweep-state.json"), &json!({"lastRunAt": now() - 4_000_000}));
    let node = node_eval(
        &f.home,
        "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");const fs=require(\"fs\");const p=process.argv[2]+\"/.anti-hall/devswarm/housekeeping-sweep-state.json\";const before=fs.readFileSync(p,\"utf8\");const r=S.housekeepingSweepIfDue({home:process.argv[2]});fs.writeFileSync(p,before);console.log(JSON.stringify({h:r.ran}))",
    );
    assert_eq!(node["h"], true, "Node also finds it due");
    assert_eq!(tick::run_duty("housekeeping", &ctx(&f, &st, true), &rec)["outcome"], "ran");
}

// ---- each duty against real Node on a fixture home ----------------------------------------------------------------------------

#[test]
fn the_node_duties_run_for_real_in_a_scratch_home_and_are_idempotent() {
    if !have_node() {
        return;
    }
    let f = fx("real", true);
    let st = settings(&f, &[]);
    let sys = System::configured();
    // the liveness sweep writes the verdict file of the descriptor
    let out = tick::run_duty("verdicts", &ctx(&f, &st, true), &sys);
    assert_eq!(out["outcome"], "ran", "{out}");
    assert_eq!(out["detail"]["native"], 1);
    let v1 = std::fs::read_to_string(dev(&f).join("liveness/ws-1.json")).unwrap();
    let parsed: Value = serde_json::from_str(&v1).unwrap();
    assert!(parsed.get("status").is_some(), "{v1}");
    let out = tick::run_duty("verdicts", &ctx(&f, &st, true), &sys);
    assert_eq!(out["outcome"], "ran");
    let v2: Value = serde_json::from_str(&std::fs::read_to_string(dev(&f).join("liveness/ws-1.json")).unwrap()).unwrap();
    assert_eq!(v2["status"], parsed["status"], "a second sweep of an unchanged workspace says the same");
    // the deferred stage: no marker, only the rotation cursor moves
    let out = tick::run_duty("deferred", &ctx(&f, &st, true), &sys);
    assert_eq!((out["outcome"].as_str(), out["detail"]["reason"].as_str()), (Some("ran"), Some("no-marker")), "{out}");
    let cursor1: Value = serde_json::from_str(&std::fs::read_to_string(dev(&f).join("deferred-sweep-state.json")).unwrap()).unwrap();
    tick::run_duty("deferred", &ctx(&f, &st, true), &sys);
    let cursor2: Value = serde_json::from_str(&std::fs::read_to_string(dev(&f).join("deferred-sweep-state.json")).unwrap()).unwrap();
    assert_ne!(cursor1, cursor2, "the four stages rotate one per tick");
    // housekeeping: Node's own state file records the run; the second call is held back by the gate
    let out = tick::run_duty("housekeeping", &ctx(&f, &st, true), &sys);
    assert_eq!(out["outcome"], "ran", "{out}");
    let state: Value = serde_json::from_str(&std::fs::read_to_string(dev(&f).join("housekeeping-sweep-state.json")).unwrap()).unwrap();
    assert!(state["lastRunAt"].as_i64().unwrap() > 0);
    assert_eq!(tick::run_duty("housekeeping", &ctx(&f, &st, true), &sys)["reason"], "cooldown");
    // retention and app sync: they ran (their result is Node's own) and deleted nothing under the home
    let before = walk(&f.home).len();
    for d in ["retention", "app_sync"] {
        let out = tick::run_duty(d, &ctx(&f, &st, true), &sys);
        assert_eq!(out["outcome"], "ran", "{d}: {out}");
    }
    assert!(walk(&f.home).len() >= before, "no file of the home was removed");
    assert!(f.home.join(".anti-hall/devswarm/workspaces/ws-1.json").exists());
}

#[test]
fn a_missing_node_fails_the_duty_and_not_the_tick() {
    struct NoNode;
    impl Runner for NoNode {
        fn run(&self, _s: &RunSpec) -> RunResult {
            RunResult { missing: true, error: Some("not found".into()), ..RunResult::default() }
        }
    }
    let f = fx("nonode", true);
    let st = settings(&f, &[]);
    let out = tick::run(&ctx(&f, &st, true), Owner::Engine, &NoNode);
    assert_eq!(out["ran"], true);
    let d = out["duties"].as_array().unwrap();
    assert_eq!(d[0]["outcome"], "ran", "the native duty does not need Node");
    for x in &d[1..] {
        let native = x["duty"] == "housekeeping" || x["duty"] == "verdicts";
        assert_eq!(x["outcome"] == "ran", native, "{x}: a native duty runs without Node, the others fail alone");
    }
}

// ---- log rotation against Node ----------------------------------------------------------------------------------------------

#[test]
fn log_rotation_is_nodes_rotation() {
    if !have_node() {
        return;
    }
    let body = "x".repeat(400);
    let setup = |tag: &str| {
        let f = fx(tag, true);
        put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"supervisorLogRotateBytes": 300}}));
        std::fs::write(f.home.join(".anti-hall/devswarm-supervisor.log"), &body).unwrap();
        std::fs::write(f.home.join(".anti-hall/devswarm-supervisor.log.1"), "old generation").unwrap();
        f
    };
    let (a, b) = (setup("rot-engine"), setup("rot-node"));
    let st = settings(&a, &[]);
    let eng = tick::log_rotate(&ctx(&a, &st, true));
    let node = node_eval(
        &b.home,
        "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");console.log(JSON.stringify(S.rotateSupervisorLogIfNeeded({home:process.argv[2]})))",
    );
    assert_eq!(eng["supervisor"]["rotated"], node["rotated"]);
    assert_eq!(eng["supervisor"]["size"], node["size"]);
    let rd = |h: &Fx, n: &str| std::fs::read_to_string(h.home.join(".anti-hall").join(n)).ok();
    assert_eq!(rd(&a, "devswarm-supervisor.log"), rd(&b, "devswarm-supervisor.log"), "the log is gone in both");
    assert_eq!(rd(&a, "devswarm-supervisor.log.1"), rd(&b, "devswarm-supervisor.log.1"), "the backup is the old log in both");
    assert_eq!(rd(&a, "devswarm-supervisor.log.1"), Some(body.clone()));
    // under the threshold: untouched, same words
    let c = setup("rot-under");
    put(&c.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"supervisorLogRotateBytes": 4000}}));
    let st = settings(&c, &[]);
    let eng = tick::log_rotate(&ctx(&c, &st, true));
    let node = node_eval(
        &c.home,
        "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");console.log(JSON.stringify(S.rotateSupervisorLogIfNeeded({home:process.argv[2]})))",
    );
    assert_eq!(eng["supervisor"], node);
    // the engine's own tick log rotates by the same rule
    std::fs::create_dir_all(c.home.join(".anti-hall/logs")).unwrap();
    std::fs::write(c.home.join(".anti-hall/logs/devswarm-supervisor-engine.ndjson"), "y".repeat(5000)).unwrap();
    let eng = tick::log_rotate(&ctx(&c, &st, true));
    assert_eq!(eng["engine"]["rotated"], true);
    // no log yet
    let d = fx("rot-none", true);
    let st = settings(&d, &[]);
    assert_eq!(tick::log_rotate(&ctx(&d, &st, true))["supervisor"], json!({"rotated": false, "size": 0, "reason": "no log file yet"}));
}

// ---- the verdict mirror against Node's recovery code ---------------------------------------------------------------------------

fn norm_ts(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("\"ts\":") {
        out.push_str(&rest[..i + 5]);
        let tail = &rest[i + 5..];
        let end = tail.find(|c: char| !c.is_ascii_digit()).unwrap_or(tail.len());
        out.push('T');
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

const NODE_NUDGE: &str = "process.env.HOME=process.argv[2];const R=require(process.argv[1]+\"/companion/lib/recovery.js\");const d={id:\"ws-1\",worktreePath:\"/nonexistent/wt\",sessionId:\"s\",nudgeCommand:[\"x\"],escalateCommand:[\"y\"]};const v=JSON.parse(process.argv[3]);const r=R.pokeOrEscalate(d,v,{home:process.argv[2],now:Number(process.argv[4]),nudgeMaxAttempts:2,nudgeCooldownMs:0},{nudge(){},escalate(){},openParentStore(){throw new Error(\"no store\")}});console.log(JSON.stringify(r))";

fn node_nudge(home: &Path, verdict: &Value, now: i64) -> Value {
    let root = ah_engine::defaults::root().unwrap();
    let o =
        Command::new("node").args(["-e", NODE_NUDGE, root.to_str().unwrap(), home.to_str().unwrap(), &verdict.to_string(), &now.to_string()]).output().unwrap();
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    serde_json::from_str(String::from_utf8_lossy(&o.stdout).lines().last().unwrap()).unwrap()
}

fn read(home: &Path, rel: &str) -> String {
    std::fs::read_to_string(home.join(".anti-hall/devswarm").join(rel)).unwrap_or_default()
}

#[test]
fn an_engine_poke_and_escalation_leave_nodes_exact_files() {
    if !have_node() {
        return;
    }
    // previous verdicts of different shapes: a fresh stale one, a nudged one with an error, an odd one with extra fields
    let prevs = [
        json!({"status": "stale", "lastOutboundTs": 1790423660282.9983_f64, "staleSince": 1790000000000_i64, "nudgeAttempts": 0, "nudgedAt": null, "pending": true, "notDraining": false, "oldestUnreadAgeMs": 5}),
        json!({"status": "nudged", "recoveries": 1, "recoveredAt": 1789000000000_i64, "nudgeAttempts": 1, "nudgedAt": 1790000100000_i64, "staleSince": 1790000000000_i64, "lastOutboundTs": 1790423660282_i64, "lastNudgeError": "spawn x ENOENT"}),
    ];
    for (i, prev) in prevs.iter().enumerate() {
        let t = now();
        // poke
        let (a, b) = (fx(&format!("vm-a{i}"), true), fx(&format!("vm-b{i}"), true));
        for h in [&a, &b] {
            put(&dev(h).join("liveness/ws-1.json"), prev);
        }
        let attempts = prev["nudgeAttempts"].as_u64().unwrap();
        let r = node_nudge(&a.home, prev, t);
        assert_eq!(r["action"], "nudged", "{r}");
        verdict::mirror_poke(&b.home, "ws-1", attempts + 1, t);
        assert_eq!(read(&a.home, "liveness/ws-1.json"), read(&b.home, "liveness/ws-1.json"), "verdict bytes after a poke (prev {i})");
        assert_eq!(norm_ts(&read(&a.home, "recovery.log")), norm_ts(&read(&b.home, "recovery.log")), "recovery log after a poke (prev {i})");
        // escalate: pokes used up
        let used = json!({"status": "nudged", "nudgeAttempts": 2, "nudgedAt": t, "staleSince": 1790000000000_i64, "lastNudgeError": prev.get("lastNudgeError").cloned().unwrap_or(Value::Null)});
        let (c, d) = (fx(&format!("vm-c{i}"), true), fx(&format!("vm-d{i}"), true));
        for h in [&c, &d] {
            put(&dev(h).join("liveness/ws-1.json"), &used);
        }
        let r = node_nudge(&c.home, &used, t + 1000);
        assert_eq!(r["action"], "escalate", "{r}");
        verdict::mirror_escalate(&d.home, "ws-1", t + 1000);
        assert_eq!(read(&c.home, "liveness/ws-1.json"), read(&d.home, "liveness/ws-1.json"), "verdict bytes after an escalation (prev {i})");
        assert_eq!(norm_ts(&read(&c.home, "recovery.log")), norm_ts(&read(&d.home, "recovery.log")), "recovery log after an escalation (prev {i})");
    }
    // no previous verdict at all
    let (a, b) = (fx("vm-n-a", true), fx("vm-n-b", true));
    let r = node_nudge(&a.home, &json!({"status": "stale", "nudgeAttempts": 0}), now());
    assert_eq!(r["action"], "nudged");
    verdict::mirror_poke(&b.home, "ws-1", 1, now());
    let (x, y): (Value, Value) =
        (serde_json::from_str(&read(&a.home, "liveness/ws-1.json")).unwrap(), serde_json::from_str(&read(&b.home, "liveness/ws-1.json")).unwrap());
    assert_eq!(x["status"], y["status"]);
    assert_eq!(x["nudgeAttempts"], y["nudgeAttempts"]);
    assert_eq!(
        read(&a.home, "liveness/ws-1.json").split("\"nudgedAt\"").next(),
        read(&b.home, "liveness/ws-1.json").split("\"nudgedAt\"").next(),
        "same keys in the same order up to the time"
    );
}

#[test]
fn the_verdict_mirror_never_writes_for_an_unsafe_id() {
    let f = fx("vm-unsafe", false);
    verdict::mirror_poke(&f.home, "../evil", 1, now());
    verdict::mirror_escalate(&f.home, "a/b", now());
    assert!(!dev(&f).join("liveness").exists() || std::fs::read_dir(dev(&f).join("liveness")).unwrap().count() == 0);
    assert!(verdict::path(&f.home, "ws-1").is_some() && verdict::path(&f.home, "..").is_none());
}

// ---- recover ---------------------------------------------------------------------------------------------------------------

fn do_recover(f: &Fx, st: &Settings, r: &dyn Runner, id: &str, req: &str) -> (Value, i32) {
    recover::run(&recover::Place { home: &f.home, root: &f.root, state_dir: &f.state }, st, r, id, req, now())
}

#[test]
fn recover_refuses_before_it_touches_anything() {
    let f = fx("rec", true);
    let st = settings(&f, &[]);
    let rec = Rec::default();
    let why = |r: &(Value, i32)| r.0["why"].as_str().unwrap_or_default().to_string();
    // an automated caller (a subagent, a hook, a workflow) is refused
    let auto = settings(&f, &[("ANTIHALL_CALLER", "supervisor")]);
    let r = do_recover(&f, &auto, &rec, "ws-1", "r1");
    assert_eq!((r.0["outcome"].as_str(), r.1), (Some("refused"), 64));
    assert!(why(&r).contains("supervisor"), "{r:?}");
    // an unsafe or missing id, a missing request
    for id in ["", "../ws-1", "a/b", ".."] {
        assert_eq!(do_recover(&f, &st, &rec, id, "r1").0["outcome"], "refused", "{id:?}");
    }
    assert_eq!(do_recover(&f, &st, &rec, "ws-1", "").0["outcome"], "refused");
    // a workspace with no descriptor, or one without a session
    assert!(why(&do_recover(&f, &st, &rec, "ghost", "r1")).contains("no usable descriptor"));
    put(&dev(&f).join("workspaces/nosession.json"), &json!({"id": "nosession", "worktreePath": "/x"}));
    assert!(why(&do_recover(&f, &st, &rec, "nosession", "r1")).contains("no usable descriptor"));
    // recovered the most times allowed already
    put(&dev(&f).join("liveness/ws-1.json"), &json!({"status": "stale", "recoveries": 3}));
    assert!(why(&do_recover(&f, &st, &rec, "ws-1", "r1")).contains("limit 3"));
    put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"maxRecoveries": 5}}));
    let (r, _) = do_recover(&f, &st, &rec, "ws-1", "r1");
    assert_eq!(r["outcome"], "handled", "with a limit of 5 and 3 done it may run: {r}");
    assert_eq!(r["result"]["action"], "abstain", "the stub process table has no such session: nothing is signalled");
    assert!(!f.state.join("none").exists());
    // none of the refusals started anything or wrote the ledger (only the last, allowed, request did)
    let ledger = std::fs::read_to_string(f.state.join("rt-recover.ndjson")).unwrap();
    assert_eq!(ledger.lines().count(), 1);
}

#[test]
fn the_rollback_hands_the_kill_to_nodes_recover_cli_with_exactly_the_one_id() {
    let f = fx("rec-ok", true);
    let st = settings(&f, &[]);
    struct Cli(Mutex<Vec<RunSpec>>);
    impl Runner for Cli {
        fn run(&self, s: &RunSpec) -> RunResult {
            self.0.lock().unwrap().push(s.clone());
            RunResult {
                ok: true,
                status: Some(0),
                stdout: "{\"ok\":true,\"id\":\"ws-1\",\"result\":{\"action\":\"abstain\"}}\n".into(),
                ..RunResult::default()
            }
        }
    }
    let cli = Cli(Mutex::new(vec![]));
    let place = recover::Place { home: &f.home, root: &f.root, state_dir: &f.state };
    let (r, code) = recover::run_node(&place, &st, &cli, "ws-1", "req-1", now());
    assert_eq!((r["outcome"].as_str(), code), (Some("handled"), 0), "{r}");
    assert_eq!(r["node"]["result"]["action"], "abstain");
    let calls = cli.0.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].args[0], "-e");
    assert!(calls[0].args[1].contains("devswarm-recover.js") && calls[0].args[1].contains(".run(["), "Node's own run, as its CLI calls it");
    assert_eq!(
        calls[0].args[2..],
        [f.root.to_string_lossy().into_owned(), f.home.to_string_lossy().into_owned(), "ws-1".to_string()],
        "exactly the one id, nothing else"
    );
    drop(calls);
    // a failing Node is reported, not hidden
    struct Bad;
    impl Runner for Bad {
        fn run(&self, _s: &RunSpec) -> RunResult {
            RunResult { ok: false, status: Some(1), stderr: "boom".into(), ..RunResult::default() }
        }
    }
    let (r, code) = recover::run_node(&place, &st, &Bad, "ws-1", "req-2", now());
    assert_eq!((r["outcome"].as_str(), code), (Some("failed"), 1));
}

#[test]
fn a_recover_request_runs_once() {
    let f = fx("rec-once", true);
    let st = settings(&f, &[]);
    let rec = Rec::default();
    let (r, code) = do_recover(&f, &st, &rec, "ws-1", "req-1");
    assert_eq!((r["outcome"].as_str(), code), (Some("handled"), 0), "{r}");
    let (again, code) = do_recover(&f, &st, &rec, "ws-1", "req-1");
    assert_eq!((again["outcome"].as_str(), code), (Some("refused"), 64), "the same request never runs twice");
}

#[test]
fn recover_against_real_node_abstains_on_a_session_that_is_not_running() {
    if !have_node() {
        return;
    }
    let f = fx("rec-real", true);
    let st = settings(&f, &[]);
    let (r, code) = do_recover(&f, &st, &System::configured(), "ws-1", "real-1");
    assert_eq!(code, 0, "{r}");
    assert_eq!(r["outcome"], "handled");
    assert_eq!(r["result"]["action"], "abstain", "no process matches the session: nothing is killed: {r}");
    assert_eq!(r["result"]["reason"], "no-candidate");
}

#[test]
fn recover_is_for_the_main_session_only_and_never_automatic() {
    ah_engine::defaults::init().unwrap();
    use ah_engine::dswire::cli::allowed;
    assert!(allowed("main", "recover"));
    for role in ["child", "subagent", "codex"] {
        assert!(!allowed(role, "recover"), "{role}");
        assert!(allowed(role, "supervisor"), "reading who owns the duties is open to {role}");
    }
    let auto = ah_engine::defaults::list("devswarm_act.automatic_kinds");
    assert!(!auto.contains(&"recover"));
    let duties = ah_engine::defaults::list("devswarm_sup.duties");
    assert!(!duties.iter().any(|d| d.contains("recover")), "no scheduled duty recovers");
    for d in &duties {
        let snippet = ah_engine::defaults::raw(&format!("devswarm_sup.duty.{d}")).str_field("snippet");
        assert!(!snippet.contains("recover(") && !snippet.contains("devswarm-recover"), "{d}");
    }
}

// ---- the action layer stands down while Node runs ---------------------------------------------------------------------------

#[test]
fn the_status_verb_reports_owner_guard_and_gates() {
    let f = fx("status", true);
    let st = settings(&f, &[]);
    age_log(&f.home.join(".anti-hall/devswarm-supervisor.log"), 1000);
    let v = ah_engine::dssup::cli::status(&f.home, &st, Owner::Engine, now());
    assert_eq!(v["mode"], "engine");
    assert!(v["nodeSupervisorRunning"].is_number());
    assert_eq!(v["duties"].as_array().unwrap().len(), 7);
    put(&dev(&f).join("housekeeping-sweep-state.json"), &json!({"lastRunAt": now()}));
    let v = ah_engine::dssup::cli::status(&f.home, &st, Owner::Witness, now());
    assert_eq!(v["mode"], "witness");
    let hk = v["duties"].as_array().unwrap().iter().find(|d| d["duty"] == "housekeeping").unwrap();
    assert_eq!(hk["notDue"], "cooldown");
}

// ---- housekeeping, native, against Node's own sweep and with the witness ------------------------------------------------------

const DAY_MS: i64 = 86_400_000;

/// Make `rel` (under the DevSwarm state directory of `f`) a file whose modification time is `age_days` days before `at`.
fn aged(f: &Fx, rel: &str, age_days: f64, at: i64) {
    let p = dev(f).join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, "x").unwrap();
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis((at as f64 - age_days * DAY_MS as f64) as u64);
    std::fs::OpenOptions::new().write(true).open(&p).unwrap().set_modified(t).unwrap();
}

fn aged_abs(p: &Path, age_days: f64, at: i64) {
    std::fs::write(p, "x").unwrap();
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis((at as f64 - age_days * DAY_MS as f64) as u64);
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_modified(t).unwrap();
}

fn seed_housekeeping(f: &Fx, at: i64) {
    aged(f, "reaped/old.ndjson", 40.0, at);
    aged(f, "reaped/new.ndjson", 2.0, at);
    aged(f, "reaped/edge-in.ndjson", 29.5, at);
    aged(f, "reaped/edge-out.ndjson", 30.5, at);
    aged(f, "reaped/old-but-not-a-log.txt", 90.0, at);
    aged(f, "reaped/2026-01-01/dated-old.ndjson", 60.0, at);
    aged(f, "reaped/2026-01-01/dated-new.ndjson", 1.0, at);
    aged(f, "reaped/a/b/too-deep-old.ndjson", 90.0, at);
    aged(f, "child-gate/session-old.json", 20.0, at);
    aged(f, "child-gate/session-new.json", 3.0, at);
    aged(f, "child-gate/session-edge-out.json", 14.5, at);
    aged(f, "child-gate/session-edge-in.json", 13.5, at);
    aged(f, "child-gate/old-other.log", 90.0, at);
    // a link to a directory that holds old files of the right name: the sweep never follows it
    std::fs::create_dir_all(f.home.join("elsewhere")).unwrap();
    aged_abs(&f.home.join("elsewhere/precious.ndjson"), 400.0, at);
    std::os::unix::fs::symlink(f.home.join("elsewhere"), dev(f).join("reaped/linked-dir")).unwrap();
    // files that are not the sweeps' business, however old
    aged(f, "liveness/ws-1.json", 400.0, at);
    aged(f, "locks/x.lock", 400.0, at);
    aged(f, "inbox/ws-1.ndjson", 400.0, at);
}

fn tree(f: &Fx) -> Vec<String> {
    let base = dev(f);
    let mut out: Vec<String> = walk(&base).into_iter().map(|(p, _)| p.strip_prefix(&base).unwrap().to_string_lossy().into_owned()).collect();
    out.sort();
    out
}

fn node_housekeeping(home: &Path, at: i64) -> Value {
    node_eval(
        home,
        &format!(
            "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");const r=S.housekeepingSweepIfDue({{home:process.argv[2],now:{at}}});console.log(JSON.stringify(r))"
        ),
    )
}

#[test]
fn native_housekeeping_removes_exactly_what_nodes_sweep_removes_and_nothing_else() {
    if !have_node() {
        return;
    }
    let at = now();
    let (a, b) = (fx("hk-engine", true), fx("hk-node", true));
    seed_housekeeping(&a, at);
    seed_housekeeping(&b, at);
    let st = settings(&a, &[]);
    let mut c = ctx(&a, &st, true);
    c.now = at;
    let eng = tick::run_duty("housekeeping", &c, &Rec::default());
    let node = node_housekeeping(&b.home, at);
    assert_eq!(eng["outcome"], "ran", "{eng}");
    assert_eq!(node["ran"], true, "{node}");
    // the same files survive in both homes, byte for byte the same tree
    // the tree is the same in both homes, EXCEPT that Node follows the link and removes the file it points to; the engine does not
    assert!(a.home.join("elsewhere/precious.ndjson").exists(), "the engine never follows a directory link");
    std::fs::remove_file(b.home.join("elsewhere/precious.ndjson")).ok();
    std::fs::write(b.home.join("elsewhere/precious.ndjson"), "x").unwrap();
    assert_eq!(tree(&a), tree(&b));
    let gone: Vec<String> = [
        "reaped/old.ndjson",
        "reaped/edge-out.ndjson",
        "reaped/2026-01-01/dated-old.ndjson",
        "child-gate/session-old.json",
        "child-gate/session-edge-out.json",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let left = tree(&a);
    for g in &gone {
        assert!(!left.contains(g), "{g} is removed");
    }
    for keep in [
        "reaped/new.ndjson",
        "reaped/edge-in.ndjson",
        "reaped/old-but-not-a-log.txt",
        "reaped/2026-01-01/dated-new.ndjson",
        "reaped/a/b/too-deep-old.ndjson",
        "child-gate/session-new.json",
        "child-gate/session-edge-in.json",
        "child-gate/old-other.log",
        "liveness/ws-1.json",
        "locks/x.lock",
        "inbox/ws-1.ndjson",
    ] {
        assert!(left.contains(&keep.to_string()), "{keep} stays");
    }
    // the result rows: same keys, same statuses, the same files (relative to each home)
    let rows = |v: &Value, base: &Path, node: bool| -> Vec<(String, String)> {
        let results = if node { &v["results"] } else { &v["detail"]["results"] };
        let mut out: Vec<(String, String)> = results
            .as_object()
            .unwrap()
            .values()
            .flat_map(|r| r.as_array().unwrap().iter())
            .filter(|r| !r["file"].as_str().unwrap().contains("linked-dir")) // Node follows the link, the engine does not (checked above)
            .map(|r| {
                (r["status"].as_str().unwrap().to_string(), Path::new(r["file"].as_str().unwrap()).strip_prefix(base).unwrap().to_string_lossy().into_owned())
            })
            .collect();
        out.sort();
        out
    };
    assert_eq!(rows(&eng, &dev(&a), false), rows(&node, &dev(&b), true));
    assert_eq!(eng["detail"]["results"].as_object().unwrap().keys().collect::<Vec<_>>(), node["results"].as_object().unwrap().keys().collect::<Vec<_>>());
    // the cool-down state file is Node's, byte for byte
    let state = |f: &Fx| std::fs::read_to_string(dev(f).join("housekeeping-sweep-state.json")).unwrap();
    assert_eq!(state(&a), state(&b));
    assert_eq!(state(&a), json!({"lastRunAt": at}).to_string());
    // a second pass inside the cool-down is held back; forced past it, it finds nothing and fails nothing
    assert_eq!(tick::run_duty("housekeeping", &c, &Rec::default())["reason"], "cooldown");
    put(&dev(&a).join("housekeeping-sweep-state.json"), &json!({"lastRunAt": 0}));
    let again = tick::run_duty("housekeeping", &c, &Rec::default());
    assert_eq!(again["detail"]["results"]["reapedLogs"], json!([]));
    assert_eq!(again["detail"]["results"]["childGate"], json!([]));
    assert_eq!(tree(&a), tree(&b));
}

#[test]
fn native_housekeeping_follows_the_retention_settings_and_a_bad_value_never_narrows_the_window() {
    let at = now();
    let f = fx("hk-settings", true);
    seed_housekeeping(&f, at);
    // a 10-day window for the logs removes the 29.5-day file too; the child-gate window stays at its default
    put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"reapedRetentionDays": 10, "childGateRetentionDays": 0}}));
    let st = settings(&f, &[]);
    let mut c = ctx(&f, &st, true);
    c.now = at;
    tick::run_duty("housekeeping", &c, &Rec::default());
    let left = tree(&f);
    assert!(!left.contains(&"reaped/edge-in.ndjson".to_string()), "10 days: the 29.5 day log goes");
    assert!(left.contains(&"reaped/new.ndjson".to_string()));
    assert!(left.contains(&"child-gate/session-edge-in.json".to_string()), "0 is not a window: the 14 day default applies");
    assert!(!left.contains(&"child-gate/session-edge-out.json".to_string()));
    // the environment wins over the file
    let g = fx("hk-env", true);
    seed_housekeeping(&g, at);
    let st = settings(&g, &[("ANTIHALL_DEVSWARM_CHILD_GATE_RETENTION_DAYS", "1")]);
    let mut c = ctx(&g, &st, true);
    c.now = at;
    tick::run_duty("housekeeping", &c, &Rec::default());
    assert!(!tree(&g).contains(&"child-gate/session-new.json".to_string()), "1 day: the 3 day file goes");
}

#[test]
fn native_housekeeping_is_off_with_the_switches_and_where_the_directories_are_absent() {
    let at = now();
    let f = fx("hk-off", true);
    seed_housekeeping(&f, at);
    let before = tree(&f);
    let st = settings(&f, &[("ANTIHALL_DEVSWARM_SUPERVISOR", "off")]);
    let mut c = ctx(&f, &st, true);
    c.now = at;
    assert_eq!(tick::run_duty("housekeeping", &c, &Rec::default())["reason"], "disabled");
    let st = settings(&f, &[("DISABLE_ANTIHALL_DEVSWARM", "1")]);
    let mut c = ctx(&f, &st, true);
    c.now = at;
    assert_eq!(tick::run_duty("housekeeping", &c, &Rec::default())["reason"], "disabled");
    put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"housekeepingSweep": "off"}}));
    let st = settings(&f, &[]);
    let mut c = ctx(&f, &st, true);
    c.now = at;
    assert_eq!(tick::run_duty("housekeeping", &c, &Rec::default())["reason"], "disabled");
    std::fs::remove_file(f.home.join(".anti-hall/settings.json")).unwrap();
    assert_eq!(tree(&f), before, "a disabled sweep removes nothing and writes no state");
    // no reaped/ and no child-gate/: a routine no-op
    let g = fx("hk-none", true);
    let st = settings(&g, &[]);
    let mut c = ctx(&g, &st, true);
    c.now = at;
    let out = tick::run_duty("housekeeping", &c, &Rec::default());
    assert_eq!((out["outcome"].as_str(), out["detail"]["results"]["reapedLogs"].clone()), (Some("ran"), json!([])));
}

#[test]
fn the_witness_runs_nodes_sweep_on_a_scratch_mirror_and_logs_agreement() {
    if !have_node() {
        return;
    }
    let at = now();
    let f = fx("witness-hk", true);
    seed_housekeeping(&f, at);
    let st = settings(&f, &[("ANTIHALL_DEVSWARM_SUP_WITNESS", "on")]);
    let mut c = ctx(&f, &st, true);
    c.now = at;
    let sys = System::configured();
    let out = tick::run(&c, Owner::Engine, &sys);
    let hk = out["duties"].as_array().unwrap().iter().find(|d| d["duty"] == "housekeeping").unwrap();
    assert_eq!(hk["witness"]["match"], true, "{out}");
    let log = std::fs::read_to_string(f.home.join(".anti-hall/logs/devswarm-sup-witness.ndjson")).unwrap();
    let lines: Vec<Value> = log.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    let h = lines.iter().find(|l| l["duty"] == "housekeeping").unwrap();
    assert_eq!(h["match"], true);
    assert_eq!(h["detail"], json!({"onlyEngine": [], "onlyNode": []}));
    assert!(h["engine"].as_array().unwrap().len() >= 5, "the five old files the engine removed");
    assert!(lines.iter().any(|l| l["duty"] == "log_rotate" && l["match"] == true), "log rotation is witnessed too");
    // the scratch mirror is gone, and the witness never ran Node against the live home
    assert_eq!(std::fs::read_dir(f.home.join(".anti-hall/witness")).map(|d| d.count()).unwrap_or(0), 0);
    // sampled: a second tick inside the interval does not run the witness again
    let before = log.lines().count();
    put(&dev(&f).join("housekeeping-sweep-state.json"), &json!({"lastRunAt": 0}));
    tick::run(&c, Owner::Engine, &sys);
    assert_eq!(std::fs::read_to_string(f.home.join(".anti-hall/logs/devswarm-sup-witness.ndjson")).unwrap().lines().count(), before);
}

#[test]
fn the_witness_logs_a_mismatch_when_the_engine_and_node_disagree() {
    if !have_node() {
        return;
    }
    let at = now();
    let f = fx("witness-mismatch", true);
    seed_housekeeping(&f, at);
    let st = settings(&f, &[("ANTIHALL_DEVSWARM_SUP_WITNESS", "on")]);
    let mut c = ctx(&f, &st, true);
    c.now = at;
    let job = ah_engine::dssup::housekeep::witness_prepare(&c).unwrap();
    // the engine claims it removed nothing at all, but five files were eligible: Node's run on the mirror disagrees
    let claimed = json!({"duty": "housekeeping", "outcome": "ran", "detail": {"ran": true, "results": {"reapedLogs": [], "childGate": []}}});
    let rec = ah_engine::dssup::witness::finish(job, &c, &System::configured(), &claimed);
    assert_eq!(rec["match"], false);
    assert_eq!(rec["detail"]["onlyNode"].as_array().unwrap().len(), 5, "{rec}");
    let log = std::fs::read_to_string(f.home.join(".anti-hall/logs/devswarm-sup-witness.ndjson")).unwrap();
    assert!(log.contains("\"match\":false"));
    // the live files were never touched by the witness
    assert!(tree(&f).contains(&"reaped/old.ndjson".to_string()));
}
