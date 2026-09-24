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

// Hand-built child envs: a test that spawns doctor or an installer with an env
// it built itself (not merged onto process.env) must carry the test marker —
// that shape (a stripped env) is exactly how the leak got through. A file that
// deliberately runs without the marker says so with `hygiene:no-test-marker`.
test('every hand-built env passed to a doctor/installer spawn carries ANTIHALL_TEST_ISOLATION', () => {
  const TESTS = path.join(__dirname, '..');
  const SCRIPT_RE = /doctor\.js|DOCTOR_JS|install-(devswarm-supervisor|devswarm-ingest|reaper)\.js|install-statusline\.js|uninstall-statusline\.js|install-codex\.js|\bINSTALLER\b|\bINSTALL\b/;
  const SAFE_RE = /ANTIHALL_TEST_ISOLATION|NODE_TEST_CONTEXT|process\.env\s*[,)}]|\.\.\.process\.env/;
  const balanced = (src, i, open, close) => { let d = 0; for (let j = i; j < src.length; j++) { if (src[j] === open) d++; else if (src[j] === close && --d === 0) return src.slice(i, j + 1); } return src.slice(i); };
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'fixtures') walk(p); continue; }
      if (!e.name.endsWith('.test.js')) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (src.includes('hygiene:' + 'no-test-marker')) continue;
      const re = /\b(spawnSync|execFileSync|spawn|execSync)\(/g;
      let m;
      while ((m = re.exec(src))) {
        const call = balanced(src, m.index + m[0].length - 1, '(', ')');
        if (!SCRIPT_RE.test(call)) continue;
        const lit = call.search(/\benv:\s*\{/);
        const asg = call.search(/\benv:\s*Object\.assign\(/);
        let env = null;
        if (lit >= 0) env = balanced(call, call.indexOf('{', lit), '{', '}');
        else if (asg >= 0) env = balanced(call, call.indexOf('(', asg), '(', ')');
        if (env && !SAFE_RE.test(env)) offenders.push(path.relative(TESTS, p) + ':' + src.slice(0, m.index).split('\n').length);
      }
    }
  };
  walk(TESTS);
  assert.deepStrictEqual(offenders, [], 'add ANTIHALL_TEST_ISOLATION: \'1\' (or merge onto process.env) at: ' + offenders.join(', '));
});

test('install-reaper.js forces dry-run on a temp HOME with NO test marker at all (same guard as supervisor/ingest)', { skip: !POSIX }, () => {
  const home = mkd('ah-svc-reaper-home-');
  const record = path.join(home, 'calls.log');
  const bin = stubBin(record);
  try {
    // Deliberately marker-free (no NODE_TEST_CONTEXT, no ANTIHALL_TEST_ISOLATION):
    // only the temp-HOME guard stands between this run and a real unit. PATH
    // stubs catch launchctl/systemctl/crontab even if that guard broke.
    const bare = { PATH: bin + path.delimiter + process.env.PATH, HOME: home, USERPROFILE: home };
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'companion', 'install-reaper.js')], { cwd: home, env: bare, encoding: 'utf8', timeout: 30000 });
    assert.match(r.stderr, /forced dry-run \(HOME .* temp directory\)/, r.stdout + r.stderr);
    assert.strictEqual(recorded(record), '', 'no scheduler call reached even a stub');
    assert.deepStrictEqual(fs.readdirSync(home).filter((f) => f === 'Library' || f === '.config'), []);
  } finally { rm(home); rm(bin); }
});
