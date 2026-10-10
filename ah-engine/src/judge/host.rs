//! The speculation judge's model call, as the one host function its plugin script (`engine/logic/speculation-judge.js`) needs.
//!
//! Decisions stay in the script (the switches, the loop guards, the state file, the block text); this is only the I/O the
//! script cannot do: read the evidence and the user request out of the transcript tail, build the judge's input, run one
//! isolated `claude -p` call, and leave one telemetry row. It answers only in a process that may wait seconds for a model
//! ([`super::blocking_calls_allowed`]: the dispatcher process or a one-shot command, never the daemon); anywhere else, and
//! whenever a transcript line cannot be read exactly as Node reads it, it answers nothing and the script defers to the Node
//! hook, which makes the same call.
//!
//! Mirrors `hooks/speculation-judge.js` (evidence, input, call) and `hooks/lib/judge-core.js`.
use super::{cli, evidence, input, settings, telemetry};
use crate::checks::git::util::Settings;
use crate::checks::replykit::io::read_window;
use crate::checks::replykit::transcript::tail_lines;
use crate::defaults;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

/// `spec` is JSON `{transcript, message}`: the transcript path and the reply under judgement. The result is the model's
/// parsed answer as JSON text `{"decision": <the answer, or null when the call produced none: a failed call, an
/// unreadable answer>}`, or `None` when the call must be left to the Node hook.
pub fn call(st: &Settings, spec: &str) -> Option<String> {
    if !super::blocking_calls_allowed() {
        return None;
    }
    let v: Value = serde_json::from_str(spec).ok()?;
    let transcript = v.get("transcript")?.as_str()?;
    let message = v.get("message")?.as_str()?;
    let (evidence, request) = match read_window(transcript, defaults::num("speculation_judge.evidence_window")) {
        Some(tail) => {
            let lines = tail_lines(&tail);
            (evidence::collect_evidence(&lines).ok()?, evidence::last_user_prompt(&lines).ok()?)
        }
        None => (Vec::new(), String::new()),
    };
    let judge_input = input::build_judge_input(message, &evidence, &request);
    let model = settings::model(st);
    let child_env = cli::process_env();
    let out = crate::jev::cascade::call_model(&cli::CliCall {
        system: defaults::text("speculation_judge.system_prompt"),
        model: &model,
        input: &judge_input,
        env: &child_env,
        timeout: Duration::from_millis(defaults::num("speculation_judge.timeout_ms")),
    });
    let decision = out.result.as_ref().ok().and_then(|t| cli::parse_decision(t));
    let error = match (&out.result, &decision) {
        (Err(e), _) => Some(e.word()),
        (Ok(_), None) => Some(defaults::text("judge.err_answer")),
        _ => None,
    };
    let word = decision.as_ref().and_then(|d| d.get("decision")).and_then(Value::as_str);
    telemetry::record(
        Path::new(&st.home),
        &telemetry::Row {
            integration: defaults::text("speculation_judge.jev_id"),
            backend: defaults::text("judge.backend_haiku_cli"),
            model: Some(&model),
            ms: out.ms,
            confidence: None,
            decision: word,
            error,
        },
    );
    Some(serde_json::json!({ "decision": decision }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jev::cascade::{MODEL_LOCK, TEST_MODEL};
    use std::collections::HashMap;

    fn scratch(tag: &str) -> String {
        let d = std::env::temp_dir().join(format!("ah-judgehost-{tag}-{}", std::process::id()));
        crate::discard::harmless(std::fs::remove_dir_all(&d));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().into_owned()
    }

    fn transcript(dir: &str) -> String {
        let p = format!("{dir}/t.jsonl");
        let user = r#"{"type":"user","message":{"role":"user","content":"why is it slow?"}}"#;
        let tool = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"u1","name":"Bash","input":{"command":"ls"}}]}}"#;
        let res = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"u1","content":"file-a file-b"}]}}"#;
        std::fs::write(&p, format!("{user}\n{tool}\n{res}\n")).unwrap();
        p
    }

    fn st(dir: &str) -> Settings {
        Settings { home: dir.to_string(), env: HashMap::new() }
    }

    fn reply(text: &str) -> cli::CliOutcome {
        cli::CliOutcome { result: Ok(text.to_string()), ms: 7 }
    }

    #[test]
    fn a_process_that_may_not_block_answers_nothing() {
        // unit tests never mark the process as one that may wait for a model, as the daemon never does
        let d = scratch("noblock");
        let spec = serde_json::json!({"transcript": transcript(&d), "message": "x"}).to_string();
        assert_eq!(call(&st(&d), &spec), None);
    }

    #[test]
    fn the_call_builds_the_input_from_the_transcript_and_returns_the_answer_and_a_telemetry_row() {
        let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        super::super::allow_blocking_calls();
        let d = scratch("call");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(String, String, String)>::new()));
        let seen2 = seen.clone();
        *TEST_MODEL.lock().unwrap() = Some(Box::new(move |c| {
            seen2.lock().unwrap().push((c.model.to_string(), c.system.to_string(), c.input.to_string()));
            reply(r#"{"decision":"block","claim":"the cache is stale"}"#)
        }));
        let spec = serde_json::json!({"transcript": transcript(&d), "message": "The cache is stale."}).to_string();
        let got = call(&st(&d), &spec).unwrap();
        *TEST_MODEL.lock().unwrap() = None;
        assert_eq!(serde_json::from_str::<Value>(&got).unwrap(), serde_json::json!({"decision": {"decision": "block", "claim": "the cache is stale"}}));
        let calls = seen.lock().unwrap();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "haiku", "an alias, never a pinned model id");
        assert_eq!(calls[0].1, defaults::text("speculation_judge.system_prompt"));
        assert!(
            calls[0].2.contains("why is it slow?") && calls[0].2.contains("file-a file-b") && calls[0].2.ends_with("The cache is stale."),
            "{}",
            calls[0].2
        );
        let log = std::fs::read_to_string(format!("{d}/.anti-hall/logs/judge-calls.ndjson")).unwrap();
        assert!(log.contains("\"integration\":\"speculation\"") && log.contains("\"decision\":\"block\"") && log.contains("\"model\":\"haiku\""), "{log}");
    }

    #[test]
    fn a_failed_or_unreadable_answer_is_null_and_leaves_an_error_row() {
        let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        super::super::allow_blocking_calls();
        let d = scratch("fail");
        *TEST_MODEL.lock().unwrap() = Some(Box::new(|_| cli::CliOutcome { result: Err(cli::CliError::Timeout), ms: 25000 }));
        let spec = serde_json::json!({"transcript": transcript(&d), "message": "x"}).to_string();
        assert_eq!(call(&st(&d), &spec).as_deref(), Some(r#"{"decision":null}"#));
        *TEST_MODEL.lock().unwrap() = Some(Box::new(|_| reply("not json")));
        assert_eq!(call(&st(&d), &spec).as_deref(), Some(r#"{"decision":null}"#));
        *TEST_MODEL.lock().unwrap() = None;
        let log = std::fs::read_to_string(format!("{d}/.anti-hall/logs/judge-calls.ndjson")).unwrap();
        assert_eq!(log.lines().count(), 2, "{log}");
        assert!(log.lines().all(|l| l.contains("\"error\":\"")), "{log}");
    }
}
