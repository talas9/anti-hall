use super::*;
use crate::jev::breaker::ManualClock;
use crate::jev::log::{DecisionLog, Row};
use crate::jev::transport::{NetError, RawResponse, Request, Transport};
use serde_json::json;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

static HOME_ID: AtomicUsize = AtomicUsize::new(0);

fn temp_home(tag: &str) -> std::path::PathBuf {
    let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let home = std::env::temp_dir().join(format!("ah-mr-{tag}-{}-{nonce}-{}", std::process::id(), HOME_ID.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    home
}

fn mechanical_payload(model: Option<&str>) -> Value {
    let mut input = json!({"subagent_type":"general-purpose","prompt":"fetch and download the dump, tail the logs"});
    if let Some(model) = model {
        input["model"] = json!(model);
    }
    json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":input})
}

fn routed_exact(v: Option<Verdict>) -> (Exact, Vec<RouteMeta>) {
    let Some(Verdict::Routed(inner, routes)) = v else { panic!("expected routed verdict") };
    let Verdict::Exact(exact) = *inner else { panic!("expected exact verdict") };
    (exact, routes)
}

struct CountingTransport {
    calls: AtomicUsize,
    confidence: f64,
}

impl Transport for CountingTransport {
    fn send(&self, _: &Request<'_>) -> Result<RawResponse, NetError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        Ok(RawResponse { status: 200, body: Ok(format!(r#"{{"answers":{{"decision":{{"choice":"research","confidence":{}}}}}}}"#, self.confidence)) })
    }
}

#[derive(Default)]
struct MemLog(Mutex<Vec<Row>>);

impl DecisionLog for MemLog {
    fn append(&self, row: &Row) -> Result<(), crate::jev::JevError> {
        self.0.lock().unwrap().push(row.clone());
        Ok(())
    }
}

fn jev_lane(home: &Path, mode: &str, confidence: f64) -> (RequestEnv, Arc<Jev>, Arc<CountingTransport>, Arc<MemLog>) {
    let env = RequestEnv::from_pairs([
        ("HOME", home.to_str().unwrap()),
        ("ANTIHALL_JEV", "1"),
        ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_MODEL_ROUTING", mode),
    ]);
    let transport = Arc::new(CountingTransport { calls: AtomicUsize::new(0), confidence });
    let log = Arc::new(MemLog::default());
    let lane = Jev::with_parts(home, jev_env(&env), transport.clone(), Arc::new(ManualClock::default()), None, Some(log.clone()));
    (env, lane, transport, log)
}

#[derive(Debug)]
struct FakeTransport;

impl Transport for FakeTransport {
    fn send(&self, _: &Request<'_>) -> Result<RawResponse, NetError> {
        Ok(RawResponse { status: 200, body: Ok(r#"{"answers":{"decision":{"choice":"research","confidence":0.99}}}"#.into()) })
    }
}

#[test]
fn row1_flagship_mechanical_blocks_with_node_shape() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    let p = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
        "model":"opus","subagent_type":"general-purpose","prompt":"fetch and download the dump, tail the logs"
    }});
    let Some(Verdict::Routed(inner, route)) = decide(&p, &env) else { panic!("expected routed verdict") };
    assert!(matches!(*inner, Verdict::Exact(ref x) if x.code == 2 && x.out.contains("\"decision\":\"block\"")));
    assert_eq!(route[0].recommended_tier, "haiku");
    assert!(route[0].delegate);
}

#[test]
fn standalone_decision_ignores_missing_odd_and_foreign_tool_names() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    for tool_name in [None, Some("Agent "), Some("Workflow"), Some("codex:Task"), Some("spawn_agent")] {
        let mut p = json!({"hook_event_name":"PreToolUse","session_id":"s","cwd":"/tmp","tool_input":{
            "model":"opus","subagent_type":"general-purpose","description":"","prompt":"fetch logs and list files"
        }});
        if let Some(tool_name) = tool_name {
            p["tool_name"] = json!(tool_name);
        }
        let (exact, routes) = routed_exact(decide(&p, &env));
        assert_eq!(exact.code, 2, "{tool_name:?}");
        assert!(exact.out.contains("\"decision\":\"block\""), "{tool_name:?}");
        assert_eq!(routes[0].outcome, "down", "{tool_name:?}");
    }
}

