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
// OPT-IN "mark imported backlog as read" (field issue A, v0.56.0): a legacy
// source with no consumed-cursor of its own imports its whole backlog at
// cursor 0, surfacing as a big unread wall that can trip the parent
// neglect-gate. `opts.markRead` (or env ANTIHALL_DEVSWARM_MIGRATE_MARK_READ) —
// see resolveMarkRead — advances the cursor to the just-imported message
// count instead. DEFAULT is false: the legacy cursor is preserved exactly as
// before. Never marks a message imported by a LATER run as read.
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

// resolveMarkRead(o) -> bool. OPT-IN "mark imported backlog as read" (field
// issue A): a legacy source with NO consumed-cursor of its own (e.g. a
// pre-0.54 shell-loop NDJSON) imports its whole backlog at cursor 0, which
// then shows up as a big "unread" wall of already-handled history and can trip
// the parent neglect-gate. An explicit boolean o.markRead wins; otherwise falls
// back to the env var ANTIHALL_DEVSWARM_MIGRATE_MARK_READ ('1'/'true',
// case-insensitive) on o.env (else process.env). DEFAULT is false — the
// current cursor-preserving behavior is UNCHANGED unless a caller opts in.
function resolveMarkRead(o) {
  if (o && typeof o.markRead === 'boolean') return o.markRead;
  const env = (o && o.env) || process.env;
  const raw = String((env && env.ANTIHALL_DEVSWARM_MIGRATE_MARK_READ) || '').trim().toLowerCase();
  return raw === '1' || raw === 'true';
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

// bodyMultisetFor(s, id) -> Map<string, number> counting how many times each
// message BODY currently appears in store `s` for workspace `id`. Used (with
// consumeBody) as a CROSS-PATH dedupe IDENTITY: two migration paths (the
// global-store split, hash `native:*`/`global-migrate:*`, vs the descriptor-inbox
// import, hash `legacy:*`) hash the SAME message content differently, so a
// hash-only OR-IGNORE cannot collapse a message copied by one path with the same
// message mirrored via the other path — both would insert, producing a duplicate
// row. A plain Set (one bit per body) fixes that but breaks two DISTINCT
// messages that merely share an identical body: the second would be wrongly
// dropped as "already migrated". The multiset instead tracks how many copies of
// each body are already accounted for, and consumeBody draws down that pool one
// occurrence at a time — so exactly as many same-body lines are skipped as the
// store already holds, and any occurrence BEYOND that still imports as its own
// row. pendingLegacyLines (below) runs the IDENTICAL draw-down over the SAME
// multiset so "already migrated" and "still pending" agree on one definition of
// coverage — this is also what fixes migrate-state.js's dryRun pending check,
// which used to test raw legacyLineHash presence and could never see a line that
// THIS cross-path dedupe intentionally skipped inserting.
function bodyMultisetFor(s, id) {
  const counts = new Map();
  try {
    for (const m of s.listMessages(id)) {
      const b = m && m.body != null ? String(m.body) : '';
      counts.set(b, (counts.get(b) || 0) + 1);
    }
  } catch (_) { /* fail-open: an unreadable store yields no cross-path dedup, never a throw */ }
  return counts;
}

// consumeBody(counts, body) -> bool. True (and decrements the pool) iff the
// multiset still holds an unconsumed copy of `body` — this occurrence is
// ALREADY covered by a row some path put in the store. False (pool exhausted,
// or never had this body) means this occurrence is NOT yet covered and must be
// imported as its own row.
function consumeBody(counts, body) {
  const n = counts.get(body) || 0;
  if (n <= 0) return false;
  counts.set(body, n - 1);
  return true;
}

// pendingLegacyLines(s, id, lines) -> number[] indices of `lines` NOT YET
// covered by store `s` for workspace `id`, under the exact identity migrateOne
// uses to decide what to import (bodyMultisetFor + consumeBody). Shared by
// migrateOne (picks which indices to import) and migrate-state.js's dryRun gap
// check (reports pending iff this returns anything), so "imported" and
// "pending" can never disagree about the same line.
function pendingLegacyLines(s, id, lines) {
  const counts = bodyMultisetFor(s, id);
  const pending = [];
  for (let i = 0; i < lines.length; i++) {
    if (!consumeBody(counts, lines[i])) pending.push(i);
  }
  return pending;
}

// migrateOne(s, descriptor, F, opts) -> per-workspace report. Imports the
// descriptor into the registry, imports its legacy inbox lines (dedupe-hashed),
// sets the cursor, and count-verifies. Never mutates any source file.
// opts.markRead (default false, see resolveMarkRead) — when true, the cursor
// is advanced to this workspace's post-import message count instead of the
// legacy cursor, so the just-imported backlog reads as already-seen.
function migrateOne(s, descriptor, F, opts) {
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
  // Which lines are NOT YET represented in the store (e.g. by the global-store
  // split, which runs earlier in migrateToStore) under the shared cross-path
  // identity — a line whose occurrence is already covered by another path's row
  // is the SAME message under a different hash namespace, so it is skipped here
  // rather than inserted as a second (duplicate) row. A line whose body repeats
  // BEYOND what the store already holds is a genuinely distinct message and
  // still imports.
  const pendingIdx = new Set(pendingLegacyLines(s, id, lines));
  let imported = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!pendingIdx.has(i)) continue; // already covered by another path
    const r = s.appendMessage({
      workspaceId: id,
      body: lines[i],
      hash: legacyLineHash(id, i, lines[i]),
      ts: Date.now(),
    });
    if (r && r.inserted) imported++;
  }

  // Count-verify: the store must now hold exactly as many messages for this id as
  // there are distinct non-empty legacy inbox lines (the inbox we actually read).
  const legacyCount = lines.length;
  const storeCount = s.messageCount(id);
  const verified = storeCount === legacyCount;

  // Carry the legacy consumed-count forward as the store cursor (idempotent
  // set) — UNLESS opts.markRead is set, in which case advance the cursor to
  // this workspace's post-import message count (storeCount, a snapshot taken
  // NOW) instead: the entire backlog THIS migration just imported reads as
  // already-seen (unread≈0). Math.max never regresses a cursor that was
  // already further along. A message appended to the store after this call
  // returns is untouched, so it still surfaces as unread. DEFAULT
  // (markRead absent/false) is BYTE-FOR-BYTE the old behavior: the legacy
  // cursor, preserved as-is.
  const legacyCursor = readCursor(descriptor.cursorPath, F);
  const markRead = !!(opts && opts.markRead);
  const cursor = markRead ? Math.max(legacyCursor, storeCount) : legacyCursor;
  s.setCursor(id, cursor);

  return {
    id, imported, legacyCount, storeCount, cursor, verified, markRead,
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
  const markRead = resolveMarkRead(o);

  const release = (o.io && o.io.lock)
    ? o.io.lock(home)
    : acquireMigrateLock(home, o.io);
  if (!release) {
    return { ok: false, action: 'migrate', locked: false, error: 'another migration or consumer holds the migrate lock' };
  }

  try {
    // FIRST: split any pre-existing GLOBAL store (v0.54.x) into per-project stores,
    // non-destructively (the global file is left in place as a backup). This lets a
    // 0.54.x user upgrade to the per-project layout without losing data.
    let globalSplit = null;
    try { globalSplit = migrateGlobalStoreToPerProject({ home, backend: o.backend, env: o.env, now: o.now, io: o.io, markRead }); }
    catch (e) { globalSplit = { ok: false, error: String(e && e.message || e) }; }

    const descriptors = readDescriptors(home, F).filter((d) => d && isSafeId(d.id));
    let migrated = [];
    // PER-PROJECT: each descriptor migrates into ITS OWN physical store.
    for (const d of descriptors) {
      const s = store.openStore({ home, workspaceId: d.id, backend: o.backend, env: o.env, fsi: (o.io && o.io.storeFs) });
      try {
        migrated.push(migrateOne(s, d, F, { markRead }));
        // (re)derive this project's projection only after its import succeeds.
        store.deriveSummary(s, { home, workspaceId: d.id, env: o.env, now: o.now });
      } catch (e) {
        migrated.push({ id: d && d.id, error: String(e && e.message || e) });
      } finally { s.close(); }
    }

    const verifiedAll = migrated.every((m) => m.error ? false : m.verified);
    return {
      ok: true, action: 'migrate', locked: true,
      backend: store.selectBackend({ backend: o.backend, env: o.env }),
      workspaces: migrated.length,
      migrated,
      globalSplit,
      verifiedAll,
      markRead,
    };
  } finally {
    try { release(); } catch (_) {}
  }
}

