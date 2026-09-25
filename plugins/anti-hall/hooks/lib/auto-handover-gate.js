// anti-hall :: auto-handover-gate — the post-handover new-work gate's state
// logic, used by hooks/auto-handover.js (UserPromptSubmit).
//
// ARMED when ALL hold (autoHandover.gateNewWork, default true):
//   - the auto-handover fire directive has gone out this arm (latch.fired —
//     which already implies usage is over the threshold: every hook that sees
//     usage drop back below resets the whole latch);
//   - THIS session's handover file exists: a HANDOVER*.md under
//     <cwd>/.anti-hall/handovers/<date>/<session-id>/ (the handover skill's own
//     layout, hooks/lib/handover-find.js) modified at or after the fire
//     (minus a small clock slack) — a handover from an earlier arm or another
//     session never arms it.
//
// STATE lives in the SAME per-session latch file as the fire/nag state
// (hooks/lib/auto-handover-state.js) — no parallel machinery:
//   handoverMtime   : mtimeMs of the handover file the baseline was taken from
//   handoverPath    : its path (for the backstop message)
//   handoverPct     : context % recorded when that file was first seen — the
//                     backstop's baseline. Hooks cannot observe the Write
//                     itself, so this is the transcript/statusline reading
//                     at the first prompt after the file appears (the usage
//                     at the end of the turn that wrote it).
//   gateBackstopAt  : ms of the one backstop reminder for this baseline
//   gateBackstopPct : the pct it fired at
// A NEWER handover file (the agent refreshed it) re-baselines and re-arms the
// backstop — the cap is one reminder per handover write.
//
// FAIL-OPEN: any fs error -> "no handover seen" (gate stays off). Never throws.
// Pure Node built-ins only.

'use strict';

const find = require('./handover-find.js');

// A handover written in the same second as the fire can carry an mtime a
// little earlier than firedAt on coarse-mtime filesystems.
const MTIME_SLACK_MS = 2000;

// sessionHandover(payload) -> { filePath, mtimeMs } | null — the newest
// HANDOVER*.md written by THIS session (any date dir). Bounded to this
// session's own handover directories only (find.findNewestHandoverForSession)
// -- noteHandover() below calls this on EVERY prompt once the gate's fire arm
// is set, so it must never fall back to (or even list) another session's
// handover dirs the way find.findNewestHandover's cross-session fallback
// does for handover-resume.js's different "pick up the newest handover
// anywhere" use case.
function sessionHandover(payload) {
  try {
    const cwd = payload && typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : null;
    if (!cwd) return null;
    const sid = find.sanitizeSessionId(payload.session_id);
    const c = find.findNewestHandoverForSession(find.handoversRoot(cwd), sid);
    if (!c) return null;
    return { filePath: c.filePath, mtimeMs: c.mtimeMs };
  } catch (_) {
    return null;
  }
}

// noteHandover(latch, payload, pct, now) -> a NEW latch object when a
// handover written since this arm's fire is seen for the first time (or a
// newer one replaced it), else null (nothing to record).
function noteHandover(latch, payload, pct, now) {
  if (!latch || latch.fired !== true || !Number.isFinite(pct)) return null;
  const h = sessionHandover(payload);
  if (!h) return null;
  const since = Number.isFinite(latch.firedAt) ? latch.firedAt - MTIME_SLACK_MS : 0;
  if (h.mtimeMs < since) return null;
  if (Number.isFinite(latch.handoverMtime) && h.mtimeMs <= latch.handoverMtime) return null;
  const next = Object.assign({}, latch, {
    handoverMtime: h.mtimeMs, handoverPath: h.filePath, handoverPct: pct, handoverSeenAt: now,
  });
  delete next.gateBackstopAt;
  delete next.gateBackstopPct;
  return next;
}

function isArmed(cfg, latch) {
  return !!(cfg && cfg.enabled && cfg.gateNewWork && latch && latch.fired === true &&
    Number.isFinite(latch.handoverPct));
}

// backstopDue(cfg, latch, pct) -> true once usage has grown more than
// gateBudgetPct points past the handover baseline and this baseline's one
// reminder has not gone out yet.
function backstopDue(cfg, latch, pct) {
  if (!isArmed(cfg, latch) || !Number.isFinite(pct)) return false;
  if (Number.isFinite(latch.gateBackstopAt)) return false;
  return pct > latch.handoverPct + cfg.gateBudgetPct;
}

module.exports = { MTIME_SLACK_MS, sessionHandover, noteHandover, isArmed, backstopDue };
