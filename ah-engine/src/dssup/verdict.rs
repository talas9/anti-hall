//! The mirror of an engine poke / escalation in Node's files: the liveness verdict (`liveness/<id>.json`, written by
//! `recovery.js` `mergeVerdict` + `writeVerdict`) and the recovery log line (`appendLog`). Node's consumers (the doctor, the
//! start-up sampling, the recovery cap) read these files, so an engine-owned poke must leave them as Node would.
//!
//! The JSON is written by hand in Node's key order (`JSON.stringify` of `Object.assign({status}, preserved, extra)`): the
//! engine's JSON maps sort their keys, which would change the bytes.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this module is a deliberate keep, for these reasons:
// - an unreadable previous verdict is an absent one (Node's try/catch): the preserved fields start at their defaults
// - a verdict or log line that cannot be written is lost, never the action's result (Node: `try { writeVerdict } catch {}`)
use crate::defaults;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The verdict file of `id`; `None` for an id that is not a safe file name (Node throws and the caller fails open).
pub fn path(home: &Path, id: &str) -> Option<PathBuf> {
    crate::meshw::idlock::is_safe_id(id).then(|| super::root(home).join(defaults::text("devswarm_sup.liveness_dir")).join(format!("{id}.json")))
}

fn default_of(field: &str) -> Value {
    if defaults::list("devswarm_sup.verdict_zero_fields").contains(&field) { Value::from(0) } else { Value::Null }
}

/// `Object.assign({status}, preserved, extra)` as ordered pairs: a key set again keeps its place, a new key goes last.
pub fn merged(prev: Option<&Value>, status: &str, extra: &[(&str, Value)]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = vec![("status".into(), Value::String(status.into()))];
    for f in defaults::list("devswarm_sup.verdict_fields") {
        let kept = prev.and_then(|p| p.get(f)).filter(|v| !v.is_null()).cloned();
        out.push((f.into(), kept.unwrap_or_else(|| default_of(f))));
    }
    for (k, v) in extra {
        match out.iter_mut().find(|(ek, _)| ek == k) {
            Some(slot) => slot.1 = v.clone(),
            None => out.push(((*k).into(), v.clone())),
        }
    }
    out
}

/// `JSON.stringify` of ordered pairs.
pub fn stringify(pairs: &[(String, Value)]) -> String {
    let body: Vec<String> = pairs.iter().map(|(k, v)| format!("{}:{}", Value::String(k.clone()), v)).collect();
    format!("{{{}}}", body.join(","))
}

/// Merge `status` and `extra` into the verdict of `id` and write it the way Node does (a `.tmp` file, then a rename).
pub fn persist(home: &Path, id: &str, status: &str, extra: &[(&str, Value)]) -> Option<String> {
    let p = path(home, id)?;
    let prev: Option<Value> = std::fs::read_to_string(&p).ok().and_then(|t| serde_json::from_str(&t).ok());
    let text = stringify(&merged(prev.as_ref(), status, extra));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the write below reports the failure
    }
    if crate::atomic::write(&p, &text).is_err() {
        return None;
    }
    Some(text)
}

/// One line of the recovery log: `{"ts":<now>,<fields>}`.
pub fn log_line(now: i64, fields: &[(&str, Value)]) -> String {
    let mut pairs: Vec<(String, Value)> = vec![("ts".into(), Value::from(now))];
    pairs.extend(fields.iter().map(|(k, v)| ((*k).to_string(), v.clone())));
    stringify(&pairs)
}

/// Append one line to the recovery log (best effort).
pub fn append_log(home: &Path, now: i64, fields: &[(&str, Value)]) {
    use std::io::Write;
    let p = super::root(home).join(defaults::text("devswarm_sup.recovery_log"));
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: the open below reports the failure
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        crate::discard::harmless(writeln!(f, "{}", log_line(now, fields))); // keep: a lost log line never changes the action
    }
}

