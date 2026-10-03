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
const pull = require('../../plugins/anti-hall/companion/lib/devswarm-pull.js');

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
    // A prior fetch already happened. `primary` was JUST cloned, so
    // origin/main hasn't moved since — a real `git fetch` here is a genuine
    // no-op that (correctly) writes neither a reflog entry nor a loose ref
    // file, since origin/main stays packed from the clone (verified: a fresh
    // clone's tracking refs live in packed-refs, not a loose file). Simulate
    // the "freshly fetched" evidence the same way a real MOVING fetch would
    // leave it: a loose `refs/remotes/origin/main` file with a just-now
    // mtime — exactly the signal remoteRefAgeSec reads.
    git(f.primary, ['fetch', 'origin', 'main']);
    const common = cli.gitCommonDirFor(f.primary);
    const sha = git(f.primary, ['rev-parse', 'refs/remotes/origin/main']);
    fs.mkdirSync(path.join(common, 'refs', 'remotes', 'origin'), { recursive: true });
    fs.writeFileSync(path.join(common, 'refs', 'remotes', 'origin', 'main'), sha + '\n');
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

test('remoteRefAgeSec / spawnSourceFreshness: FETCH_HEAD is fresh but origin/<def> itself is old -> treated as stale, fetch happens (fixed defect: FETCH_HEAD moves on ANY fetch, not just this ref)', () => {
  const f = fixture();
  try {
    // A prior fetch of `main` established origin/main locally (packed from
    // the clone, same no-op-fetch situation as the TTL-fresh test above).
    // Manufacture the loose-ref evidence a real fetch-that-moved-the-ref
    // would leave, aged 10s (see that test's comment for why this is needed
    // instead of relying on git's own reflog/loose-ref writes here).
    git(f.primary, ['fetch', 'origin', 'main']);
    const common = cli.gitCommonDirFor(f.primary);
    const sha = git(f.primary, ['rev-parse', 'refs/remotes/origin/main']);
    fs.mkdirSync(path.join(common, 'refs', 'remotes', 'origin'), { recursive: true });
    fs.writeFileSync(path.join(common, 'refs', 'remotes', 'origin', 'main'), sha + '\n');
    const old = new Date(Date.now() - 10000);
    for (const p of [path.join(common, 'logs', 'refs', 'remotes', 'origin', 'main'), path.join(common, 'refs', 'remotes', 'origin', 'main')]) {
      try { fs.utimesSync(p, old, old); } catch (_) {}
    }
    // A SEPARATE fetch (an unrelated ref/branch) touches FETCH_HEAD's mtime
    // just now, without touching origin/main at all.
    fs.writeFileSync(path.join(common, 'FETCH_HEAD'), '0000000000000000000000000000000000000000\t\tbranch \'unrelated\' of somewhere\n');
    // FETCH_HEAD is "just now" — if it were consulted, age would read ~0s and
    // the TTL would wrongly report the ref as fresh.
    const fetchHeadAgeIfUsed = Math.floor((Date.now() - fs.statSync(path.join(common, 'FETCH_HEAD')).mtimeMs) / 1000);
    assert.ok(fetchHeadAgeIfUsed < 2, 'FETCH_HEAD must look fresh for this test to be meaningful');

    const age = cli.remoteRefAgeSec(f.primary, 'origin/main', Date.now());
    assert.ok(age !== null && age >= 9, 'remoteRefAgeSec must report the REF\'s own age, not FETCH_HEAD\'s; got ' + age);

    const r = cli.spawnSourceFreshness(['child'], { home: f.home, env: { ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC: '5' }, cwd: f.primary });
    assert.strictEqual(r.fetch, 'ran', 'a stale origin/main ref must trigger a fetch even though FETCH_HEAD is fresh; got ' + JSON.stringify(r));
  } finally { rm(f); }
});

// A behavioral shim for `git` on PATH that records every argv it was called
// with (as a plain text log) and then execs the real git, so
// spawnSourceFreshness still does real, verifiable work — a source-regex
// test (the prior version of this test) is not evidence of the actual
// runtime call. `spawnSourceFreshness`'s internal `git()` helper does not
// forward `ctx.env` to the child process (it inherits ambient `process.env`),
// so the shim is installed via `process.env.PATH` itself, restored in
// `finally`.
function withGitArgLogger(fn) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gitshim-'));
  const logFile = path.join(shimDir, 'calls.log');
  const realGit = cp.spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
  const shimPath = path.join(shimDir, 'git');
  fs.writeFileSync(shimPath, '#!/bin/sh\n'
    + 'printf \'%s\\n\' "$*" >> ' + JSON.stringify(logFile) + '\n'
    + 'exec ' + JSON.stringify(realGit) + ' "$@"\n');
  fs.chmodSync(shimPath, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + origPath;
  try {
    return fn({ calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []) });
  } finally {
    process.env.PATH = origPath;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch (_) {}
  }
}

test('spawnSourceFreshness: an actual fetch passes --recurse-submodules=on-demand (behavioral: captured argv)', () => {
  const f = fixture();
  try {
    withGitArgLogger(({ calls }) => {
      const r = cli.spawnSourceFreshness(['child'], { home: f.home, env: { ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC: '0' }, cwd: f.primary });
      void r;
      const fetchCalls = calls().filter((line) => /\bfetch\b/.test(line));
      assert.ok(fetchCalls.length >= 1, 'expected at least one git fetch call; saw: ' + JSON.stringify(calls()));
      assert.ok(fetchCalls.some((line) => line.includes('--recurse-submodules=on-demand')),
        'the fetch call must pass --recurse-submodules=on-demand; saw: ' + JSON.stringify(fetchCalls));
    });
  } finally { rm(f); }
});

