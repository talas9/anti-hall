'use strict';
// anti-hall :: devswarm-store — the persistent WRITE/DERIVE side of the DevSwarm
// substrate. ONE store API, TWO interchangeable backends, chosen by
// FEATURE-DETECT (not a node-version comparison):
//
//     try { require('node:sqlite') }  -> sqlite backend (WAL)
//     catch                           -> journal (append-only NDJSON) backend
//
// Node 22.5 shipped `node:sqlite` behind --experimental-sqlite and daemons launch
// flagless, so a version check (node >= 22.5) would misdetect availability; the
// require-and-catch probe is robust regardless of the exact flagless-backport
// version (see PLAN.md Phase 2 — scope corrections, Fable P2-8). The journal
// backend is dependency-free and green on node 18/20 where node:sqlite is absent.
//
// LAYERING (PLAN.md P1-B): HOOKS NEVER OPEN THE DB. The store is the write/derive
// side only. It derives a `summary.json` PROJECTION (atomic tmp+rename) that hooks
// read; `unreadBacklog()` / `computeLiveness()` in liveness.js keep their existing
// path-addressed (fs/git) signatures — this module is the side that DERIVES the
// projections, never a new read surface for those functions.
//
// DATA MODEL (append-only where it carries history — never lose the trail):
//   messages : timestamped, append-only; idempotent by optional dedupe `hash`.
//   registry : workspaces (id, worktreePath, sessionId, inboxPath, cursorPath,
//              nudgeCommand); upsert (current mirror of the active descriptor set).
//   cursors  : per-workspace consumed-count (mirrors liveness.js's cursor = number
//              of consumed non-empty inbox lines).
//   gates    : per-workspace named boolean COMPLETION GATES, timestamped +
//              APPEND-ONLY (a set/clear appends a new {name,value,set_at,set_by}
//              row; current value = latest row per name). anti-hall stays AGNOSTIC
//              about what any consumer gate (e.g. `deployed`) MEANS — the consumer
//              sets them; the store only tracks and derives.
//
// DERIVED archive_ready: true when ALL required gates are satisfied for an ACTIVE
// workspace (present in the registry). The required-gate set is CONFIGURABLE
// (default done,merged,tests_passed; override via ANTIHALL_DEVSWARM_REQUIRED_GATES)
// — anti-hall hardcodes no consumer-specific gate name.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { devswarmRoot, isSafeId } = require('./liveness.js');

const DEFAULT_REQUIRED_GATES = ['done', 'merged', 'tests_passed'];

// ----- paths (PHYSICALLY PER-PROJECT) -----
// Each project (worktree) gets its OWN physical store under store/<hash>/, where
// <hash> is derived from the workspaceId the caller operates on. This replaces the
// former ONE global store/devswarm.db (+ journal) keyed only on $HOME. The
// workspace_id column is retained (harmless), but each per-project store now holds
// one project's data. summary.json ALSO becomes per-project, deliberately placed
// OUTSIDE store/ (under summaries/) so the inbox read-guard — which DENYs store/**
// — still ALLOWs the derived projection hooks read.
//
// DEFAULT_HASH: a stable bucket for a store opened with NO workspaceId (legacy
// callers/tests that write MANY workspace_ids into one column-partitioned handle).
// sha256('') is deterministic and 8-hex, so the read-guard's hash regex matches it.
const DEFAULT_HASH = crypto.createHash('sha256').update('').digest('hex').slice(0, 8);

// hashFromWorkspaceId(workspaceId) -> 8 lowercase hex chars. `primary-<hash>`
// (install-devswarm-ingest.js's per-worktree Primary id) unwraps to that exact
// worktreeHash, so the ingest daemon, the CLI, the parent-inbox hook, and doctor
// all agree on which per-project dir a Primary's reception queue lives in. Any
// other id (a child workspace, an arbitrary CLI id) buckets by sha256(id) so it
// still gets its own physical store. Absent/empty -> DEFAULT_HASH.
function hashFromWorkspaceId(workspaceId) {
  const id = String(workspaceId == null ? '' : workspaceId);
  if (id === '') return DEFAULT_HASH;
  const m = id.match(/^primary-([0-9a-fA-F]{8})$/);
  if (m) return m[1].toLowerCase();
  return crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
}

// ----- roots -----
function storeRootDir(home) {
  return path.join(devswarmRoot(home), 'store');
}
function summariesRootDir(home) {
  return path.join(devswarmRoot(home), 'summaries');
}

// ----- hash-keyed (doctor/migration enumerate by hash) -----
function storeDirForHash(home, hash) {
  return path.join(storeRootDir(home), String(hash));
}
function sqlitePathForHash(home, hash) {
  return path.join(storeDirForHash(home, hash), 'devswarm.db');
}
function journalDirForHash(home, hash) {
  return path.join(storeDirForHash(home, hash), 'journal');
}
function summaryPathForHash(home, hash) {
  return path.join(summariesRootDir(home), String(hash) + '.json');
}

// ----- workspaceId-keyed (the public/test convenience surface) -----
function storeDir(home, workspaceId) {
  return storeDirForHash(home, hashFromWorkspaceId(workspaceId));
}
function sqlitePath(home, workspaceId) {
  return sqlitePathForHash(home, hashFromWorkspaceId(workspaceId));
}
function journalDir(home, workspaceId) {
  return journalDirForHash(home, hashFromWorkspaceId(workspaceId));
}
function summaryPath(home, workspaceId) {
  return summaryPathForHash(home, hashFromWorkspaceId(workspaceId));
}

// listStoreHashes(home, fsi, opts) -> string[] of per-project store subdir names
// present under store/. Fail-open [] on any read error. Used by doctor/migration to
// ENUMERATE per-project stores instead of one global file.
//   Matches the LEGACY 8-hex shape (^[0-9a-fA-F]{8}$) AND, additively (D20), the
//   NEW repoKey shape (^[a-z0-9-]{1,40}-[0-9a-f]{6}$) so doctor/enumeration is not
//   blind to a post-migration repoKey store. Disjoint by construction (a repoKey
//   always contains a literal '-' separator; a legacy hash never does).
//   opts.shape === 'legacy' restricts to ONLY the 8-hex shape (D13/Phase 3 —
//   migration source enumeration must never iterate the repoKey stores IT creates,
//   avoiding self-migration noise / target==source double-open).
const LEGACY_HASH_RE = /^[0-9a-fA-F]{8}$/;
const REPOKEY_SHAPE_RE = /^[a-z0-9-]{1,40}-[0-9a-f]{6}$/;
function listStoreHashes(home, fsi, opts) {
  const F = fsi || fs;
  const o = opts || {};
  let names = [];
  try { names = F.readdirSync(storeRootDir(home)); } catch (_) { return []; }
  if (o.shape === 'legacy') return names.filter((n) => LEGACY_HASH_RE.test(n));
  return names.filter((n) => LEGACY_HASH_RE.test(n) || REPOKEY_SHAPE_RE.test(n));
}

