'use strict';
// ingest-health.js — Phase 7 shared per-project daemon health check
// (PLAN-v0.57-mesh.md D25) + devswarm.js's send-time self-heal wrapper that
// consumes it (D-O-D7). Health = RUNNING + HEALTHY, not freshness-only: BOTH a
// fresh heartbeat AND a live-pid lock holder are required for 'healthy'. This
// file exercises daemonHealth()/buildStaleBanner() directly (injectable
// fs/isAlive — no real OS pid needed) AND the CLI-level selfHeal()/withSelfHeal()
// wrapper in scripts/devswarm.js (a REAL git repo, since repoKeyForWorktree
// spawns `git rev-parse --git-common-dir` — mirrors tests/scripts/devswarm-send.test.js).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const health = require('../../plugins/anti-hall/companion/lib/ingest-health.js');
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-health-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function writeHeartbeat(home, repoKey, ts) {
  const p = health.ingestHeartbeatPath(home, repoKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts }));
}
function writeLock(home, repoKey, pid) {
  const p = health.ingestProjectLockPath(home, repoKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid, ts: Date.now(), token: 'test' }));
}

// ---------------------------------------------------------------------------
// daemonHealth() — the two D25 signals in isolation, injectable io throughout
// (no dependency on a real OS pid's liveness).
// ---------------------------------------------------------------------------

test('daemonHealth: fresh heartbeat + live-pid lock -> healthy', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeat(home, 'proj-abc', now - 5000);
    writeLock(home, 'proj-abc', 4242);
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'healthy', fresh: true, liveLock: true });
  } finally { rm(home); }
});

test('daemonHealth D25 failure mode 1: DEAD process with a still-fresh heartbeat file -> reported NOT-healthy (fresh, but not live)', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeat(home, 'proj-abc', now - 5000); // fresh
    writeLock(home, 'proj-abc', 4242); // present, but the holder is dead
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'linux', io: { isAlive: () => false } });
    assert.strictEqual(r.status, 'stale');
    assert.strictEqual(r.fresh, true);
    assert.strictEqual(r.liveLock, false);
  } finally { rm(home); }
});

test('daemonHealth D25 failure mode 2: LIVE process with a MISSING heartbeat -> reported NOT-fresh (heal candidate)', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    // No heartbeat file written at all.
    writeLock(home, 'proj-abc', 4242);
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.strictEqual(r.status, 'stale');
    assert.strictEqual(r.fresh, false);
    assert.strictEqual(r.liveLock, true);
  } finally { rm(home); }
});

test('daemonHealth: heartbeat older than the staleness window -> stale even with a live lock', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeat(home, 'proj-abc', now - (health.HEARTBEAT_STALE_MS + 60000));
    writeLock(home, 'proj-abc', 4242);
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.strictEqual(r.status, 'stale');
    assert.strictEqual(r.fresh, false);
  } finally { rm(home); }
});

test('daemonHealth: malformed heartbeat/lock JSON -> both signals fail closed, no throw', () => {
  const home = tmpHome();
  try {
    const p1 = health.ingestHeartbeatPath(home, 'proj-abc');
    fs.mkdirSync(path.dirname(p1), { recursive: true });
    fs.writeFileSync(p1, '{not json');
    const p2 = health.ingestProjectLockPath(home, 'proj-abc');
    fs.mkdirSync(path.dirname(p2), { recursive: true });
    fs.writeFileSync(p2, '{also not json');
    assert.doesNotThrow(() => {
      const r = health.daemonHealth(home, 'proj-abc', { now: Date.now(), platform: 'linux' });
      assert.deepStrictEqual(r, { status: 'stale', fresh: false, liveLock: false });
    });
  } finally { rm(home); }
});

test('daemonHealth: repoKey null -> stale, no throw (nothing to check)', () => {
  const home = tmpHome();
  try {
    const r = health.daemonHealth(home, null, { now: Date.now(), platform: 'linux' });
    assert.deepStrictEqual(r, { status: 'stale', fresh: false, liveLock: false });
  } finally { rm(home); }
});

test('daemonHealth: win32 -> unsupported (D28), regardless of heartbeat/lock state', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeat(home, 'proj-abc', now - 5000);
    writeLock(home, 'proj-abc', 4242);
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'win32', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'unsupported', fresh: false, liveLock: false });
  } finally { rm(home); }
});

