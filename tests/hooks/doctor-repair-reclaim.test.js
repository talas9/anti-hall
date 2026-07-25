'use strict';
// v0.65.0 `doctor --reclaim-ingest-lock` (explicit, opt-in, human-invoked) +
// `checkMemguardReaperRisk` (report-only, defensive).
//
// This file's own doctor-repair.js code is a thin, testable ADAPTER over the
// daemon lane's real v0.65 exports (devswarm-ingest.js's classifyLockHolder /
// sweepOrphanedIngestLocks / acquireIngestLock; install-devswarm-ingest.js's
// detectReaperGuard / reaperWarningLines) — the dead/reused/zombie/wedged
// classification and the reaper-guard heuristic themselves are NOT
// reimplemented or re-tested here (that is the daemon lane's own test
// surface); these tests instead prove the ADAPTER: report shape, the
// win32/never-thrash/each-repo-heals-its-own-daemon decisions, dry-run vs real
// mutation, and graceful fail-open degradation when an expected export is
// missing.
//
// SAFETY OF THESE TESTS THEMSELVES: this feature signals processes and removes
// lock files, and its "trigger the existing reinstall path" step spawns a REAL
// installer that registers a REAL launchd/systemd job against the ACTUAL user
// session regardless of any HOME env override (same caveat doctor-repair.test.js's
// own reconcile suite documents) — so every test below that could reach that
// step injects `io.install` to intercept it, NEVER letting the real
// spawnInstaller run. Every process-liveness/start-time/zombie probe is
// injected via `io` (isAlive/isZombie/startTimeOf/kill/now) — this suite NEVER
// calls process.kill or inspects a real pid; all "pids" here are synthetic
// numbers whose fate is entirely decided by the injected probes.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const INGEST_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'devswarm-ingest.js');

const repair = require(REPAIR_JS);
const ingest = require(INGEST_JS);
const repokey = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js'));

function mkTmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-reclaim-' + tag + '-')); }
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function makeGitRepo(tag) {
  const dir = mkTmp('repo-' + tag);
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return fs.realpathSync(dir);
}
function neverInstall() {
  throw new Error('io.install must not be called in this scenario');
}
function recordingInstall() {
  const calls = [];
  const fn = () => { calls.push(true); return { status: 0 }; };
  fn.calls = calls;
  return fn;
}
// baseIo(extra) — every synthetic pid in this suite is "dead" and "not a
// zombie" unless a test explicitly overrides isAlive/isZombie, so a lock never
// silently falls through to a REAL process probe (defaultIsZombieProcess/
// defaultProcessStartTimeMs would otherwise spawn a real `ps`/read `/proc` for
// a nonexistent synthetic pid — harmless, but this keeps every test's
// intent explicit and avoids any real syscall dependency).
function baseIo(extra) { return Object.assign({ isAlive: () => false, isZombie: () => false }, extra || {}); }

