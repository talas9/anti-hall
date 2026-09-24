'use strict';
// Review round 3 P0 — a concurrent duplicate-fold appended new unread rows into a
// survivor S AFTER rehome had snapshotted S's source tail and BEFORE rehome
// tombstoned S in the source store. The fold also raised the candidate's cursor
// past the rows it forwarded, so they lived ONLY in S's old partition, which the
// tombstone made unreachable. Present on base 1e01598 (rehome under
// withIdLock(S); fold never took the survivor's lock).
//
// Deterministic interleaving: the source store handle rehome opens is wrapped so
// the fold runs exactly between rehome's snapshot and its tombstone, while the
// rehome holds withIdLock(S) exactly as its production callers do.
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
const rc = require(path.join(ROOT, 'companion', 'lib', 'reader-cursors.js'));
const { runForeign } = require('../helpers/foreign-process.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-rehome-fold-'));
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

test('a duplicate-fold racing a rehome never strands the rows it forwards into the survivor', () => {
  const home = tmpHome();
  const S = 'survivor-s';
  const C = 'phantom-c';
  const fromKey = 'from-race';
  const toKey = 'to-race';
  const bodies = ['for-c-0', 'for-c-1'];
  const s0 = openJ(home, fromKey);
  try {
    s0.upsertRegistry({ id: S, worktreePath: '/fake/S', sessionId: 'sess-s' });
    s0.upsertRegistry({ id: C, worktreePath: '/fake/S', sessionId: null });
    for (let i = 0; i < bodies.length; i++) {
      const f = { from: 'peer', to: C, type: 'direct', message: bodies[i], timestamp: 1700000000000 + i, urgency: 'normal' };
      storeLib.appendMeshMessage(s0, Object.assign({}, f, { hash: storeLib.meshMessageHash(f) }));
    }
  } finally { s0.close(); }

  // Wrap the source handle rehome opens: the concurrent fold runs right before
  // rehome's tombstone (after its snapshot + copy + verify).
  const origOpen = storeLib.openStore;
  let foldResult = null;
  storeLib.openStore = (o) => {
    const h = origOpen(o);
    if (o && o.hash === fromKey && String(o.workspaceId) === S && typeof h.removeRegistry === 'function' && !foldResult) {
      const realRemove = h.removeRegistry.bind(h);
      h.removeRegistry = (id) => {
        if (!foldResult) {
          // The concurrent duplicate-fold is ANOTHER process (a sweep/hook), exactly
          // as in production — it runs between rehome's snapshot and its tombstone.
          foldResult = runForeign('fold', { hash: fromKey, candidate: C, survivor: S }, home);
        }
        return realRemove(id);
      };
    }
    return h;
  };
  let out;
  try {
    out = cli.withIdLock(S, home, () => cli.rehomeAcrossStores(home, S, fromKey, toKey, { backend: 'journal', env: {} }));
  } finally { storeLib.openStore = origOpen; }
  assert.ok(foldResult, 'the interleaving hook ran');

  // Reachable = what a reader can still get to: S in the destination; S in the
  // source only while S is still registered there; C's UNREAD rows while C is.
  const reach = [];
  const src = openJ(home, fromKey);
  const dst = openJ(home, toKey);
  try {
    for (const m of dst.listMessages(S, { sinceCursor: 0 })) reach.push(m.body);
    const reg = src.listRegistry().map((d) => String(d.id));
    if (reg.includes(S)) for (const m of src.listMessages(S, { sinceCursor: 0 })) reach.push(m.body);
    if (reg.includes(C)) {
      const floor = rc.floorOf(src, C, 'store', { home });
      for (const m of src.listMessages(C, { sinceCursor: floor })) reach.push(m.body);
    }
  } finally { src.close(); dst.close(); }
  for (const b of bodies) {
    assert.ok(reach.some((r) => String(r).includes(b)),
      'row "' + b + '" is unreachable: ' + JSON.stringify({ out, fold: { forwarded: foldResult.forwarded, retired: foldResult.retired, skipped: foldResult.skipped }, reach }));
  }
});
