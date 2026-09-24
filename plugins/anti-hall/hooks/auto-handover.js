#!/usr/bin/env node
// anti-hall :: auto-handover trigger (UserPromptSubmit)
//
// When the MAIN agent's context usage first crosses a threshold (default
// 85%, section "autoHandover" of ~/.anti-hall/settings.json, or env
// ANTIHALL_AUTO_HANDOVER_PCT — see hooks/lib/auto-handover-config.js for full
// precedence/validation), injects a directive that the main agent must,
// WITHOUT asking the user first:
//   1. write an anti-hall handover itself (the /anti-hall:handover skill's
//      self-write mandate — never delegate to a subagent);
//   2. tell the user this was done to preserve work against auto-compact (or
//      anything they might forget), listing the saved paths;
//   3. urge /compact or /clear, and ask whether they want to reach a good
//      stopping point first.
//
// FIRES ONCE per session at the crossing (a latch, not a level trigger) and
// RE-ARMS only once usage drops back below the threshold — which in practice
// means a /compact or /clear happened (or a brand-new session).
//
// After firing, this same hook also sends a short MILESTONE nag each time
// usage grows another `nagStepPct` points past the last nag (e.g. fire at
// 85, nag at 90, 95, ...) — see hooks/auto-handover-pause-nag.js (Stop) for
// the complementary natural-pause nag. Both share
// hooks/lib/auto-handover-state.js's latch. `autoHandover.nag=false`
// silences both nag paths; the initial fire directive still fires.
//
// Context % is ESTIMATED from the transcript's own recorded token usage
// (hooks/lib/context-pct.js) — see that file for why this, not the
// statusline, is the source. NEVER fires for a subagent/sidechain turn
// (coordinator-detect.js's payload-only signal): only the main agent should
// ever be told to self-write a handover mid-turn.
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext }
//   exit 0 : always — never wedge a turn
//
// Escape hatch: honored via skip-guard.js isSkipped('auto-handover').
// FAIL-OPEN: any missing/malformed payload, unreadable transcript, or state
// I/O error -> empty additionalContext, never fires, never throws.
//
// stdout: fs.writeSync(1, ...) — synchronous, avoids async flush races on
// macOS Node 18/20 (mirrors task-tracker.js / limit-conserve-inject.js).

'use strict';

const fs = require('fs');
const os = require('os');
const { isSubagentByPayload } = require('./coordinator-detect.js');
const { isSkipped } = require('./skip-guard.js');
const { getContextPct } = require('./lib/context-pct.js');
const { resolveEffective } = require('./lib/auto-handover-config.js');
const { sessionTag, readLatch, writeLatch } = require('./lib/auto-handover-state.js');

// One short, non-alarmist sentence shared by every message this feature
// emits (fire directive, milestone nag, and the Stop-time pause nag) — the
// reason to compact/clear isn't only "you'll hit the limit soon".
const BLOAT_SENTENCE =
  'As context grows the model gets less efficient and more prone to hallucination, ' +
  'so compacting/clearing keeps answers accurate, not just under the limit.';

function buildFireDirective(pct, estimated) {
  const label = estimated
    ? ' (ESTIMATED — assuming a standard 200k context window; if this is a 1M-context session, set ANTIHALL_CONTEXT_WINDOW_TOKENS or install the anti-hall statusline for an exact reading)'
    : '';
  return (
    'CONTEXT AT ~' + Math.round(pct) + '%' + label + ' — AUTO-HANDOVER REQUIRED. Without asking the user first: ' +
    '(1) immediately WRITE an anti-hall session handover YOURSELF, following the /anti-hall:handover ' +
    'skill contract exactly (self-write mandate — never delegate this to a subagent; it never lived ' +
    'this session and would lose decision/trial fidelity); ' +
    '(2) then TELL the user this was done, to preserve the session\'s work against auto-compact (or ' +
    'anything they might otherwise forget), and LIST every path you just saved under .anti-hall/handovers/**; ' +
    '(3) URGE them to run /compact (or /clear) soon, and ASK whether they would like to reach a good ' +
    'stopping point first before they do. ' + BLOAT_SENTENCE + ' ' +
    'This fires once per session at this threshold; you will get brief follow-up reminders as context ' +
    'keeps growing, not a repeat of this whole message.'
  );
}

function buildMilestoneNag(pct) {
  return (
    'CONTEXT NOW ~' + Math.round(pct) + '% (handover already saved earlier this session) — ' +
    BLOAT_SENTENCE + ' Mention /compact or /clear to the user again when convenient.'
  );
}

function main() {
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = null; }

  let text = '';
  try {
    if (payload && typeof payload === 'object' && !isSubagentByPayload(payload) && !isSkipped('auto-handover')) {
      const home = os.homedir();
      const env = process.env;
      const settings = resolveEffective({ home, env });

      const tag = sessionTag(payload);
      if (tag) {
        const latch = readLatch(home, tag);
        const fired = latch.fired === true;

        if (!settings.enabled) {
          if (fired) writeLatch(home, tag, { fired: false });
        } else {
          const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : null;
          const result = getContextPct(transcriptPath, env, { home, sessionId: payload.session_id });
          if (result && Number.isFinite(result.pct)) {
            const now = Date.now();
            if (result.pct < settings.pct) {
              if (fired) writeLatch(home, tag, { fired: false });
            } else if (!fired) {
              text = buildFireDirective(result.pct, result.estimated === true);
              writeLatch(home, tag, {
                fired: true, firedAt: now, firedPct: result.pct,
                lastNagPct: result.pct, lastNagAt: now,
              });
            } else if (settings.nag) {
              const lastNagPct = Number.isFinite(latch.lastNagPct) ? latch.lastNagPct : (latch.firedPct || settings.pct);
              if (result.pct >= lastNagPct + settings.nagStepPct) {
                text = buildMilestoneNag(result.pct);
                writeLatch(home, tag, Object.assign({}, latch, { lastNagPct: result.pct, lastNagAt: now }));
              }
            }
          }
        }
      }
    }
  } catch (_) {
    text = ''; // fail-open
  }

  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text,
    },
  };
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // fail-open: if we never wrote, Claude Code ignores missing stdout
}
process.exit(0);
