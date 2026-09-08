'use strict';
// devswarm-role: DevSwarm TOPOLOGY gate (Primary vs child workspace). Pure
// truth table over env, per KB-devswarm-hivecontrol.md — DEVSWARM_SOURCE_BRANCH
// empty/unset = Primary, non-empty = child workspace.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { isChildWorkspace, isChildWorkspaceCorroborated } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'devswarm-role.js',
));

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-devswarm-role-'));
}

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

// ---------------------------------------------------------------------------
// isChildWorkspaceCorroborated — defect a55d6b71a76f fix (root cause C):
// DEVSWARM_SOURCE_BRANCH alone can leak into a Primary's env with no
// corroborating on-disk evidence. Requires EITHER a registered
// workspaces/<DEVSWARM_BUILDER_ID>.json descriptor OR cwd under the real
// DevSwarm worktree layout (~/.devswarm/repos/...) before treating a session
// as a gate-eligible child.
// ---------------------------------------------------------------------------

test('CORROBORATED: env says child + a registered descriptor exists -> true', () => {
  const home = tmpHome();
  try {
    const wdir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'w-1.json'), JSON.stringify({ id: 'w-1' }));
    const env = { DEVSWARM_SOURCE_BRANCH: 'feat/x', DEVSWARM_BUILDER_ID: 'w-1' };
    assert.strictEqual(isChildWorkspaceCorroborated(env, home, '/some/unrelated/cwd'), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CORROBORATED: env says child + cwd under the real DevSwarm worktree layout -> true (no descriptor needed)', () => {
  const home = tmpHome();
  try {
    const env = { DEVSWARM_SOURCE_BRANCH: 'feat/x', DEVSWARM_BUILDER_ID: 'w-2' };
    // P1 fix (gate-fix Wave 2 round-1 review): signal 2 now honors the
    // INJECTED `home` param (not os.homedir()) and requires cwd to exist as
    // a real directory — build the worktree cwd under the isolated tmp
    // `home` (never the real os.homedir(), which this test must not touch:
    // see "Tests never touch the real home" project convention) and
    // actually create it on disk.
    const cwd = path.join(home, '.devswarm', 'repos', '1', 'abcd1234', 'feat-x');
    fs.mkdirSync(cwd, { recursive: true });
    assert.strictEqual(isChildWorkspaceCorroborated(env, home, cwd), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('NOT CORROBORATED: env says child (leaked env var) but NO descriptor and cwd outside the worktree layout -> false', () => {
  const home = tmpHome();
  try {
    const env = { DEVSWARM_SOURCE_BRANCH: 'feat/leaked', DEVSWARM_BUILDER_ID: 'no-such-workspace' };
    assert.strictEqual(isChildWorkspaceCorroborated(env, home, '/Users/someone/some-primary-repo'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('NOT CORROBORATED: env says child, DEVSWARM_BUILDER_ID present but descriptor is for a DIFFERENT id -> false', () => {
  const home = tmpHome();
  try {
    const wdir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'w-other.json'), JSON.stringify({ id: 'w-other' }));
    const env = { DEVSWARM_SOURCE_BRANCH: 'feat/x', DEVSWARM_BUILDER_ID: 'w-mismatch' };
    assert.strictEqual(isChildWorkspaceCorroborated(env, home, '/unrelated/cwd'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('NOT CORROBORATED: Primary (env says NOT a child) -> false regardless of on-disk evidence', () => {
  const home = tmpHome();
  try {
    const wdir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'w-1.json'), JSON.stringify({ id: 'w-1' }));
    const env = { DEVSWARM_SOURCE_BRANCH: '', DEVSWARM_BUILDER_ID: 'w-1' };
    assert.strictEqual(isChildWorkspaceCorroborated(env, home, '/unrelated/cwd'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('fail-open: isChildWorkspaceCorroborated never throws on a hostile env', () => {
  const hostile = new Proxy({ DEVSWARM_SOURCE_BRANCH: 'x' }, { get() { throw new Error('boom'); } });
  assert.strictEqual(isChildWorkspaceCorroborated(hostile, tmpHome(), '/x'), false);
});
