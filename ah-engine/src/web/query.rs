//! `query <topic>`: a read-only, paginated view over the stores the engine already keeps. A topic is a `webapi.source_<name>`
//! setting naming a `source` (the function that reads it), the path of its rows in the source's document, the filters
//! (`--flag:row-field`) and the parameters the source takes. Nothing is written and nothing runs in the background; a source
//! that needs the daemon says so when none runs.
use super::flag;
use crate::agents::{self, Env};
use crate::defaults;
use serde_json::{Value, json};

/// The page asked for: where it starts and how many rows.
pub struct Page {
    /// Rows skipped.
    pub offset: usize,
    /// Rows returned.
    pub limit: usize,
}

impl Page {
    fn from(rest: &[String]) -> Page {
        let max = defaults::num("webapi.page_max") as usize;
        let limit = flag(rest, "limit").parse::<usize>().ok().filter(|l| *l > 0).unwrap_or(defaults::num("webapi.page_default") as usize).min(max);
        let offset = flag(rest, "offset").parse::<usize>().unwrap_or(0).min(defaults::num("webapi.offset_max") as usize);
        Page { offset, limit }
    }
}

/// The sources, with their docs, `--where` fields and parameters.
pub fn source_list() -> Vec<Value> {
    defaults::with_prefix("webapi.source_")
        .iter()
        .map(|e| json!({"source": &e.key["webapi.source_".len()..], "doc": e.doc, "backing": e.value.str_field("source"), "filters": e.value.get("filters").map(|f| f.strings()), "params": e.value.get("params").map(|f| f.strings())}))
        .collect()
}

/// The field names and JSON types of a row.
fn schema_of(row: Option<&Value>) -> Value {
    let kind = |v: &Value| match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    };
    row.and_then(Value::as_object).map(|m| Value::Object(m.iter().map(|(k, v)| (k.clone(), json!(kind(v)))).collect())).unwrap_or(Value::Null)
}

fn telemetry(sub: &str, rest: &[String], params: &[&str], extra: &[(&str, String)]) -> Value {
    let mut args = vec![sub.to_string()];
    for p in params {
        let mut v = flag(rest, p);
        if v.is_empty() && *p == "window" {
            v = flag(rest, "since"); // `--since 24h` is the same window
        }
        if !v.is_empty() {
            args.push(format!("--{p}"));
            args.push(v);
        }
    }
    for (k, v) in extra {
        args.push(format!("--{k}"));
        args.push(v.clone());
    }
    crate::telemetry::cli::run(&args).0
}

fn agents_doc() -> Value {
    let Some(mut env) = Env::current() else { return json!({"agents": [], "error": "no home"}) };
    if !env.switch("agent_tracker.setting") {
        return json!({"agents": [], "enabled": false, "note": defaults::text("webapi.msg_agents_disabled")});
    }
    env.act = false;
    let mut st = agents::load_state(&env);
    let listing = agents::tick(&env, &mut st);
    agents::status_document(&env, &st, &listing)
}

/// The guard blocks recorded in hot.db within `--window` (newest first, at most `need`): guard, rule, event, session, agent, tool,
/// project and the first line of the block message.
fn guard_blocks(rest: &[String], need: usize) -> Value {
    let mut window = flag(rest, "window");
    if window.is_empty() {
        window = flag(rest, "since");
    }
    let days = match crate::telemetry::report::check_window(&window) {
        Ok(d) => d,
        Err(e) => return json!({"error": e}),
    };
    let since = crate::health::now_ms().saturating_sub(days.saturating_mul(defaults::num("web.query_day_ms")));
    let rows: Vec<Value> = crate::telemetry::cli::open_existing()
        .map(|t| t.blocks(since, need))
        .unwrap_or_default()
        .into_iter()
        .map(|b| json!({"ts_ms": b.ts_ms, "guard": b.guard, "rule": b.rule, "event": b.event, "session": b.session, "agent": b.agent, "tool": b.tool, "project": b.project, "reason": b.reason}))
        .collect();
    json!({"blocks": rows, "window": {"days": days}})
}

