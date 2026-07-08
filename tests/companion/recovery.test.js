'use strict';
// recovery: confirm-gated precise kill + TOCTOU re-confirm + group-kill +
// single-writer stale-steal lock + DETACHED resume + N-cap escalate. ALL
// kill/spawn/lock/fs/reconfirm is injected — NO real process is ever touched. The
// load-bearing assertions: never broad-kill, abstain on ambiguity, re-confirm
// before EACH signal (pid-recycle defense), group-signal children, escalate after
// N, single-writer with dead-holder steal, Windows never kills, a timed-out resume
// is never falsely marked alive. Workaround for #39755.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'recovery.js',
));
const { livenessPathFor } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-recovery-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptor(home) {
  const worktreePath = path.join(home, 'wt');
  fs.mkdirSync(worktreePath, { recursive: true });
  const inboxPath = path.join(worktreePath, 'inbox.ndjson');
  const cursorPath = path.join(worktreePath, 'cursor');
  fs.writeFileSync(inboxPath, JSON.stringify({ m: 'do the thing' }) + '\n');
  fs.writeFileSync(cursorPath, '0');
  return { id: 'w1', worktreePath, inboxPath, cursorPath, sessionId: UUID };
}
// A spy io: records single-pid kills, GROUP kills, and spawn calls. kill(pid,0)
// reports alive until told otherwise. reconfirm defaults TRUE (identity holds).
function spyIo(overrides) {
  const killed = [];   // single-pid signals: [pid, signal]
  const groups = [];   // process-group signals: [pid, signal]
  const spawns = [];
  const io = Object.assign({
    platform: 'darwin',
    selfPid: 999999,
    sleep: () => {},
    reconfirm: () => true,
    kill: (pid, signal) => { killed.push([pid, signal]); return signal === 0 ? false : true; }, // dead after SIGTERM
    killGroup: (pid, signal) => { groups.push([pid, signal]); return true; },
    spawnResume: (a) => { spawns.push(a); return { output: 'ok', status: 0 }; },
  }, overrides || {});
  return { io, killed, groups, spawns };
}

test('ABSTAIN target -> never kills; writes ambiguous verdict + logs', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups } = spyIo();
    const r = M.recover({ descriptor: d, target: { ambiguous: true, reason: 'multiple-candidates' }, home, io });
    assert.strictEqual(r.action, 'abstain');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(groups.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'ambiguous');
    assert.ok(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'recovery.log'), 'utf8').includes('abstain'));
  } finally { cleanup(); }
});

test('Windows: escalate-only, never kills regardless of target', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups } = spyIo({ platform: 'win32' });
    const r = M.recover({ descriptor: d, target: { pid: 123, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'win32-no-kill');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(groups.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('happy path: SIGTERM the ONE pid + its GROUP, resume, increment recoveries', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups, spawns } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 555, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'resumed');
    assert.strictEqual(r.recoveries, 1);
    // exactly one pid targeted; SIGTERM then alive-check (signal 0). No SIGKILL (died on TERM).
    assert.deepStrictEqual(killed.map((k) => k[0]), [555, 555]);
    assert.deepStrictEqual(killed.map((k) => k[1]), ['SIGTERM', 0]);
    // P0-5: the process GROUP is signaled alongside the parent (children not orphaned).
    assert.deepStrictEqual(groups, [[555, 'SIGTERM']]);
    // A timed-out/unconfirmed resume is never marked 'alive' — status stays 'recovering'.
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'recovering');
    assert.ok(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).recoveredAt > 0);
    // resume from the worktree cwd, backlog fed as prompt.
    assert.strictEqual(spawns.length, 1);
    assert.strictEqual(spawns[0].cwd, d.worktreePath);
    assert.strictEqual(spawns[0].uuid, UUID);
    assert.ok(spawns[0].prompt.includes('do the thing'));
  } finally { cleanup(); }
});

test('SIGKILL + group-SIGKILL only when the pid survives the grace window', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    // kill(pid,0) reports alive -> forces the SIGKILL branch.
    const { io, killed, groups } = spyIo({ kill: (pid, signal) => { killed.push([pid, signal]); return true; } });
    M.recover({ descriptor: d, target: { pid: 42, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.deepStrictEqual(killed.map((k) => k[1]), ['SIGTERM', 0, 'SIGKILL']);
    assert.ok(killed.every((k) => k[0] === 42)); // NEVER any pid but the target
    assert.deepStrictEqual(groups, [[42, 'SIGTERM'], [42, 'SIGKILL']]);
  } finally { cleanup(); }
});

test('TOCTOU pre-SIGTERM: identity gone on fresh data -> ABSTAIN, no signal at all', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, killed, groups } = spyIo({ reconfirm: () => false }); // re-derive fails immediately
    const r = M.recover({ descriptor: d, target: { pid: 77, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'abstain');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(groups.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'ambiguous');
  } finally { cleanup(); }
});

