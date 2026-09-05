'use strict';
// Wave D (v0.92.0) — items 2, 4, 5, 6 against the REAL devswarm.js CLI.
//
//  item 2 (76891c157288, P2): nothing retired a `sessionId: null` ghost row
//         sharing the Primary's worktreePath. ROOT CAUSE (verified in code):
//         foldMeshDuplicates' zero-live-group refusal — the Primary's own
//         anchor carries `unclaimed:primary-<hash>`, which isLiveSessionId
//         rejects BY DESIGN, so the group has no "live" row, the fold refuses
//         it wholesale, and the ghost is immortal.
//  item 4 (ecd7ad60e4cc, P1): `heartbeat --summary` meshBroadcast refused
//         `ownership-mismatch` for a child with both a builder-id row and a
//         slug row — resolveMeshTarget returns ONE row, and raw-id equality
//         against it fails whenever the winner is not the id being heartbeated.
//  item 5 (R14 F1, P2): a live->dead sibling transition re-delivered the
//         watermarked backlog once, because the watermark was discarded the
//         moment the sibling became ackable AND the ack target was anchored on
//         the sibling's own (still-0) cursor.
//  item 6 (R14 F3, P3): watermark filename/parse hygiene.

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
const livenessLib = require('../../plugins/anti-hall/companion/lib/liveness.js');
const mutantKit = require('./lib/devswarm-mutant-kit.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-waveD-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-waveD-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// The whole file drives the JOURNAL backend; anything that opens a store
// itself (the doctor sweep) must be told the same, or it opens an empty sqlite
// store and reads every sibling as gone.
const JOURNAL_ENV = { ANTIHALL_DEVSWARM_STORE_BACKEND: 'journal' };

const ctx = (home, over) => Object.assign({ home, backend: 'journal', env: {} }, over || {});

function register(home, repoDir, id, over, sessionId) {
  const inboxPath = path.join(home, 'descriptor-inboxes', id + '.ndjson');
  const cursorPath = path.join(home, 'descriptor-cursors', id + '.cursor');
  const r = cli.run(
    ['register', id, '--worktree', repoDir, '--session', sessionId || ('s-' + id), '--inbox', inboxPath, '--cursor', cursorPath],
    ctx(home, Object.assign({ cwd: repoDir }, over || {}))
  );
  assert.equal(r.result.ok, true, 'register failed: ' + JSON.stringify(r.result));
  return { inboxPath, cursorPath };
}

function seedPartition(home, repoDir, toId, rows) {
  const repoKey = repokey.repoKeyForWorktree(repoDir);
  assert.ok(repoKey, 'repoKey must resolve for a real git repo');
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try {
    for (const row of rows) {
      const fields = { from: row.from || 'sender', to: toId, type: 'direct', urgency: row.urgency || 'normal', message: row.body, timestamp: row.ts };
      const hash = row.hash || storeLib.meshMessageHash(fields);
      storeLib.appendMeshMessage(s, Object.assign({}, fields, { hash }));
    }
  } finally { s.close(); }
  return repoKey;
}

function writeHeartbeatFile(home, id, ts) {
  const p = livenessLib.heartbeatPathFor(id, home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ id, ts }));
}
function markLive(home, id, now) { writeHeartbeatFile(home, id, now || Date.now()); }
// markDead — the sibling must be dead by `isSiblingPartitionLive`, which is the
// predicate `siblingAckGate` actually consults, NOT merely by
// `hasFreshHeartbeat`. After its heartbeat term that function falls back to
// `!isDormantRow`, and isDormantRow applies the WIDE 6 h idle window to a row
// whose transcript term does not resolve — so a heartbeat 20 minutes stale
// still reads LIVE. Backdating past that window is what actually models a dead
// twin (verified against the real ack gate, not assumed).
function markDead(home, id, now) {
  writeHeartbeatFile(home, id, (now || Date.now()) - (7 * 60 * 60 * 1000));
}
function storeCursor(home, repo, id) {
  const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
  try { return s.cursorValue(id); } finally { s.close(); }
}
function listRegistryIds(home, repo) {
  const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
  try { return (s.listRegistry() || []).map((r) => String(r.id)).sort(); } finally { s.close(); }
}
function upsertRow(home, repo, row) {
  const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
  try { s.upsertRegistry(row); } finally { s.close(); }
}

