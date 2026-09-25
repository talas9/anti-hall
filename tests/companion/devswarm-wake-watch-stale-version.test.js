'use strict';
// devswarm-wake-watch.js — stale-build per-poll check (item 4c, field-proven
// P0 root cause): a child session auto-resumed BEFORE the harness
// re-registered a newer anti-hall build keeps its wake-watch Monitor process
// running the OLD build's code (old cache path baked in) with NO signal that
// a newer build exists — a silent stale watcher forever. `checkStaleVersion`
// reuses update.js's own version-resolution chain (installed_plugins.json ->
// newest cache dir -> marketplace plugin.json) to detect this on every poll;
// `formatStaleVersionLine` prints the one line telling the session how to
// re-arm.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js');
const { checkStaleVersion, formatStaleVersionLine, formatUpdateAvailableLine } = require(MODULE_PATH);

// Same pattern as tests/companion/devswarm-wake-watch.test.js's own helper of
// the same name — waits for `pattern` in the child's accumulated stdout (or a
// hard cap), always terminates the child (it polls forever by design) before
// resolving. Duplicated here (rather than shared) because that file's own
// header comment says it is run standalone by another task's own command.
function waitForStdoutMatch(args, spawnOpts, pattern, hardCapMs) {
  hardCapMs = hardCapMs || 8000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, spawnOpts);
    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let hardTimer = null;
    let exited = false;
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ stdout, stderr, exited });
    }
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; if (pattern.test(stdout)) finish(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => finish());
    child.on('exit', () => { exited = true; finish(); });
    hardTimer = setTimeout(finish, hardCapMs);
  });
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-staleversion-'));
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// Lays out ~/.claude/plugins/{installed_plugins.json, cache/anti-hall/anti-hall/<v>/,
// marketplaces/anti-hall/plugins/anti-hall/.claude-plugin/plugin.json} exactly as
// update.js's resolvePaths() expects, under a disposable HOME — same fixture
// shape as tests/hooks/doctor-harness-version-mismatch.test.js.
function layoutPlugins(home, { installedVersion, cacheVersions, marketplaceVersion } = {}) {
  const pluginsRoot = path.join(home, '.claude', 'plugins');
  // ANTIHALL_MARKETPLACE_DIR's own override validation (update.js resolvePaths)
  // requires an EXISTING directory or it is silently ignored and falls back to
  // the REAL machine's default marketplace path — which very much exists on
  // the machine running this test. Always create it so every test here is
  // genuinely isolated, never accidentally reading real installed-plugin state.
  fs.mkdirSync(path.join(pluginsRoot, 'marketplaces', 'anti-hall'), { recursive: true });
  if (installedVersion) {
    fs.mkdirSync(pluginsRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginsRoot, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'user', version: installedVersion }] } }), 'utf8');
  }
  for (const v of (cacheVersions || [])) {
    const libDir = path.join(pluginsRoot, 'cache', 'anti-hall', 'anti-hall', v, 'companion', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    // Real cache dirs are mirrored atomically (whole tree or nothing), so a
    // cache VERSION dir existing means this file exists inside it too. Write
    // a stub so scriptPath-existence checks against a "real" cached version
    // pass without needing the actual source tree.
    fs.writeFileSync(path.join(libDir, 'devswarm-wake-watch.js'), '// stub for tests\n', 'utf8');
  }
  if (marketplaceVersion) {
    const srcDir = path.join(pluginsRoot, 'marketplaces', 'anti-hall', 'plugins', 'anti-hall', '.claude-plugin');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'plugin.json'), JSON.stringify({ name: 'anti-hall', version: marketplaceVersion }), 'utf8');
  }
  return pluginsRoot;
}

test('checkStaleVersion: own version older than the newest cached version -> flags with newest + scriptPath', () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, { installedVersion: '0.105.3', cacheVersions: ['0.105.3', '0.107.1'] });
    const out = checkStaleVersion('0.105.3', { ANTIHALL_MARKETPLACE_DIR: path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall') });
    assert.ok(out, 'must flag stale');
    assert.strictEqual(out.newestVersion, '0.107.1');
    assert.ok(out.scriptPath.endsWith(path.join('0.107.1', 'companion', 'lib', 'devswarm-wake-watch.js')),
      'scriptPath must point at the newest version\'s copy of THIS file: ' + out.scriptPath);
  } finally { rm(home); }
});

