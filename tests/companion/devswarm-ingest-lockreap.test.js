'use strict';
// devswarm-ingest-lockreap.test.js — v0.65 daemon-reliability hardening.
//
// FIELD FAILURE THIS COVERS (verified, not hypothetical): the launchd ingest
// job was SIGKILLed (exit -9) by an external memory-guard's runaway-node
// "post-pass", which kills non-allowlisted node processes whose PPID is 1 — and
// a LaunchAgent always has PPID 1. It leaked its lock; 58 lock files piled up in
// ~/.anti-hall/devswarm/locks/ with 52 dead owning pids; every restart then
// refused ("another monitor consumer is already running" / "legacy per-worktree
// ingest holder(s) still alive") and KeepAlive turned that into a
// refuse -> exit(1) -> relaunch loop.
//
// Four fixes are proven here:
//   1. probeLegacyHolders applies the SAME pid start-time identity check
//      isHolderHeartbeatStale already had — a RECYCLED pid no longer blocks
//      forever, and the orphan it "holds" is removed.
//   2. sweepOrphanedIngestLocks reaps confirmed-orphan lock files at daemon
//      start, while preserving live-owner locks and the daemon's own lock.
//   3. A ZOMBIE (defunct, state Z) holder — which kill(pid,0) reports as ALIVE —
//      is treated as dead and reclaimed.
//   4. install-devswarm-ingest reports (never patches) a local reaper script
//      that would kill this daemon without allowlisting it.
//
// HERMETIC BY CONSTRUCTION. Every process probe is injected (io.isAlive,
// io.startTimeOf, io.isZombie, io.kill) and every clock is injected (io.now);
// NO test in this file ever signals, spawns against, or reads the state of a
// real process, and none of them read the ambient ~/.anti-hall (each uses its
// own mkdtemp HOME). A prior release shipped RED because a test leaned on
// ambient state — nothing here can.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const installIngest = require('../../plugins/anti-hall/companion/install-devswarm-ingest.js');

const STALE_MS = ingest.INGEST_LOCK_STALE_MS;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-lockreap-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

function writeLock(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}
function porcelainFor(paths) {
  return paths.map((p) => `worktree ${p}\nHEAD abc\nbranch refs/heads/x\n`).join('\n');
}

// ---------------------------------------------------------------------------
// 1. probeLegacyHolders — pid-reuse identity guard
// ---------------------------------------------------------------------------

test('probeLegacyHolders: a RECYCLED pid (start time postdates the lock) is NOT a holder — no block, and the proven orphan lock is removed', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const wtB = '/repo/a-wt-b';
    const now = 1_700_000_000_000;
    const lockB = ingest.legacyIngestLockPath(home, wtB);
    // The legacy daemon wrote this lock 20 minutes ago and then died.
    writeLock(lockB, { pid: 4242, ts: now - 20 * 60 * 1000 });

    const probe = ingest.probeLegacyHolders(home, wtA, {
      run: () => ({ ok: true, raw: porcelainFor([wtA, wtB]) }),
      now: () => now,
      isAlive: () => true,             // the OS says pid 4242 is alive again ...
      startTimeOf: () => now - 30_000, // ... but it only started 30s ago -> a DIFFERENT process
      isZombie: () => false,
    });

    assert.equal(probe.blocked, false, 'a recycled pid must never block the daemon forever');
    assert.equal(probe.liveHolders.length, 0);
    assert.equal(probe.reaped.length, 1, 'the proven orphan lock is removed');
    assert.equal(probe.reaped[0].reason, 'reused');
    assert.equal(fs.existsSync(lockB), false, 'the orphaned legacy lock file is gone');
  } finally { rm(home); }
});

test('probeLegacyHolders: a GENUINELY live holder whose start time is CONSISTENT with its lock STILL blocks (no regression) and its lock is left intact', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const wtB = '/repo/a-wt-b';
    const now = 1_700_000_000_000;
    const lockB = ingest.legacyIngestLockPath(home, wtB);
    // A live daemon refreshes its lock ts every loop iteration -> fresh ts,
    // and it started long BEFORE that ts, so identity is consistent.
    writeLock(lockB, { pid: 4242, ts: now - 5_000 });

    const probe = ingest.probeLegacyHolders(home, wtA, {
      run: () => ({ ok: true, raw: porcelainFor([wtA, wtB]) }),
      now: () => now,
      isAlive: () => true,
      startTimeOf: () => now - 60 * 60 * 1000, // started an hour ago -> could well be the writer
      isZombie: () => false,
    });

    assert.equal(probe.blocked, true, 'a real, consistent legacy consumer must still block the drain');
    assert.equal(probe.liveHolders.length, 1);
    assert.equal(probe.liveHolders[0].pid, 4242);
    assert.equal(probe.reaped.length, 0, 'a live holder\'s lock is NEVER removed');
    assert.ok(fs.existsSync(lockB), 'the live holder\'s lock file is untouched');
  } finally { rm(home); }
});

