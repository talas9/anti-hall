//! The gates of `hooks/repair-on-reload.js` (SessionStart and UserPromptSubmit).
use super::*;
use crate::checks::guardkit::jsre;
use crate::checks::guardkit::settings::{enabled, is_skipped};
use crate::checks::guardkit::text::js_trim;

/// The registered `repair-on-reload` check.
pub struct RepairOnReload;

/// `isSubagentByPayload(payload)`: an agent marker key present with a value other than null.
fn subagent_by_payload(p: &Value) -> bool {
    p.as_object().is_some_and(|o| defaults::list("session_gates.agent_key_markers").iter().any(|k| o.get(*k).is_some_and(|v| !v.is_null())))
}

/// `[major, minor, patch]` of a plain three-part version.
fn triple(v: &str) -> Option<[f64; 3]> {
    if !jsre::compile(defaults::text("repair_reload.version_re"), false).is_match(v) {
        return None;
    }
    let mut it = v.split('.').map(|x| x.parse::<f64>().unwrap_or(f64::NAN));
    Some([it.next()?, it.next()?, it.next()?])
}

/// `semverCmp(a, b) >= 0` for two plain versions.
fn at_least(a: [f64; 3], b: [f64; 3]) -> bool {
    for i in 0..3 {
        if a[i] != b[i] {
            return a[i] - b[i] >= 0.0;
        }
    }
    true
}

/// `repairPending(home, version)`: some default migration has no marker at the running version or newer.
fn repair_pending(st: &Settings, version: [f64; 3]) -> bool {
    let markers = read_object(st, defaults::text("guardkit.migration_markers_file")).unwrap_or_default();
    defaults::list("repair_reload.migration_keys").iter().any(|k| {
        let done = markers.get(*k).and_then(Value::as_object).and_then(|m| m.get("completedVersion")).and_then(Value::as_str).and_then(triple);
        !done.is_some_and(|d| at_least(d, version))
    })
}

/// `inCooldown(home, now, version)`.
fn in_cooldown(st: &Settings, version: &str) -> bool {
    let rel = format!("{}/{}", defaults::text("session_gates.anti_hall_dir"), defaults::text("repair_reload.cooldown_file"));
    let Some(last) = read_object(st, &rel) else { return false };
    if last.get("version").and_then(Value::as_str) != Some(version) {
        return false;
    }
    last.get("ts").and_then(Value::as_f64).is_some_and(|ts| {
        let age = now_ms() - ts;
        ts.is_finite() && age >= 0.0 && age < defaults::num("repair_reload.cooldown_ms") as f64
    })
}

/// `Ok(())` when the Node hook would start no repair; `Err` when it might.
///
/// The Node hook returns, in this order: in a judge child; with the switch off; on a subagent turn; when skipped; when the
/// plugin manifest cannot be read; with every default migration stamped at the running version or newer; within the
/// cooldown after a start. Past all of them it takes the lock and starts the detached repair, which is Node's to do.
pub(crate) fn decide(payload: &Value, st: &Settings, root: &str) -> Gate {
    if judge_child(st) {
        return Ok(());
    }
    if !enabled(st, defaults::raw("repair_reload.setting"), root)? {
        return Ok(());
    }
    if subagent_by_payload(payload) {
        return Ok(());
    }
    if is_skipped(st, defaults::text("repair_reload.guard_name")) {
        return Ok(());
    }
    if root.is_empty() {
        return Err(Undecidable);
    }
    let manifest = std::fs::read_to_string(format!("{root}/{}", defaults::text("guardkit.plugin_manifest"))).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let Some(version) = manifest.as_ref().and_then(|m| m.get("version")).and_then(Value::as_str).filter(|v| !v.is_empty()) else { return Ok(()) };
    // A version that is not a plain three-part one is compared by Node with NaN arithmetic; leave it to Node.
    let Some(running) = triple(js_trim(version)).filter(|_| js_trim(version) == version) else { return Err(Undecidable) };
    if !repair_pending(st, running) {
        return Ok(());
    }
    if in_cooldown(st, version) {
        return Ok(());
    }
    Err(Undecidable)
}

#[cfg(test)]
pub(super) fn triple_for_test(v: &str) -> Option<[f64; 3]> {
    triple(v)
}

#[cfg(test)]
pub(super) fn at_least_for_test(a: [f64; 3], b: [f64; 3]) -> bool {
    at_least(a, b)
}

gate_check!(RepairOnReload, "repair-on-reload", "repair_reload.summary", decide);
