'use strict';
// anti-hall :: devswarm-freshness — the "is this workspace actually idle"
// signal. Consumed ONLY by devswarm-parent-inbox.js today, for the live
// status table's idle/active label (readHeartbeat/lastActivityTs feed the
// per-workspace idle line; idleThresholdMs gates the table's own
// idle-beyond-threshold display logic).
//
// devswarm-parent-gate.js (the Stop-hook neglect gate) does NOT consume this
// module — a freshness/age-based exclusion was tried there and rejected on
// review (a ghost workspace's unread is actually FRESH poke traffic, so
// freshness never excluded it, and freshness also risked suppressing a
// genuinely fresh unread on an idle-but-alive child; see the isNoiseText
// require's comment in that file). The gate's ghost-workspace fix instead
// classifies unread CONTENT via companion/lib/devswarm-noise.js.
//
// Read-only fs. Never spawns git. Never throws (every function here is a pure
// computation over already-parsed objects, or a fail-open fs read).

const fs = require('fs');
const path = require('path');
const { devswarmRoot } = require('../../companion/lib/liveness.js');
const { readUnreadMessages } = require('../../companion/lib/devswarm-inbox-cursor.js');

// How long a workspace may sit with no fresh activity signal (lastActivityTs)
// before it is considered idle. 6 hours is a defensible default: long enough
// that a normal lull between turns/sessions never false-positives, short
// enough that a workspace idle since yesterday reads as idle today. Override
// via ANTIHALL_DEVSWARM_IDLE_MS (ms, not seconds).
const DEFAULT_IDLE_MS = 6 * 60 * 60 * 1000;

// idleThresholdMs(env) -> ms. Reads ANTIHALL_DEVSWARM_IDLE_MS off the given env
// (defaults to process.env when omitted); absent, non-numeric, or non-positive
// -> DEFAULT_IDLE_MS. Never throws.
function idleThresholdMs(env) {
  const src = env || process.env;
  const raw = src && src.ANTIHALL_DEVSWARM_IDLE_MS;
  const n = parseInt(raw, 10);
  return (Number.isFinite(n) && n > 0) ? n : DEFAULT_IDLE_MS;
}

// heartbeatPathFor(home, id) -> the turn-authored per-workspace heartbeat file
// (heartbeats/<id>.json), carrying progress_pct + ts.
function heartbeatPathFor(home, id) {
  return path.join(devswarmRoot(home), 'heartbeats', String(id) + '.json');
}

// readHeartbeat(home, id) -> parsed heartbeat | null. Read-only fs; tolerant of
// a missing / malformed file (fail toward "no heartbeat").
function readHeartbeat(home, id) {
  try {
    const b = JSON.parse(fs.readFileSync(heartbeatPathFor(home, id), 'utf8'));
    return b && typeof b === 'object' ? b : null;
  } catch (_) {
    return null;
  }
}

// lastActivityTs(verdict, heartbeat) -> ms | null. The most recent activity
// signal already persisted for the workspace: the liveness verdict's
// lastOutboundTs (transcript/git activity) and the heartbeat's ts, whichever
// is newer. Never spawns git — reads only what the supervisor / a heartbeat
// already wrote. null means no activity signal is known at all (fail-open:
// callers must NOT treat null as "idle").
function lastActivityTs(verdict, heartbeat) {
  const a = verdict && Number.isFinite(verdict.lastOutboundTs) ? verdict.lastOutboundTs : 0;
  const b = heartbeat && Number.isFinite(heartbeat.ts) ? heartbeat.ts : 0;
  const best = Math.max(a, b);
  return best > 0 ? best : null;
}

// parseRowTs(row) -> ms | null. The message-timestamp field(s) actually
// written into a durable inbox NDJSON line by every current producer:
// devswarm-pull.js's native drain writes `createdAt` (a value devswarm-
// ingest.js's own ingestPayload() already treats as Date.parse-able) — the
// ONLY inbox-line producer shipped today. `timestamp` / `ts` are accepted too
// (the field names appendMeshMessage / the store use) so this stays forward-
// compatible with a future producer without assuming one that doesn't exist
// yet. Numeric epoch ms is accepted as-is; anything else is Date.parse'd.
// Unparseable / absent on all three -> null (caller must fail open, never
// treat null as "confirmed old").
function parseRowTs(row) {
  if (!row || typeof row !== 'object') return null;
  const candidates = [row.createdAt, row.timestamp, row.ts];
  for (const raw of candidates) {
    if (raw == null) continue;
    const t = typeof raw === 'number' ? raw : Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

// newestUnreadMessageTs(inboxPath, cursorPath, fsi) -> ms | null. The newest
// unread MESSAGE's own timestamp, NOT the child workspace's activity/
// heartbeat. NOT currently called by any consumer — a message-freshness
// idle-exclusion on the Stop-gate was proposed and rejected on review (see
// this file's own header, and the isNoiseText require's comment in
// devswarm-parent-gate.js): a ghost's unread is actually FRESH poke traffic,
// so freshness never excluded it, and it also risked suppressing a genuinely
// fresh unread on an idle-but-alive child. Kept (not deleted) as a
// general-purpose primitive in case a future consumer needs it.
//
// null means UNKNOWN (fail-open signal): the unread slice is not conclusively
// known (readUnread `known:false`), the inbox/cursor could not be read, or NONE
// of the unread lines carry a parseable timestamp. Callers MUST treat null as
// "cannot confirm stale" (i.e. keep blocking), never as "confirmed old".
function newestUnreadMessageTs(inboxPath, cursorPath, fsi) {
  try {
    const u = readUnreadMessages(inboxPath, cursorPath, fsi);
    if (!u || !u.known || !Array.isArray(u.rows) || u.rows.length === 0) return null;
    let newest = null;
    for (const row of u.rows) {
      const t = parseRowTs(row);
      if (t !== null && (newest === null || t > newest)) newest = t;
    }
    return newest;
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULT_IDLE_MS,
  idleThresholdMs,
  heartbeatPathFor,
  readHeartbeat,
  lastActivityTs,
  newestUnreadMessageTs,
};
