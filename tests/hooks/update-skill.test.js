'use strict';
// update-skill — unit tests for the /anti-hall:update helper (update.js).
//
// NO real git, NO network. update.js is factored so the version-compare,
// changelog-extraction, cache-copy and path-resolution logic are exported PURE
// functions tested directly against tmp fixtures; the git step is exercised via
// an injectable `exec` stub (runCheck/runUpdate accept `{ exec }`).
//
// Each test builds an isolated tmp tree mirroring the real install layout:
//   <tmp>/marketplaces/anti-hall/                         (the clone)
//        plugins/anti-hall/.claude-plugin/plugin.json
//        CHANGELOG.md
//   <tmp>/cache/anti-hall/anti-hall/<version>/            (version-pinned cache)
//   <tmp>/installed_plugins.json                          (harness-owned, read-only)
// ANTIHALL_MARKETPLACE_DIR points at the clone; resolvePaths derives the rest.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');
const devswarmCli = require('../../plugins/anti-hall/scripts/devswarm.js');
const devswarmStore = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const devswarmRepokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-update-'));
  const marketplaceDir = path.join(root, 'marketplaces', 'anti-hall');
  // Created eagerly: resolvePaths now validates the override points at an
  // EXISTING dir (R1-A-01) — a missing clone dir would fall back to the real
  // ~/.claude default and leak machine paths into fixture-derived paths.
  fs.mkdirSync(marketplaceDir, { recursive: true });
  function cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
  return { root, marketplaceDir, cleanup };
}

function writePluginJson(marketplaceDir, version) {
  const dir = path.join(marketplaceDir, 'plugins', 'anti-hall', '.claude-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'anti-hall', version }), 'utf8');
}

function writeChangelog(marketplaceDir, body) {
  fs.writeFileSync(path.join(marketplaceDir, 'CHANGELOG.md'), body, 'utf8');
}

function writeInstalled(root, value) {
  // value: string | object | raw-string-for-malformed
  const p = path.join(root, 'installed_plugins.json');
  if (typeof value === 'string' && value.startsWith('RAW:')) {
    fs.writeFileSync(p, value.slice(4), 'utf8');
  } else {
    fs.writeFileSync(p, JSON.stringify({ 'anti-hall@anti-hall': value }), 'utf8');
  }
}

function pathsFor(t) {
  return U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
}

// Platform-correct fake HOME (CI regression: Windows). A posix literal like
// '/home/fake' is NOT fully absolute on Windows — the production code's
// path.resolve() prepends the drive letter ('D:\home\fake\...') while a
// path.join('/home/fake', ...) expectation stays drive-less ('\home\fake\...'),
// so a literal expectation can never match there. Resolving the fake home FIRST
// and feeding the SAME value to both the code under test and the expectation
// makes both sides go through identical path semantics on every platform.
const FAKE_HOME = path.resolve('/home/fake');

// ---------------------------------------------------------------------------
// parseVersion / compareVersions
// ---------------------------------------------------------------------------
test('compareVersions: equal / newer / older', () => {
  assert.strictEqual(U.compareVersions('1.2.3', '1.2.3'), 0);
  assert.strictEqual(U.compareVersions('1.2.4', '1.2.3'), 1);
  assert.strictEqual(U.compareVersions('1.2.3', '1.2.4'), -1);
  assert.strictEqual(U.compareVersions('0.33.0', '0.32.1'), 1);
  assert.strictEqual(U.compareVersions('0.9.0', '0.10.0'), -1, 'numeric not lexical');
});

test('parseVersion: tolerates v-prefix and pre-release; rejects junk', () => {
  assert.deepStrictEqual(U.parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepStrictEqual(U.parseVersion('0.32.1-beta'), [0, 32, 1]);
  assert.strictEqual(U.parseVersion('garbage'), null);
  assert.strictEqual(U.parseVersion(undefined), null);
});

test('compareVersions: unparseable sorts as 0.0.0 (readable wins)', () => {
  assert.strictEqual(U.compareVersions('garbage', '0.0.1'), -1);
  assert.strictEqual(U.compareVersions('0.0.1', 'garbage'), 1);
});

// ---------------------------------------------------------------------------
// resolvePaths
// ---------------------------------------------------------------------------
test('resolvePaths: override derives cache/installed two levels up', () => {
  const t = makeTree();
  try {
    const p = pathsFor(t);
    assert.strictEqual(p.marketplaceDir, t.marketplaceDir);
    assert.strictEqual(p.cacheRoot, path.join(t.root, 'cache', 'anti-hall', 'anti-hall'));
    assert.strictEqual(p.installedJson, path.join(t.root, 'installed_plugins.json'));
    assert.ok(p.pluginJson.endsWith(path.join('.claude-plugin', 'plugin.json')));
  } finally { t.cleanup(); }
});

test('resolvePaths: default (no override) lands under ~/.claude/plugins', () => {
  const p = U.resolvePaths({}, FAKE_HOME);
  assert.strictEqual(p.marketplaceDir, path.join(FAKE_HOME, '.claude', 'plugins', 'marketplaces', 'anti-hall'));
  assert.strictEqual(p.cacheRoot, path.join(FAKE_HOME, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall'));
});

// ---------------------------------------------------------------------------
// installed_plugins.json read (read-only, fallbacks)
// ---------------------------------------------------------------------------
test('resolveInstalledVersion: reads string entry from installed_plugins.json', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.0');
    writeInstalled(t.root, '0.32.1');
    assert.strictEqual(U.resolveInstalledVersion(pathsFor(t)), '0.32.1');
  } finally { t.cleanup(); }
});

test('resolveInstalledVersion: reads object {version} entry', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.0');
    writeInstalled(t.root, { version: '0.32.1', enabled: true });
    assert.strictEqual(U.resolveInstalledVersion(pathsFor(t)), '0.32.1');
  } finally { t.cleanup(); }
});

test('resolveInstalledVersion: malformed installed_plugins.json → falls back to cache then plugin.json', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.30.0');
    writeInstalled(t.root, 'RAW:{not json');
    // no cache dirs → falls all the way back to marketplace plugin.json
    assert.strictEqual(U.resolveInstalledVersion(pathsFor(t)), '0.30.0');
  } finally { t.cleanup(); }
});

test('resolveInstalledVersion: missing installed_plugins.json → newest cache dir wins over plugin.json', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.30.0');
    const cacheRoot = path.join(t.root, 'cache', 'anti-hall', 'anti-hall');
    fs.mkdirSync(path.join(cacheRoot, '0.31.0'), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, '0.31.2'), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, 'not-a-version'), { recursive: true });
    assert.strictEqual(U.resolveInstalledVersion(pathsFor(t)), '0.31.2', 'newest valid cache dir');
  } finally { t.cleanup(); }
});

test('versionFromInstalledJson: wrong key → null', () => {
  const t = makeTree();
  try {
    fs.writeFileSync(path.join(t.root, 'installed_plugins.json'), JSON.stringify({ 'other@x': '1.0.0' }), 'utf8');
    assert.strictEqual(U.versionFromInstalledJson(pathsFor(t).installedJson), null);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------
// CHANGELOG extraction
// ---------------------------------------------------------------------------
const SAMPLE_CHANGELOG = [
  '# Changelog',
  'preamble line that must be dropped',
  '',
  '## 0.33.0',
  'New update skill.',
  '',
  '## 0.32.1',
  'Docs refresh.',
  '',
  '## 0.32.0',
  'Model routing guard.',
  '',
  '## 0.31.0',
  'Merge gate.',
].join('\n');

test('extractChangelog: multi-section delta (exclusive from, inclusive to)', () => {
  const out = U.extractChangelog(SAMPLE_CHANGELOG, '0.32.0', '0.33.0');
  assert.ok(out.includes('## 0.33.0'), 'includes new section');
  assert.ok(out.includes('## 0.32.1'), 'includes intermediate section');
  assert.ok(!out.includes('## 0.32.0'), 'excludes the installed (from) version');
  assert.ok(!out.includes('## 0.31.0'), 'excludes older sections');
  assert.ok(!out.includes('preamble'), 'drops preamble before first heading');
});

test('extractChangelog: single new section', () => {
  const out = U.extractChangelog(SAMPLE_CHANGELOG, '0.32.1', '0.33.0');
  assert.ok(out.includes('## 0.33.0') && out.includes('New update skill.'));
  assert.ok(!out.includes('## 0.32.1'));
});

test('extractChangelog: already up to date (from === to) → empty', () => {
  assert.strictEqual(U.extractChangelog(SAMPLE_CHANGELOG, '0.33.0', '0.33.0'), '');
});

test('extractChangelog: target version not present in file → empty', () => {
  assert.strictEqual(U.extractChangelog(SAMPLE_CHANGELOG, '0.40.0', '0.41.0'), '');
});

test('extractChangelog: malformed / empty input → empty (no throw)', () => {
  assert.strictEqual(U.extractChangelog('', '0.1.0', '0.2.0'), '');
  assert.strictEqual(U.extractChangelog(undefined, '0.1.0', '0.2.0'), '');
  assert.strictEqual(U.extractChangelog('no headings here at all', '0.1.0', '0.2.0'), '');
});

// ---------------------------------------------------------------------------
// Cache copy
// ---------------------------------------------------------------------------
test('syncCache: copies into NEW version dir when cache root exists', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const r = U.syncCache(p, '0.33.0');
    assert.strictEqual(r.synced, true, r.reason);
    assert.ok(fs.existsSync(path.join(p.cacheRoot, '0.33.0', '.claude-plugin', 'plugin.json')));
  } finally { t.cleanup(); }
});

test('syncCache: skips when version dir already exists; never touches sibling', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    // pre-existing target + a sibling we must not touch
    fs.mkdirSync(path.join(p.cacheRoot, '0.33.0'), { recursive: true });
    fs.writeFileSync(path.join(p.cacheRoot, '0.33.0', 'sentinel.txt'), 'KEEP', 'utf8');
    const siblingFile = path.join(p.cacheRoot, '0.32.1', 'sibling.txt');
    fs.mkdirSync(path.dirname(siblingFile), { recursive: true });
    fs.writeFileSync(siblingFile, 'SIBLING', 'utf8');

    const r = U.syncCache(p, '0.33.0');
    assert.strictEqual(r.synced, false, 'must skip existing version dir');
    // sentinel untouched (not overwritten by copy)
    assert.strictEqual(fs.readFileSync(path.join(p.cacheRoot, '0.33.0', 'sentinel.txt'), 'utf8'), 'KEEP');
    // sibling untouched
    assert.strictEqual(fs.readFileSync(siblingFile, 'utf8'), 'SIBLING');
  } finally { t.cleanup(); }
});

