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
//! on the plan it read, before writing anything. A plan shape no verb writes (a `null` step) makes Node's code throw a
//! TypeError part-way; the engine answers it with the same text as a refusal ([`Throw`]) and writes nothing, never a hand-off.
//! Every other shape (a step that is a number, an array where an object belongs, a string where a number belongs) is read
//! the way JavaScript reads it. A string cut inside a surrogate pair keeps JavaScript's lone surrogate: see [`clip_utf16`].
// Discard triage (E3): every `.ok()` / `harmless` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (Node's try/catch around readFileSync)
// - the supervision log is best effort (Node's `record` never throws)
use crate::checks::guardkit::nodelock;
use crate::checks::guardkit::ojson::OVal;
use crate::checks::guardkit::text::{is_js_space, js_number_of_str};
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{self, R};
use crate::meshw::idlock::{devswarm_root, is_safe_id};
use std::io::Write;
use std::path::{Path, PathBuf};

// ---- JavaScript values the engine's strings cannot hold ----

/// What Node's code raises where a plan holds a shape no verb writes (a `null` step): the TypeError's text. The verb refuses with
/// it, the way Node's `run()` does (`{ ok: false, error }`), and nothing is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Throw(pub String);

pub(crate) fn null_read(prop: &str) -> Throw {
    Throw(defaults::render("mesh_write.js_err_null_read", &[("prop", &prop)]))
}

fn mark() -> char {
    defaults::text("mesh_write.lone_mark").chars().next().unwrap_or(char::REPLACEMENT_CHARACTER)
}

fn lone_base() -> u32 {
    defaults::num("mesh_write.lone_base") as u32
}

fn first_surrogate() -> u32 {
    defaults::num("mesh_write.surrogate_first") as u32
}

/// A lone surrogate JavaScript keeps in a string and a Rust string cannot: the mark followed by one private character that
/// names the code unit. [`parse_js`] reads a lone `\uD83D` escape into it and [`stringify`] writes it back as the escape, so the
/// bytes of a plan are what `JSON.stringify` wrote.
fn lone_pair(unit: u32) -> [char; 2] {
    [mark(), char::from_u32(lone_base() + unit - first_surrogate()).unwrap_or(char::REPLACEMENT_CHARACTER)]
}

/// `s.slice(0, n)` where `n` counts UTF-16 units: a cut inside a surrogate pair keeps the pair's high half as JavaScript does
/// (see [`lone_pair`]).
pub(crate) fn clip_utf16(text: &str, n: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for c in text.chars() {
        let w = c.len_utf16();
        if units + w > n {
            if units == n {
                return out;
            }
            // w is 2 and one unit is left: the high half of the pair
            let high = first_surrogate() + ((c as u32 - defaults::num("mesh_write.astral_base") as u32) >> defaults::num("mesh_write.surrogate_shift") as u32);
            out.extend(lone_pair(high));
            return out;
        }
        units += w;
        out.push(c);
    }
    out
}

/// `JSON.parse(text)` with a lone surrogate escape read as JavaScript reads it (see [`lone_pair`]); `None` when it throws.
pub(crate) fn parse_js(text: &str) -> Option<OVal> {
    let escape = defaults::text("mesh_write.json_unicode_escape");
    if !text.contains(escape) {
        return OVal::parse(text);
    }
    let units = |at: usize| -> Option<u32> {
        let hex = text.get(at + 2..at + 6)?;
        if text.get(at..at + 2)? != escape || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        u32::from_str_radix(hex, 16).ok()
    };
    let (first, last) = (first_surrogate(), first_surrogate() + defaults::num("mesh_write.lone_range") as u32);
    let high_end = first + defaults::num("mesh_write.lone_range") as u32 / 2;
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let rest = &text[i..];
        if rest.starts_with('\\') {
            match units(i) {
                Some(u) if (first..last).contains(&u) => {
                    let paired = u < high_end && units(i + 6).is_some_and(|l| (high_end..last).contains(&l));
                    if paired {
                        out.push_str(&text[i..i + 12]);
                        i += 12;
                    } else {
                        out.extend(lone_pair(u));
                        i += 6;
                    }
                }
                _ => {
                    // any other escape (including an escaped backslash) is copied whole, so `\\ud83d` stays text
                    let mut pair = rest.chars();
                    let take = pair.next().map_or(0, char::len_utf8) + pair.next().map_or(0, char::len_utf8);
                    out.push_str(&rest[..take]);
                    i += take;
                }
            }
        } else {
            let c = rest.chars().next().unwrap_or_default();
            out.push(c);
            i += c.len_utf8();
        }
    }
    OVal::parse(&out)
}

