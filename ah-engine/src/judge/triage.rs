//! `ah-engine jev triage`: the mesh triage worker, answered by the engine.
//!
//! Same contract as `hooks/lib/jev-triage-worker.js`, which `jev-triage.js` spawns with its own hard timeout:
//! * stdin: `{ items: [{hash, text}], timeoutMs, urgentThreshold }`;
//! * stdout: `{ <hash>: {urgency?, kind?, backend, ms, transport?, fellBack?} | null }` (an item the budget cut off is
//!   absent, so the caller retries it; `null` means "classified, no confident label");
//! * exit 0, best-effort partial results, never an error.
//!
//! The backend comes from `jev.triageBackend`:
//! * `jev` (default, today's behaviour): one multi-question Jev call per message (kind, urgency), each label kept only at
//!   its confidence threshold; a label Jev leaves open is filled by the Anthropic API when a key is visible;
//! * `haiku`: the model alone, through `jev.judgeBackend` (the Claude CLI runs here).
//!
//! The engine never calls the Anthropic API: a run that could need it (the default backend with a key visible, or
//! `haiku` routed to the API) writes nothing to stdout, says why on stderr and exits with `dispatch.defer_exit`, before
//! any call is made, so its caller can run the Node worker instead. Every model call leaves a telemetry row.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - malformed input is the empty request (Node: JSON.parse catch prints {})
// A failure that must be seen goes through `crate::discard` instead.

use super::settings::{Route, anthropic_key_visible, integration_backend, route};
use super::{cli, telemetry};
use crate::checks::git::util::Settings;
use crate::checks::guardkit::text::js_trim;
use crate::checks::jsport::text::slice16_lossy;
use crate::checks::replykit::json::{js_number, quote};
use crate::defaults;
use crate::jev::cascade;
use crate::jev::client::{Answer, JevClient};
use crate::jev::question::Question;
use crate::jev::scrub::scrub_secrets;
use crate::jev::settings::{Env, JevSettings, Sources};
use serde_json::Value;
use std::io::Read;
use std::time::{Duration, Instant};

/// One label set (Node: the object `classifyOne` returns).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Label {
    /// `urgent` or `normal`.
    pub urgency: Option<String>,
    /// One of the kind labels.
    pub kind: Option<String>,
    /// Who answered: `jev`, `haiku`, `jev+haiku`.
    pub backend: String,
    /// Milliseconds the deciding calls took.
    pub ms: u64,
    /// The Jev vendor that answered.
    pub transport: Option<String>,
    /// True when Jev's backup vendor answered.
    pub fell_back: bool,
}

impl Label {
    fn to_json(&self) -> String {
        let mut parts = Vec::new();
        if let Some(u) = &self.urgency {
            parts.push(format!("\"urgency\":{}", quote(u)));
        }
        if let Some(k) = &self.kind {
            parts.push(format!("\"kind\":{}", quote(k)));
        }
        parts.push(format!("\"backend\":{}", quote(&self.backend)));
        parts.push(format!("\"ms\":{}", js_number(self.ms as f64)));
        if let Some(t) = &self.transport {
            parts.push(format!("\"transport\":{}", quote(t)));
        }
        if self.fell_back {
            parts.push("\"fellBack\":true".to_string());
        }
        format!("{{{}}}", parts.join(","))
    }
}

/// What the run needs to know about the user's settings.
struct Ctx {
    home: std::path::PathBuf,
    st: Settings,
    jev: JevSettings,
    haiku_only: bool,
    urgent_threshold: f64,
    deadline: Instant,
}

fn kinds() -> Vec<(String, String)> {
    defaults::raw("triage.kind_criteria")
        .as_array()
        .unwrap_or_default()
        .iter()
        .filter_map(|pair| {
            let p = pair.strings();
            (p.len() == 2).then(|| (p[0].to_string(), p[1].to_string()))
        })
        .collect()
}

fn float(key: &str) -> f64 {
    defaults::text(key).parse().unwrap_or(0.0)
}

fn remaining_ms(deadline: Instant) -> u64 {
    deadline.saturating_duration_since(Instant::now()).as_millis() as u64
}