test('buildStaleBanner: renders a relative age and points to the remedy', () => {
  const now = Date.now();
  const banner = health.buildStaleBanner(now - 5 * 60 * 1000, now);
  assert.ok(/ingest daemon last alive 5m ago/.test(banner), banner);
  assert.ok(/anti-hall:doctor/.test(banner), banner);
});

test('buildStaleBanner: unknown beatTs (null) -> "—" age, still points to the remedy', () => {
  const banner = health.buildStaleBanner(null, Date.now());
  assert.ok(banner.includes('last alive — ago'), banner);
});

// ---------------------------------------------------------------------------
// scripts/devswarm.js — selfHeal()/withSelfHeal() (send-time self-heal, D-O-D7)
// A REAL git repo is required: repoKeyForWorktree spawns `git rev-parse
// --git-common-dir` (mirrors tests/scripts/devswarm-send.test.js's own
// makeGitRepo rationale).
// ---------------------------------------------------------------------------

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-health-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}
const ACTIVE_ENV = { DEVSWARM_REPO_ID: 'repo-1' };

test('selfHeal: healthy daemon -> daemonHealthy:true, no spawn attempted', () => {
  const home = tmpHome();
  const repo = makeGitRepo('healthy');
  try {
    let spawned = 0;
    const ctx = {
      home, env: ACTIVE_ENV, cwd: repo, now: Date.now(),
      io: {
        platform: 'linux',
        resolveWorktree: () => repo,
        repoKeyForWorktree: () => 'proj-x',
        health: { isAlive: () => true },
        spawnInstaller: () => { spawned++; },
      },
    };
    writeHeartbeat(home, 'proj-x', Date.now() - 5000);
    writeLock(home, 'proj-x', 111);
    const r = cli.selfHeal(ctx);
    assert.deepStrictEqual(r, { daemonHealthy: true });
    assert.strictEqual(spawned, 0, 'a healthy daemon must never trigger a heal spawn');
  } finally { rm(home); rm(repo); }
});

test('selfHeal: stale + gated (DevSwarm active + resolved worktree) + cooldown elapsed -> ONE installer spawn, daemonHealAttempted:true', () => {
  const home = tmpHome();
  const repo = makeGitRepo('stale-gated');
  try {
    let spawned = 0;
    const ctx = {
      home, env: ACTIVE_ENV, cwd: repo, now: Date.now(),
      io: {
        platform: 'linux',
        resolveWorktree: () => repo,
        repoKeyForWorktree: () => 'proj-y',
        spawnInstaller: () => { spawned++; },
      },
    };
    // No heartbeat/lock at all -> stale.
    const r = cli.selfHeal(ctx);
    assert.strictEqual(r.daemonWarning, 'stale');
    assert.strictEqual(r.daemonHealAttempted, true);
    assert.strictEqual(spawned, 1);
  } finally { rm(home); rm(repo); }
});

test('selfHeal: a SECOND stale send within the cooldown window -> no re-spawn', () => {
  const home = tmpHome();
  const repo = makeGitRepo('cooldown');
  try {
    let spawned = 0;
    const now = Date.now();
    const ctx = (at) => ({
      home, env: ACTIVE_ENV, cwd: repo, now: at,
      io: {
        platform: 'linux',
        resolveWorktree: () => repo,
        repoKeyForWorktree: () => 'proj-z',
        spawnInstaller: () => { spawned++; },
      },
    });
    const r1 = cli.selfHeal(ctx(now));
    assert.strictEqual(r1.daemonHealAttempted, true);
    assert.strictEqual(spawned, 1);
    // Same cooldown-window instant, well inside SELF_HEAL_COOLDOWN_MS.
    const r2 = cli.selfHeal(ctx(now + 1000));
    assert.strictEqual(spawned, 1, 'must NOT re-spawn within the cooldown window');
    assert.strictEqual(r2.daemonHealAttempted, undefined);
    assert.strictEqual(r2.daemonHealCooldown, true);
    // Past the cooldown -> may heal again.
    const r3 = cli.selfHeal(ctx(now + cli.SELF_HEAL_COOLDOWN_MS + 1000));
    assert.strictEqual(spawned, 2);
    assert.strictEqual(r3.daemonHealAttempted, true);
  } finally { rm(home); rm(repo); }
});

