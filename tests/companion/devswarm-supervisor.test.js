'use strict';
// devswarm-supervisor: one sweep over published descriptors. Uses a real temp
// HOME for descriptor discovery; computeLiveness/findTarget/recover are injected
// so no real process is touched and per-workspace fail-open is provable. Also
// covers descriptor sanitization (unsafe id / missing sessionId dropped) and the
// single-flight sweep lock.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js',
));

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-sweep-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
// A complete, valid descriptor unless overridden.
function writeDescriptor(home, d, fileName) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  fs.writeFileSync(path.join(dir, (fileName || d.id) + '.json'), JSON.stringify(full));
}

test('supervisorEnabled: off / hard-kill disable; otherwise enabled', () => {
  assert.strictEqual(M.supervisorEnabled({}), true);
  assert.strictEqual(M.supervisorEnabled({ ANTIHALL_DEVSWARM_SUPERVISOR: 'off' }), false);
  assert.strictEqual(M.supervisorEnabled({ DISABLE_ANTIHALL_DEVSWARM: '1' }), false);
});

test('readDescriptors: reads valid; skips malformed / no-worktree / no-sessionId / unsafe-id', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const dir = descriptorsDir(home);
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'nofields.json'), JSON.stringify({ id: 'x', sessionId: UUID })); // no worktreePath
    fs.writeFileSync(path.join(dir, 'nosession.json'), JSON.stringify({ id: 'y', worktreePath: '/wt/y' })); // no sessionId
    fs.writeFileSync(path.join(dir, 'evil.json'), JSON.stringify({ id: '../../x', worktreePath: '/wt/z', sessionId: UUID })); // P1-7
    const ds = M.readDescriptors(home);
    assert.strictEqual(ds.length, 1);
    assert.strictEqual(ds[0].id, 'a');
  } finally { cleanup(); }
});

test('sweepOnce: alive workspace -> verdict written, no recovery attempted', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let recoverCalls = 0;
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'alive', lastOutboundTs: 1, staleSince: null, recoveries: 0 }),
        writeVerdict: () => {},
        recover: () => { recoverCalls++; return { action: 'resumed' }; },
      },
    });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].verdict.status, 'alive');
    assert.strictEqual(recoverCalls, 0);
  } finally { cleanup(); }
});

test('sweepOnce: stale workspace -> findTarget (identity-bound) + recover invoked', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const seen = {};
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, recoveries: 0 }),
        writeVerdict: () => {},
        findTarget: (o) => { seen.wt = o.worktreePath; seen.sid = o.sessionId; return { pid: 1, uuid: o.sessionId, worktreePath: o.worktreePath }; },
        recover: (o) => { seen.recovered = o.target.pid; return { action: 'resumed' }; },
      },
    });
    assert.strictEqual(seen.wt, '/wt/a');
    assert.strictEqual(seen.sid, UUID); // sessionId threaded from the descriptor
    assert.strictEqual(seen.recovered, 1);
    assert.strictEqual(res[0].recovery.action, 'resumed');
  } finally { cleanup(); }
});

test('sweepOnce: fail-open — a throwing computeLiveness on one workspace does not stop the rest', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    writeDescriptor(home, { id: 'b', worktreePath: '/wt/b' });
    const res = M.sweepOnce({
      home,
      deps: {
        computeLiveness: (o) => { if (o.descriptor.id === 'a') throw new Error('boom'); return { status: 'alive', recoveries: 0 }; },
        writeVerdict: () => {},
        recover: () => ({ action: 'resumed' }),
      },
    });
    assert.strictEqual(res.length, 2);
    const a = res.find((r) => r.id === 'a'); const b = res.find((r) => r.id === 'b');
    assert.ok(a.error, 'workspace a recorded an error');
    assert.strictEqual(b.verdict.status, 'alive', 'workspace b still processed');
  } finally { cleanup(); }
});

test('sweepOnce: disabled -> empty (no work)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    const res = M.sweepOnce({ home, env: { ANTIHALL_DEVSWARM_SUPERVISOR: 'off' } });
    assert.deepStrictEqual(res, []);
  } finally { cleanup(); }
});

