'use strict';
// #39 (devswarm.wakeWatchIdleSkip, default true): companion/lib/devswarm-
// wake-watch.js main() — a Primary with 0 LIVE (non-archived) child
// workspaces prints one idle-skip line and exits 0 WITHOUT ever acquiring
// the per-id watch lock (nothing will ever message it, so arming costs a
// turn for zero coverage). A live child leaves arming unchanged. The cron
// fallback (hooks/lib/devswarm-wake.js) is untouched by this file entirely.

require('../helpers/isolate-home.js'); // HOME -> empty temp dir: this file reads home-dir state
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const MODULE_PATH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-wake-watch.js');
const { lockPathFor } = require(MODULE_PATH);

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-idle-skip-'));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-idle-skip-repo-' + tag + '-'));
  spawnSync('git', ['init', '-q', dir]);
  spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  spawnSync('git', ['-C', dir, 'add', '.']);
  spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function makeChildWorktree(repoDir, tag) {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-wakewatch-idle-skip-child-' + tag + '-'));
  fs.rmSync(wt, { recursive: true, force: true });
  const r = spawnSync('git', ['-C', repoDir, 'worktree', 'add', '-q', wt, '-b', 'child-' + tag]);
  assert.strictEqual(r.status, 0, 'git worktree add failed: ' + r.stderr);
  return wt;
}

// Registers a descriptor the same shape scripts/devswarm.js's `register`
// verb writes (companion/devswarm-supervisor.js readDescriptors requires
// worktreePath + sessionId + a safe id) — written directly rather than via
// the CLI so this file stays independent of scripts/devswarm.js.
function registerDescriptor(home, id, worktreeDir, sessionId) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ id, worktreePath: worktreeDir, sessionId: sessionId || 's-' + id }));
}

// Same "wait for the real output instead of racing a fixed wall-clock
// budget" helper devswarm-wake-watch.test.js uses for the arming path (a
// live child still spawns real git + starts polling before its first line
// prints).
function waitForStdoutMatch(args, spawnOpts, pattern, hardCapMs) {
  hardCapMs = hardCapMs || 8000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, spawnOpts);
    if (child.stdout) child.stdout.setEncoding('utf8');
    if (child.stderr) child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let settled = false;
    let hardTimer = null;
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      try { child.kill('SIGTERM'); } catch (_) {}
      resolve({ stdout, stderr });
    }
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; if (pattern.test(stdout)) finish(); });
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', () => finish());
    child.on('exit', () => finish());
    hardTimer = setTimeout(finish, hardCapMs);
  });
}

test('#39: Primary with 0 live children -> exactly the idle-skip line, exit 0, watch lock NEVER created', () => {
  const home = tmpHome();
  const repo = makeGitRepo('zero');
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1', // opens isDevswarmActiveGate; no DEVSWARM_SOURCE_BRANCH -> resolves role 'primary'
    };
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, cwd: repo, encoding: 'utf8', timeout: 8000 });
    assert.strictEqual(res.status, 0, 'stdout=' + res.stdout + ' stderr=' + res.stderr);
    // No tick marker at all -> the truthful "cannot verify a cron" wording, never "cron fallback covers".
    assert.strictEqual(res.stdout, '[wake-watch] idle-skip: no live child workspaces — not arming. No recent mailbox tick was seen: '
      + 'check CronList and re-create the 7,37 tick; arm this watcher again after you spawn a workspace.\n');
    // The idle-skip decision must fire BEFORE any lock acquisition attempt.
    assert.strictEqual(fs.existsSync(path.dirname(lockPathFor(home, 'anything'))), false,
      'idle-skip must never create the locks directory');
  } finally { rm(home); rm(repo); }
});

// The tick marker for a Primary is written only by the cron's `inbox tick`, so
// its age is the cron's liveness. Fresh -> report the age; stale/absent -> do
// not claim a cron. Always exactly ONE stdout line (each line wakes the session).
function idleSkipFor(markerAgeMin) {
  const home = tmpHome();
  const repo = makeGitRepo('marker');
  try {
    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DEVSWARM_REPO_ID: 'r1' };
    const id = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js').primaryWorkspaceId(
      require('../../plugins/anti-hall/companion/lib/identity.js').resolveContext(repo, { home, missingPath: 'ancestor' }).worktreeRoot);
    if (markerAgeMin !== null) {
      const dir = path.join(home, '.anti-hall', 'devswarm', 'wake-tick');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ ts: Date.now() - markerAgeMin * 60000 }));
    }
    const res = spawnSync(process.execPath, [MODULE_PATH], { env, cwd: repo, encoding: 'utf8', timeout: 8000 });
    assert.strictEqual(res.status, 0, 'stdout=' + res.stdout + ' stderr=' + res.stderr);
    return res.stdout;
  } finally { rm(home); rm(repo); }
}

