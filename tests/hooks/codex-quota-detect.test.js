'use strict';
// codex-quota-detect.js (PostToolUse, matcher Agent) + lib/codex-quota.js.
// 0.111 item 2: a codex:codex-rescue quota/rate-limit exhaustion was
// previously rediscovered independently by every lane; this hook records it
// once so a subsequent SessionStart / routing check can read it back instead.

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'codex-quota-detect.js';
const quota = require('../../plugins/anti-hall/hooks/lib/codex-quota.js');

function readState(home) {
  return JSON.parse(fs.readFileSync(quota.statePath(home), 'utf8'));
}

test('POSITIVE: a quota message in an Agent result for codex:codex-rescue is recorded + surfaced', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, {
      hook_event_name: 'PostToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: 'codex:codex-rescue', prompt: 'review this diff' },
      tool_response: { content: 'Error: out of quota until 2026-09-27T00:00:00.000Z. Try again later.' },
      session_id: 't',
    }, { home: h.home, expectJson: true });

    assert.strictEqual(r.status, 0);
    assert.ok(r.json, `expected JSON context, got: ${r.stdout}`);
    assert.match(r.json.hookSpecificOutput.additionalContext, /CODEX QUOTA/);
    assert.match(r.json.hookSpecificOutput.additionalContext, /route correctness review to Sonnet/);

    const state = readState(h.home);
    assert.strictEqual(state.quota.available, false);
    assert.strictEqual(state.quota.until, Date.parse('2026-09-27T00:00:00.000Z'));
  } finally { h.cleanup(); }
});

test('NEGATIVE: a clean codex:codex-rescue result records nothing', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, {
      hook_event_name: 'PostToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: 'codex:codex-rescue', prompt: 'review this diff' },
      tool_response: { content: 'Looks good, no issues found.' },
      session_id: 't',
    }, { home: h.home });

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(quota.statePath(h.home)), 'must not create a state file for a clean result');
  } finally { h.cleanup(); }
});

test('NEGATIVE: a quota-shaped message from a DIFFERENT agent type is ignored', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, {
      hook_event_name: 'PostToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: 'general-purpose', prompt: 'x' },
      tool_response: { content: 'Error: out of quota until 2026-09-27T00:00:00.000Z.' },
      session_id: 't',
    }, { home: h.home });

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(quota.statePath(h.home)));
  } finally { h.cleanup(); }
});

test('SWITCH guards.codexQuotaDetect=false: hook goes silent and records nothing', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(path.join(h.home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(h.home, '.anti-hall', 'settings.json'),
      JSON.stringify({ guards: { codexQuotaDetect: false } }));

    const r = testHook(HOOK, {
      hook_event_name: 'PostToolUse', tool_name: 'Agent',
      tool_input: { subagent_type: 'codex:codex-rescue', prompt: 'x' },
      tool_response: { content: 'Error: out of quota until 2026-09-27T00:00:00.000Z.' },
      session_id: 't',
    }, { home: h.home });

    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
    assert.ok(!fs.existsSync(quota.statePath(h.home)));
  } finally { h.cleanup(); }
});

test('lib/codex-quota.js: recordQuota/readQuota round-trip, expiry, and unparseable-until fallback', () => {
  const h = makeHome();
  try {
    const now = Date.now();
    quota.recordQuota({ until: now + 5000, reason: 'out of quota', home: h.home, now });
    let q = quota.readQuota({ home: h.home, now });
    assert.strictEqual(q.exhausted, true);
    assert.strictEqual(q.until, now + 5000);

    // expired
    q = quota.readQuota({ home: h.home, now: now + 6000 });
    assert.strictEqual(q.exhausted, false);

    // unparseable until falls back to DEFAULT_COOLDOWN_MS from `now`
    quota.recordQuota({ until: 'not-a-date', reason: 'x', home: h.home, now });
    q = quota.readQuota({ home: h.home, now });
    assert.strictEqual(q.exhausted, true);
    assert.strictEqual(q.until, now + quota.DEFAULT_COOLDOWN_MS);

    quota.clearQuota({ home: h.home });
    q = quota.readQuota({ home: h.home, now });
    assert.strictEqual(q.exhausted, false);
  } finally { h.cleanup(); }
});

test('lib/codex-quota.js: recordQuota merges into the existing PATH-probe fields, never clobbers them', () => {
  const h = makeHome();
  try {
    const p = quota.statePath(h.home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ available: true, checkedAt: 123, source: 'path-probe' }));

    quota.recordQuota({ until: Date.now() + 5000, reason: 'x', home: h.home });

    const state = readState(h.home);
    assert.strictEqual(state.available, true);
    assert.strictEqual(state.source, 'path-probe');
    assert.strictEqual(state.quota.available, false);
  } finally { h.cleanup(); }
});

test('lib/codex-quota.js: detectQuotaMessage matches conservative quota/rate-limit vocabulary and captures a trailing until-clause', () => {
  const hit1 = quota.detectQuotaMessage('Error: out of quota until 2026-09-27T00:00:00Z.');
  assert.ok(hit1);
  assert.strictEqual(hit1.until, Date.parse('2026-09-27T00:00:00Z'));

  const hit2 = quota.detectQuotaMessage('You have exceeded your rate limit, try again later.');
  assert.ok(hit2);

  const hit3 = quota.detectQuotaMessage('Everything looks fine, no errors.');
  assert.strictEqual(hit3, null);
});
