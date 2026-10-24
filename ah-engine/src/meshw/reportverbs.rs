//! `supervision-report [--days N] [--json]` (lane l8c), ported from `companion/lib/devswarm-supervision-metrics.js`
//! (`report`, `buildDailyRollups`, `formatReport`) and `companion/lib/devswarm-token-usage.js` `fmt`.
//!
//! A pure read: the raw supervision log (`devswarm-supervision.ndjson` and its numbered generations) is aggregated per UTC day,
//! merged with the daily rollup files of older days, and printed as the report object or as the text table.
//!
//! Node's JavaScript semantics are kept where a log or rollup file can hold something unexpected: an integer-like key sorts first
//! in a JavaScript object, `__proto__` is never an own key, a non-string `signal` or `id` is the key its text names, and a `null`
//! where Node dereferences a field is a [`Thrown`] exception (`{ ok:false, error }`, exit 2). Two inputs are skipped and counted
//! instead (`mesh_report_skipped`): a log row whose `ts` is a date string the engine does not read (only ISO forms are written
//! by anyone), and a rollup file with a field that is not a number or list of numbers (Node would add it as text).
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::{OVal, is_array_index_key};
use crate::checks::guardkit::text::{js_number_of_str, js_trim};
use crate::checks::jsport::date::{self, Parsed};
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::dssup::appsync::{plan as asplan, snap, state as asstate};
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::R;
use crate::meshw::send::{Answer, Effect};
use std::path::Path;

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
}

/// What Node's dispatcher does with an exception: `{ ok:false, error }`, exit 2, and the exception in the central log.
fn thrown_answer(inv: &Inv, op: &str, e: &Thrown) -> Answer {
    let repo_key = crate::meshw::ident::resolve_context(&inv.cwd, true).ok().and_then(|c| c.repo_key);
    crate::meshw::clog::refusal(inv, op, repo_key.as_deref(), None, &e.0, None);
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(&e.0));
    answer(2, o.done())
}

fn tpl(key: &str, args: &[(&str, &str)]) -> String {
    crate::checks::devswarm_role::text::fill_once(defaults::text(key), args)
}

/// A number as JavaScript prints it.
fn js(x: f64) -> String {
    to_js_string(x)
}

/// `Math.round(x)` for a non-negative number.
fn round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// An exception Node's code raises (a `TypeError` on a `null`, a `RangeError` on a date out of range): the verb answers
/// `{ ok:false, error }` with exit 2, as Node's dispatcher does, and the message is Node's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Thrown(pub String);

fn thrown(what: &str, field: &str) -> Thrown {
    Thrown(defaults::render("devswarm_cli.sr_msg_null_read", &[("what", &what), ("field", &field)]))
}

/// `Object.keys` order: a canonical array index sorts first, ascending; every other key follows in insertion order.
/// The position a new key `k` takes among `keys`.
fn js_position<'a>(keys: impl Iterator<Item = &'a str>, k: &str) -> usize {
    if !is_array_index_key(k) {
        return keys.count();
    }
    let at = k.parse::<u64>().unwrap_or(u64::MAX);
    let mut pos = 0;
    for x in keys {
        match x.parse::<u64>() {
            Ok(v) if is_array_index_key(x) && v < at => pos += 1,
            _ => break,
        }
    }
    pos
}

/// `__proto__` assigned a number or string is ignored by JavaScript: it is never an own key.
fn is_proto(k: &str) -> bool {
    k == defaults::text("devswarm_cli.sr_proto_key")
}

/// `String(x)` for the value a property key is computed from (`signal`, `id`, `integration`, `mode`).
fn key_text(v: &OVal) -> String {
    crate::dssup::ingest::import::js_string(v)
}

/// An ordered counter map (`obj[k] = (obj[k] || 0) + by`).
#[derive(Debug, Clone, Default)]
struct Counts(Vec<(String, f64)>);

impl Counts {
    fn add(&mut self, k: &str, by: f64) {
        if is_proto(k) {
            return;
        }
        match self.0.iter_mut().find(|(x, _)| x == k) {
            Some(slot) => slot.1 += by,
            None => {
                let at = js_position(self.0.iter().map(|(x, _)| x.as_str()), k);
                self.0.insert(at, (k.to_string(), by));
            }
        }
    }
    fn total(&self) -> f64 {
        self.0.iter().fold(0.0, |a, (_, v)| a + v)
    }
    fn get(&self, k: &str) -> f64 {
        self.0.iter().find(|(x, _)| x == k).map_or(0.0, |(_, v)| *v)
    }
}

/// One `jevGroup`: the counters and the per-mode counts.
#[derive(Debug, Clone, Default)]
struct Jev {
    n: f64,
    agree: f64,
    followed: f64,
    overridden: f64,
    progress_supported: f64,
    progress_not: f64,
    by_mode: Counts,
}

/// One day's rollup (`emptyRollup`).
#[derive(Debug, Clone, Default)]
pub(crate) struct Roll {
    plans: f64,
    steps: f64,
    warnings: Counts,
    repeats: f64,
    corrections: f64,
    corrections_followed: f64,
    extras: f64,
    done: f64,
    durations: Vec<f64>,
    steps_done: f64,
    steps_planned: f64,
    jev: Vec<(String, Jev)>,
    token_periods: Vec<f64>,
    tokens_by_ws: Counts,
    done_tokens: Vec<f64>,
    burn_corrections: f64,
    burn_followed: f64,
    respawns: f64,
    respawns_parked: f64,
    respawns_aborted: f64,
    respawn_progress: Vec<f64>,
    respawns_finished: f64,
    /// The exception Node raises when this rollup is summed (a null group in its `jev`).
    poison: Option<Thrown>,
    /// Where counts for the key `__proto__` go: JavaScript mutates `Object.prototype` there, which no output shows.
    sink: Jev,
}

impl Roll {
    /// `jevGroup(d, integration)`: the group of that integration (`unknown` when absent), created on first use.
    fn jev_group(&mut self, integration: Option<&str>) -> &mut Jev {
        let k = integration.filter(|x| !x.is_empty()).unwrap_or(defaults::text("devswarm_cli.sr_unknown"));
        if is_proto(k) {
            self.sink = Jev::default();
            return &mut self.sink;
        }
        let i = match self.jev.iter().position(|(x, _)| x == k) {
            Some(i) => i,
            None => {
                let at = js_position(self.jev.iter().map(|(x, _)| x.as_str()), k);
                self.jev.insert(at, (k.to_string(), Jev::default()));
                at
            }
        };
        &mut self.jev[i].1
    }
}

