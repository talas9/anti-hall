//! The DevSwarm supervisor duties (lane l7): the witness switch, the double-run guard, the tick against Node on fixture homes
//! (each duty), the shared sweep lock, the verdict mirror of an engine poke / escalation byte for byte against Node's recovery
//! code, the log rotation against Node's, and recover's refusals. Real `node` runs only in a scratch HOME and only the duties
//! that never call `hivecontrol` (reconcile is exercised through its cool-down gate and a recording runner).
use ah_engine::checks::git::util::Settings;
use ah_engine::db::TempDir;
use ah_engine::dsact::runner::{RunResult, RunSpec, Runner};
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
    // the off switch (the diagnostic word of `devswarm_sup.mode`): the tick says it is off, counted as disabled
    assert_eq!(out["reason"], "off");
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
    // every duty is native: the only process the tick starts is git (the liveness sweep asks it for the worktree's last commit)
    let calls = rec.calls.lock().unwrap();
    assert!(calls.iter().all(|c| c.bin.as_deref() == Some("git")), "no Node is launched: {calls:?}");
    drop(calls);
    assert!(!dev(&f).join("locks/sweep.lock").exists(), "the lock is released");
    // a workspace with a step plan changes nothing about that, whoever owns the poke
    put(
        &dev(&f).join("plans/ws-1.json"),
        &json!({"v": 1, "key": "ws-1", "id": "ws-1", "created_at": 1, "steps": [{"n": 1, "text": "a", "status": "doing", "ts": 1, "started_at": 1}]}),
    );
    let (rec_e, rec_n) = (Rec::default(), Rec::default());
    tick::run(&ctx(&f, &st, true), Owner::Engine, &rec_e);
    tick::run(&ctx(&f, &st, false), Owner::Engine, &rec_n);
    for r in [&rec_e, &rec_n] {
        assert!(r.calls.lock().unwrap().iter().all(|c| c.bin.as_deref() != Some("node")), "no Node sweep is started");
    }
    assert!(f.home.join(".anti-hall/logs/devswarm-supervisor-engine.ndjson").exists(), "the engine's own tick log");
}

