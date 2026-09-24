'use strict';
// anti-hall :: reader-cursors — THE read position model (mesh redesign Phase 3).
//
// One `reader_cursors(partition, ns, reader, value, retired_line, updated_at)`
// table per store (sqlite table / journal `reader_cursors.ndjson` under an O_EXCL
// lock — devswarm-store.js readerCursorRows/readerCursorTxn). Replaces the seven
// legacy places a read position lived (`cursors/<id>.json`, the store `cursors`
// row, `#base`, `#inst-<short6>`, `#nd-<short6>`, the descriptor cursor file as a
// position, and the rewind in reconcileOrphanCursor).
//
// RULES (plan .anti-hall/plans/2026-09-23-mesh-redesign.md §Phase 3):
//  - `reader` is '#floor' (one row per (partition, ns): the stored, monotone
//    floor) or a harness identity 'h:<pid>:<startMs>' (reader-identity.js).
//    Anything else is HEADLESS (null) and never gets a row.
//  - Every write is MAX-only. There is no rewind path.
//  - An ack writes the caller's own row AND recomputes the floor in ONE txn.
//    floor' = max(floor, MIN(live declared rows)); only when no live declared
//    row exists does a HEADLESS ack move the floor to its own target.
//  - A headless reader reads the stored floor ONLY — never max(floor, shared).
//  - A declared row leaves the MIN only when a successful process snapshot
//    PROVES its process ended (pid gone + ESRCH, or pid reused with a later
//    start). Uncertain = live. The session file is never evidence.
//  - countFor never writes; a read error returns UNKNOWN, never 0.
//
// Legacy files are read (one-time import + dual-read), raised (dual-write, only
// the shared pair and the descriptor cursor, upward only) and NEVER deleted.
//
// Pure Node built-ins. Store lifecycle stays with the caller.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const FLOOR = '#floor';
const NAMESPACES = ['store', 'nd'];
const READER_RE = /^h:(\d+):(\d+)$/;
const RETIRE_PIN_AGE_MS = 60 * 1000;
const PID_REUSE_MARGIN_MS = 1000;
const PROC_TABLE_TTL_MS = 30 * 1000;

function liveness() { return require('./liveness.js'); }

// readerKey(nonce) -> 'h:<pid>:<startMs>' | null (headless). The ONLY door into
// the table: a legacy 'anc:'/'self:' string, an injected test label, or null all
// resolve to headless.
function readerKey(nonce) {
  const s = nonce == null ? '' : String(nonce);
  return READER_RE.test(s) ? s : null;
}
function parseReader(reader) {
  const m = READER_RE.exec(String(reader || ''));
  return m ? { pid: Number(m[1]), startMs: Number(m[2]) } : null;
}

// ---------------------------------------------------------------------------
// Process liveness — "provably ended".
// ---------------------------------------------------------------------------
function parseLstart(s) {
  const t = Date.parse(String(s || '').trim());
  return Number.isFinite(t) ? t : NaN;
}
// psSnapshot() -> Map<pid, startMs|NaN> from ONE successful `ps -A -o pid=,lstart=`,
// or null when ps is unavailable / fails (null = nothing can be proven).
function psSnapshot() {
  try {
    const r = spawnSync('ps', ['-A', '-o', 'pid=,lstart='], { encoding: 'utf8', timeout: 5000 });
    if (!r || r.error || r.status !== 0) return null;
    const m = new Map();
    for (const line of String(r.stdout || '').split('\n')) {
      const t = line.trim();
      const i = t.indexOf(' ');
      if (i <= 0) continue;
      const pid = t.slice(0, i);
      if (!/^\d+$/.test(pid)) continue;
      m.set(Number(pid), parseLstart(t.slice(i + 1)));
    }
    return m.size ? m : null;
  } catch (_) { return null; }
}
let _procCache = null;
function defaultProcTable(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  if (_procCache && Math.abs(t - _procCache.at) < PROC_TABLE_TTL_MS) return _procCache.table;
  const table = psSnapshot();
  _procCache = { at: t, table };
  return table;
}
// provablyEnded(reader, procTable, kill) -> bool. TRUE only on proof:
//   (a) pid absent from a successful snapshot AND kill(pid,0) throws ESRCH, or
//   (b) pid present with a start time > startMs + 1000 ms (pid reuse).
// Everything else (no snapshot, EPERM, unparseable start, startMs unknown) is live.
function provablyEnded(reader, procTable, kill) {
  const p = parseReader(reader);
  if (!p || !(procTable instanceof Map)) return false;
  if (!procTable.has(p.pid)) {
    const k = typeof kill === 'function' ? kill : process.kill.bind(process);
    try { k(p.pid, 0); return false; } catch (e) { return !!(e && e.code === 'ESRCH'); }
  }
  const started = procTable.get(p.pid);
  // startMs must be a plausible epoch-ms value; anything else (0, seconds, a
  // corrupt field) makes the reuse comparison meaningless -> live.
  if (!Number.isFinite(started) || !(p.startMs >= 1e12)) return false;
  return started > p.startMs + PID_REUSE_MARGIN_MS;
}

