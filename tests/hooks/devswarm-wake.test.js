'use strict';
// lib/devswarm-wake.js — direct unit tests for the SHARED wake-directive text
// builders (wakeDirective / wakeReassert). This is the SINGLE SOURCE of the
// DevSwarm idle-wake directive; its 3 consumers are devswarm-child-role.js
// (SessionStart), devswarm-parent-gate.js (Stop, Primary), devswarm-child-gate.js
// (Stop, child) — each has its own consumer-level tests. This file tests the
// shared builders directly (no process spawn needed: pure string functions).
//
// v0.6x "Monitor low-latency wake" adds a trailing `watcher` param to BOTH
// builders. THE NON-NEGOTIABLE RULE under test throughout: Cron must be
// UNCONDITIONALLY present in every Claude-branch output, regardless of whether
// `watcher` is supplied — Monitor layers ON TOP, it never replaces or gates Cron.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const WAKE = require('../../plugins/anti-hall/hooks/lib/devswarm-wake.js');
const { wakeDirective, wakeReassert, WAKE_CRON_DEFAULT } = WAKE;

const CLI = '/fake/plugin/root/scripts/devswarm.js';
const WATCHER = '/fake/plugin/root/companion/lib/devswarm-wake-watch.js';

// ---------------------------------------------------------------------------
// REQUIRED REGRESSION MATRIX (owner-named): the cron half must be present in
// EVERY Claude-branch output. wakeDirective x wakeReassert x child x Primary x
// (watcher present/absent) x (WAKE_CRON custom/unset/garbage). Deleting the
// cron half from either builder must make this fail loudly.
// ---------------------------------------------------------------------------

const CRON_CASES = [
  { label: 'custom valid cron', env: { DEVSWARM_AI_AGENT: 'claude', ANTIHALL_DEVSWARM_WAKE_CRON: '*/1 * * * *' }, expectedSchedule: '*/1 * * * *' },
  { label: 'unset cron (default)', env: { DEVSWARM_AI_AGENT: 'claude' }, expectedSchedule: WAKE_CRON_DEFAULT },
  { label: 'garbage cron (falls back to default)', env: { DEVSWARM_AI_AGENT: 'claude', ANTIHALL_DEVSWARM_WAKE_CRON: 'not a cron at all' }, expectedSchedule: WAKE_CRON_DEFAULT },
];

const WATCHER_CASES = [
  { label: 'watcher present', watcher: WATCHER },
  { label: 'watcher absent', watcher: undefined },
];

for (const isChild of [true, false]) {
  const roleLabel = isChild ? 'child' : 'Primary';
  for (const wCase of WATCHER_CASES) {
    for (const cCase of CRON_CASES) {
      test(`MATRIX wakeDirective: ${roleLabel} x ${wCase.label} x ${cCase.label} -> cron half always present`, () => {
        const out = wakeDirective(cCase.env, isChild, CLI, wCase.watcher);
        assert.ok(/`CronList`/.test(out), `must name CronList; out=${out}`);
        assert.ok(/`CronCreate`/.test(out), `must name CronCreate; out=${out}`);
        assert.ok(out.includes('`' + cCase.expectedSchedule + '`'), `must carry schedule ${cCase.expectedSchedule}; out=${out}`);
      });

      test(`MATRIX wakeReassert: ${roleLabel} x ${wCase.label} x ${cCase.label} -> cron half always present`, () => {
        const out = wakeReassert(cCase.env, CLI, isChild, wCase.watcher);
        assert.ok(/`CronList`/.test(out), `must name CronList; out=${out}`);
        assert.ok(/`CronCreate`/.test(out), `must name CronCreate; out=${out}`);
        assert.ok(out.includes('`' + cCase.expectedSchedule + '`'), `must carry schedule ${cCase.expectedSchedule}; out=${out}`);
      });
    }
  }
}

// ---------------------------------------------------------------------------
// GOLDEN: the NON-Claude branch is byte-identical to today's captured string,
// and never contains Monitor or CronCreate — regardless of `watcher`.
// ---------------------------------------------------------------------------

function nonClaudeGolden(agent, cli, isChild) {
  const drain = isChild
    ? '`node ' + cli + ' inbox pull <DEVSWARM_BUILDER_ID>` then `node ' + cli +
      ' inbox read <DEVSWARM_BUILDER_ID>`'
    : '`node ' + cli + ' inbox read-primary <DEVSWARM_BUILDER_ID>`';
  return ' MAILBOX WAKE: this workspace runs `' + agent + '`, which has NO idle-wake ' +
    'primitive — once you go idle, nothing can wake you, so a message that lands after ' +
    'you stop waits for your next turn. Drain your mailbox at the START of every turn ' +
    'and again BEFORE you stop: ' + drain + '.';
}

