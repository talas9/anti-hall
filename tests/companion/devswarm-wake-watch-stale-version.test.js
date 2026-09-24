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

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js');
const { checkStaleVersion, formatStaleVersionLine } = require(MODULE_PATH);

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
    fs.mkdirSync(path.join(pluginsRoot, 'cache', 'anti-hall', 'anti-hall', v), { recursive: true });
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

test('checkStaleVersion: newest known version comes from the marketplace plugin.json alone (no cache dirs yet)', () => {
  const home = tmpHome();
  try {
    layoutPlugins(home, { marketplaceVersion: '0.108.0' });
    const out = checkStaleVersion('0.105.3', { ANTIHALL_MARKETPLACE_DIR: path.join(home, '.claude', 'plugins', 'marketplaces', 'anti-hall') });
    assert.ok(out);
    assert.strictEqual(out.newestVersion, '0.108.0');
  } finally { rm(home); }
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
