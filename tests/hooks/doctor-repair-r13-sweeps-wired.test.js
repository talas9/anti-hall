'use strict';
// Round 13 item 2 (R2) — THE FOUR SWEEPS ARE ACTUALLY WIRED INTO runRepairs.
//
// ROOT CAUSE: sweepStaleDrainMarkers, promoteUnclaimedSessions, sweepReapedLogs
// and sweepSendReceipts were written, exported and unit-tested — and NOTHING
// ever called them. `doctor --repair` is the only surface that visits those
// directories, so in the field a stale drain marker silenced the parent gate
// forever, an `unclaimed:` row stayed unclaimed forever, and the two
// append-only diagnostic directories grew without bound. Exported-but-unwired
// is not shipped, and no unit test of a function nobody calls can catch it.
//
// These tests exercise runRepairs END TO END through observable filesystem
// state, not through a spy on the module's own exports — a spy would pass just
// as happily on the pre-fix build if it were installed on the wrong object.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runRepairs } = require('../../plugins/anti-hall/hooks/lib/doctor-repair.js');

const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} };
const DAY = 24 * 60 * 60 * 1000;

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-doctor-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });
  return home;
}
const dsRoot = (home) => path.join(home, '.anti-hall', 'devswarm');

// An aged file in a retention-swept directory, plus a fresh one that must
// survive every mode.
function seedRetentionDirs(home) {
  const reaped = path.join(dsRoot(home), 'reaped');
  const receipts = path.join(dsRoot(home), 'send-receipts', '2020-01-01');
  fs.mkdirSync(reaped, { recursive: true });
  fs.mkdirSync(receipts, { recursive: true });
  const oldReaped = path.join(reaped, 'old.ndjson');
  const freshReaped = path.join(reaped, 'fresh.ndjson');
  const oldReceipt = path.join(receipts, 'old.json');
  fs.writeFileSync(oldReaped, '{}\n');
  fs.writeFileSync(freshReaped, '{}\n');
  fs.writeFileSync(oldReceipt, '{}\n');
  const ancient = new Date(Date.now() - 400 * DAY);
  fs.utimesSync(oldReaped, ancient, ancient);
  fs.utimesSync(oldReceipt, ancient, ancient);
  return { oldReaped, freshReaped, oldReceipt };
}

// A STALE drain marker (devswarm-drain-marker.js's TTL is 10 minutes) plus a
// fresh one that must never be touched.
function seedDrainMarkers(home) {
  const dir = path.join(dsRoot(home), 'drain');
  fs.mkdirSync(dir, { recursive: true });
  const stale = path.join(dir, 'stale-id.json');
  const fresh = path.join(dir, 'fresh-id.json');
  fs.writeFileSync(stale, JSON.stringify({ id: 'stale-id', startedAt: Date.now() - 60 * 60 * 1000, sessionId: 's', pid: 1 }));
  fs.writeFileSync(fresh, JSON.stringify({ id: 'fresh-id', startedAt: Date.now(), sessionId: 's', pid: 1 }));
  return { stale, fresh };
}

function idsOf(results) {
  return new Set(results.map((r) => r && r.id));
}

test('R13 R2: dry run (check mode) REPORTS the four sweeps and DELETES nothing', () => {
  const home = tmpHome();
  try {
    const files = seedRetentionDirs(home);
    const markers = seedDrainMarkers(home);

    const results = runRepairs({ home, cwd: home, env: {}, dryRun: true });
    const ids = idsOf(results);
    for (const id of ['sweep-drain-markers', 'promote-unclaimed', 'sweep-reaped-logs', 'sweep-send-receipts']) {
      assert.ok(ids.has(id), 'THE FIX: ' + id + ' is reached by runRepairs at all (pre-fix nothing called it)');
    }
    for (const row of results.filter((r) => r && ids.has(r.id) && String(r.id).startsWith('sweep'))) {
      assert.notStrictEqual(row.status, 'fixed', 'check mode must never report a mutation: ' + JSON.stringify(row));
    }

    assert.ok(fs.existsSync(files.oldReaped), 'check mode deletes nothing, not even an aged file');
    assert.ok(fs.existsSync(files.oldReceipt));
    assert.ok(fs.existsSync(markers.stale), 'check mode never clears even a provably stale drain marker');
    assert.ok(fs.existsSync(markers.fresh));
  } finally { rm(home); }
});

test('R13 R2: repair mode APPLIES all four — aged files removed, stale marker cleared, fresh state untouched', () => {
  const home = tmpHome();
  try {
    const files = seedRetentionDirs(home);
    const markers = seedDrainMarkers(home);

    const results = runRepairs({ home, cwd: home, env: {}, dryRun: false });
    const ids = idsOf(results);
    for (const id of ['sweep-drain-markers', 'promote-unclaimed', 'sweep-reaped-logs', 'sweep-send-receipts']) {
      assert.ok(ids.has(id), id + ' must run in repair mode');
    }

    assert.ok(!fs.existsSync(files.oldReaped), 'THE FIX: the aged reaped log is finally swept (400 days > the 30-day window)');
    assert.ok(!fs.existsSync(files.oldReceipt), 'THE FIX: the aged send receipt is finally swept (400 days > the 7-day window)');
    assert.ok(fs.existsSync(files.freshReaped), 'a file INSIDE the retention window is never touched');
    assert.ok(!fs.existsSync(markers.stale), 'THE FIX: the stale drain marker is finally cleared');
    assert.ok(fs.existsSync(markers.fresh), 'a FRESH drain marker is never removed — that would race a live drain');
  } finally { rm(home); }
});

test('R13 R2: a missing devswarm root is a routine no-op, never a failure', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r13-doctor-bare-'));
  try {
    const results = runRepairs({ home, cwd: home, env: {}, dryRun: false });
    const rows = results.filter((r) => r && String(r.id).startsWith('sweep'));
    assert.ok(rows.length >= 3, 'the sweeps still report, even with nothing on disk');
    for (const row of rows) {
      assert.notStrictEqual(row.status, 'failed', 'an absent directory is routine: ' + JSON.stringify(row));
    }
  } finally { rm(home); }
});
