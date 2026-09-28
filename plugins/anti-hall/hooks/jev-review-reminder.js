#!/usr/bin/env node
// anti-hall :: jev-review-reminder (SessionStart) — durable "time to review
// the Jev shadow numbers" nudge. Most Jev integrations default to "shadow"
// mode (consulted + logged, never trusted) until an owner reviews `jev
// report` and explicitly promotes/demotes them. A per-session reminder is
// NOT durable (session crons die with the session), so this check — and its
// on-disk state (~/.anti-hall/jev-review-state.json) — lives in the plugin
// itself. See hooks/lib/jev-review.js for the due-date logic.
//
// GATING (all silent, no output, when any of these apply):
//   - Jev not enabled (`jev.json`/settings `enabled` !== true).
//   - `jev.reviewReminder` === false (default true — opt-out, not opt-in).
//   - Not the main session (a subagent/sidechain payload, same defensive
//     check version-alert.js uses).
//   - No integration is currently due (see jev-review.js computeReviewDue).
//
// Contract:
//   stdin  : JSON { hook_event_name, session_id, cwd, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } },
//            or nothing when gated/nothing due.
//   exit 0 : ALWAYS — fail-open on any error, never blocks session start.

'use strict';

const fs = require('fs');
const os = require('os');

const MAX_LINE_CHARS = 320;
const MAX_NAMED = 3;

function settingsGet(section, key, dflt, home) {
  try { return require('./lib/settings.js').get(section, key, dflt, { home }); } catch (_) { return dflt; }
}

function readJevJson(home) {
  try {
    const path = require('path');
    const raw = fs.readFileSync(path.join(home, '.anti-hall', 'jev.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// isSubagentPayload — see version-alert.js's own doc comment: SessionStart is
// documented as firing per top-level session with no subagent marker today;
// this is defensive belt-and-suspenders in case a future harness changes that.
function isSubagentPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  if (payload.agent_id || payload.agent_type) return true;
  if (payload.isSidechain === true || payload.is_sidechain === true) return true;
  return false;
}

function readStdinPayload() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// buildLine(due) -> the single directive line, capped at MAX_LINE_CHARS. Names
// up to MAX_NAMED integrations, then "+N more" when there are others.
function buildLine(due) {
  const named = due.slice(0, MAX_NAMED).map((d) => `${d.id} (${d.days}d, ${d.decisions} decisions)`);
  const rest = due.length - named.length;
  let list = named.join(', ');
  if (rest > 0) list += `, +${rest} more`;
  let line = `\u{1F514} JEV REVIEW DUE: ${list}. Tell the owner and offer to run ` +
    '`/anti-hall:jev report` — they asked to be reminded.';
  if (line.length > MAX_LINE_CHARS) {
    // Degrade gracefully: fewer named integrations before ever hard-truncating.
    for (let n = named.length - 1; n >= 1; n--) {
      const shortList = due.slice(0, n).map((d) => `${d.id} (${d.days}d, ${d.decisions} decisions)`).join(', ');
      const remaining = due.length - n;
      const candidate = `\u{1F514} JEV REVIEW DUE: ${shortList}${remaining > 0 ? `, +${remaining} more` : ''}. ` +
        'Tell the owner and offer to run `/anti-hall:jev report` — they asked to be reminded.';
      if (candidate.length <= MAX_LINE_CHARS) { line = candidate; break; }
      line = candidate;
    }
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS - 1) + '…';
  }
  return line;
}

function emit(hookEventName, additionalContext) {
  const out = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };
  // Synchronous write to fd 1 — see verify-first-full.js's header for why
  // process.stdout.write is unsafe here (async pipe-flush truncation race).
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

function main() {
  const payload = readStdinPayload();
  if (isSubagentPayload(payload)) return; // main-thread only

  const home = require('../companion/lib/test-home-guard.js').resolveHome(undefined, process.env);
  const cfg = readJevJson(home);
  if (cfg.enabled !== true) return; // Jev off entirely — nothing to review.

  const reminderOn = settingsGet('jev', 'reviewReminder', true, home) !== false;
  if (!reminderOn) return; // explicit opt-out

  const review = require('./lib/jev-review.js');
  const result = review.computeReviewDue(home);
  if (!result.due || !result.due.length) return;

  const additionalContext = buildLine(result.due);
  review.recordReminderShown(home, result.due.map((d) => d.id));

  const hookEventName = payload && typeof payload.hook_event_name === 'string' && payload.hook_event_name
    ? payload.hook_event_name
    : 'SessionStart';
  emit(hookEventName, additionalContext);
}

try {
  main();
} catch (_) {
  // Fail-open: never block session start.
}
process.exit(0);
