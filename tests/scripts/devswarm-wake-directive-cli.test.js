'use strict';
// C (Stop-gate wake-reassert trim follow-up): `wake-directive <id>` is the
// on-demand CLI reprint of the FULL SessionStart MAILBOX WAKE text — the
// target hooks/lib/devswarm-wake.js's trimmed wakeReassert() now points at
// (`re-run the SessionStart wake directive`) instead of re-stating the whole
// CronCreate prompt inline on every Stop-gate firing.
//
// Pure read, never touches the store — cmdWakeDirective (scripts/devswarm.js)
// delegates to lib/devswarm-wake.js's own wakeDirective()/isClaudeAgent(), the
// SAME builder hooks/devswarm-child-role.js (SessionStart) uses, so the two
// can never drift on wording.

const { test } = require('node:test');
const assert = require('node:assert');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

const ctx = (env) => ({ home: '/tmp/anti-hall-wake-directive-cli-unused', backend: 'journal', env: env || {} });

test('wake-directive <id>: unknown agent (no DEVSWARM_AI_AGENT) -> ok:true with an empty directive, never an error', () => {
  const r = cli.run(['wake-directive', 'some-id'], ctx({})).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.id, 'some-id');
  assert.equal(r.agent, null);
  assert.equal(r.directive, '');
});

test('wake-directive <id>: Claude Primary -> the FULL SessionStart directive, with the concrete id substituted for the placeholder', () => {
  const r = cli.run(['wake-directive', 'primary-abc123'], ctx({ DEVSWARM_AI_AGENT: 'claude' })).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isChild, false);
  assert.equal(r.agent, 'claude');
  assert.match(r.directive, /CronList/);
  assert.match(r.directive, /CronCreate/);
  assert.match(r.directive, /Monitor/);
  assert.ok(r.directive.includes('primary-abc123'), 'the concrete id must be substituted into the drain command');
  assert.ok(!r.directive.includes('<DEVSWARM_BUILDER_ID>'), 'the generic placeholder must not leak through once an id is given');
  assert.ok(!r.directive.includes(' --child'), 'a Primary (DEVSWARM_SOURCE_BRANCH unset) must get the read-primary drain, never --child');
});

test('wake-directive <id>: Claude CHILD workspace (DEVSWARM_SOURCE_BRANCH set) -> the child-role directive with --child', () => {
  const r = cli.run(['wake-directive', 'child-xyz'], ctx({ DEVSWARM_AI_AGENT: 'claude', DEVSWARM_SOURCE_BRANCH: 'feature/x' })).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isChild, true);
  assert.ok(r.directive.includes('child-xyz'), 'the concrete id must be substituted into the drain command');
});

test('wake-directive <id>: Codex agent -> the honest no-CronCreate equivalent (matches wakeDirective\'s own contract)', () => {
  const r = cli.run(['wake-directive', 'codex-id'], ctx({ DEVSWARM_AI_AGENT: 'codex' })).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.agent, null, 'agentNameSafe only names claude — matches wakeDirective\'s own agent-name gating');
  assert.match(r.directive, /codex-id/);
  assert.ok(!/CronCreate/.test(r.directive), 'a non-Claude agent must never be told to call CronCreate');
});

test('wake-directive: missing/invalid id -> ok:false, never crashes', () => {
  const r1 = cli.run(['wake-directive'], ctx({ DEVSWARM_AI_AGENT: 'claude' })).result;
  assert.equal(r1.ok, false);
  const r2 = cli.run(['wake-directive', '../../etc/passwd'], ctx({ DEVSWARM_AI_AGENT: 'claude' })).result;
  assert.equal(r2.ok, false);
});

// Wave 3 P2 fix: the argv id (what this verb was explicitly CALLED WITH) must
// win over ctx.env.DEVSWARM_BUILDER_ID (the caller's OWN process env, which can
// legitimately differ — e.g. a Primary asking `wake-directive <some-other-
// workspace-id>` to reprint a DIFFERENT workspace's directive, or a re-
// registration where env still carries a stale/truncated id). Before this fix,
// wakeDirective() resolved+embedded the ENV id internally before
// cmdWakeDirective's own placeholder substitution ever ran, so env id A leaked
// into the printed text instead of the requested argv id B.
test('wake-directive <id>: env DEVSWARM_BUILDER_ID (A) differs from argv id (B) -> directive names B, never A', () => {
  const r = cli.run(['wake-directive', 'id-B'],
    ctx({ DEVSWARM_AI_AGENT: 'claude', DEVSWARM_BUILDER_ID: 'id-A' })).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.directive.includes('id-B'), 'the argv id must be embedded');
  assert.ok(!r.directive.includes('id-A'), 'the env id must NOT leak into the printed directive');
});

test('wake-directive <id>: env DEVSWARM_BUILDER_ID (A) differs from argv id (B), CHILD workspace -> directive names B, never A', () => {
  const r = cli.run(['wake-directive', 'id-B'],
    ctx({ DEVSWARM_AI_AGENT: 'claude', DEVSWARM_SOURCE_BRANCH: 'feature/x', DEVSWARM_BUILDER_ID: 'id-A' })).result;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.isChild, true);
  assert.ok(r.directive.includes('id-B'), 'the argv id must be embedded');
  assert.ok(!r.directive.includes('id-A'), 'the env id must NOT leak into the printed directive');
});
