'use strict';
// devswarm-migrate — AUTOMATIC-BUT-SAFE migration of on-disk state into the
// store. Idempotence, non-destructiveness, count-verification, and the
// single-consumer lock refusal, all against a forced journal backend.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const migrate = require('../../plugins/anti-hall/companion/devswarm-migrate.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-migrate-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// writeWorkspace(home, id, {lines, cursor}) — a legacy descriptor + its NDJSON
// durable inbox + a consumed-count cursor, matching the shipped file contracts.
function writeWorkspace(home, id, opts) {
  const o = opts || {};
  const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  const inbox = path.join(home, 'inbox-' + id + '.ndjson');
  const cursor = path.join(home, 'cursor-' + id + '.json');
  if (o.lines) fs.writeFileSync(inbox, o.lines.join('\n') + '\n');
  if (o.cursor != null) fs.writeFileSync(cursor, String(o.cursor));
  fs.writeFileSync(path.join(wsDir, id + '.json'), JSON.stringify({
    id, worktreePath: '/wt/' + id, sessionId: 'sess-' + id,
    inboxPath: inbox, cursorPath: cursor, nudgeCommand: null,
  }));
  return { inbox, cursor };
}
const opts = (home) => ({ home, backend: 'journal', env: {} });

test('migrates descriptors + NDJSON inbox lines + cursor, count-verified', () => {
  const home = tmpHome();
  try {
    writeWorkspace(home, 'a', { lines: ['m1', 'm2', 'm3'], cursor: 1 });
    writeWorkspace(home, 'b', { lines: ['x'], cursor: 0 });

    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.locked, true);
    assert.equal(rep.workspaces, 2);
    assert.equal(rep.verifiedAll, true);
    const a = rep.migrated.find((m) => m.id === 'a');
    assert.equal(a.imported, 3);
    assert.equal(a.storeCount, 3);
    assert.equal(a.cursor, 1);
    assert.equal(a.verified, true);

    // store actually holds them + the projection reflects unread (per-project 'a')
    const s = storeLib.openStore({ home, workspaceId: 'a', backend: 'journal' });
    try {
      assert.equal(s.messageCount('a'), 3);
      assert.equal(s.cursorValue('a'), 1);
    } finally { s.close(); }
    const sum = storeLib.readSummary(home, 'a');
    assert.equal(sum.workspaces.a.unread, 2); // 3 total - cursor 1
  } finally { rm(home); }
});

test('re-run is idempotent (imports 0 new) and NON-DESTRUCTIVE (sources intact)', () => {
  const home = tmpHome();
  try {
    const { inbox, cursor } = writeWorkspace(home, 'a', { lines: ['m1', 'm2'], cursor: 0 });
    const inboxBefore = fs.readFileSync(inbox, 'utf8');
    const cursorBefore = fs.readFileSync(cursor, 'utf8');

    migrate.migrateToStore(opts(home));
    const rep2 = migrate.migrateToStore(opts(home));
    assert.equal(rep2.migrated.find((m) => m.id === 'a').imported, 0); // nothing new
    assert.equal(rep2.verifiedAll, true);

    // store still holds exactly 2 (no duplicates from the second run)
    const s = storeLib.openStore({ home, workspaceId: 'a', backend: 'journal' });
    try { assert.equal(s.messageCount('a'), 2); } finally { s.close(); }

    // sources byte-for-byte untouched (never deletes/mutates)
    assert.equal(fs.readFileSync(inbox, 'utf8'), inboxBefore);
    assert.equal(fs.readFileSync(cursor, 'utf8'), cursorBefore);
    assert.equal(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', 'a.json')), true);
  } finally { rm(home); }
});

test('a re-run imports ONLY newly-appended lines (append-only catch-up)', () => {
  const home = tmpHome();
  try {
    const { inbox } = writeWorkspace(home, 'a', { lines: ['m1', 'm2'], cursor: 0 });
    migrate.migrateToStore(opts(home));
    fs.appendFileSync(inbox, 'm3\n'); // new message arrives in the legacy inbox
    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.migrated.find((m) => m.id === 'a').imported, 1); // only m3
    const s = storeLib.openStore({ home, workspaceId: 'a', backend: 'journal' });
    try { assert.equal(s.messageCount('a'), 3); } finally { s.close(); }
  } finally { rm(home); }
});

