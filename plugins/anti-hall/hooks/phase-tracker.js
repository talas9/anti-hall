#!/usr/bin/env node
// phase-tracker.js — anti-hall auto activity tracker (PreToolUse: Agent / Task).
//
// Records every subagent spawn so the statusline can show LIVE swarm activity
// even when the coordinator never calls phase.js. It appends a timestamp to a
// HOMEDIR log (os.homedir() is visible to every process; os.tmpdir() is NOT —
// the statusline runner's TMPDIR differs from a hook's). The line-2 renderer
// (phase-bar.js) reads this log and shows an "orchestrating · N agents" bar when
// a semantic phase-state is absent.
//
// HARD RULE: this hook NEVER blocks a spawn and NEVER fails a turn. It only
// records. Any error -> exit 0. (A tracker that can deadlock the swarm would be
// far worse than a missing bar.)

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const crypto = require('crypto');

const DIR       = path.join(os.homedir(), '.anti-hall');
const LOG       = path.join(DIR, 'agent-spawns.log');
const KEEP_MS   = 5 * 60 * 1000; // retain spawn timestamps for 5 minutes

// sessionTag — a per-session token written alongside each spawn timestamp so the
// statusline can count ONLY the spawns of the session it is rendering for, never
// another session's (cross-session/cross-project bleed). Prefer the harness
// session_id; fall back to a short stable hash of the cwd; else 'unknown'. The
// token is sanitized to [A-Za-z0-9_-] so a line is always "<ms> <token>" with a
// single space and no embedded newline/whitespace that could corrupt parsing.
function sessionTag(payload) {
  let raw = '';
  try {
    const data = JSON.parse(payload);
    if (data && typeof data.session_id === 'string' && data.session_id.trim()) {
      raw = data.session_id.trim();
    } else {
      const cwd = (data && (data.cwd || (data.workspace && data.workspace.current_dir))) || '';
      if (cwd) raw = 'cwd-' + crypto.createHash('sha1').update(String(cwd)).digest('hex').slice(0, 12);
    }
  } catch (e) { /* malformed/empty -> unknown */ }
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  return clean || 'unknown';
}

try {
  // Read stdin (the PreToolUse payload carries session_id / cwd we tag with).
  let payload = '';
  try { payload = fs.readFileSync(0, 'utf8'); } catch (e) { /* ignore */ }
  const tag = sessionTag(payload);

  const now = Date.now();
  // Keep every recent line REGARDLESS of session tag (retention prune only): the
  // log is global, but we preserve other sessions' fresh entries so each session's
  // own statusline can still find its lines. A line is "<ms>" (legacy) or
  // "<ms> <tag>"; parse the leading integer for the prune.
  let lines = [];
  try {
    lines = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/)
      .filter(l => {
        const ms = parseInt(l, 10);
        return Number.isFinite(ms) && (now - ms) < KEEP_MS;
      });
  } catch (e) { /* no log yet */ }

  lines.push(now + ' ' + tag);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LOG, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* fail-open: can't persist -> just don't track */ }
} catch (e) {
  /* never throw */
}

process.exit(0); // ALWAYS allow the spawn
