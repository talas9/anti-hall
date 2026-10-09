//! The delivery write-ahead log around the destructive `hivecontrol workspace monitor` read: `companion/lib/devswarm-read-wal.js`
//! in Rust, byte-compatible, so the engine continues a WAL the Node daemon left open and the Node tools (`doctor`, `inbox tick`)
//! read the engine's.
//!
//! One append-only NDJSON file per reader (`wal/monitor-<project key>.ndjson`): a `batch` record (the exact stdout, fsynced)
//! before anything parses it, then a `done` or `quarantine` record once it is imported. A batch without a closing record is
//! PENDING and is replayed before the next destructive read. Nothing here deletes: a full file with nothing pending is
//! RENAMED into `wal/archive/`; a spilled batch is renamed to `.absorbed`.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - a torn or unreadable line is skipped and never glues onto the next record (Node: `catch (_) { continue }`)
// - housekeeping (rotation) is best effort
use crate::defaults;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// An open (pending) batch.
#[derive(Debug, Clone, PartialEq)]
pub struct Open {
    /// The entry id.
    pub e: String,
    /// The exact stdout.
    pub raw: String,
    /// When it was captured.
    pub ts: Option<i64>,
    /// The reader's worktree, when recorded.
    pub worktree: Option<String>,
}

fn q(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

/// `walPath(home, kind, key)`: the key is made a safe file name.
pub fn wal_path(devswarm_root: &Path, kind: &str, key: &str) -> PathBuf {
    let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') { c } else { '_' }).collect();
    devswarm_root.join(defaults::text("devswarm_ingest.dir_wal")).join(format!("{kind}-{safe}{}", defaults::text("devswarm_ingest.wal_suffix")))
}

fn lacks_trailing_newline(file: &Path) -> bool {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(file) else { return false };
    let Ok(len) = f.metadata().map(|m| m.len()) else { return false };
    if len == 0 || f.seek(SeekFrom::Start(len - 1)).is_err() {
        return false;
    }
    f.bytes().next().is_some_and(|b| b.is_ok_and(|b| b != b'\n'))
}

/// Append and fsync. A torn last line gets a leading newline so the new record never glues onto it.
pub fn fsync_append(file: &Path, text: &str) -> std::io::Result<()> {
    if let Some(d) = file.parent() {
        std::fs::create_dir_all(d)?;
    }
    let lead = if lacks_trailing_newline(file) { "\n" } else { "" };
    let mut f = std::fs::OpenOptions::new().append(true).create(true).open(file)?;
    f.write_all(format!("{lead}{text}").as_bytes())?;
    f.sync_all()
}

fn rand8() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()));
    h.write_u64(SEQ.load(Ordering::Relaxed));
    let mut n = h.finish();
    let mut out = String::new();
    while out.len() < defaults::num("devswarm_ingest.entry_rand_len") as usize {
        out.push(char::from_digit((n % 36) as u32, 36).unwrap_or('0'));
        n /= 36;
        if n == 0 {
            n = 0x9e37_79b9_7f4a_7c15;
        }
    }
    out
}

/// A new entry id: `<now>-<pid>-<seq>-<random>`.
pub fn new_entry_id(now: i64) -> String {
    format!("{now}-{}-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed) + 1, rand8())
}

/// `appendBatch`: durable (fsynced) on return. `entry` reuses an id (an absorbed spill).
pub fn append_batch(file: &Path, raw: &str, now: i64, worktree: Option<&str>, entry: Option<&str>) -> std::io::Result<String> {
    let e = entry.map_or_else(|| new_entry_id(now), str::to_string);
    let wt = worktree.filter(|w| !w.is_empty()).map(|w| format!(",\"worktree\":{}", q(w))).unwrap_or_default();
    fsync_append(file, &format!("{{\"t\":\"batch\",\"e\":{},\"ts\":{now},\"raw\":{}{wt}}}\n", q(&e), q(raw)))?;
    Ok(e)
}

/// `closeBatch`: `kind` is `done` or `quarantine`; `extra` is the record's own fields as `"key":value` text.
pub fn close_batch(file: &Path, entry: &str, kind: &str, extra: &str, now: i64) -> std::io::Result<()> {
    let extra = if extra.is_empty() { String::new() } else { format!(",{extra}") };
    fsync_append(file, &format!("{{\"t\":{}{extra},\"e\":{},\"ts\":{now}}}\n", q(kind), q(entry)))
}

/// `pending`: open batches in file order. An absent file is none; an unreadable one is an error (an unknown WAL state must stop
/// new destructive reads, never read as "nothing pending").
pub fn pending(file: &Path) -> std::io::Result<Vec<Open>> {
    let text = match std::fs::read(file) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut order: Vec<String> = Vec::new();
    let mut batches: std::collections::HashMap<String, Open> = std::collections::HashMap::new();
    let mut closed: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in text.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        let Some(e) = rec["e"].as_str() else { continue };
        match rec["t"].as_str() {
            Some("batch") if rec["raw"].is_string() => {
                if !batches.contains_key(e) {
                    order.push(e.to_string());
                }
                batches.insert(
                    e.to_string(),
                    Open {
                        e: e.to_string(),
                        raw: rec["raw"].as_str().unwrap_or_default().to_string(),
                        ts: rec["ts"].as_i64(),
                        worktree: rec["worktree"].as_str().filter(|w| !w.is_empty()).map(str::to_string),
                    },
                );
            }
            Some("done" | "quarantine") => {
                closed.insert(e.to_string());
            }
            _ => {}
        }
    }
    Ok(order.into_iter().filter(|e| !closed.contains(e)).filter_map(|e| batches.remove(&e)).collect())
}

