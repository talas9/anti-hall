//! Tests of the scripted check runtime (D88): the golden parity of the migrated checks, the owner
//! override, reload on change, the per-call limits, and runtime teardown.
use super::*;
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

/// `run_forced` for a payload with no options, as a PreToolUse call.
fn run_forced(name: &str, p: &Value, e: &RequestEnv) -> Option<Option<Verdict>> {
    super::run_forced(name, p, &Value::Null, "PreToolUse", e)
}

fn user(t: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": t}}).to_string()
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
    assert!(host::write_atomic(&h, ".anti-hall/orch-full/m-1.json", "{\"a\":1}").unwrap());
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/orch-full/m-1.json")).unwrap(), "{\"a\":1}");
    assert!(host::write_atomic(&h, ".anti-hall/orch-full/m-1.json", "second").unwrap(), "replacing a file is allowed");
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/orch-full/m-1.json")).unwrap(), "second");
    let stray: Vec<_> = std::fs::read_dir(format!("{h}/.anti-hall/orch-full")).unwrap().flatten().collect();
    assert_eq!(stray.len(), 1, "the atomic helper leaves no temporary file");
}

#[test]
fn a_scripted_write_refuses_every_path_outside_the_state_directory() {
    let h = write_home("w-path");
    let long = "a".repeat(defaults::num("script.write_path_max") as usize + 1);
    for bad in [
        "/etc/x",
        "../x",
        ".anti-hall/../x",
        ".anti-hall/a/../../b",
        ".anti-hall/..",
        "./.anti-hall/a",
        ".anti-hall/./b",
        ".anti-hall//b",
        ".anti-hall/",
        ".anti-hall",
        "",
        "..",
        ".",
        ".anti-hall/a\0b",
        "x/y",
        "elsewhere/f",
        ".anti-hallx/f",
        "/.anti-hall/f",
        long.as_str(),
        "/",
    ] {
        assert!(host::write_atomic(&h, bad, "t").is_err(), "{bad:?} must be refused");
    }
    assert!(!std::path::Path::new(&format!("{h}/x")).exists(), "nothing escaped the root");
    assert!(host::write_atomic("relative/home", ".anti-hall/a", "t").is_err(), "no absolute home");
    let big = "x".repeat(defaults::num("script.write_max_bytes") as usize + 1);
    assert!(host::write_atomic(&h, ".anti-hall/big", &big).is_err(), "over the size cap");
    assert!(host::write_atomic(&h, ".anti-hall/ok", &big[..big.len() - 1]).unwrap(), "exactly at the cap is allowed");
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
    for rel in [".anti-hall/dirlink/f", ".anti-hall/dirlink/secret", ".anti-hall/filelink", ".anti-hall/dangling", ".anti-hall/dirlink/deep/er"] {
        assert!(host::write_atomic(&h, rel, "pwned").is_err(), "{rel} must be refused");
    }
    assert_eq!(std::fs::read_to_string(outside.join("secret")).unwrap(), "keep");
    assert!(!outside.join("new").exists() && !outside.join("f").exists() && !outside.join("deep").exists());
    // a file where a directory is needed, and a directory where a file is
    std::fs::write(format!("{h}/.anti-hall/plain"), "x").unwrap();
    std::fs::create_dir_all(format!("{h}/.anti-hall/adir")).unwrap();
    assert!(!host::write_atomic(&h, ".anti-hall/plain/f", "t").unwrap(), "an I/O failure, not a policy violation");
    assert!(!host::write_atomic(&h, ".anti-hall/adir", "t").unwrap());
    // the state directory itself may be a link the owner set up: what is refused is a link BELOW it
    let h2 = home("w-rootlink");
    let real = format!("{h2}/elsewhere");
    std::fs::create_dir_all(&real).unwrap();
    std::fs::remove_dir_all(format!("{h2}/.anti-hall")).unwrap();
    std::os::unix::fs::symlink(&real, format!("{h2}/.anti-hall")).unwrap();
    assert!(host::write_atomic(&h2, ".anti-hall/f", "t").unwrap());
    assert_eq!(std::fs::read_to_string(format!("{real}/f")).unwrap(), "t");
}

#[test]
fn a_script_that_tries_to_escape_the_state_directory_fails_and_defers() {
    let h = write_home("w-script");
    put_override(&h, "zz-escape", "function decide(p){ ah.state.writeAtomic('.anti-hall/../escaped', 'x'); return 'allow'; }");
    put_override(&h, "zz-write", "function decide(p){ return ah.state.writeAtomic('.anti-hall/zz/ok.txt', 'hello') ? 'allow' : 'defer'; }");
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

#[test]
fn orch_on_spawn_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("orch-on-spawn");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 20 && kinds.get("defer").copied().unwrap_or(0) > 5, "both answers: {kinds:?}");
}

#[test]
fn verify_first_subagent_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("verify-first-subagent");
    assert!(kinds.get("advisory").copied().unwrap_or(0) > 20 && kinds.get("allow").copied().unwrap_or(0) > 5, "advisory and allow: {kinds:?}");
}

#[test]
fn verify_first_full_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("verify-first-full");
    assert!(kinds.get("advisory").copied().unwrap_or(0) > 50 && kinds.get("allow").copied().unwrap_or(0) > 5, "advisory and allow: {kinds:?}");
}

#[test]
fn fable_availability_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("fable-availability");
    assert!(kinds.get("advisory").copied().unwrap_or(0) > 5 && kinds.get("allow").copied().unwrap_or(0) > 20, "advisory and allow: {kinds:?}");
}

