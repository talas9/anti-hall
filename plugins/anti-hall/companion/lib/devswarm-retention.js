'use strict';
// anti-hall :: devswarm-retention — bounded growth for the per-project DevSwarm
// message stores (store/<key>/devswarm.db). Owner-authorized automatic pruning of
// OLD messages, archive-first.
//
// WHY "PRUNE" MEANS "TOMBSTONE THE BODY", NOT "DELETE THE ROW"
// -----------------------------------------------------------
// Every read position in this system is a CONSUMED COUNT over a partition's
// insertion-ordered row list (reader_cursors.value, the legacy `cursors` row,
// cursors/<id>.json, #inst-/#base files — see reader-cursors.js and
// devswarm-unread.js unionUnread: `listMessages(id, { sinceCursor })` skips the
// first N ROWS). Deleting any row shifts every later row's position down, so a
// reader at 950 over a partition that shrank from 1000 to 500 rows would read 0
// unread while 50 real unread rows exist. `messageCount` (total) feeds the gate
// arithmetic the same way (own-reader, liveness-select, wake-watch, the CLI).
// Row identity (UNIQUE(hash)) is ALSO the dedupe key for every re-ingest path
// (the delivery WAL replay, mergeSplitBackendStore — which re-runs on every
// version — forwarding, migrations): a deleted row would be re-appended as a NEW
// unread row the next time its source is replayed.
//
// So a pruned row keeps its id / workspace_id / ts / hash / sender / recipient /
// mtype / urgency / is_heartbeat / needs_reply / orig_hash / instance_nonce / seq
// and loses only its BODY (set to NULL; every reader already maps a NULL body to
// ''). Positions, counts, seq, dedupe and every metadata-only projection
// (pendingQuestions, broadcast counts, instance-nonce detection) are unchanged by
// construction. Measured on a 60 MB live store: bodies are ~75% of the file, so
// tombstoning + VACUUM takes it to ~16 MB (~290 B/row skeleton).
//
// ELIGIBILITY — a row's body may be pruned only if ALL hold (planPartition):
//   1. it still has a non-empty body (body IS NOT NULL AND LENGTH(body) > 0);
//   2. older than retention.days (size-limit mode skips ONLY this rule);
//   3. NOT among the latest keepPerPartition rows of its partition;
//   4. direct partitions: its position is at or below EVERY reader's position —
//      the stored #floor, every non-retired declared reader row, and (when any
//      legacy artifact exists) the legacy floor legacyStoreFloor computes;
//      re-checked inside the write transaction (MAX-only positions never fall,
//      except an un-retire, which the re-check catches);
//   5. NOT a needs_reply row (an open question's text stays readable);
//   6. its body is NOT a line of the partition's NDJSON inbox (the tier-2 body
//      dedupe in unionUnread keys on the store body — pruning it would change
//      the union's `total`);
//   7. broadcast partition: NOT the latest heartbeat of any sender (working_on),
//      NOT inside the last DEFAULT_RECENT_CAP+1 collapsed runs (recent[]), and a
//      non-heartbeat broadcast only when its seq is at or below EVERY
//      workspace's broadcast cursor (a registry row with no cursor counts as 0);
//   8. not inside an id range a `retention restore` put on hold.
//
// ARCHIVE-THEN-PRUNE: each batch appends one gzip member per month to
// archive/<store>/<yyyy-mm>.ndjson.gz and fsyncs it BEFORE the tombstoning
// transaction. A crash between the two re-archives the same rows next run
// (duplicate lines); `restore` dedupes by id, so that is harmless.
//
// Pure Node built-ins (node:sqlite, zlib). Journal-backend stores are skipped.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { devswarmRoot } = require('./liveness.js');

function storeLib() { return require('./devswarm-store.js'); }
function rc() { return require('./reader-cursors.js'); }

const DEFAULTS = Object.freeze({ days: 30, maxStoreMB: 100, keepPerPartition: 200, archive: true, archiveMaxMB: 200 });
const ENV_KEYS = Object.freeze({
  days: 'ANTIHALL_DEVSWARM_RETENTION_DAYS',
  maxStoreMB: 'ANTIHALL_DEVSWARM_RETENTION_MAX_STORE_MB',
  keepPerPartition: 'ANTIHALL_DEVSWARM_RETENTION_KEEP_PER_PARTITION',
  archive: 'ANTIHALL_DEVSWARM_RETENTION_ARCHIVE',
  archiveMaxMB: 'ANTIHALL_DEVSWARM_RETENTION_ARCHIVE_MAX_MB',
});
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const BATCH_ROWS = 500;
const RECENT_RUNS_PROTECTED = 51; // devswarm-store.js DEFAULT_RECENT_CAP (50) + 1 boundary run
const VACUUM_FREELIST_RATIO = 0.2;
const STORE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000; // a store is revisited by the sweep at most every 6h
const DEFAULT_SWEEP_BUDGET_MS = 5000;
const RESTORE_HOLD_MS = 7 * DAY_MS;
const LOCK_STALE_MS = 10 * 60 * 1000;
const SIZE_MODE_MAX_ROUNDS = 3;

// ---- paths ------------------------------------------------------------------
function archiveRoot(home) { return path.join(devswarmRoot(home), 'archive'); }
function archiveDirFor(home, hash) { return path.join(archiveRoot(home), String(hash)); }
function statePath(home) { return path.join(devswarmRoot(home), 'retention-state.json'); }
function dryRunReportPath(home) { return path.join(devswarmRoot(home), 'retention-dry-run.json'); }
function lockPath(home) { return path.join(devswarmRoot(home), 'locks', 'retention.lock'); }
function logPath(home) { return path.join(home, '.anti-hall', 'logs', 'devswarm-retention.ndjson'); }
function settingsPath(home) { return path.join(home, '.anti-hall', 'settings.json'); }
function safeStoreName(h) { return /^[A-Za-z0-9._-]{1,80}$/.test(String(h || '')) && !String(h).startsWith('.'); }

function homeOf(o) {
  if (o && o.home) return o.home;
  if (process.env.NODE_TEST_CONTEXT) throw new Error('devswarm-retention: pass an explicit { home } under node --test');
  return os.homedir();
}

