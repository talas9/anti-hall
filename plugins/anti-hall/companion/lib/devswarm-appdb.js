'use strict';
// anti-hall :: devswarm-appdb — a SMALL, INJECTABLE accessor for the DevSwarm
// app's own local SQLite DB, read-only. Owner-verified live: the `builders`
// table's `builderType` column ('primary' | 'standard', default 'standard',
// hivecontrol migration 0028 — see docs/KB-devswarm-hivecontrol.md §3) marks
// the one workspace-per-repo the app created first / whose worktreePath ===
// the repo's own root. This is the PROVEN signal for distinguishing the
// Primary's own app-registered row (an "app builder" self-registration under
// a builder id, e.g. `76cf862f…`) from a genuine CHILD workspace that merely
// happens to share a worktree in a test fixture.
//
// THIS IS A PLACEHOLDER (0.107.0 base clone has no app-db module yet): the
// exact packaged DB path is UNCONFIRMED (see the KB doc's own caveat) — the
// path guessed below is best-effort Electron `userData` convention, clearly
// isolated behind one function so the integrator can swap it for the real
// 0.107.1+ devswarm-app-db reader + capabilities gate (`appdb.builders.
// builderType`) without touching any call site.
//
// CONTRACT: fail-open on EVERY axis (missing node:sqlite, missing/unreadable
// DB file, missing table/column, missing row, any query error) -> null,
// meaning "unavailable" — callers MUST treat null as "keep current
// behavior", never as a negative ('standard') answer. Never opens for write;
// never creates the DB file if absent.

const fs = require('fs');
const os = require('os');
const path = require('path');

// guessAppDbPath() -> best-effort per-OS path to the DevSwarm app's own
// SQLite DB. UNCONFIRMED (see file header) — overridable via opts.dbPath at
// every call site specifically so this guess is never load-bearing on its
// own; a real integration replaces this whole function.
function guessAppDbPath(home) {
  const h = home || os.homedir();
  if (process.platform === 'darwin') {
    return path.join(h, 'Library', 'Application Support', 'DevSwarm', 'devswarm.db');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(h, 'AppData', 'Roaming');
    return path.join(appData, 'DevSwarm', 'devswarm.db');
  }
  return path.join(h, '.config', 'DevSwarm', 'devswarm.db');
}

// builderTypeForId(id, opts) -> 'primary' | 'standard' | null.
//   opts.dbPath   - override the DB path (tests; else guessAppDbPath()).
//   opts.home     - passed through to guessAppDbPath() when dbPath is absent.
// null means UNAVAILABLE (no sqlite, no DB file, no row, any error) — the
// caller's own fail-open contract, never "standard".
function builderTypeForId(id, opts) {
  const o = opts || {};
  if (typeof id !== 'string' || !id) return null;
  const dbPath = o.dbPath || guessAppDbPath(o.home);
  let db = null;
  try {
    if (!fs.existsSync(dbPath)) return null;
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare('SELECT builderType FROM builders WHERE id = ?');
    const row = stmt.get(id);
    if (!row || typeof row.builderType !== 'string') return null;
    return row.builderType === 'primary' ? 'primary' : 'standard';
  } catch (_) {
    return null; // fail-open: missing module/table/column, corrupt db, etc.
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

module.exports = { guessAppDbPath, builderTypeForId };
