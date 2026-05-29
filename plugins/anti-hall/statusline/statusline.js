#!/usr/bin/env node
// statusline.js — Two-line statusline dispatcher.
//
// LINE 1: monorepo or simple statusline (auto-detected).
//   Monorepo detection (checked at git toplevel, then cwd):
//     .gitmodules exists    => monorepo (git submodules)
//     .gsd/ dir exists      => monorepo (GSD project)
//     .planning/ dir exists => monorepo (planning state present)
//   Otherwise => simple statusline.
//
// LINE 2: phase bar (only printed when os.tmpdir()/anti-hall/phase-state.json
//   exists and is valid). Omitted entirely when state file is absent/invalid.
//
// Fail-open: if line 1 errors, still attempt line 2. If line 2 errors, omit it.
// Never crashes Claude Code. No emojis. Pure Node. OS-agnostic.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Monorepo detection
// ---------------------------------------------------------------------------

function gitToplevel(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
  } catch (e) {
    return cwd;
  }
}

function isMonorepo(dir) {
  if (fs.existsSync(path.join(dir, '.gitmodules'))) return true;
  if (fs.existsSync(path.join(dir, '.gsd')))        return true;
  if (fs.existsSync(path.join(dir, '.planning')))   return true;
  return false;
}

// ---------------------------------------------------------------------------
// Phase bar (line 2)
// ---------------------------------------------------------------------------

const STATE_FILE = path.join(os.tmpdir(), 'anti-hall', 'phase-state.json');
const BAR_WIDTH  = 10;
const SPINNER    = ['|', '/', '-', '\\'];

function spinner() {
  return SPINNER[Math.floor(Date.now() / 250) % SPINNER.length];
}

function renderBar(done, total) {
  const filled = total > 0 ? Math.round((done / total) * BAR_WIDTH) : 0;
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  return '[' + '#'.repeat(clamped) + '-'.repeat(BAR_WIDTH - clamped) + ']';
}

function phaseBarLine() {
  try {
    const raw   = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(raw);
    const code  = (state.code  || '').toString().trim();
    const desc  = (state.desc  || '').toString().trim();
    const done  = parseInt(state.done,  10);
    const total = parseInt(state.total, 10);
    if (!code || !desc || isNaN(done) || isNaN(total) || total <= 0) return null;
    const bar = renderBar(done, total);
    return `${spinner()} ${bar} ${code} ${desc} ${done}/${total}`;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  let input = '';
  const timeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(timeout);

    // --- LINE 1: dispatch to the right renderer ---
    let line1 = '';
    try {
      let cwd = process.cwd();
      try {
        const data = JSON.parse(input);
        cwd = data.workspace?.current_dir || data.cwd || cwd;
      } catch (e) { /* use process.cwd() */ }

      const toplevel = gitToplevel(cwd);
      const monorepo = isMonorepo(toplevel) || isMonorepo(cwd);

      const scriptDir = __dirname;
      const renderer  = monorepo
        ? path.join(scriptDir, 'statusline-monorepo.js')
        : path.join(scriptDir, 'statusline-simple.js');

      // Capture renderer output by temporarily overriding process.stdout.write.
      const saved = process.stdout.write.bind(process.stdout);
      const chunks = [];
      process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
      try {
        const mod = require(renderer);
        if (typeof mod.runWithInput === 'function') mod.runWithInput(input);
      } finally {
        process.stdout.write = saved;
      }
      line1 = chunks.join('');
    } catch (e) {
      // Line 1 failed — proceed to line 2 attempt anyway
    }

    // --- LINE 2: phase bar (optional) ---
    const line2 = phaseBarLine();

    // --- Emit ---
    let out = line1;
    if (line2) out += (line1 ? '\n' : '') + line2;
    if (out) {
      try {
        process.stdout.write(out);
      } catch (e) {
        // EPIPE or other write error — ignore, never crash Claude Code
      }
    }
  });
}

// Suppress EPIPE so a closed pipe on stdout never propagates as an unhandled error.
process.stdout.on('error', (e) => { if (e.code !== 'EPIPE') throw e; });

main();
