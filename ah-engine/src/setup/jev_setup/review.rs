//! `jev-setup review-due`, `reviewed` and `snooze`: the durable "time to review the Jev shadow numbers" tracking. Port of
//! `hooks/lib/jev-review.js` as `scripts/jev-setup.js` drives it. State: `~/.anti-hall/jev-review-state.json`, one entry per
//! integration (`shadowSince`, `lastReviewedAt`, `snoozedUntil`, `dueSince`); metrics: `~/.anti-hall/logs/jev-review.ndjson`.
//! A review is due for a shadow integration when it has been in shadow for `jev.reviewAfterDays`, has logged at least
//! `jev.reviewMinDecisions` decisions, is not snoozed and was not reviewed within the last `jev.reviewAfterDays`. Every number,
//! name and text is in `operator_cli.toml`.
use super::{Ctx, SetupError, base_dir, jev_json_path, key, parse_json, read_object, resolve_settings, write_json_atomic};
use crate::checks::jsport::date::{self, Parsed};
use crate::checks::jsport::json::{J, stringify};
use crate::checks::jsport::num::to_js_string;
use crate::defaults;
use crate::setup::jsfmt::keys;
use crate::setup::{out, read_capped, text_of, warn};
use std::io::Write;
use std::path::{Path, PathBuf};

type Obj = Vec<(String, J)>;

fn k(name: &str) -> &'static str {
    defaults::raw("opcli.review_keys").str_field(name)
}

fn num_of(key_name: &str) -> f64 {
    defaults::num(key_name) as f64
}

/// JavaScript truthiness of an optional JSON value.
fn truthy(v: Option<&J>) -> bool {
    match v {
        Some(J::Str(s)) => !s.is_empty(),
        Some(J::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(J::Bool(b)) => *b,
        Some(J::Arr(_) | J::Obj(_)) => true,
        Some(J::Null) | None => false,
    }
}

fn iso(ms: f64) -> String {
    crate::jev::assist::iso_ms(ms.max(0.0) as u64)
}

/// `Date.parse` of a stored text when it is a date this tool reads, else `None` (a text whose JavaScript answer is not
/// reproduced counts as no date, like `NaN`).
fn date_ms(s: &str) -> Option<f64> {
    match date::parse(s) {
        Parsed::Ms(ms) if ms.is_finite() => Some(ms),
        _ => None,
    }
}

fn set(o: &mut Obj, name: &str, v: J) {
    match o.iter_mut().find(|(n, _)| n == name) {
        Some(slot) => slot.1 = v,
        None => o.push((name.to_string(), v)),
    }
}

fn str_of<'a>(o: &'a Obj, name: &str) -> Option<&'a str> {
    match o.iter().find(|(n, _)| n == name) {
        Some((_, J::Str(s))) => Some(s),
        _ => None,
    }
}

// ---- state ---------------------------------------------------------------------------------------------------------------

struct State {
    path: PathBuf,
    /// The whole state object (members this tool does not know are kept, in order).
    top: Obj,
}

impl State {
    fn read(home: &Path) -> State {
        let path = base_dir(home).join(defaults::text("opcli.review_state_file"));
        let parsed = match read_capped(&path) {
            Ok(Some(b)) => parse_json(&text_of(b)).ok(),
            _ => None,
        };
        let mut top = match parsed {
            Some(J::Obj(o)) => o,
            _ => Vec::new(),
        };
        if !matches!(top.iter().find(|(n, _)| n == k("integrations")), Some((_, J::Obj(_)))) {
            set(&mut top, k("integrations"), J::Obj(Vec::new()));
        }
        State { path, top }
    }

    fn integrations(&mut self) -> &mut Obj {
        let idx = match self.top.iter().position(|(n, _)| n == k("integrations")) {
            Some(idx) => idx,
            None => {
                self.top.push((k("integrations").to_string(), J::Obj(Vec::new())));
                self.top.len() - 1
            }
        };
        if !matches!(self.top[idx].1, J::Obj(_)) {
            self.top[idx].1 = J::Obj(Vec::new());
        }
        match &mut self.top[idx].1 {
            J::Obj(o) => o,
            _ => std::process::abort(),
        }
    }

