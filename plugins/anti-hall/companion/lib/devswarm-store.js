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
const { devswarmRoot, isSafeId } = require('./liveness.js');

const DEFAULT_REQUIRED_GATES = ['done', 'merged', 'tests_passed'];

// ----- paths -----
function storeDir(home) {
  return path.join(devswarmRoot(home), 'store');
}
function sqlitePath(home) {
  return path.join(storeDir(home), 'devswarm.db');
}
function journalDir(home) {
  return path.join(storeDir(home), 'journal');
}
function summaryPath(home) {
  return path.join(devswarmRoot(home), 'summary.json');
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
function openSqlite(home) {
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(storeDir(home), { recursive: true });
  const db = new DatabaseSync(sqlitePath(home));
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
function openJournal(home, fsi) {
  const F = fsi || fs;
  const dir = journalDir(home);
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
  // one critical section. Fail-soft: an unexpected fs error just proceeds
  // best-effort (no worse than before); a stale lock (crashed holder) is stolen so
  // the journal can never permanently wedge.
  const messagesLock = path.join(dir, 'messages.lock');
  const MESSAGES_LOCK_STALE_MS = 10 * 1000;
  const MESSAGES_LOCK_MAX_TRIES = 500;
  function lockSleep(ms) {
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch (_) {}
  }
  function withMessagesLock(fn) {
    try { F.mkdirSync(dir, { recursive: true }); } catch (_) {}
    let held = false;
    for (let i = 0; i < MESSAGES_LOCK_MAX_TRIES && !held; i++) {
      try {
        const fd = F.openSync(messagesLock, 'wx');
        try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() })); } finally { F.closeSync(fd); }
        held = true;
      } catch (e) {
        if (!e || e.code !== 'EEXIST') break; // unexpected fs error -> proceed unlocked (best-effort)
        let ts = null;
        try { ts = JSON.parse(F.readFileSync(messagesLock, 'utf8')).ts; } catch (_) {}
        if (ts === null || (Date.now() - ts) > MESSAGES_LOCK_STALE_MS) {
          try { F.unlinkSync(messagesLock); } catch (_) {} // steal a stale/torn lock
          continue;
        }
        lockSleep(2); // live holder -> back off and retry
      }
    }
    try { return fn(); }
    finally { if (held) { try { F.unlinkSync(messagesLock); } catch (_) {} } }
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
    appendMessage(m) {
      const hash = (m && m.hash != null) ? String(m.hash) : null;
      // Serialize check+append so concurrent writers can't both miss the hash and
      // both append it (the journal has no UNIQUE(hash) constraint). A null hash is
      // always distinct, so it needs no dedupe scan — but still append under the
      // lock so the appendFileSync itself can't interleave a torn line.
      return withMessagesLock(() => {
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
      });
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
// openStore(opts) -> backend handle. opts: { home, backend, env, fsi }.
//   backend: force 'sqlite' | 'journal'; else feature-detect. `fsi` only affects
//   the journal backend (sqlite opens a real file).
function openStore(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const backend = selectBackend({ backend: o.backend, env: o.env });
  return backend === 'sqlite' ? openSqlite(home) : openJournal(home, o.fsi);
}

// deriveSummary(store, opts) -> summary object (also written to summary.json).
//   opts: { home, requiredGates, env, now, fsi }. Iterates the ACTIVE registry
//   set, projects unread (messages - cursor), current gates, and archive_ready
//   (all required gates satisfied). Write is ATOMIC (tmp + rename) so a hook read
//   never observes a partially-written file.
function deriveSummary(store, opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const requiredGates = Array.isArray(o.requiredGates) ? o.requiredGates : requiredGatesFrom(o.env);

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
  writeSummaryAtomic(home, summary, F);
  return summary;
}

// writeSummaryAtomic — tmp + rename (mirrors liveness.js writeVerdict). The tmp
// path is UNIQUE PER CALL (pid + a monotonic counter), not a single shared
// `summary.json.tmp`: concurrent derivers (CLI + ingest daemon) would otherwise
// write the same tmp and race each other's rename (ENOENT / a half-written
// publish). A unique tmp lets each writer stage independently; the rename onto the
// final summary.json stays atomic (last writer wins a complete file).
let summaryTmpCounter = 0;
function writeSummaryAtomic(home, summary, fsi) {
  const F = fsi || fs;
  const p = summaryPath(home);
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

// readSummary(home, fsi) -> object | null. TOLERANT: a missing, zero-byte, or
// partially-written summary.json reads as null ("no data yet"), never a throw —
// hook readers fail open on null.
function readSummary(home, fsi) {
  const F = fsi || fs;
  try {
    const raw = String(F.readFileSync(summaryPath(home), 'utf8'));
    if (raw.trim() === '') return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULT_REQUIRED_GATES,
  storeDir, sqlitePath, journalDir, summaryPath,
  requiredGatesFrom, selectBackend, sqliteAvailable,
  openStore, openSqlite, openJournal,
  deriveSummary, writeSummaryAtomic, readSummary,
};
