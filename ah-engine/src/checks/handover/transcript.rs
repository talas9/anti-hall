//! What the PreCompact snapshot reads out of a transcript tail: the last typed user messages and the task list
//! (`userMessages` and `taskSnapshot` of `hooks/precompact-snapshot.js`).
use super::find::Unsure;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::text::{collapse_ws, js_trim};
use crate::checks::jsport::text::{self as jstext, member, str_member, truthy};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// One typed user message.
#[derive(Debug, Clone, PartialEq)]
pub struct Msg {
    /// The entry's timestamp, or empty.
    pub ts: String,
    /// The trimmed text.
    pub text: String,
}

/// One task row.
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    /// The task id.
    pub id: String,
    /// The subject.
    pub subject: String,
    /// `String(status)`.
    pub status: String,
    /// True when the status is exactly the string `deleted`.
    pub deleted: bool,
}

fn not_typed() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.not_typed_re"), false))
}
fn created_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("codex_handover.task_created_re"), false))
}

/// `textOf(content)`.
fn text_of(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => {
            if a.iter().any(|c| str_member(c, "type") == Some("tool_result")) {
                return String::new();
            }
            a.iter()
                .filter(|c| str_member(c, "type") == Some("text") && str_member(c, "text").is_some())
                .filter_map(|c| str_member(c, "text"))
                .collect::<Vec<_>>()
                .join("\n")
        }
        _ => String::new(),
    }
}

/// The last `max` typed user messages, oldest first.
pub fn user_messages(lines: &[&str], max: usize) -> Result<Vec<Msg>, Unsure> {
    let mut out: Vec<Msg> = Vec::new();
    for line in lines {
        if line.is_empty() || (!line.contains("\"user\"") && !line.contains("user_message")) {
            continue;
        }
        let Some(e) = jstext::parse_line(line).map_err(|_| Unsure)? else { continue };
        if !e.is_object() {
            continue;
        }
        let t = str_member(&e, "type");
        let mut text = String::new();
        let msg = member(&e, "message").filter(|m| truthy(Some(m)));
        if t == Some("user") && !truthy(member(&e, "isMeta")) && !truthy(member(&e, "isSidechain")) && !truthy(member(&e, "isCompactSummary")) && msg.is_some()
        {
            text = text_of(msg.and_then(|m| member(m, "content")));
        } else if t == Some("event_msg")
            && let Some(p) = member(&e, "payload").filter(|p| truthy(Some(p)))
            && str_member(p, "type") == Some("user_message")
            && let Some(m) = str_member(p, "message")
        {
            text = m.to_string();
        }
        let text = js_trim(&text).to_string();
        if text.is_empty() || not_typed().is_match(&text) {
            continue;
        }
        out.push(Msg { ts: str_member(&e, "timestamp").unwrap_or("").to_string(), text });
    }
    let skip = out.len().saturating_sub(max);
    Ok(out.split_off(skip))
}

fn key_of(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.is_empty() => Some(format!("s:{s}")),
        Some(Value::Number(n)) => n.as_f64().map(|f| format!("n:{}", crate::checks::jsport::num::to_js_string(f))),
        Some(Value::Bool(b)) => Some(format!("b:{b}")),
        _ => None,
    }
}

fn status_of(v: Option<&Value>) -> (String, bool) {
    match v {
        Some(x) if truthy(Some(x)) => (jstext::js_string(x), x.as_str() == Some(defaults::text("codex_handover.status_deleted"))),
        _ => (defaults::text("codex_handover.status_pending").to_string(), false),
    }
}

