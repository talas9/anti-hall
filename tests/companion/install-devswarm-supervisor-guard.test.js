'use strict';
// install-devswarm-supervisor.js test/temp-HOME guard (v0.108.0): the same class
// of guard install-devswarm-ingest.js and install-reaper.js carry. A run under
// `node --test` or with HOME under a temp root must be forced to dry-run so a
// test fixture (or repair-on-reload's detached doctor --repair in a fixture
// home) can never register a real machine-singleton supervisor unit.
//
// Belt and braces: every spawn here runs with PATH pointing at an empty dir,
// so even a broken guard could not reach launchctl/systemctl/crontab by name.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALLER = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-supervisor.js');

function run(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sup-guard-'));
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-sup-bin-'));
  const base = { HOME: home, USERPROFILE: home, PATH: emptyBin, ANTIHALL_DEVSWARM_HIVECONTROL: '/nonexistent/hivecontrol' };
  const r = spawnSync(process.execPath, [INSTALLER], { encoding: 'utf8', env: Object.assign(base, env), timeout: 30000 });
  const unitFiles = [
    path.join(home, 'Library', 'LaunchAgents', 'com.anti-hall.devswarm-supervisor.plist'),
    path.join(home, '.config', 'systemd', 'user', 'anti-hall-devswarm-supervisor.service'),
    path.join(home, '.config', 'systemd', 'user', 'anti-hall-devswarm-supervisor.timer'),
  ].filter((f) => fs.existsSync(f));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(emptyBin, { recursive: true, force: true });
  return { r, unitFiles };
}

test('temp HOME (no node --test marker) -> forced dry-run, nothing written, stderr names the guard', { skip: process.platform === 'win32' }, () => {
  const { r, unitFiles } = run({});
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\] would write/);
  assert.deepStrictEqual(unitFiles, []);
  assert.match(r.stderr, /forced dry-run \(HOME .* temp directory\)/);
});

test('NODE_TEST_CONTEXT alone forces dry-run even when the temp-HOME opt-out is set', { skip: process.platform === 'win32' }, () => {
  const { r, unitFiles } = run({ NODE_TEST_CONTEXT: 'child-v8', ANTIHALL_SUPERVISOR_ALLOW_TMP_HOME: '1' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[dry-run\]/);
  assert.deepStrictEqual(unitFiles, []);
  assert.match(r.stderr, /NODE_TEST_CONTEXT is set/);
});

test('the module exposes the guard state; under node --test it is dry-run', () => {
  const mod = require(INSTALLER);
  assert.strictEqual(mod.NODE_TEST_CONTEXT_GUARD, true);
  assert.strictEqual(mod.DRYRUN, true);
});
