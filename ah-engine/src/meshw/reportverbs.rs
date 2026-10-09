//! `supervision-report [--days N] [--json]` (lane l8c), ported from `companion/lib/devswarm-supervision-metrics.js`
//! (`report`, `buildDailyRollups`, `formatReport`) and `companion/lib/devswarm-token-usage.js` `fmt`.
//!
//! A pure read: the raw supervision log (`devswarm-supervision.ndjson` and its numbered generations) is aggregated per UTC day,
//! merged with the daily rollup files of older days, and printed as the report object or as the text table.
//!
//! Node's JavaScript semantics are kept where a log or rollup file can hold something unexpected; whatever the engine cannot
//! treat exactly like JavaScript is a [`Defer`] (Node then prints it): a timestamp `Date.parse` may read in a way the engine
//! does not know, a key that JavaScript orders or treats specially (an integer-like name, `__proto__`), a rollup field that is
//! not the number or list the sums expect, a `null` where Node would throw.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an unreadable optional file is the same as an absent one (fail-open, as Node's try/catch)
// A failure that must be seen goes through `crate::discard` instead.
use crate::checks::guardkit::ojson::{OVal, is_array_index_key};
use crate::checks::jsport::num::to_js_string;
use crate::checks::guardkit::text::{js_number_of_str, js_trim};
use crate::checks::jsport::date::{self, Parsed};
use crate::defaults;
use crate::dssup::appsync::{plan as asplan, snap, state as asstate};
use crate::meshw::args::Args;
use crate::meshw::common::{Inv, Obj, n, s};
use crate::meshw::ident::{R, defer};
use crate::meshw::send::{Answer, Effect};
use std::path::Path;

