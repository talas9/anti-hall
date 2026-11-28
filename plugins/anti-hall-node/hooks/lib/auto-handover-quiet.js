// anti-hall :: auto-handover-quiet (GH #958 (b)) -- Node mirror of the engine's quiet mode (engine/logic/lib/75-ctxbudget.js `quiet`,
// `refreshNudge`; lib/87-nostop.js). While the machine-wide AFK flag or the session's no-stop state (both written by the engine) is on, or
// the session has an open task, a context warning is never "reach a good stopping point" and never advises /compact or /clear. The one
// message left is the handover refresh nudge, sent only when the saved handover is older than the session's last task or progress change.
// Read-only, fail-open, pure Node built-ins. Texts and numbers mirror engine/defaults/ctxbudget.toml (ctxbudget.refresh_*).
'use strict';

const fs = require('fs');
const path = require('path');

const STALE_MS = 300000;
const INTERVAL_MS = 900000;

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}

function safeSid(payload) {
  return payload && payload.session_id !== undefined && payload.session_id !== null ? String(payload.session_id).replace(/[^A-Za-z0-9_-]/g, '') : '';
}

function storeDirs(home, sid) {
  if (!sid) return [];
  return [path.join(home, '.claude', 'tasks', 'session-' + sid.slice(0, 8)), path.join(home, '.claude', 'tasks', sid)];
}

function storeTasks(home, sid) {
  const out = [];
  for (const d of storeDirs(home, sid)) {
    let names;
    try { names = fs.readdirSync(d); } catch (_) { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const rec = readJson(path.join(d, n));
      if (rec && typeof rec.status === 'string') out.push({ rec, file: path.join(d, n) });
    }
    return out; // the first directory that lists is the store
  }
  return out;
}

function isQuiet(home, payload) {
  const sid = safeSid(payload);
  const flag = readJson(path.join(home, '.anti-hall', 'afk.json'));
  if (flag && flag.on === true) return true;
  if (sid) {
    const s = readJson(path.join(home, '.anti-hall', 'afk-nostop-' + sid + '.json'));
    if (s && s.on === true) return true;
  }
  return storeTasks(home, sid).some((t) => /^(pending|in_progress)$/i.test(t.rec.status));
}

function lastChangeMs(home, payload) {
  let best = 0;
  const sid = safeSid(payload);
  for (const t of storeTasks(home, sid)) {
    try { best = Math.max(best, fs.statSync(t.file).mtimeMs); } catch (_) { /* skip */ }
  }
  if (sid && typeof payload.cwd === 'string' && payload.cwd.charAt(0) === '/') {
    try {
      best = Math.max(best, fs.statSync(path.join(payload.cwd, '.anti-hall', 'progress', new Date().toISOString().slice(0, 10), sid + '.md')).mtimeMs);
    } catch (_) { /* none */ }
  }
  return best;
}

// handover: {mtimeMs} | null (hooks/lib/auto-handover-gate.js sessionHandover). Returns the refresh text or null.
function refreshNudge(home, payload, latch, pct, now, handover) {
  const last = latch && Number.isFinite(latch.lastRefreshAt) ? latch.lastRefreshAt : 0;
  if (now - last < INTERVAL_MS) return null;
  const change = lastChangeMs(home, payload);
  if (handover && change - handover.mtimeMs <= STALE_MS) return null;
  const action = handover
    ? 'update the handover with what changed since it was saved ' + Math.max(0, Math.round((now - handover.mtimeMs) / 60000)) + ' min ago; keep working, compaction runs on its own.'
    : 'write the handover with the work so far; keep working, compaction runs on its own.';
  return '⚠️ auto-handover: Do now: ' + action + ' (context is ~' + Math.round(pct) + '% and the saved handover is behind the work.)';
}

module.exports = { isQuiet, refreshNudge, lastChangeMs };