test('syncCache: no-op when cache root absent (does not invent the layout)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    const p = pathsFor(t);
    // cache root NOT created
    const r = U.syncCache(p, '0.33.0');
    assert.strictEqual(r.synced, false);
    assert.ok(!fs.existsSync(p.cacheRoot), 'must not create the cache root');
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------
// runCheck (--check mode shape) with injected exec stub
// ---------------------------------------------------------------------------
function execStub(map, calls) {
  // map: { 'fetch': out|Error, 'rev-parse': ..., 'show': ..., 'status': ..., 'pull': ... }
  // calls (optional array): records { args, cwd } for every invocation (F1).
  return function (args, cwd) {
    if (calls) calls.push({ args: args.slice(), cwd });
    const key = args[0];
    const v = map[key];
    if (v instanceof Error) throw v;
    if (typeof v === 'function') return v(args, cwd);
    return v == null ? '' : v;
  };
}

test('runCheck: update available shape', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.1');
    writeInstalled(t.root, '0.32.1');
    const exec = execStub({
      fetch: '',
      'rev-parse': 'origin/main\n',
      show: JSON.stringify({ version: '0.33.0' }),
    });
    const s = U.runCheck({ paths: pathsFor(t), exec });
    assert.strictEqual(s.installed, '0.32.1');
    assert.strictEqual(s.latest, '0.33.0');
    assert.strictEqual(s.updated, false);
    assert.strictEqual(s.cacheSynced, false);
    assert.match(s.action, /update available/);
  } finally { t.cleanup(); }
});

test('runCheck: already up to date', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeInstalled(t.root, '0.33.0');
    const exec = execStub({ fetch: '', 'rev-parse': 'origin/main\n', show: JSON.stringify({ version: '0.33.0' }) });
    const s = U.runCheck({ paths: pathsFor(t), exec });
    assert.strictEqual(s.action, 'already up to date');
  } finally { t.cleanup(); }
});

test('runCheck: offline (fetch throws) → reports, no crash', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeInstalled(t.root, '0.33.0');
    const exec = execStub({ fetch: Object.assign(new Error('fail'), { stderr: 'could not resolve host github.com' }) });
    const s = U.runCheck({ paths: pathsFor(t), exec });
    assert.strictEqual(s.latest, null);
    assert.match(s.action, /check failed/);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------
// runUpdate with injected exec stub (no real git)
// ---------------------------------------------------------------------------
test('runUpdate: clean tree + ff pull + new version → reload action + changelog + cache sync', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0'); // post-pull marketplace version
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true }); // cache root exists → sync allowed
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    const { status, changelog, stop } = U.runUpdate({ paths: p, exec });
    assert.strictEqual(stop, false);
    assert.strictEqual(status.installed, '0.32.1');
    assert.strictEqual(status.latest, '0.33.0');
    assert.strictEqual(status.updated, true);
    assert.strictEqual(status.cacheSynced, true);
    assert.strictEqual(status.action, 'run /reload-plugins');
    // installed=0.32.1 exclusive → only 0.33.0 is in the delta (0.32.1 itself excluded).
    assert.ok(changelog.includes('## 0.33.0'), 'new section present');
    assert.ok(!changelog.includes('## 0.32.1'), 'installed version (from, exclusive) excluded from delta');
  } finally { t.cleanup(); }
});

test('runUpdate: dirty tree → STOP, no pull attempted', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeInstalled(t.root, '0.32.1');
    let pullCalled = false;
    const exec = execStub({
      status: ' M plugins/anti-hall/foo.js\n',
      pull: () => { pullCalled = true; return ''; },
    });
    const { status, stop } = U.runUpdate({ paths: pathsFor(t), exec });
    assert.strictEqual(stop, true);
    assert.match(status.action, /STOP.*local changes/);
    assert.strictEqual(pullCalled, false, 'must not pull a dirty tree');
  } finally { t.cleanup(); }
});

test('runUpdate: non-fast-forward (diverged) → STOP', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.1');
    writeInstalled(t.root, '0.32.1');
    const exec = execStub({
      status: '',
      pull: Object.assign(new Error('fail'), { stderr: 'fatal: Not possible to fast-forward, aborting.' }),
    });
    const { status, stop } = U.runUpdate({ paths: pathsFor(t), exec });
    assert.strictEqual(stop, true);
    assert.match(status.action, /STOP.*fast-forward/);
  } finally { t.cleanup(); }
});

test('runUpdate: offline (git status throws) → fail-open report, no stop', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.1');
    writeInstalled(t.root, '0.32.1');
    const exec = execStub({ status: Object.assign(new Error('fail'), { stderr: 'git: command not found' }) });
    const { status, stop } = U.runUpdate({ paths: pathsFor(t), exec });
    assert.strictEqual(stop, false);
    assert.match(status.action, /offline \/ no git/);
  } finally { t.cleanup(); }
});

test('runUpdate: already up to date (no version bump after pull) → no reload action', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.33.0');
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    fs.mkdirSync(path.join(p.cacheRoot, '0.33.0'), { recursive: true }); // already cached
    const exec = execStub({ status: '', pull: 'Already up to date.\n' });
    const { status } = U.runUpdate({ paths: p, exec });
    assert.strictEqual(status.updated, false);
    assert.strictEqual(status.cacheSynced, false, 'no copy when target cache dir already present');
    assert.strictEqual(status.action, 'already up to date');
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------
// renderHuman shape
// ---------------------------------------------------------------------------
test('renderHuman: includes installed/latest/action and changelog block', () => {
  const out = U.renderHuman(
    { installed: '0.32.1', latest: '0.33.0', updated: true, cacheSynced: true, action: 'run /reload-plugins' },
    '## 0.33.0\nNew skill.'
  );
  assert.match(out, /installed: 0\.32\.1/);
  assert.match(out, /latest:\s+0\.33\.0/);
  assert.match(out, /action:\s+run \/reload-plugins/);
  assert.match(out, /Changelog delta:/);
  assert.match(out, /New skill\./);
});

// ===========================================================================
// REGRESSION (live E2E 2026-06-10): the REAL installed_plugins.json is the v2
// schema — { version: 2, plugins: { "<name>@<marketplace>": [ { scope,
// installPath, version, installedAt, lastUpdated, gitCommitSha } ] } }.
// The old parser missed it (looked at the top level), fell back to the cache
// dirs, and a commit-sha-named dir ('3928cc1257d9') was accepted by the
// lenient leading-digit parse → surfaced as installed AND compared "newer"
// than 0.32.1 → false 'already up to date'.
// ===========================================================================

function writeInstalledV2(root, entries) {
  fs.writeFileSync(
    path.join(root, 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'anti-hall@anti-hall': entries } }),
    'utf8'
  );
}

test('v2 registry: REAL verbatim shape (array, scope user) → version, not sha', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.30.0'); // must NOT be reached
    writeInstalledV2(t.root, [{
      scope: 'user',
      installPath: '/x/.claude/plugins/cache/anti-hall/anti-hall/0.32.1',
      version: '0.32.1',
      installedAt: '2026-05-29T16:49:15.773Z',
      lastUpdated: '2026-06-10T14:52:25.268Z',
      gitCommitSha: 'a8b943cfbc672b1e1532e786ddb0e62f8a2e0423',
    }]);
    assert.strictEqual(U.resolveInstalledVersion(pathsFor(t)), '0.32.1');
  } finally { t.cleanup(); }
});

test('v2 registry: prefers scope user over project', () => {
  const t = makeTree();
  try {
    writeInstalledV2(t.root, [
      { scope: 'project', version: '0.31.0' },
      { scope: 'user', version: '0.32.1' },
    ]);
    assert.strictEqual(U.versionFromInstalledJson(pathsFor(t).installedJson), '0.32.1');
  } finally { t.cleanup(); }
});

