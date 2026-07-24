'use strict';
// devswarm-ingest-selfheal.test.js — B1 daemon self-heal hardening.
//
// H2 (devswarm-ingest.js acquireIngestLock): a LIVE lock holder was
// PREVIOUSLY never reclaimable no matter how wedged it actually was — a
// daemon blocked forever inside a hung child spawnSync (H3) could never be
// restarted, since SIGTERM cannot be delivered to a process whose event loop
// is blocked in a synchronous call. This file proves the new heartbeat-aware
// steal: a LIVE holder whose OWN daemon liveness heartbeat is positively
// confirmed STALE is SIGKILLed and the lock reclaimed; a LIVE holder with a
// FRESH heartbeat (busy-but-live) is left alone exactly as before; a
// confirmed-DEAD holder is reclaimed exactly as before (unaffected by the new
// branch). Every kill is injected (io.kill) — no real process is ever
// SIGKILLed by this file.
//
// H4 (hooks/devswarm-parent-inbox.js): readSummary() only reads the store's
// MATERIALIZED cache (summaries/<repoKey>.json). When the ingest daemon is
// down, nothing refreshes that cache — this file proves the hook now
// refreshes the projection itself (via the SAME store.deriveSummary(s,
// {home}) call devswarm-child-turn.js's registerStoreDescriptor already
// makes) when daemonHealth() reports NOT healthy, and skips that refresh
// (leaving the cache as read) when the daemon IS healthy — the hook is spawned
// as a real child process (spawn-hook.js) since its own top-level `main();
// process.exit(0);` runs unconditionally on require().

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ingest = require('../../plugins/anti-hall/companion/devswarm-ingest.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const ingestHealth = require('../../plugins/anti-hall/companion/lib/ingest-health.js');
const repokey = require('../../plugins/anti-hall/companion/lib/devswarm-repokey.js');
const { testHook } = require('../helpers/spawn-hook.js');
const { makeHome } = require('../helpers/fixtures.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-ingest-selfheal-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(home) { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }

// A real git worktree (this repo checkout) so repoKeyForWorktree resolves the
// SAME hash both acquireIngestLock's steal-check and ingestHeartbeatPath use —
// mirrors the existing devswarm-ingest.test.js heartbeat tests' own pattern.
const WT = process.cwd();
const HASH = repokey.repoKeyForWorktree(WT);

// ---------------------------------------------------------------------------
// H2 — acquireIngestLock heartbeat-aware steal
// ---------------------------------------------------------------------------

test('H2 (a): LIVE holder with a STALE OWN heartbeat is SIGKILLed and the lock reclaimed', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    // Lock ts is ALSO stale — a genuinely wedged daemon can't run ANY part of
    // its loop body (including the release.heartbeat() lock-ts refresh), so
    // both signals go stale together. The steal requires BOTH stale (P0 fix:
    // a fresh lock ts alone must block the kill — see acquireIngestLock's
    // comment on this branch) rather than the heartbeat file alone, otherwise
    // a healthy daemon whose separate heartbeat WRITE happens to fail (but
    // which keeps refreshing its lock ts fine) would get wrongly SIGKILLed.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 987654, ts: now - 20 * 60 * 1000, token: 'wedged' }));

    const hbPath = ingest.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    // Stale by well over INGEST_LOCK_STALE_MS (15min): the daemon's own event
    // loop has not run its per-sweep heartbeat write in 20 minutes -> wedged.
    fs.writeFileSync(hbPath, JSON.stringify({ ts: now - 20 * 60 * 1000, pid: 987654 }));

    let killedPid = null;
    let killedSig = null;
    const io = {
      isAlive: (pid) => pid === 987654, // report the holder as LIVE
      now: () => now,
      kill: (pid, sig) => { killedPid = pid; killedSig = sig; }, // injected — never a real kill
      // PID-identity confirmation: the OS reports this pid as having started
      // WELL BEFORE the heartbeat's own ts — i.e. it plausibly IS the same
      // process that wrote that heartbeat (genuinely wedged), not a pid the
      // OS later recycled to an unrelated process. Real production code asks
      // the OS for this; the test injects it since pid 987654 is not a real
      // running process on the test machine.
      startTimeOf: (pid) => (pid === 987654 ? (now - 60 * 60 * 1000) : null),
    };

    const rel = ingest.acquireIngestLock(home, io, WT);
    assert.ok(rel, 'the lock is reclaimed once the wedged holder is killed');
    assert.equal(killedPid, 987654, 'the wedged holder pid was the kill target');
    assert.equal(killedSig, 'SIGKILL', 'SIGTERM cannot land on a wedged event loop -> SIGKILL is used');
    // The reclaimed lock is genuinely usable afterward.
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(held.pid, process.pid);
    rel();
  } finally { rm(home); }
});

