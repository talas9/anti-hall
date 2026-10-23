//! `describe`: the generated inventory. Each part reads a registry the engine already has (the command registry, the settings
//! registry, the shipped defaults, the check registry, the dispatch table, the Jev integrations); none is written by hand.
use crate::defaults::{self, V};
use crate::dispatch::table;
use crate::{checks, cfgstore, docs};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// The value type name of a shipped setting.
fn type_of(v: &V) -> &'static str {
    match v {
        V::Int(_) => "integer",
        V::Bool(_) => "boolean",
        V::Str(_) => "string",
        V::List(_) => "list",
        V::Table(_) => "table",
    }
}

/// A section prefix as config keys spell it: the configured character replaced (`stale-agent-stop-note` is `stale_agent_stop_note`).
fn norm(name: &str) -> String {
    let r = defaults::list("webapi.name_replace");
    match (r.first(), r.get(1)) {
        (Some(from), Some(to)) => name.replace(from, to),
        _ => name.to_string(),
    }
}

/// The first word of a hook command: what runs it.
fn runner(command: &str) -> &str {
    command.split_whitespace().next().unwrap_or("")
}

/// Every hook entry of every host and event: (host, event, entry).
fn all_entries() -> Vec<(&'static str, &'static str, table::Entry)> {
    let mut out = Vec::new();
    for host in table::hosts() {
        for event in table::events(host) {
            for e in table::entries(host, event) {
                out.push((host, event, e));
            }
        }
    }
    out
}

fn entry_json(host: &str, event: &str, e: &table::Entry) -> Value {
    json!({"host": host, "event": event, "id": e.id, "matcher": e.matcher, "timeout_s": e.timeout_s, "check": e.check, "runner": runner(&e.command), "conditional": e.when.is_some(), "rebindable": false})
}

/// Every shipped config file with its keys: the doc, type, shipped default, effective value and bounds.
fn config() -> Value {
    let mut by_file: BTreeMap<&str, Vec<Value>> = BTreeMap::new();
    for e in defaults::all().iter() {
        let effective = defaults::raw(e.key);
        by_file.entry(e.file).or_default().push(json!({
            "key": e.key, "type": type_of(&e.value), "doc": e.doc, "default": e.value.to_json(), "value": effective.to_json(),
            "changed": *effective != e.value, "env": e.env, "unit": e.unit, "min": e.min, "max": e.max,
            "locked": cfgstore::locked(e.key), "restart_only": cfgstore::restart_only(e.key),
        }));
    }
    Value::Array(by_file.into_iter().map(|(file, keys)| json!({"file": file, "count": keys.len(), "keys": keys})).collect())
}

/// The settings sections (first word of a key) a check reads, by the naming convention.
fn check_sections(name: &str, entry_ids: &[&str]) -> BTreeSet<String> {
    std::iter::once(name).chain(entry_ids.iter().copied()).map(|n| norm(n.split('#').next().unwrap_or(n))).collect()
}

/// The feature switches, with the check each belongs to (by section name).
fn switch_for(sections: &BTreeSet<String>, switches: &[Value]) -> Option<String> {
    switches.iter().find(|s| s["feature"].as_str().is_some_and(|f| sections.contains(f))).and_then(|s| s["id"].as_str().map(str::to_string))
}

/// The checks with their bindings (event rows), reads (config keys, by naming convention), switch and `rebindable` (false: the
/// event-to-check wiring is read-only).
fn checks_part(switches: &[Value]) -> Value {
    let entries = all_entries();
    let all = defaults::all();
    Value::Array(
        checks::registry()
            .iter()
            .map(|c| {
                let bound: Vec<&(&str, &str, table::Entry)> = entries.iter().filter(|(_, _, e)| e.check.as_deref() == Some(c.name())).collect();
                let ids: Vec<&str> = bound.iter().map(|(_, _, e)| e.id.as_str()).collect();
                let sections = check_sections(c.name(), &ids);
                let reads: Vec<&str> = all.iter().filter(|e| e.key.split('.').next().is_some_and(|s| sections.contains(s))).map(|e| e.key).collect();
                json!({
                    "name": c.name(), "summary": c.summary(), "scripted": c.scripted(),
                    "bindings": bound.iter().map(|(h, ev, e)| entry_json(h, ev, e)).collect::<Vec<_>>(),
                    "reads": reads, "switch": switch_for(&sections, switches),
                })
            })
            .collect(),
    )
}

