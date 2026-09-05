'use strict';
// Wave C2 — item 5. EXACT CROSS-PARTITION DEDUP OF FORWARDED COPIES
// (defect 64861a623503, P1).
//
// FIELD EVIDENCE: right after 0.89.0 a Primary's `inbox count` went 0 -> 551
// unread. Draining took 608 reads across 4 batches. 438 of those bodies carried
// `[forwarded from archived …]`, 75 were exact resends, and ZERO were new to
// the reader. The forward RE-ADDRESSES the row, so its hash is necessarily
// different from the original's, and the reader had ALREADY CONSUMED every
// original — so no dedup key existed that could connect the two.
//
// THE FIX, in three parts:
//   (a) a forwarded copy stores the ORIGINAL's hash as `origHash` (additive,
//       nullable column; doctor and every reader tolerate its absence);
//   (b) the fold matches `seenHashes` against `origHash` as well as `hash`, and
//       seeds `seenHashes` from the caller's CONSUMED history (bounded to the
//       newest K rows below its cursor) rather than only from current unread —
//       "I already handled this" is not expressible without that;
//   (c) a copy forwarded by an OLDER build carries no `origHash`, so the
//       original's hash is RECONSTRUCTED from the forwarded row itself: the
//       envelope changes exactly two hashed fields and both are invertible.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEVSWARM_PATH = path.join(__dirname, '../../plugins/anti-hall/scripts/devswarm.js');
const cli = require(DEVSWARM_PATH);
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wavec2-fwd-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wavec2-fwdrepo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// An ORIGINAL direct addressed to `to`, exactly as a real `send` would append it.
function originalFields(to, body, ts) {
  return { from: 'peer-a', to, type: 'direct', urgency: 'normal', message: body, timestamp: ts };
}

// A FORWARDED copy of `orig` into `survivor`, built the way
// forwardArchivedOrphanUnread builds one — with or without the new `origHash`
// stamp, so the legacy shape can be modelled exactly.
function forwardedRow(archivedId, survivor, orig, withOrigHash) {
  const body = cli.archivedForwardProvenancePrefix(archivedId) + orig.message;
  const fields = {
    from: orig.from, to: survivor, type: 'direct', urgency: orig.urgency,
    message: body, timestamp: orig.timestamp,
  };
  const row = {
    ts: fields.timestamp, hash: storeLib.meshMessageHash(fields), body,
    sender: fields.from, recipient: survivor, mtype: 'direct',
    urgency: fields.urgency, isHeartbeat: false, needsReply: false,
    origHash: withOrigHash ? storeLib.meshMessageHash(orig) : null,
  };
  return row;
}

// ---------------------------------------------------------------------------
// (c) LEGACY RECONSTRUCTION — no store, no fixtures, pure identity arithmetic.
// ---------------------------------------------------------------------------

test('item 5 (c): the original hash is reconstructed EXACTLY from a legacy forwarded row (no origHash)', () => {
  const orig = originalFields('archived-x', 'the original body', 123456);
  const expected = storeLib.meshMessageHash(orig);
  const legacy = forwardedRow('archived-x', 'survivor-y', orig, false);
  assert.equal(legacy.origHash, null, 'fixture precondition: the legacy copy carries no origHash');
  assert.equal(cli.forwardedOrigHashOf(legacy), expected,
    'reconstruction must reproduce the original\'s hash byte-for-byte — this is what makes the ~438 already-forwarded field rows dedupable with no backfill');
});

test('item 5 (c): a STAMPED origHash is preferred over reconstruction, and a non-forward row yields null', () => {
  const orig = originalFields('archived-x', 'body', 999);
  const stamped = forwardedRow('archived-x', 'survivor-y', orig, true);
  assert.equal(cli.forwardedOrigHashOf(stamped), storeLib.meshMessageHash(orig));

  assert.equal(cli.forwardedOrigHashOf({ body: 'an ordinary direct', sender: 'p', ts: 1 }), null,
    'a row with no provenance prefix and no origHash has no original to point at');
  assert.equal(cli.forwardedOrigHashOf(null), null);
  assert.equal(cli.forwardedOrigHashOf({ body: null }), null);
});

test('item 5 (c): the provenance prefix round-trips through strip, including a body that itself contains brackets', () => {
  const body = '[not a prefix] the real text';
  const stripped = cli.stripArchivedForwardPrefix(cli.archivedForwardProvenancePrefix('arch-1') + body);
  assert.equal(stripped.archivedId, 'arch-1');
  assert.equal(stripped.body, body, 'only the OUTER envelope is removed; the body is returned verbatim');
  assert.deepEqual(cli.stripArchivedForwardPrefix('plain body'), { archivedId: null, body: 'plain body' });
});

// ---------------------------------------------------------------------------
// (a)+(b) THE FOLD — suppression of a consumed original's forward, delivery of
// an unconsumed one's, and the cursor invariant.
// ---------------------------------------------------------------------------