// ----- config -----
// requiredGatesFrom(env) -> string[]. Default done,merged,tests_passed; a consumer
// extends/replaces it via ANTIHALL_DEVSWARM_REQUIRED_GATES (csv). Gate names are
// consumer-defined so they are trimmed but NOT normalized/lowercased (agnostic).
function requiredGatesFrom(env) {
  const e = env || process.env;
  const raw = e.ANTIHALL_DEVSWARM_REQUIRED_GATES;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (parts.length) return parts;
  }
  return DEFAULT_REQUIRED_GATES.slice();
}

// selectBackend(opts) -> 'sqlite' | 'journal'. FEATURE-DETECT, force-overridable
// (opts.backend or ANTIHALL_DEVSWARM_STORE_BACKEND=journal) so tests can exercise
// the journal path even on a runtime that HAS node:sqlite.
function selectBackend(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const forced = String(o.backend || env.ANTIHALL_DEVSWARM_STORE_BACKEND || '').trim().toLowerCase();
  if (forced === 'journal' || forced === 'sqlite') {
    if (forced === 'sqlite' && !sqliteAvailable()) return 'journal'; // asked-for-but-absent -> safe fallback
    return forced;
  }
  return sqliteAvailable() ? 'sqlite' : 'journal';
}
function sqliteAvailable() {
  try { require('node:sqlite'); return true; } catch (_) { return false; }
}

// ============================================================================
// Mesh (v0.57) shared constants — PLAN-v0.57-mesh.md D3-D7, D22, D23.
// ============================================================================
// BROADCAST_PARTITION_ID — the single shared `workspace_id` every broadcast /
// heartbeat row lands in (D3). NOT a real workspace: it fails isSafeId (contains
// '*'), so it can never be path.join'd into a liveness/registry file path, and
// deriveSummary explicitly skips it if it were ever (mis-)registered.
const BROADCAST_PARTITION_ID = '*mesh-broadcast*';
const URGENCY_RANK = { low: 0, normal: 1, high: 2, urgent: 3 };
const DEFAULT_RECENT_CAP = 50; // O-D8 (broadcast retention) UNRESOLVED — sane default, overridable via opts.recentCap.

// ensureMessagesMeshColumns(db) — additive migration for a `messages` table that
// pre-dates the v0.57 mesh columns (an on-disk store created by <=0.56). A brand
// new table already has them via CREATE TABLE; this is a no-op there. For an
// EXISTING table missing them, ALTER TABLE ADD COLUMN (all nullable — never a
// destructive rewrite, never touches an existing row's data).
function ensureMessagesMeshColumns(db) {
  let cols = [];
  try { cols = db.prepare('PRAGMA table_info(messages);').all().map((r) => String(r.name)); } catch (_) { return; }
  const need = [
    ['sender', 'TEXT'], ['recipient', 'TEXT'], ['mtype', 'TEXT'],
    ['urgency', 'TEXT'], ['is_heartbeat', 'INTEGER'], ['seq', 'INTEGER'],
  ];
  for (const [name, type] of need) {
    if (!cols.includes(name)) {
      try { db.exec('ALTER TABLE messages ADD COLUMN ' + name + ' ' + type + ';'); } catch (_) { /* best-effort, fail-open */ }
    }
  }
}

// meshMessageHash(fields) -> 'mesh:<sha256>'. The DISJOINT dedupe namespace for
// STORE-DIRECT mesh sends (D7) — over sender+recipient+mtype+urgency+message+
// timestamp, so two DISTINCT broadcasts never collapse under UNIQUE(hash)/journal
// dedupe. The 'mesh:' prefix keeps this namespace structurally disjoint from the
// EXISTING native 'native:' messageHash (devswarm-ingest.js) — no cross-path
// collision is even possible, by construction.
function meshMessageHash(fields) {
  const f = fields || {};
  const parts = [
    f.from != null ? String(f.from) : '',
    f.to != null ? String(f.to) : '',
    f.type != null ? String(f.type) : '',
    f.urgency != null ? String(f.urgency) : '',
    f.message != null ? String(f.message) : '',
    f.timestamp != null ? String(f.timestamp) : '',
  ].join(' ');
  return 'mesh:' + crypto.createHash('sha256').update(parts).digest('hex');
}

// appendMeshMessage(store, {from,to,type,message,timestamp,urgency,hash,isHeartbeat})
// -> {inserted, seq}. The WIRE-CONTRACT-to-physical-row mapping (D3): a DIRECT row's
// workspace_id is the CALLER-SUPPLIED `to` (the target's real read partition per D19
// — the caller resolves meshId -> builder-id partition BEFORE calling this; this
// layer does not know about meshId resolution) so the EXISTING per-workspace
// messageCount/listMessages/cursor machinery works verbatim as that recipient's
// inbox. A BROADCAST (or HEARTBEAT, D22) row's workspace_id is the single shared
// BROADCAST_PARTITION_ID. `hash` is an EXPLICIT parameter (D7) — the caller decides
// the dedupe namespace: a store-direct mesh send passes `meshMessageHash(fields)`;
// a native-drained row (Phase 5) passes the EXISTING `native:`-prefixed
// `messageHash`. `isHeartbeat` sets the orthogonal D22 marker; it does NOT change
// `mtype` (a heartbeat is `mtype='broadcast'` + `is_heartbeat=1`, never a third
// mtype value).
function appendMeshMessage(store, fields) {
  const f = fields || {};
  const type = f.type === 'broadcast' ? 'broadcast' : 'direct';
  const from = f.from != null ? String(f.from) : null;
  const to = f.to != null ? String(f.to) : null;
  const message = f.message != null ? String(f.message) : '';
  const ts = Number.isFinite(f.timestamp) ? f.timestamp : Date.now();
  const urgency = f.urgency != null ? String(f.urgency) : 'normal';
  const hash = f.hash != null ? String(f.hash) : null;
  const isHeartbeat = !!f.isHeartbeat;
  const workspaceId = type === 'direct' ? to : BROADCAST_PARTITION_ID;
  const recipient = type === 'direct' ? to : null;
  return store.appendMeshRow({
    workspaceId, ts, hash, body: message,
    sender: from, recipient, mtype: type, urgency, isHeartbeat,
  });
}

