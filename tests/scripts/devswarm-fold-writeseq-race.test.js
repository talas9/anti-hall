'use strict';
// v0.61.0 mesh-migration money-path — THE LAST residual (critic-confirmed):
// removeRegistryIf's guard used to be `{ sessionId, updatedAt }` only. A live
// child that re-registers the SAME id/sessionId within the SAME MILLISECOND as
// the fold's classification snapshot keeps `updatedAt` identical, so the
// ms-based conditional delete still fired and deleted the now-live row —
// millisecond timestamps can't distinguish a same-ms rewrite from a stable
// phantom.
//
// THE FIX: a monotonic per-row write counter (`write_seq` / `writeSeq`),
// bumped on EVERY registry upsert regardless of wall-clock time, added to the
// removeRegistryIf guard AND to foldGroupIntoSurvivor's snapshot. Both
// backends; additive + idempotent + fail-open; old stores gain the column on
// next open (sqlite) or derive it retroactively from the append-only log
// (journal) — no schema for the journal backend.
//
// This file is scoped to ONLY the write_seq residual — the P1a/P1b/P2 fixes it
// builds on are already covered by devswarm-fold-race.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-foldwriteseq-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

const backends = [{ name: 'journal', backend: 'journal' }];
if (storeLib.sqliteAvailable()) backends.push({ name: 'sqlite', backend: 'sqlite' });

