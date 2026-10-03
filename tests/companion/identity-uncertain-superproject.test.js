'use strict';
// P2-b fix (companion/lib/identity.js) — resolveContext's git spawn
// (`rev-parse --show-superproject-working-tree`, identity.js's own
// gitSuperproject closure) collapsed a FAILED/TIMED-OUT spawn to the exact
// same `null` as a spawn that cleanly answered "no superproject" (exit 0,
// empty stdout). That ambiguity meant a git timeout while classifying a
// nested repo below another repo was read as "this dir IS the outermost
// repo" — a wrong but silent meshId, with no way for a caller to tell the
// two apart. This proves the new `uncertain` field on the returned Context:
// false on the clean confirmed answer, true when the spawn itself failed.

const { test, after } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');

const { buildIdentityFixtures } = require('../helpers/git-fixtures.js');
const identity = require('../../plugins/anti-hall/companion/lib/identity.js');

const fx = buildIdentityFixtures();
after(() => fx.cleanup());

// A shape that genuinely requires ONE gitSuperproject spawn to classify (an
// untracked nested repo below another repo — identity.js's own header names
// exactly this shape as the spawn trigger).
const CWD = fx.cwds['main/untracked'];

test('resolveContext: a CLEAN "no superproject" answer -> uncertain:false', () => {
  const realSpawn = (cmd, args, opts) => cp.spawnSync(cmd, args, opts);
  const ctx = identity.resolveContext(CWD, { memo: false, spawn: realSpawn });
  assert.strictEqual(ctx.uncertain, false, 'a real, successful git answer must not be flagged uncertain');
});

test('resolveContext: a git spawn ERROR (e.g. ETIMEDOUT) -> uncertain:true, never silently "no superproject"', () => {
  const failingSpawn = () => ({ error: Object.assign(new Error('spawn git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, stdout: '' });
  const ctx = identity.resolveContext(CWD, { memo: false, spawn: failingSpawn });
  assert.strictEqual(ctx.uncertain, true, 'a failed/timed-out git spawn must be flagged uncertain, not treated as a confirmed answer');
});

test('resolveContext: a non-zero git exit -> uncertain:true too (not just a hard spawn error)', () => {
  const nonZeroSpawn = () => ({ error: null, status: 128, stdout: '', stderr: 'fatal: some git error' });
  const ctx = identity.resolveContext(CWD, { memo: false, spawn: nonZeroSpawn });
  assert.strictEqual(ctx.uncertain, true);
});
