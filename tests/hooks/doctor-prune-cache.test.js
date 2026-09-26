'use strict';
// doctor --prune-cache [--confirmed] (owner-approved 2026-09-26): opt-in,
// never automatic. Lists old plugin cache version dirs; only --confirmed
// removes them. Keeps the newest 3, the registered installPath, live-process
// versions, the running version and anything unparseable; refuses symlinks.
// Every test uses a fixture HOME with a fixture cache — never the real one.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');
const cachePrune = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'cache-prune.js'));

function makeFixture(versions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-prune-cache-'));
  const root = cachePrune.cacheRootFor(home);
  fs.mkdirSync(root, { recursive: true });
  for (const v of versions) {
    fs.mkdirSync(path.join(root, v, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, v, 'hooks', 'x.js'), 'x'.repeat(1000));
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-prune-outside-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  return {
    home, root, outside,
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    },
  };
}

function register(home, installPath) {
  const p = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  fs.writeFileSync(p, JSON.stringify({ version: 2, plugins: { 'anti-hall@anti-hall': [{ scope: 'user', version: '0.101.0', installPath }] } }));
}

const VERSIONS = ['0.100.0', '0.101.0', '0.102.0', '0.103.0', '0.104.0', '0.105.0', '0.106.0', '0.107.0', '0.108.0'];

function byName(plan) {
  const m = {};
  for (const e of plan.entries) m[e.name] = e;
  return m;
}

test('prune-cache plan: keep rules (newest 3, registered, live cwd/argv, running, unparseable, symlink)', () => {
  const f = makeFixture(VERSIONS);
  try {
    fs.mkdirSync(path.join(f.root, 'abc123def'));                       // unparseable
    fs.writeFileSync(path.join(f.root, '0.98.0'), 'not a dir');          // not a directory
    fs.symlinkSync(f.outside, path.join(f.root, '0.99.0'));              // symlink
    register(f.home, path.join(f.root, '0.101.0'));
    const plan = cachePrune.planCachePrune({
      home: f.home,
      runningVersion: '0.100.0',
      runningRoot: path.join(os.tmpdir(), 'not-in-cache'),
      scanCwds: () => ['/', path.join(f.root, '0.102.0', 'hooks')],
      scanArgv: () => ['node ' + path.join(f.root, '0.103.0', 'hooks', 'x.js') + ' --flag'],
    });
    assert.strictEqual(plan.ok, true);
    const e = byName(plan);
    const removed = plan.entries.filter((x) => x.action === 'remove').map((x) => x.name).sort();
    assert.deepStrictEqual(removed, ['0.104.0', '0.105.0']);
    assert.ok(e['0.108.0'].reasons.includes('newest 3'));
    assert.ok(e['0.106.0'].reasons.includes('newest 3'));
    assert.ok(e['0.101.0'].reasons.includes('registered installPath'));
    assert.ok(e['0.102.0'].reasons.includes('live process'));
    assert.ok(e['0.103.0'].reasons.includes('live process'));
    assert.ok(e['0.100.0'].reasons.includes('running version'));
    assert.ok(e['abc123def'].reasons.includes('unparseable name'));
    assert.ok(e['0.98.0'].reasons.includes('not a directory'));
    assert.ok(e['0.99.0'].reasons.includes('symlink (refused)'));
    assert.strictEqual(plan.removeBytes, 2000);
    // Listing alone removes nothing.
    for (const v of VERSIONS) assert.ok(fs.existsSync(path.join(f.root, v)), v);
  } finally {
    f.cleanup();
  }
});

test('prune-cache plan: an unavailable live-process scan keeps everything', () => {
  const f = makeFixture(VERSIONS);
  try {
    const plan = cachePrune.planCachePrune({ home: f.home, scanCwds: () => null, scanArgv: () => [] });
    assert.deepStrictEqual(plan.entries.filter((x) => x.action === 'remove'), []);
  } finally {
    f.cleanup();
  }
});

test('prune-cache apply: removes only the listed dirs; a dir swapped for a symlink is refused', () => {
  const f = makeFixture(VERSIONS);
  try {
    const plan = cachePrune.planCachePrune({ home: f.home, scanCwds: () => ['/'], scanArgv: () => [] });
    const listed = plan.entries.filter((x) => x.action === 'remove').map((x) => x.name).sort();
    assert.deepStrictEqual(listed, ['0.100.0', '0.101.0', '0.102.0', '0.103.0', '0.104.0', '0.105.0']);
    // Between listing and removal, 0.100.0 becomes a symlink to a dir outside the root.
    fs.rmSync(path.join(f.root, '0.100.0'), { recursive: true });
    fs.symlinkSync(f.outside, path.join(f.root, '0.100.0'));
    const log = [];
    const res = cachePrune.applyCachePrune(plan, (m) => log.push(m));
    assert.deepStrictEqual(res.removed.map((r) => path.basename(r.dir)).sort(), ['0.101.0', '0.102.0', '0.103.0', '0.104.0', '0.105.0']);
    assert.deepStrictEqual(res.refused.map((r) => [path.basename(r.dir), r.why]), [['0.100.0', 'symlink']]);
    assert.ok(fs.existsSync(path.join(f.outside, 'keep.txt')), 'symlink target untouched');
    for (const v of ['0.106.0', '0.107.0', '0.108.0']) assert.ok(fs.existsSync(path.join(f.root, v)), v);
    assert.strictEqual(log.filter((l) => l.startsWith('removed ')).length, 5);
  } finally {
    f.cleanup();
  }
});

