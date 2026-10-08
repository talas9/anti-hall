use super::*;
use crate::jev::cascade::{MODEL_LOCK, TEST_MODEL};
use crate::judge::cli::CliOutcome;
use std::sync::{Arc, Mutex};

const ON: [(&str, &str); 1] = [("ANTIHALL_JEV", "1")];

fn home(tag: &str) -> std::path::PathBuf {
    let h = std::env::temp_dir().join(format!("ah-evidence-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&h));
    std::fs::create_dir_all(&h).unwrap();
    h
}

fn rows(h: &Path) -> Vec<Value> {
    std::fs::read_to_string(h.join(".anti-hall/logs/jev-evidence.ndjson")).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

fn facts(pairs: &[(&str, f64)]) -> Facts {
    pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
}

fn wait_req(f: Value) -> Value {
    json!({
        "id": "devswarmWaitKind", "child": "kid-1", "dur": "40m", "facts": f,
        "sections": {"tool_calls": ["Bash: ls", "Bash: gh run list", "Edit: a.rs", "Bash: cargo test", "Bash: ls", "Bash: ls"], "assistant_texts": ["waiting for the next step"]}
    })
}

const ENOUGH: &str = r#"{"tool_calls":6,"assistant_texts":1,"mesh_coverage":1}"#;

fn enough_with(extra: Value) -> Value {
    let mut f: Value = serde_json::from_str(ENOUGH).unwrap();
    for (k, v) in extra.as_object().unwrap() {
        f[k] = v.clone();
    }
    f
}

#[test]
fn conditions_read_bools_comparisons_and_absent_facts_the_documented_way() {
    let f = facts(&[("a", 1.0), ("n", 3.0), ("zero", 0.0)]);
    assert!(holds("a", &f) && !holds("zero", &f) && !holds("missing", &f));
    assert!(holds("!zero", &f) && holds("!missing", &f) && !holds("!a", &f));
    assert!(holds("n>=3", &f) && holds("n<=3", &f) && holds("n==3", &f) && holds("n>2", &f) && holds("n<4", &f));
    assert!(!holds("n>3", &f) && !holds("n<3", &f) && !holds("n==2", &f));
    assert!(!holds("missing<60", &f) && !holds("missing>=0", &f), "an absent fact satisfies no comparison");
}

#[test]
fn wait_kind_rules_decide_before_any_model_and_a_done_child_is_never_asked() {
    let cfg = Cfg::load("devswarmWaitKind").unwrap();
    let d = Derived::default();
    assert_eq!(gate(&cfg, &facts(&[("done_reported", 1.0), ("ci_running", 1.0)]), &d), Gate::Skip("child_done".into()), "done wins over CI");
    assert_eq!(gate(&cfg, &facts(&[("archived", 1.0)]), &d), Gate::Skip("child_archived".into()));
    assert_eq!(gate(&cfg, &facts(&[("on_hold", 1.0)]), &d), Gate::Skip("child_on_hold".into()));
    for (fact, rule) in [
        ("ci_running", "ci_running"),
        ("unanswered_q_to_parent", "unanswered_question_to_parent"),
        ("last_report_newer", "last_report_newer"),
        ("usage_limit_pause", "usage_limit_pause"),
    ] {
        assert_eq!(gate(&cfg, &facts(&[(fact, 1.0)]), &d), Gate::Label { rule: rule.into(), label: "waiting".into() }, "{fact}");
    }
}

#[test]
fn wait_kind_needs_tool_calls_an_assistant_text_and_mesh_coverage() {
    let cfg = Cfg::load("devswarmWaitKind").unwrap();
    let d = Derived::default();
    let g = gate(&cfg, &facts(&[("tool_calls", 4.0), ("assistant_texts", 1.0)]), &d);
    assert_eq!(g, Gate::Insufficient(vec!["tool_calls:5".into(), "mesh_coverage:1".into()]));
    assert_eq!(gate(&cfg, &facts(&[("tool_calls", 5.0), ("assistant_texts", 1.0), ("mesh_coverage", 1.0)]), &d), Gate::Ask);
}

#[test]
fn loop_is_asked_only_to_confirm_a_rule_found_candidate() {
    let cfg = Cfg::load("devswarmLoop").unwrap();
    let d = Derived::default();
    let base = |extra: &[(&str, f64)]| {
        let mut p = vec![("tool_calls", 12.0)];
        p.extend_from_slice(extra);
        facts(&p)
    };
    assert_eq!(gate(&cfg, &facts(&[("tool_calls", 9.0)]), &d), Gate::Insufficient(vec!["tool_calls:10".into()]));
    assert_eq!(gate(&cfg, &base(&[("minutes_since_progress", 20.0), ("repeat_cmd_max", 5.0)]), &d), Gate::Label { rule: "recent_progress".into(), label: "not_looping".into() });
    assert_eq!(gate(&cfg, &base(&[("repeat_cmd_max", 2.0), ("minutes_since_progress", 200.0)]), &d), Gate::NoCandidate("not_looping".into()), "no repeat, no revert: no candidate");
    assert_eq!(gate(&cfg, &base(&[("repeat_cmd_max", 3.0), ("commits_on_step", 1.0)]), &d), Gate::NoCandidate("not_looping".into()), "a commit in between is not a loop");
    assert_eq!(gate(&cfg, &base(&[("repeat_cmd_max", 3.0), ("minutes_since_progress", 200.0)]), &d), Gate::Ask);
    assert_eq!(gate(&cfg, &base(&[("reverts", 1.0)]), &d), Gate::Ask, "a reverted change is a candidate too");
}

fn plan(steps: &[(i64, &str, &str)], summary: &str, earlier: &[(&str, Option<i64>)]) -> Value {
    json!({
        "steps": steps.iter().map(|(n, t, s)| json!({"n": n, "text": t, "status": s})).collect::<Vec<_>>(),
        "summary": summary,
        "earlier": earlier.iter().map(|(t, s)| json!({"text": t, "step": s})).collect::<Vec<_>>(),
    })
}

#[test]
fn step_map_picks_a_step_by_rule_and_asks_only_with_enough_plan_evidence() {
    let cfg = Cfg::load("devswarmStepMap").unwrap();
    let run = |p: Value| {
        let mut f = Facts::new();
        let d = derive(&p, &mut f);
        (gate(&cfg, &f, &d), f)
    };
    let steps = [(1, "write the parser", "done"), (2, "wire the cli command", "doing"), (3, "update the docs", "todo")];
    let earlier = [("parser finished", Some(1))];
    let (g, _) = run(plan(&steps, "fixed the flag handling", &earlier));
    assert_eq!(g, Gate::Step { rule: "single_doing_step".into(), n: 2 });
    let (g, _) = run(plan(&steps, "fixed the flag handling, then updated things", &earlier));
    assert_eq!(g, Gate::Ask, "a sequencing word means more than one step: not assumed");
    let two = [(1, "write the parser", "todo"), (2, "wire the cli command", "todo")];
    let (g, f) = run(plan(&two, "wire the cli command into main", &earlier));
    assert_eq!(g, Gate::Step { rule: "summary_quotes_step".into(), n: 2 });
    assert!(f["best_overlap"] >= 0.6);
    let (g, _) = run(plan(&two, "something unrelated happened here", &earlier));
    assert_eq!(g, Gate::Ask);
    let (g, _) = run(plan(&two, "something unrelated happened here", &[("no step", None)]));
    assert_eq!(g, Gate::Insufficient(vec!["earlier_with_step:1".into()]));
    let (g, _) = run(plan(&two[..1], "something unrelated happened here", &earlier));
    assert_eq!(g, Gate::Insufficient(vec!["steps:2".into()]));
    let (g, _) = run(plan(&two, "short", &earlier));
    assert_eq!(g, Gate::Insufficient(vec!["summary_chars:15".into()]));
}

#[test]
fn the_pack_keeps_the_latest_lines_within_its_caps_and_labels_each_one() {
    let cfg = Cfg::load("devswarmWaitKind").unwrap();
    let lines: Vec<String> = (1..=400).map(|i| format!("call number {i} with some padding text to take room")).collect();
    let (pack, ids) = render(&cfg, &facts(&[("tool_calls", 400.0)]), &[("tool_calls".into(), lines)]);
    assert!(pack.chars().count() <= cfg.pack_cap && pack.starts_with("FACTS:\n") && pack.contains("tool_calls = 400"));
    assert!(pack.contains("[tool_calls.400] call number 400") && !pack.contains("[tool_calls.1] "), "the newest lines are kept");
    assert!(!ids.is_empty() && ids.iter().all(|id| pack.contains(id.as_str())));
    assert_eq!(norm("[tool_calls.3]"), norm("tool_calls.3"));
}

fn model_says(reply: &'static str, inputs: Arc<Mutex<Vec<String>>>) {
    *TEST_MODEL.lock().unwrap() = Some(Box::new(move |c| {
        inputs.lock().unwrap().push(c.input.to_string());
        CliOutcome { result: Ok(reply.to_string()), ms: 9 }
    }));
}

#[test]
fn an_asked_haiku_call_carries_the_pack_and_leaves_a_row_naming_the_evidence() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("ask");
    let inputs = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"[tool_calls.2]"}"#, inputs.clone());
    let o = evaluate(&h, &Env::from_pairs(ON), &wait_req(enough_with(json!({}))));
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!((o.phase.as_str(), o.source.as_str(), o.label.as_deref(), o.actionable), ("asked", "haiku", Some("stuck"), true));
    assert_eq!(o.evidence_ref.as_deref(), Some("[tool_calls.2]"));
    let sent = inputs.lock().unwrap().clone();
    assert_eq!(sent.len(), 1);
    assert!(sent[0].contains("No step progress for 40m") && sent[0].contains("[tool_calls.2] Bash: gh run list") && sent[0].contains("mesh_coverage = 1"));
    let r = rows(&h);
    assert_eq!(r.len(), 1);
    assert_eq!((r[0]["phase"].as_str(), r[0]["source"].as_str(), r[0]["child"].as_str()), (Some("asked"), Some("haiku"), Some("kid-1")));
    let present: Vec<&str> = r[0]["present"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(present, ["assistant_texts", "mesh_coverage", "tool_calls"]);
    assert!(r[0]["missing"].as_array().unwrap().is_empty());
}

#[test]
fn insufficient_evidence_makes_no_call_and_the_row_says_what_was_missing() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("insuff");
    let inputs = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"tool_calls.1"}"#, inputs.clone());
    let o = evaluate(&h, &Env::from_pairs(ON), &wait_req(json!({"tool_calls": 2, "assistant_texts": 1})));
    *TEST_MODEL.lock().unwrap() = None;
    assert!(inputs.lock().unwrap().is_empty(), "no call was made");
    assert_eq!((o.phase.as_str(), o.reason.as_deref(), o.actionable), ("skipped", Some("insufficient"), false));
    let r = rows(&h);
    assert_eq!(r[0]["missing"], json!(["tool_calls:5", "mesh_coverage:1"]));
    assert_eq!(r[0]["present"], json!(["assistant_texts", "tool_calls"]));
}

