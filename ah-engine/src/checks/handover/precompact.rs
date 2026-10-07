//! Built-in `check = "precompact-snapshot"`: port of `hooks/precompact-snapshot.js` (PreCompact).
//!
//! Right before a compaction, write a mechanical snapshot of the session's continuation state to
//! `<repo>/.anti-hall/handovers/<date>/<session>/PRECOMPACT-<n>.md`: git state, the task list read back from the
//! transcript, the last user messages verbatim, and the newest handover. It never blocks the compaction and prints
//! nothing; on any error it just writes no snapshot.
use super::find::{self, Cand, Kind, Unsure};
use super::transcript::{self, Task};
use crate::checks::git::util::path_join;
use crate::checks::guardkit::settings::{get_bool, is_skipped};
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::text::{self as jstext, member, str_member};
use crate::checks::jsport::{date, fsx, gitrun, home};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;

/// The repository facts of the snapshot.
struct GitState {
    branch_line: String,
    head: String,
    dirty: Vec<String>,
}

fn git_state(cwd: &str, env: &RequestEnv) -> Option<GitState> {
    let timeout = defaults::millis("codex_handover.precompact_git_timeout_ms");
    let status = gitrun::git(cwd, &defaults::list("codex_handover.argv_status"), timeout, env)?;
    let lines: Vec<&str> = status.split('\n').filter(|l| !l.is_empty()).collect();
    let branch_prefix = defaults::text("codex_handover.branch_prefix");
    let branch_line = match lines.first() {
        Some(l) if l.starts_with(branch_prefix) => l[branch_prefix.len()..].to_string(),
        _ => defaults::text("codex_handover.branch_unknown").to_string(),
    };
    let dirty = lines.iter().filter(|l| !l.starts_with(branch_prefix)).map(|l| l.to_string()).collect();
    let head = gitrun::git(cwd, &defaults::list("codex_handover.argv_log"), timeout, env)
        .map(|h| js_trim(&h).to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| defaults::text("codex_handover.head_none").to_string());
    Some(GitState { branch_line, head, dirty })
}

/// `readTail`: the last window of the transcript as lines, the first dropped when it may be cut. `None` for a missing,
/// unreadable or empty file.
pub fn read_tail(path: &str) -> Option<Vec<String>> {
    use std::io::{Read, Seek, SeekFrom};
    let cap = defaults::num("codex_handover.transcript_tail_bytes");
    let mut f = std::fs::File::open(path).ok()?;
    let size = f.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let n = size.min(cap);
    f.seek(SeekFrom::Start(size - n)).ok()?;
    let mut buf = vec![0u8; n as usize];
    let got = f.read(&mut buf).ok()?;
    buf.truncate(got);
    let text = String::from_utf8_lossy(&buf).into_owned();
    let mut lines: Vec<String> = text.split('\n').map(str::to_string).collect();
    if size > n {
        lines.remove(0);
    }
    Some(lines)
}

struct Ctx<'a> {
    session: &'a str,
    n: u64,
    cwd: &'a str,
    now_iso: String,
    trigger: &'a str,
    custom: String,
    handover: Option<Cand>,
    git: Option<GitState>,
    tasks: Option<Vec<Task>>,
    messages: Vec<transcript::Msg>,
}

fn build(c: &Ctx<'_>) -> Result<String, Unsure> {
    let r = |k: &str, a: &[(&str, &str)]| crate::checks::guardkit::msg::render(k, a);
    let mut l: Vec<String> = Vec::new();
    l.push(r("codex_handover.snap_title", &[("session", c.session), ("n", &c.n.to_string()), ("now", &c.now_iso)]));
    l.push(String::new());
    l.push(r("codex_handover.snap_intro", &[("trigger", c.trigger)]));
    l.push(String::new());
    l.push(defaults::text("codex_handover.snap_h_handover").to_string());
    l.push(match &c.handover {
        Some(h) => r("codex_handover.snap_handover_found", &[("path", &h.file_path), ("modified", &date::to_iso(h.mtime_ms).ok_or(Unsure)?)]),
        None => defaults::text("codex_handover.snap_handover_none").to_string(),
    });
    l.push(String::new());
    l.push(defaults::text("codex_handover.snap_h_repo").to_string());
    l.push(r("codex_handover.snap_pwd", &[("cwd", c.cwd)]));
    match &c.git {
        None => l.push(defaults::text("codex_handover.snap_not_git").to_string()),
        Some(g) => {
            l.push(r("codex_handover.snap_branch", &[("branch", &g.branch_line)]));
            l.push(r("codex_handover.snap_head", &[("head", &g.head)]));
            let clean = if g.dirty.is_empty() { defaults::text("codex_handover.snap_clean") } else { "" };
            l.push(r("codex_handover.snap_dirty", &[("count", &g.dirty.len().to_string()), ("clean", clean)]));
            let max = defaults::num("codex_handover.max_dirty_listed") as usize;
            for d in g.dirty.iter().take(max) {
                l.push(format!("{}{d}", defaults::text("codex_handover.snap_indent")));
            }
            if g.dirty.len() > max {
                l.push(r("codex_handover.snap_more", &[("count", &(g.dirty.len() - max).to_string())]));
            }
        }
    }
    if !c.custom.is_empty() {
        l.push(String::new());
        l.push(defaults::text("codex_handover.snap_h_custom").to_string());
        l.push(c.custom.clone());
    }
    l.push(String::new());
    l.push(defaults::text("codex_handover.snap_h_tasks").to_string());
    match &c.tasks {
        None => l.push(defaults::text("codex_handover.snap_tasks_none").to_string()),
        Some(t) if t.is_empty() => l.push(defaults::text("codex_handover.snap_tasks_empty").to_string()),
        Some(t) => {
            l.push(defaults::text("codex_handover.snap_table_head").to_string());
            l.push(defaults::text("codex_handover.snap_table_rule").to_string());
            for x in t {
                l.push(r(
                    "codex_handover.snap_table_row",
                    &[("id", &transcript::cell(&x.id)), ("subject", &transcript::cell(&x.subject)), ("status", &transcript::cell(&x.status))],
                ));
            }
        }
    }
    l.push(String::new());
    l.push(r("codex_handover.snap_h_messages", &[("count", &c.messages.len().to_string())]));
    if c.messages.is_empty() {
        l.push(defaults::text("codex_handover.snap_messages_none").to_string());
    }
    let cap = defaults::num("codex_handover.max_message_chars") as usize;
    for (i, m) in c.messages.iter().enumerate() {
        l.push(String::new());
        let ts = if m.ts.is_empty() { String::new() } else { format!("{}{}", defaults::text("codex_handover.snap_ts_sep"), m.ts) };
        l.push(r("codex_handover.snap_msg_head", &[("i", &(i + 1).to_string()), ("ts", &ts)]));
        l.push(defaults::text("codex_handover.snap_fence_open").to_string());
        let len = jstext::len16(&m.text);
        if len > cap {
            l.push(r("codex_handover.snap_truncated", &[("head", &jstext::slice16_lossy(&m.text, cap)), ("count", &(len - cap).to_string())]));
        } else {
            l.push(m.text.clone());
        }
        l.push(defaults::text("codex_handover.snap_fence_close").to_string());
    }
    l.push(String::new());
    Ok(l.join("\n"))
}