/// The source's document. `need` is how many rows from the start the page reaches (events are fetched newest first up to it).
fn fetch(source: &str, rest: &[String], params: &[&str], need: usize) -> Value {
    let not_running = || json!({"running": false, "note": defaults::text("webapi.msg_not_running")});
    match source {
        "telemetry_summary" => telemetry("summary", rest, params, &[]),
        "telemetry_events" => telemetry("events", rest, params, &[("limit", need.to_string())]),
        "metrics" => {
            let check = flag(rest, "check");
            let verb = if check.is_empty() { "metrics".to_string() } else { format!("metrics check={check}") };
            crate::client::ctl_json(&verb).unwrap_or_else(not_running)
        }
        "guard_blocks" => guard_blocks(rest, need),
        "agents" => agents_doc(),
        "nudges" => agents::nudge_document(),
        "status" => crate::client::status_value(),
        "history" => super::manage::history_doc(),
        other => json!({"error": defaults::render("web.msg_query_no_source", &[("what", &other)])}),
    }
}

/// The rows at `path` of `doc`: an array as it is, an object as name/value rows, an empty path the document itself as one row.
fn rows_of(doc: &Value, path: &str) -> Vec<Value> {
    if path.is_empty() {
        return vec![doc.clone()];
    }
    match doc.get(path) {
        Some(Value::Array(a)) => a.clone(),
        Some(Value::Object(m)) => m.iter().map(|(k, v)| json!({"name": k, "value": v})).collect(),
        _ => Vec::new(),
    }
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// Run `topic` with the flags in `rest`. `topics` (or no topic) lists the topics.
pub fn query(topic: &str, rest: &[String]) -> Result<Value, String> {
    if topic.is_empty() || topic == "sources" {
        return Ok(json!({"sources": source_list()}));
    }
    let Some(entry) = defaults::get(&format!("webapi.source_{topic}")) else {
        let names: Vec<String> = source_list().iter().filter_map(|t| t["source"].as_str().map(str::to_string)).collect();
        return Err(defaults::render("webapi.msg_unknown_topic", &[("topic", &topic), ("topics", &names.join(", "))]));
    };
    let spec = &entry.value;
    let page = Page::from(rest);
    let params = spec.get("params").map(|p| p.strings()).unwrap_or_default();
    // the events source returns the newest `need` rows oldest first; one more than the page tells whether another page exists
    let need = page.offset + page.limit + 1;
    let doc = fetch(spec.str_field("source"), rest, &params, need);
    let mut rows = rows_of(&doc, spec.str_field("rows"));
    if spec.str_field("source") == "telemetry_events" {
        rows.reverse();
    }
    if rest.iter().any(|a| a == "--schema") {
        return Ok(json!({"source": topic, "doc": entry.doc, "filters": spec.get("filters").map(|f| f.strings()), "params": params, "fields": schema_of(rows.first())}));
    }
    // declared filter flags (`--check x`), then `--where field=value,field=value` over any field of the row
    for f in spec.get("filters").map(|f| f.strings()).unwrap_or_default() {
        let (flag_name, field) = f.split_once(':').unwrap_or((f, f));
        let want = flag(rest, flag_name);
        if !want.is_empty() {
            rows.retain(|r| r.get(field).is_some_and(|v| text_of(v) == want));
        }
    }
    for cond in flag(rest, "where").split(',').filter(|c| !c.is_empty()) {
        if let Some((field, want)) = cond.split_once('=') {
            rows.retain(|r| r.get(field).is_some_and(|v| text_of(v) == want));
        }
    }
    let total = rows.len();
    let page_rows: Vec<Value> = rows.into_iter().skip(page.offset).take(page.limit).collect();
    let mut meta = doc.clone();
    if let (Some(m), path) = (meta.as_object_mut(), spec.str_field("rows")) {
        m.remove(path);
    }
    Ok(json!({
        "source": topic, "offset": page.offset, "limit": page.limit, "count": page_rows.len(), "total": total,
        "has_more": page.offset + page_rows.len() < total, "rows": page_rows, "meta": meta,
    }))
}
