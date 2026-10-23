//! Liveness from the process list, and the sessions the transcript tree does not show.
//!
//! The host keeps a registry of live sessions (`agent_tracker.paths.sessions`: one JSON file per running process, naming its pid and
//! session id). A session whose process is alive is running or waiting, never done, and is followed however long its transcript has
//! been quiet; a session whose process is gone is done. Codex has no such registry: its sessions are found from the rollout files
//! (`agent_tracker.paths.codex`) and read as running while the file is being written. Every path, field and word is config.
use super::sources::{json_of, read_dir};
use super::{Agent, Env, State, kind_name, lim, pth};
use crate::checks::agent_scan::mtime_ms;
use crate::defaults::{self, V};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

/// One live session of the host's registry.
#[derive(Debug, Clone)]
pub(super) struct Session {
    pub pid: u32,
    pub id: String,
    pub cwd: String,
    pub status: String,
}

/// A pid the system handed out again: its process started after the session it is registered for (compared where the system reports a
/// start time in milliseconds).
fn reused(pid: u32, started_ms: u64) -> bool {
    cfg!(target_os = "macos") && crate::procid::start(pid).is_some_and(|us| us / 1000 > started_ms.saturating_add(lim("pid_start_slack_ms")))
}

/// The live sessions of the registry; `None` when the host keeps none (an older version), so absence there decides nothing.
pub(super) fn registry(env: &Env) -> Option<Vec<Session>> {
    let dir = env.home.join(pth("sessions"));
    if !dir.is_dir() {
        return None;
    }
    let f = defaults::raw("agent_tracker.registry");
    let text = |v: &Value, k: &str| v.get(f.str_field(k)).and_then(Value::as_str).unwrap_or("").to_string();
    let json_ext = pth("json_ext").trim_start_matches('.');
    let mut out = Vec::new();
    for p in read_dir(&dir) {
        if p.extension().is_none_or(|e| e.to_string_lossy() != json_ext) {
            continue;
        }
        let Some(v) = json_of(&p) else { continue };
        let pid = v.get(f.str_field("pid")).and_then(Value::as_u64).unwrap_or(0) as u32;
        let started = v.get(f.str_field("started")).and_then(Value::as_u64).unwrap_or(0);
        let id = text(&v, "session");
        if id.is_empty() || !crate::health::pid_alive(pid) || reused(pid, started) {
            continue;
        }
        out.push(Session { pid, id, cwd: text(&v, "cwd"), status: text(&v, "status") });
    }
    Some(out)
}

/// The transcript of a session, wherever the host filed it.
fn transcript_of(env: &Env, id: &str) -> Option<PathBuf> {
    let name = format!("{id}{}", pth("transcript_ext"));
    read_dir(&env.home.join(pth("projects"))).into_iter().map(|d| d.join(&name)).find(|p| p.is_file())
}

/// Live sessions that `found` (the recently written transcripts) does not already carry.
pub(super) fn quiet_sessions(env: &Env, sessions: &[Session], found: &[super::sources::Found]) -> Vec<super::sources::Found> {
    sessions
        .iter()
        .filter(|s| !found.iter().any(|f| f.id == s.id))
        .filter_map(|s| {
            let path = transcript_of(env, &s.id)?;
            Some(super::sources::Found {
                id: s.id.clone(),
                kind: kind_name("main"),
                parent: s.id.clone(),
                name: String::new(),
                mtime: mtime_ms(&path).map_or(0, |m| m as u64),
                path: path.to_string_lossy().to_string(),
                team: String::new(),
                finished: false,
            })
        })
        .collect()
}

/// Join the registry to the tracked agents: a live process un-gones its session and, when the host's own listing did not say, gives its
/// busy or waiting word. With no listing this tick (`cli_used` false) a session absent from a registry that exists is gone.
pub(super) fn apply(st: &mut State, sessions: Option<&[Session]>, cli_used: bool) {
    let Some(sessions) = sessions else { return };
    for a in st.agents.values_mut() {
        if a.kind != kind_name("main") && a.kind != kind_name("workspace") {
            continue;
        }
        match sessions.iter().find(|s| s.id == a.id) {
            Some(s) => {
                a.pid = s.pid;
                a.gone = false;
                if a.host.is_empty() || !cli_used {
                    a.host = s.status.clone();
                }
                if a.cwd.is_empty() {
                    a.cwd = s.cwd.clone();
                }
            }
            None => {
                a.pid = 0;
                if !cli_used {
                    a.gone = true;
                }
            }
        }
    }
}

// ---- Codex --------------------------------------------------------------------------------------------------

fn newest_dirs(p: &Path, n: usize) -> Vec<PathBuf> {
    let mut d: Vec<PathBuf> = read_dir(p).into_iter().filter(|x| x.is_dir()).collect();
    d.sort();
    d.reverse();
    d.truncate(n);
    d
}

