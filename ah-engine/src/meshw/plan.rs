//! The step plan a heartbeat updates (`heartbeat --step N [--status S]`, and a `--summary` for a workspace that has a plan),
//! ported from `companion/lib/devswarm-plan.js` (`findPlan`, `updatePlan`, `applyStep`, `recordSummary`, `noteActivity`,
//! `finishLabel`, `dur`), `scripts/devswarm-lib/heartbeat-plan.js` `applyHeartbeatPlan` and
//! `companion/lib/devswarm-supervision-metrics.js` `record`.
//!
//! The plan file is a read-modify-write under the plan's own lock (`<key>.json.lock`, the `lock.js` protocol), so a
//! concurrent sweep or verb write is never overwritten: the mutation runs on the fresh on-disk plan. The plan is parsed and
//! written back as an ordered JSON value ([`OVal`]), so every key the plan carries (the supervisor's own fields included)
//! survives in place and the bytes equal what Node writes.
//!
//! The mutation itself ([`compute`]) is a pure function of the plan, the clock and the settings; a heartbeat first runs it
//! on the plan it read, before writing anything, so a plan shape the engine cannot treat exactly like JavaScript defers
//! (nothing written, Node runs the verb). Under the lock the same function runs on the fresh plan; if the plan changed to
//! such a shape in between, the failure is reported after the heartbeat was written (exit 70), never repeated by Node.
// Discard triage (E3): every `.ok()` / `harmless` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync)
// - the supervision log is best effort (Node's `record` never throws)
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::jsport::num::to_js_string;
use crate::checks::guardkit::text::js_number_of_str;
use crate::defaults;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{self, R, defer};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use std::io::Write;
use std::path::{Path, PathBuf};

/// A plan found for a workspace: its key (the file name) and its parsed content.
#[derive(Debug, Clone)]
pub struct Found {
    /// The plan key.
    pub key: String,
    /// The plan.
    pub plan: OVal,
}

/// What one plan update decided: the heartbeat result's `plan` field and the supervision events to record after it.
#[derive(Debug, Clone)]
pub struct Computed {
    /// The `plan` field of the heartbeat result.
    pub out: OVal,
    /// `(type, fields)` of each supervision event (`fields` without the clock).
    pub events: Vec<(String, Vec<(String, OVal)>)>,
    /// The plan to write; `None` writes nothing.
    pub next: Option<OVal>,
}

/// What the caller asked for.
#[derive(Debug, Clone)]
pub struct Call<'a> {
    /// `--step`, raw.
    pub step_raw: Option<&'a str>,
    /// `--status` (default applied).
    pub status: &'a str,
    /// `--summary`.
    pub summary: Option<&'a str>,
    /// The clock.
    pub now: f64,
}

fn plans_dir(inv: &Inv) -> PathBuf {
    devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_plans"))
}

fn plan_file(inv: &Inv, key: &str) -> PathBuf {
    plans_dir(inv).join(format!("{key}{}", defaults::text("mesh_write.json_suffix")))
}

/// `planRefFor(home, id, ctx)`: the worktree path the descriptor names (or, for the caller's own id, the checkout it runs in).
/// A truthy value that is no string is not reproduced.
pub fn plan_ref(inv: &Inv, id: &str) -> R<Option<String>> {
    let mut wt: Option<String> = None;
    if let Some(d) = ident::read_descriptor(&inv.home, id) {
        match d.get(defaults::text("mesh_write.field_worktree_path")) {
            Some(OVal::Str(p)) if !p.is_empty() => wt = Some(p.clone()),
            Some(v) if v.truthy() => return defer("plan-ref-shape"),
            _ => {}
        }
    }
    if wt.is_none() && inv.env.get(defaults::text("mesh_write.env_builder_id")).map(String::as_str) == Some(id) {
        wt = ident::resolve_context(&inv.cwd, true)?.worktree_root;
    }
    Ok(wt)
}

