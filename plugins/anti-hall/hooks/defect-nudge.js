#!/usr/bin/env node
'use strict';
// anti-hall :: defect-nudge (SessionStart)
//
// Non-blocking, once-per-24h nudge surfacing the file-based defect channel
// (hooks/lib/defect-store.js). Deliberately registered on SessionStart, NOT
// Stop — this is never a forced ack, never blocking; the opposite of
// devswarm-parent-gate.js's DEFAULT_CAP=3 forced-ack escalation.
//
// TWO BRANCHES (mutually exclusive per session, decided by cwd):
//   - In the anti-hall repo itself (maintainer): "N open defect reports,
//     oldest Nd" — a triage nudge.
//   - In ANY other repo (a reporter): "rulings on N defects you reported" —
//     only if a defect file this repo reported into has a ruling line
//     appended AFTER this repo's own report line.
//
// INJECTION SAFETY: defect files are written by OTHER agents in OTHER repos
// — untrusted data (sym/repro/claimed/observed/proj/sid/note are all
// reporter-supplied). The emitted line contains ZERO reporter-supplied
// substrings — counts and ages only, from two fixed format strings. Mirrors
// command-guard.js's closed-vocabulary block-reason discipline ("NEVER
// reflects" attacker-controlled content).
//
// Stamp-throttled to once per 24h via ~/.anti-hall/.defects-nudge-stamp.json
// (same { lastSweep } shape as hooks/lib/state-prune.js's stamp files) so the
// bounded (<=200-file) scan is not repeated every session. Fail-open and
// silent on any error.
//
// Contract (Claude Code SessionStart hook):
//   stdin  : JSON { hook_event_name, session_id, cwd, ... }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } } | nothing
//   exit 0 : always

const fs = require('fs');
const path = require('path');

const THROTTLE_MS = 24 * 60 * 60 * 1000;

function readStdinCwd() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return process.cwd();
    const obj = JSON.parse(raw);
    return (obj && typeof obj.cwd === 'string' && obj.cwd) ? obj.cwd : process.cwd();
  } catch (_) {
    return process.cwd();
  }
}

function isAntiHallRepo(cwd) {
  try {
    return fs.existsSync(path.join(cwd, 'plugins', 'anti-hall', '.claude-plugin', 'plugin.json'));
  } catch (_) {
    return false;
  }
}

// checkStampAndArm(home) -> true if the sweep should run now (and stamps it
// immediately, best-effort, so a crash mid-sweep still throttles the next
// call — same idiom as state-prune.js).
function checkStampAndArm(store, home) {
  const stampFile = store.nudgeStampFile(home);
  const now = Date.now();
  try {
    const raw = fs.readFileSync(stampFile, 'utf8').trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Number.isFinite(parsed.lastSweep) && parsed.lastSweep <= now &&
          (now - parsed.lastSweep) < THROTTLE_MS) {
        return false; // swept recently enough
      }
    }
  } catch (_) {
    // no stamp / unreadable -> proceed
  }
  try {
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, JSON.stringify({ lastSweep: now }), 'utf8');
  } catch (_) { /* best-effort */ }
  return true;
}

function daysAgo(iso, now) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now - ms) / (24 * 60 * 60 * 1000)));
}

// maintainerLine(store, home, now) -> the fixed-format triage nudge, or ''
// when there are no open defects.
function maintainerLine(store, home, now) {
  const defects = store.listDefects({ home });
  const open = defects.filter((d) => d.status === 'open');
  if (open.length === 0) return '';
  let oldestDays = 0;
  for (const d of open) {
    oldestDays = Math.max(oldestDays, daysAgo(d.firstSeen, now));
  }
  return `anti-hall: ${open.length} open defect reports, oldest ${oldestDays}d — /anti-hall:defects`;
}

// reporterLine(store, home, cwd, now) -> the fixed-format ruling nudge, or ''
// when nothing this repo reported has a later ruling.
function reporterLine(store, home, cwd, now) {
  const proj = path.basename(cwd);
  const defects = store.listDefects({ home });
  let count = 0;
  for (const d of defects) {
    const full = store.showDefect(d.fp, home);
    if (!full || !Array.isArray(full.lines)) continue;
    let lastOwnReportIdx = -1;
    for (let i = 0; i < full.lines.length; i++) {
      const line = full.lines[i];
      if (line.t === 'report' && line.proj === proj) lastOwnReportIdx = i;
    }
    if (lastOwnReportIdx === -1) continue;
    const hasLaterRuling = full.lines.some((line, i) => i > lastOwnReportIdx && line.t === 'ruling');
    if (hasLaterRuling) count++;
  }
  if (count === 0) return '';
  return `anti-hall: rulings on ${count} defects you reported — /anti-hall:defects mine`;
}

function main() {
  const store = require(path.join(__dirname, 'lib', 'defect-store.js'));

  try {
    const sg = require('./skip-guard.js');
    if (sg.isSkipped('defect-nudge')) return;
  } catch (_) { /* skip-guard missing => no-op */ }

  const cwd = readStdinCwd();
  const home = process.env.HOME || process.env.USERPROFILE;

  if (!checkStampAndArm(store, home)) return;

  const now = Date.now();
  const line = isAntiHallRepo(cwd)
    ? maintainerLine(store, home, now)
    : reporterLine(store, home, cwd, now);

  if (!line) return;

  const out = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: line,
    },
  };
  // Synchronous write: avoids the macOS node 18/20 async-pipe-flush truncation
  // process.stdout.write can cause when the process exits immediately after.
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block or slow session start.
}
process.exit(0);