#[test]
fn edit_guard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("edit-guard");
    for k in ["allow", "defer", "exact"] {
        assert!(kinds.get(k).copied().unwrap_or(0) > 20, "a corpus that exercises {k}: {kinds:?}");
    }
}

#[test]
fn a_config_nested_past_the_compiled_readers_limit_is_decided_as_node_decides_it() {
    // The compiled port could not parse JSON nested past 128 and deferred; JSON.parse (Node's reader) can, so the script
    // decides: nothing about Fable in it, so the state is written with `available: null` and the check stays silent.
    let h = write_home("fa-deep");
    std::fs::write(format!("{h}/.claude.json"), format!("{}{}", "[".repeat(200), "]".repeat(200))).unwrap();
    let e = env(&h);
    assert_eq!(run_forced("fable-availability", &json!({}), &e), Some(Some(Verdict::Allow)));
    let state = std::fs::read_to_string(format!("{h}/.anti-hall/fable-availability.json")).unwrap();
    assert!(state.starts_with("{\"available\":null,\"checkedAt\":") && state.ends_with(",\"source\":\"unknown\"}"), "{state}");
}

#[test]
fn a_config_over_the_read_cap_defers_instead_of_being_read_truncated() {
    let h = write_home("fa-big");
    let cap = defaults::num("script.read_max_bytes") as usize;
    std::fs::write(format!("{h}/.claude.json"), format!("{{\"pad\":\"{}\"}}", "x".repeat(cap))).unwrap();
    assert_eq!(run_forced("fable-availability", &json!({}), &env(&h)), Some(Some(Verdict::Defer)));
    assert!(!std::path::Path::new(&format!("{h}/.anti-hall/fable-availability.json")).exists(), "nothing written before the deferral");
}

#[test]
fn ship_it_guard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("ship-it-guard");
    for k in ["allow", "defer", "block", "advisory"] {
        assert!(kinds.get(k).copied().unwrap_or(0) > 5, "a corpus that exercises {k}: {kinds:?}");
    }
}

/// Every case of a golden corpus through the script; mismatches are listed (up to `limit`) before the test fails.
pub(super) fn golden_report(check: &str, limit: usize) {
    let cases = golden::load(check);
    let (mut bad, mut shown) = (0usize, 0usize);
    for c in &cases {
        let l = golden::lay(c);
        let got = golden::run_case(check, &l, golden::repeat_of(c)).unwrap_or_else(|| panic!("{check}: no shipped script"));
        let got = golden::verdict_json(&got, &l);
        let mut ok = got == c["expect"];
        if ok && c.get("watch").is_some() {
            let w = golden::watched_all_pub(c, &l);
            ok = w == c["writes"];
            if !ok {
                eprintln!("FILES differ on {check} n={}\n  expect={}\n  got   ={}", c["n"], c["writes"], w);
            }
        }
        if !ok {
            bad += 1;
            if shown < limit {
                shown += 1;
                let mut p = c["payload"].to_string();
                p.truncate(300);
                eprintln!("MISMATCH {check} n={}\n  payload={p}\n  expect={}\n  got   ={}\n  errors={:?}", c["n"], c["expect"].to_string().chars().take(500).collect::<String>(), got.to_string().chars().take(500).collect::<String>(), crate::discard::captured());
            }
        }
        crate::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
    }
    eprintln!("GOLDEN {check}: {} cases, {bad} mismatches", cases.len());
    assert_eq!(bad, 0, "{check}: {bad} of {} cases differ from the compiled port", cases.len());
}

#[test]
fn git_script_matches_the_compiled_port() {
    golden_report("git", 12);
}

#[test]
fn sibling_sweep_script_matches_the_compiled_port() {
    golden_report("sibling-sweep", 12);
}

#[test]
fn ask_guard_script_matches_the_compiled_port() {
    golden_report("ask-guard", 12);
}

#[test]
fn failure_nudge_script_matches_the_compiled_port() {
    golden_report("failure-root-cause-nudge", 12);
}

#[test]
fn output_verify_script_matches_the_compiled_port() {
    golden_report("output-verify-guard", 12);
}

#[test]
fn session_scripts_match_their_compiled_ports() {
    for check in ["devswarm-version", "claude-cli-version", "version-alert", "repo-self-drift", "defect-nudge", "progress-prune"] {
        golden_report(check, 12);
    }
}

#[test]
fn handover_and_budget_scripts_match_their_compiled_ports() {
    for check in ["emit-dedupe-reset", "precompact-snapshot", "limit-conserve-inject", "auto-handover", "handover-resume"] {
        golden_report(check, 12);
    }
}

#[test]
fn phase_tracker_script_matches_the_compiled_port() {
    golden_report("phase-tracker", 12);
}

// ---- swarm-guard (ported from the compiled check's unit tests; the memory figures and the clock are replaced by an owner-style
// override of the lib helper, exactly the editable-script mechanism a user has) ----

mod swarm {
    use super::*;

    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const T0: u64 = 1_700_000_000_000;

    fn swarm_home(tag: &str) -> String {
        let h = home(tag);
        std::fs::create_dir_all(format!("{h}/.anti-hall")).unwrap();
        h
    }