test('idle-skip with a FRESH tick marker names the tick age and does not tell the agent to re-create the cron', () => {
  const out = idleSkipFor(7);
  assert.strictEqual(out, '[wake-watch] idle-skip: no live child workspaces — not arming; the mailbox tick last ran 7m ago\n');
  assert.strictEqual(out.trim().split('\n').length, 1);
});

test('idle-skip with a STALE tick marker (older than devswarm.cronMissingWarnMin) does not claim a cron', () => {
  const out = idleSkipFor(120);
  assert.ok(out.includes('No recent mailbox tick was seen: check CronList and re-create the 7,37 tick'), out);
  assert.ok(!out.includes('cron fallback covers') && !/last ran/.test(out), out);
  assert.strictEqual(out.trim().split('\n').length, 1);
});

test('#39: devswarm.wakeWatchIdleSkip=false -> a Primary with 0 live children still arms normally', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('setting-off');
  try {
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
      ANTIHALL_DEVSWARM_WAKE_WATCH_IDLE_SKIP: 'false',
    };
    const res = await waitForStdoutMatch([MODULE_PATH], { env, cwd: repo }, /\[wake-watch\] armed: watching primary/);
    assert.match(res.stdout, /\[wake-watch\] armed: watching primary/,
      'expected an arm line; got stdout=' + JSON.stringify(res.stdout) + ' stderr=' + JSON.stringify(res.stderr));
    assert.ok(!/idle-skip/.test(res.stdout), 'idle-skip line must not appear when the setting is off');
  } finally { rm(home); rm(repo); }
});

test('#39: Primary with 1 LIVE child -> arms normally (no idle-skip line)', async () => {
  const home = tmpHome();
  const repo = makeGitRepo('one-live');
  const child = makeChildWorktree(repo, 'one-live');
  try {
    registerDescriptor(home, 'child1', child);
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_REPO_ID: 'r1',
    };
    const res = await waitForStdoutMatch([MODULE_PATH], { env, cwd: repo }, /\[wake-watch\] armed: watching primary/);
    assert.match(res.stdout, /\[wake-watch\] armed: watching primary/,
      'expected an arm line; got stdout=' + JSON.stringify(res.stdout) + ' stderr=' + JSON.stringify(res.stderr));
    assert.ok(!/idle-skip/.test(res.stdout), 'idle-skip line must not appear with a live child registered');
  } finally { rm(home); rm(repo); }
});

// A held (devswarm.heldPartitions) or archive-ignored child is exempt from the
// parent gate (`archived || held || ignored`), so it is not a live child here
// either: a Primary whose only children are held/ignored must idle-skip.
for (const kind of ['held', 'ignored']) {
  test('a Primary whose only child is ' + kind + ' idle-skips (not armed)', () => {
    const home = tmpHome();
    const repo = makeGitRepo('only-' + kind);
    const child = makeChildWorktree(repo, 'only-' + kind);
    try {
      registerDescriptor(home, 'child1', child);
      const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DEVSWARM_REPO_ID: 'r1' };
      if (kind === 'held') env.ANTIHALL_DEVSWARM_HELD_PARTITIONS = 'child1';
      else {
        const dir = path.join(home, '.anti-hall', 'devswarm', 'archive-ignore');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'child1.json'), '{}');
      }
      const res = spawnSync(process.execPath, [MODULE_PATH], { env, cwd: repo, encoding: 'utf8', timeout: 8000 });
      assert.strictEqual(res.status, 0, 'stdout=' + res.stdout + ' stderr=' + res.stderr);
      assert.match(res.stdout, /\[wake-watch\] idle-skip: no live child workspaces/);
    } finally { rm(home); rm(repo); rm(child); }
  });
}

test('#39: a CHILD watcher (role child) never idle-skips even with no siblings registered', async () => {
  const home = tmpHome();
  try {
    const id = 'child-role-check';
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEVSWARM_SOURCE_BRANCH: 'main',
      DEVSWARM_BUILDER_ID: id,
    };
    const res = await waitForStdoutMatch([MODULE_PATH], { env }, new RegExp('\\[wake-watch\\] armed: watching child ' + id));
    assert.match(res.stdout, new RegExp('\\[wake-watch\\] armed: watching child ' + id),
      'expected an arm line; got stdout=' + JSON.stringify(res.stdout) + ' stderr=' + JSON.stringify(res.stderr));
    assert.ok(!/idle-skip/.test(res.stdout), 'a child watcher must never idle-skip');
  } finally { rm(home); }
});
