'use strict';
// doctor-repair-daemonhealth-shared-definition.test.js — B2 fix (v0.66.0 lane B).
//
// PROVEN GAP THIS FILE LOCKS DOWN: hooks/lib/doctor-repair.js's own
// projectDaemonHealthy() used to be a LOCALLY-DUPLICATED, WEAKER
// reimplementation of companion/lib/ingest-health.js's daemonHealth() — the
// ONE shared definition ingest-health.js's own header comment says every
// consumer must agree on. The duplicate lacked:
//   (a) the SAME-INCARNATION pid guard — it read heartbeat freshness and lock
//       liveness as two INDEPENDENT signals, never checking that the pid the
//       heartbeat claims to be IS the pid holding the lock. A stale
//       heartbeat left behind by a DEAD daemon incarnation, sitting next to a
//       lock now held by a completely different (and unrelated) live
//       process, used to read as "healthy".
//   (b) the v0.66 monitor-outcome-fault check — a daemon that is alive,
//       heartbeating, and holding its lock, but whose every `hivecontrol
//       workspace monitor` spawn is failing (see monitorFaultFor), used to
//       read as "healthy" too, even though it is draining NOTHING.
//
// reapOrphanedLegacyUnits trusts a `true` from this function to justify
// REAPING a legacy per-worktree ingest unit as "redundant". A false-positive
// "healthy" verdict there authorizes stopping the SOLE REAL DRAINER for that
// repo, silently halting ingestion with no replacement actually running.
//
// The fix makes projectDaemonHealthy() a thin delegate to
// ingest-health.js's daemonHealth(), counting ONLY status==='healthy'.
//
// HERMETIC: fresh mkdtemp HOME per test, a real (but throwaway) local git
// repo so repoKeyForWorktree resolves, and never signals/kills a real
// process — only process.kill(pid, 0) liveness probes (used, indirectly, by
// the module under test) and NEVER a destructive signal from this test file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPAIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const INGEST = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-ingest.js');
const HEALTH = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'ingest-health.js');
const REPOKEY = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js');

const repair = require(REPAIR);
const ingest = require(INGEST);
const health = require(HEALTH);
const repokey = require(REPOKEY);

const PLATFORM = process.platform;
const SKIP_WIN32 = { skip: PLATFORM === 'win32' };

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-health-home-'));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-health-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

function requireRepoKey(worktree) {
  const key = repokey.repoKeyForWorktree(worktree);
  assert.ok(key, 'test setup: repoKeyForWorktree must resolve for a real git repo fixture');
  return key;
}

function writeHeartbeat(home, repoKey, fields) {
  const p = ingest.ingestHeartbeatPath(home, repoKey);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(fields));
}
function writeLock(home, worktree, fields) {
  const p = ingest.ingestLockPath(home, worktree);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(fields));
}

// ---------------------------------------------------------------------------
// 1. projectDaemonHealthy now agrees with ingest-health.js's daemonHealth on
//    every input — proven by fuzzing a handful of (heartbeat, lock) pairs and
//    asserting they always produce the SAME verdict.
// ---------------------------------------------------------------------------

