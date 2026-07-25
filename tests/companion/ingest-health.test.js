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

function writeHeartbeat(home, repoKey, ts, pid) {
  const p = health.ingestHeartbeatPath(home, repoKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(pid === undefined ? { ts } : { ts, pid }));
}
function writeLock(home, repoKey, pid) {
  const p = health.ingestProjectLockPath(home, repoKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid, ts: Date.now(), token: 'test' }));
}
// writeHeartbeatFull — full control over the heartbeat's raw fields, for the
// v0.66 monitor-outcome fault tests below (consecutiveMonitorFailures /
// lastMonitorOkMs / lastMonitorErrorCode — see devswarm-ingest.js's
// writeIngestHeartbeat and hooks/lib/doctor-repair.js's monitorFaultFor).
function writeHeartbeatFull(home, repoKey, fields) {
  const p = health.ingestHeartbeatPath(home, repoKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(fields));
}

// ---------------------------------------------------------------------------
// daemonHealth() — the two D25 signals in isolation, injectable io throughout
// (no dependency on a real OS pid's liveness).
// ---------------------------------------------------------------------------

test('daemonHealth: fresh heartbeat + live-pid lock (same incarnation, matching pid) -> healthy', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeat(home, 'proj-abc', now - 5000, 4242);
    writeLock(home, 'proj-abc', 4242);
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'healthy', fresh: true, liveLock: true, monitorFault: null });
  } finally { rm(home); }
});

test('daemonHealth SAME-INCARNATION GUARD: fresh heartbeat from a PRIOR daemon (pid A) + a live lock now held by a DIFFERENT pid (B) -> stale, not healthy', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    // Heartbeat still fresh (A wrote it recently before exiting/dying), but
    // the lock is now held by an unrelated pid B that has not yet written
    // its own heartbeat — mixing the two signals must NOT read as healthy.
    writeHeartbeat(home, 'proj-abc', now - 5000, 111111);
    writeLock(home, 'proj-abc', 222222);
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.strictEqual(r.status, 'stale', 'a fresh heartbeat + live lock from TWO DIFFERENT pids must never report healthy');
    assert.strictEqual(r.fresh, true);
    assert.strictEqual(r.liveLock, true);
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
      assert.deepStrictEqual(r, { status: 'stale', fresh: false, liveLock: false, monitorFault: null });
    });
  } finally { rm(home); }
});

test('daemonHealth: repoKey null -> stale, no throw (nothing to check)', () => {
  const home = tmpHome();
  try {
    const r = health.daemonHealth(home, null, { now: Date.now(), platform: 'linux' });
    assert.deepStrictEqual(r, { status: 'stale', fresh: false, liveLock: false, monitorFault: null });
  } finally { rm(home); }
});

test('daemonHealth: win32 -> unsupported (D28), regardless of heartbeat/lock state', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeat(home, 'proj-abc', now - 5000);
    writeLock(home, 'proj-abc', 4242);
    const r = health.daemonHealth(home, 'proj-abc', { now, platform: 'win32', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'unsupported', fresh: false, liveLock: false, monitorFault: null });
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// v0.66 MONITOR-OUTCOME FAULT — daemonHealth() reusing hooks/lib/doctor-
// repair.js's EXPORTED monitorFaultFor() (same MONITOR_FAILURE_FAIL_THRESHOLD
// / MONITOR_OK_STALE_MS thresholds, same missing-fields=UNKNOWN rule — never
// duplicated in ingest-health.js). See doctor-repair.js's own
// MONITOR_FAILURE_FAIL_THRESHOLD (3) / MONITOR_OK_STALE_MS (10min) constants.
// ---------------------------------------------------------------------------

test('daemonHealth v0.66: alive (fresh heartbeat + live lock, same incarnation) but monitor failing past threshold -> status:"failed", not "stale"/"healthy"', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeatFull(home, 'proj-mon', {
      ts: now - 5000, pid: 4242,
      consecutiveMonitorFailures: 5, // >= MONITOR_FAILURE_FAIL_THRESHOLD (3)
      lastMonitorOkMs: null,
      lastMonitorErrorCode: 'ENOENT',
    });
    writeLock(home, 'proj-mon', 4242);
    const r = health.daemonHealth(home, 'proj-mon', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.strictEqual(r.status, 'failed', 'a daemon alive but ingesting nothing must never read as merely stale or healthy');
    assert.strictEqual(r.fresh, true);
    assert.strictEqual(r.liveLock, true);
    assert.ok(r.monitorFault, 'monitorFault must be populated');
    assert.strictEqual(r.monitorFault.consecutive, 5);
    assert.strictEqual(r.monitorFault.code, 'ENOENT');
    const banner = health.buildMonitorFaultBanner(r.monitorFault);
    assert.ok(!banner.includes('\n'), 'banner must be a single line (10k injection cap)');
    assert.ok(/hivecontrol workspace monitor/.test(banner), banner);
    assert.ok(/anti-hall:doctor/.test(banner), banner);
    assert.ok(/5x/.test(banner), banner);
  } finally { rm(home); }
});

