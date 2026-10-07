//! Built-in `check = "dispatch-tier"`: the Node dispatch-tier hook (PostToolUse on TaskCreate and TaskUpdate), natively.
//!
//! The hook asks Jev, detached, how a new or changed task should be dispatched (`lib/dispatch-tier.js` `request`): the
//! `dispatchTier` integration, a choice among workspace, workflow and subagent. It asks once per task text: a text with an
//! answer in the shared cache (`cache/jev-assist.json`, which the engine now reads and writes in Node's own shape) is not
//! asked again, and a request marker in `dispatch-tier-state.json` stops a repeat while the first ask may still be in
//! flight. Everything before the ask only reads; the one write is that marker, kept in Node's own file and shape.
//!
//! Flow, as in the Node hook: a TaskCreate's text is its subject (or title, content, description); a TaskUpdate's is the
//! reconstructed task (the transcript tail through the same state reconstruction and backfill the task guards use) with the
//! update's subject, description and `metadata.blockedOn` on top. A task waiting on the owner (the `blockedOn` marker or an
//! `OWNER:` subject) is never classified. While the integration is off nothing is read or written.
//!
//! Defers (never a silent skip): a request without a usable home, JSON only JavaScript reads (the state file, the cache
//! file, the transcript lines), a task field of a type whose JavaScript text differs, and a task text whose 600-unit cut
//! would split a surrogate pair.
//!
//! Mirrors `hooks/dispatch-tier.js` and `hooks/lib/dispatch-tier.js` (`request`, `taskText`, `readState`, `writeState`).
use crate::checks::guardkit::jsdiff::js_reads_differently_str;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::settings::get_bool;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::json::{self, Fail, J};
use crate::checks::jsport::{date, home};
use crate::checks::taskkit::js_string;
use crate::checks::taskkit::jsval::{R, Unsure, truthy};
use crate::checks::taskstate::parse::{Facts, reconstruct};
use crate::checks::taskstate::tail::{lines_of, read_tail};
use crate::checks::taskstate::{Variant, backfill::backfill};
use crate::checks::{Check, Verdict};
use crate::defaults;
use crate::jev::assist::content_hash;
use crate::jev::cache::FileCache;
use crate::jev::settings::{Env, Mode, Sources};
use crate::jev::{AskRequest, JevSettings, Question, Trust};
use crate::reqenv::RequestEnv;
use crate::rules::Subject;
use serde_json::Value;
use std::path::Path;

#[cfg(test)]
mod tests;

/// A JavaScript object field read the way `inp.key` reads it: only an object has fields.
fn field<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

/// `typeof v === 'string' && v` (a non-empty string), `None` for falsy; `Err` for a truthy value that is not a string.
fn text_or_falsy(v: Option<&Value>) -> R<Option<String>> {
    match v {
        None => Ok(None),
        Some(x) if !truthy(x) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(Unsure),
    }
}

/// The task the hook classifies: its text pieces and its `blockedOn` marker.
struct TaskText {
    content: String,
    description: String,
    blocked_on: Option<Value>,
}

/// `isOwnerBlocked` of `lib/dispatch-demand.js`.
fn owner_blocked(t: &TaskText, env: &RequestEnv) -> bool {
    let st = crate::checks::git::util::Settings::from_env(env);
    if !get_bool(&st, defaults::raw("dispatch_tier.owner_marker_setting")) {
        return false;
    }
    if let Some(Value::String(b)) = &t.blocked_on
        && defaults::list("dispatch_tier.owner_values").contains(&js_trim(b).to_lowercase().as_str())
    {
        return true;
    }
    jsre::compile(defaults::text("dispatch_tier.owner_subject_re"), true).is_match(&t.content)
}

