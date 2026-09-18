'use strict';
// devswarm-repokey — gitCommonDirNoSpawn / repoKeyForWorktreeFast (P0 fix:
// devswarm-parent-inbox.js's per-row #36 structural filter used to spawn one
// `git rev-parse --git-common-dir` PER summary row, PER UserPromptSubmit turn
// — measured as 74% of that hook's wall time under load (up to ~8.9s,
// crossing the 10s hook timeout). These tests prove the fs-only resolver
// produces the IDENTICAL repoKey the git-spawn resolver produces, for every
// on-disk shape git itself writes, with ZERO spawns for the common cases —
// using REAL temp directories (mimicking git's own on-disk layout) rather
// than a real git binary, so the test never spawns git either. Isolated to
// os.tmpdir(); touches no HOME/USERPROFILE and no real repo.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { gitCommonDirNoSpawn, repoKeyForWorktreeFast, sanitizeRepoName } = repokey;

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function expectedKey(commonDirRealPath) {
  const base = sanitizeRepoName(path.basename(path.dirname(commonDirRealPath)));
  const suffix = crypto.createHash('sha256').update(commonDirRealPath).digest('hex').slice(0, 6);
  return `${base}-${suffix}`;
}

// spawnCountingRun — an io.run double that counts invocations. Passed as the
// fallback io so a test can PROVE zero spawns happened for the fs-resolvable
// cases (repoKeyForWorktreeFast must never call this for them), while still
// letting the git-spawn fallback path (rare shapes) work when the test
// deliberately wants it to.
function spawnCountingRun(rawOut) {
  const calls = [];
  return {
    calls,
    run(spec) {
      calls.push(spec);
      return rawOut == null ? { ok: false, raw: '' } : { ok: true, raw: rawOut };
    },
  };
}

test('gitCommonDirNoSpawn: main checkout (".git" is a directory) resolves to that directory, zero spawns', () => {
  const root = mkTmp('repokey-main-');
  try {
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(gitDir);
    const spawner = spawnCountingRun(null);
    const cd = gitCommonDirNoSpawn(root, { io: { run: spawner.run } });
    assert.equal(cd, fs.realpathSync(gitDir));
    assert.equal(spawner.calls.length, 0, 'must not spawn for a resolvable main checkout');

    const key = repoKeyForWorktreeFast(root, { io: { run: spawner.run } });
    assert.equal(key, expectedKey(fs.realpathSync(gitDir)));
    assert.equal(spawner.calls.length, 0, 'repoKeyForWorktreeFast must not spawn either');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gitCommonDirNoSpawn: linked worktree (".git" file -> gitdir -> commondir) matches git\'s own on-disk shape, zero spawns', () => {
  const mainRoot = mkTmp('repokey-linkmain-');
  const wtRoot = mkTmp('repokey-linkwt-');
  try {
    const mainGitDir = path.join(mainRoot, '.git');
    fs.mkdirSync(mainGitDir);
    const worktreesDir = path.join(mainGitDir, 'worktrees', 'my-wt');
    fs.mkdirSync(worktreesDir, { recursive: true });
    // Real git writes an ABSOLUTE gitdir path in the linked worktree's own
    // ".git" file, and a RELATIVE ("../..") commondir file inside its private
    // gitdir (verified live against tf3-plc-caps-wt/tf3-plc-bridge on this
    // machine, 2026-09-18) — reproduce both forms exactly.
    fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${worktreesDir}\n`);
    fs.writeFileSync(path.join(worktreesDir, 'commondir'), '../..\n');

    const spawner = spawnCountingRun(null);
    const cd = gitCommonDirNoSpawn(wtRoot, { io: { run: spawner.run } });
    assert.equal(cd, fs.realpathSync(mainGitDir));
    assert.equal(spawner.calls.length, 0, 'must not spawn for a resolvable linked worktree');

    const mainKey = repoKeyForWorktreeFast(mainRoot, { io: { run: spawner.run } });
    const wtKey = repoKeyForWorktreeFast(wtRoot, { io: { run: spawner.run } });
    assert.equal(wtKey, mainKey, 'linked worktree and its main checkout must resolve to the SAME repoKey');
    assert.equal(spawner.calls.length, 0);
  } finally {
    fs.rmSync(mainRoot, { recursive: true, force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
  }
});

test('repoKeyForWorktreeFast: a worktree path that no longer exists on disk returns null with ZERO spawns (option c)', () => {
  const gone = path.join(os.tmpdir(), 'repokey-definitely-does-not-exist-' + Date.now());
  const spawner = spawnCountingRun('/somewhere/.git'); // would succeed if ever called
  assert.equal(gitCommonDirNoSpawn(gone, { io: { run: spawner.run } }), null);
  assert.equal(repoKeyForWorktreeFast(gone, { io: { run: spawner.run } }), null);
  assert.equal(spawner.calls.length, 0, 'a gone worktree must never reach the git-spawn fallback');
});

test('gitCommonDirNoSpawn: a submodule shape (".git/modules/<name>") is deferred (returns null) rather than guessed', () => {
  const root = mkTmp('repokey-submod-super-');
  try {
    const modulesDir = path.join(root, '.git', 'modules', 'sub');
    fs.mkdirSync(modulesDir, { recursive: true });
    const subRoot = mkTmp('repokey-submod-wt-');
    try {
      fs.writeFileSync(path.join(subRoot, '.git'), `gitdir: ${modulesDir}\n`);
      // No commondir file inside modulesDir — matches the real on-disk shape
      // a submodule's own gitdir has (verified live: skycrew/skyflutter,
      // 2026-09-18) — modulesDir itself is what git-common-dir would report,
      // and finalizeCommonDir's shared submodule-shape regex must catch it.
      const cd = gitCommonDirNoSpawn(subRoot);
      assert.equal(cd, null, 'the no-spawn resolver must defer the submodule remap, never guess "modules-<hash>"');

      // repoKeyForWorktreeFast must fall back to the git-spawn resolver for
      // this ONE shape (never fabricate a key from the raw "modules" segment).
      const spawner = spawnCountingRun(''); // superproject probe returns empty -> pre-fix submodule-local resolution
      const key = repoKeyForWorktreeFast(subRoot, { io: { run: spawner.run } });
      assert.ok(spawner.calls.length > 0, 'the submodule shape must fall back to a git spawn, not silently misresolve');
      assert.ok(!/^modules-/.test(key), 'must never key off the literal "modules" segment');
    } finally {
      fs.rmSync(subRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('repoKeyForWorktreeFast: malformed ".git" file (no "gitdir:" line) falls back to the git-spawn resolver, never throws', () => {
  const root = mkTmp('repokey-malformed-');
  try {
    fs.writeFileSync(path.join(root, '.git'), 'not a gitdir line at all\n');
    const spawner = spawnCountingRun(null); // spawn fallback also fails -> null, never a throw
    assert.equal(gitCommonDirNoSpawn(root), null);
    assert.doesNotThrow(() => repoKeyForWorktreeFast(root, { io: { run: spawner.run } }));
    assert.equal(repoKeyForWorktreeFast(root, { io: { run: spawner.run } }), null);
    assert.ok(spawner.calls.length > 0, 'a malformed .git shape is a real resolution failure, not a "gone" short-circuit, so it MAY fall back to spawn');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
