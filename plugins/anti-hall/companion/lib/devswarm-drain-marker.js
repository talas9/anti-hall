'use strict';
// anti-hall :: devswarm-drain-marker — a small, per-(home, primaryId) TTL'd
// marker file that lets a Primary declare "I am actively draining my mailbox
// THIS turn" so devswarm-parent-gate.js's Stop-hook block can downgrade to a
// non-blocking notice instead of forcing a redundant ack against a cursor a
// delegated subagent already has in flight.
//
// Fixes defect 13dedc334eb6 (P2): the parent gate had no concept of an
// in-flight drain and could not distinguish it from real neglect — it fired
// four consecutive forced acknowledgements plus one ESCALATION against a
// mailbox a delegated drain subagent was already reading, moments before the
// subagent returned the very message the gate was escalating over. The gate's
// pressure pushes toward spawning a SECOND reader against the same cursor,
// which is the action most likely to LOSE a message (a second reader can ack
// content the first has not yet reported back).
//
// WHERE THE WRITE PATH BELONGS (not wired here — scripts/devswarm.js owns
// that file and is being edited concurrently by another agent): the
// `inbox read-primary` / `read` verbs should call markDrainStart() at ENTRY
// (before the read/ack loop begins) and clearDrainMarker() at EXIT (in a
// `finally`, so a throw mid-drain still clears it rather than leaving a
// marker that silences the gate until its TTL expires). A crash between
// start and the `finally` is exactly what the TTL below is for — the marker
// self-expires and the gate resumes blocking rather than being silenced
// forever by a dead drain.
//
// TTL / STALENESS: a marker older than the configured TTL (default 10
// minutes; override via ANTIHALL_DEVSWARM_DRAIN_TTL_MS, ms not seconds) is
// STALE and MUST be ignored by readDrainMarker's caller — a crashed or
// abandoned drain can never silence the gate forever. clearStaleDrainMarker
// additionally deletes a stale marker file on read so it does not linger.
//
// IDENTITY MATCH: a marker is only "fresh for THIS session" when its
// recorded sessionId or pid matches the caller's own — a stale marker left by
// a DIFFERENT session (e.g. a prior Primary session that never cleaned up)
// must never silence a gate it does not actually correspond to. That
// comparison is the CALLER's job (devswarm-parent-gate.js); this module only
// exposes the raw marker plus a `stale` boolean so the caller can apply its
// own identity + freshness policy without this module guessing at it.
//
// Pure Node built-ins, cross-platform. Fail-soft on every fs error: a write
// failure never crashes the caller (worst case, the gate is not silenced this
// turn, which is the safe direction), and a read failure returns "no marker"
// (also safe — the gate is never WRONGLY silenced by an unreadable file).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { devswarmRoot, isSafeId } = require('./liveness.js');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ttlMs(env) -> ms. ANTIHALL_DEVSWARM_DRAIN_TTL_MS off the given env
// (process.env when omitted); absent / non-numeric / non-positive ->
// DEFAULT_TTL_MS. Number()-based (not parseInt) so a malformed value like
// "10min" is rejected wholesale rather than silently parsed as `10`
// milliseconds — matches liveness.js's dormantThresholdMs/idleThresholdMs
// precedent (P2-a there) for the same reason.
function ttlMs(env) {
  const src = env || process.env;
  const raw = src && src.ANTIHALL_DEVSWARM_DRAIN_TTL_MS;
  const n = Number(String(raw == null ? '' : raw).trim());
  return (Number.isFinite(n) && n > 0) ? n : DEFAULT_TTL_MS;
}

// drainMarkerPathFor(id, home) -> ~/.anti-hall/devswarm/drain/<id>.json.
// SAME isSafeId gate liveness.js's own livenessPathFor/heartbeatPathFor use
// (never path.join an unsafe id) — reused from liveness.js rather than
// reimplemented, per this repo's "one derivation, never three" convention.
function drainMarkerPathFor(id, home) {
  if (!isSafeId(id)) throw new Error('unsafe primary id: ' + JSON.stringify(id));
  return path.join(devswarmRoot(home), 'drain', String(id) + '.json');
}