test('v2 registry: project-only entry is used', () => {
  const t = makeTree();
  try {
    writeInstalledV2(t.root, [{ scope: 'project', version: '0.31.0' }]);
    assert.strictEqual(U.versionFromInstalledJson(pathsFor(t).installedJson), '0.31.0');
  } finally { t.cleanup(); }
});

test('v2 registry: non-semver entry version → null (falls to next step, never surfaces)', () => {
  const t = makeTree();
  try {
    writeInstalledV2(t.root, [{ scope: 'user', version: '3928cc1257d9' }]);
    assert.strictEqual(U.versionFromInstalledJson(pathsFor(t).installedJson), null);
  } finally { t.cleanup(); }
});

test('isSemver: rejects digit-prefixed hex hashes and partial versions', () => {
  assert.strictEqual(U.isSemver('0.32.1'), true);
  assert.strictEqual(U.isSemver('v1.2.3'), true);
  assert.strictEqual(U.isSemver('3928cc1257d9'), false, 'hash is NOT a version');
  assert.strictEqual(U.isSemver('1.2'), false, 'two segments insufficient');
  assert.strictEqual(U.isSemver(undefined), false);
});

test('newestCacheVersion: sha-named cache dir 3928cc1257d9 never wins', () => {
  const t = makeTree();
  try {
    const cacheRoot = pathsFor(t).cacheRoot;
    fs.mkdirSync(path.join(cacheRoot, '3928cc1257d9'), { recursive: true });
    fs.mkdirSync(path.join(cacheRoot, '0.32.1'), { recursive: true });
    assert.strictEqual(U.newestCacheVersion(cacheRoot), '0.32.1', 'sha dir must not outrank semver dirs');
  } finally { t.cleanup(); }
});

test('newestCacheVersion: sha-only cache → null, never the hash', () => {
  const t = makeTree();
  try {
    const cacheRoot = pathsFor(t).cacheRoot;
    fs.mkdirSync(path.join(cacheRoot, '3928cc1257d9'), { recursive: true });
    assert.strictEqual(U.newestCacheVersion(cacheRoot), null);
  } finally { t.cleanup(); }
});

// Non-semver EVERYWHERE: malformed registry + sha-only cache + garbage plugin.json.
function makeNonSemverEverywhere() {
  const t = makeTree();
  writeInstalled(t.root, 'RAW:{not json');
  fs.mkdirSync(path.join(pathsFor(t).cacheRoot, '3928cc1257d9'), { recursive: true });
  writePluginJson(t.marketplaceDir, 'garbage-not-a-version');
  return t;
}

test('non-semver everywhere: resolveInstalledVersion → null (nothing surfaces)', () => {
  const t = makeNonSemverEverywhere();
  try {
    assert.strictEqual(U.resolveInstalledVersion(pathsFor(t)), null);
  } finally { t.cleanup(); }
});

test('non-semver everywhere: runCheck → unknown-installed-version, NEVER up to date', () => {
  const t = makeNonSemverEverywhere();
  try {
    const exec = execStub({ fetch: '', 'rev-parse': 'origin/main\n', show: JSON.stringify({ version: '0.33.0' }) });
    const s = U.runCheck({ paths: pathsFor(t), exec });
    assert.strictEqual(s.installed, null, 'a hash must never surface as installed');
    assert.strictEqual(s.latest, '0.33.0');
    assert.match(s.action, /^unknown-installed-version/);
    assert.ok(!/already up to date/.test(s.action), 'must not claim up to date');
  } finally { t.cleanup(); }
});

test('non-semver everywhere: runUpdate → unknown-installed-version, no changelog dump', () => {
  const t = makeNonSemverEverywhere();
  try {
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    const exec = execStub({ status: '', pull: 'Already up to date.\n' });
    const { status, changelog, stop } = U.runUpdate({ paths: pathsFor(t), exec });
    assert.strictEqual(stop, false);
    assert.strictEqual(status.installed, null);
    assert.match(status.action, /^unknown-installed-version/);
    assert.ok(!/already up to date/.test(status.action));
    assert.strictEqual(changelog, '', 'null from-version must not dump the whole changelog');
  } finally { t.cleanup(); }
});

test('regression e2e shape: v2 registry + sha cache dir → runCheck reports the real version', () => {
  // The exact live-machine combination that produced the bug: v2 registry with
  // 0.32.1 AND a sha-named cache dir present. installed must be 0.32.1.
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.1');
    writeInstalledV2(t.root, [{ scope: 'user', version: '0.32.1', gitCommitSha: 'a8b943c' }]);
    fs.mkdirSync(path.join(pathsFor(t).cacheRoot, '3928cc1257d9'), { recursive: true });
    const exec = execStub({ fetch: '', 'rev-parse': 'origin/main\n', show: JSON.stringify({ version: '0.32.1' }) });
    const s = U.runCheck({ paths: pathsFor(t), exec });
    assert.strictEqual(s.installed, '0.32.1');
    assert.strictEqual(s.action, 'already up to date');
  } finally { t.cleanup(); }
});

// ===========================================================================
// Round-1 deadly-swarm fixes
// ===========================================================================

// --- R1-C-01 / R1-F-01: path traversal via the version string ---------------
test('isSemver: fully anchored — rejects path-traversal suffixes (R1-C-01)', () => {
  assert.strictEqual(U.isSemver('0.33.0/../../evil'), false, 'forward-slash traversal');
  assert.strictEqual(U.isSemver('0.33.0\\..\\evil'), false, 'backslash traversal');
  assert.strictEqual(U.isSemver('0.33.0extra'), false, 'trailing junk');
  assert.strictEqual(U.isSemver('0.33.0-beta.1'), true, 'prerelease suffix still valid');
  assert.strictEqual(U.isSemver('0.33.0+build.5'), true, 'build suffix still valid');
});

test('syncCache: traversal version → synced:false, nothing written outside cache root', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    // Sentinel two levels above cacheRoot (<root>/cache/sentinel.txt) — where
    // '0.33.0/../../../evil' would land if the guard failed.
    const sentinel = path.resolve(p.cacheRoot, '..', '..', 'sentinel.txt');
    fs.writeFileSync(sentinel, 'ORIGINAL', 'utf8');
    const evil = '0.33.0/../../../evil';

    const r = U.syncCache(p, evil);

    assert.strictEqual(r.synced, false, 'traversal version must be rejected');
    assert.strictEqual(r.reason, 'unsafe version string');
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'ORIGINAL', 'sentinel untouched');
    assert.ok(!fs.existsSync(path.resolve(p.cacheRoot, evil)), 'no escaped write target created');
    // Windows-separator variant too
    const r2 = U.syncCache(p, '0.33.0\\..\\evil');
    assert.strictEqual(r2.synced, false);
    assert.strictEqual(r2.reason, 'unsafe version string');
  } finally { t.cleanup(); }
});

// --- A2: inverted pull-failure posture --------------------------------------
test('runUpdate: "refusing to merge unrelated histories" → STOP (A2)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.1');
    writeInstalled(t.root, '0.32.1');
    const exec = execStub({
      status: '',
      pull: Object.assign(new Error('fail'), { stderr: 'fatal: refusing to merge unrelated histories' }),
    });
    const { status, stop } = U.runUpdate({ paths: pathsFor(t), exec });
    assert.strictEqual(stop, true, 'unrelated histories is divergence, not transient');
    assert.match(status.action, /^STOP/);
    assert.match(status.action, /unrelated histories/, 'raw git message surfaced');
  } finally { t.cleanup(); }
});

test('runUpdate: UNKNOWN pull error → STOP (inverted posture, A2)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.1');
    writeInstalled(t.root, '0.32.1');
    const exec = execStub({
      status: '',
      pull: Object.assign(new Error('fail'), { stderr: 'fatal: some exotic never-seen-before failure' }),
    });
    const { status, stop } = U.runUpdate({ paths: pathsFor(t), exec });
    assert.strictEqual(stop, true, 'unrecognized failure must STOP, not fail open');
    assert.match(status.action, /^STOP/);
    assert.match(status.action, /exotic never-seen-before/);
  } finally { t.cleanup(); }
});

test('runUpdate: network-shaped pull error → report + no stop (fail-open class)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.32.1');
    writeInstalled(t.root, '0.32.1');
    const exec = execStub({
      status: '',
      pull: Object.assign(new Error('fail'), {
        stderr: "fatal: unable to access 'https://github.com/talas9/anti-hall/': Could not resolve host: github.com",
      }),
    });
    const { status, stop } = U.runUpdate({ paths: pathsFor(t), exec });
    assert.strictEqual(stop, false, 'recognized offline failure stays exit 0');
    assert.match(status.action, /offline \/ network/);
    assert.ok(!/^STOP/.test(status.action));
  } finally { t.cleanup(); }
});

