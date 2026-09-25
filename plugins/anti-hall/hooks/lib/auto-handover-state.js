// anti-hall :: auto-handover-state — the per-session fire/nag latch shared by
// hooks/auto-handover.js (UserPromptSubmit: fire + milestone nag) and
// hooks/auto-handover-pause-nag.js (Stop: natural-pause nag).
//
// STATE: <home>/.anti-hall/auto-handover/<tag>.json
//   { fired, firedAt, firedPct, lastNagPct, lastNagAt }
//   fired      : has the fire directive gone out since the last re-arm
//   firedAt    : ms timestamp of the fire
//   firedPct   : the pct it fired at (milestone baseline)
//   lastNagPct : the pct baseline the last MILESTONE nag was measured from
//                (starts equal to firedPct; advances by nagStepPct each nag)
//   lastNagAt  : ms timestamp of the last nag of EITHER kind (milestone or
//                natural-pause) — the pause-nag hook's quiet-period gate
//   lastPauseNagPct : the rounded pct the last natural-pause nag showed —
//                the pause-nag hook never repeats that identical text within
//                the same nagStepPct step
//   handoverMtime / handoverPath / handoverPct / handoverSeenAt /
//   gateBackstopAt / gateBackstopPct : the post-handover new-work gate's
//                baseline + one-shot backstop (hooks/lib/auto-handover-gate.js)
//
// tag: session_id (sanitized) if present, else sha1(transcript_path).slice(0,16)
// — the same fallback scheme skills/handover/SKILL.md documents.
//
// FAIL-OPEN: read/write errors never throw; a write failure is best-effort
// (worst case: a nag fires again, or fails to fire) — never load-bearing.
// Pure Node built-ins only.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sessionTag(payload) {
  if (payload && typeof payload.session_id === 'string' && payload.session_id.trim()) {
    const safe = payload.session_id.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (safe) return safe;
  }
  if (payload && typeof payload.transcript_path === 'string' && payload.transcript_path) {
    return crypto.createHash('sha1').update(payload.transcript_path).digest('hex').slice(0, 16);
  }
  return null;
}

function statePath(home, tag) {
  return path.join(home, '.anti-hall', 'auto-handover', tag + '.json');
}

function readLatch(home, tag) {
  try {
    const obj = JSON.parse(fs.readFileSync(statePath(home, tag), 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) {
    return {};
  }
}

// writeLatch(home, tag, obj) — full overwrite (callers pass the whole
// desired object; both consumers always read-then-write in one hook
// invocation, so no merge is needed). Best-effort, atomic tmp+rename.
function writeLatch(home, tag, obj) {
  try {
    const p = statePath(home, tag);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, p);
  } catch (_) {
    /* best-effort */
  }
}

module.exports = { sessionTag, statePath, readLatch, writeLatch };
