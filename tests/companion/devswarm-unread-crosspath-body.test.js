'use strict';
// companion/lib/devswarm-unread.js — R13 Auditor P2: migration-SKIPPED legacy
// lines were DOUBLE-COUNTED by the loss-free union.
//
// ROOT CAUSE (companion/devswarm-migrate.js migrateOne, the
// `if (!pendingIdx.has(i)) continue;` skip): a legacy NDJSON line whose body is
// already covered by the store's CROSS-PATH body multiset is deliberately NOT
// imported as its own `legacy:` row — the same message is already in the store
// from another path, under a `native:`/`global-migrate:` hash. The union's two
// hash tiers (`_h`, then legacyLineHash) therefore match NOTHING for that line,
// so it was counted once on the NDJSON side AND once on the store side.
//
// FIX (in the UNION, not by rewriting store hashes): a third tier — an NDJSON
// line with no `_h` whose legacy hash is absent from the store falls back to the
// SAME body-multiset draw-down the migration used (bodyMultisetOfRows +
// consumeBody, now defined in devswarm-unread.js and IMPORTED by the migration,
// so the two identities cannot drift). No persisted shape changes: the store's
// rows, hashes and cursors are untouched.
//
// MUTATION LIST (proven RED against this file):
//   M1: delete the TIER 2 body pass in unionUnread (restore
//       `storeOnlyTotalCount = totalUncovered.length`) -> the double count returns.
//   M2: make bodyCoveredRows ignore the `_h`/hash eligibility gates (cover every
//       line) -> kills "a genuinely distinct same-body message still counts".

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const store = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const migrate = require('../../plugins/anti-hall/companion/devswarm-migrate.js');
const unread = require('../../plugins/anti-hall/companion/lib/devswarm-unread.js');

