//! The single pass over the transcript tail that tasklist-guard makes: work counted, task activity seen, the task list rebuilt
//! and the newest write to the progress file noted. A port of `tasklist-guard.js` `scanTranscript`.
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure, first_truthy, get, scalar_string, truthy};
use crate::checks::taskkit::workdetect::{Ctx, bash_work, is_counted_work, neutralize_quoted};
use crate::checks::taskstate::backfill::backfill;
use crate::checks::taskstate::parse::{Facts, collect_tool_uses, is_not_found, maybe_valid_for_js};
use crate::checks::taskstate::tail::{lines_of, parse_iso_ms, read_tail};
use crate::checks::taskstate::{Task, TaskMap, Unknown, number_of_digits, truthy_status};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

/// A TaskCreate waiting for its result: subject, status and priority.
type CreateRec = (String, String, Option<String>);

/// What the scan found.
#[derive(Debug, Default, Clone)]
pub struct Scan {
    /// Counted file-changing actions.
    pub work_count: u64,
    /// Time (ms) of the newest counted action; 0 when unknown.
    pub last_work_ts: f64,
    /// Time (ms) of the newest write that targets the progress file; 0 when none.
    pub last_progress_write_ts: f64,
    /// A TaskCreate, TaskUpdate or TodoWrite was seen.
    pub saw_task_activity: bool,
    /// A TaskGet or TaskUpdate came back "not found".
    pub task_store_reset: bool,
    /// Tasks in progress at P0 or P1 (anything but a low or deferred priority).
    pub in_progress_count: u64,
    /// Ids of the open tasks, in task-list order.
    pub open_task_ids: Vec<String>,
}

fn created_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("taskstate.re_created"), true))
}

/// `normPriority(p)`: a trimmed string, `None` when absent or blank.
fn norm_priority(v: Option<&Value>) -> R<Option<String>> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(x) => {
            let s = scalar_string(x)?;
            let t = js_trim(&s);
            Ok((!t.is_empty()).then(|| t.to_string()))
        }
    }
}

/// `(inp.metadata != null && inp.metadata.priority != null) ? inp.metadata.priority : inp.priority`.
fn priority_of(inp: &Value) -> Option<&Value> {
    let meta = get(inp, "metadata").filter(|m| !m.is_null());
    meta.and_then(|m| get(m, "priority")).filter(|p| !p.is_null()).or_else(|| get(inp, "priority"))
}

/// `isActionablePriority(p)`.
fn actionable_priority(p: &Option<String>) -> bool {
    match p {
        None => true,
        Some(s) => {
            let t = js_trim(s).to_lowercase();
            t.is_empty() || !defaults::list("tasklist_guard.low_priorities").contains(&t.as_str())
        }
    }
}

