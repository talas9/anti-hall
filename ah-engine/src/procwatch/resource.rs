//! The resource watch: processes of LIVE Claude sessions that use too much CPU or memory, and system swap and memory pressure.
//! Warn only; the only action it has is an opt-in renice. Thresholds, windows and cooldowns are in `resource_watch.toml`.
//!
//! A process belongs to a live session when its parent chain reaches a session process; the session process itself is not
//! measured. The first reading of a process is ignored (a CPU rate needs two samples).

use super::host::{MemInfo, Pressure, ProcRow};
use super::orphan::Cfg;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::defaults;
use std::collections::{HashMap, HashSet};

/// The thresholds in force.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Per-core CPU percent.
    pub cpu_pct: f64,
    /// Seconds the CPU reading must hold.
    pub window_s: u64,
    /// Memory, MB.
    pub mem_mb: u64,
    /// Swap in use, MB (0 = off).
    pub swap_mb: u64,
    /// Linux PSI percent (0 = off).
    pub psi_pct: f64,
    /// macOS pressure level (0 = off).
    pub mac_level: u32,
    /// Cooldown.
    pub cooldown_s: u64,
}

impl Limits {
    /// Read the thresholds (owner settings over the shipped defaults).
    pub fn load(st: &Settings) -> Limits {
        let n = |k: &str| get_number(st, defaults::raw(k));
        Limits {
            cpu_pct: n("resource_watch.cpu_pct"),
            window_s: n("resource_watch.cpu_window_s") as u64,
            mem_mb: n("resource_watch.mem_mb") as u64,
            swap_mb: n("resource_watch.swap_mb") as u64,
            psi_pct: n("resource_watch.psi_pct"),
            mac_level: n("resource_watch.mac_pressure_level") as u32,
            cooldown_s: n("resource_watch.cooldown_s") as u64,
        }
    }

    /// Is the watch switched on?
    pub fn enabled(st: &Settings) -> bool {
        get_bool(st, defaults::raw("resource_watch.sw_enabled"))
    }
}

/// One warning.
#[derive(Debug, Clone, PartialEq)]
pub struct Warn {
    /// `cpu`, `memory`, `swap` or `pressure`.
    pub kind: &'static str,
    /// The process (0 for a system warning).
    pub pid: u32,
    /// Its session process (0 for a system warning: every session is told).
    pub session_pid: u32,
    /// Program name.
    pub name: String,
    /// What it uses, ready to read.
    pub usage: String,
    /// The threshold, ready to read.
    pub limit: String,
    /// When the warning was made (seconds).
    pub ts_s: u64,
}

/// What the watch remembers between sweeps.
#[derive(Default)]
pub struct State {
    hist: HashMap<u32, Vec<(u64, f32)>>,
    seen: HashSet<u32>,
    last: HashMap<String, u64>,
}

fn base_name(cmd: &str) -> String {
    let first = cmd.split_whitespace().next().unwrap_or(cmd);
    first.rsplit('/').next().unwrap_or(first).to_string()
}

fn render(key: &str, args: &[(&str, &str)]) -> String {
    crate::checks::guardkit::msg::render(key, args)
}

impl State {
    fn due(&mut self, key: String, now: u64, cooldown: u64) -> bool {
        if self.last.get(&key).is_some_and(|t| now.saturating_sub(*t) < cooldown) {
            return false;
        }
        self.last.insert(key, now);
        true
    }