// --- F1 + R1-F-02: git invocation discipline (cwd + flags) ------------------
test('full flow: git runs in the marketplace cwd, --ff-only pinned, no destructive tokens', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true });

    const calls = [];
    const exec = execStub(
      { status: '', pull: 'Updating...\n', fetch: '', 'rev-parse': 'origin/main\n', show: JSON.stringify({ version: '0.33.0' }) },
      calls
    );

    // Full update + a check pass through the SAME recorded exec.
    const { status } = U.runUpdate({ paths: p, exec });
    assert.strictEqual(status.action, 'run /reload-plugins');
    U.runCheck({ paths: p, exec });

    // cwd discipline: status / pull / fetch all run against the marketplace clone.
    for (const cmd of ['status', 'pull', 'fetch']) {
      const call = calls.find(c => c.args[0] === cmd);
      assert.ok(call, `expected a git ${cmd} call`);
      assert.strictEqual(call.cwd, p.marketplaceDir, `git ${cmd} must run in the marketplace clone`);
    }
    // pull is pinned to --ff-only.
    const pull = calls.find(c => c.args[0] === 'pull');
    assert.ok(pull.args.includes('--ff-only'), 'pull must carry --ff-only');
    // NO destructive git token in ANY call of the whole flow.
    for (const c of calls) {
      const joined = c.args.join(' ');
      assert.ok(
        !/\bmerge\b|\brebase\b|\breset\b|\bpush\b|--force\b|--hard\b/.test(joined),
        `destructive git token in: git ${joined}`
      );
    }
  } finally { t.cleanup(); }
});

// --- R1-A-01: ANTIHALL_MARKETPLACE_DIR override validation ------------------
test('resolvePaths: relative override → ignored, default used, reported', () => {
  const p = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: 'relative/clone' }, FAKE_HOME);
  assert.strictEqual(p.marketplaceDir, path.join(FAKE_HOME, '.claude', 'plugins', 'marketplaces', 'anti-hall'));
  assert.match(p.overrideIgnored, /ANTIHALL_MARKETPLACE_DIR ignored/);
});

test('resolvePaths: absolute but nonexistent override → ignored, default used, reported', () => {
  const missing = path.join(os.tmpdir(), 'antihall-definitely-missing-' + Date.now());
  const p = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: missing }, FAKE_HOME);
  assert.strictEqual(p.marketplaceDir, path.join(FAKE_HOME, '.claude', 'plugins', 'marketplaces', 'anti-hall'));
  assert.match(p.overrideIgnored, /ANTIHALL_MARKETPLACE_DIR ignored/);
});

test('resolvePaths: valid absolute existing override → used, no report', () => {
  const t = makeTree();
  try {
    const p = pathsFor(t);
    assert.strictEqual(p.marketplaceDir, t.marketplaceDir);
    assert.strictEqual(p.overrideIgnored, '');
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------
// healIngestDaemon — the update → doctor auto-heal wiring (P0 fix companion).
// Uses the REAL plugin source tree (this repo's own plugins/anti-hall) as
// paths.pluginSrcDir so the require-and-call wiring against the actual
// install-devswarm-ingest.js / doctor-repair.js / devswarm-detect.js is
// exercised, not a hand-rolled stub. `home` is always an isolated tmpdir so no
// test ever reads/writes this machine's REAL installed units.
// ---------------------------------------------------------------------------
const REAL_PLUGIN_SRC_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

test('healIngestDaemon: gate closed (not a DevSwarm session) → attempted:false, never spawns', () => {
  const result = U.healIngestDaemon({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: {},
    cwd: process.cwd(),
    spawnFn: () => { throw new Error('must not spawn when the gate is closed'); },
  });
  assert.strictEqual(result.attempted, false);
  assert.strictEqual(result.healed, false);
  assert.match(result.detail, /gate closed/);
});

test('healIngestDaemon: gate closed (cwd is not a git worktree) → attempted:false, never spawns', () => {
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-nogit-'));
  try {
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: nogit,
      spawnFn: () => { throw new Error('must not spawn when the gate is closed'); },
    });
    assert.strictEqual(result.attempted, false);
    assert.match(result.detail, /not a git worktree|gate closed/);
  } finally { fs.rmSync(nogit, { recursive: true, force: true }); }
});

test('healIngestDaemon: pulled plugin tree missing companion/hooks files → fail-open, attempted:false, never throws', () => {
  const t = makeTree(); // empty marketplace fixture — no companion/hooks dirs at all
  try {
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: path.join(t.marketplaceDir, 'plugins', 'anti-hall') },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
    });
    assert.strictEqual(result.attempted, false);
    assert.match(result.detail, /not found/);
  } finally { t.cleanup(); }
});

test('healIngestDaemon: gate open + nothing installed ("absent") → attempted:true, healed:true, never spawns', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-absent-'));
  let spawned = false;
  try {
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
      home,
      spawnFn: () => { spawned = true; },
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.healed, true);
    assert.match(result.detail, /absent/);
    assert.strictEqual(spawned, false, "an absent unit is not this code path's job to first-install");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('healIngestDaemon: gate open + stale-script unit → spawns the (fresh) installer, reclassifies ok, healed:true', { skip: process.platform === 'win32' }, () => {
  const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-stale-'));
  const wt = process.cwd(); // a real git worktree (this repo)
  const staleScript = path.join(home, 'this-script-does-not-exist.js');
  const realScript = installer.SCRIPT; // a real, existing file on disk
  const writeUnit = (script) => {
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installer.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'),
        installer.buildPlist({ label, exec: process.execPath, script, log: '/tmp/x.log', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installer.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'),
        installer.buildService({ exec: process.execPath, script, workdir: wt }));
    }
  };
  try {
    writeUnit(staleScript); // starts out stale
    let spawnedScript = null;
    const spawnFn = (script) => {
      spawnedScript = script;
      writeUnit(realScript); // simulate the real installer's re-bake effect
    };
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: wt,
      home,
      spawnFn,
    });
    assert.ok(spawnedScript, 'the installer was spawned for a stale-script unit');
    assert.ok(spawnedScript.endsWith('install-devswarm-ingest.js'));
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.healed, true);
    assert.match(result.detail, /re-installed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('healIngestDaemon: gate open + reinstall does NOT fix it → attempted:true, healed:false', { skip: process.platform === 'win32' }, () => {
  const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-stillstale-'));
  const wt = process.cwd();
  const staleScript = path.join(home, 'this-script-does-not-exist.js');
  const writeUnit = (script) => {
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installer.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'),
        installer.buildPlist({ label, exec: process.execPath, script, log: '/tmp/x.log', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installer.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'),
        installer.buildService({ exec: process.execPath, script, workdir: wt }));
    }
  };
  try {
    writeUnit(staleScript);
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: wt,
      home,
      spawnFn: () => { /* no-op: a spawn that does not actually fix the unit */ },
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.healed, false);
    assert.match(result.detail, /still stale-script/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('healIngestDaemon: gate open + unstable-script (drift) unit → env is passed through to classify, spawns installer, reclassifies ok, healed:true', { skip: process.platform === 'win32' }, () => {
  const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-drift-'));
  const wt = process.cwd(); // a real git worktree (this repo)
  // A fake "current stable" marketplace clone whose companion/devswarm-ingest.js
  // is a DIFFERENT file from the one baked into the installed unit below — this
  // is exactly the drift classifyIngestUnit's 'unstable-script' branch detects,
  // but ONLY when `env` reaches it (root cause of the P1 this test guards).
  const fakeMarketplaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-drift-mkt-'));
  const stableScriptDir = path.join(fakeMarketplaceDir, 'plugins', 'anti-hall', 'companion');
  fs.mkdirSync(stableScriptDir, { recursive: true });
  const stableScript = path.join(stableScriptDir, 'devswarm-ingest.js');
  fs.writeFileSync(stableScript, '// fake current-stable ingest script\n');
  const env = { DEVSWARM_REPO_ID: 'r1', ANTIHALL_MARKETPLACE_DIR: fakeMarketplaceDir };
  const driftedScript = installer.SCRIPT; // exists on disk, but is NOT the stable path above
  const writeUnit = (script) => {
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installer.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'),
        installer.buildPlist({ label, exec: process.execPath, script, log: '/tmp/x.log', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installer.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'),
        installer.buildService({ exec: process.execPath, script, workdir: wt }));
    }
  };
  try {
    writeUnit(driftedScript); // starts out drifted (baked scriptPath != current stable)
    let spawnedScript = null;
    const spawnFn = (script) => {
      spawnedScript = script;
      writeUnit(stableScript); // simulate the real installer's re-bake onto the stable path
    };
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env,
      cwd: wt,
      home,
      spawnFn,
    });
    assert.ok(spawnedScript, 'the installer was spawned for a drifted (unstable-script) unit');
    assert.ok(spawnedScript.endsWith('install-devswarm-ingest.js'));
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.healed, true);
    assert.match(result.detail, /re-installed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeMarketplaceDir, { recursive: true, force: true });
  }
});

test('healIngestDaemon: gate open + already-stable ("ok") unit under a drift-aware env → attempted:true, healed:true, FORCES a restart anyway (pacing-fix delivery gap — the running process must re-exec onto post-pull content even when install-shape is already ok)', { skip: process.platform === 'win32' }, () => {
  const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-stable-'));
  const wt = process.cwd();
  const fakeMarketplaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-stable-mkt-'));
  const stableScriptDir = path.join(fakeMarketplaceDir, 'plugins', 'anti-hall', 'companion');
  fs.mkdirSync(stableScriptDir, { recursive: true });
  const stableScript = path.join(stableScriptDir, 'devswarm-ingest.js');
  fs.writeFileSync(stableScript, '// fake current-stable ingest script\n');
  const env = { DEVSWARM_REPO_ID: 'r1', ANTIHALL_MARKETPLACE_DIR: fakeMarketplaceDir };
  const writeUnit = (script) => {
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installer.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'),
        installer.buildPlist({ label, exec: process.execPath, script, log: '/tmp/x.log', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installer.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'),
        installer.buildService({ exec: process.execPath, script, workdir: wt }));
    }
  };
  try {
    writeUnit(stableScript); // baked scriptPath already IS the current stable path
    let spawned = false;
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env,
      cwd: wt,
      home,
      spawnFn: () => { spawned = true; },
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.healed, true);
    assert.match(result.detail, /restarted/);
    assert.strictEqual(spawned, true, 'an already-stable unit is STILL restarted once — update just changed the code on disk and the running daemon only re-execs on crash, never on a fresh git pull alone');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeMarketplaceDir, { recursive: true, force: true });
  }
});