test('probeLegacyHolders: an UNCONFIRMABLE identity on a STALE lock (alive per kill(pid,0), start time unresolvable) still BLOCKS and deletes nothing (fail-closed on an inconclusive read — an unreadable ps/proc is exactly as likely to be the genuine live holder as not, and this is the ONLY guard against two concurrent monitor consumers)', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const now = 1_700_000_000_000;
    const lockA = ingest.legacyIngestLockPath(home, wtA);
    writeLock(lockA, { pid: 4242, ts: now - (STALE_MS + 60_000) });

    const probe = ingest.probeLegacyHolders(home, wtA, {
      run: () => ({ ok: true, raw: porcelainFor([wtA]) }),
      now: () => now,
      isAlive: () => true,
      startTimeOf: () => null, // the OS cannot tell us -> identity unprovable either way
      isZombie: () => false,
    });

    assert.equal(probe.blocked, true, 'an unprovable-but-alive holder must block — relaxing this is how two concurrent monitor consumers happen');
    assert.equal(probe.reaped.length, 0, 'nothing is deleted on an UNCONFIRMED verdict — blocking authorizes no removal either way');
    assert.ok(fs.existsSync(lockA), 'the unconfirmable lock file is left exactly as found');
  } finally { rm(home); }
});

test('probeLegacyHolders: an unconfirmable identity on a FRESH lock still blocks (fail toward preserving the single-consumer invariant)', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const now = 1_700_000_000_000;
    writeLock(ingest.legacyIngestLockPath(home, wtA), { pid: 4242, ts: now - 1_000 });
    const probe = ingest.probeLegacyHolders(home, wtA, {
      run: () => ({ ok: true, raw: porcelainFor([wtA]) }),
      now: () => now,
      isAlive: () => true,
      startTimeOf: () => null,
      isZombie: () => false,
    });
    assert.equal(probe.blocked, true, 'a freshly-refreshed lock is the shape of a genuinely looping daemon');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 2. sweepOrphanedIngestLocks
// ---------------------------------------------------------------------------

test('sweepOrphanedIngestLocks reaps DEAD-owner locks, PRESERVES a live-owner lock, and NEVER touches the lock this daemon is about to take', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const dir = ingest.ingestLocksDir(home);
    const dead1 = path.join(dir, 'ingest-project-alpha-aaaaaa.lock');
    const dead2 = path.join(dir, 'ingest-deadbeef.lock');
    const live = path.join(dir, 'ingest-project-beta-bbbbbb.lock');
    const mine = path.join(dir, 'ingest-project-mine-cccccc.lock');
    const foreign = path.join(dir, 'migrate.lock'); // owned by something else entirely
    writeLock(dead1, { pid: 111, ts: now - 60 * 60 * 1000 });
    writeLock(dead2, { pid: 222, ts: now - 60 * 60 * 1000 });
    writeLock(live, { pid: 333, ts: now - 1_000 });
    // The lock we hold deliberately records a DEAD pid: even so, skipPath must
    // win — the sweep may never remove the file this daemon depends on.
    writeLock(mine, { pid: 444, ts: now - 60 * 60 * 1000 });
    writeLock(foreign, { pid: 555, ts: now - 60 * 60 * 1000 });

    const res = ingest.sweepOrphanedIngestLocks(home, {
      now: () => now,
      isAlive: (pid) => pid === 333,
      startTimeOf: () => now - 2 * 60 * 60 * 1000,
      isZombie: () => false,
    }, mine);

    const reapedPaths = res.reaped.map((r) => r.lockPath).sort();
    assert.deepEqual(reapedPaths, [dead2, dead1].sort(), 'exactly the two dead-owner ingest locks were reaped');
    assert.equal(fs.existsSync(dead1), false);
    assert.equal(fs.existsSync(dead2), false);
    assert.ok(fs.existsSync(live), 'a CONFIRMED-live owner\'s lock is preserved');
    assert.ok(fs.existsSync(mine), 'the lock this daemon is about to take is never considered, whatever it records');
    assert.ok(fs.existsSync(foreign), 'a non-ingest lock in the same directory is out of scope');
    assert.equal(res.kept, 1, 'only the live-owner lock counts as kept (skipPath is never scanned)');
  } finally { rm(home); }
});

