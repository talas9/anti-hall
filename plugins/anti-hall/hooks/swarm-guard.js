#!/usr/bin/env node
// anti-hall :: swarm-guard (PreToolUse Agent/Task — anti-fork-bomb)
//
// Limits agent spawn rate to prevent runaway swarms that can make the OS unusable.
// Checks two conditions on every agent spawn:
//   1. SPAWN RATE: if >= CAP spawns occurred in the last 60 seconds, BLOCK.
//   2. MEMORY PRESSURE: if free RAM < 4% of total, BLOCK.
//
// Both checks are conservative. The spawn-rate cap (default 20 per 60s) is a
// ceiling against runaway loops, not a parallelism budget — normal parallel
// workflows rarely exceed it. The memory threshold (4%) is a last-resort OS
// safety guard; at that level the system is already under extreme pressure.
//
// Fail-open on ANY error: a bug here must never prevent legitimate agent spawns.
//
// Contract (Claude Code PreToolUse hook):
//   stdin  : JSON { tool_name, tool_input, ... }
//   stdout : JSON { decision: "block", reason: "..." } to block
//   exit 2 : to block; exit 0: allow
//   Fail-open on any error (exit 0).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SPAWN_CAP = 20;          // max spawns allowed in WINDOW_MS
const WINDOW_MS = 60000;       // 60-second rolling window
const MEM_FLOOR_RATIO = 0.04;  // block if freemem/totalmem < 4%

const LOG_DIR = path.join(os.tmpdir(), 'anti-hall');
const LOG_FILE = path.join(LOG_DIR, 'swarm-spawns.log');

function readTimestamps() {
  try {
    const data = fs.readFileSync(LOG_FILE, 'utf8');
    return data.trim().split(/\r?\n/)
      .map(line => parseInt(line.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0);
  } catch (_) {
    return [];
  }
}

function writeTimestamps(timestamps) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(LOG_FILE, timestamps.join('\n') + '\n', 'utf8');
  } catch (_) {
    // Fail-open: if we can't persist, don't block
  }
}

function main() {
  // Read stdin (not strictly needed for logic but required by hook protocol)
  try { fs.readFileSync(0, 'utf8'); } catch (_) {}

  const now = Date.now();

  // --- Memory pressure check (fast, no I/O) ---
  try {
    const free = os.freemem();
    const total = os.totalmem();
    if (total > 0 && (free / total) < MEM_FLOOR_RATIO) {
      const freeMb = Math.round(free / 1024 / 1024);
      const totalMb = Math.round(total / 1024 / 1024);
      const reason =
        'anti-hall swarm-guard: memory pressure critical (' + freeMb + ' MB free of ' +
        totalMb + ' MB total, < 4%). Blocking new agent spawn to protect OS stability. ' +
        'Let running agents finish and free memory before spawning more.';
      process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
      process.exit(2);
    }
  } catch (_) {
    // Fail-open: if os.freemem()/os.totalmem() throw, skip this check
  }

  // --- Spawn rate check ---
  let timestamps;
  try {
    timestamps = readTimestamps();
  } catch (_) {
    process.exit(0); // fail-open
  }

  // Prune entries older than WINDOW_MS
  const cutoff = now - WINDOW_MS;
  const recent = timestamps.filter(t => t > cutoff);

  // Append current spawn timestamp (before the cap check, so it counts)
  recent.push(now);
  try {
    writeTimestamps(recent);
  } catch (_) {
    // Fail-open: can't persist -> allow
    process.exit(0);
  }

  const count = recent.length;
  if (count > SPAWN_CAP) {
    const reason =
      'anti-hall swarm-guard: agent spawn-rate ceiling reached (' + (count - 1) +
      ' spawns in the last 60s, cap is ' + SPAWN_CAP + '). Pause new agents to avoid ' +
      'a runaway swarm that can make the OS unusable. Let running agents finish, ' +
      'then continue. Respect the concurrency cap (~min(16, cores-2)): never spawn ' +
      'unbounded agents; let in-flight agents finish before launching more waves.';
    process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
    process.exit(2);
  }

  process.exit(0);
}

try {
  main();
} catch (_) {
  // Fail-open.
}
process.exit(0);
