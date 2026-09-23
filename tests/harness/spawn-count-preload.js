'use strict';
// tests/harness/spawn-count-preload.js — a `--require` preload module (spec §5)
// that wraps node:child_process's spawnSync/spawn/execFileSync so a spawned
// hook/CLI process's OWN spawn fan-out can be measured from outside it. Each
// call appends one JSON line to the file named by process.env.ANTIHALL_SPAWN_LOG.
// Pure Node, no deps. Loaded via:
//   node --require ./spawn-count-preload.js <target.js> [...args]
// with ANTIHALL_SPAWN_LOG=<tmp file> set in the child's env before spawning it.

const fs = require('node:fs');
const cpMod = require('node:child_process');

const logPath = process.env.ANTIHALL_SPAWN_LOG;

function appendLine(obj) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, JSON.stringify(obj) + '\n'); } catch (_) { /* fail-open: never break the wrapped call */ }
}

function wrap(name, orig) {
  return function (...args) {
    appendLine({ fn: name, t: Date.now(), pid: process.pid });
    return orig.apply(this, args);
  };
}

if (logPath) {
  cpMod.spawnSync = wrap('spawnSync', cpMod.spawnSync);
  cpMod.spawn = wrap('spawn', cpMod.spawn);
  cpMod.execFileSync = wrap('execFileSync', cpMod.execFileSync);
  cpMod.execFile = wrap('execFile', cpMod.execFile);
  cpMod.execSync = wrap('execSync', cpMod.execSync);
  cpMod.exec = wrap('exec', cpMod.exec);
}

module.exports = { logPath };