for (const B of backends) {
  const openS = (home, hash) => storeLib.openStore({ home, hash, backend: B.backend });

  // ---- same-ms race: FAIL-FIRST (old writeSeq-less guard) -> PASS-AFTER -----
  test(`[${B.name}] P3: a SAME-MILLISECOND live re-register bumps write_seq even though updatedAt is unchanged`, () => {
    const home = tmpHome();
    const hash = 'p3basic-' + B.name;
    try {
      const s = openS(home, hash);
      let before;
      const realNow = Date.now;
      try {
        Date.now = () => 1700000000000; // pin the ms so both upserts land identically
        // SAME sessionId both times — isolates write_seq as the ONLY signal that can
        // distinguish these two writes (the pre-existing sessionId/updatedAt guard
        // sees them as identical; that IS the residual this fix closes).
        s.upsertRegistry({ id: 'row-a', worktreePath: '/fake/wt', sessionId: 'live-sess' });
        before = s.listRegistry().find((d) => d.id === 'row-a');
        s.upsertRegistry({ id: 'row-a', worktreePath: '/fake/wt', sessionId: 'live-sess' }); // same-ms re-register, SAME session
      } finally { Date.now = realNow; }
      const after = s.listRegistry().find((d) => d.id === 'row-a');
      s.close();

      assert.equal(after.updatedAt, before.updatedAt, 'precondition: updatedAt is IDENTICAL across both upserts (the race)');
      assert.notEqual(after.writeSeq, before.writeSeq, 'write_seq DID advance even though updatedAt could not distinguish the two writes');
      assert.equal(before.writeSeq == null ? null : Number(before.writeSeq), B.name === 'journal' ? 1 : 1, 'first upsert -> write_seq 1');
      assert.equal(after.writeSeq, 2, 'second (same-ms) upsert -> write_seq 2');
    } finally { rm(home); }
  });

  test(`[${B.name}] P3: FAIL-FIRST — the pre-fix guard shape (sessionId+updatedAt only, no writeSeq) still deletes the same-ms live row`, () => {
    const home = tmpHome();
    const hash = 'p3failfirst-' + B.name;
    try {
      const s = openS(home, hash);
      let snap;
      const realNow = Date.now;
      try {
        Date.now = () => 1700000000000;
        // A store-only row carrying a (possibly stale) session_id is still a
        // classifiable phantom — the fold decides removability by descriptor-file
        // presence, not by sessionId being null (see foldGroupIntoSurvivor doc).
        s.upsertRegistry({ id: 'row-b', worktreePath: '/fake/wt', sessionId: 'live-sess' });
        snap = s.listRegistry().find((d) => d.id === 'row-b'); // fold classifies here
        s.upsertRegistry({ id: 'row-b', worktreePath: '/fake/wt', sessionId: 'live-sess' }); // races the fold, SAME session, SAME ms
      } finally { Date.now = realNow; }

      // This is EXACTLY the guard shape foldGroupIntoSurvivor used before this fix
      // (no `writeSeq` key at all) — reproduces the residual: it still matches and
      // wrongly deletes the now-live row.
      const deletedByOldGuard = s.removeRegistryIf('row-b', { sessionId: snap.sessionId, updatedAt: snap.updatedAt });
      assert.equal(deletedByOldGuard, true, 'fail-first: the ms-only guard is blind to the same-ms race and deletes');
      assert.equal(s.listRegistry().find((d) => d.id === 'row-b'), undefined, 'fail-first: the live re-registration was WRONGLY erased (data loss reproduced)');
      s.close();
    } finally { rm(home); }
  });

  test(`[${B.name}] P3: PASS-AFTER — the writeSeq-aware guard (as foldGroupIntoSurvivor now passes) does NOT delete the same-ms live row`, () => {
    const home = tmpHome();
    const hash = 'p3passafter-' + B.name;
    try {
      const s = openS(home, hash);
      let snap;
      const realNow = Date.now;
      try {
        Date.now = () => 1700000000000;
        s.upsertRegistry({ id: 'row-c', worktreePath: '/fake/wt', sessionId: 'live-sess' });
        snap = s.listRegistry().find((d) => d.id === 'row-c');
        s.upsertRegistry({ id: 'row-c', worktreePath: '/fake/wt', sessionId: 'live-sess' }); // races the fold, SAME session, SAME ms
      } finally { Date.now = realNow; }

      const removed = s.removeRegistryIf('row-c', { sessionId: snap.sessionId, updatedAt: snap.updatedAt, writeSeq: snap.writeSeq });
      assert.equal(removed, false, 'pass-after: the writeSeq guard closes the same-ms race, row is NOT deleted');
      const survivor = s.listRegistry().find((d) => d.id === 'row-c');
      assert.ok(survivor, 'the live row survives');
      assert.equal(survivor.writeSeq, 2, 'the surviving row is the SECOND (re-registered) write, not deleted');
      s.close();
    } finally { rm(home); }
  });

  // ---- production wiring: foldGroupIntoSurvivor itself closes the race ------
  test(`[${B.name}] P3 wiring: foldGroupIntoSurvivor's own snapshot (captured via listRegistry) survives a same-ms race`, () => {
    const home = tmpHome();
    const hash = 'p3wire-' + B.name;
    try {
      const s = openS(home, hash);
      let candidate;
      const realNow = Date.now;
      try {
        Date.now = () => 1700000002000;
        s.upsertRegistry({ id: 'phantom-1', worktreePath: '/fake/wt', sessionId: 'now-live' });
        // This is exactly what retireWorktreeDuplicates/foldMeshDuplicates hand to
        // foldGroupIntoSurvivor as a `candidates` entry.
        candidate = s.listRegistry().find((d) => d.id === 'phantom-1');
        s.upsertRegistry({ id: 'phantom-1', worktreePath: '/fake/wt', sessionId: 'now-live' }); // races the fold, SAME session, SAME ms
      } finally { Date.now = realNow; }

      const result = cli.foldGroupIntoSurvivor(s, home, 'survivor-x', [candidate]);
      assert.deepEqual(result.retired, [], 'the now-live row must NOT be retired/tombstoned');
      assert.deepEqual(result.left, ['phantom-1'], 'it is surfaced as left instead (a later fold re-evaluates)');

      const stillThere = s.listRegistry().find((d) => d.id === 'phantom-1');
      s.close();
      assert.ok(stillThere, 'the live row survives in the registry');
      assert.equal(stillThere.writeSeq, 2, 'the surviving row is the SECOND (re-registered) write, not deleted');
    } finally { rm(home); }
  });

  // ---- stable phantom (no re-registration): still removable -----------------
  test(`[${B.name}] P3: a STABLE phantom (writeSeq unchanged, no re-register) is still removed — no regression`, () => {
    const home = tmpHome();
    const hash = 'p3stable-' + B.name;
    try {
      const s = openS(home, hash);
      s.upsertRegistry({ id: 'row-d', worktreePath: '/fake/wt', sessionId: null });
      const snap = s.listRegistry().find((d) => d.id === 'row-d');
      // No re-registration happens — the row is genuinely still the same phantom.
      const removed = s.removeRegistryIf('row-d', { sessionId: snap.sessionId, updatedAt: snap.updatedAt, writeSeq: snap.writeSeq });
      assert.equal(removed, true, 'a stable phantom (snapshot writeSeq == current) is still removed');
      assert.equal(s.listRegistry().find((d) => d.id === 'row-d'), undefined, 'stable phantom is gone');
      s.close();
    } finally { rm(home); }
  });

  // ---- legacy callers that never pass writeSeq keep the OLD behavior --------
  test(`[${B.name}] P3: a legacy caller that omits the writeSeq key entirely keeps byte-identical old behavior`, () => {
    const home = tmpHome();
    const hash = 'p3legacy-' + B.name;
    try {
      const s = openS(home, hash);
      s.upsertRegistry({ id: 'row-e', worktreePath: '/fake/wt', sessionId: null });
      const snap = s.listRegistry().find((d) => d.id === 'row-e');
      // No `writeSeq` key at all in the guard object (pre-v0.61.0 call shape).
      const removed = s.removeRegistryIf('row-e', { sessionId: snap.sessionId, updatedAt: snap.updatedAt });
      assert.equal(removed, true, 'a legacy (writeSeq-less) guard still removes a genuinely stable phantom');
      s.close();
    } finally { rm(home); }
  });
}