// ---- settings -----------------------------------------------------------------
// Precedence: env > ~/.anti-hall/settings.json (`devswarm.retention.<key>`, nested
// or a flat dotted key) > defaults. Invalid values fall back to the default.
function resolveSettings(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  let file = {};
  try {
    const j = JSON.parse(fs.readFileSync(settingsPath(homeOf(o)), 'utf8'));
    const nested = j && j.devswarm && j.devswarm.retention && typeof j.devswarm.retention === 'object' ? j.devswarm.retention : {};
    for (const k of Object.keys(DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(nested, k)) file[k] = nested[k];
      else if (j && Object.prototype.hasOwnProperty.call(j, 'devswarm.retention.' + k)) file[k] = j['devswarm.retention.' + k];
    }
  } catch (_) { file = {}; }
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const raw = env[ENV_KEYS[k]] != null && env[ENV_KEYS[k]] !== '' ? env[ENV_KEYS[k]] : file[k];
    if (k === 'archive') {
      if (raw === undefined || raw === null) out[k] = DEFAULTS[k];
      else out[k] = !(raw === false || /^(0|false|off|no)$/i.test(String(raw)));
      continue;
    }
    const n = Number(raw);
    out[k] = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(n) && n >= 0 ? n : DEFAULTS[k];
  }
  out.keepPerPartition = Math.floor(out.keepPerPartition);
  out.enabled = out.days > 0;
  return out;
}

// ---- small io helpers -----------------------------------------------------------
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return dflt; } }
function fsyncDir(dir) { try { const fd = fs.openSync(dir, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch (_) { /* not supported everywhere */ } }
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + process.pid + '.' + Date.now() + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, p);
}
function logEvent(home, rec) {
  try {
    const p = logPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, rec)) + '\n');
  } catch (_) { /* logging never breaks retention */ }
}
function fileSize(p) { try { return fs.statSync(p).size; } catch (_) { return 0; } }
function storeBytes(home, hash) {
  const db = storeLib().sqlitePathForHash(home, hash);
  return fileSize(db) + fileSize(db + '-wal');
}
function readState(home) {
  const s = readJson(statePath(home), null);
  const st = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  if (!st.stores || typeof st.stores !== 'object') st.stores = {};
  if (!st.holds || typeof st.holds !== 'object') st.holds = {};
  if (st.phase !== 'armed') st.phase = 'dry-run';
  return st;
}
function writeState(home, st) { try { writeJsonAtomic(statePath(home), st); return true; } catch (_) { return false; } }

// acquireLock(home) -> release() | null (another retention run holds it).
function acquireLock(home) {
  const p = lockPath(home);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let i = 0; i < 2; i++) {
    const token = process.pid + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now(), token })); } finally { fs.closeSync(fd); }
      return () => { try { const cur = readJson(p, null); if (cur && cur.token === token) fs.unlinkSync(p); } catch (_) {} };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      const h = readJson(p, null);
      let dead = false;
      if (h && Number.isFinite(h.pid)) { try { process.kill(h.pid, 0); } catch (err) { dead = !!(err && err.code === 'ESRCH'); } }
      const stale = !h || !Number.isFinite(h.ts) || (Date.now() - h.ts) > LOCK_STALE_MS;
      if (dead || stale) { try { fs.unlinkSync(p); } catch (_) {} continue; }
      return null;
    }
  }
  return null;
}

// ---- store enumeration ------------------------------------------------------------
// sqliteStores(home) -> [{hash, bytes}] for stores whose chosen backend is sqlite.
function sqliteStores(home) {
  const S = storeLib();
  const out = [];
  for (const hash of S.listStoreHashes(home)) {
    const dir = S.storeDirForHash(home, hash);
    const marker = S.readBackendMarker(dir);
    if (marker === 'journal') continue;
    if (fileSize(path.join(dir, 'devswarm.db')) <= 0) continue;
    out.push({ hash, bytes: storeBytes(home, hash) });
  }
  return out;
}

function openDb(home, hash, readOnly) {
  const { DatabaseSync } = require('node:sqlite');
  const p = storeLib().sqlitePathForHash(home, hash);
  const db = new DatabaseSync(p, readOnly ? { readOnly: true } : {});
  db.exec('PRAGMA busy_timeout = 3000;');
  return db;
}

// ---- eligibility ------------------------------------------------------------------
function cursorsDirOf(home) { return path.join(devswarmRoot(home), 'cursors'); }
function legacyPresent(handle, home, partition, cursorNames) {
  try { if (typeof handle.hasCursorRow === 'function' && handle.hasCursorRow(partition)) return true; } catch (_) { return true; }
  const p = String(partition);
  for (const n of cursorNames) {
    if (n === p + '.json' || n === p + '#base.json' || (n.startsWith(p + '#inst-') && n.endsWith('.json'))) return true;
  }
  return false;
}
// readerBound(handle, home, partition, cursorNames) -> the highest position every
// reader has consumed (rows at positions <= this are read by all). Reuses the
// floor model in reader-cursors.js (positions/isRetired/legacyStoreFloor).
function readerBound(handle, home, partition, cursorNames) {
  const R = rc();
  const pos = R.positions(handle, { partition, home });
  const vals = [Number(pos.floor.store) || 0];
  for (const r of pos.rows || []) {
    if (r.ns !== 'store' || r.reader === R.FLOOR || R.isRetired(r)) continue;
    vals.push(Number(r.value) || 0);
  }
  if (legacyPresent(handle, home, partition, cursorNames)) vals.push(Number(R.legacyStoreFloor(handle, home, partition)) || 0);
  return Math.max(0, Math.min.apply(null, vals));
}
// sqlBound(db, partition) -> the in-transaction re-check: min over the stored
// floor, every non-retired declared row and the legacy cursors row. null when the
// partition has no reader_cursors rows (the planned bound then stands alone).
function sqlBound(db, partition) {
  let rows = [];
  try { rows = db.prepare("SELECT reader, value, retired_line FROM reader_cursors WHERE partition = ? AND ns = 'store';").all(String(partition)); } catch (_) { rows = []; }
  const vals = [];
  for (const r of rows) {
    const v = Number(r.value);
    const retired = r.reader !== '#floor' && r.retired_line != null && v <= Number(r.retired_line);
    if (!retired) vals.push(v);
  }
  try { const c = db.prepare('SELECT value FROM cursors WHERE workspace_id = ?;').get(String(partition)); if (c) vals.push(Number(c.value)); } catch (_) {}
  return vals.length ? Math.max(0, Math.min.apply(null, vals)) : null;
}

