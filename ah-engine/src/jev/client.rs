//! The Jev client: one decision call through the primary vendor with an optional backup vendor, under one budget.
//!
//! Mirrors `hooks/lib/jev-client.js` (`jevDecide`, `jevDecideMulti`, `runWithFallback`, `attemptTransport`,
//! `extractCostAndUsage`). Every failure mode (disabled, no key, timeout, network error, non-2xx, unparsable body,
//! malformed answer) is a [`CallResult`] with a [`Reason`]; nothing here panics or returns an error, so a caller always
//! has its own baseline to fall back on (D35).
//!
//! Fallback rules (D13). The backup is tried once, inside the SAME total budget, only after a fallback-ELIGIBLE failure
//! of the primary: a timeout, a network error, a 5xx, a 402, a 429, or a 400 or 403 whose body names an exhausted
//! balance. A 401 or 403 is deliberately not eligible: a rejected key is a configuration error the owner must see, and
//! silently using the backup would hide it. Breakers are per vendor: an open primary is skipped, an open backup is not
//! tried, and when both are open no call is made.
// Discard triage (E3): every `.ok()` / `unwrap_or_default()` in this file is a deliberate keep, for these reasons:
// - text that does not parse or decode is the absent value (Node Number()/JSON.parse catch parity)
// A failure that must be seen goes through `crate::discard` instead.

use super::breaker::{Breakers, Clock};
use super::credentials::{Key, resolve_key};
use super::error::Reason;
use super::question::{Kind, Question, js_key_order, json_str};
use super::scrub::scrub_secrets;
use super::settings::{JevSettings, Vendor};
use super::transport::{Posted, Transport, endpoint_for, post_systemone};
use crate::defaults;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;

/// A decoded answer.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// A Noul answer: true when the reported probability is at least one half.
    Bool(bool),
    /// A Choice answer: the chosen label.
    Label(String),
}

impl Answer {
    /// The answer as JSON, as it is written in the decision log.
    pub fn to_json(&self) -> Value {
        match self {
            Answer::Bool(b) => Value::Bool(*b),
            Answer::Label(s) => Value::String(s.clone()),
        }
    }
}

/// The result of one Jev call (Node: the object `jevDecide` returns).
#[derive(Debug, Clone, PartialEq)]
pub struct CallResult {
    /// The answer, when the call succeeded.
    pub answer: Option<Answer>,
    /// Confidence in `[0, 1]` (for Noul, `|p - 0.5| * 2`).
    pub confidence: f64,
    /// Why there is no answer.
    pub reason: Option<Reason>,
    /// Elapsed milliseconds of the deciding attempt.
    pub ms: u64,
    /// Cost the vendor reported, in USD.
    pub cost: Option<f64>,
    /// Input tokens the vendor reported.
    pub tokens_in: Option<f64>,
    /// Output tokens the vendor reported.
    pub tokens_out: Option<f64>,
    /// The model the vendor reported.
    pub model: Option<String>,
    /// The vendor that answered, or was last tried.
    pub transport: Option<Vendor>,
    /// True when the backup vendor answered after the primary failed.
    pub fell_back: bool,
    /// The backup's failure reason, when both vendors failed.
    pub fallback_reason: Option<Reason>,
    /// True when an error body named an exhausted balance (internal to the fallback decision).
    pub(crate) balance: bool,
}

impl CallResult {
    /// True when the call produced an answer.
    pub fn ok(&self) -> bool {
        self.answer.is_some()
    }

    /// A failure without a network attempt.
    pub fn failed(reason: Reason) -> CallResult {
        CallResult { reason: Some(reason), ..CallResult::blank() }
    }

    /// A successful result: an answer with its confidence and elapsed time, no usage reported.
    pub fn answered(answer: Answer, confidence: f64, ms: u64) -> CallResult {
        CallResult { answer: Some(answer), confidence, ms, ..CallResult::blank() }
    }

    fn blank() -> CallResult {
        CallResult {
            answer: None,
            confidence: 0.0,
            reason: None,
            ms: 0,
            cost: None,
            tokens_in: None,
            tokens_out: None,
            model: None,
            transport: None,
            fell_back: false,
            fallback_reason: None,
            balance: false,
        }
    }
}

/// One key's outcome of a multi-question call.
pub type KeyAnswer = Result<(Answer, f64), Reason>;