/// Event to entries, per host: which check (or script) answers each event, in dispatch order.
fn bindings() -> Value {
    let entries = all_entries();
    let mut by_host: BTreeMap<&str, BTreeMap<&str, Vec<Value>>> = BTreeMap::new();
    for (h, ev, e) in &entries {
        by_host.entry(h).or_default().entry(ev).or_default().push(entry_json(h, ev, e));
    }
    Value::Array(by_host.into_iter().flat_map(|(host, events)| events.into_iter().map(move |(event, entries)| json!({"host": host, "event": event, "entries": entries}))).collect())
}

/// The hook entries no built-in check answers: scripts (and shell hooks) the dispatcher runs as they are.
fn scripts() -> Value {
    Value::Array(all_entries().iter().filter(|(_, _, e)| e.check.is_none()).map(|(h, ev, e)| entry_json(h, ev, e)).collect())
}

/// The feature switches: shipped settings that name a settings.json boolean (section, key, env, default).
fn switches() -> Vec<Value> {
    let st = crate::checks::git::util::Settings::from_env(&crate::reqenv::RequestEnv::capture());
    let suffix = defaults::text("webapi.switch_key_suffix");
    defaults::all()
        .iter()
        .filter(|e| e.key.rsplit('.').next().is_some_and(|n| n.ends_with(suffix)) && e.value.get("section").is_some() && e.value.get("key").is_some())
        .map(|e| {
            let boolean = e.value.get("default").and_then(V::as_bool).is_some();
            json!({
                "id": e.key, "feature": e.key.split('.').next().unwrap_or(""), "doc": e.doc,
                "setting": format!("{}.{}", e.value.str_field("section"), e.value.str_field("key")), "env": e.value.str_field("env"),
                "default": e.value.get("default").map(V::to_json),
                "value": boolean.then(|| checks::guardkit::settings::get_bool(&st, &e.value)),
            })
        })
        .collect()
}

/// The scheduled jobs: the actions the scheduler accepts, with the interval setting each has.
fn jobs() -> Value {
    Value::Array(
        defaults::list("schedule.actions")
            .iter()
            .map(|a| {
                let key = format!("schedule.{a}_ms");
                json!({"name": a, "interval_key": defaults::has(&key).then_some(key.clone()), "interval_ms": defaults::get(&key).and_then(|e| e.value.as_integer())})
            })
            .collect(),
    )
}

/// The daemon's control verbs (the socket protocol table).
fn ctl_verbs() -> Value {
    Value::Array(
        defaults::with_prefix("protocol.")
            .iter()
            .map(|e| json!({"name": &e.key["protocol.".len()..], "request": e.value.str_field("request"), "reply": e.value.str_field("reply"), "doc": e.doc}))
            .collect(),
    )
}

/// Does `text` match `pattern`, where `*` stands for any run of characters?
fn glob(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if !text.starts_with(first) || !text.ends_with(last) || text.len() < first.len() + last.len() {
        return false;
    }
    let mut at = first.len();
    let end = text.len() - last.len();
    for mid in &parts[1..parts.len() - 1] {
        match text[at..end].find(mid) {
            Some(i) => at += i + mid.len(),
            None => return false,
        }
    }
    true
}

