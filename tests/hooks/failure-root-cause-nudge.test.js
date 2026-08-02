'use strict';
// failure-root-cause-nudge (PostToolUseFailure, matcher Bash). Advisory-only:
// a short reminder to trace the actual cause of a failed Bash command before
// patching, pointing at /anti-hall:root-cause. Never blocks.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'failure-root-cause-nudge.js';

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

function failurePayload({ toolName, command } = {}) {
  return {
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName || 'Bash',
    tool_input: typeof command === 'undefined' ? {} : { command },
    session_id: 't',
    cwd: process.cwd(),
  };
}

// ---------------------------------------------------------------------------
// Detection: any Bash tool failure -> short root-cause nudge.
// ---------------------------------------------------------------------------

test('Bash failure -> short root-cause nudge, does not block', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, failurePayload({ command: 'npm test' }), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0 (advisory, never blocks)');
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
    const c = ctx(r);
    assert.ok(c.includes('root-cause nudge'), 'reason must self-identify');
    assert.ok(c.includes('/anti-hall:root-cause'), 'reason must point at the root-cause skill');
    assert.ok(c.includes('npm test'), 'reason should include the failed command');
    assert.ok(!r.json.decision, 'must never set a blocking decision field');
  } finally { h.cleanup(); }
});

test('reason stays short: a long command is truncated, not reproduced in full', () => {
  const h = makeHome();
  try {
    const longCmd = 'echo ' + 'x'.repeat(200);
    const r = testHook(HOOK, failurePayload({ command: longCmd }), { home: h.home, expectJson: true });
    const c = ctx(r);
    assert.ok(!c.includes(longCmd), 'the full 200+ char command must not appear verbatim in the reason');
    assert.ok(c.includes('…'), 'a truncated command must show the ellipsis marker');
  } finally { h.cleanup(); }
});

test('missing tool_input.command -> still nudges, without a command fragment', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, failurePayload({}), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).includes('root-cause nudge'), 'must still nudge even with no command text available');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// No false positives: non-Bash tool.
// ---------------------------------------------------------------------------

test('non-Bash tool_name -> no annotation', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, failurePayload({ toolName: 'Edit', command: 'irrelevant' }), { home: h.home });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '', 'matcher is Bash-only; other tools must be ignored');
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

test('ENV OFF-SWITCH: ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE=off -> no annotation', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, failurePayload({ command: 'npm test' }), {
      home: h.home,
      env: { ANTIHALL_FAILURE_ROOT_CAUSE_NUDGE: 'off' },
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(ctx(r), '', 'off-switch must suppress the nudge');
  } finally { h.cleanup(); }
});

test('SKIP HATCH: skip.json active -> no annotation', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'failure-root-cause-nudge': Date.now() + 600000 });
    const r = testHook(HOOK, failurePayload({ command: 'npm test' }), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0 when skipped');
    assert.strictEqual(ctx(r), '', 'must not nudge when skip is active');
  } finally { h.cleanup(); }
});

test('SKIP HATCH: expired skip -> still nudges', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'failure-root-cause-nudge': Date.now() - 1 }); // already expired
    const r = testHook(HOOK, failurePayload({ command: 'npm test' }), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).length > 0, 'expired skip must not suppress the nudge');
  } finally { h.cleanup(); }
});
