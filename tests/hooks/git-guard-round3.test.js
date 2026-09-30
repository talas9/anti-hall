'use strict';
// git-guard round-3 review fixes. Block => exit 2; allow => exit 0.

const { test } = require('node:test');
const assert = require('node:assert');
const { testHook, bashPayload } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function run(command) {
  const h = makeHome();
  try {
    return testHook('git-guard.js', bashPayload(command), { home: h.home });
  } finally {
    h.cleanup();
  }
}

function expect(cmd, status) {
  const r = run(cmd);
  assert.strictEqual(r.status, status, `expected exit ${status} for: ${JSON.stringify(cmd)}\nstderr: ${r.stderr}`);
}

// --- Item 1: a leading `!` negation is a wrapper word, like `if`/`then`.
const BANG_BLOCK = [
  'if ! git push -f; then :; fi',
  'while ! git push --force; do :; done',
  'if ! git push origin :main; then :; fi',
  'until ! git push -f; do :; done',
  'while ! git push origin +main; do :; done',
  'echo a\nif ! git push -f; then :; fi',
  '! git push -f',
  '! ! git push -f',
  'true && ! git push -f',
];
for (const cmd of BANG_BLOCK) {
  test(`BLOCK (bang wrapper): ${JSON.stringify(cmd)}`, () => expect(cmd, 2));
}
for (const cmd of ['if ! git status; then :; fi', 'if ! git push origin main; then :; fi', 'echo "a ! b"']) {
  test(`ALLOW (bang wrapper control): ${JSON.stringify(cmd)}`, () => expect(cmd, 0));
}
