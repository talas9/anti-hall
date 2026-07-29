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
const cp = require('node:child_process');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'recovery.js',
));
const { livenessPathFor } = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
));
const storeLib = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-store.js',
));
const inst = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'install-devswarm-ingest.js',
));
const repokeyLib = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-repokey.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-recovery-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
// makeGitRepo(tag) — a REAL git repo, so repoKeyForWorktree (devswarm-repokey.js)
// resolves non-null. Mirrors tests/companion/install-ingest-repokey.test.js /
// tests/scripts/devswarm-fold-mesh.test.js's own local copy of this helper.
function makeGitRepo(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-recovery-repo-' + tag + '-'));
  cp.spawnSync('git', ['init', '-q', dir]);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  cp.spawnSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), tag);
  cp.spawnSync('git', ['-C', dir, 'add', '.']);
  cp.spawnSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return dir;
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

test('resume prompt PREPENDS the state-check guardrail before the backlog', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io, spawns } = spyIo();
    M.recover({ descriptor: d, target: { pid: 555, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(spawns.length, 1);
    assert.ok(spawns[0].prompt.startsWith(M.RESUME_GUARDRAIL), 'guardrail must be prepended');
    assert.ok(spawns[0].prompt.includes('do the thing'), 'backlog still included after the guardrail');
  } finally { cleanup(); }
});

test('pokeOrEscalate: nudgeCommand fires, persists `nudged` + nudgeAttempts, logs — NEVER a kill', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = Object.assign(descriptor(home), { nudgeCommand: ['echo', 'wake-up'] });
    const nudges = [];
    const killed = [];
    const io = { nudge: (cmd) => { nudges.push(cmd); }, kill: (...a) => killed.push(a), killGroup: (...a) => killed.push(a) };
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const now = Date.now();
    const r = M.pokeOrEscalate(d, verdict, { home, now, nudgeMaxAttempts: 2, nudgeCooldownMs: 120000 }, io);
    assert.strictEqual(r.action, 'nudged');
    assert.deepStrictEqual(nudges, [['echo', 'wake-up']]);
    assert.strictEqual(killed.length, 0);
    const persisted = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(persisted.status, 'nudged');
    assert.strictEqual(persisted.nudgeAttempts, 1);
    assert.strictEqual(persisted.nudgedAt, now);
    assert.ok(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'recovery.log'), 'utf8').includes('nudged'));
  } finally { cleanup(); }
});

test('pokeOrEscalate: attempts exhausted -> escalate, never nudges again, NEVER a kill', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = Object.assign(descriptor(home), { nudgeCommand: ['echo', 'wake-up'] });
    const nudges = [];
    const killed = [];
    const io = { nudge: (cmd) => { nudges.push(cmd); }, kill: (...a) => killed.push(a), killGroup: (...a) => killed.push(a) };
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 2, nudgedAt: Date.now() - 500000, pending: true };
    const r = M.pokeOrEscalate(d, verdict, { home, nudgeMaxAttempts: 2, nudgeCooldownMs: 120000 }, io);
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'poke-exhausted');
    assert.strictEqual(nudges.length, 0, 'must not nudge again once exhausted');
    assert.strictEqual(killed.length, 0);
    const persisted = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(persisted.status, 'escalated');
    assert.ok(fs.readFileSync(path.join(home, '.anti-hall', 'devswarm', 'recovery.log'), 'utf8').includes('poke-exhausted'));
  } finally { cleanup(); }
});

test('pokeOrEscalate: no nudgeCommand on the descriptor -> straight to escalate, no nudge attempted', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home); // no nudgeCommand
    const nudges = [];
    const io = { nudge: (cmd) => { nudges.push(cmd); } };
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const r = M.pokeOrEscalate(d, verdict, { home }, io);
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(nudges.length, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('pokeOrEscalate: escalateCommand fires once on escalation', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = Object.assign(descriptor(home), { escalateCommand: ['echo', 'help'] });
    const escalated = [];
    const io = { escalate: (cmd) => { escalated.push(cmd); } };
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const r = M.pokeOrEscalate(d, verdict, { home }, io);
    assert.strictEqual(r.action, 'escalate');
    assert.deepStrictEqual(escalated, [['echo', 'help']]);
  } finally { cleanup(); }
});

