'use strict';
// anti-hall :: devswarm-startup-sampling — PAUSED-WORKSPACE DATA CAPTURE ONLY.
//
// WHY: paused-state detection cannot be designed yet — `hivecontrol workspace
// info <id>` has been observed to return `startup: null` on EVERY workspace so
// far; nobody has ever seen a filled `startup` value. This module does not
// attempt to detect, suppress, or relabel anything. It ONLY opportunistically
// probes a bounded set of candidate workspaces from the supervisor's own
// reconcile sweep and, whenever a probe's result carries evidence worth
// keeping (a non-null startup field, or a terminalId that changed since the
// last time this module saw it), appends the RAW response to a bounded,
// rotated NDJSON log — so the next time the DevSwarm app happens to pause a
// workspace while the supervisor is running, the real shape gets captured
// automatically, without the owner having to catch it manually.
//
// NO STATUS CHANGE: nothing here writes a verdict, nudges, escalates, or
// changes any surface a Primary/child sees. It is read-only toward
// hivecontrol and append-only toward its own log.
//
// SELECTION: candidates are rows the supervisor's own persisted liveness
// verdict (companion/lib/liveness.js writeVerdict, read via livenessPathFor)
// already marks `stale` OR `notDraining` — the two signals already computed
// this same sweep tick for a completely different purpose (poke/escalate).
// This heuristic is DELIBERATELY broad (most non-actively-draining rows
// qualify) precisely because the real "paused" shape is unknown; the cost is
// bounded by pausedProbeMax (default 8) and a 3s per-probe timeout, not by
// precision in this selection.
//
// BOUNDED LOG: the ndjson file is capped at MAX_LOG_BYTES; when a write would
// exceed it, the file rotates to a SINGLE `.1` generation (the old `.1`, if
// any, is overwritten) before the new line is appended — never deleted
// outright, and no other file in ~/.anti-hall/logs/ is touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { devswarmRoot, livenessPathFor, isSafeId } = require('./liveness.js');

const DEFAULT_MAX_PROBE = 8;
const PROBE_TIMEOUT_MS = 3000;
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5MB, one rotated generation kept

function homeOf(opts) { return (opts && opts.home) || os.homedir(); }

function logsDir(home) { return path.join(home, '.anti-hall', 'logs'); }
function samplesPath(home) { return path.join(logsDir(home), 'devswarm-startup-samples.ndjson'); }

function statePath(home) { return path.join(devswarmRoot(home), 'startup-sampling-state.json'); }

function readState(home, fsi) {
  const F = fsi || fs;
  try {
    const parsed = JSON.parse(F.readFileSync(statePath(home), 'utf8'));
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) { return {}; }
}
function writeState(home, state, fsi) {
  const F = fsi || fs;
  F.mkdirSync(devswarmRoot(home), { recursive: true });
  const p = statePath(home);
  const tmp = p + '.tmp.' + process.pid;
  F.writeFileSync(tmp, JSON.stringify(state));
  F.renameSync(tmp, p);
}

function readVerdict(home, id, fsi) {
  const F = fsi || fs;
  try {
    if (!isSafeId(id)) return null;
    return JSON.parse(F.readFileSync(livenessPathFor(id, home), 'utf8'));
  } catch (_) { return null; }
}

// selectCandidates(descriptors, opts) -> descriptors[] whose persisted
// liveness verdict is stale or notDraining, capped at opts.maxProbe.
// opts: { home, fsi, maxProbe }
function selectCandidates(descriptors, opts) {
  const o = opts || {};
  const home = homeOf(o);
  const F = o.fsi || fs;
  const cap = Number.isFinite(o.maxProbe) ? o.maxProbe : DEFAULT_MAX_PROBE;
  const list = Array.isArray(descriptors) ? descriptors : [];
  const out = [];
  for (const d of list) {
    if (!d || !isSafeId(d.id)) continue;
    const verdict = readVerdict(home, d.id, F);
    if (!verdict) continue;
    const stale = verdict.status === 'stale';
    const notDraining = verdict.notDraining === true;
    if (stale || notDraining) {
      out.push(d);
      if (out.length >= cap) break;
    }
  }
  return out;
}

