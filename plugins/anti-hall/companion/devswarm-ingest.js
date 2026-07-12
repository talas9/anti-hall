#!/usr/bin/env node
'use strict';
// anti-hall :: devswarm-ingest — ONE supervised Node daemon that wraps
// `hivecontrol workspace monitor` and folds the messages it drains into the
// store (companion/lib/devswarm-store.js). Replaces the ad-hoc shell inbox
// daemon; restart-on-crash friendly (a launchd/systemd unit re-execs it).
//
// SINGLE-NATIVE-CONSUMER INVARIANT (PLAN.md Phase 2, Fable P1-5). Two concurrent
// `monitor` consumers SPLIT the destructive native queue between them — each
// call drains what the other never saw, silently losing messages. So this daemon
// takes an O_EXCL lock and REFUSES to start when another monitor consumer already
// holds it. The lock is the mechanical enforcement of the invariant, not just a
// doc note. `hivecontrol workspace monitor` is the ONE allowed native consumer
// while this runs (command-guard blocks interactive `monitor`/`read-messages`).
//
// IDEMPOTENT via a per-message dedupe hash: the native queue buffers until the
// next monitor call, and a crash-then-restart can re-observe an in-flight batch,
// so every message is content-hashed and appendMessage OR-IGNOREs a duplicate —
// safe replay / catch-up.
//
// LAYERING: this is a WRITE-side producer only. Hooks never touch it; they read
// the derived summary.json the store writes. deriveSummary is re-run after each
// ingested batch so the projection stays fresh.
//
// Pure Node built-ins. The monitor child spawn + the loop clock are injectable so
// the unit tests exercise ingest/lock/normalize WITHOUT spawning real hivecontrol.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const store = require('./lib/devswarm-store.js');
const { devswarmRoot } = require('./lib/liveness.js');

const INGEST_LOCK_STALE_MS = 15 * 60 * 1000; // a monitor consumer is long-lived; only a truly dead/old holder is stolen
const DEFAULT_MONITOR_INTERVAL_SEC = 3;      // hivecontrol monitor default poll
const DEFAULT_RESTART_BACKOFF_MS = 2000;     // gap before re-spawning after a monitor exit/crash

function ingestLockPath(home) {
  return path.join(devswarmRoot(home), 'locks', 'ingest.lock');
}

function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// acquireIngestLock(home, io) -> release() | null. null => another monitor
// consumer holds the lock; the daemon MUST refuse to start (single-consumer
// invariant). The returned release() carries a `.heartbeat()` the live daemon
// calls each loop to REFRESH its own lock timestamp, so a healthy long-lived
// consumer is never seen as stale (and thus never stolen).
//
// STEAL RULE (data-loss guard): a lock is stolen ONLY when it is BOTH stale AND
// not held by a live process — i.e. the holder is DEAD or UNKNOWN. A KNOWN-LIVE
// holder is NEVER stolen even if its timestamp looks old, because stealing from a
// live `hivecontrol workspace monitor` consumer would split the destructive
// native queue between two daemons and silently lose messages. Requiring BOTH
// conditions (never one alone) is the fix for the "stale-steals-a-live-daemon" bug.
function acquireIngestLock(home, io) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const now = (io && io.now) || Date.now;
  const p = ingestLockPath(home);
  try { F.mkdirSync(path.dirname(p), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(p, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      const release = function release() {
        try { const cur = JSON.parse(F.readFileSync(p, 'utf8')); if (cur && cur.token === token) F.unlinkSync(p); } catch (_) {}
      };
      // heartbeat(atMs?) — refresh OUR lock's ts (atomic tmp+rename) so a healthy
      // long-lived daemon stays fresh and is never mistaken for a stale holder.
      // No-op (and never clobbers) if the lock was reclaimed by someone else
      // (token mismatch) or is gone. Returns true iff we refreshed our own lock.
      release.heartbeat = function heartbeat(atMs) {
        try {
          const cur = JSON.parse(F.readFileSync(p, 'utf8'));
          if (cur && cur.token === token) {
            const nts = Number.isFinite(atMs) ? atMs : now();
            const tmp = p + '.hb.' + process.pid;
            F.writeFileSync(tmp, JSON.stringify({ pid: cur.pid, ts: nts, token }));
            F.renameSync(tmp, p);
            return true;
          }
        } catch (_) {}
        return false;
      };
      return release;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(p, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      let holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      if (holderTs === null) {
        // TORN-READ GUARD: a live holder is briefly a 0-byte file between openSync('wx')
        // and writeSync. A concurrent reader that catches it empty/unparseable must NOT
        // treat it as absent — fall back to the file's MTIME for liveness. A FRESH mtime =
        // live holder mid-write -> back off (never steal); only an OLD mtime (or a stat
        // failure) reads as a dead holder we may reclaim. Mirrors devswarm-store acquireOnce.
        try { holderTs = F.statSync(p).mtimeMs; } catch (_) { holderTs = null; }
      }
      const alive = holderPid !== null && isAlive(holderPid); // a KNOWN-live holder
      const stale = holderTs === null || (now() - holderTs) > INGEST_LOCK_STALE_MS;
      // Steal ONLY a stale lock whose holder is NOT alive (dead or unknown pid).
      // Never steal from a live holder, however old its timestamp looks.
      if (stale && !alive) { try { F.unlinkSync(p); } catch (_) {} continue; }
      return null; // live holder, or a fresh lock -> refuse
    }
  }
  return null;
}

// messageHash(workspaceId, msg) — stable dedupe hash from the message's
// identifying fields, falling back to a canonical JSON of the whole object when a
// createdAt is absent. Two genuinely-distinct messages hash differently; a
// re-observed identical message hashes the same and is OR-IGNOREd on append.
function messageHash(workspaceId, msg) {
  const m = msg && typeof msg === 'object' ? msg : { value: msg };
  const keyed = [
    String(workspaceId),
    m.fromBranch != null ? String(m.fromBranch) : '',
    m.toBranch != null ? String(m.toBranch) : '',
    m.message != null ? String(m.message) : '',
    m.status != null ? String(m.status) : '',
    m.createdAt != null ? String(m.createdAt) : '',
  ].join('\x00');
  // When there is no createdAt to disambiguate, fold in a canonical JSON of the
  // full object so two same-text messages that DO differ elsewhere stay distinct.
  const suffix = (m.createdAt == null) ? ('\x00' + stableJson(m)) : '';
  return 'native:' + crypto.createHash('sha256').update(keyed + suffix).digest('hex');
}

// stableJson — key-sorted JSON so the hash is stable regardless of key order.
function stableJson(obj) {
  try {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(stableJson).join(',') + ']';
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(obj[k])).join(',') + '}';
  } catch (_) { return '""'; }
}