// ---- sqlite-only: old-store compat (column added transparently on open) ----
if (storeLib.sqliteAvailable()) {
  test('[sqlite] old-store compat: a registry table created WITHOUT write_seq is migrated transparently on open; a stable phantom is still removable', () => {
    const home = tmpHome();
    try {
      const { DatabaseSync } = require('node:sqlite');
      const dir = storeLib.storeDirForHash(home, 'legacyreg1');
      fs.mkdirSync(dir, { recursive: true });
      const raw = new DatabaseSync(path.join(dir, 'devswarm.db'));
      raw.exec(
        'CREATE TABLE registry ('
        + ' id TEXT PRIMARY KEY,'
        + ' worktree_path TEXT, session_id TEXT, inbox_path TEXT,'
        + ' cursor_path TEXT, nudge_command TEXT, updated_at INTEGER'
        + ');' // pre-0.61.0 shape — no write_seq column at all
      );
      raw.prepare(
        'INSERT INTO registry (id, worktree_path, session_id, inbox_path, cursor_path, nudge_command, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?);'
      ).run('legacy-phantom', '/fake/legacy', null, null, null, null, 555);
      raw.close();

      // Re-open via the write_seq-aware openSqlite (hash-keyed, same dir) -> additive
      // ALTER TABLE, no data loss.
      const s = storeLib.openSqlite(home, null, { hash: 'legacyreg1' });
      try {
        const cols = new DatabaseSync(path.join(dir, 'devswarm.db')).prepare('PRAGMA table_info(registry);').all().map((r) => String(r.name));
        assert.ok(cols.includes('write_seq'), 'write_seq column is added to the pre-existing table on open');

        const row = s.listRegistry().find((d) => d.id === 'legacy-phantom');
        assert.ok(row, 'the pre-existing row survives the migration, still readable');
        assert.equal(row.writeSeq, null, 'a migrated row that was never re-upserted reads back writeSeq null');

        // A stable phantom (write_seq NULL, never re-upserted since migration) IS
        // still removable — a NULL snapshot matches a still-NULL current value.
        const removed = s.removeRegistryIf('legacy-phantom', { sessionId: row.sessionId, updatedAt: row.updatedAt, writeSeq: row.writeSeq });
        assert.equal(removed, true, 'a migrated stable phantom (write_seq still NULL) is still removable');
        assert.equal(s.listRegistry().find((d) => d.id === 'legacy-phantom'), undefined, 'migrated stable phantom is gone');

        // And upsertRegistry on the now-migrated table correctly starts a fresh
        // row's write_seq at 1 (COALESCE(NULL,0)+1).
        s.upsertRegistry({ id: 'new-after-migration', worktreePath: '/fake/new', sessionId: null });
        const fresh = s.listRegistry().find((d) => d.id === 'new-after-migration');
        assert.equal(fresh.writeSeq, 1, 'a fresh upsert on the migrated table starts write_seq at 1');
      } finally { s.close(); }
    } finally { rm(home); }
  });

  // ---- column-absent-and-CANNOT-migrate: true fail-open (critic P1 gap) -----
  // The ALTER TABLE ADD COLUMN in ensureRegistryWriteSeqColumn is best-effort and
  // swallows its own error (locked/corrupt/read-only DB, not just "already
  // exists"). Before this fix, openSqlite continued regardless and upsertRegistry/
  // removeRegistryIf referenced `write_seq` UNCONDITIONALLY — so a store that
  // genuinely could not gain the column would throw on the very next write instead
  // of degrading to pre-0.61.0 behavior. This forces that exact failure by making
  // ONLY the write_seq ALTER throw (a non-"duplicate column" error), leaving every
  // other db.exec call (CREATE TABLE, other ALTERs, PRAGMAs) untouched.
  test('[sqlite] column-absent AND cannot-migrate: store opens, upserts, and deletes without ever throwing on the missing write_seq column (fail-open)', () => {
    const home = tmpHome();
    try {
      const { DatabaseSync } = require('node:sqlite');
      // Pre-migration table shape (mirrors the "old-store compat" test above) —
      // CREATE TABLE IF NOT EXISTS in openSqlite is therefore a no-op (table
      // already exists) and the column genuinely comes down to whether the
      // ALTER TABLE ADD COLUMN succeeds.
      const dir = storeLib.storeDirForHash(home, 'noaltercap1');
      fs.mkdirSync(dir, { recursive: true });
      const raw = new DatabaseSync(path.join(dir, 'devswarm.db'));
      raw.exec(
        'CREATE TABLE registry ('
        + ' id TEXT PRIMARY KEY,'
        + ' worktree_path TEXT, session_id TEXT, inbox_path TEXT,'
        + ' cursor_path TEXT, nudge_command TEXT, updated_at INTEGER'
        + ');' // pre-0.61.0 shape — no write_seq column at all
      );
      raw.close();

      const origExec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function patchedExec(sql) {
        if (typeof sql === 'string' && sql.includes('ALTER TABLE registry ADD COLUMN write_seq')) {
          throw new Error('simulated: database is locked'); // NOT "duplicate column name" — a real migration failure
        }
        return origExec.apply(this, arguments);
      };
      let s;
      try {
        s = storeLib.openSqlite(home, null, { hash: 'noaltercap1' });
      } finally {
        DatabaseSync.prototype.exec = origExec; // restore immediately, before any assertions/further opens
      }
      try {
        assert.equal(s.hasWriteSeq, false, 'capability probe correctly observed the column is absent (ALTER failed)');

        // upsertRegistry must NOT throw and must NOT reference write_seq in its SQL.
        assert.doesNotThrow(() => {
          s.upsertRegistry({ id: 'row-f', worktreePath: '/fake/wt', sessionId: 'sess-1' });
        }, 'upsertRegistry must not throw when write_seq is genuinely absent');
        const row = s.listRegistry().find((d) => d.id === 'row-f');
        assert.ok(row, 'the row was written despite the missing column');
        assert.equal(row.writeSeq, null, 'writeSeq reads back null — the column truly does not exist');

        // removeRegistryIf with a writeSeq guard key must fall back to the legacy
        // sessionId/updatedAt guard (ignore the key) rather than emitting write_seq
        // in SQL and throwing on the missing column.
        assert.doesNotThrow(() => {
          const removed = s.removeRegistryIf('row-f', { sessionId: row.sessionId, updatedAt: row.updatedAt, writeSeq: row.writeSeq });
          assert.equal(removed, true, 'legacy guard still correctly deletes a genuinely stable phantom');
        }, 'removeRegistryIf must not throw when write_seq is genuinely absent, even if the caller supplies a writeSeq guard key');
        assert.equal(s.listRegistry().find((d) => d.id === 'row-f'), undefined, 'row was actually removed');

        // Re-registering (a second upsert) must also stay throw-free.
        assert.doesNotThrow(() => {
          s.upsertRegistry({ id: 'row-g', worktreePath: '/fake/wt', sessionId: 'sess-2' });
          s.upsertRegistry({ id: 'row-g', worktreePath: '/fake/wt', sessionId: 'sess-2' });
        }, 'repeated upserts on a column-absent store must never throw');
      } finally { s.close(); }
    } finally { rm(home); }
  });
}