test('a MISSING/unreadable legacy inbox reports unverified+error, never verified-empty', () => {
  const home = tmpHome();
  try {
    // Descriptor points at an inbox path that does NOT exist on disk. A read of it
    // returns 0 lines just like a genuinely-empty inbox would — but we must NOT
    // treat the two the same: reporting verified-empty here would silently drop the
    // workspace's real (unread) messages.
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.writeFileSync(path.join(wsDir, 'x.json'), JSON.stringify({
      id: 'x', worktreePath: '/wt/x', sessionId: 'sess-x',
      inboxPath: path.join(home, 'does-not-exist.ndjson'),
      cursorPath: path.join(home, 'cursor-x.json'), nudgeCommand: null,
    }));

    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.workspaces, 1);
    assert.equal(rep.verifiedAll, false, 'an unreadable inbox must NOT verify the whole run');
    const x = rep.migrated.find((m) => m.id === 'x');
    assert.equal(x.verified, false, 'the workspace is explicitly unverified');
    assert.ok(x.error && /unreadable|missing/.test(x.error), `error must name the read failure; got=${x.error}`);
    assert.equal(x.imported, 0, 'nothing imported when the inbox could not be read');
  } finally { rm(home); }
});

test('migrateOne unit: readable-empty inbox verifies; unreadable inbox errors', () => {
  const home = tmpHome();
  try {
    const s = storeLib.openStore({ home, backend: 'journal' });
    try {
      // readable but empty -> genuinely 0, honestly verified.
      const emptyInbox = path.join(home, 'empty.ndjson');
      fs.writeFileSync(emptyInbox, '');
      const okRep = migrate.migrateOne(s, {
        id: 'e', worktreePath: '/wt/e', sessionId: 's', inboxPath: emptyInbox, cursorPath: null,
      }, fs);
      assert.equal(okRep.verified, true, 'a readable EMPTY inbox is honestly verified');
      assert.equal(okRep.error, undefined);

      // unreadable/missing -> not verified, error surfaced.
      const badRep = migrate.migrateOne(s, {
        id: 'b', worktreePath: '/wt/b', sessionId: 's',
        inboxPath: path.join(home, 'nope.ndjson'), cursorPath: null,
      }, fs);
      assert.equal(badRep.verified, false);
      assert.ok(badRep.error);
    } finally { s.close(); }
  } finally { rm(home); }
});

test('refuses to run when another consumer holds the migrate lock', () => {
  const home = tmpHome();
  try {
    writeWorkspace(home, 'a', { lines: ['m1'], cursor: 0 });
    // Pre-acquire the lock with a LIVE holder (this process) — it is not stealable.
    const release = migrate.acquireMigrateLock(home);
    assert.ok(release, 'expected to acquire the lock first');
    try {
      const rep = migrate.migrateToStore(opts(home));
      assert.equal(rep.ok, false);
      assert.equal(rep.locked, false);
    } finally { release(); }
    // once released, migration proceeds
    const rep2 = migrate.migrateToStore(opts(home));
    assert.equal(rep2.ok, true);
    assert.equal(rep2.locked, true);
  } finally { rm(home); }
});

test('acquireMigrateLock does NOT steal a TORN/EMPTY lock whose MTIME is FRESH (live migration mid-write)', () => {
  const home = tmpHome();
  try {
    const p = migrate.migrateLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // A live holder is briefly a 0-byte file between openSync('wx') and writeSync.
    fs.writeFileSync(p, ''); // torn/empty -> unparseable (holderTs would be null)
    const mt = fs.statSync(p).mtimeMs;
    // Unparseable AND no live pid, but a FRESH mtime -> a live migration mid-write ->
    // MUST NOT be stolen (two migrations racing the same store corrupt it).
    const rel = migrate.acquireMigrateLock(home, { isAlive: () => false, now: () => mt + 1000 });
    assert.equal(rel, null, 'a torn/empty lock with a FRESH mtime is not stolen');
    assert.equal(fs.readFileSync(p, 'utf8'), '', 'the live holder empty lock is left intact');
  } finally { rm(home); }
});

test('acquireMigrateLock RECLAIMS a TORN/EMPTY lock whose MTIME is OLD (dead holder)', () => {
  const home = tmpHome();
  try {
    const p = migrate.migrateLockPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, ''); // torn/empty, written long ago (dead holder)
    const mt = fs.statSync(p).mtimeMs;
    // Unparseable AND its mtime is older than the 5-min stale window -> dead holder -> reclaimable.
    const rel = migrate.acquireMigrateLock(home, { isAlive: () => false, now: () => mt + 6 * 60 * 1000 });
    assert.ok(rel, 'a torn/empty lock with an OLD mtime (dead holder) is reclaimed');
    assert.notEqual(fs.readFileSync(p, 'utf8'), '', 'the reclaimed lock now carries our token');
    rel();
  } finally { rm(home); }
});

