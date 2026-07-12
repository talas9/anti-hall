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

// listStoreHashes(home, fsi) -> string[] of per-project store subdir names present
// under store/ (each an 8-hex hash). Fail-open [] on any read error. Used by doctor
// to ENUMERATE per-project stores instead of one global file.
function listStoreHashes(home, fsi) {
  const F = fsi || fs;
  let names = [];
  try { names = F.readdirSync(storeRootDir(home)); } catch (_) { return []; }
  return names.filter((n) => /^[0-9a-fA-F]{8}$/.test(n));
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
// SQLite backend (WAL). Touches a real db file (DatabaseSync has no fs injection);
// tests point it at an isolated temp HOME.
// ============================================================================
function openSqlite(home, workspaceId, opts) {
  const o = opts || {};
  const hash = o.hash != null ? String(o.hash) : hashFromWorkspaceId(workspaceId);
  const dir = o.dir || storeDirForHash(home, hash);
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'devswarm.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(
    'CREATE TABLE IF NOT EXISTS messages ('
    + ' id INTEGER PRIMARY KEY AUTOINCREMENT,'
    + ' workspace_id TEXT NOT NULL,'
    + ' ts INTEGER NOT NULL,'
    + ' hash TEXT,'
    + ' body TEXT,'
    + ' UNIQUE(hash)'
    + ');'
  );
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
    listRegistry() {
      return db.prepare('SELECT * FROM registry ORDER BY id ASC;').all().map(rowToDescriptor);
    },
    messageCount(id) {
      const r = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE workspace_id = ?;').get(String(id));
      return r ? Number(r.c) : 0;
    },
    // listMessages(id, {sinceCursor}) -> ordered message rows INCLUDING body. The
    // READ-BACK side of the store (the `body` column was written but never read
    // until this). Ordered by insertion (id ASC) so `seq` (1-based) aligns with the
    // consumed-count cursor. sinceCursor (a consumed-count) skips the first N rows —
    // the caller passes cursorValue(id) to get only the unread tail. Pure read;
    // never mutates. sqlite has UNIQUE(hash) so no dup-hash rows to fold here; a
    // null-hash row is a distinct message (matches messageCount's COUNT(*)).
    listMessages(id, opts) {
      const o = opts || {};
      const since = Number.isFinite(o.sinceCursor) && o.sinceCursor > 0 ? Math.floor(o.sinceCursor) : 0;
      const rows = db.prepare('SELECT id, ts, hash, body FROM messages WHERE workspace_id = ? ORDER BY id ASC;').all(String(id));
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        if (i < since) continue;
        out.push({
          seq: i + 1,
          ts: Number(rows[i].ts),
          hash: rows[i].hash != null ? String(rows[i].hash) : null,
          body: rows[i].body != null ? String(rows[i].body) : '',
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
      // Bounded retry on ELOCKUNAVAIL (contention exhaustion). The critical section
      // NEVER runs unlocked, so a retry can only ADD the row once — the dedupe hash
      // makes every re-attempt idempotent (a prior success is seen and skipped). A
      // genuine fs error (ELOCKFS) is NOT retried: fail closed, never race. If the
      // lock stays unavailable past the budget the error propagates so the ingest
      // path re-attempts on its next monitor poll (replay is idempotent by hash).
      let lastErr = null;
      for (let attempt = 0; attempt < MESSAGES_APPEND_MAX_RETRIES; attempt++) {
        try { return withMessagesLock(critical); }
        catch (e) {
          lastErr = e;
          if (e && e.code === 'ELOCKUNAVAIL') { lockSleep(4 + Math.floor(Math.random() * 8)); continue; }
          throw e; // ELOCKFS / unexpected -> fail closed
        }
      }
      throw lastErr;
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
    // read; never mutates the journal.
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
  const meta = { dir: o.dir, hash: o.hash };
  return backend === 'sqlite'
    ? openSqlite(home, o.workspaceId, meta)
    : openJournal(home, o.workspaceId, o.fsi, o.lock, meta);
}

// deriveSummary(store, opts) -> summary object (also written to this project's
// summaries/<hash>.json). opts: { home, workspaceId, requiredGates, env, now, fsi }.
// Iterates THIS store's ACTIVE registry set, projects unread (messages - cursor),
// current gates, and archive_ready (all required gates satisfied). The target
// summary file is chosen by opts.workspaceId, else the store handle's own
// workspaceId/hash (so a per-project store writes its own per-project summary).
// Write is ATOMIC (tmp + rename) so a hook read never observes a partial file.
function deriveSummary(store, opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const requiredGates = Array.isArray(o.requiredGates) ? o.requiredGates : requiredGatesFrom(o.env);
  // Which per-project summary file: explicit opts.workspaceId wins, else the
  // handle's workspaceId, else its hash (a handle always carries a hash).
  const hash = (o.workspaceId != null)
    ? hashFromWorkspaceId(o.workspaceId)
    : (store && store.hash != null ? String(store.hash)
      : hashFromWorkspaceId(store && store.workspaceId));

  const workspaces = {};
  for (const d of store.listRegistry()) {
    if (!isSafeId(d.id)) continue; // never project an unsafe id
    const total = store.messageCount(d.id);
    const cursor = store.cursorValue(d.id);
    const unread = Math.max(0, total - cursor);
    const gates = store.currentGates(d.id);
    const archive_ready = requiredGates.length > 0 && requiredGates.every((g) => gates[g] === true);
    workspaces[d.id] = {
      id: d.id,
      worktreePath: d.worktreePath,
      sessionId: d.sessionId,
      inboxPath: d.inboxPath,
      cursorPath: d.cursorPath,
      nudgeCommand: d.nudgeCommand,
      total, cursor, unread,
      gates,
      archive_ready,
    };
  }

  const summary = { generatedAt: now, requiredGates: requiredGates.slice(), workspaces };
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
};
