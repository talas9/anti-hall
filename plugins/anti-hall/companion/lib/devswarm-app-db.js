'use strict';
// anti-hall :: devswarm-app-db — APP-SIDE archive state read straight from the
// DevSwarm desktop app's own database (v0.107.1).
//
// WHY: archive detection used to be "by absence" from `hivecontrol workspace
// list all` (devswarm-archived-cache.js). Measured against a current app build,
// that command returns EVERY builder, archived ones included, with no state
// field — so an archived workspace is never absent and never detected, and its
// row kept nagging the Primary every turn. The app's database is the ground
// truth: table `builders` carries `id`, `worktreePath`, `isActive` and
// `isHidden`; an archived builder is `isActive = 0 AND isHidden = 1`.
//
// CONTRACT
//   - READ-ONLY: opened with node:sqlite `readOnly: true`, one SELECT, closed.
//     Never writes, never spawns.
//   - FAIL-OPEN: no node:sqlite, no file, no table, a missing column, or any
//     read error -> null ("no opinion"), and callers fall back to the previous
//     absence rule. Nothing here throws.
//   - PATH: ANTIHALL_DEVSWARM_APP_DB overrides (a file path, or `off` to
//     disable). Otherwise the app's per-OS data dir under the CALLER's home:
//       darwin  <home>/Library/Application Support/DevSwarm/devswarm.db
//       linux   $XDG_CONFIG_HOME|<home>/.config /DevSwarm/devswarm.db
//     No home -> null (never falls through to the real user's home).
//   - CACHE: one read per process per APP_DB_CACHE_MS (default 10 s) — the
//     per-turn hooks classify many rows against one snapshot.

const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_MS = 10 * 1000;
let memo = null; // { file, at, map }

function appDbPath(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const override = env && typeof env.ANTIHALL_DEVSWARM_APP_DB === 'string' ? env.ANTIHALL_DEVSWARM_APP_DB.trim() : '';
  if (override) return override.toLowerCase() === 'off' ? null : override;
  if (!o.home) return null;
  const platform = o.platform || process.platform;
  if (platform === 'darwin') return path.join(String(o.home), 'Library', 'Application Support', 'DevSwarm', 'devswarm.db');
  if (platform === 'linux') {
    const base = env && env.XDG_CONFIG_HOME ? String(env.XDG_CONFIG_HOME) : path.join(String(o.home), '.config');
    return path.join(base, 'DevSwarm', 'devswarm.db');
  }
  return null;
}

function normPath(p) {
  if (typeof p !== 'string' || !p) return null;
  let r;
  try { r = path.resolve(p); } catch (_) { return p; }
  try { return fs.realpathSync(r); } catch (_) { return r; }
}

// readBuilders(file) -> Map(id -> { archived, active, worktreePath }) | null.
function readBuilders(file) {
  let sqlite;
  try { sqlite = require('node:sqlite'); } catch (_) { return null; }
  try { if (!fs.statSync(file).isFile()) return null; } catch (_) { return null; }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const cols = new Set(db.prepare('PRAGMA table_info(builders)').all().map((c) => String(c.name)));
    if (!cols.has('id') || !cols.has('isActive')) return null;
    const hasHidden = cols.has('isHidden');
    const hasWt = cols.has('worktreePath');
    const rows = db.prepare('SELECT id, isActive' + (hasHidden ? ', isHidden' : '') + (hasWt ? ', worktreePath' : '') + ' FROM builders').all();
    const map = new Map();
    for (const r of rows) {
      if (!r || r.id == null) continue;
      const active = Number(r.isActive) === 1;
      const archived = Number(r.isActive) === 0 && (!hasHidden || Number(r.isHidden) === 1);
      map.set(String(r.id), { active, archived, worktreePath: hasWt ? normPath(r.worktreePath) : null });
    }
    return map;
  } catch (_) {
    return null;
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

// builderStates(opts) -> Map | null (cached).
function builderStates(opts) {
  const o = opts || {};
  const file = appDbPath(o);
  if (!file) return null;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const env = o.env || process.env;
  const ttlRaw = Number(env && env.ANTIHALL_DEVSWARM_APP_DB_CACHE_MS);
  const ttl = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? ttlRaw : DEFAULT_CACHE_MS;
  if (memo && memo.file === file && now - memo.at >= 0 && now - memo.at < ttl) return memo.map;
  const map = readBuilders(file);
  memo = { file, at: now, map };
  return map;
}

// appArchivedVerdict({ home, env, id, worktreePath, now }) -> true | false | null.
//   by id: the app's own record decides (archived -> true, otherwise false);
//   else by worktree: any ACTIVE builder on that worktree -> false; only
//   archived builders there -> true (a twin row sharing an archived worktree);
//   no record either way -> null (no opinion).
function appArchivedVerdict(opts) {
  const o = opts || {};
  try {
    const map = builderStates(o);
    if (!map) return null;
    const id = o.id != null ? String(o.id) : '';
    if (id && map.has(id)) return map.get(id).archived;
    const wt = normPath(o.worktreePath);
    if (!wt) return null;
    let sawArchived = false;
    for (const b of map.values()) {
      if (b.worktreePath !== wt) continue;
      if (b.active || !b.archived) return false;
      sawArchived = true;
    }
    return sawArchived ? true : null;
  } catch (_) { return null; }
}

function resetCache() { memo = null; }

module.exports = { appDbPath, builderStates, appArchivedVerdict, resetCache, DEFAULT_CACHE_MS };