fn finite(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `String(r.x || ...)` for a field used as a key: `None` when it is absent or falsy, else the text JavaScript prints for it.
fn text_of(v: Option<&OVal>) -> Option<String> {
    match v {
        None | Some(OVal::Null) => None,
        Some(OVal::Str(x)) => (!x.is_empty()).then(|| x.clone()),
        Some(x) if !x.truthy() => None,
        Some(x) => Some(key_text(x)),
    }
}

/// The `jev` array of a row: `(integration, supports)` per element; a `null` element makes Node throw (`n.integration`).
fn jev_notes(v: Option<&OVal>) -> Result<Vec<(Option<String>, bool)>, Thrown> {
    let Some(OVal::Arr(items)) = v else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for it in items {
        match it {
            OVal::Null => return Err(thrown(defaults::text("devswarm_cli.sr_null_word"), defaults::text("devswarm_cli.sr_field_integration"))),
            OVal::Obj(_) => out.push((text_of(it.get("integration")), it.get("supports").is_some_and(OVal::truthy))),
            _ => out.push((None, false)),
        }
    }
    Ok(out)
}

fn includes(v: Option<&OVal>, word: &str) -> bool {
    matches!(v, Some(OVal::Arr(a)) if a.iter().any(|x| matches!(x, OVal::Str(t) if t == word)))
}

/// `buildDailyRollups(rows)`: per UTC day, in order of first appearance.
pub(crate) fn build_daily(rows: &[OVal]) -> Result<Vec<(String, Roll)>, Thrown> {
    let mut days: Vec<(String, Roll)> = Vec::new();
    let t = |k: &str| defaults::text(k);
    for r in rows {
        let Some(OVal::Str(ts)) = r.get("ts") else { continue };
        let ms = match date::parse(ts) {
            Parsed::Ms(ms) => ms,
            Parsed::Nan => continue,
            // a date string the engine does not read (only ISO forms are ever written): the row is skipped and counted
            Parsed::Unknown => {
                skipped(defaults::text("devswarm_cli.sr_skip_ts"));
                continue;
            }
        };
        // `Date.parse` is NaN outside the Date range, so a finite value always has an ISO form; the guard is for a non-finite one
        let Some(iso) = ms.is_finite().then(|| date::to_iso(ms)).flatten() else { continue };
        let day = iso.chars().take(defaults::num("devswarm_cli.sr_day_chars") as usize).collect::<String>();
        let i = match days.iter().position(|(x, _)| *x == day) {
            Some(i) => i,
            None => {
                days.push((day, Roll::default()));
                days.len() - 1
            }
        };
        let d = &mut days[i].1;
        let ty = match r.get("type") {
            Some(OVal::Str(x)) => x.as_str(),
            _ => "",
        };
        if ty == t("devswarm_cli.sr_t_plan") {
            d.plans += 1.0;
        } else if ty == t("devswarm_cli.sr_t_step") {
            d.steps += 1.0;
        } else if ty == t("devswarm_cli.sr_t_warn") {
            let sig = text_of(r.get("signal")).unwrap_or_else(|| t("devswarm_cli.sr_unknown").to_string());
            d.warnings.add(&sig, 1.0);
            if r.get("repeat").is_some_and(OVal::truthy) {
                d.repeats += 1.0;
            }
        } else if ty == t("devswarm_cli.sr_t_correction") {
            d.corrections += 1.0;
            if includes(r.get("signals"), t("devswarm_cli.sr_burn")) {
                d.burn_corrections += 1.0;
            }
            for (integration, supports) in jev_notes(r.get("jev"))? {
                let g = d.jev_group(integration.as_deref());
                if supports {
                    g.followed += 1.0;
                } else {
                    g.overridden += 1.0;
                }
            }
        } else if ty == t("devswarm_cli.sr_t_followed") {
            d.corrections_followed += 1.0;
            if includes(r.get("signals"), t("devswarm_cli.sr_burn")) {
                d.burn_followed += 1.0;
            }
            for (integration, supports) in jev_notes(r.get("jev"))? {
                let g = d.jev_group(integration.as_deref());
                if supports {
                    g.progress_supported += 1.0;
                } else {
                    g.progress_not += 1.0;
                }
            }
        } else if ty == t("devswarm_cli.sr_t_tokens") {
            if let Some(tok) = finite(r.get("tokens")) {
                d.token_periods.push(tok);
                let id = text_of(r.get("id")).unwrap_or_else(|| t("devswarm_cli.sr_unknown").to_string());
                d.tokens_by_ws.add(&id, tok);
            }
        } else if ty == t("devswarm_cli.sr_t_extra") {
            d.extras += 1.0;
        } else if ty == t("devswarm_cli.sr_t_done") {
            d.done += 1.0;
            if let Some(x) = finite(r.get("durationMs")) {
                d.durations.push(x);
            }
            if let Some(x) = finite(r.get("stepsDone")) {
                d.steps_done += x;
            }
            if let Some(x) = finite(r.get("stepsPlanned")) {
                d.steps_planned += x;
            }
            if let (Some(total), Some(sd)) = (finite(r.get("tokensTotal")), finite(r.get("stepsDone")))
                && sd > 0.0
            {
                d.done_tokens.push(round(total / sd));
            }
            if r.get("respawnOf").is_some_and(OVal::truthy) {
                d.respawns_finished += 1.0;
            }
        } else if ty == t("devswarm_cli.sr_t_respawn") {
            d.respawns += 1.0;
            if r.get("parked").is_some_and(OVal::truthy) {
                d.respawns_parked += 1.0;
            }
        } else if ty == t("devswarm_cli.sr_t_aborted") {
            d.respawns_aborted += 1.0;
        } else if ty == t("devswarm_cli.sr_t_progress") {
            if let Some(x) = finite(r.get("latencyMs")) {
                d.respawn_progress.push(x);
            }
        } else if ty == t("devswarm_cli.sr_t_jev") {
            let integration = text_of(r.get("integration"));
            let agree = matches!(r.get("agree"), Some(OVal::Bool(true)));
            let mode = text_of(r.get("mode")).unwrap_or_else(|| t("devswarm_cli.sr_unknown").to_string());
            let g = d.jev_group(integration.as_deref());
            g.n += 1.0;
            if agree {
                g.agree += 1.0;
            }
            g.by_mode.add(&mode, 1.0);
        }
    }
    Ok(days)
}

/// A rollup file with a field that is no number or list of numbers: Node would add it as text and print the result; the file is
/// skipped instead, and counted.
struct Malformed;

/// A rollup field the sums add: `r.x || 0`. A number, a boolean or nothing adds as a number; text, a list or an object would be
/// concatenated by JavaScript, which marks the file malformed.
fn num0(v: Option<&OVal>) -> Result<f64, Malformed> {
    match v {
        None | Some(OVal::Null) => Ok(0.0),
        Some(OVal::Num(x)) => Ok(if x.is_nan() { 0.0 } else { *x }),
        Some(OVal::Bool(b)) => Ok(f64::from(u8::from(*b))),
        Some(x) if !x.truthy() => Ok(0.0),
        Some(_) => Err(Malformed),
    }
}

/// A list field of a rollup file whose elements are all numbers (or absent).
fn num_list(v: Option<&OVal>) -> Result<Vec<f64>, Malformed> {
    match v {
        Some(OVal::Arr(a)) => a
            .iter()
            .map(|x| match x {
                OVal::Num(f) if f.is_finite() => Ok(*f),
                _ => Err(Malformed),
            })
            .collect(),
        _ => Ok(Vec::new()),
    }
}

/// `Object.entries(v || {})`: an object's own entries, a list's by index, a string's characters by index; nothing for the rest.
fn entries_of(v: Option<&OVal>) -> Vec<(String, OVal)> {
    match v {
        Some(OVal::Obj(o)) => o.clone(),
        Some(OVal::Arr(a)) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x.clone())).collect(),
        Some(OVal::Str(x)) => x.encode_utf16().enumerate().map(|(i, u)| (i.to_string(), OVal::Str(String::from_utf16_lossy(&[u])))).collect(),
        _ => Vec::new(),
    }
}

/// A map field of a rollup file: name -> number.
fn num_map(v: Option<&OVal>) -> Result<Counts, Malformed> {
    let mut out = Counts::default();
    for (k, x) in entries_of(v) {
        out.add(&k, num0(Some(&x))?);
    }
    Ok(out)
}

/// A rollup file's content as a [`Roll`] (JavaScript reads missing fields as 0 / empty); `None` for a malformed file.
fn roll_of_json(v: &OVal) -> Option<Roll> {
    let mut r = Roll::default();
    if !matches!(v, OVal::Obj(_)) {
        return Some(r);
    }
    let f = |k: &str| v.get(k);
    let parsed = (|| -> Result<(), Malformed> {
        r.plans = num0(f("plans"))?;
        r.steps = num0(f("steps"))?;
        r.repeats = num0(f("repeats"))?;
        r.corrections = num0(f("corrections"))?;
        r.corrections_followed = num0(f("correctionsFollowed"))?;
        r.extras = num0(f("extras"))?;
        r.done = num0(f("done"))?;
        r.steps_done = num0(f("stepsDone"))?;
        r.steps_planned = num0(f("stepsPlanned"))?;
        r.durations = num_list(f("durationsMs"))?;
        r.token_periods = num_list(f("tokenPeriods"))?;
        r.done_tokens = num_list(f("doneTokens"))?;
        r.burn_corrections = num0(f("burnCorrections"))?;
        r.burn_followed = num0(f("burnFollowed"))?;
        r.respawns = num0(f("respawns"))?;
        r.respawns_parked = num0(f("respawnsParked"))?;
        r.respawns_aborted = num0(f("respawnsAborted"))?;
        r.respawns_finished = num0(f("respawnsFinished"))?;
        r.respawn_progress = num_list(f("respawnProgressMs"))?;
        r.tokens_by_ws = num_map(f("tokensByWorkspace"))?;
        r.warnings = num_map(f("warnings"))?;
        for (k, g) in entries_of(f("jev")) {
            // `g[c]` on a null group is Node's TypeError, raised when the totals are summed
            if matches!(g, OVal::Null) {
                r.poison.get_or_insert_with(|| thrown(defaults::text("devswarm_cli.sr_null_word"), defaults::text("devswarm_cli.sr_field_n")));
                continue;
            }
            let slot = r.jev_group(Some(&k));
            slot.n = num0(g.get("n"))?;
            slot.agree = num0(g.get("agree"))?;
            slot.followed = num0(g.get("followed"))?;
            slot.overridden = num0(g.get("overridden"))?;
            slot.progress_supported = num0(g.get("progressWhenSupported"))?;
            slot.progress_not = num0(g.get("progressWhenNotSupported"))?;
            slot.by_mode = num_map(g.get("byMode"))?;
        }
        Ok(())
    })();
    parsed.ok().map(|()| r)
}