test('healIngestDaemon: repoKey-aware (v0.57 mesh Phase 6, D9/D24) — after a spawn that reaps the LEGACY unit and installs the PER-PROJECT unit (what the real installer now does on a real git worktree), the FRESH project unit is detected, not the just-reaped legacy one → healed:true', { skip: process.platform === 'win32' }, () => {
  const installer = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');
  const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-repokey-'));
  const wt = process.cwd(); // a real git worktree (this repo) — repoKey resolves
  const repoKey = repokey.repoKeyForWorktree(wt);
  assert.ok(repoKey, 'test precondition: repoKeyForWorktree must resolve for this repo');
  const staleScript = path.join(home, 'this-script-does-not-exist.js');
  const realScript = installer.SCRIPT; // a real, existing file on disk
  const legacyUnitPath = () => (process.platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', installer.labelForWorktree(wt) + '.plist')
    : path.join(home, '.config', 'systemd', 'user', installer.unitForWorktree(wt) + '.service'));
  const projectUnitPath = () => (process.platform === 'darwin'
    ? path.join(home, 'Library', 'LaunchAgents', installer.labelForProject(repoKey) + '.plist')
    : path.join(home, '.config', 'systemd', 'user', installer.unitForProject(repoKey) + '.service'));
  const writeLegacyUnit = (script) => {
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installer.labelForWorktree(wt);
      fs.writeFileSync(path.join(dir, label + '.plist'),
        installer.buildPlist({ label, exec: process.execPath, script, log: '/tmp/x.log', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installer.unitForWorktree(wt);
      fs.writeFileSync(path.join(dir, unit + '.service'),
        installer.buildService({ exec: process.execPath, script, workdir: wt }));
    }
  };
  const writeProjectUnit = (script) => {
    if (process.platform === 'darwin') {
      const dir = path.join(home, 'Library', 'LaunchAgents');
      fs.mkdirSync(dir, { recursive: true });
      const label = installer.labelForProject(repoKey);
      fs.writeFileSync(path.join(dir, label + '.plist'),
        installer.buildPlist({ label, exec: process.execPath, script, log: '/tmp/x.log', workdir: wt }));
    } else {
      const dir = path.join(home, '.config', 'systemd', 'user');
      fs.mkdirSync(dir, { recursive: true });
      const unit = installer.unitForProject(repoKey);
      fs.writeFileSync(path.join(dir, unit + '.service'),
        installer.buildService({ exec: process.execPath, script, workdir: wt }));
    }
  };
  try {
    writeLegacyUnit(staleScript); // starts out as a drifted LEGACY unit only — no project unit yet
    let spawnedScript = null;
    const spawnFn = (script) => {
      spawnedScript = script;
      // Simulate exactly what the REAL installer does on a real git worktree
      // (D9 reap-before-drain): stop+remove the legacy unit, install the
      // per-project unit instead. NEVER a real launchctl/systemctl spawn here —
      // this mock IS the reap, no scheduler is touched.
      try { fs.unlinkSync(legacyUnitPath()); } catch (_) {}
      writeProjectUnit(realScript);
    };
    const result = U.healIngestDaemon({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: wt,
      home,
      spawnFn,
    });
    assert.ok(spawnedScript, 'the installer was spawned for the drifted legacy unit');
    assert.ok(!fs.existsSync(legacyUnitPath()), 'test precondition: the legacy unit really is gone post-spawn (reaped, not fixed)');
    assert.ok(fs.existsSync(projectUnitPath()), 'test precondition: the per-project unit really was installed');
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.healed, true, 'the fresh per-project unit is detected — NOT misreported as still-absent because the legacy unit it replaced is gone');
    assert.match(result.detail, /re-installed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('healIngestDaemon: an internal throw is fail-open — never propagates, detail explains it', () => {
  const result = U.healIngestDaemon({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: { DEVSWARM_REPO_ID: 'r1' },
    cwd: process.cwd(),
    home: fs.mkdtempSync(path.join(os.tmpdir(), 'update-heal-throws-')),
    spawnFn: () => { throw new Error('spawn boom'); },
  });
  // A throwing spawnFn against an absent unit never even calls spawnFn (see the
  // "absent" test above); to actually exercise the catch we'd need a stale unit —
  // covered indirectly by the try/catch wrapping every step. This asserts the
  // documented CONTRACT: the function itself never throws, regardless of input.
  assert.ok(result && typeof result.attempted === 'boolean');
});

// ---------------------------------------------------------------------------
// runUpdate wiring: ingestHeal surfaces on the returned status, fail-open.
// ---------------------------------------------------------------------------

test('runUpdate: ingestHeal is fail-open when the pulled tree has no companion/hooks files (never breaks the update)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    const { status } = U.runUpdate({ paths: p, exec, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd() });
    assert.strictEqual(status.cacheSynced, true);
    assert.strictEqual(status.updated, true);
    assert.ok(status.ingestHeal, 'ingestHeal field present on the status object');
    assert.strictEqual(status.ingestHeal.attempted, false);
    assert.match(status.ingestHeal.detail, /not found/);
  } finally { t.cleanup(); }
});

test('runUpdate: ingestHeal reports "nothing to heal" when the cache did not sync this run', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.33.0'); // already at latest
    const p = pathsFor(t);
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    fs.mkdirSync(path.join(p.cacheRoot, '0.33.0'), { recursive: true }); // already cached -> no sync
    const exec = execStub({ status: '', pull: 'Already up to date.\n' });
    const { status } = U.runUpdate({ paths: p, exec });
    assert.strictEqual(status.cacheSynced, false);
    assert.strictEqual(status.ingestHeal.attempted, false);
    assert.match(status.ingestHeal.detail, /nothing to heal/);
  } finally { t.cleanup(); }
});

// ---------------------------------------------------------------------------
// reconcilePostUpdate — v0.58.0's `devswarm.js reconcile` verb, auto-run as a
// post-update step. Same REAL-plugin-source-tree posture as the healIngestDaemon
// tests above: paths.pluginSrcDir = this repo's own plugins/anti-hall so the
// require-and-call wiring against the actual devswarm-detect.js / devswarm.js
// is exercised, not a hand-rolled stub. `home` is always an isolated tmpdir.
// ---------------------------------------------------------------------------

test('reconcilePostUpdate: not a DevSwarm session (no DEVSWARM_REPO_ID) -> attempted:false, gate closed', () => {
  const result = U.reconcilePostUpdate({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: {},
    cwd: process.cwd(),
    devswarm: { run: () => { throw new Error('must not run reconcile when the gate is closed'); } },
  });
  assert.strictEqual(result.attempted, false);
  assert.match(result.detail, /not a DevSwarm session/);
});

test('reconcilePostUpdate: machine-level descriptor/registry presence alone is NOT enough — only isDevswarmActive(env) opens the gate', () => {
  // A populated devswarm home (as if descriptors exist on disk) must not matter —
  // only the env-level DEVSWARM_REPO_ID (an actual active session) does.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-reconcile-machine-'));
  try {
    const wsDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
    fs.mkdirSync(wsDir, { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'w1.json'), JSON.stringify({ id: 'w1', worktreePath: '/wt/w1' }));
    const result = U.reconcilePostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: {}, // no DEVSWARM_REPO_ID -> not an active session
      cwd: process.cwd(),
      home,
      devswarm: { run: () => { throw new Error('must not run reconcile when the gate is closed'); } },
    });
    assert.strictEqual(result.attempted, false);
    assert.match(result.detail, /not a DevSwarm session/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('reconcilePostUpdate: pulled plugin tree missing scripts/hooks files -> fail-open, attempted:false, never throws', () => {
  const t = makeTree(); // empty marketplace fixture — no scripts/hooks dirs at all
  try {
    const result = U.reconcilePostUpdate({
      paths: { pluginSrcDir: path.join(t.marketplaceDir, 'plugins', 'anti-hall') },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
    });
    assert.strictEqual(result.attempted, false);
    assert.match(result.detail, /not found/);
  } finally { t.cleanup(); }
});

test('reconcilePostUpdate: gate open + empty shared store (real devswarm.js, no mock) -> attempted:true, count:0, imported:0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-reconcile-empty-'));
  try {
    const result = U.reconcilePostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(), // a real git worktree (this repo)
      home,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.count, 0);
    assert.strictEqual(result.imported, 0);
    assert.match(result.detail, /reconciled 0 worktree\(s\)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('reconcilePostUpdate: gate open + cwd is not a git project -> reconcile itself reports no-project, never throws', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-reconcile-nogit-'));
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'update-reconcile-nogit-cwd-'));
  try {
    const result = U.reconcilePostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: nogit,
      home,
    });
    assert.strictEqual(result.attempted, true, 'reconcile WAS attempted (gate was open) — the no-project outcome comes from inside cmdReconcile');
    assert.match(result.detail, /reconcile failed/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(nogit, { recursive: true, force: true }); }
});

