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

/// DECISIONS.md 1.111: every check of a worker thread shares ONE context, so a check's top-level declarations (its entry and helpers) must
/// stay private to it, a lib file is evaluated once per thread (not once per check), and a lib edit rebuilds the context.
#[test]
fn checks_share_one_context_but_not_their_declarations() {
    let h = home("shared");
    let e = env(&h);
    let lib = format!("{h}/.anti-hall/logic/{}", defaults::text("script.lib_dir"));
    std::fs::create_dir_all(&lib).unwrap();
    std::fs::write(format!("{lib}/zz-count.js"), "var zzLoads = (typeof zzLoads === 'number' ? zzLoads : 0) + 1;").unwrap();
    put_override(&h, "zz-a", "var helper = 'a'; function decide() { return {block: helper + zzLoads}; }");
    put_override(&h, "zz-b", "function decide() { return {block: (typeof helper) + zzLoads}; }");
    put_override(&h, "zz-none", "function notTheEntry() { return 'allow'; }");
    std::thread::spawn(move || {
        assert_eq!(run_forced("zz-a", &json!({}), &e), Some(Some(Verdict::Block("a1".into()))));
        assert_eq!(run_forced("zz-b", &json!({}), &e), Some(Some(Verdict::Block("undefined1".into()))), "zz-a's helper leaked");
        assert_eq!(run_forced("zz-a", &json!({}), &e), Some(Some(Verdict::Block("a1".into()))), "zz-b replaced zz-a's entry");
        assert_eq!(run_forced("zz-none", &json!({}), &e), Some(Some(Verdict::Allow)), "no entry: a failure, the failure policy decides (open)");
        assert_eq!(super::pool_usage().map(|u| u.0), Some(2), "two checks loaded");
        // a lib edit rebuilds the shared context: the counter starts over
        std::fs::write(format!("{lib}/zz-count.js"), "var zzLoads = 10;").unwrap();
        let f = std::fs::File::options().write(true).open(format!("{lib}/zz-count.js")).unwrap();
        f.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5)).unwrap();
        // Library fingerprints are cached between calls; an edit is visible after that interval.
        std::thread::sleep(std::time::Duration::from_millis(defaults::num("script.fingerprint_ttl_ms") + 1));
        assert_eq!(run_forced("zz-b", &json!({}), &e), Some(Some(Verdict::Block("undefined10".into()))));
        assert_eq!(super::pool_usage().map(|u| u.0), Some(1), "the rebuilt context holds only what was loaded since");
    })
    .join()
    .expect("assertions hold");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// Memory budget (DECISIONS.md 1.111; the soft limit of issue #21): one worker thread that has run EVERY shipped check script holds at most
/// `script.heap_budget_base_bytes` + `script.heap_budget_per_check_bytes` per script in its interpreter. A context per check
/// (about 150 KB each before any check code, 3.3 MB for the 16 scripts of 2026-10-09) fails this; the shared context
/// (1.0 MB) passes, and the budget grows with the number of scripted checks, not with the calls.
#[test]
fn one_thread_running_every_shipped_script_stays_within_the_interpreter_budget() {
    let h = home("budget");
    let ext = defaults::text("script.ext"); // the root is known once the defaults are loaded
    let dir = defaults::root().expect("plugin root").join(defaults::text("script.logic_dir"));
    let names: Vec<String> =
        std::fs::read_dir(&dir).unwrap().flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(ext).map(str::to_string)).collect();
    assert!(names.len() > 1, "{names:?}");
    let n = names.len();
    let used = std::thread::spawn(move || {
        let e = env(&h);
        for name in &names {
            for _ in 0..3 {
                assert!(super::run_forced(name, &json!({"hook_event_name": "Notification", "cwd": h}), &Value::Null, "Notification", &e).is_some(), "{name}");
            }
        }
        crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
        super::pool_usage().expect("the thread ran scripts")
    })
    .join()
    .expect("the scripts ran");
    assert!(used.0 <= n && used.0 > 0, "at most every script is loaded into the shared context at once ({} of {n})", used.0);
    let budget = defaults::num("script.heap_budget_base_bytes") + defaults::num("script.heap_budget_per_check_bytes") * n as u64;
    assert!(used.1 as u64 <= budget, "{n} scripts hold {} bytes in one thread's interpreter, over the budget of {budget}", used.1);
}

#[test]
fn a_runaway_script_is_interrupted_and_defers() {
    let h = home("loop");
    let e = env(&h);
    put_override(&h, "zz-loop", "function decide() { for (;;) {} }");
    let t = Instant::now();
    assert_eq!(run_forced("zz-loop", &json!({}), &e), Some(Some(Verdict::Allow)));
    assert!(
        t.elapsed() < std::time::Duration::from_millis(defaults::num("script.time_limit_ms") * defaults::num("script.time_hard_factor") * 3),
        "{:?}",
        t.elapsed()
    );
    // a catastrophic native regex is interrupted too
    put_override(&h, "zz-redos", "function decide() { return /^(a+)+$/.test('a'.repeat(40) + 'b') ? 'allow' : 'defer'; }");
    let t = Instant::now();
    assert_eq!(run_forced("zz-redos", &json!({}), &e), Some(Some(Verdict::Allow)));
    assert!(
        t.elapsed() < std::time::Duration::from_millis(defaults::num("script.time_limit_ms") * defaults::num("script.time_hard_factor") * 3),
        "{:?}",
        t.elapsed()
    );
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
    assert_eq!(run_forced("zz-oom", &json!({}), &e), Some(Some(Verdict::Allow)));
    put_override(&h, "zz-deep", "function f(n) { return f(n + 1) + 1; } function decide() { return f(0); }");
    assert_eq!(run_forced("zz-deep", &json!({}), &e), Some(Some(Verdict::Allow)));
    put_override(&h, "zz-shape", "function decide() { return 42; }");
    assert_eq!(run_forced("zz-shape", &json!({}), &e), Some(Some(Verdict::Allow)));
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
            assert_eq!(
                run_forced("zz-cycle", &json!({}), &e),
                Some(Some(Verdict::Defer)),
                "an explicit defer is the script's own answer (the dispatcher resolves it)"
            );
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
    assert_eq!(run_forced("zz-escape", &json!({}), &e), Some(Some(Verdict::Allow)), "the refusal is a script failure: the failure policy decides (open)");
    assert!(!std::path::Path::new(&format!("{h}/escaped")).exists());
    assert_eq!(run_forced("zz-write", &json!({}), &e), Some(Some(Verdict::Allow)));
    assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/zz/ok.txt")).unwrap(), "hello");
}

// ---- the script-failure policy (D88 condition b) ----

