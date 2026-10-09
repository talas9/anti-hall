//! `foldLegacyJournal` of `companion/lib/devswarm-retention.js`: a store that moved to sqlite and whose merge of the old journal
//! is complete has its raw `journal/*.ndjson` compressed into `archive/<store>/legacy-journal/`, and the raw file removed only
//! after the compressed copy is written, synced and proven to decompress to the same bytes.
//!
//! Whether a journal is safe to fold is Node's merge check (`mergeSplitBackendStore`, a dry run), which stays Node's. The
//! engine therefore asks Node's own `foldLegacyJournal` in a dry run (read only) and folds only when that says the store is
//! eligible AND names exactly the files, sizes and destinations the engine computed itself; anything else folds nothing and is
//! logged. Stricter than Node: a file that grew or was touched after it was read is not removed (its archive copy is kept).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable journal directory is "no journal" (Node: `try { names = readdirSync } catch { names = [] }`)
use super::apply::{fsync_dir, log_event};
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::fsx;
use crate::defaults;
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};

/// One journal file to fold.
#[derive(Debug, Clone, PartialEq)]
pub struct Item {
    /// File name in `journal/`.
    pub file: String,
    /// Size.
    pub bytes: u64,
    /// Destination relative to the archive root.
    pub dest_rel: String,
    /// Source path.
    pub src: PathBuf,
    /// Destination path.
    pub dest: PathBuf,
    /// `mtimeMs` when planned.
    pub mtime_ms: f64,
}

/// The journal directory of a store.
pub fn journal_dir(home: &Path, hash: &str) -> PathBuf {
    super::plan::store_dir(home, hash).join(defaults::text("devswarm_sup.rt_journal_dir"))
}

/// The files of a store's journal, in `readdirSync` order, with the destinations Node computes.
pub fn items(home: &Path, hash: &str) -> Vec<Item> {
    let jdir = journal_dir(home, hash);
    let ext = defaults::text("devswarm_sup.rt_journal_ext");
    let out_dir = super::cap::archive_root(home).join(hash).join(defaults::text("devswarm_sup.rt_legacy_dir"));
    let root = super::cap::archive_root(home);
    let mut v = Vec::new();
    for (name, _) in fsx::read_dir_names(&jdir.to_string_lossy()).unwrap_or_default() {
        if !name.ends_with(ext) {
            continue;
        }
        let src = jdir.join(&name);
        let Ok(md) = std::fs::metadata(&src) else { continue };
        let mtime = fsx::mtime_ms(&md);
        let stem = &name[..name.len() - ext.len()];
        let dest = out_dir.join(format!("{stem}-{}{}", mtime.floor() as i64, defaults::text("devswarm_sup.rt_gz_ext")));
        let dest_rel = dest.strip_prefix(&root).map_or_else(|_| dest.to_string_lossy().into_owned(), |r| r.to_string_lossy().into_owned());
        v.push(Item { file: name, bytes: md.len(), dest_rel, src, dest, mtime_ms: mtime });
    }
    v
}

/// Whether a store has any journal file at all.
pub fn any(home: &Path, hash: &str) -> bool {
    !items(home, hash).is_empty()
}

/// The files as Node's dry run reports them.
pub fn files_json(items: &[Item]) -> Vec<Value> {
    items.iter().map(|i| json!({"file": i.file, "bytes": i.bytes, "dest": i.dest_rel})).collect()
}

/// The eligibility word of Node's answer and whether the engine's list is the one Node names.
pub fn agrees(mine: &[Item], node: &Value) -> bool {
    node["eligible"] == true && node["files"].as_array().is_some_and(|f| *f == files_json(mine))
}

fn one(home: &Path, hash: &str, it: &Item) -> Value {
    let mut rec = json!({"file": it.file, "bytes": it.bytes, "dest": it.dest_rel});
    let Ok(raw) = std::fs::read(&it.src) else { return rec };
    let Ok(gz) = super::gz::compress(&raw) else {
        rec["error"] = json!("gzip");
        return rec;
    };
    if let Some(d) = it.dest.parent()
        && std::fs::create_dir_all(d).is_err()
    {
        rec["error"] = json!("mkdir");
        return rec;
    }
    let mut tmp = it.dest.as_os_str().to_os_string();
    tmp.push(format!(".{}{}", std::process::id(), defaults::text("devswarm_sup.rt_tmp_suffix")));
    let tmp = PathBuf::from(tmp);
    let wrote = std::fs::File::create(&tmp).and_then(|mut f| f.write_all(&gz).and_then(|()| f.sync_all()));
    if wrote.is_err() || std::fs::rename(&tmp, &it.dest).is_err() {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: cleanup of our own temporary file
        rec["error"] = json!("write");
        return rec;
    }
    if let Some(d) = it.dest.parent() {
        fsync_dir(d);
    }
    // the compressed copy must decompress to exactly the bytes read; otherwise it is removed and the raw file stays
    let back = std::fs::read(&it.dest).ok().and_then(|g| super::gz::decompress(&g).ok());
    if back.as_deref() != Some(raw.as_slice()) {
        rec["error"] = json!("verify-mismatch");
        crate::discard::harmless(std::fs::remove_file(&it.dest)); // keep: the unverified copy is ours; the raw file stays
        return rec;
    }
    // stricter than Node: a file that changed after it was read is not removed
    let unchanged = std::fs::metadata(&it.src).is_ok_and(|m| m.len() == it.bytes && fsx::mtime_ms(&m) == it.mtime_ms);
    if !unchanged || raw.len() as u64 != it.bytes {
        rec["error"] = json!(defaults::text("devswarm_sup.rt_msg_fold_changed"));
        return rec;
    }
    if std::fs::remove_file(&it.src).is_err() {
        rec["error"] = json!("unlink");
        return rec;
    }
    log_event(
        home,
        &[
            ("event", OVal::Str(defaults::text("devswarm_sup.rt_ev_legacy_archived").into())),
            ("store", OVal::Str(hash.into())),
            ("file", OVal::Str(it.file.clone())),
            ("bytes", OVal::Num(it.bytes as f64)),
            ("dest", OVal::Str(it.dest_rel.clone())),
        ],
    );
    rec
}

/// Fold the planned files. Returns Node's result shape for a real run.
pub fn run(home: &Path, hash: &str, planned: &[Item]) -> Value {
    let files: Vec<Value> = planned.iter().map(|it| one(home, hash, it)).collect();
    // Node: `fs.rmdirSync(jdir)`, which only succeeds on an empty directory
    crate::discard::harmless(std::fs::remove_dir(journal_dir(home, hash))); // keep: other files remain, then it stays
    json!({"hash": hash, "eligible": true, "reason": null, "files": files, "dryRun": false})
}
