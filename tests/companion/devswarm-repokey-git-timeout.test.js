'use strict';
// devswarm-repokey — Wave D9: defaultRun's real `git` spawn is now bounded by
// a timeout (production default 10s; see devswarm-repokey.js's
// GIT_SPAWN_TIMEOUT_MS doc comment) so a `git` process stuck on a stale/
// unmounted worktree can never hang a repoKey lookup forever (defect
// f3c1bc827d89 root cause).
//
// This test proves the KILL-ON-TIMEOUT behavior against a REAL, deliberately-
// hanging fake `git` on PATH — not a mock of spawnSync — while staying well
// under 2s: `ANTIHALL_REPOKEY_GIT_TIMEOUT_MS` (a test-only override, see the
// module's doc comment) is set BEFORE requiring devswarm-repokey.js (its
// GIT_SPAWN_TIMEOUT_MS constant is computed once at module-load time), so
// this file's own process uses a 300ms timeout instead of the real 10s
// default — the fake git sleeps 5s, far longer than 300ms but the test still
// finishes in well under 2s because spawnSync kills it at 300ms.
//
// Isolated in its OWN test file (rather than added to
// devswarm-repokey.test.js) specifically so this file-load-time env override
// cannot affect any other test's use of the real defaultRun path — `node
// --test` runs each test file in its own process, so this override is scoped
// to this file alone regardless.

process.env.ANTIHALL_REPOKEY_GIT_TIMEOUT_MS = '300';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

test('defaultRun (default export): GIT_SPAWN_TIMEOUT_MS honors the test-only env override', () => {
  assert.strictEqual(repokey.GIT_SPAWN_TIMEOUT_MS, 300);
});

test('defaultRun: a git process that hangs past the timeout is killed, and the call reports ok:false — not a hang', { skip: process.platform === 'win32' }, () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fake-git-bin-'));
  const fakeGit = path.join(binDir, 'git');
  // A fake `git` that just sleeps far longer than the 300ms override — proves
  // the KILL, not merely a slow-but-under-timeout run.
  fs.writeFileSync(fakeGit, '#!/bin/sh\nsleep 5\necho should-never-print\n');
  fs.chmodSync(fakeGit, 0o755);

  const realPath = process.env.PATH;
  const t0 = Date.now();
  try {
    process.env.PATH = binDir + path.delimiter + realPath;
    const result = repokey.defaultRun({ args: ['rev-parse', '--show-toplevel'], cwd: os.tmpdir() });
    const elapsed = Date.now() - t0;
    assert.strictEqual(result.ok, false, 'a killed (timed-out) spawn must report ok:false, not hang or throw');
    assert.ok(elapsed < 2000, 'the call must return well under 2s (killed at ~300ms), took ' + elapsed + 'ms');
  } finally {
    process.env.PATH = realPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