// ---------------------------------------------------------------------------
// 1. sweepOrphanedIngestLockFiles — adapter over devswarm-ingest.js's OWN
// sweepOrphanedIngestLocks / classifyLockHolder (v0.65 daemon-reliability).
// ---------------------------------------------------------------------------
function lockFilePath(home, name) {
  const dir = path.join(home, '.anti-hall', 'devswarm', 'locks');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
function writeLock(home, name, { pid, ts }) {
  const p = lockFilePath(home, name);
  fs.writeFileSync(p, JSON.stringify({ pid, ts }));
  return p;
}

test('sweepOrphanedIngestLockFiles: removes a dead-pid lock, a zombie lock, and a pid-reuse lock; keeps a live-plausible lock; ignores a non-ingest lock file', () => {
  const home = mkTmp('sweep-home');
  try {
    const deadLock = writeLock(home, 'ingest-project-repoA-111111.lock', { pid: 90001, ts: 1000 });
    const zombieLock = writeLock(home, 'ingest-project-repoB-222222.lock', { pid: 90002, ts: 1000 });
    const reuseLock = writeLock(home, 'ingest-repoC-legacyhash.lock', { pid: 90003, ts: 1000 });
    const liveLock = writeLock(home, 'ingest.lock', { pid: 90004, ts: 1000 });
    const otherLock = lockFilePath(home, 'unrelated-something.lock');
    fs.writeFileSync(otherLock, JSON.stringify({ pid: 90001, ts: 1 })); // dead pid, but NOT an ingest lock name — must be ignored entirely

    const io = baseIo({
      isAlive: (pid) => pid === 90002 || pid === 90003 || pid === 90004, // 90001 is dead
      isZombie: (pid) => pid === 90002,
      startTimeOf: (pid) => (pid === 90003 ? 200000 : 500), // 90003 started well AFTER ts:1000 (+ PID_REUSE_TOLERANCE_MS) -> reuse; 90004 before -> plausible
      // must stay >= every injected startTimeOf (so classifyLockHolder never discards a
      // reading as implausible) AND leave every lock's ts:1000 past INGEST_LOCK_STALE_MS
      // (15min/900000ms) — a 'reused' verdict now ALSO requires staleness before it
      // authorizes removal (P1 fix: a live holder's lock is refreshed every loop
      // iteration, so a merely-postdated-but-FRESH reading must never be reclaimed —
      // see classifyLockHolder's 'reused' vs 'reused-fresh' states).
      now: () => 1_000_000,
    });
    const results = repair.sweepOrphanedIngestLockFiles({ home, dryRun: false, io });

    const byPath = {};
    for (const r of results) if (r.lockPath) byPath[r.lockPath] = r;

    assert.strictEqual(byPath[deadLock].status, 'fixed');
    assert.strictEqual(byPath[deadLock].verdict, 'dead');
    assert.strictEqual(fs.existsSync(deadLock), false, 'dead-pid lock must be removed');

    assert.strictEqual(byPath[zombieLock].status, 'fixed');
    assert.strictEqual(byPath[zombieLock].verdict, 'zombie');
    assert.strictEqual(fs.existsSync(zombieLock), false, 'zombie lock must be removed');

    assert.strictEqual(byPath[reuseLock].status, 'fixed');
    assert.strictEqual(byPath[reuseLock].verdict, 'reused');
    assert.strictEqual(fs.existsSync(reuseLock), false, 'pid-reuse lock must be removed');

    assert.strictEqual(byPath[liveLock], undefined, 'a live, plausible holder is never individually reported by the real sweep (only reaped entries + a kept-count summary)');
    assert.strictEqual(fs.existsSync(liveLock), true, 'a live, plausible holder must NEVER be touched');
    assert.ok(results.some((r) => r.id === 'reclaim-sweep-summary' && /kept/.test(r.msg)), 'a kept-count summary must be present: ' + JSON.stringify(results));

    assert.strictEqual(byPath[otherLock], undefined, 'a non-ingest-named lock file must never even be considered');
    assert.strictEqual(fs.existsSync(otherLock), true);
  } finally { rm(home); }
});

test('sweepOrphanedIngestLockFiles --dry-run: reports what it would reclaim, removes nothing', () => {
  const home = mkTmp('sweep-dry');
  try {
    const deadLock = writeLock(home, 'ingest-project-repoA-111111.lock', { pid: 90001, ts: 1000 });
    const io = baseIo();
    const results = repair.sweepOrphanedIngestLockFiles({ home, dryRun: true, io });
    const r = results.find((x) => x.lockPath === deadLock);
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.verdict, 'dead');
    assert.match(r.msg, /\[dry-run\] would reclaim/);
    assert.strictEqual(fs.existsSync(deadLock), true, '--dry-run must never remove a lock file');
  } finally { rm(home); }
});

test('sweepOrphanedIngestLockFiles: an empty/absent locks dir yields no results, never creates one', () => {
  const home = mkTmp('sweep-empty');
  try {
    const results = repair.sweepOrphanedIngestLockFiles({ home, dryRun: false, io: baseIo() });
    assert.deepStrictEqual(results, []);
    assert.strictEqual(fs.existsSync(path.join(home, '.anti-hall', 'devswarm', 'locks')), false, 'must never create the locks dir just by sweeping');
  } finally { rm(home); }
});

