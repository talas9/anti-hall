//! Leaked Codex companion broker trees: an orphaned `app-server-broker.mjs serve` (parent 1) with the `codex app-server` child and
//! every `node_repl` process that child started. A tree is a leak when its broker is an orphan, no Codex job is queued or running
//! for its workspace, and it has too many descendants, too much memory or is too old. A job state that cannot be read counts as an
//! active job (report only). The stop, when the owner turns it on, names the pids of one tree (descendants first); it never matches
//! by pattern. Every pattern, limit and text is in `procwatch.toml`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable job state is "a job may be running" (fail-open: nothing is stopped), never an absent state

use super::host::{Host, ProcRow};
use super::orphan::{Finding, Mode, Outcome, cut};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::get_enum;
use crate::defaults;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// The check's configuration.
pub struct Cfg {
    /// What a leak does.
    pub mode: Mode,
    broker: Regex,
    cwd: Regex,
    min_children: usize,
    min_mem: u64,
    min_age_s: u64,
    /// The most pids one sweep stops.
    pub max_kills: usize,
    /// The most trees one report lists.
    pub max_listed: usize,
    max_pids: usize,
}

impl Cfg {
    /// Read the configuration; `None` when a pattern does not compile (the check is skipped, reported through `discard`).
    pub fn load(st: &Settings) -> Option<Cfg> {
        let mode = match get_enum(st, defaults::raw("procwatch.mode_broker_leak")).as_str() {
            "kill" => Mode::Kill,
            "off" => Mode::Off,
            _ => Mode::Report,
        };
        let compile = |key: &str| match Regex::new(defaults::text(key)) {
            Ok(r) => Some(r),
            Err(e) => {
                crate::discard::note("procwatch_bad_pattern", &format!("{key}: {e}"));
                None
            }
        };
        Some(Cfg {
            mode,
            broker: compile("procwatch.broker_re")?,
            cwd: compile("procwatch.broker_cwd_re")?,
            min_children: defaults::num("procwatch.broker_min_children") as usize,
            min_mem: defaults::num("procwatch.broker_min_mem_mb").saturating_mul(defaults::num("disk_watch.bytes_per_mb")),
            min_age_s: defaults::num("procwatch.broker_min_age_s"),
            max_kills: defaults::num("procwatch.broker_max_kills_per_run") as usize,
            max_listed: defaults::num("procwatch.broker_max_listed") as usize,
            max_pids: defaults::num("procwatch.broker_max_pids") as usize,
        })
    }
}

/// One leaked tree.
#[derive(Debug, Clone, PartialEq)]
pub struct Leak {
    /// The broker.
    pub broker: Finding,
    /// Its descendants, deepest first (the order they are stopped in).
    pub kids: Vec<Finding>,
    /// The workspace the broker serves.
    pub cwd: String,
    /// Memory of the whole tree, bytes.
    pub mem: u64,
}

impl Leak {
    /// The pids of the tree in stop order: descendants first, the broker last.
    pub fn pids(&self) -> Vec<u32> {
        self.kids.iter().map(|k| k.pid).chain(std::iter::once(self.broker.pid)).collect()
    }

