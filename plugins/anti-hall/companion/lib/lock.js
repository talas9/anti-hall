'use strict';
// anti-hall :: companion/lib/lock.js — THE one cross-process lock-file
// primitive. Every advisory lock in the plugin (swarm-guard, settings,
// repair-on-reload, recovery per-id, supervisor sweep, ingest, migrate, pull,
// wake-watch, store journal, log rotation, retention) goes through here; the
// hygiene ratchet tests/hygiene/lock-single-primitive.test.js forbids a new
// hand-written one. Pure Node built-ins, synchronous (hooks cannot await).
//
// DESIGN (promoted from companion/lib/recovery.js acquireLock, where each piece
// was paid for by a real incident):
//   * OWNER RECORD — the lock file is JSON {pid, host, ts, token, ...fields}.
//     `token` is unique per acquisition; release/refresh act ONLY while the
//     on-disk token is still ours, so we never delete a successor's lock.
//     `host` scopes the pid: a holder on ANOTHER host (a shared SMB/NFS home)
//     can never be probed with kill(pid, 0), so its pid is treated as unknown
//     (staleness-only) instead of "dead".
//   * PUBLISH — publish:'link' (default) writes the FULL record to a private
//     temp file and publishes it with linkSync (fails EEXIST like O_EXCL, but
//     the lock is never visible empty — 7858c56). When linkSync itself is
//     unsupported (EPERM/ENOTSUP/EXDEV/ENOSYS on SMB/exFAT — 3973de4) it falls
//     back to openSync(p,'wx') + write for that attempt. publish:'excl' is the
//     plain O_EXCL create for callers whose contract is defined on it.
//   * TORN-READ GUARD — a holder file that is empty/unparseable (the 'wx'
//     create->write window, or a crash inside it) is dated by its MTIME, never
//     read as "ownerless": a fresh torn file is a live holder mid-write.
//   * ATOMIC RECLAIM — a stealable holder is renamed ASIDE first (fails if
//     someone else already moved/replaced it), the moved copy's token is
//     compared with the one we judged, and only then discarded. A mismatch
//     means a fresh lock got caught: it is restored WITHOUT clobbering
//     (linkSync, so a lock published meanwhile is never overwritten) and
//     respected (2f6dd00). A blind unlinkSync(p) here was the reclaim race
//     where two stealers of one dead holder both "won".
//
// STEAL POLICY (per caller, via options — every caller keeps its old rule):
//   holder classes: KNOWN (parsed record with a local pid) -> alive | dead;
//                   UNKNOWN (torn/unparseable, no pid, or a foreign host).
//   age = now - (record.ts, else file mtime); stat failure -> Infinity.
//   - dead holder:    stolen when opts.stealDead, else once age > staleMs.
//   - live holder:    stolen once age > liveStaleMs (default Infinity = never).
//   - unknown holder: stolen once age > staleMs.
//   - opts.decide(holder) -> 'steal' | 'respect' | undefined overrides it
//     (ingest's zombie/pid-reuse/wedged-heartbeat verdicts).

const fs = require('fs');
const os = require('os');

const DEFAULT_STALE_MS = 15 * 60 * 1000;

let SEQ = 0;
function rand() { return Math.random().toString(36).slice(2); }
function newToken(ts) { return process.pid + ':' + ts + ':' + (++SEQ) + ':' + rand(); }

let HOST = null;
function localHost() {
  if (HOST === null) { try { HOST = os.hostname(); } catch (_) { HOST = ''; } }
  return HOST;
}

// defaultIsAlive(pid) -> bool. kill(pid,0): ESRCH = gone; EPERM = exists but
// not ours to signal (still alive).
function defaultIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// sleepSync(ms) — cross-platform synchronous sleep with no busy-spin.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch (_) { /* best-effort */ }
}

function parseRecord(raw) {
  try {
    const r = JSON.parse(raw);
    return r && typeof r === 'object' && !Array.isArray(r) ? r : null;
  } catch (_) { return null; }
}

function mkdirParent(F, p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (i > 0) { try { F.mkdirSync(p.slice(0, i), { recursive: true }); } catch (_) { /* surfaced by the create */ } }
}

// inspect(lockPath, opts) -> holder | null (no lock file). Read-only.
// holder = { record, pid, host, ts, token, tsFromMtime, ageMs, known, alive,
//            dead, unknown }
function inspect(lockPath, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  const now = o.now || Date.now;
  const isAlive = o.isAlive || defaultIsAlive;
  let raw;
  try { raw = F.readFileSync(lockPath, 'utf8'); }
  catch (e) { if (e && e.code === 'ENOENT') return null; raw = null; }
  const record = raw === null ? null : parseRecord(raw);
  const pid = record && Number.isFinite(record.pid) && record.pid > 0 ? record.pid : null;
  const host = record && typeof record.host === 'string' ? record.host : null;
  const token = record && typeof record.token !== 'undefined' ? record.token : null;
  let ts = record && Number.isFinite(record.ts) ? record.ts : null;
  let tsFromMtime = false;
  if (ts === null) {
    try { ts = F.statSync(lockPath).mtimeMs; tsFromMtime = true; } catch (_) { ts = null; }
  }
  const t = now();
  const ageMs = ts === null ? Infinity : Math.max(0, t - ts);
  const known = pid !== null && (host === null || host === localHost());
  let alive = null;
  if (known) { try { alive = !!isAlive(pid); } catch (_) { alive = true; } }
  return {
    record, pid, host, ts, token, tsFromMtime, ageMs, known,
    alive: alive === true, dead: alive === false, unknown: !known,
  };
}

