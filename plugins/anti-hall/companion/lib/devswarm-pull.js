'use strict';
// anti-hall :: devswarm-pull — the CHILD-SIDE reception drain (v0.54.2). A
// bounded, guard-safe, one-shot CLI pull that folds a child workspace's NATIVE
// parent->child message queue into its OWN durable descriptor inbox (the NDJSON
// `devswarm-child-turn` surfaces + the store parity feed `inbox read/ack` walks).
//
// WHY A SEPARATE PATH FROM THE INGEST DAEMON. The ingest daemon (companion/
// devswarm-ingest.js) wraps `hivecontrol workspace monitor` — a blocking,
// no-timeout long-poll — as the ONE supervised native consumer. A headless child
// sub-orchestrator cannot host a blocking daemon on its turn thread, and
// `monitor` is exactly the destructive read command-guard blocks. So reception is
// a PULL, not a push: each child turn nudges the child to run this one-shot drain,
// which:
//   1. Takes a PER-ID O_EXCL lock (a child never drains its own queue twice
//      concurrently — that would SPLIT the destructive native queue and lose
//      messages, the same single-consumer invariant the ingest lock enforces).
//   2. Runs the NON-DESTRUCTIVE `hivecontrol workspace message-count` FIRST.
//      count===0 -> return WITHOUT ever touching read-messages (the count-gate
//      minimizes the destructive-read crash-window: we only mark-read when there
//      is actually something to drain).
//   3. On count>0, ONE BOUNDED `hivecontrol workspace read-messages` with a finite
//      timeout — NEVER `monitor`. read-messages marks-read (destructive), so it is
//      called at most once per pull and only when the count-gate says there is work.
//   4. Appends the drained batch to the durable inbox NDJSON in ONE atomic
//      appendFileSync, idempotent by embedded content hash (a re-observed message
//      is skipped, so a crash-then-retry never duplicates a line).
//
// CRASH-WINDOW (honest residual limitation). `read-messages` marks the native
// messages read BEFORE this process durably persists them. If the process dies in
// the window between the native mark-read and the `appendFileSync`, those messages
// are lost from the native side without landing in the durable inbox. The
// count-gate MINIMIZES the window (no read-messages when count===0) but cannot
// close it — hivecontrol exposes no non-destructive full read. Documented, not
// hidden.
//
// Pure Node built-ins. Every spawn is injectable via io.run so unit tests exercise
// the count-gate / drain / idempotence / lock WITHOUT spawning a real binary; io.fs
// is injectable so the crash-window ordering is testable (a throwing appendFileSync
// must surface ok:false, never a false success).

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { isSafeId, devswarmRoot } = require('./liveness.js');
// REUSE the ingest primitives verbatim (do NOT reimplement) so the child-side
// drain hashes/normalizes messages IDENTICALLY to the daemon path — a message
// hashed one way here and another way there would break cross-path dedupe.
const {
  normalizeMonitorPayload, messageHash, ingestPayload,
} = require('../devswarm-ingest.js');
const store = require('./devswarm-store.js');

const PULL_LOCK_STALE_MS = 60 * 1000;   // a one-shot pull is short-lived; a lock older than this from a dead/unknown holder is stealable
const READ_TIMEOUT_MS = 10 * 1000;      // the ONE bounded read-messages spawn — finite, never a blocking monitor

// pullLockPath(home, id) — PER-ID lock so disjoint workspaces never block each
// other; only two drains of the SAME queue are mutually exclusive.
function pullLockPath(home, id) {
  return path.join(devswarmRoot(home), 'locks', 'pull-' + id + '.lock');
}
function inboxDefaultPath(home, id) { return path.join(devswarmRoot(home), 'inbox', id + '.ndjson'); }
function cursorDefaultPath(home, id) { return path.join(devswarmRoot(home), 'cursors', id + '.cursor'); }

function isAliveDefault(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return !!(e && e.code === 'EPERM'); }
}