test('item 5: a forwarded copy of a CONSUMED original is suppressed (RED: with an empty seed it is delivered)', () => {
  const orig = originalFields('archived-1', 'already handled', 5000);
  const copy = forwardedRow('archived-1', 'primary-1', orig, true);

  // RED — the pre-fix world: `seenHashes` seeded only from CURRENT UNREAD, which
  // for a consumed original is empty. The copy is delivered as if it were new.
  const red = cli.foldSiblingGapRows([copy], new Set(), new Set());
  assert.equal(red.deliveredCount, 1, 'RED: with nothing seeded from consumed history the copy is delivered');

  // GREEN — the consumed original's hash is in the seed.
  const seeded = new Set([storeLib.meshMessageHash(orig)]);
  const green = cli.foldSiblingGapRows([copy], seeded, new Set());
  assert.equal(green.deliveredCount, 0, 'THE FIX: the copy matches the consumed original by origHash and is suppressed');
  assert.equal(green.consumedCount, 1, 'an exact-hash match is proof of identity, so the cursor MAY pass it');
});

test('item 5: a LEGACY forwarded copy (no origHash) is suppressed by reconstruction alone', () => {
  const orig = originalFields('archived-2', 'legacy handled', 6000);
  const copy = forwardedRow('archived-2', 'primary-1', orig, false);
  const seeded = new Set([storeLib.meshMessageHash(orig)]);
  const folded = cli.foldSiblingGapRows([copy], seeded, new Set());
  assert.equal(folded.deliveredCount, 0,
    'no persisted backfill is needed: the original hash is recomputed from the copy itself');
});

test('item 5: an UNCONSUMED original\'s forward is still DELIVERED — the fix suppresses only what was handled', () => {
  const handled = originalFields('archived-3', 'handled', 7000);
  const fresh = originalFields('archived-3', 'never seen', 7001);
  const rows = [
    forwardedRow('archived-3', 'primary-1', handled, true),
    forwardedRow('archived-3', 'primary-1', fresh, true),
  ];
  const seeded = new Set([storeLib.meshMessageHash(handled)]); // only the handled one
  const folded = cli.foldSiblingGapRows(rows, seeded, new Set());
  assert.equal(folded.deliveredCount, 1, 'exactly one row survives');
  assert.equal(folded.deliveredRows[0].body, cli.archivedForwardProvenancePrefix('archived-3') + 'never seen',
    'and it is the one the reader has never seen — nothing is lost');
});

test('item 5: no cursor advances past a LOGICALLY suppressed row (the weak key never moves a cursor)', () => {
  // An exact RESEND — not an archived forward, so it shares neither hash nor
  // origHash with the copy the reader already handled. Only the weak
  // (from, ts, stripped-body) key can catch it.
  const row = {
    ts: 8000, hash: 'mesh:distinct-hash', body: 'duplicate text',
    sender: 'peer-a', recipient: 'primary-1', mtype: 'direct', urgency: 'normal',
    isHeartbeat: false, needsReply: false, origHash: null,
  };
  const logicalSeed = new Set([cli.logicalDeliveryKey(row)]);
  const folded = cli.foldSiblingGapRows([row], new Set(), logicalSeed);
  assert.equal(folded.deliveredCount, 0, 'the resend is suppressed from delivery');
  assert.equal(folded.logicalSuppressedCount, 1, 'and is reported as such, never silently dropped');
  assert.equal(folded.consumedCount, 0,
    'CRITICAL: consumedCount stays 0, so every ack target derived from it stops BEFORE this row — the cursor can never pass a weak-key match');
});

test('item 5: logical suppression never fires without a seed set (existing 2-arg callers are unaffected)', () => {
  const row = {
    ts: 8100, hash: 'mesh:h1', body: 'x', sender: 'p', recipient: 'r',
    mtype: 'direct', urgency: 'normal', isHeartbeat: false, needsReply: false,
  };
  const folded = cli.foldSiblingGapRows([row, Object.assign({}, row, { hash: 'mesh:h2' })], new Set());
  assert.equal(folded.deliveredCount, 2,
    'with no seenLogical set the two byte-identical-bodied rows both deliver — byte-compatible with every pre-fix caller');
  assert.equal(folded.logicalSuppressedCount, 0);
});

// ---------------------------------------------------------------------------
// (a) THE STAMP — end to end through the real forward site and the real store.
// ---------------------------------------------------------------------------

