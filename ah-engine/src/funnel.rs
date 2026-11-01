//! The per-rule funnel (B1, plan v2 section 6): the delivery stages of `delivery.rs` and the output channel of every answer,
//! split by the session's model family and by the project, and the report that reads them (`telemetry funnel`).
//!
//! Measurement only: nothing here changes an answer. The split lives in two metrics, `delivery_funnel` (check, model, project,
//! stage) and `delivery_channel` (check, channel, model, project); both persist with the other counters (the metrics snapshot) and
//! are bounded by `telemetry.max_series_by_metric`, by the model families of `delivery.model_families` and by
//! `delivery.project_slots` (past it a project is `delivery.project_other`). The session's model is read once from the payload
//! (`delivery.model_keys`) or, when the payload has none, from the newest assistant entry of the transcript tail (the
//! `model_routing.session_model_*` limits), and remembered per session in a map bounded by `delivery.session_models_max`.
//! The model is that of the session's main transcript: a subagent running on another model is counted under its parent's.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - an absent field is the empty value
// A failure that must be seen goes through `crate::discard` instead.

use crate::defaults;
use crate::dispatch::combine::HookResult;
use crate::freport::Diff;
use crate::telemetry::Telemetry;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Mutex;

/// Who an answer belongs to, as the funnel labels it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ctx {
    /// The model family (`delivery.model_families`) or `delivery.model_unknown`.
    pub model: String,
    /// The hashed project key, or `delivery.project_other` past the slots.
    pub project: String,
}

struct ModelSlot {
    model: String,
    /// Transcript reads spent on this session so far (a hit ends them).
    tries: u64,
    /// Insertion order, to forget the oldest at the cap.
    seq: u64,
}

#[derive(Default)]
struct Cache {
    models: HashMap<String, ModelSlot>,
    seq: u64,
    projects: HashSet<String>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

thread_local! {
    /// (session, project hash) of the request this thread serves, so code that has no payload (a shed answer) can still label its count.
    static REQUEST: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
}

/// Whether the funnel split is on (`delivery.funnel_enabled`).
pub fn enabled() -> bool {
    defaults::num("delivery.funnel_enabled") != 0
}

/// Marks the request this thread serves until dropped.
pub struct RequestGuard;

impl Drop for RequestGuard {
    fn drop(&mut self) {
        REQUEST.with(|r| *r.borrow_mut() = None);
    }
}

/// The request being served belongs to `session` and project `phash` (for [`dropped`]).
pub fn request(session: &str, phash: &str) -> RequestGuard {
    REQUEST.with(|r| *r.borrow_mut() = Some((session.to_string(), phash.to_string())));
    RequestGuard
}

/// The model family of a model id: the first `delivery.model_families` entry the lower-cased id contains.
fn family(id: &str) -> Option<&'static str> {
    let id = id.to_lowercase();
    defaults::list("delivery.model_families").into_iter().find(|f| id.contains(f))
}

fn payload_model(p: &Value) -> Option<&'static str> {
    defaults::list("delivery.model_keys").into_iter().find_map(|k| p.get(k).and_then(Value::as_str)).and_then(family)
}

/// The newest assistant entry's model family in the transcript tail of `p`, `None` when the payload names no readable transcript or
/// the tail holds none.
fn transcript_model(p: &Value) -> Option<&'static str> {
    let path = p.get("transcript_path").and_then(Value::as_str).filter(|t| std::path::Path::new(t).is_absolute())?;
    let raw = crate::script::host::tail_entries(
        path,
        defaults::num("model_routing.session_model_window_bytes") as f64,
        defaults::num("model_routing.session_model_line_max_bytes") as f64,
        defaults::text("delivery.model_transcript_keep"),
        defaults::num("model_routing.session_model_max_lines") as f64,
    )?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("lines")?.as_array()?.iter().rev().find_map(|l| {
        let e = l.get(1)?;
        (e.get("type").and_then(Value::as_str) == Some("assistant")).then_some(())?;
        family(e.get("message")?.get("model")?.as_str()?)
    })
}

fn project_label(c: &mut Cache, phash: &str) -> String {
    if c.projects.contains(phash) || c.projects.len() < defaults::num("delivery.project_slots") as usize {
        c.projects.insert(phash.to_string());
        phash.to_string()
    } else {
        defaults::text("delivery.project_other").to_string()
    }
}

/// The funnel labels of an answer of `session` (project hash `phash`): the model is resolved from the payload, else the transcript
/// tail (a few reads per session, then `delivery.model_unknown`).
pub fn ctx(session: &str, p: &Value, phash: &str) -> Ctx {
    resolve(session, phash, Some(p))
}

