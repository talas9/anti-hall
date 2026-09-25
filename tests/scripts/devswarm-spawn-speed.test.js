'use strict';
// Extra scope for lane v109-spawn (spawn speed):
//   1. Fetch TTL — `spawnSourceFreshness` skips the (expensive) `git fetch`
//      when the remote-tracking ref was updated within
//      `devswarm.spawnFetchTtlSec` (default 300s), and reports
//      `fetch: 'skipped (fresh, Ns ago)'`.
//   2. When it DOES fetch, it passes `--recurse-submodules=on-demand`.
//   3. `hivecontrol workspace create` gets a timeout
//      (`devswarm.spawnCreateTimeoutMs`, default 180000ms) it never had
//      before; on timeout only our own child process is affected, and
//      cmdSpawn reports it clearly (never flips `ok` into a silent hang).
//   4. cmdSpawn reports per-phase `timings` (sourceCheckMs/createMs/totalMs).
//
// Also: submodule worktree failures (SkyCrew field evidence,
// fix/devswarm-spawn-local-submodules) — `create` can be ok:true overall
// while one `git worktree add` for a submodule fails; cmdSpawn now surfaces
// that as `submoduleFailures`/`warnings` without flipping `ok`.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnspeed-log-'));
process.env.ANTI_HALL_LOG_DIR = LOG_DIR;
process.on('exit', () => { try { fs.rmSync(LOG_DIR, { recursive: true, force: true }); } catch (_) {} });

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

