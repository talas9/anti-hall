//! The per-prompt Stop budget (`hooks/lib/stop-policy.js` `budgetSpent`, `guards.stopNagBudgetPerPrompt`, off by default):
//! at most N blocks per user prompt, counted in `~/.anti-hall/devswarm/stop-policy/<session>.json` under
//! `<session>|task-guard|prompt`. Consulted only once the Stop will block; a spent budget lets the Stop through.
use super::demand::parse_js;
use crate::checks::git::util::Settings;
use crate::checks::guardkit::jsval::Js;
use crate::checks::guardkit::settings::get_number;
use crate::checks::guardkit::text::js_trim;
use crate::checks::taskkit::jsval::{R, Unsure, get, truthy};
use crate::checks::taskstate::parse::maybe_valid_for_js;
use crate::defaults;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// `promptKey(payload, transcriptPath)`: the payload's `prompt_id`, else the uuid of the newest real user entry in the tail.
fn prompt_key(p: &Value, transcript: &str) -> R<Option<String>> {
    if let Some(Value::String(id)) = get(p, defaults::text("task_guard.prompt_id_key"))
        && !id.is_empty()
    {
        return Ok(Some(id.clone()));
    }
    let Some((data, truncated)) = crate::checks::taskstate::tail::read_tail(transcript, defaults::num("taskstate.tail_bytes")) else { return Ok(None) };
    let mut lines: Vec<&str> = data.split('\n').collect();
    if truncated && !lines.is_empty() {
        lines.remove(0);
    }
    let user = defaults::text("task_guard.user_type");
    let needle = format!("\"{user}\"");
    for line in lines.iter().rev() {
        let t = js_trim(line);
        if t.is_empty() || !t.contains(&needle) {
            continue;
        }
        let e: Value = match serde_json::from_str(t) {
            Ok(v) => v,
            Err(_) if maybe_valid_for_js(t) => return Err(Unsure),
            Err(_) => continue,
        };
        if get(&e, "type").and_then(Value::as_str) != Some(user) || get(&e, "isMeta") == Some(&Value::Bool(true)) || get(&e, "isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        let Some(Value::String(uuid)) = get(&e, "uuid").filter(|u| truthy(u)) else { continue };
        let real = match get(&e, "message").filter(|m| truthy(m)).and_then(|m| get(m, "content")) {
            Some(Value::String(s)) => !js_trim(s).is_empty(),
            Some(Value::Array(a)) => a.iter().any(|b| truthy(b) && get(b, "type").and_then(Value::as_str) != Some(defaults::text("task_guard.tool_result_type"))),
            _ => false,
        };
        if real {
            return Ok(Some(uuid.clone()));
        }
    }
    Ok(None)
}

/// What a spent-budget check leaves to do: nothing, or one write of the bucket file before the block.
pub enum Budget {
    /// No budget applies, or one is left: block. `Some` carries the bucket file to write first.
    Block(Option<(PathBuf, String)>),
    /// The budget for this prompt is spent: let the Stop through.
    Spent,
}

/// `budgetSpent({ home, sessionId, hook, payload, transcriptPath })`, without its write: the caller writes the bucket file
/// it returns, and a failed write lets the Stop through as in Node.
pub fn check(st: &Settings, home: Option<&str>, safe_session: &str, p: &Value, transcript: &str) -> R<Budget> {
    let Some(home) = home else { return Ok(Budget::Block(None)) };
    let v = get_number(st, defaults::raw("task_guard.budget_setting"));
    let budget = if v.is_finite() && v > 0.0 { v.floor() } else { 0.0 };
    if budget == 0.0 {
        return Ok(Budget::Block(None));
    }
    let Some(key) = prompt_key(p, transcript)? else { return Ok(Budget::Block(None)) };
    let mut file = Path::new(home).join(defaults::text("paths.base_dir"));
    file.extend(defaults::list("task_guard.stop_policy_dir"));
    let file = file.join(format!("{safe_session}{}", defaults::text("task_guard.stop_policy_ext")));
    let mut buckets = match std::fs::read(&file) {
        Ok(b) => match parse_js(&crate::checks::guardkit::text::lossy_owned(b))? {
            Some(o @ Js::Obj(_)) => o,
            _ => Js::Obj(Vec::new()),
        },
        Err(_) => Js::Obj(Vec::new()),
    };
    let bk = format!("{safe_session}|{}|{}", defaults::text("task_guard.guard_name"), defaults::text("task_guard.budget_bucket"));
    let (k_key, k_count, k_at) = (defaults::text("task_guard.budget_key_field"), defaults::text("task_guard.budget_count_field"), defaults::text("task_guard.budget_at_field"));
    let n = match buckets.get(&bk) {
        Some(b) if b.get(k_key).and_then(Js::as_str) == Some(key.as_str()) => b.get(k_count).and_then(Js::as_f64).filter(|c| c.is_finite()).unwrap_or(0.0),
        _ => 0.0,
    };
    if n >= budget {
        return Ok(Budget::Spent);
    }
    let now = crate::checks::agent_scan::now_ms();
    buckets.set(&bk, Js::Obj(vec![(k_key.to_string(), Js::Str(key)), (k_count.to_string(), Js::Num(n + 1.0)), (k_at.to_string(), Js::Num(now))]));
    Ok(Budget::Block(Some((file, buckets.stringify()))))
}

/// `writeBuckets`: the directory made, a temporary file renamed over the target. False on any failure.
pub fn write(file: &Path, body: &str) -> bool {
    if let Some(d) = file.parent()
        && std::fs::create_dir_all(d).is_err()
    {
        return false;
    }
    crate::atomic::write_styled(file, body, crate::atomic::Style { keep_json_ext: false, leave_temp_on_rename_failure: true, ..Default::default() }).is_ok()
}
