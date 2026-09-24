'use strict';
// No test may register a real launchd/systemd/cron job or write user config
// outside a temp dir (0.108.0 launchd leak). The leak: tests called
// runRepairs({ env: {}, dryRun: false }); doctor-repair's spawnInstaller passed
// that `{}` to spawnSync, which REPLACES the child env, so the installer child
// had no HOME (os.homedir() -> the real passwd home) and no NODE_TEST_CONTEXT.
// Every guard passed and it ran a real `launchctl load`, re-pointing the
// machine's supervisor at a scratch checkout. devswarm.js's selfHeal spawned
// the ingest installer with the same stripped env (only the temp-HOME guard
// held there).
//
// Three layers, each proven here:
//   1. installer spawns merge the caller env onto process.env and carry the
//      test markers (installerChildEnv);
//   2. every installer refuses launchctl/systemctl/crontab under a test
//      (runServiceCmd seam) and forces dry-run on the ANTIHALL_TEST_ISOLATION
//      marker alone; statusline/codex installers refuse user config outside tmp;
//   3. the vulnerable call shapes run end to end under a fake HOME with a
//      PATH-stubbed launchctl/systemctl/crontab that records every call: no
//      call is recorded and no real-home unit/config references this checkout.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const guard = require(path.join(ROOT, 'companion', 'lib', 'test-home-guard.js'));
const REAL = os.userInfo().homedir;
const POSIX = process.platform !== 'win32';

function mkd(prefix) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// stubBin(record) -> dir holding launchctl/systemctl/crontab stubs that append
// "<cmd> <args>" to `record` and exit 0.
function stubBin(record) {
  const dir = mkd('ah-svc-stub-');
  for (const cmd of ['launchctl', 'systemctl', 'crontab']) {
    const p = path.join(dir, cmd);
    fs.writeFileSync(p, '#!/bin/sh\necho "' + cmd + ' $*" >> ' + JSON.stringify(record) + '\nexit 0\n');
    fs.chmodSync(p, 0o755);
  }
  return dir;
}
function recorded(record) { try { return fs.readFileSync(record, 'utf8').trim(); } catch (_) { return ''; } }

// realMentions() -> which real-home unit/config files reference THIS checkout.
// Read-only. Compared before/after, so a pre-existing reference (a developer
// who installed from this path on purpose) never fails the test.
function realMentions() {
  const needle = ROOT;
  const out = {};
  const files = [path.join(REAL, '.claude', 'settings.json'), path.join(REAL, '.codex', 'config.toml'), path.join(REAL, '.codex', 'hooks.json')];
  for (const d of [path.join(REAL, 'Library', 'LaunchAgents'), path.join(REAL, '.config', 'systemd', 'user')]) {
    try { for (const f of fs.readdirSync(d)) if (/anti-hall/.test(f)) files.push(path.join(d, f)); } catch (_) {}
  }
  for (const f of files) {
    try { out[f] = fs.readFileSync(f, 'utf8').includes(needle); } catch (_) { out[f] = 'absent'; }
  }
  return out;
}

