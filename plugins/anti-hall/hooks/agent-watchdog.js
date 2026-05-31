#!/usr/bin/env node
// agent-watchdog.js — scans ~/.anti-hall/agents/*.json heartbeat files and
// reports any that have not been updated within the staleness threshold.
//
// This is a HELPER the orchestrator runs manually (or on a ScheduleWakeup
// interval). It is NOT wired as a Claude Code hook — do not register it in
// hooks.json.
//
// Heartbeat convention:
//   Long/background subagents write ~/.anti-hall/agents/<id>.json periodically
//   while working. Format: { id, ts, status, step }
//     id      — unique agent identifier (string)
//     ts      — Date.now() at the time of the last write
//     status  — free-form string: "running", "done", "error", etc.
//     step    — current step description (optional; human-readable)
//
// Usage:
//   node agent-watchdog.js [threshold_ms]
//
//   threshold_ms — milliseconds before a heartbeat is considered stale.
//                  Default: 1200000 (20 minutes).
//
// Output (stdout):
//   One line per stale agent: STALE <id> last=<iso> age=<ms>ms status=<status> step=<step>
//   A summary line: summary: <stale>/<total> stale
//   Nothing is written to files; this is read-only.
//
// Exit codes:
//   0 — always (fail-open; stale agents are reported, not errored).
//
// Notes:
//   - Uses ~/.anti-hall/ (home dir) for consistency with phase.js and the
//     statusline — os.tmpdir() is NOT consistent across hook runners.
//   - Node built-ins only (fs, path, os). No shell, no /dev/stdin.
//   - Reads stdin via fd 0 (not /dev/stdin) if ever needed; not used here.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DEFAULT_THRESHOLD_MS = 1200000; // 20 minutes

function main() {
  const threshold = parseInt(process.argv[2], 10) || DEFAULT_THRESHOLD_MS;
  const dir = path.join(os.homedir(), '.anti-hall', 'agents');

  let entries = [];
  try {
    entries = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch (e) {
    // Directory does not exist or is unreadable — no agents running.
    process.stdout.write('summary: 0/0 stale\n');
    process.exit(0);
  }

  const now = Date.now();
  let staleCount = 0;
  const total = entries.length;

  for (const file of entries) {
    let data = null;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      // Unreadable or malformed — treat as stale with unknown id.
      const id = file.replace(/\.json$/, '');
      process.stdout.write(
        'STALE ' + id + ' last=unknown age=unknown status=unreadable step=\n'
      );
      staleCount++;
      continue;
    }

    const id     = (data && typeof data.id === 'string') ? data.id : file.replace(/\.json$/, '');
    const ts     = (data && typeof data.ts === 'number') ? data.ts : 0;
    const status = (data && typeof data.status === 'string') ? data.status : '';
    const step   = (data && typeof data.step === 'string') ? data.step : '';

    const age = now - ts;
    if (age >= threshold) {
      const lastIso = ts ? new Date(ts).toISOString() : 'unknown';
      process.stdout.write(
        'STALE ' + id +
        ' last=' + lastIso +
        ' age=' + age + 'ms' +
        ' status=' + (status || 'unknown') +
        ' step=' + step +
        '\n'
      );
      staleCount++;
    }
  }

  process.stdout.write('summary: ' + staleCount + '/' + total + ' stale\n');
}

try {
  main();
} catch (e) {
  // Fail-open.
  process.stdout.write('summary: 0/0 stale\n');
}
process.exit(0);
