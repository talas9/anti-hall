//! `ah-engine jev`: the agent-facing command for the Jev lane (D50).
//!
//! * `jev ask` reads requests as JSON, one per stdin line, asks through the same code the daemon uses, and prints each
//!   decision as one JSON line in the field names of Node's `ask()` (`final`, `h`, `costUsd`, ...). It is how the parity harness
//!   drives the Rust client against a loopback server, and it makes a real call when Jev is enabled and keyed, so it is
//!   not read-only.
//! * `jev scrub` reads JSON strings, one per stdin line, and prints each one's scrubbed text as a JSON string per line:
//!   the outbound redaction on its own, so it can be compared with Node's `scrubSecrets` over a large corpus.
//! * `jev status` prints the resolved settings and every integration's mode. It never prints a key, only whether one
//!   resolves.
use super::assist::{AskRequest, Decision, Jev, Trust};
use super::credentials::resolve_key;
use super::error::JevError;
use super::question::Question;
use super::settings::{Env, Vendor, known_integrations};
use crate::cli::Parsed;
use crate::defaults;
use serde::Deserialize;
use serde_json::{Value, json};
use std::io::Read;
use std::path::PathBuf;

/// The request `jev ask` reads.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    id: String,
    question: Question,
    state: String,
    #[serde(default)]
    trust: Option<String>,
    #[serde(default)]
    baseline: Value,
    #[serde(default)]
    cache_key: Option<String>,
    #[serde(default)]
    budget_ms: Option<u64>,
    #[serde(default)]
    compare: Option<bool>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    turn_ref: Option<String>,
    #[serde(default)]
    record_disagreement: bool,
}

fn trust_of(s: Option<&str>) -> Result<Trust, JevError> {
    match s.unwrap_or("add-block") {
        "add-block" => Ok(Trust::AddBlock),
        "advisory" => Ok(Trust::Advisory),
        "relax-block" => Ok(Trust::RelaxBlock),
        other => Err(JevError::Request(format!("unknown trust rule {other:?}"))),
    }
}

fn parse(text: &str) -> Result<AskRequest, JevError> {
    let w: Wire = serde_json::from_str(text).map_err(|e| JevError::Request(e.to_string()))?;
    let mut r = AskRequest::new(&w.id, w.question, &w.state, trust_of(w.trust.as_deref())?, w.baseline);
    r.cache_key = w.cache_key;
    r.budget_ms = w.budget_ms;
    r.compare = w.compare;
    r.project = w.project;
    r.session_id = w.session_id;
    r.turn_ref = w.turn_ref;
    r.record_disagreement = w.record_disagreement;
    Ok(r)
}

/// A decision in the field names Node's `ask()` returns.
fn decision_json(d: &Decision) -> Value {
    json!({
        "final": d.outcome, "jev": d.jev, "baseline": d.baseline, "confidence": d.confidence, "confident": d.confident,
        "ms": d.ms, "backend": d.backend.as_str(), "reason": d.reason.as_ref().map(|r| r.to_string()), "h": d.hash,
        "costUsd": d.cost_usd, "costSource": d.cost_source.map(|c| c.as_str()), "changed": d.changed,
    })
}

fn home() -> Result<PathBuf, JevError> {
    defaults::env_var("home").map(PathBuf::from).ok_or_else(|| JevError::Config(defaults::text("msg.jev_no_home").to_string()))
}

fn ask(p: &Parsed) -> Result<i32, JevError> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|e| JevError::Io { what: "read the requests from stdin".into(), source: e })?;
    // One Jev lane serves every line, so the answer cache works across the requests of one run.
    let jev = Jev::new(&home()?, Env::process());
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let v = decision_json(&jev.ask(&parse(line)?));
        if p.json {
            println!("{v}");
        } else {
            println!("{}", crate::cli::human(&v));
        }
    }
    Ok(0)
}

fn scrub() -> Result<i32, JevError> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|e| JevError::Io { what: "read the texts from stdin".into(), source: e })?;
    let mut out = String::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let s: String = serde_json::from_str(line).map_err(|e| JevError::Request(e.to_string()))?;
        out.push_str(&super::question::json_str(&super::scrub::scrub_secrets(&s)));
        out.push('\n');
    }
    print!("{out}");
    Ok(0)
}

fn status(p: &Parsed) -> Result<i32, JevError> {
    let home = home()?;
    let jev = Jev::new(&home, Env::process());
    let s = jev.settings();
    let key = |v: Vendor| resolve_key(&s, v).key.is_some();
    let modes: serde_json::Map<String, Value> = known_integrations().into_iter().map(|id| (id.to_string(), json!(s.mode(id, true).as_str()))).collect();
    let v = json!({
        "enabled": s.enabled, "transport": s.transport.as_str(), "fallback": s.fallback.map(Vendor::as_str),
        "timeout_ms": s.timeout_ms, "confidence_threshold": s.confidence_threshold,
        "key_resolves": {"vercel": key(Vendor::Vercel), "typesafe": key(Vendor::Typesafe)},
        "endpoint_override": s.has_endpoint_override(),
        "integrations": modes,
        "log": home.join(defaults::text("paths.base_dir")).join(defaults::text("jev.log_file")).display().to_string(),
    });
    if p.json {
        println!("{v}");
    } else {
        println!("{}", crate::cli::human(&v));
    }
    Ok(0)
}

/// The `jev` command handler: `ask`, `status` or `scrub`; returns the process exit code.
pub fn run_cmd(p: &Parsed) -> i32 {
    let sub = p.rest.first().map(String::as_str).unwrap_or("");
    let result = match sub {
        "ask" => ask(p),
        "status" => status(p),
        "scrub" => scrub(),
        _ => Err(JevError::Request(defaults::text("msg.jev_usage").to_string())),
    };
    match result {
        Ok(code) => code,
        Err(e) => {
            let msg = e.to_string();
            if p.json {
                println!("{}", json!({"error": msg}));
            } else {
                eprintln!("{msg}");
            }
            64
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_parses_with_defaults_and_keeps_the_criteria_order() {
        let r = parse(r#"{"id":"speculation","question":{"type":"choice","instructions":"i","criteria":{"b":"B","a":"A"}},"state":"s"}"#).unwrap();
        assert_eq!((r.trust, r.baseline.clone()), (Trust::AddBlock, Value::Null));
        assert_eq!(r.question.to_wire(), r#"{"type":"choice","instructions":"i","criteria":{"b":"B","a":"A"}}"#);
    }

    #[test]
    fn bad_requests_are_typed_errors() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"id":"x","question":{"type":"weird"},"state":"s"}"#).is_err());
        assert!(parse(r#"{"id":"x","question":{"type":"noul"},"state":"s","trust":"wild"}"#).is_err());
    }
}