/// The Jev half of `classifyOne`.
fn ask_jev(ctx: &Ctx, client: &JevClient, text: &str, out: &mut Label) {
    let min = defaults::num("triage.min_remaining_ms");
    let remaining = remaining_ms(ctx.deadline);
    if !ctx.jev.enabled || remaining <= min {
        return;
    }
    let kind_q = Question::choice(defaults::text("triage.kind_instructions"), kinds());
    let urg_q = Question::noul(defaults::text("triage.urgency_instructions"), defaults::text("triage.urgency_true"), defaults::text("triage.urgency_false"));
    let (kk, uk) = (defaults::text("triage.kind_key"), defaults::text("triage.urgency_key"));
    let state = slice16_lossy(text, defaults::num("triage.max_text") as usize);
    let timeout = min.max(remaining.min(ctx.jev.timeout_ms));
    let r = client.decide_multi(&ctx.jev, &[(kk.to_string(), kind_q.clone()), (uk.to_string(), urg_q.clone())], &state, Some(timeout));
    let mut conf = Vec::new();
    if r.call.reason.is_none() {
        let valid: Vec<String> = kinds().into_iter().map(|(k, _)| k).collect();
        for (key, ans) in &r.answers {
            let Ok((answer, c)) = ans else { continue };
            conf.push(format!("{}:{}", quote(key), js_number(*c)));
            match answer {
                Answer::Label(l) if key == kk && *c >= ctx.jev.confidence_threshold && valid.contains(l) => out.kind = Some(l.clone()),
                // Jev over-flags urgent: an urgent answer needs the stricter urgent threshold, a normal one the ordinary one
                Answer::Bool(true) if key == uk && *c >= ctx.urgent_threshold => out.urgency = Some(defaults::text("triage.urgent").to_string()),
                Answer::Bool(false) if key == uk && *c >= ctx.jev.confidence_threshold => out.urgency = Some(defaults::text("triage.normal").to_string()),
                _ => {}
            }
        }
        out.ms = r.call.ms;
        if out.kind.is_some() || out.urgency.is_some() {
            out.backend = defaults::text("triage.label_jev").to_string();
            out.transport = r.call.transport.map(|v| v.as_str().to_string());
            out.fell_back = r.call.fell_back;
        }
    }
    // the cascade: a label Jev was unsure of is judged again by the model, shown Jev's answer; the worker may wait for it
    if ctx.jev.cascade_on(defaults::text("triage.integration")) && r.call.reason.is_none() {
        let from_jev = out.kind.is_some() || out.urgency.is_some();
        let mut applied = false;
        for (key, ans) in &r.answers {
            let Ok((answer, c)) = ans else { continue };
            let is_kind = key == kk;
            let filled = if is_kind { out.kind.is_some() } else { out.urgency.is_some() };
            if filled || *c >= ctx.jev.cascade_below(defaults::text("triage.integration")) || remaining_ms(ctx.deadline) <= min {
                continue;
            }
            let case = cascade::Case { home: &ctx.home, id: defaults::text("triage.integration"), jev: (answer, *c), show: ctx.jev.cascade_show_jev };
            let rj = cascade::escalate(if is_kind { &kind_q } else { &urg_q }, &state, &case);
            let Ok(v) = rj.verdict else { continue };
            match &v.answer {
                Answer::Label(l) if is_kind && v.confidence >= ctx.jev.confidence_threshold => out.kind = Some(l.clone()),
                Answer::Bool(true) if !is_kind && v.confidence >= ctx.urgent_threshold => out.urgency = Some(defaults::text("triage.urgent").to_string()),
                Answer::Bool(false) if !is_kind && v.confidence >= ctx.jev.confidence_threshold => {
                    out.urgency = Some(defaults::text("triage.normal").to_string())
                }
                _ => continue,
            }
            out.ms += rj.ms;
            applied = true;
        }
        if applied {
            let h = defaults::text("triage.label_haiku");
            out.backend = if from_jev { format!("{}+{h}", defaults::text("triage.label_jev")) } else { h.to_string() };
        }
    }
    let reason = r.call.reason.as_ref().map(ToString::to_string);
    telemetry::record(
        &ctx.home,
        &telemetry::Row {
            integration: defaults::text("triage.integration"),
            backend: defaults::text("judge.backend_jev"),
            model: r.call.model.as_deref(),
            ms: r.call.ms,
            confidence: (!conf.is_empty()).then(|| format!("{{{}}}", conf.join(","))),
            decision: None,
            error: reason.as_deref(),
        },
    );
}