/// The labels from what is already known: no payload, no transcript read (an unseen session is `delivery.model_unknown`).
pub fn cached_ctx(session: &str, phash: &str) -> Ctx {
    resolve(session, phash, None)
}

fn resolve(session: &str, phash: &str, p: Option<&Value>) -> Ctx {
    let unknown = defaults::text("delivery.model_unknown");
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let c = g.get_or_insert_with(Cache::default);
    let project = project_label(c, phash);
    if session.is_empty() {
        return Ctx { model: p.and_then(payload_model).unwrap_or(unknown).to_string(), project };
    }
    let known = c.models.get(session).map(|s| (s.model.clone(), s.tries));
    let (model, tries) = known.clone().unwrap_or_else(|| (unknown.to_string(), 0));
    let settled = model != unknown || tries >= defaults::num("delivery.model_retry_max");
    let Some(p) = p.filter(|_| !settled) else { return Ctx { model, project } };
    drop(g); // the transcript read happens outside the lock
    let found = payload_model(p).or_else(|| transcript_model(p));
    let model = found.unwrap_or(unknown).to_string();
    let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let c = g.get_or_insert_with(Cache::default);
    if !c.models.contains_key(session) && c.models.len() >= defaults::num("delivery.session_models_max") as usize {
        let oldest = c.models.iter().min_by_key(|(_, s)| s.seq).map(|(k, _)| k.clone());
        if let Some(k) = oldest {
            c.models.remove(&k);
        }
    }
    c.seq += 1;
    let seq = c.seq;
    c.models.insert(session.to_string(), ModelSlot { model: model.clone(), tries: tries + 1, seq });
    Ctx { model, project }
}

/// Count one answer of `check` at funnel stage `stage_key` (a `delivery.stage_*` key).
pub fn stage(t: &Telemetry, check: &str, c: &Ctx, stage_key: &str) {
    if enabled() {
        t.with_metrics(|m| m.inc("delivery_funnel", &[("check", check), ("model", &c.model), ("project", &c.project), ("stage", defaults::text(stage_key))]));
    }
}

/// An answer of the request being served was lost or shed for `reason` (from `budget::note_dropped`, which has no payload).
pub fn dropped(check: &str, reason: &str) {
    if !enabled() {
        return;
    }
    let Some((session, phash)) = REQUEST.with(|r| r.borrow().clone()) else { return };
    let c = cached_ctx(&session, &phash);
    let key = if reason == defaults::text("delivery.reason_shed") { "delivery.stage_shed" } else { "delivery.stage_lost" };
    crate::metrics::bump("delivery_funnel", &[("check", check), ("model", &c.model), ("project", &c.project), ("stage", defaults::text(key))]);
}

/// Count the output channels one answer of `check` used.
pub fn channels(t: &Telemetry, check: &str, event: &str, r: &HookResult, c: &Ctx) {
    if !enabled() {
        return;
    }
    let labels = defaults::raw("delivery.channel_label");
    for key in crate::dispatch::combine::channel_keys(event, r) {
        t.with_metrics(|m| m.inc("delivery_channel", &[("check", check), ("channel", labels.str_field(key)), ("model", &c.model), ("project", &c.project)]));
    }
}

// ---- the report -------------------------------------------------------------------------------------------------------------

/// One report row's counts: by stage label, and by channel label, and whether a sum of the row stopped at the maximum or a series
/// that feeds it is flagged (its rate is then unavailable).
#[derive(Default)]
struct Counts {
    stages: BTreeMap<String, u64>,
    channels: BTreeMap<String, u64>,
    sat: bool,
    flagged: bool,
}

/// Validate `--by`: the words of the comma list, each one of `delivery.report_dims`.
pub fn parse_by(by: &str) -> Result<Vec<String>, String> {
    let known = defaults::list("delivery.report_dims");
    let mut out = Vec::new();
    for w in by.split(',').map(str::trim).filter(|w| !w.is_empty()) {
        if !known.contains(&w) {
            return Err(defaults::render("delivery.report_bad_dim", &[("dim", &w), ("dims", &known.join(", "))]));
        }
        if !out.iter().any(|x| x == w) {
            out.push(w.to_string());
        }
    }
    Ok(out)
}

