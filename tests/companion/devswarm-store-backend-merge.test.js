'use strict';
// devswarm-store backend-consistency + split-store merge (defect #10 field
// report + owner-required repair follow-up). Two things under test:
//   1. resolveStoreBackend/openStore: two processes over the SAME store dir
//      with differing backend availability must never silently split into
//      two disjoint physical stores.
//   2. mergeSplitBackendStore(s): an ALREADY-split store (both physical forms
//      holding real data, e.g. created before the marker fix shipped) gets
//      the non-chosen side's messages/registry/cursors folded into the
//      chosen side — idempotent, no-delete.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devswarm-backend-merge-'));
}

test('resolveStoreBackend: an unforced open honors an already-persisted marker over this process\'s own feature-detect', () => {
  const home = tmpHome();
  const hash = 'proj-abc123';
  const dir = store.storeDirForHash(home, hash);
  fs.mkdirSync(dir, { recursive: true });
  store.writeBackendMarker(dir, 'journal');
  assert.strictEqual(store.resolveStoreBackend(dir, { env: {} }), 'journal');
});

test('resolveStoreBackend: a marker-less store with existing journal data infers journal, never a fresh empty sqlite pick', () => {
  const home = tmpHome();
  const hash = 'proj-def456';
  const dir = store.storeDirForHash(home, hash);
  const s = store.openJournal(home, null, null, null, { hash });
  s.appendMeshRow({ workspaceId: 'w1', ts: 1, hash: 'h1', body: 'hi', mtype: 'direct' });
  s.close();
  assert.ok(!store.readBackendMarker(dir), 'no marker should exist yet for this manually-opened handle');
  assert.strictEqual(store.resolveStoreBackend(dir, { env: {} }), 'journal');
});

// Only meaningful where node:sqlite is actually available (CI matrix node 22/24).
const HAS_SQLITE = store.sqliteAvailable();

