'use strict';
// devswarm-own-reader.js — the fix for defect f061789267c1 / a77b85571dfa (P0),
// re-based on mesh redesign Phase 3 (reader_cursors).
//
// computeSummary() sizes workspaces[id].unread from `total - floor(id)`: the
// partition's stored FLOOR, which is the MIN across live declared readers. That
// is correct for the summary's own contract but WRONG as a PER-READER display:
// a reader that has genuinely drained its own mail can still be shown a phantom
// backlog borrowed from a slower sibling reader. ownReaderDelta corrects the
// CALLER's own row by its OWN reader_cursors row.
//
// In-process: scripts/devswarm.js's deriveReaderNonce export and
// devswarm-unread.js's openStoreForUnread are patched on the cached module
// objects (the same instances devswarm-own-reader.js's lazy requires resolve
// to), so these tests drive a REAL journal store in a tmp HOME with no git.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = process.env.ANTIHALL_TEST_PLUGIN_ROOT
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const unread = require(path.join(ROOT, 'companion', 'lib', 'devswarm-unread.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const ownReader = require(path.join(ROOT, 'companion', 'lib', 'devswarm-own-reader.js'));

const HASH = 'ownreader-abcdef';
const ME = 'h:4242:1700000000000';
const SIB = 'h:4343:1700000000000';

function tmpHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ah-ownreader-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function open(home) { return storeLib.openStore({ home, hash: HASH, backend: 'journal' }); }
// seed(home, id, total, rows) — `total` messages in partition `id` plus the
// given reader_cursors rows ({ns, reader, value}).
function seed(home, id, total, rows) {
  const s = open(home);
  try {
    for (let i = 0; i < total; i++) s.appendMessage({ workspaceId: id, hash: id + '-m' + i, body: 'b' + i, ts: i + 1 });
    s.readerCursorTxn((tx) => { for (const r of rows) tx.put(Object.assign({ partition: id, updatedAt: 1 }, r)); });
  } finally { s.close(); }
}
function withEnv(home, nonce, fn, opts) {
  const o = opts || {};
  const origNonce = cli.deriveReaderNonce;
  const origOpen = unread.openStoreForUnread;
  cli.deriveReaderNonce = o.nonceThrows ? () => { throw new Error('SIMULATED'); } : () => nonce;
  unread.openStoreForUnread = o.noStore ? () => null : () => {
    const s = open(home);
    if (o.brokenRows) s.readerCursorRows = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    return s;
  };
  try { return fn(); } finally { cli.deriveReaderNonce = origNonce; unread.openStoreForUnread = origOpen; }
}
const floorRows = (v) => [{ ns: 'store', reader: '#floor', value: v }, { ns: 'nd', reader: '#floor', value: 0 }];

test('(a) live incident shape: own row 929, sibling row 859 (floor 859), total 930 -> the reader sees 1 unread, not 71', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 930, floorRows(859).concat([{ ns: 'store', reader: ME, value: 929 }, { ns: 'store', reader: SIB, value: 859 }]));
    const entry = { cursor: 859, total: 930, unread: 71 };
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', entry, 71));
    assert.strictEqual(got, 1);
  } finally { rm(home); }
});

test('(b) genuinely-unread case: nothing is hidden when the reader really is behind the floor', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 100, floorRows(40).concat([{ ns: 'store', reader: ME, value: 40 }]));
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 40, total: 100 }, 60));
    assert.strictEqual(got, 60);
  } finally { rm(home); }
});

test('(c) a declared reader with NO row yet reads AT the floor -> delta 0 (raw number)', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 10, floorRows(4));
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 4, total: 10 }, 6));
    assert.strictEqual(got, 6);
  } finally { rm(home); }
});

test('(d) HEADLESS caller (null reader nonce) -> floor view, delta 0 (Phase 3: headless reads the floor only)', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 930, floorRows(859).concat([{ ns: 'store', reader: SIB, value: 929 }]));
    const got = withEnv(home, null, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 859, total: 930 }, 71));
    assert.strictEqual(got, 71);
  } finally { rm(home); }
});

test('(e) two live readers at different positions each see their own correct number', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 100, floorRows(50).concat([{ ns: 'store', reader: ME, value: 90 }, { ns: 'store', reader: SIB, value: 50 }]));
    const entry = { cursor: 50, total: 100 };
    assert.strictEqual(withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', entry, 50)), 10);
    assert.strictEqual(withEnv(home, SIB, () => ownReader.ownReaderUnread(home, '/wt', 'w1', entry, 50)), 50);
  } finally { rm(home); }
});

test('resolution failure (deriveReaderNonce throws) fails open to the raw number, never worse', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 10, floorRows(0));
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 0, total: 10 }, 10), { nonceThrows: true });
    assert.strictEqual(got, 10);
  } finally { rm(home); }
});

test('old-shape entry with no `cursor` field leaves delta at 0', () => {
  const home = tmpHome();
  try {
    const r = withEnv(home, ME, () => ownReader.ownReaderDelta(home, '/wt', 'w1', { total: 10 }));
    assert.deepStrictEqual(r, { delta: 0, stale: false });
  } finally { rm(home); }
});

test('(f) STALE-CACHE: own row (1500) EXCEEDS the cached total (930) -> resolved LIVE via countFor, not guessed', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 1502, floorRows(859).concat([{ ns: 'store', reader: ME, value: 1500 }]));
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 859, total: 930 }, 71));
    assert.strictEqual(got, 2);
  } finally { rm(home); }
});

test('(g) STALE-CACHE, reader_cursors UNREADABLE -> null (UNKNOWN), never 0', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 930, floorRows(859).concat([{ ns: 'store', reader: ME, value: 930 }]));
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 859, total: 930 }, 71), { brokenRows: true });
    assert.strictEqual(got, null);
  } finally { rm(home); }
});

test('store cannot be opened (openStoreForUnread -> null) for a declared reader -> null (UNKNOWN), never a guessed number', () => {
  const home = tmpHome();
  try {
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 0, total: 5 }, 5), { noStore: true });
    assert.strictEqual(got, null);
  } finally { rm(home); }
});

test('own row at or below the floor (own === entry.cursor) -> delta 0, raw number', () => {
  const home = tmpHome();
  try {
    seed(home, 'w1', 10, floorRows(4).concat([{ ns: 'store', reader: ME, value: 4 }]));
    const got = withEnv(home, ME, () => ownReader.ownReaderUnread(home, '/wt', 'w1', { cursor: 4, total: 10 }, 6));
    assert.strictEqual(got, 6);
  } finally { rm(home); }
});
