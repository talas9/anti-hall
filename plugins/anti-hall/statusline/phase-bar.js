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
const BAR_WIDTH  = 20;
// Rotating half-disc (Unicode geometric shapes, cross-OS: macOS/Linux/Windows
// Terminal). Full-bodied so it aligns with the block fill and reads as a clear
// "work head" at the progress frontier. 4 frames -> snappy even at a 1s refresh.
const SPINNER    = ['◐', '◓', '◑', '◒'];

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
  magenta: '\x1b[35m', white: '\x1b[97m', blue: '\x1b[34m',
};

// The spinner sits INSIDE the bar at the progress frontier (between filled and
// empty) - it marks the current position / "work happening here" head.
function renderBar(done, total) {
  const filled = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  const empty   = BAR_WIDTH - clamped;
  // Box-drawing glyphs (NOT emoji): full block for filled, light horizontal for
  // empty - a clean continuous line. Same char class as the box chars already in
  // typical statuslines. Falls back fine in any modern terminal.
  return '[' + C.green + '█'.repeat(clamped) + C.reset +
         C.cyan + spinner() + C.reset +
         C.dim + '─'.repeat(empty) + C.reset + ']';
}

try {
  const raw = readState();
  if (raw === null) process.exit(0);
  const state = JSON.parse(raw);

  const code  = (state.code  || '').toString().trim();
  let   desc  = (state.desc  || '').toString().trim();
  const done  = parseInt(state.done,  10);
  const total = parseInt(state.total, 10);

  // Require all four fields to be present and valid
  if (!code || !desc || isNaN(done) || isNaN(total) || total <= 0) {
    process.exit(0);
  }

  // Allow a fuller description now that there is room; cap to keep the line sane.
  if (desc.length > 32) desc = desc.slice(0, 31) + '...';

  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  const bar = renderBar(done, total); // spinner now lives inside the bar

  // Optional extras, rendered only if present in the state file. The orchestrator
  // writes these as it works (see the watchdog/heartbeat design) so a long-running
  // or stuck phase is visible right in the statusline.
  const extras = [];
  const started = parseInt(state.started, 10); // epoch ms when the phase began
  if (!isNaN(started) && started > 0) {
    const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
    const human = secs >= 3600 ? Math.floor(secs / 3600) + 'h' + Math.floor((secs % 3600) / 60) + 'm'
                : secs >= 60   ? Math.floor(secs / 60) + 'm'
                :                secs + 's';
    // Yellow once the phase has run long (>20m) - a visible "is this stuck?" cue.
    extras.push((secs > 1200 ? C.yellow : C.dim) + human + C.reset);
  }
  const agents = parseInt(state.agents, 10); // active subagent count
  if (!isNaN(agents) && agents >= 0) {
    extras.push(C.blue + agents + (agents === 1 ? ' agent' : ' agents') + C.reset);
  }
  let step = (state.step || '').toString().trim(); // current step text
  if (step) {
    if (step.length > 28) step = step.slice(0, 27) + '...';
    extras.push(C.dim + step + C.reset);
  }
  const extraStr = extras.length ? ` ${C.dim}|${C.reset} ` + extras.join(' ') : '';

  process.stdout.write(
    `${bar} ${C.yellow}${pct}%${C.reset} ${C.dim}|${C.reset} ` +
    `${C.bold}${C.magenta}${code}${C.reset} ${C.dim}-${C.reset} ${C.white}${desc}${C.reset} ` +
    `${C.cyan}${done}/${total}${C.reset}${extraStr}\n`
  );
} catch (e) {
  // Missing file, JSON parse error, or any other failure -> print nothing
  process.exit(0);
}
