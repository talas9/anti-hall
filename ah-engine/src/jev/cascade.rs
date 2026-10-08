//! The Jev-first cascade: when Jev answers below an integration's escalation threshold, the local Claude CLI judges the same
//! evidence again (optionally shown Jev's answer and confidence) and its answer replaces Jev's.
//!
//! It lives in the shared Jev layer ([`super::assist::Jev::ask`]), so every integration that asks through the engine's lane
//! gets it with its own `jevCascade.<id>` switch. Where the time goes:
//! * a caller that cannot wait (a hook that blocks or nudges) gets Jev's answer now; the re-judged answer is stored beside it
//!   in the cache and read by the next ask of the same decision (the resident engine re-judges on a thread, a one-shot hook
//!   starts a detached `ah-engine jev ask` that does it);
//! * a caller nobody waits for (the detached ask, the queue worker, `jev triage`) waits for the model.
//!
//! Only the Claude CLI is used; the engine never calls the Anthropic API. Every escalation leaves one telemetry row
//! (`judge::telemetry::record_escalation`). Every number, word and prompt comes from `engine/defaults/judge.toml`.
use super::client::Answer;
use super::question::{Kind, Question};
use crate::checks::git::util::Settings;
use crate::checks::jsport::text::slice16_lossy;
use crate::defaults;
use crate::judge::{cli, settings, telemetry};
use serde_json::Value;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

static INFLIGHT: AtomicUsize = AtomicUsize::new(0);

/// What the model said.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// Its answer.
    pub answer: Answer,
    /// Its confidence in `[0, 1]`.
    pub confidence: f64,
}

/// One re-judge: what came back, how long it took and the model asked.
#[derive(Debug, Clone)]
pub struct Rejudged {
    /// The parsed answer, or the telemetry word for why there is none.
    pub verdict: Result<Verdict, &'static str>,
    /// Elapsed milliseconds.
    pub ms: u64,
    /// The model alias asked.
    pub model: String,
}

fn answer_text(a: &Answer) -> String {
    match a {
        Answer::Bool(b) => b.to_string(),
        Answer::Label(l) => l.clone(),
    }
}

/// The user turn: the question with its allowed answers, the evidence, and, when `jev` is given, the first answer.
pub fn input_for(q: &Question, state: &str, jev: Option<(&Answer, f64)>) -> String {
    let mut s = String::from(defaults::text("cascade.input_question"));
    s.push_str(&q.instructions);
    s.push_str(defaults::text("cascade.input_options"));
    for (label, meaning) in &q.criteria {
        s.push_str(&format!("{label}: {meaning}\n"));
    }
    s.push_str(defaults::text("cascade.input_evidence"));
    s.push_str(&slice16_lossy(state, defaults::num("cascade.max_evidence") as usize));
    if let Some((a, c)) = jev {
        s.push_str(&defaults::render("cascade.input_jev", &[("answer", &answer_text(a)), ("confidence", &c)]));
    }
    s
}

/// The model's reply as an answer to `q`: a boolean (or the word) for a yes/no question, one of the labels for a pick-one
/// question, and a confidence in `[0, 1]`.
pub fn parse_reply(q: &Question, text: &str) -> Option<Verdict> {
    let v = cli::parse_loose(text).or_else(|| {
        let t = cli::strip_fences(text);
        let (a, b) = (t.find('{')?, t.rfind('}')?);
        serde_json::from_str::<Value>(t.get(a..=b)?).ok()
    })?;
    let confidence = v.get(defaults::text("cascade.confidence_key")).and_then(Value::as_f64).filter(|c| (0.0..=1.0).contains(c))?;
    let raw = v.get(defaults::text("cascade.answer_key"))?;
    let answer = match q.kind {
        Kind::Noul => match raw {
            Value::Bool(b) => Answer::Bool(*b),
            Value::String(s) if s.trim().eq_ignore_ascii_case("true") => Answer::Bool(true),
            Value::String(s) if s.trim().eq_ignore_ascii_case("false") => Answer::Bool(false),
            _ => return None,
        },
        Kind::Choice => {
            let label = raw.as_str()?;
            q.criteria.iter().any(|(k, _)| k == label).then(|| Answer::Label(label.to_string()))?
        }
    };
    Some(Verdict { answer, confidence })
}