/// `planKeyForWorktree(wt)`: the worktree's mesh id, when it is a safe plan key.
pub fn key_for_worktree(wt: &str) -> R<Option<String>> {
    if wt.is_empty() {
        return Ok(None);
    }
    let c = ident::resolve_context(wt, false)?;
    Ok(c.worktree_root.map(|root| ident::mesh_id_for_real_path(&root)).filter(|k| is_safe_id(k)))
}

/// `planRefFor(home, id, ctx)` then the keys `findPlan` tries, in order: the worktree's mesh id, then the id.
pub fn keys(inv: &Inv, id: &str) -> R<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    if let Some(w) = plan_ref(inv, id)? {
        out.extend(key_for_worktree(&w)?);
    }
    if is_safe_id(id) && !out.iter().any(|k| k == id) {
        out.push(id.to_string());
    }
    Ok(out)
}

/// `readJson(planPath)` plus the `Array.isArray(plan.steps)` test of `findPlan`/`updatePlan`: `Ok(None)` when Node sees
/// no plan; a plan shape the engine does not treat like JavaScript defers.
fn read_plan(path: &Path) -> R<Option<OVal>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    let Ok(text) = String::from_utf8(bytes) else { return defer("plan-encoding") };
    let Some(v) = OVal::parse(&text) else { return Ok(None) };
    if !matches!(v, OVal::Obj(_)) || !matches!(v.get("steps"), Some(OVal::Arr(_))) {
        return Ok(None);
    }
    validate(&v)?;
    Ok(Some(v))
}

/// A plan whose steps are not all objects makes Node throw part-way (`s.status` of `null`): not reproduced.
fn validate(plan: &OVal) -> R<()> {
    let Some(OVal::Arr(steps)) = plan.get("steps") else { return defer("plan-shape") };
    if steps.iter().all(|x| matches!(x, OVal::Obj(_))) { Ok(()) } else { defer("plan-shape") }
}

/// `findPlan(home, planRefFor(home, id, ctx))`.
pub fn find(inv: &Inv, id: &str) -> R<Option<Found>> {
    for key in keys(inv, id)? {
        if let Some(plan) = read_plan(&plan_file(inv, &key))? {
            return Ok(Some(Found { key, plan }));
        }
    }
    Ok(None)
}

/// `findPlan(home, { id, worktreePath })` with the worktree given (not read from the descriptor).
pub fn find_for(inv: &Inv, id: &str, wt: Option<&str>) -> R<Option<Found>> {
    let mut keys: Vec<String> = Vec::new();
    if let Some(w) = wt {
        keys.extend(key_for_worktree(w)?);
    }
    if is_safe_id(id) && !keys.iter().any(|k| k == id) {
        keys.push(id.to_string());
    }
    for key in keys {
        if let Some(plan) = read_plan(&plan_file(inv, &key))? {
            return Ok(Some(Found { key, plan }));
        }
    }
    Ok(None)
}

// ---- JavaScript value helpers ----

/// `Number.isFinite(v)`: only a number.
fn finite(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `Number(v)`; arrays and objects are not reproduced.
fn num_of(v: Option<&OVal>) -> R<f64> {
    Ok(match v {
        None => f64::NAN,
        Some(OVal::Null) => 0.0,
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Num(x)) => *x,
        Some(OVal::Str(t)) => js_number_of_str(t),
        Some(_) => return defer("plan-shape"),
    })
}

pub(crate) fn remove(plan: &mut OVal, key: &str) {
    if let OVal::Obj(v) = plan {
        v.retain(|(k, _)| k != key);
    }
}

pub(crate) fn steps_of(plan: &OVal) -> &[OVal] {
    match plan.get("steps") {
        Some(OVal::Arr(v)) => v,
        _ => &[],
    }
}

pub(crate) fn status_is(step: &OVal, word: &str) -> bool {
    matches!(step.get("status"), Some(OVal::Str(x)) if x == word)
}

/// `stepsDone(plan)`.
pub(crate) fn steps_done(plan: &OVal) -> usize {
    steps_of(plan).iter().filter(|x| status_is(x, defaults::text("mesh_write.plan_status_done"))).count()
}