/// The result of a multi-question call: the request-level outcome plus one outcome per question key.
#[derive(Debug, Clone, PartialEq)]
pub struct MultiResult {
    /// The request-level outcome (its `answer` is unused; a failure here means no key was answered).
    pub call: CallResult,
    /// One entry per question, in the order the questions were sent.
    pub answers: Vec<(String, KeyAnswer)>,
}

/// Cost and usage the response reported (Node: `extractCostAndUsage`); each field is `None` when absent, never a guess.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Usage {
    /// USD charged.
    pub cost: Option<f64>,
    /// Input tokens.
    pub tokens_in: Option<f64>,
    /// Output tokens.
    pub tokens_out: Option<f64>,
    /// The model name.
    pub model: Option<String>,
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// A number from a JSON number, or from a non-blank numeric string (the gateway reports its costs as strings).
fn number_or_numeric_string(v: Option<&Value>) -> Option<f64> {
    match v? {
        Value::String(s) if !s.trim().is_empty() => s.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
        other => finite(Some(other)),
    }
}

/// Extract cost, token counts and model from a response body. The field names and their order are Node's, which
/// documents where each was verified (TypeSafe's `usage` and `model`; the gateway's `provider_metadata.gateway.cost`
/// measured live; the rest defensive).
pub fn extract_usage(json: &Value) -> Usage {
    let mut u = Usage::default();
    if !json.is_object() {
        return u;
    }
    u.cost = finite(json.get("total_cost")).or_else(|| finite(json.get("gateway_cost"))).or_else(|| finite(json.get("market_cost")));
    if u.cost.is_none()
        && let Some(gw) = json.get("provider_metadata").and_then(|m| m.get("gateway")).filter(|g| g.is_object())
    {
        u.cost = number_or_numeric_string(gw.get("cost"))
            .or_else(|| number_or_numeric_string(gw.get("gatewayCost")))
            .or_else(|| number_or_numeric_string(gw.get("marketCost")));
    }
    u.tokens_in = finite(json.get("tokens_prompt"));
    u.tokens_out = finite(json.get("tokens_completion"));
    if let Some(usage) = json.get("usage").filter(|x| x.is_object()) {
        if u.tokens_in.is_none() {
            u.tokens_in = finite(usage.get("input_tokens")).or_else(|| finite(usage.get("prompt_tokens"))).or_else(|| finite(usage.get("promptTokens")));
        }
        if u.tokens_out.is_none() {
            u.tokens_out =
                finite(usage.get("output_tokens")).or_else(|| finite(usage.get("completion_tokens"))).or_else(|| finite(usage.get("completionTokens")));
        }
    }
    u.model = json.get("model").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    u
}

/// Decode one question's answer (Node: `parseAnswerFor`).
pub fn parse_answer(kind: Kind, ans: Option<&Value>) -> KeyAnswer {
    let ans = ans.filter(|a| a.is_object()).ok_or(Reason::BadResponse)?;
    match kind {
        Kind::Choice => {
            let label = ans.get("choice").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or(Reason::BadResponse)?;
            Ok((Answer::Label(label.to_string()), finite(ans.get("confidence")).unwrap_or(0.0)))
        }
        Kind::Noul => {
            let p = finite(ans.get("noul")).ok_or(Reason::BadResponse)?;
            Ok((Answer::Bool(p >= 0.5), (p - 0.5).abs() * 2.0))
        }
    }
}

/// One vendor to try: which vendor, whether it is the primary (the generic test endpoint applies to the primary only) and
/// its key.
struct Target<'a> {
    vendor: Vendor,
    primary: bool,
    key: &'a Key,
}

/// Parses a vendor's JSON into the call result: `(json, ms)`.
type Parse<'a> = &'a dyn Fn(&Value, u64) -> CallResult;

/// The Jev client: a transport, the breakers and a clock. Cheap to share; holds no per-call state.
pub struct JevClient {
    transport: Arc<dyn Transport>,
    breakers: Breakers,
    clock: Arc<dyn Clock>,
}