test('sweepOrphanedIngestLocks reaps a PID-REUSE orphan and a ZOMBIE owner, but not an unconfirmable one', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const dir = ingest.ingestLocksDir(home);
    const reused = path.join(dir, 'ingest-project-reuse-aaaaaa.lock');
    const zombie = path.join(dir, 'ingest-project-zomb-bbbbbb.lock');
    const unknown = path.join(dir, 'ingest-project-unk-cccccc.lock');
    writeLock(reused, { pid: 11, ts: now - 30 * 60 * 1000 });
    writeLock(zombie, { pid: 22, ts: now - 30 * 60 * 1000 });
    writeLock(unknown, { pid: 33, ts: now - 30 * 60 * 1000 });

    const res = ingest.sweepOrphanedIngestLocks(home, {
      now: () => now,
      isAlive: () => true, // all three read as "alive" via kill(pid,0)
      startTimeOf: (pid) => {
        if (pid === 11) return now - 10_000;          // born AFTER the lock -> recycled pid
        if (pid === 22) return now - 60 * 60 * 1000;  // consistent, but ...
        return null;                                   // pid 33: unknowable
      },
      isZombie: (pid) => pid === 22,                   // ... pid 22 is actually defunct
    }, null);

    const reasons = {};
    for (const r of res.reaped) reasons[r.pid] = r.reason;
    assert.deepEqual(reasons, { 11: 'reused', 22: 'zombie' });
    assert.equal(fs.existsSync(reused), false);
    assert.equal(fs.existsSync(zombie), false);
    assert.ok(fs.existsSync(unknown), 'an unconfirmable owner is never reaped — fail toward never deleting');
  } finally { rm(home); }
});

test('sweepOrphanedIngestLocks is IDEMPOTENT (a second run reaps nothing) and FAIL-OPEN on a malformed lock; a torn-stale lock is KEPT by default and only reaped with explicit allowTornStale', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const dir = ingest.ingestLocksDir(home);
    const dead = path.join(dir, 'ingest-project-x-aaaaaa.lock');
    const tornStale = path.join(dir, 'ingest-project-y-bbbbbb.lock');
    const tornFresh = path.join(dir, 'ingest-project-z-cccccc.lock');
    writeLock(dead, { pid: 111, ts: now - 60 * 60 * 1000 });
    fs.writeFileSync(tornStale, 'not json at all');
    fs.writeFileSync(tornFresh, ''); // 0-byte: the openSync('wx')->writeSync window
    const old = (now - 60 * 60 * 1000) / 1000;
    fs.utimesSync(tornStale, old, old);

    const io = { now: () => now, isAlive: () => false, startTimeOf: () => null, isZombie: () => false };

    // DEFAULT (no opts) — the shape of the AUTOMATIC per-daemon-start sweep:
    // a torn-stale lock has no provable holder identity (no pid at all), so
    // it must be KEPT, not reaped, by age alone. Only the confirmed-dead lock
    // is reaped.
    const first = ingest.sweepOrphanedIngestLocks(home, io, null);
    assert.equal(first.reaped.length, 1, 'only the confirmed-dead-owner lock is reaped by default');
    assert.equal(first.reaped[0].lockPath, dead);
    assert.ok(fs.existsSync(tornStale), 'a torn-stale lock (no provable holder identity) is KEPT by default, never auto-swept by age alone');
    assert.ok(fs.existsSync(tornFresh), 'a FRESH unparseable lock is presumed a live holder mid-write and preserved');

    const second = ingest.sweepOrphanedIngestLocks(home, io, null);
    assert.equal(second.reaped.length, 0, 'idempotent: a second default sweep has nothing left to reap');
    assert.ok(fs.existsSync(tornStale), 'still kept on the second default pass');
    assert.ok(fs.existsSync(tornFresh), 'still preserved on the second pass');

    // EXPLICIT allowTornStale — the shape of `doctor --reclaim-ingest-lock`
    // (human-invoked, opt-in only): now the torn-stale lock IS reaped.
    const explicit = ingest.sweepOrphanedIngestLocks(home, io, null, { allowTornStale: true });
    assert.equal(explicit.reaped.length, 1);
    assert.equal(explicit.reaped[0].reason, 'torn-stale');
    assert.equal(fs.existsSync(tornStale), false, 'explicit allowTornStale reclaims a torn-stale lock');
    assert.ok(fs.existsSync(tornFresh), 'a FRESH unparseable lock is still preserved even under explicit allowTornStale');
  } finally { rm(home); }
});

test('sweepOrphanedIngestLocks is fail-open when the locks directory does not exist at all', () => {
  const home = tmpHome();
  try {
    const res = ingest.sweepOrphanedIngestLocks(home, { now: () => Date.now() }, null);
    assert.deepEqual(res, { scanned: 0, kept: 0, reaped: [] });
  } finally { rm(home); }
});

