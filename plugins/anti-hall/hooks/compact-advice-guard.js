#!/usr/bin/env node
// anti-hall :: compact-advice-guard (Stop, loop-safe)
//
// Field defect (0.115.x): the model declared "✅ SAFE TO COMPACT NOW" and
// repeated a `/compact focus: …` line a few turns AFTER a manual /compact,
// with context low. Its only trigger was "no background agents running" —
// nothing checked the real context usage or a recent compact boundary.
//
// BLOCKS the Stop (once per declaration) when the turn's FINAL assistant
// message recommends compacting (hooks/lib/compact-advice.js findAdvice():
// "SAFE TO COMPACT", "good point to /compact", "/compact" offered as an
// instruction — quoted/negated/retracted text excluded) AND either:
//   - LOW CONTEXT: context % < autoHandover.pct − guards.compactAdviceMarginPct
//     (context % from hooks/lib/context-pct.js: statusline → Codex rollout →
//     transcript estimate; unknown → this rule is skipped), or
//   - RECENT COMPACT: a compact boundary within the last
//     guards.compactAdviceRecentTurns turns (0 disables this rule).
//
// ALLOWED regardless: the auto-handover threshold path — this session's
// auto-handover latch (hooks/lib/auto-handover-state.js) has fired, no compact
// happened since it fired (boundary timestamp vs latch.firedAt), and context
// is not below the low-context line.
// That is the one case the handover skill says may declare SAFE.
//
// Loop safety: stop_hook_active → allow; the same final message is never
// blocked twice (sha1 in ~/.anti-hall/compact-advice/<tag>.json).
//
// Contract (Stop): stdout {"decision":"block","reason":…} or nothing; exit 0.
// Switch: guards.compactAdviceGuard. Skip: skip-guard 'compact-advice-guard'.
// FAIL-OPEN everywhere. Pure Node built-ins.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function emit(reason) {
  try { if (reason) fs.writeSync(1, JSON.stringify({ decision: 'block', reason }) + '\n'); } catch (_) { /* fail-open */ }
}

function statePath(home, tag) {
  return path.join(home, '.anti-hall', 'compact-advice', tag + '.json');
}

function main() {
  const settings = require('./lib/settings.js');
  const home = require('../companion/lib/test-home-guard.js').resolveHome();
  const env = process.env;
  if (!settings.enabled('guards', 'compactAdviceGuard', { home, env })) return;

  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { return; }
  if (!payload || typeof payload !== 'object') return;

  const { isSubagentByPayload } = require('./coordinator-detect.js');
  const { isSkipped } = require('./skip-guard.js');
  const { stopHookActive } = require('./lib/stop-policy.js');
  if (isSubagentByPayload(payload) || stopHookActive(payload) || isSkipped('compact-advice-guard')) return;

  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
  if (!transcriptPath) return;
  const { readTail } = require('./lib/transcript-tail.js');
  const lines = readTail(transcriptPath);
  if (!lines) return;

  const advice = require('./lib/compact-advice.js');
  const turn = advice.readTurn(lines);
  const found = advice.findAdvice(turn.finalText);
  if (!found.length) return;
  if (advice.lastRetraction(turn.finalText) > found[found.length - 1].index) return;

  const { getContextPct } = require('./lib/context-pct.js');
  const result = getContextPct(transcriptPath, env, { home, sessionId: payload.session_id, lines });
  const pct = result && Number.isFinite(result.pct) ? result.pct : null;
  const threshold = settings.get('autoHandover', 'pct', 85, { home, env });
  const margin = settings.get('guards', 'compactAdviceMarginPct', 10, { home, env });
  const window = settings.get('guards', 'compactAdviceRecentTurns', 10, { home, env });

  const low = pct !== null && pct < threshold - margin;
  const recent = window > 0 && turn.turnsSinceCompact !== null && turn.turnsSinceCompact <= window;
  if (!low && !recent) return;

  // Threshold-fired handover path: allowed to declare SAFE.
  const { sessionTag, readLatch } = require('./lib/auto-handover-state.js');
  const tag = sessionTag(payload);
  if (!tag) return;
  const latch = readLatch(home, tag);
  const compactAfterFire = turn.turnsSinceCompact !== null &&
    (turn.compactAt === null || !Number.isFinite(latch.firedAt) || turn.compactAt >= latch.firedAt);
  if (latch.fired === true && !low && !compactAfterFire) return;

  const hash = crypto.createHash('sha1').update(turn.finalText).digest('hex');
  const sp = statePath(home, tag);
  try {
    const prev = JSON.parse(fs.readFileSync(sp, 'utf8'));
    if (prev && prev.hash === hash) return; // already blocked this exact declaration once
  } catch (_) { /* no state */ }
  try {
    fs.mkdirSync(path.dirname(sp), { recursive: true });
    fs.writeFileSync(sp, JSON.stringify({ hash, at: Date.now() }));
  } catch (_) { return; } // cannot record the block -> never block (no loop)

  const why = [];
  if (pct !== null) why.push('context is ' + Math.round(pct) + '% (auto-handover threshold ' + threshold + '%)');
  else why.push('context % is unknown');
  if (recent) {
    const n = turn.turnsSinceCompact;
    why.push(n === 0 ? 'a compact happened earlier in this turn' : 'a compact happened ' + n + ' turn' + (n === 1 ? '' : 's') + ' ago');
  }
  emit(
    'anti-hall compact-advice-guard: your reply recommends compacting ("' + found[found.length - 1].phrase + '"), but ' +
    why.join(', and ') + ' — don\'t recommend compacting now. "No background agents running" is necessary, not sufficient. ' +
    'Retract it in one line, e.g. "RETRACT SAFE TO COMPACT — context is ' + (pct !== null ? Math.round(pct) + '%' : 'low') +
    '; no need to compact", then continue or end the turn. Only the auto-handover threshold directive (or genuinely high context) justifies a SAFE TO COMPACT line.'
  );
}

try { main(); } catch (_) { /* fail-open */ }
process.exit(0);