/// `JSON.stringify(value)` with each [`lone_pair`] written back as the `\udXXX` escape JavaScript writes.
pub(crate) fn stringify(v: &OVal) -> String {
    let text = v.stringify();
    if !text.contains(mark()) {
        return text;
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == mark()
            && let Some(next) = chars.peek().copied()
            && (lone_base()..lone_base() + defaults::num("mesh_write.lone_range") as u32).contains(&(next as u32))
        {
            chars.next();
            out.push_str(&defaults::render("mesh_write.lone_escape", &[("unit", &format!("{:04x}", first_surrogate() + next as u32 - lone_base()))]));
        } else {
            out.push(c);
        }
    }
    out
}

/// `String(v)` of a JSON value: `null` is "null", an array joins its elements with a comma (a null one as empty), an object is
/// "[object Object]".
pub(crate) fn js_string(v: &OVal) -> String {
    match v {
        OVal::Null => defaults::text("mesh_write.js_null").to_string(),
        OVal::Bool(b) => b.to_string(),
        OVal::Num(x) => to_js_string(*x),
        OVal::Str(t) => t.clone(),
        OVal::Arr(a) => a.iter().map(|e| if matches!(e, OVal::Null) { String::new() } else { js_string(e) }).collect::<Vec<_>>().join(defaults::text("mesh_write.js_array_sep")),
        OVal::Obj(_) => defaults::text("mesh_write.js_object_string").to_string(),
    }
}

/// `String(v)` where the value may be absent (`undefined`).
fn js_string_opt(v: Option<&OVal>) -> String {
    v.map_or_else(|| defaults::text("mesh_write.js_undefined").to_string(), js_string)
}

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

/// `planRefFor(home, id, ctx).worktreePath`: the descriptor's `worktreePath` when it is truthy (whatever its type), else, for the
/// caller's own id, the checkout it runs in.
pub fn plan_ref_value(inv: &Inv, id: &str) -> R<Option<OVal>> {
    let mut wt: Option<OVal> = None;
    if let Some(d) = ident::read_descriptor(&inv.home, id)
        && let Some(v) = d.get(defaults::text("mesh_write.field_worktree_path")).filter(|v| v.truthy())
    {
        wt = Some(v.clone());
    }
    if wt.is_none() && inv.env.get(defaults::text("mesh_write.env_builder_id")).map(String::as_str) == Some(id) {
        wt = ident::resolve_context(&inv.cwd, true)?.worktree_root.filter(|w| !w.is_empty()).map(OVal::Str);
    }
    Ok(wt)
}

/// [`plan_ref_value`] where it is a path: `planKeyForWorktree` reads a worktree that is no string as none.
pub fn plan_ref(inv: &Inv, id: &str) -> R<Option<String>> {
    Ok(match plan_ref_value(inv, id)? {
        Some(OVal::Str(p)) => Some(p),
        _ => None,
    })
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

/// `readJson(planPath)` plus the `Array.isArray(plan.steps)` test of `findPlan`/`updatePlan`: `Ok(None)` when Node sees no plan.
/// The file is decoded the way `readFileSync(p, 'utf8')` decodes it (an invalid byte becomes U+FFFD).
fn read_plan(path: &Path) -> R<Option<OVal>> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };
    let Some(v) = parse_js(&String::from_utf8_lossy(&bytes)) else { return Ok(None) };
    if !matches!(v, OVal::Obj(_)) || !matches!(v.get("steps"), Some(OVal::Arr(_))) {
        return Ok(None);
    }
    Ok(Some(v))
}

/// The first `null` among the steps: Node's `s.status` / `s.text` on it throws.
fn has_null_step(plan: &OVal) -> bool {
    steps_of(plan).iter().any(|x| matches!(x, OVal::Null))
}