/// The model half of `classifyOne`, through the Claude CLI.
fn ask_model(ctx: &Ctx, text: &str, out: &mut Label) {
    let min = defaults::num("triage.min_remaining_ms");
    let remaining = remaining_ms(ctx.deadline);
    if remaining <= min {
        return;
    }
    let model = super::settings::model(&ctx.st);
    let input = format!("{}{}", defaults::text("triage.input_prefix"), slice16_lossy(text, defaults::num("triage.max_text") as usize));
    let env = cli::process_env();
    let res = cli::run(&cli::CliCall {
        system: defaults::text("triage.system_prompt"),
        model: &model,
        input: &input,
        env: &env,
        timeout: Duration::from_millis(min.max(remaining)),
    });
    // Node: `if (haiku && haiku.decision)`: a parsed answer that is falsy counts as no answer
    let d = res.result.as_ref().ok().and_then(|t| cli::parse_loose(t)).filter(crate::checks::replykit::io::truthy);
    let valid: Vec<String> = kinds().into_iter().map(|(k, _)| k).collect();
    let mut got = false;
    if let Some(d) = &d {
        if out.kind.is_none()
            && let Some(k) = d.get(defaults::text("triage.kind_key")).and_then(Value::as_str).filter(|k| valid.iter().any(|v| v.as_str() == *k))
        {
            out.kind = Some(k.to_string());
        }
        if out.urgency.is_none()
            && let Some(u) = d
                .get(defaults::text("triage.urgency_key"))
                .and_then(Value::as_str)
                .filter(|u| *u == defaults::text("triage.urgent") || *u == defaults::text("triage.normal"))
        {
            out.urgency = Some(u.to_string());
        }
        out.ms += res.ms;
        let h = defaults::text("triage.label_haiku");
        out.backend = if out.backend.is_empty() { h.to_string() } else { format!("{}+{h}", out.backend) };
        got = true;
    }
    let error = match &res.result {
        Err(e) => Some(e.word()),
        Ok(_) if !got => Some(defaults::text("judge.err_answer")),
        _ => None,
    };
    telemetry::record(
        &ctx.home,
        &telemetry::Row {
            integration: defaults::text("triage.integration"),
            backend: defaults::text("judge.backend_haiku_cli"),
            model: Some(&model),
            ms: res.ms,
            confidence: None,
            decision: None,
            error,
        },
    );
}

/// `classifyOne`: `None` when no label was confident.
fn classify(ctx: &Ctx, client: &JevClient, raw: &str) -> Option<Label> {
    let text = scrub_secrets(raw);
    let mut out = Label::default();
    if !ctx.haiku_only {
        ask_jev(ctx, client, &text, &mut out);
    }
    // the default backend reaches here only with no key visible (a key defers the whole run), so the model fills a
    // missing label only on the haiku backend
    if ctx.haiku_only && (out.kind.is_none() || out.urgency.is_none()) {
        ask_model(ctx, &text, &mut out);
    }
    if out.kind.is_none() && out.urgency.is_none() {
        return None;
    }
    if out.backend.is_empty() {
        out.backend = defaults::text("triage.label_unknown").to_string();
    }
    Some(out)
}

/// True for a key JavaScript orders before the others in an object: a canonical array index.
fn is_index(k: &str) -> bool {
    k.parse::<u32>().is_ok_and(|n| n != u32::MAX && n.to_string() == k)
}

/// `JSON.stringify(results)`: insertion order, except that array-index keys come first in ascending order.
fn results_json(results: &[(String, Option<Label>)]) -> String {
    let mut idx: Vec<&(String, Option<Label>)> = results.iter().filter(|(k, _)| is_index(k)).collect();
    idx.sort_by_key(|(k, _)| k.parse::<u32>().unwrap_or(0));
    let rest = results.iter().filter(|(k, _)| !is_index(k));
    let body: Vec<String> =
        idx.into_iter().chain(rest).map(|(k, v)| format!("{}:{}", quote(k), v.as_ref().map_or_else(|| "null".to_string(), Label::to_json))).collect();
    format!("{{{}}}", body.join(","))
}