// ----- GLOBAL -> PER-PROJECT split (v0.54.x upgrade path) -----
// synthGlobalHash(id, seq, body) — a stable dedupe hash for a legacy GLOBAL-store
// message row that carried NO hash of its own (so a re-run OR-IGNOREs it instead of
// duplicating). Rows that already have a hash (native:/legacy:/escalate:) keep it.
function synthGlobalHash(id, seq, body) {
  return 'global-migrate:' + crypto.createHash('sha256')
    .update(String(id) + '\x00' + String(seq) + '\x00' + String(body))
    .digest('hex');
}

// legacyGlobalBackendsPresent(home, F) -> ('sqlite'|'journal')[]. Detects WHICH
// pre-per-project GLOBAL store layout(s) actually exist on disk: store/devswarm.db
// (sqlite) and/or store/journal/*.ndjson (journal). The per-project layout puts
// these under store/<hash>/…, so a file DIRECTLY under store/ is the legacy
// signal. BOTH can be present at once (e.g. a runtime flip mid-lifetime wrote a
// sqlite db, then a later run without node:sqlite fell back to journal) — the
// caller must migrate whichever backend(s) the LEGACY store actually used,
// independent of what backend THIS runtime would otherwise select (the bug this
// fixes: selecting only the runtime-detected backend silently skips a legacy
// store written in the other format -> 0 messages copied -> data loss).
function legacyGlobalBackendsPresent(home, F) {
  const f = F || fs;
  const root = store.storeRootDir(home);
  const present = [];
  try { if (f.statSync(path.join(root, 'devswarm.db')).isFile()) present.push('sqlite'); } catch (_) {}
  try {
    const jdir = path.join(root, 'journal');
    const names = f.readdirSync(jdir).filter((n) => n.endsWith('.ndjson'));
    if (names.length) present.push('journal');
  } catch (_) {}
  return present;
}

