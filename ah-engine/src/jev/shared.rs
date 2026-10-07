//! The process-wide Jev lanes the checks ask through, and the helpers every Jev caller shares.
//!
//! A check runs once per hook call, but the asynchronous queue, the answer cache, the settings snapshot and the
//! connection pool belong to one long-lived [`Jev`]. [`lane`] hands every check the same lane for a home directory, so a
//! detached ask started by one Stop hook is still running (and lands in the log) after that call returned.
//! The registry is bounded (`jev.lane_cap` homes; a single user has one).
//!
//! [`turn_ref_from_transcript`] is Node's `turnRefFromTranscript`.
use super::{Env, Jev};
use crate::defaults;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

static RESIDENT: AtomicBool = AtomicBool::new(false);

/// Mark this process as the resident engine (the daemon): detached asks then run on a thread of the shared lane. In any
/// other process (a one-shot hook) a detached ask is a detached child process, because the process ends with the check.
pub fn set_resident() {
    RESIDENT.store(true, Ordering::SeqCst);
}

static LANES: Mutex<Vec<(PathBuf, Arc<Jev>)>> = Mutex::new(Vec::new());

/// The shared lane for `home`, created on first use with the real transport and the Node files (log, breaker). `env` is
/// only the snapshot the lane's own default settings resolve against; every ask carries its calling session's
/// environment in `AskRequest::env`.
pub fn lane(home: &Path, env: &Env) -> Arc<Jev> {
    let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((_, j)) = g.iter().find(|(h, _)| h == home) {
        return j.clone();
    }
    let jev = Jev::new(home, env.clone());
    if g.len() >= defaults::num("jev.lane_cap") as usize {
        g.remove(0);
    }
    g.push((home.to_path_buf(), jev.clone()));
    jev
}

/// Start a detached ask on the shared lane for `home`, as Node's `askDetached` does: it returns at once, the answer lands in
/// the log (and the lane's cache) and never reaches the caller. `req.env` is set to the calling session's environment.
pub fn ask_detached(home: &Path, env: &Env, mut req: super::AskRequest) {
    req.env = Some(env.clone());
    let jev = lane(home, env);
    if RESIDENT.load(Ordering::SeqCst) || cfg!(test) {
        jev.ask_async(req);
    } else {
        jev.ask_detached_process(req);
    }
}

/// Put a prepared lane in place of the shared one for `home` (tests only: a lane over a scripted transport).
#[cfg(test)]
pub(crate) fn install(home: &Path, jev: Arc<Jev>) {
    let mut g = LANES.lock().unwrap_or_else(|e| e.into_inner());
    g.retain(|(h, _)| h != home);
    g.push((home.to_path_buf(), jev));
}

/// A short pointer to the turn a decision was about: the `timestamp` of the last transcript line that has one, read from
/// the last 64 KiB; `L<n>` (the window's line count) when none does; `None` for a missing path, an unreadable file or an
/// empty window. Node: `turnRefFromTranscript`.
pub fn turn_ref_from_transcript(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    if path.is_empty() {
        return None;
    }
    let window = defaults::num("jev.turn_ref_window_bytes");
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    let mut buf = Vec::new();
    if size <= window {
        f.read_to_end(&mut buf).ok()?;
    } else {
        f.seek(SeekFrom::Start(size - window)).ok()?;
        f.take(window).read_to_end(&mut buf).ok()?;
    }
    let data = String::from_utf8_lossy(&buf);
    let lines: Vec<&str> = data.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).filter(|l| !super::js_trim(l).is_empty()).collect();
    if lines.is_empty() {
        return None;
    }
    for l in lines.iter().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(l)
            && let Some(ts) = v.get("timestamp").and_then(serde_json::Value::as_str).filter(|t| !t.is_empty())
        {
            return Some(ts.to_string());
        }
    }
    Some(format!("L{}", lines.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str, body: &str) -> String {
        let d = std::env::temp_dir().join(format!("ah-turnref-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join("t.jsonl");
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn the_last_timestamp_wins_and_a_window_without_one_gives_a_line_count() {
        let p = tmp("ts", "{\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n{\"x\":1}\n\n{\"timestamp\":\"\"}\n");
        assert_eq!(turn_ref_from_transcript(&p).as_deref(), Some("2026-01-01T00:00:00.000Z"));
        let p = tmp("nots", "{\"a\":1}\nnot json\r\n{\"b\":2}\n");
        assert_eq!(turn_ref_from_transcript(&p).as_deref(), Some("L3"));
        assert_eq!(turn_ref_from_transcript(&tmp("empty", " \n\n")), None);
        assert_eq!(turn_ref_from_transcript("/nonexistent/ah/t.jsonl"), None);
        assert_eq!(turn_ref_from_transcript(""), None);
    }

    #[test]
    fn only_the_last_window_is_read_and_a_cut_first_line_is_skipped() {
        let big = format!("{{\"timestamp\":\"old\",\"pad\":\"{}\"}}\n{{\"timestamp\":\"new\"}}\n", "x".repeat(70_000));
        assert_eq!(turn_ref_from_transcript(&tmp("big", &big)).as_deref(), Some("new"));
    }
}
