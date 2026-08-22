'use strict';
// anti-hall :: devswarm-gate-state — shared path/shape helpers for
// devswarm-parent-gate.js's per-session loop-state files
// (~/.anti-hall/devswarm/parent-gate/<session>.json), extracted so the Stop
// hook, scripts/devswarm.js's `gate-intent` CLI verb, and the forward
// migration below all agree on ONE path derivation and ONE persisted shape —
// never three reimplementations that could silently drift.
//
// NOT to be confused with the *-replies.json files in the SAME directory
// (companion/lib/devswarm-reply-state.js) — those are repoKey-keyed reply
// logs for a different axis (unanswered questions); this module only ever
// touches the session-keyed gate-loop-state files.
//
// Pure fs. No git, no store, no daemon. Fail-open everywhere: an unreadable
// or malformed file is skipped, never thrown, never deleted.

const fs = require('fs');
const path = require('path');

// gateStateDir(home) -> ~/.anti-hall/devswarm/parent-gate
function gateStateDir(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'parent-gate');
}

// stateFileFor(sessionId, home) — byte-for-byte the same derivation
// devswarm-parent-gate.js originally defined locally: sanitize sessionId to a
// safe filename charset (never the user's project tree; survives `cd`).
function stateFileFor(sessionId, home) {
  const safe = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(gateStateDir(home), safe + '.json');
}

// isGateStateFilename(name) -> true for a session-keyed gate-loop-state file
// (`<safe>.json`), false for a `*-replies.json` reply-state file or anything
// else in the same directory.
function isGateStateFilename(name) {
  return typeof name === 'string' && /\.json$/.test(name) && !/-replies\.json$/i.test(name);
}

// migrateGateIntentsShape(home, { dryRun }) -> { scanned, migrated,
// alreadyCurrent, pending, errors }
//
// Forward migration for the additive `intents`/`intentAcks` persisted-shape
// change: every existing gate-loop-state file gets both keys added
// (`intents: {}`, `intentAcks: 0`) if either is missing, with every OTHER
// field preserved byte-for-byte. This is a courtesy normalization, not a
// correctness prerequisite — the hook itself already defaults missing
// `intents`/`intentAcks` to `{}`/`0` on read (a pre-fix state file keeps
// working unchanged even without this migration ever running) — but the
// repo's persisted-shape-migration discipline still requires an explicit
// forward migration to exist so tooling that expects the full shape (and a
// human reading the file) never has to special-case "old" vs "new" rows.
//
// IDEMPOTENT: a file that already carries both keys is left byte-identical
// (counted as alreadyCurrent, never rewritten). FAIL-OPEN: an unreadable or
// unparseable file is counted under `errors` and left completely untouched —
// never deleted, never truncated, never overwritten with a guess. NO-DELETE:
// only ever a full read-then-atomic-rewrite (tmp + rename) of the SAME file,
// preserving every existing field.
function migrateGateIntentsShape(home, opts) {
  const o = opts || {};
  const dryRun = !!o.dryRun;
  const report = { scanned: 0, migrated: 0, alreadyCurrent: 0, pending: 0, errors: 0 };
  let dir;
  try {
    dir = gateStateDir(home);
  } catch (_) { return report; }
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return report; } // no dir -> nothing to migrate
  for (const name of names) {
    if (!isGateStateFilename(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
    } catch (_) { report.errors++; continue; }
    report.scanned++;
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (_) { report.errors++; continue; }
    const trimmed = raw.trim();
    let parsed;
    try {
      parsed = trimmed ? JSON.parse(trimmed) : {};
    } catch (_) { report.errors++; continue; } // corrupt/unparseable -> leave untouched, never overwrite
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { report.errors++; continue; }

    const hasIntents = Object.prototype.hasOwnProperty.call(parsed, 'intents');
    const hasIntentAcks = Object.prototype.hasOwnProperty.call(parsed, 'intentAcks');
    if (hasIntents && hasIntentAcks) { report.alreadyCurrent++; continue; }

    report.pending++;
    if (dryRun) continue;

    const next = Object.assign({}, parsed);
    if (!hasIntents) next.intents = {};
    if (!hasIntentAcks) next.intentAcks = 0;

    try {
      const tmp = p + '.' + process.pid + '.' + Date.now() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(next));
      fs.renameSync(tmp, p);
      report.migrated++;
    } catch (_) {
      report.errors++; // best-effort: source file is untouched on any failure here
    }
  }
  return report;
}

module.exports = {
  gateStateDir,
  stateFileFor,
  isGateStateFilename,
  migrateGateIntentsShape,
};