// normalizeMonitorPayload(raw) -> message object[]. hivecontrol emits JSON by
// default (no --json flag). The exact monitor batch SHAPE is not pinned in the
// KB, so parse tolerantly: accept a JSON string OR an already-parsed value, and
// unwrap the plausible shapes — an array, `{ messages: [...] }`, `{ data: [...] }`,
// or a single message object. Anything unparseable -> [] (fail-soft; a bad batch
// never crashes the loop).
function normalizeMonitorPayload(raw) {
  let val = raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return [];
    try { val = JSON.parse(t); } catch (_) { return []; }
  }
  if (Array.isArray(val)) return val.filter((x) => x && typeof x === 'object');
  if (val && typeof val === 'object') {
    if (Array.isArray(val.messages)) return val.messages.filter((x) => x && typeof x === 'object');
    if (Array.isArray(val.data)) return val.data.filter((x) => x && typeof x === 'object');
    // A single message object (has any of the known message fields).
    if ('message' in val || 'fromBranch' in val || 'toBranch' in val) return [val];
  }
  return [];
}

// ingestPayload(s, raw, opts) -> { total, inserted, duplicate }. Normalizes a
// monitor batch and appends each message to the store keyed by the ingesting
// workspace id, deduped by content hash. Re-ingesting the same batch inserts 0
// (replay idempotence).
function ingestPayload(s, raw, opts) {
  const o = opts || {};
  const workspaceId = String(o.workspaceId);
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const messages = normalizeMonitorPayload(raw);
  let inserted = 0;
  let duplicate = 0;
  for (const m of messages) {
    const r = s.appendMessage({
      workspaceId,
      body: (m && m.message != null) ? String(m.message) : stableJson(m),
      hash: messageHash(workspaceId, m),
      ts: (m && Number.isFinite(Date.parse(m.createdAt))) ? Date.parse(m.createdAt) : now,
    });
    if (r && r.inserted) inserted++; else duplicate++;
  }
  return { total: messages.length, inserted, duplicate };
}

// defaultMonitorRun({ hivecontrol, intervalSec, timeoutSec }) -> { ok, raw, error }.
// Runs ONE `hivecontrol workspace monitor` invocation (it long-polls, then exits
// when messages arrive or the timeout elapses) and returns its raw stdout. A
// timeout is normal (no messages this window) -> ok:true, raw:'' . Injectable via
// opts.run so tests never spawn a real binary.
function defaultMonitorRun(opts) {
  const o = opts || {};
  const bin = o.hivecontrol || 'hivecontrol';
  const args = ['workspace', 'monitor'];
  if (Number.isFinite(o.intervalSec)) { args.push('-i', String(o.intervalSec)); }
  if (Number.isFinite(o.timeoutSec)) { args.push('-t', String(o.timeoutSec)); }
  try {
    const r = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout: Number.isFinite(o.hardTimeoutMs) ? o.hardTimeoutMs : undefined,
    });
    if (r.error) return { ok: false, raw: '', error: String(r.error.message || r.error) };
    return { ok: true, raw: String(r.stdout || ''), error: null };
  } catch (e) {
    return { ok: false, raw: '', error: String(e && e.message || e) };
  }
}

