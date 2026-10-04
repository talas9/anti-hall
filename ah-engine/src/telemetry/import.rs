//! Import of the Node plugin's telemetry files (D78 revised 1.35): `ah-engine telemetry import`.
//!
//! Until the hooks are ported, the Node side appends its routing events as one JSON object per line to
//! `<base>/telemetry/<date>.ndjson`, with the same short fields as an engine event (see [`super::event`]). This reads those
//! files into hot.db so the reports show pre-engine data next to engine data.
//!
//! Idempotent: each line is stored under a key made of its file name, its line number and a hash of its text, so
//! importing the same file again (or after more lines were appended) stores only the new lines and counts nothing twice.
//! Strict: a line that is not valid JSON, has a field the schema does not have, or holds text where an identifier belongs
//! is rejected and counted by reason; its content is never kept. Lines older than `telemetry.retention_days` are skipped,
//! since the retention would remove them straight away.
use super::event::Event;
use super::persist::TelDb;
use crate::defaults;
use crate::error::DbError;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::BufRead;
use std::path::Path;

/// The files of `dir` that hold telemetry lines, in name order.
fn files(dir: &Path) -> Vec<std::path::PathBuf> {
    let ext = defaults::text("telemetry.import_ext");
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && p.extension().is_some_and(|x| x == ext)).collect())
        .unwrap_or_default();
    v.sort();
    v
}

