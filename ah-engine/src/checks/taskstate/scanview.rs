//! The task view of the tasklist Stop gate's transcript pass (`tasklist-guard.js` `scanTranscript`, the task part): whether any
//! task tool was used, whether the task store was reset, and the open and in-progress tasks. It differs from the guard and state
//! reconstructions ([`super::parse`]) in what it keeps (no owners, blockers or descriptions; a TaskCreate waits for its result's
//! number, a TodoWrite replaces the list), so it has its own pass. The work counting of the same hook pass is a rule and lives in
//! the plugin's script, not here.
use super::backfill::backfill;
use super::parse::{Facts, collect_tool_uses, is_not_found, maybe_valid_for_js};
use super::tail::{lines_of, read_tail};
use super::{Task, TaskMap, Unknown, norm_priority, number_of_digits, priority_field, truthy_status};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure, first_truthy, get, scalar_string, truthy};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;

/// A TaskCreate waiting for its result: subject, status and priority.
type CreateRec = (String, String, Option<String>);

/// What the pass found about tasks.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct ScanTasks {
    /// A TaskCreate, TaskUpdate or TodoWrite was seen (also anywhere in the wide window when the tail held none).
    pub saw_task_activity: bool,
    /// A TaskGet or TaskUpdate came back "not found".
    pub task_store_reset: bool,
    /// Tasks in progress at an actionable priority.
    pub in_progress_count: u64,
    /// Ids of the open tasks, in task-list order.
    pub open_task_ids: Vec<String>,
}

fn created_re() -> &'static Regex {
    static R: crate::defaults::Cache<Regex> = crate::defaults::Cache::new();
    R.get_or_init(|| jsre::compile(defaults::text("taskstate.re_created"), true))
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

/// `hasTaskActivityInText` over the last `window` bytes of a file, read one line at a time: the widened scan covers 16 MB and
/// holding that as one string was the biggest transient the daemon had. `None` when the file cannot be read.
fn has_task_activity_in_file(path: &str, window: u64) -> Option<R<bool>> {
    use std::io::{BufRead, Seek, SeekFrom};
    let size = std::fs::metadata(path).ok()?.len();
    let mut f = std::fs::File::open(path).ok()?;
    crate::load::note_scan(size.min(window));
    if size > window {
        f.seek(SeekFrom::Start(size - window)).ok()?;
    }
    let mut rd = std::io::BufReader::new(f);
    let names = defaults::list("tasklist_guard.task_tool_names");
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return Some(Ok(false)),
            Ok(_) => {}
        }
        if buf.last() == Some(&b'\n') {
            buf.pop();
        }
        // only a line that names a task tool can matter; the rest is skipped without decoding
        if !names.iter().any(|n| buf.windows(n.len()).any(|w| w == n.as_bytes())) {
            continue;
        }
        let line = String::from_utf8_lossy(&buf).into_owned();
        let line = line.strip_suffix('\r').unwrap_or(&line);
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        let entry = match serde_json::from_str::<Value>(t) {
            Ok(e) => e,
            Err(_) if maybe_valid_for_js(t) => return Some(Err(Unsure)),
            Err(_) => continue,
        };
        let mut uses = Vec::new();
        collect_tool_uses(&entry, &mut uses);
        if uses.iter().any(|tu| get(tu, "name").and_then(Value::as_str).is_some_and(|n| names.contains(&n))) {
            return Some(Ok(true));
        }
    }
}

/// The pass. `Ok(None)` is the quiet end (a JSON `null` entry makes the Node hook throw, so it decides nothing). `window` is
/// the tail read, `wide` the widened window searched for task activity when a cut tail holds none.
pub fn scan_tasks(path: &str, window: u64, wide: u64) -> R<Option<ScanTasks>> {
    let Some((data, truncated)) = read_tail(path, window) else { return Ok(Some(ScanTasks::default())) };
    let lines = lines_of(&data, truncated);
    let empty = Value::Object(serde_json::Map::new());
    let mut s = ScanTasks::default();
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
        let mut uses = Vec::new();
        collect_tool_uses(&entry, &mut uses);
        for tu in uses {
            let name = get(tu, "name").and_then(Value::as_str).unwrap_or("");
            let inp: &Value = match get(tu, "input") {
                Some(v) if truthy(v) && v.is_object() => v,
                _ => &empty,
            };
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
                    let rec = (content, status, norm_priority(priority_field(inp))?);
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
                        let priority = if has_pri { norm_priority(priority_field(inp))? } else { existing.priority.clone() };
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
    if !s.saw_task_activity
        && truncated
        && let Some(found) = has_task_activity_in_file(path, wide)
        && found?
    {
        s.saw_task_activity = true;
    }
    Ok(Some(s))
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
    if super::has_blocked_on_update(inp) {
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
        since: Default::default(),
    }
}
