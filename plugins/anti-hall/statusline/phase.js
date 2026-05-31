#!/usr/bin/env node
// phase.js — write/update the anti-hall phase-state that the statusline reads.
//
// This is the DATA SOURCE for the phase bar. The orchestrator / feature-launch
// skill calls it as real work progresses (NOT a fake file). The statusline's
// phase-bar.js reads the same file and renders it.
//
// State file: ~/.anti-hall/phase-state.json  (home dir = consistent across the
// statusline runner, hooks, and the orchestrator — os.tmpdir() is NOT).
//
// Usage:
//   node phase.js set <code> <desc> <done> <total>   start/replace the phase
//   node phase.js advance [n]                         done += n (default 1)
//   node phase.js step "<text>"                       set current step text
//   node phase.js agents <n>                          set active subagent count
//   node phase.js update key=value ...                merge arbitrary fields
//   node phase.js clear                               remove state (bar hides)
//
// Fields: code, desc, done, total, started(ms), agents, step.
// Fail-open: any error exits 0 without throwing.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DIR  = path.join(os.homedir(), '.anti-hall');
const FILE = path.join(DIR, 'phase-state.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}
function write(obj) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(obj));
  } catch (e) { /* fail-open */ }
}

try {
  const [cmd, ...args] = process.argv.slice(2);
  let s = read();

  switch (cmd) {
    case 'set': {
      const [code, desc, done, total] = args;
      s = {
        code: String(code || ''),
        desc: String(desc || ''),
        done: parseInt(done, 10) || 0,
        total: parseInt(total, 10) || 0,
        started: Date.now(),
      };
      break;
    }
    case 'advance':
      s.done = (parseInt(s.done, 10) || 0) + (parseInt(args[0], 10) || 1);
      break;
    case 'step':
      s.step = String(args.join(' ') || '');
      break;
    case 'agents':
      s.agents = parseInt(args[0], 10);
      if (isNaN(s.agents)) delete s.agents;
      break;
    case 'update':
      for (const a of args) {
        const i = a.indexOf('=');
        if (i > 0) {
          const k = a.slice(0, i), v = a.slice(i + 1);
          s[k] = /^-?\d+$/.test(v) ? parseInt(v, 10) : v;
        }
      }
      break;
    case 'clear':
      try { fs.unlinkSync(FILE); } catch (e) { /* already gone */ }
      process.exit(0);
      break;
    default:
      process.stderr.write('phase.js: unknown command "' + cmd + '"\n');
      process.exit(0);
  }

  write(s);
} catch (e) {
  process.exit(0);
}