    /// One sweep. `rows` is the fresh process table, `mem` the system facts; returns the warnings that are due (each respects its
    /// cooldown).
    pub fn sample(&mut self, rows: &[ProcRow], mem: &MemInfo, cfg: &Cfg, lim: &Limits, now: u64) -> Vec<Warn> {
        let table: HashMap<u32, &ProcRow> = rows.iter().map(|r| (r.pid, r)).collect();
        let max_tracked = defaults::num("resource_watch.max_tracked") as usize;
        let cover = defaults::num("resource_watch.window_cover_pct");
        let mut measured: Vec<(&ProcRow, u32)> = Vec::new();
        for r in rows {
            if cfg.is_session(&r.cmd) {
                continue;
            }
            if let Some(s) = session_of(cfg, &table, r) {
                measured.push((r, s));
            }
        }
        // the busiest first, so the table bound drops the idle ones
        measured.sort_by(|a, b| b.0.cpu_pct.partial_cmp(&a.0.cpu_pct).unwrap_or(std::cmp::Ordering::Equal));
        measured.truncate(max_tracked);
        let live: HashSet<u32> = measured.iter().map(|(r, _)| r.pid).collect();
        self.hist.retain(|p, _| live.contains(p));
        self.seen.retain(|p| live.contains(p));
        let mut out = Vec::new();
        for (r, session) in &measured {
            let first = self.seen.insert(r.pid);
            if !first {
                let h = self.hist.entry(r.pid).or_default();
                h.push((now, r.cpu_pct));
                h.retain(|(t, _)| now.saturating_sub(*t) <= lim.window_s);
                let span = h.first().map_or(0, |(t, _)| now.saturating_sub(*t));
                if h.len() >= 2
                    && span * defaults::num("resource_watch.percent_base") >= lim.window_s * cover
                    && h.iter().all(|(_, c)| f64::from(*c) >= lim.cpu_pct)
                {
                    let avg = h.iter().map(|(_, c)| f64::from(*c)).sum::<f64>() / h.len() as f64;
                    if self.due(format!("cpu:{}:{}", r.pid, r.start_s), now, lim.cooldown_s) {
                        let (pct, win) = (format!("{avg:.0}"), lim.window_s.to_string());
                        out.push(Warn {
                            kind: "cpu",
                            pid: r.pid,
                            session_pid: *session,
                            name: base_name(&r.cmd),
                            usage: render("resource_watch.msg_cpu_usage", &[("pct", &pct), ("window", &win)]),
                            limit: render("resource_watch.msg_cpu_limit", &[("pct", &format!("{:.0}", lim.cpu_pct)), ("window", &win)]),
                            ts_s: now,
                        });
                    }
                }
            }
            let mb = r.mem_bytes / defaults::num("resource_watch.bytes_per_mb");
            if mb >= lim.mem_mb && self.due(format!("mem:{}:{}", r.pid, r.start_s), now, lim.cooldown_s) {
                out.push(Warn {
                    kind: "memory",
                    pid: r.pid,
                    session_pid: *session,
                    name: base_name(&r.cmd),
                    usage: render("resource_watch.msg_mem_usage", &[("mb", &mb.to_string())]),
                    limit: render("resource_watch.msg_mem_limit", &[("mb", &lim.mem_mb.to_string())]),
                    ts_s: now,
                });
            }
        }
        // system warnings reach every session
        let swap_mb = mem.swap_used / defaults::num("resource_watch.bytes_per_mb");
        if lim.swap_mb > 0 && swap_mb >= lim.swap_mb && self.due("swap".into(), now, lim.cooldown_s) {
            out.push(Warn { kind: "swap", pid: 0, session_pid: 0, name: String::new(), usage: swap_mb.to_string(), limit: lim.swap_mb.to_string(), ts_s: now });
        }
        let pressure = match mem.pressure {
            Pressure::Psi(p) if lim.psi_pct > 0.0 && p >= lim.psi_pct => Some((format!("PSI {p:.0}%"), format!("{:.0}%", lim.psi_pct))),
            Pressure::MacLevel(l) if lim.mac_level > 0 && l >= lim.mac_level => Some((format!("level {l}"), format!("level {}", lim.mac_level))),
            _ => None,
        };
        if let Some((value, limit)) = pressure
            && self.due("pressure".into(), now, lim.cooldown_s)
        {
            out.push(Warn { kind: "pressure", pid: 0, session_pid: 0, name: String::new(), usage: value, limit, ts_s: now });
        }
        out
    }
}

/// The nearest ancestor that is a live Claude session process.
fn session_of(cfg: &Cfg, table: &HashMap<u32, &ProcRow>, row: &ProcRow) -> Option<u32> {
    let mut seen = HashSet::new();
    let mut cur = row.ppid;
    while cur > 1 && seen.insert(cur) {
        let p = table.get(&cur)?;
        if cfg.is_session(&p.cmd) {
            return Some(cur);
        }
        cur = p.ppid;
    }
    None
}

/// The one line a warning is shown as.
pub fn line(w: &Warn) -> String {
    match w.kind {
        "swap" => render("resource_watch.msg_swap", &[("used", &w.usage), ("limit", &w.limit)]),
        "pressure" => render("resource_watch.msg_pressure", &[("value", &w.usage), ("limit", &w.limit)]),
        _ => render(
            "resource_watch.msg_proc_what",
            &[("name", &w.name), ("pid", &w.pid.to_string()), ("session", &w.session_pid.to_string()), ("usage", &w.usage), ("limit", &w.limit)],
        ),
    }
}
