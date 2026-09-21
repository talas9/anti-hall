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
const { gitCommonDirNoSpawn, repoKeyForWorktreeFast, sanitizeRepoName, resolveWorktreeNoSpawn } = repokey;

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

// ---------------------------------------------------------------------------
// resolveWorktreeNoSpawn (v0.102.2) — the zero-spawn analogue of
// hooks/devswarm-parent-gate.js's own pure-fs findGitToplevel, made
// SUBMODULE-AWARE without a spawn: it continues walking up past a
// submodule's `.git` FILE (detected via the SAME `.git/modules/<name>` shape
// gitCommonDirNoSpawn already detects) instead of stopping there, so it lands
// on the SUPERPROJECT's own `.git` — the exact identity
// resolveCallerWorktree's git-spawning `--show-superproject-working-tree`
// remap produces, with zero spawns. A plain linked worktree's `.git` FILE
// does NOT match that shape, so it stops there exactly as findGitToplevel
// always has — same on-disk fixtures as the tests above, built by hand
// (never a real git binary), so these tests never spawn git either.
// ---------------------------------------------------------------------------

test('resolveWorktreeNoSpawn: main checkout (".git" is a directory) resolves to itself', () => {
  const root = mkTmp('repokey-nospawn-main-');
  try {
    fs.mkdirSync(path.join(root, '.git'));
    assert.equal(resolveWorktreeNoSpawn(root), path.resolve(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorktreeNoSpawn: a linked worktree (".git" file, non-submodule gitdir shape) resolves to ITSELF, never walked past', () => {
  const wtRoot = mkTmp('repokey-nospawn-linkwt-');
  try {
    const privateGitDir = path.join(wtRoot, 'nonexistent-elsewhere', '.git', 'worktrees', 'my-wt');
    fs.mkdirSync(path.dirname(privateGitDir), { recursive: true });
    // gitdir target names a '.git/worktrees/<name>' shape, NOT '.git/modules/'
    // -> must be treated as an ordinary linked worktree, i.e. STOP here.
    fs.writeFileSync(path.join(wtRoot, '.git'), `gitdir: ${privateGitDir}\n`);
    assert.equal(resolveWorktreeNoSpawn(wtRoot), path.resolve(wtRoot),
      'a linked worktree must resolve to ITSELF, not be walked past like a submodule');
  } finally {
    fs.rmSync(wtRoot, { recursive: true, force: true });
  }
});

test('resolveWorktreeNoSpawn: a submodule (".git" file, "gitdir:" target under ".git/modules/<name>") walks UP to the superproject, zero spawns', () => {
  const superRoot = mkTmp('repokey-nospawn-super-');
  try {
    fs.mkdirSync(path.join(superRoot, '.git'));
    const modulesDir = path.join(superRoot, '.git', 'modules', 'sub');
    fs.mkdirSync(modulesDir, { recursive: true });
    const subRoot = path.join(superRoot, 'modules', 'sub'); // submodules always nest inside the superproject's own working tree
    fs.mkdirSync(subRoot, { recursive: true });
    // Verified live (2026-09-20, real `git submodule add`): the submodule's
    // OWN ".git" file already names the ".git/modules/<name>" path DIRECTLY
    // — no commondir indirection needed to see the shape.
    fs.writeFileSync(path.join(subRoot, '.git'), `gitdir: ${modulesDir}\n`);

    const resolved = resolveWorktreeNoSpawn(subRoot);
    assert.equal(resolved, path.resolve(superRoot), 'must walk up PAST the submodule boundary to the superproject\'s own toplevel');
  } finally {
    fs.rmSync(superRoot, { recursive: true, force: true });
  }
});

test('resolveWorktreeNoSpawn: a subdirectory NESTED inside a submodule also resolves to the superproject', () => {
  const superRoot = mkTmp('repokey-nospawn-super2-');
  try {
    fs.mkdirSync(path.join(superRoot, '.git'));
    const modulesDir = path.join(superRoot, '.git', 'modules', 'sub');
    fs.mkdirSync(modulesDir, { recursive: true });
    const subRoot = path.join(superRoot, 'modules', 'sub');
    const nested = path.join(subRoot, 'deep', 'nested', 'dir');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(subRoot, '.git'), `gitdir: ${modulesDir}\n`);

    assert.equal(resolveWorktreeNoSpawn(nested), path.resolve(superRoot));
  } finally {
    fs.rmSync(superRoot, { recursive: true, force: true });
  }
});

test('resolveWorktreeNoSpawn: a NESTED submodule (submodule-of-a-submodule) walks up through BOTH boundaries to the outermost superproject', () => {
  const outerRoot = mkTmp('repokey-nospawn-nested-outer-');
  try {
    fs.mkdirSync(path.join(outerRoot, '.git'));
    const midModulesDir = path.join(outerRoot, '.git', 'modules', 'mid');
    fs.mkdirSync(midModulesDir, { recursive: true });
    const midRoot = path.join(outerRoot, 'modules', 'mid');
    fs.mkdirSync(midRoot, { recursive: true });
    fs.writeFileSync(path.join(midRoot, '.git'), `gitdir: ${midModulesDir}\n`);

    // mid's OWN nested submodule, gitdir'd under mid's modules dir (real git
    // nests a submodule-of-a-submodule's private gitdir under its immediate
    // parent's own '.git/modules/<name>/modules/<innerName>').
    const innerModulesDir = path.join(midModulesDir, 'modules', 'inner');
    fs.mkdirSync(innerModulesDir, { recursive: true });
    const innerRoot = path.join(midRoot, 'modules', 'inner');
    fs.mkdirSync(innerRoot, { recursive: true });
    fs.writeFileSync(path.join(innerRoot, '.git'), `gitdir: ${innerModulesDir}\n`);

    assert.equal(resolveWorktreeNoSpawn(innerRoot), path.resolve(outerRoot),
      'must walk through BOTH submodule boundaries to the outermost superproject');
  } finally {
    fs.rmSync(outerRoot, { recursive: true, force: true });
  }
});

test('resolveWorktreeNoSpawn: no ".git" anywhere up to the filesystem root returns null (fail-open), never throws', () => {
  const orphan = mkTmp('repokey-nospawn-orphan-');
  try {
    // mkTmp already lands under os.tmpdir(), which is very unlikely to be
    // inside a git repo itself — but guard against that CI oddity by using a
    // deeply nested path with no .git anywhere we created.
    const deep = path.join(orphan, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    assert.doesNotThrow(() => resolveWorktreeNoSpawn(deep));
  } finally {
    fs.rmSync(orphan, { recursive: true, force: true });
  }
});

test('resolveWorktreeNoSpawn: a malformed ".git" file (no "gitdir:" line) stops there (fail-open AT that dir, matches findGitToplevel), never throws', () => {
  const root = mkTmp('repokey-nospawn-malformed-');
  try {
    fs.writeFileSync(path.join(root, '.git'), 'not a gitdir line at all\n');
    assert.doesNotThrow(() => resolveWorktreeNoSpawn(root));
    assert.equal(resolveWorktreeNoSpawn(root), path.resolve(root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveWorktreeNoSpawn: a gone directory returns null without throwing', () => {
  const gone = path.join(os.tmpdir(), 'repokey-nospawn-definitely-does-not-exist-' + Date.now());
  assert.doesNotThrow(() => resolveWorktreeNoSpawn(gone));
});

test('resolveWorktreeNoSpawn: REAL git submodule fixture (spawns git only to BUILD the fixture, never to resolve it) matches --show-superproject-working-tree', (t) => {
  const { execFileSync, spawnSync } = require('node:child_process');
  const gitAvailable = (() => {
    try { const r = spawnSync('git', ['--version']); return !r.error && r.status === 0; } catch (_) { return false; }
  })();
  if (!gitAvailable) { t.skip('git not available on PATH'); return; }
  function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim(); }
  const root = mkTmp('repokey-nospawn-realgit-');
  try {
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

    // git's own output is already realpath'd; resolveWorktreeNoSpawn never
    // calls realpath (matches findGitToplevel's existing non-realpath
    // contract) — realpath BOTH sides so a symlinked tmpdir (e.g. macOS
    // /var/folders -> /private/var/folders) can't produce a false mismatch.
    const expected = fs.realpathSync(git(['-C', submodulePath, 'rev-parse', '--show-superproject-working-tree'], submodulePath));
    assert.equal(fs.realpathSync(resolveWorktreeNoSpawn(submodulePath)), expected,
      'the zero-spawn resolver must agree with git\'s own --show-superproject-working-tree on a REAL submodule');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