test('sweepOrphanedIngestLockFiles: devswarm-ingest.js missing readLockHolder/classifyLockHolder in this build -> fails open with a clear message, never crashes', () => {
  const key = require.resolve(INGEST_JS);
  const original = require.cache[key].exports;
  const stripped = Object.assign({}, original);
  delete stripped.classifyLockHolder;
  require.cache[key].exports = stripped;
  try {
    const results = repair.sweepOrphanedIngestLockFiles({ home: mkTmp('sweep-missing-export'), dryRun: false, io: baseIo() });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].status, 'failed');
    assert.match(results[0].msg, /does not export/);
  } finally {
    require.cache[key].exports = original;
  }
});

// ---------------------------------------------------------------------------
// 2. reclaimCurrentProjectLock — delegates entirely to devswarm-ingest.js's
// OWN acquireIngestLock() for the mutating decision (dead/reused/zombie
// reclaimed immediately inside it; wedged -> SIGKILL; live+healthy -> refuse).
// ---------------------------------------------------------------------------
function heartbeatPathFor(home, hash) {
  return path.join(home, '.anti-hall', 'devswarm', 'heartbeats', 'ingest-' + hash + '.json');
}
function writeHeartbeat(home, hash, { ts, pid }) {
  const p = heartbeatPathFor(home, hash);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ts, pid }));
}

test('reclaimCurrentProjectLock: no lock file present -> skipped, nothing touched', () => {
  const home = mkTmp('cur-none-home');
  const repo = makeGitRepo('cur-none');
  try {
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: false, io: baseIo() });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.verdict, null);
  } finally { rm(home); rm(repo); }
});

test('reclaimCurrentProjectLock: dead-pid holder -> reclaimed via acquireIngestLock, never signalled', () => {
  const home = mkTmp('cur-dead-home');
  const repo = makeGitRepo('cur-dead');
  try {
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90005, ts: Date.now() }));
    const io = baseIo({ kill: () => { throw new Error('a dead holder must never be signalled'); } });
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: false, io });
    assert.strictEqual(r.status, 'fixed', JSON.stringify(r));
    assert.strictEqual(r.verdict, 'dead');
    assert.strictEqual(fs.existsSync(lockPath), false);
  } finally { rm(home); rm(repo); }
});

test('reclaimCurrentProjectLock: zombie holder -> reclaimed, never signalled', () => {
  const home = mkTmp('cur-zombie-home');
  const repo = makeGitRepo('cur-zombie');
  try {
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90006, ts: Date.now() }));
    const io = baseIo({
      isAlive: (pid) => pid === 90006,
      isZombie: (pid) => pid === 90006,
      kill: () => { throw new Error('a zombie holder must never be signalled — it can never run kill\'s handler'); },
    });
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: false, io });
    assert.strictEqual(r.status, 'fixed', JSON.stringify(r));
    assert.strictEqual(r.verdict, 'zombie');
    assert.strictEqual(fs.existsSync(lockPath), false);
  } finally { rm(home); rm(repo); }
});

test('reclaimCurrentProjectLock: pid-reuse holder (alive, start time postdates the lock) -> reclaimed, never signalled', () => {
  const home = mkTmp('cur-reuse-home');
  const repo = makeGitRepo('cur-reuse');
  try {
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90007, ts: 1000 }));
    const io = baseIo({
      isAlive: (pid) => pid === 90007,
      startTimeOf: (pid) => (pid === 90007 ? 999999999999 : null), // far AFTER ts:1000
      now: () => 1000000000000,
      kill: () => { throw new Error('a recycled-pid holder must never be signalled — it is an unrelated live process'); },
    });
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: false, io });
    assert.strictEqual(r.status, 'fixed', JSON.stringify(r));
    assert.strictEqual(r.verdict, 'reused');
    assert.strictEqual(fs.existsSync(lockPath), false);
  } finally { rm(home); rm(repo); }
});