/// A skipped input, counted and logged with the reason.
fn skipped(why: &str) {
    crate::metrics::bump("mesh_report_skipped", &[("why", why)]);
    crate::debug::violated("meshw", &defaults::render("devswarm_cli.sr_msg_skipped", &[("why", &why)]));
}

/// `median(xs)`: the lower middle of the sorted values.
fn median(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    let mut v = xs.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Some(v[(v.len() - 1) / 2])
}

fn opt(x: Option<f64>) -> OVal {
    x.map_or(OVal::Null, n)
}

/// `Math.round(a / b * 100) / 100`, or null when `b` is 0.
fn rate(a: f64, b: f64) -> Option<f64> {
    (b != 0.0).then(|| round((a / b) * 100.0) / 100.0)
}

/// The retained generations of the supervision log, oldest first, then the current file.
pub(crate) fn log_files(dir: &Path, base: &str) -> Result<Vec<std::path::PathBuf>, Thrown> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Ok(Vec::new()) };
    let mut gens: Vec<f64> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name == base {
            continue;
        }
        if let Some(rest) = name.strip_prefix(&format!("{base}."))
            && !rest.is_empty()
            && rest.bytes().all(|b| b.is_ascii_digit())
        {
            // `Number(digits)` and its text (`js`) are JavaScript's, exponent forms and `Infinity` included
            gens.push(js_number_of_str(rest));
        }
    }
    gens.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<std::path::PathBuf> = gens.iter().map(|g| dir.join(format!("{base}.{}", js(*g)))).collect();
    let cur = dir.join(base);
    if cur.exists() {
        out.push(cur);
    }
    Ok(out)
}

/// `readNdjsonFiles(files)`: every line that parses, as the value it holds.
pub(crate) fn read_rows(files: &[std::path::PathBuf]) -> Vec<OVal> {
    let mut rows = Vec::new();
    for f in files {
        let Ok(bytes) = std::fs::read(f) else { continue };
        for line in String::from_utf8_lossy(&bytes).split('\n') {
            let t = js_trim(line);
            if t.is_empty() {
                continue;
            }
            if let Some(v) = OVal::parse(t) {
                rows.push(v);
            }
        }
    }
    rows
}

/// The report's data: Node's `report(home, { days, now })` as the typed totals plus the header numbers.
struct Report {
    days: f64,
    since: String,
    days_with_data: usize,
    t: Roll,
}

fn gather(inv: &Inv, days_in: f64) -> Result<Report, Thrown> {
    let days = if days_in.is_finite() && days_in >= 1.0 { days_in.floor() } else { 7.0 };
    let now = inv.now as f64;
    let start = now - (days - 1.0) * 86_400_000.0;
    // `new Date(start).toISOString()` throws a RangeError for a time outside the Date range (a huge --days)
    let Some(iso) = date::to_iso(start) else { return Err(Thrown(defaults::text("devswarm_cli.sr_msg_invalid_time").to_string())) };
    let since = iso.chars().take(defaults::num("devswarm_cli.sr_day_chars") as usize).collect::<String>();
    let logs = inv.home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs"));
    let daily_dir = logs.join(defaults::text("devswarm_cli.sr_daily_dir"));
    // a day's rollup; `None` is a rollup file holding `null`, which Node dereferences when the totals are summed
    let mut by_day: Vec<(String, Option<Roll>)> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&daily_dir) {
        // Node lists a directory in byte order (libuv sorts what `scandir` returns)
        let mut entries: Vec<(String, std::path::PathBuf)> = rd.flatten().map(|e| (e.file_name().to_string_lossy().into_owned(), e.path())).collect();
        entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        for (name, path) in entries {
            let Some(day) = name.strip_suffix(defaults::text("mesh_write.json_suffix")) else { continue };
            let b = day.as_bytes();
            let shape = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
            if !shape || day < since.as_str() {
                continue;
            }
            let Ok(bytes) = std::fs::read(path) else { continue };
            let Some(v) = OVal::parse(&String::from_utf8_lossy(&bytes)) else { continue };
            let roll = if matches!(v, OVal::Null) {
                None
            } else {
                match roll_of_json(&v) {
                    Some(r) => Some(r),
                    None => {
                        skipped(defaults::text("devswarm_cli.sr_skip_rollup"));
                        continue;
                    }
                }
            };
            match by_day.iter_mut().find(|(d, _)| d == day) {
                Some(slot) => slot.1 = roll,
                None => by_day.push((day.to_string(), roll)),
            }
        }
    }
    let base = defaults::text("mesh_write.supervision_log");
    let rows = read_rows(&log_files(&logs, base)?);
    for (day, r) in build_daily(&rows)? {
        if day.as_str() >= since.as_str() {
            match by_day.iter_mut().find(|(d, _)| *d == day) {
                Some(slot) => slot.1 = Some(r),
                None => by_day.push((day, Some(r))),
            }
        }
    }
    let mut t = Roll::default();
    for (_, r) in &by_day {
        let Some(r) = r else { return Err(thrown(defaults::text("devswarm_cli.sr_null_word"), defaults::text("devswarm_cli.sr_field_plans"))) };
        if let Some(p) = &r.poison {
            return Err(p.clone());
        }
        t.plans += r.plans;
        t.steps += r.steps;
        t.repeats += r.repeats;
        t.corrections += r.corrections;
        t.corrections_followed += r.corrections_followed;
        t.extras += r.extras;
        t.done += r.done;
        t.steps_done += r.steps_done;
        t.steps_planned += r.steps_planned;
        t.durations.extend(&r.durations);
        t.token_periods.extend(&r.token_periods);
        t.done_tokens.extend(&r.done_tokens);
        t.burn_corrections += r.burn_corrections;
        t.burn_followed += r.burn_followed;
        t.respawns += r.respawns;
        t.respawns_parked += r.respawns_parked;
        t.respawns_aborted += r.respawns_aborted;
        t.respawns_finished += r.respawns_finished;
        t.respawn_progress.extend(&r.respawn_progress);
        for (k, v) in &r.tokens_by_ws.0 {
            t.tokens_by_ws.add(k, *v);
        }
        for (k, v) in &r.warnings.0 {
            t.warnings.add(k, *v);
        }
        for (k, g) in &r.jev {
            let a = t.jev_group(Some(k));
            a.n += g.n;
            a.agree += g.agree;
            a.followed += g.followed;
            a.overridden += g.overridden;
            a.progress_supported += g.progress_supported;
            a.progress_not += g.progress_not;
            for (m, c) in &g.by_mode.0 {
                a.by_mode.add(m, *c);
            }
        }
    }
    Ok(Report { days, since, days_with_data: by_day.len(), t })
}

fn counts_obj(c: &Counts) -> OVal {
    OVal::Obj(c.0.iter().map(|(k, v)| (k.clone(), n(*v))).collect())
}

impl Roll {
    /// The rollup file's object (`Object.assign({ complete }, emptyRollup(day))` filled in): the keys in `emptyRollup`'s order.
    pub(crate) fn to_file_value(&self, day: &str, complete: bool) -> OVal {
        let list = |xs: &[f64]| OVal::Arr(xs.iter().map(|x| n(*x)).collect());
        let jev: Vec<(String, OVal)> = self
            .jev
            .iter()
            .map(|(k, g)| {
                let mut j = Obj::default();
                j.put("byMode", counts_obj(&g.by_mode))
                    .put("n", n(g.n))
                    .put("agree", n(g.agree))
                    .put("followed", n(g.followed))
                    .put("overridden", n(g.overridden))
                    .put("progressWhenSupported", n(g.progress_supported))
                    .put("progressWhenNotSupported", n(g.progress_not));
                (k.clone(), j.done())
            })
            .collect();
        let mut o = Obj::default();
        o.put("complete", OVal::Bool(complete))
            .put("v", n(1.0))
            .put("day", s(day))
            .put("plans", n(self.plans))
            .put("steps", n(self.steps))
            .put("warnings", counts_obj(&self.warnings))
            .put("repeats", n(self.repeats))
            .put("corrections", n(self.corrections))
            .put("correctionsFollowed", n(self.corrections_followed))
            .put("extras", n(self.extras))
            .put("done", n(self.done))
            .put("durationsMs", list(&self.durations))
            .put("stepsDone", n(self.steps_done))
            .put("stepsPlanned", n(self.steps_planned))
            .put("jev", OVal::Obj(jev))
            .put("tokenPeriods", list(&self.token_periods))
            .put("tokensByWorkspace", counts_obj(&self.tokens_by_ws))
            .put("doneTokens", list(&self.done_tokens))
            .put("burnCorrections", n(self.burn_corrections))
            .put("burnFollowed", n(self.burn_followed))
            .put("respawns", n(self.respawns))
            .put("respawnsParked", n(self.respawns_parked))
            .put("respawnsAborted", n(self.respawns_aborted))
            .put("respawnProgressMs", list(&self.respawn_progress))
            .put("respawnsFinished", n(self.respawns_finished));
        o.done()
    }
}