test('empty state (no descriptors) is a successful no-op', () => {
  const home = tmpHome();
  try {
    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.workspaces, 0);
    assert.equal(rep.verifiedAll, true);
  } finally { rm(home); }
});

test('legacyLineHash is stable per (id,index,content) and distinguishes duplicates', () => {
  assert.equal(migrate.legacyLineHash('a', 0, 'x'), migrate.legacyLineHash('a', 0, 'x'));
  assert.notEqual(migrate.legacyLineHash('a', 0, 'x'), migrate.legacyLineHash('a', 1, 'x')); // same text, diff index
  assert.notEqual(migrate.legacyLineHash('a', 0, 'x'), migrate.legacyLineHash('b', 0, 'x')); // diff workspace
});

// ---- migrateLegacyInbox: direct single-source import into a workspaceId --------
test('migrateLegacyInbox folds a legacy NDJSON into an explicit workspaceId, verified + non-destructive', () => {
  const home = tmpHome();
  try {
    const src = path.join(home, 'stranded.ndjson');
    fs.writeFileSync(src, 'one\ntwo\nthree\n');
    const rep = migrate.migrateLegacyInbox({ home, backend: 'journal', env: {}, source: src, workspaceId: 'primary-abc123de' });
    assert.equal(rep.ok, true);
    assert.equal(rep.action, 'migrate-legacy-inbox');
    assert.equal(rep.lines, 3);
    assert.equal(rep.imported, 3);
    assert.equal(rep.verified, true);
    // NON-DESTRUCTIVE: source untouched.
    assert.equal(fs.readFileSync(src, 'utf8'), 'one\ntwo\nthree\n');
    // rows present in the store under the target id (its own per-project store)
    const s = storeLib.openStore({ home, workspaceId: 'primary-abc123de', backend: 'journal' });
    try { assert.deepEqual(s.listMessages('primary-abc123de').map((m) => m.body), ['one', 'two', 'three']); }
    finally { s.close(); }
  } finally { rm(home); }
});

test('migrateLegacyInbox is idempotent on re-run AND co-exists with native-drained rows', () => {
  const home = tmpHome();
  try {
    const src = path.join(home, 'stranded.ndjson');
    fs.writeFileSync(src, 'a\nb\n');
    // A native-drained row already sits in the workspace (different hash namespace).
    const s0 = storeLib.openStore({ home, workspaceId: 'primary-x', backend: 'journal' });
    try { s0.appendMessage({ workspaceId: 'primary-x', body: 'native', hash: 'native:1' }); } finally { s0.close(); }

    const r1 = migrate.migrateLegacyInbox({ home, backend: 'journal', env: {}, source: src, workspaceId: 'primary-x' });
    assert.equal(r1.imported, 2);
    assert.equal(r1.verified, true, 'verifies SOURCE-line coverage even though a native row also exists');
    const r2 = migrate.migrateLegacyInbox({ home, backend: 'journal', env: {}, source: src, workspaceId: 'primary-x' });
    assert.equal(r2.imported, 0, 're-run imports nothing new (idempotent by legacyLineHash)');
    assert.equal(r2.verified, true);
    const s = storeLib.openStore({ home, workspaceId: 'primary-x', backend: 'journal' });
    try { assert.equal(s.messageCount('primary-x'), 3, 'native row + 2 legacy lines, no dup'); } finally { s.close(); }
  } finally { rm(home); }
});