    /// The report entry: count, memory, age and the exact stop command.
    pub fn json(&self, chars: usize, cfg: &Cfg) -> serde_json::Value {
        let pids = self.pids();
        let cut_at = pids.len() > cfg.max_pids;
        let list: Vec<String> = pids.iter().take(cfg.max_pids).map(u32::to_string).collect();
        let mut cmd = defaults::text("procwatch.broker_kill_cmd").replace("{pids}", &list.join(" "));
        if cut_at {
            cmd.push_str(&defaults::text("procwatch.msg_broker_cut").replace("{max}", &cfg.max_pids.to_string()));
        }
        serde_json::json!({
            "pid": self.broker.pid, "cwd": self.cwd, "children": self.kids.len(), "mem_bytes": self.mem,
            "mem": super::disk::human(self.mem), "age_s": self.broker.age_s, "cmd": cut(&self.broker.cmd, chars),
            "stop_cmd": cmd, "pids": pids, "mode": self.broker.mode.name(),
        })
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Does a Codex job run, or wait, in `workspace`? Unknown is yes: no workspace, no plugin data directory, a state file that is
/// there but does not parse.
pub fn job_active(home: &str, workspace: &str) -> bool {
    if workspace.is_empty() || home.is_empty() {
        return true;
    }
    let Ok(dirs) = Regex::new(defaults::text("procwatch.broker_state_dir_re")) else { return true };
    let parent = Path::new(home).join(defaults::text("procwatch.broker_state_parent"));
    let Ok(rd) = std::fs::read_dir(&parent) else { return true };
    let (folder, file) = (defaults::text("procwatch.broker_state_folder"), defaults::text("procwatch.broker_state_file"));
    let active = defaults::list("procwatch.broker_active_statuses");
    let (f_jobs, f_status, f_ws) =
        (defaults::text("procwatch.broker_f_jobs"), defaults::text("procwatch.broker_f_status"), defaults::text("procwatch.broker_f_workspace"));
    let mut found_root = false;
    for d in rd.flatten().filter(|d| dirs.is_match(&d.file_name().to_string_lossy())) {
        let Ok(spaces) = std::fs::read_dir(d.path().join(folder)) else { continue };
        found_root = true;
        for s in spaces.flatten() {
            let sf = s.path().join(file);
            if !sf.exists() {
                continue;
            }
            let Some(v) = read_json(&sf) else { return true };
            for j in v.get(f_jobs).and_then(|j| j.as_array()).map(Vec::as_slice).unwrap_or(&[]) {
                let on = j.get(f_status).and_then(|x| x.as_str()).is_some_and(|x| active.contains(&x));
                let ws = j.get(f_ws).and_then(|x| x.as_str()).unwrap_or("");
                if on && (ws.is_empty() || ws == workspace || workspace.starts_with(&format!("{}/", ws.trim_end_matches('/')))) {
                    return true;
                }
            }
        }
    }
    !found_root
}

fn workspace(host: &mut dyn Host, cfg: &Cfg, row: &ProcRow) -> String {
    match cfg.cwd.captures(&row.cmd).and_then(|c| c.get(1)) {
        Some(m) => m.as_str().to_string(),
        None => host.cwd(row.pid).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
    }
}

fn finding(row: &ProcRow, now: u64, mode: Mode, reason: String) -> Finding {
    Finding {
        pid: row.pid,
        ppid: row.ppid,
        start_s: row.start_s,
        age_s: now.saturating_sub(row.start_s),
        class: "broker_leak".to_string(),
        mode,
        cmd: row.cmd.clone(),
        session_id: String::new(),
        reason,
    }
}

/// The leaked trees among `rows`. `own` are the pids the engine must never touch.
pub fn scan(host: &mut dyn Host, rows: &[ProcRow], cfg: &Cfg, home: &str, own: &HashSet<u32>) -> Vec<Leak> {
    if cfg.mode == Mode::Off {
        return Vec::new();
    }
    let now = host.now_s();
    let floor = defaults::num("procwatch.protect_pids_below") as u32;
    let mut kids: HashMap<u32, Vec<&ProcRow>> = HashMap::new();
    for r in rows {
        kids.entry(r.ppid).or_default().push(r);
    }
    let mut out = Vec::new();
    for b in rows.iter().filter(|r| r.ppid == 1 && r.pid >= floor && !own.contains(&r.pid) && cfg.broker.is_match(&r.cmd)) {
        // the descendants, parents before children; stopped in reverse
        let mut order: Vec<&ProcRow> = Vec::new();
        let mut seen: HashSet<u32> = HashSet::from([b.pid]);
        let mut stack = vec![b.pid];
        while let Some(p) = stack.pop() {
            for k in kids.get(&p).map(Vec::as_slice).unwrap_or(&[]) {
                if k.pid >= floor && !own.contains(&k.pid) && seen.insert(k.pid) {
                    order.push(k);
                    stack.push(k.pid);
                }
            }
        }
        let mem = b.mem_bytes + order.iter().map(|k| k.mem_bytes).sum::<u64>();
        let age = now.saturating_sub(b.start_s);
        let over = order.len() > cfg.min_children || mem > cfg.min_mem || age > cfg.min_age_s;
        if !over {
            continue;
        }
        let ws = workspace(host, cfg, b);
        if job_active(home, &ws) {
            continue;
        }
        let kids_f: Vec<Finding> = order.iter().rev().map(|k| finding(k, now, cfg.mode, format!("child_of:{}", b.pid))).collect();
        out.push(Leak { broker: finding(b, now, cfg.mode, "orphan_broker".to_string()), kids: kids_f, cwd: ws, mem });
    }
    out.sort_by(|a, b| b.mem.cmp(&a.mem).then(a.broker.pid.cmp(&b.broker.pid)));
    out
}

/// Stop exactly the pids of one tree, descendants first. Each pid is re-read and signalled only while it is still the process
/// listed (same start time and command); the polite signal goes to every pid, one grace period is waited for the whole tree, then
/// the forced signal goes to those still there. None when a job started in the workspace since the scan. At most `budget` pids.
pub fn stop(host: &mut dyn Host, leak: &Leak, home: &str, grace_ms: u64, budget: usize) -> Vec<(Finding, Outcome)> {
    if job_active(home, &leak.cwd) {
        return Vec::new();
    }
    let same = |r: &ProcRow, f: &Finding| r.start_s == f.start_s && r.cmd == f.cmd;
    let mut res: Vec<(Finding, Outcome)> = Vec::new();
    let mut termed: Vec<usize> = Vec::new();
    for f in leak.kids.iter().chain(std::iter::once(&leak.broker)).take(budget) {
        let alive = host.proc_row(f.pid).is_some_and(|r| same(&r, f));
        if alive && host.signal(f.pid, false) {
            termed.push(res.len());
            res.push((f.clone(), Outcome::Terminated));
        } else {
            res.push((f.clone(), Outcome::Gone));
        }
    }
    if !termed.is_empty() {
        host.sleep_ms(grace_ms);
        for i in termed {
            let f = res[i].0.clone();
            if host.proc_row(f.pid).is_some_and(|r| same(&r, &f)) && host.signal(f.pid, true) {
                res[i].1 = Outcome::Killed;
            }
        }
    }
    res
}
