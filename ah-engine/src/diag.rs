//! Developer diagnostics, compiled only with `--features diag` (never in a release build).
//!
//! `ah-engine diag heap <payload-file|dir>...` replays hook payloads through every built-in check in this process and
//! reports, per check, the heap peak and what stayed allocated afterwards, measured with the dhat allocator (installed
//! by `main.rs` under the same feature). It answers "which check holds the most memory on real payloads", which RSS
//! numbers (macOS keeps freed pages) cannot.
//!
//! Safety: the checks write state (ledgers, throttles) under `HOME`, so the replay runs against a fresh temporary home
//! and never against the real one; transcripts a payload names are only read.
use crate::checks::{self, Verdict};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Per-check totals over a replay.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Row {
    /// Payloads the check was evaluated on.
    pub runs: u64,
    /// The largest peak (dhat `max_bytes`) of any single evaluation.
    pub peak: usize,
    /// The largest number of bytes still allocated when an evaluation ended (`curr_bytes`).
    pub current: usize,
    /// Bytes allocated over all evaluations (`total_bytes`).
    pub total: u64,
}

impl Row {
    /// Fold in one evaluation's stats.
    pub fn add(&mut self, peak: usize, current: usize, total: u64) {
        self.runs += 1;
        self.peak = self.peak.max(peak);
        self.current = self.current.max(current);
        self.total += total;
    }
}

/// The payloads in `path`: a file holding one JSON value, or one per line; a directory is read file by file.
pub fn load_payloads(path: &Path) -> Vec<Value> {
    if path.is_dir() {
        let mut files: Vec<PathBuf> = std::fs::read_dir(path).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
        files.sort();
        return files.iter().flat_map(|f| load_payloads(f)).collect();
    }
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        return vec![v];
    }
    text.lines().filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok()).collect()
}

/// A table of rows, largest peak first.
pub fn render(rows: &BTreeMap<String, Row>) -> String {
    let mut sorted: Vec<(&String, &Row)> = rows.iter().collect();
    sorted.sort_by(|a, b| b.1.peak.cmp(&a.1.peak).then(a.0.cmp(b.0)));
    let mut out = format!("{:<28} {:>6} {:>12} {:>12} {:>14}\n", "check", "runs", "peak B", "current B", "total B");
    for (name, r) in sorted {
        out.push_str(&format!("{:<28} {:>6} {:>12} {:>12} {:>14}\n", name, r.runs, r.peak, r.current, r.total));
    }
    out
}

/// Evaluate every check on every payload, one dhat profile per evaluation.
pub fn heap(payloads: &[Value], env: &RequestEnv) -> BTreeMap<String, Row> {
    let null = Value::Null;
    let mut rows: BTreeMap<String, Row> = BTreeMap::new();
    for p in payloads {
        let subject = Subject {
            event: p.get("hook_event_name").and_then(Value::as_str).unwrap_or("PreToolUse"),
            tool: p.get("tool_name").and_then(Value::as_str),
            cwd: p.get("cwd").and_then(Value::as_str),
            tool_input: p.get("tool_input").unwrap_or(&null),
            prompt: p.get("prompt").and_then(Value::as_str),
        };
        let opts = serde_json::json!({ "payload_sha1": checks::emit_dedupe::sha1_hex(p.to_string().as_bytes()) });
        for check in checks::registry() {
            let profiler = dhat::Profiler::builder().testing().build();
            let verdict: Option<Verdict> = checks::run_env_guarded(*check, &subject, p, &opts, env);
            let s = dhat::HeapStats::get();
            drop(verdict);
            drop(profiler);
            rows.entry(check.name().to_string()).or_default().add(s.max_bytes, s.curr_bytes, s.total_bytes);
        }
    }
    rows
}

/// `ah-engine diag <what> ...`; only `heap` exists. Returns the exit code.
pub fn run(args: &[String]) -> i32 {
    if args.first().map(String::as_str) != Some("heap") || args.len() < 2 {
        eprintln!("usage: ah-engine diag heap <payload-file|dir>...   (JSON file, JSON-lines file, or a directory of them)");
        return 64;
    }
    let payloads: Vec<Value> = args[1..].iter().flat_map(|a| load_payloads(Path::new(a))).collect();
    if payloads.is_empty() {
        eprintln!("diag heap: no payloads found in {:?}", &args[1..]);
        return 64;
    }
    let home = std::env::temp_dir().join(format!("ah-diag-heap-{}", std::process::id()));
    crate::discard::harmless(std::fs::create_dir_all(&home)); // keep: scratch HOME setup; replay below reports any resulting failure
    let env = RequestEnv::from_pairs([("HOME", home.to_string_lossy().into_owned()), ("ANTIHALL_INGEST_DRY_RUN", "1".to_string())]);
    println!("replaying {} payload(s) through {} checks (scratch HOME {})", payloads.len(), checks::registry().len(), home.display());
    print!("{}", render(&heap(&payloads, &env)));
    crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: our own scratch dir, created above
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_keep_the_largest_peak_and_sum_the_totals() {
        let mut r = Row::default();
        r.add(10, 4, 100);
        r.add(30, 2, 50);
        assert_eq!(r, Row { runs: 2, peak: 30, current: 4, total: 150 });
    }

    #[test]
    fn the_table_is_largest_peak_first() {
        let mut m = BTreeMap::new();
        m.entry("small".to_string()).or_insert_with(Row::default).add(1, 0, 1);
        m.entry("big".to_string()).or_insert_with(Row::default).add(9, 0, 9);
        let t = render(&m);
        assert!(t.find("big").unwrap() < t.find("small").unwrap(), "{t}");
    }
}
