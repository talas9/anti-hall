'use strict';
// Environment for a READ-ONLY git child. `git status` / `git diff` refresh the index and, to write it back, take
// .git/index.lock; a child that is killed at its timeout mid-refresh can leave that lock behind, which then blocks the
// user's own git. GIT_OPTIONAL_LOCKS=0 (documented in git(1)) makes those optional index writes skip the lock. Never use
// it to bound a command that must write: writes are not affected by the variable and must not be run under a short timeout.
function readOnlyGitEnv(base) {
  return Object.assign({}, base || process.env, { GIT_OPTIONAL_LOCKS: '0' });
}
module.exports = { readOnlyGitEnv };
