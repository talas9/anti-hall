//! The disk watch: free space of the volumes a Claude session writes to, two floors, and a bounded look for the biggest
//! build or cache directories as a suggestion. It never deletes or changes anything.

use super::host::{Host, Space};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::settings::{get_bool, get_number};
use crate::defaults;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn gb() -> f64 {
    defaults::num("disk_watch.bytes_per_gb") as f64
}

/// How low the space is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Above both floors.
    Ok,
    /// Below the warn floor.
    Warn,
    /// Below the critical floor.
    Critical,
}

impl Level {
    /// Report name.
    pub fn name(self) -> &'static str {
        match self {
            Level::Ok => "ok",
            Level::Warn => "warn",
            Level::Critical => "critical",
        }
    }
}

/// The floors in force. A floor of 0 is not used.
#[derive(Debug, Clone, Copy)]
pub struct Floors {
    /// Warn below this many GB.
    pub warn_gb: f64,
    /// Warn below this percent free.
    pub warn_pct: f64,
    /// Critical below this many GB.
    pub critical_gb: f64,
    /// Critical below this percent free.
    pub critical_pct: f64,
}

impl Floors {
    /// Read the floors (owner settings over the shipped defaults).
    pub fn load(st: &Settings) -> Floors {
        let n = |k: &str| get_number(st, defaults::raw(k));
        Floors {
            warn_gb: n("disk_watch.warn_gb"),
            warn_pct: n("disk_watch.warn_pct"),
            critical_gb: n("disk_watch.critical_gb"),
            critical_pct: n("disk_watch.critical_pct"),
        }
    }

    /// Is the watch on?
    pub fn enabled(st: &Settings) -> bool {
        get_bool(st, defaults::raw("disk_watch.sw_enabled"))
    }

    /// Is blocking at critical on?
    pub fn blocks(st: &Settings) -> bool {
        get_bool(st, defaults::raw("disk_watch.block_at_critical"))
    }

    /// The level of a volume.
    pub fn level(&self, s: &Space) -> Level {
        let free_gb = s.free as f64 / gb();
        let pct = pct_free(s);
        let below = |gb: f64, p: f64| (gb > 0.0 && free_gb < gb) || (p > 0.0 && pct < p);
        if below(self.critical_gb, self.critical_pct) {
            Level::Critical
        } else if below(self.warn_gb, self.warn_pct) {
            Level::Warn
        } else {
            Level::Ok
        }
    }
}

/// Percent of the volume that is free.
pub fn pct_free(s: &Space) -> f64 {
    if s.total == 0 {
        f64::from(defaults::num("disk_watch.percent_base") as u32)
    } else {
        s.free as f64 * defaults::num("disk_watch.percent_base") as f64 / s.total as f64
    }
}

/// One watched volume.
#[derive(Debug, Clone, PartialEq)]
pub struct Vol {
    /// A path on it (the first one given).
    pub path: PathBuf,
    /// Its space.
    pub space: Space,
    /// Its level.
    pub level: Level,
}

/// The volumes under `paths`, one per device, with their levels.
pub fn volumes(host: &dyn Host, paths: &[PathBuf], f: &Floors) -> Vec<Vol> {
    let mut out: Vec<Vol> = Vec::new();
    for p in paths {
        let Some(space) = host.space(p) else { continue };
        if out.iter().any(|v| v.space.dev == space.dev) {
            continue;
        }
        out.push(Vol { path: p.clone(), level: f.level(&space), space });
    }
    out
}

/// The paths a session writes to: its project directory, HOME and the temp directory.
pub fn watched_paths(cwd: Option<&str>, home: &str, tmp_env: Option<&str>) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(c) = cwd.filter(|c| !c.is_empty()) {
        v.push(PathBuf::from(c));
    }
    if !home.is_empty() {
        v.push(PathBuf::from(home));
    }
    v.push(PathBuf::from(tmp_env.filter(|t| !t.is_empty()).unwrap_or(defaults::text("disk_watch.temp_default"))));
    v
}

struct Budget {
    until: Instant,
    entries: usize,
}

impl Budget {
    fn spent(&mut self) -> bool {
        self.entries = self.entries.saturating_sub(1);
        self.entries == 0 || Instant::now() >= self.until
    }
}

/// Size of a directory tree, stopping when the budget is spent (the size is then a floor). Symlinks are not followed.
fn tree_size(dir: &Path, b: &mut Budget) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            if b.spent() {
                return total;
            }
            let Ok(m) = e.path().symlink_metadata() else { continue };
            if m.is_dir() {
                stack.push(e.path());
            } else if m.is_file() {
                total += std::os::unix::fs::MetadataExt::blocks(&m) * 512;
            }
        }
    }
    total
}

/// The biggest growth directories (build output, dependency and cache directories by name) under `roots`, biggest first,
/// within the configured entry and time budget.
pub fn growth(roots: &[PathBuf]) -> Vec<(PathBuf, u64)> {
    let names = defaults::list("disk_watch.growth_names");
    let depth = defaults::num("disk_watch.growth_depth") as usize;
    let min = defaults::num("disk_watch.growth_min_mb") * defaults::num("disk_watch.bytes_per_mb");
    let mut b = Budget {
        until: Instant::now() + Duration::from_millis(defaults::num("disk_watch.growth_budget_ms")),
        entries: defaults::num("disk_watch.growth_max_entries") as usize,
    };
    let mut found: Vec<(PathBuf, u64)> = Vec::new();
    for root in roots {
        let mut level = vec![root.clone()];
        for _ in 0..=depth {
            let mut next = Vec::new();
            for d in &level {
                let Ok(rd) = std::fs::read_dir(d) else { continue };
                for e in rd.flatten() {
                    if b.spent() {
                        return finish(found, min);
                    }
                    let Ok(m) = e.path().symlink_metadata() else { continue };
                    if !m.is_dir() {
                        continue;
                    }
                    let name = e.file_name().to_string_lossy().into_owned();
                    if names.contains(&name.as_str()) {
                        let size = tree_size(&e.path(), &mut b);
                        found.push((e.path(), size));
                    } else {
                        next.push(e.path());
                    }
                }
            }
            level = next;
        }
    }
    finish(found, min)
}

fn finish(mut found: Vec<(PathBuf, u64)>, min: u64) -> Vec<(PathBuf, u64)> {
    found.retain(|(_, s)| *s >= min);
    found.sort_by_key(|(_, s)| std::cmp::Reverse(*s));
    found.truncate(defaults::num("disk_watch.growth_top") as usize);
    found
}

/// Human size: `12.3 GB` / `640 MB`.
pub fn human(bytes: u64) -> String {
    let g = bytes as f64 / gb();
    if g >= 1.0 { format!("{g:.1} GB") } else { format!("{} MB", bytes / defaults::num("disk_watch.bytes_per_mb")) }
}