test('sweepOrphanedIngestLocks never throws when readdir/unlink themselves fail (a sweep failure can never abort daemon startup)', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    writeLock(path.join(ingest.ingestLocksDir(home), 'ingest-project-x-aaaaaa.lock'), { pid: 1, ts: now - 60 * 60 * 1000 });
    const explodingFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'unlinkSync') return function () { throw new Error('EPERM (simulated)'); };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const res = ingest.sweepOrphanedIngestLocks(home, {
      fs: explodingFs, now: () => now, isAlive: () => false, startTimeOf: () => null, isZombie: () => false,
    }, null);
    assert.equal(res.reaped.length, 0, 'an unlink that fails is reported as not-reaped, never as an exception');
  } finally { rm(home); }
});

test('runIngestLoop sweeps orphaned locks BEFORE its first drain, while keeping its OWN lock', () => {
  const home = tmpHome();
  try {
    const wt = process.cwd(); // a real git worktree so the lock/hash keying resolves
    const ownLock = ingest.ingestLockPath(home, wt);
    const orphan = path.join(ingest.ingestLocksDir(home), 'ingest-project-other-aaaaaa.lock');
    writeLock(orphan, { pid: 4242, ts: Date.now() - 60 * 60 * 1000 });

    let monitorCalls = 0;
    let orphanExistedAtFirstDrain = null; // captured INSIDE the callback, not just at teardown — see below
    const summary = ingest.runIngestLoop({
      home, backend: 'journal', worktree: wt, maxIterations: 1,
      run: () => {
        monitorCalls++;
        // ORDERING PROOF: the vacuous version of this test only checked
        // fs.existsSync(orphan) AFTER runIngestLoop had already returned, which
        // passes identically whether the sweep runs before or after the drain
        // (or not at all, as long as it eventually happens). Capture the
        // orphan's existence AT THE MOMENT the first monitor call fires — this
        // is the only way to actually distinguish "swept before this drain"
        // from "swept sometime during/after the run".
        if (orphanExistedAtFirstDrain === null) orphanExistedAtFirstDrain = fs.existsSync(orphan);
        return { ok: true, raw: '[]' };
      },
      sleep: () => {},
      // isAlive:false makes the orphan's owner CONFIRMED dead deterministically;
      // skipLegacyProbe keeps this test focused on the sweep alone.
      io: { isAlive: () => false, startTimeOf: () => null, isZombie: () => false, skipLegacyProbe: true },
    });

    assert.equal(summary.started, true);
    assert.equal(monitorCalls, 1);
    assert.equal(orphanExistedAtFirstDrain, false, 'the orphan must already be gone by the time the FIRST monitor call fires — proves the sweep runs before the drain, not merely before the function returns');
    assert.equal(fs.existsSync(orphan), false, 'the dead-owner orphan from another project was reaped at startup');
    assert.equal(fs.existsSync(ownLock), false, 'our own lock existed during the run and was released at the end');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// 3. Zombie-aware refuse (acquireIngestLock)
// ---------------------------------------------------------------------------

test('acquireIngestLock RECLAIMS a lock held by a ZOMBIE (defunct) pid — kill(pid,0) calls it alive, but it can never run again', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const p = ingest.ingestLockPath(home);
    writeLock(p, { pid: 4242, ts: now - 1_000, token: 'zombie-holder' }); // FRESH lock — staleness plays no part
    let killed = false;
    const rel = ingest.acquireIngestLock(home, {
      now: () => now,
      isAlive: () => true,
      startTimeOf: () => now - 60 * 60 * 1000, // identity consistent: it really WAS our daemon
      isZombie: (pid) => pid === 4242,
      kill: () => { killed = true; },
    });
    assert.ok(rel, 'a defunct holder is dead — the lock is reclaimed');
    assert.equal(killed, false, 'a zombie is already dead; nothing is ever signalled');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).pid, process.pid);
    rel();
  } finally { rm(home); }
});

test('acquireIngestLock does NOT reclaim a live, NON-zombie holder (unchanged refusal)', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const p = ingest.ingestLockPath(home);
    writeLock(p, { pid: 4242, ts: now - 1_000, token: 'live-holder' });
    let killed = false;
    const rel = ingest.acquireIngestLock(home, {
      now: () => now,
      isAlive: () => true,
      startTimeOf: () => now - 60 * 60 * 1000,
      isZombie: () => false,
      kill: () => { killed = true; },
    });
    assert.equal(rel, null, 'a live consumer still refuses a second daemon');
    assert.equal(killed, false);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).token, 'live-holder', 'the live holder\'s lock is untouched');
  } finally { rm(home); }
});

test('acquireIngestLock does NOT reclaim when the zombie probe is INCONCLUSIVE (throws) — an unreadable process state is never proof of death', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const p = ingest.ingestLockPath(home);
    writeLock(p, { pid: 4242, ts: now - 1_000, token: 'live-holder' });
    const rel = ingest.acquireIngestLock(home, {
      now: () => now,
      isAlive: () => true,
      startTimeOf: () => now - 60 * 60 * 1000,
      isZombie: () => { throw new Error('probe unavailable'); },
      kill: () => { throw new Error('a kill must never be attempted here'); },
    });
    assert.equal(rel, null);
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).token, 'live-holder');
  } finally { rm(home); }
});

