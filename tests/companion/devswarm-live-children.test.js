'use strict';
// #39: companion/lib/devswarm-live-children.js hasLiveChild() — unit tests
// with injected deps (readDescriptors/repoKeyForWorktree/rowEligibility),
// independent of the integration coverage in
// tests/scripts/devswarm-inbox-tick-idle-skip.test.js (real git worktrees).

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-live-children.js');
const { hasLiveChild } = require(MODULE_PATH);

const SELF_CWD = '/repo/self';
const SELF_KEY = 'repoKeyA';

function keyFor(map) {
  return (wt) => {
    if (Object.prototype.hasOwnProperty.call(map, wt)) return map[wt];
    throw new Error('unexpected repoKeyForWorktree(' + wt + ')');
  };
}

test('0 descriptors registered -> false, without ever resolving a repoKey', () => {
  let repoKeyCalled = false;
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => [],
    repoKeyForWorktree: () => { repoKeyCalled = true; return SELF_KEY; },
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, false);
  assert.strictEqual(repoKeyCalled, false, 'the short-circuit for an empty registry must never spawn git');
});

test('one live (unarchived) same-project child -> true', () => {
  const descriptors = [{ id: 'child1', worktreePath: '/repo/child1', sessionId: 's1' }];
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => descriptors,
    repoKeyForWorktree: keyFor({ [SELF_CWD]: SELF_KEY, '/repo/child1': SELF_KEY }),
    rowEligibility: () => ({ archived: false }),
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, true);
});

test('an archived-only child (rowEligibility.archived true) counts as 0 live -> false', () => {
  const descriptors = [{ id: 'child1', worktreePath: '/repo/child1', sessionId: 's1' }];
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => descriptors,
    repoKeyForWorktree: keyFor({ [SELF_CWD]: SELF_KEY, '/repo/child1': SELF_KEY }),
    rowEligibility: () => ({ archived: true }),
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, false);
});

test('a descriptor from a DIFFERENT project (different repoKey) is never counted', () => {
  const descriptors = [{ id: 'other-project', worktreePath: '/repo/other', sessionId: 's1' }];
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => descriptors,
    repoKeyForWorktree: keyFor({ [SELF_CWD]: SELF_KEY, '/repo/other': 'repoKeyB' }),
    rowEligibility: () => { throw new Error('must never classify a foreign-project row'); },
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, false);
});

test('the Primary\'s OWN row (same realpath as cwd) is excluded, never counted as a child', () => {
  const descriptors = [{ id: 'primary-self', worktreePath: SELF_CWD, sessionId: 's1' }];
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => descriptors,
    repoKeyForWorktree: keyFor({ [SELF_CWD]: SELF_KEY }),
    rowEligibility: () => { throw new Error('must never classify the self row'); },
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, false);
});

test('a live child found AFTER an archived one in the list still returns true (does not stop early on the wrong verdict)', () => {
  const descriptors = [
    { id: 'archived1', worktreePath: '/repo/archived1', sessionId: 's1' },
    { id: 'live1', worktreePath: '/repo/live1', sessionId: 's2' },
  ];
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => descriptors,
    repoKeyForWorktree: keyFor({ [SELF_CWD]: SELF_KEY, '/repo/archived1': SELF_KEY, '/repo/live1': SELF_KEY }),
    rowEligibility: (row) => ({ archived: row.id === 'archived1' }),
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, true);
});

test('fail-open: an unresolvable selfKey (repoKeyForWorktree throws) -> true (never suppresses a real watcher on uncertainty)', () => {
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => [{ id: 'child1', worktreePath: '/repo/child1', sessionId: 's1' }],
    repoKeyForWorktree: () => { throw new Error('git not found'); },
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, true);
});

test('fail-open: readDescriptors throwing -> true', () => {
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => { throw new Error('unreadable registry'); },
    repoKeyForWorktree: () => SELF_KEY,
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, true);
});

test('fail-open: a single row\'s rowEligibility throwing is treated as archived for THAT row, never crashes the scan', () => {
  const descriptors = [
    { id: 'throws', worktreePath: '/repo/throws', sessionId: 's1' },
    { id: 'live1', worktreePath: '/repo/live1', sessionId: 's2' },
  ];
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => descriptors,
    repoKeyForWorktree: keyFor({ [SELF_CWD]: SELF_KEY, '/repo/throws': SELF_KEY, '/repo/live1': SELF_KEY }),
    rowEligibility: (row) => { if (row.id === 'throws') throw new Error('boom'); return { archived: false }; },
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, true, 'the OTHER live row must still be found after the throwing one');
});

test('a descriptor missing worktreePath or id is skipped, never crashes', () => {
  const descriptors = [{ id: 'no-worktree' }, { worktreePath: '/repo/no-id' }, null, undefined];
  const result = hasLiveChild('/home', SELF_CWD, {
    readDescriptors: () => descriptors,
    repoKeyForWorktree: () => SELF_KEY,
    fsi: { realpathSync: (p) => p },
  });
  assert.strictEqual(result, false);
});