/// The report object (`report(home, opts)`).
fn report_value(r: &Report) -> OVal {
    let t = &r.t;
    let warn_total = t.warnings.total();
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.sr_action")))
        .put("days", n(r.days))
        .put("since", s(&r.since))
        .put("daysWithData", n(r.days_with_data as f64))
        .put("plans", n(t.plans))
        .put("stepUpdates", n(t.steps));
    let mut w = Obj::default();
    w.put("total", n(warn_total)).put("bySignal", counts_obj(&t.warnings)).put("repeats", n(t.repeats));
    o.put("warnings", w.done());
    let mut c = Obj::default();
    c.put("sent", n(t.corrections)).put("followedByProgress", n(t.corrections_followed)).put("followRate", opt(rate(t.corrections_followed, t.corrections)));
    o.put("corrections", c.done()).put("extrasTagged", n(t.extras));
    let mut burn = Obj::default();
    burn.put("warnings", n(t.warnings.get(defaults::text("devswarm_cli.sr_burn"))))
        .put("corrections", n(t.burn_corrections))
        .put("followedByProgress", n(t.burn_followed))
        .put("correctedRate", opt(rate(t.burn_followed, t.burn_corrections)));
    let mut tok = Obj::default();
    tok.put("total", n(t.token_periods.iter().fold(0.0, |a, b| a + b)))
        .put("byWorkspace", counts_obj(&t.tokens_by_ws))
        .put("stepPeriods", n(t.token_periods.len() as f64))
        .put("medianPerStepPeriod", opt(median(&t.token_periods)))
        .put("medianPerCompletedStep", opt(median(&t.done_tokens)))
        .put("burn", burn.done());
    o.put("tokens", tok.done());
    let mut d = Obj::default();
    d.put("n", n(t.done)).put("medianDurationMs", opt(median(&t.durations))).put("stepsDone", n(t.steps_done)).put("stepsPlanned", n(t.steps_planned));
    o.put("done", d.done());
    let mut rs = Obj::default();
    rs.put("n", n(t.respawns))
        .put("parked", n(t.respawns_parked))
        .put("notParked", n(t.respawns - t.respawns_parked))
        .put("aborted", n(t.respawns_aborted))
        .put("withProgress", n(t.respawn_progress.len() as f64))
        .put("medianFirstProgressMs", opt(median(&t.respawn_progress)))
        .put("finished", n(t.respawns_finished));
    o.put("respawns", rs.done());
    let jev: Vec<(String, OVal)> = t
        .jev
        .iter()
        .map(|(k, g)| {
            let mut j = Obj::default();
            j.put("byMode", counts_obj(&g.by_mode))
                .put("n", n(g.n))
                .put("agree", n(g.agree))
                .put("followed", n(g.followed))
                .put("overridden", n(g.overridden))
                .put("progressWhenSupported", n(g.progress_supported))
                .put("progressWhenNotSupported", n(g.progress_not))
                .put("agreeRate", opt(rate(g.agree, g.n)))
                .put("followRate", opt(rate(g.followed, g.followed + g.overridden)));
            (k.clone(), j.done())
        })
        .collect();
    o.put("jev", OVal::Obj(jev));
    o.done()
}

/// `fmt(n)` of the token-usage module: `1.8M`, `420k`, `900`.
fn fmt_tokens(v: f64) -> String {
    if v >= 1e6 {
        format!("{}{}", js(round(v / 1e5) / 10.0), defaults::text("devswarm_cli.sr_unit_m"))
    } else if v >= 1e3 {
        format!("{}{}", js(round(v / 1e3)), defaults::text("devswarm_cli.sr_unit_k"))
    } else {
        js(round(v))
    }
}

/// `dur(ms)` of the plan module.
fn fmt_dur(ms: Option<f64>) -> String {
    let Some(ms) = ms else { return defaults::text("devswarm_cli.sr_dash").to_string() };
    crate::meshw::plan::dur(ms)
}

fn pct(x: Option<f64>) -> String {
    x.map(|v| tpl("devswarm_cli.sr_rate", &[("pct", &js(round(v * 100.0)))])).unwrap_or_default()
}

/// `formatReport(r)`.
fn format_report(r: &Report) -> String {
    let t = &r.t;
    let sig = if t.warnings.0.is_empty() {
        defaults::text("devswarm_cli.sr_none").to_string()
    } else {
        t.warnings
            .0
            .iter()
            .map(|(k, v)| tpl("devswarm_cli.sr_pair", &[("k", k), ("n", &js(*v))]))
            .collect::<Vec<_>>()
            .join(defaults::text("devswarm_cli.sr_comma"))
    };
    let tok = |x: Option<f64>| x.map_or_else(|| defaults::text("devswarm_cli.sr_dash").to_string(), fmt_tokens);
    let follow = rate(t.corrections_followed, t.corrections);
    let burn_rate = rate(t.burn_followed, t.burn_corrections);
    let mut lines = vec![
        tpl("devswarm_cli.sr_head", &[("days", &js(r.days)), ("since", &r.since), ("with", &js(r.days_with_data as f64))]),
        tpl("devswarm_cli.sr_plans", &[("plans", &js(t.plans)), ("steps", &js(t.steps))]),
        tpl("devswarm_cli.sr_warn", &[("total", &js(t.warnings.total())), ("sig", &sig), ("repeats", &js(t.repeats))]),
        tpl("devswarm_cli.sr_corr", &[("sent", &js(t.corrections)), ("followed", &js(t.corrections_followed)), ("rate", &pct(follow))]),
        tpl("devswarm_cli.sr_extras", &[("n", &js(t.extras))]),
        tpl(
            "devswarm_cli.sr_tokens",
            &[
                ("total", &tok(Some(t.token_periods.iter().fold(0.0, |a, b| a + b)))),
                ("periods", &js(t.token_periods.len() as f64)),
                ("mp", &tok(median(&t.token_periods))),
                ("mc", &tok(median(&t.done_tokens))),
            ],
        ),
        tpl(
            "devswarm_cli.sr_burn_line",
            &[
                ("w", &js(t.warnings.get(defaults::text("devswarm_cli.sr_burn")))),
                ("c", &js(t.burn_corrections)),
                ("f", &js(t.burn_followed)),
                ("rate", &pct(burn_rate)),
            ],
        ),
        tpl("devswarm_cli.sr_done", &[("n", &js(t.done)), ("dur", &fmt_dur(median(&t.durations))), ("sd", &js(t.steps_done)), ("sp", &js(t.steps_planned))]),
        tpl(
            "devswarm_cli.sr_resp",
            &[
                ("n", &js(t.respawns)),
                ("parked", &js(t.respawns_parked)),
                ("np", &js(t.respawns - t.respawns_parked)),
                ("ab", &js(t.respawns_aborted)),
                ("wp", &js(t.respawn_progress.len() as f64)),
                ("med", &fmt_dur(median(&t.respawn_progress))),
                ("fin", &js(t.respawns_finished)),
            ],
        ),
    ];
    let mut ws: Vec<&(String, f64)> = t.tokens_by_ws.0.iter().collect();
    ws.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ws.truncate(defaults::num("devswarm_cli.sr_top_workspaces") as usize);
    if !ws.is_empty() {
        let list = ws
            .iter()
            .map(|(id, v)| tpl("devswarm_cli.sr_ws_item", &[("id", id), ("tok", &fmt_tokens(*v))]))
            .collect::<Vec<_>>()
            .join(defaults::text("devswarm_cli.sr_comma"));
        lines.push(tpl("devswarm_cli.sr_top", &[("list", &list)]));
    }
    if t.jev.is_empty() {
        lines.push(defaults::text("devswarm_cli.sr_jev_none").to_string());
    }
    for (k, g) in &t.jev {
        let modes = g
            .by_mode
            .0
            .iter()
            .map(|(m, c)| tpl("devswarm_cli.sr_pair", &[("k", m), ("n", &js(*c))]))
            .collect::<Vec<_>>()
            .join(defaults::text("devswarm_cli.sr_comma"));
        lines.push(tpl(
            "devswarm_cli.sr_jev",
            &[
                ("k", k),
                ("agree", &js(g.agree)),
                ("n", &js(g.n)),
                ("rate", &pct(rate(g.agree, g.n))),
                ("modes", &modes),
                ("fol", &js(g.followed)),
                ("ov", &js(g.overridden)),
                ("ps", &js(g.progress_supported)),
                ("pn", &js(g.progress_not)),
            ],
        ));
    }
    lines.join("\n")
}