    fn call(h: &str, p: &Value, now: u64, avail: Option<f64>, total: f64) -> Option<Option<Verdict>> {
        let a = avail.map_or("null".to_string(), |v| format!("{v}"));
        std::fs::create_dir_all(format!("{h}/.anti-hall/logic/lib")).unwrap();
        std::fs::write(
            format!("{h}/.anti-hall/logic/lib/99-test.js"),
            format!("ah.sys.memory = function(){{ return {{available: {a}, total: {total}}}; }}; Date.now = function(){{ return {now}; }};"),
        )
        .unwrap();
        run_forced("swarm-guard", p, &env(h))
    }

    fn spawn() -> Value {
        json!({"tool_name": "Agent", "tool_input": {"subagent_type": "Explore", "prompt": "x"}, "session_id": "s"})
    }

    fn text_of(v: &Option<Option<Verdict>>) -> String {
        match v {
            Some(Some(Verdict::Exact(x))) => x.out.clone(),
            other => format!("{other:?}"),
        }
    }

    #[test]
    fn memory_below_the_floor_blocks_and_the_numbers_are_rounded_like_javascript() {
        let h = swarm_home("sw-mem");
        let v = call(&h, &spawn(), T0, Some(0.04 * 16.0 * GB - 1.0), 16.0 * GB);
        let Some(Some(Verdict::Exact(x))) = &v else { panic!("expected a block, got {v:?}") };
        assert_eq!(x.code, 2);
        assert!(x.out.contains("memory pressure critical (655 MB available of 16384 MB total, < 4%)"), "{}", x.out);
        assert_eq!(call(&h, &spawn(), T0, Some(0.04 * 16.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)), "exactly at the floor is allowed");
        assert_eq!(call(&h, &spawn(), T0 + 1, None, 16.0 * GB), Some(Some(Verdict::Allow)), "an unreadable figure skips the gate");
    }