// ============================================================================
// SQLite backend (WAL). Touches a real db file (DatabaseSync has no fs injection);
// tests point it at an isolated temp HOME.
// ============================================================================
function openSqlite(home, workspaceId, opts) {
  const o = opts || {};
  const hash = o.hash != null ? String(o.hash) : hashFromWorkspaceId(workspaceId);
  const dir = o.dir || storeDirForHash(home, hash);
  // busy_timeout (D6 — mesh writer-availability): mesh concentrates MANY concurrent
  // writer PROCESSES on one shared db (daemon drain, per-turn heartbeats, mesh
  // sends, registry upserts). node:sqlite's DatabaseSync throws SQLITE_BUSY
  // IMMEDIATELY on writer contention with no busy handler set; PRAGMA busy_timeout
  // makes a contended writer WAIT (bounded) instead of throwing. Overridable
  // (opts.busyTimeoutMs) so tests can drive contention deterministically.
  const busyTimeoutMs = Number.isFinite(o.busyTimeoutMs) ? o.busyTimeoutMs : 3000;
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'devswarm.db'));
  // busy_timeout MUST be the FIRST statement on this connection, BEFORE even the
  // journal_mode/foreign_keys pragmas and the CREATE TABLE IF NOT EXISTS calls
  // below — those can ALSO throw SQLITE_BUSY under contention (e.g. two processes
  // opening the same file for the first time, or a concurrent writer mid-WAL-
  // checkpoint) since busy_timeout only protects statements issued AFTER it takes
  // effect on this connection. Verified live: setting it after journal_mode still
  // let 'PRAGMA journal_mode = WAL' itself throw 'database is locked' under a
  // genuine two-process race.
  db.exec('PRAGMA busy_timeout = ' + Math.max(0, Math.floor(busyTimeoutMs)) + ';');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS messages ('
    + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + ' workspace_id TEXT NOT NULL,'
    + ' ts INTEGER NOT NULL,'
    + ' hash TEXT,'
    + ' body TEXT,'
    // mesh columns (v0.57, D3/D6/D7/D22) — ALL NULLABLE so a pre-existing table
    // (created before this ALTER) and pre-migration rows stay valid; a legacy row
    // simply reads back with these as null (edge_case: mtype null -> treated as a
    // legacy direct by any mesh-aware reader).
    + ' sender TEXT,'
    + ' recipient TEXT,'
    + ' mtype TEXT,'
    + ' urgency TEXT,'
    + ' is_heartbeat INTEGER,'
    + ' seq INTEGER,'
    + ' UNIQUE(hash)'
    + ');'
  );
  ensureMessagesMeshColumns(db); // additive migration for a table that pre-dates the mesh columns
  db.exec(
    'CREATE TABLE IF NOT EXISTS registry ('
    + ' id TEXT PRIMARY KEY,'
    + ' worktree_path TEXT, session_id TEXT, inbox_path TEXT,'
    + ' cursor_path TEXT, nudge_command TEXT, updated_at INTEGER'
    + ');'
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS cursors ('
    + ' workspace_id TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER'
    + ');'
  );
  db.exec(
    'CREATE TABLE IF NOT EXISTS gates ('
    + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + ' workspace_id TEXT NOT NULL, gate_name TEXT NOT NULL,'
    + ' value INTEGER NOT NULL, set_at INTEGER, set_by TEXT'
    + ');'
  );
  // broadcast_cursors (D5) — a SEPARATE additive table (NOT a change to `cursors`'
  // PRIMARY KEY, which would be a migration hazard). Mirrors `cursors` exactly;
  // each workspace tracks broadcasts-seen independently of its direct-inbox cursor.
  db.exec(
    'CREATE TABLE IF NOT EXISTS broadcast_cursors ('
    + ' workspace_id TEXT PRIMARY KEY, value INTEGER NOT NULL, updated_at INTEGER'
    + ');'
  );

  return {
    backend: 'sqlite',
    workspaceId: workspaceId != null ? String(workspaceId) : null,
    hash,
    // listWorkspaceIds() -> distinct workspace ids present anywhere in this store
    // (messages/registry/cursors/gates). Used by the global->per-project migration
    // to split a legacy multi-workspace store file. Pure read.
    listWorkspaceIds() {
      const ids = new Set();
      try { for (const r of db.prepare('SELECT DISTINCT workspace_id AS id FROM messages;').all()) ids.add(String(r.id)); } catch (_) {}
      try { for (const r of db.prepare('SELECT id FROM registry;').all()) ids.add(String(r.id)); } catch (_) {}
      try { for (const r of db.prepare('SELECT DISTINCT workspace_id AS id FROM cursors;').all()) ids.add(String(r.id)); } catch (_) {}
      try { for (const r of db.prepare('SELECT DISTINCT workspace_id AS id FROM gates;').all()) ids.add(String(r.id)); } catch (_) {}
      return Array.from(ids);
    },
    appendMessage(m) {
      const hash = (m && m.hash != null) ? String(m.hash) : null;
      const ts = Number.isFinite(m && m.ts) ? m.ts : Date.now();
      const body = (m && m.body != null) ? String(m.body) : '';
      const stmt = db.prepare(
        'INSERT ' + (hash !== null ? 'OR IGNORE ' : '')
        + 'INTO messages (workspace_id, ts, hash, body) VALUES (?, ?, ?, ?);'
      );
      const r = stmt.run(String(m.workspaceId), ts, hash, body);
      return { inserted: r.changes > 0 };
    },
    // appendMeshRow(m) -> {inserted, seq}. The mesh-aware insert (D3/D6/D7/D22) —
    // called by the top-level appendMeshMessage(), never directly by a consumer.
    // `seq` is computed INSIDE this single INSERT statement (D6 collision-safety):
    // sqlite's writer serialization makes the COALESCE(MAX(seq),0)+1 subquery
    // atomic across concurrent writer PROCESSES — a JS read-MAX-then-bind across
    // processes would race and could assign a DUPLICATE seq, which is FORBIDDEN.
    // COALESCE handles the all-NULL legacy-rows-only case (bare MAX() would be
    // NULL, poisoning every subsequent seq).
    appendMeshRow(m) {
      const hash = (m && m.hash != null) ? String(m.hash) : null;
      const ts = Number.isFinite(m && m.ts) ? m.ts : Date.now();
      const body = (m && m.body != null) ? String(m.body) : '';
      const sender = m && m.sender != null ? String(m.sender) : null;
      const recipient = m && m.recipient != null ? String(m.recipient) : null;
      const mtype = m && m.mtype != null ? String(m.mtype) : null;
      const urgency = m && m.urgency != null ? String(m.urgency) : null;
      const isHeartbeat = m && m.isHeartbeat ? 1 : 0;
      const stmt = db.prepare(
        'INSERT ' + (hash !== null ? 'OR IGNORE ' : '')
        + 'INTO messages (workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, seq)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq),0)+1 FROM messages));'
      );
      const r = stmt.run(String(m.workspaceId), ts, hash, body, sender, recipient, mtype, urgency, isHeartbeat);
      if (r.changes <= 0) return { inserted: false, seq: null }; // dedupe hit (OR IGNORE)
      const got = db.prepare('SELECT seq FROM messages WHERE id = ?;').get(Number(r.lastInsertRowid));
      return { inserted: true, seq: got ? Number(got.seq) : null };
    },
    upsertRegistry(d) {
      db.prepare(
        'INSERT INTO registry (id, worktree_path, session_id, inbox_path, cursor_path, nudge_command, updated_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)'
        + ' ON CONFLICT(id) DO UPDATE SET worktree_path=excluded.worktree_path, session_id=excluded.session_id,'
        + ' inbox_path=excluded.inbox_path, cursor_path=excluded.cursor_path,'
        + ' nudge_command=excluded.nudge_command, updated_at=excluded.updated_at;'
      ).run(
        String(d.id), nOrNull(d.worktreePath), nOrNull(d.sessionId), nOrNull(d.inboxPath),
        nOrNull(d.cursorPath), serializeCmd(d.nudgeCommand), Date.now()
      );
    },
    removeRegistry(id) {
      db.prepare('DELETE FROM registry WHERE id = ?;').run(String(id));
    },
    setCursor(id, value) {
      const v = clampInt(value);
      db.prepare(
        'INSERT INTO cursors (workspace_id, value, updated_at) VALUES (?, ?, ?)'
        + ' ON CONFLICT(workspace_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;'
      ).run(String(id), v, Date.now());
    },
    setGate(g) {
      db.prepare(
        'INSERT INTO gates (workspace_id, gate_name, value, set_at, set_by) VALUES (?, ?, ?, ?, ?);'
      ).run(String(g.workspaceId), String(g.name), g.value ? 1 : 0,
        Number.isFinite(g && g.setAt) ? g.setAt : Date.now(),
        g && g.setBy != null ? String(g.setBy) : null);
    },
    // broadcast_cursors (D5) — mirrors cursors' get/set shape exactly, but tracks
    // a workspace's OWN join point into the shared broadcast partition.
    broadcastCursorValue(id) {
      const r = db.prepare('SELECT value FROM broadcast_cursors WHERE workspace_id = ?;').get(String(id));
      return r ? Number(r.value) : 0;
    },
    setBroadcastCursor(id, value) {
      const v = clampInt(value);
      db.prepare(
        'INSERT INTO broadcast_cursors (workspace_id, value, updated_at) VALUES (?, ?, ?)'
        + ' ON CONFLICT(workspace_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;'
      ).run(String(id), v, Date.now());
    },
    // advanceBroadcastCursor(id) -> the new cursor value (D23 read/ack). Sets `id`'s
    // broadcast cursor to the CURRENT head `seq` of the shared broadcast partition
    // (ALL broadcast rows, heartbeats included — "read up to head" marks everything
    // currently visible as seen). Consumed by the Phase-4 `mesh read` verb.
    advanceBroadcastCursor(id) {
      const r = db.prepare("SELECT MAX(seq) AS m FROM messages WHERE mtype = 'broadcast';").get();
      const head = (r && Number.isFinite(Number(r.m))) ? Number(r.m) : 0;
      db.prepare(
        'INSERT INTO broadcast_cursors (workspace_id, value, updated_at) VALUES (?, ?, ?)'
        + ' ON CONFLICT(workspace_id) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at;'
      ).run(String(id), head, Date.now());
      return head;
    },
    listRegistry() {
      return db.prepare('SELECT * FROM registry ORDER BY id ASC;').all().map(rowToDescriptor);
    },
    messageCount(id) {
      const r = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE workspace_id = ?;').get(String(id));
      return r ? Number(r.c) : 0;
    },
    // listMessages(id, {sinceCursor}) -> ordered message rows INCLUDING body. The
    // READ-BACK side of the store (the `body` column was written but never read
    // until this). Ordered by insertion (id ASC) so `seq` (1-based, PER-WORKSPACE
    // positional index — NOT the physical mesh `seq` column, see `storeSeq` below)
    // aligns with the consumed-count cursor. sinceCursor (a consumed-count) skips
    // the first N rows — the caller passes cursorValue(id) to get only the unread
    // tail. Pure read; never mutates. sqlite has UNIQUE(hash) so no dup-hash rows to
    // fold here; a null-hash row is a distinct message (matches messageCount's
    // COUNT(*)). Additive mesh fields (sender/recipient/mtype/urgency/isHeartbeat/
    // storeSeq) are null/false on a pre-mesh legacy row — existing consumers that
    // destructure only {seq,ts,hash,body} are unaffected.
    listMessages(id, opts) {
      const o = opts || {};
      const since = Number.isFinite(o.sinceCursor) && o.sinceCursor > 0 ? Math.floor(o.sinceCursor) : 0;
      const rows = db.prepare(
        'SELECT id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, seq'
        + ' FROM messages WHERE workspace_id = ? ORDER BY id ASC;'
      ).all(String(id));
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        if (i < since) continue;
        out.push({
          seq: i + 1,
          ts: Number(rows[i].ts),
          hash: rows[i].hash != null ? String(rows[i].hash) : null,
          body: rows[i].body != null ? String(rows[i].body) : '',
          sender: rows[i].sender != null ? String(rows[i].sender) : null,
          recipient: rows[i].recipient != null ? String(rows[i].recipient) : null,
          mtype: rows[i].mtype != null ? String(rows[i].mtype) : null,
          urgency: rows[i].urgency != null ? String(rows[i].urgency) : null,
          isHeartbeat: rows[i].is_heartbeat === 1 || rows[i].is_heartbeat === 1n,
          storeSeq: rows[i].seq != null ? Number(rows[i].seq) : null,
        });
      }
      return out;
    },
    cursorValue(id) {
      const r = db.prepare('SELECT value FROM cursors WHERE workspace_id = ?;').get(String(id));
      return r ? Number(r.value) : 0;
    },
    currentGates(id) {
      const rows = db.prepare('SELECT gate_name, value FROM gates WHERE workspace_id = ? ORDER BY id ASC;').all(String(id));
      const out = {};
      for (const row of rows) out[row.gate_name] = row.value === 1 || row.value === 1n;
      return out;
    },
    close() { try { db.close(); } catch (_) {} },
  };
}
function rowToDescriptor(r) {
  return {
    id: r.id,
    worktreePath: r.worktree_path || null,
    sessionId: r.session_id || null,
    inboxPath: r.inbox_path || null,
    cursorPath: r.cursor_path || null,
    nudgeCommand: deserializeCmd(r.nudge_command),
  };
}

