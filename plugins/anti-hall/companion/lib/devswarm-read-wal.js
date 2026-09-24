'use strict';
// anti-hall :: devswarm-read-wal — the delivery write-ahead log around the
// DESTRUCTIVE native reads (mesh redesign Phase 5, simplified design).
//
// `hivecontrol workspace read-messages` (child pull) and `workspace monitor`
// (ingest daemon) pop messages off the native queue as they print them. The
// raw stdout of every such read is appended + fsynced here BEFORE it is parsed
// or written anywhere else. One append-only NDJSON file per reader:
//
//   {"t":"batch","e":<entryId>,"ts":<ms>,"raw":<exact stdout string>}
//   {"t":"done","e":<entryId>,"ts":<ms>, ...counts}
//   {"t":"quarantine","e":<entryId>,"ts":<ms>,"reason":"..."}
//
// A batch with no closing record is PENDING and is replayed (through the SAME
// production parser, idempotent by the existing content hash) before the
// reader issues another destructive read. `quarantine` closes a batch the
// parser cannot use; its raw bytes stay in the WAL — nothing here deletes.
// A torn line (crash mid-write) is skipped and never glues onto the next
// record (leading '\n', #26). A full file with nothing pending is RENAMED into
// wal/archive/ (kept, never deleted).
//
// KNOWN LIMITATION — RESIDUAL WINDOW (pending a native peek/ack API; DevSwarm
// vendor ask): hivecontrol dequeues INSIDE its own process before any byte
// reaches us, and spawnSync then holds stdout in memory until the child exits.
// A crash in that span loses the batch; nothing in anti-hall can close it. The
// window is shrunk to the minimum: callers write + fsync the RAW bytes here the
// moment spawnSync returns — before the exit-status check, before any parse or
// validation — so only the native dequeue and the pipe read remain.
//
// SECOND RESIDUAL (not closable from userland): a disk that fails BETWEEN the
// preflight and the write cannot be made durable. captureRaw() then writes the
// bytes to stderr and to a last-resort file under os.tmpdir() (fsync attempted),
// and the reader stays blocked with a loud walBlocked alert.
//
// FAIL CLOSED: a reader must pass preflight() before every destructive read and
// refuse the read when the WAL cannot be written. If the batch write itself
// fails after a read, the raw bytes go to a separate SPILL file (fsync) and the
// reader stays blocked (spillPending) until absorbSpill() moves them back into
// a writable WAL. Nothing is parsed-and-dropped.
//
// PRIOR READER KEYS: every batch records the reader's worktree; replay also
// ADOPTS (atomic claim by rename, see adoptForWorktree) other WAL files of the
// same kind whose open batches all name the same worktree — a reader whose key
// changed never strands its WAL, and two adopters never both apply a batch.
//
// HEALTH: health() reports pending counts / age / bytes per WAL and flags an
// alert past PENDING_ALERT_MS or PENDING_ALERT_BYTES. Surfaced by `inbox tick`
// and `doctor`. Nothing is ever dropped because of size or age.
//
// Pure Node built-ins. fs is injectable (every function takes F).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { devswarmRoot } = require('./liveness.js');

const WAL_ROTATE_BYTES = 1024 * 1024;

// walPath(home, kind, key) — `kind` is 'pull' | 'monitor'; `key` the reader
// (workspace id / store hash), sanitized to a filename.
function walPath(home, kind, key) {
  const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(devswarmRoot(home), 'wal', kind + '-' + safe + '.ndjson');
}

// lacksTrailingNewline(F, file) -> true iff the file exists, is non-empty and
// its last byte is not '\n'. Any fs error -> false.
function lacksTrailingNewline(F, file) {
  let fd = null;
  try {
    fd = F.openSync(file, 'r');
    const size = F.fstatSync(fd).size;
    if (!(size > 0)) return false;
    const b = Buffer.alloc(1);
    F.readSync(fd, b, 0, 1, size - 1);
    return b[0] !== 0x0a;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) { try { F.closeSync(fd); } catch (_) {} }
  }
}

// fsyncAppend(F, file, text) — append and fsync before returning. THROWS on
// any fs error; the caller decides (a failed batch write never drops the
// in-memory batch; a failed close leaves the entry pending -> replay).
function fsyncAppend(F, file, text) {
  F.mkdirSync(path.dirname(file), { recursive: true });
  const lead = lacksTrailingNewline(F, file) ? '\n' : '';
  const fd = F.openSync(file, 'a');
  try {
    F.writeSync(fd, lead + text);
    F.fsyncSync(fd);
  } finally { F.closeSync(fd); }
}

const PENDING_ALERT_MS = 60 * 60 * 1000;
const PENDING_ALERT_BYTES = 1024 * 1024;