/// An engine poke (attempt `attempt`, at `now`) as Node's `pokeOrEscalate` records it.
pub fn mirror_poke(home: &Path, id: &str, attempt: u64, now: i64) {
    append_log(home, now, &[("id", id.into()), ("action", "nudged".into()), ("attempt", attempt.into())]);
    let extra = [("nudgeAttempts", Value::from(attempt)), ("nudgedAt", Value::from(now)), ("lastNudgeError", Value::Null)];
    persist(home, id, defaults::text("devswarm_sup.status_nudged"), &extra);
}

/// An engine escalation as Node's `pokeOrEscalate` records it (the verdict is terminal `escalated`).
pub fn mirror_escalate(home: &Path, id: &str, now: i64) {
    let prev: Option<Value> = path(home, id).and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok());
    let last = prev.as_ref().and_then(|p| p.get("lastNudgeError")).filter(|v| !v.is_null()).cloned();
    let mut fields: Vec<(&str, Value)> =
        vec![("id", id.into()), ("action", "escalate".into()), ("reason", defaults::text("devswarm_sup.reason_exhausted").into())];
    if let Some(l) = last {
        fields.push(("lastNudgeError", l));
    }
    append_log(home, now, &fields);
    persist(home, id, defaults::text("devswarm_sup.status_escalated"), &[]);
}

// ---- the escalation notice to the parent (recovery.js notifyParentEscalation / deliverEscalation / drainEscalationIntents) ------
//
// One message into the PARENT's (Primary's) partition of the project's store, under the parent's id lock and only while the parent
// is still registered there (`appendIntoPartition(..., { via: 'row' })`), then the store's summary is derived again. A notice that
// cannot land now (lock busy, parent not registered, any store error) is PARKED as `escalation-pending/<child>.json` and retried by
// every sweep ([`drain_notices`]); a delivered parked notice is overwritten with `delivered: true`, never deleted. The store-level
// hash (`escalate:<child>:<staleSince>`) makes a repeated delivery a no-op.
use crate::checks::guardkit::ojson::OVal;

fn ik(i: usize) -> &'static str {
    defaults::list("devswarm_sup.esc_intent_keys")[i]
}

fn rk(i: usize) -> &'static str {
    defaults::list("devswarm_sup.esc_row_keys")[i]
}

fn status_word(i: usize) -> &'static str {
    defaults::list("devswarm_sup.esc_status_words")[i]
}

fn intent_path(home: &Path, child: &str) -> PathBuf {
    super::root(home).join(defaults::text("devswarm_sup.lv_escalation_dir")).join(format!("{child}{}", defaults::text("mesh_write.json_suffix")))
}

fn write_intent(home: &Path, child: &str, it: &OVal) {
    let p = intent_path(home, child);
    if let Some(d) = p.parent() {
        crate::discard::harmless(std::fs::create_dir_all(d)); // keep: Node's write is best effort too
    }
    crate::discard::harmless(crate::atomic::write(&p, it.stringify())); // keep: same (Node: `try { writeFileSync } catch (_) {}`); the engine writes it whole or not at all
}

/// `readEscalationIntent(home, child)`: the parked, undelivered notice of `child`.
fn read_undelivered(home: &Path, child: &str) -> Option<OVal> {
    let it = std::fs::read(intent_path(home, child)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b)))?;
    let undelivered = !it.get(ik(4)).is_some_and(OVal::truthy) && it.get(ik(3)).is_some_and(OVal::truthy) && it.get(ik(1)).is_some_and(OVal::truthy);
    undelivered.then_some(it)
}