/// Load: a call still running when its request's client stops waiting is cut there and defers to its own Node hook. It is not a
/// script failure (no error is counted, and an engine-only advisory defers instead of taking its failure verdict, allow).
#[test]
fn a_call_past_its_request_deadline_is_cut_and_defers_without_counting_an_error() {
    let h = home("cut");
    put_override(&h, "sibling-sweep", "function decide(p){ for(;;){} }");
    let e = env(&h);
    let go = || super::run_forced("sibling-sweep", &json!({}), &Value::Null, "Stop", &e);
    crate::deadline::begin(Instant::now());
    crate::deadline::client_deadline(0); // the client no longer waits
    crate::telemetry::emit::take_queued();
    let t = Instant::now();
    let v = go();
    let took = t.elapsed();
    let evs = crate::telemetry::emit::take_queued();
    crate::deadline::end();
    assert_eq!(v, Some(Some(Verdict::Defer)), "cut at the client's deadline: its Node hook answers");
    assert!(evs.is_empty(), "a cut is not a script error: {evs:?}");
    assert!(took < std::time::Duration::from_millis(defaults::num("script.time_limit_ms") * defaults::num("script.wall_limit_factor")), "{took:?}");
    // outside a request the same call runs to its own limit and takes the failure policy (this advisory allows)
    assert_eq!(go(), Some(Some(Verdict::Allow)));
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// The verdict body of `v` when it is the guard-down notice (an advisory), else the verdict itself.
fn without_notice(v: Verdict) -> Verdict {
    match v {
        Verdict::Advisory(j) if j.contains("systemMessage") => Verdict::Allow,
        other => other,
    }
}

#[test]
fn no_check_defers_to_a_node_hook_when_its_script_fails_on_any_event() {
    for event in ["PreToolUse", "Stop", "SessionStart", "UserPromptSubmit", "PostToolUse"] {
        for name in ["ship-it-guard", "devswarm-parent-gate", "devswarm-child-role"] {
            assert_ne!(failed(name, event, "boom"), Verdict::Defer, "{name} on {event}");
            assert_ne!(super::unanswered(name, event), Verdict::Defer, "{name} on {event}");
        }
    }
}

#[test]
fn the_stop_guard_and_the_session_start_role_fail_open_when_their_script_fails() {
    for (name, event) in [("devswarm-parent-gate", "Stop"), ("devswarm-child-role", "SessionStart")] {
        assert_eq!(super::failure_mode(name), "open", "{name}");
        assert_eq!(without_notice(failed(name, event, "boom")), Verdict::Allow, "{name} on {event}: a failed script must not block the agent");
        assert_eq!(without_notice(super::unanswered(name, event)), Verdict::Allow, "{name} on {event}: no answer must not block the agent");
    }
}

#[test]
fn every_registered_check_is_classified_in_the_engine_only_list() {
    let listed = defaults::list("script.engine_only_checks");
    for c in crate::checks::registry() {
        assert!(listed.contains(&c.name()), "{} is a registered check but is not in script.engine_only_checks", c.name());
    }
    for name in &listed {
        assert!(crate::checks::get(name).is_some(), "{name} is listed but is not a registered check");
    }
}

#[test]
fn a_failed_open_check_tells_the_user_once_per_session_and_check() {
    super::set_session("notice-session-a");
    let first = failed("sibling-sweep", "SubagentStop", "boom");
    assert!(matches!(&first, Verdict::Advisory(j) if j.contains("sibling-sweep") && j.contains("boom") && j.contains("systemMessage")), "{first:?}");
    assert_eq!(failed("sibling-sweep", "SubagentStop", "boom"), Verdict::Allow, "the same session and check is told once");
    assert!(matches!(failed("handover-hygiene", "SubagentStop", "boom"), Verdict::Advisory(_)), "another check in the session is told");
    super::set_session("notice-session-b");
    assert!(matches!(failed("sibling-sweep", "SubagentStop", "boom"), Verdict::Advisory(_)), "another session is told");
}

#[test]
fn an_advisory_engine_only_check_never_blocks_when_its_script_fails() {
    let engine_only = defaults::list("script.engine_only_checks");
    assert!(engine_only.contains(&"sibling-sweep"));
    for name in &engine_only {
        if super::failure_mode(name) == defaults::text("script.failure_mode_closed") {
            continue; // a security guard (script.failure_mode_by_check): the matrix test below
        }
        for event in
            defaults::list("dispatch.guard_events").into_iter().chain(["SessionStart", "UserPromptSubmit", "PostToolUse", "SubagentStart", "PreCompact"])
        {
            assert_eq!(without_notice(failed(name, event, "boom")), Verdict::Allow, "{name} on {event}: a check's own failure never blocks");
        }
    }
    // a failure is counted: one telemetry check event with outcome error per failure
    crate::telemetry::emit::take_queued();
    failed("sibling-sweep", "SubagentStop", "boom");
    let evs = crate::telemetry::emit::take_queued();
    assert_eq!(evs.len(), 1, "one counter event");
    assert_eq!(evs[0].o, crate::telemetry::event::Outcome::Error);
}

#[test]
fn only_pre_tool_use_guards_fail_closed_and_a_stop_or_session_start_check_never_does() {
    let closed: Vec<&str> = defaults::list("script.engine_only_checks").into_iter().filter(|n| super::failure_mode(n) == "closed").collect();
    assert!(closed.contains(&"git") && closed.contains(&"ship-it-guard"), "{closed:?}");
    for host in crate::dispatch::table::hosts() {
        for event in crate::dispatch::table::events(host) {
            for e in crate::dispatch::table::entries(host, event) {
                let check = e.check.as_deref().unwrap_or_default();
                if closed.contains(&check) {
                    assert!(["PreToolUse", "PermissionRequest"].contains(&event), "{check} fails closed but is registered on {event}");
                }
            }
        }
    }
    for event in defaults::list("dispatch.guard_events") {
        assert!(matches!(failed("git", event, "boom"), Verdict::Block(m) if m.contains("boom")), "{event}");
    }
    assert_eq!(without_notice(failed("git", "SessionStart", "boom")), Verdict::Allow, "never block a non-guard event");
}

#[test]
fn a_fail_closed_check_blocks_on_a_guard_event_only() {
    let closed = defaults::text("script.failure_mode_closed");
    for event in defaults::list("dispatch.guard_events") {
        assert!(matches!(super::failure_verdict("g", event, "boom", closed), Verdict::Block(m) if m.contains("boom") && m.contains('g')), "{event}");
        assert_eq!(super::failure_verdict("g", event, "boom", "open"), Verdict::Allow, "{event}");
    }
    for event in ["SessionStart", "UserPromptSubmit", "PostToolUse"] {
        assert_eq!(super::failure_verdict("g", event, "boom", closed), Verdict::Allow, "{event}: never block a non-guard event");
    }
    assert_eq!(super::failure_mode("no-such-check"), defaults::text("script.failure_mode_default"));
}

#[test]
fn the_policy_applies_to_every_kind_of_script_failure() {
    let h = home("policy");
    put_override(&h, "sibling-sweep", "function decide(p){ throw new Error('bad'); }");
    let e = env(&h);
    let go = |event: &str| super::run_forced("sibling-sweep", &json!({}), &Value::Null, event, &e).expect("a script").expect("an answer");
    assert_eq!(go("Stop"), Verdict::Allow, "an exception on a guard event: the advisory fails open");
    assert_eq!(go("SessionStart"), Verdict::Allow, "an exception on a non-guard event");
    put_override(&h, "sibling-sweep", "function decide(p){ for(;;){} }");
    assert_eq!(go("SubagentStop"), Verdict::Allow, "an interrupted loop (the CPU-time limit) on a guard event");
    assert_eq!(go("PostToolUse"), Verdict::Allow);
    put_override(&h, "sibling-sweep", "function decide(p){ return 42; }");
    assert_eq!(go("PreToolUse"), Verdict::Allow, "a verdict of the wrong shape");
    put_override(&h, "sibling-sweep", "this is not javascript (");
    assert_eq!(go("Stop"), Verdict::Allow, "a script that does not load");
    // a registered scripted check with no script file at all follows the same policy
    assert!(matches!(crate::script::missing("ship-it-guard", "PreToolUse"), Some(Verdict::Block(_))), "a blocking guard without its script fails closed");
    assert_eq!(crate::script::missing("sibling-sweep", "Stop"), Some(Verdict::Allow));
    assert_eq!(crate::script::missing("sibling-sweep", "SessionStart"), Some(Verdict::Allow));
}

#[test]
fn api_guard_rechecks_a_module_after_a_package_is_installed() {
    use std::os::unix::fs::PermissionsExt;
    let h = home("agpkg");
    let bin = format!("{h}/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let marker = format!("{h}/installed");
    let body = format!("#!/bin/sh\ncase \"$1\" in --version|-V) echo 'Python 3.12.1';; *) if [ -e {marker} ]; then echo '[0]'; else echo '[2]'; fi;; esac\n");
    std::fs::write(format!("{bin}/python3"), body).unwrap();
    std::fs::set_permissions(format!("{bin}/python3"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let e = RequestEnv::from_pairs([("HOME", h.as_str()), ("PATH", bin.as_str()), ("ANTIHALL_API_GUARD_THIRDPARTY", "1")]);
    let p = json!({"tool_name": "Write", "tool_input": {"file_path": "x.py", "content": "import fakepkg\nfakepkg.no_such_fn()\n"}});
    let go = || run_forced("api-guard", &p, &e).expect("a script").expect("an answer");
    assert_eq!(go(), Verdict::Allow, "an absent package is not a fake attribute");
    std::fs::write(&marker, "").unwrap();
    assert_ne!(go(), Verdict::Allow, "the same call after the package is installed is checked again, not served from a kept allow");
}

/// Codex final N2: the verdict is verified before the optional version text is fetched, so a slow cold version probe can never
/// starve the verification (it used to run first, eat the request's remaining time, and turn a deny into an unchecked allow).
#[test]
fn api_guard_verifies_before_the_version_probe_and_the_deny_survives_a_tight_budget() {
    use std::os::unix::fs::PermissionsExt;
    let h = home("agorder");
    let bin = format!("{h}/bin");
    std::fs::create_dir_all(&bin).unwrap();
    let log = format!("{h}/calls");
    // verification answers at once; the (cold) version probe takes far longer than the whole request window
    let body = format!(
        "#!/bin/sh\ncase \"$1\" in --version|-V) echo version >>{log}; sleep 3; echo v22.0.0;; *) echo verify >>{log}; echo '{{\"req\":{{\"fs\":[0]}},\"glob\":[]}}';; esac\n"
    );
    std::fs::write(format!("{bin}/node"), body).unwrap();
    std::fs::set_permissions(format!("{bin}/node"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let e = RequestEnv::from_pairs([("HOME", h.as_str()), ("PATH", bin.as_str())]);
    let p = json!({"tool_name": "Write", "tool_input": {"file_path": "x.js", "content": "require('fs').definitelyFake();\n"}});
    // the defaults and the script are loaded before the window opens, so the window is spent on the probes alone
    assert_eq!(run_forced("api-guard", &json!({"tool_name": "Bash"}), &e), Some(Some(Verdict::Allow)));
    crate::deadline::begin(Instant::now());
    crate::deadline::client_deadline(defaults::num("daemon.reply_slack_ms") + 1200);
    let v = run_forced("api-guard", &p, &e);
    crate::deadline::end();
    let calls = std::fs::read_to_string(&log).unwrap_or_default();
    assert_eq!(calls.lines().next(), Some("verify"), "verification runs first: {calls:?}");
    let Some(Some(Verdict::Exact(x))) = v else { panic!("a verdict: {v:?}") };
    assert_eq!(x.code, 2, "the deny survives a version probe that cannot finish in budget: {x:?}");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

// ---- golden parity of the migrated checks ----

#[test]
fn api_guard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("api-guard");
    // the corpus pins no interpreter (PATH names none), so every case answers without a probe and none defers (lane L07); the
    // probes themselves are compared with Node by the node_parity api-guard harness
    assert!(kinds.get("allow").copied().unwrap_or(0) > 50 && !kinds.contains_key("defer"), "a corpus that answers every case: {kinds:?}");
}

#[test]
fn orch_on_spawn_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("orch-on-spawn");
    // every case is answered here (the Node fallback is gone, #248): a pending marker wins the claim and sends the rules
    assert!(
        kinds.get("allow").copied().unwrap_or(0) > 20 && kinds.get("advisory").copied().unwrap_or(0) > 20 && !kinds.contains_key("defer"),
        "allow and advisory, no deferral: {kinds:?}"
    );
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
    for k in ["allow", "exact"] {
        assert!(kinds.get(k).copied().unwrap_or(0) > 20, "a corpus that exercises {k}: {kinds:?}");
    }
    assert!(!kinds.contains_key("defer"), "no deferral: {kinds:?}");
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
    // A config over the interpreter's read cap is never read truncated: the check decides natively, as Node does with the whole file
    // (nothing about Fable in it), so the state is written with `available: null` and the check stays silent (the Node fallback is gone, #248).
    let h = write_home("fa-big");
    let cap = defaults::num("script.read_max_bytes") as usize;
    std::fs::write(format!("{h}/.claude.json"), format!("{{\"pad\":\"{}\"}}", "x".repeat(cap))).unwrap();
    assert_eq!(run_forced("fable-availability", &json!({}), &env(&h)), Some(Some(Verdict::Allow)));
    let state = std::fs::read_to_string(format!("{h}/.anti-hall/fable-availability.json")).unwrap();
    assert!(state.starts_with("{\"available\":null,\"checkedAt\":") && state.ends_with(",\"source\":\"unknown\"}"), "{state}");
}

#[test]
fn ship_it_guard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("ship-it-guard");
    for k in ["allow", "block", "advisory"] {
        assert!(kinds.get(k).copied().unwrap_or(0) > 5, "a corpus that exercises {k}: {kinds:?}");
    }
    assert!(!kinds.contains_key("defer"), "no deferral: {kinds:?}");
}

/// Every case of a golden corpus through the script; mismatches are listed (up to `limit`) before the test fails.
pub(super) fn golden_report(check: &str, limit: usize) {
    golden::regen_defers_local(check);
    let cases = golden::load(check);
    let limit = if std::env::var("AH_GOLDEN_ALL").is_ok() { usize::MAX } else { limit };
    let (mut bad, mut shown) = (0usize, 0usize);
    for c in &cases {
        let l = golden::lay(c);
        if check == "task-tracker" {
            // The corpus was recorded on a 16-core machine, where the dispatch cap (cores - 2) is 14; the script reads the real core
            // count, so a smaller runner wrote "cap 3". Pinning the setting to the recorded value makes the answer machine-independent.
            let dir = format!("{}/.anti-hall", l.home);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(format!("{dir}/settings.json"), r#"{"guards":{"maxParallelDispatch":14}}"#).unwrap();
        }
        let got = golden::run_case(check, &l, golden::repeat_of(c)).unwrap_or_else(|| panic!("{check}: no shipped script"));
        let got = golden::verdict_json(&got, &l);
        // a frozen "defer" (the script could not answer; Node was to decide) is now decided by the check's failure policy: an allow, or a block for a fail-closed guard
        let policy = c["expect"] == json!({"v": "defer"}) && (got == json!({"v": "allow"}) || got["v"] == "block");
        let expect = golden::intended(&c["expect"]);
        let mut ok = golden::intended(&got) == expect || policy;
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
                eprintln!(
                    "MISMATCH {check} n={}\n  payload={p}\n  expect={}\n  got   ={}\n  errors={:?}",
                    c["n"],
                    c["expect"].to_string().chars().take(4000).collect::<String>(),
                    got.to_string().chars().take(4000).collect::<String>(),
                    crate::discard::captured()
                );
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

/// broad-kill-guard is engine-only (issue #38): its corpus is hand-judged, every case's verdict was checked against the decision
/// table in tests/it/broad_kill.rs, then recorded here with the exact block text for both hosts and every caller.
#[test]
fn broad_kill_guard_script_matches_its_golden_corpus() {
    golden_report("broad-kill-guard", 12);
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

// The command corpus was frozen from the compiled port before it was removed; the three cases of non-ASCII or non-blank-ASCII
// white space the port deferred are now answered as Node answers them (parity/run-golden.js replays the whole corpus against
// hooks/command-guard.js).
#[test]
fn command_script_matches_the_compiled_port() {
    golden_report("command", 12);
}

// `command.max_classify_len`: Node judges a longer command in parts (a head/tail scan). The script decides it natively the same way
// (the Node fallback is gone, #248): the edit gate scans the head and tail, and a big heredoc write or a big heavy command is blocked
// where Node blocks it, without parsing the whole command (about 4.5 us of interpreter time per character in release).
#[test]
fn a_command_over_the_classify_cap_is_blocked_within_the_runtime_budget() {
    let h = home("cmd-cap");
    // a main-thread session of a DevSwarm checkout: the context in which Node's edit and heavy-command gates block
    let e = RequestEnv::from_pairs([
        ("HOME", h.as_str()),
        ("CLAUDE_CODE_ENTRYPOINT", "cli"),
        ("DEVSWARM_REPO_ID", "r1"),
        ("DEVSWARM_SOURCE_BRANCH", "feat"),
        ("ANTIHALL_INGEST_DRY_RUN", "1"),
    ]);
    let proj = format!("{h}/proj");
    std::fs::create_dir_all(format!("{proj}/.git/refs/heads")).unwrap();
    std::fs::create_dir_all(format!("{proj}/src")).unwrap();
    std::fs::write(format!("{proj}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let body = "b".repeat(defaults::num("command.max_classify_len") as usize);
    let bash = |command: String| json!({"tool_name": "Bash", "session_id": "s", "cwd": proj, "tool_input": {"command": command}});
    // the runtime and the script are loaded by a small call first, so the measured calls count only their own work
    assert!(run_forced("command", &bash("ls".into()), &e).is_some());
    for (what, p) in [("heredoc write", bash(format!("cat > {proj}/src/x.rs <<'EOF'\n{body}\nEOF"))), ("heavy", bash(format!("echo {body} && npm test")))] {
        let cpu = crate::limits::thread_cpu_us();
        // Node (command-guard.js, same payload and environment) blocks both with exit 2; the script decides them natively, the same way
        match run_forced("command", &p, &e) {
            Some(Some(Verdict::Exact(x))) => assert_eq!(x.code, 2, "{what}: a command over the cap is blocked as Node blocks it"),
            other => panic!("{what}: a command over the cap is blocked as Node blocks it, got {other:?}"),
        }
        let used_ms = crate::limits::thread_cpu_us().saturating_sub(cpu) / 1000;
        assert!(
            used_ms < super::limit_ms("command", "PreToolUse") * defaults::num("script.time_hard_factor"),
            "{what}: exceeded the command script's configured hard CPU budget ({used_ms} ms CPU)"
        );
    }
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// The git guard asks for the same segments again and again (aliases, backstops, runners, shell definitions); the tokenizer and the
/// segment splitter are kept per call, so a repeated question is not a second scan. `interpreter_polls` counts the interpreter's
/// work on a fixed scale (a clock would make the test depend on the load of the machine).
#[test]
fn the_git_guard_scans_each_segment_once_per_call() {
    let h = home("gitmemo");
    let e = env(&h);
    let proj = format!("{h}/proj");
    std::fs::create_dir_all(format!("{proj}/.git/refs/heads")).unwrap();
    std::fs::write(format!("{proj}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
    let cmds = [
        "cd src/mod && grep -nE 'alpha|beta' notes.txt | head -20; ls -la | wc -l && echo done",
        "git status --short && git log --oneline -5 && git diff --stat HEAD~1 | tail -3",
        "for f in a b c; do echo $f | sed 's/a/b/' >> out.txt; done; cat out.txt | sort | uniq -c | sort -rn | head",
        "python3 -c \"import json; print(json.dumps({'a': 1}))\" && node -e \"console.log(process.version)\" && true",
    ];
    let polls = std::thread::spawn(move || {
        let run = |c: &str| run_forced("git", &json!({"tool_name": "Bash", "session_id": "s", "cwd": proj, "tool_input": {"command": c}}), &e);
        for c in cmds {
            assert_eq!(run(c), Some(Some(Verdict::Allow)), "{c}");
        }
        let before = super::interpreter_polls();
        for _ in 0..30 {
            for c in cmds {
                assert_eq!(run(c), Some(Some(Verdict::Allow)));
            }
        }
        super::interpreter_polls() - before
    })
    .join()
    .expect("the runs hold");
    // measured on these 120 runs: 183 polls when every question is scanned again, 103 with the per-call memo
    assert!(polls < 140, "the guard scanned the same segments again: {polls} interpreter polls for 120 runs (103 with the memo, 183 without)");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

// The coordinator-work-guard corpus was written from the script and replayed against hooks/coordinator-work-guard.js (the PreToolUse
// cases; the PostToolUse ones are compared by the coordinator_post parity lane, which runs both hooks through whole sessions).
#[test]
fn coordinator_work_guard_script_matches_its_golden_corpus() {
    golden_report("coordinator-work-guard", 12);
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
        // Owner edits are discovered on the configured fingerprint cadence.
        std::thread::sleep(std::time::Duration::from_millis(defaults::num("script.fingerprint_ttl_ms") + 1));
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
        assert!(text_of(&v).contains("spawn limit reached (20 in 60s, cap 20)."), "{v:?}");
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

    /// GH #484: each spawn denied over `guards.maxConcurrentAgents` bumps `spawns_denied_over_cap`; an allowed spawn does not.
    #[test]
    fn a_spawn_denied_over_the_cap_is_counted_and_an_allowed_one_is_not() {
        let _excl = super::claim_evidence_guard::COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let count = || {
            let mut m = crate::metrics::Metrics::default();
            crate::metrics::drain_pending(&mut m);
            m.counter("spawns_denied_over_cap", &[])
        };
        let h = swarm_home("sw-cap484");
        let running = |n: usize| {
            let mut out = String::new();
            for i in 0..n {
                let (tu, id) = (format!("toolu_{i}"), format!("a{i:015x}"));
                let call = json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tu, "name": "Agent", "input": {"description": format!("lane {i}"), "subagent_type": "Explore"}}]}});
                let res = json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tu,
                    "content": format!("Async agent launched successfully.\nagentId: {id} (internal ID - do not mention to user)\noutput_file: /tmp/x/{id}.output")}]}});
                out.push_str(&format!("{call}\n{res}\n"));
            }
            std::fs::write(format!("{h}/t.jsonl"), out).unwrap();
        };
        let p = json!({"tool_name": "Agent", "tool_input": {"subagent_type": "Explore", "prompt": "x"}, "session_id": "s", "transcript_path": format!("{h}/t.jsonl"), "cwd": h});
        running(5);
        crate::metrics::drain_pending(&mut crate::metrics::Metrics::default());
        assert_eq!(call(&h, &p, T0, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)), "5 running is under the cap of 6");
        assert_eq!(count(), 0, "an allowed spawn is not a denial");
        running(6);
        let v = call(&h, &p, T0 + 1, Some(8.0 * GB), 16.0 * GB);
        assert!(matches!(&v, Some(Some(Verdict::Exact(x))) if x.code == 2), "{v:?}");
        assert_eq!(count(), 1, "the denial is counted once");
    }

    #[test]
    fn a_write_capable_spawn_beside_a_running_writer_gets_the_advisory_and_is_recorded() {
        let h = swarm_home("sw-adv");
        let t = transcript(&h, json!({"subagent_type": "general-purpose", "prompt": "fix it"}));
        let writer = json!({"tool_name": "Agent", "tool_input": {"subagent_type": "general-purpose"}, "transcript_path": t, "cwd": h});
        let a = advisory(call(&h, &writer, T0, Some(8.0 * GB), 16.0 * GB)).expect("advisory");
        assert!(a.contains("shared tree: another agent is already writing in this working tree.") && a.contains("give the new agent its own worktree"), "{a}");
        assert_eq!(std::fs::read_to_string(format!("{h}/.anti-hall/swarm-spawns.log")).unwrap().lines().count(), 1, "an advisory spawn is recorded once");
        std::fs::write(format!("{h}/CLAUDE.md"), "Rules: no worktrees here.\n").unwrap();
        // a repo rule that forbids worktrees makes the hint moot (guards.sharedTreeQuietNoWorktrees, default on)
        assert!(advisory(call(&h, &writer, T0 + 1, Some(8.0 * GB), 16.0 * GB)).is_none(), "silent under a no-worktrees rule");
    }

    #[test]
    fn the_advisory_is_silent_whenever_node_is_silent() {
        let h = swarm_home("sw-quiet");
        // many allowed spawns whose launches never reach the transcript: the concurrent-agent cap (GH #494) is not what this tests
        std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"maxConcurrentAgents":0}}"#).unwrap();
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

    // lane L12: Node reads the default window of the transcript (`runningAgents`); an agent launched further back is not seen, so the
    // note stays silent where a widened read would have found it
    #[test]
    fn the_shared_tree_note_reads_only_the_default_window_of_the_transcript() {
        let h = swarm_home("sw-window");
        let t = transcript(&h, json!({"subagent_type": "general-purpose", "prompt": "fix it"}));
        let p = json!({"tool_name": "Agent", "tool_input": {"subagent_type": "general-purpose"}, "transcript_path": t, "cwd": h});
        assert!(advisory(call(&h, &p, T0, Some(8.0 * GB), 16.0 * GB)).is_some(), "the running writer is inside the window");
        let pad = "{\"type\":\"system\",\"content\":\"padding padding padding padding padding padding padding padding\"}\n";
        let mut body = std::fs::read_to_string(&t).unwrap();
        body.push_str(&pad.repeat(defaults::num("agent_scan.tail_bytes") as usize / pad.len() + 100));
        std::fs::write(&t, body).unwrap();
        assert!(advisory(call(&h, &p, T0 + 1, Some(8.0 * GB), 16.0 * GB)).is_none(), "a launch before the default window is not seen");
    }

    // issue #55: a brief that names its own clone or working directory outside the session's tree shares no tree
    #[test]
    fn a_brief_naming_another_clone_shares_no_tree() {
        let h = swarm_home("sw-named");
        // many allowed spawns whose launches never reach the transcript: the concurrent-agent cap (GH #494) is not what this tests
        std::fs::write(format!("{h}/.anti-hall/settings.json"), r#"{"guards":{"maxConcurrentAgents":0}}"#).unwrap();
        let proj = format!("{h}/proj");
        std::fs::create_dir_all(format!("{proj}/.git")).unwrap();
        std::fs::write(format!("{proj}/.git/HEAD"), "ref: refs/heads/main\n").unwrap();
        let busy = transcript(&h, json!({"subagent_type": "general-purpose", "prompt": "fix it"}));
        let mut n = 0u64;
        let mut note = |prompt: &str, t: &str| {
            n += 1;
            let p = json!({"tool_name": "Agent", "tool_input": {"subagent_type": "general-purpose", "prompt": prompt}, "transcript_path": t, "cwd": proj});
            advisory(call(&h, &p, T0 + n, Some(8.0 * GB), 16.0 * GB))
        };
        for p in [
            "Base: create a clone ~/work/wt-lane3 from origin/dev, branch lane3. Fix hooks/foo.js and commit.",
            "cd /opt/build/other-checkout && fix hooks/foo.js, then commit.",
            "Your working directory is the clone at $HOME/work/wt-x. Edit and commit there.",
        ] {
            assert!(note(p, &busy).is_none(), "named outside clone: {p}");
        }
        assert!(note("cd ~/proj/sub && fix hooks/foo.js and commit.", &busy).is_some(), "a path inside the session tree still warns");
        assert!(note("git clone /srv/mirror.git for reference, then fix hooks/foo.js and commit.", &busy).is_some(), "a clone source is no tree");
        assert!(note("Use the clone ~/work/wt-ref for reading; edit hooks/foo.js in the repo in place.", &busy).is_some(), "in place still warns");
        // (transcript() rewrites the one transcript file: the running agent's brief changes last)
        let other = transcript(&h, json!({"subagent_type": "general-purpose", "prompt": "Base: create a clone ~/work/wt-a from origin/dev; fix and commit."}));
        assert!(note("fix it", &other).is_none(), "the running agent works in another clone");
    }

    #[test]
    fn what_the_script_cannot_reproduce_defers_before_the_spawn_is_recorded() {
        let h = swarm_home("sw-defer");
        let t = transcript(&h, json!({"subagent_type": "general-purpose"}));
        let log = format!("{h}/.anti-hall/swarm-spawns.log");
        let no_cwd = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": t});
        assert_eq!(call(&h, &no_cwd, T0, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)), "no cwd: Node would use the hook's own directory");
        let rel = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": "t.jsonl", "cwd": h});
        assert_eq!(call(&h, &rel, T0 + 1, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)), "a relative transcript path");
        let odd = json!({"tool_name": "Agent", "tool_input": {}, "transcript_path": t, "cwd": format!("{h}/../x")});
        assert_eq!(call(&h, &odd, T0 + 2, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)), "a cwd that is not in normal form");
        // Node answers these too (an allowed spawn is recorded, so the log holds the three)
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 3, "each allowed spawn is recorded");
    }

    #[test]
    fn the_log_is_read_like_parse_int_and_a_huge_entry_defers() {
        let h = swarm_home("sw-huge");
        std::fs::write(format!("{h}/.anti-hall/swarm-spawns.log"), "99999999999999999999\n").unwrap();
        assert_eq!(call(&h, &spawn(), T0, Some(8.0 * GB), 16.0 * GB), Some(Some(Verdict::Allow)));
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

    /// A 200,000-line transcript: one human prompt at the top (a subagent's task, far outside the read window), then
    /// alternating status texts, edits and their results; the turn ends with the cause statement. `big_texts` makes every
    /// status text about 6.5 KB, so the window holds about 1 MB of assistant text.
    fn long_transcript(h: &str, name: &str, big_texts: bool) -> String {
        let p = format!("{h}/{name}");
        let mut out = String::with_capacity(48 << 20);
        out.push_str(&user("please fix the crash"));
        out.push('\n');
        let filler = if big_texts { "the reader looks at this module and moves on to the next one ".repeat(100) } else { String::new() };
        // one serialized template per line kind, the step number substituted (serializing 200,000 lines is slow in a debug build)
        let block = [say(&format!("Step @: working through a module {filler}")), tool("Edit", json!({"file_path": "/x/m@.rs"})), result()].join("\n");
        let mut n = 1;
        let mut i = 0;
        while n < 200_000 {
            i += 1;
            out.push_str(&block.replace('@', &i.to_string()));
            out.push('\n');
            n += 3;
        }
        out.push_str(&say(CAUSE));
        out.push('\n');
        std::fs::write(&p, out).unwrap();
        p
    }

    /// The reminder (a block that continues the turn) on a long transcript: the script reads only the end of the turn, so
    /// it answers within its CPU-time limit (the limit of the build under test; a release build is held to the shipped one).
    #[test]
    fn a_200k_line_transcript_is_answered_within_the_script_limit() {
        for (tag, big) in [("long", false), ("long-big", true)] {
            let h = h(tag);
            let t = long_transcript(&h, &format!("{tag}.jsonl"), big);
            for event in ["Stop", "SubagentStop"] {
                let mut p = stop(&h, &t, CAUSE);
                p["hook_event_name"] = json!(event);
                p["session_id"] = json!(format!("{tag}-{event}"));
                let started = std::time::Instant::now();
                let v = go(&h, &p);
                let took = started.elapsed();
                assert!(is_adv(&v), "{tag} {event}: the reminder, not a script failure (which fails open): {v:?}");
                if !cfg!(debug_assertions) {
                    // wall time, not CPU time: a loaded CI runner stretches it, so CI sets AH_TEST_TIME_SCALE (default 1)
                    let scale: u128 = std::env::var("AH_TEST_TIME_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
                    assert!(took.as_millis() < u128::from(defaults::num("script.time_limit_ms")) * scale, "{tag} {event}: {took:?} (scale {scale})");
                }
            }
        }
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
        assert!(t.contains("similar bugs check") && t.contains("search for the same cause"), "{t}");
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
        let before =
            write(&d, "b.jsonl", &[user("fix"), tool("Grep", json!({"pattern": "read_window"})), result(), tool("Edit", json!({})), result(), say(CAUSE)]);
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
        append(
            &p,
            &[tool("Read", json!({})), result(), tool("Grep", json!({"pattern": "read_window"})), result(), say("Searched: no other occurrences. Done.")],
        );
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
        let text = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/sibling-sweep-corpus.ndjson"))
            .expect("the corpus file is readable");
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
    assert!(
        kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("exact").copied().unwrap_or(0) > 30 && !kinds.contains_key("defer"),
        "both answers, no deferral: {kinds:?}"
    );
}

#[test]
fn devswarm_parent_inbox_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("devswarm-parent-inbox");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 100 && !kinds.contains_key("defer"), "both answers: {kinds:?}");
}

// ---- task-lifecycle-log, the session gates, merge-side-pick, scan-throttle and merge-gate (D88 batch 6) ----

#[test]
fn task_lifecycle_log_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("task-lifecycle-log");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 40 && !kinds.contains_key("defer"), "both answers: {kinds:?}");
}

#[test]
fn jev_weekly_scorecard_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("jev-weekly-scorecard");
    assert!(kinds.get("allow").copied().unwrap_or(0) > 40 && !kinds.contains_key("defer"), "both answers: {kinds:?}");
}

