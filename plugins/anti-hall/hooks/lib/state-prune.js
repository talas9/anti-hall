// anti-hall :: shared bounded self-pruning for per-session state files under
// ~/.anti-hall/.
//
// ROOT CAUSE (proven 2026-08-21): several hooks (task-tracker.js,
// speculation-guard.js, tasklist-guard.js, codex-nudge.js, and a few smaller
// advisory files) write one state file per session_id under ~/.anti-hall/ and
// NEVER delete it — nothing anywhere ever reads an OLD session's file back
// (grep for each prefix across the whole plugin turns up only the writer
// itself). Every session that ever ran an anti-hall-enabled hook leaves a
// permanent orphan. Over ~71 days of real usage this produced ~47K
// task-tracker-*.json files alone (plus ~7K speculation-guard-state-*, ~2.2K
// tasklist-guard-state-*, ~2K codex-nudge-state-*), ~58K entries total in
// ~/.anti-hall/. A separate, smaller contributor: doctor.js's self-tests
// invoke these hooks with a FRESH `doctor-*-<Date.now()>` session id on every
// `anti-hall:doctor` run specifically so the throttle/dedupe logic sees an
// unwritten session (by design, to measure a cold-start injection) — that
// deliberately creates one more permanent orphan per hook per doctor run.
//
// FIX: bounded, throttled, fail-open self-pruning. Called opportunistically
// from the SAME write path that already creates a session's own state file
// (no new hook, no new event). Design constraints (all deliberate):
//   - CHEAP on the hot path: a full readdir of ~/.anti-hall/ costs real time
//     (measured ~161ms at 58K entries) and must NOT happen on every hook
//     invocation. A per-prefix stamp file throttles the sweep to at most once
//     per SWEEP_THROTTLE_MS (default 6h — the same cadence task-tracker.js
//     already uses for its own FULL-injection window, so this piggybacks on
//     an established rhythm instead of inventing a new one).
//   - TTL default 7 days: long enough that no plausible still-open session
//     (including a long ralph/autopilot run or a resumed session) is ever
//     mid-TTL when pruned, short enough that the backlog cannot regrow past a
//     few thousand files even under heavy multi-session usage.
//   - NEVER deletes the current session's own file (exact filename match is
//     skipped even if somehow older than TTL, e.g. clock skew).
//   - FAIL-OPEN and SILENT: any fs error (missing dir, permission, ENOENT
//     mid-iteration, corrupt stamp file) is swallowed; pruning never throws
//     and never blocks the caller's real work.
//   - Pure Node built-ins only.
'use strict';

const fs = require('fs');
const path = require('path');

// Default TTL: 7 days. See header comment for justification.
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Default sweep throttle: 6h, matching task-tracker.js's own WINDOW_MS.
const DEFAULT_THROTTLE_MS = 6 * 60 * 60 * 1000;

// pruneStale({ stateDir, prefix, keepFile, ttlMs, throttleMs }) — best-effort,
// bounded, fail-open. Removes files in `stateDir` whose name starts with
// `prefix` and ends with `.json`, are older than `ttlMs` by mtime, and are not
// `keepFile` (the caller's OWN state file for the CURRENT session — always
// kept regardless of age). Throttled via a per-prefix stamp file so the
// readdir only happens at most once per `throttleMs`. Returns the number of
// files removed (0 on throttle-skip, no dir, or any error — callers should
// treat the return value as informational only, never as a signal to retry).
function pruneStale(opts) {
  try {
    const stateDir = opts && opts.stateDir;
    const prefix = opts && opts.prefix;
    if (!stateDir || !prefix) return 0;
    const keepFile = opts.keepFile ? path.basename(opts.keepFile) : null;
    const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
    const throttleMs = Number.isFinite(opts.throttleMs) ? opts.throttleMs : DEFAULT_THROTTLE_MS;

    const stampFile = path.join(stateDir, '.prune-stamp-' + prefix + '.json');
    const now = Date.now();
    try {
      const raw = fs.readFileSync(stampFile, 'utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        // Reject a future/non-finite stamp (clock skew, corruption) so a bad
        // value self-heals to "run now" instead of permanently suppressing
        // the sweep (mirror task-tracker.js's future-timestamp guard).
        if (parsed && Number.isFinite(parsed.lastSweep) && parsed.lastSweep <= now &&
            (now - parsed.lastSweep) < throttleMs) {
          return 0; // swept recently enough -> skip, no readdir
        }
      }
    } catch (_) {
      // No stamp / unreadable / corrupt -> proceed to sweep.
    }

    // Best-effort stamp write BEFORE the sweep so a crash mid-sweep still
    // throttles the next call (avoids a pathological repeat readdir storm).
    try { fs.writeFileSync(stampFile, JSON.stringify({ lastSweep: now }), 'utf8'); } catch (_) {}

    let entries;
    try {
      entries = fs.readdirSync(stateDir);
    } catch (_) {
      return 0;
    }

    let removed = 0;
    const fullPrefix = prefix + '-';
    for (const name of entries) {
      if (!name.startsWith(fullPrefix) || !name.endsWith('.json')) continue;
      if (keepFile && name === keepFile) continue; // never touch the live session's file
      const full = path.join(stateDir, name);
      try {
        const st = fs.statSync(full);
        if ((now - st.mtimeMs) > ttlMs) {
          fs.unlinkSync(full);
          removed++;
        }
      } catch (_) {
        // Skip this file, keep going — one bad entry must not abort the sweep.
      }
    }
    return removed;
  } catch (_) {
    return 0; // fail-open: pruning is best-effort, never a hard dependency
  }
}

module.exports = { pruneStale, DEFAULT_TTL_MS, DEFAULT_THROTTLE_MS };