test('H2 (a1): FRESH lock ts + STALE own-heartbeat is NEVER killed — a healthy, actively-looping daemon whose SEPARATE heartbeat write happens to fail must not be SIGKILLed', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    // Lock ts is FRESH — release.heartbeat() is refreshing it every loop
    // iteration, proving the daemon is genuinely alive and NOT wedged.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 987654, ts: now - 1000, token: 'healthy' }));

    const hbPath = ingest.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    // The SEPARATE daemon heartbeat file is stale — e.g. its write target
    // became unwritable — but this alone must never be read as "wedged" when
    // the lock ts (refreshed by the very same live loop) is fresh.
    fs.writeFileSync(hbPath, JSON.stringify({ ts: now - 20 * 60 * 1000, pid: 987654 }));

    let killed = false;
    const io = {
      isAlive: (pid) => pid === 987654,
      now: () => now,
      kill: () => { killed = true; },
      startTimeOf: (pid) => (pid === 987654 ? (now - 60 * 60 * 1000) : null),
    };

    const rel = ingest.acquireIngestLock(home, io, WT);
    assert.equal(rel, null, 'a fresh lock ts must refuse the steal even when the separate heartbeat file is stale');
    assert.equal(killed, false, 'a healthy, actively-refreshing daemon must never be SIGKILLed over a broken heartbeat WRITE alone');
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(held.pid, 987654, 'the live holder\'s lock record is untouched');
  } finally { rm(home); }
});

test('H2 (a2): PID-REUSE GUARD — a stale heartbeat matching the holder pid is NOT enough to kill when the pid started AFTER the heartbeat was last written (likely a recycled pid, not the original daemon)', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 987654, ts: now - 20 * 60 * 1000, token: 'wedged' }));

    const hbTs = now - 20 * 60 * 1000; // stale by well over INGEST_LOCK_STALE_MS
    const hbPath = ingest.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: hbTs, pid: 987654 }));

    let killed = false;
    const io = {
      isAlive: (pid) => pid === 987654, // the OS now reports THIS pid as alive again
      now: () => now,
      kill: () => { killed = true; },
      // This pid's OS-reported start time is AFTER the stale heartbeat's own
      // ts — it cannot be the process that wrote that heartbeat. The original
      // daemon died and leaked its lock+heartbeat; the OS later handed this
      // SAME pid number to an unrelated live process.
      startTimeOf: () => now - 500,
    };

    const rel = ingest.acquireIngestLock(home, io, WT);
    assert.equal(rel, null, 'a pid whose start time postdates the heartbeat is never treated as the original (possibly-wedged) holder');
    assert.equal(killed, false, 'no kill is ever attempted against a pid that could not have written this heartbeat');
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(held.pid, 987654, 'the lock record is untouched — never stolen from an unconfirmed holder');
  } finally { rm(home); }
});

test('H2 (a3): HEARTBEAT-PID MISMATCH — a stale heartbeat recorded under a DIFFERENT pid than the current lock holder is never used as evidence against that holder', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    // The CURRENT lock holder is 424242 (live, healthy).
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, ts: now - 20 * 60 * 1000, token: 'healthy' }));

    // The heartbeat file for this hash carries a STALE record for an entirely
    // DIFFERENT pid (111111) — e.g. left over from a prior daemon instance.
    const hbPath = ingest.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: now - 20 * 60 * 1000, pid: 111111 }));

    let killed = false;
    const io = {
      isAlive: (pid) => pid === 424242,
      now: () => now,
      kill: () => { killed = true; },
      startTimeOf: () => now - 60 * 60 * 1000,
    };

    const rel = ingest.acquireIngestLock(home, io, WT);
    assert.equal(rel, null, 'a stale heartbeat for a DIFFERENT pid must never condemn the current live holder');
    assert.equal(killed, false, 'the live, healthy holder (424242) is never killed based on an unrelated pid\'s stale heartbeat');
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(held.pid, 424242, 'the live holder\'s lock record is untouched');
  } finally { rm(home); }
});

test('H2 (b): LIVE holder with a FRESH OWN heartbeat is NEVER killed (busy-but-live, refused as before)', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    // Lock ts LOOKS stale (an hour old) on its own — proves the fresh
    // heartbeat, not the lock ts, is what gates the refusal here.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, ts: now - 60 * 60 * 1000, token: 'busy' }));

    const hbPath = ingest.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: now - 5000, pid: 424242 })); // fresh

    let killed = false;
    const io = {
      isAlive: (pid) => pid === 424242,
      now: () => now,
      kill: () => { killed = true; },
    };

    const rel = ingest.acquireIngestLock(home, io, WT);
    assert.equal(rel, null, 'a fresh-heartbeat live holder is never stolen');
    assert.equal(killed, false, 'no kill is ever attempted against a busy-but-live daemon');
    // The original holder's lock record is untouched.
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(held.pid, 424242);
  } finally { rm(home); }
});

