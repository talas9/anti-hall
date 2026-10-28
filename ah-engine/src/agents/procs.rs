//! The process table, read on demand for the stall checks (the waste sensor's `stalled_call` and the lock-holder watchdog): who runs
//! under an agent, how much CPU a process tree used, who holds a lock file. The commands are config (`agent_stall.procs`); nothing is
//! read until a call or a lock is old enough to need it, so a healthy tick never spawns `ps`.
use crate::defaults;
use std::collections::BTreeMap;

/// One process of the table.
#[derive(Debug, Clone)]
pub(crate) struct Proc {
    pub pid: u32,
    pub ppid: u32,
    /// Instantaneous CPU, thousandths of a core.
    pub pcpu_pm: u64,
    /// Accumulated CPU time, ms.
    pub cpu_ms: u64,
    pub cmd: String,
}

fn argv(key: &str) -> Vec<&'static str> {
    defaults::raw("agent_stall.procs").get(key).map(defaults::V::strings).unwrap_or_default()
}

fn run(argv: &[&str], extra: Option<&str>) -> Option<String> {
    let (cmd, args) = argv.split_first()?;
    let mut c = std::process::Command::new(cmd);
    c.args(args).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if let Some(e) = extra {
        c.arg(e);
    }
    let o = c.output().ok()?;
    // lsof exits 1 when nothing matches: the output is what counts
    Some(String::from_utf8_lossy(&o.stdout).into_owned())
}

fn token(s: &str) -> Option<(&str, &str)> {
    let s = s.trim_start();
    match s.find(char::is_whitespace) {
        Some(e) => Some((&s[..e], s[e..].trim_start())),
        None if !s.is_empty() => Some((s, "")),
        None => None,
    }
}

/// `[dd-][hh:]mm:ss[.cc]` as ms.
fn parse_time(s: &str) -> Option<u64> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let mut secs = 0f64;
    for p in rest.split(':') {
        secs = secs * 60.0 + p.parse::<f64>().ok()?;
    }
    Some(days * 86_400_000 + (secs * 1000.0) as u64)
}

/// The whole process table (empty when `ps` cannot run).
pub(crate) fn snapshot() -> Vec<Proc> {
    let Some(out) = run(&argv("ps"), None) else { return Vec::new() };
    out.lines()
        .filter_map(|l| {
            let (pid, r) = token(l)?;
            let (ppid, r) = token(r)?;
            let (pcpu, r) = token(r)?;
            let (time, cmd) = token(r)?;
            Some(Proc {
                pid: pid.parse().ok()?,
                ppid: ppid.parse().ok()?,
                pcpu_pm: (pcpu.parse::<f64>().ok()? * 10.0) as u64,
                cpu_ms: parse_time(time)?,
                cmd: cmd.to_string(),
            })
        })
        .collect()
}

/// `root` and everything below it.
pub(crate) fn tree(procs: &[Proc], root: u32) -> Vec<&Proc> {
    let mut kids: BTreeMap<u32, Vec<&Proc>> = BTreeMap::new();
    for p in procs {
        kids.entry(p.ppid).or_default().push(p);
    }
    let mut out: Vec<&Proc> = procs.iter().filter(|p| p.pid == root).collect();
    let mut i = 0;
    while i < out.len() {
        let pid = out[i].pid;
        if let Some(k) = kids.get(&pid) {
            for c in k {
                if !out.iter().any(|o| o.pid == c.pid) {
                    out.push(c);
                }
            }
        }
        i += 1;
    }
    out
}

/// CPU of a tree: (accumulated ms, instantaneous thousandths of a core).
pub(crate) fn cpu_of(t: &[&Proc]) -> (u64, u64) {
    (t.iter().map(|p| p.cpu_ms).sum(), t.iter().map(|p| p.pcpu_pm).sum())
}

/// Whether a tree was idle since the baseline reading: `None` while the span is too short to trust. The accumulated-time rate is
/// used while the tree did not shrink (a child that exited takes its time with it), the instantaneous reading otherwise.
pub(crate) fn idle_since(base: (u64, u64), now: (u64, u64), now_ms: u64, min_span_ms: u64, idle_pm: u64) -> Option<bool> {
    let span = now_ms.saturating_sub(base.1);
    if span < min_span_ms.max(1) {
        return None;
    }
    Some(if now.0 >= base.0 { (now.0 - base.0) * 1000 / span <= idle_pm } else { now.1 <= idle_pm })
}

/// One process with the lock file open: pid, command, whether it holds the lock (not just waits for it).
#[derive(Debug, Clone)]
pub(crate) struct Opener {
    pub pid: u32,
    pub cmd: String,
    pub holds: bool,
}

/// Every process with `path` open, from the lsof field output.
pub(crate) fn openers(path: &str) -> Vec<Opener> {
    let Some(out) = run(&argv("lsof"), Some(path)) else { return Vec::new() };
    let held = defaults::raw("lock_watch.words").str_field("held");
    let (mut pid, mut cmd) = (0u32, String::new());
    let mut v: Vec<Opener> = Vec::new();
    for l in out.lines() {
        let (tag, val) = l.split_at(l.chars().next().map_or(0, char::len_utf8));
        match tag {
            "p" => pid = val.parse().unwrap_or(0),
            "c" => cmd = val.to_string(),
            "l" if pid != 0 => {
                let holds = val.chars().next().is_some_and(|c| held.contains(c));
                match v.iter_mut().find(|o| o.pid == pid) {
                    Some(o) => o.holds |= holds,
                    None => v.push(Opener { pid, cmd: cmd.clone(), holds }),
                }
            }
            _ => {}
        }
    }
    v
}