/// The budget of one call in milliseconds: the caller's request when it is positive, else the configured one, and never
/// more than `jev.max_timeout_ms`, whatever was asked (a `u64::MAX` request is the ceiling, not an overflow).
fn budget_for(s: &JevSettings, requested: Option<u64>) -> u64 {
    // inside a daemon request, never past the time its client still waits (review finding 4): an answer that arrives later
    // is lost, and the client's own Node fallback answers instead
    let left = crate::deadline::remaining().map_or(u64::MAX, |d| d.as_millis() as u64);
    let ceiling = defaults::num("jev.max_timeout_ms").min(left);
    match requested {
        Some(t) if t > 0 => t.min(ceiling),
        _ => s.timeout_ms.min(ceiling),
    }
}

fn is_eligible(r: &CallResult) -> bool {
    match &r.reason {
        None => false,
        Some(Reason::Timeout | Reason::NetworkError) => true,
        Some(Reason::Http(s)) => {
            let listed = |key: &str| defaults::raw(key).as_array().is_some_and(|a| a.iter().any(|v| v.as_integer() == Some(i64::from(*s))));
            u64::from(*s) >= defaults::num("jev.retry_status_min") || listed("jev.retry_statuses") || (r.balance && listed("jev.retry_statuses_balance"))
        }
        Some(_) => false,
    }
}

impl JevClient {
    /// A client over `transport` and `clock`.
    pub fn new(transport: Arc<dyn Transport>, clock: Arc<dyn Clock>) -> JevClient {
        JevClient { transport, breakers: Breakers::new(clock.clone()), clock }
    }

    /// A client whose breakers are the given ones (the Node breaker file, shared with the hooks).
    pub fn with_breakers(transport: Arc<dyn Transport>, clock: Arc<dyn Clock>, breakers: Breakers) -> JevClient {
        JevClient { transport, breakers, clock }
    }

    /// True while `vendor`'s breaker is open.
    pub fn breaker_open(&self, vendor: Vendor) -> bool {
        self.breakers.is_open(vendor)
    }