function ndjsonLineSet(home, desc) {
  const set = new Set();
  const paths = new Set();
  if (desc && desc.inboxPath) paths.add(String(desc.inboxPath));
  if (desc && desc.id) {
    const d = readJson(path.join(devswarmRoot(home), 'workspaces', String(desc.id) + '.json'), null);
    if (d && typeof d.inboxPath === 'string' && d.inboxPath) paths.add(d.inboxPath);
  }
  for (const p of paths) {
    let raw = '';
    try { raw = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
    for (const line of raw.split('\n')) if (line.trim() !== '') set.add(line);
  }
  return set;
}

function heldIds(state, hash, now) {
  const list = (state && state.holds && Array.isArray(state.holds[hash])) ? state.holds[hash] : [];
  return list.filter((h) => h && Number(h.until) > now);
}
function isHeld(holds, id) { return holds.some((h) => id >= h.minId && id <= h.maxId); }

// planStore({home, hash, settings, now, state, ignoreAge}) -> {
//   candidates: [{id, pos, partition, ts, blen}] oldest-first,
//   partitions: {id: stats}, protectedBytes, totalBodyBytes }
function planStore(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const S = storeLib();
  const settings = o.settings || resolveSettings({ home, env: o.env });
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const cutoff = now - settings.days * DAY_MS;
  const keep = settings.keepPerPartition;
  const holds = heldIds(o.state, o.hash, now);
  const db = o.db || openDb(home, o.hash, true);
  const handle = S.openStore({ home, hash: o.hash, backend: 'sqlite', readOnly: true });
  let cursorNames = [];
  try { cursorNames = fs.readdirSync(cursorsDirOf(home)); } catch (_) { cursorNames = []; }
  const out = { hash: o.hash, candidates: [], partitions: {}, totals: { rows: 0, bodyBytes: 0, tombstoned: 0 } };
  try {
    const registry = new Map();
    try { for (const d of handle.listRegistry()) registry.set(String(d.id), d); } catch (_) {}
    const parts = db.prepare('SELECT DISTINCT workspace_id AS w FROM messages;').all().map((r) => String(r.w));
    for (const partition of parts) {
      const st = { rows: 0, candidates: 0, candidateBytes: 0, tombstoned: 0, bound: null,
        protected: { tooNew: 0, keepLast: 0, unread: 0, question: 0, ndjson: 0, broadcast: 0, held: 0 } };
      out.partitions[partition] = st;
      const isBroadcast = partition === S.BROADCAST_PARTITION_ID;
      const rows = db.prepare(
        'SELECT id, ts, seq, needs_reply, is_heartbeat, sender, urgency, body IS NULL AS tomb, COALESCE(LENGTH(body),0) AS blen'
        + (isBroadcast ? ', body' : '')
        + ' FROM messages WHERE workspace_id = ? ORDER BY id ASC;'
      ).all(partition);
      st.rows = rows.length;
      out.totals.rows += rows.length;
      const protect = new Set();
      let bound = Infinity;
      if (isBroadcast) {
        const latestHb = new Map();
        for (const r of rows) if (Number(r.is_heartbeat) === 1 && r.sender != null) latestHb.set(String(r.sender), Number(r.id));
        for (const id of latestHb.values()) protect.add(id);
        let runs = 0;
        let last = null;
        for (let i = rows.length - 1; i >= 0 && runs <= RECENT_RUNS_PROTECTED; i--) {
          const r = rows[i];
          const key = JSON.stringify([r.sender == null ? null : String(r.sender), r.body == null ? '' : String(r.body), r.urgency == null ? null : String(r.urgency)]);
          if (key !== last) { runs += 1; last = key; }
          if (runs <= RECENT_RUNS_PROTECTED) protect.add(Number(r.id));
        }
        let minBc = Infinity;
        try { for (const r of db.prepare('SELECT value FROM broadcast_cursors;').all()) minBc = Math.min(minBc, Number(r.value)); } catch (_) { minBc = 0; }
        for (const id of registry.keys()) {
          let v = 0;
          try { v = Number(handle.broadcastCursorValue(id)) || 0; } catch (_) { v = 0; }
          minBc = Math.min(minBc, v);
        }
        if (!Number.isFinite(minBc)) minBc = 0;
        st.bound = minBc;
        for (const r of rows) {
          if (Number(r.is_heartbeat) !== 1 && !(r.seq != null && Number(r.seq) <= minBc)) protect.add(Number(r.id));
        }
      } else {
        bound = readerBound(handle, home, partition, cursorNames);
        st.bound = bound;
      }
      const lines = isBroadcast ? null : ndjsonLineSet(home, registry.get(partition) || { id: partition });
      const pending = [];
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const pos = i + 1;
        const blen = Number(r.blen) || 0;
        if (Number(r.tomb) === 1) { st.tombstoned += 1; continue; }
        out.totals.bodyBytes += blen;
        if (blen === 0) continue;
        if (i >= rows.length - keep) { st.protected.keepLast += 1; continue; }
        if (!isBroadcast && pos > bound) { st.protected.unread += 1; continue; }
        if (Number(r.needs_reply) === 1) { st.protected.question += 1; continue; }
        if (isBroadcast && protect.has(Number(r.id))) { st.protected.broadcast += 1; continue; }
        if (isHeld(holds, Number(r.id))) { st.protected.held += 1; continue; }
        pending.push({ id: Number(r.id), pos, partition, ts: Number(r.ts), blen, oldEnough: Number(r.ts) < cutoff });
      }
      out.totals.tombstoned += st.tombstoned;
      // Rule 6: body equal to an NDJSON inbox line of this partition stays.
      let kept = pending;
      if (lines && lines.size && pending.length) {
        kept = [];
        const getBody = db.prepare('SELECT body FROM messages WHERE id = ?;');
        for (const c of pending) {
          const b = getBody.get(c.id);
          if (b && lines.has(String(b.body))) { st.protected.ndjson += 1; continue; }
          kept.push(c);
        }
      }
      for (const c of kept) {
        if (!c.oldEnough) {
          st.protected.tooNew += 1; // size-limit mode (ignoreAge) may still take it
          if (!o.ignoreAge) continue;
        } else {
          st.candidates += 1;
          st.candidateBytes += c.blen;
        }
        out.candidates.push(c);
      }
    }
  } finally {
    try { handle && handle.close(); } catch (_) {}
    if (!o.db) { try { db.close(); } catch (_) {} }
  }
  out.candidates.sort((a, b) => a.id - b.id);
  out.candidateBytes = out.candidates.reduce((s, c) => s + c.blen, 0);
  return out;
}