test('pokeOrEscalate: fail-open — a throwing nudge io -> error result, never throws out, never kills', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = Object.assign(descriptor(home), { nudgeCommand: ['echo', 'x'] });
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0, nudgedAt: null, pending: true };
    // nudge() itself is wrapped in try/catch inside pokeOrEscalate, so a throwing
    // nudge must still result in a handled 'nudged' outcome, not an uncaught throw.
    const r = M.pokeOrEscalate(d, verdict, { home }, { nudge: () => { throw new Error('boom'); } });
    assert.strictEqual(r.action, 'nudged');
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

// P1: persistVerdict (recover()'s own bookkeeping) and persistNudgeVerdict
// (pokeOrEscalate's) write the SAME liveness file. Each must preserve the FULL
// union of cross-cutting fields from `prev`, not just the ones it owns — else an
// interleaved sweep silently resets the OTHER path's counter (defeating the
// recovery cap / nudge budget).
test('interleave: a nudge verdict AFTER a recovery must NOT clobber recoveries/recoveredAt', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const { io } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 555, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'resumed');
    assert.strictEqual(r.recoveries, 1);
    const afterRecover = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(afterRecover.recoveries, 1);
    assert.ok(afterRecover.recoveredAt > 0);

    // The AUTOMATIC sweep later nudges the SAME workspace — an independent path
    // writing the same liveness file.
    const dWithNudge = Object.assign({}, d, { nudgeCommand: ['echo', 'wake-up'] });
    const nudgeVerdict = Object.assign({ nudgeAttempts: 0, nudgedAt: null }, afterRecover);
    const pr = M.pokeOrEscalate(dWithNudge, nudgeVerdict, { home, now: Date.now() }, { nudge: () => {} });
    assert.strictEqual(pr.action, 'nudged');

    const afterNudge = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(afterNudge.nudgeAttempts, 1, 'nudge attempt recorded');
    assert.strictEqual(afterNudge.recoveries, 1, 'recoveries must NOT be dropped by a nudge verdict write');
    assert.strictEqual(afterNudge.recoveredAt, afterRecover.recoveredAt, 'recoveredAt must NOT be dropped by a nudge verdict write');
  } finally { cleanup(); }
});

test('interleave (reverse): a recovery AFTER a nudge must NOT clobber nudgeAttempts/nudgedAt', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = Object.assign(descriptor(home), { nudgeCommand: ['echo', 'wake-up'] });
    const nudgeVerdict = { status: 'stale', lastOutboundTs: 1, staleSince: 1, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const now = Date.now();
    const pr = M.pokeOrEscalate(d, nudgeVerdict, { home, now, nudgeMaxAttempts: 2, nudgeCooldownMs: 120000 }, { nudge: () => {} });
    assert.strictEqual(pr.action, 'nudged');
    const afterNudge = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(afterNudge.nudgeAttempts, 1);
    assert.strictEqual(afterNudge.nudgedAt, now);

    // A manual recover() runs on the SAME workspace afterward — same liveness file.
    const { io } = spyIo();
    const r = M.recover({ descriptor: d, target: { pid: 666, uuid: UUID, worktreePath: d.worktreePath }, home, io });
    assert.strictEqual(r.action, 'resumed');

    const afterRecover = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(afterRecover.recoveries, 1);
    assert.strictEqual(afterRecover.nudgeAttempts, 1, 'nudgeAttempts must NOT be dropped by a recovery verdict write');
    assert.strictEqual(afterRecover.nudgedAt, now, 'nudgedAt must NOT be dropped by a recovery verdict write');
  } finally { cleanup(); }
});

// ---- #19: escalation MECHANICALLY notifies the PARENT/Primary's store --------
// (owner principle #20: the daemon actively pushes into the parent's STORE — not
// just a local log — so an idle parent learns without taking a turn first).

test('pokeOrEscalate: escalation appends a synthetic notice into the PARENT store', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home); // id 'w1', no nudgeCommand -> straight to escalate
    const now = Date.now();
    const staleSince = now - 12 * 60 * 1000; // 12 minutes stale
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const r = M.pokeOrEscalate(d, verdict, { home, now }, {});
    assert.strictEqual(r.action, 'escalate');

    const parentId = inst.primaryWorkspaceId(d.worktreePath);
    const s = storeLib.openStore({ home, workspaceId: parentId }); // parent's own per-project store
    let msgs;
    try { msgs = s.listMessages(parentId, {}); } finally { s.close(); }
    assert.strictEqual(msgs.length, 1, 'exactly one notice landed in the parent store');
    assert.match(msgs[0].body, /child w1 idle 12m/);
    assert.match(msgs[0].body, /reassign or archive/);
  } finally { cleanup(); }
});