test('reclaimCurrentProjectLock: live + healthy (fresh heartbeat, plausible identity) -> LEFT UNTOUCHED (acquireIngestLock refuses)', () => {
  const home = mkTmp('cur-live-home');
  const repo = makeGitRepo('cur-live');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90008, ts: Date.now() })); // fresh lock ts -> not even "stale" by lock-ts
    writeHeartbeat(home, repoKey, { ts: Date.now(), pid: 90008 }); // fresh heartbeat too
    const io = baseIo({
      isAlive: (pid) => pid === 90008,
      startTimeOf: (pid) => (pid === 90008 ? Date.now() - 5000 : null),
      kill: () => { throw new Error('a live, healthy holder must never be signalled'); },
      sleep: () => {}, reclaimGraceMs: 0, // skip the real ~40s wedge-grace wait — verdict is null here (isAlive true), so this branch is reached
    });
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: false, io });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.verdict, null);
    assert.strictEqual(fs.existsSync(lockPath), true, 'a live, healthy holder\'s lock must survive');
  } finally { rm(home); rm(repo); }
});

test('reclaimCurrentProjectLock: live + WEDGED (stale own heartbeat, matching pid, plausible start time) -> SIGKILLed (injected) then reclaimed', () => {
  const home = mkTmp('cur-wedged-home');
  const repo = makeGitRepo('cur-wedged');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const oldTs = Date.now() - 20 * 60 * 1000; // > INGEST_LOCK_STALE_MS (15 min) for BOTH the lock ts and the heartbeat ts
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90009, ts: oldTs }));
    writeHeartbeat(home, repoKey, { ts: oldTs, pid: 90009 });
    let killed = null;
    const io = baseIo({
      isAlive: (pid) => pid === 90009,
      startTimeOf: (pid) => (pid === 90009 ? oldTs - 1000 : null), // started BEFORE the heartbeat -> plausible identity, not reuse
      kill: (pid, sig) => { killed = { pid, sig }; }, // NEVER a real process.kill
      sleep: () => {}, reclaimGraceMs: 0, // skip the real ~40s wedge-grace wait
    });
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: false, io });
    assert.strictEqual(r.status, 'fixed', JSON.stringify(r));
    assert.strictEqual(r.verdict, 'wedged');
    assert.deepStrictEqual(killed, { pid: 90009, sig: 'SIGKILL' }, 'the wedged holder must be SIGKILLed via the injected io.kill, never process.kill directly');
    assert.strictEqual(fs.existsSync(lockPath), false, 'the lock must be reclaimed (and released) after the wedged holder is cleared');
  } finally { rm(home); rm(repo); }
});

test('reclaimCurrentProjectLock --dry-run: a dead-pid holder is reported (verdict carried) but the lock file is NOT removed', () => {
  const home = mkTmp('cur-dry-home');
  const repo = makeGitRepo('cur-dry');
  try {
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90010, ts: Date.now() }));
    const io = baseIo();
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: true, io });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.verdict, 'dead');
    assert.match(r.msg, /\[dry-run\] would reclaim/);
    assert.strictEqual(fs.existsSync(lockPath), true);
  } finally { rm(home); rm(repo); }
});

test('reclaimCurrentProjectLock --dry-run: a live/wedged-ambiguous holder is previewed WITHOUT probing acquireIngestLock (no guaranteed-preview claim)', () => {
  const home = mkTmp('cur-dry-wedge-home');
  const repo = makeGitRepo('cur-dry-wedge');
  try {
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90011, ts: Date.now() }));
    const io = baseIo({ isAlive: (pid) => pid === 90011, kill: neverInstall });
    const r = repair.reclaimCurrentProjectLock({ home, currentWorktree: repo, dryRun: true, io });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.verdict, null);
    assert.match(r.msg, /\[dry-run\] would probe/);
    assert.strictEqual(fs.existsSync(lockPath), true);
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// 3. reclaimIngestLocks — full orchestration. `io.install` ALWAYS intercepts
// the reinstall step in every test below that could reach it (see this file's
// header comment for why the real spawnInstaller must never run here). Every
// test asserting Unix-only reclaim behavior below passes a FIXED
// `platform: 'linux'` rather than the ambient `process.platform` — this suite
// must behave identically on a Windows CI runner, where ambient
// process.platform would otherwise make reclaimIngestLocks take the early
// win32 return path (tested explicitly, separately, right below) instead of
// exercising the sweep/current-lock/reinstall logic these tests assert on.
// ---------------------------------------------------------------------------
test('reclaimIngestLocks: platform win32 -> single skip, sweep/current-lock/reinstall never run, io.install never called', () => {
  const home = mkTmp('top-win32-home');
  const repo = makeGitRepo('top-win32');
  try {
    writeLock(home, 'ingest-project-repoA-111111.lock', { pid: 1, ts: 1 }); // would be swept on any other platform
    const results = repair.reclaimIngestLocks({ cwd: repo, env: {}, home, dryRun: false, platform: 'win32', io: baseIo({ install: neverInstall }) });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].status, 'skipped');
    assert.match(results[0].msg, /Windows/);
  } finally { rm(home); rm(repo); }
});

