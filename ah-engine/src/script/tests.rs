//! Tests of the scripted check runtime (D88 spike): parity of the two scripted checks with their compiled ports, the owner
//! override, reload on change, the per-call limits, and runtime teardown.
use super::*;
use crate::checks::Check;
use crate::rules::Subject;
use serde_json::json;

fn home(tag: &str) -> String {
    let d = std::env::temp_dir().join(format!("ah-script-{tag}-{}", std::process::id()));
    crate::discard::harmless(std::fs::remove_dir_all(&d)); // keep: cleanup that raced; an absent dir is the goal state
    std::fs::create_dir_all(d.join(".anti-hall/logic")).unwrap();
    d.to_string_lossy().to_string()
}

fn env(h: &str) -> RequestEnv {
    RequestEnv::from_pairs([("HOME", h)])
}

fn put_override(h: &str, name: &str, body: &str) {
    std::fs::write(format!("{h}/.anti-hall/logic/{name}.js"), body).unwrap();
}

/// The compiled port's answer, exactly as the dispatcher would get it with scripts off.
fn compiled(check: &dyn Check, p: &Value, e: &RequestEnv) -> Option<Verdict> {
    let null = Value::Null;
    let subject = Subject {
        event: p.get("hook_event_name").and_then(Value::as_str).unwrap_or("PreToolUse"),
        tool: p.get("tool_name").and_then(Value::as_str),
        cwd: p.get("cwd").and_then(Value::as_str),
        tool_input: p.get("tool_input").unwrap_or(&null),
        prompt: p.get("prompt").and_then(Value::as_str),
    };
    check.run_env(&subject, p, &Value::Null, e)
}

/// `run_forced` for a payload with no options, as a PreToolUse call.
fn run_forced(name: &str, p: &Value, e: &RequestEnv) -> Option<Option<Verdict>> {
    super::run_forced(name, p, &Value::Null, "PreToolUse", e)
}

fn user(t: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": t}}).to_string()
}