test('TOCTOU pre-SIGKILL: pid recycled during the grace window -> NO SIGKILL (abstain)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    let calls = 0;
    const { io, killed, groups } = spyIo({
      kill: (pid, signal) => { killed.push([pid, signal]); return true; }, // always "alive" -> reaches pre-kill re-confirm
      reconfirm: () => { calls += 1; return calls === 1; },               // ok before SIGTERM, GONE before SIGKILL
    });
    const r = M.recover({ descriptor: d, target: { pid: 88, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'abstain');
    // SIGTERM (and its group) happened; the alive-check happened; but NO SIGKILL.
    assert.deepStrictEqual(killed.map((k) => k[1]), ['SIGTERM', 0]);
    assert.ok(!killed.some((k) => k[1] === 'SIGKILL'), 'must not SIGKILL a recycled pid');
    assert.deepStrictEqual(groups, [[88, 'SIGTERM']]);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'ambiguous');
  } finally { cleanup(); }
});

test('DETACHED resume that outlives the readiness window is NOT killed and NOT marked alive', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    // spawnResume reports the child is still running (timedOut) with no early output.
    const { io, killed } = spyIo({ spawnResume: (a) => ({ pid: 4242, timedOut: true, output: '' }) });
    const r = M.recover({ descriptor: d, target: { pid: 5, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'resumed');
    assert.strictEqual(r.recoveries, 1);
    // the long-running resumed child (pid 4242) is NEVER signaled by recovery.
    assert.ok(!killed.some((k) => k[0] === 4242), 'resumed child must not be killed');
    // unconfirmed resume -> status 'recovering' (+recoveredAt), never a false 'alive'.
    const v = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(v.status, 'recovering');
    assert.ok(v.recoveredAt > 0);
  } finally { cleanup(); }
});

test('"No conversation found" -> expected escalate, not thrown', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io } = spyIo({ spawnResume: () => ({ output: 'No conversation found', status: 1 }) });
    const r = M.recover({ descriptor: d, target: { pid: 7, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'no-conversation-found');
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('escalate after N recoveries (cap)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'liveness'), { recursive: true });
    fs.writeFileSync(livenessPathFor('w1', home), JSON.stringify({ status: 'stale', lastOutboundTs: 1, staleSince: 1, recoveries: 3 }));
    const { io, killed } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 9, uuid: UUID, worktreePath: d.worktreePath }, home, io, maxRecoveries: 3 });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'max-recoveries');
    assert.strictEqual(killed.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('single-writer: a live-holder lock -> second attempt skips (no kill)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    // Hold the lock by calling acquireLock directly; do not release. The holder pid
    // is THIS live process, so recovery must respect it (no dead-holder steal).
    const held = M.acquireLock('w1', home, { fs });
    assert.ok(held, 'first lock must succeed');
    const { io, killed } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 3, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'skip');
    assert.strictEqual(r.reason, 'locked');
    assert.strictEqual(killed.length, 0);
    held(); // release
  } finally { cleanup(); }
});

test('acquireLock: a DEAD-holder lock is stolen; a LIVE-holder lock is respected', () => {
  const { home, cleanup } = makeHome();
  try {
    const p = M.lockPathFor('w1', home);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Pre-write a lock owned by a (pretend) DEAD holder, fresh timestamp.
    fs.writeFileSync(p, JSON.stringify({ pid: 4242, ts: Date.now() }));
    const stolen = M.acquireLock('w1', home, { fs, isAlive: () => false });
    assert.ok(stolen, 'dead-holder lock must be stealable (crash must not disable recovery)');
    stolen();
    // Pre-write a lock owned by a LIVE holder, fresh timestamp -> must NOT steal.
    fs.writeFileSync(p, JSON.stringify({ pid: 4243, ts: Date.now() }));
    const blocked = M.acquireLock('w1', home, { fs, isAlive: () => true });
    assert.strictEqual(blocked, null, 'a live, fresh holder must be respected');
  } finally { cleanup(); }
});

test('fail-open: a throwing spawnResume -> error result, never throws out', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io } = spyIo({ spawnResume: () => { throw new Error('boom'); } });
    const r = M.recover({ descriptor: d, target: { pid: 1, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'error');
  } finally { cleanup(); }
});