/// `writable`: `None` when the file can be appended and fsynced (no byte written), else the error text.
pub fn writable(file: &Path) -> Option<String> {
    let go = || -> std::io::Result<()> {
        if let Some(d) = file.parent() {
            std::fs::create_dir_all(d)?;
        }
        std::fs::OpenOptions::new().append(true).create(true).open(file)?.sync_all()
    };
    go().err().map(|e| e.to_string())
}

/// The spill directory of a WAL: `<devswarm>/wal-spill/<wal base name>`.
pub fn spill_dir(file: &Path) -> PathBuf {
    let root = file.parent().and_then(Path::parent).unwrap_or(Path::new(""));
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    root.join(defaults::text("devswarm_ingest.dir_wal_spill")).join(stem)
}

/// `preflight`: `None` when both the WAL and its spill destination can be written, else why not. Run before every destructive read.
pub fn preflight(file: &Path) -> Option<String> {
    if let Some(w) = writable(file) {
        return Some(format!("{}{w}", defaults::text("devswarm_ingest.wal_prefix_wal")));
    }
    writable(&spill_dir(file).join(defaults::text("devswarm_ingest.spill_probe"))).map(|w| format!("{}{w}", defaults::text("devswarm_ingest.wal_prefix_spill")))
}

/// What happened to bytes a destructive read returned.
#[derive(Debug, Clone, PartialEq)]
pub enum Capture {
    /// In the WAL as a pending batch: the reader is not blocked.
    Wal(String),
    /// The WAL was not writable; the bytes are in a spill file and the reader stays blocked.
    Spilled(PathBuf, String),
    /// Both failed; the bytes went to stderr and a last-resort file (when that worked), and the reader stays blocked.
    LastResort(Option<PathBuf>, String),
}

fn last_resort_prefix(file: &Path) -> String {
    let abs = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    let d = ring::digest::digest(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY, abs.to_string_lossy().as_bytes());
    let hex: String = d.as_ref().iter().map(|b| format!("{b:02x}")).collect();
    format!("{}{}-", defaults::text("devswarm_ingest.last_resort_prefix"), &hex[..defaults::num("devswarm_ingest.last_resort_hex") as usize])
}

fn write_new(path: &Path, body: &str) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(body.as_bytes())?;
    f.sync_all()
}

/// `captureRaw`: the one write path for bytes a destructive read just returned.
pub fn capture_raw(file: &Path, raw: &str, now: i64, worktree: Option<&str>) -> Capture {
    let mut why = match append_batch(file, raw, now, worktree, None) {
        Ok(e) => return Capture::Wal(e),
        Err(e) => e.to_string(),
    };
    let rec = |extra: &str| {
        format!("{{\"e\":{},\"ts\":{now},\"raw\":{},\"worktree\":{}{extra}}}", q(&new_entry_id(now)), q(raw), worktree.map_or("null".to_string(), q))
    };
    let dir = spill_dir(file);
    let spilled = std::fs::create_dir_all(&dir).and_then(|()| {
        let e = new_entry_id(now);
        let out = dir.join(format!("{e}{}", defaults::text("devswarm_ingest.json_suffix")));
        write_new(&out, &format!("{{\"e\":{},\"ts\":{now},\"raw\":{},\"worktree\":{}}}", q(&e), q(raw), worktree.map_or("null".to_string(), q))).map(|()| out)
    });
    match spilled {
        Ok(p) => return Capture::Spilled(p, why),
        Err(e) => why = format!("{why}; spill: {e}"),
    }
    eprintln!("{}", defaults::render("devswarm_ingest.msg_wal_both_failed", &[("file", &file.display()), ("err", &why), ("raw", &raw)]));
    let e = new_entry_id(now);
    let out = std::env::temp_dir().join(format!("{}{e}{}", last_resort_prefix(file), defaults::text("devswarm_ingest.json_suffix")));
    let abs = std::fs::canonicalize(file).unwrap_or_else(|_| file.to_path_buf());
    let body = rec(&format!(",\"wal\":{}", q(&abs.to_string_lossy())));
    match write_new(&out, &body) {
        Ok(()) => Capture::LastResort(Some(out), why),
        Err(e) => Capture::LastResort(None, format!("{why}; last-resort: {e}")),
    }
}