/// The notice `notifyParentEscalation` builds for `child` (worktree `wt`, stale since `stale_since`), or why there is none: the
/// parent cannot be named the way Node names it, or the parent is the child itself (never notify self).
pub fn notice_intent(wt: &str, child: &str, stale_since: Option<f64>, now: i64) -> Result<OVal, String> {
    if wt.is_empty() {
        return Err(defaults::text("devswarm_sup.esc_why_no_worktree").to_string());
    }
    let parent = match super::liveness::parent_id(wt) {
        Ok(Some(p)) => p,
        Ok(None) => return Err(defaults::text("devswarm_sup.esc_why_unsafe_parent").to_string()),
        Err(crate::meshw::ident::Defer(why)) => return Err(why),
    };
    if parent == child {
        return Err(defaults::text("devswarm_sup.esc_why_self").to_string());
    }
    // `safeRepoKey`: null on any resolution failure
    let repo_key = crate::meshw::ident::repo_key_for_worktree(wt).ok().flatten();
    let idle = stale_since.map_or(String::new(), |s| {
        let min = ((now as f64 - s) / defaults::num("devswarm_sup.esc_minute_ms") as f64 + 0.5).floor().max(0.0);
        defaults::render("devswarm_sup.esc_idle", &[("min", &crate::checks::jsport::num::to_js_string(min))])
    });
    let since = stale_since.map_or_else(|| defaults::text("devswarm_sup.esc_since_none").to_string(), crate::checks::jsport::num::to_js_string);
    let row = OVal::Obj(vec![
        (rk(0).into(), OVal::Str(parent.clone())),
        (rk(1).into(), OVal::Num(now as f64)),
        (rk(2).into(), OVal::Str(defaults::text("devswarm_sup.esc_sender").into())),
        (rk(3).into(), OVal::Str(defaults::render("devswarm_sup.esc_hash", &[("id", &child), ("since", &since)]))),
        (rk(4).into(), OVal::Str(defaults::render("devswarm_sup.esc_body", &[("id", &child), ("idle", &idle)]))),
    ]);
    Ok(OVal::Obj(vec![
        (ik(0).into(), OVal::Str(child.into())),
        (ik(1).into(), OVal::Str(parent)),
        (ik(2).into(), repo_key.map_or(OVal::Null, OVal::Str)),
        (ik(3).into(), row),
    ]))
}

