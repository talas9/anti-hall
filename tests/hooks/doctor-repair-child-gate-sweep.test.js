'use strict';
// doctor-repair-child-gate-sweep — disk-growth fix: hooks/devswarm-child-gate.js
// writes one state file per session (stateFileFor) to
// <devswarmRoot>/child-gate/<sessionId>.json, read only by that SAME session's
// own later Stop calls — never cleaned up. Measured field growth: 133MB /
// 34k files on one machine. `sweepChildGateFiles` (doctor-repair.js) applies
// the SAME bounded-retention sweep pattern as sweepReapedLogs/
// sweepSendReceipts (sweepAgedFiles), window
// ANTIHALL_DEVSWARM_CHILD_GATE_RETENTION_DAYS (default 14 days), wired into
// `doctor --repair`'s runRepairs sweep list.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repair = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');
const { sweepChildGateFiles, runRepairs, CHILD_GATE_RETENTION_DAYS_DEFAULT } = repair;

const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
const DAY = 24 * 60 * 60 * 1000;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'child-gate-sweep-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });
  return home;
}
const childGateDir = (home) => path.join(home, '.anti-hall', 'devswarm', 'child-gate');

function seed(home) {
  const dir = childGateDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old-session.json');
  const fresh = path.join(dir, 'fresh-session.json');
  fs.writeFileSync(old, JSON.stringify({ blocks: 1 }));
  fs.writeFileSync(fresh, JSON.stringify({ blocks: 0 }));
  const ancient = new Date(Date.now() - 30 * DAY); // older than the 14-day default
  fs.utimesSync(old, ancient, ancient);
  return { old, fresh };
}

test('sweepChildGateFiles: default 14-day retention — reports aged files pending in check mode', () => {
  const home = tmpHome();
  try {
    const { old, fresh } = seed(home);
    const rows = sweepChildGateFiles({ home, mode: 'check', env: {} });
    assert.ok(rows.some((r) => r.file === old && r.status === 'pending'));
    assert.ok(!rows.some((r) => r.file === fresh));
    assert.ok(fs.existsSync(old), 'check mode deletes nothing');
  } finally { rm(home); }
});

test('sweepChildGateFiles: repair mode removes the aged file, leaves the fresh one', () => {
  const home = tmpHome();
  try {
    const { old, fresh } = seed(home);
    const rows = sweepChildGateFiles({ home, mode: 'repair', env: {} });
    assert.ok(rows.some((r) => r.file === old && r.status === 'fixed'));
    assert.ok(!fs.existsSync(old), 'aged session state is finally swept (30d > the 14-day default)');
    assert.ok(fs.existsSync(fresh), 'a file inside the retention window is never touched');
  } finally { rm(home); }
});

test('sweepChildGateFiles: ANTIHALL_DEVSWARM_CHILD_GATE_RETENTION_DAYS overrides the default window', () => {
  const home = tmpHome();
  try {
    const dir = childGateDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'five-days-old.json');
    fs.writeFileSync(f, '{}');
    const fiveDaysAgo = new Date(Date.now() - 5 * DAY);
    fs.utimesSync(f, fiveDaysAgo, fiveDaysAgo);

    // Default (14d) leaves a 5-day-old file untouched.
    const rowsDefault = sweepChildGateFiles({ home, mode: 'check', env: {} });
    assert.ok(!rowsDefault.some((r) => r.file === f), 'inside the default 14-day window');

    // A tighter override (2d) must flag it.
    const rowsTight = sweepChildGateFiles({ home, mode: 'check', env: { ANTIHALL_DEVSWARM_CHILD_GATE_RETENTION_DAYS: '2' } });
    assert.ok(rowsTight.some((r) => r.file === f && r.status === 'pending'), 'env override narrows the window');
  } finally { rm(home); }
});

test('sweepChildGateFiles: a missing child-gate directory is a routine no-op, never a failure', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'child-gate-sweep-bare-'));
  try {
    const rows = sweepChildGateFiles({ home, mode: 'repair', env: {} });
    assert.deepStrictEqual(rows, []);
  } finally { rm(home); }
});

test('CHILD_GATE_RETENTION_DAYS_DEFAULT is exported and is 14', () => {
  assert.strictEqual(CHILD_GATE_RETENTION_DAYS_DEFAULT, 14);
});

test('wiring: `doctor --repair` (runRepairs) actually reaches sweep-child-gate — exported-but-unwired is not shipped', () => {
  const home = tmpHome();
  try {
    const { old, fresh } = seed(home);
    const results = runRepairs({ home, cwd: home, env: {}, dryRun: false });
    const row = results.find((r) => r && r.id === 'sweep-child-gate');
    assert.ok(row, '`sweep-child-gate` must be a distinct entry in runRepairs output');
    assert.ok(!fs.existsSync(old), 'runRepairs in apply mode actually swept the aged child-gate file');
    assert.ok(fs.existsSync(fresh));
  } finally { rm(home); }
});

test('wiring: `doctor --repair --dry-run` reaches sweep-child-gate but deletes nothing', () => {
  const home = tmpHome();
  try {
    const { old } = seed(home);
    const results = runRepairs({ home, cwd: home, env: {}, dryRun: true });
    const row = results.find((r) => r && r.id === 'sweep-child-gate');
    assert.ok(row);
    assert.notStrictEqual(row.status, 'fixed', 'dry-run must never report a mutation');
    assert.ok(fs.existsSync(old), 'dry-run deletes nothing');
  } finally { rm(home); }
});