// backdateRow — `upsertRegistry` stamps `updatedAt: Date.now()` unconditionally
// (devswarm-store.js, both backends), so a caller CANNOT hand it an age. That
// is correct for production — a ghost's updatedAt is frozen precisely because
// nothing upserts it — but it means a test has to age the row by rewriting the
// journal record itself. Verified against the real reduced row, not assumed.
function backdateRow(home, repo, id, ts) {
  const dir = storeLib.storeDirForHash(home, repokey.repoKeyForWorktree(repo));
  const f = path.join(dir, 'journal', 'registry.ndjson');
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => {
    let o; try { o = JSON.parse(l); } catch (_) { return l; }
    if (o && String(o.id) === String(id)) { o.updatedAt = ts; return JSON.stringify(o); }
    return l;
  });
  fs.writeFileSync(f, lines.join('\n') + '\n');
  const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
  try {
    const row = (s.listRegistry() || []).find((r) => String(r.id) === String(id));
    assert.ok(row && row.updatedAt === ts, 'backdate fixture must actually take effect');
  } finally { s.close(); }
}

// ===========================================================================
// ITEM 5 — live->dead sibling transition must not re-deliver the watermark
// ===========================================================================

// drainTwice: the exact field sequence. A live twin's backlog is delivered to
// the caller (watermark advances, twin's own cursor untouched), the twin dies,
// and the next read must hand back ONLY genuinely new rows.
function setupTwin(home, repo, primaryId, twinId, now) {
  register(home, repo, primaryId, undefined);
  register(home, repo, twinId, undefined);
  seedPartition(home, repo, twinId, [
    { body: 'old-1', ts: 1000 }, { body: 'old-2', ts: 1100 }, { body: 'old-3', ts: 1200 },
  ]);
  markLive(home, twinId, now);
}

test('item 5: after a live twin is drained via the watermark and then DIES, the next read delivers only NEW rows', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f1');
  const now = Date.now();
  try {
    setupTwin(home, repo, 'primary-f1', 'twin-f1', now);

    // Read #1 — twin is LIVE, so its own cursor may not be acked; the caller's
    // watermark is what records what it was shown.
    const r1 = cli.run(['inbox', 'read-primary', 'primary-f1', '--ack-as-owner'], ctx(home, { cwd: repo, now }));
    const bodies1 = (r1.result.messages || []).map((m) => m.body);
    assert.deepStrictEqual(bodies1.filter((b) => /^old-/.test(b)), ['old-1', 'old-2', 'old-3'],
      'read #1 must deliver the live twin\'s backlog');
    assert.strictEqual(storeCursor(home, repo, 'twin-f1'), 0, 'a LIVE twin\'s own cursor is never advanced');
    const wm = cli.readSiblingSeenCursor(home, 'primary-f1', 'twin-f1');
    assert.strictEqual(wm, 3, 'the watermark must record all 3 rows shown');

    // The twin dies, and one genuinely new row lands in its partition.
    markDead(home, 'twin-f1', now);
    seedPartition(home, repo, 'twin-f1', [{ body: 'new-1', ts: 3000 }]);

    // Read #2 — the twin is now ackable. ONLY the new row may come back.
    const r2 = cli.run(['inbox', 'read-primary', 'primary-f1', '--ack-as-owner'], ctx(home, { cwd: repo, now }));
    const bodies2 = (r2.result.messages || []).map((m) => m.body);
    assert.deepStrictEqual(bodies2.filter((b) => /^(old|new)-/.test(b)), ['new-1'],
      'the watermarked backlog must NOT be re-delivered at the live->dead transition');

    // The twin's own cursors must now cover watermark + new (4), not just 1.
    assert.strictEqual(storeCursor(home, repo, 'twin-f1'), 4,
      'the ack must cover the watermark-skipped rows, not restart from 0');

    // And the mailbox must read empty afterwards.
    const c = cli.run(['inbox', 'count', 'primary-f1'], ctx(home, { cwd: repo, now }));
    assert.strictEqual(c.result.unreadTotal, 0, 'inbox count must be 0 after the drain');

    // The watermark file is retired once real cursors cover it.
    assert.strictEqual(cli.readSiblingSeenCursor(home, 'primary-f1', 'twin-f1'), 0,
      'the watermark must be deleted once the sibling\'s own cursors cover its rows');
  } finally { rm(home); rm(repo); }
});