fn str_of(v: Option<&OVal>) -> Option<&str> {
    match v {
        Some(OVal::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

/// What one delivery did: Node's `appendIntoPartition` status (`ok | busy | gone | error`) and whether a row was inserted (a
/// duplicate hash is `ok` without one).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delivery {
    /// The status word.
    pub status: &'static str,
    /// A new row went in.
    pub inserted: bool,
    /// The notice was parked for the first time (no parked file existed for the child before).
    pub newly_parked: bool,
}

fn failed(i: usize) -> (&'static str, bool) {
    (status_word(i), false)
}

/// The append itself.
fn append_notice(home: &Path, env: &crate::meshw::ident::Env, it: &OVal, now: i64) -> (&'static str, bool) {
    let (Some(parent), Some(row)) = (str_of(it.get(ik(1))), it.get(ik(3))) else { return failed(3) };
    if !crate::meshw::idlock::is_safe_id(parent) || str_of(row.get(rk(0))) != Some(parent) {
        return failed(3);
    }
    // the parent's own per-project store; a notice without a project key is kept parked (no legacy bucket is written)
    let Some(repo_key) = str_of(it.get(ik(2))) else { return failed(3) };
    let inv = crate::meshw::common::Inv {
        home: home.to_path_buf(),
        env: env.clone(),
        cwd: home.to_string_lossy().into_owned(),
        now,
        stdin: None,
        write_home: home.to_path_buf(),
        store_override: None,
    };
    let Ok(st) = crate::meshw::common::open_store(&inv, repo_key) else { return failed(3) };
    let Some(held) = crate::meshw::idlock::acquire(home, parent) else { return failed(1) };
    let done = (|| -> Result<Option<bool>, String> {
        if !st.is_registered(parent).map_err(|e| e.to_string())? {
            return Ok(None);
        }
        let m = crate::meshw::store::MeshRow {
            workspace_id: parent.to_string(),
            ts: row.get(rk(1)).and_then(|v| if let OVal::Num(n) = v { Some(*n as i64) } else { None }).unwrap_or(now),
            hash: str_of(row.get(rk(3))).map(str::to_string),
            body: str_of(row.get(rk(4))).unwrap_or_default().to_string(),
            sender: str_of(row.get(rk(2))).map(str::to_string),
            ..crate::meshw::store::MeshRow::default()
        };
        Ok(Some(st.append_mesh_row(&m).map_err(|e| e.to_string())?.inserted))
    })();
    held.release();
    match done {
        Ok(Some(inserted)) => {
            if let Some(why) = crate::meshw::summary::derive_after_write(&st, &inv, repo_key) {
                crate::meshw::log_summary_failure(defaults::text("devswarm_sup.esc_action"), &why);
            }
            (status_word(0), inserted)
        }
        Ok(None) => failed(2),
        Err(_) => failed(3),
    }
}

/// `deliverEscalation(intent)`: append, then record the outcome on the parked file.
pub fn deliver(home: &Path, env: &crate::meshw::ident::Env, it: &OVal, now: i64) -> Delivery {
    let (status, inserted) = append_notice(home, env, it, now);
    let mut d = Delivery { status, inserted, newly_parked: false };
    let Some(child) = str_of(it.get(ik(0))).filter(|c| crate::meshw::idlock::is_safe_id(c)) else { return d };
    let mut out = it.clone();
    if status == status_word(0) {
        if read_undelivered(home, child).is_some() {
            out.set(ik(4), OVal::Bool(true));
            out.set(ik(5), OVal::Num(now as f64));
            write_intent(home, child, &out);
        }
    } else {
        d.newly_parked = !intent_path(home, child).exists();
        out.set(ik(6), OVal::Str(status.into()));
        out.set(ik(7), OVal::Num(now as f64));
        write_intent(home, child, &out);
    }
    d
}

/// Whether a delivery is worth a line of the action ledger: a row went in, or the notice was parked for the first time (a
/// duplicate, or a retry of a notice already parked, repeats every tick and is not a new action).
pub fn is_new_action(d: &Delivery) -> bool {
    d.inserted || d.newly_parked
}

/// `notifyParentEscalation(descriptor, verdict)` for workspace `child`: the notice built and delivered (or parked). `Err` when no
/// notice is due (see [`notice_intent`]).
pub fn notify_parent(home: &Path, env: &crate::meshw::ident::Env, wt: &str, child: &str, stale_since: Option<f64>, now: i64) -> Result<Delivery, String> {
    let it = notice_intent(wt, child, stale_since, now)?;
    Ok(deliver(home, env, &it, now))
}

/// What one drain of the parked notices did (`drainEscalationIntents`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Drained {
    /// Undelivered notices tried.
    pub attempted: u64,
    /// Of those, delivered now.
    pub delivered: u64,
    /// Of those, still parked.
    pub pending: u64,
}

/// Retry every parked, undelivered notice (directory order, as Node lists it).
pub fn drain_notices(home: &Path, env: &crate::meshw::ident::Env, now: i64) -> Drained {
    let mut out = Drained::default();
    let dir = super::root(home).join(defaults::text("devswarm_sup.lv_escalation_dir"));
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    let mut names: Vec<String> =
        rd.flatten().filter_map(|e| e.file_name().into_string().ok()).filter(|n| n.ends_with(defaults::text("mesh_write.json_suffix"))).collect();
    names.sort();
    for n in names {
        let Some(it) = std::fs::read(dir.join(&n)).ok().and_then(|b| OVal::parse(&String::from_utf8_lossy(&b))) else { continue };
        if !(it.get(ik(1)).is_some_and(OVal::truthy) && it.get(ik(3)).is_some_and(OVal::truthy)) || it.get(ik(4)).is_some_and(OVal::truthy) {
            continue;
        }
        out.attempted += 1;
        let t0 = std::time::Instant::now();
        let d = deliver(home, env, &it, now);
        if d.status == status_word(0) {
            out.delivered += 1;
            let child = str_of(it.get(ik(0))).unwrap_or_default();
            super::tick::record_action(
                home,
                &super::tick::Action {
                    action: defaults::text("devswarm_sup.esc_action_drain"),
                    target: child,
                    inputs: serde_json::json!({"lastStatus": str_of(it.get(ik(6)))}),
                    outcome: d.status,
                    reason: "",
                    latency_ms: t0.elapsed().as_millis() as u64,
                    now,
                },
            );
        } else {
            out.pending += 1;
        }
    }
    out
}
