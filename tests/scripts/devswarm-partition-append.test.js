'use strict';
// proves: plugins/anti-hall/scripts/devswarm.js#appendIntoPartition — busy/gone/ok outcomes, retry, and the archived-forward race below.
// appendIntoPartition — THE one door for moving rows into another partition
// (fold forward, archived forward). Review round 4:
//   P0  forwardArchivedOrphanUnread appended into the survivor with no lock and
//       no registration recheck, so a rehome of the survivor stranded the copy
//       (same class as devswarm-rehome-fold-race.test.js).
//   P1  a busy/gone forward must leave the source untouched and surface as
//       PENDING all the way up, so no per-version marker records "done"; the
//       next pass forwards.
//
// HERMETIC: every fixture HOME is a tmp dir; HOME/USERPROFILE are isolated.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const storeLib = require(path.join(ROOT, 'companion', 'lib', 'devswarm-store.js'));
const U = require(path.join(ROOT, 'skills', 'update', 'scripts', 'update.js'));
const { runForeign, holdForeignLock } = require('../helpers/foreign-process.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-part-append-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
test.before(() => { const iso = tmpHome(); process.env.HOME = iso; process.env.USERPROFILE = iso; });
test.after(() => {
  if (REAL_HOME !== undefined) process.env.HOME = REAL_HOME; else delete process.env.HOME;
  if (REAL_USERPROFILE !== undefined) process.env.USERPROFILE = REAL_USERPROFILE; else delete process.env.USERPROFILE;
});

const openJ = (home, hash) => storeLib.openStore({ home, hash, backend: 'journal' });
function seedDirect(s, to, body, ts) {
  const f = { from: 'peer', to, type: 'direct', message: body, timestamp: ts || Date.now(), urgency: 'normal' };
  storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
}

test('P0 forwardArchivedOrphanUnread racing a rehome of its survivor never strands the forwarded copy', () => {
  const home = tmpHome();
  const S = 'survivor-s';
  const ARCH = 'archived-orphan';
  const fromKey = 'from-arch-race';
  const toKey = 'to-arch-race';
  try {
    const s0 = openJ(home, fromKey);
    try { s0.upsertRegistry({ id: S, worktreePath: '/fake/S', sessionId: 'sess-s' }); seedDirect(s0, ARCH, 'orphan-mail'); } finally { s0.close(); }

    const origOpen = storeLib.openStore;
    let fwd = null;
    storeLib.openStore = (o) => {
      const h = origOpen(o);
      if (o && o.hash === fromKey && String(o.workspaceId) === S && !fwd) {
        const realRemove = h.removeRegistry.bind(h);
        h.removeRegistry = (id) => {
          if (!fwd) {
            // The concurrent heal is ANOTHER process, as in production.
            fwd = runForeign('forwardArchived', { hash: fromKey, source: ARCH, survivor: S }, home);
          }
          return realRemove(id);
        };
      }
      return h;
    };
    let out;
    try { out = cli.withIdLock(S, home, () => cli.rehomeAcrossStores(home, S, fromKey, toKey, { backend: 'journal', env: {} })); }
    finally { storeLib.openStore = origOpen; }
    assert.ok(fwd, 'the interleaving hook ran');

    const dst = openJ(home, toKey);
    let inDest;
    try { inDest = dst.listMessages(S, { sinceCursor: 0 }).some((m) => String(m.body).includes('orphan-mail')); } finally { dst.close(); }
    if (fwd.status === 'ok' || fwd.status === undefined) {
      assert.ok(inDest, 'a forward reported done must be reachable at the survivor: ' + JSON.stringify({ out, fwd }));
    } else {
      assert.strictEqual(fwd.forwarded, 0, 'a pending forward moves nothing');
    }
  } finally { rm(home); }
});

test('P1 retry: a fold whose survivor lock is busy is PENDING (source untouched), the next pass forwards and retires', () => {
  const home = tmpHome();
  const hash = 'retry-fold';
  const S = 'survivor-r';
  const C = 'phantom-r';
  try {
    const s = openJ(home, hash);
    try {
      s.upsertRegistry({ id: S, worktreePath: '/fake/R', sessionId: 'sess-r' });
      s.upsertRegistry({ id: C, worktreePath: '/fake/R', sessionId: null });
      seedDirect(s, C, 'retry-mail', 1700000000000);
      const cand = () => s.listRegistry().find((d) => String(d.id) === C);

      const release = holdForeignLock(S, home); // a LIVE foreign process holds the survivor
      let first;
      try { first = cli.foldGroupIntoSurvivor(s, home, S, [cand()]); } finally { release(); }
      assert.strictEqual(first.pending, 1, JSON.stringify(first));
      assert.deepStrictEqual(first.skipped, [{ id: C, reason: 'survivor-busy' }]);
      assert.strictEqual(first.forwarded, 0);
      assert.ok(s.listRegistry().some((d) => String(d.id) === C), 'the candidate is NOT tombstoned while pending');
      assert.strictEqual(s.listMessages(S, { sinceCursor: 0 }).length, 0, 'nothing forwarded while pending');

      const second = cli.foldGroupIntoSurvivor(s, home, S, [cand()]);
      assert.strictEqual(second.pending, 0, JSON.stringify(second));
      assert.strictEqual(second.forwarded, 1);
      assert.ok(s.listMessages(S, { sinceCursor: 0 }).some((m) => String(m.body) === 'retry-mail'), 'the retry forwards');
    } finally { s.close(); }
  } finally { rm(home); }
});

test('P1 retry: forwardArchivedOrphanUnread busy -> status busy, nothing moved; gone -> status gone; free -> ok', () => {
  const home = tmpHome();
  const hash = 'retry-arch';
  try {
    const s = openJ(home, hash);
    try {
      s.upsertRegistry({ id: 'live-s', worktreePath: '/fake/L', sessionId: 'sess-l' });
      seedDirect(s, 'arch-x', 'arch-mail');
      const release = holdForeignLock('live-s', home); // a LIVE foreign process holds it
      let busy;
      try { busy = cli.forwardArchivedOrphanUnread(s, 'arch-x', 'live-s', { home }); } finally { release(); }
      assert.deepStrictEqual([busy.status, busy.forwarded], ['busy', 0]);
      const gone = cli.forwardArchivedOrphanUnread(s, 'arch-x', 'never-registered', { home });
      assert.deepStrictEqual([gone.status, gone.forwarded], ['gone', 0]);
      assert.strictEqual(s.listMessages('never-registered', { sinceCursor: 0 }).length, 0);
      const ok = cli.forwardArchivedOrphanUnread(s, 'arch-x', 'live-s', { home });
      assert.deepStrictEqual([ok.status, ok.forwarded], ['ok', 1]);
    } finally { s.close(); }
  } finally { rm(home); }
});

for (const stage of [
  { key: 'foldAllStores', fn: 'foldAllStoresPostUpdate', dw: (pending) => ({ foldMeshDuplicates: () => ({ ok: true, retired: [], forwarded: 0, folded: 0, pending }) }) },
  { key: 'healOrphanPartitions', fn: 'healOrphanPartitionsPostUpdate', dw: (pending) => ({ healOrphanPartitions: () => ({ ok: true, adopted: 0, forwarded: 0, unhealable: 0, skipped: 0, pending, errors: 0, detail: [] }) }) },
]) {
  test(`P1 ${stage.fn}: a pass with PENDING rows is never stamped done; a clean pass is`, () => {
    const home = tmpHome();
    try {
      const run = (pending) => U[stage.fn]({
        paths: { pluginSrcDir: ROOT }, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), home,
        devswarm: stage.dw(pending), devswarmStore: { listStoreHashes: () => ['h1'] }, hashes: ['h1'], version: '9.9.9',
      });
      const r1 = run(1);
      assert.strictEqual(r1.attempted, true, JSON.stringify(r1));
      const st1 = U.readSweepState(home)[stage.key] || {};
      assert.notStrictEqual(st1.completedVersion, '9.9.9', 'pending rows must NOT stamp the version done: ' + JSON.stringify(st1));
      run(0);
      const st2 = U.readSweepState(home)[stage.key] || {};
      assert.strictEqual(st2.completedVersion, '9.9.9', 'a clean pass stamps it: ' + JSON.stringify(st2));
    } finally { rm(home); }
  });
}