test('item 5: no row is ever delivered twice across the whole transition', () => {
  const home = tmpHome();
  const repo = makeGitRepo('f1b');
  const now = Date.now();
  try {
    setupTwin(home, repo, 'primary-f1b', 'twin-f1b', now);
    const seen = [];
    const grab = () => {
      const r = cli.run(['inbox', 'read-primary', 'primary-f1b', '--ack-as-owner'], ctx(home, { cwd: repo, now }));
      for (const m of (r.result.messages || [])) if (/^(old|new)-/.test(m.body)) seen.push(m.body);
    };
    grab();
    markDead(home, 'twin-f1b', now);
    seedPartition(home, repo, 'twin-f1b', [{ body: 'new-1', ts: 3000 }]);
    grab();
    grab(); // a third read must add nothing at all
    assert.deepStrictEqual(seen, ['old-1', 'old-2', 'old-3', 'new-1']);
    assert.strictEqual(new Set(seen).size, seen.length, 'no body may appear twice');
  } finally { rm(home); rm(repo); }
});

// The two halves are mutation-checked SEPARATELY, because the task's own
// finding is that either one alone leaves a defect (the watermark half alone
// under-acks; the anchor half alone still discards the watermark).
function waveDMutate(oldStr, newStr, fn) {
  // mutantKit.withMutant applies the byte-exact replace to an ISOLATED SCRATCH
  // COPY of the whole plugin tree and proves the live source is untouched
  // afterwards — never the real file.
  mutantKit.withMutant(oldStr, newStr, fn);
}

test('MUTATION (item 5, half A): reverting pSeen to `pAckable ? 0 : ...` re-delivers the backlog', () => {
  waveDMutate(
    'const pSeen = readSiblingSeenCursor(home, id, pid);',
    'const pSeen = pAckable ? 0 : readSiblingSeenCursor(home, id, pid);',
    (mutated) => {
      const home = tmpHome();
      const repo = makeGitRepo('f1mA');
      const now = Date.now();
      try {
        register(home, repo, 'p-mA', undefined);
        register(home, repo, 't-mA', undefined);
        seedPartition(home, repo, 't-mA', [{ body: 'old-1', ts: 1000 }, { body: 'old-2', ts: 1100 }]);
        markLive(home, 't-mA', now);
        mutated.run(['inbox', 'read-primary', 'p-mA', '--ack-as-owner'], ctx(home, { cwd: repo, now }));
        markDead(home, 't-mA', now);
        seedPartition(home, repo, 't-mA', [{ body: 'new-1', ts: 3000 }]);
        const r2 = mutated.run(['inbox', 'read-primary', 'p-mA', '--ack-as-owner'], ctx(home, { cwd: repo, now }));
        const bodies = (r2.result.messages || []).map((m) => m.body).filter((b) => /^(old|new)-/.test(b));
        assert.ok(bodies.includes('old-1'),
          'MUTANT must re-deliver the watermarked backlog — this is the defect the fix closes');
      } finally { rm(home); rm(repo); }
    }
  );
});

test('MUTATION (item 5, half B): anchoring the ack on part.cursor under-acks the watermark-skipped rows', () => {
  waveDMutate(
    'const ackAnchor = Number.isFinite(part.sinceCursor) ? Math.max(part.cursor, part.sinceCursor) : part.cursor;',
    'const ackAnchor = part.cursor;',
    (mutated) => {
      const home = tmpHome();
      const repo = makeGitRepo('f1mB');
      const now = Date.now();
      try {
        register(home, repo, 'p-mB', undefined);
        register(home, repo, 't-mB', undefined);
        seedPartition(home, repo, 't-mB', [{ body: 'old-1', ts: 1000 }, { body: 'old-2', ts: 1100 }, { body: 'old-3', ts: 1200 }]);
        markLive(home, 't-mB', now);
        mutated.run(['inbox', 'read-primary', 'p-mB', '--ack-as-owner'], ctx(home, { cwd: repo, now }));
        markDead(home, 't-mB', now);
        seedPartition(home, repo, 't-mB', [{ body: 'new-1', ts: 3000 }]);
        mutated.run(['inbox', 'read-primary', 'p-mB', '--ack-as-owner'], ctx(home, { cwd: repo, now }));
        assert.notStrictEqual(storeCursor(home, repo, 't-mB'), 4,
          'MUTANT must UNDER-ack (cursor short of watermark+new) — the defect half B closes');
      } finally { rm(home); rm(repo); }
    }
  );
});

