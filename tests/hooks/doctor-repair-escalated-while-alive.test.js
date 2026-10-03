'use strict';
// checkEscalatedWhileAlive (report-only, defensive; D12 v0.96.1).
//
// Detects a devswarm liveness file that says `escalated` for a workspace
// whose session pid is PROVABLY alive right now — the false-positive
// escalation this release fixes at the write side (devswarm-supervisor.js)
// and self-heals at the read side (liveness.js's computeLiveness). Between
// "escalated written" and "next supervisor pass" a human reading doctor's
// output should be told this will self-heal, not just told it is escalated.
//
// Report-only: this suite never asserts any write/clear/kill behavior — the
// production function itself is a pure read (descriptor list + liveness file
// + isSessionAliveRow) with no side effect of its own.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const repair = require(REPAIR_JS);
const LIVENESS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'liveness.js');
const liveness = require(LIVENESS);

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-escalated-'));
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function descriptorsDir(home) { return path.join(home, '.anti-hall', 'devswarm', 'workspaces'); }
function writeDescriptor(home, d) {
  const dir = descriptorsDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const full = Object.assign({ inboxPath: '/i', cursorPath: '/c', sessionId: UUID }, d);
  fs.writeFileSync(path.join(dir, full.id + '.json'), JSON.stringify(full));
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(dir, full.id + '.json'), old, old);
}
function writeSessionFile(home, pid, sessionId) {
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(pid) + '.json'), JSON.stringify({
    pid, sessionId, cwd: '/tmp/x', status: 'shell', kind: 'interactive',
  }));
}

test('checkEscalatedWhileAlive: escalated liveness file + LIVE session pid -> warns, names the workspace id', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'wsA', worktreePath: '/wt/a', sessionId: 'sessA' });
    writeSessionFile(home, process.pid, 'sessA'); // this test process's OWN pid is genuinely alive
    liveness.writeVerdict('wsA', { status: 'escalated', nudgeAttempts: 3, nudgedAt: 1 }, home);

    const r = repair.checkEscalatedWhileAlive({ home });
    assert.ok(r, 'must fire when an escalated row has a provably-alive session pid');
    assert.strictEqual(r.atRisk, true);
    assert.strictEqual(r.count, 1);
    assert.deepStrictEqual(r.examples, ['wsA']);
    assert.match(r.message, /wsA/);
    assert.match(r.message, /self-heals/);
  } finally { cleanup(); }
});

test('checkEscalatedWhileAlive: escalated liveness file + DEAD session pid -> silent (null)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'wsB', worktreePath: '/wt/b', sessionId: 'sessB' });
    // No session file at all -> sessionPidAlive returns null -> isSessionAliveRow false.
    liveness.writeVerdict('wsB', { status: 'escalated', nudgeAttempts: 3, nudgedAt: 1 }, home);

    const r = repair.checkEscalatedWhileAlive({ home });
    assert.strictEqual(r, null, 'must stay silent when the escalated row has no proven-live pid');
  } finally { cleanup(); }
});

test('checkEscalatedWhileAlive: NOT escalated (stale) + live pid -> silent (only escalated rows are in scope)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeDescriptor(home, { id: 'wsC', worktreePath: '/wt/c', sessionId: 'sessC' });
    writeSessionFile(home, process.pid, 'sessC');
    liveness.writeVerdict('wsC', { status: 'stale', nudgeAttempts: 0, nudgedAt: null }, home);

    const r = repair.checkEscalatedWhileAlive({ home });
    assert.strictEqual(r, null, 'a non-escalated verdict must never fire this check');
  } finally { cleanup(); }
});

test('checkEscalatedWhileAlive: no descriptors at all -> silent (null), never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = repair.checkEscalatedWhileAlive({ home });
    assert.strictEqual(r, null);
  } finally { cleanup(); }
});

test('doctor.js wires checkEscalatedWhileAlive into a report-only, warn-labeled section', () => {
  const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');
  const src = fs.readFileSync(DOCTOR_JS, 'utf8');
  assert.match(src, /checkEscalatedWhileAlive/);
  assert.match(src, /escalated while session alive/);
});