const REPO_KEY = 'repo-crosspath';
const ID = 'ws1';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unread-crosspath-'));
  return { home, cleanup() { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// seed(lines, nativeBodies) -> { home, inboxPath, cursorPath, descriptor }
// Writes a legacy NDJSON inbox, pre-seeds the store with rows carrying
// `native:`-namespaced hashes for `nativeBodies` (exactly what the global-store
// split leaves behind), then runs the REAL migrateOne over it.
function seed(h, lines, nativeBodies, cursor) {
  const root = path.join(h.home, '.anti-hall', 'devswarm');
  const inboxPath = path.join(root, 'inbox', ID + '.ndjson');
  const cursorPath = path.join(root, 'cursor', ID + '.json');
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  fs.writeFileSync(inboxPath, lines.join('\n') + '\n');
  fs.writeFileSync(cursorPath, String(cursor || 0));
  const descriptor = { id: ID, worktreePath: path.join(h.home, 'wt'), sessionId: 's1', inboxPath, cursorPath };

  const s = store.openStore({ home: h.home, workspaceId: ID, hash: REPO_KEY });
  try {
    let n = 0;
    for (const body of (nativeBodies || [])) {
      s.appendMessage({ workspaceId: ID, body, hash: 'native:' + (n++), ts: 1000 });
    }
    const report = migrate.migrateOne(s, descriptor, fs, {});
    return { inboxPath, cursorPath, report };
  } finally { s.close(); }
}

function union(h, inboxPath, cursorPath) {
  const s = store.openStore({ home: h.home, workspaceId: ID, hash: REPO_KEY });
  try {
    return unread.unionUnread({ inboxPath, cursorPath, id: ID, storeHandle: s, now: 2000 });
  } finally { s.close(); }
}

test('a migration-SKIPPED (cross-path covered) line is counted ONCE, not twice', () => {
  const h = makeHome();
  try {
    const lines = ['{"m":"one"}', '{"m":"two"}', '{"m":"three"}'];
    // "one" is already in the store from another path, under a `native:` hash —
    // migrateOne therefore skips importing it as its own `legacy:` row.
    const { inboxPath, cursorPath, report } = seed(h, lines, ['{"m":"one"}'], 0);
    assert.strictEqual(report.imported, 2, 'exactly the two uncovered lines import');
    const u = union(h, inboxPath, cursorPath);
    assert.strictEqual(u.total, 3, 'three physical messages, three counted (was 4 pre-fix)');
    assert.strictEqual(u.unread, 3, 'cursor 0 -> all three unread, counted once each (was 4 pre-fix)');
    assert.strictEqual(u.storeOnlyUnreadRows.length, 0, 'the native-hashed twin is not a separate unread row');
  } finally { h.cleanup(); }
});

test('the cursor still applies over the deduped union', () => {
  const h = makeHome();
  try {
    const lines = ['{"m":"one"}', '{"m":"two"}', '{"m":"three"}'];
    const { inboxPath, cursorPath } = seed(h, lines, ['{"m":"one"}'], 2);
    const u = union(h, inboxPath, cursorPath);
    assert.strictEqual(u.total, 3);
    assert.strictEqual(u.unread, 1, 'two consumed -> exactly one unread');
  } finally { h.cleanup(); }
});

test('a genuinely DISTINCT same-body message still counts (multiset, not a Set)', () => {
  const h = makeHome();
  try {
    // Two identical bodies in the NDJSON, but only ONE native-path copy in the
    // store: the first occurrence is covered, the second is a real second
    // message and migrateOne imports it as its own legacy row.
    const lines = ['{"m":"dup"}', '{"m":"dup"}', '{"m":"other"}'];
    const { inboxPath, cursorPath, report } = seed(h, lines, ['{"m":"dup"}'], 0);
    assert.strictEqual(report.imported, 2);
    const u = union(h, inboxPath, cursorPath);
    assert.strictEqual(u.total, 3, 'three physical messages — the duplicate is not collapsed away');
    assert.strictEqual(u.unread, 3);
  } finally { h.cleanup(); }
});

test('a store row with NO NDJSON twin at all is still store-only (no over-suppression)', () => {
  const h = makeHome();
  try {
    const lines = ['{"m":"one"}'];
    const { inboxPath, cursorPath } = seed(h, lines, ['{"m":"one"}'], 0);
    // A mesh-direct `send --to` write: store-only, no NDJSON line anywhere.
    const s = store.openStore({ home: h.home, workspaceId: ID, hash: REPO_KEY });
    try { s.appendMessage({ workspaceId: ID, body: '{"m":"mesh-direct"}', hash: 'native:direct', ts: 1500 }); }
    finally { s.close(); }
    const u = union(h, inboxPath, cursorPath);
    assert.strictEqual(u.total, 2, 'the NDJSON line (deduped) + the store-only message');
    assert.strictEqual(u.unread, 2);
    assert.strictEqual(u.storeOnlyUnreadRows.length, 1);
  } finally { h.cleanup(); }
});

test('a native-drained NDJSON line (carrying _h) still dedupes on its hash, not its body', () => {
  const h = makeHome();
  try {
    // Two DISTINCT pulled messages that happen to share a body: each carries its
    // own `_h` and its own store row, so both must survive.
    const lines = ['{"_h":"h1","message":"same"}', '{"_h":"h2","message":"same"}'];
    const { inboxPath, cursorPath } = seed(h, lines, [], 0);
    const s = store.openStore({ home: h.home, workspaceId: ID, hash: REPO_KEY });
    try {
      s.appendMessage({ workspaceId: ID, body: 'same', hash: 'h1', ts: 1000 });
      s.appendMessage({ workspaceId: ID, body: 'same', hash: 'h2', ts: 1001 });
    } finally { s.close(); }
    const u = union(h, inboxPath, cursorPath);
    assert.strictEqual(u.total, 2, 'each pulled message counted exactly once');
    assert.strictEqual(u.unread, 2);
  } finally { h.cleanup(); }
});

test('an NDJSON line carrying _h never body-covers a row (only the migration skip is compensated)', () => {
  const h = makeHome();
  try {
    // The line was written by the NATIVE pull path (it carries `_h`), so its
    // store twin — if any — is keyed on that same `_h`. Here there is no such
    // twin, and a SEPARATE store-only row happens to hold the identical text.
    // The migration skip this fix compensates for can only produce _h-LESS
    // lines, so there is no evidence these two are the same message: counting
    // them as one would DROP a real message, the one direction a loss-free
    // union must never take.
    // The store row carries a `native:` hash and the line's own `_h` matches
    // nothing, so NEITHER hash tier fires and the line reaches the body tier —
    // where the `_h` gate is the ONLY thing that stops it. (Dropping that gate
    // makes this row vanish from the count.)
    const line = '{"_h":"h-absent","message":"identical text"}';
    const { inboxPath, cursorPath } = seed(h, [line], [line], 0);
    const u = union(h, inboxPath, cursorPath);
    assert.strictEqual(u.total, 2, 'no dedupe evidence -> both rows stand');
    assert.strictEqual(u.unread, 2);
  } finally { h.cleanup(); }
});

test('ONE DEFINITION: the migration draws its multiset down through the union module', () => {
  // If these ever became two copies, the union's third tier would stop agreeing
  // with the skip it exists to compensate for.
  assert.strictEqual(migrate.consumeBody, unread.consumeBody);
  const counts = unread.bodyMultisetOfRows([{ body: 'a' }, { body: 'a' }, { body: 'b' }]);
  assert.strictEqual(counts.get('a'), 2);
  assert.strictEqual(unread.consumeBody(counts, 'a'), true);
  assert.strictEqual(unread.consumeBody(counts, 'a'), true);
  assert.strictEqual(unread.consumeBody(counts, 'a'), false);
});