test('reclaimIngestLocks: nothing to reclaim anywhere -> reinstall reports "nothing was reclaimed", io.install never called', () => {
  const home = mkTmp('top-none-home');
  const repo = makeGitRepo('top-none');
  try {
    const results = repair.reclaimIngestLocks({ cwd: repo, env: {}, home, dryRun: false, platform: 'linux', io: baseIo({ install: neverInstall }) });
    const r = results.find((x) => x.id === 'reclaim-reinstall');
    assert.ok(r);
    assert.strictEqual(r.status, 'skipped');
    assert.match(r.msg, /nothing was reclaimed/);
  } finally { rm(home); rm(repo); }
});

test('reclaimIngestLocks: THIS worktree\'s own dead lock is reclaimed -> reinstall IS triggered via io.install', () => {
  const home = mkTmp('top-dead-home');
  const repo = makeGitRepo('top-dead');
  try {
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90012, ts: Date.now() }));
    const install = recordingInstall();
    const io = baseIo({ install });
    const results = repair.reclaimIngestLocks({ cwd: repo, env: {}, home, dryRun: false, platform: 'linux', io });
    const reinstall = results.find((x) => x.id === 'reclaim-reinstall');
    assert.strictEqual(reinstall.status, 'fixed', JSON.stringify(results, null, 2));
    assert.strictEqual(install.calls.length, 1, 'io.install must be called exactly once');
    assert.strictEqual(fs.existsSync(lockPath), false);
  } finally { rm(home); rm(repo); }
});

test('reclaimIngestLocks --dry-run: THIS worktree\'s dead lock would be reclaimed -> reports "[dry-run] would (re)install", io.install NEVER called, lock untouched', () => {
  const home = mkTmp('top-dry-home');
  const repo = makeGitRepo('top-dry');
  try {
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90013, ts: Date.now() }));
    const io = baseIo({ install: neverInstall });
    const results = repair.reclaimIngestLocks({ cwd: repo, env: {}, home, dryRun: true, platform: 'linux', io });
    const reinstall = results.find((x) => x.id === 'reclaim-reinstall');
    assert.strictEqual(reinstall.status, 'skipped');
    assert.match(reinstall.msg, /\[dry-run\] would \(re\)install/);
    assert.strictEqual(fs.existsSync(lockPath), true, '--dry-run must never remove the lock either');
  } finally { rm(home); rm(repo); }
});

test('reclaimIngestLocks: a dead lock belonging to a DIFFERENT project is swept, but reinstall is NEVER triggered for an unrelated worktree (each repo heals only its own daemon)', () => {
  const home = mkTmp('top-other-home');
  const repo = makeGitRepo('top-other-mine');
  try {
    // Some OTHER project's dead lock — a completely different repoKey shape,
    // never matching THIS worktree's own ingestLockPath.
    const otherLock = writeLock(home, 'ingest-project-someoneElse-abcdef.lock', { pid: 90014, ts: 1000 });
    const io = baseIo({ install: neverInstall });
    const results = repair.reclaimIngestLocks({ cwd: repo, env: {}, home, dryRun: false, platform: 'linux', io });
    const sweepEntry = results.find((x) => x.action === 'reclaim-ingest-lock-sweep' && x.msg.includes(otherLock));
    assert.ok(sweepEntry, 'the other project\'s dead lock must still be swept');
    assert.strictEqual(sweepEntry.status, 'fixed');
    assert.strictEqual(fs.existsSync(otherLock), false);
    const reinstall = results.find((x) => x.id === 'reclaim-reinstall');
    assert.strictEqual(reinstall.status, 'skipped', 'reinstall must never fire for a lock reclaimed on an unrelated worktree');
    assert.match(reinstall.msg, /nothing was reclaimed/);
  } finally { rm(home); rm(repo); }
});