test('checkStaleVersion: own version already the newest -> null (not stale)', () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, { installedVersion: '0.107.1', cacheVersions: ['0.105.3', '0.107.1'] });
    const out = checkStaleVersion('0.107.1', { ANTIHALL_MARKETPLACE_DIR: path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall') });
    assert.strictEqual(out, null);
  } finally { rm(home); }
});

test('checkStaleVersion: own version AHEAD of everything known -> null (never regress)', () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, { installedVersion: '0.105.3', cacheVersions: ['0.105.3'] });
    const out = checkStaleVersion('9.9.9', { ANTIHALL_MARKETPLACE_DIR: path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall') });
    assert.strictEqual(out, null);
  } finally { rm(home); }
});

test('checkStaleVersion: own version unknown/non-semver -> null, never throws', () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, { installedVersion: '0.107.1', cacheVersions: ['0.107.1'] });
    assert.strictEqual(checkStaleVersion(null, {}), null);
    assert.strictEqual(checkStaleVersion(undefined, {}), null);
    assert.strictEqual(checkStaleVersion('not-a-version', {}), null);
  } finally { rm(home); }
});

test('checkStaleVersion: nothing laid out at all (fresh machine) -> fails open to null, never throws', () => {
  const home = tmpHome();
  try {
    const marketplaceDir = layoutPlugins(home); // creates only the (empty) marketplace dir itself
    const out = checkStaleVersion('0.105.3', { ANTIHALL_MARKETPLACE_DIR: path.join(marketplaceDir, 'marketplaces', 'anti-hall') });
    assert.strictEqual(out, null);
  } finally { rm(home); }
});

test('checkStaleVersion: newest known version comes from the marketplace plugin.json alone (no cache dirs yet) -> flags the version but names NO path (nothing exists on disk to re-arm)', () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, { marketplaceVersion: '0.108.0' });
    const out = checkStaleVersion('0.105.3', { ANTIHALL_MARKETPLACE_DIR: path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall') });
    assert.ok(out);
    assert.strictEqual(out.newestVersion, '0.108.0');
    // Root-cause regression (live field repro, 2026-09-25): the marketplace
    // clone had been fast-forwarded to 0.108.5 while the plugin CACHE still
    // only held 0.108.4 — `newest` picked up the marketplace-only version and
    // a scriptPath was built pointing at a cache dir that did not exist,
    // crashing the printed re-arm command with exit 1. scriptPath must be
    // null whenever the target version's cache dir is not actually on disk.
    assert.strictEqual(out.scriptPath, null, 'must not name a path that does not exist on disk');
  } finally { rm(home); }
});

