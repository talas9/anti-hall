'use strict';
// anti-hall :: devswarm-migrate — AUTOMATIC-BUT-SAFE migration of existing on-disk
// DevSwarm state into the Phase-2 store (companion/lib/devswarm-store.js).
//
// Honors the owner directive "read current state and migrate to new version
// automatically": wired to run from the updater path (scripts/migrate-state.js),
// and exposed as `scripts/devswarm.js migrate`.
//
// SOURCES it dual-reads (NEVER mutated by this module):
//   - the JSON registry: ~/.anti-hall/devswarm/workspaces/<id>.json descriptors
//     (via companion/devswarm-supervisor.js readDescriptors — same reader the
//     supervisor uses; requires id + worktreePath + sessionId + safe id).
//   - each descriptor's legacy durable inbox: the append-only NDJSON at
//     descriptor.inboxPath (one message per non-empty line) + its cursorPath
//     (a consumed-count), exactly as companion/lib/liveness.js unreadBacklog reads.
//
// SAFETY CONTRACT (each asserted by a test):
//   - IDEMPOTENT: a message's dedupe hash is derived from (id, line-index, content),
//     so a re-run OR-IGNOREs already-imported lines and imports only genuinely new
//     appended ones. Registry upsert + cursor set are naturally idempotent.
//   - NON-DESTRUCTIVE: reads sources only. It NEVER deletes/moves/truncates a
//     descriptor, inbox, or cursor file. The store is a SECOND home for the data;
//     the legacy files stay byte-for-byte intact so a rollback is always possible.
//   - SINGLE-CONSUMER-LOCKED: an O_EXCL lock (dead-holder/stale-steal, mirroring
//     the supervisor sweep lock) so two migrations never race the same store.
//   - COUNT-VERIFIED: after import, the store's messageCount(id) must equal the
//     number of distinct non-empty legacy inbox lines for that id before the
//     migration is reported `verified:true` for that workspace.
//
// Pure Node built-ins. Fail-soft per workspace: one unreadable descriptor/inbox
// never aborts the whole run.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const store = require('./lib/devswarm-store.js');
const { devswarmRoot, isSafeId } = require('./lib/liveness.js');
const { readCursor } = require('./lib/devswarm-inbox-cursor.js');
const { readDescriptors } = require('./devswarm-supervisor.js');

const MIGRATE_LOCK_STALE_MS = 5 * 60 * 1000;

function migrateLockPath(home) {
  return path.join(devswarmRoot(home), 'locks', 'migrate.lock');
}

function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// acquireMigrateLock(home, io) -> release() | null. Same dead-holder/stale-steal
// discipline as the supervisor sweep lock. null => a live, fresh migration holds
// the lock; caller must abort rather than double-migrate.
function acquireMigrateLock(home, io) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const now = (io && io.now) || Date.now;
  const p = migrateLockPath(home);
  try { F.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      return function release() {
        try { const cur = JSON.parse(F.readFileSync(p, 'utf8')); if (cur && cur.token === token) F.unlinkSync(p); } catch (_) {}
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null; // any other error -> no lock (caller aborts)
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(p, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      let holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      if (holderTs === null) {
        // TORN-READ GUARD: a live holder is briefly a 0-byte file between openSync('wx')
        // and writeSync. A concurrent reader that catches it empty/unparseable must NOT
        // treat it as absent — fall back to the file's MTIME for liveness. A FRESH mtime =
        // live migration mid-write -> back off (never steal); only an OLD mtime (or a stat
        // failure) reads as a dead holder we may reclaim. Mirrors devswarm-store acquireOnce.
        try { holderTs = F.statSync(p).mtimeMs; } catch (_) { holderTs = null; }
      }
      const alive = holderPid !== null && isAlive(holderPid); // a KNOWN-live holder
      const stale = holderTs === null || (now() - holderTs) > MIGRATE_LOCK_STALE_MS;
      // Steal ONLY a stale lock whose holder is NOT alive (dead or unknown pid):
      // a live migration is never stolen however old its timestamp looks, so two
      // migrations can never race the same store.
      if (stale && !alive) { try { F.unlinkSync(p); } catch (_) {} continue; }
      return null; // live migration in progress -> refuse
    }
  }
  return null;
}

// legacyLineHash(id, index, line) — stable dedupe hash for one physical inbox
// line. The index is included so two IDENTICAL messages (same text) remain two
// distinct rows, while a re-run maps each physical line to the SAME hash and is
// therefore OR-IGNOREd (idempotent). Append-only inbox => existing line indices
// never shift, so only newly-appended lines import on a re-run.
function legacyLineHash(id, index, line) {
  return 'legacy:' + crypto.createHash('sha256')
    .update(String(id) + '\x00' + String(index) + '\x00' + String(line))
    .digest('hex');
}

