'use strict';
// D11-C, defect 07e01aee4f1f — computeDiagnosis reported `live:true` for an
// APP-ARCHIVED workspace (archived in the DevSwarm app, which never writes
// anti-hall's own archived/<id>.json — see companion/lib/
// devswarm-archived-cache.js's absence-by-omission rule). The fix adds an
// additive `archivedInApp` per row and forces `live:false` for one, checked
// BEFORE the heartbeat/session liveness branch — a fresh heartbeat must never
// override "this was put away".
//
// MUTATION CHECK: removing the archivedInApp short-circuit in computeDiagnosis
// (letting the heartbeat/session branch run unconditionally) must turn the
// first test below RED (live:true instead of false).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../../plugins/anti-hall/scripts/devswarm.js');
const storeLib = require('../../plugins/anti-hall/companion/lib/devswarm-store.js');
const cacheLib = require('../../plugins/anti-hall/companion/lib/devswarm-archived-cache.js');

const NOW = 1_800_000_000_000;
const GRACE_MS = 10 * 60 * 1000; // DEFAULT_ARCHIVED_GRACE_MS

function tmpHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-hall-diag-live-'));
  fs.mkdirSync(path.join(home, '.anti-hall'), { recursive: true });
  return home;
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }

// Seed a registry row + a live descriptor (workspaces/<id>.json) carrying an
// explicit `repoKey` — descriptorRegisteredRepoKey falls back to this
// PERSISTED field when the worktreePath itself does not resolve as a real git
// worktree (this test's worktree paths are fixture-shaped, never real repos).
function seedRow(home, repoKey, { id, worktreePath, sessionId }) {
  const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
  try { s.upsertRegistry({ id, worktreePath, sessionId: sessionId || null }); } finally { s.close(); }
  const workspacesDir = path.join(home, '.anti-hall', 'devswarm', 'workspaces');
  fs.mkdirSync(workspacesDir, { recursive: true });
  fs.writeFileSync(path.join(workspacesDir, id + '.json'), JSON.stringify({
    id, worktreePath, sessionId: sessionId || null, repoKey,
  }));
}

test('D11-C: an app-archived row diagnoses live:false + archivedInApp:true, even with a fresh heartbeat', () => {
  const home = tmpHome();
  try {
    const repoKey = 'archdiag-repo-aa1111';
    const worktreePath = '/Users/x/.devswarm/repos/1/aa1111/archived-project';
    const id = 'ws-archived-1';
    seedRow(home, repoKey, { id, worktreePath, sessionId: 'sess-real-1' });

    // Fixture hivecontrol-active.json snapshot: this row is ABSENT (the
    // absence-by-omission rule) and fresh, and old enough (past the grace)
    // that conjunct 4 is satisfied — firstSeenMs is the descriptor file's own
    // mtime (just written above, so "now" must be past firstSeen + grace).
    cacheLib.writeActiveCache({
      home, now: NOW,
      byRepoKey: { [repoKey]: [{ id: 'some-other-live-id', worktreePath: '/Users/x/.devswarm/repos/1/aa1111/other' }] },
    });

    // A fresh heartbeat for this id — proves archivedInApp is NOT gated on
    // sessionPidAlive/hasFreshHeartbeat; it must win over a live-looking signal.
    const hbDir = path.join(home, '.anti-hall', 'devswarm', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });
    fs.writeFileSync(path.join(hbDir, id + '.json'), JSON.stringify({ id, ts: NOW - 1000, sessionId: 'sess-real-1' }));

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let d;
    try {
      d = cli.computeDiagnosis(s, {
        home, env: {}, now: NOW + GRACE_MS + 60_000, // past firstSeen + grace, well past cache freshness bound too? check below
      });
    } finally { s.close(); }

    const row = d.registry.find((r) => r.id === id);
    assert.ok(row, 'row must be present in diagnose output');
    assert.strictEqual(row.archivedInApp, true, 'archivedInApp must be true for the app-archived row');
    assert.strictEqual(row.live, false, 'live must be false for an app-archived row, even with a fresh heartbeat');
  } finally { rm(home); }
});

test('D11-C: a genuinely live row (present in the active-set fixture) is untouched — live:true, archivedInApp:false', () => {
  const home = tmpHome();
  try {
    const repoKey = 'archdiag-repo-bb2222';
    const worktreePath = '/Users/x/.devswarm/repos/1/bb2222/live-project';
    const id = 'ws-live-1';
    seedRow(home, repoKey, { id, worktreePath, sessionId: 'sess-real-2' });

    cacheLib.writeActiveCache({
      home, now: NOW,
      byRepoKey: { [repoKey]: [{ id, worktreePath }] }, // present -> conjunct 3 fails -> never app-archived
    });

    const hbDir = path.join(home, '.anti-hall', 'devswarm', 'heartbeats');
    fs.mkdirSync(hbDir, { recursive: true });
    fs.writeFileSync(path.join(hbDir, id + '.json'), JSON.stringify({ id, ts: NOW - 1000, sessionId: 'sess-real-2' }));

    const s = storeLib.openStore({ home, hash: repoKey, backend: 'journal' });
    let d;
    try {
      d = cli.computeDiagnosis(s, { home, env: {}, now: NOW + 5000 });
    } finally { s.close(); }

    const row = d.registry.find((r) => r.id === id);
    assert.ok(row, 'row must be present in diagnose output');
    assert.strictEqual(row.archivedInApp, false, 'archivedInApp must be false for a live, present-in-active-set row');
    assert.strictEqual(row.live, true, 'a genuinely live row must stay live:true, unaffected by this fix');
  } finally { rm(home); }
});
