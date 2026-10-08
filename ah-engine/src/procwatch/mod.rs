//! Process watch: leftover processes of ended Claude sessions (the orphan sweep), agents with no output (the stuck-agent warning),
//! processes of live sessions using too much CPU or memory (the resource watch) and low free disk (the disk watch).
//!
//! The scheduled job [`run_job`] samples and sweeps, stops the orphans of classes in `kill` mode, measures free disk space,
//! records telemetry and writes a small report; the plugin script `engine/logic/procwatch-advisory.js` turns the report into one
//! advisory per event, with cooldowns (and the stuck agents of the current session come from the silent-agent-nudge check). Everything tunable is in `procwatch.toml`, `resource_watch.toml` and
//! `disk_watch.toml`; nothing here decides a number. Both the orphan sweep and the resource watch use the one process scan.

pub mod disk;
pub mod host;
pub mod orphan;
pub mod resource;
#[cfg(test)]
mod tests;

use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::get_bool;
use crate::defaults;
use crate::reqenv::RequestEnv;
use host::{Host, RealHost, env_get};
use orphan::{Cfg, Finding, Mode, Outcome};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

/// What the sweep keeps between runs.
#[derive(Default)]
pub struct Sweep {
    res: resource::State,
    last_orphan_s: u64,
    orphans: Vec<Finding>,
    known: HashSet<(u32, u64)>,
    kills: Vec<Value>,
    warns: Vec<(resource::Warn, String)>,
    sessions: HashMap<u32, String>,
    growth: Vec<(std::path::PathBuf, u64)>,
    growth_s: u64,
    disk_seen: HashMap<u64, (disk::Level, u64)>,
}

/// Where a telemetry record goes: (impact kind, check or class, reason).
pub type Rec<'a> = &'a dyn Fn(&str, &str, &str);

/// The engine's own pid and the pids above it, which are never signalled.
fn own_pids(rows: &[host::ProcRow]) -> HashSet<u32> {
    let table: HashMap<u32, u32> = rows.iter().map(|r| (r.pid, r.ppid)).collect();
    let mut out = HashSet::new();
    let mut cur = std::process::id();
    while cur > 1 && out.insert(cur) {
        match table.get(&cur) {
            Some(p) => cur = *p,
            None => break,
        }
    }
    out
}

fn finding_json(f: &Finding, chars: usize) -> Value {
    json!({"pid": f.pid, "ppid": f.ppid, "age_s": f.age_s, "class": f.class, "mode": f.mode.name(), "cmd": orphan::cut(&f.cmd, chars), "session": f.session_id, "reason": f.reason})
}