// ===========================================================================
// ITEM 6 — watermark filename / parse hygiene
// ===========================================================================

test('item 6: an id containing the `.seen-` separator gets NO watermark (ambiguity refused)', () => {
  const home = tmpHome();
  try {
    assert.strictEqual(cli.watermarkSafeId('plain-id'), true);
    assert.strictEqual(cli.watermarkSafeId('bad.seen-id'), false);
    assert.strictEqual(cli.siblingSeenCursorPath(home, 'a.seen-b', 'c'), null);
    assert.strictEqual(cli.siblingSeenCursorPath(home, 'a', 'b.seen-c'), null);
    assert.strictEqual(cli.writeSiblingSeenCursor(home, 'a.seen-b', 'c', 5), false);
    assert.ok(cli.siblingSeenCursorPath(home, 'a', 'b'));
  } finally { rm(home); }
});

test('item 6: parseSiblingSeenCursorName is an exact inverse, and refuses ambiguous names', () => {
  assert.deepStrictEqual(cli.parseSiblingSeenCursorName('caller.seen-sibling.json'),
    { callerId: 'caller', siblingId: 'sibling' });
  assert.deepStrictEqual(cli.parseSiblingSeenCursorName('primary-abc.seen-twin.def.json'),
    { callerId: 'primary-abc', siblingId: 'twin.def' });
  // A legacy/hand-made name with a SECOND separator is genuinely ambiguous and
  // must be skipped, never guessed at (a mis-parse here deletes the wrong file).
  assert.strictEqual(cli.parseSiblingSeenCursorName('a.seen-b.seen-c.json'), null);
  assert.strictEqual(cli.parseSiblingSeenCursorName('notawatermark.json'), null);
  assert.strictEqual(cli.parseSiblingSeenCursorName('.seen-x.json'), null);
  assert.strictEqual(cli.parseSiblingSeenCursorName('caller.seen-sibling.txt'), null);
});

test('item 6: the round-trip path -> name -> parse is stable for every writable id', () => {
  const home = tmpHome();
  try {
    for (const [c, s] of [['p1', 't1'], ['primary-9f2c', 'unclaimed-x'], ['a.b', 'c.d']]) {
      const p = cli.siblingSeenCursorPath(home, c, s);
      assert.ok(p, c + '/' + s + ' must be writable');
      assert.deepStrictEqual(cli.parseSiblingSeenCursorName(path.basename(p)), { callerId: c, siblingId: s });
    }
  } finally { rm(home); }
});

test('item 6: doctor-repair deletes a watermark whose sibling has no registry row and no partition', () => {
  const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
  const home = tmpHome();
  const repo = makeGitRepo('f3');
  try {
    register(home, repo, 'primary-f3', undefined);
    register(home, repo, 'live-sib-f3', undefined);
    seedPartition(home, repo, 'live-sib-f3', [{ body: 'x', ts: 1 }]);
    // One watermark for a REAL sibling (must survive) and one for a sibling
    // that exists nowhere (must go).
    assert.strictEqual(cli.writeSiblingSeenCursor(home, 'primary-f3', 'live-sib-f3', 1), true);
    assert.strictEqual(cli.writeSiblingSeenCursor(home, 'primary-f3', 'ghost-sib-f3', 7), true);

    const check = doctorRepair.sweepOrphanedSiblingWatermarks({ home, mode: 'check', env: JOURNAL_ENV });
    const pending = check.filter((r) => r.status === 'pending').map((r) => path.basename(r.file));
    assert.deepStrictEqual(pending, ['primary-f3.seen-ghost-sib-f3.json'],
      'check mode must name exactly the orphaned watermark and nothing else');
    assert.ok(fs.existsSync(cli.siblingSeenCursorPath(home, 'primary-f3', 'ghost-sib-f3')),
      'check mode must not delete anything');

    const repair = doctorRepair.sweepOrphanedSiblingWatermarks({ home, mode: 'repair', env: JOURNAL_ENV });
    assert.strictEqual(repair.filter((r) => r.status === 'fixed').length, 1);
    assert.strictEqual(fs.existsSync(cli.siblingSeenCursorPath(home, 'primary-f3', 'ghost-sib-f3')), false);
    assert.strictEqual(fs.existsSync(cli.siblingSeenCursorPath(home, 'primary-f3', 'live-sib-f3')), true,
      'a watermark whose sibling still exists must NEVER be swept');
  } finally { rm(home); rm(repo); }
});