test('reclaimIngestLocks: cwd is not inside a resolvable git worktree -> current-lock skipped with a clear reason, no reinstall', () => {
  const home = mkTmp('top-noworktree-home');
  const notARepo = mkTmp('top-noworktree-cwd');
  try {
    const results = repair.reclaimIngestLocks({ cwd: notARepo, env: {}, home, dryRun: false, platform: 'linux', io: baseIo({ install: neverInstall }) });
    const current = results.find((x) => x.id === 'reclaim-current-lock');
    assert.match(current.msg, /not inside a resolvable git worktree/);
    const reinstall = results.find((x) => x.id === 'reclaim-reinstall');
    assert.strictEqual(reinstall.status, 'skipped');
  } finally { rm(home); rm(notARepo); }
});

test('reclaimIngestLocks: THIS worktree\'s WEDGED lock (via the real acquireIngestLock delegation) is reclaimed end-to-end and triggers reinstall', () => {
  const home = mkTmp('top-wedged-home');
  const repo = makeGitRepo('top-wedged');
  try {
    const repoKey = repokey.repoKeyForWorktree(repo);
    const lockPath = ingest.ingestLockPath(home, repo);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const oldTs = Date.now() - 20 * 60 * 1000;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90015, ts: oldTs }));
    writeHeartbeat(home, repoKey, { ts: oldTs, pid: 90015 });
    const install = recordingInstall();
    let killed = false;
    const io = baseIo({
      isAlive: (pid) => pid === 90015,
      startTimeOf: (pid) => (pid === 90015 ? oldTs - 1000 : null),
      kill: () => { killed = true; },
      install,
      sleep: () => {}, reclaimGraceMs: 0, // skip the real ~40s wedge-grace wait
    });
    const results = repair.reclaimIngestLocks({ cwd: repo, env: {}, home, dryRun: false, platform: 'linux', io });
    const current = results.find((x) => x.id === 'reclaim-current-lock');
    assert.strictEqual(current.status, 'fixed', JSON.stringify(current));
    assert.strictEqual(killed, true);
    const reinstall = results.find((x) => x.id === 'reclaim-reinstall');
    assert.strictEqual(reinstall.status, 'fixed');
    assert.strictEqual(install.calls.length, 1);
  } finally { rm(home); rm(repo); }
});

// ---------------------------------------------------------------------------
// 4. checkMemguardReaperRisk — adapter over install-devswarm-ingest.js's OWN
// detectReaperGuard/reaperWarningLines (v0.65 memory-guard/reaper detection).
// ---------------------------------------------------------------------------
test('checkMemguardReaperRisk: the REAL detectReaperGuard finds nothing on a fresh fixture home with no scripts dir -> null (stay silent)', () => {
  const home = mkTmp('memguard-real-empty');
  try {
    assert.strictEqual(repair.checkMemguardReaperRisk({ home }), null);
  } finally { rm(home); }
});

