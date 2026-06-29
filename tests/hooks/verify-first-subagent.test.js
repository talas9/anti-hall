'use strict';
// verify-first-subagent (SubagentStart). Exit 0; additionalContext carries the
// Iron Law core. Orchestration-delegation block deliberately absent.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'verify-first-subagent.js';

function ctx(r) {
  return (r.json && r.json.hookSpecificOutput && r.json.hookSpecificOutput.additionalContext) || '';
}

function subagentPayload() {
  return { hook_event_name: 'SubagentStart', session_id: 't', cwd: process.cwd() };
}

// ---------------------------------------------------------------------------
// Iron Law core MUST be present.
// ---------------------------------------------------------------------------

test('SubagentStart -> Iron Law present in additionalContext', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, subagentPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0');
    assert.strictEqual(r.json.hookSpecificOutput.hookEventName, 'SubagentStart', 'echoes SubagentStart');
    const c = ctx(r);
    assert.ok(c.length > 0, 'additionalContext must be non-empty');
    assert.ok(c.includes('IRON LAW'), 'IRON LAW must be present');
    assert.ok(c.includes('NO SPECULATION'), 'NO SPECULATION must be present');
  } finally { h.cleanup(); }
});

test('SubagentStart -> RATIONALIZATION TABLE present', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, subagentPayload(), { home: h.home, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('RATIONALIZATION TABLE'), 'RATIONALIZATION TABLE header must be present');
    assert.ok(c.includes("it's probably"), "rationalization entry 'probably' must be present");
    assert.ok(c.includes('should work'), "rationalization entry 'should work' must be present");
    assert.ok(c.includes('I suspect'), "rationalization entry 'I suspect' must be present");
  } finally { h.cleanup(); }
});

test('SubagentStart -> POSITIVE RULES present', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, subagentPayload(), { home: h.home, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('POSITIVE RULES'), 'POSITIVE RULES header must be present');
    assert.ok(c.includes('Collect evidence first'), 'rule 1 keyword must be present');
    assert.ok(c.includes('ROOT cause'), 'rule 3 keyword must be present');
    assert.ok(c.includes('THIS turn'), 'rule 6 keyword (THIS turn) must be present');
    assert.ok(c.includes('AGREED ACCEPTANCE CRITERIA'), 'rule 6: AGREED ACCEPTANCE CRITERIA must be present');
    assert.ok(c.includes('PENDING OWNER VERIFICATION'), 'rule 6: PENDING OWNER VERIFICATION must be present');
    assert.ok(c.includes('no real baseline'), 'rule 10: no real baseline must be present');
  } finally { h.cleanup(); }
});

test('SubagentStart -> SCOPE & FIDELITY present', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, subagentPayload(), { home: h.home, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('SCOPE & FIDELITY'), 'SCOPE & FIDELITY section header must be present');
    assert.ok(c.includes('SIMPLEST solution'), 'scope: SIMPLEST solution keyword must be present');
    assert.ok(c.includes('Intent over letter'), 'scope: Intent over letter must be present');
    assert.ok(c.includes('blast radius'), 'scope: blast radius must be present');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// ORCHESTRATION DISCIPLINE block must NOT appear (orchestrator-only).
// ---------------------------------------------------------------------------

test('SubagentStart -> ORCHESTRATION DISCIPLINE block absent (orchestrator-only)', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, subagentPayload(), { home: h.home, expectJson: true });
    const c = ctx(r);
    assert.ok(!c.includes('ORCHESTRATION DISCIPLINE'), 'ORCHESTRATION DISCIPLINE must be absent from subagent injection');
    assert.ok(!c.includes('main thread is a coordinator'), '"main thread is a coordinator" phrase must be absent');
    assert.ok(!c.includes('  A. COMMAND DELEGATION'), 'rule A (COMMAND DELEGATION) must be absent');
    assert.ok(!c.includes('  B. Keep the MAIN thread'), 'rule B must be absent');
    assert.ok(!c.includes('ACTIVELY DRAIN THE LIST'), 'rule C (ACTIVELY DRAIN THE LIST) must be absent');
    assert.ok(!c.includes('  D. BIAS TOWARD DELEGATION'), 'rule D must be absent');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Subagent disciplines footer present.
// ---------------------------------------------------------------------------

test('SubagentStart -> subagent-role discipline present', () => {
  const h = makeHome();
  try {
    const r = testHook(HOOK, subagentPayload(), { home: h.home, expectJson: true });
    const c = ctx(r);
    assert.ok(c.includes('subagent role'), 'subagent role discipline must be present');
    assert.ok(c.includes('do NOT re-delegate'), 'anti-nesting note must be present');
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Fail-open: malformed / empty stdin must never block.
// ---------------------------------------------------------------------------

test('FAIL-OPEN: empty stdin -> exit 0', () => {
  const h = makeHome();
  try {
    const r = testHookRaw(HOOK, '', { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0, 'must exit 0 on empty stdin');
    assert.ok(ctx(r).includes('IRON LAW'), 'IRON LAW must still be injected on empty stdin');
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
// Skip hatch: skip.json { 'verify-first-subagent': <future expiry> } -> silent.
// ---------------------------------------------------------------------------

test('SKIP HATCH: skip.json active -> exit 0, no additionalContext', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'verify-first-subagent': Date.now() + 600000 });
    const r = testHook(HOOK, subagentPayload(), { home: h.home });
    assert.strictEqual(r.status, 0, 'must exit 0 when skipped');
    // When skipped, the hook exits early before emitting JSON; stdout may be empty.
    const c = ctx(r);
    assert.ok(!c.includes('IRON LAW'), 'must not inject when skip is active');
  } finally { h.cleanup(); }
});

test('SKIP HATCH: expired skip -> still injects', () => {
  const h = makeHome();
  try {
    h.writeSkip({ 'verify-first-subagent': Date.now() - 1 }); // already expired
    const r = testHook(HOOK, subagentPayload(), { home: h.home, expectJson: true });
    assert.strictEqual(r.status, 0);
    assert.ok(ctx(r).includes('IRON LAW'), 'expired skip must not suppress injection');
  } finally { h.cleanup(); }
});
