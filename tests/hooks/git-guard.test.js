'use strict';
// git-guard (PreToolUse Bash). Block => exit code 2; allow => exit 0.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, testHookRaw, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

const HOOK = 'git-guard.js';

// Each git-guard invocation gets a fresh fake HOME with no skip.json so the
// escape hatch is inert and the guard is fully active.
function run(command) {
  const h = makeHome();
  try {
    return testHook(HOOK, bashPayload(command), { home: h.home });
  } finally {
    h.cleanup();
  }
}

const BLOCK = [
  'git push --force',
  'git push -f',
  'git push --force-with-lease',
  'git push origin +main',
  'git push origin -- +main:main',
  'git -c alias.p=push p origin main --force',
  'git --config-env alias.p=push p origin main --force',
  'sudo git push --force',
  'true && git push -f',
  'git push origin "$(echo --force)"',
  'eval "git push -f"',
  'git commit -m "x\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>"',
  // FIX 1: --trailer carries the AI co-author trailer on the command line.
  'git commit -m x --trailer "Co-Authored-By: Claude <noreply@anthropic.com>"',
  'git commit -m x --trailer="Co-Authored-By: Claude <noreply@anthropic.com>"',
  // FIX A.1: git accepts the `key=value` trailer separator too.
  'git commit -m x --trailer "Co-Authored-By=Claude <noreply@anthropic.com>"',
  // FIX A.2: `-c trailer.<name>.key=<self-credit>` remaps a benign token to emit
  // a Co-Authored-By trailer, dodging the value scan.
  'git -c trailer.ai.key=Co-Authored-By commit -m x --trailer "ai: Claude <noreply@anthropic.com>"',
];

const ALLOW = [
  'git push origin main',
  'git push origin -- main',
  'git status',
  'git commit -m "feat: x"',
  'eval "git status"',
  // FIX 1: a benign trailer (human reviewer) must NOT be blocked.
  'git commit -m x --trailer "Reviewed-by: Alice"',
  // FIX A.1: a benign `=`-form trailer must still ALLOW.
  'git commit -m x --trailer "Reviewed-by=Alice"',
  // FIX A.2: a non-self-credit `-c trailer.*.key=` remap stays allowed.
  'git -c trailer.sob.key=Signed-off-by commit -m x --trailer "sob: Alice"',
];

for (const cmd of BLOCK) {
  test(`BLOCK: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 2, `expected block (exit 2) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

for (const cmd of ALLOW) {
  test(`ALLOW: ${cmd}`, () => {
    const r = run(cmd);
    assert.strictEqual(r.status, 0, `expected allow (exit 0) for: ${cmd}\nstderr: ${r.stderr}`);
  });
}

test('FAIL-OPEN: empty stdin -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});

test('FAIL-OPEN: malformed JSON -> allow', () => {
  const h = makeHome();
  try {
    assert.strictEqual(testHookRaw(HOOK, '{bad', { home: h.home }).status, 0);
  } finally {
    h.cleanup();
  }
});
