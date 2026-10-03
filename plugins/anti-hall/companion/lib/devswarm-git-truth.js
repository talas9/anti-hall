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
//   gitMergeProof(worktreePath, opts) -> { merged, via, head, ref } — HEAD an
//     ancestor of the REMOTE default branch. The one merge proof shared by the
//     `gate --set merged` verb (records merged_verified) and auto-archive gate
//     (b). gitMergedInto(worktreePath, targetRef) is its boolean|null verdict.
//
// REPORT-ONLY DOCTRINE: nothing in this module blocks, kills, or archives
// anything. Callers surface what it reports; the one mechanical consumer is
// auto-archive gate (b), which only ever WITHHOLDS an archive on a non-true
// merge proof (fail-closed) — never kills or deletes.
// Same spawnSync convention as companion/lib/liveness.js's defaultGitCommitTs:
// an argv array (NEVER shell-interpolated), a short timeout, fail-open (never
// throw) on any error/non-zero/signal.

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

// gitMergeProof(worktreePath, opts) -> { merged, via, head, ref } — THE single
// merge proof shared by `scripts/devswarm.js gate --set merged` (which records
// the verdict as the `merged_verified` gate, bound to `head`) and auto-archive
// gate (b) (companion/lib/devswarm-lifecycle.js mergedFact). One rule, so the
// two can never disagree again: HEAD must be an ancestor of the REMOTE default
// branch, the origin/HEAD symbolic ref's target (e.g. origin/main). When
// origin/HEAD is unresolvable the default branch is UNKNOWN: the proof returns
// merged null with via 'default-branch-unknown' and never guesses one (not
// 'origin/<sourceBranch>': a workspace's source branch need not be the default
// branch, so containment in it proves nothing about the merge).
// A LOCAL branch ref is never consulted: a stale local `main` (behind
// origin/main) must not read as "not merged", and a local `main` carrying
// unpushed commits must not read as "merged". git always receives the FULL
// `refs/remotes/...` name: the short `origin/main` resolves a LOCAL branch
// literally named `origin/main` (refs/heads/origin/main) before the remote
// ref, so the short form could prove a merge against a local branch. `via`
// and `ref` in the result keep the short display name.
//   merged true  — HEAD is provably contained in the remote ref.
//   merged false — provably NOT (unmerged commits, or a squash/rebase merge:
//                  there is no squash detection; the caller decides what a
//                  false means — the gate verb reports it, auto-archive blocks).
//   merged null  — undeterminable (default branch unknown, ref missing
//                  locally, non-git dir, spawn failure).
// opts: { head? (bind the proof to this sha), ref? (explicit target),
// git? (cwd, args) -> { ok, status, out } — injectable for tests }.
function defaultGitRun(cwd, args) {
  try {
    const r = runGit(cwd, args);
    if (r.error || r.signal) return { ok: false, status: null, out: '' };
    return { ok: r.status === 0, status: r.status, out: String(r.stdout || '') };
  } catch (_) { return { ok: false, status: null, out: '' }; }
}

function gitMergeProof(worktreePath, opts) {
  const o = opts || {};
  const git = typeof o.git === 'function' ? o.git : defaultGitRun;
  const res = (merged, via, head, ref) => ({ merged, via, head: head || null, ref: ref || null });
  if (!worktreePath) return res(null, 'unproven');
  let head = typeof o.head === 'string' && o.head ? o.head : '';
  if (!head) {
    const h = git(worktreePath, ['rev-parse', 'HEAD']);
    head = h && h.ok ? String(h.out || '').trim() : '';
  }
  if (!head) return res(null, 'unproven');
  let ref = typeof o.ref === 'string' && o.ref ? o.ref : null;
  if (!ref) {
    const s = git(worktreePath, ['symbolic-ref', 'refs/remotes/origin/HEAD']);
    const m = s && s.ok ? /^refs\/remotes\/(origin\/.+)$/.exec(String(s.out || '').trim()) : null;
    if (!m) return res(null, 'default-branch-unknown', head);
    ref = m[1];
  }
  // full ref for git; `ref` stays the short display name
  const fullRef = /^origin\//.test(ref) ? 'refs/remotes/' + ref : ref;
  const v = git(worktreePath, ['rev-parse', '--verify', '--quiet', fullRef + '^{commit}']);
  if (!v || !v.ok) return res(null, 'unproven', head, ref);
  const r = git(worktreePath, ['merge-base', '--is-ancestor', head, fullRef]);
  if (r && r.status === 0) return res(true, 'git:' + ref, head, ref);
  if (r && r.status === 1) return res(false, 'git:not-ancestor', head, ref); // git's documented "not an ancestor"
  return res(null, 'unproven', head, ref); // 128 etc: a resolution failure, not a proven negative
}

// gitMergedInto(worktreePath, targetRef) -> boolean | null — gitMergeProof's
// verdict alone (true / false / null as documented there). REPORT-ONLY: a
// false is NOT proof "not merged" (a squash or rebase merge breaks ancestry).
function gitMergedInto(worktreePath, targetRef) {
  return gitMergeProof(worktreePath, { ref: targetRef }).merged;
}

module.exports = { GIT_TIMEOUT_MS, gitPushState, gitMergedInto, gitMergeProof, defaultBranchRef };