test('MUTATION (item 6): a sweep keyed on age instead of existence would delete a LIVE sibling watermark', () => {
  // The sweep must be existence-based. An age-based one would drop a watermark
  // that is still load-bearing, re-delivering that sibling's whole backlog.
  const doctorRepair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
  const home = tmpHome();
  const repo = makeGitRepo('f3m');
  try {
    register(home, repo, 'primary-f3m', undefined);
    register(home, repo, 'live-sib-f3m', undefined);
    seedPartition(home, repo, 'live-sib-f3m', [{ body: 'x', ts: 1 }]);
    const wmPath = cli.siblingSeenCursorPath(home, 'primary-f3m', 'live-sib-f3m');
    cli.writeSiblingSeenCursor(home, 'primary-f3m', 'live-sib-f3m', 1);
    // Backdate it a year — an age sweep would take it; this one must not.
    const old = new Date(Date.now() - 365 * 24 * 3600 * 1000);
    fs.utimesSync(wmPath, old, old);
    doctorRepair.sweepOrphanedSiblingWatermarks({ home, mode: 'repair', env: JOURNAL_ENV });
    assert.strictEqual(fs.existsSync(wmPath), true, 'age must never be the deletion criterion');
  } finally { rm(home); rm(repo); }
});

// ===========================================================================
// ITEM 4 — heartbeat --summary broadcast ownership via identity family
// ===========================================================================

test('item 4: a builder-id caller broadcasting for its SLUG row on the same worktree is ACCEPTED', () => {
  const home = tmpHome();
  const repo = makeGitRepo('hb');
  try {
    // The field shape: two registry rows, one worktree — a builder-id row and a
    // slug row. `--session` cross-links them the way the real double
    // registration does.
    register(home, repo, 'builder-uuid-1', undefined);
    register(home, repo, 'skycrew-slug', undefined, 'builder-uuid-1');
    const r = cli.run(
      ['heartbeat', 'skycrew-slug', '--summary', 'working on the thing'],
      ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'builder-uuid-1' } })
    );
    assert.strictEqual(r.result.ok, true);
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a --summary heartbeat must attempt a mesh broadcast');
    assert.strictEqual(mb.ok, true,
      'identity-family membership must be accepted: ' + JSON.stringify(mb));
    assert.ok(!mb.dropped, 'nothing may be dropped for a family member');
  } finally { rm(home); rm(repo); }
});

test('item 4: an UNRELATED caller is still refused, with dropped/dropReason intact', () => {
  const home = tmpHome();
  const repoA = makeGitRepo('hbA');
  const repoB = makeGitRepo('hbB');
  try {
    register(home, repoA, 'victim-row', undefined);
    // The attacker stands in a DIFFERENT worktree and names the victim's id.
    // Its own row lives in another project store entirely.
    register(home, repoB, 'attacker-row', undefined);
    const r = cli.run(
      ['heartbeat', 'victim-row', '--summary', 'forged'],
      ctx(home, { cwd: repoB, env: { DEVSWARM_BUILDER_ID: 'attacker-row' } })
    );
    const mb = r.result.meshBroadcast;
    assert.ok(mb, 'a broadcast attempt must be reported');
    assert.strictEqual(mb.ok, false, 'a genuinely foreign caller must still be refused');
    assert.strictEqual(mb.dropped, true, 'the dropped/dropReason contract from 0.90.0 must survive');
    assert.ok(typeof mb.dropReason === 'string' && mb.dropReason.length > 0);
  } finally { rm(home); rm(repoA); rm(repoB); }
});