// ---- archive ------------------------------------------------------------------------
function monthOf(ts) {
  const d = new Date(Number.isFinite(ts) ? ts : 0);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}
// appendArchive(home, hash, rows) -> [{file, rows}]. One gzip member per month
// file per call; fsync'd (file, and the dir on create) before returning.
function appendArchive(home, hash, rows, now) {
  const dir = archiveDirFor(home, hash);
  fs.mkdirSync(dir, { recursive: true });
  const byMonth = new Map();
  for (const r of rows) {
    const m = monthOf(Number(r.ts));
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(r);
  }
  const written = [];
  for (const [m, list] of byMonth) {
    const file = path.join(dir, m + '.ndjson.gz');
    const created = !fs.existsSync(file);
    const text = list.map((r) => JSON.stringify(Object.assign({}, r, { archivedAt: now }))).join('\n') + '\n';
    const gz = zlib.gzipSync(Buffer.from(text, 'utf8'));
    const fd = fs.openSync(file, 'a');
    try { fs.writeSync(fd, gz); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (created) fsyncDir(dir);
    written.push({ file: path.relative(archiveRoot(home), file), rows: list.length });
  }
  return written;
}
function readArchiveFile(file) {
  const raw = fs.readFileSync(file);
  const text = zlib.gunzipSync(raw).toString('utf8'); // multi-member gzip -> concatenated
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* torn line: skip */ }
  }
  return out;
}

const ROW_COLS = 'id, workspace_id, ts, hash, body, sender, recipient, mtype, urgency, is_heartbeat, needs_reply, orig_hash, instance_nonce, seq';
function rowRecord(r) {
  const o = {};
  for (const k of Object.keys(r)) {
    const v = r[k];
    o[k] = typeof v === 'bigint' ? Number(v) : v;
  }
  return o;
}