// P1 regression (v0.65 follow-up): the 'reused' verdict must ALSO require the
// lock to be stale before it authorizes removal — a live holder's lock is
// refreshed every loop iteration (release.heartbeat), so its ts is always
// fresh; a start-time reading that postdates a FRESH ts by more than
// PID_REUSE_TOLERANCE_MS is clock-skew noise (NTP slew, VM pause/resume — see
// that constant's own comment), not proof the pid was recycled, and must
// never unlink a live holder's lock.
test('acquireIngestLock does NOT reclaim a LIVE holder whose lock is FRESH (not stale) even when its reported start time postdates the lock ts beyond PID_REUSE_TOLERANCE_MS', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const p = ingest.ingestLockPath(home);
    const lockTs = now - 120_000; // 2 minutes old — well inside INGEST_LOCK_STALE_MS (15min): NOT stale
    writeLock(p, { pid: 4242, ts: lockTs, token: 'live-holder' });
    let killed = false;
    const rel = ingest.acquireIngestLock(home, {
      now: () => now,
      isAlive: () => true,
      // Postdates the lock ts by 61s (> PID_REUSE_TOLERANCE_MS=60s) but is
      // still <= now — exactly the false-positive shape a clock step/NTP
      // slew produces for a genuinely live, still-refreshing holder.
      startTimeOf: () => lockTs + 61_000,
      isZombie: () => false,
      kill: () => { killed = true; throw new Error('a kill must never be attempted here'); },
    });
    assert.equal(rel, null, 'a fresh (non-stale) lock must never be reclaimed on a bare reuse reading');
    assert.equal(killed, false);
    assert.equal(fs.existsSync(p), true, 'the live holder\'s lock file must still exist');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).token, 'live-holder', 'the live holder\'s lock is untouched');
  } finally { rm(home); }
});

test('sweepOrphanedIngestLocks LEAVES a live holder whose lock is FRESH but whose reported start time postdates it (reused-fresh is not sweepable) while still reaping a genuinely stale reuse orphan alongside it', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const dir = ingest.ingestLocksDir(home);
    const freshReuse = path.join(dir, 'ingest-project-freshreuse-aaaaaa.lock');
    const staleReuse = path.join(dir, 'ingest-project-stalereuse-bbbbbb.lock');
    const freshTs = now - 120_000;                 // 2min old -> NOT stale
    const staleTs = now - (STALE_MS + 60_000);     // past the window -> stale
    writeLock(freshReuse, { pid: 11, ts: freshTs });
    writeLock(staleReuse, { pid: 22, ts: staleTs });

    const res = ingest.sweepOrphanedIngestLocks(home, {
      now: () => now,
      isAlive: () => true,
      // Both postdate their lock ts by 61s (> PID_REUSE_TOLERANCE_MS); only the
      // STALE one may authorize removal.
      startTimeOf: (pid) => (pid === 11 ? freshTs + 61_000 : staleTs + 61_000),
      isZombie: () => false,
    }, null);

    const reapedPids = res.reaped.map((r) => r.pid);
    assert.deepEqual(reapedPids, [22], 'only the stale-lock reuse orphan is reaped');
    assert.ok(fs.existsSync(freshReuse), 'a FRESH lock must survive the sweep on a bare reuse reading — its holder may well be alive and still looping');
    assert.equal(fs.existsSync(staleReuse), false);
  } finally { rm(home); }
});

test('probeLegacyHolders: a live legacy holder with a FRESH lock whose reported start time postdates it STILL BLOCKS and is never removed (reused-fresh must not fall through to "no holder" — that would start a SECOND monitor consumer on the same destructive queue)', () => {
  const home = tmpHome();
  try {
    const wtA = '/repo/a';
    const wtB = '/repo/a-wt-b';
    const now = 1_700_000_000_000;
    const lockB = ingest.legacyIngestLockPath(home, wtB);
    const freshTs = now - 120_000; // refreshed 2min ago -> the shape of a LOOPING daemon
    writeLock(lockB, { pid: 4242, ts: freshTs });

    const probe = ingest.probeLegacyHolders(home, wtA, {
      run: () => ({ ok: true, raw: porcelainFor([wtA, wtB]) }),
      now: () => now,
      isAlive: () => true,
      startTimeOf: () => freshTs + 61_000, // postdates by > PID_REUSE_TOLERANCE_MS, still <= now
      isZombie: () => false,
    });

    assert.equal(probe.blocked, true, 'a fresh-lock holder must block whatever its reported start time says');
    assert.equal(probe.liveHolders.length, 1);
    assert.equal(probe.reaped.length, 0, 'nothing is removed on a fresh-lock reuse reading');
    assert.ok(fs.existsSync(lockB), 'the holder\'s lock file is left exactly as found');
  } finally { rm(home); }
});