// runIngestLoop(opts) -> summary. The supervised daemon body. Acquires the
// single-consumer lock (refuses if held), opens the store, then loops:
//   monitor once -> ingest -> deriveSummary -> (on child exit/crash) backoff and
//   re-spawn. Bounded by opts.maxIterations for tests; unbounded (Infinity) as a
//   real daemon. opts.run is the injectable monitor runner; opts.sleep the clock.
function runIngestLoop(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const workspaceId = o.workspaceId || o.env && o.env.DEVSWARM_BUILDER_ID || 'primary';
  const run = o.run || defaultMonitorRun;
  const sleep = o.sleep || sleepSync;
  const maxIterations = Number.isFinite(o.maxIterations) ? o.maxIterations : Infinity;
  const backoffMs = Number.isFinite(o.restartBackoffMs) ? o.restartBackoffMs : DEFAULT_RESTART_BACKOFF_MS;
  const intervalSec = Number.isFinite(o.intervalSec) ? o.intervalSec : DEFAULT_MONITOR_INTERVAL_SEC;

  const release = (o.io && o.io.lock) ? o.io.lock(home) : acquireIngestLock(home, o.io);
  if (!release) {
    return { ok: false, started: false, reason: 'another monitor consumer is already running (ingest lock held)' };
  }

  const openStore = (o.io && o.io.openStore) || store.openStore;
  const s = openStore({ home, backend: o.backend, env: o.env, fsi: (o.io && o.io.storeFs) });
  const stats = { iterations: 0, inserted: 0, duplicate: 0, errors: 0 };
  try {
    for (let i = 0; i < maxIterations; i++) {
      if (o.shouldStop && o.shouldStop()) break;
      // Heartbeat our lock each iteration so this live, long-lived consumer keeps
      // its timestamp fresh and can never be mistaken for a stale holder + stolen.
      if (release && typeof release.heartbeat === 'function') {
        try { release.heartbeat(o.now); } catch (_) {}
      }
      const res = run({
        hivecontrol: o.hivecontrol, intervalSec,
        timeoutSec: o.timeoutSec, hardTimeoutMs: o.hardTimeoutMs,
      });
      stats.iterations++;
      if (!res.ok) {
        stats.errors++;
        if (i + 1 < maxIterations) sleep(backoffMs); // crash -> backoff then re-spawn
        continue;
      }
      let ing;
      try {
        ing = ingestPayload(s, res.raw, { workspaceId, now: o.now });
      } catch (e) {
        // STORE-LOCK FAIL-CLOSED errors must not CRASH-LOOP the daemon. appendMessage
        // fails closed on ELOCKFS (a genuine fs/EPERM error on the messages lock) and
        // ELOCKUNAVAIL (contention budget exhausted) — correct, but if that throw
        // propagates out of the loop the daemon exits and is re-exec'd every RESTART_SEC,
        // hammering the same wedged lock. The native queue BUFFERS until the next monitor
        // poll and replay is idempotent by hash, so on these two known-retryable lock
        // signals we LOG and CONTINUE to the next poll instead of crashing. Any OTHER
        // error still propagates (fail-open is only for the lock signals, not arbitrary bugs).
        if (e && (e.code === 'ELOCKFS' || e.code === 'ELOCKUNAVAIL')) {
          stats.errors++;
          try { fs.writeSync(2, 'devswarm-ingest: store lock ' + e.code + ' — skipping this batch, replaying next poll (idempotent by hash)\n'); } catch (_) {}
          if (i + 1 < maxIterations) sleep(backoffMs);
          continue;
        }
        throw e;
      }
      stats.inserted += ing.inserted;
      stats.duplicate += ing.duplicate;
      if (ing.inserted > 0) store.deriveSummary(s, { home, env: o.env, now: o.now });
    }
  } finally {
    try { s.close(); } catch (_) {}
    try { release(); } catch (_) {}
  }
  return { ok: true, started: true, workspaceId, stats };
}

function sleepSync(ms) {
  try { const sab = new Int32Array(new SharedArrayBuffer(4)); Atomics.wait(sab, 0, 0, Math.max(0, ms | 0)); } catch (_) {}
}

function main() {
  // A real invocation runs unbounded until killed (launchd/systemd re-execs it on
  // exit). workspaceId is the ingesting workspace's own id (DEVSWARM_BUILDER_ID),
  // defaulting to 'primary' outside a workspace.
  const summary = runIngestLoop({ env: process.env });
  if (!summary.started) {
    fs.writeSync(2, JSON.stringify(summary) + '\n');
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  ingestLockPath, acquireIngestLock,
  messageHash, stableJson, normalizeMonitorPayload,
  ingestPayload, defaultMonitorRun, runIngestLoop,
};