/// The task of a TaskCreate or TaskUpdate; `Ok(None)` when the hook has nothing to classify.
fn task_of(p: &Value, tool: &str, env: &RequestEnv) -> R<Option<TaskText>> {
    let empty = Value::Null;
    let inp = p.get("tool_input").filter(|v| truthy(v)).unwrap_or(&empty);
    let meta = field(inp, "metadata").filter(|m| truthy(m));
    let meta_blocked = meta.and_then(|m| field(m, "blockedOn"));
    if tool == "TaskCreate" {
        let mut content = None;
        for k in ["subject", "title", "content", "description"] {
            if let Some(s) = text_or_falsy(field(inp, k))? {
                content = Some(s);
                break;
            }
        }
        let description = match field(inp, "description") {
            Some(Value::String(s)) => s.clone(),
            _ => String::new(),
        };
        let blocked_on = match meta_blocked {
            Some(v) if !v.is_null() => Some(v.clone()),
            _ => field(inp, "blockedOn").cloned(),
        };
        return Ok(Some(TaskText { content: content.unwrap_or_default(), description, blocked_on }));
    }
    let subject = text_or_falsy(field(inp, "subject"))?;
    let has_text = subject.is_some() || matches!(field(inp, "description"), Some(Value::String(_)));
    let id = match (field(inp, "taskId"), field(inp, "id")) {
        (Some(v), _) if !v.is_null() => Some(js_string(v).ok_or(Unsure)?),
        (_, Some(v)) if !v.is_null() => Some(js_string(v).ok_or(Unsure)?),
        _ => None,
    };
    let (true, Some(id)) = (has_text, id) else { return Ok(None) };
    let mut base = TaskText { content: String::new(), description: String::new(), blocked_on: None };
    if let Some(Value::String(tp)) = p.get("transcript_path").filter(|v| truthy(v)) {
        let window = defaults::num("taskstate.tail_bytes");
        if let Some((data, truncated)) = read_tail(tp, window) {
            let lines = lines_of(&data, truncated);
            let mut facts: Facts = reconstruct(&lines, Variant::State)?;
            if truncated {
                backfill(&mut facts, tp, window)?;
            }
            if let Some(t) = facts.tasks.get(&id) {
                base = TaskText { content: t.content.clone(), description: t.description.clone(), blocked_on: t.blocked_on.clone() };
            }
        }
    } else if p.get("transcript_path").is_some_and(|v| truthy(v)) {
        return Err(Unsure); // a path that is not a string: Node's readTail answers null, which this port does not model
    }
    if let Some(s) = subject {
        base.content = s;
    }
    if let Some(Value::String(d)) = field(inp, "description") {
        base.description = d.clone();
    }
    if let Some(m) = meta_blocked {
        base.blocked_on = Some(m.clone());
    }
    let _ = env;
    Ok(Some(base))
}

/// `taskText(t)`: subject, a newline and the description when they differ, cut to the cap in UTF-16 units.
fn text_of(t: &TaskText) -> R<String> {
    let joined = if !t.description.is_empty() && t.description != t.content { format!("{}\n{}", t.content, t.description) } else { t.content.clone() };
    crate::checks::replykit::io::prefix_utf16(&joined, defaults::num("dispatch_tier.text_cap") as usize).ok_or(Unsure)
}

fn is_obj(v: Option<&J>) -> bool {
    matches!(v, Some(J::Obj(_)))
}

/// `readState(home)`: the state object with `requested` and `sessions` objects in place.
fn read_state(path: &str) -> R<J> {
    let mut s = J::Obj(Vec::new());
    if let Ok(raw) = std::fs::read_to_string(path) {
        if js_reads_differently_str(&raw) {
            return Err(Unsure);
        }
        match json::parse(&raw, defaults::num("dispatch_tier.json_max_depth") as usize) {
            Ok(v @ J::Obj(_)) => s = v,
            Ok(J::Arr(_)) | Err(Fail::Unsupported) => return Err(Unsure),
            Ok(_) | Err(Fail::Invalid) => {}
        }
    }
    for k in ["requested", "sessions"] {
        match s.get(k) {
            Some(J::Arr(_)) => return Err(Unsure),
            v if is_obj(v) => {}
            _ => s.set(k, J::Obj(Vec::new())),
        }
    }
    Ok(s)
}

