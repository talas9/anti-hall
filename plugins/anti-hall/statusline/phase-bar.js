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

const STATE_FILE = path.join(os.tmpdir(), 'anti-hall', 'phase-state.json');
const BAR_WIDTH  = 10;

function renderBar(done, total) {
  const filled = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  return '[' + '#'.repeat(clamped) + '-'.repeat(BAR_WIDTH - clamped) + ']';
}

try {
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
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
  process.stdout.write(`${bar} ${code} ${desc} ${done}/${total}\n`);
} catch (e) {
  // Missing file, JSON parse error, or any other failure -> print nothing
  process.exit(0);
}