function gitRepo() {
  const repo = mkd('ah-svc-repo-');
  cp.spawnSync('git', ['init', '-q', repo]);
  cp.spawnSync('git', ['-C', repo, '-c', 'user.email=a@b.c', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
  return repo;
}

// withProcessEnv(patch, fn): run fn with process.env patched, restored after.
function withProcessEnv(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = process.env[k]; process.env[k] = patch[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('installerChildEnv keeps HOME/PATH and the test markers when the caller env is partial', () => {
  const e = guard.installerChildEnv({});
  assert.strictEqual(e.HOME, process.env.HOME);
  assert.strictEqual(e.PATH, process.env.PATH);
  assert.ok(e.NODE_TEST_CONTEXT, 'NODE_TEST_CONTEXT carried from the parent');
  const cleared = guard.installerChildEnv({ NODE_TEST_CONTEXT: '' }, { HOME: '/x' });
  assert.ok(cleared.NODE_TEST_CONTEXT, 'a caller clearing the marker does not strip it');
  assert.strictEqual(cleared.HOME, '/x', 'overrides win');
});

test('runServiceCmd refuses launchctl/systemctl/crontab under a test; user config outside tmp is refused', () => {
  for (const c of ['launchctl', 'systemctl', 'crontab', '/bin/launchctl']) {
    assert.strictEqual(guard.runServiceCmd(c, ['load', '/nonexistent.plist']).refused, true, c);
  }
  assert.strictEqual(guard.refuseServiceCmd('git'), false);
  assert.strictEqual(guard.userConfigWriteRefused(path.join(REAL, '.claude', 'settings.json')), true);
  assert.strictEqual(guard.userConfigWriteRefused(path.join(os.tmpdir(), 'h', '.claude', 'settings.json')), false);
});

test('installers force dry-run on the ANTIHALL_TEST_ISOLATION marker alone (no NODE_TEST_CONTEXT, temp-HOME opt-outs set)', { skip: !POSIX }, () => {
  const home = mkd('ah-svc-home-');
  const repo = gitRepo(); // the ingest installer no-ops outside a git worktree
  const record = path.join(home, 'calls.log');
  const bin = stubBin(record);
  try {
    for (const inst of ['install-devswarm-supervisor.js', 'install-devswarm-ingest.js', 'install-reaper.js']) {
      const env = {
        PATH: bin + path.delimiter + process.env.PATH, HOME: home, ANTIHALL_TEST_ISOLATION: '1',
        ANTIHALL_SUPERVISOR_ALLOW_TMP_HOME: '1', ANTIHALL_INGEST_ALLOW_TMP_HOME: '1', ANTIHALL_DEVSWARM_HIVECONTROL: '/nonexistent/hivecontrol',
      };
      const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'companion', inst)], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
      assert.match(r.stdout + r.stderr, /dry-run/, inst + ' must run as a dry-run: ' + (r.stdout + r.stderr).slice(0, 400));
    }
    assert.strictEqual(recorded(record), '', 'no launchctl/systemctl/crontab call may reach even a stub');
    assert.deepStrictEqual(fs.readdirSync(home).filter((f) => f === 'Library' || f === '.config'), [], 'no unit file written under the fake HOME either');
  } finally { rm(home); rm(repo); rm(bin); }
});

test('vulnerable call shapes (runRepairs env:{} dryRun:false; selfHeal with a partial ctx.env) register nothing and touch no real-home config', { skip: !POSIX }, () => {
  const before = realMentions();
  const home = mkd('ah-svc-home-');
  const repo = gitRepo();
  const record = path.join(home, 'calls.log');
  const bin = stubBin(record);
  try {
    // Seed an "installed" supervisor unit in the FAKE home so runRepairs takes
    // the relaunch branch (spawnInstaller) — the exact leak path.
    fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
    fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', 'com.anti-hall.devswarm-supervisor.plist'), '<plist/>');
    fs.mkdirSync(path.join(home, '.config', 'systemd', 'user'), { recursive: true });
    fs.writeFileSync(path.join(home, '.config', 'systemd', 'user', 'anti-hall-devswarm-supervisor.timer'), '[Timer]\n');
    // A settings.json in the fake home: the statusline repair installs into it,
    // which proves where the installer child resolved HOME.
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}\n');

    withProcessEnv({ HOME: home, USERPROFILE: home, PATH: bin + path.delimiter + process.env.PATH }, () => {
      const repair = require(path.join(ROOT, 'hooks', 'lib', 'doctor-repair.js'));
      repair.runRepairs({ home, cwd: repo, env: { DEVSWARM_REPO_ID: 'repo-hygiene' }, dryRun: false });
      repair.runRepairs({ home, cwd: repo, env: {}, dryRun: false });
      const cli = require(path.join(ROOT, 'scripts', 'devswarm.js'));
      cli.selfHeal({ home, cwd: repo, env: { DEVSWARM_REPO_ID: 'repo-hygiene' } });
    });

    // Non-vacuity: the statusline installer child ran with the FAKE home
    // (the pre-fix `env: {}` child resolved the REAL home instead).
    const fakeSettings = path.join(home, '.claude', 'settings.json');
    assert.ok(JSON.parse(fs.readFileSync(fakeSettings, 'utf8')).statusLine, 'installer children must resolve the fake HOME, proving the env reached them');
    assert.strictEqual(recorded(record), '', 'no launchctl/systemctl/crontab call may be issued under a test');
    assert.deepStrictEqual(realMentions(), before, 'no real-home unit/config may newly reference this checkout');
  } finally { rm(home); rm(repo); rm(bin); }
});