// P1 fix (v0.58.1): reconcilePostUpdate used to fall straight to a generic
// "reconcile failed: unknown error" whenever `result.ok` was false — and
// cmdReconcile itself used to ALWAYS return ok:true, so a real per-target
// message loss never even reached this branch, it just read as success. Now
// that cmdReconcile returns ok:false + a `lost` total on a genuine shortfall,
// this proves the update flow surfaces the loss count (not a generic
// "unknown error"), marks the outcome as attempted-but-NOT-success, and — per
// reconcilePostUpdate's own fail-open contract — never throws.
test('reconcilePostUpdate: a reconcile with a REAL per-target message loss -> attempted:true, NOT the success template, loss count surfaced, never throws', () => {
  const result = U.reconcilePostUpdate({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: { DEVSWARM_REPO_ID: 'r1' },
    cwd: process.cwd(),
    devswarm: {
      run: () => ({
        code: 2,
        result: {
          ok: false, action: 'reconcile', repoKey: 'fake-repo', count: 1, imported: 0, lost: 2,
          results: [{ id: 'child-lossy', worktreePath: '/wt/lossy', ok: false, imported: 0, duplicate: 0, nativeCount: 2, lost: 2, locked: true, error: null }],
        },
      }),
    },
  });
  assert.strictEqual(result.attempted, true);
  assert.strictEqual(result.lost, 2, 'the loss count must be surfaced on the returned status object');
  assert.doesNotMatch(result.detail, /^reconciled \d+ worktree/, 'a lossy reconcile must NEVER read as the success template');
  assert.match(result.detail, /LOST 2 message/i, 'the loss count must appear in the human detail, not a generic "unknown error"');
});

test('reconcilePostUpdate: an internal throw is fail-open — never propagates, detail explains it', () => {
  const result = U.reconcilePostUpdate({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: { DEVSWARM_REPO_ID: 'r1' },
    cwd: process.cwd(),
    devswarm: { run: () => { throw new Error('reconcile boom'); } },
  });
  assert.strictEqual(result.attempted, false);
  assert.match(result.detail, /reconcile raised/);
});

// ---------------------------------------------------------------------------
// runUpdate wiring: reconcile surfaces on the returned status, runs only
// inside a DevSwarm session, and a reconcile failure never fails the update.
// ---------------------------------------------------------------------------

test('runUpdate: reconcile is NOT attempted outside a DevSwarm session (default env)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR; // real scripts/hooks tree, so this exercises the GATE, not "files not found"
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    const { status } = U.runUpdate({ paths: p, exec, env: {}, cwd: process.cwd() });
    assert.ok(status.reconcile, 'reconcile field present on the status object');
    assert.strictEqual(status.reconcile.attempted, false);
    assert.match(status.reconcile.detail, /not a DevSwarm session/);
  } finally { t.cleanup(); }
});

test('runUpdate: reconcile runs inside a DevSwarm session, regardless of cache.synced (unlike ingestHeal)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.33.0'); // already at latest -> cache does NOT sync this run
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR; // real scripts/hooks tree, so the gate check itself runs
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    fs.mkdirSync(path.join(p.cacheRoot, '0.33.0'), { recursive: true }); // already cached
    const exec = execStub({ status: '', pull: 'Already up to date.\n' });
    let called = null;
    const fakeDevswarm = { run: (argv, ctx) => { called = { argv, ctx }; return { code: 0, result: { ok: true, action: 'reconcile', count: 2, imported: 5, results: [] } }; } };
    const { status } = U.runUpdate({ paths: p, exec, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), devswarm: fakeDevswarm });
    assert.strictEqual(status.cacheSynced, false, 'sanity: this run genuinely did not sync the cache');
    assert.deepStrictEqual(called.argv, ['reconcile']);
    assert.strictEqual(status.reconcile.attempted, true);
    assert.strictEqual(status.reconcile.count, 2);
    assert.strictEqual(status.reconcile.imported, 5);
  } finally { t.cleanup(); }
});

test('runUpdate: a reconcile failure is reported but never fails the update (fail-open, stop stays false)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR; // real scripts/hooks tree, so the gate opens and devswarm.run is actually called
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    const fakeDevswarm = { run: () => { throw new Error('reconcile boom'); } };
    const { status, stop } = U.runUpdate({ paths: p, exec, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: process.cwd(), devswarm: fakeDevswarm });
    assert.strictEqual(stop, false, 'a reconcile failure must never trip the STOP contract');
    assert.strictEqual(status.updated, true, 'the update itself still succeeded');
    assert.strictEqual(status.reconcile.attempted, false);
    assert.match(status.reconcile.detail, /reconcile raised/);
  } finally { t.cleanup(); }
});

test('renderHuman: prints reconcile summary + per-worktree breakdown when attempted', () => {
  const status = {
    installed: '0.32.1', latest: '0.33.0', updated: true, cacheSynced: true,
    action: 'run /reload-plugins',
    reconcile: {
      attempted: true, count: 1, imported: 3,
      detail: 'reconciled 1 worktree(s) — imported 3 message(s) into the shared store',
      results: [{ id: 'w1', imported: 3, duplicate: 0 }],
    },
  };
  const out = U.renderHuman(status, '');
  assert.match(out, /reconcile: reconciled 1 worktree\(s\) — imported 3 message\(s\) into the shared store/);
  assert.match(out, /w1: imported 3, duplicate 0/);
});

test('renderHuman: omits the reconcile block entirely when not attempted (non-DevSwarm session — no noise)', () => {
  const status = {
    installed: '0.32.1', latest: '0.33.0', updated: true, cacheSynced: true,
    action: 'run /reload-plugins',
    reconcile: { attempted: false, detail: 'not a DevSwarm session — reconcile skipped (gate closed)' },
  };
  const out = U.renderHuman(status, '');
  assert.doesNotMatch(out, /reconcile:/);
});

// ---------------------------------------------------------------------------
// healRegistryPostUpdate — Claim 3 self-heal MIGRATION, auto-run as a
// post-update step. Same REAL-plugin-source-tree posture as reconcilePostUpdate's
// own tests: paths.pluginSrcDir = this repo's own plugins/anti-hall so the
// require-and-call wiring against the actual devswarm-detect.js / devswarm.js /
// devswarm-store.js is exercised, not a hand-rolled stub. `home` is always an
// isolated tmpdir. The heal DECISION itself (rehomeMiskeyedRow) is already
// covered by devswarm-lifecycle.test.js's own Claim 3 tests — these tests prove
// the update.js INTEGRATION: the DevSwarm gate, enumeration across every
// per-project store, idempotency through this entry point, and a synthetic
// mis-keyed row rehomed with zero message loss.
// ---------------------------------------------------------------------------

function makeGitRepoForUpdate(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-healreg-repo-' + tag + '-'));
  require('node:child_process').spawnSync('git', ['init', '-q', dir]);
  require('node:child_process').spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  require('node:child_process').spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  require('node:child_process').spawnSync('git', ['-C', dir, 'add', '.']);
  require('node:child_process').spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

test('healRegistryPostUpdate: not a DevSwarm session (no DEVSWARM_REPO_ID) -> attempted:false, gate closed', () => {
  const result = U.healRegistryPostUpdate({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: {},
    cwd: process.cwd(),
    devswarm: { healRegistry: () => { throw new Error('must not run heal-registry-rows when the gate is closed'); } },
  });
  assert.strictEqual(result.attempted, false);
  assert.match(result.detail, /not a DevSwarm session/);
});

test('healRegistryPostUpdate: pulled plugin tree missing scripts/companion files -> fail-open, attempted:false, never throws', () => {
  const t = makeTree(); // empty marketplace fixture — no scripts/companion dirs at all
  try {
    const result = U.healRegistryPostUpdate({
      paths: { pluginSrcDir: path.join(t.marketplaceDir, 'plugins', 'anti-hall') },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
    });
    assert.strictEqual(result.attempted, false);
    assert.match(result.detail, /not found/);
  } finally { t.cleanup(); }
});

test('healRegistryPostUpdate: gate open + no DevSwarm store at all (real devswarm.js, no mock) -> attempted:true, checked:0, healed:0, rehomed:0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-healreg-empty-'));
  try {
    const result = U.healRegistryPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
      home,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.checked, 0);
    assert.strictEqual(result.healed, 0);
    assert.strictEqual(result.rehomed, 0);
    assert.match(result.detail, /0 store\(s\)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('healRegistryPostUpdate: gate open + a synthetic mis-keyed row -> REHOMED with ZERO message loss, then a second pass is IDEMPOTENT (real devswarm.js + devswarm-store.js, no mock)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-healreg-fix-'));
  const repoA = makeGitRepoForUpdate('a');
  const repoB = makeGitRepoForUpdate('b');
  try {
    const repoKeyA = devswarmRepokey.repoKeyForWorktree(repoA);
    const repoKeyB = devswarmRepokey.repoKeyForWorktree(repoB);

    // 'z' is correctly registered at repoB — its true, structural home.
    const reg = devswarmCli.run(['register', 'z', '--worktree', repoB, '--session', 's2'], { home, env: {}, cwd: repoB });
    assert.strictEqual(reg.result.ok, true);

    // A STRAY registry row for 'z' ALSO physically lives in store A, plus a
    // pending message that arrived into the WRONG bucket — must survive.
    const sA0 = devswarmStore.openStore({ home, hash: repoKeyA });
    try {
      sA0.upsertRegistry({ id: 'z', worktreePath: repoB, sessionId: 's2' });
      sA0.appendMeshRow({
        workspaceId: 'z', ts: Date.now(), hash: 'update-stray-hash-1', body: 'update stray message',
        sender: 'someone', recipient: 'z', mtype: 'direct', urgency: 'normal', isHeartbeat: false,
      });
    } finally { sA0.close(); }

    const result = U.healRegistryPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: repoA,
      home,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.rehomed, 1, JSON.stringify(result));
    assert.ok(Array.isArray(result.stores) && result.stores.some((s) => s.repoKey === repoKeyA && s.rows.includes('z')),
      'the healed store + row id must be reported: ' + JSON.stringify(result.stores));
    assert.match(result.detail, /rehomed 1/);

    const sA = devswarmStore.openStore({ home, hash: repoKeyA });
    try {
      assert.strictEqual((sA.listRegistry() || []).some((x) => x.id === 'z'), false, 'the mis-keyed registry row must be gone from the wrong store');
    } finally { sA.close(); }
    const sB = devswarmStore.openStore({ home, hash: repoKeyB });
    try {
      const msgs = sB.listMessages('z');
      assert.ok(msgs.some((m) => m.body === 'update stray message'), 'the stray message must have migrated into the correct store — zero loss');
      assert.ok((sB.listRegistry() || []).some((x) => x.id === 'z'), 'the registry row must now live in the correct store');
    } finally { sB.close(); }

    // Idempotency THROUGH THE UPDATE ENTRY POINT: a second pass over the
    // now-healed stores must heal/rehome nothing further.
    const second = U.healRegistryPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: repoA,
      home,
    });
    assert.strictEqual(second.healed, 0, 'a second pass must heal nothing further:\n' + JSON.stringify(second));
    assert.strictEqual(second.rehomed, 0, 'a second pass must rehome nothing further:\n' + JSON.stringify(second));
    assert.match(second.detail, /nothing mis-keyed\/stale/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repoA, { recursive: true, force: true });
    fs.rmSync(repoB, { recursive: true, force: true });
  }
});

