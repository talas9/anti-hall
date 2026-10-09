//! One row per model call the engine makes, in `<home>/.anti-hall/` + `judge.telemetry_log`: when, which integration, which
//! backend and model, how long, how confident, what was decided and what went wrong. Never the prompt, the reply or a
//! key. Best effort: a failed write never changes a decision.
use crate::checks::jsport::num::to_js_string;
use crate::checks::replykit::io::now_ms;
use crate::checks::replykit::json::{quote};
use crate::defaults;
use std::io::Write;
use std::path::Path;

/// One call.
#[derive(Debug, Clone, Default)]
pub struct Row<'a> {
    /// The integration (`speculation`, `triage`).
    pub integration: &'a str,
    /// The backend that was called (`haiku-cli`, `jev`).
    pub backend: &'a str,
    /// The model alias asked for, or the model the vendor reported.
    pub model: Option<&'a str>,
    /// Elapsed milliseconds.
    pub ms: u64,
    /// The answer's confidence, when the backend reports one (a JSON value as text, `null` when absent).
    pub confidence: Option<String>,
    /// What the call decided, when it decided.
    pub decision: Option<&'a str>,
    /// Why it produced no answer.
    pub error: Option<&'a str>,
}

fn opt(s: Option<&str>) -> String {
    s.map_or_else(|| "null".to_string(), quote)
}

/// The row as one JSON line.
pub fn line(r: &Row<'_>) -> String {
    format!(
        "{{\"ts\":{},\"integration\":{},\"backend\":{},\"model\":{},\"ms\":{},\"confidence\":{},\"decision\":{},\"error\":{}}}\n",
        quote(&crate::jev::assist::iso_ms(now_ms() as u64)),
        quote(r.integration),
        quote(r.backend),
        opt(r.model),
        to_js_string(r.ms as f64),
        r.confidence.clone().unwrap_or_else(|| "null".to_string()),
        opt(r.decision),
        opt(r.error),
    )
}

/// Append `r` under `home`, emptying the log first when the row would take it past `judge.telemetry_max_bytes`.
pub fn record(home: &Path, r: &Row<'_>) {
    append(home, &line(r));
}

fn append(home: &Path, text: &str) {
    let rel = defaults::text("judge.telemetry_log");
    if rel.is_empty() {
        return;
    }
    let path = home.join(defaults::text("paths.base_dir")).join(rel);
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut f = if size + text.len() as u64 > defaults::num("judge.telemetry_max_bytes") {
            std::fs::File::create(&path)?
        } else {
            std::fs::OpenOptions::new().create(true).append(true).open(&path)?
        };
        f.write_all(text.as_bytes())
    };
    crate::discard::logged("judge_telemetry_write", write());
}

/// One Jev-first escalation: what Jev said, what the model said, whether they agree and what the second call cost in time.
#[derive(Debug, Clone)]
pub struct Escalation<'a> {
    /// The Jev integration.
    pub integration: &'a str,
    /// The model alias asked.
    pub model: &'a str,
    /// Jev's answer as text.
    pub jev_answer: String,
    /// Jev's confidence.
    pub jev_confidence: f64,
    /// The model's answer as text, when it gave one.
    pub haiku_answer: Option<String>,
    /// The model's confidence, when it gave an answer.
    pub haiku_confidence: Option<f64>,
    /// Whether the two answers are the same, when the model answered.
    pub agree: Option<bool>,
    /// Milliseconds the second call added.
    pub added_ms: u64,
    /// Whether the model was shown Jev's answer.
    pub show_jev_answer: bool,
    /// Why the model gave no answer.
    pub error: Option<&'a str>,
}

/// The escalation as one JSON line (the shared fields first, then the cascade's own).
pub fn escalation_line(e: &Escalation<'_>) -> String {
    let num = |n: Option<f64>| n.map_or_else(|| "null".to_string(), to_js_string);
    format!(
        "{{\"ts\":{},\"integration\":{},\"backend\":{},\"model\":{},\"ms\":{},\"confidence\":{},\"decision\":{},\"error\":{},\"jevAnswer\":{},\"jevConfidence\":{},\"haikuAnswer\":{},\"haikuConfidence\":{},\"agree\":{},\"addedMs\":{},\"showJevAnswer\":{}}}\n",
        quote(&crate::jev::assist::iso_ms(now_ms() as u64)),
        quote(e.integration),
        quote(defaults::text("cascade.backend")),
        quote(e.model),
        to_js_string(e.added_ms as f64),
        num(e.haiku_confidence),
        opt(e.haiku_answer.as_deref()),
        opt(e.error),
        quote(&e.jev_answer),
        to_js_string(e.jev_confidence),
        opt(e.haiku_answer.as_deref()),
        num(e.haiku_confidence),
        e.agree.map_or_else(|| "null".to_string(), |b| b.to_string()),
        to_js_string(e.added_ms as f64),
        e.show_jev_answer,
    )
}

/// Append an escalation row under `home` (same file, size cap and best-effort rule as [`record`]).
pub fn record_escalation(home: &Path, e: &Escalation<'_>) {
    append(home, &escalation_line(e));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_row_holds_the_call_and_nothing_else() {
        let l = line(&Row {
            integration: "speculation",
            backend: "haiku-cli",
            model: Some("haiku"),
            ms: 12,
            confidence: None,
            decision: Some("block"),
            error: None,
        });
        let v: serde_json::Value = serde_json::from_str(&l).unwrap();
        assert_eq!(
            (v["integration"].as_str(), v["backend"].as_str(), v["model"].as_str(), v["ms"].as_u64()),
            (Some("speculation"), Some("haiku-cli"), Some("haiku"), Some(12))
        );
        assert!(v["confidence"].is_null() && v["error"].is_null() && v["decision"] == "block");
    }
}
