'use strict';
// anti-hall :: devswarm-git-truth — REPORT-ONLY git ground-truth checks for a
// DevSwarm child worktree. Two independent probes:
//
//   gitPushState(worktreePath)  -> { noUpstream, unpushed } | null — is this
//     worktree's current branch pushed, and does it even HAVE an upstream?
//     null means the probe itself failed (timeout, spawn error, unparseable
//     output) and proved NOTHING — callers must omit, never read it as a
//     "no upstream" fact. Field case this exists for: a child had 5 unpushed
//     commits and no upstream configured, yet had self-declared its `merged`
//     completion gate — nothing detected the single-copy-on-disk state until
//     now.
//
//   gitMergedInto(worktreePath, targetRef) -> boolean | null — best-effort
//     ancestry check (HEAD an ancestor of targetRef / the resolved default
//     branch) used to VERIFY (never gate) a child's self-declared `merged`
//     completion flag.
//
// REPORT-ONLY DOCTRINE: nothing in this module blocks, kills, or archives
// anything. Callers surface what it reports; they never act on it
// mechanically. Same spawnSync convention as companion/lib/liveness.js's
// defaultGitCommitTs — an argv array (NEVER shell-interpolated), a short
// timeout, fail-open (never throw) on any error/non-zero/signal.

const { spawnSync } = require('child_process');

const GIT_TIMEOUT_MS = 4000;

function runGit(worktreePath, args) {
  return spawnSync('git', ['-C', String(worktreePath), ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
}

// gitPushState(worktreePath) -> { noUpstream: boolean, unpushed: number|null } | null.
//
// `git rev-list --count @{u}..HEAD` exits non-zero (git ran, resolved the repo,
// and definitively told us there is no `@{u}` upstream ref) whenever the
// current branch has no upstream configured — that IS the noUpstream signal,
// not a probe error to swallow silently. Distinguishing "no upstream" from "0
// unpushed" matters: collapsing the two would report a branch with real
// unpushed work (and no upstream at all) as merely 0-unpushed, hiding exactly
// the field case this module exists for. NEVER unpushed:0 for a no-upstream
// repo.
//
// A PROBE FAILURE — spawn error (r.error: git not installed, bad cwd), a
// killed process (r.signal: the GIT_TIMEOUT_MS hang), a non-git directory
// (worktreePath isn't a git repo at all — git's exit 128 "fatal: not a git
// repository" is INDISTINGUISHABLE by exit code alone from its exit 128
// "fatal: no upstream configured", so stderr text is the only mechanical way
// to tell them apart), or a missing worktreePath — is NOT a "no upstream"
// determination; git never resolved a repo and told us anything about ITS
// upstream. Those return null so callers omit the keys entirely (fail-open to
// "we don't know" — see writeHeartbeat in devswarm-child-turn.js), never
// fabricating noUpstream:true for a transient timeout, a missing git binary,
// or a directory that was never a git repo in the first place.
const NOT_A_REPO_RE = /not a git repository/i;
function gitPushState(worktreePath) {
  if (!worktreePath) return null;
  let r;
  try {
    r = runGit(worktreePath, ['rev-list', '--count', '@{u}..HEAD']);
  } catch (_) {
    return null;
  }
  if (r.error || r.signal) return null; // probe never completed — unknown, not a fact
  if (r.status !== 0) {
    if (NOT_A_REPO_RE.test(String(r.stderr || ''))) return null; // not a git repo — probe failure, not "no upstream"
    return { noUpstream: true, unpushed: null }; // git resolved the repo and confirmed: no upstream
  }
  const n = parseInt(String(r.stdout || '').trim(), 10);
  if (!Number.isFinite(n) || n < 0) return null; // unparseable output — probe failure, not a fact
  return { noUpstream: false, unpushed: n };
}

// defaultBranchRef(worktreePath) -> 'origin/<branch>' | null. Cheap, LOCAL-ONLY
// resolution via the origin/HEAD symbolic ref (no network call — reads the ref
// cache set at clone/fetch time, same convention `git remote show origin`
// relies on internally). null when unresolvable (a fresh clone before `git
// remote set-head` has run, no `origin` remote, or any git failure) — callers
// must fail open, never guess a branch name.
function defaultBranchRef(worktreePath) {
  if (!worktreePath) return null;
  let r;
  try {
    r = runGit(worktreePath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
  } catch (_) {
    return null;
  }
  if (r.error || r.status !== 0 || r.signal) return null;
  const ref = String(r.stdout || '').trim(); // e.g. 'refs/remotes/origin/main'
  const m = /^refs\/remotes\/(origin\/.+)$/.exec(ref);
  return m ? m[1] : null;
}

// gitMergedInto(worktreePath, targetRef) -> boolean | null. Best-effort
// ancestry check: is HEAD an ancestor of targetRef (or the resolved default
// branch when targetRef is omitted)?
//
//   true  — HEAD is provably an ancestor of the target (a fast-forward /
//           regular merge landed it).
//   false — HEAD is provably NOT an ancestor. This is a REAL negative, but is
//           NOT proof "not merged" — a squash or rebase merge legitimately
//           breaks ancestry even though the work IS merged. Callers must
//           treat false as "could not verify", never as grounds to block
//           anything (REPORT-ONLY doctrine — see scripts/devswarm.js cmdGate).
//   null  — UNKNOWN: no resolvable target ref, a non-git worktree, or any
//           spawn failure. NEVER fabricated into true/false.
function gitMergedInto(worktreePath, targetRef) {
  if (!worktreePath) return null;
  const ref = targetRef || defaultBranchRef(worktreePath);
  if (!ref) return null;
  let r;
  try {
    r = runGit(worktreePath, ['merge-base', '--is-ancestor', 'HEAD', ref]);
  } catch (_) {
    return null;
  }
  if (r.error || r.signal) return null;
  if (r.status === 0) return true;
  if (r.status === 1) return false; // git's documented "not an ancestor" exit code
  return null; // any other exit code (e.g. 128, bad ref/object) is a resolution failure, not a proven negative
}

module.exports = { GIT_TIMEOUT_MS, gitPushState, gitMergedInto, defaultBranchRef };