test('migrateLegacyInbox dryRun detects without writing; rejects unsafe id / missing source', () => {
  const home = tmpHome();
  try {
    const src = path.join(home, 's.ndjson');
    fs.writeFileSync(src, 'x\n');
    const dry = migrate.migrateLegacyInbox({ home, backend: 'journal', source: src, workspaceId: 'primary-x', dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.pending, true);
    assert.equal(dry.lines, 1);
    const s = storeLib.openStore({ home, workspaceId: 'primary-x', backend: 'journal' });
    try { assert.equal(s.messageCount('primary-x'), 0, 'dryRun wrote nothing'); } finally { s.close(); }

    assert.equal(migrate.migrateLegacyInbox({ home, source: src, workspaceId: '../evil' }).ok, false);
    assert.equal(migrate.migrateLegacyInbox({ home, workspaceId: 'primary-x' }).ok, false); // missing source
    assert.equal(migrate.migrateLegacyInbox({ home, source: path.join(home, 'nope.ndjson'), workspaceId: 'primary-x' }).ok, false); // unreadable
  } finally { rm(home); }
});

// ---- GLOBAL -> PER-PROJECT split (v0.55 upgrade path) ----------------------
test('migrateGlobalStoreToPerProject splits a seeded GLOBAL store into per-project stores, NON-destructively', () => {
  const home = tmpHome();
  try {
    // Seed a LEGACY global store: multiple workspace_ids in ONE store file at the
    // devswarm store/ root (dir override), exactly the v0.54.x on-disk shape.
    const legacyDir = storeLib.storeRootDir(home);
    const src = storeLib.openStore({ home, backend: 'journal', dir: legacyDir, hash: 'legacy' });
    try {
      src.appendMessage({ workspaceId: 'primary-aaaaaaaa', body: 'A1', hash: 'native:a1' });
      src.appendMessage({ workspaceId: 'primary-aaaaaaaa', body: 'A2' }); // null hash -> synthesized on split
      src.appendMessage({ workspaceId: 'child-zzz', body: 'C1', hash: 'legacy:c1' });
      src.upsertRegistry({ id: 'primary-aaaaaaaa', worktreePath: '/wt/a', sessionId: 's', inboxPath: null, cursorPath: null, nudgeCommand: null });
      src.setCursor('primary-aaaaaaaa', 1);
      src.setGate({ workspaceId: 'child-zzz', name: 'done', value: true });
    } finally { src.close(); }
    const globalFile = path.join(legacyDir, 'journal', 'messages.ndjson');
    const globalBefore = fs.readFileSync(globalFile, 'utf8');

    const rep = migrate.migrateGlobalStoreToPerProject(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.present, true);
    assert.equal(rep.workspaces, 2);
    assert.equal(rep.copied, 3, 'all 3 messages copied into per-project stores');

    // Per-project stores exist with the right rows, physically separated.
    const pa = storeLib.openStore({ home, workspaceId: 'primary-aaaaaaaa', backend: 'journal' });
    try {
      assert.equal(pa.messageCount('primary-aaaaaaaa'), 2);
      assert.equal(pa.cursorValue('primary-aaaaaaaa'), 1, 'cursor carried forward');
    } finally { pa.close(); }
    const pc = storeLib.openStore({ home, workspaceId: 'child-zzz', backend: 'journal' });
    try {
      assert.equal(pc.messageCount('child-zzz'), 1);
      assert.deepEqual(pc.currentGates('child-zzz'), { done: true }, 'gate carried forward');
    } finally { pc.close(); }

    // A's physical file must not contain C's message (real per-project isolation).
    const aFile = path.join(storeLib.journalDir(home, 'primary-aaaaaaaa'), 'messages.ndjson');
    assert.ok(!fs.readFileSync(aFile, 'utf8').includes('C1'), "A's per-project file excludes C's message");

    // NON-DESTRUCTIVE: the global store is left byte-for-byte intact as a backup.
    assert.equal(fs.readFileSync(globalFile, 'utf8'), globalBefore, 'global store left intact (never deleted)');

    // IDEMPOTENT: a re-run copies nothing new.
    const rep2 = migrate.migrateGlobalStoreToPerProject(opts(home));
    assert.equal(rep2.copied, 0, 're-run is idempotent (no duplicate rows)');
  } finally { rm(home); }
});

test('migrateGlobalStoreToPerProject with NO legacy global store -> present:false, no-op', () => {
  const home = tmpHome();
  try {
    const rep = migrate.migrateGlobalStoreToPerProject(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.present, false);
    assert.equal(rep.copied, 0);
  } finally { rm(home); }
});

// ---- Bug 1 (P1, data-loss): migrate whichever legacy backend is ACTUALLY on
// disk, independent of the runtime-selected backend --------------------------
test('migrateGlobalStoreToPerProject migrates a legacy JOURNAL store even when the runtime backend is sqlite', () => {
  const home = tmpHome();
  try {
    // Seed a legacy JOURNAL global store (v0.54.x on-disk shape: files directly
    // under store/journal/, no store/<hash>/ subdir).
    const legacyDir = storeLib.storeRootDir(home);
    const src = storeLib.openStore({ home, backend: 'journal', dir: legacyDir, hash: 'legacy' });
    try { src.appendMessage({ workspaceId: 'primary-aaaaaaaa', body: 'JOURNAL-MSG', hash: 'native:j1' }); }
    finally { src.close(); }

    // Force the RUNTIME/destination backend to sqlite — a different backend than
    // the one the legacy store was physically written in.
    const rep = migrate.migrateGlobalStoreToPerProject({ home, backend: 'sqlite', env: {} });
    assert.equal(rep.present, true, 'the legacy journal store must be detected regardless of runtime backend');
    assert.equal(rep.copied, 1, 'the journal-backend legacy message must be migrated, not silently dropped');

    const dst = storeLib.openStore({ home, workspaceId: 'primary-aaaaaaaa', backend: 'sqlite' });
    try {
      assert.equal(dst.messageCount('primary-aaaaaaaa'), 1);
      assert.deepEqual(dst.listMessages('primary-aaaaaaaa').map((m) => m.body), ['JOURNAL-MSG']);
    } finally { dst.close(); }
  } finally { rm(home); }
});

// ---- Bug 2 (P1, duplication): the same message copied via the global-split
// path (native: hash) and the descriptor-inbox path (legacy: hash) must
// collapse to ONE row, not two ------------------------------------------------
test('a message present in the global store AND a descriptor\'s legacy inbox migrates to exactly ONE row', () => {
  const home = tmpHome();
  try {
    const id = 'primary-aaaaaaaa';

    // Global-store row (as the v0.54 ingest daemon would have written directly).
    const legacyDir = storeLib.storeRootDir(home);
    const src = storeLib.openStore({ home, backend: 'journal', dir: legacyDir, hash: 'legacy' });
    try { src.appendMessage({ workspaceId: id, body: 'DUP-MSG', hash: 'native:dup1' }); }
    finally { src.close(); }

    // Descriptor whose legacy NDJSON inbox mirrors the SAME message text.
    writeWorkspace(home, id, { lines: ['DUP-MSG'], cursor: 0 });

    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.verifiedAll, true, 'exactly one row for the id must count-verify clean');

    const s = storeLib.openStore({ home, workspaceId: id, backend: 'journal' });
    try {
      assert.equal(s.messageCount(id), 1, 'the duplicate content must collapse to exactly one row');
      assert.deepEqual(s.listMessages(id).map((m) => m.body), ['DUP-MSG']);
    } finally { s.close(); }

    // Idempotent re-run: still exactly one row, still verified.
    const rep2 = migrate.migrateToStore(opts(home));
    assert.equal(rep2.verifiedAll, true);
    const s2 = storeLib.openStore({ home, workspaceId: id, backend: 'journal' });
    try { assert.equal(s2.messageCount(id), 1); } finally { s2.close(); }
  } finally { rm(home); }
});

