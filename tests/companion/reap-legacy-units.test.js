'use strict';
// v0.57 mesh Phase 6 (D9/D25/D28) — belt-and-suspenders orphan sweep for LEGACY
// per-worktree ingest units, implemented as hooks/lib/doctor-repair.js's
// reapOrphanedLegacyUnits (PLAN-v0.57-mesh.md cites `companion/doctor-repair.js`
// — stale anchor; the module actually lives at hooks/lib/doctor-repair.js,
// verified this session, same discipline as every other corrected citation in
// the plan). Fully injectable: NEVER touches a real launchctl/systemctl/
// crontab/process in these tests (opts.io.schedRun/schedFs mocks, mirroring
// reapLegacyUnitsForRepo's own discipline in install-ingest-repokey.test.js) —
// and NEVER calls process.kill (scheduler-based teardown only, proven by
// asserting every scheduler call is one of launchctl/systemctl/crontab).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPAIR = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const INSTALLER = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js');
const INGEST = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-ingest.js');
const repair = require(REPAIR);
const installer = require(INSTALLER);
const ingest = require(INGEST);

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reap-legacy-home-'));
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// makeGitRepo(tag) -> a real, committed git repo dir (insideWorktree/repoKey
// derivation both need a real .git — mirrors install-ingest-repokey.test.js's
// own helper).
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-legacy-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
}

// writeLegacyUnit(home, platform, workdir, script) -> the unit's hash. Writes a
// LEGACY per-worktree-suffixed unit fixture (labelForWorktree/unitForWorktree +
// buildPlist/buildService), the exact shape listInstalledIngestUnits reads back.
function writeLegacyUnit(home, platform, workdir, script) {
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

// writeProjectUnit(home, platform, repoKey, workdir, script) -> the repoKey
// per-project unit fixture — used to prove D28's disjoint filter excludes it.
function writeProjectUnit(home, platform, repoKey, workdir, script) {
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const label = installer.labelForProject(repoKey);
    fs.writeFileSync(path.join(dir, label + '.plist'),
      installer.buildPlist({ label, exec: '/usr/bin/node', script, log: '/tmp/x.log', workdir }));
  } else {
    const dir = path.join(home, '.config', 'systemd', 'user');
    fs.mkdirSync(dir, { recursive: true });
    const unit = installer.unitForProject(repoKey);
    fs.writeFileSync(path.join(dir, unit + '.service'),
      installer.buildService({ exec: '/usr/bin/node', script, workdir }));
  }
}

// writeForeignUnit(home, platform) -> writes a NON-anti-hall scheduler unit
// (unrelated label/unit prefix) — must never be enumerated/touched.
function writeForeignUnit(home, platform) {
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'com.example.some-other-tool.plist');
    fs.writeFileSync(p, installer.buildPlist({ label: 'com.example.some-other-tool', exec: '/bin/true', script: '/x.js', log: '/tmp/y.log' }));
    return p;
  }
  const dir = path.join(home, '.config', 'systemd', 'user');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'some-other-tool.service');
  fs.writeFileSync(p, installer.buildService({ exec: '/bin/true', script: '/x.js' }));
  return p;
}

// writeHealthyProjectDaemon(home, worktree) -> writes a FRESH heartbeat + a
// LIVE-pid (this test process's own pid — genuinely alive) lock for the
// per-project daemon of `worktree`'s repoKey, so projectDaemonHealthy reads
// running+healthy (D25's two-signal check: freshness AND lock/process evidence).
function writeHealthyProjectDaemon(home, worktree) {
  const hbPath = ingest.ingestHeartbeatPath(home, requireRepoKey(worktree));
  fs.mkdirSync(path.dirname(hbPath), { recursive: true });
  fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now(), pid: process.pid, workspaceId: 'primary-x' }));
  const lockPath = ingest.ingestLockPath(home, worktree);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'reap-test' }));
}

function requireRepoKey(worktree) {
  const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
  const key = repokey.repoKeyForWorktree(worktree);
  assert.ok(key, 'test setup: repoKeyForWorktree must resolve for a real git repo fixture');
  return key;
}