    /// The model name sent to `vendor`.
    pub(crate) fn model_for(vendor: Vendor) -> &'static str {
        match vendor {
            Vendor::Vercel => defaults::text("jev.model_vercel"),
            Vendor::Typesafe => defaults::text("jev.model_typesafe"),
        }
    }

    /// One attempt against one vendor (Node: `attemptTransport`).
    fn attempt(&self, s: &JevSettings, target: &Target<'_>, body_for: &dyn Fn(&str) -> String, parse: Parse<'_>, budget_ms: u64) -> CallResult {
        let url = endpoint_for(s, target.vendor, target.primary);
        let body = body_for(Self::model_for(target.vendor));
        let mut out = match post_systemone(self.transport.as_ref(), self.clock.as_ref(), &url, target.key.expose(), &body, Duration::from_millis(budget_ms)) {
            Posted::Json(json, ms) => parse(&json, ms),
            Posted::Failed { reason, ms, balance } => {
                let mut f = CallResult::failed(reason);
                f.ms = ms;
                f.balance = balance;
                f
            }
        };
        out.transport = Some(target.vendor);
        out
    }

    /// Run a call through the primary and, when eligible, the backup, inside `total_ms` (Node: `runWithFallback`).
    fn run_with_fallback(&self, s: &JevSettings, total_ms: u64, body_for: &dyn Fn(&str) -> String, parse: Parse<'_>) -> CallResult {
        let total_ms = total_ms.min(defaults::num("jev.max_timeout_ms")); // belt and braces: no caller can lift the ceiling
        let primary_key = resolve_key(s, s.transport).key;
        let Some(primary_key) = primary_key else {
            let mut r = CallResult::failed(Reason::NoKey);
            r.transport = Some(s.transport);
            return r;
        };
        let fallback = s.fallback.and_then(|v| resolve_key(s, v).key.map(|k| (v, k)));
        let Some((fb_vendor, fb_key)) = fallback else {
            return self.attempt(s, &Target { vendor: s.transport, primary: true, key: &primary_key }, body_for, parse, total_ms);
        };
        let primary_open = self.breakers.is_open(s.transport);
        let fallback_open = self.breakers.is_open(fb_vendor);
        if primary_open && fallback_open {
            let mut r = CallResult::failed(Reason::CircuitOpen);
            r.transport = Some(s.transport);
            return r;
        }
        let t0 = self.clock.now_ms();
        let mut primary_res: Option<CallResult> = None;
        if !primary_open {
            let reserve = if fallback_open {
                0
            } else {
                defaults::num("jev.fallback_reserve_ms").min(total_ms.saturating_mul(defaults::num("jev.fallback_reserve_pct")) / 100)
            };
            let r = self.attempt(s, &Target { vendor: s.transport, primary: true, key: &primary_key }, body_for, parse, total_ms.saturating_sub(reserve));
            if r.ok() {
                self.breakers.record(s.transport, true);
                return r;
            }
            if !is_eligible(&r) {
                return r;
            }
            // A timeout under the SHORTENED primary budget proves nothing about the vendor: still fall back for this call, but
            // do not count it, or a merely slow primary would trip the breaker and divert text to the second vendor.
            if !(r.reason == Some(Reason::Timeout) && reserve > 0) {
                self.breakers.record(s.transport, false);
            }
            if fallback_open {
                return r;
            }
            primary_res = Some(r);
        }
        let remaining = total_ms.saturating_sub(self.clock.now_ms().saturating_sub(t0));
        if remaining < defaults::num("jev.min_fallback_ms") {
            return primary_res.unwrap_or_else(|| {
                let mut r = CallResult::failed(Reason::Timeout);
                r.transport = Some(s.transport);
                r
            });
        }
        let mut fb = self.attempt(s, &Target { vendor: fb_vendor, primary: false, key: &fb_key }, body_for, parse, remaining);
        if fb.ok() {
            self.breakers.record(fb_vendor, true);
            fb.fell_back = true;
            return fb;
        }
        if is_eligible(&fb) {
            self.breakers.record(fb_vendor, false);
        }
        match primary_res {
            None => fb,
            Some(mut p) => {
                p.fallback_reason = fb.reason;
                p
            }
        }
    }

    /// Ask one question (Node: `jevDecide`). `timeout_ms` overrides the configured budget, capped at the ceiling.
    pub fn decide(&self, s: &JevSettings, question: &Question, state: &str, timeout_ms: Option<u64>) -> CallResult {
        if super::js_trim(state).is_empty() {
            return CallResult::failed(Reason::BadState);
        }
        if !s.enabled {
            return CallResult::failed(Reason::Disabled);
        }
        let budget = budget_for(s, timeout_ms);
        // The ONE outbound scrub: every body, primary and fallback alike, carries the scrubbed text.
        let outbound = scrub_secrets(state);
        let kind = question.kind;
        let qwire = question.to_wire();
        let body_for = |model: &str| format!("{{\"state\":{},\"model\":{},\"questions\":{{\"decision\":{}}}}}", json_str(&outbound), json_str(model), qwire);
        let parse = |json: &Value, ms: u64| {
            let usage = extract_usage(json);
            match parse_answer(kind, json.get("answers").and_then(|a| a.get("decision"))) {
                Ok((answer, confidence)) => CallResult {
                    cost: usage.cost,
                    tokens_in: usage.tokens_in,
                    tokens_out: usage.tokens_out,
                    model: usage.model,
                    ..CallResult::answered(answer, confidence, ms)
                },
                Err(reason) => {
                    let mut f = CallResult::failed(reason);
                    f.ms = ms;
                    f
                }
            }
        };
        self.run_with_fallback(s, budget, &body_for, &parse)
    }

    /// Ask several questions about the same text in one round trip (Node: `jevDecideMulti`).
    pub fn decide_multi(&self, s: &JevSettings, questions: &[(String, Question)], state: &str, timeout_ms: Option<u64>) -> MultiResult {
        let failed = |r: Reason| MultiResult { call: CallResult::failed(r), answers: Vec::new() };
        if questions.is_empty() {
            return failed(Reason::BadQuestion);
        }
        if super::js_trim(state).is_empty() {
            return failed(Reason::BadState);
        }
        if !s.enabled {
            return failed(Reason::Disabled);
        }
        let budget = budget_for(s, timeout_ms); // Node applies no ceiling to a multi call; the engine does (a key never waits unbounded)
        let ordered = js_key_order(questions.iter().map(|(k, q)| (k.clone(), q.to_wire())).collect());
        let outbound = scrub_secrets(state);
        let qs: Vec<String> = ordered.iter().map(|(k, w)| format!("{}:{}", json_str(k), w)).collect();
        let body_for = |model: &str| format!("{{\"state\":{},\"model\":{},\"questions\":{{{}}}}}", json_str(&outbound), json_str(model), qs.join(","));
        let answers = std::cell::RefCell::new(Vec::new());
        let parse = |json: &Value, ms: u64| {
            let Some(map) = json.get("answers").filter(|a| a.is_object()) else {
                let mut f = CallResult::failed(Reason::BadResponse);
                f.ms = ms;
                return f;
            };
            *answers.borrow_mut() = ordered
                .iter()
                .map(|(k, _)| {
                    let kind = questions.iter().find(|(qk, _)| qk == k).map_or(Kind::Noul, |(_, q)| q.kind);
                    (k.clone(), parse_answer(kind, map.get(k)))
                })
                .collect::<Vec<_>>();
            CallResult { ms, ..CallResult::blank() }
        };
        let call = self.run_with_fallback(s, budget, &body_for, &parse);
        let answers = if call.reason.is_none() { answers.into_inner() } else { Vec::new() };
        MultiResult { call, answers }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::breaker::ManualClock;
    use crate::jev::settings::{Env, Sources};
    use crate::jev::testkit::{Fake, ok};
    use serde_json::json;

    fn settings(env: &[(&str, &str)], jev: Value) -> JevSettings {
        JevSettings::resolve(
            std::path::Path::new("/nohome"),
            Sources { env: Env::from_pairs(env.iter().copied()), settings: json!({"jev": jev}), legacy: json!({}) },
        )
    }

    fn client(f: &Arc<Fake>) -> JevClient {
        JevClient::new(f.clone(), Arc::new(ManualClock::default()))
    }

    const KEYS: [(&str, &str); 3] =
        [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"), ("CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY", "tk")];

    fn q() -> Question {
        Question::noul("Is it?", "yes", "no")
    }

    #[test]
    fn no_budget_a_caller_asks_for_can_pass_the_ceiling_or_overflow() {
        let ceiling = Duration::from_millis(defaults::num("jev.max_timeout_ms"));
        let both = json!({"transport": "vercel", "fallbackTransport": "typesafe"});
        for ask in [Some(u64::MAX), Some(u64::MAX / 100), Some(ceiling.as_millis() as u64 + 1)] {
            let f = Arc::new(Fake::new(vec![ok(500, "x"), ok(200, r#"{"answers":{"decision":{"noul":1}}}"#)]));
            let r = client(&f).decide(&settings(&KEYS, both.clone()), &q(), "hello", ask);
            assert!(r.ok(), "{ask:?}: the fallback still answers");
            assert!(f.timeouts.lock().unwrap().iter().all(|t| *t <= ceiling), "{ask:?}: {:?}", f.timeouts.lock().unwrap());
            let f = Arc::new(Fake::new(vec![ok(200, r#"{"answers":{"decision":{"noul":1}}}"#)]));
            let m = client(&f).decide_multi(&settings(&KEYS, both.clone()), &[("decision".into(), q())], "hello", ask);
            assert!(m.call.reason.is_none(), "{ask:?}");
            assert!(f.timeouts.lock().unwrap().iter().all(|t| *t <= ceiling), "{ask:?} multi: {:?}", f.timeouts.lock().unwrap());
        }
        let f = Arc::new(Fake::new(vec![ok(200, r#"{"answers":{"decision":{"noul":1}}}"#)]));
        client(&f).decide(&settings(&KEYS, json!({})), &q(), "hello", Some(0));
        assert_eq!(f.timeouts.lock().unwrap()[0], Duration::from_millis(1500), "zero means the configured budget");
    }

    #[test]
    fn a_noul_answer_is_decoded_with_its_confidence_and_usage() {
        let f = Arc::new(Fake::new(vec![ok(200, r#"{"answers":{"decision":{"noul":0.9}},"usage":{"input_tokens":10,"output_tokens":2},"model":"m"}"#)]));
        let r = client(&f).decide(&settings(&KEYS, json!({})), &q(), "hello", None);
        assert_eq!(r.answer, Some(Answer::Bool(true)));
        assert!((r.confidence - 0.8).abs() < 1e-12);
        assert_eq!((r.tokens_in, r.tokens_out, r.model.as_deref(), r.cost), (Some(10.0), Some(2.0), Some("m"), None));
        assert_eq!(r.transport, Some(Vendor::Vercel));
    }

    #[test]
    fn a_choice_answer_and_the_gateway_cost_string_are_decoded() {
        let f =
            Arc::new(Fake::new(vec![ok(200, r#"{"answers":{"decision":{"choice":"a","confidence":0.7}},"provider_metadata":{"gateway":{"cost":"0.0004"}}}"#)]));
        let r = client(&f).decide(&settings(&KEYS, json!({})), &Question::choice("p", vec![("a".into(), "A".into())]), "x", None);
        assert_eq!((r.answer, r.confidence, r.cost), (Some(Answer::Label("a".into())), 0.7, Some(0.0004)));
    }

    #[test]
    fn bad_input_and_a_disabled_jev_never_reach_the_network() {
        let f = Arc::new(Fake::new(vec![]));
        let c = client(&f);
        let on = settings(&KEYS, json!({}));
        assert_eq!(c.decide(&on, &q(), " \u{feff}\n", None).reason, Some(Reason::BadState));
        assert_eq!(c.decide(&settings(&[], json!({})), &q(), "x", None).reason, Some(Reason::Disabled));
        assert_eq!(c.decide(&settings(&[("ANTIHALL_JEV", "1")], json!({})), &q(), "x", None).reason, Some(Reason::NoKey));
        assert!(f.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn the_request_carries_the_scrubbed_state_the_vendors_model_and_only_its_own_key() {
        let f = Arc::new(Fake::new(vec![ok(200, r#"{"answers":{"decision":{"noul":1}}}"#)]));
        client(&f).decide(&settings(&KEYS, json!({})), &q(), "token=hunter2 hi", None);
        let (url, bearer, body) = f.seen.lock().unwrap()[0].clone();
        assert_eq!(url, "https://ai-gateway.vercel.sh/typesafe/v1/systemone");
        assert_eq!(bearer, "vk");
        assert_eq!(
            body.unwrap(),
            r#"{"state":"token=[REDACTED] hi","model":"typesafe-ai/jev","questions":{"decision":{"type":"noul","instructions":"Is it?","criteria":{"true":"yes","false":"no"}}}}"#
        );
    }

    #[test]
    fn a_malformed_answer_is_a_bad_response() {
        for body in [r#"{}"#, r#"{"answers":{"decision":{}}}"#, r#"{"answers":{"decision":{"noul":"x"}}}"#, r#"{"answers":{"decision":{"choice":""}}}"#] {
            let f = Arc::new(Fake::new(vec![ok(200, body)]));
            assert_eq!(client(&f).decide(&settings(&KEYS, json!({})), &q(), "x", None).reason, Some(Reason::BadResponse), "{body}");
        }
    }

    fn with_fallback() -> JevSettings {
        settings(&KEYS, json!({"fallbackTransport": "typesafe"}))
    }

    #[test]
    fn an_eligible_failure_retries_once_on_the_backup_with_the_backups_own_key_and_model() {
        let f = Arc::new(Fake::new(vec![ok(503, "down"), ok(200, r#"{"answers":{"decision":{"noul":0.1}}}"#)]));
        let r = client(&f).decide(&with_fallback(), &q(), "x", None);
        assert_eq!((r.answer, r.fell_back, r.transport), (Some(Answer::Bool(false)), true, Some(Vendor::Typesafe)));
        let seen = f.seen.lock().unwrap();
        assert_eq!((seen[0].1.as_str(), seen[1].1.as_str()), ("vk", "tk"));
        assert!(seen[0].2.as_ref().unwrap().contains("typesafe-ai/jev") && seen[1].2.as_ref().unwrap().contains("jev-latest"));
        assert_eq!(seen[1].0, "https://api.typesafe.ai/v1/systemone");
    }

    #[test]
    fn a_rejected_key_is_not_masked_by_the_backup_but_an_exhausted_balance_is_retried() {
        for status in [401, 404, 422] {
            let f = Arc::new(Fake::new(vec![ok(status, "no"), ok(200, "{}")]));
            let r = client(&f).decide(&with_fallback(), &q(), "x", None);
            assert_eq!(r.reason, Some(Reason::Http(status)));
            assert_eq!(f.seen.lock().unwrap().len(), 1, "{status} is not eligible");
        }
        for (status, body) in [(402, ""), (429, ""), (400, "insufficient credits"), (403, "quota exceeded")] {
            let f = Arc::new(Fake::new(vec![ok(status, body), ok(200, r#"{"answers":{"decision":{"noul":1}}}"#)]));
            assert!(client(&f).decide(&with_fallback(), &q(), "x", None).fell_back, "{status} {body}");
        }
    }

    #[test]
    fn both_vendors_failing_reports_the_primarys_reason_and_the_backups_alongside() {
        let f = Arc::new(Fake::new(vec![ok(500, ""), ok(502, "")]));
        let r = client(&f).decide(&with_fallback(), &q(), "x", None);
        assert_eq!((r.reason, r.fallback_reason), (Some(Reason::Http(500)), Some(Reason::Http(502))));
    }

    #[test]
    fn the_breaker_skips_a_failing_vendor_and_a_double_outage_costs_no_calls() {
        let n = defaults::num("jev.breaker_threshold") as usize;
        let f = Arc::new(Fake::new((0..2 * n).map(|_| ok(500, "")).collect()));
        let c = client(&f);
        let s = with_fallback();
        for _ in 0..n {
            c.decide(&s, &q(), "x", None);
        }
        assert!(c.breaker_open(Vendor::Vercel) && c.breaker_open(Vendor::Typesafe));
        let before = f.seen.lock().unwrap().len();
        assert_eq!(c.decide(&s, &q(), "x", None).reason, Some(Reason::CircuitOpen));
        assert_eq!(f.seen.lock().unwrap().len(), before, "no request was made");
    }

    #[test]
    fn a_slow_primary_under_the_shortened_budget_falls_back_without_tripping_its_breaker() {
        let n = defaults::num("jev.breaker_threshold") as usize;
        let script: Vec<_> = (0..n).flat_map(|_| [Err(crate::jev::transport::NetError::Timeout), ok(200, r#"{"answers":{"decision":{"noul":1}}}"#)]).collect();
        let f = Arc::new(Fake::new(script));
        let c = client(&f);
        for _ in 0..n {
            assert!(c.decide(&with_fallback(), &q(), "x", None).fell_back);
        }
        assert!(!c.breaker_open(Vendor::Vercel), "timeouts under the shortened budget are not counted");
    }

    #[test]
    fn inside_a_daemon_request_the_budget_never_outlasts_the_clients_deadline() {
        // review finding 4: jev.max_timeout_ms (3 s) outlasted the 2 s client deadline
        let s = settings(&KEYS, json!({"timeoutMs": 3000}));
        assert_eq!(budget_for(&s, None), 3000, "no request: the configured budget");
        crate::deadline::begin(std::time::Instant::now());
        let left = crate::deadline::remaining().unwrap().as_millis() as u64;
        assert!(budget_for(&s, None) <= left && budget_for(&s, Some(u64::MAX)) <= left);
        crate::deadline::end();
    }

    #[test]
    fn the_budget_is_capped_and_handed_to_the_transport() {
        assert_eq!(settings(&KEYS, json!({"timeoutMs": 99999})).timeout_ms, 3000);
        assert!(is_eligible(&{
            let mut r = CallResult::failed(Reason::Http(429));
            r.balance = false;
            r
        }));
    }

    #[test]
    fn a_multi_call_sends_all_questions_in_one_body_and_decodes_each_key_alone() {
        let f = Arc::new(Fake::new(vec![ok(200, r#"{"answers":{"b":{"noul":0.2},"a":{"choice":"x","confidence":0.5}}}"#)]));
        let qs = vec![("b".to_string(), q()), ("a".to_string(), Question::choice("p", vec![("x".into(), "X".into())])), ("c".to_string(), q())];
        let r = client(&f).decide_multi(&settings(&KEYS, json!({})), &qs, "t", None);
        assert!(r.call.ok() || r.call.reason.is_none());
        assert_eq!(r.answers.len(), 3);
        assert_eq!(r.answers[0].1, Ok((Answer::Bool(false), 0.6)));
        assert_eq!(r.answers[1].1, Ok((Answer::Label("x".into()), 0.5)));
        assert_eq!(r.answers[2].1, Err(Reason::BadResponse), "one missing answer never hides the others");
        assert!(f.seen.lock().unwrap()[0].2.as_ref().unwrap().contains(r#""questions":{"b":"#));
    }
}