// acquireExclLock(lockPath, io, staleMs) -> release() | null. The same acquire/steal
// discipline as devswarm-ingest.acquireIngestLock, factored small for the one-shot
// pull (no heartbeat needed — a pull is short-lived). null => another pull holds the
// lock; the caller MUST refuse (single-consumer invariant). STEAL RULE: a lock is
// stolen ONLY when it is BOTH stale AND not held by a live process (dead or unknown
// pid). A KNOWN-LIVE holder is NEVER stolen however old its timestamp looks.
function acquireExclLock(lockPath, io, staleMs) {
  const F = (io && io.fs) || fs;
  const isAlive = (io && io.isAlive) || isAliveDefault;
  const now = (io && io.now) || Date.now;
  const stale = Number.isFinite(staleMs) ? staleMs : PULL_LOCK_STALE_MS;
  try { F.mkdirSync(path.dirname(lockPath), { recursive: true }); } catch (_) {}
  for (let attempt = 0; attempt < 2; attempt++) {
    const ts = now();
    const token = process.pid + ':' + ts + ':' + Math.random().toString(36).slice(2);
    try {
      const fd = F.openSync(lockPath, 'wx');
      try { F.writeSync(fd, JSON.stringify({ pid: process.pid, ts, token })); } finally { F.closeSync(fd); }
      return function release() {
        try { const cur = JSON.parse(F.readFileSync(lockPath, 'utf8')); if (cur && cur.token === token) F.unlinkSync(lockPath); } catch (_) {}
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return null;
      let holder = null;
      try { holder = JSON.parse(F.readFileSync(lockPath, 'utf8')); } catch (_) {}
      const holderPid = holder && Number.isFinite(holder.pid) ? holder.pid : null;
      let holderTs = holder && Number.isFinite(holder.ts) ? holder.ts : null;
      if (holderTs === null) {
        // TORN-READ GUARD: a live holder is briefly a 0-byte file between openSync('wx')
        // and writeSync. A concurrent reader that catches it empty/unparseable must NOT
        // treat it as absent — fall back to the file's MTIME for liveness. A FRESH mtime =
        // live pull mid-write -> back off (never steal); only an OLD mtime (or a stat
        // failure) reads as a dead holder we may reclaim. Mirrors devswarm-store acquireOnce.
        try { holderTs = F.statSync(lockPath).mtimeMs; } catch (_) { holderTs = null; }
      }
      const alive = holderPid !== null && isAlive(holderPid);
      const isStale = holderTs === null || (now() - holderTs) > stale;
      if (isStale && !alive) { try { F.unlinkSync(lockPath); } catch (_) {} continue; }
      return null; // live holder, or a fresh lock -> refuse
    }
  }
  return null;
}

// defaultRun(spec) -> { ok, raw, error }. ONE injectable hivecontrol spawn (mirrors
// ingest.defaultMonitorRun). spec: { args, timeout, env, hivecontrol }. Carries a
// finite `timeout` so a hung read-messages can never wedge the child's turn.
function defaultRun(spec) {
  const o = spec || {};
  const bin = o.hivecontrol || 'hivecontrol';
  const args = Array.isArray(o.args) ? o.args : [];
  try {
    const opts = { encoding: 'utf8' };
    if (Number.isFinite(o.timeout)) opts.timeout = o.timeout;
    if (o.env && typeof o.env === 'object') opts.env = o.env;
    const r = spawnSync(bin, args, opts);
    if (r.error) return { ok: false, raw: '', error: String(r.error.message || r.error) };
    return { ok: true, raw: String(r.stdout || ''), error: null };
  } catch (e) {
    return { ok: false, raw: '', error: String(e && e.message || e) };
  }
}

// parseCount(raw) -> int (>=0). Tolerant parse of `message-count` stdout — the exact
// shape is not pinned in the KB, so accept a bare number, a JSON object with a known
// count key, or the first integer in a plain string. Unparseable -> 0 (fail-soft: a
// count we cannot read is treated as "nothing to drain", so we never blindly fire the
// destructive read-messages on an unknown count).
function parseCount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
  if (raw == null) return 0;
  const t = String(raw).trim();
  if (t === '') return 0;
  try {
    const v = JSON.parse(t);
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
    if (v && typeof v === 'object') {
      for (const k of ['count', 'unread', 'unreadCount', 'messages', 'total', 'pending']) {
        if (Number.isFinite(v[k])) return Math.max(0, Math.floor(v[k]));
      }
    }
  } catch (_) {}
  const m = t.match(/-?\d+/);
  if (m) { const n = parseInt(m[0], 10); return Number.isFinite(n) ? Math.max(0, n) : 0; }
  return 0;
}