/// `supervision-report [--days N] [--json]`.
pub fn supervision_report(inv: &Inv, a: &Args) -> R<Answer> {
    let days_raw = a.one(defaults::text("devswarm_cli.flag_days"));
    let days = days_raw.map_or(7.0, js_number_of_str);
    if !days.is_finite() || days < 1.0 {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false)).put("action", s(defaults::text("devswarm_cli.sr_action"))).put("error", s(defaults::text("devswarm_cli.sr_usage")));
        return Ok(answer(2, o.done()));
    }
    let rep = match gather(inv, days) {
        Ok(r) => r,
        Err(e) => return Ok(thrown_answer(inv, defaults::text("devswarm_cli.verb_supervision_report"), &e)),
    };
    // the text form unless the word `--json` itself was typed (`--json=1` is a flag, not that word)
    if a.raw.iter().any(|w| w == defaults::text("devswarm_cli.sr_json_word")) {
        return Ok(answer(0, report_value(&rep)));
    }
    Ok(Answer { code: 0, stdout: format!("{}\n", format_report(&rep)), effect: Effect::None })
}

// ---- sync-ui ------------------------------------------------------------------------------------------------------------

/// `normTitle(s)` of `companion/lib/devswarm-ui-sync.js`: NFKC, white space collapsed, a trailing ellipsis dropped, lower case.
fn norm_title(x: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let nf: String = x.nfkc().collect();
    let mut collapsed = String::new();
    let mut in_space = false;
    for c in nf.chars() {
        if crate::checks::guardkit::text::is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let mut t = js_trim(&collapsed).to_string();
    // `/\s*(?:…|\.\.\.)$/u`
    let ell = defaults::text("devswarm_cli.sui_ellipsis");
    let dots = defaults::text("devswarm_cli.sui_dots");
    let cut = t.strip_suffix(ell).or_else(|| t.strip_suffix(dots)).map(str::len);
    if let Some(len) = cut {
        t.truncate(len);
        t = js_trim(&t).to_string();
    }
    t.to_lowercase()
}

fn utf16_len(x: &str) -> usize {
    x.encode_utf16().count()
}

/// `titleMatches(shot, label)`.
fn title_matches(shot: &str, label: Option<&str>) -> bool {
    let a = norm_title(shot);
    let b = norm_title(label.unwrap_or_default());
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    let (short, long) = if utf16_len(&a) <= utf16_len(&b) { (&a, &b) } else { (&b, &a) };
    utf16_len(short) >= defaults::num("devswarm_cli.sui_min_prefix") as usize && long.starts_with(short.as_str())
}

fn rank_key(w: &snap::Ws) -> f64 {
    w.rank.unwrap_or(f64::INFINITY)
}

fn visible(w: &snap::Ws) -> bool {
    match w.is_hidden {
        None => !w.archived,
        Some(h) => !h,
    }
}

fn label_val(l: Option<&str>) -> OVal {
    l.map_or(OVal::Null, s)
}

fn str_list(items: &[String]) -> OVal {
    OVal::Arr(items.iter().map(|x| s(x)).collect())
}

/// `planUiSync({ titles, snapshot, repositoryId, descriptors, markers, names })`.
fn plan_ui_sync(
    titles: &[String],
    snapshot: Option<&snap::Snap>,
    repository_id: Option<&str>,
    descriptors: &[String],
    markers: &[String],
    names: &[(String, String)],
) -> OVal {
    let titles: Vec<&String> = titles.iter().filter(|t| !js_trim(t).is_empty()).collect();
    let mut out = Obj::default();
    let Some(sn) = snapshot else {
        out.put("appDb", OVal::Bool(false))
            .put("matched", OVal::Arr(vec![]))
            .put("ambiguous", OVal::Arr(vec![]))
            .put("unmatched", OVal::Arr(titles.iter().map(|t| s(t)).collect()))
            .put("toArchive", OVal::Arr(vec![]))
            .put("titleUpdates", OVal::Arr(vec![]))
            .put("conflicts", OVal::Arr(vec![]))
            .put("unknown", str_list(descriptors));
        return out.done();
    };
    let scoped: Vec<&snap::Ws> = sn
        .workspaces
        .iter()
        .filter(|w| {
            w.builder_type.as_deref() != Some(defaults::text("mesh_write.builder_type_primary"))
                && repository_id.is_none_or(|r| r.is_empty() || w.repository_id.as_deref() == Some(r))
        })
        .collect();
    let mut visible_by_rank: Vec<&snap::Ws> = scoped.iter().copied().filter(|w| visible(w)).collect();
    visible_by_rank.sort_by(|a, b| rank_key(a).partial_cmp(&rank_key(b)).unwrap_or(std::cmp::Ordering::Equal));
    let name_of = |id: &str| names.iter().find(|(k, _)| k == id).map(|(_, v)| v.as_str());
    let mut shown: Vec<&str> = Vec::new();
    let (mut matched, mut ambiguous, mut unmatched, mut title_updates, mut conflicts) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (pos, title) in titles.iter().enumerate() {
        let mut cands: Vec<&snap::Ws> = scoped.iter().copied().filter(|w| title_matches(title, w.label.as_deref())).collect();
        if cands.len() > 1 {
            let vis: Vec<&snap::Ws> = cands.iter().copied().filter(|w| visible(w)).collect();
            if !vis.is_empty() {
                cands = vis;
            }
        }
        if cands.len() > 1
            && let Some(by_pos) = visible_by_rank.get(pos)
            && cands.iter().any(|c| c.id == by_pos.id)
        {
            cands = vec![by_pos];
        }
        if cands.is_empty() {
            unmatched.push(s(title));
            continue;
        }
        if cands.len() > 1 {
            let list = cands
                .iter()
                .map(|c| {
                    let mut o = Obj::default();
                    o.put("id", s(&c.id)).put("label", label_val(c.label.as_deref())).put("rank", opt(c.rank));
                    o.done()
                })
                .collect();
            let mut o = Obj::default();
            o.put("title", s(title)).put("candidates", OVal::Arr(list));
            ambiguous.push(o.done());
            continue;
        }
        let w = cands[0];
        shown.push(&w.id);
        let mut m = Obj::default();
        m.put("title", s(title)).put("id", s(&w.id)).put("label", label_val(w.label.as_deref())).put("archivedInApp", OVal::Bool(w.archived));
        matched.push(m.done());
        if w.archived {
            let mut c = Obj::default();
            c.put("id", s(&w.id)).put("label", label_val(w.label.as_deref())).put("kind", s(defaults::text("devswarm_cli.sui_kind_visible_archived")));
            conflicts.push(c.done());
        }
        if let Some(l) = w.label.as_deref().filter(|l| !l.is_empty())
            && name_of(&w.id) != Some(l)
        {
            let mut u = Obj::default();
            u.put("id", s(&w.id))
                .put("from", name_of(&w.id).map_or(OVal::Null, s))
                .put("to", s(l))
                .put("truncatedAtSpawn", OVal::Bool(l.ends_with(defaults::text("devswarm_cli.sui_ellipsis"))));
            title_updates.push(u.done());
        }
    }
    let by_id = |id: &str| scoped.iter().copied().rev().find(|w| w.id == id);
    let mut to_archive = Vec::new();
    for id in descriptors {
        let Some(w) = by_id(id) else { continue };
        if w.archived && !shown.contains(&id.as_str()) && !markers.contains(id) {
            let mut a = Obj::default();
            a.put("id", s(id)).put("label", label_val(w.label.as_deref()));
            to_archive.push(a.done());
        }
    }
    let mut seen: Vec<&String> = Vec::new();
    for id in markers {
        if seen.contains(&id) {
            continue;
        }
        seen.push(id);
        if let Some(w) = by_id(id)
            && w.active
        {
            let mut c = Obj::default();
            c.put("id", s(&w.id)).put("label", label_val(w.label.as_deref())).put("kind", s(defaults::text("devswarm_cli.sui_kind_marker_active")));
            conflicts.push(c.done());
        }
    }
    out.put("appDb", OVal::Bool(true))
        .put("matched", OVal::Arr(matched))
        .put("ambiguous", OVal::Arr(ambiguous))
        .put("unmatched", OVal::Arr(unmatched))
        .put("toArchive", OVal::Arr(to_archive))
        .put("titleUpdates", OVal::Arr(title_updates))
        .put("conflicts", OVal::Arr(conflicts))
        .put("unknown", OVal::Arr(vec![]));
    out.done()
}

/// One snapshot-and-records gathering of `sync-ui` (`gather()`): `(snapshot, repositoryId, plan, table, descriptor ids)`.
#[allow(clippy::type_complexity)]
fn gather_ui(inv: &Inv, titles: &[String]) -> R<(Option<snap::Snap>, Option<String>, OVal, Vec<OVal>, Vec<asplan::Desc>)> {
    let file = crate::meshw::ident::app_db_path(&inv.home, &inv.env);
    let snapshot = match &file {
        Some(f) => snap::read(f)?,
        None => None,
    };
    let repository_id = match &snapshot {
        Some(sn) => {
            let main = crate::meshw::ident::resolve_context(&inv.cwd, false)?.main_worktree.unwrap_or_else(|| inv.cwd.clone());
            let resolved = crate::meshw::ident::resolve_abs(&main);
            let norm = crate::meshw::ident::realpath(&resolved).unwrap_or(resolved);
            let direct = sn.repositories.iter().find(|r| r.path.as_deref() == Some(norm.as_str()));
            match direct {
                Some(r) => Some(r.id.clone()),
                None => sn
                    .workspaces
                    .iter()
                    .find(|w| w.worktree_path.as_deref() == Some(norm.as_str()) && w.repository_id.as_deref().is_some_and(|x| !x.is_empty()))
                    .and_then(|w| w.repository_id.clone()),
            }
        }
        None => None,
    };
    let desc_rows = asplan::read_json_dir(&asplan::dir_of(&inv.home, "devswarm_sup.as_dir_workspaces"))?;
    let descriptors: Vec<String> = desc_rows.iter().map(|d| d.id.clone()).collect();
    let markers: Vec<String> = asplan::read_json_dir(&asplan::dir_of(&inv.home, "devswarm_sup.as_dir_archived"))?.into_iter().map(|d| d.id).collect();
    let mut names: Vec<(String, String)> = Vec::new();
    if let Some(sn) = &snapshot {
        for w in &sn.workspaces {
            if crate::meshw::idlock::is_safe_id(&w.id)
                && let Some(nm) = asstate::read_name(&inv.home, &w.id)
            {
                names.push((w.id.clone(), nm));
            }
        }
    }
    let plan = plan_ui_sync(titles, snapshot.as_ref(), repository_id.as_deref(), &descriptors, &markers, &names);
    let mut table: Vec<OVal> = Vec::new();
    if let Some(sn) = &snapshot {
        let mut rows: Vec<&snap::Ws> = sn
            .workspaces
            .iter()
            .filter(|w| {
                w.builder_type.as_deref() != Some(defaults::text("mesh_write.builder_type_primary"))
                    && repository_id.as_deref().is_none_or(|r| r.is_empty() || w.repository_id.as_deref() == Some(r))
                    && (w.active || descriptors.contains(&w.id))
            })
            .collect();
        rows.sort_by(|a, b| rank_key(a).partial_cmp(&rank_key(b)).unwrap_or(std::cmp::Ordering::Equal));
        for w in rows {
            let app = if w.archived {
                defaults::text("devswarm_cli.sui_app_archived")
            } else if w.active {
                defaults::text("devswarm_cli.sui_app_open")
            } else {
                defaults::text("devswarm_cli.sui_app_closed")
            };
            let anti = if markers.contains(&w.id) {
                defaults::text("devswarm_cli.sui_app_archived")
            } else if descriptors.contains(&w.id) {
                defaults::text("devswarm_cli.sui_ah_active")
            } else {
                defaults::text("devswarm_cli.sr_dash")
            };
            let cached = names.iter().find(|(k, _)| *k == w.id).map(|(_, v)| v.as_str());
            let mut o = Obj::default();
            o.put("id", s(&w.id))
                .put("title", label_val(w.label.as_deref()))
                .put("app", s(app))
                .put("antiHall", s(anti))
                .put("cachedName", cached.map_or(OVal::Null, s));
            table.push(o.done());
        }
    }
    Ok((snapshot, repository_id, plan, table, desc_rows))
}

/// `sync-ui` refuses with a message: `{ ok:false, action, error, ... }`, exit 2.
fn sui_refusal(fields: Vec<(&str, OVal)>) -> Answer {
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("action", s(defaults::text("devswarm_cli.sui_action")));
    for (k, v) in fields {
        o.put(k, v);
    }
    answer(2, o.done())
}

/// `sync-ui --titles-json F | --stdin [--yes] [--no-repair] [--accept-conflicts]` (`cmdSyncUi`, repair.js:903): the sidebar titles are
/// planned against the app database and the records; a dry run unless `--yes`, which writes the archived markers the plan proves
/// (never a delete) and, unless `--no-repair`, the names cache.
pub fn sync_ui(inv: &Inv, a: &Args) -> R<Answer> {
    let setting = defaults::raw("devswarm_cli.sui_setting_entry");
    if !crate::checks::guardkit::settings::get_bool(&inv.settings(), setting) {
        return Ok(sui_refusal(vec![("disabled", OVal::Bool(true)), ("error", s(defaults::text("devswarm_cli.sui_msg_disabled")))]));
    }
    let file = a.one(defaults::text("devswarm_cli.flag_titles_json")).filter(|f| !f.is_empty());
    let raw = match file {
        Some(f) => match std::fs::read(f) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(e) => {
                let why = crate::migrate::node_err(&e, defaults::text("mesh_write.hb_syscall_open"), Path::new(f));
                return Ok(sui_refusal(vec![("error", s(&defaults::render("devswarm_cli.sui_msg_cannot_read", &[("why", &why)])))]));
            }
        },
        None if a.has(defaults::text("devswarm_cli.flag_stdin")) => match &inv.stdin {
            Some(text) => text.clone(),
            None => {
                use std::io::Read;
                let mut buf = Vec::new();
                if let Err(e) = std::io::stdin().read_to_end(&mut buf) {
                    return Ok(sui_refusal(vec![("error", s(&defaults::render("devswarm_cli.sui_msg_cannot_read", &[("why", &e)])))]));
                }
                String::from_utf8_lossy(&buf).into_owned()
            }
        },
        None => return Ok(sui_refusal(vec![("error", s(defaults::text("devswarm_cli.sui_msg_needs_titles")))])),
    };
    let titles: Option<Vec<String>> = match OVal::parse(&raw) {
        Some(OVal::Arr(items)) => items.iter().map(|x| if let OVal::Str(t) = x { Some(t.clone()) } else { None }).collect(),
        Some(v @ OVal::Obj(_)) => match v.get("titles") {
            Some(OVal::Arr(items)) => items.iter().map(|x| if let OVal::Str(t) = x { Some(t.clone()) } else { None }).collect(),
            _ => None,
        },
        _ => None,
    };
    let Some(titles) = titles else { return Ok(sui_refusal(vec![("error", s(defaults::text("devswarm_cli.sui_msg_bad_titles")))])) };
    let apply = a.has(defaults::text("devswarm_cli.flag_yes"));
    let (snapshot, repository_id, plan, table, descriptors) = gather_ui(inv, &titles)?;
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.sui_action")))
        .put("dryRun", OVal::Bool(!apply))
        .put("appDb", OVal::Bool(snapshot.is_some()))
        .put("repositoryId", repository_id.as_deref().map_or(OVal::Null, s))
        .put("plan", plan.clone())
        .put("before", OVal::Arr(table));
    if !apply {
        return Ok(answer(0, o.done()));
    }
    let list = |key: &str| match plan.get(key) {
        Some(OVal::Arr(items)) => items.clone(),
        _ => Vec::new(),
    };
    let conflicts = list("conflicts");
    if !conflicts.is_empty() && !a.has(defaults::text("devswarm_cli.flag_accept_conflicts")) {
        o.put("ok", OVal::Bool(false))
            .put("reason", s(defaults::text("devswarm_cli.sui_reason_conflicts")))
            .put("error", s(&defaults::render("devswarm_cli.sui_msg_conflicts", &[("n", &conflicts.len())])));
        return Ok(answer(2, o.done()));
    }
    let now = inv.now;
    let (mut archived, mut renamed, mut errors): (Vec<OVal>, Vec<OVal>, Vec<OVal>) = (Vec::new(), Vec::new(), Vec::new());
    for item in list("toArchive") {
        let Some(OVal::Str(id)) = item.get("id") else { continue };
        let Some(desc) = descriptors.iter().find(|d| d.id == *id) else { continue };
        if !crate::meshw::idlock::is_safe_id(id) {
            continue;
        }
        match write_ui_marker(&inv.home, id, &desc.body, now) {
            Ok(true) => archived.push(s(id)),
            Ok(false) => {} // already there (EEXIST): left as it is
            Err(why) => {
                let mut e = Obj::default();
                e.put("id", s(id)).put("error", s(&why));
                errors.push(e.done());
            }
        }
    }
    if !a.has(defaults::text("devswarm_cli.flag_no_repair")) {
        for u in list("titleUpdates") {
            if let (Some(OVal::Str(id)), Some(OVal::Str(to))) = (u.get("id"), u.get("to"))
                && crate::meshw::idlock::is_safe_id(id)
                && asstate::write_name(&inv.home, id, to, now)
            {
                renamed.push(s(id));
            }
        }
    }
    let (_, _, after_plan, after_table, _) = gather_ui(inv, &titles)?;
    let mut diff = Obj::default();
    diff.put("archived", OVal::Arr(archived)).put("renamed", OVal::Arr(renamed)).put("errors", OVal::Arr(errors));
    o.put("after", OVal::Arr(after_table)).put("afterPlan", after_plan).put("diff", diff.done());
    Ok(answer(0, o.done()))
}

