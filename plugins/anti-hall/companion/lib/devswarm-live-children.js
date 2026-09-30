'use strict';
// anti-hall :: devswarm-live-children — "does THIS Primary have at least one
// LIVE (non-archived) child workspace registered for its own project?" (#39,
// devswarm.wakeWatchIdleSkip).
//
// WHY IT EXISTS: a Primary with zero live children gains nothing from an
// armed wake-watch Monitor — nothing will ever message it, since a message
// can only ever come FROM a child (or from the Primary itself, which never
// needs to wake itself). Re-arming that watcher every cron tick anyway is
// pure token waste with no coverage benefit. This predicate is the one read
// both `scripts/devswarm.js`'s `inbox tick` and
// `companion/lib/devswarm-wake-watch.js`'s startup gate share, so the two
// surfaces can never disagree about "0 live children".
//
// A "child" here is any OTHER registered descriptor (companion/devswarm-
// supervisor.js readDescriptors) whose own repoKey (companion/lib/devswarm-
// repokey.js repoKeyForWorktree) matches this Primary's own repoKey and
// whose worktreePath does not realpath-match this Primary's own cwd. "Live"
// means companion/lib/row-eligibility.js's `.archived` reads false for it —
// neither anti-hall's own archive marker nor an app-side archive applies (an
// archived-only child counts as 0 live, by design). row-eligibility.js is
// THE ONE projection every row-level "is this archived?" question must go
// through (tests/hygiene/archived-predicates-single-projection.test.js) —
// this module never calls row-state.js's isRowArchived directly.
//
// FAIL-OPEN TOWARD "HAS A LIVE CHILD" (returns true) on every uncertainty —
// an unreadable registry, an unresolvable repoKey, or any other read
// failure. This predicate only ever SKIPS arming the watcher on POSITIVE
// PROOF of zero live children; any doubt must behave exactly like today
// (arm it / re-arm it). Pure reads: never writes, never spawns beyond the
// git reads repoKeyForWorktree already performs.

const fs = require('fs');

// hasLiveChild(home, cwd, opts) -> boolean.
// opts: { readDescriptors, repoKeyForWorktree, rowEligibility, env, fsi } —
// all injectable for tests; each defaults to the real module it wraps.
function hasLiveChild(home, cwd, opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  try {
    const readDescriptors = o.readDescriptors || require('../devswarm-supervisor.js').readDescriptors;
    const descriptors = readDescriptors(home, F) || [];
    if (!descriptors.length) return false;

    const repoKeyForWorktree = o.repoKeyForWorktree || require('./devswarm-repokey.js').repoKeyForWorktree;
    let selfKey = null;
    try { selfKey = repoKeyForWorktree(cwd); } catch (_) { selfKey = null; }
    if (!selfKey) return true; // can't scope to a project -> fail-open toward "has children"

    let selfReal = cwd;
    try { selfReal = F.realpathSync(cwd); } catch (_) { selfReal = cwd; }

    const rowEligibility = o.rowEligibility || require('./row-eligibility.js').rowEligibility;

    for (const d of descriptors) {
      if (!d || !d.worktreePath || !d.id) continue;

      let dReal = d.worktreePath;
      try { dReal = F.realpathSync(d.worktreePath); } catch (_) { /* archived worktrees routinely no longer resolve */ }
      if (dReal === selfReal) continue; // this Primary's own row, not a child

      let dKey = null;
      try { dKey = repoKeyForWorktree(d.worktreePath); } catch (_) { dKey = null; }
      if (dKey !== selfKey) continue; // a different project's registered workspace

      let archived = true; // fail-open toward "archived" here so ONE unreadable
      // row can never fabricate a live child; the outer catch below still
      // fails open toward "has children" for a genuinely broken predicate.
      try {
        const projected = rowEligibility(
          { id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId, repoKey: dKey },
          { home, env: o.env, fsi: F },
        );
        archived = !!(projected && projected.archived);
      } catch (_) { archived = true; }
      if (!archived) return true;
    }
    return false;
  } catch (_) {
    return true; // fail-open: any surprise here must never suppress a real watcher
  }
}

module.exports = { hasLiveChild };
