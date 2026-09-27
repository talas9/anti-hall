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

test('health: lists os.tmpdir() once per call, not once per WAL, and reports identical pending/spilled counts', () => {
  const home = tmpHome();
  const realTmpdir = os.tmpdir();
  const fakeTmp = fs.mkdtempSync(path.join(realTmpdir, 'anti-hall-walhealth-tmp-'));
  const origTMPDIR = process.env.TMPDIR;
  process.env.TMPDIR = fakeTmp;
  try {
    assert.equal(os.tmpdir(), fakeTmp, 'os.tmpdir() must honor the fake TMPDIR for this test to be isolated');

    // Seed several WALs, each with a last-resort file directly in the fake
    // tmpdir (the WAL-and-spill-both-failed path), so health() must scan it
    // once and attribute each last-resort file back to its own WAL.
    const wals = ['a', 'b', 'c', 'd', 'e'].map((k) => readWal.walPath(home, 'pull', k));
    // fs stub whose writes fail ONLY under `home` (WAL + spill dirs), so
    // captureRaw exhausts both and falls through to the real last-resort
    // write under (fake) os.tmpdir(), which this stub passes through to fs.
    const failingFs = Object.assign({}, fs, {
      mkdirSync(p, ...rest) { if (String(p).startsWith(home)) throw new Error('EACCES dir'); return fs.mkdirSync(p, ...rest); },
      openSync(p, ...rest) { if (String(p).startsWith(home)) throw new Error('EACCES wal'); return fs.openSync(p, ...rest); },
    });
    for (const w of wals) {
      readWal.captureRaw(failingFs, w, 'raw-' + w, NOW, null, () => {});
    }
    const lastResortFiles = fs.readdirSync(fakeTmp).filter((n) => n.startsWith('anti-hall-wal-lastresort-'));
    assert.equal(lastResortFiles.length, wals.length, 'one last-resort file per WAL (real fs, not the failing stub)');

    // Spy: count real fs.readdirSync calls against the fake tmpdir specifically.
    const origReaddirSync = fs.readdirSync;
    let tmpdirReaddirCalls = 0;
    fs.readdirSync = function (p, ...rest) {
      if (path.resolve(String(p)) === path.resolve(fakeTmp)) tmpdirReaddirCalls++;
      return origReaddirSync.call(this, p, ...rest);
    };
    let h;
    try {
      h = readWal.health(fs, home, NOW);
    } finally {
      fs.readdirSync = origReaddirSync;
    }

    assert.equal(tmpdirReaddirCalls, 1, 'os.tmpdir() must be listed exactly once per health() call, not once per WAL: ' + tmpdirReaddirCalls);
    assert.equal(h.length, wals.length, 'every WAL with a last-resort batch is reported');
    for (const w of wals) {
      const row = h.find((r) => path.resolve(r.file) === path.resolve(w));
      assert.ok(row, 'missing row for ' + w);
      assert.equal(row.spilled, 1, 'last-resort batch counted for ' + w);
      assert.equal(row.alert, true);
    }
  } finally {
    if (origTMPDIR === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = origTMPDIR;
    fs.rmSync(fakeTmp, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
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