#[test]
fn a_gated_duty_is_not_run_again_while_its_inputs_are_unchanged() {
    let f = fx("gate", true);
    let (st, rec) = (settings(&f, &[]), Rec::default());
    let duty = |out: &Value, name: &str| out["duties"].as_array().unwrap().iter().find(|d| d["duty"] == name).cloned().unwrap();
    let first = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    assert_eq!(duty(&first, "verdicts")["outcome"], "ran", "{first}");
    assert!(duty(&first, "verdicts")["cpuMs"].is_number(), "every duty record carries its CPU");
    let second = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    let v = duty(&second, "verdicts");
    assert_eq!((v["outcome"].as_str(), v["gate"].as_str()), (Some("skipped"), Some("inputs-unchanged")), "nothing it reads moved: {second}");
    for name in ["app_sync", "retention"] {
        assert_eq!(duty(&second, name)["gate"], "inputs-unchanged", "{name}: {second}");
    }
    assert_eq!(duty(&second, "log_rotate")["outcome"], "ran", "an ungated duty runs every tick");
    // a descriptor that changes is an input that moved: the next tick runs the duty at once
    let wt = f.home.join("wt-2");
    std::fs::create_dir_all(&wt).unwrap();
    put(&dev(&f).join("workspaces/ws-2.json"), &json!({"id": "ws-2", "worktreePath": wt, "sessionId": "11111111-2222-3333-4444-666666666666"}));
    let third = tick::run(&ctx(&f, &st, true), Owner::Engine, &rec);
    assert_eq!(duty(&third, "verdicts")["outcome"], "ran", "a new workspace is run at once: {third}");
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
    assert_eq!(rec.n(), 0, "reconcile is native: no worker is started");
    // past the setting's seconds: due again
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": now() - 1_000_000}));
    assert_eq!(tick::run_duty("reconcile", &ctx(&f, &st, true), &rec)["outcome"], "ran");
    // the switches, from settings.json exactly as Node reads them
    put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"reconcileSweep": "off", "housekeepingSweep": "off"}}));
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": 0}));
    let n = rec.n();
    for d in ["reconcile", "housekeeping"] {
        let out = tick::run_duty(d, &ctx(&f, &st, true), &rec);
        // a duty switched off names its outcome (`disabled`: counted, nothing done), it is not a silent skip
        assert_eq!((out["outcome"].as_str(), out["reason"].as_str()), (Some("disabled"), Some("disabled")), "{d}");
    }
    assert_eq!(rec.n(), n);
    // the cool-down seconds setting is floored at 300 like Node's
    put(&f.home.join(".anti-hall/settings.json"), &json!({"devswarm": {"reconcileSweepSec": 5}}));
    put(&dev(&f).join("reconcile-sweep-state.json"), &json!({"lastRunAt": now() - 100_000}));
    assert_eq!(tick::run_duty("reconcile", &ctx(&f, &st, true), &rec)["reason"], "cooldown", "100 s is inside the 300 s floor");
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
        let native = ["housekeeping", "verdicts", "deferred", "app_sync", "retention", "reconcile"].contains(&x["duty"].as_str().unwrap());
        assert_eq!(x["outcome"] == "ran", native, "{x}: every duty is native and runs without Node");
    }
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
    // #233: every request that passed those checks is still refused: the engine never kills or resumes a session (owner decision F);
    // nothing is signalled, nothing is recorded, and the refusal is the explicit outcome
    let (r, code) = do_recover(&f, &st, &rec, "ws-1", "r1");
    assert_eq!((r["outcome"].as_str(), code), (Some("refused"), 64), "{r}");
    assert!(why(&(r, code)).contains("no rollback of a kill"));
    assert_eq!(rec.n(), 0, "the runner was never asked for the process table");
    assert!(!f.state.join("rt-recover.ndjson").exists(), "a refusal writes no request ledger");
}