// ---- P1 regression (Codex re-review): the cross-path body dedupe used to be a
// plain Set, which not only broke migrate-state.js's dryRun pending check (see
// tests/hooks/migrate-state.test.js) but ALSO silently dropped a SECOND,
// genuinely distinct descriptor message that happened to share the exact body
// of a message already present via another path. bodyMultisetFor/consumeBody
// (a multiset draw-down) fixes both: a duplicate collapses to one row, but any
// occurrence BEYOND what's already covered still imports as its own row -------
test('two genuinely DISTINCT descriptor lines with identical bodies both migrate (no false drop)', () => {
  const home = tmpHome();
  try {
    const id = 'primary-bbbbbbbb';
    writeWorkspace(home, id, { lines: ['SAME-TEXT', 'SAME-TEXT'], cursor: 0 });

    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.verifiedAll, true);

    const s = storeLib.openStore({ home, workspaceId: id, backend: 'journal' });
    try {
      assert.equal(s.messageCount(id), 2, 'both distinct same-body lines must be preserved as two rows');
      assert.deepEqual(s.listMessages(id).map((m) => m.body), ['SAME-TEXT', 'SAME-TEXT']);
    } finally { s.close(); }
  } finally { rm(home); }
});

test('one pre-existing native-hash row PLUS two identical-body descriptor lines: one collapses (cross-path dup), the other imports (distinct)', () => {
  const home = tmpHome();
  try {
    const id = 'primary-cccccccc';

    const legacyDir = storeLib.storeRootDir(home);
    const src = storeLib.openStore({ home, backend: 'journal', dir: legacyDir, hash: 'legacy' });
    try { src.appendMessage({ workspaceId: id, body: 'DUP-MSG', hash: 'native:dup1' }); }
    finally { src.close(); }

    // Two descriptor lines with the SAME body: one is the mirror of the
    // native row above (must collapse), the other is a genuinely new message
    // (must still import).
    writeWorkspace(home, id, { lines: ['DUP-MSG', 'DUP-MSG'], cursor: 0 });

    const rep = migrate.migrateToStore(opts(home));
    assert.equal(rep.ok, true);
    assert.equal(rep.verifiedAll, true);

    const s = storeLib.openStore({ home, workspaceId: id, backend: 'journal' });
    try {
      assert.equal(s.messageCount(id), 2, '1 pre-existing (collapsed) + 1 genuinely new = 2 total');
    } finally { s.close(); }
  } finally { rm(home); }
});