/// A test double for the model: what it is given decides what it answers. Unit tests only.
#[cfg(test)]
pub(crate) type TestModel = Box<dyn Fn(&cli::CliCall<'_>) -> cli::CliOutcome + Send + Sync>;
#[cfg(test)]
pub(crate) static TEST_MODEL: std::sync::Mutex<Option<TestModel>> = std::sync::Mutex::new(None);

fn call_model(call: &cli::CliCall<'_>) -> cli::CliOutcome {
    #[cfg(test)]
    if let Some(f) = TEST_MODEL.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        return f(call);
    }
    cli::run(call)
}

/// Ask the model once (blocking, for seconds). `show` is Jev's answer when the model may see it.
pub fn rejudge(home: &Path, q: &Question, state: &str, show: Option<(&Answer, f64)>) -> Rejudged {
    let st = Settings { home: home.to_string_lossy().into_owned(), env: cli::process_env() };
    let model = settings::model(&st);
    let input = input_for(q, state, show);
    let res = call_model(&cli::CliCall {
        system: defaults::text("cascade.system_prompt"),
        model: &model,
        input: &input,
        env: &st.env,
        timeout: Duration::from_millis(defaults::num("cascade.timeout_ms")),
    });
    let verdict = match &res.result {
        Err(e) => Err(e.word()),
        Ok(t) => parse_reply(q, t).ok_or(defaults::text("judge.err_answer")),
    };
    Rejudged { verdict, ms: res.ms, model }
}

/// What an escalation was about, for its telemetry row.
pub struct Case<'a> {
    /// The anti-hall home.
    pub home: &'a Path,
    /// The Jev integration id.
    pub id: &'a str,
    /// Jev's answer and confidence.
    pub jev: (&'a Answer, f64),
    /// Whether the model was shown Jev's answer.
    pub show: bool,
}

/// Re-judge and write the telemetry row; the verdict, when there is one.
pub fn escalate(q: &Question, state: &str, case: &Case<'_>) -> Rejudged {
    let r = rejudge(case.home, q, state, case.show.then_some(case.jev));
    telemetry::record_escalation(
        case.home,
        &telemetry::Escalation {
            integration: case.id,
            model: &r.model,
            jev_answer: answer_text(case.jev.0),
            jev_confidence: case.jev.1,
            haiku_answer: r.verdict.as_ref().ok().map(|v| answer_text(&v.answer)),
            haiku_confidence: r.verdict.as_ref().ok().map(|v| v.confidence),
            agree: r.verdict.as_ref().ok().map(|v| v.answer == *case.jev.0),
            added_ms: r.ms,
            show_jev_answer: case.show,
            error: r.verdict.as_ref().err().copied(),
        },
    );
    r
}

/// Run `work` on a background thread unless `cascade.inflight_cap` escalations are already running; false when it was
/// skipped (and a busy row written by `skipped`).
pub fn spawn_limited(work: impl FnOnce() + Send + 'static, skipped: impl FnOnce()) -> bool {
    if INFLIGHT.fetch_add(1, Ordering::SeqCst) >= defaults::num("cascade.inflight_cap") as usize {
        INFLIGHT.fetch_sub(1, Ordering::SeqCst);
        skipped();
        return false;
    }
    std::thread::spawn(move || {
        work();
        INFLIGHT.fetch_sub(1, Ordering::SeqCst);
    });
    true
}

/// Escalations running on background threads now (tests wait on it).
pub fn inflight() -> usize {
    INFLIGHT.load(Ordering::SeqCst)
}

/// The row of an escalation that was skipped because `cascade.inflight_cap` were already running.
pub fn record_busy(home: &Path, id: &str, jev: &Answer, jev_confidence: f64, show: bool) {
    telemetry::record_escalation(
        home,
        &telemetry::Escalation {
            integration: id,
            model: "",
            jev_answer: answer_text(jev),
            jev_confidence,
            haiku_answer: None,
            haiku_confidence: None,
            agree: None,
            added_ms: 0,
            show_jev_answer: show,
            error: Some(defaults::text("cascade.err_busy")),
        },
    );
}
