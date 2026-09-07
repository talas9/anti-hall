'use strict';
// defect d56bfaac2da0 (P1): resolveCallerWorktree must re-resolve a submodule
// cwd to the SUPERPROJECT toplevel, matching companion/lib/devswarm-repokey.js's
// gitCommonDir superproject re-resolution. Fails on HEAD (resolveCallerWorktree
// returns the submodule toplevel), passes with the patch applied.
//
// MODULE_UNDER_TEST env var selects which devswarm.js to load:
//   HEAD    -> the real repo file (plugins/anti-hall/scripts/devswarm.js)
//   PATCHED -> the scratch copy with d56bfaac2da0's fix applied (d56.js)
// Isolates HOME/USERPROFILE to a scratch temp dir; never touches ~/.anti-hall.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = process.env.MODULE_UNDER_TEST
  || path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'scripts', 'devswarm.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function mkSuperprojectWithSubmodule() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-d56-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-d56-home-'));
  const subRepo = path.join(root, 'sub-origin');
  const superRepo = path.join(root, 'super');

  fs.mkdirSync(subRepo, { recursive: true });
  git(['init', '-q', '-b', 'main'], subRepo);
  git(['config', 'user.email', 'a@b.c'], subRepo);
  git(['config', 'user.name', 'a'], subRepo);
  fs.writeFileSync(path.join(subRepo, 'f.txt'), 'x');
  git(['add', '.'], subRepo);
  git(['commit', '-q', '-m', 'init'], subRepo);

  fs.mkdirSync(superRepo, { recursive: true });
  git(['init', '-q', '-b', 'main'], superRepo);
  git(['config', 'user.email', 'a@b.c'], superRepo);
  git(['config', 'user.name', 'a'], superRepo);
  fs.writeFileSync(path.join(superRepo, 'root.txt'), 'x');
  git(['add', '.'], superRepo);
  git(['commit', '-q', '-m', 'init'], superRepo);
  git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subRepo, 'modules/sub'], superRepo);
  git(['commit', '-q', '-m', 'add submodule'], superRepo);

  const submodulePath = path.join(superRepo, 'modules', 'sub');
  return { superRepo, submodulePath, home, root };
}

test('resolveCallerWorktree resolves a submodule cwd to the SUPERPROJECT toplevel (d56bfaac2da0)', () => {
  const { superRepo, submodulePath, home, root } = mkSuperprojectWithSubmodule();
  try {
    const dev = require(MODULE_PATH);
    assert.equal(typeof dev.resolveCallerWorktree, 'function',
      'resolveCallerWorktree must be exported for direct testing');

    const fromSubmodule = dev.resolveCallerWorktree(submodulePath);
    const fromSuperRoot = dev.resolveCallerWorktree(superRepo);

    // The bug: a caller cd'd into the submodule gets keyed to the submodule's
    // own toplevel, disagreeing with a caller invoked from the superproject
    // root — which is exactly the "registeredRepoKey flips" symptom.
    assert.equal(
      fromSubmodule,
      fromSuperRoot,
      'a submodule cwd must resolve to the SAME worktree as the superproject root, '
      + `got submodule->${fromSubmodule} vs superRoot->${fromSuperRoot}`
    );
    assert.equal(fs.realpathSync(fromSubmodule), fs.realpathSync(superRepo));
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete require.cache[require.resolve(MODULE_PATH)];
  }
});
