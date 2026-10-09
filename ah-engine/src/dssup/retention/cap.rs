//! `enforceArchiveCap` of `companion/lib/devswarm-retention.js`: keep the archive of tombstoned bodies under its size cap by
//! evicting whole month files, oldest month first. Evicting an archive file is the one step of retention that removes message
//! text for good, so it is held to the same bar as the tombstoning: the engine lists and orders the files itself, asks Node's own
//! function for the same list in a dry run (read only), and removes a file only when the two lists are identical; a disagreement,
//! or a witness that cannot run, removes nothing and is logged. The cap is off (0 MB) by default; only a user's own setting turns
//! it on.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable directory or file is skipped (Node: `try { ... } catch (_) { return/continue }`)
use super::apply::{Settings, log_event};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::fsx;
use crate::defaults;
use crate::meshw::idlock::devswarm_root;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// One archive month file.
#[derive(Debug, Clone, PartialEq)]
pub struct ArchFile {
    /// Absolute path.
    pub path: PathBuf,
    /// Path relative to the archive root.
    pub rel: String,
    /// Size.
    pub bytes: u64,
    /// The month that orders eviction (`yyyy-mm`).
    pub sort_key: String,
    /// `mtimeMs`.
    pub mtime_ms: f64,
}

/// The archive root under the DevSwarm state directory.
pub fn archive_root(home: &Path) -> PathBuf {
    devswarm_root(home).join(defaults::text("devswarm_sup.rt_archive_dir"))
}

fn month_of_mtime(ms: f64) -> String {
    let days = (ms.floor() as i64).div_euclid(defaults::num("devswarm_sup.rt_day_ms") as i64);
    let (y, m, _) = crate::checks::jsport::date::civil_from_days(days);
    format!("{y}-{m:02}")
}

/// `listArchiveFiles(home)`.
pub fn list(home: &Path) -> Vec<ArchFile> {
    let root = archive_root(home);
    let ext = defaults::text("devswarm_sup.rt_archive_ext");
    let re = regex::Regex::new(defaults::text("devswarm_sup.rt_cap_month_re")).ok();
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(d) = stack.pop() {
        let Some(names) = fsx::read_dir_names(&d.to_string_lossy()) else { continue };
        for (name, ft) in names {
            let p = d.join(&name);
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() && name.ends_with(ext) {
                let Ok(md) = std::fs::metadata(&p) else { continue };
                let mtime = fsx::mtime_ms(&md);
                let sort_key = re.as_ref().and_then(|r| r.captures(&name)).map_or_else(|| month_of_mtime(mtime), |c| c[1].to_string());
                let rel = p.strip_prefix(&root).map_or_else(|_| name.clone(), |r| r.to_string_lossy().into_owned());
                out.push(ArchFile { path: p, rel, bytes: md.len(), sort_key, mtime_ms: mtime });
            }
        }
    }
    out
}

/// What the cap would do.
#[derive(Debug, Clone, PartialEq)]
pub struct CapPlan {
    /// Bytes in the archive.
    pub total: u64,
    /// The cap in bytes.
    pub cap: f64,
    /// Files to evict, in order.
    pub removed: Vec<(String, u64)>,
    /// Bytes left after (`None` when nothing is over the cap).
    pub after: Option<u64>,
    /// The files to evict.
    pub files: Vec<ArchFile>,
}

/// The plan of `enforceArchiveCap`.
pub fn plan(home: &Path, s: &Settings) -> CapPlan {
    let mut files = list(home);
    let total: u64 = files.iter().map(|f| f.bytes).sum();
    let cap = s.archive_max_mb * defaults::num("devswarm_sup.rt_mb") as f64;
    let mut p = CapPlan { total, cap, removed: Vec::new(), after: None, files: Vec::new() };
    let capped = s.archive_max_mb > 0.0;
    if !capped || total as f64 <= cap {
        return p;
    }
    files.sort_by(|a, b| a.sort_key.as_bytes().cmp(b.sort_key.as_bytes()).then(a.mtime_ms.partial_cmp(&b.mtime_ms).unwrap_or(std::cmp::Ordering::Equal)));
    let mut cur = total;
    for f in files {
        if cur as f64 <= cap {
            break;
        }
        p.removed.push((f.rel.clone(), f.bytes));
        cur -= f.bytes;
        p.files.push(f);
    }
    p.after = Some(cur);
    p
}

impl CapPlan {
    /// The plan in Node's result shape (`dryRun` as given).
    pub fn json(&self, dry: bool) -> Value {
        let removed: Vec<Value> = self.removed.iter().map(|(f, b)| json!({"file": f, "bytes": b})).collect();
        let mut v = json!({"totalBytes": self.total, "capBytes": super::jnum(self.cap), "removed": removed, "dryRun": dry});
        if let Some(a) = self.after {
            v["totalBytesAfter"] = json!(a);
        }
        v
    }
}

impl CapPlan {
    /// The plan as an ordered object, in the key order `enforceArchiveCap` builds its result in.
    pub fn oval(&self, dry: bool) -> OVal {
        let removed = self.removed.iter().map(|(f, b)| OVal::Obj(vec![("file".into(), OVal::Str(f.clone())), ("bytes".into(), OVal::Num(*b as f64))])).collect();
        let mut v = vec![
            ("totalBytes".to_string(), OVal::Num(self.total as f64)),
            ("capBytes".to_string(), OVal::Num(self.cap)),
            ("removed".to_string(), OVal::Arr(removed)),
            ("dryRun".to_string(), OVal::Bool(dry)),
        ];
        if let Some(a) = self.after {
            v.push(("totalBytesAfter".to_string(), OVal::Num(a as f64)));
        }
        OVal::Obj(v)
    }
}

/// The part of Node's dry-run answer that is compared: the totals and the exact list.
pub fn same(p: &CapPlan, node: &Value) -> bool {
    let mine = p.json(true);
    mine["totalBytes"] == node["totalBytes"] && mine["capBytes"] == node["capBytes"] && mine["removed"] == node["removed"]
}

/// Evict `plan`'s files: each is re-checked (still a regular file of the planned size) and removed, with Node's log event.
/// Returns the files actually removed.
pub fn evict(home: &Path, p: &CapPlan) -> Vec<(String, u64)> {
    let mut done = Vec::new();
    for f in &p.files {
        let still = std::fs::symlink_metadata(&f.path).is_ok_and(|m| m.is_file() && m.len() == f.bytes);
        if !still {
            continue;
        }
        if std::fs::remove_file(&f.path).is_ok() {
            done.push((f.rel.clone(), f.bytes));
            log_event(
                home,
                &[
                    ("event", OVal::Str(defaults::text("devswarm_sup.rt_ev_archive_evict").into())),
                    ("file", OVal::Str(f.rel.clone())),
                    ("bytes", OVal::Num(f.bytes as f64)),
                    ("capBytes", OVal::Num(p.cap)),
                ],
            );
        }
    }
    done
}