// ---- prune one store -----------------------------------------------------------------
// pruneStore({home, hash, settings, now, dryRun, budgetMs, state, env, hooks})
//   hooks.afterArchive(batch) — test seam to simulate a crash between archive
//   and tombstone (throwing there leaves the batch archived but not pruned).
function pruneStore(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const hash = String(o.hash);
  const settings = o.settings || resolveSettings({ home, env: o.env });
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const clock = typeof o.clock === 'function' ? o.clock : Date.now;
  const t0 = clock();
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : Infinity;
  const state = o.state || readState(home);
  const maxBytes = settings.maxStoreMB > 0 ? settings.maxStoreMB * MB : Infinity;
  const res = {
    ok: true, hash, dryRun: !!o.dryRun, bytesBefore: storeBytes(home, hash), bytesAfter: null,
    ageCandidates: 0, sizeCandidates: 0, tombstoned: 0, tombstonedBytes: 0, archived: [], batches: 0,
    overLimit: false, overLimitProtected: false, vacuum: null, budgetExhausted: false, partitions: null, error: null,
  };
  if (!settings.enabled) { res.skipped = 'disabled'; return res; }
  if (!storeLib().sqliteAvailable()) { res.skipped = 'sqlite-unavailable'; return res; }
  const sdir = storeLib().storeDirForHash(home, hash);
  if (!safeStoreName(hash) || storeLib().readBackendMarker(sdir) === 'journal') { res.skipped = 'not-a-sqlite-store'; return res; }
  if (fileSize(path.join(sdir, 'devswarm.db')) <= 0) { res.skipped = 'no-store'; return res; }
  let db = null;
  try {
    db = openDb(home, hash, !!o.dryRun);
    const plan = planStore({ home, hash, settings, now, state, db, ignoreAge: true });
    res.partitions = plan.partitions;
    res.totalRows = plan.totals.rows;
    res.alreadyTombstoned = plan.totals.tombstoned;
    const age = plan.candidates.filter((c) => c.oldEnough);
    res.ageCandidates = age.length;
    res.overLimit = res.bytesBefore > maxBytes;
    // Size mode: add the oldest remaining eligible rows until the body bytes
    // freed cover the excess (VACUUM then re-measures; see the rounds loop).
    const chosen = new Map(age.map((c) => [c.id, c]));
    const addSizeCandidates = (excess) => {
      let freed = 0;
      for (const c of chosen.values()) freed += c.blen;
      let added = 0;
      for (const c of plan.candidates) {
        if (freed >= excess) break;
        if (chosen.has(c.id)) continue;
        chosen.set(c.id, c);
        freed += c.blen;
        added += 1;
      }
      return added;
    };
    if (res.overLimit) res.sizeCandidates = addSizeCandidates(res.bytesBefore - maxBytes);
    res.candidateBytes = Array.from(chosen.values()).reduce((s, c) => s + c.blen, 0);
    if (o.dryRun) {
      res.overLimitProtected = res.overLimit && (res.bytesBefore - plan.candidateBytes) > maxBytes;
      res.bytesAfter = res.bytesBefore;
      return res;
    }
    const doBatches = (list) => {
      for (let i = 0; i < list.length; i += BATCH_ROWS) {
        if (clock() - t0 > budgetMs) { res.budgetExhausted = true; return false; }
        const batch = list.slice(i, i + BATCH_ROWS);
        const byId = new Map(batch.map((c) => [c.id, c]));
        const ph = batch.map(() => '?').join(',');
        const full = db.prepare('SELECT ' + ROW_COLS + ' FROM messages WHERE body IS NOT NULL AND id IN (' + ph + ') ORDER BY id;')
          .all(...batch.map((c) => c.id)).map(rowRecord);
        if (!full.length) continue;
        let written = [];
        if (settings.archive) written = appendArchive(home, hash, full, now);
        if (o.hooks && typeof o.hooks.afterArchive === 'function') o.hooks.afterArchive({ hash, ids: full.map((r) => r.id), written });
        let pruned = 0;
        let prunedBytes = 0;
        const ids = [];
        db.exec('BEGIN IMMEDIATE;');
        try {
          const boundCache = new Map();
          const upd = db.prepare('UPDATE messages SET body = NULL WHERE id = ? AND body IS NOT NULL;');
          for (const r of full) {
            const c = byId.get(Number(r.id));
            if (c && c.partition !== storeLib().BROADCAST_PARTITION_ID) {
              if (!boundCache.has(c.partition)) boundCache.set(c.partition, sqlBound(db, c.partition));
              const b = boundCache.get(c.partition);
              if (b !== null && c.pos > b) continue; // a reader fell back (un-retire): keep it
            }
            const u = upd.run(Number(r.id));
            if (u.changes > 0) { pruned += 1; prunedBytes += r.body == null ? 0 : Buffer.byteLength(String(r.body)); ids.push(Number(r.id)); }
          }
          db.exec('COMMIT;');
        } catch (e) { try { db.exec('ROLLBACK;'); } catch (_) {} throw e; }
        res.tombstoned += pruned;
        res.tombstonedBytes += prunedBytes;
        res.batches += 1;
        for (const w of written) res.archived.push(w);
        const st = state.stores[hash] || (state.stores[hash] = {});
        if (ids.length) st.maxArchivedId = Math.max(Number(st.maxArchivedId) || 0, ids[ids.length - 1]);
        logEvent(home, {
          event: 'prune-batch', store: hash, rows: pruned, bytes: prunedBytes,
          minId: ids.length ? ids[0] : null, maxId: ids.length ? ids[ids.length - 1] : null,
          archived: settings.archive ? written : false,
        });
      }
      return true;
    };
    const ordered = Array.from(chosen.values()).sort((a, b) => a.id - b.id);
    let finished = doBatches(ordered);
    res.vacuum = maybeVacuum(db, res.tombstonedBytes, res.bytesBefore, clock, res.overLimit);
    res.bytesAfter = storeBytes(home, hash);
    // Size rounds: the body-bytes estimate can undershoot the real reclaim.
    let round = 1;
    while (finished && res.bytesAfter > maxBytes && round < SIZE_MODE_MAX_ROUNDS) {
      round += 1;
      const before = chosen.size;
      const prunedSoFar = res.tombstonedBytes;
      addSizeCandidates(chosenFreed(chosen) + (res.bytesAfter - maxBytes));
      const extra = Array.from(chosen.values()).slice(before).sort((a, b) => a.id - b.id);
      if (!extra.length) break;
      res.sizeCandidates += extra.length;
      finished = doBatches(extra);
      res.vacuum = maybeVacuum(db, res.tombstonedBytes - prunedSoFar, res.bytesAfter, clock, true) || res.vacuum;
      res.bytesAfter = storeBytes(home, hash);
    }
    res.overLimitProtected = res.bytesAfter > maxBytes && finished && chosen.size >= plan.candidates.length;
    if (res.bytesAfter > maxBytes) {
      logEvent(home, { event: res.overLimitProtected ? 'over-limit-protected' : 'over-limit', store: hash, bytes: res.bytesAfter, limitBytes: maxBytes });
    }
  } catch (e) {
    res.ok = false;
    res.error = String((e && e.message) || e);
    logEvent(home, { event: 'prune-error', store: hash, error: res.error });
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
  if (res.bytesAfter === null) res.bytesAfter = storeBytes(home, hash);
  return res;
}
function chosenFreed(chosen) { let f = 0; for (const c of chosen.values()) f += c.blen; return f; }

// maybeVacuum(db, prunedBytes, fileBytes, clock) -> {ran, ms, freelistRatio, error?} | null.
// Tombstoning a body frees whole pages only for overflow chains; inline bodies
// leave partly-empty pages the freelist does not show (measured: 16 MB of bodies
// pruned from a 60 MB store left a 2.6% freelist, and VACUUM then reclaimed
// 20 MB in ~230 ms). So VACUUM when EITHER the freelist or the bytes pruned this
// run exceed 20% of the file — or always (force) when enforcing the size limit.
function maybeVacuum(db, prunedBytes, fileBytes, clock, force) {
  if (!(prunedBytes > 0)) return null;
  const now = typeof clock === 'function' ? clock : Date.now;
  let ratio = 0;
  try {
    const pc = Number(db.prepare('PRAGMA page_count;').get().page_count) || 0;
    const fl = Number(db.prepare('PRAGMA freelist_count;').get().freelist_count) || 0;
    ratio = pc > 0 ? fl / pc : 0;
  } catch (_) { ratio = 0; }
  // Tombstoning rewrites pages in place; SQLite only frees whole pages (overflow
  // chains), so the freelist is the reclaimable part. VACUUM when it is worth it.
  const prunedRatio = fileBytes > 0 ? prunedBytes / fileBytes : 0;
  if (!force && ratio <= VACUUM_FREELIST_RATIO && prunedRatio <= VACUUM_FREELIST_RATIO) return { ran: false, freelistRatio: ratio, prunedRatio };
  const t = now();
  try {
    db.exec('VACUUM;');
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {}
    return { ran: true, ms: now() - t, freelistRatio: ratio, prunedRatio };
  } catch (e) {
    return { ran: false, deferred: true, freelistRatio: ratio, prunedRatio, error: String((e && e.message) || e) };
  }
}

// ---- legacy journal fold -------------------------------------------------------------
// A split store (sqlite chosen, journal/ still on disk) whose merge already ran
// (MERGE-STATE.json) and has nothing left to merge (a fresh dry-run says so) has
// its raw journal/*.ndjson compressed into archive/<store>/legacy-journal/ and
// the raw file removed only after the gzip is fsync'd and verified byte-equal.
function foldLegacyJournal(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const S = storeLib();
  const hash = String(o.hash);
  const dir = S.storeDirForHash(home, hash);
  const jdir = path.join(dir, 'journal');
  const res = { hash, eligible: false, reason: null, files: [], dryRun: !!o.dryRun };
  let names = [];
  try { names = fs.readdirSync(jdir).filter((n) => /\.ndjson$/.test(n)); } catch (_) { names = []; }
  if (!names.length) { res.reason = 'no-journal'; return res; }
  if (S.readBackendMarker(dir) !== 'sqlite' || fileSize(path.join(dir, 'devswarm.db')) <= 0) { res.reason = 'not-sqlite-store'; return res; }
  if (!S.readMergeMarker(dir)) { res.reason = 'merge-not-recorded'; return res; }
  let dry = null;
  try { dry = S.mergeSplitBackendStore(home, hash, { dryRun: true, env: o.env }); } catch (e) { res.reason = 'merge-check-failed'; return res; }
  if (!dry || !dry.ok || dry.pending) { res.reason = 'merge-pending'; return res; }
  res.eligible = true;
  const outDir = path.join(archiveDirFor(home, hash), 'legacy-journal');
  for (const n of names) {
    const src = path.join(jdir, n);
    let st;
    try { st = fs.statSync(src); } catch (_) { continue; }
    const dest = path.join(outDir, n.replace(/\.ndjson$/, '') + '-' + Math.floor(st.mtimeMs) + '.ndjson.gz');
    res.files.push({ file: n, bytes: st.size, dest: path.relative(archiveRoot(home), dest) });
    if (o.dryRun) continue;
    const raw = fs.readFileSync(src);
    const gz = zlib.gzipSync(raw);
    fs.mkdirSync(outDir, { recursive: true });
    const tmp = dest + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, gz); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, dest);
    fsyncDir(outDir);
    const back = zlib.gunzipSync(fs.readFileSync(dest));
    if (!back.equals(raw)) { res.files[res.files.length - 1].error = 'verify-mismatch'; try { fs.unlinkSync(dest); } catch (_) {} continue; }
    fs.unlinkSync(src);
    logEvent(home, { event: 'legacy-journal-archived', store: hash, file: n, bytes: st.size, dest: path.relative(archiveRoot(home), dest) });
  }
  if (!o.dryRun) { try { fs.rmdirSync(jdir); } catch (_) { /* other files remain */ } }
  return res;
}