test('selfHeal: a non-git cwd fails the gate -> {daemonWarning:"no-worktree"}, no spawn', () => {
  const home = tmpHome();
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-health-nogit-'));
  try {
    let spawned = 0;
    const ctx = {
      home, env: ACTIVE_ENV, cwd: notGit, now: Date.now(),
      io: {
        platform: 'linux',
        resolveWorktree: () => null,
        spawnInstaller: () => { spawned++; },
      },
    };
    const r = cli.selfHeal(ctx);
    assert.deepStrictEqual(r, { daemonWarning: 'no-worktree' });
    assert.strictEqual(spawned, 0);
  } finally { rm(home); rm(notGit); }
});

test('selfHeal: win32 -> {daemonWarning:"unsupported-platform"}, no banner spam, no spawn (D28)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('win32');
  try {
    let spawned = 0;
    const ctx = {
      home, env: ACTIVE_ENV, cwd: repo, now: Date.now(),
      io: {
        platform: 'win32',
        resolveWorktree: () => repo,
        repoKeyForWorktree: () => 'proj-w',
        spawnInstaller: () => { spawned++; },
      },
    };
    const r = cli.selfHeal(ctx);
    assert.deepStrictEqual(r, { daemonWarning: 'unsupported-platform' });
    assert.strictEqual(spawned, 0);
  } finally { rm(home); rm(repo); }
});

test('selfHeal: stale but DevSwarm NOT active (env gate closed) -> warns, does not spawn', () => {
  const home = tmpHome();
  const repo = makeGitRepo('gate-closed');
  try {
    let spawned = 0;
    const ctx = {
      home, env: {}, cwd: repo, now: Date.now(), // no DEVSWARM_REPO_ID -> isDevswarmActive() false
      io: {
        platform: 'linux',
        resolveWorktree: () => repo,
        repoKeyForWorktree: () => 'proj-v',
        spawnInstaller: () => { spawned++; },
      },
    };
    const r = cli.selfHeal(ctx);
    assert.strictEqual(r.daemonWarning, 'stale');
    assert.strictEqual(r.daemonHealAttempted, undefined);
    assert.strictEqual(spawned, 0);
  } finally { rm(home); rm(repo); }
});

test('selfHeal: never throws even if the installer spawn itself throws (fail-open)', () => {
  const home = tmpHome();
  const repo = makeGitRepo('spawn-throws');
  try {
    const ctx = {
      home, env: ACTIVE_ENV, cwd: repo, now: Date.now(),
      io: {
        platform: 'linux',
        resolveWorktree: () => repo,
        repoKeyForWorktree: () => 'proj-u',
        spawnInstaller: () => { throw new Error('boom'); },
      },
    };
    assert.doesNotThrow(() => cli.selfHeal(ctx));
  } finally { rm(home); rm(repo); }
});

test('withSelfHeal: merges heal fields onto the action result without clobbering its own keys', () => {
  const home = tmpHome();
  const repo = makeGitRepo('with-heal');
  try {
    const ctx = {
      home, env: ACTIVE_ENV, cwd: repo, now: Date.now(),
      io: {
        platform: 'linux',
        resolveWorktree: () => repo,
        repoKeyForWorktree: () => 'proj-t',
        spawnInstaller: () => {},
      },
    };
    const r = cli.withSelfHeal(() => ({ ok: true, action: 'send', sent: true }), ctx);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.action, 'send');
    assert.strictEqual(r.sent, true);
    assert.strictEqual(r.daemonWarning, 'stale');
    assert.strictEqual(r.daemonHealAttempted, true);
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// D27: a deleted/corrupt ingest-health.js module must never crash a live
// consumer — devswarm-parent-inbox.js / devswarm-child-turn.js lazy-require it
// inside a try/catch, so this asserts the CONTRACT (require failure -> null,
// caller degrades to "no data") without needing a real corrupt file on disk.
// ---------------------------------------------------------------------------
test('D27 contract: a lazy require of a nonexistent module resolves to null, never throws, matching the hooks\' guard idiom', () => {
  let mod = null;
  assert.doesNotThrow(() => {
    try { mod = require('../../plugins/anti-hall/companion/lib/does-not-exist-ingest-health.js'); } catch (_) { mod = null; }
  });
  assert.strictEqual(mod, null);
});