#[test]
fn jev_review_reminder_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("jev-review-reminder");
    // every payload is answered here (the Node fallback is gone, #248)
    for k in ["advisory", "allow"] {
        assert!(kinds.get(k).copied().unwrap_or(0) >= 10, "a corpus that exercises {k}: {kinds:?}");
    }
    assert!(!kinds.contains_key("defer"), "no deferral: {kinds:?}");
}

#[test]
fn repair_on_reload_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("repair-on-reload");
    // L06: a due repair is asked of the refresh job (allow); the undecidable shapes (no home, no plugin root, a version that is not a
    // plain three-part one) are answered natively too (#248)
    assert!(kinds.get("allow").copied().unwrap_or(0) > 40 && !kinds.contains_key("defer"), "both answers: {kinds:?}");
}

#[test]
fn merge_side_pick_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("merge-side-pick");
    assert!(
        kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("advisory").copied().unwrap_or(0) > 50 && !kinds.contains_key("defer"),
        "every answer: {kinds:?}"
    );
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
    golden::regen_defers_local("scan-throttle");
    for c in golden::load("scan-throttle") {
        let l = golden::lay(&c);
        let got = super::run_forced("scan-throttle", &l.payload, &l.opts, &l.event, &l.env).expect("a shipped script");
        let mut got = golden::verdict_json(&got, &l);
        prefix_neutral(&mut got);
        let mut expected = c["expect"].clone();
        prefix_neutral(&mut expected);
        assert_eq!(
            got,
            expected,
            "scan-throttle: script differs from the compiled port on case {}: {} ({:?})",
            c["n"],
            c["payload"],
            crate::discard::captured()
        );
        *kinds.entry(got["v"].as_str().unwrap_or("").to_string()).or_insert(0usize) += 1;
        crate::discard::harmless(std::fs::remove_dir_all(&l.home)); // keep: cleanup of a scratch directory
    }
    assert!(kinds["advisory"] > 50 && kinds["allow"] > 100 && !kinds.contains_key("defer"), "every answer, no deferral: {kinds:?}");
}

#[test]
fn merge_gate_script_matches_the_compiled_port() {
    let kinds = golden::assert_script_matches("merge-gate");
    assert!(
        kinds.get("allow").copied().unwrap_or(0) > 100 && kinds.get("exact").copied().unwrap_or(0) > 50 && !kinds.contains_key("defer"),
        "every answer: {kinds:?}"
    );
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

// ---- speculation-guard: the Stop gate on the Jev wait (a sync ask only for a flagged reply) ----

mod speculation_stop_gate {
    use super::*;
    use crate::jev::testkit::{install_scripted, ok};
    use crate::jev::transport::NetError;

    const ON: [(&str, &str); 2] = [("ANTIHALL_JEV", "1"), ("CLAUDE_PLUGIN_OPTION_JEV_VERCEL_API_KEY", "vk")];
    /// No hedge word at all: the rule layer flags nothing.
    const UNFLAGGED: &str = "Here is the list of files in the directory.";
    /// No hedge word, but an unhedged completion claim with no evidence in the reply: the claim gate flags it (#310).
    const CLAIM: &str = "All done. The fix is complete and everything passes.";
    /// A hedge the reply itself acknowledges (a command it ran): flagged by the hit scan, yet the rule layer alone would not block.
    const FLAGGED: &str = "This probably fixes it, verified in main.js:42.";

    fn run(
        tag: &str,
        text: &str,
        extra: &[(&str, &str)],
        script: Vec<Result<crate::jev::transport::RawResponse, NetError>>,
    ) -> (Option<Option<Verdict>>, std::sync::Arc<crate::jev::Jev>, std::sync::Arc<crate::jev::testkit::Fake>, String) {
        let h = home(tag);
        let t = format!("{h}/t.jsonl");
        std::fs::write(&t, "").unwrap();
        let mut pairs = vec![("HOME".to_string(), h.clone())];
        pairs.extend(ON.iter().chain(extra.iter()).map(|(k, v)| (k.to_string(), v.to_string())));
        let (jev, fake) = install_scripted(std::path::Path::new(&h), &ON, script);
        let payload = json!({"transcript_path": t, "session_id": tag, "last_assistant_message": text});
        let v = super::super::run_forced("speculation-guard", &payload, &Value::Null, "Stop", &RequestEnv::from_pairs(pairs));
        (v, jev, fake, h)
    }

    fn drained(jev: &crate::jev::Jev) -> crate::metrics::Metrics {
        let mut m = crate::metrics::Metrics::default();
        jev.stats.drain_into(&mut m);
        m
    }

    #[test]
    fn an_unflagged_stop_makes_no_sync_jev_call_and_stays_inside_the_stop_limit() {
        // one call first, so the timed one does not include the interpreter's cold start
        let _ = run("sg-gate-warm", UNFLAGGED, &[], vec![]);
        let started = std::time::Instant::now();
        let (v, jev, fake, _) = run("sg-gate-unflagged", UNFLAGGED, &[], vec![ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]);
        let took = started.elapsed();
        assert_eq!(v, Some(Some(Verdict::Allow)), "{v:?}");
        assert!(fake.seen.lock().unwrap().is_empty(), "no request went to Jev");
        assert!(took < std::time::Duration::from_millis(defaults::num("jev.stop_soft_ms")), "{took:?}");
        assert!(format!("{:?}", drained(&jev)).contains("jev_skipped_unflagged"));
    }

    #[test]
    fn an_unhedged_done_claim_without_evidence_is_asked_synchronously_and_blocked_on_a_confident_answer() {
        let (v, jev, fake, _) = run("sg-gate-claim", CLAIM, &[], vec![ok(200, r#"{"answers":{"decision":{"noul":0.95}}}"#)]);
        assert_eq!(fake.seen.lock().unwrap().len(), 1, "the unhedged claim was asked about, synchronously");
        assert!(matches!(v, Some(Some(Verdict::Exact(_)))), "Jev's confident verdict added the block: {v:?}");
        assert!(format!("{:?}", drained(&jev)).contains("jev_asked_sync"));
    }

    #[test]
    fn an_unhedged_claim_that_cites_evidence_is_not_asked() {
        let (v, _, fake, _) = run("sg-gate-claim-ack", "All done. Verified in main.js:42.", &[], vec![ok(200, r#"{"answers":{"decision":{"noul":0.9}}}"#)]);
        assert_eq!(v, Some(Some(Verdict::Allow)), "{v:?}");
        assert!(fake.seen.lock().unwrap().is_empty(), "a cited claim is not flagged");
    }

    #[test]
    fn the_stop_jev_wait_fits_inside_the_request_and_client_windows() {
        // jev.stop_hard_ms is the longest a flagged Stop waits; the daemon cuts a check at request_hard_ms - reply_slack_ms, and the
        // client waits for a late reply up to slow_fallback_max_ms - slow_wait_margin_ms
        let hard = defaults::num("jev.stop_hard_ms");
        assert!(defaults::num("jev.stop_soft_ms") < hard);
        assert!(hard <= defaults::num("jev.timeout_ms"), "no longer than Node's 1500 ms ceiling");
        assert!(hard < defaults::num("daemon.request_hard_ms") - defaults::num("daemon.reply_slack_ms"));
        assert!(defaults::num("daemon.request_hard_ms") < defaults::num("client.slow_fallback_max_ms") - defaults::num("client.slow_wait_margin_ms"));
    }

    #[test]
    fn the_gate_is_on_and_the_background_ask_off_by_default() {
        // both are TOML values
        assert_eq!(defaults::num("jev.gate_background_ask"), 0);
        assert_eq!(defaults::num("jev.gate_enabled"), 1);
    }

    #[test]
    fn a_flagged_stop_waits_for_jev_and_uses_its_verdict() {
        let (v, jev, fake, _) = run("sg-gate-flagged", FLAGGED, &[], vec![ok(200, r#"{"answers":{"decision":{"noul":0.95}}}"#)]);
        assert_eq!(fake.seen.lock().unwrap().len(), 1, "the flagged reply was asked about, synchronously");
        assert!(matches!(v, Some(Some(Verdict::Exact(_)))), "Jev's confident verdict added the block: {v:?}");
        assert!(format!("{:?}", drained(&jev)).contains("jev_asked_sync"));
    }

    #[test]
    fn a_flagged_stop_whose_wait_times_out_fails_open_with_the_fail_open_reason() {
        let (v, jev, _, h) = run("sg-gate-timeout", FLAGGED, &[], vec![Err(NetError::Timeout), Err(NetError::Timeout)]);
        assert_eq!(v, Some(Some(Verdict::Allow)), "the baseline stands: {v:?}");
        let log = std::fs::read_to_string(format!("{h}/.anti-hall/logs/jev-judge.ndjson")).unwrap_or_default();
        let m = format!("{:?}", drained(&jev));
        assert!(log.contains("fail_open") || m.contains("jev_gate_timeouts"), "log: {log}; metrics: {m}");
        assert!(log.contains("fail_open"), "the reason is named: {log}");
        assert!(m.contains("jev_gate_timeouts"), "{m}");
    }
}

#[test]
fn tail_entries_projects_parsed_lines_and_hands_back_what_its_parser_refused() {
    let h = home("tail-entries");
    let p = format!("{h}/t.jsonl");
    let big = "x".repeat(100);
    let lines = [
        r#"{"type":"user","isMeta":true,"message":{"content":"hi"},"toolUseResult":{"stdout":"BIG"}}"#.to_string(),
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"t"}},{{"type":"tool_use","name":"Bash","input":{{"command":"ls","file":"{big}"}}}}]}}}}"#
        ),
        String::new(),
        "[1,2]".to_string(),
        r#"{"type":"user","message":{"content":"\ud800"}}"#.to_string(),
        "not json".to_string(),
        format!(r#"{{"big":"{big}"}}"#),
    ];
    std::fs::write(&p, lines.join("\n") + "\n").unwrap();
    let keep = r#"[["type"],["isMeta"],["message","content"],["message","content","*","type"],["message","content","*","text"],["message","content","*","name"],["message","content","*","input","command"]]"#;
    let r: Value = serde_json::from_str(&super::host::tail_entries(&p, 0.0, 120.0, keep, 0.0).unwrap()).unwrap();
    let v: Vec<&Value> = r["lines"].as_array().unwrap().iter().map(|l| &l[1]).collect();
    assert_eq!(v[0], &json!({"type": "user", "isMeta": true, "message": {"content": "hi"}}), "unnamed parts are dropped");
    assert_eq!(v[1], &Value::Null, "a line over lineMax is unread, as tailLines");
    assert_eq!(v[2], &json!(0), "a blank line");
    assert_eq!(v[3], &json!(0), "JSON that is not an object");
    assert_eq!(v[4], &json!(r#"{"type":"user","message":{"content":"\ud800"}}"#), "a lone surrogate: the text, for JSON.parse");
    assert_eq!(v[5], &json!("not json"));
    assert_eq!(v[6], &json!({}));
    let r: Value = serde_json::from_str(&super::host::tail_entries(&p, 0.0, 400.0, keep, 0.0).unwrap()).unwrap();
    assert_eq!(
        r["lines"][1][1],
        json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "t"}, {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}]}})
    );
    // only the newest maxLines lines are parsed and returned; the older ones are counted
    let r: Value = serde_json::from_str(&super::host::tail_entries(&p, 0.0, 120.0, keep, 3.0).unwrap()).unwrap();
    assert_eq!(r["lines"].as_array().unwrap().len(), 3);
    assert_eq!((r["dropped"].as_u64(), r["droppedUnread"].as_u64()), (Some(4), Some(1)));
    assert!(super::host::tail_entries(&p, 0.0, 120.0, "{}", 0.0).is_none(), "keep must be a list of paths");
}

/// The transcript-scanning Stop-time and prompt-time checks carry their own CPU-time limit in `script.time_limit_by_check`: a
/// real transcript tail made the default limit interrupt them and defer a decision the script makes identically given the time.
#[test]
fn stop_time_checks_have_their_own_time_limit() {
    let by = defaults::raw("script.time_limit_by_check");
    for name in [
        "tasklist-guard",
        "task-guard",
        "silent-agent-nudge",
        "stale-agent-stop-note",
        "auto-handover",
        "auto-handover-pause-nag",
        "compact-advice-guard",
        "limit-conserve-inject",
        "idle-agent-sweep",
    ] {
        assert!(by.get(name).and_then(defaults::V::as_integer).is_some_and(|ms| ms >= 500), "{name}");
    }
}

/// Issue #21: a worker's interpreter does not grow with the number of calls. Round-robin over every shipped script, many rounds: past
/// the soft limit the least recently called checks are unloaded (and rebuilt by their next call, with the same answer), so the size after
/// a collection stays inside a band and the later rounds are no larger than the earlier ones.
#[test]
fn interpreter_memory_stays_in_a_band_over_many_calls() {
    let h = home("band");
    let ext = defaults::text("script.ext");
    let dir = defaults::root().expect("plugin root").join(defaults::text("script.logic_dir"));
    let mut names: Vec<String> =
        std::fs::read_dir(&dir).unwrap().flatten().filter_map(|e| e.file_name().to_string_lossy().strip_suffix(ext).map(str::to_string)).collect();
    names.sort();
    let soft = defaults::num("mem.quickjs_soft_bytes") as i64;
    let max = defaults::num("mem.quickjs_hard_bytes") as i64;
    let rounds = 6;
    let sizes = std::thread::spawn(move || {
        let e = env(&h);
        let payload = json!({"hook_event_name": "Notification", "cwd": h});
        let mut first_answers: Vec<String> = Vec::new();
        let mut sizes = Vec::new();
        for round in 0..rounds {
            for (i, name) in names.iter().enumerate() {
                let full = format!("{:?}", super::run_forced(name, &payload, &Value::Null, "Notification", &e));
                // the KIND of answer (allow, defer, advisory, block) does not depend on whether the entry was just rebuilt; a check that keeps
                // state across calls (task-tracker's repeat reminder) words its text differently the second time
                let v = full.split_once("(\"").map_or(full.clone(), |(kind, _)| kind.to_string());
                if round == 0 {
                    first_answers.push(v);
                } else {
                    // a reminder that fires once per change (jev-review-reminder, #247) is an advisory the first time and silent after it
                    let once = first_answers[i].contains("Advisory") && v.contains("Allow");
                    assert!(first_answers[i] == v || once, "{name} answered differently in round {round}: {} then {v}", first_answers[i]);
                }
            }
            let (_, bytes, ..) = super::pool_usage().expect("ran scripts");
            sizes.push(bytes);
        }
        crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
        sizes
    })
    .join()
    .expect("the scripts ran");
    // one check is loaded after the limit is applied, so the band is the soft limit plus the largest single check (well under 1 MiB)
    for (r, b) in sizes.iter().enumerate() {
        assert!(*b <= soft + (1 << 20) && *b <= max, "round {r}: {b} bytes after a collection, soft limit {soft}, ceiling {max}: {sizes:?}");
    }
    // flat: the last rounds hold no more than the second round (+5%), however many calls were made in between
    assert!(sizes[rounds - 1] as f64 <= sizes[1] as f64 * 1.05, "growth over calls: {sizes:?}");
}

/// R0 soak (train live18): cyclic garbage waited for QuickJS's own collector, which runs only at 1.5 times the size after its previous
/// run, so a worker holding every check (~5.7 MB) kept up to ~2.8 MB of garbage the memory registry never saw, and the soak's footprint
/// rose for the whole run. With `maintain` called after each request (as the daemon's worker loop does), the garbage waiting between
/// calls stays within `script.gc_every_calls` calls' worth, however many calls are made. Measured WITHOUT a collection (the band test
/// above measures after one, which is why it could not see this).
#[test]
fn cyclic_garbage_between_calls_stays_within_gc_every_calls() {
    let h = home("gcevery");
    let e = env(&h);
    // ~2 MB held live (the entry keeps it referenced); each call leaves a few small cycles that only a collection frees
    put_override(
        &h,
        "zz-cycles",
        "var zzKeep = []; for (var i = 0; i < 4096; i++) zzKeep.push({i: i, s: 'k' + i, t: [i, i + 1, i + 2, i + 3, i + 4, i + 5, i + 6, i + 7]});\n\
         function decide() { for (var j = 0; j < 2; j++) { var a = {n: j}; var b = {a: a}; a.b = b; } return zzKeep.length ? null : {block: 'empty'}; }",
    );
    let every = defaults::num("script.gc_every_calls") as i64;
    let p = json!({"tool_name": "Write"});
    let (one, worst) = std::thread::spawn(move || {
        let now = || POOL.with(|c| c.borrow().as_ref().map(|p| p.rt.memory_usage().malloc_size)).expect("the thread ran scripts");
        let gc = || POOL.with(|c| c.borrow().as_ref().map(|p| p.rt.run_gc()));
        run_forced("zz-cycles", &p, &e);
        gc();
        // the collector's own threshold as QuickJS sets it after a run at this size (1.5x), independent of how this thread got here
        let base = now();
        POOL.with(|c| c.borrow().as_ref().map(|p| p.rt.set_gc_threshold(base as usize * 3 / 2)));
        // one call's garbage, averaged over a few calls
        let probe = 100;
        for _ in 0..probe {
            run_forced("zz-cycles", &p, &e);
        }
        let one = ((now() - base) / probe).max(1);
        super::maintain(true);
        let mut worst = 0;
        for _ in 0..(5 * every) {
            run_forced("zz-cycles", &p, &e);
            super::maintain(false);
            worst = worst.max(now() - base);
        }
        crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
        (one, worst)
    })
    .join()
    .expect("the scripts ran");
    // at most `every` calls' worth waits, plus one 4 KiB arena per QuickJS size class left partly used
    let bound = every * one + 31 * 4096;
    assert!(worst <= bound, "garbage waiting between calls grew to {worst} bytes, bound {bound} ({every} calls x {one} bytes + arenas)");
}

/// Issue #21: the regex cache is ONE cache bounded by estimated bytes: many distinct patterns cannot push it past its budget, and two
/// threads asking for the same pattern share one compiled program.
#[test]
fn the_shared_regex_cache_is_bounded_by_bytes_and_shared_across_threads() {
    let budget = defaults::num("mem.regex_soft_bytes") as usize;
    let max = defaults::num("mem.regex_max_entries") as usize;
    // each pattern is distinct and long enough that the budget (not the entry count) is what binds first
    let long = |i: usize| format!("zzcache{i}\\s+{}", "(?:a|b)x".repeat(40));
    for i in 0..(max * 3) {
        let r = super::recache::get(&long(i), "i").expect("valid pattern");
        assert!(r.is_match(&format!("zzcache{i}  {}", "ax".repeat(40))), "pattern {i} does not match its own text");
        let (n, bytes) = super::recache::usage();
        assert!(bytes <= budget && n <= max, "after {i} patterns: {n} entries, {bytes} bytes, budget {budget}, max {max}");
    }
    let a = super::recache::get("zzshared\\d+", "").unwrap();
    let b = std::thread::spawn(|| super::recache::get("zzshared\\d+", "").unwrap()).join().unwrap();
    assert!(std::sync::Arc::ptr_eq(&a, &b), "two threads got two compiled copies");
    assert!(super::recache::get("(", "").is_err(), "an invalid pattern is an error, not a cache entry");
}

/// Claude Code 2.1.292 fires UserPromptSubmit before a skill or command is expanded, so `prompt` is the raw `/skill args` text.
/// None of the prompt checks may read expanded skill text: each must answer the raw slash prompt exactly as it answers a plain
/// prompt of the same session shape, and none may block.
#[test]
fn the_prompt_checks_answer_a_raw_slash_command_prompt_like_a_plain_one() {
    let opts = json!({"payload_sha1": "015d8cb1790e94c77d711b8f8dcbc993aa175346"});
    for check in ["verify-first", "task-tracker", "limit-conserve-inject", "auto-handover", "agent-reminders", "gh-rt-advisory"] {
        let answer = |prompt: &str, tag: &str| {
            let h = home(&format!("raw-{check}-{tag}"));
            let p = json!({"hook_event_name": "UserPromptSubmit", "session_id": "s1", "cwd": "/tmp", "prompt": prompt});
            let v = super::run_forced(check, &p, &opts, "UserPromptSubmit", &env(&h))
                .unwrap_or_else(|| panic!("{check}: a shipped script"))
                .unwrap_or_else(|| panic!("{check}: a verdict"));
            crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: a test scratch directory
            v
        };
        let raw = answer("/anti-hall:ship-it build x", "raw");
        assert!(!matches!(raw, Verdict::Block(_)), "{check} blocked a raw slash prompt: {raw:?}");
        assert_eq!(raw, answer("build x", "plain"), "{check} reads the prompt text beyond its own purpose");
    }
}