// markDrainStart(home, id, opts) -> boolean (true on a successful write).
// Writes { startedAt, sessionId, pid, count }. `opts.sessionId` /
// `opts.count` are optional (default null / 0); `opts.pid` defaults to
// `process.pid`. `opts.now` (ms) defaults to Date.now() — override for tests.
// Atomic tmp+rename write, same idiom as liveness.js's writeVerdict. Fail-soft:
// any fs error (unsafe id, unwritable dir, ENOSPC, ...) is swallowed and
// returns false — a failed write simply means the gate is not silenced this
// turn, the safe direction.
function markDrainStart(home, id, opts) {
  const o = opts || {};
  const fsi = o.fs || fs;
  let p;
  try {
    p = drainMarkerPathFor(id, home || os.homedir());
  } catch (_) { return false; }
  const marker = {
    startedAt: Number.isFinite(o.now) ? o.now : Date.now(),
    sessionId: o.sessionId != null ? String(o.sessionId) : null,
    pid: Number.isFinite(o.pid) ? o.pid : process.pid,
    count: Number.isFinite(o.count) ? o.count : 0,
  };
  try {
    fsi.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.' + Date.now() + '.tmp';
    fsi.writeFileSync(tmp, JSON.stringify(marker));
    fsi.renameSync(tmp, p);
    return true;
  } catch (_) {
    return false;
  }
}

// readDrainMarker(home, id, opts) -> { startedAt, sessionId, pid, count,
//   stale } | null.
//   - null: no marker file, or it is unreadable/unparseable/malformed
//     (missing/non-finite startedAt) — "no marker" is always the fail-soft
//     answer, never a fabricated one.
//   - { ..., stale: false }: a marker exists and is within the TTL window
//     (relative to `opts.now`, default Date.now()).
//   - { ..., stale: true }: a marker exists but is older than the TTL — the
//     caller MUST treat this as "no marker" for gating purposes; this
//     function does NOT delete it (see clearStaleDrainMarker for that).
// `opts`: { now, fs, ttlMs, env } — `ttlMs` overrides ttlMs(env) directly
// when finite (test hook); otherwise derived from `opts.env` /
// process.env via ttlMs() above.
function readDrainMarker(home, id, opts) {
  const o = opts || {};
  const fsi = o.fs || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const ttl = Number.isFinite(o.ttlMs) ? o.ttlMs : ttlMs(o.env);
  let p;
  try {
    p = drainMarkerPathFor(id, home || os.homedir());
  } catch (_) { return null; }
  let marker;
  try {
    marker = JSON.parse(fsi.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
  if (!marker || typeof marker !== 'object' || !Number.isFinite(marker.startedAt)) return null;
  const age = now - marker.startedAt;
  // A future startedAt (clock skew / forged marker) is never treated as
  // fresher-than-now — mirrors liveness.js's isFreshBeat P1-7 posture: an
  // out-of-range timestamp in EITHER direction is not trustworthy proof.
  const stale = !(age >= 0 && age <= ttl);
  return {
    startedAt: marker.startedAt,
    sessionId: marker.sessionId != null ? String(marker.sessionId) : null,
    pid: Number.isFinite(marker.pid) ? marker.pid : null,
    count: Number.isFinite(marker.count) ? marker.count : 0,
    stale,
  };
}

// clearDrainMarker(home, id, opts) -> boolean (true on a successful unlink,
// or when no marker file existed to begin with — both count as "cleared").
// Fail-soft: any other fs error (EACCES, ...) returns false without throwing.
function clearDrainMarker(home, id, opts) {
  const o = opts || {};
  const fsi = o.fs || fs;
  let p;
  try {
    p = drainMarkerPathFor(id, home || os.homedir());
  } catch (_) { return false; }
  try {
    fsi.unlinkSync(p);
    return true;
  } catch (e) {
    return !!(e && e.code === 'ENOENT'); // already absent -> already "cleared"
  }
}

// clearStaleDrainMarker(home, id, opts) -> boolean. Convenience for a reader
// that wants to actively tidy up a stale marker it just observed (rather than
// merely ignoring it) — equivalent to `readDrainMarker` followed by
// `clearDrainMarker` when the result is stale. Returns false when there was
// no marker, or the marker was not stale (nothing cleared).
function clearStaleDrainMarker(home, id, opts) {
  const marker = readDrainMarker(home, id, opts);
  if (!marker || !marker.stale) return false;
  return clearDrainMarker(home, id, opts);
}

module.exports = {
  DEFAULT_TTL_MS,
  ttlMs,
  drainMarkerPathFor,
  markDrainStart,
  readDrainMarker,
  clearDrainMarker,
  clearStaleDrainMarker,
};
