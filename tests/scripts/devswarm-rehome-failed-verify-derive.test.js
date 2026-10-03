'use strict';
// GAP C regression — rehomeAcrossStores(home, id, fromKey, toKey, ctx). On a
// FAILED verification it returned EARLY — AFTER already appending message rows
// into toStore (step 2) and upserting its registry (step 1) — but BEFORE the
// deriveSummary pair, leaving toStore's projection stale (delivered-but-invisible
// messages). Fixed: the failed-verification branch now also derives toStore's
// projection before returning.
//
// Forced via the F2 id-collision guard (devswarm.js:694-699 / devswarm-store.js's
// upsertRegistry): upsertRegistry silently SKIPS the write when a DIFFERENT
// non-null worktree_path already occupies this id, so `regPresent` is false and
// rehomeAcrossStores returns at the `regConflict` branch — no real git worktree
// needed, since this function never calls repoKeyForWorktree on its keys.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-rehome-fail-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const openS = (home, hash) => storeLib.openStore({ home, hash, backend: B.backend });

  test(`[${B.name}] rehomeAcrossStores: a FAILED verification (F2 id-collision conflict) still re-derives the destination projection`, () => {
    const home = tmpHome();
    try {
      const id = 'child-rehome-x';
      const fromKey = 'fromkey-' + B.name;
      const toKey = 'tokey-' + B.name;

      // fromStore: registry row for id + an unread direct message.
      const fromS = openS(home, fromKey);
      try {
        fromS.upsertRegistry({ id, worktreePath: '/fake/A', sessionId: 'sess-a' });
        const f = { from: 'sender-x', to: id, type: 'direct', message: 'payload-rehome', timestamp: Date.now(), urgency: 'normal' };
        storeLib.appendMeshMessage(fromS, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
      } finally { fromS.close(); }

      // toStore: a PRE-EXISTING registry row for the SAME id but a DIFFERENT
      // worktreePath -> the F2 guard refuses the incoming write from fromStore.
      const toS = openS(home, toKey);
      try { toS.upsertRegistry({ id, worktreePath: '/fake/B', sessionId: 'sess-b' }); } finally { toS.close(); }

      // Make "the projection was refreshed" unambiguous.
      try { fs.unlinkSync(storeLib.summaryPathForHash(home, toKey)); } catch (_) {}

      const out = cli.rehomeAcrossStores(home, id, fromKey, toKey, { backend: B.backend, env: {} });

      // Precondition: we hit the intended failure path, not some other early return.
      assert.strictEqual(out.rehomed, false, 'precondition: rehome did not complete (verification failed)');
      assert.strictEqual(out.regConflict, true, 'precondition: hit the F2 id-collision conflict branch');

      const sum = storeLib.readSummaryForHash(home, toKey);
      assert.ok(sum, 'the destination projection was derived even on the failed-verification path');

      // Source untouched (no-delete-until-verified contract still holds).
      const fromS2 = openS(home, fromKey);
      let fromReg;
      try { fromReg = fromS2.listRegistry(); } finally { fromS2.close(); }
      assert.ok(fromReg.some((r) => String(r.id) === id), 'the source registry row for id is untouched');
    } finally { rm(home); }
  });
}