// A `git` shim whose `fetch --recurse-submodules=on-demand` call fails (a
// broken/unreachable submodule remote), but which otherwise delegates to the
// real git — including a plain `fetch --no-recurse-submodules` retry, which
// must succeed. Logs argv the same way withGitArgLogger does.
function withFailingSubmoduleFetchGit(fn) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gitshim-submodule-'));
  const logFile = path.join(shimDir, 'calls.log');
  const realGit = cp.spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/git';
  const shimPath = path.join(shimDir, 'git');
  fs.writeFileSync(shimPath, '#!/bin/sh\n'
    + 'printf \'%s\\n\' "$*" >> ' + JSON.stringify(logFile) + '\n'
    + 'case "$*" in\n'
    + '  *"fetch"*"--recurse-submodules=on-demand"*) echo "fatal: unable to access submodule remote" >&2; exit 1 ;;\n'
    + '  *) exec ' + JSON.stringify(realGit) + ' "$@" ;;\n'
    + 'esac\n');
  fs.chmodSync(shimPath, 0o755);
  const origPath = process.env.PATH;
  process.env.PATH = shimDir + path.delimiter + origPath;
  try {
    return fn({ calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n') : []) });
  } finally {
    process.env.PATH = origPath;
    try { fs.rmSync(shimDir, { recursive: true, force: true }); } catch (_) {}
  }
}

test('spawnSourceFreshness: submodule fetch fails -> retries once with --no-recurse-submodules, reports submoduleFetch:"failed", does not fail the whole spawn', () => {
  const f = fixture();
  try {
    withFailingSubmoduleFetchGit(({ calls }) => {
      const r = cli.spawnSourceFreshness(['child'], { home: f.home, env: { ANTIHALL_DEVSWARM_SPAWN_FETCH_TTL_SEC: '0' }, cwd: f.primary });
      assert.strictEqual(r.status, 'up-to-date', JSON.stringify(r));
      assert.strictEqual(r.submoduleFetch, 'failed', JSON.stringify(r));
      const fetchCalls = calls().filter((line) => /\bfetch\b/.test(line));
      assert.ok(fetchCalls.some((l) => l.includes('--recurse-submodules=on-demand')), JSON.stringify(fetchCalls));
      assert.ok(fetchCalls.some((l) => l.includes('--no-recurse-submodules')), 'must retry with --no-recurse-submodules: ' + JSON.stringify(fetchCalls));
    });
  } finally { rm(f); }
});

function fakeHiveCreate(f, { stderr, timeout } = {}) {
  return ({ args, cwd, timeout: t }) => {
    if (args[0] === 'workspace' && args[1] === 'create') {
      if (timeout) {
        // Simulate a hang using the REAL spawnSync-timeout shape (r.error with
        // code ETIMEDOUT, alongside r.signal/r.status) by routing through
        // pull.defaultRun itself — the shape a wedged real `hivecontrol`
        // process actually produces, not a hand-typed approximation.
        return pull.defaultRun({ hivecontrol: process.execPath, args: ['-e', 'setTimeout(()=>{}, 999999)'], timeout: t || 50 });
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

test('cmdSpawn: create timeout is reported clearly, with the exact plain-language message, and never flips into a silent hang', () => {
  const f = fixture();
  try {
    // spawnCreateTimeoutMs has a `min: 1000` floor (settings-schema.js) — use
    // the floor itself so the fake create's own kill timeout (also 1000ms)
    // and the message's reported figure agree.
    const r = cli.run(['spawn', 'child-timeout'], {
      home: f.home, backend: 'journal', env: { ANTIHALL_DEVSWARM_SPAWN_CREATE_TIMEOUT_MS: '1000' },
      cwd: f.primary, io: { run: fakeHiveCreate(f, { timeout: true }) },
    }).result;
    assert.strictEqual(r.ok, false);
    // Exact message, not a loose /timed out|signal/ — proves both the
    // ETIMEDOUT detection AND the partial-workspace-may-exist disclosure
    // (never auto-cleaned) fire together.
    assert.strictEqual(
      r.error,
      'workspace create timed out after 1000ms (only the create subprocess was killed, nothing else).'
        + ' A partial workspace for branch "child-timeout" may already exist — check with `git worktree list`'
        + ' in this repo or `devswarm list`; nothing was deleted automatically.',
      r.error,
    );
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

test('parseSubmoduleWorktreeFailures: a generic unrelated fatal: line (no "worktree", no submodule path) is NOT counted (fixed defect: the old regex was too broad)', () => {
  const out = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr: 'fatal: no upstream configured for branch \'main\'\n' });
  assert.deepStrictEqual(out, []);
});

test('parseSubmoduleWorktreeFailures: an "already exists" fatal: line whose path is NOT a known submodule and the text has no "worktree" mention -> NOT counted', () => {
  const out = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr: "fatal: '/tmp/unrelated-dir' already exists\n" });
  assert.deepStrictEqual(out, []);
});

test('parseSubmoduleWorktreeFailures: an "already exists" fatal: line whose path IS a known submodule (per .gitmodules) counts even with no "worktree" mention nearby', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-gitmodules-'));
  try {
    fs.writeFileSync(path.join(root, '.gitmodules'), '[submodule "skyflutter"]\n\tpath = skyflutter\n\turl = https://example.invalid/skyflutter.git\n');
    const out = cli.parseSubmoduleWorktreeFailures({ raw: '', stderr: "fatal: 'skyflutter' already exists\n" }, root);
    assert.strictEqual(out.length, 1, JSON.stringify(out));
    assert.strictEqual(out[0].path, 'skyflutter');
    assert.strictEqual(out[0].error, 'already exists');
  } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
});