test('checkStaleVersion: a newer version is registered/marketplace-known but its cache dir does NOT exist -> scriptPath null even though an older cache dir does exist', () => {
  const home = tmpHome();
  try {
    // Realistic shape of the live repro: 0.108.4 is cached (this process is
    // running it), the marketplace has already fast-forwarded to 0.108.5, but
    // 0.108.5's cache dir has not been mirrored yet.
    layoutPlugins(home, { installedVersion: '0.108.4', cacheVersions: ['0.108.4'], marketplaceVersion: '0.108.5' });
    const out = checkStaleVersion('0.108.4', { ANTIHALL_MARKETPLACE_DIR: path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall') });
    assert.ok(out, 'must still surface that an update is known');
    assert.strictEqual(out.newestVersion, '0.108.5');
    assert.strictEqual(out.scriptPath, null, 'the 0.108.5 cache dir does not exist; must not fabricate a path into it');
  } finally { rm(home); }
});

test('checkStaleVersion: the newer cache dir DOES exist -> scriptPath names it', () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, { installedVersion: '0.108.4', cacheVersions: ['0.108.4', '0.108.5'], marketplaceVersion: '0.108.5' });
    const out = checkStaleVersion('0.108.4', { ANTIHALL_MARKETPLACE_DIR: path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall') });
    assert.ok(out);
    assert.strictEqual(out.newestVersion, '0.108.5');
    assert.ok(out.scriptPath, 'the 0.108.5 cache dir + this file both exist; scriptPath must be populated');
    assert.ok(fs.existsSync(out.scriptPath), 'scriptPath must actually exist on disk');
    assert.ok(out.scriptPath.endsWith(path.join('0.108.5', 'companion', 'lib', 'devswarm-wake-watch.js')));
  } finally { rm(home); }
});

test('formatUpdateAvailableLine: names role, id, own version, newest version, and never tells the caller to exit', () => {
  const line = formatUpdateAvailableLine('child', 'abc-123', '0.108.4', '0.108.5');
  assert.match(line, /update available/);
  assert.match(line, /0\.108\.5/);
  assert.match(line, /child abc-123/);
  assert.match(line, /0\.108\.4/);
  assert.doesNotMatch(line, /Exiting/);
});

test('formatUpdateAvailableLine: never throws on missing fields', () => {
  assert.doesNotThrow(() => formatUpdateAvailableLine(null, null, null, '0.108.5'));
});

// ---------------------------------------------------------------------------
// Integration: main() with a newer marketplace-only version and no cache dir
// must NOT print STALE BUILD / exit, and must keep the watcher armed and
// running (root cause + fix for the live field crash this file guards).
// ---------------------------------------------------------------------------

test('main(): newer version known via marketplace only (no cache dir) -> prints update-available, never STALE BUILD, and does not exit on its own', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-staleversion-main-'));
  try {
    const pluginsRoot = path.join(home, '.claude', 'plugins');
    const srcDir = path.join(pluginsRoot, 'marketplaces', 'anti-hall', 'plugins', 'anti-hall', '.claude-plugin');
    fs.mkdirSync(srcDir, { recursive: true });
    // A version far ahead of anything this repo will ever actually be at,
    // with deliberately NO cache/anti-hall/anti-hall/<v>/ dir created for it.
    fs.writeFileSync(path.join(srcDir, 'plugin.json'), JSON.stringify({ name: 'anti-hall', version: '0.999.0' }), 'utf8');

    const id = 'stale-notify-child-1';
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
      // pollMsFromEnv floor is 250ms — keep the poll loop fast so the update-
      // available line (checked every poll) shows up quickly in the test.
      ANTIHALL_DEVSWARM_WAKE_WATCH_POLL_MS: '250',
    };
    // The stale/update check runs BEFORE tick() on each loop iteration, so
    // the update-available notice can print on the very first poll, before
    // the arm line (which only comes from tick()'s own first call) — wait for
    // BOTH substrings to have appeared, in either order.
    const res = await waitForStdoutMatch([MODULE_PATH], { env },
      /(?=[\s\S]*armed: watching child stale-notify-child-1)(?=[\s\S]*update available: anti-hall 0\.999\.0)/, 6000);
    assert.match(res.stdout, /\[wake-watch\] armed: watching child stale-notify-child-1/,
      'must still arm normally; got stdout=' + JSON.stringify(res.stdout));
    assert.match(res.stdout, /\[wake-watch\] update available: anti-hall 0\.999\.0/,
      'must print the update-available notice; got stdout=' + JSON.stringify(res.stdout));
    assert.doesNotMatch(res.stdout, /STALE BUILD/,
      'must never claim a re-arm path that does not exist on disk');
    assert.strictEqual(res.exited, false,
      'must still be running (killed only by the test harness), never self-exit with no watcher left');
  } finally { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('formatStaleVersionLine: names role, id, own version, newest version, and the re-arm command', () => {
  const line = formatStaleVersionLine('child', 'abc-123', '0.105.3', '0.107.1', '/path/to/new/devswarm-wake-watch.js');
  assert.match(line, /STALE BUILD/);
  assert.match(line, /child abc-123/);
  assert.match(line, /0\.105\.3/);
  assert.match(line, /0\.107\.1/);
  assert.match(line, /node \/path\/to\/new\/devswarm-wake-watch\.js/);
  assert.match(line, /Exiting now/);
});

test('formatStaleVersionLine: never throws on missing role/id/version fields', () => {
  assert.doesNotThrow(() => formatStaleVersionLine(null, null, null, '0.107.1', '/p'));
});
