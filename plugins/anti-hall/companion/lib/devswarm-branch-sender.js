'use strict';
// anti-hall :: devswarm-branch-sender — who sent a NATIVE message, from the branch it names.
//
// A native hivecontrol message carries `fromBranch` and no sender id, so a store row written by the
// native ingest (and the NDJSON line `inbox pull` mirrors) had `sender` NULL: `read-primary` printed
// `from: null` for the auto "DONE: <branch> ..." notices. DevSwarm names a workspace's checkout after
// its branch with `/` turned into `-` (`fix/foo-bar` -> `.../fix-foo-bar`), so the registry row whose
// worktree directory is that name IS the sender. Exactly one match or null: an ambiguous or unknown
// branch stays unattributed (never a guess). Pure; never throws.
//
// The engine mirrors this (ah-engine/src/dssup/ingest/import.rs `branch_sender`, keys
// devswarm_ingest.branch_dir_from / branch_dir_to).
const path = require('path');

const BRANCH_DIR_FROM = '/';
const BRANCH_DIR_TO = '-';
// A body "DONE: <branch> <dash> ..." names its branch even where the row lost its fromBranch (legacy rows).
const DONE_BRANCH_RE = /^DONE:\s+(\S+)\s/;

function dirNameOfBranch(branch) {
  return String(branch).split(BRANCH_DIR_FROM).join(BRANCH_DIR_TO);
}

// resolveBranchSender(registryRows, branch) -> id | null. `registryRows` = [{id, worktreePath}].
function resolveBranchSender(registryRows, branch) {
  try {
    if (branch == null || String(branch).trim() === '' || !Array.isArray(registryRows)) return null;
    const want = dirNameOfBranch(String(branch).trim());
    const hits = new Set();
    for (const r of registryRows) {
      if (!r || r.id == null || !r.worktreePath) continue;
      if (path.basename(String(r.worktreePath)) === want) hits.add(String(r.id));
    }
    return hits.size === 1 ? Array.from(hits)[0] : null;
  } catch (_) { return null; }
}

// branchOfDoneBody(body) -> the branch a legacy "DONE: <branch> ..." body names, or null.
function branchOfDoneBody(body) {
  const m = DONE_BRANCH_RE.exec(typeof body === 'string' ? body : '');
  return m ? m[1] : null;
}

module.exports = { resolveBranchSender, branchOfDoneBody, dirNameOfBranch };