/// The archived marker of a descriptor the plan proves archived in the app: the descriptor with `archivedBy` and `archivedAt` set,
/// created exclusively (`wx`) so an existing marker is never replaced. `Ok(false)` when it already exists.
fn write_ui_marker(home: &Path, id: &str, body: &OVal, now: i64) -> Result<bool, String> {
    let dir = asplan::dir_of(home, "devswarm_sup.as_dir_archived");
    // `checkedArchivedDir(home, { create: true })`: a real directory, created when absent
    let st = match std::fs::symlink_metadata(&dir) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(&dir).map_err(|e| crate::migrate::node_err(&e, defaults::text("mesh_write.hb_syscall_mkdir"), &dir))?;
            std::fs::symlink_metadata(&dir).map_err(|e| crate::migrate::node_err(&e, defaults::text("devswarm_cli.sui_syscall_lstat"), &dir))?
        }
        Err(e) => return Err(crate::migrate::node_err(&e, defaults::text("devswarm_cli.sui_syscall_lstat"), &dir)),
    };
    if !st.is_dir() || st.file_type().is_symlink() {
        return Err(defaults::text("devswarm_sup.as_msg_archived_dir").to_string());
    }
    let mut marker = body.clone();
    marker.set("archivedBy", s(defaults::text("devswarm_cli.sui_archived_by")));
    marker.set("archivedAt", n(now as f64));
    let file = dir.join(format!("{id}{}", defaults::text("devswarm_sup.as_json_ext")));
    use std::io::Write;
    match std::fs::OpenOptions::new().write(true).create_new(true).open(&file) {
        Ok(mut f) => f
            .write_all(marker.stringify().as_bytes())
            .map(|()| true)
            .map_err(|e| crate::migrate::node_err(&e, defaults::text("devswarm_cli.sui_syscall_write"), &file)),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(crate::migrate::node_err(&e, defaults::text("mesh_write.hb_syscall_open"), &file)),
    }
}

