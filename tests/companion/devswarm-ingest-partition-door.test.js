'use strict';
// The ingest daemon writes native mail into its own partition through the ONE
// partition door (scripts/devswarm.js appendIntoPartition): the partition's
// per-id lock plus a registration recheck. Before this, ingestPayload called
// s.appendMessage directly — unlocked against a concurrent rehome/fold of the
// same id. A refused write (lock busy / id gone) must never drop the batch: it
// stays pending in the delivery WAL and is replayed, once, after the lock is
// released.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const readWal = require('../../plugins/anti-hall/companion/lib/devswarm-read-wal.js');
const recovery = require('../../plugins/anti-hall/companion/lib/recovery.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-door-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function count(home) {
  const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
  try { return s.messageCount('p'); } finally { s.close(); }
}

test('ingest: partition lock held by another writer -> batch stays pending in the WAL; after release it is appended exactly once', () => {
  const home = tmpHome();
  try {
    const batch = JSON.stringify([{ fromBranch: 'c', toBranch: 'p', message: 'held', createdAt: '2026-01-01T00:00:00Z' }]);
    const wal = readWal.walPath(home, 'monitor', 'p');
    const release = recovery.acquireLock('p', home); // another writer (not this process's withIdLock)
    assert.strictEqual(typeof release, 'function');
    let s1;
    try {
      s1 = ingest.runIngestLoop({
        home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1,
        run: () => ({ ok: true, raw: batch }), sleep: () => {},
      });
    } finally { release(); }
    assert.strictEqual(s1.started, true);
    assert.strictEqual(s1.stats.inserted, 0, 'nothing written while the partition lock is held');
    assert.strictEqual(count(home), 0);
    assert.strictEqual(readWal.pending(fs, wal).length, 1, 'the refused batch is kept pending in the delivery WAL');

    // Lock released: the next run replays the pending batch before any new read.
    const s2 = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1,
      run: () => ({ ok: true, raw: '' }), sleep: () => {},
    });
    assert.strictEqual(s2.stats.inserted, 1);
    assert.strictEqual(count(home), 1, 'appended once');
    assert.strictEqual(readWal.pending(fs, wal).length, 0, 'the WAL batch is closed');

    const s3 = ingest.runIngestLoop({
      home, backend: 'journal', workspaceId: 'p', worktree: null, maxIterations: 1,
      run: () => ({ ok: true, raw: batch }), sleep: () => {},
    });
    assert.strictEqual(s3.stats.inserted, 0);
    assert.strictEqual(count(home), 1, 'a re-observed batch is never appended twice');
  } finally { rm(home); }
});

test('ingestPayload: a busy partition throws EPARTITIONBUSY and writes nothing; an unregistered one throws EPARTITIONGONE', () => {
  const home = tmpHome();
  const s = storeLib.openStore({ home, workspaceId: 'p', backend: 'journal' });
  try {
    const batch = JSON.stringify([{ message: 'x', createdAt: '2026-01-01T00:00:00Z' }]);
    assert.throws(() => ingest.ingestPayload(s, batch, { workspaceId: 'p', home }), (e) => e.code === 'EPARTITIONGONE');
    s.upsertRegistry({ id: 'p', worktreePath: '/wt/p', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null });
    const release = recovery.acquireLock('p', home);
    try {
      assert.throws(() => ingest.ingestPayload(s, batch, { workspaceId: 'p', home }), (e) => e.code === 'EPARTITIONBUSY');
    } finally { release(); }
    assert.strictEqual(s.messageCount('p'), 0);
    assert.strictEqual(ingest.ingestPayload(s, batch, { workspaceId: 'p', home }).inserted, 1);
  } finally { s.close(); rm(home); }
});
