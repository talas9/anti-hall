'use strict';
// anti-hall :: archived-child-metrics — small persisted counters for the
// "archived child can't re-register" fix (design B). Purely additive
// visibility: recordEvent() is best-effort (never throws, never blocks a
// hook/gate turn) and readMetrics() is a pure read consumed by
// companion/lib/doctor-devswarm.js's report-only check.
//
// EVENTS tracked (per workspace id, plus running totals):
//   'reregistration-refused' — devswarm-child-turn skipped a descriptor
//                               rewrite because the workspace is archived.
//   'turn-after-archive'     — a child turn ran (any hook activity) while
//                               the workspace was already archived.
//   'stop-blocked'           — devswarm-child-gate forced the one-time
//                               "save a handover and stop" block.
//   'stop-cleared'           — devswarm-child-gate let an archived child
//                               stop freely after its one-time block.
//
// Shape: { totals: { <event>: n }, byId: { <id>: { <event>: n,
//          firstArchivedTurnTs, lastEventTs, handoverWritten } } }
// Fail-open throughout: an unreadable/corrupt file reads as empty; a failed
// write is swallowed (metrics are diagnostic, never load-bearing).

const fs = require('fs');
const path = require('path');
const { devswarmRoot, isSafeId } = require('./liveness.js');

function metricsPath(home) {
  return path.join(devswarmRoot(home), 'archived-child-stop-metrics.json');
}

function readMetrics(home, fsi) {
  const F = fsi || fs;
  try {
    const o = JSON.parse(F.readFileSync(metricsPath(home), 'utf8'));
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      if (!o.totals || typeof o.totals !== 'object') o.totals = {};
      if (!o.byId || typeof o.byId !== 'object') o.byId = {};
      return o;
    }
  } catch (_) { /* fall through to empty */ }
  return { totals: {}, byId: {} };
}

function writeMetrics(home, data, fsi) {
  const F = fsi || fs;
  try {
    const p = metricsPath(home);
    F.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.tmp';
    F.writeFileSync(tmp, JSON.stringify(data));
    F.renameSync(tmp, p);
    return true;
  } catch (_) { return false; }
}

// recordEvent(home, id, event, extra, fsi) -> the updated metrics object (or
// null if id is unsafe/absent). extra: { now, handoverWritten }.
function recordEvent(home, id, event, extra, fsi) {
  const sid = id != null ? String(id) : '';
  if (!isSafeId(sid) || !event) return null;
  const now = (extra && Number.isFinite(extra.now)) ? extra.now : Date.now();
  const data = readMetrics(home, fsi);
  data.totals[event] = (data.totals[event] || 0) + 1;
  const row = data.byId[sid] || {};
  row[event] = (row[event] || 0) + 1;
  row.lastEventTs = now;
  if (event === 'reregistration-refused' && row.firstArchivedTurnTs == null) row.firstArchivedTurnTs = now;
  if (extra && extra.handoverWritten !== undefined) row.handoverWritten = !!extra.handoverWritten;
  data.byId[sid] = row;
  writeMetrics(home, data, fsi);
  return data;
}

module.exports = { metricsPath, readMetrics, writeMetrics, recordEvent };
