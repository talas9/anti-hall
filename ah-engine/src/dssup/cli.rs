//! The scheduled job `devswarm_supervisor` (one tick) and the two `devswarm` verbs that
//! belong to this lane, `supervisor` (who owns the duties and what each gate says; read-only) and `recover` (see [`super::recover`]).
use super::{Owner, tick};
use crate::checks::git::util::Settings;
use crate::defaults;
use crate::dsact::runner::{Runner, System};
use crate::reqenv::RequestEnv;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

fn paths() -> Option<(PathBuf, PathBuf)> {
    let home = defaults::env_var("home").map(PathBuf::from)?;
    Some((home, crate::bootstrap::state_dir()?))
}

fn root_dir() -> PathBuf {
    defaults::root().unwrap_or_default()
}

fn now_ms() -> i64 {
    crate::health::now_ms() as i64
}

/// The scheduled job `devswarm_supervisor` (in the daemon): one tick, or an empty answer in witness mode without reading anything
/// else. A tick runs Node's functions in bounded subprocesses; its record is the job's result.
pub fn scheduled() -> String {
    let owner = super::owner();
    if owner != Owner::Engine {
        return String::new();
    }
    let Some((home, _)) = paths() else { return String::new() };
    let st = Settings::from_env(&RequestEnv::capture());
    let ctx = tick::Ctx { home: &home, root: &root_dir(), st: &st, now: now_ms(), engine_pokes: engine_pokes(&|k| crate::dswire::executor(k)) };
    tick::run(&ctx, owner, &System::configured()).to_string()
}

/// Whether Node's poke step must be switched off in the liveness sweep: unless BOTH executors are `node`, someone other than
/// Node's sweep owns poke / escalate (the engine, or nobody).
pub fn engine_pokes(exec: &dyn Fn(&str) -> crate::dswire::Executor) -> bool {
    use crate::dswire::Executor::Node;
    !(exec("poke") == Node && exec("escalate") == Node)
}

/// The `supervisor` verb: a read-only status.
pub fn status(home: &Path, st: &Settings, owner: Owner, now: i64) -> Value {
    let names = defaults::list("devswarm_sup.duties");
    let duties: Vec<Value> = names
        .iter()
        .map(|n| {
            let d = defaults::raw(&format!("devswarm_sup.duty.{n}"));
            let ctx = tick::Ctx { home, root: Path::new(""), st, now, engine_pokes: true };
            json!({"duty": n, "kind": d.str_field("kind"), "gate": d.str_field("gate"), "notDue": tick::not_due(&ctx, d)})
        })
        .collect();
    let words = defaults::list("devswarm_sup.mode_words");
    json!({
        "mode": if owner == Owner::Engine { words.get(1) } else { words.first() },
        "nodeSupervisorRunning": super::node_running(home, now),
        "executors": defaults::list("devswarm_wire.act_kinds").iter().map(|k| ((*k).to_string(), json!(format!("{:?}", crate::dswire::executor(k)).to_lowercase()))).collect::<serde_json::Map<_, _>>(),
        "duties": duties,
    })
}

/// The `recover` verb.
pub fn recover(rest: &[String], env: &RequestEnv, runner: &dyn Runner) -> (Value, i32) {
    let flag = |name: &str| rest.iter().position(|a| a == name).and_then(|i| rest.get(i + 1)).cloned().unwrap_or_default();
    let Some((home, state_dir)) = paths() else {
        return (json!({"error": defaults::text("devswarm_wire.msg_inert")}), defaults::num("devswarm_wire.usage_exit") as i32);
    };
    let st = Settings::from_env(env);
    super::recover::run(
        &super::recover::Place { home: &home, root: &root_dir(), state_dir: &state_dir },
        &st,
        runner,
        &flag(defaults::text("devswarm_wire.id_flag")),
        &flag(defaults::text("devswarm_wire.request_flag")),
        now_ms(),
    )
}