function shouldSteal(h, o) {
  if (typeof o.decide === 'function') {
    let d;
    try { d = o.decide(h); } catch (_) { d = 'respect'; }
    if (d === 'steal') return true;
    if (d === 'respect') return false;
  }
  const staleMs = Number.isFinite(o.staleMs) ? o.staleMs : DEFAULT_STALE_MS;
  const liveStaleMs = typeof o.liveStaleMs === 'number' ? o.liveStaleMs : Infinity;
  if (h.dead) return !!o.stealDead || h.ageMs > staleMs;
  if (h.alive) return h.ageMs > liveStaleMs;
  return h.ageMs > staleMs;
}

// publish(F, p, payload, mode) -> true | throws (EEXIST = held).
function publish(F, p, payload, mode) {
  if (mode === 'excl') {
    const fd = F.openSync(p, 'wx');
    try { F.writeSync(fd, payload); } finally { F.closeSync(fd); }
    return true;
  }
  const tmp = p + '.tmp-' + process.pid + '-' + rand();
  try {
    F.writeFileSync(tmp, payload);
    try {
      F.linkSync(tmp, p);
    } catch (linkErr) {
      if (linkErr && linkErr.code === 'EEXIST') throw linkErr; // held
      // Any other link error (EPERM/ENOTSUP/EXDEV/ENOSYS: a filesystem without
      // hard links) -> O_EXCL create for THIS attempt. The torn-read guard
      // (mtime) covers its create->write window.
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, payload); } finally { F.closeSync(fd); }
    }
    return true;
  } finally {
    try { F.unlinkSync(tmp); } catch (_) { /* ENOENT when never created */ }
  }
}

// reclaim(F, p, judgedToken, judgedRecordRaw) -> 'reclaimed' | 'gone' | 'caught'.
// Rename-aside, verify, discard; a caught fresh lock is restored (never
// clobbering one published meanwhile) and must be respected.
function reclaim(F, p, h) {
  const reap = p + '.reap-' + process.pid + '-' + rand();
  try { F.renameSync(p, reap); } catch (_) { return 'gone'; }
  let moved = null;
  let movedRaw = null;
  try { movedRaw = F.readFileSync(reap, 'utf8'); moved = parseRecord(movedRaw); } catch (_) { /* unreadable */ }
  const movedToken = moved && typeof moved.token !== 'undefined' ? moved.token : null;
  let same = movedToken === h.token;
  if (same && h.token === null) {
    // No token to compare (torn/legacy record): the moved file must also
    // still be the SAME non-fresh file we judged — a fresh publish carries a
    // token, and a torn file judged by mtime must still be that old.
    let mt = null;
    try { mt = F.statSync(reap).mtimeMs; } catch (_) { mt = null; }
    same = moved === null
      ? (h.tsFromMtime && mt !== null && mt === h.ts)
      : (moved.pid === (h.record && h.record.pid) && moved.ts === (h.record && h.record.ts));
  }
  if (!same) {
    let restored = false;
    try { F.linkSync(reap, p); restored = true; } catch (_) { /* EEXIST: a newer lock is already published; unsupported: fall through */ }
    if (restored) { try { F.unlinkSync(reap); } catch (_) {} }
    else {
      let exists = false;
      try { F.statSync(p); exists = true; } catch (_) { exists = false; }
      if (!exists) { try { F.renameSync(reap, p); } catch (_) {} } else { try { F.unlinkSync(reap); } catch (_) {} }
    }
    return 'caught';
  }
  try { F.unlinkSync(reap); } catch (_) { /* already gone */ }
  return 'reclaimed';
}

