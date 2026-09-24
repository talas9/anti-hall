#!/usr/bin/env node
// anti-hall :: jev-weekly-scorecard (SessionStart) — a once-a-week, ADVISORY
// nudge pointing at `/anti-hall:jev` when the 7-day `jev report` data shows an
// integration has EARNED a KEEP or REMOVE verdict but its jev.json mode has
// not been promoted/demoted to match yet. Never changes any mode itself —
// read-only over jev-assist.ndjson + jev.json, same posture as jev-report.js.
//
// GATING (all silent, no output, when any of these apply):
//   - Jev not enabled (`jev.json` `enabled` !== true) — no point nagging about
//     a feature that is off.
//   - `jev.json` `weeklyNotice` === false (default true — opt-out, not opt-in).
//   - This session is a DevSwarm CHILD workspace (hooks/lib/devswarm-role.js's
//     isChildWorkspace) — "main-thread-only": a child workspace is automated,
//     not an interactive session a human is reading SessionStart output from;
//     only the Primary/ordinary session gets this notice.
//   - The weekly latch (~/.anti-hall/state/jev-weekly-notice.json,
//     {lastCheckedTs}) shows a check already ran within the last 7 days.
//
// WEEKLY LATCH: updated on EVERY run of the check once the above gates pass —
// not only when a notice actually fires. This keeps the cadence to AT MOST
// once per 7 days regardless of outcome (a week with nothing ready to switch
// still consumes that week's check; the next check is exactly 7 days later,
// never sooner).
//
// VERDICT SELECTION: reuses scripts/jev-report.js's OWN buildReport() (7-day
// window, the same KEEP/REVIEW/REMOVE thresholds every other jev report uses
// — no separate logic to drift). An integration is "ready to switch" when:
//   - suggestion is KEEP AND its current mode is NOT already "on" -> ON, or
//   - suggestion is REMOVE AND its current mode is NOT already "off" -> OFF.
// The FIRST such integration (report's own sort: calls desc) is named in the
// notice; if none qualify, the latch still updates (see above) but nothing is
// printed.
//
// Contract:
//   stdin  : JSON { session_id, transcript_path, cwd, source, hook_event_name }
//   stdout : JSON { hookSpecificOutput: { hookEventName, additionalContext } },
//            or nothing when gated/no candidate.
//   exit 0 : ALWAYS — fail-open on any error, never blocks session start.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function jevConfigPath(home) {
  return path.join(home, '.anti-hall', 'jev.json');
}

function readJevJson(home) {
  try {
    const raw = fs.readFileSync(jevConfigPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function latchPath(home) {
  return path.join(home, '.anti-hall', 'state', 'jev-weekly-notice.json');
}

function readLatch(home) {
  try {
    const raw = fs.readFileSync(latchPath(home), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeLatch(home, state) {
  try {
    const p = latchPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) {
    // best-effort only — a latch write failure must never block session start.
  }
}

// pickCandidate(report, cfg) -> {id, direction: 'on'|'off'} | null.
// `report.integrations` is already sorted calls-desc (buildReport's own
// contract) — the first qualifying row is the one named.
function pickCandidate(report, cfg) {
  const { getMode } = require('./lib/jev-assist.js');
  for (const r of report.integrations) {
    const mode = getMode(r.id, cfg);
    if (r.suggestion === 'KEEP' && mode !== 'on') return { id: r.id, direction: 'on' };
    if (r.suggestion === 'REMOVE' && mode !== 'off') return { id: r.id, direction: 'off' };
  }
  return null;
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    return;
  }
  let payload = {};
  try { payload = JSON.parse(raw); } catch (_) { payload = {}; }

  const home = os.homedir();
  const cfg = readJevJson(home);
  if (cfg.enabled !== true) return; // Jev off entirely — nothing to check.
  if (cfg.weeklyNotice === false) return; // explicit opt-out (default true).

  // "main-thread-only": never nag a DevSwarm child workspace's automated
  // session — only the interactive Primary/ordinary session.
  try {
    const { isChildWorkspace } = require('./lib/devswarm-role.js');
    if (isChildWorkspace(process.env)) return;
  } catch (_) { /* fail-open: lib missing/throwing -> treat as not-a-child */ }

  const now = Date.now();
  const latch = readLatch(home);
  const lastCheckedTs = Number.isFinite(latch.lastCheckedTs) ? latch.lastCheckedTs : 0;
  if (now - lastCheckedTs < SEVEN_DAYS_MS) return; // already checked this week.

  // Consume this week's check REGARDLESS of outcome (see header) — written
  // before the report even runs so a crash mid-report can never turn into a
  // tight re-check loop on every SessionStart.
  writeLatch(home, { lastCheckedTs: now });

  let report;
  try {
    const { buildReport, readLines } = require('../scripts/jev-report.js');
    report = buildReport(readLines(home), { days: 7 });
  } catch (_) {
    return; // fail-open: no report -> no notice
  }
  if (!report || !Array.isArray(report.integrations) || report.integrations.length === 0) return;

  const candidate = pickCandidate(report, cfg);
  if (!candidate) return;

  const additionalContext = `Jev scorecard: ${candidate.id} ready to switch ` +
    `${candidate.direction === 'on' ? 'ON' : 'OFF'} — run /anti-hall:jev`;

  const hookEventName = typeof payload.hook_event_name === 'string' && payload.hook_event_name
    ? payload.hook_event_name
    : 'SessionStart';

  const out = {
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  };

  // Synchronous write to fd 1 — see verify-first-full.js's header for why
  // process.stdout.write is unsafe here (async pipe-flush truncation race).
  fs.writeSync(1, JSON.stringify(out) + '\n');
}

try {
  main();
} catch (_) {
  // Fail-open: never block session start.
}
process.exit(0);
