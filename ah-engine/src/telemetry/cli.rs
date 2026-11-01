//! `ah-engine telemetry [summary|events|rollup|actions|funnel|report]` (D78). `funnel [--by model,project] [--since 6h | --from T --to T]` is the per-rule delivery funnel (`crate::funnel`); `report` is the weekly report (`crate::freport`: the funnel plus per-check latency and failures, 7 days and model,project unless asked otherwise). `actions [feature]` reports what the acting features did and got wrong (`actlog`).
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

/// The advisory counters (advisor adherence, availability and every other advisory kind) as `status` shows them: the durable
/// journal plus this process's own table, so `telemetry summary` carries them whether or not a daemon answered.
fn advisory_counts() -> Value {
    crate::obs::counters::snapshot().get("advisory").cloned().unwrap_or_else(|| json!({}))
}

/// Run a telemetry subcommand (`rest` is everything after the command word, without `--json`). Returns the report and the
/// exit code.
pub fn run(rest: &[String]) -> (Value, i32) {
    let sub = rest.first().filter(|w| !w.starts_with("--")).map(String::as_str).unwrap_or("summary");
    let window = flag(rest, "window");
    let funnel_like = sub == defaults::text("delivery.report_verb") || sub == defaults::text("delivery.report_weekly_verb");
    // the funnel reports take any window length (`6h`, `90m`); the other reports keep per-day data, so they take whole days
    if !funnel_like && let Err(e) = report::check_window(&window) {
        return (json!({"error": e}), 64);
    }
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
                if sub == "summary" {
                    v["advisory"] = advisory_counts();
                }
                return (v, 0);
            }
            let tel = open_existing();
            let days = report::window_days(&window);
            let mut v = if sub == "events" {
                report::events_json(tel.as_ref(), None, &kind, days, limit.parse().unwrap_or(defaults::num("telemetry.recent_default") as usize), now_ms())
            } else {
                report::summary_json(tel.as_ref(), None, days, now_ms())
            };
            if sub == "summary" {
                v["agent_cost"] = crate::agents::cost_report();
                v["advisory"] = advisory_counts();
            }
            v["from"] = json!("files");
            v["running"] = json!(false);
            (v, 0)
        }
        "actions" => crate::actlog::run_cli(rest),
        _ if funnel_like => funnel_report(rest, sub == defaults::text("delivery.report_weekly_verb"), &window),
        "rollup" => match open_for_write().and_then(|t| t.rollup(now_ms(), defaults::num("telemetry.retention_days")).map_err(|e| e.to_string())) {
            Ok(v) => (v, 0),
            Err(e) => (json!({"error": e}), 1),
        },
        other => (json!({"error": defaults::render("msg.cli_unknown", &[("command", &format!("telemetry {other}"))])}), 64),
    }
}

/// `telemetry funnel` / `telemetry report`: ask the running daemon (it holds the live counters), else read the stored metrics
/// snapshots (`from: files`; the end of the window is then the last snapshot). `weekly` fills the defaults of the weekly report and
/// adds the latency and failure sections.
fn funnel_report(rest: &[String], weekly: bool, window: &str) -> (Value, i32) {
    let (mut by, mut since) = (flag(rest, "by"), flag(rest, "since"));
    if since.is_empty() {
        since = window.to_string();
    }
    let (mut from, mut to) = (flag(rest, "from"), flag(rest, "to"));
    if weekly {
        if by.is_empty() {
            by = defaults::text("delivery.report_weekly_by").to_string();
        }
        if since.is_empty() && from.is_empty() && to.is_empty() {
            since = defaults::text("delivery.report_weekly_window").to_string();
        }
    }
    // absolute times go to the daemon as epoch ms (one word: its request line is split on spaces), and a bad one fails here
    for (name, v) in [("--from", &mut from), ("--to", &mut to)] {
        if !v.is_empty() {
            match crate::freport::parse_time_ms(v) {
                Some(ms) => *v = ms.to_string(),
                None => return (json!({"error": defaults::render("delivery.report_bad_time", &[("flag", &name), ("value", &v.as_str())])}), 64),
            }
        }
    }
    let ask = crate::telemetry::ReportAsk { by, since, from, to, full: weekly, stored: false };
    let verb = defaults::text(if weekly { "delivery.report_weekly_verb" } else { "delivery.report_verb" });
    let mut line = format!("telemetry {verb}");
    for (k, v) in [("by", &ask.by), ("since", &ask.since), ("from", &ask.from), ("to", &ask.to)] {
        if !v.is_empty() {
            line.push_str(&format!(" {k}={}", v.split_whitespace().collect::<String>()));
        }
    }
    let code_of = |v: &Value| if v.get("error").is_some() { 64 } else { 0 };
    if let Some(mut v) = client::ctl_json(&line) {
        v["from"] = json!("daemon");
        return (v.clone(), code_of(&v));
    }
    // no daemon: the stored snapshots of the last run
    let stored = open_existing().is_some().then(|| crate::db::Db::open(&paths::dir()).ok_logged("tel_db_open")).flatten().map(|db| {
        let t = crate::telemetry::Telemetry::with_store(Box::new(crate::storage::SqliteStore::new(db)));
        t.restore_metrics();
        t.funnel_report(&crate::telemetry::ReportAsk { stored: true, ..ask })
    });
    match stored {
        Some(mut v) => {
            v["from"] = json!("files");
            (v.clone(), code_of(&v))
        }
        None => (json!({"error": defaults::text("delivery.report_no_daemon")}), 1),
    }
}
