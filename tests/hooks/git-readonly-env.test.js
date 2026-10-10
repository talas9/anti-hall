'use strict';
// A read-only git child must never take .git/index.lock: a child killed at its timeout mid-refresh leaves the lock
// behind and blocks the user's own git. Every Node site that runs status/diff passes hooks/lib/git-env.js's env.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readOnlyGitEnv } = require('../../plugins/anti-hall/hooks/lib/git-env.js');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

test('readOnlyGitEnv sets GIT_OPTIONAL_LOCKS=0 and keeps the rest, without mutating the base', () => {
  const base = { PATH: '/x', GIT_OPTIONAL_LOCKS: '1' };
  const env = readOnlyGitEnv(base);
  assert.strictEqual(env.GIT_OPTIONAL_LOCKS, '0');
  assert.strictEqual(env.PATH, '/x');
  assert.strictEqual(base.GIT_OPTIONAL_LOCKS, '1');
  assert.strictEqual(readOnlyGitEnv().GIT_OPTIONAL_LOCKS, '0');
});

test('every Node site that runs git status/diff under a timeout uses the shared env', () => {
  const sites = [
    'hooks/git-guard.js', 'hooks/handover-resume.js', 'hooks/precompact-snapshot.js', 'statusline/statusline-rich.js',
    'companion/lib/devswarm-git-truth.js', 'companion/lib/devswarm-respawn.js', 'companion/lib/devswarm-lifecycle.js',
    'scripts/devswarm-lib/spawn.js', 'scripts/devswarm-lib/roster-diag.js', 'skills/update/scripts/update.js',
    'hooks/command-guard.js', 'engine/logic/command.js',
  ];
  for (const rel of sites) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(/readOnlyGitEnv|GIT_OPTIONAL_LOCKS/.test(src), rel + ' runs read-only git without GIT_OPTIONAL_LOCKS=0');
  }
});

test('a SIGTERM-killed read-only git call leaves no index.lock when the env is applied (stand-in git)', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-gitlock-'));
  const bin = path.join(dir, 'git');
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$GIT_OPTIONAL_LOCKS" != 0 ]; then : > "$(dirname "$0")/index.lock"; fi\nsleep 30\n', { mode: 0o755 });
  const lock = path.join(dir, 'index.lock');
  spawnSync(bin, [], { timeout: 1500, env: { PATH: process.env.PATH, HOME: dir, GIT_OPTIONAL_LOCKS: '1' } });
  assert.ok(fs.existsSync(lock), 'control: without the variable the killed child leaves the lock');
  fs.unlinkSync(lock);
  spawnSync(bin, [], { timeout: 1500, env: readOnlyGitEnv({ PATH: process.env.PATH, HOME: dir }) });
  assert.ok(!fs.existsSync(lock), 'with GIT_OPTIONAL_LOCKS=0 nothing is left');
  fs.rmSync(dir, { recursive: true, force: true });
});
