'use strict';
// D12 (v0.96.1, false-positive escalation) item 2 — an `escalated` liveness
// verdict is normally STICKY (liveness.js's P2-13 terminal short-circuit):
// once written, computeLiveness returns it unchanged forever, no re-stat, so
// the sweep stops re-targeting a workspace a human must handle. But a row can
// reach `escalated` while its session was actually alive the whole time (see
// devswarm-supervisor-idle-alive.test.js's D12 coverage for the mechanism at
// the write side this release also fixes). This file covers the SELF-HEAL:
// isSessionAliveRow proving the session pid is alive RIGHT NOW clears the
// terminal state — one-directional, a live pid can only clear `escalated`,
// never assert it — and logs the clear to recovery.log with reason
// `session-alive`. A dead/unknown pid takes the pre-existing sticky
// short-circuit completely unchanged (no regression), and when it does, no
// pending/notDraining/oldestUnreadAgeMs values are hardcoded false/null —
// `prev`'s last-known values (possibly absent) are carried through instead.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVENESS = path.join(__dirname, '..', '..', 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js');
const liveness = require(LIVENESS);

function tmpHome() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-escselfheal-'));
  fs.mkdirSync(path.join(d, '.anti-hall', 'devswarm'), { recursive: true });
  return d;
}
function rm(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }

// Same fixture shape as tests/companion/liveness-session-axis.test.js (the
// EXACT shape measured on this machine for a live harness session).
function writeSessionFile(home, pid, sessionId) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid) + '.json'), JSON.stringify({
    pid, sessionId, cwd: '/tmp/x', status: 'shell', kind: 'interactive',
  }));
}

function recoveryLogPath(home) { return path.join(liveness.devswarmRoot(home), 'recovery.log'); }
function readRecoveryLog(home) {
  try { return fs.readFileSync(recoveryLogPath(home), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch (_) { return []; }
}

const DESCRIPTOR = { id: 'ws-esc', worktreePath: '/tmp/nonexistent-worktree-esc', sessionId: 'sess-esc' };

test('D12 item 2: escalated + LIVE session pid -> cleared, recovery.log reason session-alive', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 5001, 'sess-esc');
    liveness.writeVerdict(DESCRIPTOR.id, {
      status: 'escalated', nudgeAttempts: 3, nudgedAt: Date.now() - 1000, staleSince: Date.now() - 2e6, lastOutboundTs: Date.now() - 2e6,
    }, home);

    const aliveKill = (pid, sig) => { assert.strictEqual(sig, 0); assert.strictEqual(pid, 5001); /* alive */ };
    const result = liveness.computeLiveness({
      descriptor: DESCRIPTOR, now: Date.now(), home, kill: aliveKill,
    });

    assert.notStrictEqual(result.status, 'escalated', 'a proven-live session must clear the terminal state, not stay sticky');

    const log = readRecoveryLog(home);
    const cleared = log.find((l) => l.id === DESCRIPTOR.id && l.action === 'cleared' && l.reason === 'session-alive');
    assert.ok(cleared, 'recovery.log must record the clear with reason session-alive: ' + JSON.stringify(log));
  } finally { rm(home); }
});

test('D12 item 2: escalated + DEAD session pid -> sticky short-circuit unchanged (no regression), no recovery.log write', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 5002, 'sess-esc');
    liveness.writeVerdict(DESCRIPTOR.id, {
      status: 'escalated', nudgeAttempts: 3, nudgedAt: 12345, staleSince: 6789, lastOutboundTs: 4242,
    }, home);

    const deadKill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
    const result = liveness.computeLiveness({
      descriptor: DESCRIPTOR, now: Date.now(), home, kill: deadKill,
    });

    assert.strictEqual(result.status, 'escalated');
    assert.strictEqual(result.nudgeAttempts, 3);
    assert.strictEqual(result.nudgedAt, 12345);
    assert.strictEqual(result.staleSince, 6789);
    assert.strictEqual(result.lastOutboundTs, 4242);

    const log = readRecoveryLog(home);
    assert.strictEqual(log.find((l) => l.action === 'cleared'), undefined, 'a dead pid must never clear/log session-alive');
  } finally { rm(home); }
});