    #[test]
    fn the_cap_blocks_the_next_spawn_and_a_block_is_not_recorded() {
        let h = swarm_home("sw-cap");
        for i in 0..20 {
            assert_eq!(call(&h, &spawn(), T0 + i, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)), "spawn {i}");
        }
        let log = format!("{h}/.anti-hall/swarm-spawns.log");
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 20);
        let v = call(&h, &spawn(), T0 + 21, Some(8.0 * GB), 16.0 * GB);
        assert!(text_of(&v).contains("agent spawn-rate ceiling reached (20 spawns in the last 60s, cap is 20)."), "{v:?}");
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 20, "a block must not extend the window");
        let trips = std::fs::read_to_string(format!("{h}/.anti-hall/swarm-trips.log")).unwrap();
        assert!(trips.ends_with("Z\t20\tAgent:Explore\n") && trips.starts_with("2023-11-14T22:13:20.021Z\t"), "{trips}");
        assert_eq!(call(&h, &spawn(), T0 + 60_100, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)), "a minute later the window has moved on");
    }

    fn transcript(h: &str, input: Value) -> String {
        let path = format!("{h}/t.jsonl");
        let launch = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "toolu_1", "name": "Agent", "input": input}]}});
        let result = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1",
            "content": "Async agent launched successfully.\nagentId: a1b2c3d4e5f60718 (internal ID - do not mention to user)\noutput_file: /tmp/x/a1b2c3d4e5f60718.output"}]}});
        std::fs::write(&path, format!("{launch}\n{result}\n")).unwrap();
        path
    }

    fn advisory(v: Option<Option<Verdict>>) -> Option<String> {
        match v {
            Some(Some(Verdict::Advisory(a))) => Some(a),
            Some(Some(Verdict::Allow)) => None,
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_write_capable_spawn_beside_a_running_writer_gets_the_advisory_and_is_recorded() {
        let h = swarm_home("sw-adv");
        let t = transcript(&h, json!({"subagent_type": "general-purpose", "prompt": "fix it"}));
        let writer = json!({"tool_name": "Agent", "tool_input": {"subagent_type": "general-purpose"}, "transcript_path": t, "cwd": h});
        let a = advisory(call(&h, &writer, T0, Some(8.0 * GB), 16.0 * GB)).expect("advisory");
        assert!(a.contains("anti-hall \u{b7} shared-tree: another write-capable agent") && a.contains("pass isolation:\\\"worktree\\\""), "{a}");
        assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/swarm-spawns.log")).unwrap().lines().count(), 1, "an advisory spawn is recorded once");
        std::fs::write(format!("{h}/CLAUDE.md"), "Rules: no worktrees here.\n").unwrap();
        let a = advisory(call(&h, &writer, T0 + 1, Some(8.0 * GB), 16.0 * GB)).expect("advisory");
        assert!(a.contains("serialize them or give each its own scratch clone.") && !a.contains("isolation"), "{a}");
    }

    #[test]
    fn the_advisory_is_silent_whenever_node_is_silent() {
        let h = swarm_home("sw-quiet");
        let busy = transcript(&h, json!({"subagent_type": "general-purpose"}));
        let mut n = 0u64;
        let mut silent = |input: Value, t: &str| {
            n += 1;
            let p = json!({"tool_name": "Agent", "tool_input": input, "transcript_path": t, "cwd": h});
            advisory(call(&h, &p, T0 + n, Some(8.0 * GB), 16.0 * GB)).is_none()
        };
        assert!(silent(json!({"subagent_type": "Explore"}), &busy), "a read-only type");
        assert!(silent(json!({"isolation": "worktree"}), &busy), "an isolated spawn");
        assert!(silent(json!({"prompt": "work in a scratch clone under /tmp/x"}), &busy), "a scratch spawn");
        assert!(!silent(json!({"prompt": "work in a scratch clone under /tmp/x, in the repo"}), &busy), "an in-place statement cancels scratch");
        assert!(!silent(json!({"prompt": "not in scratch /tmp/x"}), &busy), "a negation cancels scratch");
        assert!(silent(json!({}), "/missing/transcript.jsonl"), "an unreadable transcript");
        assert!(silent(json!({}), &transcript(&h, json!({"subagent_type": "Explore"}))), "the other agent is read-only");
        assert!(silent(json!({}), &transcript(&h, json!({"isolation": "remote"}))), "the other agent is isolated");
        assert!(silent(json!({}), &transcript(&h, json!({"prompt": "cd /private/tmp/x and work"}))), "the other agent works in scratch");
        let no_transcript = json!({"tool_name": "Agent", "tool_input": {}});
        assert!(advisory(call(&h, &no_transcript, T0 + 100_000, Some(8.0 * GB), 16.0 * GB)).is_none());
    }

    #[test]
    fn what_the_script_cannot_reproduce_defers_before_the_spawn_is_recorded() {
        let h = swarm_home("sw-defer");
        let t = transcript(&h, json!({"subagent_type": "general-purpose"}));
        let log = format!("{h}/.anti-hall/swarm-spawns.log");
        let no_cwd = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": t});
        assert_eq!(call(&h, &no_cwd, T0, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Defer)), "no cwd: Node would use the hook's own directory");
        let rel = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": "t.jsonl", "cwd": h});
        assert_eq!(call(&h, &rel, T0 + 1, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Defer)), "a relative transcript path");
        let odd = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": t, "cwd": format!("{h}/../x")});
        assert_eq!(call(&h, &odd, T0 + 2, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Defer)), "a cwd that is not in normal form");
        assert!(!std::path::Path::new(&log).exists(), "a deferral must not record the spawn");
    }

    #[test]
    fn the_log_is_read_like_parse_int_and_a_huge_entry_defers() {
        let h = swarm_home("sw-huge");
        std::fs::write(format!("{h}/.anti-hall/swarm-spawns.log"), "99999999999999999999\n").unwrap();
        assert_eq!(call(&h, &spawn(), T0, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Defer)));
        // a log with junk lines, a CR and a sign: only the positive finite numbers count
        let h2 = swarm_home("sw-parse");
        std::fs::write(format!("{h2}/.anti-hall/swarm-spawns.log"), format!("abc\r\n{}\n-5\n+{}abc\n0x10\n\n", T0 - 10, T0 - 20)).unwrap();
        assert_eq!(call(&h2, &spawn(), T0, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)));
        let log = std::fs::read_to_string(format!("{h2}/.anti-hall/swarm-spawns.log")).unwrap();
        assert_eq!(log.lines().map(str::to_string).collect::<Vec<_>>(), vec![(T0 - 10).to_string(), (T0 - 20).to_string(), T0.to_string()]);
    }

    #[test]
    fn the_write_capability_test_follows_the_node_helper() {
        let h = swarm_home("sw-cap2");
        // every spawn shares the tree unless the type or the tool list says it cannot write: probed through the advisory
        let t = transcript(&h, json!({"subagent_type": "general-purpose"}));
        let probe = |input: Value, n: u64| {
            let p = json!({"tool_name": "Agent", "tool_input": input, "transcript_path": t, "cwd": h});
            advisory(call(&h, &p, T0 + 200_000 + n * 70_000, Some(8.0 * GB), 16.0 * GB)).is_some()
        };
        assert!(!probe(json!({"subagent_type": "  EXPLORE "}), 1));
        assert!(probe(json!({"subagent_type": "general-purpose"}), 2));
        assert!(!probe(json!({"tools": ["Read", "Grep"]}), 3));
        assert!(probe(json!({"tools": ["Read", "Edit"]}), 4));
        assert!(!probe(json!({"tools": []}), 5));
        assert!(!probe(json!({"tools": "Read, Grep"}), 6));
        assert!(probe(json!({"tools": 5}), 7));
        assert!(!probe(json!({"disallowedTools": ["Edit", "Write", "MultiEdit"]}), 8));
        assert!(probe(json!({"disallowedTools": ["Edit", "Write"]}), 9));
        assert!(probe(json!({"tools": [["Edit"]]}), 10));
    }
}

// ---- sibling-sweep (the decision tests of the compiled check, driven through the script; the golden corpus covers the
// matcher over its message corpus and the single-call outcomes) ----

mod sibling {
    use super::*;

    const CAUSE: &str = "Root cause: `read_window` holds the file twice, so memory doubles. Fixed by streaming the lines.";

    fn h(tag: &str) -> String {
        let d = home(&format!("sib-{tag}"));
        std::fs::create_dir_all(format!("{d}/.anti-hall")).unwrap();
        d
    }

    fn assistant(blocks: Value) -> String {
        json!({"type": "assistant", "message": {"role": "assistant", "content": blocks}}).to_string()
    }

    fn say(t: &str) -> String {
        assistant(json!([{"type": "text", "text": t}]))
    }

    fn tool(name: &str, input: Value) -> String {
        assistant(json!([{"type": "tool_use", "id": "t1", "name": name, "input": input}]))
    }