/// `writeState(home, s)`: bounded, then replaced through a temp file. Best effort, as in Node.
fn write_state(path: &str, s: &mut J, now: f64) -> R<()> {
    let t_of = |v: &J| -> R<f64> {
        match v.get("t") {
            None | Some(J::Null) => Ok(0.0),
            Some(J::Num(n)) => Ok(if n.is_nan() { 0.0 } else { *n }),
            Some(_) => Err(Unsure),
        }
    };
    let max = defaults::num("dispatch_tier.max_sessions") as usize;
    if let J::Obj(top) = s {
        for (k, v) in top.iter_mut() {
            if k == "sessions"
                && let J::Obj(sess) = v
                && sess.len() > max
            {
                let mut keyed = Vec::new();
                for (i, (_, sv)) in sess.iter().enumerate() {
                    keyed.push((t_of(sv)?, i));
                }
                keyed.sort_by(|a, b| a.0.total_cmp(&b.0));
                let drop: std::collections::HashSet<usize> = keyed.iter().take(sess.len() - max).map(|(_, i)| *i).collect();
                let mut i = 0usize;
                sess.retain(|_| {
                    i += 1;
                    !drop.contains(&(i - 1))
                });
            }
            if k == "requested"
                && let J::Obj(req) = v
            {
                let ttl = defaults::num("dispatch_tier.request_ttl_ms") as f64;
                req.retain(|(_, t)| matches!(t, J::Num(n) if n.is_finite() && now - n <= ttl));
            }
        }
    }
    let dir = std::path::Path::new(path).parent();
    if let Some(d) = dir
        && std::fs::create_dir_all(d).is_ok()
    {
        let tmp = format!("{path}.{}.tmp", std::process::id());
        if std::fs::write(&tmp, json::stringify(s)).is_err() || std::fs::rename(&tmp, path).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    Ok(())
}

/// The question: a choice among the three tiers.
fn question() -> Question {
    Question::choice(
        defaults::text("dispatch_tier.question_instructions"),
        vec![
            ("workspace".to_string(), defaults::text("dispatch_tier.tier_workspace").to_string()),
            ("workflow".to_string(), defaults::text("dispatch_tier.tier_workflow").to_string()),
            ("subagent".to_string(), defaults::text("dispatch_tier.tier_subagent").to_string()),
        ],
    )
}

fn decide_inner(p: &Value, env: &RequestEnv) -> R<Verdict> {
    let tool = p.get("tool_name").and_then(Value::as_str).unwrap_or("");
    if !defaults::list("dispatch_tier.tools").contains(&tool) {
        return Ok(Verdict::Allow);
    }
    let map = env.to_map();
    let home_dir = map.get(defaults::env_name("home")).or_else(|| map.get(defaults::env_name("home_alt"))).filter(|h| !h.is_empty()).ok_or(Unsure)?;
    let hp = Path::new(home_dir);
    let jenv = Env::from_pairs(map.clone());
    let settings = JevSettings::resolve(hp, Sources::load(hp, jenv.clone()));
    let jev_id = defaults::text("dispatch_tier.jev_id");
    if settings.mode(jev_id, false) == Mode::Off {
        return Ok(Verdict::Allow);
    }
    let home_dir = home::resolve(env).ok_or(Unsure)?;
    let Some(task) = task_of(p, tool, env)? else { return Ok(Verdict::Allow) };
    if task.content.is_empty() || owner_blocked(&task, env) {
        return Ok(Verdict::Allow);
    }
    let text = text_of(&task)?;
    let hash = content_hash(&[jev_id, defaults::text("jev.question_version"), &text]);
    let hp = Path::new(&home_dir);
    if FileCache::for_home(hp).contains(&hash).ok_or(Unsure)? {
        return Ok(Verdict::Allow);
    }
    let state_path = format!("{home_dir}/{}/{}", defaults::text("paths.base_dir"), defaults::text("dispatch_tier.state_file"));
    let mut st = read_state(&state_path)?;
    let now = date::now_ms();
    if let Some(J::Obj(req)) = st.get("requested")
        && let Some((_, J::Num(at))) = req.iter().find(|(k, _)| *k == hash)
        && at.is_finite()
        && now - at < defaults::num("dispatch_tier.request_ttl_ms") as f64
    {
        return Ok(Verdict::Allow);
    }
    // the session, as `String(payload.session_id)` when truthy
    let session = match p.get("session_id").filter(|v| truthy(v)) {
        Some(v) => Some(js_string(v).ok_or(Unsure)?),
        None => None,
    };
    if let J::Obj(top) = &mut st
        && let Some((_, J::Obj(req))) = top.iter_mut().find(|(k, _)| k == "requested")
    {
        match req.iter_mut().find(|(k, _)| *k == hash) {
            Some(slot) => slot.1 = J::Num(now),
            None => req.push((hash.clone(), J::Num(now))),
        }
    }
    write_state(&state_path, &mut st, date::now_ms())?;
    let mut req = AskRequest::new(jev_id, question(), &text, Trust::Advisory, Value::Null);
    req.cache_key = Some(text.clone());
    req.session_id = session;
    req.turn_ref = p.get("transcript_path").and_then(Value::as_str).filter(|t| !t.is_empty()).and_then(crate::jev::shared::turn_ref_from_transcript);
    req.project = crate::jev::shared::project_for(p.get("cwd").and_then(Value::as_str));
    crate::jev::shared::ask_detached(hp, &jenv, req);
    Ok(Verdict::Allow)
}

/// The decision for one payload and the request's environment.
pub fn decide(p: &Value, env: &RequestEnv) -> Verdict {
    decide_inner(p, env).unwrap_or(Verdict::Defer)
}

/// The registered `dispatch-tier` check.
pub struct DispatchTier;

impl Check for DispatchTier {
    fn name(&self) -> &'static str {
        "dispatch-tier"
    }

    fn summary(&self) -> &'static str {
        defaults::text("dispatch_tier.summary")
    }

    fn run(&self, _s: &Subject<'_>, _opts: &Value) -> Option<Verdict> {
        Some(Verdict::Defer)
    }

    fn run_env(&self, _s: &Subject<'_>, payload: &Value, _opts: &Value, env: &RequestEnv) -> Option<Verdict> {
        Some(decide(payload, env))
    }
}
