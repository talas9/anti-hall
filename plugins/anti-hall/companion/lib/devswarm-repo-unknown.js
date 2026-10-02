'use strict';
// devswarm-repo-unknown.js — terminal-state marker for "hivecontrol no longer
// knows this repository" (`Repository not found. Make sure to pass the git root
// path.`). Field: a repoKey hivecontrol had forgotten made the supervisor's
// reconcile sweep re-run the same failing `workspace list all` / `message-count`
// calls every sweep, forever, and re-log the identical failure each time.
//
// That condition is TERMINAL for the repoKey until hivecontrol learns the repo
// again, so it is recorded ONCE (reason + timestamps) in a small additive file
// and the failing native calls are suppressed until a recheck is due
// (RECHECK_MS), after which ONE attempt re-tests it: success clears the marker,
// failure refreshes it. Detect-and-report only: this never moves, deletes or
// rewrites a descriptor, store, worktree or any repo content.
//
// SAFETY: one hit is NOT terminal. hivecontrol prints the same text for a wrong
// cwd and a transient app-start failure, so a LIVE child (not archived / held /
// ignored) is NEVER suppressed and never reported ok on this error: it is retried
// every sweep and keeps reporting the failure. For terminal rows (and a repoKey
// with no live row) suppression engages only after SUPPRESS_AFTER consecutive
// sweeps with the same error; a success or a different error resets the count.
//
// Persisted shape: { version:1, scopes:{ "<repoKey>:<scope>": { reason, firstSeen,
// lastChecked, count, streak } } }. An earlier shape without `streak` is read as
// already suppressed. Read tolerates absence/corruption/unknown shapes
// (-> empty); write is atomic tmp+rename; every function is fail-open (any error
// reads as "not suppressed", i.e. the pre-marker behaviour).

const fs = require('fs');
const path = require('path');

const FILE = 'repo-unknown.json';
const RECHECK_MS = 6 * 60 * 60 * 1000;
const SUPPRESS_AFTER = 3;

function markerPath(home) { return path.join(home, '.anti-hall', 'devswarm', FILE); }

const stripAnsi = (t) => String(t).replace(/\u001b\[[0-9;]*m/g, '');

// isRepoUnknownText(...strings) -> true when any string has a LINE that IS
// hivecontrol's error: `Error: Repository not found. Make sure to pass the git
// root path.` (the sentence, optionally behind `Error:` and the CLI's
// `hivecontrol <cmd> exited N:` prefix, ANSI colour ignored). A longer unrelated
// message that merely contains the words does not match.
const LINE_RE = /^(?:hivecontrol\b[^:]*\bexited \d+:\s*)?(?:Error:\s*)?Repository not found\.?(?:\s+Make sure to pass the git root path\.?)?$/i;
function isRepoUnknownText() {
  for (let i = 0; i < arguments.length; i++) {
    if (typeof arguments[i] !== 'string') continue;
    for (const line of stripAnsi(arguments[i]).split(/\r?\n/)) {
      if (LINE_RE.test(line.trim())) return true;
    }
  }
  return false;
}

// rowTerminal(row, { home, env, now }) -> true only when the row is archived,
// held or archive-ignored (row-eligibility.js, the one projection). A live row,
// or any error reading the projection, is NOT terminal (fail-open: keep pulling).
function rowTerminal(row, o) {
  try {
    const e = require('./row-eligibility.js').rowEligibility(
      { id: row.id, worktreePath: row.worktreePath || null, sessionId: row.sessionId || null },
      { home: o.home, env: o.env, now: o.now });
    return !!(e.archived || e.held || e.ignored);
  } catch (_) { return false; }
}

function read(home) {
  try {
    const p = JSON.parse(fs.readFileSync(markerPath(home), 'utf8'));
    if (p && typeof p === 'object' && p.scopes && typeof p.scopes === 'object' && !Array.isArray(p.scopes)) return p.scopes;
  } catch (_) { /* absent/corrupt -> empty */ }
  return {};
}

function write(home, scopes) {
  try {
    const p = markerPath(home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, scopes }));
    fs.renameSync(tmp, p);
    return true;
  } catch (_) { return false; }
}

const keyOf = (repoKey, scope) => String(repoKey) + ':' + String(scope);

// A marker from before `streak` existed was only written for a suppressed scope.
const streakOf = (e) => (Number.isFinite(e.streak) ? e.streak : SUPPRESS_AFTER);
const cleanReason = (r) => stripAnsi(String(r || '')).trim().slice(0, 300);

// isSuppressed(home, repoKey, scope, now) -> bool. True while a marker exists
// and its recheck is not yet due.
function isSuppressed(home, repoKey, scope, now) {
  try {
    const e = read(home)[keyOf(repoKey, scope)];
    if (!e || !Number.isFinite(e.lastChecked)) return false;
    if (streakOf(e) < SUPPRESS_AFTER) return false;
    const t = Number.isFinite(now) ? now : Date.now();
    return (t - e.lastChecked) < RECHECK_MS;
  } catch (_) { return false; }
}

// record(home, repoKey, scope, reason, now) -> { first, suppressed, engaged }. `engaged`: suppression just began. `first`:
// no marker existed for this scope. `suppressed`: the same error has now been
// seen SUPPRESS_AFTER sweeps in a row, so the caller may skip the scope (a
// different error than the last one restarts the count at 1). Callers pass only
// terminal scopes; a live row must not call this at all.
function record(home, repoKey, scope, reason, now) {
  try {
    const t = Number.isFinite(now) ? now : Date.now();
    const scopes = read(home);
    const k = keyOf(repoKey, scope);
    const prev = scopes[k];
    const first = !(prev && Number.isFinite(prev.firstSeen));
    const r = cleanReason(reason);
    const same = !first && prev.reason === r;
    const streak = (same ? streakOf(prev) : 0) + 1;
    scopes[k] = {
      reason: r,
      firstSeen: first ? t : prev.firstSeen,
      lastChecked: t,
      count: (prev && Number.isFinite(prev.count) ? prev.count : 0) + 1,
      streak,
    };
    write(home, scopes);
    const suppressed = streak >= SUPPRESS_AFTER;
    return { first, suppressed, engaged: suppressed && !(same && streakOf(prev) >= SUPPRESS_AFTER) };
  } catch (_) { return { first: false, suppressed: false, engaged: false }; }
}

// clear(home, repoKey, scope) -> void. Drops the marker (the repo is known
// again). No write when there is nothing to clear.
function clear(home, repoKey, scope) {
  try {
    const scopes = read(home);
    const k = keyOf(repoKey, scope);
    if (!(k in scopes)) return;
    delete scopes[k];
    write(home, scopes);
  } catch (_) { /* fail-open */ }
}

module.exports = { RECHECK_MS, SUPPRESS_AFTER, markerPath, isRepoUnknownText, rowTerminal, read, isSuppressed, record, clear };