    fn result() -> String {
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}).to_string()
    }

    fn write(home: &str, name: &str, lines: &[String]) -> String {
        let p = format!("{home}/{name}");
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        p
    }

    fn append(path: &str, lines: &[String]) {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(path).unwrap();
        writeln!(f, "{}", lines.join("\n")).unwrap();
    }

    fn stop(home: &str, transcript: &str, reply: &str) -> Value {
        json!({"hook_event_name": "Stop", "session_id": "s1", "transcript_path": transcript, "last_assistant_message": reply, "cwd": home})
    }

    fn continuation(home: &str, transcript: &str, reply: &str) -> Value {
        let mut v = stop(home, transcript, reply);
        v["stop_hook_active"] = json!(true);
        v
    }

    fn go(h: &str, p: &Value) -> Verdict {
        let event = p.get("hook_event_name").and_then(Value::as_str).unwrap_or("Stop");
        crate::script::run_forced("sibling-sweep", p, &Value::Null, event, &env(h)).expect("a shipped script").expect("a verdict")
    }

    fn is_adv(v: &Verdict) -> bool {
        matches!(v, Verdict::Advisory(_))
    }

    fn rows(h: &str) -> Vec<Value> {
        let p = format!("{h}/.anti-hall/{}", defaults::text("sibling_sweep.log"));
        std::fs::read_to_string(p).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
    }

    fn results(h: &str, event: &str, key: &str) -> Vec<String> {
        rows(h).iter().filter(|r| r["event"] == event).map(|r| r[key].as_str().unwrap().to_string()).collect()
    }

    fn fire(h: &str, tag: &str) -> String {
        let p = write(h, &format!("{tag}.jsonl"), &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        assert!(is_adv(&go(h, &stop(h, &p, CAUSE))));
        p
    }

    fn configure(h: &str, section: Value) {
        std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"sibling_sweep": section}).to_string()).unwrap();
    }

    #[test]
    fn a_cause_in_a_fix_context_with_no_search_gets_one_reminder_naming_the_pattern() {
        let d = h("sw-fire");
        let p = write(&d, "t.jsonl", &[user("fix the memory bug"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let v = go(&d, &stop(&d, &p, CAUSE));
        let Verdict::Advisory(j) = &v else { panic!("{v:?}") };
        let j: Value = serde_json::from_str(j).unwrap();
        assert_eq!(j["decision"], "block", "the reminder IS a Stop block");
        let t = j["reason"].as_str().unwrap();
        assert!(t.contains("read_window") && t.contains("search the codebase"), "{t}");
        assert_eq!(results(&d, "cause", "result"), ["reminded"]);
    }

    #[test]
    fn once_per_cause_per_turn_then_again_in_a_new_turn() {
        let d = h("sw-once");
        let p = write(&d, "t.jsonl", &[user("fix it"), tool("Edit", json!({})), result(), say(CAUSE)]);
        assert!(is_adv(&go(&d, &stop(&d, &p, CAUSE))));
        assert_eq!(go(&d, &stop(&d, &p, CAUSE)), Verdict::Allow);
        assert_eq!(results(&d, "cause", "result"), ["reminded", "duplicate"]);
        append(&p, &[user("now fix the other one"), tool("Edit", json!({})), result(), say(CAUSE)]);
        assert!(is_adv(&go(&d, &stop(&d, &p, CAUSE))), "a new turn re-arms the cause");
    }

    #[test]
    fn a_search_after_the_cause_statement_means_no_reminder_a_search_before_it_does_not() {
        let d = h("sw-search");
        let after = write(
            &d,
            "a.jsonl",
            &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE), tool("Grep", json!({"pattern": "read_window"})), result(), say("Fixed.")],
        );
        assert_eq!(go(&d, &stop(&d, &after, CAUSE)), Verdict::Allow);
        assert_eq!(results(&d, "cause", "result"), ["swept"]);
        let before = write(&d, "b.jsonl", &[user("fix"), tool("Grep", json!({"pattern": "read_window"})), result(), tool("Edit", json!({})), result(), say(CAUSE)]);
        let mut p = stop(&d, &before, CAUSE);
        p["session_id"] = json!("s2");
        assert!(is_adv(&go(&d, &p)), "the investigation grep came before the statement");
    }

    #[test]
    fn an_explicit_statement_no_fix_context_a_quiet_reply_and_a_continuation_never_remind() {
        let d = h("sw-quiet");
        let msg = format!("{CAUSE} Searched for other occurrences with rg: none.");
        let p = write(&d, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(&msg)]);
        assert_eq!(go(&d, &stop(&d, &p, &msg)), Verdict::Allow);
        let d2 = h("sw-nofix");
        let m2 = "The cause is the cache key, which omits the tenant.";
        let p2 = write(&d2, "t.jsonl", &[user("why is it slow"), say(m2)]);
        assert_eq!(go(&d2, &stop(&d2, &p2, m2)), Verdict::Allow);
        assert_eq!(results(&d2, "cause", "result"), ["no_fix_context"]);
        let d3 = h("sw-gone");
        assert_eq!(go(&d3, &stop(&d3, &format!("{d3}/missing.jsonl"), "Done, tests pass.")), Verdict::Allow);
        assert!(rows(&d3).is_empty(), "a reply without a cause never reads the transcript");
        let d4 = h("sw-cont");
        let p4 = write(&d4, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let mut payload = stop(&d4, &p4, CAUSE);
        payload["stop_hook_active"] = json!(true);
        assert_eq!(go(&d4, &payload), Verdict::Allow);
        assert_eq!(results(&d4, "cause", "result"), ["continuation"]);
    }

    #[test]
    fn the_per_scope_cap_bounds_reminders() {
        let d = h("sw-cap");
        let cap = defaults::num("sibling_sweep.max_per_scope");
        let mut fired = 0;
        for i in 0..cap + 3 {
            let msg = format!("Root cause: `site_{i}` drops the guard, so it fails. Fixed.");
            let p = write(&d, "t.jsonl", &[user(&format!("fix {i}")), tool("Edit", json!({})), result(), say(&msg)]);
            if is_adv(&go(&d, &stop(&d, &p, &msg))) {
                fired += 1;
            }
        }
        assert_eq!(fired, cap);
        assert_eq!(results(&d, "cause", "result").iter().filter(|r| *r == "capped").count(), 3, "{:?}", rows(&d));
    }

    #[test]
    fn the_switch_the_skip_file_a_judge_child_other_events_and_missing_inputs_silence_it() {
        let d = h("sw-off");
        let p = write(&d, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let payload = stop(&d, &p, CAUSE);
        std::fs::write(format!("{d}/.anti-hall/settings.json"), r#"{"guards":{"siblingSweep":false}}"#).unwrap();
        assert_eq!(go(&d, &payload), Verdict::Allow);
        std::fs::write(format!("{d}/.anti-hall/settings.json"), r#"{"guards":{"siblingSweep":true}}"#).unwrap();
        assert!(is_adv(&go(&d, &payload)), "on is the default and an explicit on");
        let d2 = h("sw-child");
        let p2 = write(&d2, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let e = RequestEnv::from_pairs([("HOME", d2.as_str()), ("ANTIHALL_JUDGE_CHILD", "1")]);
        assert_eq!(run_forced("sibling-sweep", &stop(&d2, &p2, CAUSE), &e), Some(Some(Verdict::Allow)));
        let d3 = h("sw-skip");
        let p3 = write(&d3, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let far = (std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 600_000) as u64;
        std::fs::write(format!("{d3}/.anti-hall/skip.json"), format!("{{\"sibling-sweep\":{far}}}")).unwrap();
        assert_eq!(go(&d3, &stop(&d3, &p3, CAUSE)), Verdict::Allow);
        let d4 = h("sw-misc");
        let p4 = write(&d4, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let mut other = stop(&d4, &p4, CAUSE);
        other["hook_event_name"] = json!("PostToolUse");
        assert_eq!(go(&d4, &other), Verdict::Allow);
        let mut nosession = stop(&d4, &p4, CAUSE);
        nosession["session_id"] = json!("");
        assert_eq!(go(&d4, &nosession), Verdict::Allow);
        let mut notranscript = stop(&d4, &p4, CAUSE);
        notranscript["transcript_path"] = json!("");
        assert_eq!(go(&d4, &notranscript), Verdict::Allow);
        assert_eq!(run_forced("sibling-sweep", &stop("", &p4, CAUSE), &RequestEnv::from_pairs([("HOME", "")])), Some(Some(Verdict::Allow)));
    }

    #[test]
    fn a_subagent_stop_reads_its_own_transcript_and_has_its_own_scope() {
        let d = h("sw-sub");
        let own = write(&d, "agent.jsonl", &[user("task"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let parent = write(&d, "parent.jsonl", &[user("p"), say("working")]);
        let payload = json!({"hook_event_name": "SubagentStop", "session_id": "s1", "agent_id": "a9", "transcript_path": parent, "agent_transcript_path": own, "last_assistant_message": CAUSE});
        assert!(is_adv(&go(&d, &payload)));
        assert_eq!(rows(&d)[0]["scope"], "subagent");
        assert!(std::path::Path::new(&format!("{d}/.anti-hall/sibling-sweep-s1-a9.json")).exists());
    }

    #[test]
    fn follow_through_is_counted_within_the_window_and_resolved_once() {
        let d = h("sw-ft1");
        let p = fire(&d, "t");
        append(&p, &[tool("Read", json!({})), result(), tool("Grep", json!({"pattern": "read_window"})), result(), say("Searched: no other occurrences. Done.")]);
        go(&d, &continuation(&d, &p, "Searched: no other occurrences. Done."));
        assert_eq!(results(&d, "followthrough", "outcome"), ["followed"]);
        assert_eq!(rows(&d).iter().find(|x| x["event"] == "followthrough").unwrap()["tool_calls"], 2);
        let d2 = h("sw-ft2");
        let p2 = fire(&d2, "t");
        append(&p2, &[tool("Bash", json!({"command": "cargo test"})), result(), say("All green.")]);
        go(&d2, &continuation(&d2, &p2, "All green."));
        assert_eq!(results(&d2, "followthrough", "outcome"), ["ignored"]);
        let d3 = h("sw-ft3");
        let p3 = fire(&d3, "t");
        let mut more: Vec<String> = Vec::new();
        for _ in 0..defaults::num("sibling_sweep.follow_window") {
            more.push(tool("Read", json!({})));
            more.push(result());
        }
        more.push(tool("Grep", json!({"pattern": "x"})));
        more.push(result());
        append(&p3, &more);
        go(&d3, &continuation(&d3, &p3, "ok"));
        assert_eq!(results(&d3, "followthrough", "outcome"), ["ignored"], "a search beyond the window does not count");
        let d4 = h("sw-ft4");
        let p4 = fire(&d4, "t");
        append(&p4, &[user("something else"), say("sure")]);
        go(&d4, &stop(&d4, &p4, "sure"));
        assert_eq!(results(&d4, "followthrough", "outcome"), ["unknown"]);
        go(&d4, &stop(&d4, &p4, "sure"));
        assert_eq!(results(&d4, "followthrough", "outcome").len(), 1, "a resolved reminder is not resolved twice");
    }

    #[test]
    fn the_telemetry_log_is_bounded_and_a_bad_state_file_reads_as_empty() {
        let d = h("sw-log");
        let path = format!("{d}/.anti-hall/{}", defaults::text("sibling_sweep.log"));
        std::fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
        std::fs::write(&path, "x".repeat(defaults::num("sibling_sweep.log_max_bytes") as usize + 1)).unwrap();
        let p = write(&d, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        assert!(is_adv(&go(&d, &stop(&d, &p, CAUSE))));
        assert!(std::fs::metadata(&path).unwrap().len() < 600, "the log is emptied once over its cap, then holds the new rows only");
        let d2 = h("sw-state");
        std::fs::write(format!("{d2}/.anti-hall/sibling-sweep-s1.json"), "{not json").unwrap();
        let p2 = write(&d2, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        assert!(is_adv(&go(&d2, &stop(&d2, &p2, CAUSE))), "an unreadable state is an empty one");
        let s: Value = serde_json::from_str(&std::fs::read_to_string(format!("{d2}/.anti-hall/sibling-sweep-s1.json")).unwrap()).unwrap();
        assert_eq!(s["fired"], 1);
        assert!(s["pending"]["cause"].is_string());
    }

    #[test]
    fn phrases_text_limits_and_a_bad_pattern_are_settings_file_edits() {
        let d = h("sw-cfg");
        let msg = "Zorp located: `site_a` loses the lock. Fixed.";
        let p = write(&d, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(msg)]);
        assert_eq!(go(&d, &stop(&d, &p, msg)), Verdict::Allow, "not a cause statement by the shipped phrases");
        configure(&d, json!({"cause_cues": ["\\bzorp located\\b"]}));
        assert!(is_adv(&go(&d, &stop(&d, &p, msg))), "the edited phrase list is read on the next call");
        let old = "Root cause: `site_b` loses the lock, so it fails. Fixed.";
        let p2 = write(&d, "u.jsonl", &[user("fix again"), tool("Edit", json!({})), result(), say(old)]);
        assert_eq!(go(&d, &stop(&d, &p2, old)), Verdict::Allow, "the shipped phrases are replaced by the file's list");
        let d2 = h("sw-cfg2");
        configure(&d2, json!({"msg_instead": "grep the tree for the twin of this bug and report the hit count", "max_per_scope": 1, "follow_window": 1}));
        let p3 = write(&d2, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        let Verdict::Advisory(j) = go(&d2, &stop(&d2, &p3, CAUSE)) else { panic!("expected a reminder") };
        assert!(j.contains("grep the tree for the twin of this bug"), "{j}");
        append(&p3, &[tool("Read", json!({})), result(), tool("Grep", json!({"pattern": "x"})), result(), say("done")]);
        go(&d2, &continuation(&d2, &p3, "done"));
        assert_eq!(results(&d2, "followthrough", "outcome"), ["ignored"]);
        let other = "Root cause: `site_z` drops the guard, so it fails. Fixed.";
        let p4 = write(&d2, "u.jsonl", &[user("again"), tool("Edit", json!({})), result(), say(other)]);
        assert_eq!(go(&d2, &stop(&d2, &p4, other)), Verdict::Allow);
        assert_eq!(results(&d2, "cause", "result").last().map(String::as_str), Some("capped"));
        let d3 = h("sw-cfg3");
        configure(&d3, json!({"hedge_any_re": "(unclosed", "cause_cues": ["(also unclosed"]}));
        let p5 = write(&d3, "t.jsonl", &[user("fix"), tool("Edit", json!({})), result(), say(CAUSE)]);
        assert!(is_adv(&go(&d3, &stop(&d3, &p5, CAUSE))), "the shipped patterns keep the check working");
    }

    #[test]
    fn the_matcher_keeps_its_precision_and_recall_over_the_message_corpus() {
        let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/sibling-sweep-corpus.ndjson")).expect("the corpus file is readable");
        let d = h("sw-corpus");
        let (mut n, mut wrong) = (0, Vec::new());
        for l in text.lines() {
            let v: Value = serde_json::from_str(l).unwrap();
            let (msg, expect) = (v["msg"].as_str().unwrap(), v["cause"].as_bool().unwrap());
            // a fresh scope per message so the once-per-cause memory never hides a verdict
            let p = write(&d, "t.jsonl", &[user("fix the crash"), tool("Edit", json!({})), result(), say(msg)]);
            let mut payload = stop(&d, &p, msg);
            payload["session_id"] = json!(format!("c{n}"));
            n += 1;
            if is_adv(&go(&d, &payload)) != expect {
                wrong.push(msg.to_string());
            }
        }
        assert!(n >= 60, "the corpus must hold at least 60 messages");
        assert!(wrong.is_empty(), "misjudged: {wrong:#?}");
    }
}

#[test]
fn compact_declaration_guard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("compact-declaration-guard");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("defer").copied().unwrap_or(0) > 50, "both answers: {kinds:?}");
}

#[test]
fn devswarm_parent_inbox_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("devswarm-parent-inbox");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("defer").copied().unwrap_or(0) > 50, "both answers: {kinds:?}");
}

#[test]
fn devswarm_child_turn_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("devswarm-child-turn");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("defer").copied().unwrap_or(0) > 50, "both answers: {kinds:?}");
}

// ---- task-lifecycle-log, the session gates, merge-side-pick, scan-throttle and merge-gate (D88 batch 6) ----

#[test]
fn task_lifecycle_log_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("task-lifecycle-log");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 40 && kinds.get("defer").copied().unwrap_or(0) >= 1, "both answers: {kinds:?}");
}

#[test]
fn jev_weekly_scorecard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("jev-weekly-scorecard");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 40 && kinds.get("defer").copied().unwrap_or(0) >= 3, "both answers: {kinds:?}");
}

#[test]
fn jev_review_reminder_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("jev-review-reminder");
    for k in ["advisory", "allow", "defer"] {
        assert!(kinds.get(k).copied().unwrap_or(0) >= 10, "a corpus that exercises {k}: {kinds:?}");
    }
}