let seq = 0;
function newEntryId(now) {
  seq += 1;
  return now + '-' + process.pid + '-' + seq + '-' + Math.random().toString(36).slice(2, 10);
}
// appendBatch(F, file, raw, now, meta?) -> entryId. Durable (fsynced) on return.
// meta.worktree (optional) lets a later reader with a different key find it.
function appendBatch(F, file, raw, now, meta, entryId) {
  const e = entryId || newEntryId(now);
  const rec = { t: 'batch', e, ts: now, raw: String(raw == null ? '' : raw) };
  if (meta && meta.worktree) rec.worktree = String(meta.worktree);
  fsyncAppend(F, file, JSON.stringify(rec) + '\n');
  return e;
}

// writable(F, file) -> null when the WAL can be appended + fsynced, else the
// error string. Opens for append and fsyncs WITHOUT writing a byte.
function writable(F, file) {
  let fd = null;
  try {
    F.mkdirSync(path.dirname(file), { recursive: true });
    fd = F.openSync(file, 'a');
    F.fsyncSync(fd);
    return null;
  } catch (e) {
    return String((e && (e.code || e.message)) || e);
  } finally {
    if (fd !== null) { try { F.closeSync(fd); } catch (_) {} }
  }
}

// Spill quarantine: <devswarm>/wal-spill/<walBasename>/<entryId>.json — a
// DIFFERENT directory from the WAL, used only when the WAL write failed.
function spillDir(file) {
  return path.join(path.dirname(path.dirname(file)), 'wal-spill', path.basename(file, '.ndjson'));
}
// spill(F, file, raw, now, meta) -> spill path (THROWS when even that fails).
function spill(F, file, raw, now, meta) {
  const dir = spillDir(file);
  F.mkdirSync(dir, { recursive: true });
  const e = newEntryId(now);
  const out = path.join(dir, e + '.json');
  const fd = F.openSync(out, 'wx');
  try {
    F.writeSync(fd, JSON.stringify({ e, ts: now, raw: String(raw == null ? '' : raw), worktree: (meta && meta.worktree) || null }));
    F.fsyncSync(fd);
  } finally { F.closeSync(fd); }
  return out;
}
// Last-resort location (WAL AND spill both failed mid-operation): a file under
// os.tmpdir() named after a hash of the WAL path, so absorbSpill() finds it.
function lastResortPrefix(file) {
  return 'anti-hall-wal-lastresort-' + crypto.createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 16) + '-';
}
function lastResortPending(F, file, tmp) {
  const dir = tmp || os.tmpdir();
  const pre = lastResortPrefix(file);
  try {
    return F.readdirSync(dir).filter((n) => n.startsWith(pre) && /\.json$/.test(n)).sort().map((n) => path.join(dir, n));
  } catch (_) { return []; }
}
// spillPending(F, file) -> [path] of spilled (and last-resort) batches not yet absorbed.
function spillPending(F, file) {
  let out = [];
  try {
    out = F.readdirSync(spillDir(file)).filter((n) => /\.json$/.test(n)).sort().map((n) => path.join(spillDir(file), n));
  } catch (_) { out = []; }
  return out.concat(lastResortPending(F, file));
}

// preflight(F, file) -> null when BOTH the WAL and its spill destination can be
// opened for append and fsynced (no bytes written), else the error string. A
// reader must pass this before every destructive native read.
function preflight(F, file) {
  const w = writable(F, file);
  if (w) return 'WAL ' + w;
  const probe = path.join(spillDir(file), '.probe');
  const sp = writable(F, probe);
  if (sp) return 'spill ' + sp;
  return null;
}