#[test]
fn only_blocking_down_routes_delegate_update_handover_and_fail_closed_do_not() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    let update = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
        "model":"sonnet","subagent_type":"general-purpose","description":"update","prompt":"Please run /anti-hall:update and report"
    }});
    let (exact, routes) = routed_exact(decide(&update, &env));
    assert_eq!(exact.code, 2);
    assert!(exact.out.contains("update.js runs migrations"), "test must execute the real update-in-session block");
    assert_eq!(routes[0].task_class, "update");
    assert_eq!(routes[0].outcome, "exempt");
    assert!(!routes[0].delegate, "update-in-session blocks are not D86 forced delegations");

    let home = temp_home("handover-delegate");
    let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap())]);
    let handover = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
        "model":"opus","subagent_type":"general-purpose","description":"handover","prompt":"write the session handover"
    }});
    let (exact, routes) = routed_exact(decide(&handover, &env));
    assert_eq!(exact.code, 0);
    assert_eq!(routes[0].outcome, "exempt");
    assert!(!routes[0].delegate, "handover advisory is not a forced delegation");

    let (exact, routes) = routed_exact(Some(fail_closed()));
    assert_eq!(exact.code, 2);
    assert_eq!(routes[0].outcome, "deny");
    assert!(!routes[0].delegate, "generic fail-closed deny is not a cheaper-model delegation");
}

#[test]
fn row6_research_advises_explore() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    let p = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
        "subagent_type":"general-purpose","description":"investigate","prompt":"research and find usages, report only"
    }});
    let Some(Verdict::Routed(inner, route)) = decide(&p, &env) else { panic!("expected routed verdict") };
    assert!(matches!(*inner, Verdict::Exact(ref x) if x.code == 0 && x.out.contains("subagent_type:'Explore'")));
    assert_eq!(route[0].task_class, "research");
}

#[test]
fn delegate_is_only_for_blocking_routing_down_decisions() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    for (name, payload, outcome, delegate) in [
        ("row1-block", mechanical_payload(Some("opus")), "down", true),
        (
            "row1-role-advice",
            json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
                "model":"opus","subagent_type":"general-purpose","description":"Reviewer","prompt":"fetch and download the dump, tail the logs"
            }}),
            "down",
            false,
        ),
        (
            "update-block",
            json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
                "model":"sonnet","subagent_type":"general-purpose","description":"update","prompt":"Please run /anti-hall:update and report"
            }}),
            "exempt",
            false,
        ),
        (
            "deploy-up-advice",
            json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
                "model":"haiku","subagent_type":"general-purpose","description":"deploy","prompt":"firebase deploy --only functions"
            }}),
            "up",
            false,
        ),
    ] {
        let Some(Verdict::Routed(_, routes)) = decide(&payload, &env) else { panic!("{name}: expected routed verdict") };
        assert_eq!(routes[0].outcome, outcome, "{name}: outcome");
        if name == "update-block" {
            assert_eq!(routes[0].task_class, "update", "{name}: must execute the update branch");
        }
        assert_eq!(routes[0].delegate, delegate, "{name}: delegate");
    }
}