// The other half of the contract: gating 'reused' on staleness must not have
// slowed down the two verdicts that are POSITIVE PROOF of death — neither can
// be faked by a live process, so both stay IMMEDIATE regardless of lock age.
test('a DEAD holder is still reclaimed IMMEDIATELY on a FRESH lock — by acquireIngestLock and by the sweep (staleness is not required for proven death)', () => {
  const home = tmpHome();
  try {
    const now = 1_700_000_000_000;
    const p = ingest.ingestLockPath(home);
    writeLock(p, { pid: 4242, ts: now - 1_000, token: 'dead-holder' }); // 1s old: as fresh as it gets
    let killed = false;
    const rel = ingest.acquireIngestLock(home, {
      now: () => now,
      isAlive: () => false, // the OS says there is no such process
      startTimeOf: () => null,
      isZombie: () => false,
      kill: () => { killed = true; },
    });
    assert.ok(rel, 'a confirmed-dead holder is reclaimed without waiting out the stale window');
    assert.equal(killed, false, 'nothing is signalled — the holder is already gone');
    assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).pid, process.pid);
    rel();

    const dir = ingest.ingestLocksDir(home);
    const deadFresh = path.join(dir, 'ingest-project-deadfresh-aaaaaa.lock');
    const zombieFresh = path.join(dir, 'ingest-project-zombfresh-bbbbbb.lock');
    writeLock(deadFresh, { pid: 11, ts: now - 1_000 });
    writeLock(zombieFresh, { pid: 22, ts: now - 1_000 });
    const res = ingest.sweepOrphanedIngestLocks(home, {
      now: () => now,
      isAlive: (pid) => pid === 22, // 11 is gone; 22 is "alive" per kill(pid,0) but defunct
      startTimeOf: () => now - 60 * 60 * 1000, // identity consistent — no reuse verdict in play
      isZombie: (pid) => pid === 22,
    }, p);
    const reasons = {};
    for (const r of res.reaped) reasons[r.pid] = r.reason;
    assert.deepEqual(reasons, { 11: 'dead', 22: 'zombie' }, 'both proofs of death are still immediate on a FRESH lock');
    assert.equal(fs.existsSync(deadFresh), false);
    assert.equal(fs.existsSync(zombieFresh), false);
  } finally { rm(home); }
});

// classifyLockHolder is the shared decision point — assert its contract directly
// so a future change to any one caller cannot quietly widen what may be removed.
test('classifyLockHolder: an OS start time LATER than our own clock is discarded, never used to justify a reuse verdict', () => {
  const now = 1_700_000_000_000;
  const cls = ingest.classifyLockHolder({ pid: 7, ts: 1000 }, now, {
    isAlive: () => true,
    startTimeOf: () => now + 60_000, // "started in the future" — a skewed/injected clock
    isZombie: () => false,
  });
  assert.notEqual(cls.state, 'reused', 'an implausible reading must never authorize removing a lock');
});

test('classifyLockHolder: a postdated start time on a FRESH lock classifies as reused-fresh (diagnostic only, never reclaimable) — on a STALE lock the same reading classifies as reused (reclaimable)', () => {
  const now = 1_700_000_000_000;
  const io = {
    isAlive: () => true,
    startTimeOf: (pid) => (pid === 1 ? now - 120_000 + 61_000 : now - 20 * 60 * 1000 + 61_000),
    isZombie: () => false,
  };
  const fresh = ingest.classifyLockHolder({ pid: 1, ts: now - 120_000 }, now, io); // 2min old lock: not stale
  assert.equal(fresh.state, 'reused-fresh');
  const stale = ingest.classifyLockHolder({ pid: 2, ts: now - 20 * 60 * 1000 }, now, io); // 20min old lock: stale
  assert.equal(stale.state, 'reused');
});