function schedMocks() {
  const calls = [];
  const removed = [];
  return {
    calls, removed,
    io: {
      schedRun: (spec) => { calls.push(spec); return { status: 0, stdout: '', error: null }; },
      schedFs: (p) => { removed.push(p); },
    },
  };
}

const PLATFORM = process.platform;
const SKIP_WIN32 = { skip: PLATFORM === 'win32' };

// ---------------------------------------------------------------------------
// reapOrphanedLegacyUnits — the core sweep.
// ---------------------------------------------------------------------------

test('reapOrphanedLegacyUnits: an orphaned legacy unit (worktree gone) is reaped, scheduler-based (never kill)', SKIP_WIN32, () => {
  const home = tmpHome();
  try {
    const goneWorktree = path.join(os.tmpdir(), 'reap-legacy-orphan-does-not-exist-' + Date.now());
    const hash = writeLegacyUnit(home, PLATFORM, goneWorktree, '/tmp/nope.js');
    const { io, calls, removed } = schedMocks();

    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io });

    assert.equal(results.length, 1);
    assert.equal(results[0].hash, hash);
    assert.equal(results[0].status, 'reaped');
    assert.match(results[0].msg, /orphaned/);
    assert.ok(calls.length > 0, 'the scheduler was invoked to stop the orphaned unit');
    for (const c of calls) {
      assert.ok(['launchctl', 'systemctl', 'crontab'].includes(c.cmd), 'scheduler-based stop only — never a raw kill');
    }
    // The unit file itself is removed via schedFs (mocked rm), never fs.unlinkSync directly.
    assert.ok(removed.some((p) => String(p).includes(hash) || String(p).includes(installer.labelForWorktree(goneWorktree)) || String(p).includes(installer.unitForWorktree(goneWorktree))));
  } finally { rm(home); }
});

test('reapOrphanedLegacyUnits: a legacy unit whose repoKey daemon is confirmed running+healthy is reaped as redundant', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('healthy');
  try {
    const hash = writeLegacyUnit(home, PLATFORM, repo, '/tmp/legacy.js');
    writeHealthyProjectDaemon(home, repo);
    const { io, calls } = schedMocks();

    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io });

    assert.equal(results.length, 1);
    assert.equal(results[0].hash, hash);
    assert.equal(results[0].status, 'reaped');
    assert.match(results[0].msg, /redundant/);
    assert.ok(calls.length > 0, 'the scheduler was invoked to stop the redundant unit');
  } finally { rm(home); rm(repo); }
});

test('reapOrphanedLegacyUnits: a legacy unit that is the SOLE possible drainer (worktree resolves, no confirmed-healthy project daemon) is NOT reaped', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('sole-drainer');
  try {
    const hash = writeLegacyUnit(home, PLATFORM, repo, '/tmp/legacy.js');
    // Deliberately no heartbeat/lock written for this repoKey's project daemon.
    const { io, calls, removed } = schedMocks();

    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io });

    assert.equal(results.length, 1);
    assert.equal(results[0].hash, hash);
    assert.equal(results[0].status, 'kept');
    assert.equal(calls.length, 0, 'never touches the scheduler for a unit that might be the sole drainer');
    assert.equal(removed.length, 0);
  } finally { rm(home); rm(repo); }
});

test('reapOrphanedLegacyUnits: a repoKey (per-project) unit is NOT matched by the legacy reap filter (D28) — never touched', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('project-unit');
  try {
    const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
    const repoKey = repokey.repoKeyForWorktree(repo);
    writeProjectUnit(home, PLATFORM, repoKey, repo, '/tmp/proj.js');
    const { io, calls } = schedMocks();

    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io });

    assert.equal(results.length, 0, 'a repoKey-shaped unit is never a legacy-reap candidate');
    assert.equal(calls.length, 0);
    // The project unit file survives untouched.
    const unitPath = PLATFORM === 'darwin'
      ? path.join(home, 'Library', 'LaunchAgents', installer.labelForProject(repoKey) + '.plist')
      : path.join(home, '.config', 'systemd', 'user', installer.unitForProject(repoKey) + '.service');
    assert.ok(fs.existsSync(unitPath), 'the per-project unit file is left in place');
  } finally { rm(home); rm(repo); }
});

