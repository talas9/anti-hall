#!/usr/bin/env node
// phase-bar.js — anti-hall phase progress bar renderer.
// Reads os.tmpdir()/anti-hall/phase-state.json and prints ONE line:
//   [####------] P2 build 2/5
// If the state file is missing or invalid -> prints nothing and exits 0.
// Fail-open: any error is silently swallowed. No emoji. OS-agnostic.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Read state from a location consistent across ALL processes. os.tmpdir() is
// NOT reliable here: the statusline runner's TMPDIR can differ from a hook's or
// a tool's, so a state file written under one tmpdir is invisible to another.
// os.homedir() is identical for every process; check it first, tmpdir as fallback.
const STATE_CANDIDATES = [
  path.join(os.homedir(), '.anti-hall', 'phase-state.json'),
  path.join(os.tmpdir(),  'anti-hall', 'phase-state.json'),
];
function readState() {
  for (const f of STATE_CANDIDATES) {
    try { return fs.readFileSync(f, 'utf8'); } catch (e) { /* try next */ }
  }
  return null;
}
const BAR_WIDTH  = 10;
const SPINNER    = ['|', '/', '-', '\\'];

// Time-cycled spinner so the bar "spins" each statusline refresh (~every few
// hundred ms), giving a live/working feel even between activity.
function spinner() {
  // Divide by 1000 so that with refreshInterval:1 (a re-run every ~1000ms) the
  // index advances by ~1 each refresh and the stick actually rotates. A smaller
  // divisor (e.g. 250) advances by 4 per second -> %4 is constant -> looks frozen.
  return SPINNER[Math.floor(Date.now() / 1000) % SPINNER.length];
}

// ANSI colors (not emojis). Statusline output is rendered with ANSI by Claude Code.
const C = {
  reset: '\x1b[0m', cyan: '\x1b[36m', green: '\x1b[32m',
  dim: '\x1b[2m', bold: '\x1b[1m', yellow: '\x1b[33m',
};

function renderBar(done, total) {
  const filled = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  return '[' + C.green + '#'.repeat(clamped) + C.reset +
         C.dim + '-'.repeat(BAR_WIDTH - clamped) + C.reset + ']';
}

try {
  const raw = readState();
  if (raw === null) process.exit(0);
  const state = JSON.parse(raw);

  const code  = (state.code  || '').toString().trim();
  const desc  = (state.desc  || '').toString().trim();
  const done  = parseInt(state.done,  10);
  const total = parseInt(state.total, 10);

  // Require all four fields to be present and valid
  if (!code || !desc || isNaN(done) || isNaN(total) || total <= 0) {
    process.exit(0);
  }

  const bar = renderBar(done, total);
  process.stdout.write(
    `${C.cyan}${spinner()}${C.reset} ${bar} ` +
    `${C.bold}${code}${C.reset} ${desc} ${C.dim}${done}/${total}${C.reset}\n`
  );
} catch (e) {
  // Missing file, JSON parse error, or any other failure -> print nothing
  process.exit(0);
}
