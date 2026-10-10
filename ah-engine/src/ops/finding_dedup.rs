//! `ah-engine finding-dedup [--file findings.json]`: ADVISORY duplicate-finding detector for the deadly-loop trio. Groups findings
//! that Jev judges to describe the same underlying issue (integration `findingDedup`, trust advisory); it never collapses anything.
//! Port of `scripts/finding-dedup.js`. The rules script (`rules/operator-cli.js`) picks the candidate pairs and groups the confirmed
//! ones; this command asks Jev about each pair (four at a time) through the engine's own Jev lane and prints the answer.
//! Fail-open: Jev off, a failed pair or malformed input drops edges, never the run.
use super::{env_snapshot, err, home, opcli_call, opcli_cfg, out, read_lossy};
use crate::cli::Parsed;
use crate::defaults;
use crate::jev::credentials::resolve_key;
use crate::jev::settings::{Env, Mode};
use crate::jev::{AskRequest, Jev, Question, Trust};
use serde_json::{Value, json};
use std::io::Read;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

fn findings_text(argv: &[String]) -> Value {
    let flag = defaults::text("opcli.fd_file_flag");
    let mut file = None;
    let mut i = 0;
    while i < argv.len() {
        if argv[i] == flag {
            i += 1;
            file = argv.get(i).cloned();
        }
        i += 1;
    }
    match (argv.iter().any(|a| a == flag), file) {
        (true, Some(f)) => read_lossy(std::path::Path::new(&f)).map_or(Value::Null, Value::String),
        (true, None) => Value::Null,
        (false, _) => {
            let mut s = String::new();
            // an unreadable stdin reads as empty input, as in Node
            if std::io::stdin().read_to_string(&mut s).is_err() {
                s.clear();
            }
            Value::String(s)
        }
    }
}

pub(crate) fn run(p: &Parsed) -> i32 {
    let env = env_snapshot();
    let home_dir = std::path::PathBuf::from(home(&env));
    let text = findings_text(&p.raw);
    let jev = Jev::new(&home_dir, Env::process());
    let settings = jev.settings();
    // this CLI is not a hook, so it never gets the plugin-option key: say why when Jev is on and nothing is visible
    if settings.enabled && resolve_key(&settings, settings.transport).key.is_none() {
        err(&(defaults::render("opcli.fd_no_key", &[("notice", &defaults::text("setup.msg_no_key_notice"))]) + "\n"));
    }
    let cfg = opcli_cfg();
    let script = defaults::text("opcli.rules_script");
    let fail_exit = defaults::num("opcli.fail_exit") as i32;
    let mode_off = settings.mode(defaults::text("opcli.fd_id"), false) == Mode::Off;
    let mut answers: Vec<Value> = Vec::new();
    if !mode_off {
        let Some(plan) = opcli_call("finding-dedup", script, "findingDedupPlan", &json!({"text": text, "cfg": cfg})) else { return fail_exit };
        let asks: Vec<(String, String)> = plan
            .get("asks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|a| (a["state"].as_str().unwrap_or_default().to_string(), a["cacheKey"].as_str().unwrap_or_default().to_string()))
            .collect();
        let q = defaults::raw("opcli.fd_question");
        let question = Question::noul(q.str_field("instructions"), q.str_field("when_true"), q.str_field("when_false"));
        let slots: Mutex<Vec<Value>> = Mutex::new(vec![Value::Null; asks.len()]);
        let next = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..(defaults::num("opcli.fd_concurrency") as usize).clamp(1, asks.len().max(1)) {
                s.spawn(|| {
                    loop {
                        let i = next.fetch_add(1, Ordering::SeqCst);
                        let Some((state, key)) = asks.get(i) else { break };
                        let mut req = AskRequest::new(defaults::text("opcli.fd_id"), question.clone(), state, Trust::Advisory, Value::Null);
                        req.cache_key = Some(key.clone());
                        req.wait_for_escalation = true; // nobody blocks on a batch command
                        let d = jev.ask(&req);
                        slots.lock().unwrap_or_else(|e| e.into_inner())[i] = json!({"final": d.outcome, "confidence": d.confidence});
                    }
                });
            }
        });
        answers = slots.into_inner().unwrap_or_else(|e| e.into_inner());
    }
    let Some(r) = opcli_call("finding-dedup", script, "findingDedupFinish", &json!({"text": text, "modeOff": mode_off, "answers": answers, "cfg": cfg})) else {
        return fail_exit;
    };
    for l in r.get("err").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        err(&(l.to_string() + "\n"));
    }
    out(r.get("out").and_then(Value::as_str).unwrap_or_default());
    0
}
