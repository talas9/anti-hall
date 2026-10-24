//! The pieces of `ah-engine diag <topic>` that need no daemon: they read the state directory and this process, nothing else.
//!
//! The other topics (cpu, mem, threads, hooks, mesh, jev, trace) are answered by the daemon (`CTL diag <topic>`, built from state it
//! already keeps); `fs` and `locks` are read here so they work when the daemon is down, which is when they are wanted. None of these
//! verbs takes a lock or writes: a lock is reported from its file (size, age, the pid it names), never probed.
use crate::{defaults, health, paths};
use serde_json::{Value, json};
use std::path::Path;

/// The topics `diag` accepts (`diagnostics.diag_topics`).
pub fn topics() -> Vec<&'static str> {
    defaults::list("diagnostics.diag_topics")
}

fn age_s(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.elapsed().ok()).map_or(0, |d| d.as_secs())
}

/// `diag fs`: open descriptors, the state directory's biggest files, and the database sizes.
pub fn fs() -> Value {
    let dir = paths::dir();
    let fds = std::fs::read_dir(defaults::text("diagnostics.fd_dir")).map_or(0, std::iter::Iterator::count);
    let mut files: Vec<(u64, String, u64)> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    e.metadata().ok().filter(std::fs::Metadata::is_file).map(|m| (m.len(), e.file_name().to_string_lossy().into_owned(), age_s(&m)))
                })
                .collect()
        })
        .unwrap_or_default();
    let total: u64 = files.iter().map(|f| f.0).sum();
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    let top: Vec<Value> =
        files.iter().take(defaults::num("diagnostics.diag_top") as usize).map(|(len, name, age)| json!({"file": name, "bytes": len, "age_s": age})).collect();
    json!({"state_dir": dir.display().to_string(), "open_fds": fds, "files": files.len(), "total_bytes": total, "largest": top, "db": crate::maintain::sizes(&dir)})
}

/// One lock file's description: its size, age, and the pid it names when it holds one (and whether that process is alive).
fn lock_row(p: &Path) -> Value {
    let Ok(m) = std::fs::metadata(p) else { return json!({"file": p.display().to_string(), "error": "unreadable"}) };
    let text = std::fs::read_to_string(p).unwrap_or_default();
    let pid = text.split_whitespace().next().and_then(|t| t.parse::<u32>().ok());
    json!({"file": p.file_name().map(|n| n.to_string_lossy().into_owned()), "bytes": m.len(), "age_s": age_s(&m), "pid": pid, "pid_alive": pid.map(health::pid_alive)})
}

/// `diag locks`: every lock file in the state directory (by `paths.lock_suffix`).
pub fn locks() -> Value {
    let suffix = defaults::text("paths.lock_suffix");
    let mut rows: Vec<Value> = std::fs::read_dir(paths::dir())
        .map(|rd| rd.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(suffix)).map(|e| lock_row(&e.path())).collect())
        .unwrap_or_default();
    rows.sort_by_key(|r| r.get("file").and_then(Value::as_str).unwrap_or_default().to_string());
    json!({"locks": rows})
}

/// The last trace dump on disk (written when a hard limit tripped), as lines; empty when there is none. For `diag trace` with no daemon.
pub fn last_trace_dump() -> Value {
    let path = paths::dir().join(defaults::text("diagnostics.trace_dump_file"));
    let lines: Vec<Value> = std::fs::read_to_string(&path).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    json!({"running": false, "dump_file": path.display().to_string(), "entries": lines})
}

