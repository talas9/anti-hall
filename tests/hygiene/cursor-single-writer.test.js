'use strict';
// Hygiene (mesh redesign Phase 3): ONE read-position model. Production code may
// not grow a second unread computation, a second nonce derivation, a rewind, or
// a new writer of the legacy per-instance cursor files. The allowlists below are
// the one-release dual-write shims; Phase 3b ratchets them to empty.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO = path.join(__dirname, '..', '..');
const PLUGIN = 'plugins/anti-hall/';

function productionFiles() {
  const r = cp.spawnSync('git', ['ls-files', '-co', '--exclude-standard', PLUGIN], { cwd: REPO, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'git ls-files failed: ' + r.stderr);
  return r.stdout.split('\n').filter((f) => f.endsWith('.js') && fs.existsSync(path.join(REPO, f)));
}
// codeLines(file) -> [{ n, text }] with whole-line comments dropped.
function codeLines(f) {
  return fs.readFileSync(path.join(REPO, f), 'utf8').split('\n')
    .map((text, i) => ({ n: i + 1, text }))
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.text));
}
function violations(re, allow) {
  const out = [];
  for (const f of productionFiles()) {
    for (const l of codeLines(f)) {
      if (!re.test(l.text)) continue;
      if (allow(f, l.text)) continue;
      out.push(f + ':' + l.n + ': ' + l.text.trim().slice(0, 120));
    }
  }
  return out;
}

test('every unread count goes through reader-cursors countFor (no direct unionUnread call)', () => {
  const v = violations(/\bunionUnread\s*\(/, (f, t) => f.endsWith('companion/lib/reader-cursors.js')
    || (f.endsWith('companion/lib/devswarm-unread.js') && /^\s*function unionUnread\(/.test(t)));
  assert.deepStrictEqual(v, []);
});

test('every nonce site uses deriveReaderNonce (no production deriveInstanceNonce call)', () => {
  const v = violations(/\bderiveInstanceNonce\s*\(/, (f, t) => /^\s*function deriveInstanceNonce\(/.test(t));
  assert.deepStrictEqual(v, []);
});

test('there is no rewind path (allowRewind / reconcileOrphanCursor are gone)', () => {
  assert.deepStrictEqual(violations(/allowRewind|reconcileOrphanCursor\s*\(/, () => false), []);
});

test('no production code writes the legacy #inst/#nd/#base files', () => {
  const legacyWriters = /\b(seedInstanceCursor|resolveNdCursorPath|projectNdDescriptorCursor|raiseAllInstanceCursors|raiseInstanceBaseline|readInstanceBaseline|instanceFloor)\s*\(/;
  // Their own (legacy, test-only) definitions and each other's bodies inside
  // scripts/devswarm.js's legacy block are the only allowed occurrences.
  const v = violations(legacyWriters, (f, t) => f.endsWith('scripts/devswarm.js')
    && (/^\s*function (raiseInstanceBaseline|readInstanceBaseline|instanceFloor)\(/.test(t)
      || /baseline = readInstanceBaseline\(storeHandle, home, id\);|const baseline = readInstanceBaseline\(storeHandle, home, id\);/.test(t)));
  assert.deepStrictEqual(v, []);
});

test('the legacy store cursor row is written only by the dual-write shim and the migrate import', () => {
  const v = violations(/\.setCursor\s*\(/, (f) => f.endsWith('companion/lib/reader-cursors.js')
    || f.endsWith('companion/devswarm-migrate.js'));
  assert.deepStrictEqual(v, []);
});
