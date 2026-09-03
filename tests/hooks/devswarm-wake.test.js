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
const { wakeDirective, wakeReassert, WAKE_CRON_DEFAULT, drainCmd } = WAKE;

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

// C1 fix (v0.86.0): drainCmd now gates the read/spawn-worthy step behind a
// cheap inline `inbox count` check first, literal golden text kept
// independent of drainCmd itself (not a call-through) so a regression in
// drainCmd's own logic cannot silently rewrite its own expectation.
function nonClaudeGolden(agent, cli, isChild) {
  const id = '<DEVSWARM_BUILDER_ID>';
  const stopCond = 'if `unreadTotal` is 0 AND `meshGapWithheld` is NOT `true`';
  const drain = isChild
    ? 'first run `node ' + cli + ' inbox pull ' + id + '` (cheap, inline — imports ' +
      'anything waiting in your native queue) then `node ' + cli + ' inbox count ' + id +
      '`; ' + stopCond + ', say so and stop — do NOT spawn a subagent; otherwise (either ' +
      '`unreadTotal` is greater than 0, or `meshGapWithheld` is `true`), run `node ' + cli +
      ' inbox read-primary ' + id + '` (delegate to a subagent only if the payload is large ' +
      '— this is the cursor-advancing verb, matching devswarm-child-turn.js\'s own ' +
      'mesh-direct instruction; `inbox read` is a non-mutating peek and cannot clear the ' +
      'withheld gap)'
    : 'first run `node ' + cli + ' inbox count ' + id + '`; ' + stopCond + ', say so ' +
      'and stop — do NOT spawn a subagent; otherwise (either `unreadTotal` is greater than ' +
      '0, or `meshGapWithheld` is `true`), run `node ' + cli + ' inbox read-primary ' + id +
      '` (delegate to a subagent only if the payload is large)';
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

// ---------------------------------------------------------------------------
// C1 fix (v0.86.0): every no-op mailbox drain used to unconditionally spend a
// full subagent context (drainCmd emitted an unconditional drain instruction,
// funneled by wakeDirective/wakeReassert into SessionStart/Stop/cron text).
// Now drainCmd runs a cheap inline `inbox count` FIRST and tells the agent
// explicitly not to spawn anything when it comes back empty.
// ---------------------------------------------------------------------------

// C1 MUTATION-CHECK (killed):
//   1. Revert drainCmd to the pre-fix unconditional form (no `inbox count`, no
//      "do NOT spawn") -> all 3 tests below fail. This is also the RED
//      baseline verified against the pre-fix source.
//   2. Swap the child branch's leading `inbox pull` for `inbox count` (so
//      count would run before pull instead of after) -> the "keeps inbox pull
//      unconditional" test below fails (pullIdx < countIdx assertion trips).
test('C1: drainCmd(cli, false) [Primary] gates the drain behind an inline `inbox count` check and forbids spawning on empty', () => {
  const out = drainCmd(CLI, false);
  assert.ok(out.includes('inbox count'), `must run inbox count first; out=${out}`);
  assert.ok(/do NOT spawn/.test(out), `must explicitly forbid spawning a subagent on empty; out=${out}`);
  assert.ok(out.includes('inbox read-primary'), `must still name the drain verb for the non-empty branch; out=${out}`);
});

test('C1: drainCmd(cli, true) [child] also gates the READ step behind `inbox count`, but keeps `inbox pull` unconditional', () => {
  const out = drainCmd(CLI, true);
  assert.ok(out.includes('inbox count'), `must run inbox count; out=${out}`);
  assert.ok(/do NOT spawn/.test(out), `must forbid spawning on empty; out=${out}`);
  // inbox pull must NOT be gated behind count: count cannot see the native
  // queue pull imports, so gating pull itself would make native-only mail
  // permanently invisible (count would keep reporting 0 forever).
  const pullIdx = out.indexOf('inbox pull');
  const countIdx = out.indexOf('inbox count');
  assert.ok(pullIdx !== -1 && countIdx !== -1 && pullIdx < countIdx,
    `inbox pull must run BEFORE inbox count, unconditionally; out=${out}`);
});

// Wave 4 P1 fix: the child branch used to send bare `inbox read <id>` on the
// "otherwise" (unreadTotal>0 || meshGapWithheld) leg — a NON-MUTATING peek
// (devswarm.js cmdInbox `sub === 'read'` never calls ackTo/setCursor), so a
// child could never clear a `meshGapWithheld:true` condition; the gate could
// re-fire forever. Must now say `inbox read-primary` (the cursor-advancing
// verb, matching devswarm-child-turn.js's own mesh-direct instruction) and
// must NEVER emit the bare non-acking `inbox read <id>` form.
test('P1 (Wave 4): drainCmd(cli, true) [child] names the cursor-advancing `inbox read-primary`, never the non-mutating bare `inbox read`', () => {
  const out = drainCmd(CLI, true);
  assert.ok(out.includes('inbox read-primary'), `child otherwise-branch must run inbox read-primary (cursor-advancing); out=${out}`);
  const id = '<DEVSWARM_BUILDER_ID>';
  assert.ok(!out.includes('inbox read ' + id), `must never emit the non-mutating bare "inbox read <id>" form; out=${out}`);
});

test('C1: unreadTotal field is the value gated on (matches `inbox count`s real JSON field name)', () => {
  assert.ok(drainCmd(CLI, false).includes('unreadTotal'));
  assert.ok(drainCmd(CLI, true).includes('unreadTotal'));
});