/// A cached pattern weighs its program plus the per-thread search scratch the regex crate keeps inside it (and cannot report):
/// `daemon.workers` times `script.regex_scratch_bytes`, so the registry sees the memory the lazy DFAs really hold.
#[test]
fn a_cached_pattern_weighs_its_per_thread_search_scratch_too() {
    let scratch = super::recache::scratch_estimate();
    assert_eq!(scratch, (defaults::num("daemon.workers") * defaults::num("script.regex_scratch_bytes")) as usize);
    assert!(scratch > 0, "the shipped defaults estimate a scratch per pattern");
    let (_, before) = super::recache::usage();
    super::recache::get("zzscratchweight\\d{3}", "").expect("valid pattern");
    let (_, after) = super::recache::usage();
    assert!(after - before >= scratch, "the entry weighs at least its scratch estimate: {} < {scratch}", after - before);
}

#[test]
fn the_limit_that_interrupted_a_call_is_named_in_its_failure() {
    use super::{Deadline, Trip};
    use std::sync::atomic::Ordering::Relaxed;
    let d = Deadline::default();
    assert_eq!(d.exceeded(10, 10), None, "nothing armed, nothing fires");
    d.cpu.store(100, Relaxed);
    d.wall.store(5_000, Relaxed);
    d.req.store(9_000, Relaxed);
    assert_eq!(d.exceeded(100, 10), None, "at the limit is not past it");
    assert_eq!(d.exceeded(101, 10), Some(Trip::Cpu));
    assert_eq!(d.exceeded(0, 5_001), Some(Trip::Wall));
    assert_eq!(d.exceeded(0, 9_001), Some(Trip::Wall), "the wall backstop is reported ahead of the client deadline");
    d.wall.store(0, Relaxed);
    assert_eq!(d.exceeded(0, 9_001), Some(Trip::Request));
    assert_eq!(d.explain("interrupted", 50), "interrupted", "no trip recorded: the error is left as it was");
    d.trip.store(Trip::Cpu as u64, Relaxed);
    let cpu_ms = (50 * defaults::num("script.time_hard_factor")).min(defaults::num("script.time_hard_cap_ms"));
    let wall_ms = cpu_ms * defaults::num("script.wall_limit_factor");
    assert_eq!(d.explain("interrupted", 50), format!("interrupted (interrupted by the cpu limit; cpu limit {cpu_ms} ms, wall backstop {wall_ms} ms)"));
}

/// R1 ENG-MEM: a worker that has not called a script for `script.idle_free_ms` frees its interpreter when it goes idle, and its next call
/// builds a new one that answers the same. A busy worker (`maintain(false)`) and an interpreter still inside the window keep theirs.
#[test]
fn an_idle_worker_frees_its_interpreter_and_the_next_call_rebuilds_it() {
    let h = home("idlefree");
    let e = env(&h);
    put_override(&h, "zz-idle", "function decide(p) { return {block: 'seen ' + p.tool_name}; }");
    let p = json!({"tool_name": "Write"});
    let ms = defaults::num("script.idle_free_ms");
    assert!(ms > 0, "the shipped default frees idle interpreters");
    let seen = std::thread::spawn(move || {
        let first = run_forced("zz-idle", &p, &e);
        assert!(super::pool_usage().is_some(), "a call builds the interpreter");
        super::maintain(true);
        assert!(super::pool_usage().is_some(), "inside script.idle_free_ms the interpreter stays");
        let old = std::time::Instant::now().checked_sub(std::time::Duration::from_millis(ms + 1)).expect("a clock older than the window");
        POOL.with(|c| c.borrow_mut().as_mut().expect("pool").last_call = old);
        super::maintain(false);
        assert!(super::pool_usage().is_some(), "a worker with a request waiting is not idle");
        super::maintain(true);
        assert!(super::pool_usage().is_none(), "an idle worker past the window frees its interpreter");
        let again = run_forced("zz-idle", &p, &e);
        assert!(super::pool_usage().is_some(), "the next call rebuilds it");
        (first, again)
    })
    .join()
    .expect("assertions hold");
    assert_eq!(seen.0, Some(Some(Verdict::Block("seen Write".into()))));
    assert_eq!(seen.0, seen.1, "the rebuilt interpreter answers the same");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

// ---- v0.301 W3b: no hand-backs in the shared libs --------------------------------------------------------------------

/// The scripts hand nothing back to Node: no deferral sentinel or token is left in an executable line of the plugin logic.
#[test]
fn no_script_hands_a_case_back_to_node() {
    let _ = defaults::text("script.ext"); // the root is known once the defaults are loaded
    let root = defaults::root().expect("plugin root").join("engine/logic");
    let banned = ["'defer'", "meshDefer", "UNDECIDABLE", "cb.DEFER", "cb.defer(", "gates.run("];
    let mut stack = vec![root];
    let mut seen = 0;
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).expect("logic directory").flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "js") {
                seen += 1;
                for (i, line) in std::fs::read_to_string(&p).expect("script").lines().enumerate() {
                    if line.trim_start().starts_with("//") {
                        continue;
                    }
                    for b in banned {
                        assert!(!line.contains(b), "{}:{} still hands a case back ({b}): {line}", p.display(), i + 1);
                    }
                }
            }
        }
    }
    assert!(seen > 50, "the scan reached the scripts ({seen})");
}

/// A DevSwarm child whose message store the host cannot read exactly (a forced backend it does not read) is answered natively, like
/// Node does (silence); with the store simply absent the same child hears nothing.
#[test]
fn a_child_mailbox_the_host_cannot_count_gets_the_drain_nudge_with_an_unknown_count() {
    let case = |forced: bool| {
        let mut env = json!({"DEVSWARM_BUILDER_ID": "ws-1", "DEVSWARM_REPO_ID": "r1", "DEVSWARM_SOURCE_BRANCH": "b", "HOME": "{HOME}"});
        if forced {
            env[defaults::text("mesh_write.env_store_backend")] = json!("journal");
        }
        json!({
            "env": env, "event": "PostToolUse", "opts": {"plugin_root": "{PLUGIN}"},
            "files": {
                ".anti-hall/devswarm/workspaces/ws-1.json": "{\"inboxPath\":\"{HOME}/inbox\",\"worktreePath\":\"{HOME}/wt\"}",
                "wt/.git/HEAD": "ref: refs/heads/main\n",
            },
            "payload": {"hook_event_name": "PostToolUse", "session_id": "s1", "tool_input": {"command": "ls"}, "tool_name": "Bash"},
        })
    };
    let run = |forced: bool| {
        let l = golden::lay(&case(forced));
        let got = golden::run_case("devswarm-child-drain", &l, 1).expect("a shipped script");
        golden::verdict_json(&got, &l)
    };
    // Node's hook says nothing in either case (checked on this payload), and the native answer no longer hands the case back or adds a
    // nudge of its own (#248): both are allowed.
    assert_eq!(run(true)["v"], "allow", "a store the host cannot count is not passed with a nudge Node never gave");
    assert_eq!(run(false)["v"], "allow", "an absent store is a count of zero, not an unknown one");
}

// ---- v0.301 W3b: the weekly Jev scorecard ----------------------------------------------------------------------------

/// The weekly scorecard is built again: a KEEP verdict whose integration is not on is named, and the week is consumed only once the
/// scorecard exists. A Jev that is off hears nothing and stamps nothing.
#[test]
fn the_weekly_scorecard_names_an_integration_whose_mode_lags_its_keep_verdict() {
    let rows: String = (0..60)
        .flat_map(|i| {
            [
                format!("{{\"ts\":\"{{ISO}}\",\"id\":\"zz-test\",\"h\":\"h{i}\",\"backend\":\"jev\",\"mode\":\"on\",\"changed\":\"added\",\"ms\":100}}"),
                format!("{{\"type\":\"outcome\",\"ts\":\"{{ISO}}\",\"id\":\"zz-test\",\"h\":\"h{i}\",\"outcome\":\"ok\"}}"),
            ]
        })
        .collect::<Vec<_>>()
        .join("\n");
    let case = |enabled: bool| {
        json!({
            "env": {"HOME": "{HOME}"}, "event": "SessionStart", "opts": {"plugin_root": "{PLUGIN}"},
            "files": {".anti-hall/jev.json": format!("{{\"enabled\":{enabled}}}"), ".anti-hall/logs/jev-assist.ndjson": rows.clone()},
            "payload": {"hook_event_name": "SessionStart", "session_id": "s1"},
        })
    };
    let latch = defaults::text("jev_weekly.latch_file");
    let on = golden::lay(&case(true));
    let got = golden::verdict_json(&golden::run_case("jev-weekly-scorecard", &on, 1).expect("a shipped script"), &on);
    assert_eq!(got["v"], "advisory", "{got}");
    assert!(got["text"].as_str().unwrap_or_default().contains("zz-test is ready to switch ON."), "{got}");
    assert!(Path::new(&on.home).join(".anti-hall").join(latch).is_file(), "the week is consumed once the scorecard is built");
    let off = golden::lay(&case(false));
    assert_eq!(golden::verdict_json(&golden::run_case("jev-weekly-scorecard", &off, 1).expect("a shipped script"), &off)["v"], "allow");
    assert!(!Path::new(&off.home).join(".anti-hall").join(latch).exists(), "a Jev that is off consumes nothing");
}

/// Script load check (every script a hand-back removal touched): each loads in the interpreter and answers a minimal call on its
/// own event without a script error (a script error would otherwise pass as a quiet allow).
#[test]
fn every_script_without_hand_backs_loads_and_answers_a_minimal_call() {
    let checks = [
        ("auto-handover", "UserPromptSubmit"),
        ("auto-handover-pause-nag", "Stop"),
        ("limit-conserve-inject", "UserPromptSubmit"),
        ("devswarm-child-gate", "Stop"),
        ("devswarm-child-drain", "PostToolUse"),
        ("devswarm-child-turn", "UserPromptSubmit"),
        ("devswarm-parent-gate", "Stop"),
        ("devswarm-parent-inbox", "UserPromptSubmit"),
        ("devswarm-parent-reply-tracker", "PostToolUse"),
        ("jev-review-reminder", "SessionStart"),
        ("jev-weekly-scorecard", "SessionStart"),
        ("repair-on-reload", "SessionStart"),
        ("speculation-judge", "Stop"),
        ("devswarm-child-role", "SessionStart"),
    ];
    for (check, event) in checks {
        let case = json!({
            "env": {"HOME": "{HOME}"}, "event": event, "opts": {"plugin_root": "{PLUGIN}"},
            "payload": {"hook_event_name": event, "session_id": "s1", "cwd": "{HOME}", "prompt": "hello", "tool_name": "Bash", "tool_input": {"command": "ls"}},
        });
        let l = golden::lay(&case);
        let got = golden::run_case(check, &l, 1).unwrap_or_else(|| panic!("{check}: no shipped script"));
        assert!(!matches!(got, Some(Verdict::Defer)), "{check}: handed a minimal call back");
        let errors: Vec<(String, String)> = crate::discard::captured().into_iter().filter(|(code, _)| code == "script_error").collect();
        assert!(errors.is_empty(), "{check}: script errors {errors:?}");
    }
}

// ---- v0.301 W3b: the speculation judge in the daemon ------------------------------------------------------------------