#[test]
fn repair_on_reload_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("repair-on-reload");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 10 && kinds.get("defer").copied().unwrap_or(0) > 10, "both answers: {kinds:?}");
}

#[test]
fn merge_side_pick_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("merge-side-pick");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("advisory").copied().unwrap_or(0) > 50 && kinds.get("defer").copied().unwrap_or(0) > 20, "every answer: {kinds:?}");
}

/// The platform's throttle prefix (macOS `taskpolicy ...`, Linux `nice ...`) stands as `{PREFIX}` in the corpus, so one corpus
/// serves both CI systems.
fn prefix_neutral(v: &mut Value) {
    if let Some(t) = v.get("text").and_then(Value::as_str) {
        let t = t.replace("taskpolicy -c utility nice -n 19", "{PREFIX}").replace("ionice -c 3 nice -n 19", "{PREFIX}").replace("nice -n 19", "{PREFIX}");
        v["text"] = json!(t);
    }
}

#[test]
fn scan_throttle_script_matches_the_compiled_port() {
    if !(cfg!(target_os = "macos") || cfg!(target_os = "linux")) {
        return;
    }
    let mut kinds = std::collections::BTreeMap::new();
    for c in golden::load("scan-throttle") {
        let l = golden::lay(&c);
        let got = super::run_forced("scan-throttle", &l.payload, &l.opts, &l.event, &l.env).expect("a shipped script");
        let mut got = golden::verdict_json(&got, &l);
        prefix_neutral(&mut got);
        assert_eq!(got, c["expect"], "scan-throttle: script differs from the compiled port on case {}: {} ({:?})", c["n"], c["payload"], crate::discard::captured());
        *kinds.entry(got["v"].as_str().unwrap_or("").to_string()).or_insert(0usize) += 1;
        crate::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
    }
    assert!(kinds["advisory"] > 50 && kinds["allow"] > 100 && kinds["defer"] > 100, "every answer: {kinds:?}");
}