test('parseEnvNum: valid override, clamped; invalid/absent/non-positive -> default', () => {
  assert.strictEqual(M.parseEnvNum({ X: '120' }, 'X', 90), 120);
  assert.strictEqual(M.parseEnvNum({ X: '10' }, 'X', 90, { min: 60 }), 60, 'clamped up to min');
  assert.strictEqual(M.parseEnvNum({ X: '999' }, 'X', 90, { max: 100 }), 100, 'clamped down to max');
  assert.strictEqual(M.parseEnvNum({}, 'X', 90), 90, 'absent -> default');
  assert.strictEqual(M.parseEnvNum({ X: '' }, 'X', 90), 90, 'empty -> default');
  assert.strictEqual(M.parseEnvNum({ X: 'abc' }, 'X', 90), 90, 'non-numeric -> default');
  assert.strictEqual(M.parseEnvNum({ X: '0' }, 'X', 90), 90, 'zero -> default');
  assert.strictEqual(M.parseEnvNum({ X: '-5' }, 'X', 90), 90, 'negative -> default');
  assert.strictEqual(M.parseEnvNum({ X: '12.5' }, 'X', 90), 90, 'non-integer -> default');
  // the min/max clamp applies to the default itself too, so an out-of-range
  // default can never slip through unclamped just because the env var is unset.
  assert.strictEqual(M.parseEnvNum({}, 'X', 10, { min: 60 }), 60);
});

test('resolveThresholdsFromEnv: each env var overrides its threshold; absent -> byte-for-byte defaults', () => {
  const defaults = M.resolveThresholdsFromEnv({});
  assert.deepStrictEqual(defaults, {
    idleThresholdMs: 15 * 60 * 1000,
    cooldownMs: 10 * 60 * 1000,
    maxRecoveries: 3,
    graceMs: 5000,
    stuckMs: 30 * 60 * 1000,
  }, 'no env set -> current module defaults, unchanged');

  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '120' }).idleThresholdMs, 120 * 1000,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_COOLDOWN_SEC: '30' }).cooldownMs, 30 * 1000,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_MAX_RECOVERIES: '1' }).maxRecoveries, 1,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_GRACE_SEC: '10' }).graceMs, 10 * 1000,
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_STUCK_SEC: '3600' }).stuckMs, 3600 * 1000,
  );

  // clamps
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '10' }).idleThresholdMs, 60 * 1000, 'idle floored to 60s',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_MAX_RECOVERIES: '99' }).maxRecoveries, 20, 'maxRecoveries capped at 20',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_MAX_RECOVERIES: '0' }).maxRecoveries, 3, 'invalid -> default (fail-open)',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_GRACE_SEC: '0' }).graceMs, 5000, 'invalid grace -> default',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_GRACE_SEC: '9999' }).graceMs, 60 * 1000, 'grace capped at 60s',
  );
  // stuck must never be a tighter window than idle, whether idle was raised by
  // env or left at its default.
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '3700' }).stuckMs, 3700 * 1000,
    'stuck floored up to a larger idle',
  );
  assert.strictEqual(
    M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '3700', ANTIHALL_DEVSWARM_STUCK_SEC: '5000' }).stuckMs,
    5000 * 1000, 'an explicit stuck above idle is respected',
  );
});

test('sweepOnce: graceMs is threaded through to recover() for a stale workspace', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'a', worktreePath: '/wt/a' });
    let seenGraceMs;
    M.sweepOnce({
      home, graceMs: 12345,
      deps: {
        computeLiveness: () => ({ status: 'stale', lastOutboundTs: 1, staleSince: 1, recoveries: 0 }),
        writeVerdict: () => {},
        findTarget: (o) => ({ pid: 1, uuid: o.sessionId, worktreePath: o.worktreePath }),
        recover: (o) => { seenGraceMs = o.graceMs; return { action: 'resumed' }; },
      },
    });
    assert.strictEqual(seenGraceMs, 12345);
  } finally { cleanup(); }
});

