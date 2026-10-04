//! The decision log: one JSON line per decision, in the row shape the Node `jev report` reads.
//!
//! Mirrors `appendLog` and `shiftRotated` in `hooks/lib/jev-assist.js`: `<home>/.anti-hall/logs/jev-assist.ndjson`,
//! rotated at `jev.log_max_bytes` into `.1` to `.N`. A row holds hashes, verdicts, confidences, latencies and costs,
//! never prompt text and never a credential. Writing is best effort: a failure is returned for the caller to count but
//! must never change a decision (D35).
//!
//! Folding the rows of the oldest generation into the daily rollups just before it is replaced (Node:
//! `writeDailyRollups`) is planned (D38); until then the rotation only shifts generations.
use super::error::JevError;
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

/// One log row with its keys in the order they are written (a plain JSON map would sort them).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Row(pub Vec<(&'static str, Value)>);

impl Row {
    /// Add a field.
    pub fn put(&mut self, key: &'static str, value: Value) {
        self.0.push((key, value));
    }

    /// The row as one JSON line without the trailing newline.
    pub fn to_line(&self) -> String {
        let fields: Vec<String> = self.0.iter().map(|(k, v)| format!("{}:{}", super::question::json_str(k), v)).collect();
        format!("{{{}}}", fields.join(","))
    }
}

/// Where decision rows go.
pub trait DecisionLog: Send + Sync {
    /// Append one row.
    fn append(&self, row: &Row) -> Result<(), JevError>;
}

/// The file log with size-based rotation.
pub struct FileLog {
    path: PathBuf,
    max_bytes: u64,
    keep: u64,
}

impl FileLog {
    /// A log at `path`, rotating at `max_bytes` and keeping `keep` generations.
    pub fn new(path: PathBuf, max_bytes: u64, keep: u64) -> FileLog {
        FileLog { path, max_bytes, keep: keep.max(1) }
    }

    /// The log's path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn io(&self, what: &str, source: std::io::Error) -> JevError {
        JevError::Io { what: format!("{what} {}", self.path.display()), source }
    }

    /// Shift `p.(keep-1)` to `p.keep`, ..., `p` to `p.1`. The rename onto `p.keep` replaces the oldest generation.
    fn rotate_if_needed(&self) {
        let Ok(meta) = std::fs::metadata(&self.path) else { return };
        if meta.len() <= self.max_bytes {
            return;
        }
        let gen = |n: u64| {
            let mut s = self.path.as_os_str().to_os_string();
            s.push(format!(".{n}"));
            PathBuf::from(s)
        };
        for i in (1..self.keep).rev() {
            let _ = std::fs::rename(gen(i), gen(i + 1)); // a gap in the chain is fine
        }
        let _ = std::fs::rename(&self.path, gen(1)); // on failure the row is appended to the oversized file
    }
}

impl DecisionLog for FileLog {
    fn append(&self, row: &Row) -> Result<(), JevError> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| self.io("create the directory of", e))?;
        }
        self.rotate_if_needed();
        let mut f = OpenOptions::new().create(true).append(true).open(&self.path).map_err(|e| self.io("open", e))?;
        f.write_all(format!("{}\n", row.to_line()).as_bytes()).map_err(|e| self.io("append to", e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ah-jev-log-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn a_row_keeps_its_key_order_and_escapes_values() {
        let mut r = Row::default();
        r.put("z", json!(1));
        r.put("a", json!("x\"y"));
        r.put("n", Value::Null);
        assert_eq!(r.to_line(), r#"{"z":1,"a":"x\"y","n":null}"#);
    }

    #[test]
    fn rows_append_one_per_line_and_the_directory_is_created() {
        let d = dir("append");
        let log = FileLog::new(d.join("logs/jev-assist.ndjson"), 1 << 20, 3);
        for n in 0..3 {
            log.append(&Row(vec![("n", json!(n))])).unwrap();
        }
        let text = std::fs::read_to_string(log.path()).unwrap();
        assert_eq!(text.lines().collect::<Vec<_>>(), [r#"{"n":0}"#, r#"{"n":1}"#, r#"{"n":2}"#]);
    }

    #[test]
    fn rotation_shifts_generations_and_drops_the_oldest() {
        let d = dir("rotate");
        let log = FileLog::new(d.join("l.ndjson"), 20, 3);
        for n in 0..8 {
            log.append(&Row(vec![("n", json!(n)), ("pad", json!("xxxxxxxxxx"))])).unwrap();
        }
        let names: Vec<String> = std::fs::read_dir(&d).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        for kept in ["l.ndjson.1", "l.ndjson.2", "l.ndjson.3"] {
            assert!(names.contains(&kept.to_string()), "{names:?}");
        }
        assert!(!names.contains(&"l.ndjson.4".to_string()), "keep=3 keeps generations .1 to .3: {names:?}");
    }
}
