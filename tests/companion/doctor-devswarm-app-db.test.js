'use strict';
// v0.108.0 — doctor's DevSwarm app-DB view (appDbChecks), report-only:
//   (a) no app DB -> silent
//   (b) schema drift -> "DevSwarm app schema changed: <col>"; core loss -> unreadable WARN
//   (c) a fresh spawn whose brief never arrived -> WARN
//   (d) after a sync: drift, conflict, message gaps, pending app deletions; stale sync WARN
//   (e) never writes

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', 'plugins', 'anti-hall');
const doc = require(path.join(ROOT, 'companion', 'lib', 'doctor-devswarm.js'));
const dw = require(path.join(ROOT, 'scripts', 'devswarm.js'));
const { buildAppDb, rmFixture } = require('../helpers/app-db-fixture.js');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch (_) { sqlite = null; }
const skip = sqlite ? false : 'node:sqlite unavailable';
const msgs = (rs) => rs.map((r) => r.status + ' ' + r.message).join('\n');

test('(a) no app DB -> silent', { skip }, () => {
  const f = buildAppDb();
  try {
    assert.deepStrictEqual(doc.appDbChecks({ home: f.home, env: { ANTIHALL_DEVSWARM_APP_DB: path.join(f.base, 'nope.db') } }), []);
    assert.deepStrictEqual(doc.appDbChecks({ home: f.home, env: { ANTIHALL_DEVSWARM_APP_DB: 'off' } }), []);
  } finally { rmFixture(f); }
});

test('(b) schema drift names the column; losing a core column reads as unreadable', { skip }, () => {
  const f = buildAppDb({ drop: ['builders.lastSelectedAt', 'pull_requests (table)'] });
  try {
    const m = msgs(doc.appDbChecks({ home: f.home, env: f.env }));
    assert.ok(/WARN DevSwarm app schema changed: .*builders\.lastSelectedAt.*pull_requests \(table\)/.test(m), m);
  } finally { rmFixture(f); }
  const g = buildAppDb({ drop: ['builders.isActive'] });
  try {
    assert.ok(/WARN DevSwarm app DB present but unreadable/.test(msgs(doc.appDbChecks({ home: g.home, env: g.env }))));
  } finally { rmFixture(g); }
});

test('(c)(d)(e) brief delivery, drift, conflict, gaps, deletions, stale sync; read-only', { skip }, () => {
  const f = buildAppDb();
  try {
    let m = msgs(doc.appDbChecks({ home: f.home, env: f.env }));
    assert.ok(/PASS DevSwarm app DB DevSwarm@9\.9\.9: 4 builders, 3 open/.test(m), m);
    assert.ok(/WARN DevSwarm spawn delivery: Bravo task \(b-b\): brief not-delivered/.test(m), m);
    assert.ok(/WARN DevSwarm app sync: no app-state\.json yet/.test(m), m);

    dw.syncAppState(f.home, { env: f.env });
    const p = dw.appStatePath(f.home);
    const st = JSON.parse(fs.readFileSync(p, 'utf8'));
    st.openButMarkedArchived = [{ id: 'b-a', label: 'Alpha' }];
    st.scheduledForDeletion = ['old-worktree'];
    st.gaps = { at: st.at, repos: [{ repositoryId: 'repo-1', name: 'repo', app: 5, matched: 1, archivedTarget: 1, preIngest: 1, gap: 2, byBranch: { main: { n: 2, lt1h: 0, lt1d: 2, lt7d: 0, older: 0 } } }] };
    fs.writeFileSync(p, JSON.stringify(st));
    const before = fs.readFileSync(p, 'utf8');
    m = msgs(doc.appDbChecks({ home: f.home, env: f.env, now: st.at + 1000 }));
    assert.ok(/WARN open in the DevSwarm app but unknown to anti-hall .*Bravo task \(b-b\)/.test(m), m);
    assert.ok(/WARN open in the DevSwarm app but archived in anti-hall .*Alpha \(b-a\)/.test(m), m);
    assert.ok(/WARN DevSwarm message cross-check \(report only\): repo 2 app message\(s\) to live targets never ingested \[main: 2, 2 in the last day\]/.test(m), m);
    assert.ok(/PASS DevSwarm app has 1 entry scheduled for deletion \(report only\): old-worktree/.test(m), m);
    assert.ok(!/last run/.test(m), 'fresh sync -> no staleness line');
    assert.ok(/WARN DevSwarm app sync: last run 60m ago/.test(msgs(doc.appDbChecks({ home: f.home, env: f.env, now: st.at + 3600e3 }))));
    assert.strictEqual(fs.readFileSync(p, 'utf8'), before, 'doctor never writes app-state.json');
  } finally { rmFixture(f); }
});