/// The opt-in judge block works again: the daemon (a process that may not wait for a model) hands the check to the one-shot dispatcher
/// ({dispatcher: true}, nothing counted as a script error), and the dispatcher, where the call may be made, blocks on the model's verdict.
#[test]
fn the_speculation_judge_is_handed_to_the_dispatcher_and_blocks_there() {
    use crate::jev::cascade::{MODEL_LOCK, TEST_MODEL};
    let _g = MODEL_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let case = json!({
        "env": {"HOME": "{HOME}", "ANTIHALL_SEMANTIC_JUDGE": "1", "ANTIHALL_JUDGE_BACKEND": "cli"},
        "event": "Stop", "files": {"t.jsonl": "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"why is it slow?\"}}\n"},
        "payload": {"hook_event_name": "Stop", "session_id": "s1", "transcript_path": "{HOME}/t.jsonl", "last_assistant_message": "The cause is the old build artifact."},
    });
    assert!(!crate::judge::blocking_calls_allowed(), "the test starts as the daemon is: not allowed to wait for a model");
    let l = golden::lay(&case);
    let in_daemon = golden::verdict_json(&golden::run_case("speculation-judge", &l, 1).expect("a shipped script"), &l);
    assert_eq!(in_daemon, json!({"v": "defer"}), "the daemon hands the check to the dispatcher");
    assert!(crate::discard::captured().iter().all(|(code, _)| code != "script_error"), "{:?}", crate::discard::captured());
    crate::judge::allow_blocking_calls();
    *TEST_MODEL.lock().unwrap() =
        Some(Box::new(|_| crate::judge::cli::CliOutcome { result: Ok(r#"{"decision":"block","claim":"the cause is stated, not shown"}"#.into()), ms: 5 }));
    let l = golden::lay(&case);
    let in_dispatcher = golden::verdict_json(&golden::run_case("speculation-judge", &l, 1).expect("a shipped script"), &l);
    *TEST_MODEL.lock().unwrap() = None;
    assert_eq!(in_dispatcher["v"], "exact", "{in_dispatcher}");
    assert!(in_dispatcher["out"].as_str().unwrap_or_default().contains("speculation judge: your reply states an unchecked claim as fact"), "{in_dispatcher}");
}

// ---- v0.301 W3b: the Primary seat and the stable launchers ------------------------------------------------------------

/// A Primary checkout registers its seat on its first run in real DevSwarm, adopts it from a closed session, says nothing on its own
/// seat again, and the SessionStart check writes the two stable launchers (executable) before anything else.
#[test]
fn a_primary_session_registers_adopts_and_keeps_its_seat_and_the_launchers_are_installed() {
    let case = json!({
        "env": {"HOME": "{HOME}", "DEVSWARM_REPO_ID": "r1"}, "event": "SessionStart", "opts": {"plugin_root": "{PLUGIN}"},
        // a readable sessions directory that names no session: every other session counts as closed
        "files": {"wt/.git/HEAD": "ref: refs/heads/main\n", ".claude/sessions/other.json": "{\"sessionId\":\"unrelated\",\"pid\":1}"},
        "payload": {"hook_event_name": "SessionStart", "session_id": "new-session", "cwd": "{HOME}/wt"},
    });
    let run = |l: &golden::Laid| golden::verdict_json(&golden::run_case("devswarm-child-role", l, 1).expect("a shipped script"), l);
    // first run: nothing registered yet
    let l = golden::lay(&case);
    let first = run(&l);
    let out = first["out"].as_str().unwrap_or_default().to_string();
    assert!(out.contains("registered Primary primary-"), "{first} {:?}", crate::discard::captured());
    let home = Path::new(&l.home);
    let desc: Vec<_> = std::fs::read_dir(home.join(".anti-hall/devswarm/workspaces")).expect("workspaces dir").flatten().collect();
    assert_eq!(desc.len(), 1, "the Primary's descriptor is written");
    for launcher in ["devswarm.js", "wake-watch.js"] {
        assert!(!home.join(".anti-hall/bin").join(launcher).exists(), "{launcher}: the engine writes no launcher file");
    }
    // the same session again: its own seat, no notice
    let second = run(&l);
    assert!(!second["out"].as_str().unwrap_or_default().contains("devswarm-primary-seat"), "{second}");
    // a closed holder is replaced by this session
    let file = desc[0].path();
    let mut d: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    d["sessionId"] = json!("old-session");
    std::fs::write(&file, d.to_string()).unwrap();
    let adopted = run(&l);
    let text = adopted["out"].as_str().unwrap_or_default();
    assert!(text.contains("adopted Primary") && text.contains("old-session"), "{adopted}");
}

/// The count of site `site` under hand-back counter `kind` so far (this process's journal).
fn handbacks(kind: &str, site: &str) -> u64 {
    crate::obs::counters::snapshot()["node_handback"]["sites"][site][kind].as_u64().unwrap_or(0)
}

#[test]
fn unable_counts_a_stand_in_by_default_and_an_abandoned_decision_with_the_second_argument() {
    crate::discard::harmless(std::fs::create_dir_all(crate::paths::dir())); // keep: the scratch state dir of this test run
    let h = home("unable");
    let e = env(&h);
    // sites unique to this run: the journal of the scratch state directory outlives a run
    let tag = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.subsec_nanos());
    put_override(&h, "zz-unable", &format!("function decide(p) {{ ah.unable('z:s{tag}'); ah.unable('z:d{tag}', 'abandoned'); return 'allow'; }}"));
    let prefix = defaults::text("script.unable_prefix");
    let (stand, drop) = (format!("{prefix}z:s{tag}"), format!("{prefix}z:d{tag}"));
    let before = (handbacks("stand_in", &stand), handbacks("abandoned", &drop));
    assert_eq!(run_forced("zz-unable", &json!({}), &e), Some(Some(Verdict::Allow)));
    assert_eq!(handbacks("stand_in", &stand), before.0 + 1, "a case the script went on with is a stand-in");
    assert_eq!(handbacks("abandoned", &drop), before.1 + 1, "a dropped decision is abandoned");
    assert_eq!(handbacks("abandoned", &stand), 0, "and not the other way round");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// The hot spots of the live counters: with no usable home or plugin root no launcher can be named. The Stop gate and the
/// SessionStart role answer themselves (an allow, counted abandoned), never a deferral and never a block.
#[test]
fn the_parent_gate_and_the_child_role_decide_natively_when_no_launcher_can_be_named() {
    crate::discard::harmless(std::fs::create_dir_all(crate::paths::dir())); // keep: the scratch state dir of this test run
    let e = RequestEnv::from_pairs([("HOME", "relative-home")]);
    let p = json!({"session_id": "s1", "cwd": "/", "transcript_path": "/nonexistent/t.jsonl"});
    let prefix = defaults::text("script.unable_prefix");
    for (check, event, site) in [("devswarm-parent-gate", "Stop", "no_launchers"), ("devswarm-child-role", "SessionStart", "no_home_or_root")] {
        let full = format!("{prefix}{check}:{site}");
        let before = handbacks("abandoned", &full);
        let got = super::run_forced(check, &p, &Value::Null, event, &e);
        assert_eq!(got, Some(Some(Verdict::Allow)), "{check}: decided natively, no deferral and no block");
        assert_eq!(handbacks("abandoned", &full), before + 1, "{check}: the dropped decision is counted abandoned at {site}");
    }
}

/// GH #270 burn breaker: a subagent with a fresh hard-flag marker is blocked on every tool except SendMessage and a plain git commit,
/// push or status; the main session, a subagent without a marker and a stale marker are never blocked.
#[test]
fn burn_breaker_blocks_a_flagged_subagent_except_commit_push_status_and_its_report() {
    let h = home("burn-breaker");
    let e = env(&h);
    let dir = format!("{h}/.anti-hall/agent-tracker/breaker");
    std::fs::create_dir_all(&dir).unwrap();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    std::fs::write(format!("{dir}/a1.json"), json!({"ts": now, "tokens": 3_500_000u64, "agent": "a1"}).to_string()).unwrap();
    std::fs::write(format!("{dir}/old.json"), json!({"ts": 1u64, "tokens": 3_500_000u64, "agent": "old"}).to_string()).unwrap();
    let blocked = |p: Value| matches!(run_forced("burn-breaker", &p, &e), Some(Some(Verdict::Exact(x))) if x.code == 2);
    let bash = |c: &str| json!({"tool_name": "Bash", "agent_id": "a1", "tool_input": {"command": c}});
    assert!(blocked(json!({"tool_name": "Read", "agent_id": "a1", "tool_input": {"file_path": "/x"}})));
    assert!(blocked(bash("cargo test")));
    assert!(blocked(bash("git commit -m x; rm -rf y")));
    assert!(blocked(bash("git status | tee out")));
    assert!(blocked(bash("git commit -m \"$(rm -rf y)\"")));
    for bad in [
        "git commit -m x && rm -rf y",
        "npm test",
        "grep foo f | sh",
        "cat f > g",
        "rg --pre ./evil foo",
        "git diff --output=/tmp/o",
        "git -c core.pager=evil log",
        "ls $(rm -rf y)",
        "find . -exec rm {} +",
        "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
        "git commit -m \"a; b & c\"",
        "git commit -m 'x $HOME'",
        "git commit",
    ] {
        assert!(blocked(bash(bad)), "{bad}");
    }
    for tool in ["Write", "Edit", "Grep", "Agent"] {
        assert!(blocked(json!({"tool_name": tool, "agent_id": "a1", "tool_input": {"file_path": "/src/main.rs"}})), "{tool}");
    }
    for ok in [
        "git status",
        "git diff HEAD~1 | head -50",
        "git log --oneline -n 5",
        "grep -rn foo src/",
        "rg foo src | wc -l",
        "ls -la",
        "cat src/lib.rs | head -20",
        "cd /w && git add -A && git commit -m 'msg (a, b)' 2>&1",
    ] {
        assert!(!blocked(bash(ok)), "{ok}");
    }
    for ok in ["git commit -m \"a b\"", "git -C /w push origin v301/x", "git status --short", "git add -A"] {
        assert!(!blocked(bash(ok)), "{ok}");
    }
    assert!(!blocked(json!({"tool_name": "SendMessage", "agent_id": "a1", "tool_input": {"to": "main"}})), "the report goes through");
    assert!(!blocked(json!({"tool_name": "Read", "tool_input": {}})), "the main session is never blocked");
    assert!(!blocked(json!({"tool_name": "Read", "agent_id": "other", "tool_input": {}})), "no marker, no block");
    assert!(!blocked(json!({"tool_name": "Read", "agent_id": "old", "tool_input": {}})), "a stale marker is ignored");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// burn-breaker (GH #270), security review of PR #397: every string that once chained, wrote or ran another program while the breaker held is
/// blocked; the plain forms a worker needs (commit, add, status, diff, log, show, read-only tools, a `| head` tail, a report, a send) pass;
/// an oversized command is refused fast; and the breaker lifts only on a real commit.
#[test]
fn burn_breaker_blocks_every_reviewed_bypass_and_lifts_only_on_a_real_commit() {
    let h = home("burn-breaker-bypass");
    let e = env(&h);
    let dir = format!("{h}/.anti-hall/agent-tracker/breaker");
    std::fs::create_dir_all(&dir).unwrap();
    let marker = format!("{dir}/a1.json");
    let raise = || {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
        std::fs::write(&marker, json!({"ts": now, "tokens": 3_500_000u64, "agent": "a1"}).to_string()).unwrap();
    };
    let blocked = |c: &str| {
        raise();
        let p = json!({"tool_name": "Bash", "agent_id": "a1", "tool_input": {"command": c}});
        matches!(run_forced("burn-breaker", &p, &e), Some(Some(Verdict::Exact(x))) if x.code == 2)
    };
    let spaces = format!("touch x{}y", " ".repeat(40_000));
    let bypasses: Vec<String> = [
        "ls # \"$(cat <<'EOF'\ntouch /x\nEOF\n)\"",
        "git commit -m \"$(cat <<'EOF'\r\nEOF\r\n)\"\ntouch /x\nEOF\n)\"",
        "git commit -m \"$(cat <<'EOF'\nmsg\nEOF\n)\"",
        "rg '--pre=./evil' foo",
        "git diff '--output=/abs/f'",
        "ls \\'; touch /x; \\'",
        "git status \\'; touch /x; \\'",
        "git -c core.fsMonitor=./e status",
        "git -c core.hooksPath=/t commit -m x",
        "git -c core.sshCommand=./e push",
        "git -c credential.helper=!./e push",
        "git -c gpg.program=./e commit -S -m x",
        "git -c diff.external=./e diff",
        "git -C /w -c core.pager=./e log",
        "git push --exec=./e ../r",
        "git -c protocol.ext.allow=always push 'ext::sh -c touch% /x' HEAD",
        "git push 'ext::sh -c touch% /x' HEAD",
        "GIT_SSH_COMMAND=./e git push",
        "file -C -m out",
        "cat > /w/scratchpad/r.md <<'EOF'\r\nEOF\r\ntouch /x\nEOF",
        "echo # > /w/scratchpad/r.md <<'EOF'\ntouch /x\nEOF",
        "cat > /w/scratchpad/r.md <<'EOF'\nbody\nEOF",
        "echo hi > /w/scratchpad/../r.md",
        "tee /etc/x > /w/scratchpad/r.md",
        "DYLD_INSERT_LIBRARIES=/tmp/x.dylib ah-engine mesh send lead hi",
        "/tmp/ah-engine mesh send lead hi",
        "ah-engine mesh send lead hi; touch /x",
        "ah-engine mesh send lead hi # x",
        "ah-engine mesh send lead \"$(touch /x)\"",
        "git commit -m 'a\rb'",
        "git commit -m 'a`id`b'",
        "git commit -m 'a\\b'",
        "git commit -m \"a${HOME}b\"",
        "git commit -m 'x' ; touch /x",
        "git commit -F /w/msg.txt && touch /x",
        "git commit -F ../../x\u{0}y",
        "git commit -m 'unbalanced",
        "ls \"unbalanced",
        "cat <(touch /x)",
        "ls\u{e9}",
        "rm -rf a/target /Users/victim",
        "rm -rf /target ~",
        "rm -rf /target",
        "rm -rf a/target ~",
        "rm -rf a/target*",
        "rm -rf ../target",
        "git commit -m 'x' && rm -rf a/target ~",
        "cd /w && git -c core.pager=./e log",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([spaces.clone()])
    .collect();
    for bad in &bypasses {
        assert!(blocked(bad), "must be blocked: {:?}", &bad[..bad.len().min(120)]);
    }
    for ok in [
        "git commit -m 'x'",
        "git commit -m \"x y\"",
        "git commit -a -m 'fix(x): y (z) #12'",
        "git commit --allow-empty -m 'x'",
        "git commit -F notes/msg.txt",
        "git commit -F /w/scratchpad/msg.txt",
        "git -C /w commit -m 'x'",
        "git add -A",
        "git commit -m 'a' -m 'b'",
        "git commit -m 'fix -c thing'",
        "git log -c",
        "rm -rf a/target",
        "rm -rf /w/work/target/",
        "git status",
        "git diff",
        "git diff HEAD~1 | head",
        "git log --oneline -n 5",
        "git log --pretty=oneline",
        "git show HEAD",
        "grep -rn foo src/",
        "rg -n foo | head -5",
        "ls -la",
        "cat a.rs",
        "head -5 a.rs",
        "tail -n 5 a.rs",
        "wc -l a.rs",
        "echo 'done' > /w/scratchpad/r.md",
        "cat a.txt b.txt > /w/scratchpad/r.md",
        "ah-engine mesh send lead 'done; all good'",
        "ah-engine agents send lead done",
    ] {
        assert!(!blocked(ok), "must be allowed: {ok}");
    }
    // the length bound refuses 40,000 spaces fast
    raise();
    let t = std::time::Instant::now();
    assert!(blocked(&spaces));
    assert!(t.elapsed().as_millis() < 50, "oversized input took {:?}", t.elapsed());
    // lifts only on a real commit: reads, status and a refused commit leave the marker; a plain commit and a report write remove it
    for keep in ["git status", "git diff", "ls", "git commit -m \"a; b\"", "git commit -m 'x'; touch /x"] {
        raise();
        let p = json!({"tool_name": "Bash", "agent_id": "a1", "tool_input": {"command": keep}});
        let _ = run_forced("burn-breaker", &p, &e);
        assert!(std::path::Path::new(&marker).exists(), "{keep} must not lift the breaker");
    }
    for lift in ["git commit -m 'x'", "git commit -F notes/m.txt", "git add -A && git commit -m 'x'", "echo hi > /w/scratchpad/r.md"] {
        raise();
        let p = json!({"tool_name": "Bash", "agent_id": "a1", "tool_input": {"command": lift}});
        let _ = run_forced("burn-breaker", &p, &e);
        assert!(!std::path::Path::new(&marker).exists(), "{lift} must lift the breaker");
    }
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// GH #270 uncommitted-work guard: a subagent's edit is blocked once its worktree holds 300 uncommitted lines, and allowed again after a commit.
#[test]
fn uncommitted_guard_blocks_a_subagent_edit_past_the_line_and_a_commit_lifts_it() {
    let h = home("uncommitted");
    let e = env(&h);
    let repo = format!("{h}/repo");
    std::fs::create_dir_all(&repo).unwrap();
    let git = |args: &[&str]| {
        let ok =
            std::process::Command::new("git").args(["-C", &repo, "-c", "user.name=t", "-c", "user.email=t@t"]).args(args).output().unwrap().status.success();
        assert!(ok, "git {args:?}");
    };
    git(&["init", "-q"]);
    std::fs::write(format!("{repo}/a.txt"), "x\n").unwrap();
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "init"]);
    let edit = |agent: Option<&str>| {
        let mut p = json!({"tool_name": "Edit", "cwd": repo, "tool_input": {"file_path": "a.txt"}});
        if let Some(a) = agent {
            p["agent_id"] = json!(a);
        }
        run_forced("uncommitted-guard", &p, &e)
    };
    let blocked = |v: Option<Option<Verdict>>| matches!(v, Some(Some(Verdict::Exact(x))) if x.code == 2);
    assert!(!blocked(edit(Some("s1"))), "a clean worktree");
    std::fs::write(format!("{repo}/big.txt"), "line\n".repeat(400)).unwrap();
    assert!(!blocked(edit(Some("s1"))), "a count under the soft line is trusted for the cache TTL");
    std::fs::remove_dir_all(format!("{h}/.anti-hall/uncommitted")).unwrap();
    assert!(blocked(edit(Some("s1"))), "400 untracked lines");
    assert!(!blocked(edit(None)), "the main session is never judged");
    git(&["add", "-A"]);
    git(&["commit", "-q", "-m", "work"]);
    assert!(!blocked(edit(Some("s1"))), "a commit lifts the block at once");
    crate::discard::harmless(std::fs::remove_dir_all(&h)); // keep: cleanup
}

/// Direct thin-client events and doctor fixtures omit a root option, while the engine has already loaded its install.
#[test]
fn script_options_keep_explicit_roots_and_fall_back_to_the_loaded_install() {
    let h = home("script-root");
    let e = env(&h);
    let st = Settings::from_env(&e);
    let _ = defaults::text("script.ext");
    let installed = defaults::root().expect("loaded plugin root").to_string_lossy().into_owned();
    assert_eq!(super::script_options(&Value::Null, &st)["plugin_root"], installed);
    let opts = json!({"payload_sha1": "abc", "plugin_root": ""});
    let resolved = super::script_options(&opts, &st);
    assert_eq!(resolved["plugin_root"], installed);
    assert_eq!(resolved["payload_sha1"], "abc");
    let explicit = json!({"plugin_root": "/explicit", "payload_sha1": "abc"});
    let request = RequestEnv::from_pairs([("HOME", h.as_str()), ("AH_ENGINE_PLUGIN_ROOT", "/request")]);
    let request = Settings::from_env(&request);
    assert_eq!(super::script_options(&Value::Null, &request)["plugin_root"], "/request");
    assert_eq!(super::script_options(&explicit, &request), explicit);
    assert_eq!(super::script_options(&json!([1]), &st), json!([1]));
}

/// A registered child with no report must still be forced to heartbeat when a direct Stop has no root argument.
#[test]
fn a_direct_child_stop_without_a_root_option_still_requires_a_report() {
    let case = golden::lay(&json!({
        "env": {"HOME": "{HOME}", "DEVSWARM_REPO_ID": "r1", "DEVSWARM_SOURCE_BRANCH": "feat/x", "DEVSWARM_BUILDER_ID": "b-1", "DEVSWARM_AI_AGENT": "codex"},
        "event": "Stop", "opts": {"payload_sha1": "doctor-like"},
        "payload": {"hook_event_name": "Stop", "session_id": "direct-stop", "cwd": "{HOME}"},
        "files": {".anti-hall/devswarm/workspaces/b-1.json": "{}"}
    }));
    let got = golden::run_case("devswarm-child-gate", &case, 1).expect("a shipped gate");
    let Some(Verdict::Exact(out)) = got else { panic!("a child must report: {got:?}") };
    assert!(out.out.contains("workspace reporting or inbox duties are unfinished"), "{}", out.out);
    let details = std::fs::read_to_string(format!("{}/.anti-hall/block-details/devswarm-child-gate-direct-stop.md", case.home)).unwrap();
    assert!(details.contains("Heartbeat: before you stop") && details.contains("ah-engine mesh"), "{details}");
    assert!(!out.out.contains("devswarm.js"), "{}", out.out);
}

/// The parent's neglected-child gate also reaches its decision without a root argument (doctor and direct Stop forms).
#[test]
fn a_direct_parent_stop_without_a_root_option_still_blocks_neglect() {
    let case = golden::lay(&json!({
        "env": {"HOME": "{HOME}", "ANTIHALL_DEVSWARM_SUPERVISOR": "on", "DEVSWARM_AI_AGENT": "codex"},
        "event": "Stop", "opts": {"payload_sha1": "doctor-like"},
        "payload": {"hook_event_name": "Stop", "session_id": "direct-parent", "cwd": "{HOME}"},
        "files": {
            ".anti-hall/devswarm/workspaces/c-1.json": "{\"id\":\"c-1\",\"worktreePath\":\"{HOME}/wt/c-1\",\"sessionId\":\"sess-c1\",\"inboxPath\":\"{HOME}/in.ndjson\",\"cursorPath\":\"{HOME}/cursor.json\"}",
            "in.ndjson": "{\"message\":\"handle this\",\"ts\":1}\n", "cursor.json": "0"
        }
    }));
    let got = golden::run_case("devswarm-parent-gate", &case, 1).expect("a shipped gate");
    let Some(Verdict::Exact(out)) = got else { panic!("neglect must block: {got:?}") };
    let answer: Value = serde_json::from_str(&out.out).expect("Stop decision JSON");
    assert_eq!(answer["decision"], "block");
    let details = std::fs::read_to_string(format!("{}/.anti-hall/block-details/devswarm-parent-gate-session.md", case.home)).unwrap();
    assert!(details.contains("c-1"), "{details}");
}

/// One row of a parent-gate fixture: who sent it and how it reached the store.
#[derive(Clone, Copy)]
enum PgRow {
    /// A `mesh send` from a child (`mtype` direct), with `needsReply`.
    Child(&'static str),
    /// A `mesh send` from the Primary itself to its own partition.
    Own(&'static str),
    /// A native-ingested row (no `mtype`), as DevSwarm's `reactivate-child` prompt reaches the store.
    Native(&'static str),
}

/// Drive the shipped parent gate script with the shipped defaults over one fixture: the Primary's partition holds `rows`, this hook's
/// own reader row sits at `own_row` (`None`: no own row, only the `#floor` row at `floor`), and the summary names `raw` unread at
/// `cursor`. `shared` sets devswarm.parentGateSharedCount. `Some(n)`: the gate blocked naming n unread; `None`: it allowed.
fn pg_fixture(tag: &str, shared: bool, rows: &[PgRow], own_row: Option<i64>, floor: i64, raw: u32, cursor: u32) -> Option<String> {
    use crate::meshw::ident;
    use crate::meshw::store::{CursorPut, MeshStore, RegistryRow, mesh_message_row};
    let case = golden::lay(&json!({
        "env": {"HOME": "{HOME}", "ANTIHALL_DEVSWARM_SUPERVISOR": "on", "DEVSWARM_AI_AGENT": "codex",
                "ANTIHALL_DEVSWARM_PARENT_GATE_SHARED_COUNT": if shared { "true" } else { "false" }},
        "event": "Stop", "opts": {"payload_sha1": format!("gate-{tag}")},
        "payload": {"hook_event_name": "Stop", "session_id": format!("gate-{tag}"), "cwd": "{HOME}/repo"},
        "files": {}
    }));
    let repo = format!("{}/repo", case.home);
    std::fs::create_dir_all(&repo).unwrap();
    assert!(std::process::Command::new("git").args(["init", "-q", &repo]).status().unwrap().success());
    let ctx = ident::resolve_context(&repo, true).expect("a git work tree resolves");
    let top = ctx.worktree_root.clone().expect("a work tree root");
    let key = ctx.repo_key.clone().expect("a project key");
    let own = ident::primary_workspace_id(&top).unwrap();
    let dir = crate::meshw::union::store_dir(Path::new(&case.home), &key);
    std::fs::create_dir_all(&dir).unwrap();
    let w = MeshStore::open(&dir.join(defaults::text("mesh_write.store_file"))).unwrap();
    let reg = RegistryRow {
        id: own.clone(),
        worktree_path: Some(top.clone()),
        session_id: Some("s-p".into()),
        inbox_path: None,
        cursor_path: None,
        nudge_command: None,
    };
    assert!(w.upsert_registry(&reg, 1, |_, _| true).unwrap());
    for (i, r) in rows.iter().enumerate() {
        let (ts, h) = (10 + i as i64, format!("h-{i}"));
        match *r {
            PgRow::Child(b) => {
                assert!(w.append_mesh_row(&mesh_message_row(Some("child-a"), Some(&own), false, b, ts, "normal", &h, true, None)).unwrap().inserted)
            }
            PgRow::Own(b) => assert!(w.append_mesh_row(&mesh_message_row(Some(&own), Some(&own), false, b, ts, "normal", &h, false, None)).unwrap().inserted),
            PgRow::Native(b) => assert!(w.append_message_from(&own, ts, Some(&h), b, Some(&own)).unwrap()),
        }
    }
    // a hook runs under a harness process: this test process stands in for it (a session record names its pid), so the gate has a reader key
    let sess = Path::new(&case.home).join(defaults::text("mesh_write.claude_dir")).join(defaults::text("mesh_write.sessions_dir"));
    std::fs::create_dir_all(&sess).unwrap();
    let pid = std::process::id();
    std::fs::write(sess.join(format!("{pid}{}", defaults::text("mesh_write.json_suffix"))), json!({"pid": pid, "startedAt": 1}).to_string()).unwrap();
    let ns = defaults::text("mesh_write.cursor_ns_store").to_string();
    let mut puts = vec![CursorPut {
        partition: own.clone(),
        ns: ns.clone(),
        reader: defaults::text("mesh_write.floor_reader").to_string(),
        value: floor,
        retired_line: None,
        updated_at: 1,
    }];
    if let Some(v) = own_row {
        let st = crate::checks::git::util::Settings { home: case.home.clone(), env: std::collections::HashMap::new() };
        let reader = super::host_mesh::own_reader_key(&st).expect("the hook's own reader key");
        puts.push(CursorPut { partition: own.clone(), ns, reader, value: v, retired_line: None, updated_at: 1 });
    }
    w.reader_cursor_txn(&puts).unwrap();
    let total = rows.len();
    let sum = json!({"workspaces": {own.clone(): {"id": own, "worktreePath": top, "unread": raw, "cursor": cursor, "total": total}}}).to_string();
    let sum_path = format!("{}/.anti-hall/devswarm/summaries/{key}.json", case.home);
    std::fs::create_dir_all(Path::new(&sum_path).parent().unwrap()).unwrap();
    std::fs::write(&sum_path, sum).unwrap();
    let got = golden::run_case("devswarm-parent-gate", &case, 1).expect("a shipped gate");
    let details = std::fs::read_to_string(format!("{}/.anti-hall/block-details/devswarm-parent-gate-session.md", case.home)).unwrap_or_default();
    match got {
        Some(Verdict::Allow) => None,
        Some(Verdict::Exact(out)) => {
            let answer: Value = serde_json::from_str(&out.out).expect("Stop decision JSON");
            assert_eq!(answer["decision"], "block", "{tag}: {}", out.out);
            let n = details.split(" unread").next().and_then(|h| h.rsplit(|c: char| !c.is_ascii_digit()).next()).unwrap_or("?").to_string();
            Some(n)
        }
        other => panic!("{tag}: unexpected verdict {other:?} {details}"),
    }
}

/// GH #384 / PR #428: the parent gate's own-mailbox count, driven through the shipped gate script with the shipped defaults, for each
/// fixture with devswarm.parentGateSharedCount on and off. Off must give what the base (`max(countFor, messageCount - own)`) gives.
#[test]
fn the_parent_gate_counts_the_shared_peek_count_when_on_and_the_old_projection_when_off() {
    use PgRow::*;
    let esc = defaults::text("devswarm_role.pg_escalation");
    let (peek, defect) = (esc.find("peek-primary"), esc.find("defect"));
    assert!(peek.is_some() && defect.is_some() && peek < defect, "the escalation names the peek-primary step, then defect: {esc}");
    let six = [Child("c0"), Child("c1"), Child("c2"), Child("c3"), Child("c4"), Child("c5")];
    let own_after = [&six[..], &[Own("mine 1"), Own("mine 2")]].concat();
    let wake = "anti-hall wake: a mesh message is waiting for workspace x.";
    // (tag, rows, own row, floor, summary raw, summary cursor, expected ON, expected OFF = base)
    type Case = (&'static str, Vec<PgRow>, Option<i64>, i64, u32, u32, Option<&'static str>, Option<&'static str>);
    let cases: Vec<Case> = vec![
        ("own-sends-past-cursor", own_after.clone(), Some(6), 6, 2, 6, None, Some("2")),
        ("own-sends-only", vec![Own("mine")], Some(0), 0, 1, 0, None, Some("1")),
        ("child-unread", vec![Child("please review")], Some(0), 0, 1, 0, Some("1"), Some("1")),
        ("child-wake-prefix", vec![Child("anti-hall wake: resolve conflict?")], Some(0), 0, 1, 0, Some("1"), Some("1")),
        // GH #429: the poke prefix is not provenance; a child's mesh send that starts with it is mail, the native-ingested poke is not
        ("child-poke-prefix", vec![Child("[Primary poke] resolve conflict?")], Some(0), 0, 1, 0, Some("1"), Some("1")),
        ("native-poke", vec![Native("[Primary poke] nudge")], Some(0), 0, 1, 0, None, Some("1")),
        ("native-wake", vec![Native(wake)], Some(0), 0, 1, 0, None, Some("1")),
        ("no-own-row", own_after.clone(), None, 6, 2, 6, None, Some("2")),
        // an impossible floor (past the message count) is unknown, never a confirmed zero: the cached count stands
        ("floor-past-total", vec![Child("please review")], None, 20, 1, 0, Some("1"), Some("1")),
        ("floor-equals-total", vec![Child("please review")], None, 1, 1, 0, None, Some("1")),
        ("floor-below-total", vec![Child("q1"), Child("q2")], None, 1, 1, 0, Some("1"), Some("1")),
    ];
    let mut table = Vec::new();
    for (tag, rows, own_row, floor, raw, cursor, on, off) in &cases {
        let got_on = pg_fixture(&format!("{tag}-on"), true, rows, *own_row, *floor, *raw, *cursor);
        let got_off = pg_fixture(&format!("{tag}-off"), false, rows, *own_row, *floor, *raw, *cursor);
        table.push(format!("{tag}: on={got_on:?} (want {on:?}) off={got_off:?} (want {off:?})"));
        assert_eq!((got_on.as_deref(), got_off.as_deref()), (*on, *off), "{}", table.join("\n"));
    }
    eprintln!("parent-gate fixtures:\n{}", table.join("\n"));
}

// ---- claim-evidence-guard (GH #313): a claim needs a tool call of this turn; pushed is not done ----

mod claim_evidence_guard {
    use super::*;

    fn assistant(id: &str, text: &str, cmds: &[&str]) -> Value {
        let mut blocks: Vec<Value> =
            cmds.iter().enumerate().map(|(i, c)| json!({"type": "tool_use", "id": format!("u{id}{i}"), "name": "Bash", "input": {"command": c}})).collect();
        blocks.push(json!({"type": "text", "text": text}));
        json!({"type": "assistant", "message": {"id": id, "role": "assistant", "content": blocks}})
    }

    fn result(text: &str) -> Value {
        json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "x", "content": text}]}})
    }

    /// One Stop of a fresh session: the transcript is `lines`, the reply is `reply`. Returns the verdict and the home.
    fn stop(tag: &str, lines: &[Value], reply: &str, extra: &[(&str, &str)], payload_extra: Value) -> (Option<Option<Verdict>>, String) {
        let _shared = COUNTS.read().unwrap_or_else(|e| e.into_inner());
        stop_unlocked(tag, lines, reply, extra, payload_extra)
    }

    /// Every Stop counts into the process-wide metric table; the counter test holds the write side so nothing else counts meanwhile.
    /// The afk-mode tests drain that same table, so they hold the write side too.
    pub(super) static COUNTS: std::sync::RwLock<()> = std::sync::RwLock::new(());

    fn stop_unlocked(tag: &str, lines: &[Value], reply: &str, extra: &[(&str, &str)], payload_extra: Value) -> (Option<Option<Verdict>>, String) {
        let h = home(tag);
        let t = format!("{h}/t.jsonl");
        let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
        std::fs::write(&t, body).unwrap();
        let mut pairs = vec![("HOME".to_string(), h.clone())];
        pairs.extend(extra.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let mut payload = json!({"transcript_path": t, "session_id": tag, "cwd": h, "last_assistant_message": reply});
        for (k, v) in payload_extra.as_object().cloned().unwrap_or_default() {
            payload[k] = v;
        }
        (super::super::run_forced("claim-evidence-guard", &payload, &Value::Null, "Stop", &RequestEnv::from_pairs(pairs)), h)
    }

    fn blocked(v: &Option<Option<Verdict>>) -> Option<String> {
        match v {
            Some(Some(Verdict::Exact(x))) if x.code == 0 && x.out.contains("\"decision\":\"block\"") => Some(x.out.clone()),
            _ => None,
        }
    }

    const ALLOW: Option<Option<Verdict>> = Some(Some(Verdict::Allow));

    #[test]
    fn a_result_claim_with_no_tool_call_this_turn_is_held_once_and_the_message_is_short() {
        let reply = "All tests pass and the change is done.";
        let lines = [json!({"type": "user", "message": {"role": "user", "content": "go"}}), assistant("m1", reply, &[])];
        let (v, h) = stop("ce-claim-none", &lines, reply, &[], json!({}));
        let out = blocked(&v).unwrap_or_else(|| panic!("held: {v:?}"));
        let reason = serde_json::from_str::<Value>(out.trim()).unwrap()["reason"].as_str().unwrap().to_string();
        assert!(reason.lines().count() <= 2 && reason.contains("no matching check"), "{reason}");
        // the same reply again is not held twice
        let t = format!("{h}/t.jsonl");
        let p = json!({"transcript_path": t, "session_id": "ce-claim-none", "cwd": h, "last_assistant_message": reply});
        let again = super::super::run_forced("claim-evidence-guard", &p, &Value::Null, "Stop", &env(&h));
        assert_eq!(again, ALLOW, "{again:?}");
    }

    #[test]
    fn a_test_claim_backed_by_a_runner_this_turn_passes_and_one_backed_by_an_unrelated_command_is_held() {
        let reply = "All tests pass.";
        let ok = [
            json!({"type": "user", "message": {"role": "user", "content": "go"}}),
            assistant("m1", "", &["cargo test -j4 --lib x"]),
            result("test result: ok. 3 passed"),
            assistant("m2", reply, &[]),
        ];
        assert_eq!(stop("ce-claim-ran", &ok, reply, &[], json!({})).0, ALLOW);
        let bad = [
            json!({"type": "user", "message": {"role": "user", "content": "go"}}),
            assistant("m1", "", &["ls -la"]),
            result("total 0"),
            assistant("m2", reply, &[]),
        ];
        assert!(blocked(&stop("ce-claim-ls", &bad, reply, &[], json!({})).0).is_some());
        // a runner from an EARLIER turn does not back a claim of this one
        let older = [
            json!({"type": "user", "message": {"role": "user", "content": "first"}}),
            assistant("m1", "", &["cargo test"]),
            result("ok"),
            assistant("m2", "done", &[]),
            json!({"type": "user", "message": {"role": "user", "content": "second"}}),
            assistant("m3", "", &["ls"]),
            result("a"),
            assistant("m4", reply, &[]),
        ];
        assert!(blocked(&stop("ce-claim-old", &older, reply, &[], json!({})).0).is_some());
    }

    #[test]
    fn an_honest_reply_a_plain_reply_a_quote_a_subagent_a_codex_payload_and_a_stop_retry_are_never_held() {
        let t = |reply: &str, extra: Value| {
            let lines = [json!({"type": "user", "message": {"role": "user", "content": "go"}}), assistant("m1", reply, &[])];
            stop("ce-honest", &lines, reply, &[], extra).0
        };
        assert_eq!(t("Tests pass (unverified).", json!({})), ALLOW);
        // a label that closes the sentence as its own clause covers the claims before it (claim_evidence.trailing_label_re)
        assert_eq!(t("Tests pass in my head but I did not run them; unverified.", json!({})), ALLOW);
        // any other label covers only a claim within claim_evidence.reach_label words of it: a second clause between them ends its reach
        assert!(blocked(&t("Tests pass in my head but I did not run the linter.", json!({}))).is_some());
        // a claim in bare quotes is a claim: quote marks alone cover nothing (claim_evidence.quote_mark_re)
        assert!(blocked(&t("CI is \"green\".", json!({}))).is_some());
        assert_eq!(t("The rename is in; nothing was run.", json!({})), ALLOW);
        assert_eq!(t("The old line said \"all tests pass\" and was wrong.", json!({})), ALLOW);
        assert_eq!(t("All tests pass.", json!({"agent_id": "a1", "agent_type": "worker"})), ALLOW);
        assert_eq!(t("All tests pass.", json!({"turn_id": "t1", "model": "gpt"})), ALLOW);
        assert_eq!(t("All tests pass.", json!({"stop_hook_active": true})), ALLOW);
    }

    #[test]
    fn pushed_then_called_done_without_a_look_at_ci_is_held_and_a_look_or_an_honest_state_passes() {
        let reply = "Done, it is all in.";
        let mk = |cmds: &[&str], text: &str| {
            let mut v = vec![json!({"type": "user", "message": {"role": "user", "content": "go"}})];
            for (i, c) in cmds.iter().enumerate() {
                v.push(assistant(&format!("a{i}"), "", &[c]));
                v.push(result("ok"));
            }
            v.push(assistant("z", text, &[]));
            v
        };
        let held = stop("ce-push-held", &mk(&["git commit -m x", "git push origin feat"], reply), reply, &[], json!({})).0;
        let out = blocked(&held).unwrap_or_else(|| panic!("held: {held:?}"));
        assert!(out.contains("CI and merge state"), "{out}");
        assert_eq!(stop("ce-push-looked", &mk(&["git push", "gh run list --limit 3"], reply), reply, &[], json!({})).0, ALLOW);
        // a look BEFORE the push does not count
        assert!(blocked(&stop("ce-push-before", &mk(&["gh run list", "git push"], reply), reply, &[], json!({})).0).is_some());
        let honest = "Pushed and the PR is open; CI is pending, nothing merged. Done on my side.";
        assert_eq!(stop("ce-push-honest", &mk(&["git push"], honest), honest, &[], json!({})).0, ALLOW);
        // no push this turn: nothing to check
        assert_eq!(stop("ce-push-none", &mk(&["ls"], reply), reply, &[], json!({})).0, ALLOW);
    }

    #[test]
    fn each_rule_has_its_own_switch_and_log_mode_never_blocks() {
        let push = "Done.";
        let lines = |cmds: &[&str], text: &str| {
            let mut v = vec![json!({"type": "user", "message": {"role": "user", "content": "go"}})];
            for (i, c) in cmds.iter().enumerate() {
                v.push(assistant(&format!("a{i}"), "", &[c]));
                v.push(result("ok"));
            }
            v.push(assistant("z", text, &[]));
            v
        };
        assert_eq!(stop("ce-sw2", &lines(&["git push"], push), push, &[("ANTIHALL_PUSHED_NOT_DONE", "false")], json!({})).0, ALLOW);
        assert!(blocked(&stop("ce-sw2-on", &lines(&["git push"], push), push, &[("ANTIHALL_CLAIM_EVIDENCE", "false")], json!({})).0).is_some());
        let claim = "All tests pass.";
        assert_eq!(stop("ce-sw1", &lines(&[], claim), claim, &[("ANTIHALL_CLAIM_EVIDENCE", "false")], json!({})).0, ALLOW);
    }

    /// A reply with no tool call at all: Some(held) when the guard blocks it.
    fn bare(tag: &str, reply: &str) -> bool {
        let lines = [json!({"type": "user", "message": {"role": "user", "content": "go"}}), assistant("m1", reply, &[])];
        blocked(&stop(tag, &lines, reply, &[], json!({})).0).is_some()
    }

    #[test]
    fn a_negated_claim_is_not_held_but_an_affirmative_one_beside_it_still_is() {
        for (i, r) in [
            "Nothing is merged this turn.",
            "PR #12 is not merged yet.",
            "The release was never deployed to prod.",
            "No, it is not fixed.",
            "Tests are not passing on main.",
        ]
        .iter()
        .enumerate()
        {
            assert!(!bare(&format!("ce-neg{i}"), r), "must allow: {r}");
        }
        assert!(bare("ce-neg-mixed", "Nothing is deployed to staging. PR #12 is merged."), "the affirmative sentence still holds");
        assert!(bare("ce-neg-far", "Not a big change, and PR #12 is merged."), "a negation in another clause does not excuse it");
    }

    #[test]
    fn a_future_or_conditional_claim_is_not_held() {
        for (i, r) in [
            "Once #373 and #374 are merged, I will rebase.",
            "After it is merged the docs go out.",
            "It will be merged when review ends.",
            "The fix needs to be verified before release.",
            "Waiting until the PR is merged.",
        ]
        .iter()
        .enumerate()
        {
            assert!(!bare(&format!("ce-fut{i}"), r), "must allow: {r}");
        }
        assert!(bare("ce-fut-after", "After the fix, all tests pass."), "a time word in an earlier clause does not excuse a claim");
        assert!(bare("ce-fut-past", "The change is deployed."));
        // a claim right after a claim the opener covered is its consequent (suppress chain, reach_consequent) ...
        assert!(!bare("ce-fut-second", "If CI is green the change is merged by the bot."));
        // ... but an opener whose own clause holds no claim covers nothing past its second predicate, and an idiom opener nothing at all
        assert!(bare("ce-fut-wait", "If we wait for review the change is merged."));
        assert!(bare("ce-fut-idiom", "Once again CI is green."));
        assert!(bare("ce-fut-idiom2", "Once again CI is green the change is merged."));
    }

    #[test]
    fn a_claim_reported_from_someone_elses_text_is_not_held() {
        for (i, r) in ["The bot reported that all tests pass.", "The PR body says the change is merged.", "The old comment said it is fixed and was wrong."]
            .iter()
            .enumerate()
        {
            assert!(!bare(&format!("ce-rep{i}"), r), "must allow: {r}");
        }
        // 'according to' opens the claim's clause only with a named source (reported_res); 'according to plan' names none
        assert!(!bare("ce-rep-pp", "According to the PR body the change is merged."));
        assert!(bare("ce-rep-plan", "According to plan the service is live."));
    }

    #[test]
    fn live_false_positives_are_allowed_and_genuine_claims_beside_them_are_still_held() {
        let mut wrongly_held: Vec<&str> = Vec::new();
        for (i, r) in [
            // (a) a future condition on CI
            "I'll merge once CI is green.",
            "Merge only if CI is green.",
            "I will merge it as soon as the build is green, then clean up.",
            // (b) a criterion inside a rule
            "SAFE-TO-REMOVE requires that the branch is merged or fully pushed.",
            "A clone is safe to remove only when its work is merged or fully pushed.",
            // (c) the word, not a claim
            "Understood. That is your explicit go-ahead, so I treat it as confirmed permission.",
            "The word 'verified' in that description is a label, and the word \"confirmed\" is too.",
            // (d) a negated claim
            "I haven't verified any of this.",
            "I haven\u{2019}t verified or confirmed any of this.",
            "None of this is verified yet.",
            // (e) pending / not confirmed
            "Waiting on tests-passed from the runner.",
            "CI is not confirmed green.",
            "Still waiting on CI to be green before the merge.",
        ]
        .iter()
        .enumerate()
        {
            if bare(&format!("ce-live{i}"), r) {
                wrongly_held.push(*r);
            }
        }
        assert!(wrongly_held.is_empty(), "must allow: {wrongly_held:#?}");
        for (i, r) in [
            "PR #405 is merged.",
            "All tests pass.",
            "CI is green.",
            "I verified the fix.",
            "Confirmed: the fix works.",
            "It is verified and deployed to prod.",
            "I'll merge once CI is green. PR #405 is merged.",
        ]
        .iter()
        .enumerate()
        {
            assert!(bare(&format!("ce-genuine{i}"), r), "must hold: {r}");
        }
    }

    #[test]
    fn a_genuine_claim_that_only_borrows_a_criterion_or_label_word_is_still_held() {
        for (i, r) in [
            "All required tests pass.",
            "Required changes are merged.",
            "The criteria are met and PR #405 is merged.",
            "It is safe to remove because PR #405 is merged.",
            "The criteria require that PR #405 is merged; PR #406 is merged.",
            "Confirmed successful deployment.",
            "Personally verified every endpoint.",
            "Verified production works.",
        ]
        .iter()
        .enumerate()
        {
            assert!(bare(&format!("ce-borrow{i}"), r), "must hold: {r}");
        }
        for (i, r) in ["The criteria require that PR #405 is merged.", "Safe to remove only when PR #405 is merged."].iter().enumerate() {
            assert!(!bare(&format!("ce-crit{i}"), r), "must allow: {r}");
        }
    }

    #[test]
    fn a_requirement_does_not_reach_a_claim_that_follows_a_causal_or_temporal_connector() {
        for (i, r) in [
            "We must hurry because PR #405 is merged.",
            "We must celebrate because CI is green.",
            "We must stop waiting because the suite is passing.",
            "We must hurry now that PR #405 is merged.",
            "The criterion requires that records be retained since PR #405 is merged.",
            "The criterion requires that checks be documented because CI is green.",
            "We must ship today as CI is green.",
            "We must move on since all tests pass.",
            "We must note that PR #405 is merged.",
            "The policy requires that we ship so PR #405 is merged.",
            "The service is live.",
            "The criteria require review given that PR #405 is merged.",
        ]
        .iter()
        .enumerate()
        {
            assert!(bare(&format!("ce-cause{i}"), r), "must hold: {r}");
        }
        for (i, r) in [
            "The checklist requires that CI is green.",
            "Each clone must be merged into main.",
            "The rule requires that all tests pass.",
            "Ready once a NAS that has it is deployed.",
            "The release is not live yet.",
            "The report said \"the service is live\" but I have not checked.",
            "The criteria require that PR #405 is merged.",
            "Safe to remove only when PR #405 is merged.",
        ]
        .iter()
        .enumerate()
        {
            assert!(!bare(&format!("ce-req{i}"), r), "must allow: {r}");
        }
    }

    /// The regression corpus (tests/fixtures/claim_evidence_corpus.ndjson): every row {text, expect: block|allow, source} must get its
    /// expected verdict. A suppressor covers a claim only when it is local to it (claim_evidence.suppress reach).
    #[test]
    fn every_row_of_the_claim_corpus_gets_its_expected_verdict() {
        let corpus = std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claim_evidence_corpus.ndjson"))
            .expect("the corpus file is readable");
        let mut wrong: Vec<String> = Vec::new();
        let mut n = 0;
        for (i, line) in corpus.lines().filter(|l| !l.trim().is_empty()).enumerate() {
            let row: Value = serde_json::from_str(line).unwrap();
            let (text, expect) = (row["text"].as_str().unwrap(), row["expect"].as_str().unwrap());
            assert!(matches!(expect, "block" | "allow"), "row {i}: expect must be block or allow");
            let held = bare(&format!("ce-corpus{i}"), text);
            if held != (expect == "block") {
                wrong.push(format!("{expect} <- {} ({}): {text}", if held { "block" } else { "allow" }, row["source"]));
            }
            n += 1;
        }
        assert!(n >= 80, "the corpus is read ({n} rows)");
        assert!(wrong.is_empty(), "corpus rows with the wrong verdict: {wrong:#?}");
    }

    #[test]
    fn the_guard_counts_what_it_holds_and_what_it_lets_pass_and_the_switch_turns_it_off() {
        let _excl = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let count = |name: &str, labels: &[(&str, &str)]| {
            let mut m = crate::metrics::Metrics::default();
            crate::metrics::drain_pending(&mut m);
            m.counter(name, labels)
        };
        let lines = |r: &str| [json!({"type": "user", "message": {"role": "user", "content": "go"}}), assistant("m1", r, &[])];
        crate::metrics::drain_pending(&mut crate::metrics::Metrics::default());
        let r = "The criteria require that PR #405 is merged.";
        let (v, _) = stop_unlocked("ce-cnt-sup", &lines(r), r, &[], json!({}));
        assert!(blocked(&v).is_none());
        assert_eq!(count("claim_evidence_suppressed", &[("reason", "criterion")]), 1, "a suppressed hit is counted with its reason");
        let r = "We must hurry because PR #405 is merged.";
        let (v, _) = stop_unlocked("ce-cnt-fire", &lines(r), r, &[], json!({}));
        assert!(blocked(&v).is_some());
        assert_eq!(count("claim_evidence_fired", &[("rule", "claim")]), 1, "a held reply is counted with its rule");
        crate::metrics::drain_pending(&mut crate::metrics::Metrics::default());
        let (v, _) = stop_unlocked("ce-cnt-off", &lines(r), r, &[("ANTIHALL_CLAIM_EVIDENCE_TELEMETRY", "0")], json!({}));
        assert!(blocked(&v).is_some(), "the switch never changes the decision");
        assert_eq!(count("claim_evidence_fired", &[("rule", "claim")]), 0, "off: nothing is counted");
    }

    /// GH #427: the strict suppressor checks hold a bare claim, count each refused suppressor, and `guards.claimEvidenceStrict` off restores the old reading.
    #[test]
    fn the_strict_switch_holds_the_leaks_counts_the_refusals_and_off_restores_the_old_reading() {
        let _excl = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let count = |reason: &str| {
            let mut m = crate::metrics::Metrics::default();
            crate::metrics::drain_pending(&mut m);
            m.counter("claim_evidence_suppressor_rejected", &[("reason", reason)])
        };
        let lines = |r: &str| [json!({"type": "user", "message": {"role": "user", "content": "go"}}), assistant("m1", r, &[])];
        crate::metrics::drain_pending(&mut crate::metrics::Metrics::default());
        for (i, (r, reason)) in [
            ("If true CI is green.", "filler_opener"),
            ("According to the doc-string CI is green.", "source_compound"),
            ("According to the reports CI is green.", "source_noun"),
            ("CI is green; not unverified.", "label_not_a_label"),
        ]
        .iter()
        .enumerate()
        {
            let (v, _) = stop_unlocked(&format!("ce-strict{i}"), &lines(r), r, &[], json!({}));
            assert!(blocked(&v).is_some(), "must hold: {r}");
            assert!(count(reason) >= 1, "{r}: refusal counted as {reason}");
            crate::metrics::drain_pending(&mut crate::metrics::Metrics::default());
            let (v, _) = stop_unlocked(&format!("ce-strict-off{i}"), &lines(r), r, &[("ANTIHALL_CLAIM_EVIDENCE_STRICT", "0")], json!({}));
            assert!(blocked(&v).is_none(), "switch off restores the old reading: {r}");
            assert_eq!(count(reason), 0, "off: nothing is refused or counted");
        }
    }

    #[test]
    fn a_claim_backed_by_an_api_call_or_another_runner_of_this_turn_passes_and_a_bare_one_is_held() {
        let mk = |cmd: &str, reply: &str| {
            vec![
                json!({"type": "user", "message": {"role": "user", "content": "go"}}),
                assistant("m1", "", &[cmd]),
                result("{\"merged\": true, \"state\": \"closed\"}"),
                assistant("m2", reply, &[]),
            ]
        };
        let r = "PR #12 is merged.";
        assert_eq!(stop("ce-ev-curl", &mk("curl -s https://api.example.test/repos/o/r/pulls/12", r), r, &[], json!({})).0, ALLOW);
        assert_eq!(stop("ce-ev-git", &mk("git log origin/main --oneline -3", r), r, &[], json!({})).0, ALLOW);
        let t = "11 passed.";
        assert_eq!(stop("ce-ev-dotnet", &mk("dotnet test", t), t, &[], json!({})).0, ALLOW);
        assert!(blocked(&stop("ce-ev-ls", &mk("ls -la", r), r, &[], json!({})).0).is_some(), "an unrelated command does not back it");
        assert!(bare("ce-ev-bare-merged", "PR #12 is merged."));
        assert!(bare("ce-ev-bare-passed", "11 passed."));
    }

    #[test]
    fn a_stop_with_no_claim_stays_inside_the_stop_latency_bar() {
        let reply = "Renamed the function and updated its two callers.";
        let lines = [json!({"type": "user", "message": {"role": "user", "content": "go"}}), assistant("m1", reply, &["sed -i x y"])];
        // the shared side is taken before the clock starts: time spent waiting for a counting test is not the Stop's latency
        let _shared = COUNTS.read().unwrap_or_else(|e| e.into_inner());
        let _ = stop_unlocked("ce-lat-warm", &lines, reply, &[], json!({}));
        let started = std::time::Instant::now();
        let (v, _) = stop_unlocked("ce-lat", &lines, reply, &[], json!({}));
        assert_eq!(v, ALLOW);
        assert!(started.elapsed() < std::time::Duration::from_millis(20), "{:?}", started.elapsed());
    }
}

/// The prompt key of the task guard: the uuid of the newest real user entry (not a tool result), read newest-first from a capped fetch,
/// whole-tail fetch when the cap holds none. It must equal what a scan of every user line gives, and the capped fetch must be small.
#[test]
fn tail_lines_newest_gives_the_prompt_key_a_full_scan_gives() {
    fn key(lines: &[String]) -> String {
        for l in lines {
            let v: Value = serde_json::from_str(l.trim()).unwrap();
            if v["isMeta"] == json!(true) || v["isSidechain"] == json!(true) {
                continue;
            }
            let real = match &v["message"]["content"] {
                Value::String(s) => !s.trim().is_empty(),
                Value::Array(a) => a.iter().any(|b| b["type"] != json!("tool_result")),
                _ => false,
            };
            if real {
                return v["uuid"].as_str().unwrap_or_default().to_string();
            }
        }
        String::new()
    }
    let user = |i: usize, c: &str| format!(r#"{{"type":"user","uuid":"u{i}","message":{{"content":{c}}}}}"#);
    let res = |i: usize| user(i, r#"[{"type":"tool_result","content":"ok"}]"#);
    let asst = |i: usize| format!(r#"{{"type":"assistant","uuid":"a{i}","message":{{"content":[{{"type":"text","text":"{}"}}]}}}}"#, "x".repeat(200));
    for tail_results in [0usize, 1, 5, 40] {
        let mut lines = vec![user(0, r#""first prompt""#), user(1, r#""second prompt""#)];
        for i in 2..600 {
            lines.push(if i % 3 == 0 { asst(i) } else { res(i) });
        }
        lines.push(user(900, r#""the real newest prompt""#));
        for i in 0..tail_results {
            lines.push(res(1000 + i));
            lines.push(asst(1000 + i));
        }
        let h = home(&format!("newest-{tail_results}"));
        let p = format!("{h}/t.jsonl");
        std::fs::write(&p, lines.join("\n") + "\n").unwrap();
        let needle = vec![r#""user""#.to_string()];
        let mut old = super::host_b3::tail_lines_matching(&p, 1 << 20, false, &needle).unwrap();
        old.reverse();
        let want = key(&old);
        assert_eq!(want, "u900");
        for max in [1usize, 3, 64] {
            let capped = super::host_b3::tail_lines_newest(&p, 1 << 20, false, &needle, max).unwrap();
            assert!(capped.len() <= max);
            assert_eq!(capped[..], old[..capped.len()], "newest first, a prefix of the full set");
            let mut got = key(&capped);
            if got.is_empty() && capped.len() >= max {
                got = key(&super::host_b3::tail_lines_newest(&p, 1 << 20, false, &needle, 0).unwrap());
            }
            assert_eq!(got, want, "tail_results={tail_results} max={max}");
        }
        if tail_results == 0 {
            let all: usize = old.iter().map(String::len).sum();
            let cap: usize = super::host_b3::tail_lines_newest(&p, 1 << 20, false, &needle, 64).unwrap().iter().map(String::len).sum();
            println!("PROMPTKEY_BYTES full={all} capped={cap}");
        }
    }
    // crlf and a missing file behave as tailLines
    let h = home("newest-crlf");
    let p = format!("{h}/t.jsonl");
    std::fs::write(&p, "a\"user\"1\r\nb\r\nc\"user\"2\r\n").unwrap();
    let n = vec![r#""user""#.to_string()];
    let mut o = super::host_b3::tail_lines_matching(&p, 1 << 20, true, &n).unwrap();
    o.reverse();
    assert_eq!(super::host_b3::tail_lines_newest(&p, 1 << 20, true, &n, 0).unwrap(), o);
    assert!(super::host_b3::tail_lines_newest(&format!("{h}/none"), 1 << 20, false, &n, 3).is_none());
}

// ---- afk-mode (GH #425): the machine-wide AFK flag, idle detection, the digest, the capped Stop hold, the counters ----
mod afk_mode {
    use super::*;

    /// The tests share the process-wide pending metric table with the claim-evidence counter test: one at a time (the write side of its
    /// lock), so a drain never takes another test's counts.
    use super::claim_evidence_guard::COUNTS;

    fn run(h: &str, ev: &str, extra: Value, envs: &[(&str, &str)]) -> Option<Option<Verdict>> {
        let mut payload = json!({"hook_event_name": ev, "session_id": "s1", "cwd": h, "transcript_path": format!("{h}/t.jsonl")});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            payload[k] = v;
        }
        let mut pairs = vec![("HOME".to_string(), h.to_string())];
        pairs.extend(envs.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        super::super::run_forced("afk-mode", &payload, &Value::Null, ev, &RequestEnv::from_pairs(pairs))
    }

    fn out(v: &Option<Option<Verdict>>) -> String {
        match v {
            Some(Some(Verdict::Exact(x))) => x.out.clone(),
            _ => String::new(),
        }
    }

    fn flag(h: &str) -> Value {
        serde_json::from_str(&std::fs::read_to_string(format!("{h}/.anti-hall/afk.json")).unwrap_or_default()).unwrap_or(Value::Null)
    }

    fn drained() -> crate::metrics::Metrics {
        let mut m = crate::metrics::Metrics::default();
        crate::metrics::drain_pending(&mut m);
        m
    }

    fn progress(h: &str) -> String {
        let date = &crate::checks::taskkit::time::iso(crate::checks::taskkit::time::now_ms())[..10];
        format!("{h}/.anti-hall/progress/{date}/s1.md")
    }

    #[test]
    fn typed_afk_starts_it_counts_it_and_is_not_sent_to_the_model() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-typed");
        drained();
        let v = run(&h, "UserPromptSubmit", json!({"prompt": "  AFK "}), &[]);
        let o = out(&v);
        assert!(o.contains("\"decision\":\"block\"") && o.contains("AFK on"), "{o}");
        let f = flag(&h);
        assert_eq!(f["on"], json!(true));
        assert_eq!(f["how"], json!("prompt"));
        assert_eq!(f["counted"], json!(true));
        let m = drained();
        assert_eq!(m.counter("afk_entered", &[("how", "prompt")]), 1);
        // a manual period from the CLI (counted=false) is counted once by the next hook
        std::fs::write(
            format!("{h}/.anti-hall/afk.json"),
            json!({"on": true, "how": "manual", "since": 1, "epoch": "1", "counted": false, "pending_digest": 3}).to_string(),
        )
        .unwrap();
        run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        let m = drained();
        assert_eq!(m.counter("afk_entered", &[("how", "manual")]), 1);
        assert_eq!(m.counter("digest_entries", &[]), 3);
    }

    #[test]
    fn idle_detection_trips_after_the_idle_minutes_and_the_next_owner_prompt_ends_it() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-idle");
        drained();
        // no recorded owner prompt: never trips
        run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        assert_eq!(flag(&h), Value::Null);
        // a prompt long ago: the next tool call trips idle and injects the rule once
        std::fs::write(format!("{h}/.anti-hall/afk-presence.json"), json!({"last": 0}).to_string()).unwrap();
        let o = out(&run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]));
        assert_eq!(flag(&h)["how"], json!("idle"));
        assert!(o.contains("AFK MODE"), "{o}");
        assert!(out(&run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[])).is_empty(), "the rule is injected once");
        let m = drained();
        assert_eq!(m.counter("idle_trips", &[]), 1);
        assert_eq!(m.counter("afk_entered", &[("how", "idle")]), 1);
        // a harness notification is not the owner
        run(&h, "UserPromptSubmit", json!({"prompt": "<task-notification>done</task-notification>"}), &[]);
        assert_eq!(flag(&h)["on"], json!(true));
        // the owner's prompt ends an idle AFK
        let o = out(&run(&h, "UserPromptSubmit", json!({"prompt": "how is it going"}), &[]));
        assert_eq!(flag(&h)["on"], json!(false));
        assert!(o.contains("ended"), "{o}");
        // idle detection off: no trip
        std::fs::write(format!("{h}/.anti-hall/afk-presence.json"), json!({"last": 0}).to_string()).unwrap();
        std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"afk": {"idleDetect": false}}).to_string()).unwrap();
        run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        assert_eq!(flag(&h)["on"], json!(false));
    }

    #[test]
    fn the_digest_prints_the_bullets_since_the_marker_with_a_percentage_and_back_ends_it() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-digest");
        drained();
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        // the first tool call of the session writes the marker into its progress file
        let o = out(&run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]));
        assert!(o.contains("AFK MODE"), "{o}");
        let p = progress(&h);
        let mut text = std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{p}: {e}"));
        assert!(text.contains("<!-- afk:"), "{text}");
        text.push_str("- [x] built the flag\n- [ ] tests pending\nnot a bullet\n");
        std::fs::write(&p, &text).unwrap();
        let o = out(&run(&h, "UserPromptSubmit", json!({"prompt": "progress"}), &[]));
        assert!(o.contains("built the flag") && o.contains("tests pending") && o.contains("50% (1/2"), "{o}");
        assert!(!o.contains("not a bullet"), "{o}");
        assert_eq!(flag(&h)["on"], json!(true), "progress does not end AFK");
        let o = out(&run(&h, "UserPromptSubmit", json!({"prompt": "back"}), &[]));
        assert!(o.contains("AFK off") && o.contains("built the flag"), "{o}");
        assert_eq!(flag(&h)["on"], json!(false));
        assert_eq!(drained().counter("digest_entries", &[]), 4);
    }

    #[test]
    fn an_overlong_afk_reply_is_nudged_once_then_held_at_most_max_blocks_times() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-enforce");
        drained();
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        let long = "line\n".repeat(10);
        let stop = |extra: Value| out(&run(&h, "Stop", extra, &[]));
        assert!(stop(json!({"last_assistant_message": "done."})).is_empty(), "a one-line reply passes");
        assert!(stop(json!({"last_assistant_message": long})).is_empty(), "the first overlong reply is nudged, not held");
        let o = out(&run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]));
        assert!(o.contains("your last reply was"), "the nudge reaches the next turn: {o}");
        assert!(stop(json!({"last_assistant_message": long, "stop_hook_active": true})).is_empty(), "never on stop_hook_active");
        assert!(stop(json!({"last_assistant_message": long})).contains("\"decision\":\"block\""), "then held");
        assert!(stop(json!({"last_assistant_message": long})).is_empty(), "capped at afk.max_blocks (1)");
        let m = drained();
        assert_eq!(m.counter("afk_overlong_turns", &[("action", "nudge")]), 1);
        assert_eq!(m.counter("afk_overlong_turns", &[("action", "block")]), 1);
        assert_eq!(m.counter("afk_overlong_turns", &[("action", "capped")]), 1);
        assert_eq!(m.counter("afk_turns", &[]), 4, "a stop_hook_active Stop is not a turn");
        // enforcement off: never held
        std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"afk": {"enforce": false}}).to_string()).unwrap();
        std::fs::remove_file(format!("{h}/.anti-hall/afk-sess-s1.json")).unwrap();
        for _ in 0..3 {
            assert!(stop(json!({"last_assistant_message": long})).is_empty());
        }
    }

    #[test]
    fn output_tokens_per_turn_are_measured_from_usage_split_afk_vs_present() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-tokens");
        drained();
        let a = |id: &str, n: u64| json!({"type": "assistant", "message": {"id": id, "role": "assistant", "usage": {"output_tokens": n}, "content": [{"type": "text", "text": "x"}]}});
        let lines = [
            json!({"type": "user", "message": {"role": "user", "content": "earlier"}}),
            a("m0", 999),
            json!({"type": "user", "message": {"role": "user", "content": "go"}}),
            a("m1", 50),
            a("m1", 50),
            json!({"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "u", "content": "ok"}]}}),
            a("m2", 30),
        ];
        std::fs::write(format!("{h}/t.jsonl"), lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
        run(&h, "Stop", json!({"last_assistant_message": "ok"}), &[]);
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        run(&h, "Stop", json!({"last_assistant_message": "ok"}), &[]);
        let m = drained();
        assert_eq!(m.counter("afk_output_tokens", &[("mode", "present")]), 80, "the turn since the last owner prompt, m1 counted once");
        assert_eq!(m.counter("afk_turns_measured", &[("mode", "present")]), 1);
        assert_eq!(m.counter("afk_output_tokens", &[("mode", "afk")]), 80);
    }

    #[test]
    fn ask_user_question_is_denied_every_time_while_afk_with_the_ladder() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-ask");
        drained();
        let ask = json!({"tool_name": "AskUserQuestion", "tool_input": {"questions": [{"question": "Which one?"}]}});
        assert!(out(&run(&h, "PreToolUse", ask.clone(), &[])).is_empty(), "not AFK: the question passes");
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        for _ in 0..5 {
            let o = out(&run(&h, "PreToolUse", ask.clone(), &[]));
            let v: Value = serde_json::from_str(o.trim()).unwrap_or_else(|e| panic!("{o}: {e}"));
            assert_eq!(v["hookSpecificOutput"]["hookEventName"], json!("PreToolUse"));
            assert_eq!(v["hookSpecificOutput"]["permissionDecision"], json!("deny"), "denied every time, no cap: {o}");
            let why = v["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap_or_default();
            assert!(why.contains("advisor") && why.contains("NEEDS OWNER"), "{why}");
        }
        assert_eq!(drained().counter("afk_question_denied", &[("tool", "AskUserQuestion")]), 5);
        // the rule injected at AFK start states the ladder
        let o = out(&run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]));
        assert!(o.contains("NEEDS OWNER"), "{o}");
        // the setting off: the question passes
        std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"afk": {"noQuestions": false}}).to_string()).unwrap();
        assert!(out(&run(&h, "PreToolUse", ask, &[])).is_empty());
        drained();
    }

    #[test]
    fn a_subagent_never_consumes_the_parents_afk_rule_and_its_question_is_still_denied() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-child");
        drained();
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        let c = out(&run(&h, "PostToolUse", json!({"tool_name": "Bash", "agent_id": "child", "agent_type": "general-purpose"}), &[]));
        assert!(c.is_empty(), "a subagent gets no rule and writes no session state: {c}");
        let d = out(&run(&h, "PreToolUse", json!({"tool_name": "AskUserQuestion", "agent_id": "child", "tool_input": {}}), &[]));
        assert!(d.contains("\"deny\""), "a subagent is part of the autonomous run: its question is denied: {d}");
        let p = out(&run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]));
        assert!(p.contains("AFK MODE"), "the parent still gets its rule: {p}");
        drained();
    }

    #[test]
    fn the_flag_is_never_rewritten_without_its_lock_and_off_wins_over_a_stale_on() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-race");
        drained();
        let fp = format!("{h}/.anti-hall/afk.json");
        std::fs::write(&fp, json!({"on": true, "how": "manual", "since": 1, "epoch": "1", "counted": false}).to_string()).unwrap();
        let lp = format!("{h}/.anti-hall/{}", crate::defaults::text("afk.lock_file"));
        let params = || crate::checks::guardkit::nodelock::Params::from_group("afk").expect("afk.lock_* keys");
        let held = crate::checks::guardkit::nodelock::acquire(&lp, params()).expect("test holds the lock");
        // another writer holds the lock: the hook writes nothing (no lost update)
        run(&h, "PostToolUse", json!({"tool_name": "Bash", "session_id": "s2"}), &[]);
        assert_eq!(flag(&h)["counted"], json!(false), "no write without the lock");
        // a hook that read ON waits on the lock while `back` writes OFF; it must not resurrect ON
        let h2 = h.clone();
        let t = std::thread::spawn(move || {
            run(&h2, "PostToolUse", json!({"tool_name": "Bash", "session_id": "s3"}), &[]);
        });
        std::thread::sleep(std::time::Duration::from_millis(60));
        std::fs::write(&fp, json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": false, "ended": 2}).to_string()).unwrap();
        assert!(held.release());
        t.join().expect("hook thread");
        assert_eq!(flag(&h)["on"], json!(false), "OFF wins over the stale ON");
        drained();
    }

    /// GH #426 review (C): a hook that read OFF and a stale presence decides to trip idle AFK; `back` writes OFF with `ended`
    /// while the hook waits on the lock; under the lock the hook must re-check idle against `ended` and write nothing.
    #[test]
    fn idle_re_entry_is_re_checked_under_the_lock_against_the_back_watermark() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-idle-race");
        drained();
        let fp = format!("{h}/.anti-hall/afk.json");
        std::fs::write(&fp, json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": true, "ended": 2}).to_string()).unwrap();
        std::fs::write(format!("{h}/.anti-hall/afk-presence.json"), json!({"last": 0}).to_string()).unwrap();
        let lp = format!("{h}/.anti-hall/{}", crate::defaults::text("afk.lock_file"));
        let params = crate::checks::guardkit::nodelock::Params::from_group("afk").expect("afk.lock_* keys");
        let held = crate::checks::guardkit::nodelock::acquire(&lp, params).expect("test holds the lock");
        let h2 = h.clone();
        let t = std::thread::spawn(move || {
            run(&h2, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        });
        std::thread::sleep(std::time::Duration::from_millis(60));
        let now = crate::checks::taskkit::time::now_ms();
        std::fs::write(&fp, json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": true, "ended": now}).to_string()).unwrap();
        assert!(held.release());
        t.join().expect("hook thread");
        assert_eq!(flag(&h)["on"], json!(false), "the later `back` wins: no idle re-entry");
        drained();
    }

    /// GH #426 review (D): a contended hook call has ONE lock budget (afk.lock_wait_ms) for all its flag updates and returns
    /// within it, writing nothing (the old code waited the full budget once per update).
    #[test]
    fn a_contended_hook_call_returns_within_one_lock_budget_writing_nothing() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-budget");
        drained();
        let fp = format!("{h}/.anti-hall/afk.json");
        let body = json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": true, "ended": 2, "pending_digest": 3}).to_string();
        std::fs::write(&fp, &body).unwrap();
        std::fs::write(format!("{h}/.anti-hall/afk-presence.json"), json!({"last": 0}).to_string()).unwrap();
        let lp = format!("{h}/.anti-hall/{}", crate::defaults::text("afk.lock_file"));
        let params = crate::checks::guardkit::nodelock::Params::from_group("afk").expect("afk.lock_* keys");
        let held = crate::checks::guardkit::nodelock::acquire(&lp, params).expect("test holds the lock");
        let budget = crate::defaults::num("afk.lock_wait_ms") as u128;
        let t0 = std::time::Instant::now();
        run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        let took = t0.elapsed().as_millis();
        assert!(held.release());
        assert!(took < 2 * budget, "one budget per call: {took} ms vs afk.lock_wait_ms {budget} ms");
        assert_eq!(std::fs::read_to_string(&fp).unwrap(), body, "a contended hook writes nothing");
        drained();
    }

    /// GH #426 review (E): typed `back` is the whole trimmed prompt in any case; with the flag lock busy it says so (the flag stays ON).
    #[test]
    fn typed_back_ignores_case_and_surrounding_space_and_reports_a_busy_lock() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-back-forms");
        drained();
        let fp = format!("{h}/.anti-hall/afk.json");
        let on = json!({"on": true, "how": "manual", "since": 1, "epoch": "1", "counted": true}).to_string();
        for typed in ["  BACK \n", "Back", "back"] {
            std::fs::write(&fp, &on).unwrap();
            run(&h, "UserPromptSubmit", json!({"prompt": typed}), &[]);
            assert_eq!(flag(&h)["on"], json!(false), "{typed:?} ends AFK");
        }
        std::fs::write(&fp, &on).unwrap();
        let lp = format!("{h}/.anti-hall/{}", crate::defaults::text("afk.lock_file"));
        let params = crate::checks::guardkit::nodelock::Params::from_group("afk").expect("afk.lock_* keys");
        let held = crate::checks::guardkit::nodelock::acquire(&lp, params).expect("test holds the lock");
        let o = out(&run(&h, "UserPromptSubmit", json!({"prompt": "back"}), &[]));
        assert!(held.release());
        assert_eq!(flag(&h)["on"], json!(true));
        assert!(o.contains("ah-engine back"), "busy: the reply says the flag did not change and names the CLI: {o}");
        drained();
    }

    #[test]
    fn a_turn_ending_on_a_plain_text_question_while_afk_is_held_with_the_ladder_capped() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-q-stop");
        drained();
        let q = json!({"last_assistant_message": "Shall I proceed?"});
        assert!(out(&run(&h, "Stop", q.clone(), &[])).is_empty(), "not AFK");
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        assert!(out(&run(&h, "Stop", json!({"last_assistant_message": "Done."}), &[])).is_empty());
        let mut q2 = q.clone();
        q2["stop_hook_active"] = json!(true);
        assert!(out(&run(&h, "Stop", q2, &[])).is_empty(), "never on stop_hook_active");
        let o = out(&run(&h, "Stop", q.clone(), &[]));
        assert!(o.contains("\"decision\":\"block\"") && o.contains("NEEDS OWNER"), "{o}");
        run(&h, "Stop", q.clone(), &[]);
        assert!(out(&run(&h, "Stop", q, &[])).is_empty(), "capped at afk.question_max_holds (2)");
        let m = drained();
        assert_eq!(m.counter("afk_question_parked", &[("action", "nudged")]), 2);
        assert_eq!(m.counter("afk_question_parked", &[("action", "capped")]), 1);
    }

    #[test]
    fn on_codex_stop_only_holds_a_question_never_the_length_or_the_measurement() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-codex-stop");
        drained();
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        let codex = |msg: &str| json!({"turn_id": "t1", "model": "gpt-5", "last_assistant_message": msg});
        std::fs::write(
            format!("{h}/t.jsonl"),
            format!("{}\n", json!({"type": "assistant", "message": {"id": "m", "usage": {"output_tokens": 9}, "content": []}})),
        )
        .unwrap();
        for _ in 0..3 {
            assert!(out(&run(&h, "Stop", codex(&"line\n".repeat(10)), &[])).is_empty(), "no length hold on Codex");
        }
        let o = out(&run(&h, "Stop", codex("Which option do you want?"), &[]));
        assert!(o.contains("\"decision\":\"block\"") && o.contains("NEEDS OWNER"), "{o}");
        let m = drained();
        assert_eq!(m.counter("afk_turns", &[]), 0);
        assert_eq!(m.counter("afk_output_tokens", &[("mode", "afk")]), 0);
        assert_eq!(m.counter("afk_overlong_turns", &[("action", "nudge")]), 0);
        assert_eq!(m.counter("afk_question_parked", &[("action", "nudged")]), 1);
    }

    #[test]
    fn the_digest_lists_needs_owner_bullets_first() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-needs");
        drained();
        run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]);
        run(&h, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        let p = progress(&h);
        let mut text = std::fs::read_to_string(&p).unwrap();
        text.push_str("- [x] built A\n- [ ] NEEDS OWNER: drop table x? (destructive)\n- [x] built B\n");
        std::fs::write(&p, &text).unwrap();
        let o = out(&run(&h, "UserPromptSubmit", json!({"prompt": "progress"}), &[]));
        let v: Value = serde_json::from_str(o.trim()).unwrap();
        let r = v["reason"].as_str().unwrap_or_default();
        let (n, a) = (r.find("NEEDS OWNER").unwrap_or(usize::MAX), r.find("built A").unwrap_or(0));
        assert!(n < a, "NEEDS OWNER first: {r}");
        assert_eq!(r.matches("NEEDS OWNER: drop").count(), 1, "listed once: {r}");
        assert!(r.contains("67% (2/3"), "{r}");
        assert_eq!(drained().counter("afk_question_parked", &[("action", "listed")]), 1);
    }

    /// GH #426 review (P1, Codex): a hook paused INSIDE its flag commit (after the ownership check, before the rename) for longer
    /// than afk.lock_stale_ms; another writer takes the expired lock over and publishes OFF; the paused hook resumes. Its stale ON
    /// must never land: the new holder swept its stage, so the rename finds nothing. Final state OFF, the loss counted.
    #[test]
    fn an_expired_holder_paused_inside_its_commit_never_resurrects_on_after_a_takeover() {
        use crate::checks::guardkit::nodelock;
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-fence");
        drained();
        let fp = format!("{h}/.anti-hall/afk.json");
        std::fs::write(&fp, json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": true, "ended": 2}).to_string()).unwrap();
        let lp = format!("{h}/.anti-hall/{}", crate::defaults::text("afk.lock_file"));
        let infix = crate::defaults::text("afk.fence_infix");
        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        nodelock::FENCE_GATE.lock().unwrap_or_else(|e| e.into_inner()).push((std::path::PathBuf::from(&fp), gate.clone()));
        let h2 = h.clone();
        let t = std::thread::spawn(move || {
            run(&h2, "UserPromptSubmit", json!({"prompt": "afk", "session_id": "s1"}), &[]);
        });
        gate.wait(); // the hook staged ON, passed its ownership check, and is paused before the rename
        let stale = crate::defaults::num("afk.lock_stale_ms");
        std::thread::sleep(std::time::Duration::from_millis(stale + stale / 20));
        let params = nodelock::Params::from_group("afk").expect("afk.lock_* keys");
        let taker = nodelock::acquire(&lp, params).expect("the expired lock is taken over");
        // unregister the gate first: the taker's own commit must not meet the barrier the paused hook is parked on
        nodelock::FENCE_GATE.lock().unwrap_or_else(|e| e.into_inner()).retain(|(p, _)| p != std::path::Path::new(&fp));
        nodelock::fence_sweep(std::path::Path::new(&fp), infix);
        let off = json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": true, "ended": 3}).to_string();
        assert!(nodelock::fenced_write(&taker, std::path::Path::new(&fp), &off, infix, false).expect("io"), "the new holder publishes OFF");
        assert!(taker.release());
        gate.wait(); // resume the paused hook
        t.join().expect("hook thread");
        assert_eq!(flag(&h)["on"], json!(false), "the stale holder never resurrects ON");
        assert_eq!(flag(&h)["ended"], json!(3), "the new holder's OFF is intact");
        let stages = std::fs::read_dir(format!("{h}/.anti-hall")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(infix)).count();
        assert_eq!(stages, 0, "no stage left behind");
        assert_eq!(drained().counter("afk_lock_lost", &[]), 1);
    }

    /// GH #426: the fence does not stop a CRASHED holder's expired lock from being taken over (a dead pid, older than
    /// afk.lock_stale_ms): the next hook takes it and writes.
    #[test]
    fn a_crashed_holders_expired_flag_lock_is_still_taken_over() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-crashed");
        drained();
        let mut child = std::process::Command::new("true").spawn().expect("spawn");
        let dead = child.id();
        child.wait().expect("wait");
        let lp = format!("{h}/.anti-hall/{}", crate::defaults::text("afk.lock_file"));
        let old = crate::checks::taskkit::time::now_ms() as u64 - 2 * crate::defaults::num("afk.lock_stale_ms");
        std::fs::write(&lp, json!({"pid": dead, "ts": old, "token": "crashed"}).to_string()).unwrap();
        run(&h, "UserPromptSubmit", json!({"prompt": "afk", "session_id": "s1"}), &[]);
        assert_eq!(flag(&h)["on"], json!(true), "the crashed holder's expired lock was taken over");
        drained();
    }

    /// Child-process helper of the interleaving tests below (ignored; a no-op unless the home is named): a typed `back` in another
    /// process, as the owner's next prompt would be (an in-process thread would queue on the daemon's in-process lock mutex).
    #[test]
    #[ignore]
    fn child_typed_back() {
        let Ok(h) = std::env::var("AH_TEST_AFK_BACK_HOME") else { return };
        run(&h, "UserPromptSubmit", json!({"prompt": "back", "session_id": "s9"}), &[]);
    }

    /// GH #426 review (P1, Codex): an idle entry decided from a stale presence is paused inside its commit (`phase`; None = after
    /// the ownership check, before the rename) past afk.lock_stale_ms; the owner types `back` in another process while the
    /// PUBLISHED flag is still OFF; the paused hook resumes. Its idle ON must never land: final OFF, no stage left.
    fn an_idle_on_paused_in_its_commit_loses_to_a_back_typed_while_the_flag_is_off(tag: &str, phase: Option<crate::checks::guardkit::nodelock::FencePhase>) {
        use crate::checks::guardkit::nodelock;
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home(tag);
        drained();
        let fp = format!("{h}/.anti-hall/afk.json");
        std::fs::write(&fp, json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": true, "ended": 2}).to_string()).unwrap();
        std::fs::write(format!("{h}/.anti-hall/afk-presence.json"), json!({"last": 0}).to_string()).unwrap();
        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        let target = std::path::PathBuf::from(&fp);
        match phase {
            None => nodelock::FENCE_GATE.lock().unwrap_or_else(|e| e.into_inner()).push((target.clone(), gate.clone())),
            Some(ph) => nodelock::FENCE_GATE_AT.lock().unwrap_or_else(|e| e.into_inner()).push((target.clone(), ph, gate.clone())),
        }
        let h2 = h.clone();
        let t = std::thread::spawn(move || {
            run(&h2, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        });
        gate.wait(); // the idle entry is paused inside its commit
        let stale = crate::defaults::num("afk.lock_stale_ms");
        std::thread::sleep(std::time::Duration::from_millis(stale + stale / 20));
        let exe = std::env::current_exe().expect("test binary");
        let st = std::process::Command::new(exe)
            .args(["afk_mode::child_typed_back", "--ignored", "--test-threads=1", "--nocapture"])
            .env("AH_TEST_AFK_BACK_HOME", &h)
            .status()
            .expect("child back");
        assert!(st.success(), "the child `back` ran");
        nodelock::FENCE_GATE.lock().unwrap_or_else(|e| e.into_inner()).retain(|(p, _)| p != &target);
        nodelock::FENCE_GATE_AT.lock().unwrap_or_else(|e| e.into_inner()).retain(|(p, _, _)| p != &target);
        gate.wait(); // resume the paused hook
        t.join().expect("hook thread");
        let f = flag(&h);
        assert_eq!(f["on"], json!(false), "the owner's `back` wins over the pending idle ON: {f}");
        assert!(f["ended"].as_i64().unwrap_or_default() > 2, "`back` bumped the watermark although the flag was OFF: {f}");
        let infix = crate::defaults::text("afk.fence_infix");
        let stages = std::fs::read_dir(format!("{h}/.anti-hall")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(infix)).count();
        assert_eq!(stages, 0, "no stage left behind");
        // the discarded commit is counted as revoked: the `ended` watermark its guard watches moved past its idle base
        assert_eq!(drained().counter("afk_idle_revoked", &[]), 1);
    }

    /// GH #426: the host's own re-check, with the lock still ours (no takeover): the idle entry is paused after its ownership
    /// check, before the rename, well under afk.lock_stale_ms; an owner presence newer than its idle base lands meanwhile (as the
    /// CLI `back` writes before it waits on the lock). The stage is discarded: final OFF, no stage left, counted afk_idle_revoked.
    #[test]
    fn an_idle_on_pending_at_the_rename_loses_to_a_newer_presence() {
        use crate::checks::guardkit::nodelock;
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-presence-rename");
        drained();
        let fp = format!("{h}/.anti-hall/afk.json");
        std::fs::write(&fp, json!({"on": false, "how": "manual", "since": 1, "epoch": "1", "counted": true, "ended": 2}).to_string()).unwrap();
        let pp = format!("{h}/.anti-hall/afk-presence.json");
        std::fs::write(&pp, json!({"last": 0}).to_string()).unwrap();
        let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
        let target = std::path::PathBuf::from(&fp);
        nodelock::FENCE_GATE.lock().unwrap_or_else(|e| e.into_inner()).push((target.clone(), gate.clone()));
        let h2 = h.clone();
        let t = std::thread::spawn(move || {
            run(&h2, "PostToolUse", json!({"tool_name": "Bash"}), &[]);
        });
        gate.wait(); // the idle entry owns the lock and is paused right before its re-check and rename
        std::fs::write(&pp, json!({"last": 3}).to_string()).unwrap();
        nodelock::FENCE_GATE.lock().unwrap_or_else(|e| e.into_inner()).retain(|(p, _)| p != &target);
        gate.wait();
        t.join().expect("hook thread");
        let f = flag(&h);
        assert_eq!(f["on"], json!(false), "a presence newer than the idle base discards the pending idle ON: {f}");
        let infix = crate::defaults::text("afk.fence_infix");
        let stages = std::fs::read_dir(format!("{h}/.anti-hall")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(infix)).count();
        assert_eq!(stages, 0, "no stage left behind");
        let m = drained();
        assert_eq!(m.counter("afk_idle_revoked", &[]), 1);
        assert_eq!(m.counter("afk_lock_lost", &[]), 0);
    }

    #[test]
    fn an_idle_on_paused_before_staging_loses_to_back() {
        an_idle_on_paused_in_its_commit_loses_to_a_back_typed_while_the_flag_is_off(
            "afk-back-pre",
            Some(crate::checks::guardkit::nodelock::FencePhase::BeforeStage),
        );
    }

    #[test]
    fn an_idle_on_paused_after_staging_loses_to_back() {
        an_idle_on_paused_in_its_commit_loses_to_a_back_typed_while_the_flag_is_off(
            "afk-back-staged",
            Some(crate::checks::guardkit::nodelock::FencePhase::AfterStage),
        );
    }

    #[test]
    fn an_idle_on_paused_inside_the_rename_loses_to_back() {
        an_idle_on_paused_in_its_commit_loses_to_a_back_typed_while_the_flag_is_off("afk-back-rename", None);
    }

    #[test]
    fn the_master_switch_off_leaves_prompts_alone() {
        let _g = COUNTS.write().unwrap_or_else(|e| e.into_inner());
        let h = home("afk-off");
        std::fs::write(format!("{h}/.anti-hall/settings.json"), json!({"afk": {"enabled": false}}).to_string()).unwrap();
        assert_eq!(run(&h, "UserPromptSubmit", json!({"prompt": "afk"}), &[]), Some(Some(Verdict::Allow)));
        assert_eq!(flag(&h), Value::Null);
        drained();
    }
}
