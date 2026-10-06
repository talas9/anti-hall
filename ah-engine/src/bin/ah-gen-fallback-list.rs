//! Generate the POSIX wrapper's fallback list and dispatch fallback map from Claude hooks.json.

use serde_json::Value;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn id_for(command: &str, seen: &mut HashMap<String, usize>) -> String {
    let (script, args) = match command.find("/hooks/") {
        Some(i) => {
            let rest = &command[i + "/hooks/".len()..];
            let rest = rest.strip_prefix('"').unwrap_or(rest);
            let end = rest.find(|c: char| c == '"' || c.is_whitespace()).unwrap_or(rest.len());
            let script = &rest[..end];
            let args = rest[end..].trim().trim_start_matches('"').trim();
            (script.to_string(), args.to_string())
        }
        None => (command.to_string(), String::new()),
    };
    let mut id = script.strip_suffix(".js").unwrap_or(&script).to_string();
    if !args.is_empty() {
        id.push(':');
        id.push_str(&args.trim_start_matches('-').split_whitespace().map(|s| s.trim_start_matches('-')).collect::<Vec<_>>().join(":"));
    }
    let n = seen.entry(id.clone()).and_modify(|n| *n += 1).or_insert(1);
    if *n > 1 {
        id = format!("{id}#{n}");
    }
    id
}

fn main() {
    let repo = PathBuf::from(arg("--repo").unwrap_or_else(|| ".".to_string()));
    let hooks_path = arg("--hooks").map(PathBuf::from).unwrap_or_else(|| repo.join("plugins/anti-hall/hooks/hooks.json"));
    let list_path = arg("--list").map(PathBuf::from).unwrap_or_else(|| repo.join("plugins/anti-hall/hooks/ah-fallback.list"));
    let map_path = arg("--map").map(PathBuf::from).unwrap_or_else(|| repo.join("plugins/anti-hall/hooks/ah-fallback.map.json"));

    let root: Value = serde_json::from_str(&fs::read_to_string(&hooks_path).expect("read hooks.json")).expect("parse hooks.json");
    let hooks = root.get("hooks").and_then(Value::as_object).expect("hooks object");
    let mut list = String::from("# Generated from hooks.json by ah-gen-fallback-list. Hook rows are: matcher<TAB>timeout<TAB>command.\n");
    let mut fallback_map = serde_json::Map::new();

    for (event, groups) in hooks {
        let groups = groups.as_array().expect("event groups array");
        let mut max_timeout = 0_u64;
        for group in groups {
            for hook in group.get("hooks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
                max_timeout = max_timeout.max(hook.get("timeout").and_then(Value::as_u64).unwrap_or(0));
            }
        }
        if max_timeout == 0 {
            max_timeout = 10;
        }
        list.push_str(&format!("@{event}\t{max_timeout}\n"));
        let mut event_map = serde_json::Map::new();
        let mut seen = HashMap::new();
        for group in groups {
            let matcher = group.get("matcher").and_then(Value::as_str).unwrap_or("*");
            let matcher = if matcher.is_empty() { "*" } else { matcher };
            for hook in group.get("hooks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
                let command = hook.get("command").and_then(Value::as_str).expect("hook command");
                let timeout = hook.get("timeout").and_then(Value::as_u64).unwrap_or(max_timeout);
                let id = id_for(command, &mut seen);
                list.push_str(&format!("{matcher}\t{timeout}\t{command}\n"));
                event_map.insert(id, Value::String(command.to_string()));
            }
        }
        fallback_map.insert(event.clone(), Value::Object(event_map));
    }

    fs::write(list_path, list).expect("write fallback list");
    fs::write(map_path, serde_json::to_string_pretty(&Value::Object(fallback_map)).expect("serialize fallback map") + "\n").expect("write fallback map");
}