/// Every feature the dashboard should cover, as (id `kind:name`, what it lacks to be editable).
fn features(doc: &Value) -> Vec<(String, Vec<&'static str>)> {
    let list = |k: &str| doc.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let name = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let mut out = Vec::new();
    for c in list("commands") {
        out.push((format!("verbs:{}", name(&c, "name")), vec![]));
    }
    for c in list("checks") {
        let missing = if c["switch"].is_null() { vec!["switch"] } else { vec![] };
        out.push((format!("checks:{}", name(&c, "name")), missing));
    }
    for s in list("settings_registry") {
        let mut missing = Vec::new();
        if s["type"].is_null() {
            missing.push("type");
        }
        if name(&s, "description").is_empty() {
            missing.push("doc");
        }
        out.push((format!("settings:{}", name(&s, "id")), missing));
    }
    for f in list("files") {
        out.push((format!("files:{}", name(&f, "file")), vec![]));
    }
    for j in list("jobs") {
        out.push((format!("jobs:{}", name(&j, "name")), vec![]));
    }
    for j in list("jev_integrations") {
        out.push((format!("jev:{}", name(&j, "id")), vec![]));
    }
    for s in list("switches") {
        out.push((format!("switches:{}", name(&s, "id")), vec![]));
    }
    for s in list("sources") {
        out.push((format!("sources:{}", name(&s, "source")), vec![]));
    }
    out
}

/// The coverage report: features no selector of `web.coverage` matches, features a screen shows but cannot edit (the metadata
/// they lack), and selectors that match nothing. `web.coverage` (screen to selectors, `kind:glob`) belongs to the web server's
/// settings; without it every feature is unmatched.
pub fn coverage() -> Value {
    let doc = match describe(&[], false) {
        Ok(d) => d,
        Err(e) => return json!({"error": e}),
    };
    let feats = features(&doc);
    let screens: Vec<(&str, Vec<&str>)> = defaults::get("web.coverage").and_then(|e| e.value.as_table()).map(|t| t.iter().map(|(k, v)| (*k, v.strings())).collect()).unwrap_or_default();
    let selectors: Vec<(&str, &str)> = screens.iter().flat_map(|(s, sels)| sels.iter().map(move |x| (*s, *x))).collect();
    let (mut unmatched, mut unready, mut covered) = (Vec::new(), Vec::new(), 0usize);
    for (id, missing) in &feats {
        let hit: Vec<&str> = selectors.iter().filter(|(_, sel)| glob(sel, id)).map(|(s, _)| *s).collect();
        if hit.is_empty() {
            unmatched.push(json!(id));
            continue;
        }
        covered += 1;
        if !missing.is_empty() {
            unready.push(json!({"id": id, "screens": hit, "missing": missing}));
        }
    }
    let stale: Vec<Value> = selectors.iter().filter(|(_, sel)| !feats.iter().any(|(id, _)| glob(sel, id))).map(|(s, sel)| json!({"screen": s, "selector": sel})).collect();
    json!({"features": feats.len(), "covered": covered, "selectors_defined": !selectors.is_empty(), "unmatched": unmatched, "unready": unready, "stale_selectors": stale})
}

/// The self-description: the generated reference (`docs --json`) plus the bindings, reads, switches, jobs and control verbs; all
/// parts, or the named ones.
pub fn describe(wanted: &[String], with_coverage: bool) -> Result<Value, String> {
    let known = defaults::list("webapi.describe_parts");
    if let Some(bad) = wanted.iter().find(|w| !known.contains(&w.as_str())) {
        return Err(defaults::render("webapi.msg_unknown_part", &[("part", bad), ("parts", &known.join(", "))]));
    }
    let want = |p: &str| wanted.is_empty() || wanted.iter().any(|w| w == p);
    let mut base = docs::json();
    let sw = switches();
    let mut out = serde_json::Map::new();
    out.insert("generated_ms".into(), json!(crate::health::now_ms()));
    out.insert("version".into(), json!(crate::version()));
    for part in &known {
        if !want(part) {
            continue;
        }
        let v = match *part {
            "settings_registry" => crate::ops::settings::registry_value(),
            "files" => config(),
            "checks" => checks_part(&sw),
            "bindings" => bindings(),
            "scripts" => scripts(),
            "jev_integrations" => crate::ops::settings::integrations_value(),
            "switches" => Value::Array(sw.clone()),
            "jobs" => jobs(),
            "ctl_verbs" => ctl_verbs(),
            "sources" => super::query::source_list().into(),
            other => base.get_mut(other).map(Value::take).unwrap_or(Value::Null),
        };
        out.insert((*part).into(), v);
    }
    if with_coverage {
        out.insert("coverage".into(), coverage());
    }
    Ok(Value::Object(out))
}