/// One run of the job against `host`. `state_dir` is where the report goes, `home` where settings are read.
pub fn run_with(host: &mut dyn Host, sw: &mut Sweep, state_dir: &Path, home: &str, rec: Rec<'_>) -> Result<String, String> {
    let st = Settings::from_env(&RequestEnv::from_pairs([("HOME", home)]));
    if !get_bool(&st, defaults::raw("procwatch.sw_enabled")) {
        return Ok("off".to_string());
    }
    let started = std::time::Instant::now();
    let Some(cfg) = Cfg::load(&st) else { return Err(defaults::text("procwatch.msg_bad_config").to_string()) };
    let rows = host.procs();
    let now = host.now_s();
    let chars = cfg.cmd_chars;
    let keep = defaults::num("resource_watch.keep_s");

    // ---- resource watch ----
    if resource::Limits::enabled(&st) {
        let lim = resource::Limits::load(&st);
        let mem = host.mem();
        let fresh = sw.res.sample(&rows, &mem, &cfg, &lim, now);
        let renice = get_bool(&st, defaults::raw("resource_watch.renice"));
        for w in fresh {
            rec(defaults::text("resource_watch.impact_kind"), "resource_watch", w.kind);
            if renice && w.pid > 0 && w.kind != "swap" {
                host.renice(w.pid, defaults::num("resource_watch.renice_value") as i32);
            }
            let sid = if w.session_pid > 0 {
                sw.sessions
                    .entry(w.session_pid)
                    .or_insert_with(|| {
                        host.environ(w.session_pid).and_then(|e| env_get(&e, defaults::text("procwatch.session_var")).map(str::to_string)).unwrap_or_default()
                    })
                    .clone()
            } else {
                String::new()
            };
            sw.warns.push((w, sid));
        }
        sw.warns.retain(|(w, _)| now.saturating_sub(w.ts_s) <= keep);
    }

    // ---- orphan sweep ----
    let mut scanned = false;
    if now.saturating_sub(sw.last_orphan_s) >= defaults::num("procwatch.scan_every_s") {
        scanned = true;
        sw.last_orphan_s = now;
        let own = own_pids(&rows);
        sw.orphans = orphan::classify(host, &rows, &cfg, &own);
        let live: HashSet<(u32, u64)> = sw.orphans.iter().map(|f| (f.pid, f.start_s)).collect();
        sw.known.retain(|k| live.contains(k));
        for f in &sw.orphans {
            if sw.known.insert((f.pid, f.start_s)) {
                rec(defaults::text("procwatch.impact_orphan"), &f.class, f.mode.name());
            }
        }
        sw.kills.clear();
        let mut done = 0usize;
        let todo: Vec<Finding> = sw.orphans.iter().filter(|f| f.mode == Mode::Kill).cloned().collect();
        for f in todo {
            if done >= cfg.max_kills {
                break;
            }
            let out = orphan::reap(host, &f, cfg.grace_ms);
            if out != Outcome::Gone {
                done += 1;
                rec(defaults::text("procwatch.impact_kill"), &f.class, if out == Outcome::Killed { "kill" } else { "term" });
            }
            sw.kills.push(json!({"ts_s": now, "pid": f.pid, "class": f.class, "cmd": orphan::cut(&f.cmd, chars), "outcome": match out { Outcome::Gone => "gone", Outcome::Terminated => "term", Outcome::Killed => "kill" }}));
        }
    }

    // ---- disk watch ----
    let mut disk_json = Value::Null;
    if disk::Floors::enabled(&st) {
        let floors = disk::Floors::load(&st);
        let mut paths = disk::watched_paths(None, home, defaults::env_var("tmpdir").as_deref());
        for r in rows.iter().filter(|r| cfg.is_session(&r.cmd)) {
            if let Some(c) = host.cwd(r.pid) {
                paths.push(c);
            }
        }
        let vols = disk::volumes(host, &paths, &floors);
        let worst = vols.iter().map(|v| v.level).max().unwrap_or(disk::Level::Ok);
        let cool = crate::checks::guardkit::settings::get_number(&st, defaults::raw("disk_watch.cooldown_s")) as u64;
        for v in vols.iter().filter(|v| v.level != disk::Level::Ok) {
            let again = sw.disk_seen.get(&v.space.dev).is_none_or(|(l, t)| *l != v.level || now.saturating_sub(*t) >= cool);
            if again {
                sw.disk_seen.insert(v.space.dev, (v.level, now));
                rec(defaults::text("disk_watch.impact_kind"), "disk_watch", v.level.name());
            }
        }
        sw.disk_seen.retain(|d, _| vols.iter().any(|v| v.space.dev == *d && v.level != disk::Level::Ok));
        if worst == disk::Level::Ok {
            sw.growth.clear();
        } else if now.saturating_sub(sw.growth_s) >= defaults::num("disk_watch.growth_every_s") {
            sw.growth = disk::growth(&paths);
            sw.growth_s = now;
        }
        let vj: Vec<Value> = vols
            .iter()
            .map(|v| json!({"path": v.path.to_string_lossy(), "dev": v.space.dev, "free": disk::human(v.space.free), "pct": format!("{:.0}", disk::pct_free(&v.space)), "level": v.level.name()}))
            .collect();
        let gj: Vec<Value> = sw.growth.iter().map(|(p, s)| json!({"path": p.to_string_lossy(), "size": disk::human(*s)})).collect();
        disk_json = json!({"volumes": vj, "growth": gj});
    }

    // ---- report ----
    let modes: serde_json::Map<String, Value> = cfg.classes.iter().map(|c| (c.name.clone(), json!(c.mode.name()))).collect();
    let listed: Vec<Value> = sw.orphans.iter().take(cfg.max_listed).map(|f| finding_json(f, chars)).collect();
    let warns: Vec<Value> = sw
        .warns
        .iter()
        .map(|(w, sid)| json!({"kind": w.kind, "pid": w.pid, "session_pid": w.session_pid, "session": sid, "name": w.name, "usage": w.usage, "limit": w.limit, "ts_s": w.ts_s}))
        .collect();
    let cost_ms = started.elapsed().as_millis() as u64;
    let report = json!({
        "ts_s": now, "procs": rows.len(), "cost_ms": cost_ms, "orphan_scan_s": sw.last_orphan_s, "scanned": scanned,
        "modes": modes,
        "orphans": {"count": sw.orphans.len(), "listed": listed},
        "kills": sw.kills,
        "resource": warns,
        "disk": disk_json,
    });
    let path = state_dir.join(defaults::text("procwatch.report_file"));
    crate::discard::logged("procwatch_report", std::fs::create_dir_all(state_dir));
    crate::discard::logged("procwatch_report", crate::atomic::write(&path, report.to_string()));
    Ok(json!({"procs": rows.len(), "orphans": sw.orphans.len(), "warnings": sw.warns.len(), "cost_ms": cost_ms}).to_string())
}

static WORKER: Mutex<Option<(RealHost, Sweep)>> = Mutex::new(None);

/// The scheduled job: the daemon calls this every `schedule.procwatch_ms`. The host and the sweep state live across runs (a CPU
/// rate needs two samples).
pub fn run_job(state_dir: &Path, home: &str, rec: Rec<'_>) -> Result<String, String> {
    let mut g = WORKER.lock().unwrap_or_else(|e| e.into_inner());
    let (host, sw) = g.get_or_insert_with(|| (RealHost::new(), Sweep::default()));
    run_with(host, sw, state_dir, home, rec)
}
