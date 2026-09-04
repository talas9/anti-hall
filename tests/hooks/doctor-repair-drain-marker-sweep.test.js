'use strict';
// sweepStaleDrainMarkers (R11 Auditor Q5, P1) — doctor-repair.js's own sweep
// over ~/.anti-hall/devswarm/drain/*.json.
//
// devswarm-parent-gate.js's Stop-hook consumer only ever clears a stale
// in-flight drain marker under `own.id` (the CALLING Primary's own
// worktree-derived id) — it observes a marker only as a side effect of
// gating ITS OWN unread on ITS OWN Stop pass. A marker written under any
// OTHER id (a Primary whose worktree later moved/was removed, or one that
// crashed before its own next Stop pass ever ran) has nothing else that ever
// visits that directory, so it lingers past its TTL forever. This sweep
// enumerates every marker file directly and applies
// companion/lib/devswarm-drain-marker.js's OWN staleness test — never
// reimplementing the TTL logic here.
//
// 'check' mode is read-only (lists {id, ageMs, stale}); 'repair' mode deletes
// ONLY markers that are actually stale (via clearStaleDrainMarker, the SAME
// primitive the gate itself uses) — a fresh marker must never be removed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeHome } = require('../helpers/fixtures.js');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const repair = require(REPAIR_JS);
const drainMarkerLib = require(path.join(REPO_ROOT, 'plugins', 'anti-hall', 'companion', 'lib', 'devswarm-drain-marker.js'));

function drainDir(home) {
  return path.join(home, '.anti-hall', 'devswarm', 'drain');
}

test('check mode: a FRESH marker is reported stale:false and never deleted', () => {
  const h = makeHome();
  try {
    drainMarkerLib.markDrainStart(h.home, 'primary-aaa', { now: Date.now(), sessionId: 'sess-1' });
    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'check' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'primary-aaa');
    assert.strictEqual(rows[0].stale, false);
    assert.ok(fs.existsSync(path.join(drainDir(h.home), 'primary-aaa.json')), 'check mode must never delete');
  } finally { h.cleanup(); }
});

test('check mode: a STALE marker is reported stale:true and left in place', () => {
  const h = makeHome();
  try {
    const staleStart = Date.now() - (20 * 60 * 1000); // 20 min ago, default TTL 10 min
    drainMarkerLib.markDrainStart(h.home, 'primary-bbb', { now: staleStart, sessionId: 'sess-1' });
    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'check' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].id, 'primary-bbb');
    assert.strictEqual(rows[0].stale, true);
    assert.ok(rows[0].ageMs >= 20 * 60 * 1000);
    assert.ok(fs.existsSync(path.join(drainDir(h.home), 'primary-bbb.json')), 'check mode must NEVER delete, even a stale marker');
  } finally { h.cleanup(); }
});

test('repair mode: a FRESH marker is KEPT (skipped), never removed', () => {
  const h = makeHome();
  try {
    drainMarkerLib.markDrainStart(h.home, 'primary-ccc', { now: Date.now(), sessionId: 'sess-1' });
    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'skipped');
    assert.strictEqual(rows[0].stale, false);
    assert.ok(fs.existsSync(path.join(drainDir(h.home), 'primary-ccc.json')), 'a fresh marker must never be deleted by repair mode');
  } finally { h.cleanup(); }
});

test('repair mode: a STALE marker is REMOVED', () => {
  const h = makeHome();
  try {
    const staleStart = Date.now() - (20 * 60 * 1000);
    drainMarkerLib.markDrainStart(h.home, 'primary-ddd', { now: staleStart, sessionId: 'sess-1' });
    const p = path.join(drainDir(h.home), 'primary-ddd.json');
    assert.ok(fs.existsSync(p), 'sanity: marker must exist before the sweep');
    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'repair' });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].status, 'fixed');
    assert.strictEqual(rows[0].stale, true);
    assert.ok(!fs.existsSync(p), 'a stale marker must be removed by repair mode');
  } finally { h.cleanup(); }
});

test('repair mode: MIXED directory — only the stale marker is removed, the fresh one survives', () => {
  const h = makeHome();
  try {
    drainMarkerLib.markDrainStart(h.home, 'primary-fresh', { now: Date.now(), sessionId: 'sess-1' });
    const staleStart = Date.now() - (20 * 60 * 1000);
    drainMarkerLib.markDrainStart(h.home, 'primary-stale', { now: staleStart, sessionId: 'sess-1' });

    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'repair' });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.strictEqual(byId['primary-fresh'].status, 'skipped');
    assert.strictEqual(byId['primary-stale'].status, 'fixed');
    assert.ok(fs.existsSync(path.join(drainDir(h.home), 'primary-fresh.json')));
    assert.ok(!fs.existsSync(path.join(drainDir(h.home), 'primary-stale.json')));
  } finally { h.cleanup(); }
});

test('missing drain/ directory -> no-op, empty array, never throws (check mode)', () => {
  const h = makeHome();
  try {
    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'check' });
    assert.deepStrictEqual(rows, []);
  } finally { h.cleanup(); }
});

test('missing drain/ directory -> no-op, empty array, never throws (repair mode)', () => {
  const h = makeHome();
  try {
    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'repair' });
    assert.deepStrictEqual(rows, []);
  } finally { h.cleanup(); }
});

test('mode defaults to check (read-only) when omitted entirely', () => {
  const h = makeHome();
  try {
    const staleStart = Date.now() - (20 * 60 * 1000);
    drainMarkerLib.markDrainStart(h.home, 'primary-eee', { now: staleStart, sessionId: 'sess-1' });
    const rows = repair.sweepStaleDrainMarkers({ home: h.home });
    assert.strictEqual(rows[0].stale, true);
    assert.ok(fs.existsSync(path.join(drainDir(h.home), 'primary-eee.json')), 'omitted mode must default to read-only check, never delete');
  } finally { h.cleanup(); }
});

test('non-.json entries in the drain/ directory are ignored', () => {
  const h = makeHome();
  try {
    fs.mkdirSync(drainDir(h.home), { recursive: true });
    fs.writeFileSync(path.join(drainDir(h.home), 'README.txt'), 'not a marker');
    const rows = repair.sweepStaleDrainMarkers({ home: h.home, mode: 'check' });
    assert.deepStrictEqual(rows, []);
  } finally { h.cleanup(); }
});

// MUTATION-CHECK (documented for reproducibility, matching this repo's
// existing mutation-proof convention): dropping the `if (!marker.stale)
// { ...skip...; continue; }` guard in repair mode (i.e. calling
// clearStaleDrainMarker unconditionally, or replacing the guard with a
// no-op) KILLS the "a FRESH marker is KEPT" test above (the fresh marker
// file would be deleted, and the reported status would flip away from
// 'skipped') — verified live: temporarily removing that guard from a scratch
// copy of doctor-repair.js's sweepStaleDrainMarkers and re-running this
// suite against the mutant reproduced the failure (RED), then restoring the
// guard on the real file restored GREEN.