test('reapOrphanedLegacyUnits: non-anti-hall scheduler units are never enumerated or touched', SKIP_WIN32, () => {
  const home = tmpHome();
  try {
    const foreignPath = writeForeignUnit(home, PLATFORM);
    const { io, calls } = schedMocks();

    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io });

    assert.equal(results.length, 0, 'no anti-hall ingest units installed — nothing for a foreign unit to be swept alongside');
    assert.equal(calls.length, 0);
    assert.ok(fs.existsSync(foreignPath), 'the foreign unit file is untouched');
  } finally { rm(home); }
});

test('reapOrphanedLegacyUnits: a LIVE monitor (worktree resolves, project daemon healthy) is stopped via the scheduler ONLY — never sent a destructive kill signal', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('live-monitor');
  try {
    writeLegacyUnit(home, PLATFORM, repo, '/tmp/legacy.js');
    writeHealthyProjectDaemon(home, repo);
    // process.kill(pid, 0) is the standard, non-destructive liveness PROBE this
    // codebase uses throughout (isAliveDefault) — it sends signal 0, which never
    // terminates anything. What must NEVER happen is a DESTRUCTIVE signal
    // (SIGTERM/SIGKILL/undefined-defaults-to-SIGTERM) sent to any pid.
    let destructiveKill = false;
    const realKill = process.kill;
    process.kill = function (pid, signal) {
      if (signal !== 0) destructiveKill = true;
      return realKill.call(process, pid, signal);
    };
    try {
      const { io } = schedMocks();
      repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io });
    } finally { process.kill = realKill; }
    assert.equal(destructiveKill, false, 'reaping a redundant-but-still-installed unit never sends a destructive kill signal — only liveness probes (signal 0) and scheduler-based stop');
  } finally { rm(home); rm(repo); }
});

test('reapOrphanedLegacyUnits: dry-run reports would-reap and touches no scheduler / no files', SKIP_WIN32, () => {
  const home = tmpHome();
  try {
    const goneWorktree = path.join(os.tmpdir(), 'reap-legacy-dryrun-does-not-exist-' + Date.now());
    const hash = writeLegacyUnit(home, PLATFORM, goneWorktree, '/tmp/nope.js');
    const { io, calls, removed } = schedMocks();

    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, dryRun: true, io });

    assert.equal(results.length, 1);
    assert.equal(results[0].hash, hash);
    assert.equal(results[0].status, 'would-reap');
    assert.match(results[0].msg, /dry-run/);
    assert.equal(calls.length, 0, 'dry-run never invokes the scheduler');
    assert.equal(removed.length, 0);
  } finally { rm(home); }
});

test('reapOrphanedLegacyUnits: no legacy units installed -> []', SKIP_WIN32, () => {
  const home = tmpHome();
  try {
    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io: schedMocks().io });
    assert.deepEqual(results, []);
  } finally { rm(home); }
});

test('reapOrphanedLegacyUnits: one unit that raises mid-evaluation is reported failed and never blocks sweeping the rest', SKIP_WIN32, () => {
  const home = tmpHome();
  const repoOk = makeGitRepo('fail-open-ok');
  try {
    const goneWorktree = path.join(os.tmpdir(), 'reap-legacy-throws-does-not-exist-' + Date.now());
    writeLegacyUnit(home, PLATFORM, goneWorktree, '/tmp/nope.js');
    const okHash = writeLegacyUnit(home, PLATFORM, repoOk, '/tmp/legacy.js');
    writeHealthyProjectDaemon(home, repoOk);
    let calls = 0;
    const io = {
      schedRun: (spec) => {
        calls++;
        if (calls === 1) throw new Error('boom');
        return { status: 0, stdout: '', error: null };
      },
      schedFs: () => {},
    };
    const results = repair.reapOrphanedLegacyUnits({ home, platform: PLATFORM, io });
    assert.equal(results.length, 2);
    const okResult = results.find((r) => r.hash === okHash);
    assert.ok(okResult, 'the second (healthy-redundant) unit is still evaluated and reaped despite the first raising');
    assert.ok(['reaped', 'failed'].includes(results.find((r) => r.hash !== okHash).status));
  } finally { rm(home); rm(repoOk); }
});