/// `noteDoneDrop(plan, doneBefore)`.
pub(crate) fn note_done_drop(plan: &mut OVal, before: usize) -> R<()> {
    let now = steps_done(plan);
    if now < before {
        let prev = num_of(plan.get("regressed_from"))?;
        let prev = if prev.is_nan() || prev == 0.0 { 0.0 } else { prev };
        plan.set("regressed_from", n((before as f64).max(prev)));
    } else if num_of(plan.get("regressed_from"))? <= now as f64 {
        remove(plan, "regressed_from");
    }
    Ok(())
}

/// `applyStep(plan, n, status, now)`: `Err(text)` is Node's `{ error }`, `Ok(changed)` its `{ changed }`.
fn apply_step(plan: &mut OVal, raw: &str, status: &str, now: f64) -> R<Result<bool, String>> {
    let num = js_number_of_str(raw);
    let len = steps_of(plan).len();
    if !(num.is_finite() && num.fract() == 0.0) || num < 1.0 || num > len as f64 {
        return Ok(Err(defaults::render("mesh_write.plan_bad_step_text", &[("n", &len)])));
    }
    if !defaults::list("mesh_write.plan_statuses").contains(&status) {
        let list = defaults::list("mesh_write.plan_statuses").join(defaults::text("mesh_write.plan_status_sep"));
        return Ok(Err(defaults::render("mesh_write.plan_bad_status_text", &[("list", &list)])));
    }
    let idx = num as usize - 1;
    if status_is(&steps_of(plan)[idx], status) {
        return Ok(Ok(false));
    }
    let before = steps_done(plan);
    step_mut(plan, idx)?.set("status", s(status));
    note_done_drop(plan, before)?;
    let step = step_mut(plan, idx)?;
    step.set("ts", n(now));
    if finite(step.get("started_at")).is_none() {
        step.set("started_at", n(now));
    }
    plan.set("step_ts", n(now));
    plan.set("current", n(num));
    remove(plan, "done_reported_at");
    Ok(Ok(true))
}

fn step_mut(plan: &mut OVal, idx: usize) -> R<&mut OVal> {
    match plan {
        OVal::Obj(v) => match v.iter_mut().find(|(k, _)| k == "steps") {
            Some((_, OVal::Arr(a))) => a.get_mut(idx).map_or_else(|| defer("plan-shape"), Ok),
            _ => defer("plan-shape"),
        },
        _ => defer("plan-shape"),
    }
}

/// `noteActivity(plan, text, now)`.
fn note_activity(plan: &mut OVal, text: &str, now: f64) {
    let mut norm = String::new();
    let mut gap = false;
    for ch in text.to_lowercase().chars() {
        if matches!(ch, ' ' | '\t' | '\n' | '\u{b}' | '\u{c}' | '\r') {
            gap = true;
        } else {
            if gap && !norm.is_empty() {
                norm.push(' ');
            }
            gap = false;
            norm.push(ch);
        }
    }
    let sig: String = crate::checks::jsport::text::sha1_hex(norm.as_bytes()).chars().take(defaults::num("mesh_write.plan_sig_hex") as usize).collect();
    let mut seen: Vec<OVal> = match plan.get("activity_sigs") {
        Some(OVal::Arr(a)) => a.clone(),
        _ => Vec::new(),
    };
    if seen.iter().any(|x| matches!(x, OVal::Str(t) if *t == sig)) {
        return;
    }
    seen.push(OVal::Str(sig));
    let keep = defaults::num("mesh_write.plan_activity_keep") as usize;
    let from = seen.len().saturating_sub(keep);
    plan.set("activity_sigs", OVal::Arr(seen.split_off(from)));
    plan.set("activity_ts", n(now));
}

