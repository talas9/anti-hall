//! The witness comparison. Node's supervisor / lifecycle run in a scratch home with a recording stub `hivecontrol` on the PATH;
//! the stub writes one JSON line per requested call (`{"args": [...], "cwd": ...}`). [`node_actions`] reads that record and
//! [`compare`] sets it against what the engine actually ran for the same trigger: a call only one side made is a mismatch.
//! Each comparison is appended to `devswarm_act.shadow_file` so the telemetry report can count agreements per trigger.
use super::exec::append_line;
use crate::defaults;
use serde_json::{Value, json};
use std::path::Path;

/// The calls the stub recorded, in order, as `{args, cwd}` objects (a line that does not parse is skipped).
pub fn node_actions(record: &Path) -> Vec<Value> {
    std::fs::read_to_string(record).unwrap_or_default().lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()).collect()
}

/// The comparison of one trigger. `engine` and `node` are lists of argv arrays (`["workspace","archive","<id>"]`).
pub fn compare(trigger: &str, engine: &[Vec<String>], node: &[Vec<String>]) -> Value {
    let mut only_engine = engine.to_vec();
    let mut only_node = Vec::new();
    for n in node {
        match only_engine.iter().position(|e| e == n) {
            Some(i) => {
                only_engine.remove(i);
            }
            None => only_node.push(n.clone()),
        }
    }
    json!({"trigger": trigger, "match": only_engine.is_empty() && only_node.is_empty(), "engine": engine, "node": node, "onlyEngine": only_engine, "onlyNode": only_node})
}

/// [`compare`], appended to the shadow file of `state_dir` with the time.
pub fn record(state_dir: &Path, now_ms: i64, trigger: &str, engine: &[Vec<String>], node: &[Vec<String>]) -> Value {
    let c = compare(trigger, engine, node);
    let mut line = c.clone();
    line["ts"] = json!(now_ms);
    append_line(&state_dir.join(defaults::text("devswarm_act.shadow_file")), &line);
    c
}
