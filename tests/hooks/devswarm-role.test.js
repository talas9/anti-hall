'use strict';
// devswarm-role: DevSwarm TOPOLOGY gate (Primary vs child workspace). Pure
// truth table over env, per KB-devswarm-hivecontrol.md — DEVSWARM_SOURCE_BRANCH
// empty/unset = Primary, non-empty = child workspace.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { isChildWorkspace } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-role.js',
));

test('Primary: DEVSWARM_SOURCE_BRANCH unset -> false', () => {
  assert.strictEqual(isChildWorkspace({}), false);
});

test('Primary: DEVSWARM_SOURCE_BRANCH empty/whitespace -> false', () => {
  assert.strictEqual(isChildWorkspace({ DEVSWARM_SOURCE_BRANCH: '' }), false);
  assert.strictEqual(isChildWorkspace({ DEVSWARM_SOURCE_BRANCH: '   ' }), false);
});

test('child: DEVSWARM_SOURCE_BRANCH non-empty -> true', () => {
  assert.strictEqual(isChildWorkspace({ DEVSWARM_SOURCE_BRANCH: 'main' }), true);
});

test('fail-open: a throwing env-like object -> false (never throws out)', () => {
  const hostile = new Proxy({}, { get() { throw new Error('boom'); } });
  assert.strictEqual(isChildWorkspace(hostile), false);
});
