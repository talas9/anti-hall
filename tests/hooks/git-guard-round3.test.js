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

// --- Item 2: git accepts unique long-option prefixes; ambiguous => fail-closed.
const ABBREV_BLOCK = [
  '--del origin x', '--dele origin x', '--delet origin x', '--d origin x', '--pru origin', '--prun origin',
  '--force-w origin main', '--for origin main', '--forc origin main', '--mir origin', '--f origin main',
  '--fo origin main', '--force-wi origin main', '--force- origin main',
];
const ABBREV_ALLOW = [
  'origin main', '--tags origin', '--follow-tags origin main', '--set-upstream origin main', '-u origin main',
  '--dry-run origin main', '--force-if-includes origin main', '--force-i origin main', '--no-verify origin main',
  '--atomic origin main', '--no-force-with-lease origin main', '--follow origin main', '--set origin main',
  '--recurse-submodules=check origin main', '--all origin',
];
for (const a of ABBREV_BLOCK) {
  test(`BLOCK (long-option abbreviation): git push ${a}`, () => expect(`git push ${a}`, 2));
}
for (const a of ABBREV_ALLOW) {
  test(`ALLOW (long-option abbreviation control): git push ${a}`, () => expect(`git push ${a}`, 0));
}
test('ALLOW: an abbreviation-looking operand after `--` is a literal operand', () => expect('git push origin -- --del', 0));
