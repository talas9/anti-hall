//! The Codex side of `hooks/lib/idle-agents.js` (`codexFinished`): agents of the `multi_agent_v1` tool set that finished
//! (a `wait_agent` result reports them completed or errored) and were never closed or re-tasked, read from the rollout.
//!
//! `spawn_agent`'s output carries the agent id, `wait_agent`'s output a status per id, `close_agent` closes an id and
//! `send_input` / `resume_agent` naming it re-tasks it. Each call is matched to its output by call id.
use crate::checks::emit_dedupe::Defer;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::jsval::{DateParse, date_parse, js_to_string, parse_line};
use crate::defaults;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// An agent the rollout shows finished and still open.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexAgent {
    /// The agent id (what `close_agent` takes).
    pub id: String,
    /// The label shown to the model: the nickname and id, or the id.
    pub label: String,
    /// When it finished, in milliseconds since the epoch.
    pub idle_since_ms: f64,
}

#[derive(PartialEq, Clone, Copy)]
enum State {
    Busy,
    Finished,
    Closed,
}

struct Agent {
    state: State,
    idle_since: f64,
    nickname: String,
}

fn id_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| jsre::compile(defaults::text("idle_sweep.re_codex_id"), true))
}

/// `parseJson(s)`: the parsed value when `s` is text holding an object or array; `None` otherwise.
fn parse_json(v: Option<&Value>) -> Option<Value> {
    let s = v?.as_str()?;
    parse_line(s).filter(|o| o.is_object() || o.is_array())
}

/// The agent ids named by a call's arguments (`target`, `targets`, `id`, `agent_id`).
fn arg_ids(args: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for k in defaults::list("idle_sweep.codex_arg_keys") {
        if let Some(s) = args.get(k).and_then(Value::as_str) {
            out.push(s.to_string());
        }
    }
    if let Some(Value::Array(a)) = args.get(defaults::text("idle_sweep.codex_arg_list_key")) {
        out.extend(a.iter().filter_map(Value::as_str).map(str::to_string));
    }
    out
}

fn truthy_name(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None | Some(Value::Bool(false)) => String::new(),
        Some(Value::Number(n)) if n.as_f64().is_none_or(|x| x == 0.0 || x.is_nan()) => String::new(),
        Some(other) => js_to_string(other),
    }
}

/// The agents `codexFinished` lists, in the order the rollout first spawned them.
pub fn finished(lines: &[String]) -> Result<Vec<CodexAgent>, Defer> {
    let marks = defaults::list("idle_sweep.codex_prefilter");
    let call_names = defaults::list("idle_sweep.codex_call_names");
    let finished_keys = defaults::list("idle_sweep.codex_finished_keys");
    let mut calls: HashMap<String, (String, Option<Value>)> = HashMap::new();
    let mut agents: Vec<(String, Agent)> = Vec::new();
    for raw in lines {
        if !marks.iter().any(|m| raw.contains(m)) {
            continue;
        }
        let Some(e) = parse_line(raw) else { return Err(Defer) };
        if !(e.is_object() || e.is_array()) {
            continue;
        }
        let Some(p) = e.get("payload").filter(|p| p.is_object() || p.is_array()) else { continue };
        let ts = match e.get("timestamp").and_then(Value::as_str) {
            Some(s) => match date_parse(s) {
                DateParse::Ms(ms) => ms,
                DateParse::Nan => f64::NAN,
                DateParse::Unsupported => return Err(Defer),
            },
            None => f64::NAN,
        };
        let ptype = p.get("type").and_then(Value::as_str);
        if ptype == Some("function_call")
            && let Some(call_id) = p.get("call_id").and_then(Value::as_str)
        {
            let name = truthy_name(p.get("name"));
            if !call_names.contains(&name.as_str()) {
                continue;
            }
            let args = parse_json(p.get("arguments"));
            for id in args.as_ref().map(arg_ids).unwrap_or_default() {
                if let Some((_, a)) = agents.iter_mut().find(|(n, _)| *n == id) {
                    if name == defaults::text("idle_sweep.codex_close_call") {
                        a.state = State::Closed;
                    } else if defaults::list("idle_sweep.codex_retask_calls").contains(&name.as_str()) {
                        a.state = State::Busy;
                    }
                }
            }
            calls.insert(call_id.to_string(), (name, args));
            continue;
        }
        if ptype != Some("function_call_output") {
            continue;
        }
        let Some((cname, _)) = p.get("call_id").and_then(Value::as_str).and_then(|c| calls.get(c)) else { continue };
        let Some(out) = parse_json(Some(p.get("output").filter(|o| o.is_string()).unwrap_or(&Value::String(String::new())))) else { continue };
        if cname == defaults::text("idle_sweep.codex_spawn_call") {
            if let Some(id) = out.get("agent_id").and_then(Value::as_str).filter(|id| id_re().is_match(id)) {
                let nick = out.get("nickname").and_then(Value::as_str).unwrap_or("").to_string();
                let fresh = Agent { state: State::Busy, idle_since: f64::NAN, nickname: nick };
                match agents.iter_mut().find(|(n, _)| n == id) {
                    Some(slot) => slot.1 = fresh,
                    None => agents.push((id.to_string(), fresh)),
                }
            }
        } else if cname == defaults::text("idle_sweep.codex_wait_call")
            && let Some(Value::Object(status)) = out.get("status")
        {
            for (id, st) in status {
                let Some((_, a)) = agents.iter_mut().find(|(n, _)| n == id) else { continue };
                if a.state != State::Busy || !(st.is_object() || st.is_array()) {
                    continue;
                }
                if finished_keys.iter().any(|k| st.get(k).is_some()) && ts.is_finite() {
                    a.state = State::Finished;
                    a.idle_since = ts;
                }
            }
        }
    }
    Ok(agents
        .into_iter()
        .filter(|(_, a)| a.state == State::Finished)
        .map(|(id, a)| CodexAgent { label: if a.nickname.is_empty() { id.clone() } else { format!("{} ({id})", a.nickname) }, id, idle_since_ms: a.idle_since })
        .collect())
}