    /// The entry of `id`, created empty when absent; an entry that is not an object cannot be updated.
    fn entry(&mut self, id: &str) -> Result<&mut Obj, String> {
        let ints = self.integrations();
        if !ints.iter().any(|(n, _)| n == id) {
            ints.push((id.to_string(), J::Obj(Vec::new())));
        }
        match ints.iter_mut().find(|(n, _)| n == id) {
            Some((_, J::Obj(o))) => Ok(o),
            _ => Err(defaults::render("opcli.review_state_bad", &[("id", &id)])),
        }
    }

    /// Best effort, as in Node: a failure is said on stderr and the verb goes on.
    fn write(&self) {
        let result = (|| -> Result<(), SetupError> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir).map_err(crate::setup::io_err(defaults::text("setup.what_create_dir").to_string()))?;
            }
            write_json_atomic(&self.path, J::Obj(self.top.clone()))
        })();
        if let Err(e) = result {
            warn(&defaults::render("opcli.review_write_failed", &[("error", &e)]));
        }
    }
}

fn append_metric(home: &Path, row: Obj) {
    let path = base_dir(home).join(defaults::text("opcli.review_metrics_file"));
    let mut o: Obj = vec![(k("ts").to_string(), J::Str(iso(date::now_ms())))];
    o.extend(row);
    let line = stringify(&J::Obj(o)) + "\n";
    let done = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|()| std::fs::OpenOptions::new().create(true).append(true).open(&path))
        .and_then(|mut f| f.write_all(line.as_bytes()));
    if let Err(e) = done {
        warn(&defaults::render("opcli.review_write_failed", &[("error", &e)]));
    }
}

// ---- decisions -------------------------------------------------------------------------------------------------------------

/// The decision rows of the log's retained generations: objects with an id and no type.
fn decision_rows(home: &Path) -> Vec<J> {
    let mut rows = Vec::new();
    for f in crate::jev::report::retained(&base_dir(home).join(defaults::text("jev.log_file"))) {
        let Ok(bytes) = std::fs::read(&f) else { continue };
        for line in String::from_utf8_lossy(&bytes).split('\n') {
            let t = crate::jev::js_trim(line);
            if t.is_empty() {
                continue;
            }
            if let Ok(row @ J::Obj(_)) = parse_json(t)
                && truthy(row.get(k("id")))
                && !truthy(row.get(k("type")))
            {
                rows.push(row);
            }
        }
    }
    rows
}

/// The daily rollups: objects with a text day and a list of groups, in file-name order.
fn rollups(home: &Path) -> Vec<J> {
    let dir = base_dir(home).join(defaults::text("jevrep.rollup_dir"));
    let Ok(re) = regex::Regex::new(defaults::text("jevrep.rollup_name_re")) else { return Vec::new() };
    let Ok(rd) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut names: Vec<String> = rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| re.is_match(n)).collect();
    names.sort();
    names
        .iter()
        .filter_map(|n| std::fs::read(dir.join(n)).ok())
        .filter_map(|b| parse_json(&String::from_utf8_lossy(&b)).ok())
        .filter(|r| matches!(r.get(k("day")), Some(J::Str(_))) && matches!(r.get(k("groups")), Some(J::Arr(_))))
        .collect()
}

struct Evidence {
    rows: Vec<J>,
    rollups: Vec<J>,
}

