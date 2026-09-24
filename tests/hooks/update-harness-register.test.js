'use strict';
// update-harness-register — P0 fix (proven live): Claude Code loads this
// plugin from ~/.claude/plugins/installed_plugins.json's
// plugins["anti-hall@anti-hall"][].installPath, a HARNESS-OWNED pointer this
// helper only ever reads. Pulling + mirroring a new version into the
// version-pinned cache does nothing to that pointer, so after a restart a
// session keeps loading the STALE version forever, unless the harness itself
// re-registers it via `claude plugin update anti-hall@anti-hall`.
//
// This suite covers the unit (`harnessRegisterPostUpdate`) and its wiring
// into `runUpdate` (gated on installed_plugins.json's OWN version, not the
// resolveInstalledVersion() fallback chain — which would mask exactly this
// staleness by falling through to the cache dir/marketplace version).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const U = require('../../plugins/anti-hall/skills/update/scripts/update.js');

const REAL_PLUGIN_SRC_DIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');

// --- unit: harnessRegisterPostUpdate ---------------------------------------

test('harnessRegisterPostUpdate: no-op when installed_plugins already at latest', () => {
  let called = false;
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.2.3', latest: '1.2.3',
    execFn: () => { called = true; return ''; },
  });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(out.ok, false);
  assert.strictEqual(called, false, 'must never shell out when already current');
});

test('harnessRegisterPostUpdate: no-op when installed_plugins is ahead (never regress)', () => {
  let called = false;
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '2.0.0', latest: '1.2.3',
    execFn: () => { called = true; return ''; },
  });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(called, false);
});

test('harnessRegisterPostUpdate: no-op when either version is unknown/non-semver', () => {
  let called = false;
  const out = U.harnessRegisterPostUpdate({
    installedVersion: null, latest: '1.2.3',
    execFn: () => { called = true; return ''; },
  });
  assert.strictEqual(out.attempted, false);
  assert.strictEqual(called, false);
});

test('harnessRegisterPostUpdate: stale installed_plugins -> runs `claude plugin update anti-hall@anti-hall`', () => {
  const calls = [];
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0',
    execFn: (args) => { calls.push(args); return 'updated\n'; },
  });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], ['plugin', 'update', 'anti-hall@anti-hall']);
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, true);
  assert.match(out.detail, /RESTART Claude Code/,
    'field-verified: /reload-plugins does not pick up a harness registry update, only a real restart does');
  assert.doesNotMatch(out.detail, /\/reload-plugins is enough|or \/reload-plugins\)/,
    'must never imply /reload-plugins alone is sufficient after a harness registry update');
});

test('harnessRegisterPostUpdate: command failure is fail-open and reports the manual command (never throws)', () => {
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0',
    execFn: () => { const e = new Error('boom'); e.stderr = 'unknown plugin\n'; throw e; },
  });
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, false);
  assert.match(out.detail, /claude plugin update anti-hall@anti-hall/);
  assert.match(out.detail, /unknown plugin/);
});

test('harnessRegisterPostUpdate: an acceptance/confirmation prompt is NEVER auto-accepted', () => {
  const calls = [];
  const out = U.harnessRegisterPostUpdate({
    installedVersion: '1.0.0', latest: '1.1.0',
    execFn: (args) => { calls.push(args); return 'requires --accept-command <sha256> to proceed\n'; },
  });
  assert.strictEqual(calls.length, 1, 'exactly one attempt — no automatic retry with --accept-command');
  assert.ok(!calls.some((a) => a.includes('--accept-command')), 'must never pass --accept-command automatically');
  assert.strictEqual(out.attempted, true);
  assert.strictEqual(out.ok, false);
  assert.match(out.detail, /run manually: claude plugin update anti-hall@anti-hall/);
});

// --- integration: runUpdate wiring -----------------------------------------

function makeMarketplace(version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-harnessreg-'));
  const marketplaceDir = path.join(root, 'marketplaces', 'anti-hall');
  const srcDir = path.join(marketplaceDir, 'plugins', 'anti-hall');
  fs.mkdirSync(path.join(srcDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(srcDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'anti-hall', version }), 'utf8');
  for (const d of ['companion', 'hooks']) {
    fs.symlinkSync(path.join(REAL_PLUGIN_SRC_DIR, d), path.join(srcDir, d), 'dir');
  }
  fs.writeFileSync(path.join(marketplaceDir, 'CHANGELOG.md'), '# Changelog\n\n## ' + version + '\n- x\n', 'utf8');
  return { root, marketplaceDir, srcDir, cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} } };
}

const execStub = () => (args) => (args[0] === 'pull' ? 'Already up to date.\n' : '');

test('runUpdate: stale installed_plugins.json (older than freshly-pulled latest) -> harnessRegistered attempted', () => {
  const t = makeMarketplace('1.1.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessreg-home-'));
  try {
    fs.writeFileSync(path.join(t.root, 'installed_plugins.json'),
      JSON.stringify({ 'anti-hall@anti-hall': '1.0.0' }), 'utf8');
    const paths = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
    const calls = [];
    const out = U.runUpdate({
      paths,
      exec: execStub(),
      env: {},
      home,
      harnessExecFn: (args) => { calls.push(args); return 'updated\n'; },
    });
    assert.strictEqual(out.status.installed, '1.0.0');
    assert.strictEqual(out.status.latest, '1.1.0');
    assert.ok(out.status.harnessRegistered, 'harnessRegistered must be present on the status object');
    assert.strictEqual(out.status.harnessRegistered.attempted, true);
    assert.strictEqual(out.status.harnessRegistered.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], ['plugin', 'update', 'anti-hall@anti-hall']);
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runUpdate: installed_plugins.json already current -> harnessRegistered not attempted, never shells out', () => {
  const t = makeMarketplace('1.1.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessreg-home-'));
  try {
    fs.writeFileSync(path.join(t.root, 'installed_plugins.json'),
      JSON.stringify({ 'anti-hall@anti-hall': '1.1.0' }), 'utf8');
    const paths = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
    const calls = [];
    const out = U.runUpdate({
      paths,
      exec: execStub(),
      env: {},
      home,
      harnessExecFn: (args) => { calls.push(args); return ''; },
    });
    assert.strictEqual(out.status.harnessRegistered.attempted, false);
    assert.strictEqual(calls.length, 0);
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('runUpdate: never writes installed_plugins.json directly (harness-owned contract preserved)', () => {
  const t = makeMarketplace('1.1.0');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harnessreg-home-'));
  try {
    fs.writeFileSync(path.join(t.root, 'installed_plugins.json'),
      JSON.stringify({ 'anti-hall@anti-hall': '1.0.0' }), 'utf8');
    const before = fs.readFileSync(path.join(t.root, 'installed_plugins.json'), 'utf8');
    const paths = U.resolvePaths({ ANTIHALL_MARKETPLACE_DIR: t.marketplaceDir }, t.root);
    U.runUpdate({
      paths, exec: execStub(), env: {}, home,
      harnessExecFn: () => 'updated\n',
    });
    const after = fs.readFileSync(path.join(t.root, 'installed_plugins.json'), 'utf8');
    assert.strictEqual(after, before, 'installed_plugins.json must be byte-identical — only the harness CLI writes it');
  } finally {
    t.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
