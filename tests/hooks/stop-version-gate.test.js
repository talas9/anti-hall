'use strict';
// stop-version-gate.js — a nudge-class Stop hook can detect that
// installed_plugins.json (harness-owned) already registered a NEWER
// anti-hall version than the one this hook process is running, so it can
// downgrade its own block to advisory until the session restarts (peer
// complaint #2, 2026-09-26). Reuses skills/update/scripts/update.js's own
// exports (never reimplements installed_plugins.json parsing).
//
// Fixture: a throwaway "plugin root" with only .claude-plugin/plugin.json
// (the version) + skills/update/scripts/update.js (the REAL file, copied —
// its own path resolution only depends on `env`/`home`, never on where it
// physically lives, so copying it is safe and exercises the real logic).

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REAL_UPDATE_JS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'skills', 'update', 'scripts', 'update.js');
const GATE = require('../../plugins/anti-hall/hooks/lib/stop-version-gate.js');

// Safety-net sweep: every makeFixtureRoot()/makeHome() dir is tracked here
// regardless of whether a given test's own fs.rmSync ran, so a missed
// cleanup never leaks an antihall-stop-version-gate-* dir into os.tmpdir().
const _tracked = new Set();
after(() => {
  for (const d of _tracked) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_) {
      /* best-effort */
    }
  }
});

function makeFixtureRoot(runningVersion) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-stop-version-gate-'));
  _tracked.add(root);
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: runningVersion }));
  fs.mkdirSync(path.join(root, 'skills', 'update', 'scripts'), { recursive: true });
  fs.copyFileSync(REAL_UPDATE_JS, path.join(root, 'skills', 'update', 'scripts', 'update.js'));
  return root;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-stop-version-gate-home-'));
  _tracked.add(home);
  return home;
}

function writeInstalledJson(home, version) {
  const p = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ plugins: { 'anti-hall@anti-hall': { version, scope: 'user' } } }));
}

test('isStale: installed_plugins.json AHEAD of the running version -> true', () => {
  const root = makeFixtureRoot('0.111.0');
  const home = makeHome();
  try {
    writeInstalledJson(home, '0.112.0');
    assert.strictEqual(GATE.isStale(root, { env: {}, home }), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isStale: installed_plugins.json SAME as the running version -> false', () => {
  const root = makeFixtureRoot('0.111.0');
  const home = makeHome();
  try {
    writeInstalledJson(home, '0.111.0');
    assert.strictEqual(GATE.isStale(root, { env: {}, home }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isStale: installed_plugins.json BEHIND the running version -> false', () => {
  const root = makeFixtureRoot('0.112.0');
  const home = makeHome();
  try {
    writeInstalledJson(home, '0.111.0');
    assert.strictEqual(GATE.isStale(root, { env: {}, home }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isStale: no installed_plugins.json at all -> false (fail-open)', () => {
  const root = makeFixtureRoot('0.111.0');
  const home = makeHome();
  try {
    assert.strictEqual(GATE.isStale(root, { env: {}, home }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isStale: malformed installed_plugins.json -> false (fail-open)', () => {
  const root = makeFixtureRoot('0.111.0');
  const home = makeHome();
  try {
    const p = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    assert.strictEqual(GATE.isStale(root, { env: {}, home }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isStale: guards.stopHookVersionDowngrade=false / ANTIHALL_STOP_HOOK_VERSION_DOWNGRADE=off -> always false', () => {
  const root = makeFixtureRoot('0.111.0');
  const home = makeHome();
  try {
    writeInstalledJson(home, '0.112.0');
    assert.strictEqual(GATE.isStale(root, { env: { ANTIHALL_STOP_HOOK_VERSION_DOWNGRADE: 'off' }, home }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('isStale: missing plugin root -> false (fail-open, no throw)', () => {
  const home = makeHome();
  try {
    writeInstalledJson(home, '0.112.0');
    assert.strictEqual(GATE.isStale('/no/such/plugin/root', { env: {}, home }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