test('pokeOrEscalate: repeated escalate on an ALREADY-escalated verdict does NOT duplicate the parent notice (idempotent)', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const now = Date.now();
    const staleSince = now - 5 * 60 * 1000;
    const first = { status: 'stale', lastOutboundTs: 1, staleSince, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const r1 = M.pokeOrEscalate(d, first, { home, now }, {});
    assert.strictEqual(r1.action, 'escalate');

    // Simulate a second sweep / a manual re-nudge passing the NOW-persisted verdict —
    // must NOT append a second notice (the TRANSITION already happened).
    const persisted = JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8'));
    assert.strictEqual(persisted.status, 'escalated');
    const r2 = M.pokeOrEscalate(d, persisted, { home, now: now + 1000 }, {});
    assert.strictEqual(r2.action, 'escalate');

    const parentId = inst.primaryWorkspaceId(d.worktreePath);
    const s = storeLib.openStore({ home, workspaceId: parentId }); // parent's own per-project store
    let msgs;
    try { msgs = s.listMessages(parentId, {}); } finally { s.close(); }
    assert.strictEqual(msgs.length, 1, 'a repeated escalate call must NOT duplicate the parent notice');
  } finally { cleanup(); }
});

test('pokeOrEscalate: a throwing parent-store open fails OPEN — escalate still persists, never throws/crashes', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = descriptor(home);
    const now = Date.now();
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: now - 60000, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const io = { openParentStore: () => { throw new Error('boom'); } };
    const r = M.pokeOrEscalate(d, verdict, { home, now }, io);
    assert.strictEqual(r.action, 'escalate', 'a parent-store notice failure must never surface as an error/crash');
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('pokeOrEscalate: never notifies itself when the escalating workspace IS the resolved parent id', () => {
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt-self');
    fs.mkdirSync(worktreePath, { recursive: true });
    const inboxPath = path.join(worktreePath, 'inbox.ndjson');
    const cursorPath = path.join(worktreePath, 'cursor');
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 'x' }) + '\n');
    fs.writeFileSync(cursorPath, '0');
    const selfId = inst.primaryWorkspaceId(worktreePath);
    const d = { id: selfId, worktreePath, inboxPath, cursorPath, sessionId: UUID };
    let opened = false;
    const io = { openParentStore: () => { opened = true; throw new Error('must not be called'); } };
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: Date.now() - 60000, nudgeAttempts: 0, nudgedAt: null, pending: true };
    const r = M.pokeOrEscalate(d, verdict, { home, now: Date.now() }, io);
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(opened, false, 'must never open the parent store to notify itself');
  } finally { cleanup(); }
});

test('pokeOrEscalate: a NUDGE (not an escalate) never touches the parent store', () => {
  const { home, cleanup } = makeHome();
  try {
    const d = Object.assign(descriptor(home), { nudgeCommand: ['echo', 'wake-up'] });
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince: Date.now(), nudgeAttempts: 0, nudgedAt: null, pending: true };
    let opened = false;
    const io = { nudge: () => {}, openParentStore: () => { opened = true; return { appendMessage() {}, close() {} }; } };
    const r = M.pokeOrEscalate(d, verdict, { home, nudgeMaxAttempts: 2, nudgeCooldownMs: 120000 }, io);
    assert.strictEqual(r.action, 'nudged');
    assert.strictEqual(opened, false, 'a nudge must never open/notify the parent store');
  } finally { cleanup(); }
});

// ---- GAP A: notifyParentEscalation must open the PARENT's REPOKEY store (not
// the legacy hashFromWorkspaceId bucket) AND re-derive its projection. Pre-fix
// it called `open({ home, workspaceId: parentId, ... })` with NO `hash`, so
// openStore fell back to the legacy 8-hex bucket store.hashFromWorkspaceId(parentId)
// — a store no other mesh participant reads — and never called deriveSummary at
// all, so even a correctly-placed row would stay invisible to every projection
// reader. -----------------------------------------------------------------------

