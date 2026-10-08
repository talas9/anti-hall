//! Reconstruct the task list from the lines of a transcript tail.
//!
//! Mirrors `task-guard.js` `parseTasksFromFile` (variant [`Variant::Guard`]) and `lib/task-state.js` `reconstructTasks`
//! (variant [`Variant::State`]). The two differ in: the State variant skips lines that do not contain `Task` or `TodoWrite`
//! before parsing them, keeps and updates a task's description and subject, and builds its end-of-scan records differently;
//! the Guard variant parses every line. Both keep a list epoch (a numbering restart, a `TaskList` that says "No tasks
//! found", a TodoWrite) and drop a single id the harness reports as not found.
use super::{
    Since, Task, TaskMap, Unknown, Variant, blocked_by_after_update, create_blocked_on, has_blocked_on_update, has_priority_update, norm_blocked_by,
    norm_owner, norm_priority, number_of_digits, priority_field, truthy_status,
};
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure, first_truthy, get, scalar_string, truthy};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;

/// What a reconstruction found.
#[derive(Clone, Debug)]
pub struct Facts {
    /// The tasks, in the order JavaScript's `Map` would hold them.
    pub tasks: TaskMap,
    /// A real list reset happened inside the window (no recovery from before it is possible).
    pub window_reset: bool,
    /// The lowest task number created inside the window (`Infinity` when none).
    pub first_created: f64,
}

struct Res {
    created: Regex,
    list_empty: Regex,
    not_found: Regex,
    since_status: Regex,
}

fn res() -> &'static Res {
    static R: crate::defaults::Cache<Res> = crate::defaults::Cache::new();
    R.get_or_init(|| Res {
        created: jsre::compile(defaults::text("taskstate.re_created"), true),
        list_empty: jsre::compile(defaults::text("taskstate.re_list_empty"), true),
        not_found: jsre::compile(defaults::text("taskstate.re_not_found"), true),
        since_status: jsre::compile(defaults::text("taskstate.since_status_re"), true),
    })
}

/// `isTaskListEmptyText`.
pub fn is_list_empty(s: &str) -> bool {
    res().list_empty.is_match(s)
}

/// `isTaskNotFoundText`.
pub fn is_not_found(s: &str) -> bool {
    res().not_found.is_match(s)
}

/// Whether a line `serde_json` refused might still be valid for `JSON.parse` (see [`jsdiff`](crate::checks::guardkit::jsdiff)); any
/// other bad line is invalid for JavaScript too and is skipped, as the Node code skips it.
pub fn maybe_valid_for_js(line: &str) -> bool {
    crate::checks::guardkit::jsdiff::js_reads_differently_str(line)
}

/// The tool uses inside an entry (`collectToolUses`): the node itself when it is a tool use with a name, then everything
/// under `content`, `message`, `messages`, `tool_uses` and `parts`.
pub fn collect_tool_uses<'a>(node: &'a Value, out: &mut Vec<&'a Value>) {
    let Value::Object(o) = node else { return };
    if o.get("type").and_then(Value::as_str) == Some("tool_use") && o.get("name").is_some_and(truthy) {
        out.push(node);
    }
    for key in defaults::list("taskstate.tools_collect_keys") {
        match o.get(key) {
            Some(Value::Array(a)) => a.iter().for_each(|it| collect_tool_uses(it, out)),
            Some(v @ Value::Object(_)) => collect_tool_uses(v, out),
            _ => {}
        }
    }
}

/// What the tool use `id` was: its name, the task id it named and its message id.
struct Call {
    name: String,
    task_id: Option<String>,
    msg_id: Option<String>,
}

/// A TaskCreate seen in an assistant record, waiting for its result to give it a number.
#[derive(Clone)]
struct Prov {
    content: String,
    description: String,
    status: String,
    owner: String,
    blocked_by: Vec<String>,
    blocked_on: Option<Value>,
    /// The priority label (the guard variant only).
    priority: Option<String>,
    /// The time of the record (the guard variant only).
    since: Since,
}

fn assign_fill(ex: &Task, rec: &Prov) -> Task {
    let mut t = ex.clone();
    if let Some(u) = ex.unknown {
        if u.status {
            t.status = Some(rec.status.clone());
        }
        if u.owner {
            t.owner = rec.owner.clone();
        }
        if u.blocked_by {
            let mut merged: Vec<String> = Vec::new();
            for id in rec.blocked_by.iter().chain(ex.blocked_by.iter()) {
                if !merged.contains(id) {
                    merged.push(id.clone());
                }
            }
            t.blocked_by = merged;
        }
        if u.blocked_on {
            t.blocked_on = rec.blocked_on.clone();
        }
    }
    t.unknown = None;
    t
}

