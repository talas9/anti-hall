//! The Jev health check of `doctor`, shown only when Jev is enabled: one minimal test call through the configured transport,
//! classified by latency and error against the thresholds in `doctor.toml` (OK under `doctor.jev_warn_ms`, WARN from there to
//! `doctor.jev_fail_ms`, FAIL at or past it, or on any error). It uses its own client, so it never opens or closes the breakers
//! the hooks share. No vendor status endpoint is known, hence the test call.
use super::Doc;
use crate::defaults;
use crate::jev::breaker::SystemClock;
use crate::jev::client::JevClient;
use crate::jev::credentials::{key_file_path, resolve_key};
use crate::jev::settings::{Env, JevSettings, Sources, Vendor};
use crate::jev::transport::{HttpTransport, NetError, Request, Transport, endpoint_for};
use crate::jev::{Question, Reason};
use std::path::Path;
use std::sync::Arc;

/// The section for the home `home` under the environment `env`: nothing when the check is off or Jev is not enabled.
pub fn section(doc: &mut Doc, home: &Path, env: &std::collections::BTreeMap<String, String>) {
    if defaults::num("doctor.jev_check") == 0 {
        return;
    }
    let s = JevSettings::resolve(home, Sources::load(home, Env::from_pairs(env.clone())));
    check(doc, &s, Arc::new(HttpTransport::new()));
}

/// The check over `transport` (a stub in the tests).
fn check(doc: &mut Doc, s: &JevSettings, transport: Arc<dyn Transport>) {
    if !s.enabled {
        return;
    }
    doc.head(defaults::text("doctor_msg.head_jev"));
    let transport_name = s.transport.as_str();
    let chain: Vec<Vendor> = std::iter::once(s.transport).chain(s.fallback).collect();
    if !s.allow_legacy_key_read {
        for v in &chain {
            let path = key_file_path(s, *v);
            if path.is_file() {
                doc.warnl(defaults::render("doctor_msg.jev_key_file_unread", &[("vendor", &v.as_str()), ("path", &path.display())]));
            }
        }
    }
    if resolve_key(s, s.transport).key.is_none() {
        doc.warnl(defaults::render("doctor_msg.jev_no_key", &[("transport", &transport_name)]));
        return;
    }
    for v in &chain {
        if let Some(src) = resolve_key(s, *v).source {
            doc.infol(defaults::render("doctor_msg.jev_key_source", &[("vendor", &v.as_str()), ("source", &src.label())]));
        }
    }
    let models: Vec<String> = chain.iter().map(|v| format!("{}={}", v.as_str(), JevClient::model_for(s, *v))).collect();
    doc.ok(defaults::render("doctor_msg.jev_model", &[("models", &models.join(", "))]));
    if chain.contains(&Vendor::Typesafe) {
        let pin = JevClient::model_for(s, Vendor::Typesafe);
        if pin == defaults::text("jev.model_typesafe") {
            doc.warnl(defaults::render("doctor_msg.jev_model_alias", &[("model", &defaults::text("jev.model_typesafe"))]));
        } else if pin == defaults::text("jev.model_pin") {
            newer_model(doc, s, &transport, &pin);
        }
    }
    let fail_ms = defaults::num("doctor.jev_fail_ms");
    let question = Question::noul(defaults::text("doctor.jev_question"), defaults::text("doctor.jev_yes"), defaults::text("doctor.jev_no"));
    let r = JevClient::new(transport, Arc::new(SystemClock)).decide(s, &question, defaults::text("doctor.jev_state"), Some(fail_ms));
    let args: [(&str, &dyn std::fmt::Display); 3] = [("ms", &r.ms), ("transport", &transport_name), ("limit", &fail_ms)];
    match &r.reason {
        Some(reason) => {
            let why = if matches!(reason, Reason::Timeout) { defaults::render("doctor_msg.jev_timeout", &args) } else { reason.to_string() };
            doc.bad(defaults::render("doctor_msg.jev_fail", &[("why", &why), ("ms", &r.ms), ("transport", &transport_name)]));
        }
        None if r.ms >= fail_ms => doc.bad(defaults::render("doctor_msg.jev_slow_fail", &args)),
        None if r.ms >= defaults::num("doctor.jev_warn_ms") => doc.warnl(defaults::render("doctor_msg.jev_slow_warn", &args)),
        None => doc.ok(defaults::render("doctor_msg.jev_ok", &args)),
    }
}

/// `scheme://host[:port]` of `url`, without a path.
fn origin(url: &str) -> &str {
    let start = url.find("://").map_or(0, |i| i + 3);
    url[start..].find('/').map_or(url, |i| &url[..start + i])
}

