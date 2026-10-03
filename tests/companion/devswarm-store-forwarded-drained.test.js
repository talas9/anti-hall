'use strict';
// B2 fix: forwarded-drained orphan classification (companion to the archived-
// stranded split in devswarm-store-archived-stranded.test.js).
//
// DEFECT: an archived orphan whose identity family DOES have a live registry
// row is NOT archivedStranded (heal would forward into it, so it is
// "actionable"). But healOrphanPartitions' forward is FORWARD-ONLY (the source
// row is always left in place) and its cursor reconciliation is MIN-only (can
// only lower a cursor, never raise one) — so once every one of the orphan's
// unread rows has actually been forwarded into the survivor, the source
// partition's `unread` count NEVER decrements, and orphans[] nags about it
// every single turn forever with nothing left for a human or another heal pass
// to do.
//
// FIX: those ids move into a QUIET `forwardedDrained[]` field — but ONLY when
// EVERY currently-unread row is PROVEN, by an exact per-row hash match against
// the hash healOrphanPartitions' forwardArchivedOrphanUnread would compute for
// that row, to already be present in the survivor's partition. A single
// unmatched row (never forwarded, age-capped, or structurally non-forwardable)
// keeps the whole id in orphans[].
//
// MUTATIONS THIS FILE KILLS (see the named test for each):
//   (i)   count-based proof instead of hash-based
//         -> 'guard: right COUNT but WRONG hashes in survivor stays in orphans[]'
//   (ii)  dropping the "must be archived" requirement
//         -> 'guard: a LIVE (non-archived) orphan with unread stays in orphans[]'
//   (iii) dropping the count/ids from the quiet field (silent drop)
//         -> 'forwardedDrained[] entry carries {id, messageCount, unread}, never dropped'
//   (iv)  dropping the "must have a live family survivor" requirement (i.e.
//         conflating this with archivedStranded)
//         -> 'guard: archived orphan with NO family stays archivedStranded, never forwardedDrained'
//   (v)   treating a PARTIALLY forwarded id as fully drained
//         -> 'guard: archived orphan with a live survivor but ZERO rows forwarded stays in orphans[]'
//         -> 'guard: only SOME unread rows forwarded stays in orphans[]'

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-fwddrained-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
function devswarmRoot(home) { return path.join(home, '.anti-hall', 'devswarm'); }
function writeDescriptor(home, sub, id, desc) {
  const dir = path.join(devswarmRoot(home), sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(Object.assign({ id }, desc)), 'utf8');
}
const ids = (arr) => (arr || []).map((o) => o.id).sort();

// Same provenance-prefix format scripts/devswarm.js's private
// archivedForwardProvenancePrefix(id) produces (mirrored, not exported —
// see devswarm-orphan-policy.js's comment). Used here ONLY to build the exact
// hash a REAL forward would produce, so the fixture proves the hash-based
// (not count-based) mechanism.
function forwardPrefix(id) { return '[forwarded from archived ' + id + '] '; }

// seedUnreadDirect(s, orphanId, from, n) -> the n seeded rows' {sender, body, ts}
// (needed to recompute the exact forward hash later). Each row is a real DIRECT
// mesh message addressed to orphanId (mtype='direct', sender/recipient set), the
// exact row shape isForwardableRow requires.
function seedUnreadDirect(s, orphanId, from, n, tsBase) {
  const seeded = [];
  for (let i = 0; i < n; i++) {
    const body = 'msg-' + i;
    const ts = (tsBase || 1000) + i;
    const fields = { from, to: orphanId, type: 'direct', message: body, timestamp: ts, urgency: 'normal' };
    const hash = store.meshMessageHash(fields);
    store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    seeded.push({ sender: from, body, ts, urgency: 'normal' });
  }
  return seeded;
}

// forwardIntoSurvivor(s, orphanId, survivorId, rows) -> forwards every row into
// survivorId using the EXACT same field/hash recipe forwardArchivedOrphanUnread
// uses (to/type/urgency overridden, message provenance-prefixed, hash recomputed
// from the NEW fields). This is what "genuinely forwarded" looks like on disk.
function forwardIntoSurvivor(s, orphanId, survivorId, rows) {
  for (const m of rows) {
    const fields = {
      from: m.sender, to: survivorId, type: 'direct',
      message: forwardPrefix(orphanId) + m.body, timestamp: m.ts, urgency: m.urgency || 'normal',
    };
    const hash = store.meshMessageHash(fields);
    store.appendMeshMessage(s, Object.assign({}, fields, { hash }));
  }
}

