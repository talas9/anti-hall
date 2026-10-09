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
    assert_eq!(calls.len(), 6, "log rotation is native, the other six are Node's functions");
    for c in calls.iter() {
        assert_eq!(c.bin.as_deref(), Some("node"));
        assert_eq!(c.args[0], "-e");
        assert_eq!(c.args[2], f.root.to_string_lossy());
        assert_eq!(c.args[3], f.home.to_string_lossy());
        assert!(c.timeout_ms > 0 && c.timeout_ms <= 900_000);
    }
    assert_eq!(calls[0].args[4], "engine", "the liveness sweep is told the engine pokes");
    assert!(calls[0].args[1].contains("sweepOnce") && calls[1].args[1].contains("reconcileSweepIfDue"));
    drop(calls);
    assert!(!dev(&f).join("locks/sweep.lock").exists(), "the lock is released");
    let rec2 = Rec::default();
    tick::run(&ctx(&f, &st, false), Owner::Engine, &rec2);
    assert_eq!(rec2.calls.lock().unwrap()[0].args[4], "node", "Node's poke step runs only when the engine does not own it");
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
    // and the other way: an old state is due for both
    put(&dev(&f).join("housekeeping-sweep-state.json"), &json!({"lastRunAt": now() - 4_000_000}));
    assert_eq!(tick::run_duty("housekeeping", &ctx(&f, &st, true), &rec)["outcome"], "ran");
    let node = node_eval(
        &f.home,
        "process.env.HOME=process.argv[2];const S=require(process.argv[1]+\"/companion/devswarm-supervisor.js\");console.log(JSON.stringify({h:S.housekeepingSweepIfDue({home:process.argv[2]}).ran}))",
    );
    assert_eq!(node["h"], true, "Node also finds it due");
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
    assert_eq!(out["detail"]["sweep"], 1);
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
    assert!(d[1..].iter().all(|x| x["outcome"] == "failed"), "{out}");
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
    assert_eq!(rec.n(), 1);
    assert!(!f.state.join("none").exists());
    // none of the refusals ran Node or wrote the ledger (only the last, allowed, request did)
    let ledger = std::fs::read_to_string(f.state.join("rt-recover.ndjson")).unwrap();
    assert_eq!(ledger.lines().count(), 1);
}

#[test]
fn recover_runs_nodes_cli_once_per_request_with_the_one_id() {
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
    let (r, code) = do_recover(&f, &st, &cli, "ws-1", "req-1");
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
    let (again, code) = do_recover(&f, &st, &cli, "ws-1", "req-1");
    assert_eq!((again["outcome"].as_str(), code), (Some("refused"), 64), "the same request never runs twice");
    assert_eq!(cli.0.lock().unwrap().len(), 1);
    // a failing Node is reported, not hidden
    struct Bad;
    impl Runner for Bad {
        fn run(&self, _s: &RunSpec) -> RunResult {
            RunResult { ok: false, status: Some(1), stderr: "boom".into(), ..RunResult::default() }
        }
    }
    let (r, code) = do_recover(&f, &st, &Bad, "ws-1", "req-2");
    assert_eq!((r["outcome"].as_str(), code), (Some("failed"), 1));
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
    assert_eq!(r["node"]["result"]["action"], "abstain", "no process matches the session: nothing is killed: {r}");
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
