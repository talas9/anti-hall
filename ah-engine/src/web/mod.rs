//! The web data API (GH #266; plan v3 rev 2, 4 and 7): what the dashboard and agents read and write, as three verbs and the same functions in process.
//!
//! * [`describe`]: the engine's generated self-description (verbs, settings, config files and keys, checks, hook bindings,
//!   scripts, Jev integrations, feature switches, query topics and a coverage list). Nothing in it is hand-kept: every part is
//!   read from a registry the engine already has.
//! * [`query`]: a read-only, paginated query over the existing stores (telemetry, per-check stats, counters, agents, status,
//!   the config history). The sources are the `webapi.source_*` settings; `--schema` describes one.
//! * [`set`], [`reset`], [`undo`], [`history`]: the `config` write verbs: validated, the previous value kept, every write in
//!   `config-history.ndjson`.
//!
//! Every topic name, limit and text is in `defaults/webapi.toml`; the code only maps a topic's `source` to the function that
//! reads it. No background work: each call reads what it needs and returns.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an absent field is the empty value
// - a line of the audit log that is not JSON is skipped: a torn tail line must not hide the rows before it
// A failure that must be seen goes through `crate::discard` instead.
pub mod actions;
mod agentsctl;
pub mod decisions;
mod describe;
mod history;
mod impactcmp;
mod insights;
pub mod io;
mod manage;
pub mod mesh_events;
pub mod pulse;
mod query;

pub use describe::{coverage, describe};
pub use manage::{Written, history, reset, set, undo};
pub use query::{Page, query};

use crate::checks::jsport::json::J;
use crate::cli::{Parsed, human};
use crate::defaults;
use serde_json::{Map, Value};

/// A JavaScript-shaped value as JSON.
pub(crate) fn j_to_value(j: &J) -> Value {
    match j {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(*b),
        J::Num(n) => {
            if n.is_finite() && n.fract() == 0.0 && n.abs() < 9.0e15 {
                Value::from(*n as i64)
            } else {
                serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number)
            }
        }
        J::Str(s) => Value::String(s.clone()),
        J::Arr(a) => Value::Array(a.iter().map(j_to_value).collect()),
        J::Obj(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), j_to_value(v))).collect::<Map<_, _>>()),
    }
}

/// A flag's value: the word after `--<name>` (empty when absent).
pub(crate) fn flag(rest: &[String], name: &str) -> String {
    let f = format!("--{name}");
    rest.iter().position(|a| *a == f).and_then(|i| rest.get(i + 1)).cloned().unwrap_or_default()
}

/// The words of `rest` that are not flags or flag values (`--flag value` pairs and bare `--flag`s are dropped).
pub(crate) fn positionals(rest: &[String]) -> Vec<String> {
    let valueless = ["--confirmed", "--json", "--all"];
    let mut out = Vec::new();
    let mut skip = false;
    for a in rest {
        if skip {
            skip = false;
        } else if a.starts_with("--") {
            skip = !valueless.contains(&a.as_str());
        } else {
            out.push(a.clone());
        }
    }
    out
}

fn print(p: &Parsed, v: &Value) {
    println!("{}", if p.json { v.to_string() } else { human(v) });
}

/// `describe [--part a,b] [--coverage]`
pub fn cmd_describe(p: &Parsed) -> i32 {
    if p.rest.iter().any(|a| a == "--coverage") && flag(&p.rest, "part").is_empty() {
        print(p, &coverage());
        return 0;
    }
    let parts: Vec<String> = flag(&p.rest, "part").split(',').filter(|s| !s.is_empty()).map(str::to_string).collect();
    match describe(&parts, p.rest.iter().any(|a| a == "--coverage")) {
        Ok(v) => {
            print(p, &v);
            0
        }
        Err(e) => {
            print(p, &serde_json::json!({"error": e}));
            64
        }
    }
}

/// `query <source> [filters]`
pub fn cmd_query(p: &Parsed) -> i32 {
    let topic = positionals(&p.rest).into_iter().next().unwrap_or_default();
    match query(&topic, &p.rest) {
        Ok(v) => {
            print(p, &v);
            0
        }
        Err(e) => {
            print(p, &serde_json::json!({"error": e}));
            64
        }
    }
}

/// `config set|reset|apply|undo|history ...` (the write side of `config`); `None` when `rest` is not one of those verbs.
pub fn cmd_config_write(p: &Parsed) -> Option<i32> {
    let words = positionals(&p.rest);
    let confirmed = p.rest.iter().any(|a| a == "--confirmed");
    let check = p.rest.iter().any(|a| a == "--check");
    let result = match words.first().map(String::as_str) {
        Some("set") => match (words.get(1), words.get(2)) {
            (Some(k), Some(v)) => set(k, v, confirmed, check),
            _ => Err(defaults::text("webapi.msg_usage_set").to_string()),
        },
        Some("reset") => match words.get(1) {
            Some(k) => reset(k, confirmed),
            None => Err(defaults::text("webapi.msg_config_usage").to_string()),
        },
        Some("undo") => match words.get(1) {
            Some(id) => undo(id, confirmed),
            None => Err(defaults::text("webapi.msg_config_usage").to_string()),
        },
        Some("apply") => {
            // a running daemon re-reads the files now instead of at its next poll
            let reply = crate::client::ctl_json("reload");
            print(p, &serde_json::json!({"ok": true, "daemon_running": reply.is_some(), "reload": reply}));
            return Some(0);
        }
        Some("history") => {
            print(p, &history(&p.rest));
            return Some(0);
        }
        _ => return None,
    };
    Some(match result {
        Ok(w) => {
            print(p, &w.to_json());
            if w.ok { 0 } else { 1 }
        }
        Err(e) => {
            print(p, &serde_json::json!({"ok": false, "error": e}));
            1
        }
    })
}

/// Answer a dashboard `CTL` verb that needs no daemon state, `None` when `verb` is not one of them (`pulse` needs the daemon's
/// counters and is built in `daemon.rs`).
pub fn dispatch(verb: &str, args: &str) -> Option<String> {
    let want = |k: &str| args.split_whitespace().find_map(|a| a.strip_prefix(k).map(str::to_string));
    match verb {
        "mesh-events" => Some(mesh_events::events(args).to_string()),
        "mesh-msg" => Some(mesh_events::message(args).to_string()),
        "decisions" => Some(decisions::snapshot(args).to_string()),
        "io" => Some(io::snapshot(args).to_string()),
        "agents" => Some(crate::agents::web_document(want("since=").as_deref(), want("agent=").as_deref()).to_string()),
        _ => None,
    }
}