// ============================================================================
// Journal backend (append-only NDJSON). Dependency-free; the guaranteed-green
// path on node 18/20. fs is injectable for isolation/testing.
// ============================================================================
function openJournal(home, workspaceId, fsi, lockOpts, opts) {
  const o = opts || {};
  const hash = o.hash != null ? String(o.hash) : hashFromWorkspaceId(workspaceId);
  const F = fsi || fs;
  const L = lockOpts || {};
  const dir = o.dir ? path.join(o.dir, 'journal') : journalDirForHash(home, hash);
  const files = {
    messages: path.join(dir, 'messages.ndjson'),
    registry: path.join(dir, 'registry.ndjson'),
    cursors: path.join(dir, 'cursors.ndjson'),
    gates: path.join(dir, 'gates.ndjson'),
    // broadcast_cursors (D5) — a SEPARATE file (NOT folded into cursors.ndjson),
    // mirroring the sqlite backend's separate table. Each workspace tracks
    // broadcasts-seen independently of its direct-inbox cursor.
    broadcastCursors: path.join(dir, 'broadcast_cursors.ndjson'),
  };
  function append(file, obj) {
    F.mkdirSync(dir, { recursive: true });
    F.appendFileSync(file, JSON.stringify(obj) + '\n');
  }
  // withMessagesLock(fn) — serialize the messages dedupe check+append across
  // processes. The journal has no UNIQUE(hash) constraint (unlike sqlite), so a
  // bare scan-then-append lets two processes both scan (miss the hash) and both
  // append the SAME hash -> duplicate rows. An O_EXCL lockfile makes check+append
  // one critical section. A stale lock (crashed holder) is stolen so the journal
  // can never permanently wedge.
  //
  // SOUNDNESS (v0.54.2): the critical section NEVER runs without the lock. If the
  // contention budget is exhausted the fn is NOT executed unlocked (that would let
  // two writers both check-then-append the same hash -> a duplicate row); instead a
  // distinct ELOCKUNAVAIL is thrown so the caller can retry later (idempotent by
  // hash). A genuine unexpected fs error opening the lock (e.g. EPERM) throws
  // ELOCKFS — fail CLOSED, never race. appendMessage() layers a bounded retry on
  // ELOCKUNAVAIL so transient contention self-heals without corrupting the trail.
  const messagesLock = path.join(dir, 'messages.lock');
  const MESSAGES_LOCK_STALE_MS = Number.isFinite(L.staleMs) ? L.staleMs : 10 * 1000;
  // Raised 500 -> 1000 + jittered backoff: slow FS (Windows NTFS + Defender) needs
  // more headroom before an append is considered genuinely un-acquirable. Tunable
  // for tests via openStore({ lock: { maxTries, appendRetries, staleMs } }).
  const MESSAGES_LOCK_MAX_TRIES = Number.isFinite(L.maxTries) ? L.maxTries : 1000;
  const MESSAGES_APPEND_MAX_RETRIES = Number.isFinite(L.appendRetries) ? L.appendRetries : 5;
  function lockSleep(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch (_) {}
  }
  function lockErr(code, msg) { const e = new Error(msg); e.code = code; return e; }
  // acquireOnce() -> 'held' | 'stole' | 'busy'; throws on a genuine fs error.
  // A lock is stolen ONLY when on-disk evidence shows the holder is gone: a
  // parseable-but-old ts, OR (for a torn/empty/unparseable file) an old MTIME. A
  // live holder is briefly a 0-byte file between openSync('wx') and writeSync — a
  // concurrent reader that catches it empty MUST NOT steal it (that lets two
  // processes both run the critical section -> a duplicate hash row). The empty
  // window is microseconds, so a fresh mtime = live holder -> back off, never steal.
  function acquireOnce() {
    try {
      const fd = F.openSync(messagesLock, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); } finally { F.closeSync(fd); }
      return 'held';
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e; // unexpected fs error -> caller fails closed
      let ts = null;
      try { ts = JSON.parse(F.readFileSync(messagesLock, 'utf8')).ts; } catch (_) {}
      if (!Number.isFinite(ts)) {
        // torn/empty/unparseable content — fall back to the file's mtime for
        // liveness; a live holder mid-write has a FRESH mtime.
        try { ts = F.statSync(messagesLock).mtimeMs; } catch (_) { ts = null; }
      }
      if (ts === null || (Date.now() - ts) > MESSAGES_LOCK_STALE_MS) {
        try { F.unlinkSync(messagesLock); } catch (_) {} // steal a genuinely stale lock
        return 'stole';
      }
      return 'busy'; // live holder
    }
  }
  function withMessagesLock(fn) {
    try { F.mkdirSync(dir, { recursive: true }); } catch (_) {}
    let held = false;
    for (let i = 0; i < MESSAGES_LOCK_MAX_TRIES && !held; i++) {
      let st;
      try { st = acquireOnce(); }
      catch (e) {
        // Genuine, unexpected fs error opening the lock (e.g. EPERM). Fail CLOSED —
        // NEVER run the critical section unlocked.
        throw lockErr('ELOCKFS', 'devswarm messages lock: fs error (' + (e && e.code || 'unknown') + ')');
      }
      if (st === 'held') { held = true; break; }
      if (st === 'busy') lockSleep(2 + Math.floor(Math.random() * 4)); // jittered backoff desyncs writers
      // 'stole' -> retry immediately (we just cleared a stale lock)
    }
    if (!held) {
      // Contention budget exhausted. Do NOT append unlocked (duplicates the dedupe
      // hash). Signal a retryable failure; the caller re-attempts (idempotent).
      throw lockErr('ELOCKUNAVAIL', 'devswarm messages lock unavailable after ' + MESSAGES_LOCK_MAX_TRIES + ' tries');
    }
    try { return fn(); }
    finally { try { F.unlinkSync(messagesLock); } catch (_) {} }
  }
  // withRetriedMessagesLock(criticalFn) — bounded retry on ELOCKUNAVAIL (contention
  // exhaustion), shared by appendMessage AND appendMeshRow. The critical section
  // NEVER runs unlocked, so a retry can only ADD a row once — the dedupe hash makes
  // every re-attempt idempotent (a prior success is seen and skipped). A genuine fs
  // error (ELOCKFS) is NOT retried: fail closed, never race.
  function withRetriedMessagesLock(criticalFn) {
    let lastErr = null;
    for (let attempt = 0; attempt < MESSAGES_APPEND_MAX_RETRIES; attempt++) {
      try { return withMessagesLock(criticalFn); }
      catch (e) {
        lastErr = e;
        if (e && e.code === 'ELOCKUNAVAIL') { lockSleep(4 + Math.floor(Math.random() * 8)); continue; }
        throw e; // ELOCKFS / unexpected -> fail closed
      }
    }
    throw lastErr;
  }
  function readAll(file) {
    let raw;
    try { raw = String(F.readFileSync(file, 'utf8')); } catch (_) { return []; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* skip a torn line, keep the trail */ }
    }
    return out;
  }

  return {
    backend: 'journal',
    workspaceId: workspaceId != null ? String(workspaceId) : null,
    hash,
    // listWorkspaceIds() -> distinct workspace ids present in any journal file.
    // Used by the global->per-project migration. Pure read (fail-open []).
    listWorkspaceIds() {
      const ids = new Set();
      for (const row of readAll(files.messages)) { if (row && row.workspaceId != null) ids.add(String(row.workspaceId)); }
      for (const row of readAll(files.registry)) { if (row && row.id != null) ids.add(String(row.id)); }
      for (const row of readAll(files.cursors)) { if (row && row.workspaceId != null) ids.add(String(row.workspaceId)); }
      for (const row of readAll(files.gates)) { if (row && row.workspaceId != null) ids.add(String(row.workspaceId)); }
      return Array.from(ids);
    },
    appendMessage(m) {
      const hash = (m && m.hash != null) ? String(m.hash) : null;
      // Serialize check+append so concurrent writers can't both miss the hash and
      // both append it (the journal has no UNIQUE(hash) constraint). A null hash is
      // always distinct, so it needs no dedupe scan — but still append under the
      // lock so the appendFileSync itself can't interleave a torn line.
      const critical = () => {
        if (hash !== null) {
          // idempotent by hash — scan existing (append-only, so a prior identical
          // hash means already-recorded); preserves the trail without a duplicate.
          for (const row of readAll(files.messages)) {
            if (row.hash === hash) return { inserted: false };
          }
        }
        append(files.messages, {
          workspaceId: String(m.workspaceId),
          ts: Number.isFinite(m && m.ts) ? m.ts : Date.now(),
          hash,
          body: (m && m.body != null) ? String(m.body) : '',
        });
        return { inserted: true };
      };
      // If the lock stays unavailable past the retry budget the error propagates so
      // the ingest path re-attempts on its next monitor poll (replay is idempotent
      // by hash).
      return withRetriedMessagesLock(critical);
    },
    // appendMeshRow(m) -> {inserted, seq}. The mesh-aware insert (D3/D6/D7/D22) —
    // called by the top-level appendMeshMessage(), never directly by a consumer.
    // Reuses the SAME O_EXCL messages.lock as appendMessage (D6: "journal: a
    // per-store counter written under the existing O_EXCL messages.lock, already
    // serializes journal writers") — the per-store seq counter is computed by
    // scanning the CURRENT max seq INSIDE the locked critical section (never a
    // cross-process JS read-then-bind race, which D6 explicitly forbids: this scan
    // is serialized by the SAME lock every other writer to this file must hold).
    appendMeshRow(m) {
      const hash = (m && m.hash != null) ? String(m.hash) : null;
      const critical = () => {
        const all = readAll(files.messages);
        if (hash !== null) {
          for (const row of all) {
            if (row.hash === hash) return { inserted: false, seq: null };
          }
        }
        let maxSeq = 0;
        for (const row of all) {
          if (Number.isFinite(row.seq) && row.seq > maxSeq) maxSeq = row.seq;
        }
        const seq = maxSeq + 1;
        append(files.messages, {
          workspaceId: String(m.workspaceId),
          ts: Number.isFinite(m && m.ts) ? m.ts : Date.now(),
          hash,
          body: (m && m.body != null) ? String(m.body) : '',
          sender: m && m.sender != null ? String(m.sender) : null,
          recipient: m && m.recipient != null ? String(m.recipient) : null,
          mtype: m && m.mtype != null ? String(m.mtype) : null,
          urgency: m && m.urgency != null ? String(m.urgency) : null,
          isHeartbeat: !!(m && m.isHeartbeat),
          seq,
        });
        return { inserted: true, seq };
      };
      return withRetriedMessagesLock(critical);
    },
    upsertRegistry(d) {
      append(files.registry, {
        id: String(d.id),
        worktreePath: nOrNull(d.worktreePath),
        sessionId: nOrNull(d.sessionId),
        inboxPath: nOrNull(d.inboxPath),
        cursorPath: nOrNull(d.cursorPath),
        nudgeCommand: (d.nudgeCommand === undefined ? null : d.nudgeCommand),
        _op: 'upsert',
        updatedAt: Date.now(),
      });
    },
    removeRegistry(id) {
      append(files.registry, { id: String(id), _op: 'remove', updatedAt: Date.now() });
    },
    setCursor(id, value) {
      append(files.cursors, { workspaceId: String(id), value: clampInt(value), updatedAt: Date.now() });
    },
    setGate(g) {
      append(files.gates, {
        workspaceId: String(g.workspaceId),
        name: String(g.name),
        value: !!(g && g.value),
        setAt: Number.isFinite(g && g.setAt) ? g.setAt : Date.now(),
        setBy: g && g.setBy != null ? String(g.setBy) : null,
      });
    },
    // broadcast_cursors (D5) — mirrors cursors' get/set shape exactly, but tracks
    // a workspace's OWN join point into the shared broadcast partition.
    broadcastCursorValue(id) {
      const wid = String(id);
      let v = 0;
      for (const row of readAll(files.broadcastCursors)) {
        if (String(row.workspaceId) === wid && Number.isFinite(row.value)) v = row.value;
      }
      return v;
    },
    setBroadcastCursor(id, value) {
      append(files.broadcastCursors, { workspaceId: String(id), value: clampInt(value), updatedAt: Date.now() });
    },
    // advanceBroadcastCursor(id) -> the new cursor value (D23 read/ack). Sets `id`'s
    // broadcast cursor to the CURRENT head `seq` of the shared broadcast partition
    // (ALL broadcast rows, heartbeats included — "read up to head" marks everything
    // currently visible as seen). Consumed by the Phase-4 `mesh read` verb.
    advanceBroadcastCursor(id) {
      let head = 0;
      for (const row of readAll(files.messages)) {
        if (row.mtype === 'broadcast' && Number.isFinite(row.seq) && row.seq > head) head = row.seq;
      }
      append(files.broadcastCursors, { workspaceId: String(id), value: head, updatedAt: Date.now() });
      return head;
    },
    listRegistry() {
      // Reduce the append-only log to the current active set: latest row per id
      // wins; a `remove` op tombstones it.
      const latest = new Map();
      for (const row of readAll(files.registry)) {
        if (!row || row.id == null) continue;
        latest.set(String(row.id), row);
      }
      const out = [];
      for (const row of latest.values()) {
        if (row._op === 'remove') continue;
        out.push({
          id: row.id,
          worktreePath: row.worktreePath || null,
          sessionId: row.sessionId || null,
          inboxPath: row.inboxPath || null,
          cursorPath: row.cursorPath || null,
          nudgeCommand: (row.nudgeCommand === undefined ? null : row.nudgeCommand),
        });
      }
      out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      return out;
    },
    messageCount(id) {
      const wid = String(id);
      const seen = new Set();
      let n = 0;
      for (const row of readAll(files.messages)) {
        if (String(row.workspaceId) !== wid) continue;
        if (row.hash != null) {
          if (seen.has(row.hash)) continue; // dedupe identical hashes on read
          seen.add(row.hash);
        }
        n++;
      }
      return n;
    },
    // listMessages(id, {sinceCursor}) -> ordered message rows INCLUDING body. Reads
    // messages.ndjson in file (insertion) order, filtered by workspaceId, deduped by
    // hash on read with the SAME rule messageCount uses (so the row indices agree
    // with the consumed-count cursor). sinceCursor skips the first N kept rows. Pure
    // read; never mutates the journal. `seq` here is the PER-WORKSPACE positional
    // index (1-based, unchanged) — NOT the physical mesh `seq` field written by
    // appendMeshRow, which is surfaced separately as `storeSeq` (parity with the
    // sqlite backend; a legacy row without it reads back as storeSeq:null).
    listMessages(id, opts) {
      const o = opts || {};
      const since = Number.isFinite(o.sinceCursor) && o.sinceCursor > 0 ? Math.floor(o.sinceCursor) : 0;
      const wid = String(id);
      const seen = new Set();
      const kept = [];
      for (const row of readAll(files.messages)) {
        if (String(row.workspaceId) !== wid) continue;
        if (row.hash != null) {
          if (seen.has(row.hash)) continue; // dedupe identical hashes on read (parity with messageCount)
          seen.add(row.hash);
        }
        kept.push(row);
      }
      const out = [];
      for (let i = 0; i < kept.length; i++) {
        if (i < since) continue;
        out.push({
          seq: i + 1,
          ts: Number.isFinite(kept[i].ts) ? kept[i].ts : null,
          hash: kept[i].hash != null ? String(kept[i].hash) : null,
          body: kept[i].body != null ? String(kept[i].body) : '',
          sender: kept[i].sender != null ? String(kept[i].sender) : null,
          recipient: kept[i].recipient != null ? String(kept[i].recipient) : null,
          mtype: kept[i].mtype != null ? String(kept[i].mtype) : null,
          urgency: kept[i].urgency != null ? String(kept[i].urgency) : null,
          isHeartbeat: !!kept[i].isHeartbeat,
          storeSeq: Number.isFinite(kept[i].seq) ? Number(kept[i].seq) : null,
        });
      }
      return out;
    },
    cursorValue(id) {
      const wid = String(id);
      let v = 0;
      for (const row of readAll(files.cursors)) {
        if (String(row.workspaceId) === wid && Number.isFinite(row.value)) v = row.value;
      }
      return v;
    },
    currentGates(id) {
      const wid = String(id);
      const out = {};
      for (const row of readAll(files.gates)) {
        if (String(row.workspaceId) === wid && row.name != null) out[row.name] = !!row.value;
      }
      return out;
    },
    close() { /* no handle to close */ },
  };
}