(HAS_SQLITE ? test : test.skip)('mergeSplitBackendStore: journal-only messages/registry/cursors become visible via the chosen (sqlite) backend, exactly once, idempotent on a second run', () => {
  const home = tmpHome();
  const hash = 'proj-split1';
  const dir = store.storeDirForHash(home, hash);

  // Seed the sqlite side (the "chosen" backend, per marker) with one message.
  const sq = store.openSqlite(home, null, { hash });
  sq.appendMeshRow({ workspaceId: 'w1', ts: 100, hash: 'sq-1', body: 'sqlite native', sender: 'primary-aaa', mtype: 'direct' });
  sq.upsertRegistry({ id: 'w1', worktreePath: '/tmp/w1', sessionId: 's1', updatedAt: 100 });
  sq.setCursor('w1', 0);
  sq.close();
  store.writeBackendMarker(dir, 'sqlite');

  // Seed the journal side (the "other", non-chosen backend) with DIFFERENT
  // messages/registry that only exist there — simulating a pre-marker split.
  const jn = store.openJournal(home, null, null, null, { hash });
  jn.appendMeshRow({ workspaceId: 'w1', ts: 200, hash: 'jn-1', body: 'journal only', sender: 'primary-bbb', mtype: 'direct', needsReply: true });
  jn.appendMeshRow({ workspaceId: 'w2', ts: 210, hash: 'jn-2', body: 'journal only w2', sender: 'primary-bbb', mtype: 'broadcast' });
  jn.upsertRegistry({ id: 'w2', worktreePath: '/tmp/w2', sessionId: 's2', updatedAt: 210 });
  jn.setCursor('w1', 0);
  jn.close();

  // Dry run first: reports what WOULD merge, writes nothing.
  const dry = store.mergeSplitBackendStore(home, hash, { dryRun: true });
  assert.strictEqual(dry.split, true);
  assert.strictEqual(dry.messagesOnlyInOther, 2);
  assert.strictEqual(dry.registryMerged, 1); // w2 only-in-other; w1 already present, not newer enough to matter here
  const sqCheck = store.openSqlite(home, null, { hash, readOnly: true });
  assert.strictEqual(sqCheck.listMessages('w1').length, 1, 'dry run must not have written anything');
  sqCheck.close();

  // Apply.
  const applied = store.mergeSplitBackendStore(home, hash, {});
  assert.strictEqual(applied.ok, true);
  assert.strictEqual(applied.messagesMerged, 2);
  assert.strictEqual(applied.registryMerged, 1);

  const sqAfter = store.openSqlite(home, null, { hash, readOnly: true });
  const w1msgs = sqAfter.listMessages('w1');
  const w2msgs = sqAfter.listMessages('w2');
  assert.strictEqual(w1msgs.length, 2, 'w1 must now have BOTH the sqlite-native and the journal-only message, exactly once');
  assert.ok(w1msgs.some((m) => m.hash === 'sq-1'));
  assert.ok(w1msgs.some((m) => m.hash === 'jn-1' && m.needsReply === true));
  assert.strictEqual(w2msgs.length, 1);
  assert.ok(w2msgs.some((m) => m.hash === 'jn-2'));
  const reg = sqAfter.listRegistry();
  assert.ok(reg.some((r) => r.id === 'w2' && r.worktreePath === '/tmp/w2'));
  sqAfter.close();

  // Neither physical form was deleted/renamed (no-delete rule).
  assert.ok(fs.existsSync(path.join(dir, 'devswarm.db')));
  assert.ok(fs.existsSync(path.join(dir, 'journal', 'messages.ndjson')));
  assert.ok(fs.existsSync(store.mergeMarkerFile(dir)), 'a no-delete completion marker must be recorded');

  // Unread correctness: w1's cursor was 0 on both sides, so both messages
  // (including the one that was ONLY in the journal) are now correctly unread
  // via the chosen backend a live reader actually reads from.
  const sum = store.computeSummary(store.openSqlite(home, null, { hash, readOnly: true }), { home });
  assert.strictEqual(sum.workspaces.w1.directUnread, 2);

  // Second run: idempotent no-op — nothing left to merge, no duplicate rows.
  const second = store.mergeSplitBackendStore(home, hash, {});
  assert.strictEqual(second.pending, false);
  assert.strictEqual(second.messagesMerged, 0);
  const sqFinal = store.openSqlite(home, null, { hash, readOnly: true });
  assert.strictEqual(sqFinal.listMessages('w1').length, 2, 'a second merge run must not duplicate anything');
  sqFinal.close();
});

(HAS_SQLITE ? test : test.skip)('mergeSplitBackendStoresAllStores: sweeps every store hash, aggregates counts, skips non-split stores', () => {
  const home = tmpHome();
  // A clean, never-split store (repoKey-shaped hash: name-6hex).
  const cleanHash = 'projclean-abc123';
  const c = store.openSqlite(home, null, { hash: cleanHash });
  c.appendMeshRow({ workspaceId: 'w', ts: 1, hash: 'c-1', body: 'x', mtype: 'direct' });
  c.close();
  store.writeBackendMarker(store.storeDirForHash(home, cleanHash), 'sqlite');

  // A genuinely split store.
  const splitHash = 'projsplit-def456';
  const sq = store.openSqlite(home, null, { hash: splitHash });
  sq.close();
  store.writeBackendMarker(store.storeDirForHash(home, splitHash), 'sqlite');
  const jn = store.openJournal(home, null, null, null, { hash: splitHash });
  jn.appendMeshRow({ workspaceId: 'w', ts: 1, hash: 'j-1', body: 'hidden', mtype: 'direct' });
  jn.close();

  const dry = store.mergeSplitBackendStoresAllStores(home, { dryRun: true });
  assert.strictEqual(dry.splitStores, 1);
  assert.strictEqual(dry.errors, 0);

  const applied = store.mergeSplitBackendStoresAllStores(home, {});
  assert.strictEqual(applied.messagesMerged, 1);
});
