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

test('prune-cache plan: a registered installPath in a different case is KEPT (darwin, case-insensitive)', { skip: process.platform !== 'darwin' }, () => {
  const f = makeFixture(VERSIONS);
  try {
    // Change the case of the fixture home segment: same dir on a case-insensitive volume.
    const base = path.basename(f.home);
    const odd = path.join(path.dirname(f.home), base.toUpperCase(), '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall', '0.100.0');
    register(f.home, odd);
    const plan = cachePrune.planCachePrune({ home: f.home, scanCwds: () => ['/'], scanArgv: () => [] });
    const e = byName(plan);
    assert.ok(e['0.100.0'].reasons.includes('registered installPath'), JSON.stringify(e['0.100.0']));
    assert.strictEqual(e['0.100.0'].action, 'keep');
  } finally {
    f.cleanup();
  }
});

test('prune-cache plan: a registered installPath through /tmp, a trailing slash or .. is KEPT', () => {
  const f = makeFixture(VERSIONS);
  try {
    const cases = [path.join(f.root, '0.100.0') + '/', path.join(f.root, '0.105.0', '..', '0.100.0')];
    if (process.platform === 'darwin' && f.root.startsWith('/private/tmp/')) cases.push(f.root.replace('/private/tmp/', '/tmp/') + '/0.100.0');
    for (const reg of cases) {
      register(f.home, reg);
      const plan = cachePrune.planCachePrune({ home: f.home, scanCwds: () => ['/'], scanArgv: () => [] });
      assert.ok(byName(plan)['0.100.0'].reasons.includes('registered installPath'), reg);
    }
  } finally {
    f.cleanup();
  }
});

test('prune-cache plan: live argv/cwd match on the cache suffix whatever the prefix, with a path boundary', () => {
  const f = makeFixture(VERSIONS);
  try {
    const suffix = (v) => '/plugins/cache/anti-hall/anti-hall/' + v;
    const plan = cachePrune.planCachePrune({
      home: f.home,
      scanCwds: () => ['/', '/tmp/aliased-home/.claude' + suffix('0.100.0')],
      scanArgv: () => [
        'node /some/symlinked/home/.claude' + suffix('0.101.0') + '/hooks/x.js',
        'node "/quoted/.claude' + suffix('0.102.0') + '"',
        'node /h/.claude' + suffix('0.103.0') + '.bak/x.js',   // no boundary: not 0.103.0
        'node /h/.claude' + suffix('0.104.0') + '0/x.js',      // 0.104.00: not 0.104.0
      ],
    });
    const e = byName(plan);
    for (const v of ['0.100.0', '0.101.0', '0.102.0']) assert.ok(e[v].reasons.includes('live process'), v);
    for (const v of ['0.103.0', '0.104.0']) assert.strictEqual(e[v].action, 'remove', v);
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

test('prune-cache plan: a version named in a recent transcript tail is KEPT with the referenced reason', () => {
  const f = makeFixture(VERSIONS);
  try {
    const plan = cachePrune.planCachePrune({
      home: f.home,
      scanCwds: () => ['/'],
      scanArgv: () => [],
      scanTranscripts: () => new Set(['0.104.0']),
    });
    const e = byName(plan);
    assert.ok(e['0.104.0'].reasons.includes('referenced by a recent session (cron/Monitor/command)'));
    assert.strictEqual(e['0.104.0'].action, 'keep');
    // Not otherwise protected: 0.105.0 is still removed.
    assert.strictEqual(e['0.105.0'].action, 'remove');
  } finally {
    f.cleanup();
  }
});

test('prune-cache plan: an unavailable transcript scan keeps everything (fail-safe)', () => {
  const f = makeFixture(VERSIONS);
  try {
    const plan = cachePrune.planCachePrune({
      home: f.home,
      scanCwds: () => ['/'],
      scanArgv: () => [],
      scanTranscripts: () => null,
    });
    assert.deepStrictEqual(plan.entries.filter((x) => x.action === 'remove'), []);
    const e = byName(plan);
    assert.ok(e['0.104.0'].reasons.includes('transcript scan unavailable'));
  } finally {
    f.cleanup();
  }
});

test('defaultScanTranscripts: no ~/.claude/projects at all is an empty scan, not "unavailable"', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-prune-transcripts-empty-'));
  try {
    const result = cachePrune.defaultScanTranscripts(home);
    assert.ok(result instanceof Set, 'ENOENT must return an empty Set, not null');
    assert.strictEqual(result.size, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('defaultScanTranscripts: finds a versioned cache path in the TAIL of a recent transcript, ignores old/oversize-prefix files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-prune-transcripts-'));
  try {
    const projDir = path.join(home, '.claude', 'projects', 'my-project');
    fs.mkdirSync(projDir, { recursive: true });
    // Recent transcript: padding then a line naming a versioned cache path near the end.
    const pad = 'x'.repeat(10000) + '\n';
    const recentLine = JSON.stringify({ text: 'node ' + path.join(home, '.claude', 'plugins', 'cache', 'anti-hall', 'anti-hall', '0.109.0', 'scripts', 'devswarm.js') + ' inbox tick abc' });
    fs.writeFileSync(path.join(projDir, 'recent.jsonl'), pad + recentLine + '\n');
    // Old transcript (mtime > 7 days ago): must NOT contribute even though it names a version.
    const oldLine = JSON.stringify({ text: 'plugins/cache/anti-hall/anti-hall/0.110.0/scripts/devswarm.js' });
    const oldFile = path.join(projDir, 'old.jsonl');
    fs.writeFileSync(oldFile, oldLine + '\n');
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, eightDaysAgo / 1000, eightDaysAgo / 1000);

    const result = cachePrune.defaultScanTranscripts(home);
    assert.ok(result instanceof Set, 'scan must succeed');
    assert.ok(result.has('0.109.0'), 'must find the version in the recent transcript tail');
    assert.ok(!result.has('0.110.0'), 'must NOT count a transcript older than 7 days');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor --prune-cache prints the cron/Monitor versioned-path warning in BOTH list and --confirmed output', () => {
  const f = makeFixture(CLI_VERSIONS);
  try {
    const listed = runDoctorScanned(f.home, ['--prune-cache']);
    assert.match(listed.out, /Crons\/Monitors that name a versioned cache path/);
    assert.match(listed.out, /~\/\.anti-hall\/bin\/devswarm\.js/);
    assert.match(listed.out, /~\/\.anti-hall\/bin\/wake-watch\.js/);

    const confirmed = runDoctorScanned(f.home, ['--prune-cache', '--confirmed']);
    assert.match(confirmed.out, /Crons\/Monitors that name a versioned cache path/);
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
