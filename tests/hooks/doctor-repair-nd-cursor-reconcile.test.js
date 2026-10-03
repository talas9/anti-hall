'use strict';
// reconcileStuckNdCursors (D1 forward migration) — doctor-repair.js's own sweep
// over ~/.anti-hall/devswarm/cursors/<id>#nd-<short6>.json.
//
// ROOT CAUSE (fixed separately in scripts/devswarm.js): `read-primary`/
// `peek-primary` used to ack the DESCRIPTOR cursor (`cursors/<id>.json`)
// while `tick`/`count` read the PER-INSTANCE file (`cursors/<id>#nd-<short6>
// .json`), so a caller that only ever used read-primary left its own
// instance file stuck behind forever. That code fix does not touch files
// already stuck on disk — this migration does, by raising each stuck
// instance cursor to `min(descriptorCursor, inboxLineCount)`.
//
// 'check' mode is read-only (reports {status:'pending', ...}); 'repair' mode
// mutates ONLY a strictly-behind instance cursor, clamped so it can never
// skip past real mail, and is a no-op on an already-healthy (ahead or equal)
// cursor.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const repair = require(REPAIR_JS);

function cursorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'cursors'); }
function inboxDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'inbox'); }

// seed(home, id, {descCursor, instCursor, inboxLines}) — write the descriptor
// cursor (`<id>.json`), the per-instance cursor (`<id>#nd-abc123.json`, both
// BARE JSON numbers per the verified on-disk format) and an inbox NDJSON with
// `inboxLines` non-empty lines.
function seed(home, id, { descCursor, instCursor, inboxLines, noDescriptor }) {
  fs.mkdirSync(cursorsDir(home), { recursive: true });
  fs.mkdirSync(inboxDir(home), { recursive: true });
  if (!noDescriptor) {
    fs.writeFileSync(path.join(cursorsDir(home), id + '.json'), String(descCursor));
  }
  const instPath = path.join(cursorsDir(home), id + '#nd-abc123.json');
  fs.writeFileSync(instPath, String(instCursor));
  const lines = [];
  for (let i = 0; i < inboxLines; i++) lines.push(JSON.stringify({ _h: 'native:' + id + '-' + i, message: 'm' + i }));
  fs.writeFileSync(path.join(inboxDir(home), id + '.ndjson'), lines.join('\n') + (lines.length ? '\n' : ''));
  return instPath;
}

test('check mode: a BEHIND instance cursor is reported pending and left untouched', () => {
  const h = makeHome();
  try {
    const instPath = seed(h.home, 'w1', { descCursor: 10, instCursor: 3, inboxLines: 10 });
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'check' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'pending');
    assert.ok(rows[0].msg.includes('instance=3') && rows[0].msg.includes('descriptor=10'));
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '3', 'check mode must never mutate');
  } finally { h.cleanup(); }
});

test('repair mode: a BEHIND instance cursor is raised to min(descriptor, inbox lines) — the ordinary case (descriptor <= inbox lines)', () => {
  const h = makeHome();
  try {
    const instPath = seed(h.home, 'w2', { descCursor: 10, instCursor: 3, inboxLines: 10 });
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'fixed');
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '10');
  } finally { h.cleanup(); }
});

test('repair mode: NEVER raises past the real inbox line count, even when the descriptor itself outran it', () => {
  const h = makeHome();
  try {
    // Descriptor claims 20 consumed, but the inbox only actually holds 8 lines
    // (e.g. a truncated/lossy write elsewhere) — raising to the descriptor
    // value would SKIP the 8 real lines never actually consumed.
    const instPath = seed(h.home, 'w3', { descCursor: 20, instCursor: 2, inboxLines: 8 });
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'fixed');
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '8', 'clamped to the real inbox line count, never the (larger) descriptor value');
  } finally { h.cleanup(); }
});

test('repair mode: NEVER lowers an instance cursor that is AHEAD of the clamp target', () => {
  const h = makeHome();
  try {
    const instPath = seed(h.home, 'w4', { descCursor: 5, instCursor: 9, inboxLines: 12 });
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 0, 'an ahead cursor is not even reported — nothing to fix');
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '9', 'must never be lowered');
  } finally { h.cleanup(); }
});

test('repair mode: a HEALTHY (equal) cursor is a no-op', () => {
  const h = makeHome();
  try {
    const instPath = seed(h.home, 'w5', { descCursor: 6, instCursor: 6, inboxLines: 6 });
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 0);
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '6');
  } finally { h.cleanup(); }
});

test('repair mode: a MALFORMED instance cursor is treated as 0 and raised (fail-open toward reconciling, never left corrupt)', () => {
  const h = makeHome();
  try {
    const instPath = seed(h.home, 'w6', { descCursor: 4, instCursor: 0, inboxLines: 4 });
    fs.writeFileSync(instPath, 'not-json-garbage'); // overwrite with a torn/unparseable value
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'fixed');
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '4');
  } finally { h.cleanup(); }
});

test('repair mode: a missing descriptor (no reconcile target) leaves the instance cursor completely untouched — never guessed at, never deleted', () => {
  const h = makeHome();
  try {
    const instPath = seed(h.home, 'w7', { descCursor: 0, instCursor: 1, inboxLines: 5, noDescriptor: true });
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 0, 'no descriptor -> not even considered');
    assert.ok(fs.existsSync(instPath), 'the instance cursor file itself must never be deleted');
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '1');
  } finally { h.cleanup(); }
});

test('idempotent: running repair mode twice in a row is a no-op the second time', () => {
  const h = makeHome();
  try {
    const instPath = seed(h.home, 'w8', { descCursor: 10, instCursor: 3, inboxLines: 10 });
    const rows1 = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows1.length, 1);
    assert.strictEqual(rows1[0].status, 'fixed');
    const rows2 = repair.reconcileStuckNdCursors({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows2.length, 0, 'second pass finds nothing left to reconcile');
    assert.strictEqual(fs.readFileSync(instPath, 'utf8').trim(), '10');
  } finally { h.cleanup(); }
});

test('no cursors dir at all -> returns [] without throwing (routine, e.g. a fresh install)', () => {
  const h = makeHome();
  try {
    const rows = repair.reconcileStuckNdCursors({ home: h.home, mode: 'check' });
    assert.deepStrictEqual(rows, []);
  } finally { h.cleanup(); }
});