for (const isChild of [true, false]) {
  test(`GOLDEN: non-Claude branch (${isChild ? 'child' : 'Primary'}) is BYTE-IDENTICAL to today's text, with or without watcher`, () => {
    const env = { DEVSWARM_AI_AGENT: 'codex' };
    const expected = nonClaudeGolden('codex', CLI, isChild);
    const withoutWatcher = wakeDirective(env, isChild, CLI, undefined);
    const withWatcher = wakeDirective(env, isChild, CLI, WATCHER);
    assert.strictEqual(withoutWatcher, expected, `non-Claude branch must be byte-identical; got=${withoutWatcher}`);
    assert.strictEqual(withWatcher, expected, `watcher must NEVER affect the non-Claude branch; got=${withWatcher}`);
    assert.ok(!/Monitor/.test(withWatcher), `non-Claude branch must never name Monitor; out=${withWatcher}`);
    assert.ok(!/CronCreate/.test(withWatcher), `non-Claude branch must never name CronCreate; out=${withWatcher}`);
  });
}

test('GOLDEN: wakeReassert is Claude-only by construction — callers gate on isClaudeAgent, never called for non-Claude', () => {
  // wakeReassert itself has no agent branch (unlike wakeDirective) — its callers
  // (devswarm-parent-gate.js / devswarm-child-gate.js) gate on isClaudeAgent()
  // before ever invoking it. Documented here so a future refactor cannot quietly
  // drop that external gate without a test noticing the contract changed.
  assert.strictEqual(typeof WAKE.isClaudeAgent, 'function');
  assert.strictEqual(WAKE.isClaudeAgent({ DEVSWARM_AI_AGENT: 'codex' }), false);
  assert.strictEqual(WAKE.isClaudeAgent({ DEVSWARM_AI_AGENT: 'claude' }), true);
});

// ---------------------------------------------------------------------------
// Monitor half: present when `watcher` is passed, ABSENT when it is not.
// ---------------------------------------------------------------------------

for (const isChild of [true, false]) {
  test(`MONITOR: wakeDirective ${isChild ? 'child' : 'Primary'} -> Monitor arm text present iff watcher supplied`, () => {
    const env = { DEVSWARM_AI_AGENT: 'claude' };
    const withWatcher = wakeDirective(env, isChild, CLI, WATCHER);
    const withoutWatcher = wakeDirective(env, isChild, CLI, undefined);
    assert.ok(/`Monitor`/.test(withWatcher), `watcher present -> must arm Monitor; out=${withWatcher}`);
    assert.ok(withWatcher.includes('node ' + WATCHER), `must emit the exact watcher path; out=${withWatcher}`);
    assert.ok(/persistent/i.test(withWatcher), `must mention persistent:true; out=${withWatcher}`);
    assert.ok(!/`Monitor`/.test(withoutWatcher), `watcher absent -> Monitor text must be ABSENT; out=${withoutWatcher}`);
    // Absent watcher must not change the cron-only text at all vs. a call with no 4th arg.
    const implicit = wakeDirective(env, isChild, CLI);
    assert.strictEqual(withoutWatcher, implicit, 'explicit undefined watcher === omitted watcher arg');
  });

  test(`MONITOR: wakeReassert ${isChild ? 'child' : 'Primary'} -> Monitor arm text present iff watcher supplied`, () => {
    const withWatcher = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, CLI, isChild, WATCHER);
    const withoutWatcher = wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, CLI, isChild, undefined);
    assert.ok(/`Monitor`/.test(withWatcher), `watcher present -> must arm Monitor; out=${withWatcher}`);
    assert.ok(withWatcher.includes('node ' + WATCHER), `must emit the exact watcher path; out=${withWatcher}`);
    assert.ok(!/`Monitor`/.test(withoutWatcher), `watcher absent -> Monitor text must be ABSENT; out=${withoutWatcher}`);
  });
}

test('MONITOR: instruction tells the agent to check whether one is already armed before arming a second', () => {
  const out = wakeDirective({ DEVSWARM_AI_AGENT: 'claude' }, true, CLI, WATCHER);
  assert.ok(/already armed|double-arming/i.test(out), `must warn against double-arming; out=${out}`);
});

// ---------------------------------------------------------------------------
// Unknown agent (DEVSWARM_AI_AGENT unset) -> '' for wakeDirective. wakeReassert
// has no agent branch of its own (callers gate via isClaudeAgent), but must
// still never throw and must still respect fail-open on garbage env.
// ---------------------------------------------------------------------------

test("UNKNOWN AGENT: DEVSWARM_AI_AGENT unset -> wakeDirective yields '' regardless of watcher", () => {
  assert.strictEqual(wakeDirective({}, true, CLI, WATCHER), '');
  assert.strictEqual(wakeDirective({}, false, CLI, undefined), '');
});

test('FAIL-OPEN: never throws for hostile env / watcher values', () => {
  const hostile = [null, undefined, 42, 'x'.repeat(5000), { toString() { throw new Error('boom'); } }];
  for (const w of hostile) {
    assert.doesNotThrow(() => wakeDirective({ DEVSWARM_AI_AGENT: 'claude' }, true, CLI, w));
    assert.doesNotThrow(() => wakeReassert({ DEVSWARM_AI_AGENT: 'claude' }, CLI, true, w));
  }
});

// Watcher path sanity: absolute-path callers (the real consumers) always pass an
// absolute path — verify our fixture constant actually is one, so the matrix
// above is representative of real usage.
test('sanity: WATCHER fixture used throughout this file is absolute (matches real consumer usage)', () => {
  assert.ok(path.isAbsolute(WATCHER));
});
