#!/usr/bin/env node
// anti-hall :: task-list discipline injector (UserPromptSubmit, THROTTLED)
//
// Fires on every UserPromptSubmit, but does NOT inject the full task directive
// every turn (that multiplied the per-turn context footprint — the exact bloat
// this plugin warns against). Instead:
//   - FIRST turn of a session (or after the window expires): inject the FULL
//     directive (high-salience primer).
//   - Subsequent turns within the window: inject a SHORT one-line reminder.
// The discipline is never weakened — the full text is delivered at session start
// (and again every window) so capture/priority/drain rules stay present.
//
// Per-session state lives under ~/.anti-hall/ (F-07: never written into the
// user's project tree). Keyed by session_id (fallback: hash of cwd). Conservative
// and FAIL-OPEN: on ANY state error we inject the FULL directive (never less).
//
// Contract (Claude Code UserPromptSubmit hook):
//   stdin  : JSON { session_id, prompt, cwd, transcript_path, ... }
//   stdout : JSON { hookSpecificOutput.additionalContext } added to the turn
//   exit 0 : always - allow prompt, inject context
//
// No external deps; pure Node built-ins. JSON via JSON.stringify.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const FULL =
  'TASK-LIST DISCIPLINE: capture EVERY user request as a task (TaskCreate) ' +
  'before starting work, so no request is lost. Assign each task a priority ' +
  '(metadata.priority: P0/P1/P2) and maintain the list sorted ' +
  'highest-priority-first so the most important work is always on top; work ' +
  'tasks in that order. Keep statuses current: in_progress when starting, ' +
  'completed when done, deferred if explicitly deprioritized. Keep the MAIN ' +
  'thread non-blocking - delegate heavy/long work to background subagents and ' +
  'continue. Report progress to the user. Do not finish a turn with ' +
  'silently-dropped requests.';

const SHORT =
  'TASK-LIST: capture every request as a priority-sorted task; keep statuses ' +
  'current; delegate heavy work; drop nothing.';

// Re-inject the FULL directive at most once per this window (ms). Within the
// window, subsequent turns get only the SHORT one-liner. 6h keeps the full
// primer fresh across a long session without repeating it every turn.
const WINDOW_MS = 6 * 60 * 60 * 1000;

// Decide which message to inject. Returns FULL on the first turn of a session or
// when the window has expired; SHORT otherwise. FAIL-OPEN to FULL on any error
// so task discipline is never weakened by a state-file problem.
function pickMessage(payload) {
  try {
    const sessionId = (payload && payload.session_id && String(payload.session_id)) ||
      crypto.createHash('sha1').update(String((payload && payload.cwd) || process.cwd()))
        .digest('hex').slice(0, 16);
    const safeSession = sessionId.replace(/[^A-Za-z0-9_.-]/g, '_');
    const stateDir = path.join(os.homedir(), '.anti-hall');
    const stateFile = path.join(stateDir, 'task-tracker-' + safeSession + '.json');

    const now = Date.now();
    let lastFull = 0;
    try {
      const raw = fs.readFileSync(stateFile, 'utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Number.isFinite(parsed.lastFull)) lastFull = parsed.lastFull;
      }
    } catch (_) {
      // No prior state -> first turn -> FULL below.
    }

    if (now - lastFull < WINDOW_MS) {
      // Within the window: short reminder, no state write needed.
      return SHORT;
    }

    // First turn of the session or window expired: inject FULL, record the time.
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ lastFull: now }), 'utf8');
    } catch (_) {
      // Can't persist -> still inject FULL (fail-open: never under-inject).
    }
    return FULL;
  } catch (_) {
    return FULL; // any unexpected error -> never weaken discipline
  }
}

try {
  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (_) { payload = {}; }

  // Official schema: `hookEventName` is NESTED in `hookSpecificOutput`, not a
  // top-level sibling. KB §1.4 specifies `hookSpecificOutput.additionalContext`
  // for UserPromptSubmit; nesting here is correct per the harness contract.
  const out = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: pickMessage(payload),
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
} catch (_) {
  // Fail-open.
}
process.exit(0);