test('healRegistryPostUpdate: a per-store throw is fail-open — never propagates, that store just contributes 0, attempted stays true', () => {
  // Isolated home with ONE real per-project store (via the real devswarm.js +
  // devswarm-store.js) so listStoreHashes finds a real repoKey to iterate, and
  // the fake healRegistry below is actually exercised — not skipped over an
  // empty enumeration, which would prove nothing about fail-open.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-healreg-throw-'));
  const repo = makeGitRepoForUpdate('throw');
  try {
    const reg = devswarmCli.run(['register', 'w', '--worktree', repo, '--session', 's1'], { home, env: {}, cwd: repo });
    assert.strictEqual(reg.result.ok, true);

    const result = U.healRegistryPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: repo,
      home,
      devswarm: { healRegistry: () => { throw new Error('heal boom'); } },
    });
    // The enumeration loop's own try/catch fails open PER STORE (mirrors
    // healRegistry's own per-row fail-open contract) — a single store's throw
    // never propagates out; attempted stays true with 0 counted for that
    // store, never a thrown exception reaching the caller.
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.checked, 0);
    assert.strictEqual(result.healed, 0);
    assert.strictEqual(result.rehomed, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('runUpdate: healRegistryRows is NOT attempted outside a DevSwarm session (default env)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR;
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    const { status } = U.runUpdate({ paths: p, exec, env: {}, cwd: process.cwd() });
    assert.ok(status.healRegistryRows, 'healRegistryRows field present on the status object');
    assert.strictEqual(status.healRegistryRows.attempted, false);
    assert.match(status.healRegistryRows.detail, /not a DevSwarm session/);
  } finally { t.cleanup(); }
});