// The two centralized rules, asserted directly: a state may only be REMOVED if
// it is in RECLAIMABLE_HOLDER_STATES, and it may only stop BLOCKING if it is
// that or a record naming no live process. A future state added to
// classifyLockHolder without touching either list must therefore block and be
// left on disk — the fail-safe direction, by default, with no call site edit.
test('holder-state rules are default-safe: only dead/reused/zombie are reclaimable, and any unrecognized state both blocks and is unreclaimable', () => {
  assert.deepEqual(ingest.RECLAIMABLE_HOLDER_STATES.slice().sort(), ['dead', 'reused', 'zombie']);
  for (const s of ['live', 'torn-fresh', 'unconfirmed-stale', 'reused-fresh', 'some-future-state']) {
    assert.equal(ingest.isReclaimableHolderState(s), false, s + ' must never authorize removing a lock');
    assert.equal(ingest.isBlockingHolderState(s), true, s + ' must be treated as a holder');
  }
  for (const s of ['dead', 'reused', 'zombie']) {
    assert.equal(ingest.isReclaimableHolderState(s), true);
    assert.equal(ingest.isBlockingHolderState(s), false, s + ' is proven not a running consumer');
  }
  for (const s of ['none', 'torn-stale']) {
    assert.equal(ingest.isBlockingHolderState(s), false, s + ' names no live process');
    assert.equal(ingest.isReclaimableHolderState(s), false, s + ' authorizes no removal by itself');
  }
});

test('classifyLockHolder: an isAlive probe that THROWS reads as ALIVE (never as proof of death)', () => {
  const now = 1_700_000_000_000;
  const cls = ingest.classifyLockHolder({ pid: 7, ts: now - 1000 }, now, {
    isAlive: () => { throw new Error('probe exploded'); },
    startTimeOf: () => null,
    isZombie: () => false,
  });
  assert.equal(cls.state, 'live');
});

test('INGEST_LOCK_NAME_RE matches every ingest lock shape and nothing else', () => {
  for (const ok of ['ingest.lock', 'ingest-deadbeef.lock', 'ingest-project-my-repo-a1b2c3.lock']) {
    assert.ok(ingest.INGEST_LOCK_NAME_RE.test(ok), `${ok} should match`);
  }
  for (const no of ['migrate.lock', 'ingest.lock.hb.1234', 'ingest', 'store.lock', 'x-ingest.lock']) {
    assert.equal(ingest.INGEST_LOCK_NAME_RE.test(no), false, `${no} must NOT match`);
  }
});

// ---------------------------------------------------------------------------
// 4. In-band reaper detection (install-devswarm-ingest) — DETECT AND REPORT ONLY
// ---------------------------------------------------------------------------

const GUARD_WITHOUT_ALLOWLIST = [
  '#!/bin/bash',
  "MCP_ALLOWLIST='obsidian-mcp|@modelcontextprotocol'",
  'pkill -f node',
  'kill -9 "$pid"',
].join('\n');
const GUARD_WITH_ALLOWLIST = [
  '#!/bin/bash',
  "MCP_ALLOWLIST='obsidian-mcp|@modelcontextprotocol|devswarm-ingest'",
  'kill -9 "$pid"',
].join('\n');

function scriptsDirWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-reaper-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

test('detectReaperGuard: a killing guard WITHOUT the daemon allowlisted -> needsAction, naming the file and the allowlist variable', () => {
  const dir = scriptsDirWith({ 'claude-memguard.sh': GUARD_WITHOUT_ALLOWLIST });
  try {
    const d = installIngest.detectReaperGuard({ scriptsDir: dir });
    assert.equal(d.found, true);
    assert.equal(d.allowlisted, false);
    assert.equal(d.needsAction, true);
    assert.equal(d.file, path.join(dir, 'claude-memguard.sh'));
    assert.equal(d.allowlistVar, 'MCP_ALLOWLIST');
    const lines = installIngest.reaperWarningLines(d);
    assert.ok(lines.length > 0, 'it reports loudly');
    const text = lines.join('\n');
    assert.ok(text.includes(d.file), 'the message names the exact file');
    assert.ok(text.includes('MCP_ALLOWLIST'), 'the message names the variable to extend');
    assert.ok(text.includes('devswarm-ingest'), 'the message names the token to add');
    assert.ok(/PPID 1/.test(text), 'the message explains WHY the daemon is targeted');
  } finally { rm(dir); }
});

test('detectReaperGuard: a guard that ALREADY allowlists the daemon -> quiet', () => {
  const dir = scriptsDirWith({ 'claude-memguard.sh': GUARD_WITH_ALLOWLIST });
  try {
    const d = installIngest.detectReaperGuard({ scriptsDir: dir });
    assert.equal(d.found, true);
    assert.equal(d.allowlisted, true);
    assert.equal(d.needsAction, false);
    assert.deepEqual(installIngest.reaperWarningLines(d), []);
  } finally { rm(dir); }
});

// REGRESSION (found by running the detector against a real machine before
// shipping): an INCLUSION-model reaper kills only processes whose command line
// MATCHES its pattern — the ingest daemon never matches, so it is never a
// target and there is nothing to act on. Worse, the advice this warning gives
// ("add devswarm-ingest to the allowlist") would, applied to an inclusion
// pattern, turn a harmless script into one that hunts this daemon. Silence is
// the only correct output. The presence of a named ALLOWLIST variable is what
// distinguishes the dangerous exclusion model from this one.
const INCLUSION_REAPER = [
  '#!/bin/bash',
  "MCP_RE='obsidian-mcp|@modelcontextprotocol|firebase mcp'",
  'ps -axo pid,ppid,command | grep -iE "$MCP_RE" | awk \'$2==1 {print $1}\' | while read pid; do',
  '  kill -KILL "$pid"',
  'done',
].join('\n');