#[test]
fn malformed_tool_input_classes_allow_but_still_route() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    for (name, p) in [
        ("missing", json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp"})),
        ("null", json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":null})),
        ("string", json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":"research and find usages"})),
        ("array", json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":["research"]})),
    ] {
        let Some(Verdict::Routed(inner, route)) = decide(&p, &env) else { panic!("{name}: expected routed allow") };
        assert!(matches!(*inner, Verdict::Allow), "{name}");
        assert_eq!(route[0].outcome, "allow", "{name}");
    }
}

#[test]
fn token_scan_uses_nfkc_and_utf16_scan_limit() {
    assert_eq!(tokenize("ﬁｎｄ ① LOGS"), vec!["find", "1", "logs"]);
    assert_eq!(js_slice_utf16("😀fetch", 1), "");
    assert_eq!(js_slice_utf16("😀fetch", 2), "😀");
}

#[test]
fn token_scan_splits_marks_and_enclosed_alphabetic_symbols() {
    for separator in ['\u{0345}', '\u{05b0}', '\u{0301}', '\u{20dd}', '\u{1f170}'] {
        assert_eq!(tokenize(&format!("fetch{separator}logs")), vec!["fetch", "logs"], "{separator:?}");
    }
    assert_eq!(tokenize("\u{10940} Ⅷ ²"), vec!["\u{10940}", "viii", "2"]);
}

#[test]
fn letter_number_categories_match_node_for_every_unicode_scalar() {
    // Node is already the model-routing parity oracle. Cover all categories, including newly assigned letters.
    let output = std::process::Command::new("node")
        .args([
            "-e",
            r"let out=''; const re=/[\p{L}\p{N}]/u; for(let n=0;n<=0x10ffff;n++)out+=re.test(String.fromCodePoint(n))?'1':'0';process.stdout.write(out);",
        ])
        .output()
        .unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(output.stdout.len(), 0x110000);
    for (n, &expected) in output.stdout.iter().enumerate() {
        if let Some(c) = char::from_u32(n as u32) {
            assert_eq!(is_letter_or_number(c), expected == b'1', "U+{n:04X}");
        }
    }
}

#[test]
fn routing_off_bypasses_update_handover_state_and_jev() {
    let home = temp_home("off");
    let (mut env, lane, transport, log) = jev_lane(&home, "on", 0.99);
    let mut pairs = env.to_map();
    pairs.insert("ANTIHALL_MODEL_ROUTING".into(), "off".into());
    env = RequestEnv::from_pairs(pairs);
    for prompt in ["Run /anti-hall:update", "write the session handover", "fetch and download dump"] {
        let mut payload = mechanical_payload(Some("opus"));
        payload["tool_input"]["prompt"] = json!(prompt);
        let Some(Verdict::Routed(inner, routes)) = decide_inner_with_jev(&payload, &env, Some(&lane)) else { panic!("expected routed allow") };
        assert!(matches!(*inner, Verdict::Allow), "{prompt}");
        assert_eq!(routes[0].outcome, "allow");
    }
    assert_eq!(std::fs::read_dir(home.join(".anti-hall")).unwrap().count(), 0);
    assert_eq!(transport.calls.load(Ordering::Relaxed), 0);
    assert!(log.0.lock().unwrap().is_empty());
}

#[test]
fn parent_model_uses_payload_model_else_unknown_and_selected_model_is_recorded() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    for model in [Some("opus"), Some("fable"), None] {
        let mut payload = mechanical_payload(model);
        let (_, routes) = routed_exact(decide(&payload, &env));
        assert_eq!(routes[0].parent_model, "inherit:unknown");
        assert_eq!(routes[0].requested_model, model.unwrap_or("inherit:unknown"));
        if model == Some("opus") || model.is_none() {
            assert_eq!(routes[0].selected_model, "haiku");
        }
        payload["model"] = json!("sonnet");
        let (_, routes) = routed_exact(decide(&payload, &env));
        assert_eq!(routes[0].parent_model, "sonnet");
    }
}

#[test]
fn spawn_key_is_stable_across_a_retry_and_never_holds_prompt_text() {
    let mut payload = mechanical_payload(Some("opus"));
    let st = "general-purpose";
    let original = route_key(&payload, st);
    // a retry: another model, another call id and turn, same session and prompt
    payload["tool_input"]["model"] = json!("haiku");
    payload["tool_use_id"] = json!("call-2");
    payload["turn_id"] = json!("turn-2");
    assert_eq!(original, route_key(&payload, st));
    // a different session, parent agent, subagent type or prompt start is a different spawn
    let mut other = payload.clone();
    other["session_id"] = json!("another-session");
    assert_ne!(original, route_key(&other, st));
    let mut other = payload.clone();
    other["agent_id"] = json!("another-parent-agent");
    assert_ne!(original, route_key(&other, st));
    assert_ne!(original, route_key(&payload, "Explore"));
    let mut other = payload.clone();
    other["tool_input"]["prompt"] = json!("fetch another endpoint");
    assert_ne!(original, route_key(&other, st));
    // only a bounded prefix counts, and the key is O(1) and content-free
    let limit = defaults::num("model_routing.key_prefix_chars") as usize;
    payload["tool_input"]["prompt"] = json!(format!("SECRET_PROMPT_MARKER {}", "x".repeat(1024 * 1024)));
    let huge = route_key(&payload, st);
    let mut tail = payload.clone();
    let prefix: String = format!("SECRET_PROMPT_MARKER {}", "x".repeat(limit)).chars().take(limit).collect();
    tail["tool_input"]["prompt"] = json!(format!("{prefix}and a different tail"));
    assert_eq!(huge, route_key(&tail, st));
    let huge_subagent = format!("{}{}", "s".repeat(defaults::num("telemetry.token_max_len") as usize), "SECRET_SUBAGENT_MARKER".repeat(1024));
    let bounded = route_key(&payload, &huge_subagent);
    assert_eq!(bounded, route_key(&payload, &huge_subagent[..defaults::num("telemetry.token_max_len") as usize]));
    assert!(!huge.contains("SECRET") && !bounded.contains("SECRET"));
    assert!(huge.len() < defaults::num("telemetry.token_max_len") as usize);
}

#[test]
fn an_opus_deny_then_a_haiku_retry_in_one_session_join_on_one_key() {
    use crate::telemetry::event::{Event, Extras, Kind, Outcome, Route, RouteOutcome, Spawn, Token, Usage};
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    let mut payload = mechanical_payload(Some("opus"));
    payload["tool_use_id"] = json!("call-1");
    payload["turn_id"] = json!("turn-1");
    let (x, original) = routed_exact(decide(&payload, &env));
    assert_eq!(x.code, 2, "the opus spawn is denied");
    let mut retry = payload;
    retry["tool_input"]["model"] = json!("haiku");
    retry["tool_use_id"] = json!("call-2");
    retry["turn_id"] = json!("turn-2");
    let Some(Verdict::Routed(_, rerouted)) = decide(&retry, &env) else { panic!("expected routed allow") };
    assert_eq!(original[0].spawn_key, rerouted[0].spawn_key, "the retry links to the first decision");
    let route = |meta: &RouteMeta, outcome| {
        Extras::Route(Route {
            requested_model: Token::sanitize(&meta.requested_model),
            parent_model: Token::sanitize(&meta.parent_model),
            task_class: Token::sanitize(&meta.task_class),
            recommended_tier: Token::sanitize(&meta.recommended_tier),
            selected_model: Token::sanitize(&meta.selected_model),
            outcome,
            spawn_key: Token::sanitize(&meta.spawn_key),
        })
    };
    let event = |ts_ms, kind, o, extras| Event { ts_ms, kind, h: Token::sanitize("model-routing"), e: Token::sanitize("PreToolUse"), o, ms: 0, ib: 0, extras };
    let events = vec![
        event(1, Kind::Route, Outcome::Block, route(&original[0], RouteOutcome::Deny)),
        event(2, Kind::Route, Outcome::Allow, route(&rerouted[0], RouteOutcome::Allow)),
        event(
            3,
            Kind::Spawn,
            Outcome::Allow,
            Extras::Spawn(Spawn { spawn_key: Token::sanitize(&rerouted[0].spawn_key), actual_model: Token::sanitize("haiku"), usage: Usage::default() }),
        ),
    ];
    let (chains, unlinked) = crate::telemetry::route::chains(&events, 10);
    assert_eq!(unlinked, 0);
    assert_eq!(chains.len(), 1);
    assert_eq!(chains[0].decisions, 2);
    assert_eq!(chains[0].origin.requested_model.as_str(), "opus", "the chain is compared against what was first asked for");
}

#[test]
fn jev_on_relaxes_row1_block_to_advisory() {
    let home = std::env::temp_dir().join(format!("ah-mr-jev-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(home.join(".anti-hall")).unwrap();
    let env = RequestEnv::from_pairs([
        ("HOME", home.to_str().unwrap()),
        ("ANTIHALL_JEV", "1"),
        ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk"),
        ("CLAUDE_PLUGIN_OPTION_JEV_INTEGRATION_MODEL_ROUTING", "on"),
    ]);
    let lane = Jev::with_parts(Path::new(home.to_str().unwrap()), jev_env(&env), Arc::new(FakeTransport), Arc::new(ManualClock::default()), None, None);
    let p = json!({"hook_event_name":"PreToolUse","tool_name":"Agent","session_id":"s","cwd":"/tmp","tool_input":{
        "model":"opus","subagent_type":"general-purpose","prompt":"fetch and download the dump, tail the logs"
    }});
    let Some(Verdict::Routed(inner, route)) = decide_inner_with_jev(&p, &env, Some(&lane)) else { panic!("expected routed verdict") };
    assert!(matches!(*inner, Verdict::Exact(ref x) if x.code == 0 && x.out.contains("Jev judged it non-mechanical")));
    assert!(!route[0].delegate);
    let _ = std::fs::remove_dir_all(home);
}

#[test]
fn fail_closed_is_never_defer_or_silent_allow() {
    let (x, routes) = routed_exact(Some(fail_closed()));
    assert_eq!(x.code, 2);
    assert!(x.out.contains("\"decision\":\"block\"") && x.out.contains("model-routing"));
    assert_eq!(routes.len(), 1);
    assert!(!routes[0].delegate);
    assert_eq!((&*routes[0].outcome, &*routes[0].task_class), ("deny", "unknown"));
}

#[test]
fn model_routing_ignores_subject_and_payload_tool_name_like_node() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    let mut payload = mechanical_payload(Some("opus"));
    for tool in [None, Some("Agent "), Some("Workflow"), Some("codex:Task"), Some("spawn_agent")] {
        if let Some(tool) = tool {
            payload["tool_name"] = json!(tool);
        } else {
            payload.as_object_mut().unwrap().remove("tool_name");
        }
        let subject = Subject { event: "PreToolUse", tool, cwd: None, tool_input: &payload["tool_input"], prompt: None };
        assert_eq!(routed_exact(ModelRouting.run_env(&subject, &payload, &Value::Null, &env)).0.code, 2, "{tool:?}");
    }
}

#[test]
fn enum_settings_invalid_environment_falls_through_and_valid_environment_wins() {
    let home = temp_home("enum");
    std::fs::write(home.join(".anti-hall/settings.json"), r#"{"guards":{"modelRouting":"advisory","modelRoutingDeployFloor":"opus"}}"#).unwrap();
    let payload = mechanical_payload(None);
    for (raw, expected) in [("not-a-mode", 0), ("   ", 0), (" STRICT ", 2)] {
        let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap()), ("ANTIHALL_MODEL_ROUTING", raw)]);
        assert_eq!(routed_exact(decide(&payload, &env)).0.code, expected, "{raw:?}");
    }
    let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap()), ("ANTIHALL_MODEL_ROUTING_DEPLOY_FLOOR", "invalid")]);
    let payload = json!({"tool_name":"Agent","tool_input":{"model":"sonnet","prompt":"deploy application"}});
    let (_, routes) = routed_exact(decide(&payload, &env));
    assert_eq!(routes[0].recommended_tier, "opus");
}

