//! `describe`: the generated inventory. Each part reads a registry the engine already has (the command registry, the settings
//! registry, the shipped defaults, the check registry, the dispatch table, the Jev integrations); none is written by hand.
use crate::defaults::{self, V};
use crate::dispatch::table;
use crate::{checks, cli, cfgstore};
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
    json!({"host": host, "event": event, "id": e.id, "matcher": e.matcher, "timeout_s": e.timeout_s, "check": e.check, "runner": runner(&e.command), "conditional": e.when.is_some()})
}

fn verbs() -> Value {
    Value::Array(cli::commands().into_iter().map(|c| json!({"name": c.name, "args": c.args, "read_only": c.read_only, "read_only_args": c.read_only_args, "status": c.status, "help": c.doc})).collect())
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

fn checks_part() -> Value {
    let entries = all_entries();
    let all = defaults::all();
    let list: Vec<Value> = checks::registry()
        .iter()
        .map(|c| {
            let bound: Vec<&(&str, &str, table::Entry)> = entries.iter().filter(|(_, _, e)| e.check.as_deref() == Some(c.name())).collect();
            let ids: Vec<&str> = bound.iter().map(|(_, _, e)| e.id.as_str()).collect();
            let sections = check_sections(c.name(), &ids);
            let keys: Vec<&str> = all.iter().filter(|e| e.key.split('.').next().is_some_and(|s| sections.contains(s))).map(|e| e.key).collect();
            json!({
                "name": c.name(), "summary": c.summary(), "scripted": c.scripted(),
                "bindings": bound.iter().map(|(h, ev, e)| entry_json(h, ev, e)).collect::<Vec<_>>(),
                "config_keys": keys,
            })
        })
        .collect();
    json!({"note": defaults::text("webapi.derivation_note"), "checks": list})
}

fn hooks() -> Value {
    let entries = all_entries();
    let mut by_host: BTreeMap<&str, BTreeMap<&str, Vec<Value>>> = BTreeMap::new();
    for (h, ev, e) in &entries {
        by_host.entry(h).or_default().entry(ev).or_default().push(entry_json(h, ev, e));
    }
    Value::Array(by_host.into_iter().map(|(host, events)| json!({"host": host, "events": events.into_iter().map(|(event, entries)| json!({"event": event, "entries": entries})).collect::<Vec<_>>()})).collect())
}

/// The hook entries no built-in check answers: scripts (and shell hooks) the dispatcher runs as they are.
fn scripts() -> Value {
    Value::Array(all_entries().iter().filter(|(_, _, e)| e.check.is_none()).map(|(h, ev, e)| entry_json(h, ev, e)).collect())
}

/// The feature switches: shipped settings that name a settings.json boolean (section, key, env, default).
fn switches() -> Value {
    let st = crate::checks::git::util::Settings::from_env(&crate::reqenv::RequestEnv::capture());
    let suffix = defaults::text("webapi.switch_key_suffix");
    Value::Array(
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
            .collect(),
    )
}

fn topics() -> Value {
    Value::Array(
        defaults::with_prefix("webapi.topic_")
            .iter()
            .map(|e| json!({"name": &e.key["webapi.topic_".len()..], "doc": e.doc, "source": e.value.str_field("source"), "filters": e.value.get("filters").map(|f| f.strings()), "params": e.value.get("params").map(|f| f.strings())}))
            .collect(),
    )
}

/// One row per thing the dashboard should cover, with the screen that covers it (`webapi.coverage_screens`; null when none does).
fn coverage(parts: &BTreeMap<&str, Value>) -> Value {
    let screens = defaults::raw("webapi.coverage_screens");
    let mut rows: Vec<(String, &str, String)> = Vec::new();
    let names = |part: &str, f: &dyn Fn(&Value) -> Option<String>| -> Vec<String> {
        parts.get(part).and_then(Value::as_array).map(|a| a.iter().filter_map(f).collect()).unwrap_or_default()
    };
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(str::to_string);
    for n in names("verbs", &|v| s(v, "name")) {
        rows.push((format!("verb:{n}"), "verb", n));
    }
    let sections: BTreeSet<String> = names("settings", &|v| s(v, "section")).into_iter().collect();
    for n in sections {
        rows.push((format!("section:{n}"), "settings_section", n));
    }
    for n in names("config", &|v| s(v, "file")) {
        rows.push((format!("file:{n}"), "config_file", n));
    }
    if let Some(a) = parts.get("checks").and_then(|c| c.get("checks")).and_then(Value::as_array) {
        for n in a.iter().filter_map(|v| s(v, "name")) {
            rows.push((format!("check:{n}"), "check", n));
        }
    }
    for n in names("jev", &|v| s(v, "id")) {
        rows.push((format!("jev:{n}"), "jev_integration", n));
    }
    for n in names("switches", &|v| s(v, "id")) {
        rows.push((format!("switch:{n}"), "switch", n));
    }
    for n in names("topics", &|v| s(v, "name")) {
        rows.push((format!("topic:{n}"), "topic", n));
    }
    Value::Array(rows.into_iter().map(|(id, kind, name)| json!({"id": id, "kind": kind, "name": name, "screen": screens.get(&id).and_then(V::as_str)})).collect())
}

/// The self-description: all parts, or the named ones (`coverage` needs the parts it lists, so it builds them itself).
pub fn describe(wanted: &[String]) -> Result<Value, String> {
    let known = defaults::list("webapi.describe_parts");
    if let Some(bad) = wanted.iter().find(|w| !known.contains(&w.as_str())) {
        return Err(defaults::render("webapi.msg_unknown_part", &[("part", bad), ("parts", &known.join(", "))]));
    }
    let want = |p: &str| wanted.is_empty() || wanted.iter().any(|w| w == p);
    let mut parts: BTreeMap<&str, Value> = BTreeMap::new();
    for part in &known {
        let needed_by_coverage = *part != "hooks" && *part != "scripts" && want("coverage");
        if !(want(part) || needed_by_coverage) || *part == "coverage" {
            continue;
        }
        let v = match *part {
            "verbs" => verbs(),
            "settings" => crate::ops::settings::registry_value(),
            "config" => config(),
            "checks" => checks_part(),
            "hooks" => hooks(),
            "scripts" => scripts(),
            "jev" => crate::ops::settings::integrations_value(),
            "switches" => switches(),
            "topics" => topics(),
            _ => continue,
        };
        parts.insert(part, v);
    }
    let cov = want("coverage").then(|| coverage(&parts));
    let mut out = serde_json::Map::new();
    out.insert("generated_ms".into(), json!(crate::health::now_ms()));
    out.insert("version".into(), json!(crate::version()));
    for part in &known {
        if *part == "coverage" {
            if let Some(c) = &cov {
                out.insert("coverage".into(), c.clone());
            }
        } else if want(part)
            && let Some(v) = parts.remove(part)
        {
            out.insert((*part).into(), v);
        }
    }
    Ok(Value::Object(out))
}