test('detectReaperGuard: an INCLUSION-model reaper (kills only what MATCHES its pattern, no allowlist) is silent — it can never target this daemon', () => {
  const dir = scriptsDirWith({ 'claude-mcp-reaper.sh': INCLUSION_REAPER });
  try {
    const d = installIngest.detectReaperGuard({ scriptsDir: dir });
    assert.equal(d.found, false, 'an inclusion-model reaper is not a threat to this daemon');
    assert.equal(d.needsAction, false);
    assert.deepEqual(installIngest.reaperWarningLines(d), [],
      'never advise adding the daemon to a pattern that would make it a KILL target');
  } finally { rm(dir); }
});

test('detectReaperGuard: no reaper at all (and a same-named script that kills nothing) -> quiet', () => {
  const empty = scriptsDirWith({ 'unrelated.sh': '#!/bin/bash\necho hi\n' });
  const harmless = scriptsDirWith({ 'claude-memcheck.sh': '#!/bin/bash\nps -axo pid,command | wc -l\n' });
  try {
    for (const dir of [empty, harmless]) {
      const d = installIngest.detectReaperGuard({ scriptsDir: dir });
      assert.equal(d.found, false, `${dir} must not register as a reaper`);
      assert.equal(d.needsAction, false);
      assert.deepEqual(installIngest.reaperWarningLines(d), []);
    }
  } finally { rm(empty); rm(harmless); }
});

test('detectReaperGuard: a missing scripts directory, and an unreadable file, are silent (fail-open)', () => {
  const missing = installIngest.detectReaperGuard({ scriptsDir: path.join(os.tmpdir(), 'anti-hall-no-such-dir-' + process.pid) });
  assert.equal(missing.found, false);
  assert.equal(missing.needsAction, false);

  const dir = scriptsDirWith({ 'claude-memguard.sh': GUARD_WITHOUT_ALLOWLIST });
  try {
    const explodingFs = new Proxy(fs, {
      get(target, prop) {
        if (prop === 'readFileSync') return function () { throw new Error('EACCES (simulated)'); };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const d = installIngest.detectReaperGuard({ scriptsDir: dir, fsi: explodingFs });
    assert.equal(d.found, false, 'an unreadable guard yields no claim at all');
    assert.deepEqual(installIngest.reaperWarningLines(d), []);
  } finally { rm(dir); }
});

test('detectReaperGuard ignores *.bak backups (only the LIVE guard is actionable) and reports the WORST case when several guards exist', () => {
  const dir = scriptsDirWith({
    'claude-memguard.sh.bak-20260724': GUARD_WITHOUT_ALLOWLIST, // a backup must never be reported
    'claude-memguard.sh': GUARD_WITH_ALLOWLIST,
  });
  try {
    const d = installIngest.detectReaperGuard({ scriptsDir: dir });
    assert.equal(d.file, path.join(dir, 'claude-memguard.sh'), 'the live guard, not the backup');
    assert.equal(d.needsAction, false);
  } finally { rm(dir); }

  const dir2 = scriptsDirWith({
    'claude-memguard.sh': GUARD_WITH_ALLOWLIST,
    'claude-mcp-reaper.sh': GUARD_WITHOUT_ALLOWLIST,
  });
  try {
    const d = installIngest.detectReaperGuard({ scriptsDir: dir2 });
    assert.equal(d.needsAction, true, 'one protective guard must not mask a second, unprotective one');
    assert.equal(d.file, path.join(dir2, 'claude-mcp-reaper.sh'));
  } finally { rm(dir2); }
});

test('detectReaperGuard NEVER modifies the script it inspects (detect-and-report only)', () => {
  const dir = scriptsDirWith({ 'claude-memguard.sh': GUARD_WITHOUT_ALLOWLIST });
  try {
    const before = fs.readFileSync(path.join(dir, 'claude-memguard.sh'), 'utf8');
    installIngest.detectReaperGuard({ scriptsDir: dir });
    installIngest.reaperWarningLines(installIngest.detectReaperGuard({ scriptsDir: dir }));
    assert.equal(fs.readFileSync(path.join(dir, 'claude-memguard.sh'), 'utf8'), before, 'byte-for-byte unchanged');
    assert.deepEqual(fs.readdirSync(dir), ['claude-memguard.sh'], 'no file was created either');
  } finally { rm(dir); }
});