#[test]
fn enum_settings_use_stored_plugin_options_and_invalid_file_falls_through() {
    let home = temp_home("stored-enum");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".anti-hall/settings.json"), r#"{"guards":{"modelRouting":["off"]}}"#).unwrap();
    std::fs::write(home.join(".claude/settings.json"), r#"{"pluginConfigs":{"anti-hall":{"options":{"guards_model_routing":"advisory"}}}}"#).unwrap();
    let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap())]);
    assert_eq!(routed_exact(decide(&mechanical_payload(None), &env)).0.code, 0);
    let env = RequestEnv::from_pairs([("HOME", home.to_str().unwrap()), ("CLAUDE_PLUGIN_OPTION_GUARDS_MODEL_ROUTING", "strict")]);
    assert_eq!(routed_exact(decide(&mechanical_payload(None), &env)).0.code, 2);
}

#[test]
fn js_line_separators_start_write_instructions_and_suppress_explore() {
    let env = RequestEnv::from_pairs([("HOME", "/tmp")]);
    for separator in ['\n', '\r', '\u{2028}', '\u{2029}'] {
        for instruction in ["Fix the bug", "run tests", "run the generator"] {
            let payload = json!({"tool_name":"Agent","tool_input":{"model":"sonnet","prompt":format!("research source{separator}{instruction}")}});
            let Some(Verdict::Routed(inner, _)) = decide(&payload, &env) else { panic!("expected routed allow") };
            assert!(matches!(*inner, Verdict::Allow), "{separator:?} {instruction}");
        }
    }
}