// captureRaw(F, file, raw, now, meta) -> { entryId } | { spillPath } | { lastResortPath|null, error }.
// The ONE write path for bytes a destructive read just returned: WAL, else the
// spill file, else (both failed mid-operation — the disk died between preflight
// and write) stderr AND a last-resort file under os.tmpdir(). Only { entryId }
// means "not blocked"; every other result must keep the reader BLOCKED.
function captureRaw(F, file, raw, now, meta, stderrWrite) {
  const rawStr = String(raw == null ? '' : raw);
  let walErr;
  try { return { entryId: appendBatch(F, file, rawStr, now, meta) }; } catch (e) { walErr = String((e && e.message) || e); }
  try { return { spillPath: spill(F, file, rawStr, now, meta), error: walErr }; } catch (e) { walErr += '; spill: ' + String((e && e.message) || e); }
  const write2 = stderrWrite || ((t) => { try { fs.writeSync(2, t); } catch (_) {} });
  write2('anti-hall delivery WAL: WAL AND spill write failed for ' + file + ' (' + walErr + ') — raw batch follows\n' + rawStr + '\n');
  let lastResortPath = null;
  try {
    const e = newEntryId(now);
    const out = path.join(os.tmpdir(), lastResortPrefix(file) + e + '.json');
    const fd = F.openSync(out, 'wx');
    try {
      F.writeSync(fd, JSON.stringify({ e, ts: now, raw: rawStr, worktree: (meta && meta.worktree) || null, wal: path.resolve(file) }));
      F.fsyncSync(fd);
    } finally { F.closeSync(fd); }
    lastResortPath = out;
  } catch (e) { walErr += '; last-resort: ' + String((e && e.message) || e); }
  return { lastResortPath, error: walErr };
}
// absorbSpill(F, file, now) -> { absorbed, error? }. Moves each spilled batch
// back into the WAL (as a pending batch, same entry id — idempotent), then
// renames the spill file to `.absorbed` (kept, never deleted). Stops at the
// first failure: the reader stays blocked.
function absorbSpill(F, file, now) {
  let absorbed = 0;
  for (const p of spillPending(F, file)) {
    try {
      const rec = JSON.parse(String(F.readFileSync(p, 'utf8')));
      const already = new Set(allBatchIds(F, file));
      if (!already.has(rec.e)) appendBatch(F, file, rec.raw, Number.isFinite(rec.ts) ? rec.ts : now, { worktree: rec.worktree }, rec.e);
      F.renameSync(p, p + '.absorbed');
      absorbed += 1;
    } catch (e) {
      return { absorbed, error: String((e && (e.code || e.message)) || e) };
    }
  }
  return { absorbed };
}
function allBatchIds(F, file) {
  let text;
  try { text = String(F.readFileSync(file, 'utf8')); } catch (_) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    try { const r = JSON.parse(line); if (r && r.t === 'batch' && typeof r.e === 'string') out.push(r.e); } catch (_) {}
  }
  return out;
}

// closeBatch(F, file, entryId, rec) — rec.t is 'done' or 'quarantine'.
function closeBatch(F, file, entryId, rec, now) {
  fsyncAppend(F, file, JSON.stringify(Object.assign({}, rec, { e: entryId, ts: now })) + '\n');
}

// pending(F, file) -> [{ e, raw }] in file order. Absent file -> []. An
// unreadable file THROWS: an unknown WAL state must stop new destructive
// reads, never read as "nothing pending".
function pending(F, file) {
  let text;
  try { text = String(F.readFileSync(file, 'utf8')); } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  const batches = new Map();
  const closed = new Set();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    if (!rec || typeof rec.e !== 'string') continue;
    if (rec.t === 'batch' && typeof rec.raw === 'string') batches.set(rec.e, rec);
    else if (rec.t === 'done' || rec.t === 'quarantine') closed.add(rec.e);
  }
  const out = [];
  for (const [e, rec] of batches) {
    if (!closed.has(e)) out.push({ e, raw: rec.raw, ts: rec.ts, worktree: rec.worktree || null, bytes: rec.raw.length });
  }
  return out;
}

// adoptForWorktree(F, home, kind, worktree, selfFile, lockFor?) -> [{ file, e, raw }]
// Open batches left by a PRIOR reader key of the same worktree. A foreign WAL
// is adopted only when EVERY open batch in it names this worktree, and only by
// CLAIMING it first: an atomic rename into wal/adopted/<selfBase>/ (one
// filesystem). Two concurrent adopters race on that rename; the loser gets
// ENOENT and skips, so exactly one reader applies each batch. lockFor(base)
// (optional) takes the prior reader's own lock first (release | null; null =
// that reader is busy -> skip this round). Previously claimed files that still
// have open batches (adopter crashed mid-replay) are returned again.
function adoptForWorktree(F, home, kind, worktree, selfFile, lockFor) {
  if (!worktree) return [];
  const dir = path.join(devswarmRoot(home), 'wal');
  const adoptedDir = path.join(dir, 'adopted', path.basename(selfFile, '.ndjson'));
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { names = []; }
  for (const n of names.sort()) {
    if (!n.startsWith(kind + '-') || !n.endsWith('.ndjson')) continue;
    const file = path.join(dir, n);
    if (path.resolve(file) === path.resolve(selfFile)) continue;
    let open;
    try { open = pending(F, file); } catch (_) { continue; }
    if (!open.length || !open.every((b) => b.worktree && b.worktree === String(worktree))) continue;
    const release = lockFor ? lockFor(path.basename(n, '.ndjson')) : () => {};
    if (!release) continue;
    try {
      F.mkdirSync(adoptedDir, { recursive: true });
      F.renameSync(file, path.join(adoptedDir, path.basename(n, '.ndjson') + '.' + Date.now() + '.' + process.pid + '.ndjson'));
    } catch (_) { /* ENOENT: another adopter won the claim */ }
    finally { try { release(); } catch (_) {} }
  }
  const out = [];
  let claimed = [];
  try { claimed = F.readdirSync(adoptedDir).filter((x) => x.endsWith('.ndjson')).sort(); } catch (_) { claimed = []; }
  for (const c of claimed) {
    const file = path.join(adoptedDir, c);
    let open;
    try { open = pending(F, file); } catch (_) { continue; }
    for (const b of open) out.push({ file, e: b.e, raw: b.raw });
  }
  return out;
}