test('H2 (b-cont): LIVE holder with NO heartbeat file at all is ALSO never killed (fail toward never-kill on an inconclusive read)', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 55555, ts: now - 60 * 60 * 1000, token: 'busy' }));
    // No heartbeat file written for HASH at all.

    let killed = false;
    const io = { isAlive: (pid) => pid === 55555, now: () => now, kill: () => { killed = true; } };
    const rel = ingest.acquireIngestLock(home, io, WT);
    assert.equal(rel, null, 'an unreadable/missing heartbeat can never PROVE wedged -> never stolen');
    assert.equal(killed, false, 'no kill on an inconclusive heartbeat read');
  } finally { rm(home); }
});

test('H2 (c): confirmed-DEAD pid is reclaimed exactly as before (H2 does not regress the pre-existing dead-holder path)', () => {
  const home = tmpHome();
  try {
    const rel1 = ingest.acquireIngestLock(home, { isAlive: () => false, now: () => Date.now() });
    assert.ok(rel1, 'first holder acquires');
    // No release() call — simulates a crashed process leaking its lock.
    let killed = false;
    const rel2 = ingest.acquireIngestLock(home, {
      isAlive: () => false, // confirmed dead
      now: () => Date.now() + 1000,
      kill: () => { killed = true; },
    });
    assert.ok(rel2, 'a confirmed-dead holder is reclaimed immediately, same as before H2');
    assert.equal(killed, false, 'a confirmed-dead holder is reclaimed via the pre-existing path, never killed (it is already dead)');
    rel2();
  } finally { rm(home); }
});

test('H2: acquireIngestLock never throws when io.kill itself throws (fail-open around the new kill call)', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 111222, ts: now - 20 * 60 * 1000, token: 'wedged' }));
    const hbPath = ingest.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: now - 20 * 60 * 1000, pid: 111222 }));

    const io = {
      isAlive: (pid) => pid === 111222,
      now: () => now,
      kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); },
      startTimeOf: () => now - 60 * 60 * 1000,
    };
    let rel;
    assert.doesNotThrow(() => { rel = ingest.acquireIngestLock(home, io, WT); },
      'a kill-call failure (e.g. the pid already exited) must not crash lock acquisition');
    assert.ok(rel, 'ESRCH means the pid was already gone before our SIGKILL -> still safe to reclaim');
    rel();
  } finally { rm(home); }
});

test('H2: a kill error OTHER than ESRCH (e.g. EPERM) REFUSES reclamation — the lock is NOT deleted while the holder may still be alive', () => {
  const home = tmpHome();
  try {
    const lockPath = ingest.ingestLockPath(home, WT);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 111333, ts: now - 20 * 60 * 1000, token: 'wedged' }));
    const hbPath = ingest.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: now - 20 * 60 * 1000, pid: 111333 }));

    const io = {
      isAlive: (pid) => pid === 111333,
      now: () => now,
      kill: () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); },
      startTimeOf: () => now - 60 * 60 * 1000,
    };
    let rel;
    assert.doesNotThrow(() => { rel = ingest.acquireIngestLock(home, io, WT); },
      'a kill-call failure must never crash lock acquisition');
    assert.equal(rel, null, 'an EPERM (or any non-ESRCH) kill error means the holder may still be alive -> refuse, never reclaim unconditionally');
    const held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(held.pid, 111333, 'the lock file is left intact — a contender must never acquire a second concurrent lock on top of a possibly-still-alive holder');
  } finally { rm(home); }
});

// ---------------------------------------------------------------------------
// H4 — devswarm-parent-inbox.js refreshes the projection when the daemon is
// unhealthy, and leaves it alone when healthy. Spawned as a real child
// process (the hook's own `main(); process.exit(0);` runs unconditionally on
// require(), so it cannot be required in-process).
// ---------------------------------------------------------------------------

const PRIMARY_ENV = { DEVSWARM_REPO_ID: 'repo-1' };
function payload() {
  return { hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hi', cwd: WT };
}
function summaryPath(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'summaries', HASH + '.json');
}

