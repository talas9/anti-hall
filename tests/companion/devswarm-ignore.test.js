'use strict';
// devswarm-ignore.js — the user-editable ~/.anti-hall/devswarm/ignore.json
// {"ids":[...]} list that suppresses the URGENT/"not draining" nag for a
// listed id (see that module's header for the full rationale).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ignoreLib = require('../../plugins/anti-hall/companion/lib/devswarm-ignore.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ignore-'));
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

test('ignoreFilePath: <home>/.anti-hall/devswarm/ignore.json', () => {
  const home = '/some/home';
  assert.equal(ignoreLib.ignoreFilePath(home), path.join('/some/home', '.anti-hall', 'devswarm', 'ignore.json'));
});

test('isNagIgnored: false when the file does not exist at all (fail-open)', () => {
  const home = tmpHome();
  try {
    assert.equal(ignoreLib.isNagIgnored(home, 'anything'), false);
  } finally { rm(home); }
});

test('isNagIgnored: true for a listed id, false for one not listed', () => {
  const home = tmpHome();
  try {
    const p = ignoreLib.ignoreFilePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ids: ['abc-123', 'primary-68f24b6b'] }));
    assert.equal(ignoreLib.isNagIgnored(home, 'abc-123'), true);
    assert.equal(ignoreLib.isNagIgnored(home, 'primary-68f24b6b'), true);
    assert.equal(ignoreLib.isNagIgnored(home, 'not-listed'), false);
  } finally { rm(home); }
});

test('isNagIgnored: malformed JSON -> false, never throws (fail-open)', () => {
  const home = tmpHome();
  try {
    const p = ignoreLib.ignoreFilePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    assert.doesNotThrow(() => ignoreLib.isNagIgnored(home, 'abc-123'));
    assert.equal(ignoreLib.isNagIgnored(home, 'abc-123'), false);
  } finally { rm(home); }
});

test('isNagIgnored: {"ids": "not-an-array"} -> false, never throws (fail-open)', () => {
  const home = tmpHome();
  try {
    const p = ignoreLib.ignoreFilePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ids: 'abc-123' }));
    assert.equal(ignoreLib.isNagIgnored(home, 'abc-123'), false);
  } finally { rm(home); }
});

test('isNagIgnored: null id -> false, never throws', () => {
  const home = tmpHome();
  try {
    assert.equal(ignoreLib.isNagIgnored(home, null), false);
    assert.equal(ignoreLib.isNagIgnored(home, undefined), false);
  } finally { rm(home); }
});

test('readIgnoreIds: non-string entries in the ids array are skipped, never crash', () => {
  const home = tmpHome();
  try {
    const p = ignoreLib.ignoreFilePath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ids: ['ok-1', 42, null, {}, ''] }));
    const ids = ignoreLib.readIgnoreIds(home);
    assert.deepEqual(Array.from(ids).sort(), ['ok-1']);
  } finally { rm(home); }
});
