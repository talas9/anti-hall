'use strict';
// devswarm-supervisor.js — disk-growth fix: the periodic liveness supervisor
// now ALSO runs a cooldown-gated housekeeping sweep (child-gate + reaped-logs
// retention, both reusing doctor-repair.js's own sweepChildGateFiles/
// sweepReapedLogs verbatim) and rotates its own launchd/systemd/cron-appended
// log file. Prior to this, `doctor --repair`'s R13 wiring was the ONLY thing
// that ever visited those two directories — a machine that installs the
// supervisor but never runs `doctor --repair` grew both without bound
// (measured: child-gate 133MB/34k files, devswarm-supervisor.log 62MB).
//
// Hermetic: fully injected deps, no real subprocess spawned, no real HOME
// touched.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const M = require(path.join(
  __dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'devswarm-supervisor.js',
));

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-housekeeping-sweep-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}

// --- housekeepingSweepIfDue: gating -----------------------------------------

test('housekeepingSweepIfDue: off when the supervisor itself is disabled', () => {
  const { home, cleanup } = makeHome();
  try {
    const out = M.housekeepingSweepIfDue({ home, env: { DISABLE_ANTIHALL_DEVSWARM: '1' } });
    assert.strictEqual(out.ran, false);
    assert.strictEqual(out.reason, 'disabled');
  } finally { cleanup(); }
});

test('housekeepingSweepIfDue: off via its own dedicated sub-toggle', () => {
  const { home, cleanup } = makeHome();
  try {
    const out = M.housekeepingSweepIfDue({ home, env: { ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP: 'off' } });
    assert.strictEqual(out.ran, false);
    assert.strictEqual(out.reason, 'disabled');
  } finally { cleanup(); }
});

test('housekeepingSweepIfDue: first call (no prior state) runs immediately', () => {
  const { home, cleanup } = makeHome();
  try {
    const out = M.housekeepingSweepIfDue({ home, env: {} });
    assert.strictEqual(out.ran, true);
    assert.ok(out.results, 'must report both sub-sweeps');
    assert.ok(Array.isArray(out.results.reapedLogs));
    assert.ok(Array.isArray(out.results.childGate));
  } finally { cleanup(); }
});

test('housekeepingSweepIfDue: cooldown-gated — a second call within the window does NOT re-run', () => {
  const { home, cleanup } = makeHome();
  try {
    const first = M.housekeepingSweepIfDue({ home, env: {}, now: 1000 });
    assert.strictEqual(first.ran, true);
    const second = M.housekeepingSweepIfDue({ home, env: {}, now: 1000 + 60 * 1000 }); // 1 min later, default cooldown 1h
    assert.strictEqual(second.ran, false);
    assert.strictEqual(second.reason, 'cooldown');
  } finally { cleanup(); }
});

test('housekeepingSweepIfDue: ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP_SEC overrides the cooldown (floor 300s)', () => {
  assert.strictEqual(M.resolveHousekeepingCooldownMs({ ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP_SEC: '600' }), 600 * 1000);
  assert.strictEqual(M.resolveHousekeepingCooldownMs({ ANTIHALL_DEVSWARM_HOUSEKEEPING_SWEEP_SEC: '10' }), 300 * 1000,
    'a typo/too-small override must never widen below the 5-minute floor');
});

test('housekeepingSweepIfDue: past the cooldown, a new sweep runs again', () => {
  const { home, cleanup } = makeHome();
  try {
    const first = M.housekeepingSweepIfDue({ home, env: {}, now: 1000, cooldownMs: 1000 });
    assert.strictEqual(first.ran, true);
    const second = M.housekeepingSweepIfDue({ home, env: {}, now: 1000 + 2000, cooldownMs: 1000 });
    assert.strictEqual(second.ran, true);
  } finally { cleanup(); }
});

// --- housekeepingSweepIfDue: it actually reaches the real sweeps -----------

test('housekeepingSweepIfDue: an aged child-gate file is actually removed end to end (real doctor-repair.js, no stub)', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'child-gate');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'ancient-session.json');
    fs.writeFileSync(old, '{}');
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30d > 14-day default
    fs.utimesSync(old, ancient, ancient);

    const out = M.housekeepingSweepIfDue({ home, env: {} });
    assert.strictEqual(out.ran, true);
    assert.ok(!fs.existsSync(old), 'THE FIX: the periodic supervisor sweep now reaches sweepChildGateFiles on its own, no doctor --repair needed');
  } finally { cleanup(); }
});

