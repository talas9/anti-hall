'use strict';
// anti-hall :: orch-full-state — the per-session state behind conditional orchestration delivery
// (cost-trim D3). verify-first-orch.js (SessionStart) writes a marker saying whether ORCH_FULL is
// still owed to the coordinator on its first spawn; orch-on-spawn.js reads it, wins an O_EXCL claim
// and sends it. Flat files in ~/.anti-hall/orch-full/ (resolveHome):
//   orch-full-<sid>.json                       marker { epochId, decision: 'pending'|'none', sentAt }
//   orch-full-<sid>-<epochId>-claim.json       first claim slot  (fs 'wx')
//   orch-full-<sid>-<epochId>-claim2.json      retry slot after the lease (fs 'wx')
// Every file starts with `orch-full-` and ends `.json`, so lib/state-prune.js pruneStale({prefix:
// 'orch-full'}) covers markers and claims. Pure Node built-ins; every function is fail-soft.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PREFIX = 'orch-full';
// Internal constants (not settings): the retry slot opens after this lease, and only if no delivered
// copy shows up in the transcript.
const LEASE_MS = 2 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;
const TAIL_BYTES_WIDE = 4 * 1024 * 1024;

function homeOf(opts) {
  const env = (opts && opts.env) || process.env;
  return require('../../companion/lib/test-home-guard.js').resolveHome(opts && opts.home, env);
}
function dirOf(opts) { return path.join(homeOf(opts), '.anti-hall', 'orch-full'); }
function sid(raw) { return require('./handover-find.js').sanitizeSessionId(raw); }
function markerPath(sessionId, opts) { return path.join(dirOf(opts), PREFIX + '-' + sid(sessionId) + '.json'); }
function claimPath(sessionId, epochId, slot, opts) {
  return path.join(dirOf(opts), PREFIX + '-' + sid(sessionId) + '-' + String(epochId).replace(/[^A-Za-z0-9_-]/g, '') + '-' + (slot === 2 ? 'claim2' : 'claim') + '.json');
}

// The token embedded in the spawn-delivered text so the seen-scan can recognise THIS epoch's copy
// (and never a copy of PROTOCOL.md read through the Read tool). epochId = String(sentAt).
function tokenFor(epochId) { return '[anti-hall orch-full:' + epochId + ']'; }

// writeMarker(sessionId, decision, opts) -> { ok, epochId, sentAt }. tmp + rename. Never throws.
function writeMarker(sessionId, decision, opts) {
  try {
    const dir = dirOf(opts);
    fs.mkdirSync(dir, { recursive: true });
    const sentAt = Date.now();
    const epochId = String(sentAt);
    const file = markerPath(sessionId, opts);
    const tmp = file.replace(/\.json$/, '') + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp.json'; // ends .json: prunable
    fs.writeFileSync(tmp, JSON.stringify({ epochId, decision, sentAt }));
    fs.renameSync(tmp, file);
    try { require('./state-prune.js').pruneStale({ stateDir: dir, prefix: PREFIX, keepFile: file }); } catch (_) { /* best-effort */ }
    return { ok: true, epochId, sentAt };
  } catch (_) {
    return { ok: false };
  }
}

// readMarker(sessionId, opts) -> { epochId, decision, sentAt } | null (missing, truncated, malformed).
function readMarker(sessionId, opts) {
  try {
    const m = JSON.parse(fs.readFileSync(markerPath(sessionId, opts), 'utf8'));
    if (!m || typeof m !== 'object') return null;
    if (typeof m.epochId !== 'string' || !m.epochId) return null;
    if (m.decision !== 'pending' && m.decision !== 'none') return null;
    if (!Number.isFinite(m.sentAt)) return null;
    return m;
  } catch (_) {
    return null;
  }
}

// tryClaim(file, now) -> true iff this call created the file (O_EXCL). A retry is a second slot,
// never a read-modify-write of the first.
function tryClaim(file, now) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'wx');
    try { fs.writeSync(fd, JSON.stringify({ at: now, pid: process.pid })); } catch (_) { /* the file exists: the claim stands */ }
    return true;
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

function claimAt(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c && Number.isFinite(c.at)) return c.at;
  } catch (_) { /* fall through */ }
  try { return fs.statSync(file).mtimeMs; } catch (_) { return null; }
}

// seen(transcriptPath, epochId, sentAt) -> true | false | null.
//   true  = a delivered copy exists: a `hook_additional_context` attachment (Claude) or a developer-role
//           response_item message (Codex rollout) (the delivered form; the
//           `hook_success` record of the raw stdout does not count) holding this epoch's token with a
//           timestamp >= sentAt;
//   false = CONCLUSIVELY absent: the scanned window reaches back to sentAt (its first timestamp is
//           <= sentAt, or the whole file was scanned) and nothing matched;
//   null  = unknown (unreadable transcript, or the window does not reach sentAt: real epochs run
//           9-11 MB, so a 4 MB tail cannot see the start). Callers never retry on null.
// 256 KB tail first, widened once to 4 MB.
function seen(transcriptPath, epochId, sentAt) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const token = tokenFor(epochId);
  let reached = false;
  let usable = false;
  for (const bytes of [TAIL_BYTES, TAIL_BYTES_WIDE]) {
    let fd = null;
    try {
      const size = fs.statSync(transcriptPath).size;
      const n = Math.min(size, bytes);
      const buf = Buffer.alloc(n);
      fd = fs.openSync(transcriptPath, 'r');
      const got = fs.readSync(fd, buf, 0, n, size - n);
      let lines = buf.toString('utf8', 0, got).split('\n');
      if (size > n) lines = lines.slice(1); // first line is partial
      usable = true;
      let firstTs = null;
      for (const line of lines) {
        if (!line) continue;
        if (firstTs === null && line.indexOf('"timestamp"') !== -1) {
          try { const t = Date.parse(JSON.parse(line).timestamp); if (Number.isFinite(t)) firstTs = t; } catch (_) { /* partial */ }
        }
        if (line.indexOf(token) === -1) continue;
        let e = null;
        try { e = JSON.parse(line); } catch (_) { continue; }
        // Codex rollout shape: a developer-role response_item message whose input_text holds the token.
        const cp = e && e.type === 'response_item' ? e.payload : null;
        const codexHit = !!(cp && cp.type === 'message' && cp.role === 'developer');
        const a = e && e.type === 'attachment' ? e.attachment : null;
        if (!codexHit && (!a || a.type !== 'hook_additional_context')) continue;
        const ts = Date.parse(e.timestamp);
        if (Number.isFinite(ts) && ts >= sentAt) return true;
      }
      reached = size <= n || (firstTs !== null && firstTs <= sentAt);
      if (reached) break;
    } catch (_) {
      return null;
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    }
  }
  return usable && reached ? false : null;
}

module.exports = { PREFIX, LEASE_MS, dirOf, markerPath, claimPath, tokenFor, writeMarker, readMarker, tryClaim, claimAt, seen };
