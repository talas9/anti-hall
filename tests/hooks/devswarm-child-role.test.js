'use strict';
// devswarm-child-role (SessionStart hook). Injects a short self-report reminder
// ONLY when the liveness supervisor is active (devswarm-detect) AND this session
// is a DevSwarm child workspace (devswarm-role: DEVSWARM_SOURCE_BRANCH non-empty).
// Primary (empty/unset DEVSWARM_SOURCE_BRANCH), non-DevSwarm sessions, and
// malformed stdin must all be silent no-ops (fail-open, exit 0).

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'devswarm-child-role.js';
const REMINDER_PHRASE = 'message-parent';

function sessionPayload() {
  return { hook_event_name: 'SessionStart', source: 'startup', session_id: 't' };
}

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

test('INJECT: DevSwarm active + DEVSWARM_SOURCE_BRANCH set (child) -> reminder present', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), {
      home: h.home,
      expectJson: true,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.ok(r.json, `stdout must be valid JSON; stdout=${r.stdout}`);
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.ok(ctx(r).includes(REMINDER_PHRASE), `reminder must mention ${REMINDER_PHRASE}; ctx=${ctx(r)}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: DevSwarm active but DEVSWARM_SOURCE_BRANCH empty (Primary) -> no injection', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), {
      home: h.home,
      env: { DEVSWARM_REPO_ID: 'repo-1', DEVSWARM_SOURCE_BRANCH: '' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: no DevSwarm at all (no env) -> no injection', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('NO-OP: DEVSWARM_SOURCE_BRANCH set but DevSwarm not active -> no injection', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, sessionPayload(), {
      home: h.home,
      env: { DEVSWARM_SOURCE_BRANCH: 'main' },
    });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.stdout, '', `expected empty stdout; got: ${r.stdout}`);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: empty stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON stdin -> exit 0, no crash', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '{bad', { home: h.home });
    assert.strictEqual(r.status, 0);
  } finally {
    h.cleanup();
  }
});