// health(F, home, now) -> [{ file, pending, oldestTs, pendingBytes, spilled, alert, reason }]
// for every WAL with something pending or spilled. Read-only.
function health(F, home, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const dir = path.join(devswarmRoot(home), 'wal');
  let names = [];
  try { names = F.readdirSync(dir); } catch (_) { names = []; }
  const out = [];
  for (const n of names.sort()) {
    if (!n.endsWith('.ndjson')) continue;
    const file = path.join(dir, n);
    let open;
    try { open = pending(F, file); } catch (e) {
      out.push({ file, pending: null, oldestTs: null, pendingBytes: null, spilled: spillPending(F, file).length, alert: true, reason: 'unreadable (' + ((e && e.code) || e) + ')' });
      continue;
    }
    const spilled = spillPending(F, file).length;
    if (!open.length && !spilled) continue;
    const oldestTs = open.reduce((m, b) => (Number.isFinite(b.ts) && (m === null || b.ts < m) ? b.ts : m), null);
    const pendingBytes = open.reduce((m, b) => m + b.bytes, 0);
    const reasons = [];
    if (spilled) reasons.push(spilled + ' spilled batch(es) — WAL was not writable; destructive reads blocked');
    if (oldestTs !== null && t - oldestTs > PENDING_ALERT_MS) reasons.push('oldest pending batch ' + Math.round((t - oldestTs) / 60000) + 'm old');
    if (pendingBytes > PENDING_ALERT_BYTES) reasons.push(pendingBytes + ' pending bytes');
    out.push({ file, pending: open.length, oldestTs, pendingBytes, spilled, alert: reasons.length > 0, reason: reasons.join('; ') || null });
  }
  // Last-resort files (WAL AND spill failed mid-operation) for this home's WALs.
  try {
    const walDirAbs = path.resolve(dir);
    for (const n of F.readdirSync(os.tmpdir())) {
      if (!n.startsWith('anti-hall-wal-lastresort-') || !/\.json$/.test(n)) continue;
      let rec = null;
      try { rec = JSON.parse(String(F.readFileSync(path.join(os.tmpdir(), n), 'utf8'))); } catch (_) { continue; }
      if (!rec || typeof rec.wal !== 'string' || path.dirname(rec.wal) !== walDirAbs) continue;
      if (out.some((r) => path.resolve(r.file) === rec.wal)) continue;
      out.push({ file: rec.wal, pending: 0, oldestTs: null, pendingBytes: 0, spilled: lastResortPending(F, rec.wal).length, alert: true,
        reason: 'LAST-RESORT batch in ' + os.tmpdir() + ' — WAL and spill both failed; destructive reads blocked' });
    }
  } catch (_) { /* tmpdir unreadable: nothing to report */ }
  // Spill dirs whose WAL file does not exist at all (WAL dir unwritable).
  try {
    for (const n of F.readdirSync(path.join(devswarmRoot(home), 'wal-spill'))) {
      const file = path.join(dir, n + '.ndjson');
      if (out.some((r) => r.file === file)) continue;
      const spilled = spillPending(F, file).length;
      if (spilled) out.push({ file, pending: 0, oldestTs: null, pendingBytes: 0, spilled, alert: true, reason: spilled + ' spilled batch(es) — WAL was not writable; destructive reads blocked' });
    }
  } catch (_) { /* no spills */ }
  return out;
}

// maybeRotate(F, file, now) — nothing pending and over the size threshold:
// RENAME into wal/archive/ (never deleted). Best-effort housekeeping.
function maybeRotate(F, file, now) {
  try {
    if (F.statSync(file).size < WAL_ROTATE_BYTES) return;
    if (pending(F, file).length) return;
    const dir = path.join(path.dirname(file), 'archive');
    F.mkdirSync(dir, { recursive: true });
    F.renameSync(file, path.join(dir, path.basename(file, '.ndjson') + '.' + now + '.ndjson'));
  } catch (_) { /* housekeeping only */ }
}

module.exports = {
  WAL_ROTATE_BYTES, PENDING_ALERT_MS, PENDING_ALERT_BYTES,
  walPath, lacksTrailingNewline, fsyncAppend,
  appendBatch, closeBatch, pending, maybeRotate,
  writable, preflight, captureRaw, spill, spillDir, spillPending, lastResortPending, absorbSpill,
  adoptForWorktree, health,
};