// ---- archive cap ------------------------------------------------------------------------
function listArchiveFiles(home) {
  const out = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.ndjson\.gz$/.test(e.name)) {
        let st = null;
        try { st = fs.statSync(p); } catch (_) { continue; }
        const m = /^(\d{4}-\d{2})\.ndjson\.gz$/.exec(e.name);
        out.push({ path: p, bytes: st.size, sortKey: m ? m[1] : new Date(st.mtimeMs).toISOString().slice(0, 7), mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(archiveRoot(home));
  return out;
}
function enforceArchiveCap(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const settings = o.settings || resolveSettings({ home, env: o.env });
  const files = listArchiveFiles(home);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  const cap = settings.archiveMaxMB * MB;
  const res = { totalBytes: total, capBytes: cap, removed: [], dryRun: !!o.dryRun };
  if (!(settings.archiveMaxMB > 0) || total <= cap) return res;
  files.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.mtimeMs - b.mtimeMs));
  let cur = total;
  for (const f of files) {
    if (cur <= cap) break;
    res.removed.push({ file: path.relative(archiveRoot(home), f.path), bytes: f.bytes });
    cur -= f.bytes;
    if (o.dryRun) continue;
    try {
      fs.unlinkSync(f.path);
      logEvent(home, { event: 'archive-evict', file: path.relative(archiveRoot(home), f.path), bytes: f.bytes, capBytes: cap });
    } catch (_) { /* next run retries */ }
  }
  res.totalBytesAfter = cur;
  return res;
}

// ---- restore -------------------------------------------------------------------------------
// restore({home, hash, month}) -> re-imports archived bodies into their
// tombstoned rows (dedupe by id; a row whose body is present is left alone;
// hash must match). Puts the restored id range on a 7-day hold so the sweep does
// not prune it straight back.
function restore(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const hash = String(o.hash || '');
  const month = String(o.month || '');
  if (!safeStoreName(hash)) return { ok: false, error: 'bad --store' };
  if (!/^\d{4}-\d{2}$/.test(month)) return { ok: false, error: '--month must be yyyy-mm' };
  const file = path.join(archiveDirFor(home, hash), month + '.ndjson.gz');
  if (!fs.existsSync(file)) return { ok: false, error: 'no archive ' + path.relative(archiveRoot(home), file) };
  if (fileSize(storeLib().sqlitePathForHash(home, hash)) <= 0) return { ok: false, error: 'no sqlite store ' + hash };
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const byId = new Map();
  let lines = 0;
  for (const r of readArchiveFile(file)) { lines += 1; if (Number.isFinite(Number(r.id))) byId.set(Number(r.id), r); }
  const res = { ok: true, action: 'retention-restore', store: hash, month, archiveLines: lines, unique: byId.size, restored: 0, alreadyPresent: 0, missing: 0, mismatched: 0 };
  const release = o.noLock ? () => {} : acquireLock(home);
  if (!release) return { ok: false, error: 'retention lock busy' };
  let db = null;
  try {
    db = openDb(home, hash, false);
    const get = db.prepare('SELECT hash, body IS NULL AS tomb FROM messages WHERE id = ?;');
    const upd = db.prepare('UPDATE messages SET body = ? WHERE id = ? AND body IS NULL;');
    let minId = Infinity;
    let maxId = -Infinity;
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const [id, r] of byId) {
        const cur = get.get(id);
        if (!cur) { res.missing += 1; continue; }
        if ((cur.hash == null ? null : String(cur.hash)) !== (r.hash == null ? null : String(r.hash))) { res.mismatched += 1; continue; }
        if (Number(cur.tomb) !== 1) { res.alreadyPresent += 1; continue; }
        upd.run(r.body == null ? '' : String(r.body), id);
        res.restored += 1;
        minId = Math.min(minId, id);
        maxId = Math.max(maxId, id);
      }
      db.exec('COMMIT;');
    } catch (e) { try { db.exec('ROLLBACK;'); } catch (_) {} throw e; }
    if (res.restored > 0) {
      const st = readState(home);
      const list = heldIds(st, hash, now);
      list.push({ minId, maxId, until: now + RESTORE_HOLD_MS, month });
      st.holds[hash] = list;
      writeState(home, st);
      res.holdUntil = now + RESTORE_HOLD_MS;
    }
    logEvent(home, { event: 'restore', store: hash, month, restored: res.restored, alreadyPresent: res.alreadyPresent, missing: res.missing, mismatched: res.mismatched });
  } catch (e) {
    res.ok = false;
    res.error = String((e && e.message) || e);
  } finally {
    try { if (db) db.close(); } catch (_) {}
    release();
  }
  return res;
}