/// `recordSummary(plan, text, stepped, now)`. Text with a non-ASCII character is not reproduced (JavaScript counts UTF-16
/// units and lowercases by its own tables).
fn record_summary(plan: &mut OVal, text: &str, stepped: bool, now: f64) -> R<()> {
    if !text.is_ascii() {
        return defer("summary-nonascii-plan");
    }
    let mut list: Vec<OVal> = match plan.get("summaries") {
        Some(OVal::Arr(a)) => a.clone(),
        _ => Vec::new(),
    };
    let clip: String = text.chars().take(defaults::num("mesh_write.plan_summary_text_max") as usize).collect();
    list.push(Obj(vec![("ts".into(), n(now)), ("text".into(), s(&clip)), ("stepped".into(), OVal::Bool(stepped))]).done());
    let keep = defaults::num("mesh_write.plan_summary_keep") as usize;
    if list.len() > keep {
        list = list.split_off(list.len() - keep);
    }
    plan.set("summaries", OVal::Arr(list));
    note_activity(plan, text, now);
    Ok(())
}

/// `dur(ms)`.
pub(crate) fn dur(ms: f64) -> String {
    let ms = if ms.is_nan() { 0.0 } else { ms };
    let m = (ms / defaults::num("mesh_write.dur_ms_per_min") as f64).floor().max(0.0);
    let per_hour = defaults::num("mesh_write.dur_min_per_hour") as f64;
    let v = |x: f64| to_js_string(x);
    if m < per_hour {
        return defaults::render("mesh_write.dur_fmt_min", &[("v", &v(m))]);
    }
    let h = (m / per_hour).floor();
    if h < defaults::num("mesh_write.dur_hours_before_days") as f64 {
        return defaults::render("mesh_write.dur_fmt_hour", &[("v", &v(h))]);
    }
    defaults::render("mesh_write.dur_fmt_day", &[("v", &v((h / defaults::num("mesh_write.dur_hours_per_day") as f64).floor()))])
}

/// A step's `n` as JavaScript prints it in a label.
fn step_number(step: &OVal) -> R<String> {
    match step.get("n") {
        Some(OVal::Num(x)) => Ok(to_js_string(*x)),
        Some(OVal::Str(t)) => Ok(t.clone()),
        _ => defer("plan-shape"),
    }
}

/// `finishLabel(plan, now)`.
pub(crate) fn finish_label(plan: &OVal, now: f64) -> R<OVal> {
    let steps = steps_of(plan);
    if steps.is_empty() {
        return Ok(OVal::Null);
    }
    let total = steps.len();
    let sep = defaults::text("mesh_write.lbl_sep");
    let last = match (finite(plan.get("step_ts")), finite(plan.get("activity_ts"))) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(f64::NEG_INFINITY).max(b.unwrap_or(f64::NEG_INFINITY))),
    };
    let progress = match last {
        Some(t) => defaults::render("mesh_write.lbl_progress_ago", &[("dur", &dur(now - t))]),
        None => defaults::text("mesh_write.lbl_no_progress").to_string(),
    };
    let done = steps_done(plan);
    if done >= total {
        let tail = if finite(plan.get("done_reported_at")).is_some() { defaults::text("mesh_write.lbl_done_reported_tail").to_string() } else { progress };
        return Ok(s(&defaults::render("mesh_write.lbl_all_done", &[("total", &total), ("tail", &tail)])));
    }
    let doing: Vec<&OVal> = steps.iter().filter(|x| status_is(x, defaults::text("mesh_write.plan_status_doing"))).collect();
    let blocked: Vec<&OVal> = steps.iter().filter(|x| status_is(x, defaults::text("mesh_write.plan_status_blocked"))).collect();
    let changed = if num_of(plan.get("regressed_from"))? > done as f64 { defaults::text("mesh_write.lbl_plan_changed") } else { "" };
    let mut parts = vec![format!("{}{changed}", defaults::render("mesh_write.lbl_done_of", &[("done", &done), ("total", &total)]))];
    match doing.len() {
        0 => {}
        1 => parts.push(defaults::render("mesh_write.lbl_doing_one", &[("n", &step_number(doing[0])?)])),
        k => parts.push(defaults::render("mesh_write.lbl_doing_many", &[("k", &k)])),
    }
    match blocked.len() {
        0 => {}
        1 => parts.push(defaults::render("mesh_write.lbl_blocked_one", &[("n", &step_number(blocked[0])?)])),
        k => parts.push(defaults::render("mesh_write.lbl_blocked_many", &[("k", &k)])),
    }
    if finite(plan.get("step_ts")).is_none()
        && let Some(OVal::Num(i)) = plan.get("inferred_step")
        && i.is_finite()
        && i.fract() == 0.0
        && *i >= 1.0
        && *i <= total as f64
    {
        parts.push(defaults::render("mesh_write.lbl_inferred", &[("n", &to_js_string(*i))]));
    }
    if let Some(r) = finite(plan.get("done_reported_at")) {
        parts.push(defaults::render("mesh_write.lbl_done_reported_part", &[("dur", &dur(now - r))]));
        return Ok(s(&parts.join(sep)));
    }
    let starts: Vec<f64> = doing.iter().chain(blocked.iter()).filter_map(|x| finite(x.get("started_at"))).collect();
    let since = if starts.is_empty() { num_of(plan.get("created_at"))? } else { starts.into_iter().fold(f64::INFINITY, f64::min) };
    parts.push(dur(now - since));
    parts.push(progress);
    Ok(s(&parts.join(sep)))
}