// acquire(lockPath, opts) -> handle | null.
// opts: fs, now, isAlive, staleMs, liveStaleMs, stealDead, decide(holder),
//   publish ('link'|'excl'), fields (extra record keys; undefined values are
//   omitted), maxTries (create attempts; default 2), waitMs (keep retrying a
//   respected holder this long; default 0), stepMs/jitterMs (sleep between
//   retries), sleep (injectable), throwOnError (rethrow a non-EEXIST fs error
//   instead of failing open to null), onRefused(holder).
// handle: { path, token, record, release(), refresh(fields) }.
function acquire(lockPath, opts) {
  const o = opts || {};
  const F = o.fs || fs;
  const now = o.now || Date.now;
  const mode = o.publish === 'excl' ? 'excl' : 'link';
  const maxTries = typeof o.maxTries === 'number' ? o.maxTries : 2;
  const waitMs = typeof o.waitMs === 'number' ? o.waitMs : 0;
  const stepMs = Number.isFinite(o.stepMs) ? o.stepMs : 5;
  const jitterMs = Number.isFinite(o.jitterMs) ? o.jitterMs : 0;
  const sleep = o.sleep || sleepSync;
  const deadline = Date.now() + waitMs;
  mkdirParent(F, lockPath);
  let lastHolder = null;
  for (let i = 0; i < maxTries; i++) {
    const ts = now();
    const token = newToken(ts);
    const record = Object.assign({ pid: process.pid, host: localHost(), ts, token }, o.fields || {});
    for (const k of Object.keys(record)) if (record[k] === undefined) delete record[k];
    try {
      publish(F, lockPath, JSON.stringify(record), mode);
      return makeHandle(F, lockPath, token, record, now);
    } catch (e) {
      if (!e || e.code !== 'EEXIST') {
        if (o.throwOnError) throw e;
        return null; // fail-open: no lock
      }
    }
    const h = inspect(lockPath, o);
    if (h === null) continue; // released between our create and the read — retry now
    lastHolder = h;
    if (shouldSteal(h, o)) {
      const r = reclaim(F, lockPath, h);
      if (r === 'caught') { refused(o, h); return null; }
      continue; // reclaimed (or already gone): retry the create immediately
    }
    if (Date.now() >= deadline || i + 1 >= maxTries) break;
    sleep(stepMs + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0));
  }
  if (lastHolder) refused(o, lastHolder);
  return null;
}

function refused(o, h) {
  if (typeof o.onRefused === 'function') { try { o.onRefused(h); } catch (_) {} }
}

function makeHandle(F, p, token, record, now) {
  const handle = { path: p, token, record, fs: F, now };
  handle.release = () => release(handle);
  handle.refresh = (fields) => refresh(handle, fields);
  return handle;
}

// release(handle) -> true iff OUR lock was removed. A lock whose on-disk token
// is no longer ours (reclaimed by someone else) or unreadable is left alone.
function release(handle) {
  if (!handle || !handle.path) return false;
  const F = handle.fs || fs;
  try {
    const cur = parseRecord(F.readFileSync(handle.path, 'utf8'));
    if (cur && cur.token === handle.token) { F.unlinkSync(handle.path); return true; }
  } catch (_) { /* gone / unreadable: not ours to remove */ }
  return false;
}

// refresh(handle, fields?) -> true | false | 'error'. Re-stamps `ts` (and any
// `fields`, e.g. a re-pointed pid) with an atomic tmp+rename while the lock is
// still ours. false = DEFINITIVE loss (file gone, or another token); 'error' =
// transient (unreadable/torn read, write failure) — not proof of loss.
function refresh(handle, fields) {
  if (!handle || !handle.path) return false;
  const F = handle.fs || fs;
  let raw;
  try { raw = F.readFileSync(handle.path, 'utf8'); }
  catch (e) { return (e && e.code === 'ENOENT') ? false : 'error'; }
  const cur = parseRecord(raw);
  if (!cur) return 'error';
  if (cur.token !== handle.token) return false;
  const next = Object.assign({}, cur, { ts: (handle.now || Date.now)() }, fields || {});
  next.token = handle.token;
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const tmp = handle.path + '.tmp-' + process.pid + '-' + rand();
  try {
    F.writeFileSync(tmp, JSON.stringify(next));
    F.renameSync(tmp, handle.path);
    handle.record = next;
    return true;
  } catch (_) {
    try { F.unlinkSync(tmp); } catch (_e) {}
    return 'error';
  }
}

const BUSY = Object.freeze({ ok: false, lockBusy: true });

// withLock(path, opts, fn) — run fn(handle) under the lock, releasing in
// finally. When the lock is not acquired, returns opts.onBusy(holder) if
// given, else { ok:false, lockBusy:true } — fn never runs unlocked. A sync
// fn that returns a Promise is refused (the lock would be released while the
// async work still runs): use withLockAsync.
function withLock(lockPath, opts, fn) {
  const o = opts || {};
  let holder = null;
  const h = acquire(lockPath, Object.assign({}, o, { onRefused(x) { holder = x; if (typeof o.onRefused === 'function') o.onRefused(x); } }));
  if (!h) return typeof o.onBusy === 'function' ? o.onBusy(holder) : BUSY;
  try {
    const out = fn(h);
    if (out && typeof out.then === 'function') {
      throw new Error('lock.withLock: the callback returned a Promise — use withLockAsync');
    }
    return out;
  } finally { release(h); }
}

async function withLockAsync(lockPath, opts, fn) {
  const o = opts || {};
  let holder = null;
  const h = acquire(lockPath, Object.assign({}, o, { onRefused(x) { holder = x; if (typeof o.onRefused === 'function') o.onRefused(x); } }));
  if (!h) return typeof o.onBusy === 'function' ? o.onBusy(holder) : BUSY;
  try { return await fn(h); } finally { release(h); }
}

module.exports = {
  acquire, release, refresh, inspect, withLock, withLockAsync,
  defaultIsAlive, sleepSync, DEFAULT_STALE_MS,
  _shouldSteal: shouldSteal,
};