function makeFamily(home, s) {
  const wt = path.join(home, 'wt-shared');
  fs.mkdirSync(wt, { recursive: true });
  s.upsertRegistry({ id: 'live-sibling', worktreePath: wt, sessionId: 'sess-live', inboxPath: '/i', cursorPath: '/c', nudgeCommand: null });
  writeDescriptor(home, 'workspaces', 'live-sibling', { worktreePath: wt, sessionId: 'sess-live' });
  writeDescriptor(home, 'archived', 'archived-with-family', { worktreePath: wt, sessionId: 'sess-old' });
  return wt;
}

const backends = [{ name: 'journal', backend: 'journal' }];
if (store.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const open = (home) => store.openStore({ home, backend: B.backend });

  // ---- RED/GREEN: the core fix -------------------------------------------
  test(`[${B.name}] RED->GREEN: archived orphan, ALL unread rows proven forwarded -> forwardedDrained, orphans empty`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      makeFamily(home, s);
      const rows = seedUnreadDirect(s, 'archived-with-family', 'someone', 3, 5000);
      // BEFORE the fix this id has 3 unread and no matching proof mechanism at
      // all, so it would show up in orphans[] (see the archived-stranded suite's
      // "archived orphan WITH a live identity-family survivor stays in orphans[]"
      // case for that pre-forward baseline — this test's fixture continues past
      // it into the state that DID NOT exist before this fix: full forward proof).
      forwardIntoSurvivor(s, 'archived-with-family', 'live-sibling', rows);

      const sum = store.computeSummary(s, { home, now: 999999 });
      assert.deepStrictEqual(ids(sum.orphans), [], 'GREEN: a fully-proven-forwarded archived orphan must not nag as orphans[]');
      assert.deepStrictEqual(ids(sum.forwardedDrained), ['archived-with-family'],
        'GREEN: it must be counted in the quiet forwardedDrained[] field');
      s.close();
    } finally { rm(home); }
  });

  test('forwardedDrained[] entry carries {id, messageCount, unread}, never dropped', () => {
    const home = tmpHome();
    try {
      const s = open(home);
      makeFamily(home, s);
      const rows = seedUnreadDirect(s, 'archived-with-family', 'someone', 3, 5000);
      forwardIntoSurvivor(s, 'archived-with-family', 'live-sibling', rows);
      const sum = store.computeSummary(s, { home, now: 999999 });
      assert.deepStrictEqual(sum.forwardedDrained[0], { id: 'archived-with-family', messageCount: 3, unread: 3 },
        'the count must be carried, not silently dropped (KB #28 shape)');
      s.close();
    } finally { rm(home); }
  });

  // ---- Guard (a): NOT forwarded at all -----------------------------------
  test(`[${B.name}] guard: archived orphan with a live survivor but ZERO rows forwarded stays in orphans[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      makeFamily(home, s);
      seedUnreadDirect(s, 'archived-with-family', 'someone', 2, 5000);
      // deliberately NOT forwarded into live-sibling
      const sum = store.computeSummary(s, { home, now: 999999 });
      assert.deepStrictEqual(ids(sum.orphans), ['archived-with-family']);
      assert.equal(sum.forwardedDrained, undefined);
      s.close();
    } finally { rm(home); }
  });

  // ---- Guard (b): only SOME rows forwarded -------------------------------
  test(`[${B.name}] guard: only SOME unread rows forwarded stays in orphans[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      makeFamily(home, s);
      const rows = seedUnreadDirect(s, 'archived-with-family', 'someone', 3, 5000);
      forwardIntoSurvivor(s, 'archived-with-family', 'live-sibling', rows.slice(0, 2)); // 2 of 3
      const sum = store.computeSummary(s, { home, now: 999999 });
      assert.deepStrictEqual(ids(sum.orphans), ['archived-with-family'],
        'a partial forward must NOT be treated as fully drained');
      assert.equal(sum.forwardedDrained, undefined);
      s.close();
    } finally { rm(home); }
  });

  // ---- Guard (c) / Mutation (ii): a LIVE (non-archived) orphan with unread
  test(`[${B.name}] guard: a LIVE (non-archived) orphan with unread stays in orphans[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-live');
      fs.mkdirSync(wt, { recursive: true });
      // A live family survivor exists AND every unread row will be given a
      // matching hash in it — i.e. EVERY OTHER condition forwardedDrained
      // requires is satisfied. Only "archived" is false. If the archived gate
      // were ever dropped (mutation ii) this would wrongly classify drained.
      s.upsertRegistry({ id: 'live-sibling-2', worktreePath: wt, sessionId: 'sess-live', inboxPath: '/i', cursorPath: '/c', nudgeCommand: null });
      writeDescriptor(home, 'workspaces', 'live-sibling-2', { worktreePath: wt, sessionId: 'sess-live' });
      writeDescriptor(home, 'workspaces', 'live-orphan', { worktreePath: wt, sessionId: 'sess-x' });
      // deliberately NOT archived -> writeDescriptor('archived', ...) skipped
      const rows = seedUnreadDirect(s, 'live-orphan', 'someone', 1, 5000);
      forwardIntoSurvivor(s, 'live-orphan', 'live-sibling-2', rows);
      const sum = store.computeSummary(s, { home, now: 999999 });
      assert.deepStrictEqual(ids(sum.orphans), ['live-orphan'],
        'MUTATION KILL (ii): a non-archived orphan must never be classified forwardedDrained even with a proven hash match');
      assert.equal(sum.forwardedDrained, undefined);
      s.close();
    } finally { rm(home); }
  });

  // ---- Guard (d): archived orphan with NO family stays archivedStranded --
  test(`[${B.name}] guard: archived orphan with NO family stays archivedStranded, never forwardedDrained`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const wt = path.join(home, 'wt-dead');
      writeDescriptor(home, 'archived', 'dead-child', { worktreePath: wt, sessionId: 'sess-dead' });
      seedUnreadDirect(s, 'dead-child', 'someone', 3, 5000);
      const sum = store.computeSummary(s, { home, now: 999999 });
      assert.deepStrictEqual(ids(sum.archivedStranded), ['dead-child']);
      assert.equal(sum.orphans, undefined);
      assert.equal(sum.forwardedDrained, undefined);
      s.close();
    } finally { rm(home); }
  });

  // ---- Mutation (i): count-based instead of hash-based -------------------
  test(`[${B.name}] guard: right COUNT but WRONG hashes in survivor stays in orphans[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      makeFamily(home, s);
      const rows = seedUnreadDirect(s, 'archived-with-family', 'someone', 3, 5000);
      // Insert exactly 3 messages into the survivor (right COUNT) but with
      // DIFFERENT bodies, so none of the 3 recomputed hashes can possibly match.
      // A count-based ("survivor gained >= unread messages") mutant would pass
      // this; the real hash-based proof must fail it.
      for (let i = 0; i < rows.length; i++) {
        const fields = { from: 'someone', to: 'live-sibling', type: 'direct', message: 'UNRELATED-' + i, timestamp: 9000 + i, urgency: 'normal' };
        store.appendMeshMessage(s, Object.assign({}, fields, { hash: store.meshMessageHash(fields) }));
      }
      const sum = store.computeSummary(s, { home, now: 999999 });
      assert.deepStrictEqual(ids(sum.orphans), ['archived-with-family'],
        'MUTATION KILL (i): a count match with wrong hashes must never be classified drained');
      assert.equal(sum.forwardedDrained, undefined);
      s.close();
    } finally { rm(home); }
  });

  // ---- Guard (e): broadcast partition unaffected -------------------------
  test(`[${B.name}] guard: broadcast partition is excluded from forwardedDrained[]`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      store.appendMeshMessage(s, { from: 'someone', body: 'hello mesh', ts: 5 });
      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.ok(!ids(sum.forwardedDrained).includes(store.BROADCAST_PARTITION_ID));
      s.close();
    } finally { rm(home); }
  });

  // ---- clean projection stays byte-identical (additive, omitted when empty)
  test(`[${B.name}] a clean projection carries no forwardedDrained key`, () => {
    const home = tmpHome();
    try {
      const s = open(home);
      const sum = store.computeSummary(s, { home, now: 1000 });
      assert.equal(Object.prototype.hasOwnProperty.call(sum, 'forwardedDrained'), false);
      s.close();
    } finally { rm(home); }
  });
}
