'use strict';
// output-verify-guard (PostToolUse, matcher Bash). Advisory-only: annotates
// when a Bash tool's own output shows BOTH a passing signal and a failing
// signal (or a passing signal alongside a confirmed non-zero exit code) in
// the same run — the shape of a mixed/partial result that risks being
// mis-reported as a clean "tests pass". Never blocks.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'output-verify-guard.js';

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

function postToolUsePayload(toolResponse, { toolName, command } = {}) {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: toolName || 'Bash',
    tool_input: { command: command || 'npm test' },
    tool_response: toolResponse,
    session_id: 't',
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Detection: mixed pass+fail signal -> annotate.
// ---------------------------------------------------------------------------

test('mixed pass+fail (jest-style summary) -> annotates, does not block', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload({
      stdout: 'FAIL src/foo.test.js\nTests: 2 failed, 8 passed, 10 total\n',
      stderr: '',
      exit_code: 1,
    });
    const r = testHook(HOOK, payload, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0 (advisory, never blocks)');
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PostToolUse');
    const c = ctx(r);
    assert.ok(c.includes('output-verify-guard'), 'reason must self-identify the hook');
    assert.ok(!r.json.decision, 'must never set a blocking decision field');
  } finally { h.cleanup(); }
});

test('mixed pass+fail (go test style) -> annotates', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload({
      stdout: '--- FAIL: TestFoo (0.00s)\n--- PASS: TestBar (0.00s)\nFAIL\tpkg\t0.010s\n',
      exit_code: 1,
    });
    const r = testHook(HOOK, payload, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).length > 0, 'must annotate on go-test mixed signal');
  } finally { h.cleanup(); }
});

test('passing text + confirmed non-zero exit_code (no explicit FAIL text) -> annotates', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload({
      stdout: 'Tests: 10 passed, 10 total\n',
      exit_code: 2,
    });
    const r = testHook(HOOK, payload, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).includes('non-zero exit code'), 'reason must call out the non-zero exit code path');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// No false positives: clean pass, clean fail (no pass mention), non-Bash.
// ---------------------------------------------------------------------------

test('clean pass only (no failure signal, zero exit) -> no annotation', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload({
      stdout: 'PASS src/foo.test.js\nTests: 10 passed, 10 total\n',
      exit_code: 0,
    });
    const r = testHook(HOOK, payload, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '', 'clean pass must not be annotated');
  } finally { h.cleanup(); }
});

test('clean failure only (no passing-count text anywhere) -> no annotation', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload({
      stdout: 'FAIL src/foo.test.js\n2 failed, 2 total\n',
      exit_code: 1,
    });
    const r = testHook(HOOK, payload, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '', 'an unambiguous failure with no passing claim must not be annotated (dual-signal design)');
  } finally { h.cleanup(); }
});

test('non-Bash tool_name -> no annotation even with mixed text', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload(
      { stdout: 'FAIL x\nTests: 1 failed, 1 passed\n', exit_code: 1 },
      { toolName: 'Read' }
    );
    const r = testHook(HOOK, payload, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '', 'matcher is Bash-only; other tools must be ignored');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Test-runner scoping (deterministic fix): only a command whose COMMAND-
// POSITION verb is an actual test runner is evaluated at all — a grep of
// source code containing both words is not a test run.
// ---------------------------------------------------------------------------

test('grep of source containing PASS and FAIL -> no annotation (not a test-runner command)', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload(
      { stdout: 'export const PASS = 1;\nexport const FAIL = 0;\n', exit_code: 0 },
      { command: 'grep -n "PASS\\|FAIL" src/constants.js' }
    );
    const r = testHook(HOOK, payload, { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '', 'a plain grep is not a test runner; must never annotate');
  } finally { h.cleanup(); }
});

test('real mixed test-runner output (pytest) -> annotation unchanged', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload(
      { stdout: '2 failed, 8 passed in 1.23s\n', exit_code: 1 },
      { command: 'pytest -q' }
    );
    const r = testHook(HOOK, payload, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).includes('output-verify-guard'), 'pytest mixed result must still annotate');
  } finally { h.cleanup(); }
});

test('go test verb+subcommand recognized; npm run test recognized; plain npm not', () => {
  const h = makeHome();
  const mixed = { stdout: '--- FAIL: TestFoo\n--- PASS: TestBar\nFAIL\tpkg\t0.01s\n', exit_code: 1 };
  try {
    let r = testHook(HOOK, postToolUsePayload(mixed, { command: 'go test ./...' }), { home: h.home, expectJson: true });
    assert.ok(ctx(r).length > 0, 'go test must be recognized as a runner');

    r = testHook(HOOK, postToolUsePayload(mixed, { command: 'npm run test' }), { home: h.home, expectJson: true });
    assert.ok(ctx(r).length > 0, 'npm run test must be recognized as a runner');

    r = testHook(HOOK, postToolUsePayload(mixed, { command: 'npm run build' }), { home: h.home });
    assert.strictEqual(ctx(r), '', 'npm run build (not test) must not be evaluated');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Fail-open: malformed / empty stdin must never block.
// ---------------------------------------------------------------------------

test('FAIL-OPEN: empty stdin -> exit 0', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0 on empty stdin');
  } finally { h.cleanup(); }
});

test('FAIL-OPEN: malformed JSON -> exit 0', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad json', { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0 on malformed JSON');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Off-switch + skip hatch.
// ---------------------------------------------------------------------------

test('ENV OFF-SWITCH: ANTIHALL_OUTPUT_VERIFY_GUARD=off -> no annotation', () => {
  const h = makeHome();
  try {
    const payload = postToolUsePayload({
      stdout: 'FAIL x\nTests: 1 failed, 1 passed, 2 total\n',
      exit_code: 1,
    });
    const r = testHook(HOOK, payload, { home: h.home, env: { ANTIHALL_OUTPUT_VERIFY_GUARD: 'off' } });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '', 'off-switch must suppress annotation');
  } finally { h.cleanup(); }
});

test('SKIP HATCH: skip.json active -> no annotation', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'output-verify-guard': Date.now() + 600000 });
    const payload = postToolUsePayload({
      stdout: 'FAIL x\nTests: 1 failed, 1 passed, 2 total\n',
      exit_code: 1,
    });
    const r = testHook(HOOK, payload, { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0 when skipped');
    assert.strictEqual(ctx(r), '', 'must not annotate when skip is active');
  } finally { h.cleanup(); }
});

test('SKIP HATCH: expired skip -> still annotates', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'output-verify-guard': Date.now() - 1 }); // already expired
    const payload = postToolUsePayload({
      stdout: 'FAIL x\nTests: 1 failed, 1 passed, 2 total\n',
      exit_code: 1,
    });
    const r = testHook(HOOK, payload, { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).length > 0, 'expired skip must not suppress annotation');
  } finally { h.cleanup(); }
});