#[test]
fn merge_gate_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("merge-gate");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("exact").copied().unwrap_or(0) > 50 && kinds.get("defer").copied().unwrap_or(0) > 10, "every answer: {kinds:?}");
}
// ---- output-verify-guard: the Jev shadow question (ported from the compiled check's unit tests) ----

mod output_verify_jev {
    use super::*;
    use crate::jev::testkit::{install_scripted, log_rows, ok};

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];

    fn env_with(h: &str, extra: &[(&str, &str)]) -> RequestEnv {
        let mut pairs = vec![("HOME".to_string(), h.to_string())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        RequestEnv::from_pairs(pairs)
    }

    fn payload(out: &str) -> Value {
        json!({"tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"stdout":out},"session_id":"sv"})
    }

    #[test]
    fn a_test_runner_output_is_asked_with_the_regex_verdict_as_baseline_and_the_advisory_is_unchanged() {
        let h = home("ov-jev-on");
        let (jev, fake) = install_scripted(std::path::Path::new(&h), &ON, vec![ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]);
        let v = super::super::run_forced("output-verify-guard", &payload("Tests: 3 passed, 2 failed"), &Value::Null, "PostToolUse", &env_with(&h, &ON));
        assert!(matches!(v, Some(Some(Verdict::Exact(_)))), "the advisory is still emitted: {v:?}");
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        let seen = fake.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let body: Value = serde_json::from_str(seen[0].2.as_ref().unwrap()).unwrap();
        assert!(body["state"].as_str().unwrap().contains("3 passed"));
        let rows = log_rows(std::path::Path::new(&h));
        assert_eq!(
            (rows.len(), &rows[0]["id"], &rows[0]["base"], &rows[0]["mode"], &rows[0]["sessionId"]),
            (1, &json!("outputVerifyGuard"), &json!(true), &json!("shadow"), &json!("sv"))
        );
    }

    #[test]
    fn an_off_integration_logs_the_off_row_and_a_clean_run_is_asked_with_baseline_false() {
        let h = home("ov-jev-off");
        let off = [("ANTIHALL_JEV", "0")];
        let (jev, fake) = install_scripted(std::path::Path::new(&h), &off, vec![]);
        let v = super::super::run_forced("output-verify-guard", &payload("Tests: 5 passed"), &Value::Null, "PostToolUse", &env_with(&h, &off));
        assert_eq!(v, Some(Some(Verdict::Allow)));
        assert!(jev.drain(std::time::Duration::from_secs(5)));
        assert!(fake.seen.lock().unwrap().is_empty());
        let rows = log_rows(std::path::Path::new(&h));
        assert_eq!((rows.len(), &rows[0]["mode"], &rows[0]["base"]), (1, &json!("off"), &json!(false)));
    }
}