// ---- retention ----------------------------------------------------------------------------------------------------------

/// `safeStoreName(h)`: `/^[A-Za-z0-9._-]{1,80}$/` and not a dotfile.
fn safe_store_name(h: &str) -> bool {
    (1..=defaults::num("devswarm_cli.ret_store_name_max") as usize).contains(&h.len())
        && h.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !h.starts_with('.')
}

/// `retention status | run [--dry-run] [--store X] | restore ...`: `status` and `run` as `ah-engine` does them under the duty's own
/// agreement with Node's planner (see [`crate::dssup::retention::cli`]); `restore` puts archived bodies back.
pub fn retention(inv: &Inv, a: &Args) -> R<Answer> {
    let sub = a.positionals.get(1).map(String::as_str);
    let t = |k: &str| defaults::text(k);
    // `root()` is empty only while no defaults are loaded, when no `defaults::text` above could have answered either
    let root = defaults::root().unwrap_or_default();
    let settings = inv.settings();
    let ctx = crate::dssup::tick::Ctx { home: &inv.home, root: &root, st: &settings, now: inv.now, engine_pokes: false };
    if sub == Some(t("devswarm_cli.ret_sub_status")) {
        let v = crate::dssup::retention::cli::status(&ctx)?;
        return Ok(answer(0, v));
    }
    if sub == Some(t("devswarm_cli.ret_sub_run")) {
        let store = a.one(t("devswarm_cli.ret_flag_store"));
        if store.is_some_and(|x| !x.is_empty() && !safe_store_name(x)) {
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false)).put("error", s(t("devswarm_cli.ret_msg_bad_store")));
            return Ok(answer(2, o.done()));
        }
        let dry = a.has(t("devswarm_cli.flag_dry_run"));
        let (ok, v) = crate::dssup::retention::cli::run(&ctx, &crate::dsact::runner::System::configured(), dry, store.filter(|x| !x.is_empty()))?;
        return Ok(answer(if ok { 0 } else { 2 }, v));
    }
    if sub == Some(t("devswarm_cli.ret_sub_restore")) {
        let (ok, v) = crate::dssup::retention::cli::restore(
            &ctx,
            a.one(t("devswarm_cli.ret_flag_store")).unwrap_or_default(),
            a.one(t("devswarm_cli.ret_flag_month")).unwrap_or_default(),
        )?;
        return Ok(answer(if ok { 0 } else { 2 }, v));
    }
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(false)).put("error", s(t("devswarm_cli.ret_msg_usage")));
    Ok(answer(2, o.done()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init() {
        defaults::init().unwrap();
    }

    #[test]
    fn rounding_is_javascripts_half_up() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(1.4), 1.0);
        assert_eq!(rate(1.0, 3.0), Some(0.33));
        assert_eq!(rate(2.0, 3.0), Some(0.67));
        assert_eq!(rate(1.0, 0.0), None);
    }

    #[test]
    fn the_median_is_the_lower_middle() {
        assert_eq!(median(&[]), None);
        assert_eq!(median(&[5.0]), Some(5.0));
        assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), Some(2.0));
        assert_eq!(median(&[9.0, 1.0, 5.0]), Some(5.0));
    }

    #[test]
    fn token_counts_print_like_the_node_formatter() {
        init();
        assert_eq!(fmt_tokens(900.0), "900");
        assert_eq!(fmt_tokens(420_000.0), "420k");
        assert_eq!(fmt_tokens(1_849_999.0), "1.8M");
        assert_eq!(fmt_tokens(2_500_000.0), "2.5M");
        assert_eq!(fmt_tokens(999.6), "1000");
    }

    #[test]
    fn titles_normalise_like_the_sidebar_matcher() {
        init();
        // an ellipsis is NFKC'd to three dots and then dropped; case and white space do not matter
        assert_eq!(norm_title("  Fix   THE gate\u{2026} "), "fix the gate");
        assert_eq!(norm_title("Fix the gate..."), "fix the gate");
        assert!(title_matches("Fix the gate\u{2026}", Some("Fix the gate and ship it")));
        assert!(!title_matches("short\u{2026}", Some("short title that is longer")), "a prefix needs twelve shared characters");
        assert!(title_matches("same", Some("SAME")));
        assert!(!title_matches("", Some("x")));
        assert!(!title_matches("x", None));
    }

    #[test]
    fn store_names_are_plain_keys() {
        init();
        assert!(safe_store_name("proj-abcdef"));
        assert!(!safe_store_name(".hidden"));
        assert!(!safe_store_name("a/b"));
        assert!(!safe_store_name(""));
        assert!(!safe_store_name(&"x".repeat(81)));
    }

    #[test]
    fn integer_like_keys_sort_first_and_proto_is_never_a_key() {
        init();
        let mut c = Counts::default();
        for k in ["beta", "10", "alpha", "2", "__proto__", "01"] {
            c.add(k, 1.0);
        }
        c.add("beta", 2.0);
        let keys: Vec<&str> = c.0.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, ["2", "10", "beta", "alpha", "01"], "array indexes first and ascending, the rest in insertion order, no __proto__");
        assert_eq!(c.get("beta"), 3.0);
        let mut r = Roll::default();
        r.jev_group(Some("7")).n = 1.0;
        r.jev_group(Some("x")).n = 1.0;
        r.jev_group(Some("3")).n = 1.0;
        r.jev_group(Some("__proto__")).n = 5.0;
        assert_eq!(r.jev.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(), ["3", "7", "x"]);
    }

    fn row(json: &str) -> OVal {
        OVal::parse(json).unwrap()
    }

    #[test]
    fn a_non_string_signal_or_id_is_the_key_its_text_names() {
        init();
        let rows = vec![
            row(r#"{"ts":"2026-10-01T10:00:00.000Z","type":"warn","signal":5}"#),
            row(r#"{"ts":"2026-10-01T10:00:01.000Z","type":"warn","signal":["a","b"]}"#),
            row(r#"{"ts":"2026-10-01T10:00:02.000Z","type":"tokens","tokens":10,"id":true}"#),
            row(r#"{"ts":"2026-10-01T10:00:03.000Z","type":"warn","signal":"__proto__"}"#),
        ];
        let days = build_daily(&rows).unwrap();
        assert_eq!(days.len(), 1);
        let d = &days[0].1;
        assert_eq!(d.warnings.0, vec![("5".to_string(), 1.0), ("a,b".to_string(), 1.0)]);
        assert_eq!(d.tokens_by_ws.0, vec![("true".to_string(), 10.0)]);
    }

    #[test]
    fn a_null_jev_note_is_nodes_type_error_and_an_unread_timestamp_is_skipped() {
        init();
        let err = build_daily(&[row(r#"{"ts":"2026-10-01T10:00:00.000Z","type":"correction","jev":[null]}"#)]).unwrap_err();
        assert_eq!(err.0, "Cannot read properties of null (reading 'integration')");
        let days = build_daily(&[row(r#"{"ts":"Oct 1 2026","type":"plan"}"#), row(r#"{"ts":"2026-10-01T10:00:00.000Z","type":"plan"}"#)]).unwrap();
        assert_eq!(days[0].1.plans, 1.0, "the legacy-format row is skipped, the ISO one counted");
    }

    #[test]
    fn a_rollup_with_text_in_a_number_field_is_skipped_and_a_numeric_boolean_adds() {
        init();
        assert!(roll_of_json(&row(r#"{"plans":"5"}"#)).is_none());
        assert!(roll_of_json(&row(r#"{"durationsMs":[1,"x"]}"#)).is_none());
        let r = roll_of_json(&row(r#"{"plans":true,"warnings":{"b":2,"3":1},"jev":{"x":{"n":2,"byMode":{"on":1}}}}"#)).unwrap();
        assert_eq!(r.plans, 1.0);
        assert_eq!(r.warnings.0, vec![("3".to_string(), 1.0), ("b".to_string(), 2.0)]);
        assert_eq!(r.jev[0].1.by_mode.get("on"), 1.0);
        let poisoned = roll_of_json(&row(r#"{"jev":{"x":null}}"#)).unwrap();
        assert_eq!(poisoned.poison.unwrap().0, "Cannot read properties of null (reading 'n')");
    }

    #[test]
    fn a_huge_generation_number_is_javascripts_number_and_text() {
        init();
        let dir = std::env::temp_dir().join(format!("ah-sr-gen-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&dir)); // keep: a stale directory of an earlier run
        std::fs::create_dir_all(&dir).unwrap();
        let big = "9".repeat(30);
        std::fs::write(dir.join(format!("log.{big}")), "x").unwrap();
        std::fs::write(dir.join("log.2"), "x").unwrap();
        let files = log_files(&dir, "log").unwrap();
        let names: Vec<String> = files.iter().map(|f| f.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(
            names,
            ["log.1e+30", "log.2"],
            "a generation JavaScript prints in exponent form names a file that does not exist; it is listed as Node lists it"
        );
    }

    fn scratch_inv(tag: &str) -> Inv {
        init();
        let home = std::env::temp_dir().join(format!("ah-sui-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: a stale directory of an earlier run of this test
        std::fs::create_dir_all(&home).unwrap();
        let mut env = std::collections::HashMap::new();
        env.insert(defaults::text("mesh_write.env_app_db").to_string(), defaults::text("mesh_write.app_db_off").to_string());
        Inv {
            home: home.clone(),
            write_home: home.clone(),
            env,
            cwd: home.to_string_lossy().into_owned(),
            now: 1_700_000_000_000,
            stdin: None,
            store_override: None,
        }
    }

    fn sync(inv: &Inv, words: &[&str]) -> (i32, OVal) {
        let argv: Vec<String> = words.iter().map(|w| w.to_string()).collect();
        let ans = sync_ui(inv, &crate::meshw::args::parse(&argv)).unwrap();
        (ans.code, OVal::parse(ans.stdout.trim()).unwrap())
    }

    #[test]
    fn sync_ui_answers_every_input_natively() {
        let inv = scratch_inv("inputs");
        // no titles at all
        let (code, v) = sync(&inv, &["sync-ui"]);
        assert_eq!(code, 2);
        assert!(matches!(v.get("error"), Some(OVal::Str(e)) if e.starts_with("sync-ui needs --titles-json")));
        // a titles file that cannot be read: Node's own error text
        let missing = inv.home.join("nope.json");
        let (code, v) = sync(&inv, &["sync-ui", "--titles-json", &missing.to_string_lossy()]);
        assert_eq!(code, 2);
        assert!(
            matches!(v.get("error"), Some(OVal::Str(e)) if e.starts_with("cannot read titles: ENOENT: no such file or directory, open")),
            "{}",
            v.stringify()
        );
        // titles on stdin
        let mut piped = inv.clone();
        piped.stdin = Some(r#"["One","Two"]"#.to_string());
        let (code, v) = sync(&piped, &["sync-ui", "--stdin"]);
        assert_eq!(code, 0);
        assert_eq!(v.get("dryRun"), Some(&OVal::Bool(true)));
        // the switch off: nothing is read or changed
        let ah = inv.home.join(defaults::text("mesh_write.dir_anti_hall"));
        std::fs::create_dir_all(&ah).unwrap();
        std::fs::write(ah.join("settings.json"), r#"{"devswarm":{"screenshotSync":false}}"#).unwrap();
        let (code, v) = sync(&piped, &["sync-ui", "--stdin"]);
        assert_eq!(code, 2);
        assert_eq!(v.get("disabled"), Some(&OVal::Bool(true)));
    }

    #[test]
    fn an_applied_sync_without_an_app_database_changes_nothing_and_reports_it() {
        let mut inv = scratch_inv("apply");
        inv.stdin = Some(r#"{"titles":["Fix the gate"]}"#.to_string());
        let (code, v) = sync(&inv, &["sync-ui", "--stdin", "--yes"]);
        assert_eq!(code, 0);
        assert_eq!(v.get("dryRun"), Some(&OVal::Bool(false)));
        assert_eq!(v.get("diff").map(OVal::stringify).as_deref(), Some(r#"{"archived":[],"renamed":[],"errors":[]}"#));
    }

    #[test]
    fn an_archived_marker_is_the_descriptor_stamped_and_never_replaced() {
        let inv = scratch_inv("marker");
        let body = OVal::parse(r#"{"id":"w1","worktreePath":"/w/1"}"#).unwrap();
        assert_eq!(write_ui_marker(&inv.home, "w1", &body, 42), Ok(true));
        let file = asplan::dir_of(&inv.home, "devswarm_sup.as_dir_archived").join("w1.json");
        assert_eq!(std::fs::read_to_string(&file).unwrap(), r#"{"id":"w1","worktreePath":"/w/1","archivedBy":"devswarm-ui-sync","archivedAt":42}"#);
        assert_eq!(write_ui_marker(&inv.home, "w1", &body, 99), Ok(false), "an existing marker is left as it is");
        assert!(std::fs::read_to_string(&file).unwrap().contains("42"));
    }
}
