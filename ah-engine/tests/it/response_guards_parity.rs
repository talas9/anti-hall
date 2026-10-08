//! Node-vs-engine parity for the response-correctness checks: `output-verify-guard`, `claim-ledger`,
//! `speculation-guard` and `speculation-judge`. Each case runs the same payloads through the real Node hook and the
//! engine check, each with its own isolated home and ANTIHALL_INGEST_DRY_RUN=1, and compares exit code, stdout, stderr
//! and the state files left behind; a case marked `defer` must be left to Node without touching anything.
//!
//! The one difference that is on purpose and not compared: with Jev off, the Node hooks that ask a Jev shadow question
//! still append a `mode: "off"` row to `logs/jev-assist.ndjson`; the engine never writes it (D35).
#![allow(clippy::unwrap_used, clippy::expect_used)] // a test crate: a panic is the failure report, and E2 exempts tests
use crate::replies;

use replies::*;
use serde_json::{Value, json};
use std::sync::Mutex;

/// The hooks write real files and spawn real processes; one scenario set at a time keeps the machine calm.
static SERIAL: Mutex<()> = Mutex::new(());

fn post(command: &str, response: Value) -> Value {
    json!({"hook_event_name":"PostToolUse","tool_name":"Bash","session_id":"s1","cwd":"/tmp","transcript_path":"$T","tool_input":{"command":command},"tool_response":response})
}

fn with(mut p: Value, k: &str, v: Value) -> Value {
    p.as_object_mut().unwrap().insert(k.into(), v);
    p
}

fn without(mut p: Value, k: &str) -> Value {
    p.as_object_mut().unwrap().remove(k);
    p
}

fn big(n: usize, unit: &str) -> String {
    unit.repeat(n)
}