// readInbox(inboxPath, F) -> { readable, lines }. Distinguishes a genuinely
// READABLE inbox (possibly empty) from a MISSING path or a read ERROR — a
// distinction migrateOne needs to avoid falsely reporting `verified:true` for a
// workspace whose legacy inbox it never actually read (silent data loss). Uses the
// SAME non-empty-line filter countMessages/unreadBacklog apply, so counts agree.
//   - inboxPath falsy      -> { readable:false, lines:[] } (no legacy inbox to read)
//   - readFileSync throws  -> { readable:false, lines:[] } (missing/unreadable)
//   - read ok (even empty) -> { readable:true,  lines:[...] }
function readInbox(inboxPath, F) {
  if (!inboxPath) return { readable: false, lines: [] };
  try {
    const lines = String((F || fs).readFileSync(inboxPath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim() !== '');
    return { readable: true, lines };
  } catch (_) { return { readable: false, lines: [] }; }
}

// readInboxLines(inboxPath, F) -> string[] (kept for backward compat; drops the
// readability signal). Absent/unreadable -> [].
function readInboxLines(inboxPath, F) {
  return readInbox(inboxPath, F).lines;
}

// migrateOne(s, descriptor, F) -> per-workspace report. Imports the descriptor
// into the registry, imports its legacy inbox lines (dedupe-hashed), sets the
// cursor, and count-verifies. Never mutates any source file.
function migrateOne(s, descriptor, F) {
  const id = descriptor.id;
  s.upsertRegistry(descriptor);

  // Read the legacy inbox with an explicit readability signal. A MISSING/unreadable
  // inbox must NEVER be treated as a genuinely-empty one: both look like 0 lines,
  // but only the readable-empty case can honestly be reported `verified`. Reporting
  // a read-error as verified-empty would silently drop the workspace's real
  // messages (they were never read, so never imported).
  const inbox = readInbox(descriptor.inboxPath, F);
  if (!inbox.readable) {
    // Do NOT import, do NOT advance the cursor, and do NOT claim verified: surface
    // an error so the caller neither switches nor trusts this workspace.
    return {
      id,
      imported: 0,
      legacyCount: null,
      storeCount: s.messageCount(id),
      cursor: null,
      verified: false,
      error: 'legacy inbox missing or unreadable: '
        + (descriptor.inboxPath ? String(descriptor.inboxPath) : '(no inboxPath)'),
    };
  }

  const lines = inbox.lines;
  let imported = 0;
  for (let i = 0; i < lines.length; i++) {
    const r = s.appendMessage({
      workspaceId: id,
      body: lines[i],
      hash: legacyLineHash(id, i, lines[i]),
      ts: Date.now(),
    });
    if (r && r.inserted) imported++;
  }

  // Carry the legacy consumed-count forward as the store cursor (idempotent set).
  const legacyCursor = readCursor(descriptor.cursorPath, F);
  s.setCursor(id, legacyCursor);

  // Count-verify: the store must now hold exactly as many messages for this id as
  // there are distinct non-empty legacy inbox lines (the inbox we actually read).
  const legacyCount = lines.length;
  const storeCount = s.messageCount(id);
  const verified = storeCount === legacyCount;

  return {
    id, imported, legacyCount, storeCount, cursor: legacyCursor, verified,
  };
}

// migrateToStore({ home, backend, env, now, io }) -> report object.
//   { ok, action:'migrate', locked, backend, migrated:[per-workspace...],
//     workspaces, verifiedAll }.
// locked:false (with ok:false) means another migration/consumer holds the lock —
// the caller must NOT proceed (single-consumer invariant). ok stays true on an
// empty run (no descriptors) — nothing to migrate is success.
function migrateToStore(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = (o.io && o.io.fs) || fs;

  const release = (o.io && o.io.lock)
    ? o.io.lock(home)
    : acquireMigrateLock(home, o.io);
  if (!release) {
    return { ok: false, action: 'migrate', locked: false, error: 'another migration or consumer holds the migrate lock' };
  }

  try {
    const descriptors = readDescriptors(home, F).filter((d) => d && isSafeId(d.id));
    const s = store.openStore({ home, backend: o.backend, env: o.env, fsi: (o.io && o.io.storeFs) });
    let migrated = [];
    try {
      for (const d of descriptors) {
        try { migrated.push(migrateOne(s, d, F)); }
        catch (e) { migrated.push({ id: d && d.id, error: String(e && e.message || e) }); }
      }
      // Only after all imports succeed do we (re)derive the projection hooks read.
      store.deriveSummary(s, { home, env: o.env, now: o.now });
    } finally { s.close(); }

    const verifiedAll = migrated.every((m) => m.error ? false : m.verified);
    return {
      ok: true, action: 'migrate', locked: true,
      backend: store.selectBackend({ backend: o.backend, env: o.env }),
      workspaces: migrated.length,
      migrated,
      verifiedAll,
    };
  } finally {
    try { release(); } catch (_) {}
  }
}

module.exports = {
  migrateToStore, migrateOne, legacyLineHash, readInbox, readInboxLines,
  acquireMigrateLock, migrateLockPath,
};