// collectExistingHashes(F, inboxPath) -> Set<string>. Read the durable inbox ONCE and
// gather every embedded `_h` so the append is idempotent: a re-observed message (same
// content hash) is skipped rather than duplicated. Absent/unreadable inbox -> empty set.
function collectExistingHashes(F, inboxPath) {
  const seen = new Set();
  let existing;
  try { existing = String(F.readFileSync(inboxPath, 'utf8')); } catch (_) { return seen; }
  for (const line of existing.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (o && o._h != null) seen.add(String(o._h)); } catch (_) { /* skip torn line */ }
  }
  return seen;
}

// pullOnce({ home, id, env, backend, now, io }) -> { ok, locked, imported, duplicate, nativeCount, error? }.
// One bounded, guard-safe drain of the child's native queue into its durable inbox.
// The caller GUARANTEES the descriptor (workspaces/<id>.json with inboxPath) exists.
// Fail-soft on any error: no durable corruption, no partial NDJSON, lock always released.
function pullOnce(opts) {
  const o = opts || {};
  const home = o.home || os.homedir();
  const id = o.id;
  const env = o.env || process.env;
  const backend = o.backend;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const io = o.io || {};
  const F = io.fs || fs;
  const run = io.run || defaultRun;

  if (!isSafeId(id)) return { ok: false, locked: false, error: 'invalid or missing workspace id' };

  const release = acquireExclLock(pullLockPath(home, id), io, PULL_LOCK_STALE_MS);
  if (!release) return { ok: false, locked: false, error: 'another pull holds the lock' };

  try {
    // Descriptor -> inboxPath (caller guarantees it exists).
    const descPath = path.join(devswarmRoot(home), 'workspaces', id + '.json');
    let desc;
    try { desc = JSON.parse(F.readFileSync(descPath, 'utf8')); } catch (_) {
      return { ok: false, locked: true, error: 'no descriptor for workspace ' + JSON.stringify(id) };
    }
    if (!desc || typeof desc !== 'object' || !desc.inboxPath) {
      return { ok: false, locked: true, error: 'descriptor for ' + JSON.stringify(id) + ' has no inboxPath' };
    }
    const inboxPath = desc.inboxPath;

    // NON-DESTRUCTIVE count-gate. count===0 -> never touch read-messages.
    const cRes = run({ args: ['workspace', 'message-count'], env });
    if (!cRes || !cRes.ok) {
      return { ok: false, locked: true, error: (cRes && cRes.error) || 'message-count failed' };
    }
    const nativeCount = parseCount(cRes.raw);
    if (!(nativeCount > 0)) {
      return { ok: true, locked: true, imported: 0, duplicate: 0, nativeCount: 0 };
    }

    // count>0 -> ONE bounded read-messages (finite timeout, NEVER monitor).
    const rRes = run({ args: ['workspace', 'read-messages'], timeout: READ_TIMEOUT_MS, env });
    if (!rRes || !rRes.ok) {
      return { ok: false, locked: true, error: (rRes && rRes.error) || 'read-messages failed' };
    }

    const messages = normalizeMonitorPayload(rRes.raw);
    const seen = collectExistingHashes(F, inboxPath);
    let imported = 0;
    let duplicate = 0;
    const batch = [];
    for (const m of messages) {
      const h = messageHash(id, m);
      if (seen.has(h)) { duplicate++; continue; }
      seen.add(h); // also de-dupe WITHIN the batch
      batch.push(JSON.stringify({
        _h: h,
        fromBranch: (m && m.fromBranch != null) ? m.fromBranch : null,
        message: (m && m.message != null) ? m.message : null,
        createdAt: (m && m.createdAt != null) ? m.createdAt : null,
        status: (m && m.status != null) ? m.status : null,
      }) + '\n');
      imported++;
    }

    // DURABLE append precedes ok:true (crash-window ordering). ONE appendFileSync of
    // the whole batch — a throw here propagates to the catch below as ok:false, never
    // a false success. Skip the syscall entirely when there is nothing new.
    if (batch.length > 0) {
      F.mkdirSync(path.dirname(inboxPath), { recursive: true });
      F.appendFileSync(inboxPath, batch.join(''));
    }

    // Store parity feed (do NOT touch the store cursor). Best-effort: the durable
    // NDJSON above is the source of truth `inbox read/ack` and the child-turn hook
    // consume; the store projection is a secondary read model. Dedupe is by the SAME
    // messageHash, so a re-ingest OR-IGNOREs — idempotent across both layers.
    try {
      // PER-PROJECT: the child's own workspaceId selects its physical store.
      const s = store.openStore({ home, workspaceId: id, backend, env });
      try {
        ingestPayload(s, rRes.raw, { workspaceId: id, now });
        store.deriveSummary(s, { home, workspaceId: id, env, now });
      } finally { s.close(); }
    } catch (_) { /* durable inbox already persisted; store parity is best-effort */ }

    // RECONCILIATION — make the destructive-read silent-loss OBSERVABLE. The KB pins
    // `message-count` and `read-messages` to the SAME native metric: message-count is
    // the UNREAD count (non-destructive), read-messages reads THOSE unread messages and
    // marks them read (destructive) — so the count gates a destructive drain whose batch
    // SHOULD contain exactly that many messages. If we recovered FEWER than the count
    // said (imported+duplicate < nativeCount), the shortfall was marked-read natively but
    // never landed in the durable inbox — genuine loss (e.g. normalizeMonitorPayload
    // returned [] on an unhandled read-messages shape). Because they are the same metric,
    // fail ok:false to force attention; a NEW message arriving between the two calls can
    // only make read-messages return MORE (never fewer), so a shortfall is never a benign
    // count-vs-read race — it is always real loss. Surface a loud `lost` field AND a
    // best-effort telemetry line (never throws) so the loss is never silent.
    const recovered = imported + duplicate;
    if (recovered < nativeCount) {
      const lost = nativeCount - recovered;
      try {
        F.writeSync(2, 'devswarm-pull: reception shortfall for ' + JSON.stringify(id)
          + ' — message-count=' + nativeCount + ' recovered=' + recovered + ' lost=' + lost
          + ' (marked-read natively but not persisted; likely an unhandled read-messages shape)\n');
      } catch (_) { /* telemetry is best-effort; a failed log must never break the drain */ }
      return { ok: false, locked: true, imported, duplicate, nativeCount, lost };
    }

    return { ok: true, locked: true, imported, duplicate, nativeCount };
  } catch (e) {
    return { ok: false, locked: true, error: String(e && e.message || e) };
  } finally {
    try { release(); } catch (_) {}
  }
}

module.exports = {
  PULL_LOCK_STALE_MS, READ_TIMEOUT_MS,
  pullLockPath, inboxDefaultPath, cursorDefaultPath,
  acquireExclLock, defaultRun, parseCount, collectExistingHashes,
  pullOnce,
};