fn spill_pending(file: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(spill_dir(file))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.to_string_lossy().ends_with(defaults::text("devswarm_ingest.json_suffix")))
        .collect();
    out.sort();
    let pre = last_resort_prefix(file);
    let mut tmp: Vec<PathBuf> = std::fs::read_dir(std::env::temp_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name().to_string_lossy().into_owned();
            n.starts_with(&pre) && n.ends_with(defaults::text("devswarm_ingest.json_suffix"))
        })
        .map(|e| e.path())
        .collect();
    tmp.sort();
    out.extend(tmp);
    out
}

/// How many spilled batches (spill directory and last-resort files) wait to go back into the WAL.
pub fn spilled(file: &Path) -> usize {
    spill_pending(file).len()
}

/// `absorbSpill`: move each spilled batch back into the WAL as a pending batch (same entry id, so idempotent), then rename the
/// spill file to `.absorbed` (kept). Stops at the first failure: the reader stays blocked.
pub fn absorb_spill(file: &Path, now: i64) -> Result<usize, String> {
    let mut absorbed = 0;
    for p in spill_pending(file) {
        let go = || -> Result<(), String> {
            let rec: Value = serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
            let e = rec["e"].as_str().ok_or_else(|| defaults::text("devswarm_ingest.msg_spill_no_id").to_string())?;
            let already = std::fs::read_to_string(file)
                .unwrap_or_default()
                .split('\n')
                .any(|l| serde_json::from_str::<Value>(l).is_ok_and(|r| r["t"] == "batch" && r["e"] == e));
            if !already {
                append_batch(file, rec["raw"].as_str().unwrap_or_default(), rec["ts"].as_i64().unwrap_or(now), rec["worktree"].as_str(), Some(e))
                    .map_err(|e| e.to_string())?;
            }
            let mut to = p.clone().into_os_string();
            to.push(defaults::text("devswarm_ingest.absorbed_suffix"));
            std::fs::rename(&p, PathBuf::from(to)).map_err(|e| e.to_string())
        };
        go()?;
        absorbed += 1;
    }
    Ok(absorbed)
}

/// `adoptForWorktree`: open batches left by a PRIOR reader key of the same worktree. A foreign WAL is adopted only when EVERY
/// open batch in it names this worktree, and only by CLAIMING it first: an atomic rename into `wal/adopted/<self>/`. Files
/// claimed earlier that still hold open batches (an adopter that crashed mid-replay) are returned again.
pub fn adopt_for_worktree(devswarm_root: &Path, kind: &str, worktree: &str, self_file: &Path, now: i64) -> Vec<(PathBuf, Open)> {
    if worktree.is_empty() {
        return vec![];
    }
    let dir = devswarm_root.join(defaults::text("devswarm_ingest.dir_wal"));
    let stem = self_file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let adopted = dir.join(defaults::text("devswarm_ingest.dir_adopted")).join(&stem);
    let suffix = defaults::text("devswarm_ingest.wal_suffix");
    let mut names: Vec<String> = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for n in names {
        if !n.starts_with(&format!("{kind}-")) || !n.ends_with(suffix) {
            continue;
        }
        let file = dir.join(&n);
        if file == self_file {
            continue;
        }
        let Ok(open) = pending(&file) else { continue };
        if open.is_empty() || !open.iter().all(|b| b.worktree.as_deref() == Some(worktree)) {
            continue;
        }
        let base = n.trim_end_matches(suffix);
        let to = adopted.join(format!("{base}.{now}.{}{suffix}", std::process::id()));
        if std::fs::create_dir_all(&adopted).is_ok() {
            crate::discard::harmless(std::fs::rename(&file, to)); // keep: ENOENT means another adopter won the claim
        }
    }
    let mut claimed: Vec<PathBuf> =
        std::fs::read_dir(&adopted).into_iter().flatten().flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(suffix)).collect();
    claimed.sort();
    let mut out = Vec::new();
    for file in claimed {
        if let Ok(open) = pending(&file) {
            out.extend(open.into_iter().map(|b| (file.clone(), b)));
        }
    }
    out
}

/// `maybeRotate`: nothing pending and over the size threshold: RENAME into `wal/archive/` (never deleted).
pub fn maybe_rotate(file: &Path, now: i64) {
    let Ok(md) = std::fs::metadata(file) else { return };
    if md.len() < defaults::num("devswarm_ingest.wal_rotate_bytes") || pending(file).is_ok_and(|p| !p.is_empty()) {
        return;
    }
    let Some(dir) = file.parent().map(|d| d.join(defaults::text("devswarm_ingest.dir_archive"))) else { return };
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    if std::fs::create_dir_all(&dir).is_ok() {
        crate::discard::harmless(std::fs::rename(file, dir.join(format!("{stem}.{now}{}", defaults::text("devswarm_ingest.wal_suffix"))))); // keep: housekeeping only
    }
}