// legacyGlobalStoreExists(home, F) -> bool. True when EITHER legacy layout is
// present (kept for the dryRun/gap-reporting callers that only need a boolean).
function legacyGlobalStoreExists(home, F) {
  return legacyGlobalBackendsPresent(home, F).length > 0;
}

// migrateGlobalStoreToPerProject({home, backend, env, now, io}) -> report.
// Reads the LEGACY global store — EVERY legacy backend layout actually found on
// disk (store/devswarm.db AND/OR store/journal/*.ndjson; usually one, but both can
// exist if the runtime's backend selection changed mid-lifetime), NEVER only the
// backend this runtime would currently select — and for each distinct
// workspace_id copies its messages/registry/cursor/gates into the per-project
// store store/<hashFromWorkspaceId>/, then derives that project's summary.
// `o.backend` still controls which backend the DESTINATION per-project store
// uses; it plays no part in choosing which legacy SOURCE data gets read (reading
// only the runtime-selected backend, ignoring a legacy store written in the OTHER
// format, silently dropped that store's messages — the bug this fixes).
// NON-DESTRUCTIVE — the global store is left byte-for-byte intact as a backup
// (never deleted). IDEMPOTENT — appendMessage OR-IGNOREs by content hash
// (null-hash rows get a stable synthesized hash), so a re-run copies nothing new.
// CROSS-BACKEND DEDUPE — when both legacy layouts exist, a message present in
// both (or mirrored from a descriptor's legacy inbox — see migrateOne) collapses
// to one row via bodyMultisetFor/consumeBody's cross-path content-identity check.
function migrateGlobalStoreToPerProject(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = (o.io && o.io.storeFs) || (o.io && o.io.fs) || fs;
  const markRead = resolveMarkRead(o);
  const presentBackends = legacyGlobalBackendsPresent(home, F);
  if (!presentBackends.length) {
    return { ok: true, action: 'migrate-global', present: false, workspaces: 0, copied: 0 };
  }
  const legacyDir = store.storeRootDir(home);
  let copied = 0;
  const idsSeen = new Set();
  const perWorkspace = new Map(); // id -> { id, hash, copied } (accumulated across backends)

  for (const legacyBackend of presentBackends) {
    // Force the backend to the ONE we just detected on disk for this pass —
    // never o.backend/env auto-selection, which is what silently skipped a
    // legacy store written in the other format.
    const src = store.openStore({ home, backend: legacyBackend, env: o.env, dir: legacyDir, hash: 'legacy', fsi: (o.io && o.io.storeFs) });
    try {
      const ids = (typeof src.listWorkspaceIds === 'function' ? src.listWorkspaceIds() : []).filter((id) => isSafeId(id));
      const reg = (function () { try { return src.listRegistry(); } catch (_) { return []; } })();
      for (const id of ids) {
        idsSeen.add(id);
        const hash = store.hashFromWorkspaceId(id);
        // Destination backend is the RUNTIME's own choice (o.backend / auto-detect),
        // independent of which legacy backend this pass is reading from.
        const dst = store.openStore({ home, workspaceId: id, backend: o.backend, env: o.env, fsi: (o.io && o.io.storeFs) });
        let wsCopied = 0;
        try {
          // Snapshot content already persisted for this id (e.g. by a PRIOR legacy
          // backend processed earlier in this same run) so a message present in
          // both legacy layouts collapses to one row instead of two — while a
          // genuinely distinct message that merely shares a body with an
          // already-persisted one still gets its own row (consumeBody only
          // draws down as many same-body occurrences as are already covered).
          const preExisting = bodyMultisetFor(dst, id);
          const msgs = src.listMessages(id); // {seq, ts, hash, body}
          for (const m of msgs) {
            const bodyStr = m.body != null ? String(m.body) : '';
            if (consumeBody(preExisting, bodyStr)) continue; // same content already migrated (this or another backend)
            const h = (m.hash != null) ? String(m.hash) : synthGlobalHash(id, m.seq, m.body);
            const r = dst.appendMessage({ workspaceId: id, body: m.body, hash: h, ts: Number.isFinite(m.ts) ? m.ts : o.now });
            if (r && r.inserted) { wsCopied++; copied++; }
          }
          const regEntry = reg.find((d) => d && String(d.id) === String(id));
          if (regEntry) dst.upsertRegistry(regEntry);
          // Cursor: never regress a further-along cursor a prior backend already
          // carried forward for this id — take the max of what's there and what
          // this backend reports. OPT-IN markRead additionally advances the
          // cursor to this workspace's post-copy message count (this run's
          // imported backlog reads as already-seen); DEFAULT is unchanged.
          const mergedCursor = Math.max(Number(dst.cursorValue(id)) || 0, Number(src.cursorValue(id)) || 0);
          const cursorToSet = markRead ? Math.max(mergedCursor, Number(dst.messageCount(id)) || 0) : mergedCursor;
          dst.setCursor(id, cursorToSet);
          const gates = src.currentGates(id);
          for (const name of Object.keys(gates)) dst.setGate({ workspaceId: id, name, value: gates[name] });
          store.deriveSummary(dst, { home, workspaceId: id, env: o.env, now: o.now });
        } finally { dst.close(); }
        const prior = perWorkspace.get(id);
        perWorkspace.set(id, { id, hash, copied: (prior ? prior.copied : 0) + wsCopied });
      }
    } finally { try { src.close(); } catch (_) {} }
  }

  return {
    ok: true, action: 'migrate-global', present: true,
    workspaces: idsSeen.size, copied, perWorkspace: Array.from(perWorkspace.values()),
    markRead,
  };
}

