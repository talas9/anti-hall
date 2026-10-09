//! `ah-engine telemetry [summary|events|rollup]` (D78).
//!
//! `summary` and `events` ask the running daemon (so they include what it has recorded but not flushed yet) and fall back to
//! reading the databases. `rollup` works on the database files directly, like `maintain`: it is idempotent, and SQLite's locks keep them apart from the daemon's own writes.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use super::persist::TelDb;
use super::report;
use crate::discard::Logged;
use crate::{client, defaults, paths};
use serde_json::{Value, json};

/// A flag's value: the word after `--<name>` (empty when absent).
fn flag(rest: &[String], name: &str) -> String {
    let f = format!("--{name}");
    rest.iter().position(|a| *a == f).and_then(|i| rest.get(i + 1)).cloned().unwrap_or_default()
}

fn now_ms() -> u64 {
    crate::health::now_ms()
}

/// Open the databases for reading; `None` when no database exists yet.
pub(crate) fn open_existing() -> Option<TelDb> {
    let dir = paths::dir();
    if !dir.join(defaults::text("storage.hot_file")).exists() {
        return None;
    }
    crate::db::Db::open(&dir).ok_logged("tel_db_open").map(TelDb::new)
}

/// Open (creating if needed) the databases for a command that writes.
fn open_for_write() -> Result<TelDb, String> {
    let dir = paths::dir();
    crate::limits::ensure_private_dir(&dir).map_err(|e| e.to_string())?;
    crate::db::Db::open(&dir).map(TelDb::new).map_err(|e| e.to_string())
}

/// Run a telemetry subcommand (`rest` is everything after the command word, without `--json`). Returns the report and the
/// exit code.
pub fn run(rest: &[String]) -> (Value, i32) {
    let sub = rest.first().filter(|w| !w.starts_with("--")).map(String::as_str).unwrap_or("summary");
    let window = flag(rest, "window");
    match sub {
        "summary" | "events" => {
            let (kind, limit) = (flag(rest, "kind"), flag(rest, "limit"));
            let mut verb = format!("telemetry {sub} window={}", window);
            if !kind.is_empty() {
                verb.push_str(&format!(" kind={kind}"));
            }
            if !limit.is_empty() {
                verb.push_str(&format!(" limit={limit}"));
            }
            if let Some(mut v) = client::ctl_json(&verb) {
                v["from"] = json!("daemon");
                return (v, 0);
            }
            let tel = open_existing();
            let days = report::window_days(&window);
            let mut v = if sub == "events" {
                report::events_json(tel.as_ref(), None, &kind, days, limit.parse().unwrap_or(defaults::num("telemetry.recent_default") as usize), now_ms())
            } else {
                report::summary_json(tel.as_ref(), None, days, now_ms())
            };
            v["from"] = json!("files");
            v["running"] = json!(false);
            (v, 0)
        }
        "rollup" => match open_for_write().and_then(|t| t.rollup(now_ms(), defaults::num("telemetry.retention_days")).map_err(|e| e.to_string())) {
            Ok(v) => (v, 0),
            Err(e) => (json!({"error": e}), 1),
        },
        other => (json!({"error": defaults::render("msg.cli_unknown", &[("command", &format!("telemetry {other}"))])}), 64),
    }
}
