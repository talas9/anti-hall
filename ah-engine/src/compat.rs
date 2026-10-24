//! Version compatibility between the four parts of an install: the plugin, the engine, the hook client (ah-hook) and the dashboard
//! (ah-web). Each part has its own version and declares the minimum it supports of every other part. This engine's own minimums are
//! the true constants below (a compatibility contract of the build, like a protocol version); the plugin's minimums are data in its
//! `engine/defaults` (`compat.*`), and the hook client reports its own `engine_min` with each request. A mismatch is only ever
//! reported (status, doctor, one log line): it never blocks a session.
use crate::defaults;
use serde_json::{Value, json};

/// The lowest plugin version this engine runs.
pub const PLUGIN_MIN: &str = "0.301.1";
/// The lowest hook client version this engine serves.
pub const HOOK_MIN: &str = "0.2.0";
/// The lowest dashboard version this engine serves.
pub const WEB_MIN: &str = "0.2.0";

/// One requirement: `needer` (at `needer_version`) needs `needs` to be at least `required`; `actual` is what is installed
/// (empty when not known).
struct Pair<'a> {
    needer: &'a str,
    needer_version: &'a str,
    needs: &'a str,
    required: &'a str,
    actual: &'a str,
}

/// Whether `actual` meets `required`: `None` when either is unknown (an unknown part is never a mismatch).
fn meets(required: &str, actual: &str) -> Option<bool> {
    if required.is_empty() || actual.is_empty() {
        return None;
    }
    Some(crate::version_cmp(actual, required) != std::cmp::Ordering::Less)
}

/// The mismatch line for one requirement, or `None` when it holds or one side is not known.
pub fn check(needer: &str, needer_version: &str, needs: &str, required: &str, actual: &str) -> Option<String> {
    (meets(required, actual) == Some(false)).then(|| {
        defaults::render("compat.msg_mismatch", &[("needer", &needer), ("needer_version", &needer_version), ("needs", &needs), ("required", &required), ("actual", &actual)])
    })
}

fn row(p: &Pair) -> Value {
    let message = check(p.needer, p.needer_version, p.needs, p.required, p.actual);
    let state = match (meets(p.required, p.actual), &message) {
        (_, Some(_)) => defaults::text("compat.state_mismatch"),
        (Some(_), None) => defaults::text("compat.state_ok"),
        (None, None) => defaults::text("compat.state_unknown"),
    };
    json!({"needer": p.needer, "needs": p.needs, "required": p.required, "actual": p.actual, "state": state, "ok": message.is_none(), "message": message.unwrap_or_default()})
}

/// Every pair this engine can check. `hook_needs_engine` is the minimum engine version the hook client reported; `web` is empty
/// when the dashboard version is not known to the engine (the dashboard checks its own side).
pub fn report(plugin: &str, hook: &str, hook_needs_engine: &str, web: &str) -> Value {
    let engine = crate::version();
    let (engine_min, hook_min, web_min) = (defaults::text("compat.engine_min"), defaults::text("compat.hook_min"), defaults::text("compat.web_min"));
    let (p, e, h, w) = (defaults::text("compat.part_plugin"), defaults::text("compat.part_engine"), defaults::text("compat.part_hook"), defaults::text("compat.part_web"));
    let pairs = [
        Pair { needer: e, needer_version: &engine, needs: p, required: PLUGIN_MIN, actual: plugin },
        Pair { needer: p, needer_version: plugin, needs: e, required: engine_min, actual: &engine },
        Pair { needer: e, needer_version: &engine, needs: h, required: HOOK_MIN, actual: hook },
        Pair { needer: p, needer_version: plugin, needs: h, required: hook_min, actual: hook },
        Pair { needer: h, needer_version: hook, needs: e, required: hook_needs_engine, actual: &engine },
        Pair { needer: e, needer_version: &engine, needs: w, required: WEB_MIN, actual: web },
        Pair { needer: p, needer_version: plugin, needs: w, required: web_min, actual: web },
    ];
    let rows: Vec<Value> = pairs.iter().map(row).collect();
    let ok = rows.iter().all(|r| r["ok"].as_bool().unwrap_or(true));
    json!({"ok": ok, "pairs": rows})
}

/// The messages of the pairs that do not hold, one line each.
pub fn mismatches(report: &Value) -> Vec<String> {
    report["pairs"].as_array().map(|a| a.iter().filter(|r| r["ok"] == false).filter_map(|r| r["message"].as_str().map(str::to_string)).collect()).unwrap_or_default()
}