// ---- status ----------------------------------------------------------------------------------
function status(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const settings = resolveSettings({ home, env: o.env });
  const st = readState(home);
  const stores = sqliteStores(home).sort((a, b) => b.bytes - a.bytes);
  const maxBytes = settings.maxStoreMB > 0 ? settings.maxStoreMB * MB : Infinity;
  const archiveFiles = listArchiveFiles(home);
  return {
    ok: true, action: 'retention-status', settings, phase: st.phase,
    dryRunCompletedAt: st.dryRunCompletedAt || null, dryRunReport: fs.existsSync(dryRunReportPath(home)) ? dryRunReportPath(home) : null,
    stores: stores.map((s) => Object.assign({ hash: s.hash, mb: Math.round((s.bytes / MB) * 10) / 10, overLimit: s.bytes > maxBytes },
      st.stores[s.hash] ? { lastRunAt: st.stores[s.hash].lastRunAt || null, overLimitProtected: !!st.stores[s.hash].overLimitProtected } : {})),
    archive: { files: archiveFiles.length, mb: Math.round((archiveFiles.reduce((a, f) => a + f.bytes, 0) / MB) * 10) / 10 },
    log: logPath(home),
  };
}

// ---- run (CLI) + sweep (supervisor) -------------------------------------------------------------
function run(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const settings = resolveSettings({ home, env: o.env });
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  if (o.store && !safeStoreName(o.store)) return { ok: false, error: 'bad --store' };
  const release = acquireLock(home);
  if (!release) return { ok: false, error: 'retention lock busy' };
  try {
    const st = readState(home);
    const targets = o.store ? [String(o.store)] : sqliteStores(home).map((s) => s.hash);
    const stores = [];
    for (const hash of targets) {
      const r = pruneStore({ home, hash, settings, now, dryRun: !!o.dryRun, state: st, budgetMs: o.budgetMs });
      r.legacy = foldLegacyJournal({ home, hash, dryRun: !!o.dryRun, env: o.env });
      if (!o.dryRun) recordStore(st, hash, r, now);
      stores.push(summarize(r));
    }
    const cap = enforceArchiveCap({ home, settings, dryRun: !!o.dryRun });
    if (!o.dryRun) writeState(home, st);
    return { ok: stores.every((s) => s.ok), action: 'retention-run', dryRun: !!o.dryRun, settings, stores, archiveCap: cap };
  } finally { release(); }
}
function recordStore(st, hash, r, now) {
  if (r.skipped) return;
  const e = st.stores[hash] || (st.stores[hash] = {});
  Object.assign(e, {
    lastRunAt: now, tombstoned: (Number(e.tombstoned) || 0) + (r.tombstoned || 0),
    lastTombstoned: r.tombstoned || 0, bytesBefore: r.bytesBefore, bytesAfter: r.bytesAfter,
    overLimitProtected: !!r.overLimitProtected, vacuum: r.vacuum || null, error: r.error || null,
    budgetExhausted: !!r.budgetExhausted,
  });
}
function summarize(r) {
  const prot = { tooNew: 0, keepLast: 0, unread: 0, question: 0, ndjson: 0, broadcast: 0, held: 0 };
  for (const p of Object.values(r.partitions || {})) for (const k of Object.keys(prot)) prot[k] += p.protected[k] || 0;
  return {
    ok: r.ok, hash: r.hash, skipped: r.skipped || null, error: r.error, dryRun: r.dryRun,
    mbBefore: Math.round((r.bytesBefore / MB) * 10) / 10, mbAfter: r.bytesAfter == null ? null : Math.round((r.bytesAfter / MB) * 10) / 10,
    rows: r.totalRows || 0, alreadyTombstoned: r.alreadyTombstoned || 0,
    ageCandidates: r.ageCandidates, sizeCandidates: r.sizeCandidates, candidateMB: Math.round(((r.candidateBytes || 0) / MB) * 10) / 10,
    tombstoned: r.tombstoned, overLimit: r.overLimit, overLimitProtected: r.overLimitProtected,
    vacuum: r.vacuum, budgetExhausted: r.budgetExhausted, protected: prot,
    legacy: r.legacy ? { eligible: r.legacy.eligible, reason: r.legacy.reason, files: r.legacy.files.length } : null,
  };
}

