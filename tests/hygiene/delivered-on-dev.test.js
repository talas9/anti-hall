'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../../.github/scripts/moderation/delivered.js');

test('closes() reads Closes/Fixes/Resolves, same repo only, deduped', () => {
  assert.deepEqual(D.closes('Closes #5, fixes #6\nResolved #5\nCloses other/repo#9\nrefs #7'), [5, 6]);
  assert.deepEqual(D.closes(null), []);
});

const open = { state: 'open', comments: [] };

test('plan closes an open issue once, with the delivery comment', () => {
  const out = D.plan([{ number: 88, body: 'Closes #5', merge_commit_sha: 'abcdef1234567' }], () => open);
  assert.equal(out.length, 1);
  assert.equal(out[0].issue, 5);
  assert.match(out[0].body, /Delivered on dev in #88 \(abcdef12\); ships to main with the next release/);
});

test('idempotent: closed issue or existing marker yields nothing', () => {
  const pr = [{ number: 88, body: 'Closes #5', merge_commit_sha: 'abc' }];
  assert.deepEqual(D.plan(pr, () => ({ state: 'closed', comments: [] })), []);
  assert.deepEqual(D.plan(pr, () => ({ state: 'open', comments: [`${D.marker(88)}\nx`] })), []);
  assert.deepEqual(D.plan(pr, () => null), []);
});

test('two PRs naming one issue close it once; PR numbers are never closed', () => {
  const prs = [{ number: 1, body: 'Fixes #5' }, { number: 2, body: 'Closes #5 and #1' }];
  assert.equal(D.plan(prs, (n) => (n === 5 ? open : { state: 'open', pull_request: true, comments: [] })).length, 1);
});