/// `diag file <id>`: the tail of an allowlisted file, scrubbed. Ids: `state:<name>` (a plain file name in the state directory),
/// `defaults:<name>.toml` (a shipped defaults file), `transcript:<agent>` (a transcript the tracker follows). Nothing outside those is read.
pub fn file(id: &str) -> Value {
    let refuse = |why: &str| json!({"id": id, "error": defaults::render("diagnostics.msg_file_refused", &[("why", &why)])});
    let plain = |n: &str| !n.is_empty() && !n.contains(['/', '\\']) && !n.starts_with('.') && !n.contains("..");
    let (st, df, tr) = (
        defaults::text("diagnostics.file_prefix_state"),
        defaults::text("diagnostics.file_prefix_defaults"),
        defaults::text("diagnostics.file_prefix_transcript"),
    );
    let path = if let Some(n) = id.strip_prefix(st) {
        if !plain(n) {
            return refuse(defaults::text("diagnostics.why_not_plain_name"));
        }
        paths::dir().join(n)
    } else if let Some(n) = id.strip_prefix(df) {
        let Some(root) = defaults::root().filter(|_| plain(n)) else { return refuse(defaults::text("diagnostics.why_not_plain_name")) };
        root.join("engine").join("defaults").join(n)
    } else if let Some(a) = id.strip_prefix(tr) {
        match crate::agents::transcript_path(a) {
            Some(p) => std::path::PathBuf::from(p),
            None => return refuse(defaults::text("diagnostics.why_not_found")),
        }
    } else {
        return refuse(defaults::text("diagnostics.why_unknown_id"));
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if defaults::list("diagnostics.file_refuse_ext").iter().any(|e| name.ends_with(e)) {
        return refuse(defaults::text("diagnostics.why_ext"));
    }
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(&path) else { return refuse(defaults::text("diagnostics.why_not_found")) };
    let len = f.metadata().map_or(0, |m| m.len());
    let start = len.saturating_sub(defaults::num("diagnostics.file_max_bytes"));
    let mut buf = Vec::new();
    crate::discard::harmless(f.seek(SeekFrom::Start(start))); // keep: a failed seek reads from the start, which is only more text
    crate::discard::harmless(f.take(len - start).read_to_end(&mut buf)); // keep: a partial read shows what was read
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // the first line of a tail is cut mid-way
    }
    let keep = defaults::num("diagnostics.file_tail_lines") as usize;
    let skip = lines.len().saturating_sub(keep);
    json!({"id": id, "file": health::scrub(&path.display().to_string()), "bytes": len, "truncated": start > 0 || skip > 0, "lines": lines[skip..].iter().map(|l| health::scrub(l)).collect::<Vec<_>>()})
}

/// `diag integrity <store>`: SQLite `PRAGMA quick_check` on a read-only connection to one of `diagnostics.integrity_stores`.
pub fn integrity(store: &str) -> Value {
    let stores = defaults::list("diagnostics.integrity_stores");
    if !stores.contains(&store) {
        return json!({"error": defaults::render("diagnostics.msg_integrity_usage", &[("stores", &stores.join("|"))])});
    }
    let path = paths::dir().join(store);
    let bytes = std::fs::metadata(&path).map_or(0, |m| m.len());
    let result = rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .and_then(|c| c.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0)));
    match result {
        Ok(r) => json!({"store": store, "bytes": bytes, "ok": r == "ok", "result": r}),
        Err(e) => json!({"store": store, "bytes": bytes, "ok": false, "result": e.to_string()}),
    }
}

/// The report for a topic that needs no daemon, `None` for the others. `arg` is the topic's argument (`file <id>`, `integrity <store>`).
pub fn local(topic: &str, arg: &str) -> Option<Value> {
    match topic {
        "fs" => Some(fs()),
        "locks" => Some(locks()),
        "file" => Some(if arg.is_empty() { json!({"error": defaults::text("diagnostics.msg_file_usage")}) } else { file(arg) }),
        "integrity" => Some(integrity(arg)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lock_file_is_described_from_its_contents_without_being_locked() {
        let dir = std::env::temp_dir().join(format!("ah-obs-diag-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.lock");
        std::fs::write(&f, format!("{} held\n", std::process::id())).unwrap();
        let row = lock_row(&f);
        assert_eq!(row["pid"], std::process::id());
        assert_eq!(row["pid_alive"], true);
        assert_eq!(lock_row(&dir.join("gone.lock"))["error"], "unreadable");
        assert!(topics().contains(&"locks") && local("cpu", "").is_none() && local("fs", "").is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