test('D12 item 3: sticky escalated verdict carries prev pending/notDraining/oldestUnreadAgeMs, never hardcodes false/null', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 5003, 'sess-esc');
    liveness.writeVerdict(DESCRIPTOR.id, {
      status: 'escalated', nudgeAttempts: 1, nudgedAt: 1, staleSince: 1, lastOutboundTs: 1,
      pending: true, notDraining: true, oldestUnreadAgeMs: 999999,
    }, home);

    const deadKill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
    const result = liveness.computeLiveness({ descriptor: DESCRIPTOR, now: Date.now(), home, kill: deadKill });

    assert.strictEqual(result.status, 'escalated');
    assert.strictEqual(result.pending, true, 'must carry prev.pending through, not hardcode false');
    assert.strictEqual(result.notDraining, true, 'must carry prev.notDraining through, not hardcode false');
    assert.strictEqual(result.oldestUnreadAgeMs, 999999, 'must carry prev.oldestUnreadAgeMs through, not hardcode null');
  } finally { rm(home); }
});

test('D12 item 3: sticky escalated verdict with NO prior pending/notDraining fields omits them (additive/absent, never a false claim)', () => {
  const home = tmpHome();
  try {
    writeSessionFile(home, 5004, 'sess-esc');
    // Exactly what persistNudgeVerdict's mergeVerdict actually writes on the
    // real escalate path today: PRESERVED_VERDICT_FIELDS does not include
    // pending/notDraining/oldestUnreadAgeMs, so a real on-disk escalated
    // verdict has none of them.
    liveness.writeVerdict(DESCRIPTOR.id, { status: 'escalated', nudgeAttempts: 1, nudgedAt: 1, staleSince: 1, lastOutboundTs: 1 }, home);

    const deadKill = () => { const e = new Error('no such process'); e.code = 'ESRCH'; throw e; };
    const result = liveness.computeLiveness({ descriptor: DESCRIPTOR, now: Date.now(), home, kill: deadKill });

    assert.strictEqual(result.status, 'escalated');
    assert.strictEqual(result.pending, undefined, 'must be omitted/absent, never hardcoded false');
    assert.strictEqual(result.notDraining, undefined, 'must be omitted/absent, never hardcoded false');
    assert.strictEqual(result.oldestUnreadAgeMs, null, 'no prior value known -> null is correct (never a false positive claim)');
  } finally { rm(home); }
});

// RED-PROOF: a scratch copy with the self-heal clause reverted reproduces the
// pre-fix sticky-forever behavior for a proven-live session.
test('D12 RED-PROOF: pre-fix source (self-heal clause reverted) stays escalated forever even with a proven-live pid', () => {
  const src = fs.readFileSync(LIVENESS, 'utf8');
  const target = "const aliveNow = (() => { try { return isSessionAliveRow(descriptor, home, { fs: fsi, now, kill: opts.kill, ps: opts.ps }); } catch (_) { return false; } })();\n    if (aliveNow) {";
  assert.ok(src.includes(target), 'D12 mutant target string not found verbatim — liveness.js shape changed');
  // Force the self-heal branch permanently off (never fires) while leaving
  // every other line — including `aliveNow`'s computation — untouched, so
  // this mutant isolates EXACTLY the self-heal clause under test.
  const neutered = target.replace('if (aliveNow) {', 'if (false && aliveNow) {');
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-liveness-d12-mutant-'));
  const scratchFile = path.join(scratchDir, 'liveness.js');
  try {
    fs.writeFileSync(scratchFile, src.replace(target, neutered));
    fs.symlinkSync(path.join(LIVENESS, '..', 'target-session.js'), path.join(scratchDir, 'target-session.js'));
    delete require.cache[require.resolve(scratchFile)];
    const mutated = require(scratchFile);
    delete require.cache[require.resolve(scratchFile)];

    const home = tmpHome();
    try {
      writeSessionFile(home, 5005, 'sess-esc');
      mutated.writeVerdict(DESCRIPTOR.id, { status: 'escalated', nudgeAttempts: 1, nudgedAt: 1, staleSince: 1, lastOutboundTs: 1 }, home);
      const aliveKill = () => {};
      const result = mutated.computeLiveness({ descriptor: DESCRIPTOR, now: Date.now(), home, kill: aliveKill });
      assert.strictEqual(result.status, 'escalated',
        'RED-PROOF: pre-fix source must reproduce the sticky-forever bug even with a proven-live pid');
    } finally { rm(home); }
  } finally { try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch (_) {} }
});