test('MUTATION (item 4): removing the identity-family leg restores the field refusal', () => {
  waveDMutate(
    "            || broadcastFamilyOwns(s, caller, id, home, ownEntry, cwd, callerSessionId, hadPriorHeartbeat);",
    '            || false;',
    (mutated) => {
      const home = tmpHome();
      const repo = makeGitRepo('hbm');
      try {
        register(home, repo, 'builder-uuid-2', undefined);
        register(home, repo, 'slug-2', undefined, 'builder-uuid-2');
        const r = mutated.run(
          ['heartbeat', 'slug-2', '--summary', 'x'],
          ctx(home, { cwd: repo, env: { DEVSWARM_BUILDER_ID: 'builder-uuid-2' } })
        );
        const mb = r.result.meshBroadcast;
        assert.strictEqual(mb.ok, false,
          'MUTANT must reproduce the field refusal — that is the defect the family leg closes');
      } finally { rm(home); rm(repo); }
    }
  );
});

// ===========================================================================
// ITEM 2 — ghost-row ageing
// ===========================================================================

// ghostFixture: the FIELD shape. The Primary's own anchor carries an
// `unclaimed:` session (so the group has ZERO "live" rows and the pre-fix fold
// refused it wholesale) and a ghost row shares its worktree with sessionId null.
function ghostFixture(home, repo, primaryId, ghostId, ghostUpdatedAt) {
  register(home, repo, primaryId, undefined, 'unclaimed:' + primaryId);
  // Give the Primary real reader evidence, exactly as the field row has.
  seedPartition(home, repo, primaryId, [{ body: 'seen', ts: 1 }]);
  const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
  try { s.setCursor(primaryId, 1); } finally { s.close(); }
  upsertRow(home, repo, { id: ghostId, worktreePath: repo, sessionId: null });
  backdateRow(home, repo, ghostId, ghostUpdatedAt);
}

const H = 60 * 60 * 1000;

test('item 2: an AGED ghost row is retired through the existing fold path', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ghost');
  try {
    ghostFixture(home, repo, 'primary-g', 'ghost-g', Date.now() - (100 * H));
    seedPartition(home, repo, 'ghost-g', [{ body: 'stranded', ts: 500 }]);
    assert.ok(listRegistryIds(home, repo).includes('ghost-g'), 'fixture must start with the ghost present');

    const r = cli.foldMeshDuplicates(home, { cwd: repo, backend: 'journal', env: {} });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.retired.map(String).includes('ghost-g'), 'the aged ghost must be retired: ' + JSON.stringify(r));
    assert.ok(r.forwarded >= 1, 'its stranded unread must be FORWARDED first, never dropped');
    assert.ok(!listRegistryIds(home, repo).includes('ghost-g'));
    assert.ok(listRegistryIds(home, repo).includes('primary-g'), 'the Primary anchor must survive');
  } finally { rm(home); rm(repo); }
});

test('item 2: a YOUNG ghost row is kept (age is what separates "never attended" from "not yet")', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ghost-young');
  try {
    ghostFixture(home, repo, 'primary-y', 'ghost-y', Date.now() - (2 * H));
    const r = cli.foldMeshDuplicates(home, { cwd: repo, backend: 'journal', env: {} });
    assert.ok(!r.retired.map(String).includes('ghost-y'), 'a 2h-old row must never be aged out');
    assert.ok(listRegistryIds(home, repo).includes('ghost-y'));
    assert.ok(Array.isArray(r.needsAttention) && r.needsAttention.length > 0,
      'the zero-live group must still be surfaced for operator attention, not silently folded');
  } finally { rm(home); rm(repo); }
});

test('item 2: an ATTENDED row sharing the worktree is NEVER touched, however old', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ghost-attended');
  try {
    ghostFixture(home, repo, 'primary-a', 'attended-a', Date.now() - (500 * H));
    // Give the "ghost" candidate each attendance signal in turn; each alone
    // must be enough to protect it.
    const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
    try { s.setCursor('attended-a', 3); } finally { s.close(); }
    const r = cli.foldMeshDuplicates(home, { cwd: repo, backend: 'journal', env: {} });
    assert.ok(!r.retired.map(String).includes('attended-a'),
      'reader evidence (a non-zero cursor) must protect the row outright');
    assert.ok(listRegistryIds(home, repo).includes('attended-a'));
  } finally { rm(home); rm(repo); }
});