/// Codex sessions: the rollout files of the newest day directories written to inside the active window, newest first.
pub(super) fn codex_found(env: &Env) -> Vec<super::sources::Found> {
    let root = env.home.join(pth("codex"));
    let cutoff = env.now_ms.saturating_sub(lim("active_window_ms"));
    let prefix = pth("rollout_prefix");
    let ext = pth("transcript_ext");
    let mut out = Vec::new();
    // year / month / day directories: the newest `codex_days` days overall
    let days: Vec<PathBuf> = newest_dirs(&root, usize::MAX)
        .into_iter()
        .flat_map(|y| newest_dirs(&y, usize::MAX))
        .flat_map(|m| newest_dirs(&m, usize::MAX))
        .take(lim("codex_days") as usize)
        .collect();
    for day in days {
        for f in read_dir(&day) {
            let name = f.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            let Some(rest) = name.strip_prefix(prefix).and_then(|n| n.strip_suffix(ext)) else { continue };
            let Some(id) = rest.get(lim("rollout_stamp_len") as usize..).filter(|i| !i.is_empty()) else { continue };
            let Some(m) = mtime_ms(&f).map(|m| m as u64).filter(|m| *m >= cutoff) else { continue };
            out.push(super::sources::Found {
                id: id.to_string(),
                kind: kind_name("codex"),
                parent: id.to_string(),
                name: String::new(),
                path: f.to_string_lossy().to_string(),
                mtime: m,
                team: String::new(),
                finished: false,
            });
        }
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.mtime));
    out.truncate(lim("max_codex") as usize);
    out
}

/// The first line of a rollout (its session metadata), bounded.
fn first_line(path: &str) -> Option<Value> {
    let mut buf = Vec::new();
    std::fs::File::open(path).ok()?.take(lim("codex_first_line_max")).read_to_end(&mut buf).ok()?;
    let end = buf.iter().position(|b| *b == b'\n')?;
    serde_json::from_slice(&buf[..end]).ok()
}

/// The end of a rollout, bounded.
fn tail(path: &str) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    f.seek(SeekFrom::Start(len.saturating_sub(lim("codex_tail_bytes")))).ok()?;
    let mut buf = Vec::new();
    f.take(lim("codex_tail_bytes")).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Whether the last turn marked in `text` has ended: the latest record of a start or a terminal type decides.
fn turn_ended(cx: &V, text: &str) -> bool {
    let at = |kind: &str| -> Option<usize> {
        let types = cx.get(kind).map(V::strings).unwrap_or_default();
        types.iter().filter_map(|t| text.rfind(&cx.str_field("marker").replace("{}", t))).max()
    };
    match (at("terminal_types"), at("start_types")) {
        (Some(t), Some(s)) => t > s,
        (Some(_), None) => true,
        _ => false,
    }
}

/// A Codex session's state from its rollout file: running while it is being written, waiting after, done when its one-shot run
/// ended or it has been quiet too long. Its transcript format is not the Claude one, so no tokens or tool calls are read: only the
/// state, the working directory and the age. The file is read again only when its mtime or size changed.
pub(super) fn codex_state(env: &Env, a: &mut Agent, mtime: u64) {
    let cx = defaults::raw("agent_tracker.codex");
    a.source = defaults::raw("agent_tracker.sources").str_field("codex").into();
    a.last_output_ms = mtime;
    let quiet = env.now_ms.saturating_sub(mtime);
    a.running = quiet <= lim("codex_running_ms");
    let size = std::fs::metadata(&a.path).map(|m| m.len()).unwrap_or(0);
    if a.codex_stamp != (mtime, size) {
        if let Some(v) = first_line(&a.path)
            && v.get(cx.str_field("type_key")).and_then(Value::as_str) == Some(cx.str_field("meta_type"))
        {
            let p = v.get(cx.str_field("payload"));
            if a.cwd.is_empty() {
                a.cwd = p.and_then(|p| p.get(cx.str_field("cwd"))).and_then(Value::as_str).unwrap_or("").to_string();
            }
            let origin = p.and_then(|p| p.get(cx.str_field("originator"))).and_then(Value::as_str).unwrap_or("");
            a.codex_exec = cx.get("exec_originators").map(V::strings).unwrap_or_default().iter().any(|o| *o == origin);
        }
        a.codex_terminal = tail(&a.path).is_some_and(|t| turn_ended(&cx, &t));
        a.codex_stamp = (mtime, size);
    }
    // done: a one-shot run whose turn ended, a one-shot run quiet past codex_done_after_ms, or any rollout quiet past codex_stale_after_ms
    // (a limit of 0 is off: it is what a missing key reads as)
    let past = |k: &str| lim(k) > 0 && quiet > lim(k);
    a.finished |= (a.codex_exec && (a.codex_terminal || past("codex_done_after_ms"))) || past("codex_stale_after_ms");
    if a.finished {
        a.running = false;
    }
}
