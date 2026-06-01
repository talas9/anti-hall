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

const DIR       = path.join(os.homedir(), '.anti-hall');
const LOG       = path.join(DIR, 'agent-spawns.log');
const KEEP_MS   = 5 * 60 * 1000; // retain spawn timestamps for 5 minutes

try {
  // Drain stdin (hook protocol gives us the tool payload; we don't need it).
  try { fs.readFileSync(0, 'utf8'); } catch (e) { /* ignore */ }

  const now = Date.now();
  let ts = [];
  try {
    ts = fs.readFileSync(LOG, 'utf8').trim().split(/\r?\n/)
      .map(n => parseInt(n, 10))
      .filter(n => Number.isFinite(n) && (now - n) < KEEP_MS);
  } catch (e) { /* no log yet */ }

  ts.push(now);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(LOG, ts.join('\n') + '\n', 'utf8');
  } catch (e) { /* fail-open: can't persist -> just don't track */ }
} catch (e) {
  /* never throw */
}

process.exit(0); // ALWAYS allow the spawn