// ----- shared helpers -----
function nOrNull(v) { return v == null ? null : String(v); }
function clampInt(v) {
  let n = Number(v);
  if (!Number.isFinite(n) || n < 0) n = 0;
  return Math.floor(n);
}
// nudgeCommand may be an argv array (per recovery.js) — serialize/restore as JSON
// in the sqlite TEXT column so it round-trips.
function serializeCmd(cmd) {
  if (cmd == null) return null;
  try { return JSON.stringify(cmd); } catch (_) { return null; }
}
function deserializeCmd(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

// ============================================================================
// Top-level store API
// ============================================================================
// openStore(opts) -> backend handle for ONE PROJECT's physical store. opts:
//   { home, workspaceId, backend, env, fsi, lock, dir, hash }.
//   workspaceId : selects the per-project store dir (store/<hashFromWorkspaceId>/).
//                 Absent -> the DEFAULT_HASH bucket (legacy multi-workspace handle).
//   dir/hash    : (advanced) open a store at an EXPLICIT dir (the legacy global
//                 store/ for migration read-back) or force a specific hash subdir.
//   backend     : force 'sqlite' | 'journal'; else feature-detect. `fsi` only
//                 affects the journal backend (sqlite opens a real file). `lock`
//                 (journal only) tunes the messages-lock budget.
function openStore(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const backend = selectBackend({ backend: o.backend, env: o.env });
  const meta = { dir: o.dir, hash: o.hash, busyTimeoutMs: o.busyTimeoutMs };
  return backend === 'sqlite'
    ? openSqlite(home, o.workspaceId, meta)
    : openJournal(home, o.workspaceId, o.fsi, o.lock, meta);
}

// maxUrgencyOf(rows) -> the highest-ranked `urgency` value present across `rows`
// (each {urgency}), or null when none carry a recognized urgency (a legacy/
// native-drained row has urgency=null and does not contribute — it never LOWERS
// an already-found max, it simply never raises one). Computed purely from the
// `urgency` COLUMN (D22-adjacent: "computed WITHOUT reading bodies").
function maxUrgencyOf(rows) {
  let best = null;
  let bestRank = -1;
  for (const r of rows) {
    const u = r && r.urgency != null ? String(r.urgency) : null;
    if (u == null) continue;
    const rank = URGENCY_RANK[u];
    if (rank == null) continue; // unrecognized value -> ignored, never thrown
    if (rank > bestRank) { bestRank = rank; best = u; }
  }
  return best;
}

// deriveSummary(store, opts) -> summary object (also written to this project's
// summaries/<hash>.json). opts: { home, workspaceId, requiredGates, env, now, fsi,
// recentCap }. Iterates THIS store's ACTIVE registry set, projects unread
// (messages - cursor), current gates, and archive_ready (all required gates
// satisfied). The target summary file is chosen by opts.workspaceId, else the
// store handle's own workspaceId/hash (so a per-project store writes its own
// per-project summary). Write is ATOMIC (tmp + rename) so a hook read never
// observes a partial file.
//
// MESH ADDITIVE fields (v0.57, D3-D5/D22/D23 — old readers ignore unknown keys):
// per-workspace `directUnread` (alias of the existing `unread` — same value, the
// wire-schema name), `broadcastUnread` (NON-heartbeat broadcast rows past this
// workspace's OWN broadcast_cursors join point — heartbeats EXCLUDED per D22, else
// it grows monotonically forever since every peer heartbeats every turn),
// `urgencyMax` (highest urgency among this workspace's PENDING direct rows, from
// the urgency column only), `working_on` (this workspace's latest heartbeat
// summary — matched by `sender === d.id`; a caller supplies its own registered id
// as `from` when heartbeating). Top-level `recent[]` = the last `recentCap`
// (O-D8 UNRESOLVED broadcast-retention cap; default 50, overridable) broadcast
// rows INCLUDING heartbeats, as `{from, summary, ts, urgency}` (roster state).
function deriveSummary(store, opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const requiredGates = Array.isArray(o.requiredGates) ? o.requiredGates : requiredGatesFrom(o.env);
  const recentCap = Number.isFinite(o.recentCap) && o.recentCap > 0 ? Math.floor(o.recentCap) : DEFAULT_RECENT_CAP;
  // Which per-project summary file: explicit opts.workspaceId wins, else the
  // handle's workspaceId, else its hash (a handle always carries a hash).
  const hash = (o.workspaceId != null)
    ? hashFromWorkspaceId(o.workspaceId)
    : (store && store.hash != null ? String(store.hash)
      : hashFromWorkspaceId(store && store.workspaceId));

  // The shared broadcast partition — read ONCE, reused for every workspace's
  // broadcastUnread/working_on AND the top-level recent[]. Ordered by insertion
  // (== storeSeq order, since a mesh row's physical seq is assigned at insert time
  // under the same serialized write path).
  const broadcastAll = typeof store.listMessages === 'function' ? store.listMessages(BROADCAST_PARTITION_ID) : [];
  const broadcastNonHeartbeat = broadcastAll.filter((r) => !r.isHeartbeat);

  const workspaces = {};
  for (const d of store.listRegistry()) {
    if (!isSafeId(d.id)) continue; // never project an unsafe id
    if (d.id === BROADCAST_PARTITION_ID) continue; // defense-in-depth: the shared broadcast partition is NEVER a real workspace (isSafeId already excludes '*', kept explicit)
    const total = store.messageCount(d.id);
    const cursor = store.cursorValue(d.id);
    const unread = Math.max(0, total - cursor);
    const gates = store.currentGates(d.id);
    const archive_ready = requiredGates.length > 0 && requiredGates.every((g) => gates[g] === true);

    const unreadRows = unread > 0 ? store.listMessages(d.id, { sinceCursor: cursor }) : [];
    const urgencyMax = maxUrgencyOf(unreadRows);

    const bcCursor = typeof store.broadcastCursorValue === 'function' ? store.broadcastCursorValue(d.id) : 0;
    const broadcastUnread = broadcastNonHeartbeat.filter(
      (r) => Number.isFinite(r.storeSeq) && r.storeSeq > bcCursor
    ).length;

    let working_on = null;
    for (const r of broadcastAll) {
      if (r.isHeartbeat && r.sender != null && r.sender === d.id) working_on = r.body;
    }

    workspaces[d.id] = {
      id: d.id,
      worktreePath: d.worktreePath,
      sessionId: d.sessionId,
      inboxPath: d.inboxPath,
      cursorPath: d.cursorPath,
      nudgeCommand: d.nudgeCommand,
      total, cursor, unread,
      directUnread: unread,
      broadcastUnread,
      urgencyMax,
      working_on,
      gates,
      archive_ready,
    };
  }

  const recent = broadcastAll.slice(-recentCap).map((r) => ({
    from: r.sender != null ? r.sender : null,
    summary: r.body != null ? r.body : '',
    ts: r.ts,
    urgency: r.urgency != null ? r.urgency : null,
  }));

  const summary = { generatedAt: now, requiredGates: requiredGates.slice(), workspaces, recent };
  writeSummaryAtomicForHash(home, hash, summary, F);
  return summary;
}

// writeSummaryAtomic — tmp + rename (mirrors liveness.js writeVerdict). The tmp
// path is UNIQUE PER CALL (pid + a monotonic counter), not a single shared
// `summary.json.tmp`: concurrent derivers (CLI + ingest daemon) would otherwise
// write the same tmp and race each other's rename (ENOENT / a half-written
// publish). A unique tmp lets each writer stage independently; the rename onto the
// final summary.json stays atomic (last writer wins a complete file).
let summaryTmpCounter = 0;
function writeSummaryAtomicForHash(home, hash, summary, fsi) {
  const F = fsi || fs;
  const p = summaryPathForHash(home, hash);
  F.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.' + (summaryTmpCounter++) + '.tmp';
  try {
    F.writeFileSync(tmp, JSON.stringify(summary));
    F.renameSync(tmp, p);
  } catch (e) {
    try { F.unlinkSync(tmp); } catch (_) {} // never leak the staged tmp on failure
    throw e;
  }
  return p;
}
// writeSummaryAtomic(home, workspaceId, summary, fsi) — workspaceId-keyed wrapper.
function writeSummaryAtomic(home, workspaceId, summary, fsi) {
  return writeSummaryAtomicForHash(home, hashFromWorkspaceId(workspaceId), summary, fsi);
}

// readSummary(home, workspaceId, fsi) -> object | null. Reads THIS project's
// summaries/<hash>.json. TOLERANT: a missing, zero-byte, or partially-written
// summary reads as null ("no data yet"), never a throw — hook readers fail open
// on null. workspaceId absent -> the DEFAULT_HASH bucket.
function readSummary(home, workspaceId, fsi) {
  const F = fsi || fs;
  try {
    const raw = String(F.readFileSync(summaryPath(home, workspaceId), 'utf8'));
    if (raw.trim() === '') return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}
// readSummaryForHash(home, hash, fsi) — hash-keyed variant (doctor enumerates by hash).
function readSummaryForHash(home, hash, fsi) {
  const F = fsi || fs;
  try {
    const raw = String(F.readFileSync(summaryPathForHash(home, hash), 'utf8'));
    if (raw.trim() === '') return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULT_REQUIRED_GATES, DEFAULT_HASH,
  hashFromWorkspaceId,
  storeRootDir, summariesRootDir, listStoreHashes,
  storeDir, sqlitePath, journalDir, summaryPath,
  storeDirForHash, sqlitePathForHash, journalDirForHash, summaryPathForHash,
  requiredGatesFrom, selectBackend, sqliteAvailable,
  openStore, openSqlite, openJournal,
  deriveSummary, writeSummaryAtomic, readSummary, readSummaryForHash,
  // mesh (v0.57, D3-D7/D22/D23):
  BROADCAST_PARTITION_ID, meshMessageHash, appendMeshMessage,
};
