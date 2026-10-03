'use strict';
// hooks/lib/doctor-repair.js's sweepAutoHandoverState / sweepContextPctState
// (v0.108.0) — bounded retention for the auto-handover feature's two
// per-session state dirs (~/.anti-hall/auto-handover/, ~/.anti-hall/context-pct/),
// wired into `doctor --repair`'s runRepairs() only (never a hook's own hot
// path — see tests/hooks/doctor-repair-r13-sweeps-wired.test.js for the
// "exported but unwired is not shipped" lesson this follows).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runRepairs, sweepAutoHandoverState, sweepContextPctState,
} = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');

const DAY = 24 * 60 * 60 * 1000;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r-auto-handover-retention-'));
  return home;
}
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* best-effort */ } };

function seedAgedFile(dir, name, ageDays) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '{}\n');
  if (ageDays > 0) {
    const t = new Date(Date.now() - ageDays * DAY);
    fs.utimesSync(p, t, t);
  }
  return p;
}

test('sweepAutoHandoverState: check mode lists an aged file but never deletes it', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'auto-handover');
    const old = seedAgedFile(dir, 'sess-old.json', 40);
    const fresh = seedAgedFile(dir, 'sess-fresh.json', 1);
    const rows = sweepAutoHandoverState({ home, mode: 'check' });
    assert.ok(rows.some((r) => r.file === old && r.status === 'pending'));
    assert.ok(fs.existsSync(old), 'check mode must never delete');
    assert.ok(fs.existsSync(fresh));
  } finally {
    rm(home);
  }
});

test('sweepAutoHandoverState: repair mode removes only files older than the retention window', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'auto-handover');
    const old = seedAgedFile(dir, 'sess-old.json', 40);
    const fresh = seedAgedFile(dir, 'sess-fresh.json', 1);
    const rows = sweepAutoHandoverState({ home, mode: 'repair' });
    assert.ok(rows.some((r) => r.file === old && r.status === 'fixed'));
    assert.ok(!fs.existsSync(old), 'the aged file should be removed');
    assert.ok(fs.existsSync(fresh), 'a fresh file must survive');
  } finally {
    rm(home);
  }
});

test('sweepAutoHandoverState: env override changes the retention window', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'auto-handover');
    const tenDaysOld = seedAgedFile(dir, 'sess-10d.json', 10);
    const rows = sweepAutoHandoverState({ home, mode: 'repair', env: { ANTIHALL_AUTO_HANDOVER_STATE_RETENTION_DAYS: '5' } });
    assert.ok(rows.some((r) => r.file === tenDaysOld && r.status === 'fixed'));
    assert.ok(!fs.existsSync(tenDaysOld));
  } finally {
    rm(home);
  }
});

test('sweepAutoHandoverState: a missing directory is a routine no-op', () => {
  const home = tmpHome();
  try {
    const rows = sweepAutoHandoverState({ home, mode: 'repair' });
    assert.deepStrictEqual(rows, []);
  } finally {
    rm(home);
  }
});

test('sweepContextPctState: repair mode removes an aged reading AND an aged inferred-1m latch file', () => {
  const home = tmpHome();
  try {
    const dir = path.join(home, '.anti-hall', 'context-pct');
    const oldReading = seedAgedFile(dir, 'sess-old.json', 40);
    const oldInferred = seedAgedFile(dir, 'sess-old.inferred-1m.json', 40);
    const fresh = seedAgedFile(dir, 'sess-fresh.json', 1);
    const rows = sweepContextPctState({ home, mode: 'repair' });
    assert.ok(rows.some((r) => r.file === oldReading && r.status === 'fixed'));
    assert.ok(rows.some((r) => r.file === oldInferred && r.status === 'fixed'));
    assert.ok(!fs.existsSync(oldReading));
    assert.ok(!fs.existsSync(oldInferred));
    assert.ok(fs.existsSync(fresh));
  } finally {
    rm(home);
  }
});

test('runRepairs: WIRED end-to-end (dryRun -> check, else repair) for both new sweeps', () => {
  const home = tmpHome();
  try {
    const ahDir = path.join(home, '.anti-hall', 'auto-handover');
    const cpDir = path.join(home, '.anti-hall', 'context-pct');
    const oldAh = seedAgedFile(ahDir, 'sess-old.json', 40);
    const oldCp = seedAgedFile(cpDir, 'sess-old.json', 40);

    // dryRun -> mode 'check' -> nothing deleted, but the sweep IDs appear.
    const checkResults = runRepairs({ home, dryRun: true });
    const checkIds = new Set(checkResults.map((r) => r.id));
    assert.ok(checkIds.has('sweep-auto-handover-state'), 'sweep-auto-handover-state must be wired into runRepairs');
    assert.ok(checkIds.has('sweep-context-pct-state'), 'sweep-context-pct-state must be wired into runRepairs');
    assert.ok(fs.existsSync(oldAh));
    assert.ok(fs.existsSync(oldCp));

    // dryRun:false -> mode 'repair' -> the aged files are actually removed.
    runRepairs({ home, dryRun: false });
    assert.ok(!fs.existsSync(oldAh));
    assert.ok(!fs.existsSync(oldCp));
  } finally {
    rm(home);
  }
});