/// The funnel report: per check (and per model / project when asked) the stages and channels of the window `d`. `baseline_ms` is the
/// time of the start snapshot; `complete` is false when no snapshot is that old (the figures then cover only what the snapshots hold,
/// and say so). A row is `partial` when a series of its check restarted inside the window or could not be compared (`d`), and the
/// window is not complete then either.
pub fn report(d: &Diff, baseline_ms: Option<u64>, complete: bool, by: &[String], windowed: bool) -> Value {
    let stage_names: Vec<(&str, &str)> =
        defaults::list("delivery.report_stages").into_iter().map(|k| (k, defaults::text(&format!("delivery.stage_{k}")))).collect();
    let channel_names: Vec<(&str, &str)> =
        defaults::raw("delivery.channel_label").as_table().unwrap_or_default().iter().map(|(k, v)| (*k, v.as_str().unwrap_or(""))).collect();
    let key_of = |labels: &BTreeMap<String, String>| -> Vec<String> {
        let mut k = vec![labels.get("check").cloned().unwrap_or_default()];
        for dim in by {
            k.push(labels.get(dim.as_str()).cloned().unwrap_or_default());
        }
        k
    };
    let (over, other) = (defaults::text("telemetry.overflow_label"), defaults::text("delivery.project_other"));
    // a series whose model or project is the overflow bucket's: past the series cap those labels fold, the check and stage stay
    let folded = |labels: &BTreeMap<String, String>| ["model", "project"].iter().any(|dim| labels.get(*dim).is_some_and(|v| v == over || v == other));
    let mut overflow_counts = 0u64;
    let mut rows: BTreeMap<Vec<String>, Counts> = BTreeMap::new();
    for s in &d.series {
        if s.value == 0 && s.flag.is_none() {
            continue;
        }
        let (stage, is_stage) = match s.name.as_str() {
            "delivery_funnel" => (s.labels.get("stage").cloned().unwrap_or_default(), true),
            "delivery_channel" => (s.labels.get("channel").cloned().unwrap_or_default(), false),
            _ => continue,
        };
        if is_stage && folded(&s.labels) {
            overflow_counts = d.add(overflow_counts, s.value);
        }
        let row = rows.entry(key_of(&s.labels)).or_default();
        row.flagged |= s.flag.is_some();
        let mut sat = row.sat;
        let slot = (if is_stage { &mut row.stages } else { &mut row.channels }).entry(stage).or_insert(0);
        *slot = d.add_row(*slot, s.value, &mut sat);
        row.sat = sat;
    }
    let mut out_rows = Vec::new();
    let mut totals: BTreeMap<String, u64> = BTreeMap::new();
    let unlisted_key = defaults::text("delivery.report_overflow_stage");
    let mut total_add = |k: &str, n: u64| {
        let t = totals.entry(k.to_string()).or_insert(0);
        *t = d.add(*t, n);
    };
    let mut sat_checks: BTreeSet<String> = BTreeSet::new();
    for (key, acc) in &rows {
        let (st, ch) = (&acc.stages, &acc.channels);
        let mut row = Map::new();
        let check = key.first().cloned().unwrap_or_default();
        let mut sat = acc.sat;
        row.insert("check".into(), json!(check));
        for (i, dim) in by.iter().enumerate() {
            row.insert(dim.clone(), json!(key.get(i + 1).cloned().unwrap_or_default()));
        }
        for (k, label) in &stage_names {
            let n = st.get(*label).copied().unwrap_or(0);
            total_add(k, n);
            row.insert((*k).to_string(), json!(n));
        }
        // counts under a stage the report does not list stay visible, never dropped
        let unlisted = st.iter().filter(|(l, _)| !stage_names.iter().any(|(_, n)| n == l)).fold(0u64, |a, (_, n)| d.add_row(a, *n, &mut sat));
        if unlisted > 0 {
            total_add(unlisted_key, unlisted);
            row.insert(unlisted_key.to_string(), json!(unlisted));
        }
        if by.iter().enumerate().any(|(i, _)| key.get(i + 1).is_some_and(|v| v == over || v == other)) {
            row.insert("overflow".into(), json!(true));
        }
        let stage = |k: &str| st.get(defaults::text(k)).copied().unwrap_or(0);
        // the rate in integer permille: a sum of two counts can pass u64, and the float of a large count is not exact
        let (a, i) = (u128::from(stage("delivery.stage_acted_on")), u128::from(stage("delivery.stage_ignored")));
        let den = a + i;
        // a rate over a row with a saturated, unreadable or restarted input, or a sum that stopped at the maximum, is not a number
        let rate = if acc.sat || sat || acc.flagged || d.is_partial(&check) {
            Value::Null
        } else {
            (a * 1000 + den / 2).checked_div(den).map_or(Value::Null, |permille| json!(permille as f64 / 1000.0))
        };
        row.insert("acted_on_rate".into(), rate);
        let mut channels: Map<String, Value> = channel_names.iter().filter_map(|(_, label)| ch.get(*label).map(|n| ((*label).to_string(), json!(n)))).collect();
        let unlisted_ch = ch.iter().filter(|(l, _)| !channel_names.iter().any(|(_, n)| n == l)).fold(0u64, |a, (_, n)| d.add_row(a, *n, &mut sat));
        if unlisted_ch > 0 {
            channels.insert(unlisted_key.to_string(), json!(unlisted_ch));
        }
        row.insert("channels".into(), Value::Object(channels));
        if sat {
            sat_checks.insert(check.clone());
        }
        row.insert("partial".into(), json!(d.is_partial(&check) || sat));
        row.insert("partial_reasons".into(), json!(crate::freport::reason_words_of(d, &check, sat)));
        out_rows.push(Value::Object(row));
    }
    // every check with an unproven figure, whether or not it has a funnel row of its own
    let mut partial_checks: BTreeSet<String> = d.partial_checks.clone();
    partial_checks.extend(sat_checks.iter().cloned());
    if !d.global.is_empty() {
        partial_checks.extend(rows.keys().filter_map(|k| k.first().cloned()));
    }
    let note = if !windowed {
        defaults::text("delivery.report_note_lifetime")
    } else if complete {
        ""
    } else {
        defaults::text("delivery.report_note_partial")
    };
    let mut window = json!({
        "baseline_ms": baseline_ms,
        "complete": complete && d.clean() && sat_checks.is_empty(),
        "resets": d.resets,
        "mismatched": d.mismatched,
        "partial_checks": partial_checks,
        "note": note,
    });
    if overflow_counts > 0 {
        window["overflow"] = json!({ "counts": overflow_counts, "note": defaults::render("delivery.report_note_overflow", &[("counts", &overflow_counts)]) });
    }
    json!({ "funnel": { "by": by, "window": window, "rows": out_rows, "totals": totals } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(pairs: &[(&str, u64)]) -> Value {
        let m: Map<String, Value> = pairs.iter().map(|(k, v)| ((*k).to_string(), json!(v))).collect();
        json!({ "counters": m })
    }

    /// The report of `live` less `base` (a snapshot taken at 123 ms).
    fn rep(live: &Value, base: Option<Value>, complete: bool, by: &[String], windowed: bool) -> Value {
        let d = Diff::new(live, base.as_ref());
        report(&d, base.as_ref().map(|_| 123), complete, by, windowed)
    }

    #[test]
    fn a_model_id_maps_to_its_first_matching_family_and_an_unknown_one_to_none() {
        assert_eq!(family("claude-opus-4-8"), Some("opus"));
        assert_eq!(family("GPT-5.5-codex"), Some("gpt"));
        assert_eq!(family("mystery-1"), None);
    }

    #[test]
    fn the_payload_model_is_remembered_for_the_session_and_unknown_is_retried_a_bounded_number_of_times() {
        let p = json!({"model": "claude-sonnet-5"});
        assert_eq!(ctx("s-fm-1", &p, "ph1").model, "sonnet");
        // a later payload without a model keeps the remembered one
        assert_eq!(ctx("s-fm-1", &json!({}), "ph1").model, "sonnet");
        // a session never seen and without a model is unknown, and cached_ctx never invents one
        assert_eq!(ctx("s-fm-2", &json!({}), "ph1").model, defaults::text("delivery.model_unknown"));
        assert_eq!(cached_ctx("s-fm-3", "ph1").model, defaults::text("delivery.model_unknown"));
        // a model that shows up within the retry bound is taken
        assert_eq!(ctx("s-fm-2", &json!({"model": "gpt-5.5"}), "ph1").model, "gpt");
    }

    #[test]
    fn the_model_is_read_from_the_newest_assistant_entry_of_the_transcript_tail() {
        let dir = std::env::temp_dir().join(format!("ah-funnel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let tp = dir.join("t.jsonl");
        std::fs::write(
            &tp,
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4\"}}\n{\"type\":\"user\",\"message\":{}}\n{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-8\"}}\n",
        )
        .unwrap();
        let p = json!({"transcript_path": tp.to_string_lossy()});
        assert_eq!(ctx("s-fm-tail", &p, "ph1").model, "opus");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn projects_past_the_slots_share_the_other_label_and_known_ones_keep_theirs() {
        let slots = defaults::num("delivery.project_slots") as usize;
        let mut c = Cache::default();
        let first = project_label(&mut c, "p-first");
        assert_eq!(first, "p-first");
        for i in 0..slots {
            project_label(&mut c, &format!("p{i}"));
        }
        assert_eq!(project_label(&mut c, "p-late"), defaults::text("delivery.project_other"));
        assert_eq!(project_label(&mut c, "p-first"), "p-first", "a project that has a slot keeps it");
        assert!(c.projects.len() <= slots);
    }

    #[test]
    fn the_report_splits_by_the_asked_dimensions_and_subtracts_the_baseline() {
        let live = snap(&[
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=decided", 10),
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=acted_on", 6),
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=ignored", 2),
            ("delivery_funnel|check=c1|model=sonnet|project=pa|stage=decided", 4),
            ("delivery_channel|check=c1|channel=block|model=opus|project=pa", 3),
            ("delivery_stage|check=c1|stage=decided", 99),
        ]);
        let by_model = rep(&live, None, true, &["model".to_string()], false);
        let rows = by_model["funnel"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let opus = rows.iter().find(|r| r["model"] == "opus").unwrap();
        assert_eq!((opus["decided"].as_u64(), opus["acted_on"].as_u64(), opus["ignored"].as_u64()), (Some(10), Some(6), Some(2)));
        assert_eq!(opus["acted_on_rate"], json!(0.75));
        assert_eq!(opus["channels"]["block"], 3);
        let sonnet = rows.iter().find(|r| r["model"] == "sonnet").unwrap();
        assert!(sonnet["acted_on_rate"].is_null(), "no acted_on or ignored answer: no rate");
        let flat = rep(&live, None, true, &[], false);
        assert_eq!(flat["funnel"]["rows"][0]["decided"], 14, "without --by the models are summed");
        let base =
            snap(&[("delivery_funnel|check=c1|model=opus|project=pa|stage=decided", 4), ("delivery_funnel|check=c1|model=opus|project=pa|stage=acted_on", 6)]);
        let win = rep(&live, Some(base), false, &["model".to_string()], true);
        let opus = win["funnel"]["rows"].as_array().unwrap().iter().find(|r| r["model"] == "opus").unwrap().clone();
        assert_eq!((opus["decided"].as_u64(), opus["acted_on"].as_u64()), (Some(6), Some(0)), "the window is live less the baseline");
        assert_eq!(win["funnel"]["window"]["baseline_ms"], 123);
        assert_eq!(win["funnel"]["window"]["complete"], false);
    }

    #[test]
    fn a_rate_over_counts_past_u64_does_not_overflow_and_sums_stop_at_the_maximum_and_flag_the_window() {
        let live = snap(&[
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=acted_on", u64::MAX),
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=ignored", 1),
        ]);
        let r = rep(&live, None, true, &[], false);
        assert_eq!(r["funnel"]["rows"][0]["acted_on_rate"], Value::Null, "a series at u64::MAX stopped counting: no rate, not a number: {r}");
        assert_eq!(r["funnel"]["rows"][0]["partial"], true, "{r}");
        assert_eq!(r["funnel"]["window"]["complete"], false, "{r}");
        let big = snap(&[
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=acted_on", 1u64 << 62),
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=ignored", 1),
        ]);
        let r = rep(&big, None, true, &[], false);
        assert_eq!(r["funnel"]["rows"][0]["acted_on_rate"], json!(1.0), "{r}");
        assert_eq!(r["funnel"]["window"]["complete"], true, "control: no value and no sum reached u64::MAX");
        // two models fold into one row without --by: the sum passes u64 and stops there, and the window says so
        let big = snap(&[
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=decided", u64::MAX),
            ("delivery_funnel|check=c1|model=sonnet|project=pa|stage=decided", 5),
        ]);
        let r = rep(&big, None, true, &[], false);
        assert_eq!(r["funnel"]["rows"][0]["decided"], u64::MAX);
        assert_eq!(r["funnel"]["window"]["complete"], false, "{r}");
    }

    #[test]
    fn an_unknown_dimension_is_refused_and_a_known_one_accepted_once() {
        assert_eq!(parse_by("model, project,model").unwrap(), vec!["model".to_string(), "project".to_string()]);
        assert!(parse_by("session").unwrap_err().contains("session"));
        assert!(parse_by("").unwrap().is_empty());
    }

    #[test]
    fn past_the_default_series_cap_the_funnel_still_keeps_its_model_and_project_labels() {
        let default_cap = defaults::num("telemetry.max_series") as usize;
        let funnel_cap = defaults::raw("telemetry.max_series_by_metric").get("delivery_funnel").and_then(defaults::V::as_integer).unwrap() as usize;
        assert!(funnel_cap > default_cap + 100, "the funnel's own cap is above the global one");
        let mut m = crate::metrics::Metrics::default();
        let combos = default_cap + 100;
        for i in 0..combos {
            m.inc("delivery_funnel", &[("check", "c"), ("model", "opus"), ("project", &format!("p{i}")), ("stage", "decided")]);
            m.inc("delivery_lost", &[("check", "c"), ("reason", &format!("r{i}"))]); // a metric with no override of its own
        }
        for i in 0..combos {
            let n = m.counter("delivery_funnel", &[("check", "c"), ("model", "opus"), ("project", &format!("p{i}")), ("stage", "decided")]);
            assert_eq!(n, 1, "series {i} kept its labels");
        }
        let other = defaults::text("telemetry.overflow_label");
        assert_eq!(m.counter("delivery_funnel", &[("check", other), ("model", other), ("project", other), ("stage", other)]), 0, "nothing collapsed");
        assert_eq!(m.counter("delivery_lost", &[("check", "c"), ("reason", other)]), 100, "control: a metric on the global cap collapses its extra series");
    }

    #[test]
    fn past_the_series_cap_no_count_is_lost_and_the_overflow_bucket_is_reported_and_flagged() {
        use crate::delivery;
        let t = Telemetry::new();
        let (checks, models, projects) = (["cap-a", "cap-b"], ["opus", "sonnet", "haiku", "fable", "gpt", "codex"], 150usize);
        let funnel_cap = defaults::raw("telemetry.max_series_by_metric").get("delivery_funnel").and_then(defaults::V::as_integer).unwrap() as usize;
        assert!(projects * models.len() * checks.len() * 2 > funnel_cap, "the run exceeds the funnel's series cap");
        for i in 0..projects {
            for m in models {
                for c in checks {
                    delivery::decided(&t, &format!("s-cap-{i}-{m}-{c}"), c, &Ctx { model: m.into(), project: format!("p{i}") });
                    delivery::settle(&t, true);
                }
            }
        }
        let each = (projects * models.len()) as u64;
        let status = delivery::status(&t);
        let flat = t.funnel_json("", "");
        for c in checks {
            let row = flat["funnel"]["rows"].as_array().unwrap().iter().find(|r| r["check"] == c).unwrap();
            assert_eq!(
                (status["per_check"][c]["decided"].as_u64(), status["per_check"][c]["delivered"].as_u64()),
                (Some(each), Some(each)),
                "{c}: unsplit ledger"
            );
            assert_eq!((row["decided"].as_u64(), row["delivered"].as_u64()), (Some(each), Some(each)), "{c}: the funnel equals the per-check ledger: {row}");
            assert_eq!(row["channels"].as_object().map(|o| o.len()), Some(0), "no channel was used");
        }
        assert_eq!(flat["funnel"]["totals"]["decided"], 2 * each);
        assert_eq!(flat["funnel"]["totals"]["delivered"], 2 * each);
        assert!(flat["funnel"]["totals"].get(defaults::text("delivery.report_overflow_stage")).is_none(), "no count sits under an unlisted stage");
        // by model and project: the bucket is a row of its own, flagged, and the window says how much sits in it
        let split = t.funnel_json("model,project", "");
        let rows = split["funnel"]["rows"].as_array().unwrap();
        let over = defaults::text("telemetry.overflow_label");
        let flagged: Vec<_> = rows.iter().filter(|r| r["overflow"] == true).collect();
        assert!(!flagged.is_empty() && flagged.iter().all(|r| r["model"] == over || r["project"] == over), "{split}");
        assert!(rows.iter().filter(|r| r["overflow"] != true).all(|r| r["model"] != over && r["project"] != over));
        assert_eq!(rows.iter().map(|r| r["decided"].as_u64().unwrap()).sum::<u64>(), 2 * each, "the rows add up to the total");
        assert!(split["funnel"]["window"]["overflow"]["counts"].as_u64() > Some(0), "{split}");
        assert!(flat["funnel"]["window"]["overflow"]["note"].as_str().is_some_and(|n| n.contains("overflow bucket")));
    }

    #[test]
    fn a_stage_or_channel_label_the_report_does_not_list_stays_in_the_row_and_the_totals() {
        let live = snap(&[
            ("delivery_funnel|check=c1|model=opus|project=pa|stage=decided", 3),
            ("delivery_funnel|check=c1|model=other|project=other|stage=other", 2),
            ("delivery_channel|check=c1|channel=other|model=opus|project=pa", 1),
        ]);
        let r = rep(&live, None, true, &[], false);
        let unlisted = defaults::text("delivery.report_overflow_stage");
        assert_eq!(r["funnel"]["rows"][0]["decided"], 3);
        assert_eq!(r["funnel"]["rows"][0][unlisted], 2);
        assert_eq!(r["funnel"]["totals"][unlisted], 2);
        assert_eq!(r["funnel"]["rows"][0]["channels"][unlisted], 1);
    }

    #[test]
    fn the_funnel_counters_survive_an_engine_restart_with_the_other_counters_and_a_window_reads_the_stored_snapshot() {
        use crate::db::{Db, TempDir};
        use crate::delivery;
        use crate::storage::SqliteStore;
        let dir = TempDir::new("funnel-restart");
        let who = Ctx { model: "opus".into(), project: "pa".into() };
        {
            let t = Telemetry::with_store(Box::new(SqliteStore::new(Db::open(&dir.0).unwrap())));
            delivery::decided(&t, "s-restart", "silent-agent-nudge", &who);
            delivery::settle(&t, true);
            delivery::observe(&t, "s-restart", defaults::text("delivery.react_event"), "SendMessage");
            assert!(t.snapshot_metrics(), "the snapshot is kept");
        }
        // a new process: same directory, empty memory, counters restored from the snapshot
        let t = Telemetry::with_store(Box::new(SqliteStore::new(Db::open(&dir.0).unwrap())));
        assert!(t.funnel_json("", "")["funnel"]["rows"].as_array().unwrap().is_empty(), "nothing before the restore");
        t.restore_metrics();
        let all = t.funnel_json("model,project", "");
        let row = &all["funnel"]["rows"][0];
        assert_eq!((row["check"].as_str(), row["model"].as_str(), row["project"].as_str()), (Some("silent-agent-nudge"), Some("opus"), Some("pa")));
        assert_eq!(
            (row["decided"].as_u64(), row["delivered"].as_u64(), row["acted_on"].as_u64(), row["ignored"].as_u64()),
            (Some(1), Some(1), Some(1), Some(0))
        );
        assert_eq!(row["acted_on_rate"], json!(1.0));
        // more activity after the restart adds to the restored figures; a window starting after the snapshot sees only the new ones
        delivery::decided(&t, "s-restart-2", "silent-agent-nudge", &who);
        delivery::settle(&t, true);
        assert_eq!(t.funnel_json("", "")["funnel"]["rows"][0]["decided"], 2, "lifetime: restored plus new");
        let win = t.funnel_json("", "1d");
        assert_eq!(win["funnel"]["rows"][0]["decided"], 1, "a 1-day window starts at the snapshot: only the new answer: {win}");
        assert_eq!(win["funnel"]["window"]["complete"], false, "the snapshot is newer than the window start, and the report says so");
        // a bad word is refused with the accepted ones named
        assert!(t.funnel_json("session", "")["error"].as_str().unwrap().contains("model"));
    }

    /// Seed the stored snapshots a report reads: (age in ms before now, decided answers, check runs of 800 us, runs of 200 ms, deadline cuts).
    fn seeded(dir: &std::path::Path, snaps: &[(u64, u64, u64, u64, u64)]) -> (Telemetry, Vec<u64>) {
        use crate::db::Db;
        use crate::storage::{SqliteStore, Store};
        let store = SqliteStore::new(Db::open(dir).unwrap());
        let now = crate::health::now_ms();
        let mut stamps = Vec::new();
        for (age, decided, fast, slow, cuts) in snaps {
            let mut m = crate::metrics::Metrics::default();
            m.add("delivery_funnel", &[("check", "swarm-guard"), ("model", "opus"), ("project", "pa"), ("stage", "decided")], *decided);
            m.add("fail_open", &[("check", "swarm-guard"), ("reason", "deadline_cut")], *cuts);
            m.add("check_calls", &[("check", "swarm-guard")], fast + slow);
            for _ in 0..*fast {
                m.observe("check_latency_us", &[("check", "swarm-guard")], 800);
            }
            for _ in 0..*slow {
                m.observe("check_latency_us", &[("check", "swarm-guard")], 200_000);
            }
            let ts = now - age;
            assert!(store.save_metrics(ts, &m.export()));
            stamps.push(ts);
        }
        let t = Telemetry::with_store(Box::new(SqliteStore::new(Db::open(dir).unwrap())));
        t.restore_metrics();
        (t, stamps)
    }

    #[test]
    fn a_report_over_a_time_window_is_the_end_snapshot_less_the_start_for_the_funnel_latency_and_failures() {
        use crate::db::TempDir;
        use crate::telemetry::ReportAsk;
        const H: u64 = 3_600_000;
        let dir = TempDir::new("report-window");
        // 5 h ago: 2 decided, 4 fast runs; 3 h ago: 5 decided, 10 fast, 1 cut; 1 h ago: 12 decided, 30 fast + 5 slow runs, 4 cuts
        let (t, at) = seeded(&dir.0, &[(5 * H, 2, 4, 0, 0), (3 * H, 5, 10, 0, 1), (H, 12, 30, 5, 4)]);
        let ask = |since: &str, from: &str, to: &str| ReportAsk {
            by: "model".into(),
            since: since.into(),
            from: from.into(),
            to: to.into(),
            full: true,
            stored: true,
        };
        // the last 2 h: the start is the snapshot 3 h ago (the last one at or before the asked start), the end the last stored one
        let v = t.funnel_report(&ask("2h", "", ""));
        assert!(v.get("error").is_none(), "{v}");
        let w = &v["funnel"]["window"];
        assert_eq!((w["baseline_ms"].as_u64(), w["end_ms"].as_u64(), w["complete"].clone()), (Some(at[1]), Some(at[2]), json!(true)), "{w}");
        assert_eq!(w["resolution"], "minute", "the finest resolution that keeps a snapshot 2 h old");
        assert!(
            w["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains("really starts")),
            "the start lags the asked start and says so: {w}"
        );
        assert_eq!(v["funnel"]["rows"][0]["decided"], 7, "12 - 5");
        let l = &v["latency"]["rows"][0];
        assert_eq!((l["check"].as_str(), l["count"].as_u64()), (Some("swarm-guard"), Some(25)), "20 fast + 5 slow runs in the window: {l}");
        assert_eq!((l["p50_ms"].clone(), l["p95_ms"].clone()), (json!(1.0), json!(1000.0)));
        let f = &v["failures"]["rows"][0];
        assert_eq!((f["fail_open"].as_u64(), f["timeouts"].as_u64(), f["runs"].as_u64()), (Some(3), Some(3), Some(25)), "{f}");
        // an absolute window with an end: 4 h ago to 2 h ago is the 5 h snapshot to the 3 h one
        let ms = |ago: u64| (crate::health::now_ms() - ago).to_string();
        let v = t.funnel_report(&ask("", &ms(4 * H), &ms(2 * H)));
        assert_eq!((v["funnel"]["window"]["baseline_ms"].as_u64(), v["funnel"]["window"]["end_ms"].as_u64()), (Some(at[0]), Some(at[1])), "{v}");
        assert_eq!(v["funnel"]["rows"][0]["decided"], 3, "5 - 2");
        assert_eq!(v["latency"]["rows"][0]["count"], 6, "10 - 4 fast runs");
        assert_eq!(v["failures"]["rows"][0]["timeouts"], 1);
        // a window that starts after the last snapshot is empty and says so; lifetime reads everything
        let v = t.funnel_report(&ask("", &ms(1_800_000), ""));
        assert!(v["funnel"]["window"]["notes"].as_array().unwrap().iter().any(|n| n.as_str().unwrap().contains("same stored snapshot")), "{v}");
        assert_eq!(t.funnel_report(&ask("", "", ""))["funnel"]["rows"][0]["decided"], 12);
        // no snapshot at or before --to: an error naming it; a bad flag is refused; the funnel verb without `full` has no extra section
        let v = t.funnel_report(&ask("", &ms(1000 * H), &ms(900 * H)));
        assert!(v["error"].as_str().unwrap().contains("no stored metrics snapshot"), "{v}");
        assert!(t.funnel_report(&ask("1x", "", ""))["error"].as_str().unwrap().contains("1x"));
        let plain = t.funnel_report(&ReportAsk { since: "2h".into(), stored: true, ..ReportAsk::default() });
        assert!(plain.get("latency").is_none() && plain.get("failures").is_none());
        // the reports are counted by outcome
        let (ok, err) = t.with_metrics(|m| (m.counter("funnel_reports", &[("outcome", "ok")]), m.counter("funnel_reports", &[("outcome", "error")])));
        assert!(ok >= 3 && err == 2, "ok {ok} err {err}");
    }

    #[test]
    fn a_counter_that_restarted_inside_the_window_reports_its_end_value_and_the_report_flags_the_reset() {
        let live = snap(&[("delivery_funnel|check=c1|model=opus|project=pa|stage=decided", 3)]);
        let base = snap(&[("delivery_funnel|check=c1|model=opus|project=pa|stage=decided", 10)]);
        let r = rep(&live, Some(base), true, &[], true);
        assert_eq!(r["funnel"]["rows"][0]["decided"], 3, "below the start: the counter restarted, the end value stands");
        assert_eq!(r["funnel"]["window"]["resets"], 1);
    }
}