#[test]
fn a_recover_request_is_refused_every_time_and_nothing_is_recorded() {
    let f = fx("rec-once", true);
    let st = settings(&f, &[]);
    let rec = Rec::default();
    for _ in 0..2 {
        let (r, code) = do_recover(&f, &st, &rec, "ws-1", "req-1");
        assert_eq!((r["outcome"].as_str(), code), (Some("refused"), 64), "{r}");
    }
    assert!(!f.state.join("rt-recover.ndjson").exists());
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
    assert_eq!(v["mode"], "off");
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

/// A recording runner that answers a `git log -1` call with a fixed commit time.
struct GitCount(Mutex<usize>);
impl Runner for GitCount {
    fn run(&self, _spec: &RunSpec) -> RunResult {
        *self.0.lock().unwrap() += 1;
        RunResult { ok: true, status: Some(0), stdout: "1700000000\n".into(), ..RunResult::default() }
    }
}

#[test]
fn the_liveness_sweep_asks_git_for_a_worktree_only_when_its_head_moved() {
    use ah_engine::dssup::liveness::worktree_activity;
    ah_engine::defaults::init().unwrap();
    let t = TempDir::new("lv-git-cache");
    let wt = std::fs::canonicalize(&t.0).unwrap().join("wt");
    let git = |args: &[&str]| {
        let o = Command::new("git")
            .args(args)
            .current_dir(&wt)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(o.status.success(), "{args:?}");
    };
    std::fs::create_dir_all(&wt).unwrap();
    git(&["init", "-q"]);
    git(&["commit", "-q", "--allow-empty", "-m", "a"]);
    let w = wt.to_string_lossy().into_owned();
    let r = GitCount(Mutex::new(0));
    assert_eq!(worktree_activity(&r, &w), Some(1_700_000_000_000.0));
    worktree_activity(&r, &w);
    worktree_activity(&r, &w);
    assert_eq!(*r.0.lock().unwrap(), 1, "an unchanged HEAD is asked about once");
    std::thread::sleep(std::time::Duration::from_millis(20));
    git(&["commit", "-q", "--allow-empty", "-m", "b"]);
    worktree_activity(&r, &w);
    assert_eq!(*r.0.lock().unwrap(), 2, "a new commit is asked about again");
    let gone = t.0.join("gone").to_string_lossy().into_owned();
    assert_eq!(worktree_activity(&r, &gone), None);
    assert_eq!(*r.0.lock().unwrap(), 2, "a worktree that is gone is not worth a git process");
}

#[test]
fn an_unchanged_liveness_verdict_is_not_written_again() {
    use std::os::unix::fs::MetadataExt;
    let f = fx("lv-nowrite", true);
    let st = settings(&f, &[]);
    let verdict = f.home.join(".anti-hall/devswarm/liveness/ws-1.json");
    tick::run_duty("verdicts", &ctx(&f, &st, true), &Rec::default());
    let first = std::fs::read_to_string(&verdict).expect("the first sweep writes the verdict");
    let ino = std::fs::metadata(&verdict).unwrap().ino();
    tick::run_duty("verdicts", &ctx(&f, &st, true), &Rec::default());
    assert_eq!(std::fs::metadata(&verdict).unwrap().ino(), ino, "an identical verdict is left alone (no temporary file, no fsync, no rename)");
    // a changed one is still written
    std::fs::write(&verdict, first.replace("alive", "stale")).unwrap();
    tick::run_duty("verdicts", &ctx(&f, &st, true), &Rec::default());
    assert_eq!(std::fs::read_to_string(&verdict).unwrap(), first, "a verdict that differs from the computed one is rewritten");
}

/// Measurement, not a gate: where one tick's CPU goes at live weight (700 old workspaces, 10 live ones), duty by duty.
#[test]
#[ignore = "measurement: cargo test --release --test it -- --ignored --nocapture where_a_supervisor_tick_spends_its_cpu"]
fn where_a_supervisor_tick_spends_its_cpu() {
    let f = fx("tickprof", true);
    for i in 0..700 {
        put(&dev(&f).join(format!("heartbeats/old-{i}.json")), &json!({"ts": now() - 86_400_000}));
        put(
            &dev(&f).join(format!("workspaces/old-{i}.json")),
            &json!({"id": format!("old-{i}"), "worktreePath": format!("/gone/{i}"), "sessionId": format!("{i}"), "status": "done"}),
        );
        put(&dev(&f).join(format!("summaries/old-{i}.json")), &json!({"workspaces": {}}));
        put(&dev(&f).join(format!("plans/old-{i}.json")), &json!({"steps": []}));
    }
    for i in 2..=10 {
        let wt = f.home.join(format!("wt-{i}"));
        std::fs::create_dir_all(&wt).unwrap();
        put(
            &dev(&f).join(format!("workspaces/ws-{i}.json")),
            &json!({"id": format!("ws-{i}"), "worktreePath": wt, "sessionId": format!("{i}1111111-2222-3333-4444-555555555555")}),
        );
        put(&dev(&f).join(format!("heartbeats/ws-{i}.json")), &json!({"ts": now()}));
    }
    let st = settings(&f, &[]);
    for round in 0..3 {
        let out = tick::run(&ctx(&f, &st, true), Owner::Engine, &Rec::default());
        let per: Vec<String> = out["duties"]
            .as_array()
            .map(|d| {
                d.iter()
                    .map(|x| format!("{}={}ms/{}ms-cpu({})", x["duty"].as_str().unwrap_or("?"), x["ms"], x["cpuMs"], x["outcome"].as_str().unwrap_or("?")))
                    .collect()
            })
            .unwrap_or_default();
        eprintln!("TICKPROF round {round}: ran={} {}", out["ran"], per.join(" "));
    }
}
