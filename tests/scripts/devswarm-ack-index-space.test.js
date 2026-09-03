'use strict';
// P0 MESSAGE-LOSS fix: `cmdInboxMessages` (scripts/devswarm.js) used to derive
// the OWN-store partition's ack target as `total - ownWithheldCount`, where
// `total` (s.messageCount) counts the RAW store sequence but
// `ownWithheldCount` was counted over a DIFFERENT, NDJSON-dedup-FILTERED
// index space (union.storeOnlyUnreadRows, devswarm-unread.js:129 —
// `storeUnreadRows.filter(r => !r.hash || !unreadNdjsonHashes.has(r.hash))`).
// Whenever the union dedups >=1 store row AND the read-cap withholds >=1
// remaining own row, the subtraction silently advanced the cursor past a row
// that was never delivered — permanent message loss.
//
// Fix: the own-store ack target is now the raw absolute `.index` (a real,
// database-backed positional field every store row carries — see
// devswarm-store.js listMessages) of the LAST 'own'-source row actually
// present in the delivered `messages` array, never lower than the pre-read
// cursor. This is safe by construction: the cursor can only ever be set to
// the position of a row that was truly returned.
//
// These tests exercise the exact proven counterexample from the adversarial
// review, guard against over-correction (no dedup, cap withholds), confirm
// no regression when nothing is withheld, and verify the OTHER sources
// (mesh sibling partitions, the NDJSON channel) were already correct in
// their own index space (no reindexing bug there) under the same combined
// scenario.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ack-idxspace-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ack-idxspace-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, over) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', 's-' + id, '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, Object.assign({ cwd: repoDir }, over || {}))
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

// seedStoreRows(home, repoDir, toId, rows) — rows: [{body, hash, ts}], inserted
// in array order (physical insertion order = raw `.index` order).
function seedStoreRows(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      s.appendMessage({ workspaceId: toId, body: row.body, hash: row.hash, ts: row.ts });
    }
  } finally { s.close(); }
  return repoKey;
}

function writeNdjson(inboxPath, entries) {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  fs.writeFileSync(inboxPath, lines);
}

// ---- 1: the exact proven counterexample ------------------------------------