fn answer(code: i32, v: OVal) -> Answer {
    Answer { code, stdout: format!("{}\n", v.stringify()), effect: Effect::None }
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

/// A name that JavaScript would order before the others in an object, or treat as the prototype.
fn odd_key(k: &str) -> bool {
    is_array_index_key(k) || k == defaults::text("devswarm_cli.sr_proto_key")
}

/// An ordered counter map (`obj[k] = (obj[k] || 0) + by`).
#[derive(Debug, Clone, Default)]
struct Counts(Vec<(String, f64)>);

impl Counts {
    fn add(&mut self, k: &str, by: f64) -> R<()> {
        if odd_key(k) {
            return defer("report-key");
        }
        match self.0.iter_mut().find(|(x, _)| x == k) {
            Some(slot) => slot.1 += by,
            None => self.0.push((k.to_string(), by)),
        }
        Ok(())
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
struct Roll {
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
}

impl Roll {
    fn jev_group(&mut self, integration: Option<&str>) -> R<&mut Jev> {
        let k = integration.filter(|x| !x.is_empty()).unwrap_or(defaults::text("devswarm_cli.sr_unknown"));
        if odd_key(k) {
            return defer("report-key");
        }
        let i = match self.jev.iter().position(|(x, _)| x == k) {
            Some(i) => i,
            None => {
                self.jev.push((k.to_string(), Jev::default()));
                self.jev.len() - 1
            }
        };
        Ok(&mut self.jev[i].1)
    }
}

fn finite(v: Option<&OVal>) -> Option<f64> {
    match v {
        Some(OVal::Num(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `r.x` as a string, `None` when it is absent, falsy, or (the case that needs JavaScript's conversion) not a string.
fn text_of(v: Option<&OVal>) -> R<Option<String>> {
    match v {
        None | Some(OVal::Null) => Ok(None),
        Some(OVal::Str(x)) => Ok((!x.is_empty()).then(|| x.clone())),
        Some(x) if !x.truthy() => Ok(None),
        Some(_) => defer("report-field"),
    }
}

/// The `jev` array of a row: `(integration, supports)` per element; a `null` element makes Node throw.
fn jev_notes(v: Option<&OVal>) -> R<Vec<(Option<String>, bool)>> {
    let Some(OVal::Arr(items)) = v else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for it in items {
        match it {
            OVal::Null => return defer("report-null"),
            OVal::Obj(_) => out.push((text_of(it.get("integration"))?, it.get("supports").is_some_and(OVal::truthy))),
            _ => out.push((None, false)),
        }
    }
    Ok(out)
}

fn includes(v: Option<&OVal>, word: &str) -> bool {
    matches!(v, Some(OVal::Arr(a)) if a.iter().any(|x| matches!(x, OVal::Str(t) if t == word)))
}

/// `buildDailyRollups(rows)`: per UTC day, in order of first appearance.
fn build_daily(rows: &[OVal]) -> R<Vec<(String, Roll)>> {
    let mut days: Vec<(String, Roll)> = Vec::new();
    let t = |k: &str| defaults::text(k);
    for r in rows {
        let Some(OVal::Str(ts)) = r.get("ts") else { continue };
        let ms = match date::parse(ts) {
            Parsed::Ms(ms) => ms,
            Parsed::Nan => continue,
            Parsed::Unknown => return defer("report-ts"),
        };
        if !ms.is_finite() {
            continue;
        }
        let Some(iso) = date::to_iso(ms) else { return defer("report-ts") };
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
            let sig = text_of(r.get("signal"))?.unwrap_or_else(|| t("devswarm_cli.sr_unknown").to_string());
            d.warnings.add(&sig, 1.0)?;
            if r.get("repeat").is_some_and(OVal::truthy) {
                d.repeats += 1.0;
            }
        } else if ty == t("devswarm_cli.sr_t_correction") {
            d.corrections += 1.0;
            if includes(r.get("signals"), t("devswarm_cli.sr_burn")) {
                d.burn_corrections += 1.0;
            }
            for (integration, supports) in jev_notes(r.get("jev"))? {
                let g = d.jev_group(integration.as_deref())?;
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
                let g = d.jev_group(integration.as_deref())?;
                if supports {
                    g.progress_supported += 1.0;
                } else {
                    g.progress_not += 1.0;
                }
            }
        } else if ty == t("devswarm_cli.sr_t_tokens") {
            if let Some(tok) = finite(r.get("tokens")) {
                d.token_periods.push(tok);
                let id = match r.get("id") {
                    None | Some(OVal::Null) => t("devswarm_cli.sr_unknown").to_string(),
                    Some(OVal::Str(x)) if !x.is_empty() => x.clone(),
                    Some(x) if !x.truthy() => t("devswarm_cli.sr_unknown").to_string(),
                    Some(_) => return defer("report-field"),
                };
                d.tokens_by_ws.add(&id, tok)?;
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
            let integration = text_of(r.get("integration"))?;
            let agree = matches!(r.get("agree"), Some(OVal::Bool(true)));
            let mode = text_of(r.get("mode"))?.unwrap_or_else(|| t("devswarm_cli.sr_unknown").to_string());
            let g = d.jev_group(integration.as_deref())?;
            g.n += 1.0;
            if agree {
                g.agree += 1.0;
            }
            g.by_mode.add(&mode, 1.0)?;
        }
    }
    Ok(days)
}

/// A rollup field the sums add: `r.x || 0`, which must be a number (a string would concatenate).
fn num0(v: Option<&OVal>) -> R<f64> {
    match v {
        None | Some(OVal::Null) => Ok(0.0),
        Some(OVal::Num(x)) => Ok(if x.is_nan() { 0.0 } else { *x }),
        Some(x) if !x.truthy() => Ok(0.0),
        Some(_) => defer("report-field"),
    }
}

/// A list field of a rollup file whose elements are all numbers (or absent).
fn num_list(v: Option<&OVal>) -> R<Vec<f64>> {
    match v {
        Some(OVal::Arr(a)) => a
            .iter()
            .map(|x| match x {
                OVal::Num(f) if f.is_finite() => Ok(*f),
                _ => defer("report-field"),
            })
            .collect(),
        _ => Ok(Vec::new()),
    }
}

/// A map field of a rollup file: name -> number, all numbers.
fn num_map(v: Option<&OVal>) -> R<Counts> {
    let mut out = Counts::default();
    match v {
        None | Some(OVal::Null) => {}
        Some(OVal::Obj(o)) => {
            for (k, x) in o {
                out.add(k, num0(Some(x))?)?;
            }
        }
        Some(x) if !x.truthy() => {}
        Some(_) => return defer("report-field"),
    }
    Ok(out)
}

/// A rollup file's content as a [`Roll`] (JavaScript reads missing fields as 0 / empty).
fn roll_of_json(v: &OVal) -> R<Roll> {
    let mut r = Roll::default();
    if matches!(v, OVal::Null) {
        return defer("report-null");
    }
    if !matches!(v, OVal::Obj(_)) {
        return Ok(r);
    }
    let f = |k: &str| v.get(k);
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
    match f("jev") {
        None | Some(OVal::Null) => {}
        Some(OVal::Obj(o)) => {
            for (k, g) in o {
                if !matches!(g, OVal::Obj(_)) && !matches!(g, OVal::Num(_) | OVal::Bool(_) | OVal::Str(_)) {
                    return defer("report-field");
                }
                let slot = r.jev_group(Some(k))?;
                slot.n = num0(g.get("n"))?;
                slot.agree = num0(g.get("agree"))?;
                slot.followed = num0(g.get("followed"))?;
                slot.overridden = num0(g.get("overridden"))?;
                slot.progress_supported = num0(g.get("progressWhenSupported"))?;
                slot.progress_not = num0(g.get("progressWhenNotSupported"))?;
                slot.by_mode = num_map(g.get("byMode"))?;
            }
        }
        Some(x) if !x.truthy() => {}
        Some(_) => return defer("report-field"),
    }
    Ok(r)
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
fn log_files(dir: &Path, base: &str) -> R<Vec<std::path::PathBuf>> {
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
            // a generation number JavaScript would print in exponent form is not reproduced
            if rest.len() > defaults::num("devswarm_cli.sr_gen_digits_max") as usize {
                return defer("report-generation");
            }
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
fn read_rows(files: &[std::path::PathBuf]) -> Vec<OVal> {
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

fn gather(inv: &Inv, days_in: f64) -> R<Report> {
    let days = if days_in.is_finite() && days_in >= 1.0 { days_in.floor() } else { 7.0 };
    let now = inv.now as f64;
    let start = now - (days - 1.0) * 86_400_000.0;
    let Some(iso) = date::to_iso(start) else { return defer("report-since") };
    let since = iso.chars().take(defaults::num("devswarm_cli.sr_day_chars") as usize).collect::<String>();
    // a year outside 0000-9999 is printed with a sign: not reproduced
    if iso.starts_with(['+', '-']) {
        return defer("report-since");
    }
    let logs = inv.home.join(defaults::text("mesh_write.dir_anti_hall")).join(defaults::text("mesh_write.dir_logs"));
    let daily_dir = logs.join(defaults::text("devswarm_cli.sr_daily_dir"));
    let mut by_day: Vec<(String, Roll)> = Vec::new();
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
            let roll = roll_of_json(&v)?;
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
                Some(slot) => slot.1 = r,
                None => by_day.push((day, r)),
            }
        }
    }
    let mut t = Roll::default();
    for (_, r) in &by_day {
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
            t.tokens_by_ws.add(k, *v)?;
        }
        for (k, v) in &r.warnings.0 {
            t.warnings.add(k, *v)?;
        }
        for (k, g) in &r.jev {
            let a = t.jev_group(Some(k))?;
            a.n += g.n;
            a.agree += g.agree;
            a.followed += g.followed;
            a.overridden += g.overridden;
            a.progress_supported += g.progress_supported;
            a.progress_not += g.progress_not;
            for (m, c) in &g.by_mode.0 {
                a.by_mode.add(m, *c)?;
            }
        }
    }
    Ok(Report { days, since, days_with_data: by_day.len(), t })
}

fn counts_obj(c: &Counts) -> OVal {
    OVal::Obj(c.0.iter().map(|(k, v)| (k.clone(), n(*v))).collect())
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
    let rep = gather(inv, days)?;
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

/// Whether `devswarm.screenshotSync` could be anything but its default (on): any tier that might name it sends the verb to Node.
fn screenshot_setting_untouched(inv: &Inv) -> bool {
    let squash = |x: &str| x.to_ascii_lowercase().replace(['_', '-'], "");
    let needle = squash(defaults::text("devswarm_cli.sui_setting_word"));
    if inv.env.keys().any(|k| squash(k).contains(&needle)) {
        return false;
    }
    let ah = inv.home.join(defaults::text("mesh_write.dir_anti_hall"));
    for f in defaults::list("devswarm_cli.sui_setting_files") {
        if let Ok(b) = std::fs::read(ah.join(f))
            && squash(&String::from_utf8_lossy(&b)).contains(&needle)
        {
            return false;
        }
    }
    true
}

/// One snapshot-and-records gathering of `sync-ui` (`gather()`): `(snapshot, repositoryId, plan, table, descriptor ids)`.
#[allow(clippy::type_complexity)]
fn gather_ui(inv: &Inv, titles: &[String]) -> R<(Option<snap::Snap>, Option<String>, OVal, Vec<OVal>)> {
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
    let descriptors: Vec<String> = asplan::read_json_dir(&asplan::dir_of(&inv.home, "devswarm_sup.as_dir_workspaces"))?.into_iter().map(|d| d.id).collect();
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
    Ok((snapshot, repository_id, plan, table))
}

/// `sync-ui --titles-json F [--yes ...]`: the dry run. Applying the plan (archived markers, the names cache) is Node's.
pub fn sync_ui(inv: &Inv, a: &Args) -> R<Answer> {
    if !screenshot_setting_untouched(inv) {
        return defer("screenshot-setting");
    }
    let file = a.one(defaults::text("devswarm_cli.flag_titles_json")).filter(|f| !f.is_empty());
    let raw = match file {
        Some(f) => match std::fs::read(f) {
            Ok(b) => String::from_utf8_lossy(&b).into_owned(),
            Err(_) => return defer("titles-file"),
        },
        None if a.has(defaults::text("devswarm_cli.flag_stdin")) => return defer("titles-stdin"),
        None => {
            let mut o = Obj::default();
            o.put("ok", OVal::Bool(false))
                .put("action", s(defaults::text("devswarm_cli.sui_action")))
                .put("error", s(defaults::text("devswarm_cli.sui_msg_needs_titles")));
            return Ok(answer(2, o.done()));
        }
    };
    let titles: Option<Vec<String>> = match OVal::parse(&raw) {
        Some(OVal::Arr(items)) => items.iter().map(|x| if let OVal::Str(t) = x { Some(t.clone()) } else { None }).collect(),
        Some(v @ OVal::Obj(_)) => match v.get("titles") {
            Some(OVal::Arr(items)) => items.iter().map(|x| if let OVal::Str(t) = x { Some(t.clone()) } else { None }).collect(),
            _ => None,
        },
        _ => None,
    };
    let Some(titles) = titles else {
        let mut o = Obj::default();
        o.put("ok", OVal::Bool(false))
            .put("action", s(defaults::text("devswarm_cli.sui_action")))
            .put("error", s(defaults::text("devswarm_cli.sui_msg_bad_titles")));
        return Ok(answer(2, o.done()));
    };
    if a.has(defaults::text("devswarm_cli.flag_yes")) {
        return defer("apply");
    }
    let (snapshot, repository_id, plan, table) = gather_ui(inv, &titles)?;
    let mut o = Obj::default();
    o.put("ok", OVal::Bool(true))
        .put("action", s(defaults::text("devswarm_cli.sui_action")))
        .put("dryRun", OVal::Bool(true))
        .put("appDb", OVal::Bool(snapshot.is_some()))
        .put("repositoryId", repository_id.as_deref().map_or(OVal::Null, s))
        .put("plan", plan)
        .put("before", OVal::Arr(table));
    Ok(answer(0, o.done()))
}

// ---- retention ----------------------------------------------------------------------------------------------------------

/// `safeStoreName(h)`: `/^[A-Za-z0-9._-]{1,80}$/` and not a dotfile.
fn safe_store_name(h: &str) -> bool {
    (1..=defaults::num("devswarm_cli.ret_store_name_max") as usize).contains(&h.len())
        && h.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && !h.starts_with('.')
}

/// `retention status | run [--dry-run] [--store X] | restore ...`: `status` and `run` as `ah-engine` does them under the duty's own
/// agreement with Node's planner (see [`crate::dssup::retention::cli`]); `restore` is Node's.
pub fn retention(inv: &Inv, a: &Args) -> R<Answer> {
    let sub = a.positionals.get(1).map(String::as_str);
    let t = |k: &str| defaults::text(k);
    let Some(root) = defaults::root() else { return defer("no-plugin-root") };
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
        return defer("restore");
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
    fn odd_keys_are_the_ones_javascript_orders_or_treats_specially() {
        init();
        assert!(odd_key("0"));
        assert!(odd_key("12"));
        assert!(odd_key("__proto__"));
        assert!(!odd_key("ws-a"));
        assert!(!odd_key("01"));
    }
}
