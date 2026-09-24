'use strict';
// identity-missing-path — B3 P1 fix (mesh redesign). resolveContext's
// `missingPath` policy for a cwd that does not exist on disk (a worktree/
// session dir removed out from under a hook that still has it as its payload
// `cwd`). Two policies:
//   default / 'null': kind 'deleted', every field null — safe for anything
//     that FOLDS/PARTITIONS/KEYS by identity (registry rows, canonicalMeshId,
//     the identity-family collapse). This is B2's shipped default, unchanged.
//   'ancestor': resolve as if called with the nearest EXISTING ancestor
//     directory instead — the same walk-up findGitToplevel always did. Every
//     B3 hook site (command-guard's stash guard, parent-gate's own-unread
//     gate, parent-inbox's own-inbox nudge, child-gate/child-turn/parent-
//     reply-tracker's key resolution) and the statusline pass this, because a
//     policy enforced about "the repo the caller was just in" must not look
//     identical to "there is no repo here" just because the caller's own cwd
//     got removed mid-turn.
//
// Uses the SAME real-git fixture tree tests/companion/identity-equivalence.test.js
// does (tests/helpers/git-fixtures.js) — 'main/src/gone' (ancestor 'main/src'
// exists inside the 'main' git repo) and 'gone' (ancestor is the fixture root,
// not a git repo at all) are built in specifically for this.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { buildIdentityFixtures } = require('../helpers/git-fixtures.js');

const fx = buildIdentityFixtures();
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_PREFIX']) delete process.env[k];
process.env.HOME = fx.home;
process.env.USERPROFILE = fx.home;
process.env.ANTIHALL_INGEST_DRY_RUN = '1';

const identity = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'identity.js'));

after(() => { try { fx.cleanup(); } catch (_) {} });

test('missingPath default (no option): a deleted cwd is kind "deleted", every field null', () => {
  identity.clearCache();
  const ctx = identity.resolveContext(fx.cwds['main/src/gone']);
  assert.strictEqual(ctx.kind, 'deleted');
  assert.strictEqual(ctx.toplevel, null);
  assert.strictEqual(ctx.worktreeRoot, null);
  assert.strictEqual(ctx.repoKey, null);
  assert.strictEqual(ctx.meshId, null);
});

test('missingPath: "null" (explicit) behaves exactly like the default', () => {
  identity.clearCache();
  const a = identity.resolveContext(fx.cwds['main/src/gone']);
  identity.clearCache();
  const b = identity.resolveContext(fx.cwds['main/src/gone'], { missingPath: 'null' });
  assert.deepStrictEqual({ ...a }, { ...b });
});

test('missingPath: "ancestor" — a deleted path inside a repo resolves to the SAME context as its nearest existing ancestor', () => {
  identity.clearCache();
  const viaAncestorFallback = identity.resolveContext(fx.cwds['main/src/gone'], { missingPath: 'ancestor' });
  identity.clearCache();
  const viaDirectAncestor = identity.resolveContext(path.dirname(fx.cwds['main/src/gone']));
  assert.strictEqual(viaAncestorFallback.kind, 'main');
  assert.strictEqual(viaAncestorFallback.toplevel, fs.realpathSync(fx.main));
  assert.strictEqual(viaAncestorFallback.worktreeRoot, fs.realpathSync(fx.main));
  assert.strictEqual(viaAncestorFallback.repoKey, viaDirectAncestor.repoKey);
  assert.strictEqual(viaAncestorFallback.meshId, viaDirectAncestor.meshId);
});

test('missingPath: "ancestor" — a deleted path whose nearest existing ancestor is NOT a git repo resolves non-git, not deleted', () => {
  identity.clearCache();
  const ctx = identity.resolveContext(fx.cwds.gone, { missingPath: 'ancestor' });
  assert.strictEqual(ctx.kind, 'non-git');
  assert.strictEqual(ctx.toplevel, null);
  assert.strictEqual(ctx.repoKey, null);
});

test('missingPath: "ancestor" is a NO-OP for a cwd that exists — byte-identical to the default', () => {
  identity.clearCache();
  const withOpt = identity.resolveContext(fx.main, { missingPath: 'ancestor' });
  identity.clearCache();
  const withoutOpt = identity.resolveContext(fx.main);
  assert.deepStrictEqual({ ...withOpt }, { ...withoutOpt });
});
