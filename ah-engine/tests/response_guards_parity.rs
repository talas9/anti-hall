//! Node-vs-engine parity for the response-correctness checks: `output-verify-guard`, `claim-ledger`,
//! `speculation-guard` and `speculation-judge`. Each case runs the same payloads through the real Node hook and the
//! engine check, each with its own isolated home and ANTIHALL_INGEST_DRY_RUN=1, and compares exit code, stdout, stderr
//! and the state files left behind; a case marked `defer` must be left to Node without touching anything.
//!
//! The one difference that is on purpose and not compared: with Jev off, the Node hooks that ask a Jev shadow question
//! still append a `mode: "off"` row to `logs/jev-assist.ndjson`; the engine never writes it (D35).
#[path = "common/replies.rs"]
mod replies;

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
    v.push(c("ov-cargo-build-not-runner").same(post("cargo build", json!(mixed))));
    v.push(c("ov-empty-command").same(post("", json!(mixed))));
    v.push(c("ov-no-command").same(json!({"hook_event_name":"PostToolUse","tool_name":"Bash","session_id":"s1","tool_response":mixed})));
    // runner shapes
    for (i, cmd) in [
        "npm test", "npm run test", "yarn test", "pnpm test", "node --test", "go test ./...", "cargo test", "pytest -q", "jest", "vitest run", "flutter test", "dart test",
        "FOO=1 BAR=2 pytest", "/usr/local/bin/pytest -x", "cd app && npm test", "make build; go test ./pkg", "echo hi | pytest", "npm run build", "npm", "go build",
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
    v.push(c("ov-jev-on-defers").env("ANTIHALL_JEV", "1").defer(post("npm test", json!(mixed))));
    v.push(c("ov-jev-on-not-runner-allows").env("ANTIHALL_JEV", "1").same(post("ls", json!(mixed))));
    v.push(c("ov-jev-settings-defers").file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#).defer(post("npm test", json!(mixed))));
    v.push(c("ov-jev-on-integration-off-allows").env("ANTIHALL_JEV", "1").env("ANTIHALL_JEV_OUTPUT_VERIFY_GUARD", "0").same(post("npm test", json!(mixed))));
    v.push(c("ov-jev-on-integration-off-settings").env("ANTIHALL_JEV", "1").file(".anti-hall/settings.json", r#"{"jevIntegrations":{"outputVerifyGuard":"off"}}"#).same(post("npm test", json!(mixed))));
    v.push(c("ov-jev-env-zero-wins").env("ANTIHALL_JEV", "0").file(".anti-hall/settings.json", r#"{"jev":{"enabled":true}}"#).same(post("npm test", json!(mixed))));
    // once per turn
    v.push(
        c("ov-once-per-turn").transcript(&turn).same(post("npm test", json!(mixed))).same(post("npm test", json!(mixed))).same(post("npm test", json!("1 passed 1 failed"))),
    );
    v.push(c("ov-once-off").env("ANTIHALL_OUTPUT_VERIFY_ONCE_PER_TURN", "0").transcript(&turn).same(post("npm test", json!(mixed))).same(post("npm test", json!(mixed))));
    v.push(
        c("ov-once-new-turn")
            .transcript(&[user_uuid("u1", "a")])
            .same(post("npm test", json!(mixed)))
            .same(post("npm test", json!(mixed))),
    );
    v.push(
        c("ov-once-injected-prompt-skipped")
            .transcript(&[user_uuid("u1", "a"), user_uuid("u2", "<system-reminder>x</system-reminder>"), tool_result("x")])
            .same(post("npm test", json!(mixed)))
            .same(post("npm test", json!(mixed))),
    );
    v.push(c("ov-once-agent").transcript(&turn).same(with(post("npm test", json!(mixed)), "agent_id", json!("ag1"))).same(with(post("npm test", json!(mixed)), "agent_id", json!("ag1"))));
    v.push(c("ov-once-agent-other").transcript(&turn).same(with(post("npm test", json!(mixed)), "agent_id", json!("ag1"))).same(with(post("npm test", json!(mixed)), "agent_id", json!("ag2"))));
    v.push(c("ov-once-no-session").transcript(&turn).same(without(post("npm test", json!(mixed)), "session_id")).same(without(post("npm test", json!(mixed)), "session_id")));
    v.push(c("ov-once-numeric-session").transcript(&turn).same(with(post("npm test", json!(mixed)), "session_id", json!(42))).same(with(post("npm test", json!(mixed)), "session_id", json!(42))));
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
    v.push(c("ov-once-sigs-capped").transcript(&turn).file(".anti-hall/turn-gate/tg-s1.json", &format!(r#"{{"output-verify-guard|main":{{"turn":"u1","sigs":[{}]}}}}"#, (0..20).map(|i| format!("\"s{i}\"")).collect::<Vec<_>>().join(","))).same(post("npm test", json!(mixed))));
    v.push(c("ov-once-prune-stale").transcript(&turn).file(".anti-hall/turn-gate/tg--old.json", "{}").same(post("npm test", json!(mixed))));
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