test('notifyParentEscalation: appends into the PARENT repoKey store (not the legacy hash bucket) and re-derives its projection', () => {
  const { home, cleanup } = makeHome();
  try {
    const gitRepoDir = makeGitRepo('gapA');
    try {
      const expectedRepoKey = repokeyLib.repoKeyForWorktree(gitRepoDir);
      assert.ok(expectedRepoKey, 'sanity: this environment must resolve a real repoKey for a real git repo — otherwise this test would be vacuous');

      const parentId = inst.primaryWorkspaceId(gitRepoDir);
      const d = { id: 'child-gapA', worktreePath: gitRepoDir, sessionId: UUID };
      assert.notStrictEqual(d.id, parentId, 'sanity: the child id must differ from the resolved parent id');

      const now = Date.now();
      const staleSince = now - 7 * 60 * 1000;
      const verdict = { status: 'stale', lastOutboundTs: 1, staleSince, nudgeAttempts: 0, nudgedAt: null, pending: true };

      // NO openParentStore override -> exercises the REAL store.
      M.notifyParentEscalation(d, verdict, { home, now }, undefined);

      // 1) The escalation row landed in the REPOKEY store.
      const s = storeLib.openStore({ home, workspaceId: parentId, hash: expectedRepoKey });
      let msgs;
      try { msgs = s.listMessages(parentId, {}); } finally { s.close(); }
      assert.ok(msgs.some((m) => m.body.includes(d.id)), 'the repoKey parent store carries a notice naming the child');

      // 2) The PROJECTION reflects it — pre-fix nothing ever derived it, so this
      //    was null.
      const sum = storeLib.readSummaryForHash(home, expectedRepoKey);
      assert.ok(sum, 'the repoKey summary was (re-)derived by notifyParentEscalation');

      // 3) ANTI-REGRESSION: the LEGACY 8-hex bucket got NOTHING (only meaningful
      //    when the two keys actually differ — a repoKey always contains an
      //    internal `-`, a legacy 8-hex hash never does, so they are disjoint by
      //    construction, but assert the precondition rather than assume it).
      const legacyHash = storeLib.hashFromWorkspaceId(parentId);
      if (legacyHash !== expectedRepoKey) {
        const sLegacy = storeLib.openStore({ home, workspaceId: parentId, hash: legacyHash });
        let legacyMsgs;
        try { legacyMsgs = sLegacy.listMessages(parentId, {}); } finally { sLegacy.close(); }
        assert.strictEqual(legacyMsgs.length, 0, 'the legacy hash bucket must receive NOTHING');
      }
    } finally { rm(gitRepoDir); }
  } finally { cleanup(); }
});

// ---- GAP A2: notifyParentEscalation must address the PARENT's mesh id, not the
// CHILD's own. primaryWorkspaceId() is a PURE hash of whatever path it is handed —
// it does no git resolution. Pre-fix the call site hashed descriptor.worktreePath
// directly, which for a LINKED worktree (the normal DevSwarm child shape) is the
// child's OWN worktree root, so the "parent" id computed was actually the child's
// own id and the notice was filed into a queue the parent never reads. ------------

