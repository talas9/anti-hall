'use strict';
// FROZEN COPY (test-only) of the scripts/devswarm.js identity resolvers as shipped at
// 86f6baa (v0.103.0 + B1), BEFORE mesh-redesign Phase 2 B2 routed them through
// companion/lib/identity.js: findGitToplevel, resolveCallerWorktree, canonicalMeshId,
// plus install-devswarm-ingest.js resolveWorktree and the POSIX primaryWorkspaceId
// formula they call. Kept so the equivalence proof compares against the real legacy
// values (spec 2.1(5): no `git show` at test time). Function bodies are verbatim
// except `inst.` prefixes dropped. Never edit; never require from plugins/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// install-devswarm-ingest.js worktreeRealPath + primaryWorkspaceId, POSIX branch.
function primaryWorkspaceId(wt) {
  let p = String(wt || '');
  try { p = fs.realpathSync(p); } catch (_) { p = path.resolve(p); }
  return `primary-${crypto.createHash('sha256').update(p).digest('hex').slice(0, 8)}`;
}

function resolveWorktree(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) return null;
    const top = String(r.stdout || '').trim();
    return top || null;
  } catch (_) {
    return null;
  }
}

function findGitToplevel(startDir) {
  try {
    let dir = path.resolve(String(startDir || ''));
    if (!dir) return null;
    for (;;) {
      try {
        fs.statSync(path.join(dir, '.git'));
        return dir;
      } catch (_) { /* keep walking up */ }
      const parent = path.dirname(dir);
      if (parent === dir) return null; // reached filesystem root, no .git found
      dir = parent;
    }
  } catch (_) {
    return null;
  }
}

function resolveCallerWorktree(cwd) {
  const c = cwd || process.cwd();
  const wt = resolveWorktree(c) || findGitToplevel(c) || null;
  if (!wt) return null;
  // SUBMODULE FIX (P1, defect d56bfaac2da0): a cwd inside a git SUBMODULE
  // resolves `wt` to the SUBMODULE's own toplevel here (both `resolveWorktree`
  // and `findGitToplevel` stop at the nearest `.git`), silently keying
  // identity/repoKey to the submodule instead of the superproject — the exact
  // mis-keying `companion/lib/devswarm-repokey.js`'s `gitCommonDir` already
  // guards against for repoKey derivation (its `.git/modules/` detection +
  // `--show-superproject-working-tree` re-resolution). `resolveCallerWorktree`
  // had no equivalent, so a caller invoked from inside a submodule registered/
  // read against the submodule toplevel while a sibling invocation from the
  // superproject root read/wrote the superproject key, flipping
  // `registeredRepoKey` between the two and failing closed as
  // `project-context-mismatch`. `--show-superproject-working-tree` is verified
  // to report the superproject root from inside ANY submodule and EMPTY from a
  // normal repo/the superproject itself, so this is safe to run unconditionally
  // (fail-open: any spawn failure or empty/self-referential result just keeps
  // the submodule-resolved `wt`, matching this function's pre-fix behavior).
  try {
    const superR = spawnSync('git', ['-C', wt, 'rev-parse', '--show-superproject-working-tree'], { encoding: 'utf8' });
    const superWt = (!superR.error && superR.status === 0) ? String(superR.stdout || '').trim() : '';
    if (superWt && superWt !== wt) return superWt;
  } catch (_) { /* fall through, keep the submodule-resolved wt */ }
  return wt;
}

function canonicalMeshId(worktreePath) {
  const top = resolveCallerWorktree(worktreePath) || worktreePath;
  return primaryWorkspaceId(top);
}

module.exports = { findGitToplevel, resolveCallerWorktree, canonicalMeshId, resolveWorktree, primaryWorkspaceId };