test('checkMemguardReaperRisk: a real fixture reaper script that kills by exclusion and does NOT allowlist devswarm-ingest -> surfaces a warning naming the file', () => {
  const home = mkTmp('memguard-real-atrisk');
  try {
    const scriptsDir = path.join(home, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    const scriptPath = path.join(scriptsDir, 'claude-memguard.sh');
    fs.writeFileSync(scriptPath, [
      '#!/bin/bash',
      "MCP_ALLOWLIST='mcp-server obsidian-mcp'",
      'for pid in $(pgrep node); do kill -9 "$pid"; done',
    ].join('\n'));
    const r = repair.checkMemguardReaperRisk({ home });
    assert.ok(r, 'a real unprotected reaper script must be surfaced');
    assert.strictEqual(r.atRisk, true);
    assert.strictEqual(r.file, scriptPath);
    assert.match(r.message, /devswarm-ingest/);
  } finally { rm(home); }
});

test('checkMemguardReaperRisk: a real fixture reaper script that DOES allowlist devswarm-ingest -> null (already protective, silent)', () => {
  const home = mkTmp('memguard-real-protected');
  try {
    const scriptsDir = path.join(home, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'claude-memguard.sh'), [
      '#!/bin/bash',
      "MCP_ALLOWLIST='mcp-server devswarm-ingest'",
      'for pid in $(pgrep node); do kill -9 "$pid"; done',
    ].join('\n'));
    assert.strictEqual(repair.checkMemguardReaperRisk({ home }), null);
  } finally { rm(home); }
});

test('checkMemguardReaperRisk: an unrequireable modPath -> null, never throws', () => {
  assert.strictEqual(repair.checkMemguardReaperRisk({ modPath: '/no/such/module-xyz.js' }), null);
});

function withFixtureModule(exportsSrc, fn) {
  const dir = mkTmp('memguard-fixture');
  const modPath = path.join(dir, 'fixture.js');
  fs.writeFileSync(modPath, exportsSrc);
  try { return fn(modPath); } finally { rm(dir); }
}

test('checkMemguardReaperRisk: modPath override with the real contract shape (fixture module) -> surfaced verbatim', () => {
  withFixtureModule(
    'module.exports = { detectReaperGuard: () => ({ found: true, file: "/fake/path.sh", allowlisted: false, allowlistVar: "MCP_ALLOWLIST", needsAction: true }), reaperWarningLines: (d) => d.needsAction ? ["line one", "  " + d.file] : [] };',
    (modPath) => {
      const r = repair.checkMemguardReaperRisk({ modPath });
      assert.deepStrictEqual(r, { atRisk: true, message: 'line one\n  /fake/path.sh', file: '/fake/path.sh' });
    },
  );
});

test('checkMemguardReaperRisk: reaperWarningLines returns [] (no action needed) -> null (silent)', () => {
  withFixtureModule(
    'module.exports = { detectReaperGuard: () => ({ needsAction: false }), reaperWarningLines: () => [] };',
    (modPath) => { assert.strictEqual(repair.checkMemguardReaperRisk({ modPath }), null); },
  );
});

test('checkMemguardReaperRisk: detectReaperGuard THROWS -> fail-open null, never propagates', () => {
  withFixtureModule(
    'module.exports = { detectReaperGuard: () => { throw new Error("boom"); }, reaperWarningLines: () => [] };',
    (modPath) => { assert.strictEqual(repair.checkMemguardReaperRisk({ modPath }), null); },
  );
});

test('checkMemguardReaperRisk: reaperWarningLines THROWS -> fail-open null, never propagates', () => {
  withFixtureModule(
    'module.exports = { detectReaperGuard: () => ({}), reaperWarningLines: () => { throw new Error("boom"); } };',
    (modPath) => { assert.strictEqual(repair.checkMemguardReaperRisk({ modPath }), null); },
  );
});

test('checkMemguardReaperRisk: module has no detectReaperGuard/reaperWarningLines exports -> null (silent) — this is what the REAL devswarm-ingest.js (wrong file) looks like too', () => {
  assert.strictEqual(repair.checkMemguardReaperRisk({ modPath: INGEST_JS }), null);
});