test('projectDaemonHealthy(...) === (daemonHealth(...).status === "healthy") for a genuinely healthy daemon', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('agree-healthy');
  try {
    const repoKey = requireRepoKey(repo);
    const now = Date.now();
    writeHeartbeat(home, repoKey, { ts: now, pid: process.pid });
    writeLock(home, repo, { pid: process.pid, ts: now, token: 't' });

    const viaShared = health.daemonHealth(home, repoKey, { now }).status === 'healthy';
    const viaRepair = repair.projectDaemonHealthy(home, repoKey, now);
    assert.equal(viaRepair, true, 'a genuinely healthy daemon still reports healthy after delegating');
    assert.equal(viaRepair, viaShared, 'doctor-repair and ingest-health must agree — same underlying definition');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// 2. THE BUG (a): mismatched incarnation. A stale heartbeat naming a DEAD pid
//    sits alongside a lock held by a DIFFERENT, currently-alive pid (this
//    test process's own pid — genuinely alive, but it is NOT the process
//    that wrote the heartbeat). The old duplicated check never compared the
//    two pids and would report this healthy; the shared definition requires
//    them to match before either signal counts.
// ---------------------------------------------------------------------------

test('projectDaemonHealthy: heartbeat pid and lock-holder pid MISMATCH -> false (was previously the undetected gap)', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('mismatch-incarnation');
  try {
    const repoKey = requireRepoKey(repo);
    const now = Date.now();
    // Heartbeat claims pid 999999 (not this process, not alive) wrote it, but
    // freshness alone (the OLD code's only signal on this file) is fine.
    writeHeartbeat(home, repoKey, { ts: now, pid: 999999 });
    // The lock is held by THIS test process's own pid — genuinely alive, so
    // the OLD code's separate isAlive(lockPid) check alone would pass too.
    writeLock(home, repo, { pid: process.pid, ts: now, token: 't' });

    const result = health.daemonHealth(home, repoKey, { now });
    assert.equal(result.status, 'stale', 'the shared definition refuses to call this healthy — the incarnations do not match');

    const viaRepair = repair.projectDaemonHealthy(home, repoKey, now);
    assert.equal(viaRepair, false,
      'doctor-repair must inherit the same-incarnation guard from the shared definition, not silently combine two unrelated signals into "healthy"');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// 3. THE BUG (b): monitor-outcome fault. Fresh heartbeat, live lock, SAME
//    incarnation (both pids match this test process) — but the heartbeat
//    also records that every `hivecontrol workspace monitor` call has been
//    failing (v0.66 monitor-outcome fields) with no successful poll ever.
//    The old duplicated check never looked at these fields and would report
//    this "healthy"; the daemon is alive but draining NOTHING.
// ---------------------------------------------------------------------------

test('projectDaemonHealthy: alive + heartbeating + same incarnation, but monitor is FAILING -> false, not healthy', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('monitor-fault');
  try {
    const repoKey = requireRepoKey(repo);
    const now = Date.now();
    writeHeartbeat(home, repoKey, {
      ts: now, pid: process.pid,
      consecutiveMonitorFailures: 12, lastMonitorOkMs: null, lastMonitorErrorCode: 'ENOENT',
    });
    writeLock(home, repo, { pid: process.pid, ts: now, token: 't' });

    const result = health.daemonHealth(home, repoKey, { now });
    assert.equal(result.status, 'failed', 'the shared definition surfaces this as a monitor-outcome fault, not healthy');
    assert.ok(result.monitorFault, 'the fault detail is attached');

    const viaRepair = repair.projectDaemonHealthy(home, repoKey, now);
    assert.equal(viaRepair, false,
      'a daemon that is alive but ingesting NOTHING must never be reported healthy by doctor-repair');
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// 4. FIELD CONSEQUENCE: reapOrphanedLegacyUnits must NOT reap a legacy unit
//    as "redundant" when the replacement per-project daemon is alive but
//    monitor-faulting — that would silently stop the sole real drainer.
// ---------------------------------------------------------------------------

function writeLegacyUnit(home, platform, workdir, script) {
  const installer = require(path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js'));
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const label = installer.labelForWorktree(workdir);
    fs.writeFileSync(path.join(dir, label + '.plist'),
      installer.buildPlist({ label, exec: '/usr/bin/node', script, log: '/tmp/x.log', workdir }));
  } else {
    const dir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const unit = installer.unitForWorktree(workdir);
    fs.writeFileSync(path.join(dir, unit + '.service'),
      installer.buildService({ exec: '/usr/bin/node', script, workdir }));
  }
  return installer.worktreeHash(workdir);
}

test('reapOrphanedLegacyUnits: a monitor-faulting "healthy-looking" replacement daemon does NOT authorize reaping the legacy unit (sole-drainer protection)', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('reap-monitor-fault');
  try {
    const hash = writeLegacyUnit(home, PLATFORM, repo, '/tmp/legacy.js');
    const repoKey = requireRepoKey(repo);
    const now = Date.now();
    // The replacement per-project daemon is alive, fresh, same-incarnation —
    // everything the OLD projectDaemonHealthy checked would have said
    // "healthy" — but it is draining nothing (monitor permanently failing).
    writeHeartbeat(home, repoKey, {
      ts: now, pid: process.pid,
      consecutiveMonitorFailures: 20, lastMonitorOkMs: null, lastMonitorErrorCode: 'ENOENT',
    });
    writeLock(home, repo, { pid: process.pid, ts: now, token: 't' });

    const calls = [];
    const io = {
      schedRun: (spec) => { calls.push(spec); return { status: 0, stdout: '', error: null }; },
      schedFs: () => {},
    };
    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, now, io });

    assert.equal(results.length, 1);
    assert.equal(results[0].hash, hash);
    assert.equal(results[0].status, 'kept',
      'a legacy unit must be KEPT (not reaped) when the replacement daemon is alive-but-ingesting-nothing — '
      + 'reaping it here would silently stop the only real drainer for this repo');
    assert.equal(calls.length, 0, 'no scheduler call is made when the unit is correctly kept');
  } finally { rm(home); rm(repo); }
});