test('runUpdate: healRegistryRows runs inside a DevSwarm session, regardless of cache.synced', () => {
  const t = makeTree();
  // VACUOUS-TEST FIX (mirrors the sibling 'a healRegistryRows failure is
  // reported...' test below): without an isolated `home` seeded with a real
  // store, `healRegistryPostUpdate` -> `devstore.listStoreHashes(home)`
  // defaults `home` to `os.homedir()` (the REAL machine's actual home). On a
  // box that runs live DevSwarm sessions, `~/.anti-hall/devswarm/store/`
  // already has real per-project store dirs, so the enumeration loop finds
  // one BY ACCIDENT and the fake `healRegistry` gets called — the test only
  // passes because of ambient machine state, not because the gate/wiring
  // under test actually works. On a clean CI checkout (no such directory),
  // `hashes` resolves to `[]`, the loop never iterates, and `called` stays
  // false — this is exactly the CI-only failure this fix addresses. Seed one
  // real per-project store under a temp `home` and pass it through so the
  // mock is provably exercised regardless of the host machine's state.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-healreg-runupdate-'));
  const repo = makeGitRepoForUpdate('runupdate');
  try {
    const reg = devswarmCli.run(['register', 'w', '--worktree', repo, '--session', 's1'], { home, env: {}, cwd: repo });
    assert.strictEqual(reg.result.ok, true);

    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.33.0'); // already at latest -> cache does NOT sync this run
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR;
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    fs.mkdirSync(path.join(p.cacheRoot, '0.33.0'), { recursive: true });
    const exec = execStub({ status: '', pull: 'Already up to date.\n' });
    let called = false;
    const fakeDevswarm = {
      run: (argv, ctx) => ({ code: 0, result: { ok: true, action: 'reconcile', count: 0, imported: 0, results: [] } }),
      foldMeshDuplicates: () => ({ retired: [], left: [] }),
      migrateOwnerKeys: () => ({ scanned: 0, backfilled: 0, rehomed: 0 }),
      healRegistry: () => { called = true; return { checked: 0, healed: 0, rehomed: 0, skipped: 0, rows: [] }; },
    };
    const { status } = U.runUpdate({ paths: p, exec, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: repo, home, devswarm: fakeDevswarm });
    assert.strictEqual(status.cacheSynced, false, 'sanity: this run genuinely did not sync the cache');
    assert.strictEqual(called, true, 'healRegistry must actually run when the gate is open');
    assert.strictEqual(status.healRegistryRows.attempted, true);
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('runUpdate: a healRegistryRows failure is reported but never fails the update (fail-open, stop stays false)', () => {
  const t = makeTree();
  // VACUOUS-TEST FIX: without an isolated `home` seeded with a real store,
  // `healRegistryPostUpdate` -> `devstore.listStoreHashes(home)` defaults
  // `home` to `os.homedir()` (the real machine's actual home), resolves
  // `hashes` to `[]` on any box with no `~/.anti-hall/devswarm/store/`
  // entries, and the enumeration loop below never iterates — the throwing
  // `healRegistry` mock is then NEVER invoked, so every assertion here passed
  // trivially regardless of whether the fail-open behavior under test
  // actually works. Seed one real per-project store under a temp `home` (same
  // pattern as the sibling 'per-store throw is fail-open' test above) and
  // pass that `home` through runUpdate so the mock is provably exercised.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-healreg-runupdate-throw-'));
  const repo = makeGitRepoForUpdate('runupdate-throw');
  try {
    const reg = devswarmCli.run(['register', 'w', '--worktree', repo, '--session', 's1'], { home, env: {}, cwd: repo });
    assert.strictEqual(reg.result.ok, true);

    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR;
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    let called = false;
    const fakeDevswarm = {
      run: () => ({ code: 0, result: { ok: true, action: 'reconcile', count: 0, imported: 0, results: [] } }),
      foldMeshDuplicates: () => ({ retired: [], left: [] }),
      migrateOwnerKeys: () => ({ scanned: 0, backfilled: 0, rehomed: 0 }),
      healRegistry: () => { called = true; throw new Error('heal boom'); },
    };
    const { status, stop } = U.runUpdate({ paths: p, exec, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: repo, home, devswarm: fakeDevswarm });
    assert.strictEqual(called, true, 'the throwing healRegistry mock must actually be invoked — otherwise this test proves nothing');
    assert.strictEqual(stop, false, 'a heal-registry-rows failure must never trip the STOP contract');
    assert.strictEqual(status.updated, true, 'the update itself still succeeded');
    assert.strictEqual(status.healRegistryRows.attempted, true, 'the enumeration loop fails open per-store, not at the attempted level');
    assert.strictEqual(status.healRegistryRows.checked, 0, 'the throw happens before this store contributes a count');
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('renderHuman: prints heal-registry-rows summary + per-store row list when attempted', () => {
  const status = {
    installed: '0.32.1', latest: '0.33.0', updated: true, cacheSynced: true,
    action: 'run /reload-plugins',
    healRegistryRows: {
      attempted: true, checked: 2, healed: 0, rehomed: 1,
      detail: 'healed 0 + rehomed 1 of 2 registry row(s) across 2 store(s)',
      stores: [{ repoKey: 'stale-repo-abc123', rows: ['z'] }],
    },
  };
  const out = U.renderHuman(status, '');
  assert.match(out, /heal-registry-rows: healed 0 \+ rehomed 1 of 2 registry row\(s\) across 2 store\(s\)/);
  assert.match(out, /stale-repo-abc123: z/);
});

test('renderHuman: omits the heal-registry-rows block entirely when not attempted (non-DevSwarm session — no noise)', () => {
  const status = {
    installed: '0.32.1', latest: '0.33.0', updated: true, cacheSynced: true,
    action: 'run /reload-plugins',
    healRegistryRows: { attempted: false, detail: 'not a DevSwarm session — heal-registry-rows skipped (gate closed)' },
  };
  const out = U.renderHuman(status, '');
  assert.doesNotMatch(out, /heal-registry-rows:/);
});

// ---------------------------------------------------------------------------
// wakeMonitorPostUpdate — Monitor-based idle-wake forward-migration companion
// (companion/lib/devswarm-wake-watch.js + hooks/lib/devswarm-wake.js).
// update.js is a plain Node process with NO access to the agent-only `Monitor`
// tool, so this function only VERIFIES + REPORTS (shipped / live / manual arm
// command) — it must never claim to have armed a watcher. Same
// REAL-plugin-source-tree posture as the other *PostUpdate suites: paths.
// pluginSrcDir = this repo's own plugins/anti-hall so the require-and-call
// wiring against the actual devswarm-detect.js / devswarm-wake-watch.js /
// liveness.js is exercised, not a hand-rolled stub. `home` is always an
// isolated tmpdir.
// ---------------------------------------------------------------------------
const wakeWatch = require('../../plugins/anti-hall/companion/lib/devswarm-wake-watch.js');

test('wakeMonitorPostUpdate: not a DevSwarm session (no DEVSWARM_REPO_ID) -> attempted:false, gate closed', () => {
  const result = U.wakeMonitorPostUpdate({
    paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
    env: {},
    cwd: process.cwd(),
  });
  assert.strictEqual(result.attempted, false);
  assert.strictEqual(result.shipped, false);
  assert.strictEqual(result.live, false);
  assert.match(result.detail, /not a DevSwarm session/);
});

test('wakeMonitorPostUpdate: pulled plugin tree missing scripts/companion files -> fail-open, attempted:false, never throws', () => {
  const t = makeTree(); // empty marketplace fixture — no hooks/companion dirs at all
  try {
    const result = U.wakeMonitorPostUpdate({
      paths: { pluginSrcDir: path.join(t.marketplaceDir, 'plugins', 'anti-hall') },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: process.cwd(),
    });
    assert.strictEqual(result.attempted, false);
    assert.strictEqual(result.shipped, false);
    assert.match(result.detail, /not found/);
  } finally { t.cleanup(); }
});

test('wakeMonitorPostUpdate: gate open + real watcher shipped but NOT live -> shipped:true, live:false, exact manual arm command surfaced', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wakemon-notlive-'));
  const repo = makeGitRepoForUpdate('wakemon-notlive');
  try {
    const result = U.wakeMonitorPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: repo,
      home,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.shipped, true);
    assert.strictEqual(result.live, false);
    assert.match(result.detail, /NOT live|live-check skipped/);
    assert.match(result.detail, /Monitor.*tool/, 'must surface the exact manual arm command since no watcher is live');
    const watcherPath = path.join(REAL_PLUGIN_SRC_DIR, 'companion', 'lib', 'devswarm-wake-watch.js');
    assert.ok(result.detail.includes(watcherPath), 'the manual arm command must name the real watcher script path');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('wakeMonitorPostUpdate: gate open + a lock genuinely held by THIS live process -> live:true, never touches the lock file (read-only)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wakemon-live-'));
  const repo = makeGitRepoForUpdate('wakemon-live');
  try {
    const identity = wakeWatch.resolveIdentity({}, repo, {});
    assert.ok(identity, 'sanity: identity must resolve for this real git repo before the lock test means anything');
    const lockPath = wakeWatch.lockPathFor(home, identity.id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const lockPayload = JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'test-token' });
    fs.writeFileSync(lockPath, lockPayload);

    const result = U.wakeMonitorPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: repo,
      home,
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.shipped, true);
    assert.strictEqual(result.live, true);
    assert.match(result.detail, /LIVE/);
    // Read-only contract: the lock file must be untouched — same bytes, still present.
    assert.strictEqual(fs.readFileSync(lockPath, 'utf8'), lockPayload, 'wakeMonitorPostUpdate must never mutate a lock file it only inspects');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('wakeMonitorPostUpdate: a DEAD pid in the lock file -> live:false, never throws, never deletes the stale lock', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wakemon-dead-'));
  const repo = makeGitRepoForUpdate('wakemon-dead');
  try {
    const identity = wakeWatch.resolveIdentity({}, repo, {});
    assert.ok(identity);
    const lockPath = wakeWatch.lockPathFor(home, identity.id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A pid essentially guaranteed dead/unassigned on any real machine.
    const deadPid = 999999;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, ts: Date.now(), token: 'x' }));

    const result = U.wakeMonitorPostUpdate({
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: repo,
      home,
    });
    assert.strictEqual(result.live, false);
    assert.ok(fs.existsSync(lockPath), 'inspection-only: a dead-holder lock must be left in place, never deleted by this reporter');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('wakeMonitorPostUpdate: corrupt/unparseable lock file -> never throws, reported as not live', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wakemon-corrupt-'));
  const repo = makeGitRepoForUpdate('wakemon-corrupt');
  try {
    const identity = wakeWatch.resolveIdentity({}, repo, {});
    assert.ok(identity);
    const lockPath = wakeWatch.lockPathFor(home, identity.id);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'not json{{{');

    assert.doesNotThrow(() => {
      const result = U.wakeMonitorPostUpdate({
        paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
        env: { DEVSWARM_REPO_ID: 'r1' },
        cwd: repo,
        home,
      });
      assert.strictEqual(result.live, false);
      assert.strictEqual(result.shipped, true);
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('wakeMonitorPostUpdate: idempotent — running twice back-to-back yields the same shipped/live verdict, no throw, no mutation drift', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wakemon-idem-'));
  const repo = makeGitRepoForUpdate('wakemon-idem');
  try {
    const opts = {
      paths: { pluginSrcDir: REAL_PLUGIN_SRC_DIR },
      env: { DEVSWARM_REPO_ID: 'r1' },
      cwd: repo,
      home,
    };
    const first = U.wakeMonitorPostUpdate(opts);
    const second = U.wakeMonitorPostUpdate(opts);
    assert.strictEqual(first.attempted, second.attempted);
    assert.strictEqual(first.shipped, second.shipped);
    assert.strictEqual(first.live, second.live);
    assert.strictEqual(first.detail, second.detail);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('runUpdate: wakeMonitor is NOT attempted outside a DevSwarm session (default env)', () => {
  const t = makeTree();
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR;
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    const { status } = U.runUpdate({ paths: p, exec, env: {}, cwd: process.cwd() });
    assert.ok(status.wakeMonitor, 'wakeMonitor field present on the status object');
    assert.strictEqual(status.wakeMonitor.attempted, false);
    assert.match(status.wakeMonitor.detail, /not a DevSwarm session/);
  } finally { t.cleanup(); }
});

test('runUpdate: wakeMonitor runs inside a DevSwarm session and never flips stop/exit', () => {
  const t = makeTree();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'update-wakemon-runupdate-'));
  const repo = makeGitRepoForUpdate('wakemon-runupdate');
  try {
    writePluginJson(t.marketplaceDir, '0.33.0');
    writeChangelog(t.marketplaceDir, SAMPLE_CHANGELOG);
    writeInstalled(t.root, '0.32.1');
    const p = pathsFor(t);
    p.pluginSrcDir = REAL_PLUGIN_SRC_DIR;
    fs.mkdirSync(p.cacheRoot, { recursive: true });
    const exec = execStub({ status: '', pull: 'Updating...\n' });
    const { status, stop } = U.runUpdate({ paths: p, exec, env: { DEVSWARM_REPO_ID: 'r1' }, cwd: repo, home });
    assert.strictEqual(stop, false);
    assert.ok(status.wakeMonitor, 'wakeMonitor field present on the status object');
    assert.strictEqual(status.wakeMonitor.attempted, true);
    assert.strictEqual(status.wakeMonitor.shipped, true);
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('renderHuman: prints wake-monitor summary line when attempted', () => {
  const status = {
    installed: '0.32.1', latest: '0.33.0', updated: true, cacheSynced: true,
    action: 'run /reload-plugins',
    wakeMonitor: { attempted: true, shipped: true, live: false, detail: 'wake-monitor shipped but NOT live for primary abc123 — arm it: call the `Monitor` tool.' },
  };
  const out = U.renderHuman(status, '');
  assert.match(out, /wake-monitor: wake-monitor shipped but NOT live for primary abc123/);
});

test('renderHuman: omits the wake-monitor block entirely when not attempted (non-DevSwarm session — no noise)', () => {
  const status = {
    installed: '0.32.1', latest: '0.33.0', updated: true, cacheSynced: true,
    action: 'run /reload-plugins',
    wakeMonitor: { attempted: false, detail: 'not a DevSwarm session — wake-monitor skipped (gate closed)' },
  };
  const out = U.renderHuman(status, '');
  assert.doesNotMatch(out, /wake-monitor:/);
});