test('P0 counterexample: NDJSON dedup + cap withholding never advances the store cursor past a withheld row', () => {
  const home = tmpHome();
  const repo = makeGitRepo('counterexample');
  try {
    const id = 'w-counterexample';
    const { inboxPath } = register(home, repo, id);
    // Raw store-unread sequence m1..m5 (ts strictly increasing so the final
    // ts-sort matches insertion order exactly).
    seedStoreRows(home, repo, id, [
      { body: 'm1', hash: 's1', ts: 1000 },
      { body: 'm2', hash: 's2', ts: 2000 },
      { body: 'm3', hash: 's3', ts: 3000 },
      { body: 'm4', hash: 's4', ts: 4000 },
      { body: 'm5', hash: 's5', ts: 5000 },
    ]);
    // NDJSON union dedups m3 (same content hash) — m3 is "already covered"
    // by the NDJSON channel and excluded from union.storeOnlyUnreadRows.
    writeNdjson(inboxPath, [{ _h: 's3', message: 'm3', fromBranch: 'child', createdAt: 3000 }]);

    // Cap withholds the tail: only 1 message survives the merged, per-source
    // prefix cap.
    const r = cli.run(['inbox', 'read-primary', id, '--ack-as-owner', '--limit', '1'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.count, 1, 'only the single kept row is delivered this call');
    assert.equal(r.result.messages[0].body, 'm1', 'm1 (earliest ts) is the one row actually delivered');
    assert.equal(r.result.truncated, true);

    // THE INVARIANT: cursor must equal the raw position of the last
    // DELIVERED row (m1 = raw position 1), never `total - filteredWithheld`
    // (which the pre-fix code computed as 5 - 3 = 2, i.e. as if m2 had also
    // been delivered).
    assert.equal(r.result.cursor, 1, 'cursor must equal the last DELIVERED row\'s raw position, not total-filteredWithheldCount');
    assert.notEqual(r.result.cursor, 2, 'pre-fix bug value: must NOT land on the buggy total-withheld result');

    // Round-trip: a subsequent read (no cap) must re-serve every withheld
    // message — nothing lost, nothing duplicated.
    const r2 = cli.run(['inbox', 'read-primary', id, '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result));
    const bodies = r2.result.messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['m2', 'm3', 'm4', 'm5'], 'every withheld message (including the dedup'
      + "'d m3, delivered via its NDJSON twin) must resurface exactly once, with no gaps or duplicates");
  } finally { rm(home); }
});

// ---- 2: guard against over-correction (union active, no dedup, cap withholds) --

test('guard: union active with NO dedup, cap withholds -> cursor still equals last delivered row\'s raw position', () => {
  const home = tmpHome();
  const repo = makeGitRepo('no-dedup-cap');
  try {
    const id = 'w-no-dedup-cap';
    register(home, repo, id);
    seedStoreRows(home, repo, id, [
      { body: 'a1', hash: 'a1', ts: 1000 },
      { body: 'a2', hash: 'a2', ts: 2000 },
      { body: 'a3', hash: 'a3', ts: 3000 },
      { body: 'a4', hash: 'a4', ts: 4000 },
    ]);
    // wantsUnion is active (read-primary always unions) but nothing in the
    // NDJSON channel to dedup against.
    const r = cli.run(['inbox', 'read-primary', id, '--ack-as-owner', '--limit', '2'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.count, 2);
    assert.deepEqual(r.result.messages.map((m) => m.body), ['a1', 'a2']);
    assert.equal(r.result.truncated, true);
    assert.equal(r.result.cursor, 2, 'no gaps: cursor advances exactly to the last delivered row\'s raw position (2)');

    const r2 = cli.run(['inbox', 'read-primary', id, '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.deepEqual(r2.result.messages.map((m) => m.body), ['a3', 'a4'], 'the withheld tail resurfaces exactly, once');
  } finally { rm(home); }
});

// ---- 3: dedup active, cap withholds NOTHING -> unchanged from today's behaviour --

test('no regression: dedup active but cap withholds nothing -> ack target unchanged from pre-fix arithmetic', () => {
  const home = tmpHome();
  const repo = makeGitRepo('dedup-no-cap');
  try {
    const id = 'w-dedup-no-cap';
    const { inboxPath } = register(home, repo, id);
    seedStoreRows(home, repo, id, [
      { body: 'b1', hash: 'sh1', ts: 1000 },
      { body: 'b2', hash: 'sh2', ts: 2000 },
      { body: 'b3', hash: 'sh3', ts: 3000 }, // deduped via NDJSON twin below
      { body: 'b4', hash: 'sh4', ts: 4000 },
    ]);
    writeNdjson(inboxPath, [{ _h: 'sh3', message: 'b3', fromBranch: 'child', createdAt: 3000 }]);

    // No --limit override small enough to truncate: everything is delivered.
    const r = cli.run(['inbox', 'read-primary', id, '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    assert.equal(r.result.truncated, undefined, 'nothing withheld this call');
    // Delivered: b1, b2, b4 (store) + b3 (via its NDJSON twin) = 4 messages.
    assert.equal(r.result.count, 4);
    // Own-store raw sequence total is 4 (m1..m4 all physically stored) —
    // the ack target equals that total exactly, matching the pre-fix
    // `total - 0` arithmetic in the no-withholding case.
    assert.equal(r.result.cursor, 4, 'own-store cursor advances to the full raw total when nothing was withheld');

    const r2 = cli.run(['inbox', 'read-primary', id, '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r2.result.count, 0, 'fully acked: nothing left unread');
  } finally { rm(home); }
});

// ---- 4: mesh sibling + NDJSON sources verified independently, combined ----

test('combined: own (deduped+capped) + mesh sibling + NDJSON, each source acks in its own correct index space', () => {
  const home = tmpHome();
  const repo = makeGitRepo('combined-sources');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const primaryId = 'w-combined-primary';
    const siblingId = 'w-combined-sibling';
    register(home, repo, primaryId);
    // A sibling registry row sharing the same worktree/meshId so the mesh
    // union widens the read across both partitions (mirrors
    // devswarm-inbox-cap.test.js's mesh setup).
    const r2reg = cli.run(
      ['register', siblingId, '--worktree', repo, '--session', 'unclaimed:' + siblingId,
        '--inbox', path.join(home, 'descriptor-inboxes', siblingId + '.ndjson'),
        '--cursor', path.join(home, 'descriptor-cursors', siblingId + '.cursor')],
      ctx(home, { cwd: repo })
    );
    assert.equal(r2reg.result.ok, true, JSON.stringify(r2reg.result));

    const primaryInbox = path.join(home, 'descriptor-inboxes', primaryId + '.ndjson');

    // Own partition: 3 raw rows, one deduped via NDJSON twin.
    seedStoreRows(home, repo, primaryId, [
      { body: 'own1', hash: 'own-h1', ts: 1000 },
      { body: 'own2', hash: 'own-h2', ts: 2000 }, // deduped via NDJSON twin below
      { body: 'own3', hash: 'own-h3', ts: 3000 },
    ]);
    writeNdjson(primaryInbox, [{ _h: 'own-h2', message: 'own2', fromBranch: 'child', createdAt: 2000 }]);

    // Sibling partition: 2 raw mesh rows, addressed via appendMeshMessage so
    // the mesh-union path (meshCandidateRows) sees them as a proper mesh send.
    const sSib = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    try {
      for (const row of [{ body: 'sib1', ts: 1500 }, { body: 'sib2', ts: 2500 }]) {
        const fields = { from: 'someone', to: siblingId, type: 'direct', urgency: 'normal', message: row.body, timestamp: row.ts };
        const hash = storeLib.meshMessageHash(fields);
        storeLib.appendMeshMessage(sSib, Object.assign({}, fields, { hash }));
      }
    } finally { sSib.close(); }

    // Large enough limit that nothing is capped — isolates the dedup-only
    // effect on the own partition while confirming sibling/NDJSON stay
    // correct in their own space alongside it.
    const r = cli.run(['inbox', 'read-primary', primaryId, '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r.result.ok, true, JSON.stringify(r.result));
    const bodies = r.result.messages.map((m) => m.body).sort();
    assert.deepEqual(bodies, ['own1', 'own2', 'own3', 'sib1', 'sib2'], 'own (incl. deduped-via-ndjson) + sibling rows all delivered');
    assert.equal(r.result.cursor, 3, 'own-store cursor: raw total (3), nothing withheld');

    // Re-read: nothing left, confirming sibling + ndjson cursors also
    // advanced fully and correctly (their own index space was never broken).
    const r3 = cli.run(['inbox', 'read-primary', primaryId, '--ack-as-owner'], ctx(home, { cwd: repo }));
    assert.equal(r3.result.ok, true, JSON.stringify(r3.result));
    assert.equal(r3.result.count, 0, 'sibling + ndjson + own all fully acked, nothing resurfaces');
  } finally { rm(home); }
});
