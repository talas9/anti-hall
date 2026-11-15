'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseClosing } = require('./autoclose.js');

const keywords = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
const refKeywords = ['refs', 'part of'];
const repo = 'talas9/anti-hall';
const parse = (body, title = '') => parseClosing({ title, body, keywords, refKeywords, repo });

test('multiple keywords and forms', () => {
  assert.deepStrictEqual(parse('Closes #3\nFixes: #12 and resolved talas9/anti-hall#7'), [3, 7, 12]);
});
test('mixed case', () => assert.deepStrictEqual(parse('CLOSES #1, fIxEd #2'), [1, 2]));
test('title is parsed too', () => assert.deepStrictEqual(parse('', 'fix: thing (fixes #9)'), [9]));
test('Refs / Part of do not close', () => {
  assert.deepStrictEqual(parse('Refs #4\nPart of #5\nCloses #6'), [6]);
  assert.deepStrictEqual(parse('Closes #4\nRefs #4'), []);
});
test('other-repo refs ignored', () => assert.deepStrictEqual(parse('Closes other/repo#8\nCloses #2'), [2]));
test('code-fenced and inline-code text ignored', () => {
  assert.deepStrictEqual(parse('```\nCloses #10\n```\nCloses #11\nuse `Fixes #12` here\n<!-- Closes #13 -->'), [11]);
});
test('no false positives on word suffixes', () => {
  assert.deepStrictEqual(parse('prefixes #5, disclosed #6, Closes #7x'), []);
});
test('issue URL form', () => {
  assert.deepStrictEqual(parse('Closes https://github.com/talas9/anti-hall/issues/14'), [14]);
});