/// Import every telemetry file in `dir` into `t`. `cutoff_ms`: lines before it are skipped (`expired`). The report counts
/// files, lines, stored, already-stored duplicates, expired and rejected lines (by reason).
pub fn import_dir(t: &TelDb, dir: &Path, cutoff_ms: u64) -> Result<Value, DbError> {
    let (mut lines, mut stored, mut expired, mut ok) = (0u64, 0u64, 0u64, 0u64);
    let mut rejected: BTreeMap<&'static str, u64> = BTreeMap::new();
    let fs = files(dir);
    let max_line = defaults::num("telemetry.import_max_line") as usize;
    let batch = defaults::num("telemetry.import_batch") as usize;
    for f in &fs {
        let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let Ok(file) = std::fs::File::open(f) else {
            *rejected.entry("unreadable_file").or_insert(0) += 1;
            continue;
        };
        let mut rows: Vec<(String, Event)> = Vec::new();
        for (i, line) in std::io::BufReader::new(file).split(b'\n').enumerate() {
            let Ok(bytes) = line else { break };
            if bytes.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            lines += 1;
            if bytes.len() > max_line {
                *rejected.entry("too_long").or_insert(0) += 1;
                continue;
            }
            let Ok(v) = serde_json::from_slice::<Value>(&bytes) else {
                *rejected.entry("bad_json").or_insert(0) += 1;
                continue;
            };
            match Event::from_json(&v) {
                Err(e) => *rejected.entry(e.code()).or_insert(0) += 1,
                Ok(ev) if ev.ts_ms < cutoff_ms => expired += 1,
                Ok(ev) => {
                    ok += 1;
                    rows.push((format!("{name}:{}:{:016x}", i + 1, crate::health::fnv(&String::from_utf8_lossy(&bytes))), ev));
                    if rows.len() >= batch {
                        stored += t.import(std::mem::take(&mut rows))?;
                    }
                }
            }
        }
        if !rows.is_empty() {
            stored += t.import(rows)?;
        }
    }
    Ok(json!({
        "dir": dir.display().to_string(),
        "files": fs.len(),
        "lines": lines,
        "stored": stored,
        "already_stored": ok.saturating_sub(stored),
        "expired": expired,
        "rejected": rejected.values().sum::<u64>(),
        "rejected_by_reason": rejected,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Db, TempDir};

    fn line(ts: u64, key: &str) -> String {
        json!({"ts": ts, "k": "route", "h": "model-routing", "e": "PreToolUse", "o": "advise", "ms": 2, "ib": 40,
               "requested_model": "opus", "parent_model": "opus", "task_class": "mechanical", "recommended_tier": "haiku", "outcome": "down", "spawn_key": key})
        .to_string()
    }

    fn setup(tag: &str) -> (TempDir, TelDb, std::path::PathBuf) {
        let d = TempDir::new(tag);
        let t = TelDb::new(Db::open(&d.0).unwrap());
        let dir = d.0.join("in");
        std::fs::create_dir_all(&dir).unwrap();
        (d, t, dir)
    }

    #[test]
    fn importing_twice_stores_each_line_once_and_counts_once() {
        let (_d, t, dir) = setup("tel-imp1");
        let now = 2_000_000_000_000u64;
        std::fs::write(dir.join("2033-05-18.ndjson"), format!("{}\n{}\n", line(now - 10, "k1"), line(now - 5, "k2"))).unwrap();
        let a = import_dir(&t, &dir, 0).unwrap();
        assert_eq!((a["lines"].as_u64(), a["stored"].as_u64(), a["already_stored"].as_u64()), (Some(2), Some(2), Some(0)));
        let b = import_dir(&t, &dir, 0).unwrap();
        assert_eq!((b["stored"].as_u64(), b["already_stored"].as_u64()), (Some(0), Some(2)));
        // more lines appended later: only the new one is stored
        let mut f = std::fs::OpenOptions::new().append(true).open(dir.join("2033-05-18.ndjson")).unwrap();
        std::io::Write::write_all(&mut f, format!("{}\n", line(now, "k3")).as_bytes()).unwrap();
        let c = import_dir(&t, &dir, 0).unwrap();
        assert_eq!((c["stored"].as_u64(), c["already_stored"].as_u64()), (Some(1), Some(2)));
        let counted: u64 = t.counts(0, 1_000_000).iter().filter(|r| r.delta.k == "route").map(|r| r.delta.n).sum();
        assert_eq!(counted, 3, "three events, counted three times in total, not nine");
        assert_eq!(t.held_events(), 3);
    }

    #[test]
    fn bad_lines_are_rejected_by_reason_and_their_text_is_never_kept() {
        let (_d, t, dir) = setup("tel-imp2");
        let secret = "please fix the login bug for alice@example.com";
        let with_text = json!({"ts": 5, "k": "hook", "h": "x", "e": "Stop", "o": "allow", "prompt": secret}).to_string();
        let text_in_id = json!({"ts": 5, "k": "hook", "h": secret, "e": "Stop", "o": "allow"}).to_string();
        let body =
            format!("not json at all\n{with_text}\n{text_in_id}\n{}\n\n{}\n", json!({"ts": 5, "k": "nope", "h": "x", "e": "y", "o": "allow"}), line(10, "ok"));
        std::fs::write(dir.join("a.ndjson"), body).unwrap();
        let r = import_dir(&t, &dir, 0).unwrap();
        assert_eq!((r["stored"].as_u64(), r["rejected"].as_u64()), (Some(1), Some(4)));
        assert_eq!(r["rejected_by_reason"]["bad_json"], 1);
        assert_eq!(r["rejected_by_reason"]["unknown_field"], 1);
        assert_eq!(r["rejected_by_reason"]["bad_token"], 1);
        assert_eq!(r["rejected_by_reason"]["unknown_name"], 1);
        let stored: Vec<String> = t.events("", 0, 100).iter().map(|e| e.to_json().to_string()).collect();
        assert!(stored.iter().all(|s| !s.contains("alice") && !s.contains("login")), "{stored:?}");
        assert!(!r.to_string().contains("alice"), "the report holds no line content either");
    }

    #[test]
    fn lines_older_than_the_cutoff_are_skipped_and_other_files_ignored() {
        let (_d, t, dir) = setup("tel-imp3");
        std::fs::write(dir.join("a.ndjson"), format!("{}\n{}\n", line(100, "old"), line(10_000, "new"))).unwrap();
        std::fs::write(dir.join("notes.txt"), "x\n").unwrap();
        let r = import_dir(&t, &dir, 5000).unwrap();
        assert_eq!((r["files"].as_u64(), r["stored"].as_u64(), r["expired"].as_u64()), (Some(1), Some(1), Some(1)));
        let missing = import_dir(&t, &dir.join("nope"), 0).unwrap();
        assert_eq!(missing["files"], 0);
    }
}
