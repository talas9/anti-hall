//! The shadow ledger: one JSON line per check and source (`engine` or `node`), appended by the engine side, the shadow runs and the
//! shell fallback, read by `shadow-compare`. A line holds only identifiers and numbers (no payload text).
//!
//! `{"ts":<ms>,"inv":"<call id>","src":"engine|node","host":"claude","ev":"PreToolUse","tool":"Bash","chk":"git-guard","v":"block","ms":12,"err":""}`
use crate::defaults;
use serde_json::{Value, json};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;

/// One ledger row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    /// When it was recorded, ms since the epoch.
    pub ts: u64,
    /// The call it belongs to (the engine and node rows of one event share it).
    pub inv: String,
    /// `engine` or `node`.
    pub src: String,
    /// The host (`claude`, `codex`).
    pub host: String,
    /// The hook event.
    pub ev: String,
    /// The tool the event matched, or empty.
    pub tool: String,
    /// The check (the dispatch table id of the hook).
    pub chk: String,
    /// The verdict word: `allow`, `advise`, `block`, or `error` / `timeout` (no verdict).
    pub v: String,
    /// Wall time in ms.
    pub ms: u64,
    /// Why there is no verdict, an identifier, or empty.
    pub err: String,
}

/// `s` as a ledger identifier: the telemetry token alphabet, anything else `_`, at most `nodeback.ident_max_len` bytes.
pub fn ident(s: &str) -> String {
    let cut = s.get(..s.len().min(defaults::num("nodeback.ident_max_len") as usize)).unwrap_or_default();
    crate::telemetry::event::Token::sanitize(cut).as_str().to_string()
}

impl Row {
    fn to_line(&self) -> String {
        let mut s = json!({
            "ts": self.ts, "inv": self.inv, "src": self.src, "host": self.host, "ev": self.ev, "tool": self.tool,
            "chk": self.chk, "v": self.v, "ms": self.ms, "err": self.err,
        })
        .to_string();
        s.push('\n');
        s
    }

    /// The row a ledger line holds, or `None` for a line that is not one.
    pub fn parse(line: &str) -> Option<Row> {
        let v: Value = serde_json::from_str(line).ok()?;
        let text = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
        Some(Row {
            ts: v.get("ts")?.as_u64()?,
            inv: text("inv")?,
            src: text("src")?,
            host: text("host").unwrap_or_default(),
            ev: text("ev").unwrap_or_default(),
            tool: text("tool").unwrap_or_default(),
            chk: text("chk")?,
            v: text("v")?,
            ms: v.get("ms").and_then(Value::as_u64).unwrap_or(0),
            err: text("err").unwrap_or_default(),
        })
    }
}

fn flock(f: &std::fs::File) -> std::io::Result<()> {
    // SAFETY: `f` is an open file owned by the caller, so its descriptor is valid; `flock` takes only the descriptor and a flag.
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Append `rows` to the ledger in one write, rotating it to `<ledger>.1` past `nodeback.ledger_max_bytes`. Best effort: a failure
/// loses these rows and nothing else.
pub fn append(rows: &[Row]) {
    if rows.is_empty() {
        return;
    }
    let path = super::state_file("files.shadow_ledger");
    let bytes: Vec<u8> = rows.iter().flat_map(|r| r.to_line().into_bytes()).collect();
    let open = || std::fs::OpenOptions::new().append(true).create(true).mode(0o600).open(&path);
    let opened = match open() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => path.parent().map(crate::limits::ensure_private_dir).map(|_| open()).unwrap_or(Err(e)),
        other => other,
    };
    let Ok(mut f) = opened else { return };
    if flock(&f).is_err() {
        return;
    }
    if f.metadata().map(|m| m.len()).unwrap_or(0) >= defaults::num("nodeback.ledger_max_bytes") {
        let mut old = path.clone().into_os_string();
        old.push(".1");
        crate::discard::harmless(std::fs::rename(&path, old)); // keep: a failed rotation only lets the file grow a little further
        match open() {
            Ok(n) => f = n,
            Err(_) => return,
        }
    }
    crate::discard::logged("nodeback_ledger_append", f.write_all(&bytes));
}

/// Every row of the ledger (and of its rotated generation) recorded at or after `since_ms`.
pub fn read_since(since_ms: u64) -> Vec<Row> {
    let path = super::state_file("files.shadow_ledger");
    let mut old = path.clone().into_os_string();
    old.push(".1");
    let mut rows = Vec::new();
    for p in [std::path::PathBuf::from(old), path] {
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        rows.extend(text.lines().filter_map(Row::parse).filter(|r| r.ts >= since_ms));
    }
    rows
}
