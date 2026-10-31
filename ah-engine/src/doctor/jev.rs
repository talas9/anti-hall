//! The Jev health check of `doctor`, shown only when Jev is enabled: one minimal test call through the configured transport,
//! classified by latency and error against the thresholds in `doctor.toml` (OK under `doctor.jev_warn_ms`, WARN from there to
//! `doctor.jev_fail_ms`, FAIL at or past it, or on any error). It uses its own client, so it never opens or closes the breakers
//! the hooks share. No vendor status endpoint is known, hence the test call.
use super::Doc;
use crate::defaults;
use crate::jev::breaker::SystemClock;
use crate::jev::client::JevClient;
use crate::jev::credentials::resolve_key;
use crate::jev::settings::{Env, JevSettings, Sources};
use crate::jev::transport::{HttpTransport, Transport};
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
    if resolve_key(s, s.transport).key.is_none() {
        doc.warnl(defaults::render("doctor_msg.jev_no_key", &[("transport", &transport_name)]));
        return;
    }
    let chain: Vec<crate::jev::settings::Vendor> = std::iter::once(s.transport).chain(s.fallback).collect();
    let models: Vec<String> = chain.iter().map(|v| format!("{}={}", v.as_str(), JevClient::model_for(s, *v))).collect();
    doc.ok(defaults::render("doctor_msg.jev_model", &[("models", &models.join(", "))]));
    if chain.contains(&crate::jev::settings::Vendor::Typesafe)
        && JevClient::model_for(s, crate::jev::settings::Vendor::Typesafe) == defaults::text("jev.model_typesafe")
    {
        doc.warnl(defaults::render("doctor_msg.jev_model_alias", &[("model", &defaults::text("jev.model_typesafe"))]));
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::testkit::{Fake, ok};

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn settings(env: &[(&str, &str)]) -> JevSettings {
        let home = std::env::temp_dir().join("ah-doctor-jev-nohome");
        JevSettings::resolve(&home, Sources::with_files(Default::default(), Env::from_pairs(env.iter().copied())))
    }

    fn run(env: &[(&str, &str)], script: Vec<Result<crate::jev::transport::RawResponse, crate::jev::transport::NetError>>) -> (Doc, Arc<Fake>) {
        let f = Arc::new(Fake::new(script));
        let mut doc = Doc::default();
        check(&mut doc, &settings(env), f.clone());
        (doc, f)
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