test('notifyParentEscalation (linked worktree): addresses the notice to the PARENT id, not the CHILD\'s own mesh id', () => {
  const { home, cleanup } = makeHome();
  let mainRepo = null;
  let parentDir = null;
  try {
    mainRepo = makeGitRepo('gapA2-main');
    // FIXTURE MUST STAY A LINKED WORKTREE — not a plain git repo. This is not a style
    // preference. For a plain repo, resolveMainWorktree(repo) === repo, so the parent id
    // and the child's own id COINCIDE and the wrong-addressee failure is structurally
    // UNREPRESENTABLE. The earlier plain-repo fixture was not weakly asserted — it was
    // STRUCTURALLY BLIND: a fixture that cannot express the failing topology passes
    // forever no matter how many assertions are bolted onto it. Do not "simplify" this
    // back to a plain repo; doing so silently re-blinds the test.
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-recovery-wtparent-'));
    const childDir = path.join(parentDir, 'child-wt');
    const wtAdd = cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'add', '-q', childDir, '-b', 'wt-gapA2']);
    assert.strictEqual(wtAdd.status, 0, `git worktree add must succeed: ${wtAdd.stderr}`);
    // PRECONDITION: a linked worktree's `.git` is a FILE (a gitdir pointer), not a
    // directory — else this scenario is vacuous (it would behave like a plain repo).
    assert.ok(fs.statSync(path.join(childDir, '.git')).isFile(), 'sanity: linked worktree .git must be a FILE');

    const d = { id: 'child-gapA2', worktreePath: childDir, sessionId: UUID };
    const expectedParentId = inst.primaryWorkspaceId(inst.resolveMainWorktree(childDir));
    const childOwnId = inst.primaryWorkspaceId(childDir);
    // NON-VACUITY GUARD: if these ever coincide, the whole scenario below proves
    // nothing — fail loudly rather than silently pass.
    assert.notStrictEqual(expectedParentId, childOwnId, 'sanity: parent id and child\'s own id must differ for this fixture to be meaningful');

    const now = Date.now();
    const staleSince = now - 7 * 60 * 1000;
    const verdict = { status: 'stale', lastOutboundTs: 1, staleSince, nudgeAttempts: 0, nudgedAt: null, pending: true };

    // NO openParentStore override -> exercises the REAL store, same as production.
    M.notifyParentEscalation(d, verdict, { home, now }, undefined);

    const expectedRepoKey = repokeyLib.repoKeyForWorktree(childDir);
    assert.ok(expectedRepoKey, 'sanity: a real git worktree must resolve a real repoKey');

    // 1) Row lands under the PARENT's key.
    const sParent = storeLib.openStore({ home, workspaceId: expectedParentId, hash: expectedRepoKey });
    let parentMsgs;
    try { parentMsgs = sParent.listMessages(expectedParentId, {}); } finally { sParent.close(); }
    assert.ok(parentMsgs.some((m) => m.body.includes(d.id)), 'the PARENT partition carries a notice naming the child');

    // 2) Row is ABSENT from the child's own key (same repoKey store, different partition).
    const sChild = storeLib.openStore({ home, workspaceId: childOwnId, hash: expectedRepoKey });
    let childMsgs;
    try { childMsgs = sChild.listMessages(childOwnId, {}); } finally { sChild.close(); }
    assert.strictEqual(childMsgs.length, 0, 'the child\'s own partition must receive NOTHING — it is not the addressee');

    // 3) The projection the parent reads reflects it. computeSummary only projects a
    //    registry.listRegistry() row into `summary.workspaces[id]`; notifyParentEscalation
    //    never registers the parent (it only appends a message), so a real-unread
    //    partition with no registry row surfaces via the A2 ORPHAN-DETECTION path
    //    instead — `summary.orphans[]` entries shaped {id, messageCount, unread}
    //    (devswarm-store.js computeSummary, A2 orphan block). Verified empirically
    //    against this exact fixture before writing this assertion — do not assume
    //    `workspaces[id].unread`, which does not exist here.
    const sum = storeLib.readSummaryForHash(home, expectedRepoKey);
    assert.ok(sum, 'the repoKey summary was (re-)derived by notifyParentEscalation');
    const orphanEntry = (sum.orphans || []).find((o) => o.id === expectedParentId);
    assert.ok(orphanEntry, 'the projection surfaces the parent partition (as an orphan: no registry row, real unread)');
    assert.ok(orphanEntry.unread > 0, 'the parent partition shows non-zero unread in the projection');

    // 4) ANTI-REGRESSION: the LEGACY 8-hex bucket (hashFromWorkspaceId(parentId)) gets
    //    NOTHING, guarded by a keys-differ precondition (disjoint by construction, but
    //    assert it rather than assume it).
    const legacyHash = storeLib.hashFromWorkspaceId(expectedParentId);
    if (legacyHash !== expectedRepoKey) {
      const sLegacy = storeLib.openStore({ home, workspaceId: expectedParentId, hash: legacyHash });
      let legacyMsgs;
      try { legacyMsgs = sLegacy.listMessages(expectedParentId, {}); } finally { sLegacy.close(); }
      assert.strictEqual(legacyMsgs.length, 0, 'the legacy hash bucket must receive NOTHING');
    }
  } finally {
    try {
      if (mainRepo) {
        const childDir = parentDir ? path.join(parentDir, 'child-wt') : null;
        if (childDir) cp.spawnSync('git', ['-C', mainRepo, 'worktree', 'remove', '--force', childDir]);
      }
    } catch (_) {}
    if (parentDir) rm(parentDir);
    if (mainRepo) rm(mainRepo);
    cleanup();
  }
});
