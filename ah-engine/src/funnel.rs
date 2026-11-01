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
use crate::telemetry::Telemetry;
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
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

/// The counters of an exported metrics snapshot (`Metrics::export`) as (name, labels, value).
fn counters(snap: &Value) -> Vec<(String, BTreeMap<String, String>, u64)> {
    let Some(map) = snap.get("counters").and_then(Value::as_object) else { return Vec::new() };
    map.iter()
        .filter_map(|(k, v)| {
            let mut parts = k.split('|');
            let name = parts.next()?.to_string();
            let labels = parts.filter_map(|kv| kv.split_once('=')).map(|(l, v)| (l.to_string(), v.to_string())).collect();
            Some((name, labels, v.as_u64()?))
        })
        .collect()
}

/// One report row's counts: by stage label, and by channel label.
type Counts = (BTreeMap<String, u64>, BTreeMap<String, u64>);

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

/// The funnel report: per check (and per model / project when asked) the stages and channels of `live`, less `baseline` when the
/// report is for a window (`days`). `baseline` is the oldest snapshot at or before the window start; `complete` is false when no
/// snapshot is that old (the figures then cover only what the snapshots hold, and say so).
pub fn report(live: &Value, baseline: Option<(u64, Value)>, complete: bool, by: &[String], days: Option<u64>) -> Value {
    let stage_names: Vec<(&str, &str)> =
        defaults::list("delivery.report_stages").into_iter().map(|k| (k, defaults::text(&format!("delivery.stage_{k}")))).collect();
    let channel_names: Vec<(&str, &str)> =
        defaults::raw("delivery.channel_label").as_table().unwrap_or_default().iter().map(|(k, v)| (*k, v.as_str().unwrap_or(""))).collect();
    let key_of = |labels: &BTreeMap<String, String>| -> Vec<String> {
        let mut k = vec![labels.get("check").cloned().unwrap_or_default()];
        for d in by {
            k.push(labels.get(d.as_str()).cloned().unwrap_or_default());
        }
        k
    };
    // cumulative counters: the window is live less baseline, per series
    let mut base: HashMap<(String, BTreeMap<String, String>), u64> = HashMap::new();
    if let Some((_, b)) = &baseline {
        for (n, l, v) in counters(b) {
            base.insert((n, l), v);
        }
    }
    let (over, other) = (defaults::text("telemetry.overflow_label"), defaults::text("delivery.project_other"));
    // a series whose model or project is the overflow bucket's: past the series cap those labels fold, the check and stage stay
    let folded = |labels: &BTreeMap<String, String>| ["model", "project"].iter().any(|d| labels.get(*d).is_some_and(|v| v == over || v == other));
    let mut overflow_counts = 0u64;
    let mut rows: BTreeMap<Vec<String>, Counts> = BTreeMap::new();
    for (name, labels, v) in counters(live) {
        let cur = v.saturating_sub(base.get(&(name.clone(), labels.clone())).copied().unwrap_or(0));
        if cur == 0 {
            continue;
        }
        let (stage, is_stage) = match name.as_str() {
            "delivery_funnel" => (labels.get("stage").cloned().unwrap_or_default(), true),
            "delivery_channel" => (labels.get("channel").cloned().unwrap_or_default(), false),
            _ => continue,
        };
        if is_stage && folded(&labels) {
            overflow_counts += cur;
        }
        let row = rows.entry(key_of(&labels)).or_default();
        *(if is_stage { &mut row.0 } else { &mut row.1 }).entry(stage).or_insert(0) += cur;
    }
    let mut out_rows = Vec::new();
    let mut totals: BTreeMap<String, u64> = BTreeMap::new();
    for (key, (st, ch)) in &rows {
        let mut row = Map::new();
        row.insert("check".into(), json!(key.first().cloned().unwrap_or_default()));
        for (i, d) in by.iter().enumerate() {
            row.insert(d.clone(), json!(key.get(i + 1).cloned().unwrap_or_default()));
        }
        for (k, label) in &stage_names {
            let n = st.get(*label).copied().unwrap_or(0);
            *totals.entry((*k).to_string()).or_insert(0) += n;
            row.insert((*k).to_string(), json!(n));
        }
        // counts under a stage the report does not list stay visible, never dropped
        let unlisted_key = defaults::text("delivery.report_overflow_stage");
        let unlisted: u64 = st.iter().filter(|(l, _)| !stage_names.iter().any(|(_, n)| n == l)).map(|(_, n)| *n).sum();
        if unlisted > 0 {
            *totals.entry(unlisted_key.to_string()).or_insert(0) += unlisted;
            row.insert(unlisted_key.to_string(), json!(unlisted));
        }
        if by.iter().enumerate().any(|(i, _)| key.get(i + 1).is_some_and(|v| v == over || v == other)) {
            row.insert("overflow".into(), json!(true));
        }
        let (a, i) =
            (st.get(defaults::text("delivery.stage_acted_on")).copied().unwrap_or(0), st.get(defaults::text("delivery.stage_ignored")).copied().unwrap_or(0));
        row.insert("acted_on_rate".into(), if a + i == 0 { Value::Null } else { json!(((a as f64 / (a + i) as f64) * 1000.0).round() / 1000.0) });
        let mut channels: Map<String, Value> = channel_names.iter().filter_map(|(_, label)| ch.get(*label).map(|n| ((*label).to_string(), json!(n)))).collect();
        let unlisted_ch: u64 = ch.iter().filter(|(l, _)| !channel_names.iter().any(|(_, n)| n == l)).map(|(_, n)| *n).sum();
        if unlisted_ch > 0 {
            channels.insert(unlisted_key.to_string(), json!(unlisted_ch));
        }
        row.insert("channels".into(), Value::Object(channels));
        out_rows.push(Value::Object(row));
    }
    let window = json!({
        "days": days,
        "baseline_ms": baseline.as_ref().map(|(ts, _)| *ts),
        "complete": complete,
        "note": if days.is_none() { defaults::text("delivery.report_note_lifetime") } else if complete { "" } else { defaults::text("delivery.report_note_partial") },
    });
    let mut window = window;
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
        let by_model = report(&live, None, true, &["model".to_string()], None);
        let rows = by_model["funnel"]["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 2);
        let opus = rows.iter().find(|r| r["model"] == "opus").unwrap();
        assert_eq!((opus["decided"].as_u64(), opus["acted_on"].as_u64(), opus["ignored"].as_u64()), (Some(10), Some(6), Some(2)));
        assert_eq!(opus["acted_on_rate"], json!(0.75));
        assert_eq!(opus["channels"]["block"], 3);
        let sonnet = rows.iter().find(|r| r["model"] == "sonnet").unwrap();
        assert!(sonnet["acted_on_rate"].is_null(), "no acted_on or ignored answer: no rate");
        let flat = report(&live, None, true, &[], None);
        assert_eq!(flat["funnel"]["rows"][0]["decided"], 14, "without --by the models are summed");
        let base =
            snap(&[("delivery_funnel|check=c1|model=opus|project=pa|stage=decided", 4), ("delivery_funnel|check=c1|model=opus|project=pa|stage=acted_on", 6)]);
        let win = report(&live, Some((123, base)), false, &["model".to_string()], Some(7));
        let opus = win["funnel"]["rows"].as_array().unwrap().iter().find(|r| r["model"] == "opus").unwrap().clone();
        assert_eq!((opus["decided"].as_u64(), opus["acted_on"].as_u64()), (Some(6), Some(0)), "the window is live less the baseline");
        assert_eq!(win["funnel"]["window"]["baseline_ms"], 123);
        assert_eq!(win["funnel"]["window"]["complete"], false);
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
        let r = report(&live, None, true, &[], None);
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
}