/// `stepsDone(plan)` reads `s.status` of every step: the TypeError of a `null` one.
pub(crate) fn null_step_throw(plan: &OVal) -> Option<Throw> {
    has_null_step(plan).then(|| null_read(defaults::text("mesh_write.js_prop_status")))
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

/// `Number(v)`: an array is `Number` of its joined text, an object is NaN (its text is "[object Object]").
fn num_of(v: Option<&OVal>) -> f64 {
    match v {
        None => f64::NAN,
        Some(OVal::Null) => 0.0,
        Some(OVal::Bool(b)) => f64::from(u8::from(*b)),
        Some(OVal::Num(x)) => *x,
        Some(other) => js_number_of_str(&js_string(other)),
    }
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
pub(crate) fn note_done_drop(plan: &mut OVal, before: usize) {
    let now = steps_done(plan);
    if now < before {
        let prev = num_of(plan.get("regressed_from"));
        let prev = if prev.is_nan() || prev == 0.0 { 0.0 } else { prev };
        plan.set("regressed_from", n((before as f64).max(prev)));
    } else if num_of(plan.get("regressed_from")) <= now as f64 {
        remove(plan, "regressed_from");
    }
}

/// `applyStep(plan, n, status, now)`: `Err(text)` is Node's `{ error }`, `Ok(changed)` its `{ changed }`. A [`Throw`] is what Node's
/// code raises on the step it reads or assigns: a `null` step is read (`step.status`), a step that is a string, number or boolean
/// is assigned to (strict mode refuses), an array takes the assignment as a property no JSON keeps.
fn apply_step(plan: &mut OVal, raw: &str, status: &str, now: f64) -> Result<Result<bool, String>, Throw> {
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
    let prop = defaults::text("mesh_write.js_prop_status");
    if matches!(steps_of(plan)[idx], OVal::Null) {
        return Err(null_read(prop));
    }
    if status_is(&steps_of(plan)[idx], status) {
        return Ok(Ok(false));
    }
    if has_null_step(plan) {
        return Err(null_read(prop)); // stepsDone(plan) reads every step
    }
    let before = steps_done(plan);
    match &steps_of(plan)[idx] {
        v @ (OVal::Str(_) | OVal::Num(_) | OVal::Bool(_)) => {
            let kind = match v {
                OVal::Str(_) => "mesh_write.js_kind_string",
                OVal::Num(_) => "mesh_write.js_kind_number",
                _ => "mesh_write.js_kind_boolean",
            };
            return Err(Throw(defaults::render(
                "mesh_write.js_err_create_prop",
                &[("prop", &prop), ("kind", &defaults::text(kind)), ("value", &js_string(v))],
            )));
        }
        _ => {}
    }
    step_set(plan, idx, "status", s(status));
    note_done_drop(plan, before);
    let started = step_at(plan, idx).and_then(|st| finite(st.get("started_at")));
    step_set(plan, idx, "ts", n(now));
    if started.is_none() {
        step_set(plan, idx, "started_at", n(now));
    }
    plan.set("step_ts", n(now));
    plan.set("current", n(num));
    remove(plan, "done_reported_at");
    Ok(Ok(true))
}

fn step_at(plan: &OVal, idx: usize) -> Option<&OVal> {
    steps_of(plan).get(idx)
}

/// `plan.steps[idx][key] = val`: a property on an object step; on an array step JavaScript sets a property no JSON keeps, which
/// [`OVal::set`] does not model either.
fn step_set(plan: &mut OVal, idx: usize, key: &str, val: OVal) {
    if let OVal::Obj(v) = plan
        && let Some((_, OVal::Arr(a))) = v.iter_mut().find(|(k, _)| k == "steps")
        && let Some(step) = a.get_mut(idx)
    {
        step.set(key, val);
    }
}

/// `noteActivity(plan, text, now)`: whether the clock was refreshed (text already seen does not refresh it).
pub(crate) fn note_activity(plan: &mut OVal, text: &str, now: f64) -> bool {
    let mut norm = String::new();
    let mut gap = false;
    for ch in text.to_lowercase().chars() {
        if is_js_space(ch) {
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
        return false;
    }
    seen.push(OVal::Str(sig));
    let keep = defaults::num("mesh_write.plan_activity_keep") as usize;
    let from = seen.len().saturating_sub(keep);
    plan.set("activity_sigs", OVal::Arr(seen.split_off(from)));
    plan.set("activity_ts", n(now));
    true
}

/// `recordSummary(plan, text, stepped, now)`.
fn record_summary(plan: &mut OVal, text: &str, stepped: bool, now: f64) {
    let mut list: Vec<OVal> = match plan.get("summaries") {
        Some(OVal::Arr(a)) => a.clone(),
        _ => Vec::new(),
    };
    let clip = clip_utf16(text, defaults::num("mesh_write.plan_summary_text_max") as usize);
    list.push(Obj(vec![("ts".into(), n(now)), ("text".into(), s(&clip)), ("stepped".into(), OVal::Bool(stepped))]).done());
    let keep = defaults::num("mesh_write.plan_summary_keep") as usize;
    if list.len() > keep {
        list = list.split_off(list.len() - keep);
    }
    plan.set("summaries", OVal::Arr(list));
    note_activity(plan, text, now);
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

/// A step's `n` as JavaScript prints it in a label (`'doing #' + step.n`).
fn step_number(step: &OVal) -> String {
    js_string_opt(step.get("n"))
}

/// `finishLabel(plan, now)`.
pub(crate) fn finish_label(plan: &OVal, now: f64) -> R<OVal> {
    // Node's callers (the roster, the parent-inbox hook) catch the throw of a plan with a `null` step and show no label
    Ok(label_checked(plan, now).unwrap_or(OVal::Null))
}

/// [`finish_label`] where a `null` step is Node's TypeError ([`Throw`]).
pub(crate) fn label_checked(plan: &OVal, now: f64) -> Result<OVal, Throw> {
    let steps = steps_of(plan);
    if steps.is_empty() {
        return Ok(OVal::Null);
    }
    if has_null_step(plan) {
        return Err(null_read(defaults::text("mesh_write.js_prop_status")));
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
    let changed = if num_of(plan.get("regressed_from")) > done as f64 { defaults::text("mesh_write.lbl_plan_changed") } else { "" };
    let mut parts = vec![format!("{}{changed}", defaults::render("mesh_write.lbl_done_of", &[("done", &done), ("total", &total)]))];
    match doing.len() {
        0 => {}
        1 => parts.push(defaults::render("mesh_write.lbl_doing_one", &[("n", &step_number(doing[0]))])),
        k => parts.push(defaults::render("mesh_write.lbl_doing_many", &[("k", &k)])),
    }
    match blocked.len() {
        0 => {}
        1 => parts.push(defaults::render("mesh_write.lbl_blocked_one", &[("n", &step_number(blocked[0]))])),
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
    let since = if starts.is_empty() { num_of(plan.get("created_at")) } else { starts.into_iter().fold(f64::INFINITY, f64::min) };
    parts.push(dur(now - since));
    parts.push(progress);
    Ok(s(&parts.join(sep)))
}

/// `stepStallMs(opts)`: `devswarm.stepStallMin` through the settings layer (the environment variable, `settings.json`, the plugin
/// option, the default), in milliseconds; a value that is no number of at least one minute is the default. A settings file the
/// engine's parser cannot read while JavaScript can (a number out of range, a lone surrogate escape) is counted and logged, and the
/// window is read from the tiers below it.
fn step_stall_ms(inv: &Inv) -> f64 {
    let entry = defaults::raw("sweep.setting_step_stall");
    let home = inv.home.to_string_lossy().to_string();
    if crate::checks::guardkit::settings::unreadable_settings_file(&home) {
        crate::metrics::bump("mesh_settings_unreadable", &[("setting", defaults::text("mesh_write.step_stall_key"))]);
        crate::debug::violated("meshw", &defaults::render("mesh_write.msg_settings_unreadable", &[("setting", &defaults::text("mesh_write.step_stall_key"))]));
    }
    let default = entry.get("default").and_then(defaults::V::as_integer).unwrap_or(0) as f64;
    let floor = entry.get("floor_min").and_then(defaults::V::as_integer).unwrap_or(1) as f64;
    let minutes = crate::checks::guardkit::settings::get_number(&inv.settings(), entry).max(floor);
    let minutes = if minutes.is_finite() && minutes >= 1.0 { minutes } else { default };
    minutes * defaults::num("mesh_write.dur_ms_per_min") as f64
}

fn field_or_empty_array(plan: &OVal, key: &str) -> OVal {
    match plan.get(key) {
        Some(a @ OVal::Arr(_)) => a.clone(),
        _ => OVal::Arr(Vec::new()),
    }
}

/// The heartbeat's `plan` field for a plan Node's code throws on: the TypeError's text, nothing written.
fn refused(key: &str, thrown: &Throw) -> Computed {
    crate::debug::violated("meshw", &defaults::render("mesh_write.msg_plan_refused", &[("key", &key), ("error", &thrown.0)]));
    let out = Obj(vec![
        ("ok".into(), OVal::Bool(false)),
        ("reason".into(), s(defaults::text("mesh_write.plan_reason_corrupt"))),
        ("error".into(), s(&thrown.0)),
        ("key".into(), s(key)),
    ])
    .done();
    Computed { out, events: Vec::new(), next: None }
}

/// The body of `applyHeartbeatPlan`'s `updatePlan` callback, on the plan as it is on disk (`None`: no file).
pub fn compute(inv: &Inv, key: &str, id: &str, call: &Call<'_>, cur: Option<OVal>) -> R<Computed> {
    let reason = |r: &str| Obj(vec![("ok".into(), OVal::Bool(false)), ("reason".into(), s(r)), ("key".into(), s(key))]).done();
    let Some(mut plan) = cur else {
        return Ok(Computed { out: reason(defaults::text("mesh_write.hb_plan_no_plan")), events: Vec::new(), next: None });
    };
    let now = call.now;
    let mut out = Obj::default();
    out.put("ok", OVal::Bool(true)).put("key", s(key));
    let mut dirty = false;
    let mut events: Vec<(String, Vec<(String, OVal)>)> = Vec::new();
    if let Some(raw) = call.step_raw {
        let applied = match apply_step(&mut plan, raw, call.status, now) {
            Ok(a) => a,
            Err(thrown) => return Ok(refused(key, &thrown)),
        };
        match applied {
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
                        && now - wa <= step_stall_ms(inv)
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
                        // an array is an object to `typeof`; it has no `first_step_at`, `from` or `at`, and the property set on it is no JSON
                        Some(OVal::Arr(_)) => events.push((
                            defaults::text("mesh_write.ev_respawn_progress").to_string(),
                            base(vec![("from", OVal::Null), ("latencyMs", OVal::Null)]),
                        )),
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
        record_summary(&mut plan, text, call.step_raw.is_some(), now);
        dirty = true;
    }
    match label_checked(&plan, now) {
        Ok(label) => out.put("label", label),
        Err(thrown) => return Ok(refused(key, &thrown)),
    };
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
/// failure inside `mutate` has written nothing; a write that fails is the verb's own refusal ([`ident::refuse`], Node's throw of `writeJsonAtomic`). The caller
/// marks the commit point after this returns.
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
        let text = stringify(next);
        if let Err(e) = write_atomic(&path, &text) {
            // Node's `writeJsonAtomic` throws and `run()` answers `{ ok: false, error }`
            return ident::refuse(&Obj(vec![("ok".into(), OVal::Bool(false)), ("error".into(), s(&e.to_string()))]).done().stringify());
        }
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

/// The log is past the size at which it is rotated before the next append. [`record`] rotates it itself (the roll-ups and the
/// generations, as Node's `rotateIfNeeded` does), so no caller needs to ask first.
pub fn log_needs_rotation(inv: &Inv) -> bool {
    std::fs::metadata(log_path(inv)).is_ok_and(|m| m.len() > defaults::num("mesh_write.supervision_max_bytes"))
}

/// `record(home, type, fields)`: one event line, best effort. Returns the line written.
pub fn record(inv: &Inv, typ: &str, fields: &[(String, OVal)], now: f64) -> Option<String> {
    let p = log_path(inv);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).ok()?;
    }
    crate::dssup::suplog::rotate_if_needed(&inv.home);
    let mut row = vec![("ts".to_string(), s(&crate::checks::agent_scan::iso_utc(now))), ("type".to_string(), s(typ))];
    row.extend(fields.iter().cloned());
    let line = format!("{}\n", stringify(&OVal::Obj(row)));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_inv(tag: &str) -> Inv {
        let home = std::env::temp_dir().join(format!("ah-plan-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&home).unwrap();
        Inv { home: home.clone(), write_home: home, env: Default::default(), cwd: "/".into(), now: 1_000_000, stdin: None, store_override: None }
    }

    fn parse(text: &str) -> OVal {
        OVal::parse(text).unwrap()
    }

    fn call<'a>(step: Option<&'a str>, summary: Option<&'a str>) -> Call<'a> {
        Call { step_raw: step, status: "doing", summary, now: 5_000_000.0 }
    }

    fn refusal(c: &Computed) -> (String, String) {
        assert!(c.next.is_none() && c.events.is_empty(), "a refused plan writes nothing and records nothing");
        assert_eq!(c.out.get("ok"), Some(&OVal::Bool(false)));
        let text = |k: &str| match c.out.get(k) {
            Some(OVal::Str(t)) => t.clone(),
            other => panic!("{k}: {other:?}"),
        };
        (text("reason"), text("error"))
    }

    #[test]
    fn a_string_cut_inside_an_emoji_keeps_javascripts_lone_surrogate_in_the_plan_bytes() {
        // "a😀b".slice(0, 2) is "a" + the high half \ud83d; JSON.stringify writes it as an escape
        let cut = clip_utf16("a\u{1F600}b", 2);
        assert_eq!(stringify(&OVal::Str(cut.clone())), "\"a\\ud83d\"");
        assert_eq!(clip_utf16("a\u{1F600}b", 3), "a\u{1F600}", "a cut after the pair keeps the pair");
        assert_eq!(clip_utf16("abc", 2), "ab");
        // and the plan file reads back into the same value, so a rewrite is byte-identical
        assert_eq!(parse_js("\"a\\ud83d\"").unwrap(), OVal::Str(cut));
        assert_eq!(parse_js("\"\\ud83d\\ude00\"").unwrap(), OVal::Str("\u{1F600}".into()), "a whole pair is the character");
        assert_eq!(parse_js("\"\\\\ud83d\"").unwrap(), OVal::Str("\\ud83d".into()), "an escaped backslash is text, not an escape");
        let low = parse_js("\"x\\ude00\"").unwrap();
        assert_eq!(stringify(&low), "\"x\\ude00\"", "a lone low half survives a rewrite");
    }

    #[test]
    fn a_plan_with_odd_steps_is_read_not_handed_over() {
        let inv = scratch_inv("read");
        let dir = plans_dir(&inv);
        std::fs::create_dir_all(&dir).unwrap();
        // invalid UTF-8 is decoded the way readFileSync decodes it; a null step is still a plan (Node's findPlan only tests the array)
        let mut bytes = b"{\"steps\":[null,7,{\"text\":\"a".to_vec();
        bytes.extend([0xff, 0xfe]);
        bytes.extend(b"\",\"status\":\"done\"}]}");
        std::fs::write(dir.join("k.json"), bytes).unwrap();
        let plan = read_plan(&dir.join("k.json")).unwrap().expect("a plan");
        assert_eq!(steps_of(&plan).len(), 3);
        assert_eq!(steps_of(&plan)[2].get("text"), Some(&OVal::Str("a\u{FFFD}\u{FFFD}".into())));
        std::fs::write(dir.join("o.json"), "{\"steps\":{}}").unwrap();
        assert!(read_plan(&dir.join("o.json")).unwrap().is_none(), "steps that is no array is no plan");
    }

    #[test]
    fn a_null_step_is_the_javascript_type_error_not_a_hand_off() {
        let inv = scratch_inv("null");
        let plan = parse(r#"{"steps":[{"n":1,"status":"todo"},null],"created_at":1}"#);
        let want = "Cannot read properties of null (reading 'status')";
        for c in [call(Some("1"), None), call(None, Some("hello")), call(Some("2"), None)] {
            let (reason, error) = refusal(&compute(&inv, "k", "id", &c, Some(plan.clone())).unwrap());
            assert_eq!((reason.as_str(), error.as_str()), ("plan-corrupt", want));
        }
        // a step number out of range is Node's own refusal, reached before any step is read
        let bad = compute(&inv, "k", "id", &call(Some("9"), None), Some(plan)).unwrap();
        assert_eq!(bad.out.get("reason"), Some(&OVal::Str("bad-step".into())));
    }

    #[test]
    fn a_step_that_is_a_primitive_refuses_the_assignment_and_an_array_step_takes_it_silently() {
        let inv = scratch_inv("prim");
        let plan = parse(r#"{"steps":[7,"x",true,[]],"created_at":1}"#);
        for (n, kind) in [("1", "number '7'"), ("2", "string 'x'"), ("3", "boolean 'true'")] {
            let (_, error) = refusal(&compute(&inv, "k", "id", &call(Some(n), None), Some(plan.clone())).unwrap());
            assert_eq!(error, format!("Cannot create property 'status' on {kind}"));
        }
        let c = compute(&inv, "k", "id", &call(Some("4"), None), Some(plan)).unwrap();
        assert_eq!(c.out.get("changed"), Some(&OVal::Bool(true)));
        let next = c.next.expect("the plan changed");
        assert_eq!(steps_of(&next)[3], OVal::Arr(vec![]), "a property on an array is no JSON");
        assert_eq!(next.get("current"), Some(&OVal::Num(4.0)));
    }

    #[test]
    fn values_javascript_converts_are_converted_as_it_does() {
        // Number([5]) is 5, Number([]) is 0, Number({}) is NaN, String({}) is "[object Object]"
        let plan = parse(r#"{"steps":[{"n":[1,[2,null]],"status":"doing"},{"n":{},"status":"blocked"},{"status":"todo"}],"created_at":[5],"regressed_from":{}}"#);
        assert_eq!(num_of(plan.get("created_at")), 5.0);
        assert!(num_of(plan.get("regressed_from")).is_nan());
        assert_eq!(num_of(Some(&parse("[]"))), 0.0);
        let label = finish_label(&plan, 5.0 + 60_000.0 * 3.0).unwrap();
        // 'doing #' + [1,[2,null]] is "doing #1,2,"; blocked #{} is "[object Object]"; no `n` at all would print "undefined"
        let OVal::Str(text) = label else { panic!("{label:?}") };
        assert!(text.contains("doing #1,2,") && text.contains("#[object Object] blocked"), "{text}");
        assert_eq!(js_string_opt(None), "undefined");
    }

    #[test]
    fn a_label_of_a_plan_node_throws_on_is_no_label_for_the_callers_that_catch_it() {
        let plan = parse(r#"{"steps":[null]}"#);
        assert_eq!(finish_label(&plan, 1.0).unwrap(), OVal::Null);
        assert!(label_checked(&plan, 1.0).is_err());
    }

    #[test]
    fn a_respawn_that_is_an_array_still_counts_the_first_step_progress_like_javascript() {
        let inv = scratch_inv("respawn");
        let plan = parse(r#"{"steps":[{"n":1,"status":"todo"}],"respawn":[],"created_at":1}"#);
        let c = compute(&inv, "k", "id", &call(Some("1"), None), Some(plan)).unwrap();
        let ev = c.events.iter().find(|(t, _)| t == "respawn-progress").expect("the respawn event");
        assert!(ev.1.contains(&("from".to_string(), OVal::Null)) && ev.1.contains(&("latencyMs".to_string(), OVal::Null)));
    }

    #[test]
    fn a_summary_with_non_ascii_text_is_recorded_the_way_javascript_records_it() {
        let inv = scratch_inv("summary");
        let plan = parse(r#"{"steps":[{"n":1,"status":"todo"}],"created_at":1}"#);
        // the text is cut at 200 UTF-16 units (an emoji is two), its signature lowercases by Unicode and collapses \s (NBSP too)
        let long = format!("{}\u{1F600}", "x".repeat(199));
        let c = compute(&inv, "k", "id", &call(None, Some(&long)), Some(plan.clone())).unwrap();
        let next = c.next.expect("a summary dirties the plan");
        let Some(OVal::Arr(list)) = next.get("summaries") else { panic!("summaries") };
        assert!(matches!(list[0].get("text"), Some(OVal::Str(t)) if t.chars().count() == 201), "199 letters, the mark and one private character");
        assert!(stringify(&next).contains("\\ud83d\""), "{}", stringify(&next));
        let a = compute(&inv, "k", "id", &call(None, Some("Caf\u{c9}\u{a0}\u{a0}BAR")), Some(plan.clone())).unwrap().next.unwrap();
        let b = compute(&inv, "k", "id", &call(None, Some("caf\u{e9} bar")), Some(plan)).unwrap().next.unwrap();
        assert_eq!(a.get("activity_sigs"), b.get("activity_sigs"), "NBSP is white space and É lowercases");
    }

    #[test]
    fn the_step_stall_window_comes_from_the_settings_tiers_and_never_hands_over() {
        let mut inv = scratch_inv("stall");
        let minute = 60_000.0;
        assert_eq!(step_stall_ms(&inv), 30.0 * minute, "the default");
        inv.env.insert("ANTIHALL_DEVSWARM_STEP_STALL_MIN".into(), "90".into());
        assert_eq!(step_stall_ms(&inv), 90.0 * minute, "the environment variable");
        inv.env.clear();
        let file = inv.home.join(".anti-hall/settings.json");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, r#"{"devswarm":{"stepStallMin":45}}"#).unwrap();
        assert_eq!(step_stall_ms(&inv), 45.0 * minute, "settings.json");
        std::fs::write(&file, r#"{"devswarm":{"stepStallMin":1}}"#).unwrap();
        assert_eq!(step_stall_ms(&inv), 5.0 * minute, "a value under the schema minimum is raised to it");
        // a settings file JavaScript reads and serde does not (a lone surrogate escape): counted, logged, the lower tiers answer
        std::fs::write(&file, r#"{"x":"\ud83d","devswarm":{"stepStallMin":45}}"#).unwrap();
        assert_eq!(step_stall_ms(&inv), 30.0 * minute);
    }

    #[test]
    fn a_descriptor_worktree_that_is_no_string_is_kept_as_it_is() {
        let inv = scratch_inv("ref");
        let dir = devswarm_root(&inv.home).join(defaults::text("mesh_write.dir_workspaces"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("w1.json"), r#"{"id":"w1","worktreePath":5}"#).unwrap();
        assert_eq!(plan_ref_value(&inv, "w1").unwrap(), Some(OVal::Num(5.0)));
        assert_eq!(plan_ref(&inv, "w1").unwrap(), None, "planKeyForWorktree reads a non-string as none");
        std::fs::write(dir.join("w2.json"), r#"{"id":"w2","worktreePath":0}"#).unwrap();
        assert_eq!(plan_ref_value(&inv, "w2").unwrap(), None, "a falsy value is none");
    }

    #[test]
    fn a_plan_that_cannot_be_written_is_the_verbs_refusal_with_the_systems_message() {
        let inv = scratch_inv("write");
        // the plan's own path is a directory: the rename onto it fails
        std::fs::create_dir_all(plan_file(&inv, "k").join("sub")).unwrap();
        let r = update_with(&inv, "k", |cur| Ok(((), cur.or_else(|| Some(parse(r#"{"steps":[]}"#))))));
        let Err(d) = r else { panic!("{r:?}") };
        let body = ident::refusal_body(&d).expect("a refusal, not a hand-off");
        assert!(body.starts_with("{\"ok\":false,\"error\":\"") && !body.contains("plan-write"), "{body}");
    }

    #[test]
    fn the_supervision_log_is_rotated_by_the_record_that_finds_it_full() {
        let inv = scratch_inv("rotate");
        let log = log_path(&inv);
        std::fs::create_dir_all(log.parent().unwrap()).unwrap();
        let row = "{\"ts\":\"2025-10-09T08:00:00.000Z\",\"type\":\"warn\",\"id\":\"w1\",\"signal\":\"stall\",\"repeat\":false}\n";
        std::fs::write(&log, row.repeat(defaults::num("mesh_write.supervision_max_bytes") as usize / row.len() + 2)).unwrap();
        assert!(log_needs_rotation(&inv));
        let line = record(&inv, "plan", &[("id".into(), s("w1"))], 1_000.0).expect("the event line");
        assert_eq!(std::fs::read_to_string(&log).unwrap(), line, "the new log holds only the new event");
        let mut rotated = log.as_os_str().to_os_string();
        rotated.push(".1");
        assert!(std::path::Path::new(&rotated).exists(), "the full log became generation 1");
    }
}
