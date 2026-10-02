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
// Persisted shape: { version:1, scopes:{ "<repoKey>:<scope>": { reason, firstSeen,
// lastChecked, count } } }. Read tolerates absence/corruption/unknown shapes
// (-> empty); write is atomic tmp+rename; every function is fail-open (any error
// reads as "not suppressed", i.e. the pre-marker behaviour).

const fs = require('fs');
const path = require('path');

const FILE = 'repo-unknown.json';
const RECHECK_MS = 6 * 60 * 60 * 1000;

function markerPath(home) { return path.join(home, '.anti-hall', 'devswarm', FILE); }

// isRepoUnknownText(...strings) -> true when any carries hivecontrol's exact
// "Repository not found" error (ANSI colour codes in between are irrelevant).
function isRepoUnknownText() {
  for (let i = 0; i < arguments.length; i++) {
    if (typeof arguments[i] === 'string' && /Repository not found/i.test(arguments[i])) return true;
  }
  return false;
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

// isSuppressed(home, repoKey, scope, now) -> bool. True while a marker exists
// and its recheck is not yet due.
function isSuppressed(home, repoKey, scope, now) {
  try {
    const e = read(home)[keyOf(repoKey, scope)];
    if (!e || !Number.isFinite(e.lastChecked)) return false;
    const t = Number.isFinite(now) ? now : Date.now();
    return (t - e.lastChecked) < RECHECK_MS;
  } catch (_) { return false; }
}

// record(home, repoKey, scope, reason, now) -> { first: bool }. `first` is true
// only when no marker existed for this scope (the caller logs once on it).
function record(home, repoKey, scope, reason, now) {
  try {
    const t = Number.isFinite(now) ? now : Date.now();
    const scopes = read(home);
    const k = keyOf(repoKey, scope);
    const prev = scopes[k];
    const first = !(prev && Number.isFinite(prev.firstSeen));
    scopes[k] = {
      reason: String(reason || '').replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 300),
      firstSeen: first ? t : prev.firstSeen,
      lastChecked: t,
      count: (prev && Number.isFinite(prev.count) ? prev.count : 0) + 1,
    };
    write(home, scopes);
    return { first };
  } catch (_) { return { first: false }; }
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

module.exports = { RECHECK_MS, markerPath, isRepoUnknownText, read, isSuppressed, record, clear };