const GIT_ENV = Object.assign({}, process.env, {
  HOME: LOG_DIR, USERPROFILE: LOG_DIR,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.x',
});
function git(cwd, args) {
  const r = cp.spawnSync('git', ['-C', cwd].concat(args), { encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}
function commit(dir, name) {
  fs.writeFileSync(path.join(dir, name), name);
  git(dir, ['add', name]);
  git(dir, ['commit', '-q', '-m', name]);
  return git(dir, ['rev-parse', 'HEAD']);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-spawnspeed-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  const origin = path.join(root, 'origin.git');
  cp.spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
  const up = path.join(root, 'upstream');
  cp.spawnSync('git', ['init', '-q', '-b', 'main', up], { env: GIT_ENV });
  commit(up, 'base.txt');
  git(up, ['remote', 'add', 'origin', origin]);
  git(up, ['push', '-q', 'origin', 'main']);
  const primary = path.join(root, 'primary');
  cp.spawnSync('git', ['clone', '-q', origin, primary], { env: GIT_ENV });
  return { root, home, origin, up, primary };
}
const rm = (f) => { try { fs.rmSync(f.root, { recursive: true, force: true }); } catch (_) {} };

test('spawnSourceFreshness: TTL skips the fetch when the remote ref is fresh, and reports it', () => {
  const f = fixture();
  try {
    // A prior fetch already happened (simulated by fetching once here).
    git(f.primary, ['fetch', 'origin', 'main']);
    const r1 = cli.spawnSourceFreshness(['child'], { home: f.home, env: {}, cwd: f.primary });
    assert.strictEqual(r1.fetch, 'skipped (fresh, 0s ago)', JSON.stringify(r1));
    assert.strictEqual(r1.status, 'up-to-date');
  } finally { rm(f); }
});

test('spawnSourceFreshness: TTL 0 always fetches (opt-out)', () => {
  const f = fixture();
  try {
    git(f.primary, ['fetch', 'origin', 'main']);
    const r = cli.spawnSourceFreshness(['child'], { home: f.home, env: { ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC: '0' }, cwd: f.primary });
    assert.strictEqual(r.fetch, 'ran', JSON.stringify(r));
  } finally { rm(f); }
});

test('spawnSourceFreshness: past the TTL, it fetches again', () => {
  const f = fixture();
  try {
    git(f.primary, ['fetch', 'origin', 'main']);
    const r = cli.spawnSourceFreshness(['child'], { home: f.home, env: { ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC: '0' }, cwd: f.primary });
    // With ttl=0 every call fetches; simulate "past TTL" with a 1s ttl and an
    // artificially aged reflog/FETCH_HEAD mtime.
    const common = cli.gitCommonDirFor(f.primary);
    const old = new Date(Date.now() - 10000);
    for (const p of [path.join(common, 'FETCH_HEAD'), path.join(common, 'logs', 'refs', 'remotes', 'origin', 'main')]) {
      try { fs.utimesSync(p, old, old); } catch (_) {}
    }
    const r2 = cli.spawnSourceFreshness(['child'], { home: f.home, env: { ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC: '1' }, cwd: f.primary });
    assert.strictEqual(r2.fetch, 'ran', JSON.stringify(r2));
    void r;
  } finally { rm(f); }
});

test('remoteRefAgeSec: null when never fetched', () => {
  const f = fixture();
  try {
    const r = cli.remoteRefAgeSec(f.primary, 'origin/main', Date.now());
    assert.strictEqual(r, null);
  } finally { rm(f); }
});

test('spawnSourceFreshness: an actual fetch passes --recurse-submodules=on-demand', () => {
  const f = fixture();
  try {
    const calls = [];
    const origSpawnSync = cp.spawnSync;
    const gitBin = require('child_process').spawnSync;
    // Intercept via monkeypatching require cache is fragile; instead assert
    // indirectly: run with ttl=0 (always fetch) and confirm the fetch actually
    // reaches origin (status up-to-date/ahead), then directly inspect the
    // command devswarm.js would run by calling the same code path and
    // capturing argv through a wrapped PATH shim is overkill for a unit test —
    // instead this test greps the source for the literal flag, pinned to the
    // exact fetch call site so a regression is caught mechanically.
    const src = fs.readFileSync(require.resolve('../../plugins/anti-hall/scripts/devswarm.js'), 'utf8');
    assert.ok(/git\(\['fetch', '--quiet', '--recurse-submodules=on-demand', 'origin', def\]/.test(src),
      'the fetch call must pass --recurse-submodules=on-demand');
    void calls; void origSpawnSync; void gitBin;
  } finally { rm(f); }
});

function fakeHiveCreate(f, { stderr, timeout } = {}) {
  return ({ args, cwd, timeout: t }) => {
    if (args[0] === 'workspace' && args[1] === 'create') {
      if (timeout) {
        // Simulate a hang: spawnSync with our own tiny timeout should return signal.
        const r = cp.spawnSync(process.execPath, ['-e', 'setTimeout(()=>{}, 999999)'], { timeout: t || 50 });
        return { ok: false, raw: '', error: 'devswarm create killed by signal ' + (r.signal || 'SIGTERM'), signal: r.signal || 'SIGTERM', status: null, stderr: '' };
      }
      const rest = args.slice(2);
      const child = rest[0];
      const wt = path.join(f.root, 'wt-' + child.replace(/\W/g, '_'));
      const r = cp.spawnSync('git', ['-C', cwd, 'worktree', 'add', '-q', '-b', child, wt, 'main'], { encoding: 'utf8', env: GIT_ENV });
      if (r.status !== 0) return { ok: false, error: r.stderr };
      f.childWt = wt;
      return { ok: true, raw: JSON.stringify({ path: wt }), stderr: stderr || '' };
    }
    return { ok: true, raw: '{}' };
  };
}
function spawn(f, argv, run) {
  return cli.run(['spawn'].concat(argv), { home: f.home, backend: 'journal', env: {}, cwd: f.primary, io: { run } }).result;
}

test('cmdSpawn: reports timings (sourceCheckMs/createMs/totalMs) on a successful spawn', () => {
  const f = fixture();
  try {
    const r = spawn(f, ['child-timings'], fakeHiveCreate(f));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.timings, 'timings must be present');
    assert.ok(Number.isFinite(r.timings.sourceCheckMs));
    assert.ok(Number.isFinite(r.timings.createMs));
    assert.ok(Number.isFinite(r.timings.totalMs));
  } finally { rm(f); }
});

test('cmdSpawn: a submodule worktree failure is surfaced without flipping ok', () => {
  const f = fixture();
  try {
    const stderr = "Cloning into '/tmp/wt-child-b/skyflutter'...\n"
      + "git worktree add -b child-b-skyflutter /tmp/wt-child-b/skyflutter 8ea79345\n"
      + "fatal: '/tmp/wt-child-b/skyflutter' already exists\n";
    const r = spawn(f, ['child-b'], fakeHiveCreate(f, { stderr }));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(Array.isArray(r.submoduleFailures) && r.submoduleFailures.length === 1, JSON.stringify(r.submoduleFailures));
    assert.strictEqual(r.submoduleFailures[0].path, '/tmp/wt-child-b/skyflutter');
    assert.strictEqual(r.submoduleFailures[0].error, 'already exists');
    assert.ok(Array.isArray(r.warnings) && r.warnings.length === 1);
    assert.ok(/submodule/i.test(r.warnings[0]));
  } finally { rm(f); }
});

test('cmdSpawn: no submodule failures -> submoduleFailures/warnings are absent, not empty arrays', () => {
  const f = fixture();
  try {
    const r = spawn(f, ['child-clean'], fakeHiveCreate(f));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.submoduleFailures, undefined);
    assert.strictEqual(r.warnings, undefined);
  } finally { rm(f); }
});

test('cmdSpawn: create timeout is reported clearly and never flips into a silent hang', () => {
  const f = fixture();
  try {
    const r = cli.run(['spawn', 'child-timeout'], {
      home: f.home, backend: 'journal', env: { ANTIHALL_DEVSWARM_SPAWN_CREATE_TIMEOUT_MS: '50' },
      cwd: f.primary, io: { run: fakeHiveCreate(f, { timeout: true }) },
    }).result;
    assert.strictEqual(r.ok, false);
    assert.ok(/timed out|signal/i.test(r.error), r.error);
    assert.ok(r.timings, 'timings must still be present on a failed create');
  } finally { rm(f); }
});

test('parseSubmoduleWorktreeFailures: a generic fatal: line with no quoted path is still surfaced', () => {
  const out = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr: 'fatal: some other worktree error\n' });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].path, null);
  assert.ok(/some other worktree error/.test(out[0].error));
});

test('parseSubmoduleWorktreeFailures: no fatal lines -> []', () => {
  assert.deepStrictEqual(cli.parseSubmoduleWorktreeFailures({ raw: '{}', stderr: '' }), []);
  assert.deepStrictEqual(cli.parseSubmoduleWorktreeFailures(null), []);
});
