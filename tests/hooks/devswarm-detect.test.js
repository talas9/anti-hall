'use strict';
// devswarm-detect: session-side liveness-supervisor feature gate. Pure truth
// table over env — reads only its argument, so no spawn/fs. Mirrors omc-detect's
// dormant-unless-feature-present contract. Workaround for claude-code#39755.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { detect, isDevswarmActive, hasOnDiskDevswarmState } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-detect.js',
));
const { makeHome } = require('../helpers/fixtures.js');
const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const fs = require('node:fs');

test('dormant: DEVSWARM_REPO_ID unset (auto) -> false', () => {
  assert.strictEqual(isDevswarmActive({}), false);
  assert.strictEqual(detect({}).active, false);
});

test('auto: DEVSWARM_REPO_ID set -> true', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'repo-1' }), true);
  assert.strictEqual(detect({ DEVSWARM_REPO_ID: 'repo-1' }).repoId, 'repo-1');
});

test('auto: DEVSWARM_REPO_ID empty/whitespace -> false', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: '' }), false);
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: '   ' }), false);
});

test('hard kill-switch: DISABLE_ANTIHALL_DEVSWARM=1 overrides everything', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', DISABLE_ANTIHALL_DEVSWARM: '1' }), false);
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', ANTIHALL_DEVSWARM_SUPERVISOR: 'on', DISABLE_ANTIHALL_DEVSWARM: '1' }), false);
});

test('mode off: forces false even with DEVSWARM_REPO_ID', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', ANTIHALL_DEVSWARM_SUPERVISOR: 'off' }), false);
});

test('mode on: forces true even without DEVSWARM_REPO_ID', () => {
  assert.strictEqual(isDevswarmActive({ ANTIHALL_DEVSWARM_SUPERVISOR: 'on' }), true);
});

test('mode is case-insensitive and trimmed', () => {
  assert.strictEqual(isDevswarmActive({ DEVSWARM_REPO_ID: 'r', ANTIHALL_DEVSWARM_SUPERVISOR: '  OFF ' }), false);
  assert.strictEqual(isDevswarmActive({ ANTIHALL_DEVSWARM_SUPERVISOR: 'On' }), true);
});

test('fail-open: a throwing env-like object -> false (never throws out)', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.strictEqual(isDevswarmActive(hostile), false);
});

// hasOnDiskDevswarmState — secondary fix (088494cc3d3b latent path): the
// env-based fast path (isDevswarmActive) alone stays false forever for a
// Primary that never got DEVSWARM_REPO_ID injected into its process; this is
// the on-disk-evidence fallback (mirrors devswarm-wake-watch.js's
// isDevswarmActiveGate tier (d)).
test('hasOnDiskDevswarmState: true when summaries/<repoKey>.json exists for that repoKey', () => {
  const h = makeHome();
  try {
    const repoKey = 'some-repo-abc123';
    const p = store.summaryPathForHash(h.home, repoKey);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ workspaces: {} }));
    assert.strictEqual(hasOnDiskDevswarmState(h.home, repoKey), true);
  } finally {
    h.cleanup();
  }
});

test('hasOnDiskDevswarmState: false when no summary file exists for that repoKey (must not arm on a bare repo)', () => {
  const h = makeHome();
  try {
    assert.strictEqual(hasOnDiskDevswarmState(h.home, 'never-seen-repo-key'), false);
  } finally {
    h.cleanup();
  }
});

test('hasOnDiskDevswarmState: fail-open false on a missing/empty repoKey or home', () => {
  const h = makeHome();
  try {
    assert.strictEqual(hasOnDiskDevswarmState(h.home, null), false);
    assert.strictEqual(hasOnDiskDevswarmState(h.home, ''), false);
    assert.strictEqual(hasOnDiskDevswarmState(null, 'x'), false);
  } finally {
    h.cleanup();
  }
});
