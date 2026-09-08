'use strict';
// doctor-repair.js's checkLeakedTestFixtureStores — Wave D9, defect
// f3c1bc827d89: a test suite spawning a real subprocess with a full
// process.env copy in its env and no HOME override leaks a fixture registry row
// into the REAL ~/.anti-hall/devswarm/store/. This is a REPORT-ONLY detector
// (no deletion path anywhere, check mode included) — these tests exercise the
// detection heuristic in isolation against a tmp `home` fixture, never the
// real machine home.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-leaked-fixture-store-'));
}
function seedStore(home, hash, rows) {
  const s = storeLib.openStore({ home, hash, backend: 'journal' });
  try {
    for (const row of rows) s.upsertRegistry(row);
  } finally { s.close(); }
}

test('checkLeakedTestFixtureStores: no stores at all -> null (silent)', () => {
  const home = tmpHome();
  try {
    const result = doctorRepair.checkLeakedTestFixtureStores({ home, backend: 'journal' });
    assert.strictEqual(result, null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('checkLeakedTestFixtureStores: a store with a single row whose worktreePath is a NOW-DELETED tmp path is flagged', () => {
  const home = tmpHome();
  const goneWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-leaked-fixture-wt-'));
  fs.rmSync(goneWorktree, { recursive: true, force: true }); // the leaked fixture's own cleanup already ran
  try {
    seedStore(home, 'fake-repo-abc123', [{ id: 'leaked-1', worktreePath: goneWorktree, sessionId: 's' }]);
    const result = doctorRepair.checkLeakedTestFixtureStores({ home, backend: 'journal' });
    assert.ok(result, 'must be flagged');
    assert.strictEqual(result.atRisk, true);
    assert.strictEqual(result.count, 1);
    assert.strictEqual(result.examples.length, 1);
    assert.strictEqual(result.examples[0].worktreePath, goneWorktree);
    assert.match(result.message, /leaked test-fixture stores: 1/);
    assert.match(result.message, /--repair-test-stores/, 'points at the explicit, opt-in repair flag (be2c6c9e81a1) — this DETECT path still never deletes anything itself');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('checkLeakedTestFixtureStores: a store whose single row worktreePath still EXISTS on disk is NOT flagged (a live tmp-rooted project)', () => {
  const home = tmpHome();
  const liveWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-leaked-fixture-live-'));
  try {
    seedStore(home, 'fake-repo-def456', [{ id: 'live-1', worktreePath: liveWorktree, sessionId: 's' }]);
    const result = doctorRepair.checkLeakedTestFixtureStores({ home, backend: 'journal' });
    assert.strictEqual(result, null, 'a worktree that still exists on disk must never be flagged');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(liveWorktree, { recursive: true, force: true });
  }
});

test('checkLeakedTestFixtureStores: a store with a real (non-tmp) worktreePath is NOT flagged even if it does not exist', () => {
  const home = tmpHome();
  try {
    seedStore(home, 'fake-repo-real-789abc', [{ id: 'real-1', worktreePath: '/Users/someone/Projects/real-repo-moved-away', sessionId: 's' }]);
    const result = doctorRepair.checkLeakedTestFixtureStores({ home, backend: 'journal' });
    assert.strictEqual(result, null, 'a non-tmp-prefixed worktreePath must never be flagged, regardless of existence');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('checkLeakedTestFixtureStores: a store with MULTIPLE rows is NOT flagged (a real project accumulates many rows; a fixture seeds exactly one)', () => {
  const home = tmpHome();
  const gone1 = path.join(os.tmpdir(), 'anti-hall-leaked-fixture-gone-multi-1-' + Date.now());
  const gone2 = path.join(os.tmpdir(), 'anti-hall-leaked-fixture-gone-multi-2-' + Date.now());
  try {
    seedStore(home, 'fake-repo-multi-abc123', [
      { id: 'm1', worktreePath: gone1, sessionId: 's' },
      { id: 'm2', worktreePath: gone2, sessionId: 's' },
    ]);
    const result = doctorRepair.checkLeakedTestFixtureStores({ home, backend: 'journal' });
    assert.strictEqual(result, null, 'a multi-row store must never be flagged, even if every worktreePath is a gone tmp dir');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('checkLeakedTestFixtureStores: examples are capped at 5, and the message reports "+N more"', () => {
  const home = tmpHome();
  const goneDirs = [];
  try {
    for (let i = 0; i < 8; i++) {
      const gone = path.join(os.tmpdir(), 'anti-hall-leaked-fixture-cap-' + i + '-' + Date.now());
      goneDirs.push(gone);
      // hash must match devswarm-store.js's REPOKEY_SHAPE_RE
      // (^[a-z0-9-]{1,40}-[0-9a-f]{6}$) to be enumerated by listStoreHashes at all.
      seedStore(home, 'fake-repo-cap' + i + '-' + i.toString(16).padStart(6, '0'), [{ id: 'x' + i, worktreePath: gone, sessionId: 's' }]);
    }
    const result = doctorRepair.checkLeakedTestFixtureStores({ home, backend: 'journal' });
    assert.ok(result);
    assert.strictEqual(result.count, 8);
    assert.strictEqual(result.examples.length, 5, 'examples must be capped at 5');
    assert.match(result.message, /\+3 more/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('checkLeakedTestFixtureStores: fully defensive — a missing/broken store module -> null, never throws', () => {
  assert.doesNotThrow(() => {
    const result = doctorRepair.checkLeakedTestFixtureStores({ home: tmpHome(), storeModPath: '/no/such/module.js' });
    assert.strictEqual(result, null);
  });
});