#[test]
fn jev_shadow_consults_and_logs_rows_one_and_two_but_only_on_relaxes() {
    for (mode, expected_code, expected_calls) in [("shadow", 2, 1), ("on", 0, 1), ("off", 2, 0)] {
        let home = temp_home(mode);
        let (env, lane, transport, log) = jev_lane(&home, mode, 0.99);
        for model in [Some("opus"), None] {
            let (exact, _) = routed_exact(decide_inner_with_jev(&mechanical_payload(model), &env, Some(&lane)));
            assert_eq!(exact.code, expected_code, "{mode} {model:?}");
        }
        assert_eq!(transport.calls.load(Ordering::Relaxed), expected_calls, "{mode}");
        let rows = log.0.lock().unwrap();
        if mode != "off" {
            assert_eq!(rows.len(), 2);
            for row in rows.iter() {
                let row: Value = serde_json::from_str(&row.to_line()).unwrap();
                assert_eq!(row["mode"], mode);
                assert_eq!(row["final"], mode != "on");
                assert_eq!(row["changed"], if mode == "on" { json!("relaxed") } else { Value::Null });
                assert_eq!(row["wouldChange"], "relaxed");
            }
        }
    }
}

#[test]
fn jev_routing_uses_inclusive_threshold_and_node_legacy_threshold_precedence() {
    for (threshold, legacy, confidence, expected_code) in [(0.8, None, 0.8, 0), (0.8, None, 0.79, 2), (0.7, Some(0.9), 0.8, 2), (0.7, Some(2.0), 0.8, 0)] {
        let home = temp_home("threshold");
        std::fs::write(home.join(".anti-hall/settings.json"), json!({"jev":{"confidenceThreshold":threshold}}).to_string()).unwrap();
        if let Some(legacy) = legacy {
            std::fs::write(home.join(".anti-hall/jev.json"), json!({"confidenceThreshold":legacy}).to_string()).unwrap();
        }
        let (env, lane, transport, _) = jev_lane(&home, "on", confidence);
        let (exact, _) = routed_exact(decide_inner_with_jev(&mechanical_payload(Some("opus")), &env, Some(&lane)));
        assert_eq!(exact.code, expected_code, "threshold={threshold} legacy={legacy:?} confidence={confidence}");
        assert_eq!(transport.calls.load(Ordering::Relaxed), 1);
    }
}