/// `stepStallMs`: the default window, or a deferral when any setting could change it (the setting tiers are not
/// reproduced for this key).
fn step_stall_ms(inv: &Inv) -> R<f64> {
    let env_name = defaults::text("mesh_write.step_stall_env");
    if inv.env.contains_key(env_name) {
        return defer("step-stall-setting");
    }
    let home = inv.home.to_string_lossy().to_string();
    if crate::checks::guardkit::settings::unreadable_settings_file(&home) {
        return defer("step-stall-settings-unreadable");
    }
    let st = inv.settings();
    let section = defaults::text("mesh_write.settings_devswarm_section");
    let set = crate::checks::guardkit::settings::read_object(&st, defaults::text("guardkit.settings_file")).is_some_and(|o| {
        o.get(section).and_then(serde_json::Value::as_object).is_some_and(|sct| sct.contains_key(defaults::text("mesh_write.step_stall_key")))
    });
    let option = defaults::text("mesh_write.step_stall_option");
    let opt_env = format!("{}{}", defaults::text("guardkit.plugin_option_prefix"), option.to_ascii_uppercase());
    let stored = crate::checks::guardkit::settings::stored_options(&st).is_some_and(|o| o.contains_key(option));
    if set || stored || inv.env.contains_key(&opt_env) {
        return defer("step-stall-setting");
    }
    Ok(defaults::num("mesh_write.step_stall_default_min") as f64 * defaults::num("mesh_write.dur_ms_per_min") as f64)
}

fn field_or_empty_array(plan: &OVal, key: &str) -> OVal {
    match plan.get(key) {
        Some(a @ OVal::Arr(_)) => a.clone(),
        _ => OVal::Arr(Vec::new()),
    }
}