test('housekeepingSweepIfDue: an aged reaped log is actually removed end to end', () => {
  const { home, cleanup } = makeHome();
  try {
    const dir = path.join(home, '.anti-hall', 'devswarm', 'reaped');
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.ndjson');
    fs.writeFileSync(old, '{}\n');
    const ancient = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // 400d > 30-day default
    fs.utimesSync(old, ancient, ancient);

    const out = M.housekeepingSweepIfDue({ home, env: {} });
    assert.strictEqual(out.ran, true);
    assert.ok(!fs.existsSync(old), 'THE FIX: sweepReapedLogs is now reached periodically, not just via doctor --repair');
  } finally { cleanup(); }
});

test('housekeepingSweepIfDue: a fresh file in either dir is never touched', () => {
  const { home, cleanup } = makeHome();
  try {
    const gateDir = path.join(home, '.anti-hall', 'devswarm', 'child-gate');
    const reapedDir = path.join(home, '.anti-hall', 'devswarm', 'reaped');
    fs.mkdirSync(gateDir, { recursive: true });
    fs.mkdirSync(reapedDir, { recursive: true });
    fs.writeFileSync(path.join(gateDir, 'fresh-session.json'), '{}');
    fs.writeFileSync(path.join(reapedDir, 'fresh.ndjson'), '{}\n');

    M.housekeepingSweepIfDue({ home, env: {} });
    assert.ok(fs.existsSync(path.join(gateDir, 'fresh-session.json')));
    assert.ok(fs.existsSync(path.join(reapedDir, 'fresh.ndjson')));
  } finally { cleanup(); }
});

// --- rotateSupervisorLogIfNeeded --------------------------------------------

test('rotateSupervisorLogIfNeeded: no log file yet -> not rotated, no crash', () => {
  const { home, cleanup } = makeHome();
  try {
    const out = M.rotateSupervisorLogIfNeeded({ home, env: {} });
    assert.strictEqual(out.rotated, false);
  } finally { cleanup(); }
});

test('rotateSupervisorLogIfNeeded: under threshold -> left alone', () => {
  const { home, cleanup } = makeHome();
  try {
    const logPath = M.supervisorLogPath(home);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'small\n');
    const out = M.rotateSupervisorLogIfNeeded({ home, env: {} });
    assert.strictEqual(out.rotated, false);
    assert.ok(fs.existsSync(logPath));
  } finally { cleanup(); }
});

test('rotateSupervisorLogIfNeeded: over threshold -> rotated to .1, active log path freed for a fresh file', () => {
  const { home, cleanup } = makeHome();
  try {
    const logPath = M.supervisorLogPath(home);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'x'.repeat(1024));
    const out = M.rotateSupervisorLogIfNeeded({ home, env: { ANTIHALL_DEVSWARM_SUPERVISOR_LOG_ROTATE_BYTES: '100' } });
    assert.strictEqual(out.rotated, true);
    assert.ok(!fs.existsSync(logPath), 'the oversized log is moved out of the active path');
    assert.ok(fs.existsSync(logPath + '.1'), 'rotated content is preserved as the one backup generation');
    assert.strictEqual(fs.readFileSync(logPath + '.1', 'utf8').length, 1024);
  } finally { cleanup(); }
});

test('rotateSupervisorLogIfNeeded: keeps exactly 2 generations — a second rotation replaces the old .1, never accumulates .2/.3', () => {
  const { home, cleanup } = makeHome();
  try {
    const logPath = M.supervisorLogPath(home);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'first-generation'.repeat(20));
    M.rotateSupervisorLogIfNeeded({ home, env: { ANTIHALL_DEVSWARM_SUPERVISOR_LOG_ROTATE_BYTES: '10' } });
    assert.ok(fs.existsSync(logPath + '.1'));

    fs.writeFileSync(logPath, 'second-generation'.repeat(20));
    M.rotateSupervisorLogIfNeeded({ home, env: { ANTIHALL_DEVSWARM_SUPERVISOR_LOG_ROTATE_BYTES: '10' } });
    assert.ok(fs.existsSync(logPath + '.1'));
    assert.match(fs.readFileSync(logPath + '.1', 'utf8'), /second-generation/, 'the newest rotation wins the single backup slot');
    assert.ok(!fs.existsSync(logPath + '.2'), 'never accumulates a third generation');
  } finally { cleanup(); }
});