test('item 5 (a): forwardArchivedOrphanUnread stamps origHash on every copy it writes', () => {
  const home = tmpHome();
  const repo = makeGitRepo('stamp');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const orig = originalFields('arch-src', 'forward me', Date.now());
      const origHash = storeLib.meshMessageHash(orig);
      storeLib.appendMeshMessage(s, Object.assign({}, orig, { hash: origHash }));

      const r = cli.forwardArchivedOrphanUnread(s, 'arch-src', 'surv-dst', { now: Date.now() });
      assert.equal(r.forwarded, 1, JSON.stringify(r));

      const rows = s.listMessages('surv-dst');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].origHash, origHash,
        'THE FIX: the copy remembers the original\'s identity, which its own re-addressed hash cannot');
      assert.notEqual(rows[0].hash, origHash, 'and it still keeps its OWN hash as its identity');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('item 5 (a): a CHAINED forward keeps pointing at the ROOT original, never at the intermediate copy', () => {
  const home = tmpHome();
  const repo = makeGitRepo('chain');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const orig = originalFields('arch-a', 'root message', Date.now());
      const rootHash = storeLib.meshMessageHash(orig);
      storeLib.appendMeshMessage(s, Object.assign({}, orig, { hash: rootHash }));
      cli.forwardArchivedOrphanUnread(s, 'arch-a', 'arch-b', { now: Date.now() });
      cli.forwardArchivedOrphanUnread(s, 'arch-b', 'final-c', { now: Date.now() });
      const rows = s.listMessages('final-c');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].origHash, rootHash,
        'a reader that consumed the ROOT must be able to suppress a copy that reached it through any number of hops');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('item 5 (a): origHash survives a store round-trip and is null for an ordinary row (additive, tolerant of absence)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('roundtrip');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    for (const backend of ['journal', 'sqlite']) {
      const s = storeLib.openStore({ home: home + '-' + backend, hash: repoKey, backend });
      try {
        const plain = originalFields('w1', 'ordinary', 111);
        storeLib.appendMeshMessage(s, Object.assign({}, plain, { hash: storeLib.meshMessageHash(plain) }));
        const stamped = originalFields('w1', 'stamped', 222);
        storeLib.appendMeshMessage(s, Object.assign({}, stamped,
          { hash: storeLib.meshMessageHash(stamped), origHash: 'mesh:the-original' }));
        const rows = s.listMessages('w1');
        assert.equal(rows.length, 2, backend);
        assert.equal(rows[0].origHash, null, backend + ': an ordinary row reads back null, exactly like every legacy row');
        assert.equal(rows[1].origHash, 'mesh:the-original', backend + ': a stamped row round-trips');
      } finally { s.close(); rm(home + '-' + backend); }
    }
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// (b) THE SEED — consumed history is where the dedup keys come from.
// ---------------------------------------------------------------------------

test('item 5 (b): consumedDedupSeed collects hashes and origHashes from BELOW the cursor only', () => {
  const home = tmpHome();
  const repo = makeGitRepo('seed');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const consumed = originalFields('p1', 'consumed row', 100);
      const consumedHash = storeLib.meshMessageHash(consumed);
      storeLib.appendMeshMessage(s, Object.assign({}, consumed, { hash: consumedHash, origHash: 'mesh:its-original' }));
      const unread = originalFields('p1', 'unread row', 200);
      const unreadHash = storeLib.meshMessageHash(unread);
      storeLib.appendMeshMessage(s, Object.assign({}, unread, { hash: unreadHash }));

      const seed = cli.consumedDedupSeed(s, 'p1', 1, cli.CONSUMED_HASH_SEED_CAP);
      assert.ok(seed.hashes.has(consumedHash), 'the consumed row\'s own hash is seeded');
      assert.ok(seed.hashes.has('mesh:its-original'), 'and so is the original it was a copy of');
      assert.ok(!seed.hashes.has(unreadHash), 'a row still UNREAD is not consumed history and must not be seeded here');
      assert.ok(seed.logical.has(cli.logicalDeliveryKey({ sender: 'peer-a', ts: 100, body: 'consumed row' })));

      assert.equal(cli.consumedDedupSeed(s, 'p1', 0, 10).hashes.size, 0, 'a cursor of 0 means no consumed history at all');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('item 5 (b): the seed is BOUNDED to the newest K consumed rows', () => {
  const home = tmpHome();
  const repo = makeGitRepo('seedcap');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      const hashes = [];
      for (let i = 0; i < 10; i++) {
        const f = originalFields('p2', 'row-' + i, 1000 + i);
        const h = storeLib.meshMessageHash(f);
        hashes.push(h);
        storeLib.appendMeshMessage(s, Object.assign({}, f, { hash: h }));
      }
      const seed = cli.consumedDedupSeed(s, 'p2', 10, 3);
      assert.equal(seed.hashes.size, 3, 'exactly the newest K=3 consumed rows are scanned');
      assert.ok(seed.hashes.has(hashes[9]) && seed.hashes.has(hashes[7]), 'and they are the NEWEST ones');
      assert.ok(!seed.hashes.has(hashes[0]), 'the oldest is outside the bound — this is what keeps a read off O(history)');
      assert.equal(cli.CONSUMED_HASH_SEED_CAP, 2000, 'the shipped default');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});