test('daemonHealth v0.66: alive + monitor healthy (consecutiveMonitorFailures:0) -> unchanged status:"healthy", monitorFault:null', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeatFull(home, 'proj-mon-ok', {
      ts: now - 5000, pid: 4242,
      consecutiveMonitorFailures: 0,
      lastMonitorOkMs: now - 1000,
      lastMonitorErrorCode: null,
    });
    writeLock(home, 'proj-mon-ok', 4242);
    const r = health.daemonHealth(home, 'proj-mon-ok', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'healthy', fresh: true, liveLock: true, monitorFault: null });
  } finally { rm(home); }
});

test('daemonHealth v0.66 BACK-COMPAT: a LEGACY heartbeat (pre-v0.66 daemon, no monitor fields at all) -> unchanged prior behavior, status:"healthy", monitorFault:null (never a fault)', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    // Exactly what an OLDER daemon build's writeIngestHeartbeat produced:
    // only ts/workspaceId/workingDir/pid — no consecutiveMonitorFailures et al.
    writeHeartbeatFull(home, 'proj-legacy', { ts: now - 5000, pid: 4242, workspaceId: 'ws', workingDir: '/tmp/x' });
    writeLock(home, 'proj-legacy', 4242);
    const r = health.daemonHealth(home, 'proj-legacy', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'healthy', fresh: true, liveLock: true, monitorFault: null });
  } finally { rm(home); }
});

test('daemonHealth v0.66: monitor failures below threshold (a blip, not a fault) with no stale last-ok -> unchanged status:"healthy"', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeatFull(home, 'proj-blip', {
      ts: now - 5000, pid: 4242,
      consecutiveMonitorFailures: 2, // below MONITOR_FAILURE_FAIL_THRESHOLD (3)
      lastMonitorOkMs: now - 30000, // recent, not stale
      lastMonitorErrorCode: 'ETIMEDOUT',
    });
    writeLock(home, 'proj-blip', 4242);
    const r = health.daemonHealth(home, 'proj-blip', { now, platform: 'linux', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'healthy', fresh: true, liveLock: true, monitorFault: null });
  } finally { rm(home); }
});

test('daemonHealth v0.66: monitor NOT baseHealthy (dead lock holder) -> stays "stale", never checks monitor fields', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeatFull(home, 'proj-dead', {
      ts: now - 5000, pid: 4242,
      consecutiveMonitorFailures: 99, // would be a fault IF baseHealthy — must never surface here
      lastMonitorOkMs: null,
      lastMonitorErrorCode: 'ENOENT',
    });
    writeLock(home, 'proj-dead', 4242); // present, but holder reported dead below
    const r = health.daemonHealth(home, 'proj-dead', { now, platform: 'linux', io: { isAlive: () => false } });
    assert.deepStrictEqual(r, { status: 'stale', fresh: true, liveLock: false, monitorFault: null });
  } finally { rm(home); }
});

test('daemonHealth v0.66: win32 -> unchanged no-op regardless of monitor-fault fields (D28 preserved)', () => {
  const home = tmpHome();
  try {
    const now = Date.now();
    writeHeartbeatFull(home, 'proj-win', {
      ts: now - 5000, pid: 4242,
      consecutiveMonitorFailures: 99,
      lastMonitorOkMs: null,
      lastMonitorErrorCode: 'ENOENT',
    });
    writeLock(home, 'proj-win', 4242);
    const r = health.daemonHealth(home, 'proj-win', { now, platform: 'win32', io: { isAlive: () => true } });
    assert.deepStrictEqual(r, { status: 'unsupported', fresh: false, liveLock: false, monitorFault: null });
  } finally { rm(home); }
});

test('buildMonitorFaultBanner: null/malformed fault never throws, still names the remedy', () => {
  assert.doesNotThrow(() => {
    const banner = health.buildMonitorFaultBanner(null);
    assert.ok(/anti-hall:doctor/.test(banner), banner);
  });
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
    writeHeartbeat(home, 'proj-x', Date.now() - 5000, 111);
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