/// `idStats`: the decisions logged for `id` (raw rows plus the days only a rollup still covers) and the earliest instant.
fn id_stats(ev: &Evidence, id: &str) -> (f64, Option<f64>) {
    let mine: Vec<&J> = ev.rows.iter().filter(|r| matches!(r.get(k("id")), Some(J::Str(s)) if s == id)).collect();
    let mut decisions = mine.len() as f64;
    let mut oldest_raw = f64::INFINITY;
    let mut earliest = f64::INFINITY;
    for r in &mine {
        if let Some(J::Str(ts)) = r.get(k("ts"))
            && let Some(t) = date_ms(ts)
        {
            oldest_raw = oldest_raw.min(t);
            earliest = earliest.min(t);
        }
    }
    for rollup in &ev.rollups {
        let Some(J::Str(day)) = rollup.get(k("day")) else { continue };
        let Some(start) = date_ms(&format!("{day}{}", defaults::text("opcli.review_rollup_midnight"))) else { continue };
        if start + num_of("opcli.review_day_ms") > oldest_raw {
            continue; // covered by raw rows already
        }
        let Some(J::Arr(groups)) = rollup.get(k("groups")) else { continue };
        for g in groups {
            if !matches!(g.get(k("id")), Some(J::Str(s)) if s == id) {
                continue;
            }
            if let Some(J::Num(n)) = g.get(k("n"))
                && *n != 0.0
                && !n.is_nan()
            {
                decisions += n;
            }
            earliest = earliest.min(start);
        }
    }
    (decisions, earliest.is_finite().then_some(earliest))
}

// ---- review-due ---------------------------------------------------------------------------------------------------------

/// `Number(jev.<name>)` of the settings store, as text first (so a zero or an empty value reads as such).
fn setting_number(name: &str, default_text: &str) -> f64 {
    let text = crate::ops::settings::effective_text("jev", name, default_text).unwrap_or_else(|| default_text.to_string());
    crate::checks::guardkit::text::js_number_of_str(&text)
}

struct Due {
    id: String,
    days: f64,
    decisions: f64,
}

struct Computed {
    due: Vec<Due>,
    after: f64,
    min: f64,
}

fn compute_review_due(cx: &Ctx) -> Result<Computed, String> {
    let now = date::now_ms();
    let after = match setting_number("reviewAfterDays", &to_js_string(num_of("opcli.review_after_days_default"))) {
        n if n == 0.0 || n.is_nan() => num_of("opcli.review_after_days_default"),
        n => n,
    };
    let min = match setting_number("reviewMinDecisions", &to_js_string(num_of("opcli.review_min_decisions_default"))) {
        n if n.is_finite() => n,
        _ => num_of("opcli.review_min_decisions_default"),
    };
    let window = after * num_of("opcli.review_day_ms");

    let s = resolve_settings(cx);
    let legacy = read_object(&jev_json_path(&cx.home));
    // the settings registry lists the integrations in the order the Node schema does
    let mut ids: Vec<String> =
        crate::migrate::settings::entries().iter().filter(|e| e.section == key("integrations_section")).map(|e| e.key.to_string()).collect();
    for id in keys(legacy.get(key("legacy_integrations")).unwrap_or(&J::Null)) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.retain(|id| s.mode(id, false).as_str() == defaults::text("opcli.review_mode_shadow"));

    let ev = Evidence { rows: decision_rows(&cx.home), rollups: rollups(&cx.home) };
    let mut state = State::read(&cx.home);
    let mut due = Vec::new();
    for id in &ids {
        let entry = state.entry(id)?;
        let since = match str_of(entry, k("shadow_since")).filter(|v| !v.is_empty()) {
            Some(v) => v.to_string(),
            None => {
                let derived = id_stats(&ev, id).1.map_or_else(|| iso(now), iso);
                set(entry, k("shadow_since"), J::Str(derived.clone()));
                derived
            }
        };
        let days = date_ms(&since).map_or(0.0, |ms| (now - ms) / num_of("opcli.review_day_ms"));
        let (decisions, _) = id_stats(&ev, id);
        let snoozed = str_of(entry, k("snoozed_until")).and_then(date_ms).is_some_and(|t| t > now);
        let reviewed_recently = str_of(entry, k("last_reviewed")).and_then(date_ms).is_some_and(|t| now - t < window);
        let is_due = days >= after && decisions >= min && !snoozed && !reviewed_recently;
        if is_due {
            if !truthy(entry.iter().find(|(n, _)| n == k("due_since")).map(|(_, v)| v)) {
                set(entry, k("due_since"), J::Str(iso(now)));
            }
            due.push(Due { id: id.clone(), days: days.floor(), decisions });
        } else if truthy(entry.iter().find(|(n, _)| n == k("due_since")).map(|(_, v)| v)) {
            set(entry, k("due_since"), J::Null);
        }
    }
    if !ids.is_empty() {
        state.write();
    }
    Ok(Computed { due, after, min })
}

