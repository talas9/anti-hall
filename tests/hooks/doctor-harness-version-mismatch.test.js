'use strict';
// doctor-harness-version-mismatch — read-only doctor check for the same P0
// this ships alongside (skills/update/scripts/update.js's
// harnessRegisterPostUpdate): ~/.claude/plugins/installed_plugins.json is
// HARNESS-OWNED, and a session keeps loading whatever version it names even
// after the marketplace clone + cache are updated. `doctor` (never
// `doctor --repair`) should WARN plainly when installed_plugins.json's own
// recorded version is older than the newest version present in
// cache/anti-hall/anti-hall/ or the marketplace plugin.json, with the exact
// fix command — never silently OK a stale harness registration.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DOCTOR_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'doctor.js');

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-harnessver-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// Lays out ~/.claude/plugins/{installed_plugins.json, cache/anti-hall/anti-hall/<v>/,
// marketplaces/anti-hall/plugins/anti-hall/.claude-plugin/plugin.json} exactly as
// resolvePaths() in update.js expects, under a disposable HOME.
function layoutPlugins(home, { installedVersion, cacheVersions, marketplaceVersion }) {
  const pluginsRoot = path.join(home, '.claude', 'plugins');
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
}

function runDoctor({ home, cwd, env }) {
  const callerEnv = env || {};
  // Isolation contract (tests/hooks/doctor-default-home-isolation.test.js):
  // a bare `HOME: undefined` here would NOT isolate anything — os.homedir()
  // falls back through the platform passwd db to the REAL machine home. Every
  // call site in this file passes its own `home`, but the fallback stays a
  // disposable mkdtemp dir, matching every other doctor.js spawner in this repo.
  const fallbackHome = ('HOME' in callerEnv) ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS, '--check'], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: home || fallbackHome, USERPROFILE: home || fallbackHome, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
    }, callerEnv),
  });
  return {
    code: res.status,
    out: (res.stdout || '') + (res.stderr || '')
      + (res.signal ? `\n[runDoctor: process terminated by signal ${res.signal}]` : ''),
  };
}

test('doctor: installed_plugins.json older than newest cache version -> WARN with the exact fix command', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-harnessver-cwd-'));
  try {
    layoutPlugins(home, { installedVersion: '0.105.3', cacheVersions: ['0.105.3', '0.107.1'] });
    const r = runDoctor({ home, cwd });
    assert.match(r.out, /installed_plugins\.json reports 0\.105\.3, but 0\.107\.1 is available/,
      'must name BOTH the stale registered version and the newest available one:\n' + r.out);
    assert.match(r.out, /claude plugin update anti-hall@anti-hall/,
      'must print the exact re-registration command:\n' + r.out);
    assert.match(r.out, /!.*installed_plugins\.json reports/, 'must be a WARN (!) line, not silently passed');
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: installed_plugins.json already at the newest version -> OK, no warning', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-harnessver-cwd-'));
  try {
    layoutPlugins(home, { installedVersion: '0.107.1', cacheVersions: ['0.105.3', '0.107.1'] });
    const r = runDoctor({ home, cwd });
    assert.match(r.out, /installed_plugins\.json harness registration is current \(0\.107\.1\)/, r.out);
    assert.doesNotMatch(r.out, /has not re-registered this build/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});

test('doctor: no installed_plugins.json at all -> fails open, no crash, no false warning', () => {
  const { home, cleanup } = makeFakeHome();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-harnessver-cwd-'));
  try {
    // Nothing laid out at all — resolvePaths/versionFromInstalledJson must fail
    // open to null rather than throwing.
    const r = runDoctor({ home, cwd });
    assert.strictEqual(r.code, 0, 'doctor must still exit cleanly with no plugins dir at all:\n' + r.out);
    assert.doesNotMatch(r.out, /has not re-registered this build/);
  } finally {
    cleanup();
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (_) {}
  }
});
