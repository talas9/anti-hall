'use strict';
// devswarm-detect: session-side liveness-supervisor feature gate. Pure truth
// table over env — reads only its argument, so no spawn/fs. Mirrors omc-detect's
// dormant-unless-feature-present contract. Workaround for claude-code#39755.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { detect, isDevswarmActive } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-detect.js',
));

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
