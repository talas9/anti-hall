//! Dashboard action verbs that change or read one node, each one audited: `proc` (the engine family's processes, by pid) and the
//! audit shared with `agents send` ([`finish`]).
//!
//! A process is acted on only when its pid has a record under `<state>/procs/` (a process of the engine family registered itself
//! with [`register`], the wake watchers among them), the pid still has the start stamp and executable the record names (the pid may
//! have been reused), and it is not a Claude or Codex session. Only SIGTERM is sent, never SIGKILL, and nothing is found by name.
//! `stop` and `restart` need `--confirmed`. Every run, a refused one too, leaves a line in the action log and an `act` telemetry event.
use crate::cli::Parsed;
use crate::telemetry::{emit, event::Outcome};
use crate::{actlog, defaults, health, paths, procid};
use serde_json::{Value, json};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::time::Instant;

/// `Err((refused, why))`: refused (nothing attempted) or failed.
pub type Done = Result<Value, (bool, String)>;

fn refuse(why: String) -> Done {
    Err((true, why))
}

fn procs_dir() -> PathBuf {
    paths::dir().join(defaults::text("act.procs_dir"))
}

fn record_path(name: &str) -> PathBuf {
    procs_dir().join(format!("{}.json", actlog::token(name)))
}

fn write_record(name: &str, kind: &str, pid: u32, argv: &[String]) {
    let rec = json!({"name": name, "kind": kind, "pid": pid, "start": procid::start(pid), "exe": procid::exe(pid).map(|p| p.display().to_string()), "argv": argv, "ts": health::now_ms()});
    crate::discard::logged("act_proc_record", std::fs::create_dir_all(procs_dir()));
    crate::discard::logged("act_proc_record", crate::atomic::write(record_path(name), rec.to_string()));
}

/// Record the running process as the engine-family process `name` (a watcher, the web server). `argv` starts it again (empty when it
/// can be stopped but not restarted from here). Records of processes that are gone and older than `act.proc_keep_ms` are swept first.
pub fn register(name: &str, kind: &str, argv: &[String]) {
    let (keep, now) = (defaults::num("act.proc_keep_ms"), health::now_ms());
    for rec in records() {
        if now.saturating_sub(rec["ts"].as_u64().unwrap_or(0)) > keep && !running(&rec) {
            crate::discard::logged("act_proc_sweep", std::fs::remove_file(record_path(rec["name"].as_str().unwrap_or(""))));
        }
    }
    write_record(name, kind, std::process::id(), argv);
}

/// Record the process `pid`, started by this one, as the engine-family process `name` (the web server, which cannot write its own
/// record: it is a separate binary). `argv` starts it again.
pub fn register_pid(name: &str, kind: &str, pid: u32, argv: &[String]) {
    write_record(name, kind, pid, argv);
}

fn records() -> Vec<Value> {
    let mut v: Vec<Value> = std::fs::read_dir(procs_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()))
        .collect();
    v.sort_by(|a, b| a["pid"].as_u64().cmp(&b["pid"].as_u64()));
    v
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

/// SIGTERM the recorded process and wait for it to go. `Ok(true)` once gone, `Ok(false)` when it was not running as recorded.
fn stop_recorded(rec: &Value) -> Result<bool, String> {
    let (pid, name) = (rec["pid"].as_u64().unwrap_or(0) as u32, rec["name"].as_str().unwrap_or(""));
    if pid == std::process::id() {
        return Err(defaults::text("act.msg_self").to_string());
    }
    if !running(rec) || !procid::signal_verified(pid, libc::SIGTERM, || running(rec)) {
        return Ok(false);
    }
    let (wait, poll) = (defaults::millis("act.stop_wait_ms"), defaults::millis("act.stop_poll_ms"));
    let t = Instant::now();
    while running(rec) {
        if t.elapsed() >= wait {
            return Err(defaults::render("act.msg_still_running", &[("name", &name), ("pid", &pid), ("ms", &wait.as_millis())]));
        }
        std::thread::sleep(poll.min(wait.saturating_sub(t.elapsed()).max(defaults::millis("act.stop_poll_floor_ms"))));
    }
    Ok(true)
}

