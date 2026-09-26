'use strict';
// command-guard.js security regressions (0.111 review of the main-thread
// allowances: read-only verify, per-project allowlist, plain push). Every
// case here was a reproduced BLOCK -> ALLOW bypass; each must BLOCK again.
// All runs use a fresh isolated HOME and an explicit fixture repo/cwd.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'command-guard.js';

function makeRepo(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'cgsec-repo-')));
  cp.spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
  cp.spawnSync('git', ['-C', dir, 'add', 'f.txt']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function payload(command, cwd) {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 't',
    cwd,
  };
}

// run(command, {cwd, home}) -> spawn result. A caller-supplied home is kept
// (the caller cleans it up); otherwise a fresh one is made and removed.
function run(command, opts) {
  const o = opts || {};
  const own = o.home ? null : makeHome();
  const home = o.home || own.home;
  try {
    return testHook(HOOK, payload(command, o.cwd || fs.realpathSync(os.tmpdir())), {
      home, env: { CLAUDE_CODE_ENTRYPOINT: 'cli' },
    });
  } finally {
    if (own) own.cleanup();
  }
}

function withRepo(fn) {
  const repo = makeRepo();
  try { return fn(repo); } finally { fs.rmSync(repo, { recursive: true, force: true }); }
}

// ---- #5 splitter: a backslash outside quotes escapes the next char ----------

const SPLITTER_BLOCK = [
  // bash reads `\"` as a literal quote char, so `npm test` is its own command.
  'git add . && git commit -m \\" ; npm test ; echo \\" && git push',
  'node --test a.test.js \\" ; npm test ; echo \\" | tail',
  'echo \\" ; npm test ; echo \\"',
  // `\'` likewise opens no single-quote span: $(...) still expands.
  "git add . && git commit -m \\'$(npm test)\\' && git push",
];

for (const cmd of SPLITTER_BLOCK) {
  test('splitter: backslash-escaped quote does not hide a segment: ' + cmd, () => {
    withRepo((repo) => {
      const r = run(cmd, { cwd: repo });
      assert.strictEqual(r.status, 2, 'expected BLOCK for ' + cmd + '\n' + r.stdout);
    });
  });
}

test('splitter: a real double-quoted arg with an escaped quote inside stays one segment', () => {
  withRepo((repo) => {
    // `"a \" ; npm test ; b"` IS one quoted string in bash — no npm test runs.
    const r = run('git add . && git commit -m "a \\" ; npm test ; b" && git push', { cwd: repo });
    assert.strictEqual(r.status, 0, 'a genuinely quoted message must still be allowed: ' + r.stdout);
  });
});