// defaultProbeRun(id, opts) -> { ok, raw, error } — ONE bounded, read-only
// `hivecontrol workspace info <id>` spawn. Injectable via opts.run for tests
// (no real hivecontrol dependency in the test suite).
function defaultProbeRun(id, opts) {
  const o = opts || {};
  const bin = o.hivecontrol || 'hivecontrol';
  try {
    const spawnOpts = { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS };
    if (o.env && typeof o.env === 'object') spawnOpts.env = o.env;
    const r = spawnSync(bin, ['workspace', 'info', String(id)], spawnOpts);
    if (r.error) {
      return { ok: false, error: String(r.error.message || r.error), timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
    }
    if (r.status !== 0) {
      return { ok: false, error: 'exit ' + r.status, raw: String(r.stdout || '') };
    }
    return { ok: true, raw: String(r.stdout || '') };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// rotateIfOversized(home, addBytes, fsi) -> best-effort: if the current log
// file's size + addBytes would exceed MAX_LOG_BYTES, move it to `.1`
// (overwriting any prior `.1`) so the active file starts fresh. Never deletes
// outright — the previous generation survives one rotation. Any fs error here
// is swallowed (fail-open toward "keep appending", never toward crashing the
// sweep).
function rotateIfOversized(home, addBytes, fsi) {
  const F = fsi || fs;
  const p = samplesPath(home);
  let size = 0;
  try { size = F.statSync(p).size; } catch (_) { size = 0; }
  if (size + (addBytes || 0) <= MAX_LOG_BYTES) return;
  try {
    F.mkdirSync(logsDir(home), { recursive: true });
    F.renameSync(p, p + '.1');
  } catch (_) { /* best-effort rotation only */ }
}

// appendSample(home, row, fsi) — bounded, rotated NDJSON append.
function appendSample(home, row, fsi) {
  const F = fsi || fs;
  const line = JSON.stringify(row) + '\n';
  rotateIfOversized(home, Buffer.byteLength(line, 'utf8'), F);
  F.mkdirSync(logsDir(home), { recursive: true });
  F.appendFileSync(samplesPath(home), line);
}

// countSamples(home, fsi) -> number of NDJSON lines currently in the active
// log (used by the doctor line; the rotated `.1` generation is NOT counted —
// it is historical, not "captured so far this generation").
function countSamples(home, fsi) {
  const F = fsi || fs;
  try {
    const raw = F.readFileSync(samplesPath(home), 'utf8');
    return raw.split('\n').filter((l) => l.trim()).length;
  } catch (_) { return 0; }
}

// worthCapturing(info, priorTerminalId) -> true when `info` (the parsed
// `workspace info` JSON body) carries a non-null startup/startup-state field,
// or a terminalId that differs from what was last seen for this id.
function worthCapturing(info, priorTerminalId) {
  if (!info || typeof info !== 'object') return false;
  const startupVal = ('startup' in info) ? info.startup : info.startupState;
  if (startupVal != null) return true;
  if ('terminalId' in info) {
    const tid = info.terminalId == null ? null : String(info.terminalId);
    if (tid !== (priorTerminalId == null ? null : String(priorTerminalId))) return true;
  }
  return false;
}

// runSamplingPass(descriptors, opts) -> { ran, probed, captured } — the
// supervisor sweep's entry point. opts: { home, env, now, fsi, maxProbe, run }.
// Fail-open throughout: any per-id failure is swallowed and moves on to the
// next candidate; nothing here ever throws out of a supervisor sweep tick.
function runSamplingPass(descriptors, opts) {
  const o = opts || {};
  const home = homeOf(o);
  const F = o.fsi || fs;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const run = o.run || defaultProbeRun;

  const candidates = selectCandidates(descriptors, { home, fsi: F, maxProbe: o.maxProbe });
  const state = readState(home, F);
  let captured = 0;

  for (const d of candidates) {
    let res;
    try { res = run(d.id, { env: o.env, hivecontrol: o.hivecontrol }); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res || !res.ok || typeof res.raw !== 'string' || !res.raw.trim()) continue;

    let info;
    try { info = JSON.parse(res.raw); } catch (_) { info = null; }
    if (!info) continue;

    const priorTerminalId = state[d.id] && state[d.id].terminalId;
    if (worthCapturing(info, priorTerminalId)) {
      try {
        appendSample(home, { id: d.id, ts: now, raw: info }, F);
        captured++;
      } catch (_) { /* logging must never break the sweep */ }
    }
    // Always refresh the last-seen terminalId (change detection is relative
    // to the MOST RECENT probe, not the most recent capture).
    state[d.id] = { terminalId: ('terminalId' in info && info.terminalId != null) ? String(info.terminalId) : null, lastProbedAt: now };
  }

  if (candidates.length) {
    try { writeState(home, state, F); } catch (_) { /* best-effort */ }
  }

  return { ran: true, probed: candidates.length, captured };
}

module.exports = {
  DEFAULT_MAX_PROBE, PROBE_TIMEOUT_MS, MAX_LOG_BYTES,
  samplesPath, statePath, readState, writeState,
  selectCandidates, defaultProbeRun, appendSample, countSamples, worthCapturing,
  runSamplingPass,
};