// seedStoreRegistryRow(home, id) — write ONE real registry row + one message
// into this project's shared (repoKey-keyed) store. Deliberately does NOT
// force a backend: devswarm-parent-inbox.js's own openStore call (the H4
// fallback) doesn't force one either, so both sides must resolve the SAME
// default (env.ANTIHALL_DEVSWARM_STORE_BACKEND, else sqlite when available,
// else journal — devswarm-store.js's selectBackend) or they'd silently open
// two DIFFERENT physical stores and this seed would never be visible to the
// hook. This is the "hasRows" precondition the H4 fallback's non-destructive
// guard requires before it will call deriveSummary at all.
function seedStoreRegistryRow(home, id) {
  const s = storeLib.openStore({ home, workspaceId: id, hash: HASH });
  try {
    s.upsertRegistry({
      id, worktreePath: WT, sessionId: null, inboxPath: null, cursorPath: null, nudgeCommand: null,
    });
    s.appendMessage({ workspaceId: id, body: 'hello', hash: 'h1', ts: Date.now() });
  } finally { s.close(); }
}

test('H4: daemonHealth NOT healthy (no heartbeat/lock) -> the hook refreshes summary.json from the store before reading it', () => {
  const h = makeHome();
  const home = h.home;
  try {
    seedStoreRegistryRow(home, 'child-selfheal-a');
    // No heartbeat/lock files written for HASH at all -> daemonHealth() is
    // 'stale' (not healthy). No summary.json exists yet either.
    assert.ok(!fs.existsSync(summaryPath(home)), 'precondition: no cached summary.json yet');

    const r = testHook('devswarm-parent-inbox.js', payload(), { home, env: PRIMARY_ENV, expectJson: true });
    assert.equal(r.status, 0);

    assert.ok(fs.existsSync(summaryPath(home)), 'the hook derived+wrote summary.json itself (H4 fallback fired)');
    const summary = JSON.parse(fs.readFileSync(summaryPath(home), 'utf8'));
    assert.ok(summary.workspaces && summary.workspaces['child-selfheal-a'],
      'the freshly-derived summary reflects the store row that was never drained by any (dead) daemon');
    assert.equal(summary.workspaces['child-selfheal-a'].total, 1);
  } finally { rm(home); }
});

test('H4: daemonHealth healthy (fresh heartbeat + live lock) -> the hook does NOT touch the store / summary.json', () => {
  const h = makeHome();
  const home = h.home;
  try {
    seedStoreRegistryRow(home, 'child-selfheal-b');
    assert.ok(!fs.existsSync(summaryPath(home)), 'precondition: no cached summary.json yet');

    // Make daemonHealth() report 'healthy': a fresh heartbeat + a lock held by
    // a REAL, currently-alive pid (this test process's own pid — the hook's
    // own daemonHealth call has no injectable isAlive, so it uses the real
    // process.kill(pid,0) probe).
    const hbPath = ingestHealth.ingestHeartbeatPath(home, HASH);
    fs.mkdirSync(path.dirname(hbPath), { recursive: true });
    fs.writeFileSync(hbPath, JSON.stringify({ ts: Date.now() - 1000, pid: process.pid }));
    const lockPath = ingestHealth.ingestProjectLockPath(home, HASH);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: Date.now(), token: 'healthy' }));

    const r = testHook('devswarm-parent-inbox.js', payload(), { home, env: PRIMARY_ENV, expectJson: true });
    assert.equal(r.status, 0);

    assert.ok(!fs.existsSync(summaryPath(home)),
      'a HEALTHY daemon means the hook must never call deriveSummary itself (no summary.json materialized by this run)');
  } finally { rm(home); }
});

test('H4: an EMPTY store (no registry rows at all) is never derived over an existing cache (non-destructive guard)', () => {
  const h = makeHome();
  const home = h.home;
  try {
    // Seed a summary.json DIRECTLY (as if written by some prior, now-orphaned
    // process) with NO backing store rows at all — the store for HASH is never
    // opened/created by this test. daemonHealth is 'stale' (no heartbeat/lock).
    const dir = path.dirname(summaryPath(home));
    fs.mkdirSync(dir, { recursive: true });
    const seeded = { generatedAt: Date.now(), requiredGates: [], workspaces: { 'preexisting': { id: 'preexisting', total: 3, cursor: 0, unread: 3, worktreePath: WT, gates: {}, archive_ready: false } }, recent: [] };
    fs.writeFileSync(summaryPath(home), JSON.stringify(seeded));

    const r = testHook('devswarm-parent-inbox.js', payload(), { home, env: PRIMARY_ENV, expectJson: true });
    assert.equal(r.status, 0);

    const after = JSON.parse(fs.readFileSync(summaryPath(home), 'utf8'));
    assert.ok(after.workspaces && after.workspaces.preexisting,
      'an empty-store fallback must never overwrite a pre-existing cache with nothing — the seeded entry must survive');
    assert.equal(after.workspaces.preexisting.total, 3);
  } finally { rm(home); }
});