test('end-to-end: ANTIHALL_DEVSWARM_MAX_RECOVERIES=1 makes recover() escalate after 1 (not the default 3)', () => {
  const { recover } = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'recovery.js',
  ));
  const { livenessPathFor } = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
  ));
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    fs.mkdirSync(worktreePath, { recursive: true });
    const inboxPath = path.join(worktreePath, 'inbox.ndjson');
    const cursorPath = path.join(worktreePath, 'cursor');
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 'x' }) + '\n');
    fs.writeFileSync(cursorPath, '0');
    const d = { id: 'w1', worktreePath, inboxPath, cursorPath, sessionId: UUID };
    fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'liveness'), { recursive: true });
    // already recovered once -> with the env-resolved cap of 1, the 2nd attempt escalates.
    fs.writeFileSync(livenessPathFor('w1', home), JSON.stringify({ status: 'stale', lastOutboundTs: 1, staleSince: 1, recoveries: 1 }));

    const { maxRecoveries } = M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_MAX_RECOVERIES: '1' });
    const io = { platform: 'darwin', selfPid: 999999, sleep: () => {}, reconfirm: () => true, kill: () => false, killGroup: () => true };
    const r = recover({ descriptor: d, target: { pid: 9, uuid: UUID, worktreePath: d.worktreePath }, home, io, maxRecoveries });
    assert.strictEqual(r.action, 'escalate');
    assert.strictEqual(r.reason, 'max-recoveries');
    assert.strictEqual(JSON.parse(fs.readFileSync(livenessPathFor('w1', home), 'utf8')).status, 'escalated');
  } finally { cleanup(); }
});

test('end-to-end: ANTIHALL_DEVSWARM_IDLE_SEC moves the stale cutoff seen by computeLiveness', () => {
  const { computeLiveness, projectDirFor } = require(path.join(
    __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js',
  ));
  const { home, cleanup } = makeHome();
  try {
    const worktreePath = path.join(home, 'wt');
    const projectDir = projectDirFor(worktreePath, home);
    fs.mkdirSync(projectDir, { recursive: true });
    const tp = path.join(projectDir, UUID + '.jsonl');
    fs.writeFileSync(tp, '{}\n');
    const ageMs = 20 * 60 * 1000; // 20 minutes idle
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(tp, t, t);
    const inboxPath = path.join(worktreePath, 'i'); const cursorPath = path.join(worktreePath, 'c');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(inboxPath, JSON.stringify({ m: 1 }) + '\n');
    fs.writeFileSync(cursorPath, '0');
    const descriptor = { id: 'w1', worktreePath, inboxPath, cursorPath, sessionId: UUID };

    // default idle (15m) -> 20m-idle workspace classifies stale.
    const withDefault = M.resolveThresholdsFromEnv({});
    const v1 = computeLiveness({ descriptor, home, idleThresholdMs: withDefault.idleThresholdMs, runners: { gitCommitTs: () => Date.now() - ageMs } });
    assert.strictEqual(v1.status, 'stale');

    // ANTIHALL_DEVSWARM_IDLE_SEC=1800 (30m) -> the SAME 20m-idle workspace is now alive.
    const withOverride = M.resolveThresholdsFromEnv({ ANTIHALL_DEVSWARM_IDLE_SEC: '1800' });
    const v2 = computeLiveness({ descriptor, home, idleThresholdMs: withOverride.idleThresholdMs, runners: { gitCommitTs: () => Date.now() - ageMs } });
    assert.strictEqual(v2.status, 'alive');
  } finally { cleanup(); }
});

test('single-flight: a live-holder sweep lock blocks a second acquire; a dead holder is stolen', () => {
  const { home, cleanup } = makeHome();
  try {
    const held = M.acquireSweepLock(home, { fs });
    assert.ok(held, 'first sweep lock must succeed');
    assert.strictEqual(M.acquireSweepLock(home, { fs, isAlive: () => true }), null, 'a live holder blocks overlap');
    held();
    // Pre-write a dead-holder lock -> stealable so a crashed sweep cannot wedge cron forever.
    fs.writeFileSync(M.sweepLockPath(home), JSON.stringify({ pid: 4242, ts: Date.now() }));
    const stolen = M.acquireSweepLock(home, { fs, isAlive: () => false });
    assert.ok(stolen, 'dead-holder sweep lock must be stealable');
    stolen();
  } finally { cleanup(); }
});