pub(super) fn cmd_review_due(cx: &mut Ctx, positional: &[String]) -> Result<(), SetupError> {
    let r = match compute_review_due(cx) {
        Ok(r) => r,
        Err(msg) => {
            cx.fail(&msg);
            return Ok(());
        }
    };
    if positional.iter().any(|a| a == defaults::text("opcli.review_json_flag")) {
        let rows: Vec<J> = r
            .due
            .iter()
            .map(|d| {
                J::Obj(vec![
                    (k("id").to_string(), J::Str(d.id.clone())),
                    (k("days").to_string(), J::Num(d.days)),
                    (k("decisions").to_string(), J::Num(d.decisions)),
                ])
            })
            .collect();
        return out(&stringify(&J::Arr(rows)));
    }
    if r.due.is_empty() {
        return out(&defaults::render("opcli.review_none", &[("after", &to_js_string(r.after)), ("min", &to_js_string(r.min))]));
    }
    out(defaults::text("opcli.review_head"))?;
    for d in &r.due {
        out(&defaults::render("opcli.review_row", &[("id", &d.id), ("days", &to_js_string(d.days)), ("decisions", &to_js_string(d.decisions))]))?;
    }
    Ok(())
}

// ---- reviewed / snooze ----------------------------------------------------------------------------------------------------

pub(super) fn cmd_reviewed(cx: &mut Ctx, positional: &[String]) -> Result<(), SetupError> {
    let Some(id) = positional.first().filter(|i| !i.is_empty()) else {
        cx.fail(defaults::text("opcli.reviewed_usage"));
        return Ok(());
    };
    let mut state = State::read(&cx.home);
    let now = date::now_ms();
    let latency = {
        let entry = match state.entry(id) {
            Ok(e) => e,
            Err(msg) => {
                cx.fail(&msg);
                return Ok(());
            }
        };
        let latency = str_of(entry, k("due_since")).filter(|v| !v.is_empty()).and_then(date_ms).map(|due| now - due);
        set(entry, k("last_reviewed"), J::Str(iso(now)));
        set(entry, k("due_since"), J::Null);
        latency
    };
    state.write();
    append_metric(
        &cx.home,
        vec![
            (k("type").to_string(), J::Str(k("reviewed_type").to_string())),
            (k("id").to_string(), J::Str(id.clone())),
            (k("latency").to_string(), latency.map_or(J::Null, J::Num)),
        ],
    );
    let late = latency.map_or(String::new(), |l| {
        let hours = (l / num_of("opcli.review_hour_ms") + 0.5).floor();
        defaults::render("opcli.reviewed_late", &[("hours", &to_js_string(hours))])
    });
    out(&defaults::render("opcli.reviewed_ok", &[("id", id), ("late", &late)]))
}

pub(super) fn cmd_snooze(cx: &mut Ctx, positional: &[String], days: Option<&str>) -> Result<(), SetupError> {
    let n = days.map_or(f64::NAN, crate::checks::guardkit::text::js_number_of_str);
    let Some(id) = positional.first().filter(|i| !i.is_empty()).filter(|_| n.is_finite() && n > 0.0) else {
        cx.fail(defaults::text("opcli.snooze_usage"));
        return Ok(());
    };
    let until = (date::now_ms() + n * num_of("opcli.review_day_ms")).floor();
    if until > num_of("opcli.review_max_time_ms") {
        cx.fail(defaults::text("opcli.snooze_range"));
        return Ok(());
    }
    let mut state = State::read(&cx.home);
    let stamp = iso(until);
    match state.entry(id) {
        Ok(entry) => set(entry, k("snoozed_until"), J::Str(stamp.clone())),
        Err(msg) => {
            cx.fail(&msg);
            return Ok(());
        }
    }
    state.write();
    out(&defaults::render("opcli.snooze_ok", &[("id", id), ("until", &stamp)]))
}