// sweep({home, env, now, budgetMs}) — the supervisor slot. Machine first run:
// a budgeted, resumable DRY-RUN over every store (report written to
// retention-dry-run.json + the log); once every store is reported the phase
// flips to 'armed' and each later sweep ACTS on ONE store (the largest not
// visited in the last 6h), then enforces the archive cap.
function sweep(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const env = o.env || process.env;
  const settings = resolveSettings({ home, env });
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const clock = typeof o.clock === 'function' ? o.clock : Date.now;
  const budgetMs = Number.isFinite(o.budgetMs) ? o.budgetMs : resolveBudgetMs(env);
  if (!settings.enabled) return { ran: false, reason: 'disabled' };
  if (!storeLib().sqliteAvailable()) return { ran: false, reason: 'sqlite-unavailable' };
  const release = acquireLock(home);
  if (!release) return { ran: false, reason: 'lock-busy' };
  const t0 = clock();
  try {
    const st = readState(home);
    const stores = sqliteStores(home);
    if (st.phase !== 'armed') {
      const report = readJson(dryRunReportPath(home), null) || { startedAt: now, stores: {} };
      if (!report.stores || typeof report.stores !== 'object') report.stores = {};
      let done = 0;
      for (const s of stores) {
        if (report.stores[s.hash]) continue;
        if (clock() - t0 > budgetMs) break;
        const r = pruneStore({ home, hash: s.hash, settings, now, dryRun: true, state: st });
        r.legacy = foldLegacyJournal({ home, hash: s.hash, dryRun: true, env });
        report.stores[s.hash] = summarize(r);
        done += 1;
      }
      const remaining = stores.filter((s) => !report.stores[s.hash]).length;
      report.archiveCap = enforceArchiveCap({ home, settings, dryRun: true });
      report.settings = settings;
      try { writeJsonAtomic(dryRunReportPath(home), report); } catch (_) {}
      if (!remaining) {
        st.phase = 'armed';
        st.dryRunCompletedAt = now;
        const tot = Object.values(report.stores).reduce((a, r) => ({ rows: a.rows + (r.ageCandidates || 0) + (r.sizeCandidates || 0), mb: a.mb + (r.candidateMB || 0) }), { rows: 0, mb: 0 });
        logEvent(home, { event: 'dry-run-complete', stores: Object.keys(report.stores).length, wouldPruneRows: tot.rows, wouldPruneMB: Math.round(tot.mb * 10) / 10, report: dryRunReportPath(home) });
      }
      writeState(home, st);
      return { ran: true, phase: 'dry-run', reported: done, remaining, ms: clock() - t0 };
    }
    const due = stores
      .filter((s) => !(st.stores[s.hash] && Number(st.stores[s.hash].lastRunAt) > now - STORE_MIN_INTERVAL_MS && !st.stores[s.hash].budgetExhausted))
      .sort((a, b) => b.bytes - a.bytes);
    let result = null;
    if (due.length) {
      const hash = due[0].hash;
      const r = pruneStore({ home, hash, settings, now, state: st, budgetMs, clock });
      r.legacy = foldLegacyJournal({ home, hash, env });
      recordStore(st, hash, r, now);
      result = summarize(r);
    }
    const cap = enforceArchiveCap({ home, settings });
    writeState(home, st);
    return { ran: true, phase: 'armed', store: result, archiveEvicted: cap.removed.length, ms: clock() - t0 };
  } catch (e) {
    return { ran: false, error: String((e && e.message) || e) };
  } finally { release(); }
}
function resolveBudgetMs(env) {
  const n = Number((env || {}).ANTIHALL_DEVSWARM_RETENTION_BUDGET_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_SWEEP_BUDGET_MS;
}

// doctorCheck({home, env}) -> [{status, message}] (PASS/WARN only; read-only).
function doctorCheck(opts) {
  const o = opts || {};
  const home = homeOf(o);
  const settings = resolveSettings({ home, env: o.env });
  if (!settings.enabled) return [{ status: 'PASS', message: 'message retention: disabled (devswarm.retention.days = 0)' }];
  const st = readState(home);
  const out = [];
  const maxBytes = settings.maxStoreMB > 0 ? settings.maxStoreMB * MB : Infinity;
  const stores = sqliteStores(home);
  const over = stores.filter((s) => s.bytes > maxBytes);
  if (st.phase !== 'armed') {
    out.push({ status: 'WARN', message: 'message retention: first run is a dry-run report only — review ' + dryRunReportPath(home) + ' (sweeps start pruning once every store is reported)' });
  }
  for (const s of over) {
    const e = st.stores[s.hash] || {};
    const mb = Math.round((s.bytes / MB) * 10) / 10;
    if (e.overLimitProtected) out.push({ status: 'WARN', message: 'message retention: store ' + s.hash + ' is ' + mb + ' MB (limit ' + settings.maxStoreMB + ' MB) and every remaining body is unread/protected — nothing more can be pruned safely' });
    else out.push({ status: 'WARN', message: 'message retention: store ' + s.hash + ' is ' + mb + ' MB, over the ' + settings.maxStoreMB + ' MB limit (pruning pending)' });
  }
  const errs = Object.keys(st.stores).filter((h) => st.stores[h] && st.stores[h].error);
  for (const h of errs) out.push({ status: 'WARN', message: 'message retention: last run on store ' + h + ' failed: ' + st.stores[h].error });
  const arch = listArchiveFiles(home).reduce((a, f) => a + f.bytes, 0);
  if (settings.archiveMaxMB > 0 && arch > settings.archiveMaxMB * MB) out.push({ status: 'WARN', message: 'message retention: archive is ' + Math.round(arch / MB) + ' MB, over the ' + settings.archiveMaxMB + ' MB cap (next sweep evicts the oldest months)' });
  if (!out.length) {
    const largest = stores.reduce((m, s) => Math.max(m, s.bytes), 0);
    out.push({ status: 'PASS', message: 'message retention: ' + stores.length + ' store(s), largest ' + (Math.round((largest / MB) * 10) / 10) + ' MB (limit ' + settings.maxStoreMB + ' MB), archive ' + (Math.round((arch / MB) * 10) / 10) + ' MB' });
  }
  return out;
}

module.exports = {
  DEFAULTS, ENV_KEYS, BATCH_ROWS, RECENT_RUNS_PROTECTED, STORE_MIN_INTERVAL_MS,
  resolveSettings, archiveRoot, archiveDirFor, statePath, dryRunReportPath, logPath, lockPath,
  readState, writeState, acquireLock, sqliteStores, storeBytes,
  readerBound, planStore, pruneStore, maybeVacuum, appendArchive, readArchiveFile, monthOf,
  foldLegacyJournal, enforceArchiveCap, listArchiveFiles, restore, status, run, sweep, doctorCheck,
};