// ---------------------------------------------------------------------------
// 5. Black-box: doctor.js --reclaim-ingest-lock and the memguard-reaper
// section, spawned as a real subprocess against an isolated HOME.
// ---------------------------------------------------------------------------
const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');
function runDoctor({ cwd, env, args }) {
  const res = cp.spawnSync(process.execPath, [DOCTOR_JS].concat(args || []), {
    cwd, encoding: 'utf8', timeout: 20000,
    env: Object.assign({}, process.env, {
      HOME: undefined, USERPROFILE: undefined, DEVSWARM_REPO_ID: undefined,
      DISABLE_ANTIHALL_DEVSWARM: undefined, ANTIHALL_DEVSWARM_SUPERVISOR: undefined,
      // Ambient-env leak fix: inheriting process.env wholesale means a real
      // ANTIHALL_DOCTOR_CONTEXT set in the invoking shell (e.g. 'flutter-debug')
      // changes doctor's own behavior (see doctor.js's flutter-debug context
      // check) and makes this suite's pass/fail depend on the ambient
      // environment it happens to run under — the exact "shipped RED because
      // of ambient state" failure class this project has been burned by
      // before. Always clear it explicitly, same as the other behavior-
      // selecting vars above.
      ANTIHALL_DOCTOR_CONTEXT: undefined,
    }, env || {}),
  });
  return { code: res.status, out: (res.stdout || '') + (res.stderr || '') };
}

test('doctor --reclaim-ingest-lock --dry-run: prints the section, exits 0 on a clean fixture with no lock files, no memguard-reaper section (no scripts dir)', () => {
  const home = mkTmp('doctor-reclaim-home');
  const cwd = makeGitRepo('doctor-reclaim-cwd');
  try {
    const r = runDoctor({ cwd, args: ['--check', '--reclaim-ingest-lock', '--dry-run'], env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /Reclaim ingest lock \(dry-run.*\[explicit --reclaim-ingest-lock\]/);
    assert.doesNotMatch(r.out, /memguard-reaper risk/, 'the memguard-reaper section must stay silent when no reaper script is found');
  } finally { rm(home); rm(cwd); }
});

// NOTE: a real, non-dry-run `doctor --reclaim-ingest-lock` subprocess test that
// seeds a genuinely reclaimable lock USED to live here. It was removed: doctor.js's
// own call site never threads an `io` seam into reclaimIngestLocks() across the
// process boundary, so a real reclaim in that subprocess falls through to the
// REAL spawnInstaller -> a REAL launchd/systemd-user/cron reinstall registered
// against the actual dev/CI session (the exact incident doctor-repair.test.js's
// own reconcile suite already documents and engineers around). It also asserted
// liveness against a hard-coded literal pid (90099), which is inside the live
// PID range on some hosts and would hang the subprocess for the full ~40s reclaim
// grace window. The mutating reclaim path (including the reinstall trigger) is
// already safely proven IN-PROCESS above, with io.install intercepting the
// reinstall step — see "reclaimIngestLocks: THIS worktree's own dead lock is
// reclaimed -> reinstall IS triggered via io.install". Only the --dry-run
// subprocess test (CLI wiring/output-text coverage, never mutates) is kept below.

test('doctor --reclaim-ingest-lock: a real unprotected reaper fixture script under HOME/.claude/scripts surfaces the memguard-reaper risk section', () => {
  const home = mkTmp('doctor-memguard-home');
  const cwd = makeGitRepo('doctor-memguard-cwd');
  try {
    const scriptsDir = path.join(home, '.claude', 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, 'claude-memguard.sh'), [
      '#!/bin/bash',
      "MCP_ALLOWLIST='mcp-server'",
      'for pid in $(pgrep node); do kill -9 "$pid"; done',
    ].join('\n'));
    const r = runDoctor({ cwd, args: ['--check'], env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.match(r.out, /memguard-reaper risk/);
    assert.match(r.out, /devswarm-ingest/);
  } finally { rm(home); rm(cwd); }
});

test('doctor (no --reclaim-ingest-lock flag): the reclaim section never prints, even with a dead lock file present', () => {
  const home = mkTmp('doctor-noflag-home');
  const cwd = makeGitRepo('doctor-noflag-cwd');
  try {
    const lockPath = ingest.ingestLockPath(home, cwd);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 90016, ts: Date.now() }));
    const r = runDoctor({ cwd, args: ['--check'], env: { HOME: home, USERPROFILE: home } });
    assert.strictEqual(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Reclaim ingest lock/, '--reclaim-ingest-lock is opt-in — omitting it must never run the reclaim pass');
    assert.strictEqual(fs.existsSync(lockPath), true, 'omitting the flag must never touch an existing lock file');
  } finally { rm(home); rm(cwd); }
});
