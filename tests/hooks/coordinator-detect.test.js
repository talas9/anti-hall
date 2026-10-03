'use strict';
// coordinator-detect.js — pure unit tests (no subprocess needed; these are
// plain functions, not hooks). isSubagentByPayload (Wave R3 P2 fix, defect
// f0958b13fe2b): a PAYLOAD-ONLY subagent signal, deliberately WITHOUT the
// CLAUDE_CODE_ENTRYPOINT=agent_tool env fallback isSubagent() uses — see the
// function's own header comment for why the env fallback is unsafe for a
// gate that BLOCKS on a subagent match (a DevSwarm child workspace's env,
// including a possibly-leaked agent_tool value, is inherited by its entire
// process tree, so the env fallback would misclassify that workspace's own
// main-thread turns as a subagent forever).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MOD = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'coordinator-detect.js');

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('isSubagentByPayload: agent_id in payload -> true', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload({ agent_id: 'sub-1' }), true);
});

test('isSubagentByPayload: agent_type in payload -> true', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload({ agent_type: 'worker' }), true);
});

test('isSubagentByPayload: no payload markers -> false, EVEN with CLAUDE_CODE_ENTRYPOINT=agent_tool in env', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  withEnv({ CLAUDE_CODE_ENTRYPOINT: 'agent_tool' }, () => {
    assert.strictEqual(isSubagentByPayload({ hook_event_name: 'PreToolUse' }), false,
      'the env-only agent_tool signal must NOT satisfy the payload-only check');
  });
});

test('isSubagentByPayload: empty/null payload -> false', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload(null), false);
  assert.strictEqual(isSubagentByPayload({}), false);
  assert.strictEqual(isSubagentByPayload(undefined), false);
});

// Wave R3 item 13 (P2 hardening): key PRESENCE, not truthiness — a truthy
// check (`payload.agent_id`) treats `agent_id: ""` or `agent_id: 0` as
// "not a subagent" (falsy), which is the wrong direction for a conservative
// signal: the key being STAMPED onto the payload at all is the marker.
// Claude Code is not observed to ever emit an empty/falsy agent_id/
// agent_type — this hardens an unobserved shape, not a fixed live bug.
test('isSubagentByPayload: agent_id present but empty string ("") -> true (key presence, not truthiness)', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload({ agent_id: '' }), true);
});

test('isSubagentByPayload: agent_id present but 0 -> true (key presence, not truthiness)', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload({ agent_id: 0 }), true);
});

test('isSubagentByPayload: agent_type present but empty string ("") -> true (key presence, not truthiness)', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload({ agent_type: '' }), true);
});

test('isSubagentByPayload: agent_id explicitly null -> false (still excluded)', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload({ agent_id: null }), false);
});

test('isSubagentByPayload: agent_id explicitly undefined -> false (still excluded)', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagentByPayload } = require(MOD);
  assert.strictEqual(isSubagentByPayload({ agent_id: undefined }), false);
});

// Contrast: isSubagent() (the general-purpose, coordinator-gate signal)
// legitimately DOES use the env fallback — unchanged by this fix.
test('isSubagent (unchanged): CLAUDE_CODE_ENTRYPOINT=agent_tool alone -> true (general-purpose signal, env fallback intact)', () => {
  delete require.cache[require.resolve(MOD)];
  const { isSubagent } = require(MOD);
  withEnv({ CLAUDE_CODE_ENTRYPOINT: 'agent_tool' }, () => {
    assert.strictEqual(isSubagent({}), true);
  });
});