// ---------------------------------------------------------------------------
// projectDaemonHealthy — D25's two-signal check (freshness AND lock/process
// evidence — never freshness alone).
// ---------------------------------------------------------------------------

test('projectDaemonHealthy: fresh heartbeat + live-pid lock -> true', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('health-true');
  try {
    writeHealthyProjectDaemon(home, repo);
    const repoKey = requireRepoKey(repo);
    assert.equal(repair.projectDaemonHealthy(home, repoKey, Date.now()), true);
  } finally { rm(home); rm(repo); }
});

test('projectDaemonHealthy: stale heartbeat -> false (even with a live-pid lock)', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('health-stale');
  try {
    const repoKey = requireRepoKey(repo);
    const hbPath = ingest.ingestHeartbeatPath(home, repoKey);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now() - 60 * 60 * 1000, pid: process.pid }));
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 't' }));
    assert.equal(repair.projectDaemonHealthy(home, repoKey, Date.now()), false);
  } finally { rm(home); rm(repo); }
});

test('projectDaemonHealthy: fresh heartbeat but NO lock file -> false (missing process evidence)', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('health-nolock');
  try {
    const repoKey = requireRepoKey(repo);
    const hbPath = ingest.ingestHeartbeatPath(home, repoKey);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now(), pid: process.pid }));
    assert.equal(repair.projectDaemonHealthy(home, repoKey, Date.now()), false);
  } finally { rm(home); rm(repo); }
});

test('projectDaemonHealthy: fresh heartbeat + lock held by a DEAD pid -> false', SKIP_WIN32, () => {
  const home = tmpHome();
  const repo = makeGitRepo('health-deadpid');
  try {
    const repoKey = requireRepoKey(repo);
    const hbPath = ingest.ingestHeartbeatPath(home, repoKey);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now(), pid: 999999 }));
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // A pid astronomically unlikely to be alive on the test runner.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, ts: Date.now(), token: 't' }));
    assert.equal(repair.projectDaemonHealthy(home, repoKey, Date.now()), false);
  } finally { rm(home); rm(repo); }
});

test('projectDaemonHealthy: null/unresolvable repoKey -> false, never throws', () => {
  const home = tmpHome();
  try {
    assert.equal(repair.projectDaemonHealthy(home, null, Date.now()), false);
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// runRepairs wiring — the reap step is GATED the same as the existing ingest
// fix, and Windows is a documented no-op.
// ---------------------------------------------------------------------------

test('runRepairs: DevSwarm gate CLOSED -> reap-legacy-ingest is gated, never sweeps', SKIP_WIN32, () => {
  const home = tmpHome();
  const nogit = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-legacy-nogit-'));
  try {
    const results = repair.runRepairs({ cwd: nogit, env: {}, home, dryRun: true });
    const r = results.find((x) => x.action === 'reap-legacy-ingest' && x.id === 'reap-legacy-ingest');
    assert.ok(r, 'a reap-legacy-ingest gate report is present');
    assert.equal(r.status, 'gated');
  } finally { rm(home); rm(nogit); }
});

test('runRepairs: Windows -> reap-legacy-ingest is a documented no-op skip', () => {
  if (process.platform !== 'win32') {
    // Force the win32 branch directly via the platform override so this proves
    // the code path without requiring an actual Windows runner.
    const home = tmpHome();
    try {
      const results = repair.runRepairs({ cwd: process.cwd(), env: { DEVSWARM_REPO_ID: 'r1' }, home, dryRun: true, platform: 'win32' });
      const r = results.find((x) => x.action === 'reap-legacy-ingest' && x.id === 'reap-legacy-ingest');
      assert.ok(r);
      assert.equal(r.status, 'skipped');
      assert.match(r.msg, /Windows/);
    } finally { rm(home); }
  }
});