/// The check's decision on one payload.
pub fn decide(p: &Value, env: &RequestEnv) -> Result<Option<Verdict>, Unsure> {
    let _zone = crate::checks::jsport::date::ZoneGuard::new(env);
    let st = crate::checks::codex::settings_of(env);
    if !get_bool(&st, defaults::raw("codex_handover.setting_precompact")) {
        return Ok(None);
    }
    if !p.is_object() {
        return Ok(None);
    }
    let present = |k: &str| member(p, k).is_some_and(|v| !v.is_null());
    if present("agent_id") || present("agent_type") || is_skipped(&st, defaults::text("codex_handover.precompact_guard")) {
        return Ok(None);
    }
    let Some(cwd) = str_member(p, "cwd").filter(|c| !c.is_empty()) else { return Ok(None) };
    let Some(home) = home::resolve(env) else { return Err(Unsure) };
    let session = jstext::sanitize_session(&jstext::string_or_empty(member(p, "session_id")), defaults::text("codex_handover.unknown_session"));
    let root = find::handovers_root(cwd, &home, env)?;
    let dir = path_join(&path_join(&root, &find::local_date()?), &session);
    let tp = str_member(p, "transcript_path");
    if tp.is_some_and(|t| !t.is_empty() && !t.starts_with('/')) {
        return Err(Unsure); // relative to the hook's own working directory, which is not known here
    }
    let lines = tp.and_then(read_tail);
    let refs: Vec<&str> = lines.as_ref().map(|v| v.iter().map(String::as_str).collect()).unwrap_or_default();
    let handover = find::newest_handover(&root, &session)?;
    if !fsx::mkdir_p(&dir) {
        return Ok(None);
    }
    let mut n: u64 = 1;
    if let Some(names) = fsx::read_dir_names(&dir) {
        for (f, _) in names {
            if let Some(Some(d)) = find::match_name(&f, Kind::Precompact) {
                if d.len() > defaults::num("codex_handover.seq_max_digits") as usize {
                    return Err(Unsure);
                }
                n = n.max(d.parse::<u64>().unwrap_or(0) + 1);
            }
        }
    }
    let tail_known = lines.is_some();
    let ctx = Ctx {
        session: &session,
        n,
        cwd,
        now_iso: date::to_iso(date::now_ms()).ok_or(Unsure)?,
        trigger: match str_member(p, "trigger") {
            Some(t) if defaults::list("codex_handover.triggers").contains(&t) => t,
            _ => defaults::text("codex_handover.trigger_unknown"),
        },
        custom: str_member(p, "custom_instructions").map(js_trim).filter(|s| !s.is_empty()).unwrap_or("").to_string(),
        handover,
        git: git_state(cwd, env),
        tasks: if tail_known { transcript::task_snapshot(&refs)? } else { None },
        messages: if tail_known { transcript::user_messages(&refs, defaults::num("codex_handover.max_user_messages") as usize)? } else { Vec::new() },
    };
    let body = build(&ctx)?;
    let file = path_join(&dir, &format!("{}{n}{}", defaults::text("codex_handover.precompact_prefix"), defaults::text("codex_handover.md_suffix")));
    // 'wx': never overwrite an existing snapshot.
    let _ = std::fs::OpenOptions::new().write(true).create_new(true).open(&file).and_then(|mut f| std::io::Write::write_all(&mut f, body.as_bytes()));
    Ok(None)
}

/// The registered `precompact-snapshot` check.
pub struct PrecompactSnapshot;

impl Check for PrecompactSnapshot {
    fn name(&self) -> &'static str {
        "precompact-snapshot"
    }

    fn summary(&self) -> &'static str {
        defaults::text("codex_handover.precompact_summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        match decide(payload, env) {
            Ok(v) => v.or(Some(Verdict::Allow)),
            Err(Unsure) => Some(Verdict::Defer),
        }
    }
}
