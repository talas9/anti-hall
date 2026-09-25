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
// POST-HANDOVER NEW-WORK GATE (autoHandover.gateNewWork, default on): once
// the fire directive has gone out AND this session's handover file exists
// (hooks/lib/auto-handover-gate.js), every prompt carries a short directive:
// judge the request's size BEFORE starting; above autoHandover.gateBudgetPct
// (default 5) of the window, offer (a) park it in the task list + handover
// until after /compact or /clear, or (b) proceed if the user insists. Quick
// questions, the in-flight task and DevSwarm workspace spawns pass through.
// A measured BACKSTOP fires once per handover baseline when usage grows more
// than gateBudgetPct points past the pct recorded when the handover was first
// seen: refresh the handover, offer to park the rest.
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
const { resolveEffective, overThreshold } = require('./lib/auto-handover-config.js');
const { sessionTag, readLatch, writeLatch } = require('./lib/auto-handover-state.js');
const { buildFireDirective, buildMilestoneNag, buildSoftAdvisory, buildGateDirective, buildGateBackstop } = require('./lib/auto-handover-text.js');
const gate = require('./lib/auto-handover-gate.js');

// consultJevShadow — the `postHandoverGate` Jev integration (default mode
// "off": an offline benchmark, n=299, found no gain over the agent's own
// size judgment plus the measured budget backstop — see CHANGELOG). When
// promoted to shadow/on, it fire-and-forgets "does this request fit in the
// remaining post-handover budget?" via askDetached (zero latency on this critical-path
// hook). The answer lands in jev-assist.ndjson only; it NEVER changes the
// injected text — the size judgment stays the agent's own. Best-effort.
function consultJevShadow(payload, settings, result) {
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) return;
  try {
    const jevAssist = require('./lib/jev-assist.js');
    const tokK = Number.isFinite(result.max) && result.max > 0
      ? ' (about ' + Math.round((result.max * settings.gateBudgetPct) / 100 / 1000) + 'K tokens)' : '';
    jevAssist.askDetached({
      id: 'postHandoverGate',
      question: {
        type: 'noul',
        instructions: 'The session is past its auto-handover threshold and a handover is saved. Does the ' +
          'user\'s request below fit in the remaining post-handover budget of about ' + settings.gateBudgetPct +
          '% of the context window' + tokK + ' — e.g. a quick question, finishing the in-flight task, or ' +
          'spawning a separate workspace — rather than needing a fresh context?',
        criteria: { true: 'fits in the remaining budget', false: 'needs more than the remaining budget' },
      },
      state: payload.prompt.slice(0, 4000),
      trust: 'advisory',
      baseline: null,
      sessionId: payload.session_id ? String(payload.session_id) : undefined,
      turnRef: jevAssist.turnRefFromTranscript(payload.transcript_path),
    });
  } catch (_) { /* best-effort — never affects the injected context */ }
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
            const over = overThreshold(result, settings);
            if (!over) {
              if (fired || latch.softFired) writeLatch(home, tag, { fired: false, softFired: false });
            } else if (!fired) {
              if (over === 'pct-unknown-window') {
                // Unknown window -> never the mandatory directive; a single
                // soft advisory per arm instead (never repeated every turn).
                if (latch.softFired !== true) {
                  text = buildSoftAdvisory(result.pct);
                  writeLatch(home, tag, Object.assign({}, latch, { softFired: true, lastNagAt: now }));
                }
              } else {
                text = buildFireDirective(result, over, payload, settings.maxTokens);
                writeLatch(home, tag, {
                  fired: true, firedAt: now, firedPct: result.pct, firedVia: over,
                  lastNagPct: result.pct, lastNagAt: now, softFired: false,
                });
              }
            } else {
              // Already fired this arm. POST-HANDOVER NEW-WORK GATE
              // (hooks/lib/auto-handover-gate.js): once this session's
              // handover file exists, every prompt carries the gate
              // directive, plus ONE measured backstop per handover baseline.
              let cur = latch;
              let dirty = false;
              const parts = [];
              let backstop = false;
              if (settings.gateNewWork) {
                const noted = gate.noteHandover(cur, payload, result.pct, now);
                if (noted) { cur = noted; dirty = true; }
                if (gate.isArmed(settings, cur)) {
                  if (gate.backstopDue(settings, cur, result.pct)) {
                    parts.push(buildGateBackstop(result.pct, cur, settings, payload));
                    // The backstop also serves as this step's milestone nag.
                    cur = Object.assign({}, cur, {
                      gateBackstopAt: now, gateBackstopPct: result.pct, lastNagPct: result.pct, lastNagAt: now,
                    });
                    dirty = true;
                    backstop = true;
                  }
                  parts.push(buildGateDirective(result, cur, settings, payload));
                  consultJevShadow(payload, settings, result);
                }
              }
              if (!backstop && settings.nag) {
                const lastNagPct = Number.isFinite(cur.lastNagPct) ? cur.lastNagPct : (cur.firedPct || settings.pct);
                if (result.pct >= lastNagPct + settings.nagStepPct) {
                  parts.push(buildMilestoneNag(result.pct, payload));
                  cur = Object.assign({}, cur, { lastNagPct: result.pct, lastNagAt: now });
                  dirty = true;
                }
              }
              if (dirty) writeLatch(home, tag, cur);
              text = parts.join('\n\n');
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