// ---------------------------------------------------------------------------
// Legacy (pre-Phase-3) read-only views. Mirrors HEAD's naming exactly.
// ---------------------------------------------------------------------------
function cursorsDir(home) { return path.join(liveness().devswarmRoot(home), 'cursors'); }
function legacySafeId(id) {
  const v = String(id);
  return liveness().isSafeId(v) && !v.includes('#') && !v.includes('.seen-');
}
function readCursorFile(p) {
  try { return require('./devswarm-inbox-cursor.js').readCursor(p); } catch (_) { return 0; }
}
function primaryCursorPath(home, id) { return path.join(cursorsDir(home), String(id) + '.json'); }
function legacyShort(nonce) {
  try { return crypto.createHash('sha1').update(String(nonce)).digest('hex').slice(0, 6); } catch (_) { return null; }
}
// legacyShortFor('h:P:S') -> the short6 HEAD minted for the same harness: sha1('anc:P:S').
function legacyShortFor(reader) {
  const p = parseReader(reader);
  return p ? legacyShort('anc:' + p.pid + ':' + p.startMs) : null;
}
// listLegacy(home, id, sep) -> [{short, value}] for `<id><sep><short6>.json`.
// Unreadable files count as 0 (HEAD's instanceFloor did the same — the
// conservative, lower value).
function listLegacy(home, id, sep) {
  const out = [];
  if (!home || !legacySafeId(id)) return out;
  let names = [];
  try { names = fs.readdirSync(cursorsDir(home)); } catch (_) { return out; }
  const prefix = String(id) + sep;
  for (const n of names) {
    if (!n.startsWith(prefix) || !n.endsWith('.json')) continue;
    const short = n.slice(prefix.length, -'.json'.length);
    if (!/^[0-9a-f]{6}$/.test(short)) continue;
    out.push({ short, value: readCursorFile(path.join(cursorsDir(home), n)) });
  }
  return out;
}
function legacySharedCursor(store, home, id) {
  let json = 0, row = 0;
  if (home) json = readCursorFile(primaryCursorPath(home, id));
  try { row = store && typeof store.cursorValue === 'function' ? Number(store.cursorValue(id)) || 0 : 0; } catch (_) { row = 0; }
  return Math.max(json, row);
}
function legacyBaseline(store, home, id) {
  if (home && legacySafeId(id)) {
    const bp = path.join(cursorsDir(home), String(id) + '#base.json');
    let exists = false;
    try { exists = fs.existsSync(bp); } catch (_) { exists = false; }
    if (exists) return readCursorFile(bp);
  }
  return legacySharedCursor(store, home, id);
}
// legacyStoreFloor — HEAD's instanceFloor(id), computed DRY (no #base seed):
// max(#base | shared pair, MIN over #inst files). Never max'ed with the shared
// pair once instance files exist (rejected-patch P0 #1).
function legacyStoreFloor(store, home, id) {
  const baseline = legacyBaseline(store, home, id);
  const files = listLegacy(home, id, '#inst-');
  if (!files.length) return baseline;
  let min = null;
  for (const f of files) if (min === null || f.value < min) min = f.value;
  return Math.max(baseline, min);
}
function legacyNdFloor(cursorPath) { return cursorPath ? readCursorFile(cursorPath) : 0; }