fn gaps_after_update(unknown: Option<Unknown>, inp: &Value) -> Option<Unknown> {
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
    if has_blocked_on_update(inp) {
        u.blocked_on = false;
    }
    u.any().then_some(u)
}

/// The id a TaskUpdate names: `taskId`, else `id`, else `task_id`, each only when not null.
fn update_id(inp: &Value) -> R<Option<String>> {
    for k in defaults::list("taskstate.id_keys") {
        if let Some(v) = get(inp, k).filter(|v| !v.is_null()) {
            return Ok(Some(scalar_string(v)?));
        }
    }
    Ok(None)
}

/// Reconstruct from the lines of a tail (the first, partial, line already removed by the caller).
pub fn reconstruct(lines: &[&str], variant: Variant) -> R<Facts> {
    let empty = Value::Object(serde_json::Map::new());
    let mut prov: Vec<(String, Prov)> = Vec::new(); // JavaScript Map order
    let mut tasks = TaskMap::default();
    let mut result_ids: Vec<(String, String)> = Vec::new(); // tool_use_id -> "N", insertion ordered
    let mut max_created = 0f64;
    let mut group_msg: Option<String> = None;
    let mut group_base = 0f64;
    let mut window_reset = false;
    let mut first_created = f64::INFINITY;
    let mut calls: HashMap<String, Call> = HashMap::new();

    for line in lines {
        let t = js_trim(line);
        if t.is_empty() {
            continue;
        }
        if variant == Variant::State && !t.contains("Task") && !t.contains("TodoWrite") {
            continue;
        }
        let entry: Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) if maybe_valid_for_js(t) => return Err(Unsure),
            Err(_) => continue,
        };
        // `entry.type` on a JSON `null` throws in JavaScript.
        if entry.is_null() {
            return Err(Unsure);
        }
        if get(&entry, "type").and_then(Value::as_str) == Some("user") {
            let content = get(&entry, "message").and_then(|m| get(m, "content")).and_then(Value::as_array);
            for it in content.into_iter().flatten() {
                if get(it, "type").and_then(Value::as_str) != Some("tool_result") {
                    continue;
                }
                let Some(use_id) = get(it, "tool_use_id").and_then(Value::as_str) else { continue };
                let txt = get(it, "content").and_then(Value::as_str).unwrap_or("");
                let call = calls.get(use_id);
                let call_name = call.map_or("", |c| c.name.as_str());
                if call_name == "TaskList" && is_list_empty(txt) {
                    tasks.clear();
                    prov.clear();
                    result_ids.clear();
                    max_created = 0.0;
                    window_reset = true;
                } else if (call_name == "TaskGet" || call_name == "TaskUpdate")
                    && is_not_found(txt)
                    && let Some(bad) = call.and_then(|c| c.task_id.clone())
                {
                    tasks.delete(&bad);
                    let drop: Vec<String> = result_ids.iter().filter(|(_, nid)| *nid == bad).map(|(tid, _)| tid.clone()).collect();
                    for tid in drop {
                        result_ids.retain(|(k, _)| *k != tid);
                        prov.retain(|(k, _)| *k != tid);
                    }
                }
                let m = if call_name == "TaskCreate" { res().created.captures(txt) } else { None };
                if let Some(m) = m
                    && !result_ids.iter().any(|(k, _)| k == use_id)
                {
                    let digits = m.get(1).map_or("", |g| g.as_str()).to_string();
                    let n = number_of_digits(&digits);
                    let mid = call.and_then(|c| c.msg_id.clone()).filter(|m| !m.is_empty());
                    if !(mid.is_some() && mid == group_msg) {
                        group_msg = mid;
                        group_base = max_created.max(tasks.max_numeric_key());
                    }
                    if n <= group_base {
                        tasks.clear();
                        let resolved: Vec<String> = result_ids.iter().map(|(k, _)| k.clone()).collect();
                        prov.retain(|(k, _)| !resolved.contains(k));
                        result_ids.clear();
                        window_reset = true;
                        max_created = 0.0;
                        group_base = 0.0;
                    }
                    first_created = first_created.min(n);
                    max_created = max_created.max(n);
                    result_ids.push((use_id.to_string(), digits));
                }
            }
        }
        let guard = variant == Variant::Guard;
        let since = if guard { Since::of_entry(&entry) } else { Since::Unknown };
        let mut uses = Vec::new();
        collect_tool_uses(&entry, &mut uses);
        for tu in uses {
            let name = get(tu, "name").and_then(Value::as_str).unwrap_or("");
            let inp0: &Value = match get(tu, "input") {
                Some(v) if truthy(v) && v.is_object() => v,
                _ => &empty,
            };
            if let Some(id_v) = get(tu, "id").filter(|v| truthy(v)) {
                let Value::String(tid) = id_v else { return Err(Unsure) };
                let task_id = match defaults::list("taskstate.id_keys").iter().find_map(|k| get(inp0, k).filter(|v| !v.is_null())) {
                    Some(v) => Some(scalar_string(v)?),
                    None => None,
                };
                let msg_id = get(&entry, "message").and_then(|m| get(m, "id")).and_then(Value::as_str).map(str::to_string);
                calls.insert(tid.clone(), Call { name: name.to_string(), task_id, msg_id });
            }
            match name {
                "TodoWrite" => {
                    if let Some(todos) = get(tu, "input").and_then(|i| get(i, "todos")).and_then(Value::as_array) {
                        window_reset = true;
                        tasks.clear();
                        prov.clear();
                        for todo in todos {
                            // `todo.id` on a null or undefined element throws.
                            if todo.is_null() {
                                return Err(Unsure);
                            }
                            let size = tasks.len().to_string();
                            let size_v = Value::String(size);
                            let id_v = first_truthy(&[get(todo, "id"), get(todo, "content"), Some(&size_v)]).unwrap_or(&size_v);
                            let id = scalar_string(id_v)?;
                            let id_str_v = Value::String(id.clone());
                            let content_v = first_truthy(&[get(todo, "content"), get(todo, "activeForm"), Some(&id_str_v)]);
                            let content = match content_v {
                                Some(v) => scalar_string(v)?,
                                None => id.clone(),
                            };
                            tasks.set(
                                &id,
                                Task {
                                    id: id.clone(),
                                    content,
                                    description: String::new(),
                                    status: Some(truthy_status(get(todo, "status"))?.unwrap_or_else(|| "pending".to_string())),
                                    owner: norm_owner(get(todo, "owner")),
                                    blocked_by: norm_blocked_by(get(todo, "blockedBy"))?,
                                    blocked_on: if guard { todo_blocked_on(todo) } else { None },
                                    priority: if guard { norm_priority(priority_field(todo))? } else { None },
                                    subject_updated: false,
                                    unknown: None,
                                    block_unknown: false,
                                    since,
                                },
                            );
                        }
                    }
                }
                "TaskCreate" => {
                    let inp = inp0;
                    let Some(Value::String(tid)) = get(tu, "id").filter(|v| truthy(v)) else {
                        // `if (tid)`: a create without an id is never recorded.
                        continue;
                    };
                    let tid_v = Value::String(tid.clone());
                    let content_v =
                        first_truthy(&[get(inp, "subject"), get(inp, "title"), get(inp, "content"), get(inp, "description"), Some(&tid_v)]).unwrap_or(&tid_v);
                    let rec = Prov {
                        content: scalar_string(content_v)?,
                        description: match get(inp, "description") {
                            Some(Value::String(s)) if variant == Variant::State => s.clone(),
                            _ => String::new(),
                        },
                        status: truthy_status(get(inp, "status"))?.unwrap_or_else(|| "pending".to_string()),
                        owner: norm_owner(get(inp, "owner")),
                        blocked_by: norm_blocked_by(get(inp, "blockedBy"))?,
                        blocked_on: create_blocked_on(inp),
                        priority: if guard { norm_priority(priority_field(inp))? } else { None },
                        since,
                    };
                    match prov.iter_mut().find(|(k, _)| k == tid) {
                        Some((_, slot)) => *slot = rec,
                        None => prov.push((tid.clone(), rec)),
                    }
                }
                "TaskUpdate" => {
                    let inp = inp0;
                    let Some(id) = update_id(inp)? else { continue };
                    let ex = tasks.get(&id).cloned().unwrap_or_else(|| Task::unseen(&id));
                    let status = match truthy_status(get(inp, "status"))? {
                        Some(s) => Some(s),
                        None => ex.status.clone(),
                    };
                    let subject = get(inp, "subject").and_then(Value::as_str).filter(|s| !s.is_empty());
                    let upd = Task {
                        id: ex.id.clone(),
                        content: if variant == Variant::State { subject.map_or_else(|| ex.content.clone(), str::to_string) } else { ex.content.clone() },
                        description: if variant == Variant::State {
                            match get(inp, "description") {
                                Some(Value::String(s)) => s.clone(),
                                _ => ex.description.clone(),
                            }
                        } else {
                            String::new()
                        },
                        status,
                        owner: if get(inp, "owner").is_some() { norm_owner(get(inp, "owner")) } else { ex.owner.clone() },
                        blocked_by: blocked_by_after_update(&ex.blocked_by, inp)?,
                        blocked_on: if has_blocked_on_update(inp) { create_blocked_on(inp) } else { ex.blocked_on.clone() },
                        priority: match guard {
                            true if has_priority_update(inp) => norm_priority(priority_field(inp))?,
                            true => ex.priority.clone(),
                            false => None,
                        },
                        subject_updated: if variant == Variant::State && subject.is_some() { true } else { variant == Variant::State && ex.subject_updated },
                        unknown: gaps_after_update(ex.unknown, inp),
                        block_unknown: false,
                        // `String(inp.status || '')` against the pending / in-progress pattern; a truthy non-string status was refused above
                        since: match get(inp, "status").and_then(Value::as_str) {
                            Some(s) if guard && res().since_status.is_match(s) => since,
                            _ => ex.since,
                        },
                    };
                    tasks.set(&id, upd);
                }
                _ => {}
            }
        }
    }
    resolve_provisional(&mut tasks, &prov, &result_ids, variant);
    Ok(Facts { tasks, window_reset, first_created })
}