test('prune-cache plan: a symlinked cache root is refused outright', () => {
  const f = makeFixture([]);
  try {
    fs.rmSync(f.root, { recursive: true });
    fs.symlinkSync(f.outside, f.root);
    const plan = cachePrune.planCachePrune({ home: f.home, scanCwds: () => ['/'], scanArgv: () => [] });
    assert.strictEqual(plan.ok, false);
    assert.deepStrictEqual(cachePrune.applyCachePrune(plan), { removed: [], refused: [] });
    assert.ok(fs.existsSync(path.join(f.outside, 'keep.txt')));
  } finally {
    f.cleanup();
  }
});

// Same isolation contract as doctor-repair-flag-early-exit.test.js: every
// caller passes its own fixture home; the fallback is a disposable mkdtemp dir.
function runDoctor(home, args) {
  const fallbackHome = home || fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-default-home-'));
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS].concat(args), {
    encoding: 'utf8', timeout: 60000,
    env: Object.assign({}, process.env, {
      HOME: fallbackHome, USERPROFILE: fallbackHome, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
      ANTIHALL_ALLOW_CACHE_PRUNE: undefined, ANTIHALL_INGEST_DRY_RUN: '1',
    }),
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

// The real lsof//proc scan is time-bounded; under heavy machine load it can
// time out, and doctor then (correctly) keeps everything with reason
// "live-process scan unavailable". That is the fail-closed path, not a
// verdict on the listing logic, so retry a bounded number of times.
function runDoctorScanned(home, args) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = runDoctor(home, args);
    if (!/live-process scan unavailable/.test(r.out)) return r;
  }
  return r;
}

const CLI_VERSIONS = ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0'];

test('doctor --prune-cache lists only; --confirmed is required to remove', () => {
  const f = makeFixture(CLI_VERSIONS);
  try {
    const listed = runDoctorScanned(f.home, ['--prune-cache']);
    assert.match(listed.out, /would remove .*0\.1\.0/, listed.out);
    assert.match(listed.out, /would remove .*0\.2\.0/);
    assert.match(listed.out, /2 dir\(s\) to remove/);
    assert.doesNotMatch(listed.out, /Hooks present/, 'exits before the self-tests');
    for (const v of CLI_VERSIONS) assert.ok(fs.existsSync(path.join(f.root, v)), 'listing removed ' + v);

    const applied = runDoctorScanned(f.home, ['--prune-cache', '--confirmed']);
    assert.match(applied.out, /removed .*0\.1\.0/, applied.out);
    assert.match(applied.out, /removed 2 dir\(s\)/);
    assert.ok(!fs.existsSync(path.join(f.root, '0.1.0')));
    assert.ok(!fs.existsSync(path.join(f.root, '0.2.0')));
    for (const v of ['0.3.0', '0.4.0', '0.5.0']) assert.ok(fs.existsSync(path.join(f.root, v)), v);
  } finally {
    f.cleanup();
  }
});

test('doctor --prune-cache keeps a version a real live process runs from (cwd scan)', { skip: !['darwin', 'linux'].includes(process.platform) }, () => {
  const f = makeFixture(CLI_VERSIONS);
  const child = cp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    cwd: path.join(f.root, '0.1.0'), stdio: 'ignore', env: { PATH: process.env.PATH, HOME: f.home },
  });
  try {
    const listed = runDoctorScanned(f.home, ['--prune-cache']);
    assert.match(listed.out, /keep .*0\.1\.0 \(live process\)/);
    assert.match(listed.out, /would remove .*0\.2\.0/);
    assert.doesNotMatch(listed.out, /would remove .*0\.1\.0/);
  } finally {
    child.kill('SIGKILL');
    f.cleanup();
  }
});

test('doctor --prune-cache is refused when updates.allowCachePrune=false', () => {
  const f = makeFixture(CLI_VERSIONS);
  try {
    fs.mkdirSync(path.join(f.home, '.anti-hall'), { recursive: true });
    fs.writeFileSync(path.join(f.home, '.anti-hall', 'settings.json'), JSON.stringify({ updates: { allowCachePrune: false } }));
    const res = runDoctor(f.home, ['--prune-cache', '--confirmed']);
    assert.notStrictEqual(res.code, 0);
    assert.match(res.out, /disabled by updates\.allowCachePrune=false/);
    for (const v of CLI_VERSIONS) assert.ok(fs.existsSync(path.join(f.root, v)), v);
  } finally {
    f.cleanup();
  }
});

test('nothing but doctor --prune-cache reaches the prune code', () => {
  const pluginDir = path.join(REPO_ROOT, 'plugins', 'anti-hall');
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(?:js|mjs|cjs)$/.test(e.name) || e.name === 'cache-prune.js') continue;
      // A require of the prune module, or the flag as a string literal (an argv
      // a spawner would pass) — prose mentions in descriptions do not count.
      if (/require\([^)]*cache-prune|['"]--prune-cache['"]/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(pluginDir, p));
    }
  };
  walk(pluginDir);
  assert.deepStrictEqual(hits.sort(), ['hooks/doctor.js']);
});