// migrateLegacyInbox({ home, source, workspaceId, backend, env, now, dryRun, io })
// -> report. Fold a SINGLE legacy NDJSON inbox (`source`) into the store under an
// explicit `workspaceId` — the direct import path a Primary uses after
// `register-primary` to pull in stranded messages, when there is no full descriptor
// to drive migrateToStore. Shares migrateOne's guarantees:
//   - IDEMPOTENT: each physical line hashes via legacyLineHash(workspaceId,i,line),
//     so a re-run OR-IGNOREs already-imported lines (and co-exists with the same
//     hashes written by a descriptor-driven migrate — no double count).
//   - NON-DESTRUCTIVE: reads `source` only; never deletes/moves/truncates it.
//   - SINGLE-CONSUMER-LOCKED: takes the same migrate lock as migrateToStore.
//   - VERIFIED: after import, every source line's hash is confirmed present in the
//     store via listMessages read-back (the workspace may ALSO hold native-drained
//     rows, so we verify SOURCE-line coverage, not messageCount equality).
// dryRun -> DETECT ONLY (no lock, no writes): { pending, lines } for gap reporting.
function migrateLegacyInbox(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = (o.io && o.io.fs) || fs;
  const workspaceId = o.workspaceId;
  const source = o.source;
  if (!isSafeId(workspaceId)) {
    return { ok: false, action: 'migrate-legacy-inbox', error: 'unsafe or missing workspaceId: ' + JSON.stringify(workspaceId) };
  }
  if (!source) {
    return { ok: false, action: 'migrate-legacy-inbox', workspaceId, error: 'missing source (legacy NDJSON path)' };
  }

  const inbox = readInbox(source, F);
  if (!inbox.readable) {
    return { ok: false, action: 'migrate-legacy-inbox', workspaceId, source, error: 'legacy inbox missing or unreadable: ' + String(source) };
  }
  const lines = inbox.lines;

  if (o.dryRun) {
    return { action: 'migrate-legacy-inbox', dryRun: true, workspaceId, source, pending: lines.length > 0, lines: lines.length };
  }

  const release = (o.io && o.io.lock) ? o.io.lock(home) : acquireMigrateLock(home, o.io);
  if (!release) {
    return { ok: false, action: 'migrate-legacy-inbox', locked: false, error: 'another migration or consumer holds the migrate lock' };
  }

  const markRead = resolveMarkRead(o);
  try {
    // PER-PROJECT: fold into the workspace's OWN physical store.
    const s = store.openStore({ home, workspaceId, backend: o.backend, env: o.env, fsi: (o.io && o.io.storeFs) });
    let imported = 0;
    let verified = false;
    try {
      const wantHashes = [];
      for (let i = 0; i < lines.length; i++) {
        const h = legacyLineHash(workspaceId, i, lines[i]);
        wantHashes.push(h);
        const r = s.appendMessage({ workspaceId, body: lines[i], hash: h, ts: Date.now() });
        if (r && r.inserted) imported++;
      }
      // OPT-IN markRead: this direct-import path never set a cursor before
      // (there is no descriptor cursorPath to carry forward) — DEFAULT stays
      // exactly that (no cursor write). When markRead is set, advance the
      // cursor to at least this workspace's post-import message count so the
      // just-imported backlog reads as already-seen instead of a big unread
      // wall; Math.max never regresses a cursor already further along.
      if (markRead) {
        const total = s.messageCount(workspaceId);
        const cur = Number(s.cursorValue(workspaceId)) || 0;
        s.setCursor(workspaceId, Math.max(cur, total));
      }
      store.deriveSummary(s, { home, workspaceId, env: o.env, now: o.now });
      // Read-back verify: every source-line hash is now present in the store.
      const have = new Set(s.listMessages(workspaceId).map((m) => m.hash));
      verified = wantHashes.every((h) => have.has(h));
    } finally { s.close(); }
    return {
      ok: true, action: 'migrate-legacy-inbox', locked: true, workspaceId, source,
      backend: store.selectBackend({ backend: o.backend, env: o.env }),
      lines: lines.length, imported, verified, markRead,
    };
  } finally {
    try { release(); } catch (_) {}
  }
}

module.exports = {
  migrateToStore, migrateOne, migrateLegacyInbox, legacyLineHash, readInbox, readInboxLines,
  acquireMigrateLock, migrateLockPath,
  migrateGlobalStoreToPerProject, legacyGlobalStoreExists, synthGlobalHash,
  bodyMultisetFor, consumeBody, pendingLegacyLines, resolveMarkRead,
};