// liveHarnessSessions(home, procTable, kill) -> [{ reader:'h:P:S', cwd }] for
// every harness session file whose process is not PROVABLY ended (the file only
// names the candidate; liveness comes from the process table).
function liveHarnessReaders(home, procTableIn, kill) {
  return liveHarnessSessions(home, procTableIn, kill).map((x) => x.reader);
}
function liveHarnessSessions(home, procTableIn, kill) {
  const out = [];
  // procTable may be a thunk: the ps snapshot is taken only when a session file
  // actually needs a verdict (no sessions dir -> no spawn).
  let procTable = procTableIn;
  let resolved = typeof procTableIn !== 'function';
  if (!home) return out;
  const dir = path.join(String(home), '.claude', 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const fp = path.join(dir, n);
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { continue; }
    if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 1 || String(rec.pid) + '.json' !== n) continue;
    let startMs = Number.isFinite(rec.startedAt) ? rec.startedAt : null;
    if (startMs === null) { try { startMs = fs.statSync(fp).mtimeMs; } catch (_) { startMs = 0; } }
    const reader = 'h:' + rec.pid + ':' + (Number.isFinite(startMs) ? startMs : 0);
    if (!resolved) { try { procTable = procTableIn(); } catch (_) { procTable = null; } resolved = true; }
    if (!provablyEnded(reader, procTable, kill)) out.push({ reader, cwd: rec.cwd != null ? String(rec.cwd) : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Partition <-> session locality (v0.106.1). A live session is a reader of a
// partition only when its session cwd resolves (identity.js resolveContext) to
// that partition's own worktree: the partition id itself when it is a mesh id
// ('primary-<hash8>'), or the worktree its descriptor names. Every other live
// session on the machine is NOT a reader — the v0.106.0 import declared all of
// them (other repos, child worktrees) and pinned every floor at the import value.
// ---------------------------------------------------------------------------
function descriptorOf(home, partition) {
  if (!home) return null;
  try {
    const d = JSON.parse(fs.readFileSync(liveness().descriptorPathFor(String(partition), home), 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch (_) { return null; }
}
function partitionMeshIds(partition, desc) {
  const ids = new Set();
  if (/^primary-[0-9a-f]{8}$/.test(String(partition))) ids.add(String(partition));
  if (desc && typeof desc.worktreePath === 'string' && desc.worktreePath) {
    try {
      const c = require('./identity.js').resolveContext(desc.worktreePath);
      if (c && c.meshId) ids.add(c.meshId);
    } catch (_) { /* unresolvable worktree: names nothing */ }
  }
  return ids;
}
// cwdInPartition(cwd, meshIds) -> true | false | null. Tri-state (P2-b fix): a
// `resolveContext` whose OWN answer was uncertain (`c.uncertain` — a git
// `--show-superproject-working-tree` spawn timed out or errored while
// classifying a submodule, see identity.js's own comment on that field)
// collapses null/false the SAME WAY a genuinely-resolved "different repo"
// answer does — there is no way to tell "definitely not local" apart from
// "could not tell" from the boolean alone. That ambiguity let a git timeout on
// one session's cwd be read as a CONFIRMED not-local verdict by
// repairPinnedFloors, which then retired (and could raise the floor past) a
// row that was never proven foreign. `null` here means "could not resolve
// with certainty" and every caller MUST treat it as "keep/include", never as
// a confident "false".
function cwdInPartition(cwd, meshIds) {
  if (!cwd || !meshIds || !meshIds.size) return false;
  try {
    const c = require('./identity.js').resolveContext(cwd);
    if (c && c.uncertain) return null;
    return !!(c && c.meshId && meshIds.has(c.meshId));
  } catch (_) { return null; }
}
// mappedShorts(home, partition) -> Set of the short6 ids with a legacy #inst/#nd
// file for this partition: proof that harness read it before Phase 3.
function mappedShorts(home, partition) {
  return new Set(listLegacy(home, partition, '#inst-').concat(listLegacy(home, partition, '#nd-')).map((f) => f.short));
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------
function rowOf(rows, ns, reader) {
  for (const r of rows) if (r.ns === ns && r.reader === reader) return r;
  return null;
}
function isRetired(r) { return !!r && r.retiredLine != null && r.value <= r.retiredLine; }
// liveMinRow(rows, ns) -> the declared, non-retired row with the lowest value.
function liveMinRow(rows, ns) {
  let best = null;
  for (const r of rows) {
    if (r.ns !== ns || r.reader === FLOOR || isRetired(r)) continue;
    if (!best || r.value < best.value) best = r;
  }
  return best;
}

// importPlan(store, opts) -> { floors:{store,nd}, readers:[{reader, ns, value}] }.
// §5: floor = HEAD's own effective floor (dry); each LIVE harness gets a row: its
// mapped legacy position (store: max(baseline, #inst) — HEAD's own read base;
// nd: its #nd file) or, unmapped, the import floor. Dead/unmappable files are
// not imported (their effect is already inside the floor).
// Only a live session LOCAL to the partition (cwdInPartition) or one with its
// own mapped legacy file is declared; the rest declare themselves lazily on
// first declare/ack. The nd floor falls back to the descriptor's cursorPath when
// the caller passed none (ack/fold/migrate callers do not carry it).
function importPlan(store, o) {
  const partition = String(o.partition);
  const desc = (!o.cursorPath || !o.harnesses) ? descriptorOf(o.home, partition) : null;
  const cursorPath = o.cursorPath || (desc && typeof desc.cursorPath === 'string' ? desc.cursorPath : null);
  const floors = {
    store: legacyStoreFloor(store, o.home, partition),
    nd: legacyNdFloor(cursorPath),
  };
  const readers = [];
  let harnesses = o.harnesses;
  if (!harnesses) {
    const meshIds = partitionMeshIds(partition, desc);
    const mapped = mappedShorts(o.home, partition);
    harnesses = liveHarnessSessions(o.home, o.procTable, o.kill)
      // cwdInPartition is tri-state (P2-b): `false` !== "not local" here — only
      // a CONFIRMED `false` excludes a session; `null` (uncertain, e.g. a git
      // timeout mid-resolution) must declare it rather than silently drop a
      // possibly-local reader.
      .filter((x) => mapped.has(legacyShortFor(x.reader)) || cwdInPartition(x.cwd, meshIds) !== false)
      .map((x) => x.reader);
  }
  if (harnesses.length) {
    const baseline = legacyBaseline(store, o.home, partition);
    const inst = new Map(listLegacy(o.home, partition, '#inst-').map((f) => [f.short, f.value]));
    const nd = new Map(listLegacy(o.home, partition, '#nd-').map((f) => [f.short, f.value]));
    for (const reader of harnesses) {
      const short = legacyShortFor(reader);
      readers.push({ reader, ns: 'store', value: inst.has(short) ? Math.max(baseline, inst.get(short)) : floors.store });
      readers.push({ reader, ns: 'nd', value: nd.has(short) ? nd.get(short) : floors.nd });
    }
  }
  return { floors, readers };
}

// applyImport(tx, rows, plan, now) — writes the missing floor rows and every
// planned reader row (MAX-upsert, so re-running is a no-op). Returns true when
// anything was written.
function applyImport(tx, rows, plan, now) {
  let wrote = false;
  for (const ns of NAMESPACES) {
    if (rowOf(rows, ns, FLOOR)) continue;
    tx.put({ partition: plan.partition, ns, reader: FLOOR, value: plan.floors[ns], updatedAt: now });
    wrote = true;
    for (const r of plan.readers) {
      if (r.ns !== ns || rowOf(rows, ns, r.reader)) continue;
      tx.put({ partition: plan.partition, ns, reader: r.reader, value: r.value, updatedAt: now });
    }
  }
  return wrote;
}
function needsImport(rows) { return NAMESPACES.some((ns) => !rowOf(rows, ns, FLOOR)); }

// ---------------------------------------------------------------------------
// Reads (never write)
// ---------------------------------------------------------------------------
// positions(store, opts) -> { store, nd, floor:{store,nd}, view, rows }.
// The caller's read base per namespace: its OWN row when declared and present,
// else the stored floor (or, before any import, the legacy floor computed dry).
// THROWS on a table read error (callers decide: countFor -> UNKNOWN).
function positions(store, opts) {
  const o = opts || {};
  const partition = String(o.partition);
  const reader = readerKey(o.reader);
  const rows = store && typeof store.readerCursorRows === 'function' ? store.readerCursorRows(partition) : [];
  const floor = {};
  for (const ns of NAMESPACES) {
    const f = rowOf(rows, ns, FLOOR);
    floor[ns] = f ? f.value : (ns === 'store' ? legacyStoreFloor(store, o.home, partition) : legacyNdFloor(o.cursorPath));
  }
  const out = { floor, rows, view: 'floor', store: floor.store, nd: floor.nd };
  if (reader) {
    const s = rowOf(rows, 'store', reader);
    const n = rowOf(rows, 'nd', reader);
    if (s) { out.store = s.value; out.view = 'own'; }
    if (n) { out.nd = n.value; out.view = 'own'; }
  }
  return out;
}
function floorOf(store, partition, ns, opts) {
  return positions(store, Object.assign({}, opts || {}, { partition, reader: null })).floor[ns || 'store'];
}
function baseFor(store, opts) { return positions(store, opts); }

function unknownResult(reason, err) {
  return {
    unknown: true, known: false, unread: null, total: null, cursor: null,
    storeCursor: null, ndCursor: null, ndjsonUnreadLines: [], storeOnlyUnreadRows: [],
    oldestUnreadAgeMs: null, view: null, reason: reason || 'read-error',
    error: err ? String((err && err.message) || err) : null,
  };
}
// countFor(store, { reader, partition, inboxPath, cursorPath, home, now, fsi }) ->
//   the unionUnread shape + { unknown:false, view, ndCursor } — or, when ANY read
//   fails, { unknown:true, known:false, unread:null, reason } (never a 0).
function countFor(store, opts) {
  const o = opts || {};
  let pos;
  try { pos = positions(store, o); } catch (e) { return unknownResult('reader-cursors-unreadable', e); }
  let u;
  try {
    u = require('./devswarm-unread.js').unionUnread({
      inboxPath: o.inboxPath || null, cursorPath: o.cursorPath || null, id: o.partition,
      storeHandle: store || null, storeBaseCursor: pos.store, ndBaseCursor: pos.nd,
      fsi: o.fsi, now: o.now,
    });
  } catch (e) { return unknownResult('union-threw', e); }
  if (u && u.storeError) return unknownResult('store-read-error', u.storeError);
  // The journal backend never throws on an unreadable file — it records the error
  // (getReadErrors) and reads empty. Surface that as UNKNOWN too.
  try {
    const errs = store && typeof store.getReadErrors === 'function' ? store.getReadErrors() : [];
    const hit = (errs || []).find((e) => e && /(messages|reader_cursors)\.ndjson$/.test(String(e.path || '')));
    if (hit) return unknownResult('store-read-error', new Error(String(hit.code || 'EUNKNOWN') + ' ' + hit.path));
  } catch (_) { /* no error channel: nothing more to check */ }
  return Object.assign(u, { unknown: false, view: pos.view, ndCursor: pos.nd });
}

// ---------------------------------------------------------------------------
// Writes (each ONE transaction)
// ---------------------------------------------------------------------------
function txnOf(store) {
  if (!store || typeof store.readerCursorTxn !== 'function') {
    const e = new Error('store handle has no reader_cursors support');
    e.code = 'ENOREADERCURSORS';
    throw e;
  }
  return store.readerCursorTxn.bind(store);
}
function nowOf(o) { return Number.isFinite(o && o.now) ? o.now : Date.now(); }

// dualWrite — one release of legacy projection, AFTER commit, best-effort,
// upward only: shared pair (store ns) / descriptor cursor (nd ns) raised to F.
// #base/#inst/#nd are never written.
function dualWrite(store, o, ns, floor) {
  if (!Number.isFinite(floor) || floor <= 0) return;
  const ic = require('./devswarm-inbox-cursor.js');
  // Each projection is independent and best-effort: one failing never skips another.
  if (ns === 'store') {
    try {
      if (o.home && legacySafeId(o.partition)) {
        const p = primaryCursorPath(o.home, o.partition);
        if (readCursorFile(p) < floor) ic.ackTo(p, floor);
      }
    } catch (_) { /* best-effort projection only */ }
    try {
      let cur = 0;
      try { cur = Number(store.cursorValue(o.partition)) || 0; } catch (_) { cur = 0; }
      if (cur < floor && typeof store.setCursor === 'function') store.setCursor(o.partition, floor);
    } catch (_) { /* best-effort projection only */ }
  } else if (o.cursorPath) {
    try { if (readCursorFile(o.cursorPath) < floor) ic.ackTo(o.cursorPath, floor); } catch (_) { /* best-effort */ }
  }
}

// importLegacy(store, { partition, home, cursorPath, dryRun, procTable, kill, harnesses, now })
//   -> { imported, dryRun, plan }. Gated on the absence of the '#floor' row(s),
//   checked INSIDE the txn: running twice is a no-op. Never deletes anything.
function importLegacy(store, opts) {
  const o = opts || {};
  const now = nowOf(o);
  const procTable = o.procTable !== undefined ? o.procTable : () => defaultProcTable(now);
  const planOpts = Object.assign({}, o, { procTable });
  if (o.dryRun) {
    const rows = store && typeof store.readerCursorRows === 'function' ? store.readerCursorRows(String(o.partition)) : [];
    if (!needsImport(rows)) return { imported: false, dryRun: true, plan: null };
    const plan = Object.assign(importPlan(store, planOpts), { partition: String(o.partition) });
    return { imported: false, dryRun: true, wouldImport: true, plan };
  }
  let plan = null;
  const imported = txnOf(store)((tx) => {
    const rows = tx.rows(String(o.partition));
    if (!needsImport(rows)) return false;
    plan = Object.assign(importPlan(store, planOpts), { partition: String(o.partition) });
    return applyImport(tx, rows, plan, now);
  });
  if (imported && plan) for (const ns of NAMESPACES) dualWrite(store, o, ns, plan.floors[ns]);
  return { imported: !!imported, dryRun: false, plan };
}

// declare(store, { partition, reader, home, cursorPath, now }) -> bool. Register/
// ensure: INSERT-if-absent at max(F, own mapped legacy position) (dual-read seed).
function declare(store, opts) {
  const o = opts || {};
  const reader = readerKey(o.reader);
  if (!reader) return false;
  const now = nowOf(o);
  const partition = String(o.partition);
  const procTable = o.procTable !== undefined ? o.procTable : undefined;
  // `ensure` declares on EVERY turn: an already-declared reader costs one read,
  // never a write transaction (the txn below re-checks, so a race is harmless).
  try {
    const pre = store.readerCursorRows(partition);
    if (!needsImport(pre) && NAMESPACES.every((ns) => { const r = rowOf(pre, ns, reader); return r && !isRetired(r); })) return false;
  } catch (_) { /* fall through: the txn surfaces a real error */ }
  return txnOf(store)((tx) => {
    let rows = tx.rows(partition);
    if (needsImport(rows)) {
      const plan = Object.assign(importPlan(store, Object.assign({}, o, { procTable: procTable !== undefined ? procTable : () => defaultProcTable(now) })), { partition });
      applyImport(tx, rows, plan, now);
      rows = tx.rows(partition);
    }
    let wrote = false;
    const short = legacyShortFor(reader);
    for (const ns of NAMESPACES) {
      const existing = rowOf(rows, ns, reader);
      if (existing) {
        // The caller is live by definition: a (false) retirement self-heals.
        if (isRetired(existing)) { tx.put({ partition, ns, reader, value: existing.value, retiredLine: null, updatedAt: now }); wrote = true; }
        continue;
      }
      const F = rowOf(rows, ns, FLOOR).value;
      const mapped = listLegacy(o.home, partition, ns === 'store' ? '#inst-' : '#nd-').find((f) => f.short === short);
      const seed = mapped ? (ns === 'store' ? Math.max(F, mapped.value) : mapped.value) : F;
      tx.put({ partition, ns, reader, value: seed, retiredLine: null, updatedAt: now });
      wrote = true;
    }
    return wrote;
  });
}

// ackFor(store, { reader, partition, ns, target, home, cursorPath, now, procTable, kill })
//   -> { ok, own, floor, from, retired, error? }.
// ONE txn: the caller's own row (declared callers only; self-heals a false
// retirement) + the floor recompute. Journal lock unavailable => nothing written.
function ackFor(store, opts) {
  const o = opts || {};
  const ns = o.ns === 'nd' ? 'nd' : 'store';
  const partition = String(o.partition);
  const reader = readerKey(o.reader);
  const now = nowOf(o);
  const target = Math.max(0, Math.floor(Number(o.target) || 0));
  // Retirement evidence is gathered OUTSIDE the txn (one ps snapshot, memoized)
  // and only when a FOREIGN declared row older than RETIRE_PIN_AGE_MS pins the MIN.
  let procTable = null;
  let observed = null;
  try {
    const pre = store.readerCursorRows(partition);
    // The FOREIGN row that would pin the floor below this ack's target (a tie
    // with the caller must not hide a dead pin behind the caller's own row).
    const pin = liveMinRow(pre.filter((r) => r.reader !== reader), ns);
    if (pin && pin.value < target && (now - (pin.updatedAt || 0)) > RETIRE_PIN_AGE_MS) {
      procTable = o.procTable !== undefined ? o.procTable : defaultProcTable(now);
      observed = new Map(pre.filter((r) => r.reader !== FLOOR).map((r) => [r.ns + '\u0000' + r.reader, r.value]));
    }
  } catch (_) { procTable = null; }
  const out = { ok: false, own: null, floor: null, from: null, retired: [] };
  try {
    const res = txnOf(store)((tx) => {
      let rows = tx.rows(partition);
      if (needsImport(rows)) {
        const plan = Object.assign(importPlan(store, Object.assign({}, o, { procTable: o.procTable !== undefined ? o.procTable : () => defaultProcTable(now) })), { partition });
        applyImport(tx, rows, plan, now);
        rows = tx.rows(partition);
      }
      const F = rowOf(rows, ns, FLOOR).value;
      let own = null;
      if (reader) {
        const cur = rowOf(rows, ns, reader);
        own = Math.max(cur ? cur.value : F, target);
        tx.put({ partition, ns, reader, value: own, retiredLine: null, updatedAt: now });
        rows = tx.rows(partition);
      }
      const retired = [];
      if (procTable && observed) {
        for (const r of rows) {
          if (r.reader === FLOOR || r.reader === reader || isRetired(r)) continue;
          if (observed.get(r.ns + '\u0000' + r.reader) !== r.value) continue; // CAS: advanced meanwhile -> not retired
          if (!provablyEnded(r.reader, procTable, o.kill)) continue;
          tx.put({ partition, ns: r.ns, reader: r.reader, value: r.value, retiredLine: r.value, updatedAt: r.updatedAt || now });
          retired.push(r.ns + ':' + r.reader);
        }
        rows = tx.rows(partition);
      }
      const pin = liveMinRow(rows, ns);
      const next = Math.max(F, pin ? pin.value : (reader ? F : target));
      tx.put({ partition, ns, reader: FLOOR, value: next, updatedAt: now });
      return { own: reader ? own : next, floor: next, from: F, retired };
    });
    Object.assign(out, res, { ok: true });
  } catch (e) {
    out.error = String((e && e.message) || e);
    out.code = (e && e.code) || null;
    return out;
  }
  dualWrite(store, o, ns, out.floor);
  return out;
}

// raiseAllLossFree(store, { partition, ns, value, home, cursorPath, now }) ->
// rows raised. ONLY for writers whose advance is loss-free by construction
// (fold after forwarding, reap after a verified archive). Every row incl. the
// floor is raised; a retired row's retired_line moves in lockstep so a fold can
// never un-retire a dead reader.
function raiseAllLossFree(store, opts) {
  const o = opts || {};
  const ns = o.ns === 'nd' ? 'nd' : 'store';
  const partition = String(o.partition);
  const value = Math.max(0, Math.floor(Number(o.value) || 0));
  if (!(value > 0)) return 0;
  const now = nowOf(o);
  const n = txnOf(store)((tx) => {
    let rows = tx.rows(partition);
    if (needsImport(rows)) {
      const plan = Object.assign(importPlan(store, Object.assign({}, o, { procTable: o.procTable !== undefined ? o.procTable : () => defaultProcTable(now) })), { partition });
      applyImport(tx, rows, plan, now);
      rows = tx.rows(partition);
    }
    let c = 0;
    for (const r of rows) {
      if (r.ns !== ns || r.value >= value) continue;
      const rec = { partition, ns, reader: r.reader, value, updatedAt: now };
      if (isRetired(r)) rec.retiredLine = value;
      tx.put(rec);
      c += 1;
    }
    return c;
  });
  dualWrite(store, o, ns, value);
  return n;
}

// raiseFloorBounded(store, { partition, value, home, now }) -> the new floor.
// For a raise that has NOT made rows reachable elsewhere (the migrate-time cursor
// merge): the floor rises to min(value, MIN(live declared)) and never lowers —
// a declared reader can never be skipped. Store namespace only.
function raiseFloorBounded(store, opts) {
  const o = opts || {};
  const partition = String(o.partition);
  const value = Math.max(0, Math.floor(Number(o.value) || 0));
  const now = nowOf(o);
  const next = txnOf(store)((tx) => {
    let rows = tx.rows(partition);
    if (needsImport(rows)) {
      const plan = Object.assign(importPlan(store, Object.assign({}, o, { procTable: o.procTable !== undefined ? o.procTable : () => defaultProcTable(now) })), { partition });
      applyImport(tx, rows, plan, now);
      rows = tx.rows(partition);
    }
    const F = rowOf(rows, 'store', FLOOR).value;
    const pin = liveMinRow(rows, 'store');
    const n = Math.max(F, pin ? Math.min(value, pin.value) : value);
    if (n > F) tx.put({ partition, ns: 'store', reader: FLOOR, value: n, updatedAt: now });
    return n;
  });
  dualWrite(store, o, 'store', next);
  return next;
}

// retireEnded(store, { partition, procTable, kill, now }) -> ['ns:reader', ...].
// Supervisor / import-stage pass. One snapshot outside the txn; CAS inside.
function retireEnded(store, opts) {
  const o = opts || {};
  const partition = String(o.partition);
  const now = nowOf(o);
  const procTable = o.procTable !== undefined ? o.procTable : defaultProcTable(now);
  if (!(procTable instanceof Map)) return [];
  const pre = store.readerCursorRows(partition);
  const observed = new Map(pre.map((r) => [r.ns + '\u0000' + r.reader, r.value]));
  return txnOf(store)((tx) => {
    const out = [];
    for (const r of tx.rows(partition)) {
      if (r.reader === FLOOR || isRetired(r)) continue;
      if (observed.get(r.ns + '\u0000' + r.reader) !== r.value) continue;
      if (!provablyEnded(r.reader, procTable, o.kill)) continue;
      tx.put({ partition, ns: r.ns, reader: r.reader, value: r.value, retiredLine: r.value, updatedAt: r.updatedAt || now });
      out.push(r.ns + ':' + r.reader);
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// v0.106.1 REPAIR — floors pinned by the v0.106.0 import (update.js stage +
// migrations.js registry entry 'repair-reader-floors'). v0.106.0 declared every
// live session on the machine as a reader of every partition (seeded at the
// import floor) and imported the nd floor as 0 when the caller carried no
// cursorPath. Per partition, ONE txn:
//   - a declared, non-retired row is RETIRED (retired_line = value; never
//     deleted) when its process provably ended, its session file is gone or now
//     names a different session, or its session is live but NOT local to the
//     partition (cwd does not resolve to the partition's worktree) AND the row
//     never advanced past the floor (value <= F: the import seed, not a read);
//   - a row with its own mapped legacy file, a local live session, an
//     unreadable/ambiguous session file, or no sessions dir at all is KEPT
//     (uncertain = keep: never retire a real local reader);
//   - the floor is recomputed by ackFor's rule: max(F, MIN(remaining live
//     declared)) — max-only; with no declared reader left and an nd floor of 0,
//     the nd floor is repaired from the legacy descriptor cursor (max-only).
// A retired row still serves its own reader's view (positions() reads it) and
// self-heals on that reader's next declare/ack. Idempotent: a second run finds
// nothing to retire and the floor already at the pin.
// ---------------------------------------------------------------------------
function sessionFilesByPid(home) {
  if (!home) return null;
  const dir = path.join(String(home), '.claude', 'sessions');
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  const m = new Map();
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const pid = Number(n.slice(0, -'.json'.length));
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch (_) { rec = null; }
    if (!rec || rec.pid !== pid) { m.set(pid, { ambiguous: true }); continue; }
    m.set(pid, { startMs: Number.isFinite(rec.startedAt) ? rec.startedAt : null, cwd: rec.cwd != null ? String(rec.cwd) : null });
  }
  return m;
}

// repairPinnedFloors(store, { partition, home, cursorPath, dryRun, procTable, kill, now })
//   -> { notImported?, retired:['ns:reader (why)'], floors:{ns:{from,to}}, changed }.
function repairPinnedFloors(store, opts) {
  const o = opts || {};
  const partition = String(o.partition);
  const now = nowOf(o);
  const pre = store.readerCursorRows(partition);
  if (needsImport(pre)) return { notImported: true, retired: [], floors: {}, changed: false };
  const desc = descriptorOf(o.home, partition);
  const cursorPath = o.cursorPath || (desc && typeof desc.cursorPath === 'string' ? desc.cursorPath : null);
  const meshIds = partitionMeshIds(partition, desc);
  const mapped = mappedShorts(o.home, partition);
  const sessions = sessionFilesByPid(o.home);
  const procTable = o.procTable !== undefined ? o.procTable : defaultProcTable(now);
  const legacyNd = legacyNdFloor(cursorPath);
  const verdicts = new Map();
  const verdictOf = (reader) => {
    if (verdicts.has(reader)) return verdicts.get(reader);
    let v = null;
    const p = parseReader(reader);
    if (p && !mapped.has(legacyShortFor(reader))) {
      if (provablyEnded(reader, procTable, o.kill)) v = 'ended';
      else if (sessions) {
        const rec = sessions.get(p.pid);
        if (!rec) v = 'session-gone';
        else if (rec.ambiguous || rec.startMs == null) v = null;
        else if (rec.startMs !== p.startMs) v = 'session-gone';
        // P2-b fix: only a CONFIRMED `false` is 'not-local'. `null` (uncertain —
        // resolveContext's own git spawn timed out/errored on this session's
        // cwd) must KEEP the row, never retire it on an unproven guess.
        else if (cwdInPartition(rec.cwd, meshIds) === false) v = 'not-local';
      }
    }
    verdicts.set(reader, v);
    return v;
  };
  const planFor = (rows) => {
    const retire = [];
    for (const r of rows) {
      if (r.reader === FLOOR || isRetired(r)) continue;
      const v = verdictOf(r.reader);
      if (!v) continue;
      const f = rowOf(rows, r.ns, FLOOR);
      if (v === 'not-local' && (!f || r.value > f.value)) continue; // advanced past the floor: a real read
      retire.push({ row: r, why: v });
    }
    const gone = new Set(retire.map((x) => x.row.ns + '\u0000' + x.row.reader));
    const remaining = rows.filter((r) => !gone.has(r.ns + '\u0000' + r.reader));
    const floors = {};
    for (const ns of NAMESPACES) {
      const f = rowOf(rows, ns, FLOOR);
      const from = f ? f.value : 0;
      const pin = liveMinRow(remaining, ns);
      let to = pin ? Math.max(from, pin.value) : from;
      if (ns === 'nd' && !pin && from === 0 && legacyNd > 0) to = legacyNd;
      floors[ns] = { from, to };
    }
    return { retire, floors };
  };
  const shape = (plan) => ({
    retired: plan.retire.map((x) => x.row.ns + ':' + x.row.reader + ' (' + x.why + ')'),
    floors: plan.floors,
    changed: plan.retire.length > 0 || NAMESPACES.some((ns) => plan.floors[ns].to > plan.floors[ns].from),
  });
  if (o.dryRun) return shape(planFor(pre));
  const plan = txnOf(store)((tx) => {
    const rows = tx.rows(partition);
    if (needsImport(rows)) return { retire: [], floors: Object.fromEntries(NAMESPACES.map((ns) => [ns, { from: 0, to: 0 }])) };
    const p = planFor(rows);
    for (const x of p.retire) {
      tx.put({ partition, ns: x.row.ns, reader: x.row.reader, value: x.row.value, retiredLine: x.row.value, updatedAt: x.row.updatedAt || now });
    }
    for (const ns of NAMESPACES) {
      if (p.floors[ns].to > p.floors[ns].from) tx.put({ partition, ns, reader: FLOOR, value: p.floors[ns].to, updatedAt: now });
    }
    return p;
  });
  const out = shape(plan);
  const dw = Object.assign({}, o, { cursorPath });
  for (const ns of NAMESPACES) if (plan.floors[ns].to > plan.floors[ns].from) dualWrite(store, dw, ns, plan.floors[ns].to);
  return out;
}

module.exports = {
  FLOOR, NAMESPACES, RETIRE_PIN_AGE_MS, PID_REUSE_MARGIN_MS,
  readerKey, parseReader, provablyEnded, psSnapshot, defaultProcTable,
  legacyStoreFloor, legacyNdFloor, legacyShortFor, liveHarnessReaders, importPlan,
  positions, baseFor, floorOf, countFor,
  importLegacy, declare, ackFor, raiseAllLossFree, raiseFloorBounded, retireEnded, repairPinnedFloors,
  isRetired, liveMinRow,
};
