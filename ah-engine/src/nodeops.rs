//! `ah-engine node`: the actions on a dashboard node, each one audited.
//!
//! * `agent request-progress|ping-heartbeat <session>`: through the tracker's reminder and wake route ([`crate::agents`]);
//! * `proc list|status|stop|restart`: the engine's own managed processes (the watchers, the web server), from one record per
//!   process under `<state>/procs/`. A process is acted on only by the pid it recorded, and only while that pid still has the
//!   start stamp and executable it recorded (the pid may have been reused); it is never found by name, and only SIGTERM is sent;
//! * `engine reload-config`: asks the running daemon to reload its configuration.
//!
//! `proc stop` and `proc restart` need `--confirm`. Every run, including a refused one, leaves a line in the action log
//! (`actions.file`) and an `act` telemetry event under `node.feature`. Every word and number is in `defaults/topology.toml`.
use crate::cli::Parsed;
use crate::telemetry::{emit, event::Outcome};
use crate::{actlog, client, defaults, health, paths, procid};
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn procs_dir() -> PathBuf {
    paths::dir().join(defaults::text("node.procs_dir"))
}

fn record_path(name: &str) -> PathBuf {
    procs_dir().join(format!("{}.json", actlog::token(name)))
}

fn read_record(name: &str) -> Option<Value> {
    std::fs::read_to_string(record_path(name)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn write_record(name: &str, kind: &str, pid: u32, argv: &[String]) {
    let rec = json!({"name": name, "kind": kind, "pid": pid, "start": procid::start(pid), "exe": procid::exe(pid).map(|p| p.display().to_string()),
        "argv": argv, "ts": health::now_ms()});
    crate::discard::logged("node_proc_record", std::fs::create_dir_all(procs_dir()));
    crate::discard::logged("node_proc_record", crate::atomic::write(record_path(name), rec.to_string()));
}

/// Record the running process as the managed process `name` (a watcher, the web server). `argv` is the command that starts it
/// again (empty when it can be stopped but not restarted from here). Records of processes that are gone and older than
/// `node.proc_keep_ms` are swept first.
pub fn register(name: &str, kind: &str, argv: &[String]) {
    sweep();
    write_record(name, kind, std::process::id(), argv);
}

/// Remove the records of managed processes that are gone and older than `node.proc_keep_ms` (the engine's own bookkeeping).
fn sweep() {
    let keep = defaults::num("node.proc_keep_ms");
    let now = health::now_ms();
    for e in std::fs::read_dir(procs_dir()).into_iter().flatten().flatten() {
        let Some(v) = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
        let old = now.saturating_sub(v["ts"].as_u64().unwrap_or(0)) > keep;
        if old && !running(&v) {
            crate::discard::logged("node_proc_sweep", std::fs::remove_file(e.path()));
        }
    }
}

/// The recorded process is alive and is the same generation (start stamp and executable unchanged).
fn running(rec: &Value) -> bool {
    let Some(pid) = rec["pid"].as_u64().map(|p| p as u32) else { return false };
    let same_start = rec["start"].as_u64().is_some() && procid::start(pid) == rec["start"].as_u64();
    let same_exe = rec["exe"].as_str().is_some_and(|e| procid::exe(pid).is_some_and(|p| p.display().to_string() == e));
    health::pid_alive(pid) && same_start && same_exe
}

fn view(rec: &Value) -> Value {
    json!({"name": rec["name"], "kind": rec["kind"], "pid": rec["pid"], "running": running(rec), "restartable": rec["argv"].as_array().is_some_and(|a| !a.is_empty()), "since_ms": rec["ts"]})
}

fn all_records() -> Vec<Value> {
    let mut v: Vec<Value> = std::fs::read_dir(procs_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()))
        .collect();
    v.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    v
}

/// SIGTERM the recorded process (never SIGKILL) and wait for it to go. `Ok(true)` once gone, `Ok(false)` when it was not running as recorded.
fn stop_recorded(name: &str, rec: &Value) -> Result<bool, String> {
    let pid = rec["pid"].as_u64().unwrap_or(0) as u32;
    if pid == std::process::id() {
        return Err(defaults::text("node.msg_self").to_string());
    }
    if !running(rec) {
        return Ok(false);
    }
    if !procid::signal_verified(pid, libc::SIGTERM, || running(rec)) {
        return Ok(false);
    }
    let (wait, poll) = (defaults::millis("node.stop_wait_ms"), defaults::millis("node.stop_poll_ms"));
    let t = Instant::now();
    while running(rec) {
        if t.elapsed() >= wait {
            return Err(defaults::render("node.msg_still_running", &[("name", &name), ("pid", &pid), ("ms", &(wait.as_millis()))]));
        }
        std::thread::sleep(poll.min(wait.saturating_sub(t.elapsed()).max(Duration::from_millis(1))));
    }
    Ok(true)
}

fn restart(name: &str, rec: &Value) -> Result<Value, String> {
    let argv: Vec<String> = rec["argv"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect();
    let Some((exe, args)) = argv.split_first() else { return Err(defaults::render("node.msg_no_restart", &[("name", &name)])) };
    let stopped = stop_recorded(name, rec)?;
    let child = std::process::Command::new(exe)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    let kind = rec["kind"].as_str().unwrap_or("");
    write_record(name, kind, child.id(), &argv);
    Ok(json!({"name": name, "stopped": stopped, "pid": child.id()}))
}

struct Args {
    kind: String,
    action: String,
    target: String,
    confirm: bool,
    text: Option<String>,
}

fn parse(p: &Parsed) -> Args {
    let (confirm_flag, text_flag) = (defaults::text("node.flag_confirm"), defaults::text("node.flag_text"));
    let (mut pos, mut text, mut it) = (Vec::new(), None, p.rest.iter());
    while let Some(a) = it.next() {
        if a == text_flag {
            text = it.next().cloned();
        } else if a != confirm_flag {
            pos.push(a.clone());
        }
    }
    let mut pos = pos.into_iter();
    Args {
        kind: pos.next().unwrap_or_default(),
        action: pos.next().unwrap_or_default(),
        target: pos.next().unwrap_or_default(),
        confirm: p.rest.iter().any(|a| a == confirm_flag),
        text,
    }
}

/// `Err((refused, why))`: refused (nothing attempted) or failed.
type Done = Result<Value, (bool, String)>;

fn refuse(why: String) -> Done {
    Err((true, why))
}

fn fail(why: String) -> Done {
    Err((false, why))
}

fn execute(a: &Args) -> Done {
    let known = |key: &str| defaults::list(key).contains(&a.action.as_str());
    let what = format!("{}:{}", a.kind, a.action);
    if defaults::list("node.destructive").contains(&what.as_str()) && !a.confirm {
        return refuse(defaults::render("node.msg_confirm", &[("what", &format!("{} {}", a.kind, a.action))]));
    }
    match a.kind.as_str() {
        "agent" if known("node.agent_actions") => {
            if a.target.is_empty() {
                return refuse(defaults::text("node.msg_no_session").to_string());
            }
            let r = if a.action == "request-progress" { crate::agents::request_progress(&a.target, a.text.as_deref()) } else { crate::agents::heartbeat(&a.target) };
            r.map_err(|e| (false, e))
        }
        "proc" if known("node.proc_actions") => match a.action.as_str() {
            "list" => Ok(json!({"processes": all_records().iter().map(view).collect::<Vec<_>>()})),
            action => {
                let Some(rec) = read_record(&a.target) else { return refuse(defaults::render("node.msg_no_proc", &[("name", &a.target)])) };
                match action {
                    "status" => Ok(view(&rec)),
                    "stop" => match stop_recorded(&a.target, &rec) {
                        Ok(true) => Ok(json!({"name": a.target, "stopped": true})),
                        Ok(false) => refuse(defaults::render("node.msg_gone", &[("name", &a.target), ("pid", &rec["pid"])])),
                        Err(e) => fail(e),
                    },
                    _ => restart(&a.target, &rec).map_err(|e| (false, e)),
                }
            }
        },
        "engine" if known("node.engine_actions") => match client::ctl("reload") {
            Some(r) => Ok(json!({"reply": r})),
            None => refuse(defaults::text("node.msg_no_daemon").to_string()),
        },
        _ => refuse(defaults::render("node.msg_unknown", &[("what", &format!("{} {}", a.kind, a.action))])),
    }
}

/// `ah-engine node <kind> <action> [target] [--confirm] [--text <t>] [--json]`.
pub fn run_cmd(p: &Parsed) -> i32 {
    let a = parse(p);
    if a.kind.is_empty() || !defaults::list("node.kinds").contains(&a.kind.as_str()) {
        println!("{}", if p.json { json!({"error": defaults::text("node.msg_usage")}).to_string() } else { defaults::text("node.msg_usage").to_string() });
        return 64;
    }
    let started = Instant::now();
    let done = execute(&a);
    let (outcome, label, reason) = match &done {
        Ok(_) => (Outcome::Allow, "ok", String::new()),
        Err((true, why)) => (Outcome::Block, "refused", why.clone()),
        Err((false, why)) => (Outcome::Error, "failed", why.clone()),
    };
    let (feature, action, target) = (defaults::text("node.feature"), actlog::token(&format!("{}-{}", a.kind, a.action)), actlog::token(&a.target));
    let ms = started.elapsed().as_millis() as u64;
    emit::act(&emit::ActRec { feature, action: &action, outcome, latency_ms: ms, target: &target, inputs: "", reason: &actlog::token(&reason), action_id: "" });
    actlog::record(&paths::dir(), &actlog::Action { feature, action: &action, target: &a.target, inputs: json!({"confirm": a.confirm}), outcome: label, reason: &reason, latency_ms: ms }, health::now_ms());
    let body = match done {
        Ok(v) => json!({"ok": true, "result": v}),
        Err((_, why)) => json!({"ok": false, "outcome": label, "error": why}),
    };
    println!("{}", if p.json { body.to_string() } else { serde_json::to_string_pretty(&body).unwrap_or_default() });
    i32::from(label != "ok")
}