#[test]
fn a_rule_answer_calls_no_model_and_is_logged_as_a_rule() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("rule");
    let inputs = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"tool_calls.1"}"#, inputs.clone());
    let o = evaluate(&h, &Env::from_pairs(ON), &wait_req(enough_with(json!({"ci_running": true}))));
    let skip = evaluate(&h, &Env::from_pairs(ON), &wait_req(enough_with(json!({"done_reported": true}))));
    *TEST_MODEL.lock().unwrap() = None;
    assert!(inputs.lock().unwrap().is_empty());
    assert_eq!((o.phase.as_str(), o.source.as_str(), o.label.as_deref(), o.rule.as_deref()), ("rule", "rule", Some("waiting"), Some("ci_running")));
    assert_eq!((skip.phase.as_str(), skip.reason.as_deref(), skip.rule.as_deref()), ("skipped", Some("rule-skip"), Some("child_done")));
    assert_eq!(rows(&h).len(), 2);
}

#[test]
fn an_answer_that_cites_no_real_line_is_discarded_and_a_low_confidence_is_not_actionable() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("ref");
    let inputs = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.95,"evidence_ref":"tool_calls.99"}"#, inputs.clone());
    let bad = evaluate(&h, &Env::from_pairs(ON), &wait_req(enough_with(json!({}))));
    model_says(r#"{"answer":false,"confidence":0.4,"evidence_ref":"tool_calls.1"}"#, inputs);
    let low = evaluate(&h, &Env::from_pairs(ON), &wait_req(enough_with(json!({}))));
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!((bad.label, bad.reason.as_deref(), bad.actionable), (None, Some("bad-evidence-ref"), false));
    assert_eq!((low.label.as_deref(), low.reason.as_deref(), low.actionable), (Some("waiting"), Some("low-confidence"), false));
}