/// The body of `applyHeartbeatPlan`'s `updatePlan` callback, on the plan as it is on disk (`None`: no file).
pub fn compute(inv: &Inv, key: &str, id: &str, call: &Call<'_>, cur: Option<OVal>) -> R<Computed> {
    let reason = |r: &str| Obj(vec![("ok".into(), OVal::Bool(false)), ("reason".into(), s(r)), ("key".into(), s(key))]).done();
    let Some(mut plan) = cur else {
        return Ok(Computed { out: reason(defaults::text("mesh_write.hb_plan_no_plan")), events: Vec::new(), next: None });
    };
    validate(&plan)?;
    let now = call.now;
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true)).put("key", s(key));
    let mut dirty = false;
    let mut events: Vec<(String, Vec<(String, OVal)>)> = Vec::new();
    if let Some(raw) = call.step_raw {
        match apply_step(&mut plan, raw, call.status, now)? {
            Err(msg) => {
                let o = Obj(vec![
                    ("ok".into(), OVal::Bool(false)),
                    ("reason".into(), s(defaults::text("mesh_write.plan_reason_bad_step"))),
                    ("error".into(), s(&msg)),
                    ("key".into(), s(key)),
                ])
                .done();
                return Ok(Computed { out: o, events: Vec::new(), next: None });
            }
            Ok(changed) => {
                let step_no = js_number_of_str(raw);
                out.put("step", n(step_no)).put("status", s(call.status)).put("changed", OVal::Bool(changed));
                if changed {
                    dirty = true;
                    let base = |extra: Vec<(&str, OVal)>| -> Vec<(String, OVal)> {
                        let mut v = vec![("id".to_string(), s(id)), ("key".to_string(), s(key))];
                        v.extend(extra.into_iter().map(|(k, x)| (k.to_string(), x)));
                        v
                    };
                    events.push((defaults::text("mesh_write.ev_step").to_string(), base(vec![("step", n(step_no)), ("status", s(call.status))])));
                    // the correction-worked measure
                    if let Some(wa) = finite(plan.get("warned_at"))
                        && now >= wa
                        && !matches!(plan.get("correction_followed_for"), Some(OVal::Num(x)) if *x == wa)
                        && now - wa <= step_stall_ms(inv)?
                    {
                        plan.set("correction_followed_for", n(wa));
                        events.push((
                            defaults::text("mesh_write.ev_correction_followed").to_string(),
                            base(vec![
                                ("step", n(step_no)),
                                ("latencyMs", n(now - wa)),
                                ("signals", field_or_empty_array(&plan, "warned_signals")),
                                ("jev", field_or_empty_array(&plan, "warned_jev")),
                            ]),
                        ));
                    }
                    // the respawn measure: the first step progress of a respawned workspace, counted once
                    match plan.get("respawn") {
                        Some(OVal::Arr(_)) => return defer("plan-shape"),
                        Some(OVal::Obj(_)) if finite(plan.get("respawn").and_then(|r| r.get("first_step_at"))).is_none() => {
                            let (from, at) = {
                                let r = plan.get("respawn");
                                (r.and_then(|r| r.get("from")).filter(|f| f.truthy()).cloned().unwrap_or(OVal::Null), finite(r.and_then(|r| r.get("at"))))
                            };
                            if let OVal::Obj(v) = &mut plan
                                && let Some((_, r)) = v.iter_mut().find(|(k, _)| k == "respawn")
                            {
                                r.set("first_step_at", n(now));
                            }
                            events.push((
                                defaults::text("mesh_write.ev_respawn_progress").to_string(),
                                base(vec![("from", from), ("latencyMs", at.map_or(OVal::Null, |a| n(now - a)))]),
                            ));
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    if let Some(text) = call.summary {
        record_summary(&mut plan, text, call.step_raw.is_some(), now)?;
        dirty = true;
    }
    out.put("label", finish_label(&plan, now)?);
    Ok(Computed { out: out.done(), events, next: dirty.then_some(plan) })
}

/// `updatePlan(home, key, mutate)`: the plan's lock, the fresh plan, the mutation and an atomic write. `Ok(None)` is Node's
/// `{ ok: false, lockBusy: true }`; otherwise what the mutation decided and the text written (`None`: nothing).
pub fn update(inv: &Inv, key: &str, id: &str, call: &Call<'_>) -> R<Option<(Computed, Option<String>)>> {
    update_with(inv, key, |cur| {
        let c = compute(inv, key, id, call, cur)?;
        let next = c.next.clone();
        Ok((c, next))
    })
}

/// `updatePlan(home, key, mutate)` for any mutation: `mutate` gets the fresh plan (`None` when the file holds none) and returns
/// its own result plus the plan to write (`None` writes nothing). The write is the first thing the engine does on the plan, so a
/// deferral inside `mutate` has written nothing; the caller marks the commit point after this returns.
pub fn update_with<T>(inv: &Inv, key: &str, mutate: impl FnOnce(Option<OVal>) -> R<(T, Option<OVal>)>) -> R<Option<(T, Option<String>)>> {
    let path = plan_file(inv, key);
    let mut lock = path.as_os_str().to_os_string();
    lock.push(defaults::text("mesh_write.lock_suffix"));
    let params = nodelock::Params {
        stale_ms: defaults::num("mesh_write.plan_lock_stale_ms"),
        wait_ms: defaults::num("mesh_write.plan_lock_wait_ms"),
        step_ms: defaults::num("mesh_write.plan_lock_step_ms"),
        reclaim_stale_ms: defaults::num("mesh_write.id_lock_reclaim_stale_ms"),
        release_tries: defaults::num("mesh_write.id_lock_release_tries"),
        release_step_ms: defaults::num("mesh_write.id_lock_release_step_ms"),
        boot_slop_s: defaults::num("mesh_write.id_lock_boot_slop_s"),
        steal_dead: true,
    };
    let Some(held) = nodelock::acquire(&lock.to_string_lossy(), params) else { return Ok(None) };
    let result = (|| -> R<(T, Option<String>)> {
        let cur = read_plan(&path)?;
        let (out, next) = mutate(cur)?;
        let Some(next) = &next else { return Ok((out, None)) };
        let text = next.stringify();
        write_atomic(&path, &text).map_err(|e| ident::Defer(format!("plan-write:{e}")))?;
        Ok((out, Some(text)))
    })();
    held.release();
    result.map(Some)
}

/// `writeJsonAtomic(p, obj)`: a staged temp next to the plan, renamed into place.
fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(format!(".{}.{}{}", std::process::id(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst), defaults::text("mesh_write.tmp_suffix")));
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        crate::discard::harmless(std::fs::remove_file(&tmp)); // keep: never leak a staged temp (Node unlinks it)
    })
}

// ---- the supervision log ----

fn log_path(inv: &Inv) -> PathBuf {
    inv.home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs")).join(defaults::text("mesh_write.supervision_log"))
}

/// The log is past the size at which Node rotates it before appending (the engine leaves the rotation to Node).
pub fn log_needs_rotation(inv: &Inv) -> bool {
    std::fs::metadata(log_path(inv)).is_ok_and(|m| m.len() > defaults::num("mesh_write.supervision_max_bytes"))
}

/// `record(home, type, fields)`: one event line, best effort. Returns the line written.
pub fn record(inv: &Inv, typ: &str, fields: &[(String, OVal)], now: f64) -> Option<String> {
    let p = log_path(inv);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).ok()?;
    }
    let mut row = vec![("ts".to_string(), s(&crate::checks::agent_scan::iso_utc(now))), ("type".to_string(), s(typ))];
    row.extend(fields.iter().cloned());
    let line = format!("{}\n", OVal::Obj(row).stringify());
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p).ok()?;
    f.write_all(line.as_bytes()).ok()?;
    Some(line)
}

/// A plan file's path under the home (`.anti-hall/devswarm/plans/<key>.json`).
pub fn plan_rel(key: &str) -> String {
    format!(
        "{}/{}/{}/{key}{}",
        defaults::text("mesh_write.dir_anti_hall"),
        defaults::text("mesh_write.dir_devswarm"),
        defaults::text("mesh_write.dir_plans"),
        defaults::text("mesh_write.json_suffix")
    )
}

/// Record the supervision log as this verb left it (its whole content: the witness starts from a copy of the log).
pub fn note_log(inv: &Inv) {
    crate::meshw::set_written(&log_rel(), &std::fs::read(log_path(inv)).unwrap_or_default());
}

/// The supervision log's path under the home.
pub fn log_rel() -> String {
    format!("{}/{}/{}", defaults::text("mesh_write.dir_anti_hall"), defaults::text("mesh_write.dir_logs"), defaults::text("mesh_write.supervision_log"))
}
