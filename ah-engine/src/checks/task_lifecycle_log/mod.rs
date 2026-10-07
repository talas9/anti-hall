//! Built-in `check = "task-lifecycle-log"`: a port of the Node task-lifecycle-log hook (TaskCreated and TaskCompleted).
//!
//! The hook is log-only: it appends one line per task event to the per-session history ledger
//! `<root>/.anti-hall/history/<UTC date>/<session>.md` and registers that file once in `<root>/.anti-hall/history/INDEX.md`.
//! It never prints and never blocks, so the verdict is always an allow; the work is the file effects, which this check
//! performs itself (the Node hook is then not run).
//!
//! A payload the Node hook would write for but this check cannot reproduce byte for byte (a relative `cwd`, a field cut
//! through a surrogate pair, a number whose JavaScript text differs) defers to Node. The project root follows
//! [`taskkit::root::repo_root`].
//!
//! Mirrors `hooks/task-lifecycle-log.js` and `hooks/session-history-index.js`.
use crate::checks::git::util::Settings;
use crate::checks::guardkit::paths::join;
use crate::checks::guardkit::settings::get_bool;
use crate::checks::taskkit::{self, root, time};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::io::Write;

#[cfg(test)]
mod tests;

/// The decision for one payload at `now_ms`: `Some(Allow)` after doing what Node does (or nothing, where Node does
/// nothing), `Some(Defer)` when Node must decide.
pub fn decide(p: &Value, st: &Settings, now_ms: i64) -> Verdict {
    if !get_bool(st, defaults::raw("task_lifecycle_log.setting")) {
        return Verdict::Allow;
    }
    let Some(obj) = p.as_object() else { return Verdict::Allow };
    let event = obj.get("hook_event_name").and_then(Value::as_str).unwrap_or("");
    if !defaults::list("task_lifecycle_log.events").contains(&event) {
        return Verdict::Allow;
    }
    let Some(cwd) = obj.get("cwd").and_then(Value::as_str).filter(|c| !c.is_empty()) else { return Verdict::Allow };
    let present = |k: &str| obj.get(k).filter(|v| !v.is_null());
    let Some(task_id_raw) = present("task_id").map_or(Some(String::new()), taskkit::js_string) else { return Verdict::Defer };
    let max = |k: &str| defaults::num(k) as usize;
    let Some(task_id) = taskkit::sanitize_text(&Value::String(task_id_raw), max("task_lifecycle_log.task_id_max")) else { return Verdict::Defer };
    if task_id.is_empty() {
        return Verdict::Allow;
    }
    let Some(sid_raw) = present("session_id").map_or(Some(String::new()), taskkit::js_string) else { return Verdict::Defer };
    let sid = taskkit::session_path_id(&sid_raw);
    // `payload.task_subject || ''`: only a truthy string survives, and a non-string is emptied by the sanitizer anyway.
    let field = |k: &str, m: &str| taskkit::sanitize_text(obj.get(k).unwrap_or(&Value::Null), max(m));
    let (Some(subject), Some(teammate)) = (field("task_subject", "task_lifecycle_log.subject_max"), field("teammate_name", "task_lifecycle_log.teammate_max"))
    else {
        return Verdict::Defer;
    };
    let iso = time::iso(now_ms);
    let date = &iso[..10];
    let sep = defaults::text("task_lifecycle_log.separator");
    let mut line = format!("- {iso}{sep}{event}{sep}task_id={task_id}");
    if !teammate.is_empty() {
        line.push_str(&format!("{sep}teammate={teammate}"));
    }
    if !subject.is_empty() {
        line.push_str(&format!("{sep}{subject}"));
    }
    let Some(root) = root::repo_root(cwd, &st.home) else { return Verdict::Defer };
    write_ledger(&root, date, &sid, &line);
    Verdict::Allow
}

/// The ledger append and the index registration; every failure stops quietly, as the Node `try` does.
fn write_ledger(root: &str, date: &str, sid: &str, line: &str) {
    let mut dir = root.to_string();
    for seg in defaults::list("task_lifecycle_log.history_dir") {
        dir = join(&dir, seg);
    }
    let history_dir = join(&dir, date);
    if std::fs::create_dir_all(&history_dir).is_err() {
        return;
    }
    let ext = defaults::text("task_lifecycle_log.ledger_ext");
    let ledger = join(&history_dir, &format!("{sid}{ext}"));
    if append(&ledger, &format!("{line}\n")).is_err() {
        return;
    }
    let index = join(&dir, defaults::text("task_lifecycle_log.index_name"));
    let sep = defaults::text("task_lifecycle_log.separator");
    let index_line = format!("- {date}{sep}{sid}{sep}[history](../{date}/{sid}{ext})");
    append_index_line_if_absent(&index, sid, &index_line);
}

fn append(path: &str, text: &str) -> std::io::Result<()> {
    std::fs::OpenOptions::new().append(true).create(true).open(path)?.write_all(text.as_bytes())
}

/// `appendIndexLineIfAbsent`: nothing when the index already mentions the session id anywhere.
pub fn append_index_line_if_absent(index: &str, sid: &str, line: &str) {
    let existing = std::fs::read(index).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    if existing.contains(sid) {
        return;
    }
    if let Some(parent) = std::path::Path::new(index).parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return;
    }
    let _ = append(index, &format!("{line}\n"));
}

/// The registered `task-lifecycle-log` check.
pub struct TaskLifecycleLog;

impl Check for TaskLifecycleLog {
    fn name(&self) -> &'static str {
        "task-lifecycle-log"
    }

    fn summary(&self) -> &'static str {
        defaults::text("task_lifecycle_log.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, &Settings::from_env(env), time::now_ms()))
    }
}