fn asst(t: &str) -> String {
    json!({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": t}]}}).to_string()
}

/// Every payload gives the same verdict from the script and from the compiled port.
fn assert_parity(check: &dyn Check, e: &RequestEnv, payloads: &[Value]) -> (usize, std::collections::BTreeSet<&'static str>) {
    let mut n = 0;
    let mut kinds = std::collections::BTreeSet::new();
    for p in payloads {
        let c = compiled(check, p, e);
        let s = run_forced(check.name(), p, e).expect("a shipped script");
        assert_eq!(s, c, "{}: script and compiled port differ on {p}", check.name());
        kinds.insert(match c {
            None => "none",
            Some(Verdict::Allow) => "allow",
            Some(Verdict::Defer) => "defer",
            Some(Verdict::Block(_)) => "block",
            Some(Verdict::Advisory(_)) => "advisory",
            Some(_) => "other",
        });
        n += 1;
    }
    (n, kinds)
}

#[test]
fn compact_declaration_guard_script_matches_the_compiled_port() {
    let h = home("cd");
    let safe = "\u{2705} SAFE TO COMPACT";
    let tps: Vec<(&str, Vec<String>)> = vec![
        ("declared", vec![user("go"), asst("done"), asst(safe)]),
        ("reset", vec![asst(safe), user("next")]),
        ("not-safe", vec![user("go"), asst("nothing to see")]),
        ("lower", vec![user("go"), asst("it is safe to compact")]),
        ("escaped", vec![user("go"), r#"{"type":"assistant","message":{"content":[{"type":"text","text":"safe"}]}}"#.into()]),
        ("lone", vec![user("go"), r#"{"type":"assistant","message":{"content":[{"type":"text","text":"x \ud83d SAFE"}]}}"#.into()]),
        ("bad", vec![user("go"), "{not json".into(), asst("ok")]),
        ("reminder", vec![asst(safe), user("<system-reminder>x</system-reminder>")]),
        (
            "codex",
            vec![json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":safe}]}}).to_string()],
        ),
        ("empty", vec![]),
    ];
    let mut paths = vec![json!(format!("{h}/missing.jsonl")), json!("relative.jsonl"), json!(""), json!(5), Value::Null];
    for (name, lines) in &tps {
        let p = format!("{h}/{name}.jsonl");
        std::fs::write(&p, lines.join("\n")).unwrap();
        paths.push(json!(p));
    }
    let calls = [
        ("Bash", json!({"command": "git commit -am x"})),
        ("Bash", json!({"command": "ls -la"})),
        ("Bash", json!({"command": "echo 'rm -rf x'"})),
        ("Bash", json!({"command": "cat a > b"})),
        ("Bash", json!({"command": "cmd 2>&1"})),
        ("Bash", json!({"command": "echo \"x > y\""})),
        ("Bash", json!({"command": 5})),
        ("Agent", json!({"prompt": "x"})),
        ("Write", json!({"file_path": "a.js"})),
        ("Write", json!({"file_path": "/w/.anti-hall/handovers/h.md"})),
        ("Edit", json!({"file_path": ".anti-hall/handovers/h.md"})),
        ("NotebookEdit", json!({"notebook_path": "x.ipynb"})),
        ("Write", json!({"file_path": ""})),
        ("Read", json!({"file_path": "a.js"})),
        ("Grep", json!({"command": "rm x"})),
    ];
    let mut payloads = vec![json!(null), json!([1]), json!("x")];
    for tp in &paths {
        for (tool, input) in &calls {
            for cwd in [json!("/w/proj"), json!("rel"), Value::Null] {
                payloads.push(json!({"hook_event_name": "PreToolUse", "tool_name": tool, "tool_input": input, "transcript_path": tp, "cwd": cwd}));
            }
        }
        payloads.push(json!({"tool_name": "Write", "tool_input": {"file_path": "a"}, "transcript_path": tp, "agent_id": "a1"}));
        payloads.push(json!({"tool_name": "Write", "tool_input": {"file_path": "a"}, "transcript_path": tp, "agent_id": null}));
    }
    let (n, kinds) = assert_parity(&crate::checks::compact_decl::CompactDeclarationGuard, &env(&h), &payloads);
    assert!(kinds.contains("allow") && kinds.contains("defer"), "a corpus that exercises both answers: {kinds:?}");
    // the switch off and a live skip
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"compactDeclarationGuard":false}}"#).unwrap();
    let (off, _) = assert_parity(&crate::checks::compact_decl::CompactDeclarationGuard, &env(&h), &payloads[..60]);
    std::fs::remove_file(format!("{h}/.anti-hall/settings.json")).unwrap();
    std::fs::write(format!("{h}/.anti-hall/skip.json"), format!(r#"{{"compact-declaration-guard":{}}}"#, 4_102_444_800_000u64)).unwrap();
    let (skip, _) = assert_parity(&crate::checks::compact_decl::CompactDeclarationGuard, &env(&h), &payloads[..60]);
    assert!(n + off + skip > 800, "corpus size {n} {off} {skip}");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

#[test]
fn ship_it_guard_script_matches_the_compiled_port() {
    let h = home("si");
    std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"shipitGate":true}}"#).unwrap();
    let with_plan = format!("{h}/withplan");
    let no_plan = format!("{h}/noplan");
    let no_phase = format!("{h}/nophase");
    std::fs::create_dir_all(&with_plan).unwrap();
    std::fs::create_dir_all(&no_plan).unwrap();
    std::fs::create_dir_all(&no_phase).unwrap();
    std::fs::write(
        format!("{with_plan}/PLAN.md"),
        "# Plan\n\n## Phases\n\n### Phase 1 \u{e9}t\u{e9} \u{1F600}\n- files: `src/a.rs`, src/b.rs, ./lib/c.js.\n- goal: x\n\n### Phase 2\n- Files:\n  - docs/x.md\n  - auth/login.ts\n\n## Risks\n- files: nope/z.rs\n",
    )
    .unwrap();
    std::fs::write(format!("{no_phase}/PLAN.md"), "# Plan\nnothing\n").unwrap();
    let files = [
        "src/a.rs",
        "src/b.rs",
        "lib/c.js",
        "src/other.rs",
        "auth/login.ts",
        "migrations/001.sql",
        ".github/workflows/ci.yml",
        "README.md",
        "src/x.test.ts",
        "tests/a.rs",
        "PLAN.md",
        "nope/z.rs",
        "a\\b\\c.rs",
        "",
        "user_session.py",
    ];
    let mut payloads = vec![json!(null), json!([1]), json!({"tool_name": "Bash", "tool_input": {"command": "x"}}), json!({"tool_name": "apply_patch"})];
    for cwd in [json!(with_plan), json!(no_plan), json!(no_phase), json!("rel"), Value::Null] {
        for f in files {
            let abs = format!("{}/{f}", cwd.as_str().unwrap_or(""));
            for fp in [json!(f), json!(abs)] {
                payloads.push(json!({"tool_name": "Write", "cwd": cwd, "tool_input": {"file_path": fp}}));
            }
            payloads.push(json!({"tool_name": "MultiEdit", "cwd": cwd, "tool_input": {"file_path": "README.md", "edits": [{"file_path": f}, {"x": 1}, 5]}}));
        }
        payloads.push(json!({"tool_name": "Edit", "cwd": cwd, "tool_input": "str"}));
    }
    let (n, kinds) = assert_parity(&crate::checks::ship_it::ShipItGuard, &env(&h), &payloads);
    assert!(["allow", "defer", "block", "advisory"].iter().all(|k| kinds.contains(k)), "a corpus that exercises every answer: {kinds:?}");
    std::fs::remove_file(format!("{h}/.anti-hall/settings.json")).unwrap();
    let (off, _) = assert_parity(&crate::checks::ship_it::ShipItGuard, &env(&h), &payloads);
    assert!(n + off > 300, "corpus size {n} {off}");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

#[test]
fn an_owner_override_wins_and_an_edit_reloads_without_a_restart() {
    let h = home("ov");
    let e = env(&h);
    let p = json!({"tool_name": "Write", "tool_input": {"file_path": "a.rs"}, "cwd": "/x"});
    // the shipped script answers first (gate off: allow)
    assert_eq!(run_forced("ship-it-guard", &p, &e), Some(Some(Verdict::Allow)));
    put_override(&h, "ship-it-guard", "function decide(p) { return {block: 'owner says ' + p.tool_name}; }");
    assert_eq!(run_forced("ship-it-guard", &p, &e), Some(Some(Verdict::Block("owner says Write".into()))));
    // an edit of the same size must still reload: bump the modification time explicitly
    put_override(&h, "ship-it-guard", "function decide(p) { return {block: 'owner said ' + p.tool_name}; }");
    let f = std::fs::File::options().write(true).open(format!("{h}/.anti-hall/logic/ship-it-guard.js")).unwrap();
    f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(run_forced("ship-it-guard", &p, &e), Some(Some(Verdict::Block("owner said Write".into()))));
    std::fs::remove_file(format!("{h}/.anti-hall/logic/ship-it-guard.js")).unwrap();
    assert_eq!(run_forced("ship-it-guard", &p, &e), Some(Some(Verdict::Allow)));
    // no script at all: the compiled port decides
    assert_eq!(run_forced("no-such-check", &p, &e), None);
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

#[test]
fn a_runaway_script_is_interrupted_and_defers() {
    let h = home("loop");
    let e = env(&h);
    put_override(&h, "zz-loop", "function decide() { for (;;) {} }");
    let t = Instant::now();
    assert_eq!(run_forced("zz-loop", &json!({}), &e), Some(Some(Verdict::Defer)));
    assert!(t.elapsed() < std::time::Duration::from_millis(defaults::num("script.time_limit_ms") * 10), "{:?}", t.elapsed());
    // a catastrophic native regex is interrupted too
    put_override(&h, "zz-redos", "function decide() { return /^(a+)+$/.test('a'.repeat(40) + 'b') ? 'allow' : 'defer'; }");
    let t = Instant::now();
    assert_eq!(run_forced("zz-redos", &json!({}), &e), Some(Some(Verdict::Defer)));
    assert!(t.elapsed() < std::time::Duration::from_millis(defaults::num("script.time_limit_ms") * 10), "{:?}", t.elapsed());
    // the same thread's runtime still works afterwards
    put_override(&h, "zz-ok", "function decide() { return 'allow'; }");
    assert_eq!(run_forced("zz-ok", &json!({}), &e), Some(Some(Verdict::Allow)));
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

#[test]
fn a_script_past_its_memory_ceiling_defers() {
    let h = home("oom");
    let e = env(&h);
    put_override(&h, "zz-oom", "function decide() { var a = []; for (;;) a.push('x'.repeat(1 << 16) + a.length); }");
    assert_eq!(run_forced("zz-oom", &json!({}), &e), Some(Some(Verdict::Defer)));
    put_override(&h, "zz-deep", "function f(n) { return f(n + 1) + 1; } function decide() { return f(0); }");
    assert_eq!(run_forced("zz-deep", &json!({}), &e), Some(Some(Verdict::Defer)));
    put_override(&h, "zz-shape", "function decide() { return 42; }");
    assert_eq!(run_forced("zz-shape", &json!({}), &e), Some(Some(Verdict::Defer)));
    put_override(&h, "zz-ok", "function decide() { return 'allow'; }");
    assert_eq!(run_forced("zz-ok", &json!({}), &e), Some(Some(Verdict::Allow)));
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// The teardown assertion: a worker thread's runtime is freed when the thread exits, after normal calls, an interrupt, an
/// out-of-memory failure, an exception and a reload. An object left alive would abort the whole test process here.
#[test]
fn a_worker_thread_tears_its_runtime_down_cleanly() {
    let h = home("td");
    put_override(&h, "zz-cycle", "var keep = []; function decide(p) { var a = {}; var b = {a: a}; a.b = b; keep.push(a); return 'allow'; }");
    put_override(&h, "zz-throw", "function decide() { throw new Error('boom'); }");
    put_override(&h, "zz-loop", "function decide() { for (;;) {} }");
    put_override(&h, "zz-oom", "function decide() { var a = []; for (;;) a.push('y'.repeat(1 << 16) + a.length); }");
    for _ in 0..3 {
        let h2 = h.clone();
        std::thread::spawn(move || {
            let e = env(&h2);
            for name in ["zz-cycle", "zz-throw", "zz-loop", "zz-oom", "ship-it-guard", "compact-declaration-guard", "zz-cycle"] {
                assert!(run_forced(name, &json!({"tool_name": "Bash", "tool_input": {"command": "ls"}}), &e).is_some());
            }
            put_override(&h2, "zz-cycle", "var keep2 = [{}]; function decide() { return 'defer'; }");
            assert_eq!(run_forced("zz-cycle", &json!({}), &e), Some(Some(Verdict::Defer)));
        })
        .join()
        .expect("the worker thread exits without a teardown abort");
        put_override(&h, "zz-cycle", "var keep = []; function decide(p) { var a = {}; var b = {a: a}; a.b = b; keep.push(a); return 'allow'; }");
    }
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

// ---- the scoped write API (D88 condition a) ----

fn write_home(tag: &str) -> String {
    let h = home(tag);
    std::fs::create_dir_all(format!("{h}/.anti-hall")).unwrap();
    h
}

#[test]
fn a_scripted_write_lands_atomically_under_the_state_directory() {
    let h = write_home("w-ok");
    assert!(host::write_atomic(&h, "orch-full/m-1.json", "{\"a\":1}").unwrap());
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/orch-full/m-1.json")).unwrap(), "{\"a\":1}");
    assert!(host::write_atomic(&h, "orch-full/m-1.json", "second").unwrap(), "replacing a file is allowed");
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/orch-full/m-1.json")).unwrap(), "second");
    let stray: Vec<_> = std::fs::read_dir(format!("{h}/.anti-hall/orch-full")).unwrap().flatten().collect();
    assert_eq!(stray.len(), 1, "the atomic helper leaves no temporary file");
}

#[test]
fn a_scripted_write_refuses_every_path_outside_the_state_directory() {
    let h = write_home("w-path");
    let long = "a".repeat(defaults::num("script.write_path_max") as usize + 1);
    for bad in ["/etc/x", "../x", "a/../../b", "a/..", "./a", "a/./b", "a//b", "a/", "", "..", ".", "a\0b", long.as_str(), "/"] {
        assert!(host::write_atomic(&h, bad, "t").is_err(), "{bad:?} must be refused");
    }
    assert!(!std::path::Path::new(&format!("{h}/x")).exists(), "nothing escaped the root");
    assert!(host::write_atomic("relative/home", "a", "t").is_err(), "no absolute home");
    let big = "x".repeat(defaults::num("script.write_max_bytes") as usize + 1);
    assert!(host::write_atomic(&h, "big", &big).is_err(), "over the size cap");
    assert!(host::write_atomic(&h, "ok", &big[..big.len() - 1]).unwrap(), "exactly at the cap is allowed");
}

#[test]
fn a_scripted_write_refuses_to_follow_a_link_out_of_the_state_directory() {
    let h = write_home("w-link");
    let outside = std::path::Path::new(&h).join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret"), "keep").unwrap();
    // a directory link below the root, a file link below the root, and a dangling link
    std::os::unix::fs::symlink(&outside, format!("{h}/.anti-hall/dirlink")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret"), format!("{h}/.anti-hall/filelink")).unwrap();
    std::os::unix::fs::symlink(outside.join("new"), format!("{h}/.anti-hall/dangling")).unwrap();
    for rel in ["dirlink/f", "dirlink/secret", "filelink", "dangling", "dirlink/deep/er"] {
        assert!(host::write_atomic(&h, rel, "pwned").is_err(), "{rel} must be refused");
    }
    assert_eq!(std::fs::read_to_string(outside.join("secret")).unwrap(), "keep");
    assert!(!outside.join("new").exists() && !outside.join("f").exists() && !outside.join("deep").exists());
    // a file where a directory is needed, and a directory where a file is
    std::fs::write(format!("{h}/.anti-hall/plain"), "x").unwrap();
    std::fs::create_dir_all(format!("{h}/.anti-hall/adir")).unwrap();
    assert!(host::write_atomic(&h, "plain/f", "t").is_err());
    assert!(host::write_atomic(&h, "adir", "t").is_err());
    // the state directory itself may be a link the owner set up: what is refused is a link BELOW it
    let h2 = home("w-rootlink");
    let real = format!("{h2}/elsewhere");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::remove_dir_all(format!("{h2}/.anti-hall")).unwrap();
    std::os::unix::fs::symlink(&real, format!("{h2}/.anti-hall")).unwrap();
    assert!(host::write_atomic(&h2, "f", "t").unwrap());
    assert_eq!(std::fs::read_to_string(format!("{real}/f")).unwrap(), "t");
}

#[test]
fn a_script_that_tries_to_escape_the_state_directory_fails_and_defers() {
    let h = write_home("w-script");
    put_override(&h, "zz-escape", "function decide(p){ ah.state.writeAtomic('../escaped', 'x'); return 'allow'; }");
    put_override(&h, "zz-write", "function decide(p){ return ah.state.writeAtomic('zz/ok.txt', 'hello') ? 'allow' : 'defer'; }");
    let e = env(&h);
    assert_eq!(run_forced("zz-escape", &json!({}), &e), Some(Some(Verdict::Defer)), "the refusal is a script failure, so Node decides");
    assert!(!std::path::Path::new(&format!("{h}/escaped")).exists());
    assert_eq!(run_forced("zz-write", &json!({}), &e), Some(Some(Verdict::Allow)));
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/zz/ok.txt")).unwrap(), "hello");
}

// ---- the script-failure policy (D88 condition b) ----

#[test]
fn a_check_with_a_node_twin_defers_when_its_script_fails_on_any_event() {
    for event in ["PreToolUse", "Stop", "SessionStart", "UserPromptSubmit", "PostToolUse"] {
        assert_eq!(failed("ship-it-guard", event, "boom"), Verdict::Defer, "{event}");
    }
}

#[test]
fn an_engine_only_check_blocks_on_a_guard_event_and_allows_quietly_elsewhere() {
    let engine_only = defaults::list("script.engine_only_checks");
    assert!(engine_only.contains(&"sibling-sweep"));
    for name in &engine_only {
        assert!(crate::checks::get(name).is_some(), "{name} is not a registered check");
        for event in defaults::list("dispatch.guard_events") {
            assert!(matches!(failed(name, event, "boom"), Verdict::Block(m) if m.contains("boom") && m.contains(name)), "{name} on {event}");
        }
        for event in ["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "PreCompact"] {
            assert_eq!(failed(name, event, "boom"), Verdict::Allow, "{name} on {event}: never block a non-guard event");
        }
    }
}

#[test]
fn the_policy_applies_to_every_kind_of_script_failure() {
    let h = home("policy");
    put_override(&h, "sibling-sweep", "function decide(p){ throw new Error('bad'); }");
    let e = env(&h);
    let go = |event: &str| super::run_forced("sibling-sweep", &json!({}), &Value::Null, event, &e).expect("a script").expect("an answer");
    assert!(matches!(go("Stop"), Verdict::Block(_)), "an exception on a guard event");
    assert_eq!(go("SessionStart"), Verdict::Allow, "an exception on a non-guard event");
    put_override(&h, "sibling-sweep", "function decide(p){ for(;;){} }");
    assert!(matches!(go("SubagentStop"), Verdict::Block(_)), "an interrupted loop on a guard event");
    assert_eq!(go("PostToolUse"), Verdict::Allow);
    put_override(&h, "sibling-sweep", "function decide(p){ return 42; }");
    assert!(matches!(go("PreToolUse"), Verdict::Block(_)), "a verdict of the wrong shape");
    put_override(&h, "sibling-sweep", "this is not javascript (");
    assert!(matches!(go("Stop"), Verdict::Block(_)), "a script that does not load");
    // a registered scripted check with no script file at all follows the same policy
    assert_eq!(crate::script::missing("ship-it-guard", "PreToolUse"), Some(Verdict::Defer));
    assert!(matches!(crate::script::missing("sibling-sweep", "Stop"), Some(Verdict::Block(_))));
    assert_eq!(crate::script::missing("sibling-sweep", "SessionStart"), Some(Verdict::Allow));
}

#[test]
fn the_compiled_logic_counter_counts_the_checks_without_a_script_entry() {
    let total = crate::checks::registry().len();
    let scripted = crate::checks::registry().iter().filter(|c| c.scripted()).count();
    assert_eq!(crate::checks::compiled_logic_checks_remaining(), total - scripted);
    let (logic_dir, ext) = (defaults::text("script.logic_dir"), defaults::text("script.ext"));
    for c in crate::checks::registry().iter().filter(|c| c.scripted()) {
        let shipped = defaults::root().expect("plugin root").join(logic_dir).join(format!("{}{ext}", c.name()));
        assert!(shipped.is_file(), "scripted check {} has no shipped script {}", c.name(), shipped.display());
    }
}

// ---- golden parity of the migrated checks ----

#[test]
fn api_guard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("api-guard");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 50 && kinds.get("defer").copied().unwrap_or(0) > 50, "a corpus that exercises both answers: {kinds:?}");
}