test('item 2: an `unclaimed:` row is NEVER a ghost (that is the live Primary\'s own shape)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ghost-unclaimed');
  try {
    register(home, repo, 'primary-u', undefined, 'unclaimed:primary-u');
    upsertRow(home, repo, { id: 'twin-u', worktreePath: repo, sessionId: 'unclaimed:twin-u' });
    backdateRow(home, repo, 'twin-u', Date.now() - (500 * H));
    const s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
    try {
      const rows = s.listRegistry().filter((x) => String(x.id) === 'twin-u');
      assert.strictEqual(cli.ghostRegistryRows(s, home, rows, { env: {} }).length, 0,
        'an `unclaimed:` sessionId is a real self-register mint, not an absent session');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('item 2: the age bar is configurable via ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H', () => {
  const home = tmpHome();
  const repo = makeGitRepo('ghost-env');
  try {
    ghostFixture(home, repo, 'primary-e', 'ghost-e', Date.now() - (5 * H));
    // Default 72h keeps it.
    let s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
    let rows;
    try { rows = s.listRegistry().filter((x) => String(x.id) === 'ghost-e'); } finally { s.close(); }
    assert.strictEqual(cli.GHOST_ROW_MAX_AGE_H_DEFAULT, 72);
    s = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
    try {
      assert.strictEqual(cli.ghostRegistryRows(s, home, rows, { env: {} }).length, 0, '5h < 72h default');
      assert.strictEqual(
        cli.ghostRegistryRows(s, home, rows, { env: { ANTIHALL_DEVSWARM_GHOST_ROW_MAX_AGE_H: '1' } }).length, 1,
        'a 1h bar must age the same row out');
    } finally { s.close(); }
  } finally { rm(home); rm(repo); }
});

test('MUTATION (item 2): dropping the age bar retires a freshly-registered row', () => {
  waveDMutate(
    "      if ((now - upd) < maxAgeMs) continue;",
    '      if (false) continue;',
    (mutated) => {
      const home = tmpHome();
      const repo = makeGitRepo('ghost-m');
      try {
        register(home, repo, 'primary-m', undefined, 'unclaimed:primary-m');
        const s0 = storeLib.openStore({ home, hash: repokey.repoKeyForWorktree(repo), backend: 'journal' });
        try { s0.setCursor('primary-m', 0); } finally { s0.close(); }
        upsertRow(home, repo, { id: 'fresh-m', worktreePath: repo, sessionId: null });
        const r = mutated.foldMeshDuplicates(home, { cwd: repo, backend: 'journal', env: {} });
        assert.ok(r.retired.map(String).includes('fresh-m'),
          'MUTANT must retire a seconds-old row — the age bar is what prevents that');
      } finally { rm(home); rm(repo); }
    }
  );
});

test('MUTATION (item 2): dropping the single-survivor restriction folds an ambiguous group', () => {
  waveDMutate(
    '            if (ghosts.length > 0 && nonGhosts.length === 1) {',
    '            if (ghosts.length > 0 && nonGhosts.length >= 1) {',
    (mutated) => {
      const home = tmpHome();
      const repo = makeGitRepo('ghost-m2');
      try {
        register(home, repo, 'p1-m2', undefined, 'unclaimed:p1-m2');
        register(home, repo, 'p2-m2', undefined, 'unclaimed:p2-m2');
        upsertRow(home, repo, { id: 'ghost-m2', worktreePath: repo, sessionId: null });
        backdateRow(home, repo, 'ghost-m2', Date.now() - (200 * H));
        const mut = mutated.foldMeshDuplicates(home, { cwd: repo, backend: 'journal', env: {} });
        const real = { retired: [] };
        assert.ok(mut.retired.map(String).includes('ghost-m2'),
          'MUTANT folds with TWO possible survivors — an id-sort accident');
        void real;
      } finally { rm(home); rm(repo); }
    }
  );
  // And the real implementation refuses that same ambiguous group.
  const home = tmpHome();
  const repo = makeGitRepo('ghost-m2r');
  try {
    register(home, repo, 'p1-m2r', undefined, 'unclaimed:p1-m2r');
    register(home, repo, 'p2-m2r', undefined, 'unclaimed:p2-m2r');
    upsertRow(home, repo, { id: 'ghost-m2r', worktreePath: repo, sessionId: null });
    backdateRow(home, repo, 'ghost-m2r', Date.now() - (200 * H));
    const r = cli.foldMeshDuplicates(home, { cwd: repo, backend: 'journal', env: {} });
    assert.ok(!r.retired.map(String).includes('ghost-m2r'),
      'two candidate survivors means survivorship is a judgement call — refuse, do not guess');
  } finally { rm(home); rm(repo); }
});
