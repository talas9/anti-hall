'use strict';
// checkSupersededArchivedMarkers (report-only, defensive; D12d P0 field fix).
//
// A Primary's own ANCHOR row (worktree == repo root) can reuse an id whose
// archived/<id>.json was left by a PRIOR occupant of that same id. Since
// devswarm-archived.js's isArchivedWorkspace() now discriminates this by
// sessionId (the archived marker's own vs. the live workspaces/<id>.json
// descriptor's), such a marker is already inert — but nothing ever told a
// human it existed. This check surfaces it, read-only, alongside doctor's
// other detect-and-report sections.
//
// Report-only: this suite never asserts any write/clear/delete behavior —
// the production function is a pure read (archived/ dir + per-id
// workspaces/<id>.json) with no side effect of its own.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const REPAIR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'lib', 'doctor-repair.js');
const repair = require(REPAIR_JS);

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antihall-doctor-superseded-'));
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'archived'), { recursive: true });
  fs.mkdirSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces'), { recursive: true });
  return { home, cleanup: () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} } };
}
function writeArchived(home, id, desc) {
  fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'archived', id + '.json'), JSON.stringify(desc));
}
function writeLive(home, id, desc) {
  fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'workspaces', id + '.json'), JSON.stringify(desc));
}

test('checkSupersededArchivedMarkers: marker sessionId != live descriptor sessionId -> reports, names the id', () => {
  const { home, cleanup } = makeHome();
  try {
    writeArchived(home, 'anchor-1', { id: 'anchor-1', worktreePath: '/repo', sessionId: 'session-old' });
    writeLive(home, 'anchor-1', { id: 'anchor-1', worktreePath: '/repo', sessionId: 'session-new' });

    const r = repair.checkSupersededArchivedMarkers({ home });
    assert.ok(r, 'must fire when a marker is superseded by a different live sessionId');
    assert.strictEqual(r.atRisk, true);
    assert.strictEqual(r.count, 1);
    assert.deepStrictEqual(r.examples, ['anchor-1']);
    assert.match(r.message, /anchor-1/);
    assert.match(r.message, /no action needed/);
  } finally { cleanup(); }
});

test('checkSupersededArchivedMarkers: marker sessionId == live descriptor sessionId -> silent (null)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeArchived(home, 'anchor-2', { id: 'anchor-2', worktreePath: '/repo', sessionId: 'same' });
    writeLive(home, 'anchor-2', { id: 'anchor-2', worktreePath: '/repo', sessionId: 'same' });

    const r = repair.checkSupersededArchivedMarkers({ home });
    assert.strictEqual(r, null, 'a genuinely-still-archived marker must never be reported as superseded');
  } finally { cleanup(); }
});

test('checkSupersededArchivedMarkers: marker has no sessionId -> silent (nothing to discriminate)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeArchived(home, 'anchor-3', { id: 'anchor-3', worktreePath: '/repo' });
    writeLive(home, 'anchor-3', { id: 'anchor-3', worktreePath: '/repo', sessionId: 'session-new' });

    const r = repair.checkSupersededArchivedMarkers({ home });
    assert.strictEqual(r, null);
  } finally { cleanup(); }
});

test('checkSupersededArchivedMarkers: no live descriptor for the id -> silent (nothing to discriminate)', () => {
  const { home, cleanup } = makeHome();
  try {
    writeArchived(home, 'anchor-4', { id: 'anchor-4', worktreePath: '/repo', sessionId: 'session-old' });
    // No workspaces/anchor-4.json written at all.

    const r = repair.checkSupersededArchivedMarkers({ home });
    assert.strictEqual(r, null);
  } finally { cleanup(); }
});

test('checkSupersededArchivedMarkers: no archived dir / no markers at all -> silent (null), never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    const r = repair.checkSupersededArchivedMarkers({ home });
    assert.strictEqual(r, null);
  } finally { cleanup(); }
});

test('checkSupersededArchivedMarkers: unparseable archived record is skipped, never throws', () => {
  const { home, cleanup } = makeHome();
  try {
    fs.writeFileSync(path.join(home, '.anti-hall', 'devswarm', 'archived', 'bad.json'), '{not json');
    const r = repair.checkSupersededArchivedMarkers({ home });
    assert.strictEqual(r, null);
  } finally { cleanup(); }
});

test('checkSupersededArchivedMarkers: caps the shown list at 5 and notes the remainder', () => {
  const { home, cleanup } = makeHome();
  try {
    for (let i = 0; i < 7; i++) {
      const id = 'anchor-many-' + i;
      writeArchived(home, id, { id, worktreePath: '/repo/' + i, sessionId: 'session-old' });
      writeLive(home, id, { id, worktreePath: '/repo/' + i, sessionId: 'session-new' });
    }
    const r = repair.checkSupersededArchivedMarkers({ home });
    assert.ok(r);
    assert.strictEqual(r.count, 7);
    assert.match(r.message, /\+2 more/);
  } finally { cleanup(); }
});

test('doctor.js wires checkSupersededArchivedMarkers into a report-only, info-labeled section', () => {
  const DOCTOR_JS = path.join(REPO_ROOT, 'plugins', 'anti-hall', 'hooks', 'doctor.js');
  const src = fs.readFileSync(DOCTOR_JS, 'utf8');
  assert.match(src, /checkSupersededArchivedMarkers/);
  assert.match(src, /superseded archived markers/);
  assert.match(src, /infol\(result\.message\);\s*\n\}\)\(\);\s*$/m, 'must use infol (never touches pass/fail) not warnl');
});