/// `commandWritesToPath(cmd, target)`: a redirect whose target is exactly `target`, or a tee, cp or mv whose last argument is.
fn command_writes_to_path(cmd: &str, target: &str) -> bool {
    if target.is_empty() {
        return false;
    }
    let cs: Vec<char> = cmd.chars().collect();
    // first `(?<![0-9&])>{1,2}(?!&)\s*("[^"]*"|'[^']*'|\S+)`
    'outer: for i in 0..cs.len() {
        if cs[i] != '>' || (i > 0 && (cs[i - 1].is_ascii_digit() || cs[i - 1] == '&')) {
            continue;
        }
        let two = cs.get(i + 1) == Some(&'>');
        for len in if two { vec![2usize, 1] } else { vec![1usize] } {
            let after = i + len;
            if cs.get(after) == Some(&'&') {
                continue;
            }
            let mut j = after;
            while j < cs.len() && crate::checks::guardkit::text::is_js_space(cs[j]) {
                j += 1;
            }
            let quoted = |q: char| -> Option<usize> {
                if cs.get(j) != Some(&q) {
                    return None;
                }
                let close = (j + 1..cs.len()).find(|&k| cs[k] == q)?;
                Some(close + 1)
            };
            let end = quoted('"').or_else(|| quoted('\'')).or_else(|| {
                let mut k = j;
                while k < cs.len() && !crate::checks::guardkit::text::is_js_space(cs[k]) {
                    k += 1;
                }
                (k > j).then_some(k)
            });
            let Some(end) = end else { continue };
            let raw: String = cs[j..end].iter().collect();
            let raw = raw.strip_prefix(['"', '\'']).unwrap_or(&raw);
            let raw = raw.strip_suffix(['"', '\'']).unwrap_or(raw);
            if raw == target {
                return true;
            }
            break 'outer;
        }
    }
    // first `\b(?:tee|cp|mv)\b[^;&|\n]*`
    let word = |s: &[char], at: usize, w: &str| -> bool {
        let wc: Vec<char> = w.chars().collect();
        s.get(at..at + wc.len()) == Some(&wc[..]) && !(at > 0 && is_word(s[at - 1])) && !s.get(at + wc.len()).is_some_and(|c| is_word(*c))
    };
    for at in 0..cs.len() {
        if ["tee", "cp", "mv"].iter().any(|w| word(&cs, at, w)) {
            let rest: String = cs[at..].iter().take_while(|c| !matches!(c, ';' | '&' | '|' | '\n')).collect();
            let parts: Vec<&str> = rest.split(crate::checks::guardkit::text::is_js_space).filter(|t| !t.is_empty() && !t.starts_with('-')).collect();
            return parts.last() == Some(&target);
        }
    }
    false
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `hasTaskActivityInText(text)`: some line holds a TaskCreate, TaskUpdate or TodoWrite tool use.
pub(super) fn has_task_activity_in_text(text: &str) -> R<bool> {
    let names = defaults::list("tasklist_guard.task_tool_names");
    if !names.iter().any(|n| text.contains(n)) {
        return Ok(false);
    }
    for line in text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if !names.iter().any(|n| line.contains(n)) {
            continue;
        }
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        let entry = match serde_json::from_str::<Value>(t) {
            Ok(e) => e,
            Err(_) if maybe_valid_for_js(t) => return Err(Unsure),
            Err(_) => continue,
        };
        let mut uses = Vec::new();
        collect_tool_uses(&entry, &mut uses);
        if uses.iter().any(|tu| get(tu, "name").and_then(Value::as_str).is_some_and(|n| names.contains(&n))) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `scanTranscript(path, { progressAbsPath, codex })`. `agent_scan_needed` is set when the answer depends on the running agents
/// (more than one task in progress on a Claude session), which the engine does not scan: the caller defers.
pub fn scan_transcript(path: &str, progress_abs: Option<&str>, codex: bool, cx: Ctx<'_>) -> R<Option<(Scan, bool)>> {
    let window = defaults::num("tasklist_guard.window_bytes");
    let Some((data, truncated)) = read_tail(path, window) else { return Ok(Some((Scan::default(), false))) };
    let lines = lines_of(&data, truncated);
    let empty = Value::Object(serde_json::Map::new());
    let mut s = Scan::default();
    let mut lookup_ids: HashSet<String> = HashSet::new();
    let mut prov: Vec<(String, CreateRec)> = Vec::new();
    let mut tasks = TaskMap::default();
    let mut window_reset = false;
    let mut first_created = f64::INFINITY;
    let mut max_created = 0f64;
    let mut result_ids: Vec<(String, String)> = Vec::new();

    for line in lines {
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        let entry: Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) if maybe_valid_for_js(t) => return Err(Unsure),
            Err(_) => continue,
        };
        // `entry.type` on a JSON null throws in JavaScript and the Node hook exits quietly: no decision, nothing written.
        if entry.is_null() {
            return Ok(None);
        }
        if get(&entry, "type").and_then(Value::as_str) == Some("user") {
            let content = get(&entry, "message").and_then(|m| get(m, "content")).and_then(Value::as_array);
            for it in content.into_iter().flatten() {
                if get(it, "type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(use_id) = get(it, "tool_use_id").and_then(Value::as_str) else { continue };
                let mut text = get(it, "content").and_then(Value::as_str).unwrap_or("").to_string();
                if text.is_empty()
                    && let Some(arr) = get(it, "content").and_then(Value::as_array)
                {
                    text = arr
                        .iter()
                        .filter(|b| get(b, "type").and_then(Value::as_str) == Some("text") && get(b, "text").is_some_and(Value::is_string))
                        .filter_map(|b| get(b, "text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                if let Some(m) = created_re().captures(&text) {
                    let digits = m.get(1).map_or("", |g| g.as_str()).to_string();
                    let n = number_of_digits(&digits);
                    if n <= max_created {
                        window_reset = true;
                    }
                    if first_created == f64::INFINITY {
                        first_created = n;
                    }
                    max_created = max_created.max(n);
                    match result_ids.iter_mut().find(|(k, _)| k == use_id) {
                        Some(slot) => slot.1 = digits,
                        None => result_ids.push((use_id.to_string(), digits)),
                    }
                }
                if lookup_ids.contains(use_id) && is_not_found(&text) {
                    s.task_store_reset = true;
                }
            }
        }
        let entry_ts = match get(&entry, "timestamp") {
            Some(Value::String(ts)) => parse_iso_ms(ts)?,
            _ => None,
        };
        let mut uses = Vec::new();
        collect_tool_uses(&entry, &mut uses);
        for tu in uses {
            let name = get(tu, "name").and_then(Value::as_str).unwrap_or("");
            let inp: &Value = match get(tu, "input") {
                Some(v) if truthy(v) && v.is_object() => v,
                _ => &empty,
            };
            if defaults::list("workdetect.mutating_tools").contains(&name) {
                let fp = get(tu, "input").and_then(|i| get(i, "file_path")).and_then(Value::as_str).unwrap_or("");
                if is_counted_work(tu, cx)? {
                    s.work_count += 1;
                    if let Some(ts) = entry_ts
                        && ts > s.last_work_ts
                    {
                        s.last_work_ts = ts;
                    }
                }
                if let (Some(p), Some(ts)) = (progress_abs, entry_ts)
                    && fp == p
                    && ts > s.last_progress_write_ts
                {
                    s.last_progress_write_ts = ts;
                }
                continue;
            }
            if name == "Bash" {
                let cmd = get(tu, "input").and_then(|i| get(i, "command")).and_then(Value::as_str).unwrap_or("");
                if is_counted_work(tu, cx)? {
                    s.work_count += 1;
                    if let Some(ts) = entry_ts
                        && ts > s.last_work_ts
                    {
                        s.last_work_ts = ts;
                    }
                }
                if let (Some(p), Some(ts)) = (progress_abs, entry_ts)
                    && !cmd.is_empty()
                    && bash_work(&neutralize_quoted(cmd))
                    && command_writes_to_path(cmd, p)
                    && ts > s.last_progress_write_ts
                {
                    s.last_progress_write_ts = ts;
                }
                continue;
            }
            match name {
                "TodoWrite" => {
                    s.saw_task_activity = true;
                    if let Some(todos) = get(tu, "input").and_then(|i| get(i, "todos")).and_then(Value::as_array) {
                        window_reset = true;
                        tasks.clear();
                        prov.clear();
                        for todo in todos {
                            if todo.is_null() {
                                return Ok(None);
                            }
                            let size_v = Value::String(tasks.len().to_string());
                            let id = scalar_string(first_truthy(&[get(todo, "id"), get(todo, "content"), Some(&size_v)]).unwrap_or(&size_v))?;
                            let id_v = Value::String(id.clone());
                            let content = scalar_string(first_truthy(&[get(todo, "content"), get(todo, "activeForm"), Some(&id_v)]).unwrap_or(&id_v))?;
                            tasks.set(&id, task(&id, content, Some(truthy_status(get(todo, "status"))?.unwrap_or_else(|| "pending".into())), None, None));
                        }
                    }
                }
                "TaskCreate" => {
                    s.saw_task_activity = true;
                    let Some(Value::String(tid)) = get(tu, "id").filter(|v| truthy(v)) else {
                        if get(tu, "id").is_some_and(truthy) {
                            return Err(Unsure);
                        }
                        continue;
                    };
                    let tid_v = Value::String(tid.clone());
                    let content = scalar_string(
                        first_truthy(&[get(inp, "subject"), get(inp, "title"), get(inp, "content"), get(inp, "description"), Some(&tid_v)]).unwrap_or(&tid_v),
                    )?;
                    let status = truthy_status(get(inp, "status"))?.unwrap_or_else(|| "pending".into());
                    let rec = (content, status, norm_priority(priority_of(inp))?);
                    match prov.iter_mut().find(|(k, _)| k == tid) {
                        Some(slot) => slot.1 = rec,
                        None => prov.push((tid.clone(), rec)),
                    }
                }
                "TaskUpdate" => {
                    s.saw_task_activity = true;
                    if let Some(Value::String(i)) = get(tu, "id").filter(|v| truthy(v)) {
                        lookup_ids.insert(i.clone());
                    }
                    let id = defaults::list("taskstate.id_keys").iter().find_map(|k| get(inp, k).filter(|v| !v.is_null()));
                    if let Some(idv) = id {
                        let id = scalar_string(idv)?;
                        let existing = tasks.get(&id).cloned().unwrap_or_else(|| Task::unseen(&id));
                        let has_pri =
                            get(inp, "priority").is_some() || get(inp, "metadata").filter(|m| !m.is_null()).and_then(|m| get(m, "priority")).is_some();
                        let priority = if has_pri { norm_priority(priority_of(inp))? } else { existing.priority.clone() };
                        let status = match truthy_status(get(inp, "status"))? {
                            Some(st) => Some(st),
                            None => existing.status.clone(),
                        };
                        let unknown = gaps(existing.unknown, inp);
                        let mut t = task(&existing.id, existing.content.clone(), status, priority, unknown);
                        t.unknown = unknown;
                        tasks.set(&id, t);
                    }
                }
                "TaskGet" => {
                    if let Some(Value::String(i)) = get(tu, "id").filter(|v| truthy(v)) {
                        lookup_ids.insert(i.clone());
                    }
                }
                _ => {}
            }
        }
    }
    // end of scan: every TaskCreate gets the number its result named
    for (tid, (content, status, priority)) in &prov {
        let key = result_ids.iter().find(|(k, _)| k == tid).map(|(_, n)| n.clone()).unwrap_or_else(|| tid.clone());
        let mut ex = tasks.get(&key).cloned();
        if let Some(e) = &ex
            && e.unknown.is_some()
        {
            let mut filled = e.clone();
            if let Some(u) = e.unknown {
                if u.status {
                    filled.status = Some(status.clone());
                }
                if u.owner {
                    filled.owner = String::new();
                }
                if u.blocked_by {
                    filled.blocked_by = e.blocked_by.clone();
                }
                if u.blocked_on {
                    filled.blocked_on = None;
                }
            }
            filled.unknown = None;
            tasks.set(&key, filled.clone());
            ex = Some(filled);
        }
        match ex {
            None => tasks.set(&key, task(&key, content.clone(), Some(status.clone()), priority.clone(), None)),
            Some(e) => {
                if e.content.is_empty() || e.content == key {
                    let st = match &e.status {
                        Some(s) if !s.is_empty() => Some(s.clone()),
                        _ => Some(status.clone()),
                    };
                    tasks.set(&key, task(&key, content.clone(), st, e.priority.clone().or_else(|| priority.clone()), None));
                }
            }
        }
    }
    let mut facts = Facts { tasks, window_reset, first_created };
    if truncated {
        backfill(&mut facts, path, window)?;
    }
    for t in facts.tasks.values() {
        if !t.is_open() {
            continue;
        }
        let st = t.status_lc();
        if st == "in_progress" || st == "in-progress" {
            s.open_task_ids.push(t.id.clone());
            if actionable_priority(&t.priority) {
                s.in_progress_count += 1;
            }
        } else if st == "pending" {
            s.open_task_ids.push(t.id.clone());
        }
    }
    let needs_agents = s.in_progress_count > 1 && !codex;
    if !s.saw_task_activity && truncated {
        let wide = defaults::num("tasklist_guard.wide_window_bytes");
        if let Some((wdata, _)) = read_tail(path, wide)
            && has_task_activity_in_text(&wdata)?
        {
            s.saw_task_activity = true;
        }
    }
    Ok(Some((s, needs_agents)))
}

fn gaps(unknown: Option<Unknown>, inp: &Value) -> Option<Unknown> {
    let mut u = unknown?;
    if get(inp, "status").is_some_and(truthy) {
        u.status = false;
    }
    if get(inp, "owner").is_some() {
        u.owner = false;
    }
    if get(inp, "blockedBy").is_some() {
        u.blocked_by = false;
    }
    if crate::checks::taskstate::has_blocked_on_update(inp) {
        u.blocked_on = false;
    }
    u.any().then_some(u)
}

fn task(id: &str, content: String, status: Option<String>, priority: Option<String>, unknown: Option<Unknown>) -> Task {
    Task {
        id: id.to_string(),
        content,
        description: String::new(),
        status,
        owner: String::new(),
        blocked_by: Vec::new(),
        blocked_on: None,
        priority,
        subject_updated: false,
        unknown,
        block_unknown: false,
    }
}