/// Warn when the provider lists a non-preview model released after the shipped pin. Fail-open: any read problem is one
/// info line and the check is skipped. The key goes only into the request's Authorization header.
fn newer_model(doc: &mut Doc, s: &JevSettings, transport: &Arc<dyn Transport>, pin: &str) {
    let Some(key) = resolve_key(s, Vendor::Typesafe).key else { return };
    let url = format!("{}{}", origin(&endpoint_for(s, Vendor::Typesafe, s.transport == Vendor::Typesafe)), defaults::text("jev.models_path"));
    let timeout = std::time::Duration::from_millis(s.timeout_ms);
    let skipped = |doc: &mut Doc, why: String| doc.infol(defaults::render("doctor_msg.jev_models_unreachable", &[("why", &why)]));
    let resp = match transport.send(&Request { body: None, url: &url, bearer: key.expose(), timeout }) {
        Ok(r) => r,
        Err(NetError::Timeout) => return skipped(doc, defaults::text("jevrep.reason_timeout").to_string()),
        Err(NetError::Network) => return skipped(doc, defaults::text("jevrep.reason_network").to_string()),
    };
    if !(200..300).contains(&resp.status) {
        return skipped(doc, defaults::render("jevrep.reason_http", &[("status", &resp.status)]));
    }
    let parsed = resp.body.ok().and_then(|b| serde_json::from_str::<serde_json::Value>(&b).ok());
    let Some(list) = parsed.as_ref().and_then(|v| v.get(defaults::text("jev.models_list_field"))).and_then(|v| v.as_array()) else {
        return skipped(doc, defaults::text("jevrep.reason_parse").to_string());
    };
    let released = defaults::text("jev.model_pin_released");
    let mut newer: Vec<(&str, &str)> = list
        .iter()
        .filter_map(|m| {
            let id = m.get(defaults::text("jev.models_name_field"))?.as_str()?;
            let date = m.get(defaults::text("jev.models_date_field"))?.as_str()?.get(..released.len())?;
            (!id.contains(defaults::text("jev.models_preview_marker")) && date > released).then_some((id, date))
        })
        .collect();
    newer.sort_by(|a, b| b.1.cmp(a.1));
    let question = Question::noul(defaults::text("doctor.jev_question"), defaults::text("doctor.jev_yes"), defaults::text("doctor.jev_no"));
    for (id, date) in newer {
        // A moving alias is only "newer" when it answers a different model id than the pin: one cheap call, doctor only.
        let mut probe = s.clone();
        probe.model_pin = Some(id.to_string());
        let r = JevClient::new(transport.clone(), Arc::new(SystemClock)).decide(&probe, &question, defaults::text("doctor.jev_state"), Some(s.timeout_ms));
        if r.transport == Some(Vendor::Typesafe) && r.model.as_deref() == Some(pin) {
            doc.infol(defaults::render("doctor_msg.jev_model_alias_same", &[("model", &id), ("pin", &pin)]));
            continue;
        }
        doc.warnl(defaults::render("doctor_msg.jev_model_newer", &[("model", &id), ("date", &date), ("pin", &pin), ("pin_date", &released)]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::testkit::{Fake, ok};

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn settings(env: &[(&str, &str)]) -> JevSettings {
        let home = crate::testtmp::path(format!("ah-doctor-jev-nohome-{}", std::process::id()));
        JevSettings::resolve(&home, Sources::with_files(Default::default(), Env::from_pairs(env.iter().copied())))
    }

    fn run(env: &[(&str, &str)], script: Vec<Result<crate::jev::transport::RawResponse, crate::jev::transport::NetError>>) -> (Doc, Arc<Fake>) {
        let f = Arc::new(Fake::new(script));
        let mut doc = Doc::default();
        check(&mut doc, &settings(env), f.clone());
        (doc, f)
    }

    const TS: [(&str, &str); 3] =
        [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT", "typesafe"), ("CLAUDE_PLUGIN_OPTION_JEV_TYPESAFE_API_KEY", "tk-secret")];

    fn texts(doc: &Doc) -> Vec<String> {
        doc.sections.iter().flat_map(|s| s.1.iter().map(|(_, m)| m.clone())).collect()
    }

    fn models(body: &str) -> Vec<Result<crate::jev::transport::RawResponse, crate::jev::transport::NetError>> {
        vec![ok(200, body), ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]
    }

    #[test]
    fn a_newer_non_preview_model_warns_and_the_key_stays_in_the_header() {
        let body = r#"{"models":[{"name":"jev-latest","release_date":"2026-10-23T02:00:00+00:00"},{"name":"jev-preview","release_date":"2026-11-01T00:00:00+00:00"}]}"#;
        let (doc, f) = run(&TS, with_probe(body, "jev-1.15.0"));
        assert_eq!(doc.warn, 1, "only jev-latest counts; the preview is skipped");
        let t = texts(&doc);
        assert!(t.iter().any(|m| m.contains("newer model available: jev-latest 2026-10-23")), "{t:?}");
        assert!(t.iter().all(|m| !m.contains("tk-secret")));
        let seen = f.seen.lock().unwrap();
        assert_eq!(seen[0].0, "https://api.typesafe.ai/v1/models");
        assert_eq!((seen[0].1.as_str(), seen[0].2.clone()), ("tk-secret", None), "a GET with the key as bearer");
    }

    fn with_probe(body: &str, answered: &str) -> Vec<Result<crate::jev::transport::RawResponse, crate::jev::transport::NetError>> {
        vec![ok(200, body), ok(200, &format!(r#"{{"model":"{answered}","answers":{{"decision":{{"noul":0.9}}}}}}"#)), ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]
    }

    #[test]
    fn an_alias_dated_after_the_pin_that_answers_the_pinned_id_does_not_warn() {
        let body = r#"{"models":[{"name":"jev-latest","release_date":"2026-10-23T02:00:00+00:00"}]}"#;
        let (doc, f) = run(&TS, with_probe(body, "jev-1.14.0"));
        assert_eq!(doc.warn, 0, "{:?}", texts(&doc));
        assert!(texts(&doc).iter().any(|m| m.contains("answers the pinned model jev-1.14.0")));
        assert!(f.seen.lock().unwrap()[1].2.as_deref().is_some_and(|b| b.contains(r#""model":"jev-latest""#)), "the probe asked for the alias");
    }

    #[test]
    fn an_alias_that_answers_no_id_falls_back_to_the_date_warning() {
        let body = r#"{"models":[{"name":"jev-latest","release_date":"2026-10-23T02:00:00+00:00"}]}"#;
        let (doc, _) = run(&TS, models(body).into_iter().take(1).chain([ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#), ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]).collect());
        assert_eq!(doc.warn, 1);
    }

    #[test]
    fn a_model_not_newer_than_the_pin_does_not_warn() {
        let body = r#"{"models":[{"name":"jev-latest","release_date":"2026-10-14T20:14:00+00:00"}]}"#;
        assert_eq!(run(&TS, models(body)).0.warn, 0);
    }

    #[test]
    fn an_unreadable_model_list_is_one_info_line_and_the_check_goes_on() {
        for script in [
            vec![Err(crate::jev::transport::NetError::Network), ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)],
            vec![ok(500, "x"), ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)],
            vec![ok(200, "junk"), ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)],
        ] {
            let (doc, _) = run(&TS, script);
            assert_eq!((doc.warn, doc.fail), (0, 0));
            assert_eq!(texts(&doc).iter().filter(|m| m.contains("model list not checked")).count(), 1);
        }
    }

    #[test]
    fn an_overridden_pin_skips_the_list_read() {
        let mut s = settings(&TS);
        s.model_pin = Some("jev-1.13.0".into());
        let f = Arc::new(Fake::new(vec![ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]));
        let mut doc = Doc::default();
        check(&mut doc, &s, f.clone());
        assert_eq!(f.seen.lock().unwrap().len(), 1, "only the test call");
    }

    #[test]
    fn a_key_file_that_is_not_read_warns_with_the_fix() {
        let home = std::env::temp_dir().join(format!("ah-doctor-jev-keyfile-{}", std::process::id()));
        std::fs::create_dir_all(home.join(".config/typesafe")).unwrap();
        std::fs::write(home.join(".config/typesafe/key"), "file-key\n").unwrap();
        let s = JevSettings::resolve(&home, Sources::with_files(Default::default(), Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_TRANSPORT", "typesafe")])));
        let mut doc = Doc::default();
        check(&mut doc, &s, Arc::new(Fake::new(vec![])));
        let t = texts(&doc);
        assert!(t.iter().any(|m| m.contains("not read") && m.contains("allowLegacyKeyRead") && !m.contains("file-key")), "{t:?}");
        assert_eq!(doc.warn, 2, "the unread file, then the missing key");
        crate::discard::harmless(std::fs::remove_dir_all(&home)); // keep: test cleanup
    }

    #[test]
    fn the_origin_drops_the_path() {
        assert_eq!(origin("https://api.typesafe.ai/v1/systemone"), "https://api.typesafe.ai");
        assert_eq!(origin("http://127.0.0.1:9"), "http://127.0.0.1:9");
    }

    #[test]
    fn a_disabled_jev_adds_no_section_and_makes_no_call() {
        let (doc, f) = run(&[], vec![]);
        assert_eq!((doc.pass, doc.warn, doc.fail), (0, 0, 0));
        assert!(f.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn a_fast_answer_is_ok() {
        let (doc, f) = run(&ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]);
        assert_eq!((doc.pass, doc.warn, doc.fail), (2, 0, 0)); // the model line and the answer
        assert_eq!(f.seen.lock().unwrap().len(), 1, "one minimal test call");
        let t = f.timeouts.lock().unwrap()[0];
        assert_eq!(t, std::time::Duration::from_millis(defaults::num("doctor.jev_fail_ms")), "the fail threshold is the call's budget");
    }

    #[test]
    fn an_error_answer_fails_and_a_missing_key_warns() {
        for script in [vec![ok(500, "x")], vec![ok(429, "x")], vec![ok(200, "junk")], vec![]] {
            let (doc, _) = run(&ON, script);
            assert_eq!((doc.pass, doc.warn, doc.fail), (1, 0, 1)); // the model line, then the failure
        }
        let (doc, f) = run(&[("ANTIHALL_JEV", "1")], vec![]);
        assert_eq!((doc.pass, doc.warn, doc.fail), (0, 1, 0));
        assert!(f.seen.lock().unwrap().is_empty(), "no key, no call");
    }
}