fn output_verify_cases() -> Vec<Case> {
    let mixed = "Tests:  2 failed, 8 passed, 10 total\nPASS src/a.test.js\nFAIL src/b.test.js";
    let clean = "test result: ok. 5 passed; 0 failed; 0 ignored";
    let turn = [user_uuid("u1", "run the tests")];
    let mut v: Vec<Case> = Vec::new();
    let c = |n: &str| Case::new(n);
    // not a Bash test run
    v.push(c("ov-non-bash").same(with(post("npm test", json!(mixed)), "tool_name", json!("Read"))));
    v.push(c("ov-no-tool-name").same(without(post("npm test", json!(mixed)), "tool_name")));
    v.push(c("ov-grep-not-runner").same(post("grep PASS FAIL src/foo.js", json!("PASS\nFAIL"))));
    v.push(c("ov-any-cargo-subcommand-is-a-runner").same(post("cargo build", json!(mixed))));
    v.push(c("ov-empty-command").same(post("", json!(mixed))));
    v.push(c("ov-no-command").same(json!({"hook_event_name":"PostToolUse","tool_name":"Bash","session_id":"s1","tool_response":mixed})));
    // runner shapes
    for (i, cmd) in [
        "npm test",
        "npm run test",
        "yarn test",
        "pnpm test",
        "node --test",
        "go test ./...",
        "cargo test",
        "pytest -q",
        "jest",
        "vitest run",
        "flutter test",
        "dart test",
        "FOO=1 BAR=2 pytest",
        "/usr/local/bin/pytest -x",
        "cd app && npm test",
        "make build; go test ./pkg",
        "echo hi | pytest",
        "npm run build",
        "npm",
        "go build",
    ]
    .iter()
    .enumerate()
    {
        v.push(c(&format!("ov-runner-{i}")).same(post(cmd, json!(mixed))));
    }
    // outputs
    v.push(c("ov-mixed-string").same(post("npm test", json!(mixed))));
    v.push(c("ov-clean-cargo-zero-failed").same(post("cargo test", json!(clean))));
    v.push(c("ov-only-pass").same(post("npm test", json!("8 passed"))));
    v.push(c("ov-only-fail").same(post("npm test", json!("2 failed"))));
    v.push(c("ov-pytest").same(post("pytest", json!("== 2 failed, 8 passed in 1.2s =="))));
    v.push(c("ov-go-test").same(post("go test ./...", json!("--- FAIL: TestA (0.00s)\nFAIL\nFAIL\tpkg\t0.01s\nok  \tpkg2\t0.002s"))));
    v.push(c("ov-go-ok-line-start").same(post("go test ./...", json!("some text\nok  \tpkg2\t0.002s\n--- FAIL: TestB"))));
    v.push(c("ov-go-ok-not-line-start").same(post("go test ./...", json!("x ok  pkg\n--- FAIL: TestB"))));
    v.push(c("ov-mocha").same(post("npm test", json!("  8 passing (20ms)\n  2 failing"))));
    v.push(c("ov-tsc").same(post("npm test", json!("src/a.ts(1,1): error TS2304: Cannot find\nFound 0 errors."))));
    v.push(c("ov-traceback").same(post("pytest", json!("Traceback (most recent call last):\n  File x\n3 passed"))));
    v.push(c("ov-case-insensitive-count").same(post("npm test", json!("3 PASSED and 2 FAILED"))));
    v.push(c("ov-zero-then-nonzero").same(post("npm test", json!("0 failed first, later 4 failed; 6 passed"))));
    v.push(c("ov-build-failed").same(post("npm test", json!("Compiled successfully\nBuild failed"))));
    v.push(c("ov-unicode").same(post("npm test", json!("テスト 3 passed ✓\n2 failed ✗ 日本語 😀"))));
    // exit codes
    v.push(c("ov-obj-exit-code").same(post("npm test", json!({"stdout":"8 passed","stderr":"","exit_code":1}))));
    v.push(c("ov-obj-exitcode-camel").same(post("npm test", json!({"stdout":"8 passed","exitCode":2}))));
    v.push(c("ov-obj-exit-zero").same(post("npm test", json!({"stdout":"8 passed","exit_code":0}))));
    v.push(c("ov-obj-exit-float").same(post("npm test", json!({"stdout":"8 passed","exit_status":1.5}))));
    v.push(c("ov-text-exit-code").same(post("npm test", json!("8 passed\nexit code: 3"))));
    v.push(c("ov-text-exit-code-quoted").same(post("npm test", json!("8 passed {\"exit_code\":4}"))));
    v.push(c("ov-text-exit-code-negative").same(post("npm test", json!("8 passed\nexit_code=-1"))));
    // object and other response shapes
    v.push(c("ov-obj-single-stream").same(post("npm test", json!({"stdout":mixed}))));
    v.push(c("ov-obj-two-streams-same-text").same(post("npm test", json!({"stdout":"8 passed 2 failed","stderr":"2 failed"}))));
    v.push(c("ov-obj-two-streams-different-text").same(post("npm test", json!({"stdout":"8 passed\n2 failed","stderr":"5 failed"}))));
    let raw_resp = |resp: &str| {
        format!(r#"{{"hook_event_name":"PostToolUse","tool_name":"Bash","session_id":"s1","tool_input":{{"command":"npm test"}},"tool_response":{resp}}}"#)
    };
    v.push(c("ov-raw-unsorted-unambiguous").raw(&raw_resp(r#"{"stdout":"8 passed","stderr":"2 failed","interrupted":false}"#), Expect::Same));
    v.push(c("ov-raw-unsorted-ambiguous-defers").raw(&raw_resp(r#"{"stdout":"2 failed 8 passed","stderr":"5 failed"}"#), Expect::Defer));
    v.push(c("ov-raw-unsorted-ambiguous-pass-defers").raw(&raw_resp(r#"{"stdout":"9 passed","stderr":"4 passed 1 failed"}"#), Expect::Defer));
    v.push(c("ov-raw-unsorted-same-text-in-both").raw(&raw_resp(r#"{"stdout":"2 failed 8 passed","stderr":"2 failed"}"#), Expect::Same));
    v.push(c("ov-raw-unsorted-exit-codes-defer").raw(&raw_resp(r#"{"stdout":"8 passed exit code: 2","stderr":"exit code: 5"}"#), Expect::Defer));
    v.push(
        c("ov-raw-unsorted-structured-exit-wins").raw(&raw_resp(r#"{"stdout":"8 passed exit code: 2","stderr":"exit code: 5","exit_code":1}"#), Expect::Same),
    );
    v.push(c("ov-raw-nested-unsorted-ambiguous-defers").raw(&raw_resp(r#"{"z":{"b":"1 failed","a":"3 failed"},"y":"8 passed"}"#), Expect::Defer));
    v.push(c("ov-raw-escaped-leaf-boundary").raw(&raw_resp(r#"{"stdout":"line\n2 failed\n8 passed"}"#), Expect::Same));
    v.push(c("ov-obj-nested").same(post("npm test", json!({"result":{"stdout":"4 passed","stderr":"1 failed"},"interrupted":false}))));
    v.push(c("ov-array").same(post("npm test", json!(["8 passed", "2 failed"]))));
    v.push(c("ov-number").same(post("npm test", json!(5))));
    v.push(c("ov-bool").same(post("npm test", json!(false))));
    v.push(c("ov-null-response").same(post("npm test", Value::Null)));
    v.push(c("ov-tool-output-field").same(without(with(post("npm test", Value::Null), "tool_output", json!(mixed)), "tool_response")));
    v.push(c("ov-both-fields").same(with(post("npm test", json!("8 passed")), "tool_output", json!("2 failed"))));
    v.push(c("ov-empty-string-response").same(post("npm test", json!(""))));
    v.push(c("ov-escape-newline-boundary").same(post("npm test", json!({"stdout":"x\nFAIL\n8 passed"}))));
    // size
    v.push(c("ov-huge-string-head-tail").same(post("npm test", json!(format!("{}8 passed\n{}2 failed", big(150_000, "a"), big(150_000, "b"))))));
    v.push(c("ov-huge-string-astral").same(post("npm test", json!(format!("{}8 passed 2 failed{}", big(100_001, "😀"), big(5, "z"))))));
    v.push(c("ov-huge-string-astral-split-defers").defer(post("npm test", json!(format!("a{}8 passed 2 failed", big(100_000, "😀"))))));
    v.push(c("ov-node-dash-test-is-not-a-runner").same(post("node --test", json!(mixed))));
    v.push(c("ov-huge-object-defers").defer(post("npm test", json!({"stdout":big(250_000, "a"),"stderr":"2 failed"}))));
    // switches
    v.push(c("ov-env-off").env("ANTIHALL_OUTPUT_VERIFY_GUARD", "0").same(post("npm test", json!(mixed))));
    v.push(c("ov-env-off-word").env("ANTIHALL_OUTPUT_VERIFY_GUARD", "off").same(post("npm test", json!(mixed))));
    v.push(c("ov-env-junk-stays-on").env("ANTIHALL_OUTPUT_VERIFY_GUARD", "maybe").same(post("npm test", json!(mixed))));
    v.push(c("ov-settings-off").file(".anti-hall/settings.json", r#"{"guards":{"outputVerifyGuard":false}}"#).same(post("npm test", json!(mixed))));
    v.push(c("ov-settings-bad-json").file(".anti-hall/settings.json", "{").same(post("npm test", json!(mixed))));
    v.push(c("ov-option-off").env("CLAUDE_PLUGIN_OPTION_GUARDS_OUTPUT_VERIFY_GUARD", "false").same(post("npm test", json!(mixed))));
    v.push(c("ov-skip").file(".anti-hall/skip.json", &format!(r#"{{"output-verify-guard": {}}}"#, 4_102_444_800_000u64)).same(post("npm test", json!(mixed))));
    v.push(c("ov-skip-all").file(".anti-hall/skip.json", &format!(r#"{{"all": {}}}"#, 4_102_444_800_000u64)).same(post("npm test", json!(mixed))));
    v.push(c("ov-skip-expired").file(".anti-hall/skip.json", r#"{"output-verify-guard": 1000}"#).same(post("npm test", json!(mixed))));
    // jev
    v.push(c("ov-jev-on-answered").env("ANTIHALL_JEV", "1").same(post("npm test", json!(mixed))));
    v.push(c("ov-jev-on-not-runner-allows").env("ANTIHALL_JEV", "1").same(post("ls", json!(mixed))));
    v.push(c("ov-jev-settings-answered").file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#).same(post("npm test", json!(mixed))));
    v.push(c("ov-jev-on-integration-off-allows").env("ANTIHALL_JEV", "1").env("ANTIHALL_JEV_OUTPUT_VERIFY_GUARD", "0").same(post("npm test", json!(mixed))));
    v.push(
        c("ov-jev-on-integration-off-settings")
            .env("ANTIHALL_JEV", "1")
            .file(".anti-hall/settings.json", r#"{"jevIntegrations":{"outputVerifyGuard":"off"}}"#)
            .same(post("npm test", json!(mixed))),
    );
    v.push(
        c("ov-jev-env-zero-wins").env("ANTIHALL_JEV", "0").file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#).same(post("npm test", json!(mixed))),
    );
    // once per turn
    v.push(
        c("ov-once-per-turn")
            .transcript(&turn)
            .same(post("npm test", json!(mixed)))
            .same(post("npm test", json!(mixed)))
            .same(post("npm test", json!("1 passed 1 failed"))),
    );
    v.push(
        c("ov-once-off")
            .env("ANTIHALL_OUTPUT_VERIFY_ONCE_PER_TURN", "0")
            .transcript(&turn)
            .same(post("npm test", json!(mixed)))
            .same(post("npm test", json!(mixed))),
    );
    v.push(c("ov-once-new-turn").transcript(&[user_uuid("u1", "a")]).same(post("npm test", json!(mixed))).same(post("npm test", json!(mixed))));
    v.push(
        c("ov-once-injected-prompt-skipped")
            .transcript(&[user_uuid("u1", "a"), user_uuid("u2", "<system-reminder>x</system-reminder>"), tool_result("x")])
            .same(post("npm test", json!(mixed)))
            .same(post("npm test", json!(mixed))),
    );
    v.push(c("ov-once-agent").transcript(&turn).same(with(post("npm test", json!(mixed)), "agent_id", json!("ag1"))).same(with(
        post("npm test", json!(mixed)),
        "agent_id",
        json!("ag1"),
    )));
    v.push(c("ov-once-agent-other").transcript(&turn).same(with(post("npm test", json!(mixed)), "agent_id", json!("ag1"))).same(with(
        post("npm test", json!(mixed)),
        "agent_id",
        json!("ag2"),
    )));
    v.push(
        c("ov-once-no-session")
            .transcript(&turn)
            .same(without(post("npm test", json!(mixed)), "session_id"))
            .same(without(post("npm test", json!(mixed)), "session_id")),
    );
    v.push(c("ov-once-numeric-session").transcript(&turn).same(with(post("npm test", json!(mixed)), "session_id", json!(42))).same(with(
        post("npm test", json!(mixed)),
        "session_id",
        json!(42),
    )));
    v.push(c("ov-once-no-transcript").same(post("npm test", json!(mixed))).same(post("npm test", json!(mixed))));
    v.push(c("ov-once-missing-transcript-file").same(with(post("npm test", json!(mixed)), "transcript_path", json!("/nonexistent/t.jsonl"))));
    v.push(c("ov-once-relative-transcript-defers").defer(with(post("npm test", json!(mixed)), "transcript_path", json!("rel/t.jsonl"))));
    v.push(
        c("ov-once-other-writers-slot-kept")
            .file(".anti-hall/turn-gate/tg-s1.json", r#"{"failure-root-cause-nudge|main":{"turn":"u1","sigs":["x"]},"zz":1}"#)
            .transcript(&turn)
            .same(post("npm test", json!(mixed))),
    );
    v.push(c("ov-once-state-array-defers").file(".anti-hall/turn-gate/tg-s1.json", "[1]").transcript(&turn).defer(post("npm test", json!(mixed))));
    v.push(c("ov-once-state-garbage").file(".anti-hall/turn-gate/tg-s1.json", "not json").transcript(&turn).same(post("npm test", json!(mixed))));
    v.push(c("ov-once-state-null").file(".anti-hall/turn-gate/tg-s1.json", "null").transcript(&turn).same(post("npm test", json!(mixed))));
    v.push(
        c("ov-once-sigs-capped")
            .transcript(&turn)
            .file(
                ".anti-hall/turn-gate/tg-s1.json",
                &format!(r#"{{"output-verify-guard|main":{{"turn":"u1","sigs":[{}]}}}}"#, (0..20).map(|i| format!("\"s{i}\"")).collect::<Vec<_>>().join(",")),
            )
            .same(post("npm test", json!(mixed))),
    );
    v.push(c("ov-once-prune-stale").transcript(&turn).aged(".anti-hall/turn-gate/tg-old.json", "{}").same(post("npm test", json!(mixed))));
    // payload shapes
    v.push(c("ov-payload-null").same(Value::Null));
    v.push(c("ov-payload-array").same(json!([1, 2])));
    v.push(c("ov-payload-string").same(json!("x")));
    v.push(c("ov-tool-input-null").same(json!({"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":null,"tool_response":mixed})));
    v.push(c("ov-command-number").same(json!({"hook_event_name":"PostToolUse","tool_name":"Bash","tool_input":{"command":5},"tool_response":mixed})));
    v
}

#[test]
fn output_verify_guard_matches_node() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = run_all("output-verify-guard.js", "output-verify-guard", &output_verify_cases());
    assert!(t.steps >= 30 && t.same >= 25);
}

// ---- claim-ledger ---------------------------------------------------------------------------------------------

fn stop(extra: Value) -> Value {
    let mut p = json!({"hook_event_name":"Stop","session_id":"s1","cwd":"/tmp","transcript_path":"$T"});
    if let Value::Object(m) = extra {
        for (k, v) in m {
            p.as_object_mut().unwrap().insert(k, v);
        }
    }
    p
}

fn msg(text: &str) -> Value {
    stop(json!({"last_assistant_message": text}))
}

fn claim_ledger_cases() -> Vec<Case> {
    let c = |n: &str| Case::new(&format!("cl-{n}"));
    let mut v: Vec<Case> = Vec::new();
    let future = 4_102_444_800_000u64;
    // counts, with and without evidence
    v.push(c("count-unsupported").transcript(&[user("go"), asst("I ran 12 tests and changed 3 files")]).same(stop(json!({}))));
    v.push(
        c("count-supported").transcript(&[user("go"), tool_result("Ran 12 tests, 3 files"), asst("I ran 12 tests and changed 3 files")]).same(stop(json!({}))),
    );
    v.push(c("count-payload-text").transcript(&[user("go"), tool_result("ok")]).same(msg("The run took 45 seconds over 7 files")));
    v.push(c("rounding-supported").transcript(&[tool_result("34.887 total"), asst("took 34.9 s")]).same(stop(json!({}))));
    v.push(c("rounding-integer").transcript(&[tool_result("34.887 total"), asst("took 35 s")]).same(stop(json!({}))));
    v.push(c("rounding-flagged").transcript(&[tool_result("34.887 total"), asst("took 34.8 s")]).same(stop(json!({}))));
    v.push(c("rounding-boundary").transcript(&[tool_result("34.85 total"), asst("took 34.9 s")]).same(stop(json!({}))));
    v.push(c("rounding-boundary-2").transcript(&[tool_result("0.15 total"), asst("took 0.2 s and 0.1 s")]).same(stop(json!({}))));
    v.push(c("thousands").transcript(&[tool_result("1234 files"), asst("scanned 1,234 files")]).same(stop(json!({}))));
    v.push(c("comma-decimal").transcript(&[asst("scanned 1,5 files")]).same(stop(json!({}))));
    v.push(c("many-decimals").transcript(&[asst("scanned 1.23456789012345678901234567890 files")]).same(stop(json!({}))));
    v.push(c("big-numbers").transcript(&[asst("scanned 123456 files and 1234567 files and 99999999999 files")]).same(stop(json!({}))));
    // lookbehind
    for (i, t) in [
        "V2-4 workspace",
        "x12 files",
        "file-3 files",
        "ver 1.5 s",
        "(12 files)",
        "a .5 files",
        "foo 12files",
        "12files",
        "_9 rows",
        "é9 rows",
        "9 ROWS and 8 Rows",
        "7 KB 6 mb",
    ]
    .iter()
    .enumerate()
    {
        v.push(c(&format!("lookbehind-{i}")).transcript(&[asst(t)]).same(stop(json!({}))));
    }
    // sha, task, state, days ago
    v.push(c("sha-unsupported").transcript(&[asst("commit abc1234 and 0123456789abcdef0123456789abcdef01234567")]).same(stop(json!({}))));
    v.push(c("sha-supported").transcript(&[tool_result("HEAD abc1234"), asst("commit abc1234")]).same(stop(json!({}))));
    v.push(c("sha-pure-digits-skipped").transcript(&[asst("id 1234567 and 12345678901234567890")]).same(stop(json!({}))));
    v.push(c("sha-too-long").transcript(&[asst(&format!("hash {}", "a".repeat(41)))]).same(stop(json!({}))));
    v.push(c("task-of").transcript(&[asst("Task 3 of 5 done, task 4 of 5 next")]).same(stop(json!({}))));
    v.push(c("task-of-supported").transcript(&[tool_result("Task 3 of 5"), asst("Task 3 of 5 done")]).same(stop(json!({}))));
    v.push(c("state-no-tool").transcript(&[user("hi"), asst("the agent is still running and currently blocked")]).same(stop(json!({}))));
    v.push(
        c("state-with-tool")
            .transcript(&[user("hi"), asst_tool(json!({"command":"ls"})), tool_result("x"), asst("the agent is still running")])
            .same(stop(json!({}))),
    );
    v.push(c("days-ago").transcript(&[asst("fixed 5 days ago, and 1 day ago")]).same(stop(json!({}))));
    v.push(c("nothing-flagged").transcript(&[asst("all good here")]).same(stop(json!({}))));
    v.push(c("empty-reply").transcript(&[asst("   ")]).same(stop(json!({}))));
    // payload versus transcript
    v.push(c("payload-equals-transcript").transcript(&[asst("took 12 seconds")]).same(msg("took 12 seconds")));
    v.push(c("payload-extends-transcript").transcript(&[asst("took 12 seconds")]).same(msg("Done: took 12 seconds and 9 files")));
    v.push(c("payload-behind-transcript").transcript(&[asst("an earlier 31 files remark"), user("next")]).same(msg("A later reply about 8 tests")));
    v.push(c("payload-whitespace-only-falls-back").transcript(&[asst("took 12 seconds")]).same(msg("  \n ")));
    v.push(c("payload-nfd-vs-nfc").transcript(&[asst("caf\u{e9} took 12 seconds")]).same(msg("cafe\u{301} took 12 seconds")));
    v.push(c("payload-no-assistant-in-transcript").transcript(&[user("hello")]).same(msg("saw 5 files")));
    v.push(c("no-assistant-no-payload").transcript(&[user("hello")]).same(stop(json!({}))));
    // repeat and sessions
    v.push(c("recorded-once").transcript(&[asst("took 12 seconds")]).same(stop(json!({}))).same(stop(json!({}))));
    v.push(c("two-messages").transcript(&[asst("took 12 seconds")]).same(stop(json!({}))).same(msg("then 13 seconds")).same(msg("then 13 seconds")));
    v.push(c("no-session-id").transcript(&[asst("took 12 seconds")]).same(without(stop(json!({})), "session_id")));
    v.push(c("numeric-session-id").transcript(&[asst("took 12 seconds")]).same(stop(json!({"session_id": 77}))));
    v.push(c("weird-session-id").transcript(&[asst("took 12 seconds")]).same(stop(json!({"session_id": "a/b c:d😀"}))));
    v.push(c("object-session-id-defers").transcript(&[asst("took 12 seconds")]).defer(stop(json!({"session_id": {"a": 1}}))));
    v.push(c("last-file-stale").file(".anti-hall/claim-ledger/s1.last", "deadbeef").transcript(&[asst("took 12 seconds")]).same(stop(json!({}))));
    // switches
    v.push(
        c("settings-off").file(".anti-hall/settings.json", r#"{"guards":{"claimLedger":false}}"#).transcript(&[asst("took 12 seconds")]).same(stop(json!({}))),
    );
    v.push(c("option-off").env("CLAUDE_PLUGIN_OPTION_GUARDS_CLAIM_LEDGER", "false").transcript(&[asst("took 12 seconds")]).same(stop(json!({}))));
    v.push(c("skip").file(".anti-hall/skip.json", &format!(r#"{{"claim-ledger": {future}}}"#)).transcript(&[asst("took 12 seconds")]).same(stop(json!({}))));
    v.push(c("skip-all").file(".anti-hall/skip.json", &format!(r#"{{"all": {future}}}"#)).transcript(&[asst("took 12 seconds")]).same(stop(json!({}))));
    // jev
    v.push(c("jev-on-flags-answered").env("ANTIHALL_JEV", "1").transcript(&[asst("took 12 seconds")]).same(stop(json!({}))));
    v.push(c("jev-on-no-flags-answers").env("ANTIHALL_JEV", "1").transcript(&[asst("all good")]).same(stop(json!({}))));
    v.push(
        c("jev-on-integration-off").env("ANTIHALL_JEV", "1").env("ANTIHALL_JEV_CLAIM_LEDGER", "0").transcript(&[asst("took 12 seconds")]).same(stop(json!({}))),
    );
    // transcript shapes
    v.push(c("no-transcript-path").same(without(msg("took 12 seconds"), "transcript_path")));
    v.push(c("transcript-path-number").same(stop(json!({"transcript_path": 5}))));
    v.push(c("transcript-path-empty").same(stop(json!({"transcript_path": ""}))));
    v.push(c("transcript-relative-defers").defer(stop(json!({"transcript_path": "rel/t.jsonl"}))));
    v.push(c("transcript-missing-file").same(stop(json!({"transcript_path": "/nonexistent/dir/t.jsonl"}))));
    v.push(c("transcript-empty-file").transcript_raw("").same(stop(json!({}))));
    v.push(c("transcript-garbage-lines").transcript_raw("garbage\n{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"took 12 seconds\"}]}}\n[1,2]\n\"str\"\nnull\n").same(stop(json!({}))));
    v.push(c("transcript-crlf").transcript_raw(&format!("{}\r\n{}\r\n", user("hi"), asst("took 12 seconds"))).same(stop(json!({}))));
    v.push(c("transcript-nbsp-bom-lines").transcript_raw(&format!("\u{a0}{}\u{feff}\n", asst("took 12 seconds"))).same(stop(json!({}))));
    v.push(
        c("transcript-lone-surrogate-defers")
            .transcript_raw("{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"took 12 seconds \\ud800\"}}\n")
            .defer(stop(json!({}))),
    );
    v.push(c("transcript-huge-exponent-defers").transcript_raw("{\"x\":1e999}\n").defer(stop(json!({}))));
    v.push(c("transcript-deep-nesting-defers").transcript_raw(&format!("{}1{}\n", "[".repeat(200), "]".repeat(200))).defer(stop(json!({}))));
    v.push(
        c("transcript-escaped-surrogate-pair-ok")
            .transcript_raw(
                "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"took 12 seconds \\ud83d\\ude00\"}]}}\n",
            )
            .same(stop(json!({}))),
    );
    v.push(c("same-message-id-merged").transcript(&[asst_id("m1", "first 3 files"), asst_tool(json!({})), asst_id("m1", "and 4 tests")]).same(stop(json!({}))));
    v.push(c("different-message-id").transcript(&[asst_id("m1", "first 3 files"), asst_id("m2", "and 4 tests")]).same(stop(json!({}))));
    v.push(
        c("attachment-evidence")
            .transcript(&[json!({"type":"attachment","attachment":{"text":"ran 9 tests"}}).to_string(), asst("9 tests")])
            .same(stop(json!({}))),
    );
    v.push(
        c("user-array-no-tool-result")
            .transcript(&[json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"12 files"}]}}).to_string(), asst("12 files")])
            .same(stop(json!({}))),
    );
    v.push(c("tool-use-input-evidence").transcript(&[asst_tool(json!({"command":"check 15 files"})), asst("15 files")]).same(stop(json!({}))));
    v.push(c("tool-use-count-resets-on-user").transcript(&[asst_tool(json!({})), user("again"), asst("still running")]).same(stop(json!({}))));
    v.push(
        c("tool-use-result-null")
            .transcript(&[
                json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":null}]},"toolUseResult":null}).to_string(),
                asst("took 5 seconds"),
            ])
            .same(stop(json!({}))),
    );
    v.push(c("role-from-message").transcript(&[json!({"message":{"role":"assistant","content":"took 12 seconds"}}).to_string()]).same(stop(json!({}))));
    v.push(
        c("content-without-message")
            .transcript(&[json!({"type":"assistant","content":[{"type":"text","text":"took 12 seconds"}]}).to_string()])
            .same(stop(json!({}))),
    );
    v.push(
        c("falsy-message")
            .transcript(&[json!({"type":"assistant","message":0,"content":[{"type":"text","text":"took 12 seconds"}]}).to_string()])
            .same(stop(json!({}))),
    );
    v.push(
        c("big-evidence-numbers")
            .transcript(&[tool_result(&(0..3000).map(|i| i.to_string()).collect::<Vec<_>>().join(" ")), asst("took 2999 seconds and 3001 seconds")])
            .same(stop(json!({}))),
    );
    // context and limits
    v.push(c("context-long-line").transcript(&[asst(&format!("{} took 12 seconds {}", "word ".repeat(60), "tail ".repeat(60)))]).same(stop(json!({}))));
    v.push(c("context-multi-line").transcript(&[asst("line one\ntook 12 seconds here\nline three")]).same(stop(json!({}))));
    v.push(c("context-astral-cut-defers").transcript(&[asst(&format!("{}😀 took 12 seconds", "a".repeat(159)))]).defer(stop(json!({}))));
    v.push(c("context-astral-before-cut").transcript(&[asst("😀😀 took 12 seconds 😀")]).same(stop(json!({}))));
    v.push(c("max-flags").transcript(&[asst(&(1..=60).map(|i| format!("took {i}1 seconds")).collect::<Vec<_>>().join("\n"))]).same(stop(json!({}))));
    v.push(
        c("big-transcript-window")
            .transcript(&{
                let mut l = vec![asst("old 99 files claim")];
                l.extend((0..4000).map(|i| tool_result(&format!("{} {}", i, "x".repeat(600)))));
                l.push(asst("now 77 files"));
                l
            })
            .same(stop(json!({}))),
    );
    v.push(c("payload-null").same(Value::Null));
    v.push(c("payload-array").same(json!([])));
    v
}

#[test]
fn claim_ledger_matches_node() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = run_all("claim-ledger.js", "claim-ledger", &claim_ledger_cases());
    assert!(t.steps >= 30 && t.same >= 25);
}

// ---- speculation-guard ----------------------------------------------------------------------------------------

fn sha1(s: &str) -> String {
    ah_engine::checks::replykit::io::sha1_hex(s)
}

fn spec_cases() -> Vec<Case> {
    let c = |n: &str| Case::new(&format!("sg-{n}"));
    let mut v: Vec<Case> = Vec::new();
    let future = 4_102_444_800_000u64;
    // hedges and acknowledgments in the payload text
    let texts: &[(&str, &str)] = &[
        ("probably", "This is probably a cache problem."),
        ("should-be-fine", "It should be fine."),
        ("must-be", "That must be the reason."),
        ("plausibly", "That is plausibly the cause."),
        ("very-plausibly", "That is very plausibly the cause."),
        ("presumably", "Presumably the build is green."),
        ("i-suspect", "I suspect the config."),
        ("my-guess", "My guess is the cache."),
        ("id-guess", "I'd guess it passes."),
        ("id-guess-no-apostrophe", "Id guess it passes."),
        ("i-bet", "I bet it works."),
        ("likely", "It is likely done."),
        ("seems-to-be", "It seems to be working."),
        ("appears-to-be", "It appears to be fixed."),
        ("i-think-its", "I think it's the cache."),
        ("my-hunch", "My hunch is the cache."),
        ("uppercase", "PROBABLY the cache."),
        ("mixed-case", "ProBably the cache."),
        ("not-a-word-boundary", "improbably unlikely probablyish"),
        ("no-hedge", "All done, nothing to add."),
        ("ack-verified", "It is probably the cache, verified with the test run."),
        ("ack-dont-know", "It is probably the cache, I don't know yet."),
        ("ack-havent-checked", "It is probably the cache; I haven't checked."),
        ("ack-not-verified", "It is probably the cache (not verified)."),
        ("ack-unverified", "Unverified: probably the cache."),
        ("ack-let-me-verify", "Probably the cache, let me verify."),
        ("ack-ill-check", "Probably the cache, I'll check."),
        ("ack-will-check", "Probably the cache, I will check."),
        ("ack-need-to-confirm", "Probably the cache, need to confirm."),
        ("ack-to-confirm", "Probably the cache, to confirm run it."),
        ("ack-file-line", "Probably the cache, see main.js:42."),
        ("ack-running", "Probably the cache, running it now."),
        ("ack-per-the-data", "Probably the cache per the data."),
        ("ack-the-data-shows", "Probably the cache, the data shows it."),
        ("ack-case-sensitive-file-line", "Probably the cache, see MAIN.JS:42."),
        ("not-ack-file-no-line", "Probably the cache, see main.js."),
        ("requirement-line", "Requirement: the build must be green."),
        ("acceptance-line", "- Acceptance criteria: the list must be sorted"),
        ("ac-line", "AC: it should be fast"),
        ("spec-line-bullet", "* Spec: output should be stable"),
        ("numbered-spec", "1. spec: x must be small"),
        ("requirement-midline", "per the spec: this should be fine"),
        ("obligation-participle", "The build must be tested before ship."),
        ("obligation-participle-newline", "It must be\n  measured on device."),
        ("obligation-participle-far", "It must be                                        measured"),
        ("state-word-done", "This should be done by now."),
        ("two-modals-second-not-exempt", "X must be measured. Later it should be fine."),
        ("modal-then-other-hedge", "X must be verified. Probably wrong."),
        ("modal-exempt-plus-other-order", "The cache is probably full. X must be measured."),
        ("inline-code", "See `probably` and `must be` in the docs."),
        ("straight-quotes", "The docs say \"probably\" and \"likely\" here."),
        ("odd-straight-quotes", "The docs say \"probably here."),
        ("curly-quotes", "The docs say \u{201c}probably\u{201d} and \u{2018}likely\u{2019} here."),
        ("blockquote-only", "> probably fine\n> likely right"),
        ("blockquote-plus-text", "> probably fine\nSome plain words."),
        ("blockquote-separator-hedge", "> it is done \u{2014} so I think it is likely right"),
        ("blockquote-separator-dashes", "> quoted -- probably mine"),
        ("blockquote-semicolon-so", "> quoted; so it is probably mine"),
        ("blockquote-comma-so-upper", "> quoted, SO it is probably mine"),
        ("fence-closed", "Result:\n```\nprobably\nmust be\n```\nDone."),
        ("fence-unclosed", "Result:\n```\nprobably"),
        ("fence-tilde", "Result:\n~~~\nprobably\n~~~\nDone."),
        ("fence-mismatch", "Result:\n```\nprobably\n~~~\nDone."),
        ("fence-only", "```\nprobably\n```"),
        ("unicode-astral", "😀 probably 😀"),
        ("unicode-masked-astral", "`😀 probably` and then likely 😀"),
        ("unicode-cjk", "多分 probably 日本語"),
        ("crlf", "line one\r\nIt is probably fine\r\n"),
        ("long-text", &"filler words here. ".repeat(20000)),
        ("long-text-with-hedge", &format!("{} probably", "filler words here. ".repeat(20000))),
        ("whitespace-heavy", "   \t probably \n\n  "),
    ];
    for (n, t) in texts {
        v.push(c(n).same(msg(t)));
    }
    // loop safety and state
    v.push(c("block-then-pending-answered").same(msg("It is probably the cache.")).same(msg("It is probably the cache.")));
    v.push(c("block-then-other-text-answered").same(msg("It is probably the cache.")).same(msg("It is likely something else.")));
    v.push(
        c("seeded-same-hash-allows")
            .file(".anti-hall/speculation-guard-state-s1.json", &format!(r#"{{"hash":"{}","blocks":1}}"#, sha1("It is probably the cache.")))
            .same(msg("It is probably the cache.")),
    );
    v.push(
        c("seeded-other-hash-blocks").file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":1}"#).same(msg("It is probably the cache.")),
    );
    v.push(c("seeded-blocks-cap").file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":3}"#).same(msg("It is probably the cache.")));
    v.push(
        c("seeded-blocks-float").file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":1.5}"#).same(msg("It is probably the cache.")),
    );
    v.push(
        c("seeded-blocks-string").file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":"9"}"#).same(msg("It is probably the cache.")),
    );
    v.push(c("seeded-legacy-hash-text").file(".anti-hall/speculation-guard-state-s1.json", "3f2a9c").same(msg("It is probably the cache.")));
    v.push(c("seeded-legacy-numeric").file(".anti-hall/speculation-guard-state-s1.json", "12345678").same(msg("It is probably the cache.")));
    v.push(c("seeded-legacy-string-json").file(".anti-hall/speculation-guard-state-s1.json", "\"abc\"").same(msg("It is probably the cache.")));
    v.push(c("seeded-array").file(".anti-hall/speculation-guard-state-s1.json", "[1,2]").same(msg("It is probably the cache.")));
    v.push(c("seeded-null").file(".anti-hall/speculation-guard-state-s1.json", "null").same(msg("It is probably the cache.")));
    v.push(c("seeded-empty").file(".anti-hall/speculation-guard-state-s1.json", "  \n").same(msg("It is probably the cache.")));
    v.push(
        c("seeded-pending-answered")
            .file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":1,"pending":{"h":"zzz","source":"regex"}}"#)
            .same(msg("It is probably the cache.")),
    );
    v.push(
        c("seeded-pending-incomplete-ok")
            .file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":1,"pending":{"h":"zzz"}}"#)
            .same(msg("It is probably the cache.")),
    );
    v.push(
        c("seeded-pending-non-hedge-answered")
            .file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":1,"pending":{"h":"zzz","source":"jev"}}"#)
            .same(msg("All fine.")),
    );
    v.push(c("seeded-index-key-state-answered").file(".anti-hall/speculation-guard-state-s1.json", r#"{"7":1}"#).same(msg("It is probably the cache.")));
    v.push(c("prune-stale-files").file(".anti-hall/speculation-guard-state-old.json", "{}").same(msg("It is probably the cache.")));
    v.push(
        c("prune-removes-aged")
            .aged(".anti-hall/speculation-guard-state-old.json", "{}")
            .aged(".anti-hall/speculation-guard-state-old2.json", "{}")
            .same(msg("It is probably the cache.")),
    );
    v.push(
        c("prune-keeps-other-prefix")
            .aged(".anti-hall/other-state-old.json", "{}")
            .aged(".anti-hall/speculation-guard-state-old.txt", "{}")
            .same(msg("It is probably the cache.")),
    );
    v.push(
        c("prune-bad-stamp-sweeps")
            .aged(".anti-hall/speculation-guard-state-old.json", "{}")
            .file(".anti-hall/.prune-stamp-speculation-guard-state.json", "garbage")
            .same(msg("It is probably the cache.")),
    );
    v.push(
        c("prune-future-stamp-sweeps")
            .aged(".anti-hall/speculation-guard-state-old.json", "{}")
            .file(".anti-hall/.prune-stamp-speculation-guard-state.json", r#"{"lastSweep":99999999999999}"#)
            .same(msg("It is probably the cache.")),
    );
    v.push(
        c("prune-throttled")
            .file(".anti-hall/.prune-stamp-speculation-guard-state.json", &format!(r#"{{"lastSweep":{}}}"#, 4_102_444_800_000u64))
            .file(".anti-hall/speculation-guard-state-old.json", "{}")
            .same(msg("It is probably the cache.")),
    );
    // sessions
    v.push(c("no-session-id").same(without(msg("It is probably the cache."), "session_id")));
    v.push(c("numeric-session-id").same(with(msg("It is probably the cache."), "session_id", json!(7))));
    v.push(c("weird-session-id").same(with(msg("It is probably the cache."), "session_id", json!("../a b😀"))));
    v.push(c("zero-session-id").same(with(msg("It is probably the cache."), "session_id", json!(0))));
    v.push(c("object-session-id-defers").defer(with(msg("It is probably the cache."), "session_id", json!({"a":1}))));
    // switches
    v.push(c("settings-off").file(".anti-hall/settings.json", r#"{"guards":{"speculationGuard":false}}"#).same(msg("It is probably the cache.")));
    v.push(c("option-off").env("CLAUDE_PLUGIN_OPTION_GUARDS_SPECULATION_GUARD", "false").same(msg("It is probably the cache.")));
    v.push(c("settings-on-string").file(".anti-hall/settings.json", r#"{"guards":{"speculationGuard":"yes"}}"#).same(msg("It is probably the cache.")));
    v.push(c("skip").file(".anti-hall/skip.json", &format!(r#"{{"speculation-guard": {future}}}"#)).same(msg("It is probably the cache.")));
    v.push(c("skip-all").file(".anti-hall/skip.json", &format!(r#"{{"all": {future}}}"#)).same(msg("It is probably the cache.")));
    v.push(c("skip-expired").file(".anti-hall/skip.json", r#"{"speculation-guard": 5}"#).same(msg("It is probably the cache.")));
    v.push(c("jev-env-answered").env("ANTIHALL_JEV", "1").same(msg("It is probably the cache.")));
    v.push(c("jev-env-answered-no-hedge").env("ANTIHALL_JEV", "1").same(msg("All fine.")));
    v.push(c("jev-settings-answered").file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#).same(msg("It is probably the cache.")));
    v.push(c("jev-legacy-file-answered").file(".anti-hall/jev.json", r#"{"enabled":true}"#).same(msg("It is probably the cache.")));
    v.push(
        c("jev-env-zero-wins").env("ANTIHALL_JEV", "0").file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#).same(msg("It is probably the cache.")),
    );
    v.push(c("inference-on-no-hedge-defers").env("ANTIHALL_INFERENCE_CHECK", "1").defer(msg("The root cause is the cache.")));
    v.push(c("inference-on-hedge-blocks").env("ANTIHALL_INFERENCE_CHECK", "1").same(msg("It is probably the cache.")));
    v.push(
        c("inference-on-loop-safe-allows")
            .env("ANTIHALL_INFERENCE_CHECK", "1")
            .file(".anti-hall/speculation-guard-state-s1.json", r#"{"hash":"zzz","blocks":3}"#)
            .same(msg("The root cause is the cache.")),
    );
    v.push(c("inference-off-no-hedge").same(msg("The root cause is the cache.")));
    // transcript fallback
    v.push(c("transcript-only-hedge").transcript(&[user("go"), asst("It is probably the cache.")]).same(stop(json!({}))));
    v.push(c("transcript-only-no-hedge").transcript(&[user("go"), asst("All fine.")]).same(stop(json!({}))));
    v.push(c("transcript-only-masked").transcript(&[asst("See `probably` here.")]).same(stop(json!({}))));
    v.push(c("transcript-whitespace-payload").transcript(&[asst("It is probably the cache.")]).same(msg("   ")));
    v.push(c("transcript-last-wins").transcript(&[asst("probably old"), user("x"), asst("All fine now.")]).same(stop(json!({}))));
    v.push(c("transcript-empty").transcript_raw("").same(stop(json!({}))));
    v.push(c("transcript-no-assistant").transcript(&[user("hello")]).same(stop(json!({}))));
    v.push(c("transcript-missing-file").same(stop(json!({"transcript_path": "/nonexistent/t.jsonl"}))));
    v.push(c("transcript-relative-defers").defer(stop(json!({"transcript_path": "rel/t.jsonl", "last_assistant_message": "probably"}))));
    v.push(
        c("transcript-lone-surrogate-defers")
            .transcript_raw("{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":\"probably \\ud800\"}}\n")
            .defer(stop(json!({}))),
    );
    v.push(
        c("transcript-duplicated-message-text")
            .transcript(&[
                json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"prob"},{"type":"text","text":"ably"}]}}).to_string()
            ])
            .same(stop(json!({}))),
    );
    v.push(c("transcript-role-direct").transcript(&[json!({"role":"assistant","content":"It is probably the cache."}).to_string()]).same(stop(json!({}))));
    v.push(
        c("transcript-empty-message-string")
            .transcript(&[json!({"role":"assistant","content":"","message":"","text":"probably"}).to_string()])
            .same(stop(json!({}))),
    );
    v.push(c("transcript-masked-blockquote").transcript(&[asst("> probably fine\nreal words")]).same(stop(json!({}))));
    v.push(
        c("transcript-big-window")
            .transcript(&{
                let mut l = vec![asst("It is probably early.")];
                l.extend((0..3000).map(|i| tool_result(&format!("{i} {}", "x".repeat(400)))));
                l.push(asst("Final: all good."));
                l
            })
            .same(stop(json!({}))),
    );
    // payload shapes
    v.push(c("no-transcript-path").same(without(msg("It is probably the cache."), "transcript_path")));
    v.push(c("transcript-path-number").same(with(msg("It is probably the cache."), "transcript_path", json!(5))));
    v.push(c("transcript-path-empty").same(with(msg("It is probably the cache."), "transcript_path", json!(""))));
    v.push(c("payload-null").same(Value::Null));
    v.push(c("payload-array").same(json!([1])));
    v.push(c("payload-number-message").same(stop(json!({"last_assistant_message": 5}))));
    v.push(c("payload-empty-message-transcript").transcript(&[asst("probably")]).same(stop(json!({"last_assistant_message": ""}))));
    v
}

#[test]
fn speculation_guard_matches_node() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = run_all("speculation-guard.js", "speculation-guard", &spec_cases());
    assert!(t.steps >= 30 && t.same >= 25);
}

// ---- speculation-judge ----------------------------------------------------------------------------------------

fn judge_cases() -> Vec<Case> {
    let c = |n: &str| Case::new(&format!("sj-{n}"));
    let mut v: Vec<Case> = Vec::new();
    let future = 4_102_444_800_000u64;
    let payloads = [
        msg("It is probably the cache."),
        msg("The cause is the stale build artifact."),
        stop(json!({})),
        Value::Null,
        json!([1]),
        stop(json!({"transcript_path": 5})),
        stop(json!({"transcript_path": "rel.jsonl", "last_assistant_message": "x"})),
        json!({"hook_event_name":"Stop"}),
    ];
    for (i, p) in payloads.iter().enumerate() {
        v.push(c(&format!("default-off-{i}")).transcript(&[asst("The cause is the stale build artifact.")]).same(p.clone()));
        v.push(c(&format!("env-off-{i}")).env("ANTIHALL_SEMANTIC_JUDGE", "0").transcript(&[asst("The cause is x.")]).same(p.clone()));
        v.push(c(&format!("settings-false-{i}")).file(".anti-hall/settings.json", r#"{"jev":{"semanticJudge":false}}"#).same(p.clone()));
    }
    for (n, val) in [("junk", "maybe"), ("empty", ""), ("space", "  "), ("zero-word", "off"), ("no", "no")] {
        v.push(c(&format!("env-{n}-stays-off")).env("ANTIHALL_SEMANTIC_JUDGE", val).same(msg("The cause is x.")));
    }
    v.push(c("settings-string-off").file(".anti-hall/settings.json", r#"{"jev":{"semanticJudge":"no"}}"#).same(msg("x")));
    v.push(c("settings-corrupt").file(".anti-hall/settings.json", "{{").same(msg("x")));
    v.push(c("option-false").env("CLAUDE_PLUGIN_OPTION_JEV_SEMANTIC_JUDGE", "false").same(msg("x")));
    v.push(c("option-true-no-key").env("CLAUDE_PLUGIN_OPTION_JEV_SEMANTIC_JUDGE", "true").same(msg("x")));
    // opted in, default jev.judgeBackend api with no Anthropic key: no model call on either side (tests/judge_parity.rs covers the calls)
    for (n, val) in [("1", "1"), ("true", "true"), ("on", "on"), ("yes", "YES"), ("spaced", " 1 ")] {
        v.push(c(&format!("env-on-{n}-no-key")).env("ANTIHALL_SEMANTIC_JUDGE", val).same(msg("The cause is x.")));
    }
    v.push(c("settings-true-no-key").file(".anti-hall/settings.json", r#"{"jev":{"semanticJudge":true}}"#).same(msg("x")));
    v.push(c("settings-string-true-no-key").file(".anti-hall/settings.json", r#"{"jev":{"semanticJudge":"on"}}"#).same(msg("x")));
    v.push(
        c("env-zero-beats-settings-true")
            .env("ANTIHALL_SEMANTIC_JUDGE", "0")
            .file(".anti-hall/settings.json", r#"{"jev":{"semanticJudge":true}}"#)
            .same(msg("x")),
    );
    v.push(
        c("env-on-beats-settings-false")
            .env("ANTIHALL_SEMANTIC_JUDGE", "1")
            .file(".anti-hall/settings.json", r#"{"jev":{"semanticJudge":false}}"#)
            .same(msg("x")),
    );
    // the judge's own child never recurses
    v.push(c("child-exits").env("ANTIHALL_JUDGE_CHILD", "1").env("ANTIHALL_SEMANTIC_JUDGE", "1").same(msg("The cause is x.")));
    v.push(c("child-other-value-no-key").env("ANTIHALL_JUDGE_CHILD", "0").env("ANTIHALL_SEMANTIC_JUDGE", "1").same(msg("x")));
    // skip
    v.push(c("skip-when-on").env("ANTIHALL_SEMANTIC_JUDGE", "1").file(".anti-hall/skip.json", &format!(r#"{{"speculation-judge": {future}}}"#)).same(msg("x")));
    v.push(c("skip-all-when-on").env("ANTIHALL_SEMANTIC_JUDGE", "1").file(".anti-hall/skip.json", &format!(r#"{{"all": {future}}}"#)).same(msg("x")));
    v.push(c("skip-expired-when-on-no-key").env("ANTIHALL_SEMANTIC_JUDGE", "1").file(".anti-hall/skip.json", r#"{"speculation-judge": 3}"#).same(msg("x")));
    v
}

#[test]
fn speculation_judge_matches_node() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let t = run_all("speculation-judge.js", "speculation-judge", &judge_cases());
    assert!(t.steps >= 30 && t.same >= 30);
}
