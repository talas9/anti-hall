'use strict';
// Markdown-cell escapers in engine/logic scripts must escape the backslash first (CodeQL js/incomplete-sanitization):
// otherwise a literal "\|" in the input re-opens the table cell.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const dir = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'engine', 'logic');

function load(file, fn) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const m = src.match(new RegExp('^function ' + fn + '\\(.*$', 'm'));
  assert.ok(m, fn + ' not found in ' + file);
  const sb = vm.createContext({ ah: { cfgNum: () => 200 } });
  vm.runInContext(m[0], sb);
  return sb[fn];
}

test('hhEsc escapes backslash before the pipe', () => {
  const hhEsc = load('handover-hygiene.js', 'hhEsc');
  assert.strictEqual(hhEsc('a\\|b'), 'a\\\\\\|b');
  assert.strictEqual(hhEsc('a|b\nc'), 'a\\|b c');
});

test('hhLink escapes backslash and brackets in the label', () => {
  const hhLink = load('handover-hygiene.js', 'hhLink');
  assert.strictEqual(hhLink('a\\]b', 'x y'), '[a\\\\\\]b](x%20y)');
});

test('psCell escapes backslash before the pipe', () => {
  const psCell = load('precompact-snapshot.js', 'psCell');
  assert.strictEqual(psCell('a\\|b'), 'a\\\\\\|b');
});