/// The task list of the tail, `None` when no tool call shaped a list.
pub fn task_snapshot(lines: &[&str]) -> Result<Option<Vec<Task>>, Unsure> {
    let mut todos: Option<Vec<Task>> = None;
    let mut tasks: Vec<Task> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut pending: HashMap<String, String> = HashMap::new();
    let words = defaults::list("codex_handover.task_line_words");
    for line in lines {
        if line.is_empty() || !words.iter().any(|w| line.contains(w)) {
            continue;
        }
        let Some(e) = jstext::parse_line(line).map_err(|_| Unsure)? else { continue };
        if !truthy(Some(&e)) || member(&e, "isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        let Some(content) = member(&e, "message").and_then(|m| member(m, "content")).and_then(Value::as_array) else { continue };
        let etype = str_member(&e, "type");
        for item in content {
            if !truthy(Some(item)) {
                continue;
            }
            let itype = str_member(item, "type");
            if etype == Some("assistant") && itype == Some("tool_use") {
                let inp = member(item, "input").filter(|i| truthy(Some(i)));
                let field = |k: &str| inp.and_then(|i| member(i, k));
                let name = str_member(item, "name");
                if name == Some("TodoWrite") && field("todos").is_some_and(Value::is_array) {
                    todos = Some(
                        field("todos")
                            .and_then(Value::as_array)
                            .map(|a| {
                                a.iter()
                                    .enumerate()
                                    .map(|(i, t)| {
                                        let subj = if truthy(Some(t)) {
                                            member(t, "content").filter(|c| truthy(Some(c))).or_else(|| member(t, "subject"))
                                        } else {
                                            None
                                        };
                                        let (status, deleted) = if truthy(Some(t)) { status_of(member(t, "status")) } else { status_of(None) };
                                        Task { id: (i + 1).to_string(), subject: jstext::string_or_empty(subj), status, deleted }
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    );
                } else if name == Some("TaskCreate") && truthy(member(item, "id")) {
                    if let Some(k) = key_of(member(item, "id")) {
                        pending.insert(k, jstext::string_or_empty(field("subject")));
                    }
                } else if name == Some("TaskUpdate") {
                    let present = |k: &str| field(k).filter(|v| !v.is_null());
                    let id = present("taskId").or_else(|| present("id")).map(jstext::js_string);
                    if let Some(id) = id {
                        let at = *index.entry(id.clone()).or_insert_with(|| {
                            tasks.push(Task {
                                id: id.clone(),
                                subject: String::new(),
                                status: defaults::text("codex_handover.status_pending").to_string(),
                                deleted: false,
                            });
                            tasks.len() - 1
                        });
                        let t = &mut tasks[at];
                        if truthy(field("status")) {
                            let (s, d) = status_of(field("status"));
                            t.status = s;
                            t.deleted = d;
                        }
                        if truthy(field("subject")) {
                            t.subject = jstext::string_or_empty(field("subject"));
                        }
                    }
                }
            } else if etype == Some("user") && itype == Some("tool_result") {
                let Some(k) = key_of(member(item, "tool_use_id")) else { continue };
                if !pending.contains_key(&k) {
                    continue;
                }
                let c = member(item, "content");
                let txt = match c {
                    Some(Value::String(s)) => s.clone(),
                    other => text_of(other),
                };
                if let Some(m) = created_re().captures(&txt) {
                    let id = m[1].to_string();
                    let subject = pending.get(&k).cloned().unwrap_or_default();
                    let prior = index.get(&id).map(|i| (tasks[*i].status.clone(), tasks[*i].deleted));
                    let (status, deleted) = prior.unwrap_or_else(|| (defaults::text("codex_handover.status_pending").to_string(), false));
                    let task = Task { id: id.clone(), subject, status, deleted };
                    match index.get(&id) {
                        Some(i) => tasks[*i] = task,
                        None => {
                            index.insert(id, tasks.len());
                            tasks.push(task);
                        }
                    }
                }
                pending.remove(&k);
            }
        }
    }
    if todos.is_none() && tasks.is_empty() {
        return Ok(None);
    }
    let mut list = todos.unwrap_or_default();
    list.extend(tasks.into_iter().filter(|t| !t.deleted));
    Ok(Some(list))
}

/// `cell(s)`: one table cell.
pub fn cell(s: &str) -> String {
    let piped = s.replace('|', "\\|");
    jstext::slice16_lossy(&collapse_ws(&piped), defaults::num("codex_handover.cell_max") as usize)
}