#[test]
fn the_daily_cap_stops_direct_haiku_calls_and_a_shadow_integration_is_never_actionable() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("cap");
    let inputs = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"tool_calls.1"}"#, inputs.clone());
    let shadow = Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_DEVSWARM_LOOP", "shadow")]);
    let req = json!({"id": "devswarmLoop", "facts": {"tool_calls": 12, "reverts": 1}, "sections": {"tool_calls": ["a", "b"]}});
    let first = evaluate(&h, &shadow, &req);
    assert_eq!((first.label.as_deref(), first.actionable, first.reason.as_deref()), (Some("looping"), false, Some("shadow")));
    let cap = defaults::raw("evidence.cfg").get("devswarmLoop").and_then(|c| c.get("daily_cap")).and_then(defaults::V::as_integer).unwrap();
    for _ in 1..cap {
        evaluate(&h, &shadow, &req);
    }
    let over = evaluate(&h, &shadow, &req);
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!((over.phase.as_str(), over.reason.as_deref()), ("skipped", Some("daily-cap")));
    assert_eq!(inputs.lock().unwrap().len() as i64, cap, "exactly the cap was asked");
}

#[test]
fn an_off_integration_is_not_looked_at_and_writes_nothing() {
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let h = home("off");
    let inputs = Arc::new(Mutex::new(Vec::new()));
    model_says(r#"{"answer":true,"confidence":0.9,"evidence_ref":"tool_calls.1"}"#, inputs.clone());
    let jev_off = evaluate(&h, &Env::from_pairs([("ANTIHALL_JEV", "0")]), &wait_req(enough_with(json!({}))));
    let int_off = evaluate(&h, &Env::from_pairs([("ANTIHALL_JEV", "1"), ("ANTIHALL_JEV_DEVSWARM_WAIT_KIND", "0")]), &wait_req(enough_with(json!({}))));
    let unknown = evaluate(&h, &Env::from_pairs(ON), &json!({"id": "speculation"}));
    *TEST_MODEL.lock().unwrap() = None;
    assert!(inputs.lock().unwrap().is_empty() && rows(&h).is_empty());
    assert_eq!((jev_off.reason.as_deref(), int_off.reason.as_deref(), unknown.reason.as_deref()), (Some("mode-off"), Some("mode-off"), Some("unknown-integration")));
}

#[test]
fn the_jev_backed_step_map_asks_a_choice_over_the_steps_through_the_shared_layer() {
    use crate::jev::testkit::{install_scripted, log_rows};
    let h = home("jev");
    let (_jev, fake) = install_scripted(&h, &[("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")], vec![]);
    let two = [(1, "write the parser", "todo"), (2, "wire the cli command", "todo")];
    let req = json!({"id": "devswarmStepMap", "plan": plan(&two, "something unrelated happened here", &[("parser done", Some(1))])});
    let o = evaluate(&h, &Env::from_pairs([("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")]), &req);
    assert_eq!((o.phase.as_str(), o.source.as_str(), o.actionable), ("asked", "jev", false), "the scripted transport answered nothing: the baseline stands");
    let body = fake.seen.lock().unwrap().first().and_then(|s| s.2.clone()).unwrap_or_default();
    assert!(body.contains("wire the cli command") && body.contains("unknown") && body.contains("[plan.2]"), "{body}");
    assert!(log_rows(&h).len() == 1 && rows(&h).len() == 1);
}