/// Why the run is left to the Node worker, decided before any call.
fn needs_api(st: &Settings, haiku_only: bool) -> bool {
    // this one-shot process's environment is the whole caller environment, so a key's presence is always known
    if haiku_only { matches!(route(st, true), Route::Api | Route::Unknown) } else { anthropic_key_visible(st, true) != Some(false) }
}

/// The `jev triage` command; returns the exit code.
pub fn run_cmd() -> i32 {
    super::allow_blocking_calls();
    let started = Instant::now();
    let mut raw = String::new();
    crate::discard::harmless(std::io::stdin().read_to_string(&mut raw)); // keep: unreadable stdin is the empty request, as in Node
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let items: Vec<Value> = payload.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
    let timeout_ms =
        payload.get("timeoutMs").and_then(Value::as_f64).filter(|t| t.is_finite() && *t > 0.0).unwrap_or(defaults::num("triage.default_timeout_ms") as f64);
    let urgent_threshold =
        payload.get("urgentThreshold").and_then(Value::as_f64).filter(|t| (0.0..=1.0).contains(t)).unwrap_or_else(|| float("triage.default_urgent_threshold"));
    let valid = |it: &Value| -> Option<(String, String)> {
        let h = it.get("hash")?.as_str()?;
        let t = it.get("text")?.as_str()?;
        (!js_trim(t).is_empty()).then(|| (h.to_string(), t.to_string()))
    };
    let env = Env::process();
    let Some(home) = env.get(defaults::env_name("home")).filter(|h| !h.is_empty()).map(std::path::PathBuf::from) else {
        print!("{{}}");
        return 0;
    };
    let st = Settings { home: home.to_string_lossy().into_owned(), env: cli::process_env() };
    let haiku_only = integration_backend(&st, defaults::raw("triage.backend_setting")) == defaults::text("triage.backend_haiku");
    if items.iter().any(|i| valid(i).is_some()) && needs_api(&st, haiku_only) {
        eprintln!("{}", defaults::text("msg.jev_triage_defer"));
        return defaults::num("dispatch.defer_exit") as i32;
    }
    let jev = JevSettings::resolve(&home, Sources::load(&home, env));
    let client = crate::jev::assist::production_client(&home);
    let ctx = Ctx { home: home.clone(), st, jev, haiku_only, urgent_threshold, deadline: started + Duration::from_millis(timeout_ms as u64) };
    let min = Duration::from_millis(defaults::num("triage.min_remaining_ms"));
    let mut results: Vec<(String, Option<Label>)> = Vec::new();
    for item in &items {
        if Instant::now() + min >= ctx.deadline {
            break; // out of budget: the rest stay unlabelled and absent
        }
        let Some((hash, text)) = valid(item) else { continue };
        let label = classify(&ctx, &client, &text);
        match results.iter_mut().find(|(k, _)| *k == hash) {
            Some(slot) => slot.1 = label,
            None => results.push((hash, label)),
        }
    }
    print!("{}", results_json(&results));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn results_keep_node_key_order_and_field_order() {
        let l = Label {
            urgency: Some("urgent".into()),
            kind: Some("blocker".into()),
            backend: "jev".into(),
            ms: 3,
            transport: Some("vercel".into()),
            fell_back: true,
        };
        let r = vec![("b".to_string(), Some(l)), ("10".to_string(), None), ("a".to_string(), None), ("2".to_string(), None)];
        assert_eq!(
            results_json(&r),
            r#"{"2":null,"10":null,"b":{"urgency":"urgent","kind":"blocker","backend":"jev","ms":3,"transport":"vercel","fellBack":true},"a":null}"#
        );
        let only_kind = Label { kind: Some("fyi".into()), backend: "haiku".into(), ..Label::default() };
        assert_eq!(only_kind.to_json(), r#"{"kind":"fyi","backend":"haiku","ms":0}"#);
    }

    #[test]
    fn the_kind_table_is_the_node_one_in_order() {
        let k: Vec<String> = kinds().into_iter().map(|(k, _)| k).collect();
        assert_eq!(k, ["question-needs-answer", "blocker", "status-report", "done-report", "fyi"]);
    }
}