/// `todo.blockedOn` as the TodoWrite record reads it: `todo.metadata.blockedOn` when not null, else `todo.blockedOn`.
fn todo_blocked_on(todo: &Value) -> Option<Value> {
    create_blocked_on(todo)
}

/// The end-of-scan step: every TaskCreate gets the number its result named (or stays under its tool-use id).
fn resolve_provisional(tasks: &mut TaskMap, prov: &[(String, Prov)], result_ids: &[(String, String)], variant: Variant) {
    for (tid, rec) in prov {
        let numeric = result_ids.iter().find(|(k, _)| k == tid).map(|(_, n)| n.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| tid.clone());
        let key = numeric;
        let mut ex = tasks.get(&key).cloned();
        if let Some(e) = &ex
            && e.unknown.is_some()
        {
            let filled = assign_fill(e, rec);
            tasks.set(&key, filled.clone());
            ex = Some(filled);
        }
        if variant == Variant::Guard
            && let Some(e) = ex.as_mut()
        {
            // `if (!(existing.sinceMs >= rec.sinceMs)) existing.sinceMs = rec.sinceMs`: the object in the map is the one changed
            e.since = e.since.merge_create(rec.since);
            if let Some(t) = tasks.get_mut(&key) {
                t.since = e.since;
            }
        }
        match (variant, ex) {
            (_, None) => tasks.set(
                &key,
                Task {
                    id: key.clone(),
                    content: rec.content.clone(),
                    description: if variant == Variant::State { rec.description.clone() } else { String::new() },
                    status: Some(rec.status.clone()),
                    owner: rec.owner.clone(),
                    blocked_by: rec.blocked_by.clone(),
                    blocked_on: rec.blocked_on.clone(),
                    priority: rec.priority.clone(),
                    subject_updated: false,
                    unknown: None,
                    block_unknown: false,
                    since: rec.since,
                },
            ),
            (Variant::Guard, Some(e)) => {
                if e.content.is_empty() || e.content == key {
                    tasks.set(
                        &key,
                        Task {
                            id: key.clone(),
                            content: rec.content.clone(),
                            description: String::new(),
                            status: e.status.clone(),
                            owner: if e.owner.is_empty() { rec.owner.clone() } else { e.owner.clone() },
                            blocked_by: if e.blocked_by.is_empty() { rec.blocked_by.clone() } else { e.blocked_by.clone() },
                            blocked_on: if e.blocked_on.is_some() { e.blocked_on.clone() } else { rec.blocked_on.clone() },
                            priority: e.priority.clone().or_else(|| rec.priority.clone()),
                            subject_updated: false,
                            unknown: None,
                            block_unknown: false,
                            since: e.since,
                        },
                    );
                }
            }
            (Variant::State, Some(e)) => {
                if !e.subject_updated || e.description.is_empty() {
                    tasks.set(
                        &key,
                        Task {
                            id: key.clone(),
                            content: if e.subject_updated { e.content.clone() } else { rec.content.clone() },
                            description: if !e.description.is_empty() { e.description.clone() } else { rec.description.clone() },
                            status: e.status.clone(),
                            owner: if e.owner.is_empty() { rec.owner.clone() } else { e.owner.clone() },
                            blocked_by: if e.blocked_by.is_empty() { rec.blocked_by.clone() } else { e.blocked_by.clone() },
                            blocked_on: if e.blocked_on.is_some() { e.blocked_on.clone() } else { rec.blocked_on.clone() },
                            priority: None,
                            subject_updated: false,
                            unknown: None,
                            block_unknown: false,
                            since: Since::Unknown,
                        },
                    );
                }
            }
        }
    }
}
