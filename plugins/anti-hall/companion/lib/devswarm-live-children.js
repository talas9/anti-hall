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

// liveChildState(home, cwd, opts) -> { live, known }.
// known=false means liveness could not be determined (unresolvable repoKey or
// a broken predicate); live is then false. Callers that need POSITIVE PROOF of
// a live child (the wake-path warning / Stop gate) act only on known && live.
// opts: { readDescriptors, repoKeyForWorktree, rowEligibility, env, fsi,
//   excludeHeldIgnored } — all injectable for tests. excludeHeldIgnored also
// skips children that are held (devswarm.heldPartitions) or archive-ignored,
// matching the parent gate's `archived || held || ignored` policy.
// excludeWaitingOnUser also skips a child that is idle on an unanswered prompt to the OWNER (a live session
// blocked on AskUserQuestion / ExitPlanMode): it cannot message anyone until the owner answers, so it is no
// reason to nag about a missing wake path.
function liveChildState(home, cwd, opts) {
  const o = opts || {};
  const d = descriptorLiveChildState(home, cwd, o);
  if (d.known && d.live) return d;
  // SECOND SOURCE (spawn-lag fix): the DevSwarm app's own workspace list, the source `roster` reports. A child that
  // was just spawned has no descriptor until its session registers itself, so the descriptor read alone said "no live
  // child workspaces" (and the watcher idle-skipped) while the roster already showed it active. POSITIVE proof only:
  // an unreadable app DB changes nothing.
  try { if (appHasLiveChild(home, cwd, o)) return { live: true, known: true }; } catch (_) { /* fail-open: the descriptor answer stands */ }
  return d;
}

// appHasLiveChild(home, cwd, o) -> bool. An ACTIVE, non-primary app workspace of this Primary's own repository that is
// not this Primary's checkout (and, with excludeHeldIgnored, not held / archive-ignored / marker-archived).
function appHasLiveChild(home, cwd, o) {
  const appDb = o.appDb || require('./devswarm-app-db.js');
  const snap = o.appSnapshot !== undefined ? o.appSnapshot : appDb.snapshot({ home, env: o.env });
  if (!snap || !Array.isArray(snap.workspaces)) return false;
  const repo = appDb.repositoryForWorktree(snap, cwd);
  if (!repo || repo.id == null) return false;
  const self = appDb.workspaceFor(snap, { worktreePath: cwd });
  const rowEligibility = o.rowEligibility || require('./row-eligibility.js').rowEligibility;
  for (const w of snap.workspaces) {
    if (!w || !w.active || w.archived || w.builderType === 'primary') continue;
    if (String(w.repositoryId) !== String(repo.id)) continue;
    if (self && w.id === self.id) continue;
    let skip = false;
    try {
      const projected = rowEligibility({ id: w.id, worktreePath: w.worktreePath, sessionId: w.sessionId || null },
        { home, env: o.env, fsi: o.fsi || fs, ...(o.excludeWaitingOnUser ? { liveness: true } : {}) });
      skip = !!(projected && (projected.markerArchived
        || (o.excludeHeldIgnored && (projected.held || projected.ignored))
        || (o.excludeWaitingOnUser && projected.waitingOnUser)));
    } catch (_) { skip = false; }
    if (!skip) return true;
  }
  return false;
}

function descriptorLiveChildState(home, cwd, opts) {
  const o = opts || {};
  const F = o.fsi || fs;
  try {
    const readDescriptors = o.readDescriptors || require('../devswarm-supervisor.js').readDescriptors;
    const descriptors = readDescriptors(home, F) || [];
    if (!descriptors.length) return { live: false, known: true };

    const repoKeyForWorktree = o.repoKeyForWorktree || require('./devswarm-repokey.js').repoKeyForWorktree;
    let selfKey = null;
    try { selfKey = repoKeyForWorktree(cwd); } catch (_) { selfKey = null; }
    if (!selfKey) return { live: false, known: false }; // can't scope to a project

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
      // row can never fabricate a live child.
      try {
        const projected = rowEligibility(
          { id: d.id, worktreePath: d.worktreePath, sessionId: d.sessionId, repoKey: dKey },
          { home, env: o.env, fsi: F, ...(o.excludeWaitingOnUser ? { liveness: true } : {}) },
        );
        archived = !!(projected && (projected.archived
          || (o.excludeHeldIgnored && (projected.held || projected.ignored))
          || (o.excludeWaitingOnUser && projected.waitingOnUser)));
      } catch (_) { archived = true; }
      if (!archived) return { live: true, known: true };
    }
    return { live: false, known: true };
  } catch (_) {
    return { live: false, known: false };
  }
}

// hasLiveChild(home, cwd, opts) -> boolean. Idle-skip semantics: FAIL-OPEN
// toward "has a live child" whenever liveness is unknown (see header).
function hasLiveChild(home, cwd, opts) {
  const s = liveChildState(home, cwd, opts);
  return s.known ? s.live : true;
}

// idleSkipApplies(home, cwd, opts) -> boolean. THE one idle-skip decision for
// a Primary's wake watcher: devswarm.wakeWatchIdleSkip on AND positive proof
// of zero live (non-held, non-ignored) children. Unknown liveness -> false
// (keep advising/arming). Shared by wake-watch's own gate and every surface
// that advises arming it (update.js, doctor), so they can never disagree.
function idleSkipApplies(home, cwd, opts) {
  const o = opts || {};
  try {
    let on = true;
    try { on = require('../../hooks/lib/settings.js').getWithEnv('devswarm', 'wakeWatchIdleSkip', true, o.env || process.env) !== false; }
    catch (_) { on = true; }
    if (!on) return false;
    const s = liveChildState(home, cwd, { ...o, excludeHeldIgnored: true });
    return !!(s.known && !s.live);
  } catch (_) { return false; }
}

module.exports = { hasLiveChild, liveChildState, idleSkipApplies };
