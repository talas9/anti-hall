'use strict';
// Phase 5 delivery WAL health: a pending batch past the age/size threshold, or
// a spilled batch (WAL unwritable -> reads blocked), surfaces as an alert in
// `inbox tick` and `doctor` — and is never dropped.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Never let a log line fall back to the real home.
if (!process.env.ANTI_HALL_LOG_DIR) process.env.ANTI_HALL_LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-walhealth-log-'));

const readWal = require('../../plugins/anti-hall/companion/lib/devswarm-read-wal.js');
const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const doctorDevswarm = require('../../plugins/anti-hall/companion/lib/doctor-devswarm.js');

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-walhealth-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm'), { recursive: true });
  return home;
}
const NOW = 1_700_000_000_000;

test('health: an old pending batch alerts; a fresh one does not; nothing is dropped', () => {
  const home = tmpHome();
  try {
    const fresh = readWal.walPath(home, 'pull', 'fresh');
    const old = readWal.walPath(home, 'pull', 'old');
    readWal.appendBatch(fs, fresh, '[]x', NOW - 1000);
    readWal.appendBatch(fs, old, '[]y', NOW - readWal.PENDING_ALERT_MS - 1000);
    const h = readWal.health(fs, home, NOW);
    assert.equal(h.find((r) => r.file === fresh).alert, false);
    const o = h.find((r) => r.file === old);
    assert.equal(o.alert, true);
    assert.match(o.reason, /oldest pending batch/);
    assert.equal(readWal.pending(fs, old).length, 1, 'report-only: the batch stays pending');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('health: a spilled batch alerts (reads blocked) even when the WAL file itself does not exist', () => {
  const home = tmpHome();
  try {
    const wal = readWal.walPath(home, 'monitor', 'k');
    readWal.spill(fs, wal, 'raw-bytes', NOW, null);
    const h = readWal.health(fs, home, NOW);
    assert.equal(h.length, 1);
    assert.equal(h[0].alert, true);
    assert.match(h[0].reason, /spilled/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('inbox tick and doctor surface a WAL alert', () => {
  const home = tmpHome();
  try {
    readWal.appendBatch(fs, readWal.walPath(home, 'pull', 'stuck'), '[]z', NOW - readWal.PENDING_ALERT_MS - 1000);
    const env = { ANTIHALL_INGEST_DRY_RUN: '1' };
    const tick = cli.run(['inbox', 'tick', 'stuck'], { home, backend: 'journal', env, cwd: path.join(home, 'nowhere'), now: NOW }).result;
    assert.ok(Array.isArray(tick.walAlerts) && tick.walAlerts.length === 1, 'tick reports the stuck WAL: ' + JSON.stringify(tick));
    const doc = doctorDevswarm.runChecks({ home, env: { DEVSWARM_REPO_ID: 'r' }, cwd: home, now: NOW });
    assert.ok(doc.results.some((r) => r.status === 'WARN' && /delivery WAL .*oldest pending batch/.test(r.message)),
      'doctor WARNs about the stuck WAL: ' + JSON.stringify(doc.results.map((r) => r.message)));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