fn restart(rec: &Value) -> Result<Value, String> {
    let name = rec["name"].as_str().unwrap_or("");
    let argv: Vec<String> = rec["argv"].as_array().into_iter().flatten().filter_map(|a| a.as_str().map(str::to_string)).collect();
    let Some((exe, args)) = argv.split_first() else { return Err(defaults::render("act.msg_no_restart", &[("name", &name)])) };
    let stopped = stop_recorded(rec)?;
    let child = std::process::Command::new(exe)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| e.to_string())?;
    write_record(name, rec["kind"].as_str().unwrap_or(""), child.id(), &argv);
    Ok(json!({"name": name, "stopped": stopped, "pid": child.id()}))
}

fn execute(action: &str, pid: Option<u32>, confirmed: bool) -> Done {
    if action == "list" {
        return Ok(json!({"processes": records().iter().map(view).collect::<Vec<_>>()}));
    }
    if !defaults::list("act.proc_actions").contains(&action) {
        return refuse(defaults::render("act.msg_unknown", &[("what", &action)]));
    }
    let Some(pid) = pid else { return refuse(defaults::text("act.msg_bad_pid").to_string()) };
    if action != "status" && !confirmed {
        return refuse(defaults::render("act.msg_confirm", &[("what", &format!("proc {action}"))]));
    }
    if crate::agents::session_pids().contains(&pid) {
        return refuse(defaults::render("act.msg_session", &[("pid", &pid)]));
    }
    let Some(rec) = records().into_iter().find(|r| r["pid"].as_u64() == Some(u64::from(pid))) else {
        return refuse(defaults::render("act.msg_not_family", &[("pid", &pid)]));
    };
    match action {
        "status" => Ok(view(&rec)),
        "stop" => match stop_recorded(&rec) {
            Ok(true) => Ok(json!({"name": rec["name"], "pid": pid, "stopped": true})),
            Ok(false) => refuse(defaults::render("act.msg_gone", &[("name", &rec["name"].as_str().unwrap_or("")), ("pid", &pid)])),
            Err(e) => Err((false, e)),
        },
        _ => restart(&rec).map_err(|e| (false, e)),
    }
}

/// Audit one finished action (the action log and an `act` telemetry event), print it, and return the exit code.
pub fn finish(p: &Parsed, kind: &str, action: &str, target: &str, confirmed: bool, done: Done) -> i32 {
    audit(kind, action, target, confirmed, &done, 0);
    let body = match done {
        Ok(v) => json!({"ok": true, "result": v}),
        Err((refused, why)) => json!({"ok": false, "outcome": if refused { "refused" } else { "failed" }, "error": why}),
    };
    println!("{}", if p.json { body.to_string() } else { serde_json::to_string_pretty(&body).unwrap_or_default() });
    i32::from(body["ok"] != json!(true))
}

fn audit(kind: &str, action: &str, target: &str, confirmed: bool, done: &Done, ms: u64) {
    let (outcome, label, reason) = match done {
        Ok(_) => (Outcome::Allow, "ok", String::new()),
        Err((true, why)) => (Outcome::Block, "refused", why.clone()),
        Err((false, why)) => (Outcome::Error, "failed", why.clone()),
    };
    let (feature, act) = (defaults::text("act.feature"), actlog::token(&format!("{kind}-{action}")));
    emit::act(&emit::ActRec { feature, action: &act, outcome, latency_ms: ms, target: &actlog::token(target), inputs: "", reason: &actlog::token(&reason), action_id: "" });
    actlog::record(&paths::dir(), &actlog::Action { feature, action: &act, target, inputs: json!({"confirmed": confirmed}), outcome: label, reason: &reason, latency_ms: ms }, health::now_ms());
}

/// `ah-engine proc <list|status|stop|restart> [<pid>] [--confirmed] [--json]`.
pub fn run_proc(p: &Parsed) -> i32 {
    let action = p.rest.first().map(String::as_str).unwrap_or("");
    if action.is_empty() {
        println!("{}", defaults::text("act.msg_proc_usage"));
        return 64;
    }
    let pid = p.rest.get(1).and_then(|a| a.parse::<u32>().ok());
    let confirmed = p.rest.iter().any(|a| a == defaults::text("act.flag_confirmed"));
    let done = execute(action, pid, confirmed);
    finish(p, "proc", action, &pid.map(|p| p.to_string()).unwrap_or_default(), confirmed, done)
}
